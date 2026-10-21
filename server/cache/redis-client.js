/**
 * WRFCoin Redis Cache Client with Data Flow Validation
 * Comprehensive caching solution with validation, monitoring, and performance optimization
 */

const Redis = require('ioredis');
const { logger } = require('../utils/logger');
const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');
const EventEmitter = require('events');

const gzipAsync = promisify(zlib.gzip);
const gunzipAsync = promisify(zlib.gunzip);

// Cache configuration with enhanced security
// If REDIS_URL is set (Docker Compose), it takes priority over host/port
const CACHE_CONFIG = {
  ...(process.env.REDIS_URL ? {} : {
    host: process.env.REDIS_HOST || 'redis-cache',
    port: parseInt(process.env.REDIS_PORT, 10) || 6379,
  }),
  password: process.env.REDIS_PASSWORD || '',
  db: parseInt(process.env.REDIS_DB, 10) || 0,

  // Connection options
  connectTimeout: 10000,
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  enableReadyCheck: true,

  // Pool configuration
  family: 4,
  keepAlive: true,

  // Security enhancements
  enableOfflineQueue: false,
  showFriendlyErrorStack: process.env.NODE_ENV !== 'production',

  // TLS support (when available)
  ...(process.env.REDIS_TLS === 'true' && {
    tls: {
      rejectUnauthorized: process.env.NODE_ENV === 'production',
    },
  }),

  // Connection validation
  retryPolicy: times => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
};

// Cache policies and validation rules
const CACHE_POLICIES = {
  // Weather data caching policy
  weatherData: {
    ttl: 300, // 5 minutes
    compression: true,
    maxSize: 10 * 1024, // 10KB
    validation: {
      required: ['stationId', 'timestamp', 'temperature'],
      types: {
        stationId: 'string',
        timestamp: 'number',
        temperature: 'number',
      },
    },
  },

  // User session caching
  userSession: {
    ttl: 3600, // 1 hour
    compression: false,
    maxSize: 5 * 1024, // 5KB
    validation: {
      required: ['userId', 'address', 'createdAt'],
      types: {
        userId: 'string',
        address: 'string',
        createdAt: 'number',
      },
    },
  },

  // GraphQL query results
  graphqlQuery: {
    ttl: 600, // 10 minutes
    compression: true,
    maxSize: 50 * 1024, // 50KB
    validation: {
      required: ['data'],
      types: {
        data: 'object',
      },
    },
  },

  // Cross-chain transaction status
  crossChainTx: {
    ttl: 1800, // 30 minutes
    compression: false,
    maxSize: 2 * 1024, // 2KB
    validation: {
      required: ['txHash', 'sourceChain', 'destinationChain', 'status'],
      types: {
        txHash: 'string',
        sourceChain: 'string',
        destinationChain: 'string',
        status: 'string',
      },
    },
  },

  // Computational NFT results
  computeResults: {
    ttl: 7200, // 2 hours
    compression: true,
    maxSize: 100 * 1024, // 100KB
    validation: {
      required: ['jobId', 'status', 'result'],
      types: {
        jobId: 'string',
        status: 'string',
        result: 'object',
      },
    },
  },

  // Default policy
  default: {
    ttl: 3600, // 1 hour
    compression: false,
    maxSize: 10 * 1024, // 10KB
    validation: {},
  },
};

class RedisCacheClient extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.isConnected = false;
    this.connectionAttempts = 0;
    this.maxRetryAttempts = 5;

    // Metrics
    this.getCount = 0;
    this.setCount = 0;
    this.hitCount = 0;
    this.missCount = 0;
    this.errorCount = 0;
    this.validationCount = 0;
    this.compressionSaved = 0;
    this.startTime = Date.now();

    // Cache operation history
    this.operationHistory = [];
    this.maxHistorySize = 1000;

    this.initializeClient();
  }

  async initializeClient() {
    try {
      // Validate Redis configuration
      if (!CACHE_CONFIG.password && process.env.NODE_ENV === 'production') {
        logger.warn('Redis password not configured for production environment');
      }

      logger.info('Initializing Redis cache client', {
        host: CACHE_CONFIG.host,
        port: CACHE_CONFIG.port,
        db: CACHE_CONFIG.db,
        passwordConfigured: !!CACHE_CONFIG.password,
        tlsEnabled: !!CACHE_CONFIG.tls,
      });

      this.client = process.env.REDIS_URL
        ? new Redis(process.env.REDIS_URL, CACHE_CONFIG)
        : new Redis(CACHE_CONFIG);

      // Event handlers
      this.client.on('connect', () => {
        logger.info('Redis client connected');
        this.isConnected = true;
        this.connectionAttempts = 0;
        this.emit('connected');
      });

      this.client.on('ready', () => {
        logger.info('Redis client ready');
        this.emit('ready');
      });

      this.client.on('error', error => {
        this.errorCount++;
        logger.error('Redis client error', {
          error: error.message,
          errorCount: this.errorCount,
        });
        this.emit('error', error);
      });

      this.client.on('close', () => {
        logger.warn('Redis client connection closed');
        this.isConnected = false;
        this.emit('disconnected');
      });

      this.client.on('reconnecting', delay => {
        this.connectionAttempts++;
        logger.info('Redis client reconnecting', {
          delay,
          attempt: this.connectionAttempts,
        });
      });

      // Test connection
      await this.testConnection();
    } catch (error) {
      this.connectionAttempts++;
      logger.error('Failed to initialize Redis client', {
        error: error.message,
        attempt: this.connectionAttempts,
      });

      if (this.connectionAttempts < this.maxRetryAttempts) {
        setTimeout(() => this.initializeClient(), 5000);
      } else {
        logger.error('Max Redis connection attempts reached');
        this.emit('connectionFailed', error);
        throw error;
      }
    }
  }

  async testConnection() {
    if (!this.client) {
      throw new Error('Redis client not initialized');
    }

    const pingResult = await this.client.ping();
    const info = await this.client.info('server');

    logger.info('Redis connection test successful', {
      ping: pingResult,
      version: info.match(/redis_version:(.+)/)?.[1],
    });
  }

  /**
   * Get value from cache with validation
   */
  async get(key, policyName = 'default') {
    const operation = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'GET',
      key,
      policyName,
      success: false,
      hit: false,
      metrics: {},
    };

    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const startTime = Date.now();
      this.getCount++;

      // Get value from Redis
      const rawValue = await this.client.get(key);
      operation.metrics.retrievalTime = Date.now() - startTime;

      if (rawValue === null) {
        this.missCount++;
        operation.hit = false;
        operation.success = true;
        this.addToHistory(operation);
        return null;
      }

      this.hitCount++;
      operation.hit = true;

      // Parse and validate cached data
      const policy = CACHE_POLICIES[policyName] || CACHE_POLICIES.default;
      let parsedValue;

      try {
        // Handle compression
        if (policy.compression && rawValue.startsWith('gz:')) {
          const compressedData = Buffer.from(rawValue.substring(3), 'base64');
          const decompressed = await gunzipAsync(compressedData);
          parsedValue = JSON.parse(decompressed.toString());
          operation.metrics.decompressed = true;
        } else {
          parsedValue = JSON.parse(rawValue);
        }

        // Validate cached data structure
        const validation = this.validateCacheData(parsedValue, policy);
        operation.validation = validation;
        this.validationCount++;

        if (!validation.valid) {
          logger.warn('Invalid cached data found, removing from cache', {
            key,
            errors: validation.errors,
          });
          await this.del(key);
          this.missCount++;
          this.hitCount--;
          operation.hit = false;
          operation.success = false;
          operation.error = 'Invalid cached data';
          this.addToHistory(operation);
          return null;
        }

        operation.success = true;
        operation.metrics.dataSize = rawValue.length;
        this.addToHistory(operation);

        logger.debug('Cache hit', {
          key,
          dataSize: rawValue.length,
          retrievalTime: operation.metrics.retrievalTime,
        });

        return parsedValue;
      } catch (parseError) {
        logger.error('Failed to parse cached data', {
          key,
          error: parseError.message,
        });

        // Remove corrupted data
        await this.del(key);
        this.missCount++;
        this.hitCount--;
        operation.hit = false;
        operation.success = false;
        operation.error = 'Parse error';
        this.addToHistory(operation);
        return null;
      }
    } catch (error) {
      this.errorCount++;
      operation.success = false;
      operation.error = error.message;
      operation.metrics.retrievalTime = Date.now() - operation.timestamp;

      logger.error('Cache get operation failed', {
        key,
        error: error.message,
      });

      this.addToHistory(operation);

      // Return null on cache errors to allow fallback to database
      return null;
    }
  }

  /**
   * Set value in cache with validation and compression
   */
  async set(key, value, ttl = null, policyName = 'default') {
    const operation = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'SET',
      key,
      policyName,
      success: false,
      metrics: {},
    };

    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const startTime = Date.now();
      this.setCount++;

      const policy = CACHE_POLICIES[policyName] || CACHE_POLICIES.default;
      const finalTtl = ttl || policy.ttl;

      // Validate data before caching
      const validation = this.validateCacheData(value, policy);
      operation.validation = validation;
      this.validationCount++;

      if (!validation.valid && policy.validation.required?.length > 0) {
        throw new Error(
          `Cache data validation failed: ${validation.errors.join(', ')}`
        );
      }

      // Serialize data
      let serializedValue = JSON.stringify(value);
      const originalSize = serializedValue.length;
      operation.metrics.originalSize = originalSize;

      // Check size limits
      if (policy.maxSize && originalSize > policy.maxSize) {
        logger.warn('Cache data exceeds size limit', {
          key,
          size: originalSize,
          limit: policy.maxSize,
        });

        if (!policy.allowOversized) {
          throw new Error(
            `Data size ${originalSize} exceeds limit ${policy.maxSize}`
          );
        }
      }

      // Apply compression if enabled
      if (policy.compression && originalSize > 1000) {
        // Only compress if > 1KB
        try {
          const compressed = await gzipAsync(Buffer.from(serializedValue));
          const compressedValue = 'gz:' + compressed.toString('base64');

          if (compressedValue.length < originalSize) {
            serializedValue = compressedValue;
            const savedBytes = originalSize - compressedValue.length;
            this.compressionSaved += savedBytes;
            operation.metrics.compressed = true;
            operation.metrics.compressionRatio = (
              (savedBytes / originalSize) *
              100
            ).toFixed(2);
          }
        } catch (compressionError) {
          logger.warn('Compression failed, storing uncompressed', {
            key,
            error: compressionError.message,
          });
        }
      }

      operation.metrics.finalSize = serializedValue.length;

      // Store in Redis
      if (finalTtl > 0) {
        await this.client.setex(key, finalTtl, serializedValue);
      } else {
        await this.client.set(key, serializedValue);
      }

      operation.success = true;
      operation.metrics.storageTime = Date.now() - startTime;
      this.addToHistory(operation);

      logger.debug('Cache set successful', {
        key,
        size: serializedValue.length,
        ttl: finalTtl,
        compressed: operation.metrics.compressed || false,
      });

      return true;
    } catch (error) {
      this.errorCount++;
      operation.success = false;
      operation.error = error.message;
      operation.metrics.storageTime = Date.now() - operation.timestamp;

      logger.error('Cache set operation failed', {
        key,
        error: error.message,
      });

      this.addToHistory(operation);
      throw error;
    }
  }

  /**
   * Delete key from cache
   */
  async del(key) {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const result = await this.client.del(key);

      logger.debug('Cache delete', {
        key,
        deleted: result === 1,
      });

      return result === 1;
    } catch (error) {
      this.errorCount++;
      logger.error('Cache delete operation failed', {
        key,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Check if key exists in cache
   */
  async exists(key) {
    try {
      if (!this.isConnected) {
        return false;
      }

      const result = await this.client.exists(key);
      return result === 1;
    } catch (error) {
      logger.error('Cache exists check failed', {
        key,
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Get cache expiration time
   */
  async ttl(key) {
    try {
      if (!this.isConnected) {
        return -1;
      }

      return await this.client.ttl(key);
    } catch (error) {
      logger.error('Cache TTL check failed', {
        key,
        error: error.message,
      });
      return -1;
    }
  }

  /**
   * Multi-get operation with validation
   */
  async mget(keys, policyName = 'default') {
    try {
      if (!this.isConnected || keys.length === 0) {
        return [];
      }

      const rawValues = await this.client.mget(...keys);
      const results = [];

      for (let i = 0; i < keys.length; i++) {
        if (rawValues[i] !== null) {
          try {
            const policy = CACHE_POLICIES[policyName] || CACHE_POLICIES.default;
            let parsedValue;

            // Handle compression
            if (policy.compression && rawValues[i].startsWith('gz:')) {
              const compressedData = Buffer.from(
                rawValues[i].substring(3),
                'base64'
              );
              const decompressed = await gunzipAsync(compressedData);
              parsedValue = JSON.parse(decompressed.toString());
            } else {
              parsedValue = JSON.parse(rawValues[i]);
            }

            // Validate data
            const validation = this.validateCacheData(parsedValue, policy);
            if (validation.valid) {
              results.push(parsedValue);
              this.hitCount++;
            } else {
              results.push(null);
              this.missCount++;
              // Remove invalid data
              await this.del(keys[i]);
            }
          } catch (parseError) {
            results.push(null);
            this.missCount++;
            await this.del(keys[i]);
          }
        } else {
          results.push(null);
          this.missCount++;
        }
      }

      this.getCount += keys.length;
      return results;
    } catch (error) {
      this.errorCount++;
      logger.error('Cache mget operation failed', {
        keyCount: keys.length,
        error: error.message,
      });
      return new Array(keys.length).fill(null);
    }
  }

  /**
   * Clear cache with pattern matching
   */
  async clear(pattern = '*') {
    try {
      if (!this.isConnected) {
        throw new Error('Redis client not connected');
      }

      const keys = await this.client.keys(pattern);
      if (keys.length > 0) {
        const result = await this.client.del(...keys);
        logger.info('Cache cleared', {
          pattern,
          keysRemoved: result,
        });
        return result;
      }
      return 0;
    } catch (error) {
      this.errorCount++;
      logger.error('Cache clear operation failed', {
        pattern,
        error: error.message,
      });
      throw error;
    }
  }

  /**
   * Get cache statistics
   */
  async getStatistics() {
    const uptime = Date.now() - this.startTime;
    const hitRate =
      this.getCount > 0
        ? ((this.hitCount / this.getCount) * 100).toFixed(2)
        : '0.00';

    let redisInfo = {};
    try {
      if (this.isConnected) {
        const info = await this.client.info('memory');
        const memory = info.match(/used_memory_human:(.+)/)?.[1]?.trim();
        const peak = info.match(/used_memory_peak_human:(.+)/)?.[1]?.trim();
        redisInfo = { usedMemory: memory, peakMemory: peak };
      }
    } catch (error) {
      logger.warn('Could not retrieve Redis memory info', {
        error: error.message,
      });
    }

    return {
      connected: this.isConnected,
      uptime,
      operations: {
        getCount: this.getCount,
        setCount: this.setCount,
        hitCount: this.hitCount,
        missCount: this.missCount,
        errorCount: this.errorCount,
        validationCount: this.validationCount,
      },
      performance: {
        hitRate: `${hitRate}%`,
        averageGetsPerMinute: (this.getCount / (uptime / 60000)).toFixed(2),
        averageSetsPerMinute: (this.setCount / (uptime / 60000)).toFixed(2),
      },
      compression: {
        bytesSaved: this.compressionSaved,
        compressionRatio:
          this.compressionSaved > 0
            ? (
                (this.compressionSaved / (this.compressionSaved + 1000000)) *
                100
              ).toFixed(2)
            : '0.00',
      },
      redis: redisInfo,
      historySize: this.operationHistory.length,
    };
  }

  /**
   * Get recent operation history
   */
  getOperationHistory(limit = 50) {
    return this.operationHistory.slice(-limit).reverse();
  }

  /**
   * Graceful shutdown
   */
  async close() {
    if (this.client) {
      logger.info('Closing Redis client connection');
      await this.client.quit();
      this.isConnected = false;
      this.emit('closed');
      logger.info('Redis client connection closed');
    }
  }

  // Private helper methods
  validateCacheData(data, policy) {
    const validation = {
      valid: true,
      errors: [],
      warnings: [],
    };

    if (!policy.validation) {
      return validation;
    }

    // Check required fields
    if (policy.validation.required) {
      for (const field of policy.validation.required) {
        if (data[field] === undefined || data[field] === null) {
          validation.valid = false;
          validation.errors.push(`Required field '${field}' is missing`);
        }
      }
    }

    // Check field types
    if (policy.validation.types) {
      for (const [field, expectedType] of Object.entries(
        policy.validation.types
      )) {
        if (data[field] !== undefined) {
          const actualType = typeof data[field];
          if (actualType !== expectedType) {
            validation.valid = false;
            validation.errors.push(
              `Field '${field}' expected type ${expectedType}, got ${actualType}`
            );
          }
        }
      }
    }

    return validation;
  }

  addToHistory(operation) {
    this.operationHistory.push({
      id: operation.id,
      timestamp: operation.timestamp,
      type: operation.type,
      key: operation.key,
      success: operation.success,
      hit: operation.hit,
      metrics: operation.metrics,
      error: operation.error,
    });

    // Maintain history size limit
    if (this.operationHistory.length > this.maxHistorySize) {
      this.operationHistory.splice(
        0,
        this.operationHistory.length - this.maxHistorySize
      );
    }
  }
}

// Export singleton instance
const cacheClient = new RedisCacheClient();

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing Redis client');
  await cacheClient.close();
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing Redis client');
  await cacheClient.close();
});

module.exports = {
  cacheClient,
  RedisCacheClient,
  CACHE_POLICIES,
  CACHE_CONFIG,
};
