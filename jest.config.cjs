module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
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
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  moduleNameMapper: {
    '^(\\.\\.?/.*)\\.js$': '$1',
    // Strip .cjs so Jest resolves dist-only shims to their .js source peers.
    // Mirrors the .js mapper above; keeps enhanced_unified_api_operational_probes
    // and similar modules testable without a pre-built dist.
    '^(\\.\\.?/.*)\\.cjs$': '$1',
  },
  testPathIgnorePatterns: ['/node_modules/', '/.claude/'],
  // Each worker loads the whole backend module graph through ts-jest and settles
  // around 1 GB RSS. Jest's default is (cores - 1), which on a 32-core dev box is
  // ~31 workers ≈ 31 GB — enough to take the machine down by itself, and it did:
  // two global OOM kills on 2026-07-29 from a bare `npx jest` run. Cap the pool
  // instead of the box. Override with JEST_MAX_WORKERS where more is affordable.
  maxWorkers: Number(process.env.JEST_MAX_WORKERS) || 4,
  // Backstop for the leak case: recycle a worker that grows past the budget
  // rather than letting the pool climb until the kernel intervenes.
  workerIdleMemoryLimit: '1.5GB',
  transformIgnorePatterns: ['node_modules/(?!(uuid|axios|zod)/)'],
};
