/**
 * Smoke tests: webauthn-routes — HTTP request assertions.
 * Addresses #355 (converts stub to real tests) and #340.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockGenRegistrationOptions = jest.fn();
const mockVerifyRegistration = jest.fn();
const mockGenAuthOptions = jest.fn();
const mockVerifyAuthentication = jest.fn();
const mockGetUserCredentials = jest.fn();
const mockHasWebAuthn = jest.fn();

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../server/services/webauthn-service.js', () => ({
  webauthnService: {
    generateRegistrationOptions: mockGenRegistrationOptions,
    verifyRegistration: mockVerifyRegistration,
    generateAuthenticationOptions: mockGenAuthOptions,
    verifyAuthentication: mockVerifyAuthentication,
    getCredentials: jest.fn(),
    getUserCredentials: mockGetUserCredentials,
    hasWebAuthn: mockHasWebAuthn,
    removeCredential: jest.fn(),
    getStatus: jest.fn(),
  },
}));

jest.mock('../../server/utils/logger.js', () => ({
  securityLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logError: jest.fn(),
}));

import router from '../../server/routes/webauthn-routes.js';

function makeAuthApp() {
  const app = express();
  app.use(express.json());
  // Attach fake user before router so handlers can read req.user
  app.use((req: any, _res: any, next: any) => { req.user = { id: 1, username: 'testuser' }; next(); });
  app.use('/webauthn', router);
  return app;
}

function makePublicApp() {
  const app = express();
  app.use(express.json());
  app.use('/webauthn', router);
  return app;
}

describe('webauthn-routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('POST /register/options returns 200 with challengeId', async () => {
    mockGenRegistrationOptions.mockResolvedValue({
      challengeId: 'chal-123',
      options: { challenge: 'abc', timeout: 60000 },
    });
    const res = await request(makeAuthApp()).post('/webauthn/register/options').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.challengeId).toBe('chal-123');
  });

  it('POST /authenticate/options returns 200', async () => {
    mockGenAuthOptions.mockResolvedValue({
      challengeId: 'auth-chal-1',
      options: { challenge: 'xyz', timeout: 60000 },
    });
    const res = await request(makePublicApp()).post('/webauthn/authenticate/options').send({});
    expect(res.status).toBe(200);
    expect(res.body.data.challengeId).toBe('auth-chal-1');
  });

  it('GET /status returns 200 with webauthn status', async () => {
    mockHasWebAuthn.mockResolvedValue(true);
    mockGetUserCredentials.mockResolvedValue([{ id: 'cred-1', credentialId: 'abcdef123456' }]);
    const res = await request(makeAuthApp()).get('/webauthn/status');
    expect(res.status).toBe(200);
    expect(res.body.data.webauthnEnabled).toBe(true);
  });

  it('GET /credentials returns 200 for authenticated user', async () => {
    mockGetUserCredentials.mockResolvedValue([{
      id: 'cred-1',
      credentialId: 'abcdef1234567890',
      friendlyName: 'YubiKey',
      deviceType: 'single_device',
      lastUsedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }]);
    const res = await request(makeAuthApp()).get('/webauthn/credentials');
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
  });
});
