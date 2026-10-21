module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: [
    '**/*.test.ts',
    '**/*.spec.ts',
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: {
        target: 'ES2020',
        module: 'CommonJS',
        moduleResolution: 'node',
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        skipLibCheck: true,
        types: ['jest', 'node'],
      },
    }],
  },
  collectCoverageFrom: [
    '**/*.ts',
    '!**/*.d.ts',
  ],
  coverageDirectory: 'coverage',
  testTimeout: 30000,
};
