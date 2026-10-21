/**
 * DataLoader Implementation for GraphQL Resolvers
 * Provides batching and caching for efficient data loading
 */

import DataLoader from 'dataloader';
import { inArray } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { GraphQLContext } from './context.js';
import { ServiceDataLoader } from './services/service-registry.js';
import {
  carbonCredits,
  stakingDeposits,
  stakingRewards,
  liquidityPositions,
  carbonTrades,
  weatherDataQuality,
} from '../shared/schema.js';

// Weather Station DataLoader
export function createWeatherStationLoader(
  context: GraphQLContext
): DataLoader<string, any> {
  return new DataLoader(
    async (stationIds: readonly string[]) => {
      try {
        // Use service data loader for batched requests
        const stations = await ServiceDataLoader.batchLoad<any>(
          'iot',
          '/api/stations/batch',
          [...stationIds],
          ids => ({ stationIds: ids })
        );

        // Ensure ordering matches input
        const stationMap = new Map(
          stations.map(station => [station.stationId, station])
        );
        return stationIds.map(id => stationMap.get(id) || null);
      } catch (error) {
        logger.error('Weather station batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          stationIds: [...stationIds],
          requestId: context.requestId,
        });
        return stationIds.map(() => null);
      }
    },
    {
      maxBatchSize: 100,
      cache: true,
      cacheKeyFn: key => `weather_station:${key}`,
    }
  );
}

// Vote DataLoader
export function createVoteLoader(
  context: GraphQLContext
): DataLoader<string, any> {
  return new DataLoader(
    async (voteIds: readonly string[]) => {
      try {
        const votes = await ServiceDataLoader.batchLoad<any>(
          'governance',
          '/api/votes/batch',
          [...voteIds],
          ids => ({ voteIds: ids })
        );

        const voteMap = new Map(votes.map(vote => [vote.id.toString(), vote]));
        return voteIds.map(id => voteMap.get(id) || null);
      } catch (error) {
        logger.error('Vote batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          voteIds: [...voteIds],
          requestId: context.requestId,
        });
        return voteIds.map(() => null);
      }
    },
    {
      maxBatchSize: 50,
      cache: true,
      cacheKeyFn: key => `vote:${key}`,
    }
  );
}

// Proposal DataLoader
export function createProposalLoader(
  context: GraphQLContext
): DataLoader<string, any> {
  return new DataLoader(
    async (proposalIds: readonly string[]) => {
      try {
        const proposals = await ServiceDataLoader.batchLoad<any>(
          'governance',
          '/api/proposals/batch',
          [...proposalIds],
          ids => ({ proposalIds: ids })
        );

        const proposalMap = new Map(
          proposals.map(proposal => [proposal.id.toString(), proposal])
        );
        return proposalIds.map(id => proposalMap.get(id) || null);
      } catch (error) {
        logger.error('Proposal batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          proposalIds: [...proposalIds],
          requestId: context.requestId,
        });
        return proposalIds.map(() => null);
      }
    },
    {
      maxBatchSize: 50,
      cache: true,
      cacheKeyFn: key => `proposal:${key}`,
    }
  );
}

// Token Balance DataLoader
export function createTokenBalanceLoader(
  context: GraphQLContext
): DataLoader<string, any> {
  return new DataLoader(
    async (addresses: readonly string[]) => {
      try {
        // Parallel calls to multiple services for comprehensive balance data
        const [contractBalances, walletServiceData] = await Promise.allSettled([
          // Batch contract calls
          Promise.all(
            [...addresses].map(address =>
              context.contracts.wrfToken.balanceOf(address).catch(() => '0')
            )
          ),
          // Wallet service batch request
          ServiceDataLoader.batchLoad<any>(
            'wallet',
            '/api/balances/batch',
            [...addresses],
            addrs => ({ addresses: addrs })
          ),
        ]);

        // Process contract balances
        const contractResults =
          contractBalances.status === 'fulfilled'
            ? contractBalances.value
            : [...addresses].map(() => '0');

        // Process wallet service data
        let walletData: any[] = [];
        if (walletServiceData.status === 'fulfilled') {
          walletData = walletServiceData.value;
        }

        const walletDataMap = new Map(
          walletData.map(data => [data.address, data])
        );

        return addresses.map((address, index) => {
          const balance = contractResults[index]?.toString() || '0';
          const walletInfo = walletDataMap.get(address) || {};

          return {
            address,
            balance,
            pendingRewards: walletInfo.pendingRewards || '0',
            lastUpdate: walletInfo.lastUpdate || new Date().toISOString(),
          };
        });
      } catch (error) {
        logger.error('Token balance batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          addresses: [...addresses],
          requestId: context.requestId,
        });
        return addresses.map(address => ({
          address,
          balance: '0',
          pendingRewards: '0',
          lastUpdate: new Date().toISOString(),
        }));
      }
    },
    {
      maxBatchSize: 100,
      cache: true,
      cacheKeyFn: key => `token_balance:${key}`,
    }
  );
}

// Cross-Chain Transfer DataLoader
export function createCrossChainTransferLoader(
  context: GraphQLContext
): DataLoader<string, any> {
  return new DataLoader(
    async (transferIds: readonly string[]) => {
      try {
        const transfers = await ServiceDataLoader.batchLoad<any>(
          'crossChain',
          '/api/transfers/batch',
          [...transferIds],
          ids => ({ transferIds: ids })
        );

        const transferMap = new Map(
          transfers.map(transfer => [transfer.id.toString(), transfer])
        );
        return transferIds.map(id => transferMap.get(id) || null);
      } catch (error) {
        logger.error('Cross-chain transfer batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          transferIds: [...transferIds],
          requestId: context.requestId,
        });
        return transferIds.map(() => null);
      }
    },
    {
      maxBatchSize: 50,
      cache: true,
      cacheKeyFn: key => `cross_chain_transfer:${key}`,
    }
  );
}

// Compute Job DataLoader
export function createComputeJobLoader(
  context: GraphQLContext
): DataLoader<string, any> {
  return new DataLoader(
    async (jobIds: readonly string[]) => {
      try {
        const jobs = await ServiceDataLoader.batchLoad<any>(
          'compute',
          '/api/jobs/batch',
          [...jobIds],
          ids => ({ jobIds: ids })
        );

        const jobMap = new Map(jobs.map(job => [job.id.toString(), job]));
        return jobIds.map(id => jobMap.get(id) || null);
      } catch (error) {
        logger.error('Compute job batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          jobIds: [...jobIds],
          requestId: context.requestId,
        });
        return jobIds.map(() => null);
      }
    },
    {
      maxBatchSize: 50,
      cache: true,
      cacheKeyFn: key => `compute_job:${key}`,
    }
  );
}

// AI/ML Model DataLoader
export function createAIModelLoader(
  context: GraphQLContext
): DataLoader<string, any> {
  return new DataLoader(
    async (modelIds: readonly string[]) => {
      try {
        const models = await ServiceDataLoader.batchLoad<any>(
          'aiml',
          '/api/models/batch',
          [...modelIds],
          ids => ({ modelIds: ids })
        );

        const modelMap = new Map(
          models.map(model => [model.id.toString(), model])
        );
        return modelIds.map(id => modelMap.get(id) || null);
      } catch (error) {
        logger.error('AI model batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          modelIds: [...modelIds],
          requestId: context.requestId,
        });
        return modelIds.map(() => null);
      }
    },
    {
      maxBatchSize: 25,
      cache: true,
      cacheKeyFn: key => `ai_model:${key}`,
    }
  );
}

// Storage Node DataLoader
export function createStorageNodeLoader(
  context: GraphQLContext
): DataLoader<string, any> {
  return new DataLoader(
    async (nodeIds: readonly string[]) => {
      try {
        const nodes = await ServiceDataLoader.batchLoad<any>(
          'storage',
          '/api/nodes/batch',
          [...nodeIds],
          ids => ({ nodeIds: ids })
        );

        const nodeMap = new Map(nodes.map(node => [node.id.toString(), node]));
        return nodeIds.map(id => nodeMap.get(id) || null);
      } catch (error) {
        logger.error('Storage node batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          nodeIds: [...nodeIds],
          requestId: context.requestId,
        });
        return nodeIds.map(() => null);
      }
    },
    {
      maxBatchSize: 30,
      cache: true,
      cacheKeyFn: key => `storage_node:${key}`,
    }
  );
}

// Carbon Credits DataLoader
export function createCarbonCreditsLoader(
  context: GraphQLContext
): DataLoader<string, any> {
  return new DataLoader(
    async (creditIds: readonly string[]) => {
      try {
        // Query carbon credits from database (id is UUID/string type)
        const credits = await context.db
          .select()
          .from(carbonCredits)
          .where(inArray(carbonCredits.id, [...creditIds]));

        // Create map for ordered results
        const creditMap = new Map(
          credits.map(credit => [credit.id, credit])
        );
        return creditIds.map(id => creditMap.get(id) || null);
      } catch (error) {
        logger.error('Carbon credits batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          creditIds: [...creditIds],
          requestId: context.requestId,
        });
        return creditIds.map(() => null);
      }
    },
    {
      maxBatchSize: 100,
      cache: true,
      cacheKeyFn: key => `carbon_credit:${key}`,
    }
  );
}

// Carbon Credits by Owner DataLoader
export function createCarbonCreditsByOwnerLoader(
  context: GraphQLContext
): DataLoader<string, any[]> {
  return new DataLoader(
    async (ownerAddresses: readonly string[]) => {
      try {
        // Query carbon credits by owner addresses
        const credits = await context.db
          .select()
          .from(carbonCredits)
          .where(inArray(carbonCredits.owner, [...ownerAddresses]));

        // Group by owner
        const creditsByOwner = new Map<string, any[]>();
        for (const credit of credits) {
          const ownerCredits = creditsByOwner.get(credit.owner) || [];
          ownerCredits.push(credit);
          creditsByOwner.set(credit.owner, ownerCredits);
        }

        return ownerAddresses.map(addr => creditsByOwner.get(addr) || []);
      } catch (error) {
        logger.error('Carbon credits by owner batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          ownerAddresses: [...ownerAddresses],
          requestId: context.requestId,
        });
        return ownerAddresses.map(() => []);
      }
    },
    {
      maxBatchSize: 50,
      cache: true,
      cacheKeyFn: key => `carbon_credits_owner:${key}`,
    }
  );
}

// Staking Positions DataLoader (by user ID)
export function createStakingPositionsLoader(
  context: GraphQLContext
): DataLoader<string, any[]> {
  return new DataLoader(
    async (userIds: readonly string[]) => {
      try {
        const positions = await context.db
          .select()
          .from(stakingDeposits)
          .where(inArray(stakingDeposits.userId, [...userIds]));

        // Group by user
        const positionsByUser = new Map<string, any[]>();
        for (const position of positions) {
          const userPositions = positionsByUser.get(position.userId) || [];
          userPositions.push(position);
          positionsByUser.set(position.userId, userPositions);
        }

        return userIds.map(id => positionsByUser.get(id) || []);
      } catch (error) {
        logger.error('Staking positions batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          userIds: [...userIds],
          requestId: context.requestId,
        });
        return userIds.map(() => []);
      }
    },
    {
      maxBatchSize: 50,
      cache: true,
      cacheKeyFn: key => `staking_positions:${key}`,
    }
  );
}

// Staking Rewards DataLoader (by staker ID)
export function createStakingRewardsLoader(
  context: GraphQLContext
): DataLoader<string, any[]> {
  return new DataLoader(
    async (stakerIds: readonly string[]) => {
      try {
        const rewards = await context.db
          .select()
          .from(stakingRewards)
          .where(inArray(stakingRewards.stakerId, [...stakerIds]));

        // Group by staker
        const rewardsByStaker = new Map<string, any[]>();
        for (const reward of rewards) {
          const stakerRewards = rewardsByStaker.get(reward.stakerId) || [];
          stakerRewards.push(reward);
          rewardsByStaker.set(reward.stakerId, stakerRewards);
        }

        return stakerIds.map(id => rewardsByStaker.get(id) || []);
      } catch (error) {
        logger.error('Staking rewards batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          stakerIds: [...stakerIds],
          requestId: context.requestId,
        });
        return stakerIds.map(() => []);
      }
    },
    {
      maxBatchSize: 50,
      cache: true,
      cacheKeyFn: key => `staking_rewards:${key}`,
    }
  );
}

// Liquidity Positions DataLoader (by user ID)
export function createLiquidityPositionsLoader(
  context: GraphQLContext
): DataLoader<string, any[]> {
  return new DataLoader(
    async (userIds: readonly string[]) => {
      try {
        const positions = await context.db
          .select()
          .from(liquidityPositions)
          .where(inArray(liquidityPositions.userId, [...userIds]));

        // Group by user
        const positionsByUser = new Map<string, any[]>();
        for (const position of positions) {
          const userPositions = positionsByUser.get(position.userId) || [];
          userPositions.push(position);
          positionsByUser.set(position.userId, userPositions);
        }

        return userIds.map(id => positionsByUser.get(id) || []);
      } catch (error) {
        logger.error('Liquidity positions batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          userIds: [...userIds],
          requestId: context.requestId,
        });
        return userIds.map(() => []);
      }
    },
    {
      maxBatchSize: 50,
      cache: true,
      cacheKeyFn: key => `liquidity_positions:${key}`,
    }
  );
}

// Carbon Trades DataLoader (by credit ID)
export function createCarbonTradesLoader(
  context: GraphQLContext
): DataLoader<string, any[]> {
  return new DataLoader(
    async (creditIds: readonly string[]) => {
      try {
        const trades = await context.db
          .select()
          .from(carbonTrades)
          .where(inArray(carbonTrades.creditId, [...creditIds]));

        // Group by credit
        const tradesByCredit = new Map<string, any[]>();
        for (const trade of trades) {
          const creditTrades = tradesByCredit.get(trade.creditId) || [];
          creditTrades.push(trade);
          tradesByCredit.set(trade.creditId, creditTrades);
        }

        return creditIds.map(id => tradesByCredit.get(id) || []);
      } catch (error) {
        logger.error('Carbon trades batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          creditIds: [...creditIds],
          requestId: context.requestId,
        });
        return creditIds.map(() => []);
      }
    },
    {
      maxBatchSize: 100,
      cache: true,
      cacheKeyFn: key => `carbon_trades:${key}`,
    }
  );
}

// Quality Score DataLoader (RPC call deduplication via DataLoader caching)
export function createQualityScoreLoader(
  context: GraphQLContext
): DataLoader<string, number> {
  return new DataLoader(
    async (stationIds: readonly string[]) => {
      const scores = await Promise.all(
        stationIds.map(id =>
          context.contracts.weatherOracle.getDataQualityScore(id)
        )
      );
      return scores.map(s => Number(s));
    },
    {
      cache: true,
      maxBatchSize: 50,
      cacheKeyFn: key => `quality_score:${key}`,
    }
  );
}

// Weather Data Quality DataLoader (by station ID)
export function createWeatherDataQualityLoader(
  context: GraphQLContext
): DataLoader<string, any[]> {
  return new DataLoader(
    async (stationIds: readonly string[]) => {
      try {
        const qualityData = await context.db
          .select()
          .from(weatherDataQuality)
          .where(inArray(weatherDataQuality.stationId, [...stationIds]));

        // Group by station
        const qualityByStation = new Map<string, any[]>();
        for (const quality of qualityData) {
          const stationQuality = qualityByStation.get(quality.stationId) || [];
          stationQuality.push(quality);
          qualityByStation.set(quality.stationId, stationQuality);
        }

        return stationIds.map(id => qualityByStation.get(id) || []);
      } catch (error) {
        logger.error('Weather data quality batch load failed', {
          error: error instanceof Error ? error.message : String(error),
          stationIds: [...stationIds],
          requestId: context.requestId,
        });
        return stationIds.map(() => []);
      }
    },
    {
      maxBatchSize: 50,
      cache: true,
      cacheKeyFn: key => `weather_data_quality:${key}`,
    }
  );
}

// DataLoader Factory
export interface DataLoaders {
  weatherStations: DataLoader<string, any>;
  votes: DataLoader<string, any>;
  proposals: DataLoader<string, any>;
  tokenBalances: DataLoader<string, any>;
  crossChainTransfers: DataLoader<string, any>;
  computeJobs: DataLoader<string, any>;
  aiModels: DataLoader<string, any>;
  storageNodes: DataLoader<string, any>;
  carbonCredits: DataLoader<string, any>;
  carbonCreditsByOwner: DataLoader<string, any[]>;
  // New DataLoaders for Task 82
  stakingPositions: DataLoader<string, any[]>;
  stakingRewards: DataLoader<string, any[]>;
  liquidityPositions: DataLoader<string, any[]>;
  carbonTrades: DataLoader<string, any[]>;
  weatherDataQuality: DataLoader<string, any[]>;
  qualityScores: DataLoader<string, number>;
}

export function createDataLoaders(context: GraphQLContext): DataLoaders {
  return {
    weatherStations: createWeatherStationLoader(context),
    votes: createVoteLoader(context),
    proposals: createProposalLoader(context),
    tokenBalances: createTokenBalanceLoader(context),
    crossChainTransfers: createCrossChainTransferLoader(context),
    computeJobs: createComputeJobLoader(context),
    aiModels: createAIModelLoader(context),
    storageNodes: createStorageNodeLoader(context),
    carbonCredits: createCarbonCreditsLoader(context),
    carbonCreditsByOwner: createCarbonCreditsByOwnerLoader(context),
    // New DataLoaders for Task 82
    stakingPositions: createStakingPositionsLoader(context),
    stakingRewards: createStakingRewardsLoader(context),
    liquidityPositions: createLiquidityPositionsLoader(context),
    carbonTrades: createCarbonTradesLoader(context),
    weatherDataQuality: createWeatherDataQualityLoader(context),
    qualityScores: createQualityScoreLoader(context),
  };
}

// Performance monitoring decorator for DataLoaders
export function withDataLoaderMonitoring<K, V>(
  loader: DataLoader<K, V>,
  loaderName: string
): DataLoader<K, V> {
  const originalLoad = loader.load.bind(loader);
  const originalLoadMany = loader.loadMany.bind(loader);

  loader.load = async (key: K): Promise<V> => {
    const startTime = Date.now();
    try {
      const result = await originalLoad(key);
      const duration = Date.now() - startTime;

      logger.debug('DataLoader load completed', {
        loader: loaderName,
        key: String(key),
        duration,
        cacheHit: false, // Note: cacheMap not publicly accessible in DataLoader
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('DataLoader load failed', {
        loader: loaderName,
        key: String(key),
        duration,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  loader.loadMany = async (keys: readonly K[]): Promise<Array<V | Error>> => {
    const startTime = Date.now();
    try {
      const results = await originalLoadMany(keys);
      const duration = Date.now() - startTime;

      logger.debug('DataLoader loadMany completed', {
        loader: loaderName,
        keyCount: keys.length,
        duration,
        batchSize: keys.length,
      });

      return results;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('DataLoader loadMany failed', {
        loader: loaderName,
        keyCount: keys.length,
        duration,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  return loader;
}

// Cache warming utility
export async function warmDataLoaderCaches(
  loaders: DataLoaders,
  context: GraphQLContext
): Promise<void> {
  try {
    // Pre-load frequently accessed data
    const [recentProposals, activeStations] = await Promise.allSettled([
      // Pre-load recent proposals
      context.services.governance.get('/api/proposals/recent?limit=10'),
      // Pre-load active weather stations
      context.services.iot.get('/api/stations/active?limit=20'),
    ]);

    // Warm proposal cache
    if (
      recentProposals.status === 'fulfilled' &&
      recentProposals.value.success
    ) {
      const proposalIds = (recentProposals.value.data as any[]).map((p: any) =>
        p.id.toString()
      );
      if (proposalIds.length > 0) {
        await loaders.proposals.loadMany(proposalIds);
      }
    }

    // Warm weather station cache
    if (activeStations.status === 'fulfilled' && activeStations.value.success) {
      const stationIds = (activeStations.value.data as any[]).map(
        (s: any) => s.stationId
      );
      if (stationIds.length > 0) {
        await loaders.weatherStations.loadMany(stationIds);
      }
    }

    logger.debug('DataLoader caches warmed', {
      requestId: context.requestId,
    });
  } catch (error) {
    logger.warn('Failed to warm DataLoader caches', {
      error: error instanceof Error ? error.message : String(error),
      requestId: context.requestId,
    });
  }
}
