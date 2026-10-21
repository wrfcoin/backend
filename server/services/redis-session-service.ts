/**
 * Redis Session Service for WRFCoin Platform
 * Task 80: Gap 3 - Redis Session Management
 *
 * Replaces in-memory Map session storage with distributed Redis storage.
 * Features:
 * - Redis-backed session storage for distributed deployments
 * - In-memory fallback for Redis unavailability
 * - TTL matching JWT expiry (1 hour for access tokens)
 * - Session validation, creation, and invalidation
 * - Activity tracking and session cleanup
 */

import Redis from 'ioredis';
import { logger } from '../../utils/logger.js';

// ============================================================================
// Types
// ============================================================================

export interface UserSession {
  userId: string;
  roles: string[];
  permissions: string[];
  sessionId: string;
  createdAt: Date;
  lastActivity: Date;
}

export interface SessionServiceConfig {
  redisUrl: string;
  sessionTTLSeconds: number;
  keyPrefix: string;
  enableInMemoryFallback: boolean;
  cleanupIntervalMs: number;
}

interface SerializedSession {
  userId: string;
  roles: string[];
  permissions: string[];
  sessionId: string;
  createdAt: string;
  lastActivity: string;
}

// ============================================================================
// Configuration
// ============================================================================

const DEFAULT_CONFIG: SessionServiceConfig = {
  redisUrl: process.env.REDIS_URL || 'redis://localhost:6379',
  sessionTTLSeconds: 3600, // 1 hour - matches JWT access token expiry
  keyPrefix: 'session',
  enableInMemoryFallback: true,
  cleanupIntervalMs: 5 * 60 * 1000, // 5 minutes
};

// ============================================================================
// Redis Session Service
// ============================================================================

export class RedisSessionService {
  private redisClient: Redis | null = null;
  private config: SessionServiceConfig;
  private isRedisAvailable: boolean = false;

  // In-memory fallback when Redis is unavailable
  private inMemorySessions: Map<string, UserSession> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor(config?: Partial<SessionServiceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.initializeRedis();
    this.startCleanupInterval();
  }

  // ============================================================================
  // Initialization
  // ============================================================================

  private initializeRedis(): void {
    try {
      this.redisClient = new Redis(this.config.redisUrl, {
        maxRetriesPerRequest: 3,
        enableReadyCheck: true,
        lazyConnect: true,
        retryStrategy: (times) => {
          if (times > 5) {
            logger.error('[RedisSession] Redis connection failed after 5 attempts, using in-memory fallback');
            this.isRedisAvailable = false;
            return null;
          }
          const delay = Math.min(times * 100, 2000);
          logger.warn(`[RedisSession] Redis connection retry #${times}, waiting ${delay}ms`);
          return delay;
        },
      });

      this.redisClient.on('connect', () => {
        logger.info('[RedisSession] Redis client connected');
        this.isRedisAvailable = true;
        // Migrate in-memory sessions to Redis if any exist
        this.migrateInMemoryToRedis();
      });

      this.redisClient.on('error', (error) => {
        logger.error('[RedisSession] Redis client error:', { error: error.message });
        this.isRedisAvailable = false;
      });

      this.redisClient.on('ready', () => {
        logger.info('[RedisSession] Redis client ready');
        this.isRedisAvailable = true;
      });

      this.redisClient.on('close', () => {
        logger.warn('[RedisSession] Redis connection closed');
        this.isRedisAvailable = false;
      });

      // Attempt to connect
      this.redisClient.connect().catch((error) => {
        logger.error('[RedisSession] Redis connection failed:', { error: error.message });
        this.isRedisAvailable = false;
      });
    } catch (error) {
      logger.error('[RedisSession] Failed to initialize Redis:', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.isRedisAvailable = false;
    }
  }

  // ============================================================================
  // Session CRUD Operations
  // ============================================================================

  /**
   * Create a new session
   */
  async createSession(session: UserSession): Promise<boolean> {
    const key = this.getSessionKey(session.sessionId);

    if (this.isRedisAvailable && this.redisClient) {
      try {
        const serialized = this.serializeSession(session);
        await this.redisClient.setex(
          key,
          this.config.sessionTTLSeconds,
          JSON.stringify(serialized)
        );

        // Also add to user's session set for tracking multiple sessions
        const userSessionsKey = this.getUserSessionsKey(session.userId);
        await this.redisClient.sadd(userSessionsKey, session.sessionId);
        await this.redisClient.expire(userSessionsKey, this.config.sessionTTLSeconds * 2);

        logger.debug('[RedisSession] Session created in Redis', {
          sessionId: session.sessionId,
          userId: session.userId,
        });
        return true;
      } catch (error) {
        logger.error('[RedisSession] Failed to create session in Redis:', {
          error: error instanceof Error ? error.message : String(error),
          sessionId: session.sessionId,
        });

        // Fall through to in-memory fallback
        if (this.config.enableInMemoryFallback) {
          return this.createSessionInMemory(session);
        }
        return false;
      }
    }

    // Use in-memory fallback
    if (this.config.enableInMemoryFallback) {
      return this.createSessionInMemory(session);
    }

    return false;
  }

  /**
   * Get a session by ID
   */
  async getSession(sessionId: string): Promise<UserSession | null> {
    const key = this.getSessionKey(sessionId);

    if (this.isRedisAvailable && this.redisClient) {
      try {
        const data = await this.redisClient.get(key);
        if (data) {
          const parsed = JSON.parse(data) as SerializedSession;
          return this.deserializeSession(parsed);
        }
        return null;
      } catch (error) {
        logger.error('[RedisSession] Failed to get session from Redis:', {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });

        // Fall through to in-memory fallback
        if (this.config.enableInMemoryFallback) {
          return this.inMemorySessions.get(sessionId) || null;
        }
        return null;
      }
    }

    // Use in-memory fallback
    if (this.config.enableInMemoryFallback) {
      return this.inMemorySessions.get(sessionId) || null;
    }

    return null;
  }

  /**
   * Authoritative, READ-ONLY session lookup for security-sensitive gates (admin).
   * A single Redis GET: it never renews the TTL (validateSession's GET-then-SETEX can
   * recreate a key an operator deleted in between), and it never falls back to
   * process-local state. Redis unavailable or erroring THROWS, so callers refuse.
   */
  async getSessionRedisOnly(sessionId: string): Promise<UserSession | null> {
    if (!this.isRedisAvailable || !this.redisClient) {
      throw new Error('session store unavailable');
    }
    const data = await this.redisClient.get(this.getSessionKey(sessionId));
    return data ? this.deserializeSession(JSON.parse(data) as SerializedSession) : null;
  }

  /**
   * Validate a session exists and update its activity
   */
  async validateSession(sessionId: string): Promise<UserSession | null> {
    const session = await this.getSession(sessionId);

    if (!session) {
      return null;
    }

    // Update last activity
    await this.updateSessionActivity(sessionId);

    return session;
  }

  /**
   * Update session's last activity timestamp
   */
  async updateSessionActivity(sessionId: string): Promise<boolean> {
    const key = this.getSessionKey(sessionId);

    if (this.isRedisAvailable && this.redisClient) {
      try {
        const data = await this.redisClient.get(key);
        if (!data) return false;

        const session = JSON.parse(data) as SerializedSession;
        session.lastActivity = new Date().toISOString();

        // Update with refreshed TTL
        await this.redisClient.setex(
          key,
          this.config.sessionTTLSeconds,
          JSON.stringify(session)
        );

        return true;
      } catch (error) {
        logger.error('[RedisSession] Failed to update session activity:', {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });

        // Fall through to in-memory
        if (this.config.enableInMemoryFallback) {
          return this.updateSessionActivityInMemory(sessionId);
        }
        return false;
      }
    }

    // Use in-memory fallback
    if (this.config.enableInMemoryFallback) {
      return this.updateSessionActivityInMemory(sessionId);
    }

    return false;
  }

  /**
   * Invalidate (delete) a session
   */
  async invalidateSession(sessionId: string): Promise<boolean> {
    const key = this.getSessionKey(sessionId);

    if (this.isRedisAvailable && this.redisClient) {
      try {
        // Get session to find userId for cleanup
        const data = await this.redisClient.get(key);
        if (data) {
          const session = JSON.parse(data) as SerializedSession;
          const userSessionsKey = this.getUserSessionsKey(session.userId);
          await this.redisClient.srem(userSessionsKey, sessionId);
        }

        await this.redisClient.del(key);
        logger.debug('[RedisSession] Session invalidated', { sessionId });
        return true;
      } catch (error) {
        logger.error('[RedisSession] Failed to invalidate session:', {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });

        // Fall through to in-memory
        if (this.config.enableInMemoryFallback) {
          this.inMemorySessions.delete(sessionId);
          return true;
        }
        return false;
      }
    }

    // Use in-memory fallback
    if (this.config.enableInMemoryFallback) {
      this.inMemorySessions.delete(sessionId);
      return true;
    }

    return false;
  }

  /**
   * Invalidate all sessions for a user
   */
  async invalidateUserSessions(userId: string): Promise<number> {
    const userSessionsKey = this.getUserSessionsKey(userId);

    if (this.isRedisAvailable && this.redisClient) {
      try {
        const sessionIds = await this.redisClient.smembers(userSessionsKey);
        if (sessionIds.length === 0) return 0;

        // Delete all session keys
        const sessionKeys = sessionIds.map((id) => this.getSessionKey(id));
        await this.redisClient.del(...sessionKeys);

        // Delete the user sessions set
        await this.redisClient.del(userSessionsKey);

        logger.info('[RedisSession] All user sessions invalidated', {
          userId,
          count: sessionIds.length,
        });

        return sessionIds.length;
      } catch (error) {
        logger.error('[RedisSession] Failed to invalidate user sessions:', {
          error: error instanceof Error ? error.message : String(error),
          userId,
        });
        return 0;
      }
    }

    // Use in-memory fallback
    if (this.config.enableInMemoryFallback) {
      let count = 0;
      for (const [sessionId, session] of this.inMemorySessions) {
        if (session.userId === userId) {
          this.inMemorySessions.delete(sessionId);
          count++;
        }
      }
      return count;
    }

    return 0;
  }

  /**
   * Get all active sessions for a user
   */
  async getUserSessions(userId: string): Promise<UserSession[]> {
    const userSessionsKey = this.getUserSessionsKey(userId);

    if (this.isRedisAvailable && this.redisClient) {
      try {
        const sessionIds = await this.redisClient.smembers(userSessionsKey);
        const sessions: UserSession[] = [];

        for (const sessionId of sessionIds) {
          const session = await this.getSession(sessionId);
          if (session) {
            sessions.push(session);
          } else {
            // Clean up stale reference
            await this.redisClient.srem(userSessionsKey, sessionId);
          }
        }

        return sessions;
      } catch (error) {
        logger.error('[RedisSession] Failed to get user sessions:', {
          error: error instanceof Error ? error.message : String(error),
          userId,
        });
        return [];
      }
    }

    // Use in-memory fallback
    if (this.config.enableInMemoryFallback) {
      return Array.from(this.inMemorySessions.values()).filter(
        (session) => session.userId === userId
      );
    }

    return [];
  }

  /**
   * Get total active session count
   */
  async getActiveSessionCount(): Promise<number> {
    if (this.isRedisAvailable && this.redisClient) {
      try {
        const keys = await this.redisClient.keys(`${this.config.keyPrefix}:*`);
        // Filter to only count session keys, not user session sets
        return keys.filter((key) => !key.includes(':user:')).length;
      } catch (error) {
        logger.error('[RedisSession] Failed to get session count:', {
          error: error instanceof Error ? error.message : String(error),
        });
        return this.inMemorySessions.size;
      }
    }

    return this.inMemorySessions.size;
  }

  // ============================================================================
  // In-Memory Fallback Operations
  // ============================================================================

  private createSessionInMemory(session: UserSession): boolean {
    this.inMemorySessions.set(session.sessionId, session);
    logger.debug('[RedisSession] Session created in memory (fallback)', {
      sessionId: session.sessionId,
      userId: session.userId,
    });
    return true;
  }

  private updateSessionActivityInMemory(sessionId: string): boolean {
    const session = this.inMemorySessions.get(sessionId);
    if (!session) return false;

    session.lastActivity = new Date();
    this.inMemorySessions.set(sessionId, session);
    return true;
  }

  private async migrateInMemoryToRedis(): Promise<void> {
    if (this.inMemorySessions.size === 0 || !this.isRedisAvailable) return;

    logger.info('[RedisSession] Migrating in-memory sessions to Redis', {
      count: this.inMemorySessions.size,
    });

    for (const [sessionId, session] of this.inMemorySessions) {
      try {
        const key = this.getSessionKey(sessionId);
        const serialized = this.serializeSession(session);

        await this.redisClient!.setex(
          key,
          this.config.sessionTTLSeconds,
          JSON.stringify(serialized)
        );

        const userSessionsKey = this.getUserSessionsKey(session.userId);
        await this.redisClient!.sadd(userSessionsKey, sessionId);

        // Remove from in-memory after successful migration
        this.inMemorySessions.delete(sessionId);
      } catch (error) {
        logger.error('[RedisSession] Failed to migrate session:', {
          error: error instanceof Error ? error.message : String(error),
          sessionId,
        });
      }
    }

    logger.info('[RedisSession] Session migration complete', {
      remainingInMemory: this.inMemorySessions.size,
    });
  }

  // ============================================================================
  // Cleanup Operations
  // ============================================================================

  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(() => {
      this.cleanupExpiredSessions();
    }, this.config.cleanupIntervalMs);
    // #977: the constructor calls this, and the module exports a module-scope
    // singleton (`export const sessionService = new RedisSessionService()`), so
    // merely importing this file starts the timer. Unref'd so session cleanup
    // never holds the process open — it still fires normally while anything else
    // keeps the loop alive.
    this.cleanupInterval.unref();
  }

  /**
   * Clean up expired sessions from in-memory fallback
   */
  async cleanupExpiredSessions(): Promise<void> {
    const now = new Date();
    const sessionTimeout = this.config.sessionTTLSeconds * 1000;

    // Clean in-memory sessions
    let cleanedCount = 0;
    for (const [sessionId, session] of this.inMemorySessions) {
      if (now.getTime() - session.lastActivity.getTime() > sessionTimeout) {
        this.inMemorySessions.delete(sessionId);
        cleanedCount++;
      }
    }

    if (cleanedCount > 0) {
      logger.debug('[RedisSession] Cleaned up expired in-memory sessions', {
        count: cleanedCount,
      });
    }

    // Redis handles TTL automatically, no need to clean there
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private getSessionKey(sessionId: string): string {
    return `${this.config.keyPrefix}:${sessionId}`;
  }

  private getUserSessionsKey(userId: string): string {
    return `${this.config.keyPrefix}:user:${userId}:sessions`;
  }

  private serializeSession(session: UserSession): SerializedSession {
    return {
      userId: session.userId,
      roles: session.roles,
      permissions: session.permissions,
      sessionId: session.sessionId,
      createdAt: session.createdAt.toISOString(),
      lastActivity: session.lastActivity.toISOString(),
    };
  }

  private deserializeSession(data: SerializedSession): UserSession {
    return {
      userId: data.userId,
      roles: data.roles,
      permissions: data.permissions,
      sessionId: data.sessionId,
      createdAt: new Date(data.createdAt),
      lastActivity: new Date(data.lastActivity),
    };
  }

  /**
   * Check if Redis is currently available
   */
  isRedisConnected(): boolean {
    return this.isRedisAvailable;
  }

  /**
   * Get service health status
   */
  getHealthStatus(): {
    redis: boolean;
    inMemorySessionCount: number;
    mode: 'redis' | 'memory';
  } {
    return {
      redis: this.isRedisAvailable,
      inMemorySessionCount: this.inMemorySessions.size,
      mode: this.isRedisAvailable ? 'redis' : 'memory',
    };
  }

  // ============================================================================
  // Shutdown
  // ============================================================================

  /**
   * Gracefully close Redis connection
   */
  async close(): Promise<void> {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    if (this.redisClient) {
      try {
        await this.redisClient.quit();
        this.redisClient = null;
        this.isRedisAvailable = false;
        logger.info('[RedisSession] Redis connection closed');
      } catch (error) {
        logger.error('[RedisSession] Error closing Redis connection:', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.redisClient?.disconnect();
        this.redisClient = null;
        this.isRedisAvailable = false;
      }
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const sessionService = new RedisSessionService();

// Graceful shutdown handlers
process.on('SIGTERM', async () => {
  await sessionService.close();
});

process.on('SIGINT', async () => {
  await sessionService.close();
});

export default sessionService;
