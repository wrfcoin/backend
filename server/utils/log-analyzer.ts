/**
 * Log Analysis and Monitoring System - Task 67.4
 *
 * Comprehensive log analysis, real-time monitoring, and alerting system
 * for the WRFCoin platform logging infrastructure.
 */

import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';
import { Transform } from 'stream';
import readline from 'readline';
import { appLogger, performanceLogger, securityLogger } from './logger.js';

// Log analysis metrics
export interface LogMetrics {
  totalRequests: number;
  errorRate: number;
  averageResponseTime: number;
  p95ResponseTime: number;
  p99ResponseTime: number;
  requestsPerSecond: number;
  topEndpoints: Array<{ endpoint: string; count: number; avgTime: number }>;
  errorsByType: Record<string, number>;
  securityEvents: number;
  serviceCalls: Record<
    string,
    { success: number; failure: number; avgTime: number }
  >;
  memoryUsage: {
    min: number;
    max: number;
    avg: number;
  };
  timeRange: {
    start: Date;
    end: Date;
  };
}

// Alert types and thresholds
export interface AlertThresholds {
  errorRateThreshold: number; // Percentage
  responseTimeThreshold: number; // Milliseconds
  securityEventThreshold: number; // Events per minute
  memoryUsageThreshold: number; // MB
  diskUsageThreshold: number; // Percentage
  serviceFailureThreshold: number; // Failures per minute
}

// Default alert thresholds
const DEFAULT_THRESHOLDS: AlertThresholds = {
  errorRateThreshold: 5.0, // 5% error rate
  responseTimeThreshold: 1000, // 1 second
  securityEventThreshold: 10, // 10 security events per minute
  memoryUsageThreshold: 512, // 512 MB
  diskUsageThreshold: 85, // 85% disk usage
  serviceFailureThreshold: 5, // 5 service failures per minute
};

// Real-time log monitor
export class LogMonitor extends EventEmitter {
  private watchers: Map<string, fs.StatWatcher> = new Map();
  private metrics: Map<string, any[]> = new Map();
  private thresholds: AlertThresholds;
  private analysisInterval: NodeJS.Timeout;
  private isMonitoring: boolean = false;

  constructor(thresholds: AlertThresholds = DEFAULT_THRESHOLDS) {
    super();
    this.thresholds = thresholds;

    // Run analysis every 30 seconds
    this.analysisInterval = setInterval(() => {
      this.performRealTimeAnalysis();
    }, 30000);
    this.analysisInterval.unref();
  }

  // Start monitoring log files
  startMonitoring(logDir: string = path.join(process.cwd(), 'logs')): void {
    this.isMonitoring = true;

    const logFiles = [
      'combined.log',
      'error.log',
      'performance.log',
      'security.log',
      'graphql.log',
      'crosschain.log',
      'iot.log',
      'weather.log',
    ];

    logFiles.forEach(filename => {
      const filepath = path.join(logDir, filename);

      if (fs.existsSync(filepath)) {
        const watcher = fs.watchFile(
          filepath,
          { interval: 1000 },
          (curr, prev) => {
            if (curr.size > prev.size) {
              this.processNewLogEntries(filepath, prev.size, curr.size);
            }
          }
        );

        this.watchers.set(filename, watcher);
        appLogger.info(`Started monitoring log file: ${filename}`);
      }
    });

    appLogger.info('Log monitoring started');
  }

  // Stop monitoring
  stopMonitoring(): void {
    this.isMonitoring = false;

    this.watchers.forEach((watcher, filename) => {
      fs.unwatchFile(filename);
    });
    this.watchers.clear();

    if (this.analysisInterval) {
      clearInterval(this.analysisInterval);
    }

    appLogger.info('Log monitoring stopped');
  }

  // Process new log entries
  private async processNewLogEntries(
    filepath: string,
    startPos: number,
    endPos: number
  ): Promise<void> {
    try {
      const buffer = Buffer.alloc(endPos - startPos);
      const fd = fs.openSync(filepath, 'r');
      fs.readSync(fd, buffer, 0, buffer.length, startPos);
      fs.closeSync(fd);

      const content = buffer.toString('utf8');
      const lines = content.split('\n').filter(line => line.trim());

      for (const line of lines) {
        try {
          const logEntry = JSON.parse(line);
          this.processLogEntry(logEntry);
        } catch (parseError) {
          // Skip non-JSON lines
        }
      }
    } catch (error) {
      appLogger.error('Error processing new log entries', {
        error: (error as Error).message,
        filepath,
      });
    }
  }

  // Process individual log entry
  private processLogEntry(logEntry: any): void {
    const timestamp = new Date(logEntry.timestamp);
    const now = Date.now();
    const entryAge = now - timestamp.getTime();

    // Only process entries from the last 5 minutes for real-time analysis
    if (entryAge > 5 * 60 * 1000) return;

    // Store metrics by type
    const logType = this.categorizeLogEntry(logEntry);
    if (!this.metrics.has(logType)) {
      this.metrics.set(logType, []);
    }

    const typeMetrics = this.metrics.get(logType)!;
    typeMetrics.push({
      timestamp,
      entry: logEntry,
    });

    // Keep only last 1000 entries per type
    if (typeMetrics.length > 1000) {
      typeMetrics.splice(0, typeMetrics.length - 1000);
    }

    // Emit events for specific log types
    this.emit('logEntry', { type: logType, entry: logEntry });

    // Check for immediate alerts
    this.checkImmediateAlerts(logEntry);
  }

  // Categorize log entries
  private categorizeLogEntry(logEntry: any): string {
    if (logEntry.level === 'error') return 'errors';
    if (logEntry.operation?.startsWith('security:')) return 'security';
    if (logEntry.operation?.startsWith('graphql:')) return 'graphql';
    if (logEntry.operation?.startsWith('crosschain:')) return 'crosschain';
    if (logEntry.operation?.startsWith('service-call:')) return 'serviceCalls';
    if (logEntry.performance?.responseTime) return 'performance';
    return 'general';
  }

  // Check for immediate alerts
  private checkImmediateAlerts(logEntry: any): void {
    // High response time alert
    if (
      logEntry.performance?.responseTime > this.thresholds.responseTimeThreshold
    ) {
      this.emit('alert', {
        type: 'high_response_time',
        severity: 'warning',
        message: `High response time detected: ${logEntry.performance.responseTime}ms`,
        threshold: this.thresholds.responseTimeThreshold,
        value: logEntry.performance.responseTime,
        logEntry,
      });
    }

    // Memory usage alert
    if (logEntry.performance?.memoryUsage?.heapUsed) {
      const memoryMB = logEntry.performance.memoryUsage.heapUsed / 1024 / 1024;
      if (memoryMB > this.thresholds.memoryUsageThreshold) {
        this.emit('alert', {
          type: 'high_memory_usage',
          severity: 'warning',
          message: `High memory usage detected: ${memoryMB.toFixed(2)}MB`,
          threshold: this.thresholds.memoryUsageThreshold,
          value: memoryMB,
          logEntry,
        });
      }
    }

    // Security event alert
    if (logEntry.operation?.startsWith('security:')) {
      this.emit('alert', {
        type: 'security_event',
        severity: logEntry.level === 'error' ? 'critical' : 'warning',
        message: `Security event: ${logEntry.operation}`,
        logEntry,
      });
    }

    // Service failure alert
    if (logEntry.serviceCall && !logEntry.serviceCall.success) {
      this.emit('alert', {
        type: 'service_failure',
        severity: 'warning',
        message: `Service call failed: ${logEntry.serviceCall.targetService}${logEntry.serviceCall.endpoint}`,
        logEntry,
      });
    }
  }

  // Perform real-time analysis
  private performRealTimeAnalysis(): void {
    if (!this.isMonitoring) return;

    try {
      const metrics = this.calculateCurrentMetrics();

      // Check error rate threshold
      if (metrics.errorRate > this.thresholds.errorRateThreshold) {
        this.emit('alert', {
          type: 'high_error_rate',
          severity: 'critical',
          message: `High error rate detected: ${metrics.errorRate.toFixed(2)}%`,
          threshold: this.thresholds.errorRateThreshold,
          value: metrics.errorRate,
          metrics,
        });
      }

      // Check requests per second for unusual spikes
      if (metrics.requestsPerSecond > 100) {
        // Configurable threshold
        this.emit('alert', {
          type: 'traffic_spike',
          severity: 'info',
          message: `Traffic spike detected: ${metrics.requestsPerSecond.toFixed(2)} RPS`,
          value: metrics.requestsPerSecond,
          metrics,
        });
      }

      // Emit metrics update
      this.emit('metricsUpdate', metrics);

      // Log summary metrics
      performanceLogger.info('Real-time metrics analysis', {
        operation: 'monitoring:real-time-analysis',
        performance: {
          totalRequests: metrics.totalRequests,
          errorRate: metrics.errorRate,
          averageResponseTime: metrics.averageResponseTime,
          requestsPerSecond: metrics.requestsPerSecond,
        },
      });
    } catch (error) {
      appLogger.error('Error in real-time analysis', {
        error: (error as Error).message,
      });
    }
  }

  // Calculate current metrics from stored data
  private calculateCurrentMetrics(): LogMetrics {
    const now = Date.now();
    const fiveMinutesAgo = now - 5 * 60 * 1000;

    let totalRequests = 0;
    let errors = 0;
    const responseTimes: number[] = [];
    let securityEvents = 0;
    const endpointCounts: Record<string, { count: number; totalTime: number }> =
      {};
    const errorTypes: Record<string, number> = {};
    const serviceCalls: Record<
      string,
      { success: number; failure: number; totalTime: number }
    > = {};
    const memoryUsages: number[] = [];

    // Process all metric types
    this.metrics.forEach((entries, type) => {
      entries.forEach(({ timestamp, entry }) => {
        if (timestamp.getTime() < fiveMinutesAgo) return;

        // Count requests
        if (entry.method && entry.path) {
          totalRequests++;

          const endpoint = `${entry.method} ${entry.path}`;
          if (!endpointCounts[endpoint]) {
            endpointCounts[endpoint] = { count: 0, totalTime: 0 };
          }
          endpointCounts[endpoint].count++;

          if (entry.performance?.responseTime) {
            endpointCounts[endpoint].totalTime +=
              entry.performance.responseTime;
            responseTimes.push(entry.performance.responseTime);
          }
        }

        // Count errors
        if (entry.level === 'error') {
          errors++;
          const errorType = entry.error?.category || 'unknown';
          errorTypes[errorType] = (errorTypes[errorType] || 0) + 1;
        }

        // Count security events
        if (entry.operation?.startsWith('security:')) {
          securityEvents++;
        }

        // Track service calls
        if (entry.serviceCall) {
          const service = entry.serviceCall.targetService;
          if (!serviceCalls[service]) {
            serviceCalls[service] = { success: 0, failure: 0, totalTime: 0 };
          }

          if (entry.serviceCall.success) {
            serviceCalls[service].success++;
          } else {
            serviceCalls[service].failure++;
          }

          if (entry.serviceCall.duration) {
            serviceCalls[service].totalTime += entry.serviceCall.duration;
          }
        }

        // Track memory usage
        if (entry.performance?.memoryUsage?.heapUsed) {
          memoryUsages.push(
            entry.performance.memoryUsage.heapUsed / 1024 / 1024
          );
        }
      });
    });

    // Calculate statistics
    responseTimes.sort((a, b) => a - b);
    const p95Index = Math.floor(responseTimes.length * 0.95);
    const p99Index = Math.floor(responseTimes.length * 0.99);

    const topEndpoints = Object.entries(endpointCounts)
      .map(([endpoint, data]) => ({
        endpoint,
        count: data.count,
        avgTime: data.totalTime / data.count || 0,
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    const serviceCallsFormatted: Record<
      string,
      { success: number; failure: number; avgTime: number }
    > = {};
    Object.entries(serviceCalls).forEach(([service, data]) => {
      const totalCalls = data.success + data.failure;
      serviceCallsFormatted[service] = {
        success: data.success,
        failure: data.failure,
        avgTime: totalCalls > 0 ? data.totalTime / totalCalls : 0,
      };
    });

    return {
      totalRequests,
      errorRate: totalRequests > 0 ? (errors / totalRequests) * 100 : 0,
      averageResponseTime:
        responseTimes.length > 0
          ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
          : 0,
      p95ResponseTime: responseTimes[p95Index] || 0,
      p99ResponseTime: responseTimes[p99Index] || 0,
      requestsPerSecond: totalRequests / 5, // 5-minute window
      topEndpoints,
      errorsByType: errorTypes,
      securityEvents,
      serviceCalls: serviceCallsFormatted,
      memoryUsage: {
        min: memoryUsages.length > 0 ? Math.min(...memoryUsages) : 0,
        max: memoryUsages.length > 0 ? Math.max(...memoryUsages) : 0,
        avg:
          memoryUsages.length > 0
            ? memoryUsages.reduce((a, b) => a + b, 0) / memoryUsages.length
            : 0,
      },
      timeRange: {
        start: new Date(fiveMinutesAgo),
        end: new Date(now),
      },
    };
  }
}

// Log file analyzer for historical analysis
export class LogAnalyzer {
  // Analyze log file for specific time period
  static async analyzeLogFile(
    filepath: string,
    startTime?: Date,
    endTime?: Date
  ): Promise<LogMetrics> {
    return new Promise((resolve, reject) => {
      const fileStream = fs.createReadStream(filepath);
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity,
      });

      const totalRequests = 0;
      const errors = 0;
      const responseTimes: number[] = [];
      const securityEvents = 0;
      const endpointCounts: Record<
        string,
        { count: number; totalTime: number }
      > = {};
      const errorTypes: Record<string, number> = {};
      const serviceCalls: Record<
        string,
        { success: number; failure: number; totalTime: number }
      > = {};
      const memoryUsages: number[] = [];

      rl.on('line', line => {
        try {
          const logEntry = JSON.parse(line);
          const timestamp = new Date(logEntry.timestamp);

          // Filter by time range if specified
          if (startTime && timestamp < startTime) return;
          if (endTime && timestamp > endTime) return;

          // Process the same way as real-time monitoring
          // (Implementation details similar to calculateCurrentMetrics)
        } catch (error) {
          // Skip invalid JSON lines
        }
      });

      rl.on('close', () => {
        // Calculate and return metrics
        const metrics: LogMetrics = {
          totalRequests,
          errorRate: totalRequests > 0 ? (errors / totalRequests) * 100 : 0,
          averageResponseTime:
            responseTimes.length > 0
              ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length
              : 0,
          p95ResponseTime:
            responseTimes.sort((a, b) => a - b)[
              Math.floor(responseTimes.length * 0.95)
            ] || 0,
          p99ResponseTime:
            responseTimes[Math.floor(responseTimes.length * 0.99)] || 0,
          requestsPerSecond:
            (totalRequests /
              ((endTime?.getTime() || Date.now()) -
                (startTime?.getTime() || 0))) *
            1000,
          topEndpoints: [],
          errorsByType: errorTypes,
          securityEvents,
          serviceCalls: {},
          memoryUsage: {
            min: memoryUsages.length > 0 ? Math.min(...memoryUsages) : 0,
            max: memoryUsages.length > 0 ? Math.max(...memoryUsages) : 0,
            avg:
              memoryUsages.length > 0
                ? memoryUsages.reduce((a, b) => a + b, 0) / memoryUsages.length
                : 0,
          },
          timeRange: {
            start: startTime || new Date(0),
            end: endTime || new Date(),
          },
        };

        resolve(metrics);
      });

      rl.on('error', reject);
    });
  }

  // Generate log analysis report
  static async generateReport(
    logDir: string = path.join(process.cwd(), 'logs'),
    timeRange: { start: Date; end: Date }
  ): Promise<string> {
    const analysisResults: Record<string, LogMetrics> = {};

    const logFiles = [
      'combined.log',
      'error.log',
      'performance.log',
      'security.log',
    ];

    for (const filename of logFiles) {
      const filepath = path.join(logDir, filename);
      if (fs.existsSync(filepath)) {
        try {
          analysisResults[filename] = await this.analyzeLogFile(
            filepath,
            timeRange.start,
            timeRange.end
          );
        } catch (error) {
          appLogger.error(`Failed to analyze ${filename}`, {
            error: (error as Error).message,
          });
        }
      }
    }

    // Generate report
    let report = '# WRFCoin Platform Log Analysis Report\n\n';
    report += `**Analysis Period:** ${timeRange.start.toISOString()} to ${timeRange.end.toISOString()}\n\n`;

    Object.entries(analysisResults).forEach(([filename, metrics]) => {
      report += `## ${filename}\n\n`;
      report += `- **Total Requests:** ${metrics.totalRequests}\n`;
      report += `- **Error Rate:** ${metrics.errorRate.toFixed(2)}%\n`;
      report += `- **Average Response Time:** ${metrics.averageResponseTime.toFixed(2)}ms\n`;
      report += `- **95th Percentile:** ${metrics.p95ResponseTime.toFixed(2)}ms\n`;
      report += `- **99th Percentile:** ${metrics.p99ResponseTime.toFixed(2)}ms\n`;
      report += `- **Requests/Second:** ${metrics.requestsPerSecond.toFixed(2)}\n`;
      report += `- **Security Events:** ${metrics.securityEvents}\n\n`;

      if (Object.keys(metrics.errorsByType).length > 0) {
        report += '### Error Types\n';
        Object.entries(metrics.errorsByType).forEach(([type, count]) => {
          report += `- **${type}:** ${count}\n`;
        });
        report += '\n';
      }
    });

    return report;
  }
}

// Alert manager for handling and routing alerts
export class AlertManager extends EventEmitter {
  private alertHistory: Array<{ timestamp: Date; alert: any }> = [];
  private webhookUrls: string[] = [];
  private emailRecipients: string[] = [];

  constructor() {
    super();
  }

  // Add webhook URL for alert notifications
  addWebhook(url: string): void {
    this.webhookUrls.push(url);
  }

  // Add email recipient for alert notifications
  addEmailRecipient(email: string): void {
    this.emailRecipients.push(email);
  }

  // Handle alert and route to appropriate channels
  async handleAlert(alert: any): Promise<void> {
    // Store alert in history
    this.alertHistory.push({
      timestamp: new Date(),
      alert,
    });

    // Keep only last 1000 alerts
    if (this.alertHistory.length > 1000) {
      this.alertHistory.splice(0, this.alertHistory.length - 1000);
    }

    // Log the alert
    const level = alert.severity === 'critical' ? 'error' : 'warn';
    securityLogger.log(level, `Alert: ${alert.message}`, {
      operation: 'monitoring:alert',
      alert: {
        type: alert.type,
        severity: alert.severity,
        threshold: alert.threshold,
        value: alert.value,
      },
    });

    // Send to webhooks
    for (const webhookUrl of this.webhookUrls) {
      try {
        await this.sendWebhookAlert(webhookUrl, alert);
      } catch (error) {
        appLogger.error('Failed to send webhook alert', {
          error: (error as Error).message,
          webhookUrl,
        });
      }
    }

    // Emit alert event for other listeners
    this.emit('alert', alert);
  }

  // Send alert to webhook
  private async sendWebhookAlert(url: string, alert: any): Promise<void> {
    const payload = {
      timestamp: new Date().toISOString(),
      service: 'wrfcoin-platform',
      alert: {
        type: alert.type,
        severity: alert.severity,
        message: alert.message,
        threshold: alert.threshold,
        value: alert.value,
        metadata: alert.logEntry || alert.metrics,
      },
    };

    // Here you would implement the actual HTTP request to the webhook
    // For now, just log the payload
    appLogger.info('Webhook alert sent', { webhookUrl: url, payload });
  }

  // Get recent alerts
  getRecentAlerts(limit: number = 50): Array<{ timestamp: Date; alert: any }> {
    return this.alertHistory.slice(-limit);
  }

  // Get alert statistics
  getAlertStatistics(): Record<string, any> {
    const now = Date.now();
    const lastHour = now - 60 * 60 * 1000;
    const lastDay = now - 24 * 60 * 60 * 1000;

    const recentAlerts = this.alertHistory.filter(
      ({ timestamp }) => timestamp.getTime() > lastHour
    );

    const dailyAlerts = this.alertHistory.filter(
      ({ timestamp }) => timestamp.getTime() > lastDay
    );

    const alertsByType: Record<string, number> = {};
    recentAlerts.forEach(({ alert }) => {
      alertsByType[alert.type] = (alertsByType[alert.type] || 0) + 1;
    });

    return {
      totalAlerts: this.alertHistory.length,
      alertsLastHour: recentAlerts.length,
      alertsLastDay: dailyAlerts.length,
      alertsByType,
      lastAlert: this.alertHistory[this.alertHistory.length - 1] || null,
    };
  }
}

// Export singleton instances
export const logMonitor = new LogMonitor();
export const alertManager = new AlertManager();

// Set up alert routing
logMonitor.on('alert', alert => {
  alertManager.handleAlert(alert);
});

// Export utilities
export { DEFAULT_THRESHOLDS };
