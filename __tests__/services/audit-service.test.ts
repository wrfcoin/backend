/**
 * Comprehensive Audit Service Tests
 * Tests for audit logging, reporting, and compliance functionality
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { auditService } from '../../server/services/audit-service.js';
import Redis from 'ioredis';

// Mock Redis
jest.mock('ioredis');

// Mock database
const mockDb = {
  insert: jest.fn(),
  select: jest.fn(),
  from: jest.fn(),
  where: jest.fn(),
  orderBy: jest.fn(),
  limit: jest.fn(),
  offset: jest.fn(),
  groupBy: jest.fn(),
  returning: jest.fn(),
};

jest.mock('../../server/db.js', () => ({
  db: mockDb,
}));

// Mock logger
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock field name converter
jest.mock('../../utils/fieldNameConverter', () => ({
  default: {
    camelToSnake: jest.fn((obj) => obj),
    snakeToCamel: jest.fn((obj) => obj),
  },
}));

describe('AuditService', () => {
  let mockRedis: jest.Mocked<Redis>;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup Redis mock with explicit implementations
    mockRedis = {
      ping: jest.fn(() => Promise.resolve('PONG')),
      setex: jest.fn(() => Promise.resolve('OK')),
      get: jest.fn(() => Promise.resolve(null)),
      xadd: jest.fn(() => Promise.resolve('1234567890-0')),
      xgroup: jest.fn(() => Promise.resolve('OK')),
      incr: jest.fn(() => Promise.resolve(1)),
      expire: jest.fn(() => Promise.resolve(1)),
      keys: jest.fn(() => Promise.resolve([])),
    } as any;

    // Reset database mock chains
    mockDb.insert.mockReturnValue(mockDb);
    mockDb.select.mockReturnValue(mockDb);
    mockDb.from.mockReturnValue(mockDb);
    mockDb.where.mockReturnValue(mockDb);
    mockDb.orderBy.mockReturnValue(mockDb);
    mockDb.limit.mockReturnValue(mockDb);
    mockDb.offset.mockReturnValue(mockDb);
    mockDb.groupBy.mockReturnValue(mockDb);
    mockDb.returning.mockImplementation(() => Promise.resolve({ id: 1 }));
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      await expect(auditService.initialize()).resolves.not.toThrow();
      expect(mockRedis.ping).toHaveBeenCalled();
    });

    it('should handle initialization errors', async () => {
      mockRedis.ping.mockImplementation(() => Promise.reject(new Error('Redis connection failed')));

      await expect(auditService.initialize()).rejects.toThrow('Redis connection failed');
    });
  });

  describe('logSecurityEvent', () => {
    const mockSecurityEvent = {
      eventType: 'AUTHENTICATION' as const,
      eventCategory: 'SECURITY' as const,
      userId: 1,
      resourceType: 'USER' as const,
      resourceId: 'user-123',
      action: 'LOGIN',
      result: 'SUCCESS' as const,
      severity: 'MEDIUM' as const,
      context: {
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0',
        sessionId: 'session-123',
      },
    };

    it('should log security event successfully', async () => {
      mockDb.returning.mockImplementation(() => Promise.resolve([{ id: 1, event_type: 'AUTHENTICATION' }]));

      const eventId = await auditService.logSecurityEvent(mockSecurityEvent);

      expect(eventId).toBe('1');
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'audit-events',
        '*',
        'type', 'security',
        'data', expect.any(String),
        'timestamp', expect.any(String),
      );
    });

    it('should calculate risk score correctly', async () => {
      mockDb.returning.mockImplementation(() => Promise.resolve([{ id: 1 }]));

      const highRiskEvent = {
        ...mockSecurityEvent,
        eventType: 'ACCESS_VIOLATION' as const,
        result: 'FAILURE' as const,
        severity: 'CRITICAL' as const,
        complianceFlags: ['SOC2', 'GDPR'],
      };

      await auditService.logSecurityEvent(highRiskEvent);

      expect(mockDb.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          event_type: 'ACCESS_VIOLATION',
          result: 'FAILURE',
          severity: 'CRITICAL',
          risk_score: expect.any(Number),
        }),
      );
    });

    it('should handle logging errors gracefully', async () => {
      mockDb.insert.mockImplementation(() => Promise.reject(new Error('Database error')));

      await expect(auditService.logSecurityEvent(mockSecurityEvent))
        .rejects.toThrow('Database error');
    });

    it('should process compliance flags', async () => {
      mockDb.returning.mockImplementation(() => Promise.resolve([{ id: 1 }]));

      const complianceEvent = {
        ...mockSecurityEvent,
        complianceFlags: ['SOC2', 'GDPR'],
      };

      await auditService.logSecurityEvent(complianceEvent);

      expect(mockRedis.incr).toHaveBeenCalledWith('compliance:SOC2:events');
      expect(mockRedis.incr).toHaveBeenCalledWith('compliance:GDPR:events');
    });
  });

  describe('logSystemActivity', () => {
    const mockSystemActivity = {
      activityType: 'STORAGE_OPERATION' as const,
      activityCategory: 'STORAGE' as const,
      component: 'file-storage-service',
      operation: 'UPLOAD',
      status: 'SUCCESS' as const,
      userId: 1,
      startTime: new Date('2024-01-01T10:00:00Z'),
      endTime: new Date('2024-01-01T10:00:05Z'),
      bytesProcessed: 1024,
      performanceMetrics: {
        responseTime: 150,
        throughput: 500,
      },
    };

    it('should log system activity successfully', async () => {
      mockDb.returning.mockImplementation(() => Promise.resolve([{ id: 1 }]));

      const activityId = await auditService.logSystemActivity(mockSystemActivity);

      expect(activityId).toBe('1');
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'audit-events',
        '*',
        'type', 'system',
        'data', expect.any(String),
        'timestamp', expect.any(String),
      );
    });

    it('should calculate duration correctly', async () => {
      mockDb.returning.mockImplementation(() => Promise.resolve([{ id: 1 }]));

      await auditService.logSystemActivity(mockSystemActivity);

      expect(mockDb.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          duration: 5000, // 5 seconds in milliseconds
        }),
      );
    });

    it('should handle missing end time', async () => {
      mockDb.returning.mockImplementation(() => Promise.resolve([{ id: 1 }]));

      const activityWithoutEndTime = {
        ...mockSystemActivity,
        endTime: undefined,
        duration: 3000,
      };

      await auditService.logSystemActivity(activityWithoutEndTime);

      expect(mockDb.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          duration: 3000,
        }),
      );
    });
  });

  describe('logComplianceAudit', () => {
    const mockComplianceAudit = {
      complianceFramework: 'SOC2' as const,
      requirementId: 'CC6.1',
      requirementDescription: 'Logical access security measures',
      entityType: 'SYSTEM' as const,
      entityId: 'auth-system',
      assessmentType: 'AUTOMATED' as const,
      assessmentResult: 'COMPLIANT' as const,
      confidenceLevel: 'HIGH' as const,
      assessorId: 1,
      assessorType: 'SYSTEM' as const,
      evidenceCollected: {
        controls: ['multi-factor-authentication', 'password-policy'],
      },
      findings: {
        status: 'All controls functioning correctly',
      },
    };

    it('should log compliance audit successfully', async () => {
      mockDb.returning.mockImplementation(() => Promise.resolve([{
        id: 1,
        audit_id: '12345678-1234-1234-1234-123456789012',
      }]));

      const auditId = await auditService.logComplianceAudit(mockComplianceAudit);

      expect(auditId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      expect(mockDb.insert).toHaveBeenCalled();
      expect(mockRedis.xadd).toHaveBeenCalledWith(
        'audit-events',
        '*',
        'type', 'compliance',
        'data', expect.any(String),
        'timestamp', expect.any(String),
      );
    });

    it('should update compliance metrics', async () => {
      mockDb.returning.mockImplementation(() => Promise.resolve([{ id: 1, audit_id: 'test-audit-id' }]));

      await auditService.logComplianceAudit(mockComplianceAudit);

      expect(mockRedis.incr).toHaveBeenCalledWith('compliance:SOC2:COMPLIANT');
      expect(mockRedis.expire).toHaveBeenCalled();
    });

    it('should handle non-compliant assessments', async () => {
      mockDb.returning.mockImplementation(() => Promise.resolve([{ id: 1, audit_id: 'test-audit-id' }]));

      const nonCompliantAudit = {
        ...mockComplianceAudit,
        assessmentResult: 'NON_COMPLIANT' as const,
        nonComplianceReasons: ['Insufficient password complexity'],
        remediationRequired: true,
      };

      await auditService.logComplianceAudit(nonCompliantAudit);

      expect(mockDb.insert).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          assessment_result: 'NON_COMPLIANT',
          remediation_required: true,
        }),
      );
    });
  });

  describe('queryAuditEvents', () => {
    const mockQuery = {
      eventTypes: ['AUTHENTICATION'],
      severities: ['HIGH', 'CRITICAL'],
      startDate: new Date('2024-01-01'),
      endDate: new Date('2024-01-31'),
      limit: 10,
      offset: 0,
      sortBy: 'eventTime' as const,
      sortOrder: 'desc' as const,
    };

    it('should query audit events successfully', async () => {
      const mockEvents = [
        { id: 1, event_type: 'AUTHENTICATION', severity: 'HIGH' },
        { id: 2, event_type: 'AUTHENTICATION', severity: 'CRITICAL' },
      ];

      mockDb.select.mockReturnValue(mockDb);
      mockDb.from.mockReturnValue(mockDb);
      mockDb.where.mockReturnValue(mockDb);
      mockDb.orderBy.mockReturnValue(mockDb);
      mockDb.limit.mockReturnValue(mockDb);
      mockDb.offset.mockImplementation(() => Promise.resolve(mockEvents));

      // Mock count query
      mockDb.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => Promise.resolve([{ count: 2 }])),
        }),
      });

      const result = await auditService.queryAuditEvents(mockQuery);

      expect(result.events).toHaveLength(2);
      expect(result.totalCount).toBe(2);
      expect(result.hasMore).toBe(false);
    });

    it('should handle empty results', async () => {
      mockDb.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => Promise.resolve([{ count: 0 }])),
        }),
      });

      mockDb.offset.mockImplementation(() => Promise.resolve([]));

      const result = await auditService.queryAuditEvents(mockQuery);

      expect(result.events).toHaveLength(0);
      expect(result.totalCount).toBe(0);
      expect(result.hasMore).toBe(false);
    });

    it('should apply all filters correctly', async () => {
      const complexQuery = {
        eventTypes: ['AUTHENTICATION', 'AUTHORIZATION'],
        categories: ['SECURITY'],
        severities: ['HIGH', 'CRITICAL'],
        results: ['SUCCESS', 'FAILURE'],
        userIds: [1, 2, 3],
        fileIds: ['file-1', 'file-2'],
        startDate: new Date('2024-01-01'),
        endDate: new Date('2024-01-31'),
      };

      mockDb.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => Promise.resolve([{ count: 0 }])),
        }),
      });

      mockDb.offset.mockImplementation(() => Promise.resolve([]));

      await auditService.queryAuditEvents(complexQuery);

      // Verify that database query methods were called
      expect(mockDb.select).toHaveBeenCalled();
      expect(mockDb.from).toHaveBeenCalled();
      expect(mockDb.where).toHaveBeenCalled();
    });
  });

  describe('getAuditStatistics', () => {
    it('should generate audit statistics successfully', async () => {
      // Mock Redis cache miss
      mockRedis.get.mockImplementation(() => Promise.resolve(null));

      // Mock database queries
      const mockBasicStats = {
        totalEvents: 100,
        avgRiskScore: 45.5,
        criticalCount: 5,
        failureCount: 10,
      };

      const mockEventsByType = [
        { eventType: 'AUTHENTICATION', count: 50 },
        { eventType: 'AUTHORIZATION', count: 30 },
      ];

      const mockEventsByCategory = [
        { eventCategory: 'SECURITY', count: 60 },
        { eventCategory: 'SYSTEM', count: 40 },
      ];

      // Setup database mock responses
      mockDb.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => Promise.resolve([mockBasicStats])),
        }),
      });

      mockDb.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            groupBy: jest.fn().mockImplementation(() => Promise.resolve(mockEventsByType)),
          }),
        }),
      });

      mockDb.select.mockReturnValueOnce({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            groupBy: jest.fn().mockImplementation(() => Promise.resolve(mockEventsByCategory)),
          }),
        }),
      });

      // Mock other required queries
      mockDb.select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            groupBy: jest.fn().mockReturnValue({
              orderBy: jest.fn().mockReturnValue({
                limit: jest.fn().mockImplementation(() => Promise.resolve([])),
              }),
            }),
          }),
        }),
      });

      // Mock compliance score calculation
      mockRedis.get.mockImplementation((key) => {
        if (key.includes('compliance:SOC2:COMPLIANT')) return Promise.resolve('8');
        if (key.includes('compliance:SOC2:NON_COMPLIANT')) return Promise.resolve('2');
        return Promise.resolve('0');
      });

      const statistics = await auditService.getAuditStatistics();

      expect(statistics.totalEvents).toBe(100);
      expect(statistics.riskScore).toBe(45.5);
      expect(statistics.eventsByType).toEqual({
        'AUTHENTICATION': 50,
        'AUTHORIZATION': 30,
      });
      expect(statistics.eventsByCategory).toEqual({
        'SECURITY': 60,
        'SYSTEM': 40,
      });
      expect(mockRedis.setex).toHaveBeenCalledWith(
        expect.stringContaining('audit_stats:'),
        expect.any(Number),
        expect.any(String),
      );
    });

    it('should use cached statistics when available', async () => {
      const cachedStats = {
        totalEvents: 100,
        eventsByType: { 'AUTHENTICATION': 50 },
        complianceScore: 85,
        riskScore: 45,
      };

      mockRedis.get.mockImplementation(() => Promise.resolve(JSON.stringify(cachedStats)));

      const statistics = await auditService.getAuditStatistics();

      expect(statistics).toEqual(cachedStats);
      expect(mockDb.select).not.toHaveBeenCalled();
    });

    it('should handle time range filtering', async () => {
      const timeRange = {
        start: new Date('2024-01-01'),
        end: new Date('2024-01-31'),
      };

      mockRedis.get.mockImplementation(() => Promise.resolve(null));

      // Mock minimal database responses
      mockDb.select.mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockImplementation(() => Promise.resolve([])),
        }),
      });

      await auditService.getAuditStatistics(timeRange);

      expect(mockRedis.get).toHaveBeenCalledWith(
        expect.stringContaining(`${timeRange.start.getTime()}_${timeRange.end.getTime()}`),
      );
    });
  });

  describe('generateAuditReport', () => {
    const mockReportRequest = {
      reportType: 'SECURITY' as const,
      reportCategory: 'MONTHLY' as const,
      title: 'Monthly Security Report',
      description: 'Comprehensive security audit for January 2024',
      generatedBy: 1,
      periodStart: new Date('2024-01-01'),
      periodEnd: new Date('2024-01-31'),
      format: 'JSON' as const,
      parameters: { includeDetails: true },
    };

    it('should generate audit report successfully', async () => {
      // Mock statistics for report generation
      const mockStats = {
        totalEvents: 100,
        eventsByType: { 'AUTHENTICATION': 50 },
        complianceScore: 85,
        riskScore: 45,
        alertCount: 5,
        recentCriticalEvents: [],
      };

      // Mock getAuditStatistics
      jest.spyOn(auditService, 'getAuditStatistics').mockImplementation(() => Promise.resolve(mockStats as any));

      mockDb.returning.mockImplementation(() => Promise.resolve([{
        id: 1,
        report_id: '12345678-1234-1234-1234-123456789012',
        title: 'Monthly Security Report',
        status: 'COMPLETED',
      }]));

      const report = await auditService.generateAuditReport(mockReportRequest);

      expect(report.title).toBe('Monthly Security Report');
      expect(report.status).toBe('COMPLETED');
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should generate different report types', async () => {
      const complianceReport = {
        ...mockReportRequest,
        reportType: 'COMPLIANCE' as const,
        title: 'Compliance Assessment Report',
      };

      jest.spyOn(auditService, 'getAuditStatistics').mockImplementation(() => Promise.resolve({} as any));
      mockDb.returning.mockImplementation(() => Promise.resolve([{
        id: 1,
        report_id: 'test-id',
        title: 'Compliance Assessment Report',
      }]));

      const report = await auditService.generateAuditReport(complianceReport);

      expect(report.title).toBe('Compliance Assessment Report');
    });

    it('should handle report generation errors', async () => {
      jest.spyOn(auditService, 'getAuditStatistics').mockImplementation(() => Promise.reject(new Error('Stats error')));

      await expect(auditService.generateAuditReport(mockReportRequest))
        .rejects.toThrow('Stats error');
    });
  });

  describe('subscribeToAlerts', () => {
    it('should allow subscribing to alerts', () => {
      const mockCallback = jest.fn();

      const unsubscribe = auditService.subscribeToAlerts(mockCallback);

      expect(typeof unsubscribe).toBe('function');

      // Test unsubscribe
      unsubscribe();
    });

    it('should handle multiple subscribers', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      const unsubscribe1 = auditService.subscribeToAlerts(callback1);
      const unsubscribe2 = auditService.subscribeToAlerts(callback2);

      expect(typeof unsubscribe1).toBe('function');
      expect(typeof unsubscribe2).toBe('function');

      unsubscribe1();
      unsubscribe2();
    });
  });

  describe('error handling', () => {
    it('should handle Redis connection errors gracefully', async () => {
      mockRedis.ping.mockImplementation(() => Promise.reject(new Error('Redis unavailable')));

      await expect(auditService.initialize()).rejects.toThrow('Redis unavailable');
    });

    it('should handle database errors gracefully', async () => {
      mockDb.insert.mockImplementation(() => Promise.reject(new Error('Database connection lost')));

      const mockEvent = {
        eventType: 'AUTHENTICATION' as const,
        eventCategory: 'SECURITY' as const,
        resourceType: 'USER' as const,
        resourceId: 'test',
        action: 'LOGIN',
        result: 'SUCCESS' as const,
      };

      await expect(auditService.logSecurityEvent(mockEvent))
        .rejects.toThrow('Database connection lost');
    });

    it('should continue operation when streaming fails', async () => {
      mockRedis.xadd.mockImplementation(() => Promise.reject(new Error('Stream error')));
      mockDb.returning.mockImplementation(() => Promise.resolve([{ id: 1 }]));

      const mockEvent = {
        eventType: 'AUTHENTICATION' as const,
        eventCategory: 'SECURITY' as const,
        resourceType: 'USER' as const,
        resourceId: 'test',
        action: 'LOGIN',
        result: 'SUCCESS' as const,
      };

      // Should not throw despite streaming error
      await expect(auditService.logSecurityEvent(mockEvent)).resolves.toBe('1');
    });
  });
});
