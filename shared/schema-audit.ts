import {
  pgTable,
  uuid,
  timestamp,
  varchar,
  jsonb,
  text,
  integer,
  index,
} from 'drizzle-orm/pg-core';

/**
 * Unified Audit Log Table
 * Provides a centralized trail for all critical security and operational events.
 */
export const unifiedAuditLog = pgTable('unified_audit_log', {
  auditId: uuid('audit_id').defaultRandom().primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),

  // The service or component that generated this log (e.g., 'hsm-service', 'bridge-manager')
  serviceName: varchar('service_name', { length: 64 }).notNull(),

  // High-level event category (e.g., 'TRANSACTION_SIGN', 'SECURITY_ALERT', 'SESSION_CREATE')
  eventType: varchar('event_type', { length: 128 }).notNull(),

  // Severity level: 0 (debug), 1 (info), 2 (warn), 3 (error), 4 (critical)
  severity: integer('severity').default(1).notNull(),

  // Optional user or operator associated with the event
  userId: varchar('user_id', { length: 256 }),

  // Optional session or request identifier
  sessionId: varchar('session_id', { length: 256 }),

  // Detailed event data in JSONB format
  details: jsonb('details').notNull(),

  // Brief human-readable description
  description: text('description'),

  // Optional cryptographic integrity hash of the entry (for tamper-resistance)
  integrityHash: varchar('integrity_hash', { length: 128 }),

  // Optional reference to a blockchain transaction hash
  txHash: varchar('tx_hash', { length: 128 }),
}, (table) => ({
  // Range queries on time-series data (most common access pattern)
  timestampIdx: index('idx_audit_log_timestamp').on(table.timestamp),
  // Security event lookups by user
  userIdIdx: index('idx_audit_log_user_id').on(table.userId),
  // Filter by event category
  eventTypeIdx: index('idx_audit_log_event_type').on(table.eventType),
  // Filter by originating service
  serviceNameIdx: index('idx_audit_log_service_name').on(table.serviceName),
  // Filter by severity (e.g. WHERE severity >= 3)
  severityIdx: index('idx_audit_log_severity').on(table.severity),
  // Composite: most common compliance query — user activity over a time window
  userTimestampIdx: index('idx_audit_log_user_timestamp').on(table.userId, table.timestamp),
}));

export type AuditLogEntry = typeof unifiedAuditLog.$inferSelect;
export type NewAuditLogEntry = typeof unifiedAuditLog.$inferInsert;
