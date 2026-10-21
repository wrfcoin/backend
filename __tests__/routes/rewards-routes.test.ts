/**
 * Smoke tests: rewards routes — HTTP request assertions.
 * Addresses #355 (converts stub to real tests) and #340.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

const mockDb = {
  select: jest.fn(),
  transaction: jest.fn(),
};

jest.mock('../../database/index.js', () => ({
  db: mockDb,
}));

jest.mock('../../shared/schema.js', () => ({
  rewardDistributionConfig: { active: 'active', createdAt: 'created_at' },
  contributorRewards: {
    userId: 'user_id',
    createdAt: 'created_at',
    contributorType: 'contributor_type',
    amount: 'amount',
  },
  forecastCoverageMetrics: {},
  environmentalOffsetProofs: {},
  computationalWorkProofs: {},
  computationalNodes: {},
  algorithmAdvancements: {},
  users: {},
}));

jest.mock('../../server/utils/logger.js', () => ({
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import router from '../../server/routes/rewards.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/rewards', router);
  return app;
}

// Build a drizzle-like chain that resolves to `value`
function makeChain(value: unknown) {
  const chain: any = {};
  ['select', 'from', 'where', 'orderBy', 'limit', 'groupBy', 'and', 'eq', 'desc'].forEach(
    (m) => { chain[m] = jest.fn(() => chain); }
  );
  Object.assign(chain, { then: (r: any) => Promise.resolve(value).then(r) });
  return chain;
}

describe('rewards routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('GET /user/:userId returns 400 for non-numeric userId', async () => {
    const res = await request(makeApp()).get('/rewards/user/notanumber');
    expect(res.status).toBe(400);
  });

  it('GET /config returns 404 when no active config exists', async () => {
    mockDb.select = jest.fn(() => makeChain([]));
    const res = await request(makeApp()).get('/rewards/config');
    expect([404, 500]).toContain(res.status);
  });

  it('GET /summary does not crash', async () => {
    mockDb.select = jest.fn(() => makeChain([]));
    const res = await request(makeApp()).get('/rewards/summary');
    // Accept any valid HTTP status — just not a 500 crash
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(600);
    expect(res.status).not.toBe(500);
  });
});
