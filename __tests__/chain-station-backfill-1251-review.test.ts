/**
 * backend#1251 codex review (round 46):
 *  P1 — a coordinate fill must fill ONLY the NULL column(s), never replace a
 *       coordinate already present (including one written between plan and
 *       apply). Proven against real PostgreSQL when BACKFILL_TEST_PG_URL is set.
 *  P2 — no output path may echo coordinates: parse, node and DB failures are
 *       reported with fixed, content-free diagnostics. Proven through the real
 *       CLI (stdout/stderr) against a loopback fake node.
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import {
  applyBackfill,
  nodeRegistrationFetcher,
  planBackfill,
  type BackfillPool,
  type FetchChainRegistration,
} from '../server/services/chain-station-backfill.js';

const OWNER = '0x7d29a4fb00000000000000000000000000000001';
const SECRET_LAT = 10.123456;
const SECRET_LON = -20.987654;
const LEAK_MARKERS = ['10.123456', '20.987654', '12.345678', '10.12', '20.98'];

function expectNoLeak(text: string): void {
  for (const marker of LEAK_MARKERS) expect(text).not.toContain(marker);
  expect(text).not.toContain(OWNER);
}

const INPUT = { stationId: 'PWS-TEST-A', name: 'Test weather station', latitude: SECRET_LAT, longitude: SECRET_LON };

const chainOk: FetchChainRegistration = async (id) => ({
  station_id: id,
  owner_address: OWNER,
  provenance_class: 'real',
  is_active: true,
});

describe('#1251 review P2: plan reasons never echo raw error or response text', () => {
  const emptyPool: BackfillPool = { query: async () => ({ rows: [] }) };

  test('a thrown non-diagnostic error is withheld', async () => {
    const plan = await planBackfill(
      [INPUT],
      async () => {
        throw new Error(`socket said ${SECRET_LAT},${SECRET_LON}`);
      },
      emptyPool
    );
    expect(plan[0].action).toBe('refuse');
    expect(plan[0].reason).toBe('chain registration unreadable: network or response error (details withheld)');
  });

  test('an unrecognized provenance string is not echoed', async () => {
    const plan = await planBackfill(
      [INPUT],
      async (id) => ({ station_id: id, owner_address: OWNER, provenance_class: `x${SECRET_LAT}`, is_active: true }),
      emptyPool
    );
    expect(plan[0].reason).toBe('chain provenance_class is <unrecognized>, not "real"');
  });

  test('an invalid stationId is labelled <invalid>, not echoed', async () => {
    const plan = await planBackfill([{ ...INPUT, stationId: `${SECRET_LAT} ${SECRET_LON}` }], chainOk, emptyPool);
    expect(plan[0].stationId).toBe('<invalid>');
    expectNoLeak(JSON.stringify(plan));
  });

  test('a non-JSON node body becomes a fixed diagnostic', async () => {
    const fetchImpl = (async () => ({
      status: 200,
      ok: true,
      json: async () => JSON.parse(`not json ${SECRET_LAT}`),
    })) as unknown as typeof fetch;
    const plan = await planBackfill([INPUT], nodeRegistrationFetcher('http://n', 't', fetchImpl), emptyPool);
    expect(plan[0].reason).toBe('chain registration unreadable: node response is not valid JSON');
  });
});

// ---------------------------------------------------------------------------
// Real CLI, real stdout/stderr, loopback fake node.
// ---------------------------------------------------------------------------

const BACKEND_ROOT = resolve(__dirname, '..');
const TSX = join(BACKEND_ROOT, 'node_modules', '.bin', 'tsx');
const CLI = join(BACKEND_ROOT, 'scripts', 'backfill-chain-stations.ts');

function runCli(args: string[], env: Record<string, string>): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    const child = spawn(TSX, [CLI, ...args], {
      cwd: BACKEND_ROOT,
      env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolveRun({ code, stdout, stderr }));
  });
}

describe('#1251 review P2: CLI output is content-free on failure', () => {
  let dir: string;
  let server: Server;
  let nodeUrl: string;
  let mode: 'garbage' | 'http500' | 'ok' = 'ok';

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'backfill-1251-'));
    server = createServer((_req, res) => {
      if (mode === 'http500') {
        res.writeHead(500);
        res.end(`upstream exploded near ${SECRET_LAT}`);
        return;
      }
      if (mode === 'garbage') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`{"station_id": ${SECRET_LAT}, oops`);
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ station_id: 'PWS-TEST-A', owner_address: OWNER, provenance_class: 'real', is_active: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const addr = server.address() as { port: number };
    nodeUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  function env(): Record<string, string> {
    // Port 9 (discard) on loopback: nothing listens, so any DB use fails fast.
    return { DATABASE_URL: 'postgresql://u:p@127.0.0.1:9/none', CORE4_API_URL: nodeUrl, WRFCOIN_OPERATOR_TOKEN: 'tok' };
  }

  test('malformed input JSON: fixed message, exit 1, fixture coordinate not echoed', async () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '[{"stationId":"PWS-TEST-A","latitude": x12.345678}]');
    const out = await runCli(['--input', file], env());
    expect(out.code).toBe(1);
    expect(out.stderr.trim()).toBe('input file is not valid JSON');
    expectNoLeak(out.stdout + out.stderr);
  }, 60_000);

  test('malformed node response: fixed diagnostic, refused (exit 2), nothing echoed', async () => {
    mode = 'garbage';
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify([INPUT]));
    const out = await runCli(['--input', file], env());
    expect(out.code).toBe(2);
    expect(out.stdout).toContain('chain registration unreadable: node response is not valid JSON');
    expectNoLeak(out.stdout + out.stderr);
  }, 60_000);

  test('node HTTP error: status only, refused (exit 2), body not echoed', async () => {
    mode = 'http500';
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify([INPUT]));
    const out = await runCli(['--input', file], env());
    expect(out.code).toBe(2);
    expect(out.stdout).toContain('chain registration unreadable: node answered HTTP 500');
    expectNoLeak(out.stdout + out.stderr);
  }, 60_000);

  test('database failure: category + code only, exit 1, nothing echoed', async () => {
    mode = 'ok';
    const file = join(dir, 'in.json');
    writeFileSync(file, JSON.stringify([INPUT]));
    const out = await runCli(['--input', file, '--apply'], env());
    expect(out.code).toBe(1);
    expect(out.stderr).toMatch(/^backfill failed: database or node error( \([A-Z0-9_]+\))? \(details withheld\)$/m);
    expectNoLeak(out.stdout + out.stderr);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// Real PostgreSQL (#1251 review P1). Runs when BACKFILL_TEST_PG_URL points at a
// disposable database; creates and drops its own schema.
// ---------------------------------------------------------------------------

const PG_URL = process.env.BACKFILL_TEST_PG_URL;
// CI sets BACKFILL_REQUIRE_PG=1 next to the URL: losing the URL there must be
// a failure, not a silent skip (a skipped real-PG gate is vacuous green).
if (process.env.BACKFILL_REQUIRE_PG === '1' && !PG_URL) {
  throw new Error('BACKFILL_REQUIRE_PG=1 but BACKFILL_TEST_PG_URL is not set');
}
const describePg = PG_URL ? describe : describe.skip;

describePg('#1251 review P1: coordinate fill against real PostgreSQL', () => {
  const schema = `backfill_1251_${process.pid}`;
  let sql: ReturnType<typeof postgres>;
  let pool: BackfillPool;

  beforeAll(async () => {
    sql = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    // Same columns/constraints as the live weather_stations (pg_dump --schema-only).
    await sql.unsafe(`CREATE TABLE weather_stations (
      id serial PRIMARY KEY,
      station_id text NOT NULL UNIQUE,
      owner_address text NOT NULL,
      location text NOT NULL,
      is_active boolean DEFAULT true NOT NULL,
      quality_score integer DEFAULT 100 NOT NULL,
      created_at timestamp DEFAULT now() NOT NULL,
      updated_at timestamp DEFAULT now() NOT NULL,
      last_reward_time timestamp,
      total_rewards text DEFAULT '0',
      metadata jsonb,
      latitude double precision,
      longitude double precision,
      name text,
      station_type text,
      submit_token_hash text)`);
    pool = {
      query: async (text, params = []) => {
        const rows = await sql.unsafe(text, params as any[]);
        return { rows: Array.from(rows), count: rows.count };
      },
    };
  });

  afterAll(async () => {
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  beforeEach(async () => {
    await sql.unsafe('TRUNCATE weather_stations');
  });

  async function seed(lat: number | null, lon: number | null): Promise<void> {
    await sql.unsafe(
      `INSERT INTO weather_stations (station_id, owner_address, location, latitude, longitude) VALUES ($1, $2, 'x', $3, $4)`,
      ['PWS-TEST-A', OWNER, lat, lon] as any[]
    );
  }

  async function coords(): Promise<{ latitude: number | null; longitude: number | null }> {
    const [row] = await sql.unsafe(`SELECT latitude, longitude FROM weather_stations WHERE station_id = 'PWS-TEST-A'`);
    return { latitude: row.latitude, longitude: row.longitude };
  }

  test('latitude present, longitude NULL: latitude kept, longitude filled', async () => {
    await seed(77.123456, null);
    const plan = await planBackfill([INPUT], chainOk, pool);
    expect(plan[0].action).toBe('fill-coordinates');
    const [res] = await applyBackfill(plan, pool);
    expect(res.written).toBe(true);
    expect(await coords()).toEqual({ latitude: 77.123456, longitude: -21 }); // the kept value is untouched; the fill is on the grid
  });

  test('longitude present, latitude NULL: longitude kept, latitude filled', async () => {
    await seed(null, 12.5);
    const plan = await planBackfill([INPUT], chainOk, pool);
    await applyBackfill(plan, pool);
    expect(await coords()).toEqual({ latitude: 10.1, longitude: 12.5 });
  });

  test('a coordinate written between plan and apply is not replaced', async () => {
    await seed(null, null);
    const plan = await planBackfill([INPUT], chainOk, pool);
    expect(plan[0].action).toBe('fill-coordinates');
    // Concurrent writer (e.g. self-service registration) sets latitude first.
    await sql.unsafe(`UPDATE weather_stations SET latitude = 10.25 WHERE station_id = 'PWS-TEST-A'`);
    const [res] = await applyBackfill(plan, pool);
    expect(res.written).toBe(true);
    expect(await coords()).toEqual({ latitude: 10.25, longitude: -21 });
  });

  test('both coordinates written between plan and apply: no write at all', async () => {
    await seed(null, null);
    const plan = await planBackfill([INPUT], chainOk, pool);
    await sql.unsafe(`UPDATE weather_stations SET latitude = 1.5, longitude = 2.5 WHERE station_id = 'PWS-TEST-A'`);
    const [res] = await applyBackfill(plan, pool);
    expect(res.written).toBe(false);
    expect(await coords()).toEqual({ latitude: 1.5, longitude: 2.5 });
  });

  test('insert path stores a jsonb object and is idempotent', async () => {
    const plan = await planBackfill([INPUT], chainOk, pool);
    expect(plan[0].action).toBe('insert');
    await applyBackfill(plan, pool);
    const [row] = await sql.unsafe(`SELECT jsonb_typeof(metadata) AS t FROM weather_stations`);
    expect(row.t).toBe('object');
    const again = await planBackfill([INPUT], chainOk, pool);
    expect(again[0].action).toBe('noop');
  });
});
