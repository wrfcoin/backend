import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';

import { corsConfig } from '../../utils/cors-config.js';

describe('cors config preflight handler', () => {
  it('returns the canonical error envelope for blocked origins', async () => {
    process.env.NODE_ENV = 'production';

    const app = express();
    app.use(corsConfig.preflightHandler());
    app.options('/api/test', (_req, res) => {
      res.status(204).end();
    });

    const res = await request(app)
      .options('/api/test')
      .set('Origin', 'https://evil.example');

    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toEqual({
      code: 'CORS_ORIGIN_NOT_ALLOWED',
      message: 'Origin not allowed by CORS policy',
    });
    expect(typeof res.body.timestamp).toBe('string');
  });
});
