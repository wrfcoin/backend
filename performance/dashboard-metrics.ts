/**
 * Dashboard-Compatible Metrics for Task 84
 *
 * Preserves only a small compatibility subset of dashboard metric names.
 * Collection cadence is owned by real-metrics-collector.
 */

import * as os from 'os';
import { Counter, Histogram, Registry } from 'prom-client';
import { logger } from '../utils/logger.js';
import {
  DEFAULT_COLLECTION_INTERVAL_MS,
  performanceRegistry,
  registerDerivedMetricsCollector,
  startMetricsCollection,
  systemMetrics,
} from './real-metrics-collector.js';

export const dashboardRegistry: Registry = performanceRegistry;

const KNOWN_CHAINS = new Set([
  'bitcoin',
  'ethereum',
  'polygon',
  'bsc',
  'avalanche',
  'arbitrum',
  'optimism',
  'base',
  'solana',
]);

const KNOWN_TX_TYPES = new Set([
  'transfer',
  'mint',
  'burn',
  'swap',
  'stake',
  'other',
]);

const KNOWN_SERVICES = new Set([
  'api',
  'graphql',
  'blockchain',
  'database',
  'cache',
  'network',
  'hsm',
  'internal',
]);

const KNOWN_OPERATIONS = new Set([
  'http_request',
  'graphql_query',
  'blockchain_tx',
  'network_message',
  'hsm_operation',
  'other',
]);

function normalizeToken(value: string | undefined): string {
  return (value || '').trim().toLowerCase().replace(/[^a-z0-9_/-]/g, '_');
}

function normalizeChain(chain: string): string {
  const normalized = normalizeToken(chain);
  return KNOWN_CHAINS.has(normalized) ? normalized : 'other';
}

function normalizeTxType(type: string): string {
  const normalized = normalizeToken(type);
  return KNOWN_TX_TYPES.has(normalized) ? normalized : 'other';
}

function normalizeService(serviceName: string): string {
  const normalized = normalizeToken(serviceName);
  return KNOWN_SERVICES.has(normalized) ? normalized : 'other';
}

function normalizeOperation(operationName: string): string {
  const normalized = normalizeToken(operationName);
  if (KNOWN_OPERATIONS.has(normalized)) {
    return normalized;
  }
  if (normalized.includes('graphql')) return 'graphql_query';
  if (normalized.includes('blockchain') || normalized.includes('tx')) return 'blockchain_tx';
  if (normalized.includes('network')) return 'network_message';
  if (normalized.includes('hsm')) return 'hsm_operation';
  if (normalized.includes('http') || normalized.includes('request')) return 'http_request';
  return 'other';
}

export const systemDashboardMetrics = {
  memoryUsagePercent: systemMetrics.memoryUsagePercent,
  healthScore: systemMetrics.healthScore,
  startTime: systemMetrics.startTime,
};

export const blockchainDashboardMetrics = {
  transactionsProcessed: new Counter({
    name: 'wrfcoin_blockchain_transactions_processed_total',
    help: 'Total blockchain transactions processed',
    labelNames: ['chain', 'type'],
    registers: [dashboardRegistry],
  }),

  transactionsFailed: new Counter({
    name: 'wrfcoin_blockchain_transactions_failed_total',
    help: 'Total failed blockchain transactions',
    labelNames: ['chain', 'type'],
    registers: [dashboardRegistry],
  }),
};

export const tracingDashboardMetrics = {
  spanDuration: new Histogram({
    name: 'wrfcoin_tracing_span_duration_seconds',
    help: 'Tracing span duration in seconds',
    labelNames: ['operation_name', 'service_name'],
    buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [dashboardRegistry],
  }),
};

export const crossChainDashboardMetrics = {} as const;
export const consensusDashboardMetrics = {} as const;
export const networkDashboardMetrics = {} as const;
export const weatherDashboardMetrics = {} as const;
export const securityDashboardMetrics = {} as const;

export async function collectDashboardMetrics(): Promise<void> {
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const memoryPercent = totalMem > 0 ? ((totalMem - freeMem) / totalMem) * 100 : 0;
    const cpuLoad = os.loadavg()[0];
    const cpuCount = Math.max(os.cpus().length, 1);
    const cpuLoadNormalized = Math.min(cpuLoad / cpuCount, 1);
    const memoryNormalized = Math.min(memoryPercent / 100, 1);
    const healthScore = Math.max(0, 1 - ((cpuLoadNormalized * 0.6) + (memoryNormalized * 0.4)));

    systemDashboardMetrics.memoryUsagePercent.set(memoryPercent);
    systemDashboardMetrics.healthScore.set(healthScore);
    systemDashboardMetrics.startTime.set(Math.floor(Date.now() / 1000 - process.uptime()));

    logger.debug('[DashboardMetrics] Compatibility metrics collected');
  } catch (error) {
    logger.warn('[DashboardMetrics] Error collecting dashboard metrics:', error);
  }
}

registerDerivedMetricsCollector(collectDashboardMetrics);
let dashboardCollectionStarted = false;

export function startDashboardMetricsCollection(
  intervalMs: number = DEFAULT_COLLECTION_INTERVAL_MS
): void {
  if (dashboardCollectionStarted) {
    return;
  }

  dashboardCollectionStarted = true;
  void collectDashboardMetrics();
  startMetricsCollection(intervalMs);
  logger.info(`[DashboardMetrics] Registered compatibility metrics on shared ${intervalMs}ms collector`);
}

export function stopDashboardMetricsCollection(): void {
  dashboardCollectionStarted = false;
}

export async function getDashboardPrometheusMetrics(): Promise<string> {
  return await dashboardRegistry.metrics();
}

export function recordBlockchainTransaction(
  chain: string,
  type: string,
  success: boolean,
  confirmationTimeSeconds?: number
): void {
  const chainLabel = normalizeChain(chain);
  const typeLabel = normalizeTxType(type);
  blockchainDashboardMetrics.transactionsProcessed.inc({ chain: chainLabel, type: typeLabel });

  if (!success) {
    blockchainDashboardMetrics.transactionsFailed.inc({ chain: chainLabel, type: typeLabel });
  }

  if (confirmationTimeSeconds !== undefined) {
    tracingDashboardMetrics.spanDuration.observe(
      { operation_name: 'blockchain_tx', service_name: 'blockchain' },
      confirmationTimeSeconds
    );
  }
}

export function recordBridgeTransfer(
  _sourceChain: string,
  _targetChain: string,
  _success: boolean,
  durationSeconds: number,
  _value?: number
): void {
  tracingDashboardMetrics.spanDuration.observe(
    { operation_name: 'blockchain_tx', service_name: 'blockchain' },
    durationSeconds
  );
}

export function recordApiRequest(
  operationName: string,
  serviceName: string,
  durationSeconds: number,
  _hasError: boolean = false
): void {
  tracingDashboardMetrics.spanDuration.observe(
    {
      operation_name: normalizeOperation(operationName),
      service_name: normalizeService(serviceName),
    },
    durationSeconds
  );
}

export function recordNetworkLatency(latencySeconds: number): void {
  tracingDashboardMetrics.spanDuration.observe(
    { operation_name: 'network_message', service_name: 'network' },
    latencySeconds
  );
}

export function recordWeatherQuality(stationId: string, qualityScore: number): void {
  void stationId;
  void qualityScore;
}

export function recordSecurityEvent(
  eventType: string,
  severity: 'low' | 'medium' | 'high' | 'critical'
): void {
  void eventType;
  void severity;
}

export function recordHsmOperation(
  operation: string,
  durationSeconds: number,
  success: boolean
): void {
  tracingDashboardMetrics.spanDuration.observe(
    { operation_name: normalizeOperation(operation), service_name: 'hsm' },
    durationSeconds
  );
  void success;
}

export default {
  systemDashboardMetrics,
  blockchainDashboardMetrics,
  crossChainDashboardMetrics,
  consensusDashboardMetrics,
  networkDashboardMetrics,
  tracingDashboardMetrics,
  weatherDashboardMetrics,
  securityDashboardMetrics,
  collectDashboardMetrics,
  recordBlockchainTransaction,
  recordBridgeTransfer,
  recordApiRequest,
  recordNetworkLatency,
  recordWeatherQuality,
  recordSecurityEvent,
  recordHsmOperation,
  startDashboardMetricsCollection,
  stopDashboardMetricsCollection,
  getDashboardPrometheusMetrics,
  dashboardRegistry,
};
