import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockSelectWhere = jest.fn();
const mockSelectFrom = jest.fn(() => ({ where: mockSelectWhere }));
const mockSelect = jest.fn(() => ({ from: mockSelectFrom }));

const mockAppLoggerError = jest.fn();

jest.mock('../../database/connection.js', () => ({
  db: {
    select: mockSelect,
  },
}));

// auth-middleware.ts (wallet JWT verification, used unmocked) also exports
// API-key auth; its service pulls the DB schema, which the drizzle mock below
// cannot satisfy. authenticateToken does not use it.
jest.mock('../../server/services/api-key-service.js', () => ({ apiKeyService: {} }));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((_left: unknown, _right: unknown) => ({ type: 'eq' })),
  and: jest.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
}));

jest.mock('../../shared/schema-engagement.js', () => ({
  referrals: {
    referralCode: 'referralCode',
    referrerAddress: 'referrerAddress',
    refereeAddress: 'refereeAddress',
    rewardAmountWrf: 'rewardAmountWrf',
    status: 'status',
  },
  REFERRAL_STATUS: {
    PENDING: 'pending',
    ACTIVATED: 'activated',
    REWARDED: 'rewarded',
  },
}));

jest.mock('../../server/utils/metrics.js', () => ({
  recordReferralFunnelStep: jest.fn(),
}));

jest.mock('../../server/utils/logger.js', () => ({
  appLogger: {
    error: mockAppLoggerError,
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import router from '../../server/routes/referral-routes.ts';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/referrals', router);
  return app;
}

describe('GET /api/referrals/stats/:walletAddress', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectWhere.mockReset();
  });

  it('returns referral stats on success and never reports a recorded amount as earned', async () => {
    // backend#1178: a recorded reward_amount_wrf was never paid (no on-chain
    // referral payout exists), so it must not surface as earned WRF.
    mockSelectWhere.mockResolvedValueOnce([
      { status: 'pending', rewardAmountWrf: 0 },
      { status: 'activated', rewardAmountWrf: null },
      { status: 'rewarded', rewardAmountWrf: 100 },
      { status: 'rewarded', rewardAmountWrf: 50 },
    ]);

    const res = await request(makeApp()).get('/api/referrals/stats/0xABC');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toEqual({
      walletAddress: '0xabc',
      totalReferrals: 4,
      byStatus: { pending: 1, activated: 1, rewarded: 2 },
      pendingActivations: 1,
      earnedWrf: 0,
      totalRewardsWrf: 0,
      reward: { state: 'not_paid', reason: 'no on-chain referral payout exists' },
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('returns a generic canonical 500 envelope and suppresses raw errors', async () => {
    mockSelectWhere.mockRejectedValueOnce(new Error('stats query exploded'));

    const res = await request(makeApp()).get('/api/referrals/stats/0xabc');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'REFERRAL_STATS_FETCH_FAILED',
      message: 'Failed to fetch referral stats',
    });
    expect(typeof res.body.timestamp).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('stats query exploded');
    expect(mockAppLoggerError).toHaveBeenCalledWith('Referral stats fetch failed', {
      error: 'stats query exploded',
    });
  });
});
