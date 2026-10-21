/**
 * Application Constants
 *
 * TypeScript implementation providing centralized constants
 * for use throughout the application with type safety.
 */

import { WRF_DECIMALS } from '../../shared/currency.js';

// Storage provider options
export const StorageProvider = {
  LOCAL: 'local',
  S3: 's3',
  IPFS: 'ipfs',
  ARWEAVE: 'arweave',
  FILECOIN: 'filecoin',
  STORJ: 'storj',
} as const;

export type StorageProviderType =
  (typeof StorageProvider)[keyof typeof StorageProvider];

// Data structure types
export const DataStructures = {
  BLOCKCHAIN: 'blockchain',
  MERKLE_TREE: 'merkle_tree',
  PATRICIA_TRIE: 'patricia_trie',
  DAG: 'directed_acyclic_graph',
  COMPUTABLE_NFT: 'computable_nft',
} as const;

export type DataStructureType =
  (typeof DataStructures)[keyof typeof DataStructures];

// Hash algorithms
export const HashAlgorithms = {
  WRF_KECCAK: 'wrf_keccak',
  WRF_RANDOMX: 'wrf_randomx',
  SHA256: 'sha256',
  SHA3: 'sha3',
  BLAKE2: 'blake2',
} as const;

export type HashAlgorithmType =
  (typeof HashAlgorithms)[keyof typeof HashAlgorithms];

// Network configuration
export const NetworkConfig = {
  MAINNET: {
    chainId: 1,
    name: 'Wrfcoin Mainnet',
    rpcUrl: 'https://mainnet.wrfcoin.io',
    explorerUrl: 'https://explorer.wrfcoin.io',
  },
  TESTNET: {
    chainId: 42,
    name: 'Wrfcoin Testnet',
    rpcUrl: 'https://testnet.wrfcoin.io',
    explorerUrl: 'https://testnet-explorer.wrfcoin.io',
  },
  DEVNET: {
    chainId: 1337,
    name: 'Wrfcoin Devnet',
    rpcUrl: process.env.DEVNET_RPC_URL || 'http://localhost:8556',
    explorerUrl: process.env.DEVNET_EXPLORER_URL || 'http://localhost:3000',
  },
} as const;

// Token constants
export const TokenConstants = {
  WRF_DECIMALS,
  MIN_TRANSFER_AMOUNT: 0.001,
  MAX_SUPPLY: 21000000,
  REWARD_PER_BLOCK: 6.25,
  HALVING_INTERVAL: 210000,
} as const;

// Weather data constants
export const WeatherConstants = {
  MIN_TEMPERATURE: -100,
  MAX_TEMPERATURE: 100,
  MIN_HUMIDITY: 0,
  MAX_HUMIDITY: 100,
  MIN_PRESSURE: 800,
  MAX_PRESSURE: 1200,
  QUALITY_THRESHOLD: 80,
  REWARD_BASE: 0.125,
} as const;

// Computational NFT constants
export const ComputationalNFTConstants = {
  RESOURCE_TIERS: {
    BASIC: {
      maxMemoryPages: 50,
      maxExecutionTime: 10000,
      maxStorageSize: 5 * 1024 * 1024,
    },
    STANDARD: {
      maxMemoryPages: 100,
      maxExecutionTime: 30000,
      maxStorageSize: 20 * 1024 * 1024,
    },
    PREMIUM: {
      maxMemoryPages: 200,
      maxExecutionTime: 60000,
      maxStorageSize: 50 * 1024 * 1024,
    },
    ENTERPRISE: {
      maxMemoryPages: 400,
      maxExecutionTime: 300000,
      maxStorageSize: 200 * 1024 * 1024,
    },
  },
  COMPUTATION_TYPES: {
    WEATHER: 'weather',
    CLIMATE: 'climate',
    AIR_QUALITY: 'air_quality',
    CUSTOM: 'custom',
  },
} as const;

// API configuration
export const APIConstants = {
  DEFAULT_PAGE_SIZE: 20,
  MAX_PAGE_SIZE: 100,
  DEFAULT_TIMEOUT: 30000,
  RATE_LIMIT: {
    REQUESTS_PER_HOUR: 1000,
    REQUESTS_PER_MINUTE: 60,
  },
} as const;

// Cross-chain bridge constants
export const BridgeConstants = {
  SUPPORTED_CHAINS: {
    ETHEREUM: { chainId: 1, name: 'Ethereum', fees: 0.1 },
    POLYGON: { chainId: 137, name: 'Polygon', fees: 0.05 },
    BSC: { chainId: 56, name: 'Binance Smart Chain', fees: 0.08 },
    AVALANCHE: { chainId: 43114, name: 'Avalanche', fees: 0.06 },
  },
  MIN_BRIDGE_AMOUNT: 1,
  MAX_BRIDGE_AMOUNT: 1000000,
  CONFIRMATION_BLOCKS: {
    ETHEREUM: 12,
    POLYGON: 128,
    BSC: 15,
    AVALANCHE: 1,
  },
} as const;

// Error codes
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  AUTHENTICATION_ERROR: 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR: 'AUTHORIZATION_ERROR',
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  NETWORK_ERROR: 'NETWORK_ERROR',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

// Status codes
export const StatusCodes = {
  SUCCESS: 200,
  CREATED: 201,
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
} as const;

// Export all constants as default
export default {
  StorageProvider,
  DataStructures,
  HashAlgorithms,
  NetworkConfig,
  TokenConstants,
  WeatherConstants,
  ComputationalNFTConstants,
  APIConstants,
  BridgeConstants,
  ErrorCodes,
  StatusCodes,
};
