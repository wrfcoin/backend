/**
 * Resilience Engineering Types
 * Comprehensive type definitions for error handling, circuit breakers, retries, and fallback mechanisms
 */

export interface CircuitBreakerConfig {
  threshold: number; // Number of failures before opening circuit
  timeout: number; // Timeout for requests in ms
  resetTimeout: number; // Time to wait before attempting to close circuit
  monitoringWindow: number; // Time window for counting failures
  volumeThreshold: number; // Minimum number of requests before circuit can open
  errorThreshold: number; // Percentage of errors that triggers circuit open
}

export interface RetryConfig {
  maxAttempts: number;
  baseDelay: number; // Initial delay in ms
  maxDelay: number; // Maximum delay between retries
  backoffMultiplier: number; // Exponential backoff multiplier
  jitter: boolean; // Add randomness to prevent thundering herd
  retryableErrors: string[]; // Error codes/types that should trigger retry
}

export interface FallbackConfig {
  enabled: boolean;
  fallbackFunction?: () => Promise<any>;
  cacheEnabled: boolean;
  cacheTtl: number; // Cache TTL in ms
  degradedResponse?: any; // Static fallback response
}

export interface HealthCheckConfig {
  interval: number; // Health check interval in ms
  timeout: number; // Health check timeout in ms
  path: string; // Health check endpoint path
  expectedStatusCode: number;
  expectedResponseTime: number; // Max acceptable response time
}

export interface ResilienceConfig {
  serviceName: string;
  circuitBreaker: CircuitBreakerConfig;
  retry: RetryConfig;
  fallback: FallbackConfig;
  healthCheck: HealthCheckConfig;
}

export enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN',
}

export interface CircuitMetrics {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  totalRequests: number;
  errorRate: number;
  avgResponseTime: number;
  lastFailureTime?: Date;
  lastSuccessTime?: Date;
}

export interface RetryAttempt {
  attempt: number;
  delay: number;
  error?: Error;
  timestamp: Date;
}

export interface ServiceHealthStatus {
  name: string;
  url: string;
  healthy: boolean;
  responseTime?: number;
  lastCheck?: Date;
  consecutiveFailures: number;
}

export interface ResilienceMetrics {
  serviceName: string;
  circuit: CircuitMetrics;
  health: ServiceHealthStatus;
  retryAttempts: RetryAttempt[];
  fallbacksActivated: number;
  lastUpdated: Date;
}

export interface ErrorContext {
  serviceName: string;
  operation: string;
  attempt: number;
  timestamp: Date;
  error: Error;
  requestId?: string;
}

export interface FallbackResult<T = any> {
  success: boolean;
  data?: T;
  source: 'primary' | 'cache' | 'fallback' | 'degraded';
  responseTime: number;
  timestamp: Date;
}

export class ResilienceError extends Error {
  public readonly code: string;
  public readonly context: ErrorContext;
  public readonly retryable: boolean;

  constructor(
    message: string,
    code: string,
    context: ErrorContext,
    retryable = false
  ) {
    super(message);
    this.name = 'ResilienceError';
    this.code = code;
    this.context = context;
    this.retryable = retryable;
  }
}

export class CircuitOpenError extends ResilienceError {
  constructor(serviceName: string, context: ErrorContext) {
    super(
      `Circuit breaker is OPEN for service: ${serviceName}`,
      'CIRCUIT_OPEN',
      context,
      false
    );
    this.name = 'CircuitOpenError';
  }
}

export class MaxRetriesExceededError extends ResilienceError {
  constructor(serviceName: string, maxAttempts: number, context: ErrorContext) {
    super(
      `Max retries (${maxAttempts}) exceeded for service: ${serviceName}`,
      'MAX_RETRIES_EXCEEDED',
      context,
      false
    );
    this.name = 'MaxRetriesExceededError';
  }
}

export class ServiceUnavailableError extends ResilienceError {
  constructor(serviceName: string, context: ErrorContext) {
    super(
      `Service unavailable: ${serviceName}`,
      'SERVICE_UNAVAILABLE',
      context,
      true
    );
    this.name = 'ServiceUnavailableError';
  }
}
