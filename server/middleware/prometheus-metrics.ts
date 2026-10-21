/**
 * Prometheus Metrics Integration for OpenForis
 *
 * Collects and exports metrics in Prometheus format for monitoring
 * and alerting on OpenForis API performance and errors.
 */

import { Request, Response, NextFunction } from 'express';
import {
  register,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
} from 'prom-client';
import { openforisLogger } from '../utils/logger.js';

// Enable default metrics collection (CPU, memory, etc.)
collectDefaultMetrics({ prefix: 'wrfcoin_' });

// OpenForis-specific metrics
export const openforisMetrics = {
  // Request counter
  httpRequestsTotal: new Counter({
    name: 'wrfcoin_openforis_http_requests_total',
    help: 'Total number of HTTP requests to OpenForis endpoints',
    labelNames: ['method', 'endpoint', 'status_code', 'operation'],
  }),

  // Request duration histogram
  httpRequestDuration: new Histogram({
    name: 'wrfcoin_openforis_http_request_duration_seconds',
    help: 'Duration of HTTP requests to OpenForis endpoints in seconds',
    labelNames: ['method', 'endpoint', 'operation'],
    buckets: [0.1, 0.3, 0.5, 0.7, 1, 3, 5, 7, 10], // seconds
  }),

  // Active requests gauge
  httpActiveRequests: new Gauge({
    name: 'wrfcoin_openforis_http_active_requests',
    help: 'Number of active HTTP requests to OpenForis endpoints',
  }),

  // Project-specific metrics
  projectsTotal: new Gauge({
    name: 'wrfcoin_openforis_projects_total',
    help: 'Total number of OpenForis projects',
    labelNames: ['status', 'type'],
  }),

  projectOperations: new Counter({
    name: 'wrfcoin_openforis_project_operations_total',
    help: 'Total number of project operations',
    labelNames: ['operation', 'status'],
  }),

  // Survey metrics
  surveysTotal: new Counter({
    name: 'wrfcoin_openforis_surveys_total',
    help: 'Total number of surveys submitted',
    labelNames: ['project_id', 'status'],
  }),

  surveyProcessingTime: new Histogram({
    name: 'wrfcoin_openforis_survey_processing_duration_seconds',
    help: 'Time taken to process surveys in seconds',
    labelNames: ['project_id'],
    buckets: [1, 5, 10, 30, 60, 120, 300], // seconds
  }),

  // Analysis metrics
  analysesTotal: new Counter({
    name: 'wrfcoin_openforis_analyses_total',
    help: 'Total number of analyses run',
    labelNames: ['analysis_type', 'status'],
  }),

  analysisProcessingTime: new Histogram({
    name: 'wrfcoin_openforis_analysis_processing_duration_seconds',
    help: 'Time taken to process analyses in seconds',
    labelNames: ['analysis_type'],
    buckets: [10, 30, 60, 120, 300, 600, 1200], // seconds
  }),

  // Data quality metrics
  dataQualityScore: new Gauge({
    name: 'wrfcoin_openforis_data_quality_score',
    help: 'Average data quality score',
    labelNames: ['project_id', 'data_type'],
  }),

  // Error metrics
  errorRate: new Gauge({
    name: 'wrfcoin_openforis_error_rate',
    help: 'Current error rate (errors per minute)',
  }),

  // Memory and performance metrics
  memoryUsage: new Gauge({
    name: 'wrfcoin_openforis_memory_usage_bytes',
    help: 'Memory usage of OpenForis operations',
    labelNames: ['type'], // heap_used, heap_total, external, rss
  }),

  responseSize: new Histogram({
    name: 'wrfcoin_openforis_response_size_bytes',
    help: 'Size of HTTP responses in bytes',
    labelNames: ['endpoint', 'operation'],
    buckets: [100, 1000, 10000, 100000, 1000000, 10000000], // bytes
  }),

  // API health metrics
  healthScore: new Gauge({
    name: 'wrfcoin_openforis_health_score',
    help: 'Overall health score of OpenForis integration (0-100)',
  }),

  // Blockchain integration metrics
  blockchainExports: new Counter({
    name: 'wrfcoin_openforis_blockchain_exports_total',
    help: 'Total number of blockchain exports',
    labelNames: ['data_type', 'status'],
  }),

  blockchainExportDuration: new Histogram({
    name: 'wrfcoin_openforis_blockchain_export_duration_seconds',
    help: 'Time taken for blockchain exports in seconds',
    labelNames: ['data_type'],
    buckets: [1, 5, 10, 30, 60], // seconds
  }),
};

// Track metric updates over time for rate calculations
let errorCount = 0;
let lastErrorReset = Date.now();

// Prometheus middleware for OpenForis routes
export const prometheusMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();
  const endTimer = openforisMetrics.httpRequestDuration.startTimer({
    method: req.method,
    endpoint: req.route?.path || req.path,
    operation: extractOperationFromPath(req.path),
  });

  // Increment active requests
  openforisMetrics.httpActiveRequests.inc();

  // Override res.end to capture metrics
  const originalEnd = res.end;
  res.end = function (chunk?: any, encoding?: any): any {
    const duration = (Date.now() - startTime) / 1000; // Convert to seconds
    const operation = extractOperationFromPath(req.path);

    // Record request metrics
    openforisMetrics.httpRequestsTotal.inc({
      method: req.method,
      endpoint: req.route?.path || req.path,
      status_code: res.statusCode.toString(),
      operation,
    });

    // End duration timer
    endTimer();

    // Record response size if available
    const contentLength = res.get('content-length');
    if (contentLength) {
      openforisMetrics.responseSize.observe(
        {
          endpoint: req.route?.path || req.path,
          operation,
        },
        parseInt(contentLength, 10)
      );
    }

    // Track errors for error rate calculation
    if (res.statusCode >= 400) {
      errorCount++;
      updateErrorRate();
    }

    // Decrement active requests
    openforisMetrics.httpActiveRequests.dec();

    // Update memory metrics
    updateMemoryMetrics();

    // Log metrics update
    if (process.env.LOG_LEVEL === 'debug') {
      openforisLogger.debug('Prometheus metrics updated', {
        method: req.method,
        path: req.path,
        statusCode: res.statusCode,
        duration,
        operation,
      });
    }

    originalEnd.call(this, chunk, encoding);
  };

  next();
};

// Extract operation name from request path
function extractOperationFromPath(path: string): string {
  if (path.includes('/projects') && !path.includes('/plots')) {
    if (path.match(/\/projects\/[^/]+$/)) return 'get_project';
    if (path === '/api/openforis/projects') return 'list_projects';
    return 'project_operation';
  }

  if (path.includes('/plots')) {
    return 'survey_operation';
  }

  if (path.includes('/analysis')) {
    return 'analysis_operation';
  }

  if (path.includes('/climate')) {
    return 'climate_operation';
  }

  if (path.includes('/blockchain')) {
    return 'blockchain_operation';
  }

  if (path.includes('/status') || path.includes('/health')) {
    return 'health_check';
  }

  return 'unknown';
}

// Update error rate metric
function updateErrorRate() {
  const now = Date.now();
  const timeDiff = (now - lastErrorReset) / 1000 / 60; // minutes

  if (timeDiff >= 1) {
    const rate = errorCount / timeDiff;
    openforisMetrics.errorRate.set(rate);

    // Reset counters every 5 minutes
    if (timeDiff >= 5) {
      errorCount = 0;
      lastErrorReset = now;
    }
  }
}

// Update memory usage metrics
function updateMemoryMetrics() {
  const memoryUsage = process.memoryUsage();

  openforisMetrics.memoryUsage.set({ type: 'heap_used' }, memoryUsage.heapUsed);
  openforisMetrics.memoryUsage.set(
    { type: 'heap_total' },
    memoryUsage.heapTotal
  );
  openforisMetrics.memoryUsage.set({ type: 'external' }, memoryUsage.external);
  openforisMetrics.memoryUsage.set({ type: 'rss' }, memoryUsage.rss);
}

// Specialized metric recording functions
export const recordProjectOperation = (
  operation: string,
  status: 'success' | 'error',
  projectType?: string
) => {
  openforisMetrics.projectOperations.inc({
    operation,
    status,
  });

  if (operation === 'create' && projectType) {
    openforisMetrics.projectsTotal.inc({
      status: 'active',
      type: projectType,
    });
  }
};

export const recordSurveySubmission = (
  projectId: string,
  processingTime: number,
  status: 'success' | 'error'
) => {
  openforisMetrics.surveysTotal.inc({
    project_id: projectId,
    status,
  });

  if (status === 'success') {
    openforisMetrics.surveyProcessingTime.observe(
      { project_id: projectId },
      processingTime / 1000 // Convert to seconds
    );
  }
};

export const recordAnalysisExecution = (
  analysisType: string,
  processingTime: number,
  status: 'success' | 'error'
) => {
  openforisMetrics.analysesTotal.inc({
    analysis_type: analysisType,
    status,
  });

  if (status === 'success') {
    openforisMetrics.analysisProcessingTime.observe(
      { analysis_type: analysisType },
      processingTime / 1000 // Convert to seconds
    );
  }
};

export const recordDataQuality = (
  projectId: string,
  dataType: string,
  qualityScore: number
) => {
  openforisMetrics.dataQualityScore.set(
    {
      project_id: projectId,
      data_type: dataType,
    },
    qualityScore
  );
};

export const recordHealthScore = (score: number) => {
  openforisMetrics.healthScore.set(score);
};

export const recordBlockchainExport = (
  dataType: string,
  exportTime: number,
  status: 'success' | 'error'
) => {
  openforisMetrics.blockchainExports.inc({
    data_type: dataType,
    status,
  });

  if (status === 'success') {
    openforisMetrics.blockchainExportDuration.observe(
      { data_type: dataType },
      exportTime / 1000 // Convert to seconds
    );
  }
};

// Metrics endpoint handler
export const metricsEndpoint = (req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(register.metrics());
};

// Health check with Prometheus metrics
export const healthCheck = async (req: Request, res: Response) => {
  const memoryUsage = process.memoryUsage();
  const heapUsedMB = memoryUsage.heapUsed / 1024 / 1024;

  // Calculate health score based on system metrics
  let healthScore = 100;

  if (heapUsedMB > 256) healthScore -= 10;
  if (heapUsedMB > 512) healthScore -= 30;

  const errorRateMetric = await openforisMetrics.errorRate.get();
  const errorRate = errorRateMetric?.values?.[0]?.value || 0;
  if (errorRate > 1) healthScore -= 20; // More than 1 error per minute
  if (errorRate > 5) healthScore -= 50; // More than 5 errors per minute

  // Update health score metric
  recordHealthScore(healthScore);

  const status =
    healthScore >= 80
      ? 'healthy'
      : healthScore >= 60
        ? 'degraded'
        : 'unhealthy';
  const statusCode =
    status === 'healthy' ? 200 : status === 'degraded' ? 200 : 503;

  res.status(statusCode).json({
    status,
    healthScore,
    timestamp: new Date().toISOString(),
    service: 'openforis-integration',
  });
};

// Initialize periodic metric updates.
//
// #977: unref'd. This runs as an IMPORT SIDE EFFECT, so every module that pulls
// in the metrics middleware — directly or transitively — inherits a 30s handle
// that keeps the event loop alive. A metrics refresh must never be the reason a
// process (or a test runner) fails to exit; `forceExit: true` was masking this on
// the canonical gate. Same fix as #978.
const memoryMetricsTimer = setInterval(() => {
  updateMemoryMetrics();
}, 30000); // Update every 30 seconds
memoryMetricsTimer.unref();

// Export the register for custom integrations
export { register };

export default prometheusMiddleware;
