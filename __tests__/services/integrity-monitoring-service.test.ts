/**
 * Integrity Monitoring Service Tests
 * Comprehensive test suite for integrity monitoring and alerting functionality
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
  integrityMonitoringService,
  IntegrityAlert,
} from '../../server/services/integrity-monitoring-service.js';
import { fileIntegrityService } from '../../server/services/file-integrity-service.js';
import { storageHealthMonitor } from '../../server/services/storage-health-monitor.js';
import { db } from '../../server/db.js';
import { files, fileIntegrityLogs } from '../../shared/file-schema.js';

// Mock external dependencies
jest.mock('../../server/services/file-integrity-service');
jest.mock('../../server/services/storage-health-monitor');
jest.mock('../../server/db.js');
jest.mock('node-cron');

const mockFileIntegrityService = fileIntegrityService as jest.Mocked<
  typeof fileIntegrityService
>;
const mockStorageHealthMonitor = storageHealthMonitor as jest.Mocked<
  typeof storageHealthMonitor
>;
const mockDb = db as jest.Mocked<typeof db>;

describe('IntegrityMonitoringService', () => {
  const testFileId = 'test-file-id-123';
  const testUserId = 1;

  beforeAll(async () => {
    // Initialize the service
    await integrityMonitoringService.initialize();
  });

  afterAll(async () => {
    // Cleanup
    await integrityMonitoringService.shutdown();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('initialize', () => {
    it('should initialize successfully', async () => {
      // Mock Redis operations
      const mockRedis = require('ioredis');
      const redisMock = {
        keys: jest.fn().mockResolvedValue([]),
        get: jest.fn().mockResolvedValue(null),
      };
      mockRedis.mockImplementation(() => redisMock);

      await integrityMonitoringService.initialize();

      expect(redisMock.keys).toHaveBeenCalledWith('integrity_alert:*');
      expect(redisMock.keys).toHaveBeenCalledWith('verification:*');
    });

    it('should load persisted alerts and verifications', async () => {
      const mockAlert = {
        id: 'alert-123',
        type: 'CORRUPTION_DETECTED',
        severity: 'HIGH',
        message: 'Test alert',
        createdAt: new Date(),
        acknowledged: false,
      };

      const mockVerification = {
        id: 'verify-123',
        fileId: testFileId,
        userId: testUserId,
        scheduledAt: new Date(),
        priority: 'MEDIUM',
        algorithms: ['SHA256'],
        status: 'PENDING',
      };

      const mockRedis = require('ioredis');
      const redisMock = {
        keys: jest
          .fn()
          .mockResolvedValueOnce(['integrity_alert:alert-123'])
          .mockResolvedValueOnce(['verification:verify-123']),
        get: jest
          .fn()
          .mockResolvedValueOnce(JSON.stringify(mockAlert))
          .mockResolvedValueOnce(JSON.stringify(mockVerification)),
      };
      mockRedis.mockImplementation(() => redisMock);

      await integrityMonitoringService.initialize();

      // Verify state was loaded
      const scheduledVerifications =
        integrityMonitoringService.getScheduledVerifications();
      expect(scheduledVerifications).toHaveLength(1);
      expect(scheduledVerifications[0].id).toBe('verify-123');
    });
  });

  describe('scheduleVerification', () => {
    beforeEach(() => {
      // Mock Redis operations
      const mockRedis = require('ioredis');
      const redisMock = {
        setex: jest.fn().mockResolvedValue('OK'),
      };
      mockRedis.mockImplementation(() => redisMock);
    });

    it('should schedule immediate verification', async () => {
      const verificationId =
        await integrityMonitoringService.scheduleVerification(
          testFileId,
          testUserId,
          {
            priority: 'HIGH',
            algorithms: ['SHA256', 'BLAKE2B'],
          }
        );

      expect(verificationId).toBeTruthy();
      expect(verificationId).toMatch(/^verify_/);

      const scheduledVerifications =
        integrityMonitoringService.getScheduledVerifications();
      const verification = scheduledVerifications.find(
        v => v.id === verificationId
      );

      expect(verification).toBeDefined();
      expect(verification?.fileId).toBe(testFileId);
      expect(verification?.priority).toBe('HIGH');
      expect(verification?.algorithms).toEqual(['SHA256', 'BLAKE2B']);
      expect(verification?.status).toBe('PENDING');
    });

    it('should schedule future verification', async () => {
      const futureDate = new Date(Date.now() + 60000); // 1 minute from now

      const verificationId =
        await integrityMonitoringService.scheduleVerification(
          testFileId,
          testUserId,
          {
            scheduledAt: futureDate,
            priority: 'MEDIUM',
          }
        );

      const scheduledVerifications =
        integrityMonitoringService.getScheduledVerifications();
      const verification = scheduledVerifications.find(
        v => v.id === verificationId
      );

      expect(verification?.scheduledAt.getTime()).toBeCloseTo(
        futureDate.getTime(),
        -3
      );
    });

    it('should set up recurring verification', async () => {
      const mockCron = require('node-cron');
      const mockTask = {
        start: jest.fn(),
        stop: jest.fn(),
      };
      mockCron.schedule = jest.fn().mockReturnValue(mockTask);

      await integrityMonitoringService.scheduleVerification(
        testFileId,
        testUserId,
        {
          recurring: true,
          recurringInterval: '0 2 * * *', // Daily at 2 AM
        }
      );

      expect(mockCron.schedule).toHaveBeenCalledWith(
        '0 2 * * *',
        expect.any(Function),
        { scheduled: false }
      );
      expect(mockTask.start).toHaveBeenCalled();
    });

    it('should persist verification to Redis', async () => {
      const mockRedis = require('ioredis');
      const redisMock = {
        setex: jest.fn().mockResolvedValue('OK'),
      };
      mockRedis.mockImplementation(() => redisMock);

      const verificationId =
        await integrityMonitoringService.scheduleVerification(
          testFileId,
          testUserId
        );

      expect(redisMock.setex).toHaveBeenCalledWith(
        `verification:${verificationId}`,
        86400,
        expect.any(String)
      );
    });
  });

  describe('getHealthStatus', () => {
    beforeEach(() => {
      // Mock database queries
      mockDb.select = jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockResolvedValue([
            {
              total: '100',
              verified: '90',
              pending: '10',
            },
          ]),
        }),
      });
    });

    it('should return comprehensive health status', async () => {
      // Mock corruption count query
      mockDb.select = jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                total: '100',
                verified: '90',
                pending: '10',
              },
            ]),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ count: '2' }]),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                avgTime: '1500',
                totalVerifications: '150',
                failedVerifications: '5',
              },
            ]),
          }),
        });

      const healthStatus = await integrityMonitoringService.getHealthStatus();

      expect(healthStatus.totalFiles).toBe(100);
      expect(healthStatus.verifiedFiles).toBe(90);
      expect(healthStatus.corruptedFiles).toBe(2);
      expect(healthStatus.pendingVerifications).toBe(10);
      expect(healthStatus.failureRate).toBeCloseTo(0.033, 3); // 5/150
      expect(healthStatus.averageVerificationTime).toBe(1500);
      expect(healthStatus.lastCheckTime).toBeInstanceOf(Date);
      expect(healthStatus.alerts).toBeDefined();
      expect(healthStatus.recommendations).toBeDefined();
    });

    it('should determine healthy status correctly', async () => {
      // Mock healthy system
      mockDb.select = jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                total: '100',
                verified: '100',
                pending: '0',
              },
            ]),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ count: '0' }]),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                avgTime: '1000',
                totalVerifications: '100',
                failedVerifications: '1',
              },
            ]),
          }),
        });

      const healthStatus = await integrityMonitoringService.getHealthStatus();

      expect(healthStatus.isHealthy).toBe(true);
      expect(healthStatus.failureRate).toBe(0.01); // 1% failure rate
      expect(healthStatus.corruptedFiles).toBe(0);
    });

    it('should determine unhealthy status correctly', async () => {
      // Mock unhealthy system
      mockDb.select = jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                total: '100',
                verified: '85',
                pending: '15',
              },
            ]),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([{ count: '5' }]),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                avgTime: '3000',
                totalVerifications: '100',
                failedVerifications: '8',
              },
            ]),
          }),
        });

      // Add a critical alert
      await integrityMonitoringService.createAlert(
        'CORRUPTION_DETECTED',
        'CRITICAL',
        'Critical corruption detected'
      );

      const healthStatus = await integrityMonitoringService.getHealthStatus();

      expect(healthStatus.isHealthy).toBe(false);
      expect(healthStatus.failureRate).toBe(0.08); // 8% failure rate
      expect(healthStatus.corruptedFiles).toBe(5);
    });
  });

  describe('createAlert', () => {
    beforeEach(() => {
      // Mock Redis operations
      const mockRedis = require('ioredis');
      const redisMock = {
        setex: jest.fn().mockResolvedValue('OK'),
      };
      mockRedis.mockImplementation(() => redisMock);
    });

    it('should create alert successfully', async () => {
      const alertId = await integrityMonitoringService.createAlert(
        'CORRUPTION_DETECTED',
        'HIGH',
        'File corruption detected in storage',
        testFileId,
        { storageProvider: 'aws_s3' }
      );

      expect(alertId).toBeTruthy();
      expect(alertId).toMatch(/^alert_/);
    });

    it('should persist alert to Redis', async () => {
      const mockRedis = require('ioredis');
      const redisMock = {
        setex: jest.fn().mockResolvedValue('OK'),
      };
      mockRedis.mockImplementation(() => redisMock);

      const alertId = await integrityMonitoringService.createAlert(
        'HIGH_FAILURE_RATE',
        'MEDIUM',
        'High verification failure rate detected'
      );

      expect(redisMock.setex).toHaveBeenCalledWith(
        `integrity_alert:${alertId}`,
        86400,
        expect.any(String)
      );
    });

    it('should handle critical alerts specially', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation();

      await integrityMonitoringService.createAlert(
        'STORAGE_HEALTH_ISSUE',
        'CRITICAL',
        'Critical storage failure'
      );

      // Should have logged critical alert
      expect(consoleSpy).toHaveBeenCalled();

      consoleSpy.mockRestore();
    });
  });

  describe('acknowledgeAlert', () => {
    it('should acknowledge existing alert', async () => {
      // Create an alert first
      const alertId = await integrityMonitoringService.createAlert(
        'VERIFICATION_TIMEOUT',
        'MEDIUM',
        'Verification timeout occurred'
      );

      const success = await integrityMonitoringService.acknowledgeAlert(
        alertId,
        testUserId
      );

      expect(success).toBe(true);
    });

    it('should return false for non-existent alert', async () => {
      const success = await integrityMonitoringService.acknowledgeAlert(
        'non-existent-alert',
        testUserId
      );

      expect(success).toBe(false);
    });

    it('should update alert metadata', async () => {
      const mockRedis = require('ioredis');
      const redisMock = {
        setex: jest.fn().mockResolvedValue('OK'),
      };
      mockRedis.mockImplementation(() => redisMock);

      const alertId = await integrityMonitoringService.createAlert(
        'CORRUPTION_DETECTED',
        'HIGH',
        'Test alert'
      );

      await integrityMonitoringService.acknowledgeAlert(alertId, testUserId);

      // Should have updated the alert in Redis
      expect(redisMock.setex).toHaveBeenCalledWith(
        `integrity_alert:${alertId}`,
        86400,
        expect.stringContaining('"acknowledged":true')
      );
    });
  });

  describe('generateReport', () => {
    beforeEach(() => {
      // Mock database queries for report generation
      mockDb.select = jest
        .fn()
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockResolvedValue([
              {
                totalFiles: '50',
                verificationsPerformed: '150',
                corruptionEvents: '3',
                avgTime: '1200',
              },
            ]),
          }),
        })
        .mockReturnValueOnce({
          from: jest.fn().mockReturnValue({
            where: jest.fn().mockReturnValue({
              groupBy: jest.fn().mockResolvedValue([
                { type: 'CHECKSUM_MISMATCH', count: '2' },
                { type: 'SIZE_MISMATCH', count: '1' },
              ]),
            }),
          }),
        });

      // Mock storage health monitor
      mockStorageHealthMonitor.getAllNetworkHealth.mockResolvedValue([
        { network: 'aws_s3', isHealthy: true, reliability: 0.99 },
        { network: 'ipfs', isHealthy: true, reliability: 0.95 },
      ]);
    });

    it('should generate daily report', async () => {
      const report = await integrityMonitoringService.generateReport('DAILY');

      expect(report.id).toBeTruthy();
      expect(report.reportType).toBe('DAILY');
      expect(report.generatedAt).toBeInstanceOf(Date);
      expect(report.period.start).toBeInstanceOf(Date);
      expect(report.period.end).toBeInstanceOf(Date);
      expect(report.summary.totalFiles).toBe(50);
      expect(report.summary.verificationsPerformed).toBe(150);
      expect(report.summary.corruptionEvents).toBe(3);
      expect(report.details.topCorruptionTypes).toHaveLength(2);
      expect(report.details.storageProviderHealth).toHaveLength(2);
    });

    it('should generate weekly report', async () => {
      const report = await integrityMonitoringService.generateReport('WEEKLY');

      expect(report.reportType).toBe('WEEKLY');

      // Weekly report should cover 7 days
      const periodDuration =
        report.period.end.getTime() - report.period.start.getTime();
      const sevenDays = 7 * 24 * 60 * 60 * 1000;
      expect(periodDuration).toBeCloseTo(sevenDays, -5); // Within 100 seconds tolerance
    });

    it('should generate custom period report', async () => {
      const customStart = new Date('2023-01-01');
      const customEnd = new Date('2023-01-31');

      const report = await integrityMonitoringService.generateReport('CUSTOM', {
        start: customStart,
        end: customEnd,
      });

      expect(report.reportType).toBe('CUSTOM');
      expect(report.period.start).toEqual(customStart);
      expect(report.period.end).toEqual(customEnd);
    });

    it('should cache generated report', async () => {
      const mockRedis = require('ioredis');
      const redisMock = {
        setex: jest.fn().mockResolvedValue('OK'),
      };
      mockRedis.mockImplementation(() => redisMock);

      const report = await integrityMonitoringService.generateReport('DAILY');

      expect(redisMock.setex).toHaveBeenCalledWith(
        `integrity_report:${report.id}`,
        604800, // 7 days
        expect.any(String)
      );
    });
  });

  describe('cancelVerification', () => {
    it('should cancel pending verification', async () => {
      const verificationId =
        await integrityMonitoringService.scheduleVerification(
          testFileId,
          testUserId,
          { scheduledAt: new Date(Date.now() + 60000) } // Future date
        );

      const success =
        await integrityMonitoringService.cancelVerification(verificationId);

      expect(success).toBe(true);

      const scheduledVerifications =
        integrityMonitoringService.getScheduledVerifications();
      const verification = scheduledVerifications.find(
        v => v.id === verificationId
      );
      expect(verification).toBeUndefined();
    });

    it('should not cancel non-pending verification', async () => {
      // Create a verification and mock it as in progress
      const verificationId =
        await integrityMonitoringService.scheduleVerification(
          testFileId,
          testUserId
        );

      // Simulate verification starting
      const scheduledVerifications =
        integrityMonitoringService.getScheduledVerifications();
      const verification = scheduledVerifications.find(
        v => v.id === verificationId
      );
      if (verification) {
        verification.status = 'IN_PROGRESS';
      }

      const success =
        await integrityMonitoringService.cancelVerification(verificationId);

      expect(success).toBe(false);
    });

    it('should return false for non-existent verification', async () => {
      const success =
        await integrityMonitoringService.cancelVerification('non-existent');

      expect(success).toBe(false);
    });
  });

  describe('Scheduled Tasks', () => {
    it('should set up daily health check', async () => {
      const mockCron = require('node-cron');
      mockCron.schedule = jest.fn().mockReturnValue({
        start: jest.fn(),
        stop: jest.fn(),
      });

      await integrityMonitoringService.initialize();

      expect(mockCron.schedule).toHaveBeenCalledWith(
        '0 2 * * *', // Daily at 2 AM
        expect.any(Function)
      );
    });

    it('should set up weekly report generation', async () => {
      const mockCron = require('node-cron');
      mockCron.schedule = jest.fn().mockReturnValue({
        start: jest.fn(),
        stop: jest.fn(),
      });

      await integrityMonitoringService.initialize();

      expect(mockCron.schedule).toHaveBeenCalledWith(
        '0 6 * * 0', // Weekly on Sunday at 6 AM
        expect.any(Function)
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle Redis connection errors gracefully', async () => {
      const mockRedis = require('ioredis');
      const redisMock = {
        keys: jest.fn().mockRejectedValue(new Error('Redis connection failed')),
        get: jest.fn().mockRejectedValue(new Error('Redis connection failed')),
        setex: jest
          .fn()
          .mockRejectedValue(new Error('Redis connection failed')),
      };
      mockRedis.mockImplementation(() => redisMock);

      // Should not throw error during initialization
      await expect(
        integrityMonitoringService.initialize()
      ).resolves.not.toThrow();

      // Should continue to work despite Redis errors
      const alertId = await integrityMonitoringService.createAlert(
        'CORRUPTION_DETECTED',
        'HIGH',
        'Test alert'
      );

      expect(alertId).toBeTruthy();
    });

    it('should handle database connection errors', async () => {
      mockDb.select = jest
        .fn()
        .mockRejectedValue(new Error('Database connection failed'));

      await expect(
        integrityMonitoringService.getHealthStatus()
      ).rejects.toThrow('Database connection failed');
    });

    it('should handle storage health monitor errors', async () => {
      mockStorageHealthMonitor.getAllNetworkHealth.mockRejectedValue(
        new Error('Storage health monitor unavailable')
      );

      const report = await integrityMonitoringService.generateReport('DAILY');

      // Should still generate report with empty storage health data
      expect(report.details.storageProviderHealth).toEqual([]);
    });
  });

  describe('Performance Tests', () => {
    it('should handle high volume of alerts efficiently', async () => {
      const startTime = Date.now();

      // Create 100 alerts
      const alertPromises = Array.from({ length: 100 }, (_, i) =>
        integrityMonitoringService.createAlert(
          'VERIFICATION_TIMEOUT',
          'LOW',
          `Test alert ${i}`
        )
      );

      await Promise.all(alertPromises);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(5000); // Should complete within 5 seconds
    });

    it('should handle concurrent verification scheduling', async () => {
      const startTime = Date.now();

      // Schedule 50 verifications concurrently
      const verificationPromises = Array.from({ length: 50 }, (_, i) =>
        integrityMonitoringService.scheduleVerification(
          `file-${i}`,
          testUserId,
          { priority: 'LOW' }
        )
      );

      const verificationIds = await Promise.all(verificationPromises);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(3000); // Should complete within 3 seconds
      expect(verificationIds).toHaveLength(50);
      expect(new Set(verificationIds).size).toBe(50); // All IDs should be unique
    });
  });

  describe('shutdown', () => {
    it('should shutdown gracefully', async () => {
      const mockCron = require('node-cron');
      const mockTask = {
        start: jest.fn(),
        stop: jest.fn(),
      };
      mockCron.schedule = jest.fn().mockReturnValue(mockTask);

      await integrityMonitoringService.initialize();
      await integrityMonitoringService.shutdown();

      expect(mockTask.stop).toHaveBeenCalled();
    });
  });
});
