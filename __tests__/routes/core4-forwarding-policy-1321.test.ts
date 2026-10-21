import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';

jest.mock('../../server/utils/logger', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
    metrics: { recordHttpRequest: jest.fn() } };
  return { logger, securityLogger: logger, blockchainLogger: logger };
});
jest.mock('../../server/middleware/authLogging', () => ({
  logAuthSuccess: jest.fn(), logAuthFailure: jest.fn(), logApiKeyUsage: jest.fn(),
}));
jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: (_req: any, _res: any, next: any) => next(),
  transferLimiter: (_req: any, _res: any, next: any) => next(),
}));
jest.mock('../../config', () => ({ jwtSecret: 'test-only-unused-config' }));
jest.mock('../../server/services/noaa-nws-api-service', () => jest.fn(() => ({})));
const mockFetch = jest.fn();
jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: (...args: any[]) => mockFetch(...args), extractCore4Data: (p: any) => p,
  forwardCore4Headers: (headers: any, extra: any = {}) => ({ ...headers, ...extra }),
  toNullable: (value: any) => value ?? null,
  sendCore4Error: (res: any, r: any) => res.status(r.status).json(r.payload),
  sendCore4Unavailable: (res: any) => res.status(503).json({ error: { code: 'CORE4_UNAVAILABLE' } }),
  sendNotImplemented: (res: any) => res.status(501).json({ error: { code: 'NOT_IMPLEMENTED' } }),
}));

const SECRET = 'test-only-forwarding-audit-jwt-key-0000000000000000';
const OWNER = `0x${'a'.repeat(40)}`;
const RPC_KEY = 'test-only-audit-rpc-key';
const READER = 'test-only-audit-reader';
const CONTRIBUTOR = 'test-only-audit-contributor';
const saved = Object.fromEntries(['JWT_SECRET', 'RPC_API_KEY', 'WRFCOIN_READER_TOKEN',
  'WRFCOIN_CONTRIBUTOR_TOKEN'].map(key => [key, process.env[key]]));
process.env.JWT_SECRET = SECRET;
const routers = {
  mining: require('../../server/routes/mining-routes'),
  blockchain: require('../../server/routes/blockchain-routes'),
  rpc: require('../../server/routes/rpc-routes'),
  wallet: require('../../server/routes/wallet-routes'),
};
function token() {
  return jwt.sign({ sub: OWNER, role: 'wallet', type: 'access', userId: 'test-user',
    roles: ['user'], sessionId: 'test-only-audit-session' }, SECRET, {
    issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m',
  });
}
function app() {
  const result = express(); result.use(express.json());
  for (const [name, router] of Object.entries(routers)) result.use(`/api/${name}`, router);
  return result;
}
function caller(call: any) {
  return call.set('authorization', `Bearer ${token()}`).set('x-api-key', RPC_KEY)
    .set('cookie', 'client-private-cookie').set('x-request-id', 'audit-request')
    .set('x-correlation-id', 'audit-correlation');
}
const tracing = { 'x-request-id': 'audit-request', 'x-correlation-id': 'audit-correlation' };
function signedTransfer() {
  return { from: OWNER, to: `0x${'b'.repeat(40)}`, amount: '10', nonce: '7',
    auth_pubkey: 'a'.repeat(64), auth_signature: 'b'.repeat(128) };
}
beforeEach(() => {
  process.env.JWT_SECRET = SECRET; process.env.RPC_API_KEY = RPC_KEY;
  process.env.WRFCOIN_READER_TOKEN = ` ${READER} `;
  process.env.WRFCOIN_CONTRIBUTOR_TOKEN = ` ${CONTRIBUTOR} `;
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({ ok: true, status: 200, payload: {
    height: 1, hash: 'test-hash', chain_height: 1, sync_status: 'synced',
    one_time_address: 'test-address', transaction_key: 'test-key',
  } });
});
afterAll(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe('remaining core4 forwarding boundaries (#1321)', () => {
  it.each(['/api/mining/stats', '/api/blockchain/status'])('uses server Reader for %s', async path => {
    const res = await caller(request(app()).get(path));
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(4);
    for (const [, options] of mockFetch.mock.calls) expect(options.headers)
      .toEqual({ authorization: `Bearer ${READER}`, ...tracing });
  });
  it('keeps missing-Reader public reads free of caller credentials', async () => {
    delete process.env.WRFCOIN_READER_TOKEN;
    await caller(request(app()).get('/api/blockchain/status'));
    for (const [, options] of mockFetch.mock.calls) expect(options.headers).toEqual(tracing);
  });
  it('does not lend the mining Reader to an unauthenticated caller', async () => {
    expect((await request(app()).get('/api/mining/stats')).status).toBe(401);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('uses Reader for the RPC shared block read', async () => {
    const res = await caller(request(app()).post('/api/rpc'))
      .send({ jsonrpc: '2.0', id: 'block', method: 'blockchain.getBlock', params: 1 });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith('/chain/block/1', {
      headers: { authorization: `Bearer ${READER}`, ...tracing },
    });
  });
  it('uses only Reader and tracing for every RPC getStatus call (#1326)', async () => {
    const res = await caller(request(app()).post('/api/rpc'))
      .send({ jsonrpc: '2.0', id: 'status', method: 'blockchain.getStatus', params: {} });
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledTimes(3);
    for (const [, options] of mockFetch.mock.calls) expect(options.headers)
      .toEqual({ authorization: `Bearer ${READER}`, ...tracing });
  });
  it('fails closed before RPC getStatus when Reader is unset', async () => {
    delete process.env.WRFCOIN_READER_TOKEN;
    const res = await caller(request(app()).post('/api/rpc'))
      .send({ jsonrpc: '2.0', id: 'status', method: 'blockchain.getStatus', params: {} });
    expect(res.status).toBe(503); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('fails closed before RPC shared reads without Reader', async () => {
    delete process.env.WRFCOIN_READER_TOKEN;
    const res = await caller(request(app()).post('/api/rpc'))
      .send({ jsonrpc: '2.0', id: 'block', method: 'blockchain.getBlock', params: 1 });
    expect(res.status).toBe(503); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('strips credentials from the already signed permissionless lane', async () => {
    const res = await caller(request(app()).post('/api/rpc')).send({ jsonrpc: '2.0', id: 'tx',
      method: 'tx.submit', params: { signer_public_key: 'a'.repeat(64), signature: 'b'.repeat(128),
        nonce: 1, timestamp: 1, tx_type: 'data_analysis', payload: {} } });
    expect(res.status).toBe(200);
    expect(mockFetch.mock.calls[0][1].headers).toEqual(tracing);
  });
  it.each([[[]], [[{ jsonrpc: '2.0', id: 'x', method: 'wallet.getBalance', params: OWNER }]]])(
    'rejects RPC batches before any upstream call: %j', async body => {
      const res = await caller(request(app()).post('/api/rpc')).send(body);
      expect(res.status).toBe(400); expect(res.body.error.code).toBe(-32600);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  it.each(['constructor', 'toString', 'newWalletRead'])('refuses methods without an explicit policy: %s', async method => {
    const res = await caller(request(app()).post('/api/rpc')).send({ jsonrpc: '2.0', id: 'bad', method });
    expect(res.status).toBe(404); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('replaces every caller credential on the owner-bound signed wallet relay', async () => {
    const res = await caller(request(app()).post('/api/wallet/send')).send(signedTransfer());
    expect(res.status).toBe(200);
    expect(mockFetch.mock.calls[0][1].headers).toEqual({ authorization: `Bearer ${CONTRIBUTOR}`, ...tracing });
  });
  it.each([undefined, '   '])('does not fall back to the wallet caller when Contributor is %j', async value => {
    if (value === undefined) delete process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
    else process.env.WRFCOIN_CONTRIBUTOR_TOKEN = value;
    const res = await caller(request(app()).post('/api/wallet/send')).send(signedTransfer());
    expect(res.status).toBe(503); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('refuses a foreign signed sender before lending Contributor', async () => {
    const res = await caller(request(app()).post('/api/wallet/send'))
      .send({ ...signedTransfer(), from: `0x${'c'.repeat(40)}` });
    expect(res.status).toBe(403); expect(mockFetch).not.toHaveBeenCalled();
  });
});
