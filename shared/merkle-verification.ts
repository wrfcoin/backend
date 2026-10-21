/**
 * Wrfcoin Merkle Tree Verification System
 *
 * Inspired by WeatherXM's Merkle tree implementation for weather data validation.
 * This module provides tools for creating and verifying Merkle trees
 * specifically optimized for sensor data and weather observations.
 */

import crypto from 'crypto';

/**
 * Node in a Merkle tree
 */
export interface MerkleNode {
  hash: string;
  left?: MerkleNode;
  right?: MerkleNode;
  data?: any;
}

/**
 * Merkle proof for data verification
 */
export interface MerkleProof {
  root: string;
  proof: Array<{
    position: 'left' | 'right';
    hash: string;
  }>;
  leaf: string;
  data: any;
}

/**
 * Weather sensor data sample
 */
export interface SensorDataSample {
  stationId: string;
  timestamp: string;
  type: string;
  value: number;
  unit: string;
  accuracy?: number;
  metadata?: Record<string, any>;
}

/**
 * Calculate hash for a data item
 * @param data Data to hash
 * @returns SHA-256 hash as a hex string
 */
export function calculateHash(data: any): string {
  const content =
    typeof data === 'object' ? JSON.stringify(data) : String(data);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Combine two hashes to create a parent hash
 * @param left Left child hash
 * @param right Right child hash
 * @returns Combined hash
 */
export function combineHashes(left: string, right: string): string {
  return crypto
    .createHash('sha256')
    .update(left + right)
    .digest('hex');
}

/**
 * Create a Merkle tree from an array of sensor data samples
 * @param data Array of data items to include in the tree
 * @returns Root of the Merkle tree
 */
export function createMerkleTree(data: SensorDataSample[]): MerkleNode {
  if (data.length === 0) {
    throw new Error('Cannot create Merkle tree with empty data');
  }

  // Create leaf nodes
  let nodes: MerkleNode[] = data.map(item => ({
    hash: calculateHash(item),
    data: item,
  }));

  // Ensure even number of nodes by duplicating last node if needed
  if (nodes.length % 2 === 1) {
    nodes.push({ ...nodes[nodes.length - 1] });
  }

  // Build the tree bottom-up
  while (nodes.length > 1) {
    const levelNodes: MerkleNode[] = [];

    for (let i = 0; i < nodes.length; i += 2) {
      const left = nodes[i];
      const right = i + 1 < nodes.length ? nodes[i + 1] : nodes[i];

      const parentHash = combineHashes(left.hash, right.hash);
      levelNodes.push({
        hash: parentHash,
        left,
        right,
      });
    }

    nodes = levelNodes;
  }

  return nodes[0]; // Root node
}

/**
 * Generate a Merkle proof for a specific data item
 * @param tree Merkle tree root
 * @param targetData Data to generate proof for
 * @returns Merkle proof or null if data not found
 */
export function generateMerkleProof(
  tree: MerkleNode,
  targetData: SensorDataSample
): MerkleProof | null {
  const targetHash = calculateHash(targetData);
  const proof: Array<{ position: 'left' | 'right'; hash: string }> = [];

  const findPath = (
    node: MerkleNode,
    path: Array<{ position: 'left' | 'right'; hash: string }>
  ): boolean => {
    // Leaf node check
    if (node.data) {
      return node.hash === targetHash;
    }

    // Internal node - try left subtree
    if (node.left && findPath(node.left, path)) {
      if (node.right) {
        path.push({ position: 'right', hash: node.right.hash });
      }
      return true;
    }

    // Try right subtree
    if (node.right && findPath(node.right, path)) {
      if (node.left) {
        path.push({ position: 'left', hash: node.left.hash });
      }
      return true;
    }

    return false;
  };

  if (!findPath(tree, proof)) {
    return null; // Target not found
  }

  return {
    root: tree.hash,
    proof,
    leaf: targetHash,
    data: targetData,
  };
}

/**
 * Verify a Merkle proof
 * @param proof Merkle proof to verify
 * @returns True if the proof is valid
 */
export function verifyMerkleProof(proof: MerkleProof): boolean {
  // Verify that the leaf hash matches the data
  const leafHash = calculateHash(proof.data);
  if (leafHash !== proof.leaf) {
    return false;
  }

  // Start with the leaf hash
  let currentHash = proof.leaf;

  // Apply each proof element
  for (const { position, hash } of proof.proof) {
    if (position === 'left') {
      currentHash = combineHashes(hash, currentHash);
    } else {
      currentHash = combineHashes(currentHash, hash);
    }
  }

  // The final hash should match the root
  return currentHash === proof.root;
}

/**
 * Create a Merkle tree specifically for weather station data
 * This is optimized for the weather data format used in Wrfcoin
 * @param stationData Array of weather station data points
 * @returns Merkle tree root
 */
export function createWeatherDataMerkleTree(
  stationData: SensorDataSample[]
): MerkleNode {
  return createMerkleTree(stationData);
}

/**
 * Batch verify multiple sensor readings from the same station
 * @param root Merkle tree root hash
 * @param proofs Array of Merkle proofs to verify
 * @returns Object containing verification results for each proof
 */
export function batchVerifySensorData(
  root: string,
  proofs: MerkleProof[]
): Record<string, boolean> {
  const results: Record<string, boolean> = {};

  for (const proof of proofs) {
    if (proof.root !== root) {
      results[`${proof.data.stationId}-${proof.data.timestamp}`] = false;
      continue;
    }

    results[`${proof.data.stationId}-${proof.data.timestamp}`] =
      verifyMerkleProof(proof);
  }

  return results;
}
