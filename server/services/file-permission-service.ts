/**
 * File Permission Service
 * Handles role-based access control for file uploads and storage system
 */

import { eq, and, or, desc, asc, sql, isNull } from 'drizzle-orm';
import { db } from '../db.js';
import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import fieldNameConverter from '../../utils/fieldNameConverter.js';
import { createRedisClient } from '../utils/create-redis.js';

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
  type InsertFilePermission,
  type FileAccessLog,
  type InsertFileAccessLog,
  type FileShare,
  type InsertFileShare,
} from '../../shared/file-schema.js';

// Redis client for permission caching
const redis = createRedisClient({
  // Permission decisions are a security boundary and must refuse on outage.
  failureMode: 'fail-closed',
  connectTimeout: 5000,
  extra: { commandTimeout: 3000 },
});

// Cache TTL in seconds (5 minutes for permissions, 1 hour for file metadata)
const PERMISSION_CACHE_TTL = 300;
const FILE_CACHE_TTL = 3600;

export interface FileAccessContext {
  userId: number;
  ipAddress?: string;
  userAgent?: string;
  sessionId?: string;
  requestId?: string;
}

export interface PermissionCheckResult {
  hasPermission: boolean;
  permission?: PermissionLevel;
  reason?: string;
  cacheHit?: boolean;
}

export interface FilePermissionGrantRequest {
  granterId: number;
  userId: number;
  fileId: string;
  permissions: PermissionLevel[];
  expiresAt?: Date;
  conditions?: Record<string, any>;
}

export class FilePermissionService {
  /**
   * Check if a user has a specific permission for a file
   */
  async checkFilePermission(
    userId: number,
    fileId: string,
    permission: PermissionLevel,
    context?: FileAccessContext
  ): Promise<PermissionCheckResult> {
    try {
      const cacheKey = `file_perm:${userId}:${fileId}:${permission}`;

      // Check Redis cache first
      const cachedResult = await redis.get(cacheKey);
      if (cachedResult) {
        const result = JSON.parse(cachedResult);
        logger.debug('[FilePermission] Cache hit for permission check', {
          userId,
          fileId,
          permission,
          result: result.hasPermission,
        });

        // Log access attempt
        await this.logFileAccess({
          fileId,
          userId,
          action: 'PERMISSION_CHECK',
          permission,
          success: result.hasPermission,
          ...context,
        });

        return { ...result, cacheHit: true };
      }

      // Get file information
      const file = await this.getFileById(fileId);
      if (!file) {
        return {
          hasPermission: false,
          reason: 'FILE_NOT_FOUND',
        };
      }

      // File owner has all permissions
      if (file.userId === userId) {
        const result = {
          hasPermission: true,
          permission,
          reason: 'OWNER',
        };

        // Cache the result
        await redis.setex(
          cacheKey,
          PERMISSION_CACHE_TTL,
          JSON.stringify(result)
        );

        // Log access
        await this.logFileAccess({
          fileId,
          userId,
          action: 'PERMISSION_CHECK',
          permission,
          success: true,
          ...context,
        });

        return result;
      }

      // Check explicit permissions
      const userPermissions = await this.getUserFilePermissions(userId, fileId);
      const hasExplicitPermission = userPermissions.some(
        p =>
          p.permission === permission ||
          p.permission === 'ADMIN' ||
          (permission === 'READ' &&
            ['WRITE', 'DELETE', 'SHARE', 'ADMIN'].includes(
              p.permission as PermissionLevel
            ))
      );

      if (hasExplicitPermission) {
        const result = {
          hasPermission: true,
          permission,
          reason: 'EXPLICIT_PERMISSION',
        };

        await redis.setex(
          cacheKey,
          PERMISSION_CACHE_TTL,
          JSON.stringify(result)
        );

        await this.logFileAccess({
          fileId,
          userId,
          action: 'PERMISSION_CHECK',
          permission,
          success: true,
          ...context,
        });

        return result;
      }

      // Check file visibility for read access
      if (permission === 'READ' && file.visibility === 'PUBLIC') {
        const result = {
          hasPermission: true,
          permission,
          reason: 'PUBLIC_FILE',
        };

        await redis.setex(
          cacheKey,
          PERMISSION_CACHE_TTL,
          JSON.stringify(result)
        );

        await this.logFileAccess({
          fileId,
          userId,
          action: 'PERMISSION_CHECK',
          permission,
          success: true,
          ...context,
        });

        return result;
      }

      // No permission found
      const result = {
        hasPermission: false,
        reason: 'PERMISSION_DENIED',
      };

      // Cache negative result with shorter TTL
      await redis.setex(
        cacheKey,
        Math.floor(PERMISSION_CACHE_TTL / 2),
        JSON.stringify(result)
      );

      await this.logFileAccess({
        fileId,
        userId,
        action: 'PERMISSION_CHECK',
        permission,
        success: false,
        errorCode: 'PERMISSION_DENIED',
        ...context,
      });

      return result;
    } catch (error) {
      logger.error('[FilePermission] Error checking file permission', {
        userId,
        fileId,
        permission,
        error: error instanceof Error ? error.message : String(error),
      });

      return {
        hasPermission: false,
        reason: 'SYSTEM_ERROR',
      };
    }
  }

  /**
   * Grant file permission to a user
   */
  async grantFilePermission(
    request: FilePermissionGrantRequest
  ): Promise<void> {
    const { granterId, userId, fileId, permissions, expiresAt, conditions } =
      request;

    try {
      logger.info('[FilePermission] Granting file permissions', {
        granterId,
        userId,
        fileId,
        permissions,
      });

      // Verify granter has ADMIN permission or is owner
      const granterCanGrant = await this.checkFilePermission(
        granterId,
        fileId,
        'ADMIN'
      );
      if (!granterCanGrant.hasPermission) {
        throw new Error('Insufficient permissions to grant access');
      }

      // Insert permissions
      const permissionInserts: InsertFilePermission[] = permissions.map(
        permission => ({
          fileId,
          userId,
          grantedByUserId: granterId,
          permission,
          expiresAt,
          conditions,
          isActive: true,
        })
      );

      await db.insert(filePermissions).values(permissionInserts);

      // Clear relevant cache entries
      await this.clearUserPermissionCache(userId, fileId);

      logger.info('[FilePermission] File permissions granted successfully', {
        granterId,
        userId,
        fileId,
        permissions,
      });
    } catch (error) {
      logger.error('[FilePermission] Error granting file permission', {
        granterId,
        userId,
        fileId,
        permissions,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Revoke file permission from a user
   */
  async revokeFilePermission(
    revokerId: number,
    userId: number,
    fileId: string,
    permission: PermissionLevel
  ): Promise<void> {
    try {
      logger.info('[FilePermission] Revoking file permission', {
        revokerId,
        userId,
        fileId,
        permission,
      });

      // Verify revoker has ADMIN permission or is owner
      const revokerCanRevoke = await this.checkFilePermission(
        revokerId,
        fileId,
        'ADMIN'
      );
      if (!revokerCanRevoke.hasPermission) {
        throw new Error('Insufficient permissions to revoke access');
      }

      // Deactivate the permission
      await db
        .update(filePermissions)
        .set({
          isActive: false,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(filePermissions.fileId, fileId),
            eq(filePermissions.userId, userId),
            eq(filePermissions.permission, permission),
            eq(filePermissions.isActive, true)
          )
        );

      // Clear cache
      await this.clearUserPermissionCache(userId, fileId);

      logger.info('[FilePermission] File permission revoked successfully', {
        revokerId,
        userId,
        fileId,
        permission,
      });
    } catch (error) {
      logger.error('[FilePermission] Error revoking file permission', {
        revokerId,
        userId,
        fileId,
        permission,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get all permissions for a specific file
   */
  async getFilePermissions(fileId: string): Promise<FilePermission[]> {
    try {
      const cacheKey = `file_perms:${fileId}`;

      // Check cache
      const cachedPerms = await redis.get(cacheKey);
      if (cachedPerms) {
        return JSON.parse(cachedPerms);
      }

      // Query database
      const perms = await db
        .select()
        .from(filePermissions)
        .where(
          and(
            eq(filePermissions.fileId, fileId),
            eq(filePermissions.isActive, true)
          )
        )
        .orderBy(asc(filePermissions.createdAt));

      // Convert field names and cache
      const convertedPerms = perms.map(perm =>
        fieldNameConverter.snakeToCamel(perm)
      );
      await redis.setex(
        cacheKey,
        PERMISSION_CACHE_TTL,
        JSON.stringify(convertedPerms)
      );

      return convertedPerms;
    } catch (error) {
      logger.error('[FilePermission] Error getting file permissions', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get user's permissions for a specific file
   */
  private async getUserFilePermissions(
    userId: number,
    fileId: string
  ): Promise<FilePermission[]> {
    try {
      const perms = await db
        .select()
        .from(filePermissions)
        .where(
          and(
            eq(filePermissions.fileId, fileId),
            eq(filePermissions.userId, userId),
            eq(filePermissions.isActive, true),
            or(
              isNull(filePermissions.expiresAt),
              sql`${filePermissions.expiresAt} > NOW()`
            )
          )
        );

      return perms.map(
        perm => fieldNameConverter.snakeToCamel(perm) as FilePermission
      );
    } catch (error) {
      logger.error('[FilePermission] Error getting user file permissions', {
        userId,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get file by ID with caching
   */
  private async getFileById(fileId: string): Promise<File | null> {
    try {
      const cacheKey = `file:${fileId}`;

      // Check cache
      const cachedFile = await redis.get(cacheKey);
      if (cachedFile) {
        return JSON.parse(cachedFile);
      }

      // Query database
      const [file] = await db
        .select()
        .from(files)
        .where(eq(files.fileId, fileId));

      if (!file) return null;

      // Convert and cache
      const convertedFile = fieldNameConverter.snakeToCamel(file);
      await redis.setex(
        cacheKey,
        FILE_CACHE_TTL,
        JSON.stringify(convertedFile)
      );

      return convertedFile;
    } catch (error) {
      logger.error('[FilePermission] Error getting file by ID', {
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Log file access attempt
   */
  private async logFileAccess(logData: {
    fileId: string;
    userId: number;
    action: string;
    permission: string;
    success: boolean;
    errorCode?: string;
    errorMessage?: string;
    ipAddress?: string;
    userAgent?: string;
    sessionId?: string;
    requestId?: string;
    duration?: number;
    bytesTransferred?: number;
  }): Promise<void> {
    try {
      const accessLog: InsertFileAccessLog = {
        ...logData,
        accessedAt: new Date(),
        metadata: {
          timestamp: new Date().toISOString(),
          version: '1.0',
        },
      };

      await db.insert(fileAccessLogs).values(accessLog);
    } catch (error) {
      // Don't throw on logging errors, just log them
      logger.error('[FilePermission] Error logging file access', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Clear permission cache for a user and file
   */
  private async clearUserPermissionCache(
    userId: number,
    fileId: string
  ): Promise<void> {
    try {
      const patterns = [
        `file_perm:${userId}:${fileId}:*`,
        `file_perms:${fileId}`,
        `file:${fileId}`,
      ];

      for (const pattern of patterns) {
        const keys = await redis.keys(pattern);
        if (keys.length > 0) {
          await redis.del(...keys);
        }
      }
    } catch (error) {
      logger.error('[FilePermission] Error clearing permission cache', {
        userId,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Create a secure file share
   */
  async createFileShare(
    userId: number,
    fileId: string,
    options: {
      shareType?: 'LINK' | 'EMAIL' | 'USER';
      permissions: PermissionLevel[];
      maxAccesses?: number;
      expiresAt?: Date;
      passwordProtected?: boolean;
      password?: string;
      recipientEmail?: string;
      recipientUserId?: number;
    }
  ): Promise<FileShare> {
    try {
      // Verify user has SHARE permission
      const canShare = await this.checkFilePermission(userId, fileId, 'SHARE');
      if (!canShare.hasPermission) {
        throw new Error('Insufficient permissions to share file');
      }

      const shareToken = crypto.randomBytes(32).toString('hex');

      const shareData: InsertFileShare = {
        fileId,
        sharedByUserId: userId,
        shareToken,
        shareType: options.shareType || 'LINK',
        permissions: options.permissions,
        maxAccesses: options.maxAccesses,
        currentAccesses: 0,
        passwordProtected: options.passwordProtected || false,
        passwordHash: options.password
          ? await this.hashPassword(options.password)
          : null,
        expiresAt: options.expiresAt,
        recipientEmail: options.recipientEmail,
        recipientUserId: options.recipientUserId,
        isActive: true,
      };

      const [share] = await db.insert(fileShares).values(shareData).returning();

      return fieldNameConverter.snakeToCamel(share) as FileShare;
    } catch (error) {
      logger.error('[FilePermission] Error creating file share', {
        userId,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Hash password for share protection
   */
  private async hashPassword(password: string): Promise<string> {
    const bcrypt = require('bcrypt');
    return await bcrypt.hash(password, 12);
  }

  /**
   * Cleanup expired permissions and shares
   */
  async cleanupExpiredAccess(): Promise<void> {
    try {
      // Deactivate expired permissions
      await db
        .update(filePermissions)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(filePermissions.isActive, true),
            sql`${filePermissions.expiresAt} <= NOW()`
          )
        );

      // Deactivate expired shares
      await db
        .update(fileShares)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(fileShares.isActive, true),
            sql`${fileShares.expiresAt} <= NOW()`
          )
        );

      logger.info(
        '[FilePermission] Cleanup completed for expired permissions and shares'
      );
    } catch (error) {
      logger.error('[FilePermission] Error during cleanup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export const filePermissionService = new FilePermissionService();
