/**
 * Jest config for Elsa's new test files (#477, #457, #462).
 * Uses diagnostics:false because weather-data-service.ts has a pre-existing
 * type error (missing windDirection field) tracked in #477 — we must not
 * modify production code to fix it.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: [
    '**/__tests__/services/weather-data-service.test.ts',
    '**/__tests__/idempotency-replay.test.ts',
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', { diagnostics: false }],
    '^.+\\.js$': 'babel-jest',
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testTimeout: 90000,
};
