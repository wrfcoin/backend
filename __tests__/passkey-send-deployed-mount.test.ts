/**
 * backend#21 mounted the self-proving passkey send router only in server/server.js; the deployed
 * entrypoint (Dockerfile CMD: dist/server/enhanced_unified_api_optimized.js) sent those paths to the
 * requireAuth wallet router. This boots the DEPLOYED entrypoint (same harness as the H11 inventory
 * ratchet) against a loopback fake core4 and checks, per flag state, which router answers:
 *   flag on:  /api/wallet/send-passkey* reach the passkey router (validation 400, nonce read, relay);
 *   flag off: unchanged, they fall through to the requireAuth wallet router (401) and core4 is untouched.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { bootLiveEntrypoint, getRouteTemplates, type Booted } from './helpers/anonymous-get-harness';

const DEAD_DB = 'postgresql://127.0.0.1:59999/passkey_mount_dead';
const CONTRIBUTOR = 'test-contributor-passkey-mount-0123456789';
const FROM = '0xca0e0f30e971631615883cba3976053463c3f63e';
const TO = '0x1111111111111111111111111111111111111111';
const transfer = () => ({
  from: FROM, to: TO, amount: '1000', nonce: '7',
  passkey_auth: {
    public_key_p256: 'ab'.repeat(64), rp_id_hash: 'cd'.repeat(32),
    authenticator_data: 'ef'.repeat(37), client_data_json: '7b7d', signature: '30'.repeat(70),
  },
});

type Seen = { method: string; path: string; authorization?: string };
let seen: Seen[] = [];
let core4: http.Server;
let core4Url = '';

beforeAll(async () => {
  core4 = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', authorization: req.headers.authorization });
      res.writeHead(req.method === 'POST' ? 202 : 200, { 'content-type': 'application/json' });
      if (req.url?.startsWith('/addresses/')) return res.end(JSON.stringify({ ok: true, data: { address: FROM, balance: '5', nonce: '7' } }));
      if (req.url === '/transactions/submit') return res.end(JSON.stringify({ ok: true, data: { tx_id: 'tx-deployed-mount' } }));
      return res.end(JSON.stringify({ ok: true, data: {} }));
    });
  });
  await new Promise<void>((r) => core4.listen(0, '127.0.0.1', () => r()));
  core4Url = `http://127.0.0.1:${(core4.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => core4.close(() => r())); });

let client = 0;
async function call(app: Booted, method: 'GET' | 'POST', urlPath: string, body?: unknown) {
  // A distinct client per request so per-IP limiters never mask the router's answer.
  const res = await fetch(`http://127.0.0.1:${app.port}${urlPath}`, {
    method,
    signal: AbortSignal.timeout(8000),
    headers: { 'x-forwarded-for': `203.0.113.${1 + (client++ % 250)}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json };
}

describe.each([
  ['on', { WRFCOIN_ENABLE_PASSKEY_SEND: 'true' }],
  ['off', { WRFCOIN_ENABLE_PASSKEY_SEND: '' }],
])('deployed entrypoint, WRFCOIN_ENABLE_PASSKEY_SEND %s', (flag, flagEnv) => {
  let app: Booted;
  beforeAll(async () => {
    app = await bootLiveEntrypoint(DEAD_DB, { ...flagEnv, CORE4_API_URL: core4Url, WRFCOIN_CONTRIBUTOR_TOKEN: CONTRIBUTOR });
  }, 150_000);
  afterAll(async () => { await app?.stop(); });

  it('lists the passkey nonce route in the route table', () => {
    expect(getRouteTemplates(app.inventory)).toEqual(expect.arrayContaining([
      '/api/wallet/send-passkey/nonce/:address', '/api/wallet/:address',
    ]));
  });

  if (flag === 'on') {
    it('POST /api/wallet/send-passkey reaches the passkey router (its validation), not requireAuth', async () => {
      const res = await call(app, 'POST', '/api/wallet/send-passkey', { from: FROM });
      expect(res.status).toBe(400);
      expect(res.json?.error?.code).toBe('VALIDATION_ERROR');
    });
    it('relays a well-formed passkey transfer to core4 with the server Contributor token, with no login', async () => {
      seen = [];
      const res = await call(app, 'POST', '/api/wallet/send-passkey', transfer());
      expect(res.status).toBe(202);
      expect(res.json).toEqual({ hash: 'tx-deployed-mount', status: 'submitted', settled: false });
      const submit = seen.find((s) => s.path === '/transactions/submit');
      expect(submit?.authorization).toBe(`Bearer ${CONTRIBUTOR}`);
    });
    it('GET /api/wallet/send-passkey/nonce/:address answers the nonce with no login', async () => {
      const res = await call(app, 'GET', `/api/wallet/send-passkey/nonce/${FROM}`);
      expect(res.status).toBe(200);
      expect(res.json).toEqual({ address: FROM, nonce: '7' });
    });
  } else {
    it('POST /api/wallet/send-passkey falls through to the requireAuth wallet router (401), core4 untouched', async () => {
      seen = [];
      const res = await call(app, 'POST', '/api/wallet/send-passkey', transfer());
      expect(res.status).toBe(401);
      expect(seen.filter((s) => s.path === '/transactions/submit')).toEqual([]);
    });
    it('GET /api/wallet/send-passkey/nonce/:address falls through to requireAuth (401), core4 untouched', async () => {
      seen = [];
      const res = await call(app, 'GET', `/api/wallet/send-passkey/nonce/${FROM}`);
      expect(res.status).toBe(401);
      expect(seen.filter((s) => s.path.startsWith('/addresses/'))).toEqual([]);
    });
  }

  it('leaves the rest of /api/wallet behind requireAuth', async () => {
    expect((await call(app, 'GET', `/api/wallet/${FROM}`)).status).toBe(401);
    expect((await call(app, 'POST', '/api/wallet/send', { from: FROM, to: TO, amount: '1' })).status).toBe(401);
  });
});
