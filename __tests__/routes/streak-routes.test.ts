/**
 * Smoke tests: streak-routes — HTTP request assertions.
 * Addresses #355 (converts stub to real tests) and #340.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockCheckInUser = jest.fn();
const mockGetStreakBadges = jest.fn();
const mockGetStreakSummary = jest.fn();

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../server/services/streak-service.js', () => ({
  checkInUser: mockCheckInUser,
  getStreakBadges: mockGetStreakBadges,
  getStreakSummary: mockGetStreakSummary,
}));

import { createStreakRouter } from '../../server/routes/streak-routes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/streaks', createStreakRouter());
  return app;
}

describe('streak-routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('GET /:userId', () => {
    it('returns 400 for non-numeric userId', async () => {
      const res = await request(makeApp()).get('/streaks/abc');
      expect(res.status).toBe(400);
    });

    it('returns 200 with streak summary for valid userId', async () => {
      mockGetStreakSummary.mockResolvedValue({ currentStreak: 3, longestStreak: 10 });
      const res = await request(makeApp()).get('/streaks/42');
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ currentStreak: 3 });
    });

    it('returns 500 when service throws', async () => {
      mockGetStreakSummary.mockRejectedValue(new Error('db error'));
      const res = await request(makeApp()).get('/streaks/42');
      expect(res.status).toBe(500);
    });
  });

  describe('POST /:userId/check-in', () => {
    it('returns 400 for non-numeric userId', async () => {
      const res = await request(makeApp()).post('/streaks/abc/check-in').send({});
      expect(res.status).toBe(400);
    });

    it('returns 200 when check-in succeeds', async () => {
      mockCheckInUser.mockResolvedValue({ streakDay: 4, awarded: true });
      const res = await request(makeApp()).post('/streaks/42/check-in').send({});
      expect(res.status).toBe(200);
      expect(res.body.streakDay).toBe(4);
    });
  });

  describe('GET /:userId/badges', () => {
    it('returns 400 for non-numeric userId', async () => {
      const res = await request(makeApp()).get('/streaks/abc/badges');
      expect(res.status).toBe(400);
    });

    it('returns 200 with badges array', async () => {
      mockGetStreakBadges.mockResolvedValue([{ badge: 'week-1', earned: true }]);
      const res = await request(makeApp()).get('/streaks/42/badges');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });
  });
});
