import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';

import { csrfProtectionMiddleware } from '../../shared/middleware/csrf-protection.js';

describe('csrfProtectionMiddleware', () => {
  function createApp() {
    const app = express();
    app.use(express.json());
    app.use(csrfProtectionMiddleware());
    app.get('/form', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    app.post('/mutate', (_req, res) => {
      res.status(200).json({ ok: true });
    });
    return app;
  }

  it('sets csrf cookies on safe requests', async () => {
    const response = await request(createApp()).get('/form');

    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toEqual(
      expect.arrayContaining([
        expect.stringContaining('csrf-token='),
        expect.stringContaining('csrf-token-http='),
      ])
    );
  });

  it('rejects state-changing requests without a csrf token', async () => {
    const response = await request(createApp()).post('/mutate').send({ ok: true });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CSRF_TOKEN_INVALID');
  });

  it('accepts matching csrf cookie and header tokens', async () => {
    const app = createApp();
    const seedResponse = await request(app).get('/form');
    const cookies = seedResponse.headers['set-cookie'];
    const tokenCookie = cookies.find((cookie: string) => cookie.startsWith('csrf-token='));
    const token = tokenCookie.split(';')[0].split('=')[1];

    const response = await request(app)
      .post('/mutate')
      .set('Cookie', cookies)
      .set('x-csrf-token', token)
      .send({ ok: true });

    expect(response.status).toBe(200);
    expect(response.body.ok).toBe(true);
  });
});
