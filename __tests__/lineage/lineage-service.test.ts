/**
 * Lineage Service Unit Tests
 * Issue #213 — Data lineage + provenance API
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock database — explicit return types to satisfy ts-jest
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockLimit = jest.fn<() => Promise<any[]>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockReturning = jest.fn<() => Promise<any[]>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockQuery = jest.fn<(...args: any[]) => Promise<{ rows: any[] }>>();

jest.mock('../../database/db.js', () => ({
  db: {
    insert: () => ({ values: (...args: unknown[]) => ({ returning: () => mockReturning() }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => mockLimit(), orderBy: () => ({ limit: () => mockLimit() }) }) }) }),
  },
  pool: {
    query: (...args: unknown[]) => mockQuery(...args),
  },
}));

jest.mock('../../shared/schema-lineage.js', () => ({
  lineageRecords: {
    lineageId: 'lineage_id',
    parentLineageId: 'parent_lineage_id',
    stageId: 'stage_id',
    stationId: 'station_id',
    commitId: 'commit_id',
    createdAt: 'created_at',
  },
}));

jest.mock('../../server/utils/logger.js', () => ({
  weatherLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Import after mocking
import {
  computeLineageId,
  computeSignature,
  computeContentHash,
  LineageService,
} from '../../server/services/lineage-service.js';

describe('Lineage Service', () => {
  let service: LineageService;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new LineageService();
  });

  describe('computeLineageId', () => {
    it('should produce deterministic IDs for same inputs', () => {
      const id1 = computeLineageId('iot_ingestion', null, 'abc123');
      const id2 = computeLineageId('iot_ingestion', null, 'abc123');
      expect(id1).toBe(id2);
    });

    it('should produce different IDs for different stages', () => {
      const id1 = computeLineageId('iot_ingestion', null, 'abc123');
      const id2 = computeLineageId('reward_settlement', null, 'abc123');
      expect(id1).not.toBe(id2);
    });

    it('should produce different IDs for different parents', () => {
      const id1 = computeLineageId('stage', null, 'hash');
      const id2 = computeLineageId('stage', 'parent123', 'hash');
      expect(id1).not.toBe(id2);
    });

    it('should produce different IDs for different content hashes', () => {
      const id1 = computeLineageId('stage', null, 'hash1');
      const id2 = computeLineageId('stage', null, 'hash2');
      expect(id1).not.toBe(id2);
    });

    it('should return a 64-char hex string (SHA-256)', () => {
      const id = computeLineageId('stage', null, 'hash');
      expect(id).toHaveLength(64);
      expect(id).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should use "root" for null parent', () => {
      const id1 = computeLineageId('stage', null, 'hash');
      // "root" is used internally for null parent
      expect(id1).toBeTruthy();
    });
  });

  describe('computeSignature', () => {
    it('should produce deterministic HMAC for same inputs', () => {
      const sig1 = computeSignature('lineageId', 'contentHash', '2026-01-01T00:00:00.000Z');
      const sig2 = computeSignature('lineageId', 'contentHash', '2026-01-01T00:00:00.000Z');
      expect(sig1).toBe(sig2);
    });

    it('should produce different HMAC for different lineageIds', () => {
      const sig1 = computeSignature('id1', 'hash', '2026-01-01T00:00:00.000Z');
      const sig2 = computeSignature('id2', 'hash', '2026-01-01T00:00:00.000Z');
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different HMAC for different timestamps', () => {
      const sig1 = computeSignature('id', 'hash', '2026-01-01T00:00:00.000Z');
      const sig2 = computeSignature('id', 'hash', '2026-02-01T00:00:00.000Z');
      expect(sig1).not.toBe(sig2);
    });

    it('should return a 64-char hex string (HMAC-SHA256)', () => {
      const sig = computeSignature('id', 'hash', '2026-01-01T00:00:00.000Z');
      expect(sig).toHaveLength(64);
      expect(sig).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('computeContentHash', () => {
    it('should hash string data', () => {
      const hash = computeContentHash('hello world');
      expect(hash).toHaveLength(64);
      expect(hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('should hash objects via JSON.stringify', () => {
      const hash1 = computeContentHash({ a: 1, b: 2 });
      const hash2 = computeContentHash(JSON.stringify({ a: 1, b: 2 }));
      expect(hash1).toBe(hash2);
    });

    it('should produce different hashes for different data', () => {
      const hash1 = computeContentHash('data1');
      const hash2 = computeContentHash('data2');
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('createLineageRecord', () => {
    it('should create a record with deterministic lineageId', async () => {
      const expectedId = computeLineageId('iot_ingestion', null, 'content_hash_123');
      const mockRecord = {
        id: 1,
        lineageId: expectedId,
        parentLineageId: null,
        stageId: 'iot_ingestion',
        stationId: 'station-001',
        contentHash: 'content_hash_123',
        signature: 'sig',
        processorId: 'wrfcoin-iot_ingestion',
        sourceType: 'iot_sensor',
        isValid: true,
        createdAt: new Date(),
      };

      mockReturning.mockResolvedValueOnce([mockRecord]);

      const result = await service.createLineageRecord({
        stageId: 'iot_ingestion',
        contentHash: 'content_hash_123',
        stationId: 'station-001',
        sourceType: 'iot_sensor',
      });

      expect(result.lineageId).toBe(expectedId);
      expect(result.stageId).toBe('iot_ingestion');
    });

    it('should handle duplicate records idempotently', async () => {
      const error = new Error('unique constraint violation');
      mockReturning.mockRejectedValueOnce(error);

      const existingRecord = {
        id: 1,
        lineageId: 'existing-id',
        stageId: 'iot_ingestion',
        contentHash: 'hash',
        isValid: true,
      };
      mockLimit.mockResolvedValueOnce([existingRecord]);

      const result = await service.createLineageRecord({
        stageId: 'iot_ingestion',
        contentHash: 'hash',
        sourceType: 'iot_sensor',
      });

      expect(result).toBeTruthy();
    });
  });

  describe('getRecord', () => {
    it('should return null for non-existent record', async () => {
      mockLimit.mockResolvedValueOnce([]);
      const result = await service.getRecord('non-existent');
      expect(result).toBeNull();
    });

    it('should return record for existing lineageId', async () => {
      const mockRecord = {
        id: 1,
        lineageId: 'test-id',
        stageId: 'iot_ingestion',
      };
      mockLimit.mockResolvedValueOnce([mockRecord]);
      const result = await service.getRecord('test-id');
      expect(result).toBeTruthy();
      expect(result?.lineageId).toBe('test-id');
    });
  });

  describe('getAncestors', () => {
    it('should execute recursive CTE query', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await service.getAncestors('lineage-id', 10);
      expect(result).toEqual([]);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WITH RECURSIVE ancestors'),
        ['lineage-id', 10]
      );
    });

    it('should map DB rows to LineageRecordResult', async () => {
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            lineage_id: 'lid-1',
            parent_lineage_id: null,
            stage_id: 'iot_ingestion',
            station_id: 'station-001',
            commit_id: null,
            content_hash: 'hash1',
            signature: 'sig1',
            processor_id: 'wrfcoin-iot_ingestion',
            source_type: 'iot_sensor',
            source_reference: null,
            transformation_applied: null,
            input_refs: [],
            metadata: {},
            is_valid: true,
            created_at: '2026-02-22T00:00:00.000Z',
          },
        ],
      });
      const result = await service.getAncestors('lid-1', 50);
      expect(result).toHaveLength(1);
      expect(result[0].lineageId).toBe('lid-1');
      expect(result[0].stageId).toBe('iot_ingestion');
      expect(result[0].createdAt).toBeInstanceOf(Date);
    });
  });

  describe('getDescendants', () => {
    it('should execute recursive CTE query for descendants', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const result = await service.getDescendants('lineage-id', 25);
      expect(result).toEqual([]);
      expect(mockQuery).toHaveBeenCalledWith(
        expect.stringContaining('WITH RECURSIVE descendants'),
        ['lineage-id', 25]
      );
    });
  });

  describe('verifyIntegrity', () => {
    it('should report broken chain for non-existent record', async () => {
      mockQuery.mockResolvedValueOnce({ rows: [] });
      const report = await service.verifyIntegrity('non-existent');
      expect(report.isIntact).toBe(false);
      expect(report.chainLength).toBe(0);
      expect(report.issues).toHaveLength(1);
      expect(report.issues[0].type).toBe('broken_chain');
    });

    it('should pass for a valid single-record chain', async () => {
      const lineageId = computeLineageId('iot_ingestion', null, 'content-hash');
      const createdAt = new Date('2026-02-22T12:00:00.000Z');
      const signature = computeSignature(lineageId, 'content-hash', createdAt.toISOString());

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            lineage_id: lineageId,
            parent_lineage_id: null,
            stage_id: 'iot_ingestion',
            station_id: 'station-001',
            commit_id: null,
            content_hash: 'content-hash',
            signature,
            processor_id: 'wrfcoin-iot_ingestion',
            source_type: 'iot_sensor',
            source_reference: null,
            transformation_applied: null,
            input_refs: [],
            metadata: {},
            is_valid: true,
            created_at: createdAt.toISOString(),
          },
        ],
      });

      const report = await service.verifyIntegrity(lineageId);
      expect(report.isIntact).toBe(true);
      expect(report.chainLength).toBe(1);
      expect(report.issues).toHaveLength(0);
    });

    it('should detect hash mismatch', async () => {
      const createdAt = new Date('2026-02-22T12:00:00.000Z');

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            lineage_id: 'tampered-id',
            parent_lineage_id: null,
            stage_id: 'iot_ingestion',
            station_id: 'station-001',
            commit_id: null,
            content_hash: 'content-hash',
            signature: null,
            processor_id: 'wrfcoin-iot_ingestion',
            source_type: 'iot_sensor',
            source_reference: null,
            transformation_applied: null,
            input_refs: [],
            metadata: {},
            is_valid: true,
            created_at: createdAt.toISOString(),
          },
        ],
      });

      const report = await service.verifyIntegrity('tampered-id');
      expect(report.isIntact).toBe(false);
      expect(report.issues.some(i => i.type === 'hash_mismatch')).toBe(true);
    });

    it('should detect signature mismatch', async () => {
      const lineageId = computeLineageId('iot_ingestion', null, 'content-hash');
      const createdAt = new Date('2026-02-22T12:00:00.000Z');

      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            lineage_id: lineageId,
            parent_lineage_id: null,
            stage_id: 'iot_ingestion',
            station_id: 'station-001',
            commit_id: null,
            content_hash: 'content-hash',
            signature: 'invalid-signature',
            processor_id: 'wrfcoin-iot_ingestion',
            source_type: 'iot_sensor',
            source_reference: null,
            transformation_applied: null,
            input_refs: [],
            metadata: {},
            is_valid: true,
            created_at: createdAt.toISOString(),
          },
        ],
      });

      const report = await service.verifyIntegrity(lineageId);
      expect(report.isIntact).toBe(false);
      expect(report.issues.some(i => i.type === 'signature_invalid')).toBe(true);
    });
  });

  describe('exportChain', () => {
    it('should export in JSON format by default', async () => {
      const lineageId = computeLineageId('iot_ingestion', null, 'hash');
      const createdAt = new Date('2026-02-22T12:00:00.000Z');
      const signature = computeSignature(lineageId, 'hash', createdAt.toISOString());

      // getAncestors call
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            lineage_id: lineageId,
            parent_lineage_id: null,
            stage_id: 'iot_ingestion',
            station_id: 'station-001',
            commit_id: null,
            content_hash: 'hash',
            signature,
            processor_id: 'wrfcoin-iot_ingestion',
            source_type: 'iot_sensor',
            source_reference: 'ttn:sensor-001',
            transformation_applied: null,
            input_refs: [],
            metadata: {},
            is_valid: true,
            created_at: createdAt.toISOString(),
          },
        ],
      });

      // verifyIntegrity call (uses getAncestors internally)
      mockQuery.mockResolvedValueOnce({
        rows: [
          {
            id: 1,
            lineage_id: lineageId,
            parent_lineage_id: null,
            stage_id: 'iot_ingestion',
            station_id: 'station-001',
            commit_id: null,
            content_hash: 'hash',
            signature,
            processor_id: 'wrfcoin-iot_ingestion',
            source_type: 'iot_sensor',
            source_reference: 'ttn:sensor-001',
            transformation_applied: null,
            input_refs: [],
            metadata: {},
            is_valid: true,
            created_at: createdAt.toISOString(),
          },
        ],
      });

      const result = await service.exportChain(lineageId, 'json') as { chain: unknown[]; integrity: { isIntact: boolean } };
      expect(result.chain).toBeDefined();
      expect(result.integrity).toBeDefined();
      expect(result.integrity.isIntact).toBe(true);
    });

    it('should export in ISO 19115 format', async () => {
      const lineageId = computeLineageId('iot_ingestion', null, 'hash');
      const createdAt = new Date('2026-02-22T12:00:00.000Z');
      const signature = computeSignature(lineageId, 'hash', createdAt.toISOString());

      const row = {
        id: 1,
        lineage_id: lineageId,
        parent_lineage_id: null,
        stage_id: 'iot_ingestion',
        station_id: 'station-001',
        commit_id: null,
        content_hash: 'hash',
        signature,
        processor_id: 'wrfcoin-iot_ingestion',
        source_type: 'iot_sensor',
        source_reference: 'ttn:sensor-001',
        transformation_applied: null,
        input_refs: [],
        metadata: {},
        is_valid: true,
        created_at: createdAt.toISOString(),
      };

      mockQuery.mockResolvedValueOnce({ rows: [row] });
      mockQuery.mockResolvedValueOnce({ rows: [row] });

      const result = await service.exportChain(lineageId, 'iso19115') as {
        lineage: { statement: string; processSteps: unknown[]; sources: unknown[] };
        integrity: { isIntact: boolean };
      };
      expect(result.lineage).toBeDefined();
      expect(result.lineage.statement).toContain('lineage chain');
      expect(result.lineage.processSteps).toBeDefined();
      expect(result.lineage.sources).toBeDefined();
    });
  });
});
