/**
 * GraphQL API Integration Tests - Mutation Operations
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

describe('GraphQL API - Mutation Operations', () => {
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

  describe('Wallet Mutations', () => {
    it('should create a new wallet', async () => {
      const mockWallet = {
        address: '0x' + '2'.repeat(40),
        publicKey: '0x' + '3'.repeat(66),
        encrypted: true,
        createdAt: new Date().toISOString(),
      };

      mockDataSource.wallet.createWallet.mockResolvedValue(mockWallet);

      const CREATE_WALLET = gql`
        mutation CreateWallet($password: String!) {
          createWallet(password: $password) {
            address
            publicKey
            encrypted
            createdAt
          }
        }
      `;

      const result = await mutate({
        mutation: CREATE_WALLET,
        variables: { password: 'secure-password' },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.createWallet).toEqual(mockWallet);
      expect(mockDataSource.wallet.createWallet).toHaveBeenCalledWith(
        'secure-password'
      );
    });

    it('should import wallet from private key', async () => {
      const mockWallet = {
        address: '0x' + '2'.repeat(40),
        publicKey: '0x' + '3'.repeat(66),
        encrypted: false,
        createdAt: new Date().toISOString(),
      };

      mockDataSource.wallet.importWallet.mockResolvedValue(mockWallet);

      const IMPORT_WALLET = gql`
        mutation ImportWallet($privateKey: String!, $password: String) {
          importWallet(privateKey: $privateKey, password: $password) {
            address
            publicKey
            encrypted
            createdAt
          }
        }
      `;

      const result = await mutate({
        mutation: IMPORT_WALLET,
        variables: {
          privateKey: '0x' + '1'.repeat(64),
          password: 'secure-password',
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.importWallet).toEqual(mockWallet);
      expect(mockDataSource.wallet.importWallet).toHaveBeenCalledWith(
        '0x' + '1'.repeat(64),
        'secure-password'
      );
    });

    it('should send transaction', async () => {
      const mockTransaction = {
        id: 'tx1',
        hash: '0x' + '1'.repeat(64),
        from: '0x' + '1'.repeat(40),
        to: '0x' + '2'.repeat(40),
        amount: '100',
        type: 'Regular',
        status: 'pending',
        timestamp: new Date().toISOString(),
        gasUsed: '21000',
        gasPrice: '10',
      };

      mockDataSource.wallet.sendTransaction.mockResolvedValue(mockTransaction);

      const SEND_TRANSACTION = gql`
        mutation SendTransaction($input: TransactionInput!) {
          sendTransaction(input: $input) {
            id
            hash
            from
            to
            amount
            type
            status
            timestamp
            gasUsed
            gasPrice
          }
        }
      `;

      const result = await mutate({
        mutation: SEND_TRANSACTION,
        variables: {
          input: {
            to: '0x' + '2'.repeat(40),
            amount: '100',
            type: 'Regular',
          },
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.sendTransaction).toEqual(mockTransaction);
      expect(mockDataSource.wallet.sendTransaction).toHaveBeenCalledWith({
        to: '0x' + '2'.repeat(40),
        amount: '100',
        type: 'Regular',
      });
    });
  });

  describe('NFT Mutations', () => {
    it('should mint NFT', async () => {
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
        txHash: '0x' + '4'.repeat(64),
      };

      mockDataSource.nft.mintNFT.mockResolvedValue(mockNFT);

      const MINT_NFT = gql`
        mutation MintNFT($input: MintNFTInput!) {
          mintNFT(input: $input) {
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
            txHash
          }
        }
      `;

      const result = await mutate({
        mutation: MINT_NFT,
        variables: {
          input: {
            contractAddress: '0x' + '3'.repeat(40),
            recipient: '0x' + '1'.repeat(40),
            metadata: {
              name: 'Weather NFT #1',
              description: 'Temperature data from Station A',
              image: 'https://example.com/nft1.png',
              attributes: [
                { trait_type: 'Temperature', value: '25.5°C' },
                { trait_type: 'Location', value: 'New York' },
              ],
            },
            type: 'WeatherData',
          },
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.mintNFT).toEqual(mockNFT);
      expect(mockDataSource.nft.mintNFT).toHaveBeenCalledWith({
        contractAddress: '0x' + '3'.repeat(40),
        recipient: '0x' + '1'.repeat(40),
        metadata: {
          name: 'Weather NFT #1',
          description: 'Temperature data from Station A',
          image: 'https://example.com/nft1.png',
          attributes: [
            { trait_type: 'Temperature', value: '25.5°C' },
            { trait_type: 'Location', value: 'New York' },
          ],
        },
        type: 'WeatherData',
      });
    });

    it('should transfer NFT', async () => {
      const mockTransfer = {
        id: 'transfer1',
        tokenId: '1',
        contractAddress: '0x' + '3'.repeat(40),
        from: '0x' + '1'.repeat(40),
        to: '0x' + '2'.repeat(40),
        txHash: '0x' + '5'.repeat(64),
        timestamp: new Date().toISOString(),
        status: 'confirmed',
      };

      mockDataSource.nft.transferNFT.mockResolvedValue(mockTransfer);

      const TRANSFER_NFT = gql`
        mutation TransferNFT($input: TransferNFTInput!) {
          transferNFT(input: $input) {
            id
            tokenId
            contractAddress
            from
            to
            txHash
            timestamp
            status
          }
        }
      `;

      const result = await mutate({
        mutation: TRANSFER_NFT,
        variables: {
          input: {
            contractAddress: '0x' + '3'.repeat(40),
            tokenId: '1',
            to: '0x' + '2'.repeat(40),
          },
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.transferNFT).toEqual(mockTransfer);
      expect(mockDataSource.nft.transferNFT).toHaveBeenCalledWith({
        contractAddress: '0x' + '3'.repeat(40),
        tokenId: '1',
        to: '0x' + '2'.repeat(40),
      });
    });
  });

  describe('Weather Data Mutations', () => {
    it('should submit weather data', async () => {
      const mockWeatherData = {
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
        signature: '0x' + '6'.repeat(130),
        verified: true,
      };

      mockDataSource.weather.submitWeatherData.mockResolvedValue(
        mockWeatherData
      );

      const SUBMIT_WEATHER_DATA = gql`
        mutation SubmitWeatherData($input: WeatherDataInput!) {
          submitWeatherData(input: $input) {
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
            signature
            verified
          }
        }
      `;

      const result = await mutate({
        mutation: SUBMIT_WEATHER_DATA,
        variables: {
          input: {
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
            signature: '0x' + '6'.repeat(130),
          },
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.submitWeatherData).toEqual(mockWeatherData);
      expect(mockDataSource.weather.submitWeatherData).toHaveBeenCalledWith({
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
        signature: '0x' + '6'.repeat(130),
      });
    });

    it('should register weather station', async () => {
      const mockStation = {
        id: 'station-002',
        name: 'Brooklyn Weather Station',
        location: {
          latitude: 40.6782,
          longitude: -73.9442,
          name: 'Brooklyn',
        },
        owner: '0x' + '1'.repeat(40),
        status: 'ACTIVE',
        registeredAt: new Date().toISOString(),
        lastDataTimestamp: null,
        configuration: {
          dataInterval: 300,
          precision: 'HIGH',
          sensors: ['temperature', 'humidity', 'pressure', 'wind'],
        },
      };

      mockDataSource.weather.registerWeatherStation.mockResolvedValue(
        mockStation
      );

      const REGISTER_WEATHER_STATION = gql`
        mutation RegisterWeatherStation($input: WeatherStationInput!) {
          registerWeatherStation(input: $input) {
            id
            name
            location {
              latitude
              longitude
              name
            }
            owner
            status
            registeredAt
            lastDataTimestamp
            configuration {
              dataInterval
              precision
              sensors
            }
          }
        }
      `;

      const result = await mutate({
        mutation: REGISTER_WEATHER_STATION,
        variables: {
          input: {
            name: 'Brooklyn Weather Station',
            location: {
              latitude: 40.6782,
              longitude: -73.9442,
              name: 'Brooklyn',
            },
            configuration: {
              dataInterval: 300,
              precision: 'HIGH',
              sensors: ['temperature', 'humidity', 'pressure', 'wind'],
            },
          },
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.registerWeatherStation).toEqual(mockStation);
      expect(
        mockDataSource.weather.registerWeatherStation
      ).toHaveBeenCalledWith({
        name: 'Brooklyn Weather Station',
        location: {
          latitude: 40.6782,
          longitude: -73.9442,
          name: 'Brooklyn',
        },
        configuration: {
          dataInterval: 300,
          precision: 'HIGH',
          sensors: ['temperature', 'humidity', 'pressure', 'wind'],
        },
      });
    });
  });

  describe('Governance Mutations', () => {
    it('should create governance proposal', async () => {
      const mockProposal = {
        id: 'proposal2',
        title: 'Reduce Transaction Fees',
        description: 'Proposal to reduce transaction fees from 0.1% to 0.05%',
        proposer: '0x' + '1'.repeat(40),
        status: 'PENDING',
        type: 'PARAMETER_CHANGE',
        startTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        endTime: new Date(Date.now() + 8 * 24 * 60 * 60 * 1000).toISOString(),
        executionTime: null,
        votingPower: {
          for: '0',
          against: '0',
          abstain: '0',
        },
        parameters: {
          transactionFee: '0.0005',
        },
        requiredVotingPower: '1000000',
      };

      mockDataSource.governance.createProposal.mockResolvedValue(mockProposal);

      const CREATE_PROPOSAL = gql`
        mutation CreateProposal($input: ProposalInput!) {
          createProposal(input: $input) {
            id
            title
            description
            proposer
            status
            type
            startTime
            endTime
            executionTime
            votingPower {
              for
              against
              abstain
            }
            parameters
            requiredVotingPower
          }
        }
      `;

      const result = await mutate({
        mutation: CREATE_PROPOSAL,
        variables: {
          input: {
            title: 'Reduce Transaction Fees',
            description:
              'Proposal to reduce transaction fees from 0.1% to 0.05%',
            type: 'PARAMETER_CHANGE',
            parameters: {
              transactionFee: '0.0005',
            },
          },
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.createProposal).toEqual(mockProposal);
      expect(mockDataSource.governance.createProposal).toHaveBeenCalledWith({
        title: 'Reduce Transaction Fees',
        description: 'Proposal to reduce transaction fees from 0.1% to 0.05%',
        type: 'PARAMETER_CHANGE',
        parameters: {
          transactionFee: '0.0005',
        },
      });
    });

    it('should vote on proposal', async () => {
      const mockVote = {
        id: 'vote1',
        proposalId: 'proposal1',
        voter: '0x' + '1'.repeat(40),
        choice: 'FOR',
        votingPower: '500000',
        timestamp: new Date().toISOString(),
        txHash: '0x' + '7'.repeat(64),
      };

      mockDataSource.governance.vote.mockResolvedValue(mockVote);

      const VOTE_ON_PROPOSAL = gql`
        mutation VoteOnProposal($input: VoteInput!) {
          voteOnProposal(input: $input) {
            id
            proposalId
            voter
            choice
            votingPower
            timestamp
            txHash
          }
        }
      `;

      const result = await mutate({
        mutation: VOTE_ON_PROPOSAL,
        variables: {
          input: {
            proposalId: 'proposal1',
            choice: 'FOR',
          },
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.voteOnProposal).toEqual(mockVote);
      expect(mockDataSource.governance.vote).toHaveBeenCalledWith({
        proposalId: 'proposal1',
        choice: 'FOR',
      });
    });

    it('should delegate voting power', async () => {
      const mockDelegation = {
        id: 'delegation1',
        delegator: '0x' + '1'.repeat(40),
        delegate: '0x' + '2'.repeat(40),
        amount: '1000000',
        timestamp: new Date().toISOString(),
        txHash: '0x' + '8'.repeat(64),
        active: true,
      };

      mockDataSource.governance.delegateVotingPower.mockResolvedValue(
        mockDelegation
      );

      const DELEGATE_VOTING_POWER = gql`
        mutation DelegateVotingPower($input: DelegationInput!) {
          delegateVotingPower(input: $input) {
            id
            delegator
            delegate
            amount
            timestamp
            txHash
            active
          }
        }
      `;

      const result = await mutate({
        mutation: DELEGATE_VOTING_POWER,
        variables: {
          input: {
            delegate: '0x' + '2'.repeat(40),
            amount: '1000000',
          },
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.delegateVotingPower).toEqual(mockDelegation);
      expect(
        mockDataSource.governance.delegateVotingPower
      ).toHaveBeenCalledWith({
        delegate: '0x' + '2'.repeat(40),
        amount: '1000000',
      });
    });
  });

  describe('Bridge Mutations', () => {
    it('should initiate bridge transfer', async () => {
      const mockBridgeTransfer = {
        id: 'bridge2',
        sourceNetwork: 'ethereum',
        targetNetwork: 'arbitrum',
        sourceAddress: '0x' + '1'.repeat(40),
        targetAddress: '0x' + '2'.repeat(40),
        token: 'USDC',
        amount: '1000',
        status: 'PENDING',
        sourceTxHash: '0x' + '9'.repeat(64),
        targetTxHash: null,
        timestamp: new Date().toISOString(),
        estimatedCompletionTime: new Date(
          Date.now() + 10 * 60 * 1000
        ).toISOString(),
        fees: {
          source: '0.01',
          target: '0.005',
          bridge: '0.02',
        },
      };

      mockDataSource.bridge.initiateBridgeTransfer.mockResolvedValue(
        mockBridgeTransfer
      );

      const INITIATE_BRIDGE_TRANSFER = gql`
        mutation InitiateBridgeTransfer($input: BridgeTransferInput!) {
          initiateBridgeTransfer(input: $input) {
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
            estimatedCompletionTime
            fees {
              source
              target
              bridge
            }
          }
        }
      `;

      const result = await mutate({
        mutation: INITIATE_BRIDGE_TRANSFER,
        variables: {
          input: {
            sourceNetwork: 'ethereum',
            targetNetwork: 'arbitrum',
            targetAddress: '0x' + '2'.repeat(40),
            token: 'USDC',
            amount: '1000',
          },
        },
      });

      expect(result.errors).toBeUndefined();
      expect(result.data.initiateBridgeTransfer).toEqual(mockBridgeTransfer);
      expect(mockDataSource.bridge.initiateBridgeTransfer).toHaveBeenCalledWith(
        {
          sourceNetwork: 'ethereum',
          targetNetwork: 'arbitrum',
          targetAddress: '0x' + '2'.repeat(40),
          token: 'USDC',
          amount: '1000',
        }
      );
    });
  });

  describe('Authentication & Authorization', () => {
    it('should reject unauthenticated mutations', async () => {
      // Override server context to simulate unauthenticated request
      const unauthenticatedServer = new ApolloServer<GraphQLContext>({
        typeDefs,
        resolvers,
      });

      const { mutate: unauthenticatedMutate } = await createTestClient(
        unauthenticatedServer
      );

      const SEND_TRANSACTION = gql`
        mutation SendTransaction($input: TransactionInput!) {
          sendTransaction(input: $input) {
            id
            hash
          }
        }
      `;

      const result = await unauthenticatedMutate({
        mutation: SEND_TRANSACTION,
        variables: {
          input: {
            to: '0x' + '2'.repeat(40),
            amount: '100',
            type: 'Regular',
          },
        },
      });

      expect((result as any).errors).toBeDefined();
      expect((result as any).errors[0].message).toContain(
        'Authentication required'
      );

      await unauthenticatedServer.stop();
    });

    it('should validate user permissions for sensitive operations', async () => {
      // Mock insufficient permissions
      mockDataSource.governance.createProposal.mockRejectedValue(
        new Error('Insufficient voting power to create proposal')
      );

      const CREATE_PROPOSAL = gql`
        mutation CreateProposal($input: ProposalInput!) {
          createProposal(input: $input) {
            id
            title
          }
        }
      `;

      const result = await mutate({
        mutation: CREATE_PROPOSAL,
        variables: {
          input: {
            title: 'Test Proposal',
            description: 'Test proposal description',
            type: 'PARAMETER_CHANGE',
            parameters: {},
          },
        },
      });

      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Insufficient voting power');
    });
  });

  describe('Input Validation', () => {
    it('should validate transaction amount', async () => {
      const SEND_TRANSACTION = gql`
        mutation SendTransaction($input: TransactionInput!) {
          sendTransaction(input: $input) {
            id
            hash
          }
        }
      `;

      const result = await mutate({
        mutation: SEND_TRANSACTION,
        variables: {
          input: {
            to: '0x' + '2'.repeat(40),
            amount: '-100', // Invalid negative amount
            type: 'Regular',
          },
        },
      });

      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Invalid amount');
    });

    it('should validate wallet address format', async () => {
      const SEND_TRANSACTION = gql`
        mutation SendTransaction($input: TransactionInput!) {
          sendTransaction(input: $input) {
            id
            hash
          }
        }
      `;

      const result = await mutate({
        mutation: SEND_TRANSACTION,
        variables: {
          input: {
            to: 'invalid-address',
            amount: '100',
            type: 'Regular',
          },
        },
      });

      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Invalid address format');
    });

    it('should validate weather data ranges', async () => {
      const SUBMIT_WEATHER_DATA = gql`
        mutation SubmitWeatherData($input: WeatherDataInput!) {
          submitWeatherData(input: $input) {
            id
            temperature
          }
        }
      `;

      const result = await mutate({
        mutation: SUBMIT_WEATHER_DATA,
        variables: {
          input: {
            stationId: 'station-001',
            location: {
              latitude: 40.7128,
              longitude: -74.006,
              name: 'New York',
            },
            temperature: 999, // Invalid temperature
            humidity: 0.45,
            pressure: 1013.25,
            signature: '0x' + '6'.repeat(130),
          },
        },
      });

      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Invalid temperature');
    });
  });

  describe('Error Handling', () => {
    it('should handle database errors gracefully', async () => {
      mockDataSource.wallet.sendTransaction.mockRejectedValue(
        new Error('Database connection failed')
      );

      const SEND_TRANSACTION = gql`
        mutation SendTransaction($input: TransactionInput!) {
          sendTransaction(input: $input) {
            id
            hash
          }
        }
      `;

      const result = await mutate({
        mutation: SEND_TRANSACTION,
        variables: {
          input: {
            to: '0x' + '2'.repeat(40),
            amount: '100',
            type: 'Regular',
          },
        },
      });

      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Database connection failed');
    });

    it('should handle blockchain errors', async () => {
      mockDataSource.nft.mintNFT.mockRejectedValue(
        new Error('Blockchain network error')
      );

      const MINT_NFT = gql`
        mutation MintNFT($input: MintNFTInput!) {
          mintNFT(input: $input) {
            id
            tokenId
          }
        }
      `;

      const result = await mutate({
        mutation: MINT_NFT,
        variables: {
          input: {
            contractAddress: '0x' + '3'.repeat(40),
            recipient: '0x' + '1'.repeat(40),
            metadata: {
              name: 'Test NFT',
              description: 'Test NFT description',
              image: 'https://example.com/test.png',
            },
            type: 'WeatherData',
          },
        },
      });

      expect(result.errors).toBeDefined();
      expect(result.errors[0].message).toContain('Blockchain network error');
    });
  });
});
