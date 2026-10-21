/**
 * WRFCoin Cache Layer
 *
 * Unified cache interface with metrics, invalidation, and multi-tier support.
 *
 * @module cache
 */

// Cache Manager - Main interface
export {
  WRFCoinCacheManager,
  cacheManager,
  DEFAULT_POLICIES,
  type CacheConfig,
  type CachePolicy,
  type CacheStats,
  type RedisClientInterface,
} from './cache-manager.js';

// Cache Metrics - Prometheus integration
export {
  cacheMetrics,
  metricsCollector,
  CacheMetricsCollector,
  recordCacheOperation,
  recordCacheEviction,
  recordCacheInvalidation,
  updateCacheHitRate,
  updateCacheSizeMetrics,
  updateRedisPoolMetrics,
  metricsRegister,
  type CacheType,
  type CacheOperation,
  type CacheStatus,
} from './cache-metrics.js';

// Cache Invalidation - Event-driven patterns
export {
  CacheInvalidationManager,
  invalidationManager,
  defaultCacheDependencies,
  InvalidatesCache,
  type InvalidationEvent,
  type InvalidationPattern,
  type InvalidationResult,
  type CacheDependency,
} from './cache-invalidation.js';
