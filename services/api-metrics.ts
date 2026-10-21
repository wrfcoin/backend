/**
 * API Metrics Collection and Real-Time Broadcasting Service
 * Integrates with existing API key middleware and WebSocket infrastructure
 */

import { Request, Response } from 'express';
import { EventEmitter } from 'events';

interface ApiMetric {
  timestamp: number;
  endpoint: string;
  method: string;
  statusCode: number;
  responseTime: number;
  apiKeyId?: string;
  userAgent?: string;
  ipAddress?: string;
  errorType?: string;
  errorMessage?: string;
}

interface AggregatedMetrics {
  totalRequests: number;
  totalErrors: number;
  averageResponseTime: number;
  requestsPerSecond: number;
  errorRate: number;
  statusCodeDistribution: { [key: string]: number };
  endpointMetrics: { [endpoint: string]: EndpointMetric };
  timeSeriesData: TimeSeriesPoint[];
}

interface EndpointMetric {
  totalRequests: number;
  averageResponseTime: number;
  errorCount: number;
  errorRate: number;
  lastAccessed: number;
}

interface TimeSeriesPoint {
  timestamp: number;
  requests: number;
  errors: number;
  averageResponseTime: number;
}

interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  uptime: number;
  memoryUsage: NodeJS.MemoryUsage;
  cpuUsage?: number;
  activeConnections: number;
  responseTimeP95: number;
  errorRateThreshold: number;
}

class ApiMetricsService extends EventEmitter {
  /** #977: timer handles — previously discarded, so unclearable. */
  private aggregationTimer?: ReturnType<typeof setInterval>;
  private cleanupTimer?: ReturnType<typeof setInterval>;

  private metrics: ApiMetric[] = [];
  private aggregatedMetrics: AggregatedMetrics;
  private readonly MAX_METRICS_HISTORY = 10000; // Keep last 10k metrics in memory
  private readonly AGGREGATION_WINDOW = 60000; // 1 minute window
  private readonly PROMETHEUS_METRICS = new Map<string, number>();
  private startTime: number;
  private lastAggregation: number;

  constructor() {
    super();
    this.startTime = Date.now();
    this.lastAggregation = Date.now();
    this.aggregatedMetrics = this.initializeAggregatedMetrics();

    // Start periodic aggregation.
    // #977 ratchet: both handles are stored and unref'd — this runs from the
    // constructor behind a module-scope singleton, so importing the file
    // otherwise holds the event loop open.
    this.aggregationTimer = setInterval(() => {
      this.performAggregation();
    }, 10000); // Aggregate every 10 seconds
    this.aggregationTimer.unref();

    // Cleanup old metrics
    this.cleanupTimer = setInterval(() => {
      this.cleanupOldMetrics();
    }, 300000); // Cleanup every 5 minutes
    this.cleanupTimer.unref();
  }

  /**
   * Record a new API metric (called from middleware)
   */
  recordMetric(metric: ApiMetric): void {
    this.metrics.push(metric);
    this.updatePrometheusMetrics(metric);

    // Emit real-time metric event
    this.emit('metric', metric);

    // If metrics exceed threshold, perform immediate aggregation
    if (this.metrics.length > this.MAX_METRICS_HISTORY) {
      this.performAggregation();
    }
  }

  /**
   * Get current aggregated metrics
   */
  getAggregatedMetrics(): AggregatedMetrics {
    return { ...this.aggregatedMetrics };
  }

  /**
   * Get health status
   */
  getHealthStatus(): HealthStatus {
    const now = Date.now();
    const recentMetrics = this.metrics.filter(m => now - m.timestamp < 300000); // Last 5 minutes

    const totalRequests = recentMetrics.length;
    const errorCount = recentMetrics.filter(m => m.statusCode >= 400).length;
    const errorRate =
      totalRequests > 0 ? (errorCount / totalRequests) * 100 : 0;

    // Calculate P95 response time
    const responseTimes = recentMetrics
      .map(m => m.responseTime)
      .sort((a, b) => a - b);
    const p95Index = Math.floor(responseTimes.length * 0.95);
    const responseTimeP95 = responseTimes[p95Index] || 0;

    let status: 'healthy' | 'degraded' | 'unhealthy' = 'healthy';
    if (errorRate > 10 || responseTimeP95 > 5000) {
      status = 'unhealthy';
    } else if (errorRate > 5 || responseTimeP95 > 2000) {
      status = 'degraded';
    }

    return {
      status,
      uptime: now - this.startTime,
      memoryUsage: process.memoryUsage(),
      activeConnections: this.metrics.filter(m => now - m.timestamp < 60000)
        .length,
      responseTimeP95,
      errorRateThreshold: errorRate,
    };
  }

  /**
   * Get Prometheus-compatible metrics
   */
  getPrometheusMetrics(): string {
    const metrics: string[] = [];

    // API request counter
    metrics.push('# HELP api_requests_total Total number of API requests');
    metrics.push('# TYPE api_requests_total counter');
    for (const [key, value] of this.PROMETHEUS_METRICS.entries()) {
      if (key.startsWith('requests_total_')) {
        const labels = key.replace('requests_total_', '');
        metrics.push(`api_requests_total{${labels}} ${value}`);
      }
    }

    // Response time histogram
    metrics.push(
      '# HELP api_request_duration_seconds API request duration in seconds'
    );
    metrics.push('# TYPE api_request_duration_seconds histogram');
    const responseTimes = this.metrics.map(m => m.responseTime / 1000); // Convert to seconds
    const buckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
    let count = 0;
    for (const bucket of buckets) {
      count += responseTimes.filter(rt => rt <= bucket).length;
      metrics.push(
        `api_request_duration_seconds_bucket{le="${bucket}"} ${count}`
      );
    }
    metrics.push(
      `api_request_duration_seconds_bucket{le="+Inf"} ${responseTimes.length}`
    );
    metrics.push(
      `api_request_duration_seconds_sum ${responseTimes.reduce((a, b) => a + b, 0)}`
    );
    metrics.push(`api_request_duration_seconds_count ${responseTimes.length}`);

    // Current health status
    const health = this.getHealthStatus();
    metrics.push(
      '# HELP api_health_status Current API health status (0=unhealthy, 1=degraded, 2=healthy)'
    );
    metrics.push('# TYPE api_health_status gauge');
    const healthValue =
      health.status === 'healthy' ? 2 : health.status === 'degraded' ? 1 : 0;
    metrics.push(`api_health_status ${healthValue}`);

    // Memory usage
    metrics.push('# HELP api_memory_usage_bytes Memory usage in bytes');
    metrics.push('# TYPE api_memory_usage_bytes gauge');
    metrics.push(
      `api_memory_usage_bytes{type="rss"} ${health.memoryUsage.rss}`
    );
    metrics.push(
      `api_memory_usage_bytes{type="heapTotal"} ${health.memoryUsage.heapTotal}`
    );
    metrics.push(
      `api_memory_usage_bytes{type="heapUsed"} ${health.memoryUsage.heapUsed}`
    );

    return metrics.join('\n') + '\n';
  }

  /**
   * Get real-time metrics for WebSocket broadcasting
   */
  getRealTimeMetrics(): any {
    const now = Date.now();
    const lastMinute = this.metrics.filter(m => now - m.timestamp < 60000);
    const lastHour = this.metrics.filter(m => now - m.timestamp < 3600000);

    return {
      timestamp: now,
      current: {
        requestsPerMinute: lastMinute.length,
        averageResponseTime: this.calculateAverageResponseTime(lastMinute),
        errorRate: this.calculateErrorRate(lastMinute),
        activeEndpoints: new Set(lastMinute.map(m => m.endpoint)).size,
      },
      trend: {
        requestsGrowth: this.calculateGrowthRate('requests', lastHour),
        responseTimeGrowth: this.calculateGrowthRate('responseTime', lastHour),
        errorRateGrowth: this.calculateGrowthRate('errorRate', lastHour),
      },
      health: this.getHealthStatus(),
      topEndpoints: this.getTopEndpoints(lastHour),
      recentErrors: this.getRecentErrors(10),
    };
  }

  private initializeAggregatedMetrics(): AggregatedMetrics {
    return {
      totalRequests: 0,
      totalErrors: 0,
      averageResponseTime: 0,
      requestsPerSecond: 0,
      errorRate: 0,
      statusCodeDistribution: {},
      endpointMetrics: {},
      timeSeriesData: [],
    };
  }

  private performAggregation(): void {
    const now = Date.now();
    const windowStart = this.lastAggregation;
    const windowMetrics = this.metrics.filter(
      m => m.timestamp >= windowStart && m.timestamp < now
    );

    if (windowMetrics.length === 0) {
      this.lastAggregation = now;
      return;
    }

    // Update aggregated metrics
    this.aggregatedMetrics.totalRequests += windowMetrics.length;
    this.aggregatedMetrics.totalErrors += windowMetrics.filter(
      m => m.statusCode >= 400
    ).length;
    this.aggregatedMetrics.averageResponseTime =
      this.calculateAverageResponseTime(this.metrics);
    this.aggregatedMetrics.requestsPerSecond =
      this.metrics.length / ((now - this.startTime) / 1000);
    this.aggregatedMetrics.errorRate =
      (this.aggregatedMetrics.totalErrors /
        this.aggregatedMetrics.totalRequests) *
      100;

    // Update status code distribution
    windowMetrics.forEach(metric => {
      const statusCode = Math.floor(metric.statusCode / 100) * 100; // Group by status class
      this.aggregatedMetrics.statusCodeDistribution[statusCode] =
        (this.aggregatedMetrics.statusCodeDistribution[statusCode] || 0) + 1;
    });

    // Update endpoint metrics
    this.updateEndpointMetrics(windowMetrics);

    // Add time series point
    this.aggregatedMetrics.timeSeriesData.push({
      timestamp: now,
      requests: windowMetrics.length,
      errors: windowMetrics.filter(m => m.statusCode >= 400).length,
      averageResponseTime: this.calculateAverageResponseTime(windowMetrics),
    });

    // Keep only last 24 hours of time series data
    const cutoff = now - 86400000; // 24 hours
    this.aggregatedMetrics.timeSeriesData =
      this.aggregatedMetrics.timeSeriesData.filter(
        point => point.timestamp > cutoff
      );

    this.lastAggregation = now;

    // Emit aggregation complete event
    this.emit('aggregation', this.aggregatedMetrics);
  }

  private updateEndpointMetrics(metrics: ApiMetric[]): void {
    const endpointGroups = this.groupBy(metrics, 'endpoint');

    for (const [endpoint, endpointMetrics] of Object.entries(endpointGroups)) {
      const existing = this.aggregatedMetrics.endpointMetrics[endpoint] || {
        totalRequests: 0,
        averageResponseTime: 0,
        errorCount: 0,
        errorRate: 0,
        lastAccessed: 0,
      };

      const errorCount = endpointMetrics.filter(
        m => m.statusCode >= 400
      ).length;
      const totalRequests = existing.totalRequests + endpointMetrics.length;
      const totalErrors = existing.errorCount + errorCount;

      this.aggregatedMetrics.endpointMetrics[endpoint] = {
        totalRequests,
        averageResponseTime: this.calculateAverageResponseTime([
          ...endpointMetrics,
        ]),
        errorCount: totalErrors,
        errorRate: (totalErrors / totalRequests) * 100,
        lastAccessed: Math.max(
          ...endpointMetrics.map(m => m.timestamp),
          existing.lastAccessed
        ),
      };
    }
  }

  private updatePrometheusMetrics(metric: ApiMetric): void {
    // Increment request counter
    const requestKey = `requests_total_method="${metric.method}",status="${metric.statusCode}",endpoint="${metric.endpoint}"`;
    this.PROMETHEUS_METRICS.set(
      requestKey,
      (this.PROMETHEUS_METRICS.get(requestKey) || 0) + 1
    );

    // Update response time
    const responseTimeKey = `response_time_sum_endpoint="${metric.endpoint}"`;
    this.PROMETHEUS_METRICS.set(
      responseTimeKey,
      (this.PROMETHEUS_METRICS.get(responseTimeKey) || 0) + metric.responseTime
    );
  }

  private calculateAverageResponseTime(metrics: ApiMetric[]): number {
    if (metrics.length === 0) return 0;
    return metrics.reduce((sum, m) => sum + m.responseTime, 0) / metrics.length;
  }

  private calculateErrorRate(metrics: ApiMetric[]): number {
    if (metrics.length === 0) return 0;
    const errors = metrics.filter(m => m.statusCode >= 400).length;
    return (errors / metrics.length) * 100;
  }

  private calculateGrowthRate(metric: string, data: ApiMetric[]): number {
    // Simplified growth calculation - compare first and second half
    const midpoint = Math.floor(data.length / 2);
    const firstHalf = data.slice(0, midpoint);
    const secondHalf = data.slice(midpoint);

    if (firstHalf.length === 0 || secondHalf.length === 0) return 0;

    let firstValue: number, secondValue: number;

    switch (metric) {
      case 'requests':
        firstValue = firstHalf.length;
        secondValue = secondHalf.length;
        break;
      case 'responseTime':
        firstValue = this.calculateAverageResponseTime(firstHalf);
        secondValue = this.calculateAverageResponseTime(secondHalf);
        break;
      case 'errorRate':
        firstValue = this.calculateErrorRate(firstHalf);
        secondValue = this.calculateErrorRate(secondHalf);
        break;
      default:
        return 0;
    }

    if (firstValue === 0) return secondValue > 0 ? 100 : 0;
    return ((secondValue - firstValue) / firstValue) * 100;
  }

  private getTopEndpoints(
    metrics: ApiMetric[]
  ): Array<{
    endpoint: string;
    requests: number;
    averageResponseTime: number;
  }> {
    const endpointGroups = this.groupBy(metrics, 'endpoint');
    return Object.entries(endpointGroups)
      .map(([endpoint, endpointMetrics]) => ({
        endpoint,
        requests: endpointMetrics.length,
        averageResponseTime: this.calculateAverageResponseTime(endpointMetrics),
      }))
      .sort((a, b) => b.requests - a.requests)
      .slice(0, 10);
  }

  private getRecentErrors(
    limit: number
  ): Array<{
    timestamp: number;
    endpoint: string;
    statusCode: number;
    message?: string;
  }> {
    return this.metrics
      .filter(m => m.statusCode >= 400)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
      .map(m => ({
        timestamp: m.timestamp,
        endpoint: m.endpoint,
        statusCode: m.statusCode,
        message: m.errorMessage,
      }));
  }

  private groupBy<T, K extends keyof T>(
    array: T[],
    key: K
  ): { [key: string]: T[] } {
    return array.reduce(
      (groups, item) => {
        const group = String(item[key]);
        groups[group] = groups[group] || [];
        groups[group].push(item);
        return groups;
      },
      {} as { [key: string]: T[] }
    );
  }

  private cleanupOldMetrics(): void {
    const cutoff = Date.now() - 3600000; // Keep last hour in detailed metrics
    this.metrics = this.metrics.filter(m => m.timestamp > cutoff);
  }
}

// Singleton instance
export const apiMetricsService = new ApiMetricsService();

/**
 * Express middleware to collect API metrics
 */
export function collectApiMetrics() {
  return (req: Request, res: Response, next: Function) => {
    const startTime = Date.now();

    // Capture original send method
    const originalSend = res.send;

    res.send = function (body: any) {
      const endTime = Date.now();
      const responseTime = endTime - startTime;

      // Record metric
      apiMetricsService.recordMetric({
        timestamp: endTime,
        endpoint: req.route?.path || req.path,
        method: req.method,
        statusCode: res.statusCode,
        responseTime,
        apiKeyId: (req as any).apiKey?.id,
        userAgent: req.get('User-Agent'),
        ipAddress: req.ip || req.connection.remoteAddress,
        errorType: res.statusCode >= 400 ? 'HTTP_ERROR' : undefined,
        errorMessage: res.statusCode >= 400 ? res.statusMessage : undefined,
      });

      return originalSend.call(this, body);
    };

    next();
  };
}

export default apiMetricsService;
