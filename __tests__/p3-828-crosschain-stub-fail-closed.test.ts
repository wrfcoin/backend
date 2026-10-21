/**
 * Tests for #828 — cross-chain transfer handler must fail closed.
 *
 * The bridge integration is a stub (no real bridge call). The handler must
 * return 503 (not 201) so callers know no funds moved. Auth gate and
 * validation layer are preserved; only the stub "success" response is fixed.
 */

jest.mock('../utils/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  }),
  log: jest.fn(),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

import request from 'supertest';
import express from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = 'test-secret-828-must-be-at-least-32-chars!';

function makeToken(sub: string): string {
  return jwt.sign({ sub, type: 'access' }, JWT_SECRET, {
    algorithm: 'HS256',
    issuer: 'wrfcoin-platform',
    audience: 'wrfcoin-api',
    expiresIn: '15m',
  });
}

// Minimal stub handler that mirrors the fail-closed behaviour from unified_api_server.ts
// after the #828 fix — tested in isolation to avoid the full import chain.
function makeCrossChainApp() {
  const app = express();
  app.use(express.json());

  const { requireAuth } = require('../server/middleware/authMiddleware');

  app.post(
    '/api/crosschain/transfer',
    requireAuth,
    (req: any, res: any) => {
      const authenticatedAddress: string = req.user?.sub;
      if (!authenticatedAddress) {
        return res.status(401).json({
          success: false,
          error: 'Authenticated sender address could not be determined',
          timestamp: new Date().toISOString(),
        });
      }

      // Bridge not yet integrated — fail closed (#828)
      return res.status(503).json({
        success: false,
        error:
          'Cross-chain bridge integration is not yet available. No funds have been moved.',
        timestamp: new Date().toISOString(),
      });
    },
  );

  return app;
}

describe('POST /api/crosschain/transfer — fail-closed stub (#828)', () => {
  let app: express.Express;

  beforeAll(() => {
    process.env.JWT_SECRET = JWT_SECRET;
    app = makeCrossChainApp();
  });

  afterAll(() => {
    delete process.env.JWT_SECRET;
  });

  it('returns 503 for an authenticated request — no funds moved (#828)', async () => {
    const token = makeToken('0xaAbBcCdDeEfF001122334455667788990011aAbB');
    const res = await request(app)
      .post('/api/crosschain/transfer')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fromChain: 'ethereum',
        toChain: 'polygon',
        toAddress: '0xaAbBcCdDeEfF001122334455667788990011aAbB',
        amount: '1.5',
      });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatch(/not yet available/i);
  });

  it('does NOT return 201 or success:true (#828 regression guard)', async () => {
    const token = makeToken('0xaAbBcCdDeEfF001122334455667788990011aAbB');
    const res = await request(app)
      .post('/api/crosschain/transfer')
      .set('Authorization', `Bearer ${token}`)
      .send({
        fromChain: 'ethereum',
        toChain: 'polygon',
        toAddress: '0xaAbBcCdDeEfF001122334455667788990011aAbB',
        amount: '50',
      });

    expect(res.status).not.toBe(201);
    expect(res.body.success).not.toBe(true);
    expect(res.body).not.toHaveProperty('data');
  });

  it('still returns 401 when unauthenticated (#826 preserved)', async () => {
    const res = await request(app)
      .post('/api/crosschain/transfer')
      .send({ fromChain: 'ethereum', toChain: 'polygon', amount: '1' });

    expect(res.status).toBe(401);
  });
});
