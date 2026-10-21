/**
 * Blockchain Types for Wrfcoin Platform
 * Core blockchain operation types and interfaces
 */

import { EthereumAddress, SecureHash, PositiveNumber } from './security-types.js';

// Core Blockchain Types
export interface Block {
  hash: SecureHash;
  number: number;
  timestamp: Date;
  parentHash: SecureHash;
  transactions: Transaction[];
  miner: EthereumAddress;
  difficulty: string;
  gasUsed: number;
  gasLimit: number;
  nonce: string;
}

export interface Transaction {
  hash: SecureHash;
  from: EthereumAddress;
  to: EthereumAddress;
  value: PositiveNumber;
  gas: number;
  gasPrice: PositiveNumber;
  nonce: number;
  blockHash?: SecureHash;
  blockNumber?: number;
  transactionIndex?: number;
  timestamp: Date;
  status: TransactionStatus;
  type: TransactionType;
  data?: string;
}

export type TransactionStatus = 'pending' | 'confirmed' | 'failed' | 'dropped';
export type TransactionType =
  | 'transfer'
  | 'contract_call'
  | 'contract_deploy'
  | 'weather_reward'
  | 'governance_vote'
  | 'cross_chain';

// Wallet and Balance Types
export interface Wallet {
  address: EthereumAddress;
  balance: PositiveNumber;
  nonce: number;
  tokenBalances: TokenBalance[];
  transactionHistory: Transaction[];
  createdAt: Date;
  lastActivity: Date;
}

export interface TokenBalance {
  tokenAddress: EthereumAddress;
  symbol: string;
  name: string;
  balance: PositiveNumber;
  decimals: number;
  value?: PositiveNumber;
}

// Mining Types
export interface MiningOperation {
  blockNumber: number;
  difficulty: string;
  hashrate: string;
  timestamp: Date;
  reward: PositiveNumber;
  minerAddress: EthereumAddress;
  nonce: string;
  mixHash: SecureHash;
}

export interface MiningPool {
  id: string;
  name: string;
  address: EthereumAddress;
  hashrate: string;
  miners: number;
  fee: PositiveNumber;
  payoutScheme: 'PPS' | 'PPLNS' | 'PROP';
  minPayout: PositiveNumber;
  lastBlock: number;
}

// Smart Contract Types
export interface SmartContract {
  address: EthereumAddress;
  abi: ContractABI[];
  bytecode: string;
  deployedAt: Date;
  creator: EthereumAddress;
  version: string;
  verified: boolean;
}

export interface ContractABI {
  type: 'function' | 'constructor' | 'event' | 'fallback';
  name?: string;
  inputs: ABIInput[];
  outputs?: ABIOutput[];
  stateMutability: 'pure' | 'view' | 'nonpayable' | 'payable';
}

export interface ABIInput {
  name: string;
  type: string;
  internalType?: string;
  indexed?: boolean;
}

export interface ABIOutput {
  name: string;
  type: string;
  internalType?: string;
}

// Network and Node Types
export interface NetworkInfo {
  chainId: number;
  networkName: string;
  rpcUrl: string;
  blockExplorerUrl: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  consensusType: 'PoW' | 'PoS' | 'DPoS' | 'PoA';
  blockTime: number;
  finalityBlocks: number;
}

export interface NodeInfo {
  nodeId: string;
  version: string;
  networkId: number;
  isValidator: boolean;
  peerCount: number;
  syncStatus: SyncStatus;
  uptime: number;
  lastBlockNumber: number;
}

export interface SyncStatus {
  syncing: boolean;
  startingBlock: number;
  currentBlock: number;
  highestBlock: number;
  progress: number;
}

// Consensus Types
export interface ValidatorInfo {
  address: EthereumAddress;
  stake: PositiveNumber;
  commission: number;
  uptime: number;
  blocksProposed: number;
  slashingEvents: number;
  delegators: number;
  isActive: boolean;
}

export interface StakingInfo {
  validatorAddress: EthereumAddress;
  stakedAmount: PositiveNumber;
  rewards: PositiveNumber;
  delegationDate: Date;
  lockupPeriod: number;
  canWithdraw: boolean;
}

// Cross-Chain Types
export interface CrossChainBridge {
  id: string;
  sourceChain: NetworkInfo;
  targetChain: NetworkInfo;
  bridgeContract: EthereumAddress;
  tvl: PositiveNumber;
  fee: PositiveNumber;
  minTransfer: PositiveNumber;
  maxTransfer: PositiveNumber;
  confirmationBlocks: number;
  estimatedTime: number;
}

export interface BridgeTransaction {
  id: string;
  sourceChain: number;
  targetChain: number;
  sourceHash: SecureHash;
  targetHash?: SecureHash;
  amount: PositiveNumber;
  token: EthereumAddress;
  sender: EthereumAddress;
  recipient: EthereumAddress;
  status: BridgeStatus;
  createdAt: Date;
  completedAt?: Date;
  confirmations: number;
  requiredConfirmations: number;
}

export type BridgeStatus =
  | 'pending'
  | 'confirmed'
  | 'completed'
  | 'failed'
  | 'expired';

// Weather Blockchain Integration Types
export interface WeatherDataBlock {
  stationId: string;
  timestamp: Date;
  readings: BlockchainSensorReading[];
  validationHash: SecureHash;
  rewardAmount: PositiveNumber;
  qualityScore: number;
  blockNumber: number;
  transactionHash: SecureHash;
}

/** A single sensor reading stored on-chain (generic type/value/unit). */
export interface BlockchainSensorReading {
  type: WeatherReadingType;
  value: number;
  unit: string;
  timestamp: Date;
  accuracy: number;
  validated: boolean;
}

export type WeatherReadingType =
  | 'temperature'
  | 'humidity'
  | 'pressure'
  | 'wind_speed'
  | 'wind_direction'
  | 'rainfall'
  | 'solar_radiation'
  | 'uv_index'
  | 'air_quality';

// Gas and Fee Types
export interface GasEstimate {
  gasLimit: number;
  gasPrice: PositiveNumber;
  maxFeePerGas?: PositiveNumber;
  maxPriorityFeePerGas?: PositiveNumber;
  estimatedCost: PositiveNumber;
  estimatedTime: number;
}

export interface FeeStructure {
  baseFee: PositiveNumber;
  priorityFee: PositiveNumber;
  maxFee: PositiveNumber;
  gasLimit: number;
  feeType: 'legacy' | 'eip1559';
}

// Event and Log Types
export interface BlockchainEvent {
  address: EthereumAddress;
  topics: string[];
  data: string;
  blockNumber: number;
  transactionHash: SecureHash;
  transactionIndex: number;
  blockHash: SecureHash;
  logIndex: number;
  removed: boolean;
}

export interface EventFilter {
  address?: EthereumAddress | EthereumAddress[];
  topics?: (string | string[] | null)[];
  fromBlock?: number | 'latest' | 'pending';
  toBlock?: number | 'latest' | 'pending';
}

// Blockchain Client Types
export interface BlockchainClient {
  getBlock(blockNumber: number): Promise<Block>;
  getTransaction(hash: SecureHash): Promise<Transaction>;
  getBalance(address: EthereumAddress): Promise<PositiveNumber>;
  sendTransaction(transaction: Transaction): Promise<SecureHash>;
  estimateGas(transaction: Partial<Transaction>): Promise<GasEstimate>;
  getLogs(filter: EventFilter): Promise<BlockchainEvent[]>;
  getCurrentBlockNumber(): Promise<number>;
  getNetworkInfo(): Promise<NetworkInfo>;
}
