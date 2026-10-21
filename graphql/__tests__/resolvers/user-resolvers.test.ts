/**
 * User Resolvers Test Suite - Task 57.6
 * Comprehensive tests for user GraphQL resolvers including carbon credits & footprints
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
  createMockUser,
  expectGraphQLError,
  expectGraphQLSuccess,
} from '../mocks/datasource.js';
import { GraphQLContext } from '../../context.js';
import {
  UserQueryResponse,
  UsersQueryResponse,
  UserProfileUpdateResponse, // Added missing import
  UserData,
  CarbonCreditData,
  WeatherStationData,
  assertGraphQLResponse,
} from '../types/graphql-response-types.js';

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

const createTestCarbonFootprint = (overrides = {}) => ({
  id: 'cf-1',
  userId: '0x1234567890123456789012345678901234567890',
  totalEmissions: '25.7',
  totalOffsets: '10.5',
  netEmissions: '15.2',
  calculationDate: new Date('2024-01-01'),
  emissionSources: { transport: 15.0, energy: 10.7 },
  offsetSources: { renewable: 10.5 },
  methodology: 'ipcc_2021',
  confidence: 0.95,
  metadata: { methodology: 'ipcc_2021', confidence: 0.95 },
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

describe('User Resolvers Test Suite', () => {
  let server: ApolloServer<GraphQLContext>;
  let mockContext: any;
  let mockDb: any;
  let mockContracts: any;
  let mockProvider: any;

  beforeAll(async () => {
    // Create mock database
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
        weatherStations: {
          findMany: jest.fn(),
        },
        computationalNfts: {
          findMany: jest.fn(),
        },
        votes: {
          findMany: jest.fn(),
        },
        proposals: {
          findMany: jest.fn(),
        },
      },
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
    };

    // Create mock provider
    mockProvider = {
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
    mockDb.query.carbonCredits.findMany.mockResolvedValue([]);
    mockDb.query.carbonFootprints.findFirst.mockResolvedValue(null);
    mockContracts.wrfToken.balanceOf.mockResolvedValue(
      BigInt('1000000000000000000')
    ); // 1 WRF
    mockContracts.wrfGovernor.getVotes.mockResolvedValue(
      BigInt('500000000000000000')
    ); // 0.5 WRF
  });

  afterAll(async () => {
    await server?.stop();
  });

  describe('Query: me', () => {
    const ME_QUERY = gql`
      query Me {
        me {
          id
          address
          username
          email
          profile {
            displayName
            bio
            avatar
            location
          wrfBalance
          joinedAt
          lastActiveAt
          isVerified
    `;

    it('should return current user profile successfully', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);

      // Act
      const result = await server.executeOperation(
        {
          query: ME_QUERY,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: testUser.walletAddress },
            isAuthenticated: true,
          },
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      expect(result.body?.kind).toBe('single');
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.me;
      expect(data).toBeDefined();
      expect(data?.id).toBe(testUser.walletAddress);
      expect(data?.username).toBe(testUser.username);
      expect(data?.email).toBe(testUser.email);
      expect(data?.walletAddress).toBe(testUser.walletAddress);
      expect(data?.isActive).toBe(true);
      expect(data?.isActive).toBe(testUser.isActive);
      // Verify database calls
      expect(mockDb.query.users.findFirst).toHaveBeenCalledWith({
        where: expect.any(Object),
      });
      expect(mockContracts.wrfToken.balanceOf).toHaveBeenCalledWith(
        testUser.walletAddress
      );
    });

    it('should handle unauthenticated user', async () => {
      // Act
      const result = await server.executeOperation(
        {
          query: ME_QUERY,
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
    });

    it('should handle user not found in database', async () => {
      // Arrange
      mockDb.query.users.findFirst.mockResolvedValue(null);

      // Act
      const result = await server.executeOperation(
        {
          query: ME_QUERY,
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
      expectGraphQLError(result, 'User not found');
    });

    it('should handle blockchain connection failures gracefully', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockContracts.wrfToken.balanceOf.mockRejectedValue(
        new Error('Blockchain connection failed')
      );
      mockContracts.wrfGovernor.getVotes.mockRejectedValue(
        new Error('Blockchain connection failed')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: ME_QUERY,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: testUser.walletAddress },
            isAuthenticated: true,
          },
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.me;
      expect(data?.id).toBe(testUser.id); // Default value when blockchain fails
    });

    it('should handle blockchain timeout gracefully', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);

      // Simulate timeout
      mockContracts.wrfToken.balanceOf.mockImplementation(
        () =>
          new Promise(resolve =>
            setTimeout(() => resolve(BigInt('1000000000000000000')), 6000)
          )
      );

      // Act
      const result = await server.executeOperation(
        {
          query: ME_QUERY,
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: testUser.walletAddress },
            isAuthenticated: true,
          },
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.me;
      expect(data?.id).toBe(testUser.id); // Default value when timeout occurs
    }, 10000);
  });

  describe('Query: user', () => {
    const USER_QUERY = gql`
      query User($address: String!) {
        user(address: $address) {
          id
          address
          username
          email
          profile {
            displayName
            bio
            avatar
            location
          wrfBalance
          isVerified
    `;

    it('should return user by address successfully', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.user;
      expect(data).toBeDefined();
      expect(data?.walletAddress).toBe(testUser.walletAddress.toLowerCase());
      expect(data?.email).toBeNull(); // Email should be hidden for public queries
    });

    it('should return null for non-existent user', async () => {
      // Arrange
      mockDb.query.users.findFirst.mockResolvedValue(null);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_QUERY,
          variables: { address: '0x9999999999999999999999999999999999999999' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.user;
      expect(data).toBeNull();
    });

    it('should validate Ethereum address format', async () => {
      // Act
      const result = await server.executeOperation(
        {
          query: USER_QUERY,
          variables: { address: 'invalid-address' },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLError(result, 'Invalid Ethereum address format');
    });

    it('should show email to own profile', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: testUser.walletAddress },
            isAuthenticated: true,
          },
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.user;
      expect(data?.email).toBe(testUser.email); // Email should be visible to own profile
    });
  });

  describe('Query: users', () => {
    const USERS_QUERY = gql`
      query Users($first: Int, $skip: Int, $orderBy: String, $orderDirection: String, $where: UserWhereInput) {
        users(first: $first, skip: $skip, orderBy: $orderBy, orderDirection: $orderDirection, where: $where) {
          id
          address
          username
          profile {
            displayName
          isVerified
    `;

    it('should return list of users with pagination', async () => {
      // Arrange
      const testUsers = [
        createTestUser({
          walletAddress: '0x1111111111111111111111111111111111111111',
        }),
        createTestUser({
          walletAddress: '0x2222222222222222222222222222222222222222',
        }),
      ];
      mockDb.query.users.findMany.mockResolvedValue(testUsers);

      // Act
      const result = await server.executeOperation(
        {
          query: USERS_QUERY,
          variables: { first: 10, skip: 0 },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UsersQueryResponse>(result);
      const data = response.body.singleResult.data?.users;
      expect(data).toHaveLength(2);
      expect(data?.[0]?.address).toBe(testUsers[0].walletAddress);
      expect(data?.[1]?.address).toBe(testUsers[1].walletAddress);
      expect(mockDb.query.users.findMany).toHaveBeenCalledWith({
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
          query: USERS_QUERY,
          variables: { first: 150, skip: 5 },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expect(mockDb.query.users.findMany).toHaveBeenCalledWith({
        where: undefined,
        limit: 20,
        offset: 5,
        orderBy: expect.any(Function),
      });
    });

    it('bounds provider calls and concurrency for the maximum users page', async () => {
      const testUsers = Array.from({ length: 20 }, (_, index) =>
        createTestUser({
          id: index + 1,
          walletAddress: `0x${(index + 1).toString(16).padStart(40, '0')}`,
        })
      );
      mockDb.query.users.findMany.mockResolvedValue(testUsers);

      let inFlight = 0;
      let maxInFlight = 0;
      const boundedRpcResult = () =>
        new Promise<bigint>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          setImmediate(() => {
            inFlight -= 1;
            resolve(1n);
          });
        });
      mockContracts.wrfToken.balanceOf.mockImplementation(boundedRpcResult);
      mockContracts.wrfGovernor.getVotes.mockImplementation(boundedRpcResult);

      const result = await server.executeOperation(
        {
          query: USERS_QUERY,
          variables: { first: 100 },
        },
        {
          contextValue: mockContext,
        }
      );

      expectGraphQLSuccess(result);
      expect(mockDb.query.users.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ limit: 20 })
      );
      expect(mockProvider.getBlockNumber).toHaveBeenCalledTimes(1);
      expect(mockContracts.wrfToken.balanceOf).toHaveBeenCalledTimes(20);
      expect(mockContracts.wrfGovernor.getVotes).toHaveBeenCalledTimes(20);
      expect(maxInFlight).toBeLessThanOrEqual(10);
    });

    it('should filter by verified status', async () => {
      // Act
      await server.executeOperation(
        {
          query: USERS_QUERY,
          variables: {
            where: { isVerified: true },
          },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expect(mockDb.query.users.findMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        limit: 10,
        offset: 0,
        orderBy: expect.any(Function),
      });
    });

    it('should handle search by username', async () => {
      // Act
      await server.executeOperation(
        {
          query: USERS_QUERY,
          variables: {
            where: { username_contains: 'test' },
          },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expect(mockDb.query.users.findMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        limit: 10,
        offset: 0,
        orderBy: expect.any(Function),
      });
    });

    it('should handle blockchain failures gracefully for multiple users', async () => {
      // Arrange
      const testUsers = [createTestUser()];
      mockDb.query.users.findMany.mockResolvedValue(testUsers);
      mockContracts.wrfToken.balanceOf.mockRejectedValue(
        new Error('Connection failed')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: USERS_QUERY,
          variables: { first: 10 },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UsersQueryResponse>(result);
      const data = response.body.singleResult.data?.users;
      expect(data).toHaveLength(1);
      expect(data?.[0]?.address).toBe(testUsers[0].walletAddress);
    });
  });

  describe('Field Resolvers - Carbon Credits', () => {
    const USER_CARBON_CREDITS_QUERY = gql`
      query UserCarbonCredits($address: String!) {
        user(address: $address) {
          carbonCredits(first: 5) {
            id
            tokenId
            carbonOffset
            projectType
            verificationStandard
            isRetired
            forSale
            price
    `;

    it('should return user carbon credits', async () => {
      // Arrange
      const testUser = createTestUser();
      const testCredits = [
        createTestCarbonCredit({ tokenId: '1' }),
        createTestCarbonCredit({ tokenId: '2', projectType: 'forestry' }),
      ];

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.carbonCredits.findMany.mockResolvedValue(testCredits);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_CARBON_CREDITS_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.user?.carbonCredits;
      expect(data).toHaveLength(2);
      expect(data?.[0]?.tokenId).toBe('1');
      expect(data?.[0]?.projectType).toBe('renewable_energy');
      expect(data?.[1]?.tokenId).toBe('2');
      expect(data?.[1]?.projectType).toBe('forestry');

      expect(mockDb.query.carbonCredits.findMany).toHaveBeenCalledWith({
        where: expect.any(Object),
        limit: 5,
        orderBy: expect.any(Function),
      });
    });

    it('should handle empty carbon credits gracefully', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.carbonCredits.findMany.mockResolvedValue([]);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_CARBON_CREDITS_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.user?.carbonCredits;
      expect(data).toHaveLength(0);
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.carbonCredits.findMany.mockRejectedValue(
        new Error('Database error')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: USER_CARBON_CREDITS_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.user?.carbonCredits;
      expect(data).toHaveLength(0); // Should return empty array on error
    });
  });

  describe('Field Resolvers - Carbon Footprint', () => {
    const USER_CARBON_FOOTPRINT_QUERY = gql`
      query UserCarbonFootprint($address: String!) {
        user(address: $address) {
          carbonFootprint {
            id
            totalEmissions
            totalOffsets
            netEmissions
            calculationDate
            methodology
            confidence
    `;

    it('should return user carbon footprint', async () => {
      // Arrange
      const testUser = createTestUser();
      const testFootprint = createTestCarbonFootprint();

      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.carbonFootprints.findFirst.mockResolvedValue(testFootprint);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_CARBON_FOOTPRINT_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.user?.carbonFootprint;
      expect(data).toBeDefined();
      expect(data?.id).toBe(testFootprint.id);
      expect(data?.totalEmissions).toBe(testFootprint.totalEmissions);
      expect(data?.totalOffsets).toBe(testFootprint.totalOffsets);
      expect(data?.netEmissions).toBe(testFootprint.netEmissions);
      expect(data?.metadata?.methodology).toBe('ipcc_2021');
      expect(data?.metadata?.confidence).toBe(0.95);
      expect(mockDb.query.carbonFootprints.findFirst).toHaveBeenCalledWith({
        where: expect.any(Object),
        orderBy: expect.any(Function),
      });
    });

    it('should return null when no footprint exists', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);
      mockDb.query.carbonFootprints.findFirst.mockResolvedValue(null);

      // Act
      const result = await server.executeOperation(
        {
          query: USER_CARBON_FOOTPRINT_QUERY,
          variables: { address: testUser.walletAddress },
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserQueryResponse>(result);
      const data = response.body.singleResult.data?.user?.carbonFootprint;
      expect(data).toBeNull();
    });
  });

  describe('Mutation: updateProfile', () => {
    const UPDATE_PROFILE_MUTATION = gql`
      mutation UpdateProfile($input: UpdateProfileInput!) {
        updateProfile(input: $input) {
          success
          user {
            id
            profile {
              displayName
              bio
              avatar
              location
          error
    `;

    it('should update user profile successfully', async () => {
      // Arrange
      const testUser = createTestUser();
      const updatedUser = {
        ...testUser,
        displayName: 'Updated Name',
        bio: 'Updated bio',
      };

      mockDb.update.mockReturnValue({
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: (jest.fn() as any).mockResolvedValue([updatedUser]),
          }),
        }),
      });

      // Mock signature verification
      const profileHash = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ['string', 'string', 'string', 'string'],
          ['Updated Name', 'Updated bio', '', '']
        )
      );
      const mockSignature = '0x' + '1'.repeat(130);

      // Act
      const result = await server.executeOperation(
        {
          query: UPDATE_PROFILE_MUTATION,
          variables: {
            input: {
              displayName: 'Updated Name',
              bio: 'Updated bio',
              signature: mockSignature,
            },
          },
        },
        {
          contextValue: {
            ...mockContext,
            user: { address: testUser.walletAddress, isVerified: true },
            isAuthenticated: true,
          },
        }
      );

      // Assert
      expectGraphQLSuccess(result);
      const response = assertGraphQLResponse<UserProfileUpdateResponse>(result);
      const data = response.body.singleResult.data?.updateProfile;
      expect(data?.success).toBe(true);
      expect(data?.user).toBeDefined();
      expect(data?.error).toBeNull();
    });

    it('should require signature for profile updates', async () => {
      // Act
      const result = await server.executeOperation(
        {
          query: UPDATE_PROFILE_MUTATION,
          variables: {
            input: {
              displayName: 'Updated Name',
              bio: 'Updated bio',
              // Missing signature
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
      const response = assertGraphQLResponse<UserProfileUpdateResponse>(result);
      const data = response.body.singleResult.data?.updateProfile;
      expect(data?.success).toBe(false);
      expect(data?.error).toContain('Signature is required');
    });

    it('should validate field lengths', async () => {
      // Act
      const result = await server.executeOperation(
        {
          query: UPDATE_PROFILE_MUTATION,
          variables: {
            input: {
              displayName: 'x'.repeat(101), // Too long
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
      const response = assertGraphQLResponse<UserProfileUpdateResponse>(result);
      const data = response.body.singleResult.data?.updateProfile;
      expect(data?.success).toBe(false);
      expect(data?.error).toContain('100 characters or less');
    });

    it('should require verified wallet', async () => {
      // Act
      const result = await server.executeOperation(
        {
          query: UPDATE_PROFILE_MUTATION,
          variables: {
            input: {
              displayName: 'Updated Name',
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
  });

  describe('Performance Tests', () => {
    it('should handle large user queries within acceptable time', async () => {
      // Arrange
      const startTime = Date.now();
      const largeUserList = Array.from({ length: 100 }, (_, i) =>
        createTestUser({ walletAddress: `0x${i.toString().padStart(40, '0')}` })
      );
      mockDb.query.users.findMany.mockResolvedValue(largeUserList);

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
          query Users {
            users(first: 100) {
              id
              address
              username
              wrfBalance
        `,
        },
        {
          contextValue: mockContext,
        }
      );

      // Assert
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
      expectGraphQLSuccess(result);

      const response = assertGraphQLResponse<UsersQueryResponse>(result);
      const data = response.body.singleResult.data?.users;
      expect(data).toHaveLength(100);
    }, 10000);

    it('should handle concurrent requests efficiently', async () => {
      // Arrange
      const testUser = createTestUser();
      mockDb.query.users.findFirst.mockResolvedValue(testUser);

      const userQuery = gql`
        query User($address: String!) {
          user(address: $address) {
            id
            username
            wrfBalance
      `;

      // Act - Run 10 concurrent requests
      const promises = Array.from({ length: 10 }, () =>
        server.executeOperation(
          {
            query: userQuery,
            variables: { address: testUser.walletAddress },
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

      // Should have made efficient database calls (not necessarily 10 calls due to potential caching)
      expect(mockDb.query.users.findFirst).toHaveBeenCalled();
    }, 10000);
  });

  describe('Error Handling', () => {
    it('should handle database connection failures', async () => {
      // Arrange
      mockDb.query.users.findFirst.mockRejectedValue(
        new Error('Database connection failed')
      );

      // Act
      const result = await server.executeOperation(
        {
          query: gql`
          query Me {
            me {
              id
              username
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
      expectGraphQLError(result, 'Database connection failed');
    });

    it('should handle invalid input gracefully', async () => {
      // Test various invalid inputs
      const invalidInputs = [
        null,
        undefined,
        '',
        'invalid-address',
        '0x',
        '0x123', // Too short
      ];

      for (const invalidAddress of invalidInputs) {
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

        expectGraphQLError(result, 'Invalid');
      }
    });

    it('should provide proper error context in logs', async () => {
      // This test would verify that errors are logged with proper context
      // In a real scenario, you'd mock the logger and verify calls

      // Arrange
      const consoleSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => {});
      mockDb.query.users.findFirst.mockRejectedValue(new Error('Test error'));

      // Act
      await server.executeOperation(
        {
          query: gql`
          query Me {
            me {
              id
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

      // Cleanup
      consoleSpy.mockRestore();
    });
  });
});
