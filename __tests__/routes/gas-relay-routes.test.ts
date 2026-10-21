/**
 * Smoke tests: gas-relay-routes — HTTP request assertions.
 * Addresses #355 (converts stub to real tests) and #340.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockBuildPaymasterAndData = jest.fn();

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateSessionJWT: (_req: any, _res: any, next: any) => next(),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../server/services/gas-relay-service.js', () => ({
  buildPaymasterAndData: mockBuildPaymasterAndData,
  WEATHER_SELECTOR: '0xdeadbeef',
}));

import { createGasRelayRouter } from '../../server/routes/gas-relay-routes.js';

type Row = Record<string, unknown>;

function makeDb(responses: { rows: Row[] }[]) {
  let call = 0;
  return {
    execute: jest.fn(async (_sql: string, _params?: unknown[]) => {
      return responses[call++] ?? { rows: [] };
    }),
  };
}

const VALID_WALLET = '0xabc1234567890123456789012345678901234567';

function makeApp(db: ReturnType<typeof makeDb>) {
  const app = express();
  app.use(express.json());
  app.use('/relay', createGasRelayRouter(db as any));
  return app;
}

describe('gas-relay-routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('POST /sponsor', () => {
    it('returns 400 for missing walletAddress', async () => {
      const res = await request(makeApp(makeDb([]))).post('/relay/sponsor').send({});
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid walletAddress format', async () => {
      const res = await request(makeApp(makeDb([])))
        .post('/relay/sponsor')
        .send({ walletAddress: 'not-an-address' });
      expect(res.status).toBe(400);
    });

    it('returns 403 when no social account is linked', async () => {
      const db = makeDb([
        { rows: [] }, // no social account
      ]);
      const res = await request(makeApp(db))
        .post('/relay/sponsor')
        .send({ walletAddress: VALID_WALLET });
      expect(res.status).toBe(403);
      expect(res.body.error).toMatch(/social account/i);
    });

    it('returns 429 when daily sponsorship limit is reached', async () => {
      const db = makeDb([
        { rows: [{ id: 1 }] },   // social account exists
        { rows: [{ cnt: 5 }] },  // lifetime count under limit
        { rows: [{ cnt: 10 }] }, // daily count at limit
      ]);
      const res = await request(makeApp(db))
        .post('/relay/sponsor')
        .send({ walletAddress: VALID_WALLET });
      expect(res.status).toBe(429);
    });

    it('returns 200 with paymasterAndData on success', async () => {
      mockBuildPaymasterAndData.mockResolvedValue({
        paymasterAndData: '0xpaymaster',
        deadline: Date.now() + 60000,
        weatherDataHash: '0xhash',
        oracle: '0xoracle',
      });
      const db = makeDb([
        { rows: [{ id: 1 }] },  // social account
        { rows: [{ cnt: 0 }] }, // lifetime count
        { rows: [{ cnt: 0 }] }, // daily count
        { rows: [] },            // INSERT log
      ]);
      const res = await request(makeApp(db))
        .post('/relay/sponsor')
        .send({
          walletAddress: VALID_WALLET,
          userOp: { callData: '0xdeadbeef1234' },
        });
      expect(res.status).toBe(200);
      expect(res.body.paymasterAndData).toBe('0xpaymaster');
    });
  });
});
