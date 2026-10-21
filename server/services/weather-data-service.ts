/**
 * Weather Data Service with Advanced TypeScript Features
 *
 * Demonstrates practical implementation of advanced TypeScript patterns
 * including branded types, discriminated unions, and runtime validation.
 */

import { z } from 'zod';
import { EventEmitter } from 'events';
import { db } from '../../database/db.js';
import { weatherLogger } from '../utils/logger.js';
import {
  WeatherDataSchema,
  WeatherData,
  createWalletAddress,
  WalletAddress,
} from '../../shared/types/runtime-validation.js';
import {
  memoizeAsync,
  AdvancedCache,
  BatchProcessor,
} from '../../shared/types/performance-optimization.js';
import type {
  EventMap,
  TypedEventEmitter,
} from '../../shared/types/advanced-typescript-features.js';
import {
  calculateAgeMinutes,
  isValidRealTimeTimestamp,
} from '../../shared/utils/timestamp-normalizer.js';
import { SafeEventEmitter } from '../../shared/utils/safe-event-emitter.js';
import {
  persistWeatherSubmission,
} from './weather-submission-persistence.js';

// Branded types for weather station operations
type StationId = string & { readonly __brand: 'StationId' };
type DataQualityScore = number & { readonly __brand: 'DataQualityScore' };
type RewardAmount = string & { readonly __brand: 'RewardAmount' };

// Factory functions for branded types
export function createStationId(id: string): StationId {
  if (!/^[A-Z0-9]{8,12}$/.test(id)) {
    throw new Error('Invalid station ID format');
  }
  return id as StationId;
}

export function createQualityScore(score: number): DataQualityScore {
  if (score < 0 || score > 100) {
    throw new Error('Quality score must be between 0 and 100');
  }
  return score as DataQualityScore;
}

export function createRewardAmount(amount: string): RewardAmount {
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
    throw new Error('Invalid reward amount format');
  }
  return amount as RewardAmount;
}

// Event system with typed events
interface WeatherServiceEvents extends EventMap {
  'data:validated': {
    data: WeatherData;
    stationId: StationId;
    qualityScore: DataQualityScore;
  };
  'reward:calculated': {
    stationId: StationId;
    amount: RewardAmount;
    walletAddress: WalletAddress;
  };
  'validation:failed': {
    stationId: StationId;
    error: string;
    rawData: unknown;
  };
}

// Advanced repository pattern with conditional types
interface WeatherRepository<T extends WeatherData> {
  findByStation(stationId: StationId): Promise<T[]>;
  findByType<K extends T['type']>(type: K): Promise<Extract<T, { type: K }>[]>;
  store(data: T): Promise<void>;
  getQualityMetrics(stationId: StationId): Promise<DataQualityScore>;
}

// Validation pipeline with runtime type checking
class WeatherValidationPipeline {
  private static readonly TEMPERATURE_BOUNDS = { min: -60, max: 60 } as const;
  private static readonly HUMIDITY_BOUNDS = { min: 0, max: 100 } as const;
  private static readonly PRESSURE_BOUNDS = { min: 800, max: 1200 } as const;

  static validate(rawData: unknown): WeatherData {
    // Runtime validation with Zod
    const validated = WeatherDataSchema.parse(rawData);

    // Additional business logic validation
    switch (validated.type) {
      case 'temperature':
        if (
          validated.value < this.TEMPERATURE_BOUNDS.min ||
          validated.value > this.TEMPERATURE_BOUNDS.max
        ) {
          throw new Error(
            `Temperature ${validated.value}°C outside valid range`
          );
        }
        break;

      case 'humidity':
        if (
          validated.value < this.HUMIDITY_BOUNDS.min ||
          validated.value > this.HUMIDITY_BOUNDS.max
        ) {
          throw new Error(`Humidity ${validated.value}% outside valid range`);
        }
        break;

      case 'pressure':
        if (
          validated.value < this.PRESSURE_BOUNDS.min ||
          validated.value > this.PRESSURE_BOUNDS.max
        ) {
          throw new Error(`Pressure ${validated.value}hPa outside valid range`);
        }
        break;
    }

    return validated;
  }

  static calculateQualityScore(data: WeatherData): DataQualityScore {
    let score = 100;

    // Age penalty - uses safe calculation that handles future timestamps
    // (never returns negative, treats future timestamps as age 0)
    const ageMinutes = calculateAgeMinutes(data.timestamp);

    // Validate timestamp is within acceptable range for real-time data
    if (!isValidRealTimeTimestamp(data.timestamp, 1440, 300)) {
      // Data older than 24 hours or more than 5 minutes in future
      score -= 30;
    } else if (ageMinutes > 60) {
      // Normal age penalty for data older than 1 hour
      score -= Math.min(20, (ageMinutes / 60) * 5);
    }

    // Quality level adjustment
    switch (data.quality) {
      case 'high':
        break; // No penalty
      case 'medium':
        score -= 10;
        break;
      case 'low':
        score -= 25;
        break;
    }

    return createQualityScore(Math.max(0, Math.round(score)));
  }
}

// Reward calculation with conditional types
type RewardTier<T extends WeatherData['type']> = {
  temperature: { base: 0.1; qualityMultiplier: 1.5 };
  humidity: { base: 0.08; qualityMultiplier: 1.3 };
  pressure: { base: 0.12; qualityMultiplier: 1.4 };
  precipitation: { base: 0.15; qualityMultiplier: 1.6 };
}[T];

class RewardCalculator {
  private static readonly REWARD_TIERS = {
    temperature: { base: 0.1, qualityMultiplier: 1.5 },
    humidity: { base: 0.08, qualityMultiplier: 1.3 },
    pressure: { base: 0.12, qualityMultiplier: 1.4 },
    precipitation: { base: 0.15, qualityMultiplier: 1.6 },
  } as const;

  static calculateReward<T extends WeatherData['type']>(
    dataType: T,
    qualityScore: DataQualityScore
  ): RewardAmount {
    const tier = this.REWARD_TIERS[dataType];
    const qualityMultiplier = (qualityScore / 100) * tier.qualityMultiplier;
    const reward = tier.base * qualityMultiplier;

    return createRewardAmount(reward.toFixed(8));
  }
}

// Main service class with advanced TypeScript features
export class WeatherDataService {
  private eventEmitter: SafeEventEmitter;
  private cache: InstanceType<typeof AdvancedCache>;
  private batchProcessor: InstanceType<typeof BatchProcessor>;

  // Memoized expensive operations
  private memoizedQualityAnalysis = memoizeAsync(
    this.performQualityAnalysis.bind(this),
    (stationId: StationId) => `quality:${stationId}`,
    300000 // 5 minute TTL
  );

  constructor() {
    // Use SafeEventEmitter to log warnings when events have no listeners
    // This prevents silent data loss in the pipeline (Task 118.5)
    this.eventEmitter = new SafeEventEmitter({
      serviceName: 'WeatherDataService',
      warnOnNoListeners: true,
    });
    this.cache = new AdvancedCache(1000, 600000); // 10 minute TTL

    this.batchProcessor = new BatchProcessor({
      batchSize: 50,
      processor: this.processBatch.bind(this) as (
        batch: unknown[]
      ) => Promise<unknown[]>,
      onResult: results => {
        weatherLogger.info('Processed batch of weather data points', { module: 'WeatherDataService', operation: 'batchProcessor', count: results.length });
      },
      onError: (error, batch) => {
        weatherLogger.error('Batch processing failed', { module: 'WeatherDataService', operation: 'batchProcessor', error: error instanceof Error ? error.message : String(error) });
        this.handleBatchError(batch as any, error);
      },
    });
  }

  // Public API with branded types
  async submitWeatherData(
    stationId: StationId,
    walletAddress: WalletAddress,
    rawData: unknown
  ): Promise<{ success: boolean; reward?: RewardAmount; error?: string }> {
    try {
      // Validate data using runtime validation
      const validatedData = WeatherValidationPipeline.validate(rawData);

      // Calculate quality score
      const qualityScore =
        WeatherValidationPipeline.calculateQualityScore(validatedData);

      // Emit validation success event (logs warning if no listeners)
      this.eventEmitter.safeEmit('data:validated', {
        data: validatedData,
        stationId,
        qualityScore,
      });

      // Calculate reward
      const rewardAmount = RewardCalculator.calculateReward(
        validatedData.type,
        qualityScore
      );

      // Cache the validated data
      this.cache.set(`${stationId}:${validatedData.id}`, validatedData);

      // Queue for batch processing
      this.batchProcessor.add(validatedData);

      // Emit reward calculation event (logs warning if no listeners)
      this.eventEmitter.safeEmit('reward:calculated', {
        stationId,
        amount: rewardAmount,
        walletAddress,
      });

      return { success: true, reward: rewardAmount };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown validation error';

      // Emit validation failure event (logs warning if no listeners)
      this.eventEmitter.safeEmit('validation:failed', {
        stationId,
        error: errorMessage,
        rawData,
      });

      return { success: false, error: errorMessage };
    }
  }

  // Type-safe event subscription
  on<K extends keyof WeatherServiceEvents>(
    event: K,
    listener: (data: WeatherServiceEvents[K]) => void
  ): void {
    this.eventEmitter.on(event, listener);
  }

  // Advanced query methods with conditional types
  async getWeatherDataByType<T extends WeatherData['type']>(
    type: T,
    stationId: StationId
  ): Promise<Extract<WeatherData, { type: T }>[]> {
    const cacheKey = `${stationId}:${type}`;
    const cached = this.cache.get(cacheKey);

    if (cached) {
      return cached as Extract<WeatherData, { type: T }>[];
    }

    // Fetch from database (implementation would use actual DB query)
    const results = await this.fetchFromDatabase(stationId, type);

    // Cache the entire results array under the stationId:type key so it hits on repeated queries
    this.cache.set(cacheKey, results);

    return results as Extract<WeatherData, { type: T }>[];
  }

  // Performance monitoring
  async getStationQualityMetrics(stationId: StationId): Promise<{
    averageQuality: DataQualityScore;
    dataPointCount: number;
    lastSubmission: Date;
    reliabilityScore: number;
  }> {
    // Mock implementation - would be replaced with actual analysis
    return {
      averageQuality: {
        score: 85,
        timestamp: new Date(),
      } as unknown as DataQualityScore,
      dataPointCount: 1000,
      lastSubmission: new Date(),
      reliabilityScore: 0.95,
    };
  }

  // Private implementation methods
  // Uses Promise.allSettled for partial failure handling (Task 118.5)
  // Individual item failures don't fail the entire batch
  private async processBatch(batch: WeatherData[]): Promise<void[]> {
    // Batch database operations for performance
    const operations = batch.map(async data => {
      try {
        // Store in database
        await this.storeInDatabase(data);

        // Update metrics
        await this.updateMetrics(data);
      } catch (error) {
        weatherLogger.error('Failed to process weather data', { module: 'WeatherDataService', operation: 'processBatch', dataId: data.id, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });

    // Use allSettled to process all items even if some fail
    const results = await Promise.allSettled(operations);

    // Log summary of batch processing results
    const successCount = results.filter(r => r.status === 'fulfilled').length;
    const failureCount = results.filter(r => r.status === 'rejected').length;

    if (failureCount > 0) {
      weatherLogger.warn('Batch processing completed with partial failures', {
        module: 'WeatherDataService',
        operation: 'processBatch',
        total: batch.length,
        succeeded: successCount,
        failed: failureCount,
      });
    }

    // Return void array for compatibility, but don't throw on partial failures
    return results.map(() => undefined) as void[];
  }

  private async performQualityAnalysis(stationId: StationId) {
    // Simulate expensive quality analysis operation
    await new Promise(resolve => setTimeout(resolve, 100));

    return {
      averageQuality: createQualityScore(85),
      dataPointCount: 1500,
      lastSubmission: new Date(),
      reliabilityScore: 0.94,
    };
  }

  private async fetchFromDatabase(
    stationId: StationId,
    type: string
  ): Promise<WeatherData[]> {
    // Mock implementation - would use actual database query
    return [];
  }

  private async storeInDatabase(data: WeatherData): Promise<void> {
    const baseData: Record<string, any> = {
      stationId: data.stationId,
      timestamp: data.timestamp.toISOString(),
    };

    // Map discriminated union to flat WeatherData format
    if (data.type === 'temperature') {
      baseData.temperature = data.value;
    } else if (data.type === 'humidity') {
      baseData.humidity = data.value;
    } else if (data.type === 'pressure') {
      baseData.pressure = data.value;
    }

    await persistWeatherSubmission({
      ...baseData,
      transportMeta: {
        source: 'weather_data_service',
        qualityScore: WeatherValidationPipeline.calculateQualityScore(data),
      },
    } as any);
  }

  private async updateMetrics(data: WeatherData): Promise<void> {
    // Mock implementation - would update metrics
  }

  private handleBatchError(batch: WeatherData[], error: Error): void {
    // Error handling logic
    weatherLogger.error('Batch processing failed for items', { module: 'WeatherDataService', operation: 'handleBatchError', itemCount: batch.length, error: error.message });
  }

  // Cleanup method
  async shutdown(): Promise<void> {
    await this.batchProcessor.flush();
    this.cache.clear();
  }
}

// Export factory function for service creation
export function createWeatherDataService(): WeatherDataService {
  return new WeatherDataService();
}

// Export types for external use
export type { StationId, DataQualityScore, RewardAmount, WeatherServiceEvents };
