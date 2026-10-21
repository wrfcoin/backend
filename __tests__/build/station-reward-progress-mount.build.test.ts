import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '@jest/globals';

const REPO_ROOT = path.resolve(__dirname, '../..');
const ENTRYPOINT = path.join(REPO_ROOT, 'dist/server/enhanced_unified_api_optimized.js');
const BUILT_ROUTER = path.join(REPO_ROOT, 'dist/server/routes/weather-routes.cjs');
const ROUTER_SOURCE = path.join(REPO_ROOT, 'server/routes/weather-routes.js');
const PROBE = path.join(REPO_ROOT, 'scripts/verify-station-reward-progress-build.mjs');
const BUILD_TIMEOUT_MS = 15 * 60 * 1000;

function distIsStale(): boolean {
  if (!existsSync(ENTRYPOINT) || !existsSync(BUILT_ROUTER)) return true;
  return statSync(ROUTER_SOURCE).mtimeMs > statSync(BUILT_ROUTER).mtimeMs;
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

describe('build-tier: station reward progress is reachable in the emitted artifact', () => {
  it('resolves from the compiled entrypoint and handles the exact path before catch-all', () => {
    const stdout = execFileSync('node', [PROBE, REPO_ROOT, '--inspect-only'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const result = JSON.parse(stdout.trim());

    expect(result).toMatchObject({
      outcome: 'ROUTE_PRESENT',
      method: 'GET',
      path: '/stations/:stationId/reward-progress',
    });
    expect(result.handlerCount).toBeGreaterThanOrEqual(3);
  });
});
