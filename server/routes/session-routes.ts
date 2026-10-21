import { Router, Request, Response } from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { body, validationResult } from 'express-validator';
import { sessionService } from '../services/session-service.js';
import { deviceService } from '../services/device-service.js';
import { requireAdmin } from '../middleware/rbac-middleware.js';
import { securityLogger, logError } from '../utils/logger.js';

const router = Router();

// Per-route auth applied to all existing session management routes.
// Session creation (if added later) may need to be public.

// Middleware to extract user ID from JWT or session
const getUserId = async (req: Request): Promise<number | null> => {
  // This should be implemented based on your existing authentication system
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
    code: code || 'SESSION_ERROR',
    message,
  },
  timestamp: new Date().toISOString(),
});

// Validation middleware
const validateDeviceInfo = [
  body('deviceFingerprint')
    .optional()
    .isString()
    .isLength({ min: 1, max: 255 }),
  body('deviceName').optional().isString().isLength({ min: 1, max: 100 }),
];

// GET /api/sessions - Get user's active sessions
router.get('/', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
    }

    const sessions = await sessionService.getUserActiveSessions(userId);

    // Remove sensitive session IDs from response
    const safeSessions = sessions.map(session => ({
      id: session.id,
      deviceName: session.deviceName,
      deviceFingerprint: session.deviceFingerprint?.substring(0, 8) + '...',
      ipAddress: session.ipAddress,
      lastActivityAt: session.lastActivityAt,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      mfaVerified: session.mfaVerified,
    }));

    return res.status(200).json(
      successResponse({
        sessions: safeSessions,
        count: safeSessions.length,
      })
    );
  } catch (error) {
    logError(securityLogger, 'Get sessions error', error as Error, { service: 'session' });
    return res
      .status(500)
      .json(errorResponse('Failed to get sessions', 'GET_SESSIONS_ERROR'));
  }
});

// POST /api/sessions/extend - Extend current session
router.post('/extend', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
    }

    // SECURITY FIX (102.5): Only accept session ID from HttpOnly cookies to prevent session fixation
    // Header-based session IDs are vulnerable to XSS attacks and session hijacking
    const sessionId = req.cookies?.sessionId;

    if (!sessionId) {
      return res.status(401).json(errorResponse('Session cookie required', 'SESSION_COOKIE_REQUIRED'));
    }

    const success = await sessionService.extendSession(sessionId);

    if (!success) {
      return res
        .status(404)
        .json(errorResponse('Session not found or expired'));
    }

    return res.status(200).json(
      successResponse({
        message: 'Session extended successfully',
      })
    );
  } catch (error) {
    logError(securityLogger, 'Extend session error', error as Error, { service: 'session' });
    return res
      .status(500)
      .json(errorResponse('Failed to extend session', 'EXTEND_ERROR'));
  }
});

// DELETE /api/sessions/:sessionId - Remove specific session
router.delete('/:sessionId', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
    }

    const sessionId = req.params.sessionId;

    const success = await sessionService.removeSession(userId, sessionId);

    if (!success) {
      return res.status(404).json(errorResponse('Session not found'));
    }

    return res.status(200).json(
      successResponse({
        message: 'Session removed successfully',
      })
    );
  } catch (error) {
    logError(securityLogger, 'Remove session error', error as Error, { service: 'session' });
    return res
      .status(500)
      .json(errorResponse('Failed to remove session', 'REMOVE_SESSION_ERROR'));
  }
});

// DELETE /api/sessions/all - Remove all other sessions
router.delete('/all', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
    }

    // SECURITY FIX (102.5): Only accept session ID from HttpOnly cookies to prevent session fixation
    // Header-based session IDs are vulnerable to XSS attacks and session hijacking
    const currentSessionId = req.cookies?.sessionId;

    await sessionService.invalidateAllUserSessions(userId, currentSessionId);

    return res.status(200).json(
      successResponse({
        message: 'All other sessions removed successfully',
      })
    );
  } catch (error) {
    logError(securityLogger, 'Remove all sessions error', error as Error, { service: 'session' });
    return res
      .status(500)
      .json(
        errorResponse('Failed to remove sessions', 'REMOVE_ALL_SESSIONS_ERROR')
      );
  }
});

// GET /api/sessions/stats - Get session statistics (admin only)
// Task 94.11: Using RBAC middleware for admin authorization
router.get('/stats', authenticateJWT, requireAdmin(), async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
    }

    const stats = await sessionService.getSessionStats();

    return res.status(200).json(successResponse(stats));
  } catch (error) {
    logError(securityLogger, 'Session stats error', error as Error, { service: 'session' });
    return res
      .status(500)
      .json(errorResponse('Failed to get session stats', 'STATS_ERROR'));
  }
});

// POST /api/sessions/analyze-device - Analyze device for security
router.post(
  '/analyze-device',
  authenticateJWT,
  validateDeviceInfo,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res
          .status(400)
          .json(errorResponse('Invalid request data', 'VALIDATION_ERROR'));
      }

      const userId = await getUserId(req);
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
      }

      const userAgent = req.get('User-Agent') || '';
      const ipAddress = req.ip;

      // Parse device information
      const deviceInfo = deviceService.parseDeviceInfo(
        userAgent,
        req.body.deviceFingerprint
      );

      // Analyze device for security risks
      const analysis = await deviceService.analyzeDevice(
        userId,
        deviceInfo,
        ipAddress
      );

      return res.status(200).json(
        successResponse({
          deviceInfo: {
            deviceName: deviceInfo.deviceName,
            deviceType: deviceInfo.deviceType,
            browser: deviceInfo.browser,
            operatingSystem: deviceInfo.operatingSystem,
          },
          analysis,
        })
      );
    } catch (error) {
      logError(securityLogger, 'Device analysis error', error as Error, { service: 'session' });
      return res
        .status(500)
        .json(
          errorResponse('Failed to analyze device', 'DEVICE_ANALYSIS_ERROR')
        );
    }
  }
);

// POST /api/sessions/trust-device - Mark device as trusted
router.post(
  '/trust-device',
  authenticateJWT,
  validateDeviceInfo,
  async (req: Request, res: Response) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res
          .status(400)
          .json(errorResponse('Invalid request data', 'VALIDATION_ERROR'));
      }

      const userId = await getUserId(req);
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
      }

      const userAgent = req.get('User-Agent') || '';
      const ipAddress = req.ip;

      // Parse device information
      const deviceInfo = deviceService.parseDeviceInfo(
        userAgent,
        req.body.deviceFingerprint
      );

      // Add device as trusted
      await deviceService.addTrustedDevice(userId, deviceInfo, ipAddress);

      return res.status(200).json(
        successResponse({
          message: 'Device marked as trusted',
          deviceName: deviceInfo.deviceName,
        })
      );
    } catch (error) {
      logError(securityLogger, 'Trust device error', error as Error, { service: 'session' });
      return res
        .status(500)
        .json(errorResponse('Failed to trust device', 'TRUST_DEVICE_ERROR'));
    }
  }
);

// GET /api/sessions/trusted-devices - Get trusted devices
router.get('/trusted-devices', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
    }

    const devices = await deviceService.getTrustedDevices(userId);

    // Remove sensitive fingerprint data from response
    const safeDevices = devices.map(device => ({
      id: device.id,
      deviceName: device.deviceName,
      deviceType: device.deviceType,
      browser: device.browser,
      operatingSystem: device.operatingSystem,
      lastUsed: device.lastUsed,
      expiresAt: device.expiresAt,
      createdAt: device.createdAt,
    }));

    return res.status(200).json(
      successResponse({
        devices: safeDevices,
      })
    );
  } catch (error) {
    logError(securityLogger, 'Get trusted devices error', error as Error, { service: 'session' });
    return res
      .status(500)
      .json(
        errorResponse('Failed to get trusted devices', 'GET_DEVICES_ERROR')
      );
  }
});

// DELETE /api/sessions/trusted-devices/:deviceId - Remove trusted device
router.delete(
  '/trusted-devices/:deviceId',
  authenticateJWT,
  async (req: Request, res: Response) => {
    try {
      const userId = await getUserId(req);
      if (!userId) {
        return res
          .status(401)
          .json(errorResponse('Unauthorized: User not authenticated'));
      }

      const deviceId = parseInt(req.params.deviceId, 10);
      if (isNaN(deviceId)) {
        return res.status(400).json(errorResponse('Invalid device ID'));
      }

      const success = await deviceService.removeTrustedDevice(userId, deviceId);

      if (!success) {
        return res
          .status(404)
          .json(errorResponse('Device not found or already removed'));
      }

      return res.status(200).json(
        successResponse({
          message: 'Trusted device removed successfully',
        })
      );
    } catch (error) {
      logError(securityLogger, 'Remove trusted device error', error as Error, { service: 'session' });
      return res
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

// GET /api/sessions/device-stats - Get device statistics
router.get('/device-stats', authenticateJWT, async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
    }

    const stats = await deviceService.getDeviceStats(userId);

    return res.status(200).json(successResponse(stats));
  } catch (error) {
    logError(securityLogger, 'Device stats error', error as Error, { service: 'session' });
    return res
      .status(500)
      .json(errorResponse('Failed to get device stats', 'DEVICE_STATS_ERROR'));
  }
});

// POST /api/sessions/cleanup - Cleanup expired data (admin only)
// Task 94.11: Using RBAC middleware for admin authorization
router.post('/cleanup', authenticateJWT, requireAdmin(), async (req: Request, res: Response) => {
  try {
    const userId = await getUserId(req);
    if (!userId) {
      return res
        .status(401)
        .json(errorResponse('Unauthorized: User not authenticated'));
    }

    await Promise.all([
      sessionService.cleanupExpiredSessions(),
      deviceService.cleanupExpiredDevices(),
    ]);

    return res.status(200).json(
      successResponse({
        message: 'Expired data cleaned up successfully',
      })
    );
  } catch (error) {
    logError(securityLogger, 'Cleanup error', error as Error, { service: 'session' });
    return res
      .status(500)
      .json(errorResponse('Failed to cleanup expired data', 'CLEANUP_ERROR'));
  }
});

export default router;
