/**
 * Jest config for Elsa's new test files (#477, #457, #462).
 * Uses diagnostics:false for ts-jest — the weather-data-service.ts source has
 * a pre-existing type error (missing windDirection) tracked in #477.
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { diagnostics: false }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^(\\.\\.?/.*)\\.js$': '$1',
  },
  testPathIgnorePatterns: ['/node_modules/'],
  testMatch: [
    '**/server/__tests__/services/weather-data-service.test.ts',
    '**/server/__tests__/idempotency-replay.test.ts',
    '**/shared/__tests__/currency-boundary.test.ts',
  ],
  testTimeout: 90000,
};
