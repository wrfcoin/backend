import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const generateStateMock = jest.fn();
const validateStateMock = jest.fn();
const exchangeCodeForTokensMock = jest.fn();
const getUserInfoMock = jest.fn();

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('express-rate-limit', () => {
  return jest.fn(() => (_req: any, _res: any, next: any) => next());
});

jest.mock('../../server/utils/logger.js', () => ({
  securityLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logError: jest.fn(),
}));

jest.mock('../../shared/utils/oauth-state-validator.js', () => ({
  OAuthStateValidator: jest.fn().mockImplementation(() => ({
    generateState: generateStateMock,
    validateState: validateStateMock,
  })),
  logOAuthStateFailure: jest.fn(),
}));

jest.mock('../../server/services/oauth-service.js', () => ({
  exchangeCodeForTokens: exchangeCodeForTokensMock,
  getUserInfo: getUserInfoMock,
  isProviderConfigured: jest.fn(() => true),
  getConfiguredProviders: jest.fn(() => ['google']),
}));

import router from '../../server/routes/oauth-routes.js';

describe('oauth-routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    generateStateMock.mockReturnValue('signed-state');
    exchangeCodeForTokensMock.mockResolvedValue({
      success: true,
      accessToken: 'access-token',
    });
    getUserInfoMock.mockResolvedValue({
      id: 'user-123',
      email: 'user@example.com',
      name: 'User Example',
      avatar: 'avatar.png',
    });
  });

  function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/oauth', router);
    return app;
  }

  it('redirects unsafe callback redirect URIs to the safe default', async () => {
    validateStateMock.mockReturnValue({
      isValid: true,
      state: {
        provider: 'google',
        redirectUri: 'https://evil.example/steal',
      },
    });

    const response = await request(createApp())
      .get('/api/oauth/callback/google')
      .query({ code: 'abc', state: 'signed-state' })
      .set('Cookie', ['sessionId=session-123']);

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe('/dashboard');
  });

  it('keeps allowlisted redirect URIs and appends success parameters', async () => {
    validateStateMock.mockReturnValue({
      isValid: true,
      state: {
        provider: 'google',
        redirectUri: 'https://wrfcoin.app/settings',
      },
    });

    const response = await request(createApp())
      .get('/api/oauth/callback/google')
      .query({ code: 'abc', state: 'signed-state' })
      .set('Cookie', ['sessionId=session-123']);

    expect(response.status).toBe(302);
    expect(response.headers.location).toContain('https://wrfcoin.app/settings');
    expect(response.headers.location).toContain('oauth_success=true');
    expect(response.headers.location).toContain('provider=google');
  });
});
