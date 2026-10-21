/**
 * Resilience-Enhanced Database Service
 * Wraps database operations with circuit breakers, retries, and fallbacks
 */

import { DatabaseService } from './database.js';
import {
  ResilienceManager,
  resilience,
  FallbackResult,
} from '../../../shared/resilience.js';
import { appLogger } from '../../../../server/utils/logger.js';

export class ResilientDatabaseService {
  private static instance: ResilientDatabaseService;
  private databaseService: DatabaseService;
  private resilienceManager: ResilienceManager;

  private constructor() {
    this.databaseService = DatabaseService.getInstance();

    // Get or create resilience manager for database operations
    this.resilienceManager =
      resilience.get('nft-database') ||
      ResilienceManager.forDatabaseService('nft-database');

    if (!resilience.get('nft-database')) {
      resilience.register('nft-database', this.resilienceManager);
    }
  }

  static getInstance(): ResilientDatabaseService {
    if (!ResilientDatabaseService.instance) {
      ResilientDatabaseService.instance = new ResilientDatabaseService();
    }
    return ResilientDatabaseService.instance;
  }

  /**
   * Connect to database with resilience patterns
   */
  async connect(): Promise<void> {
    return await this.resilienceManager.executeWithRetry(async () => {
      await this.databaseService.connect();
    }, 'database-connect');
  }

  /**
   * Execute database query with full resilience (circuit breaker + retry + fallback)
   */
  async executeQuery<T>(
    operation: () => Promise<T>,
    operationName: string,
    options: {
      cacheKey?: string;
      fallbackData?: T;
    } = {}
  ): Promise<FallbackResult<T>> {
    const { cacheKey, fallbackData } = options;

    // Create fallback operation if fallback data is provided
    const fallbackOperation = fallbackData
      ? async () => {
          appLogger.info('Using fallback data', { operationName });
          return fallbackData;
        }
      : operation;

    return await this.resilienceManager.execute(operation, operationName, {
      cacheKey,
    });
  }

  /**
   * Execute database query with retry only (for critical operations)
   */
  async executeQueryWithRetry<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return await this.resilienceManager.executeWithRetry(
      operation,
      operationName
    );
  }

  /**
   * Execute database query with circuit breaker only
   */
  async executeQueryWithCircuitBreaker<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return await this.resilienceManager.executeWithCircuitBreaker(
      operation,
      operationName
    );
  }

  /**
   * Get database health status with resilience metrics
   */
  async getHealthStatus(): Promise<{
    database: {
      connected: boolean;
      status: string;
      healthy: boolean;
    };
    resilience: {
      circuitState: string;
      errorRate: number;
      fallbacksActivated: number;
      healthy: boolean;
    };
  }> {
    const dbHealthy = this.databaseService.isHealthy();
    const connectionStatus = this.databaseService.getConnectionStatus();
    const resilienceHealthy = await this.resilienceManager.getHealthStatus();
    const metrics = this.resilienceManager.getMetrics();

    return {
      database: {
        connected: dbHealthy,
        status: connectionStatus,
        healthy: dbHealthy,
      },
      resilience: {
        circuitState: metrics.circuit.state,
        errorRate: Math.round(metrics.circuit.errorRate * 100) / 100,
        fallbacksActivated: metrics.fallbacksActivated,
        healthy: resilienceHealthy,
      },
    };
  }

  /**
   * Disconnect with graceful shutdown
   */
  async disconnect(): Promise<void> {
    try {
      await this.databaseService.disconnect();
      this.resilienceManager.shutdown();
    } catch (error) {
      appLogger.error('Error during database disconnect', { error });
      throw error;
    }
  }

  /**
   * Reset resilience state (useful for testing)
   */
  resetResilience(): void {
    this.resilienceManager.reset();
  }

  /**
   * Get underlying database service (for direct access when needed)
   */
  getUnderlyingService(): DatabaseService {
    return this.databaseService;
  }

  /**
   * Get resilience metrics
   */
  getResilienceMetrics() {
    return this.resilienceManager.getMetrics();
  }

  // Common database operation helpers with resilience

  /**
   * Find operation with resilience
   */
  async findWithResilience<T>(
    operation: () => Promise<T[]>,
    operationName: string,
    fallbackData: T[] = []
  ): Promise<FallbackResult<T[]>> {
    return await this.executeQuery(operation, operationName, {
      cacheKey: `find-${operationName}`,
      fallbackData,
    });
  }

  /**
   * Find one operation with resilience
   */
  async findOneWithResilience<T>(
    operation: () => Promise<T | null>,
    operationName: string,
    fallbackData: T | null = null
  ): Promise<FallbackResult<T | null>> {
    return await this.executeQuery(operation, operationName, {
      cacheKey: `findOne-${operationName}`,
      fallbackData,
    });
  }

  /**
   * Create operation with resilience (critical - use retry only)
   */
  async createWithResilience<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return await this.executeQueryWithRetry(operation, operationName);
  }

  /**
   * Update operation with resilience (critical - use retry only)
   */
  async updateWithResilience<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return await this.executeQueryWithRetry(operation, operationName);
  }

  /**
   * Delete operation with resilience (critical - use retry only)
   */
  async deleteWithResilience<T>(
    operation: () => Promise<T>,
    operationName: string
  ): Promise<T> {
    return await this.executeQueryWithRetry(operation, operationName);
  }

  /**
   * Count operation with resilience and fallback
   */
  async countWithResilience(
    operation: () => Promise<number>,
    operationName: string
  ): Promise<FallbackResult<number>> {
    return await this.executeQuery(operation, operationName, {
      cacheKey: `count-${operationName}`,
      fallbackData: 0,
    });
  }
}
