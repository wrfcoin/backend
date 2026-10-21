import { logger } from '../utils/logger.js';

interface RateLimitWindow {
  count: number;
  resetTime: number;
}

interface RateLimitConfig {
  maxMessages: number;
  windowMs: number;
}

export class WebSocketRateLimiter {
  // SECURITY: Shared across all connections so multiple connections from the
  // same user/IP share the same rate limit budget. Previously each connection
  // had its own Map, allowing 10 connections * 100 msgs = 1000 msgs/min per user.
  private static sharedWindows: Map<string, RateLimitWindow> = new Map();
  private static cleanupStarted = false;
  private readonly userId: string;
  private readonly globalLimit: RateLimitConfig = {
    maxMessages: 100, // 100 messages per minute globally per user (across ALL connections)
    windowMs: 60000,
  };

  constructor(userId: string) {
    this.userId = userId;

    // Start shared cleanup once
    if (!WebSocketRateLimiter.cleanupStarted) {
      WebSocketRateLimiter.cleanupStarted = true;
      setInterval(
        () => {
          WebSocketRateLimiter.sharedCleanup();
        },
        5 * 60 * 1000
      );
    }
  }

  checkLimit(messageType: string = 'default'): boolean {
    const now = Date.now();

    // Check global rate limit
    if (!this.checkTypeLimit('global', this.globalLimit, now)) {
      logger.warn('[Rate Limiter] Global rate limit exceeded', {
        userId: this.userId,
        type: 'global',
      });
      return false;
    }

    // Check type-specific rate limit
    const typeConfig = this.getConfigForType(messageType);
    if (!this.checkTypeLimit(messageType, typeConfig, now)) {
      logger.warn('[Rate Limiter] Type-specific rate limit exceeded', {
        userId: this.userId,
        type: messageType,
        limit: typeConfig.maxMessages,
        window: typeConfig.windowMs,
      });
      return false;
    }

    return true;
  }

  private checkTypeLimit(
    type: string,
    config: RateLimitConfig,
    now: number
  ): boolean {
    const windowKey = `${this.userId}:${type}`;
    const window = WebSocketRateLimiter.sharedWindows.get(windowKey);

    if (!window || now >= window.resetTime) {
      // Create new window
      WebSocketRateLimiter.sharedWindows.set(windowKey, {
        count: 1,
        resetTime: now + config.windowMs,
      });
      return true;
    }

    if (window.count >= config.maxMessages) {
      return false; // Rate limit exceeded
    }

    // Increment counter
    window.count++;
    return true;
  }

  private getConfigForType(messageType: string): RateLimitConfig {
    const configs: Record<string, RateLimitConfig> = {
      subscribe: { maxMessages: 10, windowMs: 60000 },
      unsubscribe: { maxMessages: 10, windowMs: 60000 },
      wallet_update: { maxMessages: 30, windowMs: 60000 },
      transaction_status: { maxMessages: 50, windowMs: 60000 },
      bridge_operation: { maxMessages: 10, windowMs: 60000 },
      mining_operation: { maxMessages: 20, windowMs: 60000 },
      governance: { maxMessages: 5, windowMs: 60000 },
      ping: { maxMessages: 60, windowMs: 60000 },
      default: { maxMessages: 20, windowMs: 60000 },
    };

    return configs[messageType] || configs.default;
  }

  private static sharedCleanup(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    WebSocketRateLimiter.sharedWindows.forEach((window, key) => {
      if (now >= window.resetTime) {
        keysToDelete.push(key);
      }
    });

    keysToDelete.forEach(key => {
      WebSocketRateLimiter.sharedWindows.delete(key);
    });

    if (keysToDelete.length > 0) {
      logger.debug('[Rate Limiter] Cleaned up expired windows', {
        cleanedCount: keysToDelete.length,
      });
    }
  }

  // Get current usage stats for monitoring
  getUsageStats(): Array<{
    type: string;
    count: number;
    limit: number;
    resetTime: number;
  }> {
    const stats: Array<{
      type: string;
      count: number;
      limit: number;
      resetTime: number;
    }> = [];

    WebSocketRateLimiter.sharedWindows.forEach((window, key) => {
      if (!key.startsWith(`${this.userId}:`)) return;
      const [, type] = key.split(':');
      const config = this.getConfigForType(type);

      stats.push({
        type,
        count: window.count,
        limit: config.maxMessages,
        resetTime: window.resetTime,
      });
    });

    return stats;
  }

  // Reset limits for a specific type (admin function)
  resetTypeLimit(messageType: string): void {
    const windowKey = `${this.userId}:${messageType}`;
    WebSocketRateLimiter.sharedWindows.delete(windowKey);

    logger.info('[Rate Limiter] Reset type limit', {
      userId: this.userId,
      type: messageType,
    });
  }

  // Reset all limits for this user (admin function)
  resetAllLimits(): void {
    const keysToDelete = Array.from(WebSocketRateLimiter.sharedWindows.keys()).filter(key =>
      key.startsWith(`${this.userId}:`)
    );

    keysToDelete.forEach(key => {
      WebSocketRateLimiter.sharedWindows.delete(key);
    });

    logger.info('[Rate Limiter] Reset all limits', {
      userId: this.userId,
      resetCount: keysToDelete.length,
    });
  }
}

// Global rate limiter for tracking across all users
export class GlobalWebSocketRateLimiter {
  private static instance: GlobalWebSocketRateLimiter;
  private connectionCounts: Map<string, number> = new Map(); // IP -> connection count
  private readonly maxConnectionsPerIP = 10;

  static getInstance(): GlobalWebSocketRateLimiter {
    if (!GlobalWebSocketRateLimiter.instance) {
      GlobalWebSocketRateLimiter.instance = new GlobalWebSocketRateLimiter();
    }
    return GlobalWebSocketRateLimiter.instance;
  }

  private constructor() {
    // Clean up old connections every minute
    setInterval(() => {
      this.cleanup();
    }, 60000);
  }

  checkConnectionLimit(ip: string): boolean {
    const currentCount = this.connectionCounts.get(ip) || 0;

    if (currentCount >= this.maxConnectionsPerIP) {
      logger.warn('[Global Rate Limiter] Connection limit exceeded for IP', {
        ip,
        currentCount,
        maxConnections: this.maxConnectionsPerIP,
      });
      return false;
    }

    return true;
  }

  addConnection(ip: string): void {
    const currentCount = this.connectionCounts.get(ip) || 0;
    this.connectionCounts.set(ip, currentCount + 1);

    logger.debug('[Global Rate Limiter] Connection added', {
      ip,
      connectionCount: currentCount + 1,
    });
  }

  removeConnection(ip: string): void {
    const currentCount = this.connectionCounts.get(ip) || 0;
    if (currentCount > 0) {
      this.connectionCounts.set(ip, currentCount - 1);

      logger.debug('[Global Rate Limiter] Connection removed', {
        ip,
        connectionCount: currentCount - 1,
      });
    }
  }

  private cleanup(): void {
    // Remove IPs with 0 connections
    const keysToDelete: string[] = [];

    this.connectionCounts.forEach((count, ip) => {
      if (count === 0) {
        keysToDelete.push(ip);
      }
    });

    keysToDelete.forEach(ip => {
      this.connectionCounts.delete(ip);
    });
  }

  getConnectionStats(): Array<{ ip: string; connections: number }> {
    const stats: Array<{ ip: string; connections: number }> = [];

    this.connectionCounts.forEach((count, ip) => {
      if (count > 0) {
        stats.push({ ip, connections: count });
      }
    });

    return stats.sort((a, b) => b.connections - a.connections);
  }
}
