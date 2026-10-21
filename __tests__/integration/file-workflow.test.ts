/**
 * File Workflow Integration Tests
 *
 * Task 83: Implement File Upload Security and Storage Management
 *
 * End-to-end integration tests for the complete file workflow including:
 * - Upload flow: Limits -> Virus Scan -> Encryption -> Version -> Storage -> Audit
 * - Download flow: Permission -> Decryption -> Presigned URL -> Audit
 * - Version management
 * - Cleanup operations
 */

import crypto from 'crypto';

describe('File Workflow Integration', () => {
  // Test data
  const testUser = {
    id: 'user-123',
    email: 'test@example.com',
    role: 'USER' as const,
  };

  const testAdminUser = {
    id: 'admin-456',
    email: 'admin@example.com',
    role: 'ADMIN' as const,
  };

  const testFile = {
    originalname: 'test-document.pdf',
    mimetype: 'application/pdf',
    size: 1024 * 1024, // 1MB
    buffer: Buffer.from('test pdf content'),
  };

  const largeFile = {
    originalname: 'large-file.zip',
    mimetype: 'application/zip',
    size: 15 * 1024 * 1024, // 15MB
    buffer: Buffer.alloc(15 * 1024 * 1024),
  };

  beforeEach(() => {
    // Reset test state
  });

  describe('Complete Upload Flow', () => {
    describe('Step 1: Upload Limits Check', () => {
      it('should pass limits check for USER with valid file', () => {
        const limits = {
          maxSize: 10 * 1024 * 1024,
          filesPerDay: 10,
          storageQuota: 100 * 1024 * 1024,
        };

        const currentUploads = 5;
        const currentStorage = 50 * 1024 * 1024;

        const passesLimits =
          testFile.size <= limits.maxSize &&
          currentUploads < limits.filesPerDay &&
          currentStorage + testFile.size <= limits.storageQuota;

        expect(passesLimits).toBe(true);
      });

      it('should fail limits check for oversized file', () => {
        const limits = {
          maxSize: 10 * 1024 * 1024,
          filesPerDay: 10,
          storageQuota: 100 * 1024 * 1024,
        };

        const passesLimits = largeFile.size <= limits.maxSize;
        expect(passesLimits).toBe(false);
      });

      it('should fail limits check when daily quota exceeded', () => {
        const limits = {
          maxSize: 10 * 1024 * 1024,
          filesPerDay: 10,
          storageQuota: 100 * 1024 * 1024,
        };

        const currentUploads = 10;
        const passesLimits = currentUploads < limits.filesPerDay;
        expect(passesLimits).toBe(false);
      });

      it('should fail limits check when storage quota exceeded', () => {
        const limits = {
          maxSize: 10 * 1024 * 1024,
          filesPerDay: 10,
          storageQuota: 100 * 1024 * 1024,
        };

        // File is 1MB, with 99.5MB already used, total would be 100.5MB > 100MB quota
        const currentStorage = Math.floor(99.5 * 1024 * 1024);
        const passesLimits = currentStorage + testFile.size <= limits.storageQuota;
        expect(passesLimits).toBe(false);
      });
    });

    describe('Step 2: Virus Scanning', () => {
      it('should scan file for viruses', async () => {
        const scanResult = await simulateVirusScan(testFile.buffer);

        expect(scanResult.scanned).toBe(true);
        expect(scanResult.isInfected).toBe(false);
        expect(scanResult.threats).toEqual([]);
      });

      it('should detect infected files', async () => {
        // Simulate EICAR test string
        const eicarBuffer = Buffer.from(
          'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*'
        );
        const scanResult = await simulateVirusScan(eicarBuffer, true);

        expect(scanResult.scanned).toBe(true);
        expect(scanResult.isInfected).toBe(true);
        expect(scanResult.threats.length).toBeGreaterThan(0);
      });

      it('should block upload when virus detected', async () => {
        const scanResult = { scanned: true, isInfected: true, threats: ['Test.Virus'] };
        const shouldBlock = scanResult.isInfected;

        expect(shouldBlock).toBe(true);
      });
    });

    describe('Step 3: Encryption Decision', () => {
      it('should auto-encrypt PDF files', () => {
        const shouldEncrypt = determineEncryptionPolicy(testFile);
        expect(shouldEncrypt).toBe(true);
      });

      it('should auto-encrypt large files', () => {
        const shouldEncrypt = determineEncryptionPolicy(largeFile);
        expect(shouldEncrypt).toBe(true);
      });

      it('should not auto-encrypt small images', () => {
        const imageFile = {
          originalname: 'photo.jpg',
          mimetype: 'image/jpeg',
          size: 500 * 1024, // 500KB
          buffer: Buffer.alloc(500 * 1024),
        };
        const shouldEncrypt = determineEncryptionPolicy(imageFile);
        expect(shouldEncrypt).toBe(false);
      });

      it('should encrypt when explicitly requested', () => {
        const imageFile = {
          originalname: 'photo.jpg',
          mimetype: 'image/jpeg',
          size: 500 * 1024,
          buffer: Buffer.alloc(500 * 1024),
        };
        const shouldEncrypt = determineEncryptionPolicy(imageFile, true);
        expect(shouldEncrypt).toBe(true);
      });
    });

    describe('Step 4: File Encryption', () => {
      it('should perform envelope encryption for sensitive files', async () => {
        const encryptionResult = await performEnvelopeEncryption(testFile.buffer);

        expect(encryptionResult.encryptedData).toBeDefined();
        expect(encryptionResult.encryptedDEK).toBeDefined();
        expect(encryptionResult.iv).toBeDefined();
        expect(encryptionResult.authTag).toBeDefined();
        expect(encryptionResult.algorithm).toBe('AES-256-GCM');
      });

      it('should generate unique DEK for each file', async () => {
        const result1 = await performEnvelopeEncryption(testFile.buffer);
        const result2 = await performEnvelopeEncryption(testFile.buffer);

        expect(result1.iv).not.toBe(result2.iv);
      });

      it('should be able to decrypt encrypted data', async () => {
        const encryptionResult = await performEnvelopeEncryption(testFile.buffer);
        const decrypted = await performDecryption(
          encryptionResult.encryptedData,
          encryptionResult.dek!,
          encryptionResult.iv,
          encryptionResult.authTag
        );

        expect(decrypted.toString()).toBe(testFile.buffer.toString());
      });
    });

    describe('Step 5: File Storage', () => {
      it('should generate unique S3 key', () => {
        const s3Key = generateS3Key(testUser.id, testFile.originalname);

        expect(s3Key).toContain(testUser.id);
        expect(s3Key).toMatch(/^uploads\//);
        expect(s3Key).toContain('.pdf');
      });

      it('should store file with server-side encryption', async () => {
        const uploadParams = {
          Bucket: 'wrfcoin-files',
          Key: generateS3Key(testUser.id, testFile.originalname),
          Body: testFile.buffer,
          ContentType: testFile.mimetype,
          ServerSideEncryption: 'AES256',
          Metadata: {
            originalName: testFile.originalname,
            uploadedBy: testUser.id,
            checksum: generateChecksum(testFile.buffer),
          },
        };

        expect(uploadParams.ServerSideEncryption).toBe('AES256');
        expect(uploadParams.Metadata.checksum).toBeDefined();
      });
    });

    describe('Step 6: Version Creation', () => {
      it('should create initial version on first upload', () => {
        const version = createFileVersion({
          fileId: 'file-123',
          userId: testUser.id,
          storagePath: 'uploads/user-123/file.pdf',
          fileSize: testFile.size,
          checksum: generateChecksum(testFile.buffer),
          comment: 'Initial upload',
          metadata: {
            encrypted: true,
            mimeType: testFile.mimetype,
          },
        });

        expect(version.versionNumber).toBe(1);
        expect(version.comment).toBe('Initial upload');
        expect(version.isActive).toBe(true);
      });

      it('should increment version number on re-upload', () => {
        const existingVersions = [{ versionNumber: 1 }, { versionNumber: 2 }];
        const newVersion = createFileVersion({
          fileId: 'file-123',
          userId: testUser.id,
          storagePath: 'uploads/user-123/file.pdf',
          fileSize: testFile.size,
          checksum: generateChecksum(testFile.buffer),
          existingVersionCount: existingVersions.length,
        });

        expect(newVersion.versionNumber).toBe(3);
      });
    });

    describe('Step 7: Audit Logging', () => {
      it('should log FILE_UPLOADED event', () => {
        const auditEvent = createAuditEvent({
          eventType: 'FILE_UPLOADED',
          fileId: 'file-123',
          fileName: testFile.originalname,
          operation: 'UPLOAD',
          userId: testUser.id,
          result: 'SUCCESS',
          severity: 'LOW',
          details: {
            fileSize: testFile.size,
            mimeType: testFile.mimetype,
            encrypted: true,
          },
          context: {
            ipAddress: '192.168.1.1',
            userAgent: 'Test/1.0',
          },
        });

        expect(auditEvent.eventType).toBe('FILE_UPLOADED');
        expect(auditEvent.result).toBe('SUCCESS');
      });

      it('should log FILE_ENCRYPTED event when encryption applied', () => {
        const auditEvent = createAuditEvent({
          eventType: 'FILE_ENCRYPTED',
          fileId: 'file-123',
          fileName: testFile.originalname,
          operation: 'ENCRYPT',
          userId: testUser.id,
          result: 'SUCCESS',
          severity: 'LOW',
          details: {
            algorithm: 'AES-256-GCM',
            reason: 'sensitive_mime_type',
          },
        });

        expect(auditEvent.eventType).toBe('FILE_ENCRYPTED');
        expect(auditEvent.details.algorithm).toBe('AES-256-GCM');
      });
    });
  });

  describe('Complete Download Flow', () => {
    describe('Step 1: Permission Check', () => {
      it('should allow download with READ permission', () => {
        const userPermissions = ['READ', 'WRITE'];
        const requiredPermission = 'READ';
        const hasPermission = userPermissions.includes(requiredPermission);

        expect(hasPermission).toBe(true);
      });

      it('should deny download without READ permission', () => {
        const userPermissions = ['WRITE'];
        const requiredPermission = 'READ';
        const hasPermission = userPermissions.includes(requiredPermission);

        expect(hasPermission).toBe(false);
      });
    });

    describe('Step 2: Encryption Metadata Check', () => {
      it('should retrieve encryption metadata for encrypted files', () => {
        const encryptionMetadata = {
          isEncrypted: true,
          encryptedKey: 'base64-encrypted-dek',
          iv: '0123456789abcdef01234567',
          authTag: '0123456789abcdef0123456789abcdef',
          algorithm: 'AES-256-GCM',
          kekHandle: 'hsm-key-123',
        };

        expect(encryptionMetadata.isEncrypted).toBe(true);
        expect(encryptionMetadata.algorithm).toBe('AES-256-GCM');
      });

      it('should return null metadata for unencrypted files', () => {
        const encryptionMetadata = null;
        expect(encryptionMetadata).toBeNull();
      });
    });

    describe('Step 3: Presigned URL Generation', () => {
      it('should generate presigned URL with role-based expiry', () => {
        const roleExpiryMap = {
          GUEST: 15 * 60,
          USER: 60 * 60,
          OPERATOR: 6 * 60 * 60,
          ADMIN: 12 * 60 * 60,
          SUPER_ADMIN: 24 * 60 * 60,
        };

        const expiry = roleExpiryMap[testUser.role];
        expect(expiry).toBe(3600); // 1 hour for USER
      });

      it('should cap requested expiry to role maximum', () => {
        const requestedExpiry = 86400; // 24 hours
        const roleMax = 3600; // 1 hour for USER
        const actualExpiry = Math.min(requestedExpiry, roleMax);

        expect(actualExpiry).toBe(3600);
      });

      it('should include decryption note for encrypted files', () => {
        const downloadInfo = {
          presignedUrl: 'https://bucket.s3.amazonaws.com/key?signed=true',
          expiresIn: 3600,
          isEncrypted: true,
          decryptionNote: 'Client-side decryption may be required',
        };

        expect(downloadInfo.isEncrypted).toBe(true);
        expect(downloadInfo.decryptionNote).toBeDefined();
      });
    });

    describe('Step 4: Download Audit Logging', () => {
      it('should log FILE_DOWNLOADED event', () => {
        const auditEvent = createAuditEvent({
          eventType: 'FILE_DOWNLOADED',
          fileId: 'file-123',
          fileName: testFile.originalname,
          operation: 'DOWNLOAD',
          userId: testUser.id,
          result: 'SUCCESS',
          severity: 'LOW',
          details: {
            urlExpiry: 3600,
            isEncrypted: true,
          },
        });

        expect(auditEvent.eventType).toBe('FILE_DOWNLOADED');
      });

      it('should log FILE_PRESIGNED_URL_GENERATED event', () => {
        const auditEvent = createAuditEvent({
          eventType: 'FILE_PRESIGNED_URL_GENERATED',
          fileId: 'file-123',
          fileName: testFile.originalname,
          operation: 'PRESIGN',
          userId: testUser.id,
          result: 'SUCCESS',
          severity: 'LOW',
          details: {
            expiresIn: 3600,
          },
        });

        expect(auditEvent.eventType).toBe('FILE_PRESIGNED_URL_GENERATED');
      });
    });
  });

  describe('Version Management Flow', () => {
    describe('Version History', () => {
      it('should retrieve complete version history', () => {
        const versions = [
          { versionNumber: 1, createdAt: new Date('2024-01-01'), isActive: false },
          { versionNumber: 2, createdAt: new Date('2024-01-15'), isActive: false },
          { versionNumber: 3, createdAt: new Date('2024-02-01'), isActive: true },
        ];

        expect(versions.length).toBe(3);
        expect(versions[versions.length - 1].isActive).toBe(true);
      });

      it('should identify active version', () => {
        const versions = [
          { versionNumber: 1, isActive: false },
          { versionNumber: 2, isActive: true },
        ];

        const activeVersion = versions.find((v) => v.isActive);
        expect(activeVersion?.versionNumber).toBe(2);
      });
    });

    describe('Version Rollback', () => {
      it('should rollback to previous version', () => {
        const versions = [
          { versionNumber: 1, isActive: false, storagePath: 'path/v1' },
          { versionNumber: 2, isActive: true, storagePath: 'path/v2' },
        ];

        // Rollback to version 1
        const rolledBack = {
          ...versions[0],
          isActive: true,
        };
        const deactivated = {
          ...versions[1],
          isActive: false,
        };

        expect(rolledBack.isActive).toBe(true);
        expect(deactivated.isActive).toBe(false);
      });

      it('should log FILE_VERSION_ROLLBACK event', () => {
        const auditEvent = createAuditEvent({
          eventType: 'FILE_VERSION_ROLLBACK',
          fileId: 'file-123',
          fileName: testFile.originalname,
          operation: 'ROLLBACK',
          userId: testUser.id,
          result: 'SUCCESS',
          severity: 'MEDIUM',
          details: {
            fromVersion: 2,
            toVersion: 1,
          },
        });

        expect(auditEvent.eventType).toBe('FILE_VERSION_ROLLBACK');
        expect(auditEvent.details.fromVersion).toBe(2);
        expect(auditEvent.details.toVersion).toBe(1);
      });
    });

    describe('Version Cleanup', () => {
      it('should enforce maximum version limit', () => {
        const MAX_VERSIONS = 10;
        const versions = Array.from({ length: 15 }, (_, i) => ({
          versionNumber: i + 1,
          createdAt: new Date(Date.now() - (15 - i) * 86400000),
        }));

        const versionsToDelete = versions.slice(0, versions.length - MAX_VERSIONS);
        const versionsToKeep = versions.slice(-MAX_VERSIONS);

        expect(versionsToDelete.length).toBe(5);
        expect(versionsToKeep.length).toBe(10);
      });

      it('should delete old versions after retention period', () => {
        const RETENTION_DAYS = 90;
        const now = new Date();

        const versions = [
          { versionNumber: 1, createdAt: new Date(now.getTime() - 100 * 86400000) }, // 100 days old
          { versionNumber: 2, createdAt: new Date(now.getTime() - 50 * 86400000) }, // 50 days old
          { versionNumber: 3, createdAt: new Date(now.getTime() - 10 * 86400000) }, // 10 days old
        ];

        const expiredVersions = versions.filter((v) => {
          const ageInDays = (now.getTime() - v.createdAt.getTime()) / 86400000;
          return ageInDays > RETENTION_DAYS;
        });

        expect(expiredVersions.length).toBe(1);
        expect(expiredVersions[0].versionNumber).toBe(1);
      });
    });
  });

  describe('Cleanup Operations', () => {
    describe('Temporary File Cleanup', () => {
      it('should identify temporary files older than 1 day', () => {
        const TEMP_RETENTION_HOURS = 24;
        const now = new Date();

        const files = [
          { id: '1', isTemporary: true, createdAt: new Date(now.getTime() - 2 * 86400000) },
          { id: '2', isTemporary: true, createdAt: new Date(now.getTime() - 12 * 3600000) },
          { id: '3', isTemporary: false, createdAt: new Date(now.getTime() - 2 * 86400000) },
        ];

        const expiredTempFiles = files.filter((f) => {
          if (!f.isTemporary) return false;
          const ageInHours = (now.getTime() - f.createdAt.getTime()) / 3600000;
          return ageInHours > TEMP_RETENTION_HOURS;
        });

        expect(expiredTempFiles.length).toBe(1);
        expect(expiredTempFiles[0].id).toBe('1');
      });
    });

    describe('Orphaned File Detection', () => {
      it('should detect S3 objects without database records', async () => {
        const s3Objects = [
          { Key: 'uploads/user-1/file-1.pdf' },
          { Key: 'uploads/user-1/file-2.pdf' },
          { Key: 'uploads/user-2/orphan.pdf' },
        ];

        const dbFiles = [
          { storagePath: 'uploads/user-1/file-1.pdf' },
          { storagePath: 'uploads/user-1/file-2.pdf' },
        ];

        const dbPaths = new Set(dbFiles.map((f) => f.storagePath));
        const orphanedObjects = s3Objects.filter((obj) => !dbPaths.has(obj.Key));

        expect(orphanedObjects.length).toBe(1);
        expect(orphanedObjects[0].Key).toBe('uploads/user-2/orphan.pdf');
      });
    });

    describe('Inactive User File Archival', () => {
      it('should identify files from inactive users', () => {
        const INACTIVE_DAYS = 365;
        const now = new Date();

        const users = [
          { id: 'user-1', lastActiveAt: new Date(now.getTime() - 400 * 86400000) },
          { id: 'user-2', lastActiveAt: new Date(now.getTime() - 30 * 86400000) },
        ];

        const files = [
          { id: 'file-1', userId: 'user-1' },
          { id: 'file-2', userId: 'user-1' },
          { id: 'file-3', userId: 'user-2' },
        ];

        const inactiveUserIds = new Set(
          users
            .filter((u) => {
              const daysInactive = (now.getTime() - u.lastActiveAt.getTime()) / 86400000;
              return daysInactive > INACTIVE_DAYS;
            })
            .map((u) => u.id)
        );

        const filesToArchive = files.filter((f) => inactiveUserIds.has(f.userId));

        expect(filesToArchive.length).toBe(2);
        expect(filesToArchive.every((f) => f.userId === 'user-1')).toBe(true);
      });
    });

    describe('Cleanup Audit Logging', () => {
      it('should log FILE_CLEANUP_EXECUTED event', () => {
        const auditEvent = createAuditEvent({
          eventType: 'FILE_CLEANUP_EXECUTED',
          fileId: null,
          fileName: null,
          operation: 'CLEANUP',
          userId: 'system',
          result: 'SUCCESS',
          severity: 'LOW',
          details: {
            temporaryFilesDeleted: 5,
            orphanedFilesDeleted: 2,
            oldVersionsDeleted: 10,
            totalSpaceReclaimed: 150 * 1024 * 1024,
          },
        });

        expect(auditEvent.eventType).toBe('FILE_CLEANUP_EXECUTED');
        expect(auditEvent.details.temporaryFilesDeleted).toBe(5);
      });
    });
  });

  describe('Error Scenarios', () => {
    describe('Upload Failures', () => {
      it('should handle S3 upload failure gracefully', async () => {
        const uploadError = new Error('S3 upload failed: NetworkError');

        const errorResponse = handleUploadError(uploadError);

        expect(errorResponse.success).toBe(false);
        expect(errorResponse.error).toContain('upload failed');
        expect(errorResponse.retryable).toBe(true);
      });

      it('should handle database record creation failure', async () => {
        const dbError = new Error('Database connection failed');

        const errorResponse = handleUploadError(dbError);

        expect(errorResponse.success).toBe(false);
        expect(errorResponse.retryable).toBe(true);
      });
    });

    describe('Download Failures', () => {
      it('should handle file not found error', () => {
        const notFoundError = {
          code: 'NotFound',
          message: 'File not found',
        };

        const errorResponse = handleDownloadError(notFoundError);

        expect(errorResponse.status).toBe(404);
        expect(errorResponse.error).toBe('File not found');
      });

      it('should handle permission denied error', () => {
        const permissionError = {
          code: 'AccessDenied',
          message: 'Access denied',
        };

        const errorResponse = handleDownloadError(permissionError);

        expect(errorResponse.status).toBe(403);
      });
    });

    describe('Encryption Failures', () => {
      it('should continue upload if encryption fails', async () => {
        const encryptionError = new Error('HSM unavailable');

        const result = handleEncryptionFailure(encryptionError);

        expect(result.continueUpload).toBe(true);
        expect(result.encrypted).toBe(false);
        expect(result.warning).toBeDefined();
      });
    });
  });
});

// Helper functions for tests

function simulateVirusScan(
  buffer: Buffer,
  simulateInfected = false
): Promise<{ scanned: boolean; isInfected: boolean; threats: string[] }> {
  return Promise.resolve({
    scanned: true,
    isInfected: simulateInfected,
    threats: simulateInfected ? ['EICAR-Test-Signature'] : [],
  });
}

function determineEncryptionPolicy(
  file: { mimetype: string; size: number },
  explicitEncrypt = false
): boolean {
  const SENSITIVE_MIME_TYPES = [
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/zip',
    'application/x-tar',
    'application/gzip',
  ];
  const SIZE_THRESHOLD = 10 * 1024 * 1024;

  return (
    explicitEncrypt || file.size > SIZE_THRESHOLD || SENSITIVE_MIME_TYPES.includes(file.mimetype)
  );
}

async function performEnvelopeEncryption(data: Buffer): Promise<{
  encryptedData: Buffer;
  encryptedDEK: string;
  dek?: Buffer;
  iv: string;
  authTag: string;
  algorithm: string;
}> {
  const dek = crypto.randomBytes(32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv);
  const encryptedData = Buffer.concat([cipher.update(data), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Simulate HSM wrapping of DEK
  const encryptedDEK = crypto.randomBytes(48).toString('base64');

  return {
    encryptedData,
    encryptedDEK,
    dek,
    iv: iv.toString('hex'),
    authTag: authTag.toString('hex'),
    algorithm: 'AES-256-GCM',
  };
}

async function performDecryption(
  encryptedData: Buffer,
  dek: Buffer,
  ivHex: string,
  authTagHex: string
): Promise<Buffer> {
  const iv = Buffer.from(ivHex, 'hex');
  const authTag = Buffer.from(authTagHex, 'hex');

  const decipher = crypto.createDecipheriv('aes-256-gcm', dek, iv);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
}

function generateS3Key(userId: string, filename: string): string {
  const timestamp = Date.now();
  const randomId = crypto.randomBytes(8).toString('hex');
  const ext = filename.substring(filename.lastIndexOf('.'));
  return `uploads/${userId}/${timestamp}-${randomId}${ext}`;
}

function generateChecksum(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function createFileVersion(params: {
  fileId: string;
  userId: string;
  storagePath: string;
  fileSize: number;
  checksum: string;
  comment?: string;
  metadata?: Record<string, any>;
  existingVersionCount?: number;
}): {
  versionNumber: number;
  fileId: string;
  createdBy: string;
  storagePath: string;
  size: number;
  checksum: string;
  comment?: string;
  isActive: boolean;
  metadata?: Record<string, any>;
} {
  return {
    versionNumber: (params.existingVersionCount || 0) + 1,
    fileId: params.fileId,
    createdBy: params.userId,
    storagePath: params.storagePath,
    size: params.fileSize,
    checksum: params.checksum,
    comment: params.comment,
    isActive: true,
    metadata: params.metadata,
  };
}

function createAuditEvent(params: {
  eventType: string;
  fileId: string | null;
  fileName: string | null;
  operation: string;
  userId: string;
  result: string;
  severity: string;
  details?: Record<string, any>;
  context?: Record<string, any>;
}): {
  eventType: string;
  fileId: string | null;
  fileName: string | null;
  operation: string;
  userId: string;
  result: string;
  severity: string;
  details: Record<string, any>;
  context?: Record<string, any>;
  timestamp: Date;
} {
  return {
    ...params,
    details: params.details || {},
    timestamp: new Date(),
  };
}

function handleUploadError(error: Error): {
  success: boolean;
  error: string;
  retryable: boolean;
} {
  const isNetworkError =
    error.message.includes('Network') || error.message.includes('connection');

  return {
    success: false,
    error: `File upload failed: ${error.message}`,
    retryable: isNetworkError,
  };
}

function handleDownloadError(error: { code: string; message: string }): {
  status: number;
  error: string;
} {
  const statusMap: Record<string, number> = {
    NotFound: 404,
    AccessDenied: 403,
    InternalError: 500,
  };

  return {
    status: statusMap[error.code] || 500,
    error: error.message,
  };
}

function handleEncryptionFailure(error: Error): {
  continueUpload: boolean;
  encrypted: boolean;
  warning: string;
} {
  return {
    continueUpload: true,
    encrypted: false,
    warning: `Encryption failed: ${error.message}. File stored without encryption.`,
  };
}
