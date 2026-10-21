import { Router } from 'express';
import {
  AuthMiddleware,
  AuthenticatedRequest,
} from '../middleware/auth-middleware.js';
import { Response } from 'express';
import fs from 'fs';
import path from 'path';
import {
  serviceConfig,
  testnetMvpScopeEnabled,
} from '../services/service-config.js';

const router = Router();

// Protect monitoring endpoints - admin only
router.use(AuthMiddleware.verifyUserToken);
router.use(AuthMiddleware.requireRole('admin'));

// GET /api/monitoring/health - Detailed health check
router.get('/health', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const startTime = Date.now();

    // System metrics
    const uptime = process.uptime();
    const memoryUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();

    // Service health check would go here
    // For now, we'll simulate service checks
    const services = {
      nftService: {
        status: testnetMvpScopeEnabled ? 'deferred' : 'healthy',
        responseTime: testnetMvpScopeEnabled ? 0 : 45,
        url: serviceConfig.nftService.url,
      },
      userService: {
        status: testnetMvpScopeEnabled ? 'deferred' : 'healthy',
        responseTime: testnetMvpScopeEnabled ? 0 : 62,
        url: serviceConfig.userService.url,
      },
      mainService: {
        status: 'degraded',
        responseTime: 1200,
        url: serviceConfig.mainService.url,
      },
      database: {
        status: 'healthy',
        responseTime: 23,
        connectionPool: { active: 5, idle: 15 },
      },
    };

    const responseTime = Date.now() - startTime;

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        uptime: Math.floor(uptime),
        responseTime,
        system: {
          memory: {
            rss: Math.round(memoryUsage.rss / 1024 / 1024), // MB
            heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024), // MB
            heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024), // MB
            external: Math.round(memoryUsage.external / 1024 / 1024), // MB
          },
          cpu: {
            user: cpuUsage.user,
            system: cpuUsage.system,
          },
          nodeVersion: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        services,
        overall: {
          status: Object.values(services).every(
            s => s.status === 'healthy' || s.status === 'deferred'
          )
            ? 'healthy'
            : 'degraded',
          servicesUp: Object.values(services).filter(
            s => s.status === 'healthy' || s.status === 'deferred'
          ).length,
          servicesTotal: Object.keys(services).length,
        },
      },
    });
  } catch (error) {
    console.error('Health check error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'HEALTH_CHECK_ERROR',
        message: 'Failed to perform health check',
      },
    });
  }
});

// GET /api/monitoring/metrics - System and application metrics
router.get('/metrics', async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Read log files for metrics
    const logMetrics = await getLogMetrics();

    res.json({
      success: true,
      data: {
        timestamp: new Date().toISOString(),
        requests: {
          total: logMetrics.totalRequests,
          success: logMetrics.successfulRequests,
          errors: logMetrics.errorRequests,
          successRate:
            logMetrics.totalRequests > 0
              ? (
                  (logMetrics.successfulRequests / logMetrics.totalRequests) *
                  100
                ).toFixed(2) + '%'
              : '0%',
        },
        performance: {
          averageResponseTime: logMetrics.averageResponseTime + 'ms',
          slowRequests: logMetrics.slowRequests,
          p95ResponseTime: logMetrics.p95ResponseTime + 'ms',
        },
        errors: {
          last24h: logMetrics.errorsLast24h,
          top: logMetrics.topErrors,
        },
        authentication: {
          loginAttempts: logMetrics.loginAttempts,
          failedLogins: logMetrics.failedLogins,
          successfulLogins: logMetrics.successfulLogins,
        },
        security: {
          suspiciousRequests: logMetrics.suspiciousRequests,
          blockedIPs: logMetrics.blockedIPs,
        },
      },
    });
  } catch (error) {
    console.error('Metrics error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'METRICS_ERROR',
        message: 'Failed to generate metrics',
      },
    });
  }
});

// GET /api/monitoring/logs - Recent logs with filtering
router.get('/logs', async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { level = 'info', limit = '100', service } = req.query;

    // Read recent logs
    const logs = await getRecentLogs(
      level as string,
      parseInt(limit as string, 10),
      service as string
    );

    res.json({
      success: true,
      data: {
        logs,
        count: logs.length,
        filters: {
          level,
          limit,
          service: service || 'all',
        },
      },
    });
  } catch (error) {
    console.error('Logs error:', error);
    res.status(500).json({
      success: false,
      error: {
        code: 'LOGS_ERROR',
        message: 'Failed to retrieve logs',
      },
    });
  }
});

// Helper functions
async function getLogMetrics() {
  // Mock metrics - in production, these would come from log analysis
  return {
    totalRequests: 15420,
    successfulRequests: 14892,
    errorRequests: 528,
    averageResponseTime: 145,
    slowRequests: 23,
    p95ResponseTime: 890,
    errorsLast24h: 12,
    topErrors: [
      { error: 'INVALID_TOKEN', count: 8 },
      { error: 'SERVICE_TIMEOUT', count: 3 },
      { error: 'VALIDATION_ERROR', count: 1 },
    ],
    loginAttempts: 234,
    failedLogins: 12,
    successfulLogins: 222,
    suspiciousRequests: 5,
    blockedIPs: ['192.168.1.100', '10.0.0.50'],
  };
}

async function getRecentLogs(level: string, limit: number, service?: string) {
  // Mock logs - in production, these would come from log files
  return [
    {
      timestamp: new Date().toISOString(),
      level: 'info',
      service: 'api-gateway',
      message: 'Request processed successfully',
      metadata: { responseTime: 145, userId: 'user_123' },
    },
    {
      timestamp: new Date().toISOString(),
      level: 'warn',
      service: 'nft-service',
      message: 'Slow database query detected',
      metadata: { queryTime: 1200, query: 'SELECT * FROM nfts' },
    },
    {
      timestamp: new Date().toISOString(),
      level: 'error',
      service: 'user-service',
      message: 'Database connection failed',
      metadata: { error: 'ECONNREFUSED', host: 'localhost:27017' },
    },
  ].slice(0, limit);
}

export { router as monitoringRoutes };
