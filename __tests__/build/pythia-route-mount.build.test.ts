/**
 * BUILD-TIER reachability regression for /api/pythia — backend#896.
 *
 * Why this exists, stated plainly because the lesson is the whole point:
 *
 * The 14 unit tests for this router passed while the route was **completely
 * absent in production**. `server/routes/pythia-routes.ts` imported a CommonJS
 * module through its `.js` path inside a `"type": "module"` package. Jest's
 * moduleNameMapper strips the extension and resolves the CJS source directly,
 * so the unit suite never saw it — but the emitted artifact throws at load:
 *
 *   SyntaxError: The requested module '../../middleware/rateLimiting.js'
 *   does not provide an export named 'generalLimiter'
 *
 * Production `safeMount` catches that and continues, so boot looked healthy
 * while every /api/pythia route 404'd.
 *
 * "live file" != "live code path" != "live BUILT code path". These assertions
 * operate at the third tier: the real `dist/` artifact, resolved through the
 * real production `safeMount` boundary. An `express().use('/api/pythia',
 * mockedRouter)` test cannot catch this class of defect and is not a
 * substitute.
 *
 * This test BUILDS the artifact itself rather than skipping when `dist/` is
 * absent. CI runs `npm ci` -> `tsc --noEmit` -> `npm test` with no build step,
 * so a dist-conditional skip would read as green forever — the exact
 * failure mode this file exists to prevent.
 *
 * The systemic audit of all ~46 safeMounted routers, and a CI gate for them,
 * is backend#937. This file covers one router on purpose.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeAll } from '@jest/globals';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ENTRYPOINT = path.join(REPO_ROOT, 'dist/server/enhanced_unified_api_optimized.js');
const BUILT_ROUTER = path.join(REPO_ROOT, 'dist/server/routes/pythia-routes.js');
const ROUTER_SOURCE = path.join(REPO_ROOT, 'server/routes/pythia-routes.ts');
const PROBE = path.join(__dirname, 'probe-safemount-load.mjs');

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/** Rebuild when the artifact is missing or older than the router source. */
function distIsStale(): boolean {
  if (!existsSync(ENTRYPOINT) || !existsSync(BUILT_ROUTER)) return true;
  return statSync(ROUTER_SOURCE).mtimeMs > statSync(BUILT_ROUTER).mtimeMs;
}

function runProbe(modulePath: string): Record<string, unknown> {
  const stdout = execFileSync('node', [PROBE, modulePath], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    // The probe answers on stdout; the loaded module is free to log whatever.
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('__PROBE__'));
  if (!line) throw new Error(`probe produced no result line. stdout:\n${stdout}`);
  return JSON.parse(line.slice('__PROBE__'.length));
}

beforeAll(() => {
  if (distIsStale()) {
    execFileSync('npm', ['run', 'build'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: BUILD_TIMEOUT_MS,
      stdio: 'pipe',
    });
  }
}, BUILD_TIMEOUT_MS);

describe('build-tier: /api/pythia is actually reachable in the emitted artifact', () => {
  it('builds an artifact containing the router and the entrypoint', () => {
    // If this fails the rest is meaningless, so assert it rather than skipping.
    expect(existsSync(ENTRYPOINT)).toBe(true);
    expect(existsSync(BUILT_ROUTER)).toBe(true);
  });

  it('loads through the production safeMount resolution boundary', () => {
    const result = runProbe('./routes/pythia-routes');

    // The assertion that would have caught the shipped defect. Naming the
    // outcome in the message means a regression reports the real reason.
    expect(result.outcome).toBe('LOAD_OK');
    expect(result.resolved).toBe('dist/server/routes/pythia-routes.js');
  });

  it('exposes its routes after loading, not an empty router', () => {
    const result = runProbe('./routes/pythia-routes');

    // 5 routes + the limiter layer. A router that loads but mounts nothing
    // would be just as invisible in production as one that fails to load.
    expect(result.outcome).toBe('LOAD_OK');
    expect(result.routeCount as number).toBeGreaterThanOrEqual(5);
  });

  it('mounts /api/pythia BEFORE the inline catch-all', () => {
    // Ordering matters: the catch-all forwards every unmatched request to the
    // legacy inline handler. A router mounted after it is shadowed and its
    // routes never run, which looks identical to not being mounted at all.
    const emitted = readFileSync(ENTRYPOINT, 'utf8');

    const mountIndex = emitted.indexOf("safeMount('/api/pythia'");
    const catchAllIndex = emitted.indexOf(
      'Catch-all: forward unmatched requests to the existing inline handleRequest',
    );

    expect(mountIndex).toBeGreaterThan(-1);
    expect(catchAllIndex).toBeGreaterThan(-1);
    expect(mountIndex).toBeLessThan(catchAllIndex);
  });

  it('imports the rate limiter through a specifier that resolves in the artifact', () => {
    // Source boot uses .js; the build's interop repair must emit .cjs. Check
    // the runtime artifact rather than prescribing a dist-only source import.
    const emitted = readFileSync(BUILT_ROUTER, 'utf8');
    expect(emitted).toContain("from '../../middleware/rateLimiting.cjs'");
    expect(emitted).not.toContain("from '../../middleware/rateLimiting.js'");
    expect(existsSync(path.join(REPO_ROOT, 'dist/middleware/rateLimiting.cjs'))).toBe(true);
  });
});
