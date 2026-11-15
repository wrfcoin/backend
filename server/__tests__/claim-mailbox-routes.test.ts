import express from 'express';
import request from 'supertest';
import { jest, beforeEach, afterEach, describe, it, expect } from '@jest/globals';

// The claim mailbox read proxy, with the mailbox service as a fetch stand-in.
// Every id and hex value below is synthetic.
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const BOND = 'ab'.repeat(32);
const RID = (b: string) => b.repeat(32);
const answer = {
  deployment_id: BOND,
  epoch: '40',
  claims: [{ claim_hex: '0a01ff', receipt_id: RID('01') }, { claim_hex: '0a02ff', receipt_id: RID('02') }],
};
const PATH = `/api/claim-mailbox/claims/${BOND}/40`;

let upstream: jest.Mock<any>;
function makeApp() {
  const app = express();
  app.use('/api/claim-mailbox', require('../routes/claim-mailbox-routes').default);
  return app;
}
const reply = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  jest.resetModules();
  process.env = {
    ...originalEnv,
    CLAIM_MAILBOX_PROXY_ENABLED: 'true',
    CLAIM_MAILBOX_URL: 'http://claim-mailbox.invalid:8095',
    DISABLE_FILE_LOG_TRANSPORTS: 'true',
  };
  upstream = jest.fn(async () => reply(200, answer));
  global.fetch = upstream as unknown as typeof fetch;
});
afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});

describe('claim mailbox read proxy', () => {
  it('is off (404) unless the flag is set, and then calls nothing', async () => {
    delete process.env.CLAIM_MAILBOX_PROXY_ENABLED;
    const res = await request(makeApp()).get(PATH);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('MAILBOX_DISABLED');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('is 503 when on but no service URL is configured', async () => {
    delete process.env.CLAIM_MAILBOX_URL;
    const res = await request(makeApp()).get(PATH);
    expect(res.status).toBe(503);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('relays exactly the read shape `wrfcoin node receipt auto` reads, with no credential', async () => {
    upstream.mockImplementation(async () => reply(200, {
      ...answer, extra: 'dropped', claims: answer.claims.map((c) => ({ ...c, note: 'dropped' })),
    }));
    const res = await request(makeApp()).get(PATH).set('Authorization', 'Bearer should-not-be-forwarded');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body).toEqual(answer);
    const [url, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe(`http://claim-mailbox.invalid:8095/claims/${BOND}/40`);
    expect(JSON.stringify(init.headers ?? {}).toLowerCase()).not.toContain('authorization');
    expect(init.redirect).toBe('manual');
  });

  it('passes "no claim yet" and "disabled" through as 404', async () => {
    upstream.mockImplementation(async () => reply(404, { ok: false, error: { code: 'NO_CLAIM', message: 'x' } }));
    const none = await request(makeApp()).get(PATH);
    expect(none.status).toBe(404);
    expect(none.body.error.code).toBe('NO_CLAIM');
    upstream.mockImplementation(async () => reply(404, { ok: false, error: { code: 'MAILBOX_DISABLED' } }));
    expect((await request(makeApp()).get(PATH)).body.error.code).toBe('MAILBOX_DISABLED');
  });

  it('refuses bad routes and any query before calling the service', async () => {
    const app = makeApp();
    for (const path of [
      `/api/claim-mailbox/claims/${BOND.toUpperCase()}/40`, `/api/claim-mailbox/claims/${BOND}/040`,
      `/api/claim-mailbox/claims/${BOND}/1e3`, `/api/claim-mailbox/claims/xyz/40`, `${PATH}?x=1`,
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_CLAIM_ROUTE');
    }
    expect((await request(app).put(PATH).send({ claims: [] })).status).toBe(404); // no write path here
    expect((await request(app).get('/api/claim-mailbox/claims')).status).toBe(404);
    expect(upstream).not.toHaveBeenCalled();
  });

  it('turns a wrong, oversized or failed answer into 503 without upstream text', async () => {
    for (const impl of [
      async () => reply(200, { ...answer, deployment_id: 'cd'.repeat(32) }),
      async () => reply(200, { ...answer, epoch: '41' }),
      async () => reply(200, { ...answer, claims: [] }),
      async () => reply(200, { ...answer, claims: Array.from({ length: 9 }, (_, i) => ({ claim_hex: 'ab', receipt_id: RID(`0${i}`.slice(-2)) })) }),
      async () => reply(200, { ...answer, claims: [{ claim_hex: 'ABC', receipt_id: RID('01') }] }),
      async () => reply(200, { ...answer, claims: [{ claim_hex: 'ab', receipt_id: '../x' }] }),
      async () => reply(200, { pad: 'x'.repeat(70 * 1024) }),
      async () => reply(500, { error: { message: 'leak 10.0.0.5' } }),
      async () => { throw new Error('ECONNREFUSED 10.0.0.5'); },
    ]) {
      upstream.mockImplementation(impl);
      const res = await request(makeApp()).get(PATH);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('MAILBOX_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    }
  });
});
