/**
 * backend#1288: the Postgres store's SQL, run against a real database.
 * Skipped unless MOBILE_STATION_PG_URL points at a THROWAWAY database (never the
 * live backend DB). The test bootstraps its own per-process schema: a minimal
 * weather_stations plus drizzle/migrations/0025 + 0026 (mobile_station_registrations,
 * collect_pubkey) applied as written, and drops it afterwards, so CI can point it at the job's
 * disposable postgres service. Run locally e.g.:
 *   docker run -d --rm -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=t postgres:15-alpine
 *   MOBILE_STATION_PG_URL=postgres://postgres:t@127.0.0.1:55432/postgres npx jest ...
 * MOBILE_STATION_REQUIRE_PG=1 (set by CI) turns a missing URL into a failure so
 * the real-SQL cases cannot silently skip there.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import {
  buildMobileStationRegistrationMessage,
  buildStationOwnershipMessage,
  deriveMobileStationId,
} from '../shared/mobile-station-messages';
import {
  PgMobileStationStore,
  getMobileStationStatus,
  issueMobileStationChallenge,
  registerMobileStation,
} from '../server/services/mobile-station-registration-service';

import { runStationSyncOnce } from '../server/services/chain-station-sync';
import { buildExportArtifact, markRowsSubmitted, selectDbOnlyRows } from '../server/services/mobile-station-export';

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;

if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('MOBILE_STATION_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('real-Postgres mobile-station cases would have been skipped');
  });
}

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
// Unique per run AND per call: a run id (random) plus a counter, so a persistent
// database that already holds an earlier run's rows can never produce a 409.
const RUN_ID = crypto.randomUUID();
let seedCounter = 0;
const COLLECT_KEY_SEED = 'collect';
const uniqueSeed = () => `${RUN_ID}:${seedCounter++}`;

function wallet(seed: number | string) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, crypto.createHash('sha256').update(`seed:${seed}`).digest()]), format: 'der', type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  const address = `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 40)}`;
  return { publicKey, address, sign: (m: Buffer) => crypto.sign(null, m, key).toString('hex') };
}

const COLLECT_PUBKEY = wallet(COLLECT_KEY_SEED).publicKey;

d('PgMobileStationStore against real Postgres', () => {
  let pool: Pool;
  const NOW = Math.floor(Date.now() / 1000);
  const deps = { chainId: '777', networkId: 'testnet', now: () => NOW };
  const schema = `mobile_station_${process.pid}`;
  let admin: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({ connectionString: url, options: `-c search_path=${schema}` });
    await pool.query(`CREATE TABLE weather_stations (
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
      station_type text)`);
    for (const file of ['0025_mobile_station_registrations.sql', '0026_mobile_station_collect_pubkey.sql']) {
      await pool.query(fs.readFileSync(path.join(__dirname, '../drizzle/migrations', file), 'utf8'));
    }
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  async function bodyFor(w: ReturnType<typeof wallet>, store: PgMobileStationStore, cell = { latE1: 100, lonE1: -200 }, collect = COLLECT_PUBKEY) {
    const ch = (await issueMobileStationChallenge(store, w.address, deps)).body as any;
    const stationId = ch.stationId;
    return {
      ch,
      body: {
        nonce: ch.nonce, expiresAt: ch.expiresAt, publicKey: w.publicKey, collectPubkey: collect, cell, deviceClass: 'phone-barometer',
        registrationSignature: w.sign(buildMobileStationRegistrationMessage({
          chainId: '777', networkId: 'testnet', stationId, ownerAddress: w.address, collectPubkey: collect,
          latE1: cell.latE1, lonE1: cell.lonE1, nonce: ch.nonce, expiresAt: ch.expiresAt,
        })),
        ownershipSignature: w.sign(buildStationOwnershipMessage({
          chainId: '777', networkId: 'testnet', stationId, ownerAddress: w.address,
        })),
      },
    };
  }

  it('registers, writes the owner-guard row with NULL coordinates, and is idempotent', async () => {
    const w = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    const { ch, body } = await bodyFor(w, store);
    const first = await registerMobileStation(store, w.address, body, deps);
    expect(first.status).toBe(201);
    const stationId = deriveMobileStationId(w.address);

    const guard = await pool.query('SELECT owner_address, latitude, longitude, station_type FROM weather_stations WHERE station_id = $1', [stationId]);
    expect(guard.rows[0]).toMatchObject({ owner_address: w.address, latitude: null, longitude: null, station_type: 'mobile' });
    const reg = await pool.query('SELECT * FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
    expect(reg.rows[0]).toMatchObject({ station_id: stationId, cell_lat_e1: 100, cell_lon_e1: -200, status: 'db_only' });
    const nonce = await pool.query('SELECT consumed_at FROM mobile_station_nonces WHERE nonce = $1', [ch.nonce]);
    expect(nonce.rows[0].consumed_at).not.toBeNull();

    expect((await registerMobileStation(store, w.address, body, deps)).status).toBe(200); // retry
    const second = await bodyFor(w, store, { latE1: 5, lonE1: 5 });
    const again = await registerMobileStation(store, w.address, second.body, deps);
    expect(again.status).toBe(200);
    expect((again.body as any).cell).toEqual({ latE1: 100, lonE1: -200 });
    const count = await pool.query('SELECT COUNT(*)::int n FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
    expect(count.rows[0].n).toBe(1);
  });

  it('a consumed nonce cannot be replayed after the row is removed; the UNIQUE owner backstops races', async () => {
    const w = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    const { body } = await bodyFor(w, store);
    expect((await registerMobileStation(store, w.address, body, deps)).status).toBe(201);
    await pool.query('DELETE FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
    const replay = await registerMobileStation(store, w.address, body, deps);
    expect(replay.status).toBe(409);
    expect((replay.body as any).error.code).toBe('NONCE_REPLAYED');
    // direct duplicate insert is refused by the UNIQUE(owner_address) constraint
    const dup = pool.query(
      `INSERT INTO mobile_station_registrations (station_id, owner_address, owner_pubkey, collect_pubkey, cell_lat_e1, cell_lon_e1,
         registration_nonce, registration_expires_at, registration_signature, ownership_signature)
       VALUES ('mob-x1', $1, 'k', '${COLLECT_PUBKEY}', 0, 0, 'n', 1, 's', 's'), ('mob-x2', $1, 'k', '${COLLECT_PUBKEY}', 0, 0, 'n', 1, 's', 's')`,
      [w.address]
    );
    await expect(dup).rejects.toThrow(/unique|duplicate/i);
  });

  it('concurrent registrations for one wallet yield exactly one row', async () => {
    const w = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    const a = await bodyFor(w, store);
    const b = await bodyFor(w, store, { latE1: 7, lonE1: 7 });
    const results = await Promise.all([
      registerMobileStation(store, w.address, a.body, deps),
      registerMobileStation(store, w.address, b.body, deps),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    const count = await pool.query('SELECT COUNT(*)::int n FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
    expect(count.rows[0].n).toBe(1);
  });

  it('B6: stores collect_pubkey; rotation replaces it in SQL, keeps the row/cell/status, and a retry is idempotent', async () => {
    const w = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    const phone2 = wallet(uniqueSeed()).publicKey;
    expect((await registerMobileStation(store, w.address, (await bodyFor(w, store)).body, deps)).status).toBe(201);
    const stored = await pool.query('SELECT collect_pubkey FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
    expect(stored.rows[0].collect_pubkey).toBe(COLLECT_PUBKEY);

    const rotate = await bodyFor(w, store, { latE1: 100, lonE1: -200 }, phone2);
    const res = await registerMobileStation(store, w.address, rotate.body, deps);
    expect(res.status).toBe(200);
    expect((res.body as any).rotated).toBe(true);
    const after = await pool.query('SELECT * FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
    expect(after.rows).toHaveLength(1);
    expect(after.rows[0]).toMatchObject({
      collect_pubkey: phone2, registration_nonce: rotate.ch.nonce, cell_lat_e1: 100, cell_lon_e1: -200, status: 'db_only',
    });
    const nonce = await pool.query('SELECT consumed_at FROM mobile_station_nonces WHERE nonce = $1', [rotate.ch.nonce]);
    expect(nonce.rows[0].consumed_at).not.toBeNull();
    expect((await registerMobileStation(store, w.address, rotate.body, deps)).status).toBe(200); // retry
    expect((await pool.query('SELECT collect_pubkey FROM mobile_station_registrations WHERE owner_address = $1', [w.address])).rows[0].collect_pubkey).toBe(phone2);
  });

  it('B6: concurrent rotations to different keys serialize on the wallet lock: one row, ends on one of the two keys', async () => {
    const w = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    await registerMobileStation(store, w.address, (await bodyFor(w, store)).body, deps);
    const k2 = wallet(uniqueSeed()).publicKey;
    const k3 = wallet(uniqueSeed()).publicKey;
    const a = await bodyFor(w, store, { latE1: 100, lonE1: -200 }, k2);
    const b = await bodyFor(w, store, { latE1: 100, lonE1: -200 }, k3);
    const results = await Promise.all([
      registerMobileStation(store, w.address, a.body, deps),
      registerMobileStation(store, w.address, b.body, deps),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const rows = await pool.query('SELECT collect_pubkey FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
    expect(rows.rows).toHaveLength(1);
    expect([k2, k3]).toContain(rows.rows[0].collect_pubkey);
  });

  it('B6: the table itself refuses a NULL, malformed, upper-case or wallet-equal collect key', async () => {
    const cols = `(station_id, owner_address, owner_pubkey, collect_pubkey, cell_lat_e1, cell_lon_e1,
         registration_nonce, registration_expires_at, registration_signature, ownership_signature)`;
    const attempt = (id: string, ownerPubkey: string, collect: string | null) =>
      pool.query(`INSERT INTO mobile_station_registrations ${cols} VALUES ($1, $2, $3, $4, 0, 0, 'n', 1, 's', 's')`,
        [id, `0x${crypto.randomBytes(20).toString('hex')}`, ownerPubkey, collect]);
    const owner = 'ab'.repeat(32);
    await expect(attempt('mob-c1', owner, null)).rejects.toThrow(/null value|not-null/i);
    await expect(attempt('mob-c2', owner, 'ab'.repeat(31))).rejects.toThrow(/collect_pubkey_shape/);
    await expect(attempt('mob-c3', owner, 'AB'.repeat(32).replace(/AB/g, 'Cd'))).rejects.toThrow(/collect_pubkey_shape/);
    await expect(attempt('mob-c4', owner, owner)).rejects.toThrow(/collect_not_owner/);
    await expect(attempt('mob-c5', owner, 'cd'.repeat(32))).resolves.toBeDefined();
  });

  it('refuses a derived id already held by another owner in weather_stations', async () => {
    const w = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    await pool.query(
      `INSERT INTO weather_stations (station_id, owner_address, location) VALUES ($1, '0x000000000000000000000000000000000000dead', 'x')`,
      [deriveMobileStationId(w.address)]
    );
    const { body } = await bodyFor(w, store);
    const res = await registerMobileStation(store, w.address, body, deps);
    expect(res.status).toBe(409);
    expect((res.body as any).error.code).toBe('STATION_ID_TAKEN');
    const reg = await pool.query('SELECT 1 FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
    expect(reg.rowCount).toBe(0); // rolled back
  });

  it('two concurrent registrations with different nonces for one wallet: 201 + idempotent 200, never a 500 (per-wallet advisory lock)', async () => {
    const w = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    const a = await bodyFor(w, store);
    const b = await bodyFor(w, store, { latE1: 9, lonE1: 9 });
    const settled = await Promise.allSettled([
      registerMobileStation(store, w.address, a.body, deps),
      registerMobileStation(store, w.address, b.body, deps),
    ]);
    expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
    const statuses = settled.map((s) => (s as PromiseFulfilledResult<any>).value.status).sort();
    expect(statuses).toEqual([200, 201]);
  });

  it('issuing a challenge deletes only this wallet\'s expired nonce rows', async () => {
    const w = wallet(uniqueSeed());
    const other = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    await issueMobileStationChallenge(store, w.address, deps);
    await issueMobileStationChallenge(store, other.address, deps);
    const later = { ...deps, now: () => NOW + 10_000 };
    await issueMobileStationChallenge(store, w.address, later);
    const mine = await pool.query('SELECT expires_at FROM mobile_station_nonces WHERE owner_address = $1', [w.address]);
    expect(mine.rowCount).toBe(1);
    expect(Number(mine.rows[0].expires_at)).toBeGreaterThan(NOW + 10_000);
    const theirs = await pool.query('SELECT 1 FROM mobile_station_nonces WHERE owner_address = $1', [other.address]);
    expect(theirs.rowCount).toBe(1);
  });
  it('B4 status read: own row with timestamps; another wallet gets 404', async () => {
    const w = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    const { body } = await bodyFor(w, store);
    expect((await registerMobileStation(store, w.address, body, deps)).status).toBe(201);
    const mine = await getMobileStationStatus(store, w.address);
    expect(mine.status).toBe(200);
    expect(mine.body).toMatchObject({
      stationId: deriveMobileStationId(w.address), status: 'db_only', cell: { latE1: 100, lonE1: -200 },
    });
    expect(Date.parse(String(mine.body.createdAt))).not.toBeNaN();
    expect(Date.parse(String(mine.body.updatedAt))).not.toBeNaN();
    const stranger = wallet(uniqueSeed());
    expect((await getMobileStationStatus(store, stranger.address)).status).toBe(404);
  });

  it('#1310 sync SQL: owner match fills coordinates and sets on_chain; owner mismatch changes nothing', async () => {
    const good = wallet(uniqueSeed());
    const bad = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    for (const w of [good, bad]) {
      const { body } = await bodyFor(w, store);
      expect((await registerMobileStation(store, w.address, body, deps)).status).toBe(201);
    }
    const entry = (w: ReturnType<typeof wallet>, owner: string) => ({
      station_id: deriveMobileStationId(w.address), owner_address: owner.toUpperCase().replace('0X', '0x'),
      provenance_class: 'real', is_active: true, latitude: 10, longitude: -20,
    });
    const out = await runStationSyncOnce({
      listStations: async () => [entry(good, good.address), entry(bad, good.address)],
      labels: {},
      pool: pool as any,
    });
    expect(out.mobileOnChain).toBe(1);
    expect(out.mobileRefused).toBe(1);
    const rows = await pool.query(
      `SELECT r.owner_address, r.status, s.latitude, s.longitude
         FROM mobile_station_registrations r JOIN weather_stations s ON s.station_id = r.station_id
        WHERE r.owner_address = ANY($1)`, [[good.address, bad.address]]);
    const byOwner = Object.fromEntries(rows.rows.map((r: any) => [r.owner_address, r]));
    expect(byOwner[good.address]).toMatchObject({ status: 'on_chain', latitude: 10, longitude: -20 });
    expect(byOwner[bad.address]).toMatchObject({ status: 'db_only', latitude: null, longitude: null });
    // a second pass is a no-op that keeps it on_chain
    const again = await runStationSyncOnce({ listStations: async () => [entry(good, good.address)], labels: {}, pool: pool as any });
    expect(again.mobileOnChain).toBe(1);
  });

  it('B5 export SQL: selects db_only, marks exactly the exported ids submitted once', async () => {
    const w = wallet(uniqueSeed());
    const store = new PgMobileStationStore(pool as any);
    const { body } = await bodyFor(w, store);
    expect((await registerMobileStation(store, w.address, body, deps)).status).toBe(201);
    const rows = (await selectDbOnlyRows(pool as any, 1000)).filter((r) => r.ownerAddress === w.address);
    expect(rows).toHaveLength(1);
    const { artifact, skipped } = buildExportArtifact(rows, { chainId: '777', networkId: 'testnet', batchId: 'b-pg' });
    expect(skipped).toEqual([]);
    expect(artifact.stations).toHaveLength(1);
    expect(await markRowsSubmitted(pool as any, [rows[0].stationId], 'b-pg')).toBe(1);
    expect(await markRowsSubmitted(pool as any, [rows[0].stationId], 'b-other')).toBe(0);
    const row = await pool.query('SELECT status, governance_batch_id FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
    expect(row.rows[0]).toEqual({ status: 'submitted', governance_batch_id: 'b-pg' });
    expect((await selectDbOnlyRows(pool as any, 1000)).some((r) => r.ownerAddress === w.address)).toBe(false);
  });
});
