/**
 * Jest config for running tests from within the .claude worktree.
 * Removes the /.claude/ ignore pattern so tests in this worktree can run.
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
};
