/**
 * backend#1334 / #1335: the app's OWN `pool` shim (database/db.ts, a pg-compatible
 * facade over postgres.js) run against a real PostgreSQL.
 *
 * Why this exists: `pool.connect()` once returned a fake client over the shared
 * postgres.js pool, so every `BEGIN` failed live with
 *   UNSAFE_TRANSACTION: Only use sql.begin, sql.reserved or max: 1
 * and every mobile registration 500'd. CI missed it because
 * mobile-station-pg.integration.test.ts injects a real `pg.Pool`, never this shim.
 *
 * Isolation: database/connection.ts reads DATABASE_URL at import time and builds
 * the postgres.js client immediately (db.ts additionally starts an unref'd
 * keepalive timer). So this suite creates a throwaway DATABASE per process on the
 * disposable server named by MOBILE_STATION_PG_URL, points DATABASE_URL at it, and
 * only THEN imports database/db. It drops the database afterwards. Never point
 * MOBILE_STATION_PG_URL at the live backend server.
 *
 * MOBILE_STATION_REQUIRE_PG=1 (set by CI) turns a missing URL into a failure.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import postgres from 'postgres';
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
import { markRowsSubmitted, selectDbOnlyRows } from '../server/services/mobile-station-export';

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;

if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('MOBILE_STATION_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('real-Postgres db.ts pool-shim cases would have been skipped');
  });
}

const POOL_MAX = 3; // small on purpose: the release test cycles far more than this
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const RUN_ID = crypto.randomUUID();
let seedCounter = 0;
const uniqueSeed = () => `shim:${RUN_ID}:${seedCounter++}`;

function wallet(seed: string) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, crypto.createHash('sha256').update(`seed:${seed}`).digest()]), format: 'der', type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  const address = `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 40)}`;
  return { publicKey, address, sign: (m: Buffer) => crypto.sign(null, m, key).toString('hex') };
}

const COLLECT_PUBKEY = wallet('collect').publicKey;

function withDatabase(base: string, database: string): string {
  const u = new URL(base);
  u.pathname = `/${database}`;
  return u.toString();
}

d('database/db.ts pool shim against real Postgres', () => {
  const dbName = `shim_${process.pid}_${RUN_ID.slice(0, 8).replace(/-/g, '')}`;
  const NOW = Math.floor(Date.now() / 1000);
  const deps = { chainId: '777', networkId: 'testnet', now: () => NOW };
  let admin: Pool;
  let shim: typeof import('../database/db').pool;
  let dbUrl: string;
  const savedEnv = { url: process.env.DATABASE_URL, size: process.env.DB_POOL_SIZE };

  beforeAll(async () => {
    admin = new Pool({ connectionString: url, max: 1 });
    await admin.query(`CREATE DATABASE ${dbName}`);
    dbUrl = withDatabase(url as string, dbName);

    // DDL through a plain pg connection to the fresh database (setup, not under test).
    const ddl = new Pool({ connectionString: dbUrl, max: 1 });
    await ddl.query(`CREATE TABLE weather_stations (
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
      await ddl.query(fs.readFileSync(path.join(__dirname, '../drizzle/migrations', file), 'utf8'));
    }
    await ddl.query('CREATE TABLE shim_tx_probe (id serial PRIMARY KEY, tag text NOT NULL)');
    await ddl.end();

    // Import the app's shim exactly as production does, after DATABASE_URL is set.
    process.env.DATABASE_URL = dbUrl;
    process.env.DB_POOL_SIZE = String(POOL_MAX);
    shim = (await import('../database/db')).pool;
  });

  afterAll(async () => {
    try {
      await shim?.end();
    } finally {
      if (savedEnv.url === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedEnv.url;
      if (savedEnv.size === undefined) delete process.env.DB_POOL_SIZE; else process.env.DB_POOL_SIZE = savedEnv.size;
      await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await admin.end();
    }
  });

  const probeCount = async (tag: string) =>
    Number((await shim.query('SELECT COUNT(*)::int n FROM shim_tx_probe WHERE tag = $1', [tag])).rows[0].n);

  describe('(a) pool.connect() transactions', () => {
    it('BEGIN -> INSERT -> COMMIT persists (the #1334 regression: BEGIN used to throw UNSAFE_TRANSACTION)', async () => {
      const tag = `commit-${RUN_ID}`;
      const c = await shim.connect();
      try {
        await c.query('BEGIN');
        const ins = await c.query('INSERT INTO shim_tx_probe (tag) VALUES ($1) RETURNING id', [tag]);
        expect(ins.rows).toHaveLength(1);
        expect(ins.rowCount).toBe(1);
        // not visible to other sessions until COMMIT
        expect(await probeCount(tag)).toBe(0);
        await c.query('COMMIT');
      } finally {
        c.release();
      }
      expect(await probeCount(tag)).toBe(1);
    });

    it('BEGIN -> INSERT -> ROLLBACK discards', async () => {
      const tag = `rollback-${RUN_ID}`;
      const c = await shim.connect();
      try {
        await c.query('BEGIN');
        await c.query('INSERT INTO shim_tx_probe (tag) VALUES ($1)', [tag]);
        const inside = await c.query('SELECT COUNT(*)::int n FROM shim_tx_probe WHERE tag = $1', [tag]);
        expect(inside.rows[0].n).toBe(1); // same session sees its own write
        await c.query('ROLLBACK');
      } finally {
        c.release();
      }
      expect(await probeCount(tag)).toBe(0);
    });

    it('every statement on one client runs on ONE backend session', async () => {
      const c = await shim.connect();
      try {
        const pids = new Set<number>();
        await c.query('BEGIN');
        for (let i = 0; i < 4; i++) pids.add(Number((await c.query('SELECT pg_backend_pid() pid')).rows[0].pid));
        await c.query('ROLLBACK');
        expect(pids.size).toBe(1);
      } finally {
        c.release();
      }
    });

    it(`release() returns the reserved connection: ${POOL_MAX * 6} sequential connect/release cycles on a pool of ${POOL_MAX}`, async () => {
      for (let i = 0; i < POOL_MAX * 6; i++) {
        const c = await shim.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT 1');
          await c.query('COMMIT');
        } finally {
          c.release();
        }
      }
      // pool still serves both paths afterwards
      expect((await shim.query('SELECT 1 AS one')).rows[0].one).toBe(1);
      const c = await shim.connect();
      c.release();
    });

    it('release() is idempotent and a released client refuses queries', async () => {
      const c = await shim.connect();
      c.release();
      c.release();
      await expect(c.query('SELECT 1')).rejects.toThrow(/released/);
    });

    it('two concurrent transactions run on different sessions and do not interleave', async () => {
      const tagA = `conc-a-${RUN_ID}`;
      const tagB = `conc-b-${RUN_ID}`;
      const [a, b] = await Promise.all([shim.connect(), shim.connect()]);
      try {
        await Promise.all([a.query('BEGIN'), b.query('BEGIN')]);
        const [pa, pb] = await Promise.all([a.query('SELECT pg_backend_pid() pid'), b.query('SELECT pg_backend_pid() pid')]);
        expect(pa.rows[0].pid).not.toBe(pb.rows[0].pid);
        await Promise.all([
          a.query('INSERT INTO shim_tx_probe (tag) VALUES ($1)', [tagA]),
          b.query('INSERT INTO shim_tx_probe (tag) VALUES ($1)', [tagB]),
        ]);
        // each sees only its own uncommitted row
        const seenByA = await a.query('SELECT tag FROM shim_tx_probe WHERE tag IN ($1, $2)', [tagA, tagB]);
        const seenByB = await b.query('SELECT tag FROM shim_tx_probe WHERE tag IN ($1, $2)', [tagA, tagB]);
        expect(seenByA.rows.map((r) => r.tag)).toEqual([tagA]);
        expect(seenByB.rows.map((r) => r.tag)).toEqual([tagB]);
        // one commits, the other rolls back: outcomes stay independent
        await Promise.all([a.query('COMMIT'), b.query('ROLLBACK')]);
      } finally {
        a.release();
        b.release();
      }
      expect(await probeCount(tagA)).toBe(1);
      expect(await probeCount(tagB)).toBe(0);
    });

    it('more concurrent transactions than pool slots all complete once slots are released', async () => {
      const tag = `queue-${RUN_ID}`;
      await Promise.all(
        Array.from({ length: POOL_MAX * 3 }, async (_, i) => {
          const c = await shim.connect();
          try {
            await c.query('BEGIN');
            await c.query('INSERT INTO shim_tx_probe (tag) VALUES ($1)', [`${tag}`]);
            await c.query('SELECT pg_sleep(0.02)');
            await c.query(i % 2 === 0 ? 'COMMIT' : 'ROLLBACK');
          } finally {
            c.release();
          }
        })
      );
      expect(await probeCount(tag)).toBe(Math.ceil((POOL_MAX * 3) / 2));
    });
  });

  describe('(b)/(c) PgMobileStationStore over the shim pool', () => {
    async function bodyFor(w: ReturnType<typeof wallet>, store: PgMobileStationStore, cell = { latE1: 100, lonE1: -200 }) {
      const ch = (await issueMobileStationChallenge(store, w.address, deps)).body as any;
      const stationId = ch.stationId;
      return {
        ch,
        body: {
          nonce: ch.nonce, expiresAt: ch.expiresAt, publicKey: w.publicKey, collectPubkey: COLLECT_PUBKEY, cell, deviceClass: 'phone-barometer',
          registrationSignature: w.sign(buildMobileStationRegistrationMessage({
            chainId: '777', networkId: 'testnet', stationId, ownerAddress: w.address, collectPubkey: COLLECT_PUBKEY,
            latE1: cell.latE1, lonE1: cell.lonE1, nonce: ch.nonce, expiresAt: ch.expiresAt,
          })),
          ownershipSignature: w.sign(buildStationOwnershipMessage({
            chainId: '777', networkId: 'testnet', stationId, ownerAddress: w.address,
          })),
        },
      };
    }

    it('register end to end: 201, owner-guard row + registration row + consumed nonce, then idempotent 200', async () => {
      const w = wallet(uniqueSeed());
      const store = new PgMobileStationStore(shim);
      const { ch, body } = await bodyFor(w, store);
      const first = await registerMobileStation(store, w.address, body, deps);
      expect(first.status).toBe(201);
      const stationId = deriveMobileStationId(w.address);
      const guard = await shim.query('SELECT owner_address, latitude, longitude, station_type FROM weather_stations WHERE station_id = $1', [stationId]);
      expect(guard.rows[0]).toMatchObject({ owner_address: w.address, latitude: null, longitude: null, station_type: 'mobile' });
      const reg = await shim.query('SELECT * FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
      expect(reg.rows[0]).toMatchObject({ station_id: stationId, cell_lat_e1: 100, cell_lon_e1: -200, status: 'db_only' });
      const nonce = await shim.query('SELECT consumed_at FROM mobile_station_nonces WHERE nonce = $1', [ch.nonce]);
      expect(nonce.rows[0].consumed_at).not.toBeNull();
      expect((await registerMobileStation(store, w.address, body, deps)).status).toBe(200);
      const status = await getMobileStationStatus(store, w.address);
      expect(status.status).toBe(200);
    });

    it('owner conflict: a station id held by another owner is refused with 409 STATION_ID_TAKEN and no registration row (a business refusal, not an exception)', async () => {
      const w = wallet(uniqueSeed());
      const store = new PgMobileStationStore(shim);
      await shim.query(
        `INSERT INTO weather_stations (station_id, owner_address, location) VALUES ($1, '0x000000000000000000000000000000000000dead', 'x')`,
        [deriveMobileStationId(w.address)]
      );
      const { body } = await bodyFor(w, store);
      const res = await registerMobileStation(store, w.address, body, deps);
      expect(res.status).toBe(409);
      expect((res.body as any).error.code).toBe('STATION_ID_TAKEN');
      expect((await shim.query('SELECT 1 FROM mobile_station_registrations WHERE owner_address = $1', [w.address])).rows).toHaveLength(0);
    });

    it('an EXCEPTION after registration writes ROLLS BACK everything and returns a clean connection (#1342)', async () => {
      const w = wallet(uniqueSeed());
      const store = new PgMobileStationStore(shim);
      const { ch, body } = await bodyFor(w, store);
      const stationId = deriveMobileStationId(w.address);
      // The nonce is consumed and the weather_stations guard row is written BEFORE the
      // registration insert; make that insert throw so the transaction dies mid-way.
      await shim.query('ALTER TABLE mobile_station_registrations ADD CONSTRAINT shim_force_fail CHECK (false) NOT VALID');
      try {
        await expect(registerMobileStation(store, w.address, body, deps)).rejects.toThrow(/shim_force_fail|check constraint/i);
      } finally {
        await shim.query('ALTER TABLE mobile_station_registrations DROP CONSTRAINT shim_force_fail');
      }
      // the earlier writes of the failed transaction are gone
      expect((await shim.query('SELECT 1 FROM weather_stations WHERE station_id = $1', [stationId])).rows).toHaveLength(0);
      expect((await shim.query('SELECT 1 FROM mobile_station_registrations WHERE owner_address = $1', [w.address])).rows).toHaveLength(0);
      const nonce = await shim.query('SELECT consumed_at FROM mobile_station_nonces WHERE nonce = $1', [ch.nonce]);
      expect(nonce.rows[0].consumed_at).toBeNull();
      // and the reserved connection went back to the pool clean, not "idle in transaction"
      const dirty = await admin.query(
        `SELECT count(*)::int n FROM pg_stat_activity WHERE datname = $1 AND state LIKE 'idle in transaction%'`, [dbName]);
      expect(dirty.rows[0].n).toBe(0);
      // the same request succeeds once the fault is gone (the nonce was not burned)
      expect((await registerMobileStation(store, w.address, body, deps)).status).toBe(201);
    });

    it('advisory lock (pg_advisory_xact_lock) + FOR UPDATE nonce path: two concurrent registrations for one wallet -> 201 + 200, one row, never a 500', async () => {
      const w = wallet(uniqueSeed());
      const store = new PgMobileStationStore(shim);
      const a = await bodyFor(w, store);
      const b = await bodyFor(w, store, { latE1: 9, lonE1: 9 });
      const settled = await Promise.allSettled([
        registerMobileStation(store, w.address, a.body, deps),
        registerMobileStation(store, w.address, b.body, deps),
      ]);
      expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
      expect(settled.map((s) => (s as PromiseFulfilledResult<any>).value.status).sort()).toEqual([200, 201]);
      const count = await shim.query('SELECT COUNT(*)::int n FROM mobile_station_registrations WHERE owner_address = $1', [w.address]);
      expect(count.rows[0].n).toBe(1);
    });

    it('a per-wallet advisory lock held on one reserved client really blocks a second transaction until COMMIT', async () => {
      const key = `mobile-station:shim-lock-${RUN_ID}`;
      const holder = await shim.connect();
      const waiter = await shim.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
        await waiter.query('BEGIN');
        const got = (await waiter.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [key])).rows[0].ok;
        expect(got).toBe(false);
        await holder.query('COMMIT');
        const after = (await waiter.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS ok', [key])).rows[0].ok;
        expect(after).toBe(true);
        await waiter.query('COMMIT');
      } finally {
        holder.release();
        waiter.release();
      }
    });

    it('SELECT ... FOR UPDATE on a reserved client blocks a competing writer until COMMIT', async () => {
      const tag = `forupdate-${RUN_ID}`;
      const ins = await shim.query('INSERT INTO shim_tx_probe (tag) VALUES ($1) RETURNING id', [tag]);
      const id = (ins.rows[0] as any).id;
      const locker = await shim.connect();
      const writer = await shim.connect();
      try {
        await locker.query('BEGIN');
        await locker.query('SELECT id FROM shim_tx_probe WHERE id = $1 FOR UPDATE', [id]);
        await writer.query('BEGIN');
        await writer.query("SET LOCAL lock_timeout = '150ms'");
        await expect(writer.query('UPDATE shim_tx_probe SET tag = $2 WHERE id = $1', [id, `${tag}-w`])).rejects.toThrow(/lock timeout/i);
        await writer.query('ROLLBACK');
        await locker.query('COMMIT');
        await writer.query('BEGIN');
        await writer.query('UPDATE shim_tx_probe SET tag = $2 WHERE id = $1', [id, `${tag}-w`]);
        await writer.query('COMMIT');
      } finally {
        locker.release();
        writer.release();
      }
      expect(await probeCount(`${tag}-w`)).toBe(1);
    });
  });

  describe('(d) export script pool wrapper (sql.unsafe) with array parameters', () => {
    it('markRowsSubmitted with a $1::text[] parameter really updates rows under postgres.js', async () => {
      const store = new PgMobileStationStore(shim);
      const wallets = [wallet(uniqueSeed()), wallet(uniqueSeed()), wallet(uniqueSeed())];
      for (const w of wallets) {
        const ch = (await issueMobileStationChallenge(store, w.address, deps)).body as any;
        const cell = { latE1: 1, lonE1: 2 };
        const res = await registerMobileStation(store, w.address, {
          nonce: ch.nonce, expiresAt: ch.expiresAt, publicKey: w.publicKey, collectPubkey: COLLECT_PUBKEY, cell, deviceClass: 'phone-barometer',
          registrationSignature: w.sign(buildMobileStationRegistrationMessage({
            chainId: '777', networkId: 'testnet', stationId: ch.stationId, ownerAddress: w.address, collectPubkey: COLLECT_PUBKEY,
            latE1: 1, lonE1: 2, nonce: ch.nonce, expiresAt: ch.expiresAt,
          })),
          ownershipSignature: w.sign(buildStationOwnershipMessage({
            chainId: '777', networkId: 'testnet', stationId: ch.stationId, ownerAddress: w.address,
          })),
        }, deps);
        expect(res.status).toBe(201);
      }
      const ids = wallets.map((w) => deriveMobileStationId(w.address));

      // Mirrors scripts/export-mobile-station-registrations.ts (its main() runs on
      // import, so the wrapper cannot be imported): max:1 client, sql.unsafe(text, params).
      const sql = postgres(dbUrl, { max: 1 });
      const exportPool = {
        query: async (text: string, params: unknown[] = []) => {
          const rows = await sql.unsafe(text, params as any[]);
          return { rows: rows as unknown as any[], rowCount: (rows as any).count ?? rows.length };
        },
      };
      try {
        const selected = (await selectDbOnlyRows(exportPool as any, 1000)).filter((r) => ids.includes(r.stationId));
        expect(selected).toHaveLength(3);
        // mark two of the three: exactly those two, once
        expect(await markRowsSubmitted(exportPool as any, ids.slice(0, 2), 'b-shim')).toBe(2);
        expect(await markRowsSubmitted(exportPool as any, ids.slice(0, 2), 'b-other')).toBe(0);
        const rows = await shim.query(
          'SELECT station_id, status, governance_batch_id FROM mobile_station_registrations WHERE station_id = ANY($1::text[]) ORDER BY station_id', [ids]);
        const by = Object.fromEntries(rows.rows.map((r: any) => [r.station_id, r]));
        expect(by[ids[0]]).toMatchObject({ status: 'submitted', governance_batch_id: 'b-shim' });
        expect(by[ids[1]]).toMatchObject({ status: 'submitted', governance_batch_id: 'b-shim' });
        expect(by[ids[2]]).toMatchObject({ status: 'db_only', governance_batch_id: null });
      } finally {
        await sql.end({ timeout: 5 });
      }
    });
  });
});
