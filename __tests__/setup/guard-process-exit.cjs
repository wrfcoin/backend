/**
 * Test-run integrity guard (backend#872).
 *
 * Some suites reach production code paths that call `process.exit()` (e.g.
 * shared/graceful-shutdown). Under jest that terminates the ENTIRE worker/run
 * mid-suite — the run stops early yet exits 0, masking every not-yet-run suite.
 * That made `npm test` unusable as a gate independent of any individual failure.
 *
 * Loaded via jest `setupFilesAfterEnv` (runs before each test file, after the
 * test framework is installed, so lifecycle hooks are available). Behavior:
 *
 *   - `process.exit()` DURING a test → throw. Jest catches it, only that test
 *     fails, the run continues.
 *   - `process.exit()` OUTSIDE a test (leaked timer after the suite finished,
 *     module load, hooks) → loud console warning + no-op. Throwing here would be
 *     an uncaught exception in a timer callback and would crash the worker —
 *     e.g. graceful-shutdown schedules `setTimeout(() => process.exit(), 100)`,
 *     which fires after its (passing) suite completes.
 *
 * Suites that legitimately assert on exit still work: they install their own
 * `jest.spyOn(process, 'exit')` mock, which supersedes this guard for their
 * duration.
 */

const realExit = process.exit.bind(process);

// Keep an escape hatch for teardown code that must genuinely exit.
process.__realExit = realExit;

let inTest = false;
beforeEach(() => {
  inTest = true;
});
afterEach(() => {
  inTest = false;
});

process.exit = function guardedExit(code) {
  if (inTest) {
    throw new Error(
      `process.exit(${code}) was called during a test. This would truncate the ` +
        `jest run. Mock it (jest.spyOn(process, "exit")) or quarantine the suite ` +
        `(backend#872).`,
    );
  }
  // eslint-disable-next-line no-console
  console.warn(
    `[guard-process-exit] Swallowed process.exit(${code}) outside a test ` +
      `(leaked timer or hook). The code path that scheduled it should be ` +
      `mocked or use fake timers (backend#872).`,
  );
};
