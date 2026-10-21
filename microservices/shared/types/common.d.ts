/**
 * Common types shared across all microservices
 */
export interface BaseApiResponse<T = unknown> {
  success: boolean;
  timestamp: string;
  data?: T;
  meta?: Record<string, string | number | boolean>;
}
export interface ApiError {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}
export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}
export interface PaginatedResponse<T> {
  data: T[];
  pagination: PaginationMeta;
}
/**
 * Service health status interface
 */
export interface ServiceHealth {
  name: string;
  url: string;
  healthy: boolean;
  lastCheck?: string;
  responseTime?: number;
}
/**
 * Inter-service authentication
 */
export interface ServiceAuthHeaders {
  'x-service-token': string;
  'x-service-name': string;
  'x-service-id': string;
}
/**
 * User authentication types
 */
export interface AuthenticatedUser {
  id: string;
  address: string;
  role: string;
  permissions: string[];
}
export interface JWTPayload {
  id: string;
  address: string;
  role: string;
  permissions?: string[];
  iat?: number;
  exp?: number;
}
/**
 * Common error codes used across services
 */
export declare enum ErrorCodes {
  MISSING_TOKEN = 'MISSING_TOKEN',
  INVALID_TOKEN = 'INVALID_TOKEN',
  INVALID_TOKEN_PAYLOAD = 'INVALID_TOKEN_PAYLOAD',
  AUTHENTICATION_REQUIRED = 'AUTHENTICATION_REQUIRED',
  INSUFFICIENT_PERMISSIONS = 'INSUFFICIENT_PERMISSIONS',
  SERVICE_UNAVAILABLE = 'SERVICE_UNAVAILABLE',
  SERVICE_AUTH_ERROR = 'SERVICE_AUTH_ERROR',
  INVALID_SERVICE_TOKEN = 'INVALID_SERVICE_TOKEN',
  MISSING_SERVICE_INFO = 'MISSING_SERVICE_INFO',
  NOT_FOUND = 'NOT_FOUND',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  BAD_REQUEST = 'BAD_REQUEST',
  RESOURCE_NOT_FOUND = 'RESOURCE_NOT_FOUND',
  DUPLICATE_RESOURCE = 'DUPLICATE_RESOURCE',
  OPERATION_FAILED = 'OPERATION_FAILED',
}
/**
 * Service discovery types
 */
export interface ServiceConfig {
  name: string;
  url: string;
  healthPath: string;
  timeout: number;
  retries?: number;
  circuitBreaker?: {
    threshold: number;
    timeout: number;
    resetTimeout: number;
  };
}
export type ServiceRegistry = Record<string, ServiceConfig>;
/**
 * Rate limiting configuration
 */
export interface RateLimitConfig {
  windowMs: number;
  max: number;
  message?: string;
  standardHeaders?: boolean;
  legacyHeaders?: boolean;
}
/**
 * Microservice base configuration
 */
export interface MicroserviceConfig {
  name: string;
  port: number;
  environment: 'development' | 'staging' | 'production';
  logging: {
    level: 'debug' | 'info' | 'warn' | 'error';
    format: 'json' | 'text';
  };
  security: {
    cors: {
      origins: string[];
      credentials: boolean;
    };
    rateLimit: RateLimitConfig;
  };
  database?: {
    url: string;
    maxConnections: number;
    timeout: number;
  };
}
//# sourceMappingURL=common.d.ts.map
