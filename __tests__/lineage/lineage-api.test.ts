/**
 * Lineage API Unit Tests
 * Issue #213 — Data lineage + provenance API
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

// Mock lineage service — explicit return types to satisfy ts-jest
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetRecord = jest.fn<(...args: any[]) => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetAncestors = jest.fn<(...args: any[]) => Promise<any[]>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetDescendants = jest.fn<(...args: any[]) => Promise<any[]>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetByCommitId = jest.fn<(...args: any[]) => Promise<any[]>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockGetByStationId = jest.fn<(...args: any[]) => Promise<any[]>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockVerifyIntegrity = jest.fn<(...args: any[]) => Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockExportChain = jest.fn<(...args: any[]) => Promise<any>>();

jest.mock('../../server/services/lineage-service.js', () => ({
  lineageService: {
    getRecord: (...args: unknown[]) => mockGetRecord(...args),
    getAncestors: (...args: unknown[]) => mockGetAncestors(...args),
    getDescendants: (...args: unknown[]) => mockGetDescendants(...args),
    getByCommitId: (...args: unknown[]) => mockGetByCommitId(...args),
    getByStationId: (...args: unknown[]) => mockGetByStationId(...args),
    verifyIntegrity: (...args: unknown[]) => mockVerifyIntegrity(...args),
    exportChain: (...args: unknown[]) => mockExportChain(...args),
  },
}));

jest.mock('express-rate-limit', () => jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()));
jest.mock('helmet', () => jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()));

// We test the router by importing it and using supertest-like approach
import express from 'express';
import { lineageAPI } from '../../api/lineage-api.js';

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/lineage', lineageAPI);
  return app;
}

// Simple supertest-like helper
async function request(app: express.Express, method: 'get' | 'post', path: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const http = require('http');
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const options = {
        hostname: 'localhost',
        port: addr.port,
        path,
        method: method.toUpperCase(),
        headers: { 'Content-Type': 'application/json' },
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const req = http.request(options, (res: any) => {
        let data = '';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        res.on('data', (chunk: any) => { data += chunk.toString(); });
        res.on('end', () => {
          server.close();
          try {
            resolve({ status: res.statusCode, body: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, body: { raw: data } as Record<string, unknown> });
          }
        });
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      req.on('error', (_err: any) => {
        server.close();
        resolve({ status: 500, body: {} });
      });

      req.end();
    });
  });
}

describe('Lineage API', () => {
  let app: express.Express;

  beforeEach(() => {
    jest.clearAllMocks();
    app = createApp();
  });

  describe('GET /api/lineage/:lineageId', () => {
    it('should return 200 with record when found', async () => {
      const mockRecord = {
        id: 1,
        lineageId: 'test-lineage-id',
        stageId: 'iot_ingestion',
        contentHash: 'hash123',
      };
      mockGetRecord.mockResolvedValueOnce(mockRecord);

      const res = await request(app, 'get', '/api/lineage/test-lineage-id');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });

    it('should return 404 when record not found', async () => {
      mockGetRecord.mockResolvedValueOnce(null);

      const res = await request(app, 'get', '/api/lineage/non-existent-id');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('GET /api/lineage/:lineageId/ancestors', () => {
    it('should return ancestors list', async () => {
      const mockAncestors = [
        { id: 1, lineageId: 'lid-1', stageId: 'iot_ingestion' },
        { id: 2, lineageId: 'lid-2', stageId: 'validation' },
      ];
      mockGetAncestors.mockResolvedValueOnce(mockAncestors);

      const res = await request(app, 'get', '/api/lineage/lid-1/ancestors');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });

    it('should return 404 when no ancestors found', async () => {
      mockGetAncestors.mockResolvedValueOnce([]);

      const res = await request(app, 'get', '/api/lineage/non-existent/ancestors');
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
    });
  });

  describe('GET /api/lineage/:lineageId/descendants', () => {
    it('should return descendants list', async () => {
      const mockDescendants = [
        { id: 1, lineageId: 'lid-1', stageId: 'iot_ingestion' },
      ];
      mockGetDescendants.mockResolvedValueOnce(mockDescendants);

      const res = await request(app, 'get', '/api/lineage/lid-1/descendants');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/lineage/by-commit/:commitId', () => {
    it('should return records matching commit ID', async () => {
      const mockRecords = [
        { id: 1, lineageId: 'lid-1', commitId: 'commit-abc' },
      ];
      mockGetByCommitId.mockResolvedValueOnce(mockRecords);

      const res = await request(app, 'get', '/api/lineage/by-commit/commit-abc');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toBeDefined();
    });

    it('should return empty list for unknown commit', async () => {
      mockGetByCommitId.mockResolvedValueOnce([]);

      const res = await request(app, 'get', '/api/lineage/by-commit/unknown');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/lineage/by-station/:stationId', () => {
    it('should return records for station', async () => {
      const mockRecords = [
        { id: 1, lineageId: 'lid-1', stationId: 'station-001' },
      ];
      mockGetByStationId.mockResolvedValueOnce(mockRecords);

      const res = await request(app, 'get', '/api/lineage/by-station/station-001');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/lineage/:lineageId/integrity', () => {
    it('should return integrity report', async () => {
      const mockReport = {
        lineageId: 'lid-1',
        chainLength: 3,
        isIntact: true,
        issues: [],
        checkedAt: new Date(),
      };
      mockVerifyIntegrity.mockResolvedValueOnce(mockReport);

      const res = await request(app, 'get', '/api/lineage/lid-1/integrity');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('GET /api/lineage/:lineageId/export', () => {
    it('should export in JSON format by default', async () => {
      const mockExported = {
        chain: [{ id: 1, lineageId: 'lid-1' }],
        integrity: { isIntact: true },
      };
      mockExportChain.mockResolvedValueOnce(mockExported);

      const res = await request(app, 'get', '/api/lineage/lid-1/export');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('should export in ISO 19115 format', async () => {
      const mockExported = {
        lineage: { statement: 'test', processSteps: [], sources: [] },
        integrity: { isIntact: true },
      };
      mockExportChain.mockResolvedValueOnce(mockExported);

      const res = await request(app, 'get', '/api/lineage/lid-1/export?format=iso19115');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe('input validation', () => {
    it('should reject empty lineageId', async () => {
      // Express will match '/' as a different route, resulting in 404
      const res = await request(app, 'get', '/api/lineage/');
      // Empty lineageId won't match /:lineageId route
      expect(res.status).toBe(404);
    });
  });

  describe('error handling', () => {
    it('should return 500 on service error', async () => {
      mockGetRecord.mockRejectedValueOnce(new Error('Database connection failed'));

      const res = await request(app, 'get', '/api/lineage/test-id');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });
});
