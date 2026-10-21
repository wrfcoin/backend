/**
 * Integration tests for MFA API routes
 * Tests complete MFA workflow including TOTP, SMS, and backup codes
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from '@jest/globals';
import type { Application } from 'express';
const request = require('supertest');
const express = require('express');
import mfaRoutes from '../../routes/mfa-routes.js';
import type { MfaService } from '../../services/mfa-service.js';
import type { SmsService } from '../../services/sms-service.js';

// Mock modules
jest.mock('../../services/mfa-service.js', () => {
  const service = {
    generateTotpSetup: jest.fn(),
    enableTotp: jest.fn(),
    verifyTotp: jest.fn(),
    verifyBackupCode: jest.fn(),
    regenerateBackupCodes: jest.fn(),
    getUserMfaSettings: jest.fn(),
    getTrustedDevices: jest.fn(),
    removeTrustedDevice: jest.fn(),
    disableMfa: jest.fn(),
    cleanupExpiredData: jest.fn(),
    checkTrustedDevice: jest.fn(),
    addTrustedDevice: jest.fn(),
    logMfaAttempt: jest.fn(),
    logSecurityEvent: jest.fn(),
  };
  return { mfaService: service, __service: service };
});

jest.mock('../../services/sms-service.js', () => {
  const service = {
    sendVerificationCode: jest.fn(),
    verifyCode: jest.fn(),
    enableSmsForMfa: jest.fn(),
    disableSmsForMfa: jest.fn(),
    getSmsStats: jest.fn(),
    cleanupExpiredCodes: jest.fn(),
    generateVerificationCode: jest.fn(),
    formatSmsMessage: jest.fn(),
    isValidPhoneNumber: jest.fn(),
    maskPhoneNumber: jest.fn(),
    checkRateLimit: jest.fn(),
    logSecurityEvent: jest.fn(),
  };
  return { smsService: service, __service: service };
});

jest.mock('../../middleware/auth.js', () => ({
  authenticateJWT: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../middleware/rbac-middleware.js', () => ({
  requireAdmin: () =>
    (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../utils/logger.js', () => ({
  securityLogger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
  logError: jest.fn(),
}));

jest.mock('drizzle-orm/postgres-js', () => {
  const { createDrizzleChainMock } = require('../support/drizzle-chain-mock.cjs');
  const { db, resetResults } = createDrizzleChainMock(jest);
  return { drizzle: jest.fn(() => db), __db: db, __reset: resetResults };
});

jest.mock('postgres');

type AnyMock = jest.Mock<(...args: any[]) => any>;
const mockMfaService = (
  jest.requireMock('../../services/mfa-service.js') as {
    __service: jest.Mocked<MfaService>;
  }
).__service;
const mockSmsService = (
  jest.requireMock('../../services/sms-service.js') as {
    __service: jest.Mocked<SmsService>;
  }
).__service;
const drizzleMock = jest.requireMock('drizzle-orm/postgres-js') as {
  __db: Record<string, AnyMock>;
  __reset: () => void;
};
const mockDb = drizzleMock.__db;

// Create test app
const createTestApp = (): Application => {
  const app = express();
  app.use(express.json());

  // Mock authentication middleware
  app.use((req, res, next) => {
    (req as any).user = { id: 1, email: 'test@example.com' };
    Object.defineProperty(req, 'ip', {
      value: '192.168.1.1',
      writable: false,
      enumerable: true,
      configurable: true,
    });
    next();
  });

  app.use('/api/mfa', mfaRoutes);

  return app;
};

describe('MFA Routes Integration Tests', () => {
  let app: Application;

  beforeEach(() => {
    jest.clearAllMocks();
    drizzleMock.__reset();
    app = createTestApp();

    // Default database mocks
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnThis();
  });

  describe('POST /api/mfa/setup/totp', () => {
    it('should setup TOTP successfully', async () => {
      const mockSetupResult = {
        secret: 'mock-secret-key',
        qrCodeUrl: 'data:image/png;base64,mockQRCode',
        backupCodes: ['1234567890', '0987654321'],
      };

      mockDb.select.mockResolvedValueOnce([
        { email: 'test@example.com' },
      ] as any);
      mockMfaService.generateTotpSetup.mockResolvedValueOnce(mockSetupResult);

      const response = await request(app)
        .post('/api/mfa/setup/totp')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.qrCodeUrl).toBe(mockSetupResult.qrCodeUrl);
      expect(response.body.data.backupCodes).toEqual(
        mockSetupResult.backupCodes
      );
      expect(mockMfaService.generateTotpSetup).toHaveBeenCalledWith(
        1,
        'test@example.com'
      );
    });

    it('should handle user not found', async () => {
      mockDb.select.mockResolvedValueOnce([] as any);

      const response = await request(app)
        .post('/api/mfa/setup/totp')
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MFA_ERROR');
    });

    it('should handle service errors', async () => {
      mockDb.select.mockResolvedValueOnce([
        { email: 'test@example.com' },
      ] as any);
      mockMfaService.generateTotpSetup.mockRejectedValueOnce(
        new Error('Setup failed')
      );

      const response = await request(app)
        .post('/api/mfa/setup/totp')
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('SETUP_ERROR');
    });
  });

  describe('POST /api/mfa/enable/totp', () => {
    it('should enable TOTP with valid token', async () => {
      mockMfaService.enableTotp.mockResolvedValueOnce(true);

      const response = await request(app)
        .post('/api/mfa/enable/totp')
        .send({ token: '123456' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.message).toBe('TOTP MFA enabled successfully');
      expect(mockMfaService.enableTotp).toHaveBeenCalledWith(1, '123456');
    });

    it('should reject invalid token format', async () => {
      const response = await request(app)
        .post('/api/mfa/enable/totp')
        .send({ token: 'invalid' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MFA_ERROR');
    });

    it('should reject invalid TOTP token', async () => {
      mockMfaService.enableTotp.mockResolvedValueOnce(false);

      const response = await request(app)
        .post('/api/mfa/enable/totp')
        .send({ token: '123456' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MFA_ERROR');
    });
  });

  describe('POST /api/mfa/verify/totp', () => {
    it('should verify TOTP token successfully', async () => {
      const mockVerifyResult = {
        success: true,
        requiresMfa: false,
        trustedDevice: true,
      };

      mockMfaService.verifyTotp.mockResolvedValueOnce(mockVerifyResult);

      const response = await request(app)
        .post('/api/mfa/verify/totp')
        .send({
          token: '123456',
          deviceFingerprint: 'device123',
          trustDevice: true,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.verified).toBe(true);
      expect(response.body.data.trustedDevice).toBe(true);
    });

    it('should handle verification failure', async () => {
      const mockVerifyResult = {
        success: false,
        requiresMfa: true,
        message: 'Invalid token',
      };

      mockMfaService.verifyTotp.mockResolvedValueOnce(mockVerifyResult);

      const response = await request(app)
        .post('/api/mfa/verify/totp')
        .send({ token: '123456' })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MFA_ERROR');
    });
  });

  describe('POST /api/mfa/verify/backup-code', () => {
    it('should verify backup code successfully', async () => {
      const mockVerifyResult = {
        success: true,
        requiresMfa: false,
      };

      mockMfaService.verifyBackupCode.mockResolvedValueOnce(mockVerifyResult);

      const response = await request(app)
        .post('/api/mfa/verify/backup-code')
        .send({ code: '1234567890' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.verified).toBe(true);
    });

    it('should reject invalid backup code format', async () => {
      const response = await request(app)
        .post('/api/mfa/verify/backup-code')
        .send({ code: 'invalid' })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MFA_ERROR');
    });
  });

  describe('POST /api/mfa/backup-codes/regenerate', () => {
    it('should regenerate backup codes', async () => {
      const mockBackupCodes = ['1234567890', '0987654321'];
      mockMfaService.regenerateBackupCodes.mockResolvedValueOnce(
        mockBackupCodes
      );

      const response = await request(app)
        .post('/api/mfa/backup-codes/regenerate')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.backupCodes).toEqual(mockBackupCodes);
    });
  });

  describe('GET /api/mfa/status', () => {
    it('should return MFA status', async () => {
      const mockSettings = {
        id: 1,
        userId: 1,
        mfaEnabled: true,
        totpSecret: 'encrypted-secret',
        smsEnabled: false,
        phoneNumber: null,
        backupCodes: ['code1', 'code2'],
        recoveryEmail: null,
        trustedDevices: null,
        lastBackupCodesGenerated: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const mockTrustedDevices = [
        {
          id: 1,
          userId: 1,
          deviceName: 'Chrome',
          deviceFingerprint: 'fingerprint1',
          deviceType: 'desktop',
          browser: 'Chrome',
          operatingSystem: 'Windows',
          ipAddress: '192.168.1.1',
          location: null,
          isActive: true,
          lastUsed: new Date(),
          expiresAt: new Date(),
          createdAt: new Date(),
        },
        {
          id: 2,
          userId: 1,
          deviceName: 'Safari',
          deviceFingerprint: 'fingerprint2',
          deviceType: 'desktop',
          browser: 'Safari',
          operatingSystem: 'macOS',
          ipAddress: '192.168.1.2',
          location: null,
          isActive: true,
          lastUsed: new Date(),
          expiresAt: new Date(),
          createdAt: new Date(),
        },
      ];

      mockMfaService.getUserMfaSettings.mockResolvedValueOnce(mockSettings);
      mockMfaService.getTrustedDevices.mockResolvedValueOnce(
        mockTrustedDevices
      );

      const response = await request(app).get('/api/mfa/status').expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.mfaEnabled).toBe(true);
      expect(response.body.data.totpEnabled).toBe(true);
      expect(response.body.data.trustedDevicesCount).toBe(2);
    });
  });

  describe('GET /api/mfa/trusted-devices', () => {
    it('should return trusted devices list', async () => {
      const mockDevices = [
        {
          id: 1,
          userId: 1,
          deviceName: 'Chrome Browser',
          deviceFingerprint: 'sensitive-fingerprint',
          deviceType: 'desktop',
          browser: 'Chrome',
          operatingSystem: 'Windows',
          ipAddress: '192.168.1.1',
          location: null,
          isActive: true,
          lastUsed: new Date(),
          expiresAt: new Date(),
          createdAt: new Date(),
        },
      ];

      mockMfaService.getTrustedDevices.mockResolvedValueOnce(mockDevices);

      const response = await request(app)
        .get('/api/mfa/trusted-devices')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.devices).toHaveLength(1);

      // Should not include sensitive fingerprint data
      expect(response.body.data.devices[0]).not.toHaveProperty(
        'deviceFingerprint'
      );
      expect(response.body.data.devices[0].deviceName).toBe('Chrome Browser');
    });
  });

  describe('DELETE /api/mfa/trusted-devices/:deviceId', () => {
    it('should remove trusted device', async () => {
      mockMfaService.removeTrustedDevice.mockResolvedValueOnce(undefined);

      const response = await request(app)
        .delete('/api/mfa/trusted-devices/1')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockMfaService.removeTrustedDevice).toHaveBeenCalledWith(1, 1);
    });

    it('should reject invalid device ID', async () => {
      const response = await request(app)
        .delete('/api/mfa/trusted-devices/invalid')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MFA_ERROR');
    });
  });

  describe('POST /api/mfa/disable', () => {
    it('should disable MFA with valid token', async () => {
      const mockVerifyResult = {
        success: true,
        requiresMfa: false,
      };

      mockMfaService.verifyTotp.mockResolvedValueOnce(mockVerifyResult);
      mockMfaService.disableMfa.mockResolvedValueOnce(undefined);

      const response = await request(app)
        .post('/api/mfa/disable')
        .send({ token: '123456' })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(mockMfaService.disableMfa).toHaveBeenCalledWith(1);
    });

    it('should require valid TOTP token', async () => {
      const mockVerifyResult = {
        success: false,
        requiresMfa: true,
      };

      mockMfaService.verifyTotp.mockResolvedValueOnce(mockVerifyResult);

      const response = await request(app)
        .post('/api/mfa/disable')
        .send({ token: '123456' })
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MFA_ERROR');
    });
  });

  // SMS-specific route tests
  describe('SMS Routes', () => {
    describe('POST /api/mfa/sms/send', () => {
      it('should send SMS verification code', async () => {
        const mockSmsResult = {
          success: true,
          message: 'Verification code sent via SMS',
        };

        mockSmsService.sendVerificationCode.mockResolvedValueOnce(
          mockSmsResult
        );

        const response = await request(app)
          .post('/api/mfa/sms/send')
          .send({
            phoneNumber: '+1234567890',
            purpose: 'mfa_login',
          })
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data.message).toBe(
          'Verification code sent via SMS'
        );
      });

      it('should validate phone number format', async () => {
        const response = await request(app)
          .post('/api/mfa/sms/send')
          .send({
            phoneNumber: 'invalid-phone',
            purpose: 'mfa_login',
          })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('MFA_ERROR');
      });

      it('should validate purpose field', async () => {
        const response = await request(app)
          .post('/api/mfa/sms/send')
          .send({
            phoneNumber: '+1234567890',
            purpose: 'invalid_purpose',
          })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('MFA_ERROR');
      });
    });

    describe('POST /api/mfa/sms/verify', () => {
      it('should verify SMS code successfully', async () => {
        const mockVerifyResult = {
          success: true,
          message: 'SMS verification successful',
        };

        mockSmsService.verifyCode.mockResolvedValueOnce(mockVerifyResult);

        const response = await request(app)
          .post('/api/mfa/sms/verify')
          .send({
            phoneNumber: '+1234567890',
            code: '123456',
            purpose: 'mfa_login',
          })
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data.verified).toBe(true);
      });

      it('should validate SMS code format', async () => {
        const response = await request(app)
          .post('/api/mfa/sms/verify')
          .send({
            phoneNumber: '+1234567890',
            code: 'invalid',
            purpose: 'mfa_login',
          })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('MFA_ERROR');
      });
    });

    describe('POST /api/mfa/sms/enable', () => {
      it('should enable SMS MFA with valid verification', async () => {
        const mockVerifyResult = {
          success: true,
          message: 'SMS verification successful',
        };

        mockSmsService.verifyCode.mockResolvedValueOnce(mockVerifyResult);
        mockSmsService.enableSmsForMfa.mockResolvedValueOnce(true);

        const response = await request(app)
          .post('/api/mfa/sms/enable')
          .send({
            phoneNumber: '+1234567890',
            verificationCode: '123456',
          })
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data.message).toBe('SMS MFA enabled successfully');
        expect(response.body.data.phoneNumber).toContain('*'); // Should be masked
      });

      it('should require valid verification code', async () => {
        const mockVerifyResult = {
          success: false,
          message: 'Invalid verification code',
        };

        mockSmsService.verifyCode.mockResolvedValueOnce(mockVerifyResult);

        const response = await request(app)
          .post('/api/mfa/sms/enable')
          .send({
            phoneNumber: '+1234567890',
            verificationCode: '123456',
          })
          .expect(401);

        expect(response.body.success).toBe(false);
        expect(response.body.error.code).toBe('MFA_ERROR');
      });
    });

    describe('POST /api/mfa/sms/disable', () => {
      it('should disable SMS MFA with valid TOTP token', async () => {
        const mockVerifyResult = {
          success: true,
          requiresMfa: false,
        };

        mockMfaService.verifyTotp.mockResolvedValueOnce(mockVerifyResult);
        mockSmsService.disableSmsForMfa.mockResolvedValueOnce(true);

        const response = await request(app)
          .post('/api/mfa/sms/disable')
          .send({ token: '123456' })
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data.message).toBe(
          'SMS MFA disabled successfully'
        );
      });
    });

    describe('GET /api/mfa/sms/stats', () => {
      it('should return SMS statistics', async () => {
        const mockStats = {
          totalSent: 10,
          successfulVerifications: 8,
          failedVerifications: 2,
          averageVerificationTime: 0,
        };

        mockSmsService.getSmsStats.mockResolvedValueOnce(mockStats);

        const response = await request(app)
          .get('/api/mfa/sms/stats')
          .expect(200);

        expect(response.body.success).toBe(true);
        expect(response.body.data).toEqual(mockStats);
      });
    });
  });

  describe('POST /api/mfa/cleanup', () => {
    it('should cleanup expired data', async () => {
      mockMfaService.cleanupExpiredData.mockResolvedValueOnce(undefined);
      mockSmsService.cleanupExpiredCodes.mockResolvedValueOnce(undefined);

      const response = await request(app).post('/api/mfa/cleanup').expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.message).toBe(
        'Expired data cleaned up successfully'
      );
      expect(mockMfaService.cleanupExpiredData).toHaveBeenCalled();
      expect(mockSmsService.cleanupExpiredCodes).toHaveBeenCalled();
    });
  });

  describe('Authentication Middleware', () => {
    it('should require authentication for all routes', async () => {
      // Create app without auth middleware
      const unauthApp = express();
      unauthApp.use(express.json());
      unauthApp.use('/api/mfa', mfaRoutes);

      const response = await request(unauthApp)
        .get('/api/mfa/status')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MFA_ERROR');
    });
  });

  describe('Error Handling', () => {
    it('should handle service errors gracefully', async () => {
      mockMfaService.getUserMfaSettings.mockRejectedValueOnce(
        new Error('Database error')
      );

      const response = await request(app).get('/api/mfa/status').expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('STATUS_ERROR');
    });

    it('should handle validation errors', async () => {
      const response = await request(app)
        .post('/api/mfa/enable/totp')
        .send({}) // Missing required token
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error.code).toBe('MFA_ERROR');
    });
  });

  describe('Response Format', () => {
    it('should return consistent response format', async () => {
      mockMfaService.getUserMfaSettings.mockResolvedValueOnce({
        id: 1,
        userId: 1,
        mfaEnabled: false,
        totpSecret: null,
        smsEnabled: false,
        phoneNumber: null,
        backupCodes: null,
        recoveryEmail: null,
        trustedDevices: null,
        lastBackupCodesGenerated: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      mockMfaService.getTrustedDevices.mockResolvedValueOnce([]);

      const response = await request(app).get('/api/mfa/status').expect(200);

      expect(response.body).toHaveProperty('success');
      expect(response.body).toHaveProperty('data');
      expect(response.body).toHaveProperty('timestamp');
      expect(typeof response.body.timestamp).toBe('string');
    });

    it('should return consistent error format', async () => {
      const response = await request(app)
        .post('/api/mfa/enable/totp')
        .send({ token: 'invalid' })
        .expect(400);

      expect(response.body).toHaveProperty('success', false);
      expect(response.body).toHaveProperty('error');
      expect(response.body.error).toHaveProperty('code');
      expect(response.body.error).toHaveProperty('message');
      expect(response.body).toHaveProperty('timestamp');
    });
  });
});
