/**
 * Comprehensive Audit Service
 * Provides comprehensive audit logging functionality for file operations,
 * security events, system activities, and compliance tracking
 */

import { eq, and, or, desc, asc, sql, count, between, type AnyColumn } from 'drizzle-orm';
import { db } from '../../database/connection.js';
import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import fieldNameConverter from '../../utils/fieldNameConverter.js';
import { createRedisClient } from '../utils/create-redis.js';

import {
  files,
  fileAccessLogs,
  securityAuditEvents,
  systemActivityLogs,
  auditReports,
  complianceAuditTrail,
  type SecurityAuditEvent,
  type InsertSecurityAuditEvent,
  type SystemActivityLog,
  type InsertSystemActivityLog,
  type AuditReport,
  type InsertAuditReport,
  type ComplianceAuditTrail,
  type InsertComplianceAuditTrail,
} from '../../shared/file-schema.js';

// Redis client for audit event caching and real-time streaming
const redis = createRedisClient({
  // Audit events and real-time security streams are required state.
  failureMode: 'fail-closed',
});

// Cache TTL in seconds
const AUDIT_CACHE_TTL = 3600; // 1 hour for audit summaries
const ALERT_CACHE_TTL = 1800; // 30 minutes for alert data
const REPORT_CACHE_TTL = 7200; // 2 hours for generated reports

export interface AuditContext {
  userId?: number;
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
}

export interface SecurityAuditEventRequest {
  eventType:
    | 'AUTHENTICATION'
    | 'AUTHORIZATION'
    | 'PERMISSION_CHANGE'
    | 'ACCESS_VIOLATION'
    | 'ADMIN_ACTION';
  eventCategory: 'SECURITY' | 'COMPLIANCE' | 'SYSTEM' | 'USER_ACTION';
  userId?: number;
  targetUserId?: number;
  fileId?: string;
  resourceType: 'FILE' | 'USER' | 'SYSTEM' | 'PERMISSION' | 'SHARE';
  resourceId: string;
  action: string;
  result: 'SUCCESS' | 'FAILURE' | 'DENIED' | 'ERROR';
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  details?: Record<string, any>;
  errorCode?: string;
  errorMessage?: string;
  complianceFlags?: string[];
  remedialActions?: string[];
  context?: AuditContext;
}

export interface SystemActivityLogRequest {
  activityType:
    | 'STORAGE_OPERATION'
    | 'HEALTH_CHECK'
    | 'MONITORING'
    | 'BACKUP'
    | 'MAINTENANCE';
  activityCategory:
    | 'SYSTEM'
    | 'STORAGE'
    | 'NETWORK'
    | 'PERFORMANCE'
    | 'SECURITY';
  component: string;
  operation: string;
  status: 'SUCCESS' | 'FAILURE' | 'WARNING' | 'IN_PROGRESS' | 'CANCELLED';
  priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  fileId?: string;
  userId?: number;
  storageProvider?: string;
  networkProvider?: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  bytesProcessed?: number;
  resourcesUsed?: Record<string, any>;
  performanceMetrics?: Record<string, any>;
  healthIndicators?: Record<string, any>;
  errorDetails?: Record<string, any>;
  warningMessages?: string[];
  configurationUsed?: Record<string, any>;
  environmentInfo?: Record<string, any>;
  alertsTriggered?: string[];
  metadata?: Record<string, any>;
}

export interface ComplianceAuditRequest {
  complianceFramework: 'SOC2' | 'GDPR' | 'HIPAA' | 'PCI_DSS' | 'ISO27001';
  requirementId: string;
  requirementDescription: string;
  entityType: 'FILE' | 'USER' | 'SYSTEM' | 'PROCESS' | 'POLICY';
  entityId: string;
  assessmentType: 'AUTOMATED' | 'MANUAL' | 'PERIODIC' | 'TRIGGERED';
  assessmentResult: 'COMPLIANT' | 'NON_COMPLIANT' | 'PARTIAL' | 'UNKNOWN';
  confidenceLevel: 'LOW' | 'MEDIUM' | 'HIGH' | 'VERIFIED';
  assessorId?: number;
  assessorType: 'SYSTEM' | 'HUMAN' | 'THIRD_PARTY';
  evidenceCollected?: Record<string, any>;
  controlsEvaluated?: string[];
  findings?: Record<string, any>;
  nonComplianceReasons?: string[];
  remediationRequired?: boolean;
  remediationPlan?: Record<string, any>;
  remediationDeadline?: Date;
  riskLevel?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  businessImpact?: string;
  regulatoryImplications?: Record<string, any>;
  previousAssessmentId?: string;
  metadata?: Record<string, any>;
}

export interface AuditReportRequest {
  reportType:
    | 'SECURITY'
    | 'COMPLIANCE'
    | 'SYSTEM'
    | 'PERFORMANCE'
    | 'INTEGRITY';
  reportCategory:
    | 'DAILY'
    | 'WEEKLY'
    | 'MONTHLY'
    | 'QUARTERLY'
    | 'ANNUAL'
    | 'CUSTOM';
  title: string;
  description?: string;
  generatedBy: number;
  periodStart: Date;
  periodEnd: Date;
  format?: 'JSON' | 'PDF' | 'CSV' | 'HTML';
  parameters?: Record<string, any>;
  distributionList?: string[];
}

export interface AuditQuery {
  eventTypes?: string[];
  categories?: string[];
  severities?: string[];
  results?: string[];
  userIds?: number[];
  fileIds?: string[];
  startDate?: Date;
  endDate?: Date;
  limit?: number;
  offset?: number;
  sortBy?: 'eventTime' | 'severity' | 'result';
  sortOrder?: 'asc' | 'desc';
}

// File-specific audit event types
export const FILE_AUDIT_EVENTS = {
  // Basic file operations
  FILE_UPLOADED: 'FILE_UPLOADED',
  FILE_DOWNLOADED: 'FILE_DOWNLOADED',
  FILE_DELETED: 'FILE_DELETED',
  FILE_MOVED: 'FILE_MOVED',
  FILE_COPIED: 'FILE_COPIED',

  // Permission and sharing events
  FILE_SHARED: 'FILE_SHARED',
  FILE_SHARE_REVOKED: 'FILE_SHARE_REVOKED',
  FILE_PERMISSION_GRANTED: 'FILE_PERMISSION_GRANTED',
  FILE_PERMISSION_REVOKED: 'FILE_PERMISSION_REVOKED',
  FILE_PERMISSION_CHANGED: 'FILE_PERMISSION_CHANGED',

  // Security events
  FILE_ENCRYPTED: 'FILE_ENCRYPTED',
  FILE_DECRYPTED: 'FILE_DECRYPTED',
  FILE_ENCRYPTION_KEY_ROTATED: 'FILE_ENCRYPTION_KEY_ROTATED',
  FILE_VIRUS_DETECTED: 'FILE_VIRUS_DETECTED',
  FILE_VIRUS_SCAN_PASSED: 'FILE_VIRUS_SCAN_PASSED',
  FILE_ACCESS_DENIED: 'FILE_ACCESS_DENIED',
  FILE_MALWARE_QUARANTINED: 'FILE_MALWARE_QUARANTINED',

  // Integrity events
  FILE_INTEGRITY_VERIFIED: 'FILE_INTEGRITY_VERIFIED',
  FILE_INTEGRITY_FAILED: 'FILE_INTEGRITY_FAILED',
  FILE_HASH_GENERATED: 'FILE_HASH_GENERATED',
  FILE_CHECKSUM_MISMATCH: 'FILE_CHECKSUM_MISMATCH',

  // Version control events
  FILE_VERSION_CREATED: 'FILE_VERSION_CREATED',
  FILE_VERSION_ROLLBACK: 'FILE_VERSION_ROLLBACK',
  FILE_VERSION_DELETED: 'FILE_VERSION_DELETED',
  FILE_VERSION_COMPARED: 'FILE_VERSION_COMPARED',

  // Quota and cleanup events
  FILE_QUOTA_EXCEEDED: 'FILE_QUOTA_EXCEEDED',
  FILE_QUOTA_WARNING: 'FILE_QUOTA_WARNING',
  FILE_CLEANUP_EXECUTED: 'FILE_CLEANUP_EXECUTED',
  FILE_ARCHIVED: 'FILE_ARCHIVED',
  FILE_EXPIRED: 'FILE_EXPIRED',

  // Presigned URL events
  FILE_PRESIGNED_URL_GENERATED: 'FILE_PRESIGNED_URL_GENERATED',
  FILE_PRESIGNED_URL_EXPIRED: 'FILE_PRESIGNED_URL_EXPIRED',
  FILE_PRESIGNED_URL_ACCESSED: 'FILE_PRESIGNED_URL_ACCESSED',
} as const;

export type FileAuditEventType = typeof FILE_AUDIT_EVENTS[keyof typeof FILE_AUDIT_EVENTS];

// File audit event request interface
export interface FileAuditEventRequest {
  eventType: FileAuditEventType;
  fileId: string;
  fileName: string;
  operation: string;
  userId?: number;
  result: 'SUCCESS' | 'FAILURE' | 'DENIED' | 'WARNING';
  severity?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  details?: {
    fileSize?: number;
    mimeType?: string;
    storagePath?: string;
    storageProvider?: string;
    checksum?: string;
    versionNumber?: number;
    previousVersion?: number;
    encryptionAlgorithm?: string;
    encryptionKeyId?: string;
    virusScanResult?: string;
    threatName?: string;
    integrityAlgorithms?: string[];
    shareRecipient?: string;
    shareType?: string;
    permissionLevel?: string;
    quotaUsed?: number;
    quotaLimit?: number;
    cleanupReason?: string;
    filesDeleted?: number;
    bytesRecovered?: number;
    presignedUrlExpiry?: number;
    [key: string]: any;
  };
  context?: AuditContext;
}

export interface AuditStatistics {
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsByCategory: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  eventsByResult: Record<string, number>;
  topUsers: Array<{ userId: number; eventCount: number }>;
  topFiles: Array<{ fileId: string; eventCount: number }>;
  trendData: Array<{ date: string; eventCount: number; severity: string }>;
  complianceScore: number;
  riskScore: number;
  alertCount: number;
  recentCriticalEvents: SecurityAuditEvent[];
}

export class AuditService {
  private alertSubscribers: Set<(event: SecurityAuditEvent) => void> =
    new Set();
  private isInitialized: boolean = false;

  /**
   * Initialize the audit service
   */
  async initialize(): Promise<void> {
    try {
      logger.info('[Audit] Initializing comprehensive audit service');

      // Test Redis connection
      await redis.ping();

      // Set up real-time event streaming
      await this.setupEventStreaming();

      // Initialize compliance monitoring
      await this.initializeComplianceMonitoring();

      this.isInitialized = true;

      logger.info(
        '[Audit] Comprehensive audit service initialized successfully'
      );
    } catch (error) {
      logger.error('[Audit] Failed to initialize audit service', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Log a security audit event
   */
  async logSecurityEvent(
    eventRequest: SecurityAuditEventRequest
  ): Promise<string> {
    try {
      const eventId = crypto.randomUUID();
      const riskScore = this.calculateRiskScore(eventRequest);

      logger.debug('[Audit] Logging security event', {
        eventType: eventRequest.eventType,
        action: eventRequest.action,
        result: eventRequest.result,
        severity: eventRequest.severity || 'MEDIUM',
        riskScore,
      });

      const eventData: InsertSecurityAuditEvent = {
        eventType: eventRequest.eventType,
        eventCategory: eventRequest.eventCategory,
        userId: eventRequest.userId,
        targetUserId: eventRequest.targetUserId,
        fileId: eventRequest.fileId,
        resourceType: eventRequest.resourceType,
        resourceId: eventRequest.resourceId,
        action: eventRequest.action,
        result: eventRequest.result,
        severity: eventRequest.severity || 'MEDIUM',
        ipAddress: eventRequest.context?.ipAddress,
        userAgent: eventRequest.context?.userAgent,
        sessionId: eventRequest.context?.sessionId,
        requestId: eventRequest.context?.requestId,
        details: eventRequest.details,
        errorCode: eventRequest.errorCode,
        errorMessage: eventRequest.errorMessage,
        geolocation: eventRequest.context?.geolocation,
        deviceFingerprint: eventRequest.context?.deviceFingerprint,
        riskScore,
        complianceFlags: eventRequest.complianceFlags,
        remedialActions: eventRequest.remedialActions,
        eventTime: new Date(),
        metadata: {
          source: 'audit-service',
          version: '1.0',
          timestamp: new Date().toISOString(),
        },
      };

      // Convert to snake_case for database
      const dbEventData = fieldNameConverter.camelToSnake(eventData);
      const [savedEvent] = await db
        .insert(securityAuditEvents)
        .values(dbEventData as any)
        .returning();

      // Stream event in real-time
      await this.streamEvent('security', savedEvent);

      // Check for critical events and trigger alerts
      if (
        eventRequest.severity === 'CRITICAL' ||
        eventRequest.result === 'FAILURE'
      ) {
        await this.processAlerts(savedEvent);
      }

      // Update compliance tracking if applicable
      if (
        eventRequest.complianceFlags &&
        eventRequest.complianceFlags.length > 0
      ) {
        await this.updateComplianceTracking(
          savedEvent,
          eventRequest.complianceFlags
        );
      }

      logger.info('[Audit] Security event logged successfully', {
        eventId: savedEvent.id,
        eventType: eventRequest.eventType,
        action: eventRequest.action,
        result: eventRequest.result,
        riskScore,
      });

      return savedEvent.id.toString();
    } catch (error) {
      logger.error('[Audit] Error logging security event', {
        eventRequest,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Log a system activity event
   */
  async logSystemActivity(
    activityRequest: SystemActivityLogRequest
  ): Promise<string> {
    try {
      logger.debug('[Audit] Logging system activity', {
        activityType: activityRequest.activityType,
        component: activityRequest.component,
        operation: activityRequest.operation,
        status: activityRequest.status,
      });

      const duration =
        activityRequest.endTime && activityRequest.startTime
          ? activityRequest.endTime.getTime() -
            activityRequest.startTime.getTime()
          : activityRequest.duration;

      const activityData: InsertSystemActivityLog = {
        activityType: activityRequest.activityType,
        activityCategory: activityRequest.activityCategory,
        component: activityRequest.component,
        operation: activityRequest.operation,
        status: activityRequest.status,
        priority: activityRequest.priority || 'MEDIUM',
        fileId: activityRequest.fileId,
        userId: activityRequest.userId,
        storageProvider: activityRequest.storageProvider,
        networkProvider: activityRequest.networkProvider,
        startTime: activityRequest.startTime,
        endTime: activityRequest.endTime,
        duration,
        bytesProcessed: activityRequest.bytesProcessed,
        resourcesUsed: activityRequest.resourcesUsed,
        performanceMetrics: activityRequest.performanceMetrics,
        healthIndicators: activityRequest.healthIndicators,
        errorDetails: activityRequest.errorDetails,
        warningMessages: activityRequest.warningMessages,
        configurationUsed: activityRequest.configurationUsed,
        environmentInfo: activityRequest.environmentInfo,
        auditTrail: [], // Will be populated with related events
        alertsTriggered: activityRequest.alertsTriggered,
        metadata: {
          ...activityRequest.metadata,
          source: 'audit-service',
          version: '1.0',
          timestamp: new Date().toISOString(),
        },
      };

      // Convert to snake_case for database
      const dbActivityData = fieldNameConverter.camelToSnake(activityData);
      const [savedActivity] = await db
        .insert(systemActivityLogs)
        .values(dbActivityData as any)
        .returning();

      // Stream activity in real-time
      await this.streamEvent('system', savedActivity);

      // Process performance metrics for anomaly detection
      if (activityRequest.performanceMetrics) {
        await this.processPerformanceMetrics(
          savedActivity,
          activityRequest.performanceMetrics
        );
      }

      logger.info('[Audit] System activity logged successfully', {
        activityId: savedActivity.id,
        activityType: activityRequest.activityType,
        component: activityRequest.component,
        operation: activityRequest.operation,
        status: activityRequest.status,
        duration,
      });

      return savedActivity.id.toString();
    } catch (error) {
      logger.error('[Audit] Error logging system activity', {
        activityRequest,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Log a compliance audit entry
   */
  async logComplianceAudit(
    complianceRequest: ComplianceAuditRequest
  ): Promise<string> {
    try {
      const auditId = crypto.randomUUID();

      logger.debug('[Audit] Logging compliance audit', {
        complianceFramework: complianceRequest.complianceFramework,
        requirementId: complianceRequest.requirementId,
        assessmentResult: complianceRequest.assessmentResult,
        entityType: complianceRequest.entityType,
        entityId: complianceRequest.entityId,
      });

      const complianceData: InsertComplianceAuditTrail = {
        auditId,
        complianceFramework: complianceRequest.complianceFramework,
        requirementId: complianceRequest.requirementId,
        requirementDescription: complianceRequest.requirementDescription,
        entityType: complianceRequest.entityType,
        entityId: complianceRequest.entityId,
        assessmentType: complianceRequest.assessmentType,
        assessmentResult: complianceRequest.assessmentResult,
        confidenceLevel: complianceRequest.confidenceLevel,
        assessorId: complianceRequest.assessorId,
        assessorType: complianceRequest.assessorType,
        evidenceCollected: complianceRequest.evidenceCollected,
        controlsEvaluated: complianceRequest.controlsEvaluated,
        findings: complianceRequest.findings,
        nonComplianceReasons: complianceRequest.nonComplianceReasons,
        remediationRequired: complianceRequest.remediationRequired || false,
        remediationPlan: complianceRequest.remediationPlan,
        remediationDeadline: complianceRequest.remediationDeadline,
        riskLevel: complianceRequest.riskLevel || 'MEDIUM',
        businessImpact: complianceRequest.businessImpact,
        regulatoryImplications: complianceRequest.regulatoryImplications,
        previousAssessmentId: complianceRequest.previousAssessmentId,
        metadata: {
          ...complianceRequest.metadata,
          source: 'audit-service',
          version: '1.0',
          timestamp: new Date().toISOString(),
        },
      };

      // Convert to snake_case for database
      const dbComplianceData = fieldNameConverter.camelToSnake(complianceData);
      const [savedCompliance] = await db
        .insert(complianceAuditTrail)
        .values(dbComplianceData as any)
        .returning();

      // Stream compliance event
      await this.streamEvent('compliance', savedCompliance);

      // Update compliance dashboard metrics
      await this.updateComplianceMetrics(
        complianceRequest.complianceFramework,
        complianceRequest.assessmentResult
      );

      logger.info('[Audit] Compliance audit logged successfully', {
        auditId,
        complianceFramework: complianceRequest.complianceFramework,
        requirementId: complianceRequest.requirementId,
        assessmentResult: complianceRequest.assessmentResult,
        riskLevel: complianceRequest.riskLevel,
      });

      return auditId;
    } catch (error) {
      logger.error('[Audit] Error logging compliance audit', {
        complianceRequest,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Query audit events with filters
   */
  async queryAuditEvents(query: AuditQuery): Promise<{
    events: SecurityAuditEvent[];
    totalCount: number;
    hasMore: boolean;
  }> {
    try {
      logger.debug('[Audit] Querying audit events', { query });

      // Build filter conditions
      const conditions: any[] = [];

      if (query.eventTypes && query.eventTypes.length > 0) {
        conditions.push(
          sql`${securityAuditEvents.eventType} = ANY(${query.eventTypes})`
        );
      }

      if (query.categories && query.categories.length > 0) {
        conditions.push(
          sql`${securityAuditEvents.eventCategory} = ANY(${query.categories})`
        );
      }

      if (query.severities && query.severities.length > 0) {
        conditions.push(
          sql`${securityAuditEvents.severity} = ANY(${query.severities})`
        );
      }

      if (query.results && query.results.length > 0) {
        conditions.push(
          sql`${securityAuditEvents.result} = ANY(${query.results})`
        );
      }

      if (query.userIds && query.userIds.length > 0) {
        conditions.push(
          sql`${securityAuditEvents.userId} = ANY(${query.userIds})`
        );
      }

      if (query.fileIds && query.fileIds.length > 0) {
        conditions.push(
          sql`${securityAuditEvents.fileId} = ANY(${query.fileIds})`
        );
      }

      if (query.startDate && query.endDate) {
        conditions.push(
          between(securityAuditEvents.eventTime, query.startDate, query.endDate)
        );
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      // Build order by clause
      let orderBy;
      const sortColumn =
        query.sortBy === 'severity'
          ? securityAuditEvents.severity
          : query.sortBy === 'result'
            ? securityAuditEvents.result
            : securityAuditEvents.eventTime;

      orderBy = query.sortOrder === 'asc' ? asc(sortColumn as AnyColumn) : desc(sortColumn as AnyColumn);

      // Get total count
      const [countResult] = await db
        .select({ count: count() })
        .from(securityAuditEvents)
        .where(whereClause);

      const totalCount = countResult.count;

      // Get events
      const events = await db
        .select()
        .from(securityAuditEvents)
        .where(whereClause)
        .orderBy(orderBy)
        .limit(query.limit || 50)
        .offset(query.offset || 0);

      const convertedEvents = events.map(event =>
        fieldNameConverter.snakeToCamel(event)
      );
      const hasMore = (query.offset || 0) + events.length < totalCount;

      logger.info('[Audit] Audit events queried successfully', {
        totalCount,
        returnedCount: events.length,
        hasMore,
      });

      return {
        events: convertedEvents,
        totalCount,
        hasMore,
      };
    } catch (error) {
      logger.error('[Audit] Error querying audit events', {
        query,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate comprehensive audit statistics
   */
  async getAuditStatistics(timeRange?: {
    start: Date;
    end: Date;
  }): Promise<AuditStatistics> {
    try {
      logger.debug('[Audit] Generating audit statistics', { timeRange });

      // Check cache first
      const cacheKey = `audit_stats:${timeRange ? `${timeRange.start.getTime()}_${timeRange.end.getTime()}` : 'all_time'}`;
      const cached = await redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }

      // Build date filter
      let dateFilter = sql`1=1`;
      if (timeRange) {
        dateFilter = and(
          sql`${securityAuditEvents.eventTime} >= ${timeRange.start}`,
          sql`${securityAuditEvents.eventTime} <= ${timeRange.end}`
        )!;
      }

      // Get basic counts
      const [basicStats] = await db
        .select({
          totalEvents: count(),
          avgRiskScore: sql`avg(${securityAuditEvents.riskScore})`,
          criticalCount: sql`count(*) filter (where ${securityAuditEvents.severity} = 'CRITICAL')`,
          failureCount: sql`count(*) filter (where ${securityAuditEvents.result} = 'FAILURE')`,
        })
        .from(securityAuditEvents)
        .where(dateFilter);

      // Get events by type
      const eventsByType = await db
        .select({
          eventType: securityAuditEvents.eventType,
          count: count(),
        })
        .from(securityAuditEvents)
        .where(dateFilter)
        .groupBy(securityAuditEvents.eventType);

      // Get events by category
      const eventsByCategory = await db
        .select({
          eventCategory: securityAuditEvents.eventCategory,
          count: count(),
        })
        .from(securityAuditEvents)
        .where(dateFilter)
        .groupBy(securityAuditEvents.eventCategory);

      // Get events by severity
      const eventsBySeverity = await db
        .select({
          severity: securityAuditEvents.severity,
          count: count(),
        })
        .from(securityAuditEvents)
        .where(dateFilter)
        .groupBy(securityAuditEvents.severity);

      // Get events by result
      const eventsByResult = await db
        .select({
          result: securityAuditEvents.result,
          count: count(),
        })
        .from(securityAuditEvents)
        .where(dateFilter)
        .groupBy(securityAuditEvents.result);

      // Get top users
      const topUsers = await db
        .select({
          userId: securityAuditEvents.userId,
          eventCount: count(),
        })
        .from(securityAuditEvents)
        .where(and(dateFilter, sql`${securityAuditEvents.userId} IS NOT NULL`))
        .groupBy(securityAuditEvents.userId)
        .orderBy(desc(count()))
        .limit(10);

      // Get top files
      const topFiles = await db
        .select({
          fileId: securityAuditEvents.fileId,
          eventCount: count(),
        })
        .from(securityAuditEvents)
        .where(and(dateFilter, sql`${securityAuditEvents.fileId} IS NOT NULL`))
        .groupBy(securityAuditEvents.fileId)
        .orderBy(desc(count()))
        .limit(10);

      // Get recent critical events
      const recentCriticalEvents = await db
        .select()
        .from(securityAuditEvents)
        .where(and(dateFilter, eq(securityAuditEvents.severity, 'CRITICAL')))
        .orderBy(desc(securityAuditEvents.eventTime))
        .limit(10);

      // Calculate compliance and risk scores
      const complianceScore = await this.calculateComplianceScore();
      const riskScore = Number(basicStats.avgRiskScore) || 0;

      const statistics: AuditStatistics = {
        totalEvents: basicStats.totalEvents,
        eventsByType: eventsByType.reduce(
          (acc, item) => {
            acc[item.eventType] = item.count;
            return acc;
          },
          {} as Record<string, number>
        ),
        eventsByCategory: eventsByCategory.reduce(
          (acc, item) => {
            acc[item.eventCategory] = item.count;
            return acc;
          },
          {} as Record<string, number>
        ),
        eventsBySeverity: eventsBySeverity.reduce(
          (acc, item) => {
            acc[item.severity] = item.count;
            return acc;
          },
          {} as Record<string, number>
        ),
        eventsByResult: eventsByResult.reduce(
          (acc, item) => {
            acc[item.result] = item.count;
            return acc;
          },
          {} as Record<string, number>
        ),
        topUsers: topUsers.map(user => ({
          userId: user.userId!,
          eventCount: user.eventCount,
        })),
        topFiles: topFiles.map(file => ({
          fileId: file.fileId!,
          eventCount: file.eventCount,
        })),
        trendData: [], // Would be implemented with time-series data
        complianceScore,
        riskScore,
        alertCount: Number(basicStats.criticalCount) + Number(basicStats.failureCount),
        recentCriticalEvents: recentCriticalEvents.map(event =>
          fieldNameConverter.snakeToCamel(event)
        ) as any,
      };

      // Cache the statistics
      await redis.setex(cacheKey, AUDIT_CACHE_TTL, JSON.stringify(statistics));

      logger.info('[Audit] Audit statistics generated successfully', {
        totalEvents: statistics.totalEvents,
        complianceScore: statistics.complianceScore,
        riskScore: statistics.riskScore,
        alertCount: statistics.alertCount,
      });

      return statistics;
    } catch (error) {
      logger.error('[Audit] Error generating audit statistics', {
        timeRange,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Generate comprehensive audit report
   */
  async generateAuditReport(
    reportRequest: AuditReportRequest
  ): Promise<AuditReport> {
    try {
      const reportId = crypto.randomUUID();
      const startTime = Date.now();

      logger.info('[Audit] Generating audit report', {
        reportId,
        reportType: reportRequest.reportType,
        reportCategory: reportRequest.reportCategory,
        period: `${reportRequest.periodStart} - ${reportRequest.periodEnd}`,
      });

      // Get audit statistics for the period
      const statistics = await this.getAuditStatistics({
        start: reportRequest.periodStart,
        end: reportRequest.periodEnd,
      });

      // Generate findings based on report type
      const findings = await this.generateReportFindings(
        reportRequest,
        statistics
      );

      // Generate recommendations
      const recommendations = this.generateRecommendations(
        findings,
        statistics
      );

      // Assess compliance status
      const complianceStatus = await this.generateComplianceStatus(
        reportRequest.periodStart,
        reportRequest.periodEnd
      );

      // Calculate risk assessment
      const riskAssessment = this.calculateRiskAssessment(statistics, findings);

      // Create summary
      const summary = this.createReportSummary(
        statistics,
        findings,
        recommendations
      );

      const generationTime = Date.now() - startTime;

      const reportData: InsertAuditReport = {
        reportId,
        reportType: reportRequest.reportType,
        reportCategory: reportRequest.reportCategory,
        title: reportRequest.title,
        description: reportRequest.description,
        generatedBy: reportRequest.generatedBy,
        periodStart: reportRequest.periodStart,
        periodEnd: reportRequest.periodEnd,
        status: 'COMPLETED',
        format: reportRequest.format || 'JSON',
        parameters: reportRequest.parameters,
        summary,
        findings,
        recommendations,
        complianceStatus,
        riskAssessment,
        actionItems: this.extractActionItems(recommendations),
        distributionList: reportRequest.distributionList,
        generationTime,
        recordsProcessed: statistics.totalEvents,
        metadata: {
          generatedAt: new Date().toISOString(),
          version: '1.0',
          source: 'audit-service',
        },
      };

      // Convert to snake_case and save
      const dbReportData = fieldNameConverter.camelToSnake(reportData);
      const [savedReport] = await db
        .insert(auditReports)
        .values(dbReportData as any)
        .returning();

      const convertedReport = fieldNameConverter.snakeToCamel(savedReport);

      logger.info('[Audit] Audit report generated successfully', {
        reportId,
        reportType: reportRequest.reportType,
        generationTime,
        recordsProcessed: statistics.totalEvents,
        findingsCount: Array.isArray(findings)
          ? findings.length
          : Object.keys(findings).length,
      });

      return convertedReport;
    } catch (error) {
      logger.error('[Audit] Error generating audit report', {
        reportRequest,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Log a file-specific audit event
   * Specialized method for file operations with enhanced context
   */
  async logFileEvent(
    fileEventRequest: FileAuditEventRequest
  ): Promise<string> {
    try {
      // Calculate file-specific risk score
      const riskScore = this.calculateFileRiskScore(fileEventRequest);

      logger.debug('[Audit] Logging file event', {
        eventType: fileEventRequest.eventType,
        fileId: fileEventRequest.fileId,
        fileName: fileEventRequest.fileName,
        operation: fileEventRequest.operation,
        result: fileEventRequest.result,
        severity: fileEventRequest.severity || 'MEDIUM',
        riskScore,
      });

      // Determine event category based on event type
      const eventCategory = this.determineFileEventCategory(fileEventRequest.eventType);

      // Map to security audit event for storage
      const securityEventRequest: SecurityAuditEventRequest = {
        eventType: 'AUTHORIZATION', // File operations are authorization events
        eventCategory,
        userId: fileEventRequest.userId,
        fileId: fileEventRequest.fileId,
        resourceType: 'FILE',
        resourceId: fileEventRequest.fileId,
        action: fileEventRequest.eventType,
        result: (fileEventRequest.result === 'WARNING' ? 'ERROR' : fileEventRequest.result) as 'SUCCESS' | 'FAILURE' | 'DENIED' | 'ERROR',
        severity: fileEventRequest.severity || this.determineFileSeverity(fileEventRequest),
        details: {
          fileOperation: fileEventRequest.eventType,
          fileName: fileEventRequest.fileName,
          operation: fileEventRequest.operation,
          ...fileEventRequest.details,
        },
        complianceFlags: this.getFileComplianceFlags(fileEventRequest),
        context: fileEventRequest.context,
      };

      // Log using existing security event mechanism
      const eventId = await this.logSecurityEvent(securityEventRequest);

      // Stream file-specific event for real-time monitoring
      await this.streamEvent('file', {
        eventId,
        ...fileEventRequest,
        riskScore,
        timestamp: new Date(),
      });

      // Check for file-specific alert conditions
      await this.checkFileAlertConditions(fileEventRequest);

      logger.info('[Audit] File event logged successfully', {
        eventId,
        eventType: fileEventRequest.eventType,
        fileId: fileEventRequest.fileId,
        fileName: fileEventRequest.fileName,
        result: fileEventRequest.result,
        riskScore,
      });

      return eventId;
    } catch (error) {
      logger.error('[Audit] Error logging file event', {
        fileEventRequest,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Log file upload event
   */
  async logFileUpload(params: {
    fileId: string;
    fileName: string;
    fileSize: number;
    mimeType: string;
    userId: number;
    storagePath: string;
    storageProvider: string;
    checksum: string;
    isEncrypted?: boolean;
    encryptionKeyId?: string;
    virusScanPassed?: boolean;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_UPLOADED,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: 'UPLOAD',
      userId: params.userId,
      result: 'SUCCESS',
      severity: 'LOW',
      details: {
        fileSize: params.fileSize,
        mimeType: params.mimeType,
        storagePath: params.storagePath,
        storageProvider: params.storageProvider,
        checksum: params.checksum,
        isEncrypted: params.isEncrypted,
        encryptionKeyId: params.encryptionKeyId,
        virusScanPassed: params.virusScanPassed,
      },
      context: params.context,
    });
  }

  /**
   * Log file download event
   */
  async logFileDownload(params: {
    fileId: string;
    fileName: string;
    userId: number;
    presignedUrl?: boolean;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_DOWNLOADED,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: 'DOWNLOAD',
      userId: params.userId,
      result: 'SUCCESS',
      severity: 'LOW',
      details: {
        presignedUrl: params.presignedUrl,
      },
      context: params.context,
    });
  }

  /**
   * Log file deletion event
   */
  async logFileDelete(params: {
    fileId: string;
    fileName: string;
    userId: number;
    reason?: string;
    permanent?: boolean;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_DELETED,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: 'DELETE',
      userId: params.userId,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      details: {
        reason: params.reason,
        permanent: params.permanent,
      },
      context: params.context,
    });
  }

  /**
   * Log file encryption event
   */
  async logFileEncryption(params: {
    fileId: string;
    fileName: string;
    userId: number;
    algorithm: string;
    keyId: string;
    autoEncrypted?: boolean;
    encryptionReason?: string;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_ENCRYPTED,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: 'ENCRYPT',
      userId: params.userId,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      details: {
        encryptionAlgorithm: params.algorithm,
        encryptionKeyId: params.keyId,
        autoEncrypted: params.autoEncrypted,
        encryptionReason: params.encryptionReason,
      },
      context: params.context,
    });
  }

  /**
   * Log file decryption event
   */
  async logFileDecryption(params: {
    fileId: string;
    fileName: string;
    userId: number;
    keyId: string;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_DECRYPTED,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: 'DECRYPT',
      userId: params.userId,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      details: {
        encryptionKeyId: params.keyId,
      },
      context: params.context,
    });
  }

  /**
   * Log virus detected event
   */
  async logVirusDetected(params: {
    fileId: string;
    fileName: string;
    userId: number;
    threatName: string;
    scanResult: string;
    actionTaken: 'QUARANTINED' | 'DELETED' | 'BLOCKED';
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_VIRUS_DETECTED,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: 'VIRUS_SCAN',
      userId: params.userId,
      result: 'FAILURE',
      severity: 'CRITICAL',
      details: {
        threatName: params.threatName,
        virusScanResult: params.scanResult,
        actionTaken: params.actionTaken,
      },
      context: params.context,
    });
  }

  /**
   * Log file version created event
   */
  async logFileVersionCreated(params: {
    fileId: string;
    fileName: string;
    userId: number;
    versionNumber: number;
    previousVersion?: number;
    versionComment?: string;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_VERSION_CREATED,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: 'VERSION_CREATE',
      userId: params.userId,
      result: 'SUCCESS',
      severity: 'LOW',
      details: {
        versionNumber: params.versionNumber,
        previousVersion: params.previousVersion,
        versionComment: params.versionComment,
      },
      context: params.context,
    });
  }

  /**
   * Log file version rollback event
   */
  async logFileVersionRollback(params: {
    fileId: string;
    fileName: string;
    userId: number;
    fromVersion: number;
    toVersion: number;
    reason?: string;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_VERSION_ROLLBACK,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: 'VERSION_ROLLBACK',
      userId: params.userId,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      details: {
        fromVersion: params.fromVersion,
        toVersion: params.toVersion,
        reason: params.reason,
      },
      context: params.context,
    });
  }

  /**
   * Log file integrity verification event
   */
  async logFileIntegrityCheck(params: {
    fileId: string;
    fileName: string;
    userId: number;
    passed: boolean;
    algorithms: string[];
    issues?: string[];
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: params.passed
        ? FILE_AUDIT_EVENTS.FILE_INTEGRITY_VERIFIED
        : FILE_AUDIT_EVENTS.FILE_INTEGRITY_FAILED,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: 'INTEGRITY_CHECK',
      userId: params.userId,
      result: params.passed ? 'SUCCESS' : 'FAILURE',
      severity: params.passed ? 'LOW' : 'CRITICAL',
      details: {
        integrityAlgorithms: params.algorithms,
        issues: params.issues,
      },
      context: params.context,
    });
  }

  /**
   * Log file access denied event
   */
  async logFileAccessDenied(params: {
    fileId: string;
    fileName: string;
    userId: number;
    attemptedOperation: string;
    requiredPermission: string;
    reason: string;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_ACCESS_DENIED,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: params.attemptedOperation,
      userId: params.userId,
      result: 'DENIED',
      severity: 'HIGH',
      details: {
        attemptedOperation: params.attemptedOperation,
        requiredPermission: params.requiredPermission,
        reason: params.reason,
      },
      context: params.context,
    });
  }

  /**
   * Log file quota exceeded event
   */
  async logFileQuotaExceeded(params: {
    fileId?: string;
    fileName?: string;
    userId: number;
    quotaUsed: number;
    quotaLimit: number;
    attemptedSize?: number;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_QUOTA_EXCEEDED,
      fileId: params.fileId || 'N/A',
      fileName: params.fileName || 'N/A',
      operation: 'QUOTA_CHECK',
      userId: params.userId,
      result: 'DENIED',
      severity: 'MEDIUM',
      details: {
        quotaUsed: params.quotaUsed,
        quotaLimit: params.quotaLimit,
        attemptedSize: params.attemptedSize,
        quotaPercentage: Math.round((params.quotaUsed / params.quotaLimit) * 100),
      },
      context: params.context,
    });
  }

  /**
   * Log file cleanup execution event
   */
  async logFileCleanupExecuted(params: {
    userId: number;
    cleanupType: string;
    filesDeleted: number;
    bytesRecovered: number;
    reason: string;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_CLEANUP_EXECUTED,
      fileId: 'BATCH',
      fileName: 'BATCH',
      operation: 'CLEANUP',
      userId: params.userId,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      details: {
        cleanupType: params.cleanupType,
        filesDeleted: params.filesDeleted,
        bytesRecovered: params.bytesRecovered,
        cleanupReason: params.reason,
      },
      context: params.context,
    });
  }

  /**
   * Log file sharing event
   */
  async logFileShared(params: {
    fileId: string;
    fileName: string;
    userId: number;
    recipientId?: number;
    recipientEmail?: string;
    shareType: 'LINK' | 'EMAIL' | 'USER';
    permissionLevel: string;
    expiresAt?: Date;
    context?: AuditContext;
  }): Promise<string> {
    return this.logFileEvent({
      eventType: FILE_AUDIT_EVENTS.FILE_SHARED,
      fileId: params.fileId,
      fileName: params.fileName,
      operation: 'SHARE',
      userId: params.userId,
      result: 'SUCCESS',
      severity: 'MEDIUM',
      details: {
        recipientId: params.recipientId,
        shareRecipient: params.recipientEmail || `user:${params.recipientId}`,
        shareType: params.shareType,
        permissionLevel: params.permissionLevel,
        expiresAt: params.expiresAt?.toISOString(),
      },
      context: params.context,
    });
  }

  /**
   * Calculate file-specific risk score
   */
  private calculateFileRiskScore(request: FileAuditEventRequest): number {
    let score = 0;

    // Event type base scores
    const eventTypeScores: Record<string, number> = {
      [FILE_AUDIT_EVENTS.FILE_VIRUS_DETECTED]: 90,
      [FILE_AUDIT_EVENTS.FILE_INTEGRITY_FAILED]: 80,
      [FILE_AUDIT_EVENTS.FILE_ACCESS_DENIED]: 60,
      [FILE_AUDIT_EVENTS.FILE_MALWARE_QUARANTINED]: 85,
      [FILE_AUDIT_EVENTS.FILE_CHECKSUM_MISMATCH]: 70,
      [FILE_AUDIT_EVENTS.FILE_DELETED]: 40,
      [FILE_AUDIT_EVENTS.FILE_ENCRYPTED]: 20,
      [FILE_AUDIT_EVENTS.FILE_DECRYPTED]: 30,
      [FILE_AUDIT_EVENTS.FILE_SHARED]: 35,
      [FILE_AUDIT_EVENTS.FILE_PERMISSION_CHANGED]: 45,
      [FILE_AUDIT_EVENTS.FILE_VERSION_ROLLBACK]: 35,
      [FILE_AUDIT_EVENTS.FILE_UPLOADED]: 10,
      [FILE_AUDIT_EVENTS.FILE_DOWNLOADED]: 15,
    };

    score = eventTypeScores[request.eventType] || 20;

    // Result modifiers
    if (request.result === 'FAILURE') score += 20;
    if (request.result === 'DENIED') score += 15;
    if (request.result === 'WARNING') score += 10;

    // Severity modifiers
    if (request.severity === 'CRITICAL') score += 30;
    else if (request.severity === 'HIGH') score += 20;
    else if (request.severity === 'MEDIUM') score += 10;

    // File-specific modifiers
    if (request.details?.mimeType?.includes('executable')) score += 25;
    if (request.details?.fileSize && request.details.fileSize > 100 * 1024 * 1024) score += 15; // Large files

    return Math.min(Math.round(score), 100);
  }

  /**
   * Determine file event category
   */
  private determineFileEventCategory(
    eventType: FileAuditEventType
  ): 'SECURITY' | 'COMPLIANCE' | 'SYSTEM' | 'USER_ACTION' {
    const securityEvents: FileAuditEventType[] = [
      FILE_AUDIT_EVENTS.FILE_VIRUS_DETECTED,
      FILE_AUDIT_EVENTS.FILE_MALWARE_QUARANTINED,
      FILE_AUDIT_EVENTS.FILE_ENCRYPTED,
      FILE_AUDIT_EVENTS.FILE_DECRYPTED,
      FILE_AUDIT_EVENTS.FILE_ACCESS_DENIED,
      FILE_AUDIT_EVENTS.FILE_ENCRYPTION_KEY_ROTATED,
    ];

    const complianceEvents: FileAuditEventType[] = [
      FILE_AUDIT_EVENTS.FILE_INTEGRITY_VERIFIED,
      FILE_AUDIT_EVENTS.FILE_INTEGRITY_FAILED,
      FILE_AUDIT_EVENTS.FILE_CHECKSUM_MISMATCH,
      FILE_AUDIT_EVENTS.FILE_HASH_GENERATED,
    ];

    const systemEvents: FileAuditEventType[] = [
      FILE_AUDIT_EVENTS.FILE_CLEANUP_EXECUTED,
      FILE_AUDIT_EVENTS.FILE_EXPIRED,
      FILE_AUDIT_EVENTS.FILE_ARCHIVED,
      FILE_AUDIT_EVENTS.FILE_QUOTA_EXCEEDED,
    ];

    if (securityEvents.includes(eventType)) return 'SECURITY';
    if (complianceEvents.includes(eventType)) return 'COMPLIANCE';
    if (systemEvents.includes(eventType)) return 'SYSTEM';
    return 'USER_ACTION';
  }

  /**
   * Determine appropriate severity for file events
   */
  private determineFileSeverity(
    request: FileAuditEventRequest
  ): 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL' {
    const criticalEvents: FileAuditEventType[] = [
      FILE_AUDIT_EVENTS.FILE_VIRUS_DETECTED,
      FILE_AUDIT_EVENTS.FILE_INTEGRITY_FAILED,
      FILE_AUDIT_EVENTS.FILE_MALWARE_QUARANTINED,
    ];

    const highEvents: FileAuditEventType[] = [
      FILE_AUDIT_EVENTS.FILE_ACCESS_DENIED,
      FILE_AUDIT_EVENTS.FILE_CHECKSUM_MISMATCH,
      FILE_AUDIT_EVENTS.FILE_ENCRYPTION_KEY_ROTATED,
    ];

    const mediumEvents: FileAuditEventType[] = [
      FILE_AUDIT_EVENTS.FILE_DELETED,
      FILE_AUDIT_EVENTS.FILE_ENCRYPTED,
      FILE_AUDIT_EVENTS.FILE_DECRYPTED,
      FILE_AUDIT_EVENTS.FILE_SHARED,
      FILE_AUDIT_EVENTS.FILE_PERMISSION_CHANGED,
      FILE_AUDIT_EVENTS.FILE_VERSION_ROLLBACK,
      FILE_AUDIT_EVENTS.FILE_QUOTA_EXCEEDED,
    ];

    if (criticalEvents.includes(request.eventType)) return 'CRITICAL';
    if (highEvents.includes(request.eventType)) return 'HIGH';
    if (mediumEvents.includes(request.eventType)) return 'MEDIUM';
    return 'LOW';
  }

  /**
   * Get compliance flags for file events
   */
  private getFileComplianceFlags(request: FileAuditEventRequest): string[] {
    const flags: string[] = [];

    // GDPR-related flags
    if (request.eventType === FILE_AUDIT_EVENTS.FILE_DELETED) {
      flags.push('GDPR_DATA_ERASURE');
    }

    // SOC2-related flags
    if (([FILE_AUDIT_EVENTS.FILE_ENCRYPTED, FILE_AUDIT_EVENTS.FILE_DECRYPTED] as FileAuditEventType[]).includes(request.eventType)) {
      flags.push('SOC2_ENCRYPTION_CONTROLS');
    }

    if (request.eventType === FILE_AUDIT_EVENTS.FILE_INTEGRITY_VERIFIED ||
        request.eventType === FILE_AUDIT_EVENTS.FILE_INTEGRITY_FAILED) {
      flags.push('SOC2_DATA_INTEGRITY');
    }

    if (request.eventType === FILE_AUDIT_EVENTS.FILE_ACCESS_DENIED) {
      flags.push('SOC2_ACCESS_CONTROL');
    }

    // Security-related flags
    if (request.eventType === FILE_AUDIT_EVENTS.FILE_VIRUS_DETECTED) {
      flags.push('SECURITY_THREAT_DETECTED');
      flags.push('INCIDENT_RESPONSE_REQUIRED');
    }

    return flags;
  }

  /**
   * Check file-specific alert conditions
   */
  private async checkFileAlertConditions(
    request: FileAuditEventRequest
  ): Promise<void> {
    // Critical events that require immediate alerts
    const criticalAlertEvents: FileAuditEventType[] = [
      FILE_AUDIT_EVENTS.FILE_VIRUS_DETECTED,
      FILE_AUDIT_EVENTS.FILE_INTEGRITY_FAILED,
      FILE_AUDIT_EVENTS.FILE_MALWARE_QUARANTINED,
    ];

    if (criticalAlertEvents.includes(request.eventType)) {
      await this.triggerFileAlert({
        type: 'CRITICAL_FILE_SECURITY_EVENT',
        eventType: request.eventType,
        fileId: request.fileId,
        fileName: request.fileName,
        severity: 'CRITICAL',
        message: `Critical file security event: ${request.eventType}`,
        details: request.details,
        timestamp: new Date(),
      });
    }

    // Check for suspicious access patterns
    if (request.eventType === FILE_AUDIT_EVENTS.FILE_ACCESS_DENIED) {
      const recentDenials = await this.getRecentAccessDenials(
        request.userId,
        5 * 60 * 1000 // 5 minutes
      );

      if (recentDenials.length >= 5) {
        await this.triggerFileAlert({
          type: 'SUSPICIOUS_ACCESS_PATTERN',
          eventType: request.eventType,
          fileId: request.fileId,
          fileName: request.fileName,
          severity: 'HIGH',
          message: `Multiple access denials detected for user ${request.userId}`,
          details: { denialCount: recentDenials.length },
          timestamp: new Date(),
        });
      }
    }
  }

  /**
   * Trigger file-specific alert
   */
  private async triggerFileAlert(alert: any): Promise<void> {
    try {
      // Store alert in Redis for real-time monitoring
      const alertKey = `file_alert:${alert.type}:${Date.now()}`;
      await redis.setex(alertKey, ALERT_CACHE_TTL, JSON.stringify(alert));

      // Publish to file alert channel
      await redis.publish('file-alerts', JSON.stringify(alert));

      logger.warn('[Audit] File alert triggered', alert);
    } catch (error) {
      logger.error('[Audit] Failed to trigger file alert', {
        alert,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get recent access denial events for a user
   */
  private async getRecentAccessDenials(
    userId: number | undefined,
    timeWindowMs: number
  ): Promise<any[]> {
    if (!userId) return [];

    try {
      const startTime = new Date(Date.now() - timeWindowMs);

      const denials = await db
        .select()
        .from(securityAuditEvents)
        .where(
          and(
            eq(securityAuditEvents.userId, userId),
            eq(securityAuditEvents.result, 'DENIED'),
            sql`${securityAuditEvents.eventTime} >= ${startTime}`
          )
        )
        .limit(20);

      return denials;
    } catch (error) {
      logger.error('[Audit] Failed to get recent access denials', {
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Subscribe to real-time audit alerts
   */
  subscribeToAlerts(callback: (event: SecurityAuditEvent) => void): () => void {
    this.alertSubscribers.add(callback);

    return () => {
      this.alertSubscribers.delete(callback);
    };
  }

  /**
   * Calculate risk score for a security event
   */
  private calculateRiskScore(eventRequest: SecurityAuditEventRequest): number {
    let score = 0;

    // Base score by event type
    const eventTypeScores = {
      AUTHENTICATION: 20,
      AUTHORIZATION: 30,
      PERMISSION_CHANGE: 40,
      ACCESS_VIOLATION: 60,
      ADMIN_ACTION: 50,
    };
    score += eventTypeScores[eventRequest.eventType] || 20;

    // Severity multiplier
    const severityMultipliers = {
      LOW: 0.5,
      MEDIUM: 1.0,
      HIGH: 1.5,
      CRITICAL: 2.0,
    };
    score *= severityMultipliers[eventRequest.severity || 'MEDIUM'];

    // Result impact
    if (eventRequest.result === 'FAILURE' || eventRequest.result === 'DENIED') {
      score += 20;
    }

    // Compliance flags impact
    if (
      eventRequest.complianceFlags &&
      eventRequest.complianceFlags.length > 0
    ) {
      score += eventRequest.complianceFlags.length * 10;
    }

    return Math.min(Math.round(score), 100);
  }

  /**
   * Set up real-time event streaming
   */
  private async setupEventStreaming(): Promise<void> {
    try {
      // Set up Redis streams for real-time audit events
      await redis.xgroup(
        'CREATE',
        'audit-events',
        'audit-consumers',
        '0',
        'MKSTREAM'
      );
    } catch (error) {
      // Group might already exist
      logger.debug('[Audit] Event streaming group already exists or created');
    }
  }

  /**
   * Stream audit event for real-time processing
   */
  private async streamEvent(eventType: string, eventData: any): Promise<void> {
    try {
      await redis.xadd(
        'audit-events',
        '*',
        'type',
        eventType,
        'data',
        JSON.stringify(eventData),
        'timestamp',
        Date.now().toString()
      );
    } catch (error) {
      logger.warn('[Audit] Failed to stream event', {
        eventType,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process alerts for critical events
   */
  private async processAlerts(event: any): Promise<void> {
    try {
      // Notify subscribers
      const convertedEvent = fieldNameConverter.snakeToCamel(event);
      this.alertSubscribers.forEach(callback => {
        try {
          callback(convertedEvent);
        } catch (error) {
          logger.error('[Audit] Error in alert callback', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      });

      // Store alert in cache for dashboard
      const alertKey = `alert:${event.id}:${Date.now()}`;
      await redis.setex(
        alertKey,
        ALERT_CACHE_TTL,
        JSON.stringify(convertedEvent)
      );
    } catch (error) {
      logger.error('[Audit] Error processing alerts', {
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Initialize compliance monitoring
   */
  private async initializeComplianceMonitoring(): Promise<void> {
    logger.info('[Audit] Initializing compliance monitoring');
    // This would set up periodic compliance checks
    // Implementation would depend on specific compliance requirements
  }

  /**
   * Update compliance tracking
   */
  private async updateComplianceTracking(
    event: any,
    complianceFlags: string[]
  ): Promise<void> {
    try {
      // This would update compliance metrics based on the event
      for (const flag of complianceFlags) {
        const metricKey = `compliance:${flag}:events`;
        await redis.incr(metricKey);
        await redis.expire(metricKey, 86400); // 24 hours
      }
    } catch (error) {
      logger.error('[Audit] Error updating compliance tracking', {
        eventId: event.id,
        complianceFlags,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process performance metrics for anomaly detection
   */
  private async processPerformanceMetrics(
    activity: any,
    metrics: Record<string, any>
  ): Promise<void> {
    try {
      // This would implement performance anomaly detection
      // For now, just log unusual metrics
      if (metrics.responseTime && metrics.responseTime > 5000) {
        logger.warn('[Audit] High response time detected', {
          activityId: activity.id,
          responseTime: metrics.responseTime,
        });
      }
    } catch (error) {
      logger.error('[Audit] Error processing performance metrics', {
        activityId: activity.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update compliance metrics
   */
  private async updateComplianceMetrics(
    framework: string,
    result: string
  ): Promise<void> {
    try {
      const metricKey = `compliance:${framework}:${result}`;
      await redis.incr(metricKey);
      await redis.expire(metricKey, 86400 * 30); // 30 days
    } catch (error) {
      logger.error('[Audit] Error updating compliance metrics', {
        framework,
        result,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Calculate overall compliance score
   */
  private async calculateComplianceScore(): Promise<number> {
    try {
      // Get compliance metrics from Redis
      const frameworks = ['SOC2', 'GDPR', 'HIPAA', 'PCI_DSS', 'ISO27001'];
      let totalAssessments = 0;
      let compliantAssessments = 0;

      for (const framework of frameworks) {
        const compliant =
          (await redis.get(`compliance:${framework}:COMPLIANT`)) || '0';
        const nonCompliant =
          (await redis.get(`compliance:${framework}:NON_COMPLIANT`)) || '0';
        const partial =
          (await redis.get(`compliance:${framework}:PARTIAL`)) || '0';

        totalAssessments +=
          parseInt(compliant) + parseInt(nonCompliant) + parseInt(partial);
        compliantAssessments += parseInt(compliant) + parseInt(partial) * 0.5;
      }

      return totalAssessments > 0
        ? Math.round((compliantAssessments / totalAssessments) * 100)
        : 0;
    } catch (error) {
      logger.error('[Audit] Error calculating compliance score', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  /**
   * Generate report findings based on type
   */
  private async generateReportFindings(
    reportRequest: AuditReportRequest,
    statistics: AuditStatistics
  ): Promise<Record<string, any>> {
    const findings: Record<string, any> = {};

    switch (reportRequest.reportType) {
      case 'SECURITY':
        findings.securityEvents = statistics.eventsByType;
        findings.severityDistribution = statistics.eventsBySeverity;
        findings.criticalEvents = statistics.recentCriticalEvents;
        findings.topRiskUsers = statistics.topUsers.slice(0, 5);
        break;

      case 'COMPLIANCE':
        findings.complianceScore = statistics.complianceScore;
        findings.frameworkStatus = await this.getFrameworkStatus();
        findings.nonCompliantAreas = await this.getNonCompliantAreas();
        break;

      case 'SYSTEM':
        findings.systemHealth = await this.getSystemHealthFindings();
        findings.performanceMetrics = await this.getPerformanceFindings();
        break;

      default:
        findings.overview = statistics;
        break;
    }

    return findings;
  }

  /**
   * Generate recommendations for report
   */
  private generateRecommendations(
    findings: Record<string, any>,
    statistics: AuditStatistics
  ): string[] {
    const recommendations: string[] = [];

    if (statistics.riskScore > 70) {
      recommendations.push(
        'High risk score detected - review security policies and access controls'
      );
    }

    if (statistics.complianceScore < 80) {
      recommendations.push(
        'Compliance score below threshold - address non-compliant areas immediately'
      );
    }

    if (statistics.alertCount > 10) {
      recommendations.push(
        'High number of alerts - implement additional monitoring and response procedures'
      );
    }

    if (recommendations.length === 0) {
      recommendations.push(
        'Overall security posture appears healthy - maintain current practices'
      );
    }

    return recommendations;
  }

  /**
   * Generate compliance status for period
   */
  private async generateComplianceStatus(
    startDate: Date,
    endDate: Date
  ): Promise<Record<string, any>> {
    // This would analyze compliance during the specified period
    return {
      overallScore: await this.calculateComplianceScore(),
      frameworkScores: {
        SOC2: 85,
        GDPR: 92,
        HIPAA: 78,
        PCI_DSS: 88,
        ISO27001: 81,
      },
      period: {
        start: startDate,
        end: endDate,
      },
    };
  }

  /**
   * Calculate risk assessment
   */
  private calculateRiskAssessment(
    statistics: AuditStatistics,
    findings: Record<string, any>
  ): Record<string, any> {
    return {
      overallRisk:
        statistics.riskScore > 70
          ? 'HIGH'
          : statistics.riskScore > 40
            ? 'MEDIUM'
            : 'LOW',
      riskFactors: [
        ...(statistics.riskScore > 70 ? ['High risk score'] : []),
        ...(statistics.complianceScore < 80 ? ['Low compliance score'] : []),
        ...(statistics.alertCount > 10 ? ['High alert volume'] : []),
      ],
      mitigation:
        'Review security policies and implement additional controls as needed',
    };
  }

  /**
   * Create report summary
   */
  private createReportSummary(
    statistics: AuditStatistics,
    findings: Record<string, any>,
    recommendations: string[]
  ): Record<string, any> {
    return {
      totalEvents: statistics.totalEvents,
      riskScore: statistics.riskScore,
      complianceScore: statistics.complianceScore,
      criticalIssues: statistics.recentCriticalEvents.length,
      recommendationsCount: recommendations.length,
      overallStatus:
        statistics.riskScore < 50 && statistics.complianceScore > 80
          ? 'HEALTHY'
          : 'REQUIRES_ATTENTION',
    };
  }

  /**
   * Extract action items from recommendations
   */
  private extractActionItems(recommendations: string[]): Record<string, any>[] {
    return recommendations.map((rec, index) => ({
      id: index + 1,
      description: rec,
      priority:
        rec.includes('High') || rec.includes('critical') ? 'HIGH' : 'MEDIUM',
      status: 'PENDING',
    }));
  }

  /**
   * Get framework compliance status
   */
  private async getFrameworkStatus(): Promise<Record<string, any>> {
    // This would return detailed framework status
    return {
      SOC2: { status: 'COMPLIANT', lastAssessed: new Date() },
      GDPR: { status: 'COMPLIANT', lastAssessed: new Date() },
      HIPAA: { status: 'PARTIAL', lastAssessed: new Date() },
    };
  }

  /**
   * Get non-compliant areas
   */
  private async getNonCompliantAreas(): Promise<string[]> {
    // This would return areas needing attention
    return [
      'User access review procedures',
      'Data retention policy enforcement',
      'Incident response documentation',
    ];
  }

  /**
   * Get system health findings
   */
  private async getSystemHealthFindings(): Promise<Record<string, any>> {
    // This would analyze system health metrics
    return {
      uptime: '99.9%',
      responseTime: 'Normal',
      errorRate: 'Low',
      storageHealth: 'Good',
    };
  }

  /**
   * Get performance findings
   */
  private async getPerformanceFindings(): Promise<Record<string, any>> {
    // This would analyze performance metrics
    return {
      averageResponseTime: 250,
      throughput: 'High',
      resourceUtilization: 'Normal',
      bottlenecks: 'None identified',
    };
  }
}

export const auditService = new AuditService();
