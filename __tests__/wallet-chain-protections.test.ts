/**
 * Account protections relays (core4 security_key_spend + send_allowlist), behind
 * WALLET_CHAIN_PROTECTIONS_ENABLED (default off):
 *
 *   1. the send-allowlist wrapper rebuilds the core4 CLI's transaction byte for byte
 *      (contract-fixtures/send-allowlist-cli-vectors.json, written by `wrfcoin send-allowlist`),
 *      including the tx id;
 *   2. the four routes relay to a fake core4 with the right credential, owner-bound;
 *   3. bad input is a 400 before core4; the flag off is a 404 before auth;
 *   4. POST /api/wallet/send forwards security_key_auth unchanged next to the ed25519 signature.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { JWT_AUDIENCE, JWT_ISSUER } from '../server/auth/jwt-constants';

const contract = require('../server/routes/chain-protections-contract');
const { parseSignedTransfer } = require('../server/routes/wallet-transfer-contract');

const VECTORS = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../contract-fixtures/send-allowlist-cli-vectors.json'), 'utf8'),
);

const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const addressOf = (publicKeyHex: string) =>
  `0x${crypto.createHash('sha3-256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 40)}`;
function randomKey() {
  const key = crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, crypto.randomBytes(32)]), format: 'der', type: 'pkcs8' });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  return { publicKey, address: addressOf(publicKey), sign: (m: Buffer) => crypto.sign(null, m, key).toString('hex') };
}

const hex = (bytes: number, fill = 'ab') => fill.repeat(bytes);
const assertion = (over: Record<string, unknown> = {}) => ({
  public_key_p256: hex(64, '04'),
  authenticator_data: hex(37, '11'),
  client_data_json: Buffer.from('{"type":"webauthn.get"}').toString('hex'),
  signature: `3044${hex(68, '22')}`,
  ...over,
});

describe('send-allowlist wrapper = the core4 CLI build_transaction', () => {
  it.each(VECTORS.vectors.map((v: any) => [v.name, v]))('%s: transaction JSON and tx id are identical', (_name, v: any) => {
    const parsed = contract.parseSignedSendAllowlistAction(v.signed_action);
    expect(parsed.ok).toBe(true);
    const built = contract.buildSendAllowlistTransaction(parsed.value, v.submitted_at);
    expect(JSON.stringify(contract.sendAllowlistTransactionBody(built))).toBe(JSON.stringify(v.transaction));
    expect(built.txId).toBe(Buffer.from(v.transaction.id.bytes).toString('hex'));
    // `data` is exactly the string serde_json::to_string(&signed) wrote.
    expect(JSON.stringify(parsed.value)).toBe(v.transaction.data);
  });

  it('refuses a key that does not derive the account, bad hex, unknown actions and oversize lists', () => {
    const v = VECTORS.vectors[0].signed_action;
    const bad = (over: Record<string, unknown>) => contract.parseSignedSendAllowlistAction({ ...v, ...over });
    expect(bad({ public_key: randomKey().publicKey }).message).toMatch(/derive/);
    expect(bad({ signature: 'zz'.repeat(64) }).ok).toBe(false);
    expect(bad({ signature: 'ab'.repeat(63) }).ok).toBe(false);
    expect(bad({ account: [1, 2, 3] }).ok).toBe(false);
    expect(bad({ action_nonce: -1 }).ok).toBe(false);
    expect(bad({ action_nonce: 2 ** 53 }).ok).toBe(false);
    expect(bad({ action: 'Nope' }).ok).toBe(false);
    expect(bad({ action: { RequestAdd: { address: [1] } } }).ok).toBe(false);
    expect(bad({ action: { RequestAdd: { address: Array(20).fill(1) }, Remove: { address: Array(20).fill(1) } } }).ok).toBe(false);
    expect(bad({ action: { Enable: { add_delay_blocks: 2244, allowed: Array(65).fill(Array(20).fill(1)) } } }).ok).toBe(false);
  });
});

describe('security-key action and assertion shapes', () => {
  const owner = randomKey();
  const payload = (over: Record<string, unknown> = {}) => ({
    account: owner.address,
    nonce: 0,
    action: { kind: 'enable', key: { public_key_p256: hex(64, '04'), rp_id_hash: hex(32, 'cd'), credential_id: hex(16, 'ef') }, escape_delay_blocks: 7855 },
    owner_public_key: owner.publicKey,
    owner_signature: hex(64),
    key_assertions: [assertion()],
    ...over,
  });

  it('accepts every action kind and keeps the values unchanged', () => {
    const p = payload();
    expect(contract.parseSecurityKeyActionPayload(p)).toEqual({ ok: true, account: owner.address, kind: 'enable', value: p });
    for (const action of [{ kind: 'add_key', key: p.action.key }, { kind: 'remove_key', public_key_p256: hex(64, '04') },
      { kind: 'disable' }, { kind: 'begin_escape' }, { kind: 'cancel_escape' }]) {
      expect(contract.parseSecurityKeyActionPayload(payload({ action })).ok).toBe(true);
    }
    expect(contract.parseSecurityKeyActionPayload(payload({ key_assertions: undefined })).value.key_assertions).toEqual([]);
  });

  it('refuses malformed fields', () => {
    for (const over of [
      { account: 'nope' }, { nonce: '0' }, { nonce: -1 }, { action: { kind: 'steal' } }, { action: 'enable' },
      { action: { kind: 'enable', key: { public_key_p256: hex(63), rp_id_hash: hex(32), credential_id: hex(1) }, escape_delay_blocks: 1 } },
      { action: { kind: 'enable', key: { public_key_p256: hex(64), rp_id_hash: hex(32), credential_id: hex(256) }, escape_delay_blocks: 1 } },
      { action: { kind: 'remove_key', public_key_p256: 'xyz' } },
      { owner_public_key: randomKey().publicKey }, { owner_signature: hex(63) },
      { key_assertions: [assertion(), assertion(), assertion()] }, { key_assertions: [assertion({ signature: hex(81) })] },
      { key_assertions: [assertion({ authenticator_data: hex(36) })] }, { key_assertions: [assertion({ client_data_json: 'abc' })] },
    ]) expect(contract.parseSecurityKeyActionPayload(payload(over)).ok).toBe(false);
  });
});

describe('parseSignedTransfer: security_key_auth', () => {
  const owner = randomKey();
  const base = { from: owner.address, to: randomKey().address, amount: '5', nonce: '3', auth_pubkey: owner.publicKey, auth_signature: hex(64) };

  it('keeps it next to the ed25519 signature, unchanged', () => {
    const a = assertion();
    expect(parseSignedTransfer({ ...base, security_key_auth: a })).toEqual({
      ok: true,
      value: { from: base.from, to: base.to, amount: 5, nonce: '3', authPubkey: base.auth_pubkey, authSignature: base.auth_signature, securityKeyAuth: a },
    });
  });

  it('leaves a plain ed25519 transfer as it was, and refuses bad or mixed assertions', () => {
    expect(parseSignedTransfer(base).value).not.toHaveProperty('securityKeyAuth');
    expect(parseSignedTransfer({ ...base, security_key_auth: assertion({ public_key_p256: 'x' }) }).ok).toBe(false);
    expect(parseSignedTransfer({ ...base, security_key_auth: 'yes' }).ok).toBe(false);
    const { auth_pubkey: _p, auth_signature: _s, ...noEd } = base;
    expect(parseSignedTransfer({ ...noEd, session_key_auth: { session_public_key: hex(32), signature: hex(64) }, security_key_auth: assertion() }).ok).toBe(false);
  });
});

// ---- routes against a fake core4 -------------------------------------------------------------------

const TOKENS = { contributor: 'cp-contributor-token', reader: 'cp-reader-token' };
interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: any }

function startFakeCore4(state: { featureActive: boolean }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? JSON.parse(raw) : undefined;
      const u = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? '', path: u.pathname, headers: req.headers, body });
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      const err = (status: number, code: string, message: string) => send(status, { ok: false, error: { code, message } });
      const role = (r: keyof typeof TOKENS) => (bearer === TOKENS[r] ? true : (err(403, 'FORBIDDEN', 'Invalid API token'), false));
      let m;
      if (req.method === 'GET' && (m = u.pathname.match(/^\/accounts\/(0x[0-9a-f]{40})\/security-key$/))) {
        return send(200, { ok: true, data: { address: m[1], next_height: 501, feature_active_at_next_height: state.featureActive,
          next_nonce: 0, generation: 0, required_to_spend: false, keys: [], escape_delay_blocks: null, pending_escape: null, escape_matured: false } });
      }
      if (req.method === 'GET' && (m = u.pathname.match(/^\/accounts\/(0x[0-9a-f]{40})\/send-allowlist$/))) {
        if (!role('reader')) return undefined;
        return send(200, { ok: true, data: { feature_active_next_height: state.featureActive, observed_at_height: 500,
          allowlist: { account: m[1], next_action_nonce: 0, in_force: false, at_height: 501, allowed: [], pending_additions: [] } } });
      }
      if (req.method === 'POST' && u.pathname === '/accounts/security-key/actions') {
        if (!role('contributor')) return undefined;
        if (!state.featureActive) return err(503, 'FEATURE_NOT_ACTIVE', 'security_key_spend is not active at the next block height 501');
        return send(202, { ok: true, data: { accepted: true, tx_id: 'tx-security-key', tx_type: 'SecurityKeyAction' } });
      }
      if (req.method === 'POST' && u.pathname === '/accounts/send-allowlist/submit') {
        if (!role('contributor')) return undefined;
        if (!state.featureActive) return err(503, 'FEATURE_NOT_ACTIVE', 'send_allowlist is not active at the next height');
        if (body?.tx_type !== 'SendAllowlist') return err(400, 'SEND_ALLOWLIST_PAYLOAD', 'not a SendAllowlist transaction');
        return send(202, { ok: true, data: { tx_id: Buffer.from(body.id.bytes).toString('hex'), admitted: true, included: false } });
      }
      if (req.method === 'POST' && u.pathname === '/transactions/submit') {
        if (!role('contributor')) return undefined;
        return send(202, { ok: true, data: { accepted: true, tx_id: 'tx-send' } });
      }
      return err(404, 'NOT_FOUND', 'no such route in the fake');
    });
  });
  return new Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, seen, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

describe('protection routes (fake core4)', () => {
  const JWT_SECRET = 'chain-protections-test-jwt-secret-0123456789abcdef';
  const envKeys = ['CORE4_API_URL', 'JWT_SECRET', 'WRFCOIN_CONTRIBUTOR_TOKEN', 'WRFCOIN_READER_TOKEN', 'WALLET_CHAIN_PROTECTIONS_ENABLED'];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  const state = { featureActive: true };
  const owner = randomKey();
  const other = randomKey();
  const vector = VECTORS.vectors.find((v: any) => v.name === 'add');
  const vectorAccount = `0x${Buffer.from(vector.signed_action.account).toString('hex')}`;
  let core4: Awaited<ReturnType<typeof startFakeCore4>>;
  let app: express.Express;
  const bearer = (address: string) => ({
    Authorization: `Bearer ${jwt.sign({ sub: address, address, role: 'wallet', type: 'access' }, JWT_SECRET,
      { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 600 })}`,
  });
  const last = (p: string) => core4.seen.filter((s) => s.path === p).pop()!;
  const hits = () => core4.seen.length;
  const skPayload = (over: Record<string, unknown> = {}) => ({
    account: owner.address,
    nonce: 0,
    action: { kind: 'cancel_escape' },
    owner_public_key: owner.publicKey,
    owner_signature: owner.sign(Buffer.from('not checked by the backend')),
    key_assertions: [assertion()],
    ...over,
  });

  beforeAll(async () => {
    core4 = await startFakeCore4(state);
    Object.assign(process.env, {
      CORE4_API_URL: core4.url,
      JWT_SECRET,
      WRFCOIN_CONTRIBUTOR_TOKEN: TOKENS.contributor,
      WRFCOIN_READER_TOKEN: TOKENS.reader,
    });
    const walletRoutes = require('../server/routes/wallet-routes');
    app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/wallet', walletRoutes.default ?? walletRoutes);
  });

  beforeEach(() => {
    state.featureActive = true;
    process.env.WALLET_CHAIN_PROTECTIONS_ENABLED = 'true';
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await core4?.close();
  });

  it('flag off (unset or not exactly "true"): all four routes are 404 to a logged-in caller and core4 is never called', async () => {
    for (const value of [undefined, 'false', 'TRUE', '1']) {
      if (value === undefined) delete process.env.WALLET_CHAIN_PROTECTIONS_ENABLED;
      else process.env.WALLET_CHAIN_PROTECTIONS_ENABLED = value;
      const n = hits();
      for (const r of [
        request(app).get(`/api/wallet/${owner.address}/security-key`).set(bearer(owner.address)),
        request(app).get(`/api/wallet/${owner.address}/send-allowlist`).set(bearer(owner.address)),
        request(app).post('/api/wallet/security-key/actions').set(bearer(owner.address)).send(skPayload()),
        request(app).post('/api/wallet/send-allowlist/actions').set(bearer(vectorAccount)).send(vector.signed_action),
      ]) expect((await r).status).toBe(404);
      // Anonymous callers get the same 401 as every wallet route (the H11 ratchet sees auth-required).
      for (const r of [
        request(app).get(`/api/wallet/${owner.address}/security-key`),
        request(app).post('/api/wallet/send-allowlist/actions').send(vector.signed_action),
      ]) expect((await r).status).toBe(401);
      expect(hits()).toBe(n);
    }
  });

  it('GET security-key relays the public node read, owner-bound', async () => {
    const res = await request(app).get(`/api/wallet/${owner.address.toUpperCase().replace('0X', '0x')}/security-key`).set(bearer(owner.address));
    expect(res.status).toBe(200);
    expect(res.body.data.feature_active_at_next_height).toBe(true);
    expect(last(`/accounts/${owner.address}/security-key`).method).toBe('GET');
    expect((await request(app).get(`/api/wallet/${other.address}/security-key`).set(bearer(owner.address))).status).toBe(403);
    expect((await request(app).get(`/api/wallet/${owner.address}/security-key`)).status).toBe(401);
    expect((await request(app).get('/api/wallet/0x1234/security-key').set(bearer(owner.address))).status).toBe(400);
  });

  it('GET send-allowlist relays with the Reader token (never the caller JWT), owner-bound', async () => {
    const res = await request(app).get(`/api/wallet/${owner.address}/send-allowlist`).set(bearer(owner.address));
    expect(res.status).toBe(200);
    expect(res.body.data.feature_active_next_height).toBe(true);
    expect(last(`/accounts/${owner.address}/send-allowlist`).headers.authorization).toBe(`Bearer ${TOKENS.reader}`);
    expect((await request(app).get(`/api/wallet/${other.address}/send-allowlist`).set(bearer(owner.address))).status).toBe(403);
    expect((await request(app).get('/api/wallet/not-an-address/send-allowlist').set(bearer(owner.address))).status).toBe(400);
  });

  it('GET send-allowlist is 503 without a configured Reader token', async () => {
    const saved = process.env.WRFCOIN_READER_TOKEN;
    delete process.env.WRFCOIN_READER_TOKEN;
    try {
      const res = await request(app).get(`/api/wallet/${owner.address}/send-allowlist`).set(bearer(owner.address));
      expect([res.status, res.body.error.code]).toEqual([503, 'CORE4_READER_CREDENTIAL_UNCONFIGURED']);
    } finally {
      process.env.WRFCOIN_READER_TOKEN = saved;
    }
  });

  it('POST security-key/actions relays the payload exactly, with the Contributor token', async () => {
    const b = skPayload();
    const res = await request(app).post('/api/wallet/security-key/actions').set(bearer(owner.address)).send(b);
    expect([res.status, res.body]).toEqual([202, { hash: 'tx-security-key', action: 'cancel_escape', status: 'submitted', settled: false }]);
    const relayed = last('/accounts/security-key/actions');
    expect(relayed.body).toEqual(b);
    expect(relayed.headers.authorization).toBe(`Bearer ${TOKENS.contributor}`);
  });

  it('POST security-key/actions: bad input 400, another account 403, oversize 413, all before core4; 503 passes through', async () => {
    const n = hits();
    const post = (b: unknown) => request(app).post('/api/wallet/security-key/actions').set(bearer(owner.address)).send(b as object);
    expect((await post(skPayload({ owner_signature: 'nope' }))).status).toBe(400);
    expect((await post(skPayload({ action: { kind: 'drain' } }))).status).toBe(400);
    expect((await post([])).status).toBe(400);
    expect((await post(skPayload({ account: other.address }))).status).toBe(400); // key does not derive it
    expect((await post(skPayload({ key_assertions: [assertion({ client_data_json: 'ab'.repeat(20_000) })] }))).status).toBe(413);
    const otherPayload = { ...skPayload(), account: other.address, owner_public_key: other.publicKey };
    expect((await post(otherPayload)).status).toBe(403);
    expect(hits()).toBe(n);
    state.featureActive = false;
    const off = await post(skPayload());
    expect([off.status, off.body.error.code]).toEqual([503, 'FEATURE_NOT_ACTIVE']);
  });

  it('POST send-allowlist/actions wraps the signed action into the CLI transaction and submits it', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(vector.submitted_at * 1000);
    try {
      const res = await request(app).post('/api/wallet/send-allowlist/actions').set(bearer(vectorAccount)).send(vector.signed_action);
      const txId = Buffer.from(vector.transaction.id.bytes).toString('hex');
      expect([res.status, res.body]).toEqual([202, { hash: txId, action: 'RequestAdd', status: 'submitted', settled: false }]);
      const relayed = last('/accounts/send-allowlist/submit');
      expect(relayed.body).toEqual(vector.transaction);
      expect(relayed.headers.authorization).toBe(`Bearer ${TOKENS.contributor}`);
    } finally {
      now.mockRestore();
    }
  });

  it('POST send-allowlist/actions: bad input 400 and another account 403 before core4; 503 passes through', async () => {
    const n = hits();
    const post = (b: unknown, who = vectorAccount) => request(app).post('/api/wallet/send-allowlist/actions').set(bearer(who)).send(b as object);
    expect((await post({ ...vector.signed_action, signature: 'x' })).status).toBe(400);
    expect((await post({ ...vector.signed_action, action: { Steal: {} } })).status).toBe(400);
    expect((await post({ ...vector.signed_action, public_key: owner.publicKey })).status).toBe(400);
    expect((await post(vector.signed_action, owner.address)).status).toBe(403);
    expect(hits()).toBe(n);
    state.featureActive = false;
    const off = await post(vector.signed_action);
    expect([off.status, off.body.error.code]).toEqual([503, 'FEATURE_NOT_ACTIVE']);
  });

  it('POST /send forwards security_key_auth unchanged with the ed25519 signature (flag on or off)', async () => {
    for (const flag of ['true', 'false']) {
      process.env.WALLET_CHAIN_PROTECTIONS_ENABLED = flag;
      const a = assertion({ public_key_p256: 'AB'.repeat(64) });
      const b = { from: owner.address, to: other.address, amount: '7', nonce: '2', auth_pubkey: owner.publicKey, auth_signature: hex(64), security_key_auth: a };
      const res = await request(app).post('/api/wallet/send').set(bearer(owner.address)).send(b);
      expect(res.status).toBe(202);
      expect(last('/transactions/submit').body).toEqual({
        from: owner.address, to: other.address, amount: 7, nonce: '2',
        transparent_opt_out: true, transparent_opt_out_reason: 'first-party wallet',
        auth_pubkey: owner.publicKey, auth_signature: hex(64), security_key_auth: a,
      });
    }
    const n = hits();
    const bad = { from: owner.address, to: other.address, amount: '7', nonce: '2', auth_pubkey: owner.publicKey, auth_signature: hex(64), security_key_auth: { public_key_p256: 'x' } };
    expect((await request(app).post('/api/wallet/send').set(bearer(owner.address)).send(bad)).status).toBe(400);
    expect(hits()).toBe(n);
  });
});
