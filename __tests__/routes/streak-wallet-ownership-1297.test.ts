/** backend#1297: streak routes for wallet-login callers (own id only; no write for another user). */
import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const WALLET = '0x' + 'ab'.repeat(20);
const MIXED = '0x' + 'Ab'.repeat(20);
const OTHER = '0x' + 'cd'.repeat(20);

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (req: any, _res: any, next: any) => {
    const who = req.get('x-test-caller');
    const wallet = who === 'wallet' ? WALLET : who === 'wallet-upper' ? '0X' + WALLET.slice(2).toUpperCase() : null;
    if (wallet) req.user = { id: wallet, userId: wallet, address: wallet, role: 'wallet', roles: ['wallet'], permissions: [] };
    if (who === 'session') req.user = { id: '3', userId: '3', roles: ['user'], sessionId: 's' };
    next();
  },
}));

const mockCheckInUser = jest.fn(async () => ({ checkedIn: true }));
const mockGetStreakSummary = jest.fn(async () => ({ currentStreak: 1 }));
const mockGetStreakBadges = jest.fn(async () => ({ badges: [] }));
jest.mock('../../server/services/streak-service.js', () => ({
  checkInUser: mockCheckInUser,
  getStreakSummary: mockGetStreakSummary,
  getStreakBadges: mockGetStreakBadges,
  initializeStreakSchema: jest.fn(async () => undefined),
}));

// users table: WALLET owns user 7.
const mockDb = {
  select: jest.fn(() => {
    const c: any = {};
    ['from', 'where', 'limit'].forEach((m) => { c[m] = jest.fn(() => c); });
    c.then = (resolve: any) => Promise.resolve([{ id: 7 }]).then(resolve);
    return c;
  }),
};
jest.mock('../../database/index.js', () => ({ db: mockDb }));
jest.mock('express-rate-limit', () => jest.fn(() => (_req: any, _res: any, next: any) => next()));

import { createStreakRouter } from '../../server/routes/streak-routes.js';
import { createWeatherStreakRouter } from '../../server/routes/weather-streak-routes.js';

function streakApp() {
  const app = express();
  app.use(express.json());
  app.use('/streaks', createStreakRouter());
  return app;
}

describe('streak-routes ownership for wallet callers', () => {
  beforeEach(() => jest.clearAllMocks());

  it('own id: summary, badges and check-in are allowed', async () => {
    expect((await request(streakApp()).get('/streaks/7').set('x-test-caller', 'wallet')).status).toBe(200);
    expect((await request(streakApp()).get('/streaks/7/badges').set('x-test-caller', 'wallet')).status).toBe(200);
    const res = await request(streakApp()).post('/streaks/7/check-in').set('x-test-caller', 'wallet').send({});
    expect(res.status).toBe(200);
    expect(mockCheckInUser).toHaveBeenCalledTimes(1);
  });

  it('ANOTHER user: reads are 403, and a check-in is 403 with NO write', async () => {
    expect((await request(streakApp()).get('/streaks/8').set('x-test-caller', 'wallet')).status).toBe(403);
    expect((await request(streakApp()).get('/streaks/8/badges').set('x-test-caller', 'wallet')).status).toBe(403);
    const res = await request(streakApp()).post('/streaks/8/check-in').set('x-test-caller', 'wallet').send({});
    expect(res.status).toBe(403);
    expect(mockCheckInUser).not.toHaveBeenCalled();
    expect(mockGetStreakSummary).not.toHaveBeenCalled();
    expect(mockGetStreakBadges).not.toHaveBeenCalled();
  });

  it('a session caller is unchanged: any user id, no ownership lookup', async () => {
    const res = await request(streakApp()).post('/streaks/8/check-in').set('x-test-caller', 'session').send({});
    expect(res.status).toBe(200);
    expect(mockCheckInUser).toHaveBeenCalledTimes(1);
    expect(mockDb.select).not.toHaveBeenCalled();
  });
});

describe('weather-streak-routes ownership for wallet callers', () => {
  function weatherApp() {
    const db = { execute: jest.fn(async () => ({ rows: [] })) };
    const app = express();
    app.use(express.json());
    app.use('/streak', createWeatherStreakRouter(db as any));
    return { app, db };
  }

  it('own address (any case) can be read; another address is 403 with no query', async () => {
    const own = weatherApp();
    expect((await request(own.app).get(`/streak/${MIXED}`).set('x-test-caller', 'wallet')).status).toBe(200);
    const upper = weatherApp();
    expect((await request(upper.app).get(`/streak/${WALLET}`).set('x-test-caller', 'wallet-upper')).status).toBe(200);
    const other = weatherApp();
    const res = await request(other.app).get(`/streak/${OTHER}`).set('x-test-caller', 'wallet');
    expect(res.status).toBe(403);
    expect(other.db.execute).not.toHaveBeenCalled();
  });

  it('mint-trigger for ANOTHER address is 403 with no write; for its own address it proceeds', async () => {
    const other = weatherApp();
    const res = await request(other.app).post('/streak/mint-trigger').set('x-test-caller', 'wallet').send({ walletAddress: OTHER, milestoneLevel: 7 });
    expect(res.status).toBe(403);
    expect(other.db.execute).not.toHaveBeenCalled();
    const own = weatherApp();
    const ok = await request(own.app).post('/streak/mint-trigger').set('x-test-caller', 'wallet').send({ walletAddress: MIXED, milestoneLevel: 7 });
    expect(ok.status).toBe(200);
    expect(own.db.execute).toHaveBeenCalledTimes(1);
  });

  it('a session caller is unchanged', async () => {
    const s = weatherApp();
    expect((await request(s.app).get(`/streak/${OTHER}`).set('x-test-caller', 'session')).status).toBe(200);
  });
});
