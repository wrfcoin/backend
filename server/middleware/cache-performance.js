/**
 * Cache Performance Manager
 * High-performance caching layer with Redis backend and memory fallback
 */

const Redis = require('redis');
const createLogger = require('../utils/logger');

const LOG_PREFIX = 'cache:performance';
const logger = createLogger(LOG_PREFIX);

/**
 * High-performance cache manager with Redis primary and memory fallback
 */
class CachePerformanceManager {
  constructor(options = {}) {
    this.options = {
      redisUrl:
        options.redisUrl || process.env.REDIS_URL || 'redis://redis-cache:6379',
      fallbackToMemory: options.fallbackToMemory !== false,
      maxMemoryItems: options.maxMemoryItems || 1000,
      defaultTtl: options.defaultTtl || 3600,
      keyPrefix: options.keyPrefix || 'wrfcoin:cache:',
      ...options,
    };

    this.redisClient = null;
    this.memoryCache = new Map();
    this.memoryTtl = new Map();
    this.isRedisConnected = false;
    this.metrics = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      errors: 0,
      redisOperations: 0,
      memoryOperations: 0,
    };

    this.initializeRedis();
    this.startMemoryCleanup();
  }

  /**
   * Initialize Redis connection with fallback handling
   */
  async initializeRedis() {
    try {
      this.redisClient = Redis.createClient({
        url: this.options.redisUrl,
        password: process.env.REDIS_PASSWORD || '',
        retry_strategy: options => {
          if (options.error && options.error.code === 'ECONNREFUSED') {
            logger.warn(
              `${LOG_PREFIX} Redis connection refused, using memory fallback`
            );
            return false; // Don't retry on connection refused
          }
          if (options.total_retry_time > 1000 * 60 * 60) {
            return new Error('Retry time exhausted');
          }
          if (options.attempt > 10) {
            return undefined;
          }
          return Math.min(options.attempt * 100, 3000);
        },
      });

      this.redisClient.on('connect', () => {
        logger.info(`${LOG_PREFIX} Redis connected successfully`);
        this.isRedisConnected = true;
      });

      this.redisClient.on('error', err => {
        logger.warn(`${LOG_PREFIX} Redis error: ${err.message}`);
        this.isRedisConnected = false;
        this.metrics.errors++;
      });

      this.redisClient.on('end', () => {
        logger.warn(`${LOG_PREFIX} Redis connection ended`);
        this.isRedisConnected = false;
      });

      await this.redisClient.connect();
    } catch (error) {
      logger.warn(`${LOG_PREFIX} Failed to connect to Redis: ${error.message}`);
      this.isRedisConnected = false;
      if (!this.options.fallbackToMemory) {
        throw error;
      }
      logger.info(`${LOG_PREFIX} Using memory cache as fallback`);
    }
  }

  /**
   * Start memory cleanup interval to remove expired items
   */
  startMemoryCleanup() {
    // #977 ratchet: handle stored and unref'd - was discarded, so unclearable.
    const importTimeTimer1 = setInterval(() => {
      this.cleanupMemoryCache();
    }, 60000); // Cleanup every minute
    importTimeTimer1.unref();
  }

  /**
   * Clean up expired items from memory cache
   */
  cleanupMemoryCache() {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, expireTime] of this.memoryTtl.entries()) {
      if (expireTime <= now) {
        this.memoryCache.delete(key);
        this.memoryTtl.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      logger.debug(
        `${LOG_PREFIX} Cleaned ${cleaned} expired items from memory cache`
      );
    }

    // Enforce max memory items limit
    if (this.memoryCache.size > this.options.maxMemoryItems) {
      const excess = this.memoryCache.size - this.options.maxMemoryItems;
      const keysToRemove = Array.from(this.memoryCache.keys()).slice(0, excess);

      keysToRemove.forEach(key => {
        this.memoryCache.delete(key);
        this.memoryTtl.delete(key);
      });

      logger.debug(
        `${LOG_PREFIX} Removed ${excess} items to enforce memory limit`
      );
    }
  }

  /**
   * Generate cache key with prefix
   */
  generateKey(key) {
    return `${this.options.keyPrefix}${key}`;
  }

  /**
   * Set value in cache
   * @param {string} key Cache key
   * @param {any} value Value to cache
   * @param {number} ttl Time to live in seconds
   * @returns {Promise<boolean>} Success status
   */
  async set(key, value, ttl = null) {
    const cacheKey = this.generateKey(key);
    const ttlSeconds = ttl || this.options.defaultTtl;

    try {
      // Try Redis first
      if (this.isRedisConnected && this.redisClient) {
        try {
          const serializedValue = JSON.stringify(value);
          await this.redisClient.setEx(cacheKey, ttlSeconds, serializedValue);
          this.metrics.sets++;
          this.metrics.redisOperations++;
          logger.debug(`${LOG_PREFIX} Set key in Redis: ${cacheKey}`);
          return true;
        } catch (redisError) {
          logger.warn(`${LOG_PREFIX} Redis set failed: ${redisError.message}`);
          this.isRedisConnected = false;
        }
      }

      // Fallback to memory cache
      if (this.options.fallbackToMemory) {
        this.memoryCache.set(cacheKey, value);
        this.memoryTtl.set(cacheKey, Date.now() + ttlSeconds * 1000);
        this.metrics.sets++;
        this.metrics.memoryOperations++;
        logger.debug(`${LOG_PREFIX} Set key in memory: ${cacheKey}`);
        return true;
      }

      return false;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to set cache key: ${cacheKey}`, error);
      this.metrics.errors++;
      return false;
    }
  }

  /**
   * Get value from cache
   * @param {string} key Cache key
   * @returns {Promise<any>} Cached value or null
   */
  async get(key) {
    const cacheKey = this.generateKey(key);

    try {
      // Try Redis first
      if (this.isRedisConnected && this.redisClient) {
        try {
          const value = await this.redisClient.get(cacheKey);
          if (value !== null) {
            this.metrics.hits++;
            this.metrics.redisOperations++;
            logger.debug(`${LOG_PREFIX} Cache hit in Redis: ${cacheKey}`);
            return JSON.parse(value);
          }
        } catch (redisError) {
          logger.warn(`${LOG_PREFIX} Redis get failed: ${redisError.message}`);
          this.isRedisConnected = false;
        }
      }

      // Try memory cache
      if (this.options.fallbackToMemory && this.memoryCache.has(cacheKey)) {
        const expireTime = this.memoryTtl.get(cacheKey);
        if (expireTime && expireTime > Date.now()) {
          const value = this.memoryCache.get(cacheKey);
          this.metrics.hits++;
          this.metrics.memoryOperations++;
          logger.debug(`${LOG_PREFIX} Cache hit in memory: ${cacheKey}`);
          return value;
        } else {
          // Expired, remove from memory
          this.memoryCache.delete(cacheKey);
          this.memoryTtl.delete(cacheKey);
        }
      }

      // Cache miss
      this.metrics.misses++;
      logger.debug(`${LOG_PREFIX} Cache miss: ${cacheKey}`);
      return null;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to get cache key: ${cacheKey}`, error);
      this.metrics.errors++;
      return null;
    }
  }

  /**
   * Delete key from cache
   * @param {string} key Cache key
   * @returns {Promise<boolean>} Success status
   */
  async delete(key) {
    const cacheKey = this.generateKey(key);

    try {
      let success = false;

      // Delete from Redis
      if (this.isRedisConnected && this.redisClient) {
        try {
          await this.redisClient.del(cacheKey);
          this.metrics.deletes++;
          this.metrics.redisOperations++;
          success = true;
        } catch (redisError) {
          logger.warn(
            `${LOG_PREFIX} Redis delete failed: ${redisError.message}`
          );
          this.isRedisConnected = false;
        }
      }

      // Delete from memory
      if (this.options.fallbackToMemory) {
        if (this.memoryCache.has(cacheKey)) {
          this.memoryCache.delete(cacheKey);
          this.memoryTtl.delete(cacheKey);
          this.metrics.deletes++;
          this.metrics.memoryOperations++;
          success = true;
        }
      }

      if (success) {
        logger.debug(`${LOG_PREFIX} Deleted key: ${cacheKey}`);
      }

      return success;
    } catch (error) {
      logger.error(
        `${LOG_PREFIX} Failed to delete cache key: ${cacheKey}`,
        error
      );
      this.metrics.errors++;
      return false;
    }
  }

  /**
   * Clear all cache entries
   * @returns {Promise<boolean>} Success status
   */
  async clear() {
    try {
      let success = false;

      // Clear Redis
      if (this.isRedisConnected && this.redisClient) {
        try {
          // Get all keys with our prefix and delete them
          const keys = await this.redisClient.keys(
            `${this.options.keyPrefix}*`
          );
          if (keys.length > 0) {
            await this.redisClient.del(keys);
          }
          this.metrics.redisOperations++;
          success = true;
        } catch (redisError) {
          logger.warn(
            `${LOG_PREFIX} Redis clear failed: ${redisError.message}`
          );
          this.isRedisConnected = false;
        }
      }

      // Clear memory
      if (this.options.fallbackToMemory) {
        this.memoryCache.clear();
        this.memoryTtl.clear();
        this.metrics.memoryOperations++;
        success = true;
      }

      if (success) {
        logger.info(`${LOG_PREFIX} Cache cleared successfully`);
      }

      return success;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to clear cache`, error);
      this.metrics.errors++;
      return false;
    }
  }

  /**
   * Get cache metrics
   * @returns {Object} Cache performance metrics
   */
  getMetrics() {
    const hitRate =
      this.metrics.hits + this.metrics.misses > 0
        ? (
            (this.metrics.hits / (this.metrics.hits + this.metrics.misses)) *
            100
          ).toFixed(2)
        : 0;

    return {
      ...this.metrics,
      hitRate: `${hitRate}%`,
      memorySize: this.memoryCache.size,
      isRedisConnected: this.isRedisConnected,
      cacheMode: this.isRedisConnected ? 'redis' : 'memory',
    };
  }

  /**
   * Check if key exists in cache
   * @param {string} key Cache key
   * @returns {Promise<boolean>} Key existence status
   */
  async exists(key) {
    const cacheKey = this.generateKey(key);

    try {
      // Check Redis first
      if (this.isRedisConnected && this.redisClient) {
        try {
          const exists = await this.redisClient.exists(cacheKey);
          this.metrics.redisOperations++;
          if (exists) {
            return true;
          }
        } catch (redisError) {
          logger.warn(
            `${LOG_PREFIX} Redis exists check failed: ${redisError.message}`
          );
          this.isRedisConnected = false;
        }
      }

      // Check memory cache
      if (this.options.fallbackToMemory && this.memoryCache.has(cacheKey)) {
        const expireTime = this.memoryTtl.get(cacheKey);
        if (expireTime && expireTime > Date.now()) {
          this.metrics.memoryOperations++;
          return true;
        } else {
          // Expired, remove from memory
          this.memoryCache.delete(cacheKey);
          this.memoryTtl.delete(cacheKey);
        }
      }

      return false;
    } catch (error) {
      logger.error(
        `${LOG_PREFIX} Failed to check key existence: ${cacheKey}`,
        error
      );
      this.metrics.errors++;
      return false;
    }
  }

  /**
   * Get TTL for a key
   * @param {string} key Cache key
   * @returns {Promise<number>} TTL in seconds (-1 if no TTL, -2 if key doesn't exist)
   */
  async ttl(key) {
    const cacheKey = this.generateKey(key);

    try {
      // Check Redis first
      if (this.isRedisConnected && this.redisClient) {
        try {
          const ttl = await this.redisClient.ttl(cacheKey);
          this.metrics.redisOperations++;
          return ttl;
        } catch (redisError) {
          logger.warn(
            `${LOG_PREFIX} Redis TTL check failed: ${redisError.message}`
          );
          this.isRedisConnected = false;
        }
      }

      // Check memory cache
      if (this.options.fallbackToMemory && this.memoryCache.has(cacheKey)) {
        const expireTime = this.memoryTtl.get(cacheKey);
        if (expireTime) {
          const remaining = Math.max(
            0,
            Math.floor((expireTime - Date.now()) / 1000)
          );
          this.metrics.memoryOperations++;
          return remaining;
        }
      }

      return -2; // Key doesn't exist
    } catch (error) {
      logger.error(
        `${LOG_PREFIX} Failed to get TTL for key: ${cacheKey}`,
        error
      );
      this.metrics.errors++;
      return -2;
    }
  }

  /**
   * Close connections and cleanup
   */
  async close() {
    try {
      if (this.redisClient) {
        await this.redisClient.quit();
        logger.info(`${LOG_PREFIX} Redis connection closed`);
      }

      this.memoryCache.clear();
      this.memoryTtl.clear();

      logger.info(`${LOG_PREFIX} Cache manager closed successfully`);
    } catch (error) {
      logger.error(
        `${LOG_PREFIX} Error closing cache manager: ${error.message}`
      );
    }
  }
}

// Create and export singleton instance
const cacheManager = new CachePerformanceManager();

module.exports = {
  CachePerformanceManager,
  cacheManager,
};
