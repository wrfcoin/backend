/**
 * API Key Management Service
 * Provides secure operations for API key lifecycle management
 */

import crypto from 'crypto';
import { appLogger, logError } from '../server/utils/logger.js';
import { eq, and, desc, gte, lte, count, sql } from 'drizzle-orm';
import db from '../drizzle/db.js'; // Assuming database connection exists
import {
  apiKeys,
  apiKeyUsage,
  apiKeyRateLimits,
  apiKeyEvents,
  type ApiKey,
  type NewApiKey,
  type NewApiKeyUsage,
  type NewApiKeyEvent,
  API_PERMISSIONS,
  RATE_LIMIT_TIERS,
  API_KEY_EVENTS,
} from '../shared/schema-api-keys.js';

// Configuration
const API_KEY_CONFIG = {
  PREFIX: 'wrf',
  KEY_LENGTH: 32, // Bytes for the random part
  HASH_ALGORITHM: 'sha256',
  ENCRYPTION_ALGORITHM: 'aes-256-gcm',
  get ENCRYPTION_KEY(): string {
    const key = process.env.API_KEY_ENCRYPTION_KEY;
    if (!key) {
      throw new Error(
        'FATAL: API_KEY_ENCRYPTION_KEY environment variable must be set. ' +
        'Generate one with: openssl rand -hex 32'
      );
    }
    return key;
  },
  DEFAULT_EXPIRY_DAYS: 365,
  RATE_LIMITS: {
    [RATE_LIMIT_TIERS.BASIC]: { daily: 1000, monthly: 30000 },
    [RATE_LIMIT_TIERS.STANDARD]: { daily: 10000, monthly: 300000 },
    [RATE_LIMIT_TIERS.PREMIUM]: { daily: 100000, monthly: 3000000 },
    [RATE_LIMIT_TIERS.ENTERPRISE]: { daily: 1000000, monthly: 30000000 },
  },
};

function assertApiKeyEncryptionKeyPresent(): void {
  void API_KEY_CONFIG.ENCRYPTION_KEY;
}

export interface CreateApiKeyRequest {
  userId: string;
  name: string;
  description?: string;
  permissions?: string[];
  scopes?: string[];
  rateLimitTier?: string;
  expiryDays?: number;
  allowedIps?: string[];
  allowedDomains?: string[];
  environment?: string;
}

export interface ApiKeyValidationResult {
  isValid: boolean;
  apiKey?: ApiKey;
  error?: string;
  rateLimited?: boolean;
  remainingQuota?: {
    daily: number;
    monthly: number;
  };
}

export interface ApiKeyStats {
  totalRequests: number;
  requestsToday: number;
  requestsThisMonth: number;
  lastUsed?: Date;
  averageResponseTime: number;
  errorRate: number;
}

export class ApiKeyService {
  constructor() {
    assertApiKeyEncryptionKeyPresent();
  }

  /**
   * Generate a cryptographically secure API key
   */
  private generateApiKey(): { key: string; hash: string; prefix: string } {
    // Generate random bytes
    const randomBytes = crypto.randomBytes(API_KEY_CONFIG.KEY_LENGTH);
    const randomString = randomBytes.toString('hex');

    // Create the full key with prefix
    const key = `${API_KEY_CONFIG.PREFIX}_${randomString}`;

    // Create hash for storage
    const hash = crypto
      .createHash(API_KEY_CONFIG.HASH_ALGORITHM)
      .update(key)
      .digest('hex');

    // Create prefix for display
    const prefix = key.substring(0, 12) + '...';

    return { key, hash, prefix };
  }

  /**
   * Create a new API key
   */
  async createApiKey(
    request: CreateApiKeyRequest
  ): Promise<{ apiKey: ApiKey; rawKey: string }> {
    const { key, hash, prefix } = this.generateApiKey();

    // Set rate limits based on tier
    const tierLimits =
      API_KEY_CONFIG.RATE_LIMITS[
        request.rateLimitTier || RATE_LIMIT_TIERS.STANDARD
      ];

    // Calculate expiry date
    const expiresAt = request.expiryDays
      ? new Date(Date.now() + request.expiryDays * 24 * 60 * 60 * 1000)
      : new Date(
          Date.now() + API_KEY_CONFIG.DEFAULT_EXPIRY_DAYS * 24 * 60 * 60 * 1000
        );

    // Insert the API key
    const [newApiKey] = await db
      .insert(apiKeys)
      .values({
        userId: request.userId,
        name: request.name,
        description: request.description,
        keyHash: hash,
        keyPrefix: prefix,
        permissions: request.permissions || [API_PERMISSIONS.READ],
        scopes: request.scopes || ['*'],
        rateLimitTier: request.rateLimitTier || RATE_LIMIT_TIERS.STANDARD,
        dailyRequestLimit: tierLimits.daily,
        monthlyRequestLimit: tierLimits.monthly,
        expiresAt,
        allowedIps: request.allowedIps || [],
        allowedDomains: request.allowedDomains || [],
        environment: request.environment || 'production',
        createdBy: request.userId,
      })
      .returning();

    // Log the creation event
    await this.logEvent({
      apiKeyId: newApiKey.id,
      eventType: API_KEY_EVENTS.CREATED,
      eventData: {
        name: request.name,
        permissions: request.permissions,
        rateLimitTier: request.rateLimitTier,
      },
      userId: request.userId,
    });

    return { apiKey: newApiKey, rawKey: key };
  }

  /**
   * Validate an API key and check rate limits
   */
  async validateApiKey(
    key: string,
    ipAddress?: string,
    userAgent?: string,
    referrer?: string
  ): Promise<ApiKeyValidationResult> {
    try {
      // Hash the provided key
      const keyHash = crypto
        .createHash(API_KEY_CONFIG.HASH_ALGORITHM)
        .update(key)
        .digest('hex');

      // Find the API key
      const [apiKey] = await db
        .select()
        .from(apiKeys)
        .where(eq(apiKeys.keyHash, keyHash))
        .limit(1);

      if (!apiKey) {
        return { isValid: false, error: 'Invalid API key' };
      }

      // Check if key is active
      if (!apiKey.isActive) {
        return { isValid: false, error: 'API key is disabled' };
      }

      // Check if key is expired
      if (apiKey.expiresAt && new Date() > apiKey.expiresAt) {
        return { isValid: false, error: 'API key has expired' };
      }

      // Check if key is revoked
      if (apiKey.revokedAt) {
        return { isValid: false, error: 'API key has been revoked' };
      }

      // Check IP restrictions
      const allowedIps = Array.isArray(apiKey.allowedIps)
        ? apiKey.allowedIps
        : [];
      if (ipAddress && allowedIps.length > 0) {
        const isIpAllowed = this.checkIpAllowed(
          ipAddress,
          allowedIps as string[]
        );
        if (!isIpAllowed) {
          return { isValid: false, error: 'IP address not allowed' };
        }
      }

      // Check domain restrictions
      const allowedDomains = Array.isArray(apiKey.allowedDomains)
        ? apiKey.allowedDomains
        : [];
      if (referrer && allowedDomains.length > 0) {
        const isDomainAllowed = this.checkDomainAllowed(
          referrer,
          allowedDomains as string[]
        );
        if (!isDomainAllowed) {
          return { isValid: false, error: 'Domain not allowed' };
        }
      }

      // Check rate limits
      const rateLimitCheck = await this.checkRateLimit(apiKey.id);
      if (rateLimitCheck.rateLimited) {
        return {
          isValid: false,
          error: 'Rate limit exceeded',
          rateLimited: true,
          remainingQuota: rateLimitCheck.remainingQuota,
        };
      }

      // Update last used timestamp
      await db
        .update(apiKeys)
        .set({ lastUsedAt: new Date() })
        .where(eq(apiKeys.id, apiKey.id));

      return {
        isValid: true,
        apiKey,
        remainingQuota: rateLimitCheck.remainingQuota,
      };
    } catch (error) {
      logError(appLogger, 'API key validation error', error as Error);
      return { isValid: false, error: 'Internal validation error' };
    }
  }

  /**
   * Record API usage for analytics and rate limiting
   */
  async recordUsage(
    apiKeyId: string,
    endpoint: string,
    method: string,
    statusCode: number,
    responseTime?: number,
    metadata?: {
      userAgent?: string;
      ipAddress?: string;
      referrer?: string;
      requestSize?: number;
      responseSize?: number;
      errorCode?: string;
      errorMessage?: string;
    }
  ): Promise<void> {
    try {
      // Record usage
      await db.insert(apiKeyUsage).values({
        apiKeyId,
        endpoint,
        method,
        statusCode,
        responseTime,
        userAgent: metadata?.userAgent,
        ipAddress: metadata?.ipAddress,
        referrer: metadata?.referrer,
        requestSize: metadata?.requestSize,
        responseSize: metadata?.responseSize,
        errorCode: metadata?.errorCode,
        errorMessage: metadata?.errorMessage,
      });

      // Update rate limit counters
      await this.updateRateLimitCounters(apiKeyId, statusCode >= 400);
    } catch (error) {
      logError(appLogger, 'Error recording API usage', error as Error);
    }
  }

  /**
   * Get API keys for a user
   */
  async getUserApiKeys(userId: string): Promise<ApiKey[]> {
    return db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, userId))
      .orderBy(desc(apiKeys.createdAt));
  }

  /**
   * Get API key statistics
   */
  async getApiKeyStats(apiKeyId: string): Promise<ApiKeyStats> {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const [totalStats] = await db
      .select({
        totalRequests: count(),
        avgResponseTime: sql<number>`AVG(${apiKeyUsage.responseTime})`,
        errorCount: sql<number>`COUNT(CASE WHEN ${apiKeyUsage.statusCode} >= 400 THEN 1 END)`,
      })
      .from(apiKeyUsage)
      .where(eq(apiKeyUsage.apiKeyId, apiKeyId));

    const [todayStats] = await db
      .select({ requestsToday: count() })
      .from(apiKeyUsage)
      .where(
        and(
          eq(apiKeyUsage.apiKeyId, apiKeyId),
          gte(apiKeyUsage.requestedAt, todayStart)
        )
      );

    const [monthStats] = await db
      .select({ requestsThisMonth: count() })
      .from(apiKeyUsage)
      .where(
        and(
          eq(apiKeyUsage.apiKeyId, apiKeyId),
          gte(apiKeyUsage.requestedAt, monthStart)
        )
      );

    const [lastUsedRecord] = await db
      .select({ lastUsed: apiKeyUsage.requestedAt })
      .from(apiKeyUsage)
      .where(eq(apiKeyUsage.apiKeyId, apiKeyId))
      .orderBy(desc(apiKeyUsage.requestedAt))
      .limit(1);

    const totalRequests = totalStats?.totalRequests || 0;
    const errorCount = totalStats?.errorCount || 0;

    return {
      totalRequests,
      requestsToday: todayStats?.requestsToday || 0,
      requestsThisMonth: monthStats?.requestsThisMonth || 0,
      lastUsed: lastUsedRecord?.lastUsed || undefined,
      averageResponseTime: totalStats?.avgResponseTime || 0,
      errorRate: totalRequests > 0 ? (errorCount / totalRequests) * 100 : 0,
    };
  }

  /**
   * Revoke an API key
   */
  async revokeApiKey(
    apiKeyId: string,
    revokedBy: string,
    reason?: string
  ): Promise<void> {
    await db
      .update(apiKeys)
      .set({
        isActive: false,
        revokedAt: new Date(),
        revokedBy,
        revokeReason: reason,
      })
      .where(eq(apiKeys.id, apiKeyId));

    // Log the revocation event
    await this.logEvent({
      apiKeyId,
      eventType: API_KEY_EVENTS.REVOKED,
      eventData: { reason },
      userId: revokedBy,
    });
  }

  /**
   * Update API key properties
   */
  async updateApiKey(
    apiKeyId: string,
    updates: {
      name?: string;
      description?: string;
      permissions?: string[];
      scopes?: string[];
      allowedIps?: string[];
      allowedDomains?: string[];
      isActive?: boolean;
    },
    updatedBy: string
  ): Promise<ApiKey> {
    const [updatedKey] = await db
      .update(apiKeys)
      .set({
        ...updates,
        updatedAt: new Date(),
      })
      .where(eq(apiKeys.id, apiKeyId))
      .returning();

    // Log the update event
    await this.logEvent({
      apiKeyId,
      eventType: API_KEY_EVENTS.UPDATED,
      eventData: updates,
      userId: updatedBy,
    });

    return updatedKey;
  }

  /**
   * Check if IP address is allowed
   */
  private checkIpAllowed(ipAddress: string, allowedIps: string[]): boolean {
    // Simple implementation - in production, use proper CIDR checking
    return allowedIps.includes(ipAddress) || allowedIps.includes('*');
  }

  /**
   * Check if domain is allowed
   */
  private checkDomainAllowed(
    referrer: string,
    allowedDomains: string[]
  ): boolean {
    try {
      const url = new URL(referrer);
      const domain = url.hostname;
      return allowedDomains.includes(domain) || allowedDomains.includes('*');
    } catch {
      return false;
    }
  }

  /**
   * Check rate limits for an API key
   */
  private async checkRateLimit(apiKeyId: string): Promise<{
    rateLimited: boolean;
    remainingQuota: { daily: number; monthly: number };
  }> {
    const now = new Date();
    const todayStart = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate()
    );
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    // Get API key limits
    const [apiKey] = await db
      .select({
        dailyRequestLimit: apiKeys.dailyRequestLimit,
        monthlyRequestLimit: apiKeys.monthlyRequestLimit,
      })
      .from(apiKeys)
      .where(eq(apiKeys.id, apiKeyId))
      .limit(1);

    if (!apiKey) {
      return { rateLimited: true, remainingQuota: { daily: 0, monthly: 0 } };
    }

    // Get current usage
    const [dailyUsage] = await db
      .select({ count: count() })
      .from(apiKeyUsage)
      .where(
        and(
          eq(apiKeyUsage.apiKeyId, apiKeyId),
          gte(apiKeyUsage.requestedAt, todayStart)
        )
      );

    const [monthlyUsage] = await db
      .select({ count: count() })
      .from(apiKeyUsage)
      .where(
        and(
          eq(apiKeyUsage.apiKeyId, apiKeyId),
          gte(apiKeyUsage.requestedAt, monthStart)
        )
      );

    const dailyCount = dailyUsage?.count || 0;
    const monthlyCount = monthlyUsage?.count || 0;

    const dailyLimit = apiKey.dailyRequestLimit || 0;
    const monthlyLimit = apiKey.monthlyRequestLimit || 0;

    const rateLimited =
      dailyCount >= dailyLimit || monthlyCount >= monthlyLimit;

    return {
      rateLimited,
      remainingQuota: {
        daily: Math.max(0, dailyLimit - dailyCount),
        monthly: Math.max(0, monthlyLimit - monthlyCount),
      },
    };
  }

  /**
   * Update rate limit counters
   */
  private async updateRateLimitCounters(
    apiKeyId: string,
    isError: boolean
  ): Promise<void> {
    const now = new Date();
    const windows = [
      {
        type: 'minute',
        start: new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          now.getHours(),
          now.getMinutes()
        ),
      },
      {
        type: 'hour',
        start: new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          now.getHours()
        ),
      },
      {
        type: 'day',
        start: new Date(now.getFullYear(), now.getMonth(), now.getDate()),
      },
      { type: 'month', start: new Date(now.getFullYear(), now.getMonth()) },
    ];

    for (const window of windows) {
      const windowEnd = new Date(window.start);
      if (window.type === 'minute')
        windowEnd.setMinutes(windowEnd.getMinutes() + 1);
      else if (window.type === 'hour')
        windowEnd.setHours(windowEnd.getHours() + 1);
      else if (window.type === 'day')
        windowEnd.setDate(windowEnd.getDate() + 1);
      else if (window.type === 'month')
        windowEnd.setMonth(windowEnd.getMonth() + 1);

      await db
        .insert(apiKeyRateLimits)
        .values({
          apiKeyId,
          windowType: window.type,
          windowStart: window.start,
          windowEnd,
          requestCount: 1,
          errorCount: isError ? 1 : 0,
        })
        .onConflictDoUpdate({
          target: [
            apiKeyRateLimits.apiKeyId,
            apiKeyRateLimits.windowType,
            apiKeyRateLimits.windowStart,
          ],
          set: {
            requestCount: sql`${apiKeyRateLimits.requestCount} + 1`,
            errorCount: sql`${apiKeyRateLimits.errorCount} + ${isError ? 1 : 0}`,
            updatedAt: new Date(),
          },
        });
    }
  }

  /**
   * Log an API key event
   */
  private async logEvent(event: {
    apiKeyId: string;
    eventType: string;
    eventData?: any;
    userId: string;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    await db.insert(apiKeyEvents).values({
      apiKeyId: event.apiKeyId,
      eventType: event.eventType,
      eventData: event.eventData || {},
      userId: event.userId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
    });
  }
}
