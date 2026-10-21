/**
 * #1258 review P3 (carried over): a DB error thrown inside a station detail
 * handler (after alias resolution) was an unhandled async rejection under
 * Express 4: no error middleware, so the request hung until the client timed
 * out, holding a connection. It must answer 503 with a fixed body.
 */
import express from 'express';
import request from 'supertest';
import { createStationDetailRouter } from '../../server/routes/station-detail-routes.js';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { stationAlias } = require('../../server/utils/station-alias');

const RAW = 'PWS-REVIEW-JANE-01';
const ALIAS = stationAlias(RAW);
const SECRET = `relation "weather_data" does not exist near ${RAW}`;

function appFailingOn(failPattern: RegExp, opts: { authenticated?: boolean } = {}) {
  const db = {
    execute: jest.fn(async (sql: string) => {
      if (sql.includes('sha256(')) return { rows: [{ station_id: RAW }] };
      if (failPattern.test(sql)) throw Object.assign(new Error(SECRET), { code: '42P01' });
      return { rows: [] };
    }),
  };
  const app = express();
  app.use('/api', createStationDetailRouter({
    db,
    fetchCore4Json: jest.fn(async () => ({ ok: false, status: 503, payload: {} })),
    readerToken: () => undefined, // forces the DB fallback for observations
    isAuthenticated: () => opts.authenticated ?? false,
  } as any));
  return app;
}

describe('station detail handlers answer 503 (not hang) on a DB error', () => {
  beforeEach(() => {
    // Model worker scheduling delay without sleeping or slowing the handler.
    // Correct HTTP/privacy behavior must survive a jump in the wall clock.
    let now = Date.UTC(2026, 9, 2, 12);
    jest.spyOn(Date, 'now').mockImplementation(() => (now += 3_000));
  });
  afterEach(() => jest.restoreAllMocks());

  test.each([
    ['observations (DB fallback)', 'observations', /FROM weather_data\b/],
    ['quality', 'quality', /weather_data_quality/],
    ['submissions', 'submissions', /weather_commitments/],
  ])('%s: completed 503, fixed body, no error text', async (_l, route, failOn) => {
    // A hang watchdog, not a latency benchmark on a shared worker.
    const res = await request(appFailingOn(failOn))
      .get(`/api/stations/${ALIAS}/${route}`).timeout({ response: 10_000, deadline: 15_000 });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: { code: 'STATION_DATA_UNAVAILABLE', message: 'station data temporarily unavailable' } });
    expect(JSON.stringify(res.body)).not.toMatch(/weather_data|42P01|PWS-REVIEW/i);
  });

  test('authenticated callers get the same fixed 503', async () => {
    const res = await request(appFailingOn(/weather_data_quality/, { authenticated: true }))
      .get(`/api/stations/${RAW}/quality`).timeout({ response: 10_000, deadline: 15_000 });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('STATION_DATA_UNAVAILABLE');
  });
});
