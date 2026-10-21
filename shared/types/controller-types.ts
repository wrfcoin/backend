/**
 * Controller Types for Wrfcoin Platform
 * Type definitions for controllers, business logic, and API responses
 */

import { Request, Response } from 'express';
import {
  EthereumAddress,
  PositiveNumber,
  SupportedToken,
} from './security-types.js';

// Controller Response Types
export interface ControllerResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
  requestId?: string;
}

export interface PaginatedResponse<T> extends ControllerResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// Blockchain Controller Types
export interface BlockchainTransaction {
  hash: string;
  from: EthereumAddress;
  to: EthereumAddress;
  amount: PositiveNumber;
  token: SupportedToken;
  fee: PositiveNumber;
  timestamp: Date;
  status: 'pending' | 'confirmed' | 'failed';
  blockNumber?: number;
  gasUsed?: number;
}

export interface BlockchainStatus {
  isConnected: boolean;
  chainId: number;
  blockHeight: number;
  networkName: string;
  gasPrice: number;
  lastUpdate: Date;
}

// Weather Controller Types — canonical type in weather-types.ts
export type { ControllerWeatherReading as WeatherReading } from './weather-types.js';

export interface WeatherStation {
  id: string;
  name: string;
  location: {
    latitude: number;
    longitude: number;
    elevation: number;
    address: string;
  };
  owner: EthereumAddress;
  isActive: boolean;
  lastReading: Date;
  totalReadings: number;
  rewardsEarned: PositiveNumber;
}

export interface WeatherReward {
  transactionId: string;
  stationId: string;
  amount: PositiveNumber;
  reason: string;
  timestamp: Date;
  blockHash: string;
  qualityScore: number;
}

// Mining Controller Types
export interface MiningOperation {
  id: string;
  miner: EthereumAddress;
  algorithm: string;
  hashRate: number;
  power: number;
  startTime: Date;
  endTime?: Date;
  pausedAt?: Date;
  resumedAt?: Date;
  status: 'active' | 'paused' | 'stopped';
  rewardsEarned: PositiveNumber;
  restartCount?: number;
}

export interface MiningReward {
  id: string;
  miner: EthereumAddress;
  amount: PositiveNumber;
  blockHeight: number;
  timestamp: Date;
  difficulty: number;
  algorithm: string;
}

// Cross-Chain Controller Types
export interface CrossChainBridge {
  id: string;
  name: string;
  sourceChain: string;
  targetChain: string;
  isActive: boolean;
  fee: PositiveNumber;
  minAmount: PositiveNumber;
  maxAmount: PositiveNumber;
  totalVolume: PositiveNumber;
}

export interface CrossChainTransfer {
  id: string;
  bridgeId: string;
  from: EthereumAddress;
  to: EthereumAddress;
  amount: PositiveNumber;
  token: SupportedToken;
  sourceChain: string;
  targetChain: string;
  status: 'initiated' | 'locked' | 'minted' | 'completed' | 'failed';
  timestamp: Date;
  sourceTxHash: string;
  targetTxHash?: string;
}

// NFT Controller Types
export interface NFTMetadata {
  name: string;
  description: string;
  image: string;
  attributes: Array<{
    trait_type: string;
    value: string | number;
  }>;
  external_url?: string;
  animation_url?: string;
}

export interface ComputationalNFT {
  tokenId: string;
  owner: EthereumAddress;
  metadata: NFTMetadata;
  computationData: {
    algorithm: string;
    inputData: string;
    outputData: string;
    computeTime: number;
    energyUsed: number;
  };
  timestamp: Date;
  isComputed: boolean;
}

// Governance Controller Types
export interface GovernanceProposal {
  id: string;
  title: string;
  description: string;
  proposer: EthereumAddress;
  startTime: Date;
  endTime: Date;
  status: 'draft' | 'active' | 'passed' | 'rejected' | 'executed';
  votesFor: PositiveNumber;
  votesAgainst: PositiveNumber;
  totalVotes: PositiveNumber;
  quorumReached: boolean;
}

export interface GovernanceVote {
  proposalId: string;
  voter: EthereumAddress;
  support: boolean;
  votingPower: PositiveNumber;
  timestamp: Date;
  reason?: string;
}

// Wallet Controller Types
export interface WalletBalance {
  address: EthereumAddress;
  token: SupportedToken;
  balance: PositiveNumber;
  locked: PositiveNumber;
  available: PositiveNumber;
  lastUpdate: Date;
}

export interface WalletTransaction {
  hash: string;
  from: EthereumAddress;
  to: EthereumAddress;
  amount: PositiveNumber;
  token: SupportedToken;
  type: 'send' | 'receive' | 'mining' | 'weather' | 'governance';
  status: 'pending' | 'confirmed' | 'failed';
  timestamp: Date;
  fee: PositiveNumber;
}

// Privacy Controller Types
export interface PrivacySettings {
  userId: string;
  dataSharing: boolean;
  analyticsOptOut: boolean;
  marketingOptOut: boolean;
  locationTracking: boolean;
  weatherDataSharing: boolean;
  zkProofsEnabled: boolean;
}

export interface ZKProof {
  id: string;
  type: 'weather' | 'computation' | 'identity';
  proof: string;
  publicInputs: string[];
  timestamp: Date;
  isValid: boolean;
  verificationKey: string;
}

// Controller Method Types
export type ControllerMethod<T = any> = (
  req: Request,
  res: Response
) => Promise<ControllerResponse<T>>;

export interface BaseController {
  create: ControllerMethod;
  read: ControllerMethod;
  update: ControllerMethod;
  delete: ControllerMethod;
  list: ControllerMethod;
}

// Validation Types
export interface ValidationSchema {
  [key: string]: {
    type: 'string' | 'number' | 'boolean' | 'array' | 'object';
    required?: boolean;
    min?: number;
    max?: number;
    pattern?: RegExp;
    enum?: any[];
    custom?: (value: any) => boolean;
  };
}

export interface ValidationResult {
  isValid: boolean;
  errors: Array<{
    field: string;
    message: string;
    value?: any;
  }>;
}

// Service Layer Types
export interface ServiceResult<T = any> {
  success: boolean;
  data?: T;
  error?: Error;
  errorCode?: string;
  metadata?: Record<string, any>;
}

export interface ServiceOptions {
  timeout?: number;
  retries?: number;
  cache?: boolean;
  cacheTTL?: number;
}

// Event Types for Controllers
export interface ControllerEvent {
  type: string;
  controller: string;
  method: string;
  data: any;
  timestamp: Date;
  userId?: string;
  requestId?: string;
}

// Metrics Types
export interface ControllerMetrics {
  controller: string;
  method: string;
  requestCount: number;
  averageResponseTime: number;
  errorCount: number;
  lastRequest: Date;
}

// Export utility type helpers
export type AsyncControllerMethod<T = any, R extends Request = Request> = (
  req: R,
  res: Response
) => Promise<ControllerResponse<T> | PaginatedResponse<T> | void>;

export type AsyncControllerMethodWithReturn<T = any> = (
  req: Request,
  res: Response
) => Promise<ControllerResponse<T>>;

export type ControllerFactory<T extends BaseController> = (
  services: any,
  config: any
) => T;
