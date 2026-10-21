/**
 * backend#1236 (codex round 9, P1): the CORS fatal hook must not change how
 * any OTHER uncaught error behaves. It is an uncaughtExceptionMonitor, which
 * observes without consuming; a plain uncaughtException listener would
 * suppress Node's default crash, so an unrelated throw exited 0 with empty
 * stderr once the helper was loaded.
 *
 * Each case runs in a real child process, with and without the shared
 * winston logger (which installs its own uncaughtException handler).
 */
import { spawnSync } from 'child_process';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

function run(body: string, { winston, helper }: { winston: boolean; helper: boolean }) {
  const script = [
    winston ? "require('./server/utils/logger.ts');" : '',
    helper ? "const strict = require('./server/utils/strict-cors-config.js');" : '',
    body,
  ].join('\n');
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: 'development' };
  delete env.JEST_WORKER_ID;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '-e', script], {
    cwd: ROOT,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const ORDINARY = "setTimeout(() => { throw new Error('ordinary boom 1236'); }, 10);";
const UNCAUGHT_CORS =
  "setTimeout(() => strict.resolveAllowedOrigins({ nodeEnv: 'production', corsOriginEnv: '', allowedOriginsEnv: '', corsAllowedOriginsEnv: '', corsOriginsEnv: '' }), 10);";
const CAUGHT_CORS = `
try {
  strict.resolveAllowedOrigins({ nodeEnv: 'production', corsOriginEnv: 'http://localhost:5000', allowedOriginsEnv: '', corsAllowedOriginsEnv: '', corsOriginsEnv: '' });
} catch (error) {
  console.log('caught ' + error.name);
}
setTimeout(() => console.log('still alive'), 50);
`;

describe('CORS fatal monitor is transparent to other uncaught errors', () => {
  it.each([false, true])('ordinary uncaught error, winston=%s: same exit and message as without the helper', winston => {
    const baseline = run(ORDINARY, { winston, helper: false });
    const withHelper = run(ORDINARY, { winston, helper: true });

    expect(withHelper.status).toBe(baseline.status);
    expect(withHelper.output).toContain('ordinary boom 1236');
    expect(withHelper.output).not.toContain('FATAL [CORS]');
    if (!winston) {
      // Node's default crash: non-zero with the message on stderr.
      expect(withHelper.status).not.toBe(0);
    }
  }, 60_000);

  it.each([false, true])('uncaught CorsConfigurationError, winston=%s: exit 1 with FATAL', winston => {
    const result = run(UNCAUGHT_CORS, { winston, helper: true });
    expect(result.status).toBe(1);
    expect(result.output).toMatch(/FATAL \[CORS\] Refusing to start with NODE_ENV=production/);
  }, 60_000);

  it('a caught CorsConfigurationError does not kill the process', () => {
    const result = run(CAUGHT_CORS, { winston: false, helper: true });
    expect(result.status).toBe(0);
    expect(result.output).toContain('caught CorsConfigurationError');
    expect(result.output).toContain('still alive');
    expect(result.output).not.toContain('FATAL');
  }, 60_000);
});
