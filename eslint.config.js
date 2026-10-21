import js from '@eslint/js';
import tseslint from '@typescript-eslint/eslint-plugin';
import tsparser from '@typescript-eslint/parser';

export default [
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.jsx', '**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node.js environment globals
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        module: 'readonly',
        require: 'readonly',
        exports: 'readonly',
        Buffer: 'readonly',
        global: 'readonly',
        console: 'readonly',
        // Timer functions
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        // Fetch API
        fetch: 'readonly',
        // Common Node.js modules
        URL: 'readonly',
        URLSearchParams: 'readonly',
        // Test globals
        describe: 'readonly',
        it: 'readonly',
        expect: 'readonly',
        test: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
      semi: ['error', 'always'],
      quotes: ['error', 'single'],
      indent: ['error', 2],
      'comma-dangle': ['error', 'always-multiline'],
      'no-trailing-spaces': 'error',
      'eol-last': 'error',
      // Deprecate legacy logger imports
      'no-restricted-imports': ['warn', {
        paths: [{
          name: '../utils/logger',
          message: 'DEPRECATED: Use "../server/utils/logger.js" with specialized loggers (appLogger, securityLogger, etc.) for structured logging and sensitive data masking.',
        }, {
          name: '../../utils/logger',
          message: 'DEPRECATED: Use "../../server/utils/logger.js" with specialized loggers (appLogger, securityLogger, etc.) for structured logging and sensitive data masking.',
        }, {
          name: '../../../utils/logger',
          message: 'DEPRECATED: Use "../../../server/utils/logger.js" with specialized loggers (appLogger, securityLogger, etc.) for structured logging and sensitive data masking.',
        }],
        patterns: [{
          group: ['**/utils/logger', '**/utils/logger.js'],
          message: 'DEPRECATED: Use the unified Winston logger from server/utils/logger.ts instead.',
        }],
      }],
    },
  },
  // Production code - no-console as error
  {
    files: [
      'server/**/*.ts',
      'server/**/*.js',
      'routes/**/*.ts',
      'routes/**/*.js',
      'services/**/*.ts',
      'services/**/*.js',
      'middleware/**/*.ts',
      'middleware/**/*.js',
      'api/**/*.ts',
      'api/**/*.js',
      'graphql/**/*.ts',
      'graphql/**/*.js',
      'microservices/**/*.ts',
      'microservices/**/*.js',
      'shared/**/*.ts',
      'shared/**/*.js',
    ],
    rules: {
      'no-console': 'error',
    },
  },
  // Scripts, tests, and examples - keep warn level
  {
    files: ['scripts/**/*.ts', 'scripts/**/*.js', '**/*.test.ts', '**/*.test.js', '**/*.spec.ts', '**/*.spec.js', 'dev/**/*.ts', 'dev/**/*.js', '**/examples/**/*.ts', '**/examples/**/*.js'],
    rules: {
      'no-console': 'warn',
    },
  },
  {
    ignores: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '*.min.js',
      'coverage/**',
      'logs/**',
      'test/**/*.log',
      '**/*.d.ts',
    ],
  },
];
