import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

jest.mock('../../server/utils/logger.js', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, appLogger: logger, securityLogger: logger, blockchainLogger: logger };
});
jest.mock('../../database/connection.js', () => ({ db: {} }));
let mockSessionValid = true;
let mockRevoked = false;
jest.mock('../../server/services/redis-session-service.js', () => ({ sessionService: {
  validateSession: async () => mockSessionValid ? { sessionId: 'test-rsa-session' } : null,
} }));
jest.mock('../../server/utils/create-redis.js', () => ({ createRedisClient: () => {
  const callbacks: Record<string, () => void> = {};
  const client = { on: (event: string, callback: () => void) => { callbacks[event] = callback; return client; },
    connect: async () => { callbacks.connect?.(); callbacks.ready?.(); },
    config: async () => ['maxmemory-policy', 'noeviction'], exists: async () => mockRevoked ? 1 : 0 };
  return client;
} }));
const mockFetch = jest.fn();
jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: (...args: any[]) => mockFetch(...args), extractCore4Data: (p: any) => p,
  forwardCore4Headers: (h: any) => h,
  sendCore4Error: (res: any, result: any) => res.status(result.status).json(result.payload),
  sendCore4Unavailable: (res: any) => res.status(503).json({ error: 'upstream unavailable' }),
}));
const keys = ['JWT_SECRET', 'JWT_PUBLIC_KEY_PATH', 'WRFCOIN_OPERATOR_TOKEN', 'WRFCOIN_ADMIN_STEALTH_CONFIG'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
// Only a synthetic public key is written; the synthetic private key stays in memory.
const directory = mkdtempSync(path.join(tmpdir(), 'wrfcoin-A12-rs256-'));
const publicPath = path.join(directory, 'test-public.pem');
const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
writeFileSync(publicPath, rsa.publicKey.export({ type: 'spki', format: 'pem' }));
const SECRET = 'test-only-RS256-privacy-admin-secret-000000000000';
function token(roles: any = ['admin'], options: any = {}, algorithm: 'RS256' | 'HS256' = 'RS256') {
  return jwt.sign({ userId: 'test-admin', roles, sessionId: 'test-rsa-session', jti: 'test-rsa-session', type: 'access' },
    algorithm === 'RS256' ? rsa.privateKey : SECRET,
    { algorithm, issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m', ...options });
}
function call(app: express.Express, bearer: string) {
  return request(app).post('/api/privacy/stealth-address').set('authorization', `Bearer ${bearer}`)
    .set('x-api-key', 'caller-key').set('cookie', 'caller-cookie').set('x-request-id', 'rsa-request').send({});
}
let app: express.Express;
beforeEach(async () => {
  jest.resetModules(); mockFetch.mockReset(); mockSessionValid = true; mockRevoked = false;
  process.env.JWT_SECRET = SECRET; process.env.JWT_PUBLIC_KEY_PATH = publicPath;
  process.env.WRFCOIN_OPERATOR_TOKEN = 'test-only-rsa-operator';
  process.env.WRFCOIN_ADMIN_STEALTH_CONFIG = JSON.stringify({ spend_key: 'a'.repeat(64), view_key: 'b'.repeat(64) });
  mockFetch.mockResolvedValue({ ok: true, status: 200, payload: { one_time_address: 'real-fixture' } });
  app = express(); app.use(express.json()); app.use('/api/privacy', require('../../server/routes/privacyRoutes').default);
  await Promise.resolve();
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  unlinkSync(publicPath); rmdirSync(directory);
});
it('uses the already verified RS256 admin identity and only server Operator headers', async () => {
  expect((await call(app, token())).status).toBe(200);
  expect(mockFetch).toHaveBeenCalledWith('/privacy/stealth-address/create', { method: 'POST',
    headers: { authorization: 'Bearer test-only-rsa-operator', 'x-request-id': 'rsa-request' },
    body: { spend_key: 'a'.repeat(64), view_key: 'b'.repeat(64) } });
});
it('rejects non-admin and malformed signed RS256 roles before core4', async () => {
  for (const roles of [undefined, ['user'], ['notadmin'], 'admin', 'notadmin', { admin: true }]) {
    // null avoids the token helper default for the absent-role case.
    expect((await call(app, token(roles ?? null))).status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  }
});
it('does not admit HS256 under the configured RS256 verifier', async () => {
  expect((await call(app, token(['admin'], {}, 'HS256'))).status).toBe(403);
  expect(mockFetch).not.toHaveBeenCalled();
});
it('preserves issuer, audience and expiry checks', async () => {
  for (const options of [{ issuer: 'foreign' }, { audience: 'foreign' }, { expiresIn: '-2m' }]) {
    expect((await call(app, token(['admin'], options))).status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  }
});
it('preserves the existing session and revocation refusals', async () => {
  mockSessionValid = false;
  expect((await call(app, token())).status).toBe(401); expect(mockFetch).not.toHaveBeenCalled();
  mockSessionValid = true; mockRevoked = true;
  expect((await call(app, token())).status).toBe(401); expect(mockFetch).not.toHaveBeenCalled();
});
