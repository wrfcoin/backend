/**
 * Bridge Finality Monitor
 *
 * Monitors transaction finality across different blockchain networks before
 * executing bridge operations. Prevents double-spending through:
 * - Network-specific confirmation requirements
 * - Reorg detection and handling
 * - Delayed execution until finality
 * - Real-time block monitoring
 *
 * Network Finality Requirements:
 * - Ethereum: 12+ confirmations (2.4 min)
 * - Polygon: 128+ confirmations (4.3 min)
 * - BSC: 15+ confirmations (45 sec)
 * - Bitcoin: 6+ confirmations (60 min)
 * - Cosmos/Polkadot: Immediate (1 block)
 */

import { EventEmitter } from 'events';
import { cacheManager } from '../server/cache/cache-manager.js';
import { reorgsDetectedTotal } from '../server/utils/metrics.js';

export interface BridgeReorgCacheInvalidationContext {
  reorgId: string;
  chain: SupportedChain;
  blockNumber: number;
  affectedTransactions: string[];
  transactions: Transaction[];
  cacheKeys: string[];
  cachePatterns: string[];
}

type BridgeReorgCacheInvalidator = (
  context: BridgeReorgCacheInvalidationContext
) => Promise<void>;

const defaultBridgeReorgCacheInvalidator: BridgeReorgCacheInvalidator = async (
  context
) => {
  const { cacheManager } = await import('../server/cache/cache-manager.js');

  for (const transaction of context.transactions) {
    await cacheManager.delete(`tx:${transaction.hash}`, 'cross_chain');
    await cacheManager.delete(`bridge:tx:${transaction.hash}`, 'cross_chain');
    await cacheManager.delete(
      `bridge:status:${transaction.hash}`,
      'cross_chain'
    );

    await cacheManager.invalidate('bridge_reorg', {
      key: transaction.hash,
    });
  }

  for (const pattern of context.cachePatterns) {
    await cacheManager.deletePattern(pattern, 'cross_chain');
  }

  for (const key of context.cacheKeys) {
    await cacheManager.delete(key, 'cross_chain');
  }

  for (const transaction of context.transactions) {
    await cacheManager.set(
      `tx:${transaction.hash}`,
      transaction,
      {
        cacheType: 'cross_chain',
        policyName: 'crossChainTx',
      }
    );
    await cacheManager.set(
      `bridge:tx:${transaction.hash}`,
      transaction,
      {
        cacheType: 'cross_chain',
        policyName: 'crossChainTx',
      }
    );
  }
};

let bridgeReorgCacheInvalidator: BridgeReorgCacheInvalidator =
  defaultBridgeReorgCacheInvalidator;

export const FINALITY_CONFIRMATIONS = {
  ethereum: 12,
  polygon: 128,
  bsc: 15,
  avalanche: 10,
  optimism: 20,
  arbitrum: 20,
  base: 20,
  cosmos: 1,
  osmosis: 1,
  polkadot: 1,
  kusama: 1,
  near: 2,
  solana: 32,
  bitcoin: 6,
} as const;

export type SupportedChain = keyof typeof FINALITY_CONFIRMATIONS;

export const AVERAGE_BLOCK_TIME = {
  ethereum: 12,      // seconds
  polygon: 2,
  bsc: 3,
  avalanche: 2,
  optimism: 2,
  arbitrum: 0.25,
  base: 2,
  cosmos: 6,
  osmosis: 6,
  polkadot: 6,
  kusama: 6,
  near: 1,
  solana: 0.4,
  bitcoin: 600,
} as const;

export interface Transaction {
  hash: string;
  chain: SupportedChain;
  blockNumber: number;
  blockHash: string;
  confirmations: number;
  timestamp: Date;
  finalized: boolean;
  reorgDetected: boolean;
  requiredConfirmations: number;
}

export interface ReorgEvent {
  id: string;
  chain: SupportedChain;
  oldBlockHash: string;
  newBlockHash: string;
  blockNumber: number;
  affectedTransactions: string[];
  detectedAt: Date;
  resolved: boolean;
}

export interface FinalityStatus {
  transactionHash: string;
  chain: SupportedChain;
  currentConfirmations: number;
  requiredConfirmations: number;
  finalized: boolean;
  estimatedFinalityTime?: Date;
  reorgRisk: 'low' | 'medium' | 'high';
}

export class BridgeFinalityMonitor extends EventEmitter {
  private transactions: Map<string, Transaction> = new Map();
  private reorgEvents: Map<string, ReorgEvent> = new Map();
  private blockHeaders: Map<string, Map<number, string>> = new Map();
  private monitoring: Map<string, NodeJS.Timeout> = new Map();

  private readonly REORG_CHECK_INTERVAL = 5000; // 5 seconds
  private readonly MAX_REORG_DEPTH = 100; // Maximum blocks to check for reorg

  constructor() {
    super();
    this.setupCacheHooks();
  }

  /**
   * Start monitoring transaction for finality
   */
  public async monitorTransaction(
    transactionHash: string,
    chain: SupportedChain,
    blockNumber: number,
    blockHash: string,
    customConfirmations?: number
  ): Promise<Transaction> {
    if (this.transactions.has(transactionHash)) {
      return this.transactions.get(transactionHash)!;
    }

    const requiredConfirmations =
      customConfirmations || FINALITY_CONFIRMATIONS[chain];

    const transaction: Transaction = {
      hash: transactionHash,
      chain,
      blockNumber,
      blockHash,
      confirmations: 0,
      timestamp: new Date(),
      finalized: false,
      reorgDetected: false,
      requiredConfirmations,
    };

    this.transactions.set(transactionHash, transaction);

    // Store block header
    if (!this.blockHeaders.has(chain)) {
      this.blockHeaders.set(chain, new Map());
    }
    this.blockHeaders.get(chain)!.set(blockNumber, blockHash);

    this.emit('transaction:monitoring_started', {
      transactionHash,
      chain,
      blockNumber,
      requiredConfirmations,
    });

    // Start monitoring
    this.startMonitoring(transactionHash);

    return transaction;
  }

  /**
   * Start monitoring loop for transaction
   */
  private startMonitoring(transactionHash: string): void {
    if (this.monitoring.has(transactionHash)) {
      return; // Already monitoring
    }

    const interval = setInterval(async () => {
      const tx = this.transactions.get(transactionHash);

      if (!tx) {
        this.stopMonitoring(transactionHash);
        return;
      }

      // Update confirmations
      await this.updateConfirmations(tx);

      // Check for reorgs
      await this.checkForReorg(tx);

      // Check if finalized
      if (tx.confirmations >= tx.requiredConfirmations && !tx.reorgDetected) {
        tx.finalized = true;

        this.emit('transaction:finalized', {
          transactionHash: tx.hash,
          chain: tx.chain,
          confirmations: tx.confirmations,
          blockNumber: tx.blockNumber,
        });

        this.stopMonitoring(transactionHash);
      }
    }, this.REORG_CHECK_INTERVAL);

    this.monitoring.set(transactionHash, interval);
  }

  /**
   * Stop monitoring transaction
   */
  private stopMonitoring(transactionHash: string): void {
    const interval = this.monitoring.get(transactionHash);
    if (interval) {
      clearInterval(interval);
      this.monitoring.delete(transactionHash);
    }
  }

  /**
   * Update transaction confirmations
   */
  private async updateConfirmations(tx: Transaction): Promise<void> {
    // In production, query the blockchain node for latest block
    // For now, simulate by incrementing confirmations
    const currentBlock = await this.getCurrentBlockNumber(tx.chain);

    if (currentBlock >= tx.blockNumber) {
      const newConfirmations = currentBlock - tx.blockNumber + 1;

      if (newConfirmations !== tx.confirmations) {
        tx.confirmations = newConfirmations;

        this.emit('transaction:confirmations_updated', {
          transactionHash: tx.hash,
          chain: tx.chain,
          confirmations: tx.confirmations,
          requiredConfirmations: tx.requiredConfirmations,
          progress: (tx.confirmations / tx.requiredConfirmations) * 100,
        });
      }
    }
  }

  /**
   * Check for blockchain reorganization
   */
  private async checkForReorg(tx: Transaction): Promise<boolean> {
    // Get current block hash at transaction's block number
    const currentBlockHash = await this.getBlockHash(tx.chain, tx.blockNumber);

    if (!currentBlockHash) {
      return false; // Can't verify yet
    }

    // Compare with original block hash
    if (currentBlockHash !== tx.blockHash) {
      // Reorg detected!
      tx.reorgDetected = true;

      const reorgId = this.generateReorgId(tx.chain, tx.blockNumber);

      const reorg: ReorgEvent = {
        id: reorgId,
        chain: tx.chain,
        oldBlockHash: tx.blockHash,
        newBlockHash: currentBlockHash,
        blockNumber: tx.blockNumber,
        affectedTransactions: [tx.hash],
        detectedAt: new Date(),
        resolved: false,
      };

      this.reorgEvents.set(reorgId, reorg);
      reorgsDetectedTotal.inc({
        chain: tx.chain,
        bridge: 'cross-chain',
      });

      this.emit('reorg:detected', {
        reorgId,
        chain: tx.chain,
        blockNumber: tx.blockNumber,
        oldBlockHash: tx.blockHash,
        newBlockHash: currentBlockHash,
        affectedTransactions: 1,
        affectedTransactionHashes: [tx.hash],
      });

      // Handle reorg
      await this.handleReorg(reorg);

      return true;
    }

    return false;
  }

  /**
   * Handle blockchain reorganization
   */
  private async handleReorg(reorg: ReorgEvent): Promise<void> {
    // Find all affected transactions
    const affected = Array.from(this.transactions.values()).filter(
      tx =>
        tx.chain === reorg.chain &&
        tx.blockNumber >= reorg.blockNumber &&
        tx.blockNumber < reorg.blockNumber + this.MAX_REORG_DEPTH
    );

    reorg.affectedTransactions = affected.map(tx => tx.hash);

    this.emit('reorg:handling', {
      reorgId: reorg.id,
      affectedTransactions: reorg.affectedTransactions.length,
    });

    // Reset affected transactions
    for (const tx of affected) {
      tx.confirmations = 0;
      tx.finalized = false;
      tx.reorgDetected = true;

      this.emit('transaction:reset_due_to_reorg', {
        transactionHash: tx.hash,
        chain: tx.chain,
        reorgId: reorg.id,
      });

      // Need to re-verify transaction is still in the chain
      // In production, query the blockchain to see if tx is still valid
      // For now, assume it needs to be resubmitted
    }

    const cacheInvalidationContext = this.buildReorgCacheInvalidationContext(
      reorg,
      affected
    );

    try {
      await bridgeReorgCacheInvalidator(cacheInvalidationContext);
    } catch (error) {
      this.emit('reorg:cache_invalidation_failed', {
        reorgId: reorg.id,
        affectedTransactions: reorg.affectedTransactions.length,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    reorg.resolved = true;

    this.emit('reorg:resolved', {
      reorgId: reorg.id,
      affectedTransactions: reorg.affectedTransactions.length,
      affectedTransactionHashes: [...reorg.affectedTransactions],
    });
  }

  /**
   * Get current block number for chain (simulated)
   */
  private async getCurrentBlockNumber(chain: SupportedChain): Promise<number> {
    // In production, query actual blockchain node
    // For now, simulate block progression
    const tx = Array.from(this.transactions.values()).find(t => t.chain === chain);

    if (!tx) return 0;

    const elapsed = Date.now() - tx.timestamp.getTime();
    const blockTime = AVERAGE_BLOCK_TIME[chain] * 1000;
    const blocksPassed = Math.floor(elapsed / blockTime);

    return tx.blockNumber + blocksPassed;
  }

  /**
   * Get block hash at specific number (simulated)
   */
  private async getBlockHash(
    chain: SupportedChain,
    blockNumber: number
  ): Promise<string | undefined> {
    // In production, query blockchain node
    // For now, return stored block hash
    return this.blockHeaders.get(chain)?.get(blockNumber);
  }

  /**
   * Get finality status for transaction
   */
  public getFinalityStatus(transactionHash: string): FinalityStatus | null {
    const tx = this.transactions.get(transactionHash);

    if (!tx) {
      return null;
    }

    const progress = tx.confirmations / tx.requiredConfirmations;

    let reorgRisk: 'low' | 'medium' | 'high' = 'low';
    if (tx.confirmations < tx.requiredConfirmations * 0.3) {
      reorgRisk = 'high';
    } else if (tx.confirmations < tx.requiredConfirmations * 0.7) {
      reorgRisk = 'medium';
    }

    let estimatedFinalityTime: Date | undefined;
    if (!tx.finalized) {
      const remainingConfirmations =
        tx.requiredConfirmations - tx.confirmations;
      const blockTime = AVERAGE_BLOCK_TIME[tx.chain];
      const remainingSeconds = remainingConfirmations * blockTime;

      estimatedFinalityTime = new Date(
        Date.now() + remainingSeconds * 1000
      );
    }

    return {
      transactionHash: tx.hash,
      chain: tx.chain,
      currentConfirmations: tx.confirmations,
      requiredConfirmations: tx.requiredConfirmations,
      finalized: tx.finalized,
      estimatedFinalityTime,
      reorgRisk,
    };
  }

  /**
   * Check if transaction is finalized
   */
  public isFinalized(transactionHash: string): boolean {
    const tx = this.transactions.get(transactionHash);
    return tx?.finalized || false;
  }

  /**
   * Wait for transaction finality
   */
  public async waitForFinality(
    transactionHash: string,
    timeoutMs: number = 600000 // 10 minutes default
  ): Promise<boolean> {
    const tx = this.transactions.get(transactionHash);

    if (!tx) {
      throw new Error(`Transaction not being monitored: ${transactionHash}`);
    }

    if (tx.finalized) {
      return true;
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.off('transaction:finalized', handler);
        reject(new Error('Finality timeout'));
      }, timeoutMs);

      const handler = (event: any) => {
        if (event.transactionHash === transactionHash) {
          clearTimeout(timeout);
          this.off('transaction:finalized', handler);
          resolve(true);
        }
      };

      this.on('transaction:finalized', handler);
    });
  }

  /**
   * Get transaction by hash
   */
  public getTransaction(transactionHash: string): Transaction | undefined {
    return this.transactions.get(transactionHash);
  }

  /**
   * Get all monitored transactions
   */
  public getAllTransactions(): Transaction[] {
    return Array.from(this.transactions.values());
  }

  /**
   * Get finalized transactions
   */
  public getFinalizedTransactions(chain?: SupportedChain): Transaction[] {
    let txs = Array.from(this.transactions.values()).filter(tx => tx.finalized);

    if (chain) {
      txs = txs.filter(tx => tx.chain === chain);
    }

    return txs;
  }

  /**
   * Get pending transactions
   */
  public getPendingTransactions(chain?: SupportedChain): Transaction[] {
    let txs = Array.from(this.transactions.values()).filter(tx => !tx.finalized);

    if (chain) {
      txs = txs.filter(tx => tx.chain === chain);
    }

    return txs;
  }

  /**
   * Get reorg events
   */
  public getReorgEvents(chain?: SupportedChain): ReorgEvent[] {
    let events = Array.from(this.reorgEvents.values());

    if (chain) {
      events = events.filter(e => e.chain === chain);
    }

    return events;
  }

  /**
   * Get unresolved reorgs
   */
  public getUnresolvedReorgs(): ReorgEvent[] {
    return Array.from(this.reorgEvents.values()).filter(e => !e.resolved);
  }

  /**
   * Generate reorg ID
   */
  private generateReorgId(chain: SupportedChain, blockNumber: number): string {
    return `reorg-${chain}-${blockNumber}-${Date.now()}`;
  }

  /**
   * Hook cache invalidation to reorg lifecycle events.
   */
  private setupCacheHooks(): void {
    this.on('reorg:detected', async (event: {
      reorgId: string;
      chain: SupportedChain;
      blockNumber: number;
      affectedTransactionHashes?: string[];
    }) => {
      const hashes = event.affectedTransactionHashes || [];

      for (const hash of hashes) {
        await this.invalidateTransactionCache(hash);
      }

      await cacheManager.invalidate('bridge_reorg', {
        key: hashes[0] || `${event.chain}:${event.blockNumber}`,
      });
    });

    this.on('reorg:resolved', async (event: {
      reorgId: string;
      affectedTransactionHashes?: string[];
    }) => {
      for (const hash of event.affectedTransactionHashes || []) {
        const tx = this.transactions.get(hash);
        if (!tx) {
          continue;
        }

        await cacheManager.set(
          `tx:${hash}`,
          tx,
          { cacheType: 'cross_chain', policyName: 'crossChainTx' }
        );
        await cacheManager.set(
          `bridge:tx:${hash}`,
          tx,
          { cacheType: 'cross_chain', policyName: 'crossChainTx' }
        );
      }
    });
  }

  /**
   * Remove stale transaction-related cache entries for a reorged tx.
   */
  private async invalidateTransactionCache(transactionHash: string): Promise<void> {
    await cacheManager.delete(`tx:${transactionHash}`, 'cross_chain');
    await cacheManager.delete(`bridge:tx:${transactionHash}`, 'cross_chain');
    await cacheManager.delete(`transaction:${transactionHash}`, 'cross_chain');
    await cacheManager.delete(`bridge:status:${transactionHash}`, 'cross_chain');
  }

  private buildReorgCacheInvalidationContext(
    reorg: ReorgEvent,
    affected: Transaction[]
  ): BridgeReorgCacheInvalidationContext {
    const cacheKeys = new Set<string>();
    const cachePatterns = new Set<string>([
      `block:${reorg.chain}:*`,
      'api:/bridge/*',
      'api:/bridges/*',
    ]);

    for (const tx of affected) {
      cacheKeys.add(`bridge:tx:${tx.hash}`);
      cacheKeys.add(`bridge:status:${tx.hash}`);
      cacheKeys.add(`bridge:finality:${tx.hash}`);
      cacheKeys.add(`block:${tx.chain}:${tx.blockNumber}`);
      cacheKeys.add(`block:${tx.blockHash}`);
    }

    return {
      reorgId: reorg.id,
      chain: reorg.chain,
      blockNumber: reorg.blockNumber,
      affectedTransactions: reorg.affectedTransactions,
      transactions: affected,
      cacheKeys: Array.from(cacheKeys),
      cachePatterns: Array.from(cachePatterns),
    };
  }

  /**
   * Calculate estimated finality time
   */
  public estimateFinalityTime(
    chain: SupportedChain,
    customConfirmations?: number
  ): number {
    const confirmations =
      customConfirmations || FINALITY_CONFIRMATIONS[chain];
    const blockTime = AVERAGE_BLOCK_TIME[chain];

    return confirmations * blockTime; // seconds
  }

  /**
   * Get statistics
   */
  public getStatistics() {
    const txs = Array.from(this.transactions.values());

    const stats = {
      transactions: {
        total: txs.length,
        finalized: txs.filter(tx => tx.finalized).length,
        pending: txs.filter(tx => !tx.finalized).length,
        withReorg: txs.filter(tx => tx.reorgDetected).length,
        byChain: {} as Record<string, number>,
      },
      reorgs: {
        total: this.reorgEvents.size,
        resolved: Array.from(this.reorgEvents.values()).filter(r => r.resolved)
          .length,
        pending: this.getUnresolvedReorgs().length,
      },
      monitoring: {
        active: this.monitoring.size,
      },
    };

    for (const tx of txs) {
      stats.transactions.byChain[tx.chain] =
        (stats.transactions.byChain[tx.chain] || 0) + 1;
    }

    return stats;
  }

  /**
   * Clean up old finalized transactions
   */
  public cleanup(olderThanHours: number = 24): number {
    const cutoffTime = Date.now() - olderThanHours * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [hash, tx] of this.transactions.entries()) {
      if (tx.finalized && tx.timestamp.getTime() < cutoffTime) {
        this.transactions.delete(hash);
        this.stopMonitoring(hash);
        cleaned++;
      }
    }

    this.emit('cleanup:completed', {
      cleaned,
      remaining: this.transactions.size,
    });

    return cleaned;
  }

  /**
   * Emergency pause all monitoring
   */
  public emergencyPause(): void {
    for (const hash of this.monitoring.keys()) {
      this.stopMonitoring(hash);
    }

    this.emit('monitoring:paused', {
      pausedCount: this.monitoring.size,
    });
  }

  /**
   * Resume monitoring
   */
  public resumeMonitoring(): void {
    for (const [hash, tx] of this.transactions.entries()) {
      if (!tx.finalized && !this.monitoring.has(hash)) {
        this.startMonitoring(hash);
      }
    }

    this.emit('monitoring:resumed', {
      resumedCount: this.monitoring.size,
    });
  }
}

// Singleton instance
export const finalityMonitor = new BridgeFinalityMonitor();

export function setBridgeReorgCacheInvalidator(
  invalidator: BridgeReorgCacheInvalidator
): void {
  bridgeReorgCacheInvalidator = invalidator;
}

export function resetBridgeReorgCacheInvalidator(): void {
  bridgeReorgCacheInvalidator = defaultBridgeReorgCacheInvalidator;
}
