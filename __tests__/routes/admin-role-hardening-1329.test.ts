import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

jest.mock('../../utils/logger.js', () => ({ logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } }));
jest.mock('../../server/utils/logger.js', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, appLogger: logger, securityLogger: logger, blockchainLogger: logger };
});
jest.mock('../../database/connection.js', () => ({ db: {} }));
jest.mock('../../server/services/redis-session-service.js', () => ({ sessionService: {
  validateSession: async () => ({ sessionId: 'test-A15-session' }),
} }));
jest.mock('../../server/utils/create-redis.js', () => ({ createRedisClient: () => {
  const callbacks: Record<string, () => void> = {};
  const client = { on: (event: string, callback: () => void) => { callbacks[event] = callback; return client; },
    connect: async () => { callbacks.connect?.(); callbacks.ready?.(); },
    config: async () => ['maxmemory-policy', 'noeviction'], exists: async () => 0 };
  return client;
} }));
let mockExisting: any;
const mockDbUpdate = jest.fn();
jest.mock('../../server/db.js', () => ({ db: {
  select: () => ({ from: () => ({ where: async () => [mockExisting] }) }),
  update: (...args: any[]) => { mockDbUpdate(...args); return { set: (updates: any) => ({ where: () => ({ returning: async () => [{ ...mockExisting, ...updates }] }) }) }; },
} }));
jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(), extractCore4Data: (p: any) => p, toNullable: (v: any) => v ?? null,
  sendCore4Error: jest.fn(), sendCore4Unavailable: jest.fn(),
}));
const SECRET = 'test-only-A15-exact-admin-secret-000000000000';
const ADDRESS = `0x${'a'.repeat(40)}`;
const OTHER = `0x${'b'.repeat(40)}`;
const saved = { JWT_SECRET: process.env.JWT_SECRET, JWT_PUBLIC_KEY_PATH: process.env.JWT_PUBLIC_KEY_PATH };
process.env.JWT_SECRET = SECRET; delete process.env.JWT_PUBLIC_KEY_PATH;
const { authenticateJWT, requireRole, requirePermission } = require('../../server/middleware/auth');
const { createRateLimiter } = require('../../shared/middleware/communication-middleware');
const { resolveSyncActor } = require('../../server/services/state-sync-orchestration');
const { simulateGovernanceAction, simulateRewardDistribution } = require('../../server/controllers/simulationController');
const governance = require('../../server/routes/governance-routes').default;
function token(roles: any, extra: any = {}) {
  return jwt.sign({ sub: ADDRESS, address: ADDRESS, id: 'test-A15-user', userId: 'test-A15-user',
    sessionId: 'test-A15-session', type: 'access', roles, permissions: [], ...extra }, SECRET,
    { algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m' });
}
function app() {
  const a = express(); a.use(express.json());
  a.get('/role/admin', authenticateJWT, requireRole(['admin']), (_q, s) => s.json({ ok: true }));
  a.get('/role/validator', authenticateJWT, requireRole(['validator']), (_q, s) => s.json({ ok: true }));
  a.get('/permission', authenticateJWT, requirePermission('private:read'), (_q, s) => s.json({ ok: true }));
  a.get('/limited', authenticateJWT, createRateLimiter({ max: 1, windowMs: 60000 }), (_q, s) => s.json({ ok: true }));
  a.post('/simulate/governance', authenticateJWT, simulateGovernanceAction);
  a.post('/simulate/reward', authenticateJWT, simulateRewardDistribution);
  a.use('/governance', governance); return a;
}
beforeEach(() => {
  mockDbUpdate.mockClear(); mockExisting = { id: 1, proposer: OTHER, status: 'DEPOSIT', totalYes: '10', votingEndTime: new Date(0) };
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const malformed = ['notadmin', 'admin', { admin: true }, null, undefined, [], ['notadmin'], ['ADMIN']];
it.each(malformed)('never grants canonical admin overrides for roles=%j', async roles => {
  const a = app();
  for (const endpoint of ['/role/admin', '/role/validator', '/permission']) {
    expect((await request(a).get(endpoint).set('authorization', `Bearer ${token(roles)}`)).status).toBe(403);
  }
});
it('preserves exact array admins, ordinary roles and explicit permissions', async () => {
  const a = app();
  for (const endpoint of ['/role/admin', '/role/validator', '/permission']) {
    expect((await request(a).get(endpoint).set('authorization', `Bearer ${token(['admin'])}`)).status).toBe(200);
  }
  expect((await request(a).get('/role/validator').set('authorization', `Bearer ${token(['validator'])}`)).status).toBe(200);
  expect((await request(a).get('/permission').set('authorization', `Bearer ${token(['user'], { permissions: ['private:read'] })}`)).status).toBe(200);
});
it.each(['notadmin', 'admin', { admin: true }, null, ['user']])('does not exempt roles=%j from the real rate limiter', async roles => {
  const a = app();
  expect((await request(a).get('/limited').set('authorization', `Bearer ${token(roles)}`)).status).toBe(200);
  expect((await request(a).get('/limited').set('authorization', `Bearer ${token(roles)}`)).status).toBe(429);
});
it('retains the exact array admin rate-limit exemption', async () => {
  const a = app();
  for (let i = 0; i < 2; i++) expect((await request(a).get('/limited').set('authorization', `Bearer ${token(['admin'])}`)).status).toBe(200);
});
it.each(['notadmin', 'admin', { admin: true }, null, ['ADMIN'], ['administer']])('state sync does not infer admin from roles=%j or scalar role', roles => {
  const actor = resolveSyncActor({ authorization: `Bearer ${token(roles, { role: 'admin' })}` });
  expect(actor.role).toBe('observer'); expect(actor.permissions.has('sync:operate')).toBe(false);
});
it('state sync keeps array admins and its existing wallet/operator contract', () => {
  expect(resolveSyncActor({ authorization: `Bearer ${token(['admin'])}` }).role).toBe('admin');
  expect(resolveSyncActor({ authorization: `Bearer ${token(undefined, { role: 'wallet' })}` }).role).toBe('operator');
  expect(resolveSyncActor({ authorization: `Bearer ${token(['operator'])}` }).role).toBe('operator');
});
it.each(['notadmin', [1, null, { admin: true }]])('state sync safely treats malformed roles=%j as an observer', roles => {
  const actor = resolveSyncActor({ authorization: `Bearer ${token(roles)}` });
  expect(actor.role).toBe('observer'); expect(actor.permissions.has('sync:operate')).toBe(false);
});
const simulations = [
  ['/simulate/governance', 'execute', { proposalId: 'proposal' }],
  ['/simulate/governance', 'cancel', { proposalId: 'proposal' }],
  ['/simulate/reward', 'setRate', { rewardType: 'weather_data', amount: 2 }],
] as const;
it.each(simulations)('simulation %s %s refuses malformed/absent/non-admin roles', async (endpoint, operation, params) => {
  const a = app();
  for (const roles of malformed) {
    const res = await request(a).post(endpoint).set('authorization', `Bearer ${token(roles)}`).send({ operation, params, callerAddress: ADDRESS });
    expect(res.status).toBe(200); expect(res.body.data.wouldSucceed).toBe(false);
    expect(res.body.data.errorCodes).toContain('SIM_MISSING_ROLE');
  }
  const admin = await request(a).post(endpoint).set('authorization', `Bearer ${token(['admin'])}`).send({ operation, params, callerAddress: ADDRESS });
  expect(admin.status).toBe(200); expect(admin.body.data.wouldSucceed).toBe(true);
});
const ordinarySimulations = [
  ['/simulate/governance', 'createProposal', { title: 'test', description: 'test proposal' }, 'user'],
  ['/simulate/reward', 'distribute', { recipientAddress: OTHER, amount: 2 }, 'operator'],
] as const;
it.each(ordinarySimulations)('simulation %s %s requires an allowed array role', async (endpoint, operation, params, ordinaryRole) => {
  const a = app();
  for (const roles of malformed) {
    const res = await request(a).post(endpoint).set('authorization', `Bearer ${token(roles)}`).send({ operation, params, callerAddress: ADDRESS });
    expect(res.status).toBe(200); expect(res.body.data.wouldSucceed).toBe(false);
    expect(res.body.data.errorCodes).toContain('SIM_MISSING_ROLE');
  }
  for (const roles of [['admin'], [ordinaryRole]]) {
    const res = await request(a).post(endpoint).set('authorization', `Bearer ${token(roles)}`).send({ operation, params, callerAddress: ADDRESS });
    expect(res.status).toBe(200); expect(res.body.data.wouldSucceed).toBe(true);
  }
});
const lifecycle = [
  ['activate', 'DEPOSIT'], ['finalize', 'VOTING'], ['execute', 'PASSED'], ['', 'DEPOSIT'],
] as const;
it.each(lifecycle)('governance lifecycle %s requires a creator or exact roles-array admin', async (action, status) => {
  const a = app(); const endpoint = `/governance/proposals/1${action ? `/${action}` : ''}`;
  mockExisting.status = status;
  const body = action ? {} : { title: 'changed' };
  // Two ordinary/malformed identities with a scalar admin field are not admins.
  for (const roles of ['notadmin', undefined]) {
    const res = await request(a).post(endpoint).set('authorization', `Bearer ${token(roles, { role: 'admin' })}`).send(body);
    expect(res.status).toBe(403); expect(mockDbUpdate).not.toHaveBeenCalled();
  }
  const admin = await request(a).post(endpoint).set('authorization', `Bearer ${token(['admin'])}`).send(body);
  expect(admin.status).toBe(action === 'execute' ? 503 : 200);
  if (action === 'execute') expect(admin.body.code).toBe('CANONICAL_EXECUTION_UNAVAILABLE');
  expect(mockDbUpdate).toHaveBeenCalledTimes(action === 'execute' ? 0 : 1);
});
it.each(lifecycle)('preserves creator authorization for %s without admin membership', async (action, status) => {
  const a = app(); mockExisting.proposer = ADDRESS; mockExisting.status = status;
  const endpoint = `/governance/proposals/1${action ? `/${action}` : ''}`;
  const res = await request(a).post(endpoint).set('authorization', `Bearer ${token(['user'])}`).send(action ? {} : { title: 'creator edit' });
  expect(res.status).toBe(action === 'execute' ? 503 : 200);
  if (action === 'execute') expect(res.body.code).toBe('CANONICAL_EXECUTION_UNAVAILABLE');
  expect(mockDbUpdate).toHaveBeenCalledTimes(action === 'execute' ? 0 : 1);
});
it('retains authentication before canonical role and governance dispatch', async () => {
  const a = app();
  expect((await request(a).get('/role/admin').set('authorization', 'Bearer forged')).status).toBeGreaterThanOrEqual(400);
  expect((await request(a).post('/governance/proposals/1/activate').set('authorization', 'Bearer forged').send({})).status).toBe(401);
  expect(mockDbUpdate).not.toHaveBeenCalled();
});
