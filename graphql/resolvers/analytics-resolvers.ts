/**
 * Analytics GraphQL Resolvers
 * Handles platform analytics, metrics, and statistical data
 */

import { ethers } from 'ethers';
import { createHash } from 'crypto';
import { GraphQLContext } from '../context.js';
import { logger } from '../../utils/logger.js';
import { formatError } from '../error-handler.js';
import { eq, gte, desc, asc, and, or, sql } from 'drizzle-orm';
import { cacheManager } from '../../server/cache/cache-manager.js';
import {
  users,
  weatherData,
  weatherForecasts,
  validators,
  nfts,
  transactions,
  blocks,
  computationalNfts,
  computationalTasks,
  proposals,
  votes,
} from '../../shared/schema.js';

const DEFAULT_PLATFORM_ANALYTICS_TTL_MS = 60_000;
const DEFAULT_WEATHER_ANALYTICS_TTL_MS = 30_000;

function resolveCacheTtlMs(envVar: string, fallbackMs: number): number {
  const raw = process.env[envVar];
  if (!raw) {
    return fallbackMs;
  }

  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

function buildHashedCacheKey(
  scope: string,
  params: Record<string, unknown>
): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(params))
    .digest('hex');
  return `${scope}:${digest}`;
}

export const analyticsResolvers = {
  Query: {
    // Get platform analytics overview
    platformAnalytics: async (
      _: any,
      { timeframe = 'month' }: { timeframe?: string },
      context: GraphQLContext
    ) => {
      try {
        const cacheKey = buildHashedCacheKey('graphql:analytics:platform', {
          timeframe: timeframe.toLowerCase(),
        });
        const cacheTtlMs = resolveCacheTtlMs(
          'GRAPHQL_PLATFORM_ANALYTICS_TTL_MS',
          DEFAULT_PLATFORM_ANALYTICS_TTL_MS
        );
        return await cacheManager.getOrSet(
          cacheKey,
          async () => {
            const timeframeDays = getTimeframeDays(timeframe);
            const startDate = new Date(
              Date.now() - timeframeDays * 24 * 60 * 60 * 1000
            );

            const countAll = sql<number>`cast(count(*) as int)`;

            const [
              [{ count: totalUsers }],
              [{ count: activeUsers }],
              [{ count: totalWeatherData }],
              [{ count: totalWeatherForecasts }],
              [{ count: totalNFTs }],
              [{ count: totalValidators }],
              [{ count: totalTransactions }],
              [{ count: totalComputationalNFTs }],
              [{ count: completedJobs }],
              [{ count: totalProposals }],
              [{ count: activeProposals }],
              [{ count: totalVotes }],
              [{ count: totalBlocks }],
              [{ count: totalBlocksInPeriod }],
            ] = await Promise.all([
              context.db.select({ count: countAll }).from(users),
              context.db.select({ count: countAll }).from(users).where(gte(users.lastLogin, startDate)),
              context.db.select({ count: countAll }).from(weatherData),
              context.db
                .select({ count: countAll })
                .from(weatherForecasts)
                .where(gte(weatherForecasts.generatedAt, startDate)),
              context.db.select({ count: countAll }).from(nfts),
              context.db.select({ count: countAll }).from(validators),
              context.db.select({ count: countAll }).from(transactions).where(gte(transactions.timestamp, startDate)),
              context.db.select({ count: countAll }).from(computationalNfts),
              context.db.select({ count: countAll }).from(computationalTasks).where(eq(computationalTasks.status, 'COMPLETED')),
              context.db.select({ count: countAll }).from(proposals),
              context.db.select({ count: countAll }).from(proposals).where(eq(proposals.status, 'VOTING')),
              context.db.select({ count: countAll }).from(votes).where(gte(votes.timestamp, startDate)),
              context.db.select({ count: countAll }).from(blocks),
              context.db.select({ count: countAll }).from(blocks).where(gte(blocks.timestamp, startDate)),
            ]);

            // Get token statistics
            const totalSupply = await context.contracts.wrfToken.totalSupply();
            const maxSupply = await context.contracts.wrfToken.MAX_SUPPLY();

            return {
              timeframe,
              totalUsers,
              activeUsers,
              totalWeatherData,
              totalWeatherForecasts,
              totalNFTs,
              totalValidators,
              totalTransactions,
              totalComputationalNFTs,
              completedJobs,
              totalProposals,
              activeProposals,
              totalVotes,
              totalBlocks,
              totalBlocksInPeriod,
              tokenSupply: totalSupply.toString(),
              maxTokenSupply: maxSupply.toString(),
              supplyUtilization: (
                (Number(totalSupply) / Number(maxSupply)) *
                100
              ).toFixed(2),
            };
          },
          { ttl: cacheTtlMs, policyName: 'graphqlQuery' }
        );
      } catch (error) {
        logger.error('Error fetching platform analytics', {
          timeframe,
          error: error instanceof Error ? error.message : 'Unknown error',
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'PLATFORM_ANALYTICS_ERROR',
        });
      }
    },

    // Get ZK statistics
    zkStats: async (_: any, __: any, context: GraphQLContext) => {
      try {
        return await context.blockchainAdapter.getZkStats();
      } catch (error) {
        logger.error('Error fetching ZK stats', {
          error: error instanceof Error ? error.message : 'Unknown error',
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'ZK_STATS_ERROR',
        });
      }
    },

    // Get weather analytics
    weatherAnalytics: async (
      _: any,
      {
        timeframe = 'month',
        stationId,
      }: {
        timeframe?: string;
        stationId?: string;
      },
      context: GraphQLContext
    ) => {
      try {
        const cacheKey = buildHashedCacheKey('graphql:analytics:weather', {
          timeframe: timeframe.toLowerCase(),
          stationId: stationId ? stationId.toLowerCase() : null,
        });
        const cacheTtlMs = resolveCacheTtlMs(
          'GRAPHQL_WEATHER_ANALYTICS_TTL_MS',
          DEFAULT_WEATHER_ANALYTICS_TTL_MS
        );
        return await cacheManager.getOrSet(
          cacheKey,
          async () => {
            const timeframeDays = getTimeframeDays(timeframe);
            const startDate = new Date(
              Date.now() - timeframeDays * 24 * 60 * 60 * 1000
            );

            const queryConditions = [gte(weatherData.timestamp, startDate)];
            if (stationId) {
              queryConditions.push(eq(weatherData.stationId, stationId));
            }
            const whereClause = and(...queryConditions);

            const numericWeatherValue = (column: any) =>
              sql<number>`nullif(trim(${column}), '')::double precision`;
            const dailyBucket = sql<string>`to_char(date_trunc('day', ${weatherData.timestamp}), 'YYYY-MM-DD')`;

            const [summaryRows, dailyRows] = await Promise.all([
              context.db
                .select({
                  totalDataPoints: sql<number>`cast(count(*) as int)`,
                  avgTemperature: sql<number>`coalesce(avg(${numericWeatherValue(
                    weatherData.temperature
                  )}), 0)`,
                  avgHumidity: sql<number>`coalesce(avg(${numericWeatherValue(
                    weatherData.humidity
                  )}), 0)`,
                  avgPressure: sql<number>`coalesce(avg(${numericWeatherValue(
                    weatherData.pressure
                  )}), 0)`,
                })
                .from(weatherData)
                .where(whereClause),
              context.db
                .select({
                  date: dailyBucket,
                  dataPoints: sql<number>`cast(count(*) as int)`,
                  avgTemperature: sql<number>`coalesce(avg(${numericWeatherValue(
                    weatherData.temperature
                  )}), 0)`,
                  avgHumidity: sql<number>`coalesce(avg(${numericWeatherValue(
                    weatherData.humidity
                  )}), 0)`,
                  avgPressure: sql<number>`coalesce(avg(${numericWeatherValue(
                    weatherData.pressure
                  )}), 0)`,
                })
                .from(weatherData)
                .where(whereClause)
                .groupBy(dailyBucket)
                .orderBy(asc(dailyBucket)),
            ]);

            const summary = summaryRows[0];
            const totalDataPoints = Number(summary?.totalDataPoints ?? 0);
            const avgTemperature = Number(summary?.avgTemperature ?? 0);
            const avgHumidity = Number(summary?.avgHumidity ?? 0);
            const avgPressure = Number(summary?.avgPressure ?? 0);
            const avgConfidence = totalDataPoints > 0 ? '90.00' : '0.00';
            const dailyData = dailyRows.map(row => ({
              date: row.date,
              dataPoints: row.dataPoints,
              avgTemperature: Number(row.avgTemperature ?? 0).toFixed(2),
              avgHumidity: Number(row.avgHumidity ?? 0).toFixed(2),
              avgPressure: Number(row.avgPressure ?? 0).toFixed(2),
              avgConfidence,
            }));

            return {
              timeframe,
              stationId,
              totalDataPoints,
              avgTemperature: avgTemperature.toFixed(2),
              avgHumidity: avgHumidity.toFixed(2),
              avgPressure: avgPressure.toFixed(2),
              avgConfidence,
              dailyData,
            };
          },
          { ttl: cacheTtlMs, policyName: 'graphqlQuery' }
        );
      } catch (error) {
        logger.error('Error fetching weather analytics', {
          timeframe,
          stationId,
          error: error instanceof Error ? error.message : 'Unknown error',
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'WEATHER_ANALYTICS_ERROR',
        });
      }
    },

    // Get carbon analytics
    carbonAnalytics: async (
      _: any,
      { timeframe = 'month' }: { timeframe?: string },
      context: GraphQLContext
    ) => {
      try {
        const timeframeDays = getTimeframeDays(timeframe);
        const startDate = new Date(
          Date.now() - timeframeDays * 24 * 60 * 60 * 1000
        );

        // Get NFTs created in timeframe
        const nftsCreated = await context.db.query.nfts.findMany({
          where: gte(nfts.createdAt, startDate),
        });

        // Get computational NFTs created in timeframe
        const computationalNftsCreated =
          await context.db.query.computationalNfts.findMany({
            where: gte(computationalNfts.createdAt, startDate),
          });

        // Calculate statistics
        const totalNftsCreated = nftsCreated.length;
        const totalComputationalNftsCreated = computationalNftsCreated.length;

        // Group by NFT type
        const nftTypeBreakdown = nftsCreated.reduce(
          (acc, nft) => {
            acc[nft.nftType] = (acc[nft.nftType] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );

        // Group computational NFTs by type
        const computationalTypeBreakdown = computationalNftsCreated.reduce(
          (acc, nft) => {
            acc[nft.computationType || 'unknown'] =
              (acc[nft.computationType || 'unknown'] || 0) + 1;
            return acc;
          },
          {} as Record<string, number>
        );

        return {
          timeframe,
          totalNftsCreated,
          totalComputationalNftsCreated,
          nftTypeBreakdown: Object.entries(nftTypeBreakdown).map(
            ([type, count]) => ({
              nftType: type,
              count: count.toString(),
            })
          ),
          computationalTypeBreakdown: Object.entries(
            computationalTypeBreakdown
          ).map(([type, count]) => ({
            computationType: type,
            count: count.toString(),
          })),
        };
      } catch (error) {
        logger.error('Error fetching carbon analytics', {
          timeframe,
          error: error instanceof Error ? error.message : 'Unknown error',
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'CARBON_ANALYTICS_ERROR',
        });
      }
    },

    // Get trading analytics (commented out - not in schema)
    /*
    tradingAnalytics: async (
      _: any,
      { timeframe = 'month' }: { timeframe?: string },
      context: GraphQLContext
    ) => {
      try {
        const timeframeDays = getTimeframeDays(timeframe);
        const startDate = new Date(Date.now() - timeframeDays * 24 * 60 * 60 * 1000);

        const periodTransactions = await context.db.query.transactions.findMany({
          where: and(
            gte(transactions.timestamp, startDate),
            eq(transactions.status, 'confirmed')
          ),
          orderBy: asc(transactions.timestamp),
        });

        // Calculate statistics
        const totalTransactions = periodTransactions.length;
        const totalVolume = periodTransactions.reduce((sum, tx) => sum + tx.amount, 0);
        const totalFees = periodTransactions.reduce((sum, tx) => sum + tx.fee, 0);

        // Calculate average transaction size
        const avgTransactionSize = totalTransactions > 0 ? totalVolume / totalTransactions : 0;

        // Get unique addresses
        const uniqueAddresses = new Set([
          ...periodTransactions.map(tx => tx.fromAddress),
          ...periodTransactions.map(tx => tx.toAddress)
        ]).size;

        return {
          timeframe,
          totalTransactions,
          totalVolume: totalVolume.toString(),
          totalFees: totalFees.toString(),
          avgTransactionSize: avgTransactionSize.toString(),
          uniqueAddresses,
        };
      } catch (error) {
        logger.error('Error fetching trading analytics', {
          timeframe,
          error: error instanceof Error ? error.message : 'Unknown error',
          requestId: context.requestId
        });
        throw formatError(error, { requestId: context.requestId, operationType: 'TRADING_ANALYTICS_ERROR' });
      }
    },
    */

    // Get governance analytics (commented out - not in schema)
    /*
    governanceAnalytics: async (
      _: any,
      { timeframe = 'month' }: { timeframe?: string },
      context: GraphQLContext
    ) => {
      try {
        const timeframeDays = getTimeframeDays(timeframe);
        const startDate = new Date(Date.now() - timeframeDays * 24 * 60 * 60 * 1000);

        const [proposalsList, votesList] = await Promise.all([
          context.db.query.proposals.findMany({
            where: gte(proposals.submitTime, startDate),
          }),
          context.db.query.votes.findMany({
            where: gte(votes.timestamp, startDate),
          }),
        ]);

        // Calculate statistics
        const totalProposals = proposalsList.length;
        const totalVotes = votesList.length;
        const uniqueVoters = new Set(votesList.map(vote => vote.voter)).size;

        // Group by proposal status
        const proposalsByStatus = proposalsList.reduce((acc, proposal) => {
          acc[proposal.status] = (acc[proposal.status] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);

        // Group by proposal type
        const proposalsByType = proposalsList.reduce((acc, proposal) => {
          acc[proposal.proposalType] = (acc[proposal.proposalType] || 0) + 1;
          return acc;
        }, {} as Record<string, number>);

        // Calculate average participation
        const avgParticipation = proposalsList.length > 0 ?
          proposalsList.reduce((sum, proposal) => {
            const proposalVotes = votesList.filter(v => v.proposalId === proposal.id).length;
            return sum + proposalVotes;
          }, 0) / proposalsList.length : 0;

        return {
          timeframe,
          totalProposals,
          totalVotes,
          uniqueVoters,
          avgParticipation: avgParticipation.toString(),
          proposalsByStatus: Object.entries(proposalsByStatus).map(([status, count]) => ({
            status,
            count,
          })),
          proposalsByType: Object.entries(proposalsByType).map(([type, count]) => ({
            proposalType: type,
            count,
          })),
        };
      } catch (error) {
        logger.error('Error fetching governance analytics', {
          timeframe,
          error: error instanceof Error ? error.message : 'Unknown error',
          requestId: context.requestId
        });
        throw formatError(error, { requestId: context.requestId, operationType: 'GOVERNANCE_ANALYTICS_ERROR' });
      }
    },
    */
  },
};

// Helper functions
function getTimeframeDays(timeframe: string): number {
  switch (timeframe) {
    case 'day':
      return 1;
    case 'week':
      return 7;
    case 'month':
      return 30;
    case 'quarter':
      return 90;
    case 'year':
      return 365;
    default:
      return 30;
  }
}

function groupSwapsByDay(swaps: any[]): any[] {
  const grouped = swaps.reduce(
    (acc, swap) => {
      const day = swap.timestamp.toISOString().split('T')[0];
      if (!acc[day]) {
        acc[day] = {
          date: day,
          volume: 0,
          swapCount: 0,
          fees: 0,
        };
      }
      acc[day].volume += parseFloat(swap.amountIn);
      acc[day].swapCount += 1;
      acc[day].fees += parseFloat(swap.fee);
      return acc;
    },
    {} as Record<string, any>
  );

  return Object.values(grouped).map((day: any) => ({
    date: day.date,
    volume: day.volume.toString(),
    swapCount: day.swapCount,
    fees: day.fees.toString(),
  }));
}
