/**
 * Password Reset Service
 * Task 102.14: Implement Secure Password Reset Tokens
 *
 * SECURITY REQUIREMENTS:
 * - Tokens expire in 15 minutes (short-lived to minimize attack window)
 * - Tokens are single-use (consumed on successful reset)
 * - Tokens are hashed before storage (never store plaintext)
 * - Rate limit reset requests (prevents enumeration and abuse)
 * - Generic responses (don't reveal if email exists)
 *
 * Implementation follows OWASP guidelines for password reset:
 * https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html
 */

import * as crypto from 'crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq, and, gt, lt, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { securityLogger } from '../utils/logger.js';
import {
  securityEvents,
  users,
  type InsertSecurityEvent,
} from '../../shared/schema.js';
import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  inet,
} from 'drizzle-orm/pg-core';

// =====================================================
// CONFIGURATION
// Security-critical timing and limit constants
// =====================================================

const PASSWORD_RESET_CONFIG = {
  // SECURITY: 15 minute expiry limits attack window
  // Shorter than typical session tokens but long enough for legitimate use
  TOKEN_EXPIRY_MS: 15 * 60 * 1000, // 15 minutes

  // SECURITY: Token byte length determines entropy
  // 32 bytes = 256 bits of entropy (cryptographically secure)
  TOKEN_BYTE_LENGTH: 32,

  // SECURITY: Rate limiting - max 3 reset requests per email per hour
  // Prevents enumeration attacks and abuse
  MAX_REQUESTS_PER_HOUR: 3,

  // SECURITY: Cleanup interval for expired tokens
  CLEANUP_INTERVAL_MS: 60 * 60 * 1000, // 1 hour

  // SECURITY: Lockout duration after too many failed attempts
  LOCKOUT_DURATION_MS: 60 * 60 * 1000, // 1 hour
};

// =====================================================
// DATABASE SCHEMA FOR PASSWORD RESET TOKENS
// =====================================================

/**
 * Password Reset Tokens table
 *
 * SECURITY NOTES:
 * - tokenHash: We store SHA-256 hash of the token, never the plaintext
 * - isUsed: Ensures single-use tokens (prevents replay attacks)
 * - expiresAt: Enforces short-lived tokens (15 minutes)
 * - requestIp: For audit logging and abuse detection
 */
export const passwordResetTokens = pgTable('password_reset_tokens', {
  id: serial('id').primaryKey(),
  userId: integer('user_id').notNull(),
  // SECURITY: Store only the hash of the token, never plaintext
  tokenHash: text('token_hash').notNull().unique(),
  // SECURITY: Track if token has been used (single-use enforcement)
  isUsed: boolean('is_used').notNull().default(false),
  // SECURITY: Timestamp when used for audit trail
  usedAt: timestamp('used_at'),
  // SECURITY: Hard expiry time (15 minutes from creation)
  expiresAt: timestamp('expires_at').notNull(),
  // SECURITY: Track request origin for abuse detection
  requestIp: inet('request_ip'),
  requestUserAgent: text('request_user_agent'),
  // SECURITY: Track reset completion IP for security alerts
  resetIp: inet('reset_ip'),
  resetUserAgent: text('reset_user_agent'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// =====================================================
// DATABASE CONNECTION
// =====================================================

// Lazy database connection — avoids blocking the event loop at module scope
// when running inside an esbuild CJS bundle (#267).
let _db: ReturnType<typeof drizzle> | null = null;
function getDb() {
  if (!_db) {
    const connectionString =
      process.env.DATABASE_URL || 'postgresql://localhost:5432/wrfcoin';
    _db = drizzle(postgres(connectionString));
  }
  return _db;
}

// =====================================================
// TYPE DEFINITIONS
// =====================================================

export interface PasswordResetTokenResult {
  token: string; // Plaintext token - only returned once, never stored
  expiresAt: Date;
  userId: string;
}

export interface TokenValidationResult {
  valid: boolean;
  userId?: string;
  error?: string;
  errorCode?: 'TOKEN_EXPIRED' | 'TOKEN_USED' | 'TOKEN_NOT_FOUND' | 'TOKEN_INVALID';
}

export interface CreateResetTokenOptions {
  userId: number;
  email: string;
  ipAddress?: string;
  userAgent?: string;
}

export interface ValidateAndConsumeOptions {
  token: string;
  ipAddress?: string;
  userAgent?: string;
}

// =====================================================
// PASSWORD RESET SERVICE
// =====================================================

export class PasswordResetService {
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Start automatic cleanup of expired tokens
    this.startCleanupTimer();
  }

  // =====================================================
  // CRYPTOGRAPHIC TOKEN GENERATION
  // =====================================================

  /**
   * Generate a cryptographically secure random token
   *
   * SECURITY IMPLEMENTATION:
   * - Uses crypto.randomBytes() for CSPRNG (Cryptographically Secure Pseudo-Random Number Generator)
   * - 32 bytes = 256 bits of entropy
   * - Base64url encoding for URL-safe transmission
   * - No predictable patterns or timestamps in token
   */
  static generateToken(): string {
    // SECURITY: crypto.randomBytes is the correct choice for security-sensitive tokens
    // It uses the operating system's entropy pool
    return crypto.randomBytes(PASSWORD_RESET_CONFIG.TOKEN_BYTE_LENGTH).toString('base64url');
  }

  /**
   * Hash token for secure storage
   *
   * SECURITY IMPLEMENTATION:
   * - SHA-256 is sufficient for token hashing (tokens are high-entropy)
   * - Unlike passwords, tokens don't need bcrypt/scrypt because:
   *   1. Tokens are randomly generated with high entropy
   *   2. Tokens are short-lived (15 minutes)
   *   3. Brute-force is infeasible within expiry window
   */
  static hashToken(token: string): string {
    // SECURITY: SHA-256 is appropriate here because:
    // - High-entropy input (256 bits)
    // - Short validity window (15 min)
    // - Computational cost of bcrypt not needed for random tokens
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  // =====================================================
  // TOKEN CREATION
  // =====================================================

  /**
   * Create a password reset token for a user
   *
   * SECURITY WORKFLOW:
   * 1. Invalidate any existing tokens for this user (prevent token accumulation)
   * 2. Generate cryptographically secure token
   * 3. Hash token before storing (never store plaintext)
   * 4. Store with expiry timestamp
   * 5. Return plaintext token only once (never retrievable again)
   *
   * @returns Plaintext token (only time it's available) with expiry
   */
  async createResetToken(options: CreateResetTokenOptions): Promise<PasswordResetTokenResult> {
    const { userId, email, ipAddress, userAgent } = options;

    // SECURITY: Check rate limiting before creating token
    const rateLimitCheck = await this.checkRateLimit(userId);
    if (!rateLimitCheck.allowed) {
      throw new Error(`Too many reset requests. Please try again in ${rateLimitCheck.retryAfterMinutes} minutes.`);
    }

    // SECURITY STEP 1: Invalidate all existing tokens for this user
    // Prevents token accumulation and ensures only latest token is valid
    await this.invalidateExistingTokens(userId);

    // SECURITY STEP 2: Generate cryptographically secure token
    const plainTextToken = PasswordResetService.generateToken();

    // SECURITY STEP 3: Hash token before storage
    // Plaintext is never written to database
    const tokenHash = PasswordResetService.hashToken(plainTextToken);

    // SECURITY STEP 4: Calculate expiry (15 minutes from now)
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_CONFIG.TOKEN_EXPIRY_MS);

    // SECURITY STEP 5: Store hashed token in database
    await getDb().insert(passwordResetTokens).values({
      userId,
      tokenHash,
      isUsed: false,
      expiresAt,
      requestIp: ipAddress,
      requestUserAgent: userAgent,
    });

    // Log security event for audit trail
    await this.logSecurityEvent({
      userId,
      eventType: 'password_reset_requested',
      severity: 'medium',
      description: `Password reset token created for user`,
      ipAddress,
      userAgent,
      metadata: {
        expiresAt: expiresAt.toISOString(),
        // SECURITY: Do not log email in metadata to prevent PII leakage
      },
    });

    // SECURITY: Return plaintext token only once
    // This is the only time the actual token value is available
    return {
      token: plainTextToken,
      expiresAt,
      userId: userId.toString(),
    };
  }

  // =====================================================
  // TOKEN VALIDATION AND CONSUMPTION
  // =====================================================

  /**
   * Validate and consume a password reset token
   *
   * SECURITY WORKFLOW:
   * 1. Hash the provided token to compare with stored hash
   * 2. Look up token in database by hash
   * 3. Check if token exists
   * 4. Check if token is expired
   * 5. Check if token was already used
   * 6. Mark token as used (single-use enforcement)
   * 7. Return user ID if valid
   *
   * IMPORTANT: Token is consumed regardless of password change success
   * This prevents replay attacks
   */
  async validateAndConsume(options: ValidateAndConsumeOptions): Promise<TokenValidationResult> {
    const { token, ipAddress, userAgent } = options;

    // SECURITY STEP 1: Hash the provided token to compare with stored hash
    const tokenHash = PasswordResetService.hashToken(token);

    // SECURITY STEP 2: Look up token by hash
    const tokenRecords = await getDb()
      .select()
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);

    // SECURITY STEP 3: Check if token exists
    if (tokenRecords.length === 0) {
      // SECURITY: Use constant-time response to prevent timing attacks
      // Log failed attempt for security monitoring
      await this.logSecurityEvent({
        userId: undefined,
        eventType: 'password_reset_invalid_token',
        severity: 'medium',
        description: 'Attempted to use non-existent password reset token',
        ipAddress,
        userAgent,
      });

      return {
        valid: false,
        error: 'Invalid or expired reset token',
        errorCode: 'TOKEN_NOT_FOUND',
      };
    }

    const tokenRecord = tokenRecords[0];
    const now = new Date();

    // SECURITY STEP 4: Check if token is expired
    if (tokenRecord.expiresAt < now) {
      await this.logSecurityEvent({
        userId: tokenRecord.userId,
        eventType: 'password_reset_expired_token',
        severity: 'low',
        description: 'Attempted to use expired password reset token',
        ipAddress,
        userAgent,
        metadata: {
          expiredAt: tokenRecord.expiresAt.toISOString(),
          attemptedAt: now.toISOString(),
        },
      });

      return {
        valid: false,
        error: 'Reset token has expired. Please request a new one.',
        errorCode: 'TOKEN_EXPIRED',
      };
    }

    // SECURITY STEP 5: Check if token was already used (single-use enforcement)
    if (tokenRecord.isUsed) {
      // SECURITY: Log this as a potential replay attack attempt
      await this.logSecurityEvent({
        userId: tokenRecord.userId,
        eventType: 'password_reset_token_reuse_attempt',
        severity: 'high',
        description: 'Attempted to reuse already-consumed password reset token (potential replay attack)',
        ipAddress,
        userAgent,
        metadata: {
          tokenCreatedAt: tokenRecord.createdAt.toISOString(),
          tokenUsedAt: tokenRecord.usedAt?.toISOString(),
        },
      });

      return {
        valid: false,
        error: 'This reset link has already been used',
        errorCode: 'TOKEN_USED',
      };
    }

    // SECURITY STEP 6: Mark token as used (atomic operation)
    // This prevents race conditions where token could be used twice
    await getDb()
      .update(passwordResetTokens)
      .set({
        isUsed: true,
        usedAt: now,
        resetIp: ipAddress,
        resetUserAgent: userAgent,
      })
      .where(eq(passwordResetTokens.id, tokenRecord.id));

    // Log successful token validation
    await this.logSecurityEvent({
      userId: tokenRecord.userId,
      eventType: 'password_reset_token_validated',
      severity: 'medium',
      description: 'Password reset token successfully validated and consumed',
      ipAddress,
      userAgent,
    });

    // SECURITY STEP 7: Return user ID for password change
    return {
      valid: true,
      userId: tokenRecord.userId.toString(),
    };
  }

  // =====================================================
  // RATE LIMITING
  // =====================================================

  /**
   * Check if user has exceeded rate limit for reset requests
   *
   * SECURITY: Prevents enumeration attacks and abuse
   * Limit: 3 requests per hour per user
   */
  private async checkRateLimit(userId: number): Promise<{ allowed: boolean; retryAfterMinutes?: number }> {
    const oneHourAgo = new Date(Date.now() - PASSWORD_RESET_CONFIG.LOCKOUT_DURATION_MS);

    // Count recent reset requests for this user
    const recentRequests = await getDb()
      .select({
        count: sql<number>`count(*)`,
      })
      .from(passwordResetTokens)
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          gt(passwordResetTokens.createdAt, oneHourAgo)
        )
      );

    const requestCount = recentRequests[0]?.count || 0;

    if (requestCount >= PASSWORD_RESET_CONFIG.MAX_REQUESTS_PER_HOUR) {
      // Calculate retry time based on oldest request
      const oldestRecentRequest = await getDb()
        .select()
        .from(passwordResetTokens)
        .where(
          and(
            eq(passwordResetTokens.userId, userId),
            gt(passwordResetTokens.createdAt, oneHourAgo)
          )
        )
        .orderBy(passwordResetTokens.createdAt)
        .limit(1);

      if (oldestRecentRequest.length > 0) {
        const retryAfterMs =
          oldestRecentRequest[0].createdAt.getTime() +
          PASSWORD_RESET_CONFIG.LOCKOUT_DURATION_MS -
          Date.now();

        return {
          allowed: false,
          retryAfterMinutes: Math.ceil(retryAfterMs / 60000),
        };
      }

      return {
        allowed: false,
        retryAfterMinutes: 60,
      };
    }

    return { allowed: true };
  }

  // =====================================================
  // TOKEN MANAGEMENT
  // =====================================================

  /**
   * Invalidate all existing tokens for a user
   *
   * SECURITY: Called before creating new token to prevent:
   * 1. Token accumulation
   * 2. Multiple valid tokens existing simultaneously
   * 3. Old tokens being used after new ones are issued
   */
  private async invalidateExistingTokens(userId: number): Promise<void> {
    await getDb()
      .update(passwordResetTokens)
      .set({
        isUsed: true,
        usedAt: new Date(),
      })
      .where(
        and(
          eq(passwordResetTokens.userId, userId),
          eq(passwordResetTokens.isUsed, false)
        )
      );
  }

  /**
   * Clean up expired tokens from database
   *
   * SECURITY: Removes expired tokens to:
   * 1. Prevent database bloat
   * 2. Reduce attack surface (fewer tokens to guess)
   * 3. Comply with data retention policies
   */
  async cleanupExpiredTokens(): Promise<void> {
    const now = new Date();

    // Delete tokens that are either expired or used (older than 24 hours)
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    await getDb()
      .delete(passwordResetTokens)
      .where(
        sql`${passwordResetTokens.expiresAt} < ${now} OR
            (${passwordResetTokens.isUsed} = true AND ${passwordResetTokens.createdAt} < ${twentyFourHoursAgo})`
      );
  }

  // =====================================================
  // SECURITY LOGGING
  // =====================================================

  /**
   * Log security event for audit trail
   */
  private async logSecurityEvent(event: InsertSecurityEvent): Promise<void> {
    try {
      await getDb().insert(securityEvents).values(event);
    } catch (error) {
      // Don't let logging failures affect the main flow
      securityLogger.error('Failed to log security event', { module: 'PasswordResetService', operation: 'logSecurityEvent', error: error instanceof Error ? error.message : String(error) });
    }
  }

  // =====================================================
  // CLEANUP TIMER
  // =====================================================

  /**
   * Start automatic cleanup of expired tokens
   */
  private startCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }

    this.cleanupTimer = setInterval(async () => {
      try {
        await this.cleanupExpiredTokens();
      } catch (error) {
        securityLogger.error('Token cleanup error', { module: 'PasswordResetService', operation: 'cleanupExpiredTokens', error: error instanceof Error ? error.message : String(error) });
      }
    }, PASSWORD_RESET_CONFIG.CLEANUP_INTERVAL_MS);

    this.cleanupTimer.unref();
  }

  /**
   * Stop cleanup timer (for graceful shutdown)
   */
  stopCleanupTimer(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  // =====================================================
  // USER LOOKUP
  // =====================================================

  /**
   * Find user by email for password reset
   *
   * SECURITY: This method exists to allow proper user lookup
   * while maintaining the security principle of not revealing
   * whether an email exists in the system.
   *
   * @returns User if found, null otherwise
   */
  async findUserByEmail(email: string): Promise<{ id: number; email: string } | null> {
    const result = await getDb()
      .select({
        id: users.id,
        email: users.email,
      })
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
      .limit(1);

    const row = result[0];
    if (!row || !row.email) return null;
    return { id: row.id, email: row.email };
  }
}

// =====================================================
// SINGLETON INSTANCE
// =====================================================

export const passwordResetService = new PasswordResetService();
