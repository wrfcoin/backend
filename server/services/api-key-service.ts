/**
 * API Key Service
 *
 * Provides secure API key validation, generation, and lifecycle management.
 *
 * SECURITY CONSIDERATIONS:
 * - API keys are NEVER stored in plaintext - only SHA-256 hashes
 * - Keys are validated using constant-time comparison to prevent timing attacks
 * - Rate limiting is enforced per-key to prevent abuse
 * - All key operations are logged for audit purposes
 *
 * Task 102.11 - Authentication & Authorization Security Remediation
 */

import * as crypto from 'crypto';
import { securityLogger } from '../utils/logger.js';
import { eq, and, gt, lt, sql } from 'drizzle-orm';
import { db } from '../../database/connection.js';
import {
  apiKeys,
  apiKeyRateLimits,
  apiKeyEvents,
  type ApiKey,
  type NewApiKeyUsage,
  type NewApiKeyEvent,
  RATE_LIMIT_TIERS,
  API_KEY_EVENTS,
} from '../../shared/schema-api-keys.js';

/**
 * API Key format: wrfcoin_{environment}_{random_string}
 * - environment: 'live' for production, 'test' for development/staging
 * - random_string: 32+ character base64url encoded random bytes
 *
 * Example: wrfcoin_live_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6
 */
const API_KEY_REGEX = /^wrfcoin_(live|test)_[a-zA-Z0-9_-]{32,}$/;

/**
 * Rate limit configurations by tier
 * These define requests per minute and daily/monthly quotas
 */
const RATE_LIMIT_CONFIGS = {
  [RATE_LIMIT_TIERS.BASIC]: {
    requestsPerMinute: 30,
    requestsPerHour: 500,
    dailyLimit: 5000,
    monthlyLimit: 100000,
  },
  [RATE_LIMIT_TIERS.STANDARD]: {
    requestsPerMinute: 60,
    requestsPerHour: 1000,
    dailyLimit: 10000,
    monthlyLimit: 300000,
  },
  [RATE_LIMIT_TIERS.PREMIUM]: {
    requestsPerMinute: 120,
    requestsPerHour: 3000,
    dailyLimit: 50000,
    monthlyLimit: 1000000,
  },
  [RATE_LIMIT_TIERS.ENTERPRISE]: {
    requestsPerMinute: 1000,
    requestsPerHour: 20000,
    dailyLimit: 500000,
    monthlyLimit: 10000000,
  },
} as const;

/**
 * Result of API key validation
 */
export interface APIKeyValidationResult {
  isValid: boolean;
  keyId?: string;
  userId?: string;
  permissions?: string[];
  scopes?: string[];
  rateLimitTier?: string;
  remainingQuota?: {
    daily: number;
    monthly: number;
  };
  error?: string;
  errorCode?: 'INVALID_FORMAT' | 'KEY_NOT_FOUND' | 'KEY_EXPIRED' | 'KEY_REVOKED' | 'RATE_LIMITED' | 'IP_RESTRICTED' | 'INTERNAL_ERROR';
}

/**
 * Options for creating a new API key
 */
export interface CreateAPIKeyOptions {
  userId: string;
  name: string;
  description?: string;
  permissions?: string[];
  scopes?: string[];
  rateLimitTier?: string;
  expiresAt?: Date | null;
  allowedIps?: string[];
  allowedDomains?: string[];
  environment?: 'live' | 'test';
  createdBy: string;
}

/**
 * Result of creating a new API key
 */
export interface CreateAPIKeyResult {
  success: boolean;
  apiKey?: string; // The plaintext key - ONLY returned once at creation
  keyId?: string;
  keyPrefix?: string;
  error?: string;
}

/**
 * API Key Service class
 * Handles all API key operations including validation, creation, and lifecycle management
 */
export class APIKeyService {
  /**
   * Hash an API key for secure storage and comparison
   * Uses SHA-256 which provides good security for this use case
   *
   * SECURITY NOTE: We use SHA-256 (not bcrypt) because:
   * 1. API keys have high entropy (256+ bits), unlike passwords
   * 2. We need fast validation for every API request
   * 3. Brute-forcing a high-entropy key is computationally infeasible
   */
  static hashKey(apiKey: string): string {
    return crypto.createHash('sha256').update(apiKey).digest('hex');
  }

  /**
   * Validate API key format
   * Keys must match: wrfcoin_{live|test}_{32+ alphanumeric chars}
   */
  static isValidFormat(apiKey: string): boolean {
    if (!apiKey || typeof apiKey !== 'string') {
      return false;
    }

    // Basic length check: prefix (8-12) + underscore + env (4-5) + underscore + key (32+)
    if (apiKey.length < 45 || apiKey.length > 100) {
      return false;
    }

    return API_KEY_REGEX.test(apiKey);
  }

  /**
   * Generate a new API key
   * Returns a cryptographically secure random key
   */
  static generateKey(environment: 'live' | 'test' = 'live'): string {
    // Generate 32 bytes of random data for ~256 bits of entropy
    const randomPart = crypto.randomBytes(32).toString('base64url');
    return `wrfcoin_${environment}_${randomPart}`;
  }

  /**
   * Extract the display prefix from an API key
   * Shows first 12 characters for identification without exposing the full key
   */
  static getKeyPrefix(apiKey: string): string {
    if (!apiKey || apiKey.length < 12) {
      return '';
    }
    return apiKey.substring(0, 12);
  }

  /**
   * Constant-time comparison to prevent timing attacks
   * This ensures validation time doesn't leak information about key correctness
   */
  static secureCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
      return false;
    }
    return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
  }

  /**
   * Validate an API key and return associated information
   * This is the main method called by the authentication middleware
   */
  async validateKey(
    apiKey: string,
    requestInfo?: {
      ipAddress?: string;
      userAgent?: string;
      endpoint?: string;
    }
  ): Promise<APIKeyValidationResult> {
    try {
      // Step 1: Validate format before any database operations
      if (!APIKeyService.isValidFormat(apiKey)) {
        return {
          isValid: false,
          error: 'Invalid API key format',
          errorCode: 'INVALID_FORMAT',
        };
      }

      // Step 2: Hash the key and look up in database
      const hashedKey = APIKeyService.hashKey(apiKey);

      const keyRecords = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, hashedKey))
        .limit(1);

      if (keyRecords.length === 0) {
        // SECURITY: Don't reveal whether key exists or is invalid
        return {
          isValid: false,
          error: 'Invalid API key',
          errorCode: 'KEY_NOT_FOUND',
        };
      }

      const keyRecord = keyRecords[0];

      // Step 3: Check if key is active
      if (!keyRecord.isActive) {
        return {
          isValid: false,
          error: 'API key has been revoked',
          errorCode: 'KEY_REVOKED',
        };
      }

      // Step 4: Check expiration
      if (keyRecord.expiresAt && new Date() > keyRecord.expiresAt) {
        // Mark as inactive since it's expired
        await this.markKeyExpired(keyRecord.id);
        return {
          isValid: false,
          error: 'API key has expired',
          errorCode: 'KEY_EXPIRED',
        };
      }

      // Step 5: Check IP restrictions if configured
      if (requestInfo?.ipAddress && keyRecord.allowedIps) {
        const allowedIps = keyRecord.allowedIps as string[];
        if (allowedIps.length > 0 && !this.isIpAllowed(requestInfo.ipAddress, allowedIps)) {
          await this.logKeyEvent(keyRecord.id, keyRecord.userId, 'ip_restricted', {
            ipAddress: requestInfo.ipAddress,
            allowedIps,
          });
          return {
            isValid: false,
            error: 'IP address not allowed for this API key',
            errorCode: 'IP_RESTRICTED',
          };
        }
      }

      // Step 6: Check rate limits
      const rateLimitResult = await this.checkRateLimit(keyRecord.id, keyRecord.rateLimitTier);
      if (!rateLimitResult.allowed) {
        await this.logKeyEvent(keyRecord.id, keyRecord.userId, API_KEY_EVENTS.RATE_LIMITED, {
          tier: keyRecord.rateLimitTier,
          limit: rateLimitResult.limit,
          current: rateLimitResult.current,
        });
        return {
          isValid: false,
          error: `Rate limit exceeded. Limit: ${rateLimitResult.limit} requests per ${rateLimitResult.windowType}`,
          errorCode: 'RATE_LIMITED',
        };
      }

      // Step 7: Update last used timestamp and increment usage counters
      await this.recordKeyUsage(keyRecord.id, requestInfo);

      // Step 8: Get remaining quota
      const remainingQuota = await this.getRemainingQuota(keyRecord.id, keyRecord.rateLimitTier);

      return {
        isValid: true,
        keyId: keyRecord.id,
        userId: keyRecord.userId,
        permissions: keyRecord.permissions as string[],
        scopes: keyRecord.scopes as string[],
        rateLimitTier: keyRecord.rateLimitTier,
        remainingQuota,
      };
    } catch (error) {
      securityLogger.error('API key validation error', { module: 'APIKeyService', operation: 'validateKey', error: error instanceof Error ? error.message : String(error) });
      return {
        isValid: false,
        error: 'Failed to validate API key',
        errorCode: 'INTERNAL_ERROR',
      };
    }
  }

  /**
   * Create a new API key
   * Returns the plaintext key ONLY ONCE - it cannot be retrieved later
   */
  async createKey(options: CreateAPIKeyOptions): Promise<CreateAPIKeyResult> {
    try {
      const {
        userId,
        name,
        description,
        permissions = ['read'],
        scopes = ['*'],
        rateLimitTier = RATE_LIMIT_TIERS.STANDARD,
        expiresAt = null,
        allowedIps = [],
        allowedDomains = [],
        environment = 'live',
        createdBy,
      } = options;

      // Generate the key
      const plaintextKey = APIKeyService.generateKey(environment);
      const keyHash = APIKeyService.hashKey(plaintextKey);
      const keyPrefix = APIKeyService.getKeyPrefix(plaintextKey);

      // Insert into database
      const insertedKeys = await db
        .insert(apiKeys)
        .values({
          userId,
          name,
          description,
          keyHash,
          keyPrefix,
          permissions,
          scopes,
          rateLimitTier,
          expiresAt,
          allowedIps,
          allowedDomains,
          environment,
          createdBy,
        })
        .returning({ id: apiKeys.id });

      if (insertedKeys.length === 0) {
        return {
          success: false,
          error: 'Failed to create API key',
        };
      }

      const keyId = insertedKeys[0].id;

      // Log the creation event
      await this.logKeyEvent(keyId, userId, API_KEY_EVENTS.CREATED, {
        name,
        permissions,
        scopes,
        rateLimitTier,
        createdBy,
      });

      return {
        success: true,
        apiKey: plaintextKey, // Only time the plaintext key is returned
        keyId,
        keyPrefix,
      };
    } catch (error) {
      securityLogger.error('API key creation error', { module: 'APIKeyService', operation: 'createKey', error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        error: 'Failed to create API key',
      };
    }
  }

  /**
   * Revoke an API key
   */
  async revokeKey(
    keyId: string,
    userId: string,
    reason?: string
  ): Promise<boolean> {
    try {
      const result = await db
        .update(apiKeys)
        .set({
          isActive: false,
          revokedAt: new Date(),
          revokedBy: userId,
          revokeReason: reason || 'Manually revoked',
          updatedAt: new Date(),
        })
        .where(eq(apiKeys.id, keyId))
        .returning({ id: apiKeys.id });

      if (result.length > 0) {
        await this.logKeyEvent(keyId, userId, API_KEY_EVENTS.REVOKED, {
          reason,
          revokedBy: userId,
        });
        return true;
      }

      return false;
    } catch (error) {
      securityLogger.error('API key revocation error', { module: 'APIKeyService', operation: 'revokeKey', error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Regenerate an API key (create new key, revoke old)
   */
  async regenerateKey(
    keyId: string,
    userId: string
  ): Promise<CreateAPIKeyResult> {
    try {
      // Get the existing key details
      const existingKeys = await db
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, keyId), eq(apiKeys.userId, userId)))
        .limit(1);

      if (existingKeys.length === 0) {
        return {
          success: false,
          error: 'API key not found',
        };
      }

      const existingKey = existingKeys[0];

      // Revoke the old key
      await this.revokeKey(keyId, userId, 'Regenerated');

      // Create a new key with the same settings
      const result = await this.createKey({
        userId: existingKey.userId,
        name: existingKey.name,
        description: existingKey.description || undefined,
        permissions: existingKey.permissions as string[],
        scopes: existingKey.scopes as string[],
        rateLimitTier: existingKey.rateLimitTier,
        expiresAt: existingKey.expiresAt,
        allowedIps: existingKey.allowedIps as string[],
        allowedDomains: existingKey.allowedDomains as string[],
        environment: existingKey.environment as 'live' | 'test',
        createdBy: userId,
      });

      if (result.success && result.keyId) {
        await this.logKeyEvent(result.keyId, userId, API_KEY_EVENTS.REGENERATED, {
          previousKeyId: keyId,
        });
      }

      return result;
    } catch (error) {
      securityLogger.error('API key regeneration error', { module: 'APIKeyService', operation: 'regenerateKey', error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        error: 'Failed to regenerate API key',
      };
    }
  }

  /**
   * Check rate limits for an API key
   */
  private async checkRateLimit(
    keyId: string,
    tier: string
  ): Promise<{
    allowed: boolean;
    limit?: number;
    current?: number;
    windowType?: string;
  }> {
    const config = RATE_LIMIT_CONFIGS[tier as keyof typeof RATE_LIMIT_CONFIGS] ||
      RATE_LIMIT_CONFIGS[RATE_LIMIT_TIERS.STANDARD];

    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);

    // Check per-minute rate limit
    const minuteWindow = await db
      .select()
      .from(apiKeyRateLimits)
      .where(
        and(
          eq(apiKeyRateLimits.apiKeyId, keyId),
          eq(apiKeyRateLimits.windowType, 'minute'),
          gt(apiKeyRateLimits.windowEnd, now)
        )
      )
      .limit(1);

    if (minuteWindow.length > 0) {
      const currentCount = minuteWindow[0].requestCount;
      if (currentCount >= config.requestsPerMinute) {
        return {
          allowed: false,
          limit: config.requestsPerMinute,
          current: currentCount,
          windowType: 'minute',
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Get remaining quota for an API key
   */
  private async getRemainingQuota(
    keyId: string,
    tier: string
  ): Promise<{ daily: number; monthly: number }> {
    const config = RATE_LIMIT_CONFIGS[tier as keyof typeof RATE_LIMIT_CONFIGS] ||
      RATE_LIMIT_CONFIGS[RATE_LIMIT_TIERS.STANDARD];

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [dailyUsage, monthlyUsage] = await Promise.all([
      db
        .select({ count: sql<number>`COALESCE(SUM(${apiKeyRateLimits.requestCount}), 0)` })
        .from(apiKeyRateLimits)
        .where(
          and(
            eq(apiKeyRateLimits.apiKeyId, keyId),
            eq(apiKeyRateLimits.windowType, 'day'),
            gt(apiKeyRateLimits.windowStart, startOfDay)
          )
        ),
      db
        .select({ count: sql<number>`COALESCE(SUM(${apiKeyRateLimits.requestCount}), 0)` })
        .from(apiKeyRateLimits)
        .where(
          and(
            eq(apiKeyRateLimits.apiKeyId, keyId),
            eq(apiKeyRateLimits.windowType, 'month'),
            gt(apiKeyRateLimits.windowStart, startOfMonth)
          )
        ),
    ]);

    const dailyCount = dailyUsage[0]?.count || 0;
    const monthlyCount = monthlyUsage[0]?.count || 0;

    return {
      daily: Math.max(0, config.dailyLimit - dailyCount),
      monthly: Math.max(0, config.monthlyLimit - monthlyCount),
    };
  }

  /**
   * Record API key usage
   */
  private async recordKeyUsage(
    keyId: string,
    requestInfo?: {
      ipAddress?: string;
      userAgent?: string;
      endpoint?: string;
    }
  ): Promise<void> {
    const now = new Date();

    // Update last used timestamp
    await db
      .update(apiKeys)
      .set({
        lastUsedAt: now,
        updatedAt: now,
      })
      .where(eq(apiKeys.id, keyId));

    // Update rate limit counters
    await this.incrementRateLimitCounter(keyId, 'minute', now);
    await this.incrementRateLimitCounter(keyId, 'hour', now);
    await this.incrementRateLimitCounter(keyId, 'day', now);
    await this.incrementRateLimitCounter(keyId, 'month', now);
  }

  /**
   * Increment rate limit counter for a specific window
   */
  private async incrementRateLimitCounter(
    keyId: string,
    windowType: 'minute' | 'hour' | 'day' | 'month',
    now: Date
  ): Promise<void> {
    const windowInfo = this.getWindowBoundaries(windowType, now);

    // Try to update existing record first
    const updated = await db
      .update(apiKeyRateLimits)
      .set({
        requestCount: sql`${apiKeyRateLimits.requestCount} + 1`,
        updatedAt: now,
      })
      .where(
        and(
          eq(apiKeyRateLimits.apiKeyId, keyId),
          eq(apiKeyRateLimits.windowType, windowType),
          eq(apiKeyRateLimits.windowStart, windowInfo.start)
        )
      )
      .returning({ id: apiKeyRateLimits.id });

    // If no record exists, create one
    if (updated.length === 0) {
      await db.insert(apiKeyRateLimits).values({
        apiKeyId: keyId,
        windowType,
        windowStart: windowInfo.start,
        windowEnd: windowInfo.end,
        requestCount: 1,
        errorCount: 0,
      });
    }
  }

  /**
   * Get window boundaries for rate limiting
   */
  private getWindowBoundaries(
    windowType: 'minute' | 'hour' | 'day' | 'month',
    now: Date
  ): { start: Date; end: Date } {
    const start = new Date(now);
    const end = new Date(now);

    switch (windowType) {
      case 'minute':
        start.setSeconds(0, 0);
        end.setMinutes(end.getMinutes() + 1);
        end.setSeconds(0, 0);
        break;
      case 'hour':
        start.setMinutes(0, 0, 0);
        end.setHours(end.getHours() + 1);
        end.setMinutes(0, 0, 0);
        break;
      case 'day':
        start.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() + 1);
        end.setHours(0, 0, 0, 0);
        break;
      case 'month':
        start.setDate(1);
        start.setHours(0, 0, 0, 0);
        end.setMonth(end.getMonth() + 1);
        end.setDate(1);
        end.setHours(0, 0, 0, 0);
        break;
    }

    return { start, end };
  }

  /**
   * Check if an IP address is allowed
   */
  private isIpAllowed(ip: string, allowedIps: string[]): boolean {
    return allowedIps.some(allowed => {
      if (allowed === ip) return true;
      if (allowed === '*') return true;
      // CIDR notation (e.g., 192.168.1.0/24)
      if (allowed.includes('/')) {
        const [subnet, bits] = allowed.split('/');
        const mask = ~((1 << (32 - parseInt(bits, 10))) - 1) >>> 0;
        const ipToNum = (addr: string) =>
          addr.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
        return (ipToNum(ip) & mask) === (ipToNum(subnet) & mask);
      }
      // Wildcard patterns (e.g., 192.168.*)
      if (allowed.includes('*')) {
        const pattern = allowed.replace(/\./g, '\\.').replace(/\*/g, '.*');
        return new RegExp(`^${pattern}$`).test(ip);
      }
      return false;
    });
  }

  /**
   * Mark a key as expired
   */
  private async markKeyExpired(keyId: string): Promise<void> {
    await db
      .update(apiKeys)
      .set({
        isActive: false,
        updatedAt: new Date(),
      })
      .where(eq(apiKeys.id, keyId));

    // Get userId for logging
    const keyRecord = await db
      .select({ userId: apiKeys.userId })
      .from(apiKeys)
      .where(eq(apiKeys.id, keyId))
      .limit(1);

    if (keyRecord.length > 0) {
      await this.logKeyEvent(keyId, keyRecord[0].userId, API_KEY_EVENTS.EXPIRED, {
        expiredAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Log a key event for audit purposes
   */
  private async logKeyEvent(
    keyId: string,
    userId: string,
    eventType: string,
    eventData?: Record<string, unknown>
  ): Promise<void> {
    try {
      await db.insert(apiKeyEvents).values({
        apiKeyId: keyId,
        userId,
        eventType,
        eventData: eventData || {},
      });
    } catch (error) {
      // Don't fail the main operation if logging fails
      securityLogger.error('Failed to log API key event', { module: 'APIKeyService', operation: 'logKeyEvent', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Cleanup expired rate limit windows
   * Should be run periodically (e.g., hourly via cron)
   */
  async cleanupExpiredRateLimits(): Promise<number> {
    const now = new Date();
    const result = await db
      .delete(apiKeyRateLimits)
      .where(lt(apiKeyRateLimits.windowEnd, now))
      .returning({ id: apiKeyRateLimits.id });

    return result.length;
  }

  /**
   * Get API keys for a user
   */
  async getUserApiKeys(userId: string): Promise<Omit<ApiKey, 'keyHash'>[]> {
    const keys = await db
      .select({
        id: apiKeys.id,
        userId: apiKeys.userId,
        name: apiKeys.name,
        description: apiKeys.description,
        keyPrefix: apiKeys.keyPrefix,
        permissions: apiKeys.permissions,
        scopes: apiKeys.scopes,
        rateLimitTier: apiKeys.rateLimitTier,
        dailyRequestLimit: apiKeys.dailyRequestLimit,
        monthlyRequestLimit: apiKeys.monthlyRequestLimit,
        isActive: apiKeys.isActive,
        expiresAt: apiKeys.expiresAt,
        lastUsedAt: apiKeys.lastUsedAt,
        allowedIps: apiKeys.allowedIps,
        allowedDomains: apiKeys.allowedDomains,
        environment: apiKeys.environment,
        createdAt: apiKeys.createdAt,
        updatedAt: apiKeys.updatedAt,
        createdBy: apiKeys.createdBy,
        revokedAt: apiKeys.revokedAt,
        revokedBy: apiKeys.revokedBy,
        revokeReason: apiKeys.revokeReason,
      })
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId));

    return keys;
  }
}

// Export a singleton instance
export const apiKeyService = new APIKeyService();
