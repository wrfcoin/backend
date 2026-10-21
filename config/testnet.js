/**
 * Wrfcoin Testnet Configuration
 *
 * This file contains testnet-specific configuration parameters.
 * These settings override the mainnet defaults when the application
 * is running in testnet mode.
 */

const testnetConfig = {
  // Network settings
  network: {
    name: 'testnet',
    networkId: 2,
    chainId: '0x2',
    genesisHash:
      '0x843f35649e8b217c7dd0dfe5d2f33760e7fa1d8461abaaf2324bc6f41706af53',
    blockTime: 15, // seconds
    blockReward: 50, // WRF
    maxBlockSize: 2 * 1024 * 1024, // 2MB
    confirmationBlocks: 6,
  },

  // Mining parameters
  mining: {
    initialDifficulty: 4,
    difficultyAdjustmentInterval: 10, // blocks
    targetBlockTime: 15, // seconds
    maxHashrate: 100000, // for testnet, limit hashrate
    minReward: 0.01,
    defaultPoolFee: 1.0, // 1%
    computationalBonus: 10, // % additional for computational blocks
  },

  // Transaction parameters
  transactions: {
    minFee: 0.0001,
    maxFee: 1.0,
    maxTransactionsPerBlock: 1000,
    maxInputsPerTransaction: 50,
    maxOutputsPerTransaction: 50,
    defaultGasLimit: 3000000,
    defaultGasPrice: 20, // Gwei
  },

  // Networking
  p2p: {
    bootstrapNodes: [
      'testnet-seed1.wrfcoin.network:8333',
      'testnet-seed2.wrfcoin.network:8333',
      'testnet-seed3.wrfcoin.network:8333',
    ],
    maxPeers: 50,
    minPeers: 3,
    connectionTimeout: 10000, // ms
    pingInterval: 60000, // ms
    syncInterval: 30000, // ms
    banScore: 100,
    banTime: 24 * 60 * 60 * 1000, // 24 hours
  },

  // Consensus parameters
  consensus: {
    mechanism: 'ProofOfWork', // can be ProofOfWork, ProofOfUsefulAnalysis
    minValidators: 3,
    maxValidators: 100,
    validatorStake: 1000, // minimum WRF required to be a validator
    slashingPenalty: 100, // WRF
    inactivityPenalty: 10, // WRF per day
  },

  // Computational NFT parameters
  computationalNFTs: {
    minComputeDuration: 10, // seconds
    maxComputeDuration: 3600, // 1 hour
    maxInputSize: 10 * 1024 * 1024, // 10MB
    maxOutputSize: 50 * 1024 * 1024, // 50MB
    verifiersRequired: 2,
    executionTimeout: 3600, // seconds
    resourceLimits: {
      cpu: 4, // cores
      memory: 8 * 1024, // MB
      storage: 50 * 1024, // MB
    },
  },

  // Governance parameters
  governance: {
    proposalDeposit: 100, // WRF
    votingPeriod: 7 * 24 * 60 * 60, // 7 days in seconds
    quorum: 0.4, // 40% of total stake
    threshold: 0.5, // 50% of voting stake
    vetoThreshold: 0.33, // 33% of voting stake
  },

  // Wallet parameters
  wallet: {
    addressPrefix: 'twrf', // testnet prefix
    mnemonicStrength: 128,
    defaultDerivationPath: "m/44'/9000'/0'/0/0", // testnet path
    defaultAccountName: 'Testnet Account',
  },

  // API endpoints
  api: {
    rateLimit: 100, // requests per minute
    maxPageSize: 100,
    cacheTime: 60, // seconds
  },

  // WebSocket parameters
  websocket: {
    heartbeatInterval: 30000, // ms
    reconnectInterval: 3000, // ms
    maxReconnectAttempts: 5,
  },

  // Database parameters
  database: {
    maxConnections: 20,
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
    defaultRingSize: 5,
  },

  // Faucet settings (testnet only)
  faucet: {
    enabled: true,
    amount: 10, // WRF
    cooldownPeriod: 24 * 60 * 60, // 24 hours
    maxTotalDistribution: 10000, // WRF
  },

  // Integration settings for testnet
  integrations: {
    // All integrations should be in testnet mode by default
    testMode: true,

    // Compute Networks
    compute: {
      sonm: {
        endpoint: 'https://testnet-api.sonm.network',
        defaultWorkerCount: 317,
        defaultCpuCores: 300,
        defaultGpuUnits: 7,
        refreshInterval: 60000, // ms
        testModeEnabled: true,
      },
      akash: {
        endpoint: 'https://testnet-api.akash.network',
        testModeEnabled: true,
      },
      bacalhau: {
        endpoint: 'https://testnet-api.bacalhau.org',
        testModeEnabled: true,
      },
      render: {
        endpoint: 'https://testnet-api.render.services',
        testModeEnabled: true,
      },
      golem: {
        endpoint: 'https://testnet-api.golem.network',
        testModeEnabled: true,
      },
    },

    // IoT Networks
    iot: {
      helium: {
        endpoint: 'https://testnet-api.helium.io',
        testModeEnabled: true,
      },
      'aioz-media': {
        endpoint: 'https://testnet-mediamtx.aioz.io',
        testModeEnabled: true,
      },
      ttn: {
        endpoint: 'https://testnet-api.thethingsnetwork.org',
        testModeEnabled: true,
      },
      foam: {
        endpoint: 'https://testnet-api.foam.space',
        testModeEnabled: true,
      },
      ogc: {
        endpoint: 'https://testnet-api.ogc.org',
        testModeEnabled: true,
      },
      streamr: {
        endpoint: 'https://testnet-api.streamr.network',
        testModeEnabled: true,
      },
    },

    // Cross-Chain Networks
    'cross-chain': {
      layerzero: {
        endpoint: 'https://testnet-api.layerzero.network',
        testModeEnabled: true,
      },
      axelar: {
        endpoint: 'https://testnet-api.axelar.network',
        testModeEnabled: true,
      },
      wormhole: {
        endpoint: 'https://testnet-api.wormhole.com',
        testModeEnabled: true,
      },
      parity: {
        endpoint: 'https://testnet-api.polkadot.network',
        testModeEnabled: true,
      },
      near: {
        endpoint: 'https://testnet-api.near.org',
        testModeEnabled: true,
      },
    },

    // Data Providers
    'data-providers': {
      'sensor-community': {
        endpoint: 'https://testnet-api.sensor.community',
        testModeEnabled: true,
      },
      openaq: {
        endpoint: 'https://testnet-api.openaq.org',
        testModeEnabled: true,
      },
    },
  },

  // Logging settings
  logging: {
    level: 'debug', // emergency, alert, critical, error, warning, notice, info, debug
    file: {
      enabled: true,
      path: './logs',
      maxSize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
      level: 'debug',
    },
    console: {
      enabled: true,
      level: 'info',
      colorize: true,
    },
    network: {
      enabled: false,
      endpoint: 'https://logging.wrfcoin.network/testnet',
      apiKey: process.env.LOGGING_API_KEY || '',
      level: 'error',
    },
  },
};

module.exports = testnetConfig;
