/**
 * Data Lineage Schema
 * Tracks provenance from IoT sensor ingestion through validation,
 * blockchain commit-reveal, aggregation, and reward settlement.
 * Issue #213 — Data lineage + provenance API
 */

import {
  pgTable,
  serial,
  varchar,
  text,
  timestamp,
  boolean,
  jsonb,
} from 'drizzle-orm/pg-core';

// Lineage Records — immutable provenance chain
export const lineageRecords = pgTable('lineage_records', {
  id: serial('id').primaryKey(),
  lineageId: varchar('lineage_id', { length: 128 }).notNull().unique(),
  parentLineageId: varchar('parent_lineage_id', { length: 128 }),
  stageId: varchar('stage_id', { length: 64 }).notNull(),
  stationId: varchar('station_id', { length: 128 }),
  commitId: varchar('commit_id', { length: 128 }),
  contentHash: varchar('content_hash', { length: 128 }).notNull(),
  signature: varchar('signature', { length: 256 }),
  processorId: varchar('processor_id', { length: 128 }).notNull(),
  sourceType: varchar('source_type', { length: 50 }).notNull(),
  sourceReference: varchar('source_reference', { length: 255 }),
  transformationApplied: text('transformation_applied'),
  inputRefs: jsonb('input_refs').$type<string[]>(),
  metadata: jsonb('metadata').$type<Record<string, unknown>>(),
  isValid: boolean('is_valid').default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// Drizzle inferred types
export type LineageRecord = typeof lineageRecords.$inferSelect;
export type InsertLineageRecord = typeof lineageRecords.$inferInsert;
