/**
 * backend#1402: throwaway-database teardown against real Postgres. A loaded CI runner
 * opened a window between pg-pool's end() and the session really disconnecting; here the
 * window is made deterministic by delaying each client's Terminate message. Every DROP the
 * helper sends is observed: the server must show zero sessions on the database at that moment.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { ADMIN_SHUTDOWN, dropThrowawayDatabase, sessionsOn } from './helpers/throwaway-db';

const url = process.env.MOBILE_STATION_PG_URL;
const d = url ? describe : describe.skip;
if (!url && process.env.MOBILE_STATION_REQUIRE_PG === '1') {
  it('MOBILE_STATION_PG_URL is required when MOBILE_STATION_REQUIRE_PG=1', () => {
    throw new Error('the throwaway-db teardown test would have been skipped');
  });
}

const DELAY_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('throwaway-database teardown (backend#1402)', () => {
  let admin: Pool;
  let observer: Pool;
  let n = 0;

  beforeAll(() => {
    admin = new Pool({ connectionString: url, max: 1 });
    observer = new Pool({ connectionString: url, max: 1 });
  });
  afterAll(async () => {
    await admin?.end();
    await observer?.end();
  });

  const exists = async (name: string) =>
    (await observer.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount === 1;

  /** Record the server's session count on `name` at the instant each DROP is sent through `admin`. */
  function observeDrops(name: string) {
    const atDrop: number[] = [];
    const query = admin.query.bind(admin) as (...a: unknown[]) => Promise<unknown>;
    const spy = jest.spyOn(admin, 'query').mockImplementation((async (...args: unknown[]) => {
      if (typeof args[0] === 'string' && args[0].startsWith('DROP DATABASE')) atDrop.push(await sessionsOn(observer, name));
      return query(...args);
    }) as never);
    return { atDrop, restore: () => spy.mockRestore() };
  }

  /** A fresh database and a used pool on it whose clients send Terminate `delay` ms late. */
  async function slowClosingPool(onTerminate?: (pool: Pool) => void, delay = DELAY_MS) {
    const name = `teardown1402_${process.pid}_${n++}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const u = new URL(url as string);
    u.pathname = `/${name}`;
    const pool = new Pool({ connectionString: u.toString(), max: 1 });
    pool.on('connect', (client) => {
      const con = (client as unknown as { connection: { end: () => void } }).connection;
      const end = con.end.bind(con);
      con.end = () => {
        onTerminate?.(pool);
        setTimeout(end, delay);
      };
    });
    for (let i = 0; i < 3; i++) await pool.query('SELECT 1');
    const emitted: unknown[] = [];
    const emit = pool.emit.bind(pool);
    jest.spyOn(pool, 'emit').mockImplementation((event: string | symbol, ...args: unknown[]) => {
      if (event === 'error') emitted.push(args[0]);
      return emit(event, ...args);
    });
    return { name, pool, emitted, url: u.toString() };
  }

  it('the hazard: right after pool.end() the session is still there and a FORCE drop kills it with 57P01', async () => {
    const { name, pool, emitted } = await slowClosingPool();
    pool.on('error', () => {}); // keep the demonstration from crashing the suite
    await pool.end();
    expect(await sessionsOn(observer, name)).toBe(1);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    for (let i = 0; i < 50 && emitted.length === 0; i++) await sleep(20);
    expect(emitted.map((e) => (e as { code?: string }).code)).toEqual([ADMIN_SHUTDOWN]);
  });

  it('the drop is sent only when the server shows no session; no pool error at all; the database is gone', async () => {
    const { name, pool, emitted } = await slowClosingPool();
    const drops = observeDrops(name);
    try {
      await dropThrowawayDatabase(admin, name, [pool]);
    } finally {
      drops.restore();
    }
    await sleep(DELAY_MS);
    expect(drops.atDrop).toEqual([0]);
    expect(emitted).toEqual([]);
    expect(await exists(name)).toBe(false);
  });

  it('deadline: sessions still connected at the deadline fail the teardown and nothing is dropped', async () => {
    const { name, pool, emitted } = await slowClosingPool(undefined, 1500);
    const drops = observeDrops(name);
    try {
      await expect(dropThrowawayDatabase(admin, name, [pool], { timeoutMs: 200 })).rejects.toThrow(/still connected after 200 ms/);
    } finally {
      drops.restore();
    }
    expect(drops.atDrop).toEqual([]);
    expect(await exists(name)).toBe(true);
    await sleep(1600); // the delayed Terminate completes on its own: no 57P01 was ever sent
    expect(emitted).toEqual([]);
    expect(await sessionsOn(observer, name)).toBe(0);
    await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  });

  it('an already-ending pool is not taken as disconnected: the drop still waits for the server', async () => {
    const { name, pool, emitted } = await slowClosingPool();
    void pool.end(); // ending, socket still open
    await sleep(0);
    expect(pool.ending).toBe(true);
    const drops = observeDrops(name);
    try {
      await dropThrowawayDatabase(admin, name, [pool]);
    } finally {
      drops.restore();
    }
    await sleep(DELAY_MS);
    expect(drops.atDrop).toEqual([0]);
    expect(emitted).toEqual([]);
    expect(await exists(name)).toBe(false);
  });

  it('a session from a pool the helper was not given (e.g. a stopped app) is also waited for', async () => {
    const { name, pool, url: dbUrl } = await slowClosingPool();
    const stray = new Pool({ connectionString: dbUrl, max: 1 });
    stray.on('error', () => {});
    await stray.query('SELECT 1');
    setTimeout(() => void stray.end(), 250);
    const drops = observeDrops(name);
    try {
      await dropThrowawayDatabase(admin, name, [pool]);
    } finally {
      drops.restore();
    }
    expect(drops.atDrop).toEqual([0]);
    expect(await exists(name)).toBe(false);
  });

  it('a 57P01 during teardown is tolerated', async () => {
    const { name, pool } = await slowClosingPool((p) => {
      p.emit('error', Object.assign(new Error('terminating connection due to administrator command'), { code: ADMIN_SHUTDOWN }));
    });
    await dropThrowawayDatabase(admin, name, [pool]); // throws if the teardown fails
    expect(await exists(name)).toBe(false);
  });

  it('any other pool error during teardown still fails it, and the database is still dropped', async () => {
    const { name, pool } = await slowClosingPool((p) => {
      p.emit('error', Object.assign(new Error('injected teardown failure'), { code: 'XX000' }));
    });
    await expect(dropThrowawayDatabase(admin, name, [pool])).rejects.toThrow(/injected teardown failure/);
    expect(await exists(name)).toBe(false);
  });

  it('outside teardown nothing is tolerated: the helper leaves no listener behind, on success or failure', async () => {
    const ok = await slowClosingPool();
    const keep = () => {};
    ok.pool.on('error', keep);
    await dropThrowawayDatabase(admin, ok.name, [ok.pool]);
    expect(ok.pool.listeners('error')).toEqual([keep]);
    ok.pool.removeListener('error', keep);
    for (const code of [ADMIN_SHUTDOWN, 'XX000']) {
      expect(() => ok.pool.emit('error', Object.assign(new Error('after teardown'), { code }))).toThrow('after teardown');
    }
    const bad = await slowClosingPool((p) => {
      p.emit('error', Object.assign(new Error('injected teardown failure'), { code: 'XX000' }));
    });
    await expect(dropThrowawayDatabase(admin, bad.name, [bad.pool])).rejects.toThrow(/injected teardown failure/);
    expect(bad.pool.listenerCount('error')).toBe(0);
    const late = await slowClosingPool(undefined, 1500);
    await expect(dropThrowawayDatabase(admin, late.name, [late.pool], { timeoutMs: 100 })).rejects.toThrow(/still connected/);
    expect(late.pool.listenerCount('error')).toBe(0);
    await sleep(1600);
    await admin.query(`DROP DATABASE IF EXISTS ${late.name}`);
  });

  it('undefined pools are skipped; an undefined admin drops nothing', async () => {
    const { name, pool } = await slowClosingPool();
    await dropThrowawayDatabase(admin, name, [undefined, pool]);
    expect(await exists(name)).toBe(false);
    await dropThrowawayDatabase(undefined, 'never_created_1402', [undefined]);
  });
});
