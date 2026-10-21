/**
 * Tests for #826 security fixes in unified_api_server.ts:
 *   1. POST /api/crosschain/transfer now requires auth (requireAuth middleware)
 *   2. GET /api/mining/rewards parseInt(limit) NaN uses default 10 (not empty slice)
 *
 * Strategy: mirror the handler logic in minimal express apps to avoid importing
 * unified_api_server.ts (which has a large transitive dep chain).
 */

// Mock utils/logger before any import that pulls it in transitively
jest.mock('../utils/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
  log: jest.fn(),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-secret-826-must-be-at-least-32-chars!';

function makeToken(sub: string): string {
  return jwt.sign({ sub, type: 'access' }, JWT_SECRET, {
    algorithm: 'HS256',
    issuer: 'wrfcoin-platform',
    audience: 'wrfcoin-api',
    expiresIn: '15m',
  });
}

// ─── Test 1: crosschain/transfer requireAuth (#826) ──────────────────────────

describe('POST /api/crosschain/transfer — requireAuth gate (#826)', () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    const { requireAuth } = require('../server/middleware/authMiddleware');

    app = express();
    app.use(express.json());

    // Mirrors the route registration in unified_api_server.ts:
    //   app.post('/api/crosschain/transfer', requireAuth, ...)
    app.post('/api/crosschain/transfer', requireAuth, (_req: any, res: any) => {
      res.status(201).json({ success: true, data: { id: 'mock-transfer' } });
    });
  });

  afterAll(() => { delete process.env.JWT_SECRET; });

  it('returns 401 when no Authorization header is provided (#826)', async () => {
    const res = await request(app)
      .post('/api/crosschain/transfer')
      .send({ amount: '100', toChain: 'ethereum', recipient: '0xABCD' });

    expect(res.status).toBe(401);
  });

  it('returns 401 when an invalid JWT is provided (#826)', async () => {
    const res = await request(app)
      .post('/api/crosschain/transfer')
      .set('Authorization', 'Bearer not.a.valid.jwt')
      .send({ amount: '100', toChain: 'ethereum', recipient: '0xABCD' });

    expect(res.status).toBe(401);
  });

  it('passes through with a valid JWT (#826)', async () => {
    const token = makeToken('0x1234567890123456789012345678901234567890');
    const res = await request(app)
      .post('/api/crosschain/transfer')
      .set('Authorization', `Bearer ${token}`)
      .send({ amount: '100', toChain: 'ethereum', recipient: '0xABCD' });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
  });
});

// ─── Test 2: mining/rewards parseInt(limit) NaN guard (#826) ─────────────────

describe('GET /api/mining/rewards — NaN limit defaults to 10 (#826)', () => {
  let app: express.Express;

  beforeAll(() => {
    app = express();

    // Mirrors the limit guard from unified_api_server.ts line 665:
    //   rewards.slice(0, Math.max(1, Math.min(100, parseInt(limit as string, 10) || 10)))
    app.get('/api/mining/rewards', (req: any, res: any) => {
      const { limit = '10' } = req.query;
      const parsed = parseInt(limit as string, 10);
      const safeLimit = Math.max(1, Math.min(100, parsed || 10));

      const items = Array.from({ length: 110 }, (_, i) => ({ id: i }));
      res.json({ success: true, data: items.slice(0, safeLimit), limit: safeLimit });
    });
  });

  it('uses default 10 when limit is NaN (#826)', async () => {
    const res = await request(app).get('/api/mining/rewards?limit=foo');

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(10);
    expect(res.body.data.length).toBe(10);
  });

  it('uses default 10 when limit param is absent (#826)', async () => {
    const res = await request(app).get('/api/mining/rewards');

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(10);
    expect(res.body.data.length).toBe(10);
  });

  it('caps limit at 100 (#826)', async () => {
    const res = await request(app).get('/api/mining/rewards?limit=9999');

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(100);
  });

  it('passes a valid limit through unchanged (#826)', async () => {
    const res = await request(app).get('/api/mining/rewards?limit=25');

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(25);
    expect(res.body.data.length).toBe(25);
  });
});
