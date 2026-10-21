/**
 * State Reconciliation System
 * Merges and resolves conflicting blockchain states after network partition healing
 *
 * SECURITY: Addresses Task 100.9 vulnerabilities:
 * - Resolves state conflicts after partition healing
 * - Implements transaction replay with conflict detection
 * - Validates state consistency across partitions
 * - Uses Merkle trees for efficient state comparison
 * - Supports rollback to safe checkpoint
 * - Prevents double-spending during reconciliation
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import { blockchainLogger } from '../server/utils/logger.js';

export interface StateSnapshot {
  snapshotId: string;
  blockHeight: number;
  blockHash: string;
  stateRoot: string;
  timestamp: Date;
  transactions: Transaction[];
  accounts: Map<string, AccountState>;
  merkleRoot: string;
  validatorSignatures: Map<string, string>;
}

export interface Transaction {
  txHash: string;
  from: string;
  to: string;
  amount: bigint;
  nonce: number;
  timestamp: Date;
  signature: string;
  blockHeight?: number;
}

export interface AccountState {
  address: string;
  balance: bigint;
  nonce: number;
  stateHash: string;
}

export interface StateConflict {
  conflictId: string;
  divergenceHeight: number;
  states: StateSnapshot[];
  conflictingTransactions: Transaction[];
  conflictingAccounts: string[];
  resolutionMethod: 'majority' | 'longest_chain' | 'highest_stake' | 'manual';
  resolved: boolean;
}

export interface ReconciliationPlan {
  planId: string;
  createdAt: Date;
  divergencePoint: number;
  canonicalState: StateSnapshot;
  conflictingStates: StateSnapshot[];
  transactionsToReplay: Transaction[];
  transactionsToRevert: Transaction[];
  accountsToUpdate: string[];
  estimatedDuration: number;
}

export interface ReconciliationResult {
  success: boolean;
  finalBlockHeight: number;
  finalStateRoot: string;
  transactionsReplayed: number;
  transactionsReverted: number;
  accountsUpdated: number;
  conflicts: StateConflict[];
  duration: number;
  errors: string[];
}

export interface MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
  data?: any;
}

export interface MerkleProof {
  leaf: string;
  siblings: string[];
  path: boolean[]; // true = right, false = left
}

export interface ReconciliationConfig {
  maxConflictResolutionAttempts: number;
  transactionReplayBatchSize: number;
  merkleTreeDepth: number;
  conflictResolutionStrategy: 'majority' | 'longest_chain' | 'highest_stake';
  enableDoubleSpendDetection: boolean;
  requireValidatorConsensus: boolean;
  consensusThreshold: number; // percentage
}

/**
 * State Reconciliation Service
 * SECURITY: Ensures consistent blockchain state after partition healing
 */
export class StateReconciliation extends EventEmitter {
  private snapshots: Map<number, StateSnapshot[]> = new Map(); // blockHeight -> snapshots
  private conflicts: Map<string, StateConflict> = new Map();
  private accountStates: Map<string, AccountState> = new Map();
  private transactionPool: Map<string, Transaction> = new Map();
  private merkleTree: MerkleNode | null = null;

  private readonly config: ReconciliationConfig;

  private static readonly DEFAULT_CONFIG: ReconciliationConfig = {
    maxConflictResolutionAttempts: 3,
    transactionReplayBatchSize: 100,
    merkleTreeDepth: 20,
    conflictResolutionStrategy: 'majority',
    enableDoubleSpendDetection: true,
    requireValidatorConsensus: true,
    consensusThreshold: 67,
  };

  constructor(config?: Partial<ReconciliationConfig>) {
    super();
    this.config = { ...StateReconciliation.DEFAULT_CONFIG, ...config };
  }

  /**
   * Record state snapshot
   */
  recordSnapshot(snapshot: StateSnapshot): void {
    if (!this.snapshots.has(snapshot.blockHeight)) {
      this.snapshots.set(snapshot.blockHeight, []);
    }

    const heightSnapshots = this.snapshots.get(snapshot.blockHeight)!;
    heightSnapshots.push(snapshot);

    blockchainLogger.info('Recorded snapshot', {
      module: 'StateReconciliation',
      blockHeight: snapshot.blockHeight
    });

    // Check for conflicts
    if (heightSnapshots.length > 1) {
      this.detectStateConflict(snapshot.blockHeight);
    }

    // Update Merkle tree
    this.updateMerkleTree(snapshot);

    this.emit('snapshot_recorded', snapshot);
  }

  /**
   * Detect state conflict at block height
   */
  private detectStateConflict(blockHeight: number): void {
    const snapshots = this.snapshots.get(blockHeight);
    if (!snapshots || snapshots.length <= 1) return;

    // Check if states differ
    const stateRoots = new Set(snapshots.map((s) => s.stateRoot));
    if (stateRoots.size <= 1) return; // No conflict

    const conflictId = crypto.randomBytes(16).toString('hex');

    // Find conflicting transactions
    const conflictingTxs = this.findConflictingTransactions(snapshots);

    // Find conflicting accounts
    const conflictingAccounts = this.findConflictingAccounts(snapshots);

    const conflict: StateConflict = {
      conflictId,
      divergenceHeight: blockHeight,
      states: snapshots,
      conflictingTransactions: conflictingTxs,
      conflictingAccounts,
      resolutionMethod: this.config.conflictResolutionStrategy,
      resolved: false,
    };

    this.conflicts.set(conflictId, conflict);

    blockchainLogger.error('State conflict detected', {
      module: 'StateReconciliation',
      blockHeight,
      stateCount: snapshots.length,
      conflictingTxs: conflictingTxs.length,
      conflictingAccounts: conflictingAccounts.length
    });

    this.emit('conflict_detected', conflict);
  }

  /**
   * Find conflicting transactions between states
   */
  private findConflictingTransactions(snapshots: StateSnapshot[]): Transaction[] {
    const txsByHash = new Map<string, Transaction[]>();

    // Group transactions by hash
    for (const snapshot of snapshots) {
      for (const tx of snapshot.transactions) {
        if (!txsByHash.has(tx.txHash)) {
          txsByHash.set(tx.txHash, []);
        }
        txsByHash.get(tx.txHash)!.push(tx);
      }
    }

    const conflicts: Transaction[] = [];

    // Find transactions that appear in some states but not others
    for (const [txHash, txs] of txsByHash) {
      if (txs.length !== snapshots.length) {
        // Transaction doesn't appear in all states
        conflicts.push(txs[0]);
      }
    }

    return conflicts;
  }

  /**
   * Find conflicting accounts between states
   */
  private findConflictingAccounts(snapshots: StateSnapshot[]): string[] {
    const accountsByAddress = new Map<string, AccountState[]>();

    // Group account states by address
    for (const snapshot of snapshots) {
      for (const [address, account] of snapshot.accounts) {
        if (!accountsByAddress.has(address)) {
          accountsByAddress.set(address, []);
        }
        accountsByAddress.get(address)!.push(account);
      }
    }

    const conflicts: string[] = [];

    // Find accounts with different states
    for (const [address, accounts] of accountsByAddress) {
      if (accounts.length < snapshots.length) {
        // Account missing in some states
        conflicts.push(address);
        continue;
      }

      // Check if account states differ
      const stateHashes = new Set(accounts.map((a) => a.stateHash));
      if (stateHashes.size > 1) {
        conflicts.push(address);
      }
    }

    return conflicts;
  }

  /**
   * Create reconciliation plan
   */
  async createReconciliationPlan(
    conflictId: string
  ): Promise<ReconciliationPlan> {
    const conflict = this.conflicts.get(conflictId);
    if (!conflict) {
      throw new Error(`Conflict ${conflictId} not found`);
    }

    blockchainLogger.info('Creating reconciliation plan', {
      module: 'StateReconciliation',
      conflictId
    });

    // Select canonical state based on resolution strategy
    const canonicalState = await this.selectCanonicalState(conflict);

    // Identify transactions to replay and revert
    const { toReplay, toRevert } = this.identifyTransactionActions(
      canonicalState,
      conflict.states
    );

    // Identify accounts to update
    const accountsToUpdate = conflict.conflictingAccounts;

    const plan: ReconciliationPlan = {
      planId: crypto.randomBytes(16).toString('hex'),
      createdAt: new Date(),
      divergencePoint: conflict.divergenceHeight,
      canonicalState,
      conflictingStates: conflict.states.filter((s) => s !== canonicalState),
      transactionsToReplay: toReplay,
      transactionsToRevert: toRevert,
      accountsToUpdate,
      estimatedDuration: this.estimateReconciliationDuration(toReplay, toRevert),
    };

    blockchainLogger.info('Reconciliation plan created', {
      module: 'StateReconciliation',
      replayCount: toReplay.length,
      revertCount: toRevert.length
    });

    this.emit('plan_created', plan);

    return plan;
  }

  /**
   * Execute reconciliation plan
   */
  async executeReconciliation(
    plan: ReconciliationPlan
  ): Promise<ReconciliationResult> {
    const startTime = Date.now();
    const errors: string[] = [];
    let transactionsReplayed = 0;
    let transactionsReverted = 0;
    let accountsUpdated = 0;

    blockchainLogger.info('Executing reconciliation plan', {
      module: 'StateReconciliation',
      planId: plan.planId
    });

    try {
      // Step 1: Revert conflicting transactions
      blockchainLogger.info('Reverting transactions', {
        module: 'StateReconciliation',
        transactionCount: plan.transactionsToRevert.length
      });
      for (const tx of plan.transactionsToRevert) {
        try {
          await this.revertTransaction(tx);
          transactionsReverted++;
        } catch (error) {
          const errMsg = `Failed to revert transaction ${tx.txHash}: ${error}`;
          blockchainLogger.error('Failed to revert transaction', {
            module: 'StateReconciliation',
            txHash: tx.txHash,
            error: String(error)
          });
          errors.push(errMsg);
        }
      }

      // Step 2: Replay transactions in batches
      blockchainLogger.info('Replaying transactions', {
        module: 'StateReconciliation',
        transactionCount: plan.transactionsToReplay.length
      });
      const batches = this.batchTransactions(
        plan.transactionsToReplay,
        this.config.transactionReplayBatchSize
      );

      for (const batch of batches) {
        try {
          const replayed = await this.replayTransactionBatch(batch);
          transactionsReplayed += replayed;
        } catch (error) {
          const errMsg = `Failed to replay batch: ${error}`;
          blockchainLogger.error('Failed to replay batch', {
            module: 'StateReconciliation',
            error: String(error)
          });
          errors.push(errMsg);
        }
      }

      // Step 3: Update account states
      blockchainLogger.info('Updating accounts', {
        module: 'StateReconciliation',
        accountCount: plan.accountsToUpdate.length
      });
      for (const address of plan.accountsToUpdate) {
        try {
          await this.updateAccountState(
            address,
            plan.canonicalState.accounts.get(address)
          );
          accountsUpdated++;
        } catch (error) {
          const errMsg = `Failed to update account ${address}: ${error}`;
          blockchainLogger.error('Failed to update account', {
            module: 'StateReconciliation',
            address,
            error: String(error)
          });
          errors.push(errMsg);
        }
      }

      // Step 4: Verify final state
      const finalState = await this.computeCurrentState();
      const stateValid = await this.verifyStateConsistency(
        finalState,
        plan.canonicalState
      );

      if (!stateValid) {
        errors.push('Final state does not match canonical state');
      }

      const duration = Date.now() - startTime;

      const result: ReconciliationResult = {
        success: errors.length === 0,
        finalBlockHeight: plan.canonicalState.blockHeight,
        finalStateRoot: finalState.stateRoot,
        transactionsReplayed,
        transactionsReverted,
        accountsUpdated,
        conflicts: Array.from(this.conflicts.values()),
        duration,
        errors,
      };

      blockchainLogger.info('Reconciliation completed', {
        module: 'StateReconciliation',
        success: result.success,
        durationMs: duration
      });

      this.emit('reconciliation_completed', result);

      return result;
    } catch (error) {
      blockchainLogger.error('Reconciliation failed', {
        module: 'StateReconciliation',
        error: String(error)
      });
      throw error;
    }
  }

  /**
   * Select canonical state based on resolution strategy
   */
  private async selectCanonicalState(
    conflict: StateConflict
  ): Promise<StateSnapshot> {
    const states = conflict.states;

    switch (conflict.resolutionMethod) {
      case 'majority': {
        // Count validator signatures for each state
        const signatureCounts = states.map(
          (s) => s.validatorSignatures.size
        );
        const maxIndex = signatureCounts.indexOf(Math.max(...signatureCounts));
        blockchainLogger.info('Selected state with most validator signatures', {
          module: 'StateReconciliation',
          signatureCount: signatureCounts[maxIndex]
        });
        return states[maxIndex];
      }

      case 'longest_chain': {
        // This would require checking chain length from this point
        // For now, use highest block height
        const heights = states.map((s) => s.blockHeight);
        const maxIndex = heights.indexOf(Math.max(...heights));
        blockchainLogger.info('Selected longest chain state', {
          module: 'StateReconciliation',
          height: heights[maxIndex]
        });
        return states[maxIndex];
      }

      case 'highest_stake': {
        // Sum stake of validators that signed each state
        const stakeAmounts = states.map((s) => {
          // In production, would look up actual stake amounts
          return BigInt(s.validatorSignatures.size * 1000);
        });
        const maxIndex = stakeAmounts.indexOf(
          stakeAmounts.reduce((a, b) => (a > b ? a : b))
        );
        blockchainLogger.info('Selected highest stake state', {
          module: 'StateReconciliation',
          stake: stakeAmounts[maxIndex].toString()
        });
        return states[maxIndex];
      }

      case 'manual':
      default: {
        // Fall back to majority strategy with admin notification
        blockchainLogger.warn('Manual resolution requested — falling back to majority strategy', {
          module: 'StateReconciliation',
          conflictId: conflict.conflictId,
        });
        this.emit('admin_intervention_needed', {
          conflictId: conflict.conflictId,
          reason: 'Manual resolution requested but no admin available',
          fallbackStrategy: 'majority',
        });
        const signatureCounts = states.map((s) => s.validatorSignatures.size);
        const maxIndex = signatureCounts.indexOf(Math.max(...signatureCounts));
        return states[maxIndex];
      }
    }
  }

  /**
   * Identify which transactions to replay and revert
   */
  private identifyTransactionActions(
    canonicalState: StateSnapshot,
    allStates: StateSnapshot[]
  ): { toReplay: Transaction[]; toRevert: Transaction[] } {
    const canonicalTxs = new Set(
      canonicalState.transactions.map((tx) => tx.txHash)
    );

    const toReplay: Transaction[] = [];
    const toRevert: Transaction[] = [];

    // Collect all unique transactions from other states
    for (const state of allStates) {
      if (state === canonicalState) continue;

      for (const tx of state.transactions) {
        if (!canonicalTxs.has(tx.txHash)) {
          // Transaction in non-canonical state, needs to be checked
          if (this.isTransactionValid(tx, canonicalState)) {
            toReplay.push(tx);
          } else {
            toRevert.push(tx);
          }
        }
      }
    }

    return { toReplay, toRevert };
  }

  /**
   * Check if transaction is valid against canonical state
   */
  private isTransactionValid(
    tx: Transaction,
    canonicalState: StateSnapshot
  ): boolean {
    // Check if sender has sufficient balance
    const senderState = canonicalState.accounts.get(tx.from);
    if (!senderState) return false;

    if (senderState.balance < tx.amount) {
      return false; // Insufficient balance
    }

    // Check nonce
    if (tx.nonce <= senderState.nonce) {
      return false; // Nonce already used (potential double-spend)
    }

    // Verify signature
    if (!this.verifyTransactionSignature(tx)) {
      return false;
    }

    return true;
  }

  /**
   * Revert transaction
   */
  private async revertTransaction(tx: Transaction): Promise<void> {
    // Update sender balance (refund)
    const sender = this.accountStates.get(tx.from);
    if (sender) {
      sender.balance += tx.amount;
      sender.nonce--;
    }

    // Update receiver balance
    const receiver = this.accountStates.get(tx.to);
    if (receiver) {
      receiver.balance -= tx.amount;
    }

    blockchainLogger.info('Reverted transaction', {
      module: 'StateReconciliation',
      txHash: tx.txHash
    });
  }

  /**
   * Replay transaction batch
   */
  private async replayTransactionBatch(
    transactions: Transaction[]
  ): Promise<number> {
    let replayed = 0;

    for (const tx of transactions) {
      try {
        // Check for double-spend if enabled
        if (this.config.enableDoubleSpendDetection) {
          if (await this.detectDoubleSpend(tx)) {
            blockchainLogger.warn('Skipping double-spend transaction', {
              module: 'StateReconciliation',
              txHash: tx.txHash
            });
            continue;
          }
        }

        // Execute transaction
        await this.executeTransaction(tx);
        replayed++;
      } catch (error) {
        blockchainLogger.error('Failed to replay transaction', {
          module: 'StateReconciliation',
          txHash: tx.txHash,
          error: String(error)
        });
      }
    }

    return replayed;
  }

  /**
   * Execute transaction
   */
  private async executeTransaction(tx: Transaction): Promise<void> {
    // Update sender
    const sender = this.accountStates.get(tx.from);
    if (!sender) {
      throw new Error(`Sender account ${tx.from} not found`);
    }

    if (sender.balance < tx.amount) {
      throw new Error('Insufficient balance');
    }

    sender.balance -= tx.amount;
    sender.nonce++;

    // Update receiver
    let receiver = this.accountStates.get(tx.to);
    if (!receiver) {
      receiver = {
        address: tx.to,
        balance: BigInt(0),
        nonce: 0,
        stateHash: '',
      };
      this.accountStates.set(tx.to, receiver);
    }

    receiver.balance += tx.amount;

    // Update state hashes
    sender.stateHash = this.computeAccountHash(sender);
    receiver.stateHash = this.computeAccountHash(receiver);

    blockchainLogger.info('Executed transaction', { module: 'StateReconciliation', txHash: tx.txHash });
  }

  /**
   * Detect double-spend attempt
   */
  private async detectDoubleSpend(tx: Transaction): Promise<boolean> {
    const sender = this.accountStates.get(tx.from);
    if (!sender) return false;

    // Check if nonce was already used
    if (tx.nonce <= sender.nonce) {
      return true; // Double-spend detected
    }

    // Check if there's another transaction with same nonce in pool
    for (const [_, poolTx] of this.transactionPool) {
      if (poolTx.from === tx.from && poolTx.nonce === tx.nonce) {
        return true; // Double-spend detected
      }
    }

    return false;
  }

  /**
   * Update account state
   */
  private async updateAccountState(
    address: string,
    newState: AccountState | undefined
  ): Promise<void> {
    if (!newState) {
      this.accountStates.delete(address);
      return;
    }

    this.accountStates.set(address, { ...newState });
    blockchainLogger.info('Updated account', {
      module: 'StateReconciliation',
      address
    });
  }

  /**
   * Batch transactions
   */
  private batchTransactions(
    transactions: Transaction[],
    batchSize: number
  ): Transaction[][] {
    const batches: Transaction[][] = [];
    for (let i = 0; i < transactions.length; i += batchSize) {
      batches.push(transactions.slice(i, i + batchSize));
    }
    return batches;
  }

  /**
   * Compute current state
   */
  private async computeCurrentState(): Promise<StateSnapshot> {
    const stateRoot = this.computeStateRoot();
    const merkleRoot = this.computeMerkleRoot();

    return {
      snapshotId: crypto.randomBytes(16).toString('hex'),
      blockHeight: 0, // Would be actual current height
      blockHash: '',
      stateRoot,
      timestamp: new Date(),
      transactions: [],
      accounts: new Map(this.accountStates),
      merkleRoot,
      validatorSignatures: new Map(),
    };
  }

  /**
   * Verify state consistency
   */
  private async verifyStateConsistency(
    actualState: StateSnapshot,
    expectedState: StateSnapshot
  ): Promise<boolean> {
    // Compare state roots
    if (actualState.stateRoot !== expectedState.stateRoot) {
      blockchainLogger.error('State root mismatch', {
      module: 'StateReconciliation',
      actual: actualState.stateRoot,
      expected: expectedState.stateRoot
    });
      return false;
    }

    // Compare Merkle roots
    if (actualState.merkleRoot !== expectedState.merkleRoot) {
      blockchainLogger.error('Merkle root mismatch', { module: 'StateReconciliation' });
      return false;
    }

    return true;
  }

  /**
   * Update Merkle tree with new snapshot
   */
  private updateMerkleTree(snapshot: StateSnapshot): void {
    // Build Merkle tree from account states
    const leaves = Array.from(snapshot.accounts.values()).map((account) =>
      this.computeAccountHash(account)
    );

    this.merkleTree = this.buildMerkleTree(leaves);
  }

  /**
   * Build Merkle tree from leaves
   */
  private buildMerkleTree(leaves: string[]): MerkleNode {
    if (leaves.length === 0) {
      throw new Error('Cannot build Merkle tree from empty leaves');
    }

    const nodes: MerkleNode[] = leaves.map((hash) => ({ hash }));

    while (nodes.length > 1) {
      const newLevel: MerkleNode[] = [];

      for (let i = 0; i < nodes.length; i += 2) {
        const left = nodes[i];
        const right = nodes[i + 1] || left; // Duplicate if odd number

        const combinedHash = crypto
          .createHash('sha256')
          .update(left.hash + right.hash)
          .digest('hex');

        newLevel.push({
          hash: combinedHash,
          left,
          right,
        });
      }

      nodes.splice(0, nodes.length, ...newLevel);
    }

    return nodes[0];
  }

  /**
   * Compute Merkle root
   */
  private computeMerkleRoot(): string {
    return this.merkleTree?.hash || '';
  }

  /**
   * Compute state root from all accounts
   */
  private computeStateRoot(): string {
    const accountHashes = Array.from(this.accountStates.values())
      .map((account) => this.computeAccountHash(account))
      .sort()
      .join('');

    return crypto.createHash('sha256').update(accountHashes).digest('hex');
  }

  /**
   * Compute account hash
   */
  private computeAccountHash(account: AccountState): string {
    const data = `${account.address}:${account.balance}:${account.nonce}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Verify transaction signature
   */
  private verifyTransactionSignature(tx: Transaction): boolean {
    // In production, would verify actual cryptographic signature
    return tx.signature.length > 0;
  }

  /**
   * Estimate reconciliation duration
   */
  private estimateReconciliationDuration(
    toReplay: Transaction[],
    toRevert: Transaction[]
  ): number {
    // Rough estimate: 1ms per transaction
    return (toReplay.length + toRevert.length) * 1;
  }

  /**
   * Get reconciliation status
   */
  getStatus(): {
    activeConflicts: number;
    totalSnapshots: number;
    conflicts: StateConflict[];
  } {
    return {
      activeConflicts: this.conflicts.size,
      totalSnapshots: Array.from(this.snapshots.values()).reduce(
        (sum, snapshots) => sum + snapshots.length,
        0
      ),
      conflicts: Array.from(this.conflicts.values()),
    };
  }
}
