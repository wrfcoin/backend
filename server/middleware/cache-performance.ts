import { createClient, RedisClientType } from 'redis';
import { LRUCache } from 'lru-cache';
import memoizee from 'memoizee';
import rateLimit from 'express-rate-limit';
import compression from 'compression';
import type { Request, Response, NextFunction } from 'express';
import { appLogger } from '../utils/logger.js';

// Performance and caching configuration
interface CacheConfig {
  redis: {
    host: string;
    port: number;
    password?: string;
    ttl: number; // Time to live in seconds
  };
  memory: {
    max: number;
    ttl: number; // Time to live in milliseconds
  };
  rateLimiting: {
    windowMs: number;
    max: number;
  };
}

const DEFAULT_CONFIG: CacheConfig = {
  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
    ttl: 300, // 5 minutes
  },
  memory: {
    max: 1000,
    ttl: 60000, // 1 minute
  },
  rateLimiting: {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // Limit each IP to 1000 requests per windowMs
  },
};

// Performance metrics storage
interface PerformanceMetrics {
  responseTime: number;
  cacheHits: number;
  cacheMisses: number;
  totalRequests: number;
  errorCount: number;
  timestamp: number;
}

class CachePerformanceManager {
  private redisClient: RedisClientType | null = null;
  private memoryCache: LRUCache<string, any>;
  private metrics: PerformanceMetrics;
  private config: CacheConfig;
  private isRedisConnected = false;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };

    // Initialize in-memory cache
    this.memoryCache = new LRUCache({
      max: this.config.memory.max,
      ttl: this.config.memory.ttl,
    });

    // Initialize metrics
    this.metrics = {
      responseTime: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalRequests: 0,
      errorCount: 0,
      timestamp: Date.now(),
    };

    this.initializeRedis();
  }

  private async initializeRedis(): Promise<void> {
    // Skip Redis initialization if explicitly disabled or not available
    if (process.env.DISABLE_REDIS === 'true' || (!process.env.REDIS_URL && !process.env.REDIS_HOST)) {
      appLogger.info('Redis disabled or not configured, using memory cache only', {
        operation: 'cache:redis:init',
      });
      this.isRedisConnected = false;
      return;
    }

    try {
      // Prefer REDIS_URL (set by Docker Compose) over host/port env vars
      this.redisClient = process.env.REDIS_URL
        ? createClient({
            url: process.env.REDIS_URL,
            socket: {
              connectTimeout: 2000,
              reconnectStrategy: false,
            },
          })
        : createClient({
            socket: {
              host: this.config.redis.host,
              port: this.config.redis.port,
              connectTimeout: 2000,
              reconnectStrategy: false, // Disable automatic reconnection
            },
            password: this.config.redis.password,
          });

      this.redisClient.on('error', err => {
        // Only log the first error, then disable Redis
        if (this.isRedisConnected !== false) {
          appLogger.info('Redis unavailable, using memory cache fallback', {
            operation: 'cache:redis:error',
          });
          this.isRedisConnected = false;
        }
      });

      this.redisClient.on('connect', () => {
        appLogger.info('Redis connected successfully', {
          operation: 'cache:redis:connect',
        });
        this.isRedisConnected = true;
      });

      this.redisClient.on('disconnect', () => {
        this.isRedisConnected = false;
      });

      // Single connection attempt with short timeout
      try {
        await Promise.race([
          this.redisClient.connect(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timeout')), 2000)
          ),
        ]);
      } catch (connectError) {
        appLogger.info('Redis not available, using memory cache only', {
          operation: 'cache:redis:connect:failed',
        });
        this.isRedisConnected = false;
        // Clean up the client to prevent further attempts
        if (this.redisClient) {
          try {
            await this.redisClient.disconnect();
          } catch (e) {
            // Ignore cleanup errors
          }
          this.redisClient = null;
        }
      }
    } catch (error) {
      appLogger.info('Using memory cache only (Redis initialization failed)', {
        operation: 'cache:redis:init:failed',
      });
      this.isRedisConnected = false;
      this.redisClient = null;
    }
  }

  // Get data from cache (Redis first, then memory fallback)
  async get(key: string): Promise<any> {
    try {
      // Try Redis first if connected
      if (this.isRedisConnected && this.redisClient) {
        const redisValue = await this.redisClient.get(key);
        if (typeof redisValue === 'string') {
          this.metrics.cacheHits++;
          return JSON.parse(redisValue);
        }
      }

      // Fallback to memory cache
      const memoryValue = this.memoryCache.get(key);
      if (memoryValue !== undefined) {
        this.metrics.cacheHits++;
        return memoryValue;
      }

      this.metrics.cacheMisses++;
      return null;
    } catch (error) {
      appLogger.error('Cache get error', {
        operation: 'cache:get:error',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      this.metrics.cacheMisses++;
      return null;
    }
  }

  // Set data in cache (both Redis and memory)
  async set(key: string, value: any, ttl?: number): Promise<void> {
    try {
      const serializedValue = JSON.stringify(value);
      const cacheTtl = ttl || this.config.redis.ttl;

      // Set in Redis if connected
      if (this.isRedisConnected && this.redisClient) {
        await this.redisClient.setEx(key, cacheTtl, serializedValue);
      }

      // Always set in memory cache as fallback
      this.memoryCache.set(key, value);
    } catch (error) {
      appLogger.error('Cache set error', {
        operation: 'cache:set:error',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
    }
  }

  // Delete from cache
  async delete(key: string): Promise<void> {
    try {
      if (this.isRedisConnected && this.redisClient) {
        await this.redisClient.del(key);
      }
      this.memoryCache.delete(key);
    } catch (error) {
      appLogger.error('Cache delete error', {
        operation: 'cache:delete:error',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
    }
  }

  // Clear all cache
  async clear(): Promise<void> {
    try {
      if (this.isRedisConnected && this.redisClient) {
        await this.redisClient.flushAll();
      }
      this.memoryCache.clear();
    } catch (error) {
      appLogger.error('Cache clear error', {
        operation: 'cache:clear:error',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
    }
  }

  // Generate cache key from request
  generateCacheKey(req: any): string {
    const { method, url, query, body } = req;
    const queryString = new URLSearchParams(query).toString();
    const bodyHash = body ? JSON.stringify(body) : '';
    return `api:${method}:${url}:${queryString}:${Buffer.from(bodyHash).toString('base64')}`;
  }

  // Middleware for caching API responses
  cacheMiddleware(ttl?: number) {
    return async (req: any, res: any, next: NextFunction) => {
      // Only cache GET requests
      if (req.method !== 'GET') {
        return next();
      }

      const cacheKey = this.generateCacheKey(req);

      try {
        // Check cache first
        const cachedResponse = await this.get(cacheKey);
        if (cachedResponse) {
          res.setHeader('X-Cache', 'HIT');
          res.setHeader('X-Cache-Key', cacheKey);
          return res.json(cachedResponse);
        }

        // Store original res.json method
        const originalJson = res.json;

        // Override res.json to cache the response
        res.json = (data: any) => {
          res.setHeader('X-Cache', 'MISS');
          res.setHeader('X-Cache-Key', cacheKey);

          // Cache the response asynchronously
          this.set(cacheKey, data, ttl).catch(err => {
            appLogger.error('Failed to cache response', {
              operation: 'cache:response:error',
              cacheKey,
              error: err instanceof Error ? { name: err.name, message: err.message } : 'Unknown error',
            });
          });

          // Call original json method
          return originalJson.call(res, data);
        };

        next();
      } catch (error) {
        appLogger.error('Cache middleware error', {
          operation: 'cache:middleware:error',
          error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
        });
        next();
      }
    };
  }

  // Performance monitoring middleware
  performanceMiddleware() {
    return (req: any, res: any, next: NextFunction) => {
      const startTime = Date.now();
      this.metrics.totalRequests++;

      // Override res.end to capture response time
      const originalEnd = res.end;
      res.end = (...args: any[]) => {
        const responseTime = Date.now() - startTime;
        this.metrics.responseTime =
          (this.metrics.responseTime + responseTime) / 2; // Moving average

        // Add performance headers
        res.setHeader('X-Response-Time', `${responseTime}ms`);
        res.setHeader('X-Cache-Status', res.getHeader('X-Cache') || 'NO-CACHE');

        return originalEnd.apply(res, args);
      };

      next();
    };
  }

  // Rate limiting middleware
  rateLimitMiddleware() {
    return rateLimit({
      windowMs: this.config.rateLimiting.windowMs,
      max: this.config.rateLimiting.max,
      message: {
        error: 'Too many requests from this IP, please try again later.',
        retryAfter: this.config.rateLimiting.windowMs / 1000,
      },
      standardHeaders: true,
      legacyHeaders: false,
    });
  }

  // Compression middleware
  compressionMiddleware() {
    return compression({
      threshold: 1024, // Only compress responses > 1KB
      level: 6, // Compression level (1-9, 6 is good balance)
      filter: (req: any, res: any) => {
        // Don't compress if the request includes a 'x-no-compression' header
        if (req.headers['x-no-compression']) {
          return false;
        }
        // Use compression filter function
        return compression.filter(req, res);
      },
    });
  }

  // Get performance metrics
  getMetrics(): PerformanceMetrics & { cacheInfo: any } {
    return {
      ...this.metrics,
      cacheInfo: {
        memoryCache: {
          size: this.memoryCache.size,
          maxSize: this.memoryCache.max,
          hitRate:
            this.metrics.cacheHits /
            (this.metrics.cacheHits + this.metrics.cacheMisses),
        },
        redis: {
          connected: this.isRedisConnected,
        },
      },
    };
  }

  // Memoize function for expensive operations
  memoize<T extends (...args: any[]) => any>(
    fn: T,
    options?: { maxAge?: number; max?: number }
  ): T {
    return memoizee(fn, {
      maxAge: options?.maxAge || 60000, // 1 minute default
      max: options?.max || 100, // Max 100 cached results
      promise: true, // Support promises
    });
  }

  // Health check endpoint data
  getHealthStatus() {
    const redis = this.isRedisConnected;
    // Memory LRU is always available — a full cache still works (evicts on insert).
    // Checking size < max would report "down" when the cache is merely at capacity.
    const memory = true;
    const totalRequests = this.metrics.totalRequests;
    // healthy = both layers up; degraded = memory-only (redis optional L2 absent).
    const status = redis ? 'healthy' : 'degraded';
    return {
      status,
      cache: {
        redis,
        memory,
      },
      performance: {
        avgResponseTime: this.metrics.responseTime,
        totalRequests,
        // 0/0 = NaN (→ null in JSON); report 0 until traffic flows.
        errorRate: totalRequests > 0 ? this.metrics.errorCount / totalRequests : 0,
      },
      uptime: Date.now() - this.metrics.timestamp,
    };
  }

  // Cleanup resources
  async close(): Promise<void> {
    try {
      if (this.redisClient && this.isRedisConnected) {
        await this.redisClient.quit();
      }
      this.memoryCache.clear();
    } catch (error) {
      appLogger.error('Error closing cache manager', {
        operation: 'cache:close:error',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
    }
  }
}

// Export singleton instance
export const cacheManager = new CachePerformanceManager();

// Export types and default config
export {
  CachePerformanceManager,
  CacheConfig,
  PerformanceMetrics,
  DEFAULT_CONFIG,
};
