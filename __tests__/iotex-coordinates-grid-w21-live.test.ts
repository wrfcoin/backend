/**
 * W21 (owner ruling 2026-10-01, frontend#437; residual of backend#1401): on the live
 * entrypoint with real Postgres, a privileged IoT create or update stores a device
 * position at 0.1 degree only, for both privileged callers, and the geohash and
 * geo-fence see the grid point too. The raw value is range-checked before rounding.
 * Obviously fake coordinates. Rows are read back through the privileged API, which
 * returns the stored row (projectDevice); the migration pool is ended in beforeAll,
 * long before the FORCE drop (backend#1402).
 */
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { bootLiveEntrypoint, type Booted } from './helpers/anonymous-get-harness';

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;
if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('MOBILE_STATION_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('the live iotex coordinate-grid test would have been skipped');
  });
}

// The harness boots the entrypoint with these tokens.
const CALLERS: Array<[string, Record<string, string>]> = [
  ['operator bearer', { authorization: 'Bearer test-operator-h11-0123456789abcdef' }],
  ['IoT gateway admin token', { 'x-iot-gateway-admin-token': 'test-iot-admin-h11-0123456789abcdef' }],
];
const OWNER = '0xf6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6f6';
const FINE = /10\.123456|20\.987654|11\.234567|22\.876543|10\.12\b|20\.98\b|11\.23\b|22\.87\b/;

d('IoT device positions at 0.1 degree on the live entrypoint (W21)', () => {
  const dbName = `iotexw21_${process.pid}_${Date.now().toString(36)}`;
  let admin: Pool;
  let app: Booted;
  let n = 0;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    const dbUrl = u.toString();
    const migrations = new Pool({ connectionString: dbUrl, max: 1 });
    try {
      const dir = path.join(__dirname, '../drizzle/migrations');
      for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
        await migrations.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      }
    } finally {
      await migrations.end();
    }
    app = await bootLiveEntrypoint(dbUrl);
  }, 240_000);

  afterAll(async () => {
    try {
      await app?.stop();
    } finally {
      await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin?.end();
    }
  });

  const call = async (method: string, urlPath: string, headers: Record<string, string>, body?: unknown) => {
    const res = await fetch(`http://127.0.0.1:${app.port}${urlPath}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, text, body: JSON.parse(text) };
  };
  const create = (headers: Record<string, string>, coords: Record<string, unknown>) =>
    call('POST', '/api/iotex/devices', headers, {
      name: `Fake W21 sensor ${n++}`,
      type: 'WEATHER_STATION',
      owner: OWNER,
      ...coords,
    });
  const deviceCount = async () => {
    const list = await call('GET', '/api/iotex/devices?limit=100', CALLERS[0][1]);
    return list.body.pagination.total as number;
  };

  it.each(CALLERS)('%s: create and update store 0.1 degree, never the finer value', async (_label, headers) => {
    const created = await create(headers, { latitude: 10.123456, longitude: '-20.987654' });
    expect(created.status).toBe(201);
    expect(created.body.device).toMatchObject({ latitude: 10.1, longitude: -21 });
    const id = created.body.device.id as string;
    const stored = await call('GET', `/api/iotex/devices/${id}`, headers);
    expect(stored.body.device).toMatchObject({ latitude: 10.1, longitude: -21 });

    const updated = await call('PUT', `/api/iotex/devices/${id}`, headers, { latitude: '11.234567', longitude: -22.876543 });
    expect(updated.status).toBe(200);
    expect(updated.body.device).toMatchObject({ latitude: 11.2, longitude: -22.9 });
    const after = await call('GET', `/api/iotex/devices/${id}`, headers);
    expect(after.body.device).toMatchObject({ latitude: 11.2, longitude: -22.9 });

    for (const r of [created, stored, updated, after]) expect(r.text).not.toMatch(FINE);
  });

  it('the geohash and the geo-fence decision see the grid point: a finer input hashes like its grid point', async () => {
    const [, headers] = CALLERS[0];
    const fine = await create(headers, { latitude: 10.123456, longitude: -20.987654 });
    const grid = await create(headers, { latitude: 10.1, longitude: -21 });
    expect(fine.status).toBe(201);
    expect(grid.status).toBe(201);
    expect(typeof fine.body.device.geohash).toBe('string');
    expect(fine.body.device.geohash).toBe(grid.body.device.geohash);
    expect(fine.body.device.geoFenceStatus).toBe(grid.body.device.geoFenceStatus);
  });

  it('the raw value is range-checked before rounding; a refused create or update writes nothing', async () => {
    const [, headers] = CALLERS[1];
    const before = await deviceCount();
    for (const coords of [
      { latitude: 90.04, longitude: 0 },
      { latitude: -90.04, longitude: 0 },
      { latitude: 0, longitude: 180.04 },
      { latitude: 0, longitude: -180.04 },
      { latitude: 'abc', longitude: 0 },
      { latitude: 0, longitude: true },
    ]) {
      const res = await create(headers, coords);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        success: false,
        message: 'latitude must be a number in [-90, 90] and longitude a number in [-180, 180]',
        code: 'INVALID_COORDINATES',
      });
    }
    expect(await deviceCount()).toBe(before);

    const ok = await create(headers, { latitude: 10.1, longitude: -21 });
    const id = ok.body.device.id as string;
    const refused = await call('PUT', `/api/iotex/devices/${id}`, headers, { latitude: 90.04 });
    expect(refused.status).toBe(400);
    const unchanged = await call('GET', `/api/iotex/devices/${id}`, headers);
    expect(unchanged.body.device).toMatchObject({ latitude: 10.1, longitude: -21 });
  });

  it('a device without a position is still created; boundary values stay on the grid', async () => {
    const [, headers] = CALLERS[0];
    const none = await create(headers, {});
    expect(none.status).toBe(201);
    expect(none.body.device).toMatchObject({ latitude: null, longitude: null });
    const edge = await create(headers, { latitude: -90, longitude: 180 });
    expect(edge.body.device).toMatchObject({ latitude: -90, longitude: 180 });
    // (-0 cannot be seen through JSON; toStorageGrid's -0 rule is unit-tested in
    // chain-station-writers-grid-w21.test.ts.)
    const nearZero = await create(headers, { latitude: -0.04, longitude: 0.04 });
    expect(nearZero.body.device).toMatchObject({ latitude: 0, longitude: 0 });
  });
});
