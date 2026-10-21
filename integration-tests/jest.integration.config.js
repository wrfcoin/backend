/**
 * Jest Configuration for Integration Tests
 * Separate configuration for integration tests that require database and external services
 */

module.exports = {
  // Test environment
  testEnvironment: 'node',

  // Test match patterns - only run integration tests
  testMatch: ['<rootDir>/**/*.test.js', '<rootDir>/**/*.integration.test.js'],

  // Setup files
  setupFilesAfterEnv: ['<rootDir>/setup.js'],

  // Module paths and mapping
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/../$1',
    '^@shared/(.*)$': '<rootDir>/../shared/$1',
    '^@server/(.*)$': '<rootDir>/../server/$1',
  },

  // Coverage settings for integration tests
  collectCoverage: true,
  collectCoverageFrom: [
    '../server/**/*.{js,ts}',
    '../shared/**/*.{js,ts}',
    '!../server/**/*.test.{js,ts}',
    '!../server/**/__tests__/**',
    '!../server/compiled/**',
    '!**/node_modules/**',
  ],

  // Coverage thresholds - slightly lower for integration tests
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 70,
      lines: 70,
      statements: 70,
    },
  },

  // Timeout for integration tests (longer than unit tests)
  testTimeout: 30000,

  // Database and external service setup
  globalSetup: '<rootDir>/globalSetup.js',
  globalTeardown: '<rootDir>/globalTeardown.js',

  // Verbose output for debugging
  verbose: true,

  // Fail fast on first test failure
  bail: false,

  // Clear mocks between tests
  clearMocks: true,
  restoreMocks: true,

  // Transform settings
  transform: {
    '^.+\\.(ts|tsx)$': [
      'ts-jest',
      {
        isolatedModules: true,
        useESM: false,
      },
    ],
    '^.+\\.(js|jsx)$': 'babel-jest',
  },

  // Module file extensions
  moduleFileExtensions: ['js', 'json', 'ts', 'tsx', 'node'],

  // Force exit after tests complete
  forceExit: true,

  // Detect open handles for debugging
  detectOpenHandles: true,

  // Maximum number of worker processes
  maxWorkers: 2,
};
