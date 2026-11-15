/**
 * authenticateToken carries the JWT's wallet_scheme claim onto req.user.walletScheme, so a
 * route can tell a passkey session from a 12-word one (my stations, owner decision 2026-11-10).
 * Test-only secret; made-up address.
 */
jest.mock('../server/utils/logger', () => {
  const l = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() };
  return { logger: l, securityLogger: l, default: l };
});
process.env.JWT_SECRET = 'test-only-secret-for-wallet-scheme-claim-0123456789';
const jwt = require('jsonwebtoken');
const { JWT_ISSUER, JWT_AUDIENCE } = require('../server/auth/jwt-constants');
const { authenticateToken } = require('../server/middleware/auth-middleware');

const ADDRESS = '0x' + 'e'.repeat(40);
function run(claims: Record<string, unknown>) {
  const token = jwt.sign({ sub: ADDRESS, address: ADDRESS, role: 'wallet', type: 'access', ...claims }, process.env.JWT_SECRET, {
    algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 60,
  });
  const req: any = { headers: { authorization: `Bearer ${token}` }, header: (n: string) => (n.toLowerCase() === 'authorization' ? `Bearer ${token}` : undefined), path: '/x', ip: '127.0.0.1' };
  const res: any = { status: jest.fn(() => res), json: jest.fn(() => res) };
  const next = jest.fn();
  return Promise.resolve(authenticateToken(req, res, next)).then(() => ({ req, res, next }));
}

test.each([['passkey'], ['ed25519'], ['session_key']])('wallet_scheme %s reaches req.user', async (scheme) => {
  const { req, next } = await run({ wallet_scheme: scheme });
  expect(next).toHaveBeenCalled();
  expect(req.user.walletScheme).toBe(scheme);
  expect(req.user.address).toBe(ADDRESS);
});

test('no claim (an EVM token): no walletScheme field', async () => {
  const { req, next } = await run({});
  expect(next).toHaveBeenCalled();
  expect('walletScheme' in req.user).toBe(false);
});

test('a non-string claim is ignored', async () => {
  const { req } = await run({ wallet_scheme: { evil: true } });
  expect('walletScheme' in req.user).toBe(false);
});
