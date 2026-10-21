/**
 * Multi-Network Upload Routes
 * Extended upload functionality with intelligent multi-network storage routing
 * Integrates with Auth Sub-Agent's permission system and Storage Sub-Agent's multi-network adapter
 */

import * as express from 'express';
import multer from 'multer';
import * as crypto from 'crypto';
import * as path from 'path';
import { fileTypeFromBuffer } from 'file-type';
import { Request, Response, NextFunction } from 'express';
import { authenticateJWT } from '../../server/middleware/auth.js';
import { validateFileUpload } from '../middleware/fileValidation.js';
import { logger } from '../../utils/logger.js';
import { sanitizeInput } from '../../utils/sanitize-input.js';
import { AuthenticatedRequest } from '../../shared/types/security-types.js';

// Import our storage services
import {
  multiNetworkStorageAdapter,
  MultiNetworkUploadRequest,
  MultiNetworkDownloadRequest,
} from '../../server/services/multi-network-storage-adapter.js';
import {
  storageStrategyEngine,
  StorageRequirements,
} from '../../server/services/storage-strategy-engine.js';
import { storageHealthMonitor } from '../../server/services/storage-health-monitor.js';
import {
  enhancedFileStorageService,
  FileAccessContext,
} from '../../server/services/enhanced-file-storage.js';
import { filePermissionService } from '../../server/services/file-permission-service.js';
import { FileVisibility } from '../../shared/file-schema.js';

const router: express.Router = express.Router();

// Multer Configuration for Memory Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 500 * 1024 * 1024, // 500MB limit for multi-network storage
    files: 10, // Allow more files for batch operations
  },
  fileFilter: (req, file, cb) => {
    // More permissive MIME type allowlist for multi-network storage
    const allowedMimeTypes = [
      // Images
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'image/bmp',
      'image/tiff',
      // Documents
      'application/pdf',
      'text/plain',
      'text/csv',
      'text/markdown',
      'application/json',
      'application/xml',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      // Archives
      'application/zip',
      'application/gzip',
      'application/x-tar',
      'application/x-rar-compressed',
      // Media
      'video/mp4',
      'video/webm',
      'video/quicktime',
      'video/x-msvideo',
      'audio/mpeg',
      'audio/wav',
      'audio/ogg',
      'audio/aac',
      // Data
      'application/octet-stream',
      // Code
      'text/javascript',
      'text/css',
      'text/html',
      'application/javascript',
    ];

    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      logger.warn(
        '[MultiNetworkUpload] File rejected due to invalid MIME type',
        {
          mimetype: file.mimetype,
          filename: file.originalname,
        }
      );
      cb(new Error('Invalid file type. Please check the allowed file types.'));
    }
  },
});

/**
 * Multi-network file upload endpoint with intelligent routing
 */
(router as any).post(
  '/multi-network',
  authenticateJWT,
  upload.array('files', 10),
  validateFileUpload,
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    const uploadId = crypto.randomUUID();
    const files = req.files as Express.Multer.File[];

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    try {
      if (!files || files.length === 0) {
        res.status(400).json({
          success: false,
          error: 'No files uploaded',
          code: 'NO_FILES',
        });
        return;
      }

      logger.info('[MultiNetworkUpload] Multi-network file upload initiated', {
        userId,
        uploadId,
        fileCount: files.length,
        totalSize: files.reduce((sum, file) => sum + file.size, 0),
      });

      // Parse upload parameters
      const {
        redundancyLevel = 3,
        performanceRequirement = 'MEDIUM',
        costOptimization = 'BALANCE',
        geographicDistribution,
        compressionEnabled = true,
        deduplicationEnabled = true,
        visibility = 'PRIVATE',
        tags,
      } = req.body;

      const uploadResults: any[] = [];
      const errors: Array<{
        filename: string;
        error: string;
        code: string;
        details?: string;
      }> = [];

      // Process each file
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        const fileUploadId = `${uploadId}_${i}`;

        try {
          // 1. Validate file magic numbers
          const fileType = await fileTypeFromBuffer(file.buffer);
          if (!fileType) {
            logger.warn('[MultiNetworkUpload] Could not determine file type', {
              userId,
              fileUploadId,
              claimedType: file.mimetype,
            });
            // Use claimed MIME type if detection fails
          }

          const actualMimeType = fileType?.mime || file.mimetype;

          // 2. Calculate file checksum
          const checksum = crypto
            .createHash('sha256')
            .update(file.buffer)
            .digest('hex');

          // 3. Prepare multi-network upload request
          const multiNetworkRequest: MultiNetworkUploadRequest = {
            originalName: sanitizeInput(file.originalname),
            filename: file.originalname, // Will be processed by storage adapter
            mimeType: actualMimeType,
            fileSize: file.size,
            storageProvider: 'MULTI_NETWORK',
            storagePath: '', // Will be set by storage adapter
            checksum,
            visibility: visibility as FileVisibility,
            tags: parseTags(tags),
            metadata: {
              uploadId: fileUploadId,
              userAgent: req.get('User-Agent'),
              ipAddress: req.ip,
              uploadTimestamp: new Date().toISOString(),
            },
            encryptionRequired: shouldEncryptFile(actualMimeType, file.size),
            redundancyLevel: Math.max(
              1,
              Math.min(5, parseInt(String(redundancyLevel)))
            ),
            performanceRequirement: performanceRequirement as
              | 'LOW'
              | 'MEDIUM'
              | 'HIGH',
            costOptimization: costOptimization as
              | 'MINIMIZE'
              | 'BALANCE'
              | 'PERFORMANCE',
            geographicDistribution: geographicDistribution
              ? geographicDistribution.split(',')
              : undefined,
            compressionEnabled,
            deduplicationEnabled,
          };

          // 4. Upload to multi-network storage
          const storageResult = await multiNetworkStorageAdapter.uploadFile(
            parseInt(userId) || 0,
            {
              ...multiNetworkRequest,
              data: file.buffer,
            } as any
          );

          // 5. Prepare result
          uploadResults.push({
            fileId: storageResult.fileId,
            filename: file.originalname,
            size: file.size,
            type: actualMimeType,
            checksum,
            visibility,
            tags: parseTags(tags),
            encrypted: multiNetworkRequest.encryptionRequired,
            uploadedAt: new Date().toISOString(),
            storageLocations: storageResult.locations.map(loc => ({
              provider: loc.provider,
              isActive: loc.isActive,
              createdAt: loc.createdAt,
            })),
            operationId: storageResult.operation.operationId,
            redundancyAchieved: storageResult.locations.length,
          });

          logger.info(
            '[MultiNetworkUpload] File uploaded to multi-network storage',
            {
              userId,
              fileUploadId,
              fileId: storageResult.fileId,
              locationsCount: storageResult.locations.length,
              providers: storageResult.locations.map(l => l.provider),
              size: file.size,
              type: actualMimeType,
            }
          );
        } catch (fileError) {
          logger.error('[MultiNetworkUpload] Individual file upload failed', {
            userId,
            fileUploadId,
            filename: file.originalname,
            error:
              fileError instanceof Error
                ? fileError.message
                : String(fileError),
          });
          errors.push({
            filename: file.originalname,
            error: 'Multi-network upload failed',
            code: 'UPLOAD_ERROR',
            details:
              fileError instanceof Error
                ? fileError.message
                : String(fileError),
          });
        }
      }

      // 6. Return comprehensive response
      const response = {
        success: uploadResults.length > 0,
        data: {
          uploadId,
          uploadedFiles: uploadResults,
          errors,
          summary: {
            totalFiles: files.length,
            successfulUploads: uploadResults.length,
            failedUploads: errors.length,
            totalRedundancyLocations: uploadResults.reduce(
              (sum, file) => sum + file.redundancyAchieved,
              0
            ),
            averageRedundancy:
              uploadResults.length > 0
                ? uploadResults.reduce(
                    (sum, file) => sum + file.redundancyAchieved,
                    0
                  ) / uploadResults.length
                : 0,
          },
        },
        timestamp: new Date().toISOString(),
      };

      const statusCode = uploadResults.length > 0 ? 201 : 400;
      res.status(statusCode).json(response);
    } catch (error) {
      logger.error('[MultiNetworkUpload] Multi-network upload batch failed', {
        userId,
        uploadId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Multi-network upload failed',
        code: 'UPLOAD_ERROR',
        uploadId,
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * Multi-network file download endpoint with optimal provider selection
 */
router.get(
  '/multi-network/:fileId',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    const fileId = sanitizeInput(req.params.fileId);

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    try {
      // Validate fileId format
      if (!isValidUUID(fileId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid file ID format',
          code: 'INVALID_FILE_ID',
        });
        return;
      }

      // Create access context
      const context: FileAccessContext = {
        userId: parseInt(userId) || 0,
        ipAddress: req.ip || 'unknown',
        userAgent: req.get('User-Agent'),
        sessionId: (req as any).session?.id,
        requestId: req.get('X-Request-ID') || crypto.randomUUID(),
      };

      // Check if file exists and user has permission
      const file = await enhancedFileStorageService.getFile(
        parseInt(userId) || 0,
        fileId,
        context
      );

      if (!file) {
        res.status(404).json({
          success: false,
          error: 'File not found or access denied',
          code: 'FILE_NOT_FOUND',
        });
        return;
      }

      // Parse query parameters for download preferences
      const {
        preferredProviders,
        maxLatency,
        allowFallback = 'true',
      } = req.query;

      // Prepare multi-network download request
      const downloadRequest: MultiNetworkDownloadRequest = {
        fileId,
        userId: parseInt(userId) || 0,
        preferredProviders: preferredProviders
          ? (preferredProviders as string).split(',')
          : undefined,
        maxLatency: maxLatency ? parseInt(String(maxLatency)) : undefined,
        allowFallback: allowFallback === 'true',
      };

      // Download from optimal provider
      const downloadResult =
        await multiNetworkStorageAdapter.downloadFile(downloadRequest);

      // Set appropriate headers for file download
      res.setHeader('Content-Type', file.mimeType);
      res.setHeader('Content-Length', downloadResult.data.length);
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${file.originalName}"`
      );
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('X-Provider-Used', downloadResult.metadata.provider);
      res.setHeader(
        'X-Retrieval-Time',
        downloadResult.metadata.retrievalTime.toString()
      );

      // Log successful download
      logger.info(
        '[MultiNetworkUpload] Multi-network file download completed',
        {
          userId,
          fileId,
          filename: file.originalName,
          size: downloadResult.data.length,
          provider: downloadResult.metadata.provider,
          retrievalTime: downloadResult.metadata.retrievalTime,
        }
      );

      // Send file data
      res.send(downloadResult.data);
    } catch (error) {
      logger.error('[MultiNetworkUpload] Multi-network download failed', {
        userId,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Multi-network download failed',
        code: 'DOWNLOAD_ERROR',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * Get storage strategy recommendations for a file
 */
router.post(
  '/storage/strategy',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    try {
      const {
        fileSize,
        mimeType,
        redundancyLevel = 3,
        performanceRequirement = 'MEDIUM',
        costOptimization = 'BALANCE',
        geographicDistribution,
        durabilityRequirement,
        availabilityRequirement,
        complianceRequirements,
      } = req.body;

      if (!fileSize || !mimeType) {
        res.status(400).json({
          success: false,
          error: 'fileSize and mimeType are required',
          code: 'INVALID_PARAMETERS',
        });
        return;
      }

      const requirements: StorageRequirements = {
        fileSize,
        mimeType,
        redundancyLevel,
        performanceRequirement,
        costOptimization,
        geographicDistribution,
        durabilityRequirement,
        availabilityRequirement,
        complianceRequirements,
      };

      const strategy =
        await storageStrategyEngine.getOptimalStrategy(requirements);

      logger.info('[MultiNetworkUpload] Storage strategy requested', {
        userId,
        fileSize,
        mimeType,
        estimatedCost: strategy.estimatedCost,
        estimatedLatency: strategy.estimatedLatency,
      });

      res.json({
        success: true,
        data: {
          strategy,
          requirements,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('[MultiNetworkUpload] Storage strategy request failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Storage strategy request failed',
        code: 'STRATEGY_ERROR',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * Migrate file between storage providers
 */
router.post(
  '/storage/migrate/:fileId',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    const fileId = sanitizeInput(req.params.fileId);
    const { targetProviders } = req.body;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    try {
      if (
        !isValidUUID(fileId) ||
        !targetProviders ||
        !Array.isArray(targetProviders)
      ) {
        res.status(400).json({
          success: false,
          error: 'Invalid parameters',
          code: 'INVALID_PARAMETERS',
        });
        return;
      }

      // Check if user has admin permission for the file
      const permissionCheck = await filePermissionService.checkFilePermission(
        parseInt(userId!) || 0,
        fileId,
        'ADMIN'
      );

      if (!permissionCheck.hasPermission) {
        res.status(403).json({
          success: false,
          error: 'Insufficient permissions for file migration',
          code: 'INSUFFICIENT_PERMISSIONS',
        });
        return;
      }

      const operation = await multiNetworkStorageAdapter.migrateFile(
        fileId,
        targetProviders,
        parseInt(userId!) || 0
      );

      logger.info('[MultiNetworkUpload] File migration initiated', {
        userId,
        fileId,
        targetProviders,
        operationId: operation.operationId,
      });

      res.json({
        success: true,
        data: {
          operation,
          fileId,
          targetProviders,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('[MultiNetworkUpload] File migration failed', {
        userId,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'File migration failed',
        code: 'MIGRATION_ERROR',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * Get storage health status
 */
router.get(
  '/storage/health',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    try {
      const healthStatus = await storageHealthMonitor.getAllNetworkHealth();
      const activeAlerts = storageHealthMonitor.getActiveAlerts();
      const monitoringStats = storageHealthMonitor.getMonitoringStats();

      res.json({
        success: true,
        data: {
          networkHealth: healthStatus,
          activeAlerts,
          monitoringStats,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('[MultiNetworkUpload] Storage health check failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Storage health check failed',
        code: 'HEALTH_CHECK_ERROR',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * Get storage analytics
 */
router.get(
  '/storage/analytics',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    try {
      const analytics = await multiNetworkStorageAdapter.getStorageAnalytics();

      res.json({
        success: true,
        data: {
          ...analytics,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('[MultiNetworkUpload] Storage analytics request failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Storage analytics request failed',
        code: 'ANALYTICS_ERROR',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * Optimize storage for cost and performance
 */
router.post(
  '/storage/optimize',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    try {
      const optimization = await multiNetworkStorageAdapter.optimizeStorage();

      logger.info('[MultiNetworkUpload] Storage optimization requested', {
        userId,
        optimizationsFound: optimization.optimizations.length,
        migrationsNeeded: optimization.migrationsNeeded,
      });

      res.json({
        success: true,
        data: {
          ...optimization,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('[MultiNetworkUpload] Storage optimization failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Storage optimization failed',
        code: 'OPTIMIZATION_ERROR',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * Get operation status
 */
router.get(
  '/operations/:operationId',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    const operationId = sanitizeInput(req.params.operationId);

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    try {
      const operation = multiNetworkStorageAdapter.getOperation(operationId);

      if (!operation) {
        res.status(404).json({
          success: false,
          error: 'Operation not found',
          code: 'OPERATION_NOT_FOUND',
        });
        return;
      }

      // Check if user has access to this operation
      if (operation.metadata.userId && operation.metadata.userId !== userId) {
        res.status(403).json({
          success: false,
          error: 'Access denied',
          code: 'ACCESS_DENIED',
        });
        return;
      }

      res.json({
        success: true,
        data: {
          operation,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('[MultiNetworkUpload] Operation status request failed', {
        userId,
        operationId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Operation status request failed',
        code: 'OPERATION_ERROR',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

// Helper functions

function isValidUUID(uuid: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function shouldEncryptFile(mimeType: string, fileSize: number): boolean {
  // Encrypt files larger than 50MB or containing sensitive data types
  const sensitiveTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument',
    'application/zip',
    'application/gzip',
    'application/x-tar',
    'application/x-rar-compressed',
  ];

  return (
    fileSize > 50 * 1024 * 1024 ||
    sensitiveTypes.some(type => mimeType.includes(type))
  );
}

function parseTags(tagsParam: any): string[] {
  if (typeof tagsParam === 'string') {
    return tagsParam
      .split(',')
      .map(tag => tag.trim())
      .filter(tag => tag.length > 0);
  }
  if (Array.isArray(tagsParam)) {
    return tagsParam.filter(
      tag => typeof tag === 'string' && tag.trim().length > 0
    );
  }
  return [];
}

export default router;
