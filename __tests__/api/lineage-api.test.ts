/**
 * Smoke tests: lineage-api — HTTP request assertions.
 * Addresses #363 (untested api/ endpoint) and #340.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockGetRecord = jest.fn();
const mockGetAncestors = jest.fn();
const mockGetByStationId = jest.fn();
const mockVerifyIntegrity = jest.fn();

jest.mock('express-rate-limit', () =>
  jest.fn(() => (_req: any, _res: any, next: any) => next())
);

jest.mock('helmet', () => () => (_req: any, _res: any, next: any) => next());

jest.mock('../../server/services/lineage-service.js', () => ({
  lineageService: {
    getRecord: mockGetRecord,
    getAncestors: mockGetAncestors,
    getDescendants: jest.fn().mockResolvedValue([]),
    getByCommitId: jest.fn().mockResolvedValue([]),
    getByStationId: mockGetByStationId,
    verifyIntegrity: mockVerifyIntegrity,
    exportChain: jest.fn().mockResolvedValue({}),
  },
}));

import { lineageAPI } from '../../api/lineage-api.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/lineage', lineageAPI);
  return app;
}

const FAKE_RECORD = {
  lineageId: 'lin-abc123',
  stageId: 'ingest',
  contentHash: '0xhash',
  signature: '0xsig',
  timestamp: new Date().toISOString(),
};

describe('lineage-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /:lineageId', () => {
    it('returns 200 with record when found', async () => {
      mockGetRecord.mockResolvedValue(FAKE_RECORD);
      const res = await request(makeApp()).get('/lineage/lin-abc123');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.lineageId).toBe('lin-abc123');
    });

    it('returns 404 when lineage record does not exist', async () => {
      mockGetRecord.mockResolvedValue(null);
      const res = await request(makeApp()).get('/lineage/nonexistent-id');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });

    it('returns 500 when service throws', async () => {
      mockGetRecord.mockRejectedValue(new Error('db error'));
      const res = await request(makeApp()).get('/lineage/lin-abc123');
      expect(res.status).toBe(500);
    });
  });

  describe('GET /:lineageId/ancestors', () => {
    it('returns 200 with ancestors object containing count', async () => {
      mockGetAncestors.mockResolvedValue([FAKE_RECORD]);
      const res = await request(makeApp()).get('/lineage/lin-abc123/ancestors');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.count).toBe(1);
    });
  });

  describe('GET /by-station/:stationId', () => {
    it('returns 200 with records and count', async () => {
      mockGetByStationId.mockResolvedValue([FAKE_RECORD]);
      const res = await request(makeApp()).get('/lineage/by-station/station-001');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.count).toBe(1);
    });
  });

  describe('GET /:lineageId/integrity', () => {
    it('returns 200 with integrity report', async () => {
      mockVerifyIntegrity.mockResolvedValue({ valid: true, issues: [] });
      const res = await request(makeApp()).get('/lineage/lin-abc123/integrity');
      expect(res.status).toBe(200);
      expect(res.body.data.valid).toBe(true);
    });
  });
});
