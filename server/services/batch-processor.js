/**
 * WRFCoin Batch Processing System
 *
 * Comprehensive batch processing system for historical weather data ingestion,
 * bulk data processing, and scheduled data operations.
 *
 * Features:
 * - Historical data bulk ingestion from NOAA APIs
 * - Configurable batch sizes and processing windows
 * - Progress tracking and resumable operations
 * - Parallel processing with concurrency control
 * - Error handling and retry mechanisms
 * - Data deduplication and integrity checks
 * - Scheduling and automation capabilities
 */

const EventEmitter = require('events');
const moment = require('moment');
const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require('worker_threads');
const path = require('path');
const fs = require('fs').promises;
const { NOAADataService } = require('./noaa-data-service');
const { DataPreprocessor } = require('./data-preprocessor');
const { DataIngestionPipeline } = require('./data-ingestion-pipeline');
const { DatabaseManager } = require('../database/database-manager');
const Logger = require('../utils/logger');

class BatchProcessor extends EventEmitter {
  constructor(options = {}) {
    super();

    this.options = {
      // Batch processing settings
      batchSize: options.batchSize || 50,
      maxConcurrency: options.maxConcurrency || 3,
      maxRetries: options.maxRetries || 3,
      retryDelay: options.retryDelay || 5000,

      // Progress tracking
      saveProgressInterval: options.saveProgressInterval || 100, // Save progress every N records
      progressFile: options.progressFile || '.taskmaster/batch_progress.json',

      // Data processing
      enableValidation: options.enableValidation !== false,
      enableDeduplication: options.enableDeduplication !== false,
      skipExistingData: options.skipExistingData !== false,

      // Worker settings
      useWorkers: options.useWorkers !== false,
      workerTimeout: options.workerTimeout || 60000, // 1 minute

      // Time range settings
      defaultStartDate: options.defaultStartDate || '2020-01-01',
      defaultEndDate: options.defaultEndDate || moment().format('YYYY-MM-DD'),
      maxDateRange: options.maxDateRange || 365, // Maximum days per batch

      ...options,
    };

    this.logger = Logger;
    this.noaaDataService = new NOAADataService();
    this.preprocessor = new DataPreprocessor();
    this.databaseManager = new DatabaseManager();
    this.ingestionPipeline = null;

    // Batch state
    this.isRunning = false;
    this.currentBatch = null;
    this.workers = new Map();
    this.progress = {
      totalRecords: 0,
      processedRecords: 0,
      successfulRecords: 0,
      failedRecords: 0,
      skippedRecords: 0,
      startTime: null,
      lastSaveTime: null,
      currentOperation: null,
      batches: [],
    };

    // Performance metrics
    this.metrics = {
      avgProcessingTime: 0,
      avgBatchTime: 0,
      recordsPerSecond: 0,
      totalProcessingTime: 0,
      peakMemoryUsage: 0,
    };
  }

  /**
   * Initialize the batch processor
   */
  async initialize() {
    try {
      this.logger.info('Initializing Batch Processor...');

      // Initialize database connection
      await this.databaseManager.connect();

      // Initialize ingestion pipeline
      this.ingestionPipeline = new DataIngestionPipeline({
        batchEnabled: true,
        realTimeEnabled: false,
      });
      await this.ingestionPipeline.initialize();

      // Load previous progress if exists
      await this.loadProgress();

      this.logger.info('Batch Processor initialized successfully');
      this.emit('initialized');
    } catch (error) {
      this.logger.error('Failed to initialize Batch Processor:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Process historical data in batches
   */
  async processHistoricalData(request) {
    const {
      locations = [],
      startDate = this.options.defaultStartDate,
      endDate = this.options.defaultEndDate,
      dataTypes = ['TMAX', 'TMIN', 'PRCP', 'AWND'],
      resumeFromProgress = true,
    } = request;

    if (this.isRunning) {
      throw new Error('Batch processor is already running');
    }

    try {
      this.isRunning = true;
      this.progress.startTime = new Date();
      this.progress.currentOperation = 'historical_data_processing';

      this.logger.info(
        `Starting historical data processing: ${startDate} to ${endDate}`
      );

      // Validate date range
      const dateRange = moment(endDate).diff(moment(startDate), 'days');
      if (dateRange > this.options.maxDateRange) {
        throw new Error(
          `Date range too large: ${dateRange} days (max: ${this.options.maxDateRange})`
        );
      }

      // Generate location-date batches
      const batches = await this.generateBatches(
        locations,
        startDate,
        endDate,
        dataTypes
      );
      this.progress.totalRecords = batches.reduce(
        (sum, batch) => sum + batch.estimatedRecords,
        0
      );

      this.logger.info(`Generated ${batches.length} batches for processing`);

      // Process batches
      for (let i = 0; i < batches.length; i++) {
        const batch = batches[i];

        // Skip if resuming and batch already processed
        if (resumeFromProgress && this.isBatchProcessed(batch)) {
          this.logger.info(
            `Skipping already processed batch ${i + 1}/${batches.length}`
          );
          continue;
        }

        this.currentBatch = { ...batch, index: i + 1, total: batches.length };

        try {
          await this.processBatch(batch);
          this.markBatchProcessed(batch);
        } catch (error) {
          this.logger.error(`Error processing batch ${i + 1}:`, error);

          if (batch.retryCount < this.options.maxRetries) {
            batch.retryCount = (batch.retryCount || 0) + 1;
            this.logger.info(
              `Retrying batch ${i + 1} (attempt ${batch.retryCount})`
            );
            i--; // Retry the same batch
            await this.delay(this.options.retryDelay);
          } else {
            this.logger.error(
              `Max retries exceeded for batch ${i + 1}, skipping`
            );
            this.progress.failedRecords += batch.estimatedRecords;
          }
        }

        // Save progress periodically
        if ((i + 1) % this.options.saveProgressInterval === 0) {
          await this.saveProgress();
        }

        // Emit progress event
        this.emit('batch-completed', {
          batch: i + 1,
          total: batches.length,
          progress: this.getProgressPercentage(),
        });
      }

      // Final progress save
      await this.saveProgress();

      const summary = this.getProcessingSummary();
      this.logger.info('Historical data processing completed:', summary);

      this.emit('processing-completed', summary);
      return summary;
    } catch (error) {
      this.logger.error('Error during historical data processing:', error);
      this.emit('error', error);
      throw error;
    } finally {
      this.isRunning = false;
      this.currentBatch = null;
    }
  }

  /**
   * Generate processing batches from locations and date ranges
   */
  async generateBatches(locations, startDate, endDate, dataTypes) {
    const batches = [];

    for (const location of locations) {
      // Split date range into manageable chunks
      const dateChunks = this.splitDateRange(
        startDate,
        endDate,
        this.options.batchSize
      );

      for (const dateChunk of dateChunks) {
        const batch = {
          id: `${location.id || location.stationId}_${dateChunk.start}_${dateChunk.end}`,
          location,
          startDate: dateChunk.start,
          endDate: dateChunk.end,
          dataTypes,
          estimatedRecords: dateChunk.days * dataTypes.length,
          status: 'pending',
          createdAt: new Date().toISOString(),
        };

        batches.push(batch);
      }
    }

    return batches;
  }

  /**
   * Split date range into smaller chunks
   */
  splitDateRange(startDate, endDate, maxDaysPerChunk) {
    const chunks = [];
    let current = moment(startDate);
    const end = moment(endDate);

    while (current.isBefore(end)) {
      const chunkEnd = moment.min(
        current.clone().add(maxDaysPerChunk, 'days'),
        end
      );

      chunks.push({
        start: current.format('YYYY-MM-DD'),
        end: chunkEnd.format('YYYY-MM-DD'),
        days: chunkEnd.diff(current, 'days') + 1,
      });

      current = chunkEnd.clone().add(1, 'day');
    }

    return chunks;
  }

  /**
   * Process a single batch
   */
  async processBatch(batch) {
    const startTime = Date.now();

    try {
      this.logger.info(`Processing batch: ${batch.id}`);

      // Fetch historical data from NOAA
      const rawData = await this.fetchBatchData(batch);

      if (!rawData || rawData.length === 0) {
        this.logger.warn(`No data returned for batch: ${batch.id}`);
        this.progress.skippedRecords += batch.estimatedRecords;
        return;
      }

      // Process data in parallel if workers are enabled
      let processedData;
      if (this.options.useWorkers && rawData.length > 10) {
        processedData = await this.processWithWorkers(rawData, batch);
      } else {
        processedData = await this.processInMainThread(rawData, batch);
      }

      // Store processed data
      const storageResults = await this.storeProcessedData(
        processedData,
        batch
      );

      // Update progress
      this.progress.processedRecords += processedData.length;
      this.progress.successfulRecords += storageResults.successful;
      this.progress.failedRecords += storageResults.failed;

      const processingTime = Date.now() - startTime;
      this.updateMetrics(processingTime, processedData.length);

      this.logger.info(
        `Batch ${batch.id} completed: ${processedData.length} records in ${processingTime}ms`
      );
    } catch (error) {
      this.logger.error(`Error processing batch ${batch.id}:`, error);
      throw error;
    }
  }

  /**
   * Fetch data for a batch from NOAA APIs
   */
  async fetchBatchData(batch) {
    try {
      const { location, startDate, endDate, dataTypes } = batch;

      // Use NOAA Data Service for historical data
      const data = await this.noaaDataService.getHistoricalData(location, {
        startDate,
        endDate,
        dataTypes,
        includeStationMetadata: true,
      });

      return Array.isArray(data) ? data : [data];
    } catch (error) {
      this.logger.error(`Error fetching batch data for ${batch.id}:`, error);
      throw error;
    }
  }

  /**
   * Process data using worker threads
   */
  async processWithWorkers(rawData, batch) {
    const workerCount = Math.min(
      this.options.maxConcurrency,
      Math.ceil(rawData.length / 10)
    );
    const dataChunks = this.chunkArray(
      rawData,
      Math.ceil(rawData.length / workerCount)
    );

    const workerPromises = dataChunks.map((chunk, index) => {
      return this.processChunkWithWorker(chunk, batch, index);
    });

    const results = await Promise.allSettled(workerPromises);

    // Combine results and handle failures
    const processedData = [];
    for (const result of results) {
      if (result.status === 'fulfilled') {
        processedData.push(...result.value);
      } else {
        this.logger.error('Worker processing failed:', result.reason);
      }
    }

    return processedData;
  }

  /**
   * Process data chunk with a worker thread
   */
  async processChunkWithWorker(dataChunk, batch, index) {
    return new Promise((resolve, reject) => {
      const workerPath = path.join(
        __dirname,
        'worker-threads',
        'data-processing-worker.js'
      );

      const worker = new Worker(workerPath, {
        workerData: {
          dataChunk,
          batch,
          options: this.options,
          index,
        },
      });

      const workerId = `worker_${batch.id}_${index}`;
      this.workers.set(workerId, worker);

      const timeout = setTimeout(() => {
        worker.terminate();
        this.workers.delete(workerId);
        reject(new Error(`Worker ${workerId} timed out`));
      }, this.options.workerTimeout);

      worker.on('message', result => {
        clearTimeout(timeout);
        this.workers.delete(workerId);
        resolve(result);
      });

      worker.on('error', error => {
        clearTimeout(timeout);
        this.workers.delete(workerId);
        reject(error);
      });

      worker.on('exit', code => {
        clearTimeout(timeout);
        this.workers.delete(workerId);
        if (code !== 0) {
          reject(new Error(`Worker ${workerId} exited with code ${code}`));
        }
      });
    });
  }

  /**
   * Process data in main thread
   */
  async processInMainThread(rawData, batch) {
    const processedData = [];

    for (const dataItem of rawData) {
      try {
        // Skip if data already exists and skipExistingData is enabled
        if (
          this.options.skipExistingData &&
          (await this.dataExists(dataItem))
        ) {
          this.progress.skippedRecords++;
          continue;
        }

        // Preprocess data
        const processed = await this.preprocessor.process(dataItem, {
          source: 'noaa-ncei',
          normalizeUnits: true,
          validateFormat: true,
          enrichData: true,
        });

        if (processed) {
          processedData.push(processed);
        }
      } catch (error) {
        this.logger.error('Error processing data item:', error);
        this.progress.failedRecords++;
      }
    }

    return processedData;
  }

  /**
   * Store processed data in database
   */
  async storeProcessedData(processedData, batch) {
    let successful = 0;
    let failed = 0;

    // Process in chunks to avoid overwhelming the database
    const storageChunks = this.chunkArray(processedData, 20);

    for (const chunk of storageChunks) {
      try {
        const results = await Promise.allSettled(
          chunk.map(data => this.storeDataItem(data, batch))
        );

        for (const result of results) {
          if (result.status === 'fulfilled') {
            successful++;
          } else {
            failed++;
            this.logger.error('Storage error:', result.reason);
          }
        }
      } catch (error) {
        this.logger.error('Chunk storage error:', error);
        failed += chunk.length;
      }
    }

    return { successful, failed };
  }

  /**
   * Store individual data item
   */
  async storeDataItem(data, batch) {
    try {
      // Convert to database format using the ingestion pipeline
      const dbRecord = this.formatForDatabase(data, {
        batch: batch.id,
        source: 'batch_processing',
        qualityScore: data.quality?.confidence || 0.8,
      });

      // Insert into database
      const result = await this.databaseManager.insertWeatherData(dbRecord);
      return result;
    } catch (error) {
      // Check if error is due to duplicate data
      if (error.code === '23505' || error.message.includes('duplicate')) {
        this.progress.skippedRecords++;
        return null; // Skip duplicates
      }
      throw error;
    }
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
      source_type: 'batch_noaa_ncei',
      metadata: {
        batchId: metadata.batch,
        qualityScore: metadata.qualityScore,
        processingTimestamp: new Date().toISOString(),
        source: metadata.source,
      },
    };
  }

  /**
   * Generate unique data ID
   */
  generateDataId(data) {
    const { location, timestamp, source } = data;
    return `batch_${source}_${location.latitude}_${location.longitude}_${timestamp}`;
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
   * Check if data already exists in database
   */
  async dataExists(dataItem) {
    try {
      const dataId = this.generateDataId(dataItem);
      const existing =
        await this.databaseManager.findWeatherDataByDataId(dataId);
      return !!existing;
    } catch (error) {
      this.logger.error('Error checking data existence:', error);
      return false;
    }
  }

  /**
   * Split array into chunks
   */
  chunkArray(array, chunkSize) {
    const chunks = [];
    for (let i = 0; i < array.length; i += chunkSize) {
      chunks.push(array.slice(i, i + chunkSize));
    }
    return chunks;
  }

  /**
   * Check if batch is already processed
   */
  isBatchProcessed(batch) {
    return this.progress.batches.some(
      b => b.id === batch.id && b.status === 'completed'
    );
  }

  /**
   * Mark batch as processed
   */
  markBatchProcessed(batch) {
    const existingIndex = this.progress.batches.findIndex(
      b => b.id === batch.id
    );
    const batchRecord = {
      id: batch.id,
      status: 'completed',
      completedAt: new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      this.progress.batches[existingIndex] = batchRecord;
    } else {
      this.progress.batches.push(batchRecord);
    }
  }

  /**
   * Update performance metrics
   */
  updateMetrics(processingTime, recordCount) {
    this.metrics.totalProcessingTime += processingTime;
    this.metrics.avgProcessingTime =
      this.metrics.totalProcessingTime / this.progress.processedRecords;
    this.metrics.recordsPerSecond = recordCount / (processingTime / 1000);

    // Update memory usage
    const memUsage = process.memoryUsage();
    this.metrics.peakMemoryUsage = Math.max(
      this.metrics.peakMemoryUsage,
      memUsage.heapUsed
    );
  }

  /**
   * Save progress to file
   */
  async saveProgress() {
    try {
      const progressData = {
        ...this.progress,
        lastSaveTime: new Date().toISOString(),
        metrics: this.metrics,
      };

      await fs.writeFile(
        this.options.progressFile,
        JSON.stringify(progressData, null, 2)
      );
    } catch (error) {
      this.logger.error('Error saving progress:', error);
    }
  }

  /**
   * Load progress from file
   */
  async loadProgress() {
    try {
      const progressData = await fs.readFile(this.options.progressFile, 'utf8');
      const parsed = JSON.parse(progressData);

      this.progress = { ...this.progress, ...parsed };
      if (parsed.metrics) {
        this.metrics = { ...this.metrics, ...parsed.metrics };
      }

      this.logger.info('Progress loaded from previous session');
    } catch (error) {
      if (error.code !== 'ENOENT') {
        this.logger.error('Error loading progress:', error);
      }
    }
  }

  /**
   * Get progress percentage
   */
  getProgressPercentage() {
    if (this.progress.totalRecords === 0) return 0;
    return Math.round(
      (this.progress.processedRecords / this.progress.totalRecords) * 100
    );
  }

  /**
   * Get processing summary
   */
  getProcessingSummary() {
    const totalTime = this.progress.startTime
      ? Date.now() - new Date(this.progress.startTime).getTime()
      : 0;

    return {
      totalRecords: this.progress.totalRecords,
      processedRecords: this.progress.processedRecords,
      successfulRecords: this.progress.successfulRecords,
      failedRecords: this.progress.failedRecords,
      skippedRecords: this.progress.skippedRecords,
      successRate:
        this.progress.processedRecords > 0
          ? this.progress.successfulRecords / this.progress.processedRecords
          : 0,
      totalProcessingTime: totalTime,
      avgRecordsPerSecond:
        totalTime > 0 ? this.progress.processedRecords / (totalTime / 1000) : 0,
      metrics: this.metrics,
      isComplete: this.progress.processedRecords >= this.progress.totalRecords,
    };
  }

  /**
   * Stop batch processing
   */
  async stop() {
    if (!this.isRunning) {
      this.logger.warn('Batch processor is not running');
      return;
    }

    try {
      this.logger.info('Stopping batch processor...');

      // Terminate all workers
      for (const [workerId, worker] of this.workers) {
        await worker.terminate();
        this.logger.info(`Worker ${workerId} terminated`);
      }
      this.workers.clear();

      // Save current progress
      await this.saveProgress();

      this.isRunning = false;
      this.currentBatch = null;

      this.logger.info('Batch processor stopped');
      this.emit('stopped');
    } catch (error) {
      this.logger.error('Error stopping batch processor:', error);
      this.emit('error', error);
      throw error;
    }
  }

  /**
   * Get current status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      currentBatch: this.currentBatch,
      progress: this.progress,
      metrics: this.metrics,
      progressPercentage: this.getProgressPercentage(),
      activeWorkers: this.workers.size,
    };
  }

  /**
   * Utility delay function
   */
  delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

module.exports = { BatchProcessor };
