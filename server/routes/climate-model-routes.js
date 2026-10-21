/**
 * Climate Model Integration Routes
 *
 * RESTful API routes for the Climate Model Integration Framework.
 * Provides comprehensive endpoints for model execution, data retrieval,
 * format conversion, and system monitoring.
 *
 * Route Groups:
 * - /api/climate/models/* - Model execution and data retrieval
 * - /api/climate/jobs/* - Job management and monitoring
 * - /api/climate/convert/* - Data format conversion
 * - /api/climate/system/* - System status and health
 */

const express = require('express');
const cors = require('cors');
const { resolveServiceCorsOrigins } = require('../utils/strict-cors-config');
const helmet = require('helmet');
const compression = require('compression');
const { randomBytes } = require('crypto');
const { weatherLogger } = require('../utils/logger');

// Import controller and middleware
const {
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
} = require('../controllers/climate-model-controller');

// Create router
const router = express.Router();
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');

// All climate model operations require authentication (#231)
router.use(requireAuth);

// Initialize controller
const controller = new ClimateModelController();

// Global middleware for climate routes
router.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https:'],
      },
    },
  })
);

router.use(compression());
router.use(
  cors({
    // backend#1236: FRONTEND_URL, else CORS_ORIGIN; production refuses
    // empty/loopback/wildcard instead of falling back to localhost.
    origin: resolveServiceCorsOrigins(process.env.FRONTEND_URL, {
      developmentDefaults: ['http://localhost:5000'],
    }),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
  })
);

// Request logging middleware
router.use((req, res, next) => {
  req.startTime = Date.now();
  weatherLogger.info('Climate API request received', {
    method: req.method,
    path: req.path,
    service: 'climate-model-routes'
  });

  // Add request ID if not present
  if (!req.headers['x-request-id']) {
    req.headers['x-request-id'] =
      `climate_${Date.now()}_${randomBytes(5).toString('hex')}`;
  }

  next();
});

// Response logging middleware
router.use((req, res, next) => {
  const originalSend = res.send;

  res.send = function (data) {
    const responseTime = Date.now() - req.startTime;
    weatherLogger.info('Climate API response sent', {
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      responseTime: `${responseTime}ms`,
      service: 'climate-model-routes'
    });

    originalSend.call(this, data);
  };

  next();
});

// ============================================================================
// MODEL EXECUTION AND DATA RETRIEVAL ROUTES
// ============================================================================

/**
 * @route POST /api/climate/models/execute
 * @desc Execute a climate model
 * @access Public (in demo - would require authentication in production)
 */
router.post(
  '/models/execute',
  modelExecutionRateLimit,
  validateModelExecution,
  async (req, res) => {
    await controller.executeModel(req, res);
  }
);

/**
 * @route GET /api/climate/models/:modelName/data
 * @desc Get data from a climate model (non-execution)
 * @access Public
 */
router.get(
  '/models/:modelName/data',
  dataRetrievalRateLimit,
  validateModelName,
  async (req, res) => {
    await controller.getModelData(req, res);
  }
);

/**
 * @route GET /api/climate/models/available
 * @desc Get list of available climate models
 * @access Public
 */
router.get('/models/available', generalRateLimit, async (req, res) => {
  try {
    const models = {
      GFS: {
        name: 'Global Forecast System',
        provider: 'NOAA',
        type: 'global',
        resolution: '0.25°',
        forecastHours: 384,
        updateFrequency: '6 hours',
        description: 'Global numerical weather prediction model',
      },
      WRF: {
        name: 'Weather Research and Forecasting',
        provider: 'NCAR/NOAA',
        type: 'regional',
        resolution: 'user-defined',
        forecastHours: 'user-defined',
        updateFrequency: 'on-demand',
        description: 'Regional atmospheric modeling system',
      },
      ICON: {
        name: 'ICOsahedral Nonhydrostatic',
        provider: 'DWD',
        type: 'global/regional',
        resolution: '13km (global), 2.2km (europe)',
        forecastHours: 120,
        updateFrequency: '6 hours (global), 3 hours (regional)',
        description: 'German weather and climate model',
      },
    };

    res.json({
      success: true,
      data: {
        models,
        count: Object.keys(models).length,
        capabilities: {
          execution: ['WRF'],
          dataRetrieval: ['GFS', 'ICON'],
          realTime: ['GFS', 'ICON'],
          historical: ['GFS'],
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ============================================================================
// JOB MANAGEMENT ROUTES
// ============================================================================

/**
 * @route GET /api/climate/jobs/active
 * @desc Get currently active jobs
 * @access Public
 */
router.get('/jobs/active', generalRateLimit, async (req, res) => {
  await controller.getActiveJobs(req, res);
});

/**
 * @route GET /api/climate/jobs/history
 * @desc Get job execution history
 * @access Public
 */
router.get('/jobs/history', generalRateLimit, async (req, res) => {
  await controller.getJobHistory(req, res);
});

/**
 * @route DELETE /api/climate/jobs/:jobId
 * @desc Cancel a running job
 * @access Public
 */
router.delete(
  '/jobs/:jobId',
  generalRateLimit,
  validateJobId,
  async (req, res) => {
    await controller.cancelJob(req, res);
  }
);

/**
 * @route GET /api/climate/jobs/stats
 * @desc Get job execution statistics
 * @access Public
 */
router.get('/jobs/stats', generalRateLimit, async (req, res) => {
  try {
    const stats = await controller.getMetrics(req, res);
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ============================================================================
// DATA FORMAT CONVERSION ROUTES
// ============================================================================

/**
 * @route POST /api/climate/convert/format
 * @desc Convert data between formats using specific converter
 * @access Public
 */
router.post(
  '/convert/format',
  requireAdmin,
  conversionRateLimit,
  validateFormatConversion,
  async (req, res) => {
    await controller.convertFormat(req, res);
  }
);

/**
 * @route POST /api/climate/convert/auto
 * @desc Auto-convert data format (auto-detect input format)
 * @access Public
 */
router.post(
  '/convert/auto',
  requireAdmin,
  conversionRateLimit,
  validateAutoConversion,
  async (req, res) => {
    await controller.autoConvertFormat(req, res);
  }
);

/**
 * @route GET /api/climate/convert/converters
 * @desc Get available format converters
 * @access Public
 */
router.get('/convert/converters', generalRateLimit, async (req, res) => {
  await controller.getConverters(req, res);
});

/**
 * @route GET /api/climate/convert/formats
 * @desc Get supported data formats
 * @access Public
 */
router.get('/convert/formats', generalRateLimit, async (req, res) => {
  try {
    const formats = {
      input: {
        grib: {
          name: 'GRIB/GRIB2',
          description:
            'Gridded Binary format used by meteorological organizations',
          extensions: ['.grb', '.grib', '.grib2'],
          mimeType: 'application/octet-stream',
        },
        netcdf: {
          name: 'NetCDF',
          description: 'Network Common Data Form for scientific data',
          extensions: ['.nc', '.netcdf'],
          mimeType: 'application/x-netcdf',
        },
        json: {
          name: 'JSON',
          description: 'JavaScript Object Notation',
          extensions: ['.json'],
          mimeType: 'application/json',
        },
        csv: {
          name: 'CSV',
          description: 'Comma Separated Values',
          extensions: ['.csv'],
          mimeType: 'text/csv',
        },
      },
      output: {
        netcdf: {
          name: 'NetCDF',
          description: 'Network Common Data Form for scientific data',
          extensions: ['.nc'],
          mimeType: 'application/x-netcdf',
        },
        json: {
          name: 'JSON',
          description: 'JavaScript Object Notation',
          extensions: ['.json'],
          mimeType: 'application/json',
        },
        'wrfcoin-json': {
          name: 'WRFCoin JSON',
          description: 'WRFCoin unified weather data format (JSON)',
          extensions: ['.json'],
          mimeType: 'application/json',
        },
        'wrfcoin-netcdf': {
          name: 'WRFCoin NetCDF',
          description: 'WRFCoin unified weather data format (NetCDF)',
          extensions: ['.nc'],
          mimeType: 'application/x-netcdf',
        },
      },
      conversionPaths: [
        { from: 'grib', to: 'netcdf', via: 'direct' },
        { from: 'grib', to: 'json', via: 'netcdf' },
        { from: 'grib', to: 'wrfcoin-json', via: 'direct' },
        { from: 'netcdf', to: 'json', via: 'direct' },
        { from: 'netcdf', to: 'wrfcoin-json', via: 'direct' },
        { from: 'csv', to: 'wrfcoin-json', via: 'direct' },
        { from: 'json', to: 'wrfcoin-json', via: 'direct' },
      ],
    };

    res.json({
      success: true,
      data: formats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ============================================================================
// SYSTEM STATUS AND MONITORING ROUTES
// ============================================================================

/**
 * @route GET /api/climate/system/status
 * @desc Get system status and health
 * @access Public
 */
router.get('/system/status', generalRateLimit, async (req, res) => {
  await controller.getStatus(req, res);
});

/**
 * @route GET /api/climate/system/health
 * @desc Health check endpoint
 * @access Public
 */
router.get('/system/health', async (req, res) => {
  await controller.healthCheck(req, res);
});

/**
 * @route GET /api/climate/system/metrics
 * @desc Get system performance metrics
 * @access Public
 */
router.get('/system/metrics', generalRateLimit, async (req, res) => {
  await controller.getMetrics(req, res);
});

/**
 * @route GET /api/climate/system/info
 * @desc Get system information and capabilities
 * @access Public
 */
router.get('/system/info', generalRateLimit, async (req, res) => {
  try {
    const info = {
      name: 'WRFCoin Climate Model Integration Framework',
      version: '1.0.0',
      description:
        'Comprehensive climate model integration and data processing framework',
      capabilities: {
        models: {
          supported: ['GFS', 'WRF', 'ICON'],
          execution: ['WRF'],
          dataRetrieval: ['GFS', 'ICON', 'WRF'],
          realTime: ['GFS', 'ICON'],
          historical: ['GFS'],
        },
        formats: {
          input: ['GRIB/GRIB2', 'NetCDF', 'JSON', 'CSV'],
          output: ['NetCDF', 'JSON', 'WRFCoin-JSON', 'WRFCoin-NetCDF'],
          conversion: true,
          autoDetection: true,
        },
        features: {
          containerizedExecution: true,
          blockchainProvenance: true,
          realTimeProcessing: true,
          batchProcessing: true,
          qualityValidation: true,
          dataEnrichment: true,
          jobQueue: true,
          rateLimiting: true,
          monitoring: true,
        },
      },
      endpoints: {
        models: [
          'POST /api/climate/models/execute',
          'GET /api/climate/models/:modelName/data',
          'GET /api/climate/models/available',
        ],
        jobs: [
          'GET /api/climate/jobs/active',
          'GET /api/climate/jobs/history',
          'DELETE /api/climate/jobs/:jobId',
          'GET /api/climate/jobs/stats',
        ],
        conversion: [
          'POST /api/climate/convert/format',
          'POST /api/climate/convert/auto',
          'GET /api/climate/convert/converters',
          'GET /api/climate/convert/formats',
        ],
        system: [
          'GET /api/climate/system/status',
          'GET /api/climate/system/health',
          'GET /api/climate/system/metrics',
          'GET /api/climate/system/info',
        ],
      },
      rateLimits: {
        modelExecution: '5 requests per 15 minutes',
        dataRetrieval: '30 requests per minute',
        formatConversion: '10 requests per 5 minutes',
        general: '100 requests per minute',
      },
      documentation: {
        apiDocs: '/api/climate/docs',
        examples: '/api/climate/examples',
        schemas: '/api/climate/schemas',
      },
    };

    res.json({
      success: true,
      data: info,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ============================================================================
// DOCUMENTATION AND EXAMPLES ROUTES
// ============================================================================

/**
 * @route GET /api/climate/docs
 * @desc Get API documentation
 * @access Public
 */
router.get('/docs', generalRateLimit, async (req, res) => {
  try {
    const docs = {
      title: 'Climate Model Integration API Documentation',
      version: '1.0.0',
      baseUrl: req.protocol + '://' + req.get('host') + '/api/climate',
      authentication: {
        type: 'none',
        note: 'This is a demonstration API. Production version would require authentication.',
      },
      endpoints: {
        modelExecution: {
          path: 'POST /models/execute',
          description: 'Execute a climate model with specified parameters',
          parameters: {
            modelName: 'string (required) - Model name: GFS, WRF, or ICON',
            parameters: 'object (required) - Model-specific parameters',
            options: 'object (optional) - Execution options',
          },
          example: {
            modelName: 'GFS',
            parameters: {
              runTime: '2023-10-27T00:00:00Z',
              forecastHours: [0, 6, 12, 24],
              variables: ['TMP', 'UGRD', 'VGRD'],
              bounds: {
                north: 50,
                south: 30,
                east: -70,
                west: -120,
              },
            },
            options: {
              outputFormat: 'netcdf',
            },
          },
        },
        dataRetrieval: {
          path: 'GET /models/:modelName/data',
          description: 'Retrieve data from a climate model',
          parameters: {
            modelName: 'string (path) - Model name: GFS, WRF, or ICON',
            'query parameters': 'Model-specific query parameters',
          },
          example: '/models/GFS/data?forecastHours=0,6,12&variables=TMP,UGRD',
        },
        formatConversion: {
          path: 'POST /convert/auto',
          description: 'Auto-convert data between formats',
          parameters: {
            inputPath: 'string (required) - Path to input file',
            outputFormat: 'string (required) - Target format',
            outputPath: 'string (required) - Path for output file',
            options: 'object (optional) - Conversion options',
          },
          example: {
            inputPath: '/tmp/gfs_data.grib2',
            outputFormat: 'wrfcoin-json',
            outputPath: '/tmp/converted_data.json',
            options: {
              variables: ['temperature', 'humidity'],
              qualityControl: true,
            },
          },
        },
      },
      errorHandling: {
        format: {
          success: 'boolean',
          error: 'string (if success = false)',
          data: 'object (if success = true)',
          timestamp: 'string (ISO 8601)',
        },
        statusCodes: {
          200: 'Success',
          400: 'Bad Request - Invalid parameters',
          429: 'Too Many Requests - Rate limit exceeded',
          500: 'Internal Server Error',
          503: 'Service Unavailable',
        },
      },
    };

    res.json({
      success: true,
      data: docs,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * @route GET /api/climate/examples
 * @desc Get API usage examples
 * @access Public
 */
router.get('/examples', generalRateLimit, async (req, res) => {
  try {
    const examples = {
      gfsDataRetrieval: {
        description: 'Retrieve GFS forecast data for a specific region',
        method: 'GET',
        url: '/api/climate/models/GFS/data',
        queryParams: {
          forecastHours: '0,6,12,24',
          variables: 'TMP,UGRD,VGRD,HGT',
          bounds: 'north=50&south=30&east=-70&west=-120',
        },
        response: {
          success: true,
          data: {
            modelName: 'GFS',
            data: [
              {
                forecastHour: 0,
                processedFile: '/tmp/gfs_converted_f000.json',
                variables: ['TMP', 'UGRD', 'VGRD', 'HGT'],
                format: 'json',
              },
            ],
          },
        },
      },
      wrfExecution: {
        description: 'Execute WRF model for a regional forecast',
        method: 'POST',
        url: '/api/climate/models/execute',
        body: {
          modelName: 'WRF',
          parameters: {
            domain: {
              center: [40.0, -105.0],
              size: [100, 100],
              resolution: [10000, 10000],
            },
            timeRange: {
              start: '2023-10-27T00:00:00Z',
              end: '2023-10-28T00:00:00Z',
            },
            physicsOptions: 'default',
            outputFrequency: 3600,
          },
          options: {
            parallelCores: 4,
          },
        },
        response: {
          success: true,
          data: {
            jobId: 'wrf_1698364800000_abc123def',
            modelName: 'WRF',
            outputs: [
              {
                processedFile: '/tmp/wrf_run/output/processed_wrfout_d01.nc',
                fileSize: 15728640,
              },
            ],
          },
        },
      },
      formatConversion: {
        description: 'Convert GRIB2 file to WRFCoin JSON format',
        method: 'POST',
        url: '/api/climate/convert/auto',
        body: {
          inputPath: '/tmp/gfs.t00z.pgrb2.0p25.f006',
          outputFormat: 'wrfcoin-json',
          outputPath: '/tmp/converted_weather_data.json',
          options: {
            variables: ['temperature', 'humidity', 'pressure'],
            qualityControl: true,
            enrichMetadata: true,
          },
        },
        response: {
          success: true,
          data: {
            inputFormat: 'grib',
            outputFormat: 'wrfcoin-json',
            recordCount: 847,
            conversionPath: ['grib -> netcdf -> wrfcoin'],
          },
        },
      },
    };

    res.json({
      success: true,
      data: examples,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler for climate routes
router.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: `Climate API endpoint not found: ${req.method} ${req.originalUrl}`,
    availableEndpoints: [
      'GET /api/climate/system/info',
      'GET /api/climate/docs',
      'GET /api/climate/examples',
    ],
    timestamp: new Date().toISOString(),
  });
});

// Error handling middleware
router.use((error, req, res, next) => {
  weatherLogger.error('Climate API Error', {
    method: req.method,
    path: req.path,
    error: { message: error.message, stack: error.stack }
  });

  // Determine error type and status code
  let statusCode = 500;
  let errorMessage = 'Internal server error';

  if (error.name === 'ValidationError') {
    statusCode = 400;
    errorMessage = error.message;
  } else if (error.name === 'RateLimitError') {
    statusCode = 429;
    errorMessage = 'Rate limit exceeded';
  } else if (error.message.includes('not found')) {
    statusCode = 404;
    errorMessage = error.message;
  }

  res.status(statusCode).json({
    success: false,
    error: errorMessage,
    requestId: req.headers['x-request-id'],
    timestamp: new Date().toISOString(),
  });
});

module.exports = router;
