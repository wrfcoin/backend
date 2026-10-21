/**
 * Local Storage Provider
 * High-performance local filesystem operations with proper organization and security
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import { vaultIntegrationService } from './vault-integration-service.js';

export interface LocalStorageConfig {
  basePath: string;
  tempPath: string;
  maxFileSize: number;
  allowedExtensions?: string[];
  compressionEnabled: boolean;
  encryptionEnabled: boolean;
  permissions: number; // File permissions (e.g., 0o600)
}

export interface LocalStorageResult {
  path: string;
  checksum: string;
  size: number;
  isEncrypted: boolean;
  metadata: Record<string, any>;
}

export interface ProcessedFile {
  data: Buffer;
  originalName: string;
  mimeType: string;
  size: number;
  checksum: string;
}

export class LocalStorageProvider {
  private config: LocalStorageConfig;
  private isInitialized: boolean = false;

  constructor() {
    this.config = {
      basePath: process.env.LOCAL_STORAGE_PATH || '/opt/wrfcoin/storage',
      tempPath: process.env.LOCAL_TEMP_PATH || '/tmp/wrfcoin',
      maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '1073741824'), // 1GB default
      allowedExtensions: process.env.ALLOWED_EXTENSIONS?.split(','),
      compressionEnabled: process.env.COMPRESSION_ENABLED === 'true',
      encryptionEnabled: process.env.ENCRYPTION_ENABLED !== 'false', // Default true
      permissions: parseInt(process.env.FILE_PERMISSIONS || '0o600', 8),
    };
  }

  /**
   * Initialize local storage provider
   */
  async initialize(): Promise<void> {
    try {
      logger.info('[LocalStorage] Initializing local storage provider', {
        basePath: this.config.basePath,
        tempPath: this.config.tempPath,
        encryptionEnabled: this.config.encryptionEnabled,
      });

      // Create required directories
      await this.createDirectories();

      // Verify permissions and access
      await this.verifyAccess();

      // Clean up temporary files
      await this.cleanupTempFiles();

      this.isInitialized = true;
      logger.info(
        '[LocalStorage] Local storage provider initialized successfully'
      );
    } catch (error) {
      logger.error(
        '[LocalStorage] Failed to initialize local storage provider',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }

  /**
   * Store file locally with optional encryption
   */
  async store(
    fileId: string,
    file: ProcessedFile
  ): Promise<LocalStorageResult> {
    if (!this.isInitialized) {
      throw new Error('Local storage provider not initialized');
    }

    try {
      logger.info('[LocalStorage] Storing file locally', {
        fileId,
        originalName: file.originalName,
        size: file.size,
        mimeType: file.mimeType,
      });

      // Validate file
      await this.validateFile(file);

      // Generate storage path
      const storagePath = this.generateStoragePath(fileId, file.originalName);
      const fullPath = path.join(this.config.basePath, storagePath);

      // Ensure directory exists
      await fs.mkdir(path.dirname(fullPath), { recursive: true });

      let processedData = file.data;
      let isEncrypted = false;
      let encryptionKeyId: string | undefined;

      // Apply encryption if enabled
      if (this.config.encryptionEnabled) {
        const encryptionResult = await this.encryptFile(fileId, file.data);
        processedData = encryptionResult.encryptedData;
        isEncrypted = true;
        encryptionKeyId = encryptionResult.keyId;
      }

      // Write file to disk
      await fs.writeFile(fullPath, processedData, {
        mode: this.config.permissions,
      });

      // Verify write success
      const stats = await fs.stat(fullPath);
      const actualChecksum = await this.calculateChecksum(fullPath);

      // Store metadata
      const metadata = {
        originalName: file.originalName,
        mimeType: file.mimeType,
        originalSize: file.size,
        storedSize: stats.size,
        storedAt: new Date().toISOString(),
        encryptionKeyId,
        permissions: this.config.permissions.toString(8),
      };

      await this.storeMetadata(fileId, metadata);

      const result: LocalStorageResult = {
        path: storagePath,
        checksum: isEncrypted ? actualChecksum : file.checksum, // Use actual checksum for encrypted files
        size: stats.size,
        isEncrypted,
        metadata,
      };

      logger.info('[LocalStorage] File stored successfully', {
        fileId,
        path: storagePath,
        size: stats.size,
        isEncrypted,
      });

      return result;
    } catch (error) {
      logger.error('[LocalStorage] Error storing file', {
        fileId,
        file: { ...file, data: '[REDACTED]' },
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Retrieve file from local storage
   */
  async retrieve(fileId: string, storagePath: string): Promise<Buffer> {
    if (!this.isInitialized) {
      throw new Error('Local storage provider not initialized');
    }

    try {
      logger.info('[LocalStorage] Retrieving file from local storage', {
        fileId,
        storagePath,
      });

      const fullPath = path.join(this.config.basePath, storagePath);

      // Check if file exists
      try {
        await fs.access(fullPath, fs.constants.R_OK);
      } catch {
        throw new Error(`File not found or not readable: ${storagePath}`);
      }

      // Read file data
      const data = await fs.readFile(fullPath);

      // Load metadata to check if file is encrypted
      const metadata = await this.loadMetadata(fileId);

      let result: Buffer = data;

      // Decrypt if necessary
      if (metadata?.encryptionKeyId) {
        result = await this.decryptFile(metadata.encryptionKeyId, data) as Buffer;
      }

      logger.info('[LocalStorage] File retrieved successfully', {
        fileId,
        size: result.length,
        wasEncrypted: !!metadata?.encryptionKeyId,
      });

      return result;
    } catch (error) {
      logger.error('[LocalStorage] Error retrieving file', {
        fileId,
        storagePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Delete file from local storage
   */
  async delete(fileId: string, storagePath: string): Promise<void> {
    if (!this.isInitialized) {
      throw new Error('Local storage provider not initialized');
    }

    try {
      logger.info('[LocalStorage] Deleting file from local storage', {
        fileId,
        storagePath,
      });

      const fullPath = path.join(this.config.basePath, storagePath);

      // Check if file exists
      try {
        await fs.access(fullPath);
      } catch {
        logger.warn('[LocalStorage] File already deleted or not found', {
          fileId,
          storagePath,
        });
        return;
      }

      // Delete file
      await fs.unlink(fullPath);

      // Delete metadata
      await this.deleteMetadata(fileId);

      // Clean up empty directories
      await this.cleanupEmptyDirectories(path.dirname(fullPath));

      logger.info('[LocalStorage] File deleted successfully', {
        fileId,
        storagePath,
      });
    } catch (error) {
      logger.error('[LocalStorage] Error deleting file', {
        fileId,
        storagePath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get storage health status
   */
  async getHealthStatus(): Promise<{
    isHealthy: boolean;
    freeSpace: number;
    totalSpace: number;
    fileCount: number;
    issues: string[];
  }> {
    try {
      const stats = fs.statfs ? await fs.statfs(this.config.basePath) : null;
      const fileCount = await this.countFiles();

      const issues: string[] = [];

      // Check free space (warn if less than 1GB)
      const freeSpace = stats ? stats.bavail * stats.bsize : 0;
      const totalSpace = stats ? stats.blocks * stats.bsize : 0;

      if (freeSpace < 1024 * 1024 * 1024) {
        issues.push('Low disk space');
      }

      // Check directory permissions
      try {
        await fs.access(
          this.config.basePath,
          fs.constants.W_OK | fs.constants.R_OK
        );
      } catch {
        issues.push('Directory access issues');
      }

      const isHealthy = issues.length === 0;

      return {
        isHealthy,
        freeSpace,
        totalSpace,
        fileCount,
        issues,
      };
    } catch (error) {
      logger.error('[LocalStorage] Error getting health status', {
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        isHealthy: false,
        freeSpace: 0,
        totalSpace: 0,
        fileCount: 0,
        issues: ['Health check failed'],
      };
    }
  }

  /**
   * Cleanup old temporary files
   */
  async cleanupTempFiles(): Promise<void> {
    try {
      logger.info('[LocalStorage] Cleaning up temporary files');

      // Check if temp directory exists
      try {
        await fs.access(this.config.tempPath);
      } catch {
        return; // Temp directory doesn't exist, nothing to clean
      }

      const tempFiles = await fs.readdir(this.config.tempPath);
      const now = Date.now();
      const maxAge = 24 * 60 * 60 * 1000; // 24 hours

      for (const file of tempFiles) {
        const filePath = path.join(this.config.tempPath, file);
        const stats = await fs.stat(filePath);

        if (now - stats.mtime.getTime() > maxAge) {
          await fs.unlink(filePath);
          logger.debug('[LocalStorage] Deleted old temp file', { file });
        }
      }

      logger.info('[LocalStorage] Temporary file cleanup completed');
    } catch (error) {
      logger.error('[LocalStorage] Error cleaning up temp files', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create required directories
   */
  private async createDirectories(): Promise<void> {
    const directories = [
      this.config.basePath,
      this.config.tempPath,
      path.join(this.config.basePath, 'metadata'),
      path.join(this.config.basePath, 'data'),
    ];

    for (const dir of directories) {
      await fs.mkdir(dir, { recursive: true, mode: 0o750 });
    }
  }

  /**
   * Verify access to storage directories
   */
  private async verifyAccess(): Promise<void> {
    const testFile = path.join(this.config.basePath, '.access_test');

    try {
      await fs.writeFile(testFile, 'test');
      await fs.access(testFile, fs.constants.R_OK | fs.constants.W_OK);
      await fs.unlink(testFile);
    } catch (error) {
      throw new Error(`Storage directory access verification failed: ${error}`);
    }
  }

  /**
   * Validate file before storage
   */
  private async validateFile(file: ProcessedFile): Promise<void> {
    // Check file size
    if (file.size > this.config.maxFileSize) {
      throw new Error(
        `File size ${file.size} exceeds maximum allowed size ${this.config.maxFileSize}`
      );
    }

    // Check file extension if restrictions are configured
    if (
      this.config.allowedExtensions &&
      this.config.allowedExtensions.length > 0
    ) {
      const extension = path.extname(file.originalName).toLowerCase();
      if (!this.config.allowedExtensions.includes(extension)) {
        throw new Error(`File extension ${extension} is not allowed`);
      }
    }

    // Verify checksum
    const actualChecksum = crypto
      .createHash('sha256')
      .update(file.data)
      .digest('hex');
    if (actualChecksum !== file.checksum) {
      throw new Error('File checksum verification failed');
    }
  }

  /**
   * Generate storage path for file
   */
  private generateStoragePath(fileId: string, originalName: string): string {
    // Create directory structure based on file ID for even distribution
    const hash = crypto.createHash('md5').update(fileId).digest('hex');
    const dir1 = hash.substring(0, 2);
    const dir2 = hash.substring(2, 4);

    // Use timestamp and hash for unique filename
    const timestamp = Date.now();
    const extension = path.extname(originalName);
    const filename = `${fileId}_${timestamp}${extension}`;

    return path.join('data', dir1, dir2, filename);
  }

  /**
   * Encrypt file data
   */
  private async encryptFile(
    fileId: string,
    data: Buffer
  ): Promise<{
    encryptedData: Buffer;
    keyId: string;
  }> {
    try {
      // Generate encryption key
      const encryptionKey =
        await vaultIntegrationService.generateFileEncryptionKey(fileId, {
          storageProvider: 'local',
          encryptedAt: new Date().toISOString(),
        });

      // Encrypt the data
      const encryptedDataString = await vaultIntegrationService.encryptData(
        encryptionKey.keyId,
        data.toString('base64')
      );

      const encryptedData = Buffer.from(encryptedDataString, 'base64');

      return {
        encryptedData,
        keyId: encryptionKey.keyId,
      };
    } catch (error) {
      logger.error('[LocalStorage] File encryption failed', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Decrypt file data
   */
  private async decryptFile(
    keyId: string,
    encryptedData: Buffer
  ): Promise<Buffer> {
    try {
      const encryptedDataString = encryptedData.toString('base64');
      const decryptedDataString = await vaultIntegrationService.decryptData(
        keyId,
        encryptedDataString
      );

      return Buffer.from(decryptedDataString, 'base64');
    } catch (error) {
      logger.error('[LocalStorage] File decryption failed', {
        keyId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Store file metadata
   */
  private async storeMetadata(
    fileId: string,
    metadata: Record<string, any>
  ): Promise<void> {
    const metadataPath = path.join(
      this.config.basePath,
      'metadata',
      `${fileId}.json`
    );
    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), {
      mode: this.config.permissions,
    });
  }

  /**
   * Load file metadata
   */
  private async loadMetadata(
    fileId: string
  ): Promise<Record<string, any> | null> {
    try {
      const metadataPath = path.join(
        this.config.basePath,
        'metadata',
        `${fileId}.json`
      );
      const data = await fs.readFile(metadataPath, 'utf8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Delete file metadata
   */
  private async deleteMetadata(fileId: string): Promise<void> {
    try {
      const metadataPath = path.join(
        this.config.basePath,
        'metadata',
        `${fileId}.json`
      );
      await fs.unlink(metadataPath);
    } catch {
      // Metadata file doesn't exist, ignore
    }
  }

  /**
   * Calculate file checksum
   */
  private async calculateChecksum(filePath: string): Promise<string> {
    const data = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Clean up empty directories
   */
  private async cleanupEmptyDirectories(dirPath: string): Promise<void> {
    try {
      if (dirPath === this.config.basePath) {
        return; // Don't remove base directory
      }

      const files = await fs.readdir(dirPath);
      if (files.length === 0) {
        await fs.rmdir(dirPath);
        // Recursively clean parent directories
        await this.cleanupEmptyDirectories(path.dirname(dirPath));
      }
    } catch {
      // Directory not empty or other error, ignore
    }
  }

  /**
   * Count total files in storage
   */
  private async countFiles(): Promise<number> {
    try {
      const dataPath = path.join(this.config.basePath, 'data');
      let count = 0;

      const countFilesRecursive = async (dir: string): Promise<void> => {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isFile()) {
            count++;
          } else if (entry.isDirectory()) {
            await countFilesRecursive(path.join(dir, entry.name));
          }
        }
      };

      await countFilesRecursive(dataPath);
      return count;
    } catch {
      return 0;
    }
  }
}

export const localStorageProvider = new LocalStorageProvider();
