import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '@jest/globals';

describe('Pythia source boot through release safeMount (#1318)', () => {
  let result: any;
  beforeAll(() => {
    const stdout = execFileSync(process.execPath,
      ['--import', 'tsx', path.join(__dirname, 'probe-pythia-source-mount.mjs')], {
        cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30_000,
        env: { ...process.env, REDIS_URL: 'redis://127.0.0.1:1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const line = stdout.split('\n').find(value => value.startsWith('__PROBE__'));
    if (!line) throw new Error(`Pythia source probe produced no result: ${stdout}`);
    result = JSON.parse(line.slice('__PROBE__'.length));
  }, 35_000);

  it('records the required family as mounted, without a swallowed boot failure', () => {
    expect(result.audit).toEqual([{ mountPath: '/api/pythia', modulePath: './routes/pythia-routes',
      required: true, mounted: true }]);
    expect(result.warnings).toEqual([]);
  });
  it('serves the actual prediction handler ahead of the catch-all', () => {
    expect(result.firstStatus).toBe(400);
    expect(result.firstBody).toEqual({ error: 'invalid_horizon', allowed: ['24h', 'week', '1w', 'month', 'year'] });
  });
  it('retains the real shared limiter: request 101 is refused', () => {
    expect(result.allowedRequests).toBe(100);
    expect(result.finalStatus).toBe(429);
    expect(result.finalBody.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
