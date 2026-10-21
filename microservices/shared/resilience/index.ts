/**
 * Resilience Engineering Framework
 * Comprehensive error handling, circuit breakers, retries, and fallback mechanisms
 */

// Core Components
export { CircuitBreaker } from './circuit-breaker.js';
export { RetryManager } from './retry-manager.js';
export { FallbackHandler } from './fallback-handler.js';
export { HealthMonitor, HealthMonitorRegistry } from './health-monitor.js';
export { ResilienceManager } from './resilience-manager.js';

// Express Middleware
export {
  setupResilienceMiddleware,
  healthCheckMiddleware,
  metricsMiddleware,
  resilienceErrorHandler,
} from './express-middleware.js';

// Import for use in utility functions
import { ResilienceManager } from './resilience-manager.js';

// Types and Interfaces (import first, then export)
import {
  ResilienceConfig,
  ResilienceMetrics,
  CircuitBreakerConfig,
  RetryConfig,
  FallbackConfig,
  HealthCheckConfig,
  CircuitState,
  CircuitMetrics,
  RetryAttempt,
  ServiceHealthStatus,
  ErrorContext,
  FallbackResult,
  ResilienceError,
  CircuitOpenError,
  MaxRetriesExceededError,
  ServiceUnavailableError,
} from './resilience-types.js';
export * from './resilience-types.js';

// Convenience Re-exports
export {
  CircuitBreakerConfig,
  RetryConfig,
  FallbackConfig,
  HealthCheckConfig,
  ResilienceConfig,
  CircuitState,
  CircuitMetrics,
  RetryAttempt,
  ServiceHealthStatus,
  ResilienceMetrics,
  ErrorContext,
  FallbackResult,
  ResilienceError,
  CircuitOpenError,
  MaxRetriesExceededError,
  ServiceUnavailableError,
} from './resilience-types.js';

// Default configurations for common scenarios
export const DEFAULT_CONFIGS = {
  HTTP_SERVICE: {
    circuitBreaker: {
      threshold: 5,
      timeout: 10000,
      resetTimeout: 60000,
      monitoringWindow: 60000,
      volumeThreshold: 10,
      errorThreshold: 50,
    },
    retry: {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffMultiplier: 2,
      jitter: true,
      retryableErrors: [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ENOTFOUND',
        'SERVICE_UNAVAILABLE',
      ],
    },
    fallback: {
      enabled: true,
      cacheEnabled: true,
      cacheTtl: 300000, // 5 minutes
    },
    healthCheck: {
      interval: 30000,
      timeout: 5000,
      path: '/health',
      expectedStatusCode: 200,
      expectedResponseTime: 2000,
    },
  },

  DATABASE_SERVICE: {
    circuitBreaker: {
      threshold: 3,
      timeout: 15000,
      resetTimeout: 120000,
      monitoringWindow: 60000,
      volumeThreshold: 5,
      errorThreshold: 60,
    },
    retry: {
      maxAttempts: 5,
      baseDelay: 500,
      maxDelay: 5000,
      backoffMultiplier: 1.5,
      jitter: true,
      retryableErrors: [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'DEADLOCK_DETECTED',
        'CONNECTION_ERROR',
      ],
    },
    fallback: {
      enabled: true,
      cacheEnabled: true,
      cacheTtl: 600000, // 10 minutes
    },
    healthCheck: {
      interval: 60000,
      timeout: 10000,
      path: '',
      expectedStatusCode: 200,
      expectedResponseTime: 5000,
    },
  },

  EXTERNAL_API: {
    circuitBreaker: {
      threshold: 3,
      timeout: 20000,
      resetTimeout: 300000, // 5 minutes
      monitoringWindow: 120000,
      volumeThreshold: 5,
      errorThreshold: 70,
    },
    retry: {
      maxAttempts: 2,
      baseDelay: 2000,
      maxDelay: 30000,
      backoffMultiplier: 3,
      jitter: true,
      retryableErrors: [
        'ECONNREFUSED',
        'ETIMEDOUT',
        'SERVICE_UNAVAILABLE',
        'RATE_LIMITED',
      ],
    },
    fallback: {
      enabled: true,
      cacheEnabled: true,
      cacheTtl: 1800000, // 30 minutes
    },
    healthCheck: {
      interval: 120000, // 2 minutes
      timeout: 15000,
      path: '/status',
      expectedStatusCode: 200,
      expectedResponseTime: 10000,
    },
  },
} as const;

// Utility Functions
export function createResilienceManager<T>(
  serviceName: string,
  type: 'http' | 'database' | 'external',
  baseUrl?: string,
  overrides: Partial<ResilienceConfig> = {}
): ResilienceManager<T> {
  switch (type) {
    case 'http':
      return ResilienceManager.forHttpService<T>(
        serviceName,
        baseUrl || '',
        overrides
      );
    case 'database':
      return ResilienceManager.forDatabaseService<T>(serviceName, overrides);
    case 'external':
      return ResilienceManager.forExternalApi<T>(
        serviceName,
        baseUrl || '',
        overrides
      );
    default:
      throw new Error(`Unknown resilience manager type: ${type}`);
  }
}

// Quick setup functions
export function setupHttpResilience<T>(
  serviceName: string,
  baseUrl: string
): ResilienceManager<T> {
  return ResilienceManager.forHttpService<T>(serviceName, baseUrl);
}

export function setupDatabaseResilience<T>(
  serviceName: string
): ResilienceManager<T> {
  return ResilienceManager.forDatabaseService<T>(serviceName);
}

export function setupExternalApiResilience<T>(
  serviceName: string,
  baseUrl: string
): ResilienceManager<T> {
  return ResilienceManager.forExternalApi<T>(serviceName, baseUrl);
}

// Global registry for managing all resilience managers
class GlobalResilienceRegistry {
  private static instance: GlobalResilienceRegistry;
  private managers = new Map<string, ResilienceManager>();

  private constructor() {}

  public static getInstance(): GlobalResilienceRegistry {
    if (!GlobalResilienceRegistry.instance) {
      GlobalResilienceRegistry.instance = new GlobalResilienceRegistry();
    }
    return GlobalResilienceRegistry.instance;
  }

  public register<T>(serviceName: string, manager: ResilienceManager<T>): void {
    this.managers.set(serviceName, manager as ResilienceManager<any>);
  }

  public get<T>(serviceName: string): ResilienceManager<T> | undefined {
    return this.managers.get(serviceName) as ResilienceManager<T>;
  }

  public getAll(): Map<string, ResilienceManager> {
    return new Map(this.managers);
  }

  public getAllMetrics(): Record<string, ResilienceMetrics> {
    const metrics: Record<string, ResilienceMetrics> = {};

    for (const [serviceName, manager] of this.managers) {
      metrics[serviceName] = manager.getMetrics();
    }

    return metrics;
  }

  public shutdown(): void {
    for (const [serviceName, manager] of this.managers) {
      manager.shutdown();
    }
    this.managers.clear();
  }

  public reset(): void {
    for (const [serviceName, manager] of this.managers) {
      manager.reset();
    }
  }
}

export const resilience = GlobalResilienceRegistry.getInstance();
