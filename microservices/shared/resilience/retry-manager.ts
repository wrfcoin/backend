/**
 * Retry Manager with Exponential Backoff
 * Implements intelligent retry logic with jitter to prevent thundering herd
 */

import {
  RetryConfig,
  RetryAttempt,
  MaxRetriesExceededError,
  ErrorContext,
  ResilienceError,
} from './resilience-types.js';
import { appLogger } from '../../../server/utils/logger.js';

export class RetryManager {
  private config: RetryConfig;
  private attempts: RetryAttempt[] = [];

  constructor(
    private serviceName: string,
    config: Partial<RetryConfig> = {}
  ) {
    this.config = {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 30000,
      backoffMultiplier: 2,
      jitter: true,
      retryableErrors: [
        'ECONNREFUSED',
        'ENOTFOUND',
        'ETIMEDOUT',
        'ECONNRESET',
        'EPROTO',
        'NETWORK_ERROR',
        'SERVICE_UNAVAILABLE',
        'TIMEOUT_ERROR',
        'CIRCUIT_BREAKER_FAILURE', // Allow retries after circuit breaker failures
      ],
      ...config,
    };
  }

  public async execute<T>(
    operation: () => Promise<T>,
    operationName: string = 'unknown'
  ): Promise<T> {
    let lastError: Error;
    this.attempts = [];

    for (let attempt = 1; attempt <= this.config.maxAttempts; attempt++) {
      const attemptStart = new Date();

      try {
        const result = await operation();

        // Log successful attempt if there were previous failures
        if (attempt > 1) {
          appLogger.info('Operation succeeded after retries', {
            serviceName: this.serviceName,
            operationName,
            attempt,
            maxAttempts: this.config.maxAttempts
          });
        }

        return result;
      } catch (error) {
        lastError = error as Error;

        const retryAttempt: RetryAttempt = {
          attempt,
          delay: 0, // Will be set below
          error: lastError,
          timestamp: attemptStart,
        };

        this.attempts.push(retryAttempt);

        // Check if this error is retryable
        if (!this.isRetryableError(lastError)) {
          appLogger.warn('Operation failed with non-retryable error', {
            serviceName: this.serviceName,
            operationName,
            error: lastError.message
          });
          throw lastError;
        }

        // If this was the last attempt, don't wait
        if (attempt >= this.config.maxAttempts) {
          break;
        }

        // Calculate delay for next attempt
        const delay = this.calculateDelay(attempt);
        retryAttempt.delay = delay;

        appLogger.warn('Operation attempt failed, retrying', {
          serviceName: this.serviceName,
          operationName,
          attempt,
          maxAttempts: this.config.maxAttempts,
          retryDelay: delay,
          error: lastError.message
        });

        // Wait before next attempt
        await this.sleep(delay);
      }
    }

    // All retries exhausted
    const context: ErrorContext = {
      serviceName: this.serviceName,
      operation: operationName,
      attempt: this.config.maxAttempts,
      timestamp: new Date(),
      error: lastError!,
    };

    throw new MaxRetriesExceededError(
      this.serviceName,
      this.config.maxAttempts,
      context
    );
  }

  private calculateDelay(attempt: number): number {
    // Exponential backoff: baseDelay * (backoffMultiplier ^ (attempt - 1))
    let delay =
      this.config.baseDelay *
      Math.pow(this.config.backoffMultiplier, attempt - 1);

    // Cap at maxDelay
    delay = Math.min(delay, this.config.maxDelay);

    // Add jitter to prevent thundering herd
    if (this.config.jitter) {
      // Add random jitter up to 25% of the delay
      const jitterRange = delay * 0.25;
      const jitter = Math.random() * jitterRange;
      delay += jitter;
    }

    return Math.floor(delay);
  }

  private isRetryableError(error: Error): boolean {
    const errorMessage = error.message;
    const errorName = error.name;

    // Check if error type/name is in retryable list
    if (this.config.retryableErrors.includes(errorName)) {
      return true;
    }

    // Check if error message contains retryable patterns
    return this.config.retryableErrors.some(pattern => {
      return errorMessage.toLowerCase().includes(pattern.toLowerCase());
    });
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  public getAttempts(): RetryAttempt[] {
    return [...this.attempts];
  }

  public getLastAttempt(): RetryAttempt | null {
    return this.attempts.length > 0
      ? this.attempts[this.attempts.length - 1]
      : null;
  }

  public reset(): void {
    this.attempts = [];
  }

  // Helper method to determine if we should retry based on HTTP status codes
  public static isRetryableHttpStatus(statusCode: number): boolean {
    // Retry on server errors (5xx) and specific client errors
    const retryableStatusCodes = [
      408, // Request Timeout
      429, // Too Many Requests
      500, // Internal Server Error
      502, // Bad Gateway
      503, // Service Unavailable
      504, // Gateway Timeout
      520, // Unknown Error (Cloudflare)
      521, // Web Server Is Down (Cloudflare)
      522, // Connection Timed Out (Cloudflare)
      523, // Origin Is Unreachable (Cloudflare)
      524, // A Timeout Occurred (Cloudflare)
    ];

    return retryableStatusCodes.includes(statusCode);
  }

  // Factory method to create retry manager with HTTP-specific configuration
  public static forHttpCalls(
    serviceName: string,
    config: Partial<RetryConfig> = {}
  ): RetryManager {
    const httpConfig: Partial<RetryConfig> = {
      maxAttempts: 3,
      baseDelay: 1000,
      maxDelay: 10000,
      backoffMultiplier: 2,
      jitter: true,
      retryableErrors: [
        'ECONNREFUSED',
        'ENOTFOUND',
        'ETIMEDOUT',
        'ECONNRESET',
        'REQUEST_TIMEOUT',
        'TOO_MANY_REQUESTS',
        'INTERNAL_SERVER_ERROR',
        'BAD_GATEWAY',
        'SERVICE_UNAVAILABLE',
        'GATEWAY_TIMEOUT',
        'CIRCUIT_BREAKER_FAILURE',
      ],
      ...config,
    };

    return new RetryManager(serviceName, httpConfig);
  }

  // Factory method for database operations
  public static forDatabase(
    serviceName: string,
    config: Partial<RetryConfig> = {}
  ): RetryManager {
    const dbConfig: Partial<RetryConfig> = {
      maxAttempts: 5,
      baseDelay: 500,
      maxDelay: 5000,
      backoffMultiplier: 1.5,
      jitter: true,
      retryableErrors: [
        'ECONNREFUSED',
        'ENOTFOUND',
        'ETIMEDOUT',
        'ECONNRESET',
        'CONNECTION_ERROR',
        'DATABASE_UNAVAILABLE',
        'DEADLOCK_DETECTED',
        'LOCK_TIMEOUT',
      ],
      ...config,
    };

    return new RetryManager(serviceName, dbConfig);
  }
}
