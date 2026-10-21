/**
 * backend#1303: GET /api/weather/current/<lat,lon> (NWS latest observation:
 * temperature, humidity, pressure, wind) and the explicit `unit=days` for the
 * daily forecast. NWS is faked at the axios adapter; nothing leaves the box.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
jest.mock('../../server/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() },
}));
jest.mock('../../server/services/station-registration-service.js', () => ({
  listRegisteredStations: jest.fn(async () => ({ stations: [], nextCursor: null, hasMore: false })),
}));
jest.mock('../../server/db.js', () => ({ pool: {} }));

let upstream = () => {
  throw new Error('no upstream configured');
};
const requested = [];
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
const STATIONS = {
  features: ['KMSP', 'KFCM', 'KANE', 'KSTP'].map((id) => ({ properties: { stationIdentifier: id } })),
};
const AGE = (ms) => OBS({ timestamp: new Date(Date.now() - ms).toISOString() });
const OBS = (extra = {}) => ({
  properties: {
    timestamp: new Date(Date.now() - 10 * 60000).toISOString(),
    temperature: { value: 12.8, unitCode: 'wmoUnit:degC' },
    relativeHumidity: { value: 0, unitCode: 'wmoUnit:percent' },
    barometricPressure: { value: 101325, unitCode: 'wmoUnit:Pa' },
    seaLevelPressure: { value: null, unitCode: 'wmoUnit:Pa' },
    windSpeed: { value: 0, unitCode: 'wmoUnit:km_h-1' },
    ...extra,
  },
});
const periods = (n) => ({
  properties: { periods: Array.from({ length: n }, (_, i) => ({ number: i + 1, name: `P${i + 1}`, temperature: 50 })) },
});

function ok(cfg, data) {
  return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config: cfg });
}
function nws(obs, perStation) {
  return (cfg) => {
    const url = cfg.url || '';
    requested.push(url);
    if (url.startsWith('/points/')) return ok(cfg, POINT);
    if (url.endsWith('/forecast')) return ok(cfg, periods(14));
    if (url.endsWith('/forecast/hourly')) return ok(cfg, periods(168));
    if (url.endsWith('/stations')) return ok(cfg, STATIONS);
    if (url.includes('/observations/latest')) {
      return ok(cfg, perStation ? perStation[url.split('/')[2]] : obs);
    }
    return ok(cfg, {});
  };
}
const app = () => {
  const a = express();
  a.use('/api/weather', weatherRoutes);
  return a;
};

describe('GET /api/weather/current/:location (backend#1303)', () => {
  beforeEach(() => { requested.length = 0; });

  it('returns temperature, humidity, pressure (hPa), wind and the observation time', async () => {
    upstream = nws(OBS());
    const res = await request(app()).get('/api/weather/current/45.0,-93.3');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('NOAA-NWS');
    expect(res.body.current).toEqual({
      temperatureC: 12.8,
      relativeHumidityPercent: 0,
      barometricPressureHpa: 1013.25,
      seaLevelPressureHpa: null,
      windSpeedKmh: 0,
      observedAt: expect.any(String),
    });
  });

  it('keeps a missing value null, never 0, and a real 0 as 0', async () => {
    upstream = nws(OBS({
      temperature: { value: null, unitCode: 'wmoUnit:degC' },
      relativeHumidity: undefined,
      barometricPressure: { value: null },
    }));
    const res = await request(app()).get('/api/weather/current/45.0,-93.3');
    expect(res.status).toBe(200);
    expect(res.body.current.temperatureC).toBeNull();
    expect(res.body.current.relativeHumidityPercent).toBeNull();
    expect(res.body.current.barometricPressureHpa).toBeNull();
    expect(res.body.current.windSpeedKmh).toBe(0);
  });

  it('does not expose the observing station or the gridpoint', async () => {
    upstream = nws(OBS());
    const res = await request(app()).get('/api/weather/current/45.0,-93.3');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain('KMSP');
    expect(body).not.toMatch(/gridpoint|gridX|107/i);
  });

  it('fresh nearest station: only that station is queried', async () => {
    upstream = nws(null, { KMSP: OBS() });
    await request(app()).get('/api/weather/current/45.0,-93.3');
    expect(requested.filter((u) => u.includes('/observations/'))).toHaveLength(1);
  });

  it('stale nearest station falls back to the next fresh one', async () => {
    upstream = nws(null, { KMSP: AGE(3 * 3600e3), KFCM: OBS({ temperature: { value: 7, unitCode: 'wmoUnit:degC' } }) });
    const res = await request(app()).get('/api/weather/current/45.0,-93.3');
    expect(res.body.status).toBe('success');
    expect(res.body.current.temperatureC).toBe(7);
    expect(JSON.stringify(res.body)).not.toMatch(/KFCM|KMSP/);
  });

  it('all stale (2020 data included): current is null with status unavailable, never success', async () => {
    upstream = nws(null, { KMSP: OBS({ timestamp: '2020-01-01T00:00:00+00:00' }), KFCM: AGE(5 * 3600e3), KANE: AGE(9 * 3600e3) });
    const res = await request(app()).get('/api/weather/current/45.0,-93.3');
    expect(res.status).toBe(200);
    expect(res.body.current).toBeNull();
    expect(res.body.status).toBe('unavailable');
    expect(res.body.reason).toBe('stale_observation');
    expect(requested.filter((u) => u.includes('/observations/'))).toHaveLength(3); // capped, KSTP never asked
  });

  it('a missing observation timestamp is treated as stale', async () => {
    upstream = nws(null, { KMSP: OBS({ timestamp: undefined }), KFCM: OBS({ timestamp: undefined }), KANE: OBS({ timestamp: undefined }) });
    const res = await request(app()).get('/api/weather/current/45.0,-93.3');
    expect(res.body.current).toBeNull();
  });

  it('400s without valid coordinates', async () => {
    upstream = nws(OBS());
    const res = await request(app()).get('/api/weather/current/nowhere');
    expect(res.status).toBe(400);
  });

  it('is behind weatherGetLimiter (standard RateLimit headers present)', async () => {
    upstream = nws(OBS());
    const res = await request(app()).get('/api/weather/current/45.0,-93.3');
    expect(res.headers['ratelimit-limit'] || res.headers['ratelimit']).toBeDefined();
  });
});

describe('daily forecast days semantics (backend#1303)', () => {
  const count = async (qs) => {
    upstream = nws(OBS());
    const res = await request(app()).get(`/api/weather/forecast/45.0,-93.3${qs}`);
    expect(res.status).toBe(200);
    return res.body.forecast.periods.length;
  };

  it('default is unchanged: days counts 12h periods (mobile ?days=14 => 14)', async () => {
    expect(await count('')).toBe(7);
    expect(await count('?days=14')).toBe(14);
  });

  it('unit=days: days is calendar days (2 periods each), capped at the 14 NWS provides', async () => {
    expect(await count('?days=7&unit=days')).toBe(14);
    expect(await count('?days=3&unit=days')).toBe(6);
    expect(await count('?days=30&unit=days')).toBe(14);
  });

  it('unit=days leaves hourly mode alone (already days)', async () => {
    upstream = nws(OBS());
    const res = await request(app()).get('/api/weather/forecast/45.0,-93.3?type=hourly&days=2&unit=days');
    expect(res.body.forecast.periods.length).toBe(48);
  });

  it('unit=days with a non-numeric days is a 400', async () => {
    upstream = nws(OBS());
    const res = await request(app()).get('/api/weather/forecast/45.0,-93.3?unit=days&days=abc');
    expect(res.status).toBe(400);
  });

  it('rejects an unknown unit', async () => {
    upstream = nws(OBS());
    const res = await request(app()).get('/api/weather/forecast/45.0,-93.3?unit=fortnights');
    expect(res.status).toBe(400);
  });
});
