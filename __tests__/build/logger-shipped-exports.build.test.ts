/**
 * BUILD-TIER regression for the logger basename collision — backend#1097.
 *
 * ## Why a dev-side test cannot detect this class, by construction
 *
 * Two independent modules share the basename `server/utils/logger`:
 *
 *   server/utils/logger.js    166 lines, standalone winston
 *   server/utils/logger.ts   1091 lines, correlation IDs / OTel / masking
 *
 * `scripts/copy-build-assets.mjs` skips any `.js` with a `.ts` peer, so
 * `logger.js` never reaches `dist/` and one specifier resolves three ways:
 *
 *   plain node (dev, tsx) -> the literal logger.js
 *   jest                  -> logger.ts   (mapper strips `.js`; ts-first)
 *   dist/                 -> compiled logger.ts
 *
 * Dev and the test suite therefore exercise a logger that does not ship. Any
 * name present in `logger.js` but absent from `logger.ts` is `undefined` in
 * production and fine everywhere a test can see. Two such names were live:
 *
 *   websocketLogger  api/gamification-notifications.js:18      on client connect
 *   nftLogger        api/environmental-achievement-nfts.js:279 inside a catch —
 *                    it converted a handled error into an unhandled TypeError
 *
 * Four more (privacy, analytics, identity, oracle) had no consumer: latent, not
 * live. `crossChainLogger` is the same defect and is covered by its own
 * build-tier test from #1096.
 *
 * ## Why it builds instead of skipping
 *
 * Same reason as `pythia-route-mount.build.test.ts` (#896) and
 * `cross-chain-logger-export.build.test.ts` (#1086): a dist-conditional skip
 * reads as green forever on any runner that did not build, which is precisely
 * the failure mode this file guards.
 *
 * ## Follow-up
 *
 * Once #1096 has landed, this file and the #1086 one should be replaced by a
 * single assertion that the shipped logger is a strict superset of `logger.js`.
 * That is deliberately NOT written here: on this branch `crossChainLogger` is
 * still missing, so a superset assertion would fail for a reason this PR does
 * not own. Removing the basename collision outright (#1097 option 2) makes the
 * whole class unrepresentable and is the real fix.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, beforeAll } from '@jest/globals';

const REPO_ROOT = path.resolve(__dirname, '../..');
const BUILT_LOGGER = path.join(REPO_ROOT, 'dist/server/utils/logger.js');
const LOGGER_SOURCE = path.join(REPO_ROOT, 'server/utils/logger.ts');
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

/** Names this PR adds to the module that actually ships. */
const RESTORED = [
  'websocketLogger',
  'nftLogger',
  'privacyLogger',
  'analyticsLogger',
  'identityLogger',
  'oracleLogger',
] as const;

/** The two that had live consumers, with the built consumer that destructures each. */
const LIVE_CONSUMERS: ReadonlyArray<readonly [string, string, string]> = [
  ['websocketLogger', 'dist/api/gamification-notifications.cjs', '../server/utils/logger'],
  ['nftLogger', 'dist/api/environmental-achievement-nfts.cjs', '../server/utils/logger'],
];

function distIsStale(): boolean {
  if (!existsSync(BUILT_LOGGER)) return true;
  return statSync(LOGGER_SOURCE).mtimeMs > statSync(BUILT_LOGGER).mtimeMs;
}

/**
 * Resolve a specifier from a BUILT consumer's own directory, in a clean child
 * process. Jest's registry and moduleNameMapper are what hide this defect, so
 * nothing here may resolve through them.
 */
function resolveFromBuiltConsumer(consumerRel: string, specifier: string, name: string) {
  const script = `
    const path = require('path'), Module = require('module');
    const from = path.resolve(${JSON.stringify(path.dirname(consumerRel))}, 'x.js');
    const out = { consumerExists: false, resolved: null, present: false, error: null };
    try {
      out.consumerExists = require('fs').existsSync(${JSON.stringify(consumerRel)});
      const target = Module.createRequire(from).resolve(${JSON.stringify(specifier)});
      out.resolved = path.relative(process.cwd(), target);
      out.present = ${JSON.stringify(name)} in require(target);
    } catch (e) { out.error = e && e.message ? e.message : String(e); }
    process.stdout.write('__PROBE__' + JSON.stringify(out));
  `;
  const stdout = execFileSync('node', ['-e', script], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const line = stdout.split('\n').find((l) => l.startsWith('__PROBE__'));
  if (!line) throw new Error(`probe produced no result line. stdout:\n${stdout}`);
  return JSON.parse(line.slice('__PROBE__'.length)) as {
    consumerExists: boolean;
    resolved: string | null;
    present: boolean;
    error: string | null;
  };
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

describe('build-tier: the shipped logger exports the names dev consumers destructure (#1097)', () => {
  it.each(RESTORED)('%s is present in the emitted logger and is usable', (name) => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const shipped = require(BUILT_LOGGER) as Record<string, { info?: unknown } | undefined>;

    // `in` rather than truthiness: a missing KEY is a name mismatch, whereas a
    // present key holding undefined would point at initialisation order.
    expect(name in shipped).toBe(true);
    expect(typeof shipped[name]).toBe('object');
    expect(typeof shipped[name]?.info).toBe('function');
  });

  it.each(LIVE_CONSUMERS)(
    '%s resolves to a defined binding from its own built consumer',
    (name, consumerRel, specifier) => {
      const probe = resolveFromBuiltConsumer(consumerRel, specifier, name);

      expect(probe.error).toBeNull();
      // If the consumer stops shipping, this assertion must fail loudly rather
      // than quietly passing on an absent file.
      expect(probe.consumerExists).toBe(true);
      expect(probe.resolved).toBe('dist/server/utils/logger.js');
      // On main this is false, so the destructured const is undefined and the
      // first call on it throws.
      expect(probe.present).toBe(true);
    },
  );
});
