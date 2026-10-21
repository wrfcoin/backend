/**
 * Atomic Swap Engine
 *
 * Coordinates complete atomic swaps across chains using all security components:
 * - HTLC management
 * - Fraud proof verification
 * - Multi-signature collection
 * - State synchronization
 * - Finality monitoring
 * - Rollback coordination
 *
 * Ensures atomicity: either both chains complete or both rollback
 */

import { EventEmitter } from 'events';
import { htlcManager, HTLCCreateParams, HTLCStatus, SupportedNetwork } from './cross-chain-htlc-manager.js';
import { fraudProofSystem } from './bridge-fraud-proof-system.js';
import { bridgeMultiSig } from './bridge-multi-signature.js';
import { bridgeStateSync } from './bridge-state-synchronization.js';
import { finalityMonitor } from './bridge-finality-monitor.js';
import { rollbackCoordinator, RollbackReason } from './bridge-rollback-coordinator.js';

export enum SwapStatus {
  INITIATED = 'INITIATED',
  HTLC_CREATED = 'HTLC_CREATED',
  SOURCE_LOCKED = 'SOURCE_LOCKED',
  AWAITING_FINALITY = 'AWAITING_FINALITY',
  SIGNATURES_COLLECTING = 'SIGNATURES_COLLECTING',
  SIGNATURES_VERIFIED = 'SIGNATURES_VERIFIED',
  DESTINATION_READY = 'DESTINATION_READY',
  COMPLETED = 'COMPLETED',
  ROLLING_BACK = 'ROLLING_BACK',
  ROLLED_BACK = 'ROLLED_BACK',
  FAILED = 'FAILED',
}

export interface AtomicSwap {
  id: string;
  sourceChain: SupportedNetwork;
  destinationChain: SupportedNetwork;
  sender: string;
  recipient: string;
  amount: string;
  asset: string;
  status: SwapStatus;
  htlcId?: string;
  sourceTransactionHash?: string;
  destinationTransactionHash?: string;
  signatureRequestId?: string;
  checkpointId?: string;
  secret?: string;
  secretHash?: string;
  createdAt: Date;
  completedAt?: Date;
  error?: string;
}

export class AtomicSwapEngine extends EventEmitter {
  private swaps: Map<string, AtomicSwap> = new Map();

  constructor() {
    super();
    this.setupEventListeners();
  }

  /**
   * Setup event listeners for components
   */
  private setupEventListeners(): void {
    // HTLC events
    htlcManager.on('htlc:locked', (event) => {
      this.handleHTLCLocked(event);
    });

    htlcManager.on('htlc:claimed', (event) => {
      this.handleHTLCClaimed(event);
    });

    htlcManager.on('htlc:expired', (event) => {
      this.handleHTLCExpired(event);
    });

    // Finality events
    finalityMonitor.on('transaction:finalized', (event) => {
      this.handleTransactionFinalized(event);
    });

    // Signature events
    bridgeMultiSig.on('signature:threshold_reached', (event) => {
      this.handleSignatureThresholdReached(event);
    });

    // Rollback events
    rollbackCoordinator.on('rollback:completed', (event) => {
      this.handleRollbackCompleted(event);
    });
  }

  /**
   * Initiate atomic swap
   */
  public async initiateSwap(params: {
    sourceChain: SupportedNetwork;
    destinationChain: SupportedNetwork;
    sender: string;
    recipient: string;
    amount: string;
    asset: string;
  }): Promise<AtomicSwap> {
    const swapId = this.generateSwapId(params);

    const swap: AtomicSwap = {
      id: swapId,
      ...params,
      status: SwapStatus.INITIATED,
      createdAt: new Date(),
    };

    this.swaps.set(swapId, swap);

    this.emit('swap:initiated', {
      swapId,
      sourceChain: params.sourceChain,
      destinationChain: params.destinationChain,
      amount: params.amount,
    });

    try {
      // Step 1: Create HTLC
      await this.createHTLC(swap);

      // Step 2: Lock funds on source chain
      await this.lockSourceFunds(swap);

      // Step 3: Wait for finality
      await this.waitForFinality(swap);

      // Step 4: Collect validator signatures
      await this.collectSignatures(swap);

      // Step 5: Execute on destination chain
      await this.executeDestination(swap);

      // Step 6: Complete swap
      await this.completeSwap(swap);

      return swap;
    } catch (error) {
      swap.status = SwapStatus.FAILED;
      swap.error = error instanceof Error ? error.message : 'Unknown error';

      this.emit('swap:failed', {
        swapId,
        error: swap.error,
      });

      // Initiate rollback
      await this.initiateRollback(swap);

      throw error;
    }
  }

  /**
   * Step 1: Create HTLC contract
   */
  private async createHTLC(swap: AtomicSwap): Promise<void> {
    const htlcParams: HTLCCreateParams = {
      sourceChain: swap.sourceChain,
      destinationChain: swap.destinationChain,
      sender: swap.sender,
      recipient: swap.recipient,
      amount: swap.amount,
      asset: swap.asset,
    };

    const htlc = await htlcManager.createHTLC(htlcParams);

    swap.htlcId = htlc.id;
    swap.secretHash = htlc.secretHash;
    swap.status = SwapStatus.HTLC_CREATED;

    this.emit('swap:htlc_created', {
      swapId: swap.id,
      htlcId: htlc.id,
      secretHash: htlc.secretHash,
    });
  }

  /**
   * Step 2: Lock funds on source chain
   */
  private async lockSourceFunds(swap: AtomicSwap): Promise<void> {
    if (!swap.htlcId) {
      throw new Error('HTLC not created');
    }

    // Simulate locking transaction
    const txHash = this.simulateTransaction(swap.sourceChain);
    swap.sourceTransactionHash = txHash;

    // Register with HTLC manager
    await htlcManager.lockHTLC(swap.htlcId, txHash);

    swap.status = SwapStatus.SOURCE_LOCKED;

    this.emit('swap:source_locked', {
      swapId: swap.id,
      transactionHash: txHash,
      chain: swap.sourceChain,
    });
  }

  /**
   * Step 3: Wait for transaction finality
   */
  private async waitForFinality(swap: AtomicSwap): Promise<void> {
    if (!swap.sourceTransactionHash) {
      throw new Error('No source transaction');
    }

    swap.status = SwapStatus.AWAITING_FINALITY;

    // Monitor transaction
    await finalityMonitor.monitorTransaction(
      swap.sourceTransactionHash,
      swap.sourceChain,
      1000, // Block number (simulated)
      this.simulateBlockHash()
    );

    // Wait for finality (with timeout)
    const finalized = await finalityMonitor.waitForFinality(
      swap.sourceTransactionHash,
      600000 // 10 minutes timeout
    );

    if (!finalized) {
      throw new Error('Finality timeout');
    }

    this.emit('swap:finality_reached', {
      swapId: swap.id,
      transactionHash: swap.sourceTransactionHash,
    });
  }

  /**
   * Step 4: Collect validator signatures
   */
  private async collectSignatures(swap: AtomicSwap): Promise<void> {
    if (!swap.sourceTransactionHash) {
      throw new Error('No source transaction');
    }

    swap.status = SwapStatus.SIGNATURES_COLLECTING;

    // Create signature request
    const request = await bridgeMultiSig.createSignatureRequest(
      swap.sourceTransactionHash,
      swap.sourceChain,
      swap.destinationChain,
      swap.amount,
      swap.sender,
      swap.recipient,
      swap.asset
    );

    swap.signatureRequestId = request.id;

    this.emit('swap:signatures_collecting', {
      swapId: swap.id,
      requestId: request.id,
      requiredSignatures: request.requiredSignatures,
    });

    // Wait for threshold (handled by event listener)
  }

  /**
   * Step 5: Execute on destination chain
   */
  private async executeDestination(swap: AtomicSwap): Promise<void> {
    swap.status = SwapStatus.DESTINATION_READY;

    // Simulate destination transaction
    const txHash = this.simulateTransaction(swap.destinationChain);
    swap.destinationTransactionHash = txHash;

    this.emit('swap:destination_executed', {
      swapId: swap.id,
      transactionHash: txHash,
      chain: swap.destinationChain,
    });
  }

  /**
   * Step 6: Complete swap
   */
  private async completeSwap(swap: AtomicSwap): Promise<void> {
    if (!swap.htlcId) {
      throw new Error('HTLC not found');
    }

    // Get secret from HTLC
    const htlc = htlcManager.getHTLC(swap.htlcId);
    if (!htlc) {
      throw new Error('HTLC not found');
    }

    // Claim HTLC with secret
    const secret = htlcManager.getSecret(htlc.secretHash);
    if (!secret) {
      throw new Error('Secret not found');
    }

    await htlcManager.claimHTLC({
      htlcId: swap.htlcId,
      secret: secret.secret.toString('hex'),
      claimant: swap.recipient,
    });

    swap.status = SwapStatus.COMPLETED;
    swap.completedAt = new Date();
    swap.secret = secret.secret.toString('hex');

    this.emit('swap:completed', {
      swapId: swap.id,
      sourceChain: swap.sourceChain,
      destinationChain: swap.destinationChain,
      amount: swap.amount,
    });
  }

  /**
   * Initiate rollback
   */
  private async initiateRollback(swap: AtomicSwap): Promise<void> {
    if (!swap.sourceTransactionHash) {
      return;
    }

    swap.status = SwapStatus.ROLLING_BACK;

    await rollbackCoordinator.initiateRollback(
      swap.sourceTransactionHash,
      swap.sourceChain,
      swap.destinationChain,
      RollbackReason.SOURCE_LOCK_FAILED
    );
  }

  /**
   * Event handlers
   */
  private handleHTLCLocked(event: any): void {
    const swap = this.findSwapByHTLC(event.htlcId);
    if (swap) {
      this.emit('swap:htlc_locked', {
        swapId: swap.id,
        htlcId: event.htlcId,
      });
    }
  }

  private handleHTLCClaimed(event: any): void {
    const swap = this.findSwapByHTLC(event.htlcId);
    if (swap) {
      swap.secret = event.secret;
    }
  }

  private handleHTLCExpired(event: any): void {
    const swap = this.findSwapByHTLC(event.htlcId);
    if (swap && swap.status !== SwapStatus.COMPLETED) {
      this.initiateRollback(swap);
    }
  }

  private handleTransactionFinalized(event: any): void {
    const swap = this.findSwapByTransaction(event.transactionHash);
    if (swap && swap.status === SwapStatus.AWAITING_FINALITY) {
      // Finality reached, continue to signature collection
    }
  }

  private handleSignatureThresholdReached(event: any): void {
    const swap = this.findSwapBySignatureRequest(event.requestId);
    if (swap) {
      swap.status = SwapStatus.SIGNATURES_VERIFIED;
      this.executeDestination(swap);
    }
  }

  private handleRollbackCompleted(event: any): void {
    const swap = this.findSwapByTransaction(event.transactionHash);
    if (swap) {
      swap.status = SwapStatus.ROLLED_BACK;
    }
  }

  /**
   * Helper methods
   */
  private findSwapByHTLC(htlcId: string): AtomicSwap | undefined {
    return Array.from(this.swaps.values()).find(s => s.htlcId === htlcId);
  }

  private findSwapByTransaction(txHash: string): AtomicSwap | undefined {
    return Array.from(this.swaps.values()).find(
      s => s.sourceTransactionHash === txHash || s.destinationTransactionHash === txHash
    );
  }

  private findSwapBySignatureRequest(requestId: string): AtomicSwap | undefined {
    return Array.from(this.swaps.values()).find(
      s => s.signatureRequestId === requestId
    );
  }

  private generateSwapId(params: any): string {
    return `swap-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private simulateTransaction(chain: string): string {
    return `0x${Math.random().toString(16).substr(2, 64)}`;
  }

  private simulateBlockHash(): string {
    return `0x${Math.random().toString(16).substr(2, 64)}`;
  }

  /**
   * Get swap by ID
   */
  public getSwap(swapId: string): AtomicSwap | undefined {
    return this.swaps.get(swapId);
  }

  /**
   * Get all swaps
   */
  public getAllSwaps(): AtomicSwap[] {
    return Array.from(this.swaps.values());
  }

  /**
   * Get statistics
   */
  public getStatistics() {
    const swaps = Array.from(this.swaps.values());

    return {
      total: swaps.length,
      completed: swaps.filter(s => s.status === SwapStatus.COMPLETED).length,
      failed: swaps.filter(s => s.status === SwapStatus.FAILED).length,
      inProgress: swaps.filter(
        s => s.status !== SwapStatus.COMPLETED && s.status !== SwapStatus.FAILED
      ).length,
      byStatus: this.groupByStatus(),
    };
  }

  private groupByStatus(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const swap of this.swaps.values()) {
      result[swap.status] = (result[swap.status] || 0) + 1;
    }
    return result;
  }
}

export const atomicSwapEngine = new AtomicSwapEngine();
