/**
 * WRFCoin Data Ingestion Controller
 *
 * Main controller that integrates all data ingestion pipeline components.
 * Provides RESTful API endpoints for managing data ingestion, processing, and monitoring.
 *
 * Features:
 * - Unified API for all pipeline operations
 * - Real-time and batch processing endpoints
 * - Data quality assessment and monitoring
 * - Pipeline status and health monitoring
 * - Integration with existing WRFCoin validation framework
 */

const {
  DataIngestionPipeline,
} = require('../services/data-ingestion-pipeline');
const { BatchProcessor } = require('../services/batch-processor');
const {
  RealTimeStreamProcessor,
} = require('../services/realtime-stream-processor');
const { DataQualityEngine } = require('../services/data-quality-engine');
const {
  TemporalSpatialProcessor,
} = require('../services/temporal-spatial-processor');
const {
  WeatherDataValidator,
} = require('../utils/testing/weather-data-validation');
const { DatabaseManager } = require('../database/database-manager');
const Logger = require('../utils/logger');

class DataIngestionController {
  constructor() {
    this.logger = Logger;

    // Initialize core components
    this.pipeline = new DataIngestionPipeline();
    this.batchProcessor = new BatchProcessor();
    this.streamProcessor = new RealTimeStreamProcessor();
    this.qualityEngine = new DataQualityEngine();
    this.spatialProcessor = new TemporalSpatialProcessor();
    this.validator = new WeatherDataValidator();
    this.databaseManager = new DatabaseManager();

    // Controller state
    this.isInitialized = false;
    this.services = new Map();

    // Setup service event listeners
    this.setupEventListeners();
  }

  /**
   * Initialize all pipeline components
   */
  async initialize() {
    try {
      this.logger.info('Initializing Data Ingestion Controller...');

      // Initialize components in order
      await this.databaseManager.connect();
      await this.pipeline.initialize();
      await this.batchProcessor.initialize();
      await this.streamProcessor.initialize();

      // Register services
      this.services.set('pipeline', this.pipeline);
      this.services.set('batch', this.batchProcessor);
      this.services.set('stream', this.streamProcessor);
      this.services.set('quality', this.qualityEngine);
      this.services.set('spatial', this.spatialProcessor);

      this.isInitialized = true;
      this.logger.info('Data Ingestion Controller initialized successfully');
    } catch (error) {
      this.logger.error(
        'Failed to initialize Data Ingestion Controller:',
        error
      );
      throw error;
    }
  }

  /**
   * Setup event listeners for pipeline components
   */
  setupEventListeners() {
    // Pipeline events
    if (this.pipeline) {
      this.pipeline.on('data-ingested', data => {
        this.logger.debug('Data ingested:', data.data?.location);
      });

      this.pipeline.on('error', error => {
        this.logger.error('Pipeline error:', error);
      });
    }

    // Batch processor events
    if (this.batchProcessor) {
      this.batchProcessor.on('batch-completed', progress => {
        this.logger.info(
          `Batch progress: ${progress.batch}/${progress.total} (${progress.progress}%)`
        );
      });
    }

    // Stream processor events
    if (this.streamProcessor) {
      this.streamProcessor.on('data-processed', data => {
        this.logger.debug('Real-time data processed:', {
          source: data.source,
          qualityScore: data.qualityAssessment?.overallScore,
          enriched: data.data.quality?.enrichment?.enabled,
        });
      });

      this.streamProcessor.on('anomaly-detected', anomaly => {
        this.logger.warn('Anomaly detected:', anomaly);
      });

      this.streamProcessor.on('alert-generated', alert => {
        this.logger.warn('Alert generated:', alert);
      });

      // Quality Assurance events
      this.streamProcessor.on('quality-assessment', assessment => {
        this.logger.debug('Quality assessment completed:', {
          score: assessment.overallScore,
          level: assessment.qualityLevel,
          flags: assessment.flags.length,
        });
      });

      this.streamProcessor.on('advanced-anomaly-detected', result => {
        this.logger.warn('Advanced anomaly detected:', {
          confidence: result.anomalyResults.anomalies.ensemble.confidenceScore,
          anomalies: result.anomalyResults.anomalies.ensemble.anomalies.length,
        });
      });

      this.streamProcessor.on('data-profiled', profileResult => {
        this.logger.info('Data profiling completed:', {
          dataCount: profileResult.dataCount,
          qualityScore: profileResult.profile.quality?.overallScore,
        });
      });

      this.streamProcessor.on('quality-metrics-generated', metrics => {
        this.logger.debug('Quality metrics generated:', {
          averageScore: metrics.averageQualityScore,
          rejectionRate: metrics.rejectionRate,
        });
      });
    }
  }

  /**
   * Ingest data through the main pipeline
   */
  async ingestData(req, res) {
    try {
      if (!this.isInitialized) {
        return res.status(503).json({
          success: false,
          error: 'Data ingestion pipeline not initialized',
        });
      }

      const { sources, options = {} } = req.body;

      if (!sources || !Array.isArray(sources)) {
        return res.status(400).json({
          success: false,
          error: 'Sources array is required',
        });
      }

      // Validate sources
      for (const source of sources) {
        if (!source.type || !source.location) {
          return res.status(400).json({
            success: false,
            error: 'Each source must have type and location',
          });
        }
      }

      // Process ingestion
      const result = await this.pipeline.ingestData(sources, options);

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error in data ingestion:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Start batch processing
   */
  async startBatchProcessing(req, res) {
    try {
      const request = {
        locations: req.body.locations || [],
        startDate: req.body.startDate,
        endDate: req.body.endDate,
        dataTypes: req.body.dataTypes || ['TMAX', 'TMIN', 'PRCP'],
        resumeFromProgress: req.body.resumeFromProgress !== false,
      };

      if (request.locations.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'At least one location is required for batch processing',
        });
      }

      // Start batch processing asynchronously
      this.batchProcessor
        .processHistoricalData(request)
        .then(summary => {
          this.logger.info('Batch processing completed:', summary);
        })
        .catch(error => {
          this.logger.error('Batch processing failed:', error);
        });

      res.json({
        success: true,
        message: 'Batch processing started',
        request,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error starting batch processing:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Start real-time streaming
   */
  async startStreaming(req, res) {
    try {
      const config = {
        locations: req.body.locations || [],
        enableNOAAStreaming: req.body.enableNOAAStreaming !== false,
        enableStationStreaming: req.body.enableStationStreaming !== false,
        enableWebSocketStreaming: req.body.enableWebSocketStreaming || false,
      };

      await this.streamProcessor.startStreaming(config);

      res.json({
        success: true,
        message: 'Real-time streaming started',
        config,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error starting streaming:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Stop real-time streaming
   */
  async stopStreaming(req, res) {
    try {
      await this.streamProcessor.stopStreaming();

      res.json({
        success: true,
        message: 'Real-time streaming stopped',
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error stopping streaming:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Assess data quality
   */
  async assessDataQuality(req, res) {
    try {
      const { data, options = {} } = req.body;

      if (!data) {
        return res.status(400).json({
          success: false,
          error: 'Data is required for quality assessment',
        });
      }

      const assessment = await this.qualityEngine.assessQuality(data, options);

      res.json({
        success: true,
        data: assessment,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error assessing data quality:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Enrich data
   */
  async enrichData(req, res) {
    try {
      const { data, qualityAssessment, options = {} } = req.body;

      if (!data) {
        return res.status(400).json({
          success: false,
          error: 'Data is required for enrichment',
        });
      }

      const enrichedData = await this.qualityEngine.enrichData(
        data,
        qualityAssessment,
        options
      );

      res.json({
        success: true,
        data: enrichedData,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error enriching data:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Perform temporal aggregation
   */
  async aggregateTemporalData(req, res) {
    try {
      const { data, options = {} } = req.body;

      if (!data || !Array.isArray(data)) {
        return res.status(400).json({
          success: false,
          error: 'Data array is required for temporal aggregation',
        });
      }

      const result = await this.spatialProcessor.aggregateTemporalData(
        data,
        options
      );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error in temporal aggregation:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Perform spatial interpolation
   */
  async interpolateSpatialData(req, res) {
    try {
      const { data, targetLocations, options = {} } = req.body;

      if (!data || !Array.isArray(data)) {
        return res.status(400).json({
          success: false,
          error: 'Data array is required for spatial interpolation',
        });
      }

      if (!targetLocations || !Array.isArray(targetLocations)) {
        return res.status(400).json({
          success: false,
          error: 'Target locations array is required',
        });
      }

      const result = await this.spatialProcessor.interpolateSpatialData(
        data,
        targetLocations,
        options
      );

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error in spatial interpolation:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Generate grid data
   */
  async generateGrid(req, res) {
    try {
      const { data, options = {} } = req.body;

      if (!data || !Array.isArray(data)) {
        return res.status(400).json({
          success: false,
          error: 'Data array is required for grid generation',
        });
      }

      const result = await this.spatialProcessor.generateGrid(data, options);

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error generating grid:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Fill missing data
   */
  async fillMissingData(req, res) {
    try {
      const { data, options = {} } = req.body;

      if (!data || !Array.isArray(data)) {
        return res.status(400).json({
          success: false,
          error: 'Data array is required for gap filling',
        });
      }

      const result = await this.spatialProcessor.fillMissingData(data, options);

      res.json({
        success: true,
        data: result,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error filling missing data:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get pipeline status
   */
  async getPipelineStatus(req, res) {
    try {
      const status = {
        initialized: this.isInitialized,
        services: {},
        timestamp: new Date().toISOString(),
      };

      // Get status from each service
      for (const [name, service] of this.services) {
        try {
          status.services[name] = {
            available: true,
            status: service.getStatus ? service.getStatus() : 'running',
            metrics: service.getMetrics ? service.getMetrics() : null,
          };
        } catch (error) {
          status.services[name] = {
            available: false,
            error: error.message,
          };
        }
      }

      // Add database status
      status.database = await this.databaseManager.checkHealth();

      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error getting pipeline status:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get batch processing status
   */
  async getBatchStatus(req, res) {
    try {
      const status = this.batchProcessor.getStatus();

      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error getting batch status:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get streaming status
   */
  async getStreamingStatus(req, res) {
    try {
      const status = this.streamProcessor.getStatus();

      res.json({
        success: true,
        data: status,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error getting streaming status:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get quality metrics
   */
  async getQualityMetrics(req, res) {
    try {
      const metrics = this.qualityEngine.getMetrics();
      const trends = this.qualityEngine.getQualityTrends();

      res.json({
        success: true,
        data: {
          metrics,
          trends,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error getting quality metrics:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get processing metrics
   */
  async getProcessingMetrics(req, res) {
    try {
      const metrics = {
        pipeline: this.pipeline.getStats(),
        batch: this.batchProcessor.getStatus(),
        stream: this.streamProcessor.getMetrics(),
        spatial: this.spatialProcessor.getMetrics(),
        database: this.databaseManager.getMetrics(),
      };

      res.json({
        success: true,
        data: metrics,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error getting processing metrics:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Health check endpoint
   */
  async healthCheck(req, res) {
    try {
      const health = {
        status: 'healthy',
        initialized: this.isInitialized,
        services: {
          pipeline: this.pipeline?.getHealth?.() || { status: 'unknown' },
          batch: {
            status: this.batchProcessor?.isRunning ? 'running' : 'idle',
          },
          stream: {
            status: this.streamProcessor?.isStreaming ? 'streaming' : 'idle',
          },
          database: await this.databaseManager.checkHealth(),
        },
        timestamp: new Date().toISOString(),
      };

      // Determine overall health
      const serviceStates = Object.values(health.services);
      const hasUnhealthy = serviceStates.some(
        service => service.status === 'unhealthy' || service.status === 'error'
      );

      if (hasUnhealthy || !this.isInitialized) {
        health.status = 'degraded';
      }

      const statusCode = health.status === 'healthy' ? 200 : 503;

      res.status(statusCode).json({
        success: health.status === 'healthy',
        data: health,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error in health check:', error);
      res.status(503).json({
        success: false,
        data: {
          status: 'unhealthy',
          error: error.message,
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Validate data using existing framework
   */
  async validateData(req, res) {
    try {
      const { data, options = {} } = req.body;

      if (!data) {
        return res.status(400).json({
          success: false,
          error: 'Data is required for validation',
        });
      }

      const validationResult = await this.validator.validateData(data, options);

      res.json({
        success: true,
        data: validationResult,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Error validating data:', error);
      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Shutdown the controller and all services
   */
  async shutdown() {
    try {
      this.logger.info('Shutting down Data Ingestion Controller...');

      // Stop services
      if (this.streamProcessor?.isStreaming) {
        await this.streamProcessor.stopStreaming();
      }

      if (this.batchProcessor?.isRunning) {
        await this.batchProcessor.stop();
      }

      if (this.pipeline) {
        await this.pipeline.stop();
      }

      // Close database connection
      await this.databaseManager.disconnect();

      this.isInitialized = false;
      this.logger.info('Data Ingestion Controller shutdown completed');
    } catch (error) {
      this.logger.error('Error during controller shutdown:', error);
      throw error;
    }
  }
}

module.exports = { DataIngestionController };
