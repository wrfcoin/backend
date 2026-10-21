/** backend#1154 — release server exports no OpenForis fixture or route. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from '@jest/globals';

const repoRoot = path.resolve(__dirname, '../..');

describe('OpenForis release boundary', () => {
  it('does not mount OpenForis API or monitoring routes', () => {
    const server = fs.readFileSync(
      path.join(repoRoot, 'server/enhanced_unified_api_optimized.ts'),
      'utf8',
    );

    expect(server).not.toMatch(/safeMount\(\s*['"]\/api\/openforis['"]/);
    expect(server).not.toMatch(/app\.use\(\s*['"]\/api\/openforis['"]/);
  });

  it('contains no fabricated success fixtures in the retained route module', () => {
    const route = fs.readFileSync(
      path.join(repoRoot, 'server/routes/openforis-routes.ts'),
      'utf8',
    );

    expect(route).not.toMatch(
      /deterministicTxHash|Sample Forest Project|status:\s*['"](?:completed|anchored)['"]|explorer\.wrfcoin\.io/,
    );
    expect(route).toContain('proofClass: \'UNAVAILABLE\'');
  });
});
