/**
 * Bridge Merkle Proof Service
 *
 * Provides Merkle tree construction and proof verification for cross-chain bridge operations.
 * Supports both standard and sparse Merkle trees for efficient transaction inclusion proofs.
 *
 * Security Features:
 * - Keccak256 hashing for Ethereum compatibility
 * - Ordered concatenation for proof reconstruction
 * - Sparse Merkle tree support for efficient state proofs
 * - Transaction batch proof generation
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { EventEmitter } from 'events';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface BridgeTransaction {
  id: string;
  sourceChain: string;
  destinationChain: string;
  sender: string;
  recipient: string;
  amount: bigint;
  tokenAddress: string;
  nonce: number;
  timestamp: number;
  data?: Uint8Array;
}

export interface MerkleProof {
  leaf: string;
  root: string;
  proof: string[];
  leafIndex: number;
  treeSize: number;
}

export interface SparseMerkleProof {
  key: string;
  value: string;
  root: string;
  siblings: string[];
  included: boolean;
}

export interface TransactionMerkleTree {
  root: string;
  leaves: string[];
  tree: string[][];
  transactionIds: string[];
  depth: number;
}

export type HashFunction = 'keccak256' | 'sha256';

// ============================================================================
// Merkle Tree Construction
// ============================================================================

/**
 * Bridge Merkle Service for constructing and verifying Merkle proofs
 */
export class BridgeMerkleService extends EventEmitter {
  private readonly defaultHashFn: HashFunction = 'keccak256';
  private readonly EMPTY_LEAF = '0x' + '0'.repeat(64);

  constructor() {
    super();
  }

  /**
   * Hash function selector
   */
  private hash(data: Uint8Array, hashFn: HashFunction = this.defaultHashFn): Uint8Array {
    if (hashFn === 'keccak256') {
      return keccak_256(data);
    }
    return sha256(data);
  }

  /**
   * Convert hex string to bytes
   */
  private hexToBytes(hex: string): Uint8Array {
    const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
    return hexToBytes(normalized);
  }

  /**
   * Convert bytes to hex string
   */
  private bytesToHexStr(bytes: Uint8Array): string {
    return '0x' + bytesToHex(bytes);
  }

  /**
   * Hash a transaction into a leaf node
   */
  public hashTransaction(tx: BridgeTransaction, hashFn: HashFunction = this.defaultHashFn): string {
    // Create deterministic encoding of the transaction
    const encoder = new TextEncoder();

    // Pack transaction data in a deterministic order
    const packedData: Uint8Array[] = [
      encoder.encode(tx.id),
      encoder.encode(tx.sourceChain),
      encoder.encode(tx.destinationChain),
      this.hexToBytes(tx.sender),
      this.hexToBytes(tx.recipient),
      this.bigintToBytes(tx.amount),
      this.hexToBytes(tx.tokenAddress),
      this.uint32ToBytes(tx.nonce),
      this.uint64ToBytes(BigInt(tx.timestamp)),
    ];

    if (tx.data && tx.data.length > 0) {
      packedData.push(tx.data);
    }

    // Concatenate all parts
    let totalLength = 0;
    for (const part of packedData) {
      totalLength += part.length;
    }

    const combined = new Uint8Array(totalLength);
    let offset = 0;
    for (const part of packedData) {
      combined.set(part, offset);
      offset += part.length;
    }

    return this.bytesToHexStr(this.hash(combined, hashFn));
  }

  /**
   * Build a Merkle tree from a batch of transactions
   */
  public buildTransactionMerkleTree(
    transactions: BridgeTransaction[],
    hashFn: HashFunction = this.defaultHashFn
  ): TransactionMerkleTree {
    if (transactions.length === 0) {
      return {
        root: this.EMPTY_LEAF,
        leaves: [],
        tree: [],
        transactionIds: [],
        depth: 0,
      };
    }

    // Hash all transactions to create leaves
    const leaves = transactions.map(tx => this.hashTransaction(tx, hashFn));
    const transactionIds = transactions.map(tx => tx.id);

    // Pad to power of 2 for complete binary tree
    const targetSize = this.nextPowerOfTwo(leaves.length);
    while (leaves.length < targetSize) {
      leaves.push(this.EMPTY_LEAF);
    }

    // Build tree layers from leaves to root
    const tree: string[][] = [leaves];
    let currentLayer = leaves;

    while (currentLayer.length > 1) {
      const nextLayer: string[] = [];

      for (let i = 0; i < currentLayer.length; i += 2) {
        const left = currentLayer[i];
        const right = currentLayer[i + 1] || left; // Handle odd number of nodes
        const combined = this.hashPair(left, right, hashFn);
        nextLayer.push(combined);
      }

      tree.push(nextLayer);
      currentLayer = nextLayer;
    }

    const root = currentLayer[0];
    const depth = tree.length - 1;

    this.emit('tree:built', {
      root,
      transactionCount: transactions.length,
      treeSize: targetSize,
      depth,
    });

    return {
      root,
      leaves: tree[0],
      tree,
      transactionIds,
      depth,
    };
  }

  /**
   * Generate a Merkle proof for a transaction at a given index
   */
  public generateTransactionProof(
    tree: TransactionMerkleTree,
    transactionIndex: number
  ): MerkleProof | null {
    if (transactionIndex < 0 || transactionIndex >= tree.transactionIds.length) {
      this.emit('proof:error', {
        reason: 'invalid_index',
        index: transactionIndex,
        maxIndex: tree.transactionIds.length - 1,
      });
      return null;
    }

    const proof: string[] = [];
    let currentIndex = transactionIndex;

    // Traverse from leaf to root, collecting sibling hashes
    for (let level = 0; level < tree.tree.length - 1; level++) {
      const layer = tree.tree[level];
      const isRightNode = currentIndex % 2 === 1;
      const siblingIndex = isRightNode ? currentIndex - 1 : currentIndex + 1;

      if (siblingIndex < layer.length) {
        proof.push(layer[siblingIndex]);
      }

      currentIndex = Math.floor(currentIndex / 2);
    }

    const merkleProof: MerkleProof = {
      leaf: tree.leaves[transactionIndex],
      root: tree.root,
      proof,
      leafIndex: transactionIndex,
      treeSize: tree.leaves.length,
    };

    this.emit('proof:generated', {
      leafIndex: transactionIndex,
      proofLength: proof.length,
    });

    return merkleProof;
  }

  /**
   * Verify a Merkle proof against a known root
   */
  public verifyProof(
    proof: MerkleProof,
    hashFn: HashFunction = this.defaultHashFn
  ): boolean {
    try {
      let computedHash = proof.leaf;
      let currentIndex = proof.leafIndex;

      for (const siblingHash of proof.proof) {
        const isRightNode = currentIndex % 2 === 1;

        if (isRightNode) {
          computedHash = this.hashPair(siblingHash, computedHash, hashFn);
        } else {
          computedHash = this.hashPair(computedHash, siblingHash, hashFn);
        }

        currentIndex = Math.floor(currentIndex / 2);
      }

      const isValid = computedHash.toLowerCase() === proof.root.toLowerCase();

      this.emit('proof:verified', {
        isValid,
        leafIndex: proof.leafIndex,
        computedRoot: computedHash,
        expectedRoot: proof.root,
      });

      return isValid;
    } catch (error) {
      this.emit('proof:error', {
        reason: 'verification_failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Verify a transaction is included in a tree with given root
   */
  public verifyTransactionInclusion(
    transaction: BridgeTransaction,
    proof: string[],
    leafIndex: number,
    root: string,
    hashFn: HashFunction = this.defaultHashFn
  ): boolean {
    const leaf = this.hashTransaction(transaction, hashFn);
    const treeSize = Math.pow(2, proof.length);

    const merkleProof: MerkleProof = {
      leaf,
      root,
      proof,
      leafIndex,
      treeSize,
    };

    return this.verifyProof(merkleProof, hashFn);
  }

  // ============================================================================
  // Sparse Merkle Tree Operations
  // ============================================================================

  /**
   * Build a sparse Merkle tree for key-value mappings
   * Useful for efficient state proofs
   */
  public buildSparseMerkleTree(
    entries: Map<string, string>,
    depth: number = 256,
    hashFn: HashFunction = this.defaultHashFn
  ): { root: string; tree: Map<string, string> } {
    const tree = new Map<string, string>();
    const emptyHashes = this.computeEmptyHashes(depth, hashFn);

    // Start with empty tree root
    let currentRoot = emptyHashes[depth];

    // Insert each entry
    for (const [key, value] of entries) {
      const keyHash = this.bytesToHexStr(this.hash(this.hexToBytes(key), hashFn));
      const valueHash = this.bytesToHexStr(this.hash(this.hexToBytes(value), hashFn));

      // Store the leaf value
      tree.set(`leaf:${keyHash}`, valueHash);

      // Update path from leaf to root
      currentRoot = this.updateSparsePath(
        tree,
        keyHash,
        valueHash,
        depth,
        emptyHashes,
        hashFn
      );
    }

    this.emit('sparse_tree:built', {
      root: currentRoot,
      entryCount: entries.size,
      depth,
    });

    return { root: currentRoot, tree };
  }

  /**
   * Generate a sparse Merkle proof for a key
   */
  public generateSparseMerkleProof(
    tree: Map<string, string>,
    key: string,
    depth: number = 256,
    hashFn: HashFunction = this.defaultHashFn
  ): SparseMerkleProof {
    const emptyHashes = this.computeEmptyHashes(depth, hashFn);
    const keyHash = this.bytesToHexStr(this.hash(this.hexToBytes(key), hashFn));
    const keyBits = this.hexToBits(keyHash, depth);

    const siblings: string[] = [];
    let currentHash = keyHash;

    for (let i = depth - 1; i >= 0; i--) {
      const bit = keyBits[i];
      const siblingKey = `node:${i}:${this.toggleBit(currentHash, i)}`;
      const sibling = tree.get(siblingKey) || emptyHashes[i];
      siblings.push(sibling);

      currentHash = currentHash.substring(0, currentHash.length - 1) +
        (bit === '0' ? '0' : '1');
    }

    const leafKey = `leaf:${keyHash}`;
    const value = tree.get(leafKey) || '';
    const included = tree.has(leafKey);

    // Compute root
    const root = this.computeSparseMerkleRoot(tree, depth, hashFn);

    return {
      key,
      value,
      root,
      siblings,
      included,
    };
  }

  /**
   * Verify a sparse Merkle proof
   */
  public verifySparseMerkleProof(
    proof: SparseMerkleProof,
    depth: number = 256,
    hashFn: HashFunction = this.defaultHashFn
  ): boolean {
    try {
      const keyHash = this.bytesToHexStr(this.hash(this.hexToBytes(proof.key), hashFn));
      const keyBits = this.hexToBits(keyHash, depth);

      let currentHash: string;

      if (proof.included) {
        currentHash = this.bytesToHexStr(this.hash(this.hexToBytes(proof.value), hashFn));
      } else {
        const emptyHashes = this.computeEmptyHashes(depth, hashFn);
        currentHash = emptyHashes[0]; // Empty leaf
      }

      for (let i = 0; i < depth; i++) {
        const bit = keyBits[depth - 1 - i];
        const sibling = proof.siblings[i];

        if (bit === '0') {
          currentHash = this.hashPair(currentHash, sibling, hashFn);
        } else {
          currentHash = this.hashPair(sibling, currentHash, hashFn);
        }
      }

      const isValid = currentHash.toLowerCase() === proof.root.toLowerCase();

      this.emit('sparse_proof:verified', {
        isValid,
        key: proof.key,
        included: proof.included,
      });

      return isValid;
    } catch (error) {
      this.emit('sparse_proof:error', {
        reason: 'verification_failed',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  // ============================================================================
  // Batch Operations
  // ============================================================================

  /**
   * Generate proofs for multiple transactions efficiently
   */
  public generateBatchProofs(
    tree: TransactionMerkleTree,
    transactionIndices: number[]
  ): Map<number, MerkleProof> {
    const proofs = new Map<number, MerkleProof>();

    for (const index of transactionIndices) {
      const proof = this.generateTransactionProof(tree, index);
      if (proof) {
        proofs.set(index, proof);
      }
    }

    this.emit('batch_proofs:generated', {
      requestedCount: transactionIndices.length,
      generatedCount: proofs.size,
    });

    return proofs;
  }

  /**
   * Verify multiple proofs efficiently
   */
  public verifyBatchProofs(
    proofs: MerkleProof[],
    expectedRoot: string,
    hashFn: HashFunction = this.defaultHashFn
  ): { valid: number[]; invalid: number[] } {
    const valid: number[] = [];
    const invalid: number[] = [];

    for (const proof of proofs) {
      // Check root matches expected
      if (proof.root.toLowerCase() !== expectedRoot.toLowerCase()) {
        invalid.push(proof.leafIndex);
        continue;
      }

      if (this.verifyProof(proof, hashFn)) {
        valid.push(proof.leafIndex);
      } else {
        invalid.push(proof.leafIndex);
      }
    }

    this.emit('batch_proofs:verified', {
      total: proofs.length,
      validCount: valid.length,
      invalidCount: invalid.length,
    });

    return { valid, invalid };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Hash two nodes together in sorted order for consistency
   */
  private hashPair(left: string, right: string, hashFn: HashFunction): string {
    const leftBytes = this.hexToBytes(left);
    const rightBytes = this.hexToBytes(right);

    // Always hash in consistent order (smaller first)
    const combined = left.toLowerCase() < right.toLowerCase()
      ? concatBytes(leftBytes, rightBytes)
      : concatBytes(rightBytes, leftBytes);

    return this.bytesToHexStr(this.hash(combined, hashFn));
  }

  /**
   * Compute next power of 2 greater than or equal to n
   */
  private nextPowerOfTwo(n: number): number {
    if (n <= 1) return 1;
    return Math.pow(2, Math.ceil(Math.log2(n)));
  }

  /**
   * Convert bigint to bytes (big-endian)
   */
  private bigintToBytes(value: bigint): Uint8Array {
    const hex = value.toString(16).padStart(64, '0');
    return this.hexToBytes(hex);
  }

  /**
   * Convert uint32 to bytes (big-endian)
   */
  private uint32ToBytes(value: number): Uint8Array {
    const buffer = new Uint8Array(4);
    buffer[0] = (value >>> 24) & 0xff;
    buffer[1] = (value >>> 16) & 0xff;
    buffer[2] = (value >>> 8) & 0xff;
    buffer[3] = value & 0xff;
    return buffer;
  }

  /**
   * Convert uint64 to bytes (big-endian)
   */
  private uint64ToBytes(value: bigint): Uint8Array {
    const buffer = new Uint8Array(8);
    for (let i = 7; i >= 0; i--) {
      buffer[i] = Number(value & BigInt(0xff));
      value >>= BigInt(8);
    }
    return buffer;
  }

  /**
   * Compute empty hashes for each level of sparse Merkle tree
   */
  private computeEmptyHashes(depth: number, hashFn: HashFunction): string[] {
    const emptyHashes: string[] = new Array(depth + 1);

    // Level 0 is the empty leaf (all zeros)
    emptyHashes[0] = this.EMPTY_LEAF;

    // Each level is hash of two children from previous level
    for (let i = 1; i <= depth; i++) {
      emptyHashes[i] = this.hashPair(emptyHashes[i - 1], emptyHashes[i - 1], hashFn);
    }

    return emptyHashes;
  }

  /**
   * Convert hex to bit string
   */
  private hexToBits(hex: string, length: number): string {
    const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bigint = BigInt('0x' + normalized);
    return bigint.toString(2).padStart(length, '0');
  }

  /**
   * Toggle a specific bit in a hex string
   */
  private toggleBit(hex: string, position: number): string {
    const normalized = hex.startsWith('0x') ? hex.slice(2) : hex;
    const bigint = BigInt('0x' + normalized);
    const mask = BigInt(1) << BigInt(position);
    const toggled = bigint ^ mask;
    return '0x' + toggled.toString(16).padStart(normalized.length, '0');
  }

  /**
   * Update path in sparse Merkle tree after inserting a leaf
   */
  private updateSparsePath(
    tree: Map<string, string>,
    keyHash: string,
    valueHash: string,
    depth: number,
    emptyHashes: string[],
    hashFn: HashFunction
  ): string {
    const keyBits = this.hexToBits(keyHash, depth);
    let currentHash = valueHash;

    for (let level = 0; level < depth; level++) {
      const bit = keyBits[depth - 1 - level];
      const nodeKey = `node:${level}:${keyHash}`;

      tree.set(nodeKey, currentHash);

      // Get sibling (empty if not exists)
      const siblingKey = `node:${level}:${this.toggleBit(keyHash, level)}`;
      const sibling = tree.get(siblingKey) || emptyHashes[level];

      if (bit === '0') {
        currentHash = this.hashPair(currentHash, sibling, hashFn);
      } else {
        currentHash = this.hashPair(sibling, currentHash, hashFn);
      }
    }

    return currentHash;
  }

  /**
   * Compute root of sparse Merkle tree
   */
  private computeSparseMerkleRoot(
    tree: Map<string, string>,
    depth: number,
    hashFn: HashFunction
  ): string {
    // Find the highest level node
    for (let level = depth - 1; level >= 0; level--) {
      for (const [key] of tree) {
        if (key.startsWith(`node:${level}:`)) {
          // Traverse up to root
          // This is a simplified approach; in practice, you'd track the root
          return tree.get(key) || this.EMPTY_LEAF;
        }
      }
    }
    return this.EMPTY_LEAF;
  }
}

// Export singleton instance
export const bridgeMerkleService = new BridgeMerkleService();
