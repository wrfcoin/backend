/**
 * Unit tests for SMS Service
 * Tests SMS verification, rate limiting, and provider integrations
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from '@jest/globals';
import { SmsService } from '../../services/sms-service.js';
import * as bcrypt from 'bcrypt';

// Mock dependencies
jest.mock('drizzle-orm/postgres-js');
jest.mock('postgres');
jest.mock('bcrypt');

// #992: the mock objects are built INSIDE the factories and pulled back out with
// `jest.requireMock`. Declaring them above and closing over them fails: `jest.mock`
// is hoisted above the `const`, the static import of the module under test is
// hoisted above that, and the factory therefore runs while the binding is still in
// its temporal dead zone — `ReferenceError: Cannot access 'mockDb' before
// initialization`, which is why this suite was quarantined.
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

// Mock bcrypt (same #992 hoisting fix).
jest.mock('bcrypt', () => ({
  hash: jest.fn<(...args: any[]) => any>(),
  compare: jest.fn<(...args: any[]) => any>(),
}));
const mockBcrypt = jest.requireMock('bcrypt') as Record<string, AnyMock>;

// Mock SMS providers
const mockSmsProvider = {
  sendSms: jest.fn<(...args: any[]) => any>(),
};

describe('SmsService', () => {
  let smsService: SmsService;

  beforeEach(() => {
    jest.clearAllMocks();
    drizzleMock.__reset();

    // Reset database mock methods
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

    // Default bcrypt mocks
    mockBcrypt.hash.mockResolvedValue('hashedCode123');
    mockBcrypt.compare.mockResolvedValue(true);

    // Default SMS provider mock
    mockSmsProvider.sendSms.mockResolvedValue(true);

    // Create service instance with mock provider
    smsService = new SmsService();
    (smsService as any).smsProvider = mockSmsProvider;
  });

  describe('Constructor and Provider Selection', () => {
    it('should use mock provider by default', () => {
      const service = new SmsService();
      expect(service).toBeInstanceOf(SmsService);
    });

    it('should use Twilio provider when configured', () => {
      process.env.SMS_PROVIDER = 'twilio';
      process.env.TWILIO_ACCOUNT_SID = 'test_sid';
      process.env.TWILIO_AUTH_TOKEN = 'test_token';
      process.env.TWILIO_FROM_NUMBER = '+1234567890';

      const service = new SmsService();
      expect(service).toBeInstanceOf(SmsService);

      // Cleanup
      delete process.env.SMS_PROVIDER;
      delete process.env.TWILIO_ACCOUNT_SID;
      delete process.env.TWILIO_AUTH_TOKEN;
      delete process.env.TWILIO_FROM_NUMBER;
    });

    it('should use AWS provider when configured', () => {
      process.env.SMS_PROVIDER = 'aws';

      const service = new SmsService();
      expect(service).toBeInstanceOf(SmsService);

      // Cleanup
      delete process.env.SMS_PROVIDER;
    });
  });

  describe('sendVerificationCode', () => {
    it('should send SMS verification code successfully', async () => {
      const options = {
        userId: 1,
        phoneNumber: '+1234567890',
        purpose: 'mfa_login' as const,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
      };

      // Mock rate limit check (allowed)
      mockDb.select.mockResolvedValueOnce([]); // No recent SMS
      mockDb.select.mockResolvedValueOnce([]); // Hourly limit not exceeded

      // Mock database insert
      mockDb.insert.mockResolvedValueOnce([{ id: 1 }]);

      const result = await smsService.sendVerificationCode(options);

      expect(result.success).toBe(true);
      expect(result.message).toBe('Verification code sent via SMS');
      expect(mockSmsProvider.sendSms).toHaveBeenCalledWith(
        '+1234567890',
        expect.stringContaining(
          'Your Wrfcoin multi-factor authentication code is:'
        )
      );
      expect(mockDb.insert).toHaveBeenCalled();
    });

    it('should reject invalid phone number format', async () => {
      const options = {
        userId: 1,
        phoneNumber: 'invalid-phone',
        purpose: 'mfa_login' as const,
      };

      const result = await smsService.sendVerificationCode(options);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid phone number format');
      expect(mockSmsProvider.sendSms).not.toHaveBeenCalled();
    });

    it('should enforce rate limiting - recent SMS', async () => {
      const options = {
        userId: 1,
        phoneNumber: '+1234567890',
        purpose: 'mfa_login' as const,
      };

      // Mock recent SMS (rate limited)
      mockDb.select.mockResolvedValueOnce([{ id: 1, createdAt: new Date() }]);

      const result = await smsService.sendVerificationCode(options);

      expect(result.success).toBe(false);
      expect(result.message).toBe('Please wait before requesting another code');
      expect(mockSmsProvider.sendSms).not.toHaveBeenCalled();
    });

    it('should enforce hourly SMS limit', async () => {
      const options = {
        userId: 1,
        phoneNumber: '+1234567890',
        purpose: 'mfa_login' as const,
      };

      // Mock rate limit checks
      mockDb.select.mockResolvedValueOnce([]); // No recent SMS (1 min)

      // Mock hourly limit exceeded
      const hourlySms = Array(10)
        .fill(null)
        .map((_, i) => ({
          id: i + 1,
          createdAt: new Date(Date.now() - i * 60000), // Every minute for past 10 minutes
        }));
      mockDb.select.mockResolvedValueOnce(hourlySms);

      const result = await smsService.sendVerificationCode(options);

      expect(result.success).toBe(false);
      expect(result.message).toBe('SMS limit exceeded. Please try again later');
    });

    it('should handle SMS provider failure', async () => {
      const options = {
        userId: 1,
        phoneNumber: '+1234567890',
        purpose: 'mfa_login' as const,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
      };

      // Mock successful rate limit checks
      mockDb.select.mockResolvedValueOnce([]);
      mockDb.select.mockResolvedValueOnce([]);
      mockDb.insert.mockResolvedValueOnce([{ id: 1 }]);

      // Mock SMS provider failure
      mockSmsProvider.sendSms.mockResolvedValueOnce(false);

      const result = await smsService.sendVerificationCode(options);

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        'Failed to send SMS. Please try again later.'
      );
    });

    it('should generate different message formats for different purposes', async () => {
      const baseOptions = {
        userId: 1,
        phoneNumber: '+1234567890',
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
      };

      // Mock successful conditions
      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([{ id: 1 }]);

      // Test MFA login
      await smsService.sendVerificationCode({
        ...baseOptions,
        purpose: 'mfa_login',
      });
      expect(mockSmsProvider.sendSms).toHaveBeenLastCalledWith(
        '+1234567890',
        expect.stringContaining('multi-factor authentication')
      );

      // Test MFA setup
      await smsService.sendVerificationCode({
        ...baseOptions,
        purpose: 'mfa_setup',
      });
      expect(mockSmsProvider.sendSms).toHaveBeenLastCalledWith(
        '+1234567890',
        expect.stringContaining('MFA setup')
      );

      // Test password reset
      await smsService.sendVerificationCode({
        ...baseOptions,
        purpose: 'password_reset',
      });
      expect(mockSmsProvider.sendSms).toHaveBeenLastCalledWith(
        '+1234567890',
        expect.stringContaining('password reset')
      );
    });
  });

  describe('verifyCode', () => {
    it('should verify SMS code successfully', async () => {
      const userId = 1;
      const phoneNumber = '+1234567890';
      const code = '123456';
      const purpose = 'mfa_login';

      // Mock database record
      const mockRecord = {
        id: 1,
        userId: 1,
        code: 'hashedCode123',
        attempts: 0,
        isUsed: false,
        expiresAt: new Date(Date.now() + 300000), // 5 minutes future
        createdAt: new Date(),
      };

      mockDb.select.mockResolvedValueOnce([mockRecord]);
      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);

      const result = await smsService.verifyCode(
        userId,
        phoneNumber,
        code,
        purpose,
        '192.168.1.1',
        'Mozilla/5.0...'
      );

      expect(result.success).toBe(true);
      expect(result.message).toBe('SMS verification successful');
      expect(mockBcrypt.compare).toHaveBeenCalledWith(code, 'hashedCode123');
      expect(mockDb.update).toHaveBeenCalledWith(expect.any(Object));
    });

    it('should fail for no valid code found', async () => {
      const userId = 1;
      const phoneNumber = '+1234567890';
      const code = '123456';
      const purpose = 'mfa_login';

      mockDb.select.mockResolvedValueOnce([]); // No records found

      const result = await smsService.verifyCode(
        userId,
        phoneNumber,
        code,
        purpose
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        'No valid verification code found or code has expired'
      );
    });

    it('should fail for too many attempts', async () => {
      const userId = 1;
      const phoneNumber = '+1234567890';
      const code = '123456';
      const purpose = 'mfa_login';

      const mockRecord = {
        id: 1,
        userId: 1,
        code: 'hashedCode123',
        attempts: 3, // Max attempts reached
        isUsed: false,
        expiresAt: new Date(Date.now() + 300000),
        createdAt: new Date(),
      };

      mockDb.select.mockResolvedValueOnce([mockRecord]);

      const result = await smsService.verifyCode(
        userId,
        phoneNumber,
        code,
        purpose
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        'Too many failed attempts. Please request a new code.'
      );
    });

    it('should fail for invalid code and increment attempts', async () => {
      const userId = 1;
      const phoneNumber = '+1234567890';
      const code = 'invalid';
      const purpose = 'mfa_login';

      const mockRecord = {
        id: 1,
        userId: 1,
        code: 'hashedCode123',
        attempts: 1,
        isUsed: false,
        expiresAt: new Date(Date.now() + 300000),
        createdAt: new Date(),
      };

      mockDb.select.mockResolvedValueOnce([mockRecord]);
      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);
      mockBcrypt.compare.mockResolvedValueOnce(false);

      const result = await smsService.verifyCode(
        userId,
        phoneNumber,
        code,
        purpose
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('Invalid verification code');
      expect(result.attemptsRemaining).toBe(1); // 3 max - 2 attempts
      expect(mockDb.update).toHaveBeenCalledWith(expect.any(Object));
    });

    it('should handle expired codes', async () => {
      const userId = 1;
      const phoneNumber = '+1234567890';
      const code = '123456';
      const purpose = 'mfa_login';

      // Mock expired record (should not be returned by query)
      mockDb.select.mockResolvedValueOnce([]);

      const result = await smsService.verifyCode(
        userId,
        phoneNumber,
        code,
        purpose
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe(
        'No valid verification code found or code has expired'
      );
    });
  });

  describe('enableSmsForMfa', () => {
    it('should enable SMS for MFA successfully', async () => {
      const userId = 1;
      const phoneNumber = '+1234567890';

      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);
      mockDb.insert.mockResolvedValueOnce([{ id: 1 }]); // Security event

      const result = await smsService.enableSmsForMfa(userId, phoneNumber);

      expect(result).toBe(true);
      expect(mockDb.update).toHaveBeenCalled();
    });

    it('should handle database errors gracefully', async () => {
      const userId = 1;
      const phoneNumber = '+1234567890';

      mockDb.update.mockRejectedValueOnce(new Error('Database error'));

      const result = await smsService.enableSmsForMfa(userId, phoneNumber);

      expect(result).toBe(false);
    });
  });

  describe('disableSmsForMfa', () => {
    it('should disable SMS for MFA successfully', async () => {
      const userId = 1;

      mockDb.update.mockResolvedValueOnce([{ id: 1 }]);
      mockDb.insert.mockResolvedValueOnce([{ id: 1 }]); // Security event

      const result = await smsService.disableSmsForMfa(userId);

      expect(result).toBe(true);
      expect(mockDb.update).toHaveBeenCalledWith(expect.any(Object));
    });

    it('should handle database errors gracefully', async () => {
      const userId = 1;

      mockDb.update.mockRejectedValueOnce(new Error('Database error'));

      const result = await smsService.disableSmsForMfa(userId);

      expect(result).toBe(false);
    });
  });

  describe('Phone Number Validation', () => {
    it('should validate international phone numbers correctly', () => {
      const validNumbers = [
        '+1234567890',
        '+1234567890123',
        '+12345678901234',
        '+919876543210',
        '+447700900123',
      ];

      validNumbers.forEach(number => {
        expect((smsService as any).isValidPhoneNumber(number)).toBe(true);
      });
    });

    it('should reject invalid phone numbers', () => {
      const invalidNumbers = [
        '1234567890', // Missing +
        '+1', // Too short
        '+1234567890123456', // Too long (E.164 permits at most 15 digits)
        '+abc1234567890', // Contains letters
        '++1234567890', // Double +
        '+0234567890', // Starts with 0 after country code
      ];

      invalidNumbers.forEach(number => {
        expect((smsService as any).isValidPhoneNumber(number)).toBe(false);
      });
    });
  });

  describe('Phone Number Masking', () => {
    it('should mask phone numbers for logging', () => {
      const testCases = [
        { input: '+1234567890', expected: '+123*******' },
        { input: '+12345', expected: '+123**' },
        { input: '+12', expected: '****' },
        { input: '', expected: '****' },
      ];

      testCases.forEach(({ input, expected }) => {
        const result = (smsService as any).maskPhoneNumber(input);
        expect(result).toBe(expected);
      });
    });
  });

  describe('cleanupExpiredCodes', () => {
    it('should remove expired SMS codes', async () => {
      mockDb.delete.mockResolvedValueOnce(undefined);

      await smsService.cleanupExpiredCodes();

      expect(mockDb.delete).toHaveBeenCalled();
    });
  });

  describe('getSmsStats', () => {
    it('should return SMS statistics for user', async () => {
      const userId = 1;

      const mockCodes = [
        { id: 1, isUsed: true, attempts: 1 },
        { id: 2, isUsed: true, attempts: 2 },
        { id: 3, isUsed: false, attempts: 3 }, // Failed (max attempts)
        { id: 4, isUsed: false, attempts: 1 }, // Pending
      ];

      mockDb.select.mockResolvedValueOnce(mockCodes);

      const result = await smsService.getSmsStats(userId);

      expect(result).toEqual({
        totalSent: 4,
        successfulVerifications: 2,
        failedVerifications: 1,
        averageVerificationTime: 0, // Not implemented in mock
      });
    });

    it('should return global statistics when no userId provided', async () => {
      const mockCodes = [
        { id: 1, isUsed: true, attempts: 1 },
        { id: 2, isUsed: false, attempts: 3 },
      ];

      mockDb.select.mockResolvedValueOnce(mockCodes);

      const result = await smsService.getSmsStats();

      expect(result).toEqual({
        totalSent: 2,
        successfulVerifications: 1,
        failedVerifications: 1,
        averageVerificationTime: 0,
      });
    });
  });

  describe('Code Generation', () => {
    it('should generate 6-digit numeric codes', () => {
      const code = (smsService as any).generateVerificationCode();

      expect(code).toMatch(/^\d{6}$/);
      expect(code.length).toBe(6);
    });

    it('should generate different codes on multiple calls', () => {
      const codes = new Set();

      for (let i = 0; i < 100; i++) {
        const code = (smsService as any).generateVerificationCode();
        codes.add(code);
      }

      // Should have generated many different codes (allowing for some duplicates)
      expect(codes.size).toBeGreaterThan(50);
    });
  });

  describe('Security Event Logging', () => {
    it('should log security events for all SMS operations', async () => {
      const mockLogSecurityEvent = jest
        .spyOn(smsService as any, 'logSecurityEvent')
        .mockResolvedValue(undefined);

      const options = {
        userId: 1,
        phoneNumber: '+1234567890',
        purpose: 'mfa_login' as const,
        ipAddress: '192.168.1.1',
        userAgent: 'Mozilla/5.0...',
      };

      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([{ id: 1 }]);

      await smsService.sendVerificationCode(options);

      expect(mockLogSecurityEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 1,
          eventType: 'sms_verification_sent',
          severity: 'low',
        })
      );
    });
  });
});

describe('SMS Provider Tests', () => {
  describe('MockSmsProvider', () => {
    it('should send through the mock provider', async () => {
      process.env.SMS_PROVIDER = 'mock';
      const service = new SmsService();

      const options = {
        userId: 1,
        phoneNumber: '+1234567890',
        purpose: 'mfa_login' as const,
      };

      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([{ id: 1 }]);

      const result = await service.sendVerificationCode(options);

      expect(result.success).toBe(true);
      expect(mockDb.insert).toHaveBeenCalled();
    });
  });

  describe('TwilioSmsProvider', () => {
    it('should handle missing Twilio configuration', async () => {
      process.env.SMS_PROVIDER = 'twilio';
      // Don't set Twilio credentials

      const service = new SmsService();

      const options = {
        userId: 1,
        phoneNumber: '+1234567890',
        purpose: 'mfa_login' as const,
      };

      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([{ id: 1 }]);

      const result = await service.sendVerificationCode(options);

      expect(result.success).toBe(false);
      delete process.env.SMS_PROVIDER;
    });
  });

  describe('AwsSmsProvider', () => {
    it('should fail closed when AWS credentials are missing', async () => {
      process.env.SMS_PROVIDER = 'aws';
      const service = new SmsService();

      const options = {
        userId: 1,
        phoneNumber: '+1234567890',
        purpose: 'mfa_login' as const,
      };

      mockDb.select.mockResolvedValue([]);
      mockDb.insert.mockResolvedValue([{ id: 1 }]);

      const result = await service.sendVerificationCode(options);

      expect(result.success).toBe(false);
      delete process.env.SMS_PROVIDER;
    });
  });
});
