/**
 * Metrics Middleware
 *
 * This middleware collects and exposes metrics about HTTP requests
 * using simple logging. It measures request durations and status codes.
 *
 * Enhanced for Task 84 with dashboard-compatible metrics.
 */

const { logger } = require('../utils/logger');
const promClient = require('prom-client');

// Import the consolidated Task 84 registry and compatibility layer
let performanceRegistry = null;
let dashboardMetricsModule = null;

// Lazy load TypeScript modules to avoid issues with CommonJS
async function loadMetricsRegistries() {
  if (!performanceRegistry) {
    try {
      const realMetrics = await import('../../performance/real-metrics-collector.js');
      performanceRegistry = realMetrics.performanceRegistry;
    } catch (error) {
      logger.warn('[Metrics] Could not load real-metrics-collector:', error.message);
    }
  }

  if (!dashboardMetricsModule) {
    try {
      dashboardMetricsModule = await import('../../performance/dashboard-metrics.js');
      dashboardMetricsModule.startDashboardMetricsCollection();
    } catch (error) {
      logger.warn('[Metrics] Could not load dashboard-metrics:', error.message);
    }
  }
}

// Create a Registry to store metrics
const register = new promClient.Registry();

// Create metrics counters
const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
});

const httpRequestCounter = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
});

// Register metrics with the Registry
register.registerMetric(httpRequestDurationMicroseconds);
register.registerMetric(httpRequestCounter);

/**
 * Create a middleware that collects metrics for each HTTP request
 * @returns {Function} Express middleware function
 */
function createMetricsMiddleware() {
  return (req, res, next) => {
    // Skip metrics collection for the metrics endpoint itself
    if (req.path === '/api/metrics') {
      return next();
    }

    // Record the start time
    const startTime = Date.now();

    // Store the original end method
    const originalEnd = res.end;

    // Override the end method to calculate duration and record metrics
    res.end = function (...args) {
      // Calculate duration
      const duration = Date.now() - startTime;

      // Get the route - use the route pattern if available, otherwise use the path
      const route = req.route
        ? req.baseUrl + req.route.path
        : req.originalUrl.split('?')[0] || req.path;

      try {
        // Record metrics
        httpRequestDurationMicroseconds
          .labels(req.method, route, res.statusCode)
          .observe(duration);

        httpRequestCounter.labels(req.method, route, res.statusCode).inc();
      } catch (error) {
        // If there's an error recording metrics, just log it but don't fail the request
        logger.error(`Error recording metrics: ${error.message}`);
      }

      // If response was an error, log it with appropriate details
      if (res.statusCode >= 400) {
        // For 4xx errors, it's a client error - log with less detail
        if (res.statusCode < 500) {
          logger.warn(
            `Client error: ${res.statusCode} ${req.method} ${route}`,
            {
              statusCode: res.statusCode,
              method: req.method,
              path: route,
              ip: req.ip || req.connection.remoteAddress,
              duration,
            }
          );
        }
        // For 5xx errors, it's a server error - log with more detail
        else {
          logger.error(
            `Server error: ${res.statusCode} ${req.method} ${route}`,
            {
              statusCode: res.statusCode,
              method: req.method,
              path: route,
              ip: req.ip || req.connection.remoteAddress,
              duration,
              body: req.body
                ? JSON.stringify(req.body).substr(0, 200)
                : undefined,
              query: req.query ? JSON.stringify(req.query) : undefined,
            }
          );
        }
      }
      // For successful responses, log basic info at debug level
      else {
        logger.debug(
          `Request completed: ${res.statusCode} ${req.method} ${route}`,
          {
            statusCode: res.statusCode,
            method: req.method,
            path: route,
            duration,
          }
        );
      }

      // Call the original end method
      return originalEnd.apply(this, args);
    };

    next();
  };
}

/**
 * Create a middleware that exposes Prometheus metrics
 * @returns {Function} Express middleware function
 */
function createMetricsEndpoint() {
  return async (req, res) => {
    try {
      // Ensure all metrics registries are loaded (Task 84)
      await loadMetricsRegistries();

      // Set correct content type for Prometheus metrics
      res.set('Content-Type', register.contentType);

      // Collect metrics from all registries
      const metricsArray = [await register.metrics()];

      // Add performance metrics if available
      if (performanceRegistry) {
        try {
          const perfMetrics = await performanceRegistry.metrics();
          metricsArray.push(perfMetrics);
        } catch (error) {
          logger.debug('[Metrics] Performance metrics unavailable:', error.message);
        }
      }

      // Combine all metrics
      const combinedMetrics = metricsArray.join('\n');

      // Send the metrics
      res.end(combinedMetrics);
    } catch (error) {
      logger.error('Error generating metrics', { error: error.message });
      res.status(500).send('Error generating metrics');
    }
  };
}

module.exports = {
  createMetricsMiddleware,
  createMetricsEndpoint,
};
