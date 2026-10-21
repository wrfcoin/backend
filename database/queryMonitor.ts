/**
 * Database Query Performance Monitor for Task 84.3
 *
 * Provides comprehensive database query profiling including:
 * - Query execution timing with Prometheus histograms
 * - Slow query detection and logging (>100ms threshold)
 * - Connection pool utilization tracking
 * - Query error rate monitoring
 * - Integration with real-metrics-collector
 */

import { Registry, Histogram, Counter, Gauge, Summary } from 'prom-client';
import { logger } from '../utils/logger.js';
import * as realMetrics from '../performance/real-metrics-collector.js';

// Create a dedicated registry for database metrics
export const databaseMetricsRegistry = new Registry();

// ============================================================================
// Database Metrics Configuration
// ============================================================================

const SLOW_QUERY_THRESHOLD_MS = 100; // Log queries slower than 100ms
const VERY_SLOW_QUERY_THRESHOLD_MS = 1000; // 1 second is critically slow

/**
 * Query Duration Histogram
 * Tracks the distribution of query execution times
 */
export const queryDurationHistogram = new Histogram({
  name: 'wrfcoin_database_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation', 'table', 'status'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [databaseMetricsRegistry],
});

/**
 * Query Duration Summary for Percentiles
 * Provides P50, P95, P99 query latencies
 */
export const queryDurationSummary = new Summary({
  name: 'wrfcoin_database_query_duration_summary_seconds',
  help: 'Database query duration percentiles in seconds',
  labelNames: ['operation'],
  percentiles: [0.5, 0.9, 0.95, 0.99],
  maxAgeSeconds: 600,
  ageBuckets: 5,
  registers: [databaseMetricsRegistry],
});

/**
 * Query Counter
 * Total number of queries executed
 */
export const queryTotalCounter = new Counter({
  name: 'wrfcoin_database_queries_total',
  help: 'Total number of database queries',
  labelNames: ['operation', 'status'],
  registers: [databaseMetricsRegistry],
});

/**
 * Query Error Counter
 * Tracks query failures by error type
 */
export const queryErrorCounter = new Counter({
  name: 'wrfcoin_database_query_errors_total',
  help: 'Total number of database query errors',
  labelNames: ['operation', 'error_type'],
  registers: [databaseMetricsRegistry],
});

/**
 * Slow Query Counter
 * Tracks queries exceeding the threshold
 */
export const slowQueryCounter = new Counter({
  name: 'wrfcoin_database_slow_queries_total',
  help: 'Total number of slow database queries (>100ms)',
  labelNames: ['operation', 'severity'],
  registers: [databaseMetricsRegistry],
});

/**
 * Connection Pool Metrics
 */
export const connectionPoolTotal = new Gauge({
  name: 'wrfcoin_database_pool_connections_total',
  help: 'Total connections in the pool',
  registers: [databaseMetricsRegistry],
});

export const connectionPoolIdle = new Gauge({
  name: 'wrfcoin_database_pool_connections_idle',
  help: 'Idle connections in the pool',
  registers: [databaseMetricsRegistry],
});

export const connectionPoolActive = new Gauge({
  name: 'wrfcoin_database_pool_connections_active',
  help: 'Active connections in the pool',
  registers: [databaseMetricsRegistry],
});

export const connectionPoolWaiting = new Gauge({
  name: 'wrfcoin_database_pool_connections_waiting',
  help: 'Clients waiting for a connection',
  registers: [databaseMetricsRegistry],
});

export const connectionPoolErrors = new Counter({
  name: 'wrfcoin_database_pool_errors_total',
  help: 'Total number of pool connection errors',
  labelNames: ['error_type'],
  registers: [databaseMetricsRegistry],
});

// ============================================================================
// Query Parsing Utilities
// ============================================================================

/**
 * Extract operation type from SQL query
 */
function extractOperation(query: string): string {
  const normalized = query.trim().toUpperCase();

  if (normalized.startsWith('SELECT')) return 'select';
  if (normalized.startsWith('INSERT')) return 'insert';
  if (normalized.startsWith('UPDATE')) return 'update';
  if (normalized.startsWith('DELETE')) return 'delete';
  if (normalized.startsWith('BEGIN') || normalized.startsWith('START')) return 'transaction';
  if (normalized.startsWith('COMMIT')) return 'commit';
  if (normalized.startsWith('ROLLBACK')) return 'rollback';
  if (normalized.startsWith('CREATE')) return 'ddl';
  if (normalized.startsWith('ALTER')) return 'ddl';
  if (normalized.startsWith('DROP')) return 'ddl';

  return 'other';
}

/**
 * Extract table name from SQL query (best effort)
 */
function extractTable(query: string): string {
  const normalized = query.trim().toUpperCase();

  // Match patterns like FROM table_name, INTO table_name, UPDATE table_name
  const patterns = [
    /FROM\s+["']?(\w+)["']?/i,
    /INTO\s+["']?(\w+)["']?/i,
    /UPDATE\s+["']?(\w+)["']?/i,
    /DELETE\s+FROM\s+["']?(\w+)["']?/i,
    /JOIN\s+["']?(\w+)["']?/i,
  ];

  for (const pattern of patterns) {
    const match = query.match(pattern);
    if (match && match[1]) {
      return match[1].toLowerCase();
    }
  }

  return 'unknown';
}

/**
 * Classify error type
 */
function classifyError(error: any): string {
  const message = error?.message?.toLowerCase() || '';
  const code = error?.code || '';

  if (code === '23505' || message.includes('unique constraint')) return 'unique_violation';
  if (code === '23503' || message.includes('foreign key')) return 'foreign_key_violation';
  if (code === '23502' || message.includes('not null')) return 'not_null_violation';
  if (code === '42703' || message.includes('column')) return 'column_error';
  if (code === '42P01' || message.includes('relation')) return 'table_not_found';
  if (message.includes('timeout')) return 'timeout';
  if (message.includes('connection')) return 'connection_error';
  if (message.includes('deadlock')) return 'deadlock';
  if (message.includes('syntax')) return 'syntax_error';

  return 'unknown';
}

/**
 * Sanitize query for logging (remove sensitive data)
 */
function sanitizeQuery(query: string): string {
  // Replace string literals with placeholders
  let sanitized = query.replace(/'[^']*'/g, "'***'");
  // Replace numeric values in common patterns
  sanitized = sanitized.replace(/= \d+/g, '= ***');
  // Truncate long queries
  if (sanitized.length > 500) {
    sanitized = sanitized.substring(0, 500) + '...';
  }
  return sanitized;
}

// ============================================================================
// Query Profiler
// ============================================================================

export interface QueryProfileResult {
  durationMs: number;
  operation: string;
  table: string;
  success: boolean;
  isSlow: boolean;
  isVerySlow: boolean;
}

/**
 * Profile a database query execution
 */
export async function profileQuery<T>(
  queryFn: () => Promise<T>,
  query?: string
): Promise<{ result: T; profile: QueryProfileResult }> {
  const startTime = performance.now();
  const operation = query ? extractOperation(query) : 'unknown';
  const table = query ? extractTable(query) : 'unknown';

  let success = true;
  let result: T;

  try {
    result = await queryFn();
  } catch (error) {
    success = false;

    const durationMs = performance.now() - startTime;
    const durationSec = durationMs / 1000;
    const errorType = classifyError(error);

    // Record error metrics
    queryDurationHistogram.observe({ operation, table, status: 'error' }, durationSec);
    queryTotalCounter.inc({ operation, status: 'error' });
    queryErrorCounter.inc({ operation, error_type: errorType });

    // Update real-metrics-collector
    realMetrics.recordDatabaseQuery(durationMs, query);

    // Log the error
    logger.error('Database query failed', {
      operation,
      table,
      durationMs: durationMs.toFixed(2),
      errorType,
      query: query ? sanitizeQuery(query) : undefined,
    });

    throw error;
  }

  const durationMs = performance.now() - startTime;
  const durationSec = durationMs / 1000;
  const isSlow = durationMs > SLOW_QUERY_THRESHOLD_MS;
  const isVerySlow = durationMs > VERY_SLOW_QUERY_THRESHOLD_MS;

  // Record success metrics
  queryDurationHistogram.observe({ operation, table, status: 'success' }, durationSec);
  queryDurationSummary.observe({ operation }, durationSec);
  queryTotalCounter.inc({ operation, status: 'success' });

  // Update real-metrics-collector
  realMetrics.recordDatabaseQuery(durationMs, query);

  // Track slow queries
  if (isSlow) {
    const severity = isVerySlow ? 'critical' : 'warning';
    slowQueryCounter.inc({ operation, severity });

    logger.warn('Slow database query detected', {
      operation,
      table,
      durationMs: durationMs.toFixed(2),
      severity,
      query: query ? sanitizeQuery(query) : undefined,
    });
  }

  const profile: QueryProfileResult = {
    durationMs,
    operation,
    table,
    success,
    isSlow,
    isVerySlow,
  };

  return { result, profile };
}

/**
 * Simple timing wrapper for queries without full profiling
 */
export function recordQueryDuration(
  durationMs: number,
  operation: string = 'unknown',
  table: string = 'unknown',
  success: boolean = true
): void {
  const durationSec = durationMs / 1000;
  const status = success ? 'success' : 'error';

  queryDurationHistogram.observe({ operation, table, status }, durationSec);
  queryDurationSummary.observe({ operation }, durationSec);
  queryTotalCounter.inc({ operation, status });

  // Update real-metrics-collector
  realMetrics.recordDatabaseQuery(durationMs);

  if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
    const severity = durationMs > VERY_SLOW_QUERY_THRESHOLD_MS ? 'critical' : 'warning';
    slowQueryCounter.inc({ operation, severity });
  }
}

// ============================================================================
// Connection Pool Monitoring
// ============================================================================

/**
 * Update connection pool metrics from pool statistics
 */
export function updatePoolMetrics(poolStats: {
  totalCount?: number;
  idleCount?: number;
  waitingCount?: number;
}): void {
  if (poolStats.totalCount !== undefined) {
    connectionPoolTotal.set(poolStats.totalCount);
    connectionPoolActive.set(poolStats.totalCount - (poolStats.idleCount || 0));
  }
  if (poolStats.idleCount !== undefined) {
    connectionPoolIdle.set(poolStats.idleCount);
  }
  if (poolStats.waitingCount !== undefined) {
    connectionPoolWaiting.set(poolStats.waitingCount);
  }
}

/**
 * Record a pool connection error
 */
export function recordPoolError(errorType: string): void {
  connectionPoolErrors.inc({ error_type: errorType });
}

// ============================================================================
// Metrics Export
// ============================================================================

/**
 * Get all database metrics in Prometheus format
 */
export async function getDatabaseMetrics(): Promise<string> {
  return await databaseMetricsRegistry.metrics();
}

/**
 * Get database metrics summary for monitoring
 */
export async function getDatabaseMetricsSummary(): Promise<{
  totalQueries: number;
  errorRate: number;
  slowQueryRate: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  connectionPoolUtilization: number;
}> {
  const metricsJson = await databaseMetricsRegistry.getMetricsAsJSON();

  let totalQueries = 0;
  let totalErrors = 0;
  let totalSlowQueries = 0;
  let poolTotal = 0;
  let poolActive = 0;

  for (const metric of metricsJson) {
    if (metric.name === 'wrfcoin_database_queries_total') {
      for (const value of metric.values) {
        totalQueries += value.value;
        if (value.labels?.status === 'error') {
          totalErrors += value.value;
        }
      }
    }
    if (metric.name === 'wrfcoin_database_slow_queries_total') {
      for (const value of metric.values) {
        totalSlowQueries += value.value;
      }
    }
    if (metric.name === 'wrfcoin_database_pool_connections_total') {
      for (const value of metric.values) {
        poolTotal = value.value;
      }
    }
    if (metric.name === 'wrfcoin_database_pool_connections_active') {
      for (const value of metric.values) {
        poolActive = value.value;
      }
    }
  }

  return {
    totalQueries,
    errorRate: totalQueries > 0 ? totalErrors / totalQueries : 0,
    slowQueryRate: totalQueries > 0 ? totalSlowQueries / totalQueries : 0,
    avgLatencyMs: 0, // Would need histogram calculation
    p95LatencyMs: 0, // Would come from summary metric
    connectionPoolUtilization: poolTotal > 0 ? poolActive / poolTotal : 0,
  };
}

// ============================================================================
// Drizzle ORM Integration Helper
// ============================================================================

/**
 * Create a profiled version of the Drizzle execute function
 * This can be used to wrap Drizzle query execution
 */
export function createProfiledExecutor<T>(
  executor: (query: string, params?: any[]) => Promise<T>
): (query: string, params?: any[]) => Promise<T> {
  return async (query: string, params?: any[]): Promise<T> => {
    const { result } = await profileQuery(
      () => executor(query, params),
      query
    );
    return result;
  };
}

export default {
  profileQuery,
  recordQueryDuration,
  updatePoolMetrics,
  recordPoolError,
  getDatabaseMetrics,
  getDatabaseMetricsSummary,
  createProfiledExecutor,
  databaseMetricsRegistry,
  queryDurationHistogram,
  queryDurationSummary,
  queryTotalCounter,
  queryErrorCounter,
  slowQueryCounter,
  connectionPoolTotal,
  connectionPoolIdle,
  connectionPoolActive,
  connectionPoolWaiting,
};
