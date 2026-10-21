/**
 * Carbon Credit AMM GraphQL Resolvers
 * Handles AMM trading, liquidity pools, and market operations
 */

import { ethers } from 'ethers';
import { eq, or, desc, asc } from 'drizzle-orm';
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
  validationError,
  notFoundError,
  blockchainError,
  timeoutError,
} from '../error-handler.js';
import { pubsub } from '../subscriptions/pubsub.js';
import { ammPairs, ammSwaps } from '../../shared/schema.js';

export const ammResolvers = {
  Query: {
    // Get AMM pool information
    ammPool: withPerformanceMonitoring(
      'ammPool',
      async (_: any, { id }: { id: string }, context: GraphQLContext) => {
        try {
          // Input validation
          if (!id || !ethers.isAddress(id)) {
            throw validationError('Invalid pair address format', 'id', {
              requestId: context.requestId,
              operationType: 'ammPool',
              variables: { id },
            });
          }

          const pairAddress = id.toLowerCase();
          const errorContext = {
            requestId: context.requestId,
            operationType: 'ammPool',
            variables: { id: pairAddress },
            clientIP: context.clientIP,
          };

          // Get data from blockchain and database concurrently with timeout
          const [blockchainResult, pairRecord] = await Promise.allSettled([
            Promise.race([
              Promise.all([
                context.contracts.carbonCreditAMM.getPairInfo(pairAddress),
                context.contracts.carbonCreditAMM.getReserves(),
                context.contracts.carbonCreditAMM.swapFee(),
              ]),
              new Promise((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      timeoutError(
                        'AMM blockchain data fetch',
                        8000,
                        errorContext
                      )
                    ),
                  8000
                )
              ),
            ]),
            withRetry(
              () =>
                context.db.query.ammPairs.findFirst({
                  where: eq(ammPairs.pairAddress, pairAddress),
                }),
              3,
              1000,
              errorContext
            ),
          ]);

          // Handle blockchain data
          let pairInfo: any[] = [];
          let reserves: [bigint, bigint] = [BigInt(0), BigInt(0)];
          let fee = BigInt(0);

          if (blockchainResult.status === 'fulfilled') {
            [pairInfo, reserves, fee] = blockchainResult.value as [
              any[],
              [bigint, bigint],
              bigint,
            ];
          } else {
            logger.warn('Failed to fetch blockchain data for AMM pair', {
              id: pairAddress,
              error: blockchainResult.reason?.message,
              requestId: context.requestId,
            });

            // Continue with database data only
          }

          // Handle database data
          const dbRecord =
            pairRecord.status === 'fulfilled' ? pairRecord.value : null;

          if (!dbRecord && blockchainResult.status === 'rejected') {
            // Neither blockchain nor database has this pair
            return null;
          }

          return {
            id: pairAddress,
            pairAddress,
            token0: pairInfo[0] || dbRecord?.token0 || '',
            token1: pairInfo[1] || dbRecord?.token1 || '',
            reserve0: reserves[0].toString() || dbRecord?.reserve0 || '0',
            reserve1: reserves[1].toString() || dbRecord?.reserve1 || '0',
            totalLiquidity: dbRecord?.totalLiquidity || '0',
            swapFee: fee.toString() || dbRecord?.swapFee || '0',
            volume24h: dbRecord?.volume24h || '0',
            volumeWeek: dbRecord?.volumeWeek || '0',
            feeRewards24h: dbRecord?.feeRewards24h || '0',
            createdAt: dbRecord?.createdAt || new Date(),
            lastUpdateTime: dbRecord?.lastUpdateTime || new Date(),
          };
        } catch (error) {
          const errorContext = {
            requestId: context.requestId,
            operationType: 'ammPool',
            variables: { id },
            clientIP: context.clientIP,
          };

          logger.error('Error fetching AMM pair', {
            id,
            error: error instanceof Error ? error.message : String(error),
            requestId: context.requestId,
            stack: error instanceof Error ? error.stack : undefined,
          });

          throw formatError(error, errorContext);
        }
      }
    ),

    // Get multiple AMM pools
    ammPools: async (
      _: any,
      {
        first = 10,
        skip = 0,
        orderBy = 'totalLiquidity',
        orderDirection = 'desc',
      }: {
        first?: number;
        skip?: number;
        orderBy?: string;
        orderDirection?: string;
      },
      context: GraphQLContext
    ) => {
      try {
        // Build the order by field, defaulting to totalLiquidity
        const orderField =
          (ammPairs as any)[orderBy] || ammPairs.totalLiquidity;
        const orderFunction = orderDirection === 'desc' ? desc : asc;

        const pairs = await context.db.query.ammPairs.findMany({
          limit: Math.min(first, 100),
          offset: skip,
          orderBy: orderFunction(orderField),
          where: eq(ammPairs.isActive, true), // Only show active pairs
        });

        return pairs.map(pair => ({
          id: pair.pairAddress,
          pairAddress: pair.pairAddress,
          token0: pair.token0,
          token1: pair.token1,
          reserve0: pair.reserve0,
          reserve1: pair.reserve1,
          totalLiquidity: pair.totalLiquidity,
          swapFee: pair.swapFee,
          volume24h: pair.volume24h,
          volumeWeek: pair.volumeWeek,
          feeRewards24h: pair.feeRewards24h,
          createdAt: pair.createdAt,
          lastUpdateTime: pair.lastUpdateTime,
        }));
      } catch (error) {
        logger.error('Error fetching AMM pairs', {
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        throw formatError(error, {
          requestId: context.requestId,
          operationType: 'AMM_PAIRS_FETCH_ERROR',
        });
      }
    },

    // Get swap quote (commented out - not in schema)
    /*
    getSwapQuote: async (
      _: any,
      {
        tokenIn,
        tokenOut,
        amountIn
      }: {
        tokenIn: string;
        tokenOut: string;
        amountIn: string;
      },
      context: GraphQLContext
    ) => {
      try {
        const amountInBN = BigInt(amountIn);

        // Get quote from AMM contract
        const quote = await context.contracts.carbonCreditAMM.getAmountOut(
          amountInBN,
          tokenIn,
          tokenOut
        );

        // Calculate price impact
        const reserves = await context.contracts.carbonCreditAMM.getReserves();
        const priceImpact = calculatePriceImpact(amountInBN, reserves, tokenIn === reserves[0]);

        // Get swap fee
        const swapFee = await context.contracts.carbonCreditAMM.swapFee();
        const feeAmount = (amountInBN * swapFee) / BigInt(10000);

        return {
          tokenIn,
          tokenOut,
          amountIn,
          amountOut: quote.toString(),
          priceImpact: priceImpact.toString(),
          fee: feeAmount.toString(),
          minimumAmountOut: (quote * BigInt(95) / BigInt(100)).toString(), // 5% slippage
        };
      } catch (error) {
        logger.error('Error getting swap quote', {
          tokenIn,
          tokenOut,
          amountIn,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId
        });
        throw formatError(error, { requestId: context.requestId, operationType: 'SWAP_QUOTE_ERROR' });
      }
    },
    */
  },

  // Field resolvers
  AMMPair: {
    swaps: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const swaps = await context.db.query.ammSwaps.findMany({
          where: eq(ammSwaps.pairAddress, parent.pairAddress),
          limit: Math.min(first, 100),
          orderBy: desc(ammSwaps.timestamp),
        });

        return swaps.map(swap => ({
          id: swap.id,
          user: swap.user,
          tokenIn: swap.tokenIn,
          tokenOut: swap.tokenOut,
          amountIn: swap.amountIn,
          amountOut: swap.amountOut,
          minimumAmountOut: swap.minimumAmountOut,
          priceImpact: swap.priceImpact,
          fee: swap.fee,
          status: swap.status,
          timestamp: swap.timestamp,
          transactionHash: swap.transactionHash,
        }));
      } catch (error) {
        logger.error('Error fetching pair swaps', {
          pairAddress: parent.pairAddress,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
  },
};

// Helper functions
function calculatePriceImpact(
  amountIn: bigint,
  reserves: [bigint, bigint],
  isToken0: boolean
): bigint {
  const [reserve0, reserve1] = reserves;
  const reserveIn = isToken0 ? reserve0 : reserve1;
  const reserveOut = isToken0 ? reserve1 : reserve0;

  // Calculate price impact as percentage (basis points)
  const priceImpact = (amountIn * BigInt(10000)) / (reserveIn + amountIn);
  return priceImpact;
}
