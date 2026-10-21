/**
 * Resilience Manager
 * Unified interface combining circuit breaker, retry logic, fallback mechanisms, and health monitoring
 */

import { CircuitBreaker } from './circuit-breaker.js';
import { RetryManager } from './retry-manager.js';
import { FallbackHandler } from './fallback-handler.js';
import { HealthMonitor } from './health-monitor.js';
import {
  ResilienceConfig,
  ResilienceMetrics,
  FallbackResult,
  CircuitOpenError,
  MaxRetriesExceededError,
  ServiceUnavailableError,
} from './resilience-types.js';
import { appLogger } from '../../../server/utils/logger.js';

export class ResilienceManager<T = any> {
  private circuitBreaker: CircuitBreaker;
  private retryManager: RetryManager;
  private fallbackHandler: FallbackHandler<T>;
  private healthMonitor?: HealthMonitor;
  private totalOperations = 0;
  private successfulOperations = 0;

  constructor(private config: ResilienceConfig) {
    this.circuitBreaker = new CircuitBreaker(
      config.serviceName,
      config.circuitBreaker
    );
    this.retryManager = new RetryManager(config.serviceName, config.retry);
    this.fallbackHandler = new FallbackHandler<T>(
      config.serviceName,
      config.fallback
    );

    // Initialize health monitor if URL is provided
    if (config.healthCheck && this.hasValidUrl(config.serviceName)) {
      this.healthMonitor = new HealthMonitor(
        config.serviceName,
        this.extractBaseUrl(config.serviceName),
        config.healthCheck
      );
      this.healthMonitor.startMonitoring();
    }
  }

  /**
   * Execute an operation with full resilience patterns
   */
  public async execute(
    operation: () => Promise<T>,
    operationName: string = 'unknown',
    options: {
      cacheKey?: string;
      skipCircuitBreaker?: boolean;
      skipRetry?: boolean;
      skipFallback?: boolean;
    } = {}
  ): Promise<FallbackResult<T>> {
    this.totalOperations++;
    const startTime = Date.now();

    try {
      let result: T;

      if (options.skipCircuitBreaker) {
        // Skip circuit breaker, but still use retry logic
        if (options.skipRetry) {
          result = await operation();
        } else {
          result = await this.retryManager.execute(operation, operationName);
        }
      } else {
        // Use circuit breaker with retry logic
        const operationWithRetry = options.skipRetry
          ? operation
          : () => this.retryManager.execute(operation, operationName);

        result = await this.circuitBreaker.execute(
          operationWithRetry,
          operationName
        );
      }

      // Success - cache result if fallback handler supports it
      if (this.config.fallback.cacheEnabled && options.cacheKey) {
        await this.fallbackHandler.execute(
          async () => result,
          operationName,
          options.cacheKey
        );
      }

      this.successfulOperations++;

      return {
        success: true,
        data: result,
        source: 'primary',
        responseTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    } catch (error) {
      // Primary operation failed - try fallback if not skipped
      if (options.skipFallback) {
        throw error;
      }

      appLogger.warn('Operation failed, attempting fallback', {
        serviceName: this.config.serviceName,
        operationName,
        error: (error as Error).message
      });

      try {
        return await this.fallbackHandler.execute(
          operation,
          operationName,
          options.cacheKey
        );
      } catch (fallbackError) {
        // Even fallback failed - throw original error with context
        throw error;
      }
    }
  }

  /**
   * Execute operation with circuit breaker only
   */
  public async executeWithCircuitBreaker(
    operation: () => Promise<T>,
    operationName: string = 'unknown'
  ): Promise<T> {
    return await this.circuitBreaker.execute(operation, operationName);
  }

  /**
   * Execute operation with retry logic only
   */
  public async executeWithRetry(
    operation: () => Promise<T>,
    operationName: string = 'unknown'
  ): Promise<T> {
    return await this.retryManager.execute(operation, operationName);
  }

  /**
   * Execute operation with fallback only
   */
  public async executeWithFallback(
    operation: () => Promise<T>,
    operationName: string = 'unknown',
    cacheKey?: string
  ): Promise<FallbackResult<T>> {
    return await this.fallbackHandler.execute(
      operation,
      operationName,
      cacheKey
    );
  }

  /**
   * Get comprehensive resilience metrics
   */
  public getMetrics(): ResilienceMetrics {
    const circuitMetrics = this.circuitBreaker.getMetrics();
    const healthStatus = this.healthMonitor?.getHealthStatus() || {
      name: this.config.serviceName,
      url: 'unknown',
      healthy: true,
      consecutiveFailures: 0,
    };

    const retryAttempts = this.retryManager.getAttempts();

    return {
      serviceName: this.config.serviceName,
      circuit: circuitMetrics,
      health: healthStatus,
      retryAttempts,
      fallbacksActivated: this.fallbackHandler.getFallbacksActivated(),
      lastUpdated: new Date(),
    };
  }

  /**
   * Get current service health status
   */
  public async getHealthStatus(): Promise<boolean> {
    if (this.healthMonitor) {
      const status = await this.healthMonitor.performImmediateCheck();
      return status.healthy;
    }

    // If no health monitor, check circuit breaker state
    return this.circuitBreaker.isHealthy();
  }

  /**
   * Get success rate over all operations
   */
  public getSuccessRate(): number {
    if (this.totalOperations === 0) return 100;
    return (this.successfulOperations / this.totalOperations) * 100;
  }

  /**
   * Reset all metrics and state
   */
  public reset(): void {
    this.circuitBreaker.reset();
    this.retryManager.reset();
    this.fallbackHandler.resetMetrics();
    this.fallbackHandler.clearCache();
    this.healthMonitor?.reset();
    this.totalOperations = 0;
    this.successfulOperations = 0;

    appLogger.info('Resilience manager reset', { serviceName: this.config.serviceName });
  }

  /**
   * Shutdown and cleanup
   */
  public shutdown(): void {
    this.healthMonitor?.stopMonitoring();
    appLogger.info('Resilience manager shutdown', { serviceName: this.config.serviceName });
  }

  /**
   * Manually trigger circuit breaker open (for testing)
   */
  public openCircuit(): void {
    this.circuitBreaker.forceOpen();
  }

  /**
   * Manually trigger circuit breaker close (for testing)
   */
  public closeCircuit(): void {
    this.circuitBreaker.forceClose();
  }

  /**
   * Check if circuit is currently open
   */
  public isCircuitOpen(): boolean {
    return !this.circuitBreaker.isHealthy();
  }

  private hasValidUrl(serviceName: string): boolean {
    // Simple check if serviceName looks like a URL
    return (
      serviceName.includes('://') ||
      serviceName.includes('localhost') ||
      serviceName.includes('.')
    );
  }

  private extractBaseUrl(serviceName: string): string {
    // Extract base URL from service name/config
    if (serviceName.includes('://')) {
      return serviceName;
    }
    return `http://${serviceName}`;
  }

  // Static factory methods for common patterns
  public static forHttpService<T>(
    serviceName: string,
    baseUrl: string,
    options: Partial<ResilienceConfig> = {}
  ): ResilienceManager<T> {
    const defaultConfig: ResilienceConfig = {
      serviceName,
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
        retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND'],
      },
      fallback: {
        enabled: true,
        cacheEnabled: true,
        cacheTtl: 300000,
      },
      healthCheck: {
        interval: 30000,
        timeout: 5000,
        path: '/health',
        expectedStatusCode: 200,
        expectedResponseTime: 2000,
      },
    };

    const config = { ...defaultConfig, ...options };
    return new ResilienceManager<T>(config);
  }

  public static forDatabaseService<T>(
    serviceName: string,
    options: Partial<ResilienceConfig> = {}
  ): ResilienceManager<T> {
    const defaultConfig: ResilienceConfig = {
      serviceName,
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
        retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT', 'DEADLOCK_DETECTED'],
      },
      fallback: {
        enabled: true,
        cacheEnabled: true,
        cacheTtl: 600000, // 10 minutes for DB data
      },
      healthCheck: {
        interval: 60000,
        timeout: 10000,
        path: '',
        expectedStatusCode: 200,
        expectedResponseTime: 5000,
      },
    };

    const config = { ...defaultConfig, ...options };
    return new ResilienceManager<T>(config);
  }

  public static forExternalApi<T>(
    serviceName: string,
    baseUrl: string,
    options: Partial<ResilienceConfig> = {}
  ): ResilienceManager<T> {
    const defaultConfig: ResilienceConfig = {
      serviceName,
      circuitBreaker: {
        threshold: 3,
        timeout: 20000,
        resetTimeout: 300000, // 5 minutes
        monitoringWindow: 120000,
        volumeThreshold: 5,
        errorThreshold: 70,
      },
      retry: {
        maxAttempts: 2, // Less aggressive for external APIs
        baseDelay: 2000,
        maxDelay: 30000,
        backoffMultiplier: 3,
        jitter: true,
        retryableErrors: ['ECONNREFUSED', 'ETIMEDOUT', 'SERVICE_UNAVAILABLE'],
      },
      fallback: {
        enabled: true,
        cacheEnabled: true,
        cacheTtl: 1800000, // 30 minutes for external data
      },
      healthCheck: {
        interval: 120000, // 2 minutes
        timeout: 15000,
        path: '/status',
        expectedStatusCode: 200,
        expectedResponseTime: 10000,
      },
    };

    const config = { ...defaultConfig, ...options };
    return new ResilienceManager<T>(config);
  }
}
