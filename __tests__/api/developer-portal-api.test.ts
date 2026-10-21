import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getUserApiKeys = jest.fn();

jest.mock('express-rate-limit', () => {
  return jest.fn(() => (_req: any, _res: any, next: any) => next());
});

jest.mock('../../services/api-key-service.js', () => ({
  ApiKeyService: jest.fn().mockImplementation(() => ({
    getUserApiKeys,
  })),
}));

jest.mock('../../middleware/api-key-auth.js', () => ({
  apiKeyAuth: jest.fn(),
  requireApiKey: jest.fn(() => (req: any, _res: any, next: any) => {
    req.apiKey = { userId: 'user-1' };
    next();
  }),
  requirePermissions: jest.fn(() => (_req: any, _res: any, next: any) => next()),
}));

jest.mock('../../server/utils/logger.js', () => ({
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import router from '../../api/developer-portal-api.ts';

describe('developer portal error envelopes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns the canonical validation envelope for invalid API key create input', async () => {
    const app = express();
    app.use(express.json());
    app.use('/developer', router);

    const res = await request(app).post('/developer/api-keys').send({ name: '' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('Validation Error');
    expect(Array.isArray(res.body.error.details)).toBe(true);
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('returns the canonical 500 envelope when listing API keys fails', async () => {
    getUserApiKeys.mockRejectedValueOnce(new Error('boom'));

    const app = express();
    app.use('/developer', router);

    const res = await request(app).get('/developer/api-keys');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toEqual({
      code: 'DEVELOPER_PORTAL_ERROR',
      message: 'Failed to fetch API keys',
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('returns the canonical 404 envelope when an API key is missing', async () => {
    getUserApiKeys.mockResolvedValueOnce([]);

    const app = express();
    app.use('/developer', router);

    const res = await request(app)
      .get('/developer/api-keys/550e8400-e29b-41d4-a716-446655440000');

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toEqual({
      code: 'API_KEY_NOT_FOUND',
      message: 'The specified API key does not exist or you do not have access to it',
      details: undefined,
    });
    expect(typeof res.body.timestamp).toBe('string');
  });
});
