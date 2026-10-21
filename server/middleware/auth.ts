/**
 * Authentication Middleware for Wrfcoin API - TypeScript
 *
 * This file implements middleware functions for authenticating API requests.
 *
 * Task 94.2: Updated to support RS256 algorithm for JWT verification
 * Task 80: Gap 3 - Migrated from in-memory Map to Redis session storage
 */

import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../auth/jwt-constants.js';
import { hasAdminRole } from '../utils/admin-role.js';
import * as fs from 'fs';
import { createHash } from 'crypto';
import {
  JWTPayload,
  AuthenticatedRequest,
  APIKeyValidation,
  AuthenticationResult,
} from '../../shared/types/security-types.js';
import { sessionService, UserSession } from '../services/redis-session-service.js';
import { securityLogger } from '../utils/logger.js';
import { apiKeys, apiKeyUsage, apiKeyRateLimits } from '../../shared/schema-api-keys.js';
import { eq, and, gte } from 'drizzle-orm';
import { db } from '../../database/connection.js';
import { createRedisClient } from '../utils/create-redis.js';
import type Redis from 'ioredis';

const WALLET_ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

interface AuthConfig {
  jwtSecret: string | Buffer;  // Can be secret string or public key
  jwtAlgorithm: jwt.Algorithm;
  jwtExpiresIn: string;
  apiKeyHeader: string;
  bypassAuthInDev: boolean;
}


/**
 * Hash an API key using SHA-256 for database comparison.
 * Uses the same algorithm used when keys are stored.
 */
function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

// UserSession interface now imported from redis-session-service

/** Default TTL for revoked token entries in Redis (seconds). Caps storage at 24h. */
const REVOCATION_TTL_SECONDS = 24 * 60 * 60;

/** Redis key prefix for revoked JWT identifiers. */
const REVOCATION_KEY_PREFIX = 'jwt:revoked:';

/** Legacy Redis key prefix used before the JWT identifier migration. */
const LEGACY_REVOCATION_KEY_PREFIX = 'revoked:jwt:';

/** Redis eviction policy required for durable JWT revocation persistence. */
const REQUIRED_REVOCATION_REDIS_POLICY = 'noeviction';

class AuthRevocationStoreUnavailableError extends Error {
  constructor(message = 'JWT revocation store is unavailable') {
    super(message);
    this.name = 'AuthRevocationStoreUnavailableError';
  }
}

class AuthenticationMiddleware {
  private config: AuthConfig;
  // L1 in-memory cache — fast path for hot revocations within this process lifetime.
  // Stores JWT identifiers (`jti` / `sessionId`) instead of raw token strings.
  private revokedTokens: Set<string> = new Set();
  // L2 persistent store — survives restarts (issue #623)
  private redisClient: Redis | null = null;
  private isRedisAvailable: boolean = false;
  private revocationRedisPolicySafe: boolean = false;
  private revocationPolicyCheckPromise: Promise<void> | null = null;

  constructor() {
    this.initRevocationRedis();
    // Task 94.2: Load RS256 public key for JWT verification
    const JWT_PUBLIC_KEY_PATH = process.env.JWT_PUBLIC_KEY_PATH || 'keys/jwt-public.pem';

    let jwtSecret: string | Buffer;
    let jwtAlgorithm: jwt.Algorithm = 'HS256';

    try {
      // Try to load RS256 public key
      jwtSecret = fs.readFileSync(JWT_PUBLIC_KEY_PATH, 'utf8');
      if (jwtSecret.includes('BEGIN PUBLIC KEY') || jwtSecret.includes('BEGIN RSA PUBLIC KEY')) {
        jwtAlgorithm = 'RS256';
        securityLogger.info('Auth middleware: RS256 public key loaded for JWT verification');
      } else {
        throw new Error('Invalid public key format');
      }
    } catch (error) {
      // Fall back to HS256 with JWT_SECRET
      securityLogger.warn('Auth middleware: RS256 key not found, falling back to HS256');
      const secret = process.env.JWT_SECRET;
      if (!secret) {
        throw new Error(
          'JWT_SECRET environment variable is required when RS256 key is not configured. ' +
          'Set JWT_SECRET (min 32 characters) or provide a valid JWT_PUBLIC_KEY_PATH.'
        );
      }
      if (secret.length < 32) {
        throw new Error(
          'JWT_SECRET must be at least 32 characters'
        );
      }
      jwtSecret = secret;
      jwtAlgorithm = 'HS256';
    }

    // SECURITY FIX: Authentication bypass is now completely disabled
    // Development environments should use proper test credentials
    this.config = {
      jwtSecret,
      jwtAlgorithm,
      jwtExpiresIn: process.env.JWT_EXPIRES_IN || '1h', // Updated to 1h for access tokens
      apiKeyHeader: 'X-API-Key',
      bypassAuthInDev: false, // CRITICAL: Bypass permanently disabled
    };

    securityLogger.info('Auth middleware initialized', { algorithm: jwtAlgorithm });
  }

  // ============================================================================
  // Redis-backed Token Revocation (issue #623)
  // ============================================================================

  /**
   * Initialize a dedicated Redis client for token revocation persistence.
   * Uses the shared createRedisClient factory in explicit fail-closed mode.
   * The in-memory set is only an L1 denial cache; it is never sufficient to
   * prove that a token is not revoked.
   */
  private initRevocationRedis(): void {
    try {
      this.redisClient = createRedisClient({
        failureMode: 'fail-closed',
        lazyConnect: true,
        enableReadyCheck: false,
      });
      this.revocationRedisPolicySafe = false;

      this.redisClient.on('connect', () => {
        this.isRedisAvailable = true;
        securityLogger.info('[AuthRevocation] Redis connected — revocations will persist across restarts');
      });

      this.redisClient.on('error', (error) => {
        securityLogger.warn('[AuthRevocation] Redis error — authentication will fail closed', {
          error: error.message,
        });
        this.isRedisAvailable = false;
      });

      this.redisClient.on('close', () => {
        this.isRedisAvailable = false;
        this.revocationRedisPolicySafe = false;
      });

      this.redisClient.on('ready', () => {
        this.isRedisAvailable = true;
        this.revocationPolicyCheckPromise = this.refreshRevocationRedisPolicy();
      });

      this.redisClient.connect().catch((error) => {
        securityLogger.warn('[AuthRevocation] Redis connection failed — authentication will fail closed', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.isRedisAvailable = false;
      });
    } catch (error) {
      securityLogger.warn('[AuthRevocation] Failed to initialize Redis client — authentication will fail closed', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.isRedisAvailable = false;
    }
  }

  /**
   * Verify that the Redis instance uses a non-evicting policy before trusting it
   * for durable JWT revocation persistence.
   */
  private async refreshRevocationRedisPolicy(): Promise<void> {
    if (!this.redisClient) {
      this.revocationRedisPolicySafe = false;
      return;
    }

    try {
      const policyResult = await this.redisClient.config('GET', 'maxmemory-policy');
      const policy = Array.isArray(policyResult)
        ? policyResult[1]
        : typeof policyResult === 'string'
          ? policyResult
          : null;

      if (policy?.toLowerCase() === REQUIRED_REVOCATION_REDIS_POLICY) {
        this.revocationRedisPolicySafe = true;
        securityLogger.info('[AuthRevocation] Redis maxmemory-policy=noeviction; revocation persistence enabled');
        return;
      }

      this.revocationRedisPolicySafe = false;
      securityLogger.warn(
        '[AuthRevocation] Redis maxmemory-policy permits eviction; JWT revocation persistence disabled',
        {
          policy: policy || 'unknown',
        }
      );
    } catch (error) {
      this.revocationRedisPolicySafe = false;
      securityLogger.warn(
        '[AuthRevocation] Failed to verify Redis eviction policy; JWT revocation persistence disabled',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  private async waitForRevocationPolicyCheck(): Promise<void> {
    if (this.revocationPolicyCheckPromise) {
      try {
        await this.revocationPolicyCheckPromise;
      } catch {
        // The policy refresh already logged the failure; fall back below.
      }
    }
  }

  /**
   * Compute a SHA-256 hash of the raw JWT token for legacy fallback keys.
   * We never store the raw token in Redis.
   */
  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  /**
   * Extract the revocation identifier and expiry from a token.
   * Prefer `jti`, fall back to `sessionId` for older tokens, and finally
   * hash the raw token so malformed legacy entries can still be revoked.
   */
  private getTokenRevocationMetadata(token: string): {
    revocationId: string;
    expiresAt: number | null;
  } {
    const decoded = jwt.decode(token);

    if (decoded && typeof decoded !== 'string') {
      const payload = decoded as jwt.JwtPayload & Partial<JWTPayload>;
      return {
        revocationId:
          payload.jti || payload.sessionId || this.hashToken(token),
        expiresAt: typeof payload.exp === 'number' ? payload.exp : null,
      };
    }

    return {
      revocationId: this.hashToken(token),
      expiresAt: null,
    };
  }

  private getRevocationKey(revocationId: string): string {
    return `${REVOCATION_KEY_PREFIX}${revocationId}`;
  }

  private getLegacyRevocationKey(token: string): string {
    return `${LEGACY_REVOCATION_KEY_PREFIX}${this.hashToken(token)}`;
  }

  private getRevocationTtlSeconds(expiresAt: number | null): number {
    if (typeof expiresAt !== 'number') {
      return REVOCATION_TTL_SECONDS;
    }

    const remaining = expiresAt - Math.floor(Date.now() / 1000);
    if (remaining <= 0) {
      return 1;
    }

    return Math.min(remaining, REVOCATION_TTL_SECONDS);
  }

  /**
   * Check whether a token has been revoked.
   * L1: in-memory Set (instant, covers tokens revoked in this process lifetime).
   * L2: Redis lookup (covers tokens revoked by other processes or before restart).
   *
   * If a Redis hit is found, the revocation id is promoted into the in-memory
   * Set so subsequent checks for the same token are O(1).
   */
  private async isTokenRevoked(token: string): Promise<boolean> {
    const { revocationId } = this.getTokenRevocationMetadata(token);

    // L1 can prove a token IS revoked, even during an outage.  An L1 miss
    // cannot prove the token is safe because another process may have revoked
    // it, so the authoritative Redis check remains mandatory.
    if (this.revokedTokens.has(revocationId)) {
      return true;
    }

    await this.waitForRevocationPolicyCheck();

    if (!this.isRedisAvailable || !this.redisClient || !this.revocationRedisPolicySafe) {
      throw new AuthRevocationStoreUnavailableError();
    }

    try {
      const result = await this.redisClient.exists(this.getRevocationKey(revocationId));
      if (result === 1) {
        // Promote to L1 cache so we don't hit Redis again for the same token
        this.revokedTokens.add(revocationId);
        return true;
      }

      const legacyKey = this.getLegacyRevocationKey(token);
      if (legacyKey !== this.getRevocationKey(revocationId)) {
        const legacyResult = await this.redisClient.exists(legacyKey);
        if (legacyResult === 1) {
          this.revokedTokens.add(revocationId);
          return true;
        }
      }
    } catch (error) {
      securityLogger.warn('[AuthRevocation] Redis lookup failed — authentication will fail closed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AuthRevocationStoreUnavailableError();
    }

    return false;
  }

  /**
   * Middleware to authenticate API requests with JWT tokens
   * SECURITY: Authentication bypass removed - all requests require valid tokens
   * Task 80: Updated to use Redis session service for distributed session management
   */
  authenticateJWT = (req: Request, res: Response, next: NextFunction): Promise<void> =>
    this.runJwtAuthentication(req, res, next, true);

  /**
   * authenticateJWT but a live Redis session is ALWAYS required: wallet-login tokens (no
   * sessionId) are refused. For routes whose logic has not been reviewed for wallet callers
   * (gas sponsorship, sensor upload). backend#1297.
   */
  authenticateSessionJWT = (req: Request, res: Response, next: NextFunction): Promise<void> =>
    this.runJwtAuthentication(req, res, next, false);

  private runJwtAuthentication = async (
    req: Request,
    res: Response,
    next: NextFunction,
    allowWalletTokens: boolean,
  ): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const authHeader = req.get('authorization');
    const token =
      authHeader && authHeader.startsWith('Bearer ')
        ? authHeader.substring(7)
        : null;

    if (!token) {
      res.status(401).json({
        success: false,
        error: {
          code: 'NO_TOKEN',
          message: 'Access token is required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Redis is authoritative for cross-process revocation state.  If it cannot
    // prove a token is not revoked, refuse the request instead of authenticating
    // from incomplete process-local state.
    try {
      if (await this.isTokenRevoked(token)) {
        res.status(401).json({
          success: false,
          error: {
            code: 'TOKEN_REVOKED',
            message: 'Token has been revoked',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }
    } catch (error) {
      securityLogger.error('[AuthRevocation] Refusing authentication: revocation store unavailable', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(503).json({
        success: false,
        error: {
          code: 'AUTH_REVOCATION_STORE_UNAVAILABLE',
          message: 'Authentication temporarily unavailable',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    try {
      // SECURITY FIX (Task 94.2): Support RS256 and prevent 'none' algorithm attack
      // Explicitly specify allowed algorithms based on configuration
      const allowedAlgorithms: jwt.Algorithm[] = this.config.jwtAlgorithm === 'RS256'
        ? ['RS256']  // Only allow RS256 when using asymmetric keys
        : ['HS256', 'HS384', 'HS512']; // Allow HMAC algorithms for symmetric keys

      const decoded = jwt.verify(token, this.config.jwtSecret, {
        algorithms: allowedAlgorithms,
        issuer: JWT_ISSUER, // Verify issuer
        audience: JWT_AUDIENCE, // Verify audience
        clockTolerance: 30, // 30 second clock tolerance
      }) as JWTPayload;

      // backend#1297 (owner ruling 2026-09-30, option a): a wallet-login ACCESS token carries no sessionId
      // ({sub, address, role:'wallet', type:'access'}, signed by wallet-auth-service) and its
      // lifetime is bounded by its own expiry plus refresh-token rotation, so there is no Redis
      // session to look up. Everything else, including any token that names a sessionId, keeps the
      // session requirement. The signature, issuer, audience, expiry and revocation checks above
      // have already run.
      const walletClaims = decoded as unknown as Record<string, unknown>;
      if (
        allowWalletTokens &&
        walletClaims.sessionId === undefined &&
        walletClaims.role === 'wallet' &&
        walletClaims.type === 'access' &&
        typeof walletClaims.sub === 'string' &&
        WALLET_ADDRESS_PATTERN.test(walletClaims.sub) &&
        walletClaims.address === walletClaims.sub
      ) {
        authReq.user = {
          id: walletClaims.sub,
          userId: walletClaims.sub,
          address: walletClaims.sub,
          walletAddress: walletClaims.sub,
          role: 'wallet',
          roles: ['wallet'],
          permissions: [],
        };
        next();
        return;
      }

      // Task 80: Validate session using Redis service (with in-memory fallback)
      const session = await sessionService.validateSession(decoded.sessionId);
      if (!session) {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_SESSION',
            message: 'Session not found or expired',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Add user info to request
      authReq.user = {
        id: decoded.userId,
        userId: decoded.userId,
        roles: decoded.roles,
        permissions: decoded.permissions,
        sessionId: decoded.sessionId,
      };

      next();
    } catch (error) {
      res.status(403).json({
        success: false,
        error: {
          code: 'INVALID_TOKEN',
          message: 'Invalid or expired token',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }
  };

  /**
   * Middleware to authenticate API requests with API keys
   * SECURITY: Authentication bypass removed - all requests require valid API keys
   * Issue #132: Now validates API keys against database with revocation and rate limit checks
   */
  authenticateApiKey = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const apiKey = req.get(this.config.apiKeyHeader);

    if (!apiKey) {
      res.status(401).json({
        success: false,
        error: {
          code: 'NO_API_KEY',
          message: 'API key is required',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Validate API key format first, then verify against database
    const validation = await this.validateApiKey(apiKey);
    if (!validation.isValid) {
      securityLogger.warn('API key authentication failed', {
        reason: validation.reason,
        apiKey: this.maskApiKey(apiKey),
        ip: req.ip || req.connection?.remoteAddress,
        path: req.path,
      });
      res.status(401).json({
        success: false,
        error: {
          code: 'INVALID_API_KEY',
          message: validation.reason || 'Invalid API key',
        },
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Add API key info to request
    (authReq as any).apiKey = {
      key: this.maskApiKey(apiKey),
      permissions: validation.permissions || [],
      rateLimitTier: validation.rateLimitTier || 'standard',
    };

    securityLogger.info('Request authenticated with API key', {
      method: req.method,
      path: req.path,
      apiKey: this.maskApiKey(apiKey),
    });
    next();
  };

  /**
   * Optional authentication middleware (allows unauthenticated requests)
   */
  optionalAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const authReq = req as AuthenticatedRequest;
    const authHeader = req.get('authorization');
    const apiKey = req.get(this.config.apiKeyHeader);

    if (authHeader && authHeader.startsWith('Bearer ')) {
      // Try JWT authentication
      return this.authenticateJWT(req, res, next);
    } else if (apiKey) {
      // Try API key authentication
      return this.authenticateApiKey(req, res, next);
    } else {
      // No authentication provided, continue as anonymous
      authReq.user = {
        id: 'anonymous',
        userId: 'anonymous',
        roles: ['anonymous'],
        permissions: ['read:public'],
        sessionId: 'anonymous',
      };
      next();
    }
  };

  /**
   * Role-based authorization middleware
   */
  requireRole = (requiredRoles: string[]) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user) {
        res.status(401).json({
          success: false,
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'Authentication is required',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const hasRequiredRole = requiredRoles.some(
        role =>
          (Array.isArray(authReq.user!.roles) && authReq.user!.roles.includes(role)) ||
          hasAdminRole(authReq.user)
      );

      if (!hasRequiredRole) {
        res.status(403).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: `Required roles: ${requiredRoles.join(', ')}`,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      next();
    };
  };

  /**
   * Permission-based authorization middleware
   */
  requirePermission = (requiredPermission: string) => {
    return (req: Request, res: Response, next: NextFunction): void => {
      const authReq = req as AuthenticatedRequest;
      if (!authReq.user) {
        res.status(401).json({
          success: false,
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'Authentication is required',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const hasPermission =
        authReq.user.permissions?.includes(requiredPermission) ||
        authReq.user.permissions?.includes('*') ||
        hasAdminRole(authReq.user);

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_PERMISSIONS',
            message: `Required permission: ${requiredPermission}`,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      next();
    };
  };

  /**
   * Generate JWT token for user
   * SECURITY (Task 94.2): Enhanced with RS256 support and explicit algorithm
   * Task 80: Updated to store sessions in Redis for distributed deployments
   *
   * NOTE: For new implementations, prefer using the auth routes (/api/auth/login)
   * which provide access + refresh token pairs. This method is for backward
   * compatibility and internal session management.
   */
  async generateToken(
    userId: string,
    roles: string[],
    permissions: string[]
  ): Promise<{ token: string; sessionId: string; expiresAt: Date }> {
    const sessionId = this.generateSessionId();
    // Updated: 1 hour for access tokens (Task 94.2)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

    const payload: Omit<JWTPayload, 'exp'> & { jti: string } = {
      userId,
      roles,
      permissions,
      sessionId,
      jti: sessionId,
      iat: Math.floor(Date.now() / 1000),
    };

    // SECURITY FIX (Task 94.2): Use configured algorithm (RS256 or HS256)
    const token = jwt.sign(payload, this.config.jwtSecret, {
      algorithm: this.config.jwtAlgorithm,
      expiresIn: this.config.jwtExpiresIn,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    } as jwt.SignOptions);

    // Task 80: Store session in Redis (with in-memory fallback)
    await sessionService.createSession({
      userId,
      roles,
      permissions,
      sessionId,
      createdAt: new Date(),
      lastActivity: new Date(),
    });

    return { token, sessionId, expiresAt };
  }

  /**
   * Revoke JWT token
   * SECURITY (Task 94.2): Enhanced token verification during revocation
   * Task 80: Updated to invalidate session in Redis
   * Issue #623: Persist revocation to Redis so it survives server restarts
   */
  async revokeToken(token: string): Promise<void> {
    const { revocationId, expiresAt } = this.getTokenRevocationMetadata(token);
    await this.waitForRevocationPolicyCheck();

    // L1 — always add the JWT identifier to in-memory Set for fast lookups
    this.revokedTokens.add(revocationId);

    if (!this.isRedisAvailable || !this.redisClient || !this.revocationRedisPolicySafe) {
      throw new AuthRevocationStoreUnavailableError(
        'Cannot durably revoke token while JWT revocation store is unavailable'
      );
    }

    // L2 — persist to Redis with TTL matching token's remaining lifetime.
    // A process-local revocation is not a successful distributed revocation.
    try {
      const ttlSeconds = this.getRevocationTtlSeconds(expiresAt);
      const newKey = this.getRevocationKey(revocationId);
      const legacyKey = this.getLegacyRevocationKey(token);

      await this.redisClient.setex(newKey, ttlSeconds, '1');
      if (legacyKey !== newKey) {
        await this.redisClient.setex(legacyKey, ttlSeconds, '1');
      }
      securityLogger.info('[AuthRevocation] Token revocation persisted to Redis', {
        revocationId,
        ttlSeconds,
      });
    } catch (error) {
      securityLogger.warn('[AuthRevocation] Failed to persist revocation to Redis — revocation failed closed', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw new AuthRevocationStoreUnavailableError(
        'Cannot durably revoke token while JWT revocation store is unavailable'
      );
    }

    try {
      // Use same security settings as verification
      const allowedAlgorithms: jwt.Algorithm[] = this.config.jwtAlgorithm === 'RS256'
        ? ['RS256']
        : ['HS256', 'HS384', 'HS512'];

      const decoded = jwt.verify(token, this.config.jwtSecret, {
        algorithms: allowedAlgorithms,
      }) as JWTPayload;

      // Task 80: Invalidate session in Redis (with in-memory fallback)
      await sessionService.invalidateSession(decoded.sessionId);
    } catch (error) {
      // Token already invalid, ignore
    }
  }

  /**
   * Validate API key format and authenticity against the database.
   *
   * SECURITY: API keys must follow a strict format to prevent brute-force attacks.
   * Format: wrfc_{environment}_{base64_encoded_payload}
   * - Prefix: 'wrfc_' followed by environment ('live', 'test', 'dev')
   * - Payload: 32+ bytes of cryptographic randomness, base64 encoded
   *
   * Issue #132: Now performs database lookup for key hash, revocation check,
   * expiration check, and rate limiting per key.
   */
  private async validateApiKey(apiKey: string): Promise<APIKeyValidation> {
    // Minimum length check (prefix + environment + underscore + base64 payload)
    if (!apiKey || apiKey.length < 40) {
      return {
        isValid: false,
        reason: 'API key too short',
      };
    }

    // Maximum length check to prevent DoS via long strings
    if (apiKey.length > 128) {
      return {
        isValid: false,
        reason: 'API key too long',
      };
    }

    // SECURITY: Validate API key format with strict regex pattern
    // Pattern: wrfc_{live|test|dev}_{base64-safe characters, 32-96 chars}
    const apiKeyPattern = /^wrfc_(live|test|dev)_[A-Za-z0-9+/=]{32,96}$/;
    if (!apiKeyPattern.test(apiKey)) {
      return {
        isValid: false,
        reason: 'Invalid API key format. Expected format: wrfc_{environment}_{key}',
      };
    }

    // Extract environment from the key
    const parts = apiKey.split('_');
    if (parts.length !== 3) {
      return {
        isValid: false,
        reason: 'Invalid API key structure',
      };
    }

    const [prefix, environment, payload] = parts;

    // Verify prefix
    if (prefix !== 'wrfc') {
      return {
        isValid: false,
        reason: 'Invalid API key prefix',
      };
    }

    // Issue #132: Database lookup for API key validation
    try {
      const keyHash = hashApiKey(apiKey);
      const keyRecords = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1);

      if (keyRecords.length === 0) {
        securityLogger.warn('API key not found in database', {
          keyPrefix: apiKey.substring(0, 12),
        });
        return {
          isValid: false,
          reason: 'API key not recognized',
        };
      }

      const keyRecord = keyRecords[0];

      // Check if key has been revoked
      if (keyRecord.revokedAt !== null) {
        securityLogger.warn('Revoked API key used', {
          keyId: keyRecord.id,
          revokedAt: keyRecord.revokedAt?.toISOString(),
        });
        return {
          isValid: false,
          reason: 'API key has been revoked',
        };
      }

      // Check if key is active
      if (!keyRecord.isActive) {
        securityLogger.warn('Inactive API key used', {
          keyId: keyRecord.id,
        });
        return {
          isValid: false,
          reason: 'API key is inactive',
        };
      }

      // Check if key has expired
      if (keyRecord.expiresAt && keyRecord.expiresAt < new Date()) {
        securityLogger.warn('Expired API key used', {
          keyId: keyRecord.id,
          expiresAt: keyRecord.expiresAt.toISOString(),
        });
        return {
          isValid: false,
          reason: 'API key has expired',
        };
      }

      // Rate limit check: verify daily request count
      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const dailyLimit = keyRecord.dailyRequestLimit || 10000;

      const rateLimitRecords = await db
        .select({ requestCount: apiKeyRateLimits.requestCount })
        .from(apiKeyRateLimits)
        .where(
          and(
            eq(apiKeyRateLimits.apiKeyId, keyRecord.id),
            eq(apiKeyRateLimits.windowType, 'day'),
            gte(apiKeyRateLimits.windowStart, startOfDay)
          )
        )
        .limit(1);

      if (rateLimitRecords.length > 0 && rateLimitRecords[0].requestCount >= dailyLimit) {
        securityLogger.warn('API key daily rate limit exceeded', {
          keyId: keyRecord.id,
          limit: dailyLimit,
          current: rateLimitRecords[0].requestCount,
        });
        return {
          isValid: false,
          reason: 'Daily rate limit exceeded',
        };
      }

      // Update last used timestamp (fire-and-forget, don't block the request)
      db.update(apiKeys)
        .set({ lastUsedAt: now, updatedAt: now })
        .where(eq(apiKeys.id, keyRecord.id))
        .catch(err => {
          securityLogger.error('Failed to update API key last used timestamp', { error: String(err) });
        });

      // Audit log: record key usage
      securityLogger.info('API key validated successfully', {
        keyId: keyRecord.id,
        userId: keyRecord.userId,
        rateLimitTier: keyRecord.rateLimitTier,
      });

      const permissions = Array.isArray(keyRecord.permissions)
        ? (keyRecord.permissions as string[])
        : ['read'];

      return {
        isValid: true,
        permissions,
        rateLimitTier: keyRecord.rateLimitTier,
        environment: environment as 'live' | 'test' | 'dev',
      };
    } catch (error) {
      securityLogger.error('API key database validation error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        isValid: false,
        reason: 'Internal validation error',
      };
    }
  }

  /**
   * Mask API key for logging
   */
  private maskApiKey(apiKey: string): string {
    if (apiKey.length <= 8) return '*'.repeat(apiKey.length);
    return `${apiKey.substring(0, 4)}...${apiKey.substring(apiKey.length - 4)}`;
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Clean up expired sessions
   * Task 80: Delegates to Redis session service (Redis handles TTL automatically)
   */
  async cleanupExpiredSessions(): Promise<void> {
    // Redis handles TTL automatically for session expiration
    // This method is kept for backward compatibility and handles in-memory fallback cleanup
    await sessionService.cleanupExpiredSessions();
  }

  /**
   * Get active session count
   * Task 80: Delegates to Redis session service
   */
  async getActiveSessionCount(): Promise<number> {
    return await sessionService.getActiveSessionCount();
  }

  /**
   * Get session service health status
   * Task 80: New method to check Redis connectivity
   */
  getSessionServiceHealth(): { redis: boolean; inMemorySessionCount: number; mode: 'redis' | 'memory' } {
    return sessionService.getHealthStatus();
  }
}

// Create singleton instance
const authMiddleware = new AuthenticationMiddleware();

// Export middleware functions
export const authenticateJWT = authMiddleware.authenticateJWT;
export const authenticateSessionJWT = authMiddleware.authenticateSessionJWT;
export const authenticateApiKey = authMiddleware.authenticateApiKey;
export const optionalAuth = authMiddleware.optionalAuth;
export const requireRole = authMiddleware.requireRole;
export const requirePermission = authMiddleware.requirePermission;
export const generateToken = authMiddleware.generateToken.bind(authMiddleware);
export const revokeToken = authMiddleware.revokeToken.bind(authMiddleware);

// Task 80: New exports for session management
export const getSessionServiceHealth = authMiddleware.getSessionServiceHealth.bind(authMiddleware);
export const cleanupExpiredSessions = authMiddleware.cleanupExpiredSessions.bind(authMiddleware);
export const getActiveSessionCount = authMiddleware.getActiveSessionCount.bind(authMiddleware);

export default authMiddleware;
