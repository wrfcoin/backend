/**
 * Unit tests for Device Service
 * Tests device fingerprinting, trust management, and security analysis
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { deviceService } from '../../services/device-service.js';
import type {
  DeviceAlert,
  ParsedDeviceInfo,
} from '../../services/device-service.js';

// Mock dependencies
jest.mock('drizzle-orm/postgres-js');
jest.mock('postgres');
jest.mock('ua-parser-js');

// Mock drizzle
jest.mock('drizzle-orm/postgres-js', () => {
  const { createDrizzleChainMock } = require('../support/drizzle-chain-mock.cjs');
  const { db, resetResults } = createDrizzleChainMock(jest);
  return { drizzle: jest.fn(() => db), __db: db, __reset: resetResults };
});
type AnyMock = jest.Mock<(...args: any[]) => any>;
const drizzleMock = jest.requireMock('drizzle-orm/postgres-js') as {
  __db: Record<string, AnyMock>;
  __reset: () => void;
};
const mockDb = drizzleMock.__db;

// Mock UAParser
jest.mock('ua-parser-js', () => {
  const parser = {
    setUA: jest.fn<() => any>().mockReturnThis(),
    getResult: jest.fn<() => any>(),
  };
  return { UAParser: jest.fn(() => parser), __parser: parser };
});
const mockUAParser = (
  jest.requireMock('ua-parser-js') as { __parser: Record<string, AnyMock> }
).__parser;

describe('DeviceService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    drizzleMock.__reset();

    // Default mock implementations
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnThis();
    mockDb.orderBy.mockReturnThis();
    mockDb.insert.mockReturnThis();
    mockDb.values.mockReturnThis();
    mockDb.returning.mockReturnThis();
    mockDb.update.mockReturnThis();
    mockDb.set.mockReturnThis();
    mockDb.delete.mockReturnThis();

    // Default UA parser mock
    mockUAParser.getResult.mockReturnValue({
      ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      browser: { name: 'Chrome', version: '91.0.4472.124' },
      os: { name: 'Windows', version: '10' },
      device: { type: undefined, vendor: undefined, model: undefined },
    });
  });

  describe('parseDeviceInfo', () => {
    it('should parse desktop browser correctly', () => {
      const userAgent =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36';
      const deviceFingerprint = 'desktop_chrome_windows';

      mockUAParser.getResult.mockReturnValue({
        ua: userAgent,
        browser: { name: 'Chrome', version: '91.0.4472.124' },
        os: { name: 'Windows', version: '10' },
        device: { type: undefined },
      });

      const result = deviceService.parseDeviceInfo(
        userAgent,
        deviceFingerprint
      );

      expect(result).toEqual({
        fingerprint: deviceFingerprint,
        deviceName: 'Chrome on Windows',
        deviceType: 'desktop',
        browser: 'Chrome 91.0.4472.124',
        browserVersion: '91.0.4472.124',
        operatingSystem: 'Windows 10',
        osVersion: '10',
      });
    });

    it('should parse mobile device correctly', () => {
      const userAgent =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1';
      const deviceFingerprint = 'mobile_safari_ios';

      mockUAParser.getResult.mockReturnValue({
        ua: userAgent,
        browser: { name: 'Mobile Safari', version: '14.1.1' },
        os: { name: 'iOS', version: '14.6' },
        device: { type: 'mobile', vendor: 'Apple', model: 'iPhone' },
      });

      const result = deviceService.parseDeviceInfo(
        userAgent,
        deviceFingerprint
      );

      expect(result).toEqual({
        fingerprint: deviceFingerprint,
        deviceName: 'Apple iPhone',
        deviceType: 'mobile',
        browser: 'Mobile Safari 14.1.1',
        browserVersion: '14.1.1',
        operatingSystem: 'iOS 14.6',
        osVersion: '14.6',
      });
    });

    it('should parse tablet device correctly', () => {
      const userAgent =
        'Mozilla/5.0 (iPad; CPU OS 14_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.1.1 Mobile/15E148 Safari/604.1';

      mockUAParser.getResult.mockReturnValue({
        ua: userAgent,
        browser: { name: 'Mobile Safari', version: '14.1.1' },
        os: { name: 'iOS', version: '14.6' },
        device: { type: 'tablet', vendor: 'Apple', model: 'iPad' },
      });

      const result = deviceService.parseDeviceInfo(userAgent);

      expect(result.deviceType).toBe('tablet');
      expect(result.deviceName).toBe('Apple iPad');
    });

    it('should handle unknown devices gracefully', () => {
      const userAgent = 'Unknown/1.0';

      mockUAParser.getResult.mockReturnValue({
        ua: userAgent,
        browser: { name: undefined, version: undefined },
        os: { name: undefined, version: undefined },
        device: { type: undefined, vendor: undefined, model: undefined },
      });

      const result = deviceService.parseDeviceInfo(userAgent);

      expect(result.deviceName).toBe('Unknown Browser on Unknown OS');
      expect(result.deviceType).toBe('desktop');
      expect(result.browser).toBe('Unknown');
      expect(result.operatingSystem).toBe('Unknown');
    });

    it('should handle missing user agent', () => {
      const result = deviceService.parseDeviceInfo('');

      expect(result.deviceName).toBe('Chrome on Windows');
      expect(result.deviceType).toBe('desktop');
    });

    it('should use device fingerprint when provided', () => {
      const userAgent = 'Mozilla/5.0...';
      const deviceFingerprint = 'custom_fingerprint_123';

      const result = deviceService.parseDeviceInfo(
        userAgent,
        deviceFingerprint
      );

      expect(result.fingerprint).toBe(deviceFingerprint);
    });
  });

  describe('analyzeDevice', () => {
    it('should analyze low-risk known device', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'known_device',
        deviceName: 'Chrome on Windows',
        deviceType: 'desktop',
        browser: 'Chrome 91.0.4472.124',
        browserVersion: '91.0.4472.124',
        operatingSystem: 'Windows 10',
        osVersion: '10',
      };
      const ipAddress = '192.168.1.1';

      // Mock known device
      mockDb.select.mockResolvedValueOnce([
        {
          id: 1,
          fingerprint: 'known_device',
          lastUsed: new Date(),
        },
      ]);

      // Mock no recent suspicious activity
      mockDb.select.mockResolvedValueOnce([]);

      const result = await deviceService.analyzeDevice(
        userId,
        deviceInfo,
        ipAddress
      );

      expect(result.riskLevel).toBe('low');
      expect(result.isNewDevice).toBe(false);
      expect(result.reasons).toHaveLength(0);
    });

    it('should analyze an unknown device as medium risk', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'suspicious_device',
        deviceName: 'Unknown Browser',
        deviceType: 'unknown',
        browser: 'Unknown Browser',
        browserVersion: '',
        operatingSystem: 'Unknown OS',
        osVersion: '',
      };
      const ipAddress = '10.0.0.1'; // Suspicious IP

      // Mock unknown device
      mockDb.select.mockResolvedValueOnce([]);

      // Mock recent failed attempts from this IP
      mockDb.select.mockResolvedValueOnce([
        { id: 1, ipAddress: '10.0.0.1', createdAt: new Date() },
        { id: 2, ipAddress: '10.0.0.1', createdAt: new Date() },
      ]);

      const result = await deviceService.analyzeDevice(
        userId,
        deviceInfo,
        ipAddress
      );

      expect(result.riskLevel).toBe('medium');
      expect(result.isNewDevice).toBe(true);
      expect(result.isSuspicious).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('should detect suspicious IP patterns', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'test_device',
        deviceName: 'Chrome on Windows',
        deviceType: 'desktop',
        browser: 'Chrome 91.0.4472.124',
        browserVersion: '91.0.4472.124',
        operatingSystem: 'Windows 10',
        osVersion: '10',
      };
      const ipAddress = '192.168.1.100';

      // Mock device not found
      mockDb.select.mockResolvedValueOnce([]);

      // Mock multiple recent attempts from different IPs (user account compromise indicator)
      mockDb.select.mockResolvedValueOnce([
        { id: 1, ipAddress: '192.168.1.1', createdAt: new Date() },
        { id: 2, ipAddress: '10.0.0.1', createdAt: new Date() },
        { id: 3, ipAddress: '172.16.0.1', createdAt: new Date() },
      ]);

      const result = await deviceService.analyzeDevice(
        userId,
        deviceInfo,
        ipAddress
      );

      expect(result.riskLevel).toBe('medium');
      expect(result.isNewDevice).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('should analyze medium-risk scenarios', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'new_browser',
        deviceName: 'Firefox on Linux',
        deviceType: 'desktop',
        browser: 'Firefox 89.0',
        browserVersion: '89.0',
        operatingSystem: 'Linux',
        osVersion: '',
      };
      const ipAddress = '192.168.1.1';

      // Mock no existing device
      mockDb.select.mockResolvedValueOnce([]);

      // Mock some but not excessive recent attempts
      mockDb.select.mockResolvedValueOnce([
        { id: 1, ipAddress: '192.168.1.1', createdAt: new Date() },
      ]);

      const result = await deviceService.analyzeDevice(
        userId,
        deviceInfo,
        ipAddress
      );

      expect(result.riskLevel).toBe('medium');
      expect(result.isNewDevice).toBe(true);
      expect(result.reasons.length).toBeGreaterThan(0);
    });

    it('should propagate device analysis database errors', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'test_device',
        deviceName: 'Chrome on Windows',
        deviceType: 'desktop',
        browser: 'Chrome 91.0.4472.124',
        browserVersion: '91.0.4472.124',
        operatingSystem: 'Windows 10',
        osVersion: '10',
      };

      mockDb.select.mockRejectedValueOnce(new Error('Database error'));

      await expect(
        deviceService.analyzeDevice(userId, deviceInfo, '192.168.1.1')
      ).rejects.toThrow('Database error');
    });
  });

  describe('addTrustedDevice', () => {
    it('should add device as trusted', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'trusted_device',
        deviceName: 'Chrome on Windows',
        deviceType: 'desktop',
        browser: 'Chrome 91.0.4472.124',
        browserVersion: '91.0.4472.124',
        operatingSystem: 'Windows 10',
        osVersion: '10',
      };
      const ipAddress = '192.168.1.1';

      mockDb.insert.mockResolvedValueOnce([
        {
          id: 1,
          userId: 1,
          deviceFingerprint: 'trusted_device',
        },
      ]);

      await deviceService.addTrustedDevice(userId, deviceInfo, ipAddress);

      expect(mockDb.insert).toHaveBeenCalledWith(expect.any(Object));
    });

    it('should store the requested expiry for a trusted device', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'new_device',
        deviceName: 'New Device',
        deviceType: 'mobile',
        browser: 'Mobile Safari',
        browserVersion: '',
        operatingSystem: 'iOS',
        osVersion: '',
      };

      mockDb.insert.mockResolvedValueOnce([{ id: 11 }]);

      await deviceService.addTrustedDevice(
        userId,
        deviceInfo,
        '192.168.1.1',
        undefined,
        7
      );

      expect(mockDb.values).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          userId,
          deviceFingerprint: 'new_device',
          expiresAt: expect.any(Date),
        })
      );
    });

    it('should preserve the device fingerprint when storing trust', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'existing_device',
        deviceName: 'Chrome on Windows',
        deviceType: 'desktop',
        browser: 'Test Browser',
        browserVersion: '1.0',
        operatingSystem: 'Test OS',
        osVersion: '1.0',
      };

      mockDb.insert.mockResolvedValueOnce([{ id: 1 }]);

      await deviceService.addTrustedDevice(userId, deviceInfo, '192.168.1.1');

      expect(mockDb.values).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ deviceFingerprint: 'existing_device' })
      );
    });
  });

  // Note: isTrustedDevice method doesn't exist in current service implementation
  // These tests would need to be updated to test actual available methods

  // Note: getTrustedDevices method doesn't exist in current service implementation
  // These tests would need to be updated to test actual available methods

  describe('removeTrustedDevice', () => {
    it('should remove trusted device', async () => {
      const userId = 1;
      const deviceId = 1;

      mockDb.select.mockResolvedValueOnce([{ id: 1 }]);
      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);

      const result = await deviceService.removeTrustedDevice(userId, deviceId);

      expect(result).toBe(true);
      expect(mockDb.set).toHaveBeenCalledWith({ isActive: false });
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should return false if device not found', async () => {
      const userId = 1;
      const deviceId = 999;

      mockDb.select.mockResolvedValueOnce([]);

      const result = await deviceService.removeTrustedDevice(userId, deviceId);

      expect(result).toBe(false);
    });
  });

  describe('cleanupExpiredDevices', () => {
    it('should remove expired trusted devices', async () => {
      mockDb.update.mockResolvedValueOnce(undefined);

      await deviceService.cleanupExpiredDevices();

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith({ isActive: false });
    });
  });

  describe('getDeviceStats', () => {
    it('should return device statistics for user', async () => {
      const userId = 1;

      const mockStats = [
        ...Array(3).fill({ deviceType: 'desktop', browser: 'Chrome 91' }),
        ...Array(2).fill({ deviceType: 'mobile', browser: 'Safari 14' }),
        { deviceType: 'tablet', browser: 'Safari 14' },
      ];

      mockDb.select.mockResolvedValueOnce(mockStats);

      const result = await deviceService.getDeviceStats(userId);

      expect(result).toHaveProperty('totalTrusted');
      expect(result).toHaveProperty('deviceTypes');
      expect(result).toHaveProperty('activeDevices');
      expect(result.deviceTypes).toEqual({
        desktop: 3,
        mobile: 2,
        tablet: 1,
      });
    });
  });

  describe('Device Fingerprint Generation', () => {
    it('should generate consistent fingerprints for same device', () => {
      const deviceInfo1 = {
        userAgent: 'Mozilla/5.0 Chrome/91',
        screenResolution: '1920x1080',
        platform: 'Win32',
      };

      const deviceInfo2 = { ...deviceInfo1 };

      const fingerprint1 = (deviceService as any).generateDeviceFingerprint(
        deviceInfo1
      );
      const fingerprint2 = (deviceService as any).generateDeviceFingerprint(
        deviceInfo2
      );

      expect(fingerprint1).toBe(fingerprint2);
    });

    it('should generate different fingerprints for different devices', () => {
      const deviceInfo1 = {
        userAgent: 'Mozilla/5.0 Chrome/91',
        screenResolution: '1920x1080',
        platform: 'Win32',
      };

      const deviceInfo2 = {
        userAgent: 'Mozilla/5.0 Safari/14',
        screenResolution: '390x844',
        platform: 'iPhone',
      };

      const fingerprint1 = (deviceService as any).generateDeviceFingerprint(
        deviceInfo1
      );
      const fingerprint2 = (deviceService as any).generateDeviceFingerprint(
        deviceInfo2
      );

      expect(fingerprint1).not.toBe(fingerprint2);
    });
  });

  describe('Security Risk Assessment', () => {
    it('should escalate risk for suspicious browser patterns', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'test_device',
        deviceName: 'curl client',
        deviceType: 'unknown',
        browser: 'curl/8.0',
        operatingSystem: 'Linux',
        browserVersion: '1.0',
        osVersion: '1.0',
      };

      mockDb.select.mockResolvedValue([]);

      const result = await deviceService.analyzeDevice(
        userId,
        deviceInfo,
        '192.168.1.1'
      );

      expect(result.riskLevel).toBe('high');
      expect(result.reasons).toContain('Suspicious user agent detected');
    });

    it('should consider geographic factors', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'test_device',
        deviceName: 'Chrome on Windows',
        deviceType: 'desktop',
        browser: 'Chrome 91.0.4472.124',
        operatingSystem: 'Windows 10',
        browserVersion: '1.0',
        osVersion: '1.0',
      };

      // Mock recent access from different geographic location (simulated via IP)
      mockDb.select.mockResolvedValueOnce([]); // No known devices
      mockDb.select.mockResolvedValueOnce([
        { id: 1, ipAddress: '192.168.1.1', createdAt: new Date() }, // Local IP
      ]);

      // Current access from different IP range (simulating different location)
      const result = await deviceService.analyzeDevice(
        userId,
        deviceInfo,
        '10.0.0.1'
      );

      expect(result.riskLevel).toBe('medium');
    });

    it('should assess time-based patterns', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'test_device',
        deviceName: 'Chrome on Windows',
        deviceType: 'desktop',
        browser: 'Chrome 91.0.4472.124',
        operatingSystem: 'Windows 10',
        browserVersion: '1.0',
        osVersion: '1.0',
      };

      // Mock very recent attempts (potential brute force)
      const recentAttempts = Array(5)
        .fill(null)
        .map((_, i) => ({
          id: i + 1,
          ipAddress: '192.168.1.1',
          createdAt: new Date(Date.now() - i * 1000), // Every second
        }));

      mockDb.select.mockResolvedValueOnce([]);
      mockDb.select.mockResolvedValueOnce(recentAttempts);

      const result = await deviceService.analyzeDevice(
        userId,
        deviceInfo,
        '192.168.1.1'
      );

      expect(result.riskLevel).toBe('medium');
      expect(result.reasons).toContain('Multiple new devices in short time');
    });
  });

  describe('Error Handling', () => {
    it('should propagate UA parser errors', () => {
      mockUAParser.getResult.mockImplementationOnce(() => {
        throw new Error('UA parsing failed');
      });

      expect(() => deviceService.parseDeviceInfo('invalid user agent')).toThrow(
        'UA parsing failed'
      );
    });

    it('should handle database errors in device analysis', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'test_device',
        deviceName: 'Chrome on Windows',
        deviceType: 'desktop',
        browser: 'Test Browser',
        browserVersion: '1.0',
        operatingSystem: 'Test OS',
        osVersion: '1.0',
      };

      mockDb.select.mockRejectedValueOnce(new Error('Database error'));

      await expect(
        deviceService.analyzeDevice(userId, deviceInfo, '192.168.1.1')
      ).rejects.toThrow('Database error');
    });

    it('should handle trusted device storage errors', async () => {
      const userId = 1;
      const deviceInfo: ParsedDeviceInfo = {
        fingerprint: 'device123',
        deviceName: 'Chrome on Windows',
        deviceType: 'desktop',
        browser: 'Test Browser',
        browserVersion: '1.0',
        operatingSystem: 'Test OS',
        osVersion: '1.0',
      };

      mockDb.insert.mockRejectedValueOnce(new Error('Insert failed'));

      await expect(
        deviceService.addTrustedDevice(userId, deviceInfo, '192.168.1.1')
      ).rejects.toThrow('Insert failed');
    });
  });
});
