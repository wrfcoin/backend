/**
 * WRFCoin Data Flow Monitoring API Routes
 * REST endpoints for data flow validation status and performance monitoring
 */

const express = require('express');
const { dataFlowValidator } = require('../services/data-flow-manager');
const { dataFlowMonitor } = require('../services/data-flow-monitor');
const { connectionPool } = require('../database/connection-pool');
const { cacheClient } = require('../cache/redis-client');
const {
  validateRequest,
  validateResponse,
  VALIDATION_PIPELINES,
} = require('../middleware/data-validation-middleware');
const { logger } = require('../utils/logger');

const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');

// All data flow operations require authentication (#231)
router.use(requireAuth);

/**
 * GET /api/data-flow/status
 * Get comprehensive data flow system status
 */
router.get('/status', async (req, res) => {
  try {
    const requestId = req.headers['x-request-id'] || 'status-' + Date.now();

    // Get status from all components
    const [validatorStats, monitorStatus, dbStats, cacheStats, healthCheck] =
      await Promise.allSettled([
        Promise.resolve(dataFlowValidator.getStatistics()),
        Promise.resolve(dataFlowMonitor.getStatus()),
        connectionPool.getPoolStatistics
          ? Promise.resolve(connectionPool.getPoolStatistics())
          : Promise.resolve({}),
        cacheClient.getStatistics
          ? cacheClient.getStatistics()
          : Promise.resolve({}),
        dataFlowMonitor.performHealthCheck(),
      ]);

    const status = {
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        systemHealth:
          healthCheck.status === 'fulfilled'
            ? healthCheck.value.overall
            : 'unknown',
        components: {
          validator: {
            status:
              validatorStats.status === 'fulfilled' ? 'operational' : 'error',
            statistics:
              validatorStats.status === 'fulfilled'
                ? validatorStats.value
                : null,
            error:
              validatorStats.status === 'rejected'
                ? validatorStats.reason?.message
                : null,
          },
          monitor: {
            status:
              monitorStatus.status === 'fulfilled' ? 'operational' : 'error',
            isRunning:
              monitorStatus.status === 'fulfilled'
                ? monitorStatus.value.isRunning
                : false,
            healthIndicators:
              monitorStatus.status === 'fulfilled'
                ? monitorStatus.value.healthIndicators
                : {},
            error:
              monitorStatus.status === 'rejected'
                ? monitorStatus.reason?.message
                : null,
          },
          database: {
            status: dbStats.status === 'fulfilled' ? 'operational' : 'error',
            statistics: dbStats.status === 'fulfilled' ? dbStats.value : null,
            error:
              dbStats.status === 'rejected' ? dbStats.reason?.message : null,
          },
          cache: {
            status: cacheStats.status === 'fulfilled' ? 'operational' : 'error',
            statistics:
              cacheStats.status === 'fulfilled' ? cacheStats.value : null,
            error:
              cacheStats.status === 'rejected'
                ? cacheStats.reason?.message
                : null,
          },
        },
        performance: {
          overallLatency:
            monitorStatus.status === 'fulfilled'
              ? calculateOverallLatency(monitorStatus.value.metrics)
              : null,
          throughput:
            monitorStatus.status === 'fulfilled'
              ? calculateThroughput(monitorStatus.value.metrics)
              : null,
          errorRate:
            validatorStats.status === 'fulfilled'
              ? calculateErrorRate(validatorStats.value)
              : null,
        },
      },
      metadata: {
        requestId,
        timestamp: new Date().toISOString(),
        responseTime: 0, // Will be calculated at response time
      },
    };

    res.json(status);
  } catch (error) {
    logger.error('Data flow status endpoint error', {
      error: error.message,
      requestId: req.headers['x-request-id'],
    });

    res.status(500).json({
      success: false,
      error: {
        code: 'STATUS_ERROR',
        message: 'Failed to retrieve data flow status',
      },
      metadata: {
        requestId: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
      },
    });
  }
});

/**
 * GET /api/data-flow/metrics
 * Get detailed performance metrics
 */
router.get('/metrics', async (req, res) => {
  try {
    const requestId = req.headers['x-request-id'] || 'metrics-' + Date.now();
    const timeRange = req.query.range || 'short'; // short, medium, long
    const component = req.query.component; // optional filter

    const monitorStatus = dataFlowMonitor.getStatus();
    const validatorStats = dataFlowValidator.getStatistics();

    const metrics = {
      timestamp: new Date().toISOString(),
      timeRange,
      overall: {
        systemUptime: monitorStatus.uptime,
        validatorUptime: validatorStats.uptime,
        totalValidations: validatorStats.validationCount,
        totalErrors: validatorStats.errorCount,
        successRate: validatorStats.successRate,
      },
      components: monitorStatus.metrics,
    };

    // Filter by component if specified
    if (component && metrics.components[component]) {
      metrics.components = { [component]: metrics.components[component] };
    }

    // Add historical data if available
    if (
      dataFlowMonitor.performanceWindows &&
      dataFlowMonitor.performanceWindows[timeRange]
    ) {
      metrics.historical =
        dataFlowMonitor.performanceWindows[timeRange].slice(-50); // Last 50 data points
    }

    res.json({
      success: true,
      data: metrics,
      metadata: {
        requestId,
        timestamp: new Date().toISOString(),
        dataPoints: metrics.historical ? metrics.historical.length : 0,
      },
    });
  } catch (error) {
    logger.error('Data flow metrics endpoint error', {
      error: error.message,
      requestId: req.headers['x-request-id'],
    });

    res.status(500).json({
      success: false,
      error: {
        code: 'METRICS_ERROR',
        message: 'Failed to retrieve performance metrics',
      },
      metadata: {
        requestId: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
      },
    });
  }
});

/**
 * GET /api/data-flow/alerts
 * Get current alerts and alert history
 */
router.get('/alerts', async (req, res) => {
  try {
    const requestId = req.headers['x-request-id'] || 'alerts-' + Date.now();
    const severity = req.query.severity; // optional filter
    const limit = parseInt(req.query.limit, 10) || 50;

    const monitorStatus = dataFlowMonitor.getStatus();

    const alerts = {
      active: monitorStatus.alerts.active,
      history: monitorStatus.alerts.history.slice(-limit),
    };

    // Filter by severity if specified
    if (severity) {
      alerts.history = alerts.history.filter(
        alert => alert.severity === severity
      );
    }

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        alertSummary: {
          activeCount: alerts.active.length,
          historyCount: alerts.history.length,
          severityBreakdown: calculateSeverityBreakdown(alerts.history),
        },
        alerts,
      },
      metadata: {
        requestId,
        timestamp: new Date().toISOString(),
        filters: { severity, limit },
      },
    });
  } catch (error) {
    logger.error('Data flow alerts endpoint error', {
      error: error.message,
      requestId: req.headers['x-request-id'],
    });

    res.status(500).json({
      success: false,
      error: {
        code: 'ALERTS_ERROR',
        message: 'Failed to retrieve alerts',
      },
      metadata: {
        requestId: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
      },
    });
  }
});

/**
 * GET /api/data-flow/health
 * Get health check results
 */
router.get('/health', async (req, res) => {
  try {
    const requestId = req.headers['x-request-id'] || 'health-' + Date.now();

    const healthCheck = await dataFlowMonitor.performHealthCheck();
    const monitorStatus = dataFlowMonitor.getStatus();

    const response = {
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        overall: healthCheck.overall,
        components: healthCheck.components,
        indicators: monitorStatus.healthIndicators,
        uptime: monitorStatus.uptime,
        recommendations: generateHealthRecommendations(healthCheck),
      },
      metadata: {
        requestId,
        timestamp: new Date().toISOString(),
        checkDuration: Date.now() - healthCheck.timestamp,
      },
    };

    // Set appropriate HTTP status based on health
    const statusCode =
      healthCheck.overall === 'critical'
        ? 503
        : healthCheck.overall === 'warning'
          ? 206
          : 200;

    res.status(statusCode).json(response);
  } catch (error) {
    logger.error('Data flow health endpoint error', {
      error: error.message,
      requestId: req.headers['x-request-id'],
    });

    res.status(503).json({
      success: false,
      error: {
        code: 'HEALTH_CHECK_ERROR',
        message: 'Health check failed',
      },
      metadata: {
        requestId: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
      },
    });
  }
});

/**
 * POST /api/data-flow/validate
 * Validate data using specified pipeline
 */
router.post('/validate', validateRequest('graphqlFlow'), async (req, res) => {
  try {
    const requestId = req.headers['x-request-id'] || 'validate-' + Date.now();
    const { data, pipeline, options = {} } = req.body;

    if (!data) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_DATA',
          message: 'Data to validate is required',
        },
        metadata: {
          requestId,
          timestamp: new Date().toISOString(),
        },
      });
    }

    const pipelineName = pipeline || 'weatherIngestion';
    const validationPipeline = VALIDATION_PIPELINES[pipelineName];

    if (!validationPipeline) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_PIPELINE',
          message: `Unknown validation pipeline: ${pipelineName}`,
          availablePipelines: Object.keys(VALIDATION_PIPELINES),
        },
        metadata: {
          requestId,
          timestamp: new Date().toISOString(),
        },
      });
    }

    const startTime = Date.now();
    const result = await dataFlowValidator.validateDataFlow(
      data,
      validationPipeline
    );
    const validationTime = Date.now() - startTime;

    res.json({
      success: result.success,
      data: {
        validationResult: result,
        validatedData: result.finalData,
        pipeline: pipelineName,
        performance: {
          validationTime,
          stagesCompleted: result.stages.length,
        },
      },
      metadata: {
        requestId,
        timestamp: new Date().toISOString(),
        validationTime,
      },
    });
  } catch (error) {
    logger.error('Data flow validation endpoint error', {
      error: error.message,
      requestId: req.headers['x-request-id'],
    });

    res.status(500).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Validation failed due to internal error',
      },
      metadata: {
        requestId: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
      },
    });
  }
});

/**
 * GET /api/data-flow/pipelines
 * Get available validation pipelines
 */
router.get('/pipelines', (req, res) => {
  try {
    const requestId = req.headers['x-request-id'] || 'pipelines-' + Date.now();

    const pipelines = Object.entries(VALIDATION_PIPELINES).map(
      ([name, pipeline]) => ({
        name,
        description: pipeline.name,
        stages: pipeline.stages.map(stage => ({
          name: stage.name,
          type: stage.type,
          critical: stage.critical !== false,
          schema: stage.schema,
        })),
      })
    );

    res.json({
      success: true,
      data: {
        pipelines,
        totalCount: pipelines.length,
      },
      metadata: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Data flow pipelines endpoint error', {
      error: error.message,
      requestId: req.headers['x-request-id'],
    });

    res.status(500).json({
      success: false,
      error: {
        code: 'PIPELINES_ERROR',
        message: 'Failed to retrieve pipeline information',
      },
      metadata: {
        requestId: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
      },
    });
  }
});

/**
 * POST /api/data-flow/clear-cache
 * Clear validation cache
 */
router.post('/clear-cache', async (req, res) => {
  try {
    const requestId =
      req.headers['x-request-id'] || 'clear-cache-' + Date.now();
    const { component = 'all' } = req.body;

    const results = {};

    if (component === 'all' || component === 'validation') {
      dataFlowValidator.clearCache();
      results.validation = 'cleared';
    }

    if (component === 'all' || component === 'redis') {
      if (cacheClient.clearCache) {
        await cacheClient.clearCache();
        results.redis = 'cleared';
      } else {
        results.redis = 'not available';
      }
    }

    res.json({
      success: true,
      data: {
        message: 'Cache cleared successfully',
        components: results,
      },
      metadata: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Data flow clear cache endpoint error', {
      error: error.message,
      requestId: req.headers['x-request-id'],
    });

    res.status(500).json({
      success: false,
      error: {
        code: 'CLEAR_CACHE_ERROR',
        message: 'Failed to clear cache',
      },
      metadata: {
        requestId: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
      },
    });
  }
});

/**
 * GET /api/data-flow/statistics
 * Get comprehensive statistics for all components
 */
router.get('/statistics', async (req, res) => {
  try {
    const requestId = req.headers['x-request-id'] || 'stats-' + Date.now();

    const stats = {
      validator: dataFlowValidator.getStatistics(),
      monitor: dataFlowMonitor.getStatus(),
      database: connectionPool.getPoolStatistics
        ? connectionPool.getPoolStatistics()
        : {},
      cache: cacheClient.getStatistics ? await cacheClient.getStatistics() : {},
    };

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        statistics: stats,
        summary: {
          totalValidations: stats.validator.validationCount,
          totalErrors: stats.validator.errorCount,
          systemUptime: stats.monitor.uptime,
          successRate: stats.validator.successRate,
        },
      },
      metadata: {
        requestId,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error('Data flow statistics endpoint error', {
      error: error.message,
      requestId: req.headers['x-request-id'],
    });

    res.status(500).json({
      success: false,
      error: {
        code: 'STATISTICS_ERROR',
        message: 'Failed to retrieve statistics',
      },
      metadata: {
        requestId: req.headers['x-request-id'],
        timestamp: new Date().toISOString(),
      },
    });
  }
});

// Helper functions
function calculateOverallLatency(metrics) {
  if (!metrics) return null;

  const components = ['validation', 'database', 'cache', 'transformation'];
  const latencies = components
    .map(comp => metrics[comp]?.avgLatency)
    .filter(lat => lat !== undefined && lat !== null);

  if (latencies.length === 0) return null;

  return Math.round(
    latencies.reduce((sum, lat) => sum + lat, 0) / latencies.length
  );
}

function calculateThroughput(metrics) {
  if (!metrics) return null;

  const components = ['validation', 'database', 'transformation'];
  const throughputs = components
    .map(comp => metrics[comp]?.opsPerSecond)
    .filter(ops => ops !== undefined && ops !== null);

  if (throughputs.length === 0) return null;

  return Math.round(throughputs.reduce((sum, ops) => sum + ops, 0));
}

function calculateErrorRate(validatorStats) {
  if (!validatorStats || validatorStats.validationCount === 0) return 0;

  return (
    (validatorStats.errorCount / validatorStats.validationCount) *
    100
  ).toFixed(2);
}

function calculateSeverityBreakdown(alerts) {
  const breakdown = { critical: 0, warning: 0, info: 0 };

  alerts.forEach(alert => {
    if (breakdown.hasOwnProperty(alert.severity)) {
      breakdown[alert.severity]++;
    }
  });

  return breakdown;
}

function generateHealthRecommendations(healthCheck) {
  const recommendations = [];

  if (!healthCheck.components) return recommendations;

  Object.entries(healthCheck.components).forEach(([component, health]) => {
    if (health.status === 'critical') {
      recommendations.push({
        component,
        priority: 'high',
        action: `Immediate attention required for ${component}`,
        issues: health.issues || [],
      });
    } else if (health.status === 'warning') {
      recommendations.push({
        component,
        priority: 'medium',
        action: `Monitor ${component} performance closely`,
        issues: health.issues || [],
      });
    }
  });

  return recommendations;
}

module.exports = router;
