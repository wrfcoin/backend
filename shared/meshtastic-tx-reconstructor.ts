/**
 * Meshtastic Transaction Chunk Reconstructor
 *
 * Handles accumulation and reconstruction of chunked transactions
 * received over LoRa mesh network (Task 109.2).
 */

import { eq, and, lt } from 'drizzle-orm';
import { db } from '../database/db.js';
import { meshtasticTxChunks, type MeshtasticTxChunk } from './schema-meshtastic.js';
import type { TxBody } from './meshtastic-payload-types.js';
import { blockchainLogger } from '../server/utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Accumulated chunk data for a pending transaction.
 */
export interface ChunkAccumulator {
  txId: string;
  from: string;
  to: string;
  amount: string;
  nonce: number;
  signature: string;
  totalChunks: number;
  receivedChunks: Map<number, string>; // index -> base64 data
  meshtasticNodeId: string;
  gatewayId: string;
  firstReceivedAt: Date;
  lastReceivedAt: Date;
}

/**
 * A fully reconstructed transaction ready for validation.
 */
export interface ReconstructedTransaction {
  txId: string;
  from: string;
  to: string;
  amount: string;
  nonce: number;
  signature: string;
  rawData: Buffer;
  meshtasticNodeId: string;
  gatewayId: string;
  reconstructedAt: Date;
}

/**
 * Result of storing a chunk.
 */
export interface ChunkStorageResult {
  success: boolean;
  txId: string;
  chunksReceived: number;
  chunksTotal: number;
  isComplete: boolean;
  error?: string;
  isNewChunk: boolean;
}

/**
 * Result of reconstruction attempt.
 */
export interface ReconstructionResult {
  success: boolean;
  transaction?: ReconstructedTransaction;
  error?: string;
}

// ============================================================================
// Configuration
// ============================================================================

/**
 * Default timeout for incomplete transactions (5 minutes).
 */
const DEFAULT_CHUNK_TIMEOUT_MS = parseInt(
  process.env.MESHTASTIC_TX_CHUNK_TIMEOUT_MS || '300000',
  10
);

/**
 * Maximum number of pending transactions to track in memory.
 */
const MAX_PENDING_TRANSACTIONS = parseInt(
  process.env.MESHTASTIC_MAX_PENDING_TX || '1000',
  10
);

// ============================================================================
// Chunk Reconstructor Service
// ============================================================================

/**
 * Service for managing chunked transaction reconstruction.
 * Maintains in-memory state with database backup for crash recovery.
 */
export class MeshtasticTxReconstructor {
  private accumulators: Map<string, ChunkAccumulator> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_CHUNK_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  /**
   * Start the cleanup interval for stale chunks.
   */
  startCleanup(intervalMs: number = 60000): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }

    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanupStaleChunks();
      } catch (error) {
        blockchainLogger.error('Cleanup error', { module: 'TxReconstructor', error: error instanceof Error ? error.message : String(error) });
      }
    }, intervalMs);
    // #977: unref'd — startCleanup() is invoked at module scope below, so
    // importing this file (or anything re-exporting it) holds the loop open.
    this.cleanupInterval.unref();

    blockchainLogger.info('Started cleanup interval', { module: 'TxReconstructor', intervalMs });
  }

  /**
   * Stop the cleanup interval.
   */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Store a chunk and check if the transaction is complete.
   */
  async storeChunk(
    chunk: TxBody,
    meshtasticNodeId: string,
    gatewayId: string
  ): Promise<ChunkStorageResult> {
    const txId = chunk.txId;
    const chunkIndex = chunk.chunk.index;
    const totalChunks = chunk.chunk.total;

    try {
      // Check if we've already stored this exact chunk
      const existingChunk = await this.findExistingChunk(txId, chunkIndex);
      if (existingChunk) {
        // Already have this chunk, return current status
        const accumulator = this.accumulators.get(txId);
        return {
          success: true,
          txId,
          chunksReceived: accumulator?.receivedChunks.size || 1,
          chunksTotal: totalChunks,
          isComplete: accumulator ? accumulator.receivedChunks.size === totalChunks : false,
          isNewChunk: false,
        };
      }

      // Check memory limit
      if (this.accumulators.size >= MAX_PENDING_TRANSACTIONS && !this.accumulators.has(txId)) {
        blockchainLogger.warn('Max pending transactions reached, evicting oldest', { module: 'TxReconstructor' });
        this.evictOldestTransaction();
      }

      // Get or create accumulator
      let accumulator = this.accumulators.get(txId);
      if (!accumulator) {
        accumulator = {
          txId,
          from: chunk.from,
          to: chunk.to,
          amount: chunk.amount,
          nonce: chunk.nonce,
          signature: chunk.signature,
          totalChunks,
          receivedChunks: new Map(),
          meshtasticNodeId,
          gatewayId,
          firstReceivedAt: new Date(),
          lastReceivedAt: new Date(),
        };
        this.accumulators.set(txId, accumulator);
      } else {
        // Prevent txId reuse with conflicting signed metadata (chunk poisoning/injection).
        const hasMismatch =
          accumulator.from !== chunk.from ||
          accumulator.to !== chunk.to ||
          accumulator.amount !== chunk.amount ||
          accumulator.nonce !== chunk.nonce ||
          accumulator.signature !== chunk.signature ||
          accumulator.totalChunks !== totalChunks ||
          accumulator.meshtasticNodeId !== meshtasticNodeId;

        if (hasMismatch) {
          blockchainLogger.warn('Rejected inconsistent chunk metadata', {
            module: 'TxReconstructor',
            txId,
            chunkIndex,
          });
          return {
            success: false,
            txId,
            chunksReceived: accumulator.receivedChunks.size,
            chunksTotal: accumulator.totalChunks,
            isComplete: false,
            error: 'Inconsistent chunk metadata for txId',
            isNewChunk: false,
          };
        }
      }

      // Store the chunk data
      accumulator.receivedChunks.set(chunkIndex, chunk.chunk.data);
      accumulator.lastReceivedAt = new Date();

      // Persist to database for crash recovery.
      // If a concurrent request inserted the same (txId, chunkIndex), treat as idempotent.
      try {
        await db.insert(meshtasticTxChunks).values({
          txId,
          chunkIndex,
          totalChunks,
          meshtasticNodeId,
          gatewayId,
          chunkData: chunk.chunk.data,
          receivedAt: new Date(),
          isComplete: false,
        });
      } catch (error) {
        const pgError = error as { code?: string };
        if (pgError.code === '23505') {
          return {
            success: true,
            txId,
            chunksReceived: accumulator.receivedChunks.size,
            chunksTotal: totalChunks,
            isComplete: accumulator.receivedChunks.size === totalChunks,
            isNewChunk: false,
          };
        }
        throw error;
      }

      const isComplete = accumulator.receivedChunks.size === totalChunks;

      blockchainLogger.info('Stored chunk', { module: 'TxReconstructor', chunkIndex: chunkIndex + 1, totalChunks, txId });

      return {
        success: true,
        txId,
        chunksReceived: accumulator.receivedChunks.size,
        chunksTotal: totalChunks,
        isComplete,
        isNewChunk: true,
      };
    } catch (error) {
      blockchainLogger.error('Error storing chunk', { module: 'TxReconstructor', error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        txId,
        chunksReceived: 0,
        chunksTotal: totalChunks,
        isComplete: false,
        error: error instanceof Error ? error.message : 'Unknown error',
        isNewChunk: false,
      };
    }
  }

  /**
   * Check if a transaction has all chunks and is ready for reconstruction.
   */
  isComplete(txId: string): boolean {
    const accumulator = this.accumulators.get(txId);
    if (!accumulator) return false;
    return accumulator.receivedChunks.size === accumulator.totalChunks;
  }

  /**
   * Get the current state of a transaction's chunks.
   */
  getState(txId: string): { received: number; total: number } | null {
    const accumulator = this.accumulators.get(txId);
    if (!accumulator) return null;
    return {
      received: accumulator.receivedChunks.size,
      total: accumulator.totalChunks,
    };
  }

  /**
   * Reconstruct a complete transaction from its chunks.
   */
  reconstruct(txId: string): ReconstructionResult {
    const accumulator = this.accumulators.get(txId);

    if (!accumulator) {
      return {
        success: false,
        error: `Transaction ${txId} not found`,
      };
    }

    if (accumulator.receivedChunks.size !== accumulator.totalChunks) {
      return {
        success: false,
        error: `Transaction ${txId} incomplete: ${accumulator.receivedChunks.size}/${accumulator.totalChunks} chunks`,
      };
    }

    try {
      // Sort chunks by index and concatenate
      const sortedChunks = Array.from(accumulator.receivedChunks.entries())
        .sort(([a], [b]) => a - b)
        .map(([, data]) => Buffer.from(data, 'base64'));

      const rawData = Buffer.concat(sortedChunks);

      const transaction: ReconstructedTransaction = {
        txId: accumulator.txId,
        from: accumulator.from,
        to: accumulator.to,
        amount: accumulator.amount,
        nonce: accumulator.nonce,
        signature: accumulator.signature,
        rawData,
        meshtasticNodeId: accumulator.meshtasticNodeId,
        gatewayId: accumulator.gatewayId,
        reconstructedAt: new Date(),
      };

      blockchainLogger.info('Reconstructed transaction', { module: 'TxReconstructor', txId, sizeBytes: rawData.length });

      return {
        success: true,
        transaction,
      };
    } catch (error) {
      blockchainLogger.error('Reconstruction error', { module: 'TxReconstructor', error: error instanceof Error ? error.message : String(error) });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Mark a transaction as processed and clean up.
   */
  async markProcessed(txId: string): Promise<void> {
    // Remove from memory
    this.accumulators.delete(txId);

    // Mark in database
    await db
      .update(meshtasticTxChunks)
      .set({
        isComplete: true,
        processedAt: new Date(),
      })
      .where(eq(meshtasticTxChunks.txId, txId));

    blockchainLogger.info('Marked transaction as processed', { module: 'TxReconstructor', txId });
  }

  /**
   * Check if a transaction has already been processed.
   */
  async isAlreadyProcessed(txId: string): Promise<boolean> {
    const result = await db
      .select({ id: meshtasticTxChunks.id })
      .from(meshtasticTxChunks)
      .where(and(eq(meshtasticTxChunks.txId, txId), eq(meshtasticTxChunks.isComplete, true)))
      .limit(1);

    return result.length > 0;
  }

  /**
   * Clean up stale transactions that have exceeded the timeout.
   */
  async cleanupStaleChunks(): Promise<number> {
    const cutoffTime = new Date(Date.now() - this.timeoutMs);
    let cleanedCount = 0;

    // Clean up from memory
    for (const [txId, accumulator] of this.accumulators.entries()) {
      if (accumulator.lastReceivedAt < cutoffTime) {
        this.accumulators.delete(txId);
        cleanedCount++;
        blockchainLogger.info('Expired incomplete transaction', { module: 'TxReconstructor', txId });
      }
    }

    // Clean up from database (mark as expired)
    await db
      .update(meshtasticTxChunks)
      .set({
        processedAt: new Date(),
      })
      .where(
        and(
          eq(meshtasticTxChunks.isComplete, false),
          lt(meshtasticTxChunks.receivedAt, cutoffTime)
        )
      );

    if (cleanedCount > 0) {
      blockchainLogger.info('Cleaned up stale transactions', { module: 'TxReconstructor', cleanedCount });
    }

    return cleanedCount;
  }

  /**
   * Recover pending transactions from database on startup.
   */
  async recoverFromDatabase(): Promise<number> {
    const cutoffTime = new Date(Date.now() - this.timeoutMs);

    // Get all pending chunks that haven't expired
    const pendingChunks = await db
      .select()
      .from(meshtasticTxChunks)
      .where(
        and(
          eq(meshtasticTxChunks.isComplete, false),
          // Only recover recent chunks (not expired)
          // Note: processedAt being null means not yet processed or expired
        )
      );

    // Group by txId
    const txMap = new Map<string, MeshtasticTxChunk[]>();
    for (const chunk of pendingChunks) {
      if (chunk.receivedAt >= cutoffTime) {
        const existing = txMap.get(chunk.txId) || [];
        existing.push(chunk);
        txMap.set(chunk.txId, existing);
      }
    }

    // Rebuild accumulators
    let recoveredCount = 0;
    for (const [txId, chunks] of txMap.entries()) {
      if (this.accumulators.size >= MAX_PENDING_TRANSACTIONS) {
        break;
      }

      const firstChunk = chunks[0];
      const accumulator: ChunkAccumulator = {
        txId,
        from: '', // Will be filled from actual transaction data if needed
        to: '',
        amount: '',
        nonce: 0,
        signature: '',
        totalChunks: firstChunk.totalChunks,
        receivedChunks: new Map(),
        meshtasticNodeId: firstChunk.meshtasticNodeId,
        gatewayId: firstChunk.gatewayId,
        firstReceivedAt: firstChunk.receivedAt,
        lastReceivedAt: firstChunk.receivedAt,
      };

      for (const chunk of chunks) {
        accumulator.receivedChunks.set(chunk.chunkIndex, chunk.chunkData);
        if (chunk.receivedAt > accumulator.lastReceivedAt) {
          accumulator.lastReceivedAt = chunk.receivedAt;
        }
      }

      this.accumulators.set(txId, accumulator);
      recoveredCount++;
    }

    if (recoveredCount > 0) {
      blockchainLogger.info('Recovered pending transactions from database', { module: 'TxReconstructor', recoveredCount });
    }

    return recoveredCount;
  }

  /**
   * Find an existing chunk in the database.
   */
  private async findExistingChunk(
    txId: string,
    chunkIndex: number
  ): Promise<MeshtasticTxChunk | null> {
    const result = await db
      .select()
      .from(meshtasticTxChunks)
      .where(
        and(
          eq(meshtasticTxChunks.txId, txId),
          eq(meshtasticTxChunks.chunkIndex, chunkIndex)
        )
      )
      .limit(1);

    return result[0] || null;
  }

  /**
   * Evict the oldest transaction from memory to make room.
   */
  private evictOldestTransaction(): void {
    let oldestTxId: string | null = null;
    let oldestTime: Date | null = null;

    for (const [txId, accumulator] of this.accumulators.entries()) {
      if (!oldestTime || accumulator.lastReceivedAt < oldestTime) {
        oldestTime = accumulator.lastReceivedAt;
        oldestTxId = txId;
      }
    }

    if (oldestTxId) {
      this.accumulators.delete(oldestTxId);
      blockchainLogger.info('Evicted oldest transaction', { module: 'TxReconstructor', txId: oldestTxId });
    }
  }

  /**
   * Get statistics about the current state.
   */
  getStats(): {
    pendingTransactions: number;
    maxPending: number;
    timeoutMs: number;
  } {
    return {
      pendingTransactions: this.accumulators.size,
      maxPending: MAX_PENDING_TRANSACTIONS,
      timeoutMs: this.timeoutMs,
    };
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

/**
 * Global reconstructor instance.
 */
export const txReconstructor = new MeshtasticTxReconstructor();

// Start cleanup on module load
txReconstructor.startCleanup();

// Graceful shutdown
process.on('SIGTERM', () => txReconstructor.stopCleanup());
process.on('SIGINT', () => txReconstructor.stopCleanup());
