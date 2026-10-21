/**
 * #909 / #971 — the enhanced entrypoint's inline error path must emit the same
 * nested `error: { code, message, details }` envelope as every safeMounted
 * router (createApiError), not a flat string.
 *
 * Why this is a SOURCE contract test: `enhanced_unified_api_optimized.ts`
 * starts a listening server as an import side effect (`server.listen`,
 * `export default server`), so the inline handler cannot be exercised
 * in-process without booting the world — which is exactly why no suite pinned
 * it and the flat/nested divergence survived. Same pattern as the #936
 * router-source contract test: derive the claim from the source that ships.
 *
 * What this does NOT pin: a runtime request through handleRequest. If a future
 * refactor builds a second inline responder that bypasses `createApiError`,
 * this test only catches it if it replaces the helper this test reads. The
 * structural fix (a bootable, injectable handler) is #909 follow-up work.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const { createApiError } = require('../server/utils/api-error');

const ENTRYPOINT = path.join(__dirname, '..', 'server', 'enhanced_unified_api_optimized.ts');

describe('#909 enhanced entrypoint error envelope', () => {
  it('createApiError emits the nested envelope safeMounted routers use', () => {
    const body = createApiError('AUTH_REQUIRED', 'Authentication required', { hint: 'x' });
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Authentication required',
        details: { hint: 'x' },
      },
    });
    expect(typeof body.timestamp).toBe('string');
    // The old inline shape put the string at the top level — it must not.
    expect(typeof body.error).not.toBe('string');
  });

  it('the inline error helper routes through createApiError, not a flat literal', () => {
    const src = readFileSync(ENTRYPOINT, 'utf8');

    // The helper exists and calls createApiError.
    const helper = src.match(/const error = \([\s\S]{0,400}?=>[\s\S]{0,200}?;/);
    expect(helper).not.toBeNull();
    expect(helper![0]).toContain('createApiError(');

    // The old flat construction is gone from the helper: no inline object that
    // assigns the message string directly to `error:`.
    expect(helper![0]).not.toMatch(/error:\s*message/);

    // And the entrypoint imports the shared helper rather than re-implementing it.
    expect(src).toMatch(/import \{ createApiError \} from '\.\/utils\/api-error\.js'/);
  });

  it('the auth path forwards a machine-readable code', () => {
    const src = readFileSync(ENTRYPOINT, 'utf8');
    expect(src).toContain("'AUTH_REQUIRED'");
  });
});
