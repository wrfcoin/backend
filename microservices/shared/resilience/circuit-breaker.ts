/**
 * Circuit Breaker Implementation
 * Prevents cascade failures by stopping requests to failing services
 */

import {
  CircuitBreakerConfig,
  CircuitState,
  CircuitMetrics,
  CircuitOpenError,
  ErrorContext,
  ResilienceError,
} from './resilience-types.js';
import { appLogger } from '../../../server/utils/logger.js';

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private totalRequests: number = 0;
  private lastFailureTime?: Date;
  private lastSuccessTime?: Date;
  private nextAttemptTime?: Date;
  private requestTimes: number[] = [];

  constructor(
    private serviceName: string,
    config: Partial<CircuitBreakerConfig> = {}
  ) {
    this.config = {
      threshold: 5,
      timeout: 10000,
      resetTimeout: 60000,
      monitoringWindow: 60000,
      volumeThreshold: 10,
      errorThreshold: 50,
      ...config,
    };
  }

  public async execute<T>(
    operation: () => Promise<T>,
    operationName: string = 'unknown'
  ): Promise<T> {
    const startTime = Date.now();
    this.totalRequests++;

    // Check if circuit is open
    if (this.state === CircuitState.OPEN) {
      if (this.shouldAttemptReset()) {
        this.state = CircuitState.HALF_OPEN;
        appLogger.info('Circuit breaker moving to HALF_OPEN', { serviceName: this.serviceName });
      } else {
        const context: ErrorContext = {
          serviceName: this.serviceName,
          operation: operationName,
          attempt: 1,
          timestamp: new Date(),
          error: new Error('Circuit breaker is OPEN'),
        };
        throw new CircuitOpenError(this.serviceName, context);
      }
    }

    try {
      // Create a timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(
            new Error(`Operation timed out after ${this.config.timeout}ms`)
          );
        }, this.config.timeout);
      });

      // Race between operation and timeout
      const result = await Promise.race([operation(), timeoutPromise]);

      this.onSuccess(Date.now() - startTime);
      return result;
    } catch (error) {
      this.onFailure(error as Error, Date.now() - startTime);

      const context: ErrorContext = {
        serviceName: this.serviceName,
        operation: operationName,
        attempt: 1,
        timestamp: new Date(),
        error: error as Error,
      };

      throw new ResilienceError(
        `Circuit breaker failure for ${this.serviceName}: ${(error as Error).message}`,
        'CIRCUIT_BREAKER_FAILURE',
        context,
        this.isRetryableError(error as Error)
      );
    }
  }

  private onSuccess(responseTime: number): void {
    this.successCount++;
    this.lastSuccessTime = new Date();
    this.requestTimes.push(responseTime);
    this.trimRequestTimes();

    if (this.state === CircuitState.HALF_OPEN) {
      appLogger.info('Circuit breaker closing after successful request', { serviceName: this.serviceName });
      this.state = CircuitState.CLOSED;
      this.resetCounts();
    }
  }

  private onFailure(error: Error, responseTime: number): void {
    this.failureCount++;
    this.lastFailureTime = new Date();
    this.requestTimes.push(responseTime);
    this.trimRequestTimes();

    // If we're in half-open state, any failure opens the circuit
    if (this.state === CircuitState.HALF_OPEN) {
      this.openCircuit();
      return;
    }

    // Check if we should open the circuit
    if (this.shouldOpenCircuit()) {
      this.openCircuit();
    }
  }

  private shouldOpenCircuit(): boolean {
    // Need minimum volume of requests
    if (this.totalRequests < this.config.volumeThreshold) {
      return false;
    }

    // Check failure threshold
    const errorRate = (this.failureCount / this.totalRequests) * 100;
    return (
      errorRate >= this.config.errorThreshold &&
      this.failureCount >= this.config.threshold
    );
  }

  private openCircuit(): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = new Date(Date.now() + this.config.resetTimeout);
    appLogger.warn('Circuit breaker OPENED', {
      serviceName: this.serviceName,
      nextAttemptTime: this.nextAttemptTime
    });
  }

  private shouldAttemptReset(): boolean {
    return this.nextAttemptTime
      ? Date.now() >= this.nextAttemptTime.getTime()
      : false;
  }

  private resetCounts(): void {
    this.failureCount = 0;
    this.successCount = 0;
    this.totalRequests = 0;
    this.requestTimes = [];
  }

  private trimRequestTimes(): void {
    const cutoff = Date.now() - this.config.monitoringWindow;
    // In a real implementation, we'd need to store timestamps with response times
    // For simplicity, we'll just keep the last 100 requests
    if (this.requestTimes.length > 100) {
      this.requestTimes = this.requestTimes.slice(-100);
    }
  }

  private isRetryableError(error: Error): boolean {
    // Network errors, timeouts, and 5xx status codes are typically retryable
    const retryablePatterns = [
      'ECONNREFUSED',
      'ENOTFOUND',
      'ETIMEDOUT',
      'ECONNRESET',
      'timeout',
      'network',
      '5', // 5xx status codes
    ];

    const errorMessage = error.message.toLowerCase();
    return retryablePatterns.some(pattern => errorMessage.includes(pattern));
  }

  public getMetrics(): CircuitMetrics {
    const avgResponseTime =
      this.requestTimes.length > 0
        ? this.requestTimes.reduce((sum, time) => sum + time, 0) /
          this.requestTimes.length
        : 0;

    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalRequests: this.totalRequests,
      errorRate:
        this.totalRequests > 0
          ? (this.failureCount / this.totalRequests) * 100
          : 0,
      avgResponseTime,
      lastFailureTime: this.lastFailureTime,
      lastSuccessTime: this.lastSuccessTime,
    };
  }

  public getState(): CircuitState {
    return this.state;
  }

  public isHealthy(): boolean {
    return this.state !== CircuitState.OPEN;
  }

  public reset(): void {
    this.state = CircuitState.CLOSED;
    this.resetCounts();
    this.nextAttemptTime = undefined;
    appLogger.info('Circuit breaker manually reset', { serviceName: this.serviceName });
  }

  // Manual controls for testing
  public forceOpen(): void {
    this.state = CircuitState.OPEN;
    this.nextAttemptTime = new Date(Date.now() + this.config.resetTimeout);
    appLogger.info('Circuit breaker manually opened', { serviceName: this.serviceName });
  }

  public forceClose(): void {
    this.state = CircuitState.CLOSED;
    this.resetCounts();
    this.nextAttemptTime = undefined;
    appLogger.info('Circuit breaker manually closed', { serviceName: this.serviceName });
  }
}
