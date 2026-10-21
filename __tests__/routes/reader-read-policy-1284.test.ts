import { beforeEach, afterAll, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

jest.mock('../../server/utils/logger', () => {
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), metrics: { recordHttpRequest: jest.fn() } };
  return { logger: log, securityLogger: log };
});
jest.mock('../../server/middleware/authLogging', () => ({
  logAuthSuccess: jest.fn(), logAuthFailure: jest.fn(), logApiKeyUsage: jest.fn(),
}));
jest.mock('../../server/services/noaa-nws-api-service', () => jest.fn(() => ({})));
jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: (_req: any, _res: any, next: any) => next(),
  transferLimiter: (_req: any, _res: any, next: any) => next(),
}));

const mockFetch = jest.fn();
jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: (...args: unknown[]) => mockFetch(...args),
  extractCore4Data: (p: any) => p?.data ?? p,
  forwardCore4Headers: (h: any) => ({ authorization: h.authorization, 'x-api-key': h['x-api-key'] }),
  sendCore4Error: (res: any, result: any) => res.status(result.status).json(result.payload),
  sendCore4Unavailable: (res: any) => res.status(503).json({ error: { code: 'CORE4_UNAVAILABLE' } }),
}));

const rpcRouter = require('../../server/routes/rpc-routes');
const nftRouter = require('../../server/routes/nft-routes');
const OWNER = `0x${'a'.repeat(40)}`;
const FOREIGN = `0x${'b'.repeat(40)}`;
const JWT_KEY = 'test-only-reader-policy-wallet-jwt-key-000000000000';
const RPC_KEY = 'test-only-reader-policy-rpc-api-key';
const READER = 'test-only-server-reader-token';
const saved = Object.fromEntries(['JWT_SECRET', 'RPC_API_KEY', 'WRFCOIN_READER_TOKEN'].map(k => [k, process.env[k]]));
function access(sub = OWNER, role = 'wallet', secret = JWT_KEY) {
  return jwt.sign({ sub, role, type: 'access' }, secret, {
    algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m',
  });
}
function app() {
  const result = express();
  result.use(express.json());
  result.use('/api/rpc', rpcRouter);
  result.use('/api/nft', nftRouter);
  return result;
}
function balance(body: any = {}, token?: string) {
  let call = request(app()).post('/api/rpc').set('x-api-key', RPC_KEY);
  if (token) call = call.set('authorization', `Bearer ${token}`);
  return call.send({ jsonrpc: '2.0', id: 'balance-test', method: 'wallet.getBalance', params: OWNER, ...body });
}

beforeEach(() => {
  process.env.JWT_SECRET = JWT_KEY;
  process.env.RPC_API_KEY = RPC_KEY;
  process.env.WRFCOIN_READER_TOKEN = `  ${READER}  `;
  mockFetch.mockReset();
  mockFetch.mockImplementation(async (path: string, options: any) => {
    if (options.headers.authorization !== `Bearer ${READER}`) {
      return { ok: false, status: 403, payload: { error: { code: 'FORBIDDEN', message: 'Invalid API token' } } };
    }
    return { ok: true, status: 200, payload: path.startsWith('/addresses/')
      ? { spendable_balance: '12', pending_balance: '0', stake_locked: '1' }
      : path === '/nft/list' ? { items: [{ id: 'nft-other', owner: FOREIGN }], total: 1, limit: 20, offset: 0 }
        : { id: 'nft-other', owner: FOREIGN } };
  });
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('owner policy A: real RPC authentication + owner-bound Reader (#1284)', () => {
  it('reads only the verified wallet subject, with server Reader and tracing headers only', async () => {
    const caller = access();
    const res = await request(app()).post('/api/rpc')
      .set('x-api-key', RPC_KEY).set('authorization', `Bearer ${caller}`)
      .set('cookie', 'client-session=private').set('x-request-id', 'request-test').set('x-correlation-id', 'correlation-test')
      .send({ jsonrpc: '2.0', id: 'own', method: 'wallet.getBalance', params: OWNER });
    expect(res.status).toBe(200);
    expect(res.body.result).toMatchObject({ address: OWNER, balance: '12' });
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(`/addresses/${OWNER}`, { headers: {
      authorization: `Bearer ${READER}`, 'x-request-id': 'request-test', 'x-correlation-id': 'correlation-test',
    } });
    expect(JSON.stringify(mockFetch.mock.calls)).not.toContain(caller);
    expect(JSON.stringify(mockFetch.mock.calls)).not.toContain(RPC_KEY);
  });
  it('accepts casing differences in the owned hex address', async () => {
    const res = await balance({ params: `0x${'A'.repeat(40)}` }, access());
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
  it('an RPC API key plus claimed body identity cannot replace wallet login', async () => {
    const res = await balance({ user: { sub: OWNER, role: 'wallet' } });
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('rejects a forged wallet JWT before any core4 request', async () => {
    const res = await balance({}, access(OWNER, 'wallet', 'test-only-wrong-signing-key-000000000000'));
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('a valid non-wallet JWT cannot claim a wallet by its subject', async () => {
    const res = await balance({}, access(OWNER, 'user'));
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('refuses another wallet address before lending the Reader credential', async () => {
    const res = await balance({ params: FOREIGN }, access());
    expect(res.status).toBe(403);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each([{}, [OWNER], 123])('rejects malformed address parameter %j with zero core4 calls', async (params) => {
    const res = await balance({ params }, access());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe(-32602);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('returns a JSON-RPC 503 when the server Reader credential is unset', async () => {
    delete process.env.WRFCOIN_READER_TOKEN;
    const res = await balance({}, access());
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ jsonrpc: '2.0', id: 'balance-test', error: {
      data: { code: 'CORE4_READER_CREDENTIAL_UNCONFIGURED' },
    } });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('owner policy A: authenticated shared NFT Reader (#1284)', () => {
  it.each(['/api/nft', '/api/nft/nft-other'])('reads %s for a valid non-wallet user with server headers only', async (path) => {
    const caller = access('ordinary-user', 'user');
    const res = await request(app()).get(path).set('authorization', `Bearer ${caller}`)
      .set('x-api-key', 'client-nft-api-key').set('cookie', 'client-session=private')
      .set('x-request-id', 'nft-request').set('x-correlation-id', 'nft-correlation');
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain(FOREIGN);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch.mock.calls[0][1].headers).toEqual({
      authorization: `Bearer ${READER}`, 'x-request-id': 'nft-request', 'x-correlation-id': 'nft-correlation',
    });
    expect(JSON.stringify(mockFetch.mock.calls)).not.toContain(caller);
    expect(JSON.stringify(mockFetch.mock.calls)).not.toContain('client-nft-api-key');
  });
  it.each(['/api/nft', '/api/nft/nft-other'])('rejects anonymous %s with zero core4 calls', async (path) => {
    const res = await request(app()).get(path);
    expect(res.status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it.each(['/api/nft', '/api/nft/nft-other'])('returns 503 for %s without a server Reader token', async (path) => {
    process.env.WRFCOIN_READER_TOKEN = '   ';
    const res = await request(app()).get(path).set('authorization', `Bearer ${access()}`);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('CORE4_READER_CREDENTIAL_UNCONFIGURED');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
