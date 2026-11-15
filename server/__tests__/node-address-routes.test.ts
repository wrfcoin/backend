import express from 'express';
import request from 'supertest';
import { jest, beforeEach, afterEach, describe, it, expect } from '@jest/globals';

// The node address record proxy, with the mailbox service as a fetch stand-in.
// Every key, address and signature below is synthetic.
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const K = 'a1'.repeat(32);
const PEER = '12D3KooWJWoaqZhDaoEFshF7Rh1bpY9ohihFhzcW6d69Lr2NASuq';
const record = {
  version: 1, chain_id: '888', network_id: 'testnet', genesis_hash: 'ab'.repeat(32), deployment_id: '01'.repeat(32),
  server_key: K, peer_id: PEER, epoch: '41', height: '27300', multiaddrs: [`/ip4/198.51.99.7/tcp/9000/p2p/${PEER}`],
  signature: 'cd'.repeat(64), peer_signature: 'ef'.repeat(64),
};

let upstream: jest.Mock<any>;
function makeApp() {
  const app = express();
  app.use('/api/node-addresses', require('../routes/node-address-routes').default);
  return app;
}
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  jest.resetModules();
  process.env = {
    ...originalEnv,
    NODE_ADDRESS_PROXY_ENABLED: 'true',
    CLAIM_MAILBOX_URL: 'http://claim-mailbox.invalid:8095',
    DISABLE_FILE_LOG_TRANSPORTS: 'true',
  };
  upstream = jest.fn(async () => reply(200, { ok: true, data: { status: 'STORED', server_key: K, epoch: '41', height: '27300' } }));
  global.fetch = upstream as unknown as typeof fetch;
});
afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});

describe('node address record proxy', () => {
  it('is off (404) unless the flag is set, and then calls nothing', async () => {
    delete process.env.NODE_ADDRESS_PROXY_ENABLED;
    const res = await request(makeApp()).post('/api/node-addresses').send(record);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ADDRESSES_DISABLED');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('is 503 when on but no service URL is configured', async () => {
    delete process.env.CLAIM_MAILBOX_URL;
    const res = await request(makeApp()).post('/api/node-addresses').send(record);
    expect(res.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards exactly the record fields, no header or client address, and relays a fixed answer shape', async () => {
    const res = await request(makeApp()).post('/api/node-addresses')
      .set('X-Forwarded-For', '198.51.99.200').set('Authorization', 'Bearer synthetic').send(record);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, data: { status: 'STORED', server_key: K, epoch: '41', height: '27300' } });
    expect(upstream).toHaveBeenCalledTimes(1);
    const [url, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://claim-mailbox.invalid:8095/addresses');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('manual');
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    expect(JSON.parse(String(init.body))).toEqual(record);
  });

  it('refuses a wrong field set, a query, or an oversized body before calling the mailbox', async () => {
    const app = makeApp();
    for (const body of [{ ...record, extra: 1 }, (({ signature, ...rest }) => rest)(record), [], {}]) {
      const res = await request(app).post('/api/node-addresses').send(body as object);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_RECORD');
    }
    expect((await request(app).post('/api/node-addresses?x=1').send(record)).status).toBe(400);
    const big = await request(app).post('/api/node-addresses').send({ ...record, multiaddrs: ['x'.repeat(5000)] });
    expect(big.status).toBe(413);
    expect(big.body.error.code).toBe('RECORD_TOO_LARGE');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('keeps known refusal codes with local wording, and hides everything else', async () => {
    const cases: Array<[number, string, number, string]> = [
      [403, 'BAD_SIGNATURE', 403, 'BAD_SIGNATURE'],
      [403, 'NOT_BONDED', 403, 'NOT_BONDED'],
      [409, 'FUTURE_EPOCH', 409, 'FUTURE_EPOCH'],
      [429, 'RATE_LIMITED', 429, 'RATE_LIMITED'],
      [503, 'NODE_UNAVAILABLE', 503, 'NODE_UNAVAILABLE'],
      [404, 'ADDRESSES_DISABLED', 404, 'ADDRESSES_DISABLED'],
      [409, 'SOMETHING_NEW', 409, 'ADDRESSES_UNAVAILABLE'],
      [500, 'BAD_SIGNATURE', 503, 'BAD_SIGNATURE'],
    ];
    for (const [status, code, wantStatus, wantCode] of cases) {
      upstream.mockImplementationOnce(async () => reply(status, { ok: false, error: { code, message: 'upstream text at 10.0.0.5' } }));
      const res = await request(makeApp()).post('/api/node-addresses').send(record);
      expect(res.status).toBe(wantStatus);
      expect(res.body.error.code).toBe(wantCode);
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    }
  });

  it('answers 503 when the mailbox is down or answers out of shape', async () => {
    upstream.mockImplementationOnce(async () => { throw new Error('ECONNREFUSED 10.0.0.5'); });
    expect((await request(makeApp()).post('/api/node-addresses').send(record)).status).toBe(503);
    upstream.mockImplementationOnce(async () => reply(200, { ok: true, data: { status: 'STORED', server_key: 'nope' } }));
    expect((await request(makeApp()).post('/api/node-addresses').send(record)).status).toBe(503);
  });
});
