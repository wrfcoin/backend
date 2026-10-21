/**
 * OpenForis Alerting System
 *
 * Comprehensive alerting and notification system for OpenForis integration
 * monitoring. Handles alert conditions, escalation, and notification channels.
 */

import { EventEmitter } from 'events';
import { openforisLogger, securityLogger, logSecurityEvent } from './logger.js';
import { openforisMonitor } from '../middleware/openforis-monitoring.js';

// Alert severity levels
export type AlertSeverity = 'info' | 'warning' | 'critical' | 'emergency';

// Alert categories
export type AlertCategory =
  | 'performance'
  | 'availability'
  | 'errors'
  | 'security'
  | 'resource'
  | 'data_quality'
  | 'integration';

// Alert interface
export interface Alert {
  id: string;
  severity: AlertSeverity;
  category: AlertCategory;
  title: string;
  message: string;
  details?: Record<string, any>;
  threshold?: string;
  currentValue?: string;
  timestamp: Date;
  resolved?: Date;
  acknowledgedBy?: string;
  acknowledgedAt?: Date;
  escalated?: boolean;
  escalatedAt?: Date;
  escalationLevel?: number;
}

// Alert rule interface
interface AlertRule {
  id: string;
  name: string;
  category: AlertCategory;
  severity: AlertSeverity;
  condition: (metrics: any) => boolean;
  message: (metrics: any) => string;
  threshold?: string;
  cooldown?: number; // minutes
  escalationRules?: EscalationRule[];
}

// Escalation rule interface
interface EscalationRule {
  level: number;
  afterMinutes: number;
  severity: AlertSeverity;
  notificationChannels: string[];
}

// Notification channel interface
interface NotificationChannel {
  id: string;
  type: 'email' | 'slack' | 'webhook' | 'sms' | 'pagerduty';
  config: Record<string, any>;
  enabled: boolean;
}

// Alert manager class
class OpenForisAlertManager extends EventEmitter {
  private alerts = new Map<string, Alert>();
  private alertHistory: Alert[] = [];
  private alertRules: AlertRule[] = [];
  private notificationChannels: NotificationChannel[] = [];
  private alertCooldowns = new Map<string, Date>();
  private escalationTimers = new Map<string, NodeJS.Timeout>();

  constructor() {
    super();
    this.initializeDefaultRules();
    this.initializeDefaultChannels();
    this.startMonitoring();
  }

  // Initialize default alert rules
  private initializeDefaultRules() {
    this.alertRules = [
      // Performance alerts
      {
        id: 'high_response_time',
        name: 'High Response Time',
        category: 'performance',
        severity: 'warning',
        condition: metrics => metrics.averageResponseTime > 5000,
        message: metrics =>
          `OpenForis API response time is ${Math.round(metrics.averageResponseTime)}ms (threshold: 5000ms)`,
        threshold: '5000ms',
        cooldown: 10,
        escalationRules: [
          {
            level: 1,
            afterMinutes: 15,
            severity: 'critical',
            notificationChannels: ['slack', 'email'],
          },
        ],
      },
      {
        id: 'very_high_response_time',
        name: 'Very High Response Time',
        category: 'performance',
        severity: 'critical',
        condition: metrics => metrics.averageResponseTime > 10000,
        message: metrics =>
          `OpenForis API response time is critically high: ${Math.round(metrics.averageResponseTime)}ms`,
        threshold: '10000ms',
        cooldown: 5,
      },

      // Error rate alerts
      {
        id: 'high_error_rate',
        name: 'High Error Rate',
        category: 'errors',
        severity: 'warning',
        condition: metrics => {
          const errorRate =
            metrics.requestCount > 0
              ? metrics.errorCount / metrics.requestCount
              : 0;
          return errorRate > 0.05; // 5%
        },
        message: metrics => {
          const errorRate =
            metrics.requestCount > 0
              ? ((metrics.errorCount / metrics.requestCount) * 100).toFixed(2)
              : '0';
          return `OpenForis API error rate is ${errorRate}% (threshold: 5%)`;
        },
        threshold: '5%',
        cooldown: 10,
      },
      {
        id: 'critical_error_rate',
        name: 'Critical Error Rate',
        category: 'errors',
        severity: 'critical',
        condition: metrics => {
          const errorRate =
            metrics.requestCount > 0
              ? metrics.errorCount / metrics.requestCount
              : 0;
          return errorRate > 0.1; // 10%
        },
        message: metrics => {
          const errorRate =
            metrics.requestCount > 0
              ? ((metrics.errorCount / metrics.requestCount) * 100).toFixed(2)
              : '0';
          return `OpenForis API error rate is critically high: ${errorRate}%`;
        },
        threshold: '10%',
        cooldown: 5,
        escalationRules: [
          {
            level: 1,
            afterMinutes: 5,
            severity: 'emergency',
            notificationChannels: ['pagerduty', 'sms', 'slack'],
          },
        ],
      },

      // Resource alerts
      {
        id: 'high_memory_usage',
        name: 'High Memory Usage',
        category: 'resource',
        severity: 'warning',
        condition: metrics => {
          const memoryUsage = process.memoryUsage();
          return memoryUsage.heapUsed > 512 * 1024 * 1024; // 512MB
        },
        message: metrics => {
          const memoryUsage = process.memoryUsage();
          const memoryMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
          return `OpenForis service memory usage is ${memoryMB}MB (threshold: 512MB)`;
        },
        threshold: '512MB',
        cooldown: 15,
      },
      {
        id: 'very_high_memory_usage',
        name: 'Very High Memory Usage',
        category: 'resource',
        severity: 'critical',
        condition: metrics => {
          const memoryUsage = process.memoryUsage();
          return memoryUsage.heapUsed > 1024 * 1024 * 1024; // 1GB
        },
        message: metrics => {
          const memoryUsage = process.memoryUsage();
          const memoryMB = Math.round(memoryUsage.heapUsed / 1024 / 1024);
          return `OpenForis service memory usage is critically high: ${memoryMB}MB`;
        },
        threshold: '1024MB',
        cooldown: 5,
      },

      // Availability alerts
      {
        id: 'high_active_requests',
        name: 'High Concurrent Requests',
        category: 'availability',
        severity: 'warning',
        condition: metrics => metrics.activeRequests > 50,
        message: metrics =>
          `OpenForis API has ${metrics.activeRequests} concurrent requests (threshold: 50)`,
        threshold: '50',
        cooldown: 5,
      },
      {
        id: 'very_high_active_requests',
        name: 'Very High Concurrent Requests',
        category: 'availability',
        severity: 'critical',
        condition: metrics => metrics.activeRequests > 100,
        message: metrics =>
          `OpenForis API has critically high concurrent requests: ${metrics.activeRequests}`,
        threshold: '100',
        cooldown: 2,
      },

      // Security alerts
      {
        id: 'repeated_failures',
        name: 'Repeated API Failures',
        category: 'security',
        severity: 'warning',
        condition: metrics => {
          // Check for patterns that might indicate attacks
          return metrics.errorCount > 50 && metrics.requestCount > 100;
        },
        message: metrics =>
          `Detected ${metrics.errorCount} errors out of ${metrics.requestCount} requests - possible attack`,
        cooldown: 30,
      },

      // Data quality alerts
      {
        id: 'data_quality_degradation',
        name: 'Data Quality Degradation',
        category: 'data_quality',
        severity: 'warning',
        condition: metrics => {
          // Mock data quality check - in real implementation,
          // this would check actual data quality metrics
          return false; // Disabled for now
        },
        message: () =>
          'OpenForis data quality has degraded below acceptable thresholds',
        cooldown: 60,
      },
    ];
  }

  // Initialize default notification channels
  private initializeDefaultChannels() {
    this.notificationChannels = [
      {
        id: 'slack',
        type: 'slack',
        config: {
          webhookUrl: process.env.SLACK_WEBHOOK_URL || '',
          channel: '#openforis-alerts',
        },
        enabled: Boolean(process.env.SLACK_WEBHOOK_URL),
      },
      {
        id: 'email',
        type: 'email',
        config: {
          to: process.env.ALERT_EMAIL || 'admin@wrfcoin.com',
          from: 'alerts@wrfcoin.com',
        },
        enabled: Boolean(process.env.ALERT_EMAIL),
      },
      {
        id: 'webhook',
        type: 'webhook',
        config: {
          url: process.env.ALERT_WEBHOOK_URL || '',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${process.env.ALERT_WEBHOOK_TOKEN || ''}`,
          },
        },
        enabled: Boolean(process.env.ALERT_WEBHOOK_URL),
      },
      {
        id: 'pagerduty',
        type: 'pagerduty',
        config: {
          integrationKey: process.env.PAGERDUTY_INTEGRATION_KEY || '',
        },
        enabled: Boolean(process.env.PAGERDUTY_INTEGRATION_KEY),
      },
    ];
  }

  // Start monitoring and checking alert conditions
  private startMonitoring() {
    // #977 ratchet: unref'd — reached at import; the handle was discarded.
    const importTimeTimer100 = setInterval(() => {
      this.checkAlertConditions();
    }, 30000);
    importTimeTimer100.unref(); // Check every 30 seconds
  }

  // Check all alert conditions
  private checkAlertConditions() {
    try {
      const metrics = openforisMonitor.getMetrics();
      const systemMetrics = {
        ...metrics,
        memoryUsage: process.memoryUsage(),
        timestamp: new Date(),
      };

      for (const rule of this.alertRules) {
        this.evaluateRule(rule, systemMetrics);
      }
    } catch (error) {
      openforisLogger.error('Error checking alert conditions', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  // Evaluate a single alert rule
  private evaluateRule(rule: AlertRule, metrics: any) {
    const isTriggered = rule.condition(metrics);
    const existingAlert = this.alerts.get(rule.id);

    if (isTriggered && !existingAlert) {
      // Check cooldown
      const cooldownEnd = this.alertCooldowns.get(rule.id);
      if (cooldownEnd && new Date() < cooldownEnd) {
        return; // Still in cooldown
      }

      // Create new alert
      this.createAlert(rule, metrics);
    } else if (!isTriggered && existingAlert && !existingAlert.resolved) {
      // Resolve existing alert
      this.resolveAlert(rule.id);
    }
  }

  // Create a new alert
  private createAlert(rule: AlertRule, metrics: any) {
    const alert: Alert = {
      id: `${rule.id}_${Date.now()}`,
      severity: rule.severity,
      category: rule.category,
      title: rule.name,
      message: rule.message(metrics),
      details: {
        rule: rule.id,
        metrics: {
          requestCount: metrics.requestCount,
          errorCount: metrics.errorCount,
          activeRequests: metrics.activeRequests,
          averageResponseTime: Math.round(metrics.averageResponseTime),
          memoryUsage:
            Math.round(metrics.memoryUsage?.heapUsed / 1024 / 1024) || 0,
        },
      },
      threshold: rule.threshold,
      timestamp: new Date(),
    };

    // Add current value for comparison
    if (rule.id.includes('response_time')) {
      alert.currentValue = `${Math.round(metrics.averageResponseTime)}ms`;
    } else if (rule.id.includes('error_rate')) {
      const errorRate =
        metrics.requestCount > 0
          ? ((metrics.errorCount / metrics.requestCount) * 100).toFixed(2)
          : '0';
      alert.currentValue = `${errorRate}%`;
    } else if (rule.id.includes('memory')) {
      const memoryMB =
        Math.round(metrics.memoryUsage?.heapUsed / 1024 / 1024) || 0;
      alert.currentValue = `${memoryMB}MB`;
    } else if (rule.id.includes('active_requests')) {
      alert.currentValue = metrics.activeRequests.toString();
    }

    this.alerts.set(rule.id, alert);
    this.alertHistory.push(alert);

    // Set cooldown
    if (rule.cooldown) {
      const cooldownEnd = new Date(Date.now() + rule.cooldown * 60000);
      this.alertCooldowns.set(rule.id, cooldownEnd);
    }

    // Send notifications
    this.sendNotifications(alert);

    // Set up escalation if defined
    if (rule.escalationRules && rule.escalationRules.length > 0) {
      this.setupEscalation(alert, rule.escalationRules[0]);
    }

    // Log security events for security-related alerts
    if (rule.category === 'security') {
      logSecurityEvent(
        `OpenForis Alert: ${rule.name}`,
        {
          alertId: alert.id,
          severity: alert.severity,
          message: alert.message,
        },
        'warn'
      );
    }

    // Emit alert event
    this.emit('alert', alert);

    openforisLogger.warn('OpenForis alert triggered', {
      alertId: alert.id,
      rule: rule.id,
      severity: alert.severity,
      category: alert.category,
      message: alert.message,
    });
  }

  // Resolve an alert
  private resolveAlert(ruleId: string) {
    const alert = this.alerts.get(ruleId);
    if (!alert) return;

    alert.resolved = new Date();
    this.alerts.delete(ruleId);

    // Clear escalation timer
    const timer = this.escalationTimers.get(alert.id);
    if (timer) {
      clearTimeout(timer);
      this.escalationTimers.delete(alert.id);
    }

    // Send resolution notification
    this.sendResolutionNotification(alert);

    // Emit resolution event
    this.emit('alertResolved', alert);

    openforisLogger.info('OpenForis alert resolved', {
      alertId: alert.id,
      duration: alert.resolved.getTime() - alert.timestamp.getTime(),
    });
  }

  // Set up alert escalation
  private setupEscalation(alert: Alert, escalationRule: EscalationRule) {
    const timeout = setTimeout(() => {
      this.escalateAlert(alert, escalationRule);
    }, escalationRule.afterMinutes * 60000);

    this.escalationTimers.set(alert.id, timeout);
  }

  // Escalate an alert
  private escalateAlert(alert: Alert, escalationRule: EscalationRule) {
    if (alert.resolved) return; // Alert was resolved

    alert.escalated = true;
    alert.escalatedAt = new Date();
    alert.escalationLevel = escalationRule.level;
    alert.severity = escalationRule.severity;

    openforisLogger.error('OpenForis alert escalated', {
      alertId: alert.id,
      newSeverity: alert.severity,
      escalationLevel: alert.escalationLevel,
    });

    // Send escalation notifications
    this.sendEscalationNotifications(
      alert,
      escalationRule.notificationChannels
    );

    this.emit('alertEscalated', alert);
  }

  // Send notifications for new alerts
  private async sendNotifications(alert: Alert) {
    const enabledChannels = this.notificationChannels.filter(c => c.enabled);

    for (const channel of enabledChannels) {
      try {
        await this.sendNotification(channel, alert);
      } catch (error) {
        openforisLogger.error('Failed to send alert notification', {
          alertId: alert.id,
          channel: channel.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  // Send escalation notifications
  private async sendEscalationNotifications(
    alert: Alert,
    channelIds: string[]
  ) {
    const channels = this.notificationChannels.filter(
      c => c.enabled && channelIds.includes(c.id)
    );

    for (const channel of channels) {
      try {
        await this.sendEscalationNotification(channel, alert);
      } catch (error) {
        openforisLogger.error('Failed to send escalation notification', {
          alertId: alert.id,
          channel: channel.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  // Send individual notification
  private async sendNotification(channel: NotificationChannel, alert: Alert) {
    const payload = this.formatNotificationPayload(channel.type, alert);

    // Mock notification sending - in real implementation,
    // this would integrate with actual notification services
    openforisLogger.info('Sending alert notification', {
      channel: channel.id,
      type: channel.type,
      alertId: alert.id,
      severity: alert.severity,
    });

    // Example webhook notification
    if (channel.type === 'webhook' && channel.config.url) {
      // In real implementation, send HTTP request to webhook URL
      console.log(`Webhook notification to ${channel.config.url}:`, payload);
    }
  }

  // Send escalation notification
  private async sendEscalationNotification(
    channel: NotificationChannel,
    alert: Alert
  ) {
    const payload = this.formatEscalationPayload(channel.type, alert);

    openforisLogger.warn('Sending escalation notification', {
      channel: channel.id,
      type: channel.type,
      alertId: alert.id,
      severity: alert.severity,
      escalationLevel: alert.escalationLevel,
    });

    // Mock escalation notification
    console.log(`Escalation notification via ${channel.type}:`, payload);
  }

  // Send resolution notification
  private async sendResolutionNotification(alert: Alert) {
    const enabledChannels = this.notificationChannels.filter(c => c.enabled);

    for (const channel of enabledChannels) {
      try {
        const payload = this.formatResolutionPayload(channel.type, alert);

        openforisLogger.info('Sending resolution notification', {
          channel: channel.id,
          alertId: alert.id,
        });

        // Mock resolution notification
        console.log(`Resolution notification via ${channel.type}:`, payload);
      } catch (error) {
        openforisLogger.error('Failed to send resolution notification', {
          alertId: alert.id,
          channel: channel.id,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }
  }

  // Format notification payload
  private formatNotificationPayload(type: string, alert: Alert) {
    const basePayload = {
      service: 'openforis-integration',
      alert: {
        id: alert.id,
        severity: alert.severity,
        category: alert.category,
        title: alert.title,
        message: alert.message,
        timestamp: alert.timestamp.toISOString(),
        threshold: alert.threshold,
        currentValue: alert.currentValue,
      },
    };

    switch (type) {
      case 'slack':
        return {
          text: `🚨 OpenForis Alert: ${alert.title}`,
          attachments: [
            {
              color: this.getSeverityColor(alert.severity),
              fields: [
                {
                  title: 'Severity',
                  value: alert.severity.toUpperCase(),
                  short: true,
                },
                { title: 'Category', value: alert.category, short: true },
                { title: 'Message', value: alert.message, short: false },
                {
                  title: 'Threshold',
                  value: alert.threshold || 'N/A',
                  short: true,
                },
                {
                  title: 'Current Value',
                  value: alert.currentValue || 'N/A',
                  short: true,
                },
              ],
              ts: Math.floor(alert.timestamp.getTime() / 1000),
            },
          ],
        };

      case 'pagerduty':
        return {
          routing_key: this.notificationChannels.find(c => c.id === 'pagerduty')
            ?.config.integrationKey,
          event_action: 'trigger',
          dedup_key: alert.id,
          payload: {
            summary: `${alert.title}: ${alert.message}`,
            severity: alert.severity,
            source: 'openforis-integration',
            component: 'api',
            group: alert.category,
          },
        };

      default:
        return basePayload;
    }
  }

  // Format escalation payload
  private formatEscalationPayload(type: string, alert: Alert) {
    const payload = this.formatNotificationPayload(type, alert);

    if (type === 'slack' && 'attachments' in payload) {
      (payload as any).text = `🔥 ESCALATED OpenForis Alert: ${alert.title}`;
      (payload as any).attachments[0].color = 'danger';
      (payload as any).attachments[0].fields.unshift({
        title: 'ESCALATED',
        value: `Level ${alert.escalationLevel}`,
        short: true,
      });
    }

    return payload;
  }

  // Format resolution payload
  private formatResolutionPayload(type: string, alert: Alert) {
    const duration = alert.resolved
      ? Math.round(
          (alert.resolved.getTime() - alert.timestamp.getTime()) / 1000 / 60
        )
      : 0;

    if (type === 'slack') {
      return {
        text: `✅ OpenForis Alert Resolved: ${alert.title}`,
        attachments: [
          {
            color: 'good',
            fields: [
              {
                title: 'Resolution Time',
                value: `${duration} minutes`,
                short: true,
              },
              {
                title: 'Original Severity',
                value: alert.severity.toUpperCase(),
                short: true,
              },
            ],
          },
        ],
      };
    }

    return {
      service: 'openforis-integration',
      resolution: {
        alertId: alert.id,
        title: alert.title,
        duration: `${duration} minutes`,
        resolvedAt: alert.resolved?.toISOString(),
      },
    };
  }

  // Get color for severity level
  private getSeverityColor(severity: AlertSeverity): string {
    switch (severity) {
      case 'info':
        return 'good';
      case 'warning':
        return 'warning';
      case 'critical':
        return 'danger';
      case 'emergency':
        return '#ff0000';
      default:
        return '#cccccc';
    }
  }

  // Public API methods

  getActiveAlerts(): Alert[] {
    return Array.from(this.alerts.values());
  }

  getAlertHistory(limit?: number): Alert[] {
    return limit ? this.alertHistory.slice(-limit) : this.alertHistory;
  }

  acknowledgeAlert(alertId: string, acknowledgedBy: string): boolean {
    for (const alert of this.alerts.values()) {
      if (alert.id === alertId) {
        alert.acknowledgedBy = acknowledgedBy;
        alert.acknowledgedAt = new Date();

        openforisLogger.info('Alert acknowledged', {
          alertId,
          acknowledgedBy,
        });

        this.emit('alertAcknowledged', alert);
        return true;
      }
    }
    return false;
  }

  getAlertSummary() {
    const active = this.getActiveAlerts();
    const summary = {
      total: active.length,
      bySeverity: {} as Record<AlertSeverity, number>,
      byCategory: {} as Record<AlertCategory, number>,
      escalated: active.filter(a => a.escalated).length,
      acknowledged: active.filter(a => a.acknowledgedBy).length,
    };

    for (const alert of active) {
      summary.bySeverity[alert.severity] =
        (summary.bySeverity[alert.severity] || 0) + 1;
      summary.byCategory[alert.category] =
        (summary.byCategory[alert.category] || 0) + 1;
    }

    return summary;
  }
}

// Create and export singleton instance
export const alertManager = new OpenForisAlertManager();

// Export types and interfaces
export {
  OpenForisAlertManager,
  AlertRule,
  NotificationChannel,
  EscalationRule,
};
