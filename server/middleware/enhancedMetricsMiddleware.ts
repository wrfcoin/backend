/**
 * Enhanced Metrics Middleware for Task 84
 *
 * Provides comprehensive HTTP request metrics including:
 * - P50, P95, P99 latency percentiles via Summary
 * - Error rates by endpoint category
 * - Request/Response payload sizes
 * - Throughput per endpoint
 * - Integration with real-metrics-collector for GraphQL and cache metrics
 */

import { Request, Response, NextFunction } from 'express';
import {
  Registry,
  Histogram,
  Counter,
  Summary,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import { logger } from '../../utils/logger.js';
import * as realMetrics from '../../performance/real-metrics-collector.js';

// Create a dedicated registry for HTTP metrics
export const httpMetricsRegistry = new Registry();

// Collect default Node.js metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({
  register: httpMetricsRegistry,
  prefix: 'wrfcoin_nodejs_',
});

// ============================================================================
// Enhanced HTTP Metrics
// ============================================================================

/**
 * HTTP Request Duration Histogram
 * Fine-grained buckets for accurate latency tracking
 */
export const httpRequestDuration = new Histogram({
  name: 'wrfcoin_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code', 'category'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [httpMetricsRegistry],
});

/**
 * HTTP Request Duration Summary for Percentiles
 * Provides P50, P95, P99 latencies
 */
export const httpRequestDurationSummary = new Summary({
  name: 'wrfcoin_http_request_duration_summary_seconds',
  help: 'HTTP request duration percentiles in seconds',
  labelNames: ['method', 'route', 'category'],
  percentiles: [0.5, 0.9, 0.95, 0.99],
  maxAgeSeconds: 600, // 10 minute sliding window
  ageBuckets: 5,
  registers: [httpMetricsRegistry],
});

/**
 * HTTP Request Counter
 */
export const httpRequestTotal = new Counter({
  name: 'wrfcoin_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code', 'category'],
  registers: [httpMetricsRegistry],
});

/**
 * HTTP Error Counter by Type
 */
export const httpErrorsTotal = new Counter({
  name: 'wrfcoin_http_errors_total',
  help: 'Total number of HTTP errors by type',
  labelNames: ['method', 'route', 'status_code', 'error_type', 'category'],
  registers: [httpMetricsRegistry],
});

/**
 * Request Payload Size Histogram
 */
export const requestPayloadSize = new Histogram({
  name: 'wrfcoin_http_request_size_bytes',
  help: 'HTTP request payload size in bytes',
  labelNames: ['method', 'route', 'category'],
  buckets: [100, 1000, 10000, 100000, 1000000, 10000000], // 100B to 10MB
  registers: [httpMetricsRegistry],
});

/**
 * Response Payload Size Histogram
 */
export const responsePayloadSize = new Histogram({
  name: 'wrfcoin_http_response_size_bytes',
  help: 'HTTP response payload size in bytes',
  labelNames: ['method', 'route', 'status_code', 'category'],
  buckets: [100, 1000, 10000, 100000, 1000000, 10000000], // 100B to 10MB
  registers: [httpMetricsRegistry],
});

/**
 * Active Requests Gauge
 */
export const activeRequests = new Gauge({
  name: 'wrfcoin_http_active_requests',
  help: 'Number of active HTTP requests',
  labelNames: ['method', 'category'],
  registers: [httpMetricsRegistry],
});

/**
 * Request Rate per Endpoint (requests per second)
 */
export const requestRateGauge = new Gauge({
  name: 'wrfcoin_http_request_rate_per_second',
  help: 'HTTP request rate per second by endpoint',
  labelNames: ['route', 'category'],
  registers: [httpMetricsRegistry],
});

// ============================================================================
// Route Categorization
// ============================================================================

/**
 * Categorize route for better aggregation and analysis
 */
function categorizeRoute(route: string): string {
  if (route.startsWith('/api/wallet') || route.startsWith('/wallet')) {
    return 'wallet';
  }
  if (route.startsWith('/api/bridge') || route.startsWith('/bridge') || route.includes('cross-chain')) {
    return 'blockchain';
  }
  if (route.startsWith('/api/weather') || route.startsWith('/weather') || route.includes('sensor')) {
    return 'weather';
  }
  if (route.startsWith('/api/nft') || route.startsWith('/nft')) {
    return 'nft';
  }
  if (route.startsWith('/api/governance') || route.startsWith('/governance')) {
    return 'governance';
  }
  if (route.startsWith('/api/carbon') || route.includes('carbon')) {
    return 'carbon';
  }
  if (route.startsWith('/graphql')) {
    return 'graphql';
  }
  if (route.startsWith('/health') || route.startsWith('/metrics') || route.startsWith('/ready')) {
    return 'internal';
  }
  if (route.startsWith('/api/auth') || route.includes('login') || route.includes('logout')) {
    return 'auth';
  }
  return 'general';
}

/**
 * Classify error type based on status code
 */
function classifyError(statusCode: number): string {
  if (statusCode === 400) return 'bad_request';
  if (statusCode === 401) return 'unauthorized';
  if (statusCode === 403) return 'forbidden';
  if (statusCode === 404) return 'not_found';
  if (statusCode === 429) return 'rate_limited';
  if (statusCode >= 400 && statusCode < 500) return 'client_error';
  if (statusCode === 500) return 'internal_error';
  if (statusCode === 502) return 'bad_gateway';
  if (statusCode === 503) return 'service_unavailable';
  if (statusCode === 504) return 'gateway_timeout';
  if (statusCode >= 500) return 'server_error';
  return 'unknown';
}

/**
 * Normalize route path to prevent high cardinality
 * Replaces dynamic segments with placeholders
 */
function normalizeRoute(route: string): string {
  // Replace UUIDs
  let normalized = route.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':uuid'
  );
  // Replace numeric IDs
  normalized = normalized.replace(/\/\d+/g, '/:id');
  // Replace hex addresses (Ethereum, etc.)
  normalized = normalized.replace(/0x[a-fA-F0-9]{40,64}/g, ':address');
  // Replace query strings
  normalized = normalized.split('?')[0];
  // Limit length
  if (normalized.length > 100) {
    normalized = normalized.substring(0, 100);
  }
  return normalized || '/';
}

// ============================================================================
// Request Rate Tracking
// ============================================================================

interface RequestCount {
  count: number;
  windowStart: number;
}

const requestCounts = new Map<string, RequestCount>();
const RATE_WINDOW_MS = 1000; // 1 second window

function updateRequestRate(route: string, category: string): void {
  const key = `${route}:${category}`;
  const now = Date.now();
  const entry = requestCounts.get(key);

  if (!entry || now - entry.windowStart >= RATE_WINDOW_MS) {
    // New window
    if (entry) {
      // Record the rate from the completed window
      requestRateGauge.set({ route, category }, entry.count);
    }
    requestCounts.set(key, { count: 1, windowStart: now });
  } else {
    entry.count++;
  }
}

// ============================================================================
// Middleware Factory
// ============================================================================

export interface EnhancedMetricsOptions {
  /**
   * Routes to skip metrics collection (e.g., /health, /metrics)
   */
  skipRoutes?: string[];

  /**
   * Whether to collect request body size
   */
  collectRequestSize?: boolean;

  /**
   * Whether to collect response body size
   */
  collectResponseSize?: boolean;

  /**
   * Whether to record GraphQL metrics
   */
  recordGraphQL?: boolean;

  /**
   * Whether to log slow requests
   */
  logSlowRequests?: boolean;

  /**
   * Threshold for slow request logging (ms)
   */
  slowRequestThreshold?: number;
}

const defaultOptions: EnhancedMetricsOptions = {
  skipRoutes: ['/health', '/ready', '/live', '/api/metrics', '/metrics'],
  collectRequestSize: true,
  collectResponseSize: true,
  recordGraphQL: true,
  logSlowRequests: true,
  slowRequestThreshold: 1000, // 1 second
};

/**
 * Create enhanced metrics middleware
 */
export function createEnhancedMetricsMiddleware(
  options: EnhancedMetricsOptions = {}
): (req: Request, res: Response, next: NextFunction) => void {
  const opts = { ...defaultOptions, ...options };

  return (req: Request, res: Response, next: NextFunction) => {
    // Skip specified routes
    if (opts.skipRoutes?.some(route => req.path.startsWith(route))) {
      return next();
    }

    const startTime = process.hrtime.bigint();
    const method = req.method;

    // Get normalized route
    const route = normalizeRoute(
      req.route ? req.baseUrl + req.route.path : req.path
    );
    const category = categorizeRoute(route);

    // Track active requests
    activeRequests.inc({ method, category });

    // Record request size
    if (opts.collectRequestSize) {
      const contentLength = parseInt(req.get('content-length') || '0', 10);
      if (contentLength > 0) {
        requestPayloadSize.observe({ method, route, category }, contentLength);
      }
    }

    // Update request rate
    updateRequestRate(route, category);

    // Store original end function
    const originalEnd = res.end;
    let responseSize = 0;

    // Override res.end to capture response
    // Use type assertion to handle Express's complex overloaded signatures
    (res as any).end = function(
      this: Response,
      chunk?: any,
      encodingOrCallback?: any,
      callback?: () => void
    ): Response {
      // Calculate duration
      const endTime = process.hrtime.bigint();
      const durationNs = Number(endTime - startTime);
      const durationSec = durationNs / 1e9;
      const durationMs = durationNs / 1e6;

      const statusCode = res.statusCode.toString();

      // Track active requests (decrement)
      activeRequests.dec({ method, category });

      // Record duration histogram
      httpRequestDuration.observe(
        { method, route, status_code: statusCode, category },
        durationSec
      );

      // Record duration summary (for percentiles)
      httpRequestDurationSummary.observe(
        { method, route, category },
        durationSec
      );

      // Record request count
      httpRequestTotal.inc({ method, route, status_code: statusCode, category });

      // Record response size
      if (opts.collectResponseSize && chunk) {
        responseSize = typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.length;
        responsePayloadSize.observe(
          { method, route, status_code: statusCode, category },
          responseSize
        );
      }

      // Record errors
      if (res.statusCode >= 400) {
        const errorType = classifyError(res.statusCode);
        httpErrorsTotal.inc({
          method,
          route,
          status_code: statusCode,
          error_type: errorType,
          category,
        });
      }

      // Log slow requests
      if (opts.logSlowRequests && durationMs > (opts.slowRequestThreshold || 1000)) {
        logger.warn('Slow request detected', {
          method,
          route,
          statusCode,
          category,
          durationMs: durationMs.toFixed(2),
          requestSize: parseInt(req.get('content-length') || '0', 10),
          responseSize,
        });
      }

      // Record GraphQL metrics if applicable
      if (opts.recordGraphQL && route === '/graphql' && method === 'POST') {
        try {
          const hasError = res.statusCode >= 400;
          realMetrics.recordGraphQLOperation('query', undefined, durationMs, hasError);
        } catch (err) {
          // Ignore errors in metrics recording
        }
      }

      // Call original end
      if (typeof encodingOrCallback === 'function') {
        return (originalEnd as Function).call(this, chunk, encodingOrCallback);
      }
      return (originalEnd as Function).call(this, chunk, encodingOrCallback, callback);
    };

    next();
  };
}

/**
 * Create metrics endpoint handler
 */
export function createEnhancedMetricsEndpoint() {
  return async (req: Request, res: Response): Promise<void> => {
    try {
      // Merge with real-metrics-collector registry
      const [httpMetrics, performanceMetrics] = await Promise.all([
        httpMetricsRegistry.metrics(),
        realMetrics.getPrometheusMetrics(),
      ]);

      res.set('Content-Type', httpMetricsRegistry.contentType);
      res.end(httpMetrics + '\n' + performanceMetrics);
    } catch (error) {
      logger.error('Error generating metrics', { error: (error as Error).message });
      res.status(500).send('Error generating metrics');
    }
  };
}

/**
 * Get summary statistics for monitoring
 */
export async function getMetricsSummary(): Promise<{
  requestsPerSecond: number;
  averageLatencyMs: number;
  errorRate: number;
  activeRequestCount: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  p99LatencyMs: number;
}> {
  // This would need to be calculated from the actual metrics
  // For now, return structure that can be populated
  const metricsJson = await httpMetricsRegistry.getMetricsAsJSON();

  let totalRequests = 0;
  let totalErrors = 0;
  let activeCount = 0;

  for (const metric of metricsJson) {
    if (metric.name === 'wrfcoin_http_requests_total') {
      for (const value of metric.values) {
        totalRequests += value.value;
      }
    }
    if (metric.name === 'wrfcoin_http_errors_total') {
      for (const value of metric.values) {
        totalErrors += value.value;
      }
    }
    if (metric.name === 'wrfcoin_http_active_requests') {
      for (const value of metric.values) {
        activeCount += value.value;
      }
    }
  }

  return {
    requestsPerSecond: 0, // Would need time-series calculation
    averageLatencyMs: 0, // Would need histogram calculation
    errorRate: totalRequests > 0 ? totalErrors / totalRequests : 0,
    activeRequestCount: activeCount,
    p50LatencyMs: 0, // Would come from summary metric
    p95LatencyMs: 0,
    p99LatencyMs: 0,
  };
}

export default {
  createEnhancedMetricsMiddleware,
  createEnhancedMetricsEndpoint,
  getMetricsSummary,
  httpMetricsRegistry,
  httpRequestDuration,
  httpRequestDurationSummary,
  httpRequestTotal,
  httpErrorsTotal,
  requestPayloadSize,
  responsePayloadSize,
  activeRequests,
};
