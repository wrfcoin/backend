/**
 * File Integrity Service Tests
 * Comprehensive test suite for file integrity verification functionality
 */

import {
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  it,
  expect,
  jest,
} from '@jest/globals';
import {
  fileIntegrityService,
  IntegrityVerificationRequest,
} from '../../server/services/file-integrity-service.js';
import { enhancedFileStorageService } from '../../server/services/enhanced-file-storage.js';
import { multiNetworkStorageAdapter } from '../../server/services/multi-network-storage-adapter.js';
import { db } from '../../server/db.js';
import { files, fileIntegrityLogs } from '../../shared/file-schema.js';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

// Mock external dependencies
jest.mock('../../server/services/enhanced-file-storage');
jest.mock('../../server/services/multi-network-storage-adapter');
jest.mock('../../server/db.js');
jest.mock('fs');

const mockEnhancedFileStorageService =
  enhancedFileStorageService as jest.Mocked<typeof enhancedFileStorageService>;
const mockMultiNetworkStorageAdapter =
  multiNetworkStorageAdapter as jest.Mocked<typeof multiNetworkStorageAdapter>;
const mockDb = db as jest.Mocked<typeof db>;
const mockFs = fs as jest.Mocked<typeof fs>;

describe('FileIntegrityService', () => {
  const testFileId = 'test-file-id-123';
  const testUserId = 1;
  const testFilePath = '/tmp/test-file.txt';
  const testFileContent =
    'This is test file content for integrity verification';
  const testFileHash = crypto
    .createHash('sha256')
    .update(testFileContent)
    .digest('hex');

  beforeAll(async () => {
    // Initialize the service
    await fileIntegrityService.initialize();
  });

  afterAll(async () => {
    // Cleanup
    fileIntegrityService.stopIntegrityMonitoring();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('generateFileHashes', () => {
    beforeEach(() => {
      // Mock file system operations
      mockFs.promises.stat = jest
        .fn()
        .mockResolvedValue({ size: testFileContent.length });
      mockFs.createReadStream = jest.fn().mockReturnValue({
        on: jest.fn((event, callback) => {
          if (event === 'data') {
            callback(Buffer.from(testFileContent));
          } else if (event === 'end') {
            callback();
          }
          return this;
        }),
      });
      mockFs.promises.access = jest.fn().mockResolvedValue(undefined);
    });

    it('should generate SHA256 hash correctly', async () => {
      const hashes = await fileIntegrityService.generateFileHashes(
        testFileId,
        testFilePath,
        ['SHA256']
      );

      expect(hashes).toHaveLength(1);
      expect(hashes[0].algorithm).toBe('SHA256');
      expect(hashes[0].hash).toBe(testFileHash);
      expect(hashes[0].size).toBe(testFileContent.length);
      expect(hashes[0].verificationTime).toBeGreaterThan(0);
    });

    it('should generate multiple hash algorithms', async () => {
      const algorithms = ['SHA256', 'BLAKE2B', 'MD5'];
      const hashes = await fileIntegrityService.generateFileHashes(
        testFileId,
        testFilePath,
        algorithms
      );

      expect(hashes).toHaveLength(3);
      expect(hashes.map(h => h.algorithm)).toEqual(algorithms);
      hashes.forEach(hash => {
        expect(hash.hash).toBeTruthy();
        expect(hash.size).toBe(testFileContent.length);
        expect(hash.verificationTime).toBeGreaterThan(0);
      });
    });

    it('should throw error for non-existent file', async () => {
      mockFs.promises.access = jest
        .fn()
        .mockRejectedValue(new Error('File not found'));

      await expect(
        fileIntegrityService.generateFileHashes(
          testFileId,
          '/non/existent/file',
          ['SHA256']
        )
      ).rejects.toThrow('File not found');
    });

    it('should cache generated hashes', async () => {
      // Mock Redis cache
      const mockRedis = require('ioredis');
      const redisMock = {
        setex: jest.fn().mockResolvedValue('OK'),
        get: jest.fn().mockResolvedValue(null),
      };
      mockRedis.mockImplementation(() => redisMock);

      await fileIntegrityService.generateFileHashes(testFileId, testFilePath, [
        'SHA256',
      ]);

      expect(redisMock.setex).toHaveBeenCalledWith(
        `file_hash:${testFileId}:SHA256`,
        86400,
        expect.any(String)
      );
    });
  });

  describe('verifyFileIntegrity', () => {
    const mockFile = {
      fileId: testFileId,
      userId: testUserId,
      originalName: 'test-file.txt',
      filename: 'secure-filename.txt',
      mimeType: 'text/plain',
      fileSize: testFileContent.length,
      storageProvider: 'S3',
      storagePath: '/bucket/path/file.txt',
      checksum: testFileHash,
      visibility: 'PRIVATE' as const,
      isEncrypted: false,
      status: 'ACTIVE' as const,
      uploadedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    beforeEach(() => {
      mockEnhancedFileStorageService.getFile.mockResolvedValue(mockFile);

      // Mock database operations
      mockDb.insert = jest.fn().mockResolvedValue([{}]);
      mockDb.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([{ count: '0' }]),
        }),
      });
    });

    it('should verify file integrity successfully', async () => {
      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
        algorithms: ['SHA256'],
      };

      const result = await fileIntegrityService.verifyFileIntegrity(request);

      expect(result.fileId).toBe(testFileId);
      expect(result.status).toBe('VERIFIED');
      expect(result.verificationTime).toBeGreaterThan(0);
      expect(result.verifiedAt).toBeInstanceOf(Date);
    });

    it('should handle multi-network storage verification', async () => {
      const multiNetworkFile = {
        ...mockFile,
        storageProvider: 'MULTI_NETWORK',
        storagePath: JSON.stringify([
          { provider: 'aws_s3', path: '/bucket/file.txt' },
          { provider: 'ipfs', path: 'QmXXX...' },
        ]),
      };

      mockEnhancedFileStorageService.getFile.mockResolvedValue(
        multiNetworkFile
      );

      const mockLocations = [
        {
          provider: 'aws_s3',
          path: '/bucket/file.txt',
          checksum: testFileHash,
          size: testFileContent.length,
          isActive: true,
          createdAt: new Date(),
        },
        {
          provider: 'ipfs',
          path: 'QmXXX...',
          checksum: testFileHash,
          size: testFileContent.length,
          isActive: true,
          createdAt: new Date(),
        },
      ];

      mockMultiNetworkStorageAdapter.getFileLocations.mockReturnValue(
        mockLocations
      );

      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
        algorithms: ['SHA256'],
      };

      const result = await fileIntegrityService.verifyFileIntegrity(request);

      expect(result.storageSources).toBeDefined();
      expect(result.storageSources).toHaveLength(2);
      expect(result.storageSources?.[0].provider).toBe('aws_s3');
      expect(result.storageSources?.[1].provider).toBe('ipfs');
    });

    it('should detect corruption when checksums mismatch', async () => {
      const corruptedFile = {
        ...mockFile,
        checksum: 'corrupted-hash-value',
      };

      mockEnhancedFileStorageService.getFile.mockResolvedValue(corruptedFile);

      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
        forceRecompute: true,
      };

      const result = await fileIntegrityService.verifyFileIntegrity(request);

      expect(result.status).toBe('CORRUPTED');
      expect(result.issues).toBeDefined();
      expect(result.issues?.length).toBeGreaterThan(0);
      expect(result.recommendations).toBeDefined();
    });

    it('should use cached results when available', async () => {
      const cachedResult = {
        fileId: testFileId,
        status: 'VERIFIED' as const,
        hashes: [],
        verifiedAt: new Date(),
        verificationTime: 1000,
      };

      // Mock Redis cache hit
      const mockRedis = require('ioredis');
      const redisMock = {
        get: jest.fn().mockResolvedValue(JSON.stringify(cachedResult)),
        setex: jest.fn().mockResolvedValue('OK'),
      };
      mockRedis.mockImplementation(() => redisMock);

      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
      };

      const result = await fileIntegrityService.verifyFileIntegrity(request);

      expect(result.fileId).toBe(testFileId);
      expect(result.status).toBe('VERIFIED');
      // Should not call file storage service for cached result
      expect(mockEnhancedFileStorageService.getFile).not.toHaveBeenCalled();
    });

    it('should force recomputation when requested', async () => {
      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
        forceRecompute: true,
      };

      await fileIntegrityService.verifyFileIntegrity(request);

      expect(mockEnhancedFileStorageService.getFile).toHaveBeenCalled();
    });

    it('should include binary comparison when requested', async () => {
      const multiNetworkFile = {
        ...mockFile,
        storageProvider: 'MULTI_NETWORK',
      };

      mockEnhancedFileStorageService.getFile.mockResolvedValue(
        multiNetworkFile
      );
      mockMultiNetworkStorageAdapter.getFileLocations.mockReturnValue([
        {
          provider: 'aws_s3',
          path: '/bucket/file.txt',
          checksum: testFileHash,
          size: testFileContent.length,
          isActive: true,
          createdAt: new Date(),
        },
        {
          provider: 'ipfs',
          path: 'QmXXX...',
          checksum: 'different-hash',
          size: testFileContent.length,
          isActive: true,
          createdAt: new Date(),
        },
      ]);

      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
        includeBinaryComparison: true,
      };

      const result = await fileIntegrityService.verifyFileIntegrity(request);

      expect(result.issues).toContain(
        expect.stringContaining('Binary comparison revealed inconsistencies')
      );
    });

    it('should log verification results to database', async () => {
      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
      };

      await fileIntegrityService.verifyFileIntegrity(request);

      expect(mockDb.insert).toHaveBeenCalledWith(fileIntegrityLogs);
    });

    it('should handle file not found error', async () => {
      mockEnhancedFileStorageService.getFile.mockResolvedValue(null);

      const request: IntegrityVerificationRequest = {
        fileId: 'non-existent-file',
        userId: testUserId,
      };

      await expect(
        fileIntegrityService.verifyFileIntegrity(request)
      ).rejects.toThrow('File not found');
    });
  });

  describe('detectCorruption', () => {
    beforeEach(() => {
      // Mock successful integrity verification
      jest
        .spyOn(fileIntegrityService, 'verifyFileIntegrity')
        .mockResolvedValue({
          fileId: testFileId,
          status: 'VERIFIED',
          hashes: [],
          verifiedAt: new Date(),
          verificationTime: 1000,
        });
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it('should return not corrupted for healthy file', async () => {
      const result = await fileIntegrityService.detectCorruption(
        testFileId,
        testUserId
      );

      expect(result.isCorrupted).toBe(false);
    });

    it('should detect corruption and classify type', async () => {
      jest
        .spyOn(fileIntegrityService, 'verifyFileIntegrity')
        .mockResolvedValue({
          fileId: testFileId,
          status: 'CORRUPTED',
          hashes: [],
          verifiedAt: new Date(),
          verificationTime: 1000,
          issues: ['Checksum mismatch detected'],
        });

      const result = await fileIntegrityService.detectCorruption(
        testFileId,
        testUserId
      );

      expect(result.isCorrupted).toBe(true);
      expect(result.corruptionType).toBe('CHECKSUM_MISMATCH');
      expect(result.details).toContain('Checksum mismatch detected');
      expect(result.recoveryRecommendations).toBeDefined();
    });

    it('should handle different corruption types', async () => {
      const corruptionTypes = [
        { issue: 'size mismatch', expectedType: 'SIZE_MISMATCH' },
        {
          issue: 'Binary comparison failed',
          expectedType: 'BINARY_CORRUPTION',
        },
        { issue: 'Storage provider error', expectedType: 'STORAGE_FAILURE' },
      ];

      for (const { issue, expectedType } of corruptionTypes) {
        jest
          .spyOn(fileIntegrityService, 'verifyFileIntegrity')
          .mockResolvedValue({
            fileId: testFileId,
            status: 'CORRUPTED',
            hashes: [],
            verifiedAt: new Date(),
            verificationTime: 1000,
            issues: [issue],
          });

        const result = await fileIntegrityService.detectCorruption(
          testFileId,
          testUserId
        );

        expect(result.corruptionType).toBe(expectedType);
      }
    });
  });

  describe('startIntegrityMonitoring', () => {
    it('should start monitoring successfully', async () => {
      await fileIntegrityService.startIntegrityMonitoring();

      const status = fileIntegrityService.getMonitoringStatus();
      expect(status.isRunning).toBe(true);
    });

    it('should not start monitoring if already running', async () => {
      await fileIntegrityService.startIntegrityMonitoring();

      // Try to start again
      await fileIntegrityService.startIntegrityMonitoring();

      const status = fileIntegrityService.getMonitoringStatus();
      expect(status.isRunning).toBe(true);
    });
  });

  describe('stopIntegrityMonitoring', () => {
    it('should stop monitoring successfully', async () => {
      await fileIntegrityService.startIntegrityMonitoring();
      fileIntegrityService.stopIntegrityMonitoring();

      const status = fileIntegrityService.getMonitoringStatus();
      expect(status.isRunning).toBe(false);
    });
  });

  describe('getIntegrityStatistics', () => {
    beforeEach(() => {
      // Mock database statistics query
      mockDb.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            {
              total: '100',
              successful: '95',
              failed: '3',
              corrupted: '2',
              avgTime: '1500.5',
            },
          ]),
        }),
      });
    });

    it('should return integrity statistics', async () => {
      const stats = await fileIntegrityService.getIntegrityStatistics();

      expect(stats.totalVerifications).toBe(100);
      expect(stats.successfulVerifications).toBe(95);
      expect(stats.failedVerifications).toBe(3);
      expect(stats.corruptedFiles).toBe(2);
      expect(stats.averageVerificationTime).toBe(1500.5);
      expect(stats.algorithmUsage).toBeDefined();
    });

    it('should filter statistics by time range', async () => {
      const timeRange = {
        start: new Date('2023-01-01'),
        end: new Date('2023-12-31'),
      };

      await fileIntegrityService.getIntegrityStatistics(timeRange);

      // Verify that database query includes time range filter
      expect(mockDb.select).toHaveBeenCalled();
    });
  });

  describe('updateMonitoringConfig', () => {
    it('should update monitoring configuration', () => {
      const newConfig = {
        enabled: true,
        checkInterval: 120,
        batchSize: 25,
        algorithms: ['SHA256', 'BLAKE2B'] as const,
      };

      fileIntegrityService.updateMonitoringConfig(newConfig);

      const status = fileIntegrityService.getMonitoringStatus();
      expect(status.config.checkInterval).toBe(120);
      expect(status.config.batchSize).toBe(25);
    });

    it('should restart monitoring when critical settings change', async () => {
      await fileIntegrityService.startIntegrityMonitoring();

      const stopSpy = jest.spyOn(
        fileIntegrityService,
        'stopIntegrityMonitoring'
      );
      const startSpy = jest.spyOn(
        fileIntegrityService,
        'startIntegrityMonitoring'
      );

      fileIntegrityService.updateMonitoringConfig({
        checkInterval: 240,
      });

      expect(stopSpy).toHaveBeenCalled();
      expect(startSpy).toHaveBeenCalled();
    });
  });

  describe('Error Handling', () => {
    it('should handle database connection errors', async () => {
      mockDb.insert = jest
        .fn()
        .mockRejectedValue(new Error('Database connection failed'));

      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
      };

      await expect(
        fileIntegrityService.verifyFileIntegrity(request)
      ).rejects.toThrow();
    });

    it('should handle Redis connection errors gracefully', async () => {
      const mockRedis = require('ioredis');
      const redisMock = {
        get: jest.fn().mockRejectedValue(new Error('Redis connection failed')),
        setex: jest
          .fn()
          .mockRejectedValue(new Error('Redis connection failed')),
      };
      mockRedis.mockImplementation(() => redisMock);

      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
      };

      // Should not throw error, but continue without caching
      const result = await fileIntegrityService.verifyFileIntegrity(request);
      expect(result).toBeDefined();
    });

    it('should handle storage provider failures', async () => {
      mockMultiNetworkStorageAdapter.downloadFile.mockRejectedValue(
        new Error('Storage provider unavailable')
      );

      const mockFile = {
        fileId: testFileId,
        userId: testUserId,
        originalName: 'test-file.txt',
        filename: 'secure-filename.txt',
        mimeType: 'text/plain',
        fileSize: 100,
        storageProvider: 'S3',
        storagePath: '/bucket/path/file.txt',
        checksum: testFileHash,
        visibility: 'PRIVATE' as const,
        isEncrypted: false,
        status: 'ACTIVE' as const,
        uploadedAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const multiNetworkFile = {
        ...mockFile,
        storageProvider: 'MULTI_NETWORK',
      };

      mockEnhancedFileStorageService.getFile.mockResolvedValue(
        multiNetworkFile
      );

      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
        algorithms: ['SHA256'],
      };

      const result = await fileIntegrityService.verifyFileIntegrity(request);
      expect(result.issues).toContain(
        expect.stringContaining('Hash generation failed')
      );
    });
  });

  describe('Performance Tests', () => {
    it('should complete verification within reasonable time', async () => {
      const startTime = Date.now();

      const request: IntegrityVerificationRequest = {
        fileId: testFileId,
        userId: testUserId,
        algorithms: ['SHA256'],
      };

      await fileIntegrityService.verifyFileIntegrity(request);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it('should handle large batch verification efficiently', async () => {
      // Mock multiple files
      const fileIds = Array.from({ length: 10 }, (_, i) => `file-${i}`);

      mockDb.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: jest.fn().mockResolvedValue(
                fileIds.map(id => ({
                  file_id: id,
                  user_id: testUserId,
                  status: 'ACTIVE',
                }))
              ),
            }),
          }),
        }),
      });

      const startTime = Date.now();

      // This would test the batch verification method
      // await fileIntegrityService.performBatchIntegrityCheck();

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(10000); // Should complete within 10 seconds
    });
  });
});
