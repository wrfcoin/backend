/**
 * Shared harness for the anonymous-GET exposure audit (backend H11): boots the LIVE
 * entrypoint (`node --import tsx server/enhanced_unified_api_optimized.ts`) as a
 * subprocess with a preload that dumps every GET route of the express app, then probes
 * routes over loopback (never a real host). Test support only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const CORE4_TEST_URL = 'http://127.0.0.1:59998';
const root = path.resolve(__dirname, '../..');
const entry = path.join(root, 'server/enhanced_unified_api_optimized.ts');
const tsxLoader = pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href;
const preload = path.join(root, '__tests__/fixtures/route-inventory-preload.cjs');
// NOAA answers from canned data (no external request); see the file.
const noaaStub = path.join(root, '__tests__/fixtures/noaa-stub-preload.cjs');

export interface InventoryEntry { kind: 'get' | 'all' | 'use' | 'unsupported'; path: string; handler?: string }
export interface Booted {
  port: number;
  inventory: InventoryEntry[];
  output: () => string;
  stop: () => Promise<void>;
  get: (urlPath: string, headers?: Record<string, string>) => Promise<{ status: number; body: string }>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

const LEGACY_CORE4_VARS = ['BLOCKCHAIN_NODE_URL', 'BLOCKCHAIN_SERVICE_URL', 'RUST_BLOCKCHAIN_URL'];

/**
 * The environment of the entrypoint subprocess. core4 is pointed at a dead loopback port through
 * CORE4_API_URL, the variable shared/core4-route-client.js actually reads (WRFCOIN_CORE4_URL is
 * ignored by it), and every legacy alias is blanked so no inherited value can select a real host.
 */
export function entrypointEnv(port: number, databaseUrl: string, invFile: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PORT: String(port),
    DATABASE_URL: databaseUrl,
    REDIS_URL: 'redis://127.0.0.1:59999',
    NODE_ENV: 'test',
    JWT_SECRET: 'test-jwt-secret-for-h11-inventory-0123456789',
    ENCRYPTION_KEY: 'h11-inventory-encryption-key-0123456789abcdef',
    WRFCOIN_OPERATOR_TOKEN: 'test-operator-h11-0123456789abcdef',
    WRFCOIN_READER_TOKEN: 'test-reader-h11-0123456789abcdef',
    ADMIN_TOKEN: 'test-admin-h11-0123456789abcdef',
    IOT_GATEWAY_ADMIN_TOKEN: 'test-iot-admin-h11-0123456789abcdef',
    RPC_API_KEY: 'test-rpc-h11-0123456789abcdef',
    CORE4_API_URL: CORE4_TEST_URL,
    ...Object.fromEntries(LEGACY_CORE4_VARS.map((name) => [name, ''])),
    LOG_LEVEL: 'error',
    DISABLE_FILE_LOG_TRANSPORTS: 'true', // no logs/ directory written into the repo
    WRFCOIN_ROUTE_INVENTORY_FILE: invFile,
    WRFCOIN_TEST_NOAA_STUB: '1',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`, `--require=${noaaStub}`].filter(Boolean).join(' '),
  };
}

export async function bootLiveEntrypoint(databaseUrl: string, testEnv: Record<string, string> = {}): Promise<Booted> {
  const port = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h11-inventory-'));
  const invFile = path.join(dir, 'inventory.json');
  let out = '';
  const child: ChildProcess = spawn(process.execPath, ['--import', tsxLoader, entry], {
    cwd: root,
    env: { ...entrypointEnv(port, databaseUrl, invFile), ...testEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (c: Buffer) => { out = (out + c.toString()).slice(-20000); });
  child.stderr?.on('data', (c: Buffer) => { out = (out + c.toString()).slice(-20000); });

  const started = Date.now();
  while (!fs.existsSync(invFile)) {
    if (child.exitCode !== null) throw new Error(`entrypoint exited early (${child.exitCode})\n${out}`);
    if (Date.now() - started > 90_000) { child.kill('SIGKILL'); throw new Error(`no route inventory within 90s\n${out}`); }
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 500));
  const inventory = JSON.parse(fs.readFileSync(invFile, 'utf8')) as InventoryEntry[];

  let n = 0;
  const get = async (urlPath: string, extraHeaders: Record<string, string> = {}) => {
    // A distinct client per request: the loopback peer is a trusted proxy, so the
    // per-IP limiters must not turn later probes into 429 and hide their auth answer.
    const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
      signal: AbortSignal.timeout(8000),
      headers: { 'x-forwarded-for': `198.51.100.${1 + (n++ % 250)}`, ...extraHeaders },
    });
    return { status: res.status, body: await res.text() };
  };
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((r) => { const t = setTimeout(() => { child.kill('SIGKILL'); r(null); }, 8000); child.once('exit', () => { clearTimeout(t); r(null); }); });
    }
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { port, inventory, output: () => out, stop, get };
}

/** The GET route templates of the inventory (`use` mounts and unsupported shapes excluded; see unsupportedRoutes). */
export function getRouteTemplates(inventory: InventoryEntry[]): string[] {
  return [...new Set(inventory.filter((e) => e.kind === 'get' || e.kind === 'all').map((e) => e.path))].sort();
}

/** Mount or route shapes the walker could not represent faithfully: the ratchet fails on any. */
export function unsupportedRoutes(inventory: InventoryEntry[]): string[] {
  return inventory.filter((e) => e.kind === 'unsupported').map((e) => e.path).sort();
}

/** GET paths handled by the inline handler in the entrypoint (outside the express router stack). */
export function inlineGetTemplates(): string[] {
  const src = fs.readFileSync(entry, 'utf8');
  const out = new Set<string>();
  for (const m of src.matchAll(/path === '([^']+)'(\s*&& req\.method === '([A-Z]+)')?/g)) {
    if (m[3] && m[3] !== 'GET') continue;
    out.add(`inline:${m[1]}`);
  }
  for (const m of src.matchAll(/path\.startsWith\('([^']+)'\)/g)) out.add(`inline:${m[1]}*`);
  return [...out].sort();
}

export function concreteUrl(template: string, fill: (paramName: string) => string): string {
  return template
    .replace(/^inline:/, '')
    .replace(/:([A-Za-z0-9_]+)/g, (_m, name) => fill(name))
    .replace(/\*/g, fill('*'));
}

/**
 * Coverage check for a probing loop: every expected probe URL must have produced an HTTP answer.
 * Returns the URLs that did not (transport failure or never attempted), so a route that silently
 * became unreachable cannot leave an audit green.
 */
export function coverageProblems(expected: string[], answered: string[]): string[] {
  const got = new Set(answered);
  return expected.filter((url) => !got.has(url)).sort();
}

export interface Expectation { url: string; status: number; contains: string[] }

/**
 * For the seeded DB-backed routes: the answer must have the expected status AND show the seeded
 * row (public projection), so an HTTP 500, an empty result or a missing row cannot count as
 * "audited". Returns human-readable problems; empty means every expectation held.
 */
export function expectationProblems(expectations: Expectation[], results: Map<string, { status: number; body: string }>): string[] {
  const problems: string[] = [];
  for (const e of expectations) {
    const got = results.get(e.url);
    if (!got) { problems.push(`${e.url}: no answer`); continue; }
    if (got.status !== e.status) { problems.push(`${e.url}: status ${got.status}, expected ${e.status}`); continue; }
    for (const needle of e.contains) if (!got.body.includes(needle)) problems.push(`${e.url}: seeded value ${needle} not in the answer`);
  }
  return problems;
}
