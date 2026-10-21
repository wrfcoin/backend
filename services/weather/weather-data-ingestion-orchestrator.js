/**
 * Weather Data Ingestion Orchestrator
 *
 * Main orchestrator service that coordinates the entire weather data ingestion pipeline.
 * Handles data flow from external sources through transformation, cleaning, validation,
 * and storage in the WRFCoin database.
 */

const { logger } = require('../../utils/logger');
const WeatherDataTransformer = require('./weather-data-transformer');
const WeatherDataCleaner = require('./weather-data-cleaner');
const WeatherIngestionValidator = require('./weather-ingestion-validator');
const NOAAWeatherService = require('./noaa-nws-api-service');
const NOAADataService = require('./noaa-data-service');

class WeatherDataIngestionOrchestrator {
  constructor() {
    // Initialize pipeline components
    this.transformer = new WeatherDataTransformer();
    this.cleaner = new WeatherDataCleaner();
    this.validator = new WeatherIngestionValidator();

    // Initialize data sources
    this.dataSources = {
      'NOAA-NWS': new NOAAWeatherService(),
      'NOAA-NCEI': new NOAADataService(),
    };

    // Pipeline configuration
    this.config = {
      enableParallelProcessing: true,
      batchSize: 10,
      maxRetries: 3,
      retryDelay: 1000,
      enableMetrics: true,
      enableCaching: true,
      storageEnabled: true,
    };

    // Metrics tracking
    this.metrics = {
      totalProcessed: 0,
      totalIngested: 0,
      totalRejected: 0,
      processingTime: [],
      errorCounts: {},
      qualityDistribution: {},
    };

    // Pipeline state
    this.isRunning = false;
    this.lastIngestionTime = null;
    this.activeJobs = new Map();
  }

  /**
   * Main ingestion method - orchestrates the entire pipeline
   */
  async ingestWeatherData(source, rawData, options = {}) {
    const jobId = this.generateJobId();
    const startTime = Date.now();

    const {
      enableTransformation = true,
      enableCleaning = true,
      enableValidation = true,
      enableStorage = true,
      strictMode = false,
      previousData = null,
    } = options;

    const ingestionResult = {
      jobId,
      source,
      success: false,
      data: null,
      errors: [],
      warnings: [],
      metrics: {
        startTime: new Date(startTime).toISOString(),
        processingTime: 0,
        pipelineSteps: [],
      },
      pipeline: {
        transformation: { completed: false, result: null },
        cleaning: { completed: false, result: null },
        validation: { completed: false, result: null },
        storage: { completed: false, result: null },
      },
    };

    try {
      this.activeJobs.set(jobId, ingestionResult);
      logger.info('Starting weather data ingestion', { jobId, source });

      // Step 1: Data Transformation
      if (enableTransformation) {
        const transformStep = await this.executeTransformation(
          rawData,
          source,
          options
        );
        ingestionResult.pipeline.transformation = transformStep;
        ingestionResult.metrics.pipelineSteps.push({
          step: 'transformation',
          duration: transformStep.duration,
          success: transformStep.completed,
        });

        if (!transformStep.completed || !transformStep.result?.success) {
          throw new Error(
            `Transformation failed: ${transformStep.result?.errors?.join(', ') || 'Unknown error'}`
          );
        }

        ingestionResult.data = transformStep.result.transformedData;
      } else {
        ingestionResult.data = rawData;
      }

      // Step 2: Data Cleaning (optional)
      if (enableCleaning && ingestionResult.data) {
        const cleaningStep = await this.executeCleaning(
          ingestionResult.data,
          options
        );
        ingestionResult.pipeline.cleaning = cleaningStep;
        ingestionResult.metrics.pipelineSteps.push({
          step: 'cleaning',
          duration: cleaningStep.duration,
          success: cleaningStep.completed,
        });

        if (cleaningStep.completed && cleaningStep.result) {
          ingestionResult.data = cleaningStep.result.cleanedData;
          if (cleaningStep.result.warnings?.length > 0) {
            ingestionResult.warnings.push(...cleaningStep.result.warnings);
          }
        }
      }

      // Step 3: Data Validation
      if (enableValidation && ingestionResult.data) {
        const validationStep = await this.executeValidation(
          ingestionResult.data,
          options
        );
        ingestionResult.pipeline.validation = validationStep;
        ingestionResult.metrics.pipelineSteps.push({
          step: 'validation',
          duration: validationStep.duration,
          success: validationStep.completed,
        });

        if (!validationStep.completed || !validationStep.result?.canIngest) {
          if (strictMode) {
            throw new Error('Validation failed: Data cannot be ingested');
          } else {
            ingestionResult.warnings.push(
              'Validation warnings present but data ingested in non-strict mode'
            );
          }
        }

        if (validationStep.result?.warnings?.length > 0) {
          ingestionResult.warnings.push(...validationStep.result.warnings);
        }
      }

      // Step 4: Data Storage
      if (enableStorage && ingestionResult.data) {
        const storageStep = await this.executeStorage(
          ingestionResult.data,
          options
        );
        ingestionResult.pipeline.storage = storageStep;
        ingestionResult.metrics.pipelineSteps.push({
          step: 'storage',
          duration: storageStep.duration,
          success: storageStep.completed,
        });

        if (!storageStep.completed) {
          throw new Error(
            `Storage failed: ${storageStep.error || 'Unknown storage error'}`
          );
        }
      }

      // Mark as successful
      ingestionResult.success = true;
      this.updateMetrics(ingestionResult, true);

      const endTime = Date.now();
      ingestionResult.metrics.processingTime = endTime - startTime;
      ingestionResult.metrics.endTime = new Date(endTime).toISOString();

      logger.info('Weather data ingestion completed successfully', {
        jobId,
        source,
        processingTime: ingestionResult.metrics.processingTime,
        warnings: ingestionResult.warnings.length,
      });

      return ingestionResult;
    } catch (error) {
      logger.error('Weather data ingestion failed', {
        jobId,
        source,
        error: error.message,
        processingTime: Date.now() - startTime,
      });

      ingestionResult.errors.push(error.message);
      ingestionResult.success = false;
      this.updateMetrics(ingestionResult, false);

      const endTime = Date.now();
      ingestionResult.metrics.processingTime = endTime - startTime;
      ingestionResult.metrics.endTime = new Date(endTime).toISOString();

      return ingestionResult;
    } finally {
      this.activeJobs.delete(jobId);
      this.lastIngestionTime = new Date();
    }
  }

  /**
   * Execute transformation step
   */
  async executeTransformation(rawData, source, options) {
    const startTime = Date.now();

    try {
      const result = await this.transformer.transformWeatherData(
        rawData,
        source,
        {
          enableCleaning: false, // We'll do cleaning separately
          enableValidation: false,
          strictMode: options.strictMode,
          preserveOriginal: false,
        }
      );

      return {
        completed: result.success,
        result,
        duration: Date.now() - startTime,
        error: result.success ? null : result.errors?.join(', '),
      };
    } catch (error) {
      return {
        completed: false,
        result: null,
        duration: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * Execute cleaning step
   */
  async executeCleaning(data, options) {
    const startTime = Date.now();

    try {
      const result = await this.cleaner.cleanWeatherRecord(data, {
        enableMissingValueHandling: true,
        enableUnitConversion: true,
        enableOutlierDetection: true,
        enableNormalization: true,
        strictMode: options.strictMode,
      });

      return {
        completed: true,
        result,
        duration: Date.now() - startTime,
        error: null,
      };
    } catch (error) {
      return {
        completed: false,
        result: null,
        duration: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * Execute validation step
   */
  async executeValidation(data, options) {
    const startTime = Date.now();

    try {
      const result = await this.validator.validateIngestionData(data, {
        enableSourceValidation: true,
        enableFreshnessValidation: true,
        enableCompletenessValidation: true,
        enableConsistencyValidation: true,
        enablePhysicsValidation: true,
        strictMode: options.strictMode,
        previousData: options.previousData,
      });

      return {
        completed: true,
        result,
        duration: Date.now() - startTime,
        error: null,
      };
    } catch (error) {
      return {
        completed: false,
        result: null,
        duration: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * Execute storage step
   */
  async executeStorage(data, options) {
    const startTime = Date.now();

    try {
      // For now, we'll log the storage operation
      // In a real implementation, this would save to PostgreSQL/TimescaleDB
      logger.info('Storing weather data', {
        sourceId: data.metadata?.sourceId,
        provider: data.metadata?.provider,
        timestamp: data.metadata?.timestamp,
        measurements: Object.keys(data.measurements || {}).length,
      });

      // Simulate storage operation
      await new Promise(resolve => setTimeout(resolve, 50));

      return {
        completed: true,
        result: {
          stored: true,
          recordId: this.generateRecordId(),
          timestamp: new Date().toISOString(),
        },
        duration: Date.now() - startTime,
        error: null,
      };
    } catch (error) {
      return {
        completed: false,
        result: null,
        duration: Date.now() - startTime,
        error: error.message,
      };
    }
  }

  /**
   * Ingest weather data from multiple sources in batch
   */
  async ingestWeatherBatch(dataArray, options = {}) {
    const {
      enableParallelProcessing = this.config.enableParallelProcessing,
      batchSize = this.config.batchSize,
    } = options;

    const results = [];

    if (enableParallelProcessing) {
      // Process in parallel batches
      for (let i = 0; i < dataArray.length; i += batchSize) {
        const batch = dataArray.slice(i, i + batchSize);
        const batchPromises = batch.map(
          ({ source, rawData, options: itemOptions }) =>
            this.ingestWeatherData(source, rawData, {
              ...options,
              ...itemOptions,
            })
        );

        try {
          const batchResults = await Promise.allSettled(batchPromises);
          batchResults.forEach(result => {
            if (result.status === 'fulfilled') {
              results.push(result.value);
            } else {
              results.push({
                success: false,
                errors: [
                  result.reason?.message || 'Unknown batch processing error',
                ],
                metrics: { processingTime: 0 },
              });
            }
          });
        } catch (error) {
          logger.error('Batch processing error:', {
            error: error.message,
            batchStart: i,
          });
        }
      }
    } else {
      // Process sequentially
      for (const { source, rawData, options: itemOptions } of dataArray) {
        try {
          const result = await this.ingestWeatherData(source, rawData, {
            ...options,
            ...itemOptions,
          });
          results.push(result);
        } catch (error) {
          results.push({
            success: false,
            errors: [error.message],
            metrics: { processingTime: 0 },
          });
        }
      }
    }

    return results;
  }

  /**
   * Fetch and ingest data from a specific source
   */
  async fetchAndIngestFromSource(sourceType, location, options = {}) {
    const { dataType = 'current', startDate = null, endDate = null } = options;

    try {
      const dataSource = this.dataSources[sourceType];
      if (!dataSource) {
        throw new Error(`Unsupported data source: ${sourceType}`);
      }

      let rawData;

      // Fetch data based on type
      if (dataType === 'current') {
        if (sourceType === 'NOAA-NWS') {
          rawData = await dataSource.getCurrentObservations(
            location.latitude,
            location.longitude
          );
        } else {
          throw new Error(
            `Current data not supported for source: ${sourceType}`
          );
        }
      } else if (dataType === 'historical') {
        if (sourceType === 'NOAA-NCEI') {
          // Find stations first
          const stationsResult = await dataSource.findStationsNearLocation(
            location.latitude,
            location.longitude,
            50,
            5
          );

          if (stationsResult.stations.length === 0) {
            throw new Error('No weather stations found near location');
          }

          rawData = await dataSource.getHistoricalData({
            dataset: 'GHCND',
            stations: stationsResult.stations[0].id,
            startDate,
            endDate,
            dataTypes: ['TMAX', 'TMIN', 'PRCP'],
          });
        } else {
          throw new Error(
            `Historical data not supported for source: ${sourceType}`
          );
        }
      } else {
        throw new Error(`Unsupported data type: ${dataType}`);
      }

      // Ingest the fetched data
      return await this.ingestWeatherData(sourceType, rawData, options);
    } catch (error) {
      logger.error('Fetch and ingest failed:', {
        sourceType,
        location,
        error: error.message,
      });

      return {
        success: false,
        errors: [error.message],
        source: sourceType,
        metrics: { processingTime: 0 },
      };
    }
  }

  /**
   * Schedule periodic ingestion from multiple sources
   */
  async schedulePeriodicIngestion(sources, intervalMinutes = 60) {
    logger.info('Starting periodic weather data ingestion', {
      sources: sources.length,
      intervalMinutes,
    });

    const interval = setInterval(
      async () => {
        if (this.isRunning) {
          logger.warn('Previous ingestion still running, skipping this cycle');
          return;
        }

        this.isRunning = true;

        try {
          const ingestionPromises = sources.map(async sourceConfig => {
            try {
              return await this.fetchAndIngestFromSource(
                sourceConfig.type,
                sourceConfig.location,
                sourceConfig.options
              );
            } catch (error) {
              logger.error('Periodic ingestion error:', {
                source: sourceConfig.type,
                error: error.message,
              });
              return { success: false, errors: [error.message] };
            }
          });

          const results = await Promise.allSettled(ingestionPromises);

          const successful = results.filter(
            r => r.status === 'fulfilled' && r.value.success
          ).length;
          const failed = results.length - successful;

          logger.info('Periodic ingestion cycle completed', {
            successful,
            failed,
            total: results.length,
          });
        } catch (error) {
          logger.error('Periodic ingestion cycle failed:', {
            error: error.message,
          });
        } finally {
          this.isRunning = false;
        }
      },
      intervalMinutes * 60 * 1000
    );

    return interval;
  }

  /**
   * Update metrics
   */
  updateMetrics(ingestionResult, success) {
    this.metrics.totalProcessed++;

    if (success) {
      this.metrics.totalIngested++;
    } else {
      this.metrics.totalRejected++;
    }

    this.metrics.processingTime.push(ingestionResult.metrics.processingTime);

    // Track quality distribution
    const qualityLevel =
      ingestionResult.pipeline.validation?.result?.qualityLevel;
    if (qualityLevel) {
      this.metrics.qualityDistribution[qualityLevel] =
        (this.metrics.qualityDistribution[qualityLevel] || 0) + 1;
    }

    // Track error types
    ingestionResult.errors.forEach(error => {
      const errorType = error.split(':')[0];
      this.metrics.errorCounts[errorType] =
        (this.metrics.errorCounts[errorType] || 0) + 1;
    });
  }

  /**
   * Get orchestrator status and metrics
   */
  getStatus() {
    const avgProcessingTime =
      this.metrics.processingTime.length > 0
        ? this.metrics.processingTime.reduce((a, b) => a + b, 0) /
          this.metrics.processingTime.length
        : 0;

    return {
      isRunning: this.isRunning,
      lastIngestionTime: this.lastIngestionTime,
      activeJobs: this.activeJobs.size,
      metrics: {
        ...this.metrics,
        averageProcessingTime: Math.round(avgProcessingTime),
        successRate:
          this.metrics.totalProcessed > 0
            ? this.metrics.totalIngested / this.metrics.totalProcessed
            : 0,
      },
      config: this.config,
    };
  }

  /**
   * Get detailed statistics
   */
  getDetailedStatistics() {
    const status = this.getStatus();

    return {
      ...status,
      pipeline: {
        supportedSources: Object.keys(this.dataSources),
        transformationSupport: this.transformer.supportedSources,
        validationRules: this.validator.ingestionRules,
      },
      performance: {
        processingTimeDistribution: this.calculateProcessingTimeDistribution(),
        qualityTrends: this.metrics.qualityDistribution,
        errorAnalysis: this.metrics.errorCounts,
      },
    };
  }

  /**
   * Calculate processing time distribution
   */
  calculateProcessingTimeDistribution() {
    if (this.metrics.processingTime.length === 0) {
      return { min: 0, max: 0, median: 0, p95: 0, p99: 0 };
    }

    const sorted = [...this.metrics.processingTime].sort((a, b) => a - b);
    const len = sorted.length;

    return {
      min: sorted[0],
      max: sorted[len - 1],
      median: sorted[Math.floor(len / 2)],
      p95: sorted[Math.floor(len * 0.95)],
      p99: sorted[Math.floor(len * 0.99)],
    };
  }

  // Helper methods

  generateJobId() {
    return `job-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  generateRecordId() {
    return `rec-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`;
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    this.metrics = {
      totalProcessed: 0,
      totalIngested: 0,
      totalRejected: 0,
      processingTime: [],
      errorCounts: {},
      qualityDistribution: {},
    };
  }

  /**
   * Shutdown orchestrator gracefully
   */
  async shutdown() {
    this.isRunning = false;

    // Wait for active jobs to complete
    while (this.activeJobs.size > 0) {
      logger.info(
        `Waiting for ${this.activeJobs.size} active jobs to complete...`
      );
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    logger.info('Weather data ingestion orchestrator shutdown complete');
  }
}

module.exports = WeatherDataIngestionOrchestrator;
