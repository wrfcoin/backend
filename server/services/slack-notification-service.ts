/**
 * Slack Notification Service - Outbound WRFCoin → Slack Bridge
 * Sends alerts, test results, and health status to configured Slack channels
 */

import { securityLogger } from '../utils/logger.js';

export type AlertSeverity = 'SEV1' | 'SEV2' | 'SEV3' | 'SEV4' | 'info' | 'warning' | 'critical' | 'emergency';

export interface SlackAlert {
  alertname: string;
  severity: AlertSeverity;
  status: 'firing' | 'resolved';
  description?: string;
  summary?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  endsAt?: string;
}

export interface SlackMessage {
  text: string;
  channel?: string;
  attachments?: SlackAttachment[];
  blocks?: SlackBlock[];
}

interface SlackAttachment {
  color: string;
  fields: SlackField[];
  ts?: number;
  fallback?: string;
}

interface SlackField {
  title: string;
  value: string;
  short: boolean;
}

interface SlackBlock {
  type: string;
  text?: { type: string; text: string };
  fields?: { type: string; text: string }[];
}

interface DeliveryResult {
  success: boolean;
  channel: string;
  messageTs?: string;
  error?: string;
  retryCount: number;
}

const RETRY_DELAYS = [1000, 4000, 16000];

export class SlackNotificationService {
  private webhookUrl: string;
  private enabled: boolean;

  private channelMap: Record<string, string> = {
    SEV1: process.env.SLACK_CHANNEL_CRITICAL || '#wrfcoin-alerts-critical',
    SEV2: process.env.SLACK_CHANNEL_CRITICAL || '#wrfcoin-alerts-critical',
    SEV3: process.env.SLACK_CHANNEL_WARNING || '#wrfcoin-alerts-warnings',
    SEV4: process.env.SLACK_CHANNEL_INFO || '#wrfcoin-alerts',
    critical: process.env.SLACK_CHANNEL_CRITICAL || '#wrfcoin-alerts-critical',
    emergency: process.env.SLACK_CHANNEL_CRITICAL || '#wrfcoin-alerts-critical',
    warning: process.env.SLACK_CHANNEL_WARNING || '#wrfcoin-alerts-warnings',
    info: process.env.SLACK_CHANNEL_INFO || '#wrfcoin-alerts',
  };

  constructor() {
    this.webhookUrl = process.env.SLACK_WEBHOOK_URL || '';
    this.enabled = !!this.webhookUrl && process.env.SLACK_ENABLED !== 'false';

    if (!this.enabled) {
      securityLogger.warn('Slack notification service disabled - no webhook URL configured');
    }
  }

  private getSeverityColor(severity: AlertSeverity): string {
    switch (severity) {
      case 'SEV1':
      case 'emergency':
        return '#ff0000';
      case 'SEV2':
      case 'critical':
        return 'danger';
      case 'SEV3':
      case 'warning':
        return 'warning';
      case 'SEV4':
      case 'info':
      default:
        return 'good';
    }
  }

  private getSeverityEmoji(severity: AlertSeverity): string {
    switch (severity) {
      case 'SEV1':
      case 'emergency':
        return '🚨🔥';
      case 'SEV2':
      case 'critical':
        return '🚨';
      case 'SEV3':
      case 'warning':
        return '⚠️';
      case 'SEV4':
      case 'info':
      default:
        return 'ℹ️';
    }
  }

  private getChannelForSeverity(severity: AlertSeverity): string {
    return this.channelMap[severity] || this.channelMap.info;
  }

  formatAlertMessage(alert: SlackAlert): SlackMessage {
    const emoji = this.getSeverityEmoji(alert.severity);
    const status = alert.status === 'resolved' ? '✅ RESOLVED' : `${emoji} FIRING`;

    const fields: SlackField[] = [
      { title: 'Status', value: status, short: true },
      { title: 'Severity', value: alert.severity.toUpperCase(), short: true },
      { title: 'Alert', value: alert.alertname, short: true },
    ];

    if (alert.description || alert.annotations?.description) {
      fields.push({
        title: 'Description',
        value: alert.description || alert.annotations?.description || '',
        short: false,
      });
    }

    if (alert.summary || alert.annotations?.summary) {
      fields.push({
        title: 'Summary',
        value: alert.summary || alert.annotations?.summary || '',
        short: false,
      });
    }

    if (alert.labels) {
      const labelStr = Object.entries(alert.labels)
        .filter(([k]) => !['alertname', 'severity'].includes(k))
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
      if (labelStr) {
        fields.push({ title: 'Labels', value: labelStr, short: false });
      }
    }

    const color = alert.status === 'resolved' ? 'good' : this.getSeverityColor(alert.severity);

    return {
      text: `${emoji} WRFCoin Alert: ${alert.alertname}`,
      channel: this.getChannelForSeverity(alert.severity),
      attachments: [{
        color,
        fields,
        ts: Math.floor(Date.now() / 1000),
      }],
    };
  }

  formatIncidentMessage(incident: {
    id: string;
    alertName: string;
    severity: AlertSeverity;
    status: string;
    actionsExecuted: number;
    actions?: { action: string; result: string }[];
  }): SlackMessage {
    const emoji = this.getSeverityEmoji(incident.severity);

    const fields: SlackField[] = [
      { title: 'Incident ID', value: incident.id.substring(0, 8), short: true },
      { title: 'Severity', value: incident.severity, short: true },
      { title: 'Status', value: incident.status, short: true },
      { title: 'Actions Executed', value: String(incident.actionsExecuted), short: true },
    ];

    if (incident.actions && incident.actions.length > 0) {
      const actionsStr = incident.actions
        .map(a => `• ${a.action}: ${a.result}`)
        .join('\n');
      fields.push({ title: 'Action Results', value: actionsStr, short: false });
    }

    return {
      text: `${emoji} WRFCoin Incident: ${incident.alertName}`,
      channel: this.getChannelForSeverity(incident.severity),
      attachments: [{
        color: this.getSeverityColor(incident.severity),
        fields,
        ts: Math.floor(Date.now() / 1000),
      }],
    };
  }

  formatTestResultMessage(result: {
    suite: string;
    passed: number;
    failed: number;
    skipped: number;
    duration: number;
    failures?: { test: string; error: string }[];
  }): SlackMessage {
    const success = result.failed === 0;
    const emoji = success ? '✅' : '❌';

    const fields: SlackField[] = [
      { title: 'Suite', value: result.suite, short: true },
      { title: 'Duration', value: `${result.duration}ms`, short: true },
      { title: 'Passed', value: String(result.passed), short: true },
      { title: 'Failed', value: String(result.failed), short: true },
      { title: 'Skipped', value: String(result.skipped), short: true },
    ];

    if (result.failures && result.failures.length > 0) {
      const failStr = result.failures
        .slice(0, 5)
        .map(f => `• ${f.test}: ${f.error.substring(0, 100)}`)
        .join('\n');
      fields.push({ title: 'Failures', value: failStr, short: false });
    }

    return {
      text: `${emoji} Test Results: ${result.suite}`,
      channel: process.env.SLACK_CHANNEL_TESTS || '#wrfcoin-alerts',
      attachments: [{
        color: success ? 'good' : 'danger',
        fields,
        ts: Math.floor(Date.now() / 1000),
      }],
    };
  }

  formatHealthMessage(health: {
    overall: 'healthy' | 'degraded' | 'unhealthy';
    services: { name: string; status: string; latency?: number }[];
    timestamp: string;
  }): SlackMessage {
    const emoji = health.overall === 'healthy' ? '💚' : health.overall === 'degraded' ? '💛' : '❤️';

    const serviceList = health.services
      .map(s => {
        const statusEmoji = s.status === 'healthy' ? '✓' : s.status === 'degraded' ? '~' : '✗';
        const latency = s.latency ? ` (${s.latency}ms)` : '';
        return `${statusEmoji} ${s.name}${latency}`;
      })
      .join('\n');

    return {
      text: `${emoji} WRFCoin Health Status: ${health.overall.toUpperCase()}`,
      channel: process.env.SLACK_CHANNEL_HEALTH || '#wrfcoin-infrastructure',
      attachments: [{
        color: health.overall === 'healthy' ? 'good' : health.overall === 'degraded' ? 'warning' : 'danger',
        fields: [
          { title: 'Overall Status', value: health.overall.toUpperCase(), short: true },
          { title: 'Timestamp', value: health.timestamp, short: true },
          { title: 'Services', value: serviceList, short: false },
        ],
        ts: Math.floor(Date.now() / 1000),
      }],
    };
  }

  async sendMessage(message: SlackMessage): Promise<DeliveryResult> {
    if (!this.enabled) {
      return { success: false, channel: message.channel || '', error: 'Slack disabled', retryCount: 0 };
    }

    let lastError: string | undefined;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const response = await fetch(this.webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(message),
        });

        if (response.ok) {
          securityLogger.info('Slack message delivered', {
            channel: message.channel,
            attempt: attempt + 1,
          });
          return {
            success: true,
            channel: message.channel || '',
            retryCount: attempt,
          };
        }

        lastError = `HTTP ${response.status}: ${await response.text()}`;

        if (response.status >= 400 && response.status < 500) {
          break;
        }
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }

      if (attempt < RETRY_DELAYS.length) {
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAYS[attempt]));
      }
    }

    securityLogger.error('Slack message delivery failed', {
      channel: message.channel,
      error: lastError,
    });

    return {
      success: false,
      channel: message.channel || '',
      error: lastError,
      retryCount: RETRY_DELAYS.length,
    };
  }

  async sendAlert(alert: SlackAlert): Promise<DeliveryResult> {
    const message = this.formatAlertMessage(alert);
    return this.sendMessage(message);
  }

  async sendIncident(incident: Parameters<typeof this.formatIncidentMessage>[0]): Promise<DeliveryResult> {
    const message = this.formatIncidentMessage(incident);
    return this.sendMessage(message);
  }

  async sendTestResult(result: Parameters<typeof this.formatTestResultMessage>[0]): Promise<DeliveryResult> {
    const message = this.formatTestResultMessage(result);
    return this.sendMessage(message);
  }

  async sendHealth(health: Parameters<typeof this.formatHealthMessage>[0]): Promise<DeliveryResult> {
    const message = this.formatHealthMessage(health);
    return this.sendMessage(message);
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}

export const slackNotificationService = new SlackNotificationService();
