/**
 * Cache Invalidation Module
 *
 * Provides cache invalidation patterns for WRFCoin platform.
 * Supports event-driven invalidation, dependency tracking, and cross-service coordination.
 */

import { EventEmitter } from 'events';
import {
  recordCacheInvalidation,
  CacheType,
} from './cache-metrics.js';
import { performanceLogger } from '../utils/logger.js';

// Invalidation event types
export type InvalidationEvent =
  | 'weather_data_update'
  | 'bridge_state_change'
  | 'user_session_change'
  | 'transaction_complete'
  | 'graphql_schema_change'
  | 'database_migration'
  | 'config_update'
  | 'manual_invalidation'
  | 'governance_vote'
  | 'proposal_created'
  | 'proposal_executed'
  | 'delegation_changed'
  | 'carbon_transfer'
  | 'carbon_mint'
  | 'carbon_retire'
  | 'carbon_verified'
  | 'swap_executed'
  | 'liquidity_added'
  | 'liquidity_removed'
  | 'stake_deposited'
  | 'rewards_claimed'
  | 'bridge_reorg';

// Invalidation pattern configuration
export interface InvalidationPattern {
  event: InvalidationEvent;
  cacheTypes: CacheType[];
  keyPatterns: string[];
  ttl?: number; // Optional TTL for delayed invalidation
  cascade?: boolean; // Whether to cascade invalidation to dependencies
}

// Cache dependency configuration
export interface CacheDependency {
  source: CacheType;
  dependents: CacheType[];
  keyMatcher: (sourceKey: string) => string[];
}

/**
 * Cache Invalidation Manager
 *
 * Coordinates cache invalidation across services using event-driven patterns.
 */
export class CacheInvalidationManager extends EventEmitter {
  private patterns: Map<InvalidationEvent, InvalidationPattern[]> = new Map();
  private dependencies: CacheDependency[] = [];
  private pendingInvalidations: Map<string, NodeJS.Timeout> = new Map();
  private invalidationHandler: ((cacheType: CacheType, pattern: string) => Promise<void>) | null = null;

  constructor() {
    super();
    this.initializeDefaultPatterns();
    this.setupEventListeners();
  }

  /**
   * Register custom invalidation handler
   */
  setInvalidationHandler(
    handler: (cacheType: CacheType, pattern: string) => Promise<void>
  ): void {
    this.invalidationHandler = handler;
  }

  /**
   * Register an invalidation pattern
   */
  registerPattern(pattern: InvalidationPattern): void {
    const patterns = this.patterns.get(pattern.event) || [];
    patterns.push(pattern);
    this.patterns.set(pattern.event, patterns);
  }

  /**
   * Register a cache dependency
   */
  registerDependency(dependency: CacheDependency): void {
    this.dependencies.push(dependency);
  }

  /**
   * Trigger invalidation for an event
   */
  async invalidate(
    event: InvalidationEvent,
    context?: { key?: string; data?: Record<string, unknown> }
  ): Promise<InvalidationResult> {
    const patterns = this.patterns.get(event) || [];
    const result: InvalidationResult = {
      event,
      patternsMatched: 0,
      keysInvalidated: 0,
      cascaded: false,
      timestamp: new Date(),
    };

    for (const pattern of patterns) {
      result.patternsMatched++;

      for (const cacheType of pattern.cacheTypes) {
        for (const keyPattern of pattern.keyPatterns) {
          // Apply context substitution if key provided
          const finalPattern = context?.key
            ? keyPattern.replace('{key}', context.key)
            : keyPattern;

          // Handle delayed invalidation
          if (pattern.ttl && pattern.ttl > 0) {
            this.scheduleInvalidation(cacheType, finalPattern, pattern.ttl);
          } else {
            await this.executeInvalidation(cacheType, finalPattern, 'data_change');
            result.keysInvalidated++;
          }
        }
      }

      // Handle cascade invalidation
      if (pattern.cascade) {
        await this.cascadeInvalidation(pattern.cacheTypes, context?.key);
        result.cascaded = true;
      }
    }

    this.emit('invalidation', result);
    return result;
  }

  /**
   * Schedule delayed invalidation
   */
  private scheduleInvalidation(
    cacheType: CacheType,
    pattern: string,
    delayMs: number
  ): void {
    const key = `${cacheType}:${pattern}`;

    // Cancel existing scheduled invalidation for same key
    const existing = this.pendingInvalidations.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    // Schedule new invalidation
    const timeout = setTimeout(async () => {
      await this.executeInvalidation(cacheType, pattern, 'scheduled');
      this.pendingInvalidations.delete(key);
    }, delayMs);

    this.pendingInvalidations.set(key, timeout);
  }

  /**
   * Execute cache invalidation
   */
  private async executeInvalidation(
    cacheType: CacheType,
    pattern: string,
    trigger: 'data_change' | 'manual' | 'dependency' | 'scheduled'
  ): Promise<void> {
    // Record metrics
    recordCacheInvalidation(cacheType, pattern, trigger);

    // Execute through registered handler
    if (this.invalidationHandler) {
      try {
        await this.invalidationHandler(cacheType, pattern);
      } catch (error) {
        performanceLogger.error('Cache invalidation failed', { cacheType, pattern, error: (error as Error).message });
      }
    }

    this.emit('key_invalidated', { cacheType, pattern, trigger });
  }

  /**
   * Cascade invalidation to dependent caches
   */
  private async cascadeInvalidation(
    sourceCacheTypes: CacheType[],
    sourceKey?: string
  ): Promise<void> {
    for (const dependency of this.dependencies) {
      if (sourceCacheTypes.includes(dependency.source)) {
        const dependentKeys = sourceKey
          ? dependency.keyMatcher(sourceKey)
          : ['*'];

        for (const cacheType of dependency.dependents) {
          for (const key of dependentKeys) {
            await this.executeInvalidation(cacheType, key, 'dependency');
          }
        }
      }
    }
  }

  /**
   * Manual invalidation by pattern
   */
  async invalidateByPattern(
    cacheType: CacheType,
    pattern: string
  ): Promise<void> {
    await this.executeInvalidation(cacheType, pattern, 'manual');
  }

  /**
   * Invalidate all caches of a type
   */
  async invalidateAll(cacheType: CacheType): Promise<void> {
    await this.executeInvalidation(cacheType, '*', 'manual');
  }

  /**
   * Cancel pending invalidations
   */
  cancelPendingInvalidations(): void {
    for (const timeout of this.pendingInvalidations.values()) {
      clearTimeout(timeout);
    }
    this.pendingInvalidations.clear();
  }

  /**
   * Initialize default invalidation patterns
   */
  private initializeDefaultPatterns(): void {
    // Weather data updates
    this.registerPattern({
      event: 'weather_data_update',
      cacheTypes: ['weather_data', 'graphql', 'api_response'],
      keyPatterns: ['weather:{key}', 'graphql:weather*', 'api:/weather/*'],
      cascade: true,
    });

    // Bridge state changes
    this.registerPattern({
      event: 'bridge_state_change',
      cacheTypes: ['cross_chain', 'api_response'],
      keyPatterns: ['bridge:{key}', 'api:/bridge/*'],
      cascade: false,
    });

    // User session changes
    this.registerPattern({
      event: 'user_session_change',
      cacheTypes: ['user_session', 'graphql'],
      keyPatterns: ['session:{key}', 'user:{key}', 'graphql:user*'],
      cascade: false,
    });

    // Transaction completion
    this.registerPattern({
      event: 'transaction_complete',
      cacheTypes: ['database_query', 'api_response', 'graphql'],
      keyPatterns: ['tx:{key}', 'balance:{key}', 'wallet:{key}'],
      cascade: true,
    });

    // GraphQL schema changes
    this.registerPattern({
      event: 'graphql_schema_change',
      cacheTypes: ['graphql'],
      keyPatterns: ['graphql:*'],
      cascade: false,
    });

    // Database migration
    this.registerPattern({
      event: 'database_migration',
      cacheTypes: ['database_query', 'graphql', 'api_response'],
      keyPatterns: ['*'],
      cascade: true,
    });

    // Config updates
    this.registerPattern({
      event: 'config_update',
      cacheTypes: ['memory', 'redis'],
      keyPatterns: ['config:*'],
      ttl: 5000, // 5 second delay for config propagation
      cascade: false,
    });

    // Task 77: Governance invalidation patterns
    this.registerPattern({
      event: 'governance_vote',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['governance:stats*', 'governance:proposal:{key}', 'governance:voter:*', 'api:/governance/*'],
      cascade: true,
    });

    this.registerPattern({
      event: 'proposal_created',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['governance:stats*', 'governance:history*', 'api:/governance/*'],
      cascade: false,
    });

    this.registerPattern({
      event: 'proposal_executed',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['governance:stats*', 'governance:proposal:{key}', 'governance:treasury*', 'api:/governance/*'],
      cascade: true,
    });

    this.registerPattern({
      event: 'delegation_changed',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['governance:voter:{key}', 'governance:delegates*', 'api:/governance/voter/*'],
      cascade: false,
    });

    // Task 77: Carbon credit invalidation patterns
    this.registerPattern({
      event: 'carbon_transfer',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['carbon:balance:{key}', 'carbon:credit:{key}', 'api:/carbon-credit/*'],
      cascade: true,
    });

    this.registerPattern({
      event: 'carbon_mint',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['carbon:balance:*', 'carbon:stats*', 'api:/carbon-credit/*'],
      cascade: false,
    });

    this.registerPattern({
      event: 'carbon_retire',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['carbon:balance:{key}', 'carbon:credit:{key}', 'carbon:retired*', 'api:/carbon-credit/*'],
      cascade: false,
    });

    this.registerPattern({
      event: 'carbon_verified',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['carbon:credit:{key}', 'carbon:verified*', 'api:/carbon-credit/*'],
      cascade: false,
    });

    // Task 77: DeFi invalidation patterns
    this.registerPattern({
      event: 'swap_executed',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['amm:pool:*', 'amm:price:*', 'api:/amm/*', 'api:/defi/*'],
      cascade: true,
    });

    this.registerPattern({
      event: 'liquidity_added',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['amm:pool:{key}', 'amm:liquidity:*', 'api:/amm/*'],
      cascade: false,
    });

    this.registerPattern({
      event: 'liquidity_removed',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['amm:pool:{key}', 'amm:liquidity:*', 'api:/amm/*'],
      cascade: false,
    });

    this.registerPattern({
      event: 'stake_deposited',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['yield:stats*', 'yield:user:{key}', 'api:/yield-farming/*'],
      cascade: false,
    });

    this.registerPattern({
      event: 'rewards_claimed',
      cacheTypes: ['api_response', 'graphql'],
      keyPatterns: ['yield:stats*', 'yield:user:{key}', 'yield:rewards:*', 'api:/yield-farming/*'],
      cascade: false,
    });

    this.registerPattern({
      event: 'bridge_reorg',
      cacheTypes: ['cross_chain', 'api_response', 'graphql', 'database_query'],
      keyPatterns: [
        'tx:{key}',
        'transaction:{key}',
        'bridge:tx:{key}',
        'bridge:status:{key}',
        'block:*',
        'balance:*',
        'wallet:*',
        'api:/bridge/*',
        'api:/bridges/*',
      ],
      cascade: true,
    });
  }

  /**
   * Setup internal event listeners
   */
  private setupEventListeners(): void {
    // Log invalidation events
    this.on('invalidation', (result: InvalidationResult) => {
      if (result.keysInvalidated > 0) {
        performanceLogger.info('Cache invalidation completed', {
          event: result.event,
          keysInvalidated: result.keysInvalidated
        });
      }
    });
  }
}

/**
 * Result of invalidation operation
 */
export interface InvalidationResult {
  event: InvalidationEvent;
  patternsMatched: number;
  keysInvalidated: number;
  cascaded: boolean;
  timestamp: Date;
}

// Default cache dependencies
export const defaultCacheDependencies: CacheDependency[] = [
  {
    source: 'database_query',
    dependents: ['graphql', 'api_response'],
    keyMatcher: (key) => [`graphql:${key}`, `api:${key}`],
  },
  {
    source: 'weather_data',
    dependents: ['graphql', 'api_response', 'database_query'],
    keyMatcher: (key) => [
      `graphql:weather:${key}`,
      `api:/weather/${key}`,
      `db:weather:${key}`,
    ],
  },
  {
    source: 'cross_chain',
    dependents: ['api_response'],
    keyMatcher: (key) => [`api:/bridge/${key}`],
  },
];

// Global invalidation manager instance
export const invalidationManager = new CacheInvalidationManager();

// Register default dependencies
defaultCacheDependencies.forEach((dep) =>
  invalidationManager.registerDependency(dep)
);

/**
 * Decorator for automatic cache invalidation
 * Use with methods that modify data
 */
export function InvalidatesCache(
  event: InvalidationEvent,
  keyExtractor?: (args: unknown[]) => string
) {
  return function (
    _target: unknown,
    _propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (...args: unknown[]) {
      const result = await originalMethod.apply(this, args);

      // Trigger invalidation after successful operation
      const key = keyExtractor ? keyExtractor(args) : undefined;
      await invalidationManager.invalidate(event, { key });

      return result;
    };

    return descriptor;
  };
}
