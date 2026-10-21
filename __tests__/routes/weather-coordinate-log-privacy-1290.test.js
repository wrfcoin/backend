/**
 * backend#1290: the weather controller and the NOAA services must never write
 * a caller's coordinates to the log at more than 0.1 deg precision.
 *
 * Mobile sends the phone position to /api/weather/forecast/<lat,lon> and
 * /api/weather/alerts/<lat,lon>. Owner ruling 2026-09-28: exact coordinates
 * are never logged. This drives the REAL router, controller and NOAA services
 * (only the network hop is faked, at the axios adapter, so NOAA's own
 * response interceptor runs) and captures every call to BOTH logger modules
 * on the path: backend/utils/logger (controller) and server/utils/logger
 * (routes, NOAA services).
 */
const express = require('express');
const request = require('supertest');

const captured = [];
function capturingLogger() {
  const record = (level) => jest.fn((...args) => captured.push({ level, args }));
  return {
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    log: record('log'),
  };
}

jest.mock('../../utils/logger', () => ({ logger: capturingLogger() }));
jest.mock('../../server/utils/logger', () => ({ logger: capturingLogger() }));
jest.mock('../../server/services/station-registration-service.js', () => ({
  listRegisteredStations: jest.fn(async () => ({ stations: [], nextCursor: null, hasMore: false })),
}));
jest.mock('../../server/db.js', () => ({ pool: {} }));

// Every axios instance the NOAA services create answers from this fake.
let upstream = () => {
  throw new Error('no upstream configured');
};
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

// Full precision in; the only thing allowed out is the 0.1 deg cell (45.0, -93.3).
const LAT = '44.98765';
const LON = '-93.26543';
// Any rendering of either coordinate with two or more decimals: 44.98765,
// 44.99, 44.9877 (NOAA's own 4-decimal rounding), -93.27, -93.2654, ...
const FINE = /44\.9[0-9]|93\.2[0-9]|44\.98|93\.26/;
// The NWS gridpoint the point resolves to: a ~2.5 km cell, finer than 0.1 deg.
const GRID = /107\s*(,|%2C)\s*71/i;

const POINT = {
  properties: {
    gridId: 'MPX',
    gridX: 107,
    gridY: 71,
    forecast: 'https://api.weather.gov/gridpoints/MPX/107,71/forecast',
    forecastHourly: 'https://api.weather.gov/gridpoints/MPX/107,71/forecast/hourly',
    observationStations: 'https://api.weather.gov/gridpoints/MPX/107,71/stations',
  },
};
const PERIODS = { properties: { periods: [{ number: 1, name: 'Tonight', temperature: 50 }] } };
const STATIONS = {
  features: [
    {
      properties: { stationIdentifier: 'KMSP', name: 'MSP' },
      geometry: { coordinates: [-93.1, 44.7, 256] },
    },
  ],
};

function ok(cfg, data) {
  return Promise.resolve({ data, status: 200, statusText: 'OK', headers: {}, config: cfg });
}

/** Healthy NOAA NWS + NCEI. */
function healthy(cfg) {
  const url = cfg.url || '';
  if (url.startsWith('/points/')) return ok(cfg, POINT);
  if (url.endsWith('/forecast') || url.endsWith('/forecast/hourly')) return ok(cfg, PERIODS);
  if (url.endsWith('/stations') && url.includes('gridpoints')) return ok(cfg, STATIONS);
  if (url.includes('/observations/latest')) return ok(cfg, { properties: { temperature: { value: 10 } } });
  if (url === '/alerts/active') return ok(cfg, { features: [], updated: 'now' });
  if (url === '/stations') return ok(cfg, { results: [] });
  return ok(cfg, {});
}

/** NOAA answers 404 with a body that echoes the (4-decimal) point, as it does live. */
function noaaFailure(cfg, axios) {
  const detail = `Unable to provide data for requested point ${Number(LAT).toFixed(4)},${Number(LON).toFixed(4)}`;
  const response = {
    status: 404,
    statusText: 'Not Found',
    headers: {},
    config: cfg,
    data: { title: 'Data Unavailable For Requested Point', detail, instance: `https://api.weather.gov/points/${LAT},${LON}` },
  };
  return Promise.reject(
    new axios.AxiosError('Request failed with status code 404', 'ERR_BAD_REQUEST', cfg, null, response),
  );
}

/** /points resolves, then every gridpoint call (forecast, hourly, stations) 500s. */
function gridpoint5xx(cfg, axios) {
  const url = cfg.url || '';
  if (url.startsWith('/points/')) return ok(cfg, POINT);
  const response = {
    status: 500,
    statusText: 'Internal Server Error',
    headers: {},
    config: cfg,
    data: { title: 'Unexpected Problem', detail: 'An unexpected problem has occurred.' },
  };
  return Promise.reject(
    new axios.AxiosError('Request failed with status code 500', 'ERR_BAD_RESPONSE', cfg, null, response),
  );
}

/** NOAA answers 200 with junk, so the service and controller take their own error paths. */
function malformed(cfg) {
  return ok(cfg, {});
}

function buildApp() {
  const app = express();
  app.use('/api/weather', weatherRoutes);
  return app;
}

const ENDPOINTS = [
  ['forecast (path)', `/api/weather/forecast/${LAT},${LON}`],
  ['forecast hourly (path)', `/api/weather/forecast/${LAT},${LON}?type=hourly&days=1`],
  ['forecast (query)', `/api/weather/forecast/here?lat=${LAT}&lng=${LON}`],
  ['alerts (path)', `/api/weather/alerts/${LAT},${LON}`],
  ['current (path)', `/api/weather/data/${LAT},${LON}`],
  ['current observations (path, #1303)', `/api/weather/current/${LAT},${LON}`],
  ['current observations (query, #1303)', `/api/weather/current/here?lat=${LAT}&lng=${LON}`],
  ['historical (path)', `/api/weather/historical/${LAT},${LON}?startDate=2026-01-01&endDate=2026-01-02`],
  ['nearby stations (query)', `/api/weather/stations?lat=${LAT}&lng=${LON}`],
];

function leakedLines() {
  return captured
    .map(({ level, args }) => `${level} ${JSON.stringify(args)}`)
    .filter((line) => FINE.test(line) || GRID.test(line));
}

describe('weather path logs no full-precision caller coordinates (backend#1290)', () => {
  beforeEach(() => {
    captured.length = 0;
  });

  for (const [scenario, fake] of [
    ['success', healthy],
    ['error (malformed upstream)', malformed],
    ['NOAA failure (404 echoing the point)', noaaFailure],
  ]) {
    describe(scenario, () => {
      it.each(ENDPOINTS)('%s', async (_name, path) => {
        upstream = fake;
        await request(buildApp()).get(path);
        // The scenario must actually have produced log output, or this is blind.
        expect(captured.length).toBeGreaterThan(0);
        expect(leakedLines()).toEqual([]);
      }, 20000);
    });
  }

  // Reviewer P1 on #1291: a NOAA 5xx AFTER /points logged the gridpoint URL
  // (.../gridpoints/MPX/107,71/forecast). Only reads that go past /points.
  describe('NOAA 5xx on the gridpoint calls after /points resolves', () => {
    it.each(ENDPOINTS.filter(([name]) => /forecast|current|nearby/.test(name)))('%s', async (_name, path) => {
      upstream = gridpoint5xx;
      await request(buildApp()).get(path);
      const lines = captured.map(({ level, args }) => `${level} ${JSON.stringify(args)}`);
      // Not blind: the interceptor really logged a gridpoint request.
      expect(lines.some((line) => line.includes('NOAA API Error') && line.includes('/gridpoints/'))).toBe(true);
      expect(leakedLines()).toEqual([]);
    }, 20000);
  });

  // Reviewer P3 on #1291: the nearest observation station can place a caller
  // finer than 0.1 deg in a dense metro area.
  it('does not log the nearest station id on a current-weather read', async () => {
    upstream = healthy;
    await request(buildApp()).get(`/api/weather/data/${LAT},${LON}`);
    expect(captured.length).toBeGreaterThan(0);
    expect(JSON.stringify(captured)).not.toContain('KMSP');
  }, 20000);

  it('does not log the nearest station id on the #1303 current-observations read', async () => {
    upstream = healthy;
    await request(buildApp()).get(`/api/weather/current/${LAT},${LON}`);
    expect(captured.length).toBeGreaterThan(0);
    expect(JSON.stringify(captured)).not.toContain('KMSP');
  }, 20000);

  it('still logs the coarse 0.1 deg cell, so the log keeps its diagnostic value', async () => {
    upstream = healthy;
    await request(buildApp()).get(`/api/weather/forecast/${LAT},${LON}`);
    const all = JSON.stringify(captured);
    expect(all).toContain('"latitude":45');
    expect(all).toContain('"longitude":-93.3');
  }, 20000);
});

// backend#1304 P1: /points and the station list succeed, then the station's
// observations call fails; handleAPIError must not log /stations/<id>.
describe('observation-station failure logs no station id (backend#1304)', () => {
  // backend#1305: generic text redaction cannot recognize a station under
  // arbitrary keys. Only the /stations error-body guard protects this payload.
  it('drops the entire station error body even for arbitrary id/name keys (#1305)', async () => {
    captured.length = 0;
    upstream = (cfg, axios) => {
      if (!String(cfg.url || '').includes('/observations/latest')) {
        return healthy(cfg);
      }
      const response = {
        status: 500, statusText: 'Internal Server Error', headers: {}, config: cfg,
        // No station/stationIdentifier keys or /stations/ URL text: this must
        // not pass merely because STATION_FIELD/STATION_PATH masks the body.
        data: { properties: { id: 'KMSP', name: 'Minneapolis KMSP' } },
      };
      return Promise.reject(new axios.AxiosError(
        'Request failed with status code 500', 'ERR_BAD_RESPONSE', cfg, null, response,
      ));
    };
    await request(buildApp()).get(`/api/weather/current/${LAT},${LON}`);
    const errors = captured.filter(({ args }) =>
      args[0] === 'NOAA API Error:' && String(args[1]?.url || '').includes('/observations/latest'),
    );
    // Prove the real response interceptor actually saw the failing station read.
    expect(errors.length).toBeGreaterThan(0);
    for (const { args } of errors) {
      expect(args[1].status).toBe(500);
      expect(args[1]).not.toHaveProperty('data');
    }
    expect(JSON.stringify(captured)).not.toContain('KMSP');
    expect(leakedLines()).toEqual([]);
  }, 20000);

  const stationFailure = (status, code) => (cfg, axios) => {
    const url = cfg.url || '';
    if (url.includes('/observations/latest')) {
      if (code === 'ECONNABORTED') {
        return Promise.reject(new axios.AxiosError('timeout of 10000ms exceeded', 'ECONNABORTED', cfg));
      }
      const response = {
        status, statusText: 'x', headers: {}, config: cfg,
        data: { title: 'Failure', detail: 'bad', instance: `https://api.weather.gov${url}`, station: 'KMSP', stationIdentifier: 'KMSP', nested: { station: 'https://api.weather.gov/stations/KMSP' } },
      };
      return Promise.reject(new axios.AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_RESPONSE', cfg, null, response));
    }
    return healthy(cfg);
  };

  it.each([
    ['500', stationFailure(500)],
    ['404', stationFailure(404)],
    ['timeout', stationFailure(0, 'ECONNABORTED')],
  ])('observations %s', async (_n, fake) => {
    captured.length = 0;
    upstream = fake;
    await request(buildApp()).get(`/api/weather/current/${LAT},${LON}`);
    const lines = captured.map(({ level, args }) => `${level} ${JSON.stringify(args)}`);
    expect(lines.some((l) => l.includes('NOAA API Error') && l.includes('observations/latest'))).toBe(true);
    expect(lines.join('\n')).not.toContain('KMSP');
    expect(leakedLines()).toEqual([]);
  }, 20000);
});

describe('station fields in redactCoordinateText (backend#1304)', () => {
  const { redactCoordinateText } = require('../../server/utils/log-coordinates');
  it('redacts bare station / stationIdentifier values anywhere in a body', () => {
    const out = redactCoordinateText({ a: { station: 'KMSP' }, stationIdentifier: 'KFCM', ok: 'keep' });
    expect(out).not.toMatch(/KMSP|KFCM/);
    expect(out).toContain('keep');
  });
});

describe('redactCoordinateText (backend#1290)', () => {
  const { redactCoordinateText } = require('../../server/utils/log-coordinates');

  it.each([
    ['https://api.weather.gov/gridpoints/MPX/107,71/forecast', 'https://api.weather.gov/gridpoints/MPX/*/forecast'],
    ['/gridpoints/MPX/107%2C71/stations', '[REDACTED: encoded coordinate text]'],
    ['/points/44.98765,-93.26543', '/points/45.0,-93.3'],
    ['point -.98765', 'point -1.0'],
    ['/points/44%2E98765,-93%2e26543', '[REDACTED: encoded coordinate text]'],
    ['/points/45.0,-93.3', '/points/45.0,-93.3'],
    ['/stations/KMSP/observations/latest', '/stations/*/observations/latest'],
    ['https://api.weather.gov/gridpoints/MPX/107,71/stations', 'https://api.weather.gov/gridpoints/MPX/*/stations'],
    ['/stations', '/stations'],
    ['/api/demo/x%2Dy%2Ez%20w', '/api/demo/x%2Dy%2Ez%20w'],
    ['/points/4498765e-5,%2D9326543e-5', '[REDACTED: encoded coordinate text]'],
    ['/points/449876%2E5e-4,-932654%2E3e-4', '[REDACTED: encoded coordinate text]'],
    ['/points/4498765%65-5,-9326543%45-5', '[REDACTED: encoded coordinate text]'],
    ['/api/demo/a%65b%45c', '/api/demo/a%65b%45c'],
    // round 5: encoded separators, double encoding, malformed escapes (never throws), byte-stable when no coordinate
    ['points%2F4498765%65-5,%2D9326543%65-5', '[REDACTED: encoded coordinate text]'],
    ['/points/4498765e-5%2C9326543e-5', '[REDACTED: encoded coordinate text]'],
    ['points%252F4498765%2565-5,%252D9326543%2565-5', '[REDACTED: encoded coordinate text]'],
    ['/points/44.98765%zz,%', '/points/45.0%zz,%'],
    ['/api/a%2Fb%2Cc%20d%%', '/api/a%2Fb%2Cc%20d%%'],
    // encoded fine coordinate inside otherwise harmless text: the whole value goes
    ['upstream said: points%2F4498765%65-5 while fetching', '[REDACTED: encoded coordinate text]'],
    // controls: escapes present but only coarse (<= 0.1 degree) or no coordinates: bytes unchanged
    ['/points/45.0,-93.3%2Fx%20y', '/points/45.0,-93.3%2Fx%20y'],
    ['/points/45.0%2C-93.3?q=a%20b', '/points/45.0%2C-93.3?q=a%20b'],
    ['GET /api/v1/search?q=hello%20world%21&page=2%2F5', 'GET /api/v1/search?q=hello%20world%21&page=2%2F5'],
  ])('%s -> %s', (input, expected) => {
    expect(redactCoordinateText(input)).toBe(expected);
  });

  // Nested encoding: every character percent-encoded once, then '%' -> '%25' (levels - 1) more times.
  const encodeDeep = (text, levels) => {
    let out = [...text].map((ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')).join('');
    for (let i = 1; i < levels; i += 1) out = out.replace(/%/g, '%25');
    return out;
  };
  const PLACEHOLDER = '[REDACTED: encoded coordinate text]';

  it.each([5, 6, 8])('a coordinate encoded %i levels deep inside harmless text is dropped whole', (levels) => {
    const out = redactCoordinateText('upstream said: points/' + encodeDeep('4498765e-5,-9326543e-5', levels) + ' while fetching');
    expect(out).toBe(PLACEHOLDER);
  });

  it.each([6, 9])('a harmless string encoded %i levels deep also gets the placeholder (accepted: fails safe)', (levels) => {
    expect(redactCoordinateText('note: ' + encodeDeep('hello world', levels))).toBe(PLACEHOLDER);
  });

  it('a harmless string encoded within the pass limit keeps its bytes', () => {
    const input = 'note: ' + encodeDeep('hello world', 2);
    expect(redactCoordinateText(input)).toBe(input);
  });

  it('the placeholder replaces the whole value and no digit of the hidden number survives', () => {
    const out = redactCoordinateText('upstream said: points%2F4498765%65-5 while fetching');
    expect(out).toBe('[REDACTED: encoded coordinate text]');
    expect(out).not.toMatch(/4498765|44\.98/);
  });
});
