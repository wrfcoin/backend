/**
 * Proves the backend server starts and serves requests without a live
 * database or Redis (#271).  The server is spawned as a child process
 * with DATABASE_URL / REDIS_URL pointed at ports with nothing listening.
 */

import { spawn, type ChildProcess } from 'child_process';
import * as net from 'net';
import * as path from 'path';

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Return a port the OS guarantees is free right now. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close(() => reject(new Error('could not obtain free port')));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

/** Poll until a TCP connection to `port` succeeds, or throw after `timeoutMs`. */
function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    function attempt() {
      const sock = net.connect({ port, host: '127.0.0.1' });
      sock.once('connect', () => {
        sock.destroy();
        resolve();
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`port ${port} did not open within ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 150);
        }
      });
    }
    attempt();
  });
}

/* ------------------------------------------------------------------ */
/*  Test suite                                                         */
/* ------------------------------------------------------------------ */

describe('server starts and handles requests without a live database (#271)', () => {
  let child: ChildProcess;
  let port: number;
  let baseUrl: string;
  let stderr = '';
  let stdout = '';

  beforeAll(async () => {
    port = await getFreePort();
    baseUrl = `http://127.0.0.1:${port}`;

    const entry = path.resolve(
      __dirname,
      '../server/enhanced_unified_api_optimized.ts',
    );

    // Spawn the server DIRECTLY (node --import tsx), never via `npx tsx`:
    // npx interposes a wrapper process, so afterAll's kill() signalled npx
    // while the real server ran on as an orphan at ~98% CPU (backend#1077).
    // This is the same spawn shape the other server-starting suites use.
    child = spawn(process.execPath, ['--import', 'tsx', entry], {
      cwd: path.resolve(__dirname, '..'),
      env: {
        ...process.env,
        PORT: String(port),
        // Point at ports where nothing is listening
        DATABASE_URL: 'postgresql://localhost:59999/nonexistent',
        REDIS_URL: 'redis://localhost:59999',
        NODE_ENV: 'test',
        // Required by wallet-auth-service
        JWT_SECRET: 'test-jwt-secret-for-startup-survival-271',
        // Required (fail-closed) by the core4 client since the commit-reveal
        // service landed; never used against a live node here — core4 is a
        // dead port too, so /health reports it down alongside the database.
        WRFCOIN_OPERATOR_TOKEN: 'test-operator-token-startup-survival-271',
        WRFCOIN_CORE4_URL: 'http://127.0.0.1:59998',
        // #932 asserts the live entrypoint's detector-and-warn migration stage.
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    // Fail fast if the process crashes before the port opens
    const exitPromise = new Promise<never>((_, reject) => {
      child.once('exit', (code) =>
        reject(new Error(`server exited early with code ${code}\nstderr: ${stderr}`)),
      );
    });

    await Promise.race([waitForPort(port), exitPromise]);
  }, 30_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      // SIGTERM first for a graceful stop; if the server has not exited
      // within 3s (this suite points it at dead DB/Redis ports, so a
      // shutdown path can hang on teardown I/O), escalate to SIGKILL and
      // WAIT for the exit — resolving on a timer without escalation is how
      // the #1077 orphan survived even after the kill target was fixed.
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });
      child.kill('SIGTERM');
      const graceful = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(() => resolve(false), 3_000);
          timer.unref();
        }),
      ]);
      if (!graceful) {
        child.kill('SIGKILL');
        await exited;
      }
    }
  });

  it('server process is still running (did not crash on startup)', () => {
    expect(child.exitCode).toBeNull();
  });

  it('GET /health reports the dead database as down with a 503 (#910)', async () => {
    // backend#1224: dependency detail is operator/reader-only.
    const res = await fetch(`${baseUrl}/health`, {
      headers: { authorization: 'Bearer test-operator-token-startup-survival-271' },
    });

    // Before #910 this returned 200 "healthy" with Postgres fully down — the
    // false positive the issue was filed about. The probe must now fail closed.
    expect(res.status).toBe(503);

    const body = (await res.json()) as {
      success?: boolean;
      data?: {
        status?: string;
        dependencies?: { database?: { status?: string } };
      };
    };
    expect(body.success).toBe(false);
    expect(body.data?.status).toBe('unhealthy');
    expect(body.data?.dependencies?.database?.status).toBe('down');
  });

  it('anonymous GET /health keeps the 503 but carries no dependency detail (backend#1224)', async () => {
    const res = await fetch(`${baseUrl}/health`);

    expect(res.status).toBe(503);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['status', 'success', 'timestamp']);
    expect(body.status).toBe('unhealthy');
    expect(JSON.stringify(body)).not.toContain('59998');
  });

  it('anonymous /api/ready, /metrics and /api/dashboard leak no operator detail (backend#1224)', async () => {
    const ready = await fetch(`${baseUrl}/api/ready`);
    const readyBody = (await ready.json()) as Record<string, unknown>;
    expect(Object.keys(readyBody).sort()).toEqual(['status', 'timestamp']);

    for (const probe of ['/metrics', '/api/dashboard']) {
      const res = await fetch(`${baseUrl}${probe}`);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toMatch(/process_cpu|<html/i);
    }

    const incidents = await fetch(`${baseUrl}/api/resilience/incidents/synthetic`);
    expect(incidents.status).toBe(401);

    const authed = await fetch(`${baseUrl}/metrics`, {
      headers: { authorization: 'Bearer test-operator-token-startup-survival-271' },
    });
    expect(authed.status).toBe(200);
    expect(await authed.text()).toMatch(/process_cpu/);
  });

  it('GET /api/performance/metrics answers structured HTTP, not a crash', async () => {
    const res = await fetch(`${baseUrl}/api/performance/metrics`);

    // With Redis down, the auth-revocation layer fails closed and returns 401
    // before route handlers run (deliberate; see AuthRevocation). Survival
    // means a structured status — never a hang, crash, or empty reply.
    expect([200, 401, 503]).toContain(res.status);
    await res.json(); // must parse — a crashed handler yields an empty body
  });

  it('POST /api/weather/submit without DB returns success (mock path), not crash', async () => {
    const res = await fetch(`${baseUrl}/api/weather/submit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        temperature: 22.5,
        humidity: 60,
        pressure: 1013,
        location: { lat: 40.7, lng: -74.0 },
      }),
    });

    // With Redis down the auth layer fails closed (401) before the staged
    // migration path can run; with it up, the mock path may 200/500/503.
    // Survival means a structured answer either way.
    expect([200, 401, 500, 503]).toContain(res.status);

    const body = await res.json();
    expect(body).toBeTruthy();
    if (res.status !== 401) {
      expect(body).toHaveProperty('timestamp');
      expect(`${stdout}\n${stderr}`).toContain(
        'Unauthenticated weather submit accepted during staged migration',
      );
    }
  });

  it('unknown route answers structured HTTP, not a crash', async () => {
    const res = await fetch(`${baseUrl}/api/nonexistent-route-12345`);

    // Fail-closed auth (Redis down) intercepts with 401 before 404 routing —
    // the "401 masks 404" surface. Both are structured; neither is a crash.
    expect([401, 404]).toContain(res.status);

    const body = (await res.json()) as Record<string, unknown>;
    if (res.status === 404) {
      expect(body).toHaveProperty('success', false);
    } else {
      // The 401 interceptor's shape: { error, message } with no success field.
      expect(body).toHaveProperty('error');
    }
  });
});
