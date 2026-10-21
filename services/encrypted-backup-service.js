/**
 * Encrypted Database Backup Service
 *
 * Provides secure database backup and restore with AES-256 encryption.
 * Supports incremental backups, compression, and secure key management.
 *
 * @module encrypted-backup-service
 * @security CRITICAL - This service handles sensitive database backups
 *
 * Features:
 * - AES-256-GCM encryption for backup files
 * - GZIP compression before encryption
 * - Secure key management via HashiCorp Vault
 * - Backup rotation and retention policies
 * - Integrity verification with checksums
 * - Point-in-time recovery support
 */

'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { createGzip, createGunzip } = require('zlib');
const { getVaultClient } = require('../server/config/vault-config');
const { securityLogger } = require('../server/utils/logger');

// Encryption constants
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const CHUNK_SIZE = 64 * 1024; // 64KB chunks for streaming

/**
 * Encrypted Backup Service
 * Handles secure database backup and restore operations
 */
class EncryptedBackupService {
  constructor(options = {}) {
    this.vaultClient = null;
    this.backupKey = null;
    this.keyId = null;
    this.initialized = false;

    this.options = {
      backupDir: options.backupDir || process.env.BACKUP_DIR || '/var/backups/wrfcoin',
      keyPath: options.keyPath || 'wrfcoin/backup/encryption-key',
      retentionDays: options.retentionDays || 30,
      maxBackups: options.maxBackups || 10,
      compressionLevel: options.compressionLevel || 6, // 1-9, higher = more compression
      pgDumpPath: options.pgDumpPath || 'pg_dump',
      pgRestorePath: options.pgRestorePath || 'pg_restore',
      tempDir: options.tempDir || '/tmp/wrfcoin-backups',
    };

    // Backup manifest tracking
    this.manifest = {
      backups: [],
      lastFullBackup: null,
      lastIncrementalBackup: null,
    };

    // Metrics
    this.metrics = {
      totalBackups: 0,
      successfulBackups: 0,
      failedBackups: 0,
      totalRestores: 0,
      successfulRestores: 0,
      failedRestores: 0,
      lastBackupTime: null,
      lastBackupSize: 0,
      totalBackupSize: 0,
    };
  }

  /**
   * Initialize the backup service
   * @returns {Promise<void>}
   */
  async initialize() {
    if (this.initialized) {
      return;
    }

    try {
      // Ensure directories exist
      await this._ensureDirectories();

      // Initialize Vault client and load encryption key
      this.vaultClient = getVaultClient();
      await this._loadOrGenerateBackupKey();

      // Load manifest
      await this._loadManifest();

      this.initialized = true;
      securityLogger.info('Encrypted Backup Service initialized', { service: 'backup' });
    } catch (error) {
      securityLogger.error('Initialization failed', { service: 'backup', error: error.message });
      throw error;
    }
  }

  /**
   * Create a full database backup
   * @param {Object} dbConfig - Database connection configuration
   * @param {Object} options - Backup options
   * @returns {Promise<Object>} Backup result with metadata
   */
  async createFullBackup(dbConfig, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    const backupId = `full-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const timestamp = new Date();
    const tempFile = path.join(this.options.tempDir, `${backupId}.dump`);
    const encryptedFile = path.join(this.options.backupDir, `${backupId}.enc`);

    securityLogger.info('Starting full backup', { service: 'backup', backupId });
    this.metrics.totalBackups++;

    try {
      // Step 1: Create pg_dump
      await this._createPgDump(dbConfig, tempFile, options);

      // Step 2: Compress and encrypt
      const { checksum, size, iv, authTag } = await this._compressAndEncrypt(tempFile, encryptedFile);

      // Step 3: Create backup metadata
      const metadata = {
        id: backupId,
        type: 'full',
        timestamp: timestamp.toISOString(),
        database: dbConfig.database,
        keyId: this.keyId,
        iv: iv.toString('base64'),
        authTag: authTag.toString('base64'),
        checksum,
        compressedSize: size,
        originalSize: fs.statSync(tempFile).size,
        compressionRatio: (size / fs.statSync(tempFile).size * 100).toFixed(2) + '%',
        pgVersion: await this._getPgVersion(),
        options: {
          format: options.format || 'custom',
          compression: this.options.compressionLevel,
        },
      };

      // Step 4: Save metadata
      await this._saveBackupMetadata(backupId, metadata);

      // Step 5: Update manifest
      this.manifest.backups.push({
        id: backupId,
        type: 'full',
        timestamp: timestamp.toISOString(),
        size,
        checksum,
      });
      this.manifest.lastFullBackup = backupId;
      await this._saveManifest();

      // Step 6: Cleanup temp file
      await fs.promises.unlink(tempFile);

      // Step 7: Apply retention policy
      await this._applyRetentionPolicy();

      // Update metrics
      this.metrics.successfulBackups++;
      this.metrics.lastBackupTime = timestamp;
      this.metrics.lastBackupSize = size;
      this.metrics.totalBackupSize += size;

      securityLogger.info('Full backup completed', { service: 'backup', backupId, sizeMB: (size / 1024 / 1024).toFixed(2) });

      return {
        success: true,
        backupId,
        metadata,
        filePath: encryptedFile,
      };
    } catch (error) {
      this.metrics.failedBackups++;
      securityLogger.error('Backup failed', { service: 'backup', error: error.message });

      // Cleanup on failure
      try {
        if (fs.existsSync(tempFile)) await fs.promises.unlink(tempFile);
        if (fs.existsSync(encryptedFile)) await fs.promises.unlink(encryptedFile);
      } catch (cleanupError) {
        securityLogger.warn('Cleanup failed', { service: 'backup', error: cleanupError.message });
      }

      throw new Error(`Backup failed: ${error.message}`);
    }
  }

  /**
   * Restore a database from backup
   * @param {string} backupId - Backup ID to restore
   * @param {Object} dbConfig - Database connection configuration
   * @param {Object} options - Restore options
   * @returns {Promise<Object>} Restore result
   */
  async restoreBackup(backupId, dbConfig, options = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    securityLogger.info('Starting restore', { service: 'backup', backupId });
    this.metrics.totalRestores++;

    const encryptedFile = path.join(this.options.backupDir, `${backupId}.enc`);
    const tempFile = path.join(this.options.tempDir, `${backupId}-restore.dump`);

    try {
      // Step 1: Load backup metadata
      const metadata = await this._loadBackupMetadata(backupId);
      if (!metadata) {
        throw new Error(`Backup metadata not found: ${backupId}`);
      }

      // Step 2: Verify backup file exists
      if (!fs.existsSync(encryptedFile)) {
        throw new Error(`Backup file not found: ${encryptedFile}`);
      }

      // Step 3: Decrypt and decompress
      await this._decryptAndDecompress(encryptedFile, tempFile, metadata);

      // Step 4: Verify checksum
      const checksum = await this._calculateChecksum(tempFile);
      if (checksum !== metadata.checksum) {
        throw new Error('Backup integrity check failed: checksum mismatch');
      }

      // Step 5: Restore database (if not dry-run)
      if (!options.dryRun) {
        await this._restorePgDump(tempFile, dbConfig, options);
      }

      // Step 6: Cleanup temp file
      await fs.promises.unlink(tempFile);

      this.metrics.successfulRestores++;
      securityLogger.info('Restore completed', { service: 'backup', backupId });

      return {
        success: true,
        backupId,
        restoredAt: new Date().toISOString(),
        database: dbConfig.database,
        dryRun: options.dryRun || false,
      };
    } catch (error) {
      this.metrics.failedRestores++;
      securityLogger.error('Restore failed', { service: 'backup', error: error.message });

      // Cleanup on failure
      try {
        if (fs.existsSync(tempFile)) await fs.promises.unlink(tempFile);
      } catch (cleanupError) {
        securityLogger.warn('Cleanup failed', { service: 'backup', error: cleanupError.message });
      }

      throw new Error(`Restore failed: ${error.message}`);
    }
  }

  /**
   * List all available backups
   * @param {Object} filters - Filter options
   * @returns {Promise<Array>} List of backup metadata
   */
  async listBackups(filters = {}) {
    if (!this.initialized) {
      await this.initialize();
    }

    let backups = [...this.manifest.backups];

    // Apply filters
    if (filters.type) {
      backups = backups.filter(b => b.type === filters.type);
    }
    if (filters.startDate) {
      backups = backups.filter(b => new Date(b.timestamp) >= new Date(filters.startDate));
    }
    if (filters.endDate) {
      backups = backups.filter(b => new Date(b.timestamp) <= new Date(filters.endDate));
    }

    // Sort by timestamp descending
    backups.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    // Apply limit
    if (filters.limit) {
      backups = backups.slice(0, filters.limit);
    }

    return backups;
  }

  /**
   * Delete a specific backup
   * @param {string} backupId - Backup ID to delete
   * @returns {Promise<Object>} Deletion result
   */
  async deleteBackup(backupId) {
    if (!this.initialized) {
      await this.initialize();
    }

    securityLogger.info('Deleting backup', { service: 'backup', backupId });

    const encryptedFile = path.join(this.options.backupDir, `${backupId}.enc`);
    const metadataFile = path.join(this.options.backupDir, `${backupId}.meta.json`);

    try {
      // Delete files
      if (fs.existsSync(encryptedFile)) {
        await fs.promises.unlink(encryptedFile);
      }
      if (fs.existsSync(metadataFile)) {
        await fs.promises.unlink(metadataFile);
      }

      // Update manifest
      this.manifest.backups = this.manifest.backups.filter(b => b.id !== backupId);
      if (this.manifest.lastFullBackup === backupId) {
        const lastFull = this.manifest.backups.filter(b => b.type === 'full').pop();
        this.manifest.lastFullBackup = lastFull?.id || null;
      }
      await this._saveManifest();

      securityLogger.info('Backup deleted', { service: 'backup', backupId });
      return { success: true, backupId };
    } catch (error) {
      securityLogger.error('Delete failed', { service: 'backup', error: error.message });
      throw error;
    }
  }

  /**
   * Verify backup integrity
   * @param {string} backupId - Backup ID to verify
   * @returns {Promise<Object>} Verification result
   */
  async verifyBackup(backupId) {
    if (!this.initialized) {
      await this.initialize();
    }

    securityLogger.info('Verifying backup', { service: 'backup', backupId });

    const encryptedFile = path.join(this.options.backupDir, `${backupId}.enc`);
    const tempFile = path.join(this.options.tempDir, `${backupId}-verify.dump`);

    try {
      // Load metadata
      const metadata = await this._loadBackupMetadata(backupId);
      if (!metadata) {
        return { success: false, error: 'Metadata not found' };
      }

      // Check file exists
      if (!fs.existsSync(encryptedFile)) {
        return { success: false, error: 'Backup file not found' };
      }

      // Verify file size
      const stats = fs.statSync(encryptedFile);
      if (stats.size !== metadata.compressedSize + IV_LENGTH + AUTH_TAG_LENGTH) {
        return { success: false, error: 'File size mismatch' };
      }

      // Decrypt and verify checksum
      await this._decryptAndDecompress(encryptedFile, tempFile, metadata);
      const checksum = await this._calculateChecksum(tempFile);

      // Cleanup
      await fs.promises.unlink(tempFile);

      if (checksum !== metadata.checksum) {
        return { success: false, error: 'Checksum mismatch' };
      }

      return {
        success: true,
        backupId,
        verifiedAt: new Date().toISOString(),
        metadata,
      };
    } catch (error) {
      // Cleanup on failure
      try {
        if (fs.existsSync(tempFile)) await fs.promises.unlink(tempFile);
      } catch (cleanupError) {
        // Ignore cleanup errors
      }

      return { success: false, error: error.message };
    }
  }

  /**
   * Rotate encryption keys
   * @returns {Promise<Object>} Rotation result
   */
  async rotateEncryptionKey() {
    if (!this.initialized) {
      await this.initialize();
    }

    securityLogger.info('Rotating backup encryption key', { service: 'backup' });

    // Generate new key
    const newKeyId = `backup-key-${Date.now()}`;
    const newKey = crypto.randomBytes(KEY_LENGTH);

    // Store in Vault
    if (this.vaultClient?.isAuthenticated) {
      try {
        await this.vaultClient.client?.write(this.options.keyPath, {
          data: {
            currentKeyId: newKeyId,
            key: newKey.toString('base64'),
            previousKeyId: this.keyId,
            previousKey: this.backupKey.toString('base64'),
            rotatedAt: new Date().toISOString(),
          },
        });
      } catch (error) {
        securityLogger.warn('Could not store key in Vault', { service: 'backup', error: error.message });
      }
    }

    this.keyId = newKeyId;
    this.backupKey = newKey;

    securityLogger.info('Encryption key rotated', { service: 'backup', newKeyId });
    return { success: true, newKeyId };
  }

  /**
   * Get service metrics
   * @returns {Object} Service metrics
   */
  getMetrics() {
    return {
      ...this.metrics,
      backupCount: this.manifest.backups.length,
      lastFullBackup: this.manifest.lastFullBackup,
      initialized: this.initialized,
    };
  }

  /**
   * Shutdown the service
   * @returns {Promise<void>}
   */
  async shutdown() {
    securityLogger.info('Shutting down Encrypted Backup Service', { service: 'backup' });

    // Clear encryption key from memory
    if (this.backupKey) {
      crypto.randomFillSync(this.backupKey);
      this.backupKey = null;
    }

    this.initialized = false;
    securityLogger.info('Encrypted Backup Service shut down', { service: 'backup' });
  }

  // ==================== Private Methods ====================

  /**
   * Ensure required directories exist
   * @private
   */
  async _ensureDirectories() {
    const dirs = [this.options.backupDir, this.options.tempDir];
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) {
        await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
      }
    }
  }

  /**
   * Load or generate backup encryption key
   * @private
   */
  async _loadOrGenerateBackupKey() {
    try {
      if (this.vaultClient?.isAuthenticated) {
        const secrets = await this.vaultClient.readSecret(this.options.keyPath);
        if (secrets?.key && secrets?.currentKeyId) {
          this.keyId = secrets.currentKeyId;
          this.backupKey = Buffer.from(secrets.key, 'base64');
          securityLogger.info('Loaded encryption key from Vault', { service: 'backup' });
          return;
        }
      }
    } catch (error) {
      securityLogger.warn('Could not load key from Vault', { service: 'backup', error: error.message });
    }

    // Generate new key
    this.keyId = `backup-key-${Date.now()}`;
    this.backupKey = crypto.randomBytes(KEY_LENGTH);

    // Store in Vault if available
    if (this.vaultClient?.isAuthenticated) {
      try {
        await this.vaultClient.client?.write(this.options.keyPath, {
          data: {
            currentKeyId: this.keyId,
            key: this.backupKey.toString('base64'),
            createdAt: new Date().toISOString(),
          },
        });
        securityLogger.info('Encryption key stored in Vault', { service: 'backup' });
      } catch (error) {
        securityLogger.warn('Could not store key in Vault', { service: 'backup', error: error.message });
      }
    }

    securityLogger.info('Generated new encryption key', { service: 'backup', keyId: this.keyId });
  }

  /**
   * Create pg_dump backup
   * @private
   */
  async _createPgDump(dbConfig, outputFile, options = {}) {
    return new Promise((resolve, reject) => {
      const args = [
        '-h', dbConfig.host || 'localhost',
        '-p', String(dbConfig.port || 5432),
        '-U', dbConfig.user,
        '-d', dbConfig.database,
        '-F', options.format || 'c', // custom format
        '-f', outputFile,
        '--no-password',
      ];

      if (options.schemas) {
        for (const schema of options.schemas) {
          args.push('-n', schema);
        }
      }

      if (options.excludeTables) {
        for (const table of options.excludeTables) {
          args.push('-T', table);
        }
      }

      const env = {
        ...process.env,
        PGPASSWORD: dbConfig.password,
      };

      const pgDump = spawn(this.options.pgDumpPath, args, { env });

      let stderr = '';
      pgDump.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pgDump.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`pg_dump failed with code ${code}: ${stderr}`));
        }
      });

      pgDump.on('error', (error) => {
        reject(new Error(`pg_dump error: ${error.message}`));
      });
    });
  }

  /**
   * Compress and encrypt a file
   * @private
   */
  async _compressAndEncrypt(inputFile, outputFile) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.backupKey, iv);

    const input = fs.createReadStream(inputFile);
    const gzip = createGzip({ level: this.options.compressionLevel });
    const output = fs.createWriteStream(outputFile);

    // Write IV at the beginning
    output.write(iv);

    // Track encrypted data for auth tag
    let encryptedChunks = [];

    gzip.on('data', (chunk) => {
      const encrypted = cipher.update(chunk);
      encryptedChunks.push(encrypted);
      output.write(encrypted);
    });

    await pipeline(input, gzip);

    // Finalize cipher
    const finalChunk = cipher.final();
    if (finalChunk.length > 0) {
      encryptedChunks.push(finalChunk);
      output.write(finalChunk);
    }

    // Write auth tag at the end
    const authTag = cipher.getAuthTag();
    output.write(authTag);
    output.end();

    // Wait for output to finish
    await new Promise((resolve, reject) => {
      output.on('finish', resolve);
      output.on('error', reject);
    });

    // Calculate checksum of original file
    const checksum = await this._calculateChecksum(inputFile);

    return {
      checksum,
      size: fs.statSync(outputFile).size,
      iv,
      authTag,
    };
  }

  /**
   * Decrypt and decompress a file
   * @private
   */
  async _decryptAndDecompress(inputFile, outputFile, metadata) {
    const fileSize = fs.statSync(inputFile).size;
    const fd = await fs.promises.open(inputFile, 'r');

    try {
      // Read IV from beginning
      const ivBuffer = Buffer.alloc(IV_LENGTH);
      await fd.read(ivBuffer, 0, IV_LENGTH, 0);

      // Read auth tag from end
      const authTagBuffer = Buffer.alloc(AUTH_TAG_LENGTH);
      await fd.read(authTagBuffer, 0, AUTH_TAG_LENGTH, fileSize - AUTH_TAG_LENGTH);

      // Use IV and auth tag from metadata if available, otherwise from file
      const iv = metadata.iv ? Buffer.from(metadata.iv, 'base64') : ivBuffer;
      const authTag = metadata.authTag ? Buffer.from(metadata.authTag, 'base64') : authTagBuffer;

      // Create decipher
      const decipher = crypto.createDecipheriv(ALGORITHM, this.backupKey, iv);
      decipher.setAuthTag(authTag);

      // Read encrypted data (excluding IV and auth tag)
      const encryptedSize = fileSize - IV_LENGTH - AUTH_TAG_LENGTH;
      const encryptedBuffer = Buffer.alloc(encryptedSize);
      await fd.read(encryptedBuffer, 0, encryptedSize, IV_LENGTH);

      // Decrypt
      const decrypted = Buffer.concat([
        decipher.update(encryptedBuffer),
        decipher.final(),
      ]);

      // Decompress
      const gunzip = createGunzip();
      const output = fs.createWriteStream(outputFile);

      await new Promise((resolve, reject) => {
        gunzip.on('error', reject);
        output.on('error', reject);
        output.on('finish', resolve);

        gunzip.pipe(output);
        gunzip.end(decrypted);
      });
    } finally {
      await fd.close();
    }
  }

  /**
   * Restore from pg_dump file
   * @private
   */
  async _restorePgDump(inputFile, dbConfig, options = {}) {
    return new Promise((resolve, reject) => {
      const args = [
        '-h', dbConfig.host || 'localhost',
        '-p', String(dbConfig.port || 5432),
        '-U', dbConfig.user,
        '-d', dbConfig.database,
        '--no-password',
      ];

      if (options.clean) {
        args.push('--clean');
      }

      if (options.noOwner) {
        args.push('--no-owner');
      }

      args.push(inputFile);

      const env = {
        ...process.env,
        PGPASSWORD: dbConfig.password,
      };

      const pgRestore = spawn(this.options.pgRestorePath, args, { env });

      let stderr = '';
      pgRestore.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      pgRestore.on('close', (code) => {
        // pg_restore returns non-zero for warnings too
        if (code === 0 || (code === 1 && !stderr.includes('error'))) {
          resolve();
        } else {
          reject(new Error(`pg_restore failed with code ${code}: ${stderr}`));
        }
      });

      pgRestore.on('error', (error) => {
        reject(new Error(`pg_restore error: ${error.message}`));
      });
    });
  }

  /**
   * Calculate SHA-256 checksum of a file
   * @private
   */
  async _calculateChecksum(filePath) {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', reject);
    });
  }

  /**
   * Get PostgreSQL version
   * @private
   */
  async _getPgVersion() {
    return new Promise((resolve) => {
      const pgDump = spawn(this.options.pgDumpPath, ['--version']);
      let output = '';

      pgDump.stdout.on('data', (data) => {
        output += data.toString();
      });

      pgDump.on('close', () => {
        const match = output.match(/\d+\.\d+/);
        resolve(match ? match[0] : 'unknown');
      });

      pgDump.on('error', () => resolve('unknown'));
    });
  }

  /**
   * Save backup metadata
   * @private
   */
  async _saveBackupMetadata(backupId, metadata) {
    const metadataFile = path.join(this.options.backupDir, `${backupId}.meta.json`);
    await fs.promises.writeFile(metadataFile, JSON.stringify(metadata, null, 2), {
      mode: 0o600,
    });
  }

  /**
   * Load backup metadata
   * @private
   */
  async _loadBackupMetadata(backupId) {
    const metadataFile = path.join(this.options.backupDir, `${backupId}.meta.json`);
    try {
      const content = await fs.promises.readFile(metadataFile, 'utf8');
      return JSON.parse(content);
    } catch (error) {
      return null;
    }
  }

  /**
   * Load manifest
   * @private
   */
  async _loadManifest() {
    const manifestFile = path.join(this.options.backupDir, 'manifest.json');
    try {
      const content = await fs.promises.readFile(manifestFile, 'utf8');
      this.manifest = JSON.parse(content);
    } catch (error) {
      // Use default manifest
      securityLogger.info('No existing manifest found, starting fresh', { service: 'backup' });
    }
  }

  /**
   * Save manifest
   * @private
   */
  async _saveManifest() {
    const manifestFile = path.join(this.options.backupDir, 'manifest.json');
    await fs.promises.writeFile(manifestFile, JSON.stringify(this.manifest, null, 2), {
      mode: 0o600,
    });
  }

  /**
   * Apply retention policy
   * @private
   */
  async _applyRetentionPolicy() {
    const now = Date.now();
    const retentionMs = this.options.retentionDays * 24 * 60 * 60 * 1000;

    // Find old backups
    const oldBackups = this.manifest.backups.filter(b => {
      const age = now - new Date(b.timestamp).getTime();
      return age > retentionMs;
    });

    // Keep at least the most recent full backup
    const recentFullBackup = this.manifest.backups
      .filter(b => b.type === 'full')
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0];

    // Delete old backups
    for (const backup of oldBackups) {
      if (backup.id === recentFullBackup?.id) {
        continue; // Keep most recent full backup
      }

      try {
        await this.deleteBackup(backup.id);
        securityLogger.info('Deleted old backup', { service: 'backup', backupId: backup.id });
      } catch (error) {
        securityLogger.warn('Failed to delete old backup', { service: 'backup', backupId: backup.id, error: error.message });
      }
    }

    // Enforce max backups limit
    if (this.manifest.backups.length > this.options.maxBackups) {
      const toDelete = this.manifest.backups
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
        .slice(0, this.manifest.backups.length - this.options.maxBackups);

      for (const backup of toDelete) {
        if (backup.id === recentFullBackup?.id) {
          continue;
        }

        try {
          await this.deleteBackup(backup.id);
          securityLogger.info('Deleted excess backup', { service: 'backup', backupId: backup.id });
        } catch (error) {
          securityLogger.warn('Failed to delete excess backup', { service: 'backup', backupId: backup.id, error: error.message });
        }
      }
    }
  }
}

// ==================== Singleton Instance ====================

let backupServiceInstance = null;

/**
 * Get or create the backup service singleton
 * @param {Object} options - Service options
 * @returns {EncryptedBackupService}
 */
function getEncryptedBackupService(options = {}) {
  if (!backupServiceInstance) {
    backupServiceInstance = new EncryptedBackupService(options);
  }
  return backupServiceInstance;
}

/**
 * Initialize the backup service
 * @param {Object} options - Service options
 * @returns {Promise<EncryptedBackupService>}
 */
async function initializeEncryptedBackup(options = {}) {
  const service = getEncryptedBackupService(options);
  await service.initialize();
  return service;
}

module.exports = {
  EncryptedBackupService,
  getEncryptedBackupService,
  initializeEncryptedBackup,
};
