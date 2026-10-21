/**
 * Performance Benchmarks Test Suite - Task 57.6
 * Comprehensive performance tests for all Task 57 GraphQL implementations
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
import { performance } from 'perf_hooks';
import { typeDefs } from '../../schema/typeDefs.js';
import { resolvers } from '../../resolvers/index.js';
import { createMockContext, expectGraphQLSuccess } from '../mocks/datasource.js';
import { GraphQLContext } from '../../context.js';

// Performance test utilities
interface PerformanceResult {
  duration: number;
  memoryUsage: NodeJS.MemoryUsage;
  operationsPerSecond: number;
}

const measurePerformance = async (
  operation: () => Promise<any>
): Promise<PerformanceResult> => {
  const startTime = performance.now();
  const startMemory = process.memoryUsage();

  await operation();

  const endTime = performance.now();
  const endMemory = process.memoryUsage();

  const duration = endTime - startTime;
  const memoryUsage = {
    rss: endMemory.rss - startMemory.rss,
    heapTotal: endMemory.heapTotal - startMemory.heapTotal,
    heapUsed: endMemory.heapUsed - startMemory.heapUsed,
    external: endMemory.external - startMemory.external,
    arrayBuffers: endMemory.arrayBuffers - startMemory.arrayBuffers,
  };

  return {
    duration,
    memoryUsage,
    operationsPerSecond: 1000 / duration,
  };
};

const runConcurrentOperations = async (
  operation: () => Promise<any>,
  concurrency: number
): Promise<PerformanceResult[]> => {
  const promises = Array.from({ length: concurrency }, () =>
    measurePerformance(operation)
  );

  return Promise.all(promises);
};

describe('Performance Benchmarks Test Suite', () => {
  let server: ApolloServer<GraphQLContext>;
  let mockContext: any;
  let mockDb: any;
  let mockContracts: any;

  // Test data generators for performance testing
  const generateLargeUserDataset = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      username: `user${i}`,
      email: `user${i}@example.com`,
      walletAddress: `0x${i.toString().padStart(40, '0')}`,
      displayName: `User ${i}`,
      bio: `Bio for user ${i}`,
      isVerified: i % 2 === 0,
      createdAt: new Date(Date.now() - i * 86400000), // Staggered creation dates
      lastActiveAt: new Date(),
    }));

  const generateLargeCarbonCreditDataset = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `cc-${i}`,
      tokenId: i.toString(),
      owner: `0x${(i % 100).toString().padStart(40, '0')}`,
      carbonOffset: (Math.random() * 100).toFixed(8),
      projectType: ['renewable_energy', 'forestry', 'weather_monitoring'][
        i % 3
      ],
      verificationStandard: ['VCS', 'Gold Standard', 'CDM'][i % 3],
      issuanceDate: new Date(2024, 0, 1),
      isRetired: i % 10 === 0,
      forSale: i % 5 === 0,
      price: i % 5 === 0 ? (Math.random() * 1000).toFixed(2) : null,
      createdAt: new Date(),
    }));

  const generateLargeComputationalNFTDataset = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      nftId: i.toString(),
      creator: `0x${(i % 50).toString().padStart(40, '0')}`,
      name: `Compute Job ${i}`,
      computationType: ['WEATHER_FORECAST', 'CLIMATE_MODEL', 'CARBON_ANALYSIS'][
        i % 3
      ],
      inputData: JSON.stringify({ input: `data-${i}` }),
      resourceRequirements: JSON.stringify({
        cpu: (i % 8) + 1,
        memory: `${((i % 16) + 1) * 2}GB`,
      }),
      isVerified: i % 3 === 0,
      createdAt: new Date(Date.now() - i * 3600000), // Staggered by hours
    }));

  const generateLargeAMMPairDataset = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: `pair-${i}`,
      pairAddress: `0x${i.toString().padStart(40, '0')}`,
      token0: `0x${'1'.repeat(40)}`,
      token1: `0x${(i + 1).toString().padStart(40, '0')}`,
      reserve0: (BigInt(1000 + i) * BigInt(10) ** BigInt(18)).toString(),
      reserve1: (BigInt(50000 + i * 100) * BigInt(10) ** BigInt(6)).toString(),
      totalLiquidity: (
        BigInt(Math.sqrt((1000 + i) * (50000 + i * 100))) *
        BigInt(10) ** BigInt(18)
      ).toString(),
      volume24h: (
        BigInt(Math.random() * 1000) *
        BigInt(10) ** BigInt(18)
      ).toString(),
      isActive: true,
      createdAt: new Date(),
    }));

  beforeAll(async () => {
    // Create optimized mock database for performance testing
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
    };

    // Create mock contracts with realistic response times
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
    });

    mockContext = {
      ...createMockContext(),
      db: mockDb,
      contracts: mockContracts,
      requestId: 'perf-test-request-id',
      clientIP: '127.0.0.1',
    };
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default mock responses with realistic delays
    mockDb.query.users.findFirst.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(null), 10)) // 10ms DB delay
    );
    mockDb.query.users.findMany.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve([]), 15)) // 15ms for complex queries
    );
    mockContracts.wrfToken.balanceOf.mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve(BigInt(0)), 50)) // 50ms blockchain delay
    );
  });

  afterAll(async () => {
    await server?.stop();
  });

  describe('Single Operation Performance', () => {
    describe('User Queries', () => {
      it('should handle user profile query within performance threshold', async () => {
        // Arrange
        const testUser = {
          walletAddress: '0x1234567890123456789012345678901234567890',
          username: 'testuser',
          email: 'test@example.com',
          isVerified: true,
          createdAt: new Date(),
        };

        mockDb.query.users.findFirst.mockResolvedValue(testUser);
        mockContracts.wrfToken.balanceOf.mockResolvedValue(
          BigInt('1000000000000000000')
        );

        // Act
        const result = await measurePerformance(async () => {
          return server.executeOperation(
            {
              query: gql`
                query Me {
                  me {
                    id
                    address
                    username
                    email
                    wrfBalance
                    isVerified
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
        });

        // Assert
        expect(result.duration).toBeLessThan(500); // Should complete within 500ms
        expect(result.memoryUsage.heapUsed).toBeLessThan(50 * 1024 * 1024); // Less than 50MB heap growth
        expect(result.operationsPerSecond).toBeGreaterThan(2); // At least 2 ops/sec

        console.log('User profile query performance:', {
          duration: `${result.duration.toFixed(2)}ms`,
          opsPerSec: result.operationsPerSecond.toFixed(2),
          memoryMB: (result.memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
        });
      });

      it('should handle large user list query efficiently', async () => {
        // Arrange
        const largeUserList = generateLargeUserDataset(1000);
        mockDb.query.users.findMany.mockResolvedValue(largeUserList);

        // Act
        const result = await measurePerformance(async () => {
          return server.executeOperation(
            {
              query: gql`
                query Users {
                  users(first: 100) {
                    id
                    address
                    username
                    isVerified
                  }
                }
              `,
            },
            {
              contextValue: mockContext,
            }
          );
        });

        // Assert
        expect(result.duration).toBeLessThan(1000); // Should complete within 1 second
        expect(result.memoryUsage.heapUsed).toBeLessThan(100 * 1024 * 1024); // Less than 100MB

        console.log('Large user list query performance:', {
          duration: `${result.duration.toFixed(2)}ms`,
          opsPerSec: result.operationsPerSecond.toFixed(2),
          memoryMB: (result.memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
        });
      });
    });

    describe('Carbon Credits Queries', () => {
      it('should handle carbon credits query with complex filtering', async () => {
        // Arrange
        const largeCreditList = generateLargeCarbonCreditDataset(500);
        mockDb.query.users.findFirst.mockResolvedValue({
          walletAddress: '0x1234567890123456789012345678901234567890',
          username: 'testuser',
        });
        mockDb.query.carbonCredits.findMany.mockResolvedValue(
          largeCreditList.slice(0, 50)
        );

        // Act
        const result = await measurePerformance(async () => {
          return server.executeOperation(
            {
              query: gql`
                query UserCarbonCredits($address: String!) {
                  user(address: $address) {
                    carbonCredits(first: 50) {
                      id
                      tokenId
                      carbonOffset
                      projectType
                      verificationStandard
                      isRetired
                      forSale
                      price
                    }
                  }
                }
              `,
              variables: {
                address: '0x1234567890123456789012345678901234567890',
              },
            },
            {
              contextValue: mockContext,
            }
          );
        });

        // Assert
        expect(result.duration).toBeLessThan(800); // Should complete within 800ms
        expect(result.memoryUsage.heapUsed).toBeLessThan(75 * 1024 * 1024); // Less than 75MB

        console.log('Carbon credits query performance:', {
          duration: `${result.duration.toFixed(2)}ms`,
          opsPerSec: result.operationsPerSecond.toFixed(2),
          memoryMB: (result.memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
        });
      });
    });

    describe('Computational NFT Queries', () => {
      it('should handle computational NFT query with blockchain fallback', async () => {
        // Arrange
        const testNFT = {
          nftId: '1',
          creator: '0x1234567890123456789012345678901234567890',
          name: 'Test NFT',
          computationType: 'WEATHER_FORECAST',
          isVerified: true,
          createdAt: new Date(),
        };

        mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);

        // Simulate blockchain delay
        mockContracts.computationalNFT.getComputeJob.mockImplementation(
          () => new Promise(resolve => setTimeout(() => resolve([]), 100))
        );
        mockContracts.computationalNFT.ownerOf.mockImplementation(
          () =>
            new Promise(resolve =>
              setTimeout(
                () => resolve('0x1234567890123456789012345678901234567890'),
                100
              )
            )
        );

        // Act
        const result = await measurePerformance(async () => {
          return server.executeOperation(
            {
              query: gql`
                query ComputationalNFT($id: String!) {
                  computationalNFT(id: $id) {
                    id
                    tokenId
                    modelType
                    modelName
                    status
                    owner
                    isVerified
                  }
                }
              `,
              variables: { id: '1' },
            },
            {
              contextValue: mockContext,
            }
          );
        });

        // Assert
        expect(result.duration).toBeLessThan(1000); // Should complete within 1 second (including blockchain calls)
        expect(result.memoryUsage.heapUsed).toBeLessThan(50 * 1024 * 1024); // Less than 50MB

        console.log('Computational NFT query performance:', {
          duration: `${result.duration.toFixed(2)}ms`,
          opsPerSec: result.operationsPerSecond.toFixed(2),
          memoryMB: (result.memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
        });
      });

      it('should handle computational NFT list query efficiently', async () => {
        // Arrange
        const largeNFTList = generateLargeComputationalNFTDataset(200);
        mockDb.query.computationalNfts.findMany.mockResolvedValue(largeNFTList);

        // Act
        const result = await measurePerformance(async () => {
          return server.executeOperation(
            {
              query: gql`
                query ComputationalNFTs {
                  computationalNFTs(first: 50) {
                    id
                    tokenId
                    modelType
                    modelName
                    status
                    owner
                    isVerified
                  }
                }
              `,
            },
            {
              contextValue: mockContext,
            }
          );
        });

        // Assert
        expect(result.duration).toBeLessThan(600); // Should complete within 600ms
        expect(result.memoryUsage.heapUsed).toBeLessThan(60 * 1024 * 1024); // Less than 60MB

        console.log('Computational NFT list query performance:', {
          duration: `${result.duration.toFixed(2)}ms`,
          opsPerSec: result.operationsPerSecond.toFixed(2),
          memoryMB: (result.memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
        });
      });
    });

    describe('AMM Queries', () => {
      it('should handle AMM pool query with blockchain data integration', async () => {
        // Arrange
        const testPair = {
          pairAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          token0: '0x1111111111111111111111111111111111111111',
          token1: '0x2222222222222222222222222222222222222222',
          totalLiquidity: '1000000000000000000000',
          isActive: true,
          createdAt: new Date(),
        };

        mockDb.query.ammPairs.findFirst.mockResolvedValue(testPair);

        // Simulate blockchain calls
        mockContracts.carbonCreditAMM.getPairInfo.mockImplementation(
          () =>
            new Promise(resolve =>
              setTimeout(
                () => resolve([testPair.token0, testPair.token1, true]),
                80
              )
            )
        );
        mockContracts.carbonCreditAMM.getReserves.mockImplementation(
          () =>
            new Promise(resolve =>
              setTimeout(
                () =>
                  resolve([
                    BigInt('1000000000000000000000'),
                    BigInt('50000000000'),
                  ]),
                80
              )
            )
        );

        // Act
        const result = await measurePerformance(async () => {
          return server.executeOperation(
            {
              query: gql`
                query AMMPool($id: String!) {
                  ammPool(id: $id) {
                    id
                    pairAddress
                    token0
                    token1
                    reserve0
                    reserve1
                    totalLiquidity
                    volume24h
                  }
                }
              `,
              variables: { id: testPair.pairAddress },
            },
            {
              contextValue: mockContext,
            }
          );
        });

        // Assert
        expect(result.duration).toBeLessThan(1200); // Should complete within 1.2 seconds
        expect(result.memoryUsage.heapUsed).toBeLessThan(40 * 1024 * 1024); // Less than 40MB

        console.log('AMM pool query performance:', {
          duration: `${result.duration.toFixed(2)}ms`,
          opsPerSec: result.operationsPerSecond.toFixed(2),
          memoryMB: (result.memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
        });
      });

      it('should handle AMM pools list query efficiently', async () => {
        // Arrange
        const largePairList = generateLargeAMMPairDataset(100);
        mockDb.query.ammPairs.findMany.mockResolvedValue(largePairList);

        // Act
        const result = await measurePerformance(async () => {
          return server.executeOperation(
            {
              query: gql`
                query AMMPools {
                  ammPools(
                    first: 50
                    orderBy: "totalLiquidity"
                    orderDirection: "desc"
                  ) {
                    id
                    pairAddress
                    token0
                    token1
                    totalLiquidity
                    volume24h
                    swapFee
                  }
                }
              `,
            },
            {
              contextValue: mockContext,
            }
          );
        });

        // Assert
        expect(result.duration).toBeLessThan(500); // Should complete within 500ms
        expect(result.memoryUsage.heapUsed).toBeLessThan(50 * 1024 * 1024); // Less than 50MB

        console.log('AMM pools list query performance:', {
          duration: `${result.duration.toFixed(2)}ms`,
          opsPerSec: result.operationsPerSecond.toFixed(2),
          memoryMB: (result.memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
        });
      });
    });
  });

  describe('Concurrent Operations Performance', () => {
    it('should handle concurrent user queries efficiently', async () => {
      // Arrange
      const testUser = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        username: 'testuser',
        isVerified: true,
        createdAt: new Date(),
      };

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockContracts.wrfToken.balanceOf.mockResolvedValue(
        BigInt('1000000000000000000')
      );

      const operation = () =>
        server.executeOperation(
          {
            query: gql`
              query Me {
                me {
                  id
                  username
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

      // Act - Run 10 concurrent operations
      const startTime = performance.now();
      const results = await runConcurrentOperations(operation, 10);
      const totalTime = performance.now() - startTime;

      // Assert
      const avgDuration =
        results.reduce((sum, r) => sum + r.duration, 0) / results.length;
      const maxDuration = Math.max(...results.map(r => r.duration));
      const totalOpsPerSec = (10 * 1000) / totalTime;

      expect(avgDuration).toBeLessThan(1000); // Average operation under 1 second
      expect(maxDuration).toBeLessThan(2000); // No operation over 2 seconds
      expect(totalOpsPerSec).toBeGreaterThan(5); // At least 5 ops/sec total throughput

      console.log('Concurrent user queries performance:', {
        avgDuration: `${avgDuration.toFixed(2)}ms`,
        maxDuration: `${maxDuration.toFixed(2)}ms`,
        totalOpsPerSec: totalOpsPerSec.toFixed(2),
        totalTime: `${totalTime.toFixed(2)}ms`,
      });
    });

    it('should handle mixed query types concurrently', async () => {
      // Arrange
      mockDb.query.users.findFirst.mockResolvedValue({
        walletAddress: '0x1234567890123456789012345678901234567890',
        username: 'testuser',
      });
      mockDb.query.ammPairs.findFirst.mockResolvedValue({
        pairAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        token0: '0x1111111111111111111111111111111111111111',
        token1: '0x2222222222222222222222222222222222222222',
      });
      mockDb.query.computationalNfts.findFirst.mockResolvedValue({
        nftId: '1',
        creator: '0x1234567890123456789012345678901234567890',
        name: 'Test NFT',
        computationType: 'WEATHER_FORECAST',
      });

      const userQuery = () =>
        server.executeOperation(
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
              user: { address: '0x1234567890123456789012345678901234567890' },
              isAuthenticated: true,
            },
          }
        );

      const ammQuery = () =>
        server.executeOperation(
          {
            query: gql`
              query AMMPool {
                ammPool(id: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
                  id
                  token0
                }
              }
            `,
          },
          { contextValue: mockContext }
        );

      const nftQuery = () =>
        server.executeOperation(
          {
            query: gql`
              query ComputationalNFT {
                computationalNFT(id: "1") {
                  id
                  modelType
                }
              }
            `,
          },
          { contextValue: mockContext }
        );

      // Act - Run mixed concurrent operations
      const startTime = performance.now();
      const promises = [
        ...Array.from({ length: 5 }, userQuery),
        ...Array.from({ length: 3 }, ammQuery),
        ...Array.from({ length: 2 }, nftQuery),
      ];

      const results = await Promise.allSettled(
        promises.map(p => measurePerformance(() => p))
      );
      const totalTime = performance.now() - startTime;

      // Assert
      const successfulResults = results.filter(
        r => r.status === 'fulfilled'
      ) as PromiseFulfilledResult<PerformanceResult>[];
      const avgDuration =
        successfulResults.reduce((sum, r) => sum + r.value.duration, 0) /
        successfulResults.length;
      const totalOpsPerSec = (promises.length * 1000) / totalTime;

      expect(successfulResults.length).toBe(promises.length); // All operations should succeed
      expect(avgDuration).toBeLessThan(1500); // Average under 1.5 seconds
      expect(totalOpsPerSec).toBeGreaterThan(3); // At least 3 ops/sec total throughput

      console.log('Mixed concurrent queries performance:', {
        successfulOps: successfulResults.length,
        avgDuration: `${avgDuration.toFixed(2)}ms`,
        totalOpsPerSec: totalOpsPerSec.toFixed(2),
        totalTime: `${totalTime.toFixed(2)}ms`,
      });
    });
  });

  describe('Large Dataset Performance', () => {
    it('should handle pagination efficiently with large datasets', async () => {
      // Test pagination performance with different page sizes
      const pageSizes = [10, 25, 50, 100];
      const largeUserList = generateLargeUserDataset(10000);

      for (const pageSize of pageSizes) {
        mockDb.query.users.findMany.mockResolvedValue(
          largeUserList.slice(0, pageSize)
        );

        const result = await measurePerformance(async () => {
          return server.executeOperation(
            {
              query: gql`
                query Users($first: Int) {
                  users(first: $first) {
                    id
                    username
                    isVerified
                  }
                }
              `,
              variables: { first: pageSize },
            },
            {
              contextValue: mockContext,
            }
          );
        });

        // Assert that performance scales reasonably with page size
        const expectedMaxDuration = 200 + pageSize * 2; // Base time + 2ms per item
        expect(result.duration).toBeLessThan(expectedMaxDuration);

        console.log(`Pagination performance (pageSize ${pageSize}):`, {
          duration: `${result.duration.toFixed(2)}ms`,
          opsPerSec: result.operationsPerSecond.toFixed(2),
          memoryMB: (result.memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
        });
      }
    });

    it('should handle complex nested queries efficiently', async () => {
      // Arrange complex nested data
      const testUser = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        username: 'testuser',
        isVerified: true,
        createdAt: new Date(),
      };

      const carbonCredits = generateLargeCarbonCreditDataset(20);
      const computationalNFTs = generateLargeComputationalNFTDataset(15);

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.carbonCredits.findMany.mockResolvedValue(carbonCredits);
      mockDb.query.computationalNfts.findMany.mockResolvedValue(
        computationalNFTs
      );
      mockDb.query.carbonFootprints.findFirst.mockResolvedValue({
        id: 'cf-1',
        userId: testUser.walletAddress,
        totalEmissions: '25.7',
        netEmissions: '15.2',
        calculationDate: new Date(),
      });

      // Act
      const result = await measurePerformance(async () => {
        return server.executeOperation(
          {
            query: gql`
              query ComplexUserQuery($address: String!) {
                user(address: $address) {
                  id
                  username
                  carbonCredits(first: 20) {
                    id
                    tokenId
                    carbonOffset
                    projectType
                    verificationStandard
                  }
                  computationalNFTs(first: 15) {
                    id
                    tokenId
                    modelType
                    modelName
                    status
                  }
                  carbonFootprint {
                    id
                    totalEmissions
                    netEmissions
                    calculationDate
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
      });

      // Assert
      expect(result.duration).toBeLessThan(2000); // Complex query under 2 seconds
      expect(result.memoryUsage.heapUsed).toBeLessThan(150 * 1024 * 1024); // Less than 150MB

      console.log('Complex nested query performance:', {
        duration: `${result.duration.toFixed(2)}ms`,
        opsPerSec: result.operationsPerSecond.toFixed(2),
        memoryMB: (result.memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
      });
    });
  });

  describe('Memory Management Performance', () => {
    it('should manage memory efficiently during repeated operations', async () => {
      // Setup for memory leak detection
      const initialMemory = process.memoryUsage();
      const testUser = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        username: 'testuser',
      };

      mockDb.query.users.findFirst.mockResolvedValue(testUser);

      // Perform many operations to test for memory leaks
      const operations = 100;
      const memorySnapshots: number[] = [];

      for (let i = 0; i < operations; i++) {
        await server.executeOperation(
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

        if (i % 20 === 0) {
          // Force garbage collection if available
          if (global.gc) {
            global.gc();
          }
          memorySnapshots.push(process.memoryUsage().heapUsed);
        }
      }

      // Assert memory growth is reasonable
      const memoryGrowth =
        memorySnapshots[memorySnapshots.length - 1] - memorySnapshots[0];
      const maxAllowedGrowth = 50 * 1024 * 1024; // 50MB max growth

      expect(memoryGrowth).toBeLessThan(maxAllowedGrowth);

      console.log('Memory management test:', {
        operations,
        initialMemoryMB: (initialMemory.heapUsed / (1024 * 1024)).toFixed(2),
        finalMemoryMB: (
          memorySnapshots[memorySnapshots.length - 1] /
          (1024 * 1024)
        ).toFixed(2),
        memoryGrowthMB: (memoryGrowth / (1024 * 1024)).toFixed(2),
      });
    });

    it('should handle garbage collection efficiently with large responses', async () => {
      // Test with large response payloads
      const largeDataset = generateLargeUserDataset(1000);
      mockDb.query.users.findMany.mockResolvedValue(largeDataset);

      const memoryBefore = process.memoryUsage();

      // Perform operation with large response
      await server.executeOperation(
        {
          query: gql`
            query Users {
              users(first: 100) {
                id
                username
                email
                walletAddress
                displayName
                bio
                isVerified
              }
            }
          `,
        },
        {
          contextValue: mockContext,
        }
      );

      const memoryAfter = process.memoryUsage();
      const memoryGrowth = memoryAfter.heapUsed - memoryBefore.heapUsed;

      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const memoryAfterGC = process.memoryUsage();
      const memoryReclaimed = memoryAfter.heapUsed - memoryAfterGC.heapUsed;

      console.log('Garbage collection efficiency:', {
        memoryGrowthMB: (memoryGrowth / (1024 * 1024)).toFixed(2),
        memoryReclaimedMB: (memoryReclaimed / (1024 * 1024)).toFixed(2),
        gcEfficiency: `${((memoryReclaimed / memoryGrowth) * 100).toFixed(1)}%`,
      });

      // Assert that a significant portion of memory can be reclaimed
      expect(memoryReclaimed / memoryGrowth).toBeGreaterThan(0.3); // At least 30% should be reclaimable
    });
  });

  describe('Error Handling Performance', () => {
    it('should handle errors efficiently without performance degradation', async () => {
      // Test error handling performance
      mockDb.query.users.findFirst.mockRejectedValue(
        new Error('Database error')
      );

      const result = await measurePerformance(async () => {
        return server.executeOperation(
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
      });

      // Assert that error handling is still fast
      expect(result.duration).toBeLessThan(300); // Error handling under 300ms
      expect(result.memoryUsage.heapUsed).toBeLessThan(20 * 1024 * 1024); // Less than 20MB

      console.log('Error handling performance:', {
        duration: `${result.duration.toFixed(2)}ms`,
        opsPerSec: result.operationsPerSecond.toFixed(2),
        memoryMB: (result.memoryUsage.heapUsed / (1024 * 1024)).toFixed(2),
      });
    });

    it('should handle timeout scenarios efficiently', async () => {
      // Test timeout handling performance
      mockContracts.wrfToken.balanceOf.mockImplementation(
        () =>
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Timeout')), 100)
          )
      );

      const testUser = {
        walletAddress: '0x1234567890123456789012345678901234567890',
        username: 'testuser',
        isVerified: true,
        createdAt: new Date(),
      };

      mockDb.query.users.findFirst.mockResolvedValue(testUser);

      const result = await measurePerformance(async () => {
        return server.executeOperation(
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
      });

      // Assert that timeout handling doesn't significantly impact performance
      expect(result.duration).toBeLessThan(500); // Timeout handling under 500ms

      console.log('Timeout handling performance:', {
        duration: `${result.duration.toFixed(2)}ms`,
        opsPerSec: result.operationsPerSecond.toFixed(2),
      });
    });
  });

  describe('Performance Regression Tests', () => {
    it('should maintain consistent performance across operation types', async () => {
      // Test consistent performance across different operation types
      const operations = [
        {
          name: 'User Query',
          operation: () =>
            server.executeOperation(
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
                  user: {
                    address: '0x1234567890123456789012345678901234567890',
                  },
                  isAuthenticated: true,
                },
              }
            ),
        },
        {
          name: 'AMM Query',
          operation: () =>
            server.executeOperation(
              {
                query: gql`
                  query AMMPools {
                    ammPools(first: 10) {
                      id
                      totalLiquidity
                    }
                  }
                `,
              },
              { contextValue: mockContext }
            ),
        },
        {
          name: 'NFT Query',
          operation: () =>
            server.executeOperation(
              {
                query: gql`
                  query ComputationalNFTs {
                    computationalNFTs(first: 10) {
                      id
                      modelType
                    }
                  }
                `,
              },
              { contextValue: mockContext }
            ),
        },
      ];

      // Setup mocks
      mockDb.query.users.findFirst.mockResolvedValue({
        walletAddress: '0x1234567890123456789012345678901234567890',
        username: 'testuser',
      });
      mockDb.query.ammPairs.findMany.mockResolvedValue([]);
      mockDb.query.computationalNfts.findMany.mockResolvedValue([]);

      const results: { name: string; performance: PerformanceResult }[] = [];

      for (const op of operations) {
        const perf = await measurePerformance(op.operation);
        results.push({ name: op.name, performance: perf });
      }

      // Assert performance consistency
      const durations = results.map(r => r.performance.duration);
      const avgDuration =
        durations.reduce((sum, d) => sum + d, 0) / durations.length;
      const maxVariation = Math.max(...durations) - Math.min(...durations);

      expect(maxVariation).toBeLessThan(avgDuration * 2); // Variation should be less than 2x average

      console.log('Performance consistency across operations:');
      results.forEach(result => {
        console.log(
          `  ${result.name}: ${result.performance.duration.toFixed(2)}ms`
        );
      });
      console.log(
        `  Average: ${avgDuration.toFixed(2)}ms, Variation: ${maxVariation.toFixed(2)}ms`
      );
    });
  });
});
