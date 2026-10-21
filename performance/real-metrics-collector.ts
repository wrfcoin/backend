/**
 * Real Metrics Collector for Task 84
 * Reduced to a single low-cardinality registry for active backend metrics.
 *
 * Host disk and network telemetry is intentionally delegated to node-exporter.
 */

import * as os from 'os';
import { performance } from 'perf_hooks';
import { Counter, Gauge, Histogram, Registry } from 'prom-client';
import { logger } from '../utils/logger.js';

export const performanceRegistry = new Registry();
export const DEFAULT_COLLECTION_INTERVAL_MS = 60000;

export const systemMetrics = {
  cpuUsage: new Gauge({
    name: 'wrfcoin_system_cpu_usage_percent',
    help: 'Current CPU usage percentage',
    registers: [performanceRegistry],
  }),

  loadAverage: new Gauge({
    name: 'wrfcoin_system_load_average',
    help: 'System load average',
    labelNames: ['period'],
    registers: [performanceRegistry],
  }),

  memoryUsed: new Gauge({
    name: 'wrfcoin_system_memory_used_bytes',
    help: 'Used system memory in bytes',
    registers: [performanceRegistry],
  }),

  memoryTotal: new Gauge({
    name: 'wrfcoin_system_memory_total_bytes',
    help: 'Total system memory in bytes',
    registers: [performanceRegistry],
  }),

  heapUsed: new Gauge({
    name: 'wrfcoin_process_heap_used_bytes',
    help: 'Process heap memory used in bytes',
    registers: [performanceRegistry],
  }),

  heapTotal: new Gauge({
    name: 'wrfcoin_process_heap_total_bytes',
    help: 'Process heap memory total in bytes',
    registers: [performanceRegistry],
  }),

  memoryUsagePercent: new Gauge({
    name: 'wrfcoin_system_memory_usage_percent',
    help: 'System memory usage as percentage (0-100)',
    registers: [performanceRegistry],
  }),

  healthScore: new Gauge({
    name: 'wrfcoin_system_health_score',
    help: 'Overall system health score (0-1)',
    registers: [performanceRegistry],
  }),

  startTime: new Gauge({
    name: 'wrfcoin_system_start_time',
    help: 'System start time in Unix timestamp',
    registers: [performanceRegistry],
  }),
};

export const databaseMetrics = {
  activeConnections: new Gauge({
    name: 'wrfcoin_database_active_connections',
    help: 'Number of active database connections',
    registers: [performanceRegistry],
  }),

  queriesTotal: new Counter({
    name: 'wrfcoin_database_queries_total',
    help: 'Total number of database queries executed',
    registers: [performanceRegistry],
  }),

  queryDuration: new Histogram({
    name: 'wrfcoin_database_query_duration_seconds',
    help: 'Database query duration in seconds',
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [performanceRegistry],
  }),

  slowQueries: new Counter({
    name: 'wrfcoin_database_slow_queries_total',
    help: 'Number of slow database queries (>100ms)',
    registers: [performanceRegistry],
  }),
};

export const graphqlMetrics = {
  operationsTotal: new Counter({
    name: 'wrfcoin_graphql_operations_total',
    help: 'Total GraphQL operations executed',
    labelNames: ['operation_type'],
    registers: [performanceRegistry],
  }),

  resolverDuration: new Histogram({
    name: 'wrfcoin_graphql_resolver_duration_seconds',
    help: 'GraphQL resolver execution duration',
    labelNames: ['operation_type'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
    registers: [performanceRegistry],
  }),

  errors: new Counter({
    name: 'wrfcoin_graphql_errors_total',
    help: 'Total GraphQL errors',
    labelNames: ['error_type'],
    registers: [performanceRegistry],
  }),

  complexity: new Histogram({
    name: 'wrfcoin_graphql_query_complexity',
    help: 'GraphQL query complexity scores',
    buckets: [1, 5, 10, 25, 50, 100, 250, 500],
    registers: [performanceRegistry],
  }),
};

interface MetricsState {
  lastCpuUsage: NodeJS.CpuUsage | null;
  lastCpuTime: number;
  networkBytesIn: number;
  networkBytesOut: number;
  activeConnections: number;
  dbConnectionCount: number;
  dbQueriesPerMinute: number;
  dbSlowQueryCount: number;
  dbQueryTimes: number[];
  graphqlOpsPerMinute: number;
  graphqlComplexities: number[];
  graphqlResolverTimes: number[];
  graphqlErrorCount: number;
  graphqlTotalOps: number;
  slowQueries: Array<{
    query: string;
    latency: number;
    timestamp: string;
  }>;
}

const state: MetricsState = {
  lastCpuUsage: null,
  lastCpuTime: 0,
  networkBytesIn: 0,
  networkBytesOut: 0,
  activeConnections: 0,
  dbConnectionCount: 0,
  dbQueriesPerMinute: 0,
  dbSlowQueryCount: 0,
  dbQueryTimes: [],
  graphqlOpsPerMinute: 0,
  graphqlComplexities: [],
  graphqlResolverTimes: [],
  graphqlErrorCount: 0,
  graphqlTotalOps: 0,
  slowQueries: [],
};

const START_TIME_SECONDS = Math.floor(Date.now() / 1000 - process.uptime());
const ROLLING_WINDOW_MS = 60000;
const queryTimeWindow: Array<{ time: number; duration: number }> = [];
const graphqlOpsWindow: Array<{ time: number }> = [];
const derivedCollectors = new Set<() => Promise<void> | void>();

function updateDerivedSystemMetrics(memoryPercent: number): void {
  const cpuLoad = os.loadavg()[0];
  const cpuCount = Math.max(os.cpus().length, 1);
  const cpuLoadNormalized = Math.min(cpuLoad / cpuCount, 1);
  const memoryNormalized = Math.min(memoryPercent / 100, 1);
  const healthScore = Math.max(0, 1 - ((cpuLoadNormalized * 0.6) + (memoryNormalized * 0.4)));

  systemMetrics.memoryUsagePercent.set(memoryPercent);
  systemMetrics.healthScore.set(healthScore);
  systemMetrics.startTime.set(START_TIME_SECONDS);
}

export function registerDerivedMetricsCollector(
  collector: () => Promise<void> | void
): () => void {
  derivedCollectors.add(collector);
  return () => {
    derivedCollectors.delete(collector);
  };
}

export function getCPUUsage(): number {
  const currentUsage = process.cpuUsage(state.lastCpuUsage || undefined);
  const currentTime = performance.now();

  if (state.lastCpuUsage === null) {
    state.lastCpuUsage = process.cpuUsage();
    state.lastCpuTime = currentTime;
    return 0;
  }

  const elapsedMs = currentTime - state.lastCpuTime;
  if (elapsedMs === 0) {
    return 0;
  }

  const userPercent = (currentUsage.user / 1000 / elapsedMs) * 100;
  const systemPercent = (currentUsage.system / 1000 / elapsedMs) * 100;
  const totalPercent = Math.min(100, userPercent + systemPercent);

  state.lastCpuUsage = process.cpuUsage();
  state.lastCpuTime = currentTime;
  systemMetrics.cpuUsage.set(totalPercent);

  return totalPercent;
}

export function getLoadAverage(): number[] {
  const loadAvg = os.loadavg();

  systemMetrics.loadAverage.set({ period: '1m' }, loadAvg[0]);
  systemMetrics.loadAverage.set({ period: '5m' }, loadAvg[1]);
  systemMetrics.loadAverage.set({ period: '15m' }, loadAvg[2]);

  return loadAvg;
}

export function getMemoryMetrics(): {
  used: number;
  total: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
} {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  const processMemory = process.memoryUsage();
  const memoryPercent = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;

  systemMetrics.memoryUsed.set(usedMem);
  systemMetrics.memoryTotal.set(totalMem);
  systemMetrics.heapUsed.set(processMemory.heapUsed);
  systemMetrics.heapTotal.set(processMemory.heapTotal);
  updateDerivedSystemMetrics(memoryPercent);

  return {
    used: usedMem,
    total: totalMem,
    heapUsed: processMemory.heapUsed,
    heapTotal: processMemory.heapTotal,
    external: processMemory.external,
  };
}

export async function getNetworkStats(): Promise<{
  bytesIn: number;
  bytesOut: number;
  connections: number;
}> {
  return {
    bytesIn: state.networkBytesIn,
    bytesOut: state.networkBytesOut,
    connections: state.activeConnections,
  };
}

export async function getDiskStats(): Promise<{
  readBytes: number;
  writeBytes: number;
  iops: number;
}> {
  return {
    readBytes: 0,
    writeBytes: 0,
    iops: 0,
  };
}

export function recordDatabaseQuery(durationMs: number, query?: string): void {
  const now = Date.now();
  const durationSeconds = durationMs / 1000;

  databaseMetrics.queryDuration.observe(durationSeconds);
  databaseMetrics.queriesTotal.inc();

  queryTimeWindow.push({ time: now, duration: durationMs });

  const cutoff = now - ROLLING_WINDOW_MS;
  while (queryTimeWindow.length > 0 && queryTimeWindow[0].time < cutoff) {
    queryTimeWindow.shift();
  }

  if (durationMs > 100) {
    databaseMetrics.slowQueries.inc();
    state.dbSlowQueryCount++;

    if (query) {
      state.slowQueries.push({
        query: query.substring(0, 200),
        latency: durationMs,
        timestamp: new Date().toISOString(),
      });

      if (state.slowQueries.length > 100) {
        state.slowQueries.shift();
      }
    }
  }

  state.dbQueriesPerMinute = queryTimeWindow.length;
  state.dbQueryTimes.push(durationMs);

  if (state.dbQueryTimes.length > 1000) {
    state.dbQueryTimes.shift();
  }
}

export function updateDatabaseConnections(count: number): void {
  state.dbConnectionCount = count;
  databaseMetrics.activeConnections.set(count);
}

export function getDatabaseMetrics(): {
  connections: number;
  queriesPerMinute: number;
  slowQueries: number;
  averageQueryTime: number;
} {
  const avgQueryTime = state.dbQueryTimes.length > 0
    ? state.dbQueryTimes.reduce((a, b) => a + b, 0) / state.dbQueryTimes.length
    : 0;

  return {
    connections: state.dbConnectionCount,
    queriesPerMinute: state.dbQueriesPerMinute,
    slowQueries: state.dbSlowQueryCount,
    averageQueryTime: avgQueryTime,
  };
}

export function getSlowQueries(): Array<{
  query: string;
  latency: number;
  timestamp: string;
}> {
  return [...state.slowQueries];
}

export function recordGraphQLOperation(
  operationType: 'query' | 'mutation' | 'subscription',
  complexity?: number,
  durationMs?: number,
  hasError: boolean = false
): void {
  const now = Date.now();

  graphqlMetrics.operationsTotal.inc({ operation_type: operationType });

  if (complexity !== undefined) {
    graphqlMetrics.complexity.observe(complexity);
    state.graphqlComplexities.push(complexity);
    if (state.graphqlComplexities.length > 1000) {
      state.graphqlComplexities.shift();
    }
  }

  if (durationMs !== undefined) {
    graphqlMetrics.resolverDuration.observe(
      { operation_type: operationType },
      durationMs / 1000
    );
    state.graphqlResolverTimes.push(durationMs);
    if (state.graphqlResolverTimes.length > 1000) {
      state.graphqlResolverTimes.shift();
    }
  }

  if (hasError) {
    graphqlMetrics.errors.inc({ error_type: 'execution' });
    state.graphqlErrorCount++;
  }

  graphqlOpsWindow.push({ time: now });
  state.graphqlTotalOps++;

  const cutoff = now - ROLLING_WINDOW_MS;
  while (graphqlOpsWindow.length > 0 && graphqlOpsWindow[0].time < cutoff) {
    graphqlOpsWindow.shift();
  }

  state.graphqlOpsPerMinute = graphqlOpsWindow.length;
}

export function getGraphQLMetrics(): {
  operationsPerMinute: number;
  averageComplexity: number;
  averageResolverLatency: number;
  errorRate: number;
} {
  const avgComplexity = state.graphqlComplexities.length > 0
    ? state.graphqlComplexities.reduce((a, b) => a + b, 0) / state.graphqlComplexities.length
    : 0;

  const avgLatency = state.graphqlResolverTimes.length > 0
    ? state.graphqlResolverTimes.reduce((a, b) => a + b, 0) / state.graphqlResolverTimes.length
    : 0;

  const errorRate = state.graphqlTotalOps > 0
    ? state.graphqlErrorCount / state.graphqlTotalOps
    : 0;

  return {
    operationsPerMinute: state.graphqlOpsPerMinute,
    averageComplexity: avgComplexity,
    averageResolverLatency: avgLatency,
    errorRate,
  };
}

const cacheState = {
  hitCount: 0,
  missCount: 0,
  totalOps: 0,
};

export function recordCacheOperation(hit: boolean): void {
  cacheState.totalOps++;
  if (hit) {
    cacheState.hitCount++;
  } else {
    cacheState.missCount++;
  }
}

export function getCacheHitRate(): number {
  if (cacheState.totalOps === 0) return 0;
  return cacheState.hitCount / cacheState.totalOps;
}

export function getDataLoaderEfficiency(): number {
  const hitRate = getCacheHitRate();
  return hitRate > 0 ? 0.7 + (hitRate * 0.25) : 0.8;
}

export async function collectSystemSnapshot(): Promise<{
  cpu: { usage: number; loadAverage: number[] };
  memory: { used: number; total: number; heapUsed: number; heapTotal: number; external: number };
  network: { bytesIn: number; bytesOut: number; connections: number };
  database: { connections: number; queriesPerMinute: number; slowQueries: number; averageQueryTime: number };
  graphql: { operationsPerMinute: number; averageComplexity: number; averageResolverLatency: number; errorRate: number };
  cache: { hitRate: number; dataLoaderEfficiency: number };
}> {
  const networkStats = await getNetworkStats();

  return {
    cpu: {
      usage: getCPUUsage(),
      loadAverage: getLoadAverage(),
    },
    memory: getMemoryMetrics(),
    network: networkStats,
    database: getDatabaseMetrics(),
    graphql: getGraphQLMetrics(),
    cache: {
      hitRate: getCacheHitRate(),
      dataLoaderEfficiency: getDataLoaderEfficiency(),
    },
  };
}

let collectionInterval: NodeJS.Timeout | null = null;

export function startMetricsCollection(intervalMs: number = DEFAULT_COLLECTION_INTERVAL_MS): void {
  if (collectionInterval) {
    logger.info('[MetricsCollector] Collection already started');
    return;
  }

  void collectAllSystemMetrics();
  collectionInterval = setInterval(() => {
    void collectAllSystemMetrics();
  }, intervalMs);

  logger.info(`[MetricsCollector] Started periodic collection every ${intervalMs}ms`);
}

export function stopMetricsCollection(): void {
  if (collectionInterval) {
    clearInterval(collectionInterval);
    collectionInterval = null;
    logger.info('[MetricsCollector] Stopped periodic collection');
  }
}

async function collectAllSystemMetrics(): Promise<void> {
  try {
    getCPUUsage();
    getLoadAverage();
    getMemoryMetrics();

    for (const collector of derivedCollectors) {
      await collector();
    }

    logger.debug('[MetricsCollector] System metrics collected');
  } catch (error) {
    logger.warn('[MetricsCollector] Error collecting system metrics:', error);
  }
}

export async function getPrometheusMetrics(): Promise<string> {
  return await performanceRegistry.metrics();
}

export function resetMetrics(): void {
  state.lastCpuUsage = null;
  state.lastCpuTime = 0;
  state.networkBytesIn = 0;
  state.networkBytesOut = 0;
  state.activeConnections = 0;
  state.dbConnectionCount = 0;
  state.dbQueriesPerMinute = 0;
  state.dbSlowQueryCount = 0;
  state.dbQueryTimes = [];
  state.graphqlOpsPerMinute = 0;
  state.graphqlComplexities = [];
  state.graphqlResolverTimes = [];
  state.graphqlErrorCount = 0;
  state.graphqlTotalOps = 0;
  state.slowQueries = [];
  cacheState.hitCount = 0;
  cacheState.missCount = 0;
  cacheState.totalOps = 0;
  queryTimeWindow.length = 0;
  graphqlOpsWindow.length = 0;

  performanceRegistry.resetMetrics();
}

export default {
  getCPUUsage,
  getLoadAverage,
  getMemoryMetrics,
  getNetworkStats,
  getDiskStats,
  recordDatabaseQuery,
  updateDatabaseConnections,
  getDatabaseMetrics,
  getSlowQueries,
  recordGraphQLOperation,
  getGraphQLMetrics,
  recordCacheOperation,
  getCacheHitRate,
  getDataLoaderEfficiency,
  collectSystemSnapshot,
  getPrometheusMetrics,
  resetMetrics,
  startMetricsCollection,
  stopMetricsCollection,
  registerDerivedMetricsCollector,
  performanceRegistry,
  systemMetrics,
  databaseMetrics,
  graphqlMetrics,
};
