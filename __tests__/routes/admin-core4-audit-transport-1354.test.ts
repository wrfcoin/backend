import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

jest.mock('../../server/utils/logger.js', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), metrics: { recordHttpRequest: jest.fn() } };
  return { logger, appLogger: logger, securityLogger: logger, blockchainLogger: logger, createLogger: () => logger };
});
jest.mock('../../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../middleware/rateLimiting', () => ({ generalLimiter: (_q: any, _s: any, n: any) => n(), transferLimiter: (_q: any, _s: any, n: any) => n() }));
jest.mock('../../server/db.js', () => ({ db: {} }));
jest.mock('../../database/connection.js', () => ({ db: {} }));
jest.mock('../../server/services/redis-session-service.js', () => ({ sessionService: {
  validateSession: jest.fn(async () => ({ sessionId: 'test-session' })),
  // requireAdmin's read-only Redis session lookup (#1344): the token's own admin session
  getSessionRedisOnly: jest.fn(async () => ({ userId: 'test-user', roles: ['admin'], sessionId: 'test-session' })),
} }));
jest.mock('../../server/utils/create-redis.js', () => ({ createRedisClient: () => {
  const handlers: Record<string, () => void> = {};
  const client = { on: (event: string, handler: () => void) => { handlers[event] = handler; return client; },
    connect: async () => { handlers.connect?.(); handlers.ready?.(); }, config: async () => ['maxmemory-policy', 'noeviction'], exists: async () => 0 };
  return client;
} }));
const mockFetch = jest.fn();
jest.mock('../../shared/core4-route-client.js', () => ({
  ...jest.requireActual('../../shared/core4-route-client.js'),
  fetchCore4Json: (...args: any[]) => mockFetch(...args), extractCore4Data: (p: any) => p,
  forwardCore4Headers: (headers: any, extra: any = {}) => ({ ...headers, ...extra }),
  toNullable: (v: any) => v ?? null,
  sendCore4Error: (res: any, r: any) => res.status(r.status).json(r.payload),
  sendNotImplemented: (res: any) => res.status(501).json({ error: { code: 'NOT_IMPLEMENTED' } }),
}));
const SECRET = 'test-only-A12-admin-signed-jwt-secret-000000000';
const ADDRESS = `0x${'a'.repeat(40)}`;
const configs = {
  WRFCOIN_MINING_REWARD_ADDRESS: ADDRESS,
  WRFCOIN_ADMIN_NFT_MINT_CONFIG: JSON.stringify({ id: 'configured-nft', owner: ADDRESS, metadata: { title: 'configured' }, price: 2 }),
  WRFCOIN_ADMIN_NFT_TRANSFER_CONFIG: JSON.stringify({ id: 'configured-nft', to: ADDRESS }),
  WRFCOIN_ADMIN_STEALTH_CONFIG: JSON.stringify({ spend_key: 'a'.repeat(64), view_key: 'b'.repeat(64), payment_id: 'c'.repeat(16) }),
  WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG: JSON.stringify({ proposal_id: 'configured-proposal', parameter: 'test_parameter', value: '10' }),
  WRFCOIN_GOVERNANCE_PROPOSER_ADDRESS: ADDRESS,
  WRFCOIN_OPERATOR_TOKEN: 'test-only-operator', WRFCOIN_CONTRIBUTOR_TOKEN: 'test-only-contributor',
  WRFCOIN_READER_TOKEN: 'test-only-reader',
  WRFCOIN_GOVERNANCE_SIGNING_VERSION: '2', WRFCOIN_GOVERNANCE_CHAIN_ID: '777', WRFCOIN_GOVERNANCE_NETWORK_ID: 'testnet', JWT_SECRET: SECRET,
};
const saved = Object.fromEntries(Object.keys(configs).map(key => [key, process.env[key]]));
Object.assign(process.env, configs);
const routers = {
  mining: require('../../server/routes/mining-routes'), nft: require('../../server/routes/nft-routes'),
  governance: require('../../server/routes/governance-routes').default,
  privacy: require('../../server/routes/privacyRoutes').default,
};
function app() {
  const a = express(); a.use(express.json());
  for (const [name, router] of Object.entries(routers)) a.use(`/api/${name}`, router);
  return a;
}
function token(claims: any = { roles: ['admin'] }, secret = SECRET, options: any = {}) {
  return jwt.sign({ sub: ADDRESS, id: 'untrusted-id', address: 'untrusted-address', type: 'access', userId: 'test-user', sessionId: 'test-session', ...claims }, secret,
    { issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m', ...options });
}
function caller(path: string, claims?: any) {
  return request(app()).post(path).set('authorization', `Bearer ${token(claims)}`)
    .set('x-api-key', 'caller-private-key').set('cookie', 'caller-private-cookie')
    .set('x-proposer-address', 'caller-proposer').set('x-voter-address', 'caller-voter')
    .set('x-request-id', 'a12-request').set('x-correlation-id', 'a12-correlation');
}
const trace = { 'x-request-id': 'a12-request', 'x-correlation-id': 'a12-correlation' };
const adminWrites = [
  ['/api/mining/start', '/blocks/mine', 'WRFCOIN_MINING_REWARD_ADDRESS', { miner_address: ADDRESS }],
  ['/api/mining/setup/start', '/blocks/mine', 'WRFCOIN_MINING_REWARD_ADDRESS', { miner_address: ADDRESS }],
  ['/api/nft', '/nft/mint', 'WRFCOIN_ADMIN_NFT_MINT_CONFIG', JSON.parse(configs.WRFCOIN_ADMIN_NFT_MINT_CONFIG)],
  ['/api/nft/configured-nft/transfer', '/nft/configured-nft/transfer', 'WRFCOIN_ADMIN_NFT_TRANSFER_CONFIG', { to: ADDRESS }],
  ['/api/privacy/stealth-address', '/privacy/stealth-address/create', 'WRFCOIN_ADMIN_STEALTH_CONFIG', JSON.parse(configs.WRFCOIN_ADMIN_STEALTH_CONFIG)],
  ['/api/governance/proposals', '/governance/proposals/submit', 'WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG', JSON.parse(configs.WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG)],
] as const;

/**
 * backend#1354: every admin Operator write records `attempt` and then exactly ONE terminal
 * record. A transport exception (timeout, reset, unavailable upstream) used to leave only the
 * `attempt`. Harness copied from admin-core4-write-policy-1321.test.ts (same mounted routers,
 * same core4 seam). Exception text, tokens, keys and metadata must never reach the log.
 */
const auditCalls = () => (require('../../server/utils/logger.js').securityLogger.info as jest.Mock).mock.calls
  .filter((c: any[]) => c[0] === 'admin_core4_write').map((c: any[]) => c[1]);
const capturedLogs = () => [
  require('../../server/utils/logger.js').logger,
  require('../../utils/logger.js').logger,
].flatMap(logger => ['info', 'warn', 'error', 'debug'].flatMap(level => logger[level].mock.calls));
beforeEach(() => {
  Object.assign(process.env, configs);
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, payload: { id: 'actual', one_time_address: 'actual-address' } });
  for (const logger of [require('../../server/utils/logger.js').logger, require('../../utils/logger.js').logger]) {
    for (const level of ['info', 'warn', 'error', 'debug']) logger[level].mockClear();
  }
});
afterAll(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });

describe('admin core4 write audit has a terminal record on every path (#1354)', () => {
  it.each(adminWrites)('%s: transport exception -> attempt then error, safe classification, no exception text', async (path) => {
    mockFetch.mockRejectedValueOnce(Object.assign(new Error('transport-secret-http://internal:8556/?tok=abc 44.98765,-93.26543'), { code: 'ECONNRESET' }));
    const res = await caller(path).send({});
    expect(res.status).toBe(503);
    const audit = auditCalls();
    expect(audit.map((a: any) => a.outcome)).toEqual(['attempt', 'error']);
    expect(audit[1]).toMatchObject({ errorClass: 'connection_reset', indeterminate: true });
    expect(audit[1].action).toBe(audit[0].action);
    expect(audit[1].actor).toBe(audit[0].actor);
    const text = JSON.stringify(audit);
    expect(text).not.toContain('transport-secret');
    expect(text).not.toContain('tok=abc');
    expect(text).not.toContain('44.98765');
    expect(res.body).toMatchObject({ success: false, error: { code: 'CORE4_UNAVAILABLE' } });
    expect(res.body.error).not.toHaveProperty('details');
    const exposed = JSON.stringify({ response: res.body, logs: capturedLogs() }, (_key, value) =>
      value instanceof Error ? { message: value.message, stack: value.stack, ...value } : value);
    for (const privateFragment of ['transport-secret', 'internal:8556', 'tok=abc', '44.98765', '-93.26543']) {
      expect(exposed).not.toContain(privateFragment);
    }
  });

  it.each(adminWrites)('%s: classifications are closed (timeout / unreachable / other)', async (path) => {
    for (const [error, expected] of [
      [Object.assign(new Error('x'), { name: 'TimeoutError' }), { errorClass: 'timeout', indeterminate: true }],
      [Object.assign(new Error('x'), { code: 'ECONNREFUSED' }), { errorClass: 'unreachable', indeterminate: false }],
      [new Error('anything else'), { errorClass: 'transport', indeterminate: true }],
    ] as const) {
      (require('../../server/utils/logger.js').securityLogger.info as jest.Mock).mockClear();
      mockFetch.mockRejectedValueOnce(error);
      await caller(path).send({});
      expect(auditCalls().map((a: any) => a.outcome)).toEqual(['attempt', 'error']);
      expect(auditCalls()[1]).toMatchObject(expected);
    }
  });

  it.each(adminWrites)('%s: normal answers keep their single terminal record (ok / refused with status)', async (path) => {
    await caller(path).send({});
    expect(auditCalls().map((a: any) => a.outcome)).toEqual(['attempt', 'ok']);
    (require('../../server/utils/logger.js').securityLogger.info as jest.Mock).mockClear();
    mockFetch.mockResolvedValueOnce({ ok: false, status: 422, payload: { error: 'no' } });
    await caller(path).send({});
    const audit = auditCalls();
    expect(audit.map((a: any) => a.outcome)).toEqual(['attempt', 'refused']);
    expect(audit[1].status).toBe(422);
  });

  it.each(adminWrites)('%s: a refusal before the write (missing Operator credential) records no attempt and no error', async (path) => {
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    const res = await caller(path).send({});
    expect(res.status).toBe(503);
    expect(auditCalls()).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('core4 transport errors use a generic production response (#1370)', () => {
  it.each(['/api/nft', '/api/nft/configured-nft'])('%s: legacy NFT read logs omit upstream exception text', async path => {
    mockFetch.mockRejectedValueOnce(new Error('transport-secret-http://internal:8556/?tok=abc 44.98765,-93.26543'));
    const res = await request(app()).get(path).set('authorization', `Bearer ${token()}`);
    expect(res.status).toBe(503);
    const logs = require('../../server/utils/logger.js').logger.error.mock.calls;
    expect(logs).toHaveLength(1);
    expect(logs[0][1]).toMatchObject({ code: 'CORE4_UNAVAILABLE' });
    expect(JSON.stringify({ response: res.body, logs })).not.toContain('transport-secret');
    expect(res.body.error).not.toHaveProperty('details');
  });
  it.each([
    new Error('transport-secret-http://internal:8556/?tok=abc 44.98765,-93.26543'),
    'transport-secret-http://internal:8556/?tok=abc 44.98765,-93.26543',
    { message: 'transport-secret', toString: () => 'transport-secret' },
    null,
  ])('does not serialize or inspect a thrown value', error => {
    const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
    require('../../shared/core4-route-client.js').sendCore4Unavailable(res, error);
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json.mock.calls[0][0]).toMatchObject({
      success: false, error: { code: 'CORE4_UNAVAILABLE', message: 'Blockchain node unavailable' },
    });
    expect(res.json.mock.calls[0][0].error).not.toHaveProperty('details');
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('transport-secret');
  });
});
