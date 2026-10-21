/**
 * Wrfcoin Mainnet Configuration
 *
 * This file contains mainnet-specific configuration parameters.
 * These are the default settings used when the application is running
 * in mainnet mode.
 */

const mainnetConfig = {
  // Network settings
  network: {
    name: 'mainnet',
    networkId: 1,
    chainId: '0x1',
    genesisHash:
      '0x1a7b1fa9e5e34dad972fadf921a5d6df4a89342c0f635ee6c1e4ced38ddb3339',
    blockTime: 15, // seconds
    blockReward: 50, // WRF
    maxBlockSize: 5 * 1024 * 1024, // 5MB
    confirmationBlocks: 12,
  },

  // Mining parameters
  mining: {
    initialDifficulty: 8,
    difficultyAdjustmentInterval: 2016, // blocks
    targetBlockTime: 15, // seconds
    minReward: 0.01,
    defaultPoolFee: 1.0, // 1%
    computationalBonus: 15, // % additional for computational blocks
  },

  // Transaction parameters
  transactions: {
    minFee: 0.0001,
    maxFee: 1.0,
    maxTransactionsPerBlock: 3000,
    maxInputsPerTransaction: 100,
    maxOutputsPerTransaction: 100,
    defaultGasLimit: 5000000,
    defaultGasPrice: 25, // Gwei
  },

  // Networking
  p2p: {
    bootstrapNodes: [
      'seed1.wrfcoin.network:8333',
      'seed2.wrfcoin.network:8333',
      'seed3.wrfcoin.network:8333',
      'seed4.wrfcoin.network:8333',
      'seed5.wrfcoin.network:8333',
    ],
    maxPeers: 125,
    minPeers: 8,
    connectionTimeout: 5000, // ms
    pingInterval: 30000, // ms
    syncInterval: 15000, // ms
    banScore: 100,
    banTime: 24 * 60 * 60 * 1000, // 24 hours
  },

  // Consensus parameters
  consensus: {
    mechanism: 'ProofOfWork', // can be ProofOfWork, ProofOfUsefulAnalysis
    minValidators: 7,
    maxValidators: 300,
    validatorStake: 10000, // minimum WRF required to be a validator
    slashingPenalty: 1000, // WRF
    inactivityPenalty: 100, // WRF per day
  },

  // Computational NFT parameters
  computationalNFTs: {
    minComputeDuration: 5, // seconds
    maxComputeDuration: 86400, // 24 hours
    maxInputSize: 100 * 1024 * 1024, // 100MB
    maxOutputSize: 500 * 1024 * 1024, // 500MB
    verifiersRequired: 5,
    executionTimeout: 86400, // seconds (24 hours)
    resourceLimits: {
      cpu: 16, // cores
      memory: 64 * 1024, // MB
      storage: 500 * 1024, // MB
    },
  },

  // Governance parameters
  governance: {
    proposalDeposit: 1000, // WRF
    votingPeriod: 14 * 24 * 60 * 60, // 14 days in seconds
    quorum: 0.4, // 40% of total stake
    threshold: 0.6, // 60% of voting stake
    vetoThreshold: 0.33, // 33% of voting stake
  },

  // Wallet parameters
  wallet: {
    addressPrefix: 'wrf', // mainnet prefix
    mnemonicStrength: 256,
    defaultDerivationPath: "m/44'/9000'/0'/0/0", // mainnet path
    defaultAccountName: 'Wrfcoin Account',
  },

  // API endpoints
  api: {
    rateLimit: 30, // requests per minute
    maxPageSize: 100,
    cacheTime: 120, // seconds
  },

  // WebSocket parameters
  websocket: {
    heartbeatInterval: 30000, // ms
    reconnectInterval: 3000, // ms
    maxReconnectAttempts: 5,
  },

  // Database parameters
  database: {
    maxConnections: 50,
    statementTimeout: 30000, // ms
    idleTimeout: 10000, // ms
    maxQueryDuration: 5000, // ms
  },

  // Privacy parameters
  privacy: {
    defaultLevel: 'STANDARD', // STANDARD, BASIC, MEDIUM, HIGH, MAXIMUM
    enableStealth: true,
    enableRingSignatures: true,
    enableMixing: true,
    defaultRingSize: 11,
  },

  // Logging settings
  logging: {
    level: 'info', // emergency, alert, critical, error, warning, notice, info, debug
    file: {
      enabled: true,
      path: './logs',
      maxSize: 50 * 1024 * 1024, // 50MB
      maxFiles: 10,
      level: 'info',
    },
    console: {
      enabled: true,
      level: 'warning',
      colorize: true,
    },
    network: {
      enabled: true,
      endpoint: 'https://logging.wrfcoin.network/mainnet',
      apiKey: process.env.LOGGING_API_KEY || '',
      level: 'error',
    },
  },
};

module.exports = mainnetConfig;
