import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function writeRequiredRuntimeModules(root: string) {
  const hsmPath = path.join(root, 'security', 'hsm-secure-implementation.cjs');
  mkdirSync(path.dirname(hsmPath), { recursive: true });
  writeFileSync(hsmPath, 'module.exports = class SecureHSM {};\n');

  const indexPath = path.join(root, 'server/data/documentation-index.json');
  const documentPath = path.join(root, 'docs/runtime-fixture.md');
  mkdirSync(path.dirname(indexPath), { recursive: true });
  mkdirSync(path.dirname(documentPath), { recursive: true });
  writeFileSync(
    indexPath,
    JSON.stringify([
      {
        id: 'runtime-fixture',
        title: 'Runtime fixture',
        path: 'docs/runtime-fixture.md',
      },
    ]),
  );
  writeFileSync(documentPath, '# Runtime fixture\n');
}

describe('copy-build-assets', () => {
  it('emits a legacy dist/server.cjs shim for N5 testnet commands', () => {
    const tempDir = mkdtempSync(
      path.join(tmpdir(), 'wrfcoin-copy-build-assets-'),
    );
    const scriptPath = path.resolve(
      __dirname,
      '..',
      'scripts/copy-build-assets.mjs',
    );

    try {
      writeRequiredRuntimeModules(tempDir);
      execFileSync(process.execPath, [scriptPath], {
        cwd: tempDir,
        stdio: 'pipe',
      });

      const shim = readFileSync(path.join(tempDir, 'dist/server.cjs'), 'utf8');
      expect(shim).toContain('./server/enhanced_unified_api_optimized.js');
      expect(shim).toContain('failed to start optimized API entrypoint');
      expect(
        readFileSync(
          path.join(tempDir, 'dist/security/hsm-secure-implementation.cjs'),
          'utf8',
        ),
      ).toContain('class SecureHSM');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('repairs require interop uniformly in emitted ESM', () => {
    const tempDir = mkdtempSync(
      path.join(tmpdir(), 'wrfcoin-copy-build-assets-'),
    );
    const scriptPath = path.resolve(
      __dirname,
      '..',
      'scripts/copy-build-assets.mjs',
    );
    const routeDir = path.join(tempDir, 'dist/server/routes');
    const middlewareDir = path.join(tempDir, 'dist/server/middleware');

    try {
      writeRequiredRuntimeModules(tempDir);
      mkdirSync(routeDir, { recursive: true });
      mkdirSync(middlewareDir, { recursive: true });
      writeFileSync(
        path.join(routeDir, 'fixture.js'),
        `export function loadLegacy() {
  return require('../middleware/legacy.js');
}
`,
      );
      writeFileSync(
        path.join(middlewareDir, 'legacy.cjs'),
        'module.exports = { loaded: true };\n',
      );

      execFileSync(process.execPath, [scriptPath], {
        cwd: tempDir,
        stdio: 'pipe',
      });

      const output = readFileSync(path.join(routeDir, 'fixture.js'), 'utf8');
      expect(output).toContain(
        'import { createRequire as __wrfBuildCreateRequire } from \'node:module\';',
      );
      expect(output).toContain(
        'const require = __wrfBuildCreateRequire(import.meta.url);',
      );
      expect(output).toContain('require(\'../middleware/legacy.cjs\')');
      expect(output).not.toContain('require(\'../middleware/legacy.js\')');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed when a required runtime-only module is absent', () => {
    const tempDir = mkdtempSync(
      path.join(tmpdir(), 'wrfcoin-copy-build-assets-'),
    );
    const scriptPath = path.resolve(
      __dirname,
      '..',
      'scripts/copy-build-assets.mjs',
    );

    try {
      expect(() =>
        execFileSync(process.execPath, [scriptPath], {
          cwd: tempDir,
          stdio: 'pipe',
        }),
      ).toThrow('security/hsm-secure-implementation.cjs');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('fails closed when an indexed documentation asset is absent', () => {
    const tempDir = mkdtempSync(
      path.join(tmpdir(), 'wrfcoin-copy-build-assets-'),
    );
    const scriptPath = path.resolve(
      __dirname,
      '..',
      'scripts/copy-build-assets.mjs',
    );

    try {
      writeRequiredRuntimeModules(tempDir);
      rmSync(path.join(tempDir, 'docs/runtime-fixture.md'));
      expect(() =>
        execFileSync(process.execPath, [scriptPath], {
          cwd: tempDir,
          stdio: 'pipe',
        }),
      ).toThrow(
        'required documentation runtime asset is missing: docs/runtime-fixture.md',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
