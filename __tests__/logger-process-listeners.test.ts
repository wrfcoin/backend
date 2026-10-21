import { describe, expect, it } from '@jest/globals';
import { execFileSync } from 'child_process';

function runLoggerListenerProbe() {
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      'tsx',
      '--eval',
      `
        const loggerModule = await import('./server/utils/logger.js');
        loggerModule.default.default('lane6-listener-regression');
        console.log(JSON.stringify({
          uncaughtException: process.listenerCount('uncaughtException'),
          unhandledRejection: process.listenerCount('unhandledRejection'),
        }));
      `,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'development',
        SILENT_LOGS: 'true',
        DISABLE_FILE_LOG_TRANSPORTS: 'false',
      },
      encoding: 'utf8',
    }
  );

  const lines = output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return JSON.parse(lines.at(-1) ?? '{}') as {
    uncaughtException: number;
    unhandledRejection: number;
  };
}

describe('server/utils/logger process listeners', () => {
  it('keeps fatal process listener counts bounded', () => {
    const counts = runLoggerListenerProbe();

    expect(counts.uncaughtException).toBe(1);
    expect(counts.unhandledRejection).toBe(1);
  });
});
