// SPDX-License-Identifier: MIT
/**
 * @title Oracle Integration Service
 * @dev Comprehensive service for integrating with multiple oracle providers
 * Supports Chainlink, API3, Band Protocol, DIA Data, and custom APIs
 */

import { ethers, JsonRpcProvider } from 'ethers';
import axios from 'axios';
import crypto from 'crypto';
import { EventEmitter } from 'events';
import { appLogger } from '../server/utils/logger.js';

// Oracle Provider Types
export enum OracleProvider {
  CHAINLINK = 'CHAINLINK',
  API3 = 'API3',
  BAND_PROTOCOL = 'BAND_PROTOCOL',
  DIA_DATA = 'DIA_DATA',
  TELLOR = 'TELLOR',
  CUSTOM = 'CUSTOM',
}

export enum DataType {
  PRICE_FEED = 'PRICE_FEED',
  WEATHER_DATA = 'WEATHER_DATA',
  VERIFICATION_STATUS = 'VERIFICATION_STATUS',
  QUALITY_SCORE = 'QUALITY_SCORE',
  VOLATILITY_DATA = 'VOLATILITY_DATA',
}

// Data Structures
export interface OracleConfig {
  provider: OracleProvider;
  oracleAddress: string;
  weight: number; // Weight for aggregation (basis points)
  maxStaleness: number; // Maximum staleness in seconds
  minConfidence: number; // Minimum confidence threshold
  isActive: boolean;
  endpoint?: string; // For API-based oracles
  apiKey?: string;
  rateLimit?: number; // Requests per minute
}

export interface DataFeed {
  value: number;
  timestamp: number;
  confidence: number;
  dataHash: string;
  source: OracleProvider;
}

export interface AggregatedData {
  value: number;
  timestamp: number;
  confidence: number;
  sourceCount: number;
  deviation: number; // Standard deviation of sources
}

/**
 * Oracle wire format for weather data. All numeric measurement fields are
 * scaled ×100 (integer representation for on-chain precision).
 *
 * To convert to canonical WeatherObservation: divide each field by 100.
 * See shared/types/weather-types.ts for the canonical type.
 */
export interface ScaledOracleWeatherData {
  temperature: number; // Temperature in Celsius * 100
  humidity: number; // Humidity percentage * 100
  pressure: number; // Atmospheric pressure in hPa * 100
  windSpeed: number; // Wind speed in m/s * 100
  rainfall: number; // Rainfall in mm * 100
  timestamp: number;
  stationId: string;
  confidence: number;
}

export function scaledOracleToObservation(scaled: ScaledOracleWeatherData): import('../shared/generated-types/index.js').WeatherObservation {
  return {
    temperature_c: scaled.temperature / 100,
    humidity_percent: scaled.humidity / 100,
    pressure_hpa: scaled.pressure / 100,
    wind_speed_ms: scaled.windSpeed / 100,
    wind_direction_deg: null,
    precipitation_mm: scaled.rainfall / 100,
    dewpoint_c: null,
    visibility_m: null,
  };
}

export interface ClimateData {
  co2Level: number; // CO2 concentration in ppm * 100
  avgTemperature: number; // Average temperature over period
  precipitation: number; // Total precipitation over period
  period: number; // Time period in seconds
  timestamp: number;
  confidence: number;
}

export interface VerificationData {
  status: string;
  standard: string;
  projectId: string;
  verifierId: string;
  verificationDate: number;
  expiryDate: number;
  creditAmount: number;
  documentHash: string;
  confidence: number;
  metadata: string;
}

export interface PriceData {
  price: number; // Price in wei (18 decimals)
  timestamp: number;
  volume: number; // Trading volume in 24h
  marketCap: number; // Market capitalization
  confidence: number; // Price confidence (0-100)
  marketId: string;
}

/**
 * Oracle Integration Service Class
 */
export class OracleIntegrationService extends EventEmitter {
  private provider: JsonRpcProvider;
  private oracleConfigs: Map<string, OracleConfig[]> = new Map();
  private dataCache: Map<string, { data: any; timestamp: number }> = new Map();
  private rateLimiters: Map<string, { count: number; resetTime: number }> =
    new Map();
  private circuitBreakers: Map<string, boolean> = new Map();
  private healthScores: Map<string, number> = new Map();

  // Contract addresses (would be loaded from config)
  private contracts = {
    oracleAggregator: '',
    weatherOracle: '',
    verificationOracle: '',
    priceFeedOracle: '',
  };

  constructor(providerUrl: string, contractAddresses: any) {
    super();
    this.provider = new JsonRpcProvider(providerUrl);
    this.contracts = contractAddresses;
    this.initializeDefaultOracles();
    this.startHealthMonitoring();
  }

  /**
   * Initialize default oracle configurations
   */
  private initializeDefaultOracles(): void {
    // Chainlink Price Feeds
    this.addOracleConfig('BTC/USD', {
      provider: OracleProvider.CHAINLINK,
      oracleAddress: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', // BTC/USD Chainlink
      weight: 4000, // 40% weight
      maxStaleness: 3600, // 1 hour
      minConfidence: 95,
      isActive: true,
    });

    this.addOracleConfig('ETH/USD', {
      provider: OracleProvider.CHAINLINK,
      oracleAddress: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', // ETH/USD Chainlink
      weight: 4000,
      maxStaleness: 3600,
      minConfidence: 95,
      isActive: true,
    });

    // Custom Weather API Configuration
    this.addOracleConfig('WEATHER_GLOBAL', {
      provider: OracleProvider.CUSTOM,
      oracleAddress: '0x0000000000000000000000000000000000000000',
      weight: 3000,
      maxStaleness: 1800, // 30 minutes
      minConfidence: 80,
      isActive: true,
      endpoint: 'https://api.openweathermap.org/data/2.5/weather',
      apiKey: process.env.OPENWEATHER_API_KEY,
      rateLimit: 60, // 60 requests per minute
    });

    // NOAA Climate Data
    this.addOracleConfig('CLIMATE_NOAA', {
      provider: OracleProvider.CUSTOM,
      oracleAddress: '0x0000000000000000000000000000000000000000',
      weight: 3500,
      maxStaleness: 7200, // 2 hours
      minConfidence: 90,
      isActive: true,
      endpoint: 'https://api.weather.gov/gridpoints',
      rateLimit: 300, // 300 requests per minute
    });

    // Carbon Credit Verification APIs
    this.addOracleConfig('VCS_VERIFICATION', {
      provider: OracleProvider.CUSTOM,
      oracleAddress: '0x0000000000000000000000000000000000000000',
      weight: 5000,
      maxStaleness: 86400, // 24 hours
      minConfidence: 95,
      isActive: true,
      endpoint: 'https://registry.verra.org/app/projectDetail/VCS',
      rateLimit: 10, // 10 requests per minute
    });
  }

  /**
   * Add oracle configuration for a data feed
   */
  public addOracleConfig(feedId: string, config: OracleConfig): void {
    if (!this.oracleConfigs.has(feedId)) {
      this.oracleConfigs.set(feedId, []);
    }
    this.oracleConfigs.get(feedId)!.push(config);
    this.healthScores.set(`${feedId}-${config.provider}`, 100);
  }

  /**
   * Get aggregated data from multiple oracle sources
   */
  public async getAggregatedData(
    feedId: string,
    dataType: DataType
  ): Promise<AggregatedData> {
    const configs = this.oracleConfigs.get(feedId);
    if (!configs || configs.length === 0) {
      throw new Error(`No oracle configurations found for feed: ${feedId}`);
    }

    const dataFeeds: DataFeed[] = [];
    const activeConfigs = configs.filter(
      config =>
        config.isActive &&
        !this.circuitBreakers.get(`${feedId}-${config.provider}`)
    );

    // Fetch data from all active oracles
    const promises = activeConfigs.map(async config => {
      try {
        const data = await this.fetchDataFromOracle(feedId, config, dataType);
        if (data) {
          dataFeeds.push(data);
          this.updateHealthScore(`${feedId}-${config.provider}`, true);
        }
      } catch (error) {
        appLogger.error('Failed to fetch from oracle', { provider: config.provider, error: error instanceof Error ? error.message : String(error) });
        this.updateHealthScore(`${feedId}-${config.provider}`, false);
        this.emit('oracleError', { feedId, provider: config.provider, error });
      }
    });

    await Promise.allSettled(promises);

    if (dataFeeds.length === 0) {
      throw new Error(`No data available from any oracle for feed: ${feedId}`);
    }

    // Aggregate the data
    return this.aggregateDataFeeds(dataFeeds, activeConfigs);
  }

  /**
   * Fetch data from a specific oracle
   */
  private async fetchDataFromOracle(
    feedId: string,
    config: OracleConfig,
    dataType: DataType
  ): Promise<DataFeed | null> {
    // Check rate limiting
    if (!this.checkRateLimit(config)) {
      throw new Error(`Rate limit exceeded for ${config.provider}`);
    }

    // Check cache first
    const cacheKey = `${feedId}-${config.provider}`;
    const cached = this.dataCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < config.maxStaleness * 1000) {
      return cached.data;
    }

    let data: DataFeed | null = null;

    switch (config.provider) {
      case OracleProvider.CHAINLINK:
        data = await this.fetchChainlinkData(config);
        break;
      case OracleProvider.API3:
        data = await this.fetchAPI3Data(config);
        break;
      case OracleProvider.BAND_PROTOCOL:
        data = await this.fetchBandProtocolData(config);
        break;
      case OracleProvider.DIA_DATA:
        data = await this.fetchDIAData(config);
        break;
      case OracleProvider.CUSTOM:
        data = await this.fetchCustomAPIData(feedId, config, dataType);
        break;
      default:
        throw new Error(`Unsupported oracle provider: ${config.provider}`);
    }

    // Cache the data
    if (data) {
      this.dataCache.set(cacheKey, { data, timestamp: Date.now() });
    }

    return data;
  }

  /**
   * Fetch data from Chainlink oracle
   */
  private async fetchChainlinkData(config: OracleConfig): Promise<DataFeed> {
    const aggregatorV3InterfaceABI = [
      {
        inputs: [],
        name: 'latestRoundData',
        outputs: [
          { internalType: 'uint80', name: 'roundId', type: 'uint80' },
          { internalType: 'int256', name: 'answer', type: 'int256' },
          { internalType: 'uint256', name: 'startedAt', type: 'uint256' },
          { internalType: 'uint256', name: 'updatedAt', type: 'uint256' },
          { internalType: 'uint80', name: 'answeredInRound', type: 'uint80' },
        ],
        stateMutability: 'view',
        type: 'function',
      },
    ];

    const contract = new ethers.Contract(
      config.oracleAddress,
      aggregatorV3InterfaceABI,
      this.provider
    );
    const roundData = await contract.latestRoundData();

    return {
      value: parseFloat(ethers.formatUnits(roundData.answer, 8)), // Chainlink typically uses 8 decimals
      timestamp: roundData.updatedAt.toNumber(),
      confidence: 95, // Chainlink typically has high confidence
      dataHash: ethers.keccak256(
        ethers.toUtf8Bytes(roundData.answer.toString())
      ),
      source: OracleProvider.CHAINLINK,
    };
  }

  /**
   * Fetch data from API3 oracle
   */
  private async fetchAPI3Data(config: OracleConfig): Promise<DataFeed> {
    // API3 specific implementation
    // This would interact with API3 dAPIs or Airnode
    throw new Error('API3 integration not yet implemented');
  }

  /**
   * Fetch data from Band Protocol oracle
   */
  private async fetchBandProtocolData(config: OracleConfig): Promise<DataFeed> {
    // Band Protocol specific implementation
    throw new Error('Band Protocol integration not yet implemented');
  }

  /**
   * Fetch data from DIA Data oracle
   */
  private async fetchDIAData(config: OracleConfig): Promise<DataFeed> {
    // DIA Data specific implementation
    if (!config.endpoint) {
      throw new Error('DIA Data endpoint not configured');
    }

    const response = await axios.get(config.endpoint, {
      timeout: 10000,
      headers: {
        Accept: 'application/json',
      },
    });

    const data = response.data;
    return {
      value: data.Price || data.value,
      timestamp: new Date(data.Time).getTime() / 1000,
      confidence: 90,
      dataHash: crypto
        .createHash('sha256')
        .update(JSON.stringify(data))
        .digest('hex'),
      source: OracleProvider.DIA_DATA,
    };
  }

  /**
   * Fetch data from custom API
   */
  private async fetchCustomAPIData(
    feedId: string,
    config: OracleConfig,
    dataType: DataType
  ): Promise<DataFeed> {
    if (!config.endpoint) {
      throw new Error('Custom API endpoint not configured');
    }

    const headers: any = {
      Accept: 'application/json',
      'User-Agent': 'WRFCoin-Oracle-Service/1.0',
    };

    // API keys are passed directly to fetch methods — never via Authorization header (#432)
    const url = config.endpoint;
    let data: any;

    switch (dataType) {
      case DataType.WEATHER_DATA:
        data = await this.fetchWeatherData(url, headers, feedId, config.apiKey);
        break;
      case DataType.VERIFICATION_STATUS:
        data = await this.fetchVerificationData(url, headers, feedId);
        break;
      case DataType.PRICE_FEED:
        data = await this.fetchPriceData(url, headers, feedId);
        break;
      default:
        throw new Error(`Unsupported data type for custom API: ${dataType}`);
    }

    return {
      value: data.value,
      timestamp: data.timestamp || Math.floor(Date.now() / 1000),
      confidence: data.confidence || 80,
      dataHash: crypto
        .createHash('sha256')
        .update(JSON.stringify(data))
        .digest('hex'),
      source: OracleProvider.CUSTOM,
    };
  }

  /**
   * Fetch weather data from external API
   */
  private async fetchWeatherData(
    url: string,
    headers: any,
    location: string,
    apiKey?: string
  ): Promise<any> {
    // OpenWeatherMap uses appid query param — pass API key directly, never extract from JWT (#432)
    if (!apiKey) {
      throw new Error('OPENWEATHER_API_KEY is required for weather data fetch');
    }
    const response = await axios.get(
      `${url}?q=${encodeURIComponent(location)}&appid=${encodeURIComponent(apiKey)}`,
      {
        headers,
        timeout: 10000,
      }
    );

    const weather = response.data;
    return {
      value: weather.main.temp, // Main value (temperature)
      temperature: Math.round((weather.main.temp - 273.15) * 100), // Convert Kelvin to Celsius * 100
      humidity: weather.main.humidity * 100,
      pressure: weather.main.pressure * 100,
      windSpeed: Math.round(weather.wind.speed * 100),
      rainfall: Math.round((weather.rain?.['1h'] || 0) * 100),
      confidence: 85,
    };
  }

  /**
   * Fetch verification data from registry API
   */
  private async fetchVerificationData(
    url: string,
    headers: any,
    projectId: string
  ): Promise<any> {
    const response = await axios.get(`${url}/${projectId}`, {
      headers,
      timeout: 15000,
    });

    const verification = response.data;
    return {
      value: verification.status === 'VERIFIED' ? 1 : 0,
      status: verification.status,
      standard: verification.standard,
      verificationDate:
        new Date(verification.verificationDate).getTime() / 1000,
      expiryDate: new Date(verification.expiryDate).getTime() / 1000,
      confidence: 95,
    };
  }

  /**
   * Fetch price data from market API
   */
  private async fetchPriceData(
    url: string,
    headers: any,
    symbol: string
  ): Promise<any> {
    const response = await axios.get(`${url}/${symbol}`, {
      headers,
      timeout: 10000,
    });

    const price = response.data;
    return {
      value: parseFloat(price.price || price.last || price.current_price),
      volume: parseFloat(price.volume || price.total_volume || 0),
      marketCap: parseFloat(price.market_cap || 0),
      confidence: 90,
    };
  }

  /**
   * Aggregate data from multiple feeds
   */
  private aggregateDataFeeds(
    dataFeeds: DataFeed[],
    configs: OracleConfig[]
  ): AggregatedData {
    if (dataFeeds.length === 0) {
      throw new Error('No data feeds to aggregate');
    }

    let totalWeight = 0;
    let weightedSum = 0;
    let totalConfidence = 0;
    let validFeeds = 0;

    // Calculate weighted average
    for (const feed of dataFeeds) {
      const config = configs.find(c => c.provider === feed.source);
      if (config && feed.confidence >= config.minConfidence) {
        const weight = config.weight;
        weightedSum += feed.value * weight;
        totalWeight += weight;
        totalConfidence += feed.confidence;
        validFeeds++;
      }
    }

    if (validFeeds === 0) {
      throw new Error('No valid feeds meet confidence requirements');
    }

    const aggregatedValue = weightedSum / totalWeight;
    const avgConfidence = totalConfidence / validFeeds;

    // Calculate standard deviation
    const deviation = this.calculateStandardDeviation(
      dataFeeds,
      aggregatedValue
    );

    return {
      value: aggregatedValue,
      timestamp: Math.floor(Date.now() / 1000),
      confidence: avgConfidence,
      sourceCount: validFeeds,
      deviation,
    };
  }

  /**
   * Calculate standard deviation of data feeds
   */
  private calculateStandardDeviation(feeds: DataFeed[], mean: number): number {
    if (feeds.length <= 1) return 0;

    const sumSquaredDiffs = feeds.reduce((sum, feed) => {
      const diff = feed.value - mean;
      return sum + diff * diff;
    }, 0);

    const variance = sumSquaredDiffs / feeds.length;
    return Math.sqrt(variance);
  }

  /**
   * Check rate limiting for oracle provider
   */
  private checkRateLimit(config: OracleConfig): boolean {
    if (!config.rateLimit) return true;

    const key = `${config.provider}-${config.oracleAddress}`;
    const now = Date.now();
    const limiter = this.rateLimiters.get(key);

    if (!limiter || now > limiter.resetTime) {
      this.rateLimiters.set(key, { count: 1, resetTime: now + 60000 }); // Reset every minute
      return true;
    }

    if (limiter.count >= config.rateLimit) {
      return false;
    }

    limiter.count++;
    return true;
  }

  /**
   * Update health score for oracle
   */
  private updateHealthScore(oracleKey: string, success: boolean): void {
    const currentScore = this.healthScores.get(oracleKey) || 100;

    if (success) {
      const newScore = Math.min(100, currentScore + 1);
      this.healthScores.set(oracleKey, newScore);
    } else {
      const newScore = Math.max(0, currentScore - 5);
      this.healthScores.set(oracleKey, newScore);

      // Trigger circuit breaker if health is too low
      if (newScore < 20) {
        this.circuitBreakers.set(oracleKey, true);
        this.emit('circuitBreakerTriggered', {
          oracleKey,
          healthScore: newScore,
        });
      }
    }
  }

  /**
   * Start health monitoring for all oracles
   */
  private startHealthMonitoring(): void {
    setInterval(() => {
      this.performHealthChecks();
    }, 300000); // Check every 5 minutes
  }

  /**
   * Perform health checks on all oracles
   */
  private async performHealthChecks(): Promise<void> {
    for (const [feedId, configs] of this.oracleConfigs.entries()) {
      for (const config of configs) {
        if (!config.isActive) continue;

        try {
          // Perform a lightweight health check
          await this.fetchDataFromOracle(feedId, config, DataType.PRICE_FEED);
          this.updateHealthScore(`${feedId}-${config.provider}`, true);
        } catch (error) {
          this.updateHealthScore(`${feedId}-${config.provider}`, false);
        }
      }
    }

    this.emit('healthCheckCompleted', {
      timestamp: Date.now(),
      healthScores: Object.fromEntries(this.healthScores),
    });
  }

  /**
   * Get health scores for all oracles
   */
  public getHealthScores(): Map<string, number> {
    return new Map(this.healthScores);
  }

  /**
   * Enable/disable circuit breaker for specific oracle
   */
  public setCircuitBreaker(oracleKey: string, enabled: boolean): void {
    this.circuitBreakers.set(oracleKey, enabled);
    this.emit('circuitBreakerChanged', { oracleKey, enabled });
  }

  /**
   * Get current circuit breaker status
   */
  public getCircuitBreakerStatus(): Map<string, boolean> {
    return new Map(this.circuitBreakers);
  }

  /**
   * Clear data cache
   */
  public clearCache(): void {
    this.dataCache.clear();
    this.emit('cacheCleared', { timestamp: Date.now() });
  }

  /**
   * Get cached data statistics
   */
  public getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.dataCache.size,
      keys: Array.from(this.dataCache.keys()),
    };
  }

  /**
   * Track carbon activity for a user
   */
  public async trackActivity(userId: string, activityData: any): Promise<any> {
    try {
      return {
        success: true,
        activityId: `activity_${Date.now()}`,
        userId,
        carbonEmission: activityData.emission ?? (() => {
          // Deterministic stub: derive from userId hash until real sensor integration
          const seed = Array.from(userId).reduce((acc: number, c: string) => acc + c.charCodeAt(0), 0);
          return (seed % 100) + 1; // 1–100 kg CO2e, deterministic per userId
        })(),
        confidence: 85,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      appLogger.error('Error tracking activity', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Get user carbon footprint
   */
  public async getUserFootprint(userId: string): Promise<any> {
    try {
      // Deterministic stub — replace with DB query when carbon data pipeline is live
      const seed = Array.from(userId).reduce((acc: number, c: string) => acc + c.charCodeAt(0), 0);
      return {
        userId,
        totalEmissions: (seed % 4000) + 500,
        monthlyEmissions: (seed % 400) + 50,
        categories: {
          transportation: (seed % 1000) + 200,
          energy: (seed % 1500) + 300,
          food: (seed % 800) + 100,
          other: (seed % 400) + 50,
        },
        lastUpdated: new Date().toISOString(),
      };
    } catch (error) {
      appLogger.error('Error getting user footprint', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Get available carbon offsets
   */
  public async getCarbonOffsets(amount: number): Promise<any[]> {
    try {
      return [
        {
          offsetId: 'offset_1',
          projectName: 'Renewable Energy Project',
          pricePerTonne: 25.5,
          available: amount,
          vintage: 2024,
          standard: 'VCS',
        },
      ];
    } catch (error) {
      appLogger.error('Error getting carbon offsets', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Calculate personalized carbon score
   */
  public async calculatePersonalizedScore(
    userId: string,
    data: any
  ): Promise<any> {
    try {
      // Deterministic stub: derive from userId hash until real scoring pipeline is live
      const seed = Array.from(userId).reduce((acc: number, c: string) => acc + c.charCodeAt(0), 0);
      const baseScore = (seed % 60) + 40; // 40–99, deterministic per userId
      return {
        userId,
        score: Math.round(baseScore),
        grade:
          baseScore > 80
            ? 'A'
            : baseScore > 60
              ? 'B'
              : baseScore > 40
                ? 'C'
                : 'D',
        improvements: ['Reduce transportation emissions'],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      appLogger.error('Error calculating personalized score', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }

  /**
   * Generate carbon reduction recommendations
   */
  public async generateRecommendations(
    userId: string,
    footprintData: any
  ): Promise<any[]> {
    try {
      return [
        {
          category: 'Transportation',
          recommendation: 'Use public transport or carpool',
          potentialSaving: (() => {
            // Deterministic stub: derive from userId hash until real recommendations pipeline is live
            const seed = Array.from(userId).reduce((acc: number, c: string) => acc + c.charCodeAt(0), 0);
            return (seed % 400) + 50; // 50–449, deterministic per userId
          })(),
          difficulty: 'Easy',
          timeframe: '1 month',
        },
      ];
    } catch (error) {
      appLogger.error('Error generating recommendations', { error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

// Carbon Activity Types for compatibility
export enum CarbonActivityType {
  ENERGY_CONSUMPTION = 'ENERGY_CONSUMPTION',
  TRANSPORTATION = 'TRANSPORTATION',
  MANUFACTURING = 'MANUFACTURING',
  AGRICULTURE = 'AGRICULTURE',
  WASTE_MANAGEMENT = 'WASTE_MANAGEMENT',
  OTHER = 'OTHER',
}

// Compatibility export for CarbonTrackingService
export { OracleIntegrationService as CarbonTrackingService };

// Export default instance
export default OracleIntegrationService;
