import express from 'express';
import request from 'supertest';

jest.mock('jose', () => ({
  createRemoteJWKSet: () => jest.fn(),
  jwtVerify: jest.fn(),
}));

import { createSocialAuthRouter } from '../server/routes/social-auth-routes.js';

type Row = Record<string, unknown>;

function makeDb(responses: { rows: Row[] }[]) {
  let call = 0;
  return {
    execute: jest.fn(async (_sql: string, _params?: unknown[]) => {
      return responses[call++] ?? { rows: [] };
    }),
  };
}

function makeApp(db: { execute: jest.Mock }) {
  const app = express();
  app.use(express.json());
  app.use('/api/auth/social', createSocialAuthRouter(db as any));
  return app;
}

describe('Social auth routes', () => {
  const originalTestMode = process.env.SOCIAL_AUTH_TEST_MODE;
  const originalJwt = process.env.JWT_SECRET;

  beforeAll(() => {
    process.env.SOCIAL_AUTH_TEST_MODE = 'true';
    process.env.JWT_SECRET = 'test-secret';
  });

  afterAll(() => {
    process.env.SOCIAL_AUTH_TEST_MODE = originalTestMode;
    process.env.JWT_SECRET = originalJwt;
  });

  it('POST /google creates social account and returns smart account metadata', async () => {
    const db = makeDb([
      { rows: [] }, // existing user lookup
      { rows: [] }, // upsert
    ]);
    const app = makeApp(db);
    const res = await request(app).post('/api/auth/social/google').send({
      mockSub: 'google-sub-1',
      mockEmail: 'user@example.com',
    });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('google');
    expect(res.body.walletAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(res.body.smartAccountAddress).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(res.body.isNewUser).toBe(true);
    expect(res.body.token).toBeTruthy();
  });

  it('POST /github returns existing user as not new', async () => {
    const db = makeDb([
      { rows: [{ '?column?': 1 }] }, // existing user lookup
      { rows: [] }, // upsert
    ]);
    const app = makeApp(db);
    const res = await request(app).post('/api/auth/social/github').send({
      mockSub: 'github-sub-42',
      mockEmail: 'octo@example.com',
    });

    expect(res.status).toBe(200);
    expect(res.body.provider).toBe('github');
    expect(res.body.isNewUser).toBe(false);
  });

  it('POST /google returns 400 when token and mockSub are missing', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).post('/api/auth/social/google').send({});
    expect(res.status).toBe(400);
  });
});
