/**
 * backend#1089 — combined regression control for the two green .js suites.
 *
 * WHY THIS EXISTS, and why isolation is not enough:
 *
 * #1099 made eight previously-dark .js suites under server/__tests__/
 * discoverable. Two of them are green and gate immediately; the other six are
 * quarantined. Because the six are quarantined, THE DEFAULT GATE NEVER RUNS THE
 * EIGHT TOGETHER — so a green `npm test`, a green typecheck and a green CI run
 * are all silent about whether the two green suites survive in that company.
 *
 * They did not. data-flow-validation.test.js imported connection-pool and
 * redis-client without using them; both build their singleton at module load,
 * so requiring them opened a Postgres pool and a Redis client (host defaulting
 * to 'redis-cache') for the whole run. The resulting async ENOTFOUND arrived
 * OUTSIDE any assertion: it failed oracle-detail-routes without changing the
 * assertion counts at all — 22 failed / 96 passed / 118 total, identical either
 * way — and on some runs escaped as an uncaught exception that killed the
 * runner mid-run. The suite-level count moved from 6 to 7; the number everyone
 * reads did not move.
 *
 * A test that only ever runs in isolation cannot catch that, and the assertion
 * totals cannot express it. This control runs the exact eight TOGETHER with the
 * quarantine bypassed and asserts the two green ones still pass, so the next
 * person does not have to know to check.
 *
 * It lives in __tests__/ rather than server/__tests__/ deliberately: it invokes
 * only `server/__tests__/**.test.js`, so it can never collect itself.
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

// The two suites #1099 records as green-and-gating. If either stops passing in
// company, the quarantine comment claiming they "gate immediately" is false.
const MUST_PASS_IN_COMPANY = [
  'server/__tests__/oracle-detail-routes.test.js',
  'server/__tests__/middleware/authLogging.test.js',
];

describe('backend#1089: the two green .js suites stay green in company', () => {
  // Spawns a full jest run of eight suites; six of them fail by design.
  jest.setTimeout(180_000);

  it('passes oracle-detail-routes and authLogging when the exact eight run together', () => {
    let raw: string;
    try {
      raw = execFileSync(
        process.execPath,
        [
          require.resolve('jest/bin/jest'),
          '--config',
          path.join(REPO_ROOT, '__tests__/jest.standalone.cjs'),
          // Bypass the #872 quarantine so the six quarantined suites run too —
          // reproducing the contaminated combination the default gate cannot.
          '--testPathIgnorePatterns',
          '/node_modules/',
          '/dist/',
          '--runInBand',
          '--json',
          'server/__tests__/.*\\.test\\.js$',
        ],
        { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
      );
    } catch (error: any) {
      // Six suites fail by design, so a non-zero exit is EXPECTED. The JSON on
      // stdout is the result; only a run that produced none is a real failure.
      raw = error?.stdout ?? '';
      if (!raw) {
        throw new Error(
          'combined run produced no JSON — the runner died before reporting. ' +
            'That is the uncaught-async-error failure mode this control exists ' +
            `to catch. exit=${error?.status} signal=${error?.signal}`
        );
      }
    }

    const report = JSON.parse(raw);
    const byFile = new Map<string, string>(
      report.testResults.map((r: any) => [
        path.relative(REPO_ROOT, r.name).split(path.sep).join('/'),
        r.status,
      ])
    );

    // Guards against the control silently passing because it ran nothing.
    expect(report.numTotalTestSuites).toBe(8);

    for (const suite of MUST_PASS_IN_COMPANY) {
      expect(byFile.has(suite)).toBe(true);
      expect(`${suite}=${byFile.get(suite)}`).toBe(`${suite}=passed`);
    }
  });
});
