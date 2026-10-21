/**
 * Audit Monitoring Service
 * Provides real-time audit monitoring, alerting, and automated response capabilities
 */

import { eq, and, or, desc, asc, sql, count, gte, lte } from 'drizzle-orm';
import { db } from '../../database/db.js';
import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';
import fieldNameConverter from '../../utils/fieldNameConverter.js';
import { createRedisClient } from '../utils/create-redis.js';

import {
  securityAuditEvents,
  systemActivityLogs,
  auditReports,
  type SecurityAuditEvent,
  type SystemActivityLog,
} from '../../shared/file-schema.js';

import { auditService } from './audit-service.js';

// Redis client for monitoring and alerting
const redis = createRedisClient({
  // Security monitoring and automated responses must refuse on store outage.
  failureMode: 'fail-closed',
});

// Monitoring configuration
interface MonitoringConfig {
  enabled: boolean;
  checkInterval: number; // minutes
  alertThresholds: {
    criticalEventsPerHour: number;
    failedLoginsPerHour: number;
    riskScoreThreshold: number;
    systemErrorRate: number;
    complianceScore: number;
  };
  alertChannels: {
    email: boolean;
    webhook: boolean;
    slack: boolean;
    sms: boolean;
  };
  automatedResponses: {
    blockSuspiciousIPs: boolean;
    disableCompromisedAccounts: boolean;
    quarantineFiles: boolean;
    escalateToAdmin: boolean;
  };
  retentionPolicies: {
    auditLogs: number; // days
    reports: number; // days
    alerts: number; // days
  };
}

interface Alert {
  id: string;
  type: 'SECURITY' | 'COMPLIANCE' | 'SYSTEM' | 'PERFORMANCE';
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  description: string;
  triggeredBy: string;
  triggeredAt: Date;
  acknowledged: boolean;
  acknowledgedBy?: number;
  acknowledgedAt?: Date;
  resolved: boolean;
  resolvedBy?: number;
  resolvedAt?: Date;
  metadata: Record<string, any>;
  actions: AlertAction[];
}

interface AlertAction {
  id: string;
  type:
    | 'BLOCK_IP'
    | 'DISABLE_USER'
    | 'QUARANTINE_FILE'
    | 'NOTIFY_ADMIN'
    | 'ESCALATE';
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  executedAt?: Date;
  result?: string;
  metadata?: Record<string, any>;
}

interface MonitoringRule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  eventType: string;
  conditions: Record<string, any>;
  alertSeverity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  actions: string[];
  cooldownPeriod: number; // minutes
  lastTriggered?: Date;
}

interface MonitoringMetrics {
  eventsPerHour: number;
  criticalEventsPerHour: number;
  failedLoginsPerHour: number;
  averageRiskScore: number;
  systemErrorRate: number;
  complianceScore: number;
  activeAlerts: number;
  resolvedAlerts: number;
  topRiskUsers: Array<{ userId: number; riskScore: number }>;
  topRiskFiles: Array<{ fileId: string; riskScore: number }>;
  systemHealth: {
    overall: 'HEALTHY' | 'WARNING' | 'CRITICAL';
    components: Record<string, 'HEALTHY' | 'WARNING' | 'CRITICAL'>;
  };
}

export class AuditMonitoringService {
  private config: MonitoringConfig;
  private monitoringInterval?: ReturnType<typeof setInterval>;
  private isMonitoring: boolean = false;
  private activeAlerts: Map<string, Alert> = new Map();
  private monitoringRules: Map<string, MonitoringRule> = new Map();
  private alertSubscribers: Set<(alert: Alert) => void> = new Set();

  constructor() {
    this.config = {
      enabled: process.env.AUDIT_MONITORING_ENABLED === 'true',
      checkInterval: parseInt(process.env.AUDIT_MONITORING_INTERVAL || '5'), // 5 minutes default
      alertThresholds: {
        criticalEventsPerHour: parseInt(
          process.env.CRITICAL_EVENTS_THRESHOLD || '10'
        ),
        failedLoginsPerHour: parseInt(
          process.env.FAILED_LOGINS_THRESHOLD || '20'
        ),
        riskScoreThreshold: parseInt(process.env.RISK_SCORE_THRESHOLD || '70'),
        systemErrorRate: parseFloat(
          process.env.SYSTEM_ERROR_RATE_THRESHOLD || '0.05'
        ), // 5%
        complianceScore: parseInt(
          process.env.COMPLIANCE_SCORE_THRESHOLD || '80'
        ),
      },
      alertChannels: {
        email: process.env.ALERT_EMAIL_ENABLED === 'true',
        webhook: process.env.ALERT_WEBHOOK_ENABLED === 'true',
        slack: process.env.ALERT_SLACK_ENABLED === 'true',
        sms: process.env.ALERT_SMS_ENABLED === 'true',
      },
      automatedResponses: {
        blockSuspiciousIPs: process.env.AUTO_BLOCK_IPS === 'true',
        disableCompromisedAccounts:
          process.env.AUTO_DISABLE_ACCOUNTS === 'true',
        quarantineFiles: process.env.AUTO_QUARANTINE_FILES === 'true',
        escalateToAdmin: process.env.AUTO_ESCALATE === 'true',
      },
      retentionPolicies: {
        auditLogs: parseInt(process.env.AUDIT_LOG_RETENTION_DAYS || '365'),
        reports: parseInt(process.env.AUDIT_REPORT_RETENTION_DAYS || '90'),
        alerts: parseInt(process.env.ALERT_RETENTION_DAYS || '30'),
      },
    };

    this.initializeDefaultRules();
  }

  /**
   * Initialize the monitoring service
   */
  async initialize(): Promise<void> {
    try {
      logger.info('[AuditMonitoring] Initializing audit monitoring service');

      // Test Redis connection
      await redis.ping();

      // Load existing alerts from Redis
      await this.loadActiveAlerts();

      // Start monitoring if enabled
      if (this.config.enabled) {
        await this.startMonitoring();
      }

      // Subscribe to audit events from the audit service
      auditService.subscribeToAlerts(event => {
        this.processAuditEvent(event);
      });

      logger.info(
        '[AuditMonitoring] Audit monitoring service initialized successfully'
      );
    } catch (error) {
      logger.error(
        '[AuditMonitoring] Failed to initialize monitoring service',
        {
          error: error instanceof Error ? error.message : String(error),
        }
      );
      throw error;
    }
  }

  /**
   * Start real-time monitoring
   */
  async startMonitoring(): Promise<void> {
    if (this.isMonitoring) {
      logger.warn('[AuditMonitoring] Monitoring is already running');
      return;
    }

    try {
      logger.info('[AuditMonitoring] Starting real-time audit monitoring', {
        checkInterval: this.config.checkInterval,
        alertThresholds: this.config.alertThresholds,
      });

      this.isMonitoring = true;

      // Set up periodic monitoring checks
      this.monitoringInterval = setInterval(
        async () => {
          try {
            await this.performMonitoringChecks();
          } catch (error) {
            logger.error('[AuditMonitoring] Error in monitoring check', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
        this.config.checkInterval * 60 * 1000
      ); // Convert minutes to milliseconds

      // Perform initial check
      await this.performMonitoringChecks();

      logger.info(
        '[AuditMonitoring] Real-time audit monitoring started successfully'
      );
    } catch (error) {
      this.isMonitoring = false;
      logger.error('[AuditMonitoring] Failed to start monitoring', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Stop monitoring
   */
  stopMonitoring(): void {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = undefined;
    }
    this.isMonitoring = false;
    logger.info('[AuditMonitoring] Audit monitoring stopped');
  }

  /**
   * Get current monitoring metrics
   */
  async getMonitoringMetrics(): Promise<MonitoringMetrics> {
    try {
      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      // Get events from the last hour
      const [hourlyStats] = await db
        .select({
          totalEvents: count(),
          criticalEvents: sql`count(*) filter (where ${securityAuditEvents.severity} = 'CRITICAL')`,
          failedLogins: sql`count(*) filter (where ${securityAuditEvents.eventType} = 'AUTHENTICATION' AND ${securityAuditEvents.result} = 'FAILURE')`,
          avgRiskScore: sql`avg(${securityAuditEvents.riskScore})`,
        })
        .from(securityAuditEvents)
        .where(gte(securityAuditEvents.eventTime, oneHourAgo));

      // Get system error rate
      const [systemStats] = await db
        .select({
          totalActivities: count(),
          errorActivities: sql`count(*) filter (where ${systemActivityLogs.status} = 'FAILURE')`,
        })
        .from(systemActivityLogs)
        .where(gte(systemActivityLogs.startTime, oneHourAgo));

      const systemErrorRate =
        systemStats.totalActivities > 0
          ? Number(systemStats.errorActivities) / systemStats.totalActivities
          : 0;

      // Get compliance score
      const statistics = await auditService.getAuditStatistics({
        start: oneHourAgo,
        end: now,
      });

      // Get top risk users and files
      const topRiskUsers = await this.getTopRiskUsers();
      const topRiskFiles = await this.getTopRiskFiles();

      // Assess system health
      const systemHealth = this.assessSystemHealth(
        Number(hourlyStats.criticalEvents),
        systemErrorRate,
        statistics.complianceScore
      );

      const metrics: MonitoringMetrics = {
        eventsPerHour: hourlyStats.totalEvents,
        criticalEventsPerHour: Number(hourlyStats.criticalEvents),
        failedLoginsPerHour: Number(hourlyStats.failedLogins),
        averageRiskScore: Number(hourlyStats.avgRiskScore) || 0,
        systemErrorRate,
        complianceScore: statistics.complianceScore,
        activeAlerts: this.activeAlerts.size,
        resolvedAlerts: await this.getResolvedAlertsCount(),
        topRiskUsers,
        topRiskFiles,
        systemHealth,
      };

      logger.debug('[AuditMonitoring] Monitoring metrics calculated', {
        eventsPerHour: metrics.eventsPerHour,
        criticalEventsPerHour: metrics.criticalEventsPerHour,
        systemHealth: metrics.systemHealth.overall,
      });

      return metrics;
    } catch (error) {
      logger.error('[AuditMonitoring] Error getting monitoring metrics', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Create a monitoring rule
   */
  async createMonitoringRule(
    rule: Omit<MonitoringRule, 'id'>
  ): Promise<string> {
    try {
      const ruleId = crypto.randomUUID();
      const monitoringRule: MonitoringRule = {
        id: ruleId,
        ...rule,
      };

      this.monitoringRules.set(ruleId, monitoringRule);

      // Persist rule to Redis
      await redis.hset(
        'monitoring_rules',
        ruleId,
        JSON.stringify(monitoringRule)
      );

      logger.info('[AuditMonitoring] Monitoring rule created', {
        ruleId,
        name: rule.name,
        eventType: rule.eventType,
        alertSeverity: rule.alertSeverity,
      });

      return ruleId;
    } catch (error) {
      logger.error('[AuditMonitoring] Error creating monitoring rule', {
        rule,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  /**
   * Get all active alerts
   */
  getActiveAlerts(): Alert[] {
    return Array.from(this.activeAlerts.values()).filter(
      alert => !alert.resolved
    );
  }

  /**
   * Get all resolved alerts
   */
  async getResolvedAlerts(limit: number = 50): Promise<Alert[]> {
    try {
      const keys = await redis.keys('resolved_alert:*');
      const resolvedAlerts: Alert[] = [];

      for (const key of keys.slice(0, limit)) {
        const alertData = await redis.get(key);
        if (alertData) {
          resolvedAlerts.push(JSON.parse(alertData));
        }
      }

      return resolvedAlerts.sort(
        (a, b) => b.resolvedAt!.getTime() - a.resolvedAt!.getTime()
      );
    } catch (error) {
      logger.error('[AuditMonitoring] Error getting resolved alerts', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Acknowledge an alert
   */
  async acknowledgeAlert(alertId: string, userId: number): Promise<boolean> {
    try {
      const alert = this.activeAlerts.get(alertId);
      if (!alert) {
        return false;
      }

      alert.acknowledged = true;
      alert.acknowledgedBy = userId;
      alert.acknowledgedAt = new Date();

      // Update in Redis
      await redis.setex(
        `alert:${alertId}`,
        86400 * this.config.retentionPolicies.alerts,
        JSON.stringify(alert)
      );

      logger.info('[AuditMonitoring] Alert acknowledged', {
        alertId,
        acknowledgedBy: userId,
        alertType: alert.type,
        severity: alert.severity,
      });

      return true;
    } catch (error) {
      logger.error('[AuditMonitoring] Error acknowledging alert', {
        alertId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Resolve an alert
   */
  async resolveAlert(
    alertId: string,
    userId: number,
    resolution?: string
  ): Promise<boolean> {
    try {
      const alert = this.activeAlerts.get(alertId);
      if (!alert) {
        return false;
      }

      alert.resolved = true;
      alert.resolvedBy = userId;
      alert.resolvedAt = new Date();

      if (resolution) {
        alert.metadata.resolution = resolution;
      }

      // Move to resolved alerts
      await redis.setex(
        `resolved_alert:${alertId}`,
        86400 * this.config.retentionPolicies.alerts,
        JSON.stringify(alert)
      );

      // Remove from active alerts
      this.activeAlerts.delete(alertId);
      await redis.del(`alert:${alertId}`);

      logger.info('[AuditMonitoring] Alert resolved', {
        alertId,
        resolvedBy: userId,
        alertType: alert.type,
        severity: alert.severity,
        resolution,
      });

      return true;
    } catch (error) {
      logger.error('[AuditMonitoring] Error resolving alert', {
        alertId,
        userId,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Subscribe to alert notifications
   */
  subscribeToAlerts(callback: (alert: Alert) => void): () => void {
    this.alertSubscribers.add(callback);

    return () => {
      this.alertSubscribers.delete(callback);
    };
  }

  /**
   * Update monitoring configuration
   */
  updateConfiguration(newConfig: Partial<MonitoringConfig>): void {
    this.config = { ...this.config, ...newConfig };

    if (this.isMonitoring && newConfig.checkInterval) {
      this.stopMonitoring();
      if (this.config.enabled) {
        this.startMonitoring();
      }
    }

    logger.info('[AuditMonitoring] Configuration updated', {
      config: this.config,
    });
  }

  /**
   * Get monitoring status
   */
  getMonitoringStatus(): {
    isRunning: boolean;
    config: MonitoringConfig;
    activeAlertsCount: number;
    monitoringRulesCount: number;
    lastCheck?: Date;
  } {
    return {
      isRunning: this.isMonitoring,
      config: this.config,
      activeAlertsCount: this.activeAlerts.size,
      monitoringRulesCount: this.monitoringRules.size,
      lastCheck: new Date(), // Would track actual last check time
    };
  }

  /**
   * Perform monitoring checks
   */
  private async performMonitoringChecks(): Promise<void> {
    try {
      logger.debug('[AuditMonitoring] Performing monitoring checks');

      const metrics = await this.getMonitoringMetrics();

      // Check alert thresholds
      await this.checkAlertThresholds(metrics);

      // Process monitoring rules
      await this.processMonitoringRules();

      // Clean up expired alerts
      await this.cleanupExpiredAlerts();

      // Update system health
      await this.updateSystemHealth(metrics);

      logger.debug('[AuditMonitoring] Monitoring checks completed', {
        activeAlerts: metrics.activeAlerts,
        systemHealth: metrics.systemHealth.overall,
      });
    } catch (error) {
      logger.error('[AuditMonitoring] Error in monitoring checks', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check alert thresholds
   */
  private async checkAlertThresholds(
    metrics: MonitoringMetrics
  ): Promise<void> {
    // Check critical events threshold
    if (
      metrics.criticalEventsPerHour >=
      this.config.alertThresholds.criticalEventsPerHour
    ) {
      await this.createAlert({
        type: 'SECURITY',
        severity: 'HIGH',
        title: 'High Critical Events Volume',
        description: `Critical events per hour (${metrics.criticalEventsPerHour}) exceeds threshold (${this.config.alertThresholds.criticalEventsPerHour})`,
        triggeredBy: 'threshold_monitor',
        metadata: {
          threshold: this.config.alertThresholds.criticalEventsPerHour,
          actual: metrics.criticalEventsPerHour,
        },
      });
    }

    // Check failed logins threshold
    if (
      metrics.failedLoginsPerHour >=
      this.config.alertThresholds.failedLoginsPerHour
    ) {
      await this.createAlert({
        type: 'SECURITY',
        severity: 'MEDIUM',
        title: 'High Failed Login Attempts',
        description: `Failed logins per hour (${metrics.failedLoginsPerHour}) exceeds threshold (${this.config.alertThresholds.failedLoginsPerHour})`,
        triggeredBy: 'threshold_monitor',
        metadata: {
          threshold: this.config.alertThresholds.failedLoginsPerHour,
          actual: metrics.failedLoginsPerHour,
        },
      });
    }

    // Check compliance score
    if (metrics.complianceScore < this.config.alertThresholds.complianceScore) {
      await this.createAlert({
        type: 'COMPLIANCE',
        severity: 'HIGH',
        title: 'Low Compliance Score',
        description: `Compliance score (${metrics.complianceScore}%) is below threshold (${this.config.alertThresholds.complianceScore}%)`,
        triggeredBy: 'threshold_monitor',
        metadata: {
          threshold: this.config.alertThresholds.complianceScore,
          actual: metrics.complianceScore,
        },
      });
    }

    // Check system error rate
    if (metrics.systemErrorRate > this.config.alertThresholds.systemErrorRate) {
      await this.createAlert({
        type: 'SYSTEM',
        severity: 'HIGH',
        title: 'High System Error Rate',
        description: `System error rate (${(metrics.systemErrorRate * 100).toFixed(2)}%) exceeds threshold (${(this.config.alertThresholds.systemErrorRate * 100).toFixed(2)}%)`,
        triggeredBy: 'threshold_monitor',
        metadata: {
          threshold: this.config.alertThresholds.systemErrorRate,
          actual: metrics.systemErrorRate,
        },
      });
    }
  }

  /**
   * Process audit event for real-time monitoring
   */
  private async processAuditEvent(event: SecurityAuditEvent): Promise<void> {
    try {
      // Check if event matches any monitoring rules
      for (const rule of this.monitoringRules.values()) {
        if (!rule.enabled) continue;

        if (await this.eventMatchesRule(event, rule)) {
          // Check cooldown period
          if (rule.lastTriggered) {
            const cooldownEnd = new Date(
              rule.lastTriggered.getTime() + rule.cooldownPeriod * 60 * 1000
            );
            if (new Date() < cooldownEnd) {
              continue; // Still in cooldown
            }
          }

          await this.triggerRuleAlert(event, rule);
          rule.lastTriggered = new Date();
        }
      }
    } catch (error) {
      logger.error('[AuditMonitoring] Error processing audit event', {
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Create an alert
   */
  private async createAlert(alertData: {
    type: Alert['type'];
    severity: Alert['severity'];
    title: string;
    description: string;
    triggeredBy: string;
    metadata?: Record<string, any>;
  }): Promise<Alert> {
    const alert: Alert = {
      id: crypto.randomUUID(),
      ...alertData,
      triggeredAt: new Date(),
      acknowledged: false,
      resolved: false,
      metadata: alertData.metadata || {},
      actions: [],
    };

    this.activeAlerts.set(alert.id, alert);

    // Store in Redis
    await redis.setex(
      `alert:${alert.id}`,
      86400 * this.config.retentionPolicies.alerts,
      JSON.stringify(alert)
    );

    // Notify subscribers
    this.alertSubscribers.forEach(callback => {
      try {
        callback(alert);
      } catch (error) {
        logger.error('[AuditMonitoring] Error in alert callback', {
          alertId: alert.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    // Execute automated responses if configured
    if (alert.severity === 'CRITICAL' || alert.severity === 'HIGH') {
      await this.executeAutomatedResponse(alert);
    }

    logger.info('[AuditMonitoring] Alert created', {
      alertId: alert.id,
      type: alert.type,
      severity: alert.severity,
      title: alert.title,
    });

    return alert;
  }

  /**
   * Initialize default monitoring rules
   */
  private initializeDefaultRules(): void {
    const defaultRules: Omit<MonitoringRule, 'id'>[] = [
      {
        name: 'Multiple Failed Logins',
        description: 'Detect multiple failed login attempts from same IP',
        enabled: true,
        eventType: 'AUTHENTICATION',
        conditions: { result: 'FAILURE', count: 5, timeWindow: 15 },
        alertSeverity: 'HIGH',
        actions: ['BLOCK_IP', 'NOTIFY_ADMIN'],
        cooldownPeriod: 30,
      },
      {
        name: 'Privilege Escalation',
        description: 'Detect privilege escalation attempts',
        enabled: true,
        eventType: 'AUTHORIZATION',
        conditions: { action: 'PRIVILEGE_ESCALATION', result: 'SUCCESS' },
        alertSeverity: 'CRITICAL',
        actions: ['NOTIFY_ADMIN', 'ESCALATE'],
        cooldownPeriod: 5,
      },
      {
        name: 'Suspicious File Access',
        description: 'Detect unusual file access patterns',
        enabled: true,
        eventType: 'PERMISSION_CHANGE',
        conditions: { severity: 'HIGH', riskScore: { '>': 80 } },
        alertSeverity: 'MEDIUM',
        actions: ['QUARANTINE_FILE', 'NOTIFY_ADMIN'],
        cooldownPeriod: 60,
      },
    ];

    defaultRules.forEach(rule => {
      const ruleId = crypto.randomUUID();
      this.monitoringRules.set(ruleId, { id: ruleId, ...rule });
    });
  }

  /**
   * Load active alerts from Redis
   */
  private async loadActiveAlerts(): Promise<void> {
    try {
      const keys = await redis.keys('alert:*');

      for (const key of keys) {
        const alertData = await redis.get(key);
        if (alertData) {
          const alert: Alert = JSON.parse(alertData);
          if (!alert.resolved) {
            this.activeAlerts.set(alert.id, alert);
          }
        }
      }

      logger.info('[AuditMonitoring] Loaded active alerts', {
        count: this.activeAlerts.size,
      });
    } catch (error) {
      logger.error('[AuditMonitoring] Error loading active alerts', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process monitoring rules
   */
  private async processMonitoringRules(): Promise<void> {
    // This would process complex rules that require periodic evaluation
    // For now, we handle real-time rules in processAuditEvent
  }

  /**
   * Clean up expired alerts
   */
  private async cleanupExpiredAlerts(): Promise<void> {
    try {
      const expiredTime = new Date(
        Date.now() - this.config.retentionPolicies.alerts * 24 * 60 * 60 * 1000
      );

      for (const [alertId, alert] of this.activeAlerts.entries()) {
        if (alert.triggeredAt < expiredTime && alert.resolved) {
          this.activeAlerts.delete(alertId);
          await redis.del(`alert:${alertId}`);
        }
      }
    } catch (error) {
      logger.error('[AuditMonitoring] Error cleaning up expired alerts', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Update system health metrics
   */
  private async updateSystemHealth(metrics: MonitoringMetrics): Promise<void> {
    try {
      await redis.setex(
        'system_health',
        300,
        JSON.stringify(metrics.systemHealth)
      ); // 5 minute cache
    } catch (error) {
      logger.error('[AuditMonitoring] Error updating system health', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Check if event matches monitoring rule
   */
  private async eventMatchesRule(
    event: SecurityAuditEvent,
    rule: MonitoringRule
  ): Promise<boolean> {
    if (event.eventType !== rule.eventType) {
      return false;
    }

    // Check conditions
    for (const [key, value] of Object.entries(rule.conditions)) {
      const eventValue = (event as any)[key];

      if (typeof value === 'object' && value !== null) {
        // Handle complex conditions like { '>': 80 }
        for (const [op, condValue] of Object.entries(value as Record<string, unknown>)) {
          const numCondValue = Number(condValue);
          switch (op) {
            case '>':
              if (!(eventValue > numCondValue)) return false;
              break;
            case '>=':
              if (!(eventValue >= numCondValue)) return false;
              break;
            case '<':
              if (!(eventValue < numCondValue)) return false;
              break;
            case '<=':
              if (!(eventValue <= numCondValue)) return false;
              break;
            case '=':
            case '==':
              if (eventValue !== condValue) return false;
              break;
          }
        }
      } else {
        // Simple equality check
        if (eventValue !== value) return false;
      }
    }

    return true;
  }

  /**
   * Trigger alert from monitoring rule
   */
  private async triggerRuleAlert(
    event: SecurityAuditEvent,
    rule: MonitoringRule
  ): Promise<void> {
    await this.createAlert({
      type: 'SECURITY',
      severity: rule.alertSeverity,
      title: rule.name,
      description: `${rule.description} - Event ID: ${event.id}`,
      triggeredBy: `rule:${rule.id}`,
      metadata: {
        ruleId: rule.id,
        eventId: event.id,
        eventData: event,
      },
    });
  }

  /**
   * Execute automated response for alert
   */
  private async executeAutomatedResponse(alert: Alert): Promise<void> {
    try {
      // This would implement automated responses based on configuration
      logger.info('[AuditMonitoring] Executing automated response', {
        alertId: alert.id,
        severity: alert.severity,
        type: alert.type,
      });

      // Example automated responses would be implemented here
      // - Block suspicious IPs
      // - Disable compromised accounts
      // - Quarantine files
      // - Escalate to administrators
    } catch (error) {
      logger.error('[AuditMonitoring] Error executing automated response', {
        alertId: alert.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get top risk users
   */
  private async getTopRiskUsers(): Promise<
    Array<{ userId: number; riskScore: number }>
  > {
    try {
      const topUsers = await db
        .select({
          userId: securityAuditEvents.userId,
          avgRiskScore: sql`avg(${securityAuditEvents.riskScore})`,
        })
        .from(securityAuditEvents)
        .where(
          and(
            sql`${securityAuditEvents.userId} IS NOT NULL`,
            gte(securityAuditEvents.eventTime, sql`NOW() - INTERVAL '24 hours'`)
          )
        )
        .groupBy(securityAuditEvents.userId)
        .orderBy(desc(sql`avg(${securityAuditEvents.riskScore})`))
        .limit(5);

      return topUsers.map(user => ({
        userId: user.userId!,
        riskScore: Number(user.avgRiskScore),
      }));
    } catch (error) {
      logger.error('[AuditMonitoring] Error getting top risk users', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Get top risk files
   */
  private async getTopRiskFiles(): Promise<
    Array<{ fileId: string; riskScore: number }>
  > {
    try {
      const topFiles = await db
        .select({
          fileId: securityAuditEvents.fileId,
          avgRiskScore: sql`avg(${securityAuditEvents.riskScore})`,
        })
        .from(securityAuditEvents)
        .where(
          and(
            sql`${securityAuditEvents.fileId} IS NOT NULL`,
            gte(securityAuditEvents.eventTime, sql`NOW() - INTERVAL '24 hours'`)
          )
        )
        .groupBy(securityAuditEvents.fileId)
        .orderBy(desc(sql`avg(${securityAuditEvents.riskScore})`))
        .limit(5);

      return topFiles.map(file => ({
        fileId: file.fileId!,
        riskScore: Number(file.avgRiskScore),
      }));
    } catch (error) {
      logger.error('[AuditMonitoring] Error getting top risk files', {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
  }

  /**
   * Assess overall system health
   */
  private assessSystemHealth(
    criticalEvents: number,
    systemErrorRate: number,
    complianceScore: number
  ): MonitoringMetrics['systemHealth'] {
    let overall: 'HEALTHY' | 'WARNING' | 'CRITICAL' = 'HEALTHY';

    // Determine overall health
    if (criticalEvents > 20 || systemErrorRate > 0.1 || complianceScore < 60) {
      overall = 'CRITICAL';
    } else if (
      criticalEvents > 10 ||
      systemErrorRate > 0.05 ||
      complianceScore < 80
    ) {
      overall = 'WARNING';
    }

    return {
      overall,
      components: {
        audit: criticalEvents > 10 ? 'WARNING' : 'HEALTHY',
        system: systemErrorRate > 0.05 ? 'WARNING' : 'HEALTHY',
        compliance: complianceScore < 80 ? 'WARNING' : 'HEALTHY',
        storage: 'HEALTHY', // Would be determined from storage metrics
        network: 'HEALTHY', // Would be determined from network metrics
      },
    };
  }

  /**
   * Get resolved alerts count
   */
  private async getResolvedAlertsCount(): Promise<number> {
    try {
      const keys = await redis.keys('resolved_alert:*');
      return keys.length;
    } catch (error) {
      return 0;
    }
  }
}

export const auditMonitoringService = new AuditMonitoringService();
