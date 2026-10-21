/**
 * Advanced Memory Optimization System for Wrfcoin Platform
 * Implements intelligent caching, connection pooling, and memory management
 */

const { LRUCache } = require('lru-cache');
const EventEmitter = require('events');
const { appLogger } = require('./logger');

class MemoryOptimizer extends EventEmitter {
  constructor(options = {}) {
    super();

    // Configuration with smart defaults
    this.config = {
      maxCacheSize: options.maxCacheSize || 100 * 1024 * 1024, // 100MB
      maxCacheItems: options.maxCacheItems || 10000,
      gcInterval: options.gcInterval || 30000, // 30 seconds
      compressionEnabled: options.compressionEnabled !== false,
      poolSize: options.poolSize || 20,
      connectionTimeout: options.connectionTimeout || 30000,
      maxIdleTime: options.maxIdleTime || 300000, // 5 minutes
      ...options,
    };

    // Initialize caching layers
    this.initializeCaches();

    // Initialize connection pools
    this.initializeConnectionPools();

    // Initialize memory monitoring
    this.initializeMemoryMonitoring();

    // Start optimization routines
    this.startOptimizationRoutines();
  }

  initializeCaches() {
    // Main application cache with compression
    this.cache = new LRUCache({
      max: this.config.maxCacheItems,
      maxSize: this.config.maxCacheSize,
      sizeCalculation: value => {
        return JSON.stringify(value).length;
      },
      ttl: 1000 * 60 * 15, // 15 minutes default TTL
      allowStale: false,
      updateAgeOnGet: true,
      updateAgeOnHas: false,
    });

    // Specialized caches for different data types
    this.blockCache = new LRUCache({
      max: 1000,
      ttl: 1000 * 60 * 30, // 30 minutes for blocks
    });

    this.transactionCache = new LRUCache({
      max: 5000,
      ttl: 1000 * 60 * 10, // 10 minutes for transactions
    });

    this.userSessionCache = new LRUCache({
      max: 2000,
      ttl: 1000 * 60 * 60, // 1 hour for user sessions
    });

    this.apiResponseCache = new LRUCache({
      max: 3000,
      ttl: 1000 * 60 * 5, // 5 minutes for API responses
    });

    appLogger.info('Memory caches initialized with intelligent layering', { module: 'MemoryOptimizer' });
  }

  initializeConnectionPools() {
    // WebSocket connection pool
    this.wsConnectionPool = {
      active: new Map(),
      idle: new Set(),
      maxConnections: this.config.poolSize,
      currentConnections: 0,

      acquire: () => {
        if (this.wsConnectionPool.idle.size > 0) {
          const connection = Array.from(this.wsConnectionPool.idle)[0];
          this.wsConnectionPool.idle.delete(connection);
          this.wsConnectionPool.active.set(connection.id, connection);
          return connection;
        }
        return null;
      },

      release: connection => {
        this.wsConnectionPool.active.delete(connection.id);
        this.wsConnectionPool.idle.add(connection);

        // Clean up old idle connections
        if (this.wsConnectionPool.idle.size > this.config.poolSize) {
          const oldestConnection = Array.from(this.wsConnectionPool.idle)[0];
          this.wsConnectionPool.idle.delete(oldestConnection);
          this.wsConnectionPool.currentConnections--;
        }
      },
    };

    // Database connection pool simulation
    this.dbConnectionPool = {
      connections: [],
      available: [],
      inUse: [],
      maxSize: this.config.poolSize,

      getConnection: () => {
        if (this.dbConnectionPool.available.length > 0) {
          const conn = this.dbConnectionPool.available.pop();
          this.dbConnectionPool.inUse.push(conn);
          return conn;
        }
        return null;
      },

      releaseConnection: conn => {
        const index = this.dbConnectionPool.inUse.indexOf(conn);
        if (index > -1) {
          this.dbConnectionPool.inUse.splice(index, 1);
          this.dbConnectionPool.available.push(conn);
        }
      },
    };

    appLogger.info('Connection pools initialized for optimal resource usage', { module: 'MemoryOptimizer' });
  }

  initializeMemoryMonitoring() {
    this.memoryStats = {
      heapUsed: 0,
      heapTotal: 0,
      external: 0,
      rss: 0,
      cacheHitRatio: 0,
      activeConnections: 0,
      lastGC: Date.now(),
    };

    // Memory threshold alerts
    this.memoryThresholds = {
      warning: this.config.maxCacheSize * 0.8,
      critical: this.config.maxCacheSize * 0.95,
    };

    appLogger.info('Memory monitoring system active', { module: 'MemoryOptimizer' });
  }

  startOptimizationRoutines() {
    // Garbage collection optimizer
    this.gcInterval = setInterval(() => {
      this.performOptimizedGC();
    }, this.config.gcInterval);
    this.gcInterval.unref();

    // Memory pressure monitoring
    this.memoryMonitorInterval = setInterval(() => {
      this.monitorMemoryPressure();
    }, 5000);
    this.memoryMonitorInterval.unref();

    // Cache cleanup routine
    this.cacheCleanupInterval = setInterval(() => {
      this.performCacheCleanup();
    }, 60000);
    this.cacheCleanupInterval.unref();

    appLogger.info('Memory optimization routines started', { module: 'MemoryOptimizer' });
  }

  // Intelligent caching methods
  set(key, value, options = {}) {
    const cacheKey = this.generateCacheKey(key);
    const compressedValue = this.config.compressionEnabled
      ? this.compress(value)
      : value;

    // Choose appropriate cache based on data type
    const cache = this.selectOptimalCache(key, value);
    cache.set(cacheKey, compressedValue, options.ttl);

    this.emit('cache:set', {
      key: cacheKey,
      size: JSON.stringify(value).length,
    });
    return true;
  }

  get(key) {
    const cacheKey = this.generateCacheKey(key);

    // Try all caches in order of specificity
    const caches = [
      this.blockCache,
      this.transactionCache,
      this.userSessionCache,
      this.apiResponseCache,
      this.cache,
    ];

    for (const cache of caches) {
      const value = cache.get(cacheKey);
      if (value !== undefined) {
        const decompressed = this.config.compressionEnabled
          ? this.decompress(value)
          : value;
        this.emit('cache:hit', { key: cacheKey });
        return decompressed;
      }
    }

    this.emit('cache:miss', { key: cacheKey });
    return undefined;
  }

  selectOptimalCache(key, value) {
    if (key.includes('block_')) return this.blockCache;
    if (key.includes('tx_')) return this.transactionCache;
    if (key.includes('user_') || key.includes('session_'))
      return this.userSessionCache;
    if (key.includes('api_')) return this.apiResponseCache;
    return this.cache;
  }

  generateCacheKey(key) {
    return typeof key === 'string' ? key : JSON.stringify(key);
  }

  compress(data) {
    // Simple compression simulation - in production use zlib
    return Buffer.from(JSON.stringify(data)).toString('base64');
  }

  decompress(data) {
    try {
      return JSON.parse(Buffer.from(data, 'base64').toString());
    } catch (error) {
      return data; // Return as-is if not compressed
    }
  }

  // Memory optimization methods
  performOptimizedGC() {
    const before = process.memoryUsage();

    // Force garbage collection if available
    if (global.gc) {
      global.gc();
    }

    // Clean up expired cache entries
    this.cache.purgeStale();
    this.blockCache.purgeStale();
    this.transactionCache.purgeStale();
    this.userSessionCache.purgeStale();
    this.apiResponseCache.purgeStale();

    const after = process.memoryUsage();
    const freed = Math.max(0, before.heapUsed - after.heapUsed);

    this.memoryStats.lastGC = Date.now();
    this.emit('gc:complete', { freed, before, after });

    if (freed > 0) {
      appLogger.info('Memory optimization completed', { module: 'MemoryOptimizer', freedMB: (freed / 1024 / 1024).toFixed(2) });
    } else {
      appLogger.info('Cache cleanup completed', { module: 'MemoryOptimizer', sizeMB: (this.cache.calculatedSize / 1024 / 1024).toFixed(2) });
    }
  }

  monitorMemoryPressure() {
    const usage = process.memoryUsage();
    this.memoryStats = {
      ...this.memoryStats,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      external: usage.external,
      rss: usage.rss,
      activeConnections: this.wsConnectionPool.currentConnections,
    };

    // Calculate cache hit ratio
    const totalHits = this.cache.calculatedSize || 0;
    this.memoryStats.cacheHitRatio =
      totalHits > 0 ? (this.cache.size / totalHits) * 100 : 0;

    // Check memory thresholds
    if (usage.heapUsed > this.memoryThresholds.critical) {
      this.emit('memory:critical', usage);
      this.performEmergencyCleanup();
    } else if (usage.heapUsed > this.memoryThresholds.warning) {
      this.emit('memory:warning', usage);
      this.performPreventiveCleanup();
    }
  }

  performCacheCleanup() {
    // Clean up least recently used items
    const targetSize = this.config.maxCacheSize * 0.7;

    while (this.cache.calculatedSize > targetSize && this.cache.size > 0) {
      this.cache.delete(this.cache.rLRU);
    }

    appLogger.info('Cache cleanup completed', { module: 'MemoryOptimizer', sizeMB: (this.cache.calculatedSize / 1024 / 1024).toFixed(2) });
  }

  performEmergencyCleanup() {
    appLogger.warn('Emergency memory cleanup initiated', { module: 'MemoryOptimizer' });

    // Aggressive cache clearing
    this.cache.clear();
    this.apiResponseCache.clear();

    // Clean up connection pools
    this.cleanupConnectionPools();

    // Force garbage collection
    this.performOptimizedGC();
  }

  performPreventiveCleanup() {
    appLogger.warn('Preventive memory cleanup initiated', { module: 'MemoryOptimizer' });

    // Clear 50% of least used cache entries
    const targetSize = this.cache.size * 0.5;
    while (this.cache.size > targetSize) {
      this.cache.delete(this.cache.rLRU);
    }
  }

  cleanupConnectionPools() {
    // Clean up idle WebSocket connections
    this.wsConnectionPool.idle.clear();

    // Reset database connection pool
    this.dbConnectionPool.available = [];
    this.dbConnectionPool.inUse = [];
  }

  // Buffer and stream optimization
  optimizeBuffer(buffer, maxSize = 1024 * 1024) {
    if (buffer.length > maxSize) {
      // Split large buffers into chunks
      const chunks = [];
      for (let i = 0; i < buffer.length; i += maxSize) {
        chunks.push(buffer.slice(i, i + maxSize));
      }
      return chunks;
    }
    return buffer;
  }

  // API response optimization
  optimizeApiResponse(data, compressionLevel = 6) {
    if (typeof data !== 'object') return data;

    // Remove null/undefined values
    const cleaned = this.removeEmptyValues(data);

    // Compress if enabled
    if (this.config.compressionEnabled) {
      return this.compress(cleaned);
    }

    return cleaned;
  }

  removeEmptyValues(obj) {
    if (Array.isArray(obj)) {
      return obj
        .map(item => this.removeEmptyValues(item))
        .filter(item => item !== null);
    }

    if (obj && typeof obj === 'object') {
      const cleaned = {};
      for (const [key, value] of Object.entries(obj)) {
        if (value !== null && value !== undefined && value !== '') {
          cleaned[key] = this.removeEmptyValues(value);
        }
      }
      return cleaned;
    }

    return obj;
  }

  // Memory statistics and reporting
  getMemoryStats() {
    const usage = process.memoryUsage();

    return {
      ...this.memoryStats,
      current: usage,
      caches: {
        main: {
          size: this.cache.size,
          calculatedSize: this.cache.calculatedSize || 0,
        },
        blocks: {
          size: this.blockCache.size,
          calculatedSize: this.blockCache.calculatedSize || 0,
        },
        transactions: {
          size: this.transactionCache.size,
          calculatedSize: this.transactionCache.calculatedSize || 0,
        },
        sessions: {
          size: this.userSessionCache.size,
          calculatedSize: this.userSessionCache.calculatedSize || 0,
        },
        apiResponses: {
          size: this.apiResponseCache.size,
          calculatedSize: this.apiResponseCache.calculatedSize || 0,
        },
      },
      connectionPools: {
        websocket: {
          active: this.wsConnectionPool.active.size,
          idle: this.wsConnectionPool.idle.size,
        },
        database: {
          available: this.dbConnectionPool.available.length,
          inUse: this.dbConnectionPool.inUse.length,
        },
      },
    };
  }

  // Cleanup method
  destroy() {
    clearInterval(this.gcInterval);
    clearInterval(this.memoryMonitorInterval);
    clearInterval(this.cacheCleanupInterval);

    this.cache.clear();
    this.blockCache.clear();
    this.transactionCache.clear();
    this.userSessionCache.clear();
    this.apiResponseCache.clear();

    this.cleanupConnectionPools();

    appLogger.info('Memory optimizer destroyed and cleaned up', { module: 'MemoryOptimizer' });
  }
}

// Export singleton instance
const memoryOptimizer = new MemoryOptimizer();

module.exports = {
  MemoryOptimizer,
  memoryOptimizer,
};
