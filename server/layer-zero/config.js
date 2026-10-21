/**
 * LayerZero Integration Configuration
 *
 * This file contains configuration settings for the LayerZero integration.
 */

// Chain configuration data
const chains = [
  {
    id: 1,
    name: 'Ethereum',
    symbol: 'ETH',
    type: 'ETHEREUM',
    endpoint: 'https://ethereum.layerzero-mainnet.com',
    gasLimit: 150000,
    gasPrice: '50', // in gwei
    confirmations: 12,
  },
  {
    id: 2,
    name: 'Binance Smart Chain',
    symbol: 'BNB',
    type: 'ETHEREUM',
    endpoint: 'https://bsc.layerzero-mainnet.com',
    gasLimit: 150000,
    gasPrice: '5', // in gwei
    confirmations: 15,
  },
  {
    id: 3,
    name: 'Avalanche',
    symbol: 'AVAX',
    type: 'ETHEREUM',
    endpoint: 'https://avalanche.layerzero-mainnet.com',
    gasLimit: 150000,
    gasPrice: '30', // in gwei
    confirmations: 12,
  },
  {
    id: 4,
    name: 'Polygon',
    symbol: 'MATIC',
    type: 'ETHEREUM',
    endpoint: 'https://polygon.layerzero-mainnet.com',
    gasLimit: 150000,
    gasPrice: '50', // in gwei
    confirmations: 256,
  },
  {
    id: 5,
    name: 'Arbitrum',
    symbol: 'ETH',
    type: 'ETHEREUM',
    endpoint: 'https://arbitrum.layerzero-mainnet.com',
    gasLimit: 150000,
    gasPrice: '0.1', // in gwei
    confirmations: 12,
  },
  {
    id: 6,
    name: 'Optimism',
    symbol: 'ETH',
    type: 'ETHEREUM',
    endpoint: 'https://optimism.layerzero-mainnet.com',
    gasLimit: 150000,
    gasPrice: '0.001', // in gwei
    confirmations: 12,
  },
  {
    id: 1399811149,
    name: 'Solana',
    symbol: 'SOL',
    type: 'SOLANA',
    endpoint: 'https://solana.layerzero-mainnet.com',
    computeUnits: 200000,
    priorityFee: 1, // in micro-lamports
    confirmations: 32,
  },
  {
    id: 9999,
    name: 'Wrfcoin Testnet',
    symbol: 'tWRF',
    type: 'WRFCOIN',
    endpoint: 'https://testnet.wrfcoin.layerzero.com',
    gasLimit: 100000,
    gasPrice: '1', // in WRF units
    confirmations: 6,
  },
  {
    id: 9000,
    name: 'Wrfcoin Mainnet',
    symbol: 'WRF',
    type: 'WRFCOIN',
    endpoint: 'https://wrfcoin.layerzero-mainnet.com',
    gasLimit: 100000,
    gasPrice: '1', // in WRF units
    confirmations: 12,
  },
];

// Protocol configuration
const protocolConfig = {
  version: '1.0.0',
  supportedTokenStandards: {
    EVM: ['ERC20', 'ERC721', 'ERC1155'],
    SOLANA: ['SPL', 'Metaplex'],
    WRFCOIN: ['WRF20', 'WRFNFT'],
  },
  maxMessageSize: 2048, // bytes
  maxTransferAmount: '1000000', // in USD value
  securityLevel: 'high',
  defaultTimeouts: {
    message: 3600, // 1 hour in seconds
    transfer: 7200, // 2 hours in seconds
  },
};

// Helper functions to access configuration

/**
 * Get all supported chains
 * @returns {Object[]} Array of chain configurations
 */
function getAllChains() {
  return chains;
}

/**
 * Get a specific chain configuration by ID
 * @param {number} chainId - Chain ID
 * @returns {Object|undefined} Chain configuration or undefined if not found
 */
function getChainConfig(chainId) {
  return chains.find(chain => chain.id === chainId);
}

/**
 * Get chains by type (e.g., "ETHEREUM", "SOLANA", "WRFCOIN")
 * @param {string} type - Chain type
 * @returns {Object[]} Array of chain configurations of the specified type
 */
function getChainsByType(type) {
  return chains.filter(chain => chain.type === type);
}

/**
 * Get protocol configuration
 * @returns {Object} Protocol configuration
 */
function getProtocolConfig() {
  return protocolConfig;
}

// Export configuration and helper functions
module.exports = {
  // Endpoints for main LayerZero networks
  endpoints: {
    ethereum: 'https://ethereum.layerzero-mainnet.com',
    binance: 'https://bsc.layerzero-mainnet.com',
    avalanche: 'https://avalanche.layerzero-mainnet.com',
    polygon: 'https://polygon.layerzero-mainnet.com',
    arbitrum: 'https://arbitrum.layerzero-mainnet.com',
    optimism: 'https://optimism.layerzero-mainnet.com',
    solana: 'https://solana.layerzero-mainnet.com',
    wrfcoin: 'https://wrfcoin.layerzero-mainnet.com',
  },

  // Chain IDs for LayerZero
  chainIds: {
    ethereum: 1,
    binance: 2,
    avalanche: 3,
    polygon: 4,
    arbitrum: 5,
    optimism: 6,
    solana: 1399811149,
    wrfcoin: 9999,
  },

  // Default gas configs
  defaultGasConfig: {
    ethereum: {
      gasLimit: 150000,
      gasPrice: '50', // in gwei
    },
    binance: {
      gasLimit: 150000,
      gasPrice: '5', // in gwei
    },
    avalanche: {
      gasLimit: 150000,
      gasPrice: '30', // in gwei
    },
    solana: {
      computeUnits: 200000,
      priorityFee: 1, // in micro-lamports
    },
    wrfcoin: {
      gasLimit: 100000,
      gasPrice: '1', // in gwei
    },
  },

  // Relayer configuration
  relayers: {
    defaultTimeout: 60000, // 60 seconds
    retryAttempts: 3,
    retryDelay: 5000, // 5 seconds
  },

  // Connection settings
  connection: {
    timeout: 30000, // 30 seconds
    retryAttempts: 3,
    retryDelay: 2000, // 2 seconds
  },

  // Helper functions
  getAllChains,
  getChainConfig,
  getChainsByType,
  getProtocolConfig,
};
