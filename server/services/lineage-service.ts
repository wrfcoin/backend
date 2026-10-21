/**
 * Data Lineage Service
 * Core business logic for creating, querying, and verifying lineage records.
 * Issue #213 — Data lineage + provenance API
 */

import { createHash, createHmac } from 'crypto';
import { eq, desc, sql } from 'drizzle-orm';
import { db, pool } from '../../database/db.js';
import { lineageRecords } from '../../shared/schema-lineage.js';
import { weatherLogger as logger } from '../utils/logger.js';

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface CreateLineageInput {
  parentLineageId?: string | null;
  stageId: string;
  stationId?: string;
  commitId?: string;
  contentHash: string;
  processorId?: string;
  sourceType: string;
  sourceReference?: string;
  transformationApplied?: string;
  inputRefs?: string[];
  metadata?: Record<string, unknown>;
}

export interface LineageRecordResult {
  id: number;
  lineageId: string;
  parentLineageId: string | null;
  stageId: string;
  stationId: string | null;
  commitId: string | null;
  contentHash: string;
  signature: string | null;
  processorId: string;
  sourceType: string;
  sourceReference: string | null;
  transformationApplied: string | null;
  inputRefs: string[] | null;
  metadata: Record<string, unknown> | null;
  isValid: boolean | null;
  createdAt: Date;
}

export interface IntegrityIssue {
  lineageId: string;
  type: 'hash_mismatch' | 'signature_invalid' | 'timestamp_gap' | 'missing_parent' | 'broken_chain';
  description: string;
}

export interface IntegrityReport {
  lineageId: string;
  chainLength: number;
  isIntact: boolean;
  issues: IntegrityIssue[];
  checkedAt: Date;
}

export interface ISO19115ProcessStep {
  description: string;
  dateTime: string;
  processor: string;
  sourceType: string;
}

export interface ISO19115DataSource {
  description: string;
  sourceCitation: string;
  sourceType: string;
}

export interface ISO19115Export {
  statement: string;
  processSteps: ISO19115ProcessStep[];
  sources: ISO19115DataSource[];
}

// ─── Utility Functions ──────────────────────────────────────────────────────

const HMAC_SECRET = process.env.LINEAGE_HMAC_SECRET || (
  process.env.NODE_ENV === 'production'
    ? (() => { throw new Error('LINEAGE_HMAC_SECRET is required in production'); })()
    : 'wrfcoin-lineage-dev-key'
);

/**
 * Generate a deterministic lineage ID from stage, parent, and content hash.
 */
export function computeLineageId(stageId: string, parentLineageId: string | null, contentHash: string): string {
  const input = `${stageId}:${parentLineageId || 'root'}:${contentHash}`;
  return createHash('sha256').update(input).digest('hex');
}

/**
 * Generate HMAC signature for tamper detection.
 */
export function computeSignature(lineageId: string, contentHash: string, timestamp: string): string {
  const data = `${lineageId}:${contentHash}:${timestamp}`;
  return createHmac('sha256', HMAC_SECRET as string).update(data).digest('hex');
}

/**
 * Compute SHA-256 hash of data payload.
 */
export function computeContentHash(data: unknown): string {
  const json = typeof data === 'string' ? data : JSON.stringify(data);
  return createHash('sha256').update(json).digest('hex');
}

// ─── Service Class ──────────────────────────────────────────────────────────

export class LineageService {
  /**
   * Create an immutable lineage record.
   */
  async createLineageRecord(input: CreateLineageInput): Promise<LineageRecordResult> {
    const parentId = input.parentLineageId || null;
    const lineageId = computeLineageId(input.stageId, parentId, input.contentHash);
    const now = new Date();
    const signature = computeSignature(lineageId, input.contentHash, now.toISOString());
    const processorId = input.processorId || `wrfcoin-${input.stageId}`;

    try {
      const [record] = await db.insert(lineageRecords).values({
        lineageId,
        parentLineageId: parentId,
        stageId: input.stageId,
        stationId: input.stationId || null,
        commitId: input.commitId || null,
        contentHash: input.contentHash,
        signature,
        processorId,
        sourceType: input.sourceType,
        sourceReference: input.sourceReference || null,
        transformationApplied: input.transformationApplied || null,
        inputRefs: input.inputRefs || [],
        metadata: input.metadata || {},
        isValid: true,
        createdAt: now,
      }).returning();

      logger.info('Lineage record created', {
        lineageId,
        stageId: input.stageId,
        stationId: input.stationId,
      });

      return record as LineageRecordResult;
    } catch (error: unknown) {
      // Handle duplicate lineage_id (idempotent)
      const errMsg = error instanceof Error ? error.message : String(error);
      if (errMsg.includes('unique') || errMsg.includes('duplicate')) {
        logger.info('Lineage record already exists', { lineageId });
        const existing = await this.getRecord(lineageId);
        if (existing) return existing;
      }
      logger.error('Failed to create lineage record', {
        error: errMsg,
        stageId: input.stageId,
      });
      throw error;
    }
  }

  /**
   * Get a single lineage record by its ID.
   */
  async getRecord(lineageId: string): Promise<LineageRecordResult | null> {
    const results = await db
      .select()
      .from(lineageRecords)
      .where(eq(lineageRecords.lineageId, lineageId))
      .limit(1);

    return (results[0] as LineageRecordResult) || null;
  }

  /**
   * Walk up the ancestor chain using a recursive CTE.
   */
  async getAncestors(lineageId: string, maxDepth: number = 50): Promise<LineageRecordResult[]> {
    const query = `
      WITH RECURSIVE ancestors AS (
        SELECT *, 0 AS depth FROM lineage_records WHERE lineage_id = $1
        UNION ALL
        SELECT lr.*, a.depth + 1
        FROM lineage_records lr
        JOIN ancestors a ON lr.lineage_id = a.parent_lineage_id
        WHERE a.depth < $2
      )
      SELECT * FROM ancestors ORDER BY depth ASC
    `;
    const result = await pool.query(query, [lineageId, maxDepth]);
    return result.rows.map(mapDbRow);
  }

  /**
   * Walk down the descendant chain using a recursive CTE.
   */
  async getDescendants(lineageId: string, maxDepth: number = 50): Promise<LineageRecordResult[]> {
    const query = `
      WITH RECURSIVE descendants AS (
        SELECT *, 0 AS depth FROM lineage_records WHERE lineage_id = $1
        UNION ALL
        SELECT lr.*, d.depth + 1
        FROM lineage_records lr
        JOIN descendants d ON lr.parent_lineage_id = d.lineage_id
        WHERE d.depth < $2
      )
      SELECT * FROM descendants ORDER BY depth ASC
    `;
    const result = await pool.query(query, [lineageId, maxDepth]);
    return result.rows.map(mapDbRow);
  }

  /**
   * Find all lineage records for a PoP commit_id.
   */
  async getByCommitId(commitId: string): Promise<LineageRecordResult[]> {
    const results = await db
      .select()
      .from(lineageRecords)
      .where(eq(lineageRecords.commitId, commitId))
      .orderBy(desc(lineageRecords.createdAt));

    return results as LineageRecordResult[];
  }

  /**
   * Find all lineage records for a station.
   */
  async getByStationId(stationId: string, limit: number = 100): Promise<LineageRecordResult[]> {
    const results = await db
      .select()
      .from(lineageRecords)
      .where(eq(lineageRecords.stationId, stationId))
      .orderBy(desc(lineageRecords.createdAt))
      .limit(limit);

    return results as LineageRecordResult[];
  }

  /**
   * Find the most recent lineage record for a station at a given stage.
   */
  async getRecentByStationAndStage(
    stationId: string,
    stageId: string,
    withinMinutes: number = 5
  ): Promise<LineageRecordResult | null> {
    const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000);
    const query = `
      SELECT * FROM lineage_records
      WHERE station_id = $1 AND stage_id = $2 AND created_at > $3
      ORDER BY created_at DESC
      LIMIT 1
    `;
    const result = await pool.query(query, [stationId, stageId, cutoff.toISOString()]);
    return result.rows.length > 0 ? mapDbRow(result.rows[0]) : null;
  }

  /**
   * Verify the integrity of a lineage chain.
   */
  async verifyIntegrity(lineageId: string): Promise<IntegrityReport> {
    const chain = await this.getAncestors(lineageId, 100);
    const issues: IntegrityIssue[] = [];

    if (chain.length === 0) {
      return {
        lineageId,
        chainLength: 0,
        isIntact: false,
        issues: [{ lineageId, type: 'broken_chain', description: 'Record not found' }],
        checkedAt: new Date(),
      };
    }

    for (let i = 0; i < chain.length; i++) {
      const record = chain[i];

      // Verify deterministic ID
      const expectedId = computeLineageId(
        record.stageId,
        record.parentLineageId,
        record.contentHash
      );
      if (record.lineageId !== expectedId) {
        issues.push({
          lineageId: record.lineageId,
          type: 'hash_mismatch',
          description: `Lineage ID mismatch: expected ${expectedId.substring(0, 16)}..., got ${record.lineageId.substring(0, 16)}...`,
        });
      }

      // Verify HMAC signature
      if (record.signature && record.createdAt) {
        const expectedSig = computeSignature(
          record.lineageId,
          record.contentHash,
          record.createdAt.toISOString()
        );
        if (record.signature !== expectedSig) {
          issues.push({
            lineageId: record.lineageId,
            type: 'signature_invalid',
            description: `Signature mismatch for stage ${record.stageId}`,
          });
        }
      }

      // Verify parent exists (except root)
      if (record.parentLineageId && i < chain.length - 1) {
        const parent = chain[i + 1];
        if (!parent || parent.lineageId !== record.parentLineageId) {
          issues.push({
            lineageId: record.lineageId,
            type: 'missing_parent',
            description: `Parent ${record.parentLineageId.substring(0, 16)}... not found in chain`,
          });
        }
      }

      // Verify timestamp ordering (parent should be older)
      if (i < chain.length - 1) {
        const parent = chain[i + 1];
        if (parent && record.createdAt < parent.createdAt) {
          issues.push({
            lineageId: record.lineageId,
            type: 'timestamp_gap',
            description: `Record at ${record.createdAt.toISOString()} is older than parent at ${parent.createdAt.toISOString()}`,
          });
        }
      }
    }

    return {
      lineageId,
      chainLength: chain.length,
      isIntact: issues.length === 0,
      issues,
      checkedAt: new Date(),
    };
  }

  /**
   * Export a lineage chain in JSON or ISO 19115 format.
   */
  async exportChain(lineageId: string, format: 'json' | 'iso19115' = 'json'): Promise<unknown> {
    const chain = await this.getAncestors(lineageId);
    const integrity = await this.verifyIntegrity(lineageId);

    if (format === 'iso19115') {
      const processSteps: ISO19115ProcessStep[] = chain
        .reverse()
        .map((record) => ({
          description: record.transformationApplied || `Stage: ${record.stageId}`,
          dateTime: record.createdAt.toISOString(),
          processor: record.processorId,
          sourceType: record.sourceType,
        }));

      const sources: ISO19115DataSource[] = chain
        .filter((r) => r.stageId === 'iot_ingestion')
        .map((record) => ({
          description: `${record.sourceType} sensor data`,
          sourceCitation: record.sourceReference || record.stationId || 'unknown',
          sourceType: record.sourceType,
        }));

      const iso: ISO19115Export = {
        statement: `Data lineage chain of ${chain.length} stages from ${chain[0]?.sourceType || 'unknown'} to ${chain[chain.length - 1]?.stageId || 'unknown'}`,
        processSteps,
        sources,
      };

      return { lineage: iso, integrity };
    }

    return { chain, integrity };
  }
}

// ─── Row Mapping ────────────────────────────────────────────────────────────

function mapDbRow(row: Record<string, unknown>): LineageRecordResult {
  return {
    id: row.id as number,
    lineageId: row.lineage_id as string,
    parentLineageId: (row.parent_lineage_id as string) || null,
    stageId: row.stage_id as string,
    stationId: (row.station_id as string) || null,
    commitId: (row.commit_id as string) || null,
    contentHash: row.content_hash as string,
    signature: (row.signature as string) || null,
    processorId: row.processor_id as string,
    sourceType: row.source_type as string,
    sourceReference: (row.source_reference as string) || null,
    transformationApplied: (row.transformation_applied as string) || null,
    inputRefs: (row.input_refs as string[]) || null,
    metadata: (row.metadata as Record<string, unknown>) || null,
    isValid: row.is_valid as boolean | null,
    createdAt: new Date(row.created_at as string),
  };
}

// ─── Singleton ──────────────────────────────────────────────────────────────

export const lineageService = new LineageService();
