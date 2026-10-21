#!/usr/bin/env node
/**
 * backend#1017 (class) — find test files whose module-registry manipulation is
 * ORDER-DEPENDENT, not merely present.
 *
 * ## Why a grep is not enough
 *
 * `#1017` was closed against one file. The mechanism it named survives in the
 * others. The obvious way to size that population is
 *
 *     grep -rlE 'jest\.doMock|jest\.resetModules' __tests__/
 *
 * which reports 48 paths on `647473c4` (46 of them actual test files; the other
 * two are `helpers/assert-mock-bound.ts` and `setup/guard-network-egress.cjs`,
 * which only mention the API in prose and code that supports it). That number
 * is not a defect count. Most of those files reset the registry the safe way:
 * reset, mock, load, assert, restore — every test self-contained. Reporting 46
 * hazards would send a follow-up lane at 40-odd files that are fine, and the
 * real ones would be lost in the noise. A count is only useful if the predicate
 * behind it is the one that actually races.
 *
 * ## The predicate, and why it is NOT the one this lane was handed
 *
 * The assignment described the hazard as "module-registry mutation PLUS
 * import-time `process.env` mutation PLUS shared module state". That is an
 * accurate description of the PRE-#1078 `real-storage-integrations.test.ts`,
 * whose subject snapshotted `ENABLE_REAL_STORAGE` at module scope. It is NOT
 * the mechanism of the file this lane was told to fix. `server/axelar/api-client.js`
 * reads `ENABLE_REAL_BRIDGES` and `AXELAR_API_URL` LAZILY, inside its functions
 * (lines 23, 31) — load order cannot change its answer through the environment,
 * and `server/axelar/config.js` reads no env at all. An import-time-env
 * predicate would score `bridge-real-api-clients.test.ts` CLEAN, which the
 * observed failure falsifies: on a full-gate run of `647473c4` its six
 * network-touching Axelar tests failed with
 *
 *     [guard-network-egress] BLOCKED https.request -> https://api.axelarscan.io/...
 *     at Object.queryGMPStatus (server/axelar/api-client.js:52:32)
 *
 * — the subject held the REAL `node_modules/axios`, so `jest.doMock('axios')`
 * had not bound. Environment played no part.
 *
 * So the conjunct is generalised one level, to the thing both files share and
 * that #1078's fix actually removed: the subject receives a dependency THROUGH
 * THE REGISTRY instead of through its own interface.
 *
 *   C1 — RUNTIME registry mutation.
 *        `jest.resetModules()` / `jest.doMock()` executed from inside a test, a
 *        lifecycle hook, or a helper they call. A top-level `jest.mock()` is
 *        hoisted and installed once before any module loads; nothing can win or
 *        lose it by ordering, so a file with only those is not in the class.
 *
 *   C2 — REGISTRY-MEDIATED INJECTION.
 *        The file substitutes a dependency it never hands to the subject
 *        directly. Either sub-case qualifies:
 *
 *        C2-mock  the file `doMock`s specifier S, then runtime-loads a
 *                 different subject M, and S is reachable from M's IMPORT-TIME
 *                 require graph. The assertions then depend on the registry
 *                 putting the mock inside M. Mocking S and then loading S is
 *                 deliberately excluded: that is a direct replacement the test
 *                 holds a reference to, and a positive assertion on it fails
 *                 honestly when it does not bind.
 *
 *        C2-env   `process.env` is the injected dependency — the file writes a
 *                 key that M, or M's import-time graph, snapshots in module
 *                 top-level scope. Keys are matched by NAME; writing FOO while
 *                 the subject snapshots BAR is not a coupling. A subject that
 *                 reads env lazily inside its functions is immune to load order
 *                 and is deliberately not counted.
 *
 *   C3 — the substitution is RE-PERFORMED ACROSS TESTS: two or more tests in
 *        the file each mutate the registry and load the same subject, so every
 *        test's result depends on the previous test's teardown having actually
 *        evicted the last instance. One test doing this once is not a race.
 *
 * On top of the verdict, five ordering violations are reported where they are
 * present. They are aggravating detail, not the predicate — a HAZARD file need
 * not have any:
 *
 *   V1  a load of a registry-substituted specifier with no `resetModules()`
 *       anywhere before it in that test's effective sequence — which includes
 *       the previous test's `afterEach` and this test's `beforeEach`, so
 *       cleaning up afterwards counts and only a genuine gap fires.
 *   V2  a write to a coupled env key AFTER the load that snapshots it.
 *   V3  a `doMock(spec)` issued after `spec` was already loaded in that test.
 *   V4  a coupled env key written and never deleted or restored in an
 *       `afterEach`/`afterAll` — it leaks to later tests AND to later test
 *       FILES in the same worker.
 *   V5  a module handle from a runtime load bound at module scope, or loaded in
 *       `beforeAll` — one instance, built under one configuration, shared by
 *       tests that assume different ones.
 *
 * Tiers are reported separately (grep / C1 / C1+C2 / HAZARD) so the population
 * claim is auditable rather than asserted.
 *
 * ## Validation — the point of the whole exercise
 *
 * `--self-test` runs the predicate against files whose verdict is known
 * independently of this script:
 *
 *   1. `__tests__/real-storage-integrations.test.ts` at its PRE-#1078 blob —
 *      one of the two files empirically observed racing — must be HAZARDOUS.
 *   2. The same file on the current tree, after #1078 replaced the registry
 *      manipulation with constructor injection, must be CLEAN. This is the
 *      mutation half: a detector that cannot tell the fixed file from the
 *      broken one is measuring something other than the fix.
 *   3. Synthetic fixtures: one per violation V1..V5, each of which must raise
 *      exactly its own violation, so no rule can silently stop firing; a
 *      HOISTED fixture that must fail C1; a DIRECT fixture (mock S, then load
 *      S) that must fail C2; and an ORDERED fixture that must come out
 *      HAZARDOUS with no violations at all, pinning the point that tidy
 *      ordering is not an exemption from the class.
 *   4. Regression fixtures for the three defects found reviewing #1087:
 *      DESCRIBE_SCOPED_HELPER (a substitution routed through a helper declared
 *      inside the describe — must be HAZARD), and V4_NEG_WHOLE_OBJECT /
 *      V4_NEG_HELPER_ASSIGN (whole-environment restoration is a restore, not a
 *      leak — must raise no V4 while still holding C1 and C2).
 *   5. An EMBEDDED copy of the pre-#1078 shape, so the pre/post discrimination
 *      assertion runs whether or not `git` is available. It loads the real
 *      `server/services/real-storage-client.js`, whose module-scope
 *      `ENABLE_REAL_STORAGE` read survived #1078, so C2-env is established
 *      against current source rather than a frozen copy that can drift.
 *
 * ## Anti-vacuity
 *
 * Two layers, because the first one was not enough.
 *
 * The SCAN reports files parsed, runtime load sites found, specifiers resolved,
 * and module-graph nodes visited. It exits 2 if it parsed nothing, or if it
 * found runtime load sites but resolved no module graph at all — that
 * combination means C2 could never have been established and the scan is
 * measuring resolution failure, not cleanliness. A file with no runtime loads
 * resolves no graph legitimately, which is what a fixed file looks like, so that
 * alone is not treated as vacuous.
 *
 * The SELF-TEST counts its own checks against `EXPECTED_SELF_TEST_CHECKS` and
 * fails if the tally does not match. This exists because the anti-vacuity check
 * itself failed open: the historical-blob comparison caught a `git` failure,
 * printed SKIP, recorded nothing, and `--self-test` exited 0 while announcing
 * success on a battery three checks smaller (#1087 review). Two independent
 * defences now cover that boundary — the git path fails closed, AND a shrunken
 * battery fails on the tally even if someone restores the SKIP.
 *
 * ## What this does NOT prove
 *
 *   - A HAZARD verdict is a shape, not an observed failure. It says the file
 *     can be ordered into a wrong answer, not that it has been. Only two files
 *     have been WATCHED to fail; the rest of the population is a scoping input
 *     for a follow-up, not a defect list.
 *   - CLEAN means "none of C1..C3", not "no race". Registry state can also be
 *     lost to module identity aliasing — a nested `node_modules` symlink makes
 *     one specifier resolve to two realpaths — which no AST can see.
 *   - Specifiers built at runtime, and env keys accessed through a computed
 *     name (`process.env[k]`), are counted as unknown and never as coupling.
 *   - Env restoration is recognised as per-key writes/deletes, whole-object
 *     assignment (`process.env = saved`), and `Object.assign(process.env, …)`,
 *     including through a helper. A restore performed only inside a nested
 *     callback is not seen, and a restore in `beforeEach` deliberately does not
 *     count: it protects the next test in the file but not the next FILE in the
 *     worker, which is what V4 is about.
 *   - Resolution is this repo's jest moduleNameMapper plus node's extension
 *     search. A package with an `exports` map is treated as third-party: it is
 *     matched by bare name for C2-mock, and its own import-time env reads are
 *     not followed.
 *   - A file that asserts its mock is bound (`assertAxiosMockBound`, #1019/#1022)
 *     is still HAZARDOUS. Those assertions convert a vacuous green into an
 *     honest red; they do not remove the dependence on the registry. The report
 *     flags which files have them so a follow-up can tell "already detects it"
 *     from "still silent".
 */

import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, extname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const ts = require_('typescript');

const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

function scriptKindFor(file) {
  switch (extname(file)) {
    case '.ts':
      return ts.ScriptKind.TS;
    case '.tsx':
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.JS;
  }
}

const parseCache = new Map();
function parseFile(file, textOverride) {
  // The cache key must include the TEXT when one is supplied: --self-test
  // analyses several different fixture bodies under one synthetic path, and a
  // path-only key silently served the first fixture's AST to all of them.
  const key =
    textOverride === undefined
      ? file
      : `${file} ${createHash('sha1').update(textOverride).digest('hex')}`;
  if (parseCache.has(key)) return parseCache.get(key);
  const text = textOverride ?? readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, scriptKindFor(file));
  parseCache.set(key, sf);
  return sf;
}

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

function isFunctionLike(node) {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessor(node) ||
    ts.isSetAccessor(node)
  );
}

/** Nearest function-like ancestor, or null when the node runs at module top level. */
function enclosingFunction(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (isFunctionLike(p)) return p;
  }
  return null;
}

/** The literal text of a call argument, or null when it is computed. */
function literalArg(call, index = 0) {
  const a = call.arguments?.[index];
  return a && ts.isStringLiteralLike(a) ? a.text : null;
}

function calleeName(call) {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    return `${e.expression.text}.${e.name.text}`;
  }
  if (ts.isIdentifier(e)) return e.text;
  return null;
}

const isImportCall = (n) => ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword;
const isRequireCall = (n) => ts.isCallExpression(n) && calleeName(n) === 'require';

function walk(node, fn) {
  fn(node);
  ts.forEachChild(node, (c) => walk(c, fn));
}

// ---------------------------------------------------------------------------
// Specifier resolution — this repo's jest config, not node's default
// ---------------------------------------------------------------------------

const CANDIDATE_SUFFIXES = [
  '', '.ts', '.tsx', '.js', '.jsx', '.cjs', '.mjs',
  '/index.ts', '/index.js', '/index.cjs',
];

function resolveSpecifier(spec, fromFile) {
  if (!spec.startsWith('.')) return null; // bare specifier: third-party, matched by name
  // jest moduleNameMapper: '^(\\.{1,2}/.*)\\.js$' -> '$1' (ESM-style .js suffix stripped)
  const mapped = /^\.{1,2}\/.*\.js$/.test(spec) ? spec.replace(/\.js$/, '') : spec;
  const base = resolve(dirname(fromFile), mapped);
  for (const suffix of CANDIDATE_SUFFIXES) {
    const cand = base + suffix;
    if (existsSync(cand) && statSync(cand).isFile()) return cand;
  }
  if (mapped !== spec) {
    const raw = resolve(dirname(fromFile), spec);
    if (existsSync(raw) && statSync(raw).isFile()) return raw;
  }
  return null;
}

const stats = { filesParsed: 0, specifiersResolved: 0, graphNodes: 0, runtimeLoadSites: 0 };

// ---------------------------------------------------------------------------
// The import-time module graph of a subject
// ---------------------------------------------------------------------------

const graphCache = new Map();

/**
 * What `file` pulls in at IMPORT time, transitively through first-party files.
 *
 *   bare  — bare specifiers required at module top level anywhere in the graph
 *           ('axios', 'express', …). These are the C2-mock candidates.
 *   files — resolved first-party paths in the graph.
 *   env   — env keys read in MODULE TOP-LEVEL scope anywhere in the graph. A
 *           read inside a function body is lazy, hence load-order-independent,
 *           and is deliberately excluded; that exclusion is what makes C2-env
 *           discriminating.
 *   envWildcard — a computed `process.env[k]` was seen; keys are incomplete.
 */
function importTimeGraph(file, maxDepth = 4, seen = new Set()) {
  const cacheKey = `${file} ${maxDepth}`;
  if (graphCache.has(cacheKey)) return graphCache.get(cacheKey);
  const out = { bare: new Set(), files: new Set(), env: new Set(), envWildcard: false };
  if (seen.has(file) || maxDepth < 0) return out;
  seen.add(file);
  stats.graphNodes += 1;

  let sf;
  try {
    sf = parseFile(file);
    stats.filesParsed += 1;
  } catch {
    return out;
  }

  const childSpecs = [];
  walk(sf, (node) => {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === 'process' &&
      node.expression.name.text === 'env' &&
      enclosingFunction(node) === null
    ) {
      if (ts.isPropertyAccessExpression(node)) out.env.add(node.name.text);
      else if (ts.isStringLiteralLike(node.argumentExpression)) out.env.add(node.argumentExpression.text);
      else out.envWildcard = true;
    }
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      childSpecs.push(node.moduleSpecifier.text);
    }
    if (isRequireCall(node) && enclosingFunction(node) === null) {
      const s = literalArg(node);
      if (s) childSpecs.push(s);
    }
  });

  for (const spec of childSpecs) {
    if (!spec.startsWith('.')) {
      out.bare.add(spec);
      continue;
    }
    const target = resolveSpecifier(spec, file);
    if (!target) continue;
    stats.specifiersResolved += 1;
    out.files.add(target);
    const sub = importTimeGraph(target, maxDepth - 1, seen);
    sub.bare.forEach((b) => out.bare.add(b));
    sub.files.forEach((f) => out.files.add(f));
    sub.env.forEach((e) => out.env.add(e));
    if (sub.envWildcard) out.envWildcard = true;
  }

  graphCache.set(cacheKey, out);
  return out;
}

// ---------------------------------------------------------------------------
// Event extraction — the ordered story of one test
// ---------------------------------------------------------------------------

const HOOKS = new Set(['beforeEach', 'beforeAll', 'afterEach', 'afterAll']);
const TESTS = new Set(['it', 'test', 'fit', 'xit']);

/** True for the `process.env` object itself, not a member of it. */
function isProcessEnvObject(node) {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

/**
 * Whole-environment restoration: `process.env = savedCopy` or
 * `Object.assign(process.env, saved)`.
 *
 * #1087 review: V4 recognised only per-key `process.env.KEY = ...` and
 * `delete process.env.KEY`, so every suite that snapshots and restores the whole
 * object — the more careful pattern, and the one six of the seven flagged files
 * actually use — was reported as leaking. That made the env-leaker count and its
 * priority ordering false, and #1085 was seeded from it.
 */
function isWholeEnvRestore(node) {
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return isProcessEnvObject(node.left);
  }
  if (ts.isCallExpression(node)) {
    const e = node.expression;
    const isObjectAssign =
      ts.isPropertyAccessExpression(e) &&
      ts.isIdentifier(e.expression) &&
      e.expression.text === 'Object' &&
      e.name.text === 'assign';
    return isObjectAssign && node.arguments.length > 0 && isProcessEnvObject(node.arguments[0]);
  }
  return false;
}

/** 'FOO' for process.env.FOO / process.env['FOO'], '*' for a computed key. */
function envKeyOf(expr) {
  if (
    (ts.isPropertyAccessExpression(expr) || ts.isElementAccessExpression(expr)) &&
    ts.isPropertyAccessExpression(expr.expression) &&
    ts.isIdentifier(expr.expression.expression) &&
    expr.expression.expression.text === 'process' &&
    expr.expression.name.text === 'env'
  ) {
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    if (ts.isStringLiteralLike(expr.argumentExpression)) return expr.argumentExpression.text;
    return '*';
  }
  return null;
}

/**
 * Linearise a function body into RESET / DOMOCK / LOAD / ENVSET / ENVDEL /
 * ENVRESTORE_ALL events in source order, splicing in the bodies of helper
 * functions it calls (bounded depth, no recursion).
 *
 * "Helper" means one declared in any enclosing lexical scope — module top level
 * OR the `describe` the test sits in. Collecting only module-scope declarations
 * was a real blind spot, not a theoretical one: it produced false negatives on
 * an ordinary Jest shape and understated the population (#1087 review).
 *
 * A call inside a nested callback (`arr.forEach(k => delete process.env[k])`)
 * is still not followed — nested functions run later, or never, so they are not
 * part of this sequence.
 */
function eventsOf(node, sf, helpers, depth = 0, seenHelpers = new Set()) {
  const events = [];
  if (!node || depth > 2) return events;

  const visit = (n) => {
    // A nested callback runs later, or never; its body is not part of this
    // sequence. Hook and test callbacks are spliced in by the caller instead.
    if (n !== node && isFunctionLike(n)) return;

    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name === 'jest.resetModules') {
        events.push({ kind: 'RESET', line: lineOf(sf, n) });
      } else if (name === 'jest.doMock') {
        events.push({ kind: 'DOMOCK', spec: literalArg(n), line: lineOf(sf, n) });
      } else if (isRequireCall(n) || isImportCall(n)) {
        const s = literalArg(n);
        if (s) events.push({ kind: 'LOAD', spec: s, line: lineOf(sf, n) });
      } else if (name && helpers.has(name) && !seenHelpers.has(name)) {
        const next = new Set(seenHelpers);
        next.add(name);
        events.push(...eventsOf(helpers.get(name).body, sf, helpers, depth + 1, next));
      }
    }
    if (isWholeEnvRestore(n)) {
      events.push({ kind: 'ENVRESTORE_ALL', line: lineOf(sf, n) });
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const key = envKeyOf(n.left);
      if (key) events.push({ kind: 'ENVSET', key, line: lineOf(sf, n) });
    }
    if (ts.isDeleteExpression(n)) {
      const key = envKeyOf(n.expression);
      if (key) events.push({ kind: 'ENVDEL', key, line: lineOf(sf, n) });
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return events;
}

/** Locally declared functions, so helper bodies can be inlined into a test. */
function collectHelpers(scopeNode) {
  const helpers = new Map();
  const statements = scopeNode.statements ?? [];
  for (const stmt of statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      helpers.set(stmt.name.text, { body: stmt.body });
    }
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer && isFunctionLike(d.initializer) && d.initializer.body) {
          helpers.set(d.name.text, { body: d.initializer.body });
        }
      }
    }
  }
  return helpers;
}

/**
 * One entry per test, carrying the hook events that precede it. Jest runs every
 * enclosing `beforeAll`/`beforeEach` before the test body, so those events are
 * the test's real prefix and must be part of its sequence.
 */
function collectTests(sf) {
  const tests = [];
  const cleanupEvents = [];
  const beforeAllLoads = [];

  const descend = (bodyNode, prefix, cleanupPrefix, inheritedHelpers) => {
    // #1087 review: helpers are declared in whatever scope is convenient, and a
    // helper inside a `describe` is an entirely ordinary Jest shape. Collecting
    // only `sf.statements` made every substitution routed through such a helper
    // invisible: C1 and C2 still held from the raw walk, but no test carried
    // inlined LOAD/DOMOCK events, so C3 was false and the file scored CLEAN.
    // That is a false negative in the conjunct the population count rests on.
    // Inner declarations shadow outer ones, which is also what JS does.
    const helpers = new Map([...inheritedHelpers, ...collectHelpers(bodyNode)]);
    const before = [];
    const after = [];
    const localTests = [];
    const nested = [];

    ts.forEachChild(bodyNode, function scan(stmt) {
      if (ts.isCallExpression(stmt)) {
        const name = calleeName(stmt);
        const base = name?.split('.')[0];
        const cb = stmt.arguments?.find((a) => isFunctionLike(a));
        if (base && HOOKS.has(base) && cb?.body) {
          const ev = eventsOf(cb.body, sf, helpers);
          if (base === 'beforeEach' || base === 'beforeAll') {
            before.push(...ev);
            if (base === 'beforeAll') beforeAllLoads.push(...ev.filter((e) => e.kind === 'LOAD'));
          } else {
            after.push(...ev);
            cleanupEvents.push(...ev);
          }
          return;
        }
        if (base && TESTS.has(base) && cb?.body) {
          localTests.push({
            name: stmt.arguments?.[0] && ts.isStringLiteralLike(stmt.arguments[0]) ? stmt.arguments[0].text : '<anon>',
            line: lineOf(sf, stmt),
            body: cb.body,
          });
          return;
        }
        if (base === 'describe' && cb?.body) {
          nested.push(cb.body);
          return;
        }
      }
      ts.forEachChild(stmt, scan);
    });

    for (const t of localTests) {
      tests.push({
        name: t.name,
        line: t.line,
        // What jest runs before this test's body: enclosing beforeAll/beforeEach.
        hooks: [...prefix, ...before],
        body: eventsOf(t.body, sf, helpers),
        // What jest runs after it: this describe's afterEach plus its ancestors'.
        cleanup: [...after, ...cleanupPrefix],
      });
    }
    for (const n of nested) descend(n, [...prefix, ...before], [...after, ...cleanupPrefix], helpers);
  };

  descend(sf, [], [], new Map());

  // A test does not start from a blank registry: the PREVIOUS test's afterEach
  // has already run. Without that, a `jest.resetModules()` sitting in an
  // afterEach reads as "never reset" and V1 fires on every file that cleans up
  // afterwards instead of beforehand — which is a style, not a defect.
  //
  // Approximation, stated so a reader can discount it: tests are ordered by
  // traversal (a describe's own tests, then its nested describes), whereas
  // jest-circus runs children strictly in registration order. The two differ
  // only for a describe that declares tests both before and after a nested
  // describe, and the effect is limited to which cleanup is credited to the
  // seam. Every test's own hooks are exact.
  for (let i = 0; i < tests.length; i += 1) {
    const priorCleanup = i > 0 ? tests[i - 1].cleanup : [];
    tests[i].events = [...priorCleanup, ...tests[i].hooks, ...tests[i].body];
  }

  return { tests, cleanupEvents, beforeAllLoads };
}

// ---------------------------------------------------------------------------
// The predicate
// ---------------------------------------------------------------------------

function analyse(file, textOverride) {
  const sf = parseFile(file, textOverride);
  stats.filesParsed += 1;
  const { tests, cleanupEvents, beforeAllLoads } = collectTests(sf);

  // ---- C1: runtime (non-top-level) registry mutation -----------------------
  const runtimeMutations = [];
  const doMockSpecs = new Set();
  const runtimeLoads = new Set();
  const envWrites = new Map(); // key -> first line
  let hasBindingAssertion = false;

  walk(sf, (node) => {
    if (ts.isIdentifier(node) && node.text === 'assertAxiosMockBound') hasBindingAssertion = true;

    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const k = envKeyOf(node.left);
      if (k && !envWrites.has(k)) envWrites.set(k, lineOf(sf, node));
    }
    if (ts.isDeleteExpression(node)) {
      const k = envKeyOf(node.expression);
      if (k && !envWrites.has(k)) envWrites.set(k, lineOf(sf, node));
    }
    if (!ts.isCallExpression(node)) return;

    const name = calleeName(node);
    if ((name === 'jest.resetModules' || name === 'jest.doMock') && enclosingFunction(node) !== null) {
      runtimeMutations.push({ name, line: lineOf(sf, node) });
    }
    if (name === 'jest.doMock') {
      const s = literalArg(node);
      if (s) doMockSpecs.add(s);
    }
    if ((isRequireCall(node) || isImportCall(node)) && enclosingFunction(node) !== null) {
      const s = literalArg(node);
      if (s) runtimeLoads.add(s);
    }
  });
  const C1 = runtimeMutations.length > 0;

  // ---- C2: registry-mediated injection -------------------------------------
  const injections = []; // C2-mock
  const coupledKeys = new Set(); // C2-env
  const coupledSpecs = [];
  const c2SubjectSpecs = new Set(); // load specifiers that receive a registry-mediated dependency

  stats.runtimeLoadSites += runtimeLoads.size;
  for (const loadSpec of runtimeLoads) {
    const subject = resolveSpecifier(loadSpec, file);
    if (!subject) continue; // a bare runtime load has no first-party graph to inspect
    stats.specifiersResolved += 1;
    const graph = importTimeGraph(subject);

    // C2-mock: a doMock'd specifier lives inside the subject's import-time graph.
    for (const mocked of doMockSpecs) {
      const mockedPath = resolveSpecifier(mocked, file);
      if (mockedPath) {
        if (mockedPath === subject) continue; // direct replacement — excluded by design
        if (graph.files.has(mockedPath)) {
          injections.push({ subject: relative(ROOT, subject), injected: mocked, via: 'first-party import-time graph' });
          c2SubjectSpecs.add(loadSpec);
        }
      } else if (graph.bare.has(mocked)) {
        injections.push({ subject: relative(ROOT, subject), injected: mocked, via: 'bare import-time dependency' });
        c2SubjectSpecs.add(loadSpec);
      }
    }

    // C2-env: the subject snapshots a key this file writes.
    const hit = [...graph.env].filter((k) => envWrites.has(k));
    if (hit.length > 0) {
      hit.forEach((k) => coupledKeys.add(k));
      coupledSpecs.push({ spec: loadSpec, target: relative(ROOT, subject), keys: hit });
      c2SubjectSpecs.add(loadSpec);
    }
  }
  const C2 = injections.length > 0 || coupledKeys.size > 0;

  // ---- C3: the substitution is re-performed across tests -------------------
  const substitutingTests = tests.filter((t) => {
    const mutated = t.events.some((e) => e.kind === 'RESET' || e.kind === 'DOMOCK');
    const loaded = t.events.some((e) => e.kind === 'LOAD');
    return mutated && loaded;
  });
  const C3 = substitutingTests.length >= 2;

  // ---- V1..V5: aggravating ordering violations -----------------------------
  const violations = [];
  for (const t of tests) {
    let sawReset = false;
    const loaded = new Set();
    for (const ev of t.events) {
      if (ev.kind === 'RESET') {
        sawReset = true;
        loaded.clear();
      } else if (ev.kind === 'DOMOCK') {
        if (ev.spec && loaded.has(ev.spec)) {
          violations.push({ id: 'V3', line: ev.line, detail: `doMock('${ev.spec}') after it was already loaded, in "${t.name}"` });
        }
      } else if (ev.kind === 'LOAD') {
        // No reset before the load means the registry may still hold the
        // instance an EARLIER test built — with that test's mock and that
        // test's env baked in. Only loads that actually depend on the
        // substitution count: the mocked specifier itself, or a C2 subject.
        if (ev.spec && !sawReset && (doMockSpecs.has(ev.spec) || c2SubjectSpecs.has(ev.spec))) {
          const what = doMockSpecs.has(ev.spec) ? "doMock'd" : 'registry-substituted';
          violations.push({ id: 'V1', line: ev.line, detail: `load of ${what} '${ev.spec}' with no resetModules() before it, in "${t.name}" — a cached instance from an earlier test can be served` });
        }
        loaded.add(ev.spec);
      } else if (coupledKeys.has(ev.key) && loaded.size > 0) {
        violations.push({ id: 'V2', line: ev.line, detail: `writes coupled env ${ev.key} AFTER the module that snapshots it was loaded, in "${t.name}"` });
      }
    }
  }
  const restored = new Set(cleanupEvents.filter((e) => e.kind === 'ENVSET' || e.kind === 'ENVDEL').map((e) => e.key));
  // A whole-environment restore in a cleanup hook covers every key at once,
  // including ones this file never names. Helper calls are inlined by eventsOf,
  // so a `resetEnv()` that Object.assigns the originals counts here too.
  const restoresWholeEnv = cleanupEvents.some((e) => e.kind === 'ENVRESTORE_ALL');
  for (const k of coupledKeys) {
    if (!restoresWholeEnv && !restored.has(k) && !restored.has('*')) {
      violations.push({ id: 'V4', line: envWrites.get(k), detail: `coupled env ${k} is written but never deleted or restored in afterEach/afterAll — leaks to later tests and later FILES in the worker` });
    }
  }
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!d.initializer) continue;
      let isLoad = false;
      walk(d.initializer, (n) => {
        if (isRequireCall(n) || isImportCall(n)) isLoad = true;
      });
      if (isLoad) {
        violations.push({ id: 'V5', line: lineOf(sf, d), detail: 'module handle from a runtime load bound at module scope — one instance shared by every test' });
      }
    }
  }
  for (const ev of beforeAllLoads) {
    violations.push({ id: 'V5', line: ev.line, detail: `beforeAll loads '${ev.spec}' once for the whole describe — later tests cannot change what it captured` });
  }

  return {
    file: relative(ROOT, file),
    tests: tests.length,
    C1,
    C2,
    C3,
    hazardous: C1 && C2 && C3,
    hasBindingAssertion,
    substitutingTests: substitutingTests.length,
    runtimeMutations: runtimeMutations.length,
    envWrites: [...envWrites.keys()],
    injections: dedupeBy(injections, (i) => `${i.subject}<-${i.injected}`),
    coupledKeys: [...coupledKeys],
    coupledSpecs,
    violations: dedupeBy(violations, (v) => `${v.id} ${v.line} ${v.detail}`).sort((a, b) => a.line - b.line),
  };
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const it of items) {
    const k = keyFn(it);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

// ---------------------------------------------------------------------------
// File discovery
// ---------------------------------------------------------------------------

const GREP = /jest\.doMock|jest\.resetModules/;

function listTestFiles() {
  const roots = [join(ROOT, '__tests__'), join(ROOT, 'server', '__tests__')];
  const out = [];
  const walkDir = (dir) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === 'coverage') continue;
        walkDir(p);
      } else if (/\.(test|spec)\.(ts|tsx|js)$/.test(e.name)) {
        out.push(p);
      }
    }
  };
  roots.forEach(walkDir);
  return out.sort();
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

// Fixtures resolve './fixture-subject' relative to the fixtures directory, so
// the subject exists on disk: C2 is then established by the same resolution and
// graph walk the real scan uses, not by a special case.
const FIXTURE_DIR = join(ROOT, 'scripts', 'fixtures', 'module-registry-race');
const FIXTURE_SUBJECT = join(FIXTURE_DIR, 'fixture-subject.js');
const FIXTURE_PATH = join(FIXTURE_DIR, 'fixture.test.ts');

const FIXTURES = {
  // Registry-mediated injection of axios into the subject, correctly ordered in
  // every test and fully restored. C1+C2+C3 all hold — being tidy does not take
  // a file out of the class, and this fixture pins that.
  ORDERED: `
    describe('d', () => {
      afterEach(() => { delete process.env.FLAG; jest.resetModules(); });
      it('a', async () => {
        jest.resetModules();
        process.env.FLAG = 'true';
        jest.doMock('axios', () => ({ get: jest.fn() }));
        expect(require('./fixture-subject').value()).toBe('true');
      });
      it('b', async () => {
        jest.resetModules();
        process.env.FLAG = 'false';
        jest.doMock('axios', () => ({ get: jest.fn() }));
        expect(require('./fixture-subject').value()).toBe('false');
      });
    });
  `,
  // Mocks the very module it then loads: a direct replacement the test holds a
  // reference to. C2 must exclude this, so the file is CLEAN.
  // No env write, so C2-env cannot mask the thing under test: the only
  // candidate substitution is the direct one, which C2-mock must reject.
  DIRECT: `
    describe('d', () => {
      afterEach(() => { jest.resetModules(); });
      it('a', async () => {
        jest.resetModules();
        jest.doMock('./fixture-subject', () => ({ value: () => 'x' }));
        expect(require('./fixture-subject').value()).toBe('x');
      });
      it('b', async () => {
        jest.resetModules();
        jest.doMock('./fixture-subject', () => ({ value: () => 'y' }));
        expect(require('./fixture-subject').value()).toBe('y');
      });
    });
  `,
  // Only a hoisted top-level jest.mock: installed once, before anything loads.
  // C1 must be false.
  HOISTED: `
    jest.mock('axios', () => ({ get: jest.fn() }));
    const subject = require('./fixture-subject');
    describe('d', () => {
      it('a', () => { expect(subject.value()).toBeDefined(); });
      it('b', () => { expect(subject.value()).toBeDefined(); });
    });
  `,
  V1: `
    describe('d', () => {
      afterEach(() => { delete process.env.FLAG; jest.resetModules(); });
      it('a', async () => {
        process.env.FLAG = 'true';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBe('true');
      });
      it('b', async () => {
        jest.resetModules();
        process.env.FLAG = 'false';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBe('false');
      });
    });
  `,
  V2: `
    describe('d', () => {
      afterEach(() => { delete process.env.FLAG; jest.resetModules(); });
      it('a', async () => {
        jest.resetModules();
        jest.doMock('axios', () => ({}));
        const m = require('./fixture-subject');
        process.env.FLAG = 'true';
        expect(m.value()).toBe('true');
      });
      it('b', async () => {
        jest.resetModules();
        process.env.FLAG = 'false';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBe('false');
      });
    });
  `,
  V3: `
    describe('d', () => {
      afterEach(() => { delete process.env.FLAG; jest.resetModules(); });
      it('a', async () => {
        jest.resetModules();
        process.env.FLAG = 'true';
        const m = require('./fixture-subject');
        jest.doMock('./fixture-subject', () => ({}));
        expect(m.value()).toBe('true');
      });
      it('b', async () => {
        jest.resetModules();
        process.env.FLAG = 'false';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBe('false');
      });
    });
  `,
  V4: `
    describe('d', () => {
      it('a', async () => {
        jest.resetModules();
        process.env.FLAG = 'true';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBe('true');
      });
      it('b', async () => {
        jest.resetModules();
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBeDefined();
      });
    });
  `,
  // The pre-#1078 shape, embedded so the discrimination check never depends on
  // git being present (#1087 review: the git path used to print SKIP and record
  // nothing, so `--self-test` returned 0 with the check silently not run).
  // It loads the REAL server/services/real-storage-client.js, whose module-scope
  // `ENABLE_REAL_STORAGE` read survived #1078 — so C2-env is established against
  // current source rather than a frozen copy that could drift.
  PRE_1078_SHAPE: `
    describe('real-storage-client: ENABLE_REAL_STORAGE=false (stub mode)', () => {
      beforeEach(() => {
        jest.resetModules();
        delete process.env.ENABLE_REAL_STORAGE;
      });
      afterEach(() => {
        delete process.env.ENABLE_REAL_STORAGE;
        jest.resetModules();
      });
      it('stub mode makes no HTTP call', async () => {
        const axiosMock = { post: jest.fn() };
        jest.doMock('axios', () => ({ default: axiosMock, ...axiosMock }));
        const { ipfsPinAdd } = await import('../../server/services/real-storage-client.js');
        expect(await ipfsPinAdd('cid')).toBeDefined();
      });
      it('flag-on mode posts', async () => {
        process.env.ENABLE_REAL_STORAGE = 'true';
        const axiosMock = { post: jest.fn() };
        jest.doMock('axios', () => ({ default: axiosMock, ...axiosMock }));
        const { ipfsPinAdd } = await import('../../server/services/real-storage-client.js');
        expect(await ipfsPinAdd('cid')).toBeDefined();
      });
    });
  `,
  // V4 negatives (#1087 review): whole-environment restoration is the careful
  // pattern, and V4 used to report it as a leak. Both of these must be CLEAN of
  // V4 while still being HAZARD on the conjuncts.
  V4_NEG_WHOLE_OBJECT: `
    const originalEnv = { ...process.env };
    describe('d', () => {
      afterEach(() => { process.env = { ...originalEnv }; jest.resetModules(); });
      it('a', async () => {
        jest.resetModules();
        process.env.FLAG = 'true';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBe('true');
      });
      it('b', async () => {
        jest.resetModules();
        process.env.FLAG = 'false';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBe('false');
      });
    });
  `,
  V4_NEG_HELPER_ASSIGN: `
    const ORIGINAL_ENV = { ...process.env };
    const resetEnv = () => { Object.assign(process.env, ORIGINAL_ENV); };
    describe('d', () => {
      afterAll(() => { resetEnv(); });
      it('a', async () => {
        jest.resetModules();
        process.env.FLAG = 'true';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBe('true');
      });
      it('b', async () => {
        jest.resetModules();
        process.env.FLAG = 'false';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBe('false');
      });
    });
  `,
  // The false negative Bob found: same substitution sequence as ORDERED, but the
  // helper is declared INSIDE the describe. Must classify HAZARD.
  DESCRIBE_SCOPED_HELPER: `
    describe('d', () => {
      function buildClient(get) {
        jest.resetModules();
        jest.doMock('axios', () => ({ get, post: jest.fn() }));
        return require('./fixture-subject');
      }
      afterEach(() => { delete process.env.FLAG; jest.resetModules(); });
      it('a', async () => {
        process.env.FLAG = 'true';
        expect(buildClient(jest.fn()).value()).toBe('true');
      });
      it('b', async () => {
        process.env.FLAG = 'false';
        expect(buildClient(jest.fn()).value()).toBe('false');
      });
    });
  `,
  V5: `
    const pinned = require('./fixture-subject');
    describe('d', () => {
      afterEach(() => { delete process.env.FLAG; jest.resetModules(); });
      it('a', async () => {
        jest.resetModules();
        process.env.FLAG = 'true';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBe(pinned.value());
      });
      it('b', async () => {
        jest.resetModules();
        process.env.FLAG = 'false';
        jest.doMock('axios', () => ({}));
        expect(require('./fixture-subject').value()).toBeDefined();
      });
    });
  `,
};

// Every check `selfTest` is expected to execute. If a check stops running — the
// way the git-blob one silently did — the tally will not match and the self-test
// fails instead of reporting success on a smaller battery (#1087 review).
const EXPECTED_SELF_TEST_CHECKS = 17;

function selfTest() {
  const failures = [];
  let checksRun = 0;
  const check = (label, cond, detail) => {
    checksRun += 1;
    if (cond) console.log(`  ok    ${label}`);
    else {
      console.log(`  FAIL  ${label} — ${detail}`);
      failures.push(label);
    }
  };

  if (!existsSync(FIXTURE_SUBJECT)) {
    console.error(`FAIL  fixture subject missing at ${relative(ROOT, FIXTURE_SUBJECT)}`);
    return 1;
  }

  console.log('self-test: conjuncts (a rule that stops discriminating must show up here)');
  {
    const r = analyse(FIXTURE_PATH, FIXTURES.HOISTED);
    check('HOISTED fixture fails C1 (top-level jest.mock is not in the class)', !r.C1 && !r.hazardous, `C1=${r.C1}`);
  }
  {
    const r = analyse(FIXTURE_PATH, FIXTURES.DIRECT);
    check('DIRECT fixture fails C2 (mocking the module you then load is a direct replacement)', r.C1 && !r.C2, `C1=${r.C1} C2=${r.C2} injections=${r.injections.length}`);
  }
  {
    const r = analyse(FIXTURE_PATH, FIXTURES.ORDERED);
    check('ORDERED fixture is HAZARDOUS with no V1..V5 (tidiness is not an exemption)', r.hazardous && r.violations.length === 0, `hazardous=${r.hazardous} violations=[${r.violations.map((v) => v.id).join(',')}]`);
  }
  {
    // Regression guard for the false negative found reviewing #1087.
    const r = analyse(FIXTURE_PATH, FIXTURES.DESCRIBE_SCOPED_HELPER);
    check('DESCRIBE_SCOPED_HELPER fixture is HAZARDOUS (helpers are not only module-scope)', r.hazardous, `C1=${r.C1} C2=${r.C2} C3=${r.C3} substitutingTests=${r.substitutingTests}`);
  }
  {
    const r = analyse(FIXTURE_PATH, FIXTURES.V4_NEG_WHOLE_OBJECT);
    const v4 = r.violations.filter((v) => v.id === 'V4');
    check('V4_NEG_WHOLE_OBJECT raises no V4 (`process.env = {...saved}` is a restore)', r.C1 && r.C2 && v4.length === 0, `V4=${v4.length} C1=${r.C1} C2=${r.C2}`);
  }
  {
    const r = analyse(FIXTURE_PATH, FIXTURES.V4_NEG_HELPER_ASSIGN);
    const v4 = r.violations.filter((v) => v.id === 'V4');
    check('V4_NEG_HELPER_ASSIGN raises no V4 (Object.assign restore inside a helper)', r.C1 && r.C2 && v4.length === 0, `V4=${v4.length} C1=${r.C1} C2=${r.C2}`);
  }

  console.log('self-test: violation rules (each must fire on its own shape)');
  for (const id of ['V1', 'V2', 'V3', 'V4', 'V5']) {
    const r = analyse(FIXTURE_PATH, FIXTURES[id]);
    const ids = new Set(r.violations.map((v) => v.id));
    check(`${id} fixture raises ${id}`, r.hazardous && ids.has(id), `hazardous=${r.hazardous} C1=${r.C1} C2=${r.C2} C3=${r.C3} raised=[${[...ids].join(',')}]`);
  }

  console.log('self-test: the empirically-observed file, before and after #1078');
  const realStorage = join(ROOT, '__tests__', 'real-storage-integrations.test.ts');
  {
    // Runs unconditionally: the discrimination assertion must not depend on git.
    const shape = analyse(join(ROOT, '__tests__', 'embedded', 'pre-1078-shape.test.ts'), FIXTURES.PRE_1078_SHAPE);
    check('EMBEDDED pre-#1078 shape is HAZARDOUS (no git required)', shape.hazardous, `C1=${shape.C1} C2=${shape.C2} C3=${shape.C3} coupled=[${shape.coupledKeys.join(',')}]`);
    check('EMBEDDED pre-#1078 shape shows BOTH sub-cases of C2', shape.injections.length > 0 && shape.coupledKeys.length > 0, `injections=${shape.injections.length} coupled=[${shape.coupledKeys.join(',')}]`);
  }
  let pre;
  let gitError = '';
  try {
    pre = execFileSync('git', ['show', '9a826253^:__tests__/real-storage-integrations.test.ts'], {
      cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024,
    });
  } catch (e) {
    gitError = String(e.message).split('\n')[0];
  }
  if (!pre) {
    // Fails closed. Previously this printed SKIP and recorded nothing, so the
    // battery shrank silently and still exited 0 (#1087 review).
    check('HISTORICAL pre-#1078 blob is retrievable', false, `git show failed: ${gitError}`);
    check('HISTORICAL pre-#1078 blob is HAZARDOUS', false, 'not evaluated — blob unavailable');
    check('HISTORICAL pre-#1078 blob shows BOTH sub-cases of C2', false, 'not evaluated — blob unavailable');
  }
  if (pre) {
    check('HISTORICAL pre-#1078 blob is retrievable', true, '');
    const before = analyse(realStorage, pre);
    check(
      'HISTORICAL pre-#1078 blob is HAZARDOUS',
      before.hazardous,
      `C1=${before.C1} C2=${before.C2} C3=${before.C3}`,
    );
    check(
      'HISTORICAL pre-#1078 blob shows BOTH sub-cases of C2 (axios injection AND env snapshot)',
      before.injections.length > 0 && before.coupledKeys.length > 0,
      `injections=${before.injections.length} coupled=[${before.coupledKeys.join(',')}]`,
    );
  }
  if (!existsSync(realStorage)) {
    check('POST-#1078 real-storage-integrations.test.ts is present', false, `missing at ${relative(ROOT, realStorage)}`);
  }
  if (existsSync(realStorage)) {
    const after = analyse(realStorage);
    check(
      'POST-#1078 real-storage-integrations.test.ts is CLEAN (the fix is what the detector measures)',
      !after.hazardous,
      `C1=${after.C1} C2=${after.C2} C3=${after.C3} violations=[${after.violations.map((v) => `${v.id}@${v.line}`).join(', ')}]`,
    );
  }

  if (checksRun !== EXPECTED_SELF_TEST_CHECKS) {
    console.error(
      `\nself-test FAILED: ran ${checksRun} checks, expected ${EXPECTED_SELF_TEST_CHECKS}. ` +
        'A check that stops executing must fail the battery, not shrink it silently.',
    );
    return 1;
  }
  if (failures.length > 0) {
    console.error(`\nself-test FAILED: ${failures.length} check(s) — the predicate is not measuring what it claims.`);
    return 1;
  }
  console.log(`\nself-test passed (${checksRun} checks).`);
  return 0;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
if (args.includes('--self-test')) process.exit(selfTest());

const jsonOut = args.includes('--json');
const explicit = args.filter((a) => !a.startsWith('--'));
const files = explicit.length > 0 ? explicit.map((f) => resolve(ROOT, f)) : listTestFiles();

const grepMatches = [];
const results = [];
for (const f of files) {
  let text;
  try {
    text = readFileSync(f, 'utf8');
  } catch {
    continue;
  }
  const matches = GREP.test(text);
  if (matches) grepMatches.push(f);
  else if (explicit.length === 0) continue; // tier 0 is the entry gate for a full scan
  results.push(analyse(f));
}

// Anti-vacuity. Parsing nothing is always a broken scan. Resolving no module
// graph is broken ONLY when some file actually performed a runtime load —
// a file with none (which is what the fix looks like) legitimately has no graph
// to walk, and must be allowed to come out CLEAN.
if (stats.filesParsed === 0) {
  console.error('VACUOUS SCAN — parsed no files. Failing rather than reporting a clean bill.');
  process.exit(2);
}
if (stats.runtimeLoadSites > 0 && stats.graphNodes === 0) {
  console.error(
    `VACUOUS SCAN — ${stats.runtimeLoadSites} runtime load site(s) were found but no module graph resolved, ` +
      'so C2 could never have been established. Resolution is broken; failing rather than reporting a clean bill.',
  );
  process.exit(2);
}

const tier1 = results.filter((r) => r.C1);
const tier2 = tier1.filter((r) => r.C2);
const hazard = tier2.filter((r) => r.C3);

if (jsonOut) {
  console.log(JSON.stringify({
    stats,
    counts: { grep: grepMatches.length, c1: tier1.length, c2: tier2.length, hazard: hazard.length },
    results,
  }, null, 2));
  process.exit(hazard.length > 0 ? 1 : 0);
}

console.log(`scanned ${files.length} test files; parsed ${stats.filesParsed}, found ${stats.runtimeLoadSites} runtime load sites, resolved ${stats.specifiersResolved} specifiers, visited ${stats.graphNodes} module-graph nodes\n`);
console.log('POPULATION');
console.log(`  tier 0  grep jest.doMock|jest.resetModules ............. ${grepMatches.length}`);
console.log(`  tier 1  C1 runtime registry mutation .................. ${tier1.length}`);
console.log(`  tier 2  C1 + C2 registry-mediated injection ........... ${tier2.length}`);
console.log(`  HAZARD  C1 + C2 + C3 re-performed across tests ........ ${hazard.length}\n`);

for (const r of hazard) {
  const flag = r.hasBindingAssertion ? ' [has a binding assertion — fails honestly, still dependent]' : ' [NO binding assertion — can go vacuously green]';
  console.log(`HAZARD  ${r.file}  (${r.tests} tests, ${r.substitutingTests} of them re-perform the substitution)${flag}`);
  for (const i of r.injections) console.log(`          injects '${i.injected}' into ${i.subject} via the registry (${i.via})`);
  for (const s of r.coupledSpecs) console.log(`          env snapshot: ${s.target} reads [${s.keys.join(', ')}] at import time`);
  for (const v of r.violations) console.log(`          ${v.id} line ${v.line}: ${v.detail}`);
  console.log('');
}

const c2NotC3 = tier2.filter((r) => !r.C3);
if (c2NotC3.length > 0) {
  console.log(`SINGLE-SHOT (${c2NotC3.length}) — C1+C2 hold but fewer than two tests re-perform the substitution:`);
  for (const r of c2NotC3) console.log(`  ${r.file}`);
  console.log('');
}

const c1Only = tier1.filter((r) => !r.C2);
console.log(`NOT IN THE CLASS (${c1Only.length}) — they mutate the registry, but nothing is injected THROUGH it:`);
for (const r of c1Only) console.log(`  ${r.file}`);

process.exit(hazard.length > 0 ? 1 : 0);
