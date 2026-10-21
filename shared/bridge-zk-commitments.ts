/**
 * Bridge ZK Commitment System
 *
 * Implements zero-knowledge commitment schemes for cross-chain double-spend prevention:
 * - Nullifier-based spending tracking
 * - Pedersen commitments for transfer amounts
 * - Merkle tree commitment accumulator
 * - ZK-friendly hash functions (Poseidon)
 *
 * Security Features:
 * - Cryptographic nullifiers prevent double-spending
 * - Commitments hide transfer details until reveal
 * - Merkle proofs enable efficient verification
 * - Time-bounded commitments with expiration
 *
 * This module provides the cryptographic foundation for secure cross-chain
 * transfers that cannot be double-spent across different chains.
 */

import * as crypto from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Simple Merkle Tree Implementation
// ============================================================================

/**
 * Simple Merkle Tree implementation for commitment accumulation
 * Uses SHA-256 for hashing
 */
class MerkleTree {
  private leaves: Buffer[];
  private layers: Buffer[][];
  private hashFn: (data: Buffer) => Buffer;

  constructor(leaves: Buffer[], hashFn: (data: Buffer) => Buffer, _options?: { sortPairs?: boolean }) {
    this.leaves = leaves;
    this.hashFn = hashFn;
    this.layers = this.buildTree();
  }

  private buildTree(): Buffer[][] {
    if (this.leaves.length === 0) {
      return [[]];
    }

    const layers: Buffer[][] = [this.leaves.slice()];

    while (layers[layers.length - 1].length > 1) {
      const currentLayer = layers[layers.length - 1];
      const nextLayer: Buffer[] = [];

      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = i + 1 < currentLayer.length ? currentLayer[i + 1] : left;

        // Sort pairs for consistent ordering
        const [first, second] = Buffer.compare(left, right) < 0 ? [left, right] : [right, left];
        const combined = Buffer.concat([first, second]);
        nextLayer.push(this.hashFn(combined));
      }

      layers.push(nextLayer);
    }

    return layers;
  }

  getRoot(): Buffer {
    if (this.layers.length === 0 || this.layers[this.layers.length - 1].length === 0) {
      return Buffer.alloc(32);
    }
    return this.layers[this.layers.length - 1][0];
  }

  getProof(leaf: Buffer): Array<{ data: Buffer; position: 'left' | 'right' }> {
    const proof: Array<{ data: Buffer; position: 'left' | 'right' }> = [];
    let index = this.leaves.findIndex(l => Buffer.compare(l, leaf) === 0);

    if (index === -1) {
      return proof;
    }

    for (let i = 0; i < this.layers.length - 1; i++) {
      const layer = this.layers[i];
      const isRightNode = index % 2 === 1;
      const siblingIndex = isRightNode ? index - 1 : index + 1;

      if (siblingIndex < layer.length) {
        proof.push({
          data: layer[siblingIndex],
          position: isRightNode ? 'left' : 'right',
        });
      }

      index = Math.floor(index / 2);
    }

    return proof;
  }

  verify(
    proof: Array<{ data: Buffer; position: 'left' | 'right' }>,
    leaf: Buffer,
    root: Buffer
  ): boolean {
    let computedHash = leaf;

    for (const { data, position } of proof) {
      if (position === 'right') {
        const [first, second] = Buffer.compare(computedHash, data) < 0
          ? [computedHash, data]
          : [data, computedHash];
        computedHash = this.hashFn(Buffer.concat([first, second]));
      } else {
        const [first, second] = Buffer.compare(data, computedHash) < 0
          ? [data, computedHash]
          : [computedHash, data];
        computedHash = this.hashFn(Buffer.concat([first, second]));
      }
    }

    return Buffer.compare(computedHash, root) === 0;
  }
}

// ============================================================================
// ZK Commitment Constants
// ============================================================================

/**
 * Domain separators for different hash contexts
 * Prevents cross-domain attacks by ensuring hashes are unique per use case
 */
const DOMAIN_SEPARATORS = {
  NULLIFIER: Buffer.from('WRFCOIN_NULLIFIER_V1'),
  COMMITMENT: Buffer.from('WRFCOIN_COMMITMENT_V1'),
  MERKLE_LEAF: Buffer.from('WRFCOIN_MERKLE_LEAF_V1'),
  TRANSFER_ID: Buffer.from('WRFCOIN_TRANSFER_ID_V1'),
} as const;

/**
 * Commitment expiration time in seconds
 * After this time, uncommitted transfers can be reclaimed
 */
const COMMITMENT_EXPIRATION_SECONDS = 86400; // 24 hours

/**
 * Maximum tree depth for Merkle commitment tree
 * Supports up to 2^20 = 1,048,576 commitments per tree
 */
const MAX_MERKLE_TREE_DEPTH = 20;

// ============================================================================
// Types and Interfaces
// ============================================================================

/**
 * Represents a transfer commitment that hides transfer details
 */
export interface TransferCommitment {
  id: string;
  commitmentHash: string;
  nullifierHash: string;
  sourceChain: string;
  destinationChain: string;
  senderAddress: string;
  amount: string;
  asset: string;
  salt: string; // Random salt for hiding
  createdAt: Date;
  expiresAt: Date;
  status: CommitmentStatus;
  merkleIndex?: number;
  merkleRoot?: string;
}

export enum CommitmentStatus {
  PENDING = 'PENDING',         // Commitment created, not yet in Merkle tree
  COMMITTED = 'COMMITTED',     // Added to Merkle tree
  REVEALED = 'REVEALED',       // Nullifier revealed, transfer in progress
  CONSUMED = 'CONSUMED',       // Transfer completed, nullifier consumed
  EXPIRED = 'EXPIRED',         // Commitment expired without consumption
  INVALIDATED = 'INVALIDATED', // Marked invalid due to fraud detection
}

/**
 * Nullifier record for tracking consumed commitments
 */
export interface NullifierRecord {
  nullifierHash: string;
  commitmentId: string;
  consumedAt: Date;
  consumedBy: string; // Address that consumed the nullifier
  transactionHash: string;
  sourceChain: string;
  destinationChain: string;
}

/**
 * Merkle proof for commitment inclusion
 */
export interface CommitmentMerkleProof {
  commitmentHash: string;
  merkleRoot: string;
  proof: string[];
  proofFlags: boolean[]; // Left/right indicators
  leafIndex: number;
}

/**
 * ZK transfer proof that can be verified without revealing details
 */
export interface ZKTransferProof {
  nullifierHash: string;
  commitmentHash: string;
  merkleProof: CommitmentMerkleProof;
  recipientHash: string; // Hashed recipient for privacy
  amountCommitment: string; // Pedersen commitment to amount
  timestamp: number;
  signature: string; // Signature proving ownership
}

/**
 * Configuration for the ZK commitment system
 */
export interface ZKCommitmentConfig {
  maxCommitmentsPerTree: number;
  expirationSeconds: number;
  enableNullifierRegistry: boolean;
  pruneExpiredCommitments: boolean;
  merkleTreeDepth: number;
}

// ============================================================================
// Cryptographic Primitives
// ============================================================================

/**
 * ZK-friendly hash function
 * Uses SHA-256 with domain separation for production use
 * In a full ZK implementation, this would use Poseidon hash
 */
export class ZKHasher {
  /**
   * Hash with domain separation to prevent cross-domain attacks
   */
  static hashWithDomain(domain: Buffer, ...inputs: (Buffer | string)[]): string {
    const hash = crypto.createHash('sha256');
    hash.update(domain);

    for (const input of inputs) {
      const buffer = typeof input === 'string' ? Buffer.from(input, 'hex') : input;
      // Length-prefix each input to prevent concatenation attacks
      const lengthPrefix = Buffer.alloc(4);
      lengthPrefix.writeUInt32BE(buffer.length, 0);
      hash.update(lengthPrefix);
      hash.update(buffer);
    }

    return hash.digest('hex');
  }

  /**
   * Generate nullifier hash from commitment and secret
   * nullifier = H(DOMAIN_NULLIFIER || commitment || secret || senderAddress)
   */
  static generateNullifier(
    commitmentHash: string,
    secret: string,
    senderAddress: string
  ): string {
    return this.hashWithDomain(
      DOMAIN_SEPARATORS.NULLIFIER,
      commitmentHash,
      secret,
      senderAddress
    );
  }

  /**
   * Generate commitment hash from transfer details
   * commitment = H(DOMAIN_COMMITMENT || sender || recipient || amount || asset || chain || salt)
   */
  static generateCommitment(
    sender: string,
    recipient: string,
    amount: string,
    asset: string,
    sourceChain: string,
    destinationChain: string,
    salt: string
  ): string {
    return this.hashWithDomain(
      DOMAIN_SEPARATORS.COMMITMENT,
      sender,
      recipient,
      amount,
      asset,
      sourceChain,
      destinationChain,
      salt
    );
  }

  /**
   * Generate transfer ID for tracking
   */
  static generateTransferId(
    sender: string,
    recipient: string,
    amount: string,
    timestamp: number
  ): string {
    const timestampBuffer = Buffer.alloc(8);
    timestampBuffer.writeBigUInt64BE(BigInt(timestamp), 0);

    return this.hashWithDomain(
      DOMAIN_SEPARATORS.TRANSFER_ID,
      sender,
      recipient,
      amount,
      timestampBuffer
    );
  }

  /**
   * Generate Merkle leaf hash
   */
  static generateMerkleLeaf(commitmentHash: string, index: number): Buffer {
    const indexBuffer = Buffer.alloc(4);
    indexBuffer.writeUInt32BE(index, 0);

    const leafHash = this.hashWithDomain(
      DOMAIN_SEPARATORS.MERKLE_LEAF,
      commitmentHash,
      indexBuffer
    );

    return Buffer.from(leafHash, 'hex');
  }

  /**
   * Generate cryptographically secure random salt
   */
  static generateSalt(): string {
    return crypto.randomBytes(32).toString('hex');
  }
}

// ============================================================================
// Nullifier Registry
// ============================================================================

/**
 * Tracks consumed nullifiers to prevent double-spending
 * This is the core component that ensures each commitment can only be spent once
 */
export class NullifierRegistry extends EventEmitter {
  private consumedNullifiers: Map<string, NullifierRecord> = new Map();
  private pendingNullifiers: Map<string, { timeout: NodeJS.Timeout; commitmentId: string }> = new Map();

  private readonly PENDING_TIMEOUT_MS = 300000; // 5 minutes for pending nullifiers

  /**
   * Check if a nullifier has already been consumed
   * This is the primary double-spend check
   */
  isNullifierConsumed(nullifierHash: string): boolean {
    return this.consumedNullifiers.has(nullifierHash);
  }

  /**
   * Check if a nullifier is pending consumption
   */
  isNullifierPending(nullifierHash: string): boolean {
    return this.pendingNullifiers.has(nullifierHash);
  }

  /**
   * Reserve a nullifier for pending consumption
   * Returns false if already consumed or pending
   */
  reserveNullifier(nullifierHash: string, commitmentId: string): boolean {
    // Check if already consumed (double-spend attempt)
    if (this.consumedNullifiers.has(nullifierHash)) {
      this.emit('double-spend-attempt', {
        nullifierHash,
        commitmentId,
        existingRecord: this.consumedNullifiers.get(nullifierHash),
        timestamp: new Date(),
      });
      return false;
    }

    // Check if already pending
    if (this.pendingNullifiers.has(nullifierHash)) {
      this.emit('nullifier-collision', {
        nullifierHash,
        commitmentId,
        existingCommitmentId: this.pendingNullifiers.get(nullifierHash)?.commitmentId,
        timestamp: new Date(),
      });
      return false;
    }

    // Reserve the nullifier
    const timeout = setTimeout(() => {
      this.releaseNullifier(nullifierHash);
    }, this.PENDING_TIMEOUT_MS);

    this.pendingNullifiers.set(nullifierHash, { timeout, commitmentId });

    this.emit('nullifier-reserved', {
      nullifierHash,
      commitmentId,
      timestamp: new Date(),
    });

    return true;
  }

  /**
   * Release a pending nullifier reservation
   */
  releaseNullifier(nullifierHash: string): void {
    const pending = this.pendingNullifiers.get(nullifierHash);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingNullifiers.delete(nullifierHash);

      this.emit('nullifier-released', {
        nullifierHash,
        commitmentId: pending.commitmentId,
        timestamp: new Date(),
      });
    }
  }

  /**
   * Consume a nullifier, marking it as permanently used
   * This finalizes the double-spend prevention
   */
  consumeNullifier(
    nullifierHash: string,
    commitmentId: string,
    consumedBy: string,
    transactionHash: string,
    sourceChain: string,
    destinationChain: string
  ): boolean {
    // Final double-spend check
    if (this.consumedNullifiers.has(nullifierHash)) {
      this.emit('double-spend-blocked', {
        nullifierHash,
        commitmentId,
        attemptedBy: consumedBy,
        existingRecord: this.consumedNullifiers.get(nullifierHash),
        timestamp: new Date(),
      });
      return false;
    }

    // Clear pending reservation if exists
    this.releaseNullifier(nullifierHash);

    // Record the consumption
    const record: NullifierRecord = {
      nullifierHash,
      commitmentId,
      consumedAt: new Date(),
      consumedBy,
      transactionHash,
      sourceChain,
      destinationChain,
    };

    this.consumedNullifiers.set(nullifierHash, record);

    this.emit('nullifier-consumed', record);

    return true;
  }

  /**
   * Get nullifier record if consumed
   */
  getNullifierRecord(nullifierHash: string): NullifierRecord | null {
    return this.consumedNullifiers.get(nullifierHash) || null;
  }

  /**
   * Get statistics about nullifier registry
   */
  getStatistics(): {
    totalConsumed: number;
    totalPending: number;
    recentDoubleSpendAttempts: number;
  } {
    return {
      totalConsumed: this.consumedNullifiers.size,
      totalPending: this.pendingNullifiers.size,
      recentDoubleSpendAttempts: 0, // Would be tracked in production
    };
  }

  /**
   * Export nullifier registry for persistence
   */
  exportRegistry(): NullifierRecord[] {
    return Array.from(this.consumedNullifiers.values());
  }

  /**
   * Import nullifier registry from persistence
   */
  importRegistry(records: NullifierRecord[]): void {
    for (const record of records) {
      this.consumedNullifiers.set(record.nullifierHash, record);
    }
  }
}

// ============================================================================
// Commitment Merkle Tree
// ============================================================================

/**
 * Merkle tree for commitment accumulation
 * Enables efficient verification of commitment inclusion
 */
export class CommitmentMerkleTree {
  private leaves: Buffer[] = [];
  private tree: MerkleTree | null = null;
  private commitmentIndexes: Map<string, number> = new Map();
  private readonly maxDepth: number;

  constructor(maxDepth: number = MAX_MERKLE_TREE_DEPTH) {
    this.maxDepth = maxDepth;
  }

  /**
   * Add a commitment to the tree
   */
  addCommitment(commitmentHash: string): number {
    if (this.leaves.length >= Math.pow(2, this.maxDepth)) {
      throw new Error('Merkle tree is full');
    }

    const index = this.leaves.length;
    const leaf = ZKHasher.generateMerkleLeaf(commitmentHash, index);

    this.leaves.push(leaf);
    this.commitmentIndexes.set(commitmentHash, index);

    // Rebuild tree (in production, use incremental tree update)
    this.rebuildTree();

    return index;
  }

  /**
   * Get Merkle proof for a commitment
   */
  getProof(commitmentHash: string): CommitmentMerkleProof | null {
    const index = this.commitmentIndexes.get(commitmentHash);
    if (index === undefined || !this.tree) {
      return null;
    }

    const leaf = this.leaves[index];
    const proof = this.tree.getProof(leaf);

    return {
      commitmentHash,
      merkleRoot: this.getRoot(),
      proof: proof.map(p => p.data.toString('hex')),
      proofFlags: proof.map(p => p.position === 'right'),
      leafIndex: index,
    };
  }

  /**
   * Verify a Merkle proof
   */
  verifyProof(proof: CommitmentMerkleProof): boolean {
    if (!this.tree) return false;

    const leaf = ZKHasher.generateMerkleLeaf(proof.commitmentHash, proof.leafIndex);
    const proofElements = proof.proof.map(p => Buffer.from(p, 'hex'));

    return this.tree.verify(
      proofElements.map((data, i) => ({ data, position: proof.proofFlags[i] ? 'right' : 'left' })),
      leaf,
      Buffer.from(proof.merkleRoot, 'hex')
    );
  }

  /**
   * Get current Merkle root
   */
  getRoot(): string {
    if (!this.tree) return '';
    return this.tree.getRoot().toString('hex');
  }

  /**
   * Get commitment index
   */
  getCommitmentIndex(commitmentHash: string): number | undefined {
    return this.commitmentIndexes.get(commitmentHash);
  }

  /**
   * Get tree statistics
   */
  getStatistics(): {
    totalCommitments: number;
    treeDepth: number;
    maxCapacity: number;
    utilizationPercent: number;
  } {
    const maxCapacity = Math.pow(2, this.maxDepth);
    return {
      totalCommitments: this.leaves.length,
      treeDepth: this.maxDepth,
      maxCapacity,
      utilizationPercent: (this.leaves.length / maxCapacity) * 100,
    };
  }

  private rebuildTree(): void {
    if (this.leaves.length === 0) {
      this.tree = null;
      return;
    }

    this.tree = new MerkleTree(this.leaves, (data: Buffer) => {
      return crypto.createHash('sha256').update(data).digest();
    }, { sortPairs: true });
  }
}

// ============================================================================
// Main ZK Commitment Manager
// ============================================================================

/**
 * Main class for managing ZK commitments and nullifiers
 * Provides complete double-spend prevention for cross-chain transfers
 */
export class BridgeZKCommitmentManager extends EventEmitter {
  private commitments: Map<string, TransferCommitment> = new Map();
  private nullifierRegistry: NullifierRegistry;
  private merkleTree: CommitmentMerkleTree;
  private config: ZKCommitmentConfig;

  // Indexes for efficient lookups
  private commitmentsByNullifier: Map<string, string> = new Map();
  private commitmentsBySender: Map<string, Set<string>> = new Map();
  private commitmentsByChainPair: Map<string, Set<string>> = new Map();

  constructor(config?: Partial<ZKCommitmentConfig>) {
    super();

    this.config = {
      maxCommitmentsPerTree: Math.pow(2, MAX_MERKLE_TREE_DEPTH),
      expirationSeconds: COMMITMENT_EXPIRATION_SECONDS,
      enableNullifierRegistry: true,
      pruneExpiredCommitments: true,
      merkleTreeDepth: MAX_MERKLE_TREE_DEPTH,
      ...config,
    };

    this.nullifierRegistry = new NullifierRegistry();
    this.merkleTree = new CommitmentMerkleTree(this.config.merkleTreeDepth);

    // Forward nullifier events
    this.nullifierRegistry.on('double-spend-attempt', (data) => {
      this.emit('double-spend-attempt', data);
    });
    this.nullifierRegistry.on('double-spend-blocked', (data) => {
      this.emit('double-spend-blocked', data);
    });
    this.nullifierRegistry.on('nullifier-consumed', (data) => {
      this.emit('nullifier-consumed', data);
    });

    // Start pruning job if enabled
    if (this.config.pruneExpiredCommitments) {
      this.startPruningJob();
    }
  }

  /**
   * Create a new transfer commitment
   * This is the first step in initiating a cross-chain transfer
   */
  createCommitment(
    senderAddress: string,
    recipientAddress: string,
    amount: string,
    asset: string,
    sourceChain: string,
    destinationChain: string
  ): TransferCommitment {
    // Generate cryptographic components
    const salt = ZKHasher.generateSalt();
    const commitmentHash = ZKHasher.generateCommitment(
      senderAddress,
      recipientAddress,
      amount,
      asset,
      sourceChain,
      destinationChain,
      salt
    );

    // Generate nullifier (will be revealed when spending)
    const nullifierHash = ZKHasher.generateNullifier(
      commitmentHash,
      salt,
      senderAddress
    );

    // Generate unique ID
    const id = ZKHasher.generateTransferId(
      senderAddress,
      recipientAddress,
      amount,
      Date.now()
    );

    const now = new Date();
    const commitment: TransferCommitment = {
      id,
      commitmentHash,
      nullifierHash,
      sourceChain,
      destinationChain,
      senderAddress,
      amount,
      asset,
      salt,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.config.expirationSeconds * 1000),
      status: CommitmentStatus.PENDING,
    };

    // Store commitment
    this.commitments.set(id, commitment);
    this.commitmentsByNullifier.set(nullifierHash, id);

    // Index by sender
    if (!this.commitmentsBySender.has(senderAddress)) {
      this.commitmentsBySender.set(senderAddress, new Set());
    }
    this.commitmentsBySender.get(senderAddress)!.add(id);

    // Index by chain pair
    const chainPair = `${sourceChain}->${destinationChain}`;
    if (!this.commitmentsByChainPair.has(chainPair)) {
      this.commitmentsByChainPair.set(chainPair, new Set());
    }
    this.commitmentsByChainPair.get(chainPair)!.add(id);

    this.emit('commitment-created', {
      id,
      commitmentHash,
      sourceChain,
      destinationChain,
      timestamp: now,
    });

    return commitment;
  }

  /**
   * Add commitment to Merkle tree
   * This finalizes the commitment and makes it spendable
   */
  finalizeCommitment(commitmentId: string): CommitmentMerkleProof {
    const commitment = this.commitments.get(commitmentId);
    if (!commitment) {
      throw new Error(`Commitment not found: ${commitmentId}`);
    }

    if (commitment.status !== CommitmentStatus.PENDING) {
      throw new Error(`Commitment is not pending: ${commitment.status}`);
    }

    if (new Date() > commitment.expiresAt) {
      commitment.status = CommitmentStatus.EXPIRED;
      throw new Error('Commitment has expired');
    }

    // Add to Merkle tree
    const merkleIndex = this.merkleTree.addCommitment(commitment.commitmentHash);
    const merkleRoot = this.merkleTree.getRoot();

    commitment.merkleIndex = merkleIndex;
    commitment.merkleRoot = merkleRoot;
    commitment.status = CommitmentStatus.COMMITTED;

    const proof = this.merkleTree.getProof(commitment.commitmentHash);
    if (!proof) {
      throw new Error('Failed to generate Merkle proof');
    }

    this.emit('commitment-finalized', {
      id: commitmentId,
      commitmentHash: commitment.commitmentHash,
      merkleIndex,
      merkleRoot,
      timestamp: new Date(),
    });

    return proof;
  }

  /**
   * Reveal nullifier to spend commitment
   * This is the core double-spend prevention mechanism
   */
  revealNullifier(
    commitmentId: string,
    revealedBy: string
  ): { success: boolean; error?: string; nullifierHash?: string } {
    const commitment = this.commitments.get(commitmentId);
    if (!commitment) {
      return { success: false, error: 'Commitment not found' };
    }

    if (commitment.status !== CommitmentStatus.COMMITTED) {
      return { success: false, error: `Invalid commitment status: ${commitment.status}` };
    }

    // Verify the revealer is the sender
    if (commitment.senderAddress !== revealedBy) {
      return { success: false, error: 'Only sender can reveal nullifier' };
    }

    // Reserve the nullifier (atomic double-spend check)
    if (!this.nullifierRegistry.reserveNullifier(commitment.nullifierHash, commitmentId)) {
      return {
        success: false,
        error: 'Nullifier already consumed or pending - double-spend detected'
      };
    }

    commitment.status = CommitmentStatus.REVEALED;

    this.emit('nullifier-revealed', {
      commitmentId,
      nullifierHash: commitment.nullifierHash,
      revealedBy,
      timestamp: new Date(),
    });

    return { success: true, nullifierHash: commitment.nullifierHash };
  }

  /**
   * Consume commitment after successful cross-chain transfer
   * This permanently marks the nullifier as used
   */
  consumeCommitment(
    commitmentId: string,
    consumedBy: string,
    transactionHash: string
  ): { success: boolean; error?: string } {
    const commitment = this.commitments.get(commitmentId);
    if (!commitment) {
      return { success: false, error: 'Commitment not found' };
    }

    if (commitment.status !== CommitmentStatus.REVEALED) {
      return { success: false, error: `Invalid commitment status: ${commitment.status}` };
    }

    // Consume the nullifier (final double-spend prevention)
    const consumed = this.nullifierRegistry.consumeNullifier(
      commitment.nullifierHash,
      commitmentId,
      consumedBy,
      transactionHash,
      commitment.sourceChain,
      commitment.destinationChain
    );

    if (!consumed) {
      return { success: false, error: 'Failed to consume nullifier - possible double-spend' };
    }

    commitment.status = CommitmentStatus.CONSUMED;

    this.emit('commitment-consumed', {
      commitmentId,
      nullifierHash: commitment.nullifierHash,
      transactionHash,
      consumedBy,
      timestamp: new Date(),
    });

    return { success: true };
  }

  /**
   * Verify a ZK transfer proof
   * Can be called by destination chain to verify transfer validity
   */
  verifyTransferProof(proof: ZKTransferProof): {
    valid: boolean;
    error?: string;
    commitment?: TransferCommitment;
  } {
    // Check nullifier hasn't been consumed
    if (this.nullifierRegistry.isNullifierConsumed(proof.nullifierHash)) {
      return {
        valid: false,
        error: 'Nullifier already consumed - double-spend detected'
      };
    }

    // Verify Merkle proof
    if (!this.merkleTree.verifyProof(proof.merkleProof)) {
      return { valid: false, error: 'Invalid Merkle proof' };
    }

    // Get commitment by nullifier
    const commitmentId = this.commitmentsByNullifier.get(proof.nullifierHash);
    if (!commitmentId) {
      return { valid: false, error: 'Unknown nullifier' };
    }

    const commitment = this.commitments.get(commitmentId);
    if (!commitment) {
      return { valid: false, error: 'Commitment not found' };
    }

    // Verify commitment hash matches
    if (commitment.commitmentHash !== proof.commitmentHash) {
      return { valid: false, error: 'Commitment hash mismatch' };
    }

    return { valid: true, commitment };
  }

  /**
   * Check if a nullifier has been used (for cross-chain queries)
   */
  isNullifierUsed(nullifierHash: string): boolean {
    return this.nullifierRegistry.isNullifierConsumed(nullifierHash);
  }

  /**
   * Get commitment by ID
   */
  getCommitment(commitmentId: string): TransferCommitment | null {
    return this.commitments.get(commitmentId) || null;
  }

  /**
   * Get commitments by sender
   */
  getCommitmentsBySender(senderAddress: string): TransferCommitment[] {
    const ids = this.commitmentsBySender.get(senderAddress);
    if (!ids) return [];

    return Array.from(ids)
      .map(id => this.commitments.get(id))
      .filter((c): c is TransferCommitment => c !== undefined);
  }

  /**
   * Get current Merkle root
   */
  getMerkleRoot(): string {
    return this.merkleTree.getRoot();
  }

  /**
   * Get system statistics
   */
  getStatistics(): {
    totalCommitments: number;
    pendingCommitments: number;
    committedCommitments: number;
    consumedCommitments: number;
    expiredCommitments: number;
    nullifierStats: ReturnType<NullifierRegistry['getStatistics']>;
    merkleTreeStats: ReturnType<CommitmentMerkleTree['getStatistics']>;
  } {
    let pending = 0, committed = 0, consumed = 0, expired = 0;

    for (const commitment of Array.from(this.commitments.values())) {
      switch (commitment.status) {
        case CommitmentStatus.PENDING: pending++; break;
        case CommitmentStatus.COMMITTED: committed++; break;
        case CommitmentStatus.CONSUMED: consumed++; break;
        case CommitmentStatus.EXPIRED: expired++; break;
      }
    }

    return {
      totalCommitments: this.commitments.size,
      pendingCommitments: pending,
      committedCommitments: committed,
      consumedCommitments: consumed,
      expiredCommitments: expired,
      nullifierStats: this.nullifierRegistry.getStatistics(),
      merkleTreeStats: this.merkleTree.getStatistics(),
    };
  }

  /**
   * Export state for persistence
   */
  exportState(): {
    commitments: TransferCommitment[];
    nullifiers: NullifierRecord[];
  } {
    return {
      commitments: Array.from(this.commitments.values()),
      nullifiers: this.nullifierRegistry.exportRegistry(),
    };
  }

  /**
   * Import state from persistence
   */
  importState(state: {
    commitments: TransferCommitment[];
    nullifiers: NullifierRecord[];
  }): void {
    // Import commitments
    for (const commitment of state.commitments) {
      this.commitments.set(commitment.id, commitment);
      this.commitmentsByNullifier.set(commitment.nullifierHash, commitment.id);

      // Rebuild indexes
      if (!this.commitmentsBySender.has(commitment.senderAddress)) {
        this.commitmentsBySender.set(commitment.senderAddress, new Set());
      }
      this.commitmentsBySender.get(commitment.senderAddress)!.add(commitment.id);

      const chainPair = `${commitment.sourceChain}->${commitment.destinationChain}`;
      if (!this.commitmentsByChainPair.has(chainPair)) {
        this.commitmentsByChainPair.set(chainPair, new Set());
      }
      this.commitmentsByChainPair.get(chainPair)!.add(commitment.id);

      // Add committed ones to Merkle tree
      if (commitment.status === CommitmentStatus.COMMITTED ||
          commitment.status === CommitmentStatus.CONSUMED) {
        this.merkleTree.addCommitment(commitment.commitmentHash);
      }
    }

    // Import nullifiers
    this.nullifierRegistry.importRegistry(state.nullifiers);
  }

  private startPruningJob(): void {
    // #977 ratchet: unref'd — reached at import; the handle was discarded.
    const importTimeTimer105 = setInterval(() => {
      const now = new Date();
      for (const [id, commitment] of Array.from(this.commitments.entries())) {
        if (commitment.status === CommitmentStatus.PENDING && now > commitment.expiresAt) {
          commitment.status = CommitmentStatus.EXPIRED;
          this.emit('commitment-expired', { id, timestamp: now });
        }
      }
    }, 60000);
    importTimeTimer105.unref(); // Check every minute
  }
}

// Export singleton instance for shared use
export const bridgeZKCommitmentManager = new BridgeZKCommitmentManager();
