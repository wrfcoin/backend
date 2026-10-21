import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const express = require('express');
const request = require('supertest');

const mockAuthMiddleware = jest.fn((req: any, _res: any, next: any) => next());

jest.mock('../../middleware/auth.js', () => ({
  authenticateJWT: (req: any, res: any, next: any) =>
    mockAuthMiddleware(req, res, next),
}));

async function buildApp(dbRows: Record<string, unknown>[] = []) {
  const { createSubscriptionRouter } = await import(
    '../../routes/subscription-routes.js'
  );

  const db = {
    execute: jest.fn(async () => ({ rows: dbRows })),
  };

  const app = express();
  app.use(express.json());
  app.use('/api/subscription', createSubscriptionRouter(db));

  return { app, db };
}

describe('Subscription routes error envelopes', () => {
  beforeEach(() => {
    mockAuthMiddleware.mockImplementation((req: any, _res: any, next: any) =>
      next()
    );
  });

  it('returns the canonical envelope for missing user ID on a 401 path', async () => {
    const { app } = await buildApp();

    const res = await request(app).get('/api/subscription/usage');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: {
        message: 'User ID not found in token',
        code: 'USER_ID_NOT_FOUND',
      },
    });
  });

  it('returns the canonical envelope for a 404 path', async () => {
    mockAuthMiddleware.mockImplementation((req: any, _res: any, next: any) => {
      req.user = { id: 'user-123' };
      next();
    });

    const { app } = await buildApp([]);

    const res = await request(app).get('/api/subscription/usage');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      error: {
        message: 'No active API key found',
        code: 'API_KEY_NOT_FOUND',
      },
    });
  });
});
