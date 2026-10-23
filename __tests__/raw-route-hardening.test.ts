/**
 * Defense-in-depth hardening of the enhanced entrypoint's raw handler.
 *
 * `enhanced_unified_api_optimized.ts` starts a listener on import, so the raw
 * handler is pinned the same way as enhanced-api-error-envelope.test.ts: by
 * reading the source that ships. The behavior behind the guards (operator
 * token check, wormhole gate, store bound, CORS) is exercised at runtime.
 */
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ENTRYPOINT = readFileSync(
  path.join(__dirname, '..', 'server', 'enhanced_unified_api_optimized.ts'),
  'utf8'
);

/** Source of one raw-handler branch: from its route match to the next `} else if`. */
function branch(marker: string): string {
  const start = ENTRYPOINT.indexOf(marker);
  expect(start).toBeGreaterThan(-1);
  const next = ENTRYPOINT.indexOf('\n    } else if', start + marker.length);
  return ENTRYPOINT.slice(start, next === -1 ? undefined : next);
}

describe('raw maintenance routes require the operator bearer', () => {
  const routes: Array<[string, string]> = [
    ['cache clear', "path === '/api/cache/clear' && req.method === 'POST'"],
    ['sms queue', "path === '/api/transport/sms/observations/queue' &&"],
    ['wormhole inbound', "path === '/api/bridges/wormhole/inbound/process'"],
    ['wormhole outbound', "path === '/api/bridges/wormhole/outbound/initiate'"],
  ];

  it.each(routes)('%s checks hasOperatorToken before doing work', (_n, marker) => {
    const src = branch(marker);
    const guard = src.indexOf('hasOperatorToken(req)');
    expect(guard).toBeGreaterThan(-1);
    expect(src).toContain("error(401, 'Operator bearer token required'");
    // The guard precedes every side effect in the branch.
    for (const effect of ['cacheManager.clear', 'listQueue', 'processInboundTransfer(', 'initiateOutboundTransfer(']) {
      const at = src.indexOf(effect);
      if (at !== -1) expect(guard).toBeLessThan(at);
    }
  });

  it.each(routes.slice(2))('%s is 404 unless the upstream is configured', (_n, marker) => {
    expect(branch(marker)).toContain('isWormholeBridgeEnabled()');
  });
});

describe('wallet login error body', () => {
  it('does not echo exception text', () => {
    const src = branch("path === '/api/auth/wallet-login' && req.method === 'POST'");
    expect(src).toContain("error(401, 'Wallet login failed', null, 'WALLET_LOGIN_FAILED')");
    expect(src).not.toMatch(/error\(401,\s*e instanceof Error/);
  });
});

describe('operator token helper', () => {
  const { hasOperatorToken } = require('../server/middleware/operator-token-auth');
  const saved = process.env.WRFCOIN_OPERATOR_TOKEN;
  beforeEach(() => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'test-operator-token-value';
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.WRFCOIN_OPERATOR_TOKEN;
    else process.env.WRFCOIN_OPERATOR_TOKEN = saved;
  });

  it('rejects missing and wrong bearers, accepts the configured one', () => {
    expect(hasOperatorToken({ headers: {} })).toBe(false);
    expect(hasOperatorToken({ headers: { authorization: 'Bearer nope' } })).toBe(false);
    expect(
      hasOperatorToken({ headers: { authorization: 'Bearer test-operator-token-value' } })
    ).toBe(true);
  });
});

describe('wormhole gate and bounded state', () => {
  const svc = require('../server/services/wormhole-transfer-service');
  const savedUrl = process.env.WORMHOLE_OPERATOR_API_URL;
  afterEach(() => {
    if (savedUrl === undefined) delete process.env.WORMHOLE_OPERATOR_API_URL;
    else process.env.WORMHOLE_OPERATOR_API_URL = savedUrl;
    svc.__resetWormholeTransferTestState();
  });

  it('is disabled unless WORMHOLE_OPERATOR_API_URL is set', () => {
    delete process.env.WORMHOLE_OPERATOR_API_URL;
    expect(svc.isWormholeBridgeEnabled()).toBe(false);
    process.env.WORMHOLE_OPERATOR_API_URL = '  ';
    expect(svc.isWormholeBridgeEnabled()).toBe(false);
    process.env.WORMHOLE_OPERATOR_API_URL = 'https://operator.example/unlock';
    expect(svc.isWormholeBridgeEnabled()).toBe(true);
  });

  it('caps the in-memory transfer store and evicts the oldest', async () => {
    const db = { execute: async () => ({ rows: [] }) } as any;
    const first = await svc.initiateOutboundTransfer(
      { sender: 'a', recipient: 'b', amount: '1' },
      db
    );
    for (let i = 0; i < svc.MAX_IN_MEMORY_TRANSFERS + 5; i++) {
      await svc.initiateOutboundTransfer({ sender: 'a', recipient: 'b', amount: '1' }, db);
    }
    expect(svc.__wormholeTransferStoreSize()).toBe(svc.MAX_IN_MEMORY_TRANSFERS);
    expect(await svc.getWormholeTransfer(first.transferId, db)).toBeFalsy();
  });
});

describe('credentialed CORS allowlist', () => {
  const { validateOrigin } = require('../shared/middleware/cors-config');

  it.each([
    'https://wrfcoin.replit.app',
    'https://x.replit.app',
    'https://x.repl.co',
    'https://x.replit.dev',
  ])('rejects %s', (origin) => {
    expect(validateOrigin(origin)).toBe(false);
  });

  it('still accepts first-party origins', () => {
    expect(validateOrigin('https://wrfcoin.app')).toBe('https://wrfcoin.app');
    expect(validateOrigin('https://dashboard.wrfcoin.app')).toBe('https://dashboard.wrfcoin.app');
  });
});
