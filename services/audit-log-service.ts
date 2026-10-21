/**
 * Backend Service-Layer Audit Log
 * ================================
 * Persists Node.js service-layer events to the PostgreSQL `unifiedAuditLog`
 * table with SHA-256 integrity hashes.
 *
 * Responsibility split (two-tier architecture):
 *   - THIS LOG (backend):  HSM signing attempts, API auth failures, session
 *                          lifecycle, rate-limit events, bridge verification.
 *   - RUST LOG (core4):    On-chain protocol events — slashing, staking,
 *                          oracle attestation, governance proposal execution.
 *
 * Table name `unifiedAuditLog` is backend-only; the Rust state never writes
 * to it.  If a future sync from Rust state is added, use a different table
 * (e.g. `chainProtocolEvents`) to avoid schema conflicts.
 */

import { db } from '../database/connection.js';
import { unifiedAuditLog, NewAuditLogEntry, AuditLogEntry } from '../shared/schema-audit.js';
import { desc, eq, and, SQL } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

/**
 * In-memory audit log store.
 * Every successful DB insert also pushes here; when the DB insert fails the
 * entry is still captured in memory so getLogs() never loses events.
 */
interface InMemoryAuditEntry {
  auditId: string;
  timestamp: Date;
  serviceName: string;
  eventType: string;
  severity: number;
  userId: string | null;
  sessionId: string | null;
  details: any;
  description: string | null;
  integrityHash: string;
  txHash: string | null;
}

const inMemoryAuditLog: InMemoryAuditEntry[] = [];

export class AuditLogService {
  /**
   * Log an audit event.
   * Writes to both PostgreSQL (via Drizzle) and the in-memory store.
   */
  async log(entry: Omit<NewAuditLogEntry, 'auditId' | 'timestamp' | 'integrityHash'>): Promise<string> {
    // Calculate integrity hash of the log entry
    const hashInput = JSON.stringify({
      serviceName: entry.serviceName,
      eventType: entry.eventType,
      severity: entry.severity,
      userId: entry.userId,
      sessionId: entry.sessionId,
      details: entry.details,
      description: entry.description,
    });

    const integrityHash = crypto
      .createHash('sha256')
      .update(hashInput)
      .digest('hex');

    let auditId = '';

    try {
      // Insert into the database
      const [inserted] = await db
        .insert(unifiedAuditLog)
        .values({
          ...entry,
          integrityHash,
        } as NewAuditLogEntry)
        .returning({ auditId: unifiedAuditLog.auditId });

      auditId = inserted.auditId;

      logger.debug('Audit log entry created', {
        auditId,
        serviceName: entry.serviceName,
        eventType: entry.eventType
      });
    } catch (error) {
      // DB write failed — generate a synthetic auditId so the in-memory
      // fallback still tracks the event
      auditId = crypto.randomUUID();
      logger.error('Failed to write audit log entry to DB, persisting in memory', {
        error: error instanceof Error ? error.message : String(error),
        serviceName: entry.serviceName,
        eventType: entry.eventType
      });
      console.error('CRITICAL: AUDIT LOG DB PERSISTENCE FAILED', entry);
    }

    // Always persist to in-memory store (survives DB failures)
    inMemoryAuditLog.push({
      auditId,
      timestamp: new Date(),
      serviceName: entry.serviceName,
      eventType: entry.eventType,
      severity: entry.severity ?? 1,
      userId: entry.userId ?? null,
      sessionId: entry.sessionId ?? null,
      details: entry.details,
      description: entry.description ?? null,
      integrityHash,
      txHash: (entry as any).txHash ?? null,
    });

    return auditId;
  }

  /**
   * Retrieve audit logs with optional filtering and pagination.
   *
   * Attempts to query PostgreSQL first. If the DB is unavailable (connection
   * error, missing table, etc.) it falls back to the in-memory store so
   * callers always get results when events have been logged.
   *
   * @param options.serviceName - Filter by originating service
   * @param options.userId      - Filter by associated user
   * @param options.limit       - Max rows to return (default 50)
   * @param options.offset      - Number of rows to skip (default 0)
   * @returns Array of audit log entries, sorted by timestamp descending
   */
  async getLogs(options: {
    serviceName?: string;
    userId?: string;
    limit?: number;
    offset?: number
  }): Promise<any[]> {
    const { serviceName, userId, limit = 50, offset = 0 } = options;

    // --- Try DB first ---
    try {
      const conditions: SQL[] = [];
      if (serviceName) {
        conditions.push(eq(unifiedAuditLog.serviceName, serviceName));
      }
      if (userId) {
        conditions.push(eq(unifiedAuditLog.userId, userId));
      }

      const whereClause = conditions.length > 0
        ? conditions.length === 1 ? conditions[0] : and(...conditions)
        : undefined;

      const rows = await db
        .select()
        .from(unifiedAuditLog)
        .where(whereClause)
        .orderBy(desc(unifiedAuditLog.timestamp))
        .limit(limit)
        .offset(offset);

      if (rows.length > 0 || inMemoryAuditLog.length === 0) {
        return rows;
      }
      // If DB returned empty but we have in-memory entries, fall through
      // to the in-memory path (DB may not have the table yet)
    } catch (error) {
      logger.warn('getLogs DB query failed, falling back to in-memory store', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // --- In-memory fallback ---
    let filtered = [...inMemoryAuditLog];

    if (serviceName) {
      filtered = filtered.filter(e => e.serviceName === serviceName);
    }
    if (userId) {
      filtered = filtered.filter(e => e.userId === userId);
    }

    // Sort by timestamp descending (most recent first)
    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    // Paginate
    return filtered.slice(offset, offset + limit);
  }
}

// Singleton instance
export const auditLogService = new AuditLogService();
