/**
 * Build-tier mount reachability (backend#935).
 *
 * The companion to `__tests__/routes/route-mount-integrity.test.ts`, one layer
 * deeper. That suite proves every `safeMount`ed router resolves **in the source
 * tree, through Jest's resolver**. This one proves it resolves **in the compiled
 * artifact, through Node's resolver** — which is the thing that actually runs.
 *
 * ## Why the source-tier test was not enough
 *
 * `server/routes/governance-routes.ts` imported `api-error` from the wrong depth;
 * that was fixed and the source-tier test pins it. But the built router was
 * *still* unreachable, for an unrelated reason the source tree cannot express:
 *
 *   SyntaxError: The requested module '../server/utils/error-response.js'
 *   does not provide an export named 'default'
 *
 * `server/utils/error-response.js` is CommonJS. The package is `"type": "module"`,
 * so in `dist/` that `.js` specifier names an **ESM** file whose `module.exports`
 * provides no bindings. The build emits a `.cjs` shim for exactly this reason,
 * but only rewrote `require()` specifiers — an ESM `import ... from './x.js'`
 * was copied verbatim.
 *
 * `safeMount` then did what it always does: caught the load error, logged a warn,
 * and left `/api/governance` unmounted. A production-shaped request returned
 * `{"error":"catch-all"}` with status 404 while the service reported healthy.
 *
 * The lesson is the `safeMount` one, one level deeper: **live file ≠ live code
 * path**, and now **source resolves ≠ build resolves**.
 *
 * ## Why an existence check would not have caught it
 *
 * Worth stating, because it is the trap: `dist/server/utils/error-response.js`
 * **exists**. Nothing is missing. The defect is that the file that exists is the
 * wrong *module format* for the way it is imported. So the invariant asserted
 * below is format compatibility, not presence.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DIST = path.join(REPO_ROOT, 'dist');
const COMPILED_ENTRY = path.join(
  DIST,
  'server/enhanced_unified_api_optimized.js',
);
const SOURCE_ENTRY = path.join(
  REPO_ROOT,
  'server/enhanced_unified_api_optimized.ts',
);

/**
 * The source-tier suite's `KNOWN_BROKEN_MOUNTS` is deliberately **not** mirrored
 * here, and the reason is worth recording rather than leaving as an omission.
 *
 * Its only entry is `/api/node-os` (backend#936), which is broken by a *missing
 * transitive require target* — `../../src/node_os/node_os_core` exists nowhere.
 * The assertion at this tier is whether the mount's own module was **emitted**,
 * and `node-os-routes.js` is emitted perfectly well. So the entry does not
 * transfer: marking it expected-to-fail here would assert a failure that does
 * not occur, and `it.failing` would then fail for being wrong.
 *
 * That is the general shape — an allowlist belongs to the property it excuses,
 * not to the mount. Any entry added here must be broken *at this tier*.
 */
const KNOWN_BROKEN_MOUNTS: Record<string, string> = {};

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

/**
 * Build if `dist/` is missing or older than the sources it is built from.
 *
 * A stale `dist/` is the vacuous-green risk here: the suite would pass against
 * yesterday's output and report reachability it never checked. The build takes
 * ~25s, so paying it on a real change is cheaper than trusting a stale artifact.
 */
function ensureFreshBuild(): void {
  const newestSource = newestMtime([
    path.join(REPO_ROOT, 'server'),
    path.join(REPO_ROOT, 'shared'),
    path.join(REPO_ROOT, 'scripts/copy-build-assets.mjs'),
    path.join(REPO_ROOT, 'tsconfig.json'),
  ]);
  const built = fs.existsSync(COMPILED_ENTRY)
    ? fs.statSync(COMPILED_ENTRY).mtimeMs
    : 0;

  if (built >= newestSource) return;

  execFileSync('npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function newestMtime(targets: string[]): number {
  let newest = 0;
  const visit = (p: string): void => {
    if (!fs.existsSync(p)) return;
    const stat = fs.statSync(p);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(p)) visit(path.join(p, entry));
    } else {
      newest = Math.max(newest, stat.mtimeMs);
    }
  };
  targets.forEach(visit);
  return newest;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Is this emitted file CommonJS (`module.exports`) rather than ESM? */
function isCommonJsOutput(file: string): boolean {
  const source = fs.readFileSync(file, 'utf8');
  if (/^\s*(import|export)\s/m.test(source)) return false;
  return /\b(require\s*\(|module\.exports|exports\.)/.test(source);
}

function isEsmOutput(file: string): boolean {
  return /^\s*(import|export)\s/m.test(fs.readFileSync(file, 'utf8'));
}

function collectJsFiles(dir: string): string[] {
  const found: string[] = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...collectJsFiles(full));
    else if (entry.isFile() && full.endsWith('.js')) found.push(full);
  }
  return found;
}

function requireUsage(file: string): {
  invokesRequire: boolean;
  hasTopLevelBinding: boolean;
} {
  const source = fs.readFileSync(file, 'utf8');
  const syntax = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let invokesRequire = false;

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'require'
    ) {
      invokesRequire = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(syntax);

  const hasTopLevelBinding = syntax.statements.some((statement) => {
    if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === 'require'
    ) {
      return true;
    }
    if (!ts.isVariableStatement(statement)) {
      return false;
    }
    return statement.declarationList.declarations.some(
      (declaration) =>
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === 'require',
    );
  });

  return { invokesRequire, hasTopLevelBinding };
}

/** Every `safeMount('<mount>', '<module>')` in the SOURCE entrypoint. */
function readSafeMounts(): Array<{ mountPath: string; modulePath: string }> {
  const source = fs.readFileSync(SOURCE_ENTRY, 'utf8');
  const pattern = /safeMount\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
  return [...source.matchAll(pattern)].map((m) => ({
    mountPath: m[1],
    modulePath: m[2],
  }));
}

// ---------------------------------------------------------------------------

describe('build-tier mount reachability (#935)', () => {
  beforeAll(() => {
    ensureFreshBuild();
  }, 600_000);

  it('produced the compiled entrypoint', () => {
    expect(fs.existsSync(COMPILED_ENTRY)).toBe(true);
  });

  /**
   * The class, asserted repo-wide across the artifact.
   *
   * An ESM module importing a CommonJS `.js` sibling is unloadable under
   * `"type": "module"`. The build emits a `.cjs` shim for those; the import must
   * point at it. This is the check that fails on the #935 defect — and note it
   * is a *format* check, because the `.js` file it pointed at did exist.
   */
  it('has no ESM import pointing at a CommonJS .js file', () => {
    const offenders: string[] = [];

    for (const file of collectJsFiles(DIST)) {
      if (!isEsmOutput(file)) continue;
      const fromDir = path.dirname(file);
      const source = fs.readFileSync(file, 'utf8');

      for (const match of source.matchAll(
        /(?:from|import)\s*\(?\s*(['"])(\.{1,2}\/[^'"]+)\.js\1/g,
      )) {
        const specifier = match[2];
        const target = path.join(fromDir, `${specifier}.js`);
        if (!fs.existsSync(target) || !isCommonJsOutput(target)) continue;

        const shim = path.join(fromDir, `${specifier}.cjs`);
        offenders.push(
          `${path.relative(REPO_ROOT, file)} imports '${specifier}.js', which is CommonJS` +
            (fs.existsSync(shim)
              ? ` — the emitted '${specifier}.cjs' shim exists and should be used instead`
              : ' — and no .cjs shim was emitted for it'),
        );
      }
    }

    expect(
      offenders.length === 0
        ? 'no ESM->CJS .js imports'
        : 'unloadable ESM->CommonJS imports in the build artifact. Node raises ' +
            '"does not provide an export named \'default\'"; safeMount swallows that as a ' +
            'warn and the affected routes 404 while the service reports healthy:\n  ' +
            offenders.join('\n  '),
    ).toBe('no ESM->CJS .js imports');
  });

  /**
   * TypeScript preserves hand-written require() calls in otherwise-ESM files.
   * Repointing one of those calls at a `.cjs` shim is still unloadable unless
   * the emitted ESM file creates a require function anchored at itself.
   */
  it('has no emitted ESM module that invokes an unbound require', () => {
    const offenders: string[] = [];

    for (const file of collectJsFiles(DIST)) {
      if (!isEsmOutput(file)) continue;
      const usage = requireUsage(file);
      if (!usage.invokesRequire || usage.hasTopLevelBinding) continue;

      offenders.push(path.relative(REPO_ROOT, file));
    }

    expect(
      offenders.length === 0
        ? 'no unbound require calls in emitted ESM'
        : 'emitted ESM modules invoke require() without a createRequire binding; ' +
            'Node raises "require is not defined", safeMount swallows it, and the ' +
            `affected routes become silent 404s:\n  ${offenders.join('\n  ')}`,
    ).toBe('no unbound require calls in emitted ESM');
  });

  /**
   * The executed proof, on the route that actually broke.
   *
   * Loads the compiled router the way `safeMount` does — `createRequire`
   * anchored at the real compiled entrypoint, `.cjs` first then the bare
   * specifier — mounts it behind a catch-all, and issues a production-shaped
   * request.
   *
   * `/delegations` with no query is chosen because the router answers it itself
   * with a 400 before touching the database, so reaching the router is
   * distinguishable from reaching the catch-all without needing Postgres.
   */
  it('reaches the governance router in the built artifact, not the catch-all', () => {
    // Delegated to a real Node subprocess. An earlier revision of this test did
    // the `createRequire` inline and was VACUOUS: Jest's resolver loaded a
    // `dist/` that real Node rejects, so the test passed on a build whose
    // governance route was still 404. Measured against an identical artifact —
    // in-Jest said "loaded", the subprocess said SyntaxError.
    //
    // Testing the build through Jest's resolver repeats, one level up, exactly
    // the mistake of testing the source tree and calling it production truth.
    const raw = execFileSync(
      'node',
      [path.join(__dirname, 'probe-governance-mount.mjs'), REPO_ROOT],
      { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );

    const lines = raw.trim().split('\n');
    const result = JSON.parse(lines[lines.length - 1]);

    expect(
      result.loaded === true
        ? 'router loaded'
        : 'the compiled governance router failed to load, so safeMount would leave ' +
            '/api/governance unmounted and every request under it would 404 while the ' +
            `service reported healthy: ${result.error}`,
    ).toBe('router loaded');

    expect(result.harnessError).toBeUndefined();
    expect(result.body).not.toEqual({ error: 'catch-all' });
    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      success: false,
      error: 'delegator query parameter is required',
    });
  }, 180_000);

  describe.each(readSafeMounts())('$mountPath', ({ mountPath, modulePath }) => {
    const known = KNOWN_BROKEN_MOUNTS[mountPath];
    const check = known ? it.failing : it;

    check(
      `is present in the build artifact${known ? ` [known broken: ${known}]` : ''}`,
      () => {
        const base = path.join(DIST, 'server', modulePath.replace(/^\.\//, ''));
        const resolved = ['.cjs', '.js', '/index.cjs', '/index.js']
          .map((suffix) => `${base}${suffix}`)
          .find((candidate) => fs.existsSync(candidate));

        expect(
          resolved !== undefined
            ? 'emitted'
            : `safeMount('${mountPath}', '${modulePath}') has no emitted counterpart under ` +
                'dist/server/. safeMount would swallow the load failure as a warn and every ' +
                `endpoint under ${mountPath} would 404 in production.`,
        ).toBe('emitted');
      },
    );
  });
});
