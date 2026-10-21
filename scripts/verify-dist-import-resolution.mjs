/**
 * Build gate for #1042: every relative import in dist must resolve inside dist.
 *
 * The failure class this stops: a CJS route file is copied into dist by
 * copy-build-assets.mjs and dynamically imports an ESM service
 * (`await import('../services/station-registration-service.js')`) whose only
 * source is a `.ts`. If the tsc emit for that service is missing from the
 * image — wrong tsconfig include, a deploy that copied routes without running
 * tsc, a renamed service — the route ships anyway and every request to it
 * dies at runtime with ERR_MODULE_NOT_FOUND, swallowed into a generic 500.
 * That exact skew took down station registration AND credential listing
 * (wrfcoin/backend#1042) and was only diagnosable from inside the container.
 *
 * This script fails the BUILD instead: after `tsc && copy-build-assets`, scan
 * every .js/.mjs/.cjs under dist, extract relative specifiers from static
 * imports, dynamic import() calls and require() calls, and verify the target
 * file exists. Any dangling specifier is a hard error.
 *
 * Pre-existing debt is held in a ratchet baseline
 * (scripts/dist-import-resolution-baseline.json): findings listed there pass,
 * any NEW finding fails the build, and a baseline entry that no longer occurs
 * also fails so the exemption is retired with the fix instead of rotting.
 *
 * Usage: node scripts/verify-dist-import-resolution.mjs [--dist <dir>] [--baseline <file>]
 */

import {
  readdirSync,
  readFileSync,
  existsSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const distFlag = args.indexOf("--dist");
const distDir = distFlag !== -1 ? args[distFlag + 1] : "dist";
const distRoot = path.resolve(distDir);
const baselineFlag = args.indexOf("--baseline");
const baselinePath =
  baselineFlag !== -1
    ? args[baselineFlag + 1]
    : path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "dist-import-resolution-baseline.json",
      );

/** (file-relative-to-dist, specifier) pairs excused as pre-existing debt. */
function loadBaseline() {
  if (!existsSync(baselinePath)) {
    return [];
  }
  const entries = JSON.parse(readFileSync(baselinePath, "utf8"));
  if (
    !Array.isArray(entries) ||
    entries.some(
      (e) => typeof e.file !== "string" || typeof e.spec !== "string",
    )
  ) {
    console.error(
      `verify-dist-import-resolution: malformed baseline at ${baselinePath}`,
    );
    process.exit(2);
  }
  return entries;
}

const baselineKey = (file, spec) => `${file} => ${spec}`;

if (!existsSync(distRoot) || !statSync(distRoot).isDirectory()) {
  console.error(
    `verify-dist-import-resolution: dist directory not found: ${distDir}`,
  );
  process.exit(2);
}

/** Recursively collect .js/.mjs/.cjs files under dir. */
function collectModuleFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectModuleFiles(p));
    } else if (entry.isFile() && /\.(js|mjs|cjs)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * Extract relative module specifiers from source text.
 *
 * Matches, in both quote styles:
 *   import ... from './x.js'   export ... from './x.js'
 *   import('./x.js')           require('./x.js')
 * Every specifier starting with './' or '../' is checked. Extensionless
 * specifiers are resolved node-style (exact file, then .js/.cjs/.mjs/.json,
 * then index.* in a directory) — under this dist, 84% of relative requires
 * are extensionless, and an unexamined one shipped a real dist-boundary
 * escape. Only bare package names are out of scope.
 */
function extractRelativeSpecifiers(source) {
  // Strip comments so commented-out imports cannot produce false findings.
  // Crude but sufficient for emitted/derived code: removes /* ... */ and
  // line comments that do not sit inside string literals containing '//'
  // (URLs like 'https://' are protected by requiring whitespace or line
  // start before '//').
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");

  const specifiers = new Set();
  const patterns = [
    /(?:import|export)\s[^'"]*?from\s*['"]((?:\.\.?\/)[^'"]+)['"]/g,
    /import\s*\(\s*['"]((?:\.\.?\/)[^'"]+)['"]\s*\)/g,
    /require\s*\(\s*['"]((?:\.\.?\/)[^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) {
    for (const match of stripped.matchAll(re)) {
      specifiers.add(match[1]);
    }
  }
  return [...specifiers];
}

const CHECKED_EXTENSION = /\.(js|mjs|cjs|json)$/;
const EXTENSIONLESS_PROBES = [".js", ".cjs", ".mjs", ".json"];

function isFile(p) {
  return existsSync(p) && statSync(p).isFile();
}

/**
 * Resolve a relative specifier target the way node's CJS loader would:
 * exact file, then extension probes, then directory index probes.
 * Returns the resolved file path, or null if nothing exists.
 */
function resolveSpecifierTarget(target, spec) {
  if (CHECKED_EXTENSION.test(spec)) {
    return existsSync(target) ? target : null;
  }
  if (isFile(target)) {
    return target;
  }
  for (const ext of EXTENSIONLESS_PROBES) {
    if (isFile(target + ext)) {
      return target + ext;
    }
  }
  for (const ext of EXTENSIONLESS_PROBES) {
    const index = path.join(target, `index${ext}`);
    if (isFile(index)) {
      return index;
    }
  }
  return null;
}

const failures = [];
const boundaryEscapes = [];
const files = collectModuleFiles(distRoot);

function isOutsideDist(candidate) {
  const relative = path.relative(distRoot, candidate);
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const spec of extractRelativeSpecifiers(source)) {
    const target = path.resolve(path.dirname(file), spec);
    if (isOutsideDist(target)) {
      boundaryEscapes.push({ file, spec, target });
      continue;
    }
    const resolved = resolveSpecifierTarget(target, spec);
    if (resolved !== null && isOutsideDist(realpathSync(resolved))) {
      boundaryEscapes.push({ file, spec, target: realpathSync(resolved) });
    } else if (resolved === null) {
      const probed = CHECKED_EXTENSION.test(spec)
        ? target
        : `${target} (probed .js/.cjs/.mjs/.json and index.*)`;
      failures.push({ file, spec, target: probed });
    }
  }
}

// Boundary escapes are never baselineable. A build-host file outside dist is
// absent from the runtime image, so allowing an exemption would recreate #1043.
if (boundaryEscapes.length > 0) {
  console.error(
    `verify-dist-import-resolution: ${boundaryEscapes.length} relative import(s) ` +
      `escape the runtime dist boundary — this build depends on files the image does not copy (#1043):\n`,
  );
  for (const { file, spec, target } of boundaryEscapes) {
    console.error(
      `  ${file}\n    imports '${spec}'\n    -> outside dist: ${target}\n`,
    );
  }
  console.error(
    "Move each runtime module under dist and point the import at that emitted path. " +
      "Boundary escapes cannot be added to the missing-import baseline.",
  );
  process.exit(1);
}

const baseline = loadBaseline();
const baselineKeys = new Set(baseline.map((e) => baselineKey(e.file, e.spec)));
const seenKeys = new Set(
  failures.map(({ file, spec }) =>
    baselineKey(path.relative(distRoot, file).split(path.sep).join("/"), spec),
  ),
);

const newFailures = failures.filter(
  ({ file, spec }) =>
    !baselineKeys.has(
      baselineKey(
        path.relative(distRoot, file).split(path.sep).join("/"),
        spec,
      ),
    ),
);
// Ratchet: an excused finding that stopped occurring must leave the baseline
// with the fix that cleared it — a stale exemption is worse than none.
const staleBaseline = baseline.filter(
  (e) => !seenKeys.has(baselineKey(e.file, e.spec)),
);

if (newFailures.length > 0) {
  console.error(
    `verify-dist-import-resolution: ${newFailures.length} relative import(s) in ${distDir} ` +
      "do not resolve — this build would throw ERR_MODULE_NOT_FOUND at runtime (#1042):\n",
  );
  for (const { file, spec, target } of newFailures) {
    console.error(
      `  ${file}\n    imports '${spec}'\n    -> missing: ${target}\n`,
    );
  }
  console.error(
    "A route or service is importing a compiled file that this build did not produce. " +
      "Check tsconfig include patterns, copy-build-assets.mjs coverage, and that the " +
      "imported .ts actually compiles.",
  );
  process.exit(1);
}

if (staleBaseline.length > 0) {
  console.error(
    `verify-dist-import-resolution: ${staleBaseline.length} baseline entr(y/ies) in ` +
      `${baselinePath} no longer occur — remove them so the ratchet only tightens:`,
  );
  for (const e of staleBaseline) {
    console.error(`  ${e.file} => ${e.spec}`);
  }
  process.exit(1);
}

const excused = failures.length - newFailures.length;
console.log(
  `verify-dist-import-resolution: OK — ${files.length} module files scanned, ` +
    `all relative imports resolve` +
    (excused > 0
      ? ` (${excused} pre-existing finding(s) excused by baseline — see ${baselinePath})`
      : "."),
);
