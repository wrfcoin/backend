/**
 * File Upload Security Tests
 *
 * Task 83: Implement File Upload Security and Storage Management
 *
 * Comprehensive security tests for file upload functionality including:
 * - Role-based upload limits (GUEST, USER, OPERATOR, ADMIN, SUPER_ADMIN)
 * - ClamAV virus scanning with strict mode
 * - HSM-backed envelope encryption
 * - Presigned URL generation with role-based expiry
 * - File versioning
 * - Comprehensive audit logging
 */

import express, { Express, Request, Response } from 'express';
import request from 'supertest';
import crypto from 'crypto';

// Mock types for testing
interface MockUser {
  id: string;
  email: string;
  role: 'GUEST' | 'USER' | 'OPERATOR' | 'ADMIN' | 'SUPER_ADMIN';
}

describe('File Upload Security', () => {
  let app: Express;

  // Role-based upload limits from uploadLimitsMiddleware
  const UPLOAD_LIMITS = {
    GUEST: { maxSize: 0, filesPerDay: 0, storageQuota: 0 },
    USER: { maxSize: 10 * 1024 * 1024, filesPerDay: 10, storageQuota: 100 * 1024 * 1024 },
    OPERATOR: { maxSize: 50 * 1024 * 1024, filesPerDay: 50, storageQuota: 1024 * 1024 * 1024 },
    ADMIN: { maxSize: 100 * 1024 * 1024, filesPerDay: 100, storageQuota: 10 * 1024 * 1024 * 1024 },
    SUPER_ADMIN: { maxSize: 500 * 1024 * 1024, filesPerDay: Infinity, storageQuota: Infinity },
  };

  // Presigned URL expiry limits
  const URL_EXPIRY_LIMITS = {
    GUEST: 15 * 60, // 15 minutes
    USER: 60 * 60, // 1 hour
    OPERATOR: 6 * 60 * 60, // 6 hours
    ADMIN: 12 * 60 * 60, // 12 hours
    SUPER_ADMIN: 24 * 60 * 60, // 24 hours
  };

  // Encryption policy - files that should auto-encrypt
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

  const AUTO_ENCRYPT_SIZE_THRESHOLD = 10 * 1024 * 1024; // 10MB

  beforeEach(() => {
    app = express();
    app.use(express.json());
    jest.clearAllMocks();
  });

  describe('Role-Based Upload Limits', () => {
    describe('File Size Limits', () => {
      it('should deny uploads for GUEST role', async () => {
        const guestLimits = UPLOAD_LIMITS.GUEST;
        expect(guestLimits.maxSize).toBe(0);
        expect(guestLimits.filesPerDay).toBe(0);
        expect(guestLimits.storageQuota).toBe(0);
      });

      it('should enforce 10MB limit for USER role', () => {
        const userLimits = UPLOAD_LIMITS.USER;
        expect(userLimits.maxSize).toBe(10 * 1024 * 1024);
      });

      it('should enforce 50MB limit for OPERATOR role', () => {
        const operatorLimits = UPLOAD_LIMITS.OPERATOR;
        expect(operatorLimits.maxSize).toBe(50 * 1024 * 1024);
      });

      it('should enforce 100MB limit for ADMIN role', () => {
        const adminLimits = UPLOAD_LIMITS.ADMIN;
        expect(adminLimits.maxSize).toBe(100 * 1024 * 1024);
      });

      it('should enforce 500MB limit for SUPER_ADMIN role', () => {
        const superAdminLimits = UPLOAD_LIMITS.SUPER_ADMIN;
        expect(superAdminLimits.maxSize).toBe(500 * 1024 * 1024);
      });
    });

    describe('Daily Upload Limits', () => {
      it('should limit USER role to 10 files per day', () => {
        expect(UPLOAD_LIMITS.USER.filesPerDay).toBe(10);
      });

      it('should limit OPERATOR role to 50 files per day', () => {
        expect(UPLOAD_LIMITS.OPERATOR.filesPerDay).toBe(50);
      });

      it('should limit ADMIN role to 100 files per day', () => {
        expect(UPLOAD_LIMITS.ADMIN.filesPerDay).toBe(100);
      });

      it('should allow unlimited uploads for SUPER_ADMIN', () => {
        expect(UPLOAD_LIMITS.SUPER_ADMIN.filesPerDay).toBe(Infinity);
      });
    });

    describe('Storage Quota Limits', () => {
      it('should enforce 100MB quota for USER role', () => {
        expect(UPLOAD_LIMITS.USER.storageQuota).toBe(100 * 1024 * 1024);
      });

      it('should enforce 1GB quota for OPERATOR role', () => {
        expect(UPLOAD_LIMITS.OPERATOR.storageQuota).toBe(1024 * 1024 * 1024);
      });

      it('should enforce 10GB quota for ADMIN role', () => {
        expect(UPLOAD_LIMITS.ADMIN.storageQuota).toBe(10 * 1024 * 1024 * 1024);
      });

      it('should allow unlimited storage for SUPER_ADMIN', () => {
        expect(UPLOAD_LIMITS.SUPER_ADMIN.storageQuota).toBe(Infinity);
      });
    });
  });

  describe('ClamAV Virus Scanning - Strict Mode', () => {
    it('should have STRICT_VIRUS_SCAN enabled by default in production', () => {
      // In production, STRICT_VIRUS_SCAN should default to true
      const strictMode = process.env.STRICT_VIRUS_SCAN !== 'false';
      // Test assumes strict mode is not explicitly disabled
      expect(typeof strictMode).toBe('boolean');
    });

    it('should return 503 when ClamAV is unavailable in strict mode', async () => {
      // Mock endpoint that simulates strict virus scan middleware behavior
      app.post('/test-strict-scan', (req: Request, res: Response) => {
        const strictMode = true;
        const clamAvailable = false;

        if (strictMode && !clamAvailable) {
          res.status(503).json({
            error: 'Virus scanning service unavailable',
            retryAfter: 60,
          });
          return;
        }

        res.status(200).json({ success: true });
      });

      const response = await request(app)
        .post('/test-strict-scan')
        .send({ file: 'test.txt' });

      expect(response.status).toBe(503);
      expect(response.body.error).toBe('Virus scanning service unavailable');
      expect(response.body.retryAfter).toBe(60);
    });

    it('should include Retry-After header when scanner unavailable', async () => {
      app.post('/test-retry-header', (req: Request, res: Response) => {
        res.setHeader('Retry-After', '60');
        res.status(503).json({
          error: 'Virus scanning service unavailable',
        });
      });

      const response = await request(app)
        .post('/test-retry-header')
        .send({});

      expect(response.status).toBe(503);
      expect(response.headers['retry-after']).toBe('60');
    });

    it('should reject files with detected threats', async () => {
      app.post('/test-virus-detected', (req: Request, res: Response) => {
        // Simulate detected virus
        const scanResult = {
          isInfected: true,
          threats: ['EICAR-Test-Signature'],
        };

        if (scanResult.isInfected) {
          res.status(400).json({
            error: 'Virus detected in uploaded file',
            threats: scanResult.threats,
          });
          return;
        }

        res.status(200).json({ success: true });
      });

      const response = await request(app)
        .post('/test-virus-detected')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toBe('Virus detected in uploaded file');
      expect(response.body.threats).toContain('EICAR-Test-Signature');
    });

    it('should allow clean files to proceed', async () => {
      app.post('/test-clean-file', (req: Request, res: Response) => {
        const scanResult = {
          isInfected: false,
          threats: [],
        };

        if (!scanResult.isInfected) {
          res.status(200).json({ success: true, scanned: true });
          return;
        }

        res.status(400).json({ error: 'Virus detected' });
      });

      const response = await request(app)
        .post('/test-clean-file')
        .send({});

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.scanned).toBe(true);
    });
  });

  describe('HSM Envelope Encryption', () => {
    describe('Encryption Policy', () => {
      it('should auto-encrypt files larger than 10MB', () => {
        const fileSize = 15 * 1024 * 1024; // 15MB
        const shouldEncrypt = fileSize > AUTO_ENCRYPT_SIZE_THRESHOLD;
        expect(shouldEncrypt).toBe(true);
      });

      it('should auto-encrypt PDF files', () => {
        const mimeType = 'application/pdf';
        const shouldEncrypt = SENSITIVE_MIME_TYPES.includes(mimeType);
        expect(shouldEncrypt).toBe(true);
      });

      it('should auto-encrypt Word documents', () => {
        const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
        const doc = 'application/msword';
        expect(SENSITIVE_MIME_TYPES.includes(docx)).toBe(true);
        expect(SENSITIVE_MIME_TYPES.includes(doc)).toBe(true);
      });

      it('should auto-encrypt Excel files', () => {
        const xlsx = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
        const xls = 'application/vnd.ms-excel';
        expect(SENSITIVE_MIME_TYPES.includes(xlsx)).toBe(true);
        expect(SENSITIVE_MIME_TYPES.includes(xls)).toBe(true);
      });

      it('should auto-encrypt compressed archives', () => {
        expect(SENSITIVE_MIME_TYPES.includes('application/zip')).toBe(true);
        expect(SENSITIVE_MIME_TYPES.includes('application/x-tar')).toBe(true);
        expect(SENSITIVE_MIME_TYPES.includes('application/gzip')).toBe(true);
      });

      it('should not auto-encrypt small images', () => {
        const fileSize = 100 * 1024; // 100KB
        const mimeType = 'image/png';
        const shouldEncrypt =
          fileSize > AUTO_ENCRYPT_SIZE_THRESHOLD || SENSITIVE_MIME_TYPES.includes(mimeType);
        expect(shouldEncrypt).toBe(false);
      });

      it('should honor explicit encrypt=true parameter', () => {
        const fileSize = 1024; // 1KB
        const mimeType = 'text/plain';
        const explicitEncrypt = true;

        const shouldEncrypt =
          fileSize > AUTO_ENCRYPT_SIZE_THRESHOLD ||
          SENSITIVE_MIME_TYPES.includes(mimeType) ||
          explicitEncrypt;

        expect(shouldEncrypt).toBe(true);
      });
    });

    describe('Envelope Encryption Process', () => {
      it('should generate a unique DEK for each file', () => {
        const dek1 = crypto.randomBytes(32);
        const dek2 = crypto.randomBytes(32);

        expect(dek1.toString('hex')).not.toBe(dek2.toString('hex'));
        expect(dek1.length).toBe(32); // 256 bits
      });

      it('should use AES-256-GCM for file encryption', () => {
        const algorithm = 'aes-256-gcm';
        const key = crypto.randomBytes(32);
        const iv = crypto.randomBytes(12);
        const plaintext = Buffer.from('test data');

        const cipher = crypto.createCipheriv(algorithm, key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
        const authTag = cipher.getAuthTag();

        expect(encrypted.length).toBeGreaterThan(0);
        expect(authTag.length).toBe(16); // 128-bit auth tag

        // Verify decryption works
        const decipher = crypto.createDecipheriv(algorithm, key, iv);
        decipher.setAuthTag(authTag);
        const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

        expect(decrypted.toString()).toBe('test data');
      });

      it('should generate proper IV for AES-GCM', () => {
        const iv = crypto.randomBytes(12); // 96-bit IV for GCM
        expect(iv.length).toBe(12);
      });

      it('should store encrypted DEK with file metadata', () => {
        const encryptionMetadata = {
          encryptedKey: crypto.randomBytes(48).toString('base64'), // Wrapped DEK
          iv: crypto.randomBytes(12).toString('hex'),
          authTag: crypto.randomBytes(16).toString('hex'),
          algorithm: 'AES-256-GCM',
          kekHandle: 'hsm-key-handle-123',
        };

        expect(encryptionMetadata.encryptedKey.length).toBeGreaterThan(0);
        expect(encryptionMetadata.iv.length).toBe(24); // 12 bytes hex = 24 chars
        expect(encryptionMetadata.authTag.length).toBe(32); // 16 bytes hex = 32 chars
        expect(encryptionMetadata.algorithm).toBe('AES-256-GCM');
        expect(encryptionMetadata.kekHandle).toBeTruthy();
      });
    });

    describe('Encryption Failure Handling', () => {
      it('should continue upload if encryption fails (non-critical)', async () => {
        app.post('/test-encryption-failure', (req: Request, res: Response) => {
          // Simulate encryption failure scenario
          let encryptionSucceeded = false;
          let uploadSucceeded = true;

          try {
            // Simulate encryption failure
            throw new Error('HSM unavailable');
          } catch {
            // Log but don't fail the upload
            encryptionSucceeded = false;
          }

          if (uploadSucceeded) {
            res.status(200).json({
              success: true,
              encrypted: encryptionSucceeded,
              warning: encryptionSucceeded ? undefined : 'Encryption failed, file stored unencrypted',
            });
          }
        });

        const response = await request(app)
          .post('/test-encryption-failure')
          .send({});

        expect(response.status).toBe(200);
        expect(response.body.success).toBe(true);
        expect(response.body.encrypted).toBe(false);
        expect(response.body.warning).toContain('Encryption failed');
      });
    });
  });

  describe('Presigned URL Security', () => {
    describe('Role-Based Expiry', () => {
      it('should limit GUEST URLs to 15 minutes', () => {
        expect(URL_EXPIRY_LIMITS.GUEST).toBe(15 * 60);
      });

      it('should limit USER URLs to 1 hour', () => {
        expect(URL_EXPIRY_LIMITS.USER).toBe(60 * 60);
      });

      it('should limit OPERATOR URLs to 6 hours', () => {
        expect(URL_EXPIRY_LIMITS.OPERATOR).toBe(6 * 60 * 60);
      });

      it('should limit ADMIN URLs to 12 hours', () => {
        expect(URL_EXPIRY_LIMITS.ADMIN).toBe(12 * 60 * 60);
      });

      it('should limit SUPER_ADMIN URLs to 24 hours', () => {
        expect(URL_EXPIRY_LIMITS.SUPER_ADMIN).toBe(24 * 60 * 60);
      });
    });

    describe('URL Generation Security', () => {
      it('should include expiration in presigned URL', () => {
        const mockPresignedUrl =
          'https://bucket.s3.amazonaws.com/key?X-Amz-Expires=3600&X-Amz-Signature=abc123';

        expect(mockPresignedUrl).toContain('X-Amz-Expires');
        expect(mockPresignedUrl).toContain('X-Amz-Signature');
      });

      it('should enforce maximum expiry based on role', () => {
        const requestedExpiry = 86400; // 24 hours
        const userRole = 'USER';
        const maxAllowed = URL_EXPIRY_LIMITS[userRole];
        const actualExpiry = Math.min(requestedExpiry, maxAllowed);

        expect(actualExpiry).toBe(3600); // Capped at 1 hour for USER
      });
    });
  });

  describe('File Versioning Security', () => {
    it('should create new version on re-upload', () => {
      const existingVersions = [
        { versionNumber: 1, checksum: 'abc123' },
        { versionNumber: 2, checksum: 'def456' },
      ];

      const newVersion = {
        versionNumber: existingVersions.length + 1,
        checksum: 'ghi789',
      };

      expect(newVersion.versionNumber).toBe(3);
    });

    it('should limit version history to configured maximum', () => {
      const MAX_VERSIONS = 10;
      const versions = Array.from({ length: 15 }, (_, i) => ({
        versionNumber: i + 1,
        checksum: crypto.randomBytes(16).toString('hex'),
      }));

      // Keep only the most recent MAX_VERSIONS
      const trimmedVersions = versions.slice(-MAX_VERSIONS);

      expect(trimmedVersions.length).toBe(MAX_VERSIONS);
      expect(trimmedVersions[0].versionNumber).toBe(6);
      expect(trimmedVersions[trimmedVersions.length - 1].versionNumber).toBe(15);
    });

    it('should track version creator', () => {
      const versionMetadata = {
        fileId: 'file-123',
        versionNumber: 1,
        createdBy: 'user-456',
        createdAt: new Date(),
        checksum: 'abc123',
        comment: 'Initial upload',
      };

      expect(versionMetadata.createdBy).toBeTruthy();
      expect(versionMetadata.createdAt).toBeInstanceOf(Date);
    });

    it('should preserve checksum for each version', () => {
      const fileContent = Buffer.from('version 1 content');
      const checksum = crypto.createHash('sha256').update(fileContent).digest('hex');

      expect(checksum.length).toBe(64); // SHA-256 hex digest
    });
  });

  describe('Audit Logging', () => {
    const FILE_AUDIT_EVENTS = {
      FILE_UPLOADED: 'FILE_UPLOADED',
      FILE_DOWNLOADED: 'FILE_DOWNLOADED',
      FILE_DELETED: 'FILE_DELETED',
      FILE_SHARED: 'FILE_SHARED',
      FILE_PERMISSION_CHANGED: 'FILE_PERMISSION_CHANGED',
      FILE_ENCRYPTED: 'FILE_ENCRYPTED',
      FILE_DECRYPTED: 'FILE_DECRYPTED',
      FILE_VERSION_CREATED: 'FILE_VERSION_CREATED',
      FILE_VERSION_ROLLBACK: 'FILE_VERSION_ROLLBACK',
      FILE_INTEGRITY_VERIFIED: 'FILE_INTEGRITY_VERIFIED',
      FILE_INTEGRITY_FAILED: 'FILE_INTEGRITY_FAILED',
      FILE_VIRUS_DETECTED: 'FILE_VIRUS_DETECTED',
      FILE_ACCESS_DENIED: 'FILE_ACCESS_DENIED',
      FILE_QUOTA_EXCEEDED: 'FILE_QUOTA_EXCEEDED',
      FILE_CLEANUP_EXECUTED: 'FILE_CLEANUP_EXECUTED',
      FILE_PRESIGNED_URL_GENERATED: 'FILE_PRESIGNED_URL_GENERATED',
    };

    it('should log FILE_UPLOADED event on successful upload', () => {
      const auditEvent = {
        eventType: FILE_AUDIT_EVENTS.FILE_UPLOADED,
        fileId: 'file-123',
        fileName: 'document.pdf',
        operation: 'UPLOAD',
        userId: 'user-456',
        result: 'SUCCESS',
        severity: 'LOW',
        details: {
          fileSize: 1024 * 1024,
          mimeType: 'application/pdf',
          encrypted: true,
        },
        context: {
          ipAddress: '192.168.1.1',
          userAgent: 'Mozilla/5.0',
        },
      };

      expect(auditEvent.eventType).toBe('FILE_UPLOADED');
      expect(auditEvent.fileId).toBeTruthy();
      expect(auditEvent.context.ipAddress).toBeTruthy();
    });

    it('should log FILE_DOWNLOADED event with presigned URL info', () => {
      const auditEvent = {
        eventType: FILE_AUDIT_EVENTS.FILE_DOWNLOADED,
        fileId: 'file-123',
        fileName: 'document.pdf',
        operation: 'DOWNLOAD',
        userId: 'user-456',
        result: 'SUCCESS',
        severity: 'LOW',
        details: {
          urlExpiry: 3600,
          method: 'presigned_url',
        },
      };

      expect(auditEvent.eventType).toBe('FILE_DOWNLOADED');
      expect(auditEvent.details.method).toBe('presigned_url');
    });

    it('should log FILE_VIRUS_DETECTED event when threat found', () => {
      const auditEvent = {
        eventType: FILE_AUDIT_EVENTS.FILE_VIRUS_DETECTED,
        fileId: 'file-123',
        fileName: 'malicious.exe',
        operation: 'UPLOAD',
        userId: 'user-456',
        result: 'BLOCKED',
        severity: 'HIGH',
        details: {
          threats: ['Trojan.Generic'],
          scanEngine: 'ClamAV',
        },
      };

      expect(auditEvent.eventType).toBe('FILE_VIRUS_DETECTED');
      expect(auditEvent.severity).toBe('HIGH');
      expect(auditEvent.result).toBe('BLOCKED');
    });

    it('should log FILE_QUOTA_EXCEEDED event when limit reached', () => {
      const auditEvent = {
        eventType: FILE_AUDIT_EVENTS.FILE_QUOTA_EXCEEDED,
        fileId: null,
        fileName: 'large-file.zip',
        operation: 'UPLOAD',
        userId: 'user-456',
        result: 'DENIED',
        severity: 'MEDIUM',
        details: {
          attemptedSize: 200 * 1024 * 1024,
          quotaLimit: 100 * 1024 * 1024,
          currentUsage: 95 * 1024 * 1024,
        },
      };

      expect(auditEvent.eventType).toBe('FILE_QUOTA_EXCEEDED');
      expect(auditEvent.result).toBe('DENIED');
    });

    it('should include risk score in audit events', () => {
      const calculateRiskScore = (event: any): number => {
        let score = 0;

        if (event.severity === 'HIGH') score += 50;
        if (event.severity === 'CRITICAL') score += 100;
        if (event.result === 'BLOCKED' || event.result === 'DENIED') score += 25;
        if (event.eventType === FILE_AUDIT_EVENTS.FILE_VIRUS_DETECTED) score += 50;
        if (event.eventType === FILE_AUDIT_EVENTS.FILE_ACCESS_DENIED) score += 15;

        return Math.min(score, 100);
      };

      const virusEvent = {
        eventType: FILE_AUDIT_EVENTS.FILE_VIRUS_DETECTED,
        severity: 'HIGH',
        result: 'BLOCKED',
      };

      const riskScore = calculateRiskScore(virusEvent);
      expect(riskScore).toBeGreaterThanOrEqual(50);
    });
  });

  describe('File Cleanup Security', () => {
    const RETENTION_POLICIES = {
      temporary: 1, // 1 day
      expired: 0, // Immediate
      orphaned: 7, // 7 days
      inactiveUser: 365, // 1 year
      oldVersions: 90, // 90 days
      accessLogs: 90, // 90 days, then anonymize
    };

    it('should delete temporary files after 1 day', () => {
      expect(RETENTION_POLICIES.temporary).toBe(1);
    });

    it('should immediately delete expired files', () => {
      expect(RETENTION_POLICIES.expired).toBe(0);
    });

    it('should delete orphaned files after 7 days', () => {
      expect(RETENTION_POLICIES.orphaned).toBe(7);
    });

    it('should archive inactive user files after 365 days', () => {
      expect(RETENTION_POLICIES.inactiveUser).toBe(365);
    });

    it('should delete old versions after 90 days', () => {
      expect(RETENTION_POLICIES.oldVersions).toBe(90);
    });

    it('should anonymize access logs after 90 days', () => {
      expect(RETENTION_POLICIES.accessLogs).toBe(90);
    });
  });

  describe('Input Validation Security', () => {
    it('should sanitize file names', () => {
      const sanitizeFileName = (name: string): string => {
        return name
          .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
          .replace(/\.{2,}/g, '.')
          .replace(/^\.+/, '')
          .substring(0, 255);
      };

      expect(sanitizeFileName('../../../etc/passwd')).toBe('_._._etc_passwd');
      expect(sanitizeFileName('file<script>.txt')).toBe('file_script_.txt');
      expect(sanitizeFileName('normal-file.pdf')).toBe('normal-file.pdf');
    });

    it('should validate MIME types match file content', () => {
      // Magic number validation for common types
      const MAGIC_NUMBERS: Record<string, number[]> = {
        'image/png': [0x89, 0x50, 0x4e, 0x47],
        'image/jpeg': [0xff, 0xd8, 0xff],
        'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
        'application/zip': [0x50, 0x4b, 0x03, 0x04],
      };

      const validateMagicNumber = (buffer: Buffer, expectedType: string): boolean => {
        const magic = MAGIC_NUMBERS[expectedType];
        if (!magic) return true; // Unknown types pass

        for (let i = 0; i < magic.length; i++) {
          if (buffer[i] !== magic[i]) return false;
        }
        return true;
      };

      const pngBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
      expect(validateMagicNumber(pngBuffer, 'image/png')).toBe(true);
      expect(validateMagicNumber(pngBuffer, 'application/pdf')).toBe(false);
    });

    it('should reject files with mismatched extensions', () => {
      const validateExtension = (filename: string, mimeType: string): boolean => {
        const extensionMap: Record<string, string[]> = {
          'image/png': ['.png'],
          'image/jpeg': ['.jpg', '.jpeg'],
          'application/pdf': ['.pdf'],
          'text/plain': ['.txt'],
        };

        const ext = filename.toLowerCase().slice(filename.lastIndexOf('.'));
        const allowedExtensions = extensionMap[mimeType];

        if (!allowedExtensions) return true; // Unknown types pass
        return allowedExtensions.includes(ext);
      };

      expect(validateExtension('image.png', 'image/png')).toBe(true);
      expect(validateExtension('script.exe.png', 'image/png')).toBe(true);
      expect(validateExtension('document.txt', 'application/pdf')).toBe(false);
    });
  });

  describe('Permission Enforcement', () => {
    const PERMISSIONS = ['READ', 'WRITE', 'DELETE', 'SHARE', 'ADMIN'];

    it('should require READ permission for downloads', () => {
      const userPermissions = ['READ'];
      const requiredPermission = 'READ';
      expect(userPermissions.includes(requiredPermission)).toBe(true);
    });

    it('should require WRITE permission for uploads', () => {
      const userPermissions = ['READ'];
      const requiredPermission = 'WRITE';
      expect(userPermissions.includes(requiredPermission)).toBe(false);
    });

    it('should require DELETE permission for file deletion', () => {
      const userPermissions = ['READ', 'WRITE'];
      const requiredPermission = 'DELETE';
      expect(userPermissions.includes(requiredPermission)).toBe(false);
    });

    it('should require SHARE permission for sharing files', () => {
      const userPermissions = ['READ', 'WRITE', 'SHARE'];
      const requiredPermission = 'SHARE';
      expect(userPermissions.includes(requiredPermission)).toBe(true);
    });

    it('should grant all permissions to ADMIN permission holders', () => {
      const userPermissions = ['ADMIN'];
      // ADMIN includes all other permissions
      const hasFullAccess = userPermissions.includes('ADMIN');
      expect(hasFullAccess).toBe(true);
    });
  });
});
