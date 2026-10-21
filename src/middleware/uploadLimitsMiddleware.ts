/**
 * Upload Limits Middleware
 * Implements role-based file upload restrictions including:
 * - Maximum file size per upload
 * - Daily upload count limits
 * - Total storage quota per user
 *
 * @module uploadLimitsMiddleware
 */

import { Response, NextFunction } from 'express';
import { db } from '../../database/db.js';
import { files } from '../../shared/file-schema.js';
import { eq, and, gte, sql } from 'drizzle-orm';
import { logger } from '../../utils/logger.js';
import { ROLES, Role } from '../../shared/rbac.js';
import { AuthenticatedRequest } from '../../shared/types/security-types.js';
import { createRedisClient } from '../../server/utils/create-redis.js';

// Redis client for rate limiting
const redis = createRedisClient({
  // Upload rate/quota enforcement is a security boundary.
  failureMode: 'fail-closed',
});

/**
 * Upload limits configuration per role
 */
export interface UploadLimits {
  maxFileSize: number; // Maximum file size in bytes
  maxFilesPerDay: number; // Maximum uploads per day (0 = no limit)
  storageQuota: number; // Maximum total storage in bytes (0 = no limit)
  allowedMimeTypes?: string[]; // Optional mime type restrictions
}

/**
 * Default upload limits per role
 * Based on Task 83 requirements:
 * - GUEST: No uploads allowed
 * - USER: 10MB max, 10 files/day, 100MB quota
 * - OPERATOR: 50MB max, 50 files/day, 1GB quota
 * - ADMIN: 100MB max, 100 files/day, 10GB quota
 * - SUPER_ADMIN: 500MB max, unlimited files/day, unlimited quota
 */
export const ROLE_UPLOAD_LIMITS: Record<Role, UploadLimits> = {
  [ROLES.GUEST]: {
    maxFileSize: 0, // No uploads allowed
    maxFilesPerDay: 0,
    storageQuota: 0,
  },
  [ROLES.USER]: {
    maxFileSize: 10 * 1024 * 1024, // 10MB
    maxFilesPerDay: 10,
    storageQuota: 100 * 1024 * 1024, // 100MB
  },
  [ROLES.OPERATOR]: {
    maxFileSize: 50 * 1024 * 1024, // 50MB
    maxFilesPerDay: 50,
    storageQuota: 1024 * 1024 * 1024, // 1GB
  },
  [ROLES.ADMIN]: {
    maxFileSize: 100 * 1024 * 1024, // 100MB
    maxFilesPerDay: 100,
    storageQuota: 10 * 1024 * 1024 * 1024, // 10GB
  },
  [ROLES.SUPER_ADMIN]: {
    maxFileSize: 500 * 1024 * 1024, // 500MB
    maxFilesPerDay: 0, // Unlimited
    storageQuota: 0, // Unlimited
  },
};

/**
 * Cache TTL for user upload counts (1 day in seconds)
 */
const UPLOAD_COUNT_CACHE_TTL = 86400;

/**
 * Get upload limits for a user's role
 */
export function getUploadLimits(role: Role): UploadLimits {
  return ROLE_UPLOAD_LIMITS[role] || ROLE_UPLOAD_LIMITS[ROLES.GUEST];
}

/**
 * Get today's upload count for a user from cache or database
 */
async function getUserDailyUploadCount(userId: number): Promise<number> {
  const cacheKey = `upload_count:${userId}:${new Date().toISOString().split('T')[0]}`;

  try {
    // Try cache first
    const cachedCount = await redis.get(cacheKey);
    if (cachedCount !== null) {
      return parseInt(cachedCount, 10);
    }

    // Query database for today's uploads
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const result = await db
      .select({
        count: sql<number>`count(*)::int`,
      })
      .from(files)
      .where(
        and(
          eq(files.userId, userId),
          gte(files.uploadedAt, today),
          eq(files.status, 'ACTIVE')
        )
      );

    const count = result[0]?.count || 0;

    // Cache the result
    await redis.setex(cacheKey, UPLOAD_COUNT_CACHE_TTL, count.toString());

    return count;
  } catch (error) {
    logger.error('[UploadLimits] Error getting daily upload count', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('UPLOAD_DAILY_COUNT_CHECK_FAILED');
  }
}

/**
 * Get total storage used by a user
 */
async function getUserStorageUsed(userId: number): Promise<number> {
  const cacheKey = `storage_used:${userId}`;

  try {
    // Try cache first
    const cachedUsage = await redis.get(cacheKey);
    if (cachedUsage !== null) {
      return parseInt(cachedUsage, 10);
    }

    // Query database for total storage
    const result = await db
      .select({
        totalSize: sql<number>`COALESCE(SUM(file_size), 0)::bigint`,
      })
      .from(files)
      .where(and(eq(files.userId, userId), eq(files.status, 'ACTIVE')));

    const totalSize = Number(result[0]?.totalSize || 0);

    // Cache for 5 minutes (storage changes less frequently)
    await redis.setex(cacheKey, 300, totalSize.toString());

    return totalSize;
  } catch (error) {
    logger.error('[UploadLimits] Error getting storage used', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw new Error('UPLOAD_STORAGE_CHECK_FAILED');
  }
}

/**
 * Increment daily upload count in cache
 */
async function incrementDailyUploadCount(userId: number): Promise<void> {
  const cacheKey = `upload_count:${userId}:${new Date().toISOString().split('T')[0]}`;

  try {
    await redis.incr(cacheKey);
    // Ensure TTL is set
    await redis.expire(cacheKey, UPLOAD_COUNT_CACHE_TTL);
  } catch (error) {
    logger.warn('[UploadLimits] Error incrementing upload count', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Invalidate storage cache when files are uploaded/deleted
 */
export async function invalidateStorageCache(userId: number): Promise<void> {
  const cacheKey = `storage_used:${userId}`;
  try {
    await redis.del(cacheKey);
  } catch (error) {
    logger.warn('[UploadLimits] Error invalidating storage cache', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Middleware to check and enforce upload limits
 *
 * Checks:
 * 1. Role-based access (GUEST cannot upload)
 * 2. File size limit
 * 3. Daily upload count limit
 * 4. Storage quota limit
 */
export const uploadLimitsMiddleware = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const parsedUserId =
    req.user?.userId !== undefined && req.user?.userId !== null
      ? Number(req.user.userId)
      : null;
  const userId = parsedUserId !== null && Number.isFinite(parsedUserId) ? parsedUserId : null;
  const userRole = (req.user?.role as Role) || ROLES.GUEST;

  // Get upload limits for user's role
  const limits = getUploadLimits(userRole);

  logger.debug('[UploadLimits] Checking upload limits', {
    userId,
    role: userRole,
    limits: {
      maxFileSize: formatBytes(limits.maxFileSize),
      maxFilesPerDay: limits.maxFilesPerDay === 0 ? 'unlimited' : limits.maxFilesPerDay,
      storageQuota: limits.storageQuota === 0 ? 'unlimited' : formatBytes(limits.storageQuota),
    },
  });

  // Check 1: Role-based access
  if (limits.maxFileSize === 0) {
    logger.warn('[UploadLimits] Upload denied - role not allowed to upload', {
      userId,
      role: userRole,
    });
    res.status(403).json({
      success: false,
      error: 'Your role does not permit file uploads',
      code: 'UPLOAD_NOT_ALLOWED',
    });
    return;
  }

  // Check 2: File size limit
  const contentLength = parseInt(req.headers['content-length'] || '0', 10);
  if (contentLength > limits.maxFileSize) {
    logger.warn('[UploadLimits] Upload denied - file too large', {
      userId,
      role: userRole,
      fileSize: contentLength,
      maxAllowed: limits.maxFileSize,
    });
    res.status(413).json({
      success: false,
      error: `File size exceeds maximum allowed for your role. Maximum: ${formatBytes(limits.maxFileSize)}`,
      code: 'FILE_TOO_LARGE',
      limits: {
        maxFileSize: limits.maxFileSize,
        maxFileSizeFormatted: formatBytes(limits.maxFileSize),
      },
    });
    return;
  }

  // Check 3: Daily upload count limit (only if limit is set > 0)
  if (limits.maxFilesPerDay > 0 && userId !== null) {
    let dailyCount: number;
    try {
      dailyCount = await getUserDailyUploadCount(userId);
    } catch {
      res.status(503).json({
        success: false,
        error: 'Upload limit check unavailable. Please retry shortly.',
        code: 'UPLOAD_LIMIT_CHECK_UNAVAILABLE',
      });
      return;
    }
    if (dailyCount >= limits.maxFilesPerDay) {
      logger.warn('[UploadLimits] Upload denied - daily limit reached', {
        userId,
        role: userRole,
        dailyCount,
        maxAllowed: limits.maxFilesPerDay,
      });
      res.status(429).json({
        success: false,
        error: `Daily upload limit reached. Maximum: ${limits.maxFilesPerDay} files per day`,
        code: 'DAILY_LIMIT_REACHED',
        limits: {
          maxFilesPerDay: limits.maxFilesPerDay,
          currentCount: dailyCount,
          resetsAt: new Date(new Date().setHours(24, 0, 0, 0)).toISOString(),
        },
      });
      return;
    }
  }

  // Check 4: Storage quota limit (only if quota is set > 0)
  if (limits.storageQuota > 0 && userId !== null) {
    let storageUsed: number;
    try {
      storageUsed = await getUserStorageUsed(userId);
    } catch {
      res.status(503).json({
        success: false,
        error: 'Upload limit check unavailable. Please retry shortly.',
        code: 'UPLOAD_LIMIT_CHECK_UNAVAILABLE',
      });
      return;
    }
    if (storageUsed + contentLength > limits.storageQuota) {
      logger.warn('[UploadLimits] Upload denied - storage quota exceeded', {
        userId,
        role: userRole,
        storageUsed,
        fileSize: contentLength,
        quota: limits.storageQuota,
      });
      res.status(507).json({
        success: false,
        error: `Storage quota would be exceeded. Used: ${formatBytes(storageUsed)}, Quota: ${formatBytes(limits.storageQuota)}`,
        code: 'STORAGE_QUOTA_EXCEEDED',
        limits: {
          storageQuota: limits.storageQuota,
          storageQuotaFormatted: formatBytes(limits.storageQuota),
          storageUsed,
          storageUsedFormatted: formatBytes(storageUsed),
          availableSpace: limits.storageQuota - storageUsed,
          availableSpaceFormatted: formatBytes(limits.storageQuota - storageUsed),
        },
      });
      return;
    }
  }

  // Attach limits to request for downstream use
  (req as any).uploadLimits = limits;

  // Register callback to increment daily count after successful upload
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300 && userId !== null) {
      incrementDailyUploadCount(userId);
      invalidateStorageCache(userId);
    }
  });

  logger.debug('[UploadLimits] Upload limits check passed', {
    userId,
    role: userRole,
  });

  next();
};

/**
 * Get upload limits info for a user (useful for UI)
 */
export const getUploadLimitsInfo = async (
  userId: number,
  role: Role
): Promise<{
  limits: UploadLimits;
  usage: {
    dailyUploads: number;
    storageUsed: number;
    storageUsedFormatted: string;
  };
  remaining: {
    dailyUploads: number | 'unlimited';
    storageSpace: number | 'unlimited';
    storageSpaceFormatted: string;
  };
}> => {
  const limits = getUploadLimits(role);
  const [dailyUploads, storageUsed] = await Promise.all([
    getUserDailyUploadCount(userId),
    getUserStorageUsed(userId),
  ]);

  return {
    limits,
    usage: {
      dailyUploads,
      storageUsed,
      storageUsedFormatted: formatBytes(storageUsed),
    },
    remaining: {
      dailyUploads:
        limits.maxFilesPerDay === 0
          ? 'unlimited'
          : Math.max(0, limits.maxFilesPerDay - dailyUploads),
      storageSpace:
        limits.storageQuota === 0
          ? 'unlimited'
          : Math.max(0, limits.storageQuota - storageUsed),
      storageSpaceFormatted:
        limits.storageQuota === 0
          ? 'unlimited'
          : formatBytes(Math.max(0, limits.storageQuota - storageUsed)),
    },
  };
};

export default uploadLimitsMiddleware;
