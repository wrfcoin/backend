/**
 * Computational NFT GraphQL Resolvers
 * Handles computational NFTs, compute jobs, and provider management
 */

import { ethers } from 'ethers';
import {
  GraphQLContext,
  requireAuth,
  requireVerifiedWallet,
} from '../context.js';
import { logger } from '../../utils/logger.js';
import {
  formatError,
  withRetry,
  withPerformanceMonitoring,
  notFoundError,
  validationError,
  blockchainError,
  timeoutError,
  ErrorCode,
} from '../error-handler.js';
import { eq, gte, desc, asc, and, or, sql } from 'drizzle-orm';
import {
  computationalNfts,
  computationalTasks,
  computeRewards,
} from '../../shared/schema.js';

export const computationalNftResolvers = {
  Query: {
    // Get single computational NFT
    computationalNFT: withPerformanceMonitoring(
      'computationalNFT',
      async (_: any, { id }: { id: string }, context: GraphQLContext) => {
        try {
          // Input validation
          let tokenId: bigint;
          try {
            tokenId = BigInt(id);
            if (tokenId < 0) {
              throw new Error('Token ID must be non-negative');
            }
          } catch (conversionError) {
            throw validationError('Invalid token ID format', 'id', {
              requestId: context.requestId,
              operationType: 'computationalNFT',
              variables: { id },
            });
          }

          const errorContext = {
            requestId: context.requestId,
            operationType: 'computationalNFT',
            variables: { id, tokenId: tokenId.toString() },
            clientIP: context.clientIP,
          };

          // Get data from blockchain and database concurrently with timeout
          const [blockchainResult, nftRecord] = await Promise.allSettled([
            Promise.race([
              Promise.all([
                context.contracts.computationalNFT.getComputeJob(tokenId),
                context.contracts.computationalNFT.ownerOf(tokenId),
              ]),
              new Promise((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      timeoutError('Blockchain data fetch', 8000, errorContext)
                    ),
                  8000
                )
              ),
            ]),
            withRetry(
              () =>
                context.db.query.computationalNfts.findFirst({
                  where: eq(computationalNfts.nftId, id),
                }),
              3,
              1000,
              errorContext
            ),
          ]);

          // Handle blockchain data
          let jobDetails: any[] = [];
          let owner = ethers.ZeroAddress;

          if (blockchainResult.status === 'fulfilled') {
            [jobDetails, owner] = blockchainResult.value as [any[], string];
          } else {
            const blockchainError = blockchainResult.reason;

            // Check if it's a "token doesn't exist" error
            if (
              blockchainError?.message?.includes('ERC721: invalid token ID') ||
              blockchainError?.message?.includes('nonexistent token')
            ) {
              return null; // NFT doesn't exist
            }

            logger.warn(
              'Failed to fetch blockchain data for computational NFT',
              {
                id,
                error: blockchainError?.message,
                requestId: context.requestId,
              }
            );

            // Continue with database data only, but log the blockchain failure
          }

          // Handle database data
          const dbRecord =
            nftRecord.status === 'fulfilled' ? nftRecord.value : null;

          if (!dbRecord && blockchainResult.status === 'rejected') {
            // Neither blockchain nor database has this NFT
            return null;
          }

          // Construct response with available data
          return {
            id,
            tokenId: tokenId.toString(),
            modelType: jobDetails[0] || dbRecord?.computationType || 'UNKNOWN',
            modelName: jobDetails[1] || dbRecord?.name || '',
            status:
              jobDetails[2] || (dbRecord?.metadata as any)?.status || 'unknown',
            stakeAmount:
              jobDetails[3]?.toString() ||
              (dbRecord?.metadata as any)?.stakeAmount ||
              '0',
            computeProvider:
              jobDetails[4] ||
              (dbRecord?.metadata as any)?.computeProvider ||
              ethers.ZeroAddress,
            isVerified:
              jobDetails[5] !== undefined
                ? jobDetails[5]
                : dbRecord?.isVerified || false,
            resultHash: jobDetails[6] || dbRecord?.executionResultHash || '',

            // From database
            inputData: dbRecord?.inputData || '',
            computeResources: dbRecord?.resourceRequirements || '',
            executionTime: (dbRecord?.metadata as any)?.executionTime || '0',
            resultData: (dbRecord?.metadata as any)?.resultData || '',
            createdAt: dbRecord?.createdAt || new Date(),
            executedAt: (dbRecord?.metadata as any)?.executedAt || null,

            owner:
              owner !== ethers.ZeroAddress
                ? owner.toLowerCase()
                : dbRecord?.creator || '',
          };
        } catch (error) {
          const errorContext = {
            requestId: context.requestId,
            operationType: 'computationalNFT',
            variables: { id },
            clientIP: context.clientIP,
          };

          logger.error('Error fetching computational NFT', {
            id,
            error: error instanceof Error ? error.message : 'Unknown error',
            requestId: context.requestId,
            stack: error instanceof Error ? error.stack : undefined,
          });

          throw formatError(error, errorContext);
        }
      }
    ),

    // Get multiple computational NFTs with filtering
    computationalNFTs: async (
      _: any,
      {
        first = 10,
        skip = 0,
        orderBy = 'id',
        orderDirection = 'asc',
        where,
      }: {
        first?: number;
        skip?: number;
        orderBy?: string;
        orderDirection?: string;
        where?: any;
      },
      context: GraphQLContext
    ) => {
      try {
        const queryConditions: any[] = [];

        if (where) {
          if (where.modelType) {
            queryConditions.push(
              eq(computationalNfts.computationType, where.modelType)
            );
          }

          if (where.status) {
            queryConditions.push(
              sql`${computationalNfts.metadata}->>'status' = ${where.status}`
            );
          }

          if (where.owner) {
            queryConditions.push(
              eq(computationalNfts.creator, where.owner.toLowerCase())
            );
          }

          if (where.isVerified !== undefined) {
            queryConditions.push(
              eq(computationalNfts.isVerified, where.isVerified)
            );
          }
        }

        const whereClause =
          queryConditions.length > 0 ? and(...queryConditions) : undefined;

        const nfts = await context.db.query.computationalNfts.findMany({
          where: whereClause,
          limit: Math.min(first, 100),
          offset: skip,
          orderBy:
            orderDirection === 'desc'
              ? desc(computationalNfts.createdAt)
              : asc(computationalNfts.createdAt),
        });

        return nfts.map(nft => ({
          id: nft.nftId,
          tokenId: nft.nftId,
          modelType: nft.computationType,
          modelName: nft.name,
          inputData: nft.inputData,
          computeResources: nft.resourceRequirements,
          executionTime: (nft.metadata as any)?.executionTime || '0',
          stakeAmount: (nft.metadata as any)?.stakeAmount || '0',
          status: (nft.metadata as any)?.status || 'pending',
          resultData: (nft.metadata as any)?.resultData || '',
          resultHash: nft.executionResultHash,
          createdAt: nft.createdAt,
          executedAt: (nft.metadata as any)?.executedAt,
          computeProvider: (nft.metadata as any)?.computeProvider || '',
          isVerified: nft.isVerified,
          owner: nft.creator,
        }));
      } catch (error) {
        logger.error('Error fetching computational NFTs', {
          error: error instanceof Error ? error.message : 'Unknown error',
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'COMPUTATIONAL_NFTS_FETCH_ERROR',
        });
      }
    },
  },

  // Field resolvers
  ComputationalNFT: {
    job: async (parent: any, _: any, context: GraphQLContext) => {
      try {
        return {
          id: `job_${parent.tokenId}`,
          nft: parent,
        };
      } catch (error) {
        logger.error('Error fetching compute job', {
          tokenId: parent.tokenId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        return null;
      }
    },
  },

  ComputeJob: {
    provider: async (parent: any, _: any, context: GraphQLContext) => {
      try {
        if (
          !parent.nft.computeProvider ||
          parent.nft.computeProvider === ethers.ZeroAddress
        ) {
          return null;
        }

        const providerStats =
          await context.contracts.computationalNFT.getProviderStats(
            parent.nft.computeProvider
          );

        return {
          id: parent.nft.computeProvider,
          address: parent.nft.computeProvider,
          isAuthorized: providerStats[0],
          totalComputeTime: providerStats[1].toString(),
          successfulJobs: providerStats[2].toString(),
          failedJobs: providerStats[3].toString(),
          stakedTokens: providerStats[4].toString(),
          hardwareSpecs: '', // Would need to be stored separately
        };
      } catch (error) {
        logger.error('Error fetching compute provider', {
          provider: parent.nft.computeProvider,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        return null;
      }
    },

    rewards: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        // Query compute rewards table filtering by jobId
        const rewards = await context.db.query.computeRewards.findMany({
          where: eq(computeRewards.jobId, parent.id),
          limit: Math.min(first, 100), // Limit to reasonable amount
          orderBy: desc(computeRewards.createdAt), // Order by most recent first
        });

        logger.info('Fetched compute rewards', {
          jobId: parent.id,
          rewardCount: rewards.length,
        });

        // Map database results to expected GraphQL response format
        return rewards.map(reward => ({
          id: reward.id,
          provider: reward.computeProvider,
          amount: reward.rewardAmount.toString(),
          computeTime: reward.executionTime?.toString() || '0',
          timestamp: reward.distributedAt || reward.createdAt,
          transactionHash: reward.transactionHash || '',
        }));
      } catch (error) {
        logger.error('Error fetching compute rewards', {
          jobId: parent.id,
          error: error instanceof Error ? error.message : 'Unknown error',
          requestId: context.requestId,
        });
        return [];
      }
    },
  },

  ComputeProvider: {
    jobs: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const nfts = await context.db.query.computationalNfts.findMany({
          where: eq(computationalNfts.creator, parent.address),
          limit: Math.min(first, 100),
          orderBy: desc(computationalNfts.createdAt),
        });

        return nfts.map(nft => ({
          id: `job_${nft.nftId}`,
          nft,
        }));
      } catch (error) {
        logger.error('Error fetching provider jobs', {
          provider: parent.address,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        return [];
      }
    },
  },
};
