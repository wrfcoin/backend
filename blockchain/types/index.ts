/**
 * Type definitions for WRFCoin Smart Contract Integration
 * Task 76: Replace Mock Smart Contract API with Real Blockchain Integration
 */

import type { TransactionReceipt, Log } from 'ethers';

/**
 * Supported blockchain network identifiers
 */
export type NetworkId =
  | 'ethereum'
  | 'polygon'
  | 'bsc'
  | 'avalanche'
  | 'arbitrum'
  | 'optimism'
  | 'base'
  | 'sepolia'
  | 'goerli'
  | 'mumbai'
  | 'hardhat'
  | 'localhost';

/**
 * Network configuration for each supported chain
 */
export interface NetworkConfig {
  /** Human-readable network name */
  name: string;
  /** EVM chain ID */
  chainId: number;
  /** Network identifier for internal use */
  networkId: NetworkId;
  /** Primary RPC endpoint URL */
  rpcUrl: string;
  /** Fallback RPC endpoints for failover */
  fallbackRpcUrls: string[];
  /** Native currency information */
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  /** Block explorer URL */
  explorerUrl?: string;
  /** Whether the network supports EIP-1559 */
  eip1559: boolean;
  /** Number of confirmations to wait for transactions */
  confirmations: number;
  /** Whether this is a testnet */
  isTestnet: boolean;
  /** Gas price multiplier for this network (1.0 = no adjustment) */
  gasPriceMultiplier: number;
}

/**
 * Deployed contract information stored in registry
 */
export interface DeployedContract {
  /** Contract address */
  address: string;
  /** Network where contract is deployed */
  networkId: NetworkId;
  /** Contract ABI (JSON string or array) */
  abi: string | object[];
  /** Deployment transaction hash */
  transactionHash: string;
  /** Block number at deployment */
  blockNumber: number;
  /** Deployer address */
  deployer: string;
  /** Deployment timestamp */
  deployedAt: string;
  /** Gas used for deployment */
  gasUsed: string;
  /** Contract bytecode (optional, for verification) */
  bytecode?: string;
  /** Constructor arguments (optional, for verification) */
  constructorArgs?: unknown[];
  /** Contract name/identifier */
  name?: string;
}

/**
 * Contract deployment request parameters
 */
export interface DeployContractParams {
  /** Contract bytecode (hex string) */
  bytecode: string;
  /** Contract ABI for interaction */
  abi: object[];
  /** Constructor arguments */
  constructorArgs?: unknown[];
  /** Target network */
  networkId?: NetworkId;
  /** Gas limit override */
  gasLimit?: number;
  /** Contract name for registry */
  name?: string;
  /** Value to send with deployment (in wei) */
  value?: string;
}

/**
 * Contract deployment result
 */
export interface DeployContractResult {
  success: boolean;
  contractAddress: string;
  transactionHash: string;
  gasUsed: string;
  blockNumber: number;
  networkId: NetworkId;
}

/**
 * Contract call request parameters
 */
export interface CallContractParams {
  /** Contract address */
  contractAddress: string;
  /** Function name to call */
  functionName: string;
  /** Function arguments */
  args?: unknown[];
  /** Contract ABI (optional if registered) */
  abi?: object[];
  /** Target network */
  networkId?: NetworkId;
  /** Gas limit override */
  gasLimit?: number;
  /** Value to send (for payable functions) */
  value?: string;
  /** Whether this is a read-only call (no state change) */
  isReadOnly?: boolean;
}

/**
 * Contract call result
 */
export interface CallContractResult {
  success: boolean;
  result: unknown;
  gasUsed?: string;
  transactionHash?: string;
  events?: ContractEvent[];
  blockNumber?: number;
}

/**
 * Contract event from transaction logs
 */
export interface ContractEvent {
  /** Event name */
  event: string;
  /** Contract address that emitted the event */
  address: string;
  /** Event arguments */
  args: Record<string, unknown>;
  /** Log topics */
  topics: string[];
  /** Raw log data */
  data: string;
  /** Block number */
  blockNumber: number;
  /** Transaction hash */
  transactionHash: string;
  /** Log index in transaction */
  logIndex: number;
}

/**
 * Event query parameters
 */
export interface GetEventsParams {
  /** Contract address */
  contractAddress: string;
  /** Target network */
  networkId?: NetworkId;
  /** Event name filter */
  eventName?: string;
  /** Starting block number */
  fromBlock?: number | 'latest' | 'earliest';
  /** Ending block number */
  toBlock?: number | 'latest' | 'earliest';
  /** Contract ABI (optional if registered) */
  abi?: object[];
}

/**
 * Gas estimation request parameters
 */
export interface EstimateGasParams {
  /** Contract bytecode for deployment estimation */
  bytecode?: string;
  /** Contract address for call estimation */
  contractAddress?: string;
  /** Function name for call estimation */
  functionName?: string;
  /** Function arguments */
  args?: unknown[];
  /** Contract ABI */
  abi?: object[];
  /** Target network */
  networkId?: NetworkId;
  /** Value to send */
  value?: string;
}

/**
 * Gas estimation result
 */
export interface GasEstimateResult {
  gasEstimate: string;
  gasPrice: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  estimatedCost: string;
  estimatedCostUsd?: number;
  networkId: NetworkId;
  isEip1559: boolean;
}

/**
 * Contract verification parameters
 */
export interface VerifyContractParams {
  /** Contract address */
  contractAddress: string;
  /** Source code */
  sourceCode?: string;
  /** Compiler version */
  compilerVersion?: string;
  /** Constructor arguments */
  constructorArgs?: unknown[];
  /** Target network */
  networkId?: NetworkId;
}

/**
 * Contract verification result
 */
export interface VerifyContractResult {
  verified: boolean;
  sourceCode?: string;
  compilerVersion?: string;
  verifiedAt?: string;
  matchesDeployedBytecode: boolean;
}

/**
 * HSM signing credentials
 */
export interface HSMCredentials {
  /** User ID for session identification */
  userId: string;
  /** HSM PIN for authentication */
  pin: string;
}

/**
 * HSM session information
 */
export interface HSMSession {
  /** Session ID */
  sessionId: string;
  /** When the session was created */
  createdAt: Date;
  /** When the session expires */
  expiresAt: Date;
  /** Whether the session is currently valid */
  isValid: boolean;
}

/**
 * HSM key information
 */
export interface HSMKeyInfo {
  /** Key handle for referencing the key */
  keyHandle: string;
  /** Key type (signing, encryption, etc.) */
  keyType: string;
  /** Algorithm used */
  algorithm: string;
  /** Public key in PEM format */
  publicKey: string;
  /** Whether the key is stored in hardware HSM */
  hsmStored: boolean;
  /** When the key was created */
  createdAt: string;
}

/**
 * Provider health status
 */
export interface ProviderHealth {
  networkId: NetworkId;
  isHealthy: boolean;
  latency: number;
  lastChecked: Date;
  blockNumber?: number;
  error?: string;
}

/**
 * Service status information
 */
export interface ServiceStatus {
  initialized: boolean;
  hsmConnected: boolean;
  hsmMode: 'hardware' | 'mock';
  activeNetworks: NetworkId[];
  contractCount: number;
  signerAddress?: string;
}

/**
 * API response wrapper
 */
export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  timestamp: string;
}

/**
 * Transaction options for contract interactions
 */
export interface TransactionOptions {
  gasLimit?: number;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  value?: string;
  nonce?: number;
}

/**
 * Signature result from HSM
 */
export interface HSMSignatureResult {
  /** Raw signature in hex format */
  signature: string;
  /** Hash of the signed data */
  dataHash: string;
  /** Timestamp of signing */
  timestamp: string;
  /** Whether signed by actual HSM hardware */
  hsmSigned: boolean;
}

/**
 * Ethereum signature components
 */
export interface EthereumSignature {
  r: string;
  s: string;
  v: number;
  serialized: string;
}
