/**
 * BigchainDB Integration Module for Wrfcoin
 *
 * This module provides the main interface for BigchainDB-inspired functionality:
 * - Asset ownership model for computational assets
 * - Rich metadata handling
 * - Byzantine fault tolerance concepts
 * - Privacy features for sensitive data
 */

const BigchainDBAdapter = require('./adapter');
const logger = require('../utils/logger')('bigchaindb');

let adapter = null;

/**
 * Initialize the BigchainDB integration
 * @param {Object} options - Configuration options
 * @returns {Promise<boolean>} Success status
 */
async function initialize(options = {}) {
  try {
    adapter = new BigchainDBAdapter(options);
    const success = await adapter.initialize();

    if (success) {
      logger.info('BigchainDB integration initialized successfully');
    } else {
      logger.error('Failed to initialize BigchainDB integration');
    }

    return success;
  } catch (error) {
    logger.error(`Error initializing BigchainDB integration: ${error.message}`);
    return false;
  }
}

/**
 * Create a new digital asset with ownership
 * @param {Object} assetData - Core data of the asset
 * @param {Object} metadata - Metadata associated with the asset
 * @param {String} ownerId - ID of the initial owner
 * @param {String} publicKey - Public key for verification
 * @param {String} signature - Cryptographic signature
 * @returns {Promise<Object>} Created asset info
 */
async function createAsset(assetData, metadata, ownerId, publicKey, signature) {
  ensureInitialized();
  return adapter.createAsset(
    assetData,
    metadata,
    ownerId,
    publicKey,
    signature
  );
}

/**
 * Create a new computational asset with ownership
 * This is a specialized version for computational NFTs and data
 * @param {Object} computationalData - Computational asset data
 * @param {Object} metadata - Metadata for the computational asset
 * @param {String} ownerId - ID of the initial owner
 * @param {String} publicKey - Public key for verification
 * @param {String} signature - Cryptographic signature
 * @returns {Promise<Object>} Created computational asset info
 */
async function createComputationalAsset(
  computationalData,
  metadata,
  ownerId,
  publicKey,
  signature
) {
  ensureInitialized();

  // Ensure the computational data has the required fields
  const enrichedData = {
    type: 'computational',
    subtype: computationalData.type || 'generic',
    computationType: computationalData.computationType || 'GENERIC',
    ...computationalData,
  };

  // Add computational-specific metadata
  const enrichedMetadata = {
    contentType: 'application/json',
    schema: 'https://wrfcoin.io/schemas/computational-asset-v1.json',
    license: metadata.license || 'CC-BY-4.0',
    ...metadata,
  };

  return adapter.createAsset(
    enrichedData,
    enrichedMetadata,
    ownerId,
    publicKey,
    signature
  );
}

/**
 * Transfer ownership of an asset
 * @param {String} assetId - ID of the asset to transfer
 * @param {String} currentOwnerId - ID of the current owner
 * @param {String} newOwnerId - ID of the new owner
 * @param {Object} metadata - Metadata for the transfer
 * @param {String} publicKey - Public key for verification
 * @param {String} signature - Cryptographic signature
 * @returns {Promise<Object>} Transfer transaction info
 */
async function transferAsset(
  assetId,
  currentOwnerId,
  newOwnerId,
  metadata,
  publicKey,
  signature
) {
  ensureInitialized();
  return adapter.transferAsset(
    assetId,
    currentOwnerId,
    newOwnerId,
    metadata,
    publicKey,
    signature
  );
}

/**
 * Get asset by ID
 * @param {String} assetId - ID of the asset to retrieve
 * @returns {Promise<Object>} Asset data
 */
async function getAsset(assetId) {
  ensureInitialized();
  return adapter.getAsset(assetId);
}

/**
 * Search for assets based on data or metadata
 * @param {Object} query - Query parameters
 * @param {Number} limit - Maximum number of results
 * @param {Number} offset - Number of results to skip
 * @returns {Promise<Array>} Matching assets
 */
async function searchAssets(query, limit = 10, offset = 0) {
  ensureInitialized();
  return adapter.searchAssets(query, limit, offset);
}

/**
 * Get assets owned by a specific user
 * @param {String} ownerId - ID of the owner
 * @param {Number} limit - Maximum number of results
 * @param {Number} offset - Number of results to skip
 * @returns {Promise<Array>} Assets owned by the user
 */
async function getAssetsByOwner(ownerId, limit = 10, offset = 0) {
  ensureInitialized();
  return adapter.getAssetsByOwner(ownerId, limit, offset);
}

/**
 * Update asset metadata without changing ownership
 * @param {String} assetId - ID of the asset to update
 * @param {String} ownerId - ID of the current owner
 * @param {Object} metadata - New metadata for the asset
 * @param {String} publicKey - Public key for verification
 * @param {String} signature - Cryptographic signature
 * @returns {Promise<Object>} Updated asset info
 */
async function updateAssetMetadata(
  assetId,
  ownerId,
  metadata,
  publicKey,
  signature
) {
  ensureInitialized();
  return adapter.updateAssetMetadata(
    assetId,
    ownerId,
    metadata,
    publicKey,
    signature
  );
}

/**
 * Create a shared ownership asset
 * @param {Object} assetData - Core data of the asset
 * @param {Object} metadata - Metadata associated with the asset
 * @param {Array} owners - Array of {ownerId, shares} objects
 * @param {String} publicKey - Public key for verification
 * @param {String} signature - Cryptographic signature
 * @returns {Promise<Object>} Created asset info
 */
async function createSharedAsset(
  assetData,
  metadata,
  owners,
  publicKey,
  signature
) {
  ensureInitialized();
  return adapter.createSharedAsset(
    assetData,
    metadata,
    owners,
    publicKey,
    signature
  );
}

/**
 * Generate a key pair for cryptographic operations
 * @returns {Object} Key pair { publicKey, privateKey }
 */
function generateKeyPair() {
  const crypto = require('crypto');
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });
}

/**
 * Sign data with a private key
 * @param {String|Object} data - Data to sign
 * @param {String} privateKey - Private key for signing
 * @returns {String} Signature
 */
function signData(data, privateKey) {
  if (typeof data === 'object') {
    data = JSON.stringify(data);
  }
  return BigchainDBAdapter.signData(data, privateKey);
}

/**
 * Ensure the adapter is initialized
 * @private
 * @throws {Error} If adapter is not initialized
 */
function ensureInitialized() {
  if (!adapter || !adapter.initialized) {
    throw new Error(
      'BigchainDB integration not initialized. Call initialize() first.'
    );
  }
}

// Export public functions
module.exports = {
  initialize,
  createAsset,
  createComputationalAsset,
  transferAsset,
  getAsset,
  searchAssets,
  getAssetsByOwner,
  updateAssetMetadata,
  createSharedAsset,
  generateKeyPair,
  signData,
};
