/**
 * Smoke tests: social-auth-routes — HTTP request assertions.
 * Addresses #355 (converts stub to real tests) and #340.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockCompleteSocialLogin = jest.fn();
const mockVerifyGoogleIdToken = jest.fn();
const mockVerifyGithubIdentity = jest.fn();

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('express-rate-limit', () => {
  const rateLimit = jest.fn(() => (_req: any, _res: any, next: any) => next());
  (rateLimit as any).ipKeyGenerator = jest.fn((ip: string) => ip);
  return rateLimit;
});

jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(() => jest.fn()),
  jwtVerify: jest.fn(),
}));

jest.mock('../../server/utils/logger.js', () => ({
  securityLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logError: jest.fn(),
}));

jest.mock('../../server/services/social-auth-service.js', () => ({
  completeSocialLogin: mockCompleteSocialLogin,
  verifyGoogleIdToken: mockVerifyGoogleIdToken,
  verifyGithubIdentity: mockVerifyGithubIdentity,
}));

import { createSocialAuthRouter } from '../../server/routes/social-auth-routes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/social', createSocialAuthRouter());
  return app;
}

const fakeAuth = { token: 'jwt-token', walletAddress: '0xabc', smartAccount: '0xdef' };

describe('social-auth-routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCompleteSocialLogin.mockResolvedValue(fakeAuth);
  });

  describe('POST /google', () => {
    it('returns 400 when idToken is missing (non-test mode)', async () => {
      const res = await request(makeApp()).post('/social/google').send({});
      expect(res.status).toBe(400);
    });

    it('returns 200 with auth result when idToken is valid', async () => {
      mockVerifyGoogleIdToken.mockResolvedValue({ sub: 'google-sub-123', email: 'u@example.com' });
      const res = await request(makeApp())
        .post('/social/google')
        .send({ idToken: 'valid-google-token' });
      expect(res.status).toBe(200);
      expect(res.body.token).toBe('jwt-token');
    });

    it('returns 401 when idToken verification fails', async () => {
      mockVerifyGoogleIdToken.mockRejectedValue(new Error('invalid token'));
      const res = await request(makeApp())
        .post('/social/google')
        .send({ idToken: 'bad-token' });
      expect(res.status).toBe(401);
    });
  });

  describe('POST /github', () => {
    it('returns 400 when neither code nor accessToken is provided', async () => {
      const res = await request(makeApp()).post('/social/github').send({});
      expect(res.status).toBe(400);
    });

    it('returns 200 when github code exchange succeeds', async () => {
      mockVerifyGithubIdentity.mockResolvedValue({ sub: 'gh-456', email: 'dev@gh.com' });
      const res = await request(makeApp())
        .post('/social/github')
        .send({ code: 'github-oauth-code' });
      expect(res.status).toBe(200);
      expect(res.body.token).toBe('jwt-token');
    });
  });
});
