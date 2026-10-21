/**
 * Mock DataSource for GraphQL API Testing
 */

import { jest, expect } from '@jest/globals';

export const createMockDataSource = () => {
  const mockDataSource = {
    blockchain: {
      getLatestBlocks: jest.fn(),
      getBlockByHeight: jest.fn(),
      getBlockByHash: jest.fn(),
      getNetworkStats: jest.fn(),
      getTransaction: jest.fn(),
      getTransactionHistory: jest.fn(),
      validateTransaction: jest.fn(),
      broadcastTransaction: jest.fn(),
      getNodeInfo: jest.fn(),
      getPeers: jest.fn(),
      getMempool: jest.fn(),
    },

    wallet: {
      createWallet: jest.fn(),
      importWallet: jest.fn(),
      getBalance: jest.fn(),
      getTokenBalances: jest.fn(),
      sendTransaction: jest.fn(),
      getTransactionHistory: jest.fn(),
      signMessage: jest.fn(),
      verifyMessage: jest.fn(),
      encryptWallet: jest.fn(),
      decryptWallet: jest.fn(),
      exportWallet: jest.fn(),
      getWalletInfo: jest.fn(),
    },

    nft: {
      mintNFT: jest.fn(),
      transferNFT: jest.fn(),
      getNFTDetails: jest.fn(),
      getNFTsByOwner: jest.fn(),
      getNFTsByContract: jest.fn(),
      getNFTMetadata: jest.fn(),
      updateNFTMetadata: jest.fn(),
      approveNFT: jest.fn(),
      setApprovalForAll: jest.fn(),
      burnNFT: jest.fn(),
      getNFTMarketplace: jest.fn(),
      listNFTForSale: jest.fn(),
      purchaseNFT: jest.fn(),
    },

    weather: {
      submitWeatherData: jest.fn(),
      getWeatherData: jest.fn(),
      getWeatherDataByLocation: jest.fn(),
      getWeatherDataByStation: jest.fn(),
      getWeatherStations: jest.fn(),
      registerWeatherStation: jest.fn(),
      updateWeatherStation: jest.fn(),
      deactivateWeatherStation: jest.fn(),
      validateWeatherData: jest.fn(),
      getWeatherDataQuality: jest.fn(),
      getWeatherDataHistory: jest.fn(),
      getWeatherStationMetrics: jest.fn(),
    },

    governance: {
      createProposal: jest.fn(),
      getProposals: jest.fn(),
      getProposal: jest.fn(),
      vote: jest.fn(),
      getVotes: jest.fn(),
      getVotingPower: jest.fn(),
      delegateVotingPower: jest.fn(),
      getDelegations: jest.fn(),
      executeProposal: jest.fn(),
      cancelProposal: jest.fn(),
      getGovernanceConfig: jest.fn(),
      updateGovernanceConfig: jest.fn(),
    },

    bridge: {
      initiateBridgeTransfer: jest.fn(),
      getBridgeTransactions: jest.fn(),
      getBridgeTransaction: jest.fn(),
      estimateBridgeFees: jest.fn(),
      getSupportedNetworks: jest.fn(),
      getSupportedTokens: jest.fn(),
      getNetworkStatus: jest.fn(),
      cancelBridgeTransfer: jest.fn(),
      retryBridgeTransfer: jest.fn(),
      getBridgeStatistics: jest.fn(),
      validateBridgeTransfer: jest.fn(),
    },

    // Reset all mocks
    resetMocks: () => {
      Object.values(mockDataSource).forEach(service => {
        if (typeof service === 'object' && service !== null) {
          Object.values(service).forEach(method => {
            if (typeof method === 'function' && method.mockReset) {
              method.mockReset();
            }
          });
        }
      });
    },
  };

  return mockDataSource;
};

// Mock data generators
export const mockGenerators = {
  block: (overrides = {}) => ({
    id: '1',
    hash: '0x' + '1'.repeat(64),
    height: 12345,
    timestamp: new Date().toISOString(),
    transactions: [],
    previousHash: '0x' + '0'.repeat(64),
    merkleRoot: '0x' + '2'.repeat(64),
    nonce: 0,
    difficulty: 1000,
    gasUsed: '0',
    gasLimit: '8000000',
    size: 1024,
    ...overrides,
  }),

  transaction: (overrides = {}) => ({
    id: 'tx1',
    hash: '0x' + '1'.repeat(64),
    from: '0x' + '1'.repeat(40),
    to: '0x' + '2'.repeat(40),
    amount: '100',
    type: 'Regular',
    status: 'confirmed',
    timestamp: new Date().toISOString(),
    blockHeight: 12345,
    blockHash: '0x' + '1'.repeat(64),
    gasUsed: '21000',
    gasPrice: '10',
    nonce: 0,
    data: '0x',
    ...overrides,
  }),

  wallet: (overrides = {}) => ({
    address: '0x' + '1'.repeat(40),
    publicKey: '0x' + '2'.repeat(66),
    balance: '1000.0',
    tokens: [
      { symbol: 'WRF', balance: '1000.0' },
      { symbol: 'USDC', balance: '500.0' },
    ],
    transactionCount: 10,
    createdAt: new Date().toISOString(),
    encrypted: false,
    ...overrides,
  }),

  nft: (overrides = {}) => ({
    id: 'nft1',
    tokenId: '1',
    contractAddress: '0x' + '3'.repeat(40),
    owner: '0x' + '1'.repeat(40),
    metadata: {
      name: 'Test NFT',
      description: 'Test NFT description',
      image: 'https://example.com/nft.png',
      attributes: [
        { trait_type: 'Type', value: 'Test' },
        { trait_type: 'Rarity', value: 'Common' },
      ],
    },
    mintedAt: new Date().toISOString(),
    type: 'WeatherData',
    transferHistory: [],
    ...overrides,
  }),

  weatherData: (overrides = {}) => ({
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
    signature: '0x' + '1'.repeat(130),
    verified: true,
    ...overrides,
  }),

  weatherStation: (overrides = {}) => ({
    id: 'station-001',
    name: 'NYC Weather Station',
    location: {
      latitude: 40.7128,
      longitude: -74.006,
      name: 'New York',
    },
    owner: '0x' + '1'.repeat(40),
    status: 'ACTIVE',
    registeredAt: new Date().toISOString(),
    lastDataTimestamp: new Date().toISOString(),
    configuration: {
      dataInterval: 300,
      precision: 'HIGH',
      sensors: ['temperature', 'humidity', 'pressure', 'wind'],
    },
    ...overrides,
  }),

  proposal: (overrides = {}) => ({
    id: 'proposal1',
    title: 'Test Proposal',
    description: 'Test proposal description',
    proposer: '0x' + '1'.repeat(40),
    status: 'ACTIVE',
    type: 'PARAMETER_CHANGE',
    startTime: new Date().toISOString(),
    endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    executionTime: null,
    votingPower: {
      for: '1000000',
      against: '500000',
      abstain: '100000',
    },
    parameters: {},
    requiredVotingPower: '1000000',
    ...overrides,
  }),

  vote: (overrides = {}) => ({
    id: 'vote1',
    proposalId: 'proposal1',
    voter: '0x' + '1'.repeat(40),
    choice: 'FOR',
    votingPower: '500000',
    timestamp: new Date().toISOString(),
    txHash: '0x' + '1'.repeat(64),
    reason: 'I support this proposal',
    ...overrides,
  }),

  bridgeTransfer: (overrides = {}) => ({
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
    estimatedCompletionTime: new Date(
      Date.now() + 10 * 60 * 1000
    ).toISOString(),
    fees: {
      source: '0.01',
      target: '0.005',
      bridge: '0.02',
    },
    ...overrides,
  }),

  networkStats: (overrides = {}) => ({
    totalBlocks: 12346,
    totalTransactions: 25000,
    hashRate: 500,
    difficulty: 1000,
    averageBlockTime: 15,
    activeNodes: 25,
    pendingTransactions: 150,
    networkFee: '0.001',
    ...overrides,
  }),

  nodeInfo: (overrides = {}) => ({
    id: 'node1',
    version: '1.0.0',
    network: 'testnet',
    status: 'healthy',
    uptime: 3600,
    peers: 25,
    blockHeight: 12345,
    syncProgress: 100,
    ...overrides,
  }),
};

// Helper functions for test data
export const createMockUser = (address = '0x' + '1'.repeat(40)) => ({
  address,
  isAuthenticated: true,
  permissions: ['read', 'write', 'admin'],
});

export const createMockContext = (user = createMockUser()) => ({
  user,
  isAuthenticated: !!user,
  dataSources: createMockDataSource(),
});

export const createMockError = (message: string, code = 'INTERNAL_ERROR') => ({
  message,
  code,
  timestamp: new Date().toISOString(),
});

// Common test utilities
export const expectGraphQLError = (result: any, expectedMessage: string) => {
  expect(result.errors).toBeDefined();
  expect(result.errors.length).toBeGreaterThan(0);
  expect(result.errors[0].message).toContain(expectedMessage);
};

export const expectGraphQLSuccess = (result: any) => {
  expect(result.errors).toBeUndefined();
  expect(result.data).toBeDefined();
};

export const mockAsyncOperation = (returnValue: any, delay = 0) => {
  return jest
    .fn()
    .mockImplementation(
      () =>
        new Promise(resolve => setTimeout(() => resolve(returnValue), delay))
    );
};

export const mockAsyncError = (error: Error, delay = 0) => {
  return jest
    .fn()
    .mockImplementation(
      () => new Promise((_, reject) => setTimeout(() => reject(error), delay))
    );
};
