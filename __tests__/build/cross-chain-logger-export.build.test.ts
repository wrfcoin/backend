/**
 * BUILD-TIER regression for the cross-chain logger export — backend#1086.
 *
 * ## The defect, and why no source-level test can see it
 *
 * There are TWO independent modules with the basename `server/utils/logger`:
 *
 *   - `server/utils/logger.js`  — 166 lines, standalone winston setup,
 *                                 exports `crossChainLogger` (capital C)
 *   - `server/utils/logger.ts`  — 1091 lines, correlation IDs / OTel / masking,
 *                                 exports `crosschainLogger` (lowercase c)
 *
 * `scripts/copy-build-assets.mjs` copies `.js` runtime sources into `dist/` but
 * skips any `.js` that has a `.ts` peer. `logger.ts` exists, so `logger.js` is
 * NEVER copied, and `dist/server/utils/logger.js` is the compiled `logger.ts`.
 *
 * Seven cross-chain modules do:
 *
 *     const { crossChainLogger: logger } = require('../utils/logger.js');
 *
 * which resolves three different ways:
 *
 *   dist        -> compiled logger.ts   -> no `crossChainLogger`  -> undefined
 *   jest (unit) -> logger.ts, because moduleNameMapper strips `.js` and
 *                  moduleFileExtensions is ts-first
 *   plain node  -> the literal logger.js -> works
 *
 * So in the built artifact `logger` is `undefined` and the first log call throws
 * `TypeError: Cannot read properties of undefined (reading 'debug')`. That call
 * is in the FLAG-OFF branch, so it fires on every invocation in the default
 * production configuration — `ENABLE_REAL_BRIDGES` unset:
 *
 *     if (!isRealBridgesEnabled()) {
 *       logger.debug('[Axelar API] Real bridges disabled — …');
 *       return null;   // never reached
 *     }
 *
 * `scripts/verify-dist-import-resolution.mjs` passes because the specifier
 * RESOLVES; it checks reachability, not that a named export exists.
 *
 * ## Why this test builds rather than skipping
 *
 * Same reasoning as `pythia-route-mount.build.test.ts` (#896): CI runs
 * `npm ci` -> `tsc --noEmit` -> `npm run build` -> `npm test`, but a
 * dist-conditional skip would read as green forever on any runner that did not
 * build — which is the exact failure mode this file exists to prevent. It
 * builds the artifact itself when the artifact is missing or stale.
 *
 * "live file" != "live code path" != "live BUILT code path". A unit test
 * importing the api-client from source passes today and proves nothing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeAll } from '@jest/globals';

const REPO_ROOT = path.resolve(__dirname, '../..');
const BUILT_LOGGER = path.join(REPO_ROOT, 'dist/server/utils/logger.js');
const BUILT_AXELAR = path.join(REPO_ROOT, 'dist/server/axelar/api-client.cjs');
const BUILT_LAYERZERO = path.join(REPO_ROOT, 'dist/server/layer-zero/api-client.cjs');
const LOGGER_SOURCE = path.join(REPO_ROOT, 'server/utils/logger.ts');

const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

function distIsStale(): boolean {
  if (!existsSync(BUILT_LOGGER) || !existsSync(BUILT_AXELAR) || !existsSync(BUILT_LAYERZERO)) {
    return true;
  }
  return statSync(LOGGER_SOURCE).mtimeMs > statSync(BUILT_LOGGER).mtimeMs;
}

/**
 * Load a built module in a clean child process and report what happened.
 *
 * A child process rather than `require()` in-band: the emitted modules are the
 * production artifact, and jest's module registry and moduleNameMapper are
 * precisely what hide this defect. Nothing here may resolve through them.
 */
function probeBuilt(modulePath: string, fnName: string, arg: string): Record<string, unknown> {
  const script = `
    delete process.env.ENABLE_REAL_BRIDGES;
    (async () => {
      const out = { loaded: false, threw: null, resolved: undefined };
      try {
        const m = require(${JSON.stringify(modulePath)});
        out.loaded = true;
        out.resolved = await m[${JSON.stringify(fnName)}](${JSON.stringify(arg)});
      } catch (e) {
        out.threw = e && e.message ? e.message : String(e);
      }
      process.stdout.write('__PROBE__' + JSON.stringify(out));
    })();
  `;
  const stdout = execFileSync('node', ['-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
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

describe('build-tier: the cross-chain logger the emitted artifact actually resolves (#1086)', () => {
  it('the shipped logger exports the name its seven consumers destructure', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shipped = require(BUILT_LOGGER) as Record<string, unknown>;

    // The assertion that fails on main. `in` rather than a truthiness check
    // because the distinction matters for diagnosis: a missing KEY is a name
    // mismatch, whereas a present key holding undefined would indicate a
    // circular import resolving to a partially-initialized module.
    expect('crossChainLogger' in shipped).toBe(true);
    expect(shipped.crossChainLogger).toBeDefined();
  });

  it('both spellings resolve to a usable logger, so either consumer style works', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shipped = require(BUILT_LOGGER) as Record<string, { debug?: unknown }>;

    // `server/routes/bridges.js` already uses the lowercase spelling while the
    // seven cross-chain modules use the capitalised one. Both are live callers
    // of the same emitted module, so both must work.
    for (const name of ['crossChainLogger', 'crosschainLogger']) {
      expect(typeof shipped[name]).toBe('object');
      expect(typeof shipped[name]?.debug).toBe('function');
    }
  });

  it.each([
    ['axelar', BUILT_AXELAR, 'queryGMPStatus'],
    ['layer-zero', BUILT_LAYERZERO, 'trackMessage'],
  ])(
    '%s api-client returns the stub instead of throwing, with ENABLE_REAL_BRIDGES unset',
    (_name, modulePath, fnName) => {
      const result = probeBuilt(modulePath, fnName, '0xabc');

      expect(result.loaded).toBe(true);
      // On main this is
      //   "Cannot read properties of undefined (reading 'debug')"
      expect(result.threw).toBeNull();
      // Flag off is contractually a null return so callers fall back to stubs.
      expect(result.resolved).toBeNull();
    },
  );
});
