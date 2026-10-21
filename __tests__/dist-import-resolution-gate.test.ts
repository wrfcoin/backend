/**
 * #1042 — the build gate that stops a route shipping without its compiled
 * service.
 *
 * Tonight's defect shape, exactly: dist contained
 * `server/routes/weather-routes.cjs` (copied by copy-build-assets) whose
 * `await import('../services/station-registration-service.js')` pointed at a
 * tsc emit that was not in the image. Both station endpoints 500ed at first
 * request with a swallowed ERR_MODULE_NOT_FOUND.
 *
 * These tests spawn the REAL gate script (`scripts/verify-dist-import-resolution.mjs`,
 * now part of `npm run build`) against fixture dist trees. They are RED on any
 * tree that lacks the script or whose script stops detecting the dangling
 * import — no handler mirrors, per the repeated mirror-test failure mode.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(
  __dirname,
  '..',
  'scripts',
  'verify-dist-import-resolution.mjs',
);

function runGate(distDir: string, baselineFile?: string) {
  const baseline =
    baselineFile ?? path.join(path.dirname(distDir), 'empty-baseline.json');
  if (!baselineFile) {
    writeFileSync(baseline, '[]');
  }
  const result = spawnSync(
    process.execPath,
    [SCRIPT, '--dist', distDir, '--baseline', baseline],
    { encoding: 'utf8' },
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

describe('verify-dist-import-resolution build gate (#1042)', () => {
  let fixtureRoot: string;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'dist-gate-'));
  });

  afterEach(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function writeFixture(files: Record<string, string>): string {
    const dist = path.join(fixtureRoot, 'dist');
    for (const [rel, content] of Object.entries(files)) {
      const p = path.join(dist, rel);
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(p, content);
    }
    return dist;
  }

  it('fails the build when a route dynamically imports a service missing from dist (the #1042 shape)', () => {
    const dist = writeFixture({
      'server/routes/weather-routes.cjs': `
        async function getStationService() {
          return await import('../services/station-registration-service.js');
        }
        module.exports = { getStationService };
      `,
      // NOTE: server/services/station-registration-service.js deliberately absent.
    });

    const { status, stderr } = runGate(dist);

    expect(status).toBe(1);
    expect(stderr).toContain('station-registration-service.js');
    expect(stderr).toContain('weather-routes.cjs');
    expect(stderr).toContain('ERR_MODULE_NOT_FOUND');
  });

  it('fails on a dangling static import and a dangling require too', () => {
    const dist = writeFixture({
      'a.js': 'import { x } from \'./gone-esm.js\';',
      'b.cjs': 'const y = require(\'./gone-cjs.cjs\');',
    });

    const { status, stderr } = runGate(dist);

    expect(status).toBe(1);
    expect(stderr).toContain('gone-esm.js');
    expect(stderr).toContain('gone-cjs.cjs');
  });

  it('passes when every relative import resolves', () => {
    const dist = writeFixture({
      'server/routes/weather-routes.cjs': `
        async function getStationService() {
          return await import('../services/station-registration-service.js');
        }
        module.exports = { getStationService };
      `,
      'server/services/station-registration-service.js': 'export const registerStation = () => {};',
    });

    const { status, stdout } = runGate(dist);

    expect(status).toBe(0);
    expect(stdout).toContain('all relative imports resolve');
  });

  it('fails when an import resolves outside dist even if the build host has the target (#1043)', () => {
    const dist = writeFixture({
      'blockchain/signers/hsm-signer.js': 'const SecureHSM = require(\'../../../security/hsm-secure-implementation.cjs\');',
    });
    const hostOnlyTarget = path.join(
      fixtureRoot,
      'security',
      'hsm-secure-implementation.cjs',
    );
    mkdirSync(path.dirname(hostOnlyTarget), { recursive: true });
    writeFileSync(hostOnlyTarget, 'module.exports = class SecureHSM {};');

    const { status, stderr } = runGate(dist);

    expect(status).toBe(1);
    expect(stderr).toContain('escape the runtime dist boundary');
    expect(stderr).toContain('hsm-secure-implementation.cjs');
  });

  it('never allows a baseline entry to excuse a dist-escaping import', () => {
    const dist = writeFixture({
      'server/routes/data-quality-routes.js': 'const { logger } = require(\'../../../utils/logger.js\');',
    });
    const hostOnlyTarget = path.join(fixtureRoot, 'utils', 'logger.js');
    mkdirSync(path.dirname(hostOnlyTarget), { recursive: true });
    writeFileSync(hostOnlyTarget, 'export const logger = {};');
    const baseline = path.join(fixtureRoot, 'baseline.json');
    writeFileSync(
      baseline,
      JSON.stringify([
        {
          file: 'server/routes/data-quality-routes.js',
          spec: '../../../utils/logger.js',
        },
      ]),
    );

    const { status, stderr } = runGate(dist, baseline);

    expect(status).toBe(1);
    expect(stderr).toContain('escape the runtime dist boundary');
  });

  it('excuses a baselined pre-existing finding but fails on a NEW one (ratchet)', () => {
    const dist = writeFixture({
      'legacy/old-server.js': 'const m = require(\'./gone-legacy.js\');',
      'server/routes/weather-routes.cjs': 'import(\'../services/station-registration-service.js\');',
    });
    const baseline = path.join(fixtureRoot, 'baseline.json');
    writeFileSync(
      baseline,
      JSON.stringify([
        { file: 'legacy/old-server.js', spec: './gone-legacy.js' },
      ]),
    );

    const { status, stderr } = runGate(dist, baseline);

    expect(status).toBe(1);
    expect(stderr).toContain('station-registration-service.js'); // new finding fails
    expect(stderr).not.toContain('gone-legacy.js'); // baselined finding excused
  });

  it('fails when a baseline entry goes stale — exemptions retire with the fix', () => {
    const dist = writeFixture({
      'fine.js': 'export const ok = 1;',
    });
    const baseline = path.join(fixtureRoot, 'baseline.json');
    writeFileSync(
      baseline,
      JSON.stringify([
        { file: 'legacy/old-server.js', spec: './gone-legacy.js' },
      ]),
    );

    const { status, stderr } = runGate(dist, baseline);

    expect(status).toBe(1);
    expect(stderr).toContain('no longer occur');
  });

  it('ignores bare package specifiers and commented-out imports', () => {
    const dist = writeFixture({
      'ok.js': `
        import express from 'express';
        const mod = require('some-package/deep/path.js');
        // const dead = require('./commented-away.js');
        /* import('./also-commented.js') */
        export const ok = true;
      `,
    });

    const { status } = runGate(dist);

    expect(status).toBe(0);
  });

  it('resolves extensionless specifiers node-style (.ext and index probes) instead of skipping them', () => {
    const dist = writeFixture({
      'ok.js': `
        const byExt = require('./sibling');
        const byIndex = require('./lib');
        export const ok = true;
      `,
      'sibling.js': 'module.exports = {};',
      'lib/index.cjs': 'module.exports = {};',
    });

    const { status } = runGate(dist);

    expect(status).toBe(0);
  });

  it('fails when an extensionless specifier resolves to nothing in dist', () => {
    const dist = writeFixture({
      'server/routes/broken.js': `
        const missing = require('../services/never-emitted');
        module.exports = { missing };
      `,
    });

    const { status, stderr } = runGate(dist);

    expect(status).toBe(1);
    expect(stderr).toContain('do not resolve');
    expect(stderr).toContain('never-emitted');
  });

  it('fails when an extensionless specifier escapes the dist boundary (the #1043 shape the old filter missed)', () => {
    const dist = writeFixture({
      'server/services/escaper.js': `
        const { logger } = require('../../../utils/logger');
        module.exports = { logger };
      `,
    });

    const { status, stderr } = runGate(dist);

    expect(status).toBe(1);
    expect(stderr).toContain('escape the runtime dist boundary');
  });
});
