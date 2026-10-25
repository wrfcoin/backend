/**
 * Self-proving passkey send (owner ruling 2026-10-25, "transfer proves itself"):
 * POST /api/wallet/send-passkey needs no JWT login; the WebAuthn assertion is the
 * authorization and core4 verifies it. The backend checks SHAPE AND SIZE only, then relays
 * to core4 POST /transactions/submit with the server Contributor token and no ed25519 fields.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';

type Seen = { method: string; path: string; headers: http.IncomingHttpHeaders; body: any };
const TOKEN = 'contributor-token-for-passkey-test';
const READER = 'reader-token-for-passkey-test';
const FROM = '0xca0e0f30e971631615883cba3976053463c3f63e';
const TO = '0x1111111111111111111111111111111111111111';
const passkey_auth = () => ({
  public_key_p256: 'ab'.repeat(64),
  rp_id_hash: 'cd'.repeat(32),
  authenticator_data: 'ef'.repeat(37),
  client_data_json: '7b7d',
  signature: '30'.repeat(70),
});
const body = (over: Record<string, unknown> = {}) => ({ from: FROM, to: TO, amount: '1000', nonce: '5', passkey_auth: passkey_auth(), ...over });

describe('POST /api/wallet/send-passkey', () => {
  const envKeys = ['CORE4_API_URL', 'WRFCOIN_CONTRIBUTOR_TOKEN', 'WRFCOIN_READER_TOKEN', 'WRFCOIN_ENABLE_PASSKEY_SEND'];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  let seen: Seen[] = [];
  let reply: { status: number; json: unknown } = { status: 202, json: { ok: true, data: { tx_id: 'tx-1' } } };
  let upstream: http.Server;
  let app: express.Express;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        seen.push({ method: req.method ?? '', path: req.url ?? '', headers: req.headers, body: raw ? JSON.parse(raw) : undefined });
        if (req.method === 'GET' && req.url?.startsWith('/addresses/')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, data: { address: FROM, balance: '999', nonce: 7 } }));
        }
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.json));
      });
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    Object.assign(process.env, {
      CORE4_API_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      WRFCOIN_CONTRIBUTOR_TOKEN: TOKEN,
      WRFCOIN_READER_TOKEN: READER,
      WRFCOIN_ENABLE_PASSKEY_SEND: 'true',
    });
    /* eslint-disable @typescript-eslint/no-var-requires */
    const router = require('../server/routes/wallet-passkey-send-routes');
    app = express();
    app.use(express.json({ verify: (req: any, _res, buf) => { req.rawBody = buf.toString(); } }));
    // No requireAuth anywhere: the route must work with no Authorization header.
    app.use('/api/wallet', router.default ?? router);
  });
  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await new Promise((r) => upstream.close(r));
  });
  beforeEach(() => { seen = []; reply = { status: 202, json: { ok: true, data: { tx_id: 'tx-1' } } }; process.env.WRFCOIN_ENABLE_PASSKEY_SEND = 'true'; });

  it('relays a passkey transfer with no JWT, the Contributor token, and no ed25519 fields', async () => {
    const res = await request(app).post('/api/wallet/send-passkey').send(body());
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ hash: 'tx-1', status: 'submitted', settled: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].path).toBe('/transactions/submit');
    expect(seen[0].headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(seen[0].body).toEqual({
      from: FROM, to: TO, amount: 1000, nonce: '5',
      transparent_opt_out: true, transparent_opt_out_reason: 'first-party wallet',
      passkey_auth: passkey_auth(),
    });
    expect(seen[0].body).not.toHaveProperty('auth_pubkey');
    expect(seen[0].body).not.toHaveProperty('auth_signature');
  });

  it('is 404 and never reaches core4 while the flag is off', async () => {
    delete process.env.WRFCOIN_ENABLE_PASSKEY_SEND;
    const res = await request(app).post('/api/wallet/send-passkey').send(body());
    expect(res.status).toBe(404);
    expect(seen).toHaveLength(0);
  });

  it.each([
    ['ed25519 fields present', { auth_pubkey: 'aa'.repeat(32) }],
    ['missing passkey_auth', { passkey_auth: undefined }],
    ['bad from', { from: '0x12' }],
    ['bad amount', { amount: '1.5' }],
    ['bad nonce', { nonce: 'x' }],
    ['non-hex field', { passkey_auth: { ...passkey_auth(), signature: 'zz' } }],
    ['odd-length hex', { passkey_auth: { ...passkey_auth(), client_data_json: '7b7' } }],
    ['public key wrong size', { passkey_auth: { ...passkey_auth(), public_key_p256: 'ab'.repeat(63) } }],
    ['rp_id_hash wrong size', { passkey_auth: { ...passkey_auth(), rp_id_hash: 'cd'.repeat(31) } }],
    ['client_data_json over the 4096-byte node cap', { passkey_auth: { ...passkey_auth(), client_data_json: 'aa'.repeat(4097) } }],
    ['unknown passkey member', { passkey_auth: { ...passkey_auth(), extra: '00' } }],
  ])('rejects on shape: %s', async (_name, over) => {
    const res = await request(app).post('/api/wallet/send-passkey').send(body(over));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(seen).toHaveLength(0);
  });

  it('rejects an oversized body before parsing it into a relay', async () => {
    const res = await request(app).post('/api/wallet/send-passkey').send(body({ pad: 'x'.repeat(40_000) }));
    expect(res.status).toBe(413);
    expect(seen).toHaveLength(0);
  });

  it.each([
    [503, { error: { code: 'FEATURE_NOT_ACTIVE', message: 'passkey_p256_auth is not active' } }],
    [400, { error: { code: 'AUTHORIZATION_INVALID', message: 'passkey_auth does not verify' } }],
  ])('passes core4 %s through unchanged', async (status, json) => {
    reply = { status, json };
    const res = await request(app).post('/api/wallet/send-passkey').send(body());
    expect(res.status).toBe(status);
    expect(res.body).toEqual(json);
  });

  it('does not log assertion bytes', async () => {
    const { logger } = require('../server/utils/logger');
    const lines: string[] = [];
    const spies = ['info', 'warn', 'error', 'debug'].map((k) => {
      const orig = logger[k]; logger[k] = (...a: unknown[]) => { lines.push(JSON.stringify(a)); };
      return () => { logger[k] = orig; };
    });
    reply = { status: 400, json: { error: { code: 'AUTHORIZATION_INVALID', message: 'no' } } };
    await request(app).post('/api/wallet/send-passkey').send(body());
    spies.forEach((restore) => restore());
    expect(lines.join('\n')).not.toContain('ef'.repeat(37));
    expect(lines.join('\n')).not.toContain('30'.repeat(70));
  });

  it('serves the account nonce with no JWT (public chain data, nonce only)', async () => {
    const res = await request(app).get(`/api/wallet/send-passkey/nonce/${FROM}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ address: FROM, nonce: '7' });
    expect(seen[0].path).toBe(`/addresses/${FROM}`);
    expect(seen[0].headers.authorization).toBe(`Bearer ${READER}`);
    const bad = await request(app).get('/api/wallet/send-passkey/nonce/nope');
    expect(bad.status).toBe(400);
  });

  it('is rate limited per IP no looser than the ed25519 send route', () => {
    const { transferLimiter } = require('../middleware/rateLimiting');
    const router = require('../server/routes/wallet-passkey-send-routes');
    expect(router.PASSKEY_SEND_LIMITER).toBe(transferLimiter);
  });
});
