import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const entrypoint = readFileSync(
  resolve(process.cwd(), 'server/enhanced_unified_api_optimized.ts'),
  'utf8',
);

function assertTruthfulGraphSource(source: string): void {
  const branchStart = source.indexOf(
    'path === \'/api/smart-contracts/graph\' && req.method === \'GET\'',
  );
  const branchEnd = source.indexOf('// Weather commit/reveal flow endpoints', branchStart);
  const branch = source.slice(branchStart, branchEnd);

  expect(branchStart).toBeGreaterThan(-1);
  expect(branchEnd).toBeGreaterThan(branchStart);
  expect(branch).toMatch(/notWired\(\s*'smart-contracts\.graph'/);
  expect(branch).not.toMatch(/success\(/);
  expect(source).not.toMatch(/auditStatus|['"]audited['"]/);
}

describe('smart-contract graph truth boundary', () => {
  it('replaces the fabricated graph with the not-wired boundary', () => {
    assertTruthfulGraphSource(entrypoint);
  });

  it('rejects restoration of an audited node literal', () => {
    const mutated = `${entrypoint}\nconst restoredNode = { auditStatus: 'audited' };`;

    expect(() => assertTruthfulGraphSource(mutated)).toThrow();
  });
});
