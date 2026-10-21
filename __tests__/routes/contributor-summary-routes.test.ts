/**
 * Tests for contributor summary endpoint — backend#684.
 *
 * GET /api/contributor/:address/summary
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any import that uses them
// ---------------------------------------------------------------------------

const mockRedisGet = jest.fn<() => Promise<string | null>>().mockResolvedValue(null);
const mockRedisSet = jest.fn<() => Promise<'OK'>>().mockResolvedValue('OK');

jest.mock('../../server/utils/create-redis.js', () => ({
  createRedisClient: jest.fn(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
  })),
}));

const mockGetStreakSummary = jest.fn<() => Promise<{ currentStreak: number; longestStreak: number; nextMilestone: number | null; milestoneReached: boolean }>>().mockResolvedValue({
  currentStreak: 7,
  longestStreak: 30,
  nextMilestone: null,
  milestoneReached: false,
});

jest.mock('../../server/services/streak-service.js', () => ({
  getStreakSummary: mockGetStreakSummary,
}));

const mockGetScore = jest.fn<() => Promise<{ compositeScore: number; badges: string[] }>>().mockResolvedValue({
  compositeScore: 82,
  badges: ['streak_7', 'storm_chaser'],
});

jest.mock('../../server/services/reputation/reputation-scoring-engine.js', () => ({
  reputationScoringEngine: { getScore: mockGetScore },
}));

const mockMetricsRegistry = {
  getSingleMetric: jest.fn<(name: string) => undefined>().mockReturnValue(undefined),
};

jest.mock('../../server/utils/metrics.js', () => ({
  metricsRegistry: mockMetricsRegistry,
}));

const mockCounterInc = jest.fn();
jest.mock('prom-client', () => ({
  Counter: jest.fn().mockImplementation(() => ({ inc: mockCounterInc })),
}));

jest.mock('../../shared/middleware/rate-limit-redis.js', () => ({
  createRateLimitMiddleware: jest.fn(() => (_req: any, _res: any, next: any) => next()),
  RATE_LIMIT_PRESETS: { api: { windowMs: 60_000, maxRequests: 100, keyPrefix: 'ratelimit:api' } },
}));

jest.mock('../../server/utils/logger.js', () => ({
  appLogger: { debug: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() },
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

import { createContributorSummaryRouter } from '../../server/routes/contributor-summary-routes.js';

type Row = Record<string, unknown>;

function makeDb(sequences: Array<{ rows: Row[] }>) {
  let idx = 0;
  return {
    execute: jest.fn(async (_sql: string, _params?: unknown[]) => sequences[idx++] ?? { rows: [] }),
  };
}

const VALID_ADDRESS = '0xAbCd1234567890AbCd1234567890AbCd12345678';

function makeFullDb() {
  return makeDb([
    // fetchUserRow
    { rows: [{ id: 1, display_name: 'Alice', created_at: '2025-01-15T00:00:00Z' }] },
    // fetchReferralsActivated
    { rows: [{ cnt: 3 }] },
    // fetchSubmissionsData
    { rows: [{ total_30d: 42, quality_avg: 0.91 }] },
    // fetchTotalEarnedWrf
    { rows: [{ total: 500 }] },
    // fetchWeeklyRank
    { rows: [{ rank: 12 }] },
  ]);
}

function makeApp(db: ReturnType<typeof makeDb>) {
  const app = express();
  app.use(express.json());
  app.use('/contributor', createContributorSummaryRouter(db as any));
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /contributor/:address/summary', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRedisGet.mockResolvedValue(null);
    mockRedisSet.mockResolvedValue('OK');
    mockGetStreakSummary.mockResolvedValue({
      currentStreak: 7,
      longestStreak: 30,
      nextMilestone: null,
      milestoneReached: false,
    });
    mockGetScore.mockResolvedValue({ compositeScore: 82, badges: ['streak_7', 'storm_chaser'] });
  });

  it('returns 400 for a malformed address', async () => {
    const app = makeApp(makeDb([]));
    const res = await request(app).get('/contributor/notanaddress/summary');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'INVALID_ETHEREUM_ADDRESS',
      message: 'Invalid Ethereum address format',
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('returns 400 for a too-short hex address', async () => {
    const app = makeApp(makeDb([]));
    const res = await request(app).get('/contributor/0x1234/summary');
    expect(res.status).toBe(400);
  });

  it('returns 200 with consolidated summary for a valid address', async () => {
    const db = makeFullDb();
    const app = makeApp(db);
    const res = await request(app).get(`/contributor/${VALID_ADDRESS}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const { data } = res.body;
    expect(data.address).toBe(VALID_ADDRESS.toLowerCase());
    expect(data.display_name).toBe('Alice');
    expect(data.joined_at).toBe('2025-01-15T00:00:00Z');
    expect(data.current_streak_days).toBe(7);
    expect(data.longest_streak_days).toBe(30);
    expect(data.total_submissions_30d).toBe(42);
    expect(data.quality_score_avg).toBeCloseTo(0.91);
    expect(data.reputation_pct).toBe(82);
    expect(data.total_earned_wrf).toBe(500);
    expect(data.referrals_activated).toBe(3);
    expect(data.badges).toHaveLength(2);
    expect(data.badges[0]).toMatchObject({ kind: 'streak_7' });
    expect(data.rank_weekly).toBe(12);
  });

  it('returns zeroed numeric fields when address has no activity', async () => {
    const db = makeDb([
      { rows: [] }, // fetchUserRow → no user
      { rows: [{ cnt: 0 }] }, // referrals
      { rows: [{ total_30d: 0, quality_avg: null }] }, // submissions
      // earnedWrf and rank skipped (no userId)
      { rows: [] }, // weeklyRank
    ]);
    const app = makeApp(db);

    // Reputation engine returns default score even for unknown addresses
    mockGetScore.mockResolvedValue({ compositeScore: 0, badges: [] });
    // No userId → streak service not called
    mockGetStreakSummary.mockResolvedValue({
      currentStreak: 0,
      longestStreak: 0,
      nextMilestone: 7,
      milestoneReached: false,
    });

    const res = await request(app).get(`/contributor/${VALID_ADDRESS}/summary`);
    expect(res.status).toBe(200);
    const { data } = res.body;
    expect(data.display_name).toBeNull();
    expect(data.joined_at).toBeNull();
    expect(data.current_streak_days).toBe(0);
    expect(data.longest_streak_days).toBe(0);
    expect(data.total_submissions_30d).toBe(0);
    expect(data.quality_score_avg).toBeNull();
    expect(data.total_earned_wrf).toBe(0);
    expect(data.referrals_activated).toBe(0);
    expect(data.badges).toHaveLength(0);
    // streak service should not have been called since there's no userId
    expect(mockGetStreakSummary).not.toHaveBeenCalled();
  });

  it('returns cached response on cache hit without hitting db', async () => {
    const cachedData = {
      address: VALID_ADDRESS.toLowerCase(),
      display_name: 'Cached Alice',
      joined_at: '2025-01-01T00:00:00Z',
      current_streak_days: 5,
      longest_streak_days: 20,
      total_submissions_30d: 10,
      quality_score_avg: 0.85,
      reputation_pct: 70,
      total_earned_wrf: 100,
      referrals_activated: 1,
      badges: [],
      rank_weekly: 5,
    };
    mockRedisGet.mockResolvedValueOnce(JSON.stringify(cachedData));

    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get(`/contributor/${VALID_ADDRESS}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.data.display_name).toBe('Cached Alice');
    // DB should not have been queried at all
    expect(db.execute).not.toHaveBeenCalled();
    expect(mockGetStreakSummary).not.toHaveBeenCalled();
  });

  it('sets Cache-Control: max-age=30 on a fresh response', async () => {
    const db = makeFullDb();
    const app = makeApp(db);
    const res = await request(app).get(`/contributor/${VALID_ADDRESS}/summary`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toMatch(/max-age=30/);
  });

  it('sets Cache-Control: max-age=30 on a cached response', async () => {
    mockRedisGet.mockResolvedValueOnce(JSON.stringify({ address: VALID_ADDRESS.toLowerCase() }));
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get(`/contributor/${VALID_ADDRESS}/summary`);
    expect(res.headers['cache-control']).toMatch(/max-age=30/);
  });

  it('increments the Prometheus counter on each request', async () => {
    const db = makeFullDb();
    const app = makeApp(db);
    await request(app).get(`/contributor/${VALID_ADDRESS}/summary`);
    expect(mockCounterInc).toHaveBeenCalledTimes(1);
  });
});
