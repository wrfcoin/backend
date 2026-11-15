/**
 * Website station on-chain registration: the migration and every SQL statement,
 * run against a real database. Skipped unless MOBILE_STATION_PG_URL points at a
 * THROWAWAY database (never the live backend DB); the test builds its own
 * per-process schema and drops it. The tables this feature only reads
 * (weather_stations, station_provider_credentials) are STUB tables created here
 * with the columns the statements use; only migration 0045 is the real file. The
 * full migration chain is not applied. MOBILE_STATION_REQUIRE_PG=1 (set by CI) turns
 * a missing URL into a failure so these cases cannot silently skip there.
 * Made-up wallets, stations and positions only.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { buildStationOwnershipMessage } from '../shared/mobile-station-messages';
import {
  getChainRegistrationStatus,
  reconcileWebsiteStations,
  submitOwnershipProof,
} from '../server/services/website-station-chain-registration';
import {
  REASON_PROVIDER_UNREACHABLE,
  REASON_STATION_REPORT,
  buildWebsiteExportArtifact,
  resolveReporting,
  selectNotReadyWebsiteRows,
  selectReadyWebsiteRows,
} from '../server/services/website-station-export';

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;

if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('MOBILE_STATION_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('real-Postgres website-station cases would have been skipped');
  });
}

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const RUN_ID = crypto.randomUUID();
let counter = 0;
function wallet() {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, crypto.createHash('sha256').update(`${RUN_ID}:${counter++}`).digest()]),
    format: 'der', type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  const address = `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 40)}`;
  return { publicKey, address, sign: (m: Buffer) => crypto.sign(null, m, key).toString('hex') };
}
const neutralId = () => `pws-${crypto.randomBytes(8).toString('hex')}`;
const CHAIN = { chainId: '888', networkId: 'testnet' };
const MIGRATION = fs.readFileSync(
  path.join(__dirname, '../drizzle/migrations/0045_website_station_chain_registrations.sql'), 'utf8');

d('website station chain registration against real Postgres', () => {
  const schema = `website_station_${process.pid}`;
  let admin: Pool;
  let pool: Pool;

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
      name text,
      station_type text)`);
    await pool.query(`CREATE TABLE station_provider_credentials (
      id serial PRIMARY KEY,
      station_id text NOT NULL REFERENCES weather_stations(station_id) ON DELETE CASCADE,
      provider text NOT NULL DEFAULT 'ambient',
      encrypted_api_key text NOT NULL, key_iv text NOT NULL, key_tag text NOT NULL,
      encrypted_app_key text, app_iv text, app_tag text,
      UNIQUE (station_id, provider))`);
    await pool.query(MIGRATION);
  });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin?.end();
  });

  interface Opts {
    id?: string; active?: boolean; ingestion?: string; credentials?: boolean; mac?: string;
    lat?: number | null; lon?: number | null; owner?: string;
  }
  /** A website station row, by default one that is ready: credentials, active ingestion, a bound device. */
  async function station(w: ReturnType<typeof wallet>, o: Opts = {}) {
    const id = o.id ?? neutralId();
    await pool.query(
      `INSERT INTO weather_stations (station_id, owner_address, location, is_active, metadata, latitude, longitude)
       VALUES ($1, $2, 'fixture', $3, $4::jsonb, $5, $6)`,
      [id, o.owner ?? w.address, o.active ?? true, JSON.stringify({ ingestionStatus: o.ingestion ?? 'active', mac: o.mac ?? 'aa:bb:cc:dd:ee:01' }),
        o.lat === undefined ? 10 + 1 / 3 : o.lat, o.lon === undefined ? -(20 + 2 / 3) : o.lon],
    );
    if (o.credentials ?? true) {
      await pool.query(
        `INSERT INTO station_provider_credentials (station_id, encrypted_api_key, key_iv, key_tag, encrypted_app_key, app_iv, app_tag)
         VALUES ($1, 'enc-api', 'iv1', 'tag1', 'enc-app', 'iv2', 'tag2')`, [id]);
    }
    return id;
  }
  const proof = (w: ReturnType<typeof wallet>, id: string) => ({
    owner_pubkey: w.publicKey,
    owner_signature: w.sign(buildStationOwnershipMessage({ ...CHAIN, stationId: id, ownerAddress: w.address })),
  });
  const submit = (w: ReturnType<typeof wallet>, id: string) => submitOwnershipProof(pool as any, w.address, id, proof(w, id), CHAIN);
  const status = (w: ReturnType<typeof wallet>, id: string) => getChainRegistrationStatus(pool as any, id, w.address, CHAIN);
  const row = async (id: string) =>
    (await pool.query('SELECT * FROM website_station_chain_registrations WHERE station_id = $1', [id])).rows[0];
  const chain = (id: string, owner: string, over: Record<string, unknown> = {}) =>
    ({ station_id: id, owner_address: owner, provenance_class: 'real', is_active: true, ...over });

  it('the migration is rerunnable and its constraints hold', async () => {
    await pool.query(MIGRATION);
    const w = wallet();
    const id = await station(w);
    const insert = (cols: string, vals: string) =>
      pool.query(`INSERT INTO website_station_chain_registrations (station_id, owner_address, ${cols}) VALUES ($1, $2, ${vals})`, [id, w.address]);
    // A waiting row needs its proof; blocked needs a known reason; unknown statuses are refused.
    await expect(insert('status', "'db_only'")).rejects.toThrow(/proof_check/);
    await expect(insert('status', "'blocked'")).rejects.toThrow(/blocked_check/);
    await expect(insert('status, blocked_reason', "'blocked', 'because'")).rejects.toThrow(/blocked_reason_check/);
    await expect(insert('status, blocked_reason', "'on_chain', 'station_id_taken_on_chain'")).rejects.toThrow(/blocked_check/);
    await expect(insert('status', "'submitted'")).rejects.toThrow(/status_check/);
    await expect(pool.query(
      `INSERT INTO website_station_chain_registrations (station_id, owner_address, status) VALUES ($1, $2, 'on_chain')`,
      [id, w.address.toUpperCase()])).rejects.toThrow();
    await expect(pool.query(
      `INSERT INTO website_station_chain_registrations (station_id, owner_address, status) VALUES ('pws-no-such-station', $1, 'on_chain')`,
      [w.address])).rejects.toThrow(/station_fk/);
    await insert('status', "'on_chain'");
    // Removing the station removes its registration.
    await pool.query('DELETE FROM weather_stations WHERE station_id = $1', [id]);
    expect(await row(id)).toBeUndefined();
  });

  it('stores a proof, is idempotent, and reports waiting for the batch', async () => {
    const w = wallet();
    const id = await station(w);
    expect(await status(w, id)).toEqual({ state: 'needs_owner_signature', stationId: id, ...CHAIN });
    const first = await submit(w, id);
    expect(first.body).toEqual({ chainRegistration: { state: 'waiting', stationId: id, ...CHAIN, waitingFor: 'batch' } });
    expect(await submit(w, id)).toEqual(first);
    expect(await row(id)).toMatchObject({ owner_address: w.address, owner_pubkey: w.publicKey, status: 'db_only', blocked_reason: null });
    expect((await pool.query('SELECT count(*)::int AS n FROM website_station_chain_registrations WHERE station_id = $1', [id])).rows[0].n).toBe(1);
  });

  it('matches the owner whatever case the station row holds, and hides another wallet\'s station', async () => {
    const w = wallet();
    const id = await station(w, { owner: '0x' + w.address.slice(2).toUpperCase() });
    expect((await submit(w, id)).status).toBe(200);
    const stranger = wallet();
    expect(await status(stranger, id)).toBeNull();
    expect((await submit(stranger, id)).status).toBe(404);
  });

  it('says what a waiting station is waiting for', async () => {
    const w = wallet();
    const cases: Array<[Opts, string]> = [
      [{ ingestion: 'pending' }, 'station_report'],
      [{ credentials: false }, 'station_report'],
      [{ id: `pws-fixture-named-${crypto.randomBytes(3).toString('hex')}` }, 'operator_review'],
      [{}, 'batch'],
    ];
    for (const [opts, waitingFor] of cases) {
      const id = await station(w, opts);
      await submit(w, id);
      expect((await status(w, id))!.waitingFor).toBe(waitingFor);
    }
  });

  it('the export reads only ready stations, oldest first, and a station that is not ready takes no place in the window', async () => {
    const w = wallet();
    const named = `pws-fixture-named-${crypto.randomBytes(3).toString('hex')}`;
    const notReady: Array<[Opts, string]> = [
      [{ ingestion: 'pending' }, 'provider credentials are not verified or ingestion is not active'],
      [{ credentials: false }, 'provider credentials are not verified or ingestion is not active'],
      [{ lat: null }, 'station has no usable position'],
      [{ id: named }, 'station id is not a neutral id (it may hold a name); pass --allow-id to include it'],
    ];
    const expected = new Map<string, string>();
    for (const [opts, reason] of notReady) {
      const id = await station(w, opts);
      await submit(w, id);
      expected.set(id, reason);
    }
    // Two more that become not-ready AFTER signing.
    const inactive = await station(w);
    await submit(w, inactive);
    await pool.query('UPDATE weather_stations SET is_active = false WHERE station_id = $1', [inactive]);
    expected.set(inactive, 'station is not active');
    const moved = await station(w);
    await submit(w, moved);
    await pool.query('UPDATE weather_stations SET owner_address = $2 WHERE station_id = $1', [moved, wallet().address]);
    expected.set(moved, 'the station now belongs to a different owner');
    // Stations that pass the database rules; whether each is reporting is settled afterwards
    // by the provider read (a fake one here).
    const silent = await station(w, { mac: 'aa:bb:cc:dd:ee:02' });
    await submit(w, silent);
    const down = await station(w, { mac: 'aa:bb:cc:dd:ee:03' });
    await submit(w, down);
    // The ready station is the NEWEST waiting row, behind all of the above.
    const ready = await station(w, { mac: 'aa:bb:cc:dd:ee:04' });
    await submit(w, ready);

    const ours = new Set([ready, silent, down, ...expected.keys()]);
    const mine = <T extends { stationId: string }>(rows: T[]) => rows.filter((r) => ours.has(r.stationId));
    const all = mine(await selectReadyWebsiteRows(pool as any, 200));
    // Only the rows that pass the database rules come back, oldest first, each with its device
    // and its stored (still encrypted) keys for the provider read.
    expect(all.map((r) => r.stationId)).toEqual([silent, down, ready]);
    expect(all.map((r) => r.mac)).toEqual(['aa:bb:cc:dd:ee:02', 'aa:bb:cc:dd:ee:03', 'aa:bb:cc:dd:ee:04']);
    expect(all[2].credentials).toEqual({
      encryptedApiKey: 'enc-api', keyIv: 'iv1', keyTag: 'tag1', encryptedAppKey: 'enc-app', appIv: 'iv2', appTag: 'tag2',
    });
    // No provider read available: nothing is exported.
    const none = await resolveReporting(all, 21);
    expect(none.ready).toEqual([]);
    expect(none.notReady.map((r) => r.reason)).toEqual(Array(3).fill(REASON_PROVIDER_UNREACHABLE));
    // With a provider read: the reporting one is ready even behind the others; they keep their reasons.
    const asked: string[] = [];
    const resolved = await resolveReporting(all, 1, {
      providerCheck: async (r) => {
        asked.push(r.stationId);
        if (r.stationId === silent) return { kind: 'stale' };
        if (r.stationId === down) return { kind: 'unreachable' };
        return { kind: 'fresh', ageMinutes: 7 };
      },
    });
    expect(asked).toEqual([silent, down, ready]);
    expect(resolved.ready.map((r) => [r.stationId, r.reportingSource, r.lastObservationAgeMinutes])).toEqual([[ready, 'provider', 7]]);
    expect(resolved.notReady).toEqual([
      { stationId: silent, reason: REASON_STATION_REPORT }, { stationId: down, reason: REASON_PROVIDER_UNREACHABLE },
    ]);

    const report = new Map(mine(await selectNotReadyWebsiteRows(pool as any)).map((r) => [r.stationId, (r as any).reason]));
    expect(report).toEqual(expected);

    // The allow-list admits exactly the named id, and the export writes the grid point only.
    const allowed = mine(await selectReadyWebsiteRows(pool as any, 200, [named]));
    expect(allowed.map((r) => r.stationId).sort()).toEqual([named, down, ready, silent].sort());
    const fresh = (await resolveReporting(allowed, 21, { providerCheck: async () => ({ kind: 'fresh', ageMinutes: 1 }) })).ready;
    const { artifact, skipped } = buildWebsiteExportArtifact(fresh, { ...CHAIN, batchId: 'b' });
    expect(skipped).toEqual([]);
    for (const s of artifact.stations) expect([s.latitude, s.longitude]).toEqual([10.3, -20.7]);
    // Reading changed nothing.
    expect((await row(ready)).status).toBe('db_only');
  });

  it('reconcile: same owner, active and real becomes on_chain; transferred or deactivated on chain, it is blocked', async () => {
    const w = wallet();
    const id = await station(w);
    await submit(w, id);
    expect(await reconcileWebsiteStations([chain(id, '0x' + w.address.slice(2).toUpperCase())], pool as any))
      .toEqual({ onChain: 1, blocked: 0, failed: 0 });
    expect((await status(w, id))!.state).toBe('earning');
    expect(await reconcileWebsiteStations([chain(id, wallet().address)], pool as any)).toEqual({ onChain: 0, blocked: 1, failed: 0 });
    expect(await row(id)).toMatchObject({ status: 'blocked', blocked_reason: 'station_id_taken_on_chain' });
    expect(await reconcileWebsiteStations([chain(id, w.address, { is_active: false })], pool as any)).toEqual({ onChain: 0, blocked: 1, failed: 0 });
    expect(await row(id)).toMatchObject({ status: 'blocked', blocked_reason: 'chain_record_not_active' });
    expect(await reconcileWebsiteStations([chain(id, w.address)], pool as any)).toEqual({ onChain: 1, blocked: 0, failed: 0 });
    expect(await row(id)).toMatchObject({ status: 'on_chain', blocked_reason: null });
    expect((await selectReadyWebsiteRows(pool as any, 200)).some((r) => r.stationId === id)).toBe(false);
  });

  it('reconcile: an id the chain has under another owner is blocked, leaves the waiting list, and stays blocked', async () => {
    const w = wallet();
    const id = await station(w);
    await submit(w, id);
    expect(await reconcileWebsiteStations([chain(id, wallet().address)], pool as any)).toEqual({ onChain: 0, blocked: 1, failed: 0 });
    expect(await status(w, id)).toEqual({ state: 'blocked', stationId: id, ...CHAIN, blockedReason: 'station_id_taken_on_chain' });
    expect((await selectReadyWebsiteRows(pool as any, 200)).some((r) => r.stationId === id)).toBe(false);
    expect((await selectNotReadyWebsiteRows(pool as any)).some((r) => r.stationId === id)).toBe(false);
    // Signing again cannot un-block it.
    expect(((await submit(w, id)).body.chainRegistration as any).state).toBe('blocked');
    expect((await row(id)).status).toBe('blocked');
  });

  it('reconcile: same owner but inactive or not real is blocked, and becomes on_chain if the chain later shows it live', async () => {
    const w = wallet();
    for (const over of [{ is_active: false }, { provenance_class: 'synthetic' }]) {
      const id = await station(w);
      await submit(w, id);
      expect(await reconcileWebsiteStations([chain(id, w.address, over)], pool as any)).toEqual({ onChain: 0, blocked: 1, failed: 0 });
      expect(await row(id)).toMatchObject({ status: 'blocked', blocked_reason: 'chain_record_not_active' });
      expect(await reconcileWebsiteStations([chain(id, w.address)], pool as any)).toEqual({ onChain: 1, blocked: 0, failed: 0 });
      expect(await row(id)).toMatchObject({ status: 'on_chain', blocked_reason: null });
    }
  });

  it('reconcile: adopts a website station registered on chain earlier, but not a back-filled one', async () => {
    const w = wallet();
    const website = await station(w);
    const backfilled = await station(w, { credentials: false });
    const result = await reconcileWebsiteStations([chain(website, w.address), chain(backfilled, w.address)], pool as any);
    expect(result).toEqual({ onChain: 1, blocked: 0, failed: 0 });
    expect(await row(website)).toMatchObject({ status: 'on_chain', owner_pubkey: null, ownership_signature: null });
    expect(await row(backfilled)).toBeUndefined();
    // A chain station the backend holds under another owner is not adopted.
    const other = await station(w);
    await reconcileWebsiteStations([chain(other, wallet().address)], pool as any);
    expect(await row(other)).toBeUndefined();
  });

  it('after an owner change the new owner reads their own state and can sign over the old row', async () => {
    const old = wallet();
    const id = await station(old);
    await submit(old, id);
    await reconcileWebsiteStations([chain(id, old.address)], pool as any);
    const next = wallet();
    await pool.query('UPDATE weather_stations SET owner_address = $2 WHERE station_id = $1', [id, next.address]);
    expect((await status(next, id))!.state).toBe('needs_owner_signature');
    expect(await status(old, id)).toBeNull();
    expect(((await submit(next, id)).body.chainRegistration as any).state).toBe('waiting');
    expect(await row(id)).toMatchObject({ owner_address: next.address, owner_pubkey: next.publicKey, status: 'db_only' });
    // The chain still has the old owner, so the next reconcile blocks it honestly.
    await reconcileWebsiteStations([chain(id, old.address)], pool as any);
    expect((await status(next, id))!.blockedReason).toBe('station_id_taken_on_chain');
  });
});
