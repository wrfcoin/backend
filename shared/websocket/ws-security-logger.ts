/**
 * WebSocket Security Logger
 * Task 74: Prometheus metrics and audit logging for WebSocket security events
 *
 * Integrates with existing monitoring infrastructure in infra/monitoring/
 */

import {
  SecurityEvent,
  SecurityEventType,
  WebSocketChannel,
  WebSocketErrorCode,
  UserRole,
} from './types.js';
import { appLogger } from '../../server/utils/logger.js';

/**
 * Prometheus metric names for WebSocket security
 */
const METRICS = {
  // Connection metrics
  CONNECTIONS_TOTAL: 'wrfcoin_ws_connections_total',
  ACTIVE_CONNECTIONS: 'wrfcoin_ws_active_connections',

  // Authentication metrics
  AUTH_ATTEMPTS_TOTAL: 'wrfcoin_ws_auth_attempts_total',

  // Message metrics
  MESSAGES_TOTAL: 'wrfcoin_ws_messages_total',

  // Rate limiting metrics
  RATE_LIMIT_HITS_TOTAL: 'wrfcoin_ws_rate_limit_hits_total',

  // Channel authorization metrics
  CHANNEL_AUTH_FAILURES_TOTAL: 'wrfcoin_ws_channel_auth_failures_total',

  // Session metrics
  SESSION_DURATION_SECONDS: 'wrfcoin_ws_session_duration_seconds',
};

/**
 * In-memory metrics store
 * In production, this would be replaced with prom-client or similar
 */
interface MetricValue {
  value: number;
  labels: Record<string, string>;
}

/**
 * WebSocket Security Logger
 * Provides security event logging and Prometheus metrics
 */
export class WebSocketSecurityLogger {
  private metrics: Map<string, MetricValue[]>;
  private eventBuffer: SecurityEvent[];
  private flushInterval: ReturnType<typeof setInterval> | null;
  private maxBufferSize: number;
  private flushIntervalMs: number;
  private onFlush?: (events: SecurityEvent[]) => Promise<void>;

  constructor(options: {
    maxBufferSize?: number;
    flushIntervalMs?: number;
    onFlush?: (events: SecurityEvent[]) => Promise<void>;
  } = {}) {
    this.metrics = new Map();
    this.eventBuffer = [];
    this.maxBufferSize = options.maxBufferSize || 1000;
    this.flushIntervalMs = options.flushIntervalMs || 10000; // 10 seconds
    this.onFlush = options.onFlush;
    this.flushInterval = null;

    // Initialize counters
    this.initializeMetrics();

    // Start flush interval if callback provided
    if (this.onFlush) {
      this.startFlushInterval();
    }
  }

  /**
   * Initialize all metric counters
   */
  private initializeMetrics(): void {
    for (const metricName of Object.values(METRICS)) {
      this.metrics.set(metricName, []);
    }
  }

  /**
   * Log a security event
   */
  logEvent(event: Omit<SecurityEvent, 'timestamp'>): void {
    const fullEvent: SecurityEvent = {
      ...event,
      timestamp: new Date(),
    };

    // Update metrics based on event type
    this.updateMetrics(fullEvent);

    // Add to buffer
    this.eventBuffer.push(fullEvent);

    // Flush if buffer is full
    if (this.eventBuffer.length >= this.maxBufferSize) {
      this.flush();
    }

    // Console log for development
    if (process.env.NODE_ENV !== 'production') {
      this.logToConsole(fullEvent);
    }
  }

  /**
   * Update Prometheus-style metrics based on event
   */
  private updateMetrics(event: SecurityEvent): void {
    switch (event.type) {
    case 'connection_attempt':
      this.incrementCounter(METRICS.CONNECTIONS_TOTAL, {
        status: 'attempt',
      });
      break;

    case 'connection_success':
      this.incrementCounter(METRICS.CONNECTIONS_TOTAL, {
        status: 'success',
        role: (event.details?.role as string) || 'unknown',
      });
      this.incrementGauge(METRICS.ACTIVE_CONNECTIONS, {
        role: (event.details?.role as string) || 'unknown',
      });
      break;

    case 'connection_rejected':
      this.incrementCounter(METRICS.CONNECTIONS_TOTAL, {
        status: 'rejected',
        reason: event.errorCode || 'unknown',
      });
      break;

    case 'auth_success':
      this.incrementCounter(METRICS.AUTH_ATTEMPTS_TOTAL, {
        result: 'success',
      });
      break;

    case 'auth_failure':
      this.incrementCounter(METRICS.AUTH_ATTEMPTS_TOTAL, {
        result: 'failure',
        error_code: event.errorCode || 'unknown',
      });
      break;

    case 'channel_subscribe':
      this.incrementCounter(METRICS.MESSAGES_TOTAL, {
        direction: 'inbound',
        channel: event.channel || 'unknown',
        type: 'subscribe',
      });
      break;

    case 'channel_subscribe_denied':
      this.incrementCounter(METRICS.CHANNEL_AUTH_FAILURES_TOTAL, {
        channel: event.channel || 'unknown',
        reason: (event.details?.reason as string) || 'unknown',
      });
      break;

    case 'rate_limit_hit':
      this.incrementCounter(METRICS.RATE_LIMIT_HITS_TOTAL, {
        type: (event.details?.limitType as string) || 'message',
        channel: event.channel || 'global',
      });
      break;

    case 'ip_blocked':
      this.incrementCounter(METRICS.RATE_LIMIT_HITS_TOTAL, {
        type: 'ip_blocked',
        channel: 'global',
      });
      break;

    case 'session_destroyed':
      this.decrementGauge(METRICS.ACTIVE_CONNECTIONS, {
        role: (event.details?.role as string) || 'unknown',
      });

      // Record session duration
      if (event.details?.duration) {
        this.recordHistogram(METRICS.SESSION_DURATION_SECONDS, event.details.duration as number, {
          role: (event.details?.role as string) || 'unknown',
        });
      }
      break;

    case 'message_received':
      this.incrementCounter(METRICS.MESSAGES_TOTAL, {
        direction: 'inbound',
        channel: event.channel || 'global',
        type: (event.details?.messageType as string) || 'unknown',
      });
      break;

    case 'message_sent':
      this.incrementCounter(METRICS.MESSAGES_TOTAL, {
        direction: 'outbound',
        channel: event.channel || 'global',
        type: (event.details?.messageType as string) || 'unknown',
      });
      break;
    }
  }

  /**
   * Increment a counter metric
   */
  private incrementCounter(name: string, labels: Record<string, string>): void {
    const metrics = this.metrics.get(name) || [];
    const existing = metrics.find((m) => this.labelsMatch(m.labels, labels));

    if (existing) {
      existing.value++;
    } else {
      metrics.push({ value: 1, labels });
      this.metrics.set(name, metrics);
    }
  }

  /**
   * Increment a gauge metric
   */
  private incrementGauge(name: string, labels: Record<string, string>): void {
    this.incrementCounter(name, labels);
  }

  /**
   * Decrement a gauge metric
   */
  private decrementGauge(name: string, labels: Record<string, string>): void {
    const metrics = this.metrics.get(name) || [];
    const existing = metrics.find((m) => this.labelsMatch(m.labels, labels));

    if (existing) {
      existing.value = Math.max(0, existing.value - 1);
    }
  }

  /**
   * Record a histogram value
   */
  private recordHistogram(
    _name: string,
    _value: number,
    _labels: Record<string, string>,
  ): void {
    // In a real implementation, this would bucket values
    // For now, we just store the raw values
  }

  /**
   * Check if two label sets match
   */
  private labelsMatch(
    a: Record<string, string>,
    b: Record<string, string>,
  ): boolean {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);

    if (keysA.length !== keysB.length) return false;

    return keysA.every((key) => a[key] === b[key]);
  }

  /**
   * Log event to console in development
   */
  private logToConsole(event: SecurityEvent): void {
    const severityColors: Record<string, string> = {
      connection_attempt: '\x1b[34m', // Blue
      connection_success: '\x1b[32m', // Green
      connection_rejected: '\x1b[31m', // Red
      auth_failure: '\x1b[31m', // Red
      auth_success: '\x1b[32m', // Green
      channel_subscribe: '\x1b[36m', // Cyan
      channel_subscribe_denied: '\x1b[33m', // Yellow
      rate_limit_hit: '\x1b[33m', // Yellow
      ip_blocked: '\x1b[31m', // Red
      session_created: '\x1b[32m', // Green
      session_destroyed: '\x1b[34m', // Blue
      token_refresh: '\x1b[36m', // Cyan
      message_received: '\x1b[90m', // Gray
      message_sent: '\x1b[90m', // Gray
    };

    const reset = '\x1b[0m';
    const color = severityColors[event.type] || '\x1b[0m';

    appLogger.info('Security event', {
      module: 'WSSecurityLogger',
      eventType: event.type,
      connectionId: event.connectionId,
      userId: event.userId,
      channel: event.channel,
      errorCode: event.errorCode,
      details: event.details,
    });
  }

  /**
   * Start periodic flush interval
   */
  private startFlushInterval(): void {
    this.flushInterval = setInterval(() => {
      if (this.eventBuffer.length > 0) {
        this.flush();
      }
    }, this.flushIntervalMs);
  }

  /**
   * Flush event buffer
   */
  async flush(): Promise<void> {
    if (this.eventBuffer.length === 0) return;

    const eventsToFlush = [...this.eventBuffer];
    this.eventBuffer = [];

    if (this.onFlush) {
      try {
        await this.onFlush(eventsToFlush);
      } catch (error) {
        appLogger.error('Failed to flush events', { module: 'WSSecurityLogger', error: error instanceof Error ? error.message : String(error) });
        // Re-add events to buffer on failure (up to max size)
        this.eventBuffer = [
          ...eventsToFlush.slice(0, this.maxBufferSize - this.eventBuffer.length),
          ...this.eventBuffer,
        ];
      }
    }
  }

  /**
   * Get Prometheus-formatted metrics
   */
  getPrometheusMetrics(): string {
    const lines: string[] = [];

    for (const [metricName, values] of Array.from(this.metrics.entries())) {
      // Add HELP and TYPE comments
      lines.push(`# HELP ${metricName} WebSocket security metric`);
      lines.push(`# TYPE ${metricName} counter`);

      for (const { value, labels } of values) {
        const labelStr = Object.entries(labels)
          .map(([k, v]) => `${k}="${v}"`)
          .join(',');

        lines.push(`${metricName}{${labelStr}} ${value}`);
      }

      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Get metrics summary as JSON
   */
  getMetricsSummary(): Record<string, MetricValue[]> {
    const summary: Record<string, MetricValue[]> = {};

    for (const [name, values] of Array.from(this.metrics.entries())) {
      summary[name] = values;
    }

    return summary;
  }

  /**
   * Get active connection count by role
   */
  getActiveConnectionsByRole(): Record<UserRole, number> {
    const result: Record<UserRole, number> = {
      guest: 0,
      user: 0,
      operator: 0,
      admin: 0,
      super_admin: 0,
    };

    const activeMetrics = this.metrics.get(METRICS.ACTIVE_CONNECTIONS) || [];

    for (const metric of activeMetrics) {
      const role = metric.labels.role as UserRole;
      if (role && role in result) {
        result[role] = metric.value;
      }
    }

    return result;
  }

  /**
   * Get total connection count
   */
  getTotalConnections(): number {
    const activeMetrics = this.metrics.get(METRICS.ACTIVE_CONNECTIONS) || [];
    return activeMetrics.reduce((sum, m) => sum + m.value, 0);
  }

  /**
   * Get authentication failure rate (last hour approximation)
   */
  getAuthFailureRate(): { total: number; failures: number; rate: number } {
    const authMetrics = this.metrics.get(METRICS.AUTH_ATTEMPTS_TOTAL) || [];

    let total = 0;
    let failures = 0;

    for (const metric of authMetrics) {
      total += metric.value;
      if (metric.labels.result === 'failure') {
        failures += metric.value;
      }
    }

    return {
      total,
      failures,
      rate: total > 0 ? failures / total : 0,
    };
  }

  /**
   * Get rate limit statistics
   */
  getRateLimitStats(): {
    totalHits: number;
    byType: Record<string, number>;
    ipBlocked: number;
    } {
    const rateLimitMetrics = this.metrics.get(METRICS.RATE_LIMIT_HITS_TOTAL) || [];

    let totalHits = 0;
    let ipBlocked = 0;
    const byType: Record<string, number> = {};

    for (const metric of rateLimitMetrics) {
      totalHits += metric.value;

      const type = metric.labels.type;
      if (type === 'ip_blocked') {
        ipBlocked += metric.value;
      } else {
        byType[type] = (byType[type] || 0) + metric.value;
      }
    }

    return { totalHits, byType, ipBlocked };
  }

  /**
   * Get channel authorization failure stats
   */
  getChannelAuthFailures(): Record<WebSocketChannel, number> {
    const channelMetrics = this.metrics.get(METRICS.CHANNEL_AUTH_FAILURES_TOTAL) || [];

    const result: Record<string, number> = {};

    for (const metric of channelMetrics) {
      const channel = metric.labels.channel;
      result[channel] = (result[channel] || 0) + metric.value;
    }

    return result as Record<WebSocketChannel, number>;
  }

  /**
   * Log connection attempt
   */
  logConnectionAttempt(ipAddress: string, userAgent?: string): void {
    this.logEvent({
      type: 'connection_attempt',
      ipAddress,
      userAgent,
    });
  }

  /**
   * Log successful connection
   */
  logConnectionSuccess(
    connectionId: string,
    userId: string,
    role: UserRole,
    ipAddress: string,
    userAgent?: string,
  ): void {
    this.logEvent({
      type: 'connection_success',
      connectionId,
      userId,
      ipAddress,
      userAgent,
      details: { role },
    });
  }

  /**
   * Log rejected connection
   */
  logConnectionRejected(
    ipAddress: string,
    errorCode: WebSocketErrorCode,
    reason: string,
    userAgent?: string,
  ): void {
    this.logEvent({
      type: 'connection_rejected',
      ipAddress,
      userAgent,
      errorCode,
      details: { reason },
    });
  }

  /**
   * Log authentication success
   */
  logAuthSuccess(
    connectionId: string,
    userId: string,
    ipAddress: string,
  ): void {
    this.logEvent({
      type: 'auth_success',
      connectionId,
      userId,
      ipAddress,
    });
  }

  /**
   * Log authentication failure
   */
  logAuthFailure(
    ipAddress: string,
    errorCode: WebSocketErrorCode,
    reason: string,
    userAgent?: string,
  ): void {
    this.logEvent({
      type: 'auth_failure',
      ipAddress,
      userAgent,
      errorCode,
      details: { reason },
    });
  }

  /**
   * Log channel subscription
   */
  logChannelSubscribe(
    connectionId: string,
    userId: string,
    channel: WebSocketChannel,
    ipAddress: string,
  ): void {
    this.logEvent({
      type: 'channel_subscribe',
      connectionId,
      userId,
      channel,
      ipAddress,
    });
  }

  /**
   * Log channel subscription denied
   */
  logChannelSubscribeDenied(
    connectionId: string,
    userId: string,
    channel: WebSocketChannel,
    reason: string,
    ipAddress: string,
  ): void {
    this.logEvent({
      type: 'channel_subscribe_denied',
      connectionId,
      userId,
      channel,
      ipAddress,
      errorCode: 'CHANNEL_UNAUTHORIZED',
      details: { reason },
    });
  }

  /**
   * Log rate limit hit
   */
  logRateLimitHit(
    connectionId: string,
    userId: string | undefined,
    ipAddress: string,
    limitType: 'connection' | 'message' | 'burst',
    channel?: WebSocketChannel,
  ): void {
    this.logEvent({
      type: 'rate_limit_hit',
      connectionId,
      userId,
      channel,
      ipAddress,
      details: { limitType },
    });
  }

  /**
   * Log IP blocked
   */
  logIpBlocked(
    ipAddress: string,
    duration: number,
  ): void {
    this.logEvent({
      type: 'ip_blocked',
      ipAddress,
      details: { duration },
    });
  }

  /**
   * Log session created
   */
  logSessionCreated(
    connectionId: string,
    userId: string,
    role: UserRole,
    ipAddress: string,
  ): void {
    this.logEvent({
      type: 'session_created',
      connectionId,
      userId,
      ipAddress,
      details: { role },
    });
  }

  /**
   * Log session destroyed
   */
  logSessionDestroyed(
    connectionId: string,
    userId: string,
    role: UserRole,
    ipAddress: string,
    duration: number,
  ): void {
    this.logEvent({
      type: 'session_destroyed',
      connectionId,
      userId,
      ipAddress,
      details: { role, duration },
    });
  }

  /**
   * Log token refresh
   */
  logTokenRefresh(
    connectionId: string,
    userId: string,
    ipAddress: string,
  ): void {
    this.logEvent({
      type: 'token_refresh',
      connectionId,
      userId,
      ipAddress,
    });
  }

  /**
   * Log message received
   */
  logMessageReceived(
    connectionId: string,
    userId: string,
    channel: WebSocketChannel,
    messageType: string,
    ipAddress: string,
  ): void {
    this.logEvent({
      type: 'message_received',
      connectionId,
      userId,
      channel,
      ipAddress,
      details: { messageType },
    });
  }

  /**
   * Log message sent
   */
  logMessageSent(
    connectionId: string,
    userId: string,
    channel: WebSocketChannel,
    messageType: string,
    ipAddress: string,
  ): void {
    this.logEvent({
      type: 'message_sent',
      connectionId,
      userId,
      channel,
      ipAddress,
      details: { messageType },
    });
  }

  /**
   * Reset all metrics (for testing)
   */
  reset(): void {
    this.initializeMetrics();
    this.eventBuffer = [];
  }

  /**
   * Stop the logger
   */
  async stop(): Promise<void> {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }

    // Final flush
    await this.flush();
  }
}

/**
 * Singleton instance
 */
let defaultInstance: WebSocketSecurityLogger | null = null;

export function getWebSocketSecurityLogger(
  options?: {
    maxBufferSize?: number;
    flushIntervalMs?: number;
    onFlush?: (events: SecurityEvent[]) => Promise<void>;
  },
): WebSocketSecurityLogger {
  if (!defaultInstance || options) {
    defaultInstance = new WebSocketSecurityLogger(options);
  }
  return defaultInstance;
}

/**
 * Express middleware to expose Prometheus metrics
 */
export function prometheusMetricsMiddleware() {
  return (_req: any, res: any) => {
    const logger = getWebSocketSecurityLogger();
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(logger.getPrometheusMetrics());
  };
}
