/**
 * Climate Model Integration Controller
 *
 * RESTful API controller for the Climate Model Integration Framework.
 * Provides endpoints for model execution, data retrieval, format conversion,
 * and system monitoring.
 *
 * Endpoints:
 * - Model execution and job management
 * - Data format conversion
 * - System status and health monitoring
 * - Job history and metrics
 * - Blockchain provenance queries
 */

const express = require('express');
const { body, param, query, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const Logger = require('../utils/logger');

// Import framework components
const {
  ClimateModelFramework,
} = require('../services/climate-model-integration-framework');
const {
  ClimateDataFormatManager,
} = require('../services/climate-data-format-converter');

class ClimateModelController {
  constructor() {
    this.logger = Logger;

    // Initialize framework and services
    this.framework = null;
    this.formatManager = null;
    this.isInitialized = false;

    // Request metrics
    this.requestMetrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageResponseTime: 0,
    };

    this.initialize();
  }

  /**
   * Initialize the controller and framework
   */
  async initialize() {
    try {
      this.logger.info('Initializing Climate Model Controller...');

      // Initialize framework with configuration
      const frameworkConfig = {
        enabledModels: ['GFS', 'WRF', 'ICON'],
        maxConcurrentJobs: 3,
        enableBlockchainProvenance: true,
        dataRetentionDays: 30,
        gfs: {
          useAWS: true,
          resolution: '0p25',
        },
        wrf: {
          useDocker: true,
          dockerImage: 'wrfcoin/wrf:latest',
          maxRuntimeHours: 12,
        },
        icon: {
          region: 'global',
        },
      };

      this.framework = new ClimateModelFramework(frameworkConfig);
      await this.framework.initialize();

      // Initialize format manager
      this.formatManager = new ClimateDataFormatManager({
        preserveMetadata: true,
        enableQualityControl: true,
      });

      this.isInitialized = true;
      this.logger.info('Climate Model Controller initialized successfully');
    } catch (error) {
      this.logger.error(
        'Failed to initialize Climate Model Controller:',
        error
      );
      throw error;
    }
  }

  /**
   * Execute climate model
   */
  async executeModel(req, res) {
    const startTime = Date.now();

    try {
      // Validate request
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
          timestamp: new Date().toISOString(),
        });
      }

      if (!this.isInitialized) {
        return res.status(503).json({
          success: false,
          error: 'Climate Model Framework not initialized',
          timestamp: new Date().toISOString(),
        });
      }

      const { modelName, parameters, options = {} } = req.body;

      // Add user context to options
      options.userId = req.user?.id || 'anonymous';
      options.requestId = req.headers['x-request-id'] || `req_${Date.now()}`;

      this.logger.info(
        `Executing model ${modelName} for user ${options.userId}`
      );

      // Execute model
      const result = await this.framework.executeModel(
        modelName,
        parameters,
        options
      );

      const responseTime = Date.now() - startTime;
      this.updateMetrics(true, responseTime);

      res.json({
        success: true,
        data: result,
        responseTime,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.updateMetrics(false, responseTime);

      this.logger.error('Model execution failed:', error);

      res.status(500).json({
        success: false,
        error: error.message,
        responseTime,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get model data (non-execution retrieval)
   */
  async getModelData(req, res) {
    const startTime = Date.now();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
          timestamp: new Date().toISOString(),
        });
      }

      if (!this.isInitialized) {
        return res.status(503).json({
          success: false,
          error: 'Climate Model Framework not initialized',
          timestamp: new Date().toISOString(),
        });
      }

      const { modelName } = req.params;
      const parameters = req.query;

      this.logger.info(`Retrieving data from model ${modelName}`);

      const result = await this.framework.getModelData(modelName, parameters);

      const responseTime = Date.now() - startTime;
      this.updateMetrics(true, responseTime);

      res.json({
        success: true,
        data: result,
        responseTime,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.updateMetrics(false, responseTime);

      this.logger.error('Model data retrieval failed:', error);

      res.status(500).json({
        success: false,
        error: error.message,
        responseTime,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get framework status
   */
  async getStatus(req, res) {
    try {
      if (!this.isInitialized) {
        return res.status(503).json({
          success: false,
          error: 'Climate Model Framework not initialized',
          timestamp: new Date().toISOString(),
        });
      }

      const status = this.framework.getStatus();

      res.json({
        success: true,
        data: {
          ...status,
          controller: {
            initialized: this.isInitialized,
            metrics: this.requestMetrics,
            formatManager: {
              available: this.formatManager !== null,
              converters: this.formatManager
                ? this.formatManager.getAvailableConverters()
                : null,
            },
          },
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Failed to get framework status:', error);

      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get job history
   */
  async getJobHistory(req, res) {
    try {
      if (!this.isInitialized) {
        return res.status(503).json({
          success: false,
          error: 'Climate Model Framework not initialized',
          timestamp: new Date().toISOString(),
        });
      }

      const limit = parseInt(req.query.limit, 10) || 50;
      const modelName = req.query.model;
      const status = req.query.status;

      let history = this.framework.getJobHistory(limit);

      // Apply filters
      if (modelName) {
        history = history.filter(job => job.modelName === modelName);
      }

      if (status) {
        history = history.filter(job => job.status === status);
      }

      res.json({
        success: true,
        data: {
          jobs: history,
          total: history.length,
          filters: {
            limit,
            modelName: modelName || null,
            status: status || null,
          },
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Failed to get job history:', error);

      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get active jobs
   */
  async getActiveJobs(req, res) {
    try {
      if (!this.isInitialized) {
        return res.status(503).json({
          success: false,
          error: 'Climate Model Framework not initialized',
          timestamp: new Date().toISOString(),
        });
      }

      const activeJobs = this.framework.getActiveJobs();

      res.json({
        success: true,
        data: {
          jobs: activeJobs,
          count: activeJobs.length,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Failed to get active jobs:', error);

      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Cancel job
   */
  async cancelJob(req, res) {
    try {
      const { jobId } = req.params;

      if (!this.isInitialized) {
        return res.status(503).json({
          success: false,
          error: 'Climate Model Framework not initialized',
          timestamp: new Date().toISOString(),
        });
      }

      const cancelledJob = await this.framework.cancelJob(jobId);

      this.logger.info(
        `Job ${jobId} cancelled by user ${req.user?.id || 'anonymous'}`
      );

      res.json({
        success: true,
        data: cancelledJob,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error(`Failed to cancel job ${req.params.jobId}:`, error);

      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Convert data format
   */
  async convertFormat(req, res) {
    const startTime = Date.now();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
          timestamp: new Date().toISOString(),
        });
      }

      if (!this.formatManager) {
        return res.status(503).json({
          success: false,
          error: 'Format Manager not initialized',
          timestamp: new Date().toISOString(),
        });
      }

      const { converterName, inputPath, outputPath, options = {} } = req.body;

      this.logger.info(
        `Converting format using ${converterName}: ${inputPath} -> ${outputPath}`
      );

      const result = await this.formatManager.convertFormat(
        converterName,
        inputPath,
        outputPath,
        options
      );

      const responseTime = Date.now() - startTime;
      this.updateMetrics(result.success, responseTime);

      res.json({
        success: true,
        data: result,
        responseTime,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.updateMetrics(false, responseTime);

      this.logger.error('Format conversion failed:', error);

      res.status(500).json({
        success: false,
        error: error.message,
        responseTime,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Auto-convert format
   */
  async autoConvertFormat(req, res) {
    const startTime = Date.now();

    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({
          success: false,
          error: 'Validation failed',
          details: errors.array(),
          timestamp: new Date().toISOString(),
        });
      }

      if (!this.formatManager) {
        return res.status(503).json({
          success: false,
          error: 'Format Manager not initialized',
          timestamp: new Date().toISOString(),
        });
      }

      const { inputPath, outputFormat, outputPath, options = {} } = req.body;

      this.logger.info(
        `Auto-converting format: ${inputPath} -> ${outputFormat}`
      );

      const result = await this.formatManager.autoConvert(
        inputPath,
        outputFormat,
        outputPath,
        options
      );

      const responseTime = Date.now() - startTime;
      this.updateMetrics(result.success, responseTime);

      res.json({
        success: true,
        data: result,
        responseTime,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      const responseTime = Date.now() - startTime;
      this.updateMetrics(false, responseTime);

      this.logger.error('Auto format conversion failed:', error);

      res.status(500).json({
        success: false,
        error: error.message,
        responseTime,
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Get available converters
   */
  async getConverters(req, res) {
    try {
      if (!this.formatManager) {
        return res.status(503).json({
          success: false,
          error: 'Format Manager not initialized',
          timestamp: new Date().toISOString(),
        });
      }

      const converters = this.formatManager.getAvailableConverters();
      const statistics = this.formatManager.getStatistics();

      res.json({
        success: true,
        data: {
          converters,
          statistics,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Failed to get converters:', error);

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
    const health = {
      status: 'healthy',
      timestamp: new Date().toISOString(),
      services: {
        controller: {
          initialized: this.isInitialized,
          status: this.isInitialized ? 'healthy' : 'unhealthy',
        },
        framework: {
          initialized: this.framework !== null,
          status: 'unknown',
        },
        formatManager: {
          initialized: this.formatManager !== null,
          status: this.formatManager !== null ? 'healthy' : 'unhealthy',
        },
      },
      metrics: this.requestMetrics,
    };

    // Check framework health if available
    if (this.framework && this.isInitialized) {
      try {
        const frameworkStatus = this.framework.getStatus();
        health.services.framework.status = frameworkStatus.framework.initialized
          ? 'healthy'
          : 'unhealthy';
        health.services.framework.activeJobs =
          frameworkStatus.framework.activeJobs;
      } catch (error) {
        health.services.framework.status = 'error';
        health.services.framework.error = error.message;
      }
    }

    // Determine overall health
    const allHealthy = Object.values(health.services).every(
      service => service.status === 'healthy'
    );
    health.status = allHealthy ? 'healthy' : 'degraded';

    const statusCode = allHealthy ? 200 : 503;
    res.status(statusCode).json(health);
  }

  /**
   * Update request metrics
   */
  updateMetrics(success, responseTime) {
    this.requestMetrics.totalRequests++;

    if (success) {
      this.requestMetrics.successfulRequests++;
    } else {
      this.requestMetrics.failedRequests++;
    }

    // Update average response time
    const count = this.requestMetrics.totalRequests;
    this.requestMetrics.averageResponseTime =
      (this.requestMetrics.averageResponseTime * (count - 1) + responseTime) /
      count;
  }

  /**
   * Get controller metrics
   */
  async getMetrics(req, res) {
    try {
      const metrics = {
        controller: this.requestMetrics,
        framework: this.framework
          ? this.framework.getStatus().framework.stats
          : null,
        formatManager: this.formatManager
          ? this.formatManager.getStatistics()
          : null,
      };

      res.json({
        success: true,
        data: metrics,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      this.logger.error('Failed to get metrics:', error);

      res.status(500).json({
        success: false,
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  }
}

// Validation middleware
const validateModelExecution = [
  body('modelName')
    .isString()
    .notEmpty()
    .isIn(['GFS', 'WRF', 'ICON'])
    .withMessage('Model name must be one of: GFS, WRF, ICON'),

  body('parameters').isObject().withMessage('Parameters must be an object'),

  body('options')
    .optional()
    .isObject()
    .withMessage('Options must be an object'),
];

const validateFormatConversion = [
  body('converterName')
    .isString()
    .notEmpty()
    .withMessage('Converter name is required'),

  body('inputPath')
    .isString()
    .notEmpty()
    .withMessage('Input path is required')
    .custom((value) => {
      if (/\.\.|[\0;|&$`(){}<>\n\r]/.test(value)) {
        throw new Error('Input path contains forbidden characters');
      }
      return true;
    }),

  body('outputPath')
    .isString()
    .notEmpty()
    .withMessage('Output path is required')
    .custom((value) => {
      if (/\.\.|[\0;|&$`(){}<>\n\r]/.test(value)) {
        throw new Error('Output path contains forbidden characters');
      }
      return true;
    }),

  body('options')
    .optional()
    .isObject()
    .withMessage('Options must be an object'),
];

const validateAutoConversion = [
  body('inputPath')
    .isString()
    .notEmpty()
    .withMessage('Input path is required')
    .custom((value) => {
      if (/\.\.|[\0;|&$`(){}<>\n\r]/.test(value)) {
        throw new Error('Input path contains forbidden characters');
      }
      return true;
    }),

  body('outputFormat')
    .isString()
    .notEmpty()
    .withMessage('Output format is required'),

  body('outputPath')
    .isString()
    .notEmpty()
    .withMessage('Output path is required')
    .custom((value) => {
      if (/\.\.|[\0;|&$`(){}<>\n\r]/.test(value)) {
        throw new Error('Output path contains forbidden characters');
      }
      return true;
    }),

  body('options')
    .optional()
    .isObject()
    .withMessage('Options must be an object'),
];

const validateJobId = [
  param('jobId').isString().notEmpty().withMessage('Job ID is required'),
];

const validateModelName = [
  param('modelName')
    .isString()
    .notEmpty()
    .isIn(['GFS', 'WRF', 'ICON'])
    .withMessage('Model name must be one of: GFS, WRF, ICON'),
];

// Rate limiting
const createRateLimit = (windowMs, max, message) => {
  return rateLimit({
    windowMs,
    max,
    message: {
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
    },
    standardHeaders: true,
    legacyHeaders: false,
  });
};

// Rate limits for different endpoint types
const modelExecutionRateLimit = createRateLimit(
  15 * 60 * 1000, // 15 minutes
  5, // 5 requests per window
  'Too many model execution requests, please try again later'
);

const dataRetrievalRateLimit = createRateLimit(
  60 * 1000, // 1 minute
  30, // 30 requests per window
  'Too many data retrieval requests, please try again later'
);

const conversionRateLimit = createRateLimit(
  5 * 60 * 1000, // 5 minutes
  10, // 10 requests per window
  'Too many format conversion requests, please try again later'
);

const generalRateLimit = createRateLimit(
  60 * 1000, // 1 minute
  100, // 100 requests per window
  'Too many requests, please try again later'
);

module.exports = {
  ClimateModelController,
  validateModelExecution,
  validateFormatConversion,
  validateAutoConversion,
  validateJobId,
  validateModelName,
  modelExecutionRateLimit,
  dataRetrievalRateLimit,
  conversionRateLimit,
  generalRateLimit,
};
