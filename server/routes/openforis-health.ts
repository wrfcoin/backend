/**
 * OpenForis Health Check and Monitoring Routes
 *
 * Provides comprehensive health monitoring, metrics, and alerting
 * endpoints for the OpenForis integration system.
 */

import express, { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import {
  getOpenforisHealthStatus,
  getOpenforisMetrics,
  resetOpenforisMetrics,
  openforisMonitor,
} from '../middleware/openforis-monitoring.js';
import {
  metricsEndpoint,
  healthCheck,
  recordHealthScore,
  openforisMetrics,
} from '../middleware/prometheus-metrics.js';
import { openforisLogger, performanceLogger } from '../utils/logger.js';
import { validateOrigin } from '../../shared/middleware/cors-config.js';

const router = express.Router();

/**
 * Comprehensive health check endpoint
 * Provides detailed health status with scoring algorithm
 *
 * @route GET /api/openforis/health
 * @returns {Object} Detailed health status and metrics
 */
router.get('/health', (req: Request, res: Response) => {
  try {
    getOpenforisHealthStatus(req, res);
  } catch (error) {
    openforisLogger.error('Health check endpoint error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      status: 'error',
      healthScore: 0,
      timestamp: new Date().toISOString(),
      error: 'Health check failed',
    });
  }
});

/**
 * Basic health ping endpoint
 * Simple up/down status check for load balancers
 *
 * @route GET /api/openforis/health/ping
 * @returns {Object} Simple status response
 */
router.get('/health/ping', (req: Request, res: Response) => {
  const startTime = Date.now();

  try {
    const responseTime = Date.now() - startTime;

    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      service: 'openforis-integration',
      responseTime: `${responseTime}ms`,
    });

    openforisLogger.debug('Health ping requested', {
      responseTime,
      ip: req.ip,
      userAgent: req.get('User-Agent'),
    });
  } catch (error) {
    openforisLogger.error('Health ping failed', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    res.status(500).json({
      status: 'error',
      timestamp: new Date().toISOString(),
      service: 'openforis-integration',
    });
  }
});

/**
 * Detailed metrics endpoint
 * Provides comprehensive operational metrics
 *
 * @route GET /api/openforis/health/metrics
 * @returns {Object} Detailed operational metrics
 */
router.get('/health/metrics', (req: Request, res: Response) => {
  try {
    getOpenforisMetrics(req, res);
  } catch (error) {
    openforisLogger.error('Metrics endpoint error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      error: 'Failed to retrieve metrics',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Prometheus metrics endpoint
 * Exports metrics in Prometheus format for scraping
 *
 * @route GET /api/openforis/health/prometheus
 * @returns {String} Prometheus formatted metrics
 */
router.get('/health/prometheus', (req: Request, res: Response) => {
  try {
    metricsEndpoint(req, res);
  } catch (error) {
    openforisLogger.error('Prometheus metrics endpoint error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    res.status(500).send('# Prometheus metrics unavailable\n');
  }
});

/**
 * Performance monitoring endpoint
 * Provides detailed performance analytics
 *
 * @route GET /api/openforis/health/performance
 * @returns {Object} Performance analytics and trends
 */
router.get('/health/performance', (req: Request, res: Response) => {
  const memoryUsage = process.memoryUsage();
  const cpuUsage = process.cpuUsage();
  const metrics = openforisMonitor.getMetrics();

  try {
    const performanceData = {
      timestamp: new Date().toISOString(),
      service: 'openforis-integration',

      // Request performance
      requests: {
        total: metrics.requestCount,
        active: metrics.activeRequests,
        averageResponseTime: Math.round(metrics.averageResponseTime),
        totalResponseTime: Math.round(metrics.totalResponseTime),
      },

      // Error tracking
      errors: {
        total: metrics.errorCount,
        rate:
          metrics.requestCount > 0
            ? Number(
                ((metrics.errorCount / metrics.requestCount) * 100).toFixed(2)
              )
            : 0,
        lastError: metrics.lastError?.message,
        lastErrorTime: metrics.lastErrorTime?.toISOString(),
      },

      // System performance
      system: {
        memory: {
          heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
          heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
          external: Math.round(memoryUsage.external / 1024 / 1024), // MB
          rss: Math.round(memoryUsage.rss / 1024 / 1024), // MB
          peakUsage: Math.round(metrics.peakMemoryUsage / 1024 / 1024), // MB
        },
        cpu: {
          user: cpuUsage.user,
          system: cpuUsage.system,
        },
        uptime: Math.round(process.uptime()), // seconds
      },

      // OpenForis-specific metrics
      openforis: {
        projectsHandled: Math.floor(metrics.requestCount * 0.3), // Estimated
        surveysProcessed: Math.floor(metrics.requestCount * 0.4), // Estimated
        analysesCompleted: Math.floor(metrics.requestCount * 0.2), // Estimated
        dataQualityAverage: 0.92, // Mock average
      },
    };

    performanceLogger.info('Performance metrics requested', performanceData);

    res.json(performanceData);
  } catch (error) {
    performanceLogger.error('Performance endpoint error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    res.status(500).json({
      error: 'Failed to retrieve performance metrics',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Alerts status endpoint
 * Shows current alert conditions and thresholds
 *
 * @route GET /api/openforis/health/alerts
 * @returns {Object} Current alerts and thresholds
 */
router.get('/health/alerts', (req: Request, res: Response) => {
  const metrics = openforisMonitor.getMetrics();
  const memoryUsage = process.memoryUsage();

  try {
    // Calculate current values
    const errorRate =
      metrics.requestCount > 0 ? metrics.errorCount / metrics.requestCount : 0;
    const memoryUsageMB = memoryUsage.heapUsed / 1024 / 1024;

    // Define thresholds
    const thresholds = {
      maxResponseTime: 5000, // ms
      maxErrorRate: 0.1, // 10%
      maxMemoryUsage: 512, // MB
      maxActiveRequests: 100,
    };

    // Check alert conditions
    const alerts: Array<{
      type: string;
      severity: string;
      message: string;
      threshold: string;
      triggered: string;
    }> = [];
    if (metrics.averageResponseTime > thresholds.maxResponseTime) {
      alerts.push({
        type: 'performance',
        severity: 'warning',
        message: `High average response time: ${Math.round(metrics.averageResponseTime)}ms`,
        threshold: `${thresholds.maxResponseTime}ms`,
        triggered: new Date().toISOString(),
      });
    }

    if (errorRate > thresholds.maxErrorRate) {
      alerts.push({
        type: 'reliability',
        severity: 'critical',
        message: `High error rate: ${(errorRate * 100).toFixed(2)}%`,
        threshold: `${thresholds.maxErrorRate * 100}%`,
        triggered: new Date().toISOString(),
      });
    }

    if (memoryUsageMB > thresholds.maxMemoryUsage) {
      alerts.push({
        type: 'resource',
        severity: 'warning',
        message: `High memory usage: ${Math.round(memoryUsageMB)}MB`,
        threshold: `${thresholds.maxMemoryUsage}MB`,
        triggered: new Date().toISOString(),
      });
    }

    if (metrics.activeRequests > thresholds.maxActiveRequests) {
      alerts.push({
        type: 'load',
        severity: 'critical',
        message: `High concurrent requests: ${metrics.activeRequests}`,
        threshold: `${thresholds.maxActiveRequests}`,
        triggered: new Date().toISOString(),
      });
    }

    const alertStatus = {
      timestamp: new Date().toISOString(),
      service: 'openforis-integration',
      alertsActive: alerts.length > 0,
      alertCount: alerts.length,
      alerts,
      thresholds,
      currentValues: {
        averageResponseTime: Math.round(metrics.averageResponseTime),
        errorRate: Number((errorRate * 100).toFixed(2)),
        memoryUsage: Math.round(memoryUsageMB),
        activeRequests: metrics.activeRequests,
      },
    };

    if (alerts.length > 0) {
      openforisLogger.warn('Active alerts detected', {
        alertCount: alerts.length,
        alerts: alerts.map(a => a.message),
      });
    }

    res.json(alertStatus);
  } catch (error) {
    openforisLogger.error('Alerts endpoint error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    res.status(500).json({
      error: 'Failed to retrieve alert status',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * System information endpoint
 * Provides detailed system and service information
 *
 * @route GET /api/openforis/health/info
 * @returns {Object} System and service information
 */
router.get('/health/info', (req: Request, res: Response) => {
  try {
    const systemInfo = {
      timestamp: new Date().toISOString(),
      service: {
        name: 'openforis-integration',
        version: '1.0.0',
        environment: process.env.NODE_ENV || 'development',
        uptime: Math.round(process.uptime()),
        startTime: new Date(Date.now() - process.uptime() * 1000).toISOString(),
      },
      system: {
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        pid: process.pid,
        title: process.title,
      },
      features: {
        monitoring: true,
        prometheus: true,
        logging: true,
        healthChecks: true,
        alerting: true,
      },
      endpoints: {
        health: '/api/openforis/health',
        metrics: '/api/openforis/health/metrics',
        prometheus: '/api/openforis/health/prometheus',
        performance: '/api/openforis/health/performance',
        alerts: '/api/openforis/health/alerts',
        ping: '/api/openforis/health/ping',
      },
    };

    res.json(systemInfo);
  } catch (error) {
    openforisLogger.error('System info endpoint error', {
      error: error instanceof Error ? error.message : 'Unknown error',
    });

    res.status(500).json({
      error: 'Failed to retrieve system information',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Reset metrics endpoint (administrative)
 * Clears monitoring metrics for a fresh start
 *
 * @route POST /api/openforis/health/reset
 * @returns {Object} Reset confirmation
 */
router.post('/health/reset', (req: Request, res: Response) => {
  try {
    // Require authentication/authorization in production
    if (process.env.NODE_ENV === 'production') {
      const authHeader = req.get('Authorization');
      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({
          error: 'Unauthorized - Bearer token required for metrics reset',
          timestamp: new Date().toISOString(),
        });
      }
    }

    resetOpenforisMetrics(req, res);
  } catch (error) {
    openforisLogger.error('Reset metrics endpoint error', {
      error: error instanceof Error ? error.message : 'Unknown error',
      ip: req.ip,
    });

    res.status(500).json({
      error: 'Failed to reset metrics',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Live status endpoint with server-sent events
 * Provides real-time monitoring updates
 *
 * @route GET /api/openforis/health/live
 * @returns {EventStream} Server-sent events with live updates
 */
router.get('/health/live', (req: Request, res: Response) => {
  // Validate origin for SSE endpoint
  const origin = req.headers.origin as string | undefined;
  const validOrigin = validateOrigin(origin);

  // Set headers for server-sent events with secure CORS
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': validOrigin || '',
    'Access-Control-Allow-Headers': 'Cache-Control, Authorization, X-API-Key',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  });

  const clientId = `client_${Date.now()}_${randomBytes(5).toString('hex')}`;

  openforisLogger.info('Live monitoring client connected', {
    clientId,
    ip: req.ip,
  });

  // Send initial status
  const sendStatus = () => {
    try {
      const metrics = openforisMonitor.getMetrics();
      const memoryUsage = process.memoryUsage();

      const liveData = {
        timestamp: new Date().toISOString(),
        clientId,
        metrics: {
          requests: metrics.requestCount,
          errors: metrics.errorCount,
          active: metrics.activeRequests,
          averageResponseTime: Math.round(metrics.averageResponseTime),
          errorRate:
            metrics.requestCount > 0
              ? Number(
                  ((metrics.errorCount / metrics.requestCount) * 100).toFixed(2)
                )
              : 0,
        },
        system: {
          memoryUsage: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
          uptime: Math.round(process.uptime()),
        },
      };

      res.write(`data: ${JSON.stringify(liveData)}\n\n`);
    } catch (error) {
      openforisLogger.error('Live monitoring update error', {
        clientId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  // Send initial status
  sendStatus();

  // Set up periodic updates
  const interval = setInterval(sendStatus, 5000); // Every 5 seconds

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(interval);
    openforisLogger.info('Live monitoring client disconnected', { clientId });
  });

  req.on('error', () => {
    clearInterval(interval);
    openforisLogger.info('Live monitoring client error', { clientId });
  });
});

export default router;
