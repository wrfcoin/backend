/**
 * Unit tests for MFA Service
 * Tests TOTP authentication, backup codes, and device management
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { mfaService } from '../../services/mfa-service.js';
import * as QRCode from 'qrcode';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

// Mock dependencies
jest.mock('drizzle-orm/postgres-js');
jest.mock('postgres');
jest.mock('otplib', () => ({
  generateSecret: jest.fn(),
  generateURI: jest.fn(),
  verifySync: jest.fn(),
}));

// Mock the schema imports
jest.mock('../../shared/schema.js', () => ({
  userMfaSettings: { name: 'user_mfa_settings' },
  mfaAttempts: { name: 'mfa_attempts' },
  userSessions: { name: 'user_sessions' },
  trustedDevices: { name: 'trusted_devices', expiresAt: 'expires_at' },
  mfaBackupCodeUsage: { name: 'mfa_backup_code_usage' },
  smsVerificationCodes: {
    name: 'sms_verification_codes',
    expiresAt: 'expires_at',
  },
  securityEvents: { name: 'security_events' },
  users: { name: 'users' },
}));

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

// Mock bcrypt
jest.mock('bcrypt', () => ({
  hash: jest.fn() as any,
  compare: jest.fn() as any,
}));

// Mock QRCode
jest.mock('qrcode', () => ({
  toDataURL: jest.fn() as jest.MockedFunction<any>,
}));

const mockOtplib = jest.requireMock('otplib') as {
  generateSecret: AnyMock;
  generateURI: AnyMock;
  verifySync: AnyMock;
};

const encryptedTestSecret = (secret = 'JBSWY3DPEHPK3PXP'): string => {
  const key = crypto.scryptSync(
    process.env.MFA_ENCRYPTION_KEY as string,
    'wrfcoin-mfa-salt-v1',
    32
  );
  const iv = Buffer.alloc(16, 1);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('mfa-data'));
  const encrypted = Buffer.concat([
    cipher.update(secret, 'utf8'),
    cipher.final(),
  ]);
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`;
};

describe('MfaService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    drizzleMock.__reset();

    // Default mock implementations
    mockDb.select.mockReturnThis();
    mockDb.from.mockReturnThis();
    mockDb.where.mockReturnThis();
    mockDb.limit.mockReturnThis();
    mockDb.insert.mockReturnThis();
    mockDb.values.mockReturnThis();
    mockDb.returning.mockReturnThis();
    mockDb.update.mockReturnThis();
    mockDb.set.mockReturnThis();
    mockDb.delete.mockReturnThis();

    (bcrypt.hash as any).mockResolvedValue('hashedCode');
    (bcrypt.compare as any).mockResolvedValue(true);
    (QRCode.toDataURL as any).mockResolvedValue(
      'data:image/png;base64,mockQRCode'
    );
    mockOtplib.generateSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mockOtplib.generateURI.mockReturnValue('otpauth://totp/test');
    mockOtplib.verifySync.mockReturnValue({ valid: true });
  });

  describe('generateTotpSetup', () => {
    it('should generate TOTP setup with QR code and backup codes', async () => {
      const userId = 1;
      const userEmail = 'test@example.com';

      // Mock database responses
      mockDb.select.mockResolvedValueOnce([]); // No existing MFA settings
      mockDb.insert.mockResolvedValueOnce([{ id: 1 }]);

      const result = await mfaService.generateTotpSetup(userId, userEmail);

      expect(result).toHaveProperty('qrCodeUrl');
      expect(result).toHaveProperty('backupCodes');
      expect(result.qrCodeUrl).toBe('data:image/png;base64,mockQRCode');
      expect(result.backupCodes).toHaveLength(8);
      expect(mockOtplib.generateSecret).toHaveBeenCalled();
      expect(QRCode.toDataURL).toHaveBeenCalled();
    });

    it('should replace an existing MFA setup without enabling it', async () => {
      const userId = 1;
      const userEmail = 'test@example.com';

      // Mock existing MFA settings
      mockDb.select.mockResolvedValueOnce([{ mfaEnabled: true }]);

      const result = await mfaService.generateTotpSetup(userId, userEmail);

      expect(result.backupCodes).toHaveLength(8);
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('enableTotp', () => {
    it('should enable TOTP after successful verification', async () => {
      const userId = 1;
      const token = '123456';

      // Mock database responses
      mockDb.select.mockResolvedValueOnce([
        {
          id: 1,
          totpSecret: encryptedTestSecret(),
          mfaEnabled: false,
        },
      ]);

      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);

      const result = await mfaService.enableTotp(userId, token);

      expect(result).toBe(true);
      expect(mockOtplib.verifySync).toHaveBeenCalledWith(
        expect.objectContaining({ token, secret: expect.any(String) })
      );
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should return false for invalid token', async () => {
      const userId = 1;
      const token = 'invalid';

      mockDb.select.mockResolvedValueOnce([
        {
          id: 1,
          totpSecret: encryptedTestSecret(),
          mfaEnabled: false,
        },
      ]);

      mockOtplib.verifySync.mockReturnValueOnce({ valid: false });

      const result = await mfaService.enableTotp(userId, token);

      expect(result).toBe(false);
    });

    it('should throw error if no setup found', async () => {
      const userId = 1;
      const token = '123456';

      mockDb.select.mockResolvedValueOnce([]);

      await expect(mfaService.enableTotp(userId, token)).rejects.toThrow(
        'TOTP setup not found'
      );
    });
  });

  describe('verifyTotp', () => {
    it('should verify TOTP token successfully', async () => {
      const options = {
        userId: 1,
        token: '123456',
        deviceFingerprint: 'device123',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
      };

      // Mock MFA settings
      mockDb.select.mockResolvedValueOnce([]); // Device is not trusted
      mockDb.select.mockResolvedValueOnce([{ count: 0 }]); // No failed attempts
      mockDb.select.mockResolvedValueOnce([
        {
          id: 1,
          mfaEnabled: true,
          totpSecret: encryptedTestSecret(),
        },
      ]);

      const result = await mfaService.verifyTotp(options);

      expect(result.success).toBe(true);
      expect(mockOtplib.verifySync).toHaveBeenCalled();
    });

    it('should handle rate limiting', async () => {
      const options = {
        userId: 1,
        token: '123456',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
      };

      mockDb.select.mockResolvedValueOnce([{ count: 5 }]);

      const result = await mfaService.verifyTotp(options);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Too many failed attempts');
    });

    it('should return false for disabled MFA', async () => {
      const options = {
        userId: 1,
        token: '123456',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
      };

      mockDb.select.mockResolvedValueOnce([{ count: 0 }]);
      mockDb.select.mockResolvedValueOnce([
        {
          id: 1,
          mfaEnabled: false,
        },
      ]);

      const result = await mfaService.verifyTotp(options);

      expect(result.success).toBe(false);
      expect(result.message).toBe('MFA not enabled for this user');
    });
  });

  describe('verifyBackupCode', () => {
    it('should verify backup code successfully', async () => {
      const userId = 1;
      const code = '1234567890';

      // Mock MFA settings with backup codes
      mockDb.select.mockResolvedValueOnce([
        {
          id: 1,
          mfaEnabled: true,
          backupCodes: ['hashedCode1', 'hashedCode2'],
        },
      ]);
      mockDb.select.mockResolvedValueOnce([]); // Code has not been used

      (bcrypt.compare as any).mockResolvedValueOnce(true);
      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);

      const result = await mfaService.verifyBackupCode(userId, code);

      expect(result.success).toBe(true);
      expect(bcrypt.compare).toHaveBeenCalledWith(code, 'hashedCode1');
    });

    it('should return false for invalid backup code', async () => {
      const userId = 1;
      const code = 'invalid';

      mockDb.select.mockResolvedValueOnce([
        {
          id: 1,
          mfaEnabled: true,
          backupCodes: ['hashedCode1', 'hashedCode2'],
        },
      ]);
      mockDb.select.mockResolvedValueOnce([]); // Code has not been used

      (bcrypt.compare as any).mockResolvedValue(false);

      const result = await mfaService.verifyBackupCode(userId, code);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid backup code');
    });

    it('should return false if no backup codes available', async () => {
      const userId = 1;
      const code = '1234567890';

      mockDb.select.mockResolvedValueOnce([
        {
          id: 1,
          mfaEnabled: true,
          backupCodes: null,
        },
      ]);

      const result = await mfaService.verifyBackupCode(userId, code);

      expect(result.success).toBe(false);
      expect(result.message).toBe('MFA not enabled for this user');
    });
  });

  describe('regenerateBackupCodes', () => {
    it('should generate new backup codes', async () => {
      const userId = 1;

      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);

      const result = await mfaService.regenerateBackupCodes(userId);

      expect(result).toHaveLength(8);
      expect(result[0]).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should regenerate codes without reading current settings', async () => {
      const userId = 1;

      const result = await mfaService.regenerateBackupCodes(userId);

      expect(result).toHaveLength(8);
      expect(mockDb.select).not.toHaveBeenCalled();
      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('disableMfa', () => {
    it('should disable MFA and cleanup related data', async () => {
      const userId = 1;

      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);
      mockDb.delete.mockResolvedValue(undefined);

      await mfaService.disableMfa(userId);

      expect(mockDb.update).toHaveBeenCalledWith(expect.any(Object));
      expect(mockDb.update).toHaveBeenCalledTimes(2);
      expect(mockDb.delete).not.toHaveBeenCalled();
    });
  });

  describe('getUserMfaSettings', () => {
    it('should return user MFA settings', async () => {
      const userId = 1;

      const mockSettings = {
        id: 1,
        userId: 1,
        mfaEnabled: true,
        smsEnabled: false,
        backupCodes: ['code1', 'code2'],
        createdAt: new Date(),
      };

      mockDb.select.mockResolvedValueOnce([mockSettings]);

      const result = await mfaService.getUserMfaSettings(userId);

      expect(result).toEqual(mockSettings);
    });

    it('should return null if no settings found', async () => {
      const userId = 1;

      mockDb.select.mockResolvedValueOnce([]);

      const result = await mfaService.getUserMfaSettings(userId);

      expect(result).toBeNull();
    });
  });

  describe('getTrustedDevices', () => {
    it('should return list of trusted devices', async () => {
      const userId = 1;

      const mockDevices = [
        {
          id: 1,
          userId: 1,
          deviceName: 'Chrome Browser',
          deviceType: 'desktop',
          lastUsed: new Date(),
        },
        {
          id: 2,
          userId: 1,
          deviceName: 'Mobile Safari',
          deviceType: 'mobile',
          lastUsed: new Date(),
        },
      ];

      mockDb.select.mockResolvedValueOnce(mockDevices);

      const result = await mfaService.getTrustedDevices(userId);

      expect(result).toEqual(mockDevices);
      expect(result).toHaveLength(2);
    });
  });

  describe('removeTrustedDevice', () => {
    it('should remove trusted device', async () => {
      const userId = 1;
      const deviceId = 1;

      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);

      await mfaService.removeTrustedDevice(userId, deviceId);

      expect(mockDb.update).toHaveBeenCalled();
    });
  });

  describe('cleanupExpiredData', () => {
    it('should cleanup expired attempts, sessions, and devices', async () => {
      mockDb.delete.mockResolvedValue(undefined);

      await mfaService.cleanupExpiredData();

      expect(mockDb.update).toHaveBeenCalledTimes(1);
      expect(mockDb.delete).toHaveBeenCalledTimes(2);
    });
  });
});

describe('MfaService Error Handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    drizzleMock.__reset();
    (bcrypt.hash as any).mockResolvedValue('hashedCode');
    (bcrypt.compare as any).mockResolvedValue(true);
    (QRCode.toDataURL as any).mockResolvedValue(
      'data:image/png;base64,mockQRCode'
    );
    mockOtplib.generateSecret.mockReturnValue('JBSWY3DPEHPK3PXP');
    mockOtplib.generateURI.mockReturnValue('otpauth://totp/test');
    mockOtplib.verifySync.mockReturnValue({ valid: true });
  });

  it('should handle database connection errors', async () => {
    const userId = 1;

    mockDb.select.mockRejectedValueOnce(
      new Error('Database connection failed')
    );

    await expect(mfaService.getUserMfaSettings(userId)).rejects.toThrow(
      'Database connection failed'
    );
  });

  it('should handle encryption errors gracefully', async () => {
    const userId = 1;
    const userEmail = 'test@example.com';

    // Mock crypto error
    jest.spyOn(require('crypto'), 'createCipheriv').mockImplementationOnce(() => {
      throw new Error('Encryption failed');
    });

    await expect(
      mfaService.generateTotpSetup(userId, userEmail)
    ).rejects.toThrow();
  });

  it('should handle QR code generation failures', async () => {
    const userId = 1;
    const userEmail = 'test@example.com';

    mockDb.select.mockResolvedValueOnce([]);
    (QRCode.toDataURL as any).mockRejectedValueOnce(
      new Error('QR generation failed')
    );

    await expect(
      mfaService.generateTotpSetup(userId, userEmail)
    ).rejects.toThrow('QR generation failed');
  });
});

describe('MfaService Security Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    drizzleMock.__reset();
    (bcrypt.hash as any).mockResolvedValue('hashedCode');
    (bcrypt.compare as any).mockResolvedValue(true);
    mockOtplib.verifySync.mockReturnValue({ valid: true });
  });

  it('should use constant-time comparison for backup codes', async () => {
    const userId = 1;
    const code = '1234567890';

    mockDb.select.mockResolvedValueOnce([
      {
        id: 1,
        mfaEnabled: true,
        backupCodes: ['hashedCode1'],
      },
    ]);
    mockDb.select.mockResolvedValueOnce([]); // Code has not been used

    await mfaService.verifyBackupCode(userId, code);

    expect(bcrypt.compare).toHaveBeenCalledWith(code, 'hashedCode1');
  });

  it('should enforce rate limiting on verification attempts', async () => {
    const options = {
      userId: 1,
      token: '123456',
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0...',
    };

    mockDb.select.mockResolvedValueOnce([{ count: 5 }]);

    const result = await mfaService.verifyTotp(options);

    expect(result.success).toBe(false);
    expect(result.message).toContain('Too many failed attempts');
  });

  it('should log MFA verification attempts', async () => {
    const mockLogMfaAttempt = jest
      .spyOn(mfaService as any, 'logMfaAttempt')
      .mockResolvedValue(undefined);

    const options = {
      userId: 1,
      token: '123456',
      ipAddress: '192.168.1.1',
      userAgent: 'Mozilla/5.0...',
    };

    mockDb.select.mockResolvedValueOnce([{ count: 0 }]);
    mockDb.select.mockResolvedValueOnce([
      {
        id: 1,
        mfaEnabled: true,
        totpSecret: encryptedTestSecret(),
      },
    ]);

    await mfaService.verifyTotp(options);

    expect(mockLogMfaAttempt).toHaveBeenCalledWith(
      expect.objectContaining({ attemptType: 'totp', success: true })
    );
  });
});
