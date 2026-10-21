import { Router } from 'express';
import {
  AuthMiddleware,
  AuthenticatedRequest,
} from '../middleware/auth-middleware.js';
import { SecurityUtils } from '../middleware/security-middleware.js';
import { Response } from 'express';

const router = Router();

// Protect security endpoints - admin only
router.use(AuthMiddleware.verifyUserToken);
router.use(AuthMiddleware.requireRole('admin'));

// GET /api/security/status - Security overview
router.get('/status', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const blockedIPs = SecurityUtils.getBlockedIPs();
    const suspiciousActivity = SecurityUtils.getSuspiciousActivity();

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        blockedIPs: {
          count: blockedIPs.length,
          ips: blockedIPs,
        },
        suspiciousActivity: {
          count: suspiciousActivity.length,
          activities: suspiciousActivity.slice(0, 10), // Top 10 most suspicious
        },
        rateLimiting: {
          generalLimit: '100 requests per 15 minutes',
          authLimit: '5 attempts per 15 minutes',
          walletLimit: '20 requests per 5 minutes',
          bridgeLimit: '3 requests per 10 minutes',
        },
        securityFeatures: [
          'IP-based blocking',
          'Rate limiting',
          'Request validation',
          'Malicious pattern detection',
          'Speed limiting',
          'CSP headers',
          'Security headers',
        ],
      },
    });
  } catch (error) {
    console.error('Security status error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'SECURITY_STATUS_ERROR',
        message: 'Failed to get security status',
      },
    });
  }
});

// POST /api/security/block-ip - Block an IP address
router.post('/block-ip', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ip, reason } = req.body;

    if (!ip) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_IP',
          message: 'IP address is required',
        },
      });
    }

    // Validate IP format (basic validation)
    const ipRegex = /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/;
    if (!ipRegex.test(ip)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_IP',
          message: 'Invalid IP address format',
        },
      });
    }

    SecurityUtils.blockIP(ip);

    return res.json({
      success: true,
      data: {
        message: 'IP address blocked successfully',
        ip,
        reason: reason || 'Manual block by admin',
        blockedBy: req.user?.address,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Block IP error:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'BLOCK_IP_ERROR',
        message: 'Failed to block IP address',
      },
    });
  }
});

// POST /api/security/unblock-ip - Unblock an IP address
router.post('/unblock-ip', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { ip } = req.body;

    if (!ip) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'MISSING_IP',
          message: 'IP address is required',
        },
      });
    }

    SecurityUtils.unblockIP(ip);

    return res.json({
      success: true,
      data: {
        message: 'IP address unblocked successfully',
        ip,
        unblockedBy: req.user?.address,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('Unblock IP error:', error);
    return res.status(500).json({
      success: false,
      error: {
        code: 'UNBLOCK_IP_ERROR',
        message: 'Failed to unblock IP address',
      },
    });
  }
});

// POST /api/security/clear-suspicious - Clear suspicious activity records
router.post(
  '/clear-suspicious',
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const { ip } = req.body;

      SecurityUtils.clearSuspiciousActivity(ip);

      res.json({
        success: true,
        data: {
          message: ip
            ? `Suspicious activity cleared for IP ${ip}`
            : 'All suspicious activity records cleared',
          clearedBy: req.user?.address,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error) {
      console.error('Clear suspicious activity error:', error);
      res.status(500).json({
        success: false,
        error: {
          code: 'CLEAR_SUSPICIOUS_ERROR',
          message: 'Failed to clear suspicious activity',
        },
      });
    }
  }
);

export { router as securityRoutes };
