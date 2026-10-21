import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { beforeAll, describe, expect, it } from '@jest/globals';

// backend#1318: /api/keys refuses to start without ENCRYPTION_KEY. It is not a testnet client surface, so its
// absence is an optional-family miss, while a missing required family (/api/pythia) must still count.
describe('/api/keys is an optional safeMount family (#1318)', () => {
  let result: any;
  beforeAll(() => {
    const env = { ...process.env, REDIS_URL: 'redis://127.0.0.1:1' } as Record<string, string | undefined>;
    delete env.ENCRYPTION_KEY;
    const stdout = execFileSync(process.execPath,
      ['--import', 'tsx', path.join(__dirname, 'probe-keys-source-mount.mjs')], {
        cwd: path.resolve(__dirname, '../..'), encoding: 'utf8', timeout: 30_000, env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    const line = stdout.split('\n').find(value => value.startsWith('__PROBE__'));
    if (!line) throw new Error(`keys source probe produced no result: ${stdout}`);
    result = JSON.parse(line.slice('__PROBE__'.length));
  }, 35_000);

  it('the release allowlist names /api/keys and still requires /api/pythia', () => {
    expect(result.optional).toContain('/api/keys');
    expect(result.optional).not.toContain('/api/pythia');
  });
  it('without ENCRYPTION_KEY the keys family is recorded optional and unmounted, with the real reason', () => {
    const keys = result.audit.find((e: any) => e.mountPath === '/api/keys');
    expect(keys).toMatchObject({ required: false, mounted: false });
    expect(keys.error).toMatch(/ENCRYPTION_KEY/);
  });
  it('the required family is unaffected: /api/pythia is still recorded required', () => {
    const pythia = result.audit.find((e: any) => e.mountPath === '/api/pythia');
    expect(pythia).toMatchObject({ required: true });
  });
});
