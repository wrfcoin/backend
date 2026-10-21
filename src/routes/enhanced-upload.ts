/**
 * Enhanced File Upload Routes with Permission-Based Access Control
 * Integrates with the existing upload.ts patterns and adds RBAC functionality
 *
 * Security Features:
 * - Role-based upload limits (size, daily count, storage quota)
 * - ClamAV virus scanning with strict mode
 * - HSM-backed envelope encryption for sensitive files
 * - Automatic file versioning
 * - Comprehensive audit logging
 */

import * as express from 'express';
import multer from 'multer';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import * as path from 'path';
import { fileTypeFromBuffer } from 'file-type';
import { Request, Response, NextFunction } from 'express';
import { authenticateJWT } from '../../server/middleware/auth.js';
import { validateFileUpload } from '../middleware/fileValidation.js';
import {
  scanFile,
  getScannerStatus,
} from '../middleware/virusScanMiddleware.js';
import { logger } from '../../utils/logger.js';
import { sanitizeInput } from '../../utils/sanitize-input.js';
import { AuthenticatedRequest } from '../../shared/types/security-types.js';

// Environment configuration for strict virus scanning
const STRICT_VIRUS_SCAN = process.env.STRICT_VIRUS_SCAN !== 'false';

// Import our enhanced services
import {
  enhancedFileStorageService,
  FileAccessContext,
} from '../../server/services/enhanced-file-storage.js';
import {
  filePermissionService,
  PermissionCheckResult,
} from '../../server/services/file-permission-service.js';
import { vaultIntegrationService } from '../../server/services/vault-integration-service.js';
import {
  PERMISSION_LEVELS,
  PermissionLevel,
  FileVisibility,
} from '../../shared/file-schema.js';

// Import new security services
import {
  uploadLimitsMiddleware,
  getUploadLimitsInfo,
  invalidateStorageCache,
} from '../middleware/uploadLimitsMiddleware.js';
import {
  fileEncryptionService,
  EncryptionResult,
} from '../../server/services/file-encryption-service.js';
import {
  fileVersioningService,
  CreateVersionRequest,
} from '../../server/services/file-versioning-service.js';
import {
  auditService,
  FILE_AUDIT_EVENTS,
  FileAuditEventRequest,
} from '../../server/services/audit-service.js';

const router = express.Router();

// AWS S3 Configuration
const s3Client = new S3Client({
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

// ClamAV Scanner is now managed centrally by virusScanMiddleware
// See backend/src/middleware/virusScanMiddleware.ts for configuration

// Initialize Vault on startup
vaultIntegrationService.initialize().catch(error => {
  logger.error('[EnhancedUpload] Failed to initialize Vault service', {
    error: error.message,
  });
});

// Multer Configuration for Memory Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit (increased from 10MB)
    files: 5, // Allow multiple files
  },
  fileFilter: (req, file, cb) => {
    // Extended MIME type allowlist
    const allowedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/svg+xml',
      'application/pdf',
      'text/plain',
      'text/csv',
      'text/markdown',
      'application/json',
      'application/xml',
      'application/zip',
      'application/gzip',
      'video/mp4',
      'video/webm',
      'audio/mpeg',
      'audio/wav',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ];

    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      logger.warn('[EnhancedUpload] File rejected due to invalid MIME type', {
        mimetype: file.mimetype,
        filename: file.originalname,
      });
      cb(new Error('Invalid file type. Please check the allowed file types.'));
    }
  },
});

/**
 * Enhanced secure file upload endpoint with permission management
 * Upload flow: Limits -> Virus Scan -> Encryption -> Version -> Storage -> Audit
 */
(router as any).post(
  '/file',
  authenticateJWT,
  uploadLimitsMiddleware,
  upload.array('files', 5),
  validateFileUpload,
  async (req: AuthenticatedRequest, res: Response) => {
    const userIdString = req.user?.userId;
    const userId = userIdString ? parseInt(userIdString, 10) : 0;
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

      logger.info('[EnhancedUpload] File upload initiated', {
        userId,
        uploadId,
        fileCount: files.length,
        totalSize: files.reduce((sum, file) => sum + file.size, 0),
      });

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
          if (!fileType || !isAllowedFileType(fileType.mime)) {
            logger.warn(
              '[EnhancedUpload] File rejected due to invalid file signature',
              {
                userId,
                fileUploadId,
                detectedType: fileType?.mime,
                claimedType: file.mimetype,
              }
            );
            errors.push({
              filename: file.originalname,
              error: 'Invalid file type detected',
              code: 'INVALID_FILE_TYPE',
            });
            continue;
          }

          // 2. Virus scanning with ClamAV (strict mode enforcement)
          const virusScanResult = await scanFile(file.buffer, file.originalname, userIdString);

          if (!virusScanResult.scanned && virusScanResult.strictModeEnforced) {
            // Scanner unavailable and strict mode is enabled - reject entire batch
            logger.error('[EnhancedUpload] Virus scanner unavailable - rejecting upload (strict mode)', {
              userId,
              fileUploadId,
              error: virusScanResult.error,
            });
            res.status(503).json({
              success: false,
              error: 'Virus scanning service unavailable. Upload rejected for security.',
              code: 'SCANNER_UNAVAILABLE',
              retryAfter: 60,
            });
            return;
          }

          if (!virusScanResult.scanned && !STRICT_VIRUS_SCAN) {
            // Scanner unavailable but strict mode is disabled - log and continue
            logger.warn('[EnhancedUpload] ClamAV unavailable - continuing (STRICT_VIRUS_SCAN=false)', {
              userId,
              fileUploadId,
            });
          }

          if (virusScanResult.isInfected) {
            logger.error('[EnhancedUpload] Malware detected in file', {
              userId,
              fileUploadId,
              viruses: virusScanResult.viruses,
              scanDuration: virusScanResult.scanDuration,
            });
            errors.push({
              filename: file.originalname,
              error: 'Malware detected in uploaded file',
              code: 'MALWARE_DETECTED',
            });
            continue;
          }

          if (virusScanResult.scanned) {
            logger.debug('[EnhancedUpload] File passed virus scan', {
              userId,
              fileUploadId,
              duration: virusScanResult.scanDuration,
            });
          }

          // 3. Generate secure filename and path
          const fileExtension = path.extname(file.originalname).toLowerCase();
          const sanitizedOriginalName = sanitizeInput(file.originalname);
          const secureFilename = `${fileUploadId}_${crypto.randomBytes(8).toString('hex')}${fileExtension}`;
          const s3Key = `uploads/${userId}/${new Date().getFullYear()}/${new Date().getMonth() + 1}/${secureFilename}`;

          // 4. Calculate file checksum
          const checksum = crypto
            .createHash('sha256')
            .update(file.buffer)
            .digest('hex');

          // 5. Determine if encryption is required using encryption service policy
          const encryptionPolicy = fileEncryptionService.determineEncryptionPolicy(
            file.size,
            fileType.mime,
            file.originalname,
            req.body.encrypt === 'true'
          );
          const encryptionRequired = encryptionPolicy.shouldEncrypt;

          // 6. Apply envelope encryption if required
          let dataToUpload: Buffer = file.buffer;
          let encryptionResult: EncryptionResult | undefined;

          if (encryptionRequired) {
            try {
              encryptionResult = await fileEncryptionService.encryptFile(
                file.buffer,
                fileUploadId,
                { originalName: sanitizedOriginalName, mimeType: fileType.mime }
              );
              dataToUpload = encryptionResult.encryptedData;

              logger.debug('[EnhancedUpload] File encrypted with HSM envelope encryption', {
                fileUploadId,
                algorithm: encryptionResult.algorithm,
                originalSize: encryptionResult.originalSize,
                encryptedSize: encryptionResult.encryptedSize,
              });
            } catch (encError) {
              logger.error('[EnhancedUpload] Encryption failed', {
                fileUploadId,
                error: encError instanceof Error ? encError.message : String(encError),
              });
              // Continue without encryption if it fails - log for monitoring
            }
          }

          // 7. Upload to S3 with security settings
          const uploadParams = {
            Bucket: process.env.S3_BUCKET_NAME!,
            Key: s3Key,
            Body: dataToUpload,
            ContentType: fileType.mime,
            Metadata: {
              'original-name': sanitizedOriginalName,
              'upload-id': fileUploadId,
              'user-id': userId.toString(),
              'upload-timestamp': new Date().toISOString(),
              checksum: checksum,
              encrypted: encryptionRequired.toString(),
              'encryption-key-id': encryptionResult?.keyId || '',
              'encryption-algorithm': encryptionResult?.algorithm || '',
            },
            ServerSideEncryption: 'AES256' as const,
            ContentDisposition: 'attachment',
            CacheControl: 'no-cache, no-store, must-revalidate',
          };

          const command = new PutObjectCommand(uploadParams);
          await s3Client.send(command);

          // 8. Create file record with enhanced storage service
          const visibility: FileVisibility = determineFileVisibility(
            req.body.visibility
          );
          const tags = parseTags(req.body.tags);

          const fileRecord = await enhancedFileStorageService.createFile(
            userId,
            {
              originalName: sanitizedOriginalName,
              filename: secureFilename,
              mimeType: fileType.mime,
              fileSize: file.size,
              storageProvider: 'S3',
              storagePath: s3Key,
              checksum,
              visibility,
              tags,
              metadata: {
                uploadId: fileUploadId,
                contentDisposition: 'attachment',
                serverSideEncryption: 'AES256',
                userAgent: req.get('User-Agent'),
                ipAddress: req.ip,
                encryptionKeyId: encryptionResult?.keyId,
                encryptionAlgorithm: encryptionResult?.algorithm,
              },
              encryptionRequired,
            }
          );

          // 9. Create initial file version
          try {
            await fileVersioningService.createVersion({
              fileId: fileRecord.fileId,
              userId,
              storagePath: s3Key,
              fileSize: file.size,
              checksum,
              comment: 'Initial upload',
              metadata: {
                uploadId: fileUploadId,
                encrypted: encryptionRequired,
                mimeType: fileType.mime,
              },
            });
            logger.debug('[EnhancedUpload] Initial file version created', {
              fileId: fileRecord.fileId,
              versionNumber: 1,
            });
          } catch (versionError) {
            // Log but don't fail the upload if versioning fails
            logger.warn('[EnhancedUpload] Failed to create initial version', {
              fileId: fileRecord.fileId,
              error: versionError instanceof Error ? versionError.message : String(versionError),
            });
          }

          // 10. Log audit event for file upload
          try {
            await auditService.logFileEvent({
              eventType: FILE_AUDIT_EVENTS.FILE_UPLOADED,
              fileId: fileRecord.fileId,
              fileName: sanitizedOriginalName,
              operation: 'UPLOAD',
              userId,
              result: 'SUCCESS',
              severity: 'LOW',
              details: {
                fileSize: file.size,
                mimeType: fileType.mime,
                storagePath: s3Key,
                storageProvider: 'S3',
                checksum,
                encryptionAlgorithm: encryptionResult?.algorithm,
                encryptionKeyId: encryptionResult?.keyId,
                versionNumber: 1,
                virusScanResult: virusScanResult.scanned ? 'CLEAN' : 'NOT_SCANNED',
              },
              context: {
                ipAddress: req.ip,
                userAgent: req.get('User-Agent'),
                requestId: fileUploadId,
              },
            });

            // Log encryption event if file was encrypted
            if (encryptionRequired && encryptionResult) {
              await auditService.logFileEvent({
                eventType: FILE_AUDIT_EVENTS.FILE_ENCRYPTED,
                fileId: fileRecord.fileId,
                fileName: sanitizedOriginalName,
                operation: 'ENCRYPT',
                userId,
                result: 'SUCCESS',
                severity: 'LOW',
                details: {
                  encryptionAlgorithm: encryptionResult.algorithm,
                  encryptionKeyId: encryptionResult.keyId,
                  originalSize: encryptionResult.originalSize,
                  encryptedSize: encryptionResult.encryptedSize,
                },
              });
            }
          } catch (auditError) {
            // Log but don't fail the upload if audit logging fails
            logger.warn('[EnhancedUpload] Failed to log audit event', {
              fileId: fileRecord.fileId,
              error: auditError instanceof Error ? auditError.message : String(auditError),
            });
          }

          uploadResults.push({
            fileId: fileRecord.fileId,
            filename: sanitizedOriginalName,
            size: file.size,
            type: fileType.mime,
            checksum,
            visibility,
            tags,
            encrypted: encryptionRequired,
            encryptionKeyId: encryptionResult?.keyId,
            versionNumber: 1,
            uploadedAt: fileRecord.uploadedAt,
          });

          logger.info('[EnhancedUpload] File uploaded successfully', {
            userId,
            fileUploadId,
            fileId: fileRecord.fileId,
            s3Key,
            size: file.size,
            type: fileType.mime,
            encrypted: encryptionRequired,
            versioned: true,
          });
        } catch (fileError) {
          logger.error('[EnhancedUpload] Individual file upload failed', {
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
            error: 'File upload failed',
            code: 'UPLOAD_ERROR',
          });
        }
      }

      // 8. Return comprehensive response
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
          },
        },
        timestamp: new Date().toISOString(),
      };

      const statusCode = uploadResults.length > 0 ? 201 : 400;
      res.status(statusCode).json(response);
    } catch (error) {
      logger.error('[EnhancedUpload] File upload batch failed', {
        userId,
        uploadId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'File upload failed',
        code: 'UPLOAD_ERROR',
        uploadId,
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * Enhanced secure file download endpoint with permission checking
 */
router.get(
  '/file/:fileId',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userIdString = req.user?.userId;
    const userId = userIdString ? parseInt(userIdString, 10) : 0;
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
        userId,
        ipAddress: req.ip,
        userAgent: req.get('User-Agent'),
        sessionId: 'session-' + crypto.randomUUID(),
        requestId: req.get('X-Request-ID') || crypto.randomUUID(),
      };

      // Get file with permission check
      const file = await enhancedFileStorageService.getFile(
        userId,
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

      // Check if file is encrypted and get encryption metadata
      const encryptionMetadata = await fileEncryptionService.getEncryptionMetadata(fileId);

      // Generate pre-signed download URL with role-based expiry
      const userRole = req.user?.role || 'USER';
      const { url: downloadUrl, expiresIn } = await generateSecureDownloadUrl(file.storagePath, {
        filename: file.originalName,
        contentType: file.mimeType,
        userRole,
      });

      // Log successful access
      logger.info('[EnhancedUpload] File download initiated', {
        userId,
        fileId,
        filename: file.originalName,
        size: file.fileSize,
        expiresIn,
        userRole,
        isEncrypted: encryptionMetadata.isEncrypted,
      });

      // Log audit event for file download
      try {
        await auditService.logFileEvent({
          eventType: FILE_AUDIT_EVENTS.FILE_DOWNLOADED,
          fileId,
          fileName: file.originalName,
          operation: 'DOWNLOAD',
          userId,
          result: 'SUCCESS',
          severity: 'LOW',
          details: {
            fileSize: file.fileSize,
            mimeType: file.mimeType,
            storagePath: file.storagePath,
            presignedUrlExpiry: expiresIn,
            isEncrypted: encryptionMetadata.isEncrypted,
            encryptionAlgorithm: encryptionMetadata.algorithm,
          },
          context: {
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
            requestId: context.requestId,
          },
        });

        // Log presigned URL generation event
        await auditService.logFileEvent({
          eventType: FILE_AUDIT_EVENTS.FILE_PRESIGNED_URL_GENERATED,
          fileId,
          fileName: file.originalName,
          operation: 'GENERATE_PRESIGNED_URL',
          userId,
          result: 'SUCCESS',
          severity: 'LOW',
          details: {
            presignedUrlExpiry: expiresIn,
            userRole,
          },
          context: {
            ipAddress: req.ip,
            userAgent: req.get('User-Agent'),
          },
        });
      } catch (auditError) {
        logger.warn('[EnhancedUpload] Failed to log download audit event', {
          fileId,
          error: auditError instanceof Error ? auditError.message : String(auditError),
        });
      }

      res.json({
        success: true,
        data: {
          fileId: file.fileId,
          filename: file.originalName,
          size: file.fileSize,
          type: file.mimeType,
          downloadUrl,
          expiresIn,
          expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
          encrypted: encryptionMetadata.isEncrypted,
          encryptionInfo: encryptionMetadata.isEncrypted ? {
            algorithm: encryptionMetadata.algorithm,
            keyId: encryptionMetadata.keyId,
          } : undefined,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[EnhancedUpload] File download failed', {
        userId,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'File download failed',
        code: 'DOWNLOAD_ERROR',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * List files accessible to the authenticated user
 */
router.get(
  '/files',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userIdString = req.user?.userId;
    const userId = userIdString ? parseInt(userIdString, 10) : 0;

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
        visibility,
        tags,
        limit = '20',
        offset = '0',
        sortBy = 'uploadedAt',
        sortOrder = 'desc',
      } = req.query;

      const listRequest = {
        userId,
        visibility: visibility
          ? ((visibility as string).split(',') as FileVisibility[])
          : undefined,
        tags: tags ? (tags as string).split(',') : undefined,
        limit: Math.min(100, Math.max(1, parseInt(limit as string, 10))),
        offset: Math.max(0, parseInt(offset as string, 10)),
        sortBy: sortBy as
          | 'uploadedAt'
          | 'lastAccessedAt'
          | 'filename'
          | 'fileSize',
        sortOrder: sortOrder as 'asc' | 'desc',
      };

      const result = await enhancedFileStorageService.listFiles(listRequest);

      res.json({
        success: true,
        data: {
          files: result.files,
          pagination: {
            limit: listRequest.limit,
            offset: listRequest.offset,
            total: result.total,
            hasMore: listRequest.offset + listRequest.limit < result.total,
          },
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[EnhancedUpload] File listing failed', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'File listing failed',
        code: 'LISTING_ERROR',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

/**
 * Grant file permissions to another user
 */
router.post(
  '/file/:fileId/permissions',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userIdString = req.user?.userId;
    const userId = userIdString ? parseInt(userIdString, 10) : 0;
    const fileId = sanitizeInput(req.params.fileId);
    const { targetUserId, permissions, expiresAt } = req.body;

    if (!userId) {
      res.status(401).json({
        success: false,
        error: 'Authentication required',
        code: 'UNAUTHORIZED',
      });
      return;
    }

    try {
      if (!isValidUUID(fileId) || !targetUserId || !permissions) {
        res.status(400).json({
          success: false,
          error: 'Invalid request parameters',
          code: 'INVALID_PARAMETERS',
        });
        return;
      }

      // Validate permissions
      const validPermissions = permissions.filter((p: string) =>
        PERMISSION_LEVELS.includes(p as PermissionLevel)
      );

      if (validPermissions.length === 0) {
        res.status(400).json({
          success: false,
          error: 'No valid permissions specified',
          code: 'INVALID_PERMISSIONS',
        });
        return;
      }

      await filePermissionService.grantFilePermission({
        granterId: userId,
        userId: targetUserId,
        fileId,
        permissions: validPermissions,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
      });

      logger.info('[EnhancedUpload] File permissions granted', {
        granterId: userId,
        targetUserId,
        fileId,
        permissions: validPermissions,
      });

      res.json({
        success: true,
        data: {
          fileId,
          targetUserId,
          permissions: validPermissions,
          grantedAt: new Date().toISOString(),
          expiresAt,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      logger.error('[EnhancedUpload] Permission grant failed', {
        userId,
        fileId,
        targetUserId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Permission grant failed',
        code: 'PERMISSION_ERROR',
        timestamp: new Date().toISOString(),
      });
    }
  }
);

// Helper functions

function isAllowedFileType(mimeType: string): boolean {
  const allowedTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'application/pdf',
    'text/plain',
    'text/csv',
    'text/markdown',
    'application/json',
    'application/xml',
    'application/zip',
    'application/gzip',
    'video/mp4',
    'video/webm',
    'audio/mpeg',
    'audio/wav',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ];
  return allowedTypes.includes(mimeType);
}

function isValidUUID(uuid: string): boolean {
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  return uuidRegex.test(uuid);
}

function shouldEncryptFile(mimeType: string, fileSize: number): boolean {
  // Encrypt files larger than 10MB or containing sensitive data types
  const sensitiveTypes = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument',
    'application/zip',
    'application/gzip',
  ];

  return (
    fileSize > 10 * 1024 * 1024 ||
    sensitiveTypes.some(type => mimeType.includes(type))
  );
}

function determineFileVisibility(visibilityParam: any): FileVisibility {
  const validVisibilities: FileVisibility[] = [
    'PRIVATE',
    'SHARED',
    'PUBLIC',
    'RESTRICTED',
  ];
  if (validVisibilities.includes(visibilityParam)) {
    return visibilityParam;
  }
  return 'PRIVATE'; // Default to private
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

// Role-based presigned URL expiry limits (in seconds)
const ROLE_EXPIRY_LIMITS: Record<string, number> = {
  GUEST: 900,        // 15 minutes
  USER: 3600,        // 1 hour
  OPERATOR: 14400,   // 4 hours
  ADMIN: 43200,      // 12 hours
  SUPER_ADMIN: 86400, // 24 hours
};

const MAX_PRESIGNED_URL_EXPIRY = parseInt(process.env.MAX_PRESIGNED_URL_EXPIRY || '86400');
const DEFAULT_PRESIGNED_URL_EXPIRY = parseInt(process.env.PRESIGNED_URL_EXPIRY || '3600');

/**
 * Generate a secure presigned download URL with role-based expiry limits
 */
async function generateSecureDownloadUrl(
  s3Key: string,
  options: {
    filename: string;
    contentType: string;
    expiresIn?: number;
    userRole?: string;
  }
): Promise<{ url: string; expiresIn: number }> {
  // Determine expiry based on role
  const roleLimit = options.userRole
    ? ROLE_EXPIRY_LIMITS[options.userRole] || DEFAULT_PRESIGNED_URL_EXPIRY
    : DEFAULT_PRESIGNED_URL_EXPIRY;

  // Use minimum of requested expiry and role limit
  const requestedExpiry = options.expiresIn || DEFAULT_PRESIGNED_URL_EXPIRY;
  const expiresIn = Math.min(requestedExpiry, roleLimit, MAX_PRESIGNED_URL_EXPIRY);

  const command = new GetObjectCommand({
    Bucket: process.env.S3_BUCKET_NAME!,
    Key: s3Key,
    ResponseContentDisposition: `attachment; filename="${options.filename}"`,
    ResponseContentType: options.contentType,
  });

  const url = await getSignedUrl(s3Client, command, { expiresIn });

  logger.debug('[EnhancedUpload] Generated presigned URL', {
    s3Key,
    expiresIn,
    roleLimit,
    userRole: options.userRole,
  });

  return { url, expiresIn };
}

export default router;
