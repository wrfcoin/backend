import express from 'express';
import request from 'supertest';
import { jest, beforeEach, afterEach, describe, it, expect } from '@jest/globals';

// The bond admission proxy, with the admission service as a fetch stand-in.
// Every key, id and hash below is synthetic.
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const HEX = (b: string) => b.repeat(32);
const requestBody = () => ({
  transaction: { synthetic: true, data: '{}' },
  peerId: '12D3KooWJWoaqZhDaoEFshF7Rh1bpY9ohihFhzcW6d69Lr2NASuq',
  multiaddr: '/ip4/81.2.69.1/tcp/9000/p2p/12D3KooWJWoaqZhDaoEFshF7Rh1bpY9ohihFhzcW6d69Lr2NASuq',
  peerSignature: 'ab'.repeat(64),
});
const admitted = {
  ok: true,
  data: {
    admitted: true, included: false, action: 'Deposit', deploymentId: HEX('5a'), effectiveEpoch: 40,
    transaction: { synthetic: true, cosigned: true }, next: 'upstream wording is not relayed',
  },
};
const row = {
  action: 'Deposit', deploymentId: HEX('5a'), serverKey: HEX('7b'), serviceAlias: 'node-7b7b7b7b',
  effectiveEpoch: 40, renewal: false, time: '2026-11-20T01:00:00.000Z',
};

let upstream: jest.Mock<any>;
function makeApp(parsed = false) {
  const app = express();
  if (parsed) app.use(express.json({ limit: '1mb' }));
  app.use('/api/bond-admission', require('../routes/bond-admission-routes').default);
  return app;
}
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  jest.resetModules();
  process.env = {
    ...originalEnv,
    BOND_ADMISSION_PROXY_ENABLED: 'true',
    BOND_ADMISSION_URL: 'http://bond-admission.invalid:8094',
    DISABLE_FILE_LOG_TRANSPORTS: 'true',
  };
  upstream = jest.fn(async () => reply(200, admitted));
  global.fetch = upstream as unknown as typeof fetch;
});
afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});

describe('bond admission proxy', () => {
  it('is off (404) unless the flag is set, and then calls nothing', async () => {
    delete process.env.BOND_ADMISSION_PROXY_ENABLED;
    const app = makeApp();
    const post = await request(app).post('/api/bond-admission').send(requestBody());
    expect(post.status).toBe(404);
    expect(post.body.error.code).toBe('ADMISSION_DISABLED');
    expect((await request(app).get('/api/bond-admission/recent')).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('is 503 when on but no service URL is configured', async () => {
    delete process.env.BOND_ADMISSION_URL;
    const res = await request(makeApp()).post('/api/bond-admission').send(requestBody());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('ADMISSION_UNAVAILABLE');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards exactly the four fields, with no credential, and returns the co-signed packet', async () => {
    const res = await request(makeApp()).post('/api/bond-admission').send({ ...requestBody(), extra: 'dropped', challengeId: 'x' });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ admitted: true, included: false, action: 'Deposit', effectiveEpoch: 40 });
    expect(res.body.data.transaction).toEqual({ synthetic: true, cosigned: true });
    expect(res.body.data.next).not.toBe('upstream wording is not relayed');
    const [url, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://bond-admission.invalid:8094/bond-admission');
    expect(Object.keys(JSON.parse(init.body as string)).sort()).toEqual(['multiaddr', 'peerId', 'peerSignature', 'transaction']);
    expect(JSON.stringify(init.headers).toLowerCase()).not.toContain('authorization');
    expect(init.redirect).toBe('manual');
  });

  it('refuses a malformed request before calling the service', async () => {
    const app = makeApp();
    for (const body of [{}, { ...requestBody(), transaction: 'x' }, { ...requestBody(), transaction: [] }, { ...requestBody(), peerId: 1 }]) {
      const res = await request(app).post('/api/bond-admission').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_ADMISSION_REQUEST');
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('caps the body at 48 KiB, also behind a larger global parser', async () => {
    const big = { ...requestBody(), transaction: { pad: 'x'.repeat(49 * 1024) } };
    for (const parsed of [false, true]) {
      const res = await request(makeApp(parsed)).post('/api/bond-admission').send(big);
      expect(res.status).toBe(413);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('keeps known refusal codes and status, Retry-After, and never upstream text', async () => {
    upstream.mockImplementation(async () => reply(429, {
      ok: false, error: { code: 'ADMISSION_SPACING', message: 'leak: http://10.0.0.5 stack', retryAfterSeconds: 99 },
    }, { 'retry-after': '99' }));
    const res = await request(makeApp()).post('/api/bond-admission').send(requestBody());
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('99');
    expect(res.body.error.code).toBe('ADMISSION_SPACING');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');

    upstream.mockImplementation(async () => reply(422, { ok: false, error: { code: 'SOMETHING_NEW', message: 'x' } }));
    const unknown = await request(makeApp()).post('/api/bond-admission').send(requestBody());
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('ADMISSION_UNAVAILABLE');

    upstream.mockImplementation(async () => reply(500, { ok: false, error: { code: 'ADMISSION_FAILED' } }));
    expect((await request(makeApp()).post('/api/bond-admission').send(requestBody())).status).toBe(503);
  });

  it('turns an unexpected success, an oversized answer or a network failure into 503', async () => {
    for (const impl of [
      async () => reply(200, { ok: true, data: { admitted: false } }),
      async () => reply(200, { ok: true, data: { ...admitted.data, deploymentId: 'zz' } }),
      async () => reply(200, { ok: true, data: { pad: 'x'.repeat(200 * 1024) } }),
      async () => { throw new Error('ECONNREFUSED 10.0.0.5'); },
    ]) {
      upstream.mockImplementation(impl);
      const res = await request(makeApp()).post('/api/bond-admission').send(requestBody());
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    }
  });

  it('serves the recent list with only the known fields, and no query string', async () => {
    upstream.mockImplementation(async () => reply(200, { admissions: [{ ...row, ip: '81.2.69.1' }] }));
    const app = makeApp();
    const res = await request(app).get('/api/bond-admission/recent');
    expect(res.status).toBe(200);
    expect(res.body.admissions).toEqual([row]);
    expect(String(upstream.mock.calls[0][0])).toBe('http://bond-admission.invalid:8094/bond-admissions');
    expect((await request(app).get('/api/bond-admission/recent?limit=5')).status).toBe(400);

    upstream.mockImplementation(async () => reply(200, { admissions: [{ ...row, serverKey: 'nothex' }] }));
    expect((await request(app).get('/api/bond-admission/recent')).status).toBe(503);
  });
});
