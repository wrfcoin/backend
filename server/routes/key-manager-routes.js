/**
 * Key Manager API Routes
 *
 * These routes handle access to the secure key management functionality
 * including key generation, storage, and retrieval. These endpoints
 * require strict authentication.
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const keyManager = require('../utils/keyManager');
const {
  verifyNodeControlAuth,
  nodeControlRateLimiter,
} = require('../middleware/rpcAuthMiddleware');

// Apply rate limiting and authentication to all key manager routes
router.use(nodeControlRateLimiter);
router.use(verifyNodeControlAuth);

/**
 * Generate a new key pair
 */
router.post('/generate', async (req, res) => {
  try {
    const { keyId, keyType } = req.body;

    if (!keyId || !keyType) {
      return res.status(400).json({
        error: true,
        message: 'Missing required parameters: keyId and keyType',
        code: 'MISSING_PARAMS',
      });
    }

    // Check if key already exists
    const existingKey = await keyManager.getKey(keyId);
    if (existingKey) {
      return res.status(409).json({
        error: true,
        message: `Key with ID '${keyId}' already exists`,
        code: 'KEY_EXISTS',
      });
    }

    // Generate the key pair
    const keyPair = await keyManager.generateKeyPair(keyId, keyType);

    logger.info(`Key pair generated for ${keyId}`, { keyType, ip: req.ip });

    res.json({
      success: true,
      message: 'Key pair generated successfully',
      key: keyPair,
    });
  } catch (error) {
    logger.error('Error generating key pair', { error: error.message });
    res.status(500).json({
      error: true,
      message: 'Failed to generate key pair',
      details: error.message,
    });
  }
});

/**
 * List all keys or filter by type
 */
router.get('/', async (req, res) => {
  try {
    const { type } = req.query;

    const keys = await keyManager.listKeys(type || null);

    res.json({
      keys,
      count: keys.length,
      keyTypes: [...new Set(keys.map(key => key.keyType))],
    });
  } catch (error) {
    logger.error('Error listing keys', { error: error.message });
    res.status(500).json({
      error: true,
      message: 'Failed to list keys',
      details: error.message,
    });
  }
});

/**
 * Get a specific key by ID
 */
router.get('/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;

    const key = await keyManager.getKey(keyId);

    if (!key) {
      return res.status(404).json({
        error: true,
        message: `Key not found: ${keyId}`,
        code: 'KEY_NOT_FOUND',
      });
    }

    // Mask private key in response
    const keyResponse = {
      ...key,
      privateKey: '[REDACTED]',
    };

    res.json({
      key: keyResponse,
    });
  } catch (error) {
    logger.error(`Error getting key: ${req.params.keyId}`, {
      error: error.message,
    });
    res.status(500).json({
      error: true,
      message: 'Failed to get key',
      details: error.message,
    });
  }
});

/**
 * Delete a key
 */
router.delete('/:keyId', async (req, res) => {
  try {
    const { keyId } = req.params;

    const deleted = await keyManager.deleteKey(keyId);

    if (!deleted) {
      return res.status(404).json({
        error: true,
        message: `Key not found: ${keyId}`,
        code: 'KEY_NOT_FOUND',
      });
    }

    logger.info(`Key deleted: ${keyId}`, { ip: req.ip });

    res.json({
      success: true,
      message: `Key '${keyId}' deleted successfully`,
    });
  } catch (error) {
    logger.error(`Error deleting key: ${req.params.keyId}`, {
      error: error.message,
    });
    res.status(500).json({
      error: true,
      message: 'Failed to delete key',
      details: error.message,
    });
  }
});

/**
 * Sign data with a key
 */
router.post('/sign', async (req, res) => {
  try {
    const { keyId, data } = req.body;

    if (!keyId || !data) {
      return res.status(400).json({
        error: true,
        message: 'Missing required parameters: keyId and data',
        code: 'MISSING_PARAMS',
      });
    }

    // Check if key exists
    const key = await keyManager.getKey(keyId);
    if (!key) {
      return res.status(404).json({
        error: true,
        message: `Key not found: ${keyId}`,
        code: 'KEY_NOT_FOUND',
      });
    }

    // Sign the data
    const signature = await keyManager.signData(keyId, data);

    logger.info(`Data signed with key: ${keyId}`, { ip: req.ip });

    res.json({
      success: true,
      signature,
      keyId,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error signing data', { error: error.message });
    res.status(500).json({
      error: true,
      message: 'Failed to sign data',
      details: error.message,
    });
  }
});

/**
 * Verify a signature
 */
router.post('/verify', async (req, res) => {
  try {
    const { publicKey, data, signature } = req.body;

    if (!publicKey || !data || !signature) {
      return res.status(400).json({
        error: true,
        message: 'Missing required parameters: publicKey, data, and signature',
        code: 'MISSING_PARAMS',
      });
    }

    // Verify the signature
    const isValid = await keyManager.verifySignature(
      publicKey,
      data,
      signature
    );

    res.json({
      success: true,
      valid: isValid,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error verifying signature', { error: error.message });
    res.status(500).json({
      error: true,
      message: 'Failed to verify signature',
      details: error.message,
    });
  }
});

module.exports = router;
