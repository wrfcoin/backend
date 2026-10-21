/**
 * Comprehensive Audit API Routes
 * Provides REST endpoints for audit logging, monitoring, reporting, and compliance tracking
 */

import express from 'express';
import type { Response, NextFunction } from 'express';
import { z } from 'zod';
import { logger } from '../../utils/logger.js';
import { auditService } from '../../server/services/audit-service.js';
import { auditMonitoringService } from '../../server/services/audit-monitoring-service.js';
import { filePermissionService } from '../../server/services/file-permission-service.js';
import { AuthenticatedRequest } from '../../shared/types/security-types.js';
import { validateOrigin } from '../../shared/middleware/cors-config.js';
import { authenticateJWT } from '../../server/middleware/auth.js';
import {
  requireAdmin,
  requirePermission,
  RESOURCES,
} from '../../server/middleware/rbac-middleware.js';
import type {
  SecurityAuditEventRequest,
  SystemActivityLogRequest,
  ComplianceAuditRequest,
  AuditReportRequest,
  AuditQuery,
} from '../../server/services/audit-service.js';

// Define monitoring types here to avoid import issues
type MonitoringConfig = {
  enabled?: boolean;
  checkInterval?: number;
  alertThresholds?: {
    criticalEventsPerHour?: number;
    failedLoginsPerHour?: number;
    riskScoreThreshold?: number;
    systemErrorRate?: number;
    complianceScore?: number;
  };
  alertChannels?: {
    email?: boolean;
    webhook?: boolean;
    slack?: boolean;
    sms?: boolean;
  };
  automatedResponses?: {
    blockSuspiciousIPs?: boolean;
    disableCompromisedAccounts?: boolean;
    quarantineFiles?: boolean;
    escalateToAdmin?: boolean;
  };
  retentionPolicies?: {
    auditLogs?: number;
    reports?: number;
    alerts?: number;
  };
};

type MonitoringRule = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  eventType: string;
  conditions: Record<string, any>;
  alertSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  actions: string[];
  cooldownPeriod: number;
  lastTriggered?: Date;
};

// Extend the shared AuthenticatedRequest interface with audit context
interface AuditAuthenticatedRequest extends AuthenticatedRequest {
  auditContext?: {
    userId?: string;
    sessionId?: string;
    requestId?: string;
    ipAddress?: string;
    userAgent?: string;
    deviceFingerprint?: string;
  };
}

const router = express.Router();

// Validation schemas
const securityEventSchema = z.object({
  eventType: z.enum([
    'AUTHENTICATION',
    'AUTHORIZATION',
    'PERMISSION_CHANGE',
    'ACCESS_VIOLATION',
    'ADMIN_ACTION',
  ]),
  eventCategory: z.enum(['SECURITY', 'COMPLIANCE', 'SYSTEM', 'USER_ACTION']),
  targetUserId: z.number().optional(),
  fileId: z.string().uuid().optional(),
  resourceType: z.enum(['FILE', 'USER', 'SYSTEM', 'PERMISSION', 'SHARE']),
  resourceId: z.string(),
  action: z.string(),
  result: z.enum(['SUCCESS', 'FAILURE', 'DENIED', 'ERROR']),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  details: z.record(z.string(), z.any()).optional(),
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  complianceFlags: z.array(z.string()).optional(),
  remedialActions: z.array(z.string()).optional(),
});

const systemActivitySchema = z.object({
  activityType: z.enum([
    'STORAGE_OPERATION',
    'HEALTH_CHECK',
    'MONITORING',
    'BACKUP',
    'MAINTENANCE',
  ]),
  activityCategory: z.enum([
    'SYSTEM',
    'STORAGE',
    'NETWORK',
    'PERFORMANCE',
    'SECURITY',
  ]),
  component: z.string(),
  operation: z.string(),
  status: z.enum(['SUCCESS', 'FAILURE', 'WARNING', 'IN_PROGRESS', 'CANCELLED']),
  priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  fileId: z.string().uuid().optional(),
  storageProvider: z.string().optional(),
  networkProvider: z.string().optional(),
  startTime: z.string().datetime(),
  endTime: z.string().datetime().optional(),
  duration: z.number().optional(),
  bytesProcessed: z.number().optional(),
  resourcesUsed: z.record(z.string(), z.any()).optional(),
  performanceMetrics: z.record(z.string(), z.any()).optional(),
  healthIndicators: z.record(z.string(), z.any()).optional(),
  errorDetails: z.record(z.string(), z.any()).optional(),
  warningMessages: z.array(z.string()).optional(),
  configurationUsed: z.record(z.string(), z.any()).optional(),
  environmentInfo: z.record(z.string(), z.any()).optional(),
  alertsTriggered: z.array(z.string()).optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const complianceAuditSchema = z.object({
  complianceFramework: z.enum(['SOC2', 'GDPR', 'HIPAA', 'PCI_DSS', 'ISO27001']),
  requirementId: z.string(),
  requirementDescription: z.string(),
  entityType: z.enum(['FILE', 'USER', 'SYSTEM', 'PROCESS', 'POLICY']),
  entityId: z.string(),
  assessmentType: z.enum(['AUTOMATED', 'MANUAL', 'PERIODIC', 'TRIGGERED']),
  assessmentResult: z.enum([
    'COMPLIANT',
    'NON_COMPLIANT',
    'PARTIAL',
    'UNKNOWN',
  ]),
  confidenceLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'VERIFIED']),
  assessorType: z.enum(['SYSTEM', 'HUMAN', 'THIRD_PARTY']),
  evidenceCollected: z.record(z.string(), z.any()).optional(),
  controlsEvaluated: z.array(z.string()).optional(),
  findings: z.record(z.string(), z.any()).optional(),
  nonComplianceReasons: z.array(z.string()).optional(),
  remediationRequired: z.boolean().optional(),
  remediationPlan: z.record(z.string(), z.any()).optional(),
  remediationDeadline: z.string().datetime().optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  businessImpact: z.string().optional(),
  regulatoryImplications: z.record(z.string(), z.any()).optional(),
  previousAssessmentId: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
});

const reportRequestSchema = z.object({
  reportType: z.enum([
    'SECURITY',
    'COMPLIANCE',
    'SYSTEM',
    'PERFORMANCE',
    'INTEGRITY',
  ]),
  reportCategory: z.enum([
    'DAILY',
    'WEEKLY',
    'MONTHLY',
    'QUARTERLY',
    'ANNUAL',
    'CUSTOM',
  ]),
  title: z.string(),
  description: z.string().optional(),
  periodStart: z.string().datetime(),
  periodEnd: z.string().datetime(),
  format: z.enum(['JSON', 'PDF', 'CSV', 'HTML']).optional(),
  parameters: z.record(z.string(), z.any()).optional(),
  distributionList: z.array(z.string()).optional(),
});

const auditQuerySchema = z.object({
  eventTypes: z.array(z.string()).optional(),
  categories: z.array(z.string()).optional(),
  severities: z.array(z.string()).optional(),
  results: z.array(z.string()).optional(),
  userIds: z.array(z.number()).optional(),
  fileIds: z.array(z.string()).optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  limit: z.number().min(1).max(1000).optional(),
  offset: z.number().min(0).optional(),
  sortBy: z.enum(['eventTime', 'severity', 'result']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

const monitoringRuleSchema = z.object({
  name: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  eventType: z.string(),
  conditions: z.record(z.string(), z.any()),
  alertSeverity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']),
  actions: z.array(z.string()),
  cooldownPeriod: z.number().min(1),
});

const monitoringConfigSchema = z.object({
  enabled: z.boolean().optional(),
  checkInterval: z.number().min(1).optional(),
  alertThresholds: z
    .object({
      criticalEventsPerHour: z.number().optional(),
      failedLoginsPerHour: z.number().optional(),
      riskScoreThreshold: z.number().optional(),
      systemErrorRate: z.number().optional(),
      complianceScore: z.number().optional(),
    })
    .optional(),
  alertChannels: z
    .object({
      email: z.boolean().optional(),
      webhook: z.boolean().optional(),
      slack: z.boolean().optional(),
      sms: z.boolean().optional(),
    })
    .optional(),
  automatedResponses: z
    .object({
      blockSuspiciousIPs: z.boolean().optional(),
      disableCompromisedAccounts: z.boolean().optional(),
      quarantineFiles: z.boolean().optional(),
      escalateToAdmin: z.boolean().optional(),
    })
    .optional(),
  retentionPolicies: z
    .object({
      auditLogs: z.number().optional(),
      reports: z.number().optional(),
      alerts: z.number().optional(),
    })
    .optional(),
});

// Middleware to extract audit context after JWT authentication
const extractAuditContext = (
  req: AuditAuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  // Extract request context for audit logging
  req.auditContext = {
    userId: req.user?.userId || req.user?.id,
    sessionId: req.user?.sessionId || (req.headers['x-session-id'] as string),
    requestId: req.headers['x-request-id'] as string,
    ipAddress: req.ip || (req as any).connection?.remoteAddress,
    userAgent: req.headers['user-agent'],
    deviceFingerprint: req.headers['x-device-fingerprint'] as string,
  };
  next();
};

// Apply JWT authentication to all routes
router.use(authenticateJWT);
router.use(extractAuditContext);

/**
 * POST /api/audit/security-events
 * Log a security audit event
 * Requires: create permission on security_audit resource
 */
router.post(
  '/security-events',
  requirePermission('create', RESOURCES.SECURITY_AUDIT),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const validation = securityEventSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request data',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const eventData = validation.data;
      const userId = req.user?.userId ? parseInt(req.user.userId, 10) : 0;

      // Check if user can log events for the specified file/resource
      if (eventData.fileId) {
        const permissionCheck = await filePermissionService.checkFilePermission(
          userId,
          eventData.fileId,
          'READ'
        );

        if (!permissionCheck.hasPermission) {
          return res.status(403).json({
            success: false,
            error: 'Insufficient permissions to log events for this file',
            code: 'AUTHORIZATION_ERROR',
          });
        }
      }

      const normalizedContext = req.auditContext
        ? {
            ...req.auditContext,
            userId:
              typeof req.auditContext.userId === 'string'
                ? Number.parseInt(req.auditContext.userId, 10)
                : req.auditContext.userId,
          }
        : undefined;

      const eventId = await auditService.logSecurityEvent({
        ...eventData,
        userId,
        context: normalizedContext,
      } as SecurityAuditEventRequest);

      res.json({
        success: true,
        data: {
          eventId,
          message: 'Security event logged successfully',
        },
      });
    } catch (error) {
      logger.error('[AuditAPI] Error logging security event', {
        userId: req.user?.userId,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to log security event',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/audit/system-activities
 * Log a system activity event
 * Requires: create permission on security_audit resource
 */
router.post(
  '/system-activities',
  requirePermission('create', RESOURCES.SECURITY_AUDIT),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const validation = systemActivitySchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request data',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const activityData = validation.data;
      const userId = req.user?.userId ? parseInt(req.user.userId, 10) : 0;

      const activityId = await auditService.logSystemActivity({
        ...activityData,
        userId,
        startTime: new Date(activityData.startTime),
        endTime: activityData.endTime
          ? new Date(activityData.endTime)
          : undefined,
      } as SystemActivityLogRequest);

      res.json({
        success: true,
        data: {
          activityId,
          message: 'System activity logged successfully',
        },
      });
    } catch (error) {
      logger.error('[AuditAPI] Error logging system activity', {
        userId: req.user?.userId,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to log system activity',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/audit/compliance-audits
 * Log a compliance audit entry
 * Requires: admin role (compliance audits are sensitive)
 */
router.post(
  '/compliance-audits',
  requireAdmin(),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const validation = complianceAuditSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid request data',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const complianceData = validation.data;
      const userId = req.user?.userId ? parseInt(req.user.userId, 10) : 0;

      const auditId = await auditService.logComplianceAudit({
        ...complianceData,
        assessorId: userId,
        remediationDeadline: complianceData.remediationDeadline
          ? new Date(complianceData.remediationDeadline)
          : undefined,
      } as ComplianceAuditRequest);

      res.json({
        success: true,
        data: {
          auditId,
          message: 'Compliance audit logged successfully',
        },
      });
    } catch (error) {
      logger.error('[AuditAPI] Error logging compliance audit', {
        userId: req.user?.userId,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to log compliance audit',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/audit/events/query
 * Query audit events with filters
 * Requires: read permission on security_audit resource
 */
router.post(
  '/events/query',
  requirePermission('read', RESOURCES.SECURITY_AUDIT),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const validation = auditQuerySchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid query parameters',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const query = validation.data;

      // Convert string dates to Date objects
      const processedQuery: AuditQuery = {
        ...query,
        startDate: query.startDate ? new Date(query.startDate) : undefined,
        endDate: query.endDate ? new Date(query.endDate) : undefined,
      };

      const result = await auditService.queryAuditEvents(processedQuery);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('[AuditAPI] Error querying audit events', {
        userId: req.user?.userId,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to query audit events',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * GET /api/audit/statistics
 * Get comprehensive audit statistics
 * Requires: read permission on security_audit resource
 */
router.get(
  '/statistics',
  requirePermission('read', RESOURCES.SECURITY_AUDIT),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const { startDate, endDate } = req.query;

      let timeRange;
      if (startDate && endDate) {
        timeRange = {
          start: new Date(startDate as string),
          end: new Date(endDate as string),
        };
      }

      const statistics = await auditService.getAuditStatistics(timeRange);

      res.json({
        success: true,
        data: statistics,
      });
    } catch (error) {
      logger.error('[AuditAPI] Error getting audit statistics', {
        userId: req.user?.userId,
        query: req.query,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get audit statistics',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/audit/reports/generate
 * Generate comprehensive audit report
 * Requires: admin role (report generation is sensitive)
 */
router.post(
  '/reports/generate',
  requireAdmin(),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const validation = reportRequestSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid report request',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const reportData = validation.data;
      const userId = req.user?.userId ? parseInt(req.user.userId, 10) : 0;

      const report = await auditService.generateAuditReport({
        ...reportData,
        periodStart: new Date(reportData.periodStart),
        periodEnd: new Date(reportData.periodEnd),
        generatedBy: userId,
      } as AuditReportRequest);

      res.json({
        success: true,
        data: report,
      });
    } catch (error) {
      logger.error('[AuditAPI] Error generating audit report', {
        userId: req.user?.userId,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to generate audit report',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * GET /api/audit/monitoring/metrics
 * Get real-time monitoring metrics
 * Requires: read permission on security_audit resource
 */
router.get(
  '/monitoring/metrics',
  requirePermission('read', RESOURCES.SECURITY_AUDIT),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const metrics = await auditMonitoringService.getMonitoringMetrics();

      res.json({
        success: true,
        data: metrics,
      });
    } catch (error) {
      logger.error('[AuditAPI] Error getting monitoring metrics', {
        userId: req.user?.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get monitoring metrics',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * GET /api/audit/monitoring/alerts
 * Get active alerts
 * Requires: read permission on security_audit resource
 */
router.get(
  '/monitoring/alerts',
  requirePermission('read', RESOURCES.SECURITY_AUDIT),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const { resolved } = req.query;

      let alerts;
      if (resolved === 'true') {
        alerts = await auditMonitoringService.getResolvedAlerts();
      } else {
        alerts = auditMonitoringService.getActiveAlerts();
      }

      res.json({
        success: true,
        data: alerts,
      });
    } catch (error) {
      logger.error('[AuditAPI] Error getting alerts', {
        userId: req.user?.userId,
        query: req.query,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get alerts',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/audit/monitoring/alerts/:alertId/acknowledge
 * Acknowledge an alert
 * Requires: admin role (alert acknowledgment is an admin action)
 */
router.post(
  '/monitoring/alerts/:alertId/acknowledge',
  requireAdmin(),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const { alertId } = req.params;
      const userId = req.user?.userId ? parseInt(req.user.userId, 10) : 0;

      if (!alertId) {
        return res.status(400).json({
          success: false,
          error: 'alertId is required',
          code: 'VALIDATION_ERROR',
        });
      }

      const success = await auditMonitoringService.acknowledgeAlert(
        alertId,
        userId
      );

      if (!success) {
        return res.status(404).json({
          success: false,
          error: 'Alert not found',
          code: 'RESOURCE_NOT_FOUND',
        });
      }

      res.json({
        success: true,
        data: {
          message: 'Alert acknowledged successfully',
        },
      });
    } catch (error) {
      logger.error('[AuditAPI] Error acknowledging alert', {
        userId: req.user?.userId,
        alertId: req.params.alertId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to acknowledge alert',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/audit/monitoring/alerts/:alertId/resolve
 * Resolve an alert
 * Requires: admin role (alert resolution is an admin action)
 */
router.post(
  '/monitoring/alerts/:alertId/resolve',
  requireAdmin(),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const { alertId } = req.params;
      const { resolution } = req.body;
      const userId = req.user?.userId ? parseInt(req.user.userId, 10) : 0;

      if (!alertId) {
        return res.status(400).json({
          success: false,
          error: 'alertId is required',
          code: 'VALIDATION_ERROR',
        });
      }

      const success = await auditMonitoringService.resolveAlert(
        alertId,
        userId,
        resolution
      );

      if (!success) {
        return res.status(404).json({
          success: false,
          error: 'Alert not found',
          code: 'RESOURCE_NOT_FOUND',
        });
      }

      res.json({
        success: true,
        data: {
          message: 'Alert resolved successfully',
        },
      });
    } catch (error) {
      logger.error('[AuditAPI] Error resolving alert', {
        userId: req.user?.userId,
        alertId: req.params.alertId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to resolve alert',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * POST /api/audit/monitoring/rules
 * Create a monitoring rule
 * Requires: admin role
 */
router.post(
  '/monitoring/rules',
  requireAdmin(),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const validation = monitoringRuleSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid monitoring rule',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const ruleData = validation.data;
      const ruleId = await auditMonitoringService.createMonitoringRule({
        ...ruleData,
      } as Omit<MonitoringRule, 'id'>);

      res.json({
        success: true,
        data: {
          ruleId,
          message: 'Monitoring rule created successfully',
        },
      });
    } catch (error) {
      logger.error('[AuditAPI] Error creating monitoring rule', {
        userId: req.user?.userId,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to create monitoring rule',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * GET /api/audit/monitoring/status
 * Get monitoring system status
 * Requires: read permission on security_audit resource
 */
router.get(
  '/monitoring/status',
  requirePermission('read', RESOURCES.SECURITY_AUDIT),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const status = auditMonitoringService.getMonitoringStatus();

      res.json({
        success: true,
        data: status,
      });
    } catch (error) {
      logger.error('[AuditAPI] Error getting monitoring status', {
        userId: req.user?.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get monitoring status',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * PUT /api/audit/monitoring/config
 * Update monitoring configuration
 * Requires: admin role
 */
router.put(
  '/monitoring/config',
  requireAdmin(),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const validation = monitoringConfigSchema.safeParse(req.body);
      if (!validation.success) {
        return res.status(400).json({
          success: false,
          error: 'Invalid monitoring configuration',
          details: validation.error.issues,
          code: 'VALIDATION_ERROR',
        });
      }

      const config = validation.data;

      // Type assertion for configuration - the actual service will handle validation
      auditMonitoringService.updateConfiguration(config as any);

      res.json({
        success: true,
        data: {
          message: 'Monitoring configuration updated successfully',
          config,
        },
      });
    } catch (error) {
      logger.error('[AuditAPI] Error updating monitoring config', {
        userId: req.user?.userId,
        body: req.body,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to update monitoring configuration',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * GET /api/audit/health
 * Get audit system health status
 * Requires: read permission on security_audit resource
 */
router.get(
  '/health',
  requirePermission('read', RESOURCES.SECURITY_AUDIT),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      const metrics = await auditMonitoringService.getMonitoringMetrics();
      const monitoringStatus = auditMonitoringService.getMonitoringStatus();

      res.json({
        success: true,
        data: {
          systemHealth: metrics.systemHealth,
          monitoring: {
            isRunning: monitoringStatus.isRunning,
            activeAlerts: monitoringStatus.activeAlertsCount,
          },
          metrics: {
            eventsPerHour: metrics.eventsPerHour,
            complianceScore: metrics.complianceScore,
            riskScore: metrics.averageRiskScore,
          },
        },
      });
    } catch (error) {
      logger.error('[AuditAPI] Error getting audit health status', {
        userId: req.user?.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to get audit health status',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

/**
 * GET /api/audit/events/stream
 * Get real-time audit event stream (SSE)
 * Requires: read permission on security_audit resource
 */
router.get(
  '/events/stream',
  requirePermission('read', RESOURCES.SECURITY_AUDIT),
  async (req: AuditAuthenticatedRequest, res: Response) => {
    try {
      // Validate origin for SSE endpoint
      const origin = req.headers.origin as string | undefined;
      const validOrigin = validateOrigin(origin);

      // Set up Server-Sent Events with secure CORS
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': validOrigin || '',
        'Access-Control-Allow-Headers': 'Cache-Control, Authorization, X-API-Key',
        'Access-Control-Allow-Credentials': 'true',
        Vary: 'Origin',
      });

      // Send initial connection confirmation
      res.write(
        'data: {"type":"connected","message":"Connected to audit event stream"}\n\n'
      );

      // Subscribe to real-time alerts
      const unsubscribe = auditMonitoringService.subscribeToAlerts(alert => {
        res.write(
          `data: ${JSON.stringify({
            type: 'alert',
            data: alert,
          })}\n\n`
        );
      });

      // Handle client disconnect
      req.on('close', () => {
        unsubscribe();
        res.end();
      });

      // Keep connection alive with periodic heartbeat
      const heartbeat = setInterval(() => {
        res.write(
          'data: {"type":"heartbeat","timestamp":"' +
            new Date().toISOString() +
            '"}\n\n'
        );
      }, 30000); // 30 seconds

      req.on('close', () => {
        clearInterval(heartbeat);
      });
    } catch (error) {
      logger.error('[AuditAPI] Error setting up event stream', {
        userId: req.user?.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      res.status(500).json({
        success: false,
        error: 'Failed to setup event stream',
        code: 'INTERNAL_SERVER_ERROR',
      });
    }
  }
);

// Error handling middleware
router.use(
  (
    error: Error,
    req: AuditAuthenticatedRequest,
    res: Response,
    next: NextFunction
  ) => {
    logger.error('[AuditAPI] Unhandled error', {
      path: req.path,
      method: req.method,
      userId: req.userId,
      error: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
      code: 'INTERNAL_SERVER_ERROR',
    });
  }
);

export default router;

// Type augmentation for Express Request
declare global {
  namespace Express {
    interface Request {
      userId?: string;
      auditContext?: {
        userId?: string;
        sessionId?: string;
        requestId?: string;
        ipAddress?: string;
        userAgent?: string;
        deviceFingerprint?: string;
        geolocation?: {
          country?: string;
          region?: string;
          city?: string;
          latitude?: number;
          longitude?: number;
        };
      };
    }
  }
}
