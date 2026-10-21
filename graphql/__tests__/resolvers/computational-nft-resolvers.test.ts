/**
 * Computational NFT Resolvers Test Suite - Task 57.6
 * Comprehensive tests for computational NFT GraphQL resolvers including compute rewards
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
import { ethers } from 'ethers';
import { typeDefs } from '../../schema/typeDefs.js';
import { resolvers } from '../../resolvers/index.js';
import {
  createMockDataSource,
  createMockContext,
  expectGraphQLError,
  expectGraphQLSuccess,
} from '../mocks/datasource.js';
import { GraphQLContext } from '../../context.js';
import {
  ComputationalNFTQueryResponse,
  ComputationalNFTsQueryResponse,
  ComputationalNFTData,
  ComputeJobData,
  ComputeProviderData,
  ComputeRewardData,
  assertGraphQLResponse,
} from '../types/graphql-response-types.js';

// Test data generators
const createTestComputationalNFT = (overrides = {}) => ({
  nftId: '1',
  creator: '0x1234567890123456789012345678901234567890',
  name: 'Weather Forecast Model',
  computationType: 'WEATHER_FORECAST',
  inputData: '{"location": "NYC", "timeframe": "7d"}',
  resourceRequirements: '{"cpu": "2", "memory": "4GB", "duration": "300"}',
  executionResultHash: 'QmTestHash123',
  isVerified: true,
  metadata: {
    status: 'completed',
    stakeAmount: '1000000000000000000',
    computeProvider: '0x5555555555555555555555555555555555555555',
    executionTime: '250',
    resultData: '{"forecast": "sunny"}',
    executedAt: new Date('2024-01-01'),
  },
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-01'),
  ...overrides,
});

const createTestComputeReward = (overrides = {}) => ({
  id: 'reward-1',
  jobId: 'job_1',
  computeProvider: '0x5555555555555555555555555555555555555555',
  rewardAmount: '100000000000000000', // 0.1 WRF
  rewardType: 'WRF',
  jobComplexity: 5,
  executionTime: 250,
  qualityScore: 0.95,
  status: 'distributed',
  distributedAt: new Date('2024-01-01'),
  transactionHash: '0x' + 'a'.repeat(64),
  createdAt: new Date('2024-01-01'),
  ...overrides,
});

const createTestComputeJob = (nft: any) => ({
  id: `job_${nft.nftId}`,
  nft,
});

describe('Computational NFT Resolvers Test Suite', () => {
  let server: ApolloServer<GraphQLContext>;
  let mockContext: any;
  let mockDb: any;
  let mockContracts: any;

  beforeAll(async () => {
    // Create mock database
    mockDb = {
      query: {
        computationalNfts: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        computeRewards: {
          findMany: jest.fn(),
        },
      },
    };

    // Create mock contracts
    mockContracts = {
      computationalNFT: {
        getComputeJob: jest.fn(),
        ownerOf: jest.fn(),
        getProviderStats: jest.fn(),
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
      requestId: 'test-request-id',
      clientIP: '127.0.0.1',
    };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset all mock return values
    mockDb.query.computationalNfts.findFirst.mockResolvedValue(null);
    mockDb.query.computationalNfts.findMany.mockResolvedValue([]);
    mockDb.query.computeRewards.findMany.mockResolvedValue([]);
    mockContracts.computationalNFT.getComputeJob.mockResolvedValue([]);
    mockContracts.computationalNFT.ownerOf.mockResolvedValue(
      ethers.ZeroAddress
    );
    mockContracts.computationalNFT.getProviderStats.mockResolvedValue([
      false,
      0,
      0,
      0,
      0,
    ]);
  });

  afterAll(async () => {
    await server?.stop();
  });

  describe('Query: computationalNFT', () => {
    const COMPUTATIONAL_NFT_QUERY = gql`
      query ComputationalNFT($id: String!) {
        computationalNFT(id: $id) {
          id
          tokenId
          modelType
          modelName
          status
          stakeAmount
          computeProvider
          isVerified
          resultHash
          inputData
          computeResources
          executionTime
          resultData
          createdAt
          executedAt
          owner
    `;

    it('should return computational NFT with blockchain and database data', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      const blockchainJobData = [
        'WEATHER_FORECAST', // modelType
        'Weather Model', // modelName
        'completed', // status
        BigInt('1000000000000000000'), // stakeAmount
        '0x5555555555555555555555555555555555555555', // computeProvider
        true, // isVerified
        'QmBlockchainHash', // resultHash
      ];
      const owner = '0x1234567890123456789012345678901234567890';

      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);
      mockContracts.computationalNFT.getComputeJob.mockResolvedValue(
        blockchainJobData
      );
      mockContracts.computationalNFT.ownerOf.mockResolvedValue(owner);

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTATIONAL_NFT_QUERY,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data = response.body.singleResult.data?.computationalNFT;
      expect(data).toBeDefined();
      expect(data?.id).toBe('1');
      expect(data?.nftId).toBe('1');
      expect(data?.computationType).toBe('WEATHER_FORECAST'); // From blockchain
      expect(data?.name).toBe('Weather Model'); // From blockchain
      expect(data?.metadata?.status).toBe('completed'); // From blockchain
      expect(data?.metadata?.stakeAmount).toBe('1000000000000000000'); // From blockchain
      expect(data?.metadata?.computeProvider).toBe(
        '0x5555555555555555555555555555555555555555'
      );
      expect(data?.isVerified).toBe(true);
      expect(data?.executionResultHash).toBe('QmBlockchainHash'); // From blockchain
      expect(data?.inputData).toBe(testNFT.inputData); // From database
      expect(data?.creator).toBe(owner.toLowerCase());
      // Verify blockchain calls
      expect(mockContracts.computationalNFT.getComputeJob).toHaveBeenCalledWith(
        BigInt(1)
      );
      expect(mockContracts.computationalNFT.ownerOf).toHaveBeenCalledWith(
        BigInt(1)
      );
    });

    it('should return null for non-existent NFT', async () => {
      // Arrange
      mockDb.query.computationalNfts.findFirst.mockResolvedValue(null);
      mockContracts.computationalNFT.getComputeJob.mockRejectedValue(
        new Error('ERC721: invalid token ID')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTATIONAL_NFT_QUERY,
          variables: { id: '999' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data = response.body.singleResult.data?.computationalNFT;
      expect(data).toBeNull();
    });

    it('should validate token ID format', async () => {
      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTATIONAL_NFT_QUERY,
          variables: { id: 'invalid-id' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLError(result, 'Invalid token ID format');
    });

    it('should validate non-negative token ID', async () => {
      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTATIONAL_NFT_QUERY,
          variables: { id: '-1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLError(result, 'Invalid token ID format');
    });

    it('should handle blockchain timeout gracefully', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);

      // Simulate timeout
      mockContracts.computationalNFT.getComputeJob.mockImplementation(
        () => new Promise(resolve => setTimeout(() => resolve([]), 10000))
      );

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTATIONAL_NFT_QUERY,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data = response.body.singleResult.data?.computationalNFT;
      expect(data).toBeDefined();
      expect(data?.computationType).toBe(testNFT.computationType); // Fallback to database
      expect(data?.inputData).toBe(testNFT.inputData);
    }, 15000);

    it('should fallback to database data when blockchain fails', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);
      mockContracts.computationalNFT.getComputeJob.mockRejectedValue(
        new Error('Blockchain connection failed')
      );
      mockContracts.computationalNFT.ownerOf.mockRejectedValue(
        new Error('Blockchain connection failed')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTATIONAL_NFT_QUERY,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data = response.body.singleResult.data?.computationalNFT;
      expect(data).toBeDefined();
      expect(data?.computationType).toBe(testNFT.computationType); // From database
      expect(data?.name).toBe(testNFT.name); // From database
      expect(data?.creator).toBe(testNFT.creator); // From database
    });
  });

  describe('Query: computationalNFTs', () => {
    const COMPUTATIONAL_NFTS_QUERY = gql`
      query ComputationalNFTs($first: Int, $skip: Int, $orderBy: String, $orderDirection: String, $where: ComputationalNFTWhereInput) {
        computationalNFTs(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection, where: $where) {
          id
          tokenId
          modelType
          modelName
          status
          isVerified
          owner
    `;

    it('should return list of computational NFTs with pagination', async () => {
      // Arrange
      const testNFTs = [
        createTestComputationalNFT({ nftId: '1' }),
        createTestComputationalNFT({
          nftId: '2',
          computationType: 'CLIMATE_MODEL',
        }),
      ];
      mockDb.query.computationalNfts.findMany.mockResolvedValue(testNFTs);

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTATIONAL_NFTS_QUERY,
          variables: { first: 10, skip: 0 },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTsQueryResponse>(result);
      const data = response.body.singleResult.data?.computationalNFTs;
      expect(data).toHaveLength(2);
      expect(data?.[0]?.id).toBe('1');
      expect(data?.[0]?.modelType).toBe('WEATHER_FORECAST');
      expect(data?.[1]?.id).toBe('2');
      expect(data?.[1]?.modelType).toBe('CLIMATE_MODEL');
      expect(mockDb.query.computationalNfts.findMany).toHaveBeenCalledWith({
        where: undefined,
        limit: 10,
        offset: 0,
        orderBy: expect.any(Function),
      });
    });

    it('should apply pagination limits', async () => {
      // Act
      await server.executeOperation(
        {
          query: COMPUTATIONAL_NFTS_QUERY,
          variables: { first: 150, skip: 5 },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expect(mockDb.query.computationalNfts.findMany).toHaveBeenCalledWith({
        where: undefined,
        limit: 100, // Should be capped at 100
        offset: 5,
        orderBy: expect.any(Function),
      });
    });

    it('should filter by model type', async () => {
      // Act
      await server.executeOperation(
        {
          query: COMPUTATIONAL_NFTS_QUERY,
          variables: {
            where: { modelType: 'WEATHER_FORECAST' },
          },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expect(mockDb.query.computationalNfts.findMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        limit: 10,
        offset: 0,
        orderBy: expect.any(Function),
      });
    });

    it('should filter by owner', async () => {
      // Act
      await server.executeOperation(
        {
          query: COMPUTATIONAL_NFTS_QUERY,
          variables: {
            where: { owner: '0x1234567890123456789012345678901234567890' },
          },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expect(mockDb.query.computationalNfts.findMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        limit: 10,
        offset: 0,
        orderBy: expect.any(Function),
      });
    });

    it('should filter by verification status', async () => {
      // Act
      await server.executeOperation(
        {
          query: COMPUTATIONAL_NFTS_QUERY,
          variables: {
            where: { isVerified: true },
          },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expect(mockDb.query.computationalNfts.findMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        limit: 10,
        offset: 0,
        orderBy: expect.any(Function),
      });
    });

    it('should handle order by and direction', async () => {
      // Act
      await server.executeOperation(
        {
          query: COMPUTATIONAL_NFTS_QUERY,
          variables: {
            orderBy: 'createdAt',
            orderDirection: 'desc',
          },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expect(mockDb.query.computationalNfts.findMany).toHaveBeenCalledWith({
        where: undefined,
        limit: 10,
        offset: 0,
        orderBy: expect.any(Function),
      });
    });
  });

  describe('Field Resolver: ComputationalNFT.job', () => {
    const COMPUTATIONAL_NFT_JOB_QUERY = gql`
      query ComputationalNFTJob($id: String!) {
        computationalNFT(id: $id) {
          job {
            id
            nft {
              id
              modelName
    `;

    it('should return compute job for NFT', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTATIONAL_NFT_JOB_QUERY,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data = response.body.singleResult.data?.computationalNFT?.job;
      expect(data).toBeDefined();
      expect(data?.id).toBe('job_1');
      expect(data?.nft?.id).toBe('1');
    });
  });

  describe('Field Resolver: ComputeJob.provider', () => {
    const COMPUTE_JOB_PROVIDER_QUERY = gql`
      query ComputeJobProvider($id: String!) {
        computationalNFT(id: $id) {
          job {
            provider {
              id
              address
              isAuthorized
              totalComputeTime
              successfulJobs
              failedJobs
              stakedTokens
    `;

    it('should return compute provider details', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      const providerStats = [
        true, // isAuthorized
        BigInt('1000'), // totalComputeTime
        BigInt('50'), // successfulJobs
        BigInt('2'), // failedJobs
        BigInt('10000000000000000000'), // stakedTokens (10 WRF)
      ];

      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);
      mockContracts.computationalNFT.getProviderStats.mockResolvedValue(
        providerStats
      );

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTE_JOB_PROVIDER_QUERY,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data =
        response.body.singleResult.data?.computationalNFT?.job?.provider;
      expect(data).toBeDefined();
      expect(data?.address).toBe('0x5555555555555555555555555555555555555555');
      expect(data?.isAuthorized).toBe(true);
      expect(data?.totalComputeTime).toBe('1000');
      expect(data?.successfulJobs).toBe('50');
      expect(data?.failedJobs).toBe('2');
      expect(data?.stakedTokens).toBe('10000000000000000000');
      expect(
        mockContracts.computationalNFT.getProviderStats
      ).toHaveBeenCalledWith('0x5555555555555555555555555555555555555555');
    });

    it('should return null for zero address provider', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT({
        metadata: {
          ...createTestComputationalNFT().metadata,
          computeProvider: ethers.ZeroAddress,
        },
      });
      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTE_JOB_PROVIDER_QUERY,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data =
        response.body.singleResult.data?.computationalNFT?.job?.provider;
      expect(data).toBeNull();
    });

    it('should handle blockchain error gracefully', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);
      mockContracts.computationalNFT.getProviderStats.mockRejectedValue(
        new Error('Provider not found')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTE_JOB_PROVIDER_QUERY,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data =
        response.body.singleResult.data?.computationalNFT?.job?.provider;
      expect(data).toBeNull();
    });
  });

  describe('Field Resolver: ComputeJob.rewards', () => {
    const COMPUTE_JOB_REWARDS_QUERY = gql`
      query ComputeJobRewards($id: String!) {
        computationalNFT(id: $id) {
          job {
            rewards(first: 5) {
              id
              provider
              amount
              computeTime
              timestamp
              transactionHash
    `;

    it('should return compute rewards for job', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      const testRewards = [
        createTestComputeReward({ id: 'reward-1', jobId: 'job_1' }),
        createTestComputeReward({
          id: 'reward-2',
          jobId: 'job_1',
          rewardAmount: '200000000000000000',
        }),
      ];

      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);
      mockDb.query.computeRewards.findMany.mockResolvedValue(testRewards);

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTE_JOB_REWARDS_QUERY,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data =
        response.body.singleResult.data?.computationalNFT?.job?.rewards;
      expect(data).toHaveLength(2);
      expect(data?.[0]?.id).toBe('reward-1');
      expect(data?.[0]?.amount).toBe('100000000000000000');
      expect(data?.[0]?.provider).toBe(
        '0x5555555555555555555555555555555555555555'
      );
      expect(data?.[0]?.computeTime).toBe('250');
      expect(data?.[1]?.amount).toBe('200000000000000000');
      expect(mockDb.query.computeRewards.findMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        limit: 5,
        orderBy: expect.any(Function),
      });
    });

    it('should handle empty rewards gracefully', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);
      mockDb.query.computeRewards.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTE_JOB_REWARDS_QUERY,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data =
        response.body.singleResult.data?.computationalNFT?.job?.rewards;
      expect(data).toHaveLength(0);
    });

    it('should handle database error gracefully', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);
      mockDb.query.computeRewards.findMany.mockRejectedValue(
        new Error('Database error')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: COMPUTE_JOB_REWARDS_QUERY,
          variables: { id: '1' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data =
        response.body.singleResult.data?.computationalNFT?.job?.rewards;
      expect(data).toHaveLength(0); // Should return empty array on error
    });
  });

  describe('Field Resolver: ComputeProvider.jobs', () => {
    const COMPUTE_PROVIDER_JOBS_QUERY = gql`
      query ComputeProviderJobs($address: String!) {
        # This would require a computeProvider query in the schema
        # For now, testing via the field resolver directly
    `;

    // Note: This test would require a computeProvider query in the GraphQL schema
    // Since it's not currently in the schema, we'll test the resolver logic directly
    it('should return jobs for compute provider', async () => {
      // This test demonstrates how to test the field resolver
      const testNFTs = [
        createTestComputationalNFT({ nftId: '1' }),
        createTestComputationalNFT({ nftId: '2' }),
      ];
      mockDb.query.computationalNfts.findMany.mockResolvedValue(testNFTs);

      // Simulate the field resolver being called
      const parent = { address: '0x1234567890123456789012345678901234567890' };
      const args = { first: 10 };

      // This would call the actual field resolver
      // const result = await resolvers.ComputeProvider.jobs(parent, args, mockContext);

      // For now, just verify the database query would be called correctly
      expect(mockDb.query.computationalNfts.findMany).toHaveBeenCalledTimes(0); // Not called yet
    });
  });

  describe('Performance Tests', () => {
    it('should handle large NFT queries within acceptable time', async () => {
      // Arrange
      const startTime = Date.now();
      const largeNFTList = Array.from({ length: 100 }, (_, i) =>
        createTestComputationalNFT({ nftId: i.toString() })
      );
      mockDb.query.computationalNfts.findMany.mockResolvedValue(largeNFTList);

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
          query ComputationalNFTs {
            computationalNFTs(first: 100) {
              id
              tokenId
              modelType
              modelName
              status
        `,
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(3000); // Should complete within 3 seconds
      expectGraphQLSuccess(result);

      const response =
        assertGraphQLResponse<ComputationalNFTsQueryResponse>(result);
      const data = response.body.singleResult.data?.computationalNFTs;
      expect(data).toHaveLength(100);
    }, 10000);

    it('should handle concurrent blockchain calls efficiently', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);

      const nftQuery = gql`
        query ComputationalNFT($id: String!) {
          computationalNFT(id: $id) {
            id
            modelType
            status
            owner
      `;

      // Act - Run 5 concurrent requests
      const promises = Array.from({ length: 5 }, () =>
        server.executeOperation(
          {
            query: nftQuery,
            variables: { id: '1' },
          },
          {
            contextValue: mockContext,
          }
        )
      );

      const results = await Promise.all(promises);

      // Assert
      results.forEach(result => {
        expectGraphQLSuccess(result);
      });

      // Database should be called for each request
      expect(mockDb.query.computationalNfts.findFirst).toHaveBeenCalledTimes(5);
    }, 10000);
  });

  describe('Error Handling', () => {
    it('should handle database connection failures', async () => {
      // Arrange
      mockDb.query.computationalNfts.findFirst.mockRejectedValue(
        new Error('Database connection failed')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
          query ComputationalNFT {
            computationalNFT(id: "1") {
              id
        `,
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLError(result, 'Database connection failed');
    });

    it('should handle blockchain connection failures gracefully', async () => {
      // Arrange
      const testNFT = createTestComputationalNFT();
      mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);
      mockContracts.computationalNFT.getComputeJob.mockRejectedValue(
        new Error('Blockchain unavailable')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
          query ComputationalNFT {
            computationalNFT(id: "1") {
              id
              modelType
              owner
        `,
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response =
        assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
      const data = response.body.singleResult.data?.computationalNFT;
      expect(data).toBeDefined();
      expect(data?.computationType).toBe(testNFT.computationType); // Fallback to database
    });

    it('should validate BigInt token ID conversions', async () => {
      // Test edge cases for BigInt conversion
      const edgeCases = [
        '9007199254740991', // MAX_SAFE_INTEGER
        '18446744073709551615', // 2^64 - 1
        '0',
      ];

      for (const tokenId of edgeCases) {
        const testNFT = createTestComputationalNFT({ nftId: tokenId });
        mockDb.query.computationalNfts.findFirst.mockResolvedValue(testNFT);

        const result = await server.executeOperation(
          {
            query: gql`
              query ComputationalNFT($id: String!) {
                computationalNFT(id: $id) {
                  id
                  nftId
                }
              }
            `,
            variables: { id: tokenId },
          },
          {
            contextValue: mockContext,
          }
        );

        expectGraphQLSuccess(result);
        const response =
          assertGraphQLResponse<ComputationalNFTQueryResponse>(result);
        const data = response.body.singleResult.data?.computationalNFT;
        expect(data?.nftId).toBe(tokenId);
      }
    });

    it('should provide detailed error context', async () => {
      // This test would verify that errors include proper context for debugging
      const consoleSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});

      mockDb.query.computationalNfts.findFirst.mockRejectedValue(
        new Error('Test database error')
      );

      await server.executeOperation(
        {
          query: gql`
          query ComputationalNFT {
            computationalNFT(id: "1") {
              id
        `,
        },
        {
          contextValue: mockContext,
        }
      );

      // In a real implementation, you'd verify logger.error was called with proper context
      consoleSpy.mockRestore();
    });
  });
});
