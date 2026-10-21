import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { mfaService } from '../services/mfa-service.js';
import { smsService } from '../services/sms-service.js';
import { users } from '../../shared/schema.js';
import { drizzle } from 'drizzle-orm/postgres-js';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { securityLogger, logError } from '../utils/logger.js';
import { requireAdmin } from '../middleware/rbac-middleware.js';

const router = Router();

// Verify endpoints (/verify/totp, /verify/backup-code, /sms/verify) are
// public — they run during step-up auth before a full JWT is issued.
// Setup, management, and admin endpoints require authenticateJWT per-route.

// Lazy database connection — avoids blocking the event loop at module scope
// when running inside an esbuild CJS bundle (#267).
let _db: ReturnType<typeof drizzle> | null = null;
function getDb() {
  if (!_db) {
    const connectionString =
      process.env.DATABASE_URL || 'postgresql://localhost:5432/wrfcoin';
    _db = drizzle(postgres(connectionString), { schema: { users } });
  }
  return _db;
}

// Middleware to extract user ID from JWT or session
const getUserId = async (req: Request): Promise<number | null> => {
  // This should be implemented based on your existing authentication system
  // For now, we'll assume the user ID is available in req.user.id
  const user = (req as any).user;
  return user?.id || null;
};

// Standard API response helpers
const successResponse = <T>(data: T) => ({
  success: true,
  data,
  timestamp: new Date().toISOString(),
});

const errorResponse = (message: string, code?: string) => ({
  success: false,
  error: {
    code: code || 'MFA_ERROR',
    message,
  },
  timestamp: new Date().toISOString(),
});

// Validation middleware
const validateTotpToken = [
  body('token')
    .isString()
    .isLength({ min: 6, max: 6 })
    .matches(/^\d{6}$/)
    .withMessage('TOTP token must be 6 digits'),
];

const validateBackupCode = [
  body('code')
    .isString()
    .isLength({ min: 10, max: 10 })
    .matches(/^\d{10}$/)
    .withMessage('Backup code must be 10 digits'),
];

const validateDeviceInfo = [
  body('deviceFingerprint')
    .optional()
    .isString()
    .isLength({ min: 1, max: 255 }),
  body('deviceName').optional().isString().isLength({ min: 1, max: 100 }),
];

// POST /api/mfa/setup/totp - Start TOTP setup
router.post('/setup/totp', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
      return;
    }

    // Get user email for QR code
    const userResult = await getDb()
      .select({ email: users.email })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!userResult.length) {
      res.status(404).json(errorResponse('User not found'));
      return;
    }

    const userEmail = userResult[0].email || `user${userId}@wrfcoin.local`;

    const setupResult = await mfaService.generateTotpSetup(userId, userEmail);

    res.status(200).json(
      successResponse({
        qrCodeUrl: setupResult.qrCodeUrl,
        backupCodes: setupResult.backupCodes,
        message:
          'TOTP setup initiated. Save backup codes securely and scan QR code with authenticator app.',
      })
    );
  } catch (error) {
    logError(securityLogger, 'TOTP setup error', error as Error, { service: 'mfa' });
    res.status(500).json(errorResponse('Failed to setup TOTP', 'SETUP_ERROR'));
  }
});

// POST /api/mfa/enable/totp - Enable TOTP after verification
router.post(
  '/enable/totp',
  authenticateJWT,
  validateTotpToken,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(
          errorResponse(
            'Validation failed: ' +
              errors
                .array()
                .map(e => e.msg)
                .join(', ')
          )
        );
        return;
      }

      const userId = await getUserId(req);
      if (!userId) {
        res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
        return;
      }

      const { token }: { token: string } = req.body;

      const success = await mfaService.enableTotp(userId, token);

      if (!success) {
        res.status(400).json(errorResponse('Operation failed'));
        return;
      }

      res.status(200).json(
        successResponse({
          message: 'TOTP MFA enabled successfully',
        })
      );
    } catch (error) {
      logError(securityLogger, 'TOTP enable error', error as Error, { service: 'mfa' });
      const message =
        error instanceof Error ? error.message : 'Failed to enable TOTP';
      res.status(500).json(errorResponse(message, 'ENABLE_ERROR'));
    }
  }
);

// POST /api/mfa/verify/totp - Verify TOTP token
router.post(
  '/verify/totp',
  [...validateTotpToken, ...validateDeviceInfo],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(
          errorResponse(
            'Validation failed: ' +
              errors
                .array()
                .map(e => e.msg)
                .join(', ')
          )
        );
        return;
      }

      const userId = await getUserId(req);
      if (!userId) {
        res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
        return;
      }

      const {
        token,
        deviceFingerprint,
        trustDevice,
      }: { token: string; deviceFingerprint?: string; trustDevice?: boolean } =
        req.body;

      const result = await mfaService.verifyTotp({
        userId,
        token,
        deviceFingerprint,
        trustDevice,
        ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
        userAgent: req.get('User-Agent'),
      });

      if (!result.success) {
        res.status(401).json(errorResponse('Verification failed'));
        return;
      }

      res.status(200).json(
        successResponse({
          verified: true,
          trustedDevice: result.trustedDevice,
          message: 'TOTP verification successful',
        })
      );
    } catch (error) {
      logError(securityLogger, 'TOTP verify error', error as Error, { service: 'mfa' });
      res
        .status(500)
        .json(errorResponse('Failed to verify TOTP', 'VERIFY_ERROR'));
    }
  }
);

// POST /api/mfa/verify/backup-code - Verify backup code
router.post(
  '/verify/backup-code',
  validateBackupCode,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(
          errorResponse(
            'Validation failed: ' +
              errors
                .array()
                .map(e => e.msg)
                .join(', ')
          )
        );
        return;
      }

      const userId = await getUserId(req);
      if (!userId) {
        res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
        return;
      }

      const { code }: { code: string } = req.body;

      const result = await mfaService.verifyBackupCode(userId, code);

      if (!result.success) {
        res.status(401).json(errorResponse('Verification failed'));
        return;
      }

      res.status(200).json(
        successResponse({
          verified: true,
          message: 'Backup code verification successful',
        })
      );
    } catch (error) {
      logError(securityLogger, 'Backup code verify error', error as Error, { service: 'mfa' });
      res
        .status(500)
        .json(errorResponse('Failed to verify backup code', 'VERIFY_ERROR'));
    }
  }
);

// POST /api/mfa/backup-codes/regenerate - Generate new backup codes
router.post('/backup-codes/regenerate', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
      return;
    }

    const backupCodes = await mfaService.regenerateBackupCodes(userId);

    res.status(200).json(
      successResponse({
        backupCodes,
        message: 'New backup codes generated. Save them securely.',
      })
    );
  } catch (error) {
    logError(securityLogger, 'Backup codes regeneration error', error as Error, { service: 'mfa' });
    res
      .status(500)
      .json(
        errorResponse('Failed to regenerate backup codes', 'REGENERATE_ERROR')
      );
  }
});

// GET /api/mfa/status - Get MFA status for user
router.get('/status', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
      return;
    }

    const settings = await mfaService.getUserMfaSettings(userId);
    const trustedDevices = await mfaService.getTrustedDevices(userId);

    res.status(200).json(
      successResponse({
        mfaEnabled: settings?.mfaEnabled || false,
        totpEnabled: !!(settings?.mfaEnabled && settings?.totpSecret),
        smsEnabled: settings?.smsEnabled || false,
        backupCodesGenerated: !!settings?.backupCodes,
        lastBackupCodesGenerated: settings?.lastBackupCodesGenerated,
        trustedDevicesCount: trustedDevices.length,
      })
    );
  } catch (error) {
    logError(securityLogger, 'MFA status error', error as Error, { service: 'mfa' });
    res
      .status(500)
      .json(errorResponse('Failed to get MFA status', 'STATUS_ERROR'));
  }
});

// GET /api/mfa/trusted-devices - Get trusted devices
router.get('/trusted-devices', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
      return;
    }

    const trustedDevices = await mfaService.getTrustedDevices(userId);

    // Remove sensitive fingerprint data from response
    const safeDevices = trustedDevices.map(device => ({
      id: device.id,
      deviceName: device.deviceName,
      deviceType: device.deviceType,
      browser: device.browser,
      operatingSystem: device.operatingSystem,
      lastUsed: device.lastUsed,
      expiresAt: device.expiresAt,
      createdAt: device.createdAt,
    }));

    res.status(200).json(
      successResponse({
        devices: safeDevices,
      })
    );
  } catch (error) {
    logError(securityLogger, 'Trusted devices error', error as Error, { service: 'mfa' });
    res
      .status(500)
      .json(errorResponse('Failed to get trusted devices', 'DEVICES_ERROR'));
  }
});

// DELETE /api/mfa/trusted-devices/:deviceId - Remove trusted device
router.delete(
  '/trusted-devices/:deviceId',
  authenticateJWT,
  async (req: Request, res: Response) => {
    try {
      const userId = await getUserId(req);
      if (!userId) {
        res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
        return;
      }

      const deviceId = parseInt(req.params.deviceId, 10);
      if (isNaN(deviceId)) {
        res.status(400).json(errorResponse('Invalid device ID'));
        return;
      }

      await mfaService.removeTrustedDevice(userId, deviceId);

      res.status(200).json(
        successResponse({
          message: 'Trusted device removed successfully',
        })
      );
    } catch (error) {
      logError(securityLogger, 'Remove trusted device error', error as Error, { service: 'mfa' });
      res
        .status(500)
        .json(
          errorResponse(
            'Failed to remove trusted device',
            'REMOVE_DEVICE_ERROR'
          )
        );
    }
  }
);

// POST /api/mfa/disable - Disable MFA
router.post(
  '/disable',
  authenticateJWT,
  validateTotpToken,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(
          errorResponse(
            'Validation failed: ' +
              errors
                .array()
                .map(e => e.msg)
                .join(', ')
          )
        );
        return;
      }

      const userId = await getUserId(req);
      if (!userId) {
        res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
        return;
      }

      const { token }: { token: string } = req.body;

      // Verify TOTP token before disabling
      const verificationResult = await mfaService.verifyTotp({
        userId,
        token,
        ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
        userAgent: req.get('User-Agent'),
      });

      if (!verificationResult.success) {
        res.status(401).json(errorResponse('Verification failed'));
        return;
      }

      await mfaService.disableMfa(userId);

      res.status(200).json(
        successResponse({
          message: 'MFA disabled successfully',
        })
      );
    } catch (error) {
      logError(securityLogger, 'MFA disable error', error as Error, { service: 'mfa' });
      res
        .status(500)
        .json(errorResponse('Failed to disable MFA', 'DISABLE_ERROR'));
    }
  }
);

// SMS-specific routes

// POST /api/mfa/sms/send - Send SMS verification code
router.post(
  '/sms/send',
  authenticateJWT,
  [
    body('phoneNumber')
      .isString()
      .matches(/^\+[1-9]\d{1,14}$/)
      .withMessage(
        'Phone number must be in international format (e.g., +1234567890)'
      ),
    body('purpose')
      .isIn(['mfa_login', 'mfa_setup', 'password_reset'])
      .withMessage(
        'Purpose must be one of: mfa_login, mfa_setup, password_reset'
      ),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(
          errorResponse(
            'Validation failed: ' +
              errors
                .array()
                .map(e => e.msg)
                .join(', ')
          )
        );
        return;
      }

      const userId = await getUserId(req);
      if (!userId) {
        res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
        return;
      }

      const {
        phoneNumber,
        purpose,
      }: {
        phoneNumber: string;
        purpose: 'mfa_login' | 'mfa_setup' | 'password_reset';
      } = req.body;

      const result = await smsService.sendVerificationCode({
        userId,
        phoneNumber,
        purpose,
        ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
        userAgent: req.get('User-Agent'),
      });

      if (!result.success) {
        res.status(401).json(errorResponse('Verification failed'));
        return;
      }

      res.status(200).json(
        successResponse({
          message: result.message,
        })
      );
    } catch (error) {
      logError(securityLogger, 'SMS send error', error as Error, { service: 'mfa' });
      res
        .status(500)
        .json(
          errorResponse(
            'Failed to send SMS verification code',
            'SMS_SEND_ERROR'
          )
        );
    }
  }
);

// POST /api/mfa/sms/verify - Verify SMS code
router.post(
  '/sms/verify',
  [
    body('phoneNumber')
      .isString()
      .matches(/^\+[1-9]\d{1,14}$/)
      .withMessage('Phone number must be in international format'),
    body('code')
      .isString()
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage('SMS code must be 6 digits'),
    body('purpose')
      .isIn(['mfa_login', 'mfa_setup', 'password_reset'])
      .withMessage(
        'Purpose must be one of: mfa_login, mfa_setup, password_reset'
      ),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(
          errorResponse(
            'Validation failed: ' +
              errors
                .array()
                .map(e => e.msg)
                .join(', ')
          )
        );
        return;
      }

      const userId = await getUserId(req);
      if (!userId) {
        res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
        return;
      }

      const {
        phoneNumber,
        code,
        purpose,
      }: {
        phoneNumber: string;
        code: string;
        purpose: 'mfa_login' | 'mfa_setup' | 'password_reset';
      } = req.body;

      const result = await smsService.verifyCode(
        userId,
        phoneNumber,
        code,
        purpose,
        req.ip || req.connection.remoteAddress || 'unknown',
        req.get('User-Agent')
      );

      if (!result.success) {
        res.status(401).json(errorResponse('Verification failed'));
        return;
      }

      res.status(200).json(
        successResponse({
          verified: true,
          message: result.message,
        })
      );
    } catch (error) {
      logError(securityLogger, 'SMS verify error', error as Error, { service: 'mfa' });
      res
        .status(500)
        .json(errorResponse('Failed to verify SMS code', 'SMS_VERIFY_ERROR'));
    }
  }
);

// POST /api/mfa/sms/enable - Enable SMS for MFA
router.post(
  '/sms/enable',
  authenticateJWT,
  [
    body('phoneNumber')
      .isString()
      .matches(/^\+[1-9]\d{1,14}$/)
      .withMessage('Phone number must be in international format'),
    body('verificationCode')
      .isString()
      .isLength({ min: 6, max: 6 })
      .matches(/^\d{6}$/)
      .withMessage('Verification code must be 6 digits'),
  ],
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(
          errorResponse(
            'Validation failed: ' +
              errors
                .array()
                .map(e => e.msg)
                .join(', ')
          )
        );
        return;
      }

      const userId = await getUserId(req);
      if (!userId) {
        res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
        return;
      }

      const {
        phoneNumber,
        verificationCode,
      }: { phoneNumber: string; verificationCode: string } = req.body;

      // First verify the SMS code
      const verifyResult = await smsService.verifyCode(
        userId,
        phoneNumber,
        verificationCode,
        'mfa_setup',
        req.ip || req.connection.remoteAddress || 'unknown',
        req.get('User-Agent')
      );

      if (!verifyResult.success) {
        res.status(401).json(errorResponse('SMS verification failed'));
        return;
      }

      // Enable SMS for MFA
      const enableResult = await smsService.enableSmsForMfa(
        userId,
        phoneNumber
      );

      if (!enableResult) {
        res.status(400).json(errorResponse('Failed to enable SMS MFA'));
        return;
      }

      res.status(200).json(
        successResponse({
          message: 'SMS MFA enabled successfully',
          phoneNumber:
            phoneNumber.substring(0, 4) + '*'.repeat(phoneNumber.length - 4),
        })
      );
    } catch (error) {
      logError(securityLogger, 'SMS enable error', error as Error, { service: 'mfa' });
      res
        .status(500)
        .json(errorResponse('Failed to enable SMS MFA', 'SMS_ENABLE_ERROR'));
    }
  }
);

// POST /api/mfa/sms/disable - Disable SMS for MFA
router.post(
  '/sms/disable',
  authenticateJWT,
  validateTotpToken,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        res.status(400).json(
          errorResponse(
            'Validation failed: ' +
              errors
                .array()
                .map(e => e.msg)
                .join(', ')
          )
        );
        return;
      }

      const userId = await getUserId(req);
      if (!userId) {
        res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
        return;
      }

      const { token }: { token: string } = req.body;

      // Verify TOTP token before disabling SMS
      const verificationResult = await mfaService.verifyTotp({
        userId,
        token,
        ipAddress: req.ip || req.connection.remoteAddress || 'unknown',
        userAgent: req.get('User-Agent'),
      });

      if (!verificationResult.success) {
        res.status(401).json(errorResponse('Verification failed'));
        return;
      }

      const success = await smsService.disableSmsForMfa(userId);

      if (!success) {
        res.status(400).json(errorResponse('Operation failed'));
        return;
      }

      res.status(200).json(
        successResponse({
          message: 'SMS MFA disabled successfully',
        })
      );
    } catch (error) {
      logError(securityLogger, 'SMS disable error', error as Error, { service: 'mfa' });
      res
        .status(500)
        .json(errorResponse('Failed to disable SMS MFA', 'SMS_DISABLE_ERROR'));
    }
  }
);

// GET /api/mfa/sms/stats - Get SMS statistics (admin only)
// Issue #133: requireAdmin() enforces RBAC; audit logging added for admin action tracking
router.get('/sms/stats', authenticateJWT, requireAdmin(), async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
      return;
    }

    securityLogger.info('Admin action: viewing SMS stats', {
      adminUserId: userId,
      action: 'mfa:sms:stats:view',
      ip: req.ip || req.connection?.remoteAddress,
    });

    const stats = await smsService.getSmsStats(userId);

    res.status(200).json(successResponse(stats));
  } catch (error) {
    logError(securityLogger, 'SMS stats error', error as Error, { service: 'mfa' });
    res
      .status(500)
      .json(errorResponse('Failed to get SMS statistics', 'SMS_STATS_ERROR'));
  }
});

// Cleanup endpoint (admin only)
// Issue #133: requireAdmin() enforces RBAC; audit logging added for admin action tracking
router.post('/cleanup', authenticateJWT, requireAdmin(), async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
      return;
    }

    securityLogger.info('Admin action: MFA data cleanup initiated', {
      adminUserId: userId,
      action: 'mfa:cleanup:execute',
      ip: req.ip || req.connection?.remoteAddress,
    });

    await Promise.all([
      mfaService.cleanupExpiredData(),
      smsService.cleanupExpiredCodes(),
    ]);

    securityLogger.info('Admin action: MFA data cleanup completed', {
      adminUserId: userId,
      action: 'mfa:cleanup:complete',
    });

    res.status(200).json(
      successResponse({
        message: 'Expired data cleaned up successfully',
      })
    );
  } catch (error) {
    logError(securityLogger, 'MFA cleanup error', error as Error, { service: 'mfa' });
    res
      .status(500)
      .json(errorResponse('Failed to cleanup expired data', 'CLEANUP_ERROR'));
  }
});

export default router;
