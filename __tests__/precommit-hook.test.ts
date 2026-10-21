import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'fs';
import path from 'path';

const precommitHook = readFileSync(
  path.join(__dirname, '..', '.husky', 'pre-commit'),
  'utf8'
);

describe('pre-commit hardening hook', () => {
  it('blocks staged deletion of security-critical auth files', () => {
    expect(precommitHook).toContain(
      'git diff --cached --diff-filter=D --name-only'
    );
    expect(precommitHook).toContain('server/middleware/rpcAuthMiddleware.js');
    expect(precommitHook).toContain(
      '__tests__/server/rpc-auth-middleware.test.ts'
    );
    expect(precommitHook).toContain(
      'Refusing to commit deletion of security-critical auth files'
    );
  });
});
