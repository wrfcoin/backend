/**
 * backend#1289 (b3): GET /api/v1/weather/wrf-forecast/:location has no source
 * anywhere under server/ and fell through to the catch-all 404 "Endpoint not
 * found". It answers the backend#1145 honest-gap 501 envelope instead, which
 * mobile maps to "Not Available Yet". The caller's location is not echoed.
 */
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';

const ENTRYPOINT = fs.readFileSync(
  path.resolve(__dirname, '../../server/enhanced_unified_api_optimized.ts'),
  'utf8',
);

function loadRouter(): express.Router {
  const { createWrfForecastNotWiredRouter } = require('../../server/routes/wrf-forecast-not-wired-routes');
  return createWrfForecastNotWiredRouter();
}

function buildApp(): express.Express {
  const app = express();
  app.use('/api', loadRouter());
  app.use((req, res) => res.status(404).json({ fellThrough: req.path }));
  return app;
}

describe('GET /api/v1/weather/wrf-forecast/* (backend#1289 b3)', () => {
  it('the live entrypoint mounts the router at /api, before the catch-all', () => {
    const mountAt = ENTRYPOINT.indexOf('app.use(\'/api\', createWrfForecastNotWiredRouter())');
    const catchAllAt = ENTRYPOINT.indexOf('// Catch-all: forward unmatched requests');
    expect(mountAt).toBeGreaterThan(-1);
    expect(catchAllAt).toBeGreaterThan(mountAt);
  });

  it.each([
    '/api/v1/weather/wrf-forecast/45.0,-93.3',
    '/api/v1/weather/wrf-forecast/45.0,-93.3/hourly',
  ])('%s answers the 501 not-wired envelope', async (url) => {
    const res = await request(buildApp()).get(url);
    expect(res.status).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      unavailable: true,
      error: { code: 'NOT_IMPLEMENTED', capability: 'weather.wrf-forecast' },
    });
    expect(JSON.stringify(res.body)).not.toContain('45.0');
    expect(JSON.stringify(res.body)).not.toContain('-93.3');
  });

  it('leaves every other /api path to the routers mounted after it', async () => {
    const app = buildApp();
    for (const url of ['/api/weather/forecast/45.0,-93.3', '/api/v1/weather/other', '/api/v1/weather/wrf-forecast']) {
      const res = await request(app).get(url);
      expect(res.status).toBe(404);
      expect(res.body.fellThrough).toBe(url);
    }
    const post = await request(app).post('/api/v1/weather/wrf-forecast/45.0,-93.3');
    expect(post.status).toBe(404);
  });
});
