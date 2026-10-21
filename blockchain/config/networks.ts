/**
 * Network Configuration for WRFCoin Multi-Chain Support
 * Task 76: Replace Mock Smart Contract API with Real Blockchain Integration
 *
 * Supports 13+ EVM-compatible blockchain networks with automatic
 * RPC failover and network-specific gas handling.
 */

import type { NetworkConfig, NetworkId } from '../types/index.js';

/**
 * Default network configurations
 * RPC URLs can be overridden via environment variables
 */
export const NETWORK_CONFIGS: Record<NetworkId, NetworkConfig> = {
  // ===== MAINNETS =====

  ethereum: {
    name: 'Ethereum Mainnet',
    chainId: 1,
    networkId: 'ethereum',
    rpcUrl: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
    fallbackRpcUrls: [
      'https://rpc.ankr.com/eth',
      'https://ethereum.publicnode.com',
      'https://1rpc.io/eth',
    ],
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    explorerUrl: 'https://etherscan.io',
    eip1559: true,
    confirmations: 3,
    isTestnet: false,
    gasPriceMultiplier: 1.1,
  },

  polygon: {
    name: 'Polygon Mainnet',
    chainId: 137,
    networkId: 'polygon',
    rpcUrl: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
    fallbackRpcUrls: [
      'https://rpc.ankr.com/polygon',
      'https://polygon.llamarpc.com',
      'https://polygon-bor-rpc.publicnode.com',
    ],
    nativeCurrency: {
      name: 'MATIC',
      symbol: 'MATIC',
      decimals: 18,
    },
    explorerUrl: 'https://polygonscan.com',
    eip1559: true,
    confirmations: 5,
    isTestnet: false,
    gasPriceMultiplier: 1.2,
  },

  bsc: {
    name: 'BNB Smart Chain',
    chainId: 56,
    networkId: 'bsc',
    rpcUrl: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
    fallbackRpcUrls: [
      'https://bsc-dataseed1.binance.org',
      'https://bsc-dataseed2.binance.org',
      'https://rpc.ankr.com/bsc',
    ],
    nativeCurrency: {
      name: 'BNB',
      symbol: 'BNB',
      decimals: 18,
    },
    explorerUrl: 'https://bscscan.com',
    eip1559: false,
    confirmations: 3,
    isTestnet: false,
    gasPriceMultiplier: 1.1,
  },

  avalanche: {
    name: 'Avalanche C-Chain',
    chainId: 43114,
    networkId: 'avalanche',
    rpcUrl: process.env.AVALANCHE_RPC_URL || 'https://api.avax.network/ext/bc/C/rpc',
    fallbackRpcUrls: [
      'https://rpc.ankr.com/avalanche',
      'https://avalanche.public-rpc.com',
      'https://1rpc.io/avax/c',
    ],
    nativeCurrency: {
      name: 'AVAX',
      symbol: 'AVAX',
      decimals: 18,
    },
    explorerUrl: 'https://snowtrace.io',
    eip1559: true,
    confirmations: 3,
    isTestnet: false,
    gasPriceMultiplier: 1.1,
  },

  arbitrum: {
    name: 'Arbitrum One',
    chainId: 42161,
    networkId: 'arbitrum',
    rpcUrl: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
    fallbackRpcUrls: [
      'https://rpc.ankr.com/arbitrum',
      'https://arbitrum.llamarpc.com',
      'https://1rpc.io/arb',
    ],
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    explorerUrl: 'https://arbiscan.io',
    eip1559: true,
    confirmations: 3,
    isTestnet: false,
    gasPriceMultiplier: 1.0,
  },

  optimism: {
    name: 'Optimism',
    chainId: 10,
    networkId: 'optimism',
    rpcUrl: process.env.OPTIMISM_RPC_URL || 'https://mainnet.optimism.io',
    fallbackRpcUrls: [
      'https://rpc.ankr.com/optimism',
      'https://optimism.llamarpc.com',
      'https://1rpc.io/op',
    ],
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    explorerUrl: 'https://optimistic.etherscan.io',
    eip1559: true,
    confirmations: 3,
    isTestnet: false,
    gasPriceMultiplier: 1.0,
  },

  base: {
    name: 'Base',
    chainId: 8453,
    networkId: 'base',
    rpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    fallbackRpcUrls: [
      'https://rpc.ankr.com/base',
      'https://base.llamarpc.com',
      'https://1rpc.io/base',
    ],
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    explorerUrl: 'https://basescan.org',
    eip1559: true,
    confirmations: 3,
    isTestnet: false,
    gasPriceMultiplier: 1.0,
  },

  // ===== TESTNETS =====

  sepolia: {
    name: 'Sepolia Testnet',
    chainId: 11155111,
    networkId: 'sepolia',
    rpcUrl: process.env.SEPOLIA_RPC_URL || 'https://rpc.sepolia.org',
    fallbackRpcUrls: [
      'https://rpc.ankr.com/eth_sepolia',
      'https://sepolia.gateway.tenderly.co',
      'https://ethereum-sepolia-rpc.publicnode.com',
    ],
    nativeCurrency: {
      name: 'Sepolia Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    explorerUrl: 'https://sepolia.etherscan.io',
    eip1559: true,
    confirmations: 2,
    isTestnet: true,
    gasPriceMultiplier: 1.0,
  },

  goerli: {
    name: 'Goerli Testnet',
    chainId: 5,
    networkId: 'goerli',
    rpcUrl: process.env.GOERLI_RPC_URL || 'https://rpc.ankr.com/eth_goerli',
    fallbackRpcUrls: [
      'https://goerli.gateway.tenderly.co',
      'https://ethereum-goerli-rpc.publicnode.com',
    ],
    nativeCurrency: {
      name: 'Goerli Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    explorerUrl: 'https://goerli.etherscan.io',
    eip1559: true,
    confirmations: 2,
    isTestnet: true,
    gasPriceMultiplier: 1.0,
  },

  mumbai: {
    name: 'Polygon Mumbai Testnet',
    chainId: 80001,
    networkId: 'mumbai',
    rpcUrl: process.env.MUMBAI_RPC_URL || 'https://rpc-mumbai.maticvigil.com',
    fallbackRpcUrls: [
      'https://rpc.ankr.com/polygon_mumbai',
      'https://polygon-mumbai-bor-rpc.publicnode.com',
    ],
    nativeCurrency: {
      name: 'MATIC',
      symbol: 'MATIC',
      decimals: 18,
    },
    explorerUrl: 'https://mumbai.polygonscan.com',
    eip1559: true,
    confirmations: 2,
    isTestnet: true,
    gasPriceMultiplier: 1.0,
  },

  // ===== LOCAL DEVELOPMENT =====

  hardhat: {
    name: 'Hardhat Local',
    chainId: 31337,
    networkId: 'hardhat',
    rpcUrl: process.env.HARDHAT_RPC_URL || 'http://127.0.0.1:8545',
    fallbackRpcUrls: [],
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    explorerUrl: undefined,
    eip1559: true,
    confirmations: 1,
    isTestnet: true,
    gasPriceMultiplier: 1.0,
  },

  localhost: {
    name: 'Localhost',
    chainId: 1337,
    networkId: 'localhost',
    rpcUrl: process.env.LOCALHOST_RPC_URL || 'http://127.0.0.1:8545',
    fallbackRpcUrls: [],
    nativeCurrency: {
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
    },
    explorerUrl: undefined,
    eip1559: true,
    confirmations: 1,
    isTestnet: true,
    gasPriceMultiplier: 1.0,
  },
};

/**
 * Get network configuration by network ID
 */
export function getNetworkConfig(networkId: NetworkId): NetworkConfig {
  const config = NETWORK_CONFIGS[networkId];
  if (!config) {
    throw new Error(`Unknown network: ${networkId}`);
  }
  return config;
}

/**
 * Get network configuration by chain ID
 */
export function getNetworkConfigByChainId(chainId: number): NetworkConfig | null {
  for (const config of Object.values(NETWORK_CONFIGS)) {
    if (config.chainId === chainId) {
      return config;
    }
  }
  return null;
}

/**
 * Get all supported network IDs
 */
export function getSupportedNetworks(): NetworkId[] {
  return Object.keys(NETWORK_CONFIGS) as NetworkId[];
}

/**
 * Get all mainnet network IDs
 */
export function getMainnetNetworks(): NetworkId[] {
  return Object.entries(NETWORK_CONFIGS)
    .filter(([_, config]) => !config.isTestnet)
    .map(([id]) => id as NetworkId);
}

/**
 * Get all testnet network IDs
 */
export function getTestnetNetworks(): NetworkId[] {
  return Object.entries(NETWORK_CONFIGS)
    .filter(([_, config]) => config.isTestnet)
    .map(([id]) => id as NetworkId);
}

/**
 * Validate if a network ID is supported
 */
export function isValidNetworkId(networkId: string): networkId is NetworkId {
  return networkId in NETWORK_CONFIGS;
}

/**
 * Get the default network ID based on environment
 */
export function getDefaultNetworkId(): NetworkId {
  const env = process.env.NODE_ENV;
  const defaultNetwork = process.env.DEFAULT_NETWORK as NetworkId | undefined;

  if (defaultNetwork && isValidNetworkId(defaultNetwork)) {
    return defaultNetwork;
  }

  // Production defaults to ethereum mainnet
  if (env === 'production') {
    return 'ethereum';
  }

  // Development defaults to hardhat local
  return 'hardhat';
}

/**
 * Environment variable for enabling real blockchain mode
 */
function readBooleanEnv(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  switch (value.trim().toLowerCase()) {
    case '0':
    case 'false':
    case 'no':
    case 'off':
      return false;
    case '1':
    case 'true':
    case 'yes':
    case 'on':
      return true;
    default:
      return defaultValue;
  }
}

export const USE_REAL_BLOCKCHAIN = readBooleanEnv(
  process.env.USE_REAL_BLOCKCHAIN,
  true
);

/**
 * Default gas limits for common operations
 */
export const DEFAULT_GAS_LIMITS = {
  deployment: 5_000_000,
  transfer: 21_000,
  erc20Transfer: 65_000,
  contractCall: 100_000,
  complexCall: 300_000,
};
