/**
 * User GraphQL Resolvers
 * Handles user profiles, authentication, and user-specific data aggregation
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
  authenticationError,
  notFoundError,
  validationError,
  databaseError,
  blockchainError,
  timeoutError,
  ErrorCode,
} from '../error-handler.js';
import { eq, gte, desc, asc, and, or, sql, like } from 'drizzle-orm';
import {
  users,
  transactions,
  nfts,
  userAchievements,
  achievements,
  weatherStations,
  votes,
  proposals,
  computationalNfts,
  carbonCredits,
  carbonFootprints,
  ammSwaps,
  stakingDeposits,
  stakingRewards,
  liquidityPositions,
  computeRewards,
} from '../../shared/schema.js';

const USERS_MAX_PAGE_SIZE = 20;
const USERS_RPC_CONCURRENCY = 5;
const USERS_RPC_TIMEOUT_MS = 3000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Timeout')), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]);
      }
    }
  );

  await Promise.all(workers);
  return results;
}

export const userResolvers = {
  Query: {
    // Get current user profile
    me: withPerformanceMonitoring(
      'userProfile',
      async (_: any, __: any, context: GraphQLContext) => {
        try {
          const user = requireAuth(context);

          const errorContext = {
            requestId: context.requestId,
            userId: user.address,
            operationType: 'me',
            clientIP: context.clientIP,
          };

          // Get user data from database with retry
          const userRecord = await withRetry(
            () =>
              context.db.query.users.findFirst({
                where: eq(users.walletAddress, user.address),
              }),
            3,
            1000,
            errorContext
          );

          if (!userRecord) {
            throw notFoundError('User', errorContext);
          }

          // Get blockchain data with graceful degradation and timeout
          let balance = '0';
          let votingPower = '0';

          try {
            const blockchainPromises = await Promise.allSettled([
              Promise.race([
                context.contracts.wrfToken.balanceOf(user.address),
                new Promise((_, reject) =>
                  setTimeout(
                    () =>
                      reject(
                        timeoutError('WRF balance fetch', 5000, errorContext)
                      ),
                    5000
                  )
                ),
              ]),
              Promise.race([
                context.contracts.wrfGovernor.getVotes(
                  user.address,
                  Math.max(0, (await context.provider.getBlockNumber()) - 1)
                ),
                new Promise((_, reject) =>
                  setTimeout(
                    () =>
                      reject(
                        timeoutError('Voting power fetch', 5000, errorContext)
                      ),
                    5000
                  )
                ),
              ]),
            ]);

            if (blockchainPromises[0].status === 'fulfilled') {
              balance = (blockchainPromises[0].value as bigint).toString();
            } else {
              logger.warn('Failed to fetch WRF balance, using default', {
                address: user.address,
                error: blockchainPromises[0].reason?.message,
                requestId: context.requestId,
              });
            }

            if (blockchainPromises[1].status === 'fulfilled') {
              votingPower = (blockchainPromises[1].value as bigint).toString();
            } else {
              logger.warn('Failed to fetch voting power, using default', {
                address: user.address,
                error: blockchainPromises[1].reason?.message,
                requestId: context.requestId,
              });
            }
          } catch (blockchainError) {
            // Log blockchain errors but don't fail the entire query
            logger.warn('Blockchain data fetch failed, using defaults', {
              address: user.address,
              error:
                blockchainError instanceof Error
                  ? blockchainError.message
                  : String(blockchainError),
              requestId: context.requestId,
            });
          }

          return {
            id: user.address,
            address: user.address,
            username: userRecord.username,
            email: userRecord.email,
            profile: {
              displayName: userRecord.displayName,
              bio: userRecord.bio,
              avatar: userRecord.avatar,
              location: userRecord.location,
            },
            wrfBalance: balance,
            joinedAt: userRecord.createdAt,
            lastActiveAt: userRecord.lastActiveAt,
            isVerified: userRecord.isVerified,
          };
        } catch (error) {
          const errorContext = {
            requestId: context.requestId,
            operationType: 'me',
            clientIP: context.clientIP,
          };

          logger.error('Error fetching user profile', {
            error: error instanceof Error ? error.message : String(error),
            requestId: context.requestId,
            stack: error instanceof Error ? error.stack : undefined,
          });

          throw formatError(error, errorContext);
        }
      }
    ),

    // Get user by address
    user: withPerformanceMonitoring(
      'userByAddress',
      async (
        _: any,
        { address }: { address: string },
        context: GraphQLContext
      ) => {
        try {
          // Input validation
          if (!address || !ethers.isAddress(address)) {
            throw validationError(
              'Invalid Ethereum address format',
              'address',
              {
                requestId: context.requestId,
                operationType: 'user',
                variables: { address },
              }
            );
          }

          const normalizedAddress = address.toLowerCase();
          const errorContext = {
            requestId: context.requestId,
            operationType: 'user',
            variables: { address: normalizedAddress },
            clientIP: context.clientIP,
          };

          // Get user data from database with retry
          const userRecord = await withRetry(
            () =>
              context.db.query.users.findFirst({
                where: eq(users.walletAddress, normalizedAddress),
              }),
            3,
            1000,
            errorContext
          );

          if (!userRecord) {
            return null; // Return null for not found users (allows client to handle gracefully)
          }

          // Get blockchain data with graceful degradation and timeout
          let balance = '0';
          let votingPower = '0';

          try {
            const blockchainPromises = await Promise.allSettled([
              Promise.race([
                context.contracts.wrfToken.balanceOf(normalizedAddress),
                new Promise((_, reject) =>
                  setTimeout(
                    () =>
                      reject(
                        timeoutError('WRF balance fetch', 5000, errorContext)
                      ),
                    5000
                  )
                ),
              ]),
              Promise.race([
                context.contracts.wrfGovernor.getVotes(
                  normalizedAddress,
                  Math.max(0, (await context.provider.getBlockNumber()) - 1)
                ),
                new Promise((_, reject) =>
                  setTimeout(
                    () =>
                      reject(
                        timeoutError('Voting power fetch', 5000, errorContext)
                      ),
                    5000
                  )
                ),
              ]),
            ]);

            if (blockchainPromises[0].status === 'fulfilled') {
              balance = (blockchainPromises[0].value as bigint).toString();
            } else {
              logger.warn(
                'Failed to fetch WRF balance for user, using default',
                {
                  address: normalizedAddress,
                  error: blockchainPromises[0].reason?.message,
                  requestId: context.requestId,
                }
              );
            }

            if (blockchainPromises[1].status === 'fulfilled') {
              votingPower = (blockchainPromises[1].value as bigint).toString();
            } else {
              logger.warn(
                'Failed to fetch voting power for user, using default',
                {
                  address: normalizedAddress,
                  error: blockchainPromises[1].reason?.message,
                  requestId: context.requestId,
                }
              );
            }
          } catch (blockchainError) {
            // Log blockchain errors but don't fail the entire query
            logger.warn(
              'Blockchain data fetch failed for user, using defaults',
              {
                address: normalizedAddress,
                error:
                  blockchainError instanceof Error
                    ? blockchainError.message
                    : String(blockchainError),
                requestId: context.requestId,
              }
            );
          }

          // Hide email for privacy in public queries
          const currentUser = context.user;
          const canViewPrivateInfo =
            currentUser &&
            (currentUser.address.toLowerCase() === normalizedAddress ||
              // Add admin check here if needed
              false);

          return {
            id: normalizedAddress,
            address: normalizedAddress,
            username: userRecord.username,
            email: canViewPrivateInfo ? userRecord.email : null,
            profile: {
              displayName: userRecord.displayName,
              bio: userRecord.bio,
              avatar: userRecord.avatar,
              location: userRecord.location,
            },
            wrfBalance: balance,
            joinedAt: userRecord.createdAt,
            lastActiveAt: userRecord.lastActiveAt,
            isVerified: userRecord.isVerified,
          };
        } catch (error) {
          const errorContext = {
            requestId: context.requestId,
            operationType: 'user',
            variables: { address },
            clientIP: context.clientIP,
          };

          logger.error('Error fetching user by address', {
            address,
            error: error instanceof Error ? error.message : String(error),
            requestId: context.requestId,
            stack: error instanceof Error ? error.stack : undefined,
          });

          throw formatError(error, errorContext);
        }
      }
    ),

    // Search users
    users: withPerformanceMonitoring(
      'usersSearch',
      async (
        _: any,
        {
          first = 10,
          skip = 0,
          orderBy = 'joinedAt',
          orderDirection = 'desc',
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
          // Input validation
          const validatedFirst = Math.min(
            Math.max(first, 1),
            USERS_MAX_PAGE_SIZE
          );
          const validatedSkip = Math.max(skip, 0);

          if (validatedFirst > 50) {
            logger.warn('Large users query requested', {
              first: validatedFirst,
              skip: validatedSkip,
              requestId: context.requestId,
              clientIP: context.clientIP,
            });
          }

          const errorContext = {
            requestId: context.requestId,
            operationType: 'users',
            variables: {
              first: validatedFirst,
              skip: validatedSkip,
              orderBy,
              orderDirection,
              where,
            },
            clientIP: context.clientIP,
          };

          const queryConditions: any[] = [];

          if (where) {
            if (where.isVerified !== undefined) {
              queryConditions.push(eq(users.isVerified, where.isVerified));
            }

            if (where.username_contains) {
              // Sanitize search input
              const sanitizedUsername = where.username_contains.replace(
                /[%_]/g,
                '\\$&'
              );
              queryConditions.push(
                like(users.username, `%${sanitizedUsername}%`)
              );
            }

            if (where.displayName_contains) {
              // Sanitize search input
              const sanitizedDisplayName = where.displayName_contains.replace(
                /[%_]/g,
                '\\$&'
              );
              queryConditions.push(
                like(users.displayName, `%${sanitizedDisplayName}%`)
              );
            }
          }

          const whereClause =
            queryConditions.length > 0 ? and(...queryConditions) : undefined;

          // Execute database query with retry
          const userRecords = await withRetry(
            () =>
              context.db.query.users.findMany({
                where: whereClause,
                limit: validatedFirst,
                offset: validatedSkip,
                orderBy: (() => {
                  const getColumn = () => {
                    switch (orderBy) {
                      case 'id':
                        return users.id;
                      case 'username':
                        return users.username;
                      case 'email':
                        return users.email;
                      case 'walletAddress':
                        return users.walletAddress;
                      case 'displayName':
                        return users.displayName;
                      case 'reputation':
                        return users.reputation;
                      case 'lastActiveAt':
                        return users.lastActiveAt;
                      case 'lastLogin':
                        return users.lastLogin;
                      case 'updatedAt':
                        return users.updatedAt;
                      default:
                        return users.createdAt;
                    }
                  };
                  const column = getColumn();
                  return orderDirection === 'desc' ? desc(column) : asc(column);
                })(),
              }),
            3,
            1000,
            errorContext
          );

          let votingBlock: number | null = null;
          try {
            votingBlock = Math.max(
              0,
              (await withTimeout(
                context.provider.getBlockNumber(),
                USERS_RPC_TIMEOUT_MS
              )) - 1
            );
          } catch (error) {
            logger.debug(
              'Failed to fetch voting block for users search, using defaults',
              {
                error: error instanceof Error ? error.message : String(error),
                requestId: context.requestId,
              }
            );
          }

          // Keep both the total calls (2 per user + 1 block lookup) and the
          // concurrent pressure on the chain provider strictly bounded.
          const successfulUsers = await mapWithConcurrency(
            userRecords.slice(0, validatedFirst),
            USERS_RPC_CONCURRENCY,
            async (userRecord) => {
              try {
                const blockchainPromises = await Promise.allSettled([
                  withTimeout(
                    context.contracts.wrfToken.balanceOf(
                      userRecord.walletAddress
                    ),
                    USERS_RPC_TIMEOUT_MS
                  ),
                  votingBlock === null
                    ? Promise.reject(new Error('Voting block unavailable'))
                    : withTimeout(
                        context.contracts.wrfGovernor.getVotes(
                          userRecord.walletAddress,
                          votingBlock
                        ),
                        USERS_RPC_TIMEOUT_MS
                      ),
                ]);

                const balance =
                  blockchainPromises[0].status === 'fulfilled'
                    ? (blockchainPromises[0].value as bigint).toString()
                    : '0';

                const votingPower =
                  blockchainPromises[1].status === 'fulfilled'
                    ? (blockchainPromises[1].value as bigint).toString()
                    : '0';

                return {
                  id: userRecord.walletAddress,
                  address: userRecord.walletAddress,
                  username: userRecord.username,
                  email: null, // Don't expose email in public lists
                  profile: {
                    displayName: userRecord.displayName,
                    bio: userRecord.bio,
                    avatar: userRecord.avatar,
                    location: userRecord.location,
                  },
                  wrfBalance: balance,
                  joinedAt: userRecord.createdAt,
                  lastActiveAt: userRecord.lastActiveAt,
                  isVerified: userRecord.isVerified,
                };
              } catch (error) {
                // If blockchain call fails, use default values
                logger.debug(
                  'Failed to fetch blockchain data for user in search',
                  {
                    address: userRecord.walletAddress,
                    error:
                      error instanceof Error ? error.message : String(error),
                    requestId: context.requestId,
                  }
                );

                return {
                  id: userRecord.walletAddress,
                  address: userRecord.walletAddress,
                  username: userRecord.username,
                  email: null,
                  profile: {
                    displayName: userRecord.displayName,
                    bio: userRecord.bio,
                    avatar: userRecord.avatar,
                    location: userRecord.location,
                  },
                  wrfBalance: '0',
                  joinedAt: userRecord.createdAt,
                  lastActiveAt: userRecord.lastActiveAt,
                  isVerified: userRecord.isVerified,
                };
              }
            }
          );

          return successfulUsers;
        } catch (error) {
          const errorContext = {
            requestId: context.requestId,
            operationType: 'users',
            variables: { first, skip, orderBy, orderDirection, where },
            clientIP: context.clientIP,
          };

          logger.error('Error fetching users', {
            error: error instanceof Error ? error.message : String(error),
            requestId: context.requestId,
            stack: error instanceof Error ? error.stack : undefined,
          });

          throw formatError(error, errorContext);
        }
      }
    ),
  },

  Mutation: {
    // Update user profile
    updateProfile: withPerformanceMonitoring(
      'updateProfile',
      async (_: any, { input }: { input: any }, context: GraphQLContext) => {
        try {
          const user = requireVerifiedWallet(context);

          const errorContext = {
            requestId: context.requestId,
            userId: user.address,
            operationType: 'updateProfile',
            clientIP: context.clientIP,
          };

          // Enhanced input validation
          if (!input) {
            throw validationError('Input is required', 'input', errorContext);
          }

          if (!input.signature) {
            throw validationError(
              'Signature is required for profile updates',
              'signature',
              errorContext
            );
          }

          // Validate field lengths to prevent abuse
          const maxFieldLengths = {
            displayName: 100,
            bio: 500,
            avatar: 500,
            location: 200,
          };

          for (const [field, maxLength] of Object.entries(maxFieldLengths)) {
            if (input[field] && input[field].length > maxLength) {
              throw validationError(
                `${field} must be ${maxLength} characters or less`,
                field,
                errorContext
              );
            }
          }

          // Sanitize inputs to prevent injection attacks
          const sanitizedInput = {
            displayName: input.displayName?.trim() || '',
            bio: input.bio?.trim() || '',
            avatar: input.avatar?.trim() || '',
            location: input.location?.trim() || '',
          };

          // Verify the signature with timeout
          let recoveredAddress: string;
          try {
            const profileHash = ethers.keccak256(
              ethers.AbiCoder.defaultAbiCoder().encode(
                ['string', 'string', 'string', 'string'],
                [
                  sanitizedInput.displayName,
                  sanitizedInput.bio,
                  sanitizedInput.avatar,
                  sanitizedInput.location,
                ]
              )
            );

            recoveredAddress = await Promise.race([
              ethers.verifyMessage(
                ethers.getBytes(profileHash),
                input.signature
              ),
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      timeoutError('Signature verification', 3000, errorContext)
                    ),
                  3000
                )
              ),
            ]);
          } catch (signatureError) {
            logger.warn('Signature verification failed', {
              address: user.address,
              error:
                signatureError instanceof Error
                  ? signatureError.message
                  : String(signatureError),
              requestId: context.requestId,
            });

            throw validationError(
              'Invalid signature for profile update',
              'signature',
              errorContext
            );
          }

          if (recoveredAddress.toLowerCase() !== user.address.toLowerCase()) {
            throw validationError(
              'Signature does not match user address',
              'signature',
              errorContext
            );
          }

          // Update user profile with retry
          const [updatedUser] = await withRetry(
            () =>
              context.db
                .update(users)
                .set({
                  displayName: sanitizedInput.displayName,
                  bio: sanitizedInput.bio,
                  avatar: sanitizedInput.avatar,
                  location: sanitizedInput.location,
                  updatedAt: new Date(),
                })
                .where(eq(users.walletAddress, user.address))
                .returning(),
            3,
            1000,
            errorContext
          );

          if (!updatedUser) {
            throw databaseError(
              'Failed to update user profile - no rows affected',
              undefined,
              errorContext
            );
          }

          logger.info('User profile updated successfully', {
            address: user.address,
            requestId: context.requestId,
            fields: Object.keys(sanitizedInput).filter(
              k => sanitizedInput[k as keyof typeof sanitizedInput]
            ),
          });

          // Get fresh WRF balance for response
          let wrfBalance = '0';
          try {
            const balance = await Promise.race([
              context.contracts.wrfToken.balanceOf(user.address),
              new Promise((_, reject) =>
                setTimeout(() => reject(new Error('Timeout')), 3000)
              ),
            ]);
            wrfBalance = (balance as bigint).toString();
          } catch (balanceError) {
            logger.debug(
              'Failed to fetch WRF balance for profile update response',
              {
                address: user.address,
                error:
                  balanceError instanceof Error
                    ? balanceError.message
                    : String(balanceError),
              }
            );
          }

          return {
            success: true,
            user: {
              id: updatedUser.walletAddress,
              address: updatedUser.walletAddress,
              username: updatedUser.username,
              email: updatedUser.email,
              profile: {
                displayName: updatedUser.displayName,
                bio: updatedUser.bio,
                avatar: updatedUser.avatar,
                location: updatedUser.location,
              },
              wrfBalance,
              joinedAt: updatedUser.createdAt,
              lastActiveAt: updatedUser.lastActiveAt,
              isVerified: updatedUser.isVerified,
            },
            error: null,
          };
        } catch (error) {
          const errorContext = {
            requestId: context.requestId,
            operationType: 'updateProfile',
            variables: { input },
            clientIP: context.clientIP,
          };

          logger.error('Error updating user profile', {
            input: {
              ...input,
              signature: input?.signature ? '[REDACTED]' : undefined,
            },
            error: error instanceof Error ? error.message : String(error),
            requestId: context.requestId,
            stack: error instanceof Error ? error.stack : undefined,
          });

          // Return error in mutation response format (not thrown)
          return {
            success: false,
            user: null,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
    ),
  },

  // Field resolvers
  User: {
    // WRF Balance - Get from blockchain with enhanced error handling
    wrfBalance: async (parent: any, _: any, context: GraphQLContext) => {
      try {
        // Add timeout and retry for blockchain calls
        const balance = await Promise.race([
          withRetry(
            () => context.contracts.wrfToken.balanceOf(parent.address),
            2, // Fewer retries for field resolvers
            500,
            {
              requestId: context.requestId,
              operationType: 'wrfBalance',
              userId: parent.address,
            }
          ),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(timeoutError('WRF balance fetch', 5000)),
              5000
            )
          ),
        ]);

        return (balance as bigint).toString();
      } catch (error) {
        logger.warn('Error fetching WRF balance, returning default', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
          requestId: context.requestId,
        });
        return '0'; // Graceful degradation
      }
    },
    weatherStations: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const stations = await context.db.query.weatherStations.findMany({
          where: eq(weatherStations.ownerAddress, parent.address),
          limit: Math.min(first, 100),
          orderBy: desc(weatherStations.createdAt),
        });

        return stations.map(station => ({
          id: station.stationId,
          address: station.ownerAddress,
          stationId: station.stationId,
          location: station.location,
          isActive: station.isActive,
          lastRewardTime: station.lastRewardTime,
          totalRewards: station.totalRewards || '0',
          qualityScore: station.qualityScore || 100,
        }));
      } catch (error) {
        logger.error('Error fetching user weather stations', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    carbonCredits: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const credits = await context.db.query.carbonCredits.findMany({
          where: eq(carbonCredits.owner, parent.address),
          limit: Math.min(first, 100),
          orderBy: desc(carbonCredits.issuanceDate),
        });

        return credits.map(credit => ({
          id: credit.tokenId,
          tokenId: credit.tokenId,
          carbonOffset: credit.carbonOffset,
          projectType: credit.projectType,
          verificationStandard: credit.verificationStandard,
          issuanceDate: credit.issuanceDate,
          expiryDate: credit.expiryDate,
          location: credit.location,
          isRetired: credit.isRetired,
          issuer: credit.issuer,
          certificationHash: credit.certificationHash,
          forSale: credit.forSale || false,
          price: credit.price || '0',
          owner: credit.owner,
        }));
      } catch (error) {
        logger.error('Error fetching user carbon credits', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    computationalNFTs: async (
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

        return nfts.map(nft => {
          // Extract stakeAmount, computeProvider, and status from metadata if available
          const metadata = nft.metadata as Record<string, any> | null;

          return {
            id: nft.nftId,
            tokenId: nft.nftId,
            modelType: nft.computationType || 'WEATHER_FORECAST',
            modelName: nft.name,
            inputData: JSON.stringify(nft.inputData || {}),
            computeResources: JSON.stringify(nft.resourceRequirements || {}),
            executionTime: nft.computationComplexity || 0,
            // Get stakeAmount from metadata, blockchain data is loaded in field resolver
            stakeAmount: metadata?.stakeAmount || '0',
            // Status is stored in metadata since there's no status column
            status: metadata?.status || 'COMPLETED',
            resultData: nft.executionResultHash || null,
            resultHash: nft.executionResultHash || null,
            createdAt: nft.createdAt,
            executedAt: nft.updatedAt,
            // Get computeProvider from metadata, can be enhanced by field resolver
            computeProvider: metadata?.computeProvider || null,
            isVerified: nft.isVerified,
            owner: nft.creator,
          };
        });
      } catch (error) {
        logger.error('Error fetching user computational NFTs', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    carbonFootprint: async (parent: any, _: any, context: GraphQLContext) => {
      try {
        const footprint = await context.db.query.carbonFootprints.findFirst({
          where: eq(carbonFootprints.userId, parent.address),
          orderBy: desc(carbonFootprints.calculationDate),
        });

        if (!footprint) {
          return null;
        }

        return {
          id: footprint.id,
          user: footprint.userId,
          totalEmissions: footprint.totalEmissions,
          totalOffsets: footprint.totalOffsets,
          netEmissions: footprint.netEmissions,
          calculationDate: footprint.calculationDate,
          emissionSources: footprint.emissionSources,
          offsetSources: footprint.offsetSources,
          methodology: footprint.methodology,
          confidence: footprint.confidence,
        };
      } catch (error) {
        logger.error('Error fetching user carbon footprint', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },

    votes: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const userVotes = await context.db.query.votes.findMany({
          where: eq(votes.voter, parent.address),
          limit: Math.min(first, 100),
          orderBy: desc(votes.timestamp),
        });

        return userVotes.map(vote => ({
          id: vote.id,
          proposalId: vote.proposalId,
          voter: vote.voter,
          support: vote.support,
          weight: vote.weight,
          reason: vote.reason,
          timestamp: vote.timestamp,
          transactionHash: vote.transactionHash,
        }));
      } catch (error) {
        logger.error('Error fetching user votes', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    proposals: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const userProposals = await context.db.query.proposals.findMany({
          where: eq(proposals.proposer, parent.address),
          limit: Math.min(first, 100),
          orderBy: desc(proposals.submitTime),
        });

        return userProposals.map(proposal => ({
          id: proposal.id.toString(),
          proposalId: proposal.id.toString(),
          title: proposal.title,
          description: proposal.description,
          proposer: proposal.proposer,
          targets: proposal.targets || [],
          values: proposal.values || [],
          calldatas: proposal.calldatas || [],
          votingType: 'STANDARD', // Default for governance proposals
          votingDelay: 0, // Not in current schema
          votingPeriod: 0, // Not in current schema
          quorumFraction: 0, // Not in current schema
          emergencyProposal: false, // Not in current schema
          state: proposal.status || 'PENDING',
          startBlock: 0, // Not in current schema
          endBlock: 0, // Not in current schema
          forVotes: proposal.totalYes?.toString() || '0',
          againstVotes: proposal.totalNo?.toString() || '0',
          abstainVotes: proposal.totalAbstain?.toString() || '0',
          createdAt: proposal.submitTime,
          executedAt: proposal.executedAt || null,
        }));
      } catch (error) {
        logger.error('Error fetching user proposals', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    // User swap history from AMM
    swaps: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const swaps = await context.db.query.ammSwaps.findMany({
          where: eq(ammSwaps.user, parent.address),
          orderBy: desc(ammSwaps.timestamp),
          limit: Math.min(first, 50),
        });

        logger.info('Fetched user swaps', {
          address: parent.address,
          count: swaps.length,
        });

        return swaps.map(swap => ({
          id: swap.id,
          tokenIn: swap.tokenIn,
          tokenOut: swap.tokenOut,
          amountIn: swap.amountIn,
          amountOut: swap.amountOut,
          priceImpact: swap.priceImpact,
          fee: swap.fee,
          timestamp: swap.timestamp,
          transactionHash: swap.transactionHash,
          status: swap.status,
        }));
      } catch (error) {
        logger.error('Error fetching user swaps', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    // User liquidity positions in AMM pools
    liquidityPositions: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const positions = await context.db.query.liquidityPositions.findMany({
          where: and(
            eq(liquidityPositions.userId, parent.address),
            eq(liquidityPositions.status, 'active')
          ),
          orderBy: desc(liquidityPositions.createdAt),
          limit: Math.min(first, 50),
        });

        logger.info('Fetched user liquidity positions', {
          address: parent.address,
          count: positions.length,
        });

        return positions.map(pos => ({
          id: pos.id,
          poolId: pos.poolId,
          pairAddress: pos.pairAddress,
          token0Amount: pos.token0Amount,
          token1Amount: pos.token1Amount,
          lpTokens: pos.lpTokens,
          sharePercentage: pos.sharePercentage,
          entryPrice: pos.entryPrice,
          status: pos.status,
          createdAt: pos.createdAt,
          updatedAt: pos.updatedAt,
        }));
      } catch (error) {
        logger.error('Error fetching user liquidity positions', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    // User staking positions
    stakingPositions: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        const positions = await context.db.query.stakingDeposits.findMany({
          where: eq(stakingDeposits.userId, parent.address),
          orderBy: desc(stakingDeposits.depositedAt),
          limit: Math.min(first, 50),
        });

        logger.info('Fetched user staking positions', {
          address: parent.address,
          count: positions.length,
        });

        return positions.map(pos => ({
          id: pos.id,
          validatorId: pos.validatorId,
          amount: pos.amount,
          lockupPeriod: pos.lockupPeriod,
          depositedAt: pos.depositedAt,
          unlocksAt: pos.unlocksAt,
          status: pos.status,
          transactionHash: pos.transactionHash,
        }));
      } catch (error) {
        logger.error('Error fetching user staking positions', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },

    // User rewards (combines compute rewards and staking rewards)
    rewards: async (
      parent: any,
      { first = 10 }: { first?: number },
      context: GraphQLContext
    ) => {
      try {
        // Fetch both compute rewards and staking rewards concurrently
        const [computeRewardsData, stakingRewardsData] = await Promise.all([
          context.db.query.computeRewards.findMany({
            where: eq(computeRewards.computeProvider, parent.address),
            orderBy: desc(computeRewards.createdAt),
            limit: Math.min(first, 25),
          }),
          context.db.query.stakingRewards.findMany({
            where: eq(stakingRewards.stakerId, parent.address),
            orderBy: desc(stakingRewards.createdAt),
            limit: Math.min(first, 25),
          }),
        ]);

        // Normalize compute rewards format (computeRewards schema has rewardAmount, not amount)
        const normalizedComputeRewards = computeRewardsData.map(r => ({
          id: `compute-${r.id}`,
          amount: r.rewardAmount,
          rewardType: 'compute',
          period: null,
          claimedAt: r.distributedAt,
          createdAt: r.createdAt,
          transactionHash: r.transactionHash,
          source: 'computational_nft',
        }));

        // Normalize staking rewards format
        const normalizedStakingRewards = stakingRewardsData.map(r => ({
          id: `staking-${r.id}`,
          amount: r.amount,
          rewardType: r.rewardType || 'staking',
          period: r.period,
          claimedAt: r.claimedAt,
          createdAt: r.createdAt,
          transactionHash: r.transactionHash,
          source: 'staking',
        }));

        // Merge and sort by creation date (newest first)
        const allRewards = [...normalizedComputeRewards, ...normalizedStakingRewards]
          .sort((a, b) => {
            const dateA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
            const dateB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
            return dateB - dateA;
          })
          .slice(0, first);

        logger.info('Fetched user rewards', {
          address: parent.address,
          computeCount: computeRewardsData.length,
          stakingCount: stakingRewardsData.length,
          totalReturned: allRewards.length,
        });

        return allRewards;
      } catch (error) {
        logger.error('Error fetching user rewards', {
          address: parent.address,
          error: error instanceof Error ? error.message : String(error),
        });
        return [];
      }
    },
  },
};
