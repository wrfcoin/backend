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
  // requireAdmin's read-only Redis session lookup (#1329): the token's own admin session
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
  fetchCore4Json: (...args: any[]) => mockFetch(...args), extractCore4Data: (p: any) => p,
  forwardCore4Headers: (headers: any, extra: any = {}) => ({ ...headers, ...extra }),
  toNullable: (v: any) => v ?? null,
  sendCore4Error: (res: any, r: any) => res.status(r.status).json(r.payload),
  sendCore4Unavailable: (res: any) => res.status(503).json({ error: { code: 'CORE4_UNAVAILABLE' } }),
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
beforeEach(() => { Object.assign(process.env, configs); mockFetch.mockReset(); mockFetch.mockResolvedValue({ ok: true, status: 200, payload: { id: 'actual', one_time_address: 'actual-address' } }); });
afterAll(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
describe('mounted admin Operator writes (#1321 owner ruling)', () => {
  it.each(adminWrites)('requires a signed exact admin role on %s', async (path) => {
    for (const claims of [{ role: 'wallet', roles: ['user'] }, { role: 'admin' }, { roles: 'admin' }, { roles: 'notadmin' }, { roles: ['notadmin'] }, { roles: { admin: true } }]) {
      expect((await caller(path, claims).send({})).status).toBe(403);
      expect(mockFetch).not.toHaveBeenCalled();
    }
  });
  it.each(adminWrites)('rejects missing or forged authentication on %s', async (path) => {
    expect((await request(app()).post(path).send({})).status).toBe(401);
    expect((await request(app()).post(path).set('authorization', `Bearer ${token(undefined, 'wrong-test-key-0000000000000000000')}`).send({})).status).toBeGreaterThanOrEqual(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each(adminWrites)('uses configured parameters and only Operator + tracing on %s', async (path, upstream, _env, body) => {
    const res = await caller(path).send({});
    expect(res.status).toBeLessThan(300); expect(res.status).toBeGreaterThanOrEqual(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(upstream, { method: 'POST', headers: {
      authorization: 'Bearer test-only-operator', ...trace,
      ...(path.includes('governance') ? { 'x-proposer-address': ADDRESS } : {}),
    }, body });
  });
  it.each(adminWrites)('refuses request parameter overrides on %s', async (path) => {
    expect((await caller(path).send({ miner_address: 'evil', owner: 'evil', to: 'evil', spend_key: 'evil', proposal_id: 'evil' })).status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each(adminWrites)('fails closed before %s without Operator or valid configuration', async (path, _upstream, env) => {
    for (const value of [undefined, '   ']) {
      if (value === undefined) delete process.env.WRFCOIN_OPERATOR_TOKEN; else process.env.WRFCOIN_OPERATOR_TOKEN = value;
      expect((await caller(path).send({})).status).toBe(503); expect(mockFetch).not.toHaveBeenCalled();
    }
    process.env.WRFCOIN_OPERATOR_TOKEN = configs.WRFCOIN_OPERATOR_TOKEN;
    delete process.env[env];
    expect((await caller(path).send({})).status).toBe(503); expect(mockFetch).not.toHaveBeenCalled();
    process.env[env] = '{secret-looking-invalid-config';
    const bad = await caller(path).send({});
    expect(bad.status).toBe(503); expect(JSON.stringify(bad.body)).not.toContain('secret-looking'); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('does not let an admin select an unconfigured NFT by URL', async () => {
    expect((await caller('/api/nft/other-nft/transfer').send({})).status).toBe(400); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('requires configured proposer attribution without JWT/id/header fallbacks', async () => {
    delete process.env.WRFCOIN_GOVERNANCE_PROPOSER_ADDRESS;
    expect((await caller('/api/governance/proposals').send({})).status).toBe(503); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('preserves real upstream write refusals', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, payload: { error: 'mutation disabled' } });
    expect((await caller('/api/nft').send({})).status).toBe(403);
  });
  it.each([{ issuer: 'foreign' }, { audience: 'foreign' }, { expiresIn: '-2m' }])('rejects an admin JWT with invalid registered claims %j', async options => {
    const res = await request(app()).post('/api/mining/start').set('authorization', `Bearer ${token(undefined, SECRET, options)}`).send({});
    expect(res.status).toBe(401); expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each([
    ['WRFCOIN_ADMIN_NFT_MINT_CONFIG', '/api/nft', { id: 'x', owner: ADDRESS, price: -1 }],
    ['WRFCOIN_ADMIN_NFT_MINT_CONFIG', '/api/nft', { id: 'x', owner: 'foreign' }],
    ['WRFCOIN_ADMIN_NFT_TRANSFER_CONFIG', '/api/nft/configured-nft/transfer', { id: 'configured-nft', to: 'foreign' }],
    ['WRFCOIN_ADMIN_STEALTH_CONFIG', '/api/privacy/stealth-address', { spend_key: 'a'.repeat(64), view_key: 'b'.repeat(64), payment_id: 'bad' }],
    ['WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG', '/api/governance/proposals', { proposal_id: 'x', parameter: 'test', value: '10', deposit: Number.MAX_SAFE_INTEGER + 1 }],
    ['WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG', '/api/governance/proposals', { proposal_id: 'x', parameter: 'test', value: '10', extra: 'unsupported' }],
  ])('rejects malformed configured payload %s', async (env, route, payload) => {
    process.env[String(env)] = JSON.stringify(payload);
    expect((await caller(String(route)).send({})).status).toBe(503); expect(mockFetch).not.toHaveBeenCalled();
  });
});

// Independent encoding of core4 DomainSeparated GovernanceVotePayload V2:
// domain_impls.rs:444; chain_binding.rs:913. Never sign JSON or a backend-only intent.
function frame(value: string | Buffer) { const b = Buffer.from(value); const size = Buffer.alloc(8); size.writeBigUInt64LE(BigInt(b.length)); return Buffer.concat([size, b]); }
const privateKey = crypto.createPrivateKey({ key: Buffer.from(`302e020100300506032b657004220420${'12'.repeat(32)}`, 'hex'), type: 'pkcs8', format: 'der' });
const publicKey = (crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'der' }) as Buffer).subarray(-32).toString('hex');
const voter = `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKey, 'hex')).digest('hex').slice(0, 40)}`;
function vote(proposal = 'proposal-1', approve = true, chain = '777', network = 'testnet') {
  const body = Buffer.concat([frame(proposal), Buffer.from([approve ? 1 : 0, 0, 1]), frame(publicKey)]);
  const version = Buffer.from([2, 0, 0, 0]);
  const preimage = Buffer.concat([frame('wrfcoin.governance_vote.v1'), frame(chain), frame(network), version, frame(body)]);
  return { support: approve, signer_public_key: publicKey, signature: crypto.sign(null, preimage, privateKey).toString('hex') };
}
const wallet = { sub: voter, role: 'wallet', wallet_scheme: 'ed25519', roles: ['user'] };
const OTHER = `0x${'b'.repeat(40)}`;
// each call gets its own limiter key so the 10/15min governance write limiter does not interfere
let uid = 0;
const callerU = (path: string, claims: any = { roles: ['admin'] }) => caller(path, { ...claims, id: `admin-u${uid++}` });
describe('admin-supplied validated bodies + audit log (#1329 item 2)', () => {
  const audits = () => (require('../../server/utils/logger.js').securityLogger.info as jest.Mock).mock.calls.filter(c => c[0] === 'admin_core4_write');
  beforeEach(() => (require('../../server/utils/logger.js').securityLogger.info as jest.Mock).mockClear());
  it('mints the admin-supplied NFT, not the configured one', async () => {
    const body = { id: 'custom-nft', owner: OTHER, metadata: { title: 'x' }, price: 5 };
    expect((await callerU('/api/nft').send(body)).status).toBe(201);
    expect(mockFetch).toHaveBeenCalledWith('/nft/mint', expect.objectContaining({ body }));
  });
  it('transfers the URL NFT to the admin-supplied recipient (no configured-id lock when a body is given)', async () => {
    expect((await callerU('/api/nft/other-nft/transfer').send({ to: OTHER })).status).toBeLessThan(300);
    expect(mockFetch).toHaveBeenCalledWith('/nft/other-nft/transfer', expect.objectContaining({ body: { to: OTHER } }));
  });
  it('files the admin-supplied proposal; the proposer stays the configured address', async () => {
    const body = { proposal_id: 'p-2', parameter: 'test_parameter', value: '11', deposit: 3 };
    expect((await callerU('/api/governance/proposals').send(body)).status).toBeLessThan(300);
    expect(mockFetch).toHaveBeenCalledWith('/governance/proposals/submit', expect.objectContaining({ body, headers: expect.objectContaining({ 'x-proposer-address': ADDRESS }) }));
  });
  it.each([
    ['/api/nft', { id: 'x', owner: 'not-an-address' }],
    ['/api/nft', { id: 'x', owner: OTHER, extra: 1 }],
    ['/api/nft', { id: 'x', owner: OTHER, price: -1 }],
    ['/api/nft', { id: 'x', owner: OTHER, metadata: { blob: 'a'.repeat(9000) } }],
    ['/api/nft/x/transfer', { to: OTHER, id: 'y' }],
    ['/api/nft/x/transfer', { to: 'evil' }],
    ['/api/governance/proposals', { proposal_id: 'p', parameter: 'q', value: 'v', proposer: OTHER }],
    ['/api/governance/proposals', { proposal_id: 'bad id!', parameter: 'q', value: 'v' }],
  ])('rejects a malformed/over-broad body on %s %j before any upstream call', async (path, body) => {
    const res = await callerU(path).send(body);
    expect(res.status).toBe(400); expect(res.body.error.code).toBe('ADMIN_BODY_INVALID'); expect(mockFetch).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('aaaaaaaa');
  });
  it('still refuses any body on the config-fixed routes (mining reward, stealth keys)', async () => {
    for (const path of ['/api/mining/start', '/api/privacy/stealth-address']) {
      expect((await callerU(path).send({ miner_address: OTHER, spend_key: 'a'.repeat(64) })).status).toBe(400);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('refuses a non-admin with a valid body', async () => {
    expect((await callerU('/api/nft', { roles: ['user'] }).send({ id: 'x', owner: OTHER })).status).toBe(403); expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each(adminWrites)('audit-logs attempt and result for %s without secrets', async (path) => {
    await callerU(path).send({});
    const calls = audits();
    expect(calls.map(c => c[1].outcome)).toEqual(['attempt', 'ok']);
    expect(calls[0][1]).toMatchObject({ actor: 'test-user', sessionId: 'test-session', source: 'config' });
    const text = JSON.stringify(calls);
    for (const secret of ['test-only-operator', 'a'.repeat(64), 'b'.repeat(64), 'caller-private']) expect(text).not.toContain(secret);
  });
  it('audit line for a body-supplied call records source=body and identifiers only', async () => {
    await callerU('/api/nft').send({ id: 'custom-nft', owner: OTHER, metadata: { secret: 'meta-do-not-log' } });
    const text = JSON.stringify(audits());
    expect(text).toContain('"source":"body"'); expect(text).toContain('custom-nft'); expect(text).not.toContain('meta-do-not-log');
  });
  it('an upstream refusal is audited as refused', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, payload: { error: 'no' } });
    await callerU('/api/nft').send({});
    expect(audits().map(c => c[1].outcome)).toEqual(['attempt', 'refused']);
  });
  it('no audit line is written for a rejected call', async () => {
    await callerU('/api/nft').send({ id: 'x', owner: 'bad' });
    expect(audits()).toHaveLength(0);
  });
});
describe('mounted wallet-signed governance votes (#1321)', () => {
  it('verifies the signature and binds voter to verified JWT sub before lending Contributor', async () => {
    const payload = vote(); const res = await caller('/api/governance/proposals/proposal-1/vote', wallet).send(payload);
    expect(res.status).toBe(200); expect(res.body.vote.voterAddress).toBe(voter);
    expect(mockFetch).toHaveBeenCalledWith('/governance/vote', { method: 'POST', headers: {
      authorization: 'Bearer test-only-contributor', ...trace, 'x-voter-address': voter,
    }, body: { proposal_id: 'proposal-1', approve: true, signature: payload.signature, signer_public_key: publicKey } });
  });
  it('preserves a signed rejection ballot using the voteType alias', async () => {
    const { support: _support, ...payload } = vote('proposal-1', false);
    const res = await caller('/api/governance/proposals/proposal-1/vote', wallet).send({ ...payload, voteType: 'AGAINST' });
    expect(res.status).toBe(200); expect(mockFetch.mock.calls[0][1].body.approve).toBe(false);
  });
  it.each([
    ['unsigned', () => ({ support: true })],
    ['tampered choice', () => ({ ...vote(), support: false })],
    ['foreign proposal', () => vote('other')],
    ['foreign chain', () => vote('proposal-1', true, 'other')],
    ['foreign network', () => vote('proposal-1', true, '777', 'other')],
    ['malformed key', () => ({ ...vote(), signer_public_key: '0'.repeat(63) })],
    ['malformed signature', () => ({ ...vote(), signature: '0'.repeat(128) })],
    ['ambiguous aliases', () => ({ ...vote(), voteType: 'AGAINST' })],
    ['unsigned power', () => ({ ...vote(), voting_power: 100000 })],
  ])('rejects %s before any upstream call', async (_name, payload) => {
    expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send((payload as Function)())).status).toBe(400); expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each([{ ...wallet, sub: ADDRESS }, { roles: ['admin'] }, { ...wallet, role: 'user' }, { ...wallet, wallet_scheme: 'evm' }])('refuses unbound or incompatible wallet claims %j', async claims => {
    expect((await caller('/api/governance/proposals/proposal-1/vote', claims).send(vote())).status).toBe(403); expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each(['WRFCOIN_CONTRIBUTOR_TOKEN', 'WRFCOIN_GOVERNANCE_SIGNING_VERSION', 'WRFCOIN_GOVERNANCE_CHAIN_ID', 'WRFCOIN_GOVERNANCE_NETWORK_ID'])('fails closed when %s is unset', async env => {
    delete process.env[env]; expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send(vote())).status).toBe(503); expect(mockFetch).not.toHaveBeenCalled();
  });
  // Golden vector: core4 @65134a64 shared-protocol/src/blockchain/transaction.rs:1695-1706,
  // message `governance-vote-v1|<proposal_id>|approve|reject`, signed independently with node:crypto.
  function v1Vote(proposal = 'proposal-1', approve = true) {
    const msg = Buffer.from(`governance-vote-v1|${proposal}|${approve ? 'approve' : 'reject'}`, 'utf8');
    return { support: approve, signer_public_key: publicKey, signature: crypto.sign(null, msg, privateKey).toString('hex') };
  }
  it('V1 golden: exact core4 V1 bytes verify under =1 and are forwarded; fail under =2', async () => {
    expect(Buffer.from('governance-vote-v1|proposal-1|approve').toString('hex'))
      .toBe('676f7665726e616e63652d766f74652d76317c70726f706f73616c2d317c617070726f7665');
    process.env.WRFCOIN_GOVERNANCE_SIGNING_VERSION = '1';
    const payload = v1Vote();
    const res = await caller('/api/governance/proposals/proposal-1/vote', wallet).send(payload);
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith('/governance/vote', expect.objectContaining({ body: { proposal_id: 'proposal-1', approve: true, signature: payload.signature, signer_public_key: publicKey } }));
    mockFetch.mockClear();
    process.env.WRFCOIN_GOVERNANCE_SIGNING_VERSION = '2';
    expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send(payload)).status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('V1 reject ballot verifies under =1; tampered choice/proposal fail', async () => {
    process.env.WRFCOIN_GOVERNANCE_SIGNING_VERSION = '1';
    expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send(v1Vote('proposal-1', false))).status).toBe(200);
    mockFetch.mockClear();
    expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send({ ...v1Vote(), support: false })).status).toBe(400);
    expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send(v1Vote('other'))).status).toBe(400);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('V2 signature fails under =1; other versions fail closed 503; version is never caller-selected', async () => {
    process.env.WRFCOIN_GOVERNANCE_SIGNING_VERSION = '1';
    expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send(vote())).status).toBe(400);
    expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send({ ...v1Vote(), version: 1 })).status).toBe(400);
    for (const v of ['3', '01', 'v1', '']) {
      process.env.WRFCOIN_GOVERNANCE_SIGNING_VERSION = v;
      expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send(v1Vote())).status).toBe(503);
    }
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('V1 still requires chain/network config and refuses blank Contributor', async () => {
    process.env.WRFCOIN_GOVERNANCE_SIGNING_VERSION = '1'; delete process.env.WRFCOIN_GOVERNANCE_CHAIN_ID;
    expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send(v1Vote())).status).toBe(503);
    process.env.WRFCOIN_GOVERNANCE_CHAIN_ID = '777'; process.env.WRFCOIN_CONTRIBUTOR_TOKEN = '   ';
    expect((await caller('/api/governance/proposals/proposal-1/vote', wallet).send(v1Vote())).status).toBe(503); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('does not accept a forged wallet JWT even with a valid vote signature', async () => {
    const res = await request(app()).post('/api/governance/proposals/proposal-1/vote')
      .set('authorization', `Bearer ${token(wallet, 'foreign-test-key-00000000000000000000000')}`).send(vote());
    expect(res.status).toBe(401); expect(mockFetch).not.toHaveBeenCalled();
  });
});
