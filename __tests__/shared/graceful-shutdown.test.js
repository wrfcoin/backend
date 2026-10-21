const { spawnSync } = require('child_process');
const { existsSync, readFileSync, unlinkSync } = require('fs');
const path = require('path');
const { GracefulShutdown } = require('../../shared/graceful-shutdown/index.js');

const runTsxLoader = (script, env = {}) => {
  const result = spawnSync(process.execPath, [
    '--import',
    './node_modules/tsx/dist/loader.mjs',
    '-e',
    script,
  ], {
    encoding: 'utf8',
    cwd: path.resolve(__dirname, '../..'),
    env: { ...process.env, ...env },
    timeout: 5000,
  });

  if (result.error) {
    throw result.error;
  }

  return result;
};

const runTsxProbe = (script) => {
  const result = runTsxLoader(script);

  if (result.status !== 0) {
    throw new Error(`tsx probe failed with status ${result.status}: ${result.stderr}`);
  }

  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const jsonLine = lines.find((line) => line.startsWith('{') && line.endsWith('}'));
  if (!jsonLine) {
    throw new Error(`No JSON result from tsx probe: ${result.stdout}`);
  }
  return JSON.parse(jsonLine);
};

const runTsxProbeProcess = (script, env = {}) => {
  return runTsxLoader(script, env);
};

describe('GracefulShutdown signal and fatal handlers', () => {
  let shutdown;
  let exitSpy;

  beforeEach(() => {
    GracefulShutdown.resetInstance();
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});

    shutdown = GracefulShutdown.getInstance({
      exitCodeSuccess: 0,
      exitCodeError: 9,
      defaultHandlerTimeout: 25,
      globalTimeout: 200,
    });

    shutdown.registerHandler({
      name: 'test-handler',
      priority: 1,
      timeout: 10,
      handler: jest.fn().mockResolvedValue(undefined),
    });
  });

  afterEach(async () => {
    if (shutdown?.isShuttingDown()) {
      await shutdown.shutdown('test-after');
    }

    GracefulShutdown.resetInstance();
    exitSpy.mockRestore();
    jest.clearAllMocks();
  });

  test('SIGTERM exits with configured success code after successful cleanup', async () => {
    const beforeSigTerm = process.listenerCount('SIGTERM');

    shutdown.setupSignalHandlers();
    expect(process.listenerCount('SIGTERM')).toBe(beforeSigTerm + 1);

    process.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(shutdown.getState()).toBe('completed');
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  test('uncaughtException always exits with fatal configured error code', async () => {
    shutdown.setupSignalHandlers();

    process.emit('uncaughtException', new Error('boom'));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(shutdown.getState()).toBe('completed');
    expect(exitSpy).toHaveBeenCalledWith(9);
  });

  test('unhandledRejection always exits with fatal configured error code', async () => {
    shutdown.setupSignalHandlers();

    process.emit('unhandledRejection', new Error('rejected'));
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(shutdown.getState()).toBe('completed');
    expect(exitSpy).toHaveBeenCalledWith(9);
  });

  test('attaches only one listener per fatal and signal event', () => {
    const beforeSigTerm = process.listenerCount('SIGTERM');
    const beforeSigInt = process.listenerCount('SIGINT');
    const beforeUncaught = process.listenerCount('uncaughtException');
    const beforeUnhandled = process.listenerCount('unhandledRejection');

    shutdown.setupSignalHandlers();
    shutdown.setupSignalHandlers();

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigTerm + 1);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigInt + 1);
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled + 1);
  });

  test('resetInstance removes exactly listeners it registered', () => {
    const beforeSigTerm = process.listenerCount('SIGTERM');
    const beforeSigInt = process.listenerCount('SIGINT');
    const beforeUncaught = process.listenerCount('uncaughtException');
    const beforeUnhandled = process.listenerCount('unhandledRejection');

    shutdown.setupSignalHandlers();

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigTerm + 1);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigInt + 1);
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught + 1);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled + 1);

    GracefulShutdown.resetInstance();

    expect(process.listenerCount('SIGTERM')).toBe(beforeSigTerm);
    expect(process.listenerCount('SIGINT')).toBe(beforeSigInt);
    expect(process.listenerCount('uncaughtException')).toBe(beforeUncaught);
    expect(process.listenerCount('unhandledRejection')).toBe(beforeUnhandled);
  });

  test('tsx entrypoint maps to the shared graceful-shutdown TS implementation', () => {
    // Split `from` so the dist import-resolution gate does not mistake this
    // child-process source fixture for an import owned by the compiled test.
    const entryImport = [
      'import { GracefulShutdown as EntryShutdown } fro',
      "m './shared/graceful-shutdown/index.js';",
    ].join('');
    const tsImport = [
      'import { GracefulShutdown as TsShutdown } fro',
      "m './shared/graceful-shutdown/graceful-shutdown.js';",
    ].join('');
    const result = runTsxProbe(`
      import { readFileSync } from 'node:fs';
      ${entryImport}
      ${tsImport}

      const enhancedSource = readFileSync('./server/enhanced_unified_api_optimized.ts', 'utf8');
      const importsShutdownIndex = enhancedSource.includes(\"from '../shared/graceful-shutdown/index.js'\");
      const sameInstance = EntryShutdown === TsShutdown;
      const setupSource = EntryShutdown.prototype.setupSignalHandlers.toString();
      const fatalPathForcesErrorCode = /runFatalShutdown\\(\"uncaughtException\"\\)/.test(
        setupSource
      );

      console.log(JSON.stringify({
        importsShutdownIndex,
        sameInstance,
        fatalPathForcesErrorCode,
      }));
    `);

    expect(result.importsShutdownIndex).toBe(true);
    expect(result.sameInstance).toBe(true);
    expect(result.fatalPathForcesErrorCode).toBe(true);
  });

  test('tsx fatal exit path stays nonzero after successful cleanup', () => {
    const markerPath = path.join(process.env.TMPDIR || '/tmp', `backend-graceful-fatal-${Date.now()}.txt`);
    const entryImport = [
      'import { GracefulShutdown } fro',
      "m './shared/graceful-shutdown/index.js';",
    ].join('');
    const tsxScript = `
      ${entryImport}
      import { writeFileSync } from 'node:fs';

      const marker = process.env.MARKER_PATH;

      GracefulShutdown.resetInstance();
      const shutdown = GracefulShutdown.getInstance({
        exitCodeSuccess: 0,
        exitCodeError: 9,
        defaultHandlerTimeout: 50,
        globalTimeout: 200,
      });

      shutdown.registerHandler({
        name: 'test-handler',
        priority: 1,
        timeout: 50,
        handler: () => {
          writeFileSync(marker, 'cleanup-complete');
          return Promise.resolve();
        },
      });

      shutdown.setupSignalHandlers();
      process.emit('uncaughtException', new Error('fatal-sentinel'));
    `;

    const result = runTsxProbeProcess(tsxScript, { MARKER_PATH: markerPath });
    const markerContent = existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : null;
    if (existsSync(markerPath)) {
      unlinkSync(markerPath);
    }

    expect(result.status).toBe(9);
    expect(markerContent).not.toBeNull();
    expect(markerContent).toBe('cleanup-complete');
  });
});
