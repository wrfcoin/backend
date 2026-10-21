/**
 * Data Quality Routes for WRFCoin Weather Data Quality Pipeline
 *
 * Defines RESTful API routes for data quality operations including
 * profiling, anomaly detection, reporting, and monitoring.
 *
 * @author WRFCoin Development Team
 * @version 1.0.0
 * @since 2025-07-12
 */

const express = require('express');
const DataQualityController = require('../controllers/data-quality-controller');
const { logger } = require('../utils/logger');

const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const controller = new DataQualityController();

// All data quality operations require authentication (#231)
router.use(requireAuth);

// Middleware for request logging
router.use((req, res, next) => {
  logger.info('Data quality API request', {
    method: req.method,
    path: req.path,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
  });
  next();
});

// Middleware for request validation
const validateDataPayload = (req, res, next) => {
  if (!req.body || !Array.isArray(req.body.data)) {
    return res.status(400).json({
      success: false,
      error: 'Request body must contain a "data" array',
    });
  }

  if (req.body.data.length === 0) {
    return res.status(400).json({
      success: false,
      error: 'Data array cannot be empty',
    });
  }

  // Validate data array size (prevent memory issues)
  if (req.body.data.length > 10000) {
    return res.status(400).json({
      success: false,
      error:
        'Data array too large. Maximum 10,000 records allowed per request.',
    });
  }

  next();
};

// Rate limiting middleware (basic implementation)
const rateLimitMap = new Map();
const rateLimit = (maxRequests = 100, windowMs = 60000) => {
  return (req, res, next) => {
    const clientId = req.ip || 'unknown';
    const now = Date.now();
    const windowStart = now - windowMs;

    // Clean old entries
    const clientRequests = rateLimitMap.get(clientId) || [];
    const validRequests = clientRequests.filter(time => time > windowStart);

    if (validRequests.length >= maxRequests) {
      return res.status(429).json({
        success: false,
        error: 'Rate limit exceeded',
        retryAfter: Math.ceil((validRequests[0] - windowStart) / 1000),
      });
    }

    validRequests.push(now);
    rateLimitMap.set(clientId, validRequests);

    next();
  };
};

// Error handling middleware
const handleAsyncErrors = fn => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

// =======================
// PROFILING ENDPOINTS
// =======================

/**
 * @route POST /api/data-quality/profile
 * @desc Generate comprehensive data profile
 * @access Public
 * @body {Array} data - Weather data array
 * @body {Object} metadata - Optional metadata
 */
router.post(
  '/profile',
  rateLimit(50, 60000), // 50 requests per minute
  validateDataPayload,
  handleAsyncErrors(async (req, res) => {
    await controller.generateProfile(req, res);
  })
);

// =======================
// ANOMALY DETECTION ENDPOINTS
// =======================

/**
 * @route POST /api/data-quality/anomalies
 * @desc Detect anomalies in weather data
 * @access Public
 * @body {Array} data - Weather data array
 * @body {Object} options - Detection options
 */
router.post(
  '/anomalies',
  rateLimit(30, 60000), // 30 requests per minute
  validateDataPayload,
  handleAsyncErrors(async (req, res) => {
    await controller.detectAnomalies(req, res);
  })
);

// =======================
// REPORTING ENDPOINTS
// =======================

/**
 * @route POST /api/data-quality/report
 * @desc Generate comprehensive quality report
 * @access Public
 * @body {Array} data - Weather data array
 * @body {Object} metadata - Optional metadata
 * @body {String} format - Report format (json, html, csv)
 */
router.post(
  '/report',
  rateLimit(20, 60000), // 20 requests per minute
  validateDataPayload,
  handleAsyncErrors(async (req, res) => {
    await controller.generateReport(req, res);
  })
);

/**
 * @route GET /api/data-quality/reports
 * @desc List recent reports
 * @access Public
 * @query {Number} limit - Maximum number of reports to return
 */
router.get(
  '/reports',
  rateLimit(100, 60000), // 100 requests per minute
  handleAsyncErrors(async (req, res) => {
    await controller.listReports(req, res);
  })
);

/**
 * @route GET /api/data-quality/reports/:reportId
 * @desc Get specific report by ID
 * @access Public
 * @param {String} reportId - Report ID
 * @query {String} format - Output format (json, html, csv)
 */
router.get(
  '/reports/:reportId',
  rateLimit(100, 60000), // 100 requests per minute
  handleAsyncErrors(async (req, res) => {
    await controller.getReport(req, res);
  })
);

// =======================
// COMPREHENSIVE ANALYSIS ENDPOINTS
// =======================

/**
 * @route POST /api/data-quality/analyze
 * @desc Run comprehensive quality analysis (profile + anomalies + report)
 * @access Public
 * @body {Array} data - Weather data array
 * @body {Object} metadata - Optional metadata
 * @body {Object} options - Analysis options
 */
router.post(
  '/analyze',
  rateLimit(10, 60000), // 10 requests per minute (resource intensive)
  validateDataPayload,
  handleAsyncErrors(async (req, res) => {
    await controller.analyzeQuality(req, res);
  })
);

// =======================
// METRICS ENDPOINTS
// =======================

/**
 * @route POST /api/data-quality/metrics
 * @desc Get quality metrics for specific parameters
 * @access Public
 * @body {Array} data - Weather data array
 * @body {Array} parameters - Optional parameter filter
 */
router.post(
  '/metrics',
  rateLimit(50, 60000), // 50 requests per minute
  validateDataPayload,
  handleAsyncErrors(async (req, res) => {
    await controller.getQualityMetrics(req, res);
  })
);

/**
 * @route POST /api/data-quality/validate
 * @desc Validate data against quality thresholds
 * @access Public
 * @body {Array} data - Weather data array
 * @body {Object} thresholds - Quality thresholds
 * @body {Object} metadata - Optional metadata
 */
router.post(
  '/validate',
  rateLimit(50, 60000), // 50 requests per minute
  validateDataPayload,
  handleAsyncErrors(async (req, res) => {
    await controller.validateQuality(req, res);
  })
);

// =======================
// MONITORING ENDPOINTS
// =======================

/**
 * @route GET /api/data-quality/dashboard
 * @desc Get dashboard data for real-time monitoring
 * @access Public
 */
router.get(
  '/dashboard',
  rateLimit(200, 60000), // 200 requests per minute
  handleAsyncErrors(async (req, res) => {
    await controller.getDashboard(req, res);
  })
);

/**
 * @route GET /api/data-quality/risk-status
 * @desc Get sanitized anti-fraud risk status
 * @access Public
 */
router.get(
  '/risk-status',
  rateLimit(120, 60000),
  handleAsyncErrors(async (req, res) => {
    await controller.getRiskStatus(req, res);
  })
);

/**
 * @route GET /api/data-quality/risk-events
 * @desc Get sanitized anti-fraud audit events
 * @access Public
 * @query {Number} limit - Optional limit (1-100)
 */
router.get(
  '/risk-events',
  rateLimit(120, 60000),
  handleAsyncErrors(async (req, res) => {
    await controller.getRiskEvents(req, res);
  })
);

/**
 * @route GET /api/data-quality/health
 * @desc Health check endpoint
 * @access Public
 */
router.get(
  '/health',
  rateLimit(300, 60000), // 300 requests per minute
  handleAsyncErrors(async (req, res) => {
    await controller.healthCheck(req, res);
  })
);

// =======================
// STREAMING ENDPOINTS
// =======================

/**
 * @route GET /api/data-quality/stream
 * @desc WebSocket endpoint for real-time quality updates
 * @access Public
 * @websocket true
 */
router.ws('/stream', (ws, req) => {
  try {
    controller.streamQualityUpdates(ws, req);
  } catch (error) {
    logger.error('WebSocket setup failed', { error: error.message });
    ws.close(1011, 'Setup failed');
  }
});

// =======================
// BATCH OPERATIONS
// =======================

/**
 * @route POST /api/data-quality/batch/analyze
 * @desc Analyze multiple datasets in batch
 * @access Public
 * @body {Array} datasets - Array of dataset objects
 */
router.post(
  '/batch/analyze',
  rateLimit(5, 60000), // 5 requests per minute (very resource intensive)
  (req, res, next) => {
    if (!req.body || !Array.isArray(req.body.datasets)) {
      return res.status(400).json({
        success: false,
        error: 'Request body must contain a "datasets" array',
      });
    }

    if (req.body.datasets.length === 0 || req.body.datasets.length > 10) {
      return res.status(400).json({
        success: false,
        error: 'Datasets array must contain 1-10 datasets',
      });
    }

    // Validate each dataset
    for (const dataset of req.body.datasets) {
      if (!Array.isArray(dataset.data) || dataset.data.length === 0) {
        return res.status(400).json({
          success: false,
          error: 'Each dataset must contain a non-empty "data" array',
        });
      }
    }

    next();
  },
  handleAsyncErrors(async (req, res) => {
    const { datasets } = req.body;
    const batchStart = Date.now();
    const results = [];

    try {
      logger.info('Batch analysis requested', {
        datasetCount: datasets.length,
      });

      for (let i = 0; i < datasets.length; i++) {
        const dataset = datasets[i];
        const datasetStart = Date.now();

        try {
          // Run analysis for this dataset
          const mockReq = {
            body: {
              data: dataset.data,
              metadata: dataset.metadata || {},
              options: dataset.options || {},
            },
          };

          let analysisResult;
          const mockRes = {
            json: data => {
              analysisResult = data;
            },
            status: () => mockRes,
          };

          await controller.analyzeQuality(mockReq, mockRes);

          results.push({
            datasetIndex: i,
            datasetId: dataset.id || `dataset_${i}`,
            success: analysisResult.success,
            analysis: analysisResult.analysis,
            processingTimeMs: Date.now() - datasetStart,
            error: analysisResult.success ? null : analysisResult.error,
          });
        } catch (error) {
          results.push({
            datasetIndex: i,
            datasetId: dataset.id || `dataset_${i}`,
            success: false,
            analysis: null,
            processingTimeMs: Date.now() - datasetStart,
            error: error.message,
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const totalProcessingTime = Date.now() - batchStart;

      res.json({
        success: true,
        batchResults: {
          totalDatasets: datasets.length,
          successfulAnalyses: successCount,
          failedAnalyses: datasets.length - successCount,
          totalProcessingTimeMs: totalProcessingTime,
          results: results,
        },
        message: `Batch analysis completed: ${successCount}/${datasets.length} successful`,
      });
    } catch (error) {
      logger.error('Batch analysis failed', { error: error.message });
      res.status(500).json({
        success: false,
        error: 'Batch analysis failed',
        details: error.message,
        partialResults: results,
      });
    }
  })
);

// =======================
// EXPORT ENDPOINTS
// =======================

/**
 * @route GET /api/data-quality/export/:reportId
 * @desc Export report to file
 * @access Public
 * @param {String} reportId - Report ID
 * @query {String} format - Export format (json, html, csv)
 */
router.get(
  '/export/:reportId',
  rateLimit(50, 60000), // 50 requests per minute
  handleAsyncErrors(async (req, res) => {
    const { reportId } = req.params;
    const { format = 'json' } = req.query;

    try {
      const report = controller.reportingService.getReport(reportId);

      if (!report) {
        return res.status(404).json({
          success: false,
          error: 'Report not found',
        });
      }

      const formattedReport = await controller.reportingService._formatReport(
        report,
        format
      );
      const timestamp = new Date().toISOString().split('T')[0];
      const filename = `wrfcoin-quality-report-${reportId}-${timestamp}.${format}`;

      // Set appropriate headers
      res.set({
        'Content-Type':
          format === 'html'
            ? 'text/html'
            : format === 'csv'
              ? 'text/csv'
              : 'application/json',
        'Content-Disposition': `attachment; filename="${filename}"`,
      });

      res.send(formattedReport);
    } catch (error) {
      logger.error('Report export failed', { error: error.message, reportId });
      res.status(500).json({
        success: false,
        error: 'Report export failed',
        details: error.message,
      });
    }
  })
);

// =======================
// ERROR HANDLING
// =======================

// Generic error handler
router.use((error, req, res, next) => {
  logger.error('Data quality API error', {
    error: error.message,
    stack: error.stack,
    path: req.path,
    method: req.method,
  });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    message: 'An unexpected error occurred while processing your request',
  });
});

// 404 handler for undefined routes
router.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    message: `The endpoint ${req.method} ${req.originalUrl} does not exist`,
  });
});

module.exports = router;
