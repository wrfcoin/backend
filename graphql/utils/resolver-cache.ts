/**
 * GraphQL Resolver Caching Utilities
 * Provides caching wrappers for high-frequency resolver queries
 * Task 82: Redis caching for GraphQL resolvers
 */

import { cacheManager, DEFAULT_POLICIES } from '../../server/cache/cache-manager.js';
import { logger } from '../../utils/logger.js';

// Cache key generators
export const cacheKeys = {
  user: {
    stakingPositions: (address: string) => `user:${address}:staking_positions`,
    liquidityPositions: (address: string) => `user:${address}:liquidity_positions`,
    rewards: (address: string) => `user:${address}:rewards`,
    swaps: (address: string) => `user:${address}:swaps`,
    computationalNFTs: (address: string) => `user:${address}:computational_nfts`,
  },
  weather: {
    stationData: (stationId: string) => `weather:station:${stationId}:data`,
    stationQuality: (stationId: string) => `weather:station:${stationId}:quality`,
    dataConfidence: (dataId: string) => `weather:data:${dataId}:confidence`,
    stationList: (filters?: string) => `weather:stations:${filters || 'all'}`,
  },
  carbon: {
    credit: (tokenId: string) => `carbon:credit:${tokenId}`,
    tradingHistory: (tokenId: string) => `carbon:credit:${tokenId}:trading_history`,
    priceHistory: (tokenId: string) => `carbon:credit:${tokenId}:price_history`,
    marketplace: (filters?: string) => `carbon:marketplace:${filters || 'all'}`,
  },
  defi: {
    poolState: (poolId: string) => `defi:pool:${poolId}:state`,
    yieldFarming: (userId: string) => `defi:yield:${userId}`,
  },
};

// Cache TTL configurations (in seconds)
const CACHE_TTL = {
  user: {
    stakingPositions: 30, // 30 seconds - updates on stake/unstake
    liquidityPositions: 30, // 30 seconds - updates on add/remove liquidity
    rewards: 60, // 1 minute - rewards accumulate over time
    swaps: 15, // 15 seconds - swap history changes frequently
    computationalNFTs: 120, // 2 minutes - NFTs don't change often
  },
  weather: {
    stationData: 300, // 5 minutes - weather data polling
    stationQuality: 600, // 10 minutes - quality scores update less frequently
    dataConfidence: 600, // 10 minutes
    stationList: 120, // 2 minutes - station list relatively stable
  },
  carbon: {
    credit: 60, // 1 minute - credit details
    tradingHistory: 30, // 30 seconds - trades happen frequently
    priceHistory: 60, // 1 minute - price history
    marketplace: 30, // 30 seconds - marketplace listings
  },
  defi: {
    poolState: 15, // 15 seconds - AMM pools need fresh data
    yieldFarming: 30, // 30 seconds - yield changes
  },
};

/**
 * Cache-aside pattern wrapper for resolver queries
 * Fetches from cache first, falls back to database/service call
 */
export async function withCache<T>(
  cacheKey: string,
  ttlSeconds: number,
  fetcher: () => Promise<T>,
  options?: {
    policyName?: string;
    forceRefresh?: boolean;
  }
): Promise<T> {
  const startTime = Date.now();

  try {
    // Check if we should skip cache
    if (options?.forceRefresh) {
      const result = await fetcher();
      await cacheManager.set(cacheKey, result, {
        ttl: ttlSeconds * 1000,
        policyName: options?.policyName,
      });
      return result;
    }

    // Try to get from cache
    const cached = await cacheManager.get<T>(cacheKey);
    if (cached !== null) {
      const duration = Date.now() - startTime;
      logger.debug('Cache hit for resolver', {
        cacheKey,
        duration,
      });
      return cached;
    }

    // Cache miss - fetch and store
    const result = await fetcher();
    await cacheManager.set(cacheKey, result, {
      ttl: ttlSeconds * 1000,
      policyName: options?.policyName,
    });

    const duration = Date.now() - startTime;
    logger.debug('Cache miss for resolver', {
      cacheKey,
      duration,
      fetchDuration: duration,
    });

    return result;
  } catch (error) {
    logger.error('Cache error in resolver', {
      cacheKey,
      error: error instanceof Error ? error.message : String(error),
    });
    // On cache error, fallback to direct fetch
    return fetcher();
  }
}

/**
 * Invalidate cache entries by pattern
 * Used when data is mutated (e.g., new stake, trade, etc.)
 */
export async function invalidateCache(patterns: string[]): Promise<void> {
  for (const pattern of patterns) {
    try {
      await cacheManager.deletePattern(pattern);
      logger.debug('Cache invalidated', { pattern });
    } catch (error) {
      logger.error('Failed to invalidate cache', {
        pattern,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Pre-built cache wrappers for common queries

/**
 * Cache wrapper for user staking positions
 */
export async function getCachedStakingPositions<T>(
  userAddress: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return withCache(
    cacheKeys.user.stakingPositions(userAddress.toLowerCase()),
    CACHE_TTL.user.stakingPositions,
    fetcher,
    { policyName: 'yieldFarmingStats' }
  );
}

/**
 * Cache wrapper for user liquidity positions
 */
export async function getCachedLiquidityPositions<T>(
  userAddress: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return withCache(
    cacheKeys.user.liquidityPositions(userAddress.toLowerCase()),
    CACHE_TTL.user.liquidityPositions,
    fetcher,
    { policyName: 'ammPoolState' }
  );
}

/**
 * Cache wrapper for user rewards
 */
export async function getCachedRewards<T>(
  userAddress: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return withCache(
    cacheKeys.user.rewards(userAddress.toLowerCase()),
    CACHE_TTL.user.rewards,
    fetcher,
    { policyName: 'yieldFarmingStats' }
  );
}

/**
 * Cache wrapper for weather station data
 */
export async function getCachedWeatherStationData<T>(
  stationId: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return withCache(
    cacheKeys.weather.stationData(stationId),
    CACHE_TTL.weather.stationData,
    fetcher,
    { policyName: 'weatherData' }
  );
}

/**
 * Cache wrapper for weather data confidence
 */
export async function getCachedDataConfidence<T>(
  dataId: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return withCache(
    cacheKeys.weather.dataConfidence(dataId),
    CACHE_TTL.weather.dataConfidence,
    fetcher,
    { policyName: 'weatherData' }
  );
}

/**
 * Cache wrapper for carbon credit details
 */
export async function getCachedCarbonCredit<T>(
  tokenId: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return withCache(
    cacheKeys.carbon.credit(tokenId),
    CACHE_TTL.carbon.credit,
    fetcher,
    { policyName: 'carbonCredits' }
  );
}

/**
 * Cache wrapper for carbon trading history
 */
export async function getCachedTradingHistory<T>(
  tokenId: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return withCache(
    cacheKeys.carbon.tradingHistory(tokenId),
    CACHE_TTL.carbon.tradingHistory,
    fetcher,
    { policyName: 'carbonCredits' }
  );
}

/**
 * Cache wrapper for AMM pool state
 */
export async function getCachedPoolState<T>(
  poolId: string,
  fetcher: () => Promise<T>
): Promise<T> {
  return withCache(
    cacheKeys.defi.poolState(poolId),
    CACHE_TTL.defi.poolState,
    fetcher,
    { policyName: 'ammPoolState' }
  );
}

// Invalidation helpers for mutations

/**
 * Invalidate user-related caches when stake/unstake occurs
 */
export async function invalidateUserStakingCache(userAddress: string): Promise<void> {
  await invalidateCache([
    cacheKeys.user.stakingPositions(userAddress.toLowerCase()),
    cacheKeys.user.rewards(userAddress.toLowerCase()),
  ]);
}

/**
 * Invalidate user-related caches when liquidity changes
 */
export async function invalidateUserLiquidityCache(userAddress: string): Promise<void> {
  await invalidateCache([
    cacheKeys.user.liquidityPositions(userAddress.toLowerCase()),
  ]);
}

/**
 * Invalidate carbon credit caches when trade occurs
 */
export async function invalidateCarbonCreditCache(tokenId: string): Promise<void> {
  await invalidateCache([
    cacheKeys.carbon.credit(tokenId),
    cacheKeys.carbon.tradingHistory(tokenId),
    cacheKeys.carbon.priceHistory(tokenId),
    `carbon:marketplace:*`, // Invalidate all marketplace listings
  ]);
}

/**
 * Invalidate weather station caches when data is submitted
 */
export async function invalidateWeatherCache(stationId: string): Promise<void> {
  await invalidateCache([
    cacheKeys.weather.stationData(stationId),
    cacheKeys.weather.stationQuality(stationId),
    `weather:stations:*`, // Invalidate station lists
  ]);
}

export { CACHE_TTL };
