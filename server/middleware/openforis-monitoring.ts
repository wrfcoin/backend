/**
 * OpenForis Integration Monitoring Middleware
 *
 * Comprehensive monitoring and logging middleware for OpenForis API operations
 * including performance metrics, error tracking, and alerting.
 */

import { Request, Response, NextFunction } from 'express';
import { performance } from 'perf_hooks';
import {
  openforisLogger,
  performanceLogger,
  logError,
  logOpenforisOperation,
  logPerformanceMetrics,
  LogMetadata,
} from '../utils/logger.js';

// Types for monitoring
interface MonitoringMetrics {
  requestCount: number;
  errorCount: number;
  totalResponseTime: number;
  averageResponseTime: number;
  lastError?: Error;
  lastErrorTime?: Date;
  peakMemoryUsage: number;
  activeRequests: number;
}

interface AlertThresholds {
  maxResponseTime: number;
  maxErrorRate: number;
  maxMemoryUsage: number;
  maxActiveRequests: number;
}

// Global monitoring state
class OpenForisMonitor {
  private metrics: MonitoringMetrics = {
    requestCount: 0,
    errorCount: 0,
    totalResponseTime: 0,
    averageResponseTime: 0,
    peakMemoryUsage: 0,
    activeRequests: 0,
  };

  private thresholds: AlertThresholds = {
    maxResponseTime: 5000, // 5 seconds
    maxErrorRate: 0.1, // 10%
    maxMemoryUsage: 512 * 1024 * 1024, // 512MB
    maxActiveRequests: 100,
  };

  private activeRequests = new Map<
    string,
    { startTime: number; endpoint: string }
  >();

  // Update metrics
  updateMetrics(duration: number, isError: boolean, memoryUsage: number) {
    this.metrics.requestCount++;
    this.metrics.totalResponseTime += duration;
    this.metrics.averageResponseTime =
      this.metrics.totalResponseTime / this.metrics.requestCount;

    if (isError) {
      this.metrics.errorCount++;
    }

    if (memoryUsage > this.metrics.peakMemoryUsage) {
      this.metrics.peakMemoryUsage = memoryUsage;
    }
  }

  // Check alert thresholds
  checkAlerts(
    duration: number,
    isError: boolean,
    memoryUsage: number
  ): string[] {
    const alerts: string[] = [];

    // Response time alert
    if (duration > this.thresholds.maxResponseTime) {
      alerts.push(
        `High response time: ${duration}ms (threshold: ${this.thresholds.maxResponseTime}ms)`
      );
    }

    // Error rate alert
    const errorRate = this.metrics.errorCount / this.metrics.requestCount;
    if (errorRate > this.thresholds.maxErrorRate) {
      alerts.push(
        `High error rate: ${(errorRate * 100).toFixed(2)}% (threshold: ${this.thresholds.maxErrorRate * 100}%)`
      );
    }

    // Memory usage alert
    if (memoryUsage > this.thresholds.maxMemoryUsage) {
      alerts.push(
        `High memory usage: ${Math.round(memoryUsage / 1024 / 1024)}MB (threshold: ${Math.round(this.thresholds.maxMemoryUsage / 1024 / 1024)}MB)`
      );
    }

    // Active requests alert
    if (this.metrics.activeRequests > this.thresholds.maxActiveRequests) {
      alerts.push(
        `High concurrent requests: ${this.metrics.activeRequests} (threshold: ${this.thresholds.maxActiveRequests})`
      );
    }

    return alerts;
  }

  // Start request tracking
  startRequest(requestId: string, endpoint: string): number {
    const startTime = performance.now();
    this.activeRequests.set(requestId, { startTime, endpoint });
    this.metrics.activeRequests++;
    return startTime;
  }

  // End request tracking
  endRequest(requestId: string): number | null {
    const request = this.activeRequests.get(requestId);
    if (!request) return null;

    const duration = performance.now() - request.startTime;
    this.activeRequests.delete(requestId);
    this.metrics.activeRequests--;
    return duration;
  }

  // Get current metrics
  getMetrics(): MonitoringMetrics {
    return { ...this.metrics };
  }

  // Reset metrics (for periodic reporting)
  resetMetrics() {
    this.metrics = {
      requestCount: 0,
      errorCount: 0,
      totalResponseTime: 0,
      averageResponseTime: 0,
      peakMemoryUsage: 0,
      activeRequests: this.metrics.activeRequests, // Keep active requests count
    };
  }
}

// Global monitor instance
const monitor = new OpenForisMonitor();

// Extended request interface
interface MonitoredRequest extends Request {
  monitoringId?: string;
  monitoringStartTime?: number;
  openforisContext?: {
    operation: string;
    projectId?: string;
    plotId?: string;
    analysisId?: string;
  };
}

// Extract OpenForis context from request
const extractOpenforisContext = (
  req: MonitoredRequest
): MonitoredRequest['openforisContext'] => {
  const path = req.path;

  if (path.includes('/projects')) {
    if (req.method === 'GET' && path.match(/\/projects\/[^/]+$/)) {
      return {
        operation: 'get_project',
        projectId: req.params.projectId,
      };
    } else if (req.method === 'GET' && path === '/projects') {
      return {
        operation: 'list_projects',
      };
    } else if (req.method === 'POST' && path === '/projects') {
      return {
        operation: 'create_project',
      };
    } else if (path.includes('/plots')) {
      return {
        operation: 'survey_operation',
        projectId: req.params.projectId,
        plotId: req.params.plotId,
      };
    }
  }

  if (path.includes('/analysis')) {
    return {
      operation: 'earth_map_analysis',
      projectId: req.params.projectId,
      plotId: req.params.plotId,
    };
  }

  if (path.includes('/climate')) {
    return {
      operation: 'climate_data',
    };
  }

  if (path.includes('/blockchain')) {
    return {
      operation: 'blockchain_export',
    };
  }

  return {
    operation: 'unknown',
  };
};

// Main monitoring middleware
export const openforisMonitoringMiddleware = (
  req: MonitoredRequest,
  res: Response,
  next: NextFunction
) => {
  // Generate unique request ID
  const requestId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  req.monitoringId = requestId;

  // Extract OpenForis context
  req.openforisContext = extractOpenforisContext(req);

  // Start monitoring
  const startTime = process.hrtime.bigint();
  const memoryBefore = process.memoryUsage();

  monitor.startRequest(requestId, req.path);

  // Log request start
  openforisLogger.info('OpenForis API request started', {
    requestId,
    method: req.method,
    path: req.path,
    userAgent: req.get('User-Agent'),
    ip: req.ip,
    openforis: {
      operation: req.openforisContext?.operation,
      projectId: req.openforisContext?.projectId,
      plotId: req.openforisContext?.plotId,
      apiEndpoint: `${req.method} ${req.path}`,
    },
  });

  // Override res.end to capture response metrics
  const originalEnd = res.end;
  res.end = function (chunk?: any, encoding?: any): any {
    // Calculate metrics
    const endTime = process.hrtime.bigint();
    const duration = Number(endTime - startTime) / 1_000_000; // Convert to milliseconds
    const memoryAfter = process.memoryUsage();
    const memoryDelta = memoryAfter.heapUsed - memoryBefore.heapUsed;

    // End request tracking
    monitor.endRequest(requestId);

    // Determine if this was an error
    const isError = res.statusCode >= 400;
    const isSuccess = res.statusCode >= 200 && res.statusCode < 300;

    // Update monitoring metrics
    monitor.updateMetrics(duration, isError, memoryAfter.heapUsed);

    // Check for alerts
    const alerts = monitor.checkAlerts(duration, isError, memoryAfter.heapUsed);
    if (alerts.length > 0) {
      openforisLogger.warn('OpenForis monitoring alerts triggered', {
        requestId,
        alerts,
        metrics: monitor.getMetrics(),
      });
    }

    // Log operation completion
    logOpenforisOperation(req.openforisContext?.operation || 'unknown', {
      success: isSuccess,
      duration: Math.round(duration),
      projectId: req.openforisContext?.projectId,
      plotId: req.openforisContext?.plotId,
      apiEndpoint: `${req.method} ${req.path}`,
      responseTime: Math.round(duration),
    });

    // Log performance metrics
    logPerformanceMetrics(
      `OpenForis ${req.openforisContext?.operation}`,
      Math.round(duration),
      memoryAfter,
      {
        statusCode: res.statusCode,
        memoryDelta: Math.round(memoryDelta / 1024), // KB
        method: req.method,
        path: req.path,
      }
    );

    // Detailed completion log
    const logLevel = isError ? 'error' : 'info';
    const message = `OpenForis API request ${isError ? 'failed' : 'completed'}`;

    openforisLogger.log(logLevel, message, {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      openforis: {
        operation: req.openforisContext?.operation,
        projectId: req.openforisContext?.projectId,
        plotId: req.openforisContext?.plotId,
        apiEndpoint: `${req.method} ${req.path}`,
        responseTime: Math.round(duration),
      },
      performance: {
        responseTime: Math.round(duration),
        memoryUsage: memoryAfter,
        memoryDelta: Math.round(memoryDelta / 1024),
      },
    });

    // Call original end method
    originalEnd.call(this, chunk, encoding);
  };

  // Handle uncaught errors
  const originalNext = next;
  next = (error?: any) => {
    if (error) {
      const duration = monitor.endRequest(requestId) || 0;

      logError(openforisLogger, 'OpenForis API request error', error, {
        requestId,
        method: req.method,
        path: req.path,
        openforis: {
          operation: req.openforisContext?.operation,
          projectId: req.openforisContext?.projectId,
          plotId: req.openforisContext?.plotId,
          apiEndpoint: `${req.method} ${req.path}`,
          responseTime: Math.round(duration),
        },
      });

      // Update error metrics
      monitor.updateMetrics(duration, true, process.memoryUsage().heapUsed);
    }

    originalNext(error);
  };

  next();
};

// Health check endpoint handler
export const getOpenforisHealthStatus = (req: Request, res: Response) => {
  const metrics = monitor.getMetrics();
  const memoryUsage = process.memoryUsage();

  // Calculate health score based on metrics
  let healthScore = 100;

  // Deduct points for high error rate
  const errorRate =
    metrics.requestCount > 0 ? metrics.errorCount / metrics.requestCount : 0;
  if (errorRate > 0.05) healthScore -= 30; // 5% threshold
  if (errorRate > 0.1) healthScore -= 50; // 10% threshold

  // Deduct points for slow response times
  if (metrics.averageResponseTime > 2000) healthScore -= 20; // 2s threshold
  if (metrics.averageResponseTime > 5000) healthScore -= 40; // 5s threshold

  // Deduct points for high memory usage
  const memoryUsageMB = memoryUsage.heapUsed / 1024 / 1024;
  if (memoryUsageMB > 256) healthScore -= 10; // 256MB threshold
  if (memoryUsageMB > 512) healthScore -= 30; // 512MB threshold

  const status =
    healthScore >= 80
      ? 'healthy'
      : healthScore >= 60
        ? 'degraded'
        : 'unhealthy';

  const healthData = {
    status,
    healthScore,
    timestamp: new Date().toISOString(),
    metrics: {
      requestCount: metrics.requestCount,
      errorCount: metrics.errorCount,
      errorRate: Math.round(errorRate * 10000) / 100, // Percentage with 2 decimals
      averageResponseTime: Math.round(metrics.averageResponseTime),
      activeRequests: metrics.activeRequests,
      peakMemoryUsage: Math.round(metrics.peakMemoryUsage / 1024 / 1024), // MB
    },
    systemMetrics: {
      memoryUsage: {
        heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
        heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
        external: Math.round(memoryUsage.external / 1024 / 1024), // MB
        rss: Math.round(memoryUsage.rss / 1024 / 1024), // MB
      },
      uptime: Math.round(process.uptime()),
    },
  };

  openforisLogger.info('OpenForis health check requested', {
    healthScore,
    status,
    metrics: healthData.metrics,
  });

  const statusCode =
    status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;
  res.status(statusCode).json(healthData);
};

// Metrics endpoint handler
export const getOpenforisMetrics = (req: Request, res: Response) => {
  const metrics = monitor.getMetrics();
  const memoryUsage = process.memoryUsage();

  const detailedMetrics = {
    openforis: {
      requests: {
        total: metrics.requestCount,
        errors: metrics.errorCount,
        errorRate:
          metrics.requestCount > 0
            ? metrics.errorCount / metrics.requestCount
            : 0,
        active: metrics.activeRequests,
      },
      performance: {
        averageResponseTime: metrics.averageResponseTime,
        totalResponseTime: metrics.totalResponseTime,
        peakMemoryUsage: metrics.peakMemoryUsage,
      },
    },
    system: {
      memory: {
        heapUsed: memoryUsage.heapUsed,
        heapTotal: memoryUsage.heapTotal,
        external: memoryUsage.external,
        rss: memoryUsage.rss,
      },
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
  };

  performanceLogger.info('OpenForis metrics requested', detailedMetrics);

  res.json(detailedMetrics);
};

// Reset metrics endpoint (for administrative use)
export const resetOpenforisMetrics = (req: Request, res: Response) => {
  const oldMetrics = monitor.getMetrics();
  monitor.resetMetrics();

  openforisLogger.info('OpenForis metrics reset', {
    previousMetrics: oldMetrics,
    resetBy: req.ip,
    resetAt: new Date().toISOString(),
  });

  res.json({
    success: true,
    message: 'OpenForis monitoring metrics have been reset',
    previousMetrics: oldMetrics,
    timestamp: new Date().toISOString(),
  });
};

// Export monitor instance for external access
export { monitor as openforisMonitor };

export default openforisMonitoringMiddleware;
