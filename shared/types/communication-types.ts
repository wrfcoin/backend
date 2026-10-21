/**
 * Service Communication Standards - Type Definitions
 *
 * This file contains TypeScript type definitions that enforce
 * the WRFCoin Service Communication Standards across all services.
 */

// ================================
// Core API Response Types
// ================================

export interface ApiResponse<T = any> {
  success: true;
  data: T;
  timestamp: string;
  meta?: {
    pagination?: PaginationMeta;
    cache?: CacheMeta;
    version?: string;
    requestId?: string;
    [key: string]: any;
  };
}

export interface ApiError {
  success: false;
  error: {
    code: string; // Machine-readable error code
    message: string; // Human-readable message
    details?: unknown; // Additional error context
    field?: string; // Field causing validation error
    stack?: string; // Stack trace (development only)
  };
  timestamp: string;
  requestId?: string; // For request tracking
}

export type ApiResult<T> = ApiResponse<T> | ApiError;

// ================================
// Pagination Types
// ================================

export interface PaginationMeta {
  page: number; // Current page (1-based)
  limit: number; // Items per page
  total: number; // Total items
  totalPages: number; // Total pages
  hasNext: boolean; // Has next page
  hasPrev: boolean; // Has previous page
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

// ================================
// Cache Types
// ================================

export interface CacheMeta {
  cached: boolean;
  cacheKey?: string;
  ttl?: number;
  hitRate?: number;
}

export interface CacheConfig {
  ttl: number; // Time to live in seconds
  prefix: string; // Key prefix
  compress?: boolean; // Enable compression
  tags?: string[]; // Cache invalidation tags
}

// ================================
// Service Registry Types
// ================================

export interface ServiceRegistration {
  serviceId: string;
  serviceName: string;
  version: string;
  host: string;
  port: number;
  protocol: 'http' | 'https' | 'grpc' | 'grpc+tls';
  healthCheckUrl?: string;
  tags: string[];
  metadata: Record<string, string>;
  lastHeartbeat?: Date;
  status: 'healthy' | 'unhealthy' | 'unknown';
}

export interface ServiceDiscoveryClient {
  register(service: ServiceRegistration): Promise<void>;
  deregister(serviceId: string): Promise<void>;
  discover(
    serviceName: string,
    tags?: string[]
  ): Promise<ServiceRegistration[]>;
  health(serviceId: string): Promise<boolean>;
}

// ================================
// Health Check Types
// ================================

export interface HealthCheck {
  name: string;
  status: 'up' | 'down' | 'degraded';
  timestamp: Date;
  duration?: number;
  error?: string;
  metadata?: Record<string, any>;
}

export interface MemoryUsageSnapshot {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

export interface SystemHealth {
  status: 'healthy' | 'unhealthy' | 'degraded';
  timestamp: string;
  version: string;
  uptime: number;
  services: Record<string, HealthCheck>;
  metrics: {
    memory: MemoryUsageSnapshot;
    cpu?: number;
    connections?: number;
  };
}

// ================================
// Request Tracing Types
// ================================

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  flags?: number;
}

export interface RequestMetadata {
  requestId: string;
  transactionId: string;
  userId?: string;
  userRole?: string;
  clientId?: string;
  userAgent?: string;
  ipAddress?: string;
  startTime: Date;
  trace?: TraceContext;
}

// ================================
// Rate Limiting Types
// ================================

export interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  max: number; // Maximum requests per window
  keyGenerator?: (req: any) => string;
  skip?: (req: any) => boolean;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
}

export interface RateLimitInfo {
  limit: number;
  remaining: number;
  reset: Date;
  retryAfter?: number;
}

// ================================
// Authentication Types
// ================================

export interface JWTPayload {
  sub: string; // Subject (user ID)
  iss: string; // Issuer
  aud: string; // Audience
  exp: number; // Expiration time
  iat: number; // Issued at
  jti?: string; // JWT ID
  scope?: string[]; // OAuth scopes
  permissions?: string[]; // User permissions
  roles?: string[]; // User roles
}

export interface ApiKeyInfo {
  keyId: string;
  name: string;
  scopes: string[];
  permissions: string[];
  rateLimit?: RateLimitConfig;
  expiresAt?: Date;
  lastUsed?: Date;
  metadata?: Record<string, string>;
}

// ================================
// gRPC Types
// ================================

export interface GrpcServiceConfig {
  host: string;
  port: number;
  credentials: 'insecure' | 'ssl' | 'mtls';
  keepAlive?: {
    time: number;
    timeout: number;
    permitWithoutCalls: boolean;
  };
  maxMessageSize?: number;
  interceptors?: string[];
}

export interface GrpcError {
  code: number; // gRPC status code
  message: string;
  details?: any[];
  metadata?: Record<string, string>;
}

// ================================
// Service Communication Types
// ================================

export interface ServiceClient {
  serviceName: string;
  protocol: 'rest' | 'grpc';
  baseUrl?: string; // For REST
  grpcConfig?: GrpcServiceConfig; // For gRPC
  timeout: number;
  retries: number;
  circuitBreaker?: {
    failureThreshold: number;
    resetTimeout: number;
  };
}

export interface InterServiceRequest<T = any> {
  method: string;
  path?: string; // REST path
  data?: T;
  headers?: Record<string, string>;
  timeout?: number;
  retries?: number;
  metadata?: RequestMetadata;
}

export interface InterServiceResponse<T = any> {
  success: boolean;
  data?: T;
  error?: ApiError['error'];
  metadata: {
    service: string;
    duration: number;
    retries: number;
    cached: boolean;
  };
}

// ================================
// Middleware Types
// ================================

export interface ValidationSchema {
  type: 'joi' | 'ajv' | 'zod';
  schema: any;
  options?: {
    allowUnknown?: boolean;
    stripUnknown?: boolean;
    abortEarly?: boolean;
  };
}

export interface SecurityHeaders {
  'content-security-policy'?: string;
  'strict-transport-security'?: string;
  'x-content-type-options'?: string;
  'x-frame-options'?: string;
  'x-xss-protection'?: string;
  'referrer-policy'?: string;
}

// ================================
// Monitoring Types
// ================================

export interface RequestMetrics {
  method: string;
  path: string;
  statusCode: number;
  duration: number;
  size: {
    request: number;
    response: number;
  };
  timestamp: Date;
  metadata: RequestMetadata;
}

export interface ServiceMetrics {
  requests: {
    total: number;
    success: number;
    error: number;
    avgDuration: number;
  };
  errors: {
    rate: number;
    byCode: Record<string, number>;
  };
  performance: {
    p50: number;
    p95: number;
    p99: number;
  };
  resources: {
    memory: MemoryUsageSnapshot;
    cpu: number;
    connections: number;
  };
}

// ================================
// Configuration Types
// ================================

export interface CommunicationConfig {
  service: {
    name: string;
    version: string;
    port: number;
    environment: 'development' | 'staging' | 'production';
  };

  api: {
    prefix: string;
    version: string;
    cors: {
      origin: string | string[];
      methods: string[];
      allowedHeaders: string[];
    };
    rateLimit: RateLimitConfig;
    security: SecurityHeaders;
  };

  tracing: {
    enabled: boolean;
    serviceName: string;
    endpoint?: string;
    sampleRate: number;
  };

  logging: {
    level: 'error' | 'warn' | 'info' | 'debug';
    format: 'json' | 'text';
    transports: string[];
  };

  cache: {
    enabled: boolean;
    provider: 'redis' | 'memory';
    connection?: string;
    defaultTtl: number;
  };

  clients: Record<string, ServiceClient>;
}

// ================================
// Type Guards and Utilities
// ================================

export function isApiResponse<T>(
  response: ApiResult<T>,
): response is ApiResponse<T> {
  return response.success === true;
}

export function isApiError(response: ApiResult<any>): response is ApiError {
  return response.success === false;
}

export function createApiResponse<T>(
  data: T,
  meta?: ApiResponse<T>['meta'],
): ApiResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
    meta,
  };
}

export function createApiError(
  code: string,
  message: string,
  details?: unknown,
  field?: string,
): ApiError {
  return {
    success: false,
    error: {
      code,
      message,
      details,
      field,
    },
    timestamp: new Date().toISOString(),
  };
}

// ================================
// Error Code Constants
// ================================

export const ERROR_CODES = {
  // Validation Errors
  VALIDATION_MISSING_FIELD: 'VALIDATION_MISSING_FIELD',
  VALIDATION_INVALID_FORMAT: 'VALIDATION_INVALID_FORMAT',
  VALIDATION_OUT_OF_RANGE: 'VALIDATION_OUT_OF_RANGE',

  // Authentication Errors
  AUTH_TOKEN_MISSING: 'AUTH_TOKEN_MISSING',
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID',
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED',
  AUTH_INVALID_CREDENTIALS: 'AUTH_INVALID_CREDENTIALS',

  // Authorization Errors
  AUTHZ_INSUFFICIENT_PERMISSIONS: 'AUTHZ_INSUFFICIENT_PERMISSIONS',
  AUTHZ_RESOURCE_ACCESS_DENIED: 'AUTHZ_RESOURCE_ACCESS_DENIED',
  AUTHZ_SCOPE_INSUFFICIENT: 'AUTHZ_SCOPE_INSUFFICIENT',

  // Resource Errors
  RESOURCE_NOT_FOUND: 'RESOURCE_NOT_FOUND',
  RESOURCE_CONFLICT: 'RESOURCE_CONFLICT',
  RESOURCE_GONE: 'RESOURCE_GONE',
  RESOURCE_LOCKED: 'RESOURCE_LOCKED',

  // Rate Limiting
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED',

  // Business Logic Errors
  WEATHER_STATION_NOT_FOUND: 'WEATHER_STATION_NOT_FOUND',
  WEATHER_DATA_INVALID: 'WEATHER_DATA_INVALID',
  INSUFFICIENT_BALANCE: 'INSUFFICIENT_BALANCE',
  TRANSACTION_FAILED: 'TRANSACTION_FAILED',

  // System Errors
  DATABASE_CONNECTION_FAILED: 'DATABASE_CONNECTION_FAILED',
  EXTERNAL_SERVICE_UNAVAILABLE: 'EXTERNAL_SERVICE_UNAVAILABLE',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

// ================================
// Export Everything
// ================================

export * from './api-types.js';
export * from './security-types.js';
export {
  type UnifiedAPIRequest,
  type APIResponse,
  type PaginatedAPIResponse,
  type CrossChainTransfer,
  type WeatherSubmission,
  type WeatherSensor,
  type MiningReward,
  type BlockchainStatus,
  type BlockInfo,
  type NetworkAnalytics,
  // RateLimitInfo, SecurityEvent, and RateLimitConfig are intentionally excluded to avoid conflict with security-types/communication-types
  type SecurityStats,
  type HealthStatus,
  type ServiceHealth,
  type DatabaseHealth,
  type BlockchainHealth,
  type PerformanceMetrics,
  type SecurityHealth,
  type ComplianceStatus,
  type Certification,
  type DataProtection,
  type SecurityMiddleware,
  type RateLimitMiddleware,
  type ValidationMiddleware,
  type APIHandler,
  type AsyncAPIHandler,
  type UnifiedAPIConfig,
} from './unified-api-types.js';
