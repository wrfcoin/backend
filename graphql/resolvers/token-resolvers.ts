/**
 * WRF Token GraphQL Resolvers
 * Handles WRF token operations, balances, and governance features
 */

import { ethers } from 'ethers';
import { eq, desc } from 'drizzle-orm';
import { GraphQLContext } from '../context.js';
import { logger } from '../../utils/logger.js';
import {
  formatError,
  withRetry,
  withPerformanceMonitoring,
  timeoutError,
} from '../error-handler.js';
import { weatherStations, votes, proposals } from '../../shared/schema.js';
import { Vote, Proposal } from '../../shared/governance-schema.js';
import { ServiceDataLoader } from '../services/service-registry.js';

export const tokenResolvers = {
  Query: {
    // Get WRF token information with enhanced service integration
    wrfToken: withPerformanceMonitoring(
      'wrfToken',
      async (_: any, __: any, context: GraphQLContext) => {
        try {
          const errorContext = {
            requestId: context.requestId,
            operationType: 'wrfToken',
            clientIP: context.clientIP,
          };

          // Parallel service calls for improved performance
          const [contractData, walletServiceData, governanceData] =
            await Promise.allSettled([
              // Blockchain contract data
              withRetry(
                () =>
                  Promise.all([
                    context.contracts.wrfToken.symbol(),
                    context.contracts.wrfToken.name(),
                    context.contracts.wrfToken.decimals(),
                    context.contracts.wrfToken.totalSupply(),
                    context.contracts.wrfToken.MAX_SUPPLY(),
                    context.contracts.wrfToken.paused(),
                    context.contracts.wrfToken.WEATHER_REWARD_RATE(),
                  ]),
                3,
                1000,
                errorContext
              ),
              // Wallet service data
              context.services.wallet.get('/api/token/wrf/stats'),
              // Governance service data
              context.services.governance.get('/api/token/governance-stats'),
            ]);

          // Process contract data
          if (contractData.status === 'rejected') {
            throw new Error(
              `Contract data fetch failed: ${contractData.reason}`
            );
          }

          const [
            symbol,
            name,
            decimals,
            totalSupply,
            maxSupply,
            paused,
            weatherRewardRate,
          ] = contractData.value as [
            string,
            string,
            bigint,
            bigint,
            bigint,
            boolean,
            bigint,
          ];

          // Process additional service data with fallbacks
          let holderCount = 0;
          let circulatingSupply = totalSupply.toString();
          let governanceWeight = '0';

          if (
            walletServiceData.status === 'fulfilled' &&
            walletServiceData.value.success
          ) {
            const walletData = walletServiceData.value.data as any;
            holderCount = walletData?.holderCount || 0;
            circulatingSupply =
              walletData?.circulatingSupply || totalSupply.toString();
          }

          if (
            governanceData.status === 'fulfilled' &&
            governanceData.value.success
          ) {
            const govData = governanceData.value.data as any;
            governanceWeight = govData?.totalVotingWeight || '0';
          }

          // Enhanced token information with service integration
          return {
            id: context.contracts.wrfToken.address,
            address: context.contracts.wrfToken.address,
            symbol,
            name,
            decimals: Number(decimals),
            totalSupply: totalSupply.toString(),
            circulatingSupply,
            maxSupply: maxSupply.toString(),
            paused,
            weatherRewardRate: weatherRewardRate.toString(),
            holderCount,
            governanceWeight,
            // Additional metrics from services
            metadata: {
              lastUpdated: new Date().toISOString(),
              dataSource: 'blockchain+services',
              serviceHealth: {
                wallet:
                  walletServiceData.status === 'fulfilled' &&
                  walletServiceData.value.success,
                governance:
                  governanceData.status === 'fulfilled' &&
                  governanceData.value.success,
              },
            },
          };
        } catch (error) {
          const errorContext = {
            requestId: context.requestId,
            operationType: 'wrfToken',
            clientIP: context.clientIP,
          };

          logger.error('Error fetching WRF token info', {
            error: error instanceof Error ? error.message : String(error),
            requestId: context.requestId,
            stack: error instanceof Error ? error.stack : undefined,
          });

          throw formatError(error, errorContext);
        }
      }
    ),

    // Enhanced token balance query with service integration
    tokenBalance: withPerformanceMonitoring(
      'tokenBalance',
      async (
        _: any,
        {
          address,
          includeStaking = false,
        }: { address: string; includeStaking?: boolean },
        context: GraphQLContext
      ) => {
        try {
          const errorContext = {
            requestId: context.requestId,
            operationType: 'tokenBalance',
            clientIP: context.clientIP,
            address,
          };

          // Parallel calls to multiple services
          const [contractBalance, walletServiceData, stakingData] =
            await Promise.allSettled([
              context.contracts.wrfToken.balanceOf(address),
              context.services.wallet.get(`/api/balance/${address}`),
              includeStaking
                ? context.services.governance.get(`/api/staking/${address}`)
                : Promise.resolve(null),
            ]);

          const balance =
            contractBalance.status === 'fulfilled'
              ? contractBalance.value.toString()
              : '0';

          let walletData: any = null;
          if (
            walletServiceData.status === 'fulfilled' &&
            walletServiceData.value.success
          ) {
            walletData = walletServiceData.value.data as any;
          }

          let stakingInfo: any = null;
          if (
            includeStaking &&
            stakingData.status === 'fulfilled' &&
            stakingData.value?.success
          ) {
            stakingInfo = stakingData.value.data as any;
          }

          return {
            address,
            balance,
            formattedBalance: ethers.formatEther(balance),
            pendingRewards: walletData?.pendingRewards || '0',
            lastUpdate: walletData?.lastUpdate || new Date().toISOString(),
            staking: stakingInfo
              ? {
                  stakedAmount: stakingInfo.stakedAmount || '0',
                  rewards: stakingInfo.rewards || '0',
                  lockPeriod: stakingInfo.lockPeriod || 0,
                  canUnstake: stakingInfo.canUnstake || false,
                }
              : null,
          };
        } catch (error) {
          logger.error('Error fetching token balance', {
            error: error instanceof Error ? error.message : String(error),
            address,
            requestId: context.requestId,
          });
          throw formatError(error, {
            requestId: context.requestId,
            operationType: 'tokenBalance',
            clientIP: context.clientIP,
          });
        }
      }
    ),
  },

  // Field resolvers with enhanced service integration
  WRFToken: {
    weatherStations: async (
      parent: any,
      {
        first = 20,
        includeOffline = false,
      }: { first?: number; includeOffline?: boolean },
      context: GraphQLContext
    ) => {
      try {
        // Parallel queries to database and IoT service
        const [dbStations, iotServiceData] = await Promise.allSettled([
          // Database query for basic station data
          context.db.query.weatherStations.findMany({
            where: includeOffline
              ? undefined
              : eq(weatherStations.isActive, true),
            limit: Math.min(first, 50), // Limit to prevent excessive data loading
            orderBy: desc(weatherStations.totalRewards),
          }),
          // IoT service for real-time data
          context.services.iot.get('/api/stations/active'),
        ]);

        let stations: any[] = [];
        if (dbStations.status === 'fulfilled') {
          stations = dbStations.value;
        }

        // Enhance with real-time IoT data
        let iotData: any = {};
        if (
          iotServiceData.status === 'fulfilled' &&
          iotServiceData.value.success
        ) {
          const iotStations = (iotServiceData.value.data as any[]) || [];
          iotData = iotStations.reduce((acc: any, station: any) => {
            acc[station.stationId] = station;
            return acc;
          }, {});
        }

        return stations.map((station: any) => {
          const realtimeData = iotData[station.stationId] || {};
          return {
            id: station.stationId,
            address: station.ownerAddress,
            stationId: station.stationId,
            location: station.location,
            isActive: station.isActive,
            lastRewardTime:
              station.lastRewardTime?.toISOString() || new Date().toISOString(),
            totalRewards: station.totalRewards || '0',
            qualityScore: Number(station.qualityScore) || 0,
            // Enhanced with real-time IoT data
            realtimeData: realtimeData
              ? {
                  temperature: realtimeData.temperature,
                  humidity: realtimeData.humidity,
                  pressure: realtimeData.pressure,
                  lastUpdate: realtimeData.lastUpdate,
                  connectionStatus: realtimeData.connectionStatus || 'unknown',
                }
              : null,
          };
        });
      } catch (error) {
        logger.error('Error fetching weather stations for token', {
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        return [];
      }
    },

    votes: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        // Use data loader for batched requests and caching
        const voteIds = Array.from({ length: Math.min(first, 50) }, (_, i) =>
          i.toString()
        );

        // Parallel queries to database and governance service
        const [dbVotes, governanceServiceData] = await Promise.allSettled([
          // Database query for vote records
          context.db.query.votes.findMany({
            limit: Math.min(first, 50),
            orderBy: desc(votes.timestamp),
          }),
          // Governance service for additional vote metadata
          context.services.governance.get('/api/votes/recent', {
            params: { limit: Math.min(first, 50) },
          }),
        ]);

        let voteRecords: Vote[] = [];
        if (dbVotes.status === 'fulfilled') {
          voteRecords = dbVotes.value;
        }

        // Enhance with governance service data
        let governanceVotes: Record<string, any> = {};
        if (
          governanceServiceData.status === 'fulfilled' &&
          governanceServiceData.value.success
        ) {
          const govVotes = (governanceServiceData.value.data as any[]) || [];
          governanceVotes = govVotes.reduce(
            (acc: Record<string, any>, vote: any) => {
              acc[vote.id] = vote;
              return acc;
            },
            {}
          );
        }

        return voteRecords.map((vote: Vote) => {
          const govData = governanceVotes[vote.id.toString()] || {};
          return {
            id: vote.id.toString(),
            proposalId: vote.proposalId,
            voter: vote.voter,
            support: vote.support,
            weight: vote.weight,
            reason: vote.reason || '',
            timestamp: vote.timestamp.toISOString(),
            transactionHash: vote.transactionHash || '',
            // Enhanced with governance service data
            delegatedWeight: govData.delegatedWeight || '0',
            voterPowerAtTime: govData.voterPowerAtTime || '0',
            isDelegate: govData.isDelegate || false,
          };
        });
      } catch (error) {
        logger.error('Error fetching votes for token', {
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        return [];
      }
    },

    proposals: async (
      parent: any,
      { first = 10, status }: { first?: number; status?: string },
      context: GraphQLContext
    ) => {
      try {
        // Parallel queries to database and governance service
        const [dbProposals, governanceServiceData, aiAnalysisData] =
          await Promise.allSettled([
            // Database query for proposal records
            context.db.query.proposals.findMany({
              limit: Math.min(first, 50),
              orderBy: desc(proposals.createdAt),
            }),
            // Governance service for real-time proposal state
            context.services.governance.get('/api/proposals/active'),
            // AI/ML service for proposal sentiment analysis
            context.services.aiml.get('/api/analysis/proposal-sentiment'),
          ]);

        let proposalRecords: Proposal[] = [];
        if (dbProposals.status === 'fulfilled') {
          proposalRecords = dbProposals.value;
        }

        // Enhance with governance service data
        let governanceProposals: Record<string, any> = {};
        if (
          governanceServiceData.status === 'fulfilled' &&
          governanceServiceData.value.success
        ) {
          const govProposals =
            (governanceServiceData.value.data as any[]) || [];
          governanceProposals = govProposals.reduce(
            (acc: Record<string, any>, proposal: any) => {
              acc[proposal.id] = proposal;
              return acc;
            },
            {}
          );
        }

        // Enhance with AI analysis data
        let aiAnalysis: Record<string, any> = {};
        if (
          aiAnalysisData.status === 'fulfilled' &&
          aiAnalysisData.value.success
        ) {
          const analysisData = (aiAnalysisData.value.data as any[]) || [];
          aiAnalysis = analysisData.reduce(
            (acc: Record<string, any>, analysis: any) => {
              acc[analysis.proposalId] = analysis;
              return acc;
            },
            {}
          );
        }

        return proposalRecords
          .filter(
            (proposal: Proposal) =>
              !status || proposal.state === status || proposal.status === status
          )
          .map((proposal: Proposal) => {
            const govData = governanceProposals[proposal.id.toString()] || {};
            const sentimentData = aiAnalysis[proposal.id.toString()] || {};

            return {
              id: proposal.id.toString(),
              proposalId: proposal.id.toString(),
              title: proposal.title,
              description: proposal.description,
              proposer: proposal.proposer,
              targets: (proposal.targets as string[]) || [],
              values: (proposal.values as string[]) || [],
              calldatas: (proposal.calldatas as string[]) || [],
              votingType: proposal.votingType || 'SIMPLE_MAJORITY',
              votingDelay: proposal.votingDelay?.toString() || '1',
              votingPeriod: proposal.votingPeriod?.toString() || '604800',
              quorumFraction: proposal.quorumFraction?.toString() || '50',
              emergencyProposal: proposal.emergencyProposal || false,
              state:
                govData.currentState ||
                proposal.state ||
                proposal.status ||
                'ACTIVE',
              startBlock: proposal.startBlock?.toString() || '0',
              endBlock: proposal.endBlock?.toString() || '0',
              forVotes: proposal.forVotes?.toString() || '0',
              againstVotes: proposal.againstVotes?.toString() || '0',
              abstainVotes: proposal.abstainVotes?.toString() || '0',
              createdAt: proposal.createdAt.toISOString(),
              // Enhanced with service data
              currentQuorum: govData.currentQuorum || '0',
              participationRate: govData.participationRate || 0,
              timeRemaining: govData.timeRemaining || 0,
              isExecutable: govData.isExecutable || false,
              // AI analysis data
              sentimentAnalysis: sentimentData
                ? {
                    overallSentiment:
                      sentimentData.overallSentiment || 'neutral',
                    supportProbability: sentimentData.supportProbability || 0,
                    riskFactors: sentimentData.riskFactors || [],
                    keyTopics: sentimentData.keyTopics || [],
                  }
                : null,
            };
          });
      } catch (error) {
        logger.error('Error fetching proposals for token', {
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        return [];
      }
    },

    // Add performance metrics resolver
    performance: async (parent: any, _: any, context: GraphQLContext) => {
      try {
        // Aggregate performance metrics from multiple services
        const [mainApiMetrics, crossChainMetrics, computeMetrics] =
          await Promise.allSettled([
            context.services.mainApi.get('/api/metrics/performance'),
            context.services.crossChain.get('/api/bridge/metrics'),
            context.services.compute.get('/api/compute/metrics'),
          ]);

        const metrics = {
          totalTransactions: 0,
          avgBlockTime: 0,
          networkHashrate: '0',
          activeNodes: 0,
          crossChainVolume: '0',
          computeJobsCompleted: 0,
          lastUpdated: new Date().toISOString(),
        };

        // Process metrics from each service
        if (
          mainApiMetrics.status === 'fulfilled' &&
          mainApiMetrics.value.success
        ) {
          const data = mainApiMetrics.value.data as any;
          metrics.totalTransactions = data.totalTransactions || 0;
          metrics.avgBlockTime = data.avgBlockTime || 0;
          metrics.networkHashrate = data.networkHashrate || '0';
          metrics.activeNodes = data.activeNodes || 0;
        }

        if (
          crossChainMetrics.status === 'fulfilled' &&
          crossChainMetrics.value.success
        ) {
          const data = crossChainMetrics.value.data as any;
          metrics.crossChainVolume = data.totalVolume || '0';
        }

        if (
          computeMetrics.status === 'fulfilled' &&
          computeMetrics.value.success
        ) {
          const data = computeMetrics.value.data as any;
          metrics.computeJobsCompleted = data.completedJobs || 0;
        }

        return metrics;
      } catch (error) {
        logger.error('Error fetching performance metrics', {
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        return {
          totalTransactions: 0,
          avgBlockTime: 0,
          networkHashrate: '0',
          activeNodes: 0,
          crossChainVolume: '0',
          computeJobsCompleted: 0,
          lastUpdated: new Date().toISOString(),
        };
      }
    },
  },
};
