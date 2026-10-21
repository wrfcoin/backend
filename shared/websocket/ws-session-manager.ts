/**
 * WebSocket Session Manager
 * Task 74: Redis-based session tracking for WebSocket connections
 *
 * Tracks active connections, supports token refresh without disconnection,
 * and enables user session invalidation.
 */

import type { Redis as RedisClient } from 'ioredis';
import {
  WebSocketSession,
  WebSocketSessionConfig,
  DEFAULT_SESSION_CONFIG,
  AuthenticatedWebSocket,
  WebSocketChannel,
  UserRole,
} from './types.js';
import { appLogger } from '../../server/utils/logger.js';
import { createRedisClient } from '../../server/utils/create-redis.js';

/**
 * Reconnection backoff ceiling. The delay grows linearly to this value and
 * then stays there — it never stops. See `retryStrategy` below for why a
 * terminal "give up" value is not an option here.
 */
export const WS_REDIS_MAX_RECONNECT_DELAY_MS = 3000;

/**
 * Attempt number at which the outage is escalated from debug noise to a single
 * warning. Purely a logging threshold: it does not affect reconnection, which
 * continues regardless.
 */
export const WS_REDIS_WARN_AFTER_ATTEMPTS = 5;

/**
 * WebSocket Session Manager
 * Manages WebSocket sessions in Redis for tracking, token refresh, and invalidation
 */
export class WebSocketSessionManager {
  private redis: RedisClient;
  private config: WebSocketSessionConfig;
  private isRedisAvailable: boolean = true;

  constructor(config: Partial<WebSocketSessionConfig> = {}) {
    this.config = { ...DEFAULT_SESSION_CONFIG, ...config };

    // Initialize Redis connection (REDIS_URL-aware via shared factory)
    const REDIS_DB = parseInt(process.env.REDIS_DB || '0', 10);
    this.redis = createRedisClient({
      // Session and invalidation state is security-critical.
      failureMode: 'fail-closed',
      db: REDIS_DB,
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      extra: {
        // NEVER return null here.
        //
        // `null` tells ioredis to stop reconnecting *permanently*. Combined
        // with availability being restored only by a later connection event,
        // that made a transient blip terminal: retries stopped, so no
        // connection event could ever fire, so `isRedisAvailable` stayed false
        // and every session operation threw until the process was redeployed.
        // A 30-second hiccup took WebSocket sessions down for good
        // (#929 review, blocker 1).
        //
        // Capping the backoff keeps reconnection running forever at a bounded
        // interval, so recovery is automatic once Redis returns. Commands
        // issued during the outage still fail fast — that is `maxRetriesPerRequest`
        // above, and it is deliberately unchanged: this fixes recovery without
        // reintroducing the hangs the PR set out to remove.
        retryStrategy: (times: number) => {
          const delay = Math.min(times * 100, WS_REDIS_MAX_RECONNECT_DELAY_MS);
          if (times === WS_REDIS_WARN_AFTER_ATTEMPTS) {
            appLogger.warn(
              'Redis unreachable; WebSocket session operations fail closed until it returns. Reconnection continues.',
              { module: 'WSSession', attempts: times, retryDelayMs: delay },
            );
          }
          return delay;
        },
      },
    }) as unknown as RedisClient;

    // Handle Redis events
    this.redis.on('connect', () => {
      // Socket is up, but with enableReadyCheck the client cannot serve
      // commands yet. Availability flips on 'ready' below, not here.
      appLogger.info('Redis connected', { module: 'WSSession' });
    });

    this.redis.on('ready', () => {
      appLogger.info('Redis ready; WebSocket session operations resumed', { module: 'WSSession' });
      this.isRedisAvailable = true;
    });

    this.redis.on('error', (err: Error) => {
      appLogger.error('Redis error', { module: 'WSSession', error: err.message });
      this.isRedisAvailable = false;
    });

    this.redis.on('close', () => {
      appLogger.warn('Redis connection closed', { module: 'WSSession' });
      this.isRedisAvailable = false;
    });
  }

  /**
   * Connect to Redis
   */
  async connect(): Promise<void> {
    try {
      await this.redis.connect();
    } catch (error) {
      appLogger.warn('Redis connection failed; refusing WebSocket session operations', { module: 'WSSession' });
      this.isRedisAvailable = false;
      throw error;
    }
  }

  private requireRedis(): void {
    if (!this.isRedisAvailable) {
      throw new Error('WebSocket session store unavailable');
    }
  }

  /**
   * Create a new WebSocket session
   */
  async createSession(ws: AuthenticatedWebSocket, userAgent: string): Promise<void> {
    const session: WebSocketSession = {
      connectionId: ws.connectionId,
      userId: ws.user.id,
      address: ws.user.address,
      role: ws.user.role,
      permissions: ws.user.permissions,
      ipAddress: ws.ipAddress,
      userAgent,
      connectedAt: ws.connectedAt,
      lastActivity: ws.lastActivity,
      subscribedChannels: Array.from(ws.subscribedChannels),
      messageCount: ws.messageCount,
      tokenExpiry: ws.tokenExpiry,
    };

    this.requireRedis();
    try {
      const pipeline = this.redis.pipeline();

      // Store session data
      pipeline.setex(
        `${this.config.sessionPrefix}${ws.connectionId}`,
        this.config.sessionTtl,
        JSON.stringify(session),
      );

      // Add to user's connection set
      pipeline.sadd(`${this.config.userConnectionsPrefix}${ws.user.id}`, ws.connectionId);
      pipeline.expire(
        `${this.config.userConnectionsPrefix}${ws.user.id}`,
        this.config.sessionTtl,
      );

      await pipeline.exec();
    } catch (error) {
      appLogger.error('Failed to create session in Redis', { module: 'WSSession', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Update session activity timestamp
   */
  async updateActivity(connectionId: string): Promise<void> {
    const now = Date.now();
    this.requireRedis();
    try {
      const key = `${this.config.sessionPrefix}${connectionId}`;
      const sessionData = await this.redis.get(key);

      if (sessionData) {
        const session: WebSocketSession = JSON.parse(sessionData);
        session.lastActivity = now;
        session.messageCount++;

        await this.redis.setex(key, this.config.sessionTtl, JSON.stringify(session));
      }
    } catch (error) {
      appLogger.error('Failed to update activity', { module: 'WSSession', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Update subscribed channels for a session
   */
  async updateChannels(connectionId: string, channels: WebSocketChannel[]): Promise<void> {
    this.requireRedis();
    try {
      const key = `${this.config.sessionPrefix}${connectionId}`;
      const sessionData = await this.redis.get(key);

      if (sessionData) {
        const session: WebSocketSession = JSON.parse(sessionData);
        session.subscribedChannels = channels;
        session.lastActivity = Date.now();

        await this.redis.setex(key, this.config.sessionTtl, JSON.stringify(session));
      }
    } catch (error) {
      appLogger.error('Failed to update channels', { module: 'WSSession', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Get session by connection ID
   */
  async getSession(connectionId: string): Promise<WebSocketSession | null> {
    this.requireRedis();
    try {
      const sessionData = await this.redis.get(`${this.config.sessionPrefix}${connectionId}`);
      return sessionData ? JSON.parse(sessionData) : null;
    } catch (error) {
      appLogger.error('Failed to get session', { module: 'WSSession', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Get all connections for a user
   */
  async getUserConnections(userId: string): Promise<string[]> {
    this.requireRedis();
    try {
      return await this.redis.smembers(`${this.config.userConnectionsPrefix}${userId}`);
    } catch (error) {
      appLogger.error('Failed to get user connections', { module: 'WSSession', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Remove session (on disconnect)
   */
  async removeSession(connectionId: string, userId: string): Promise<void> {
    this.requireRedis();
    try {
      const pipeline = this.redis.pipeline();

      pipeline.del(`${this.config.sessionPrefix}${connectionId}`);
      pipeline.srem(`${this.config.userConnectionsPrefix}${userId}`, connectionId);

      await pipeline.exec();
    } catch (error) {
      appLogger.error('Failed to remove session', { module: 'WSSession', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Handle token refresh - update all user's sessions with new expiry
   * Returns connection IDs for notification
   */
  async handleTokenRefresh(userId: string, newExpiry: number): Promise<string[]> {
    const connections = await this.getUserConnections(userId);

    this.requireRedis();
    try {
      const pipeline = this.redis.pipeline();

      for (const connectionId of connections) {
        const key = `${this.config.sessionPrefix}${connectionId}`;
        const sessionData = await this.redis.get(key);

        if (sessionData) {
          const session: WebSocketSession = JSON.parse(sessionData);
          session.tokenExpiry = newExpiry;
          session.lastActivity = Date.now();

          pipeline.setex(key, this.config.sessionTtl, JSON.stringify(session));
        }
      }

      await pipeline.exec();
    } catch (error) {
      appLogger.error('Failed to handle token refresh', { module: 'WSSession', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    return connections;
  }

  /**
   * Invalidate all sessions for a user (on logout/revoke)
   * Returns connection IDs for disconnection
   */
  async invalidateUserSessions(userId: string): Promise<string[]> {
    const connections = await this.getUserConnections(userId);

    this.requireRedis();
    try {
      const pipeline = this.redis.pipeline();

      for (const connectionId of connections) {
        pipeline.del(`${this.config.sessionPrefix}${connectionId}`);
      }
      pipeline.del(`${this.config.userConnectionsPrefix}${userId}`);

      await pipeline.exec();
    } catch (error) {
      appLogger.error('Failed to invalidate user sessions', { module: 'WSSession', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    return connections;
  }

  /**
   * Get total active connection count (for metrics)
   */
  async getActiveConnectionCount(): Promise<number> {
    this.requireRedis();
    try {
      const keys = await this.redis.keys(`${this.config.sessionPrefix}*`);
      return keys.length;
    } catch (error) {
      appLogger.error('Failed to get connection count', { module: 'WSSession', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Get sessions by role (for metrics/admin)
   */
  async getSessionsByRole(): Promise<Record<UserRole, number>> {
    const counts: Record<UserRole, number> = {
      guest: 0,
      user: 0,
      operator: 0,
      admin: 0,
      super_admin: 0,
    };

    this.requireRedis();
    try {
      const keys = await this.redis.keys(`${this.config.sessionPrefix}*`);
      const pipeline = this.redis.pipeline();

      for (const key of keys) {
        pipeline.get(key);
      }

      const results = await pipeline.exec();

      if (results) {
        for (const [, result] of results) {
          if (result) {
            const session: WebSocketSession = JSON.parse(result as string);
            if (session.role in counts) {
              counts[session.role]++;
            }
          }
        }
      }
    } catch (error) {
      appLogger.error('Failed to get sessions by role', { module: 'WSSession', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    return counts;
  }

  /**
   * Clean up expired sessions (for maintenance)
   */
  async cleanupExpiredSessions(): Promise<number> {
    // Redis sessions are cleaned automatically by TTL
    return 0;
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
let defaultInstance: WebSocketSessionManager | null = null;

export function getWebSocketSessionManager(
  config?: Partial<WebSocketSessionConfig>,
): WebSocketSessionManager {
  if (!defaultInstance || config) {
    defaultInstance = new WebSocketSessionManager(config);
  }
  return defaultInstance;
}
