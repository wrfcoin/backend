/**
 * Type definitions for Unified API Server
 * Comprehensive types for the core API gateway
 */

import { Request, Response, NextFunction } from 'express';
import { EthereumAddress, PositiveNumber } from './security-types.js';

// Enhanced Request interfaces
export interface UnifiedAPIRequest extends Request {
  rateLimitInfo?: {
    limit: number;
    remaining: number;
    resetTime: Date;
  };
  security?: {
    validated: boolean;
    threatLevel: 'low' | 'medium' | 'high';
    ipWhitelisted: boolean;
  };
  performance?: {
    startTime: number;
    cacheHit?: boolean;
  };
}

// API Response interfaces
export interface APIResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  timestamp: string;
  requestId?: string;
  performance?: {
    processingTime: number;
    cacheStatus: 'hit' | 'miss' | 'bypass';
  };
}

export interface PaginatedAPIResponse<T> extends APIResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

// Cross-chain transfer interfaces
export interface CrossChainTransfer {
  id: string;
  sourceChain: string;
  targetChain: string;
  senderAddress: EthereumAddress;
  recipientAddress: EthereumAddress;
  assetType: 'TOKEN' | 'NFT' | 'DATA';
  assetId: string;
  amount: PositiveNumber;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  bridgeId: string;
  transferFee: PositiveNumber;
  estimatedTime: number; // minutes
  actualTime?: number; // minutes
  confirmations: {
    required: number;
    current: number;
  };
  transactions: {
    sourceTxHash?: string;
    targetTxHash?: string;
    bridgeTxHash?: string;
  };
  metadata?: Record<string, any>;
  timestamp: Date;
  completedAt?: Date;
  errorMessage?: string;
}

// Weather data interfaces
export interface WeatherSubmission {
  stationId: string;
  timestamp: Date;
  location: {
    latitude: number;
    longitude: number;
    elevation?: number;
    address?: string;
  };
  sensors: WeatherSensor[];
  quality: {
    score: number; // 0-100
    issues: string[];
    validated: boolean;
  };
  rewards: {
    baseAmount: PositiveNumber;
    qualityBonus: PositiveNumber;
    proximityBonus: PositiveNumber;
    totalAmount: PositiveNumber;
  };
  blockchain: {
    blockNumber?: number;
    transactionHash?: string;
    gasUsed?: number;
  };
}

export interface WeatherSensor {
  type: string;
  value: number;
  unit: string;
  accuracy?: number;
  calibration?: Date;
  status: 'active' | 'inactive' | 'error' | 'maintenance';
}

// Mining and rewards interfaces
export interface MiningReward {
  id: string;
  recipient: EthereumAddress;
  type:
    | 'weather_data'
    | 'computation'
    | 'validation'
    | 'cross_chain'
    | 'staking';
  amount: PositiveNumber;
  currency: string;
  source: {
    type: string;
    id: string;
    details: Record<string, any>;
  };
  multipliers: {
    base: number;
    quality: number;
    proximity: number;
    frequency: number;
    total: number;
  };
  performance: {
    uptime: number; // percentage
    accuracy: number; // percentage
    speed: number; // operations per second
  };
  blockchain: {
    blockNumber: number;
    transactionHash: string;
    gasUsed: number;
    confirmations: number;
  };
  timestamp: Date;
  status: 'pending' | 'confirmed' | 'distributed' | 'failed';
}

// Blockchain status interfaces
export interface BlockchainStatus {
  network: string;
  chainId: number;
  blockHeight: number;
  blockTime: number; // seconds
  hashRate: PositiveNumber;
  difficulty: PositiveNumber;
  totalTransactions: number;
  pendingTransactions: number;
  activeNodes: number;
  networkHealth: 'excellent' | 'good' | 'fair' | 'poor' | 'critical';
  consensus: {
    mechanism: string;
    validators: number;
    stakeAmount: PositiveNumber;
    finalityTime: number; // seconds
  };
  recentBlocks: BlockInfo[];
  gasMetrics: {
    averageGasPrice: PositiveNumber;
    medianGasPrice: PositiveNumber;
    gasLimit: number;
    utilization: number; // percentage
  };
}

export interface BlockInfo {
  number: number;
  hash: string;
  timestamp: Date;
  transactions: number;
  gasUsed: number;
  miner?: EthereumAddress;
  reward?: PositiveNumber;
  size: number; // bytes
}

// Network analytics interfaces
export interface NetworkAnalytics {
  overview: {
    totalUsers: number;
    activeUsers24h: number;
    totalTransactions: number;
    totalValueLocked: PositiveNumber;
    networkUtilization: number; // percentage
  };
  performance: {
    averageResponseTime: number; // milliseconds
    throughput: number; // TPS
    errorRate: number; // percentage
    uptime: number; // percentage
  };
  security: {
    threatLevel: 'low' | 'medium' | 'high' | 'critical';
    activeThreats: number;
    blockedAttacks: number;
    securityScore: number; // 0-100
  };
  crossChain: {
    supportedChains: number;
    activeBridges: number;
    bridgeVolume24h: PositiveNumber;
    bridgeSuccessRate: number; // percentage
  };
  weather: {
    activeStations: number;
    dataSubmissions24h: number;
    averageQuality: number; // percentage
    rewardsDistributed24h: PositiveNumber;
  };
}

// Rate limiting interfaces
export interface RateLimitConfig {
  windowMs: number;
  max: number;
  message: string | object;
  standardHeaders?: boolean;
  legacyHeaders?: boolean;
  trustProxy?: boolean;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  resetTime: Date;
  retryAfter?: number;
}

// Security logging interfaces
export interface SecurityEvent {
  id: string;
  type:
    | 'rate_limit'
    | 'validation_error'
    | 'authentication_failure'
    | 'suspicious_activity'
    | 'breach_attempt';
  severity: 'low' | 'medium' | 'high' | 'critical';
  source: {
    ip: string;
    userAgent?: string;
    userId?: string;
    sessionId?: string;
  };
  target: {
    endpoint: string;
    method: string;
    resource?: string;
  };
  details: Record<string, any>;
  timestamp: Date;
  resolved: boolean;
  actions: string[];
}

export interface SecurityStats {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  topThreats: Array<{
    type: string;
    count: number;
    lastSeen: Date;
  }>;
  blockedIPs: string[];
  activeSessions: number;
  securityScore: number; // 0-100
}

// Health check interfaces
export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy' | 'critical';
  timestamp: Date;
  uptime: number; // seconds
  version: string;
  environment: string;
  services: ServiceHealth[];
  database: DatabaseHealth;
  blockchain: BlockchainHealth;
  performance: PerformanceMetrics;
  security: SecurityHealth;
}

export interface ServiceHealth {
  name: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  responseTime: number; // milliseconds
  errorRate: number; // percentage
  lastCheck: Date;
  dependencies: string[];
  message?: string;
}

export interface DatabaseHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  connectionPool: {
    total: number;
    active: number;
    idle: number;
  };
  queryPerformance: {
    averageTime: number; // milliseconds
    slowQueries: number;
  };
  storage: {
    used: number; // bytes
    available: number; // bytes
    utilization: number; // percentage
  };
}

export interface BlockchainHealth {
  status: 'healthy' | 'degraded' | 'unhealthy';
  nodeConnection: boolean;
  syncStatus: 'synced' | 'syncing' | 'behind' | 'disconnected';
  blocksBehind: number;
  lastBlockTime: Date;
  networkLatency: number; // milliseconds
}

export interface PerformanceMetrics {
  cpu: {
    usage: number; // percentage
    loadAverage: number[];
  };
  memory: {
    used: number; // bytes
    available: number; // bytes
    utilization: number; // percentage
  };
  disk: {
    used: number; // bytes
    available: number; // bytes
    utilization: number; // percentage
  };
  network: {
    bytesIn: number;
    bytesOut: number;
    packetsIn: number;
    packetsOut: number;
  };
}

export interface SecurityHealth {
  status: 'secure' | 'warning' | 'critical';
  lastSecurityScan: Date;
  vulnerabilities: {
    critical: number;
    high: number;
    medium: number;
    low: number;
  };
  certificates: {
    valid: boolean;
    expiresAt: Date;
    grade: string;
  };
  firewall: {
    active: boolean;
    rules: number;
    blockedConnections24h: number;
  };
}

// Compliance interfaces
export interface ComplianceStatus {
  overall_score: number;
  gdpr_compliance: boolean;
  iso27001_status: 'certified' | 'pending' | 'expired' | 'not_applicable';
  last_audit: string;
  next_audit: string;
  certifications: Certification[];
  data_protection: DataProtection;
  policy_compliance: number;
  violations: number;
  remediation_tasks: number;
}

export interface Certification {
  name: string;
  status: 'active' | 'expired' | 'pending' | 'revoked';
  expires?: string;
  last_review?: string;
  authority?: string;
}

export interface DataProtection {
  encryption_at_rest: boolean;
  encryption_in_transit: boolean;
  backup_encryption: boolean;
  access_logging: boolean;
  data_retention_policy: boolean;
  right_to_deletion: boolean;
  consent_management: boolean;
}

// Middleware types
export type SecurityMiddleware = (
  req: UnifiedAPIRequest,
  res: Response,
  next: NextFunction
) => void;
export type RateLimitMiddleware = (
  req: UnifiedAPIRequest,
  res: Response,
  next: NextFunction
) => void;
export type ValidationMiddleware = (
  req: UnifiedAPIRequest,
  res: Response,
  next: NextFunction
) => void;

import { RequestHandler } from 'express';

// Utility types - Use standard Express RequestHandler for compatibility
export type APIHandler = RequestHandler;
export type AsyncAPIHandler = RequestHandler;

// Configuration interfaces
export interface UnifiedAPIConfig {
  port: number;
  environment: 'development' | 'staging' | 'production';
  security: {
    trustProxy: boolean;
    helmet: Record<string, any>;
    cors: Record<string, any>;
    rateLimiting: Record<string, RateLimitConfig>;
  };
  performance: {
    compression: boolean;
    caching: boolean;
    monitoring: boolean;
  };
  logging: {
    level: string;
    format: string;
    destinations: string[];
  };
  database: {
    url: string;
    poolSize: number;
    timeout: number;
  };
  blockchain: {
    networks: Record<string, any>;
    defaultNetwork: string;
  };
}
