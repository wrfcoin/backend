/**
 * WebSocket Rate Limiter
 * Task 74: Connection and message rate limiting for WebSocket connections
 *
 * Extends patterns from backend/shared/middleware/rate-limit-redis.ts
 */

import Redis from 'ioredis';
import type { Redis as RedisClient } from 'ioredis';
import {
  WebSocketRateLimitResult,
  WebSocketRateLimitConfig,
  DEFAULT_RATE_LIMIT_CONFIG,
  AuthenticatedWebSocket,
  WebSocketChannel,
} from './types.js';
import { appLogger } from '../../server/utils/logger.js';

// Environment configuration
const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const TRUSTED_PROXIES = (process.env.TRUSTED_PROXIES || '127.0.0.1,::1,::ffff:127.0.0.1')
  .split(',')
  .map((ip) => ip.trim());
const RedisCtor = Redis as unknown as typeof import('ioredis').Redis;

/**
 * WebSocket Rate Limiter
 * Provides connection and message rate limiting for WebSocket connections
 */
export class WebSocketRateLimiter {
  private redis: RedisClient;
  private config: WebSocketRateLimitConfig;
  private localFallback: Map<string, { count: number; resetAt: number }>;
  private isRedisAvailable: boolean = true;

  constructor(config: Partial<WebSocketRateLimitConfig> = {}) {
    this.config = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
    this.localFallback = new Map();

    // Initialize Redis connection
    this.redis = new RedisCtor(REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: true,
      retryStrategy: (times: number) => {
        if (times > 5) {
          appLogger.warn('Redis connection failed, using local fallback', { module: 'WSRateLimit' });
          this.isRedisAvailable = false;
          return null;
        }
        return Math.min(times * 100, 2000);
      },
    });

    this.redis.on('connect', () => {
      this.isRedisAvailable = true;
    });

    this.redis.on('error', () => {
      this.isRedisAvailable = false;
    });

    // Connect
    this.redis.connect().catch(() => {
      this.isRedisAvailable = false;
    });

    // Clean up local fallback periodically
    setInterval(() => this.cleanupLocalFallback(), 60000);
  }

  /**
   * Check connection rate limit (per IP)
   */
  async checkConnectionLimit(ipAddress: string): Promise<WebSocketRateLimitResult> {
    const normalizedIp = this.normalizeIp(ipAddress);

    // Check if IP is blocked
    const blockStatus = await this.isIpBlocked(normalizedIp);
    if (blockStatus.blocked) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: Date.now() + (blockStatus.expiresIn || this.config.blockDuration) * 1000,
        reason: 'IP blocked due to rate limit violations',
        blocked: true,
      };
    }

    const key = `ws:conn:${normalizedIp}`;
    const result = await this.checkLimit(key, this.config.maxConnectionsPerMinute, 60000);

    if (!result.allowed) {
      await this.recordViolation(normalizedIp);
      return {
        ...result,
        reason: 'Connection rate limit exceeded',
      };
    }

    return result;
  }

  /**
   * Check message rate limit (per connection)
   */
  async checkMessageLimit(
    connectionId: string,
    channel?: WebSocketChannel,
    channelLimit?: number,
  ): Promise<WebSocketRateLimitResult> {
    // Get the limit to use (channel-specific or default)
    const messagesPerMinute = channelLimit || this.config.defaultMessagesPerMinute;

    // Check per-connection limit
    const key = `ws:msg:${connectionId}`;
    const connectionResult = await this.checkLimit(key, messagesPerMinute, 60000);

    if (!connectionResult.allowed) {
      return {
        ...connectionResult,
        reason: 'Message rate limit exceeded for connection',
      };
    }

    // Check burst limit (per 10 seconds)
    const burstKey = `ws:burst:${connectionId}`;
    const burstResult = await this.checkLimit(burstKey, this.config.defaultBurstLimit, 10000);

    if (!burstResult.allowed) {
      return {
        ...burstResult,
        reason: 'Burst limit exceeded - slow down',
      };
    }

    return {
      allowed: true,
      remaining: Math.min(connectionResult.remaining, burstResult.remaining),
      resetAt: Math.min(connectionResult.resetAt, burstResult.resetAt),
    };
  }

  /**
   * Check subscription limit (max channels per connection)
   */
  checkSubscriptionLimit(
    currentSubscriptions: number,
    maxChannels: number = 10,
  ): WebSocketRateLimitResult {
    if (currentSubscriptions >= maxChannels) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: 0,
        reason: `Maximum ${maxChannels} channel subscriptions reached`,
      };
    }

    return {
      allowed: true,
      remaining: maxChannels - currentSubscriptions,
      resetAt: 0,
    };
  }

  /**
   * Core rate limit check using sliding window
   */
  private async checkLimit(
    key: string,
    maxRequests: number,
    windowMs: number,
  ): Promise<WebSocketRateLimitResult> {
    const now = Date.now();
    const windowStart = now - windowMs;

    if (this.isRedisAvailable) {
      try {
        const pipeline = this.redis.pipeline();

        // Remove entries older than the window
        pipeline.zremrangebyscore(key, 0, windowStart);

        // Add current request with unique timestamp
        pipeline.zadd(key, now, `${now}-${Math.random().toString(36).substring(2, 10)}`);

        // Count requests in current window
        pipeline.zcard(key);

        // Set expiration
        pipeline.expire(key, Math.ceil(windowMs / 1000));

        const results = await pipeline.exec();

        if (results) {
          const requestCount = (results[2]?.[1] as number) || 0;
          const remaining = Math.max(0, maxRequests - requestCount);
          const resetAt = now + windowMs;

          return {
            allowed: requestCount <= maxRequests,
            remaining,
            resetAt,
          };
        }
      } catch (error) {
        appLogger.error('Redis error', { module: 'WSRateLimit', error: error instanceof Error ? error.message : String(error) });
      }
    }

    // Fallback to local rate limiting
    return this.checkLocalLimit(key, maxRequests, windowMs);
  }

  /**
   * Local fallback rate limiting
   */
  private checkLocalLimit(
    key: string,
    maxRequests: number,
    windowMs: number,
  ): WebSocketRateLimitResult {
    const now = Date.now();
    const entry = this.localFallback.get(key);

    if (!entry || entry.resetAt < now) {
      // Start new window
      this.localFallback.set(key, { count: 1, resetAt: now + windowMs });
      return {
        allowed: true,
        remaining: maxRequests - 1,
        resetAt: now + windowMs,
      };
    }

    // Increment count
    entry.count++;

    if (entry.count > maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        resetAt: entry.resetAt,
      };
    }

    return {
      allowed: true,
      remaining: maxRequests - entry.count,
      resetAt: entry.resetAt,
    };
  }

  /**
   * Check if an IP is blocked
   */
  async isIpBlocked(ipAddress: string): Promise<{ blocked: boolean; expiresIn?: number }> {
    const normalizedIp = this.normalizeIp(ipAddress);
    const blockKey = `ws:blocked:${normalizedIp}`;

    if (this.isRedisAvailable) {
      try {
        const ttl = await this.redis.ttl(blockKey);
        if (ttl > 0) {
          return { blocked: true, expiresIn: ttl };
        }
        return { blocked: false };
      } catch (error) {
        appLogger.error('Error checking block status', { module: 'WSRateLimit', error: error instanceof Error ? error.message : String(error) });
      }
    }

    return { blocked: false };
  }

  /**
   * Record a rate limit violation
   */
  async recordViolation(ipAddress: string): Promise<void> {
    const normalizedIp = this.normalizeIp(ipAddress);
    const violationKey = `ws:violations:${normalizedIp}`;
    const violationWindowSeconds = 3600; // 1 hour

    if (this.isRedisAvailable) {
      try {
        const pipeline = this.redis.pipeline();
        const now = Date.now();
        const windowStart = now - violationWindowSeconds * 1000;

        // Remove old violations
        pipeline.zremrangebyscore(violationKey, 0, windowStart);

        // Add new violation
        pipeline.zadd(violationKey, now, `${now}-${Math.random().toString(36).substring(2, 8)}`);

        // Count violations
        pipeline.zcard(violationKey);

        // Set expiration
        pipeline.expire(violationKey, violationWindowSeconds);

        const results = await pipeline.exec();

        if (results) {
          const violationCount = (results[2]?.[1] as number) || 0;

          // Block IP if threshold exceeded
          if (violationCount >= this.config.blockThreshold) {
            await this.blockIp(normalizedIp);
          }
        }
      } catch (error) {
        appLogger.error('Error recording violation', { module: 'WSRateLimit', error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Block an IP address
   */
  async blockIp(ipAddress: string, durationSeconds?: number): Promise<void> {
    const normalizedIp = this.normalizeIp(ipAddress);
    const blockKey = `ws:blocked:${normalizedIp}`;
    const duration = durationSeconds || this.config.blockDuration;

    if (this.isRedisAvailable) {
      try {
        await this.redis.setex(blockKey, duration, 'blocked');
        appLogger.warn('IP blocked', { module: 'WSRateLimit', ip: normalizedIp, durationSeconds: duration });
      } catch (error) {
        appLogger.error('Error blocking IP', { module: 'WSRateLimit', error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Unblock an IP address
   */
  async unblockIp(ipAddress: string): Promise<void> {
    const normalizedIp = this.normalizeIp(ipAddress);
    const blockKey = `ws:blocked:${normalizedIp}`;

    if (this.isRedisAvailable) {
      try {
        await this.redis.del(blockKey);
        appLogger.info('IP unblocked', { module: 'WSRateLimit', ip: normalizedIp });
      } catch (error) {
        appLogger.error('Error unblocking IP', { module: 'WSRateLimit', error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Get rate limit statistics
   */
  async getStats(): Promise<{
    blockedIps: number;
    activeConnections: number;
    redisAvailable: boolean;
  }> {
    let blockedIps = 0;

    if (this.isRedisAvailable) {
      try {
        const blockedKeys = await this.redis.keys('ws:blocked:*');
        blockedIps = blockedKeys.length;
      } catch (error) {
        appLogger.error('Error getting stats', { module: 'WSRateLimit', error: error instanceof Error ? error.message : String(error) });
      }
    }

    return {
      blockedIps,
      activeConnections: this.localFallback.size,
      redisAvailable: this.isRedisAvailable,
    };
  }

  /**
   * Normalize IP address
   */
  private normalizeIp(ip: string): string {
    if (!ip) return '0.0.0.0';

    // Handle IPv4-mapped IPv6 addresses
    if (ip.startsWith('::ffff:')) {
      return ip.substring(7);
    }

    return ip;
  }

  /**
   * Clean up expired entries from local fallback
   */
  private cleanupLocalFallback(): void {
    const now = Date.now();

    for (const [key, entry] of Array.from(this.localFallback.entries())) {
      if (entry.resetAt < now) {
        this.localFallback.delete(key);
      }
    }
  }

  /**
   * Close Redis connection
   */
  async close(): Promise<void> {
    await this.redis.quit();
  }
}

/**
 * Singleton instance
 */
let defaultInstance: WebSocketRateLimiter | null = null;

export function getWebSocketRateLimiter(
  config?: Partial<WebSocketRateLimitConfig>,
): WebSocketRateLimiter {
  if (!defaultInstance || config) {
    defaultInstance = new WebSocketRateLimiter(config);
  }
  return defaultInstance;
}
