/**
 * Owner ruling 2026-10-03 (S55 item 26): the MFA, WebAuthn, session, OAuth and
 * security-admin routers stay UNMOUNTED. Login is wallet-based and nothing
 * consumes them. server/SERVICE_REGISTRY.md must record that, and no entrypoint may mount
 * them without that ruling being revisited. (social-auth-routes is a different,
 * mounted router and is not part of this ruling.)
 */

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const read = (rel: string): string => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const UNMOUNTED = [
  'mfa-routes',
  'webauthn-routes',
  'session-routes',
  'oauth-routes',
  'security-admin-routes',
];

describe('unmounted auth routers (owner ruling 2026-10-03)', () => {
  it('server/SERVICE_REGISTRY.md records each router as unmounted by ruling', () => {
    const doc = read('server/SERVICE_REGISTRY.md');
    expect(doc).toContain('Unmounted by owner ruling');
    for (const name of UNMOUNTED) {
      expect(doc).toContain(`${name}`);
    }
  });

  it('no server entrypoint mounts them', () => {
    const entrypoints = [
      'server/enhanced_unified_api_optimized.ts',
      'server/server.js',
    ];
    for (const file of entrypoints) {
      const src = read(file);
      for (const name of UNMOUNTED) {
        expect(`${file} mounts ${name}: ${src.includes(name)}`).toBe(`${file} mounts ${name}: false`);
      }
    }
  });
});
