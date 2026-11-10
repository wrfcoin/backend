/**
 * The collector roster's query against a real database. Skipped unless
 * MOBILE_STATION_PG_URL points at a THROWAWAY database (never the live backend
 * DB); MOBILE_STATION_REQUIRE_PG=1 (set by CI) turns a missing URL into a
 * failure. The tables this feature only reads (weather_stations,
 * station_provider_credentials) are STUB tables created here with the columns
 * the query uses; migration 0045 is the real file. Made-up stations only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { encryptData } from '../server/utils/crypto';
import { listCollectorRoster } from '../server/services/collector-roster';
import { reconcileWebsiteStations } from '../server/services/website-station-chain-registration';

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;
if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('MOBILE_STATION_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('real-Postgres collector-roster cases would have been skipped');
  });
}

const ENC_KEY = 'ab'.repeat(32);
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../drizzle/migrations/0045_website_station_chain_registrations.sql'), 'utf8');

d('collector roster against real Postgres', () => {
  const schema = `collector_roster_${process.pid}`;
  let admin: Pool;
  let pool: Pool;
  let n = 0;

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE weather_stations (
      id serial PRIMARY KEY, station_id text NOT NULL UNIQUE, owner_address text NOT NULL, location text NOT NULL,
      is_active boolean DEFAULT true NOT NULL, created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL, metadata jsonb, latitude double precision,
      longitude double precision, name text, station_type text)`);
    await pool.query(`CREATE TABLE station_provider_credentials (
      id serial PRIMARY KEY,
      station_id text NOT NULL REFERENCES weather_stations(station_id) ON DELETE CASCADE,
      provider text NOT NULL DEFAULT 'ambient',
      encrypted_api_key text NOT NULL, key_iv text NOT NULL, key_tag text NOT NULL,
      encrypted_app_key text, app_iv text, app_tag text, UNIQUE (station_id, provider))`);
    await pool.query(MIGRATION);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  interface Opts { status?: string; blockedReason?: string; active?: boolean; stationOwner?: string; credentials?: boolean; provider?: string; ingestion?: string }
  async function station(o: Opts = {}) {
    n += 1;
    const id = `pws-${crypto.randomBytes(8).toString('hex')}`;
    const owner = `0x${crypto.createHash('sha256').update(`${process.pid}:${n}`).digest('hex').slice(0, 40)}`;
    const mac = `aa:bb:cc:${crypto.randomBytes(3).toString('hex').match(/.{2}/g)!.join(':')}`;
    await pool.query(
      `INSERT INTO weather_stations (station_id, owner_address, location, is_active, metadata, latitude, longitude, name)
       VALUES ($1, $2, 'fixture', $3, $4::jsonb, $5, $6, 'A name that must never be sent')`,
      [id, o.stationOwner ?? owner, o.active ?? true, JSON.stringify({ mac, ingestionStatus: o.ingestion ?? 'active' }), 10 + 1 / 3, -(20 + 2 / 3)]);
    if (o.credentials ?? true) {
      const api = encryptData(`api-${id}`, ENC_KEY);
      const app = encryptData(`app-${id}`, ENC_KEY);
      await pool.query(
        `INSERT INTO station_provider_credentials
           (station_id, provider, encrypted_api_key, key_iv, key_tag, encrypted_app_key, app_iv, app_tag)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, o.provider ?? 'ambient', api.encrypted, api.iv, api.tag, app.encrypted, app.iv, app.tag]);
    }
    await pool.query(
      `INSERT INTO website_station_chain_registrations
         (station_id, owner_address, owner_pubkey, ownership_signature, status, blocked_reason)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, owner, 'c'.repeat(64), 'd'.repeat(128), o.status ?? 'on_chain', o.blockedReason ?? null]);
    return { id, owner, mac: mac.toUpperCase() };
  }
  const ids = async () => (await listCollectorRoster(pool as any, ENC_KEY)).stations.map((s) => s.stationId);

  it('serves a station registered on chain, with its own keys, its device and the grid position; no name', async () => {
    const a = await station();
    const roster = await listCollectorRoster(pool as any, ENC_KEY);
    const entry = roster.stations.find((s) => s.stationId === a.id)!;
    expect(entry).toMatchObject({
      ownerAddress: a.owner, mac: a.mac, apiKey: `api-${a.id}`, appKey: `app-${a.id}`, latitude: 10.3, longitude: -20.7,
    });
    expect(JSON.stringify(roster)).not.toContain('A name that must never be sent');
  });

  it('leaves out a station that is waiting, blocked, deactivated, moved to another owner, without credentials, or on another provider', async () => {
    const waiting = await station({ status: 'db_only' });
    const blocked = await station({ status: 'blocked', blockedReason: 'station_id_taken_on_chain' });
    const inactive = await station({ active: false });
    const moved = await station({ stationOwner: `0x${'9'.repeat(40)}` });
    const noKeys = await station({ credentials: false });
    const otherProvider = await station({ provider: 'other' });
    const pending = await station({ ingestion: 'pending' });
    const good = await station();
    const served = await ids();
    expect(served).toContain(good.id);
    for (const out of [waiting, blocked, inactive, moved, noKeys, otherProvider, pending]) expect(served).not.toContain(out.id);
  });

  it('a station drops off the next read when it is deactivated, blocked or changes owner; the owner match ignores case', async () => {
    const a = await station();
    const b = await station();
    const c = await station();
    const upper = await station();
    await pool.query('UPDATE weather_stations SET owner_address = $2 WHERE station_id = $1', [upper.id, `0x${upper.owner.slice(2).toUpperCase()}`]);
    expect(await ids()).toEqual(expect.arrayContaining([a.id, b.id, c.id, upper.id]));
    await pool.query('UPDATE weather_stations SET is_active = false WHERE station_id = $1', [a.id]);
    await pool.query(`UPDATE website_station_chain_registrations SET status = 'blocked', blocked_reason = 'chain_record_not_active' WHERE station_id = $1`, [b.id]);
    await pool.query('UPDATE weather_stations SET owner_address = $2 WHERE station_id = $1', [c.id, `0x${'8'.repeat(40)}`]);
    const after = await ids();
    for (const gone of [a, b, c]) expect(after).not.toContain(gone.id);
    expect(after).toContain(upper.id);
  });

  it('a station transferred or deactivated ON CHAIN leaves the roster on the next read (the reconcile blocks its row)', async () => {
    const moved = await station();
    const stopped = await station();
    expect(await ids()).toEqual(expect.arrayContaining([moved.id, stopped.id]));
    const entry = (id: string, owner: string, over: Record<string, unknown> = {}) =>
      ({ station_id: id, owner_address: owner, provenance_class: 'real', is_active: true, ...over });
    const result = await reconcileWebsiteStations(
      [entry(moved.id, `0x${'7'.repeat(40)}`), entry(stopped.id, stopped.owner, { is_active: false })], pool as any);
    expect(result).toEqual({ onChain: 0, blocked: 2, failed: 0 });
    const after = await ids();
    expect(after).not.toContain(moved.id);
    expect(after).not.toContain(stopped.id);
    // Live again under the same owner: back on the roster.
    await reconcileWebsiteStations([entry(stopped.id, stopped.owner)], pool as any);
    expect(await ids()).toContain(stopped.id);
  });

  it('reading the roster changes no row', async () => {
    const before = (await pool.query('SELECT station_id, status, updated_at FROM website_station_chain_registrations ORDER BY station_id')).rows;
    await listCollectorRoster(pool as any, ENC_KEY);
    const after = (await pool.query('SELECT station_id, status, updated_at FROM website_station_chain_registrations ORDER BY station_id')).rows;
    expect(after).toEqual(before);
  });
});
