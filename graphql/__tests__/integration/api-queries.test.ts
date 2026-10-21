/**
 * GraphQL API Integration Tests - Query Operations
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  jest,
} from '@jest/globals';
import { ApolloServer } from '@apollo/server';
import { gql } from 'graphql-tag';
import { typeDefs } from '../../schema/typeDefs.js';
import { resolvers } from '../../resolvers/index.js';
import { createMockDataSource } from '../mocks/datasource.js';
import { GraphQLContext } from '../../context.js';

// Modern test client for Apollo Server v4
async function createTestClient(server: ApolloServer<GraphQLContext>) {
  const executeOperation = async (operation: any) => {
    return await server.executeOperation(operation, {
      contextValue: {
        user: { address: '0x' + '1'.repeat(40) },
        isAuthenticated: true,
      } as any,
    });
  };

  return {
    query: executeOperation,
    mutate: executeOperation,
  };
}

describe('GraphQL API - Query Operations', () => {
  let server: ApolloServer<GraphQLContext>;
  let query: any;
  let mutate: any;
  let mockDataSource: any;

  beforeAll(async () => {
    mockDataSource = createMockDataSource();

    server = new ApolloServer<GraphQLContext>({
      typeDefs,
      resolvers,
    });

    const testClient = await createTestClient(server);
    query = testClient.query;
    mutate = testClient.mutate;
  });

  afterAll(async () => {
    await server?.stop();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockDataSource.resetMocks();
  });

  describe('Blockchain Queries', () => {
    it('should query latest blocks', async () => {
      const mockBlocks = [
        {
          id: '1',
          hash: '0x' + '1'.repeat(64),
          height: 12345,
          timestamp: new Date().toISOString(),
          transactions: [],
          previousHash: '0x' + '0'.repeat(64),
          merkleRoot: '0x' + '2'.repeat(64),
          nonce: 0,
        },
        {
          id: '2',
          hash: '0x' + '2'.repeat(64),
          height: 12346,
          timestamp: new Date().toISOString(),
          transactions: [],
          previousHash: '0x' + '1'.repeat(64),
          merkleRoot: '0x' + '3'.repeat(64),
          nonce: 1,
        },
      ];

      mockDataSource.blockchain.getLatestBlocks.mockResolvedValue(mockBlocks);

      const GET_LATEST_BLOCKS = gql`
        query GetLatestBlocks($limit: Int) {
          blocks(limit: $limit) {
            id
            hash
            height
            timestamp
            transactions {
              id
              hash
              type
              amount
              status
            }
            previousHash
            merkleRoot
            nonce
          }
        }
      `;

      const result = await query({
        query: GET_LATEST_BLOCKS,
        variables: { limit: 10 },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.blocks).toHaveLength(2);
      expect(result.data.blocks[0]).toMatchObject({
        id: '1',
        hash: '0x' + '1'.repeat(64),
        height: 12345,
      });
      expect(mockDataSource.blockchain.getLatestBlocks).toHaveBeenCalledWith(
        10
      );
    });

    it('should query specific block by height', async () => {
      const mockBlock = {
        id: '1',
        hash: '0x' + '1'.repeat(64),
        height: 12345,
        timestamp: new Date().toISOString(),
        transactions: [
          {
            id: 'tx1',
            hash: '0x' + '3'.repeat(64),
            type: 'Regular',
            amount: '100',
            status: 'confirmed',
          },
        ],
        previousHash: '0x' + '0'.repeat(64),
        merkleRoot: '0x' + '2'.repeat(64),
        nonce: 0,
      };

      mockDataSource.blockchain.getBlockByHeight.mockResolvedValue(mockBlock);

      const GET_BLOCK_BY_HEIGHT = gql`
        query GetBlockByHeight($height: Int!) {
          block(height: $height) {
            id
            hash
            height
            timestamp
            transactions {
              id
              hash
              type
              amount
              status
            }
            previousHash
            merkleRoot
            nonce
          }
        }
      `;

      const result = await query({
        query: GET_BLOCK_BY_HEIGHT,
        variables: { height: 12345 },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.block).toMatchObject({
        id: '1',
        hash: '0x' + '1'.repeat(64),
        height: 12345,
      });
      expect(result.data.block.transactions).toHaveLength(1);
      expect(mockDataSource.blockchain.getBlockByHeight).toHaveBeenCalledWith(
        12345
      );
    });

    it('should query network statistics', async () => {
      const mockStats = {
        totalBlocks: 12346,
        totalTransactions: 25000,
        hashRate: 500,
        difficulty: 1000,
        averageBlockTime: 15,
        activeNodes: 25,
      };

      mockDataSource.blockchain.getNetworkStats.mockResolvedValue(mockStats);

      const GET_NETWORK_STATS = gql`
        query GetNetworkStats {
          networkStats {
            totalBlocks
            totalTransactions
            hashRate
            difficulty
            averageBlockTime
            activeNodes
          }
        }
      `;

      const result = await query({
        query: GET_NETWORK_STATS,
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.networkStats).toEqual(mockStats);
      expect(mockDataSource.blockchain.getNetworkStats).toHaveBeenCalled();
    });
  });

  describe('Wallet Queries', () => {
    it('should query wallet balance', async () => {
      const mockBalance = {
        address: '0x' + '1'.repeat(40),
        balance: '1000.5',
        tokens: [
          { symbol: 'WRF', balance: '1000.5' },
          { symbol: 'USDC', balance: '500.0' },
        ],
      };

      mockDataSource.wallet.getBalance.mockResolvedValue(mockBalance);

      const GET_WALLET_BALANCE = gql`
        query GetWalletBalance($address: String!) {
          walletBalance(address: $address) {
            address
            balance
            tokens {
              symbol
              balance
            }
          }
        }
      `;

      const result = await query({
        query: GET_WALLET_BALANCE,
        variables: { address: '0x' + '1'.repeat(40) },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.walletBalance).toEqual(mockBalance);
      expect(mockDataSource.wallet.getBalance).toHaveBeenCalledWith(
        '0x' + '1'.repeat(40)
      );
    });

    it('should query transaction history', async () => {
      const mockTransactions = [
        {
          id: 'tx1',
          hash: '0x' + '1'.repeat(64),
          from: '0x' + '1'.repeat(40),
          to: '0x' + '2'.repeat(40),
          amount: '100',
          type: 'Regular',
          status: 'confirmed',
          timestamp: new Date().toISOString(),
          blockHeight: 12345,
        },
        {
          id: 'tx2',
          hash: '0x' + '2'.repeat(64),
          from: '0x' + '2'.repeat(40),
          to: '0x' + '1'.repeat(40),
          amount: '50',
          type: 'Regular',
          status: 'confirmed',
          timestamp: new Date().toISOString(),
          blockHeight: 12346,
        },
      ];

      mockDataSource.wallet.getTransactionHistory.mockResolvedValue(
        mockTransactions
      );

      const GET_TRANSACTION_HISTORY = gql`
        query GetTransactionHistory($address: String!, $limit: Int) {
          transactionHistory(address: $address, limit: $limit) {
            id
            hash
            from
            to
            amount
            type
            status
            timestamp
            blockHeight
          }
        }
      `;

      const result = await query({
        query: GET_TRANSACTION_HISTORY,
        variables: { address: '0x' + '1'.repeat(40), limit: 10 },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.transactionHistory).toEqual(mockTransactions);
      expect(mockDataSource.wallet.getTransactionHistory).toHaveBeenCalledWith(
        '0x' + '1'.repeat(40),
        10
      );
    });
  });

  describe('NFT Queries', () => {
    it('should query NFT collection', async () => {
      const mockNFTs = [
        {
          id: 'nft1',
          tokenId: '1',
          contractAddress: '0x' + '3'.repeat(40),
          owner: '0x' + '1'.repeat(40),
          metadata: {
            name: 'Weather NFT #1',
            description: 'Temperature data from Station A',
            image: 'https://example.com/nft1.png',
            attributes: [
              { trait_type: 'Temperature', value: '25.5°C' },
              { trait_type: 'Location', value: 'New York' },
            ],
          },
          mintedAt: new Date().toISOString(),
          type: 'WeatherData',
        },
      ];

      mockDataSource.nft.getNFTsByOwner.mockResolvedValue(mockNFTs);

      const GET_NFTS_BY_OWNER = gql`
        query GetNFTsByOwner($owner: String!) {
          nftsByOwner(owner: $owner) {
            id
            tokenId
            contractAddress
            owner
            metadata {
              name
              description
              image
              attributes {
                trait_type
                value
              }
            }
            mintedAt
            type
          }
        }
      `;

      const result = await query({
        query: GET_NFTS_BY_OWNER,
        variables: { owner: '0x' + '1'.repeat(40) },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.nftsByOwner).toEqual(mockNFTs);
      expect(mockDataSource.nft.getNFTsByOwner).toHaveBeenCalledWith(
        '0x' + '1'.repeat(40)
      );
    });

    it('should query specific NFT details', async () => {
      const mockNFT = {
        id: 'nft1',
        tokenId: '1',
        contractAddress: '0x' + '3'.repeat(40),
        owner: '0x' + '1'.repeat(40),
        metadata: {
          name: 'Weather NFT #1',
          description: 'Temperature data from Station A',
          image: 'https://example.com/nft1.png',
          attributes: [
            { trait_type: 'Temperature', value: '25.5°C' },
            { trait_type: 'Location', value: 'New York' },
          ],
        },
        mintedAt: new Date().toISOString(),
        type: 'WeatherData',
        transferHistory: [
          {
            from: '0x' + '0'.repeat(40),
            to: '0x' + '1'.repeat(40),
            timestamp: new Date().toISOString(),
            txHash: '0x' + '4'.repeat(64),
          },
        ],
      };

      mockDataSource.nft.getNFTDetails.mockResolvedValue(mockNFT);

      const GET_NFT_DETAILS = gql`
        query GetNFTDetails($contractAddress: String!, $tokenId: String!) {
          nft(contractAddress: $contractAddress, tokenId: $tokenId) {
            id
            tokenId
            contractAddress
            owner
            metadata {
              name
              description
              image
              attributes {
                trait_type
                value
              }
            }
            mintedAt
            type
            transferHistory {
              from
              to
              timestamp
              txHash
            }
          }
        }
      `;

      const result = await query({
        query: GET_NFT_DETAILS,
        variables: { contractAddress: '0x' + '3'.repeat(40), tokenId: '1' },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.nft).toEqual(mockNFT);
      expect(mockDataSource.nft.getNFTDetails).toHaveBeenCalledWith(
        '0x' + '3'.repeat(40),
        '1'
      );
    });
  });

  describe('Weather Data Queries', () => {
    it('should query weather data by location', async () => {
      const mockWeatherData = [
        {
          id: 'weather1',
          stationId: 'station-001',
          location: {
            latitude: 40.7128,
            longitude: -74.006,
            name: 'New York',
          },
          temperature: 25.5,
          humidity: 0.45,
          pressure: 1013.25,
          windSpeed: 5.5,
          windDirection: 270,
          precipitation: 0,
          timestamp: new Date().toISOString(),
          quality: 'HIGH',
        },
      ];

      mockDataSource.weather.getWeatherDataByLocation.mockResolvedValue(
        mockWeatherData
      );

      const GET_WEATHER_DATA = gql`
        query GetWeatherData(
          $latitude: Float!
          $longitude: Float!
          $limit: Int
        ) {
          weatherData(
            latitude: $latitude
            longitude: $longitude
            limit: $limit
          ) {
            id
            stationId
            location {
              latitude
              longitude
              name
            }
            temperature
            humidity
            pressure
            windSpeed
            windDirection
            precipitation
            timestamp
            quality
          }
        }
      `;

      const result = await query({
        query: GET_WEATHER_DATA,
        variables: { latitude: 40.7128, longitude: -74.006, limit: 10 },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.weatherData).toEqual(mockWeatherData);
      expect(
        mockDataSource.weather.getWeatherDataByLocation
      ).toHaveBeenCalledWith(40.7128, -74.006, 10);
    });

    it('should query weather stations', async () => {
      const mockStations = [
        {
          id: 'station-001',
          name: 'NYC Weather Station',
          location: {
            latitude: 40.7128,
            longitude: -74.006,
            name: 'New York',
          },
          status: 'ACTIVE',
          owner: '0x' + '1'.repeat(40),
          registeredAt: new Date().toISOString(),
          lastDataTimestamp: new Date().toISOString(),
        },
      ];

      mockDataSource.weather.getWeatherStations.mockResolvedValue(mockStations);

      const GET_WEATHER_STATIONS = gql`
        query GetWeatherStations {
          weatherStations {
            id
            name
            location {
              latitude
              longitude
              name
            }
            status
            owner
            registeredAt
            lastDataTimestamp
          }
        }
      `;

      const result = await query({
        query: GET_WEATHER_STATIONS,
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.weatherStations).toEqual(mockStations);
      expect(mockDataSource.weather.getWeatherStations).toHaveBeenCalled();
    });
  });

  describe('Governance Queries', () => {
    it('should query governance proposals', async () => {
      const mockProposals = [
        {
          id: 'proposal1',
          title: 'Increase Block Size',
          description:
            'Proposal to increase the maximum block size from 1MB to 2MB',
          proposer: '0x' + '1'.repeat(40),
          status: 'ACTIVE',
          votingPower: {
            for: '1000000',
            against: '500000',
            abstain: '100000',
          },
          startTime: new Date().toISOString(),
          endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
          executionTime: null,
          type: 'PARAMETER_CHANGE',
        },
      ];

      mockDataSource.governance.getProposals.mockResolvedValue(mockProposals);

      const GET_PROPOSALS = gql`
        query GetProposals($status: String) {
          proposals(status: $status) {
            id
            title
            description
            proposer
            status
            votingPower {
              for
              against
              abstain
            }
            startTime
            endTime
            executionTime
            type
          }
        }
      `;

      const result = await query({
        query: GET_PROPOSALS,
        variables: { status: 'ACTIVE' },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.proposals).toEqual(mockProposals);
      expect(mockDataSource.governance.getProposals).toHaveBeenCalledWith(
        'ACTIVE'
      );
    });

    it('should query user voting power', async () => {
      const mockVotingPower = {
        address: '0x' + '1'.repeat(40),
        totalPower: '1000000',
        delegatedPower: '500000',
        ownPower: '500000',
        activeProposals: 3,
      };

      mockDataSource.governance.getVotingPower.mockResolvedValue(
        mockVotingPower
      );

      const GET_VOTING_POWER = gql`
        query GetVotingPower($address: String!) {
          votingPower(address: $address) {
            address
            totalPower
            delegatedPower
            ownPower
            activeProposals
          }
        }
      `;

      const result = await query({
        query: GET_VOTING_POWER,
        variables: { address: '0x' + '1'.repeat(40) },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.votingPower).toEqual(mockVotingPower);
      expect(mockDataSource.governance.getVotingPower).toHaveBeenCalledWith(
        '0x' + '1'.repeat(40)
      );
    });
  });

  describe('Cross-Chain Bridge Queries', () => {
    it('should query bridge transactions', async () => {
      const mockBridgeTransactions = [
        {
          id: 'bridge1',
          sourceNetwork: 'ethereum',
          targetNetwork: 'arbitrum',
          sourceAddress: '0x' + '1'.repeat(40),
          targetAddress: '0x' + '2'.repeat(40),
          token: 'USDC',
          amount: '1000',
          status: 'COMPLETED',
          sourceTxHash: '0x' + '3'.repeat(64),
          targetTxHash: '0x' + '4'.repeat(64),
          timestamp: new Date().toISOString(),
          fees: {
            source: '0.01',
            target: '0.005',
            bridge: '0.02',
          },
        },
      ];

      mockDataSource.bridge.getBridgeTransactions.mockResolvedValue(
        mockBridgeTransactions
      );

      const GET_BRIDGE_TRANSACTIONS = gql`
        query GetBridgeTransactions($address: String!) {
          bridgeTransactions(address: $address) {
            id
            sourceNetwork
            targetNetwork
            sourceAddress
            targetAddress
            token
            amount
            status
            sourceTxHash
            targetTxHash
            timestamp
            fees {
              source
              target
              bridge
            }
          }
        }
      `;

      const result = await query({
        query: GET_BRIDGE_TRANSACTIONS,
        variables: { address: '0x' + '1'.repeat(40) },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.bridgeTransactions).toEqual(mockBridgeTransactions);
      expect(mockDataSource.bridge.getBridgeTransactions).toHaveBeenCalledWith(
        '0x' + '1'.repeat(40)
      );
    });

    it('should query supported networks', async () => {
      const mockNetworks = [
        {
          id: 'ethereum',
          name: 'Ethereum',
          chainId: 1,
          status: 'ACTIVE',
          supportedTokens: ['ETH', 'USDC', 'USDT'],
        },
        {
          id: 'arbitrum',
          name: 'Arbitrum',
          chainId: 42161,
          status: 'ACTIVE',
          supportedTokens: ['ETH', 'USDC', 'USDT'],
        },
      ];

      mockDataSource.bridge.getSupportedNetworks.mockResolvedValue(
        mockNetworks
      );

      const GET_SUPPORTED_NETWORKS = gql`
        query GetSupportedNetworks {
          supportedNetworks {
            id
            name
            chainId
            status
            supportedTokens
          }
        }
      `;

      const result = await query({
        query: GET_SUPPORTED_NETWORKS,
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.supportedNetworks).toEqual(mockNetworks);
      expect(mockDataSource.bridge.getSupportedNetworks).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle network errors gracefully', async () => {
      mockDataSource.blockchain.getLatestBlocks.mockRejectedValue(
        new Error('Network error')
      );

      const GET_LATEST_BLOCKS = gql`
        query GetLatestBlocks {
          blocks {
            id
            hash
            height
          }
        }
      `;

      const result = await query({
        query: GET_LATEST_BLOCKS,
      });

      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Network error');
    });

    it('should handle validation errors', async () => {
      const INVALID_QUERY = gql`
        query InvalidQuery {
          nonExistentField
        }
      `;

      const result = await query({
        query: INVALID_QUERY,
      });

      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Cannot query field');
    });

    it('should handle missing parameters', async () => {
      const GET_BLOCK_BY_HEIGHT = gql`
        query GetBlockByHeight($height: Int!) {
          block(height: $height) {
            id
            hash
            height
          }
        }
      `;

      const result = await query({
        query: GET_BLOCK_BY_HEIGHT,
        // Missing required variables
      });

      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain(
        'Variable "$height" of required type "Int!" was not provided'
      );
    });
  });

  describe('Performance and Pagination', () => {
    it('should handle large result sets with pagination', async () => {
      const mockBlocks = Array.from({ length: 100 }, (_, i) => ({
        id: `${i + 1}`,
        hash: '0x' + (i + 1).toString().padStart(64, '0'),
        height: i + 1,
        timestamp: new Date().toISOString(),
        transactions: [],
      }));

      mockDataSource.blockchain.getLatestBlocks.mockResolvedValue(
        mockBlocks.slice(0, 10)
      );

      const GET_LATEST_BLOCKS = gql`
        query GetLatestBlocks($limit: Int, $offset: Int) {
          blocks(limit: $limit, offset: $offset) {
            id
            hash
            height
            timestamp
          }
        }
      `;

      const result = await query({
        query: GET_LATEST_BLOCKS,
        variables: { limit: 10, offset: 0 },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.blocks).toHaveLength(10);
      expect(mockDataSource.blockchain.getLatestBlocks).toHaveBeenCalledWith(
        10,
        0
      );
    });

    it('should handle concurrent queries efficiently', async () => {
      mockDataSource.blockchain.getLatestBlocks.mockResolvedValue([]);
      mockDataSource.wallet.getBalance.mockResolvedValue({ balance: '0' });

      const GET_DASHBOARD_DATA = gql`
        query GetDashboardData($address: String!) {
          blocks(limit: 5) {
            id
            hash
            height
          }
          walletBalance(address: $address) {
            balance
          }
        }
      `;

      const result = await query({
        query: GET_DASHBOARD_DATA,
        variables: { address: '0x' + '1'.repeat(40) },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.blocks).toBeDefined();
      expect(result.data.walletBalance).toBeDefined();
    });
  });
});
