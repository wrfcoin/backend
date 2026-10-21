/**
 * Cache Manager Module
 *
 * Unified cache interface for WRFCoin platform.
 * Provides multi-tier caching with metrics and invalidation support.
 */

import { LRUCache } from 'lru-cache';
import {
  CacheType,
  recordCacheOperation,
  recordCacheEviction,
  updateCacheSizeMetrics,
  metricsCollector,
} from './cache-metrics.js';
import {
  InvalidationEvent,
  invalidationManager,
} from './cache-invalidation.js';

// Cache entry with metadata
interface CacheEntry<T> {
  value: T;
  createdAt: number;
  accessCount: number;
  lastAccessed: number;
  size: number;
}

// Cache configuration
interface CacheConfig {
  maxSize: number; // Max entries for memory cache
  maxAge: number; // Default TTL in milliseconds
  updateAgeOnGet: boolean;
  allowStale: boolean;
  enableMetrics: boolean;
}

// Cache policy definitions
interface CachePolicy {
  name: string;
  ttl: number;
  maxSize: number;
  priority: 'low' | 'normal' | 'high';
  compression: boolean;
  invalidationEvents: InvalidationEvent[];
}

// Default cache policies (aligned with redis-client.js)
const DEFAULT_POLICIES: Record<string, CachePolicy> = {
  weatherData: {
    name: 'weatherData',
    ttl: 5 * 60 * 1000, // 5 minutes
    maxSize: 10000,
    priority: 'high',
    compression: false,
    invalidationEvents: ['weather_data_update'],
  },
  userSession: {
    name: 'userSession',
    ttl: 60 * 60 * 1000, // 1 hour
    maxSize: 50000,
    priority: 'high',
    compression: false,
    invalidationEvents: ['user_session_change'],
  },
  graphqlQuery: {
    name: 'graphqlQuery',
    ttl: 10 * 60 * 1000, // 10 minutes
    maxSize: 5000,
    priority: 'normal',
    compression: true,
    invalidationEvents: ['graphql_schema_change', 'database_migration'],
  },
  crossChainTx: {
    name: 'crossChainTx',
    ttl: 30 * 60 * 1000, // 30 minutes
    maxSize: 1000,
    priority: 'high',
    compression: false,
    invalidationEvents: ['bridge_state_change', 'transaction_complete'],
  },
  computeResults: {
    name: 'computeResults',
    ttl: 2 * 60 * 60 * 1000, // 2 hours
    maxSize: 500,
    priority: 'low',
    compression: true,
    invalidationEvents: [],
  },
  apiResponse: {
    name: 'apiResponse',
    ttl: 60 * 1000, // 1 minute
    maxSize: 10000,
    priority: 'normal',
    compression: false,
    invalidationEvents: ['config_update'],
  },
  databaseQuery: {
    name: 'databaseQuery',
    ttl: 5 * 60 * 1000, // 5 minutes
    maxSize: 5000,
    priority: 'normal',
    compression: true,
    invalidationEvents: ['database_migration'],
  },
  // Task 77: Governance Analytics caching policies
  governanceStats: {
    name: 'governanceStats',
    ttl: 60 * 1000, // 1 minute - governance stats should be relatively fresh
    maxSize: 1000,
    priority: 'high',
    compression: false,
    invalidationEvents: ['governance_vote', 'proposal_created', 'proposal_executed'],
  },
  governanceHistory: {
    name: 'governanceHistory',
    ttl: 10 * 60 * 1000, // 10 minutes - historical data changes less frequently
    maxSize: 5000,
    priority: 'normal',
    compression: true,
    invalidationEvents: ['governance_vote', 'proposal_created'],
  },
  governanceProposal: {
    name: 'governanceProposal',
    ttl: 2 * 60 * 1000, // 2 minutes - proposal details need to be current during voting
    maxSize: 2000,
    priority: 'high',
    compression: false,
    invalidationEvents: ['governance_vote', 'proposal_executed'],
  },
  governanceVoter: {
    name: 'governanceVoter',
    ttl: 5 * 60 * 1000, // 5 minutes - voter data
    maxSize: 10000,
    priority: 'normal',
    compression: false,
    invalidationEvents: ['governance_vote', 'delegation_changed'],
  },
  // Task 77: Carbon Credit caching policies
  carbonBalances: {
    name: 'carbonBalances',
    ttl: 30 * 1000, // 30 seconds - balances change frequently
    maxSize: 10000,
    priority: 'high',
    compression: false,
    invalidationEvents: ['carbon_transfer', 'carbon_mint', 'carbon_retire'],
  },
  carbonCredits: {
    name: 'carbonCredits',
    ttl: 60 * 1000, // 1 minute - carbon credit details
    maxSize: 5000,
    priority: 'normal',
    compression: false,
    invalidationEvents: ['carbon_transfer', 'carbon_verified'],
  },
  // Task 77: DeFi caching policies
  ammPoolState: {
    name: 'ammPoolState',
    ttl: 15 * 1000, // 15 seconds - AMM pools need very fresh data for trading
    maxSize: 500,
    priority: 'high',
    compression: false,
    invalidationEvents: ['swap_executed', 'liquidity_added', 'liquidity_removed'],
  },
  yieldFarmingStats: {
    name: 'yieldFarmingStats',
    ttl: 30 * 1000, // 30 seconds - staking rewards update frequently
    maxSize: 1000,
    priority: 'high',
    compression: false,
    invalidationEvents: ['stake_deposited', 'rewards_claimed'],
  },
};

/**
 * WRFCoin Cache Manager
 *
 * Provides unified multi-tier caching with:
 * - Memory cache (LRU) for hot data
 * - Redis cache for distributed caching
 * - Automatic metrics collection
 * - Event-driven invalidation
 */
export class WRFCoinCacheManager {
  private memoryCache: LRUCache<string, CacheEntry<unknown>>;
  private policies: Map<string, CachePolicy> = new Map();
  private config: CacheConfig;
  private stats = {
    hits: 0,
    misses: 0,
    sets: 0,
    deletes: 0,
    evictions: 0,
  };

  // Redis client placeholder - injected at runtime
  private redisClient: RedisClientInterface | null = null;

  constructor(config?: Partial<CacheConfig>) {
    this.config = {
      maxSize: 10000,
      maxAge: 5 * 60 * 1000, // 5 minutes default
      updateAgeOnGet: true,
      allowStale: false,
      enableMetrics: true,
      ...config,
    };

    // Initialize memory cache
    this.memoryCache = new LRUCache<string, CacheEntry<unknown>>({
      max: this.config.maxSize,
      ttl: this.config.maxAge,
      updateAgeOnGet: this.config.updateAgeOnGet,
      allowStale: this.config.allowStale,
      dispose: (value, key) => {
        this.onEviction(key, value, 'lru');
      },
      ttlAutopurge: true,
    });

    // Load default policies
    Object.values(DEFAULT_POLICIES).forEach((policy) => {
      this.policies.set(policy.name, policy);
    });

    // Setup invalidation handler
    this.setupInvalidationHandler();

    // Start metrics collection
    if (this.config.enableMetrics) {
      metricsCollector.start();
    }
  }

  /**
   * Set Redis client for distributed caching
   */
  setRedisClient(client: RedisClientInterface): void {
    this.redisClient = client;
  }

  /**
   * Get value from cache
   */
  async get<T>(key: string, cacheType: CacheType = 'memory'): Promise<T | null> {
    const startTime = Date.now();
    let value: T | null = null;
    let status: 'hit' | 'miss' = 'miss';

    try {
      // Try memory cache first
      const memoryEntry = this.memoryCache.get(key) as CacheEntry<T> | undefined;
      if (memoryEntry) {
        memoryEntry.accessCount++;
        memoryEntry.lastAccessed = Date.now();
        value = memoryEntry.value;
        status = 'hit';
        this.stats.hits++;
        metricsCollector.recordHit(cacheType);
      } else if (this.redisClient) {
        // Try Redis
        const redisValue = await this.redisClient.get(key);
        if (redisValue) {
          value = JSON.parse(redisValue) as T;
          status = 'hit';
          this.stats.hits++;
          metricsCollector.recordHit(cacheType);

          // Promote to memory cache
          this.setMemoryCache(key, value);
        } else {
          this.stats.misses++;
          metricsCollector.recordMiss(cacheType);
        }
      } else {
        this.stats.misses++;
        metricsCollector.recordMiss(cacheType);
      }

      // Record metrics
      if (this.config.enableMetrics) {
        const latency = Date.now() - startTime;
        recordCacheOperation('get', cacheType, status, latency);
      }

      return value;
    } catch (error) {
      recordCacheOperation('get', cacheType, 'error');
      console.error(`Cache get error for key ${key}:`, error);
      return null;
    }
  }

  /**
   * Set value in cache
   */
  async set<T>(
    key: string,
    value: T,
    options?: {
      ttl?: number;
      cacheType?: CacheType;
      policyName?: string;
    }
  ): Promise<boolean> {
    const startTime = Date.now();
    const cacheType = options?.cacheType || 'memory';

    try {
      // Get policy if specified
      const policy = options?.policyName
        ? this.policies.get(options.policyName)
        : undefined;
      const ttl = options?.ttl || policy?.ttl || this.config.maxAge;

      // Create cache entry
      const entry: CacheEntry<T> = {
        value,
        createdAt: Date.now(),
        accessCount: 0,
        lastAccessed: Date.now(),
        size: this.estimateSize(value),
      };

      // Set in memory cache
      this.memoryCache.set(key, entry as CacheEntry<unknown>, { ttl });

      // Set in Redis if available
      if (this.redisClient) {
        const serialized = JSON.stringify(value);
        await this.redisClient.setex(key, Math.ceil(ttl / 1000), serialized);
      }

      this.stats.sets++;

      // Record metrics
      if (this.config.enableMetrics) {
        const latency = Date.now() - startTime;
        recordCacheOperation('set', cacheType, 'hit', latency);
        this.updateSizeMetrics();
      }

      return true;
    } catch (error) {
      recordCacheOperation('set', cacheType, 'error');
      console.error(`Cache set error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete from cache
   */
  async delete(key: string, cacheType: CacheType = 'memory'): Promise<boolean> {
    const startTime = Date.now();

    try {
      // Delete from memory cache
      this.memoryCache.delete(key);

      // Delete from Redis
      if (this.redisClient) {
        await this.redisClient.del(key);
      }

      this.stats.deletes++;

      if (this.config.enableMetrics) {
        const latency = Date.now() - startTime;
        recordCacheOperation('delete', cacheType, 'hit', latency);
      }

      return true;
    } catch (error) {
      recordCacheOperation('delete', cacheType, 'error');
      console.error(`Cache delete error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Delete by pattern
   */
  async deletePattern(pattern: string, cacheType: CacheType = 'memory'): Promise<number> {
    let count = 0;

    // Delete from memory cache
    const regex = this.patternToRegex(pattern);
    for (const key of this.memoryCache.keys()) {
      if (regex.test(key)) {
        this.memoryCache.delete(key);
        count++;
      }
    }

    // Delete from Redis using SCAN
    if (this.redisClient && this.redisClient.scanDelete) {
      count += await this.redisClient.scanDelete(pattern);
    }

    if (this.config.enableMetrics) {
      recordCacheOperation('delete', cacheType, 'hit');
    }

    return count;
  }

  /**
   * Check if key exists
   */
  async exists(key: string): Promise<boolean> {
    if (this.memoryCache.has(key)) {
      return true;
    }

    if (this.redisClient) {
      return await this.redisClient.exists(key);
    }

    return false;
  }

  /**
   * Get remaining TTL for key
   */
  async ttl(key: string): Promise<number> {
    const entry = this.memoryCache.get(key) as CacheEntry<unknown> | undefined;
    if (entry) {
      const remaining = this.memoryCache.getRemainingTTL(key);
      return remaining ? Math.ceil(remaining / 1000) : -1;
    }

    if (this.redisClient) {
      return await this.redisClient.ttl(key);
    }

    return -2; // Key doesn't exist
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    this.memoryCache.clear();

    if (this.redisClient) {
      await this.redisClient.flushdb();
    }

    this.stats = {
      hits: 0,
      misses: 0,
      sets: 0,
      deletes: 0,
      evictions: 0,
    };
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return {
      ...this.stats,
      size: this.memoryCache.size,
      maxSize: this.config.maxSize,
      hitRate: this.stats.hits + this.stats.misses > 0
        ? (this.stats.hits / (this.stats.hits + this.stats.misses)) * 100
        : 0,
    };
  }

  /**
   * Get or set cache value (cache-aside pattern)
   */
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    options?: {
      ttl?: number;
      cacheType?: CacheType;
      policyName?: string;
    }
  ): Promise<T> {
    const cached = await this.get<T>(key, options?.cacheType);
    if (cached !== null) {
      return cached;
    }

    const value = await factory();
    await this.set(key, value, options);
    return value;
  }

  /**
   * Register a cache policy
   */
  registerPolicy(policy: CachePolicy): void {
    this.policies.set(policy.name, policy);
  }

  /**
   * Get policy by name
   */
  getPolicy(name: string): CachePolicy | undefined {
    return this.policies.get(name);
  }

  /**
   * Trigger cache invalidation
   */
  async invalidate(
    event: InvalidationEvent,
    context?: { key?: string; data?: Record<string, unknown> }
  ): Promise<void> {
    await invalidationManager.invalidate(event, context);
  }

  // Private methods

  private setMemoryCache<T>(key: string, value: T): void {
    const entry: CacheEntry<T> = {
      value,
      createdAt: Date.now(),
      accessCount: 0,
      lastAccessed: Date.now(),
      size: this.estimateSize(value),
    };
    this.memoryCache.set(key, entry as CacheEntry<unknown>);
  }

  private onEviction(
    key: string,
    _value: CacheEntry<unknown>,
    reason: 'lru' | 'ttl_expired' | 'manual'
  ): void {
    this.stats.evictions++;
    recordCacheEviction('memory', reason === 'lru' ? 'lru' : 'ttl_expired');
  }

  private estimateSize(value: unknown): number {
    const str = JSON.stringify(value);
    return str ? str.length * 2 : 0; // Approximate byte size
  }

  private patternToRegex(pattern: string): RegExp {
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    return new RegExp(`^${escaped}$`);
  }

  private updateSizeMetrics(): void {
    let totalSize = 0;
    for (const entry of this.memoryCache.values()) {
      totalSize += (entry as CacheEntry<unknown>).size;
    }
    updateCacheSizeMetrics('memory', totalSize, this.memoryCache.size);
  }

  private setupInvalidationHandler(): void {
    invalidationManager.setInvalidationHandler(
      async (cacheType: CacheType, pattern: string) => {
        await this.deletePattern(pattern, cacheType);
      }
    );
  }
}

// Redis client interface for dependency injection
interface RedisClientInterface {
  get(key: string): Promise<string | null>;
  setex(key: string, seconds: number, value: string): Promise<void>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  ttl(key: string): Promise<number>;
  flushdb(): Promise<void>;
  scanDelete?(pattern: string): Promise<number>;
}

// Cache statistics
interface CacheStats {
  hits: number;
  misses: number;
  sets: number;
  deletes: number;
  evictions: number;
  size: number;
  maxSize: number;
  hitRate: number;
}

// Global cache manager instance
export const cacheManager = new WRFCoinCacheManager();

// Export types and utilities
export type { CacheConfig, CachePolicy, CacheStats, RedisClientInterface };
export { DEFAULT_POLICIES };
