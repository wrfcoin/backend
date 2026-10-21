/**
 * Performance Monitoring Middleware for Wrfcoin Backend
 * Tracks response times, memory usage, and system performance
 */

import { appLogger } from '../utils/logger.js';

class PerformanceMonitor {
  constructor() {
    this.metrics = {
      requests: new Map(),
      slowQueries: [],
      memorySnapshots: [],
      errorRates: new Map(),
    };
    this.thresholds = {
      slowRequest: 1000, // 1 second
      memoryWarning: 512, // 512 MB
      errorRateWarning: 0.05, // 5%
    };

    // Start periodic monitoring
    this.startPeriodicMonitoring();
  }

  // Middleware for Express
  middleware() {
    return (req, res, next) => {
      const startTime = Date.now();
      const startMemory = process.memoryUsage();

      // Capture original end function
      const originalEnd = res.end;

      res.end = function (chunk, encoding) {
        const endTime = Date.now();
        const responseTime = endTime - startTime;
        const endMemory = process.memoryUsage();

        // Record metrics
        const route = req.route ? req.route.path : req.path;
        this.recordRequest(route, responseTime, res.statusCode, {
          startMemory,
          endMemory,
          method: req.method,
          userAgent: req.get('User-Agent'),
        });

        // Check for slow requests
        if (responseTime > this.thresholds.slowRequest) {
          this.recordSlowRequest(route, responseTime, req.method);
        }

        // Call original end function
        originalEnd.call(res, chunk, encoding);
      }.bind(this);

      next();
    };
  }

  // Record request metrics
  recordRequest(route, responseTime, statusCode, metadata) {
    const key = `${metadata.method}:${route}`;

    if (!this.metrics.requests.has(key)) {
      this.metrics.requests.set(key, {
        count: 0,
        totalTime: 0,
        avgTime: 0,
        minTime: Infinity,
        maxTime: 0,
        errors: 0,
        lastAccess: null,
      });
    }

    const stats = this.metrics.requests.get(key);
    stats.count++;
    stats.totalTime += responseTime;
    stats.avgTime = stats.totalTime / stats.count;
    stats.minTime = Math.min(stats.minTime, responseTime);
    stats.maxTime = Math.max(stats.maxTime, responseTime);
    stats.lastAccess = new Date().toISOString();

    if (statusCode >= 400) {
      stats.errors++;
    }

    // Update error rate
    const errorRate = stats.errors / stats.count;
    this.metrics.errorRates.set(key, errorRate);

    // Alert on high error rate
    if (errorRate > this.thresholds.errorRateWarning && stats.count > 10) {
      appLogger.warn('High error rate detected', {
        operation: 'performance:error-rate:high',
        route: key,
        errorRate: (errorRate * 100).toFixed(2) + '%',
        requestCount: stats.count,
      });
    }
  }

  // Record slow requests
  recordSlowRequest(route, responseTime, method) {
    this.metrics.slowQueries.push({
      route,
      method,
      responseTime,
      timestamp: new Date().toISOString(),
    });

    // Keep only last 100 slow queries
    if (this.metrics.slowQueries.length > 100) {
      this.metrics.slowQueries = this.metrics.slowQueries.slice(-100);
    }

    appLogger.warn('Slow request detected', {
      operation: 'performance:slow-request',
      method,
      route,
      responseTime,
    });
  }

  // Start periodic monitoring
  startPeriodicMonitoring() {
    setInterval(() => {
      this.captureMemorySnapshot();
      this.checkSystemHealth();
    }, 30000); // Every 30 seconds
  }

  // Capture memory snapshot
  captureMemorySnapshot() {
    const memory = process.memoryUsage();
    const snapshot = {
      timestamp: new Date().toISOString(),
      rss: Math.round(memory.rss / 1024 / 1024),
      heapTotal: Math.round(memory.heapTotal / 1024 / 1024),
      heapUsed: Math.round(memory.heapUsed / 1024 / 1024),
      external: Math.round(memory.external / 1024 / 1024),
    };

    this.metrics.memorySnapshots.push(snapshot);

    // Keep only last 100 snapshots
    if (this.metrics.memorySnapshots.length > 100) {
      this.metrics.memorySnapshots = this.metrics.memorySnapshots.slice(-100);
    }

    // Check memory warning
    if (snapshot.heapUsed > this.thresholds.memoryWarning) {
      appLogger.warn('High memory usage detected', {
        operation: 'performance:memory:high',
        heapUsedMB: snapshot.heapUsed,
        thresholdMB: this.thresholds.memoryWarning,
      });
    }
  }

  // Check system health
  checkSystemHealth() {
    const cpuUsage = process.cpuUsage();
    const uptime = process.uptime();

    // Log system status periodically
    if (uptime % 300 < 30) {
      // Every 5 minutes
      appLogger.info('System health status', {
        operation: 'performance:system-health',
        uptimeSeconds: Math.round(uptime),
        cpuMicroseconds: cpuUsage.user + cpuUsage.system,
      });
    }
  }

  // Get performance summary
  getPerformanceSummary() {
    const summary = {
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      requests: {},
      slowQueries: this.metrics.slowQueries.slice(-10), // Last 10
      memory: this.metrics.memorySnapshots.slice(-1)[0], // Latest
      errorRates: {},
    };

    // Process request metrics
    for (const [route, stats] of this.metrics.requests) {
      summary.requests[route] = {
        count: stats.count,
        avgTime: Math.round(stats.avgTime),
        minTime: stats.minTime === Infinity ? 0 : stats.minTime,
        maxTime: stats.maxTime,
        errorRate: ((stats.errors / stats.count) * 100).toFixed(2) + '%',
        lastAccess: stats.lastAccess,
      };
    }

    // Process error rates
    for (const [route, rate] of this.metrics.errorRates) {
      if (rate > 0) {
        summary.errorRates[route] = (rate * 100).toFixed(2) + '%';
      }
    }

    return summary;
  }

  // Reset metrics
  resetMetrics() {
    this.metrics.requests.clear();
    this.metrics.slowQueries = [];
    this.metrics.memorySnapshots = [];
    this.metrics.errorRates.clear();
  }
}

module.exports = PerformanceMonitor;
