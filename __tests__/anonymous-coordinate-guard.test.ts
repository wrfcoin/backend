/**
 * backend#1222 (owner ruling 2026-10-01): the blanket response rule. No body
 * sent to an anonymous caller carries a horizontal coordinate field finer than
 * 0.1 degree. Field-aware (backend#1397 review): strings, ids and non-horizontal
 * axes are never rewritten. Authorized callers keep exact values. All
 * coordinates are obviously fake.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';

const {
  anonymousCoordinateGuard,
  coarsenCoordinatesDeep,
} = require('../server/middleware/anonymous-coordinate-guard');
// backend#1397 r5: the name rule lives in the station projections, not the guard.
const { coarsenCoordinatesInName } = require('../server/utils/anonymous-projection');

const OPERATOR = 'test-operator-guard-0123456789abcdef';
// Shared with frontend#436 (contract-fixtures/station-name-public-vectors.json):
// the two copies must stay byte-identical, so both suites pin the same hash.
const VECTORS_PATH = resolve(__dirname, '../contract-fixtures/station-name-public-vectors.json');
const VECTORS_SHA256 = 'e38a4fa25237ebad65397e92c43ddd7213e553bf0da681cbd10bdecac6701585'; // pragma: allowlist secret — sha256 of a test fixture
process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;

// Coordinate fields in every shape the guard knows: plain and nested numbers,
// number-like strings (decimal, exponent, plus), suffix names, GeoJSON (2D and
// 3D: the altitude must survive), bbox and center. Next to them, values that
// must NOT change: an opaque id that looks like a pair, free text, amounts.
const EXACT = {
  location: { latitude: 10.123456, longitude: -20.987654, name: 'kept as sent' },
  near: { lat: '1.0123456e1', lng: '+20.654321', radius_km: 25 },
  current: { temperature: 11.25, stationLat: '10.123456', station_lng: -20.987654 },
  geometry: { type: 'Point', coordinates: [-20.987654, 10.123456] },
  point3d: { type: 'Point', coordinates: [20.654321, 10.123456, 1234.567] },
  line: { type: 'LineString', coordinates: [[-20.987654, 10.123456], [-20.912345, 10.198765]] },
  bbox: [-20.987654, 10.123456, -20.912345, 10.198765],
  center: [-20.987654, 10.123456],
  rows: [{ lat: 10.16, lon: 20.66 }],
  id: '10.123456,20.654321',
  note: 'centred near 10.123456, 20.654321 today',
};

const COARSE = {
  location: { latitude: 10.1, longitude: -21, name: 'kept as sent' },
  near: { lat: '10.1', lng: '20.7', radius_km: 25 },
  current: { temperature: 11.25, stationLat: '10.1', station_lng: -21 },
  geometry: { type: 'Point', coordinates: [-21, 10.1] },
  point3d: { type: 'Point', coordinates: [20.7, 10.1, 1234.567] },
  line: { type: 'LineString', coordinates: [[-21, 10.1], [-20.9, 10.2]] },
  bbox: [-21, 10.1, -20.9, 10.2],
  center: [-21, 10.1],
  rows: [{ lat: 10.2, lon: 20.7 }],
  id: '10.123456,20.654321',
  note: 'centred near 10.123456, 20.654321 today',
};

function app(options: { user?: boolean; routeFlag?: unknown } = {}) {
  const a = express();
  if (options.user) {
    a.use((req: any, _res, next) => { req.user = { id: 'fake-user' }; next(); });
  }

  a.use(anonymousCoordinateGuard);
  if (options.routeFlag !== undefined) {
    // A route that authorized the caller itself (e.g. the IoT router for its gateway admin
    // token) sets the flag AFTER the guard is mounted, as a router does.
    a.use((req: any, _res, next) => { req.exactCoordinatesAuthorized = options.routeFlag; next(); });
  }
  a.get('/json', (_req, res) => res.json(EXACT));
  // The live entrypoint's inline handler: writeHead + end(JSON.stringify(...)).
  a.get('/inline', (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(EXACT));
  });
  a.get('/send-string', (_req, res) => {
    res.type('application/json').send(JSON.stringify(EXACT));
  });
  a.get('/text', (_req, res) => res.type('text/plain').send('10.123456,-20.987654'));
  // backend#1397 r8: the same handlers under several namespaces, for the
  // route-flag scope controls.
  for (const prefix of ['/api/iotex', '/API/IoTeX', '/api/weather', '/api/iotex-other', '/api/iotexx']) {
    a.get(`${prefix}/json`, (_req, res) => res.json(EXACT));
    a.get(`${prefix}/inline`, (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(EXACT));
    });
  }
  return a;
}

describe('anonymous coordinate guard', () => {
  it.each(['/json', '/inline', '/send-string'])('%s: anonymous callers get one decimal everywhere', async (path) => {
    const res = await request(app()).get(path).expect(200);
    expect(JSON.parse(res.text)).toEqual(COARSE);
  });

  it('a JSON body sent as a string keeps a correct Content-Length', async () => {
    const res = await request(app()).get('/send-string').expect(200);
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.text));
  });

  it('an operator token keeps exact values (positive control)', async () => {
    for (const path of ['/json', '/inline', '/send-string']) {
      const res = await request(app()).get(path).set('Authorization', `Bearer ${OPERATOR}`).expect(200);
      expect(JSON.parse(res.text)).toEqual(EXACT);
    }
  });

  it('an authenticated user (req.user set by an auth middleware) keeps exact values', async () => {
    const res = await request(app({ user: true })).get('/json').expect(200);
    expect(res.body).toEqual(EXACT);
  });

  it('the route flag (exactCoordinatesAuthorized === true) keeps exact values on /api/iotex paths only', async () => {
    for (const path of ['/api/iotex/json', '/api/iotex/inline', '/API/IoTeX/json', '/api/iotex/json?x=1']) {
      const res = await request(app({ routeFlag: true })).get(path).expect(200);
      expect(JSON.parse(res.text)).toEqual(EXACT);
    }
  });

  it('the route flag is refused outside /api/iotex, for res.json and res.end alike (backend#1397 r8)', async () => {
    for (const path of [
      '/api/weather/json', '/api/weather/inline',
      '/api/iotex-other/json', '/api/iotex-other/inline',
      '/api/iotexx/json', '/json', '/inline',
    ]) {
      const res = await request(app({ routeFlag: true })).get(path).expect(200);
      expect({ path, body: JSON.parse(res.text) }).toEqual({ path, body: COARSE });
    }
  });

  it('look-alike flag values are refused even on /api/iotex paths', async () => {
    for (const lookalike of ['true', 1, {}]) {
      const anon = await request(app({ routeFlag: lookalike })).get('/api/iotex/json').expect(200);
      expect(anon.body).toEqual(COARSE);
    }
  });

  it('a wrong bearer token is anonymous', async () => {
    const res = await request(app()).get('/json').set('Authorization', 'Bearer not-the-operator').expect(200);
    expect(res.body).toEqual(COARSE);
  });

  it('non-JSON bodies pass through untouched', async () => {
    const res = await request(app()).get('/text').expect(200);
    expect(res.text).toBe('10.123456,-20.987654');
  });

  it('leaves non-coordinates alone', () => {
    const value = {
      flat: 10.123456,
      format: '10.123456',
      temperature: 21.456,
      amount: '1234.5678',
      timestamp: '2026-10-01T09:20:10.123Z',
      version: '1.2.3',
      pair_out_of_range: '200.123,10.456',
      nested: [{ pressure: 1013.25 }],
      when: new Date('2026-10-01T00:00:00.000Z'),
    };
    expect(coarsenCoordinatesDeep(value)).toEqual({ ...value, when: '2026-10-01T00:00:00.000Z' });
  });

  it('backend#1397 review controls: an opaque id and free text are never rewritten; a 3D altitude survives', async () => {
    const res = await request(app()).get('/json').expect(200);
    expect(res.body.id).toBe('10.123456,20.654321');
    expect(res.body.note).toBe('centred near 10.123456, 20.654321 today');
    expect(res.body.point3d.coordinates[2]).toBe(1234.567);
    expect(res.body.location.name).toBe('kept as sent');
  });

  it('station-projection name rule: coordinate-like numbers at one decimal; the global guard never rewrites a name', () => {
    expect(coarsenCoordinatesInName('Hilltop 10.123456,-21')).toBe('Hilltop 10.1,-21');
    expect(coarsenCoordinatesInName('At 1.0123456e1, +20.654321')).toBe('At 10.1, 20.7');
    // backend#1397 r3: leading-dot decimals, with signs and exponents.
    expect(coarsenCoordinatesInName('H11 Station .10123456,-.20987654')).toBe('H11 Station 0.1,-0.2');
    expect(coarsenCoordinatesInName('Ridge +.10123456e2')).toBe('Ridge 10.1');
    for (const ordinary of ['Hilltop station', 'Station 42', 'v2', '1.', 'Unit .5', 'Elev 1234.567 m', '10.1,-21.0']) {
      expect(coarsenCoordinatesInName(ordinary)).toBe(ordinary);
    }
    // One numeric-token grammar: empty fractions and exponents are numbers too.
    expect(coarsenCoordinatesInName('Site 1.e-3')).toBe('Site 0');
    // The accepted cost: a fine non-coordinate in a name is coarsened too.
    expect(coarsenCoordinatesInName('v2.15 build 1.2.3')).toBe('v2.2 build 1.2.3');
    // The global guard never rewrites text, names included (backend#1397 r5): an NWS forecast
    // period label such as "Tonight 1.e-3" reaches an anonymous caller exactly as sent.
    const text = {
      name: 'Tonight 1.e-3',
      stationName: 'Ridge 10.123456',
      display_name: 'Hilltop 10.123456,-21',
      periods: [{ name: 'Tonight 1.e-3', detailedForecast: 'near 10.123456,-21' }],
    };
    expect(coarsenCoordinatesDeep(text)).toEqual(text);
  });

  it('station names match the shared vector table, byte-identical to frontend#436 (sha256-pinned)', () => {
    const bytes = readFileSync(VECTORS_PATH);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(VECTORS_SHA256);
    const { rows } = JSON.parse(bytes.toString('utf8')) as { rows: Array<{ input: string; public: string }> };
    expect(rows.length).toBeGreaterThanOrEqual(30);
    for (const row of rows) {
      expect({ input: row.input, public: coarsenCoordinatesInName(row.input) }).toEqual(row);
      // The guard leaves every name as sent; only the station projections apply this rule.
      expect(coarsenCoordinatesDeep({ stationName: row.input })).toEqual({ stationName: row.input });
    }
  });

  it('number-like strings in coordinate fields: exponent and plus forms are rounded too', () => {
    expect(coarsenCoordinatesDeep({ lat: '1.0123456e1', lon: '+10.123456', lng: '-2.0987654E1' })).toEqual({
      lat: '10.1',
      lon: '10.1',
      lng: '-21',
    });
    // Not a number: untouched.
    expect(coarsenCoordinatesDeep({ lat: 'unknown' })).toEqual({ lat: 'unknown' });
  });
});
});
