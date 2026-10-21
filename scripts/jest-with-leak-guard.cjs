#!/usr/bin/env node
/**
 * Run jest, then FAIL if the run leaked a live child process (backend#1077).
 *
 * Why this exists: a suite spawned a real dev server (`npx tsx
 * server/enhanced_unified_api_optimized.ts`) and its teardown SIGTERMed the
 * npx wrapper instead of the server — so after `npm test` exited 0, an
 * orphaned tsx server kept burning ~98% CPU indefinitely (reparented to
 * PID 1, observed 20+ minutes later). `forceExit: true` in the jest config
 * means jest itself will never surface this: it force-exits over whatever is
 * still running. Ambient load then climbs with every test run on the
 * machine, destabilising wall-clock assertions (#1076) and making failures
 * non-reproducible in isolation.
 *
 * How it detects OUR leaks and only ours: jest is spawned into its OWN
 * process group (`detached: true` => setsid), and every process the run
 * spawns (workers, and any child a test starts without `detached: true`)
 * inherits that group. A process keeps its pgid even after being orphaned
 * and reparented to PID 1. So after jest exits, any live process still in
 * jest's group is a leaked descendant of THIS run — by construction the
 * wrapper, npm, the shell, and pipeline siblings (`npm test | tee`) are
 * outside the group and can never be misidentified. Other lanes' test runs
 * on the same machine have different pgids and are never touched — that
 * scoping is load-bearing: concurrent lanes measure this exact leak as a
 * confounder, and killing their processes would corrupt their evidence.
 *
 * Verdict:
 *   - survivors found  -> print one LEAKED_TEST_CHILD line each, SIGKILL
 *     them (they are ours to reap; leaving them running IS the #1077
 *     defect), and exit 1 even if jest passed.
 *   - jest failed      -> propagate its exit code (after the same scan).
 *   - clean            -> propagate jest's 0.
 *
 * Known limitation, stated rather than hidden: a test that spawns with
 * `detached: true` escapes the pgid and this guard. No current suite does;
 * a new one that does should register its own teardown and say why.
 *
 * `--self-test` proves the guard can reach BOTH verdicts without jest:
 * it spawns a deliberately-leaked busy child, requires the scan to find it,
 * reaps it, and requires the follow-up scan to come back clean. A guard
 * that cannot demonstrate its own RED is not evidence.
 */
'use strict';

const { execFileSync, spawn } = require('child_process');

function scanSurvivors(pgid, exclude) {
  const table = execFileSync(
    'ps',
    ['-eo', 'pid=,pgid=,etimes=,pcpu=,args='],
    { encoding: 'utf8' },
  );
  const survivors = [];
  for (const line of table.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/);
    if (!match) continue;
    const [, pidStr, pgidStr, etimes, pcpu, args] = match;
    const pid = Number(pidStr);
    if (Number(pgidStr) !== pgid) continue;
    if (exclude.has(pid)) continue;
    // Belt-and-braces: never report a ps snapshot process (it runs outside
    // jest's group in the current design, but this filter keeps the scan
    // safe if the call site ever moves).
    if (args.startsWith('ps -eo ') || args.startsWith('ps -o ')) continue;
    // A zombie is already dead — killed but not yet reaped by its parent
    // (init reaps orphans promptly; our own killed self-test child shows
    // here for an instant). It burns nothing and is not a leak.
    if (args.includes('<defunct>')) continue;
    survivors.push({ pid, etimes: Number(etimes), pcpu, args });
  }
  return survivors;
}

function reportAndReap(survivors) {
  for (const p of survivors) {
    console.error(
      `LEAKED_TEST_CHILD pid=${p.pid} alive_secs=${p.etimes} cpu=${p.pcpu}% cmd=${p.args}`,
    );
    try {
      process.kill(p.pid, 'SIGKILL');
    } catch {
      // already gone — the report above still stands
    }
  }
  if (survivors.length > 0) {
    console.error(
      `JEST_LEAK_GUARD: ${survivors.length} process(es) survived the test run ` +
        '(backend#1077). They were reaped, and this run is FAILED: a test that ' +
        'starts a real server owns tearing it down.',
    );
  }
}

function selfTest() {
  // Deliberately leaked busy child in ITS OWN process group, exactly as the
  // main path isolates jest: the guard must see it there (RED).
  const leaked = spawn(process.execPath, ['-e', 'setInterval(() => {}, 50)'], {
    stdio: 'ignore',
    detached: true,
  });
  const pgid = leaked.pid; // setsid: group leader of the new group
  const exclude = new Set();
  const dirty = scanSurvivors(pgid, exclude).filter((p) => p.pid === leaked.pid);
  if (dirty.length !== 1) {
    console.error('SELF_TEST_FAILED: guard did not detect a deliberately leaked child');
    try { process.kill(leaked.pid, 'SIGKILL'); } catch {}
    return 1;
  }
  reportAndReap(dirty);

  // After reaping, the scan must come back clean for that pid (GREEN).
  const clean = scanSurvivors(pgid, exclude).filter((p) => p.pid === leaked.pid);
  if (clean.length !== 0) {
    console.error('SELF_TEST_FAILED: reaped child still visible');
    return 1;
  }
  console.log('jest-with-leak-guard self-test passed (RED and GREEN both reachable)');
  return 0;
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--self-test') {
    return selfTest();
  }

  // Run jest in its OWN process group (detached => setsid). Everything the
  // run spawns inherits that group; the wrapper, npm, the shell, and any
  // pipeline siblings (`npm test | tee`) live outside it and can never be
  // misidentified — the first draft scanned the wrapper's own group and
  // killed the invoking pipeline's `tail`. Orphans keep the group id even
  // after reparenting to PID 1, which is exactly how we find them.
  const jest = spawn(
    process.execPath,
    [require.resolve('jest/bin/jest'), ...argv],
    { stdio: 'inherit', detached: true },
  );
  const pgid = jest.pid;

  // detached jest is outside the terminal's foreground group, so forward
  // interactive termination to the whole test group.
  const forward = (signal) => {
    try {
      process.kill(-pgid, signal);
    } catch {}
  };
  process.on('SIGINT', () => forward('SIGINT'));
  process.on('SIGTERM', () => forward('SIGTERM'));

  const jestCode = await new Promise((resolve) => {
    jest.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1));
  });

  const survivors = scanSurvivors(pgid, new Set());
  reportAndReap(survivors);

  if (survivors.length > 0) return 1;
  return jestCode;
}

main().then((code) => process.exit(code));
