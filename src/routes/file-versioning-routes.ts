/**
 * File Versioning Routes
 * Provides REST API endpoints for file version management including:
 * - Version history retrieval
 * - Rollback to previous versions
 * - Version comparison
 * - Version deletion
 *
 * @module file-versioning-routes
 */

import { Router, Response, NextFunction } from 'express';
import { body, param, query, validationResult } from 'express-validator';
import { fileVersioningService } from '../../server/services/file-versioning-service.js';
import { logger } from '../../utils/logger.js';
import { AuthenticatedRequest } from '../../shared/types/security-types.js';
import { ROLES, hasMinimumRole } from '../../shared/rbac.js';

const router: Router = Router();

/**
 * Validation error handler middleware
 */
const handleValidationErrors = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
): void => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors.array(),
    });
    return;
  }
  next();
};

/**
 * @route GET /api/files/:fileId/versions
 * @desc Get version history for a file
 * @access Private
 */
router.get(
  '/:fileId/versions',
  [
    param('fileId').isString().notEmpty().withMessage('File ID is required'),
    query('limit').optional().isInt({ min: 1, max: 100 }).toInt(),
    query('offset').optional().isInt({ min: 0 }).toInt(),
    query('includeArchived').optional().isBoolean().toBoolean(),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { fileId } = req.params;
    const userId = req.user?.userId ? parseInt(req.user.userId, 10) : undefined;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : 20;
    const offset = req.query.offset ? parseInt(req.query.offset as string, 10) : 0;
    const includeArchived = req.query.includeArchived === 'true';

    try {
      logger.info('[FileVersioningRoutes] Getting version history', {
        fileId,
        userId,
        limit,
        offset,
        includeArchived,
      });

      const result = await fileVersioningService.getVersionHistory(fileId, userId, {
        limit,
        offset,
        includeArchived,
      });

      res.json({
        success: true,
        data: {
          versions: result.versions,
          total: result.total,
          limit,
          offset,
          hasMore: offset + result.versions.length < result.total,
        },
      });
    } catch (error) {
      logger.error('[FileVersioningRoutes] Error getting version history', {
        fileId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof Error && error.message.includes('Access denied')) {
        res.status(403).json({
          success: false,
          error: 'Access denied: insufficient permissions',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to retrieve version history',
      });
    }
  }
);

/**
 * @route GET /api/files/:fileId/versions/current
 * @desc Get the current (active) version of a file
 * @access Private
 */
router.get(
  '/:fileId/versions/current',
  [param('fileId').isString().notEmpty().withMessage('File ID is required')],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { fileId } = req.params;
    const userId = req.user?.userId ? parseInt(req.user.userId, 10) : undefined;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    try {
      logger.info('[FileVersioningRoutes] Getting current version', {
        fileId,
        userId,
      });

      const version = await fileVersioningService.getCurrentVersion(fileId, userId);

      if (!version) {
        res.status(404).json({
          success: false,
          error: 'No current version found for this file',
        });
        return;
      }

      res.json({
        success: true,
        data: version,
      });
    } catch (error) {
      logger.error('[FileVersioningRoutes] Error getting current version', {
        fileId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof Error && error.message.includes('Access denied')) {
        res.status(403).json({
          success: false,
          error: 'Access denied: insufficient permissions',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to retrieve current version',
      });
    }
  }
);

/**
 * @route GET /api/files/:fileId/versions/:versionId
 * @desc Get a specific version by version ID
 * @access Private
 */
router.get(
  '/:fileId/versions/:versionId',
  [
    param('fileId').isString().notEmpty().withMessage('File ID is required'),
    param('versionId').isString().notEmpty().withMessage('Version ID is required'),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { fileId, versionId } = req.params;
    const userId = req.user?.userId ? parseInt(req.user.userId, 10) : undefined;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    try {
      logger.info('[FileVersioningRoutes] Getting specific version', {
        fileId,
        versionId,
        userId,
      });

      const version = await fileVersioningService.getVersion(versionId, userId);

      if (!version) {
        res.status(404).json({
          success: false,
          error: 'Version not found',
        });
        return;
      }

      // Verify the version belongs to the requested file
      if (version.fileId !== fileId) {
        res.status(400).json({
          success: false,
          error: 'Version does not belong to the specified file',
        });
        return;
      }

      res.json({
        success: true,
        data: version,
      });
    } catch (error) {
      logger.error('[FileVersioningRoutes] Error getting version', {
        fileId,
        versionId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof Error && error.message.includes('Access denied')) {
        res.status(403).json({
          success: false,
          error: 'Access denied: insufficient permissions',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to retrieve version',
      });
    }
  }
);

/**
 * @route POST /api/files/:fileId/versions/rollback
 * @desc Rollback to a previous version
 * @access Private
 */
router.post(
  '/:fileId/versions/rollback',
  [
    param('fileId').isString().notEmpty().withMessage('File ID is required'),
    body('targetVersionId')
      .isString()
      .notEmpty()
      .withMessage('Target version ID is required'),
    body('comment')
      .optional()
      .isString()
      .isLength({ max: 500 })
      .withMessage('Comment must be at most 500 characters'),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { fileId } = req.params;
    const { targetVersionId, comment } = req.body;
    const userId = req.user?.userId ? parseInt(req.user.userId, 10) : undefined;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    try {
      logger.info('[FileVersioningRoutes] Initiating rollback', {
        fileId,
        targetVersionId,
        userId,
        comment,
      });

      const result = await fileVersioningService.rollbackToVersion(
        fileId,
        targetVersionId,
        userId,
        comment
      );

      logger.info('[FileVersioningRoutes] Rollback completed successfully', {
        fileId,
        fromVersion: result.previousVersion.versionNumber,
        toVersion: result.newVersion.versionNumber,
      });

      res.json({
        success: true,
        data: {
          message: result.message,
          previousVersion: {
            id: result.previousVersion.versionId,
            versionNumber: result.previousVersion.versionNumber,
          },
          newVersion: {
            id: result.newVersion.versionId,
            versionNumber: result.newVersion.versionNumber,
          },
        },
      });
    } catch (error) {
      logger.error('[FileVersioningRoutes] Rollback failed', {
        fileId,
        targetVersionId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof Error) {
        if (error.message.includes('Access denied')) {
          res.status(403).json({
            success: false,
            error: 'Access denied: insufficient permissions',
          });
          return;
        }
        if (
          error.message.includes('not found') ||
          error.message.includes('inactive')
        ) {
          res.status(404).json({
            success: false,
            error: error.message,
          });
          return;
        }
      }

      res.status(500).json({
        success: false,
        error: 'Failed to rollback version',
      });
    }
  }
);

/**
 * @route DELETE /api/files/:fileId/versions/:versionId
 * @desc Delete (soft-delete) a specific version
 * @access Private
 */
router.delete(
  '/:fileId/versions/:versionId',
  [
    param('fileId').isString().notEmpty().withMessage('File ID is required'),
    param('versionId').isString().notEmpty().withMessage('Version ID is required'),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { fileId, versionId } = req.params;
    const userId = req.user?.userId ? parseInt(req.user.userId, 10) : undefined;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    try {
      // First verify the version belongs to the file
      const version = await fileVersioningService.getVersion(versionId, userId);

      if (!version) {
        res.status(404).json({
          success: false,
          error: 'Version not found',
        });
        return;
      }

      if (version.fileId !== fileId) {
        res.status(400).json({
          success: false,
          error: 'Version does not belong to the specified file',
        });
        return;
      }

      logger.info('[FileVersioningRoutes] Deleting version', {
        fileId,
        versionId,
        userId,
      });

      const result = await fileVersioningService.deleteVersion(versionId, userId);

      logger.info('[FileVersioningRoutes] Version deleted successfully', {
        fileId,
        versionId,
        userId,
      });

      res.json({
        success: true,
        data: {
          message: result.message,
        },
      });
    } catch (error) {
      logger.error('[FileVersioningRoutes] Delete version failed', {
        fileId,
        versionId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof Error) {
        if (error.message.includes('Access denied')) {
          res.status(403).json({
            success: false,
            error: 'Access denied: insufficient permissions',
          });
          return;
        }
        if (error.message.includes('Cannot delete the current version')) {
          res.status(400).json({
            success: false,
            error: 'Cannot delete the current version. Rollback to a different version first.',
          });
          return;
        }
      }

      res.status(500).json({
        success: false,
        error: 'Failed to delete version',
      });
    }
  }
);

/**
 * @route GET /api/files/:fileId/versions/compare/:versionId1/:versionId2
 * @desc Compare two versions of a file
 * @access Private
 */
router.get(
  '/:fileId/versions/compare/:versionId1/:versionId2',
  [
    param('fileId').isString().notEmpty().withMessage('File ID is required'),
    param('versionId1')
      .isString()
      .notEmpty()
      .withMessage('First version ID is required'),
    param('versionId2')
      .isString()
      .notEmpty()
      .withMessage('Second version ID is required'),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { fileId, versionId1, versionId2 } = req.params;
    const userId = req.user?.userId ? parseInt(req.user.userId, 10) : undefined;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    try {
      logger.info('[FileVersioningRoutes] Comparing versions', {
        fileId,
        versionId1,
        versionId2,
        userId,
      });

      const comparison = await fileVersioningService.compareVersions(
        versionId1,
        versionId2,
        userId
      );

      // Verify both versions belong to the requested file
      if (
        comparison.version1.fileId !== fileId ||
        comparison.version2.fileId !== fileId
      ) {
        res.status(400).json({
          success: false,
          error: 'One or both versions do not belong to the specified file',
        });
        return;
      }

      res.json({
        success: true,
        data: {
          version1: {
            id: comparison.version1.versionId,
            versionNumber: comparison.version1.versionNumber,
            size: comparison.version1.fileSize,
            checksum: comparison.version1.checksum,
            createdAt: comparison.version1.createdAt,
            comment: comparison.version1.comment,
          },
          version2: {
            id: comparison.version2.versionId,
            versionNumber: comparison.version2.versionNumber,
            size: comparison.version2.fileSize,
            checksum: comparison.version2.checksum,
            createdAt: comparison.version2.createdAt,
            comment: comparison.version2.comment,
          },
          differences: {
            sizeChange: comparison.differences.sizeChange,
            sizeChangeFormatted: formatBytes(
              Math.abs(comparison.differences.sizeChange)
            ),
            sizeDirection:
              comparison.differences.sizeChange > 0 ? 'increased' : 'decreased',
            checksumMatch: comparison.differences.checksumMatch,
            contentChanged: !comparison.differences.checksumMatch,
            timeDifference: comparison.differences.timeDifference,
            timeDifferenceFormatted: formatDuration(
              comparison.differences.timeDifference
            ),
          },
        },
      });
    } catch (error) {
      logger.error('[FileVersioningRoutes] Compare versions failed', {
        fileId,
        versionId1,
        versionId2,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof Error) {
        if (error.message.includes('Access denied')) {
          res.status(403).json({
            success: false,
            error: 'Access denied: insufficient permissions',
          });
          return;
        }
        if (error.message.includes('not found')) {
          res.status(404).json({
            success: false,
            error: error.message,
          });
          return;
        }
      }

      res.status(500).json({
        success: false,
        error: 'Failed to compare versions',
      });
    }
  }
);

/**
 * @route GET /api/files/:fileId/versions/count
 * @desc Get the count of active versions for a file
 * @access Private
 */
router.get(
  '/:fileId/versions/count',
  [param('fileId').isString().notEmpty().withMessage('File ID is required')],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { fileId } = req.params;
    const userId = req.user?.userId ? parseInt(req.user.userId, 10) : undefined;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    try {
      // First check if user has access to this file
      const currentVersion = await fileVersioningService.getCurrentVersion(
        fileId,
        userId
      );

      // If no current version, the file might not exist or user lacks access
      if (!currentVersion) {
        res.status(404).json({
          success: false,
          error: 'File not found or access denied',
        });
        return;
      }

      const count = await fileVersioningService.getVersionCount(fileId);

      res.json({
        success: true,
        data: {
          fileId,
          versionCount: count,
        },
      });
    } catch (error) {
      logger.error('[FileVersioningRoutes] Get version count failed', {
        fileId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      if (error instanceof Error && error.message.includes('Access denied')) {
        res.status(403).json({
          success: false,
          error: 'Access denied: insufficient permissions',
        });
        return;
      }

      res.status(500).json({
        success: false,
        error: 'Failed to get version count',
      });
    }
  }
);

/**
 * @route POST /api/files/:fileId/versions/cleanup
 * @desc Cleanup old versions beyond the configured limit (Admin only)
 * @access Private - ADMIN/SUPER_ADMIN
 */
router.post(
  '/:fileId/versions/cleanup',
  [
    param('fileId').isString().notEmpty().withMessage('File ID is required'),
    body('maxVersions')
      .optional()
      .isInt({ min: 1, max: 100 })
      .withMessage('Max versions must be between 1 and 100'),
  ],
  handleValidationErrors,
  async (req: AuthenticatedRequest, res: Response): Promise<void> => {
    const { fileId } = req.params;
    const { maxVersions } = req.body;
    const userId = req.user?.userId ? parseInt(req.user.userId, 10) : undefined;
    const userRole = req.user?.role;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
      });
      return;
    }

    // Only ADMIN and SUPER_ADMIN can trigger manual cleanup
    if (!hasMinimumRole(userRole as any, ROLES.ADMIN)) {
      res.status(403).json({
        success: false,
        error: 'Admin privileges required for manual cleanup',
      });
      return;
    }

    try {
      logger.info('[FileVersioningRoutes] Initiating version cleanup', {
        fileId,
        maxVersions,
        userId,
      });

      const result = await fileVersioningService.cleanupOldVersions(
        fileId,
        maxVersions
      );

      logger.info('[FileVersioningRoutes] Cleanup completed', {
        fileId,
        deletedVersions: result.deletedVersions,
        freedSpace: result.freedSpace,
        errors: result.errors.length,
      });

      res.json({
        success: true,
        data: {
          deletedVersions: result.deletedVersions,
          freedSpace: result.freedSpace,
          freedSpaceFormatted: formatBytes(result.freedSpace),
          errors: result.errors,
        },
      });
    } catch (error) {
      logger.error('[FileVersioningRoutes] Cleanup failed', {
        fileId,
        maxVersions,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to cleanup old versions',
      });
    }
  }
);

/**
 * Format bytes to human-readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

/**
 * Format duration in milliseconds to human-readable string
 */
function formatDuration(ms: number): string {
  const absMs = Math.abs(ms);
  if (absMs < 1000) return `${absMs}ms`;
  if (absMs < 60000) return `${(absMs / 1000).toFixed(1)}s`;
  if (absMs < 3600000) return `${(absMs / 60000).toFixed(1)}m`;
  if (absMs < 86400000) return `${(absMs / 3600000).toFixed(1)}h`;
  return `${(absMs / 86400000).toFixed(1)}d`;
}

export default router;
export { router as fileVersioningRoutes };
