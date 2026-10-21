/**
 * Database Activity Monitor Service
 * Task 104.10: Database Security Monitoring
 *
 * Provides real-time monitoring of database activity with:
 * - Query logging and analysis
 * - Baseline learning for normal patterns
 * - Anomaly detection and alerting
 * - Performance tracking
 * - Security event correlation
 */

import { appLogger } from '../utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface QueryLogEntry {
  id: string;
  query: string;
  queryHash: string;
  operation: 'SELECT' | 'INSERT' | 'UPDATE' | 'DELETE' | 'OTHER';
  table?: string;
  userId?: string;
  userRole?: string;
  ipAddress?: string;
  duration: number; // milliseconds
  rowsAffected?: number;
  success: boolean;
  error?: string;
  timestamp: Date;
  metadata?: Record<string, unknown>;
}

export interface BaselineMetrics {
  queryPatternFrequency: Map<string, number>;
  averageQueryDuration: Map<string, number>;
  peakQueriesPerMinute: number;
  averageQueriesPerMinute: number;
  operationDistribution: Record<string, number>;
  userActivityPatterns: Map<string, UserActivityPattern>;
  hourlyDistribution: number[];
  tableAccessPatterns: Map<string, TableAccessPattern>;
}

interface UserActivityPattern {
  userId: string;
  averageQueriesPerHour: number;
  commonOperations: string[];
  commonTables: string[];
  activeHours: number[];
  lastSeen: Date;
}

interface TableAccessPattern {
  tableName: string;
  readCount: number;
  writeCount: number;
  averageRowsAffected: number;
  peakAccessTime: number;
}

export interface AnomalyAlert {
  id: string;
  type: AnomalyType;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  details: Record<string, unknown>;
  timestamp: Date;
  acknowledged: boolean;
  resolvedAt?: Date;
}

type AnomalyType =
  | 'HIGH_QUERY_RATE'
  | 'SLOW_QUERY'
  | 'FAILED_QUERIES_SPIKE'
  | 'UNUSUAL_ACCESS_PATTERN'
  | 'PRIVILEGED_OPERATION'
  | 'BULK_DATA_ACCESS'
  | 'OFF_HOURS_ACTIVITY'
  | 'NEW_QUERY_PATTERN'
  | 'TABLE_SCAN_DETECTED'
  | 'CONNECTION_SPIKE';

interface MonitorConfig {
  enableRealTimeMonitoring: boolean;
  enableBaselineLearning: boolean;
  baselineLearningPeriodHours: number;
  alertThresholds: AlertThresholds;
  logRetentionHours: number;
  samplingRate: number; // 0-1, 1 = log all queries
}

interface AlertThresholds {
  failedQueriesPerMinute: number;
  slowQueryThresholdMs: number;
  slowQueriesPerMinute: number;
  queriesPerMinuteMultiplier: number;
  privilegedOperationsPerHour: number;
  bulkAccessRowThreshold: number;
  connectionSpikeMultiplier: number;
}

// ============================================================================
// Database Activity Monitor Service
// ============================================================================

export class DatabaseActivityMonitor {
  private queryLog: QueryLogEntry[] = [];
  private alerts: AnomalyAlert[] = [];
  private baseline: BaselineMetrics;
  private config: MonitorConfig;
  private isLearning: boolean = true;
  private learningStartTime: Date;
  private currentMinuteStats: {
    queries: number;
    failed: number;
    slow: number;
    timestamp: number;
  };

  constructor(config: Partial<MonitorConfig> = {}) {
    this.config = {
      enableRealTimeMonitoring: config.enableRealTimeMonitoring ?? true,
      enableBaselineLearning: config.enableBaselineLearning ?? true,
      baselineLearningPeriodHours: config.baselineLearningPeriodHours ?? 24,
      alertThresholds: {
        failedQueriesPerMinute: config.alertThresholds?.failedQueriesPerMinute ?? 50,
        slowQueryThresholdMs: config.alertThresholds?.slowQueryThresholdMs ?? 1000,
        slowQueriesPerMinute: config.alertThresholds?.slowQueriesPerMinute ?? 20,
        queriesPerMinuteMultiplier: config.alertThresholds?.queriesPerMinuteMultiplier ?? 3,
        privilegedOperationsPerHour: config.alertThresholds?.privilegedOperationsPerHour ?? 10,
        bulkAccessRowThreshold: config.alertThresholds?.bulkAccessRowThreshold ?? 10000,
        connectionSpikeMultiplier: config.alertThresholds?.connectionSpikeMultiplier ?? 2,
      },
      logRetentionHours: config.logRetentionHours ?? 24,
      samplingRate: config.samplingRate ?? 1,
    };

    this.baseline = this.initializeBaseline();
    this.learningStartTime = new Date();
    this.currentMinuteStats = {
      queries: 0,
      failed: 0,
      slow: 0,
      timestamp: Math.floor(Date.now() / 60000),
    };

    // Start periodic tasks
    this.startPeriodicTasks();
  }

  // ============================================================================
  // Query Logging
  // ============================================================================

  /**
   * Log a database query
   */
  logQuery(entry: Omit<QueryLogEntry, 'id' | 'queryHash' | 'timestamp'>): void {
    // Apply sampling rate
    if (Math.random() > this.config.samplingRate) {
      return;
    }

    const logEntry: QueryLogEntry = {
      ...entry,
      id: this.generateId(),
      queryHash: this.hashQuery(entry.query),
      timestamp: new Date(),
    };

    this.queryLog.push(logEntry);

    // Update current minute stats
    this.updateMinuteStats(logEntry);

    // Perform real-time analysis if enabled
    if (this.config.enableRealTimeMonitoring) {
      this.analyzeQuery(logEntry);
    }

    // Update baseline if learning
    if (this.config.enableBaselineLearning && this.isLearning) {
      this.updateBaseline(logEntry);
    }
  }

  /**
   * Update per-minute statistics
   */
  private updateMinuteStats(entry: QueryLogEntry): void {
    const currentMinute = Math.floor(Date.now() / 60000);

    if (currentMinute !== this.currentMinuteStats.timestamp) {
      // Check for anomalies in the completed minute
      this.checkMinuteAnomalies();

      // Reset for new minute
      this.currentMinuteStats = {
        queries: 0,
        failed: 0,
        slow: 0,
        timestamp: currentMinute,
      };
    }

    this.currentMinuteStats.queries++;
    if (!entry.success) {
      this.currentMinuteStats.failed++;
    }
    if (entry.duration > this.config.alertThresholds.slowQueryThresholdMs) {
      this.currentMinuteStats.slow++;
    }
  }

  /**
   * Check for anomalies in the completed minute
   */
  private checkMinuteAnomalies(): void {
    const stats = this.currentMinuteStats;

    // Check failed queries threshold
    if (stats.failed >= this.config.alertThresholds.failedQueriesPerMinute) {
      this.createAlert({
        type: 'FAILED_QUERIES_SPIKE',
        severity: stats.failed >= this.config.alertThresholds.failedQueriesPerMinute * 2 ? 'critical' : 'high',
        description: `High number of failed queries: ${stats.failed} in the last minute`,
        details: {
          failedCount: stats.failed,
          totalQueries: stats.queries,
          failureRate: (stats.failed / stats.queries * 100).toFixed(2) + '%',
        },
      });
    }

    // Check slow queries threshold
    if (stats.slow >= this.config.alertThresholds.slowQueriesPerMinute) {
      this.createAlert({
        type: 'SLOW_QUERY',
        severity: 'medium',
        description: `High number of slow queries: ${stats.slow} in the last minute`,
        details: {
          slowCount: stats.slow,
          threshold: this.config.alertThresholds.slowQueryThresholdMs,
        },
      });
    }

    // Check query rate anomaly
    if (!this.isLearning && this.baseline.averageQueriesPerMinute > 0) {
      const threshold = this.baseline.averageQueriesPerMinute * this.config.alertThresholds.queriesPerMinuteMultiplier;
      if (stats.queries > threshold) {
        this.createAlert({
          type: 'HIGH_QUERY_RATE',
          severity: stats.queries > threshold * 2 ? 'high' : 'medium',
          description: `Query rate ${stats.queries}/min exceeds baseline ${this.baseline.averageQueriesPerMinute}/min by ${this.config.alertThresholds.queriesPerMinuteMultiplier}x`,
          details: {
            currentRate: stats.queries,
            baselineRate: this.baseline.averageQueriesPerMinute,
            threshold,
          },
        });
      }
    }
  }

  // ============================================================================
  // Real-time Analysis
  // ============================================================================

  /**
   * Analyze a single query for anomalies
   */
  private analyzeQuery(entry: QueryLogEntry): void {
    // Check for slow query
    if (entry.duration > this.config.alertThresholds.slowQueryThresholdMs * 5) {
      this.createAlert({
        type: 'SLOW_QUERY',
        severity: entry.duration > this.config.alertThresholds.slowQueryThresholdMs * 10 ? 'high' : 'medium',
        description: `Very slow query detected: ${entry.duration}ms`,
        details: {
          duration: entry.duration,
          query: entry.query.substring(0, 200),
          table: entry.table,
          userId: entry.userId,
        },
      });
    }

    // Check for bulk data access
    if (entry.rowsAffected && entry.rowsAffected > this.config.alertThresholds.bulkAccessRowThreshold) {
      this.createAlert({
        type: 'BULK_DATA_ACCESS',
        severity: entry.operation === 'DELETE' ? 'critical' : 'high',
        description: `Bulk ${entry.operation} affecting ${entry.rowsAffected} rows`,
        details: {
          operation: entry.operation,
          rowsAffected: entry.rowsAffected,
          table: entry.table,
          userId: entry.userId,
          query: entry.query.substring(0, 200),
        },
      });
    }

    // Check for privileged operations
    if (this.isPrivilegedOperation(entry)) {
      this.createAlert({
        type: 'PRIVILEGED_OPERATION',
        severity: 'high',
        description: `Privileged database operation detected`,
        details: {
          operation: entry.operation,
          query: entry.query.substring(0, 200),
          userId: entry.userId,
          userRole: entry.userRole,
        },
      });
    }

    // Check for off-hours activity (if baseline established)
    if (!this.isLearning && this.isOffHoursActivity(entry)) {
      this.createAlert({
        type: 'OFF_HOURS_ACTIVITY',
        severity: 'medium',
        description: 'Database activity detected outside normal hours',
        details: {
          hour: new Date().getHours(),
          userId: entry.userId,
          operation: entry.operation,
        },
      });
    }

    // Check for new query patterns (after baseline period)
    if (!this.isLearning && this.isNewQueryPattern(entry)) {
      this.createAlert({
        type: 'NEW_QUERY_PATTERN',
        severity: 'low',
        description: 'Previously unseen query pattern detected',
        details: {
          queryHash: entry.queryHash,
          operation: entry.operation,
          table: entry.table,
        },
      });
    }
  }

  /**
   * Check if operation is privileged (DDL, GRANT, etc.)
   */
  private isPrivilegedOperation(entry: QueryLogEntry): boolean {
    const privilegedPatterns = [
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bALTER\b/i,
      /\bCREATE\b/i,
      /\bGRANT\b/i,
      /\bREVOKE\b/i,
      /\bVACUUM\b/i,
      /\bREINDEX\b/i,
    ];

    return privilegedPatterns.some((pattern) => pattern.test(entry.query));
  }

  /**
   * Check if activity is during off-hours
   */
  private isOffHoursActivity(entry: QueryLogEntry): boolean {
    const hour = new Date().getHours();
    const normalHours = this.baseline.hourlyDistribution;

    // Consider "off-hours" if this hour has less than 10% of peak activity
    const maxActivity = Math.max(...normalHours);
    const currentHourActivity = normalHours[hour] || 0;

    return currentHourActivity < maxActivity * 0.1;
  }

  /**
   * Check if query pattern is new
   */
  private isNewQueryPattern(entry: QueryLogEntry): boolean {
    return !this.baseline.queryPatternFrequency.has(entry.queryHash);
  }

  // ============================================================================
  // Baseline Learning
  // ============================================================================

  /**
   * Initialize empty baseline metrics
   */
  private initializeBaseline(): BaselineMetrics {
    return {
      queryPatternFrequency: new Map(),
      averageQueryDuration: new Map(),
      peakQueriesPerMinute: 0,
      averageQueriesPerMinute: 0,
      operationDistribution: {
        SELECT: 0,
        INSERT: 0,
        UPDATE: 0,
        DELETE: 0,
        OTHER: 0,
      },
      userActivityPatterns: new Map(),
      hourlyDistribution: new Array(24).fill(0),
      tableAccessPatterns: new Map(),
    };
  }

  /**
   * Update baseline with new query data
   */
  private updateBaseline(entry: QueryLogEntry): void {
    // Update query pattern frequency
    const currentFreq = this.baseline.queryPatternFrequency.get(entry.queryHash) || 0;
    this.baseline.queryPatternFrequency.set(entry.queryHash, currentFreq + 1);

    // Update average duration for this query pattern
    const currentDuration = this.baseline.averageQueryDuration.get(entry.queryHash) || entry.duration;
    const newDuration = (currentDuration + entry.duration) / 2;
    this.baseline.averageQueryDuration.set(entry.queryHash, newDuration);

    // Update operation distribution
    this.baseline.operationDistribution[entry.operation]++;

    // Update hourly distribution
    const hour = new Date().getHours();
    this.baseline.hourlyDistribution[hour]++;

    // Update user activity patterns
    if (entry.userId) {
      this.updateUserPattern(entry);
    }

    // Update table access patterns
    if (entry.table) {
      this.updateTablePattern(entry);
    }
  }

  /**
   * Update user activity pattern
   */
  private updateUserPattern(entry: QueryLogEntry): void {
    if (!entry.userId) return;

    const existing = this.baseline.userActivityPatterns.get(entry.userId);
    const hour = new Date().getHours();

    if (existing) {
      existing.averageQueriesPerHour++;
      if (!existing.commonOperations.includes(entry.operation)) {
        existing.commonOperations.push(entry.operation);
      }
      if (entry.table && !existing.commonTables.includes(entry.table)) {
        existing.commonTables.push(entry.table);
      }
      if (!existing.activeHours.includes(hour)) {
        existing.activeHours.push(hour);
      }
      existing.lastSeen = new Date();
    } else {
      this.baseline.userActivityPatterns.set(entry.userId, {
        userId: entry.userId,
        averageQueriesPerHour: 1,
        commonOperations: [entry.operation],
        commonTables: entry.table ? [entry.table] : [],
        activeHours: [hour],
        lastSeen: new Date(),
      });
    }
  }

  /**
   * Update table access pattern
   */
  private updateTablePattern(entry: QueryLogEntry): void {
    if (!entry.table) return;

    const existing = this.baseline.tableAccessPatterns.get(entry.table);

    if (existing) {
      if (entry.operation === 'SELECT') {
        existing.readCount++;
      } else {
        existing.writeCount++;
      }
      if (entry.rowsAffected) {
        existing.averageRowsAffected =
          (existing.averageRowsAffected + entry.rowsAffected) / 2;
      }
    } else {
      this.baseline.tableAccessPatterns.set(entry.table, {
        tableName: entry.table,
        readCount: entry.operation === 'SELECT' ? 1 : 0,
        writeCount: entry.operation !== 'SELECT' ? 1 : 0,
        averageRowsAffected: entry.rowsAffected || 0,
        peakAccessTime: new Date().getHours(),
      });
    }
  }

  /**
   * Finalize baseline after learning period
   */
  private finalizeBaseline(): void {
    const learningHours = this.config.baselineLearningPeriodHours;
    const totalMinutes = learningHours * 60;

    // Calculate average queries per minute
    const totalQueries = Array.from(this.baseline.queryPatternFrequency.values()).reduce(
      (sum, freq) => sum + freq,
      0
    );
    this.baseline.averageQueriesPerMinute = totalQueries / totalMinutes;

    // Calculate peak from hourly distribution
    const maxHourlyQueries = Math.max(...this.baseline.hourlyDistribution);
    this.baseline.peakQueriesPerMinute = maxHourlyQueries / 60;

    this.isLearning = false;
    appLogger.info('Baseline learning complete', {
      module: 'DatabaseActivityMonitor',
      operation: 'finalizeBaseline',
      averageQueriesPerMinute: this.baseline.averageQueriesPerMinute,
      peakQueriesPerMinute: this.baseline.peakQueriesPerMinute,
      uniqueQueryPatterns: this.baseline.queryPatternFrequency.size,
      uniqueUsers: this.baseline.userActivityPatterns.size,
      uniqueTables: this.baseline.tableAccessPatterns.size,
    });
  }

  // ============================================================================
  // Alert Management
  // ============================================================================

  /**
   * Create a new alert
   */
  private createAlert(params: {
    type: AnomalyType;
    severity: AnomalyAlert['severity'];
    description: string;
    details: Record<string, unknown>;
  }): void {
    const alert: AnomalyAlert = {
      id: this.generateId(),
      type: params.type,
      severity: params.severity,
      description: params.description,
      details: params.details,
      timestamp: new Date(),
      acknowledged: false,
    };

    this.alerts.push(alert);

    // Log alert
    if (params.severity === 'critical' || params.severity === 'high') {
      appLogger.error(`${params.type}: ${params.description}`, { module: 'DatabaseActivityMonitor', operation: 'createAlert', severity: params.severity, ...params.details });
    } else {
      appLogger.warn(`${params.type}: ${params.description}`, { module: 'DatabaseActivityMonitor', operation: 'createAlert', severity: params.severity, ...params.details });
    }

    // Limit alerts in memory
    if (this.alerts.length > 1000) {
      this.alerts = this.alerts.slice(-500);
    }
  }

  /**
   * Get active (unacknowledged) alerts
   */
  getActiveAlerts(): AnomalyAlert[] {
    return this.alerts.filter((a) => !a.acknowledged && !a.resolvedAt);
  }

  /**
   * Get alerts by severity
   */
  getAlertsBySeverity(severity: AnomalyAlert['severity']): AnomalyAlert[] {
    return this.alerts.filter((a) => a.severity === severity);
  }

  /**
   * Acknowledge an alert
   */
  acknowledgeAlert(alertId: string): boolean {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (alert) {
      alert.acknowledged = true;
      return true;
    }
    return false;
  }

  /**
   * Resolve an alert
   */
  resolveAlert(alertId: string): boolean {
    const alert = this.alerts.find((a) => a.id === alertId);
    if (alert) {
      alert.resolvedAt = new Date();
      return true;
    }
    return false;
  }

  // ============================================================================
  // Statistics and Reporting
  // ============================================================================

  /**
   * Get current monitoring statistics
   */
  getStats(): {
    isLearning: boolean;
    learningProgress: number;
    totalQueriesLogged: number;
    activeAlerts: number;
    queriesPerMinute: number;
    baseline: {
      averageQueriesPerMinute: number;
      peakQueriesPerMinute: number;
      uniquePatterns: number;
    };
  } {
    const learningElapsed = Date.now() - this.learningStartTime.getTime();
    const learningTotal = this.config.baselineLearningPeriodHours * 60 * 60 * 1000;

    return {
      isLearning: this.isLearning,
      learningProgress: Math.min(1, learningElapsed / learningTotal),
      totalQueriesLogged: this.queryLog.length,
      activeAlerts: this.getActiveAlerts().length,
      queriesPerMinute: this.currentMinuteStats.queries,
      baseline: {
        averageQueriesPerMinute: this.baseline.averageQueriesPerMinute,
        peakQueriesPerMinute: this.baseline.peakQueriesPerMinute,
        uniquePatterns: this.baseline.queryPatternFrequency.size,
      },
    };
  }

  /**
   * Get query statistics for a time range
   */
  getQueryStats(
    since: Date
  ): {
    totalQueries: number;
    successfulQueries: number;
    failedQueries: number;
    averageDuration: number;
    operationBreakdown: Record<string, number>;
    slowestQueries: QueryLogEntry[];
  } {
    const filtered = this.queryLog.filter((q) => q.timestamp >= since);

    const successful = filtered.filter((q) => q.success).length;
    const failed = filtered.length - successful;
    const avgDuration =
      filtered.reduce((sum, q) => sum + q.duration, 0) / filtered.length || 0;

    const operationBreakdown: Record<string, number> = {};
    for (const query of filtered) {
      operationBreakdown[query.operation] =
        (operationBreakdown[query.operation] || 0) + 1;
    }

    const slowest = [...filtered]
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 10);

    return {
      totalQueries: filtered.length,
      successfulQueries: successful,
      failedQueries: failed,
      averageDuration: avgDuration,
      operationBreakdown,
      slowestQueries: slowest,
    };
  }

  /**
   * Get recent query log entries
   */
  getRecentQueries(limit: number = 100): QueryLogEntry[] {
    return this.queryLog.slice(-limit);
  }

  // ============================================================================
  // Periodic Tasks
  // ============================================================================

  /**
   * Start periodic maintenance tasks
   */
  private startPeriodicTasks(): void {
    // Check learning status every minute
    setInterval(() => {
      if (this.isLearning) {
        const elapsed = Date.now() - this.learningStartTime.getTime();
        const learningPeriod = this.config.baselineLearningPeriodHours * 60 * 60 * 1000;

        if (elapsed >= learningPeriod) {
          this.finalizeBaseline();
        }
      }
    }, 60000);

    // Clean old log entries every hour
    setInterval(() => {
      this.cleanupOldEntries();
    }, 3600000);
  }

  /**
   * Remove old log entries
   */
  private cleanupOldEntries(): void {
    const cutoff = Date.now() - this.config.logRetentionHours * 60 * 60 * 1000;
    this.queryLog = this.queryLog.filter((q) => q.timestamp.getTime() > cutoff);
  }

  // ============================================================================
  // Utility Functions
  // ============================================================================

  /**
   * Generate unique ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Hash a query for pattern matching
   */
  private hashQuery(query: string): string {
    // Normalize query: remove literals, whitespace normalization
    const normalized = query
      .replace(/\s+/g, ' ')
      .replace(/'[^']*'/g, "'?'")
      .replace(/\d+/g, '?')
      .trim()
      .toLowerCase();

    // Simple hash
    let hash = 0;
    for (let i = 0; i < normalized.length; i++) {
      const char = normalized.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let instance: DatabaseActivityMonitor | null = null;

export function getDatabaseActivityMonitor(
  config?: Partial<MonitorConfig>
): DatabaseActivityMonitor {
  if (!instance) {
    instance = new DatabaseActivityMonitor(config);
  }
  return instance;
}

// ============================================================================
// Export
// ============================================================================

export default {
  DatabaseActivityMonitor,
  getDatabaseActivityMonitor,
};
