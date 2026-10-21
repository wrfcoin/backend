/**
 * Weather Data Service with Advanced TypeScript Features
 *
 * Demonstrates practical implementation of advanced TypeScript patterns
 * including branded types, discriminated unions, and runtime validation.
 */

import { z } from 'zod';
import { EventEmitter } from 'events';
import { db } from '../../database/db.js';
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
import { weatherLogger } from '../../server/utils/logger.js';

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

    // Age penalty
    const ageMinutes = (Date.now() - data.timestamp.getTime()) / (1000 * 60);
    if (ageMinutes > 60) {
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
  private eventEmitter: TypedEventEmitter<WeatherServiceEvents>;
  private cache: InstanceType<typeof AdvancedCache>;
  private batchProcessor: InstanceType<typeof BatchProcessor>;

  // Memoized expensive operations
  private memoizedQualityAnalysis = memoizeAsync(
    this.performQualityAnalysis.bind(this),
    (stationId: StationId) => `quality:${stationId}`,
    300000 // 5 minute TTL
  );

  constructor() {
    this.eventEmitter =
      new EventEmitter() as TypedEventEmitter<WeatherServiceEvents>;
    this.cache = new AdvancedCache(1000, 600000); // 10 minute TTL

    this.batchProcessor = new BatchProcessor({
      batchSize: 50,
      processor: this.processBatch.bind(this) as (
        batch: unknown[]
      ) => Promise<unknown[]>,
      onResult: results => {
        weatherLogger.info('Batch processing completed', { dataPointCount: results.length });
      },
      onError: (error, batch) => {
        weatherLogger.error('Batch processing failed', { error: error instanceof Error ? error.message : String(error) });
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

      // Emit validation success event
      this.eventEmitter.emit('data:validated', {
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

      // Emit reward calculation event
      this.eventEmitter.emit('reward:calculated', {
        stationId,
        amount: rewardAmount,
        walletAddress,
      });

      return { success: true, reward: rewardAmount };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown validation error';

      this.eventEmitter.emit('validation:failed', {
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

    if (cached && Array.isArray(cached)) {
      return cached as Extract<WeatherData, { type: T }>[];
    }

    // Fetch from database (implementation would use actual DB query)
    const results = await this.fetchFromDatabase(stationId, type);

    // Cache results array under the same key used for reads
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
  private async processBatch(batch: WeatherData[]): Promise<void[]> {
    // Batch database operations for performance
    const operations = batch.map(async data => {
      try {
        // Store in database
        await this.storeInDatabase(data);

        // Update metrics
        await this.updateMetrics(data);
      } catch (error) {
        weatherLogger.error('Failed to process weather data', { dataId: data.id, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    });

    return Promise.all(operations);
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
    // Mock implementation - would store in actual database
  }

  private async updateMetrics(data: WeatherData): Promise<void> {
    // Mock implementation - would update metrics
  }

  private handleBatchError(batch: WeatherData[], error: Error): void {
    // Error handling logic
    weatherLogger.error('Batch processing failed', { itemCount: batch.length, error: error.message });
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
