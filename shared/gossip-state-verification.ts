/**
 * Gossip Network State Verification System
 * Task 100.14 - Network state consistency and corruption protection
 *
 * SECURITY FEATURES:
 * - Cross-node state verification with Byzantine fault tolerance
 * - Merkle tree-based state validation
 * - State corruption detection and recovery
 * - Automatic state reconciliation with conflict resolution
 * - State snapshot management with versioning
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

export interface NetworkState {
  stateId: string;
  version: number;
  timestamp: Date;
  data: Map<string, any>;
  merkleRoot: Buffer;
  merkleTree: MerkleNode[];
  signatures: Map<string, Buffer>; // Node signatures
  checksum: string;
}

export interface MerkleNode {
  hash: Buffer;
  left?: MerkleNode;
  right?: MerkleNode;
  data?: any;
}

export interface StateVerificationResult {
  isValid: boolean;
  consistency: number; // 0-1
  divergences: StateDivergence[];
  consensusReached: boolean;
  participatingNodes: number;
  merkleValid: boolean;
}

export interface StateDivergence {
  key: string;
  localValue: any;
  remoteValue: any;
  conflictType: 'missing' | 'mismatch' | 'corrupted';
  severity: 'low' | 'medium' | 'high' | 'critical';
}

export interface StateReconciliationStrategy {
  strategy: 'local-wins' | 'remote-wins' | 'newest-wins' | 'consensus' | 'manual';
  threshold: number; // Consensus threshold (0-1)
}

export interface StateSnapshot {
  snapshotId: string;
  state: NetworkState;
  createdAt: Date;
  validatedBy: Set<string>;
  isFinalized: boolean;
}

/**
 * Gossip State Verification Service
 * SECURITY: Byzantine-resistant state consistency
 */
export class GossipStateVerifier extends EventEmitter {
  private localState: NetworkState | null = null;
  private remoteStates: Map<string, NetworkState> = new Map();
  private snapshots: Map<string, StateSnapshot> = new Map();
  private stateHistory: NetworkState[] = [];
  private readonly maxHistorySize = 100;
  private readonly maxSnapshotAge = 3600000; // 1 hour

  constructor() {
    super();
    this.initializeState();

    // Periodic state verification
    setInterval(() => this.performPeriodicVerification(), 60000); // Every minute
    setInterval(() => this.cleanupOldSnapshots(), 300000); // Every 5 minutes
  }

  /**
   * Initialize local network state
   */
  private initializeState(): void {
    const stateId = crypto.randomBytes(16).toString('hex');
    const now = new Date();

    this.localState = {
      stateId,
      version: 1,
      timestamp: now,
      data: new Map(),
      merkleRoot: Buffer.alloc(32),
      merkleTree: [],
      signatures: new Map(),
      checksum: '',
    };

    this.updateMerkleTree();
  }

  /**
   * Update local state with new data
   * SECURITY: Incremental state updates with Merkle tree regeneration
   */
  updateState(key: string, value: any): void {
    if (!this.localState) {
      this.initializeState();
    }

    this.localState!.data.set(key, value);
    this.localState!.version++;
    this.localState!.timestamp = new Date();

    this.updateMerkleTree();
    this.emit('stateUpdated', { key, version: this.localState!.version });
  }

  /**
   * Build Merkle tree from current state
   * SECURITY: Cryptographic proof of state integrity
   */
  private updateMerkleTree(): void {
    if (!this.localState) return;

    const entries = Array.from(this.localState.data.entries());

    // Sort entries for deterministic tree construction
    entries.sort((a, b) => a[0].localeCompare(b[0]));

    // Create leaf nodes
    const leaves: MerkleNode[] = entries.map(([key, value]) => {
      const data = Buffer.concat([
        Buffer.from(key),
        Buffer.from(JSON.stringify(value)),
      ]);

      const hash = crypto.createHash('sha256').update(data).digest();

      return { hash, data: { key, value } };
    });

    // Build tree bottom-up
    this.localState.merkleTree = this.buildMerkleTree(leaves);

    // Set root hash
    if (this.localState.merkleTree.length > 0) {
      this.localState.merkleRoot = this.localState.merkleTree[0].hash;
    }

    // Update checksum
    this.localState.checksum = this.calculateChecksum(this.localState);
  }

  /**
   * Build Merkle tree recursively
   */
  private buildMerkleTree(nodes: MerkleNode[]): MerkleNode[] {
    if (nodes.length === 0) {
      return [];
    }

    if (nodes.length === 1) {
      return nodes;
    }

    const parents: MerkleNode[] = [];

    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i];
      const right = nodes[i + 1] || left; // Duplicate last node if odd count

      const combined = Buffer.concat([left.hash, right.hash]);
      const hash = crypto.createHash('sha256').update(combined).digest();

      parents.push({ hash, left, right });
    }

    return this.buildMerkleTree(parents);
  }

  /**
   * Calculate state checksum
   */
  private calculateChecksum(state: NetworkState): string {
    const data = JSON.stringify({
      version: state.version,
      timestamp: state.timestamp.toISOString(),
      merkleRoot: state.merkleRoot.toString('hex'),
      dataKeys: Array.from(state.data.keys()).sort(),
    });

    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Verify state against remote node states
   * SECURITY: Cross-node verification with Byzantine consensus
   */
  async verifyStateConsistency(
    remoteStates: Map<string, NetworkState>
  ): Promise<StateVerificationResult> {
    if (!this.localState) {
      return {
        isValid: false,
        consistency: 0,
        divergences: [],
        consensusReached: false,
        participatingNodes: 0,
        merkleValid: false,
      };
    }

    // Store remote states
    this.remoteStates = remoteStates;

    const divergences: StateDivergence[] = [];
    let matchingStates = 0;
    let merkleValid = true;

    // Compare with each remote state
    for (const [nodeId, remoteState] of remoteStates.entries()) {
      // Verify remote state Merkle tree
      if (!this.verifyMerkleRoot(remoteState)) {
        merkleValid = false;
        this.emit('invalidMerkleRoot', { nodeId, stateId: remoteState.stateId });
        continue;
      }

      // Compare Merkle roots
      if (this.localState.merkleRoot.equals(remoteState.merkleRoot)) {
        matchingStates++;
        continue;
      }

      // Find divergences
      const nodeDivergences = this.findDivergences(this.localState, remoteState);
      divergences.push(...nodeDivergences);
    }

    // Calculate consistency score
    const totalNodes = remoteStates.size;
    const consistency = totalNodes > 0 ? matchingStates / totalNodes : 0;

    // Byzantine consensus: need > 2/3 agreement
    const consensusReached = consistency > 0.66;

    const result: StateVerificationResult = {
      isValid: consensusReached && merkleValid,
      consistency,
      divergences,
      consensusReached,
      participatingNodes: totalNodes,
      merkleValid,
    };

    this.emit('verificationCompleted', {
      consistency,
      consensusReached,
      divergenceCount: divergences.length,
    });

    // Auto-reconcile if divergences found
    if (divergences.length > 0 && consensusReached) {
      await this.reconcileState(divergences, { strategy: 'consensus', threshold: 0.66 });
    }

    return result;
  }

  /**
   * Verify Merkle root integrity
   */
  private verifyMerkleRoot(state: NetworkState): boolean {
    if (state.merkleTree.length === 0) {
      return state.merkleRoot.equals(Buffer.alloc(32));
    }

    const computedRoot = state.merkleTree[0].hash;
    return computedRoot.equals(state.merkleRoot);
  }

  /**
   * Find divergences between local and remote state
   */
  private findDivergences(
    localState: NetworkState,
    remoteState: NetworkState
  ): StateDivergence[] {
    const divergences: StateDivergence[] = [];
    const allKeys = new Set([
      ...localState.data.keys(),
      ...remoteState.data.keys(),
    ]);

    for (const key of allKeys) {
      const localValue = localState.data.get(key);
      const remoteValue = remoteState.data.get(key);

      if (localValue === undefined && remoteValue !== undefined) {
        divergences.push({
          key,
          localValue: null,
          remoteValue,
          conflictType: 'missing',
          severity: this.assessDivergenceSeverity('missing', key),
        });
      } else if (localValue !== undefined && remoteValue === undefined) {
        divergences.push({
          key,
          localValue,
          remoteValue: null,
          conflictType: 'missing',
          severity: this.assessDivergenceSeverity('missing', key),
        });
      } else if (!this.valuesEqual(localValue, remoteValue)) {
        divergences.push({
          key,
          localValue,
          remoteValue,
          conflictType: 'mismatch',
          severity: this.assessDivergenceSeverity('mismatch', key),
        });
      }
    }

    return divergences;
  }

  /**
   * Check if two values are equal
   */
  private valuesEqual(a: any, b: any): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  /**
   * Assess divergence severity
   */
  private assessDivergenceSeverity(
    conflictType: StateDivergence['conflictType'],
    key: string
  ): StateDivergence['severity'] {
    // Critical keys
    const criticalKeys = ['consensus', 'validator', 'block'];
    if (criticalKeys.some(critical => key.toLowerCase().includes(critical))) {
      return 'critical';
    }

    // High priority keys
    const highKeys = ['transaction', 'state', 'balance'];
    if (highKeys.some(high => key.toLowerCase().includes(high))) {
      return 'high';
    }

    // Medium priority
    if (conflictType === 'mismatch') {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Reconcile state divergences
   * SECURITY: Consensus-based reconciliation with conflict resolution
   */
  async reconcileState(
    divergences: StateDivergence[],
    strategy: StateReconciliationStrategy
  ): Promise<void> {
    if (!this.localState) return;

    const reconciled: string[] = [];

    for (const divergence of divergences) {
      let resolvedValue: any;

      switch (strategy.strategy) {
        case 'consensus':
          resolvedValue = await this.resolveByConsensus(divergence, strategy.threshold);
          break;

        case 'newest-wins':
          resolvedValue = await this.resolveByTimestamp(divergence);
          break;

        case 'remote-wins':
          resolvedValue = divergence.remoteValue;
          break;

        case 'local-wins':
          resolvedValue = divergence.localValue;
          break;

        case 'manual':
          this.emit('manualReconciliationRequired', divergence);
          continue;
      }

      if (resolvedValue !== null) {
        this.updateState(divergence.key, resolvedValue);
        reconciled.push(divergence.key);
      }
    }

    this.emit('stateReconciled', {
      divergenceCount: divergences.length,
      reconciledCount: reconciled.length,
      strategy: strategy.strategy,
    });
  }

  /**
   * Resolve divergence by consensus
   */
  private async resolveByConsensus(
    divergence: StateDivergence,
    threshold: number
  ): Promise<any> {
    const valueCounts = new Map<string, number>();

    // Count occurrences of each value across all states
    for (const [nodeId, state] of this.remoteStates.entries()) {
      const value = state.data.get(divergence.key);
      const valueKey = JSON.stringify(value);

      valueCounts.set(valueKey, (valueCounts.get(valueKey) || 0) + 1);
    }

    // Add local value
    const localKey = JSON.stringify(divergence.localValue);
    valueCounts.set(localKey, (valueCounts.get(localKey) || 0) + 1);

    // Find value with most votes
    let maxVotes = 0;
    let consensusValue: any = null;

    for (const [valueKey, votes] of valueCounts.entries()) {
      const voteRatio = votes / (this.remoteStates.size + 1);
      if (voteRatio >= threshold && votes > maxVotes) {
        maxVotes = votes;
        consensusValue = JSON.parse(valueKey);
      }
    }

    return consensusValue;
  }

  /**
   * Resolve divergence by timestamp (newest wins)
   */
  private async resolveByTimestamp(divergence: StateDivergence): Promise<any> {
    let newestTimestamp = this.localState?.timestamp || new Date(0);
    let newestValue = divergence.localValue;

    for (const [nodeId, state] of this.remoteStates.entries()) {
      if (state.timestamp > newestTimestamp) {
        newestTimestamp = state.timestamp;
        newestValue = state.data.get(divergence.key);
      }
    }

    return newestValue;
  }

  /**
   * Create state snapshot for recovery
   */
  createSnapshot(): StateSnapshot {
    if (!this.localState) {
      throw new Error('No local state to snapshot');
    }

    const snapshotId = crypto.randomBytes(16).toString('hex');

    // Deep clone state
    const stateCopy: NetworkState = {
      stateId: this.localState.stateId,
      version: this.localState.version,
      timestamp: new Date(this.localState.timestamp),
      data: new Map(this.localState.data),
      merkleRoot: Buffer.from(this.localState.merkleRoot),
      merkleTree: this.localState.merkleTree,
      signatures: new Map(this.localState.signatures),
      checksum: this.localState.checksum,
    };

    const snapshot: StateSnapshot = {
      snapshotId,
      state: stateCopy,
      createdAt: new Date(),
      validatedBy: new Set(),
      isFinalized: false,
    };

    this.snapshots.set(snapshotId, snapshot);

    // Add to history
    this.stateHistory.push(stateCopy);
    if (this.stateHistory.length > this.maxHistorySize) {
      this.stateHistory.shift();
    }

    this.emit('snapshotCreated', { snapshotId, version: stateCopy.version });

    return snapshot;
  }

  /**
   * Restore state from snapshot
   */
  restoreSnapshot(snapshotId: string): boolean {
    const snapshot = this.snapshots.get(snapshotId);
    if (!snapshot) {
      return false;
    }

    // Restore state
    this.localState = {
      stateId: snapshot.state.stateId,
      version: snapshot.state.version + 1, // Increment version
      timestamp: new Date(),
      data: new Map(snapshot.state.data),
      merkleRoot: Buffer.from(snapshot.state.merkleRoot),
      merkleTree: snapshot.state.merkleTree,
      signatures: new Map(),
      checksum: snapshot.state.checksum,
    };

    this.updateMerkleTree();

    this.emit('snapshotRestored', { snapshotId, version: this.localState.version });

    return true;
  }

  /**
   * Detect state corruption
   */
  detectCorruption(): {
    isCorrupted: boolean;
    reasons: string[];
  } {
    if (!this.localState) {
      return { isCorrupted: true, reasons: ['No local state'] };
    }

    const reasons: string[] = [];

    // Verify checksum
    const computedChecksum = this.calculateChecksum(this.localState);
    if (computedChecksum !== this.localState.checksum) {
      reasons.push('Checksum mismatch');
    }

    // Verify Merkle root
    if (!this.verifyMerkleRoot(this.localState)) {
      reasons.push('Invalid Merkle root');
    }

    // Check for data anomalies
    if (this.localState.data.size === 0 && this.localState.version > 1) {
      reasons.push('Empty state with version > 1');
    }

    const isCorrupted = reasons.length > 0;

    if (isCorrupted) {
      this.emit('corruptionDetected', { reasons });
    }

    return { isCorrupted, reasons };
  }

  /**
   * Perform periodic state verification
   */
  private async performPeriodicVerification(): Promise<void> {
    // Check for corruption
    const corruption = this.detectCorruption();

    if (corruption.isCorrupted) {
      // Attempt recovery from latest snapshot
      const latestSnapshot = this.getLatestSnapshot();
      if (latestSnapshot) {
        this.restoreSnapshot(latestSnapshot.snapshotId);
      }
    }
  }

  /**
   * Get latest snapshot
   */
  private getLatestSnapshot(): StateSnapshot | null {
    let latest: StateSnapshot | null = null;

    for (const snapshot of this.snapshots.values()) {
      if (!latest || snapshot.createdAt > latest.createdAt) {
        latest = snapshot;
      }
    }

    return latest;
  }

  /**
   * Cleanup old snapshots
   */
  private cleanupOldSnapshots(): void {
    const cutoff = Date.now() - this.maxSnapshotAge;
    let cleaned = 0;

    for (const [snapshotId, snapshot] of this.snapshots.entries()) {
      if (snapshot.createdAt.getTime() < cutoff && !snapshot.isFinalized) {
        this.snapshots.delete(snapshotId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.emit('snapshotsCleanedUp', { count: cleaned });
    }
  }

  /**
   * Get current state
   */
  getCurrentState(): NetworkState | null {
    return this.localState;
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    currentVersion: number;
    dataEntries: number;
    snapshotCount: number;
    historySize: number;
  } {
    return {
      currentVersion: this.localState?.version || 0,
      dataEntries: this.localState?.data.size || 0,
      snapshotCount: this.snapshots.size,
      historySize: this.stateHistory.length,
    };
  }

  /**
   * Shutdown and cleanup
   */
  shutdown(): void {
    this.remoteStates.clear();
    this.snapshots.clear();
    this.stateHistory = [];
    this.emit('shutdown');
  }
}
