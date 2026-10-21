/**
 * Offline acceptance test: weather-ipfs-archive-worker.ts -> services/weather-ipfs-archive.ts ->
 * StorageProvidersClient -> the REAL storage-providers storage-node -> a REAL (disposable, local) Kubo.
 * Only the database is replaced, by an in-memory `pg` serving SYNTHETIC released weather cells.
 *
 * Runs only when both KUBO_API (e.g. http://127.0.0.1:5101) and STORAGE_NODE_BIN (the built `storage-node`
 * binary) are set; otherwise it is skipped, so the default test run and the default API path stay off.
 * scripts/weather-archive-real-node-e2e.sh starts and removes the disposable Kubo and runs this file.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

const KUBO_API = process.env.KUBO_API;
const NODE_BIN = process.env.STORAGE_NODE_BIN;
const enabled = Boolean(KUBO_API && NODE_BIN);
const suite = enabled ? describe : describe.skip;

const repoRoot = path.resolve(__dirname, '..');
const preload = path.join(__dirname, 'fixtures/weather-archive/fake-pg-preload.mjs');
const DAY = '2026-09-30';
const SCHEMA = 'weather-temperature-daily/v1';
// The synthetic cells of fixtures/weather-archive/fake-pg.mjs, with the suppressed (all-null) cell absent.
const EXPECTED_CELLS = [
  { latE1: 449, lonE1: -933, minC: 12.5, maxC: 21, meanC: 16.5, countBucket: 30 },
  { latE1: 450, lonE1: -933, minC: 11, maxC: 19.5, meanC: 15, countBucket: 20 },
  { latE1: 452, lonE1: -931, minC: 9, maxC: 18, meanC: 13.5, countBucket: 10 },
];

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') { server.close(); reject(new Error('no port')); return; }
      server.close(() => resolve(address.port));
    });
  });
}

async function waitFor(url: string, timeoutMs = 20_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`${url} did not become ready`);
}

function runWorker(env: Record<string, string>, day = DAY) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', preload,
    path.join(repoRoot, 'server/weather-ipfs-archive-worker.ts'), day], {
    cwd: repoRoot, encoding: 'utf8', timeout: 90_000,
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'error', ...env },
  });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

suite('weather archive worker against a real storage node and a real Kubo (synthetic cells)', () => {
  let work: string;
  let node: ChildProcess;
  let nodeUrl: string;
  let archiveDir: string;
  let pgLog: string;
  let baseEnv: Record<string, string>;

  beforeAll(async () => {
    work = fs.mkdtempSync(path.join(os.tmpdir(), 'wrfcoin-archive-e2e-'));
    archiveDir = path.join(work, 'receipts');
    pgLog = path.join(work, 'pg.log');
    const port = await freePort();
    nodeUrl = `http://127.0.0.1:${port}`;
    const config = path.join(work, 'storage-node.toml');
    fs.writeFileSync(config, `bind_addr = "127.0.0.1:${port}"\nstorage_tier = "hot"\ncache_ttl_secs = 60\n\n[provider_endpoints]\nipfs = "${KUBO_API}"\n`);
    node = spawn(NODE_BIN as string, [], { env: { ...process.env, STORAGE_NODE_CONFIG: config, RUST_LOG: 'warn' }, stdio: 'ignore' });
    await waitFor(`${nodeUrl}/health`);
    baseEnv = {
      WRFCOIN_WEATHER_ARCHIVE_ENABLED: 'true', WRFCOIN_WEATHER_ARCHIVE_DIR: archiveDir,
      DATABASE_URL: 'postgresql://127.0.0.1:1/synthetic', WRFCOIN_FAKE_PG_LOG: pgLog, WRFCOIN_STORAGE_NODE_URL: nodeUrl,
    };
  }, 60_000);

  afterAll(() => {
    if (node && node.exitCode === null) node.kill('SIGTERM');
    if (work) fs.rmSync(work, { recursive: true, force: true });
  });

  const expectedBytes = () => Buffer.from(JSON.stringify({ schema: SCHEMA, day: DAY, cells: EXPECTED_CELLS }));
  const kubo = async (route: string, body?: FormData) =>
    fetch(`${KUBO_API}/api/v0/${route}`, { method: 'POST', body });

  it('a first run archives the synthetic day: receipt, CID and bytes agree with Kubo', async () => {
    const run = runWorker(baseEnv);
    expect(run.status).toBe(0);
    const line = JSON.parse(run.stdout.trim().split('\n').filter(l => l.startsWith('{')).pop() as string);
    expect(line).toMatchObject({ day: DAY, status: 'archived' });

    const receipt = JSON.parse(fs.readFileSync(path.join(archiveDir, `${DAY}.json`), 'utf8'));
    const bytes = expectedBytes();
    expect(receipt).toMatchObject({ day: DAY, cid: line.cid, bytes: bytes.length, cellCount: 3 });
    expect(receipt.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));

    // The bytes really are in Kubo under that CID.
    const cat = await kubo(`cat?arg=${line.cid}`);
    expect(cat.status).toBe(200);
    expect(Buffer.from(await cat.arrayBuffer()).equals(bytes)).toBe(true);

    // The CID is the one Kubo itself computes for those bytes (independent of the storage node).
    const form = new FormData();
    form.append('file', new Blob([bytes]));
    const hashed = await kubo('add?only-hash=true&pin=false', form);
    expect((await hashed.json() as { Hash: string }).Hash).toBe(line.cid);
  }, 120_000);

  it('only the suppressed-free cells leave the worker: no contributor or fine location data in the archived bytes', async () => {
    const receipt = JSON.parse(fs.readFileSync(path.join(archiveDir, `${DAY}.json`), 'utf8'));
    const cat = await kubo(`cat?arg=${receipt.cid}`);
    const archived = JSON.parse(Buffer.from(await cat.arrayBuffer()).toString('utf8'));
    expect(Object.keys(archived).sort()).toEqual(['cells', 'day', 'schema']);
    for (const cell of archived.cells) expect(Object.keys(cell).sort()).toEqual(['countBucket', 'latE1', 'lonE1', 'maxC', 'meanC', 'minC']);
    expect(archived.cells).toHaveLength(3);
  }, 60_000);

  it('a second run is idempotent: same receipt, the database is not consulted again', async () => {
    const before = fs.readFileSync(path.join(archiveDir, `${DAY}.json`), 'utf8');
    const queriesBefore = fs.readFileSync(pgLog, 'utf8').trim().split('\n').length;
    const run = runWorker(baseEnv);
    expect(run.status).toBe(0);
    expect(fs.readFileSync(path.join(archiveDir, `${DAY}.json`), 'utf8')).toBe(before);
    expect(fs.readFileSync(pgLog, 'utf8').trim().split('\n').length).toBe(queriesBefore);
  }, 120_000);

  it('the worker only ever reads the released daily table, with the day as its single parameter', () => {
    const queries = fs.readFileSync(pgLog, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) expect(q.parameters).toEqual([DAY]);
  });

  it('an unreachable storage node yields "unavailable", exit 1 and no receipt', () => {
    const other = '2026-09-29';
    const run = runWorker({ ...baseEnv, WRFCOIN_STORAGE_NODE_URL: 'http://127.0.0.1:1' }, other);
    expect(run.status).toBe(1);
    expect(run.stderr + run.stdout).toContain('unavailable');
    expect(fs.existsSync(path.join(archiveDir, `${other}.json`))).toBe(false);
    expect(run.stdout + run.stderr).not.toMatch(/-933|ECONNREFUSED|postgresql:/);
  }, 120_000);

  it('the default path stays off: without the enable flag the worker does nothing', () => {
    const { WRFCOIN_WEATHER_ARCHIVE_ENABLED: _off, ...rest } = baseEnv;
    const run = runWorker(rest, '2026-09-28');
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('"weatherArchive":"disabled"');
    expect(fs.existsSync(path.join(archiveDir, '2026-09-28.json'))).toBe(false);
  }, 60_000);
});
