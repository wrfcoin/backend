import express from 'express';
import request from 'supertest';
import { jest, beforeEach, afterEach, describe, it, expect } from '@jest/globals';

// The station registrar proxy, with the registrar service as a fetch stand-in.
// Every key, id, signature and address below is synthetic.
const originalEnv = { ...process.env };
const originalFetch = global.fetch;
const STATION = `mob-${'3c'.repeat(16)}`;
const row = () => ({
  station_id: STATION,
  owner_address: `0x${'ab'.repeat(20)}`,
  owner_pubkey: 'cd'.repeat(32),
  owner_signature: 'ef'.repeat(64),
  latitude: 49.3,
  longitude: -123.1,
  hardware_model: 'phone-barometer',
  provenance_class: 'real',
  data_quality_tier: 'unverified',
});
const held = { ok: true, data: { stationId: STATION, status: 'held', releaseAt: '2026-11-22T20:00:00.000Z' } };

let upstream: jest.Mock<any>;
function makeApp({ parsed = false, ip = '81.2.69.1' }: { parsed?: boolean; ip?: string | null } = {}) {
  const app = express();
  // Stand-in for the entrypoint's trust-proxy resolution of req.ip.
  app.use((req, _res, next) => { Object.defineProperty(req, 'ip', { value: ip ?? undefined }); next(); });
  if (parsed) app.use(express.json({ limit: '1mb' }));
  app.use('/api/station-registrar', require('../routes/station-registrar-routes').default);
  return app;
}
const reply = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

beforeEach(() => {
  jest.resetModules();
  process.env = {
    ...originalEnv,
    STATION_REGISTRAR_PROXY_ENABLED: 'true',
    STATION_REGISTRAR_URL: 'http://station-registrar.invalid:8095',
    DISABLE_FILE_LOG_TRANSPORTS: 'true',
  };
  upstream = jest.fn(async () => reply(202, held));
  global.fetch = upstream as unknown as typeof fetch;
});
afterEach(() => {
  process.env = { ...originalEnv };
  global.fetch = originalFetch;
});

describe('station registrar proxy', () => {
  it('is off (404) unless the flag is set, and then calls nothing', async () => {
    for (const value of [undefined, 'false', '1', 'TRUE']) {
      if (value === undefined) delete process.env.STATION_REGISTRAR_PROXY_ENABLED;
      else process.env.STATION_REGISTRAR_PROXY_ENABLED = value;
      const app = makeApp();
      const post = await request(app).post('/api/station-registrar/requests').send(row());
      expect(post.status).toBe(404);
      expect(post.body.error.code).toBe('REGISTRAR_DISABLED');
      expect((await request(app).get(`/api/station-registrar/requests/${STATION}`)).status).toBe(404);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('is 503 when on but no service URL is configured', async () => {
    delete process.env.STATION_REGISTRAR_URL;
    const res = await request(makeApp()).post('/api/station-registrar/requests').send(row());
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('REGISTRAR_UNAVAILABLE');
    expect(upstream).not.toHaveBeenCalled();
  });

  it('forwards exactly the nine row fields and one client address, with no credential', async () => {
    const res = await request(makeApp()).post('/api/station-registrar/requests')
      .set('X-Forwarded-For', '203.0.113.50, 198.51.100.1')
      .send({ ...row(), extra: 'dropped', elevation: 12, submitted_at: 1 });
    expect(res.status).toBe(202);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.data).toMatchObject({ stationId: STATION, status: 'held', releaseAt: held.data.releaseAt });
    const [url, init] = upstream.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toBe('http://station-registrar.invalid:8095/station-registrar/requests');
    expect(JSON.parse(init.body as string)).toEqual(row());
    const headers = init.headers as Record<string, string>;
    expect(headers['x-forwarded-for']).toBe('81.2.69.1');
    expect(JSON.stringify(headers).toLowerCase()).not.toContain('authorization');
    expect(init.redirect).toBe('manual');
  });

  it('strips the IPv4-mapped prefix and refuses when the address is unknown', async () => {
    await request(makeApp({ ip: '::ffff:81.2.69.1' })).post('/api/station-registrar/requests').send(row());
    expect(((upstream.mock.calls[0] as [URL, RequestInit])[1].headers as Record<string, string>)['x-forwarded-for']).toBe('81.2.69.1');
    upstream.mockClear();
    for (const ip of [null, '', 'not-an-ip']) {
      const res = await request(makeApp({ ip })).post('/api/station-registrar/requests').send(row());
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('CLIENT_ADDRESS_UNKNOWN');
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('refuses a malformed row before calling the service', async () => {
    const app = makeApp();
    const { latitude: _l, ...noLatitude } = row();
    for (const body of [{}, [], noLatitude, { ...row(), latitude: '49.3' }, { ...row(), station_id: 7 }, { ...row(), hardware_model: null }]) {
      const res = await request(app).post('/api/station-registrar/requests').send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('INVALID_REQUEST');
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('caps the body at 8 KiB, also behind a larger global parser', async () => {
    const big = { ...row(), pad: 'x'.repeat(9 * 1024) };
    for (const parsed of [false, true]) {
      const res = await request(makeApp({ parsed })).post('/api/station-registrar/requests').send(big);
      expect(res.status).toBe(413);
    }
    expect(upstream).not.toHaveBeenCalled();
  });

  it('keeps known refusal codes and status, Retry-After, and never upstream text', async () => {
    upstream.mockImplementation(async () => reply(429, {
      ok: false, error: { code: 'DAILY_PER_IP', message: 'leak: http://10.0.0.5 stack', retryAfterSeconds: 99 },
    }, { 'retry-after': '99' }));
    const res = await request(makeApp()).post('/api/station-registrar/requests').send(row());
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('99');
    expect(res.body.error.code).toBe('DAILY_PER_IP');
    expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');

    upstream.mockImplementation(async () => reply(503, { ok: false, error: { code: 'REGISTRAR_NOT_ACTIVE', message: 'x' } }));
    const inactive = await request(makeApp()).post('/api/station-registrar/requests').send(row());
    expect(inactive.status).toBe(503);
    expect(inactive.body.error.code).toBe('REGISTRAR_NOT_ACTIVE');

    upstream.mockImplementation(async () => reply(422, { ok: false, error: { code: 'SOMETHING_NEW', message: 'x' } }));
    const unknown = await request(makeApp()).post('/api/station-registrar/requests').send(row());
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('REGISTRAR_UNAVAILABLE');

    upstream.mockImplementation(async () => reply(500, { ok: false, error: { code: 'REGISTRAR_FAILED' } }));
    expect((await request(makeApp()).post('/api/station-registrar/requests').send(row())).status).toBe(503);
  });

  it('turns an unexpected acceptance, an oversized answer or a network failure into 503', async () => {
    for (const impl of [
      async () => reply(202, { ok: true, data: { ...held.data, status: 'registered' } }),
      async () => reply(202, { ok: true, data: { ...held.data, stationId: `mob-${'00'.repeat(16)}` } }),
      async () => reply(202, { ok: true, data: { ...held.data, releaseAt: 'soon' } }),
      async () => reply(202, { ok: true, data: { pad: 'x'.repeat(20 * 1024) } }),
      async () => { throw new Error('ECONNREFUSED 10.0.0.5'); },
    ]) {
      upstream.mockImplementation(impl);
      const res = await request(makeApp()).post('/api/station-registrar/requests').send(row());
      expect(res.status).toBe(503);
      expect(JSON.stringify(res.body)).not.toContain('10.0.0.5');
    }
  });

  it('serves a status with only the known fields, and no query string', async () => {
    const tx = '9a'.repeat(32);
    upstream.mockImplementation(async () => reply(200, {
      ok: true, data: { stationId: STATION, status: 'registered', transactionId: tx, owner_address: '0xleak', ip: '81.2.69.1' },
    }));
    const app = makeApp();
    const res = await request(app).get(`/api/station-registrar/requests/${STATION}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ stationId: STATION, status: 'registered', transactionId: tx });
    expect(String(upstream.mock.calls[0][0])).toBe(`http://station-registrar.invalid:8095/station-registrar/requests/${STATION}`);
    expect((await request(app).get(`/api/station-registrar/requests/${STATION}?x=1`)).status).toBe(400);

    upstream.mockImplementation(async () => reply(404, { ok: false, error: { code: 'NOT_REQUESTED' } }));
    const missing = await request(app).get(`/api/station-registrar/requests/${STATION}`);
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('NOT_REQUESTED');

    for (const data of [
      { stationId: STATION, status: 'weird' },
      { stationId: STATION, status: 'registered', transactionId: 'nothex' },
      { stationId: STATION, status: 'refused', code: 'leak 10.0.0.5' },
      { stationId: `mob-${'00'.repeat(16)}`, status: 'held' },
    ]) {
      upstream.mockImplementation(async () => reply(200, { ok: true, data }));
      expect((await request(app).get(`/api/station-registrar/requests/${STATION}`)).status).toBe(503);
    }
  });

  it('refuses a station id that is not a phone id before calling the service', async () => {
    const app = makeApp();
    for (const id of ['ws-1', `mob-${'3C'.repeat(16)}`, `mob-${'3c'.repeat(15)}`, '..%2Fhealth']) {
      const res = await request(app).get(`/api/station-registrar/requests/${id}`);
      expect(res.status).toBe(400);
    }
    expect(upstream).not.toHaveBeenCalled();
  });
});
