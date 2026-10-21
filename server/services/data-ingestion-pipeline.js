/**
 * WRFCoin Data Ingestion Pipeline
 *
 * Comprehensive data ingestion and preprocessing pipeline for weather data from multiple sources.
 * Handles real-time streaming, batch processing, data validation, transformation, and storage.
 *
 * Features:
 * - Event-driven architecture with message queuing
 * - Multi-source data integration (NOAA APIs, weather stations)
 * - Real-time and batch processing modes
 * - Data quality scoring and enrichment
 * - Unit normalization and format standardization
 * - Temporal aggregation and spatial interpolation
 * - Integration with existing validation framework
 */

const EventEmitter = require('events');
const Queue = require('bull');
const redis = require('redis');
const { NOAANWSApiService } = require('./noaa-nws-api-service');
const { NOAADataService } = require('./noaa-data-service');
const {
  WeatherDataValidator,
} = require('../utils/testing/weather-data-validation');
const { DataPreprocessor } = require('./data-preprocessor');
const { DatabaseManager } = require('../database/database-manager');
const Logger = require('../utils/logger');

class DataIngestionPipeline extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      // Processing configuration
      batchSize: options.batchSize || 100,
      maxConcurrency: options.maxConcurrency || 5,
      retryAttempts: options.retryAttempts || 3,
      retryDelay: options.retryDelay || 1000,

      // Data quality settings
      qualityThreshold: options.qualityThreshold || 0.7,
      enableEnrichment: options.enableEnrichment || true,
      enableAggregation: options.enableAggregation || true,

      // Storage settings
      enableCaching: options.enableCaching || true,
      cacheExpiry: options.cacheExpiry || 3600, // 1 hour

      // Pipeline modes
      realTimeEnabled: options.realTimeEnabled || true,
      batchEnabled: options.batchEnabled || true,

      ...options,
    };

    // Initialize services
    this.noaaApiService = new NOAANWSApiService();
    this.noaaDataService = new NOAADataService();
    this.validator = new WeatherDataValidator();
    this.preprocessor = new DataPreprocessor();
    this.databaseManager = new DatabaseManager();
    this.logger = Logger;

    // Initialize Redis for caching and queuing
    this.redisClient = null;
    this.dataQueue = null;
    this.processingQueue = null;

    // Pipeline state
    this.isRunning = false;
    this.stats = {
      totalProcessed: 0,
      successfulIngestions: 0,
      failedIngestions: 0,
      qualityScores: [],
      avgProcessingTime: 0,
      lastProcessedAt: null,
    };

    this.initialize();
  }

  /**
   * Initialize the data ingestion pipeline
   */
  async initialize() {
    try {
      this.logger.info('Initializing Data Ingestion Pipeline...');

      // Initialize Redis connection
      await this.initializeRedis();

      // Initialize job queues
      await this.initializeQueues();

      // Setup event listeners
      this.setupEventListeners();

      // Initialize database connections
      await this.databaseManager.connect();

      this.logger.info('Data Ingestion Pipeline initialized successfully');
      this.emit('initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Data Ingestion Pipeline:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Initialize Redis connection for caching and message queuing
   */
  async initializeRedis() {
    if (this.options.enableCaching) {
      this.redisClient = redis.createClient({
        host: process.env.REDIS_HOST || 'redis-cache',
        port: process.env.REDIS_PORT || 6379,
        password: process.env.REDIS_PASSWORD || '',
      });

      this.redisClient.on('error', error => {
        this.logger.error('Redis connection error:', error);
      });

      await this.redisClient.connect();
      this.logger.info('Redis connection established');
    }
  }

  /**
   * Initialize Bull job queues for async processing
   */
  async initializeQueues() {
    const redisConfig = {
      host: process.env.REDIS_HOST || 'redis-cache',
      port: process.env.REDIS_PORT || 6379,
      password: process.env.REDIS_PASSWORD || '',
    };

    // Main data ingestion queue
    this.dataQueue = new Queue('weather data ingestion', {
      redis: redisConfig,
    });

    // Data processing queue
    this.processingQueue = new Queue('weather data processing', {
      redis: redisConfig,
    });

    // Setup queue processors
    this.setupQueueProcessors();

    this.logger.info('Job queues initialized');
  }

  /**
   * Setup job queue processors
   */
  setupQueueProcessors() {
    // Data ingestion processor
    this.dataQueue.process(
      'ingest-data',
      this.options.maxConcurrency,
      async job => {
        return await this.processDataIngestion(job.data);
      }
    );

    // Data processing processor
    this.processingQueue.process(
      'process-data',
      this.options.maxConcurrency,
      async job => {
        return await this.processDataTransformation(job.data);
      }
    );

    // Error handlers
    this.dataQueue.on('failed', (job, error) => {
      this.logger.error(`Data ingestion job ${job.id} failed:`, error);
      this.stats.failedIngestions++;
    });

    this.processingQueue.on('failed', (job, error) => {
      this.logger.error(`Data processing job ${job.id} failed:`, error);
    });
  }

  /**
   * Setup event listeners for pipeline monitoring
   */
  setupEventListeners() {
    this.on('data-ingested', data => {
      this.stats.successfulIngestions++;
      this.stats.lastProcessedAt = new Date();
      this.updateProcessingStats(data);
    });

    this.on('data-failed', error => {
      this.stats.failedIngestions++;
      this.logger.error('Data ingestion failed:', error);
    });

    this.on('quality-score', score => {
      this.stats.qualityScores.push(score);
      if (this.stats.qualityScores.length > 1000) {
        this.stats.qualityScores.shift(); // Keep only last 1000 scores
      }
    });
  }

  /**
   * Start the data ingestion pipeline
   */
  async start() {
    if (this.isRunning) {
      this.logger.warn('Pipeline is already running');
      return;
    }

    try {
      this.isRunning = true;
      this.logger.info('Starting Data Ingestion Pipeline...');

      // Start real-time processing if enabled
      if (this.options.realTimeEnabled) {
        await this.startRealTimeIngestion();
      }

      // Start batch processing if enabled
      if (this.options.batchEnabled) {
        await this.startBatchProcessing();
      }

      this.logger.info('Data Ingestion Pipeline started successfully');
      this.emit('started');
    } catch (error) {
      this.isRunning = false;
      this.logger.error('Failed to start Data Ingestion Pipeline:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Stop the data ingestion pipeline
   */
  async stop() {
    if (!this.isRunning) {
      this.logger.warn('Pipeline is not running');
      return;
    }

    try {
      this.isRunning = false;
      this.logger.info('Stopping Data Ingestion Pipeline...');

      // Close queues
      if (this.dataQueue) {
        await this.dataQueue.close();
      }
      if (this.processingQueue) {
        await this.processingQueue.close();
      }

      // Close Redis connection
      if (this.redisClient) {
        await this.redisClient.quit();
      }

      // Close database connections
      await this.databaseManager.disconnect();

      this.logger.info('Data Ingestion Pipeline stopped successfully');
      this.emit('stopped');
    } catch (error) {
      this.logger.error('Error stopping Data Ingestion Pipeline:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Ingest data from multiple sources
   */
  async ingestData(sources = [], options = {}) {
    const startTime = Date.now();

    try {
      const jobs = [];

      for (const source of sources) {
        const job = await this.dataQueue.add(
          'ingest-data',
          {
            source,
            options,
            timestamp: new Date().toISOString(),
          },
          {
            attempts: this.options.retryAttempts,
            backoff: {
              type: 'exponential',
              delay: this.options.retryDelay,
            },
          }
        );

        jobs.push(job);
      }

      const results = await Promise.allSettled(jobs.map(job => job.finished()));

      const processedData = results
        .filter(result => result.status === 'fulfilled')
        .map(result => result.value);

      const processingTime = Date.now() - startTime;
      this.updateProcessingTime(processingTime);

      this.logger.info(
        `Ingested ${processedData.length} data points in ${processingTime}ms`
      );

      return {
        success: true,
        processed: processedData.length,
        failed: results.length - processedData.length,
        processingTime,
        data: processedData,
      };
    } catch (error) {
      this.logger.error('Error during data ingestion:', error);
      this.emit('data-failed', error);
      throw error;
    }
  }

  /**
   * Process individual data ingestion job
   */
  async processDataIngestion(jobData) {
    const { source, options } = jobData;

    try {
      let rawData;

      // Fetch data based on source type
      switch (source.type) {
        case 'noaa-nws':
          rawData = await this.fetchNOAANWSData(source, options);
          break;
        case 'noaa-ncei':
          rawData = await this.fetchNOAANCEIData(source, options);
          break;
        case 'weather-station':
          rawData = await this.fetchWeatherStationData(source, options);
          break;
        default:
          throw new Error(`Unsupported data source type: ${source.type}`);
      }

      if (rawData == null) {
        return { status: 'skipped', source: source.type, reason: 'no data available' };
      }

      // Queue data for processing
      const processingJob = await this.processingQueue.add('process-data', {
        rawData,
        source,
        timestamp: new Date().toISOString(),
      });

      return await processingJob.finished();
    } catch (error) {
      this.logger.error(
        `Error processing ingestion for ${source.type}:`,
        error
      );
      throw error;
    }
  }

  /**
   * Process data transformation and validation
   */
  async processDataTransformation(jobData) {
    const { rawData, source } = jobData;

    try {
      // Preprocess and normalize data
      const preprocessedData = await this.preprocessor.process(rawData, {
        source: source.type,
        normalizeUnits: true,
        validateFormat: true,
        enrichData: this.options.enableEnrichment,
      });

      // Validate data quality
      const validationResult =
        await this.validator.validateData(preprocessedData);

      // Calculate quality score
      const qualityScore = this.calculateQualityScore(
        validationResult,
        preprocessedData
      );
      this.emit('quality-score', qualityScore);

      // Skip low-quality data if below threshold
      if (qualityScore < this.options.qualityThreshold) {
        this.logger.warn(
          `Data quality below threshold (${qualityScore}), skipping storage`
        );
        return { skipped: true, qualityScore, reason: 'low_quality' };
      }

      // Store processed data
      const storageResult = await this.storeProcessedData(preprocessedData, {
        source,
        qualityScore,
        validationResult,
      });

      // Cache if enabled
      if (this.options.enableCaching) {
        await this.cacheProcessedData(preprocessedData);
      }

      this.emit('data-ingested', {
        data: preprocessedData,
        qualityScore,
        storageResult,
      });

      return {
        success: true,
        qualityScore,
        dataPoints: Array.isArray(preprocessedData)
          ? preprocessedData.length
          : 1,
        storageResult,
      };
    } catch (error) {
      this.logger.error('Error during data transformation:', error);
      throw error;
    }
  }

  /**
   * Fetch data from NOAA NWS API
   */
  async fetchNOAANWSData(source, options) {
    const { location, dataTypes = ['current'] } = source;
    const results = [];

    for (const dataType of dataTypes) {
      switch (dataType) {
        case 'current':
          const currentData =
            await this.noaaApiService.getCurrentWeather(location);
          results.push(currentData);
          break;
        case 'forecast':
          const forecastData = await this.noaaApiService.getForecast(location);
          results.push(forecastData);
          break;
        case 'alerts':
          const alertsData = await this.noaaApiService.getAlerts(location);
          results.push(alertsData);
          break;
      }
    }

    return results.flat();
  }

  /**
   * Fetch data from NOAA NCEI Data Service
   */
  async fetchNOAANCEIData(source, options) {
    const {
      location,
      startDate,
      endDate,
      dataTypes = ['TMAX', 'TMIN', 'PRCP'],
    } = source;

    return await this.noaaDataService.getHistoricalData(location, {
      startDate,
      endDate,
      dataTypes,
    });
  }

  /**
   * Fetch data from weather station
   */
  async fetchWeatherStationData(source, options) {
    if (source.data) {
      return source.data;
    }
    if (source.payload) {
      return source.payload;
    }
    if (Array.isArray(source.readings) && source.readings.length > 0) {
      return {
        timestamp: source.timestamp || new Date().toISOString(),
        source: 'weather-station',
        location: source.location,
        data: source.readings[0],
      };
    }
    this.logger.warn(
      'Weather station source has no recognizable data format (expected .data, .payload, or .readings) — skipping ingestion',
      { stationId: source.stationId || source.id, sourceKeys: Object.keys(source || {}) }
    );
    return null;
  }

  /**
   * Calculate data quality score
   */
  calculateQualityScore(validationResult, data) {
    const weights = {
      completeness: 0.3,
      accuracy: 0.4,
      consistency: 0.2,
      timeliness: 0.1,
    };

    const scores = {
      completeness: this.calculateCompletenessScore(data),
      accuracy: validationResult.passed ? 1.0 : 0.5,
      consistency: this.calculateConsistencyScore(data),
      timeliness: this.calculateTimelinessScore(data),
    };

    const totalScore = Object.keys(weights).reduce((sum, metric) => {
      return sum + weights[metric] * scores[metric];
    }, 0);

    return Math.round(totalScore * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Calculate completeness score based on available data fields
   */
  calculateCompletenessScore(data) {
    const requiredFields = ['temperature', 'humidity', 'pressure'];
    const optionalFields = [
      'windSpeed',
      'windDirection',
      'precipitation',
      'visibility',
    ];

    if (!data || !data.data) return 0;

    const availableRequired = requiredFields.filter(
      field =>
        data.data[field] &&
        data.data[field].value !== null &&
        data.data[field].value !== undefined
    ).length;

    const availableOptional = optionalFields.filter(
      field =>
        data.data[field] &&
        data.data[field].value !== null &&
        data.data[field].value !== undefined
    ).length;

    const requiredScore = availableRequired / requiredFields.length;
    const optionalScore = availableOptional / optionalFields.length;

    return requiredScore * 0.8 + optionalScore * 0.2;
  }

  /**
   * Calculate consistency score based on data relationships
   */
  calculateConsistencyScore(data) {
    // Implementation would check physical consistency between parameters
    // For now, return a default high score
    return 0.9;
  }

  /**
   * Calculate timeliness score based on data age
   */
  calculateTimelinessScore(data) {
    if (!data.timestamp) return 0.5;

    const dataAge = Date.now() - new Date(data.timestamp).getTime();
    const maxAge = 24 * 60 * 60 * 1000; // 24 hours

    if (dataAge < maxAge / 4) return 1.0; // Fresh data (< 6 hours)
    if (dataAge < maxAge / 2) return 0.8; // Recent data (< 12 hours)
    if (dataAge < maxAge) return 0.6; // Acceptable data (< 24 hours)
    return 0.3; // Old data (> 24 hours)
  }

  /**
   * Store processed data in database
   */
  async storeProcessedData(data, metadata) {
    try {
      const { persistWeatherSubmission } = await import('./weather-submission-persistence.js');
      const persisted = await persistWeatherSubmission({
        stationId: data.location?.stationId || this.generateDataId(data),
        timestamp: data.timestamp || new Date().toISOString(),
        temperature: data.data?.temperature?.value ?? null,
        humidity: data.data?.humidity?.value ?? null,
        pressure: data.data?.pressure?.value ?? null,
        windSpeed: data.data?.windSpeed?.value ?? null,
        windDirection: data.data?.windDirection?.value ?? null,
        precipitation: data.data?.precipitation?.value ?? null,
        visibility: data.data?.visibility?.value ?? null,
        transportMeta: {
          source: data.source || metadata?.source?.type || 'data_ingestion_pipeline',
          qualityScore: metadata.qualityScore,
          location: {
            latitude: data.location?.latitude ?? null,
            longitude: data.location?.longitude ?? null,
            altitude: data.location?.elevation ?? null,
          },
        },
      });

      this.logger.debug(
        `Stored weather data record with submission ID: ${persisted.submissionId}`
      );

      return persisted;
    } catch (error) {
      this.logger.error('Error storing processed data:', error);
      throw error;
    }
  }

  /**
   * Cache processed data in Redis
   */
  async cacheProcessedData(data) {
    if (!this.redisClient || !data) return;

    try {
      const cacheKey = this.generateCacheKey(data);
      const cacheValue = JSON.stringify(data);

      await this.redisClient.setEx(
        cacheKey,
        this.options.cacheExpiry,
        cacheValue
      );
    } catch (error) {
      this.logger.error('Error caching processed data:', error);
    }
  }

  /**
   * Generate cache key for data
   */
  generateCacheKey(data) {
    const { location, timestamp, source } = data;
    return `weather:${source}:${location.latitude}:${location.longitude}:${timestamp}`;
  }

  /**
   * Format data for database storage
   */
  formatForDatabase(data, metadata) {
    return {
      data_id: this.generateDataId(data),
      timestamp: data.timestamp,
      latitude: data.location.latitude.toString(),
      longitude: data.location.longitude.toString(),
      elevation: data.location.elevation || null,
      station_id: data.location.stationId || null,
      temperature: data.data.temperature
        ? JSON.stringify(data.data.temperature)
        : null,
      humidity: data.data.humidity ? JSON.stringify(data.data.humidity) : null,
      pressure: data.data.pressure ? JSON.stringify(data.data.pressure) : null,
      wind_speed: data.data.windSpeed
        ? JSON.stringify(data.data.windSpeed)
        : null,
      wind_direction: data.data.windDirection
        ? JSON.stringify(data.data.windDirection)
        : null,
      precipitation: data.data.precipitation
        ? JSON.stringify(data.data.precipitation)
        : null,
      cloud_cover: data.data.cloudCover
        ? JSON.stringify(data.data.cloudCover)
        : null,
      visibility: data.data.visibility
        ? JSON.stringify(data.data.visibility)
        : null,
      data_hash: this.calculateDataHash(data),
      source_type: data.source,
      metadata: {
        qualityScore: metadata.qualityScore,
        validationResult: metadata.validationResult,
        processingTimestamp: new Date().toISOString(),
      },
    };
  }

  /**
   * Generate unique data ID
   */
  generateDataId(data) {
    const { location, timestamp, source } = data;
    return `${source}_${location.latitude}_${location.longitude}_${timestamp}`;
  }

  /**
   * Calculate data hash for integrity verification
   */
  calculateDataHash(data) {
    const crypto = require('crypto');
    const dataString = JSON.stringify(data, Object.keys(data).sort());
    return crypto.createHash('sha256').update(dataString).digest('hex');
  }

  /**
   * Start real-time data ingestion
   */
  async startRealTimeIngestion() {
    // Implementation for continuous data streaming
    this.logger.info('Real-time ingestion started');
  }

  /**
   * Start batch processing
   */
  async startBatchProcessing() {
    // Implementation for scheduled batch processing
    this.logger.info('Batch processing started');
  }

  /**
   * Update processing statistics
   */
  updateProcessingStats(data) {
    this.stats.totalProcessed++;
  }

  /**
   * Update average processing time
   */
  updateProcessingTime(time) {
    const count = this.stats.totalProcessed;
    this.stats.avgProcessingTime =
      (this.stats.avgProcessingTime * (count - 1) + time) / count;
  }

  /**
   * Get pipeline statistics
   */
  getStats() {
    return {
      ...this.stats,
      isRunning: this.isRunning,
      avgQualityScore:
        this.stats.qualityScores.length > 0
          ? this.stats.qualityScores.reduce((a, b) => a + b) /
            this.stats.qualityScores.length
          : 0,
      successRate:
        this.stats.totalProcessed > 0
          ? this.stats.successfulIngestions / this.stats.totalProcessed
          : 0,
    };
  }

  /**
   * Get pipeline health status
   */
  getHealth() {
    const stats = this.getStats();
    const health = {
      status: this.isRunning ? 'running' : 'stopped',
      healthy: stats.successRate > 0.8,
      lastProcessed: stats.lastProcessedAt,
      totalProcessed: stats.totalProcessed,
      avgQualityScore: stats.avgQualityScore,
      avgProcessingTime: stats.avgProcessingTime,
    };

    return health;
  }
}

module.exports = { DataIngestionPipeline };
