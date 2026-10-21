import request from 'supertest';
import express from 'express';
import { jest } from '@jest/globals';

const originalEnv = { ...process.env };

const resetEnv = () => {
  Object.keys(process.env).forEach(key => {
    if (!(key in originalEnv)) delete process.env[key];
  });
  Object.assign(process.env, originalEnv);
};

describe('retired OpenForis security boundary', () => {
  beforeEach(resetEnv);
  afterAll(resetEnv);

  it('keeps the legacy auth module fail-closed without a production secret', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.OPENFORIS_JWT_SECRET;
    jest.resetModules();

    await expect(import('../middleware/openforis-auth.js')).rejects.toThrow(
      'OPENFORIS_JWT_SECRET is required when NODE_ENV is not development',
    );
  });

  it('cannot be re-enabled by credentials passed to a direct legacy import', async () => {
    process.env.NODE_ENV = 'production';
    process.env.OPENFORIS_JWT_SECRET = 'production-test-secret-for-retired-route';
    jest.resetModules();
    const router = (await import('../routes/openforis-routes.js')).default;
    const app = express();
    app.use('/api/openforis', router);

    const response = await request(app)
      .get('/api/openforis/projects')
      .set('Authorization', 'Bearer fabricated-credential');

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({
      available: false,
      proofClass: 'UNAVAILABLE',
      code: 'OPENFORIS_INTEGRATION_RETIRED',
    });
  });
});
