/**
 * Metrics API endpoints for Prometheus integration and dashboard data
 */

import express, { Request, Response } from 'express';
import { apiMetricsService } from '../services/api-metrics.js';
import { metricsWebSocketIntegration } from '../services/metrics-websocket-integration.js';
import { apiKeyAuth } from '../middleware/api-key-auth.js';
import { performanceLogger } from '../server/utils/logger.js';

const router = express.Router();

// Helper function for aggregating time series data by granularity
function aggregateByGranularity(
  timeSeriesData: any[],
  granularity: string
): any[] {
  if (!timeSeriesData || timeSeriesData.length === 0) {
    return [];
  }

  const granularityMs =
    granularity === 'hour' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  const aggregatedData: { [key: number]: any } = {};

  timeSeriesData.forEach(point => {
    const roundedTimestamp =
      Math.floor(point.timestamp / granularityMs) * granularityMs;

    if (!aggregatedData[roundedTimestamp]) {
      aggregatedData[roundedTimestamp] = {
        timestamp: roundedTimestamp,
        count: 0,
        totalResponseTime: 0,
        avgResponseTime: 0,
      };
    }

    aggregatedData[roundedTimestamp].count += point.count || 1;
    aggregatedData[roundedTimestamp].totalResponseTime +=
      point.responseTime || 0;
  });

  // Calculate averages
  Object.values(aggregatedData).forEach(point => {
    if (point.count > 0) {
      point.avgResponseTime = point.totalResponseTime / point.count;
    }
  });

  return Object.values(aggregatedData).sort(
    (a, b) => a.timestamp - b.timestamp
  );
}

/**
 * Prometheus metrics endpoint
 * GET /metrics
 */
router.get('/metrics', (req: Request, res: Response) => {
  try {
    const prometheusMetrics = apiMetricsService.getPrometheusMetrics();

    // Set appropriate content type for Prometheus
    res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(prometheusMetrics);
  } catch (error) {
    performanceLogger.error('Error generating Prometheus metrics', { error: (error as Error).message, stack: (error as Error).stack });
    res.status(500).send('# Error generating metrics\n');
  }
});

/**
 * Real-time metrics endpoint for dashboard
 * GET /api/metrics/realtime
 */
router.get(
  '/api/metrics/realtime',
  apiKeyAuth.authenticate({ required: true }),
  (req: Request, res: Response) => {
    try {
      const realTimeMetrics = apiMetricsService.getRealTimeMetrics();
      res.json({
        success: true,
        data: realTimeMetrics,
        timestamp: Date.now(),
      });
    } catch (error) {
      performanceLogger.error('Error fetching real-time metrics', { error: (error as Error).message, stack: (error as Error).stack });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch real-time metrics',
      });
    }
  }
);

/**
 * Aggregated metrics endpoint
 * GET /api/metrics/aggregated
 */
router.get(
  '/api/metrics/aggregated',
  apiKeyAuth.authenticate({ required: true }),
  (req: Request, res: Response) => {
    try {
      const aggregatedMetrics = apiMetricsService.getAggregatedMetrics();
      res.json({
        success: true,
        data: aggregatedMetrics,
        timestamp: Date.now(),
      });
    } catch (error) {
      performanceLogger.error('Error fetching aggregated metrics', { error: (error as Error).message, stack: (error as Error).stack });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch aggregated metrics',
      });
    }
  }
);

/**
 * Health status endpoint
 * GET /api/metrics/health
 */
router.get(
  '/api/metrics/health',
  apiKeyAuth.authenticate({ required: false }), // Allow public health checks
  (req: Request, res: Response) => {
    try {
      const healthStatus = apiMetricsService.getHealthStatus();

      // Set appropriate HTTP status based on health
      const httpStatus =
        healthStatus.status === 'healthy'
          ? 200
          : healthStatus.status === 'degraded'
            ? 200
            : 503;

      res.status(httpStatus).json({
        success: true,
        data: healthStatus,
        timestamp: Date.now(),
      });
    } catch (error) {
      performanceLogger.error('Error fetching health status', { error: (error as Error).message, stack: (error as Error).stack });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch health status',
      });
    }
  }
);

/**
 * Metrics configuration endpoint
 * GET /api/metrics/config
 */
router.get(
  '/api/metrics/config',
  apiKeyAuth.authenticate({ required: true, permissions: ['read'] }),
  (req: Request, res: Response) => {
    try {
      const config = metricsWebSocketIntegration.getAlertConfig();
      const broadcastStats = metricsWebSocketIntegration.getBroadcastStats();

      res.json({
        success: true,
        data: {
          alertConfig: config,
          broadcastStats,
          channels: {
            available: ['api-monitoring', 'global', 'blockchain'],
            current: 'api-monitoring',
          },
        },
      });
    } catch (error) {
      performanceLogger.error('Error fetching metrics config', { error: (error as Error).message, stack: (error as Error).stack });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch metrics configuration',
      });
    }
  }
);

/**
 * Update metrics configuration
 * PUT /api/metrics/config
 */
router.put(
  '/api/metrics/config',
  apiKeyAuth.authenticate({ required: true, permissions: ['admin'] }),
  (req: Request, res: Response) => {
    try {
      const { alertConfig } = req.body;

      if (alertConfig) {
        metricsWebSocketIntegration.updateAlertConfig(alertConfig);
      }

      res.json({
        success: true,
        message: 'Metrics configuration updated successfully',
        data: metricsWebSocketIntegration.getAlertConfig(),
      });
    } catch (error) {
      performanceLogger.error('Error updating metrics config', { error: (error as Error).message, stack: (error as Error).stack });
      res.status(500).json({
        success: false,
        error: 'Failed to update metrics configuration',
      });
    }
  }
);

/**
 * Manual metrics broadcast trigger
 * POST /api/metrics/broadcast
 */
router.post(
  '/api/metrics/broadcast',
  apiKeyAuth.authenticate({ required: true, permissions: ['admin'] }),
  (req: Request, res: Response) => {
    try {
      metricsWebSocketIntegration.broadcastCurrentMetrics();

      res.json({
        success: true,
        message: 'Metrics broadcast triggered successfully',
      });
    } catch (error) {
      performanceLogger.error('Error triggering metrics broadcast', { error: (error as Error).message, stack: (error as Error).stack });
      res.status(500).json({
        success: false,
        error: 'Failed to trigger metrics broadcast',
      });
    }
  }
);

/**
 * Historical metrics endpoint with time range
 * GET /api/metrics/historical
 */
router.get(
  '/api/metrics/historical',
  apiKeyAuth.authenticate({ required: true }),
  (req: Request, res: Response) => {
    try {
      const { from, to, granularity = 'hour' } = req.query;
      const aggregatedMetrics = apiMetricsService.getAggregatedMetrics();

      let timeSeriesData = aggregatedMetrics.timeSeriesData;

      // Apply time range filter if provided
      if (from || to) {
        const fromTimestamp = from ? parseInt(from as string, 10) : 0;
        const toTimestamp = to ? parseInt(to as string, 10) : Date.now();

        timeSeriesData = timeSeriesData.filter(
          point =>
            point.timestamp >= fromTimestamp && point.timestamp <= toTimestamp
        );
      }

      // Apply granularity aggregation if requested
      if (granularity === 'hour' || granularity === 'day') {
        timeSeriesData = aggregateByGranularity(
          timeSeriesData,
          granularity as string
        );
      }

      res.json({
        success: true,
        data: {
          timeSeries: timeSeriesData,
          summary: {
            totalDataPoints: timeSeriesData.length,
            granularity,
            timeRange: {
              from: timeSeriesData[0]?.timestamp || null,
              to: timeSeriesData[timeSeriesData.length - 1]?.timestamp || null,
            },
          },
        },
      });
    } catch (error) {
      performanceLogger.error('Error fetching historical metrics', { error: (error as Error).message, stack: (error as Error).stack });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch historical metrics',
      });
    }
  }
);

/**
 * Top endpoints by various metrics
 * GET /api/metrics/top-endpoints
 */
router.get(
  '/api/metrics/top-endpoints',
  apiKeyAuth.authenticate({ required: true }),
  (req: Request, res: Response) => {
    try {
      const { metric = 'requests', limit = 10 } = req.query;
      const aggregatedMetrics = apiMetricsService.getAggregatedMetrics();
      const realTimeMetrics = apiMetricsService.getRealTimeMetrics();

      const topEndpoints = realTimeMetrics.topEndpoints || [];

      // Sort by requested metric
      switch (metric) {
        case 'responseTime':
          topEndpoints.sort(
            (a, b) => b.averageResponseTime - a.averageResponseTime
          );
          break;
        case 'errors':
          // Would need error data per endpoint
          break;
        case 'requests':
        default:
          topEndpoints.sort((a, b) => b.requests - a.requests);
          break;
      }

      res.json({
        success: true,
        data: {
          endpoints: topEndpoints.slice(0, parseInt(limit as string, 10)),
          metric,
          totalEndpoints: Object.keys(aggregatedMetrics.endpointMetrics).length,
        },
      });
    } catch (error) {
      performanceLogger.error('Error fetching top endpoints', { error: (error as Error).message, stack: (error as Error).stack });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch top endpoints',
      });
    }
  }
);

/**
 * Error analysis endpoint
 * GET /api/metrics/errors
 */
router.get(
  '/api/metrics/errors',
  apiKeyAuth.authenticate({ required: true }),
  (req: Request, res: Response) => {
    try {
      const realTimeMetrics = apiMetricsService.getRealTimeMetrics();
      const aggregatedMetrics = apiMetricsService.getAggregatedMetrics();

      res.json({
        success: true,
        data: {
          recentErrors: realTimeMetrics.recentErrors || [],
          statusCodeDistribution: aggregatedMetrics.statusCodeDistribution,
          errorRate: aggregatedMetrics.errorRate,
          totalErrors: aggregatedMetrics.totalErrors,
        },
      });
    } catch (error) {
      performanceLogger.error('Error fetching error metrics', { error: (error as Error).message, stack: (error as Error).stack });
      res.status(500).json({
        success: false,
        error: 'Failed to fetch error metrics',
      });
    }
  }
);

export default router;
