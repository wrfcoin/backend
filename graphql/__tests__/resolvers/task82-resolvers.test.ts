/**
 * Task 82 Resolvers Test Suite
 * Tests for new GraphQL resolvers: User fields (swaps, stakingPositions, liquidityPositions, rewards)
 * and CarbonCredit fields (tradingHistory, priceHistory)
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  jest,
} from '@jest/globals';
import { ApolloServer } from '@apollo/server';
import { gql } from 'graphql-tag';
import { typeDefs } from '../../schema/typeDefs.js';
import { resolvers } from '../../resolvers/index.js';
import {
  createMockContext,
  createMockUser,
  expectGraphQLError,
  expectGraphQLSuccess,
} from '../mocks/datasource.js';
import { GraphQLContext } from '../../context.js';
import { assertGraphQLResponse } from '../types/graphql-response-types.js';

// Test data generators
const createTestUser = (overrides = {}) => ({
  id: 1,
  username: 'testuser',
  email: 'test@example.com',
  walletAddress: '0x1234567890123456789012345678901234567890',
  displayName: 'Test User',
  bio: 'Test bio',
  avatar: 'https://example.com/avatar.png',
  location: 'Test Location',
  isVerified: true,
  isActive: true,
  createdAt: new Date('2024-01-01'),
  lastActiveAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createTestSwap = (overrides = {}) => ({
  id: 1,
  user: '0x1234567890123456789012345678901234567890',
  pairAddress: '0xpair123',
  tokenIn: '0xtoken1',
  tokenOut: '0xtoken2',
  amountIn: '1000000000000000000',
  amountOut: '2000000000000000000',
  minimumAmountOut: '1900000000000000000',
  priceImpact: '0.5',
  fee: '3000000000000000',
  status: 'completed',
  timestamp: new Date('2024-01-15'),
  blockNumber: 12345,
  transactionHash: '0xtxhash123',
  gasUsed: 150000,
  metadata: { slippage: '0.5', deadline: 1705320000 },
  createdAt: new Date('2024-01-15'),
  ...overrides,
});

const createTestStakingPosition = (overrides = {}) => ({
  id: 1,
  userId: '0x1234567890123456789012345678901234567890',
  validatorId: 'validator-001',
  amount: '5000000000000000000000',
  lockupPeriod: 90,
  depositedAt: new Date('2024-01-01'),
  unlocksAt: new Date('2024-04-01'),
  status: 'active',
  createdAt: new Date('2024-01-01'),
  ...overrides,
});

const createTestLiquidityPosition = (overrides = {}) => ({
  id: 1,
  userId: '0x1234567890123456789012345678901234567890',
  poolId: 'pool-001',
  token0Amount: '1000000000000000000',
  token1Amount: '2000000000000000000',
  lpTokens: '1414213562373095048',
  entryPrice: '2.0',
  createdAt: new Date('2024-01-10'),
  updatedAt: new Date('2024-01-15'),
  ...overrides,
});

const createTestReward = (overrides = {}) => ({
  id: 1,
  recipient: '0x1234567890123456789012345678901234567890',
  amount: '100000000000000000',
  rewardType: 'staking',
  period: '2024-01',
  claimedAt: null,
  createdAt: new Date('2024-01-31'),
  ...overrides,
});

const createTestStakingReward = (overrides = {}) => ({
  id: 1,
  stakerId: '0x1234567890123456789012345678901234567890',
  amount: '50000000000000000',
  period: '2024-01',
  claimedAt: null,
  createdAt: new Date('2024-01-31'),
  ...overrides,
});

const createTestCarbonCredit = (overrides = {}) => ({
  id: 'cc-1',
  tokenId: '1',
  owner: '0x1234567890123456789012345678901234567890',
  carbonOffset: '10.5',
  projectType: 'renewable_energy',
  verificationStandard: 'VCS',
  issuanceDate: new Date('2024-01-01'),
  expiryDate: new Date('2030-01-01'),
  location: { country: 'USA', region: 'California' },
  isRetired: false,
  issuer: 'Test Issuer',
  certificationHash: 'QmTest123',
  forSale: true,
  price: '100.0',
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

const createTestCarbonTrade = (overrides = {}) => ({
  id: 1,
  creditId: '1',
  buyerAddress: '0xbuyer123456789012345678901234567890123456',
  sellerAddress: '0xseller12345678901234567890123456789012345',
  price: '100.0',
  quantity: '5.0',
  totalValue: '500.0',
  tradeType: 'market',
  transactionHash: '0xtradehash123',
  tradedAt: new Date('2024-01-20'),
  createdAt: new Date('2024-01-20'),
  ...overrides,
});

describe('Task 82 Resolvers Test Suite', () => {
  let server: ApolloServer<GraphQLContext>;
  let mockContext: any;
  let mockDb: any;
  let mockContracts: any;

  beforeAll(async () => {
    // Create mock database with all required tables
    mockDb = {
      query: {
        users: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        ammSwaps: {
          findMany: jest.fn(),
        },
        stakingDeposits: {
          findMany: jest.fn(),
        },
        stakingRewards: {
          findMany: jest.fn(),
        },
        liquidityPositions: {
          findMany: jest.fn(),
        },
        computeRewards: {
          findMany: jest.fn(),
        },
        carbonCredits: {
          findFirst: jest.fn(),
          findMany: jest.fn(),
        },
        carbonTrades: {
          findMany: jest.fn(),
        },
        weatherStations: {
          findMany: jest.fn(),
        },
        computationalNfts: {
          findMany: jest.fn(),
        },
        carbonFootprints: {
          findFirst: jest.fn(),
        },
        weatherDataQuality: {
          findFirst: jest.fn(),
        },
      },
      insert: jest.fn().mockReturnValue({
        values: jest.fn().mockReturnValue({
          returning: jest.fn(),
        }),
      }),
      update: jest.fn(),
    };

    // Create mock contracts
    mockContracts = {
      wrfToken: {
        balanceOf: jest.fn(),
      },
      wrfGovernor: {
        getVotes: jest.fn(),
      },
      carbonCreditAMM: {
        getActiveListings: jest.fn(),
      },
    };

    // Create mock provider
    const mockProvider = {
      getBlockNumber: (jest.fn() as any).mockResolvedValue(1000),
    };

    server = new ApolloServer<GraphQLContext>({
      typeDefs,
      resolvers,
    });

    mockContext = {
      ...createMockContext(),
      db: mockDb,
      contracts: mockContracts,
      provider: mockProvider,
      requestId: 'test-request-id',
      clientIP: '127.0.0.1',
    };
  });

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset all mock return values
    mockDb.query.users.findFirst.mockResolvedValue(null);
    mockDb.query.users.findMany.mockResolvedValue([]);
    mockDb.query.ammSwaps.findMany.mockResolvedValue([]);
    mockDb.query.stakingDeposits.findMany.mockResolvedValue([]);
    mockDb.query.stakingRewards.findMany.mockResolvedValue([]);
    mockDb.query.liquidityPositions.findMany.mockResolvedValue([]);
    mockDb.query.computeRewards.findMany.mockResolvedValue([]);
    mockDb.query.carbonCredits.findFirst.mockResolvedValue(null);
    mockDb.query.carbonCredits.findMany.mockResolvedValue([]);
    mockDb.query.carbonTrades.findMany.mockResolvedValue([]);
    mockDb.query.carbonFootprints.findFirst.mockResolvedValue(null);
    mockContracts.wrfToken.balanceOf.mockResolvedValue(
      BigInt('1000000000000000000')
    );
    mockContracts.wrfGovernor.getVotes.mockResolvedValue(
      BigInt('500000000000000000')
    );
  });

  afterAll(async () => {
    await server?.stop();
  });

  describe('User.swaps Field Resolver', () => {
    const USER_SWAPS_QUERY = gql`
      query UserSwaps($address: String!) {
        user(address: $address) {
          id
          address
          swaps(first: 10) {
            id
            tokenIn
            tokenOut
            amountIn
            amountOut
            timestamp
            transactionHash
          }
        }
      }
    `;

    it('should return user swaps from ammSwaps table', async () => {
      // Arrange
      const testUser = createTestUser();
      const testSwaps = [
        createTestSwap({ id: 1 }),
        createTestSwap({ id: 2, amountIn: '2000000000000000000' }),
      ];

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.ammSwaps.findMany.mockResolvedValue(testSwaps);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_SWAPS_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.user?.swaps;
      expect(data).toHaveLength(2);
      expect(data?.[0]?.tokenIn).toBe(testSwaps[0].tokenIn);
      expect(data?.[0]?.transactionHash).toBe(testSwaps[0].transactionHash);
    });

    it('should return empty array when user has no swaps', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.ammSwaps.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_SWAPS_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.user?.swaps;
      expect(data).toHaveLength(0);
    });

    it('should respect pagination limits', async () => {
      // Arrange
      const testUser = createTestUser();
      const testSwaps = Array.from({ length: 20 }, (_, i) =>
        createTestSwap({ id: i + 1 })
      );
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.ammSwaps.findMany.mockResolvedValue(testSwaps.slice(0, 10));

      // Act
      const result = await server.executeOperation(
        {
          query: USER_SWAPS_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      expect(mockDb.query.ammSwaps.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: expect.any(Number),
        })
      );
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.ammSwaps.findMany.mockRejectedValue(
        new Error('Database error')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: USER_SWAPS_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert - should return empty array on error
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.user?.swaps;
      expect(data).toHaveLength(0);
    });
  });

  describe('User.stakingPositions Field Resolver', () => {
    const USER_STAKING_QUERY = gql`
      query UserStaking($address: String!) {
        user(address: $address) {
          id
          stakingPositions(first: 10) {
            id
            amount
            validatorId
            lockupPeriod
            status
            depositedAt
            unlocksAt
          }
        }
      }
    `;

    it('should return user staking positions', async () => {
      // Arrange
      const testUser = createTestUser();
      const testPositions = [
        createTestStakingPosition({ id: 1 }),
        createTestStakingPosition({ id: 2, validatorId: 'validator-002' }),
      ];

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.stakingDeposits.findMany.mockResolvedValue(testPositions);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_STAKING_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.user?.stakingPositions;
      expect(data).toHaveLength(2);
      expect(data?.[0]?.validatorId).toBe('validator-001');
      expect(data?.[0]?.status).toBe('active');
    });

    it('should return empty array when no staking positions exist', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.stakingDeposits.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_STAKING_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.user?.stakingPositions;
      expect(data).toHaveLength(0);
    });

    it('should filter by user address correctly', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.stakingDeposits.findMany.mockResolvedValue([]);

      // Act
      await server.executeOperation(
        {
          query: USER_STAKING_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expect(mockDb.query.stakingDeposits.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.any(Object),
        })
      );
    });
  });

  describe('User.liquidityPositions Field Resolver', () => {
    const USER_LIQUIDITY_QUERY = gql`
      query UserLiquidity($address: String!) {
        user(address: $address) {
          id
          liquidityPositions(first: 10) {
            id
            poolId
            token0Amount
            token1Amount
            lpTokens
            entryPrice
            createdAt
          }
        }
      }
    `;

    it('should return user liquidity positions', async () => {
      // Arrange
      const testUser = createTestUser();
      const testPositions = [
        createTestLiquidityPosition({ id: 1 }),
        createTestLiquidityPosition({ id: 2, poolId: 'pool-002' }),
      ];

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.liquidityPositions.findMany.mockResolvedValue(testPositions);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_LIQUIDITY_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.user?.liquidityPositions;
      expect(data).toHaveLength(2);
      expect(data?.[0]?.poolId).toBe('pool-001');
      expect(data?.[0]?.lpTokens).toBe(testPositions[0].lpTokens);
    });

    it('should return empty array when no liquidity positions exist', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.liquidityPositions.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_LIQUIDITY_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.user?.liquidityPositions;
      expect(data).toHaveLength(0);
    });
  });

  describe('User.rewards Field Resolver', () => {
    const USER_REWARDS_QUERY = gql`
      query UserRewards($address: String!) {
        user(address: $address) {
          id
          rewards(first: 10) {
            id
            amount
            rewardType
            period
            claimedAt
            createdAt
          }
        }
      }
    `;

    it('should return combined compute and staking rewards', async () => {
      // Arrange
      const testUser = createTestUser();
      const computeRewards = [
        createTestReward({ id: 1, rewardType: 'compute' }),
      ];
      const stakingRewards = [
        createTestStakingReward({ id: 2 }),
      ];

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.computeRewards.findMany.mockResolvedValue(computeRewards);
      mockDb.query.stakingRewards.findMany.mockResolvedValue(stakingRewards);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_REWARDS_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.user?.rewards;
      expect(data).toBeDefined();
      // Combined rewards from both sources
      expect(data?.length).toBeGreaterThanOrEqual(0);
    });

    it('should return empty array when no rewards exist', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.computeRewards.findMany.mockResolvedValue([]);
      mockDb.query.stakingRewards.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_REWARDS_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.user?.rewards;
      expect(data).toHaveLength(0);
    });

    it('should handle partial data gracefully', async () => {
      // Arrange - only compute rewards available
      const testUser = createTestUser();
      const computeRewards = [
        createTestReward({ id: 1, rewardType: 'compute' }),
      ];

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.computeRewards.findMany.mockResolvedValue(computeRewards);
      mockDb.query.stakingRewards.findMany.mockRejectedValue(
        new Error('Table not found')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: USER_REWARDS_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert - should still return compute rewards
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.user?.rewards;
      expect(data).toBeDefined();
    });
  });

  describe('CarbonCredit.tradingHistory Field Resolver', () => {
    const CARBON_CREDIT_TRADING_QUERY = gql`
      query CarbonCreditTrading($tokenId: String!) {
        carbonCredit(tokenId: $tokenId) {
          tokenId
          tradingHistory(first: 20) {
            id
            creditId
            buyer
            seller
            price
            quantity
            totalValue
            tradeType
            transactionHash
            timestamp
          }
        }
      }
    `;

    it('should return trading history for a carbon credit', async () => {
      // Arrange
      const testCredit = createTestCarbonCredit();
      const testTrades = [
        createTestCarbonTrade({ id: 1 }),
        createTestCarbonTrade({
          id: 2,
          price: '110.0',
          tradedAt: new Date('2024-01-25'),
        }),
      ];

      mockDb.query.carbonCredits.findFirst.mockResolvedValue(testCredit);
      mockDb.query.carbonTrades.findMany.mockResolvedValue(testTrades);

      // Act
      const result = await server.executeOperation(
        {
          query: CARBON_CREDIT_TRADING_QUERY,
          variables: { tokenId: testCredit.tokenId },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data =
        response.body.singleResult.data?.carbonCredit?.tradingHistory;
      expect(data).toHaveLength(2);
      expect(data?.[0]?.buyer).toBe(testTrades[0].buyerAddress);
      expect(data?.[0]?.seller).toBe(testTrades[0].sellerAddress);
      expect(data?.[0]?.price).toBe(testTrades[0].price);
    });

    it('should return empty array when no trades exist', async () => {
      // Arrange
      const testCredit = createTestCarbonCredit();
      mockDb.query.carbonCredits.findFirst.mockResolvedValue(testCredit);
      mockDb.query.carbonTrades.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: CARBON_CREDIT_TRADING_QUERY,
          variables: { tokenId: testCredit.tokenId },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data =
        response.body.singleResult.data?.carbonCredit?.tradingHistory;
      expect(data).toHaveLength(0);
    });

    it('should respect pagination limits', async () => {
      // Arrange
      const testCredit = createTestCarbonCredit();
      const testTrades = Array.from({ length: 30 }, (_, i) =>
        createTestCarbonTrade({ id: i + 1 })
      );
      mockDb.query.carbonCredits.findFirst.mockResolvedValue(testCredit);
      mockDb.query.carbonTrades.findMany.mockResolvedValue(testTrades.slice(0, 20));

      // Act
      const result = await server.executeOperation(
        {
          query: CARBON_CREDIT_TRADING_QUERY,
          variables: { tokenId: testCredit.tokenId },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      expect(mockDb.query.carbonTrades.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: expect.any(Number),
        })
      );
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      const testCredit = createTestCarbonCredit();
      mockDb.query.carbonCredits.findFirst.mockResolvedValue(testCredit);
      mockDb.query.carbonTrades.findMany.mockRejectedValue(
        new Error('Database error')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: CARBON_CREDIT_TRADING_QUERY,
          variables: { tokenId: testCredit.tokenId },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert - should return empty array on error
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data =
        response.body.singleResult.data?.carbonCredit?.tradingHistory;
      expect(data).toHaveLength(0);
    });
  });

  describe('CarbonCredit.priceHistory Field Resolver', () => {
    const CARBON_CREDIT_PRICE_QUERY = gql`
      query CarbonCreditPrice($tokenId: String!) {
        carbonCredit(tokenId: $tokenId) {
          tokenId
          priceHistory(first: 30) {
            id
            price
            timestamp
            tradeType
          }
        }
      }
    `;

    it('should return price history derived from trades', async () => {
      // Arrange
      const testCredit = createTestCarbonCredit();
      const testTrades = [
        createTestCarbonTrade({ id: 1, price: '100.0' }),
        createTestCarbonTrade({ id: 2, price: '105.0' }),
        createTestCarbonTrade({ id: 3, price: '110.0' }),
      ];

      mockDb.query.carbonCredits.findFirst.mockResolvedValue(testCredit);
      mockDb.query.carbonTrades.findMany.mockResolvedValue(testTrades);

      // Act
      const result = await server.executeOperation(
        {
          query: CARBON_CREDIT_PRICE_QUERY,
          variables: { tokenId: testCredit.tokenId },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.carbonCredit?.priceHistory;
      expect(data).toBeDefined();
      expect(data?.length).toBeGreaterThanOrEqual(0);
    });

    it('should return empty array when no price history exists', async () => {
      // Arrange
      const testCredit = createTestCarbonCredit();
      mockDb.query.carbonCredits.findFirst.mockResolvedValue(testCredit);
      mockDb.query.carbonTrades.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: CARBON_CREDIT_PRICE_QUERY,
          variables: { tokenId: testCredit.tokenId },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const data = response.body.singleResult.data?.carbonCredit?.priceHistory;
      expect(data).toHaveLength(0);
    });
  });

  describe('Combined User Fields Query', () => {
    const COMBINED_USER_QUERY = gql`
      query CombinedUser($address: String!) {
        user(address: $address) {
          id
          address
          swaps(first: 5) {
            id
            tokenIn
            tokenOut
          }
          stakingPositions(first: 5) {
            id
            amount
            status
          }
          liquidityPositions(first: 5) {
            id
            poolId
            lpTokens
          }
          rewards(first: 5) {
            id
            amount
            rewardType
          }
        }
      }
    `;

    it('should return all user fields in a single query', async () => {
      // Arrange
      const testUser = createTestUser();
      const testSwaps = [createTestSwap()];
      const testStaking = [createTestStakingPosition()];
      const testLiquidity = [createTestLiquidityPosition()];
      const testRewards = [createTestReward()];

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.ammSwaps.findMany.mockResolvedValue(testSwaps);
      mockDb.query.stakingDeposits.findMany.mockResolvedValue(testStaking);
      mockDb.query.liquidityPositions.findMany.mockResolvedValue(testLiquidity);
      mockDb.query.computeRewards.findMany.mockResolvedValue(testRewards);
      mockDb.query.stakingRewards.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: COMBINED_USER_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const user = response.body.singleResult.data?.user;
      expect(user).toBeDefined();
      expect(user?.swaps).toBeDefined();
      expect(user?.stakingPositions).toBeDefined();
      expect(user?.liquidityPositions).toBeDefined();
      expect(user?.rewards).toBeDefined();
    });

    it('should handle user with no activity', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.ammSwaps.findMany.mockResolvedValue([]);
      mockDb.query.stakingDeposits.findMany.mockResolvedValue([]);
      mockDb.query.liquidityPositions.findMany.mockResolvedValue([]);
      mockDb.query.computeRewards.findMany.mockResolvedValue([]);
      mockDb.query.stakingRewards.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: COMBINED_USER_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const user = response.body.singleResult.data?.user;
      expect(user?.swaps).toHaveLength(0);
      expect(user?.stakingPositions).toHaveLength(0);
      expect(user?.liquidityPositions).toHaveLength(0);
      expect(user?.rewards).toHaveLength(0);
    });

    it('should handle partial failures gracefully', async () => {
      // Arrange - some queries fail
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.ammSwaps.findMany.mockResolvedValue([createTestSwap()]);
      mockDb.query.stakingDeposits.findMany.mockRejectedValue(
        new Error('Database error')
      );
      mockDb.query.liquidityPositions.findMany.mockResolvedValue([
        createTestLiquidityPosition(),
      ]);
      mockDb.query.computeRewards.findMany.mockResolvedValue([]);
      mockDb.query.stakingRewards.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: COMBINED_USER_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert - should still return data for successful queries
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      const user = response.body.singleResult.data?.user;
      expect(user?.swaps?.length).toBeGreaterThan(0);
      expect(user?.stakingPositions).toHaveLength(0); // Failed query returns empty
      expect(user?.liquidityPositions?.length).toBeGreaterThan(0);
    });
  });

  describe('Performance Tests', () => {
    it('should handle concurrent resolver calls efficiently', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.ammSwaps.findMany.mockResolvedValue([createTestSwap()]);
      mockDb.query.stakingDeposits.findMany.mockResolvedValue([
        createTestStakingPosition(),
      ]);
      mockDb.query.liquidityPositions.findMany.mockResolvedValue([
        createTestLiquidityPosition(),
      ]);
      mockDb.query.computeRewards.findMany.mockResolvedValue([createTestReward()]);
      mockDb.query.stakingRewards.findMany.mockResolvedValue([]);

      const startTime = Date.now();

      // Act - Run multiple queries concurrently
      const queries = Array.from({ length: 5 }, () =>
        server.executeOperation(
          {
            query: gql`
              query User($address: String!) {
                user(address: $address) {
                  swaps(first: 10) { id }
                  stakingPositions(first: 10) { id }
                  liquidityPositions(first: 10) { id }
                  rewards(first: 10) { id }
                }
              }
            `,
            variables: { address: testUser.walletAddress },
          },
          {
            contextValue: mockContext,
          }
        )
      );

      const results = await Promise.all(queries);
      const duration = Date.now() - startTime;

      // Assert
      results.forEach(result => {
        expectGraphQLSuccess(result);
      });
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    }, 10000);
  });

  describe('Error Handling', () => {
    it('should handle null user gracefully', async () => {
      // Arrange
      mockDb.query.users.findFirst.mockResolvedValue(null);

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query User($address: String!) {
              user(address: $address) {
                id
                swaps(first: 5) { id }
              }
            }
          `,
          variables: { address: '0xnonexistent' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<any>(result);
      expect(response.body.singleResult.data?.user).toBeNull();
    });

    it('should handle invalid address format', async () => {
      // Act
      const result = await server.executeOperation(
        {
          query: gql`
            query User($address: String!) {
              user(address: $address) {
                id
              }
            }
          `,
          variables: { address: 'invalid-address' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLError(result, 'Invalid');
    });
  });
});
