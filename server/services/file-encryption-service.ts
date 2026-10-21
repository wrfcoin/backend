/**
 * File Encryption Service with HSM Integration
 *
 * Implements envelope encryption pattern:
 * 1. Generate random Data Encryption Key (DEK) for each file
 * 2. Encrypt file content with DEK using AES-256-GCM
 * 3. Encrypt DEK with HSM Key Encryption Key (KEK)
 * 4. Store encrypted DEK, IV, authTag with file metadata
 *
 * Auto-encryption policy (user confirmed):
 * - Files > 10MB are auto-encrypted
 * - Sensitive file types: PDF, DOC/DOCX, XLS/XLSX, ZIP, TAR
 * - Optional encryption via encrypt=true parameter for other files
 */

import crypto from 'crypto';
import { appLogger } from '../utils/logger.js';
import { v4 as uuidv4 } from 'uuid';
import { db } from '../../database/db.js';
import { fileEncryptionKeys, files } from '../../shared/file-schema.js';
import { eq, and } from 'drizzle-orm';

// HSM types and integration
interface HSMService {
  encryptWithKEK(data: Buffer, keyHandle: string): Promise<Buffer>;
  decryptWithKEK(encryptedData: Buffer, keyHandle: string): Promise<Buffer>;
  getActiveKEKHandle(): Promise<string>;
  rotateKEK(oldHandle: string): Promise<string>;
}

// Encryption configuration
interface EncryptionConfig {
  algorithm: 'AES-256-GCM' | 'AES-256-CBC' | 'CHACHA20-POLY1305';
  keySize: number; // in bytes
  ivSize: number; // in bytes
  authTagSize: number; // in bytes (for GCM)
}

// Default configuration for AES-256-GCM
const DEFAULT_CONFIG: EncryptionConfig = {
  algorithm: 'AES-256-GCM',
  keySize: 32, // 256 bits
  ivSize: 12, // 96 bits for GCM
  authTagSize: 16, // 128 bits
};

// File types that require automatic encryption
const SENSITIVE_MIME_TYPES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/zip',
  'application/x-zip-compressed',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-7z-compressed',
  'application/x-rar-compressed',
]);

// File extensions that require automatic encryption
const SENSITIVE_EXTENSIONS = new Set([
  '.pdf',
  '.doc',
  '.docx',
  '.xls',
  '.xlsx',
  '.zip',
  '.tar',
  '.gz',
  '.7z',
  '.rar',
  '.key',
  '.pem',
  '.crt',
  '.p12',
  '.pfx',
]);

// Size threshold for auto-encryption (10MB)
const AUTO_ENCRYPT_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10MB

// Encryption result
interface EncryptionResult {
  encryptedData: Buffer;
  keyId: string;
  iv: string; // base64
  authTag: string; // base64
  algorithm: string;
  kekHandle: string;
  originalSize: number;
  encryptedSize: number;
}

// Decryption result
interface DecryptionResult {
  decryptedData: Buffer;
  originalSize: number;
  keyId: string;
}

// Encryption policy decision
interface EncryptionPolicy {
  shouldEncrypt: boolean;
  reason: string;
  isForced: boolean;
}

/**
 * File Encryption Service
 * Provides HSM-backed envelope encryption for file storage
 */
export class FileEncryptionService {
  private config: EncryptionConfig;
  private hsmService: HSMService | null = null;
  private useSimulation: boolean;

  constructor(config?: Partial<EncryptionConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.useSimulation = process.env.HSM_SIMULATION_MODE === 'true' ||
      process.env.NODE_ENV === 'development' ||
      process.env.NODE_ENV === 'test';
  }

  /**
   * Initialize HSM connection
   */
  async initialize(hsmService?: HSMService): Promise<void> {
    if (hsmService) {
      this.hsmService = hsmService;
    } else if (!this.useSimulation) {
      // In production, require HSM service
      throw new Error('HSM service required in production mode');
    }
    appLogger.info('File Encryption Service initialized', { module: 'FileEncryptionService', operation: 'initialize', simulation: this.useSimulation });
  }

  /**
   * Determine if a file should be encrypted based on policy
   */
  determineEncryptionPolicy(
    fileSize: number,
    mimeType: string,
    fileName: string,
    forceEncrypt?: boolean
  ): EncryptionPolicy {
    // Force encryption if explicitly requested
    if (forceEncrypt) {
      return {
        shouldEncrypt: true,
        reason: 'Encryption explicitly requested',
        isForced: true,
      };
    }

    // Check file size threshold
    if (fileSize >= AUTO_ENCRYPT_SIZE_THRESHOLD) {
      return {
        shouldEncrypt: true,
        reason: `File size (${(fileSize / 1024 / 1024).toFixed(2)}MB) exceeds threshold (10MB)`,
        isForced: false,
      };
    }

    // Check MIME type
    if (SENSITIVE_MIME_TYPES.has(mimeType)) {
      return {
        shouldEncrypt: true,
        reason: `Sensitive MIME type: ${mimeType}`,
        isForced: false,
      };
    }

    // Check file extension
    const ext = fileName.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
    if (ext && SENSITIVE_EXTENSIONS.has(ext)) {
      return {
        shouldEncrypt: true,
        reason: `Sensitive file extension: ${ext}`,
        isForced: false,
      };
    }

    return {
      shouldEncrypt: false,
      reason: 'File does not meet auto-encryption criteria',
      isForced: false,
    };
  }

  /**
   * Encrypt file data using envelope encryption
   */
  async encryptFile(
    fileData: Buffer,
    fileId: string,
    metadata?: Record<string, any>
  ): Promise<EncryptionResult> {
    // Generate random DEK (Data Encryption Key)
    const dek = crypto.randomBytes(this.config.keySize);

    // Generate random IV
    const iv = crypto.randomBytes(this.config.ivSize);

    // Encrypt file data with DEK using AES-256-GCM
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
    const encryptedData = Buffer.concat([
      cipher.update(fileData),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    // Get KEK handle from HSM
    const kekHandle = await this.getKEKHandle();

    // Encrypt DEK with HSM KEK
    const encryptedDEK = await this.encryptDEKWithKEK(dek, kekHandle);

    // Generate unique key ID
    const keyId = uuidv4();

    // Store encrypted key metadata in database
    await this.storeEncryptionKey({
      keyId,
      fileId,
      encryptedKey: encryptedDEK.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      algorithm: this.config.algorithm,
      kekHandle,
      metadata,
    });

    // Securely clear DEK from memory
    dek.fill(0);

    return {
      encryptedData,
      keyId,
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      algorithm: this.config.algorithm,
      kekHandle,
      originalSize: fileData.length,
      encryptedSize: encryptedData.length,
    };
  }

  /**
   * Decrypt file data using stored encryption key
   */
  async decryptFile(
    encryptedData: Buffer,
    fileId: string
  ): Promise<DecryptionResult> {
    // Retrieve encryption key metadata from database
    const keyRecord = await this.getEncryptionKey(fileId);
    if (!keyRecord) {
      throw new Error(`No encryption key found for file: ${fileId}`);
    }

    // Decrypt DEK with HSM KEK
    const encryptedDEK = Buffer.from(keyRecord.encryptedKey, 'base64');
    const dek = await this.decryptDEKWithKEK(encryptedDEK, keyRecord.kekHandle);

    // Prepare IV and authTag
    const iv = Buffer.from(keyRecord.iv, 'base64');
    const authTag = Buffer.from(keyRecord.authTag, 'base64');

    // Decrypt file data with DEK
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
    decipher.setAuthTag(authTag);

    try {
      const decryptedData = Buffer.concat([
        decipher.update(encryptedData),
        decipher.final(),
      ]);

      // Securely clear DEK from memory
      dek.fill(0);

      return {
        decryptedData,
        originalSize: decryptedData.length,
        keyId: keyRecord.keyId,
      };
    } catch (error) {
      // Securely clear DEK from memory even on error
      dek.fill(0);
      throw new Error(`Decryption failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Re-encrypt file with new DEK (for key rotation)
   */
  async reEncryptFile(
    encryptedData: Buffer,
    fileId: string
  ): Promise<EncryptionResult> {
    // First decrypt with old key
    const { decryptedData } = await this.decryptFile(encryptedData, fileId);

    // Mark old key as inactive
    await this.deactivateEncryptionKey(fileId);

    // Re-encrypt with new key
    return this.encryptFile(decryptedData, fileId, {
      reEncrypted: true,
      reEncryptedAt: new Date().toISOString(),
    });
  }

  /**
   * Rotate KEK and re-wrap all DEKs
   */
  async rotateKEK(oldKekHandle: string): Promise<{
    newKekHandle: string;
    keysRotated: number;
    errors: string[];
  }> {
    // Get new KEK from HSM
    const newKekHandle = await this.rotateHSMKEK(oldKekHandle);

    // Find all keys using the old KEK
    const keysToRotate = await db
      .select()
      .from(fileEncryptionKeys)
      .where(
        and(
          eq(fileEncryptionKeys.kekHandle, oldKekHandle),
          eq(fileEncryptionKeys.isActive, true)
        )
      );

    let keysRotated = 0;
    const errors: string[] = [];

    // Re-wrap each DEK with new KEK
    for (const keyRecord of keysToRotate) {
      try {
        // Decrypt DEK with old KEK
        const encryptedDEK = Buffer.from(keyRecord.encryptedKey, 'base64');
        const dek = await this.decryptDEKWithKEK(encryptedDEK, oldKekHandle);

        // Re-encrypt DEK with new KEK
        const newEncryptedDEK = await this.encryptDEKWithKEK(dek, newKekHandle);

        // Update database record
        await db
          .update(fileEncryptionKeys)
          .set({
            encryptedKey: newEncryptedDEK.toString('base64'),
            kekHandle: newKekHandle,
            keyVersion: keyRecord.keyVersion + 1,
            rotatedAt: new Date(),
          })
          .where(eq(fileEncryptionKeys.id, keyRecord.id));

        // Clear DEK from memory
        dek.fill(0);
        keysRotated++;
      } catch (error) {
        errors.push(`Failed to rotate key ${keyRecord.keyId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    return { newKekHandle, keysRotated, errors };
  }

  /**
   * Check if a file is encrypted
   */
  async isFileEncrypted(fileId: string): Promise<boolean> {
    const keyRecord = await this.getEncryptionKey(fileId);
    return keyRecord !== null;
  }

  /**
   * Get encryption metadata for a file
   */
  async getEncryptionMetadata(fileId: string): Promise<{
    isEncrypted: boolean;
    keyId?: string;
    algorithm?: string;
    keyVersion?: number;
    createdAt?: Date;
    rotatedAt?: Date | null;
  }> {
    const keyRecord = await this.getEncryptionKey(fileId);

    if (!keyRecord) {
      return { isEncrypted: false };
    }

    return {
      isEncrypted: true,
      keyId: keyRecord.keyId,
      algorithm: keyRecord.algorithm,
      keyVersion: keyRecord.keyVersion,
      createdAt: keyRecord.createdAt,
      rotatedAt: keyRecord.rotatedAt,
    };
  }

  // Private helper methods

  /**
   * Get active KEK handle from HSM
   */
  private async getKEKHandle(): Promise<string> {
    if (this.hsmService) {
      return this.hsmService.getActiveKEKHandle();
    }

    // Simulation mode - use a fixed handle
    return process.env.HSM_FILE_KEK_HANDLE || 'sim-file-kek-001';
  }

  /**
   * Encrypt DEK with HSM KEK
   */
  private async encryptDEKWithKEK(dek: Buffer, kekHandle: string): Promise<Buffer> {
    if (this.hsmService) {
      return this.hsmService.encryptWithKEK(dek, kekHandle);
    }

    // Simulation mode - use local encryption with derived key
    const simulatedKEK = this.deriveSimulatedKEK(kekHandle);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', simulatedKEK, iv);
    const encrypted = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();

    // Return IV + authTag + encrypted data
    return Buffer.concat([iv, authTag, encrypted]);
  }

  /**
   * Decrypt DEK with HSM KEK
   */
  private async decryptDEKWithKEK(encryptedDEK: Buffer, kekHandle: string): Promise<Buffer> {
    if (this.hsmService) {
      return this.hsmService.decryptWithKEK(encryptedDEK, kekHandle);
    }

    // Simulation mode - use local decryption
    const simulatedKEK = this.deriveSimulatedKEK(kekHandle);
    const iv = encryptedDEK.subarray(0, 12);
    const authTag = encryptedDEK.subarray(12, 28);
    const encrypted = encryptedDEK.subarray(28);

    const decipher = crypto.createDecipheriv('aes-256-gcm', simulatedKEK, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]);
  }

  /**
   * Rotate HSM KEK
   */
  private async rotateHSMKEK(oldKekHandle: string): Promise<string> {
    if (this.hsmService) {
      return this.hsmService.rotateKEK(oldKekHandle);
    }

    // Simulation mode - generate new handle
    return `sim-file-kek-${Date.now()}`;
  }

  /**
   * Derive simulated KEK from handle (development only)
   */
  private deriveSimulatedKEK(handle: string): Buffer {
    const secret = process.env.HSM_SIMULATION_SECRET || 'wrfcoin-dev-simulation-secret';
    return crypto.pbkdf2Sync(secret, handle, 100000, 32, 'sha256');
  }

  /**
   * Store encryption key in database
   */
  private async storeEncryptionKey(params: {
    keyId: string;
    fileId: string;
    encryptedKey: string;
    iv: string;
    authTag: string;
    algorithm: string;
    kekHandle: string;
    metadata?: Record<string, any>;
  }): Promise<void> {
    await db.insert(fileEncryptionKeys).values({
      keyId: params.keyId,
      fileId: params.fileId,
      encryptedKey: params.encryptedKey,
      iv: params.iv,
      authTag: params.authTag,
      algorithm: params.algorithm,
      kekHandle: params.kekHandle,
      keyVersion: 1,
      isActive: true,
      metadata: params.metadata || null,
      createdAt: new Date(),
    });
  }

  /**
   * Get encryption key from database
   */
  private async getEncryptionKey(fileId: string): Promise<{
    keyId: string;
    encryptedKey: string;
    iv: string;
    authTag: string;
    algorithm: string;
    kekHandle: string;
    keyVersion: number;
    createdAt: Date;
    rotatedAt: Date | null;
  } | null> {
    const results = await db
      .select()
      .from(fileEncryptionKeys)
      .where(
        and(
          eq(fileEncryptionKeys.fileId, fileId),
          eq(fileEncryptionKeys.isActive, true)
        )
      )
      .limit(1);

    if (results.length === 0) {
      return null;
    }

    return {
      keyId: results[0].keyId,
      encryptedKey: results[0].encryptedKey,
      iv: results[0].iv,
      authTag: results[0].authTag,
      algorithm: results[0].algorithm,
      kekHandle: results[0].kekHandle,
      keyVersion: results[0].keyVersion,
      createdAt: results[0].createdAt,
      rotatedAt: results[0].rotatedAt,
    };
  }

  /**
   * Deactivate encryption key (for rotation)
   */
  private async deactivateEncryptionKey(fileId: string): Promise<void> {
    await db
      .update(fileEncryptionKeys)
      .set({ isActive: false })
      .where(
        and(
          eq(fileEncryptionKeys.fileId, fileId),
          eq(fileEncryptionKeys.isActive, true)
        )
      );
  }
}

// Export singleton instance
export const fileEncryptionService = new FileEncryptionService();

// Export types
export type {
  EncryptionConfig,
  EncryptionResult,
  DecryptionResult,
  EncryptionPolicy,
  HSMService,
};

// Export constants
export {
  SENSITIVE_MIME_TYPES,
  SENSITIVE_EXTENSIONS,
  AUTO_ENCRYPT_SIZE_THRESHOLD,
  DEFAULT_CONFIG,
};
