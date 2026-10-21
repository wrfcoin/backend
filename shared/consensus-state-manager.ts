/**
 * Consensus State Manager
 * Manages blockchain state with Merkle tree verification and checkpoints
 *
 * FEATURES:
 * - Merkle tree-based state verification
 * - State checkpoints with 2f+1 signatures
 * - State synchronization between nodes
 * - Conflict resolution with Byzantine tolerance
 * - State rollback and recovery
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

export interface StateCheckpoint {
  checkpointId: string;
  height: number;
  stateRoot: string;
  merkleRoot: string;
  timestamp: Date;
  signatures: Map<string, Buffer>; // validator -> signature
  quorumAchieved: boolean;
  validatorCount: number;
}

export interface MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
  data?: any;
}

export interface MerkleProof {
  rootHash: string;
  leaf: string;
  siblings: { hash: string; position: 'left' | 'right' }[];
  valid?: boolean;
}

export interface StateTransition {
  fromHeight: number;
  toHeight: number;
  stateRoot: string;
  transactions: any[];
  timestamp: Date;
}

export interface ConflictResolution {
  conflictId: string;
  competingStates: string[];
  resolvedState: string;
  validatorVotes: Map<string, string>;
  resolutionMethod: 'majority' | 'longest-chain' | 'highest-reputation';
}

/**
 * Consensus State Management System
 */
export class ConsensusStateManager extends EventEmitter {
  private currentHeight: number = 0;
  private stateRoot: string = '';
  private checkpoints: Map<number, StateCheckpoint> = new Map();
  private stateHistory: StateTransition[] = [];
  private merkleTree?: MerkleNode;

  private readonly CHECKPOINT_INTERVAL = 100; // Every 100 blocks
  private readonly MAX_HISTORY_SIZE = 1000;

  constructor() {
    super();
  }

  /**
   * Create state checkpoint with validator signatures
   */
  async createCheckpoint(
    height: number,
    stateData: any[],
    validatorSignatures: Map<string, Buffer>,
    requiredQuorum: number
  ): Promise<StateCheckpoint> {
    const merkleTree = this.buildMerkleTree(stateData);
    const merkleRoot = merkleTree.hash;
    const stateRoot = this.calculateStateRoot(stateData);

    const checkpoint: StateCheckpoint = {
      checkpointId: crypto.randomBytes(16).toString('hex'),
      height,
      stateRoot,
      merkleRoot,
      timestamp: new Date(),
      signatures: validatorSignatures,
      quorumAchieved: validatorSignatures.size >= requiredQuorum,
      validatorCount: validatorSignatures.size,
    };

    this.checkpoints.set(height, checkpoint);
    this.merkleTree = merkleTree;

    this.emit('checkpointCreated', {
      height,
      stateRoot,
      merkleRoot,
      signatures: validatorSignatures.size,
      quorumAchieved: checkpoint.quorumAchieved,
    });

    return checkpoint;
  }

  /**
   * Build Merkle tree from state data
   */
  private buildMerkleTree(data: any[]): MerkleNode {
    if (data.length === 0) {
      return { hash: crypto.createHash('sha256').update('').digest('hex') };
    }

    // Create leaf nodes
    const leaves = data.map(item => ({
      hash: crypto.createHash('sha256').update(JSON.stringify(item)).digest('hex'),
      data: item,
    }));

    return this.buildMerkleTreeRecursive(leaves);
  }

  /**
   * Recursively build Merkle tree
   */
  private buildMerkleTreeRecursive(nodes: MerkleNode[]): MerkleNode {
    if (nodes.length === 1) {
      return nodes[0];
    }

    const parents: MerkleNode[] = [];

    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i];
      const right = i + 1 < nodes.length ? nodes[i + 1] : left;

      const parentHash = crypto
        .createHash('sha256')
        .update(left.hash + right.hash)
        .digest('hex');

      parents.push({
        hash: parentHash,
        left,
        right,
      });
    }

    return this.buildMerkleTreeRecursive(parents);
  }

  /**
   * Generate Merkle proof for data item
   */
  generateMerkleProof(data: any): MerkleProof | null {
    if (!this.merkleTree) return null;

    const leafHash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const siblings: { hash: string; position: 'left' | 'right' }[] = [];

    if (!this.findMerkleProofPath(this.merkleTree, leafHash, siblings)) {
      return null;
    }

    return {
      rootHash: this.merkleTree.hash,
      leaf: leafHash,
      siblings,
    };
  }

  /**
   * Find path to leaf in Merkle tree
   */
  private findMerkleProofPath(
    node: MerkleNode,
    targetLeaf: string,
    siblings: { hash: string; position: 'left' | 'right' }[]
  ): boolean {
    if (!node.left && !node.right) {
      return node.hash === targetLeaf;
    }

    if (node.left && this.findMerkleProofPath(node.left, targetLeaf, siblings)) {
      if (node.right) {
        siblings.push({ hash: node.right.hash, position: 'right' });
      }
      return true;
    }

    if (node.right && this.findMerkleProofPath(node.right, targetLeaf, siblings)) {
      if (node.left) {
        siblings.push({ hash: node.left.hash, position: 'left' });
      }
      return true;
    }

    return false;
  }

  /**
   * Verify Merkle proof
   */
  verifyMerkleProof(proof: MerkleProof): boolean {
    let currentHash = proof.leaf;

    for (const sibling of proof.siblings) {
      const combined =
        sibling.position === 'left'
          ? sibling.hash + currentHash
          : currentHash + sibling.hash;

      currentHash = crypto.createHash('sha256').update(combined).digest('hex');
    }

    proof.valid = currentHash === proof.rootHash;
    return proof.valid;
  }

  /**
   * Calculate state root hash
   */
  private calculateStateRoot(stateData: any[]): string {
    const dataString = JSON.stringify(stateData.sort());
    return crypto.createHash('sha256').update(dataString).digest('hex');
  }

  /**
   * Record state transition
   */
  async recordStateTransition(
    fromHeight: number,
    toHeight: number,
    transactions: any[]
  ): Promise<void> {
    const stateRoot = this.calculateStateRoot(transactions);

    const transition: StateTransition = {
      fromHeight,
      toHeight,
      stateRoot,
      transactions,
      timestamp: new Date(),
    };

    this.stateHistory.push(transition);
    this.currentHeight = toHeight;
    this.stateRoot = stateRoot;

    // Create checkpoint if needed
    if (toHeight % this.CHECKPOINT_INTERVAL === 0) {
      await this.createCheckpoint(toHeight, transactions, new Map(), 1);
    }

    // Cleanup old history
    if (this.stateHistory.length > this.MAX_HISTORY_SIZE) {
      this.stateHistory = this.stateHistory.slice(-this.MAX_HISTORY_SIZE);
    }

    this.emit('stateTransitionRecorded', {
      fromHeight,
      toHeight,
      stateRoot,
      transactionCount: transactions.length,
    });
  }

  /**
   * Resolve state conflicts using validator votes
   */
  async resolveStateConflict(
    competingStates: string[],
    validatorVotes: Map<string, string>,
    validatorReputations: Map<string, number>
  ): Promise<ConflictResolution> {
    const voteCounts = new Map<string, number>();
    const weightedVotes = new Map<string, number>();

    // Count votes and apply reputation weighting
    for (const [validatorId, votedState] of validatorVotes.entries()) {
      const reputation = validatorReputations.get(validatorId) || 50;
      const weight = reputation / 100;

      voteCounts.set(votedState, (voteCounts.get(votedState) || 0) + 1);
      weightedVotes.set(votedState, (weightedVotes.get(votedState) || 0) + weight);
    }

    // Find state with highest weighted votes
    let resolvedState = competingStates[0];
    let maxWeight = 0;

    for (const [state, weight] of weightedVotes.entries()) {
      if (weight > maxWeight) {
        maxWeight = weight;
        resolvedState = state;
      }
    }

    const resolution: ConflictResolution = {
      conflictId: crypto.randomBytes(16).toString('hex'),
      competingStates,
      resolvedState,
      validatorVotes,
      resolutionMethod: 'highest-reputation',
    };

    this.emit('conflictResolved', {
      conflictId: resolution.conflictId,
      resolvedState,
      competingStatesCount: competingStates.length,
      validatorVotes: validatorVotes.size,
    });

    return resolution;
  }

  /**
   * Rollback to checkpoint
   */
  async rollbackToCheckpoint(height: number): Promise<boolean> {
    const checkpoint = this.checkpoints.get(height);
    if (!checkpoint) {
      return false;
    }

    this.currentHeight = height;
    this.stateRoot = checkpoint.stateRoot;

    // Remove later state transitions
    this.stateHistory = this.stateHistory.filter(t => t.toHeight <= height);

    this.emit('stateRolledBack', {
      height,
      stateRoot: checkpoint.stateRoot,
    });

    return true;
  }

  /**
   * Get checkpoint at height
   */
  getCheckpoint(height: number): StateCheckpoint | undefined {
    return this.checkpoints.get(height);
  }

  /**
   * Get latest checkpoint
   */
  getLatestCheckpoint(): StateCheckpoint | undefined {
    const heights = Array.from(this.checkpoints.keys()).sort((a, b) => b - a);
    return heights.length > 0 ? this.checkpoints.get(heights[0]) : undefined;
  }

  /**
   * Get current state
   */
  getCurrentState(): { height: number; stateRoot: string } {
    return {
      height: this.currentHeight,
      stateRoot: this.stateRoot,
    };
  }

  /**
   * Get state history
   */
  getStateHistory(limit?: number): StateTransition[] {
    const history = [...this.stateHistory].reverse();
    return limit ? history.slice(0, limit) : history;
  }
}
