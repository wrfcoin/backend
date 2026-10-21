/**
 * Cache Metrics Module - Prometheus Integration
 *
 * Provides cache performance metrics for WRFCoin platform monitoring.
 * Integrates with existing redis-client.js cache layer.
 */

import { Counter, Gauge, Histogram, register } from 'prom-client';
import { performanceLogger } from '../utils/logger.js';

// Cache metrics for Prometheus
export const cacheMetrics = {
  // Cache hit/miss counter
  cacheOperations: new Counter({
    name: 'wrfcoin_cache_operations_total',
    help: 'Total number of cache operations',
    labelNames: ['operation', 'cache_type', 'status'],
  }),

  // Cache hit rate gauge (updated periodically)
  cacheHitRate: new Gauge({
    name: 'wrfcoin_cache_hit_rate',
    help: 'Current cache hit rate percentage',
    labelNames: ['cache_type'],
  }),

  // Cache operation latency
  cacheLatency: new Histogram({
    name: 'wrfcoin_cache_operation_duration_seconds',
    help: 'Cache operation latency in seconds',
    labelNames: ['operation', 'cache_type'],
    buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1],
  }),

  // Cache size gauge
  cacheSize: new Gauge({
    name: 'wrfcoin_cache_size_bytes',
    help: 'Current cache size in bytes',
    labelNames: ['cache_type'],
  }),

  // Cache key count
  cacheKeyCount: new Gauge({
    name: 'wrfcoin_cache_key_count',
    help: 'Number of keys in cache',
    labelNames: ['cache_type', 'policy'],
  }),

  // Cache evictions
  cacheEvictions: new Counter({
    name: 'wrfcoin_cache_evictions_total',
    help: 'Total number of cache evictions',
    labelNames: ['cache_type', 'reason'],
  }),

  // Cache invalidations
  cacheInvalidations: new Counter({
    name: 'wrfcoin_cache_invalidations_total',
    help: 'Total number of cache invalidations',
    labelNames: ['cache_type', 'pattern', 'trigger'],
  }),

  // Memory cache specific metrics
  memoryCacheUtilization: new Gauge({
    name: 'wrfcoin_memory_cache_utilization',
    help: 'Memory cache utilization percentage',
    labelNames: ['cache_name'],
  }),

  // Redis connection pool status
  redisPoolActive: new Gauge({
    name: 'wrfcoin_redis_pool_active_connections',
    help: 'Number of active Redis connections',
  }),

  redisPoolIdle: new Gauge({
    name: 'wrfcoin_redis_pool_idle_connections',
    help: 'Number of idle Redis connections',
  }),
};

// Cache types for consistent labeling
export type CacheType =
  | 'memory'
  | 'redis'
  | 'distributed'
  | 'graphql'
  | 'api_response'
  | 'database_query'
  | 'cross_chain'
  | 'weather_data'
  | 'user_session';

// Cache operation types
export type CacheOperation = 'get' | 'set' | 'delete' | 'exists' | 'ttl' | 'batch_get' | 'batch_set';

// Cache status for operations
export type CacheStatus = 'hit' | 'miss' | 'error' | 'expired' | 'evicted';

/**
 * Record a cache operation for metrics
 */
export function recordCacheOperation(
  operation: CacheOperation,
  cacheType: CacheType,
  status: CacheStatus,
  latencyMs?: number
): void {
  // Record operation count
  cacheMetrics.cacheOperations.inc({
    operation,
    cache_type: cacheType,
    status,
  });

  // Record latency if provided
  if (latencyMs !== undefined) {
    cacheMetrics.cacheLatency.observe(
      { operation, cache_type: cacheType },
      latencyMs / 1000 // Convert to seconds
    );
  }
}

/**
 * Update cache hit rate gauge
 */
export function updateCacheHitRate(
  cacheType: CacheType,
  hits: number,
  total: number
): void {
  const hitRate = total > 0 ? (hits / total) * 100 : 0;
  cacheMetrics.cacheHitRate.set({ cache_type: cacheType }, hitRate);
}

/**
 * Record cache eviction
 */
export function recordCacheEviction(
  cacheType: CacheType,
  reason: 'ttl_expired' | 'lru' | 'memory_pressure' | 'manual'
): void {
  cacheMetrics.cacheEvictions.inc({
    cache_type: cacheType,
    reason,
  });
}

/**
 * Record cache invalidation
 */
export function recordCacheInvalidation(
  cacheType: CacheType,
  pattern: string,
  trigger: 'data_change' | 'manual' | 'dependency' | 'scheduled'
): void {
  cacheMetrics.cacheInvalidations.inc({
    cache_type: cacheType,
    pattern,
    trigger,
  });
}

/**
 * Update cache size metrics
 */
export function updateCacheSizeMetrics(
  cacheType: CacheType,
  sizeBytes: number,
  keyCount: number,
  policy?: string
): void {
  cacheMetrics.cacheSize.set({ cache_type: cacheType }, sizeBytes);
  cacheMetrics.cacheKeyCount.set({
    cache_type: cacheType,
    policy: policy || 'default'
  }, keyCount);
}

/**
 * Update Redis connection pool metrics
 */
export function updateRedisPoolMetrics(active: number, idle: number): void {
  cacheMetrics.redisPoolActive.set(active);
  cacheMetrics.redisPoolIdle.set(idle);
}

/**
 * Cache metrics collector class for periodic updates
 */
export class CacheMetricsCollector {
  private collectionInterval: NodeJS.Timeout | null = null;
  private cacheStats: Map<CacheType, { hits: number; misses: number }> = new Map();

  constructor(private intervalMs: number = 30000) {}

  /**
   * Start periodic metrics collection
   */
  start(): void {
    if (this.collectionInterval) {
      return;
    }

    this.collectionInterval = setInterval(() => {
      this.collectMetrics();
    }, this.intervalMs);
    // #977: unref'd — reached from the module-scope `cacheManager` singleton, so
    // metrics collection must never be the reason a process cannot exit.
    this.collectionInterval.unref();

    // Collect immediately on start
    this.collectMetrics();
  }

  /**
   * Stop metrics collection
   */
  stop(): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
    }
  }

  /**
   * Record a cache hit
   */
  recordHit(cacheType: CacheType): void {
    const stats = this.cacheStats.get(cacheType) || { hits: 0, misses: 0 };
    stats.hits++;
    this.cacheStats.set(cacheType, stats);
  }

  /**
   * Record a cache miss
   */
  recordMiss(cacheType: CacheType): void {
    const stats = this.cacheStats.get(cacheType) || { hits: 0, misses: 0 };
    stats.misses++;
    this.cacheStats.set(cacheType, stats);
  }

  /**
   * Get current hit rate for a cache type
   */
  getHitRate(cacheType: CacheType): number {
    const stats = this.cacheStats.get(cacheType);
    if (!stats) return 0;
    const total = stats.hits + stats.misses;
    return total > 0 ? (stats.hits / total) * 100 : 0;
  }

  /**
   * Collect and update all metrics
   */
  private collectMetrics(): void {
    // Update hit rates for all cache types
    // Use Array.from for ES5 compatibility
    const cacheEntries = Array.from(this.cacheStats.entries());
    for (const [cacheType, stats] of cacheEntries) {
      updateCacheHitRate(cacheType, stats.hits, stats.hits + stats.misses);
    }

    // Update memory usage
    const memUsage = process.memoryUsage();
    cacheMetrics.memoryCacheUtilization.set(
      { cache_name: 'process' },
      (memUsage.heapUsed / memUsage.heapTotal) * 100
    );
  }

  /**
   * Reset statistics (for testing or periodic reset)
   */
  resetStats(): void {
    this.cacheStats.clear();
  }
}

// Global metrics collector instance
export const metricsCollector = new CacheMetricsCollector();

// ============================================================================
// Redis Cache Prometheus Collector
// Connects RedisCacheClient's internal metrics to Prometheus
// ============================================================================

// Redis-specific Prometheus metrics
export const redisMetrics = {
  // Hit rate as percentage (0-100)
  redisHitRate: new Gauge({
    name: 'wrfcoin_redis_hit_rate_percent',
    help: 'Redis cache hit rate percentage',
  }),

  // Total operations counters
  redisTotalGets: new Gauge({
    name: 'wrfcoin_redis_total_gets',
    help: 'Total Redis GET operations',
  }),

  redisTotalSets: new Gauge({
    name: 'wrfcoin_redis_total_sets',
    help: 'Total Redis SET operations',
  }),

  redisTotalHits: new Gauge({
    name: 'wrfcoin_redis_total_hits',
    help: 'Total Redis cache hits',
  }),

  redisTotalMisses: new Gauge({
    name: 'wrfcoin_redis_total_misses',
    help: 'Total Redis cache misses',
  }),

  redisTotalErrors: new Gauge({
    name: 'wrfcoin_redis_total_errors',
    help: 'Total Redis errors',
  }),

  // Validation count
  redisValidations: new Gauge({
    name: 'wrfcoin_redis_validations_total',
    help: 'Total Redis data validations',
  }),

  // Compression metrics
  redisCompressionBytesSaved: new Gauge({
    name: 'wrfcoin_redis_compression_bytes_saved',
    help: 'Bytes saved through Redis compression',
  }),

  // Connection status (1 = connected, 0 = disconnected)
  redisConnectionStatus: new Gauge({
    name: 'wrfcoin_redis_connected',
    help: 'Redis connection status (1=connected, 0=disconnected)',
  }),

  // Uptime in seconds
  redisUptimeSeconds: new Gauge({
    name: 'wrfcoin_redis_uptime_seconds',
    help: 'Redis client uptime in seconds',
  }),

  // Operations per minute
  redisGetsPerMinute: new Gauge({
    name: 'wrfcoin_redis_gets_per_minute',
    help: 'Average Redis GET operations per minute',
  }),

  redisSetsPerMinute: new Gauge({
    name: 'wrfcoin_redis_sets_per_minute',
    help: 'Average Redis SET operations per minute',
  }),
};

// Interface for RedisCacheClient statistics
interface RedisCacheStatistics {
  connected: boolean;
  uptime: number;
  operations: {
    getCount: number;
    setCount: number;
    hitCount: number;
    missCount: number;
    errorCount: number;
    validationCount: number;
  };
  performance: {
    hitRate: string;
    averageGetsPerMinute: string;
    averageSetsPerMinute: string;
  };
  compression: {
    bytesSaved: number;
    compressionRatio: string;
  };
  redis: {
    usedMemory?: string;
    peakMemory?: string;
  };
  historySize: number;
}

// Redis cache client getter type
type RedisCacheClientGetter = () => {
  getStatistics(): Promise<RedisCacheStatistics>;
};

/**
 * RedisCachePrometheusCollector
 * Periodically collects metrics from RedisCacheClient and updates Prometheus gauges
 */
export class RedisCachePrometheusCollector {
  private collectionInterval: NodeJS.Timeout | null = null;
  private cacheClientGetter: RedisCacheClientGetter | null = null;
  private readonly DEFAULT_INTERVAL_MS = 15000; // 15 seconds

  /**
   * Set the Redis cache client getter
   * This allows lazy initialization to avoid circular dependencies
   */
  setCacheClient(getter: RedisCacheClientGetter): void {
    this.cacheClientGetter = getter;
    performanceLogger.info('RedisCachePrometheusCollector cache client configured');
  }

  /**
   * Start periodic metrics collection
   */
  start(intervalMs: number = this.DEFAULT_INTERVAL_MS): void {
    if (this.collectionInterval) {
      performanceLogger.info('RedisCachePrometheusCollector already running');
      return;
    }

    // Collect immediately on start
    this.collectMetrics();

    // Start periodic collection
    this.collectionInterval = setInterval(() => {
      this.collectMetrics();
    }, intervalMs);

    performanceLogger.info('RedisCachePrometheusCollector started', { intervalMs });
  }

  /**
   * Stop metrics collection
   */
  stop(): void {
    if (this.collectionInterval) {
      clearInterval(this.collectionInterval);
      this.collectionInterval = null;
      performanceLogger.info('RedisCachePrometheusCollector stopped');
    }
  }

  /**
   * Collect and update all Redis cache metrics
   */
  private async collectMetrics(): Promise<void> {
    if (!this.cacheClientGetter) {
      return;
    }

    try {
      const cacheClient = this.cacheClientGetter();
      const stats = await cacheClient.getStatistics();

      // Update connection status
      redisMetrics.redisConnectionStatus.set(stats.connected ? 1 : 0);

      // Update uptime
      redisMetrics.redisUptimeSeconds.set(Math.floor(stats.uptime / 1000));

      // Update operation counts
      redisMetrics.redisTotalGets.set(stats.operations.getCount);
      redisMetrics.redisTotalSets.set(stats.operations.setCount);
      redisMetrics.redisTotalHits.set(stats.operations.hitCount);
      redisMetrics.redisTotalMisses.set(stats.operations.missCount);
      redisMetrics.redisTotalErrors.set(stats.operations.errorCount);
      redisMetrics.redisValidations.set(stats.operations.validationCount);

      // Update hit rate
      const hitRate = parseFloat(stats.performance.hitRate.replace('%', '')) || 0;
      redisMetrics.redisHitRate.set(hitRate);

      // Also update the general cache hit rate gauge
      cacheMetrics.cacheHitRate.set({ cache_type: 'redis' }, hitRate);

      // Update operations per minute
      const getsPerMin = parseFloat(stats.performance.averageGetsPerMinute) || 0;
      const setsPerMin = parseFloat(stats.performance.averageSetsPerMinute) || 0;
      redisMetrics.redisGetsPerMinute.set(getsPerMin);
      redisMetrics.redisSetsPerMinute.set(setsPerMin);

      // Update compression metrics
      redisMetrics.redisCompressionBytesSaved.set(stats.compression.bytesSaved);

      // Update Redis pool metrics (connected = 1 active, 0 idle when connected)
      if (stats.connected) {
        cacheMetrics.redisPoolActive.set(1);
        cacheMetrics.redisPoolIdle.set(0);
      } else {
        cacheMetrics.redisPoolActive.set(0);
        cacheMetrics.redisPoolIdle.set(0);
      }

      // Update cache operation counters
      cacheMetrics.cacheOperations.inc({
        operation: 'get',
        cache_type: 'redis',
        status: 'hit',
      }, 0); // Reset counter to 0 delta - the actual count is in redisTotalHits

      performanceLogger.debug('RedisCachePrometheusCollector metrics collected', {
        connected: stats.connected,
        hitRate: `${hitRate}%`,
        gets: stats.operations.getCount,
        hits: stats.operations.hitCount,
      });
    } catch (error) {
      performanceLogger.warn('RedisCachePrometheusCollector error collecting metrics', { error: (error as Error).message });
      // Mark as disconnected on error
      redisMetrics.redisConnectionStatus.set(0);
    }
  }

  /**
   * Get current metrics snapshot for debugging
   */
  async getSnapshot(): Promise<RedisCacheStatistics | null> {
    if (!this.cacheClientGetter) {
      return null;
    }
    try {
      const cacheClient = this.cacheClientGetter();
      return await cacheClient.getStatistics();
    } catch {
      return null;
    }
  }
}

// Global Redis cache Prometheus collector instance
export const redisCachePrometheusCollector = new RedisCachePrometheusCollector();

// Export register for custom integrations
export { register as metricsRegister };
