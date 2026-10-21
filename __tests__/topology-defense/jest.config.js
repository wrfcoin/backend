/**
 * Jest configuration for Topology Attack Defense Tests
 * Memory-optimized configuration for Task 100.13
 */

export default {
  // Test environment
  testEnvironment: 'node',

  // Single worker to prevent parallel memory accumulation
  maxWorkers: 1,

  // Extended timeout for async tests
  testTimeout: 30000,

  // Test file patterns
  testMatch: ['**/*.test.ts'],

  // Root directory for this test suite
  rootDir: '../..',

  // Transform TypeScript
  preset: 'ts-jest',
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          target: 'ES2020',
          module: 'CommonJS',
          moduleResolution: 'node',
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          skipLibCheck: true,
          types: ['jest', 'node'],
        },
      },
    ],
  },

  // Use lightweight setup instead of global
  setupFilesAfterEnv: [],

  // Memory management
  workerIdleMemoryLimit: '512MB',
  logHeapUsage: true,

  // Clear mocks and timers between tests
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,

  // Verbose output for debugging
  verbose: true,

  // No coverage for individual test runs (run with full suite)
  collectCoverage: false,

  // Detect open handles (EventEmitter leaks)
  detectOpenHandles: true,

  // Force exit after tests complete
  forceExit: true,

  // Ignore patterns
  testPathIgnorePatterns: [
    '/node_modules/',
    '/blockchain-core/target/',
    '/dist/',
    '/build/',
  ],
};
