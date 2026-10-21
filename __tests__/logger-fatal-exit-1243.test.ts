/**
 * backend#1243: the shared winston logger (file transports enabled, i.e. the
 * normal case) claimed uncaughtException / unhandledRejection with
 * exitOnError:false, so a fatal error was logged and the process then exited 0
 * (or idled). Real subprocesses, real logger; cwd is a temp dir so the logs/
 * directory the logger creates never touches the repo.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(__dirname, '..');
const loggerPath = path.join(root, 'server/utils/logger.ts');
const tsxLoader = pathToFileURL(path.join(root, 'node_modules/tsx/dist/loader.mjs')).href;

function run(body: string, before = '') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logger-1243-'));
  const script = path.join(dir, 'probe.mjs');
  fs.writeFileSync(script, `${before}\nconst { logger } = await import(${JSON.stringify(pathToFileURL(loggerPath).href)});\nlogger.info('probe-started');\n${body}\n`);
  try {
    const env = { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info', DISABLE_CONSOLE_LOGS: 'false' };
    delete env.DISABLE_FILE_LOG_TRANSPORTS;
    delete env.SILENT_LOGS;
    const res = spawnSync(process.execPath, ['--import', tsxLoader, script], { cwd: dir, env, encoding: 'utf8', timeout: 60_000 });
    const errorLog = path.join(dir, 'logs', 'error.log');
    return { ...res, errorLog: fs.existsSync(errorLog) ? fs.readFileSync(errorLog, 'utf8') : '', filesEnabled: fs.existsSync(path.join(dir, 'logs')) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('shared logger does not swallow fatal errors (backend#1243)', () => {
  it('an uncaught exception exits non-zero, and the message is recorded', () => {
    const res = run("setTimeout(() => { throw new Error('boom-1243-uncaught'); }, 10);\nsetTimeout(() => {}, 5000);");
    expect(res.filesEnabled).toBe(true);
    expect(res.status).not.toBe(0);
    expect(res.status).not.toBeNull();
    expect(res.stdout + res.stderr + res.errorLog).toContain('boom-1243-uncaught');
  });

  it('an unhandled rejection exits non-zero, and the message is recorded', () => {
    const res = run("Promise.reject(new Error('boom-1243-rejection'));\nsetTimeout(() => {}, 5000);");
    expect(res.status).not.toBe(0);
    expect(res.status).not.toBeNull();
    expect(res.stdout + res.stderr + res.errorLog).toContain('boom-1243-rejection');
  });

  it('an application that registered its own fatal handler keeps control (no forced exit by the logger)', () => {
    const res = run("process.on('uncaughtException', () => console.log('app-handler-ran'));\nprocess.on('unhandledRejection', () => {});\nsetTimeout(() => { throw new Error('boom-1243-handled'); }, 10);\nsetTimeout(() => console.log('still-alive'), 300);");
    expect(res.stdout).toContain('app-handler-ran');
    expect(res.stdout).toContain('still-alive');
    expect(res.status).toBe(0);
  });

  it('a handler for ONE event does not silence the other: uncaughtException-only handler, then an unhandled rejection exits non-zero', () => {
    const res = run("process.on('uncaughtException', () => {});\nPromise.reject(new Error('boom-1243-cross-a'));\nsetTimeout(() => {}, 5000);");
    expect(res.status).not.toBe(0);
    expect(res.status).not.toBeNull();
    expect(res.stdout + res.stderr + res.errorLog).toContain('boom-1243-cross-a');
  });

  it('a handler for ONE event does not silence the other: unhandledRejection-only handler, then an uncaught exception exits non-zero', () => {
    const res = run("process.on('unhandledRejection', () => {});\nsetTimeout(() => { throw new Error('boom-1243-cross-b'); }, 10);\nsetTimeout(() => {}, 5000);");
    expect(res.status).not.toBe(0);
    expect(res.status).not.toBeNull();
    expect(res.stdout + res.stderr + res.errorLog).toContain('boom-1243-cross-b');
  });

  // Review of #1351 (SOL-C): an application handler that is registered BEFORE the logger is imported
  // and is one-shot is removed by Node as it is invoked; the logger must still treat that event as
  // owned and let the handler's asynchronous drain finish and choose the exit code.
  it.each([
    ['uncaughtException', "setTimeout(() => { throw new Error('boom-1243-once-a'); }, 10);"],
    ['unhandledRejection', "Promise.reject(new Error('boom-1243-once-b'));"],
  ])('an early process.once(%s) handler keeps ownership through its own drain and exit code', (event, raise) => {
    const before = `process.once('${event}', () => { console.log('handler-ran'); setTimeout(() => { console.log('drain-completed'); process.exit(23); }, 1100); });`;
    const res = run(`${raise}\nsetTimeout(() => {}, 5000);`, before);
    expect(res.stdout).toContain('handler-ran');
    expect(res.stdout).toContain('drain-completed');
    expect(res.status).toBe(23);
  });

  it.each(['uncaughtException', 'unhandledRejection'])('a persistent %s handler registered after the logger import also keeps ownership', (event) => {
    const raise = event === 'uncaughtException' ? "setTimeout(() => { throw new Error('boom-1243-late'); }, 10);" : "Promise.reject(new Error('boom-1243-late'));";
    const res = run(`process.on('${event}', () => { console.log('handler-ran'); setTimeout(() => { console.log('drain-completed'); process.exit(23); }, 1100); });\n${raise}\nsetTimeout(() => {}, 5000);`);
    expect(res.stdout).toContain('drain-completed');
    expect(res.status).toBe(23);
  });

  // Review of #1351 (SOL-B): a handler registered AFTER the logger import with prependOnceListener runs
  // first and is removed by Node as it is invoked. Ownership is decided before dispatch, so it holds.
  it.each([
    ['uncaughtException', "setTimeout(() => { throw new Error('boom-1243-latepo-a'); }, 10);"],
    ['unhandledRejection', "Promise.reject(new Error('boom-1243-latepo-b'));"],
  ])('a late process.prependOnceListener(%s) handler keeps ownership through its own drain and exit code', (event, raise) => {
    const res = run(`process.prependOnceListener('${event}', () => { console.log('handler-ran'); setTimeout(() => { console.log('drain-completed'); process.exit(23); }, 1100); });\n${raise}\nsetTimeout(() => {}, 5000);`);
    expect(res.stdout).toContain('handler-ran');
    expect(res.stdout).toContain('drain-completed');
    expect(res.status).toBe(23);
  });

  it.each(['uncaughtException', 'unhandledRejection'])('every registration order keeps ownership for %s (on/once/prepend, before/after the import)', (event) => {
    const raise = event === 'uncaughtException' ? "setTimeout(() => { throw new Error('boom-1243-order'); }, 10);" : "Promise.reject(new Error('boom-1243-order'));";
    const handler = "() => { console.log('handler-ran'); setTimeout(() => { console.log('drain-completed'); process.exit(23); }, 1100); }";
    for (const register of ['on', 'once', 'prependListener', 'prependOnceListener']) {
      const late = run(`process.${register}('${event}', ${handler});\n${raise}\nsetTimeout(() => {}, 5000);`);
      expect([register, 'late', late.status, late.stdout.includes('drain-completed')]).toEqual([register, 'late', 23, true]);
      const early = run(`${raise}\nsetTimeout(() => {}, 5000);`, `process.${register}('${event}', ${handler});`);
      expect([register, 'early', early.status, early.stdout.includes('drain-completed')]).toEqual([register, 'early', 23, true]);
    }
  });

  it('a FRESH re-import of the logger (query-suffixed URL) still exits 1 on an unowned uncaught exception', () => {
    const url = pathToFileURL(loggerPath).href;
    const res = run(`await import(${JSON.stringify(url + '?review_reload=2')});\nsetTimeout(() => { throw new Error('boom-1243-reload-a'); }, 10);\nsetTimeout(() => {}, 5000);`);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr + res.errorLog).toContain('boom-1243-reload-a');
  });

  it('a FRESH re-import of the logger still exits 1 on an unowned unhandled rejection', () => {
    const url = pathToFileURL(loggerPath).href;
    const res = run(`await import(${JSON.stringify(url + '?review_reload=2')});\nPromise.reject(new Error('boom-1243-reload-b'));\nsetTimeout(() => {}, 5000);`);
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr + res.errorLog).toContain('boom-1243-reload-b');
  });

  it.each(['uncaughtException', 'unhandledRejection'])('a borrowed %s emit on ANOTHER emitter does not kill the process', (event) => {
    const res = run(`import('node:events').then(({ EventEmitter }) => {\n  const other = new EventEmitter();\n  other.on(${JSON.stringify(event)}, () => console.log('other-handled'));\n  console.log('returned-' + process.emit.call(other, ${JSON.stringify(event)}, new Error('x')));\n  setTimeout(() => console.log('still-alive'), 900);\n});`);
    expect(res.stdout).toContain('other-handled');
    expect(res.stdout).toContain('returned-true');
    expect(res.stdout).toContain('still-alive');
    expect(res.status).toBe(0);
  });

  it('control: a process that throws nothing still exits 0', () => {
    const res = run("logger.info('done');");
    expect(res.status).toBe(0);
  });
});
