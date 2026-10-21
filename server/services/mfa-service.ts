import { generateSecret, generateURI, verifySync } from 'otplib';
import * as QRCode from 'qrcode';
import * as crypto from 'crypto';
import * as bcrypt from 'bcrypt';
import { eq, and, gt, lt, sql } from 'drizzle-orm';
import {
  userMfaSettings,
  mfaAttempts,
  userSessions,
  trustedDevices,
  mfaBackupCodeUsage,
  smsVerificationCodes,
  securityEvents,
  users,
  type UserMfaSettings,
  type InsertUserMfaSettings,
  type MfaAttempt,
  type InsertMfaAttempt,
  type TrustedDevice,
  type InsertTrustedDevice,
  type SecurityEvent,
  type InsertSecurityEvent,
} from '../../shared/schema.js';
import { db } from '../../database/connection.js';

// Configuration
const MFA_CONFIG = {
  TOTP_WINDOW: 2, // Allow 2 steps tolerance for time synchronization
  TOTP_STEP: 30, // 30-second window
  BACKUP_CODES_COUNT: 8,
  BACKUP_CODE_LENGTH: 10,
  SMS_CODE_LENGTH: 6,
  SMS_CODE_EXPIRY: 5 * 60 * 1000, // 5 minutes
  TRUSTED_DEVICE_EXPIRY: 30 * 24 * 60 * 60 * 1000, // 30 days
  SESSION_TIMEOUT: 8 * 60 * 60 * 1000, // 8 hours
  MAX_FAILED_ATTEMPTS: 5,
  LOCKOUT_DURATION: 15 * 60 * 1000, // 15 minutes
};

// Encryption utilities
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
    cipher.setAAD(Buffer.from('mfa-data'));

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
    decipher.setAAD(Buffer.from('mfa-data'));

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }
}

// MFA Service Interface
export interface MfaSetupResult {
  secret: string;
  qrCodeUrl: string;
  backupCodes: string[];
}

export interface MfaVerificationResult {
  success: boolean;
  requiresMfa: boolean;
  trustedDevice?: boolean;
  message?: string;
}

export interface TotpVerificationOptions {
  userId: number;
  token: string;
  deviceFingerprint?: string;
  trustDevice?: boolean;
  ipAddress?: string;
  userAgent?: string;
}

export interface SmsVerificationOptions {
  userId: number;
  phoneNumber: string;
  purpose: 'mfa_login' | 'mfa_setup' | 'password_reset';
  ipAddress?: string;
  userAgent?: string;
}

export class MfaService {
  /**
   * Generate TOTP secret and QR code for MFA setup
   */
  async generateTotpSetup(
    userId: number,
    userEmail: string
  ): Promise<MfaSetupResult> {
    // Generate secret
    const secret = generateSecret();

    // Create TOTP URL for QR code
    const totpUrl = generateURI({
      issuer: 'Wrfcoin',
      label: userEmail,
      secret,
    });

    // Generate QR code
    const qrCodeUrl = await QRCode.toDataURL(totpUrl);

    // Generate backup codes
    const backupCodes = this.generateBackupCodes();

    // Encrypt sensitive data
    const encryptedSecret = EncryptionUtil.encrypt(secret);
    const hashedBackupCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 12))
    );

    // Save MFA settings (but don't enable MFA yet)
    const existingSettings = await db
      .select()
      .from(userMfaSettings)
      .where(eq(userMfaSettings.userId, userId))
      .limit(1);

    if (existingSettings.length > 0) {
      await db
        .update(userMfaSettings)
        .set({
          totpSecret: encryptedSecret,
          backupCodes: hashedBackupCodes,
          lastBackupCodesGenerated: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(userMfaSettings.userId, userId));
    } else {
      await db.insert(userMfaSettings).values({
        userId,
        mfaEnabled: false,
        totpSecret: encryptedSecret,
        backupCodes: hashedBackupCodes,
        lastBackupCodesGenerated: new Date(),
      });
    }

    return {
      secret,
      qrCodeUrl,
      backupCodes,
    };
  }

  /**
   * Enable TOTP MFA after user confirms setup
   */
  async enableTotp(userId: number, token: string): Promise<boolean> {
    const settings = await this.getUserMfaSettings(userId);
    if (!settings?.totpSecret) {
      throw new Error('TOTP setup not found');
    }

    // Verify the token
    const secret = EncryptionUtil.decrypt(settings.totpSecret);
    const isValid = verifySync({
      token,
      secret,
    }).valid;

    if (!isValid) {
      await this.logMfaAttempt({
        userId,
        attemptType: 'totp',
        success: false,
        failureReason: 'Invalid TOTP token during setup',
      });
      return false;
    }

    // Enable MFA
    await db
      .update(userMfaSettings)
      .set({
        mfaEnabled: true,
        updatedAt: new Date(),
      })
      .where(eq(userMfaSettings.userId, userId));

    // Log security event
    await this.logSecurityEvent({
      userId,
      eventType: 'mfa_enabled',
      severity: 'medium',
      description: 'TOTP MFA enabled for user account',
    });

    await this.logMfaAttempt({
      userId,
      attemptType: 'totp',
      success: true,
    });

    return true;
  }

  /**
   * Verify TOTP token
   */
  async verifyTotp(
    options: TotpVerificationOptions
  ): Promise<MfaVerificationResult> {
    const {
      userId,
      token,
      deviceFingerprint,
      trustDevice,
      ipAddress,
      userAgent,
    } = options;

    // Check if device is already trusted
    if (deviceFingerprint) {
      const trustedDevice = await this.checkTrustedDevice(
        userId,
        deviceFingerprint
      );
      if (trustedDevice) {
        return {
          success: true,
          requiresMfa: false,
          trustedDevice: true,
        };
      }
    }

    // Check rate limiting
    const recentFailures = await this.getRecentFailedAttempts(userId);
    if (recentFailures >= MFA_CONFIG.MAX_FAILED_ATTEMPTS) {
      return {
        success: false,
        requiresMfa: true,
        message: 'Too many failed attempts. Please try again later.',
      };
    }

    const settings = await this.getUserMfaSettings(userId);
    if (!settings?.mfaEnabled || !settings.totpSecret) {
      return {
        success: false,
        requiresMfa: false,
        message: 'MFA not enabled for this user',
      };
    }

    // Verify token
    const secret = EncryptionUtil.decrypt(settings.totpSecret);
    const isValid = verifySync({
      token,
      secret,
    }).valid;

    // Log attempt
    await this.logMfaAttempt({
      userId,
      attemptType: 'totp',
      success: isValid,
      ipAddress,
      userAgent,
      deviceFingerprint,
      failureReason: isValid ? undefined : 'Invalid TOTP token',
    });

    if (!isValid) {
      return {
        success: false,
        requiresMfa: true,
        message: 'Invalid authentication code',
      };
    }

    // Add device as trusted if requested
    if (trustDevice && deviceFingerprint) {
      await this.addTrustedDevice({
        userId,
        deviceFingerprint,
        deviceName: 'Trusted Device',
        ipAddress,
        expiresAt: new Date(Date.now() + MFA_CONFIG.TRUSTED_DEVICE_EXPIRY),
      });
    }

    return {
      success: true,
      requiresMfa: false,
    };
  }

  /**
   * Verify backup code
   */
  async verifyBackupCode(
    userId: number,
    code: string
  ): Promise<MfaVerificationResult> {
    const settings = await this.getUserMfaSettings(userId);
    if (!settings?.mfaEnabled || !settings.backupCodes) {
      return {
        success: false,
        requiresMfa: false,
        message: 'MFA not enabled for this user',
      };
    }

    // Check if code was already used
    const usedCode = await db
      .select()
      .from(mfaBackupCodeUsage)
      .where(eq(mfaBackupCodeUsage.userId, userId))
      .limit(1);

    const codeHash = await bcrypt.hash(code, 12);
    const isUsed = usedCode.some(usage => usage.codeHash === codeHash);

    if (isUsed) {
      await this.logMfaAttempt({
        userId,
        attemptType: 'backup_code',
        success: false,
        failureReason: 'Backup code already used',
      });

      return {
        success: false,
        requiresMfa: true,
        message: 'This backup code has already been used',
      };
    }

    // Verify code against stored hashes
    const backupCodes = settings.backupCodes as string[];
    let isValid = false;

    for (const storedHash of backupCodes) {
      if (await bcrypt.compare(code, storedHash)) {
        isValid = true;
        break;
      }
    }

    if (!isValid) {
      await this.logMfaAttempt({
        userId,
        attemptType: 'backup_code',
        success: false,
        failureReason: 'Invalid backup code',
      });

      return {
        success: false,
        requiresMfa: true,
        message: 'Invalid backup code',
      };
    }

    // Mark code as used
    await db.insert(mfaBackupCodeUsage).values({
      userId,
      codeHash,
    });

    await this.logMfaAttempt({
      userId,
      attemptType: 'backup_code',
      success: true,
    });

    return {
      success: true,
      requiresMfa: false,
    };
  }

  /**
   * Generate new backup codes
   */
  async regenerateBackupCodes(userId: number): Promise<string[]> {
    const backupCodes = this.generateBackupCodes();
    const hashedCodes = await Promise.all(
      backupCodes.map(code => bcrypt.hash(code, 12))
    );

    await db
      .update(userMfaSettings)
      .set({
        backupCodes: hashedCodes,
        lastBackupCodesGenerated: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(userMfaSettings.userId, userId));

    await this.logSecurityEvent({
      userId,
      eventType: 'backup_codes_regenerated',
      severity: 'medium',
      description: 'Backup codes regenerated',
    });

    return backupCodes;
  }

  /**
   * Disable MFA for user
   */
  async disableMfa(userId: number): Promise<void> {
    await db
      .update(userMfaSettings)
      .set({
        mfaEnabled: false,
        totpSecret: null,
        backupCodes: null,
        smsEnabled: false,
        phoneNumber: null,
        updatedAt: new Date(),
      })
      .where(eq(userMfaSettings.userId, userId));

    // Remove all trusted devices
    await db
      .update(trustedDevices)
      .set({
        isActive: false,
      })
      .where(eq(trustedDevices.userId, userId));

    await this.logSecurityEvent({
      userId,
      eventType: 'mfa_disabled',
      severity: 'high',
      description: 'MFA disabled for user account',
    });
  }

  /**
   * Get user MFA settings
   */
  async getUserMfaSettings(userId: number): Promise<UserMfaSettings | null> {
    const result = await db
      .select()
      .from(userMfaSettings)
      .where(eq(userMfaSettings.userId, userId))
      .limit(1);

    return result[0] || null;
  }

  /**
   * Check if device is trusted
   */
  async checkTrustedDevice(
    userId: number,
    deviceFingerprint: string
  ): Promise<boolean> {
    const result = await db
      .select()
      .from(trustedDevices)
      .where(
        and(
          eq(trustedDevices.userId, userId),
          eq(trustedDevices.deviceFingerprint, deviceFingerprint),
          eq(trustedDevices.isActive, true),
          gt(trustedDevices.expiresAt, new Date())
        )
      )
      .limit(1);

    if (result.length > 0) {
      // Update last used timestamp
      await db
        .update(trustedDevices)
        .set({
          lastUsed: new Date(),
        })
        .where(eq(trustedDevices.id, result[0].id));

      return true;
    }

    return false;
  }

  /**
   * Add trusted device
   */
  async addTrustedDevice(device: InsertTrustedDevice): Promise<void> {
    await db.insert(trustedDevices).values(device);
  }

  /**
   * Get user's trusted devices
   */
  async getTrustedDevices(userId: number): Promise<TrustedDevice[]> {
    return await db
      .select()
      .from(trustedDevices)
      .where(
        and(
          eq(trustedDevices.userId, userId),
          eq(trustedDevices.isActive, true),
          gt(trustedDevices.expiresAt, new Date())
        )
      );
  }

  /**
   * Remove trusted device
   */
  async removeTrustedDevice(userId: number, deviceId: number): Promise<void> {
    await db
      .update(trustedDevices)
      .set({
        isActive: false,
      })
      .where(
        and(eq(trustedDevices.id, deviceId), eq(trustedDevices.userId, userId))
      );
  }

  /**
   * Generate backup codes using cryptographically secure random bytes
   * Uses alphanumeric charset excluding confusing characters (0/O, 1/I/L)
   */
  private generateBackupCodes(): string[] {
    // Alphanumeric charset without confusing characters (no 0/O, 1/I/L)
    const BACKUP_CODE_CHARSET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const BACKUP_CODE_LENGTH = 12; // Increased from 10-digit numeric to 12-char alphanumeric
    const codes: string[] = [];

    for (let i = 0; i < MFA_CONFIG.BACKUP_CODES_COUNT; i++) {
      const randomBytes = crypto.randomBytes(BACKUP_CODE_LENGTH);
      let code = '';
      for (let j = 0; j < BACKUP_CODE_LENGTH; j++) {
        // Use modulo to map random byte to charset index
        code += BACKUP_CODE_CHARSET[randomBytes[j] % BACKUP_CODE_CHARSET.length];
      }
      codes.push(code);
    }

    return codes;
  }

  /**
   * Log MFA attempt
   */
  async logMfaAttempt(attempt: InsertMfaAttempt): Promise<void> {
    await db.insert(mfaAttempts).values(attempt);
  }

  /**
   * Log security event
   */
  async logSecurityEvent(event: InsertSecurityEvent): Promise<void> {
    await db.insert(securityEvents).values(event);
  }

  /**
   * Get recent failed attempts count
   */
  private async getRecentFailedAttempts(userId: number): Promise<number> {
    const fifteenMinutesAgo = new Date(
      Date.now() - MFA_CONFIG.LOCKOUT_DURATION
    );

    const result = await db
      .select({
        count: sql<number>`count(*)`,
      })
      .from(mfaAttempts)
      .where(
        and(
          eq(mfaAttempts.userId, userId),
          eq(mfaAttempts.success, false),
          gt(mfaAttempts.createdAt, fifteenMinutesAgo)
        )
      );

    return result[0]?.count || 0;
  }

  /**
   * Clean up expired data
   */
  async cleanupExpiredData(): Promise<void> {
    const now = new Date();

    // Remove expired trusted devices
    await db
      .update(trustedDevices)
      .set({
        isActive: false,
      })
      .where(
        and(
          eq(trustedDevices.isActive, true),
          lt(trustedDevices.expiresAt, sql`${now}`)
        )
      );

    // Remove expired SMS codes
    await db
      .delete(smsVerificationCodes)
      .where(lt(smsVerificationCodes.expiresAt, sql`${now}`));

    // Remove old MFA attempts (older than 30 days)
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await db
      .delete(mfaAttempts)
      .where(lt(mfaAttempts.createdAt, sql`${thirtyDaysAgo}`));
  }
}

export const mfaService = new MfaService();
