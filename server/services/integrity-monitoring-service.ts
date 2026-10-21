/**
 * Integrity Monitoring Service
 * Handles automated integrity verification scheduling, health monitoring,
 * and alerting for the file integrity system
 */

import { eq, and, or, desc, asc, sql } from 'drizzle-orm';
import { db } from '../../database/db.js';
import * as cron from 'node-cron';
import { logger } from '../../utils/logger.js';
import fieldNameConverter from '../../utils/fieldNameConverter.js';
import { createRedisClient } from '../utils/create-redis.js';

import {
  files,
  fileIntegrityLogs,
  HashAlgorithm,
  IntegrityStatus,
  type File,
  type FileIntegrityLog,
} from '../../shared/file-schema.js';

import {
  fileIntegrityService,
  IntegrityMonitoringConfig,
} from './file-integrity-service.js';
import { enhancedFileStorageService } from './enhanced-file-storage.js';
import { storageHealthMonitor } from './storage-health-monitor.js';

// Redis client for monitoring state
const redis = createRedisClient({
  // Integrity alerts and monitoring state must not silently disappear.
  failureMode: 'fail-closed',
});

export interface IntegrityHealthStatus {
  isHealthy: boolean;
  totalFiles: number;
  verifiedFiles: number;
  corruptedFiles: number;
  pendingVerifications: number;
  lastCheckTime: Date;
  averageVerificationTime: number;
  failureRate: number;
  alerts: IntegrityAlert[];
  recommendations: string[];
}

export interface IntegrityAlert {
  id: string;
  type:
    | 'CORRUPTION_DETECTED'
    | 'HIGH_FAILURE_RATE'
    | 'VERIFICATION_TIMEOUT'
    | 'STORAGE_HEALTH_ISSUE';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  fileId?: string;
  message: string;
  createdAt: Date;
  acknowledged: boolean;
  metadata?: Record<string, any>;
}

export interface ScheduledVerification {
  id: string;
  fileId: string;
  userId: number;
  scheduledAt: Date;
  priority: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  algorithms: HashAlgorithm[];
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED';
  completedAt?: Date;
  error?: string;
}

export interface IntegrityReport {
  id: string;
  reportType: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'CUSTOM';
  generatedAt: Date;
  period: {
    start: Date;
    end: Date;
  };
  summary: {
    totalFiles: number;
    verificationsPerformed: number;
    corruptionEvents: number;
    healedFiles: number;
    avgVerificationTime: number;
  };
  details: {
    topCorruptionTypes: { type: string; count: number }[];
    storageProviderHealth: { provider: string; reliability: number }[];
    recommendedActions: string[];
  };
  alerts: IntegrityAlert[];
}

export class IntegrityMonitoringService {
  private scheduledTasks: Map<string, ReturnType<typeof cron.schedule>> = new Map();
  private verificationQueue: Map<string, ScheduledVerification> = new Map();
  private alerts: Map<string, IntegrityAlert> = new Map();
  private isInitialized: boolean = false;

  /**
   * Initialize the monitoring service
   */
  async initialize(): Promise<void> {
    try {
      logger.info(
        '[IntegrityMonitoring] Initializing integrity monitoring service'
      );

      // Load existing alerts and scheduled verifications
      await this.loadPersistedState();

      // Set up scheduled tasks
      await this.setupScheduledTasks();

      // Initialize health monitoring
      await this.initializeHealthMonitoring();

      this.isInitialized = true;
      logger.info(
        '[IntegrityMonitoring] Integrity monitoring service initialized successfully'
      );
    } catch (error) {
      logger.error(
        '[IntegrityMonitoring] Failed to initialize monitoring service',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }

  /**
   * Schedule integrity verification for a file
   */
  async scheduleVerification(
    fileId: string,
    userId: number,
    options: {
      priority?: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
      scheduledAt?: Date;
      algorithms?: HashAlgorithm[];
      recurring?: boolean;
      recurringInterval?: string; // Cron expression
    } = {}
  ): Promise<string> {
    try {
      const verificationId = `verify_${fileId}_${Date.now()}`;

      const verification: ScheduledVerification = {
        id: verificationId,
        fileId,
        userId,
        scheduledAt: options.scheduledAt || new Date(),
        priority: options.priority || 'MEDIUM',
        algorithms: options.algorithms || ['SHA256', 'BLAKE2B'],
        status: 'PENDING',
      };

      this.verificationQueue.set(verificationId, verification);

      // If scheduled for immediate execution
      if (verification.scheduledAt <= new Date()) {
        setImmediate(() => this.executeVerification(verificationId));
      } else {
        // Schedule for later execution
        const delay = verification.scheduledAt.getTime() - Date.now();
        setTimeout(() => this.executeVerification(verificationId), delay);
      }

      // Set up recurring verification if requested
      if (options.recurring && options.recurringInterval) {
        const taskId = `recurring_${fileId}`;
        const task = cron.schedule(
          options.recurringInterval,
          async () => {
            await this.scheduleVerification(fileId, userId, {
              ...options,
              scheduledAt: new Date(),
              recurring: false, // Prevent infinite recursion
            });
          },
          { scheduled: false }
        );

        this.scheduledTasks.set(taskId, task);
        task.start();

        logger.info('[IntegrityMonitoring] Recurring verification scheduled', {
          fileId,
          interval: options.recurringInterval,
          taskId,
        });
      }

      // Persist to Redis
      await this.persistVerificationSchedule(verification);

      logger.info('[IntegrityMonitoring] Verification scheduled successfully', {
        verificationId,
        fileId,
        scheduledAt: verification.scheduledAt,
        priority: verification.priority,
      });

      return verificationId;
    } catch (error) {
      logger.error('[IntegrityMonitoring] Error scheduling verification', {
        fileId,
        userId,
        options,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get integrity health status
   */
  async getHealthStatus(): Promise<IntegrityHealthStatus> {
    try {
      const now = new Date();
      const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

      // Get file counts
      const [fileCounts] = await db
        .select({
          total: sql`count(*) filter (where ${files.status} = 'ACTIVE')`,
          verified: sql`count(*) filter (where ${files.status} = 'ACTIVE' AND ${files.lastIntegrityCheck} IS NOT NULL)`,
          pending: sql`count(*) filter (where ${files.status} = 'ACTIVE' AND (${files.lastIntegrityCheck} IS NULL OR ${files.lastIntegrityCheck} < ${oneDayAgo}))`,
        })
        .from(files);

      // Get corruption count from recent logs
      const [corruptionCount] = await db
        .select({ count: sql`count(*)` })
        .from(fileIntegrityLogs)
        .where(
          and(
            eq(fileIntegrityLogs.status, 'CORRUPTED'),
            sql`${fileIntegrityLogs.verifiedAt} >= ${oneDayAgo}`
          )
        );

      // Get recent verification statistics
      const [verificationStats] = await db
        .select({
          avgTime: sql`avg(${fileIntegrityLogs.verificationTime})`,
          totalVerifications: sql`count(*)`,
          failedVerifications: sql`count(*) filter (where ${fileIntegrityLogs.status} = 'VERIFICATION_FAILED')`,
        })
        .from(fileIntegrityLogs)
        .where(sql`${fileIntegrityLogs.verifiedAt} >= ${oneDayAgo}`);

      const totalFiles = Number(fileCounts.total);
      const verifiedFiles = Number(fileCounts.verified);
      const corruptedFiles = Number(corruptionCount.count);
      const pendingVerifications = Number(fileCounts.pending);
      const totalVerifications = Number(verificationStats.totalVerifications);
      const failedVerifications = Number(verificationStats.failedVerifications);

      const failureRate =
        totalVerifications > 0 ? failedVerifications / totalVerifications : 0;
      const averageVerificationTime = Number(verificationStats.avgTime) || 0;

      // Get active alerts
      const activeAlerts = Array.from(this.alerts.values()).filter(
        alert => !alert.acknowledged
      );

      // Generate recommendations
      const recommendations = this.generateHealthRecommendations({
        totalFiles,
        verifiedFiles,
        corruptedFiles,
        pendingVerifications,
        failureRate,
        activeAlerts,
      });

      const isHealthy =
        failureRate < 0.05 && // Less than 5% failure rate
        corruptedFiles === 0 && // No corrupted files
        activeAlerts.filter(a => a.severity === 'CRITICAL').length === 0; // No critical alerts

      return {
        isHealthy,
        totalFiles,
        verifiedFiles,
        corruptedFiles,
        pendingVerifications,
        lastCheckTime: now,
        averageVerificationTime,
        failureRate,
        alerts: activeAlerts,
        recommendations,
      };
    } catch (error) {
      logger.error('[IntegrityMonitoring] Error getting health status', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Create integrity alert
   */
  async createAlert(
    type: IntegrityAlert['type'],
    severity: IntegrityAlert['severity'],
    message: string,
    fileId?: string,
    metadata?: Record<string, any>
  ): Promise<string> {
    try {
      const alertId = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      const alert: IntegrityAlert = {
        id: alertId,
        type,
        severity,
        fileId,
        message,
        createdAt: new Date(),
        acknowledged: false,
        metadata,
      };

      this.alerts.set(alertId, alert);

      // Persist to Redis
      await redis.setex(
        `integrity_alert:${alertId}`,
        86400, // 24 hours
        JSON.stringify(alert)
      );

      // Log alert
      logger.warn('[IntegrityMonitoring] Integrity alert created', {
        alertId,
        type,
        severity,
        message,
        fileId,
        metadata,
      });

      // Trigger notification for critical alerts
      if (severity === 'CRITICAL') {
        await this.handleCriticalAlert(alert);
      }

      return alertId;
    } catch (error) {
      logger.error('[IntegrityMonitoring] Error creating alert', {
        type,
        severity,
        message,
        fileId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Acknowledge alert
   */
  async acknowledgeAlert(alertId: string, userId: number): Promise<boolean> {
    try {
      const alert = this.alerts.get(alertId);
      if (!alert) {
        return false;
      }

      alert.acknowledged = true;
      alert.metadata = {
        ...alert.metadata,
        acknowledgedBy: userId,
        acknowledgedAt: new Date(),
      };

      this.alerts.set(alertId, alert);

      // Update in Redis
      await redis.setex(
        `integrity_alert:${alertId}`,
        86400,
        JSON.stringify(alert)
      );

      logger.info('[IntegrityMonitoring] Alert acknowledged', {
        alertId,
        userId,
      });

      return true;
    } catch (error) {
      logger.error('[IntegrityMonitoring] Error acknowledging alert', {
        alertId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Generate integrity report
   */
  async generateReport(
    reportType: IntegrityReport['reportType'] = 'DAILY',
    customPeriod?: { start: Date; end: Date }
  ): Promise<IntegrityReport> {
    try {
      const reportId = `report_${reportType.toLowerCase()}_${Date.now()}`;
      const now = new Date();

      let period: { start: Date; end: Date };

      if (customPeriod) {
        period = customPeriod;
      } else {
        switch (reportType) {
          case 'DAILY':
            period = {
              start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
              end: now,
            };
            break;
          case 'WEEKLY':
            period = {
              start: new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
              end: now,
            };
            break;
          case 'MONTHLY':
            period = {
              start: new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
              end: now,
            };
            break;
          default:
            period = {
              start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
              end: now,
            };
        }
      }

      logger.info('[IntegrityMonitoring] Generating integrity report', {
        reportId,
        reportType,
        period,
      });

      // Get verification statistics for the period
      const [verificationStats] = await db
        .select({
          totalFiles: sql`count(distinct ${fileIntegrityLogs.fileId})`,
          verificationsPerformed: sql`count(*)`,
          corruptionEvents: sql`count(*) filter (where ${fileIntegrityLogs.status} = 'CORRUPTED')`,
          avgTime: sql`avg(${fileIntegrityLogs.verificationTime})`,
        })
        .from(fileIntegrityLogs)
        .where(
          and(
            sql`${fileIntegrityLogs.verifiedAt} >= ${period.start}`,
            sql`${fileIntegrityLogs.verifiedAt} <= ${period.end}`
          )
        );

      // Get corruption types breakdown
      const corruptionTypes = await db
        .select({
          type: fileIntegrityLogs.corruptionType,
          count: sql`count(*)`,
        })
        .from(fileIntegrityLogs)
        .where(
          and(
            eq(fileIntegrityLogs.status, 'CORRUPTED'),
            sql`${fileIntegrityLogs.verifiedAt} >= ${period.start}`,
            sql`${fileIntegrityLogs.verifiedAt} <= ${period.end}`
          )
        )
        .groupBy(fileIntegrityLogs.corruptionType);

      // Generate storage provider health information
      const storageProviderHealth = await this.getStorageProviderHealthReport();

      // Get alerts from the period
      const periodAlerts = Array.from(this.alerts.values()).filter(
        alert =>
          alert.createdAt >= period.start && alert.createdAt <= period.end
      );

      const report: IntegrityReport = {
        id: reportId,
        reportType,
        generatedAt: now,
        period,
        summary: {
          totalFiles: Number(verificationStats.totalFiles),
          verificationsPerformed: Number(
            verificationStats.verificationsPerformed
          ),
          corruptionEvents: Number(verificationStats.corruptionEvents),
          healedFiles: 0, // Would be calculated from recovery operations
          avgVerificationTime: Number(verificationStats.avgTime) || 0,
        },
        details: {
          topCorruptionTypes: corruptionTypes.map(ct => ({
            type: ct.type || 'UNKNOWN',
            count: Number(ct.count),
          })),
          storageProviderHealth,
          recommendedActions: this.generateReportRecommendations(
            verificationStats,
            corruptionTypes
          ),
        },
        alerts: periodAlerts,
      };

      // Cache the report
      await redis.setex(
        `integrity_report:${reportId}`,
        86400 * 7, // Keep for 7 days
        JSON.stringify(report)
      );

      logger.info(
        '[IntegrityMonitoring] Integrity report generated successfully',
        {
          reportId,
          reportType,
          summary: report.summary,
        }
      );

      return report;
    } catch (error) {
      logger.error('[IntegrityMonitoring] Error generating report', {
        reportType,
        customPeriod,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get scheduled verifications
   */
  getScheduledVerifications(): ScheduledVerification[] {
    return Array.from(this.verificationQueue.values());
  }

  /**
   * Cancel scheduled verification
   */
  async cancelVerification(verificationId: string): Promise<boolean> {
    try {
      const verification = this.verificationQueue.get(verificationId);
      if (!verification || verification.status !== 'PENDING') {
        return false;
      }

      this.verificationQueue.delete(verificationId);

      // Remove from Redis
      await redis.del(`verification:${verificationId}`);

      logger.info('[IntegrityMonitoring] Verification cancelled', {
        verificationId,
      });

      return true;
    } catch (error) {
      logger.error('[IntegrityMonitoring] Error cancelling verification', {
        verificationId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Execute scheduled verification
   */
  private async executeVerification(verificationId: string): Promise<void> {
    try {
      const verification = this.verificationQueue.get(verificationId);
      if (!verification || verification.status !== 'PENDING') {
        return;
      }

      verification.status = 'IN_PROGRESS';
      this.verificationQueue.set(verificationId, verification);

      logger.info('[IntegrityMonitoring] Executing scheduled verification', {
        verificationId,
        fileId: verification.fileId,
      });

      const result = await fileIntegrityService.verifyFileIntegrity({
        fileId: verification.fileId,
        userId: verification.userId,
        algorithms: verification.algorithms,
        forceRecompute: true,
      });

      verification.status = 'COMPLETED';
      verification.completedAt = new Date();

      // Create alerts for issues
      if (result.status === 'CORRUPTED') {
        await this.createAlert(
          'CORRUPTION_DETECTED',
          'HIGH',
          `File corruption detected during scheduled verification: ${verification.fileId}`,
          verification.fileId,
          { verificationResult: result }
        );
      } else if (result.status === 'VERIFICATION_FAILED') {
        await this.createAlert(
          'VERIFICATION_TIMEOUT',
          'MEDIUM',
          `Verification failed for file: ${verification.fileId}`,
          verification.fileId,
          { verificationResult: result }
        );
      }

      this.verificationQueue.set(verificationId, verification);

      logger.info('[IntegrityMonitoring] Scheduled verification completed', {
        verificationId,
        fileId: verification.fileId,
        status: result.status,
      });
    } catch (error) {
      const verification = this.verificationQueue.get(verificationId);
      if (verification) {
        verification.status = 'FAILED';
        verification.error =
          error instanceof Error ? error.message : String(error);
        verification.completedAt = new Date();
        this.verificationQueue.set(verificationId, verification);
      }

      logger.error('[IntegrityMonitoring] Scheduled verification failed', {
        verificationId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Setup scheduled tasks
   */
  private async setupScheduledTasks(): Promise<void> {
    // Daily health check
    const dailyHealthCheck = cron.schedule('0 2 * * *', async () => {
      try {
        const healthStatus = await this.getHealthStatus();
        if (!healthStatus.isHealthy) {
          await this.createAlert(
            'STORAGE_HEALTH_ISSUE',
            'MEDIUM',
            'Daily health check revealed integrity issues',
            undefined,
            { healthStatus }
          );
        }
      } catch (error) {
        logger.error('[IntegrityMonitoring] Daily health check failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Weekly report generation
    const weeklyReport = cron.schedule('0 6 * * 0', async () => {
      try {
        await this.generateReport('WEEKLY');
      } catch (error) {
        logger.error('[IntegrityMonitoring] Weekly report generation failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    this.scheduledTasks.set('daily_health_check', dailyHealthCheck);
    this.scheduledTasks.set('weekly_report', weeklyReport);

    dailyHealthCheck.start();
    weeklyReport.start();

    logger.info('[IntegrityMonitoring] Scheduled tasks set up successfully');
  }

  /**
   * Initialize health monitoring
   */
  private async initializeHealthMonitoring(): Promise<void> {
    // Set up continuous monitoring for storage health
    setInterval(
      async () => {
        try {
          await this.monitorStorageHealth();
        } catch (error) {
          logger.error(
            '[IntegrityMonitoring] Storage health monitoring failed',
            {
              error: error instanceof Error ? error.message : String(error),
            }
          );
        }
      },
      5 * 60 * 1000
    ); // Every 5 minutes
  }

  /**
   * Monitor storage health
   */
  private async monitorStorageHealth(): Promise<void> {
    try {
      const healthStatuses = await storageHealthMonitor.getAllNetworkHealth();

      for (const status of healthStatuses) {
        if (!status.isHealthy || status.reliability < 0.95) {
          await this.createAlert(
            'STORAGE_HEALTH_ISSUE',
            status.reliability < 0.9 ? 'HIGH' : 'MEDIUM',
            `Storage provider ${status.networkName} showing degraded performance`,
            undefined,
            { healthStatus: status }
          );
        }
      }
    } catch (error) {
      logger.warn(
        '[IntegrityMonitoring] Storage health monitoring check failed',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  /**
   * Handle critical alert
   */
  private async handleCriticalAlert(alert: IntegrityAlert): Promise<void> {
    // This would typically integrate with external alerting systems
    // For now, we'll just log it with high visibility
    logger.error('[CRITICAL INTEGRITY ALERT]', {
      alertId: alert.id,
      type: alert.type,
      message: alert.message,
      fileId: alert.fileId,
      metadata: alert.metadata,
    });

    // Here you would typically:
    // - Send notifications to administrators
    // - Trigger automated recovery procedures
    // - Escalate to incident management systems
  }

  /**
   * Generate health recommendations
   */
  private generateHealthRecommendations(stats: {
    totalFiles: number;
    verifiedFiles: number;
    corruptedFiles: number;
    pendingVerifications: number;
    failureRate: number;
    activeAlerts: IntegrityAlert[];
  }): string[] {
    const recommendations: string[] = [];

    if (stats.failureRate > 0.05) {
      recommendations.push(
        'High verification failure rate detected - investigate storage network connectivity'
      );
    }

    if (stats.corruptedFiles > 0) {
      recommendations.push(
        `${stats.corruptedFiles} corrupted files detected - initiate recovery procedures`
      );
    }

    if (stats.pendingVerifications > stats.totalFiles * 0.1) {
      recommendations.push(
        'Large number of pending verifications - consider increasing monitoring resources'
      );
    }

    const criticalAlerts = stats.activeAlerts.filter(
      a => a.severity === 'CRITICAL'
    ).length;
    if (criticalAlerts > 0) {
      recommendations.push(
        `${criticalAlerts} critical alerts require immediate attention`
      );
    }

    if (recommendations.length === 0) {
      recommendations.push(
        'System integrity appears healthy - continue regular monitoring'
      );
    }

    return recommendations;
  }

  /**
   * Generate report recommendations
   */
  private generateReportRecommendations(
    stats: any,
    corruptionTypes: any[]
  ): string[] {
    const recommendations: string[] = [];

    if (Number(stats.corruptionEvents) > 0) {
      recommendations.push('Investigate root causes of file corruption events');

      const topCorruption = corruptionTypes[0];
      if (topCorruption) {
        recommendations.push(
          `Focus on ${topCorruption.type} corruption type which accounts for most issues`
        );
      }
    }

    if (Number(stats.avgTime) > 5000) {
      // More than 5 seconds
      recommendations.push(
        'Verification times are high - consider optimizing hash algorithms or storage access'
      );
    }

    return recommendations;
  }

  /**
   * Get storage provider health report
   */
  private async getStorageProviderHealthReport(): Promise<
    { provider: string; reliability: number }[]
  > {
    try {
      const healthStatuses = await storageHealthMonitor.getAllNetworkHealth();
      return healthStatuses.map(status => ({
        provider: status.networkName,
        reliability: status.reliability,
      }));
    } catch (error) {
      logger.warn(
        '[IntegrityMonitoring] Error getting storage provider health',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      return [];
    }
  }

  /**
   * Load persisted state from Redis
   */
  private async loadPersistedState(): Promise<void> {
    try {
      // Load alerts
      const alertKeys = await redis.keys('integrity_alert:*');
      for (const key of alertKeys) {
        const alertData = await redis.get(key);
        if (alertData) {
          const alert = JSON.parse(alertData);
          this.alerts.set(alert.id, alert);
        }
      }

      // Load scheduled verifications
      const verificationKeys = await redis.keys('verification:*');
      for (const key of verificationKeys) {
        const verificationData = await redis.get(key);
        if (verificationData) {
          const verification = JSON.parse(verificationData);
          this.verificationQueue.set(verification.id, verification);
        }
      }

      logger.info('[IntegrityMonitoring] Persisted state loaded', {
        alertsLoaded: this.alerts.size,
        verificationsLoaded: this.verificationQueue.size,
      });
    } catch (error) {
      logger.warn('[IntegrityMonitoring] Error loading persisted state', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Persist verification schedule to Redis
   */
  private async persistVerificationSchedule(
    verification: ScheduledVerification
  ): Promise<void> {
    try {
      await redis.setex(
        `verification:${verification.id}`,
        86400, // 24 hours
        JSON.stringify(verification)
      );
    } catch (error) {
      logger.warn(
        '[IntegrityMonitoring] Error persisting verification schedule',
        {
          verificationId: verification.id,
          error: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  /**
   * Shutdown the monitoring service
   */
  async shutdown(): Promise<void> {
    logger.info(
      '[IntegrityMonitoring] Shutting down integrity monitoring service'
    );

    // Stop all scheduled tasks
    for (const [taskId, task] of this.scheduledTasks) {
      task.stop();
      logger.debug('[IntegrityMonitoring] Stopped scheduled task', { taskId });
    }
    this.scheduledTasks.clear();

    // Clear intervals and timeouts would be handled here

    this.isInitialized = false;
    logger.info(
      '[IntegrityMonitoring] Integrity monitoring service shut down successfully'
    );
  }
}

export const integrityMonitoringService = new IntegrityMonitoringService();
