/**
 * Wrfcoin Merkle Tree Verification System
 *
 * Inspired by WeatherXM's Merkle tree implementation for weather data validation.
 * This module provides tools for creating and verifying Merkle trees
 * specifically optimized for sensor data and weather observations.
 */

const crypto = require('crypto');

/**
 * Calculate hash for a data item
 * @param {any} data Data to hash
 * @returns {string} SHA-256 hash as a hex string
 */
function calculateHash(data) {
  const content =
    typeof data === 'object' ? JSON.stringify(data) : String(data);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Combine two hashes to create a parent hash
 * @param {string} left Left child hash
 * @param {string} right Right child hash
 * @returns {string} Combined hash
 */
function combineHashes(left, right) {
  return crypto
    .createHash('sha256')
    .update(left + right)
    .digest('hex');
}

/**
 * Create a Merkle tree from an array of sensor data samples
 * @param {Array<Object>} data Array of data items to include in the tree
 * @returns {Object} Root of the Merkle tree
 */
function createMerkleTree(data) {
  if (data.length === 0) {
    throw new Error('Cannot create Merkle tree with empty data');
  }

  // Create leaf nodes
  let nodes = data.map(item => ({
    hash: calculateHash(item),
    data: item,
  }));

  // Ensure even number of nodes by duplicating last node if needed
  if (nodes.length % 2 === 1) {
    nodes.push({ ...nodes[nodes.length - 1] });
  }

  // Build the tree bottom-up
  while (nodes.length > 1) {
    const levelNodes = [];

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
 * @param {Object} tree Merkle tree root
 * @param {Object} targetData Data to generate proof for
 * @returns {Object|null} Merkle proof or null if data not found
 */
function generateMerkleProof(tree, targetData) {
  const targetHash = calculateHash(targetData);
  const proof = [];

  const findPath = (node, path) => {
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
 * @param {Object} proof Merkle proof to verify
 * @returns {boolean} True if the proof is valid
 */
function verifyMerkleProof(proof) {
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
 * @param {Array<Object>} stationData Array of weather station data points
 * @returns {Object} Merkle tree root
 */
function createWeatherDataMerkleTree(stationData) {
  return createMerkleTree(stationData);
}

/**
 * Batch verify multiple sensor readings from the same station
 * @param {string} root Merkle tree root hash
 * @param {Array<Object>} proofs Array of Merkle proofs to verify
 * @returns {Object} Object containing verification results for each proof
 */
function batchVerifySensorData(root, proofs) {
  const results = {};

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

module.exports = {
  calculateHash,
  combineHashes,
  createMerkleTree,
  generateMerkleProof,
  verifyMerkleProof,
  createWeatherDataMerkleTree,
  batchVerifySensorData,
};
