/**
 * backend#1247 — under tsx (the live entrypoint) everything in server/ is
 * CommonJS (server/package.json has no "type"), and a CJS star re-export in
 * server/db.ts hid every named export from `await import('../db.js')`. The
 * weather station list and coverage zones then read `dbModule.pool` as
 * undefined on every request.
 *
 * ts-jest does not use tsx's module system, so the runtime check spawns the
 * real tsx binary on a fixture that imports server/db.js the way
 * server/routes/weather-routes.js does.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');

function valueExports(source: string): string[] {
  return [...source.matchAll(/^export (?:async )?(?:const|let|function|class) (\w+)/gm)].map((m) => m[1]).sort();
}

describe('server/db.js exposes named exports to CommonJS importers (backend#1247)', () => {
  it('re-exports database/db.ts by name, never with export *', () => {
    const facade = readFileSync(resolve(root, 'server/db.ts'), 'utf8');
    const target = readFileSync(resolve(root, 'database/db.ts'), 'utf8');

    expect(facade).not.toMatch(/^export \*/m);
    const listed = /export \{([^}]*)\} from '\.\.\/database\/db\.js'/.exec(facade);
    expect(listed).not.toBeNull();
    const names = listed![1].split(',').map((n) => n.trim()).filter(Boolean).sort();
    expect(names).toEqual(valueExports(target));
  });

  it('under tsx, import("../db.js") from server/ yields a usable pool, db and executeQuery', () => {
    const stdout = execFileSync(
      resolve(root, 'node_modules/.bin/tsx'),
      [resolve(root, 'server/__tests__/fixtures/db-module-interop-probe.js')],
      {
        cwd: root,
        encoding: 'utf8',
        timeout: 60_000,
        // The pool is lazy: nothing connects, so any well-formed URL will do.
        env: { ...process.env, DATABASE_URL: 'postgresql://interop:probe@127.0.0.1:1/interop' },
      },
    );
    const line = stdout.split('\n').find((l) => l.startsWith('DB_MODULE_INTEROP '));
    expect(line).toBeDefined();
    const report = JSON.parse(line!.slice('DB_MODULE_INTEROP '.length));

    expect(report.pool).toBe('function');
    expect(report.db).not.toBe('undefined');
    expect(report.executeQuery).toBe('function');
    expect(report.keys).toEqual(expect.arrayContaining(['pool', 'db', 'executeQuery']));
  }, 90_000);
});
