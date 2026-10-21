/**
 * #936 / #965 — `logger.security.*` is not a real API.
 *
 * `server/utils/logger.js` exports `securityLogger` as a separate named export;
 * the `logger` export is a plain winston logger with no `.security` namespace.
 * Every `logger.security.X(...)` call therefore throws
 * `TypeError: Cannot read properties of undefined (reading 'X')`.
 *
 * This matters most on the auth *failure* path: `rpcAuthMiddleware` calls
 * `logAuthFailure()` when an API key is missing, so an unauthenticated request
 * crashes with a 500 instead of being refused with a 401.
 */
import { describe, expect, it } from '@jest/globals';

const { logAuthSuccess, logAuthFailure, logApiKeyUsage } = require('../server/middleware/authLogging');

function makeReq(headers: Record<string, string> = {}) {
  return {
    method: 'POST',
    originalUrl: '/api/node-os/status',
    headers,
    ip: '127.0.0.1',
    connection: { remoteAddress: '127.0.0.1' },
  } as any;
}

describe('#936 security logging must not throw', () => {
  it('logAuthFailure does not throw — the unauthenticated path must reach its 401', () => {
    expect(() => logAuthFailure(makeReq(), 'Missing API key', null, 'api-key')).not.toThrow();
  });

  it('logAuthSuccess does not throw', () => {
    expect(() => logAuthSuccess(makeReq(), { id: 'operator' }, 'api-key')).not.toThrow();
  });

  it('logApiKeyUsage does not throw', () => {
    expect(() => logApiKeyUsage(makeReq(), 'key-1', true)).not.toThrow();
  });
});
