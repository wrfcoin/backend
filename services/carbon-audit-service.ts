/**
 * Carbon Credit Audit Service
 * Provides comprehensive audit logging for all carbon credit operations
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { logger } from '../utils/logger.js';

// Audit Event Types
export enum AuditEventType {
  // Credit Lifecycle
  CREDIT_ISSUED = 'CREDIT_ISSUED',
  CREDIT_TRANSFERRED = 'CREDIT_TRANSFERRED',
  CREDIT_RETIRED = 'CREDIT_RETIRED',
  CREDIT_BURNED = 'CREDIT_BURNED',

  // Marketplace
  CREDIT_LISTED = 'CREDIT_LISTED',
  CREDIT_DELISTED = 'CREDIT_DELISTED',
  CREDIT_PURCHASED = 'CREDIT_PURCHASED',
  ORDER_CREATED = 'ORDER_CREATED',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  ORDER_MATCHED = 'ORDER_MATCHED',
  TRADE_EXECUTED = 'TRADE_EXECUTED',
  TRADE_SETTLED = 'TRADE_SETTLED',

  // IoT/Sensor
  SENSOR_DATA_RECEIVED = 'SENSOR_DATA_RECEIVED',
  SENSOR_DATA_VALIDATED = 'SENSOR_DATA_VALIDATED',
  SENSOR_DATA_REJECTED = 'SENSOR_DATA_REJECTED',
  STATION_REGISTERED = 'STATION_REGISTERED',
  STATION_DEACTIVATED = 'STATION_DEACTIVATED',
  CREDITS_CALCULATED = 'CREDITS_CALCULATED',

  // Verification
  VERIFICATION_REQUESTED = 'VERIFICATION_REQUESTED',
  VERIFICATION_COMPLETED = 'VERIFICATION_COMPLETED',
  VERIFICATION_FAILED = 'VERIFICATION_FAILED',

  // Access & Security
  ACCESS_GRANTED = 'ACCESS_GRANTED',
  ACCESS_DENIED = 'ACCESS_DENIED',
  PERMISSION_CHANGED = 'PERMISSION_CHANGED',
  SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY',

  // Compliance
  COMPLIANCE_CHECK_PASSED = 'COMPLIANCE_CHECK_PASSED',
  COMPLIANCE_CHECK_FAILED = 'COMPLIANCE_CHECK_FAILED',
  REGULATORY_REPORT_GENERATED = 'REGULATORY_REPORT_GENERATED',
}

// Audit Severity
export enum AuditSeverity {
  DEBUG = 'DEBUG',
  INFO = 'INFO',
  WARNING = 'WARNING',
  ERROR = 'ERROR',
  CRITICAL = 'CRITICAL',
}

// Audit Event Structure
export interface AuditEvent {
  eventId: string;
  eventType: AuditEventType;
  severity: AuditSeverity;
  timestamp: Date;
  actor: {
    userId?: string;
    walletAddress?: string;
    systemComponent?: string;
    ipAddress?: string;
    userAgent?: string;
  };
  target: {
    resourceType: string;
    resourceId?: string;
    previousState?: any;
    newState?: any;
  };
  context: {
    transactionHash?: string;
    blockNumber?: number;
    chainId?: number;
    correlationId?: string;
    sessionId?: string;
  };
  details: Record<string, any>;
  outcome: 'SUCCESS' | 'FAILURE' | 'PENDING';
  integrityHash: string;
  previousEventHash?: string;
}

// Audit Query Options
export interface AuditQueryOptions {
  eventTypes?: AuditEventType[];
  startDate?: Date;
  endDate?: Date;
  actorUserId?: string;
  actorWalletAddress?: string;
  resourceType?: string;
  resourceId?: string;
  severity?: AuditSeverity[];
  outcome?: 'SUCCESS' | 'FAILURE' | 'PENDING';
  limit?: number;
  offset?: number;
  sortOrder?: 'asc' | 'desc';
}

// Audit Summary
export interface AuditSummary {
  period: {
    start: Date;
    end: Date;
  };
  totalEvents: number;
  eventsByType: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  eventsByOutcome: Record<string, number>;
  topActors: Array<{ actor: string; eventCount: number }>;
  anomalies: Array<{ description: string; severity: AuditSeverity; count: number }>;
  integrityStatus: 'VALID' | 'COMPROMISED' | 'UNKNOWN';
}

// Compliance Report
export interface ComplianceReport {
  reportId: string;
  generatedAt: Date;
  period: {
    start: Date;
    end: Date;
  };
  creditActivity: {
    issued: number;
    transferred: number;
    retired: number;
    totalValue: bigint;
  };
  verificationStatus: {
    total: number;
    passed: number;
    failed: number;
    pending: number;
  };
  marketplaceActivity: {
    trades: number;
    totalVolume: bigint;
    averagePrice: bigint;
  };
  securityEvents: {
    accessDenied: number;
    suspiciousActivity: number;
    complianceFailures: number;
  };
  recommendations: string[];
  signature: string;
}

/**
 * Carbon Credit Audit Service
 */
export class CarbonAuditService extends EventEmitter {
  // Audit log storage (in production, this would be a database)
  private auditLog: AuditEvent[] = [];

  // Last event hash for chain integrity
  private lastEventHash: string = '0x0000000000000000000000000000000000000000000000000000000000000000';

  // Event counters for anomaly detection
  private eventCounters: Map<string, Map<string, number>> = new Map();

  // Anomaly thresholds
  private readonly ANOMALY_THRESHOLDS = {
    failedAccessPerHour: 10,
    creditIssuancePerHour: 100,
    highValueTransfersPerHour: 20,
    rejectedSensorDataPerHour: 50,
  };

  constructor() {
    super();
    this.startAnomalyDetection();
  }

  /**
   * Log an audit event
   */
  async logEvent(
    eventType: AuditEventType,
    severity: AuditSeverity,
    actor: AuditEvent['actor'],
    target: AuditEvent['target'],
    context: AuditEvent['context'],
    details: Record<string, any>,
    outcome: AuditEvent['outcome']
  ): Promise<string> {
    const eventId = crypto.randomUUID();
    const timestamp = new Date();

    // Calculate integrity hash
    const integrityHash = this.calculateIntegrityHash({
      eventId,
      eventType,
      severity,
      timestamp: timestamp.toISOString(),
      actor,
      target,
      context,
      details,
      outcome,
      previousEventHash: this.lastEventHash,
    });

    const event: AuditEvent = {
      eventId,
      eventType,
      severity,
      timestamp,
      actor,
      target,
      context,
      details,
      outcome,
      integrityHash,
      previousEventHash: this.lastEventHash,
    };

    // Store event
    this.auditLog.push(event);
    this.lastEventHash = integrityHash;

    // Update counters for anomaly detection
    this.updateEventCounters(eventType, actor, outcome);

    // Check for anomalies
    await this.checkForAnomalies(event);

    // Keep only last 100000 events in memory
    if (this.auditLog.length > 100000) {
      this.auditLog = this.auditLog.slice(-100000);
    }

    // Emit event for real-time monitoring
    this.emit('auditEvent', event);

    // Log to structured logger
    logger.info('Audit event logged', {
      eventId,
      eventType,
      severity,
      outcome,
      actor: actor.userId || actor.walletAddress || actor.systemComponent,
    });

    return eventId;
  }

  /**
   * Log credit issuance
   */
  async logCreditIssued(
    issuerAddress: string,
    creditId: string,
    amount: bigint,
    metadata: Record<string, any>,
    transactionHash?: string
  ): Promise<string> {
    return this.logEvent(
      AuditEventType.CREDIT_ISSUED,
      AuditSeverity.INFO,
      { walletAddress: issuerAddress },
      { resourceType: 'carbon_credit', resourceId: creditId, newState: { amount: amount.toString() } },
      { transactionHash },
      { amount: amount.toString(), metadata },
      'SUCCESS'
    );
  }

  /**
   * Log credit transfer
   */
  async logCreditTransferred(
    fromAddress: string,
    toAddress: string,
    creditId: string,
    amount: bigint,
    transactionHash?: string
  ): Promise<string> {
    return this.logEvent(
      AuditEventType.CREDIT_TRANSFERRED,
      AuditSeverity.INFO,
      { walletAddress: fromAddress },
      {
        resourceType: 'carbon_credit',
        resourceId: creditId,
        previousState: { owner: fromAddress },
        newState: { owner: toAddress },
      },
      { transactionHash },
      { from: fromAddress, to: toAddress, amount: amount.toString() },
      'SUCCESS'
    );
  }

  /**
   * Log credit retirement
   */
  async logCreditRetired(
    ownerAddress: string,
    creditId: string,
    amount: bigint,
    reason: string,
    transactionHash?: string
  ): Promise<string> {
    return this.logEvent(
      AuditEventType.CREDIT_RETIRED,
      AuditSeverity.INFO,
      { walletAddress: ownerAddress },
      {
        resourceType: 'carbon_credit',
        resourceId: creditId,
        previousState: { status: 'active' },
        newState: { status: 'retired' },
      },
      { transactionHash },
      { amount: amount.toString(), reason },
      'SUCCESS'
    );
  }

  /**
   * Log trade execution
   */
  async logTradeExecuted(
    tradeId: string,
    buyerId: string,
    sellerId: string,
    creditType: string,
    quantity: bigint,
    price: bigint,
    transactionHash?: string
  ): Promise<string> {
    return this.logEvent(
      AuditEventType.TRADE_EXECUTED,
      AuditSeverity.INFO,
      { systemComponent: 'marketplace' },
      {
        resourceType: 'trade',
        resourceId: tradeId,
        newState: { status: 'executed' },
      },
      { transactionHash },
      {
        buyerId,
        sellerId,
        creditType,
        quantity: quantity.toString(),
        price: price.toString(),
        totalValue: (quantity * price).toString(),
      },
      'SUCCESS'
    );
  }

  /**
   * Log sensor data validation
   */
  async logSensorDataValidated(
    stationId: string,
    readingId: string,
    isValid: boolean,
    qualityScore: number,
    anomalyFlags: string[]
  ): Promise<string> {
    return this.logEvent(
      isValid ? AuditEventType.SENSOR_DATA_VALIDATED : AuditEventType.SENSOR_DATA_REJECTED,
      isValid ? AuditSeverity.DEBUG : AuditSeverity.WARNING,
      { systemComponent: 'iot-validation' },
      {
        resourceType: 'sensor_reading',
        resourceId: readingId,
        newState: { validated: isValid, qualityScore },
      },
      {},
      { stationId, qualityScore, anomalyFlags },
      isValid ? 'SUCCESS' : 'FAILURE'
    );
  }

  /**
   * Log access denied
   */
  async logAccessDenied(
    userId: string,
    resource: string,
    action: string,
    reason: string,
    ipAddress?: string
  ): Promise<string> {
    return this.logEvent(
      AuditEventType.ACCESS_DENIED,
      AuditSeverity.WARNING,
      { userId, ipAddress },
      { resourceType: resource },
      {},
      { action, reason },
      'FAILURE'
    );
  }

  /**
   * Log suspicious activity
   */
  async logSuspiciousActivity(
    actor: AuditEvent['actor'],
    activityType: string,
    details: Record<string, any>,
    severity: AuditSeverity = AuditSeverity.WARNING
  ): Promise<string> {
    return this.logEvent(
      AuditEventType.SUSPICIOUS_ACTIVITY,
      severity,
      actor,
      { resourceType: 'security' },
      {},
      { activityType, ...details },
      'PENDING'
    );
  }

  /**
   * Query audit log
   */
  async queryEvents(options: AuditQueryOptions): Promise<AuditEvent[]> {
    let events = [...this.auditLog];

    // Apply filters
    if (options.eventTypes && options.eventTypes.length > 0) {
      events = events.filter(e => options.eventTypes!.includes(e.eventType));
    }

    if (options.startDate) {
      events = events.filter(e => e.timestamp >= options.startDate!);
    }

    if (options.endDate) {
      events = events.filter(e => e.timestamp <= options.endDate!);
    }

    if (options.actorUserId) {
      events = events.filter(e => e.actor.userId === options.actorUserId);
    }

    if (options.actorWalletAddress) {
      events = events.filter(e =>
        e.actor.walletAddress?.toLowerCase() === options.actorWalletAddress?.toLowerCase()
      );
    }

    if (options.resourceType) {
      events = events.filter(e => e.target.resourceType === options.resourceType);
    }

    if (options.resourceId) {
      events = events.filter(e => e.target.resourceId === options.resourceId);
    }

    if (options.severity && options.severity.length > 0) {
      events = events.filter(e => options.severity!.includes(e.severity));
    }

    if (options.outcome) {
      events = events.filter(e => e.outcome === options.outcome);
    }

    // Sort
    events.sort((a, b) => {
      const order = options.sortOrder === 'asc' ? 1 : -1;
      return (a.timestamp.getTime() - b.timestamp.getTime()) * order;
    });

    // Pagination
    const offset = options.offset || 0;
    const limit = options.limit || 100;
    events = events.slice(offset, offset + limit);

    return events;
  }

  /**
   * Generate audit summary
   */
  async generateSummary(startDate: Date, endDate: Date): Promise<AuditSummary> {
    const events = await this.queryEvents({
      startDate,
      endDate,
      limit: Infinity,
    });

    // Calculate counts by type
    const eventsByType: Record<string, number> = {};
    const eventsBySeverity: Record<string, number> = {};
    const eventsByOutcome: Record<string, number> = {};
    const actorCounts: Map<string, number> = new Map();

    for (const event of events) {
      // By type
      eventsByType[event.eventType] = (eventsByType[event.eventType] || 0) + 1;

      // By severity
      eventsBySeverity[event.severity] = (eventsBySeverity[event.severity] || 0) + 1;

      // By outcome
      eventsByOutcome[event.outcome] = (eventsByOutcome[event.outcome] || 0) + 1;

      // Actor counts
      const actor = event.actor.userId || event.actor.walletAddress || event.actor.systemComponent || 'unknown';
      actorCounts.set(actor, (actorCounts.get(actor) || 0) + 1);
    }

    // Top actors
    const topActors = Array.from(actorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([actor, eventCount]) => ({ actor, eventCount }));

    // Detect anomalies
    const anomalies = this.detectAnomaliesInPeriod(events);

    // Verify integrity
    const integrityStatus = this.verifyChainIntegrity(events);

    return {
      period: { start: startDate, end: endDate },
      totalEvents: events.length,
      eventsByType,
      eventsBySeverity,
      eventsByOutcome,
      topActors,
      anomalies,
      integrityStatus,
    };
  }

  /**
   * Generate compliance report
   */
  async generateComplianceReport(startDate: Date, endDate: Date): Promise<ComplianceReport> {
    const events = await this.queryEvents({
      startDate,
      endDate,
      limit: Infinity,
    });

    // Calculate credit activity
    const creditIssued = events.filter(e => e.eventType === AuditEventType.CREDIT_ISSUED);
    const creditTransferred = events.filter(e => e.eventType === AuditEventType.CREDIT_TRANSFERRED);
    const creditRetired = events.filter(e => e.eventType === AuditEventType.CREDIT_RETIRED);

    let totalValue = 0n;
    for (const event of [...creditIssued, ...creditTransferred]) {
      if (event.details.amount) {
        totalValue += BigInt(event.details.amount);
      }
    }

    // Calculate verification status
    const verificationRequested = events.filter(e => e.eventType === AuditEventType.VERIFICATION_REQUESTED);
    const verificationCompleted = events.filter(e => e.eventType === AuditEventType.VERIFICATION_COMPLETED);
    const verificationFailed = events.filter(e => e.eventType === AuditEventType.VERIFICATION_FAILED);

    // Calculate marketplace activity
    const trades = events.filter(e => e.eventType === AuditEventType.TRADE_EXECUTED);
    let totalVolume = 0n;
    let totalPriceSum = 0n;
    for (const trade of trades) {
      if (trade.details.totalValue) {
        totalVolume += BigInt(trade.details.totalValue);
      }
      if (trade.details.price) {
        totalPriceSum += BigInt(trade.details.price);
      }
    }
    const averagePrice = trades.length > 0 ? totalPriceSum / BigInt(trades.length) : 0n;

    // Calculate security events
    const accessDenied = events.filter(e => e.eventType === AuditEventType.ACCESS_DENIED);
    const suspiciousActivity = events.filter(e => e.eventType === AuditEventType.SUSPICIOUS_ACTIVITY);
    const complianceFailures = events.filter(e => e.eventType === AuditEventType.COMPLIANCE_CHECK_FAILED);

    // Generate recommendations
    const recommendations: string[] = [];
    if (accessDenied.length > 100) {
      recommendations.push('High number of access denied events - review access control policies');
    }
    if (verificationFailed.length > verificationCompleted.length * 0.1) {
      recommendations.push('High verification failure rate - review verification criteria');
    }
    if (suspiciousActivity.length > 10) {
      recommendations.push('Suspicious activity detected - investigate flagged events');
    }

    // Create report
    const reportId = crypto.randomUUID();
    const report: ComplianceReport = {
      reportId,
      generatedAt: new Date(),
      period: { start: startDate, end: endDate },
      creditActivity: {
        issued: creditIssued.length,
        transferred: creditTransferred.length,
        retired: creditRetired.length,
        totalValue,
      },
      verificationStatus: {
        total: verificationRequested.length,
        passed: verificationCompleted.length,
        failed: verificationFailed.length,
        pending: verificationRequested.length - verificationCompleted.length - verificationFailed.length,
      },
      marketplaceActivity: {
        trades: trades.length,
        totalVolume,
        averagePrice,
      },
      securityEvents: {
        accessDenied: accessDenied.length,
        suspiciousActivity: suspiciousActivity.length,
        complianceFailures: complianceFailures.length,
      },
      recommendations,
      signature: this.signReport(reportId),
    };

    // Log report generation
    await this.logEvent(
      AuditEventType.REGULATORY_REPORT_GENERATED,
      AuditSeverity.INFO,
      { systemComponent: 'audit-service' },
      { resourceType: 'compliance_report', resourceId: reportId },
      {},
      { period: { start: startDate.toISOString(), end: endDate.toISOString() } },
      'SUCCESS'
    );

    return report;
  }

  /**
   * Verify audit chain integrity
   */
  verifyChainIntegrity(events?: AuditEvent[]): 'VALID' | 'COMPROMISED' | 'UNKNOWN' {
    const eventsToVerify = events || this.auditLog;

    if (eventsToVerify.length === 0) {
      return 'UNKNOWN';
    }

    let previousHash = '0x0000000000000000000000000000000000000000000000000000000000000000';

    for (const event of eventsToVerify) {
      // Verify previous hash link
      if (event.previousEventHash !== previousHash) {
        logger.error('Audit chain integrity violation detected', {
          eventId: event.eventId,
          expected: previousHash,
          actual: event.previousEventHash,
        });
        return 'COMPROMISED';
      }

      // Verify integrity hash
      const calculatedHash = this.calculateIntegrityHash({
        eventId: event.eventId,
        eventType: event.eventType,
        severity: event.severity,
        timestamp: event.timestamp.toISOString(),
        actor: event.actor,
        target: event.target,
        context: event.context,
        details: event.details,
        outcome: event.outcome,
        previousEventHash: event.previousEventHash,
      });

      if (calculatedHash !== event.integrityHash) {
        logger.error('Audit event integrity violation detected', {
          eventId: event.eventId,
          expected: calculatedHash,
          actual: event.integrityHash,
        });
        return 'COMPROMISED';
      }

      previousHash = event.integrityHash;
    }

    return 'VALID';
  }

  // ==================== Private Methods ====================

  /**
   * Calculate integrity hash
   */
  private calculateIntegrityHash(data: any): string {
    const input = JSON.stringify(data, Object.keys(data).sort());
    return ethers.keccak256(ethers.toUtf8Bytes(input));
  }

  /**
   * Sign report
   */
  private signReport(reportId: string): string {
    const input = `compliance_report:${reportId}:${Date.now()}`;
    return ethers.keccak256(ethers.toUtf8Bytes(input));
  }

  /**
   * Update event counters for anomaly detection
   */
  private updateEventCounters(
    eventType: AuditEventType,
    actor: AuditEvent['actor'],
    outcome: AuditEvent['outcome']
  ): void {
    const now = new Date();
    const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;

    let hourCounters = this.eventCounters.get(hourKey);
    if (!hourCounters) {
      hourCounters = new Map();
      this.eventCounters.set(hourKey, hourCounters);
    }

    // Count by event type
    const typeKey = `type:${eventType}`;
    hourCounters.set(typeKey, (hourCounters.get(typeKey) || 0) + 1);

    // Count failures
    if (outcome === 'FAILURE') {
      const failKey = `fail:${eventType}`;
      hourCounters.set(failKey, (hourCounters.get(failKey) || 0) + 1);
    }

    // Count by actor
    const actorId = actor.userId || actor.walletAddress || 'system';
    const actorKey = `actor:${actorId}`;
    hourCounters.set(actorKey, (hourCounters.get(actorKey) || 0) + 1);
  }

  /**
   * Check for anomalies
   */
  private async checkForAnomalies(event: AuditEvent): Promise<void> {
    const now = new Date();
    const hourKey = `${now.getUTCFullYear()}-${now.getUTCMonth()}-${now.getUTCDate()}-${now.getUTCHours()}`;
    const hourCounters = this.eventCounters.get(hourKey);
    if (!hourCounters) return;

    // Check failed access threshold
    const failedAccess = hourCounters.get(`fail:${AuditEventType.ACCESS_DENIED}`) || 0;
    if (failedAccess >= this.ANOMALY_THRESHOLDS.failedAccessPerHour) {
      await this.logSuspiciousActivity(
        { systemComponent: 'audit-service' },
        'high_failed_access_rate',
        { count: failedAccess, threshold: this.ANOMALY_THRESHOLDS.failedAccessPerHour },
        AuditSeverity.WARNING
      );
    }

    // Check credit issuance threshold
    const creditIssuance = hourCounters.get(`type:${AuditEventType.CREDIT_ISSUED}`) || 0;
    if (creditIssuance >= this.ANOMALY_THRESHOLDS.creditIssuancePerHour) {
      await this.logSuspiciousActivity(
        { systemComponent: 'audit-service' },
        'high_credit_issuance_rate',
        { count: creditIssuance, threshold: this.ANOMALY_THRESHOLDS.creditIssuancePerHour },
        AuditSeverity.WARNING
      );
    }

    // Check rejected sensor data
    const rejectedSensor = hourCounters.get(`type:${AuditEventType.SENSOR_DATA_REJECTED}`) || 0;
    if (rejectedSensor >= this.ANOMALY_THRESHOLDS.rejectedSensorDataPerHour) {
      await this.logSuspiciousActivity(
        { systemComponent: 'audit-service' },
        'high_sensor_rejection_rate',
        { count: rejectedSensor, threshold: this.ANOMALY_THRESHOLDS.rejectedSensorDataPerHour },
        AuditSeverity.WARNING
      );
    }
  }

  /**
   * Detect anomalies in a period
   */
  private detectAnomaliesInPeriod(events: AuditEvent[]): AuditSummary['anomalies'] {
    const anomalies: AuditSummary['anomalies'] = [];

    // Group events by hour
    const byHour: Map<string, AuditEvent[]> = new Map();
    for (const event of events) {
      const hourKey = event.timestamp.toISOString().slice(0, 13);
      if (!byHour.has(hourKey)) {
        byHour.set(hourKey, []);
      }
      byHour.get(hourKey)!.push(event);
    }

    // Check each hour
    for (const [hourKey, hourEvents] of byHour) {
      const failedAccess = hourEvents.filter(e => e.eventType === AuditEventType.ACCESS_DENIED).length;
      if (failedAccess >= this.ANOMALY_THRESHOLDS.failedAccessPerHour) {
        anomalies.push({
          description: `High failed access rate in hour ${hourKey}`,
          severity: AuditSeverity.WARNING,
          count: failedAccess,
        });
      }

      const suspicious = hourEvents.filter(e => e.eventType === AuditEventType.SUSPICIOUS_ACTIVITY).length;
      if (suspicious > 0) {
        anomalies.push({
          description: `Suspicious activity detected in hour ${hourKey}`,
          severity: AuditSeverity.WARNING,
          count: suspicious,
        });
      }
    }

    return anomalies;
  }

  /**
   * Start anomaly detection background task
   */
  private startAnomalyDetection(): void {
    // Clean up old counters every hour
    // #977 ratchet: unref'd — reached at import; the handle was discarded.
    const importTimeTimer101 = setInterval(() => {
      const cutoff = new Date();
      cutoff.setHours(cutoff.getHours() - 24);

      for (const [hourKey, _] of this.eventCounters) {
        const [year, month, day, hour] = hourKey.split('-').map(Number);
        const hourDate = new Date(year, month, day, hour);
        if (hourDate < cutoff) {
          this.eventCounters.delete(hourKey);
        }
      }
    }, 60 * 60 * 1000);
    importTimeTimer101.unref();
  }
}

// Singleton instance
export const carbonAuditService = new CarbonAuditService();
