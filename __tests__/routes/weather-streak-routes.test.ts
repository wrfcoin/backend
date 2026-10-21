/**
 * Smoke tests: weather-streak-routes — HTTP request assertions.
 * Addresses #355 (converts stub to real tests) and #340.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

jest.mock('express-rate-limit', () =>
  jest.fn(() => (_req: any, _res: any, next: any) => next())
);

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

import { createWeatherStreakRouter } from '../../server/routes/weather-streak-routes.js';

type Row = Record<string, unknown>;

function makeDb(responses: { rows: Row[] }[]) {
  let call = 0;
  return {
    execute: jest.fn(async (_sql: string, _params?: unknown[]) => {
      return responses[call++] ?? { rows: [] };
    }),
  };
}

function makeApp(db: ReturnType<typeof makeDb>) {
  const app = express();
  app.use(express.json());
  app.use('/streak', createWeatherStreakRouter(db as any));
  return app;
}

const VALID_WALLET = '0xabc1234567890123456789012345678901234567';

describe('weather-streak-routes', () => {
  describe('GET /:walletAddress', () => {
    it('returns 400 for invalid wallet address', async () => {
      const app = makeApp(makeDb([]));
      const res = await request(app).get('/streak/notavalidaddress');
      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it('returns 200 with streak data for valid wallet', async () => {
      // DB calls in order:
      // 1. SELECT id FROM users WHERE wallet_address = $1
      // 2. recursive CTE → current_streak
      // 3. islands CTE → longest_streak
      // 4. SELECT milestone_days FROM streak_milestones_claimed
      const db = makeDb([
        { rows: [{ id: 1 }] },               // user lookup
        { rows: [{ current_streak: 5 }] },   // streak walk CTE
        { rows: [{ longest_streak: 12 }] },  // islands CTE
        { rows: [] },                          // claimed milestones
      ]);
      const app = makeApp(db);
      const res = await request(app).get(`/streak/${VALID_WALLET}`);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        currentStreak: 5,
        longestStreak: 12,
      });
    });

    it('returns 200 with zeroed streaks when user has no submissions', async () => {
      // userId is null — only milestones query runs after user lookup
      const db = makeDb([
        { rows: [] },  // user not found
        { rows: [] },  // claimed milestones
      ]);
      const app = makeApp(db);
      const res = await request(app).get(`/streak/${VALID_WALLET}`);
      expect(res.status).toBe(200);
      expect(res.body.currentStreak).toBe(0);
    });
  });

  describe('POST /mint-trigger', () => {
    it('returns 400 for missing walletAddress', async () => {
      const app = makeApp(makeDb([]));
      const res = await request(app)
        .post('/streak/mint-trigger')
        .send({ milestoneLevel: 7 });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid milestoneLevel', async () => {
      const app = makeApp(makeDb([]));
      const res = await request(app)
        .post('/streak/mint-trigger')
        .send({ walletAddress: VALID_WALLET, milestoneLevel: 99 });
      expect(res.status).toBe(400);
    });

    it('returns 200 when milestone is recorded', async () => {
      const db = makeDb([
        { rows: [] }, // INSERT ON CONFLICT DO NOTHING
      ]);
      const app = makeApp(db);
      const res = await request(app)
        .post('/streak/mint-trigger')
        .send({ walletAddress: VALID_WALLET, milestoneLevel: 7 });
      expect(res.status).toBe(200);
      expect(res.body.recorded).toBe(true);
    });
  });
});
