/**
 * Security Audit Trail Service
 * Task 104.10: Database Security Monitoring
 *
 * Provides tamper-proof audit logging with hash-chain integrity for all
 * database security events including injection attempts, privilege escalations,
 * and suspicious query patterns.
 */

import crypto from 'crypto';
import { createRedisClient } from '../utils/create-redis.js';
import { sql } from 'drizzle-orm';
import { db } from '../../database/db.js';
import { securityLogger } from '../utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

export type SecurityEventType =
  | 'QUERY_EXECUTED'
  | 'INJECTION_ATTEMPT'
  | 'PRIVILEGE_ESCALATION'
  | 'SCHEMA_CHANGE'
  | 'ACCESS_DENIED'
  | 'SUSPICIOUS_PATTERN'
  | 'AUTHENTICATION_FAILURE'
  | 'RATE_LIMIT_EXCEEDED'
  | 'VALIDATION_FAILURE'
  | 'CONFIG_CHANGE';

export type SecuritySeverity = 'INFO' | 'WARNING' | 'ERROR' | 'CRITICAL';
export type SecurityOutcome = 'SUCCESS' | 'BLOCKED' | 'FAILED' | 'LOGGED';

export interface SecurityEvent {
  eventType: SecurityEventType;
  severity: SecuritySeverity;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  query?: string;
  parameters?: unknown[];
  outcome: SecurityOutcome;
  metadata?: Record<string, unknown>;
}

export interface AuditRecord {
  id: string;
  eventId: string;
  eventType: SecurityEventType;
  severity: SecuritySeverity;
  timestamp: Date;
  userId?: string;
  ipAddress?: string;
  userAgent?: string;
  queryHash?: string;
  parameters?: unknown[];
  outcome: SecurityOutcome;
  metadata?: Record<string, unknown>;
  previousHash: string;
  eventHash: string;
}

export interface InjectionAttempt {
  attemptType:
    | 'SQL_INJECTION'
    | 'NOSQL_INJECTION'
    | 'JSONB_PATH_INJECTION'
    | 'COMMAND_INJECTION'
    | 'XSS'
    | 'PRIVILEGE_ESCALATION'
    | 'QUERY_OPTIMIZATION_ABUSE';
  sourceIp: string;
  userId?: string;
  endpoint?: string;
  httpMethod?: string;
  payload: string;
  detectedPatterns: string[];
  blocked: boolean;
  riskScore: number;
  metadata?: Record<string, unknown>;
}

export interface SecurityMetrics {
  totalQueries: number;
  failedQueries: number;
  slowQueries: number;
  blockedInjections: number;
  privilegedOperations: number;
  uniqueIps: number;
  avgResponseTimeMs: number;
}

export interface ChainVerificationResult {
  isValid: boolean;
  brokenAtEventId?: string;
  message: string;
}

// ============================================================================
// Redis Client for State Management
// ============================================================================

const redis = createRedisClient({
  // Audit-chain and security-event state must never degrade to a cache miss.
  failureMode: 'fail-closed',
});

// ============================================================================
// Security Audit Trail Service
// ============================================================================

export class SecurityAuditTrailService {
  private lastHash: string = 'GENESIS';
  private isInitialized: boolean = false;
  private eventBuffer: SecurityEvent[] = [];
  private readonly BUFFER_FLUSH_SIZE = 100;
  private readonly BUFFER_FLUSH_INTERVAL = 5000; // 5 seconds
  private flushTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Initialize flush timer
    this.startBufferFlush();
  }

  /**
   * Initialize the audit trail service
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      // Get the last hash from the audit trail
      const result = await db.execute(sql`
        SELECT event_hash
        FROM security.audit_trail
        ORDER BY timestamp DESC
        LIMIT 1
      `);

      if (result && result.length > 0) {
        this.lastHash = (result[0] as { event_hash: string }).event_hash;
      }

      this.isInitialized = true;
      securityLogger.info('Service initialized successfully', { module: 'SecurityAuditTrail' });
    } catch (error) {
      // Table might not exist yet - use GENESIS hash
      securityLogger.warn('Could not load last hash, using GENESIS', {
        module: 'SecurityAuditTrail',
        error: error instanceof Error ? error.message : String(error)
      });
      this.lastHash = 'GENESIS';
      this.isInitialized = true;
    }
  }

  /**
   * Log a security event to the audit trail
   */
  async logEvent(event: SecurityEvent): Promise<string> {
    await this.initialize();

    const eventId = this.generateEventId();
    const timestamp = new Date();

    // Hash the query if provided
    const queryHash = event.query
      ? this.hashData(event.query)
      : undefined;

    // Create the audit record
    const record: Omit<AuditRecord, 'id'> = {
      eventId,
      eventType: event.eventType,
      severity: event.severity,
      timestamp,
      userId: event.userId,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent,
      queryHash,
      parameters: event.parameters,
      outcome: event.outcome,
      metadata: event.metadata,
      previousHash: this.lastHash,
      eventHash: '', // Will be computed
    };

    // Compute the event hash
    record.eventHash = this.computeEventHash(record);

    // Insert into database
    try {
      await db.execute(sql`
        INSERT INTO security.audit_trail (
          event_id, event_type, severity, timestamp,
          user_id, ip_address, user_agent, query_hash,
          parameters, outcome, metadata, previous_hash, event_hash
        ) VALUES (
          ${record.eventId},
          ${record.eventType},
          ${record.severity},
          ${record.timestamp},
          ${record.userId || null},
          ${record.ipAddress || null},
          ${record.userAgent || null},
          ${record.queryHash || null},
          ${record.parameters ? JSON.stringify(record.parameters) : null}::jsonb,
          ${record.outcome},
          ${record.metadata ? JSON.stringify(record.metadata) : null}::jsonb,
          ${record.previousHash},
          ${record.eventHash}
        )
      `);

      // Update last hash
      this.lastHash = record.eventHash;

      // Update Redis for real-time monitoring
      await this.updateRealTimeMetrics(event);

      return eventId;
    } catch (error) {
      securityLogger.error('Failed to log event', {
        module: 'SecurityAuditTrail',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Log an injection attempt
   */
  async logInjectionAttempt(attempt: InjectionAttempt): Promise<string> {
    const attemptId = `INJ_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    // Hash the payload for storage (don't store actual payload)
    const payloadHash = this.hashData(attempt.payload);

    try {
      await db.execute(sql`
        INSERT INTO security.injection_attempts (
          attempt_id, attempt_type, source_ip, user_id,
          endpoint, http_method, payload_hash, detected_patterns,
          blocked, risk_score, metadata
        ) VALUES (
          ${attemptId},
          ${attempt.attemptType},
          ${attempt.sourceIp}::inet,
          ${attempt.userId || null},
          ${attempt.endpoint || null},
          ${attempt.httpMethod || null},
          ${payloadHash},
          ${attempt.detectedPatterns}::text[],
          ${attempt.blocked},
          ${attempt.riskScore},
          ${attempt.metadata ? JSON.stringify(attempt.metadata) : null}::jsonb
        )
      `);

      // Also log to main audit trail
      await this.logEvent({
        eventType: 'INJECTION_ATTEMPT',
        severity: attempt.riskScore > 70 ? 'CRITICAL' : 'ERROR',
        userId: attempt.userId,
        ipAddress: attempt.sourceIp,
        outcome: attempt.blocked ? 'BLOCKED' : 'LOGGED',
        metadata: {
          attemptId,
          attemptType: attempt.attemptType,
          detectedPatterns: attempt.detectedPatterns,
          riskScore: attempt.riskScore,
        },
      });

      // Check if IP should be blocked
      await this.checkAutoBlock(attempt.sourceIp);

      return attemptId;
    } catch (error) {
      securityLogger.error('Failed to log injection attempt', {
        module: 'SecurityAuditTrail',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Block an IP address
   */
  async blockIp(
    ipAddress: string,
    reason: string,
    durationMinutes?: number
  ): Promise<void> {
    const blockedUntil = durationMinutes
      ? new Date(Date.now() + durationMinutes * 60 * 1000)
      : null;

    try {
      await db.execute(sql`
        INSERT INTO security.ip_blocklist (
          ip_address, reason, blocked_until
        ) VALUES (
          ${ipAddress}::inet,
          ${reason},
          ${blockedUntil}
        )
        ON CONFLICT (ip_address) DO UPDATE SET
          violation_count = security.ip_blocklist.violation_count + 1,
          last_violation = NOW(),
          blocked_until = EXCLUDED.blocked_until,
          reason = EXCLUDED.reason
      `);

      // Also update Redis for fast lookups
      const key = `blocked_ip:${ipAddress}`;
      if (durationMinutes) {
        await redis.setex(key, durationMinutes * 60, reason);
      } else {
        await redis.set(key, reason);
      }

      // Log the block event
      await this.logEvent({
        eventType: 'ACCESS_DENIED',
        severity: 'WARNING',
        ipAddress,
        outcome: 'BLOCKED',
        metadata: { reason, blockedUntil },
      });
    } catch (error) {
      securityLogger.error('Failed to block IP', {
        module: 'SecurityAuditTrail',
        error: error instanceof Error ? error.message : String(error)
      });
      throw error;
    }
  }

  /**
   * Check if an IP is blocked
   */
  async isIpBlocked(ipAddress: string): Promise<boolean> {
    // Check Redis first (fast path)
    const redisResult = await redis.get(`blocked_ip:${ipAddress}`);
    if (redisResult) return true;

    // Check database
    try {
      const result = await db.execute(sql`
        SELECT 1 FROM security.ip_blocklist
        WHERE ip_address = ${ipAddress}::inet
          AND (blocked_until IS NULL OR blocked_until > NOW())
        LIMIT 1
      `);

      return result && result.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Verify the integrity of the audit trail hash chain
   */
  async verifyChainIntegrity(): Promise<ChainVerificationResult> {
    try {
      const result = await db.execute(sql`
        SELECT * FROM security.verify_audit_chain()
      `);

      if (result && result.length > 0) {
        const row = result[0] as {
          is_valid: boolean;
          broken_at_event_id: string | null;
          message: string;
        };
        return {
          isValid: row.is_valid,
          brokenAtEventId: row.broken_at_event_id || undefined,
          message: row.message,
        };
      }

      return { isValid: true, message: 'No audit records to verify' };
    } catch (error) {
      return {
        isValid: false,
        message: `Verification failed: ${error}`,
      };
    }
  }

  /**
   * Get recent security events
   */
  async getRecentEvents(
    limit: number = 100,
    filters?: {
      eventType?: SecurityEventType;
      severity?: SecuritySeverity;
      userId?: string;
      ipAddress?: string;
      since?: Date;
    }
  ): Promise<AuditRecord[]> {
    let query = sql`
      SELECT * FROM security.audit_trail
      WHERE 1=1
    `;

    if (filters?.eventType) {
      query = sql`${query} AND event_type = ${filters.eventType}`;
    }
    if (filters?.severity) {
      query = sql`${query} AND severity = ${filters.severity}`;
    }
    if (filters?.userId) {
      query = sql`${query} AND user_id = ${filters.userId}`;
    }
    if (filters?.ipAddress) {
      query = sql`${query} AND ip_address = ${filters.ipAddress}::inet`;
    }
    if (filters?.since) {
      query = sql`${query} AND timestamp >= ${filters.since}`;
    }

    query = sql`${query} ORDER BY timestamp DESC LIMIT ${limit}`;

    const result = await db.execute(query);
    return ((result as any).rows || []) as unknown as AuditRecord[];
  }

  /**
   * Get aggregated security metrics
   */
  async getMetrics(date: Date = new Date()): Promise<SecurityMetrics> {
    const dateStr = date.toISOString().split('T')[0];

    try {
      const result = await db.execute(sql`
        SELECT
          COALESCE(SUM(total_queries), 0) as total_queries,
          COALESCE(SUM(failed_queries), 0) as failed_queries,
          COALESCE(SUM(slow_queries), 0) as slow_queries,
          COALESCE(SUM(blocked_injections), 0) as blocked_injections,
          COALESCE(SUM(privileged_operations), 0) as privileged_operations,
          COALESCE(SUM(unique_ips), 0) as unique_ips,
          COALESCE(AVG(avg_response_time_ms), 0) as avg_response_time_ms
        FROM security.metrics
        WHERE metric_date = ${dateStr}::date
      `);

      if (result && result.length > 0) {
        const row = result[0] as Record<string, number>;
        return {
          totalQueries: Number(row.total_queries),
          failedQueries: Number(row.failed_queries),
          slowQueries: Number(row.slow_queries),
          blockedInjections: Number(row.blocked_injections),
          privilegedOperations: Number(row.privileged_operations),
          uniqueIps: Number(row.unique_ips),
          avgResponseTimeMs: Number(row.avg_response_time_ms),
        };
      }

      return {
        totalQueries: 0,
        failedQueries: 0,
        slowQueries: 0,
        blockedInjections: 0,
        privilegedOperations: 0,
        uniqueIps: 0,
        avgResponseTimeMs: 0,
      };
    } catch (error) {
      securityLogger.error('Failed to get metrics', {
        module: 'SecurityAuditTrail',
        error: error instanceof Error ? error.message : String(error)
      });
      return {
        totalQueries: 0,
        failedQueries: 0,
        slowQueries: 0,
        blockedInjections: 0,
        privilegedOperations: 0,
        uniqueIps: 0,
        avgResponseTimeMs: 0,
      };
    }
  }

  /**
   * Update real-time metrics in Redis
   */
  private async updateRealTimeMetrics(event: SecurityEvent): Promise<void> {
    const now = new Date();
    const minute = `${now.toISOString().slice(0, 16)}`;

    try {
      const pipeline = redis.pipeline();

      // Increment event type counter
      pipeline.incr(`security:events:${event.eventType}:${minute}`);
      pipeline.expire(`security:events:${event.eventType}:${minute}`, 3600);

      // Increment severity counter
      pipeline.incr(`security:severity:${event.severity}:${minute}`);
      pipeline.expire(`security:severity:${event.severity}:${minute}`, 3600);

      // Track unique IPs
      if (event.ipAddress) {
        pipeline.sadd(`security:ips:${minute}`, event.ipAddress);
        pipeline.expire(`security:ips:${minute}`, 3600);
      }

      await pipeline.exec();
    } catch (error) {
      securityLogger.warn('Failed to update Redis metrics', {
        module: 'SecurityAuditTrail',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Check if IP should be auto-blocked based on violation count
   */
  private async checkAutoBlock(ipAddress: string): Promise<void> {
    const windowMinutes = 10;
    const threshold = 5;

    try {
      const result = await db.execute(sql`
        SELECT COUNT(*) as count
        FROM security.injection_attempts
        WHERE source_ip = ${ipAddress}::inet
          AND timestamp > NOW() - INTERVAL '${sql.raw(windowMinutes.toString())} minutes'
      `);

      if (result && result.length > 0) {
        const count = Number((result[0] as { count: string }).count);
        if (count >= threshold) {
          await this.blockIp(
            ipAddress,
            'INJECTION_ATTEMPTS',
            60 // Block for 1 hour
          );
          securityLogger.warn('Auto-blocked IP after injection attempts', {
            module: 'SecurityAuditTrail',
            ipAddress,
            attemptCount: count
          });
        }
      }
    } catch (error) {
      securityLogger.error('Failed to check auto-block', {
        module: 'SecurityAuditTrail',
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Generate a unique event ID
   */
  private generateEventId(): string {
    const timestamp = Date.now().toString(36);
    const random = crypto.randomBytes(6).toString('hex');
    return `EVT_${timestamp}_${random}`;
  }

  /**
   * Hash data using SHA-256
   */
  private hashData(data: string): string {
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Compute hash for an audit record (for chain integrity)
   */
  private computeEventHash(record: Omit<AuditRecord, 'id' | 'eventHash'>): string {
    const dataToHash = [
      record.eventId,
      record.eventType,
      record.severity,
      record.timestamp.toISOString(),
      record.userId || '',
      record.ipAddress || '',
      record.outcome,
      record.previousHash,
      JSON.stringify(record.metadata || {}),
    ].join('|');

    return this.hashData(dataToHash);
  }

  /**
   * Start buffer flush timer
   */
  private startBufferFlush(): void {
    if (this.flushTimer) return;

    this.flushTimer = setInterval(async () => {
      if (this.eventBuffer.length > 0) {
        await this.flushEventBuffer();
      }
    }, this.BUFFER_FLUSH_INTERVAL);

    this.flushTimer.unref();
  }

  /**
   * Flush event buffer to database
   */
  private async flushEventBuffer(): Promise<void> {
    const events = [...this.eventBuffer];
    this.eventBuffer = [];

    for (const event of events) {
      try {
        await this.logEvent(event);
      } catch (error) {
        securityLogger.error('Failed to flush event', {
          module: 'SecurityAuditTrail',
          error: error instanceof Error ? error.message : String(error)
        });
        // Re-add to buffer for retry
        this.eventBuffer.push(event);
      }
    }
  }

  /**
   * Add event to buffer for batch processing
   */
  bufferEvent(event: SecurityEvent): void {
    this.eventBuffer.push(event);

    if (this.eventBuffer.length >= this.BUFFER_FLUSH_SIZE) {
      this.flushEventBuffer().catch((error) => {
        securityLogger.error('Failed to flush event buffer', {
          module: 'SecurityAuditTrail',
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }
  }

  /**
   * Cleanup expired IP blocks
   */
  async cleanupExpiredBlocks(): Promise<number> {
    try {
      const result = await db.execute(sql`
        SELECT security.cleanup_expired_blocks() as deleted_count
      `);

      if (result && result.length > 0) {
        return Number((result[0] as { deleted_count: number }).deleted_count);
      }
      return 0;
    } catch (error) {
      securityLogger.error('Failed to cleanup expired blocks', {
        module: 'SecurityAuditTrail',
        error: error instanceof Error ? error.message : String(error)
      });
      return 0;
    }
  }

  /**
   * Shutdown the service gracefully
   */
  async shutdown(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Flush remaining events
    if (this.eventBuffer.length > 0) {
      await this.flushEventBuffer();
    }

    await redis.quit();
    securityLogger.info('Service shutdown complete', { module: 'SecurityAuditTrail' });
  }
}

// Singleton instance
export const securityAuditTrail = new SecurityAuditTrailService();

// Export for convenience
export default securityAuditTrail;
