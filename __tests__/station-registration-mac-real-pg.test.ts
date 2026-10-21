/**
 * One MAC = one active station (owner ruling 2026-09-27, backend#1261 / #1267
 * review P2-1) against a REAL PostgreSQL. Runs when BACKFILL_TEST_PG_URL points
 * at a disposable database (CI sets it for `npm test`); creates and drops its
 * own schema. Every registration runs on its own reserved connection inside
 * BEGIN/COMMIT, exactly as the route does, so the advisory locks are real.
 * Uses `pg` (the production driver) so jsonb parameters encode as they do live.
 */
import pg from 'pg';
import { registerStation, type FetchLike, type QueryablePool } from '../server/services/station-registration-service.js';

const PG_URL = process.env.BACKFILL_TEST_PG_URL;
if (process.env.BACKFILL_REQUIRE_PG === '1' && !PG_URL) {
  throw new Error('BACKFILL_REQUIRE_PG=1 but BACKFILL_TEST_PG_URL is not set');
}
const describePg = PG_URL ? describe : describe.skip;

const MAC = 'AA:BB:CC:DD:EE:FF';
const input = { name: 'Garden', latitude: 1, longitude: 2, provider: 'ambient', mac: MAC, ambientApiKey: 'k', ambientAppKey: 'a', elevation_meters: 10 };
const fetchFn: FetchLike = async () => ({ ok: true, status: 200, json: async () => [{ macAddress: MAC }] }) as any;

describePg('one MAC = one active station on real PostgreSQL (#1261 P2-1)', () => {
  const schema = `mac_unique_1261_${process.pid}`;
  let admin: pg.Client;
  let sql: pg.Pool;

  /** One route-shaped transaction; holdMs keeps it open after the service returns. */
  async function register(stationId: string, owner: string, overrides: Record<string, unknown> = {}, holdMs = 0) {
    const conn = await sql.connect();
    const pool: QueryablePool = {
      query: async (text: string, params: unknown[] = []) => ({ rows: (await conn.query(text, params as any[])).rows }),
    } as QueryablePool;
    try {
      await conn.query('BEGIN');
      const result = await registerStation({ ...input, stationId, ...overrides }, owner, { pool, fetchFn, encryptionKey: 'a'.repeat(64) }, () => stationId);
      if (holdMs) await new Promise(resolve => setTimeout(resolve, holdMs));
      await conn.query(result.status < 400 ? 'COMMIT' : 'ROLLBACK');
      return result;
    } catch (error) {
      await conn.query('ROLLBACK');
      throw error;
    } finally {
      conn.release();
    }
  }
  const activeWithMac = async () =>
    (await sql.query(`SELECT station_id FROM weather_stations WHERE is_active AND lower(btrim(metadata->>'mac')) = $1 ORDER BY station_id`, [MAC.toLowerCase()])).rows.map(r => r.station_id);

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    sql = new pg.Pool({ connectionString: PG_URL, max: 6, options: `-c search_path=${schema}` });
    await sql.query(`CREATE TABLE weather_stations (
      id serial PRIMARY KEY,
      station_id text NOT NULL UNIQUE,
      owner_address text NOT NULL,
      location text NOT NULL,
      is_active boolean DEFAULT true NOT NULL,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL,
      metadata jsonb,
      latitude double precision,
      longitude double precision,
      name text,
      station_type text)`);
    await sql.query(`CREATE TABLE station_provider_credentials (
      id serial PRIMARY KEY,
      station_id text NOT NULL REFERENCES weather_stations(station_id) ON DELETE CASCADE,
      provider text NOT NULL DEFAULT 'ambient',
      encrypted_api_key text NOT NULL, key_iv text NOT NULL, key_tag text NOT NULL,
      encrypted_app_key text, app_iv text, app_tag text,
      created_at timestamptz NOT NULL DEFAULT now(), rotated_at timestamptz,
      UNIQUE (station_id, provider))`);
  });

  afterAll(async () => {
    await sql?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  beforeEach(async () => {
    await sql.query('TRUNCATE weather_stations CASCADE');
  });

  it('same owner: s1 then s2 with one MAC -> 409 MAC_TAKEN; re-binding s1 stays 201', async () => {
    expect((await register('s1', 'owner-a')).status).toBe(201);
    const second = await register('s2', 'OWNER-A', { mac: ' aa:bb:cc:dd:ee:ff ' });
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('MAC_TAKEN');
    expect((await register('s1', 'owner-a')).status).toBe(201);
    expect((await register('s1', 'owner-a', { mac: undefined })).status).toBe(201);
    expect(await activeWithMac()).toEqual(['s1']);
  });

  it('an inactive station does not hold its MAC', async () => {
    expect((await register('s1', 'owner-a')).status).toBe(201);
    await sql.query(`UPDATE weather_stations SET is_active = false WHERE station_id = 's1'`);
    expect((await register('s2', 'owner-a')).status).toBe(201);
    expect(await activeWithMac()).toEqual(['s2']);
  });

  it('race: one owner binding one MAC to two stations concurrently -> exactly one wins', async () => {
    const results = await Promise.all([
      register('race-1', 'owner-a', {}, 150),
      register('race-2', 'owner-a', { mac: 'aa:bb:cc:dd:ee:ff' }, 150),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    expect(results.find(r => r.status === 409)?.body.error).toBe('MAC_TAKEN');
    expect(await activeWithMac()).toHaveLength(1);
  });

  it('race: mixed owners and stations on one MAC -> exactly one active holder', async () => {
    const results = await Promise.all(
      ['owner-a', 'owner-a', 'owner-b', 'owner-b', 'owner-c'].map((owner, i) => register(`mix-${i}`, owner, {}, 100)),
    );
    expect(results.filter(r => r.status === 201)).toHaveLength(1);
    expect(results.filter(r => r.status === 409)).toHaveLength(4);
    expect(await activeWithMac()).toHaveLength(1);
  });

  // #1272 on real PostgreSQL: the query's regexp_replace/lower/btrim must agree with canonicalMac.
  it.each(['AA-BB-CC-DD-EE-FF', 'aabbccddeeff', ' Aa:bB:cC:dD:eE:fF '])('a legacy row stored as %j blocks another owner (409)', async legacy => {
    await sql.query(
      `INSERT INTO weather_stations (station_id, owner_address, location, is_active, metadata, latitude, longitude, name)
       VALUES ('legacy', 'owner-b', 'x', true, $1::jsonb, 1, 2, 'legacy')`,
      [JSON.stringify({ mac: legacy })],
    );
    const result = await register('s-new', 'owner-a');
    expect(result.status).toBe(409);
    expect(result.body.error).toBe('MAC_TAKEN');
  });

  it.each(['Ambient', 'AMBIENT', ' ambient '])('a legacy row tagged %j still reserves its MAC (409)', async provider => {
    await sql.query(
      `INSERT INTO weather_stations (station_id, owner_address, location, is_active, metadata, latitude, longitude, name)
       VALUES ('legacy', 'owner-b', 'x', true, $1::jsonb, 1, 2, 'legacy')`,
      [JSON.stringify({ mac: MAC.toLowerCase(), provider })],
    );
    expect((await register('s-new', 'owner-a')).status).toBe(409);
  });

  it('a pending-provider row (ecowitt) still does not reserve the MAC', async () => {
    await sql.query(
      `INSERT INTO weather_stations (station_id, owner_address, location, is_active, metadata, latitude, longitude, name)
       VALUES ('legacy', 'owner-b', 'x', true, $1::jsonb, 1, 2, 'legacy')`,
      [JSON.stringify({ mac: MAC.toLowerCase(), provider: 'ecowitt' })],
    );
    expect((await register('s-new', 'owner-a')).status).toBe(201);
  });

  it('race: two spellings of one MAC from different owners serialize on one lock -> exactly one wins', async () => {
    const results = await Promise.all([
      register('sp-1', 'owner-a', { mac: 'AA:BB:CC:DD:EE:FF' }, 150),
      register('sp-2', 'owner-b', { mac: 'aa-bb-cc-dd-ee-ff' }, 150),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
  });
});
