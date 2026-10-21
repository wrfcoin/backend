/**
 * Enhanced File Storage Service with Permission Integration
 * Extends the existing enhanced-storage.ts patterns for file management
 */

import * as drizzleOrm from 'drizzle-orm';
import type * as drizzleOrmEsm from '../../node_modules/drizzle-orm/index.js';
import { db } from '../../database/db.js';
import * as crypto from 'crypto';
import * as path from 'path';
import { logger } from '../../utils/logger.js';
import fieldNameConverter from '../../utils/fieldNameConverter.js';

import {
  files,
  filePermissions,
  fileAccessLogs,
  fileShares,
  PERMISSION_LEVELS,
  PermissionLevel,
  FileVisibility,
  type File,
  type InsertFile,
  type FilePermission,
  type FileShare,
} from '../../shared/file-schema.js';

import {
  filePermissionService,
  FileAccessContext,
} from './file-permission-service.js';

// Re-export FileAccessContext for external modules
export { FileAccessContext } from './file-permission-service.js';
import {
  vaultIntegrationService,
  PermissionKey,
} from './vault-integration-service.js';

const { eq, and, or, desc, asc, sql } =
  drizzleOrm as unknown as typeof drizzleOrmEsm;

export interface FileUploadRequest {
  originalName: string;
  filename: string;
  mimeType: string;
  fileSize: number;
  storageProvider: string;
  storagePath: string;
  checksum: string;
  visibility?: FileVisibility;
  tags?: string[];
  metadata?: Record<string, any>;
  encryptionRequired?: boolean;
}

export interface FileDownloadRequest {
  fileId: string;
  userId: number;
  context?: FileAccessContext;
}

export interface FileListRequest {
  userId: number;
  visibility?: FileVisibility[];
  tags?: string[];
  limit?: number;
  offset?: number;
  sortBy?: 'uploadedAt' | 'lastAccessedAt' | 'filename' | 'fileSize';
  sortOrder?: 'asc' | 'desc';
}

export interface FileSearchRequest {
  userId: number;
  query: string;
  fileTypes?: string[];
  visibility?: FileVisibility[];
  uploadedAfter?: Date;
  uploadedBefore?: Date;
  limit?: number;
  offset?: number;
}

export class EnhancedFileStorageService {
  /**
   * Create a new file record with permissions
   */
  async createFile(
    userId: number,
    uploadRequest: FileUploadRequest
  ): Promise<File> {
    try {
      logger.info('[FileStorage] Creating new file record', {
        userId,
        originalName: uploadRequest.originalName,
        fileSize: uploadRequest.fileSize,
        mimeType: uploadRequest.mimeType,
      });

      // Generate unique file ID
      const fileId = crypto.randomUUID();

      // Handle encryption if required
      let encryptionKeyId: string | undefined;
      if (uploadRequest.encryptionRequired) {
        const encryptionKey =
          await vaultIntegrationService.generateFileEncryptionKey(fileId, {
            originalName: uploadRequest.originalName,
            mimeType: uploadRequest.mimeType,
            userId,
          });
        encryptionKeyId = encryptionKey.keyId;
      }

      // Create file record
      const fileData: InsertFile = {
        fileId,
        userId,
        originalName: uploadRequest.originalName,
        filename: uploadRequest.filename,
        mimeType: uploadRequest.mimeType,
        fileSize: uploadRequest.fileSize,
        storageProvider: uploadRequest.storageProvider,
        storagePath: uploadRequest.storagePath,
        checksum: uploadRequest.checksum,
        visibility: uploadRequest.visibility || 'PRIVATE',
        isEncrypted: !!uploadRequest.encryptionRequired,
        encryptionKeyId,
        tags: uploadRequest.tags || [],
        metadata: uploadRequest.metadata || {},
        status: 'ACTIVE',
        uploadedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      // Convert to database format and insert
      const dbFileData = fieldNameConverter.camelToSnake(fileData);
      const [file] = await db
        .insert(files)
        .values(dbFileData as any)
        .returning();

      // Convert back to application format
      const result = fieldNameConverter.snakeToCamel(file) as File;

      logger.info('[FileStorage] File record created successfully', {
        userId,
        fileId,
        originalName: uploadRequest.originalName,
      });

      return result;
    } catch (error) {
      logger.error('[FileStorage] Error creating file record', {
        userId,
        uploadRequest,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get file by ID with permission check
   */
  async getFile(
    userId: number,
    fileId: string,
    context?: FileAccessContext
  ): Promise<File | null> {
    try {
      // Check read permission
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'READ',
        context
      );

      if (!permissionCheck.hasPermission) {
        logger.warn('[FileStorage] Access denied for file', {
          userId,
          fileId,
          reason: permissionCheck.reason,
        });
        return null;
      }

      // Get file record
      const [file] = await db
        .select()
        .from(files)
        .where(and(eq(files.fileId, fileId), eq(files.status, 'ACTIVE')));

      if (!file) {
        return null;
      }

      // Update last accessed timestamp
      await db
        .update(files)
        .set({
          lastAccessedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(files.fileId, fileId));

      return fieldNameConverter.snakeToCamel(file) as File;
    } catch (error) {
      logger.error('[FileStorage] Error getting file', {
        userId,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * List files accessible to a user
   */
  async listFiles(
    request: FileListRequest
  ): Promise<{ files: File[]; total: number }> {
    try {
      const {
        userId,
        visibility,
        tags,
        limit = 20,
        offset = 0,
        sortBy = 'uploadedAt',
        sortOrder = 'desc',
      } = request;

      logger.debug('[FileStorage] Listing files for user', {
        userId,
        visibility,
        tags,
        limit,
        offset,
      });

      // Build base query for files user can access
      // Include files the user owns, public files, and files with explicit permissions
      const permittedFileIds = db
        .select({ fileId: filePermissions.fileId })
        .from(filePermissions)
        .where(and(eq(filePermissions.userId, userId), eq(filePermissions.isActive, true)));

      let whereClause = or(
        eq(files.userId, userId),
        eq(files.visibility, 'PUBLIC'),
        sql`${files.id} IN (${permittedFileIds})`
      );

      // Add visibility filter
      if (visibility && visibility.length > 0) {
        whereClause = and(
          whereClause,
          or(...visibility.map(v => eq(files.visibility, v)))
        ) as any;
      }

      // Add tag filter
      if (tags && tags.length > 0) {
        const tagConditions = tags.map(
          tag => sql`${files.tags} @> ${JSON.stringify([tag])}`
        );
        whereClause = and(whereClause, or(...tagConditions)) as any;
      }

      // Add status filter
      whereClause = and(whereClause, eq(files.status, 'ACTIVE')) as any;

      // Build sort clause based on sortBy field
      let orderClause;
      switch (sortBy) {
        case 'uploadedAt':
          orderClause =
            sortOrder === 'desc'
              ? desc(files.uploadedAt)
              : asc(files.uploadedAt);
          break;
        case 'lastAccessedAt':
          orderClause =
            sortOrder === 'desc'
              ? desc(files.lastAccessedAt)
              : asc(files.lastAccessedAt);
          break;
        case 'filename':
          orderClause =
            sortOrder === 'desc' ? desc(files.filename) : asc(files.filename);
          break;
        case 'fileSize':
          orderClause =
            sortOrder === 'desc' ? desc(files.fileSize) : asc(files.fileSize);
          break;
        default:
          orderClause = desc(files.uploadedAt); // Default sorting
      }

      // Get total count
      const [{ count }] = await db
        .select({ count: sql`count(*)` })
        .from(files)
        .where(whereClause);

      // Get files
      const fileRecords = await db
        .select()
        .from(files)
        .where(whereClause)
        .orderBy(orderClause)
        .limit(limit)
        .offset(offset);

      const result = {
        files: fileRecords.map(file =>
          fieldNameConverter.snakeToCamel(file)
        ) as File[],
        total: Number(count),
      };

      logger.debug('[FileStorage] Files listed successfully', {
        userId,
        count: result.files.length,
        total: result.total,
      });

      return result;
    } catch (error) {
      logger.error('[FileStorage] Error listing files', {
        request,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Search files with full-text search
   */
  async searchFiles(
    request: FileSearchRequest
  ): Promise<{ files: File[]; total: number }> {
    try {
      const {
        userId,
        query,
        fileTypes,
        visibility,
        uploadedAfter,
        uploadedBefore,
        limit = 20,
        offset = 0,
      } = request;

      logger.debug('[FileStorage] Searching files', {
        userId,
        query,
        fileTypes,
        limit,
        offset,
      });

      // Build search conditions
      let whereClause = and(
        or(eq(files.userId, userId), eq(files.visibility, 'PUBLIC')),
        eq(files.status, 'ACTIVE')
      );

      // Add text search condition
      if (query) {
        const searchCondition = or(
          sql`${files.originalName} ILIKE ${`%${query}%`}`,
          sql`${files.metadata}->>'description' ILIKE ${`%${query}%`}`,
          sql`${files.tags}::text ILIKE ${`%${query}%`}`
        );
        whereClause = and(whereClause, searchCondition) as any;
      }

      // Add file type filter
      if (fileTypes && fileTypes.length > 0) {
        const typeConditions = fileTypes.map(
          type => sql`${files.mimeType} LIKE ${`${type}%`}`
        );
        whereClause = and(whereClause, or(...typeConditions)) as any;
      }

      // Add visibility filter
      if (visibility && visibility.length > 0) {
        const visibilityConditions = visibility.map(v =>
          eq(files.visibility, v)
        );
        whereClause = and(whereClause, or(...visibilityConditions)) as any;
      }

      // Add date range filters
      if (uploadedAfter) {
        whereClause = and(
          whereClause,
          sql`${files.uploadedAt} >= ${uploadedAfter}`
        ) as any;
      }
      if (uploadedBefore) {
        whereClause = and(
          whereClause,
          sql`${files.uploadedAt} <= ${uploadedBefore}`
        ) as any;
      }

      // Get total count
      const [{ count }] = await db
        .select({ count: sql`count(*)` })
        .from(files)
        .where(whereClause);

      // Get files with relevance scoring
      const fileRecords = await db
        .select()
        .from(files)
        .where(whereClause)
        .orderBy(desc(files.uploadedAt)) // Default sort by upload date
        .limit(limit)
        .offset(offset);

      const result = {
        files: fileRecords.map(file =>
          fieldNameConverter.snakeToCamel(file)
        ) as File[],
        total: Number(count),
      };

      logger.debug('[FileStorage] File search completed', {
        userId,
        query,
        count: result.files.length,
        total: result.total,
      });

      return result;
    } catch (error) {
      logger.error('[FileStorage] Error searching files', {
        request,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Update file metadata
   */
  async updateFile(
    userId: number,
    fileId: string,
    updates: {
      visibility?: FileVisibility;
      tags?: string[];
      metadata?: Record<string, any>;
    },
    context?: FileAccessContext
  ): Promise<File | null> {
    try {
      // Check write permission
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'WRITE',
        context
      );

      if (!permissionCheck.hasPermission) {
        logger.warn('[FileStorage] Write access denied for file', {
          userId,
          fileId,
          reason: permissionCheck.reason,
        });
        return null;
      }

      // Prepare update data
      const updateData = {
        ...updates,
        updatedAt: new Date(),
      };

      // Convert to database format
      const dbUpdateData = fieldNameConverter.camelToSnake(updateData);

      // Update file
      const [updatedFile] = await db
        .update(files)
        .set(dbUpdateData as any)
        .where(and(eq(files.fileId, fileId), eq(files.status, 'ACTIVE')))
        .returning();

      if (!updatedFile) {
        return null;
      }

      logger.info('[FileStorage] File updated successfully', {
        userId,
        fileId,
        updates,
      });

      return fieldNameConverter.snakeToCamel(updatedFile) as File;
    } catch (error) {
      logger.error('[FileStorage] Error updating file', {
        userId,
        fileId,
        updates,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Delete a file (soft delete)
   */
  async deleteFile(
    userId: number,
    fileId: string,
    context?: FileAccessContext
  ): Promise<boolean> {
    try {
      // Check delete permission
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'DELETE',
        context
      );

      if (!permissionCheck.hasPermission) {
        logger.warn('[FileStorage] Delete access denied for file', {
          userId,
          fileId,
          reason: permissionCheck.reason,
        });
        return false;
      }

      // Soft delete the file
      const [deletedFile] = await db
        .update(files)
        .set({
          status: 'DELETED',
          updatedAt: new Date(),
        })
        .where(and(eq(files.fileId, fileId), eq(files.status, 'ACTIVE')))
        .returning();

      if (!deletedFile) {
        return false;
      }

      // Deactivate all permissions for this file
      await db
        .update(filePermissions)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(eq(filePermissions.fileId, fileId));

      // Deactivate all shares for this file
      await db
        .update(fileShares)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(eq(fileShares.fileId, fileId));

      logger.info('[FileStorage] File deleted successfully', {
        userId,
        fileId,
      });

      return true;
    } catch (error) {
      logger.error('[FileStorage] Error deleting file', {
        userId,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get file access statistics
   */
  async getFileStats(
    userId: number,
    fileId: string,
    context?: FileAccessContext
  ): Promise<any> {
    try {
      // Check admin permission for detailed stats
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'ADMIN',
        context
      );

      if (!permissionCheck.hasPermission) {
        // Return limited stats for non-admin users
        return await this.getBasicFileStats(fileId);
      }

      // Get comprehensive stats for admins
      const [accessCount] = await db
        .select({ count: sql`count(*)` })
        .from(fileAccessLogs)
        .where(eq(fileAccessLogs.fileId, fileId));

      const [uniqueUsers] = await db
        .select({ count: sql`count(distinct ${fileAccessLogs.userId})` })
        .from(fileAccessLogs)
        .where(eq(fileAccessLogs.fileId, fileId));

      const [totalDownloads] = await db
        .select({ count: sql`count(*)` })
        .from(fileAccessLogs)
        .where(
          and(
            eq(fileAccessLogs.fileId, fileId),
            eq(fileAccessLogs.action, 'DOWNLOAD'),
            eq(fileAccessLogs.success, true)
          )
        );

      const [permissionCount] = await db
        .select({ count: sql`count(*)` })
        .from(filePermissions)
        .where(
          and(
            eq(filePermissions.fileId, fileId),
            eq(filePermissions.isActive, true)
          )
        );

      const [shareCount] = await db
        .select({ count: sql`count(*)` })
        .from(fileShares)
        .where(
          and(eq(fileShares.fileId, fileId), eq(fileShares.isActive, true))
        );

      return {
        totalAccesses: Number(accessCount.count),
        uniqueUsers: Number(uniqueUsers.count),
        totalDownloads: Number(totalDownloads.count),
        activePermissions: Number(permissionCount.count),
        activeShares: Number(shareCount.count),
      };
    } catch (error) {
      logger.error('[FileStorage] Error getting file stats', {
        userId,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get basic file statistics (for non-admin users)
   */
  private async getBasicFileStats(fileId: string): Promise<any> {
    const [file] = await db
      .select({
        uploadedAt: files.uploadedAt,
        lastAccessedAt: files.lastAccessedAt,
        fileSize: files.fileSize,
      })
      .from(files)
      .where(eq(files.fileId, fileId));

    return {
      uploadedAt: file?.uploadedAt,
      lastAccessedAt: file?.lastAccessedAt,
      fileSize: file?.fileSize,
    };
  }

  /**
   * Cleanup expired files and data
   */
  async cleanupExpiredFiles(): Promise<void> {
    try {
      // Mark expired files as inactive
      await db
        .update(files)
        .set({
          status: 'EXPIRED',
          updatedAt: new Date(),
        })
        .where(
          and(eq(files.status, 'ACTIVE'), sql`${files.expiresAt} <= NOW()`)
        );

      // Clean up old access logs (keep last 90 days)
      const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
      await db
        .delete(fileAccessLogs)
        .where(sql`${fileAccessLogs.accessedAt} < ${ninetyDaysAgo}`);

      logger.info(
        '[FileStorage] Cleanup completed for expired files and old logs'
      );
    } catch (error) {
      logger.error('[FileStorage] Error during cleanup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const enhancedFileStorageService = new EnhancedFileStorageService();
