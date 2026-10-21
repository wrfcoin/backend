/**
 * backend#1236: with NODE_ENV=production a backend entry must REFUSE TO START
 * (non-zero exit) on an empty, loopback or wildcard CORS_ORIGIN instead of
 * falling back to a built-in localhost allowlist, and must start normally on
 * an explicit public origin. Spawns the real entrypoints (same spawn shape as
 * db-startup-survival: `node --import tsx`, dead DB/Redis/core4 ports).
 */
import { spawn, type ChildProcess } from 'child_process';
import * as crypto from 'crypto';
import * as net from 'net';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const MAIN_ENTRY = path.join(ROOT, 'server/enhanced_unified_api_optimized.ts');
const DISCOVERY_ENTRY = path.join(ROOT, 'server/easy_node_discovery.js');
const PUBLIC_ORIGIN = 'https://wrfcoin-testnet.taila1c049.ts.net';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('could not obtain free port')));
        return;
      }
      const { port } = addr;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

function baseEnv(port: number, corsOrigin: string | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    PORT: String(port),
    NODE_DISCOVERY_PORT: String(port),
    DATABASE_URL: 'postgresql://localhost:59999/nonexistent',
    REDIS_URL: 'redis://localhost:59999',
    JWT_SECRET: crypto.randomBytes(64).toString('hex'),
    WRFCOIN_OPERATOR_TOKEN: 'test-operator-token-1236',
    WRFCOIN_CORE4_URL: 'http://127.0.0.1:59998',
    WRFCOIN_WALLET_AUTH_ORIGIN: PUBLIC_ORIGIN,
    DISABLE_FILE_LOG_TRANSPORTS: 'true',
    LOG_LEVEL: 'warn',
  };
  delete env.CORS_ORIGIN;
  delete env.ALLOWED_ORIGINS;
  delete env.CORS_ALLOWED_ORIGINS;
  delete env.CORS_ORIGINS;
  delete env.JEST_WORKER_ID;
  if (corsOrigin !== undefined) env.CORS_ORIGIN = corsOrigin;
  return env;
}

interface Boot {
  child: ChildProcess;
  output: () => string;
  exit: Promise<number | null>;
}

function boot(entry: string, env: NodeJS.ProcessEnv): Boot {
  const child = spawn(process.execPath, ['--import', 'tsx', entry], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  child.stderr?.on('data', (chunk: Buffer) => { out += chunk.toString(); });
  const exit = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)));
  return { child, output: () => out, exit };
}

async function stop(b: Boot): Promise<void> {
  if (b.child.exitCode !== null || b.child.signalCode !== null) return;
  b.child.kill('SIGTERM');
  const graceful = await Promise.race([
    b.exit.then(() => true),
    new Promise<boolean>(resolve => setTimeout(() => resolve(false), 3_000).unref()),
  ]);
  if (!graceful) {
    b.child.kill('SIGKILL');
    await b.exit;
  }
}

async function waitForHttp(url: string, b: Boot, timeoutMs = 30_000): Promise<Response> {
  const start = Date.now();
  for (;;) {
    if (b.child.exitCode !== null) {
      throw new Error(`server exited early (${b.child.exitCode}):\n${b.output().slice(-2000)}`);
    }
    try {
      return await fetch(url, { headers: { Origin: PUBLIC_ORIGIN } });
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`no HTTP answer within ${timeoutMs}ms`);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
  }
}

describe('production CORS fail-closed at real startup (backend#1236)', () => {
  const running: Boot[] = [];
  afterEach(async () => {
    await Promise.all(running.splice(0).map(stop));
  });

  it.each([
    ['main API, CORS_ORIGIN unset', MAIN_ENTRY, undefined],
    ['main API, CORS_ORIGIN empty', MAIN_ENTRY, ''],
    ['main API, CORS_ORIGIN loopback', MAIN_ENTRY, 'http://localhost:5000'],
    ['main API, CORS_ORIGIN wildcard', MAIN_ENTRY, '*'],
    // codex round 9 bypasses of the first version of the check:
    ['main API, trailing-dot localhost', MAIN_ENTRY, 'http://localhost.:5000'],
    ['main API, trailing-dot *.localhost', MAIN_ENTRY, 'https://foo.localhost.'],
    ['main API, IPv4-mapped IPv6 loopback', MAIN_ENTRY, 'http://[::ffff:7f00:1]:5000'],
    ['main API, wildcard host', MAIN_ENTRY, 'https://*.example.org'],
    ['node-discovery, CORS_ORIGIN empty', DISCOVERY_ENTRY, ''],
  ])('%s: refuses to start with a non-zero exit', async (_label, entry, corsOrigin) => {
    const port = await getFreePort();
    const b = boot(entry, baseEnv(port, corsOrigin));
    running.push(b);

    const code = await Promise.race([
      b.exit,
      new Promise<'timeout'>(resolve => setTimeout(() => resolve('timeout'), 45_000).unref()),
    ]);

    expect(code).toBe(1);
    expect(b.output()).toMatch(/FATAL \[CORS\] Refusing to start with NODE_ENV=production/);
  }, 60_000);

  it('main API with an explicit public origin starts and serves that origin only', async () => {
    const port = await getFreePort();
    const b = boot(MAIN_ENTRY, baseEnv(port, PUBLIC_ORIGIN));
    running.push(b);

    const res = await waitForHttp(`http://127.0.0.1:${port}/health`, b);
    // Dead DB/core4 → 503, but the process is up and answering.
    expect([200, 503]).toContain(res.status);
    expect(res.headers.get('access-control-allow-origin')).toBe(PUBLIC_ORIGIN);

    const loopback = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { Origin: 'http://localhost:5000' },
    });
    expect(loopback.headers.get('access-control-allow-origin') || '').toBe('');
    expect(b.output()).not.toMatch(/FATAL \[CORS\]/);
  }, 60_000);
});
