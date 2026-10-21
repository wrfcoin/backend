import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Application } from 'express';
const request = require('supertest');
const express = require('express');

// --- Mocks ---

const mockMiningLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../server/utils/logger.js', () => ({
  miningLogger: mockMiningLogger,
}));

// Mock auth middleware so authenticateJWT passes through in tests
jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (req: any, _res: any, next: any) => {
    req.user = { id: 'test-user', address: '0x' + 'a'.repeat(40), role: 'user', permissions: ['read'] };
    next();
  },
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
  requireRole: () => (_req: any, _res: any, next: any) => next(),
}));

// --- Import route after mocks ---
import miningRoutes from '../../routes/mining.js';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

const createApp = (): Application => {
  const app = express();
  app.use(express.json());
  app.use('/api/mining', miningRoutes);
  return app;
};

describe('mining-routes', () => {
  let app: Application;

  beforeEach(() => {
    app = createApp();
    jest.clearAllMocks();
    mockFetch.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);

      if (url.includes('/mining/stats')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              chain_height: 42,
              difficulty: 1500000,
              total_transactions: 321,
              avg_block_time_secs: 12.5,
            }),
        } as any;
      }

      if (url.includes('/node/sync/status')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              chain_height: 42,
              sync_status: 'synced',
            }),
        } as any;
      }

      if (url.includes('/node/resources')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              uptime_secs: 600,
              pending_transactions: 4,
            }),
        } as any;
      }

      throw new Error(`Unexpected fetch URL: ${url}`);
    });
  });

  // --- GET /api/mining/stats ---

  describe('GET /api/mining/stats', () => {
    it('returns 200 with mapped core4 stats shape', async () => {
      const res = await request(app).get('/api/mining/stats');

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('hashrate');
      expect(res.body).toHaveProperty('workers');
      expect(res.body).toHaveProperty('network');
      expect(res.body).toHaveProperty('earnings');
      expect(res.body).toHaveProperty('hardware');
      expect(res.body).toHaveProperty('performance');
      expect(res.body).toHaveProperty('timestamps');
    });

    it('maps difficulty into the displayed hashrate fields', async () => {
      const res = await request(app).get('/api/mining/stats');

      expect(typeof res.body.hashrate.current).toBe('number');
      expect(res.body.hashrate.current).toBe(1500000);
      expect(res.body.hashrate.formatted).toBe('1.50 MH/s');
      expect(res.body.network.blockHeight).toBe(42);
    });
  });

  // --- GET /api/mining/miners/:address ---

  describe('GET /api/mining/miners/:address', () => {
    it('returns 501 because core4 has no miner-specific endpoint', async () => {
      const res = await request(app).get('/api/mining/miners/wrf1miner');

      expect(res.status).toBe(501);
      expect(res.body.error).toBe('Not implemented');
    });
  });

  // --- POST /api/mining/submit ---

  describe('POST /api/mining/submit', () => {
    it('returns 501 because share submission is not implemented in core4', async () => {
      const res = await request(app)
        .post('/api/mining/submit')
        .send({ nonce: '0x1234', hash: '0xabcd', difficulty: 12500 });

      expect(res.status).toBe(501);
      expect(res.body.error).toBe('Not implemented');
    });
  });

  // --- GET /api/mining/stats/history ---

  describe('GET /api/mining/stats/history', () => {
    it('returns 501 because history is not exposed by core4', async () => {
      const res = await request(app).get('/api/mining/stats/history');

      expect(res.status).toBe(501);
      expect(res.body.error).toBe('Not implemented');
    });
  });

  // --- GET /api/mining/pools ---

  describe('GET /api/mining/pools', () => {
    it('returns 501 because core4 has no pool discovery endpoint', async () => {
      const res = await request(app).get('/api/mining/pools');

      expect(res.status).toBe(501);
      expect(res.body.error).toBe('Not implemented');
    });
  });

  // --- GET /api/mining/config ---

  describe('GET /api/mining/config', () => {
    it('returns default config with expected sections', async () => {
      const res = await request(app).get('/api/mining/config');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      const cfg = res.body.data;
      expect(cfg).toHaveProperty('algorithm');
      expect(cfg).toHaveProperty('pools');
      expect(cfg).toHaveProperty('workers');
      expect(cfg).toHaveProperty('hardware');
      expect(cfg).toHaveProperty('rewards');
      expect(cfg.algorithm.primary).toBe('sha256d');
    });
  });

  // --- POST /api/mining/config ---

  describe('POST /api/mining/config', () => {
    it('returns 400 when config id is missing', async () => {
      const res = await request(app)
        .post('/api/mining/config')
        .send({ name: 'test' });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('Configuration ID is required');
    });

    it('saves config when id is provided', async () => {
      const res = await request(app)
        .post('/api/mining/config')
        .send({ id: 'test-config', name: 'Test' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.id).toBe('test-config');
      expect(res.body.data.validated).toBe(true);
    });
  });

  // --- POST /api/mining/config/validate ---

  describe('POST /api/mining/config/validate', () => {
    it('returns validation error when algorithm.primary is missing', async () => {
      const res = await request(app)
        .post('/api/mining/config/validate')
        .send({ pools: { primary: { url: 'stratum+tcp://example:3333' } } });

      expect(res.status).toBe(200);
      const errors = res.body.data.validationResults.filter(
        (r: any) => r.type === 'error'
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0].field).toBe('algorithm.primary');
    });
  });
});
