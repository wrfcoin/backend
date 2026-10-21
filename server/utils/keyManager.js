/**
 * Wrfcoin Secure Key Manager
 *
 * This module handles secure storage, retrieval, and generation of
 * cryptographic keys for the Wrfcoin node. It uses industry-standard
 * encryption and secure storage practices to protect private keys.
 *
 * keyManager.js manages ED25519 key pairs for general wallet operations
 * (key generation, storage, retrieval).  It must NOT be used for
 * L1_PERMISSIONLESS or high-value transactions (>= 100,000 WRF).  The HSM
 * transaction-signing service that was meant to carry those paths is retired
 * (owner ruling 2026-10-03); until a replacement exists, no route here signs
 * them.  Audit any callers if adding new routes.
 */

const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const { logger } = require('./logger');

// Key storage location (in production would use secure environment variables)
const KEY_STORAGE_DIR =
  process.env.KEY_STORAGE_DIR || path.join(__dirname, '../../data/keys');
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY;
if (!ENCRYPTION_KEY) {
  const msg = 'FATAL: ENCRYPTION_KEY environment variable is required. Refusing to start with default key.';
  logger.error(msg);
  throw new Error(msg);
}
const IV_LENGTH = 16; // For AES, this is always 16 bytes

class KeyManager {
  constructor() {
    this.initialized = false;
  }

  /**
   * Initialize the key manager
   */
  async initialize() {
    try {
      // Ensure key storage directory exists
      await fs.mkdir(KEY_STORAGE_DIR, { recursive: true });
      this.initialized = true;
      logger.info('Key manager initialized successfully');
      return true;
    } catch (error) {
      logger.error('Failed to initialize key manager', {
        error: error.message,
      });
      return false;
    }
  }

  /**
   * Generate a new key pair
   * @param {string} keyId - Unique identifier for the key
   * @param {string} keyType - Type of key ('node', 'validator', 'wallet', etc.)
   * @returns {Promise<object>} Key pair object
   */
  async generateKeyPair(keyId, keyType) {
    if (!this.initialized) await this.initialize();

    try {
      // Generate a new key pair
      const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
        publicKeyEncoding: {
          type: 'spki',
          format: 'pem',
        },
        privateKeyEncoding: {
          type: 'pkcs8',
          format: 'pem',
        },
      });

      // Store the key pair
      const keyPair = {
        keyId,
        keyType,
        publicKey,
        privateKey,
        createdAt: new Date().toISOString(),
      };

      await this.storeKey(keyId, keyPair);

      logger.info(`Generated new key pair: ${keyId}`, { keyType });

      // Return a limited object without the actual private key
      return {
        keyId,
        keyType,
        publicKey,
        privateKeyStored: true,
        createdAt: keyPair.createdAt,
      };
    } catch (error) {
      logger.error(`Failed to generate key pair: ${keyId}`, {
        error: error.message,
        keyType,
      });
      throw new Error(`Failed to generate key pair: ${error.message}`);
    }
  }

  /**
   * Store a key securely
   * @param {string} keyId - Unique identifier for the key
   * @param {object} keyData - Key data to store
   * @returns {Promise<boolean>} Success status
   */
  async storeKey(keyId, keyData) {
    if (!this.initialized) await this.initialize();

    try {
      // Validate key ID
      if (!keyId || typeof keyId !== 'string') {
        throw new Error('Invalid key ID');
      }

      // Validate key data
      if (!keyData || typeof keyData !== 'object') {
        throw new Error('Invalid key data');
      }

      // Encrypt the key data
      const encryptedData = this.encrypt(JSON.stringify(keyData));

      // Store the encrypted key
      const keyPath = path.join(KEY_STORAGE_DIR, `${keyId}.enc`);
      await fs.writeFile(keyPath, encryptedData, 'utf8');

      logger.info(`Stored key: ${keyId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to store key: ${keyId}`, { error: error.message });
      throw new Error(`Failed to store key: ${error.message}`);
    }
  }

  /**
   * Retrieve a key
   * @param {string} keyId - Unique identifier for the key
   * @returns {Promise<object|null>} Key data or null if not found
   */
  async getKey(keyId) {
    if (!this.initialized) await this.initialize();

    try {
      // Validate key ID
      if (!keyId || typeof keyId !== 'string') {
        throw new Error('Invalid key ID');
      }

      // Check if key exists
      const keyPath = path.join(KEY_STORAGE_DIR, `${keyId}.enc`);
      const keyExists = await fs
        .access(keyPath)
        .then(() => true)
        .catch(() => false);

      if (!keyExists) {
        logger.warn(`Key not found: ${keyId}`);
        return null;
      }

      // Read and decrypt the key
      const encryptedData = await fs.readFile(keyPath, 'utf8');
      const keyDataString = this.decrypt(encryptedData);
      const keyData = JSON.parse(keyDataString);

      logger.info(`Retrieved key: ${keyId}`);
      return keyData;
    } catch (error) {
      logger.error(`Failed to retrieve key: ${keyId}`, {
        error: error.message,
      });
      throw new Error(`Failed to retrieve key: ${error.message}`);
    }
  }

  /**
   * Delete a key
   * @param {string} keyId - Unique identifier for the key
   * @returns {Promise<boolean>} Success status
   */
  async deleteKey(keyId) {
    if (!this.initialized) await this.initialize();

    try {
      // Validate key ID
      if (!keyId || typeof keyId !== 'string') {
        throw new Error('Invalid key ID');
      }

      // Check if key exists
      const keyPath = path.join(KEY_STORAGE_DIR, `${keyId}.enc`);
      const keyExists = await fs
        .access(keyPath)
        .then(() => true)
        .catch(() => false);

      if (!keyExists) {
        logger.warn(`Key not found for deletion: ${keyId}`);
        return false;
      }

      // Delete the key
      await fs.unlink(keyPath);

      logger.info(`Deleted key: ${keyId}`);
      return true;
    } catch (error) {
      logger.error(`Failed to delete key: ${keyId}`, { error: error.message });
      throw new Error(`Failed to delete key: ${error.message}`);
    }
  }

  /**
   * List all keys
   * @param {string} [keyType] - Optional filter by key type
   * @returns {Promise<Array<object>>} Array of key info objects
   */
  async listKeys(keyType = null) {
    if (!this.initialized) await this.initialize();

    try {
      // Get all key files
      const files = await fs.readdir(KEY_STORAGE_DIR);
      const keyFiles = files.filter(file => file.endsWith('.enc'));

      const keys = [];

      // Process each key file
      for (const file of keyFiles) {
        try {
          const keyId = file.replace('.enc', '');
          const keyData = await this.getKey(keyId);

          // Skip if key type filter is provided and doesn't match
          if (keyType && keyData.keyType !== keyType) {
            continue;
          }

          // Add key info without private key
          keys.push({
            keyId: keyData.keyId,
            keyType: keyData.keyType,
            publicKey: keyData.publicKey,
            createdAt: keyData.createdAt,
          });
        } catch (error) {
          logger.warn(`Failed to process key file: ${file}`, {
            error: error.message,
          });
          // Continue processing other keys
        }
      }

      return keys;
    } catch (error) {
      logger.error('Failed to list keys', { error: error.message });
      throw new Error(`Failed to list keys: ${error.message}`);
    }
  }

  /**
   * Sign data with a private key
   * @param {string} keyId - Unique identifier for the key
   * @param {string|Buffer} data - Data to sign
   * @returns {Promise<string>} Signature (base64 encoded)
   */
  async signData(keyId, data) {
    if (!this.initialized) await this.initialize();

    try {
      // Get the key
      const keyData = await this.getKey(keyId);

      if (!keyData) {
        throw new Error(`Key not found: ${keyId}`);
      }

      // Create a sign object and sign the data
      const sign = crypto.createSign('SHA256');
      sign.update(data);
      sign.end();

      const signature = sign.sign(keyData.privateKey, 'base64');
      return signature;
    } catch (error) {
      logger.error(`Failed to sign data with key: ${keyId}`, {
        error: error.message,
      });
      throw new Error(`Failed to sign data: ${error.message}`);
    }
  }

  /**
   * Verify a signature
   * @param {string} publicKey - Public key (PEM format)
   * @param {string|Buffer} data - Original data
   * @param {string} signature - Signature (base64 encoded)
   * @returns {Promise<boolean>} Verification result
   */
  async verifySignature(publicKey, data, signature) {
    try {
      // Create a verify object and verify the signature
      const verify = crypto.createVerify('SHA256');
      verify.update(data);
      verify.end();

      return verify.verify(publicKey, signature, 'base64');
    } catch (error) {
      logger.error('Failed to verify signature', { error: error.message });
      return false;
    }
  }

  /**
   * Encrypt data using the master encryption key
   * @param {string} data - Data to encrypt
   * @returns {string} Encrypted data
   * @private
   */
  encrypt(data) {
    try {
      // Create a random initialization vector
      const iv = crypto.randomBytes(IV_LENGTH);

      // Generate a key from the master encryption key
      const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);

      // Create the cipher
      const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);

      // Encrypt the data
      let encrypted = cipher.update(data, 'utf8', 'hex');
      encrypted += cipher.final('hex');

      // Prepend the IV to the encrypted data
      return `${iv.toString('hex')}:${encrypted}`;
    } catch (error) {
      logger.error('Encryption failed', { error: error.message });
      throw new Error(`Encryption failed: ${error.message}`);
    }
  }

  /**
   * Decrypt data using the master encryption key
   * @param {string} data - Encrypted data
   * @returns {string} Decrypted data
   * @private
   */
  decrypt(data) {
    try {
      // Split the IV and encrypted data
      const parts = data.split(':');
      if (parts.length !== 2) {
        throw new Error('Invalid encrypted data format');
      }

      const iv = Buffer.from(parts[0], 'hex');
      const encrypted = parts[1];

      // Generate a key from the master encryption key
      const key = crypto.scryptSync(ENCRYPTION_KEY, 'salt', 32);

      // Create the decipher
      const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);

      // Decrypt the data
      let decrypted = decipher.update(encrypted, 'hex', 'utf8');
      decrypted += decipher.final('utf8');

      return decrypted;
    } catch (error) {
      logger.error('Decryption failed', { error: error.message });
      throw new Error(`Decryption failed: ${error.message}`);
    }
  }
}

// Export a singleton instance
const keyManager = new KeyManager();

module.exports = keyManager;
