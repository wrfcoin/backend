/**
 * Service Integration Type Safety Framework
 * Ensures type safety across all microservice integrations in the WRFCoin platform
 *
 * This framework provides:
 * 1. Standardized service interface definitions
 * 2. Type-safe inter-service communication contracts
 * 3. Service registry validation
 * 4. Request/response type validation
 * 5. Event system type safety
 */

import { Request, Response, NextFunction } from 'express';
import { ApiResponse, ApiError, ApiResult } from './api-types.js';
import {
  CommunicationConfig,
  ServiceRegistration,
} from './communication-types.js';

// ================================
// Core Service Interface Types
// ================================

export interface ServiceEndpoint {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
  path: string;
  handler: ServiceHandler;
  middleware?: ServiceMiddleware[];
  validation?: ValidationSchema;
  rateLimit?: RateLimitConfig;
  auth?: AuthRequirement;
}

export type ServiceHandler<T = any, R = any> = (
  req: ServiceRequest<T>,
  res: ServiceResponse<R>,
  context: ServiceContext
) => Promise<void> | void;

export type ServiceMiddleware = (
  req: ServiceRequest,
  res: ServiceResponse,
  next: NextFunction,
  context: ServiceContext
) => Promise<void> | void;

// ================================
// Service Communication Types
// ================================

export interface ServiceRequest<T = any> extends Request {
  body: T;
  context: ServiceContext;
  serviceMetadata: {
    serviceId: string;
    version: string;
    requestId: string;
    traceId: string;
    timestamp: Date;
  };
}

export interface ServiceResponse<T = any> extends Response {
  sendTyped(result: ApiResult<T>): ServiceResponse<T>;
}

export interface ServiceContext {
  serviceId: string;
  version: string;
  environment: 'development' | 'staging' | 'production';
  user?: AuthenticatedUser;
  database: DatabaseConnection;
  cache: CacheConnection;
  logger: Logger;
  metrics: MetricsCollector;
  registry: ServiceRegistry;
}

// ================================
// Service Registry Types
// ================================

export interface ServiceDefinition {
  serviceId: string;
  serviceName: string;
  version: string;
  port: number;
  protocol: 'http' | 'https' | 'grpc';
  endpoints: ServiceEndpoint[];
  dependencies: ServiceDependency[];
  healthCheck: HealthCheckConfig;
  metrics: MetricsConfig;
  documentation: ServiceDocumentation;
}

export interface ServiceDependency {
  serviceId: string;
  version: string;
  required: boolean;
  timeout: number;
  retries: number;
  fallback?: string;
}

export interface HealthCheckConfig {
  enabled: boolean;
  interval: number;
  timeout: number;
  unhealthyThreshold: number;
  healthyThreshold: number;
  path?: string;
  checks: HealthCheckFunction[];
}

export type HealthCheckFunction = () => Promise<HealthCheckResult>;

export interface HealthCheckResult {
  status: 'healthy' | 'unhealthy' | 'degraded';
  message?: string;
  details?: any;
  duration: number;
}

// ================================
// Inter-Service Communication Types
// ================================

export interface InterServiceCall<TRequest = any, TResponse = any> {
  targetService: string;
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  data?: TRequest;
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  validate?: boolean;
}

export interface InterServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: ApiError['error'];
  metadata: {
    service: string;
    endpoint: string;
    duration: number;
    retries: number;
    cached: boolean;
    timestamp: Date;
  };
}

export interface ServiceClient<T = any> {
  serviceId: string;
  baseUrl: string;
  version: string;
  timeout: number;

  call<TRequest, TResponse>(
    call: InterServiceCall<TRequest, TResponse>
  ): Promise<InterServiceResponse<TResponse>>;

  get<TResponse>(
    endpoint: string,
    params?: any
  ): Promise<InterServiceResponse<TResponse>>;
  post<TRequest, TResponse>(
    endpoint: string,
    data: TRequest
  ): Promise<InterServiceResponse<TResponse>>;
  put<TRequest, TResponse>(
    endpoint: string,
    data: TRequest
  ): Promise<InterServiceResponse<TResponse>>;
  delete<TResponse>(endpoint: string): Promise<InterServiceResponse<TResponse>>;

  health(): Promise<HealthCheckResult>;
}

// ================================
// WRFCoin Service Definitions
// ================================

export interface WRFCoinServices {
  mainApi: MainApiService;
  crossChain: CrossChainService;
  wallet: WalletService;
  compute: ComputeService;
  aiml: AIMLService;
  storage: StorageService;
  iot: IoTService;
  governance: GovernanceService;
  weatherEarnings: WeatherEarningsService;
  nodeDiscovery: NodeDiscoveryService;
  nftMarketplace: NFTMarketplaceService;
  apiGateway: ApiGatewayService;
  userManagement: UserManagementService;
}

// ================================
// Service-Specific Type Definitions
// ================================

export interface MainApiService extends ServiceClient {
  getDashboardStats(): Promise<InterServiceResponse<DashboardStats>>;
  getNetworkInfo(): Promise<InterServiceResponse<NetworkInfo>>;
  getValidators(): Promise<InterServiceResponse<ValidatorInfo[]>>;
  getTransactionHistory(
    params: TransactionHistoryParams
  ): Promise<InterServiceResponse<PaginatedTransactions>>;
}

export interface CrossChainService extends ServiceClient {
  getBridges(): Promise<InterServiceResponse<CrossChainBridge[]>>;
  initiateBridgeTransfer(
    params: BridgeTransferParams
  ): Promise<InterServiceResponse<CrossChainTransaction>>;
  getBridgeStatus(
    bridgeId: string
  ): Promise<InterServiceResponse<BridgeStatus>>;
}

export interface WalletService extends ServiceClient {
  createWallet(
    params: CreateWalletParams
  ): Promise<InterServiceResponse<WalletInfo>>;
  getBalance(address: string): Promise<InterServiceResponse<WalletBalance>>;
  signTransaction(
    params: SignTransactionParams
  ): Promise<InterServiceResponse<SignedTransaction>>;
}

export interface ComputeService extends ServiceClient {
  getNetworks(): Promise<InterServiceResponse<ComputeNetwork[]>>;
  submitJob(
    params: ComputeJobParams
  ): Promise<InterServiceResponse<ComputeJob>>;
  getJobStatus(jobId: string): Promise<InterServiceResponse<ComputeJobStatus>>;
}

export interface AIMLService extends ServiceClient {
  getModels(): Promise<InterServiceResponse<AIModel[]>>;
  deployModel(
    params: DeployModelParams
  ): Promise<InterServiceResponse<ModelDeployment>>;
  executeInference(
    params: InferenceParams
  ): Promise<InterServiceResponse<InferenceResult>>;
}

export interface StorageService extends ServiceClient {
  uploadFile(params: FileUploadParams): Promise<InterServiceResponse<FileInfo>>;
  getFile(fileId: string): Promise<InterServiceResponse<FileData>>;
  getStorageStats(): Promise<InterServiceResponse<StorageStats>>;
}

export interface IoTService extends ServiceClient {
  getDevices(): Promise<InterServiceResponse<IoTDevice[]>>;
  submitSensorData(
    params: SensorDataParams
  ): Promise<InterServiceResponse<SensorDataResult>>;
  getDeviceStatus(
    deviceId: string
  ): Promise<InterServiceResponse<DeviceStatus>>;
}

export interface GovernanceService extends ServiceClient {
  getProposals(): Promise<InterServiceResponse<GovernanceProposal[]>>;
  createProposal(
    params: CreateProposalParams
  ): Promise<InterServiceResponse<ProposalResult>>;
  submitVote(params: VoteParams): Promise<InterServiceResponse<VoteResult>>;
}

export interface WeatherEarningsService extends ServiceClient {
  getEarnings(
    stationId: string
  ): Promise<InterServiceResponse<WeatherEarnings>>;
  processReward(
    params: WeatherRewardParams
  ): Promise<InterServiceResponse<RewardResult>>;
  getStationStats(
    stationId: string
  ): Promise<InterServiceResponse<StationStats>>;
}

export interface NodeDiscoveryService extends ServiceClient {
  getNodes(): Promise<InterServiceResponse<NetworkNode[]>>;
  registerNode(
    params: NodeRegistrationParams
  ): Promise<InterServiceResponse<NodeRegistrationResult>>;
  getNodeHealth(
    nodeId: string
  ): Promise<InterServiceResponse<NodeHealthStatus>>;
}

export interface NFTMarketplaceService extends ServiceClient {
  getMarketplace(): Promise<InterServiceResponse<NFTMarketplace>>;
  listNFT(params: ListNFTParams): Promise<InterServiceResponse<NFTListing>>;
  buyNFT(params: BuyNFTParams): Promise<InterServiceResponse<NFTPurchase>>;
}

export interface ApiGatewayService extends ServiceClient {
  getRoutes(): Promise<InterServiceResponse<GatewayRoute[]>>;
  getMetrics(): Promise<InterServiceResponse<GatewayMetrics>>;
  updateRouting(
    params: UpdateRoutingParams
  ): Promise<InterServiceResponse<RoutingUpdateResult>>;
}

export interface UserManagementService extends ServiceClient {
  getUser(userId: string): Promise<InterServiceResponse<User>>;
  createUser(
    params: CreateUserParams
  ): Promise<InterServiceResponse<UserResult>>;
  updateUser(
    userId: string,
    params: UpdateUserParams
  ): Promise<InterServiceResponse<UserResult>>;
}

// ================================
// Type Validation Framework
// ================================

export interface TypeValidator<T> {
  validate(data: unknown): ValidationResult<T>;
  schema: any; // JSON Schema or Joi schema
}

export interface ValidationResult<T> {
  isValid: boolean;
  data?: T;
  errors: ValidationError[];
}

export interface ValidationError {
  field: string;
  message: string;
  code: string;
  value?: any;
}

export interface ValidationSchema {
  type: 'joi' | 'ajv' | 'zod' | 'yup';
  schema: any;
  options?: any;
}

// ================================
// Service Registry Validation
// ================================

export interface ServiceRegistry {
  register(service: ServiceDefinition): Promise<void>;
  deregister(serviceId: string): Promise<void>;
  discover(serviceId: string): Promise<ServiceRegistration | null>;
  discoverAll(): Promise<ServiceRegistration[]>;
  validateTypes(serviceId: string): Promise<TypeValidationResult>;
  healthCheck(serviceId: string): Promise<HealthCheckResult>;
}

export interface TypeValidationResult {
  serviceId: string;
  isValid: boolean;
  errors: TypeValidationError[];
  warnings: TypeValidationWarning[];
  timestamp: Date;
}

export interface TypeValidationError {
  endpoint: string;
  field: string;
  expected: string;
  actual: string;
  message: string;
}

export interface TypeValidationWarning {
  endpoint: string;
  field?: string;
  message: string;
  suggestion?: string;
}

// ================================
// Event System Type Safety
// ================================

export interface ServiceEvent<T = any> {
  id: string;
  type: string;
  source: string;
  version: string;
  data: T;
  timestamp: Date;
  metadata?: any;
}

export interface EventSubscription<T = any> {
  eventType: string;
  handler: EventHandler<T>;
  filter?: EventFilter<T>;
  options?: EventSubscriptionOptions;
}

export type EventHandler<T = any> = (event: ServiceEvent<T>) => Promise<void>;
export type EventFilter<T = any> = (event: ServiceEvent<T>) => boolean;

export interface EventSubscriptionOptions {
  maxRetries?: number;
  retryDelay?: number;
  deadLetterQueue?: string;
  timeout?: number;
}

export interface EventBus {
  publish<T>(event: ServiceEvent<T>): Promise<void>;
  subscribe<T>(subscription: EventSubscription<T>): Promise<string>;
  unsubscribe(subscriptionId: string): Promise<void>;
  validateEvent<T>(event: ServiceEvent<T>): ValidationResult<ServiceEvent<T>>;
}

// ================================
// Circuit Breaker Types
// ================================

export interface CircuitBreakerConfig {
  failureThreshold: number;
  recoveryTimeout: number;
  halfOpenMaxCalls: number;
  monitoringPeriod: number;
}

export enum CircuitBreakerState {
  CLOSED = 'closed',
  OPEN = 'open',
  HALF_OPEN = 'half_open',
}

export interface CircuitBreaker {
  state: CircuitBreakerState;
  config: CircuitBreakerConfig;
  execute<T>(fn: () => Promise<T>): Promise<T>;
  reset(): void;
  getMetrics(): CircuitBreakerMetrics;
}

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState;
  failureCount: number;
  successCount: number;
  lastFailureTime?: Date;
  nextAttempt?: Date;
}

// ================================
// Authentication & Authorization
// ================================

export interface AuthenticatedUser {
  id: string;
  address: string;
  roles: string[];
  permissions: string[];
  verified: boolean;
  metadata?: any;
}

export interface AuthRequirement {
  required: boolean;
  roles?: string[];
  permissions?: string[];
  wallet?: boolean;
}

export interface RateLimitConfig {
  windowMs: number;
  max: number;
  keyGenerator?: (req: ServiceRequest) => string;
  skip?: (req: ServiceRequest) => boolean;
}

// ================================
// Database & Cache Types
// ================================

export interface DatabaseConnection {
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  execute(sql: string, params?: any[]): Promise<void>;
  transaction<T>(fn: (tx: DatabaseTransaction) => Promise<T>): Promise<T>;
  health(): Promise<boolean>;
}

export interface DatabaseTransaction {
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  execute(sql: string, params?: any[]): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
}

export interface CacheConnection {
  get<T>(key: string): Promise<T | null>;
  set<T>(key: string, value: T, ttl?: number): Promise<void>;
  del(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  health(): Promise<boolean>;
}

// ================================
// Logging & Metrics
// ================================

export interface Logger {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
  fatal(message: string, meta?: any): void;
}

export interface MetricsCollector {
  counter(name: string, value?: number, tags?: any): void;
  gauge(name: string, value: number, tags?: any): void;
  histogram(name: string, value: number, tags?: any): void;
  timer(name: string): MetricsTimer;
}

export interface MetricsTimer {
  end(tags?: any): void;
}

export interface MetricsConfig {
  enabled: boolean;
  prefix: string;
  tags: Record<string, string>;
  exportInterval: number;
}

export interface ServiceDocumentation {
  title: string;
  description: string;
  version: string;
  endpoints: EndpointDocumentation[];
  examples: DocumentationExample[];
}

export interface EndpointDocumentation {
  path: string;
  method: string;
  summary: string;
  description?: string;
  parameters?: ParameterDocumentation[];
  responses: ResponseDocumentation[];
}

export interface ParameterDocumentation {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  example?: any;
}

export interface ResponseDocumentation {
  status: number;
  description: string;
  schema?: any;
  example?: any;
}

export interface DocumentationExample {
  title: string;
  description: string;
  request: any;
  response: any;
}

// ================================
// Type-Safe Parameter Definitions
// ================================

// These would be specific to the WRFCoin platform services
export interface DashboardStats {
  totalNodes: number;
  activeValidators: number;
  totalTransactions: number;
  networkHashrate: string;
  averageBlockTime: string;
}

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
}

export interface ValidatorInfo {
  address: string;
  stake: string;
  commission: number;
  uptime: number;
  status: 'active' | 'inactive';
}

// ================================
// Service-Specific Parameter & Result Types
// ================================

export interface TransactionHistoryParams {
  address?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  startDate?: string;
  endDate?: string;
  type?: string;
}

export interface PaginatedTransactions {
  transactions: any[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export interface BridgeTransferParams {
  sourceChain: string;
  destinationChain: string;
  token: string;
  amount: string;
  fromAddress: string;
  toAddress: string;
}

export interface BridgeStatus {
  bridgeId: string;
  status: 'active' | 'maintenance' | 'disabled';
  tvl: string;
  pendingTransfers: number;
  lastActivity: Date;
}

export interface CreateWalletParams {
  network?: string;
  label?: string;
  type?: 'standard' | 'multisig' | 'hardware';
}

export interface WalletInfo {
  address: string;
  network: string;
  balance: string;
  publicKey: string;
  label?: string;
  createdAt: Date;
}

export interface WalletBalance {
  address: string;
  balance: string;
  tokens: Array<{ symbol: string; balance: string; value: string }>;
}

export interface SignTransactionParams {
  fromAddress: string;
  toAddress: string;
  amount: string;
  token?: string;
  nonce?: number;
}

export interface SignedTransaction {
  hash: string;
  signature: string;
  rawTransaction: string;
}

export interface ComputeNetwork {
  id: string;
  name: string;
  type: string;
  capacity: number;
  utilization: number;
  status: 'active' | 'inactive';
}

export interface ComputeJobParams {
  network: string;
  task: any;
  resources?: { cpu: number; memory: string; gpu?: boolean };
  priority?: 'low' | 'normal' | 'high' | 'urgent';
}

export interface ComputeJob {
  id: string;
  network: string;
  status: string;
  createdAt: Date;
  estimatedCompletion?: Date;
}

export interface ComputeJobStatus {
  jobId: string;
  status: 'queued' | 'running' | 'completed' | 'failed';
  progress: number;
  result?: any;
  error?: string;
}

export interface AIModel {
  id: string;
  name: string;
  type: string;
  provider: string;
  version: string;
  status: 'active' | 'inactive' | 'deploying';
}

export interface DeployModelParams {
  modelId: string;
  provider: string;
  config?: Record<string, any>;
}

export interface ModelDeployment {
  deploymentId: string;
  modelId: string;
  status: 'deploying' | 'active' | 'failed';
  endpoint?: string;
  createdAt: Date;
}

export interface InferenceParams {
  modelId: string;
  input: any;
  parameters?: Record<string, any>;
}

export interface InferenceResult {
  modelId: string;
  output: any;
  confidence?: number;
  latency: number;
}

export interface FileUploadParams {
  filename: string;
  contentType: string;
  data: Buffer | string;
  metadata?: Record<string, any>;
}

export interface FileInfo {
  fileId: string;
  filename: string;
  contentType: string;
  size: number;
  hash: string;
  url?: string;
  createdAt: Date;
}

export interface FileData {
  fileId: string;
  filename: string;
  contentType: string;
  data: Buffer | string;
  metadata?: Record<string, any>;
}

export interface StorageStats {
  totalStorage: number;
  usedStorage: number;
  availableStorage: number;
  fileCount: number;
}

export interface IoTDevice {
  deviceId: string;
  deviceType: string;
  name: string;
  status: 'online' | 'offline' | 'maintenance';
  location?: { lat: number; lng: number };
  lastSeen?: Date;
}

export interface SensorDataParams {
  deviceId: string;
  readings: Array<{ type: string; value: number; unit: string; timestamp?: Date }>;
}

export interface SensorDataResult {
  accepted: number;
  rejected: number;
  errors?: string[];
}

export interface DeviceStatus {
  deviceId: string;
  status: 'online' | 'offline' | 'maintenance';
  battery?: number;
  signalStrength?: number;
  lastReading?: Date;
  firmware?: string;
}

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
}

export interface CreateProposalParams {
  title: string;
  description: string;
  actions?: any[];
  votingPeriod?: number;
}

export interface ProposalResult {
  proposalId: string;
  status: string;
  transactionHash?: string;
}

export interface VoteParams {
  proposalId: string;
  support: boolean;
  reason?: string;
}

export interface VoteResult {
  voteId: string;
  proposalId: string;
  recorded: boolean;
  transactionHash?: string;
}

export interface WeatherEarnings {
  stationId: string;
  totalEarnings: string;
  pendingRewards: string;
  lastPayout?: Date;
  tier: string;
}

export interface WeatherRewardParams {
  stationId: string;
  dataQuality: number;
  dataVolume: number;
  period?: string;
}

export interface RewardResult {
  rewardId: string;
  amount: string;
  transactionHash?: string;
  status: 'pending' | 'processed' | 'failed';
}

export interface StationStats {
  stationId: string;
  totalReadings: number;
  averageQuality: number;
  uptime: number;
  lastReading?: Date;
}

export interface NetworkNode {
  nodeId: string;
  address: string;
  type: 'full' | 'light' | 'validator';
  status: 'active' | 'inactive' | 'syncing';
  version: string;
  lastSeen: Date;
}

export interface NodeRegistrationParams {
  address: string;
  type: 'full' | 'light' | 'validator';
  publicKey: string;
  metadata?: Record<string, any>;
}

export interface NodeRegistrationResult {
  nodeId: string;
  registered: boolean;
  token?: string;
}

export interface NodeHealthStatus {
  nodeId: string;
  status: 'healthy' | 'unhealthy' | 'degraded';
  uptime: number;
  blockHeight: number;
  peerCount: number;
  lastCheck: Date;
}

export interface NFTMarketplace {
  totalNFTs: number;
  activeListings: number;
  floorPrice: string;
  volume24h: string;
}

export interface ListNFTParams {
  tokenId: string;
  price: string;
  currency: string;
  expiration?: string;
}

export interface NFTListing {
  listingId: string;
  tokenId: string;
  price: string;
  currency: string;
  seller: string;
  createdAt: Date;
}

export interface BuyNFTParams {
  listingId: string;
  buyerAddress: string;
}

export interface NFTPurchase {
  purchaseId: string;
  tokenId: string;
  price: string;
  buyer: string;
  seller: string;
  transactionHash: string;
}

export interface GatewayRoute {
  path: string;
  service: string;
  method: string[];
  rateLimit?: { windowMs: number; max: number };
  auth?: boolean;
}

export interface GatewayMetrics {
  totalRequests: number;
  averageLatency: number;
  errorRate: number;
  activeConnections: number;
  routes: Array<{ path: string; requestCount: number; avgLatency: number }>;
}

export interface UpdateRoutingParams {
  routes: GatewayRoute[];
  version?: string;
}

export interface RoutingUpdateResult {
  updated: boolean;
  activeRoutes: number;
  version: string;
}

export interface User {
  id: string;
  username?: string;
  email?: string;
  address?: string;
  role: string;
  roles?: string[];
  permissions?: string[];
  isActive: boolean;
  createdAt: Date;
}

export interface CreateUserParams {
  username?: string;
  email?: string;
  address?: string;
  role?: string;
  password?: string;
}

export interface UpdateUserParams {
  username?: string;
  email?: string;
  role?: string;
  isActive?: boolean;
}

export interface UserResult {
  userId: string;
  success: boolean;
  message?: string;
}

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

// ================================
// Export All Types
// ================================

// Re-export from communication-types which already includes api-types and security-types
export * from './communication-types.js';
