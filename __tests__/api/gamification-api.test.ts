import express from 'express';
import request from 'supertest';
import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';

const mockAwardAchievement = jest.fn();
const mockGetUserProfile = jest.fn();

jest.mock('../../services/gamification-service.js', () => ({
  gamificationService: {
    achievements: {
      achievement_1: {
        id: 'achievement_1',
        category: 'governance',
        rarity: 'common',
      },
    },
    awardAchievement: mockAwardAchievement,
    getUserProfile: mockGetUserProfile,
    getLeaderboard: jest.fn(),
    levelThresholds: [],
    userStats: new Map(),
    getUserLevel: jest.fn(),
    recordVote: jest.fn(),
    recordProposalCreation: jest.fn(),
    recordDelegation: jest.fn(),
    getUserStats: jest.fn(),
  },
}));

import gamificationRouter from '../../api/gamification-api.js';

const originalAdminKey = process.env.GAMIFICATION_ADMIN_KEY;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/gamification', gamificationRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GAMIFICATION_ADMIN_KEY = 'unit-test-admin-key';
  mockGetUserProfile.mockReturnValue({
    address: '0x1111111111111111111111111111111111111111',
    achievements: ['achievement_1'],
  });
});

afterEach(() => {
  process.env.GAMIFICATION_ADMIN_KEY = originalAdminKey;
});

describe('gamification admin award route', () => {
  it('rejects callers that do not know the configured admin secret', async () => {
    const res = await request(makeApp()).post('/api/gamification/admin/award-achievement').send({
      userAddress: '0x1111111111111111111111111111111111111111',
      achievementId: 'achievement_1',
      adminKey: 'admin_demo_key',
    });

    expect(res.status).toBe(401);
    expect(res.body.success).toBe(false);
    expect(mockAwardAchievement).not.toHaveBeenCalled();
  });

  it('returns a service unavailable error when the admin secret is missing', async () => {
    delete process.env.GAMIFICATION_ADMIN_KEY;

    const res = await request(makeApp()).post('/api/gamification/admin/award-achievement').send({
      userAddress: '0x1111111111111111111111111111111111111111',
      achievementId: 'achievement_1',
      adminKey: 'unit-test-admin-key',
    });

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(mockAwardAchievement).not.toHaveBeenCalled();
  });

  it('awards an achievement when the configured admin secret matches', async () => {
    const res = await request(makeApp()).post('/api/gamification/admin/award-achievement').send({
      userAddress: '0x1111111111111111111111111111111111111111',
      achievementId: 'achievement_1',
      adminKey: 'unit-test-admin-key',
    });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockAwardAchievement).toHaveBeenCalledWith(
      '0x1111111111111111111111111111111111111111',
      'achievement_1'
    );
  });
});
