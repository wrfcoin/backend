/**
 * File Versioning Service
 * Provides comprehensive file version management including:
 * - Auto-increment version on upload
 * - Version history retrieval
 * - Rollback to previous version
 * - Cleanup old versions (configurable limit)
 *
 * @module file-versioning-service
 */

import * as drizzleOrm from 'drizzle-orm';
import type * as drizzleOrmEsm from '../../node_modules/drizzle-orm/index.js';
import { db } from '../../database/db.js';
import { v4 as uuidv4 } from 'uuid';
import * as crypto from 'crypto';
import {
  S3Client,
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} from '@aws-sdk/client-s3';
import { logger } from '../../utils/logger.js';
import {
  files,
  fileVersions,
  type File,
  type FileVersion,
  type InsertFileVersion,
} from '../../shared/file-schema.js';
import { filePermissionService } from './file-permission-service.js';
import { createRedisClient } from '../utils/create-redis.js';

const { eq, and, desc, asc, lt, sql } =
  drizzleOrm as unknown as typeof drizzleOrmEsm;

// Redis client for caching
const redis = createRedisClient({
  // Redis stores only disposable version-list caches; Postgres is authoritative.
  failureMode: 'fail-open-cache',
});

// S3 client for storage operations
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Configuration
const MAX_VERSIONS_DEFAULT = parseInt(process.env.MAX_FILE_VERSIONS || '10', 10);
const VERSION_CACHE_TTL = 300; // 5 minutes

export interface CreateVersionRequest {
  fileId: string;
  userId: number;
  storagePath: string;
  fileSize: number;
  checksum: string;
  comment?: string;
  metadata?: Record<string, any>;
}

export interface VersionHistoryOptions {
  limit?: number;
  offset?: number;
  includeArchived?: boolean;
}

export interface RollbackResult {
  success: boolean;
  previousVersion: FileVersion;
  newVersion: FileVersion;
  message: string;
}

export interface CleanupResult {
  deletedVersions: number;
  freedSpace: number;
  errors: string[];
}

export class FileVersioningService {
  private maxVersions: number;

  constructor(maxVersions: number = MAX_VERSIONS_DEFAULT) {
    this.maxVersions = maxVersions;
  }

  /**
   * Create a new version for a file
   * Automatically increments version number and handles cleanup of old versions
   */
  async createVersion(request: CreateVersionRequest): Promise<FileVersion> {
    try {
      const {
        fileId,
        userId,
        storagePath,
        fileSize,
        checksum,
        comment,
        metadata,
      } = request;

      logger.info('[FileVersioning] Creating new version', {
        fileId,
        userId,
        storagePath,
      });

      // Get current highest version number
      const currentVersions = await db
        .select()
        .from(fileVersions)
        .where(eq(fileVersions.fileId, fileId))
        .orderBy(desc(fileVersions.versionNumber))
        .limit(1);

      const nextVersionNumber =
        currentVersions.length > 0
          ? currentVersions[0].versionNumber + 1
          : 1;

      // Mark previous current version as not current
      if (currentVersions.length > 0) {
        await db
          .update(fileVersions)
          .set({ isCurrentVersion: false })
          .where(
            and(
              eq(fileVersions.fileId, fileId),
              eq(fileVersions.isCurrentVersion, true)
            )
          );
      }

      // Create new version record
      const versionId = uuidv4();
      const newVersion: InsertFileVersion = {
        versionId,
        fileId,
        versionNumber: nextVersionNumber,
        storagePath,
        storageProvider: 'S3',
        fileSize,
        checksum,
        createdBy: userId,
        comment,
        isActive: true,
        isCurrentVersion: true,
        metadata: metadata || {},
        createdAt: new Date(),
      };

      const [insertedVersion] = await db
        .insert(fileVersions)
        .values(newVersion)
        .returning();

      // Invalidate cache
      await this.invalidateVersionCache(fileId);

      // Cleanup old versions if exceeded limit
      await this.cleanupOldVersions(fileId);

      logger.info('[FileVersioning] Version created successfully', {
        fileId,
        versionId,
        versionNumber: nextVersionNumber,
      });

      return insertedVersion;
    } catch (error) {
      logger.error('[FileVersioning] Error creating version', {
        request,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get version history for a file
   */
  async getVersionHistory(
    fileId: string,
    userId: number,
    options: VersionHistoryOptions = {}
  ): Promise<{ versions: FileVersion[]; total: number }> {
    try {
      const { limit = 20, offset = 0, includeArchived = false } = options;

      // Check read permission
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'READ'
      );

      if (!permissionCheck.hasPermission) {
        throw new Error('Access denied: insufficient permissions');
      }

      // Try cache first
      const cacheKey = `file_versions:${fileId}:${limit}:${offset}:${includeArchived}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Build query conditions
      const conditions = includeArchived
        ? eq(fileVersions.fileId, fileId)
        : and(
            eq(fileVersions.fileId, fileId),
            eq(fileVersions.isActive, true)
          );

      // Get total count
      const countResult = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(fileVersions)
        .where(conditions);
      const total = countResult[0]?.count || 0;

      // Get versions
      const versions = await db
        .select()
        .from(fileVersions)
        .where(conditions)
        .orderBy(desc(fileVersions.versionNumber))
        .limit(limit)
        .offset(offset);

      const result = { versions, total };

      // Cache result
      await redis.setex(cacheKey, VERSION_CACHE_TTL, JSON.stringify(result));

      return result;
    } catch (error) {
      logger.error('[FileVersioning] Error getting version history', {
        fileId,
        userId,
        options,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get a specific version by version ID
   */
  async getVersion(
    versionId: string,
    userId: number
  ): Promise<FileVersion | null> {
    try {
      const [version] = await db
        .select()
        .from(fileVersions)
        .where(eq(fileVersions.versionId, versionId));

      if (!version) {
        return null;
      }

      // Check read permission
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        version.fileId,
        'READ'
      );

      if (!permissionCheck.hasPermission) {
        throw new Error('Access denied: insufficient permissions');
      }

      return version;
    } catch (error) {
      logger.error('[FileVersioning] Error getting version', {
        versionId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get current version of a file
   */
  async getCurrentVersion(
    fileId: string,
    userId: number
  ): Promise<FileVersion | null> {
    try {
      // Check read permission
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'READ'
      );

      if (!permissionCheck.hasPermission) {
        throw new Error('Access denied: insufficient permissions');
      }

      const [version] = await db
        .select()
        .from(fileVersions)
        .where(
          and(
            eq(fileVersions.fileId, fileId),
            eq(fileVersions.isCurrentVersion, true),
            eq(fileVersions.isActive, true)
          )
        );

      return version || null;
    } catch (error) {
      logger.error('[FileVersioning] Error getting current version', {
        fileId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Rollback to a previous version
   * Creates a new version based on the target version
   */
  async rollbackToVersion(
    fileId: string,
    targetVersionId: string,
    userId: number,
    comment?: string
  ): Promise<RollbackResult> {
    try {
      // Check write permission
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'WRITE'
      );

      if (!permissionCheck.hasPermission) {
        throw new Error('Access denied: insufficient permissions');
      }

      // Get target version
      const [targetVersion] = await db
        .select()
        .from(fileVersions)
        .where(
          and(
            eq(fileVersions.versionId, targetVersionId),
            eq(fileVersions.fileId, fileId),
            eq(fileVersions.isActive, true)
          )
        );

      if (!targetVersion) {
        throw new Error('Target version not found or inactive');
      }

      // Get current version
      const [currentVersion] = await db
        .select()
        .from(fileVersions)
        .where(
          and(
            eq(fileVersions.fileId, fileId),
            eq(fileVersions.isCurrentVersion, true)
          )
        );

      if (!currentVersion) {
        throw new Error('No current version found');
      }

      // Create new version based on target version's content
      // Copy the file in S3 to a new location
      const newVersionNumber = currentVersion.versionNumber + 1;
      const newStoragePath = `versions/${fileId}/${uuidv4()}`;

      await s3Client.send(
        new CopyObjectCommand({
          Bucket: process.env.S3_BUCKET_NAME!,
          CopySource: `${process.env.S3_BUCKET_NAME}/${targetVersion.storagePath}`,
          Key: newStoragePath,
        })
      );

      // Mark current version as not current
      await db
        .update(fileVersions)
        .set({ isCurrentVersion: false })
        .where(eq(fileVersions.versionId, currentVersion.versionId));

      // Create new version record
      const versionId = uuidv4();
      const [newVersion] = await db
        .insert(fileVersions)
        .values({
          versionId,
          fileId,
          versionNumber: newVersionNumber,
          storagePath: newStoragePath,
          storageProvider: 'S3',
          fileSize: targetVersion.fileSize,
          checksum: targetVersion.checksum,
          createdBy: userId,
          comment:
            comment ||
            `Rollback to version ${targetVersion.versionNumber}`,
          isActive: true,
          isCurrentVersion: true,
          metadata: {
            rollbackFrom: currentVersion.versionId,
            rollbackTo: targetVersion.versionId,
            originalVersionNumber: targetVersion.versionNumber,
          },
          createdAt: new Date(),
        })
        .returning();

      // Update main file record with new storage path
      await db
        .update(files)
        .set({
          storagePath: newStoragePath,
          checksum: targetVersion.checksum,
          fileSize: targetVersion.fileSize,
          updatedAt: new Date(),
        })
        .where(eq(files.fileId, fileId));

      // Invalidate cache
      await this.invalidateVersionCache(fileId);

      // Cleanup old versions
      await this.cleanupOldVersions(fileId);

      logger.info('[FileVersioning] Rollback completed', {
        fileId,
        fromVersion: currentVersion.versionNumber,
        toVersion: targetVersion.versionNumber,
        newVersionNumber,
      });

      return {
        success: true,
        previousVersion: currentVersion,
        newVersion,
        message: `Successfully rolled back to version ${targetVersion.versionNumber}`,
      };
    } catch (error) {
      logger.error('[FileVersioning] Error rolling back version', {
        fileId,
        targetVersionId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Delete a specific version (soft delete - marks as inactive)
   */
  async deleteVersion(
    versionId: string,
    userId: number
  ): Promise<{ success: boolean; message: string }> {
    try {
      const [version] = await db
        .select()
        .from(fileVersions)
        .where(eq(fileVersions.versionId, versionId));

      if (!version) {
        throw new Error('Version not found');
      }

      // Check delete permission
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        version.fileId,
        'DELETE'
      );

      if (!permissionCheck.hasPermission) {
        throw new Error('Access denied: insufficient permissions');
      }

      // Cannot delete current version
      if (version.isCurrentVersion) {
        throw new Error('Cannot delete the current version');
      }

      // Soft delete - mark as inactive
      await db
        .update(fileVersions)
        .set({
          isActive: false,
          archivedAt: new Date(),
        })
        .where(eq(fileVersions.versionId, versionId));

      // Invalidate cache
      await this.invalidateVersionCache(version.fileId);

      logger.info('[FileVersioning] Version deleted', {
        versionId,
        fileId: version.fileId,
        versionNumber: version.versionNumber,
      });

      return {
        success: true,
        message: `Version ${version.versionNumber} deleted successfully`,
      };
    } catch (error) {
      logger.error('[FileVersioning] Error deleting version', {
        versionId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Cleanup old versions beyond the limit
   */
  async cleanupOldVersions(
    fileId: string,
    maxVersions?: number
  ): Promise<CleanupResult> {
    const limit = maxVersions || this.maxVersions;
    const result: CleanupResult = {
      deletedVersions: 0,
      freedSpace: 0,
      errors: [],
    };

    try {
      // Get all active versions ordered by version number descending
      const allVersions = await db
        .select()
        .from(fileVersions)
        .where(
          and(eq(fileVersions.fileId, fileId), eq(fileVersions.isActive, true))
        )
        .orderBy(desc(fileVersions.versionNumber));

      if (allVersions.length <= limit) {
        return result;
      }

      // Versions to delete (keep the first 'limit' versions)
      const versionsToDelete = allVersions.slice(limit);

      for (const version of versionsToDelete) {
        try {
          // Soft delete version record
          await db
            .update(fileVersions)
            .set({
              isActive: false,
              archivedAt: new Date(),
            })
            .where(eq(fileVersions.versionId, version.versionId));

          // Optionally delete from S3 (depends on policy)
          if (process.env.DELETE_OLD_VERSION_FILES === 'true') {
            await s3Client.send(
              new DeleteObjectCommand({
                Bucket: process.env.S3_BUCKET_NAME!,
                Key: version.storagePath,
              })
            );
            result.freedSpace += version.fileSize;
          }

          result.deletedVersions++;
        } catch (error) {
          result.errors.push(
            `Failed to delete version ${version.versionId}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }

      // Invalidate cache
      await this.invalidateVersionCache(fileId);

      logger.info('[FileVersioning] Old versions cleaned up', {
        fileId,
        deletedCount: result.deletedVersions,
        freedSpace: result.freedSpace,
        errors: result.errors.length,
      });

      return result;
    } catch (error) {
      logger.error('[FileVersioning] Error cleaning up old versions', {
        fileId,
        maxVersions: limit,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get version count for a file
   */
  async getVersionCount(fileId: string): Promise<number> {
    try {
      const result = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(fileVersions)
        .where(
          and(eq(fileVersions.fileId, fileId), eq(fileVersions.isActive, true))
        );

      return result[0]?.count || 0;
    } catch (error) {
      logger.error('[FileVersioning] Error getting version count', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Compare two versions
   */
  async compareVersions(
    versionId1: string,
    versionId2: string,
    userId: number
  ): Promise<{
    version1: FileVersion;
    version2: FileVersion;
    differences: {
      sizeChange: number;
      checksumMatch: boolean;
      timeDifference: number;
    };
  }> {
    try {
      const [version1] = await db
        .select()
        .from(fileVersions)
        .where(eq(fileVersions.versionId, versionId1));

      const [version2] = await db
        .select()
        .from(fileVersions)
        .where(eq(fileVersions.versionId, versionId2));

      if (!version1 || !version2) {
        throw new Error('One or both versions not found');
      }

      if (version1.fileId !== version2.fileId) {
        throw new Error('Versions must belong to the same file');
      }

      // Check permission
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        version1.fileId,
        'READ'
      );

      if (!permissionCheck.hasPermission) {
        throw new Error('Access denied: insufficient permissions');
      }

      return {
        version1,
        version2,
        differences: {
          sizeChange: version2.fileSize - version1.fileSize,
          checksumMatch: version1.checksum === version2.checksum,
          timeDifference:
            new Date(version2.createdAt).getTime() -
            new Date(version1.createdAt).getTime(),
        },
      };
    } catch (error) {
      logger.error('[FileVersioning] Error comparing versions', {
        versionId1,
        versionId2,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Invalidate version cache for a file
   */
  private async invalidateVersionCache(fileId: string): Promise<void> {
    try {
      const pattern = `file_versions:${fileId}:*`;
      const keys = await redis.keys(pattern);
      if (keys.length > 0) {
        await redis.del(...keys);
      }
    } catch (error) {
      logger.warn('[FileVersioning] Error invalidating cache', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

// Export singleton instance
export const fileVersioningService = new FileVersioningService();

export default fileVersioningService;
