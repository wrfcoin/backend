/**
 * Audit Monitoring Service Tests
 * Tests for real-time monitoring, alerting, and automated response functionality
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  jest,
} from '@jest/globals';
import { auditMonitoringService } from '../../server/services/audit-monitoring-service.js';
import Redis from 'ioredis';

// Mock Redis
jest.mock('ioredis');

// Mock database.
//
// #992: the mock object is built INSIDE the factory and pulled back out with
// `jest.requireMock`. Declaring `const mockDb = {...}` above and closing over it
// fails: `jest.mock` is hoisted above the const, the static import of the module
// under test is hoisted above that, and the factory therefore runs while `mockDb`
// is still in its temporal dead zone —
// `ReferenceError: Cannot access 'mockDb' before initialization`.
// #992 (second defect): the target was `../../server/db.js`, which the service
// under test does not import — it imports `../../database/db.js`. So even once
// the factory ran, the REAL postgres client was used: the failures surfaced as
// `PostgresJsPreparedQuery` in the stack, and the suite HUNG on the live
// connection rather than failing.
jest.mock('../../database/db.js', () => ({
  db: {
    select: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
    groupBy: jest.fn(),
  },
}));
const { db: mockDb } = jest.requireMock('../../database/db.js') as {
  db: Record<string, jest.Mock<(...args: any[]) => any>>;
};

// Mock logger
jest.mock('../../utils/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

// Mock audit service (same #992 hoisting fix as above).
jest.mock('../../server/services/audit-service', () => ({
  auditService: {
    subscribeToAlerts: jest.fn(),
    getAuditStatistics: jest.fn(),
  },
}));
const { auditService: mockAuditService } = jest.requireMock(
  '../../server/services/audit-service'
) as { auditService: Record<string, jest.Mock<(...args: any[]) => any>> };

describe('AuditMonitoringService', () => {
  let mockRedis: any;

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Setup Redis mock with explicit typing
    mockRedis = {
      ping: jest.fn(() => Promise.resolve('PONG')),
      setex: jest.fn(() => Promise.resolve('OK')),
      get: jest.fn(() => Promise.resolve(null)),
      del: jest.fn(() => Promise.resolve(1)),
      keys: jest.fn(() => Promise.resolve([])),
      hset: jest.fn(() => Promise.resolve(1)),
    };

    // Reset database mock chains
    mockDb.select.mockReturnValue(mockDb);
    mockDb.from.mockReturnValue(mockDb);
    mockDb.where.mockReturnValue(mockDb);
    mockDb.orderBy.mockReturnValue(mockDb);
    mockDb.limit.mockReturnValue(mockDb);
    mockDb.groupBy.mockReturnValue(mockDb);

    // Setup audit service mocks with explicit implementations
    mockAuditService.subscribeToAlerts.mockImplementation(() => () => {});
    mockAuditService.getAuditStatistics.mockImplementation(() =>
      Promise.resolve({
        totalEvents: 100,
        complianceScore: 85,
        riskScore: 45,
        alertCount: 5,
      })
    );
  });

  afterEach(() => {
    auditMonitoringService.stopMonitoring();
    jest.restoreAllMocks();
  });

  describe('initialization', () => {
    it('should initialize successfully', async () => {
      await expect(auditMonitoringService.initialize()).resolves.not.toThrow();
      expect(mockRedis.ping).toHaveBeenCalled();
      expect(mockAuditService.subscribeToAlerts).toHaveBeenCalled();
    });

    it('should handle initialization errors', async () => {
      mockRedis.ping.mockImplementation(() =>
        Promise.reject(new Error('Redis connection failed'))
      );

      await expect(auditMonitoringService.initialize()).rejects.toThrow(
        'Redis connection failed'
      );
    });

    it('should load existing alerts during initialization', async () => {
      const mockAlert = {
        id: 'alert-1',
        type: 'SECURITY',
        severity: 'HIGH',
        resolved: false,
      };

      mockRedis.keys.mockImplementation(() =>
        Promise.resolve(['alert:alert-1'])
      );
      mockRedis.get.mockImplementation(() =>
        Promise.resolve(JSON.stringify(mockAlert))
      );

      await auditMonitoringService.initialize();

      expect(mockRedis.keys).toHaveBeenCalledWith('alert:*');
      expect(mockRedis.get).toHaveBeenCalledWith('alert:alert-1');
    });
  });

  describe('monitoring lifecycle', () => {
    beforeEach(async () => {
      await auditMonitoringService.initialize();
    });

    it('should start monitoring successfully', async () => {
      await expect(
        auditMonitoringService.startMonitoring()
      ).resolves.not.toThrow();

      const status = auditMonitoringService.getMonitoringStatus();
      expect(status.isRunning).toBe(true);
    });

    it('should prevent starting monitoring twice', async () => {
      await auditMonitoringService.startMonitoring();

      // Second call should not throw but should warn
      await auditMonitoringService.startMonitoring();

      const status = auditMonitoringService.getMonitoringStatus();
      expect(status.isRunning).toBe(true);
    });

    it('should stop monitoring', async () => {
      await auditMonitoringService.startMonitoring();

      auditMonitoringService.stopMonitoring();

      const status = auditMonitoringService.getMonitoringStatus();
      expect(status.isRunning).toBe(false);
    });
  });

  describe('monitoring metrics', () => {
    beforeEach(async () => {
      await auditMonitoringService.initialize();
    });

    it('should get monitoring metrics successfully', async () => {
      // Mock database queries for metrics with explicit implementations
      let callCount = 0;
      mockDb.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([
            {
              totalEvents: 50,
              criticalEvents: 5,
              failedLogins: 10,
              avgRiskScore: 45.5,
            },
          ]);
        } else if (callCount === 2) {
          return Promise.resolve([
            {
              totalActivities: 100,
              errorActivities: 5,
            },
          ]);
        } else {
          return Promise.resolve([]);
        }
      });

      const metrics = await auditMonitoringService.getMonitoringMetrics();

      expect(metrics.eventsPerHour).toBe(50);
      expect(metrics.criticalEventsPerHour).toBe(5);
      expect(metrics.failedLoginsPerHour).toBe(10);
      expect(metrics.averageRiskScore).toBe(45.5);
      expect(metrics.systemErrorRate).toBe(0.05); // 5/100
      expect(metrics.systemHealth).toHaveProperty('overall');
    });

    it('should assess system health correctly', async () => {
      // Mock critical situation with explicit implementations
      let callCount = 0;
      mockDb.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([
            {
              totalEvents: 50,
              criticalEvents: 25, // High critical events
              failedLogins: 10,
              avgRiskScore: 85,
            },
          ]);
        } else if (callCount === 2) {
          return Promise.resolve([
            {
              totalActivities: 100,
              errorActivities: 15, // High error rate
            },
          ]);
        } else {
          return Promise.resolve([]);
        }
      });

      mockAuditService.getAuditStatistics.mockImplementation(() =>
        Promise.resolve({
          complianceScore: 50, // Low compliance
        })
      );

      const metrics = await auditMonitoringService.getMonitoringMetrics();

      expect(metrics.systemHealth.overall).toBe('CRITICAL');
      expect(metrics.systemHealth.components.audit).toBe('WARNING');
      expect(metrics.systemHealth.components.system).toBe('WARNING');
      expect(metrics.systemHealth.components.compliance).toBe('WARNING');
    });

    it('should handle metrics calculation errors', async () => {
      mockDb.select.mockImplementation(() =>
        Promise.reject(new Error('Database error'))
      );

      await expect(
        auditMonitoringService.getMonitoringMetrics()
      ).rejects.toThrow('Database error');
    });
  });

  describe('monitoring rules', () => {
    beforeEach(async () => {
      await auditMonitoringService.initialize();
    });

    it('should create monitoring rule successfully', async () => {
      const ruleData = {
        name: 'Test Rule',
        description: 'Test monitoring rule',
        enabled: true,
        eventType: 'AUTHENTICATION',
        conditions: { result: 'FAILURE', count: 5 },
        alertSeverity: 'HIGH' as const,
        actions: ['NOTIFY_ADMIN'],
        cooldownPeriod: 30,
      };

      const ruleId =
        await auditMonitoringService.createMonitoringRule(ruleData);

      expect(ruleId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(mockRedis.hset).toHaveBeenCalledWith(
        'monitoring_rules',
        ruleId,
        expect.any(String)
      );
    });

    it('should handle rule creation errors', async () => {
      mockRedis.hset.mockImplementation(() =>
        Promise.reject(new Error('Redis error'))
      );

      const ruleData = {
        name: 'Test Rule',
        description: 'Test monitoring rule',
        enabled: true,
        eventType: 'AUTHENTICATION',
        conditions: {},
        alertSeverity: 'HIGH' as const,
        actions: ['NOTIFY_ADMIN'],
        cooldownPeriod: 30,
      };

      await expect(
        auditMonitoringService.createMonitoringRule(ruleData)
      ).rejects.toThrow('Redis error');
    });
  });

  describe('alert management', () => {
    beforeEach(async () => {
      await auditMonitoringService.initialize();
    });

    it('should get active alerts', () => {
      const alerts = auditMonitoringService.getActiveAlerts();
      expect(Array.isArray(alerts)).toBe(true);
    });

    it('should get resolved alerts', async () => {
      const mockResolvedAlert = {
        id: 'alert-1',
        type: 'SECURITY',
        resolved: true,
        resolvedAt: new Date(),
      };

      mockRedis.keys.mockImplementation(() =>
        Promise.resolve(['resolved_alert:alert-1'])
      );
      mockRedis.get.mockImplementation(() =>
        Promise.resolve(JSON.stringify(mockResolvedAlert))
      );

      const resolvedAlerts = await auditMonitoringService.getResolvedAlerts();

      expect(resolvedAlerts).toHaveLength(1);
      expect(resolvedAlerts[0].id).toBe('alert-1');
      expect(resolvedAlerts[0].resolved).toBe(true);
    });

    it('should acknowledge alert successfully', async () => {
      const mockAlert = {
        id: 'alert-1',
        type: 'SECURITY',
        severity: 'HIGH',
        acknowledged: false,
        resolved: false,
      };

      // Add alert to internal map (simulating active alert)
      const service = auditMonitoringService as any;
      service.activeAlerts.set('alert-1', mockAlert);

      const success = await auditMonitoringService.acknowledgeAlert(
        'alert-1',
        1
      );

      expect(success).toBe(true);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'alert:alert-1',
        expect.any(Number),
        expect.any(String)
      );
    });

    it('should handle acknowledging non-existent alert', async () => {
      const success = await auditMonitoringService.acknowledgeAlert(
        'non-existent',
        1
      );
      expect(success).toBe(false);
    });

    it('should resolve alert successfully', async () => {
      const mockAlert = {
        id: 'alert-1',
        type: 'SECURITY',
        severity: 'HIGH',
        acknowledged: false,
        resolved: false,
      };

      // Add alert to internal map
      const service = auditMonitoringService as any;
      service.activeAlerts.set('alert-1', mockAlert);

      const success = await auditMonitoringService.resolveAlert(
        'alert-1',
        1,
        'Fixed issue'
      );

      expect(success).toBe(true);
      expect(mockRedis.setex).toHaveBeenCalledWith(
        'resolved_alert:alert-1',
        expect.any(Number),
        expect.any(String)
      );
      expect(mockRedis.del).toHaveBeenCalledWith('alert:alert-1');
    });

    it('should handle resolving non-existent alert', async () => {
      const success = await auditMonitoringService.resolveAlert(
        'non-existent',
        1
      );
      expect(success).toBe(false);
    });
  });

  describe('alert subscriptions', () => {
    beforeEach(async () => {
      await auditMonitoringService.initialize();
    });

    it('should allow subscribing to alerts', () => {
      const mockCallback = jest.fn();

      const unsubscribe =
        auditMonitoringService.subscribeToAlerts(mockCallback);

      expect(typeof unsubscribe).toBe('function');

      // Test unsubscribe
      unsubscribe();
    });

    it('should handle multiple subscribers', () => {
      const callback1 = jest.fn();
      const callback2 = jest.fn();

      const unsubscribe1 = auditMonitoringService.subscribeToAlerts(callback1);
      const unsubscribe2 = auditMonitoringService.subscribeToAlerts(callback2);

      expect(typeof unsubscribe1).toBe('function');
      expect(typeof unsubscribe2).toBe('function');

      unsubscribe1();
      unsubscribe2();
    });
  });

  describe('configuration management', () => {
    beforeEach(async () => {
      await auditMonitoringService.initialize();
    });

    it('should update configuration successfully', () => {
      const newConfig = {
        enabled: true,
        checkInterval: 10,
        alertThresholds: {
          criticalEventsPerHour: 20,
          failedLoginsPerHour: 50,
          riskScoreThreshold: 80,
          systemErrorRate: 0.1,
          complianceScore: 90,
        },
      };

      auditMonitoringService.updateConfiguration(newConfig);

      const status = auditMonitoringService.getMonitoringStatus();
      expect(status.config.checkInterval).toBe(10);
      expect(status.config.alertThresholds.criticalEventsPerHour).toBe(20);
    });

    it('should restart monitoring when interval changes', async () => {
      await auditMonitoringService.startMonitoring();

      const newConfig = {
        checkInterval: 15,
      };

      auditMonitoringService.updateConfiguration(newConfig);

      // Should still be running with new interval
      const status = auditMonitoringService.getMonitoringStatus();
      expect(status.isRunning).toBe(true);
      expect(status.config.checkInterval).toBe(15);
    });

    it('should get monitoring status', () => {
      const status = auditMonitoringService.getMonitoringStatus();

      expect(status).toHaveProperty('isRunning');
      expect(status).toHaveProperty('config');
      expect(status).toHaveProperty('activeAlertsCount');
      expect(status).toHaveProperty('monitoringRulesCount');
      expect(typeof status.isRunning).toBe('boolean');
      expect(typeof status.activeAlertsCount).toBe('number');
      expect(typeof status.monitoringRulesCount).toBe('number');
    });
  });

  describe('threshold monitoring', () => {
    beforeEach(async () => {
      await auditMonitoringService.initialize();
    });

    it('should trigger alerts when thresholds are exceeded', async () => {
      // Mock metrics that exceed thresholds with explicit implementations
      let callCount = 0;
      mockDb.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([
            {
              totalEvents: 50,
              criticalEvents: 15, // Exceeds default threshold of 10
              failedLogins: 25, // Exceeds default threshold of 20
              avgRiskScore: 45.5,
            },
          ]);
        } else if (callCount === 2) {
          return Promise.resolve([
            {
              totalActivities: 100,
              errorActivities: 2,
            },
          ]);
        } else {
          return Promise.resolve([]);
        }
      });

      mockAuditService.getAuditStatistics.mockImplementation(() =>
        Promise.resolve({
          complianceScore: 75, // Below default threshold of 80
        })
      );

      // Subscribe to alerts to capture them
      const alertsReceived: any[] = [];
      auditMonitoringService.subscribeToAlerts(alert => {
        alertsReceived.push(alert);
      });

      await auditMonitoringService.startMonitoring();

      // Wait a bit for monitoring to process
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should have triggered multiple alerts
      expect(alertsReceived.length).toBeGreaterThan(0);
    });

    it('should not trigger alerts when thresholds are not exceeded', async () => {
      // Mock normal metrics with explicit implementations
      let callCount = 0;
      mockDb.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve([
            {
              totalEvents: 50,
              criticalEvents: 2, // Below threshold
              failedLogins: 5, // Below threshold
              avgRiskScore: 30,
            },
          ]);
        } else if (callCount === 2) {
          return Promise.resolve([
            {
              totalActivities: 100,
              errorActivities: 1, // Low error rate
            },
          ]);
        } else {
          return Promise.resolve([]);
        }
      });

      mockAuditService.getAuditStatistics.mockImplementation(() =>
        Promise.resolve({
          complianceScore: 90, // Above threshold
        })
      );

      const alertsReceived: any[] = [];
      auditMonitoringService.subscribeToAlerts(alert => {
        alertsReceived.push(alert);
      });

      await auditMonitoringService.startMonitoring();

      // Wait a bit for monitoring to process
      await new Promise(resolve => setTimeout(resolve, 100));

      // Should not have triggered threshold alerts
      expect(alertsReceived.length).toBe(0);
    });
  });

  describe('error handling', () => {
    it('should handle Redis connection errors gracefully', async () => {
      mockRedis.ping.mockImplementation(() =>
        Promise.reject(new Error('Redis unavailable'))
      );

      await expect(auditMonitoringService.initialize()).rejects.toThrow(
        'Redis unavailable'
      );
    });

    it('should handle database errors in metrics calculation', async () => {
      await auditMonitoringService.initialize();

      mockDb.select.mockImplementation(() =>
        Promise.reject(new Error('Database connection lost'))
      );

      await expect(
        auditMonitoringService.getMonitoringMetrics()
      ).rejects.toThrow('Database connection lost');
    });

    it('should handle alert callback errors gracefully', async () => {
      await auditMonitoringService.initialize();

      const faultyCallback = jest.fn().mockImplementation(() => {
        throw new Error('Callback error');
      });

      auditMonitoringService.subscribeToAlerts(faultyCallback);

      // Should not throw when callback fails
      // This would be tested by triggering an alert and ensuring it doesn't crash
    });

    it('should continue monitoring when individual checks fail', async () => {
      await auditMonitoringService.initialize();
      await auditMonitoringService.startMonitoring();

      // Mock a failure in metrics calculation
      let callCount = 0;
      mockDb.select.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Temporary failure');
        }
        return mockDb;
      });

      // Wait for monitoring cycle to complete
      await new Promise(resolve => setTimeout(resolve, 100));

      // Monitoring should still be running
      const status = auditMonitoringService.getMonitoringStatus();
      expect(status.isRunning).toBe(true);
    });
  });

  describe('cleanup operations', () => {
    beforeEach(async () => {
      await auditMonitoringService.initialize();
    });

    it('should clean up expired alerts', async () => {
      const expiredAlert = {
        id: 'expired-alert',
        triggeredAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000), // 40 days ago
        resolved: true,
      };

      // Add expired alert to internal map
      const service = auditMonitoringService as any;
      service.activeAlerts.set('expired-alert', expiredAlert);

      await auditMonitoringService.startMonitoring();

      // Wait for cleanup to run
      await new Promise(resolve => setTimeout(resolve, 100));

      // Alert should be removed from active alerts
      const activeAlerts = auditMonitoringService.getActiveAlerts();
      expect(activeAlerts.find(a => a.id === 'expired-alert')).toBeUndefined();
    });

    it('should not clean up recent resolved alerts', async () => {
      const recentAlert = {
        id: 'recent-alert',
        triggeredAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000), // 1 day ago
        resolved: true,
      };

      // Add recent alert to internal map
      const service = auditMonitoringService as any;
      service.activeAlerts.set('recent-alert', recentAlert);

      await auditMonitoringService.startMonitoring();

      // Wait for cleanup attempt
      await new Promise(resolve => setTimeout(resolve, 100));

      // Recent alert should still be there
      const service2 = auditMonitoringService as any;
      expect(service2.activeAlerts.has('recent-alert')).toBe(true);
    });
  });
});
