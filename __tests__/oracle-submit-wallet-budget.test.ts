/** Real JWT middleware and HTTP submit router; only DB/node/logger boundaries are synthetic. */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const mockLimiters: any[] = [];
jest.mock('express-rate-limit', () => {
  const actual = jest.requireActual('express-rate-limit');
  const wrapped: any = (options: any) => {
    const limiter = actual.rateLimit(options); mockLimiters.push(limiter); return limiter;
  };
  Object.assign(wrapped, actual); wrapped.default = wrapped; wrapped.__esModule = true;
  return wrapped;
});
jest.mock('../utils/logger', () => ({ logger: mockLog }));
jest.mock('../server/utils/logger', () => ({ blockchainLogger: mockLog }));
const mockOwners = new Map<string, string>();
const key = crypto.createPrivateKey({ key: Buffer.concat([
  Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.alloc(32, 7),
]), format: 'der', type: 'pkcs8' });
const PUB = (crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer).subarray(-32).toString('hex');
const mockQuery = jest.fn(async (sql: string, args: string[]) => ({ rows: sql.includes('collect_pubkey')
  ? [{ collect_pubkey: PUB, status: 'on_chain' }]
  : mockOwners.has(args[0]) ? [{ owner_address: mockOwners.get(args[0]) }] : [] }));
jest.mock('../database/connection.js', () => ({ executeQuery: (...args: any[]) => mockQuery(...args as [string, string[]]) }));
const mockNode = jest.fn(async (_url: string, _init: any) => ({
  ok: true, status: 200, text: async () => JSON.stringify({ ok: true, data: {
    status: 'revealed_pending_attestation', tx_id: 'synthetic-transfer',
  } }),
}));
jest.mock('../shared/core4-node-http', () => ({ nodeHttpFetch: (...args: any[]) => mockNode(...args as [string, any]) }));

const SECRET = 'synthetic-phone-budget-jwt-secret-at-least-32-chars';
const ENV = { JWT_SECRET: SECRET, CORE4_API_URL: 'http://core4.invalid',
  WRFCOIN_READER_TOKEN: 'synthetic-reader', WRFCOIN_CONTRIBUTOR_TOKEN: 'synthetic-contributor',
  WRFCOIN_CHAIN_ID: '777', WRFCOIN_NETWORK_ID: 'testnet' };
const saved = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]]));
Object.assign(process.env, ENV);
const router = require('../server/routes/oracle-submit-routes').default;
const NOW = 1790000000000;
let serial = 0;
function wallet() { return '0x' + (++serial).toString(16).padStart(40, '0'); }
function token(address: string, type = 'access', jti = 'first') {
  return jwt.sign({ sub: address, address, role: 'wallet', wallet_scheme: 'ed25519', type, jti }, SECRET,
    { algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '15m' });
}
function body(owner: string, index = 0) {
  const stationId = 'mob-' + (serial * 1000 + index).toString(16).padStart(32, '0');
  mockOwners.set(stationId, owner.toLowerCase());
  return { stationId, dataType: 'temperature', location: { lat: 1, lon: 2 }, value: 20,
    timestamp: new Date(NOW).toISOString(), source: 'mobile', nonce: 'synthetic-' + index };
}
function app() {
  const a = express(); a.use(express.json()); a.use('/api/oracle', router); return a;
}
function post(a: express.Express, phase: 'prepare' | 'submit', bearer: string, data: any) {
  return request(a).post('/api/oracle/submit-data' + (phase === 'prepare' ? '/prepare' : ''))
    .set('authorization', 'Bearer ' + bearer).send(data);
}
beforeAll(() => {
  // Fake Date only: sockets and limiter cleanup timers stay real.
  jest.useFakeTimers({ now: NOW, doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask',
    'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
});
beforeEach(async () => {
  jest.setSystemTime(NOW); jest.clearAllMocks(); mockOwners.clear();
  // Reset only the original shared loopback bucket so main's cases are independent.
  // Actual limiters and stores run unchanged; each wallet fixture is unique.
  const { ipKeyGenerator } = require('express-rate-limit');
  const ip = ipKeyGenerator('::ffff:127.0.0.1');
  await Promise.all(mockLimiters.flatMap(l => [l.resetKey(ip), l.resetKey('ip:' + ip)]));
});
afterAll(() => {
  jest.useRealTimers();
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
});

describe('phone prepare and submit budgets after wallet authentication', () => {
  it('admits thirty complete signed reading pairs and limits the next attempt per phase', async () => {
    const a = app(), owner = wallet(), bearer = token(owner);
    for (let i = 0; i < 30; i++) {
      const data = body(owner, i);
      const prepared = await post(a, 'prepare', bearer, data);
      expect(prepared.status).toBe(200);
      const signature = crypto.sign(null, Buffer.from(prepared.body.authorization.messageHex, 'hex'), key).toString('hex');
      const submitted = await post(a, 'submit', bearer, { ...data, nonce: prepared.body.nonce,
        auth_pubkey: PUB, auth_signature: signature });
      expect(submitted.status).toBe(200);
      expect(submitted.body.commitHash).toBe(prepared.body.commitId);
    }
    expect((await post(a, 'prepare', bearer, body(owner, 30))).status).toBe(429);
    expect((await post(a, 'submit', bearer, body(owner, 30))).status).toBe(429);
    expect(mockNode).toHaveBeenCalledTimes(120);
  });
  it('excess prepares cannot spend the signed-submit budget', async () => {
    const a = app(), owner = wallet(), bearer = token(owner), data = body(owner);
    for (let i = 0; i < 30; i++) expect((await post(a, 'prepare', bearer, data)).status).toBe(200);
    expect((await post(a, 'prepare', bearer, data)).status).toBe(429);
    const res = await post(a, 'submit', bearer, { ...data, auth_pubkey: PUB, auth_signature: '11'.repeat(64) });
    expect(res.status).toBe(200);
    expect(mockNode).toHaveBeenCalledTimes(4);
  });
  it('wallets sharing the same socket IP have independent bounded phase quotas', async () => {
    const a = app();
    for (let n = 0; n < 3; n++) {
      const owner = wallet(), bearer = token(owner), data = body(owner);
      for (let i = 0; i < 30; i++) expect((await post(a, 'prepare', bearer, data)).status).toBe(200);
      expect((await post(a, 'prepare', bearer, data)).status).toBe(429);
    }
    expect(mockNode).not.toHaveBeenCalled();
  });
  it('new JWT ids, address case, body contributor and station changes cannot mint an owner bucket', async () => {
    const a = app(), owner = wallet(), bearer = token(owner);
    for (let i = 0; i < 30; i++) expect((await post(a, 'prepare', bearer, {})).status).toBe(400);
    const refreshed = token(owner.toUpperCase(), 'access', 'new-id');
    const res = await post(a, 'prepare', refreshed, { ...body(owner, 30), contributor: wallet() });
    expect(res.status).toBe(429);
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it('counts failed submissions and refuses the thirty-first before store or node work', async () => {
    const a = app(), owner = wallet(), bearer = token(owner);
    for (let i = 0; i < 30; i++) expect((await post(a, 'submit', bearer, {})).status).toBe(400);
    const res = await post(a, 'submit', token(owner, 'access', 'replacement'), body(owner));
    expect(res.status).toBe(429);
    expect(res.headers['ratelimit-limit']).toBe('30');
    expect(res.headers['retry-after']).toBeDefined();
    expect(mockQuery).not.toHaveBeenCalled(); expect(mockNode).not.toHaveBeenCalled();
  });
  it('rejects missing, forged and refresh bearers before consuming account quota', async () => {
    const a = app(), owner = wallet(), data = body(owner);
    for (let i = 0; i < 35; i++) {
      expect((await request(a).post('/api/oracle/submit-data/prepare').send(data)).status).toBe(401);
    }
    expect((await post(a, 'prepare', token(owner, 'refresh'), data)).status).toBe(401);
    expect((await post(a, 'prepare', 'forged', data)).status).toBe(401);
    expect(mockQuery).not.toHaveBeenCalled(); expect(mockNode).not.toHaveBeenCalled();
    expect((await post(a, 'prepare', token(owner), data)).status).toBe(200);
  });
  it('refills only when the one-minute Date boundary is reached', async () => {
    const a = app(), owner = wallet(), bearer = token(owner);
    for (let i = 0; i < 30; i++) expect((await post(a, 'prepare', bearer, {})).status).toBe(400);
    jest.setSystemTime(NOW + 59999);
    expect((await post(a, 'prepare', bearer, {})).status).toBe(429);
    jest.setSystemTime(NOW + 60000);
    expect((await post(a, 'prepare', bearer, {})).status).toBe(400);
  });
  it('verified tokens without a wallet use a bounded IP fallback, independent of JWT ids', async () => {
    const a = app();
    const bearer = (jti: string) => jwt.sign({ userId: 'synthetic-user', type: 'access', jti }, SECRET,
      { issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '15m' });
    for (let i = 0; i < 30; i++) expect((await post(a, 'prepare', bearer(String(i)), {})).status).toBe(400);
    expect((await post(a, 'prepare', bearer('replacement'), {})).status).toBe(429);
    expect(mockQuery).not.toHaveBeenCalled(); expect(mockNode).not.toHaveBeenCalled();
  });
});
