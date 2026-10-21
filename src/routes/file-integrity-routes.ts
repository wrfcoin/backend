/**
 * File Integrity API Routes
 * Provides REST endpoints for file integrity verification, monitoring, and health checks
 */

import express, { Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import * as crypto from 'crypto';
import { Readable } from 'stream';
import {
  S3Client,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { logger } from '../../utils/logger.js';
import { fileIntegrityService } from '../../server/services/file-integrity-service.js';
import { integrityMonitoringService } from '../../server/services/integrity-monitoring-service.js';
import { filePermissionService } from '../../server/services/file-permission-service.js';
import { enhancedFileStorageService } from '../../server/services/enhanced-file-storage.js';
import { HashAlgorithm, HASH_ALGORITHMS } from '../../shared/file-schema.js';

import { AuthenticatedRequest } from '../../shared/types/security-types.js';

const STRONG_HASH_ALGORITHMS = ['SHA256', 'SHA512', 'BLAKE2B'] as const;
const STRONG_HASH_ALGORITHM_SET = new Set<string>(STRONG_HASH_ALGORITHMS);

// S3 client for retrieving files
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// Extend the base authenticated request with audit context
interface ExtendedAuthenticatedRequest extends AuthenticatedRequest {
  auditContext?: {
    userId?: string;
    sessionId?: string;
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
    deviceFingerprint?: string;
  };
}

const router: express.Router = express.Router();

const toDisallowedAlgorithms = (
  algorithms: readonly string[] | undefined
): string[] => {
  if (!algorithms) {
    return [];
  }

  return Array.from(
    new Set(algorithms.filter(a => !STRONG_HASH_ALGORITHM_SET.has(a)))
  );
};

const unsupportedHashResponse = (disallowedAlgorithms: readonly string[]) => ({
  success: false,
  error:
    'Unsupported hash algorithm requested. Supported algorithms are SHA256, SHA512, and BLAKE2B.',
  code: 'UNSUPPORTED_HASH_ALGORITHM',
  details: {
    disallowedAlgorithms,
    allowedAlgorithms: STRONG_HASH_ALGORITHMS,
  },
});

const ensureStrongHashAlgorithms = (
  req: ExtendedAuthenticatedRequest,
  res: Response,
  algorithms: readonly string[] | undefined,
  route: string
): boolean => {
  const disallowedAlgorithms = toDisallowedAlgorithms(algorithms);
  if (disallowedAlgorithms.length === 0) {
    return true;
  }

  logger.warn('[FileIntegrityAPI] Rejected disallowed hash algorithms', {
    route,
    userId: req.userId,
    disallowedAlgorithms,
    allowedAlgorithms: STRONG_HASH_ALGORITHMS,
  });

  res.status(400).json(unsupportedHashResponse(disallowedAlgorithms));
  return false;
};

// Validation schemas
const verifyIntegritySchema = z.object({
  fileId: z.string().uuid(),
  algorithms: z
    .array(z.enum(HASH_ALGORITHMS as unknown as [HashAlgorithm, ...HashAlgorithm[]]))
    .optional(),
  forceRecompute: z.boolean().optional(),
  includeBinaryComparison: z.boolean().optional(),
});

const scheduleVerificationSchema = z.object({
  fileId: z.string().uuid(),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  scheduledAt: z.string().datetime().optional(),
  algorithms: z
    .array(z.enum(HASH_ALGORITHMS as unknown as [HashAlgorithm, ...HashAlgorithm[]]))
    .optional(),
  recurring: z.boolean().optional(),
  recurringInterval: z.string().optional(), // Cron expression
});

const generateHashesSchema = z.object({
  fileId: z.string().uuid(),
  algorithms: z.array(
    z.enum(HASH_ALGORITHMS as unknown as [HashAlgorithm, ...HashAlgorithm[]])
  ),
});

const reportSchema = z.object({
  reportType: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'CUSTOM']).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
});

// Middleware for authentication (assumes JWT or similar)
const authenticateUser = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    // Extract user ID from JWT token or session
    // This would be implemented based on your authentication strategy
    const userId = req.headers['x-user-id'] as string;

    if (!userId || isNaN(parseInt(userId))) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'AUTHENTICATION_ERROR',
      });
    }

    req.userId = userId;
    next();
  } catch (error) {
    logger.error('[FileIntegrityAPI] Authentication error', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(401).json({
      success: false,
      error: 'Authentication failed',
      code: 'AUTHENTICATION_ERROR',
    });
  }
};

// Apply authentication to all routes
router.use(authenticateUser);

/**
 * POST /api/file-integrity/verify
 * Verify integrity of a specific file
 */
router.post(
  '/verify',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const validation = verifyIntegritySchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request data',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const { fileId, algorithms, forceRecompute, includeBinaryComparison } =
        validation.data;
      const userId = parseInt(req.userId!, 10);

      if (!ensureStrongHashAlgorithms(req, res, algorithms, '/verify')) {
        return;
      }

      // Check if user has read permission for the file
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'READ'
      );

      if (!permissionCheck.hasPermission) {
        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions to verify file integrity',
          code: 'AUTHORIZATION_ERROR',
        });
      }

      const result = await fileIntegrityService.verifyFileIntegrity({
        fileId,
        userId,
        algorithms,
        forceRecompute,
        includeBinaryComparison,
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error verifying file integrity', {
        userId: req.user?.id,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to verify file integrity',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/file-integrity/detect-corruption
 * Detect corruption in a specific file
 */
router.post(
  '/detect-corruption',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const { fileId } = req.body;
      const userId = parseInt(req.userId!, 10);

      if (!fileId || typeof fileId !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'fileId is required',
          code: 'VALIDATION_ERROR',
        });
      }

      // Check permissions
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'READ'
      );

      if (!permissionCheck.hasPermission) {
        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions to check file corruption',
          code: 'AUTHORIZATION_ERROR',
        });
      }

      const result = await fileIntegrityService.detectCorruption(
        fileId,
        userId
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error detecting corruption', {
        userId: req.user?.id,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to detect corruption',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/file-integrity/generate-hashes
 * Generate hashes for a file using specified algorithms
 */
router.post(
  '/generate-hashes',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const validation = generateHashesSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request data',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const { fileId, algorithms } = validation.data;
      const userId = parseInt(req.userId!, 10);

      if (
        !ensureStrongHashAlgorithms(req, res, algorithms, '/generate-hashes')
      ) {
        return;
      }

      // Check permissions
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'READ'
      );

      if (!permissionCheck.hasPermission) {
        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions to generate file hashes',
          code: 'AUTHORIZATION_ERROR',
        });
      }

      // Get file record from database
      const file = await enhancedFileStorageService.getFile(userId, fileId);
      if (!file) {
        return res.status(404).json({
          success: false,
          error: 'File not found',
          code: 'FILE_NOT_FOUND',
        });
      }

      logger.info('[FileIntegrityAPI] Generating hashes for file', {
        userId,
        fileId,
        storagePath: file.storagePath,
        algorithms,
      });

      // Download file from S3
      const getCommand = new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: file.storagePath,
      });

      const s3Response = await s3Client.send(getCommand);
      if (!s3Response.Body) {
        return res.status(500).json({
          success: false,
          error: 'Failed to retrieve file from storage',
          code: 'STORAGE_ERROR',
        });
      }

      // Convert stream to buffer
      const chunks: Buffer[] = [];
      const bodyStream = s3Response.Body as Readable;
      for await (const chunk of bodyStream) {
        chunks.push(Buffer.from(chunk));
      }
      const fileBuffer = Buffer.concat(chunks);
      const fileSize = fileBuffer.length;

      // Compute hashes for each requested algorithm
      const startTime = Date.now();
      const hashes: Array<{
        algorithm: HashAlgorithm;
        hash: string;
        size: number;
        generatedAt: Date;
        verificationTime: number;
      }> = [];

      for (const algorithm of algorithms) {
        const hashStartTime = Date.now();
        let hashAlgorithm: string | undefined;

        switch (algorithm) {
          case 'SHA256':
            hashAlgorithm = 'sha256';
            break;
          case 'BLAKE2B':
            hashAlgorithm = 'blake2b512';
            break;
          case 'SHA512':
            hashAlgorithm = 'sha512';
            break;
          default:
            logger.error(
              '[FileIntegrityAPI] Non-strong algorithm reached hash generation',
              {
                algorithm,
                fileId,
              }
            );
            return res.status(400).json(
              unsupportedHashResponse([
                String(algorithm),
              ])
            );
        }

        if (!hashAlgorithm) {
          logger.error('[FileIntegrityAPI] Failed to map strong hash algorithm', {
            algorithm,
            fileId,
          });
          return res.status(500).json({
            success: false,
            error: 'Failed to map hash algorithm',
            code: 'INTERNAL_SERVER_ERROR',
          });
        }

        const hash = crypto.createHash(hashAlgorithm);
        hash.update(fileBuffer);
        const hashValue = hash.digest('hex');
        const hashTime = Date.now() - hashStartTime;

        hashes.push({
          algorithm,
          hash: hashValue,
          size: fileSize,
          generatedAt: new Date(),
          verificationTime: hashTime,
        });
      }

      const totalTime = Date.now() - startTime;

      logger.info('[FileIntegrityAPI] Hashes generated successfully', {
        userId,
        fileId,
        algorithms: hashes.map(h => h.algorithm),
        fileSize,
        totalTime,
      });

      res.status(200).json({
        success: true,
        data: {
          fileId,
          filename: file.filename,
          size: fileSize,
          hashes,
          generatedAt: new Date().toISOString(),
          totalTime,
        },
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error generating hashes', {
        userId: req.user?.id,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      // Handle S3 errors specifically
      if ((error as any)?.name === 'NoSuchKey') {
        return res.status(404).json({
          success: false,
          error: 'File not found in storage',
          code: 'FILE_NOT_FOUND',
        });
      }

      res.status(500).json({
        success: false,
        error: 'Failed to generate hashes',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/file-integrity/schedule-verification
 * Schedule integrity verification for a file
 */
router.post(
  '/schedule-verification',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const validation = scheduleVerificationSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request data',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const {
        fileId,
        priority,
        scheduledAt,
        algorithms,
        recurring,
        recurringInterval,
      } = validation.data;
      const userId = parseInt(req.userId!, 10);

      if (
        !ensureStrongHashAlgorithms(req, res, algorithms, '/schedule-verification')
      ) {
        return;
      }

      // Check permissions
      const permissionCheck = await filePermissionService.checkFilePermission(
        userId,
        fileId,
        'READ'
      );

      if (!permissionCheck.hasPermission) {
        return res.status(403).json({
          success: false,
          error: 'Insufficient permissions to schedule verification',
          code: 'AUTHORIZATION_ERROR',
        });
      }

      const verificationId =
        await integrityMonitoringService.scheduleVerification(fileId, userId, {
          priority,
          scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
          algorithms,
          recurring,
          recurringInterval,
        });

      res.json({
        success: true,
        data: {
          verificationId,
          message: 'Verification scheduled successfully',
        },
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error scheduling verification', {
        userId: req.user?.id,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to schedule verification',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * GET /api/file-integrity/health-status
 * Get overall integrity health status
 */
router.get(
  '/health-status',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const healthStatus = await integrityMonitoringService.getHealthStatus();

      res.json({
        success: true,
        data: healthStatus,
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error getting health status', {
        userId: req.user?.id,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get health status',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * GET /api/file-integrity/monitoring-status
 * Get monitoring system status
 */
router.get(
  '/monitoring-status',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const monitoringStatus = fileIntegrityService.getMonitoringStatus();

      res.json({
        success: true,
        data: monitoringStatus,
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error getting monitoring status', {
        userId: req.user?.id,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get monitoring status',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * GET /api/file-integrity/scheduled-verifications
 * Get all scheduled verifications
 */
router.get(
  '/scheduled-verifications',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const scheduledVerifications =
        integrityMonitoringService.getScheduledVerifications();

      // Filter to only show user's own files (would need additional permission checks)
      res.json({
        success: true,
        data: scheduledVerifications,
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error getting scheduled verifications', {
        userId: req.user?.id,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get scheduled verifications',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * DELETE /api/file-integrity/scheduled-verifications/:verificationId
 * Cancel a scheduled verification
 */
router.delete(
  '/scheduled-verifications/:verificationId',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const { verificationId } = req.params;
      const userId = parseInt(req.userId!, 10);

      if (!verificationId) {
        return res.status(400).json({
          success: false,
          error: 'verificationId is required',
          code: 'VALIDATION_ERROR',
        });
      }

      const success =
        await integrityMonitoringService.cancelVerification(verificationId);

      if (!success) {
        return res.status(404).json({
          success: false,
          error: 'Verification not found or cannot be cancelled',
          code: 'RESOURCE_NOT_FOUND',
        });
      }

      res.json({
        success: true,
        data: {
          message: 'Verification cancelled successfully',
        },
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error cancelling verification', {
        userId: req.user?.id,
        verificationId: req.params.verificationId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to cancel verification',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/file-integrity/alerts/:alertId/acknowledge
 * Acknowledge an integrity alert
 */
router.post(
  '/alerts/:alertId/acknowledge',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const { alertId } = req.params;
      const userId = parseInt(req.userId!, 10);

      if (!alertId) {
        return res.status(400).json({
          success: false,
          error: 'alertId is required',
          code: 'VALIDATION_ERROR',
        });
      }

      const success = await integrityMonitoringService.acknowledgeAlert(
        alertId,
        userId
      );

      if (!success) {
        return res.status(404).json({
          success: false,
          error: 'Alert not found',
          code: 'RESOURCE_NOT_FOUND',
        });
      }

      res.json({
        success: true,
        data: {
          message: 'Alert acknowledged successfully',
        },
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error acknowledging alert', {
        userId: req.user?.id,
        alertId: req.params.alertId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to acknowledge alert',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/file-integrity/reports/generate
 * Generate integrity report
 */
router.post(
  '/reports/generate',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const validation = reportSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request data',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const { reportType, startDate, endDate } = validation.data;

      let customPeriod;
      if (startDate && endDate) {
        customPeriod = {
          start: new Date(startDate),
          end: new Date(endDate),
        };
      }

      const report = await integrityMonitoringService.generateReport(
        reportType || 'DAILY',
        customPeriod
      );

      res.json({
        success: true,
        data: report,
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error generating report', {
        userId: req.user?.id,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to generate report',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * GET /api/file-integrity/statistics
 * Get integrity statistics
 */
router.get(
  '/statistics',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const { startDate, endDate } = req.query;

      let timeRange;
      if (startDate && endDate) {
        timeRange = {
          start: new Date(startDate as string),
          end: new Date(endDate as string),
        };
      }

      const statistics =
        await fileIntegrityService.getIntegrityStatistics(timeRange);

      res.json({
        success: true,
        data: statistics,
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error getting statistics', {
        userId: req.user?.id,
        query: req.query,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get statistics',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * PUT /api/file-integrity/monitoring-config
 * Update monitoring configuration (admin only)
 */
router.put(
  '/monitoring-config',
  async (req: ExtendedAuthenticatedRequest, res: Response) => {
    try {
      const userId = parseInt(req.userId!, 10);

      // Check if user has admin privileges (this would be implemented based on your role system)
      // For now, we'll assume all authenticated users can modify config

      const { enabled, checkInterval, batchSize, algorithms, alertThreshold } =
        req.body;

      if (algorithms !== undefined) {
        if (
          !Array.isArray(algorithms) ||
          algorithms.some((algorithm: unknown) => typeof algorithm !== 'string')
        ) {
          return res.status(400).json({
            success: false,
            error: 'Invalid request data',
            code: 'VALIDATION_ERROR',
          });
        }

        if (
          !ensureStrongHashAlgorithms(
            req,
            res,
            algorithms as string[],
            '/monitoring-config'
          )
        ) {
          return;
        }
      }

      const config = {
        ...(enabled !== undefined && { enabled }),
        ...(checkInterval !== undefined && { checkInterval }),
        ...(batchSize !== undefined && { batchSize }),
        ...(algorithms !== undefined && {
          algorithms: algorithms as HashAlgorithm[],
        }),
        ...(alertThreshold !== undefined && { alertThreshold }),
      };

      fileIntegrityService.updateMonitoringConfig(config);

      res.json({
        success: true,
        data: {
          message: 'Monitoring configuration updated successfully',
          config,
        },
      });
    } catch (error) {
      logger.error('[FileIntegrityAPI] Error updating monitoring config', {
        userId: req.user?.id,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to update monitoring configuration',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

// Error handling middleware
router.use((error: Error, req: Request, res: Response, next: NextFunction) => {
  logger.error('[FileIntegrityAPI] Unhandled error', {
    path: req.path,
    method: req.method,
    userId: req.userId,
    error: error.message,
    stack: error.stack,
  });

  res.status(500).json({
    success: false,
    error: 'Internal server error',
    code: 'INTERNAL_SERVER_ERROR',
  });
});

export default router;

// Note: Express.Request.userId is augmented as string elsewhere.
// This file converts to number internally for service calls.
