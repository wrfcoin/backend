import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../server/controllers/achievementController.js', () => ({
  getUserAchievements: jest.fn(),
  calculateGovernanceWeight: jest.fn(),
  calculateReputationBoost: jest.fn(),
  awardAchievement: jest.fn(),
  updateAchievementProgress: jest.fn(),
  getBadgeUpgradePath: jest.fn(),
  syncWithWrfView: jest.fn(),
  recalculateUserMetrics: jest.fn(),
}));

jest.mock('../../utils/logger.js', () => ({
  createLogger: () => ({
    info: jest.fn(),
    error: jest.fn(),
  }),
}));

import router from '../../server/routes/achievementRoutes.js';
import * as achievementController from '../../server/controllers/achievementController.js';

describe('achievement route error envelopes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // backend#1145: the family is guarded by require-wired-storage — without a
  // real req.storage the controller (which only has a mock branch) is never
  // reached and the route answers the honest-gap 501 envelope.
  it('answers 501 NOT_IMPLEMENTED, never a mock, when no storage is wired', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/achievement', router);

    const response = await request(app).get('/api/achievement/42');

    expect(response.status).toBe(501);
    expect(response.body).toMatchObject({
      success: false,
      unavailable: true,
      error: { code: 'NOT_IMPLEMENTED', capability: 'achievement' },
    });
    expect(achievementController.getUserAchievements).not.toHaveBeenCalled();
  });

  it('does not leak internal exception messages on 500 responses', async () => {
    (achievementController.getUserAchievements as jest.Mock).mockRejectedValue(
      new Error('database password leaked from /srv/backend/.env')
    );

    const app = express();
    app.use(express.json());
    // A wired storage implementation lets the request through the guard.
    app.use((req: any, _res, next) => {
      req.storage = {};
      next();
    });
    app.use('/api/achievement', router);

    const response = await request(app).get('/api/achievement/42');

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'Internal server error',
      message: 'An unexpected error occurred',
    });
    expect(JSON.stringify(response.body)).not.toContain('database password leaked');
  });
});
