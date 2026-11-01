import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

jest.mock('../../server/utils/logger.js', () => ({ appLogger: { warn: jest.fn(), info: jest.fn(), error: jest.fn() } }));
const { WalletNonceRateLimitError } = require('../../server/routes/wallet-auth-service');

// The parent module boots every service on import. Execute its actual nonce
// branch with response callbacks instead, preserving its error/status mapping.
const source = fs.readFileSync(path.join(process.cwd(), 'server/enhanced_unified_api_optimized.ts'), 'utf8');
const start = "    } else if (path.startsWith('/api/auth/nonce/') && req.method === 'GET') {";
const end = "    } else if (path === '/api/auth/wallet-login' && req.method === 'POST') {";
if (!source.includes(start) || !source.includes(end)) throw new Error('public nonce branch missing');
const body = source.split(start)[1].split(end)[0];
const execute = new Function('walletAuthService', 'WalletNonceRateLimitError', 'path', 'query', 'res', 'success', 'error',
  ts.transpileModule(`return (async () => { ${body} })();`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);

it('passes ?session_public_key through for a session_key challenge', async () => {
  const service = { generateNonce: jest.fn(async () => ({ nonce: 'n' })) };
  const success = jest.fn();
  await execute(service, WalletNonceRateLimitError, '/api/auth/nonce/0x1234', { scheme: 'session_key', session_public_key: 'ab'.repeat(32) }, { setHeader: jest.fn() }, success, jest.fn());
  expect(service.generateNonce).toHaveBeenCalledWith('0x1234', 'session_key', 'ab'.repeat(32));
  expect(success).toHaveBeenCalled();
});

it('maps a target-address limit to the existing 429 envelope code and Retry-After', async () => {
  const service = { generateNonce: jest.fn(async () => { throw new WalletNonceRateLimitError(37); }) };
  const res = { setHeader: jest.fn() }, success = jest.fn(), error = jest.fn();
  await execute(service, WalletNonceRateLimitError, '/api/auth/nonce/0x1234', { scheme: 'ed25519' }, res, success, error);
  expect(service.generateNonce).toHaveBeenCalledWith('0x1234', 'ed25519', undefined);
  expect(error).toHaveBeenCalledWith(429, expect.any(String), null, 'RATE_LIMIT_EXCEEDED');
  expect(res.setHeader).toHaveBeenCalledWith('Retry-After', '37');
  expect(success).not.toHaveBeenCalled();
});

it('preserves ordinary validation failures as 400', async () => {
  const res = { setHeader: jest.fn() }, error = jest.fn();
  await execute({ generateNonce: async () => { throw new Error('invalid address format'); } }, WalletNonceRateLimitError,
    '/api/auth/nonce/bad', {}, res, jest.fn(), error);
  expect(error).toHaveBeenCalledWith(400, 'invalid address format');
  expect(res.setHeader).not.toHaveBeenCalled();
});
