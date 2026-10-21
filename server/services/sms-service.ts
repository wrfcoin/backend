import { eq, and, gt, lt } from 'drizzle-orm';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { securityLogger } from '../utils/logger.js';
import {
  smsVerificationCodes,
  securityEvents,
  userMfaSettings,
  type SmsVerificationCode,
  type InsertSmsVerificationCode,
  type InsertSecurityEvent,
} from '../../shared/schema.js';
import { db } from '../../database/connection.js';

// SMS Configuration
const SMS_CONFIG = {
  CODE_LENGTH: 6,
  CODE_EXPIRY: 5 * 60 * 1000, // 5 minutes
  MAX_ATTEMPTS: 3,
  RATE_LIMIT_WINDOW: 60 * 1000, // 1 minute between SMS sends
  MAX_SMS_PER_HOUR: 10,
  PHONE_VERIFICATION_EXPIRY: 24 * 60 * 60 * 1000, // 24 hours
};


// Encryption utilities (reused from MFA service)
class EncryptionUtil {
  private static readonly ALGORITHM = 'aes-256-gcm';
  private static readonly KEY = (() => {
    const encryptionKey = process.env.MFA_ENCRYPTION_KEY;
    if (!encryptionKey || encryptionKey.length < 32) {
      throw new Error(
        'MFA_ENCRYPTION_KEY environment variable must be set with at least 32 characters'
      );
    }
    return crypto.scryptSync(encryptionKey, 'wrfcoin-mfa-salt-v1', 32);
  })();

  static encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.ALGORITHM, this.KEY, iv);
    cipher.setAAD(Buffer.from('sms-data'));

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  }

  static decrypt(encryptedData: string): string {
    const [ivHex, authTagHex, encrypted] = encryptedData.split(':');

    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(this.ALGORITHM, this.KEY, iv);
    decipher.setAuthTag(authTag);
    decipher.setAAD(Buffer.from('sms-data'));

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}

// SMS Provider Interface
interface SmsProvider {
  sendSms(phoneNumber: string, message: string): Promise<boolean>;
}

// Mock SMS Provider (for development/testing)
class MockSmsProvider implements SmsProvider {
  async sendSms(phoneNumber: string, message: string): Promise<boolean> {
    securityLogger.info('Mock SMS sent', { module: 'MockSmsProvider', operation: 'sendSms', phoneNumber, message });

    // Log to security events for testing
    await db.insert(securityEvents).values({
      eventType: 'mock_sms_sent',
      severity: 'low',
      description: `Mock SMS sent to ${phoneNumber}: ${message}`,
      metadata: { phoneNumber, message },
    });

    return true;
  }
}

// Twilio SMS Provider (production-ready)
class TwilioSmsProvider implements SmsProvider {
  private accountSid: string;
  private authToken: string;
  private fromNumber: string;

  constructor() {
    this.accountSid = process.env.TWILIO_ACCOUNT_SID || '';
    this.authToken = process.env.TWILIO_AUTH_TOKEN || '';
    this.fromNumber = process.env.TWILIO_FROM_NUMBER || '';

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      securityLogger.warn('Twilio credentials not configured, SMS sending will fail unless SMS_STUB_MODE is enabled', { module: 'TwilioSmsProvider', operation: 'constructor' });
    }
  }

  async sendSms(phoneNumber: string, message: string): Promise<boolean> {
    if (process.env.SMS_STUB_MODE === 'true') {
      securityLogger.warn('SMS_STUB_MODE: SMS not actually sent', { module: 'TwilioSmsProvider', operation: 'sendSms', phoneNumber: phoneNumber.slice(-4) });
      return true;
    }

    if (!this.accountSid || !this.authToken || !this.fromNumber) {
      throw new Error('Twilio credentials not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_FROM_NUMBER, or enable SMS_STUB_MODE=true for development.');
    }

    try {
      const twilio = require('twilio');
      const client = twilio(this.accountSid, this.authToken);
      await client.messages.create({
        body: message,
        from: this.fromNumber,
        to: phoneNumber,
      });
      securityLogger.info('SMS sent via Twilio', { module: 'TwilioSmsProvider', operation: 'sendSms', phoneNumber: phoneNumber.slice(-4) });
      return true;
    } catch (error) {
      securityLogger.error('Failed to send SMS via Twilio', { module: 'TwilioSmsProvider', operation: 'sendSms', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

// AWS SNS SMS Provider
class AwsSmsProvider implements SmsProvider {
  private accessKeyId: string;
  private secretAccessKey: string;
  private region: string;

  constructor() {
    this.accessKeyId = process.env.AWS_ACCESS_KEY_ID || '';
    this.secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY || '';
    this.region = process.env.AWS_REGION || 'us-east-1';

    if (!this.accessKeyId || !this.secretAccessKey) {
      securityLogger.warn('AWS credentials not configured, SMS sending will fail unless SMS_STUB_MODE is enabled', { module: 'AwsSmsProvider', operation: 'constructor' });
    }
  }

  async sendSms(phoneNumber: string, message: string): Promise<boolean> {
    if (process.env.SMS_STUB_MODE === 'true') {
      securityLogger.warn('SMS_STUB_MODE: SMS not actually sent', { module: 'AwsSmsProvider', operation: 'sendSms', phoneNumber: phoneNumber.slice(-4) });
      return true;
    }

    if (!this.accessKeyId || !this.secretAccessKey) {
      throw new Error('AWS credentials not configured. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, or enable SMS_STUB_MODE=true for development.');
    }

    try {
      const { SNS } = require('@aws-sdk/client-sns');
      const sns = new SNS({
        region: this.region,
        credentials: { accessKeyId: this.accessKeyId, secretAccessKey: this.secretAccessKey },
      });
      await sns.publish({ Message: message, PhoneNumber: phoneNumber });
      securityLogger.info('SMS sent via AWS SNS', { module: 'AwsSmsProvider', operation: 'sendSms', phoneNumber: phoneNumber.slice(-4) });
      return true;
    } catch (error) {
      securityLogger.error('Failed to send SMS via AWS SNS', { module: 'AwsSmsProvider', operation: 'sendSms', error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
  }
}

export interface SmsVerificationOptions {
  userId: number;
  phoneNumber: string;
  purpose: 'mfa_login' | 'mfa_setup' | 'password_reset';
  ipAddress?: string;
  userAgent?: string;
}

export interface SmsVerificationResult {
  success: boolean;
  message?: string;
  attemptsRemaining?: number;
}

export class SmsService {
  private smsProvider: SmsProvider;

  constructor() {
    // Choose SMS provider based on environment
    const provider = process.env.SMS_PROVIDER || 'mock';

    switch (provider) {
      case 'twilio':
        this.smsProvider = new TwilioSmsProvider();
        break;
      case 'aws':
        this.smsProvider = new AwsSmsProvider();
        break;
      default:
        this.smsProvider = new MockSmsProvider();
    }
  }

  /**
   * Send SMS verification code
   */
  async sendVerificationCode(
    options: SmsVerificationOptions
  ): Promise<SmsVerificationResult> {
    const { userId, phoneNumber, purpose, ipAddress, userAgent } = options;

    // Validate phone number format
    if (!this.isValidPhoneNumber(phoneNumber)) {
      return {
        success: false,
        message: 'Invalid phone number format',
      };
    }

    // Check rate limiting
    const rateLimitCheck = await this.checkRateLimit(userId, phoneNumber);
    if (!rateLimitCheck.allowed) {
      return {
        success: false,
        message: rateLimitCheck.message,
      };
    }

    // Generate verification code
    const code = this.generateVerificationCode();
    const hashedCode = await bcrypt.hash(code, 12);
    const encryptedPhone = EncryptionUtil.encrypt(phoneNumber);

    // Store verification code
    const expiresAt = new Date(Date.now() + SMS_CONFIG.CODE_EXPIRY);

    await db.insert(smsVerificationCodes).values({
      userId,
      phoneNumber: encryptedPhone,
      code: hashedCode,
      purpose,
      expiresAt,
    });

    // Prepare SMS message
    const message = this.formatSmsMessage(code, purpose);

    // Send SMS
    let smsSuccess: boolean;
    try {
      smsSuccess = await this.smsProvider.sendSms(phoneNumber, message);
    } catch (error) {
      securityLogger.error('SMS send failed', { error: (error as Error).message, phoneNumber: phoneNumber.slice(-4) });
      smsSuccess = false;
    }

    if (!smsSuccess) {
      await this.logSecurityEvent({
        userId,
        eventType: 'sms_send_failed',
        severity: 'medium',
        description: `Failed to send SMS verification code for ${purpose}`,
        ipAddress,
        userAgent,
        metadata: { phoneNumber: this.maskPhoneNumber(phoneNumber), purpose },
      });

      return {
        success: false,
        message: 'Failed to send SMS. Please try again later.',
      };
    }

    // Log security event
    await this.logSecurityEvent({
      userId,
      eventType: 'sms_verification_sent',
      severity: 'low',
      description: `SMS verification code sent for ${purpose}`,
      ipAddress,
      userAgent,
      metadata: { phoneNumber: this.maskPhoneNumber(phoneNumber), purpose },
    });

    return {
      success: true,
      message: 'Verification code sent via SMS',
    };
  }

  /**
   * Verify SMS code
   */
  async verifyCode(
    userId: number,
    phoneNumber: string,
    code: string,
    purpose: 'mfa_login' | 'mfa_setup' | 'password_reset',
    ipAddress?: string,
    userAgent?: string
  ): Promise<SmsVerificationResult> {
    // Find pending verification code
    const encryptedPhone = EncryptionUtil.encrypt(phoneNumber);

    const verificationRecords = await db
      .select()
      .from(smsVerificationCodes)
      .where(
        and(
          eq(smsVerificationCodes.userId, userId),
          eq(smsVerificationCodes.phoneNumber, encryptedPhone),
          eq(smsVerificationCodes.purpose, purpose),
          eq(smsVerificationCodes.isUsed, false),
          gt(smsVerificationCodes.expiresAt, new Date())
        )
      );

    if (verificationRecords.length === 0) {
      await this.logSecurityEvent({
        userId,
        eventType: 'sms_verification_failed',
        severity: 'medium',
        description: 'SMS verification failed: No valid code found',
        ipAddress,
        userAgent,
        metadata: {
          phoneNumber: this.maskPhoneNumber(phoneNumber),
          purpose,
          reason: 'no_valid_code',
        },
      });

      return {
        success: false,
        message: 'No valid verification code found or code has expired',
      };
    }

    const record = verificationRecords[0];

    // Check attempt limit
    if ((record.attempts || 0) >= SMS_CONFIG.MAX_ATTEMPTS) {
      await this.logSecurityEvent({
        userId,
        eventType: 'sms_verification_failed',
        severity: 'high',
        description: 'SMS verification failed: Too many attempts',
        ipAddress,
        userAgent,
        metadata: {
          phoneNumber: this.maskPhoneNumber(phoneNumber),
          purpose,
          reason: 'max_attempts',
        },
      });

      return {
        success: false,
        message: 'Too many failed attempts. Please request a new code.',
      };
    }

    // Verify code
    const isValidCode = await bcrypt.compare(code, record.code);

    // Update attempts count
    await db
      .update(smsVerificationCodes)
      .set({
        attempts: (record.attempts || 0) + 1,
        isUsed: isValidCode,
      })
      .where(eq(smsVerificationCodes.id, record.id));

    if (!isValidCode) {
      const attemptsRemaining =
        SMS_CONFIG.MAX_ATTEMPTS - ((record.attempts || 0) + 1);

      await this.logSecurityEvent({
        userId,
        eventType: 'sms_verification_failed',
        severity: 'medium',
        description: 'SMS verification failed: Invalid code',
        ipAddress,
        userAgent,
        metadata: {
          phoneNumber: this.maskPhoneNumber(phoneNumber),
          purpose,
          reason: 'invalid_code',
          attemptsRemaining,
        },
      });

      return {
        success: false,
        message: 'Invalid verification code',
        attemptsRemaining,
      };
    }

    // Success - log and return
    await this.logSecurityEvent({
      userId,
      eventType: 'sms_verification_success',
      severity: 'low',
      description: `SMS verification successful for ${purpose}`,
      ipAddress,
      userAgent,
      metadata: { phoneNumber: this.maskPhoneNumber(phoneNumber), purpose },
    });

    return {
      success: true,
      message: 'SMS verification successful',
    };
  }

  /**
   * Enable SMS for MFA
   */
  async enableSmsForMfa(userId: number, phoneNumber: string): Promise<boolean> {
    try {
      const encryptedPhone = EncryptionUtil.encrypt(phoneNumber);

      await db
        .update(userMfaSettings)
        .set({
          smsEnabled: true,
          phoneNumber: encryptedPhone,
          updatedAt: new Date(),
        })
        .where(eq(userMfaSettings.userId, userId));

      await this.logSecurityEvent({
        userId,
        eventType: 'sms_mfa_enabled',
        severity: 'medium',
        description: 'SMS MFA enabled for user account',
        metadata: { phoneNumber: this.maskPhoneNumber(phoneNumber) },
      });

      return true;
    } catch (error) {
      securityLogger.error('Enable SMS MFA error', { module: 'SmsService', operation: 'enableSmsForMfa', error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Disable SMS for MFA
   */
  async disableSmsForMfa(userId: number): Promise<boolean> {
    try {
      await db
        .update(userMfaSettings)
        .set({
          smsEnabled: false,
          phoneNumber: null,
          updatedAt: new Date(),
        })
        .where(eq(userMfaSettings.userId, userId));

      await this.logSecurityEvent({
        userId,
        eventType: 'sms_mfa_disabled',
        severity: 'medium',
        description: 'SMS MFA disabled for user account',
      });

      return true;
    } catch (error) {
      securityLogger.error('Disable SMS MFA error', { module: 'SmsService', operation: 'disableSmsForMfa', error: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  /**
   * Generate verification code
   */
  private generateVerificationCode(): string {
    let code = '';
    for (let i = 0; i < SMS_CONFIG.CODE_LENGTH; i++) {
      code += crypto.randomInt(0, 10).toString();
    }
    return code;
  }

  /**
   * Format SMS message
   */
  private formatSmsMessage(code: string, purpose: string): string {
    const purposeText =
      {
        mfa_login: 'multi-factor authentication',
        mfa_setup: 'MFA setup',
        password_reset: 'password reset',
      }[purpose] || 'verification';

    return `Your Wrfcoin ${purposeText} code is: ${code}. This code expires in 5 minutes. Do not share this code with anyone.`;
  }

  /**
   * Validate phone number format
   */
  private isValidPhoneNumber(phoneNumber: string): boolean {
    // Basic international phone number validation
    // In production, you might want to use a library like libphonenumber
    const phoneRegex = /^\+[1-9]\d{1,14}$/;
    return phoneRegex.test(phoneNumber);
  }

  /**
   * Mask phone number for logging
   */
  private maskPhoneNumber(phoneNumber: string): string {
    if (phoneNumber.length <= 4) return '****';
    return phoneNumber.substring(0, 4) + '*'.repeat(phoneNumber.length - 4);
  }

  /**
   * Check rate limiting
   *
   * Security Note: Rate limiting is currently implemented per userId only.
   * For enhanced security, consider implementing additional rate limiting per phone number
   * to prevent abuse scenarios such as:
   * - Multiple user accounts targeting the same phone number
   * - SMS flooding attacks on specific phone numbers
   *
   * Recommended enhancements:
   * 1. Add a separate rate limit table for phone numbers
   * 2. Implement a sliding window counter per phone number (e.g., max 5 SMS per hour per number)
   * 3. Consider implementing carrier-level rate limiting for production deployments
   * 4. Add monitoring/alerting for unusual SMS patterns to specific numbers
   */
  private async checkRateLimit(
    userId: number,
    phoneNumber: string
  ): Promise<{
    allowed: boolean;
    message?: string;
  }> {
    const now = new Date();
    const oneMinuteAgo = new Date(now.getTime() - SMS_CONFIG.RATE_LIMIT_WINDOW);
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    // Check recent SMS sends
    const recentSms = await db
      .select()
      .from(smsVerificationCodes)
      .where(
        and(
          eq(smsVerificationCodes.userId, userId),
          gt(smsVerificationCodes.createdAt, oneMinuteAgo)
        )
      );

    if (recentSms.length > 0) {
      return {
        allowed: false,
        message: 'Please wait before requesting another code',
      };
    }

    // Check hourly limit
    const hourlySms = await db
      .select()
      .from(smsVerificationCodes)
      .where(
        and(
          eq(smsVerificationCodes.userId, userId),
          gt(smsVerificationCodes.createdAt, oneHourAgo)
        )
      );

    if (hourlySms.length >= SMS_CONFIG.MAX_SMS_PER_HOUR) {
      return {
        allowed: false,
        message: 'SMS limit exceeded. Please try again later',
      };
    }

    return { allowed: true };
  }

  /**
   * Log security event
   */
  private async logSecurityEvent(event: InsertSecurityEvent): Promise<void> {
    await db.insert(securityEvents).values(event);
  }

  /**
   * Clean up expired SMS codes
   */
  async cleanupExpiredCodes(): Promise<void> {
    const now = new Date();

    await db
      .delete(smsVerificationCodes)
      .where(lt(smsVerificationCodes.expiresAt, now));
  }

  /**
   * Get SMS statistics
   */
  async getSmsStats(userId?: number): Promise<{
    totalSent: number;
    successfulVerifications: number;
    failedVerifications: number;
    averageVerificationTime: number;
  }> {
    // This would require additional tracking in production
    // For now, return basic statistics
    const whereCondition = userId
      ? eq(smsVerificationCodes.userId, userId)
      : undefined;

    const codes = await db
      .select()
      .from(smsVerificationCodes)
      .where(whereCondition);

    const successful = codes.filter(c => c.isUsed).length;
    const failed = codes.filter(
      c => !c.isUsed && (c.attempts || 0) >= SMS_CONFIG.MAX_ATTEMPTS
    ).length;

    return {
      totalSent: codes.length,
      successfulVerifications: successful,
      failedVerifications: failed,
      averageVerificationTime: 0, // Would need additional tracking
    };
  }
}

export const smsService = new SmsService();
