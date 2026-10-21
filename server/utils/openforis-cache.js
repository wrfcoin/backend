/**
 * OpenForis-specific caching layer with Redis backend
 * Implements intelligent caching strategies for different OpenForis data types
 */

// Initialize Redis client for OpenForis caching
const Redis = require('ioredis');
const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: process.env.REDIS_PORT || 6379,
  retryDelayOnFailover: 100,
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

// Fallback to in-memory cache if Redis is not available
const memoryCache = new Map();
let useRedis = true;

// Test Redis connection
redis.ping().catch(() => {
  console.warn('Redis not available, falling back to memory cache');
  useRedis = false;
});

const cacheManager = {
  async get(key) {
    if (useRedis) {
      try {
        const value = await redis.get(key);
        return value ? JSON.parse(value) : null;
      } catch (error) {
        console.warn('Redis get error, falling back to memory:', error.message);
        return memoryCache.get(key) || null;
      }
    }
    return memoryCache.get(key) || null;
  },

  async set(key, value, ttl = 300) {
    if (useRedis) {
      try {
        await redis.setex(key, ttl, JSON.stringify(value));
      } catch (error) {
        console.warn('Redis set error, falling back to memory:', error.message);
        memoryCache.set(key, value);
        setTimeout(() => memoryCache.delete(key), ttl * 1000);
      }
    } else {
      memoryCache.set(key, value);
      setTimeout(() => memoryCache.delete(key), ttl * 1000);
    }
  },

  async del(key) {
    if (useRedis) {
      try {
        await redis.del(key);
      } catch (error) {
        console.warn('Redis del error:', error.message);
      }
    }
    memoryCache.delete(key);
  },
};
const createLogger = require('./logger');

const LOG_PREFIX = 'openforis:cache';
const logger = createLogger(LOG_PREFIX);

// Cache TTL configurations for different data types (in seconds)
const CACHE_TTL = {
  PROJECT: 3600, // 1 hour - projects change infrequently
  PLOT: 1800, // 30 minutes - plot data updates moderately
  TIME_SERIES: 900, // 15 minutes - time series data is more dynamic
  CLIMATE_DATA: 7200, // 2 hours - climate projections are stable
  LIST_OPERATIONS: 300, // 5 minutes - list operations for freshness
  SEARCH_RESULTS: 600, // 10 minutes - search results
  STATISTICS: 120, // 2 minutes - statistics and counters
};

// Cache key prefixes for different data types
const KEY_PREFIXES = {
  PROJECT: 'openforis:project',
  PLOT: 'openforis:plot',
  TIME_SERIES: 'openforis:timeseries',
  CLIMATE_DATA: 'openforis:climate',
  PROJECT_PLOTS: 'openforis:project:plots',
  PLOT_TIMESERIES: 'openforis:plot:timeseries',
  REGION_CLIMATE: 'openforis:region:climate',
  SEARCH: 'openforis:search',
  STATS: 'openforis:stats',
};

/**
 * OpenForis Cache Manager
 * Provides specialized caching for OpenForis data with intelligent invalidation
 */
class OpenForisCacheManager {
  constructor() {
    this.cache = cacheManager;
    this.cacheStats = {
      hits: 0,
      misses: 0,
      invalidations: 0,
      errors: 0,
    };

    // Cache warming queue
    this.warmingQueue = [];
    this.isWarming = false;

    logger.info(`${LOG_PREFIX} OpenForis cache manager initialized`);
  }

  /**
   * Generate cache key for a given data type and identifier
   * @param {string} type Data type (PROJECT, PLOT, etc.)
   * @param {string} id Primary identifier
   * @param {Object} params Additional parameters for the key
   * @returns {string} Cache key
   */
  generateKey(type, id, params = {}) {
    const prefix = KEY_PREFIXES[type];
    if (!prefix) {
      throw new Error(`Unknown cache type: ${type}`);
    }

    let key = `${prefix}:${id}`;

    // Add additional parameters to the key if provided
    if (Object.keys(params).length > 0) {
      const paramString = Object.keys(params)
        .sort()
        .map(k => `${k}:${params[k]}`)
        .join(':');
      key += `:${paramString}`;
    }

    return key;
  }

  /**
   * Cache a project
   * @param {string} projectId Project ID
   * @param {Object} projectData Project data
   * @returns {Promise<void>}
   */
  async cacheProject(projectId, projectData) {
    try {
      const key = this.generateKey('PROJECT', projectId);
      await this.cache.set(key, projectData, CACHE_TTL.PROJECT);

      logger.debug(`${LOG_PREFIX} Cached project`, { projectId, key });
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to cache project`, {
        projectId,
        error: error.message,
      });
    }
  }

  /**
   * Get cached project
   * @param {string} projectId Project ID
   * @returns {Promise<Object|null>} Cached project data or null
   */
  async getProject(projectId) {
    try {
      const key = this.generateKey('PROJECT', projectId);
      const data = await this.cache.get(key);

      if (data) {
        this.cacheStats.hits++;
        logger.debug(`${LOG_PREFIX} Cache hit for project`, { projectId, key });
      } else {
        this.cacheStats.misses++;
        logger.debug(`${LOG_PREFIX} Cache miss for project`, {
          projectId,
          key,
        });
      }

      return data;
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to get cached project`, {
        projectId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Cache a plot
   * @param {string} plotId Plot ID
   * @param {Object} plotData Plot data
   * @returns {Promise<void>}
   */
  async cachePlot(plotId, plotData) {
    try {
      const key = this.generateKey('PLOT', plotId);
      await this.cache.set(key, plotData, CACHE_TTL.PLOT);

      // Also cache in project plots index if projectId is available
      if (plotData.projectId) {
        await this.addToProjectPlots(plotData.projectId, plotId);
      }

      logger.debug(`${LOG_PREFIX} Cached plot`, { plotId, key });
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to cache plot`, {
        plotId,
        error: error.message,
      });
    }
  }

  /**
   * Get cached plot
   * @param {string} plotId Plot ID
   * @returns {Promise<Object|null>} Cached plot data or null
   */
  async getPlot(plotId) {
    try {
      const key = this.generateKey('PLOT', plotId);
      const data = await this.cache.get(key);

      if (data) {
        this.cacheStats.hits++;
        logger.debug(`${LOG_PREFIX} Cache hit for plot`, { plotId, key });
      } else {
        this.cacheStats.misses++;
        logger.debug(`${LOG_PREFIX} Cache miss for plot`, { plotId, key });
      }

      return data;
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to get cached plot`, {
        plotId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Cache time series data
   * @param {string} timeSeriesId Time series ID
   * @param {Object} timeSeriesData Time series data
   * @returns {Promise<void>}
   */
  async cacheTimeSeries(timeSeriesId, timeSeriesData) {
    try {
      const key = this.generateKey('TIME_SERIES', timeSeriesId);
      await this.cache.set(key, timeSeriesData, CACHE_TTL.TIME_SERIES);

      // Also cache in plot time series index if plotId is available
      if (timeSeriesData.plotId) {
        await this.addToPlotTimeSeries(timeSeriesData.plotId, timeSeriesId);
      }

      logger.debug(`${LOG_PREFIX} Cached time series`, { timeSeriesId, key });
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to cache time series`, {
        timeSeriesId,
        error: error.message,
      });
    }
  }

  /**
   * Get cached time series
   * @param {string} timeSeriesId Time series ID
   * @returns {Promise<Object|null>} Cached time series data or null
   */
  async getTimeSeries(timeSeriesId) {
    try {
      const key = this.generateKey('TIME_SERIES', timeSeriesId);
      const data = await this.cache.get(key);

      if (data) {
        this.cacheStats.hits++;
        logger.debug(`${LOG_PREFIX} Cache hit for time series`, {
          timeSeriesId,
          key,
        });
      } else {
        this.cacheStats.misses++;
        logger.debug(`${LOG_PREFIX} Cache miss for time series`, {
          timeSeriesId,
          key,
        });
      }

      return data;
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to get cached time series`, {
        timeSeriesId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Cache climate data
   * @param {string} region Region name
   * @param {string} scenario Climate scenario
   * @param {Object} climateData Climate data
   * @returns {Promise<void>}
   */
  async cacheClimateData(region, scenario, climateData) {
    try {
      const key = this.generateKey('CLIMATE_DATA', `${region}:${scenario}`);
      await this.cache.set(key, climateData, CACHE_TTL.CLIMATE_DATA);

      logger.debug(`${LOG_PREFIX} Cached climate data`, {
        region,
        scenario,
        key,
      });
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to cache climate data`, {
        region,
        scenario,
        error: error.message,
      });
    }
  }

  /**
   * Get cached climate data
   * @param {string} region Region name
   * @param {string} scenario Climate scenario
   * @returns {Promise<Object|null>} Cached climate data or null
   */
  async getClimateData(region, scenario) {
    try {
      const key = this.generateKey('CLIMATE_DATA', `${region}:${scenario}`);
      const data = await this.cache.get(key);

      if (data) {
        this.cacheStats.hits++;
        logger.debug(`${LOG_PREFIX} Cache hit for climate data`, {
          region,
          scenario,
          key,
        });
      } else {
        this.cacheStats.misses++;
        logger.debug(`${LOG_PREFIX} Cache miss for climate data`, {
          region,
          scenario,
          key,
        });
      }

      return data;
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to get cached climate data`, {
        region,
        scenario,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Cache project plots list
   * @param {string} projectId Project ID
   * @param {Array} plotIds Array of plot IDs
   * @returns {Promise<void>}
   */
  async cacheProjectPlots(projectId, plotIds) {
    try {
      const key = this.generateKey('PROJECT_PLOTS', projectId);
      await this.cache.set(key, plotIds, CACHE_TTL.LIST_OPERATIONS);

      logger.debug(`${LOG_PREFIX} Cached project plots`, {
        projectId,
        plotCount: plotIds.length,
      });
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to cache project plots`, {
        projectId,
        error: error.message,
      });
    }
  }

  /**
   * Get cached project plots
   * @param {string} projectId Project ID
   * @returns {Promise<Array|null>} Array of plot IDs or null
   */
  async getProjectPlots(projectId) {
    try {
      const key = this.generateKey('PROJECT_PLOTS', projectId);
      const data = await this.cache.get(key);

      if (data) {
        this.cacheStats.hits++;
        logger.debug(`${LOG_PREFIX} Cache hit for project plots`, {
          projectId,
        });
      } else {
        this.cacheStats.misses++;
        logger.debug(`${LOG_PREFIX} Cache miss for project plots`, {
          projectId,
        });
      }

      return data;
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to get cached project plots`, {
        projectId,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Add plot to project plots index
   * @param {string} projectId Project ID
   * @param {string} plotId Plot ID
   * @returns {Promise<void>}
   */
  async addToProjectPlots(projectId, plotId) {
    try {
      const key = this.generateKey('PROJECT_PLOTS', projectId);
      const plotIds = (await this.cache.get(key)) || [];

      if (!plotIds.includes(plotId)) {
        plotIds.push(plotId);
        await this.cache.set(key, plotIds, CACHE_TTL.LIST_OPERATIONS);
      }
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to add plot to project plots index`, {
        projectId,
        plotId,
        error: error.message,
      });
    }
  }

  /**
   * Add time series to plot time series index
   * @param {string} plotId Plot ID
   * @param {string} timeSeriesId Time series ID
   * @returns {Promise<void>}
   */
  async addToPlotTimeSeries(plotId, timeSeriesId) {
    try {
      const key = this.generateKey('PLOT_TIMESERIES', plotId);
      const timeSeriesIds = (await this.cache.get(key)) || [];

      if (!timeSeriesIds.includes(timeSeriesId)) {
        timeSeriesIds.push(timeSeriesId);
        await this.cache.set(key, timeSeriesIds, CACHE_TTL.LIST_OPERATIONS);
      }
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to add time series to plot index`, {
        plotId,
        timeSeriesId,
        error: error.message,
      });
    }
  }

  /**
   * Invalidate cache for a specific data type and ID
   * @param {string} type Data type
   * @param {string} id Identifier
   * @returns {Promise<void>}
   */
  async invalidate(type, id) {
    try {
      const key = this.generateKey(type, id);
      await this.cache.delete(key);
      this.cacheStats.invalidations++;

      // Invalidate related cache entries
      await this.invalidateRelated(type, id);

      logger.debug(`${LOG_PREFIX} Invalidated cache`, { type, id, key });
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to invalidate cache`, {
        type,
        id,
        error: error.message,
      });
    }
  }

  /**
   * Invalidate related cache entries
   * @param {string} type Data type
   * @param {string} id Identifier
   * @returns {Promise<void>}
   */
  async invalidateRelated(type, id) {
    try {
      if (type === 'PROJECT') {
        // Invalidate project plots list
        await this.cache.delete(this.generateKey('PROJECT_PLOTS', id));
      } else if (type === 'PLOT') {
        // Invalidate plot time series list
        await this.cache.delete(this.generateKey('PLOT_TIMESERIES', id));
      }
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to invalidate related cache entries`, {
        type,
        id,
        error: error.message,
      });
    }
  }

  /**
   * Warm cache with frequently accessed data
   * @param {Array} warmingData Array of data to warm cache with
   * @returns {Promise<void>}
   */
  async warmCache(warmingData = []) {
    if (this.isWarming) {
      logger.debug(`${LOG_PREFIX} Cache warming already in progress`);
      return;
    }

    this.isWarming = true;

    try {
      logger.info(
        `${LOG_PREFIX} Starting cache warming with ${warmingData.length} items`
      );

      for (const item of warmingData) {
        try {
          switch (item.type) {
            case 'PROJECT':
              await this.cacheProject(item.id, item.data);
              break;
            case 'PLOT':
              await this.cachePlot(item.id, item.data);
              break;
            case 'TIME_SERIES':
              await this.cacheTimeSeries(item.id, item.data);
              break;
            case 'CLIMATE_DATA':
              await this.cacheClimateData(
                item.region,
                item.scenario,
                item.data
              );
              break;
          }

          // Small delay to prevent overwhelming the cache
          await new Promise(resolve => setTimeout(resolve, 10));
        } catch (error) {
          logger.error(`${LOG_PREFIX} Failed to warm cache item`, {
            item: item.id,
            error: error.message,
          });
        }
      }

      logger.info(`${LOG_PREFIX} Cache warming completed`);
    } finally {
      this.isWarming = false;
    }
  }

  /**
   * Get cache statistics
   * @returns {Object} Cache statistics
   */
  getStats() {
    const hitRate =
      this.cacheStats.hits + this.cacheStats.misses > 0
        ? (
            (this.cacheStats.hits /
              (this.cacheStats.hits + this.cacheStats.misses)) *
            100
          ).toFixed(2)
        : 0;

    return {
      ...this.cacheStats,
      hitRate: `${hitRate}%`,
      totalOperations: this.cacheStats.hits + this.cacheStats.misses,
      cacheManager: this.cache.getMetrics(),
    };
  }

  /**
   * Cache search results with complex queries
   * @param {string} query Search query
   * @param {Array} results Search results
   * @param {Object} options Search options
   * @returns {Promise<void>}
   */
  async cacheSearchResults(query, results, options = {}) {
    try {
      const key = this.generateKey('SEARCH', query, {
        type: options.type || 'all',
        limit: options.limit || 50,
        region: options.region || 'all',
      });

      const cacheData = {
        query,
        results,
        resultCount: Array.isArray(results) ? results.length : 0,
        searchOptions: options,
        cachedAt: new Date().toISOString(),
      };

      await this.cache.set(key, cacheData, CACHE_TTL.SEARCH_RESULTS);
      logger.debug(`${LOG_PREFIX} Cached search results`, {
        query,
        resultCount: cacheData.resultCount,
      });
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to cache search results`, {
        query,
        error: error.message,
      });
    }
  }

  /**
   * Get cached search results
   * @param {string} query Search query
   * @param {Object} options Search options
   * @returns {Promise<Object|null>} Cached search results or null
   */
  async getSearchResults(query, options = {}) {
    try {
      const key = this.generateKey('SEARCH', query, {
        type: options.type || 'all',
        limit: options.limit || 50,
        region: options.region || 'all',
      });

      const data = await this.cache.get(key);

      if (data) {
        this.cacheStats.hits++;
        logger.debug(`${LOG_PREFIX} Cache hit for search`, {
          query,
          resultCount: data.resultCount,
        });
      } else {
        this.cacheStats.misses++;
        logger.debug(`${LOG_PREFIX} Cache miss for search`, { query });
      }

      return data;
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to get cached search results`, {
        query,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Cache statistics data
   * @param {string} type Statistics type
   * @param {Object} stats Statistics data
   * @returns {Promise<void>}
   */
  async cacheStats(type, stats) {
    try {
      const key = this.generateKey('STATS', type);
      await this.cache.set(
        key,
        {
          ...stats,
          cachedAt: new Date().toISOString(),
        },
        CACHE_TTL.STATISTICS
      );

      logger.debug(`${LOG_PREFIX} Cached statistics`, { type });
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to cache statistics`, {
        type,
        error: error.message,
      });
    }
  }

  /**
   * Get cached statistics
   * @param {string} type Statistics type
   * @returns {Promise<Object|null>} Cached statistics or null
   */
  async getCachedStats(type) {
    try {
      const key = this.generateKey('STATS', type);
      const data = await this.cache.get(key);

      if (data) {
        this.cacheStats.hits++;
        logger.debug(`${LOG_PREFIX} Cache hit for statistics`, { type });
      } else {
        this.cacheStats.misses++;
        logger.debug(`${LOG_PREFIX} Cache miss for statistics`, { type });
      }

      return data;
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Failed to get cached statistics`, {
        type,
        error: error.message,
      });
      return null;
    }
  }

  /**
   * Implement cache-aside pattern for complex operations
   * @param {string} key Cache key
   * @param {Function} fetchFunction Function to fetch data if not cached
   * @param {number} ttl Time to live in seconds
   * @returns {Promise<any>} Data from cache or fetch function
   */
  async cacheAside(key, fetchFunction, ttl = CACHE_TTL.LIST_OPERATIONS) {
    try {
      // Try to get from cache first
      let data = await this.cache.get(key);

      if (data) {
        this.cacheStats.hits++;
        logger.debug(`${LOG_PREFIX} Cache-aside hit`, { key });
        return data;
      }

      // Cache miss - fetch data
      this.cacheStats.misses++;
      logger.debug(`${LOG_PREFIX} Cache-aside miss, fetching data`, { key });

      data = await fetchFunction();

      // Cache the fetched data
      if (data !== null && data !== undefined) {
        await this.cache.set(key, data, ttl);
        logger.debug(`${LOG_PREFIX} Cached fetched data`, { key });
      }

      return data;
    } catch (error) {
      this.cacheStats.errors++;
      logger.error(`${LOG_PREFIX} Cache-aside operation failed`, {
        key,
        error: error.message,
      });

      // If caching fails, still try to return the fetched data
      try {
        return await fetchFunction();
      } catch (fetchError) {
        logger.error(`${LOG_PREFIX} Fetch function also failed`, {
          key,
          error: fetchError.message,
        });
        throw fetchError;
      }
    }
  }

  /**
   * Bulk cache operations for efficiency
   * @param {Array} operations Array of cache operations
   * @returns {Promise<Object>} Results of bulk operations
   */
  async bulkOperations(operations) {
    const results = {
      successful: 0,
      failed: 0,
      errors: [],
    };

    try {
      // Process operations in parallel batches
      const batchSize = 10;
      for (let i = 0; i < operations.length; i += batchSize) {
        const batch = operations.slice(i, i + batchSize);

        const batchPromises = batch.map(async operation => {
          try {
            switch (operation.type) {
              case 'SET':
                await this.cache.set(
                  operation.key,
                  operation.data,
                  operation.ttl || CACHE_TTL.LIST_OPERATIONS
                );
                break;
              case 'GET':
                operation.result = await this.cache.get(operation.key);
                break;
              case 'DELETE':
                await this.cache.delete(operation.key);
                break;
              default:
                throw new Error(`Unknown operation type: ${operation.type}`);
            }
            results.successful++;
          } catch (error) {
            results.failed++;
            results.errors.push({
              operation: operation.type,
              key: operation.key,
              error: error.message,
            });
          }
        });

        await Promise.all(batchPromises);
      }

      logger.info(`${LOG_PREFIX} Bulk operations completed`, {
        total: operations.length,
        successful: results.successful,
        failed: results.failed,
      });
    } catch (error) {
      logger.error(`${LOG_PREFIX} Bulk operations failed`, {
        error: error.message,
      });
      results.errors.push({ general: error.message });
    }

    return results;
  }

  /**
   * Get cache size and memory usage estimates
   * @returns {Promise<Object>} Cache size information
   */
  async getCacheSize() {
    try {
      const sizes = {
        estimatedMemoryUsage: 0,
        keyCount: 0,
        largestEntry: { key: '', size: 0 },
        breakdown: {},
      };

      // Estimate memory usage for each prefix
      for (const [prefixName, prefix] of Object.entries(KEY_PREFIXES)) {
        sizes.breakdown[prefixName] = {
          count: 0,
          estimatedSize: 0,
        };
      }

      // This is a simplified estimation - in production, you'd use Redis MEMORY USAGE command
      logger.debug(`${LOG_PREFIX} Cache size estimation`, sizes);

      return sizes;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to get cache size`, {
        error: error.message,
      });
      return { error: error.message };
    }
  }

  /**
   * Clear all OpenForis cache entries
   * @returns {Promise<void>}
   */
  async clearAll() {
    try {
      // Clear all cache entries with OpenForis prefixes
      const prefixes = Object.values(KEY_PREFIXES);

      for (const prefix of prefixes) {
        // This is a simplified approach - in production, you'd need to scan and delete keys
        // For now, we'll clear the entire cache
        await this.cache.clear();
      }

      // Reset stats
      this.cacheStats = {
        hits: 0,
        misses: 0,
        invalidations: 0,
        errors: 0,
      };

      logger.info(`${LOG_PREFIX} Cleared all OpenForis cache entries`);
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to clear cache`, {
        error: error.message,
      });
    }
  }

  /**
   * Clear cache entries older than specified age
   * @param {number} maxAgeMs Maximum age in milliseconds
   * @returns {Promise<number>} Number of entries cleared
   */
  async clearOldEntries(maxAgeMs = 24 * 60 * 60 * 1000) {
    // Default 24 hours
    const clearedCount = 0;

    try {
      // This is a simplified implementation
      // In production with Redis, you'd use TTL-based expiration or scan keys with SCAN
      logger.info(`${LOG_PREFIX} Cleared ${clearedCount} old cache entries`, {
        maxAgeMs,
      });

      return clearedCount;
    } catch (error) {
      logger.error(`${LOG_PREFIX} Failed to clear old entries`, {
        error: error.message,
      });
      return 0;
    }
  }
}

// Export singleton instance
const openForisCacheManager = new OpenForisCacheManager();

module.exports = {
  OpenForisCacheManager,
  openForisCacheManager,
  CACHE_TTL,
  KEY_PREFIXES,
};
