/**
 * CI guard for the publishable @wrfcoin/generated-types npm package (#698).
 *
 * Issue #698 requires shared/generated-types/ to be shippable as a real npm
 * package so the (independent) frontend repo can import a single source of
 * truth instead of re-declaring weather/environmental types. This test locks
 * in the package manifest shape AND proves the package actually builds and
 * packs into a tarball that contains compiled declarations (never raw sources).
 *
 * Complements __tests__/meteo-types-bindings.test.ts (#341), which guards the
 * binding contents; this file guards the packaging/publishability contract.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const BACKEND_ROOT = path.join(__dirname, '..');
const PKG_DIR = path.join(BACKEND_ROOT, 'shared', 'generated-types');
const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, 'package.json'), 'utf-8'));

describe('@wrfcoin/generated-types package manifest (#698)', () => {
  it('keeps the canonical package name but is never published to public npm', () => {
    // Owner ruling 2026-10-03: distribute by tarball or git path, or private
    // packages. private:true makes `npm publish` refuse; `npm pack` still works.
    expect(pkg.name).toBe('@wrfcoin/generated-types');
    expect(pkg.private).toBe(true);
    expect(pkg.publishConfig?.access).not.toBe('public');
  });

  it('is an ESM package whose entrypoints resolve to compiled dist output', () => {
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
    expect(pkg.exports['.'].types).toBe('./dist/index.d.ts');
    expect(pkg.exports['.'].import).toBe('./dist/index.js');
    // Per-binding deep imports (e.g. @wrfcoin/generated-types/WeatherObservation)
    expect(pkg.exports['./*'].types).toBe('./dist/*.d.ts');
  });

  it('ships only compiled output (dist + README), not raw sources', () => {
    expect(pkg.files).toContain('dist');
    expect(pkg.files).not.toContain('*.ts');
  });

  it('builds via tsc and rebuilds before publish', () => {
    expect(pkg.scripts?.build).toContain('tsc');
    expect(pkg.scripts?.prepublishOnly).toContain('build');
    expect(pkg.devDependencies?.typescript).toBeDefined();
  });

  it('has a README documenting installation and usage', () => {
    const readme = fs.readFileSync(path.join(PKG_DIR, 'README.md'), 'utf-8');
    expect(readme).toContain('@wrfcoin/generated-types');
    expect(readme).toMatch(/never published to public npm/i);
    expect(readme).not.toMatch(/^npm install @wrfcoin\/generated-types\s*$/m);
    // npm cannot install a subdirectory of a git repository, and a repo-root git URL would install
    // the whole backend, not this package (SOL-W2 P2 on backend#1446). The documented route is the tarball.
    expect(readme).not.toMatch(/git\+https?:\/\/[^\s"]*wrfcoin\/backend/);
    expect(readme).toMatch(/npm pack/);
  });

  it('declares a declaration-emitting build config', () => {
    const tsconfig = JSON.parse(
      fs.readFileSync(path.join(PKG_DIR, 'tsconfig.build.json'), 'utf-8'),
    );
    expect(tsconfig.compilerOptions.declaration).toBe(true);
    expect(tsconfig.compilerOptions.outDir).toBe('./dist');
  });
});

describe('@wrfcoin/generated-types build + pack (#698)', () => {
  const tscBin = path.join(
    BACKEND_ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'tsc.cmd' : 'tsc',
  );
  const distDir = path.join(PKG_DIR, 'dist');

  afterAll(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('compiles to .d.ts + .js declarations under dist/', () => {
    if (!fs.existsSync(tscBin)) {
      console.warn(`[generated-types] tsc not found at ${tscBin}; skipping build assertion`);
      return;
    }
    fs.rmSync(distDir, { recursive: true, force: true });
    execFileSync(tscBin, ['-p', 'tsconfig.build.json'], { cwd: PKG_DIR, stdio: 'pipe' });

    for (const f of ['index.d.ts', 'index.js', 'WeatherObservation.d.ts']) {
      expect(fs.existsSync(path.join(distDir, f))).toBe(true);
    }
    // index.js is a type-only barrel; it must emit a valid (empty) ES module.
    expect(fs.readFileSync(path.join(distDir, 'index.js'), 'utf-8')).toContain('export {}');
  }, 120_000);

  it('packs a tarball with compiled declarations and no raw sources', () => {
    if (!fs.existsSync(path.join(distDir, 'index.d.ts'))) {
      console.warn('[generated-types] dist missing (build skipped); skipping pack assertion');
      return;
    }
    const out = execFileSync(
      'npm',
      ['pack', '--dry-run', '--ignore-scripts', '--json'],
      { cwd: PKG_DIR, encoding: 'utf-8' },
    );
    const entry = JSON.parse(out)[0];
    const names: string[] = entry.files.map((f: { path: string }) => f.path);

    expect(entry.name).toBe('@wrfcoin/generated-types');
    expect(names).toContain('dist/index.d.ts');
    expect(names).toContain('dist/index.js');
    expect(names).toContain('README.md');
    // No raw TypeScript sources (only compiled *.d.ts) should ship.
    const rawSources = names.filter(
      (n) => n.startsWith('dist/') && n.endsWith('.ts') && !n.endsWith('.d.ts'),
    );
    expect(rawSources).toEqual([]);
  }, 120_000);
});
