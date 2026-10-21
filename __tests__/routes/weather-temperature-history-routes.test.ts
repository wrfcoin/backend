/**
 * Daily temperature history for a 0.1 degree cell (Refs wrfcoin/mobile#299).
 * Unit + route level with a fake transaction runner; the real-SQL privacy cases
 * live in __tests__/weather-temperature-history-pg.integration.test.ts.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';

jest.mock('express-rate-limit', () => jest.fn(() => (_req: any, _res: any, next: any) => next()));

let authAllows = true;
jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, res: any, next: any) =>
    authAllows ? next() : res.status(401).json({ error: 'Unauthorized' }),
  authenticateApiKey: (_req: any, _res: any, next: any) => next(),
  optionalAuth: (_req: any, _res: any, next: any) => next(),
}));

import { createWeatherTemperatureHistoryRouter } from '../../server/routes/weather-temperature-history-routes.js';
import {
  RELEASE_SQL,
  SERVE_SQL,
  cellBounds,
  getTemperatureHistory,
  type TransactionRunner,
} from '../../server/services/temperature-history.js';

type Row = Record<string, unknown>;

function makeRunner(rows: Row[], failWith?: unknown) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const run: TransactionRunner = async (callback) =>
    callback({
      execute: async (sql, params) => {
        calls.push({ sql, params });
        if (failWith && /INSERT INTO weather_temperature_daily_release/.test(sql)) throw failWith;
        // the serve select is the only statement that returns rows
        return { rows: /FROM weather_temperature_daily_release\s+WHERE/.test(sql) ? rows : [] };
      },
    });
  return { run, calls };
}

const NOW = new Date('2026-09-30T15:30:00Z');

describe('cell bounds and rounding', () => {
  it('uses the registration convention: centre latE1/10, half width 0.05, exact decimals', () => {
    expect(cellBounds(400)).toEqual({ lower: '39.95', upper: '40.05' });
    expect(cellBounds(-3)).toEqual({ lower: '-0.35', upper: '-0.25' });
    expect(cellBounds(0)).toEqual({ lower: '-0.05', upper: '0.05' });
    expect(cellBounds(-1800)).toEqual({ lower: '-180.05', upper: '-179.95' });
  });
});

describe('getTemperatureHistory', () => {
  it('returns completed UTC days only, rounded, with null days and a coarse sample count', async () => {
    const { run } = makeRunner([
      { day: '2026-09-28', min_c: 10, max_c: 14.5, mean_c: 12.5, count_bucket: 10 },
      { day: '2026-09-29', min_c: 8, max_c: 8, mean_c: 8, count_bucket: 10 },
    ]);
    const out = await getTemperatureHistory(run, { latE1: 400, lonE1: -1050, days: 3 }, NOW);
    expect(out.cell).toEqual({ latE1: 400, lonE1: -1050 });
    // today (2026-09-30) is never part of the window
    expect(out.window).toEqual({ from: '2026-09-27', to: '2026-09-29' });
    expect(out.daily).toEqual([
      { date: '2026-09-27', minC: null, maxC: null, meanC: null },
      { date: '2026-09-28', minC: 10, maxC: 14.5, meanC: 12.5 },
      { date: '2026-09-29', minC: 8, maxC: 8, meanC: 8 },
    ]);
    expect(out.sampleCount).toBe(20); // sum of the released days' coarse buckets
    expect(Object.keys(out).sort()).toEqual(['cell', 'daily', 'days', 'sampleCount', 'window']);
    expect(out.daily.every((d) => Object.keys(d).sort().join() === 'date,maxC,meanC,minC')).toBe(true);
  });

  it('publishes a day only after D_end + 2 h: inside the grace window it is absent', async () => {
    const { run, calls } = makeRunner([]);
    const early = await getTemperatureHistory(run, { latE1: 1, lonE1: 2, days: 2 }, new Date('2026-10-01T01:59:59Z'));
    expect(early.daily.map((d) => d.date)).toEqual(['2026-09-28', '2026-09-29']);
    expect(early.window).toEqual({ from: '2026-09-28', to: '2026-09-29' });
    expect(calls[1].params?.slice(7, 9)).toEqual(['2026-09-28T00:00:00.000Z', '2026-09-30T00:00:00.000Z']);
    const late = await getTemperatureHistory(makeRunner([]).run, { latE1: 1, lonE1: 2, days: 2 }, new Date('2026-10-01T02:00:00Z'));
    expect(late.daily.map((d) => d.date)).toEqual(['2026-09-29', '2026-09-30']);
  });

  it('no writer can set received_at: none of the INSERT INTO weather_submissions column lists names it', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const files = [
      'server/enhanced_weather_rewards.ts',
      'server/routes/sensor-ingest-routes.ts',
      'server/routes/weather-commit-reveal-routes.ts',
      'server/services/weather-submission-persistence.ts',
    ];
    for (const file of files) {
      const src: string = fs.readFileSync(path.join(__dirname, '../..', file), 'utf8');
      const inserts = [...src.matchAll(/INSERT INTO weather_submissions\s*\(([\s\S]*?)\)\s*(?:VALUES|SELECT)/g)];
      expect(inserts.length).toBeGreaterThan(0);
      for (const m of inserts) expect(m[1]).not.toMatch(/received_at/);
      expect(src).not.toMatch(/received_at/);
    }
  });

  it('ignores a row outside the completed-day window (today) in both values and sampleCount', async () => {
    const { run } = makeRunner([{ day: '2026-09-30', min_c: 99, max_c: 99, mean_c: 99, count_bucket: 500 }]);
    const out = await getTemperatureHistory(run, { latE1: 1, lonE1: 2, days: 2 }, NOW);
    expect(out.sampleCount).toBe(0);
    expect(JSON.stringify(out)).not.toMatch(/99|2026-09-30/);
  });

  it('a released suppressed day (NULL values) stays null and adds no count', async () => {
    const { run } = makeRunner([{ day: '2026-09-29', min_c: null, max_c: null, mean_c: null, count_bucket: null }]);
    const out = await getTemperatureHistory(run, { latE1: 1, lonE1: 2, days: 1 }, NOW);
    expect(out.daily).toEqual([{ date: '2026-09-29', minC: null, maxC: null, meanC: null }]);
    expect(out.sampleCount).toBe(0);
  });

  it('returns null days and sampleCount 0 for an empty cell', async () => {
    const out = await getTemperatureHistory(makeRunner([]).run, { latE1: 1, lonE1: 2, days: 2 }, NOW);
    expect(out.sampleCount).toBe(0);
    expect(out.daily.every((d) => d.minC === null && d.maxC === null && d.meanC === null)).toBe(true);
  });

  it('a day with the same data reads identically whatever the window (no window differencing)', async () => {
    const rows = [{ day: '2026-09-29', min_c: 8, max_c: 9, mean_c: 8.5, count_bucket: 10 }];
    const one = await getTemperatureHistory(makeRunner(rows).run, { latE1: 1, lonE1: 2, days: 1 }, NOW);
    const two = await getTemperatureHistory(makeRunner(rows).run, { latE1: 1, lonE1: 2, days: 2 }, NOW);
    expect(two.daily.find((d) => d.date === '2026-09-29')).toEqual(one.daily[0]);
  });

  it('sets a database-side statement_timeout, then releases, then serves from the release table, in one transaction', async () => {
    const { run, calls } = makeRunner([]);
    await getTemperatureHistory(run, { latE1: 400, lonE1: -1050, days: 1 }, NOW);
    expect(calls).toHaveLength(3);
    expect(calls[0].sql).toMatch(/set_config\('statement_timeout', \$1, true\)/);
    expect(calls[0].params).toEqual(['5000']);
    expect(calls[1].sql).toBe(RELEASE_SQL);
    expect(calls[1].params).toEqual([
      -90, 60, 50, '39.95', '40.05', '-105.05', '-104.95',
      '2026-09-29T00:00:00.000Z', '2026-09-30T00:00:00.000Z', 5, 7200, 400, -1050,
    ]);
    expect(calls[2].sql).toBe(SERVE_SQL);
    expect(calls[2].params).toEqual([400, -1050, '2026-09-29', '2026-09-30']);
  });

  it('a statement timeout on the release aborts the request before anything is served', async () => {
    const { run, calls } = makeRunner([], Object.assign(new Error('canceled'), { code: '57014' }));
    await expect(getTemperatureHistory(run, { latE1: 1, lonE1: 2, days: 1 }, NOW)).rejects.toMatchObject({ code: '57014' });
    expect(calls.some((c) => c.sql === SERVE_SQL)).toBe(false);
  });

  it('the release SQL enforces the policy and freezes: ON CONFLICT DO NOTHING, never an update', () => {
    expect(RELEASE_SQL).toMatch(/COUNT\(DISTINCT contributor\) >= \$10/);
    expect(RELEASE_SQL).toMatch(/COALESCE\(station_id, device_id, wallet_address\) IS NOT NULL/);
    expect(RELEASE_SQL).toMatch(/physics_violations = '\[\]'::jsonb/);
    expect(RELEASE_SQL).toMatch(/ON CONFLICT \(lat_e1, lon_e1, day\) DO NOTHING/);
    expect(RELEASE_SQL).not.toMatch(/DO UPDATE|LIMIT|\bUPDATE\b|\bDELETE\b/);
    // immutable release: only rows the SERVER received by D_end + grace count toward D
    expect(RELEASE_SQL).toMatch(/received_at <= \(\(submitted_at AT TIME ZONE 'UTC'\)::date \+ 1\)::timestamp AT TIME ZONE 'UTC'\s+\+ make_interval\(secs => \$11::int\)/);
    // a day that is already released is not recomputed
    expect(RELEASE_SQL).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM weather_temperature_daily_release r/);
  });

  it('the serve SQL reads only the release table and selects no identifiers or coordinates', () => {
    expect(SERVE_SQL).toMatch(/FROM weather_temperature_daily_release/);
    expect(SERVE_SQL).not.toMatch(/weather_submissions|latitude|longitude|station_id|wallet_address|device_id|contributor/);
  });
});

describe('GET /api/weather/temperature-history', () => {
  const url = '/api/weather/temperature-history';
  // The route reads the wall clock (published days end at today - 1 once D_end + 2 h has
  // passed), so its fixtures need a pinned clock. Only Date is faked: timers stay real for
  // supertest. Unpinned, "returns 200 with daily values only" went red on its own at
  // 2026-10-02T02:00Z, when its 2026-09-29 row left the 2-day window.
  const fakeDateOnly = (now: Date) =>
    jest.useFakeTimers({
      now,
      doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'clearImmediate',
        'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
    });
  beforeAll(() => fakeDateOnly(NOW));
  afterAll(() => jest.useRealTimers());
  const app = (run: TransactionRunner) => {
    const a = express();
    a.use(url, createWeatherTemperatureHistoryRouter(run));
    return a;
  };

  it('requires authentication', async () => {
    authAllows = false;
    const { run, calls } = makeRunner([]);
    const res = await request(app(run)).get(`${url}?latE1=400&lonE1=-1050`);
    authAllows = true;
    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('returns 200 with daily values only', async () => {
    const { run } = makeRunner([{ day: '2026-09-29', min_c: 1, max_c: 2, mean_c: 1.5, count_bucket: 30 }]);
    const res = await request(app(run)).get(`${url}?latE1=400&lonE1=-1050&days=2`);
    expect(res.status).toBe(200);
    expect(res.body.cell).toEqual({ latE1: 400, lonE1: -1050 });
    expect(res.body.days).toBe(2);
    expect(res.body.hours).toBeUndefined();
    expect(res.body.contributorBucket).toBeUndefined();
    expect(res.body.sampleCount).toBe(30);
    expect(res.headers['cache-control']).toMatch(/private/);
  });

  it('the window moves with the clock: two days later the same row is outside it', async () => {
    const row = { day: '2026-09-29', min_c: 1, max_c: 2, mean_c: 1.5, count_bucket: 30 };
    try {
      fakeDateOnly(new Date('2026-10-02T01:59:59Z')); // 2026-10-01 not yet published: window 09-29..09-30
      const inside = await request(app(makeRunner([row]).run)).get(`${url}?latE1=400&lonE1=-1050&days=2`);
      expect(inside.body.window).toEqual({ from: '2026-09-29', to: '2026-09-30' });
      expect(inside.body.sampleCount).toBe(30);
      fakeDateOnly(new Date('2026-10-02T02:08:00Z')); // past D_end + 2 h: window 09-30..10-01
      const outside = await request(app(makeRunner([row]).run)).get(`${url}?latE1=400&lonE1=-1050&days=2`);
      expect(outside.body.window).toEqual({ from: '2026-09-30', to: '2026-10-01' });
      expect(outside.body.sampleCount).toBe(0);
    } finally {
      fakeDateOnly(NOW);
    }
  });

  it('defaults days to 14 and accepts the bounds 1 and 14', async () => {
    const { run } = makeRunner([]);
    expect((await request(app(run)).get(`${url}?latE1=0&lonE1=0`)).body.days).toBe(14);
    expect((await request(app(run)).get(`${url}?latE1=0&lonE1=0&days=1`)).status).toBe(200);
    expect((await request(app(run)).get(`${url}?latE1=-900&lonE1=1800&days=14`)).status).toBe(200);
  });

  it.each([
    ['decimal cell', 'latE1=40.1&lonE1=-105.2'],
    ['exact coordinates', 'latE1=400&lonE1=-1050&lat=40.123456&lon=-105.123456'],
    ['latitude word', 'latE1=400&lonE1=-1050&latitude=40.123456'],
    ['cell string', 'cell=40.1,-105.2'],
    ['missing lon', 'latE1=400'],
    ['lat out of range', 'latE1=901&lonE1=0'],
    ['lon out of range', 'latE1=0&lonE1=-1801'],
    ['days zero', 'latE1=0&lonE1=0&days=0'],
    ['days too big', 'latE1=0&lonE1=0&days=15'],
    ['days 30 (cap is 14)', 'latE1=0&lonE1=0&days=30'],
    ['days decimal', 'latE1=0&lonE1=0&days=1.5'],
    ['repeated latE1', 'latE1=1&latE1=2&lonE1=0'],
    ['exponent', 'latE1=1e2&lonE1=0'],
    ['hours parameter (hourly series no longer exists)', 'latE1=0&lonE1=0&hours=24'],
  ])('rejects %s with 400, no DB call and no echo of the input', async (_name, query) => {
    const { run, calls } = makeRunner([]);
    const res = await request(app(run)).get(`${url}?${query}`);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(res.body)).not.toMatch(/40\.123456|105\.123456|40\.1\b|-105\.2/);
  });

  it('never leaks identifiers or coordinates even if a row carried them', async () => {
    const { run } = makeRunner([
      { day: '2026-09-29', min_c: 1, max_c: 2, mean_c: 1.5, count_bucket: 30, station_id: 'mob-secret', latitude: 40.123456, wallet_address: '0xabc' },
    ]);
    const res = await request(app(run)).get(`${url}?latE1=400&lonE1=-1050`);
    expect(JSON.stringify(res.body)).not.toMatch(/mob-secret|40\.123456|0xabc|station|wallet|device/);
  });

  it('maps the database statement timeout (57014) to 503 and never starts another query', async () => {
    const { run, calls } = makeRunner([], Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    const res = await request(app(run)).get(`${url}?latE1=400&lonE1=-1050`);
    expect(res.status).toBe(503);
    expect(calls.filter((c) => /FROM weather_submissions/.test(c.sql))).toHaveLength(1);
    expect(JSON.stringify(res.body)).not.toMatch(/statement|SELECT/);
  });

  it('returns a generic 500 that carries no SQL or coordinates', async () => {
    const { run } = makeRunner([], new Error('boom SELECT 40.123456'));
    const res = await request(app(run)).get(`${url}?latE1=400&lonE1=-1050`);
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/boom|SELECT|40\.123/);
  });

  it('does not log the requested cell or any coordinate', async () => {
    const spies = (['log', 'info', 'warn', 'error'] as const).map((m) => jest.spyOn(console, m).mockImplementation(() => undefined));
    await request(app(makeRunner([], new Error('boom')).run)).get(`${url}?latE1=400&lonE1=-1050`);
    const logged = JSON.stringify(spies.flatMap((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());
    expect(logged).not.toMatch(/400|-1050|40\.0/);
  });
});
