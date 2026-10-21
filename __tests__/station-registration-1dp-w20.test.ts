/**
 * W20 (owner ruling 2026-10-01, frontend#437): a station registration is kept
 * at 0.1 degree, like the phones. Anything finer is rounded before it is
 * stored, used as the fallback location label, or sent to the DEM lookup.
 * Obviously fake coordinates.
 */
import { describe, expect, it, jest } from '@jest/globals';
import {
  registerStation,
  toRegistrationGrid,
  USGS_EPQS_URL,
  type QueryablePool,
  type FetchLike,
} from '../server/services/station-registration-service.js';

const ENC_KEY = 'a'.repeat(64);
const OWNER = '0x' + '1'.repeat(40);
const FINE = /10\.123456|20\.987654|10\.12\b|20\.98\b/;

function mockPool() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const pool: QueryablePool = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)')) return { rows: [{ n: 0 }] };
      return { rows: [] };
    }),
  };
  return { pool, calls };
}

function demFetch(): jest.Mock {
  return jest.fn(async (url: string) => {
    if (!url.startsWith(USGS_EPQS_URL)) throw new Error(`unexpected URL in test: ${url}`);
    return { ok: true, status: 200, json: async () => ({ value: '100.0' }) };
  });
}

async function register(input: Record<string, unknown>) {
  const { pool, calls } = mockPool();
  const fetchFn = demFetch();
  const result = await registerStation(
    { name: 'Fake W20 station', ...input },
    OWNER,
    { pool, fetchFn: fetchFn as unknown as FetchLike, encryptionKey: ENC_KEY },
    () => 'abc123',
  );
  const insert = calls.find((c) => c.sql.includes('INSERT INTO weather_stations'));
  return { result, calls, fetchFn, insert };
}

describe('station registration at 0.1 degree (W20)', () => {
  it.each([
    ['numbers', 10.123456, -20.987654],
    ['strings', '10.123456', '-20.987654'],
  ])('fine %s are stored, labelled and looked up at 0.1 degree', async (_label, latitude, longitude) => {
    const { result, fetchFn, insert, calls } = await register({ latitude, longitude });
    expect(result.status).toBe(201);
    if (!insert) throw new Error('no weather_stations insert');
    // [stationId, owner, location, latitude, longitude, name, stationType, metadata]
    expect(insert.params[3]).toBe(10.1);
    expect(insert.params[4]).toBe(-21);
    expect(insert.params[2]).toBe('10.1,-21');
    const url = new URL(String(fetchFn.mock.calls[0][0]));
    expect(url.searchParams.get('y')).toBe('10.1');
    expect(url.searchParams.get('x')).toBe('-21');
    // Nothing finer is written, sent or answered anywhere.
    expect(JSON.stringify(calls.map((c) => c.params))).not.toMatch(FINE);
    expect(JSON.stringify(result.body)).not.toMatch(FINE);
  });

  it('a value already on the grid is kept; a tiny negative is stored as 0, not -0', async () => {
    const { insert } = await register({ latitude: 10.1, longitude: -0.04 });
    expect(insert?.params[3]).toBe(10.1);
    expect(Object.is(insert?.params[4], 0)).toBe(true);
    expect(insert?.params[2]).toBe('10.1,0');
  });

  it('an owner-entered location label is kept as entered (the label is not a coordinate field)', async () => {
    const { insert } = await register({ latitude: 10.123456, longitude: -20.987654, location: 'Fake Town' });
    expect(insert?.params[2]).toBe('Fake Town');
    expect(insert?.params[3]).toBe(10.1);
  });

  it('range validation still runs on the input, before rounding', async () => {
    for (const [latitude, longitude] of [[90.04, 0], [-90.04, 0], [0, 180.04], [0, -180.04], [91, 0]]) {
      const { result } = await register({ latitude, longitude });
      expect(result.status).toBe(400);
    }
  });

  it('toRegistrationGrid: one decimal, -0 never escapes', () => {
    expect(toRegistrationGrid(10.123456)).toBe(10.1);
    expect(toRegistrationGrid(-20.987654)).toBe(-21);
    expect(toRegistrationGrid(10.16)).toBe(10.2);
    expect(Object.is(toRegistrationGrid(-0.04), 0)).toBe(true);
    expect(toRegistrationGrid(90)).toBe(90);
    expect(toRegistrationGrid(-180)).toBe(-180);
  });
});
