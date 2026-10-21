/**
 * #846 — the environment-report ingest endpoints must refuse unauthenticated
 * writes on the NORMALLY MOUNTED router, and that refusal must be an AUTH
 * decision rather than a route that simply is not there.
 *
 * ## What already existed, and the one thing that did not
 *
 *   - `environment-report-ingest-auth.test.ts` (#980) calls `authenticateJWT`
 *     directly and pins that it never calls `next()` for an unauthenticated
 *     caller. It never touches routing.
 *   - `loop-build-r20-928-degraded-mount-auth.test.ts` boots the real
 *     entrypoint with the environment router's mount FORCED TO FAIL, and pins
 *     the inline fallback guards. That is the degraded path.
 *   - Neither covers the **normal** path, where `safeMount` succeeds and
 *     `environment-reports-routes` serves the request behind its own
 *     `router.use(authenticateJWT)`. And nothing anywhere pinned that a 401
 *     here is distinguishable from a 404.
 *
 * This file covers that: normal mount, real HTTP.
 *
 * ## The 401-vs-404 question, and the honest answer
 *
 * "The unauthenticated request was refused" is NOT the claim "the endpoint is
 * protected" — a route that does not exist also refuses unauthenticated input.
 * So this suite went looking for a negative control that tells the two apart,
 * and **found that on this route no such external control exists**. Measured,
 * not assumed:
 *
 *   - anonymous      -> 401 for real AND absent paths, because
 *     `router.use(authenticateJWT)` runs before any route is matched
 *   - authenticated  -> the two paths SEPARATE: the real route reaches the ingest
 *     handler (201, or 400 from its own validation), the absent sibling answers
 *     404 `Endpoint not found`
 *
 * The anonymous half is pinned below and is genuine: the 401 really does mask the
 * 404 there, by design, so **an anonymous 401 is not evidence that the endpoint
 * exists**. That is why this suite still does not assert `not.toBe(404)` on an
 * anonymous request — an absent route satisfies it identically.
 *
 * ## Correction (#928 review)
 *
 * An earlier version of this file also pinned the AUTHENTICATED case as
 * indistinguishable (both 403) and attributed it to "the global node/p2p
 * middleware layer". Both halves were wrong:
 *
 *   - the 403 was `CROSSPOST_WRITE_FORBIDDEN` from the wrfsentinel crosspost
 *     router, mounted globally with no path prefix at
 *     `enhanced_unified_api_optimized.ts:1743`; `authenticateJWT` was never
 *     reached on those requests, and
 *   - it was an artifact of THIS FILE's token minting `permissions: []`, not
 *     system behaviour. Pinning it as system behaviour would have failed for the
 *     wrong reason the moment anyone changed the test token.
 *
 * Granting `crosspost:write` separates the paths, which makes the real negative
 * control — and the authorized 201 — reachable from inside this file.
 *
 * ## Infrastructure
 *
 * Reuses the `r20-degraded-mount-preload.cjs` fixture with
 * `WRFCOIN_R20_SKIP_MOUNT_FAILURE=1`, so the environment router mounts
 * normally. The fixture stubs Redis, `database/connection`, schema verification
 * and session lookup, so this boots with no Postgres and no Redis — required,
 * because the CI workflow has no service containers. (The older
 * spawn-with-dead-DB approach in `db-startup-survival.test.ts` no longer boots
 * and is quarantined; the entrypoint now fails before `listen` without a
 * database.)
 */

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import { JWT_AUDIENCE, JWT_ISSUER } from '../server/auth/jwt-constants.js';

const repoRoot = path.resolve(__dirname, '..');
const entrypoint = path.join(repoRoot, 'server/enhanced_unified_api_optimized.ts');
const preload = path.join(__dirname, 'fixtures/r20-degraded-mount-preload.cjs');
const jwtSecret = 'r97-test-secret-with-at-least-32-characters';

type Domain = 'soil' | 'ocean' | 'hydrology';
const DOMAINS: Domain[] = ['soil', 'ocean', 'hydrology'];

/** Sibling paths that are deliberately absent — the not-found controls. */
const ABSENT_PATHS = [
  '/api/environment/reports/soil/ingest-does-not-exist',
  '/api/environment/reports/definitely-not-a-domain/ingest',
];

/**
 * A COMPLETE report body. `assertBaseInput`
 * (server/services/environment-phase2-reports-service.ts:126-133) requires
 * source, providerId, region and an actorClass in {human, ai_agent, robot};
 * anything missing throws and the handler returns 400. Supplying all four is
 * what lets the authorized case reach 201 instead of stopping at a 400.
 */
function payload(domain: Domain) {
  return {
    source: 'r97-e2e-probe',
    providerId: 'r97-provider',
    region: 'test-region',
    actorClass: 'human',
    stationId: `r97-${domain}-probe`,
    observedAt: '2026-08-03T00:00:00.000Z',
    domain,
    value: 1,
  };
}

function authHeader(): string {
  return `Bearer ${jwt.sign(
    {
      userId: 'r97-test-user',
      sessionId: 'r97-test-session',
      jti: 'r97-test-jti',
      roles: ['user'],
      // #928 review: the wrfsentinel crosspost router is mounted GLOBALLY with no
      // path prefix (enhanced_unified_api_optimized.ts:1743) and requires one of
      // ['*','admin','write','crosspost:write'] (wrfsentinel-crosspost-routes.ts:40-61).
      // Without it every authenticated request — real path or absent — is refused
      // 403 CROSSPOST_WRITE_FORBIDDEN before the environment router is consulted,
      // which is what previously made real and absent paths look indistinguishable.
      permissions: ['crosspost:write'],
    },
    jwtSecret,
    { expiresIn: '5m', issuer: JWT_ISSUER, audience: JWT_AUDIENCE },
  )}`;
}

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

function waitForPort(port: number, timeoutMs = 60_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
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
          setTimeout(attempt, 200).unref();
        }
      });
    };
    attempt();
  });
}

let child: ChildProcess;
let port: number;
let stderr = '';
let countsDir = '';

const url = (p: string) => `http://127.0.0.1:${port}${p}`;

async function post(p: string, authorization?: string): Promise<Response> {
  return fetch(url(p), {
    method: 'POST',
    headers: {
      ...(authorization ? { authorization } : {}),
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload('soil')),
  });
}

describe('#846 environment report ingest auth — normal mount, real HTTP', () => {
  beforeAll(async () => {
    port = await getFreePort();
    countsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r97-env-auth-'));

    const nodeOptions = [process.env.NODE_OPTIONS, `--require=${preload}`]
      .filter(Boolean)
      .join(' ');

    child = spawn(process.execPath, ['--import', 'tsx', entrypoint], {
      cwd: repoRoot,
      env: {
        ...process.env,
        NODE_OPTIONS: nodeOptions,
        PORT: String(port),
        NODE_ENV: 'test',
        LOG_LEVEL: 'warn',
        JWT_SECRET: jwtSecret,
        // Test-only placeholder. The entrypoint refuses to boot without it
        // (weather-commit-reveal-routes builds a core4 client at startup); this
        // suite never makes a core4 call.
        WRFCOIN_OPERATOR_TOKEN: 'r97-test-operator-token',
        DATABASE_URL: 'postgresql://127.0.0.1:59999/r97-test',
        REDIS_URL: 'redis://127.0.0.1:59999',
        WRFCOIN_R20_COUNTS_FILE: path.join(countsDir, 'counts.json'),
        // The whole point of this suite: mount the environment router NORMALLY.
        WRFCOIN_R20_SKIP_MOUNT_FAILURE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stderr?.on('data', (c: Buffer) => {
      stderr += c.toString();
    });

    const exitedEarly = new Promise<never>((_, reject) => {
      child.once('exit', (code) =>
        reject(new Error(`server exited early with code ${code}\nstderr: ${stderr.slice(-4000)}`)),
      );
    });

    await Promise.race([waitForPort(port), exitedEarly]);
  }, 120_000);

  afterAll(async () => {
    // An orphaned server holds the port and wedges later integration suites.
    if (child && !child.killed) {
      child.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => resolve(), 5_000);
        timer.unref();
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (countsDir) fs.rmSync(countsDir, { recursive: true, force: true });
  });

  it('the server is alive and serving (anti-vacuity)', async () => {
    expect(child.exitCode).toBeNull();
    const res = await fetch(url('/api/health'));
    // Must be a real answer from the app, and must not be the not-found branch,
    // or the 404 controls below would prove nothing.
    expect(res.status).not.toBe(404);
  });

  it.each(DOMAINS)('refuses an unauthenticated POST to %s/ingest with 401', async (domain) => {
    const res = await post(`/api/environment/reports/${domain}/ingest`);
    expect(res.status).toBe(401);
  });

  it.each(ABSENT_PATHS)(
    'unauthenticated %s also answers 401 — the 401 DOES mask the 404 here, by design',
    async (p) => {
      // MEASURED, not assumed. `environment-reports-routes` calls
      // `router.use(authenticateJWT)` before any route is matched, so every path
      // under the mount — real or absent — is refused before Express can decide
      // it is a 404. Anonymous callers therefore cannot learn which routes exist.
      //
      // The consequence for this suite is the important part: an unauthenticated
      // 401 is NOT evidence that the route exists, so it cannot on its own prove
      // the endpoint is protected. The authenticated probes below are what carry
      // that claim. This test pins the masking behaviour so that if the mount
      // ever changes to leak route existence to anonymous callers, it is a
      // deliberate decision and not a silent drift.
      const res = await post(p);
      expect(res.status).toBe(401);
    },
  );

  it('AUTHENTICATED — the real ingest route EXISTS and is reached', async () => {
    // #928 review correction. The earlier version of this suite pinned real and
    // absent as indistinguishable (both 403) and attributed that to a "node/p2p
    // middleware layer". Both parts were wrong: the 403 was
    // CROSSPOST_WRITE_FORBIDDEN from the globally-mounted crosspost router, and
    // it was an artifact of THIS FILE's token carrying `permissions: []` — not
    // system behaviour. With `crosspost:write` granted the two paths separate,
    // so the discrimination the suite went looking for is available after all.
    //
    // 201 is the handler's success path; 400 is the handler's own validation
    // throw. Either proves the request reached `environment-reports-routes`,
    // which is the positive existence evidence a 401 cannot give. Accepting both
    // keeps this from going red if the required-field set changes.
    const res = await post('/api/environment/reports/soil/ingest', authHeader());
    expect(res.status).not.toBe(401);
    expect(res.status).not.toBe(403);
    expect(res.status).not.toBe(404);
    expect([200, 201, 400]).toContain(res.status);
  });

  it.each(ABSENT_PATHS)(
    'AUTHENTICATED CONTROL — absent sibling %s answers 404 Endpoint not found',
    async (p) => {
      // This is the control that gives the assertion above its meaning. Past the
      // crosspost guard, route existence becomes observable: a genuinely absent
      // path under the same prefix answers 404 with the terminal handler's
      // `Endpoint not found`, while the real route does not. Without this pair,
      // "the real route was not 404" could equally mean nothing under this
      // prefix ever 404s.
      const res = await post(p, authHeader());
      const body: any = await res.json().catch(() => ({}));
      expect(res.status).toBe(404);
      expect(JSON.stringify(body)).toMatch(/endpoint not found/i);
    },
  );

  it('AUTHENTICATED — the guard ADMITS a valid caller (201), not only refuses', async () => {
    // The assertion that turns "the guard refuses" into "the guard refuses AND
    // admits". Without it the suite cannot distinguish a working guard from a
    // permanently closed route. Requires the complete payload — see payload().
    const res = await post('/api/environment/reports/soil/ingest', authHeader());
    const body: any = await res.json().catch(() => ({}));
    expect(res.status).toBe(201);
    expect(body?.success).toBe(true);
  });

  it('a syntactically present but unverifiable bearer token still gets 401', async () => {
    const res = await post('/api/environment/reports/soil/ingest', 'Bearer not-a-real-jwt');
    expect(res.status).toBe(401);
  });

  it('an empty bearer token still gets 401', async () => {
    const res = await post('/api/environment/reports/soil/ingest', 'Bearer ');
    expect(res.status).toBe(401);
  });

  it('no ingest domain admits an unauthenticated write', async () => {
    const statuses = await Promise.all(
      DOMAINS.map(async (d) => (await post(`/api/environment/reports/${d}/ingest`)).status),
    );
    for (const status of statuses) expect(status).toBe(401);
  });
});

/**
 * NOT PINNED HERE, stated rather than left to be discovered:
 *
 *   - **Route existence to an ANONYMOUS caller.** Still genuinely unobservable:
 *     `router.use(authenticateJWT)` refuses before route matching, so real and
 *     absent paths are identical to an unauthenticated prober. That half of the
 *     masking is real and is pinned above.
 *   - **Session revocation and token expiry.** `validateSession` is stubbed by the
 *     shared preload fixture, so this proves credential-vs-no-credential, not
 *     session-lifecycle correctness.
 *   - **The other two domains' success paths.** Only `soil/ingest` is driven to
 *     201; `ocean` and `hydrology` are covered for refusal only. Their handlers
 *     share `assertBaseInput`, so the marginal value is low, but it is a gap.
 */
