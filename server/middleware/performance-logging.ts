/**
 * Performance Monitoring and Logging Integration - Task 67.4
 *
 * Advanced performance monitoring middleware that integrates with existing
 * monitoring systems (Grafana/Prometheus) and provides detailed logging.
 */

import { Request, Response, NextFunction } from 'express';
import { performance, PerformanceObserver } from 'perf_hooks';
import * as promClient from 'prom-client';
import {
  performanceLogger,
  appLogger,
  logPerformanceMetrics,
  getCorrelationId,
} from '../utils/logger.js';

// Performance metrics for Prometheus integration
const httpRequestDuration = new promClient.Histogram({
  name: 'http_request_duration_ms',
  help: 'Duration of HTTP requests in ms',
  labelNames: ['method', 'route', 'status_code', 'service'],
  buckets: [1, 5, 15, 50, 100, 200, 500, 1000, 2000, 5000],
});

const httpRequestsTotal = new promClient.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code', 'service'],
});

const httpRequestSize = new promClient.Histogram({
  name: 'http_request_size_bytes',
  help: 'Size of HTTP requests in bytes',
  labelNames: ['method', 'route', 'service'],
  buckets: [100, 1000, 10000, 100000, 1000000],
});

const httpResponseSize = new promClient.Histogram({
  name: 'http_response_size_bytes',
  help: 'Size of HTTP responses in bytes',
  labelNames: ['method', 'route', 'status_code', 'service'],
  buckets: [100, 1000, 10000, 100000, 1000000, 10000000],
});

const activeConnections = new promClient.Gauge({
  name: 'http_active_connections',
  help: 'Number of active HTTP connections',
  labelNames: ['service'],
});

const databaseQueryDuration = new promClient.Histogram({
  name: 'database_query_duration_ms',
  help: 'Duration of database queries in ms',
  labelNames: ['query_type', 'table', 'operation'],
  buckets: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000],
});

const redisOperationDuration = new promClient.Histogram({
  name: 'redis_operation_duration_ms',
  help: 'Duration of Redis operations in ms',
  labelNames: ['operation', 'key_pattern'],
  buckets: [1, 2, 5, 10, 25, 50, 100, 250, 500],
});

const serviceCallDuration = new promClient.Histogram({
  name: 'service_call_duration_ms',
  help: 'Duration of service calls in ms',
  labelNames: ['target_service', 'endpoint', 'method', 'status'],
  buckets: [10, 50, 100, 200, 500, 1000, 2000, 5000, 10000],
});

const memoryUsage = new promClient.Gauge({
  name: 'nodejs_memory_usage_bytes',
  help: 'Memory usage in bytes',
  labelNames: ['type'],
});

const cpuUsage = new promClient.Gauge({
  name: 'nodejs_cpu_usage_percent',
  help: 'CPU usage percentage',
  labelNames: ['type'],
});

// Performance tracking utilities
interface PerformanceContext {
  startTime: number;
  startMemory: NodeJS.MemoryUsage;
  startCpu: NodeJS.CpuUsage;
  marks: Map<string, number>;
  measures: Map<string, number>;
}

// Enhanced request interface
interface RequestWithPerformance extends Request {
  performanceContext?: PerformanceContext;
}

// Performance observer for detailed timing
const perfObserver = new PerformanceObserver(list => {
  const entries = list.getEntries();

  entries.forEach(entry => {
    if (entry.entryType === 'measure') {
      performanceLogger.debug(`Performance measure: ${entry.name}`, {
        operation: 'performance:measure',
        duration: entry.duration,
        startTime: entry.startTime,
        name: entry.name,
      });
    }
  });
});

perfObserver.observe({ entryTypes: ['measure'] });

// Create performance context for request
function createPerformanceContext(): PerformanceContext {
  return {
    startTime: performance.now(),
    startMemory: process.memoryUsage(),
    startCpu: process.cpuUsage(),
    marks: new Map(),
    measures: new Map(),
  };
}

// Add performance mark
function addPerformanceMark(context: PerformanceContext, name: string): void {
  const markTime = performance.now();
  context.marks.set(name, markTime);
  performance.mark(`${getCorrelationId()}-${name}`);
}

// Add performance measure
function addPerformanceMeasure(
  context: PerformanceContext,
  name: string,
  startMark?: string
): number {
  const now = performance.now();
  const startTime = startMark
    ? context.marks.get(startMark) || context.startTime
    : context.startTime;
  const duration = now - startTime;

  context.measures.set(name, duration);

  try {
    const correlationId = getCorrelationId();
    const startMarkName = startMark
      ? `${correlationId}-${startMark}`
      : undefined;
    const measureName = `${correlationId}-${name}`;

    if (startMarkName) {
      performance.measure(measureName, startMarkName);
    } else {
      performance.measure(measureName, { start: startTime });
    }
  } catch (error) {
    // Ignore performance API errors
  }

  return duration;
}

// Main performance monitoring middleware
export function performanceMonitoringMiddleware(
  req: RequestWithPerformance,
  res: Response,
  next: NextFunction
): void {
  // Create performance context
  req.performanceContext = createPerformanceContext();

  // Track active connections
  activeConnections.inc({ service: 'api' });

  // Mark request start
  addPerformanceMark(req.performanceContext, 'request-start');

  // Track request size
  const requestSize = parseInt(req.headers['content-length'] || '0', 10);
  if (requestSize > 0) {
    httpRequestSize.observe(
      {
        method: req.method,
        route: req.route?.path || req.path,
        service: 'api',
      },
      requestSize
    );
  }

  // Override response methods to capture metrics
  const originalSend = res.send;
  const originalJson = res.json;
  const originalEnd = res.end;

  let performanceLogged = false;

  const logPerformance = (responseBody?: any) => {
    if (performanceLogged || !req.performanceContext) return;
    performanceLogged = true;

    // Mark request end and measure total duration
    addPerformanceMark(req.performanceContext, 'request-end');
    const totalDuration = addPerformanceMeasure(
      req.performanceContext,
      'total-request',
      'request-start'
    );

    // Calculate resource usage
    const endMemory = process.memoryUsage();
    const endCpu = process.cpuUsage(req.performanceContext.startCpu);

    const memoryDelta = {
      heapUsed:
        endMemory.heapUsed - req.performanceContext.startMemory.heapUsed,
      heapTotal:
        endMemory.heapTotal - req.performanceContext.startMemory.heapTotal,
      external:
        endMemory.external - req.performanceContext.startMemory.external,
      rss: endMemory.rss - req.performanceContext.startMemory.rss,
    };

    const cpuDelta = {
      user: endCpu.user / 1000, // Convert to milliseconds
      system: endCpu.system / 1000,
    };

    // Calculate response size
    let responseSize = 0;
    if (responseBody) {
      responseSize = Buffer.byteLength(JSON.stringify(responseBody), 'utf8');
    }

    const route = req.route?.path || req.path;
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
      service: 'api',
    };

    // Update Prometheus metrics
    httpRequestDuration.observe(labels, totalDuration);
    httpRequestsTotal.inc(labels);

    if (responseSize > 0) {
      httpResponseSize.observe(labels, responseSize);
    }

    // Update memory and CPU metrics
    memoryUsage.set({ type: 'heapUsed' }, endMemory.heapUsed);
    memoryUsage.set({ type: 'heapTotal' }, endMemory.heapTotal);
    memoryUsage.set({ type: 'external' }, endMemory.external);
    memoryUsage.set({ type: 'rss' }, endMemory.rss);

    cpuUsage.set({ type: 'user' }, cpuDelta.user);
    cpuUsage.set({ type: 'system' }, cpuDelta.system);

    // Log detailed performance metrics
    const performanceData = {
      operation: `api:${req.method}:${route}`,
      correlationId: getCorrelationId(),
      method: req.method,
      path: req.path,
      route,
      statusCode: res.statusCode,
      duration: totalDuration,
      requestSize,
      responseSize,
      performance: {
        responseTime: totalDuration,
        memoryUsage: endMemory,
        memoryDelta,
        cpuUsage: endCpu,
        cpuDelta,
        marks: Object.fromEntries(req.performanceContext.marks),
        measures: Object.fromEntries(req.performanceContext.measures),
      },
    };

    // Log at appropriate level based on performance
    let logLevel = 'info';
    if (totalDuration > 2000) {
      logLevel = 'warn';
    } else if (totalDuration > 5000) {
      logLevel = 'error';
    }

    performanceLogger.log(
      logLevel as any,
      `API performance: ${req.method} ${route}`,
      performanceData
    );

    // Log to main app logger for correlation
    appLogger.info(`${req.method} ${route} completed`, {
      operation: `api:${req.method}:${route}`,
      statusCode: res.statusCode,
      duration: totalDuration,
      correlationId: getCorrelationId(),
    });

    // Use helper function for structured logging
    logPerformanceMetrics(`${req.method} ${route}`, totalDuration, endMemory, {
      statusCode: res.statusCode,
      requestSize,
      responseSize,
      cpuDelta,
      memoryDelta,
    });

    // Decrement active connections
    activeConnections.dec({ service: 'api' });
  };

  // Override response methods
  res.send = function (body: any) {
    logPerformance(body);
    return originalSend.call(this, body);
  };

  res.json = function (body: any) {
    logPerformance(body);
    return originalJson.call(this, body);
  };

  (res as any).end = function (...args: any[]) {
    logPerformance();
    return (originalEnd as Function).apply(this, args);
  };

  next();
}

// Database query performance logging
export function logDatabaseQuery(
  queryType: string,
  table: string,
  operation: string,
  duration: number,
  success: boolean = true
): void {
  databaseQueryDuration.observe(
    { query_type: queryType, table, operation },
    duration
  );

  const level = success ? 'debug' : 'warn';
  performanceLogger.log(level, `Database query: ${operation} on ${table}`, {
    operation: `database:${operation}`,
    duration,
    queryType,
    table,
    success,
    correlationId: getCorrelationId(),
    performance: {
      queryTime: duration,
    },
  });
}

// Redis operation performance logging
export function logRedisOperation(
  operation: string,
  keyPattern: string,
  duration: number,
  success: boolean = true
): void {
  redisOperationDuration.observe(
    { operation, key_pattern: keyPattern },
    duration
  );

  performanceLogger.debug(`Redis operation: ${operation}`, {
    operation: `redis:${operation}`,
    duration,
    keyPattern,
    success,
    correlationId: getCorrelationId(),
    performance: {
      responseTime: duration,
    },
  });
}

// Service call performance logging
export function logServiceCallPerformance(
  targetService: string,
  endpoint: string,
  method: string,
  duration: number,
  statusCode: number,
  success: boolean
): void {
  serviceCallDuration.observe(
    {
      target_service: targetService,
      endpoint,
      method,
      status: success ? 'success' : 'failure',
    },
    duration
  );

  const level = success ? 'info' : 'warn';
  performanceLogger.log(level, `Service call: ${targetService}${endpoint}`, {
    operation: `service-call:${targetService}`,
    duration,
    statusCode,
    success,
    correlationId: getCorrelationId(),
    serviceCall: {
      targetService,
      endpoint,
      method,
      duration,
      success,
    },
    performance: {
      responseTime: duration,
    },
  });
}

// GraphQL performance logging
export function logGraphQLPerformance(
  operationType: string,
  operationName: string,
  duration: number,
  complexity?: number,
  depth?: number
): void {
  performanceLogger.info(`GraphQL ${operationType}: ${operationName}`, {
    operation: `graphql:${operationType}:${operationName}`,
    duration,
    correlationId: getCorrelationId(),
    graphql: {
      operationType,
      operationName,
      complexity,
      depth,
    },
    performance: {
      responseTime: duration,
    },
  });
}

// Resource usage monitoring
export function startResourceMonitoring(
  intervalMs: number = 30000
): NodeJS.Timeout {
  return setInterval(() => {
    const memory = process.memoryUsage();
    const cpu = process.cpuUsage();

    // Update Prometheus metrics
    memoryUsage.set({ type: 'heapUsed' }, memory.heapUsed);
    memoryUsage.set({ type: 'heapTotal' }, memory.heapTotal);
    memoryUsage.set({ type: 'external' }, memory.external);
    memoryUsage.set({ type: 'rss' }, memory.rss);

    // Log resource usage
    performanceLogger.info('Resource usage snapshot', {
      operation: 'monitoring:resource-usage',
      performance: {
        memoryUsage: memory,
        cpuUsage: cpu,
      },
    });

    // Check for memory leaks (basic detection)
    const heapUsedMB = memory.heapUsed / 1024 / 1024;
    if (heapUsedMB > 512) {
      // Configurable threshold
      appLogger.warn('High memory usage detected', {
        operation: 'monitoring:memory-warning',
        memoryUsageMB: heapUsedMB,
        performance: {
          memoryUsage: memory,
        },
      });
    }
  }, intervalMs);
}

// Export metrics endpoint for Prometheus scraping
export function getMetricsEndpoint() {
  return async (req: Request, res: Response) => {
    try {
      res.set('Content-Type', promClient.register.contentType);
      const metrics = await promClient.register.metrics();
      res.end(metrics);
    } catch (error) {
      res.status(500).end('Error generating metrics');
      appLogger.error('Error generating Prometheus metrics', {
        error: (error as Error).message,
      });
    }
  };
}

// Performance mark and measure utilities for custom instrumentation
export const performanceUtils = {
  mark: (name: string) => {
    const correlationId = getCorrelationId();
    performance.mark(`${correlationId}-${name}`);
  },

  measure: (name: string, startMark?: string) => {
    const correlationId = getCorrelationId();
    const measureName = `${correlationId}-${name}`;
    const startMarkName = startMark
      ? `${correlationId}-${startMark}`
      : undefined;

    try {
      if (startMarkName) {
        performance.measure(measureName, startMarkName);
      } else {
        performance.measure(measureName);
      }

      const measure = performance.getEntriesByName(measureName, 'measure')[0];
      return measure?.duration || 0;
    } catch (error) {
      return 0;
    }
  },

  clearMarks: (name?: string) => {
    if (name) {
      const correlationId = getCorrelationId();
      performance.clearMarks(`${correlationId}-${name}`);
    } else {
      performance.clearMarks();
    }
  },
};

// Export performance context utilities
export {
  createPerformanceContext,
  addPerformanceMark,
  addPerformanceMeasure,
  PerformanceContext,
};
