#!/usr/bin/env node
/**
 * backend#1006 / #1016 — find modules that cannot actually be used.
 *
 * ## The class
 *
 * This repo has been bitten at least four times by code that is present, typed,
 * and dead: #936 (`node_os_core`), #979 (`toml`), #1006 (`graphene-pk11`),
 * #1016 (`fieldNameConverter`). Every one passed `tsc` and the full gate. They
 * fail only when *called*, and callers that wrap the call in try/catch convert
 * the crash into a plausible wrong answer — #1016's permission service reported
 * FILE_NOT_FOUND for files that exist.
 *
 * Two mechanically-checkable rules, one per observed mechanism:
 *
 *   RULE A — a bare specifier that is imported but neither declared in
 *            package.json nor present in node_modules. The module cannot load
 *            at all.  (#936, #979, #1006)
 *
 *   RULE B — a `const X = require('...')` of an untyped JS module in a .ts
 *            file, where the code calls `X.foo(...)` and the target's
 *            `module.exports` has no `foo`. `require()` of an untyped module
 *            yields `any`, so every property access on it is unchecked and tsc
 *            cannot see this.  (#1016)
 *
 * ## Validation — this is the point
 *
 * A detector validated only on cases it did not find is indistinguishable from
 * one that finds nothing. `--self-test` asserts that each rule re-finds its
 * known instance:
 *
 *   Rule A must flag `graphene-pk11` (#1006). Its original home,
 *     services/hsm-transaction-service.ts, is retired, so `--self-test` feeds the
 *     rule an in-memory import of it (never written to disk) and asserts it fires.
 *   Rule B must flag `fieldConverter.snakeToCamel` in utils/fieldNameConverter.ts
 *     — which is FIXED on main, so `--self-test` reverts it in memory (never on
 *     disk) and asserts the rule fires on the reverted text.
 *
 * ## Anti-vacuity
 *
 * Reports files scanned, specifiers resolved and require-boundaries analysed,
 * and exits non-zero if any of those is zero. A scan that examines nothing
 * passes trivially, which is the exact failure mode it exists to prevent.
 *
 * ## What this does NOT do
 *
 *   - It proves LOADABILITY, not reachability. It cannot say whether dead code
 *     matters; that stays a human call.
 *   - Rule A checks against THIS machine's node_modules. A dependency that is
 *     undeclared but incidentally installed looks fine here and breaks in CI.
 *   - Rule A cannot distinguish a genuinely optional dependency from a missing
 *     one. #1007 has a real case (`graphene-pk11` mocked `virtual: true` because
 *     it is legitimately absent) — the flag is correct there, the fix is not.
 *   - Rule B only understands `module.exports = { a, b }` object literals. A
 *     target using `exports.foo =` or a computed shape is skipped, not passed.
 *   - Dynamic/computed specifiers and property names are invisible to both.
 */

import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();
const SELF_TEST = process.argv.includes('--self-test');

const BUILTINS = new Set(
  ('assert async_hooks buffer child_process cluster console constants crypto dgram diagnostics_channel ' +
   'dns domain events fs http http2 https inspector module net os path perf_hooks process punycode ' +
   'querystring readline repl stream string_decoder timers tls trace_events tty url util v8 vm wasi ' +
   'worker_threads zlib').split(' '),
);

function listFiles() {
  const out = execSync(
    "grep -rl --include=*.ts --include=*.js -E \"^\\s*import .* from ['\\\"]|require\\(['\\\"]\" . " +
      "| grep -v node_modules | grep -v '/dist/' | grep -v '/__tests__/' | grep -v '/.git/'",
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  return out.split('\n').filter(Boolean);
}

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const declared = new Set([
  ...Object.keys(pkg.dependencies ?? {}),
  ...Object.keys(pkg.devDependencies ?? {}),
  ...Object.keys(pkg.optionalDependencies ?? {}),
  ...Object.keys(pkg.peerDependencies ?? {}),
]);

const stats = { files: 0, specifiers: 0, requireBoundaries: 0 };
const ruleA = [];
const ruleB = [];

const SPEC_RE = /(?:from\s+|require\(\s*)['"]([^'"]+)['"]/g;

function rootOf(spec) {
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
}

function checkRuleA(file, src) {
  for (const m of src.matchAll(SPEC_RE)) {
    const spec = m[1];
    stats.specifiers++;
    if (spec.startsWith('.') || spec.startsWith('/')) continue;
    const root = rootOf(spec);
    if (root.startsWith('node:') || BUILTINS.has(root)) continue;
    if (declared.has(root)) continue;
    if (existsSync(join(ROOT, 'node_modules', root))) continue;
    const line = src.slice(0, m.index).split('\n').length;
    ruleA.push({ file, line, spec: root });
  }
}

/** Resolve a relative require target to a real file. */
function resolveRel(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  for (const ext of ['', '.js', '.cjs', '.ts', '.mjs']) {
    const p = base + ext;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  return null;
}

/**
 * Extract TOP-LEVEL keys from `module.exports = { ... }`.
 *
 * Brace-matched rather than regex-terminated. A naive /\{([^}]*)\}/ stops at the
 * first `}`, which for a literal containing a nested object captures the NESTED
 * keys and misses every real export after it — that produced two false positives
 * (`config.getAllChains`, `config.getChainConfig`) on the first run of this
 * detector, both of which are exported perfectly well. Also tracks `exports.foo =`
 * assignments, and depth so nested keys are never mistaken for exports.
 */
function exportedKeys(targetSrc) {
  const keys = new Set();

  for (const m of targetSrc.matchAll(/(?:^|\n)\s*exports\.([A-Za-z_$][\w$]*)\s*=/g)) keys.add(m[1]);

  const start = targetSrc.search(/module\.exports\s*=\s*\{/);
  if (start === -1) return keys.size ? keys : null; // unknown shape -> skip, do not guess

  const open = targetSrc.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let i = open; i < targetSrc.length; i++) {
    const ch = targetSrc[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return keys.size ? keys : null;

  // Strip comments first. A `// Helper functions` line sitting between `},` and
  // the next key glues itself onto that key when splitting on commas, so the key
  // fails the identifier test and is silently dropped — which is exactly how
  // `config.getAllChains` was reported missing on the second run of this
  // detector while being exported on the very next line.
  const body = targetSrc
    .slice(open + 1, end)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  depth = 0;
  let buf = '';
  const parts = [];
  for (const ch of body) {
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    else if (ch === '}' || ch === ']' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(buf);
      buf = '';
    } else buf += ch;
  }
  parts.push(buf);

  for (const p of parts) {
    const name = p.split(':')[0].trim().replace(/^\.\.\./, '');
    if (/^[A-Za-z_$][\w$]*$/.test(name)) keys.add(name);
  }
  return keys;
}

function checkRuleB(file, src) {
  if (!file.endsWith('.ts')) return;
  const reqRe = /const\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(reqRe)) {
    const [, varName, spec] = m;
    const target = resolveRel(file, spec);
    if (!target || target.endsWith('.ts')) continue; // typed targets are tsc's job
    const keys = exportedKeys(readFileSync(target, 'utf8'));
    if (!keys) continue;
    stats.requireBoundaries++;
    const callRe = new RegExp(`\\b${varName}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g');
    for (const c of src.matchAll(callRe)) {
      const member = c[1];
      if (keys.has(member)) continue;
      const line = src.slice(0, c.index).split('\n').length;
      ruleB.push({ file, line, varName, member, target: target.replace(ROOT + '/', ''), exports: [...keys] });
    }
  }
}

const files = listFiles();
for (const f of files) {
  let src;
  try {
    src = readFileSync(join(ROOT, f.replace(/^\.\//, '')), 'utf8');
  } catch {
    continue;
  }
  stats.files++;
  const abs = resolve(ROOT, f.replace(/^\.\//, ''));
  checkRuleA(f, src);
  checkRuleB(abs, src);
}

// ---------------------------------------------------------------------------
// Self-test: each rule must re-find its known instance.
// ---------------------------------------------------------------------------
if (SELF_TEST) {
  let ok = true;
  const beforeA = ruleA.length;
  checkRuleA('self-test/synthetic-hsm.ts', "import graphene from 'graphene-pk11';\n");
  const aHit = ruleA.slice(beforeA).find((r) => r.spec === 'graphene-pk11');
  ruleA.length = beforeA; // the synthetic finding must not appear in the report
  console.log(
    aHit
      ? `RULE A self-test PASS — re-found #1006: ${aHit.file}:${aHit.line} '${aHit.spec}'`
      : 'RULE A self-test FAIL — did not re-find graphene-pk11 (#1006)',
  );
  if (!aHit) ok = false;

  // #1016 is fixed on main; revert it IN MEMORY and assert the rule fires.
  const fncPath = resolve(ROOT, 'utils/fieldNameConverter.ts');
  const reverted = readFileSync(fncPath, 'utf8')
    .replace('fieldConverter.dbToApp(dbObject)', 'fieldConverter.snakeToCamel(dbObject)')
    .replace('fieldConverter.appToDb(appObject)', 'fieldConverter.camelToSnake(appObject)');
  const before = ruleB.length;
  checkRuleB(fncPath, reverted);
  const found = ruleB.slice(before).filter((r) => r.member === 'snakeToCamel' || r.member === 'camelToSnake');
  console.log(
    found.length >= 2
      ? `RULE B self-test PASS — re-found #1016 on reverted text: ${found.map((f) => f.varName + '.' + f.member).join(', ')}`
      : `RULE B self-test FAIL — did not re-find #1016 (found ${found.length})`,
  );
  if (found.length < 2) ok = false;
  ruleB.length = before; // drop synthetic findings from the report

  if (!ok) {
    console.error('\nSELF-TEST FAILED — the detector does not detect. Do not trust its other output.');
    process.exit(2);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// Anti-vacuity
// ---------------------------------------------------------------------------
console.log(
  `scanned: ${stats.files} files, ${stats.specifiers} specifiers, ${stats.requireBoundaries} untyped require-boundaries`,
);
if (stats.files === 0 || stats.specifiers === 0 || stats.requireBoundaries === 0) {
  console.error('VACUOUS SCAN — examined nothing. Failing rather than reporting a clean bill.');
  process.exit(2);
}

const bySpec = new Map();
for (const r of ruleA) {
  if (!bySpec.has(r.spec)) bySpec.set(r.spec, []);
  bySpec.get(r.spec).push(r);
}
console.log(`\nRULE A — imported but neither declared nor installed (${bySpec.size} specifiers, ${ruleA.length} sites)`);
for (const [spec, rows] of [...bySpec.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${spec}  (${rows.length})`);
  for (const r of rows.slice(0, 3)) console.log(`      ${r.file}:${r.line}`);
}

console.log(`\nRULE B — calls a member the untyped require target does not export (${ruleB.length})`);
for (const r of ruleB) {
  console.log(`  ${r.file}:${r.line}  ${r.varName}.${r.member}()  ->  ${r.target} exports [${r.exports.join(', ')}]`);
}

process.exit(ruleA.length + ruleB.length > 0 ? 1 : 0);
