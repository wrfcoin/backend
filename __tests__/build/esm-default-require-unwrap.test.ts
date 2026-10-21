/**
 * Regression for backend#1218: iot crashed at startup in the shared bundle with
 *
 *   TypeError: ProductionCORSCleanup2.autoConfigureCORS is not a function
 *
 * `middleware/production-cors-cleanup.js` and `middleware/security-standardization.js`
 * are ESM (`"type": "module"`) with a single `export default` class. A CJS
 * `require()` of such a module returns the module NAMESPACE, `{ default: Class }`,
 * both in esbuild's bundle (`__toCommonJS(..._exports)`, which infra's
 * `esbuild-backend.sh` ships) and under ts-jest. The static methods live on
 * `.default`, so a call site that binds the raw `require()` result gets
 * `undefined` for every method.
 *
 * The bug stayed hidden until infra#984 switched the image entry from the
 * deleted `iot_sensor_networks_server_fixed.ts` to `iot_sensor_networks_server.js`.
 *
 * The test has two parts:
 *   1. It pins the interop shape: the raw require has no static methods and
 *      `.default` has them. If the modules ever become CJS, this fails and the
 *      guard below should be revisited.
 *   2. A source guard: every `server/` file that requires one of these modules
 *      must unwrap `.default`, either directly or through a `?.default` fallback
 *      on the bound variable.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SERVER_DIR = path.join(REPO_ROOT, 'server');

// ESM modules with a default-only export whose static methods the servers call.
const ESM_DEFAULT_MODULES: Record<string, string> = {
  'production-cors-cleanup': 'autoConfigureCORS',
  'security-standardization': 'getSecurityMiddleware',
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '__tests__' || name === 'compiled') continue;
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(c?js|ts)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(full);
  }
  return out;
}

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findViolations(): { sites: number; violations: Violation[] } {
  const names = Object.keys(ESM_DEFAULT_MODULES).join('|');
  // Matches: [const|let|var] <ident> = require('<...>/middleware/<name>[.js]')<rest>
  const requireRe = new RegExp(
    String.raw`(?:(?:const|let|var)\s+(\w+)\s*=\s*)?require\(\s*['"][^'"]*\/middleware\/(?:${names})(?:\.js)?['"]\s*\)(\s*\??\.\s*default)?`,
    'g',
  );
  const violations: Violation[] = [];
  let sites = 0;
  for (const file of listSourceFiles(SERVER_DIR)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(requireRe)) {
      sites += 1;
      const [whole, boundVar, unwrapped] = m;
      if (unwrapped) continue;
      // Allowed: `const mod = require(...)` followed by `mod?.default` / `mod.default`.
      if (boundVar && new RegExp(String.raw`\b${boundVar}\s*\??\.\s*default\b`).test(src)) {
        continue;
      }
      const line = src.slice(0, m.index).split('\n').length;
      violations.push({ file: path.relative(REPO_ROOT, file), line, text: whole.trim() });
    }
  }
  return { sites, violations };
}

describe('ESM default-only middleware required from CJS server code (#1218)', () => {
  it.each(Object.entries(ESM_DEFAULT_MODULES))(
    'require("middleware/%s") is a namespace: %s lives on .default, not on the raw result',
    (moduleName, method) => {

      const raw = require(`../../middleware/${moduleName}.js`);
      expect(typeof raw[method]).toBe('undefined');
      expect(typeof raw.default?.[method]).toBe('function');
    },
  );

  it('every server/ require of those modules unwraps .default', () => {
    const { sites, violations } = findViolations();
    // The retired storage-network JS service contributed one site; retain the nine remaining
    // sites as the non-vacuity floor, plus the named shipped-entry checks below.
    expect(sites).toBeGreaterThanOrEqual(9);
    expect(violations).toEqual([]);
  });

  it('the iot and governance bundle entries are among the scanned call sites', () => {
    for (const rel of ['server/iot_sensor_networks_server.js', 'server/governance_server.js']) {
      const src = readFileSync(path.join(REPO_ROOT, rel), 'utf8');
      expect(src).toMatch(/require\(\s*['"]\.\.\/middleware\/[\w-]+['"]\s*\)\.default/);
    }
  });
});
