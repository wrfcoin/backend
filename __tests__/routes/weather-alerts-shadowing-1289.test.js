/**
 * backend#1289: weather-routes.js's `GET /alerts/:location` is mounted at
 * /api/weather BEFORE weather-alerts-routes (mounted at /api), so it caught
 * GET /api/weather/alerts/active and /history with location = "active" /
 * "history" and answered 400 "Valid coordinates required". The alerts router's
 * handlers were unreachable for GET.
 *
 * The app below is assembled in the order the LIVE entrypoint mounts the two
 * routers (read from enhanced_unified_api_optimized.ts, so a reorder there is
 * reflected here). The real alerts router runs behind a stand-in JWT gate so
 * the test also pins that the per-point route stays un-gated.
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const request = require('supertest');

jest.mock('../../server/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../server/services/station-registration-service.js', () => ({
  listRegisteredStations: jest.fn(async () => ({ stations: [], nextCursor: null, hasMore: false })),
}));
jest.mock('../../server/db.js', () => ({ pool: {} }));

// The per-point handler: answers like the real one for a coordinate path.
const mockPerPoint = jest.fn((req, res) =>
  res.status(200).json({ handler: 'per-point', location: req.params.location, query: req.query }),
);
jest.mock('../../server/controllers/enhanced-weather-controller', () =>
  jest.fn().mockImplementation(() => ({
    getWeatherAlerts: mockPerPoint,
    getNearbyStations: jest.fn(),
    getServicesHealth: jest.fn(),
  })),
);

// Stand-in for the real JWT middleware: valid only with this bearer.
jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (req, res, next) =>
    req.headers.authorization === 'Bearer test-jwt'
      ? next()
      : res.status(401).json({ error: 'unauthorized' }),
}));

const weatherRoutes = require('../../server/routes/weather-routes.js');
const { createWeatherAlertsRouter } = require('../../server/routes/weather-alerts-routes');

const ENTRYPOINT = fs.readFileSync(
  path.resolve(__dirname, '../../server/enhanced_unified_api_optimized.ts'),
  'utf8',
);

/** The two relevant safeMount calls, in live mount order. */
function liveMountOrder() {
  const mounts = [];
  const re = /safeMount\(\s*'([^']+)',\s*'\.\/routes\/(weather-routes|weather-alerts-routes)'\s*\)/g;
  let m;
  while ((m = re.exec(ENTRYPOINT)) !== null) {
    mounts.push({ mountPath: m[1], module: m[2] });
  }
  return mounts;
}

function buildApp(service) {
  const routers = {
    'weather-routes': weatherRoutes,
    'weather-alerts-routes': createWeatherAlertsRouter(service),
  };
  const app = express();
  app.use(express.json());
  for (const { mountPath, module } of liveMountOrder()) {
    app.use(mountPath, routers[module]);
  }
  app.use((req, res) => res.status(404).json({ fellThrough: req.path }));
  return app;
}

function fakeService() {
  return {
    getActiveAlerts: jest.fn(() => [{ id: 'a1', type: 'tornado' }]),
    getAlertHistory: jest.fn(() => [{ id: 'h1' }]),
    getLastPollAt: jest.fn(() => '2026-09-28T00:00:00.000Z'),
    pollNow: jest.fn(async () => ({ newAlerts: 0 })),
  };
}

describe('GET /api/weather/alerts/* routing on the live mount table (backend#1289)', () => {
  beforeEach(() => mockPerPoint.mockClear());

  it('the entrypoint mounts both routers, weather-routes first (the premise of this test)', () => {
    expect(liveMountOrder()).toEqual([
      { mountPath: '/api/weather', module: 'weather-routes' },
      { mountPath: '/api', module: 'weather-alerts-routes' },
    ]);
  });

  it('/alerts/active reaches SevereWeatherResponseService.getActiveAlerts', async () => {
    const service = fakeService();
    const res = await request(buildApp(service))
      .get('/api/weather/alerts/active')
      .set('Authorization', 'Bearer test-jwt');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, count: 1, alerts: [{ id: 'a1' }] });
    expect(service.getActiveAlerts).toHaveBeenCalledTimes(1);
    expect(mockPerPoint).not.toHaveBeenCalled();
  });

  it('/alerts/history reaches SevereWeatherResponseService.getAlertHistory', async () => {
    const service = fakeService();
    const res = await request(buildApp(service))
      .get('/api/weather/alerts/history?limit=5')
      .set('Authorization', 'Bearer test-jwt');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, count: 1, history: [{ id: 'h1' }] });
    expect(service.getAlertHistory).toHaveBeenCalledWith(5);
    expect(mockPerPoint).not.toHaveBeenCalled();
  });

  it('/alerts/active without a JWT meets the alerts router\'s own gate (401), not a 400', async () => {
    const service = fakeService();
    const res = await request(buildApp(service)).get('/api/weather/alerts/active');
    expect(res.status).toBe(401);
    expect(service.getActiveAlerts).not.toHaveBeenCalled();
    expect(mockPerPoint).not.toHaveBeenCalled();
  });

  it('/alerts/<lat,lon> is still served by the per-point handler, without a JWT', async () => {
    const service = fakeService();
    const res = await request(buildApp(service)).get('/api/weather/alerts/45.0,-93.3');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handler: 'per-point', location: '45.0,-93.3' });
    expect(mockPerPoint).toHaveBeenCalledTimes(1);
    expect(service.getActiveAlerts).not.toHaveBeenCalled();
  });

  it('/alerts/<name>?lat=&lng= (query form) is still served by the per-point handler', async () => {
    const res = await request(buildApp(fakeService())).get('/api/weather/alerts/here?lat=45.0&lng=-93.3');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ handler: 'per-point', location: 'here' });
  });

  it('POST /api/weather/alerts/poll is unaffected', async () => {
    const service = fakeService();
    const res = await request(buildApp(service))
      .post('/api/weather/alerts/poll')
      .set('Authorization', 'Bearer test-jwt')
      .send({});
    expect(res.status).toBe(201);
    expect(service.pollNow).toHaveBeenCalledTimes(1);
    expect(mockPerPoint).not.toHaveBeenCalled();
  });
});

it('shadow endpoint reaches its own auth gate in live mount order', async () => {
  const res = await request(buildApp(fakeService())).get('/api/weather/alerts/shadow');
  expect(res.status).toBe(401);
});
