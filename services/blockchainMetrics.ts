/**
 * Blockchain & Cross-Chain Transaction Metrics for Task 84.4
 *
 * Provides Prometheus metrics export for blockchain transactions including:
 * - Transaction confirmation times
 * - Gas usage tracking
 * - Bridge transfer latency
 * - Success/failure rates by chain and protocol
 * - Integration with CrossChainMetricsService
 */

import { Registry, Counter, Histogram, Gauge, Summary } from 'prom-client';
import { logger } from '../utils/logger.js';
import { getCrossChainMetricsService, MessageStatus } from './CrossChainMetricsService.js';

// Create a dedicated registry for blockchain metrics
export const blockchainMetricsRegistry = new Registry();

// ============================================================================
// Transaction Metrics
// ============================================================================

/**
 * Transaction Confirmation Time Histogram
 * Tracks how long it takes for transactions to be confirmed
 */
export const transactionConfirmationTime = new Histogram({
  name: 'wrfcoin_blockchain_transaction_confirmation_seconds',
  help: 'Blockchain transaction confirmation time in seconds',
  labelNames: ['chain', 'transaction_type', 'status'],
  buckets: [1, 5, 15, 30, 60, 120, 300, 600, 1800, 3600],
  registers: [blockchainMetricsRegistry],
});

/**
 * Transaction Confirmation Time Summary for Percentiles
 */
export const transactionConfirmationSummary = new Summary({
  name: 'wrfcoin_blockchain_transaction_confirmation_summary_seconds',
  help: 'Transaction confirmation time percentiles in seconds',
  labelNames: ['chain'],
  percentiles: [0.5, 0.9, 0.95, 0.99],
  maxAgeSeconds: 600,
  ageBuckets: 5,
  registers: [blockchainMetricsRegistry],
});

/**
 * Total Transactions Counter
 */
export const transactionsTotal = new Counter({
  name: 'wrfcoin_blockchain_transactions_total',
  help: 'Total number of blockchain transactions',
  labelNames: ['chain', 'transaction_type', 'status'],
  registers: [blockchainMetricsRegistry],
});

/**
 * Transaction Errors Counter
 */
export const transactionErrors = new Counter({
  name: 'wrfcoin_blockchain_transaction_errors_total',
  help: 'Total number of blockchain transaction errors',
  labelNames: ['chain', 'error_type'],
  registers: [blockchainMetricsRegistry],
});

// ============================================================================
// Gas Metrics
// ============================================================================

/**
 * Gas Usage Histogram
 * Tracks gas consumed by transactions
 */
export const gasUsageHistogram = new Histogram({
  name: 'wrfcoin_blockchain_gas_used',
  help: 'Gas used by blockchain transactions',
  labelNames: ['chain', 'transaction_type'],
  buckets: [21000, 50000, 100000, 200000, 500000, 1000000, 2000000, 5000000],
  registers: [blockchainMetricsRegistry],
});

/**
 * Gas Price Gauge
 * Current gas price on each chain
 */
export const gasPriceGauge = new Gauge({
  name: 'wrfcoin_blockchain_gas_price_gwei',
  help: 'Current gas price in gwei',
  labelNames: ['chain'],
  registers: [blockchainMetricsRegistry],
});

/**
 * Transaction Fee Histogram (in USD)
 */
export const transactionFeeHistogram = new Histogram({
  name: 'wrfcoin_blockchain_transaction_fee_usd',
  help: 'Transaction fees in USD',
  labelNames: ['chain', 'transaction_type'],
  buckets: [0.01, 0.1, 0.5, 1, 2, 5, 10, 25, 50, 100],
  registers: [blockchainMetricsRegistry],
});

// ============================================================================
// Cross-Chain Bridge Metrics
// ============================================================================

/**
 * Bridge Transfer Latency Histogram
 * Tracks time from initiation to completion of bridge transfers
 */
export const bridgeTransferLatency = new Histogram({
  name: 'wrfcoin_bridge_transfer_latency_seconds',
  help: 'Cross-chain bridge transfer latency in seconds',
  labelNames: ['source_chain', 'destination_chain', 'protocol'],
  buckets: [10, 30, 60, 120, 300, 600, 1800, 3600, 7200],
  registers: [blockchainMetricsRegistry],
});

/**
 * Bridge Transfer Latency Summary for Percentiles
 */
export const bridgeTransferLatencySummary = new Summary({
  name: 'wrfcoin_bridge_transfer_latency_summary_seconds',
  help: 'Bridge transfer latency percentiles in seconds',
  labelNames: ['protocol'],
  percentiles: [0.5, 0.9, 0.95, 0.99],
  maxAgeSeconds: 600,
  ageBuckets: 5,
  registers: [blockchainMetricsRegistry],
});

/**
 * Bridge Transfers Counter
 */
export const bridgeTransfersTotal = new Counter({
  name: 'wrfcoin_bridge_transfers_total',
  help: 'Total number of cross-chain bridge transfers',
  labelNames: ['source_chain', 'destination_chain', 'protocol', 'status'],
  registers: [blockchainMetricsRegistry],
});

/**
 * Bridge Queue Length Gauge
 */
export const bridgeQueueLength = new Gauge({
  name: 'wrfcoin_bridge_queue_length',
  help: 'Number of pending bridge transfers in queue',
  labelNames: ['protocol'],
  registers: [blockchainMetricsRegistry],
});

/**
 * Bridge Success Rate Gauge
 */
export const bridgeSuccessRate = new Gauge({
  name: 'wrfcoin_bridge_success_rate',
  help: 'Bridge transfer success rate (0-1)',
  labelNames: ['protocol'],
  registers: [blockchainMetricsRegistry],
});

/**
 * Bridge Daily Volume Gauge
 */
export const bridgeDailyVolume = new Gauge({
  name: 'wrfcoin_bridge_daily_volume',
  help: 'Number of bridge transfers in the last 24 hours',
  labelNames: ['protocol'],
  registers: [blockchainMetricsRegistry],
});

// ============================================================================
// Network Health Metrics
// ============================================================================

/**
 * Block Height Gauge
 */
export const blockHeightGauge = new Gauge({
  name: 'wrfcoin_blockchain_block_height',
  help: 'Current block height on each chain',
  labelNames: ['chain'],
  registers: [blockchainMetricsRegistry],
});

/**
 * Network Latency Gauge (RPC response time)
 */
export const networkLatencyGauge = new Gauge({
  name: 'wrfcoin_blockchain_network_latency_ms',
  help: 'RPC network latency in milliseconds',
  labelNames: ['chain', 'rpc_endpoint'],
  registers: [blockchainMetricsRegistry],
});

/**
 * Chain Sync Status Gauge (1 = synced, 0 = syncing)
 */
export const chainSyncStatus = new Gauge({
  name: 'wrfcoin_blockchain_sync_status',
  help: 'Chain sync status (1 = synced, 0 = syncing)',
  labelNames: ['chain'],
  registers: [blockchainMetricsRegistry],
});

// ============================================================================
// Recording Functions
// ============================================================================

/**
 * Record a blockchain transaction completion
 */
export function recordTransaction(params: {
  chain: string;
  transactionType: string;
  confirmationTimeMs: number;
  gasUsed?: number;
  feeUsd?: number;
  success: boolean;
  errorType?: string;
}): void {
  const {
    chain,
    transactionType,
    confirmationTimeMs,
    gasUsed,
    feeUsd,
    success,
    errorType,
  } = params;

  const status = success ? 'success' : 'failed';
  const confirmationTimeSec = confirmationTimeMs / 1000;

  // Record confirmation time
  transactionConfirmationTime.observe(
    { chain, transaction_type: transactionType, status },
    confirmationTimeSec
  );
  transactionConfirmationSummary.observe({ chain }, confirmationTimeSec);

  // Record transaction count
  transactionsTotal.inc({ chain, transaction_type: transactionType, status });

  // Record gas usage if provided
  if (gasUsed !== undefined) {
    gasUsageHistogram.observe({ chain, transaction_type: transactionType }, gasUsed);
  }

  // Record fee if provided
  if (feeUsd !== undefined) {
    transactionFeeHistogram.observe({ chain, transaction_type: transactionType }, feeUsd);
  }

  // Record error if failed
  if (!success && errorType) {
    transactionErrors.inc({ chain, error_type: errorType });
  }

  // Log transaction
  logger.debug('Blockchain transaction recorded', {
    chain,
    transactionType,
    confirmationTimeMs,
    gasUsed,
    feeUsd,
    success,
  });
}

/**
 * Record a bridge transfer completion
 */
export function recordBridgeTransfer(params: {
  sourceChain: string;
  destinationChain: string;
  protocol: string;
  latencyMs: number;
  success: boolean;
}): void {
  const { sourceChain, destinationChain, protocol, latencyMs, success } = params;
  const status = success ? 'success' : 'failed';
  const latencySec = latencyMs / 1000;

  // Record latency
  bridgeTransferLatency.observe(
    { source_chain: sourceChain, destination_chain: destinationChain, protocol },
    latencySec
  );
  bridgeTransferLatencySummary.observe({ protocol }, latencySec);

  // Record count
  bridgeTransfersTotal.inc({
    source_chain: sourceChain,
    destination_chain: destinationChain,
    protocol,
    status,
  });

  logger.debug('Bridge transfer recorded', {
    sourceChain,
    destinationChain,
    protocol,
    latencyMs,
    success,
  });
}

/**
 * Update gas price for a chain
 */
export function updateGasPrice(chain: string, gasPriceGwei: number): void {
  gasPriceGauge.set({ chain }, gasPriceGwei);
}

/**
 * Update block height for a chain
 */
export function updateBlockHeight(chain: string, height: number): void {
  blockHeightGauge.set({ chain }, height);
}

/**
 * Update network latency for an RPC endpoint
 */
export function updateNetworkLatency(chain: string, rpcEndpoint: string, latencyMs: number): void {
  networkLatencyGauge.set({ chain, rpc_endpoint: rpcEndpoint }, latencyMs);
}

/**
 * Update chain sync status
 */
export function updateChainSyncStatus(chain: string, isSynced: boolean): void {
  chainSyncStatus.set({ chain }, isSynced ? 1 : 0);
}

// ============================================================================
// CrossChainMetricsService Integration
// ============================================================================

/**
 * Sync metrics from CrossChainMetricsService to Prometheus
 * Call this periodically to update bridge metrics
 */
export async function syncCrossChainMetrics(): Promise<void> {
  try {
    const service = getCrossChainMetricsService();

    // Define the supported protocols
    const protocols = [
      'LayerZero', 'Axelar', 'Wormhole', 'CCIP', 'IBC',
      'PolkadotXCM', 'Polygon', 'Avalanche', 'Optimism', 'Arbitrum',
    ];

    await Promise.all(
      protocols.map(async (protocol) => {
        const metrics = await service.getProtocolMetrics(protocol);
        bridgeQueueLength.set({ protocol }, metrics.queueLength);
        bridgeSuccessRate.set({ protocol }, metrics.successRate / 100);
        bridgeDailyVolume.set({ protocol }, metrics.dailyVolume);
      })
    );

    logger.debug('Cross-chain metrics synced to Prometheus');
  } catch (error) {
    logger.warn('Failed to sync cross-chain metrics:', error);
  }
}

// Start periodic sync (every 30 seconds)
let syncInterval: NodeJS.Timeout | null = null;

export function startMetricsSync(): void {
  if (!syncInterval) {
    syncInterval = setInterval(syncCrossChainMetrics, 30000);
    // Also sync immediately
    syncCrossChainMetrics();
    logger.info('Cross-chain metrics sync started');
  }
}

export function stopMetricsSync(): void {
  if (syncInterval) {
    clearInterval(syncInterval);
    syncInterval = null;
  }
}

// ============================================================================
// Metrics Export
// ============================================================================

/**
 * Get all blockchain metrics in Prometheus format
 */
export async function getBlockchainMetrics(): Promise<string> {
  return await blockchainMetricsRegistry.metrics();
}

/**
 * Get blockchain metrics summary for monitoring
 */
export async function getBlockchainMetricsSummary(): Promise<{
  totalTransactions: number;
  transactionSuccessRate: number;
  avgConfirmationTimeMs: number;
  bridgeTransfers: number;
  bridgeSuccessRate: number;
  avgBridgeLatencyMs: number;
}> {
  const metricsJson = await blockchainMetricsRegistry.getMetricsAsJSON();

  let totalTx = 0;
  let successfulTx = 0;
  let totalBridges = 0;
  let successfulBridges = 0;

  for (const metric of metricsJson) {
    if (metric.name === 'wrfcoin_blockchain_transactions_total') {
      for (const value of metric.values) {
        totalTx += value.value;
        if (value.labels?.status === 'success') {
          successfulTx += value.value;
        }
      }
    }
    if (metric.name === 'wrfcoin_bridge_transfers_total') {
      for (const value of metric.values) {
        totalBridges += value.value;
        if (value.labels?.status === 'success') {
          successfulBridges += value.value;
        }
      }
    }
  }

  return {
    totalTransactions: totalTx,
    transactionSuccessRate: totalTx > 0 ? successfulTx / totalTx : 1,
    avgConfirmationTimeMs: 0, // Would need histogram calculation
    bridgeTransfers: totalBridges,
    bridgeSuccessRate: totalBridges > 0 ? successfulBridges / totalBridges : 1,
    avgBridgeLatencyMs: 0, // Would come from summary
  };
}

export default {
  // Recording functions
  recordTransaction,
  recordBridgeTransfer,
  updateGasPrice,
  updateBlockHeight,
  updateNetworkLatency,
  updateChainSyncStatus,
  syncCrossChainMetrics,
  startMetricsSync,
  stopMetricsSync,

  // Export functions
  getBlockchainMetrics,
  getBlockchainMetricsSummary,

  // Registry and metrics
  blockchainMetricsRegistry,
  transactionConfirmationTime,
  transactionsTotal,
  bridgeTransferLatency,
  bridgeTransfersTotal,
};
