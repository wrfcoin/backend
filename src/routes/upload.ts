import * as express from 'express';
import multer from 'multer';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import * as crypto from 'crypto';
import * as path from 'path';
import { fileTypeFromBuffer } from 'file-type';
import { Request, Response, NextFunction } from 'express';
import { authenticateJWT } from '../../server/middleware/auth.js';
import { validateFileUpload } from '../middleware/fileValidation.js';
import {
  virusScanMiddleware,
  scanFile,
  getScannerStatus,
} from '../middleware/virusScanMiddleware.js';
import { logger } from '../../utils/logger.js';
import {
  sanitizeInput,
  isValidUUID as validateUUID,
} from '../../utils/sanitize-input.js';
import { AuthenticatedRequest } from '../../shared/types/security-types.js';

// Environment configuration for strict virus scanning
const STRICT_VIRUS_SCAN = process.env.STRICT_VIRUS_SCAN !== 'false';

const router: express.Router = express.Router();

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

// Multer Configuration for Memory Storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB limit
    files: 1, // Only one file at a time
  },
  fileFilter: (req, file, cb) => {
    // Initial MIME type check
    const allowedMimeTypes = [
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'application/pdf',
      'text/plain',
      'text/csv',
      'application/json',
    ];

    if (allowedMimeTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      logger.warn('[Upload] File rejected due to invalid MIME type', {
        mimetype: file.mimetype,
        filename: file.originalname,
      });
      cb(
        new Error(
          'Invalid file type. Only images, PDFs, and text files are allowed.'
        )
      );
    }
  },
});

// Secure file upload endpoint
(router as any).post(
  '/file',
  authenticateJWT,
  upload.single('file'),
  validateFileUpload,
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    const uploadId = crypto.randomUUID();

    try {
      if (!req.file) {
        res.status(400).json({
          success: false,
          error: 'No file uploaded',
          code: 'NO_FILE',
        });
        return;
      }

      logger.info('[Upload] File upload initiated', {
        userId,
        uploadId,
        filename: req.file.originalname,
        size: req.file.size,
        mimetype: req.file.mimetype,
      });

      // 1. Validate file magic numbers (more secure than MIME type)
      const fileType = await fileTypeFromBuffer(req.file.buffer);
      if (!fileType || !isAllowedFileType(fileType.mime)) {
        logger.warn('[Upload] File rejected due to invalid file signature', {
          userId,
          uploadId,
          detectedType: fileType?.mime,
          claimedType: req.file.mimetype,
        });
        res.status(400).json({
          success: false,
          error: 'Invalid file type detected',
          code: 'INVALID_FILE_TYPE',
        });
        return;
      }

      // 2. Virus scanning with ClamAV (strict mode enforcement)
      const scanResult = await scanFile(req.file.buffer, req.file.originalname, userId);

      if (!scanResult.scanned && scanResult.strictModeEnforced) {
        // Scanner unavailable and strict mode is enabled
        logger.error('[Upload] Virus scanner unavailable - rejecting upload (strict mode)', {
          userId,
          uploadId,
          error: scanResult.error,
        });
        res.status(503).json({
          success: false,
          error: 'Virus scanning service unavailable. Upload rejected for security.',
          code: 'SCANNER_UNAVAILABLE',
          retryAfter: 60,
        });
        return;
      }

      if (!scanResult.scanned && !STRICT_VIRUS_SCAN) {
        // Scanner unavailable but strict mode is disabled - log and continue
        logger.warn('[Upload] ClamAV unavailable - continuing (STRICT_VIRUS_SCAN=false)', {
          userId,
          uploadId,
        });
      }

      if (scanResult.isInfected) {
        logger.error('[Upload] Malware detected in file', {
          userId,
          uploadId,
          viruses: scanResult.viruses,
          scanDuration: scanResult.scanDuration,
        });
        res.status(400).json({
          success: false,
          error: 'Malware detected in uploaded file',
          code: 'MALWARE_DETECTED',
        });
        return;
      }

      if (scanResult.scanned) {
        logger.debug('[Upload] File passed virus scan', {
          userId,
          uploadId,
          duration: scanResult.scanDuration,
        });
      }

      // 3. Generate secure filename and path
      const fileExtension = path.extname(req.file.originalname).toLowerCase();
      const sanitizedOriginalName = sanitizeInput(req.file.originalname);
      const secureFilename = `${uploadId}_${crypto.randomBytes(8).toString('hex')}${fileExtension}`;
      const s3Key = `uploads/${userId}/${new Date().getFullYear()}/${new Date().getMonth() + 1}/${secureFilename}`;

      // 4. Upload to S3 with security settings
      const uploadParams = {
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: s3Key,
        Body: req.file.buffer,
        ContentType: fileType.mime,
        Metadata: {
          'original-name': sanitizedOriginalName,
          'upload-id': uploadId,
          'user-id': userId || 'anonymous',
          'upload-timestamp': new Date().toISOString(),
        },
        ServerSideEncryption: 'AES256' as const,
        // ACL: 'private',  // ACL is deprecated, use bucket policy instead
        // Add content security headers
        ContentDisposition: 'attachment',
        CacheControl: 'no-cache, no-store, must-revalidate',
      };

      const command = new PutObjectCommand(uploadParams);
      await s3Client.send(command);

      // 5. Log successful upload
      logger.info('[Upload] File uploaded successfully', {
        userId,
        uploadId,
        s3Key,
        size: req.file.size,
        type: fileType.mime,
      });

      // 6. Return success response (don't expose S3 details)
      res.status(201).json({
        success: true,
        data: {
          fileId: uploadId,
          filename: sanitizedOriginalName,
          size: req.file.size,
          type: fileType.mime,
          uploadedAt: new Date().toISOString(),
        },
      });
    } catch (error) {
      logger.error('[Upload] File upload failed', {
        userId,
        uploadId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'File upload failed',
        code: 'UPLOAD_ERROR',
      });
    }
  }
);

// Secure file download endpoint
router.get(
  '/file/:fileId',
  authenticateJWT,
  async (req: AuthenticatedRequest, res: Response) => {
    const userId = req.user?.userId;
    const fileId = sanitizeInput(req.params.fileId);

    try {
      // Validate fileId format
      if (!validateUUID(fileId)) {
        res.status(400).json({
          success: false,
          error: 'Invalid file ID format',
          code: 'INVALID_FILE_ID',
        });
        return;
      }

      // Find the file in S3 by searching for the fileId in the key
      // Files are stored as: uploads/{userId}/{year}/{month}/{fileId}_{randomHex}.{ext}
      const s3Prefix = `uploads/`;

      // First, try to get file metadata to verify ownership
      // We need to find the file by its upload ID prefix
      const listCommand = new ListObjectsV2Command({
        Bucket: process.env.S3_BUCKET_NAME!,
        Prefix: s3Prefix,
        MaxKeys: 1000,
      });

      const listResult = await s3Client.send(listCommand);

      // Find the file that matches the fileId
      const matchingFile = listResult.Contents?.find(obj =>
        obj.Key?.includes(`${fileId}_`)
      );

      if (!matchingFile || !matchingFile.Key) {
        logger.warn('[Upload] File not found for download', {
          userId,
          fileId,
        });
        res.status(404).json({
          success: false,
          error: 'File not found',
          code: 'FILE_NOT_FOUND',
        });
        return;
      }

      // Get object metadata to verify ownership
      const headCommand = new HeadObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: matchingFile.Key,
      });

      const headResult = await s3Client.send(headCommand);
      const fileOwnerId = headResult.Metadata?.['user-id'];

      // Access control: Check if the requesting user is the file owner
      if (fileOwnerId && fileOwnerId !== userId && fileOwnerId !== 'anonymous') {
        logger.warn('[Upload] Access denied - user is not file owner', {
          userId,
          fileId,
          fileOwnerId,
        });
        res.status(403).json({
          success: false,
          error: 'Access denied',
          code: 'ACCESS_DENIED',
        });
        return;
      }

      // Generate presigned URL for secure download (1 hour expiry)
      const getCommand = new GetObjectCommand({
        Bucket: process.env.S3_BUCKET_NAME!,
        Key: matchingFile.Key,
        ResponseContentDisposition: `attachment; filename="${headResult.Metadata?.['original-name'] || 'download'}"`,
      });

      const presignedUrl = await getSignedUrl(s3Client, getCommand, {
        expiresIn: 3600, // 1 hour
      });

      // Log successful download access
      logger.info('[Upload] File download access granted', {
        userId,
        fileId,
        fileKey: matchingFile.Key,
        originalName: headResult.Metadata?.['original-name'],
      });

      res.status(200).json({
        success: true,
        data: {
          downloadUrl: presignedUrl,
          filename: headResult.Metadata?.['original-name'] || 'download',
          contentType: headResult.ContentType,
          size: headResult.ContentLength,
          expiresIn: 3600,
        },
      });
    } catch (error) {
      logger.error('[Upload] File download failed', {
        userId,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'File download failed',
        code: 'DOWNLOAD_ERROR',
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
    'application/pdf',
    'text/plain',
    'text/csv',
    'application/json',
  ];
  return allowedTypes.includes(mimeType);
}

export default router;
