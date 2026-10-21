/**
 * API Types for Wrfcoin Platform
 * Shared types for request/response validation and type safety
 */

export type { WeatherData } from './weather-types.js';

export interface ApiResponse<T = any> {
  success: true;
  data: T;
  timestamp?: string;
  meta?: Record<string, any>;
}

export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
    stack?: string;
  };
  timestamp?: string;
}

export type ApiResult<T = any> = ApiResponse<T> | ApiError;

// Dashboard Stats Types
export interface DashboardStats {
  totalNodes: number;
  activeValidators: number;
  totalTransactions: number;
  networkHashrate: string;
  averageBlockTime: string;
  totalSupply: string;
  circulatingSupply: string;
  marketCap: string;
  price: string;
  volume24h: string;
}

// NFT Marketplace Types
export interface NFTMarketplace {
  totalNFTs: number;
  activeListings: number;
  floorPrice: string;
  volume24h: string;
  topCollections: NFTCollection[];
}

export interface NFTCollection {
  id: string;
  name: string;
  floorPrice: string;
  volume: string;
  owners: number;
}

export interface NFT {
  tokenId: string;
  name: string;
  description: string;
  image: string;
  price: string;
  owner: string;
  collection: string;
  attributes: NFTAttribute[];
}

export interface NFTAttribute {
  trait_type: string;
  value: string | number;
  rarity?: number;
}

// Weather Data Types — canonical WeatherData is re-exported from weather-types.ts

export interface WeatherReward {
  stationId: string;
  amount: number;
  timestamp: Date;
  achievementTier: number;
  transactionHash?: string;
  blockNumber?: number;
}

// Cross-Chain Types
export interface CrossChainBridge {
  id: string;
  name: string;
  sourceChain: string;
  targetChain: string;
  tvl: string;
  status: 'active' | 'maintenance' | 'disabled';
  fee: string;
}

export interface CrossChainTransaction {
  id: string;
  sourceChain: string;
  targetChain: string;
  amount: string;
  token: string;
  status: 'pending' | 'completed' | 'failed';
  timestamp: Date;
  sourceHash?: string;
  targetHash?: string;
}

// Governance Types
export interface GovernanceProposal {
  id: string;
  title: string;
  description: string;
  proposer: string;
  status: 'active' | 'passed' | 'failed' | 'executed';
  votesFor: number;
  votesAgainst: number;
  startDate: Date;
  endDate: Date;
  executionDate?: Date;
}

export interface Vote {
  proposalId: string;
  voter: string;
  support: boolean;
  weight: number;
  timestamp: Date;
}

// Mining Types
export interface MiningStats {
  hashrate: string;
  difficulty: string;
  blocksFound: number;
  lastBlockTime: Date;
  estimatedRewards: string;
}

export interface MiningPool {
  id: string;
  name: string;
  hashrate: string;
  miners: number;
  fee: string;
  payoutScheme: string;
}

// Wallet Types
export interface WalletBalance {
  address: string;
  balance: string;
  tokens: TokenBalance[];
  nfts: NFT[];
}

export interface TokenBalance {
  symbol: string;
  balance: string;
  value: string;
}

// Transaction Types
export interface Transaction {
  hash: string;
  from: string;
  to: string;
  amount: string;
  fee: string;
  timestamp: Date;
  blockNumber: number;
  status: 'pending' | 'confirmed' | 'failed';
  type: 'transfer' | 'contract' | 'weather_reward' | 'governance';
}

// Validation Types
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  warnings?: string[];
}

// Pagination Types
export interface PaginationParams {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// Request Types
export interface CreateTransactionRequest {
  to: string;
  amount: string;
  token?: string;
  memo?: string;
}

export interface CreateProposalRequest {
  title: string;
  description: string;
  actions: ProposalAction[];
  votingPeriod: number;
}

export interface ProposalAction {
  target: string;
  value: string;
  signature: string;
  data: string;
}

export interface VoteRequest {
  proposalId: string;
  support: boolean;
  reason?: string;
}

// Computational NFT Types
export interface ComputationalNft {
  id: number;
  nftId: string;
  name: string;
  description: string;
  creator: string;
  contentUri: string;
  computationType: string;
  computationComplexity: number;
  resourceRequirements: any;
  inputData: any;
  parameters: any;
  createdAt: Date;
  updatedAt: Date;
  isVerified: boolean;
  verifiers: any;
  region: string;
  accuracy: string;
  creatorReputation: number;
  verificationSignatures: any;
  executionResultHash: string;
  metadata: any;
  transactionId: string;
  versionTag: string;
}

// User and Wallet Types
export interface User {
  id: number;
  username?: string;
  email?: string;
  address?: string;
  walletAddress?: string; // Alias for address
  role: string;
  roles?: string[];
  permissions?: string[];
  createdAt: Date;
  updatedAt: Date;
  lastLogin?: Date;
  isActive: boolean;
  emailVerified: boolean;
  metadata?: any;
}

export interface Wallet {
  id: number;
  address: string;
  network: string;
  balance: string;
  lastUpdated: Date;
  createdAt: Date;
  publicKey?: string;
  label?: string;
  isActive: boolean;
  metadata?: any;
}
