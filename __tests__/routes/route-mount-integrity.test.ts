/**
 * Mount integrity for every `safeMount`ed router (backend#920).
 *
 * ## The failure this exists to catch
 *
 * `safeMount` (server/enhanced_unified_api_optimized.ts) wraps its `require` in
 * a try/catch and, on failure, logs `appLogger.warn('Route mount skipped: …')`
 * and carries on:
 *
 * ```ts
 * } catch (e) {
 *   appLogger.warn(`Route mount skipped: ${mountPath}`, { ... });
 * }
 * ```
 *
 * So a route module that cannot be resolved does not crash the server and does
 * not fail a health check. The router is simply never mounted, and **every
 * endpoint under that mount path returns 404** while the service reports itself
 * healthy. The only signal is one `warn` line in the startup log.
 *
 * That is exactly what #920 shipped: `server/routes/governance-routes.ts`
 * imported `'../../utils/api-error.js'`. The file lives in `server/routes/`, so
 * `../../utils/` is the **repo root**, which has no `utils/` directory — the
 * real module is `server/utils/api-error.ts`, one level up, not two. Result:
 * `safeMount('/api/governance', './routes/governance-routes')` threw
 * MODULE_NOT_FOUND, was swallowed as a warn, and the entire governance API
 * 404'd in production.
 *
 * Nothing in the existing suite would have caught it:
 *
 * - Jest's `moduleNameMapper` strips the `.js` suffix but does not change the
 *   `../../` prefix, so the specifier is just as unresolvable under test.
 * - ts-jest runs with `diagnostics: false` and `isolatedModules: true`, so the
 *   TS2307 that `tsc --noEmit` would report never surfaces during `npm test`.
 * - No suite imported `governance-routes` at all.
 *
 * ## Why this test is static
 *
 * It resolves specifiers on disk rather than `require()`-ing the routers.
 * Actually loading 40+ route modules would open database and Redis handles and
 * make the check flaky and slow — and a flaky mount check gets quarantined,
 * which is how the guarantee would be lost again. Reading the import graph is
 * deterministic, needs no services, and is precisely the property that broke.
 */

import fs from 'fs';
import path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SERVER_FILE = path.join(REPO_ROOT, 'server/enhanced_unified_api_optimized.ts');
const SERVER_DIR = path.dirname(SERVER_FILE);

/** Extensions `require`/ts-jest will try, in the order they are attempted. */
const CANDIDATE_EXTENSIONS = ['.cjs', '.ts', '.tsx', '.js', '.jsx', '.json', '.mjs'];

/** Resolve a relative specifier to a real file, mimicking Node/ts-jest lookup. */
function resolveSpecifier(fromDir: string, specifier: string): string | null {
  // Jest's moduleNameMapper rewrites '^(\.{1,2}/.*)\.js$' -> '$1', so a '.js'
  // suffix is advisory. Try the literal path first, then the stripped form.
  const literal = path.resolve(fromDir, specifier);
  const stripped = specifier.endsWith('.js')
    ? path.resolve(fromDir, specifier.slice(0, -3))
    : null;

  // A `.cjs` specifier that has no `.cjs` in the SOURCE tree is not broken: the
  // build emits `x.cjs` beside a CommonJS `x.js` (see
  // scripts/copy-build-assets.mjs), and route modules legitimately point at the
  // emitted shim — `server/routes/pythia-routes.ts` imports
  // '../../middleware/rateLimiting.cjs', which resolves only post-build.
  //
  // Accepting the `.js` peer here is not a weakening: this suite asserts
  // SOURCE-tier resolvability, and whether the shim really exists in the
  // artifact is exactly what the build-tier suites verify
  // (__tests__/build/route-mount-artifact.test.ts and the safe-mount audit,
  // which reports /api/pythia REACHABLE 200).
  const cjsSourcePeer = specifier.endsWith('.cjs')
    ? path.resolve(fromDir, `${specifier.slice(0, -4)}.js`)
    : null;

  for (const base of [literal, stripped, cjsSourcePeer].filter(Boolean) as string[]) {
    if (fs.existsSync(base) && fs.statSync(base).isFile()) return base;
    for (const ext of CANDIDATE_EXTENSIONS) {
      if (fs.existsSync(base + ext)) return base + ext;
    }
    // Directory with an index file.
    if (fs.existsSync(base) && fs.statSync(base).isDirectory()) {
      for (const ext of CANDIDATE_EXTENSIONS) {
        const idx = path.join(base, `index${ext}`);
        if (fs.existsSync(idx)) return idx;
      }
    }
  }
  return null;
}

/** Every `safeMount('<mountPath>', '<modulePath>')` in the server entrypoint. */
function readSafeMounts(): Array<{ mountPath: string; modulePath: string }> {
  const source = fs.readFileSync(SERVER_FILE, 'utf8');
  const pattern = /safeMount\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
  const mounts: Array<{ mountPath: string; modulePath: string }> = [];
  for (const match of source.matchAll(pattern)) {
    mounts.push({ mountPath: match[1], modulePath: match[2] });
  }
  return mounts;
}

/**
 * Known-broken mounts that are already dead on `main`, with the reason.
 *
 * Deliberately an explicit allowlist rather than a softened assertion: each
 * entry is a route that returns 404 in production **today**, recorded so this
 * suite reflects the real state of the tree while still failing loudly for any
 * *new* breakage. Fixing one means deleting its line.
 */
const KNOWN_BROKEN_MOUNTS: Record<string, string> = {};

/**
 * Strip comments so documentation examples are not mistaken for real imports.
 *
 * `alignment-kpi-routes.ts` carries a JSDoc usage example containing
 * `require('./routes/alignment-kpi-routes')`. Scanning raw text reports that as
 * a broken import — a false positive that would train readers to ignore this
 * suite, which is worse than not having it.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*)/.test(line))
    .join('\n');
}

/** Relative import/require specifiers in a source file. */
function readRelativeSpecifiers(file: string): string[] {
  const source = stripComments(fs.readFileSync(file, 'utf8'));
  const specifiers = new Set<string>();

  const patterns = [
    /(?:^|[^.\w])import\s+(?:[\w*{}\n\r\t,\s]+\s+from\s+)?['"](\.[^'"]+)['"]/g,
    /(?:^|[^.\w])export\s+(?:[\w*{}\n\r\t,\s]+\s+from\s+)['"](\.[^'"]+)['"]/g,
    /\brequire\(\s*['"](\.[^'"]+)['"]\s*\)/g,
    /\bimport\(\s*['"](\.[^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1]);
  }
  return [...specifiers];
}

describe('safeMount route integrity (#920)', () => {
  const mounts = readSafeMounts();

  it('finds the safeMount table (guards against the parser silently matching nothing)', () => {
    // A regex that quietly matched zero mounts would make every assertion below
    // vacuously pass — the test would go green precisely when it stopped working.
    expect(mounts.length).toBeGreaterThan(10);
  });

  it('mounts /api/governance, the route that 404d behind a warn in #920', () => {
    const governance = mounts.find((m) => m.mountPath === '/api/governance');
    expect(governance).toBeDefined();

    const resolved = resolveSpecifier(SERVER_DIR, governance!.modulePath);
    expect(resolved).not.toBeNull();
  });

  describe.each(readSafeMounts())('$mountPath -> $modulePath', ({ mountPath, modulePath }) => {
    it('resolves its route module', () => {
      const resolved = resolveSpecifier(SERVER_DIR, modulePath);
      // The failure message is the whole value of this test: safeMount swallows
      // the throw as a warn, so the operator-visible symptom is a silent 404.
      expect(
        resolved !== null
          ? 'resolved'
          : `safeMount('${mountPath}', '${modulePath}') cannot be resolved. safeMount would ` +
            `swallow this as a warn and EVERY endpoint under ${mountPath} would return 404 ` +
            `while the service reported healthy.`,
      ).toBe('resolved');
    });

    const known = KNOWN_BROKEN_MOUNTS[mountPath];
    const check = known ? it.failing : it;

    check(`resolves every relative import inside that route module${known ? ` [known broken: ${known}]` : ''}`, () => {
      const resolved = resolveSpecifier(SERVER_DIR, modulePath);
      if (resolved === null) return; // reported by the test above

      const broken: string[] = [];
      for (const specifier of readRelativeSpecifiers(resolved)) {
        if (resolveSpecifier(path.dirname(resolved), specifier) === null) {
          broken.push(specifier);
        }
      }

      expect(
        broken.length === 0
          ? 'all imports resolve'
          : `${path.relative(REPO_ROOT, resolved)} has unresolvable relative import(s): ` +
            `${broken.join(', ')}. Requiring it throws MODULE_NOT_FOUND, safeMount catches ` +
            `that as a warn, and every endpoint under ${mountPath} returns 404.`,
      ).toBe('all imports resolve');
    });
  });
});

describe('api-error utility location (#920 regression anchor)', () => {
  // The specific mistake, pinned: the helper lives one level up from
  // server/routes/, not two. Stated as a fact about the tree so a future move
  // of api-error.* fails here with an explanation rather than as a mystery
  // 404 in production.
  it('lives at server/utils/, so server/routes/ reaches it with ../utils', () => {
    expect(fs.existsSync(path.join(REPO_ROOT, 'server/utils/api-error.ts'))).toBe(true);
    expect(fs.existsSync(path.join(REPO_ROOT, 'utils/api-error.ts'))).toBe(false);
    expect(fs.existsSync(path.join(REPO_ROOT, 'utils/api-error.js'))).toBe(false);
  });

  it('is imported with ../utils by every route module that uses it', () => {
    const routesDir = path.join(REPO_ROOT, 'server/routes');
    const offenders: string[] = [];

    for (const entry of fs.readdirSync(routesDir)) {
      if (!/\.(ts|js|cjs|mjs)$/.test(entry)) continue;
      const source = fs.readFileSync(path.join(routesDir, entry), 'utf8');
      for (const match of source.matchAll(/['"](\.\.\/[^'"]*api-error[^'"]*)['"]/g)) {
        const specifier = match[1];
        if (resolveSpecifier(routesDir, specifier) === null) {
          offenders.push(`${entry}: ${specifier}`);
        }
      }
    }

    expect(
      offenders.length === 0
        ? 'all api-error imports resolve'
        : `route module(s) import api-error by a path that does not resolve: ${offenders.join(', ')}`,
    ).toBe('all api-error imports resolve');
  });
});
