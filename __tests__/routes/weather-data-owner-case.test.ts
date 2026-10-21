/**
 * POST /api/weather/data station-ownership check must be case-insensitive.
 *
 * EVM login stores whatever address case the client sent; ed25519 login
 * subjects are lowercase. A station registered under a mixed-case EVM owner
 * must still accept submissions from the same wallet presenting a lowercase
 * subject (and vice versa), while a different wallet is still refused.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../server/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const MIXED = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const LOWER = MIXED.toLowerCase();
const STATIONS = [{ station_id: 'pws-mixed', owner_address: MIXED }];

let currentUser: { id: string; address: string } | null = null;

jest.mock('../../server/middleware/auth-middleware.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = currentUser;
    next();
  },
}));

// Row-backed pool: evaluates the ownership predicate the way Postgres would
// for the SQL actually sent, so a regression to exact equality flips results.
const queries: Array<{ sql: string; params: unknown[] }> = [];
jest.mock('../../server/db.js', () => ({
  pool: {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      queries.push({ sql, params });
      const ci = /lower\(owner_address\)\s*=\s*lower\(\$2\)/.test(sql);
      const hit = STATIONS.some(
        (s) =>
          s.station_id === params[0] &&
          (ci
            ? s.owner_address.toLowerCase() === String(params[1]).toLowerCase()
            : s.owner_address === params[1]),
      );
      return { rows: hit ? [{ '?column?': 1 }] : [] };
    }),
  },
}));

jest.mock('../../server/services/weather-ingestion-service.js', () => ({
  ingestWeatherPayload: jest.fn(async () => ({ status: 201, body: { success: true } })),
}));

jest.mock('../../server/controllers/enhanced-weather-controller', () => {
  return jest.fn().mockImplementation(() => ({}));
});

const weatherRoutes = require('../../server/routes/weather-routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/weather', weatherRoutes);
  return app;
}

const BODY = {
  location: '46.8,-92.0',
  stationId: 'pws-mixed',
  data: { temperature: 12.5, humidity: 60 },
};

describe('POST /api/weather/data — case-insensitive station ownership', () => {
  beforeEach(() => {
    queries.length = 0;
  });

  it('accepts the owner presenting a LOWERCASE subject for a MIXED-case row', async () => {
    currentUser = { id: 'u1', address: LOWER };
    const res = await request(buildApp()).post('/api/weather/data').send(BODY);
    expect(res.status).toBe(201);
    expect(queries[0].sql).toContain('lower(owner_address) = lower($2)');
  });

  it('accepts the owner presenting an UPPERCASE-hex variant', async () => {
    currentUser = { id: 'u1', address: '0x' + MIXED.slice(2).toUpperCase() };
    const res = await request(buildApp()).post('/api/weather/data').send(BODY);
    expect(res.status).toBe(201);
  });

  it('still refuses a different wallet (403)', async () => {
    currentUser = { id: 'u2', address: '0x' + '9'.repeat(40) };
    const res = await request(buildApp()).post('/api/weather/data').send(BODY);
    expect(res.status).toBe(403);
  });
});
