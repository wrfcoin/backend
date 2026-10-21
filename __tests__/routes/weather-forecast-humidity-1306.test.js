/**
 * backend#1306: daily forecast periods carry relativeHumidity {min,max}|null
 * aggregated from the NWS hourly forecast; hourly periods expose a plain
 * percent (or null). NWS is faked at the axios adapter; nothing leaves the box.
 */
const express = require('express');
const request = require('supertest');

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() };
jest.mock('../../utils/logger', () => ({ logger: mockLogger }));
jest.mock('../../server/utils/logger', () => ({ logger: mockLogger }));
jest.mock('../../server/services/station-registration-service.js', () => ({
  listRegisteredStations: jest.fn(async () => ({ stations: [], nextCursor: null, hasMore: false })),
}));
jest.mock('../../server/db.js', () => ({ pool: {} }));

let upstream = () => {
  throw new Error('no upstream configured');
};
const requested = [];
const hourlyTimeouts = [];
jest.mock('axios', () => {
  const actual = jest.requireActual('axios');
  const create = (config = {}) =>
    actual.create({ ...config, adapter: (cfg) => upstream(cfg, actual) });
  return Object.assign(Object.create(actual), { create, default: { ...actual, create } });
});

const weatherRoutes = require('../../server/routes/weather-routes.js');

// S2c: these cases reuse one coordinate and expect every request to reach the
// (faked) NWS, so start each from empty NOAA caches.
beforeEach(() => {
  require('../../server/controllers/enhanced-weather-controller').noaaCache.clear();
  require('../../server/services/noaa-nws-api-service').gridPointCache.clear();
});

const POINT = {
  properties: {
    gridId: 'MPX', gridX: 107, gridY: 71,
    forecast: 'https://api.weather.gov/gridpoints/MPX/107,71/forecast',
    forecastHourly: 'https://api.weather.gov/gridpoints/MPX/107,71/forecast/hourly',
    observationStations: 'https://api.weather.gov/gridpoints/MPX/107,71/stations',
  },
};

const HOUR = 3600e3;
const T0 = Date.parse('2031-03-01T06:00:00-06:00'); // synthetic, far from real data
const iso = (ms) => new Date(ms).toISOString();

// Two 12h daily periods: [T0, T0+12h) and [T0+12h, T0+24h).
const dailyPeriods = (n = 2) => ({
  properties: {
    periods: Array.from({ length: n }, (_, i) => ({
      number: i + 1,
      name: `P${i + 1}`,
      startTime: iso(T0 + i * 12 * HOUR),
      endTime: iso(T0 + (i + 1) * 12 * HOUR),
      isDaytime: i % 2 === 0,
      temperature: 50,
    })),
  },
});
// One hourly period per hour; rh(h) gives the NWS-shaped humidity for hour h.
const hourlyPeriods = (count, rh, startHour = 0) => ({
  properties: {
    periods: Array.from({ length: count }, (_, i) => {
      const h = startHour + i;
      return {
        number: i + 1,
        startTime: iso(T0 + h * HOUR),
        endTime: iso(T0 + (h + 1) * HOUR),
        temperature: 50,
        relativeHumidity: rh(h),
      };
    }),
  },
});
const pct = (value) => ({ unitCode: 'wmoUnit:percent', value });

function ok(cfg, data) {
  return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config: cfg });
}
function nws({ daily = dailyPeriods(), hourly, hourlyFails = null } = {}) {
  return (cfg) => {
    const url = cfg.url || '';
    requested.push(url);
    if (url.endsWith('/forecast/hourly')) hourlyTimeouts.push(cfg.timeout);
    if (url.startsWith('/points/')) return ok(cfg, POINT);
    if (url.endsWith('/forecast/hourly')) {
      if (hourlyFails) return hourlyFails(cfg);
      return ok(cfg, hourly);
    }
    if (url.endsWith('/forecast')) return ok(cfg, daily);
    return ok(cfg, {});
  };
}
const app = () => {
  const a = express();
  a.use('/api/weather', weatherRoutes);
  return a;
};
const getDaily = () => request(app()).get('/api/weather/forecast/45.0,-93.3?days=2');

beforeEach(() => {
  requested.length = 0;
  hourlyTimeouts.length = 0;
  Object.values(mockLogger).forEach((f) => f.mockClear());
});

describe('daily relativeHumidity (backend#1306)', () => {
  it('aggregates min/max over hourly periods in [startTime, endTime): inclusive start, exclusive end', async () => {
    // hour 0 (== P1.start) = 40, hour 11 = 90, hour 12 (== P1.end == P2.start) = 10
    const rh = (h) => pct({ 0: 40, 11: 90, 12: 10 }[h] ?? 60);
    upstream = nws({ hourly: hourlyPeriods(24, rh) });
    const res = await getDaily();
    expect(res.status).toBe(200);
    const [p1, p2] = res.body.forecast.periods;
    expect(p1.relativeHumidity).toEqual({ min: 40, max: 90 }); // hour 12 excluded
    expect(p2.relativeHumidity).toEqual({ min: 10, max: 60 }); // hour 12 included
  });

  it('rounds to integer percent', async () => {
    upstream = nws({ hourly: hourlyPeriods(24, (h) => pct(h === 3 ? 41.6 : 70.2)) });
    const res = await getDaily();
    expect(res.body.forecast.periods[0].relativeHumidity).toEqual({ min: 42, max: 70 });
  });

  it('partial hourly coverage: uncovered periods are null, never 0', async () => {
    upstream = nws({ hourly: hourlyPeriods(12, () => pct(55)) }); // covers P1 only
    const res = await getDaily();
    const [p1, p2] = res.body.forecast.periods;
    expect(p1.relativeHumidity).toEqual({ min: 55, max: 55 });
    expect(p2.relativeHumidity).toBeNull();
  });

  it('a period whose hourly values are all null/missing is null', async () => {
    upstream = nws({ hourly: hourlyPeriods(24, (h) => (h < 12 ? pct(null) : undefined)) });
    const res = await getDaily();
    const [p1, p2] = res.body.forecast.periods;
    expect(p1.relativeHumidity).toBeNull();
    expect(p2.relativeHumidity).toBeNull();
  });

  it('keeps a real 0% as 0', async () => {
    upstream = nws({ hourly: hourlyPeriods(24, (h) => pct(h === 5 ? 0 : 30)) });
    const res = await getDaily();
    expect(res.body.forecast.periods[0].relativeHumidity).toEqual({ min: 0, max: 30 });
  });

  it('hourly fetch failure: daily still 200, humidity null, existing fields intact', async () => {
    upstream = nws({ hourlyFails: (cfg) => Promise.reject(Object.assign(new Error('boom'), { config: cfg, response: { status: 500, statusText: 'x', data: {} } })) });
    const res = await getDaily();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    const periods = res.body.forecast.periods;
    expect(periods).toHaveLength(2);
    periods.forEach((p) => {
      expect(p.relativeHumidity).toBeNull();
      expect(p.temperature).toBe(50);
      expect(p.name).toMatch(/^P\d$/);
    });
  });

  it('hourly timeout: daily still 200 with null humidity', async () => {
    upstream = nws({ hourlyFails: (cfg) => Promise.reject(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED', config: cfg })) });
    const res = await getDaily();
    expect(res.status).toBe(200);
    expect(res.body.forecast.periods.every((p) => p.relativeHumidity === null)).toBe(true);
  });

  it('hourly call has its own short timeout (best-effort, <= 3000ms)', async () => {
    upstream = nws({ hourly: hourlyPeriods(24, () => pct(50)) });
    await getDaily();
    expect(hourlyTimeouts).toEqual([3000]);
  });

  it('makes one /points lookup and exactly one extra (hourly) NWS call', async () => {
    upstream = nws({ hourly: hourlyPeriods(24, () => pct(50)) });
    await getDaily();
    expect(requested.filter((u) => u.startsWith('/points/'))).toHaveLength(1);
    expect(requested.filter((u) => u.endsWith('/forecast/hourly'))).toHaveLength(1);
    expect(requested).toHaveLength(3);
  });

  it('privacy (#1290): a failed hourly fetch neither returns nor logs office/grid ids or unrounded coordinates', async () => {
    upstream = nws({ hourlyFails: (cfg) => Promise.reject(Object.assign(new Error('boom'), { config: cfg, response: { status: 503, statusText: 'x', data: { detail: 'MPX/107,71' } } })) });
    const res = await request(app()).get('/api/weather/forecast/45.1234,-93.5678?days=2');
    expect(res.status).toBe(200);
    const logged = JSON.stringify(Object.values(mockLogger).flatMap((f) => f.mock.calls));
    expect(logged).not.toMatch(/MPX|107,71/);
    expect(logged).not.toMatch(/45\.1234|93\.5678/);
    expect(JSON.stringify(res.body)).not.toContain('forecast/hourly');
  });
});

describe('hourly relativeHumidity passthrough (backend#1306)', () => {
  it('exposes each hourly period humidity as a percent number, or null', async () => {
    const rh = (h) => (h === 0 ? pct(0) : h === 1 ? pct(64) : h === 2 ? pct(null) : undefined);
    upstream = nws({ hourly: hourlyPeriods(4, rh) });
    const res = await request(app()).get('/api/weather/forecast/45.0,-93.3?type=hourly&days=1');
    expect(res.status).toBe(200);
    expect(res.body.forecast.periods.map((p) => p.relativeHumidity)).toEqual([0, 64, null, null]);
  });
});

describe('forecast responses carry no NWS grid/office/station identifiers (backend#1308)', () => {
  const FORBIDDEN = /gridId|gridX|gridY|\bMPX\b|107|"office"|station/i;
  it.each([
    ['daily', '?days=2'],
    ['hourly', '?type=hourly&days=1'],
  ])('%s: no identifiers, rounded lat/lon kept', async (_n, qs) => {
    upstream = nws({ hourly: hourlyPeriods(24, () => pct(50)) });
    const res = await request(app()).get(`/api/weather/forecast/45.0,-93.3${qs}`);
    expect(res.status).toBe(200);
    expect(res.body.forecast.location).toEqual({ latitude: 45, longitude: -93.3 });
    expect(JSON.stringify(res.body)).not.toMatch(FORBIDDEN);
  });
});

// Timestamps must be compared as instants, not strings (offsets differ per side).
describe('daily relativeHumidity: instant comparison across offsets (backend#1306)', () => {
  const pad = (n) => String(n).padStart(2, '0');
  // Render an instant as a local wall-clock ISO string with a fixed offset (minutes east of UTC).
  const at = (ms, offsetMin) => {
    const d = new Date(ms + offsetMin * 60e3);
    const sign = offsetMin < 0 ? '-' : '+';
    const a = Math.abs(offsetMin);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:00${sign}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
  };
  const daily = (periods) => ({
    properties: { periods: periods.map(([s, e], i) => ({ number: i + 1, name: `P${i + 1}`, startTime: s, endTime: e, temperature: 50 })) },
  });
  const hourlyRows = (rows) => ({
    properties: { periods: rows.map(([s, v], i) => ({ number: i + 1, startTime: s, temperature: 50, relativeHumidity: pct(v) })) },
  });

  it('daily at -05:00, hourly mixed -06:00 and Z: same hours selected as by instant', async () => {
    // P1 = [T0, T0+12h) written at -05:00; hourly hours written at -06:00 (first half) and Z (second half).
    const dailyP = daily([
      [at(T0, -300), at(T0 + 12 * HOUR, -300)],
      [at(T0 + 12 * HOUR, -300), at(T0 + 24 * HOUR, -300)],
    ]);
    const rows = Array.from({ length: 24 }, (_, h) => [
      h % 2 === 0 ? at(T0 + h * HOUR, -360) : iso(T0 + h * HOUR),
      { 0: 40, 11: 90, 12: 10 }[h] ?? 60,
    ]);
    upstream = nws({ daily: dailyP, hourly: hourlyRows(rows) });
    const res = await getDaily();
    const [p1, p2] = res.body.forecast.periods;
    expect(p1.relativeHumidity).toEqual({ min: 40, max: 90 });
    expect(p2.relativeHumidity).toEqual({ min: 10, max: 60 });
  });

  it('DST fall-back (America/Chicago 2026-11-01): repeated 01:00 wall time with different offsets', async () => {
    const z = (s) => Date.parse(s);
    const cdt0 = z('2026-11-01T00:00:00-05:00'); // 05:00Z
    // Hourly rows: 00:00 CDT, 01:00 CDT, 01:00 CST (same wall time), 02:00 CST.
    const rows = [
      ['2026-11-01T00:00:00-05:00', 10],
      ['2026-11-01T01:00:00-05:00', 20],
      ['2026-11-01T01:00:00-06:00', 30],
      ['2026-11-01T02:00:00-06:00', 90],
    ];
    const dailyP = daily([
      ['2026-11-01T00:00:00-05:00', '2026-11-01T01:30:00-05:00'], // [05:00Z, 06:30Z)
      ['2026-11-01T01:30:00-05:00', '2026-11-01T03:30:00-06:00'], // [06:30Z, 09:30Z)
    ]);
    expect(z(rows[2][0]) - z(rows[1][0])).toBe(HOUR); // sanity: really one hour apart
    expect(z(rows[0][0])).toBe(cdt0);
    upstream = nws({ daily: dailyP, hourly: hourlyRows(rows) });
    const res = await getDaily();
    const [p1, p2] = res.body.forecast.periods;
    expect(p1.relativeHumidity).toEqual({ min: 10, max: 20 }); // 01:00 CST (07:00Z) is NOT in P1
    expect(p2.relativeHumidity).toEqual({ min: 30, max: 90 }); // ...it starts P2
  });
});
