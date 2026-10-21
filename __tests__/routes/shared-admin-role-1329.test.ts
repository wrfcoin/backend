import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { existsSync } from 'node:fs';
import path from 'node:path';

const mockAdminRole = jest.fn();
jest.mock('../../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
jest.mock('../../server/utils/logger.js', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, appLogger: logger, securityLogger: logger, blockchainLogger: logger };
});
jest.mock('../../database/connection.js', () => ({ db: {} }));
jest.mock('../../server/services/redis-session-service.js', () => ({ sessionService: {
  validateSession: async () => ({ sessionId: 'test-shared-admin-session' }),
} }));
jest.mock('../../server/utils/create-redis.js', () => ({ createRedisClient: () => {
  const callbacks: Record<string, () => void> = {};
  const client = { on: (event: string, callback: () => void) => { callbacks[event] = callback; return client; },
    connect: async () => { callbacks.connect?.(); callbacks.ready?.(); },
    config: async () => ['maxmemory-policy', 'noeviction'], exists: async () => 0 };
  return client;
} }));
const mockFetch = jest.fn();
jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: (...args: any[]) => mockFetch(...args), extractCore4Data: (p: any) => p,
  sendCore4Error: (res: any, result: any) => res.status(result.status).json(result.payload),
  sendCore4Unavailable: (res: any) => res.status(503).json({ error: 'upstream unavailable' }),
}));
const SECRET = 'test-only-A14-shared-admin-secret-000000000000';
const keys = ['JWT_SECRET', 'JWT_PUBLIC_KEY_PATH', 'WRFCOIN_OPERATOR_TOKEN', 'WRFCOIN_ADMIN_STEALTH_CONFIG'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
let app: express.Express;
function token() {
  return jwt.sign({ sub: 'test-admin', userId: 'test-admin', roles: ['admin'], type: 'access', sessionId: 'test-shared-admin-session' }, SECRET,
    { algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m' });
}
beforeEach(async () => {
  jest.resetModules(); mockAdminRole.mockReset().mockReturnValue(false); mockFetch.mockReset();
  const predicateFile = path.resolve(__dirname, '../../server/utils/admin-role.js');
  if (existsSync(predicateFile)) {
    const factory = () => ({ hasAdminRole: (...args: any[]) => mockAdminRole(...args) });
    // Cover the CommonJS require and the TS .js import through Jest's mapper.
    jest.doMock('../../server/utils/admin-role', factory);
    jest.doMock('../../server/utils/admin-role.js', factory);
  }
  process.env.JWT_SECRET = SECRET; delete process.env.JWT_PUBLIC_KEY_PATH;
  process.env.WRFCOIN_OPERATOR_TOKEN = 'test-only-A14-operator';
  process.env.WRFCOIN_ADMIN_STEALTH_CONFIG = JSON.stringify({ spend_key: 'a'.repeat(64), view_key: 'b'.repeat(64) });
  mockFetch.mockResolvedValue({ ok: true, status: 200, payload: { one_time_address: 'test-fixture' } });
  app = express(); app.use(express.json());
  app.post('/admin-probe', require('../../server/middleware/authMiddleware').requireAdmin, (_req, res) => res.json({ success: true }));
  app.use('/api/privacy', require('../../server/routes/privacyRoutes').default);
  await Promise.resolve();
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
it.each(['/admin-probe', '/api/privacy/stealth-address'])('delegates %s to the same predicate on verified JWT claims', async endpoint => {
  const res = await request(app).post(endpoint).set('authorization', `Bearer ${token()}`).send({});
  expect(res.status).toBe(403);
  expect(mockAdminRole).toHaveBeenCalledTimes(1);
  expect(mockAdminRole).toHaveBeenCalledWith(expect.objectContaining({ roles: ['admin'], userId: 'test-admin' }));
  expect(mockFetch).not.toHaveBeenCalled();
});
it.each(['/admin-probe', '/api/privacy/stealth-address'])('never checks %s admin membership before authentication', async endpoint => {
  const res = await request(app).post(endpoint).set('authorization', 'Bearer forged-token').send({});
  expect(res.status).toBeGreaterThanOrEqual(400);
  expect(mockAdminRole).not.toHaveBeenCalled(); expect(mockFetch).not.toHaveBeenCalled();
});
it('defines exact roles-array membership in the actual shared predicate', () => {
  const filename = path.resolve(__dirname, '../../server/utils/admin-role.js');
  expect(existsSync(filename)).toBe(true); // Main fails here, rather than on module setup.
  const { hasAdminRole } = jest.requireActual(filename);
  for (const identity of [undefined, null, {}, { role: 'admin' }, { roles: 'admin' }, { roles: 'notadmin' },
    { roles: { admin: true } }, { roles: [] }, { roles: ['notadmin'] }, { roles: ['Admin'] }, { roles: [null, 1] }]) {
    expect(hasAdminRole(identity)).toBe(false);
  }
  expect(hasAdminRole({ roles: ['admin'] })).toBe(true);
  expect(hasAdminRole({ roles: ['user', 'admin'] })).toBe(true);
});
