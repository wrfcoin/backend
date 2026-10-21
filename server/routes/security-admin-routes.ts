/**
 * Security Administration Routes
 *
 * Task 80: Gap 4 - RASP configuration and security admin endpoints
 *
 * Provides admin-only endpoints for:
 * - RASP blocking mode configuration
 * - RASP statistics and monitoring
 * - IP blocking/unblocking
 * - Session service health
 */

import { Router, Request, Response } from 'express';
import { authenticateJWT, getSessionServiceHealth } from '../middleware/auth.js';
import { requireAdmin, requirePermission } from '../middleware/rbac-middleware.js';
import { raspAdmin } from '../../src/middleware/rasp.js';
import { logger } from '../../utils/logger.js';

const router = Router();

// Standard API response helpers
const successResponse = <T>(data: T) => ({
  success: true,
  data,
  timestamp: new Date().toISOString(),
});

const errorResponse = (message: string, code?: string) => ({
  success: false,
  error: {
    code: code || 'SECURITY_ADMIN_ERROR',
    message,
  },
  timestamp: new Date().toISOString(),
});

// Validate RASP config update payload
interface RASPConfigUpdate {
  enabled?: boolean;
  blockingMode?: boolean;
  monitoringOnly?: boolean;
  alertThreshold?: number;
  rateLimits?: {
    maxRequestsPerMinute?: number;
    maxRequestsPerHour?: number;
  };
}

/**
 * GET /api/admin/security/rasp
 * Get RASP configuration and statistics
 * Requires: admin role or read:system_config permission
 */
router.get(
  '/rasp',
  authenticateJWT,
  requirePermission('read', 'system_config'),
  async (req: Request, res: Response) => {
    try {
      const stats = raspAdmin.getStats();

      logger.info('[Security Admin] RASP stats requested', {
        userId: (req as any).user?.userId,
        ip: req.ip,
      });

      return res.status(200).json(successResponse(stats));
    } catch (error) {
      logger.error('[Security Admin] Failed to get RASP stats', { error });
      return res.status(500).json(
        errorResponse('Failed to get RASP statistics', 'RASP_STATS_ERROR')
      );
    }
  }
);

/**
 * POST /api/admin/security/rasp/config
 * Update RASP configuration
 * Requires: admin role
 */
router.post(
  '/rasp/config',
  authenticateJWT,
  requireAdmin(),
  async (req: Request, res: Response) => {
    try {
      const config: RASPConfigUpdate = req.body;
      const userId = (req as any).user?.userId;

      // Validate config values
      if (config.alertThreshold !== undefined) {
        if (config.alertThreshold < 1 || config.alertThreshold > 100) {
          return res.status(400).json(
            errorResponse('alertThreshold must be between 1 and 100', 'INVALID_THRESHOLD')
          );
        }
      }

      if (config.rateLimits) {
        if (config.rateLimits.maxRequestsPerMinute !== undefined &&
            (config.rateLimits.maxRequestsPerMinute < 1 || config.rateLimits.maxRequestsPerMinute > 10000)) {
          return res.status(400).json(
            errorResponse('maxRequestsPerMinute must be between 1 and 10000', 'INVALID_RATE_LIMIT')
          );
        }
        if (config.rateLimits.maxRequestsPerHour !== undefined &&
            (config.rateLimits.maxRequestsPerHour < 1 || config.rateLimits.maxRequestsPerHour > 100000)) {
          return res.status(400).json(
            errorResponse('maxRequestsPerHour must be between 1 and 100000', 'INVALID_RATE_LIMIT')
          );
        }
      }

      // Log the configuration change for audit
      logger.warn('[Security Admin] RASP configuration updated', {
        userId,
        ip: req.ip,
        previousConfig: raspAdmin.getStats().config,
        newConfig: config,
      });

      // Update RASP configuration
      raspAdmin.updateConfig(config as any);

      const updatedStats = raspAdmin.getStats();

      return res.status(200).json(successResponse({
        message: 'RASP configuration updated successfully',
        config: updatedStats.config,
      }));
    } catch (error) {
      logger.error('[Security Admin] Failed to update RASP config', { error });
      return res.status(500).json(
        errorResponse('Failed to update RASP configuration', 'RASP_CONFIG_ERROR')
      );
    }
  }
);

/**
 * POST /api/admin/security/rasp/blocking-mode
 * Toggle RASP blocking mode (convenience endpoint)
 * Requires: admin role
 */
router.post(
  '/rasp/blocking-mode',
  authenticateJWT,
  requireAdmin(),
  async (req: Request, res: Response) => {
    try {
      const { enabled } = req.body;
      const userId = (req as any).user?.userId;

      if (typeof enabled !== 'boolean') {
        return res.status(400).json(
          errorResponse('enabled must be a boolean', 'INVALID_INPUT')
        );
      }

      // Log the blocking mode change for audit
      logger.warn('[Security Admin] RASP blocking mode changed', {
        userId,
        ip: req.ip,
        blockingMode: enabled,
      });

      raspAdmin.updateConfig({
        blockingMode: enabled,
        monitoringOnly: !enabled,
      });

      return res.status(200).json(successResponse({
        message: `RASP blocking mode ${enabled ? 'enabled' : 'disabled'}`,
        blockingMode: enabled,
      }));
    } catch (error) {
      logger.error('[Security Admin] Failed to toggle blocking mode', { error });
      return res.status(500).json(
        errorResponse('Failed to toggle blocking mode', 'BLOCKING_MODE_ERROR')
      );
    }
  }
);

/**
 * GET /api/admin/security/rasp/blocked-ips
 * Get list of currently blocked IPs
 * Requires: admin role or security_admin permission
 */
router.get(
  '/rasp/blocked-ips',
  authenticateJWT,
  requirePermission('read', 'system_config'),
  async (req: Request, res: Response) => {
    try {
      const blockedIPs = raspAdmin.getBlockedIPs();

      return res.status(200).json(successResponse({
        blockedIPs,
        count: blockedIPs.length,
      }));
    } catch (error) {
      logger.error('[Security Admin] Failed to get blocked IPs', { error });
      return res.status(500).json(
        errorResponse('Failed to get blocked IPs', 'BLOCKED_IPS_ERROR')
      );
    }
  }
);

/**
 * POST /api/admin/security/rasp/unblock-ip
 * Unblock a specific IP address
 * Requires: admin role
 */
router.post(
  '/rasp/unblock-ip',
  authenticateJWT,
  requireAdmin(),
  async (req: Request, res: Response) => {
    try {
      const { ip } = req.body;
      const userId = (req as any).user?.userId;

      if (!ip || typeof ip !== 'string') {
        return res.status(400).json(
          errorResponse('ip address is required', 'INVALID_INPUT')
        );
      }

      // Validate IP format (basic validation)
      const ipRegex = /^(?:\d{1,3}\.){3}\d{1,3}$|^([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}$/;
      if (!ipRegex.test(ip)) {
        return res.status(400).json(
          errorResponse('Invalid IP address format', 'INVALID_IP')
        );
      }

      // Log the unblock action for audit
      logger.warn('[Security Admin] IP unblocked', {
        userId,
        adminIp: req.ip,
        unblockedIp: ip,
      });

      raspAdmin.unblockIP(ip);

      return res.status(200).json(successResponse({
        message: `IP ${ip} has been unblocked`,
        ip,
      }));
    } catch (error) {
      logger.error('[Security Admin] Failed to unblock IP', { error });
      return res.status(500).json(
        errorResponse('Failed to unblock IP', 'UNBLOCK_IP_ERROR')
      );
    }
  }
);

/**
 * GET /api/admin/security/session-health
 * Get session service health status (Redis connectivity)
 * Requires: admin role or security_admin permission
 */
router.get(
  '/session-health',
  authenticateJWT,
  requirePermission('read', 'system_config'),
  async (req: Request, res: Response) => {
    try {
      const health = getSessionServiceHealth();

      return res.status(200).json(successResponse({
        sessionService: health,
        timestamp: new Date().toISOString(),
      }));
    } catch (error) {
      logger.error('[Security Admin] Failed to get session health', { error });
      return res.status(500).json(
        errorResponse('Failed to get session service health', 'SESSION_HEALTH_ERROR')
      );
    }
  }
);

/**
 * GET /api/admin/security/overview
 * Get comprehensive security overview
 * Requires: admin role
 */
router.get(
  '/overview',
  authenticateJWT,
  requireAdmin(),
  async (req: Request, res: Response) => {
    try {
      const raspStats = raspAdmin.getStats();
      const sessionHealth = getSessionServiceHealth();

      return res.status(200).json(successResponse({
        rasp: {
          enabled: raspStats.config.enabled,
          blockingMode: raspStats.config.blockingMode,
          blockedIPCount: raspStats.blockedIPs,
          activeMonitoring: raspStats.activeMonitoring,
        },
        sessions: {
          redisConnected: sessionHealth.redis,
          mode: sessionHealth.mode,
          inMemorySessionCount: sessionHealth.inMemorySessionCount,
        },
        timestamp: new Date().toISOString(),
      }));
    } catch (error) {
      logger.error('[Security Admin] Failed to get security overview', { error });
      return res.status(500).json(
        errorResponse('Failed to get security overview', 'OVERVIEW_ERROR')
      );
    }
  }
);

export default router;
