/**
 * WRFCoin Secure Redis Connection Utility
 * Centralized Redis connection management with security best practices
 */

const Redis = require('ioredis');
const { logger } = require('./logger');

/**
 * Create a secure Redis connection with proper authentication and configuration
 * @param {Object} options - Redis connection options
 * @returns {Object} Redis client instance
 */
function createSecureRedisConnection(options = {}) {
  // If REDIS_URL is set and no explicit host override provided, parse from URL
  if (process.env.REDIS_URL && !options.host) {
    return createRedisFromUrl(process.env.REDIS_URL, options);
  }

  const config = {
    // Use container hostname by default
    host: options.host || process.env.REDIS_HOST || 'redis-cache',
    port: parseInt(options.port || process.env.REDIS_PORT) || 6379,
    db: parseInt(options.db || process.env.REDIS_DB) || 0,

    // Security configuration
    password: options.password || process.env.REDIS_PASSWORD || '',

    // Connection options
    connectTimeout: options.connectTimeout || 10000,
    lazyConnect: options.lazyConnect !== false,
    maxRetriesPerRequest: options.maxRetriesPerRequest || 3,
    retryDelayOnFailover: options.retryDelayOnFailover || 100,
    enableReadyCheck: options.enableReadyCheck !== false,

    // Performance options
    family: options.family || 4,
    keepAlive: options.keepAlive !== false,
    enableOfflineQueue: options.enableOfflineQueue || false,

    // Security enhancements
    showFriendlyErrorStack: process.env.NODE_ENV !== 'production',

    // TLS support (when available)
    ...(process.env.REDIS_TLS === 'true' && {
      tls: {
        rejectUnauthorized: process.env.NODE_ENV === 'production',
      },
    }),

    // Retry policy
    retryPolicy:
      options.retryPolicy ||
      (times => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      }),

    // Override with any custom options
    ...options.customConfig,
  };

  // Validate configuration in production
  if (process.env.NODE_ENV === 'production') {
    if (!config.password) {
      logger.warn('Redis password not configured for production environment', {
        host: config.host,
        port: config.port,
      });
    }
  }

  logger.info('Creating Redis connection', {
    host: config.host,
    port: config.port,
    db: config.db,
    passwordConfigured: !!config.password,
    tlsEnabled: !!config.tls,
  });

  return new Redis(config);
}

/**
 * Create Redis connection from URL with authentication
 * @param {string} url - Redis URL (redis://[password]@host:port/db)
 * @param {Object} options - Additional options
 * @returns {Object} Redis client instance
 */
function createRedisFromUrl(url = process.env.REDIS_URL, options = {}) {
  if (!url) {
    throw new Error('Redis URL is required');
  }

  // Parse URL to extract components
  const urlObj = new URL(url);

  const config = {
    host: urlObj.hostname,
    port: parseInt(urlObj.port) || 6379,
    db: parseInt(urlObj.pathname.slice(1)) || 0,
    password: urlObj.password || process.env.REDIS_PASSWORD || '',
    ...options,
  };

  return createSecureRedisConnection(config);
}

/**
 * Test Redis connection with authentication
 * @param {Object} client - Redis client instance
 * @returns {Promise<Object>} Connection test results
 */
async function testRedisConnection(client) {
  try {
    const startTime = Date.now();

    // Test basic connectivity
    const pingResult = await client.ping();
    const pingTime = Date.now() - startTime;

    // Get server info
    const info = await client.info('server');
    const redisVersion = info.match(/redis_version:(.+)/)?.[1];

    // Test authentication by trying to get server info
    const memoryInfo = await client.info('memory');
    const usedMemory = memoryInfo.match(/used_memory_human:(.+)/)?.[1]?.trim();

    logger.info('Redis connection test successful', {
      ping: pingResult,
      pingTime: `${pingTime}ms`,
      version: redisVersion,
      usedMemory,
    });

    return {
      success: true,
      ping: pingResult,
      pingTime,
      version: redisVersion,
      usedMemory,
    };
  } catch (error) {
    logger.error('Redis connection test failed', {
      error: error.message,
      code: error.code,
    });

    return {
      success: false,
      error: error.message,
      code: error.code,
    };
  }
}

/**
 * Get Redis configuration summary (safe for logging)
 * @param {Object} client - Redis client instance
 * @returns {Object} Safe configuration summary
 */
function getRedisConfigSummary(client) {
  const options = client.options;

  return {
    host: options.host,
    port: options.port,
    db: options.db,
    passwordConfigured: !!options.password,
    tlsEnabled: !!options.tls,
    connectTimeout: options.connectTimeout,
    retryPolicy: !!options.retryPolicy,
  };
}

/**
 * Gracefully close Redis connection
 * @param {Object} client - Redis client instance
 * @param {number} timeout - Timeout in milliseconds
 * @returns {Promise<void>}
 */
async function closeRedisConnection(client, timeout = 5000) {
  if (!client) {
    return;
  }

  try {
    logger.info('Closing Redis connection gracefully');

    // Set a timeout for the close operation
    const closePromise = client.quit();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Redis close timeout')), timeout);
    });

    await Promise.race([closePromise, timeoutPromise]);
    logger.info('Redis connection closed successfully');
  } catch (error) {
    logger.warn('Error during Redis connection close, forcing disconnect', {
      error: error.message,
    });

    // Force disconnect if graceful close fails
    client.disconnect();
  }
}

/**
 * Redis connection pool manager for multiple connections
 */
class RedisConnectionPool {
  constructor() {
    this.connections = new Map();
    this.defaultConfig = {};
  }

  /**
   * Set default configuration for all connections
   * @param {Object} config - Default Redis configuration
   */
  setDefaultConfig(config) {
    this.defaultConfig = { ...config };
  }

  /**
   * Get or create a Redis connection
   * @param {string} name - Connection name
   * @param {Object} config - Connection-specific configuration
   * @returns {Object} Redis client instance
   */
  getConnection(name = 'default', config = {}) {
    if (this.connections.has(name)) {
      return this.connections.get(name);
    }

    const mergedConfig = { ...this.defaultConfig, ...config };
    const client = createSecureRedisConnection(mergedConfig);

    // Add connection tracking
    client.on('connect', () => {
      logger.info(`Redis connection '${name}' established`);
    });

    client.on('error', error => {
      logger.error(`Redis connection '${name}' error`, {
        error: error.message,
      });
    });

    client.on('close', () => {
      logger.info(`Redis connection '${name}' closed`);
      this.connections.delete(name);
    });

    this.connections.set(name, client);
    return client;
  }

  /**
   * Close all connections in the pool
   * @returns {Promise<void>}
   */
  async closeAll() {
    const closePromises = Array.from(this.connections.values()).map(client =>
      closeRedisConnection(client)
    );

    await Promise.allSettled(closePromises);
    this.connections.clear();
    logger.info('All Redis connections closed');
  }

  /**
   * Get connection status summary
   * @returns {Object} Status summary
   */
  getStatus() {
    const connections = Array.from(this.connections.entries()).map(
      ([name, client]) => ({
        name,
        status: client.status,
        config: getRedisConfigSummary(client),
      })
    );

    return {
      totalConnections: this.connections.size,
      connections,
    };
  }
}

// Create default pool instance
const defaultPool = new RedisConnectionPool();

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  logger.info('SIGTERM received, closing all Redis connections');
  await defaultPool.closeAll();
});

process.on('SIGINT', async () => {
  logger.info('SIGINT received, closing all Redis connections');
  await defaultPool.closeAll();
});

module.exports = {
  createSecureRedisConnection,
  createRedisFromUrl,
  testRedisConnection,
  getRedisConfigSummary,
  closeRedisConnection,
  RedisConnectionPool,
  defaultPool,
};
