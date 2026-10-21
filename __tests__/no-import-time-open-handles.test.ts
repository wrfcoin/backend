/**
 * #977 ratchet — no module may start a ref'd timer at import.
 *
 * #978, #999 and #1010 removed 14 traced open handles. None of that was
 * self-defending: the next module-scope `setInterval` reintroduces the class,
 * and `forceExit: true` on the canonical gate hides it exactly as it hid the
 * first fourteen. #977 has already regrown once.
 *
 * ## Why this guard is STATIC, and what pairs with it
 *
 * The first version of this file imported every candidate module and asserted
 * `hasRef() === false` on the timers each import created — the truer property.
 * But importing ~87 modules for inspection also opens their real Redis and
 * Postgres clients, and one of them killed the entire gate run with an
 * asynchronous `NOAUTH Authentication required` **after** the suite had passed.
 * A guard that can crash the run it protects is worse than no guard.
 *
 * So the work is split, and each half does what it is good at:
 *
 *   - **This file: static breadth.** Scans every candidate module, imports
 *     nothing, so it cannot crash, hang or open a socket. Catches a new leak
 *     anywhere in the tree.
 *   - **`module-scope-timers-unref.test.ts`: dynamic depth.** Imports the 11
 *     modules that actually leaked and asserts the real runtime property,
 *     `hasRef() === false`.
 *
 * Static alone would be a regex pretending to be a proof; dynamic alone cannot
 * safely cover the tree. Together the claim is honest.
 *
 * ## What counts as import-reachable
 *
 *   - a timer created at column 0 (the module body), or
 *   - a timer inside a `constructor(...)` in a file that also builds a
 *     module-scope instance — the shape behind most of the original 14.
 *
 * **Process entrypoints are skipped, DERIVED rather than allowlisted**: a file
 * calling `.listen(` is a standalone server where a ref'd keepalive is CORRECT,
 * and unref'ing it would be the bug. `governance_server.js` keeps its heartbeat.
 * A derived rule cannot go stale the way an allowlist does (see #1009).
 *
 * ## Anti-vacuity
 *
 * Asserts it examined a non-zero set — files scanned, entrypoints skipped, and
 * timers actually inspected. A guard that inspects nothing passes trivially,
 * which is the exact failure mode it exists to prevent.
 *
 * ## What this does NOT pin — each found by running a RED control, not by taste
 *
 *   - **A timer that does not begin its line.** `constructor() { setInterval(…) }`
 *     written on ONE line is missed: the matcher is line-anchored. Realistic
 *     code puts the call on its own line (and that form IS caught), but this is
 *     a real hole and it is stated rather than discovered later.
 *   - **It reads source**, so it proves an `.unref()` is *written* for each
 *     import-reachable timer — not that it *executed*. The dynamic companion
 *     suite proves execution for the modules that actually leaked.
 *   - Timers created at RUNTIME by methods a caller invokes; those are owned by
 *     the caller and are not leaks.
 *   - Non-timer handles (sockets, file watchers) need a different probe.
 *   - Discovery requires a module-scope `new` binding or a column-0 timer.
 *     Widening it was MEASURED and surfaces 6 further leaking modules
 *     (bridge_monitor, computational/manager, database/connection-pool,
 *     eclipse-protection-middleware, securityAlertMiddleware.ts,
 *     utils/memoryOptimizer). Real, but a separate body of work: widening
 *     without fixing them lands a failing guard, and a baseline exemption list
 *     would decay exactly like the allowlist retired in #1009.
 */

import { describe, expect, it } from '@jest/globals';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..');
const ROOTS = ['server', 'shared', 'services', 'database'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '__tests__', '.claude', '.git', 'coverage']);

const SINGLETON_BINDING = /^(?:export\s+)?(?:const|let|var)\s+[a-zA-Z_$][\w$]*\s*=\s*new\b/m;
const MODULE_SCOPE_TIMER = /^(?:const [a-zA-Z_$][\w$]* = )?set(?:Interval|Timeout)\(/m;
/** Derived, not allowlisted — a listening server is meant to stay alive. */
const PROCESS_ENTRYPOINT = /\.listen\(/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (/\.(ts|js)$/.test(entry) && !/\.d\.ts$/.test(entry)) out.push(full);
  }
  return out;
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

interface Scan {
  filesScanned: number;
  entrypointsSkipped: number;
  timersInspected: number;
  findings: Finding[];
}

/**
 * The line that opens the block enclosing `idx`, brace-counted rather than
 * guessed. Returns null if `idx` is not inside a block.
 *
 * Starts at `idx - 1` deliberately. A timer line usually ENDS in `{` — the
 * arrow-function body of `setInterval(async () => {` — so scanning from `idx`
 * finds that brace first and reports the timer line as its own enclosing block.
 * Any brace on the timer's own line belongs to the timer statement, not to the
 * block containing it.
 */
function enclosingBlockOpener(lines: string[], idx: number): string | null {
  let depth = 0;
  for (let i = idx - 1; i >= 0; i--) {
    const line = lines[i];
    for (let c = line.length - 1; c >= 0; c--) {
      if (line[c] === '}') depth += 1;
      else if (line[c] === '{') {
        if (depth === 0) return line;
        depth -= 1;
      }
    }
  }
  return null;
}

/** Is line `idx` inside a `constructor(` body? */
function insideConstructor(lines: string[], idx: number): boolean {
  const opener = enclosingBlockOpener(lines, idx);
  return opener !== null && /\bconstructor\s*\(/.test(opener);
}

/**
 * Every `this.foo(...)` the constructor invokes.
 *
 * #1013 review: the original discovery only reached timers written directly in
 * a `constructor(...)` body, and three of the fixes this suite shipped are NOT
 * written that way — `session-service.ts`, `password-reset-service.ts` and
 * `security-audit-trail.ts` all have the constructor call a private starter
 * (`startCleanupTimer()`, `startBufferFlush()`) which creates the timer. Those
 * timers are genuinely import-reachable (module-scope `new` -> constructor ->
 * starter -> setInterval), so deleting their `.unref()` left the guard GREEN.
 * Verified by mutation before this change: removing
 * `this.cleanupTimer.unref()` from session-service.ts did not fail the suite.
 *
 * This is deliberately ONE level of delegation, not "any method". Widening to
 * every method was measured in the original PR and surfaces six further leaking
 * modules — real, but a separate body of work, and landing a failing guard or a
 * decaying baseline list is the thing #1009 retired.
 */
function constructorDelegates(lines: string[]): Set<string> {
  const names = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    if (!/\bconstructor\s*\(/.test(lines[i])) continue;
    let depth = 0;
    let started = false;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) {
        if (ch === '{') {
          depth += 1;
          started = true;
        } else if (ch === '}') depth -= 1;
      }
      if (started && j > i) {
        for (const m of lines[j].matchAll(/this\.([\w$]+)\s*\(/g)) names.add(m[1]);
      }
      if (started && depth === 0) break;
    }
  }
  return names;
}

/** Is `idx` inside a method the constructor calls? */
function insideConstructorDelegate(
  lines: string[],
  idx: number,
  delegates: Set<string>,
): boolean {
  const opener = enclosingBlockOpener(lines, idx);
  if (opener === null) return false;
  const m = opener.match(
    /^\s*(?:private\s+|public\s+|protected\s+|async\s+)*([\w$]+)\s*\(/,
  );
  return m !== null && delegates.has(m[1]);
}

function scan(): Scan {
  let filesScanned = 0;
  let entrypointsSkipped = 0;
  let timersInspected = 0;
  const findings: Finding[] = [];

  for (const root of ROOTS) {
    for (const file of walk(path.join(REPO_ROOT, root))) {
      let src: string;
      try {
        src = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      const hasSingleton = SINGLETON_BINDING.test(src);
      if (!hasSingleton && !MODULE_SCOPE_TIMER.test(src)) continue;
      if (PROCESS_ENTRYPOINT.test(src)) {
        entrypointsSkipped += 1;
        continue;
      }
      filesScanned += 1;

      const lines = src.split('\n');
      const delegates = constructorDelegates(lines);
      for (let i = 0; i < lines.length; i++) {
        const m = lines[i].match(
          /^(\s*)(?:(?:const|let|var)\s+(?<local>[\w$]+)\s*=\s*|this\.(?<field>[\w$]+)\s*=\s*)?set(?:Interval|Timeout)\(/,
        );
        if (!m) continue;
        const atModuleScope = m[1].length === 0;
        const reachable =
          hasSingleton &&
          (insideConstructor(lines, i) ||
            insideConstructorDelegate(lines, i, delegates));
        if (!atModuleScope && !reachable) continue;

        timersInspected += 1;

        // Match by BINDING NAME, not a line window. An earlier draft searched a
        // fixed 14-line window: it produced false positives on multi-line
        // intervals whose unref sat past the window, and missed `.unref?.()`
        // entirely. Both were found by running it, not by reading it.
        const local = m.groups?.local;
        const field = m.groups?.field;
        const binding = local ? local : field ? `this\\.${field}` : null;

        // An anonymous timer discards its handle, so it can NEVER be unref'd or
        // cleared by anyone. That is always a finding.
        const unrefd =
          binding !== null &&
          new RegExp(`${binding}\\s*\\??\\.unref\\s*(?:\\?\\.)?\\(`).test(src);

        if (!unrefd) {
          findings.push({
            file: path.relative(REPO_ROOT, file),
            line: i + 1,
            text: lines[i].trim(),
          });
        }
      }
    }
  }
  return { filesScanned, entrypointsSkipped, timersInspected, findings };
}

describe('#977 ratchet — no import-time open handles', () => {
  const result = scan();

  it('examined a non-empty set (anti-vacuity)', () => {
    // A guard that inspects nothing passes trivially. If discovery ever returns
    // nothing — a moved directory, a broken regex — this fails LOUDLY rather
    // than reporting a clean bill of health for an empty set.
    expect(result.filesScanned).toBeGreaterThan(20);
    expect(result.entrypointsSkipped).toBeGreaterThan(0);
    expect(result.timersInspected).toBeGreaterThan(5);
  });

  it("every import-reachable timer is unref'd", () => {
    if (result.findings.length > 0) {
      throw new Error(
        `Import-time open handle(s) — a timer created at import must be ` +
          `.unref()'d, or it holds the event loop open for every importer (#977):\n` +
          result.findings.map((f) => `  - ${f.file}:${f.line}  ${f.text}`).join('\n') +
          `\n\nScanned ${result.filesScanned} file(s); inspected ` +
          `${result.timersInspected} import-reachable timer(s).`,
      );
    }
    expect(result.findings).toEqual([]);
  });
});
