/**
 * backend#1253: chain -> weather_stations sync job.
 *
 * The pool models the weather_stations semantics the backfill rules rely on
 * (unique station_id, ON CONFLICT DO NOTHING, guarded coordinate fill).
 */

import postgres from 'postgres';
import {
  OVERWRITE_COORDINATES_SQL,
  fetchChainStationList,
  labelMapFromEnv,
  parseLabelMap,
  resolveSyncIntervalMs,
  runStationSyncOnce,
  startChainStationSync,
  stopChainStationSync,
  MIN_SYNC_INTERVAL_MS,
  DEFAULT_SYNC_INTERVAL_MS,
  type ChainStationListEntry,
} from '../server/services/chain-station-sync.js';
import type { BackfillPool } from '../server/services/chain-station-backfill.js';

const OWNER = '0x7d29a4fb00000000000000000000000000000001';
const OTHER = '0x5eaf842a8341cd38812a63de6b5dcc5103f071c0';

interface Row {
  station_id: string;
  owner_address: string;
  latitude: number | null;
  longitude: number | null;
  name?: string;
  location?: string;
}

function tablePool(initial: Row[] = []) {
  const rows = new Map(initial.map((r) => [r.station_id, { ...r }]));
  const overwrites: string[] = [];
  const pool: BackfillPool = {
    query: async (sql: string, params: unknown[] = []) => {
      if (sql.startsWith('SELECT owner_address, latitude, longitude FROM weather_stations')) {
        const r = rows.get(params[0] as string);
        return { rows: r ? [r] : [] };
      }
      if (sql.includes('INSERT INTO weather_stations')) {
        const id = params[0] as string;
        if (rows.has(id)) return { rows: [], rowCount: 0 };
        rows.set(id, {
          station_id: id,
          owner_address: params[1] as string,
          location: params[2] as string,
          latitude: params[3] as number,
          longitude: params[4] as number,
          name: params[5] as string,
        });
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      if (sql.includes('UPDATE weather_stations') && sql.includes('IS DISTINCT FROM')) {
        // Q6 overwrite: same owner, and only when the coordinates differ.
        const [id, lat, lon, owner] = params as [string, number, number, string];
        const r = rows.get(id);
        if (!r || r.owner_address.toLowerCase() !== owner.toLowerCase() || (r.latitude === lat && r.longitude === lon)) {
          return { rows: [], rowCount: 0 };
        }
        r.latitude = lat;
        r.longitude = lon;
        overwrites.push(id);
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      if (sql.includes('UPDATE weather_stations')) {
        // #1251 fill: only the NULL column(s) (COALESCE).
        const [id, lat, lon, owner] = params as [string, number, number, string];
        const r = rows.get(id);
        if (!r || (r.latitude !== null && r.longitude !== null) || r.owner_address.toLowerCase() !== owner.toLowerCase()) {
          return { rows: [], rowCount: 0 };
        }
        r.latitude = r.latitude ?? lat;
        r.longitude = r.longitude ?? lon;
        return { rows: [{ station_id: id }], rowCount: 1 };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { pool, rows, overwrites };
}

function entry(id: string, over: Partial<ChainStationListEntry> = {}): ChainStationListEntry {
  return {
    station_id: id,
    owner_address: OWNER,
    provenance_class: 'real',
    is_active: true,
    latitude: 10.123456,
    longitude: -20.987654,
    elevation_meters: 350,
    ...over,
  };
}

const LABELS = {
  'PWS-EXAMPLE-WS5000': { name: 'Example Station', location: 'Example location' },
  'PWS-EXAMPLE-PRIVATE-01': { name: 'Example private station', location: 'Example location' },
};

describe('backend#1253 chain station sync', () => {
  afterEach(async () => {
    await stopChainStationSync();
  });

  test('inserts labelled chain stations with the configured label, never the id, and is idempotent', async () => {
    const { pool, rows } = tablePool();
    const list = async () => [entry('PWS-EXAMPLE-WS5000'), entry('PWS-EXAMPLE-PRIVATE-01', { owner_address: '0x1747c01600000000000000000000000000000002', latitude: 30.5, longitude: -40.5 })];
    const first = await runStationSyncOnce({ listStations: list, labels: LABELS, pool });
    expect(first).toMatchObject({ chainStations: 2, inserted: 2, refused: 0, unlabelled: 0 });
    expect(rows.get('PWS-EXAMPLE-WS5000')).toMatchObject({
      name: 'Example Station',
      location: 'Example location',
      owner_address: OWNER,
      latitude: 10.1, // W21: the 0.1 degree grid point of the chain registration, never finer
      longitude: -21,
    });
    for (const r of rows.values()) {
      expect(r.name).not.toMatch(/EXAMPLE-PRIVATE|PWS-/i);
      expect(r.location).not.toMatch(/EXAMPLE-PRIVATE|PWS-/i);
    }
    const second = await runStationSyncOnce({ listStations: list, labels: LABELS, pool });
    expect(second).toMatchObject({ inserted: 0, unchanged: 2, refused: 0 });
  });

  test('an unlabelled station is skipped, not titled after its id', async () => {
    const { pool, rows } = tablePool();
    const res = await runStationSyncOnce({
      listStations: async () => [entry('PWS-SOMEONE-PRIVATE-01')],
      labels: LABELS,
      pool,
    });
    expect(res).toMatchObject({ chainStations: 1, unlabelled: 1, inserted: 0 });
    expect(rows.size).toBe(0);
  });

  test('backfill rules hold: different owner never overwritten; synthetic/inactive refused', async () => {
    const { pool, rows } = tablePool([
      { station_id: 'PWS-EXAMPLE-WS5000', owner_address: OTHER, latitude: null, longitude: null },
    ]);
    const res = await runStationSyncOnce({
      listStations: async () => [
        entry('PWS-EXAMPLE-WS5000'),
        entry('PWS-EXAMPLE-PRIVATE-01', { provenance_class: 'synthetic' }),
        entry('PWS-X', { is_active: false }),
      ],
      labels: { ...LABELS, 'PWS-X': { name: 'X weather station' } },
      pool,
    });
    expect(res.refused).toBe(3);
    expect(res.refusedIds.sort()).toEqual(['PWS-EXAMPLE-PRIVATE-01', 'PWS-EXAMPLE-WS5000', 'PWS-X']);
    expect(rows.get('PWS-EXAMPLE-WS5000')!.owner_address).toBe(OTHER);
    expect(rows.size).toBe(1);
  });

  test('a same-owner row missing coordinates gets the chain coordinates', async () => {
    const { pool, rows } = tablePool([
      { station_id: 'PWS-EXAMPLE-WS5000', owner_address: OWNER, latitude: null, longitude: null, name: 'kept' },
    ]);
    const res = await runStationSyncOnce({ listStations: async () => [entry('PWS-EXAMPLE-WS5000')], labels: LABELS, pool });
    expect(res.coordinatesFilled).toBe(1);
    expect(rows.get('PWS-EXAMPLE-WS5000')).toMatchObject({ latitude: 10.1, longitude: -21, name: 'kept' });
  });

  test('a list failure writes nothing', async () => {
    const { pool, rows } = tablePool();
    await expect(
      runStationSyncOnce({ listStations: async () => { throw new Error('node station list answered HTTP 403'); }, labels: LABELS, pool })
    ).rejects.toThrow(/HTTP 403/);
    expect(rows.size).toBe(0);
  });

  describe('fetchChainStationList', () => {
    function pagedFetch(pages: Array<{ status?: number; body: unknown }>) {
      const urls: string[] = [];
      const auths: string[] = [];
      let i = 0;
      const impl = (async (url: string, init: any) => {
        urls.push(url);
        auths.push(init.headers.Authorization);
        const p = pages[Math.min(i++, pages.length - 1)];
        const status = p.status ?? 200;
        return { status, ok: status >= 200 && status < 300, json: async () => p.body } as any;
      }) as unknown as typeof fetch;
      return { impl, urls, auths };
    }

    test('walks keyset pages with the operator bearer', async () => {
      const { impl, urls, auths } = pagedFetch([
        { body: { stations: [entry('A'), entry('B')], has_more: true, next_cursor: 'B' } },
        { body: { stations: [entry('C')], has_more: false, next_cursor: null } },
      ]);
      const all = await fetchChainStationList('http://node:8556/', 'optok', impl);
      expect(all.map((s) => s.station_id)).toEqual(['A', 'B', 'C']);
      expect(urls[0]).toBe('http://node:8556/transactions/station/registrations?limit=500');
      expect(urls[1]).toBe('http://node:8556/transactions/station/registrations?limit=500&after=B');
      expect(auths).toEqual(['Bearer optok', 'Bearer optok']);
    });

    test('fails closed on HTTP error, malformed page, or a cursor that does not advance', async () => {
      await expect(fetchChainStationList('http://n', 't', pagedFetch([{ status: 403, body: {} }]).impl)).rejects.toThrow(/HTTP 403/);
      await expect(fetchChainStationList('http://n', 't', pagedFetch([{ body: { nope: 1 } }]).impl)).rejects.toThrow(/no stations array/);
      await expect(
        fetchChainStationList(
          'http://n',
          't',
          pagedFetch([
            { body: { stations: [entry('B')], has_more: true, next_cursor: 'B' } },
            { body: { stations: [entry('B')], has_more: true, next_cursor: 'B' } },
          ]).impl
        )
      ).rejects.toThrow(/did not advance/);
    });
  });

  describe('config', () => {
    test('label map validation', () => {
      expect(parseLabelMap(JSON.stringify(LABELS))['PWS-EXAMPLE-PRIVATE-01'].name).toBe('Example private station');
      expect(() => parseLabelMap('not json')).toThrow(/valid JSON/);
      expect(() => parseLabelMap('[]')).toThrow(/object keyed by station id/);
      expect(() => parseLabelMap('{"A":{"name":""}}')).toThrow(/non-empty name/);
      expect(labelMapFromEnv({})).toEqual({});
    });

    test('interval defaults and clamps', () => {
      expect(resolveSyncIntervalMs(undefined)).toBe(DEFAULT_SYNC_INTERVAL_MS);
      expect(resolveSyncIntervalMs('abc')).toBe(DEFAULT_SYNC_INTERVAL_MS);
      expect(resolveSyncIntervalMs('5')).toBe(MIN_SYNC_INTERVAL_MS);
      expect(resolveSyncIntervalMs('900000')).toBe(900000);
    });
  });

  describe('startChainStationSync', () => {
    const logger = { info: jest.fn(), warn: jest.fn() };
    const baseEnv = {
      STATION_CHAIN_SYNC_ENABLED: 'true',
      CORE4_API_URL: 'http://node:8556',
      WRFCOIN_OPERATOR_TOKEN: 'optok',
      STATION_CHAIN_SYNC_LABELS: JSON.stringify(LABELS),
    };

    test('is OFF by default', async () => {
      const { pool } = tablePool();
      expect(await startChainStationSync({ env: {}, pool, logger })).toBe(false);
      expect(await startChainStationSync({ env: { ...baseEnv, STATION_CHAIN_SYNC_ENABLED: '1' }, pool, logger })).toBe(false);
    });

    test.each([
      ['no node url', { CORE4_API_URL: undefined }],
      ['no token', { WRFCOIN_OPERATOR_TOKEN: undefined }],
      ['bad labels', { STATION_CHAIN_SYNC_LABELS: '[]' }],
    ])('refuses to start with %s', async (_label, over) => {
      const { pool } = tablePool();
      expect(await startChainStationSync({ env: { ...baseEnv, ...over } as any, pool, logger })).toBe(false);
    });

    test('an empty label map STARTS (mobile path needs no labels) and logs that labelled sync covers 0 stations', async () => {
      const { pool } = tablePool();
      const info = jest.fn();
      const fetchImpl = (async () => ({
        status: 200,
        ok: true,
        json: async () => ({ stations: [], has_more: false, next_cursor: null }),
      })) as unknown as typeof fetch;
      const setIntervalImpl = ((fn: () => void) => setInterval(fn, 1e9)) as unknown as typeof setInterval;
      const started = await startChainStationSync({
        env: { ...baseEnv, STATION_CHAIN_SYNC_LABELS: undefined } as any,
        pool,
        logger: { info, warn: jest.fn() },
        fetchImpl,
        setIntervalImpl,
      });
      expect(started).toBe(true);
      await stopChainStationSync();
      expect(JSON.stringify(info.mock.calls)).toMatch(/labelled sync covers 0 stations/);
    });

    test('runs a pass immediately and schedules the clamped interval', async () => {
      const { pool, rows } = tablePool();
      const fetchImpl = (async () => ({
        status: 200,
        ok: true,
        json: async () => ({ stations: [entry('PWS-EXAMPLE-WS5000')], has_more: false, next_cursor: null }),
      })) as unknown as typeof fetch;
      let scheduledMs = 0;
      const setIntervalImpl = ((fn: () => void, ms: number) => {
        scheduledMs = ms;
        return setInterval(fn, 1e9);
      }) as unknown as typeof setInterval;
      const started = await startChainStationSync({
        env: { ...baseEnv, STATION_CHAIN_SYNC_INTERVAL_MS: '1000' },
        pool,
        logger,
        fetchImpl,
        setIntervalImpl,
      });
      expect(started).toBe(true);
      expect(scheduledMs).toBe(MIN_SYNC_INTERVAL_MS);
      await stopChainStationSync(); // awaits the in-flight first pass
      expect(rows.get('PWS-EXAMPLE-WS5000')).toMatchObject({ name: 'Example Station' });
      const logged = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls]);
      expect(logged).not.toContain(OWNER);
      expect(logged).not.toContain('10.12');
    });
  });
});

describe('backend#1253 no-leak discipline (#1251 review P2)', () => {
  const SECRET = '10.123456';

  afterEach(async () => {
    await stopChainStationSync();
  });

  test('a non-JSON node list is a fixed diagnostic, not a parse excerpt', async () => {
    const fetchImpl = (async () => ({
      status: 200,
      ok: true,
      json: async () => JSON.parse(`{"stations":[${SECRET}, oops`),
    })) as unknown as typeof fetch;
    await expect(fetchChainStationList('http://n', 't', fetchImpl)).rejects.toThrow(/^node station list is not valid JSON$/);
  });

  test('pass-failure logs carry only fixed text: parse failure and DB failure', async () => {
    const warns: string[] = [];
    const logger = { info: () => {}, warn: (m: string, meta?: Record<string, unknown>) => warns.push(`${m} ${JSON.stringify(meta ?? {})}`) };
    const env = {
      STATION_CHAIN_SYNC_ENABLED: 'true',
      CORE4_API_URL: 'http://node:8556',
      WRFCOIN_OPERATOR_TOKEN: 'optok',
      STATION_CHAIN_SYNC_LABELS: JSON.stringify(LABELS),
    };
    const noTimer = ((fn: () => void) => setInterval(fn, 1e9)) as unknown as typeof setInterval;

    // 1) node answers garbage that embeds a coordinate
    const garbage = (async () => ({ status: 200, ok: true, json: async () => JSON.parse(`[${SECRET} x`) })) as unknown as typeof fetch;
    const { pool } = tablePool();
    await startChainStationSync({ env, pool, logger, fetchImpl: garbage, setIntervalImpl: noTimer });
    await stopChainStationSync();

    // 2) DB throws a driver-style error whose message embeds query parameters
    const good = (async () => ({
      status: 200,
      ok: true,
      json: async () => ({ stations: [entry('PWS-EXAMPLE-WS5000')], has_more: false, next_cursor: null }),
    })) as unknown as typeof fetch;
    const failingPool: BackfillPool = {
      query: async () => {
        throw Object.assign(new Error(`bad value ${SECRET} for column latitude`), { code: '22P02' });
      },
    };
    await startChainStationSync({ env, pool: failingPool, logger, fetchImpl: good, setIntervalImpl: noTimer });
    await stopChainStationSync();

    const text = warns.join('\n');
    expect(text).toContain('node station list is not valid JSON');
    expect(text).toContain('database or node error (22P02) (details withheld)');
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(OWNER);
  });

  test('a bad label key is not echoed unless it is a valid station id', () => {
    expect(() => parseLabelMap(JSON.stringify({ [`${SECRET} x`]: { name: '' } }))).toThrow(/^label for <invalid id> needs a non-empty name$/);
  });
});

describe('owner ruling Q6: chain coordinates overwrite same-owner rows', () => {
  test('a same-owner row with different coordinates is overwritten; other columns kept', async () => {
    const { pool, rows } = tablePool([
      { station_id: 'PWS-EXAMPLE-WS5000', owner_address: OWNER.toUpperCase().replace('0X', '0x'), latitude: 1.5, longitude: 2.5, name: 'kept' },
    ]);
    const res = await runStationSyncOnce({ listStations: async () => [entry('PWS-EXAMPLE-WS5000')], labels: LABELS, pool });
    expect(res).toMatchObject({ coordinatesUpdated: 1, unchanged: 0, refused: 0 });
    expect(rows.get('PWS-EXAMPLE-WS5000')).toMatchObject({ latitude: 10.1, longitude: -21, name: 'kept' });
  });

  test('a row already at the grid point of the chain registration: no write', async () => {
    const { pool, overwrites } = tablePool([
      { station_id: 'PWS-EXAMPLE-WS5000', owner_address: OWNER, latitude: 10.1, longitude: -21 },
    ]);
    const res = await runStationSyncOnce({ listStations: async () => [entry('PWS-EXAMPLE-WS5000')], labels: LABELS, pool });
    expect(res).toMatchObject({ coordinatesUpdated: 0, unchanged: 1 });
    expect(overwrites).toEqual([]);
  });

  test('a different-owner row is NEVER touched, coordinates included', async () => {
    const { pool, rows, overwrites } = tablePool([
      { station_id: 'PWS-EXAMPLE-WS5000', owner_address: OTHER, latitude: 1.5, longitude: 2.5, name: 'theirs' },
    ]);
    const res = await runStationSyncOnce({ listStations: async () => [entry('PWS-EXAMPLE-WS5000')], labels: LABELS, pool });
    expect(res).toMatchObject({ coordinatesUpdated: 0, refused: 1, refusedIds: ['PWS-EXAMPLE-WS5000'] });
    expect(overwrites).toEqual([]);
    expect(rows.get('PWS-EXAMPLE-WS5000')).toEqual({
      station_id: 'PWS-EXAMPLE-WS5000', owner_address: OTHER, latitude: 1.5, longitude: 2.5, name: 'theirs',
    });
  });

  test('synthetic or inactive on chain: never overwritten', async () => {
    const { pool, overwrites } = tablePool([
      { station_id: 'PWS-EXAMPLE-WS5000', owner_address: OWNER, latitude: 1.5, longitude: 2.5 },
      { station_id: 'PWS-EXAMPLE-PRIVATE-01', owner_address: OWNER, latitude: 1.5, longitude: 2.5 },
    ]);
    await runStationSyncOnce({
      listStations: async () => [entry('PWS-EXAMPLE-WS5000', { provenance_class: 'synthetic' }), entry('PWS-EXAMPLE-PRIVATE-01', { is_active: false })],
      labels: LABELS,
      pool,
    });
    expect(overwrites).toEqual([]);
  });

  test('the overwrite pass logs counts only', async () => {
    const infos: string[] = [];
    const logger = { info: (m: string, meta?: Record<string, unknown>) => infos.push(`${m} ${JSON.stringify(meta ?? {})}`), warn: () => {} };
    const { pool } = tablePool([{ station_id: 'PWS-EXAMPLE-WS5000', owner_address: OWNER, latitude: 1.5, longitude: 2.5 }]);
    const fetchImpl = (async () => ({ status: 200, ok: true, json: async () => ({ stations: [entry('PWS-EXAMPLE-WS5000')], has_more: false, next_cursor: null }) })) as unknown as typeof fetch;
    await startChainStationSync({
      env: { STATION_CHAIN_SYNC_ENABLED: 'true', CORE4_API_URL: 'http://n', WRFCOIN_OPERATOR_TOKEN: 't', STATION_CHAIN_SYNC_LABELS: JSON.stringify(LABELS) },
      pool, logger, fetchImpl, setIntervalImpl: ((fn: () => void) => setInterval(fn, 1e9)) as unknown as typeof setInterval,
    });
    await stopChainStationSync();
    const text = infos.join('\n');
    expect(text).toContain('"coordinatesUpdated":1');
    expect(text).not.toMatch(/10\.12|20\.98|1\.5|2\.5/);
    expect(text).not.toContain(OWNER);
  });
});

// Real PostgreSQL semantics of the Q6 overwrite (BACKFILL_TEST_PG_URL, as in CT102 CI).
const PG_URL = process.env.BACKFILL_TEST_PG_URL;
(PG_URL ? describe : describe.skip)('Q6 overwrite SQL against real PostgreSQL', () => {
  const schema = `sync_q6_${process.pid}`;
  let sql: ReturnType<typeof postgres>;
  let pool: BackfillPool;

  beforeAll(async () => {
    sql = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe(`CREATE TABLE weather_stations (
      station_id text NOT NULL UNIQUE, owner_address text NOT NULL, location text NOT NULL DEFAULT 'x',
      name text, latitude double precision, longitude double precision, metadata jsonb,
      station_type text, is_active boolean NOT NULL DEFAULT true,
      updated_at timestamp NOT NULL DEFAULT '2000-01-01')`);
    pool = { query: async (text, params = []) => { const r = await sql.unsafe(text, params as any[]); return { rows: Array.from(r), count: r.count }; } };
  });
  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => { await sql.unsafe('TRUNCATE weather_stations'); });

  async function row() {
    const [r] = await sql.unsafe(`SELECT owner_address, latitude, longitude, name, updated_at FROM weather_stations`);
    return r;
  }

  test('same owner (case-insensitive), different coordinates → overwritten, name kept', async () => {
    await sql.unsafe(`INSERT INTO weather_stations (station_id, owner_address, name, latitude, longitude) VALUES ('S', $1, 'kept', 1.5, 2.5)`, [OWNER.toUpperCase().replace('0X', '0x')]);
    const r = await pool.query(OVERWRITE_COORDINATES_SQL, ['S', 10.123456, -20.987654, OWNER]);
    expect(r.count).toBe(1);
    expect(await row()).toMatchObject({ latitude: 10.123456, longitude: -20.987654, name: 'kept' });
  });

  test('matching coordinates → no write, updated_at untouched', async () => {
    await sql.unsafe(`INSERT INTO weather_stations (station_id, owner_address, latitude, longitude) VALUES ('S', $1, 10.123456, -20.987654)`, [OWNER]);
    const r = await pool.query(OVERWRITE_COORDINATES_SQL, ['S', 10.123456, -20.987654, OWNER]);
    expect(r.count).toBe(0);
    expect(new Date((await row()).updated_at).getUTCFullYear()).toBe(2000);
  });

  test('different owner → never touched', async () => {
    await sql.unsafe(`INSERT INTO weather_stations (station_id, owner_address, latitude, longitude) VALUES ('S', $1, 1.5, 2.5)`, [OTHER]);
    const r = await pool.query(OVERWRITE_COORDINATES_SQL, ['S', 10.123456, -20.987654, OWNER]);
    expect(r.count).toBe(0);
    expect(await row()).toMatchObject({ owner_address: OTHER, latitude: 1.5, longitude: 2.5 });
  });

  test('end to end through runStationSyncOnce: other-owner row untouched, own row synced', async () => {
    await sql.unsafe(`INSERT INTO weather_stations (station_id, owner_address, latitude, longitude) VALUES ('PWS-EXAMPLE-WS5000', $1, 1.5, 2.5), ('PWS-EXAMPLE-PRIVATE-01', $2, 3.5, 4.5)`, [OWNER, OTHER]);
    const res = await runStationSyncOnce({
      listStations: async () => [entry('PWS-EXAMPLE-WS5000'), entry('PWS-EXAMPLE-PRIVATE-01', { latitude: 30.5, longitude: -40.5 })],
      labels: LABELS,
      pool,
    });
    expect(res).toMatchObject({ coordinatesUpdated: 1, refused: 1 });
    const rows = await sql.unsafe(`SELECT station_id, latitude, longitude FROM weather_stations ORDER BY station_id`);
    expect(rows.map((r: any) => [r.station_id, r.latitude, r.longitude])).toEqual([
      ['PWS-EXAMPLE-PRIVATE-01', 3.5, 4.5],
      ['PWS-EXAMPLE-WS5000', 10.1, -21],
    ]);
  });
});

// #1254 review round 62: the whole list (every page envelope, pagination
// field types, every entry) is validated before ANY database access.
describe('round 62: station-list validation, zero writes on a malformed list', () => {
  function pages(bodies: unknown[]) {
    let i = 0;
    return (async () => {
      const body = bodies[Math.min(i++, bodies.length - 1)];
      return { status: 200, ok: true, json: async () => body };
    }) as unknown as typeof fetch;
  }
  function countingPool() {
    const t = tablePool();
    let calls = 0;
    const pool: BackfillPool = { query: async (sql, params) => { calls += 1; return t.pool.query(sql, params); } };
    return { pool, rows: t.rows, calls: () => calls };
  }
  const good = (id: string) => entry(id);

  test.each([
    ['has_more missing', [{ stations: [good('A')] }], /has_more is missing or not a boolean/],
    ['has_more "true" (string)', [{ stations: [good('A')], has_more: 'true', next_cursor: 'A' }], /has_more is missing or not a boolean/],
    ['has_more without cursor', [{ stations: [good('A')], has_more: true }], /has_more without a string next_cursor/],
    ['next_cursor not a string', [{ stations: [good('A')], has_more: false, next_cursor: 5 }], /next_cursor is not a string/],
    ['null entry among valid ones', [{ stations: [good('A'), null, good('B')], has_more: false }], /an entry is not an object/],
    ['latitude as a string', [{ stations: [{ ...good('A'), latitude: '10.1' }], has_more: false }], /invalid latitude/],
    ['is_active as a string', [{ stations: [{ ...good('A'), is_active: 'true' }], has_more: false }], /non-boolean is_active/],
    // Owner FORMAT is a per-station refusal (Opus review); a MISSING owner is structural.
    ['missing owner', [{ stations: [{ ...good('A'), owner_address: undefined }], has_more: false }], /invalid owner_address/],
    ['page is an array', [[good('A')]], /the page is not an object/],
    ['duplicate id across pages', [
      { stations: [good('A'), good('B')], has_more: true, next_cursor: 'B' },
      { stations: [good('B')], has_more: false, next_cursor: null },
    ], /appears twice/],
    ['malformed LATER page', [
      { stations: [good('A'), good('B')], has_more: true, next_cursor: 'B' },
      { stations: [good('C'), { station_id: 'D' }], has_more: false },
    ], /node station list rejected/],
  ])('%s → rejected with a fixed diagnostic and ZERO database calls', async (_l, bodies, reason) => {
    const { pool, rows, calls } = countingPool();
    await expect(
      runStationSyncOnce({
        listStations: () => fetchChainStationList('http://n', 't', pages(bodies as unknown[])),
        labels: { A: { name: 'a' }, B: { name: 'b' }, C: { name: 'c' }, D: { name: 'd' } },
        pool,
      })
    ).rejects.toThrow(reason);
    expect(calls()).toBe(0);
    expect(rows.size).toBe(0);
  });

  test('an injected list (not via fetch) is validated too: mixed list → zero DB calls', async () => {
    const { pool, calls } = countingPool();
    await expect(
      runStationSyncOnce({ listStations: async () => [good('A'), null as any], labels: { A: { name: 'a' } }, pool })
    ).rejects.toThrow(/an entry is not an object/);
    expect(calls()).toBe(0);
  });

  test('control: well-formed inactive/synthetic entries still pass validation and get per-station refusals', async () => {
    const { pool, rows } = countingPool();
    const res = await runStationSyncOnce({
      listStations: () => fetchChainStationList('http://n', 't', pages([
        { stations: [good('A'), { ...good('B'), is_active: false }], has_more: true, next_cursor: 'B' },
        { stations: [{ ...good('C'), provenance_class: 'synthetic' }], has_more: false, next_cursor: null },
      ])),
      labels: { A: { name: 'a' }, B: { name: 'b' }, C: { name: 'c' } },
      pool,
    });
    expect(res).toMatchObject({ chainStations: 3, inserted: 1, refused: 2 });
    expect(res.refusedIds.sort()).toEqual(['B', 'C']);
    expect([...rows.keys()]).toEqual(['A']);
  });

  test('a rejected pass logs only the fixed diagnostic', async () => {
    const warns: string[] = [];
    const logger = { info: () => {}, warn: (m: string, meta?: Record<string, unknown>) => warns.push(`${m} ${JSON.stringify(meta ?? {})}`) };
    const { pool, calls } = countingPool();
    await startChainStationSync({
      env: { STATION_CHAIN_SYNC_ENABLED: 'true', CORE4_API_URL: 'http://n', WRFCOIN_OPERATOR_TOKEN: 't', STATION_CHAIN_SYNC_LABELS: JSON.stringify(LABELS) },
      pool, logger,
      fetchImpl: pages([{ stations: [good('PWS-EXAMPLE-WS5000'), { station_id: 'x', latitude: 10.123456 }], has_more: false }]),
      setIntervalImpl: ((fn: () => void) => setInterval(fn, 1e9)) as unknown as typeof setInterval,
    });
    await stopChainStationSync();
    expect(warns.join('\n')).toContain('node station list rejected: an entry has an invalid owner_address');
    expect(warns.join('\n')).not.toContain('10.12');
    expect(calls()).toBe(0);
  });
});

(process.env.BACKFILL_TEST_PG_URL ? describe : describe.skip)('round 62 on real PostgreSQL: malformed later page = zero mutations', () => {
  const schema = `sync_r62_${process.pid}`;
  let sql: ReturnType<typeof postgres>;
  let pool: BackfillPool;
  beforeAll(async () => {
    sql = postgres(process.env.BACKFILL_TEST_PG_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe(`CREATE TABLE weather_stations (
      station_id text NOT NULL UNIQUE, owner_address text NOT NULL, location text NOT NULL,
      name text, latitude double precision, longitude double precision, metadata jsonb,
      station_type text, is_active boolean NOT NULL DEFAULT true, updated_at timestamp NOT NULL DEFAULT now())`);
    pool = { query: async (text, params = []) => { const r = await sql.unsafe(text, params as any[]); return { rows: Array.from(r), count: r.count }; } };
  });
  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  const fetchPages = (bodies: unknown[]) => {
    let i = 0;
    return (async () => ({ status: 200, ok: true, json: async () => bodies[Math.min(i++, bodies.length - 1)] })) as unknown as typeof fetch;
  };

  test('page 1 valid + page 2 malformed → rejected, table still empty; control inserts', async () => {
    const labels = { 'PWS-EXAMPLE-WS5000': { name: 'Example Station' }, 'PWS-EXAMPLE-PRIVATE-01': { name: 'Example private station' } };
    await expect(runStationSyncOnce({
      listStations: () => fetchChainStationList('http://n', 't', fetchPages([
        { stations: [entry('PWS-EXAMPLE-WS5000')], has_more: true, next_cursor: 'PWS-EXAMPLE-WS5000' },
        { stations: [entry('PWS-EXAMPLE-PRIVATE-01'), null], has_more: false },
      ])),
      labels,
      pool,
    })).rejects.toThrow(/node station list rejected/);
    expect((await sql.unsafe('SELECT count(*)::int AS n FROM weather_stations'))[0].n).toBe(0);

    const ok = await runStationSyncOnce({
      listStations: () => fetchChainStationList('http://n', 't', fetchPages([
        { stations: [entry('PWS-EXAMPLE-WS5000')], has_more: true, next_cursor: 'PWS-EXAMPLE-WS5000' },
        { stations: [entry('PWS-EXAMPLE-PRIVATE-01')], has_more: false, next_cursor: null },
      ])),
      labels,
      pool,
    });
    expect(ok.inserted).toBe(2);
    expect((await sql.unsafe('SELECT count(*)::int AS n FROM weather_stations'))[0].n).toBe(2);
  });
});

// #1254 Opus review: the whole-list validator must not reject chain-VALID
// entries. Owner format and a backend-unsupported id are PER-STATION refusals
// (as in #1251); only true structural faults reject the whole list.
describe('chain-valid entries never freeze the sync (Opus review)', () => {
  const WRF_OWNER = 'wrf' + 'a1'.repeat(20);
  const listOf = (bodies: unknown[]) => {
    let i = 0;
    return (async () => ({ status: 200, ok: true, json: async () => bodies[Math.min(i++, bodies.length - 1)] })) as unknown as typeof fetch;
  };

  test.each([
    ['a wrf-owned station', entry('PWS-WRF-OWNED-01', { owner_address: WRF_OWNER }), 'PWS-WRF-OWNED-01'],
    ["an id with '/'", entry('PWS/SLASH-01'), '<invalid>'],
    ['a non-ASCII id', entry('PWS-MÜNCHEN-01'), '<invalid>'],
  ])('valid Duluth + %s → Duluth inserted, the other refused per station', async (_l, other, refusedLabel) => {
    const { pool, rows } = tablePool();
    const labels = { ...LABELS, [other.station_id]: { name: 'Other weather station' } };
    const res = await runStationSyncOnce({
      listStations: () => fetchChainStationList('http://n', 't', listOf([
        { stations: [entry('PWS-EXAMPLE-WS5000'), other], has_more: false, next_cursor: null },
      ])),
      labels,
      pool,
    });
    expect(res.inserted).toBe(1);
    expect(rows.has('PWS-EXAMPLE-WS5000')).toBe(true);
    expect(rows.has(other.station_id)).toBe(false);
    expect(res.refused).toBe(1);
    expect(res.refusedIds).toEqual([refusedLabel]);
  });

  test.each([
    ['whitespace in the id', entry('PWS BAD 01')],
    ['an empty id', entry('')],
    ['an id over 128 bytes', entry('Ü'.repeat(65))],
    ['a non-string owner', entry('PWS-X', { owner_address: 42 as any })],
  ])('structural fault (%s) still rejects the whole list', async (_l, bad) => {
    const { pool, rows } = tablePool();
    await expect(runStationSyncOnce({
      listStations: () => fetchChainStationList('http://n', 't', listOf([
        { stations: [entry('PWS-EXAMPLE-WS5000'), bad], has_more: false },
      ])),
      labels: LABELS,
      pool,
    })).rejects.toThrow(/node station list rejected/);
    expect(rows.size).toBe(0);
  });
});

// #1254 review P3: the id-whitespace rule must be Rust's char::is_whitespace
// (Unicode White_Space), not JS \s. U+FEFF and U+200B are NOT whitespace in
// Rust, so an id containing them is on-chain valid and must not reject the
// whole list; U+0085 IS whitespace in Rust (and not in JS \s).
describe('station-id whitespace matches Rust char::is_whitespace', () => {
  const listOf = (bodies: unknown[]) => {
    let i = 0;
    return (async () => ({ status: 200, ok: true, json: async () => bodies[Math.min(i++, bodies.length - 1)] })) as unknown as typeof fetch;
  };

  test.each([
    ['U+FEFF (BOM)', 'PWS-﻿-01'],
    ['U+200B (zero-width space)', 'PWS-​-01'],
  ])('an id with %s is chain-valid: the list is accepted, Duluth still syncs', async (_l, id) => {
    const { pool, rows } = tablePool();
    const res = await runStationSyncOnce({
      listStations: () => fetchChainStationList('http://n', 't', listOf([
        { stations: [entry('PWS-EXAMPLE-WS5000'), entry(id)], has_more: false, next_cursor: null },
      ])),
      labels: { ...LABELS, [id]: { name: 'Other weather station' } },
      pool,
    });
    expect(res.inserted).toBe(1);
    expect(rows.has('PWS-EXAMPLE-WS5000')).toBe(true);
    // The backend's own id charset refuses it per station, never the whole list.
    expect(res.refused).toBe(1);
  });

  test.each([
    ['U+0085 (NEL)', 'PWS-\u0085-01'],
    ['U+3000 (ideographic space)', 'PWS-　-01'],
    ['U+00A0 (no-break space)', 'PWS- -01'],
  ])('an id with %s is Rust whitespace: structural, whole list rejected', async (_l, id) => {
    const { pool, rows } = tablePool();
    await expect(runStationSyncOnce({
      listStations: () => fetchChainStationList('http://n', 't', listOf([
        { stations: [entry('PWS-EXAMPLE-WS5000'), entry(id)], has_more: false },
      ])),
      labels: LABELS,
      pool,
    })).rejects.toThrow(/invalid station_id/);
    expect(rows.size).toBe(0);
  });
});
