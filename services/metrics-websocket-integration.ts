/**
 * Integration service between API metrics and WebSocket broadcasting
 * Provides real-time metrics broadcasting to connected clients
 */

import { apiMetricsService } from './api-metrics.js';
import { appLogger } from '../server/utils/logger.js';

// Import WebSocket functions (we'll handle the JS/TS interop)
const websocketServer = require('../server/websocket');

interface AlertConfig {
  errorRateThreshold: number;
  responseTimeThreshold: number;
  requestVolumeThreshold: number;
}

class MetricsWebSocketIntegration {
  private alertConfig: AlertConfig;
  private lastAlertTimestamps: Map<string, number> = new Map();
  private readonly ALERT_COOLDOWN = 300000; // 5 minutes cooldown between similar alerts

  constructor() {
    this.alertConfig = {
      errorRateThreshold: 5, // 5% error rate threshold
      responseTimeThreshold: 2000, // 2 second response time threshold
      requestVolumeThreshold: 1000, // 1000 requests per minute threshold
    };

    this.setupEventListeners();
    this.startRealTimeMetricsBroadcasting();
    this.startHealthMonitoring();
  }

  private setupEventListeners(): void {
    // Listen for new metrics and broadcast real-time updates
    apiMetricsService.on('metric', metric => {
      this.handleNewMetric(metric);
    });

    // Listen for aggregation complete and broadcast summary
    apiMetricsService.on('aggregation', aggregatedMetrics => {
      this.handleAggregationComplete(aggregatedMetrics);
    });
  }

  private handleNewMetric(metric: any): void {
    // Check for immediate alerts based on the new metric
    this.checkForAlerts(metric);

    // Broadcast high-priority events immediately
    if (metric.statusCode >= 500) {
      websocketServer.broadcastApiAlert(
        {
          type: 'SERVER_ERROR',
          message: `Server error on ${metric.endpoint}: ${metric.statusCode}`,
          endpoint: metric.endpoint,
          statusCode: metric.statusCode,
          responseTime: metric.responseTime,
          timestamp: metric.timestamp,
        },
        'SERVER_ERROR_ALERT'
      );
    }

    if (metric.responseTime > 10000) {
      // 10+ second response time
      websocketServer.broadcastApiAlert(
        {
          type: 'SLOW_RESPONSE',
          message: `Extremely slow response on ${metric.endpoint}: ${metric.responseTime}ms`,
          endpoint: metric.endpoint,
          responseTime: metric.responseTime,
          timestamp: metric.timestamp,
        },
        'SLOW_RESPONSE_ALERT'
      );
    }
  }

  private handleAggregationComplete(aggregatedMetrics: any): void {
    // Broadcast aggregated metrics summary
    websocketServer.broadcastApiMetrics(
      {
        aggregated: true,
        ...aggregatedMetrics,
      },
      'AGGREGATED_METRICS_UPDATE'
    );
  }

  private startRealTimeMetricsBroadcasting(): void {
    // Broadcast real-time metrics every 5 seconds
    // #977 ratchet: unref'd — reached at import; the handle was discarded.
    const importTimeTimer104 = setInterval(() => {
      const realTimeMetrics = apiMetricsService.getRealTimeMetrics();
      websocketServer.broadcastApiMetrics(realTimeMetrics, 'REAL_TIME_METRICS');
    }, 5000);
    importTimeTimer104.unref();
  }

  private startHealthMonitoring(): void {
    // Monitor health and broadcast updates every 30 seconds
    // #977 ratchet: unref'd — reached at import; the handle was discarded.
    const importTimeTimer103 = setInterval(() => {
      const healthStatus = apiMetricsService.getHealthStatus();
      websocketServer.broadcastApiHealth(healthStatus, 'HEALTH_STATUS_UPDATE');

      // Check for health-based alerts
      this.checkHealthAlerts(healthStatus);
    }, 30000);
    importTimeTimer103.unref();
  }

  private checkForAlerts(metric: any): void {
    const now = Date.now();
    const recentMetrics = this.getRecentMetrics(60000); // Last minute

    // Check error rate
    const errorRate = this.calculateErrorRate(recentMetrics);
    if (errorRate > this.alertConfig.errorRateThreshold) {
      this.sendAlert(
        'HIGH_ERROR_RATE',
        `Error rate is ${errorRate.toFixed(1)}% (threshold: ${this.alertConfig.errorRateThreshold}%)`,
        { errorRate, threshold: this.alertConfig.errorRateThreshold }
      );
    }

    // Check average response time
    const avgResponseTime = this.calculateAverageResponseTime(recentMetrics);
    if (avgResponseTime > this.alertConfig.responseTimeThreshold) {
      this.sendAlert(
        'HIGH_RESPONSE_TIME',
        `Average response time is ${avgResponseTime.toFixed(0)}ms (threshold: ${this.alertConfig.responseTimeThreshold}ms)`,
        {
          responseTime: avgResponseTime,
          threshold: this.alertConfig.responseTimeThreshold,
        }
      );
    }

    // Check request volume
    if (recentMetrics.length > this.alertConfig.requestVolumeThreshold) {
      this.sendAlert(
        'HIGH_REQUEST_VOLUME',
        `Request volume is ${recentMetrics.length}/min (threshold: ${this.alertConfig.requestVolumeThreshold}/min)`,
        {
          requestVolume: recentMetrics.length,
          threshold: this.alertConfig.requestVolumeThreshold,
        }
      );
    }
  }

  private checkHealthAlerts(healthStatus: any): void {
    if (healthStatus.status === 'unhealthy') {
      this.sendAlert(
        'UNHEALTHY_STATUS',
        `API status is unhealthy. Error rate: ${healthStatus.errorRateThreshold.toFixed(1)}%, P95 response time: ${healthStatus.responseTimeP95}ms`,
        { healthStatus }
      );
    } else if (healthStatus.status === 'degraded') {
      this.sendAlert(
        'DEGRADED_STATUS',
        `API status is degraded. Error rate: ${healthStatus.errorRateThreshold.toFixed(1)}%, P95 response time: ${healthStatus.responseTimeP95}ms`,
        { healthStatus }
      );
    }

    // Memory usage alert
    const memoryUsagePercent =
      (healthStatus.memoryUsage.heapUsed / healthStatus.memoryUsage.heapTotal) *
      100;
    if (memoryUsagePercent > 85) {
      this.sendAlert(
        'HIGH_MEMORY_USAGE',
        `Memory usage is ${memoryUsagePercent.toFixed(1)}%`,
        {
          memoryUsage: healthStatus.memoryUsage,
          usagePercent: memoryUsagePercent,
        }
      );
    }
  }

  private sendAlert(type: string, message: string, data?: any): void {
    const now = Date.now();
    const lastAlert = this.lastAlertTimestamps.get(type);

    // Check cooldown
    if (lastAlert && now - lastAlert < this.ALERT_COOLDOWN) {
      return; // Skip alert due to cooldown
    }

    this.lastAlertTimestamps.set(type, now);

    websocketServer.broadcastApiAlert(
      {
        type,
        message,
        timestamp: now,
        severity: this.getAlertSeverity(type),
        data,
      },
      'API_ALERT'
    );

    // Also log the alert
    appLogger.warn('API Alert triggered', { alertType: type, message });
  }

  private getAlertSeverity(
    type: string
  ): 'low' | 'medium' | 'high' | 'critical' {
    switch (type) {
      case 'SERVER_ERROR':
      case 'UNHEALTHY_STATUS':
        return 'critical';
      case 'HIGH_ERROR_RATE':
      case 'DEGRADED_STATUS':
      case 'HIGH_MEMORY_USAGE':
        return 'high';
      case 'HIGH_RESPONSE_TIME':
      case 'SLOW_RESPONSE':
        return 'medium';
      case 'HIGH_REQUEST_VOLUME':
        return 'low';
      default:
        return 'medium';
    }
  }

  private getRecentMetrics(windowMs: number): any[] {
    // This would ideally call apiMetricsService.getMetricsInWindow()
    // For now, we'll simulate with a simple approach
    const allMetrics = apiMetricsService.getAggregatedMetrics();
    const now = Date.now();

    // Filter time series data to the recent window
    return allMetrics.timeSeriesData.filter(
      point => now - point.timestamp <= windowMs
    );
  }

  private calculateErrorRate(metrics: any[]): number {
    if (metrics.length === 0) return 0;
    const errors = metrics.reduce((sum, point) => sum + point.errors, 0);
    const total = metrics.reduce((sum, point) => sum + point.requests, 0);
    return total > 0 ? (errors / total) * 100 : 0;
  }

  private calculateAverageResponseTime(metrics: any[]): number {
    if (metrics.length === 0) return 0;
    const totalResponseTime = metrics.reduce(
      (sum, point) => sum + point.averageResponseTime * point.requests,
      0
    );
    const totalRequests = metrics.reduce(
      (sum, point) => sum + point.requests,
      0
    );
    return totalRequests > 0 ? totalResponseTime / totalRequests : 0;
  }

  /**
   * Update alert configuration
   */
  updateAlertConfig(config: Partial<AlertConfig>): void {
    this.alertConfig = { ...this.alertConfig, ...config };
    appLogger.info('Updated API monitoring alert configuration', { alertConfig: this.alertConfig });
  }

  /**
   * Get current alert configuration
   */
  getAlertConfig(): AlertConfig {
    return { ...this.alertConfig };
  }

  /**
   * Manually trigger a metrics broadcast
   */
  broadcastCurrentMetrics(): void {
    const realTimeMetrics = apiMetricsService.getRealTimeMetrics();
    const aggregatedMetrics = apiMetricsService.getAggregatedMetrics();
    const healthStatus = apiMetricsService.getHealthStatus();

    websocketServer.broadcastApiMetrics(realTimeMetrics, 'REAL_TIME_METRICS');
    websocketServer.broadcastApiMetrics(
      aggregatedMetrics,
      'AGGREGATED_METRICS_UPDATE'
    );
    websocketServer.broadcastApiHealth(healthStatus, 'HEALTH_STATUS_UPDATE');
  }

  /**
   * Get metrics broadcast statistics
   */
  getBroadcastStats(): any {
    return {
      totalAlertsToday: this.lastAlertTimestamps.size,
      lastAlertTimestamps: Object.fromEntries(this.lastAlertTimestamps),
      alertConfig: this.alertConfig,
      connectedClients: websocketServer.CHANNELS?.API_MONITORING || 0,
    };
  }
}

// Singleton instance
export const metricsWebSocketIntegration = new MetricsWebSocketIntegration();

export default metricsWebSocketIntegration;
