/**
 * Standalone Jest Configuration for Backend Tests
 * Run from backend directory with: npx jest --config __tests__/jest.standalone.cjs
 *
 * Quarantine (backend#872): suites listed in ./quarantine.cjs fail/hang on clean
 * main for reasons unrelated to any one change and are excluded by default so the
 * suite is green-by-default and can gate PRs (#870). Set RUN_QUARANTINED=1 to run
 * ONLY the quarantined suites for triage (`npm run test:quarantined`).
 */

const { QUARANTINED_PATTERNS, QUARANTINED_FILES } = require('./quarantine.cjs');

const RUN_QUARANTINED = process.env.RUN_QUARANTINED === '1';

module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '..',
  // Runs BEFORE the test framework and before any module is required
  // (backend#992): supplies test-only defaults for env vars that modules
  // validate at IMPORT time — e.g. sms-service.ts computes a scrypt key from
  // MFA_ENCRYPTION_KEY in a static initializer, so a suite cannot mock or
  // beforeEach its way past a missing value. Config only; never stubs
  // behaviour, and never overwrites an already-set value.
  // guard-network-egress is FIRST so it patches http/https/fetch before any
  // module under test can capture an unguarded reference: tests must not reach
  // external hosts, because a mock that fails to bind otherwise calls the real
  // third-party API silently (backend#1017). Loopback only; derived, not a list.
  // Fails the whole run first, with one clear message, on a Node major below package.json engines.
  globalSetup: '<rootDir>/__tests__/setup/require-supported-node.cjs',
  setupFiles: [
    '<rootDir>/__tests__/setup/guard-network-egress.cjs',
    '<rootDir>/__tests__/setup/test-env-defaults.cjs',
  ],
  // Runs after the test framework installs (needs beforeEach/afterEach):
  // neutralizes stray process.exit() so one suite can't truncate the whole
  // run (backend#872).
  setupFilesAfterEnv: ['<rootDir>/__tests__/setup/guard-process-exit.cjs'],
  testMatch: RUN_QUARANTINED
    ? QUARANTINED_FILES.map((f) => `<rootDir>/${f}`)
    : [
        // backend#1089 (residual of #907): the extension class is [jt]s, not ts.
        // #907 repaired discovery for server/__tests__/ but added .ts patterns
        // only, so eight .js suites sat dark INSIDE the directory it repaired —
        // a half-closed fix, invisible because the issue reads as resolved.
        // This widens the extension on the roots already covered; it does NOT
        // add new roots. The ~48 test files outside these two roots stay
        // undiscovered by design — widening the roots is a separate decision.
        '<rootDir>/__tests__/**/*.test.[jt]s',
        '<rootDir>/__tests__/**/*.spec.[jt]s',
        // backend#907: server/__tests__/ was silently never discovered — it
        // orphaned the faucet double-dispense (#887) and reward double-claim
        // (#215) regression tests. Anchored at <rootDir>/server so nested
        // worktree copies (.claude/worktrees/**) are NOT matched. Known-failing
        // suites here are quarantined in quarantine.cjs like the top-level set.
        '<rootDir>/server/__tests__/**/*.test.[jt]s',
        '<rootDir>/server/__tests__/**/*.spec.[jt]s',
      ],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', {
      isolatedModules: true,
      diagnostics: false,
      tsconfig: {
        target: 'ES2020',
        module: 'CommonJS',
        moduleResolution: 'node',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        allowJs: true,
        outDir: './.ts-jest',
        skipLibCheck: true,
        types: ['jest', 'node'],
        strict: false,
      },
    }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^@wrfcoin/meteo-types$': '<rootDir>/shared/generated-types/index',
    '^@wrfcoin/meteo-types/(.*)$': '<rootDir>/shared/generated-types/$1',
  },
  transformIgnorePatterns: [
    'node_modules/(?!(uuid|axios)/)',
  ],
  collectCoverageFrom: [
    'src/**/*.ts',
    'server/**/*.ts',
    '!**/*.d.ts',
  ],
  coverageDirectory: '__tests__/coverage',
  testTimeout: 30000,
  // See jest.config.cjs for the full account: ~1 GB per worker × (cores - 1)
  // defaults to ~31 GB on a 32-core box, which OOM-killed the machine twice on
  // 2026-07-29. This is the config `npm test` uses, so it needs the same cap.
  maxWorkers: Number(process.env.JEST_MAX_WORKERS) || 4,
  workerIdleMemoryLimit: '1.5GB',
  verbose: true,
  forceExit: true,
  detectOpenHandles: true,
  // Default gate excludes the #872 quarantine (testMatch already narrows to only
  // quarantined files when RUN_QUARANTINED=1, so no extra ignores needed there).
  testPathIgnorePatterns: RUN_QUARANTINED
    ? ['/node_modules/', '/dist/']
    : ['/node_modules/', '/dist/', ...QUARANTINED_PATTERNS],
};
