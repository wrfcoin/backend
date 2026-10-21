/**
 * Fallback Handler
 * Provides graceful degradation when primary services fail
 */

import {
  FallbackConfig,
  FallbackResult,
  ServiceUnavailableError,
  ErrorContext,
} from './resilience-types.js';
import { appLogger } from '../../../server/utils/logger.js';

interface CacheEntry<T> {
  data: T;
  timestamp: Date;
  ttl: number;
}

export class FallbackHandler<T = any> {
  private config: FallbackConfig;
  private cache = new Map<string, CacheEntry<T>>();
  private fallbacksActivated = 0;

  constructor(
    private serviceName: string,
    config: Partial<FallbackConfig> = {}
  ) {
    this.config = {
      enabled: true,
      cacheEnabled: true,
      cacheTtl: 300000, // 5 minutes default
      ...config,
    };
  }

  public async execute(
    primaryOperation: () => Promise<T>,
    operationName: string = 'unknown',
    cacheKey?: string
  ): Promise<FallbackResult<T>> {
    const startTime = Date.now();

    if (!this.config.enabled) {
      // If fallback is disabled, just execute primary operation
      try {
        const result = await primaryOperation();
        return {
          success: true,
          data: result,
          source: 'primary',
          responseTime: Date.now() - startTime,
          timestamp: new Date(),
        };
      } catch (error) {
        const context: ErrorContext = {
          serviceName: this.serviceName,
          operation: operationName,
          attempt: 1,
          timestamp: new Date(),
          error: error as Error,
        };
        throw new ServiceUnavailableError(this.serviceName, context);
      }
    }

    // Try primary operation first
    try {
      const result = await primaryOperation();

      // Cache successful result if caching is enabled
      if (this.config.cacheEnabled && cacheKey) {
        this.setCache(cacheKey, result);
      }

      return {
        success: true,
        data: result,
        source: 'primary',
        responseTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    } catch (primaryError) {
      appLogger.warn('Primary operation failed', {
        serviceName: this.serviceName,
        operationName,
        error: (primaryError as Error).message
      });

      // Try fallback mechanisms in order of preference
      const fallbackResult = await this.tryFallbacks(
        operationName,
        cacheKey,
        startTime
      );

      if (fallbackResult.success) {
        this.fallbacksActivated++;
        return fallbackResult;
      }

      // All fallback mechanisms failed
      const context: ErrorContext = {
        serviceName: this.serviceName,
        operation: operationName,
        attempt: 1,
        timestamp: new Date(),
        error: primaryError as Error,
      };

      throw new ServiceUnavailableError(this.serviceName, context);
    }
  }

  private async tryFallbacks(
    operationName: string,
    cacheKey?: string,
    startTime: number = Date.now()
  ): Promise<FallbackResult<T>> {
    // 1. Try cached data first (fastest fallback)
    if (this.config.cacheEnabled && cacheKey) {
      const cachedResult = this.getCache(cacheKey);
      if (cachedResult) {
        appLogger.info('Serving from cache', {
          serviceName: this.serviceName,
          operationName
        });
        return {
          success: true,
          data: cachedResult,
          source: 'cache',
          responseTime: Date.now() - startTime,
          timestamp: new Date(),
        };
      }
    }

    // 2. Try custom fallback function
    if (this.config.fallbackFunction) {
      try {
        appLogger.info('Executing fallback function', {
          serviceName: this.serviceName,
          operationName
        });
        const fallbackResult = await this.config.fallbackFunction();
        return {
          success: true,
          data: fallbackResult,
          source: 'fallback',
          responseTime: Date.now() - startTime,
          timestamp: new Date(),
        };
      } catch (fallbackError) {
        appLogger.warn('Fallback function failed', {
          serviceName: this.serviceName,
          operationName,
          error: (fallbackError as Error).message
        });
      }
    }

    // 3. Return degraded response if available
    if (this.config.degradedResponse !== undefined) {
      appLogger.info('Serving degraded response', {
        serviceName: this.serviceName,
        operationName
      });
      return {
        success: true,
        data: this.config.degradedResponse,
        source: 'degraded',
        responseTime: Date.now() - startTime,
        timestamp: new Date(),
      };
    }

    // No fallback succeeded
    return {
      success: false,
      source: 'primary',
      responseTime: Date.now() - startTime,
      timestamp: new Date(),
    };
  }

  private setCache(key: string, data: T): void {
    const entry: CacheEntry<T> = {
      data,
      timestamp: new Date(),
      ttl: this.config.cacheTtl,
    };

    this.cache.set(key, entry);

    // Clean up expired entries periodically
    if (this.cache.size % 100 === 0) {
      this.cleanExpiredCache();
    }
  }

  private getCache(key: string): T | null {
    const entry = this.cache.get(key);

    if (!entry) {
      return null;
    }

    // Check if cache entry is expired
    const age = Date.now() - entry.timestamp.getTime();
    if (age > entry.ttl) {
      this.cache.delete(key);
      return null;
    }

    return entry.data;
  }

  private cleanExpiredCache(): void {
    const now = Date.now();
    for (const [key, entry] of this.cache.entries()) {
      const age = now - entry.timestamp.getTime();
      if (age > entry.ttl) {
        this.cache.delete(key);
      }
    }
  }

  public clearCache(): void {
    this.cache.clear();
    appLogger.info('Cache cleared', { serviceName: this.serviceName });
  }

  public getCacheSize(): number {
    return this.cache.size;
  }

  public getFallbacksActivated(): number {
    return this.fallbacksActivated;
  }

  public resetMetrics(): void {
    this.fallbacksActivated = 0;
  }

  // Static factory methods for common fallback patterns
  public static withCacheOnly<T>(
    serviceName: string,
    cacheTtl: number = 300000
  ): FallbackHandler<T> {
    return new FallbackHandler<T>(serviceName, {
      enabled: true,
      cacheEnabled: true,
      cacheTtl,
      fallbackFunction: undefined,
      degradedResponse: undefined,
    });
  }

  public static withDegradedResponse<T>(
    serviceName: string,
    degradedResponse: T,
    cacheTtl: number = 300000
  ): FallbackHandler<T> {
    return new FallbackHandler<T>(serviceName, {
      enabled: true,
      cacheEnabled: true,
      cacheTtl,
      degradedResponse,
    });
  }

  public static withCustomFallback<T>(
    serviceName: string,
    fallbackFunction: () => Promise<T>,
    cacheTtl: number = 300000
  ): FallbackHandler<T> {
    return new FallbackHandler<T>(serviceName, {
      enabled: true,
      cacheEnabled: true,
      cacheTtl,
      fallbackFunction,
    });
  }

  // Helper method for API responses with degraded data
  public static createDegradedApiResponse(
    message: string,
    data: any = null
  ): any {
    return {
      success: true,
      degraded: true,
      message,
      data,
      timestamp: new Date().toISOString(),
    };
  }

  // Helper method for empty/default responses
  public static createEmptyResponse<T>(defaultValue: T): T {
    return defaultValue;
  }
}
