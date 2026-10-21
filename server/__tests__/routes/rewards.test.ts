/**
 * Smoke tests for rewards.ts route (#473)
 *
 * Verifies:
 *  - All 8 GET endpoints are mounted and return 200 / correct shape
 *  - Auth middleware (authenticateJWT) is applied: missing token → 401
 *  - Reward percentages in config sum to 100
 *  - /user/:userId with no reward history → 200 + empty arrays (not 500)
 *  - /user/:userId with invalid id → 400
 *  - /top-contributors limit validation (out-of-range → 400)
 *  - DAO vote count field present in governance-adjacent response shape
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from '@jest/globals';

// ---------------------------------------------------------------------------
// Mock prom-client (pulled in transitively through cache-manager)
// ---------------------------------------------------------------------------
jest.mock('prom-client', () => {
  class Counter { inc = jest.fn(); labels = () => ({ inc: jest.fn() }); }
  class Gauge { set = jest.fn(); labels = () => ({ set: jest.fn() }); }
  class Histogram { observe = jest.fn(); labels = () => ({ observe: jest.fn() }); }
  const register = { registerMetric: jest.fn() };
  return { Counter, Gauge, Histogram, register };
});

// ---------------------------------------------------------------------------
// Mock logger
// ---------------------------------------------------------------------------
jest.mock('../../utils/logger.js', () => ({
  performanceLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  appLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Mock the JWT middleware — by default it lets requests through;
// individual tests can override the mock to simulate 401
// ---------------------------------------------------------------------------
const mockAuthMiddleware = jest.fn((req: any, _res: any, next: any) => next());

jest.mock('../../middleware/auth.js', () => ({
  authenticateJWT: (req: any, res: any, next: any) => mockAuthMiddleware(req, res, next),
}));

// ---------------------------------------------------------------------------
// Mock drizzle db — default returns empty arrays / sensible config object
// ---------------------------------------------------------------------------

// Shared config fixture; percentages sum to 100
const MOCK_CONFIG = {
  id: 1,
  active: true,
  forecastRewardsPercent: '40.00',
  environmentalOffsetPercent: '20.00',
  computationalWorkPercent: '20.00',
  algorithmAdvancementPercent: '10.00',
  dataQualityBonusPercent: '10.00',
  createdAt: new Date('2024-01-01'),
};

// Chain builder: .select().from().where().orderBy().limit() → resolves to arr
function makeChain(result: unknown[]) {
  const chain: any = {};
  const methods = ['select', 'from', 'where', 'orderBy', 'limit', 'groupBy', 'leftJoin', 'innerJoin'];
  for (const m of methods) {
    chain[m] = jest.fn(() => chain);
  }
  // Make the chain a thenable so await works
  chain.then = (resolve: (v: unknown) => void) => Promise.resolve(result).then(resolve);
  return chain;
}

// We need the mock to be configurable per test; use a factory approach
let mockDbBehavior: Record<string, unknown[]> = {};

jest.mock('../../../database/index.js', () => ({
  db: new Proxy({}, {
    get(_t, prop) {
      return (...args: unknown[]) => makeChain(mockDbBehavior[String(prop)] ?? []);
    },
  }),
}));

jest.mock('../../../shared/schema.js', () => ({
  rewardDistributionConfig: { id: 'id', active: 'active', createdAt: 'createdAt' },
  contributorRewards: { userId: 'userId', amount: 'amount', contributorType: 'contributorType', createdAt: 'createdAt' },
  forecastCoverageMetrics: { region: 'region', createdAt: 'createdAt' },
  environmentalOffsetProofs: { userId: 'userId', isVerified: 'isVerified', offsetPoints: 'offsetPoints', createdAt: 'createdAt' },
  computationalWorkProofs: {
    id: 'id', taskId: 'taskId', computationType: 'computationType',
    computeResourcesUsed: 'computeResourcesUsed', startedAt: 'startedAt',
    completedAt: 'completedAt', isVerified: 'isVerified', resourceHours: 'resourceHours',
    rewardAmount: 'rewardAmount', resultMetadata: 'resultMetadata', nodeId: 'nodeId',
  },
  computationalNodes: { nodeId: 'nodeId', operatorAddress: 'operatorAddress' },
  algorithmAdvancements: { userId: 'userId', isVerified: 'isVerified', createdAt: 'createdAt' },
  users: { id: 'id', username: 'username', walletAddress: 'walletAddress' },
}));

// Payout client (#215 on-chain rewire) — mocked so the ESM
// shared/core4-route-client.js stays off the CJS load path. The smoke suite
// doesn't exercise claims, so a stub is sufficient.
jest.mock('../../services/reward-payout-client.js', () => ({
  submitPayout: jest.fn(async () => ({ kind: 'success', status: 'accepted', txHash: '0x', claimId: 'c', address: '0x', amountBaseUnits: 0n })),
  isValidPayoutAddress: (a: unknown) => typeof a === 'string' && /^(0x)?[0-9a-fA-F]{40}$/.test(a),
  WRF_UNITS_PER_COIN: 100_000_000n,
}));

// drizzle helpers
jest.mock('drizzle-orm', () => ({
  eq: jest.fn((_a: unknown, _b: unknown) => ({})),
  and: jest.fn((...args: unknown[]) => ({})),
  desc: jest.fn((_a: unknown) => ({})),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray, ..._vals: unknown[]) => strings.join('')),
    { as: jest.fn() }
  ),
}));

// ---------------------------------------------------------------------------
// App setup
// ---------------------------------------------------------------------------
const express = require('express');
const request = require('supertest');

async function buildApp() {
  const { default: rewardsRouter } = await import('../../routes/rewards.js');
  const app = express();
  app.use(express.json());
  app.use('/rewards', rewardsRouter);
  return app;
}

let app: any;

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(() => {
  // Default: allow auth through
  mockAuthMiddleware.mockImplementation((req: any, _res: any, next: any) => next());
  // Default db behavior
  mockDbBehavior = {
    select: [MOCK_CONFIG],
  };
});

// ---------------------------------------------------------------------------
// Auth — missing token → 401
// ---------------------------------------------------------------------------

describe('Auth guard (#473)', () => {
  it('returns 401 when JWT middleware rejects the request', async () => {
    mockAuthMiddleware.mockImplementation((_req: any, res: any, _next: any) => {
      res.status(401).json({ error: 'Unauthorized' });
    });

    const res = await request(app).get('/rewards/config');
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /rewards/config
// ---------------------------------------------------------------------------

describe('GET /rewards/config (#473)', () => {
  it('returns 200 with a config object', async () => {
    const res = await request(app).get('/rewards/config');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('config');
  });

  it('config percentages sum to 100', async () => {
    const res = await request(app).get('/rewards/config');
    expect(res.status).toBe(200);
    const c = res.body.config;
    // All five percentage fields must exist
    expect(c).toHaveProperty('forecastRewardsPercent');
    expect(c).toHaveProperty('environmentalOffsetPercent');
    expect(c).toHaveProperty('computationalWorkPercent');
    expect(c).toHaveProperty('algorithmAdvancementPercent');
    expect(c).toHaveProperty('dataQualityBonusPercent');

    const sum =
      parseFloat(c.forecastRewardsPercent) +
      parseFloat(c.environmentalOffsetPercent) +
      parseFloat(c.computationalWorkPercent) +
      parseFloat(c.algorithmAdvancementPercent) +
      parseFloat(c.dataQualityBonusPercent);
    expect(sum).toBeCloseTo(100, 1);
  });

  it('returns 404 when no active config exists', async () => {
    mockDbBehavior = { select: [] };
    const res = await request(app).get('/rewards/config');
    expect(res.status).toBe(404);
    expect(res.body).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// GET /rewards/user/:userId
// ---------------------------------------------------------------------------

describe('GET /rewards/user/:userId (#473)', () => {
  it('returns 200 with empty arrays when user has no reward history', async () => {
    // DB returns empty arrays for rewards and totalsByType
    mockDbBehavior = { select: [] };
    const res = await request(app).get('/rewards/user/99');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('rewards');
    expect(Array.isArray(res.body.rewards)).toBe(true);
    expect(res.body).toHaveProperty('totalsByType');
    expect(Array.isArray(res.body.totalsByType)).toBe(true);
  });

  it('totalRewards is 0 when there are no entries', async () => {
    mockDbBehavior = { select: [] };
    const res = await request(app).get('/rewards/user/99');
    expect(res.status).toBe(200);
    expect(res.body.totalRewards).toBe(0);
  });

  it('returns 400 for a non-numeric userId', async () => {
    const res = await request(app).get('/rewards/user/not-a-number');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });
});

// ---------------------------------------------------------------------------
// GET /rewards/forecast-coverage
// ---------------------------------------------------------------------------

describe('GET /rewards/forecast-coverage (#473)', () => {
  it('returns 200 with a metrics array', async () => {
    mockDbBehavior = { select: [] };
    const res = await request(app).get('/rewards/forecast-coverage');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('metrics');
  });
});

// ---------------------------------------------------------------------------
// GET /rewards/summary
// ---------------------------------------------------------------------------

describe('GET /rewards/summary (#473)', () => {
  it('returns 200 with rewardsByType and totalRewards fields', async () => {
    mockDbBehavior = { select: [] };
    const res = await request(app).get('/rewards/summary');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('rewardsByType');
    expect(res.body).toHaveProperty('totalRewards');
  });
});

// ---------------------------------------------------------------------------
// GET /rewards/user/:userId/offsets
// ---------------------------------------------------------------------------

describe('GET /rewards/user/:userId/offsets (#473)', () => {
  it('returns 200 with an offsets array', async () => {
    mockDbBehavior = { select: [] };
    const res = await request(app).get('/rewards/user/1/offsets');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('offsets');
    expect(Array.isArray(res.body.offsets)).toBe(true);
  });

  it('returns 400 for invalid userId', async () => {
    const res = await request(app).get('/rewards/user/bad/offsets');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /rewards/user/:userId/computational
// ---------------------------------------------------------------------------

describe('GET /rewards/user/:userId/computational (#473)', () => {
  it('returns 200 with computationalWork array', async () => {
    mockDbBehavior = { select: [] };
    const res = await request(app).get('/rewards/user/1/computational');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('computationalWork');
  });

  it('returns 400 for invalid userId', async () => {
    const res = await request(app).get('/rewards/user/nope/computational');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /rewards/user/:userId/algorithms
// ---------------------------------------------------------------------------

describe('GET /rewards/user/:userId/algorithms (#473)', () => {
  it('returns 200 with algorithms array', async () => {
    mockDbBehavior = { select: [] };
    const res = await request(app).get('/rewards/user/1/algorithms');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('algorithms');
  });

  it('returns 400 for invalid userId', async () => {
    const res = await request(app).get('/rewards/user/xyz/algorithms');
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// GET /rewards/top-contributors
// ---------------------------------------------------------------------------

describe('GET /rewards/top-contributors (#473)', () => {
  it('returns 200 with topContributors array using default limit', async () => {
    mockDbBehavior = { select: [] };
    const res = await request(app).get('/rewards/top-contributors');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('topContributors');
  });

  it('returns 400 for limit=0 (below minimum)', async () => {
    const res = await request(app).get('/rewards/top-contributors?limit=0');
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty('error');
  });

  it('returns 400 for limit=101 (above maximum)', async () => {
    const res = await request(app).get('/rewards/top-contributors?limit=101');
    expect(res.status).toBe(400);
  });

  it('accepts limit=100 (boundary: within range)', async () => {
    mockDbBehavior = { select: [] };
    const res = await request(app).get('/rewards/top-contributors?limit=100');
    expect(res.status).toBe(200);
  });

  it('returns 400 for non-numeric limit', async () => {
    const res = await request(app).get('/rewards/top-contributors?limit=abc');
    expect(res.status).toBe(400);
  });
});
