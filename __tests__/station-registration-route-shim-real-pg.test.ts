/**
 * backend#1334 follow-up (H2): POST /api/weather/stations on the REAL weather
 * router, over the app's own database/db.ts pool shim (postgres.js), against a
 * real PostgreSQL. The route checks out `pool.connect()`, runs BEGIN, hands the
 * client to registerStation and COMMITs / ROLLBACKs. The service's
 * pg_advisory_xact_lock calls only serialize anything if they run on that one
 * reserved connection, and its `$8::jsonb` metadata parameter must encode under
 * postgres.js exactly as it does under `pg`. The pre-existing
 * station-registration-mac-real-pg.test.ts proves this on a pg.Pool only.
 *
 * Isolation as in db-pool-shim-real-pg.integration.test.ts: a throwaway database
 * on the server named by MOBILE_STATION_PG_URL, DATABASE_URL pointed at it BEFORE
 * the router (and so database/db) is first required.
 * MOBILE_STATION_REQUIRE_PG=1 (CI) turns a missing URL into a failure.
 */
import crypto from 'node:crypto';
import { Pool } from 'pg';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { dropThrowawayDatabase } from './helpers/throwaway-db';

function fakeAuth(req: any, res: any, next: any) {
  const wallet = req.headers['x-test-wallet'];
  if (!wallet) return res.status(401).json({ error: 'Bearer Token Required' });
  req.user = { address: wallet, walletAddress: wallet, id: 'u' };
  return next();
}
jest.mock('../server/middleware/auth-middleware.js', () => ({ authenticateToken: fakeAuth }));
jest.mock('../server/middleware/authMiddleware', () => ({ requireAuth: fakeAuth }));

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;

if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('MOBILE_STATION_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('real-Postgres station-registration route cases would have been skipped');
  });
}

const RUN = crypto.randomUUID().replace(/-/g, '').slice(0, 8);
const mac = (i: number) => `aa:bb:cc:${RUN.slice(0, 2)}:${RUN.slice(2, 4)}:${i.toString(16).padStart(2, '0')}`;

d('POST /api/weather/stations over the db.ts shim on real Postgres', () => {
  const dbName = `stnreg_${process.pid}_${RUN}`;
  let admin: Pool;
  let raw: Pool;
  let app: express.Express;
  let shimEnd: () => Promise<void>;
  const saved: Record<string, string | undefined> = {};
  const ENV = { DATABASE_URL: '', DB_POOL_SIZE: '4', API_KEY_ENCRYPTION_KEY: 'a'.repeat(64), MAX_STATIONS_PER_OWNER: '3' };
  let fetchSpy: jest.SpiedFunction<typeof fetch>;
  const knownMacs = new Set<string>();

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    const u = new URL(url as string);
    u.pathname = `/${dbName}`;
    ENV.DATABASE_URL = u.toString();
    raw = new Pool({ connectionString: ENV.DATABASE_URL, max: 2 });
    await raw.query(`CREATE TABLE weather_stations (
      id serial PRIMARY KEY, station_id text NOT NULL UNIQUE, owner_address text NOT NULL, location text NOT NULL,
      is_active boolean DEFAULT true NOT NULL, created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL, metadata jsonb, latitude double precision,
      longitude double precision, name text, station_type text)`);
    await raw.query(`CREATE TABLE station_provider_credentials (
      id serial PRIMARY KEY,
      station_id text NOT NULL REFERENCES weather_stations(station_id) ON DELETE CASCADE,
      provider text NOT NULL DEFAULT 'ambient',
      encrypted_api_key text NOT NULL, key_iv text NOT NULL, key_tag text NOT NULL,
      encrypted_app_key text, app_iv text, app_tag text,
      created_at timestamptz NOT NULL DEFAULT now(), rotated_at timestamptz,
      UNIQUE (station_id, provider))`);

    for (const k of Object.keys(ENV)) saved[k] = process.env[k];
    Object.assign(process.env, ENV);

    // The provider key check: every MAC a test registers is "on the account".
    fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementation((async () => ({
      ok: true, status: 200, json: async () => [...knownMacs].map((m) => ({ macAddress: m })),
    })) as any);

    const weatherRoutes = require('../server/routes/weather-routes');
    app = express();
    app.use(express.json());
    app.use('/api/weather', weatherRoutes.default ?? weatherRoutes);
    shimEnd = () => require('../database/db').pool.end();
  });

  afterAll(async () => {
    fetchSpy?.mockRestore();
    try {
      await shimEnd?.();
    } finally {
      for (const k of Object.keys(ENV)) {
        if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
      }
      // Wait for raw's sessions to go away before the FORCE drop (backend#1402).
      try { await dropThrowawayDatabase(admin, dbName, [raw]); } finally { await admin?.end(); }
    }
  });

  beforeEach(async () => {
    await raw.query('TRUNCATE weather_stations CASCADE');
  });

  const post = (owner: string, i: number, extra: Record<string, unknown> = {}) => {
    const m = mac(i);
    knownMacs.add(m);
    return request(app)
      .post('/api/weather/stations')
      .set('x-test-wallet', owner)
      .send({
        name: `Garden ${i}`, latitude: 10, longitude: 20, provider: 'ambient', mac: m, ambientApiKey: 'k', ambientAppKey: 'a',
        elevation_meters: 10, stationId: `stn-${RUN}-${i}`, ...extra,
      });
  };

  it('commits: 201, station row with jsonb metadata intact, encrypted credentials row', async () => {
    const res = await post('0xAbC0000000000000000000000000000000000001', 1);
    expect(res.status).toBe(201);
    const row = (await raw.query('SELECT owner_address, metadata FROM weather_stations WHERE station_id = $1', [`stn-${RUN}-1`])).rows[0];
    expect(row.owner_address).toBe('0xabc0000000000000000000000000000000000001');
    expect(row.metadata).toMatchObject({ mac: mac(1), elevation_m: 10, provider: 'ambient' });
    expect(typeof row.metadata).toBe('object'); // a jsonb object, not a double-encoded string
    const cred = await raw.query('SELECT encrypted_api_key FROM station_provider_credentials WHERE station_id = $1', [`stn-${RUN}-1`]);
    expect(cred.rowCount).toBe(1);
    expect(cred.rows[0].encrypted_api_key).not.toContain('k');
  });

  it('a service refusal (409 MAC_TAKEN) ROLLS BACK and leaves the first station alone', async () => {
    const owner = '0xabc0000000000000000000000000000000000002';
    expect((await post(owner, 2)).status).toBe(201);
    const clash = await request(app).post('/api/weather/stations').set('x-test-wallet', owner)
      .send({ name: 'Other', latitude: 10, longitude: 20, provider: 'ambient', mac: mac(2), ambientApiKey: 'k', elevation_meters: 10, stationId: `stn-${RUN}-2b` });
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe('MAC_TAKEN');
    const ids = (await raw.query('SELECT station_id FROM weather_stations ORDER BY station_id')).rows.map((r) => r.station_id);
    expect(ids).toEqual([`stn-${RUN}-2`]);
  });

  it('a mid-transaction failure ROLLS BACK the station upsert too (no half-registered station)', async () => {
    await raw.query('ALTER TABLE station_provider_credentials ADD CONSTRAINT h2_force_fail CHECK (false) NOT VALID');
    try {
      const res = await post('0xabc0000000000000000000000000000000000003', 3);
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect((await raw.query('SELECT 1 FROM weather_stations')).rowCount).toBe(0);
    } finally {
      await raw.query('ALTER TABLE station_provider_credentials DROP CONSTRAINT h2_force_fail');
    }
    // and the reserved connection went back to the pool: the route works again
    expect((await post('0xabc0000000000000000000000000000000000003', 3)).status).toBe(201);
  });

  it('per-owner advisory lock serializes on the reserved connection: 8 concurrent registrations, cap 3 -> exactly 3 x 201, 5 x 429 (the #1000 25-of-10 bypass)', async () => {
    const owner = '0xabc0000000000000000000000000000000000004';
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => post(owner, 10 + i)));
    const codes = results.map((r) => r.status).sort();
    expect(codes).toEqual([201, 201, 201, 429, 429, 429, 429, 429]);
    expect((await raw.query('SELECT COUNT(*)::int n FROM weather_stations')).rows[0].n).toBe(3);
  });

  it('the MAC advisory lock serializes across owners: one MAC, 6 owners at once -> exactly one 201, five MAC_TAKEN', async () => {
    knownMacs.add(mac(99));
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(app).post('/api/weather/stations').set('x-test-wallet', `0xabc00000000000000000000000000000000001${i}0`)
          .send({ name: `Shared ${i}`, latitude: 10, longitude: 20, provider: 'ambient', mac: mac(99), ambientApiKey: 'k', elevation_meters: 10, stationId: `stn-${RUN}-s${i}` }))
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error === 'MAC_TAKEN')).toHaveLength(5);
    expect((await raw.query('SELECT COUNT(*)::int n FROM weather_stations')).rows[0].n).toBe(1);
  });
});
