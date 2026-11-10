/**
 * Station coordinates are public at 0.1 degree only. Two places this suite
 * pins that the other coordinate suites do not:
 *
 *  - ENTRY: the write to `weather_submissions`. The submit routes pass the
 *    caller's `location` through as sent, so the one write rounds it.
 *  - EXIT: fixed-point coordinate fields (`latitude_e7`, the chain's station
 *    record spelling, in 1e-7 degree) in a body sent to an anonymous caller.
 *
 * It also pins the shared 0.1 degree helpers on the awkward inputs (negative
 * values, .05 boundaries, strings, nulls). All coordinates are made up.
 */
jest.mock(
  '../database/index.js',
  () => ({
    executeQuery: jest.fn(),
  }),
  { virtual: true },
);

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from '@jest/globals';
import {
  persistWeatherSubmission,
  submissionGridCoordinate,
} from '../server/services/weather-submission-persistence.js';

const {
  anonymousCoordinateGuard,
  coarsenCoordinatesDeep,
  isCoordinateKey,
  isFixedE7CoordinateKey,
} = require('../server/middleware/anonymous-coordinate-guard');
const { coarsenCoordinate } = require('../server/utils/anonymous-projection');
const { toStorageGrid } = require('../server/utils/coordinate-grid');

const OPERATOR = 'test-operator-rounding-0123456789abcdef';
process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;

/** Decimal places of a number or number-like string, as JSON would carry it. */
function decimals(value: unknown): number {
  const text = String(value);
  if (/e/i.test(text)) throw new Error(`exponent form in a coordinate: ${text}`);
  const dot = text.indexOf('.');
  return dot === -1 ? 0 : text.length - dot - 1;
}

describe('the 0.1 degree helpers', () => {
  it('negative values round to the nearest tenth and -0 never escapes', () => {
    expect(toStorageGrid(-20.987654)).toBe(-21);
    expect(toStorageGrid(-20.44)).toBe(-20.4);
    expect(coarsenCoordinate(-20.44)).toBe(-20.4);
    expect(Object.is(toStorageGrid(-0.04), 0)).toBe(true);
    expect(JSON.stringify([toStorageGrid(-0.04), submissionGridCoordinate(-0.04)])).toBe('[0,0]');
  });

  it('.05 boundaries land on a tenth, never between two', () => {
    // The exact tie rule follows the binary value (10.25 is exact, 10.05 is
    // not); what is pinned is that the result is ON the grid and within half
    // a cell of the input.
    for (const input of [10.05, 10.15, 10.25, 10.35, -10.05, -10.15, -10.25, 0.05, -0.05, 89.95, -179.95]) {
      for (const rounded of [toStorageGrid(input), coarsenCoordinate(input), submissionGridCoordinate(input)]) {
        expect(decimals(rounded)).toBeLessThanOrEqual(1);
        expect(Math.abs((rounded as number) - input)).toBeLessThanOrEqual(0.05 + 1e-9);
      }
    }
    expect(toStorageGrid(10.25)).toBe(10.3);
    expect(toStorageGrid(-10.25)).toBe(-10.2);
    expect(toStorageGrid(10.04999)).toBe(10);
    expect(toStorageGrid(10.05001)).toBe(10.1);
  });

  it('strings, nulls and non-numbers', () => {
    expect(coarsenCoordinate('10.123456')).toBe(10.1);
    expect(coarsenCoordinate('-20.987654')).toBe(-21);
    expect(coarsenCoordinate(null)).toBeNull();
    expect(coarsenCoordinate(undefined)).toBeNull();
    expect(coarsenCoordinate('')).toBeNull();
    expect(coarsenCoordinate('north')).toBeNull();
    expect(coarsenCoordinate(Number.NaN)).toBeNull();
    expect(submissionGridCoordinate('10.123456')).toBe(10.1);
    expect(submissionGridCoordinate(' -20.987654 ')).toBe(-21);
    expect(submissionGridCoordinate(null)).toBeNull();
    expect(submissionGridCoordinate(undefined)).toBeNull();
    expect(submissionGridCoordinate('')).toBeNull();
    expect(submissionGridCoordinate('north')).toBeNull();
    expect(submissionGridCoordinate(Number.POSITIVE_INFINITY)).toBeNull();
    expect(submissionGridCoordinate({ latitude: 10.123456 })).toBeNull();
  });
});

describe('entry: the weather_submissions write', () => {
  async function storedLocation(location: unknown) {
    const calls: unknown[][] = [];
    const execute = async (_sql: string, params: unknown[] = []) => {
      calls.push(params);
      return { rows: [{ id: 7, submitted_at: '2026-01-01T00:00:00.000Z', reward_cycle_created: false }] };
    };
    await persistWeatherSubmission(
      {
        stationId: 'station-made-up',
        timestamp: '2026-01-01T00:00:00.000Z',
        temperature: 11.25,
        humidity: 50,
        pressure: 1013.25,
        transportMeta: { source: 'test', location: location as never },
      } as never,
      { execute },
    );
    const insert = calls[calls.length - 1];
    // Positional parameters of the INSERT: $5 latitude, $6 longitude, $7 altitude.
    return { latitude: insert[4], longitude: insert[5], altitude: insert[6], params: insert };
  }

  it('a finer position is stored at one decimal; altitude and readings are untouched', async () => {
    const stored = await storedLocation({ latitude: 10.123456, longitude: -20.987654, altitude: 1234.567 });
    expect(stored.latitude).toBe(10.1);
    expect(stored.longitude).toBe(-21);
    expect(stored.altitude).toBe(1234.567);
    expect(stored.params).toContain(11.25);
    expect(stored.params).toContain(1013.25);
    expect(JSON.stringify(stored.params)).not.toContain('10.123456');
    expect(JSON.stringify(stored.params)).not.toContain('20.987654');
  });

  it('number-like strings are rounded too; a position already on the grid is kept', async () => {
    const fromStrings = await storedLocation({ latitude: '10.16', longitude: '-20.94' });
    expect([fromStrings.latitude, fromStrings.longitude]).toEqual([10.2, -20.9]);
    const onGrid = await storedLocation({ latitude: 10.3, longitude: -20.7 });
    expect([onGrid.latitude, onGrid.longitude]).toEqual([10.3, -20.7]);
  });

  it('no location, nulls and junk store NULL, as before', async () => {
    for (const location of [null, undefined, {}, { latitude: null, longitude: null }, { latitude: 'north', longitude: {} }]) {
      const stored = await storedLocation(location);
      expect([stored.latitude, stored.longitude]).toEqual([null, null]);
    }
  });
});

describe('exit: fixed-point coordinate fields', () => {
  // 10.1234567 and -20.9876543 degrees in 1e-7 degree units.
  const EXACT = {
    station: {
      latitude_e7: 101234567,
      longitude_e7: -209876543,
      elevation_mm: 1234567,
      latitude: 10.1234567,
      longitude: -20.9876543,
    },
    payload: { stationLatE7: '101234567', station_lon_e7: '-209876543', lngE7: 499999, lat_e7: -400000 },
    untouched: { amount_e7: 101234567, plate7: 101234567, slate_e7x: 101234567, note: 'latitude_e7 101234567' },
  };
  const COARSE = {
    station: { latitude_e7: 101000000, longitude_e7: -210000000, elevation_mm: 1234567, latitude: 10.1, longitude: -21 },
    payload: { stationLatE7: '101000000', station_lon_e7: '-210000000', lngE7: 0, lat_e7: 0 },
    untouched: EXACT.untouched,
  };

  function app() {
    const a = express();
    a.use(anonymousCoordinateGuard);
    a.get('/json', (_req, res) => res.json(EXACT));
    a.get('/inline', (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify(EXACT));
    });
    return a;
  }

  it('key matching: fixed-point keys are their own class, plain keys are unchanged', () => {
    for (const key of ['latitude_e7', 'longitude_e7', 'lat_e7', 'lon_e7', 'lng_e7', 'latE7', 'station_lat_e7', 'stationLonE7']) {
      expect(isFixedE7CoordinateKey(key)).toBe(true);
      expect(isCoordinateKey(key)).toBe(false);
    }
    for (const key of ['amount_e7', 'elevation_mm', 'plate7', 'e7', 'latitude', 'cell_lat_e1', 'slate_e7x']) {
      expect(isFixedE7CoordinateKey(key)).toBe(false);
    }
  });

  it.each(['/json', '/inline'])('%s: an anonymous caller gets whole tenths of a degree', async (path) => {
    const res = await request(app()).get(path).expect(200);
    const body = JSON.parse(res.text);
    expect(body).toEqual(COARSE);
    for (const value of [body.station.latitude_e7, body.station.longitude_e7, body.payload.stationLatE7, body.payload.station_lon_e7]) {
      expect(Number(value) % 1_000_000 === 0).toBe(true);
    }
    expect(decimals(body.station.latitude)).toBeLessThanOrEqual(1);
    expect(decimals(body.station.longitude)).toBeLessThanOrEqual(1);
    expect(res.text).not.toContain('-0');
  });

  it('an operator token keeps exact values (positive control)', async () => {
    const res = await request(app()).get('/json').set('Authorization', `Bearer ${OPERATOR}`).expect(200);
    expect(JSON.parse(res.text)).toEqual(EXACT);
  });

  it('non-integer strings, booleans and nested objects under such a key are left alone', () => {
    const odd = { latitude_e7: 'n/a', longitude_e7: true, lat_e7: { raw: 101234567 }, lon_e7: null, lng_e7: '10.5' };
    expect(coarsenCoordinatesDeep(odd)).toEqual(odd);
  });
});
