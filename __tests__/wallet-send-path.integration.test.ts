import { attachWalletNonceIssuer } from './helpers/wallet-nonce-redis';
/**
 * Backend H15 (GO step 5, the owner's live wallet send): the signed transparent-transfer
 * path end to end, through the REAL wallet router, against an in-process FAKE core4 on
 * loopback that verifies everything INDEPENDENTLY of the backend's helpers.
 *
 *   wallet login (real wallet-auth service) -> GET /api/wallet/:address (new wallet: exists:false,
 *   balance '0') -> GET /api/wallet/:address/nonce -> a CLIENT-side signer (written here from the
 *   spec, like mobile's signed_transfer.dart) signs the base-unit transfer -> POST /api/wallet/send
 *   -> the backend relays to core4 /transactions/submit with the server Contributor token (never the
 *   user's JWT) and the exact body -> the fake core4 re-derives the address (SHA3-256), rebuilds the
 *   `wrfcoin_transparent_transfer_auth_v2` preimage itself and verifies the ed25519 signature ->
 *   the response shape the app reads.
 *
 * The fake's preimage builder and verifier are first checked against core4's own golden vector
 * (contract-fixtures/transparent-transfer-auth-vector.json, from shared-protocol's
 * signing_preimage_v2.json), so a wrong restatement here cannot make the chain agree with itself.
 * Every link is asserted; the mutation cases at the end prove a single wrong link (unit, case,
 * token, pubkey) is caught. No database is needed (the wallet router reads only core4).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';

// ---- independent crypto (deliberately NOT the backend's) ---------------------
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const sha3 = (b: Buffer) => crypto.createHash('sha3-256').update(b).digest('hex');
const addressOf = (publicKeyHex: string) => `0x${sha3(Buffer.from(publicKeyHex, 'hex')).slice(0, 40)}`;

function keypair(seed: string) {
  const key = crypto.createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, crypto.createHash('sha256').update(`h15:${seed}`).digest()]), format: 'der', type: 'pkcs8',
  });
  const spki = crypto.createPublicKey(key).export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKey = spki.subarray(spki.length - 32).toString('hex');
  return { publicKey, address: addressOf(publicKey), sign: (m: Buffer | string) => crypto.sign(null, Buffer.isBuffer(m) ? m : Buffer.from(m), key).toString('hex') };
}
function verifyEd25519(publicKeyHex: string, signatureHex: string, message: Buffer): boolean {
  try {
    const pub = crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, 'hex')]), format: 'der', type: 'spki' });
    return crypto.verify(null, message, pub, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const framed = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
/** core4 transparent_transfer_authorization_message_with_domain (shared-protocol transaction.rs), restated. */
function core4TransferPreimage(chain: string, network: string, from: string, to: string, amount: bigint, nonce: bigint): Buffer {
  return Buffer.concat([Buffer.from('wrfcoin_transparent_transfer_auth_v2'), framed(chain), framed(network), framed(from), framed(to), u64(amount), u64(nonce)]);
}

// ---- fake core4 ----------------------------------------------------------------
const CHAIN = '777';
const NETWORK = 'testnet';
const TOKENS = { contributor: 'h15-contributor-token', reader: 'h15-reader-token' };
interface Seen { method: string; path: string; headers: http.IncomingHttpHeaders; body: any }

function startFakeCore4() {
  const seen: Seen[] = [];
  const accounts = new Map<string, { balance: bigint; nonce: number }>();
  const settled: Array<{ from: string; to: string; amount: bigint; nonce: bigint }> = [];
  const replay = new Set<string>();
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: any;
      try { body = raw ? JSON.parse(raw) : undefined; } catch { body = undefined; }
      const u = new URL(req.url ?? '/', 'http://x');
      seen.push({ method: req.method ?? '', path: u.pathname, headers: req.headers, body });
      const bearer = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      const send = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
      const err = (status: number, code: string, message: string) => send(status, { ok: false, error: { code, message } });
      const needs = (role: keyof typeof TOKENS) => (bearer === TOKENS[role] ? true : (err(403, 'FORBIDDEN', 'Invalid API token'), false));

      if (req.method === 'GET' && u.pathname.startsWith('/addresses/')) {
        if (!needs('reader')) return;
        const address = decodeURIComponent(u.pathname.slice('/addresses/'.length));
        if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return err(400, 'VALIDATION_ERROR', 'address must be a valid hex address');
        const account = accounts.get(address.toLowerCase());
        if (!account) return err(404, 'NOT_FOUND', 'address not found'); // get_address_compat, core4 65134a64 chain.rs:118-125
        return send(200, { ok: true, data: {
          address, balance: account.balance.toString(), nonce: String(account.nonce), stake_required: '0', stake_locked: '0',
          spendable_balance: account.balance.toString(), earned_balance_total: '0',
        } });
      }
      if (req.method === 'POST' && u.pathname === '/transactions/submit') {
        // submit_transaction_compat, core4 65134a64 routes/transactions.rs:145-372
        if (!needs('contributor')) return;
        const from = String(body?.from ?? '').trim();
        const to = String(body?.to ?? '').trim();
        if (!from || !to || typeof body?.amount !== 'number' || !Number.isInteger(body.amount) || body.amount <= 0) {
          return err(400, 'VALIDATION_ERROR', 'from, to, and positive amount are required');
        }
        if (!/^0x[0-9a-fA-F]{40}$/.test(from) || !/^0x[0-9a-fA-F]{40}$/.test(to)) return err(400, 'VALIDATION_ERROR', 'from and to must be valid hex addresses');
        if (typeof body?.nonce !== 'string' || !/^\d{1,20}$/.test(body.nonce.trim())) return err(422, 'UNPROCESSABLE_ENTITY', 'nonce is required');
        if (body.transparent_opt_out !== true) return err(501, 'FEATURE_DISABLED', 'confidential transfers are disabled');
        if (!body.auth_pubkey || !body.auth_signature) return err(400, 'VALIDATION_ERROR', 'transparent transfers require auth_pubkey and auth_signature');
        const nonce = BigInt(body.nonce.trim());
        const preimage = core4TransferPreimage(CHAIN, NETWORK, from, to, BigInt(body.amount), nonce);
        const derived = /^[0-9a-fA-F]{64}$/.test(body.auth_pubkey) ? addressOf(body.auth_pubkey) : '';
        if (derived.toLowerCase() !== from.toLowerCase() || !verifyEd25519(body.auth_pubkey, body.auth_signature, preimage)) {
          return err(400, 'AUTHORIZATION_INVALID', 'auth_signature does not verify for auth_pubkey over from|to|amount|nonce, or auth_pubkey does not derive to from');
        }
        const key = `${from}:${nonce}`;
        if (replay.has(key)) return err(409, 'REPLAY', 'replay');
        const account = accounts.get(from.toLowerCase());
        if (!account || account.balance < BigInt(body.amount)) return err(400, 'TRANSACTION_REJECTED', 'insufficient balance');
        replay.add(key);
        account.balance -= BigInt(body.amount);
        account.nonce += 1;
        accounts.set(to.toLowerCase(), { balance: (accounts.get(to.toLowerCase())?.balance ?? 0n) + BigInt(body.amount), nonce: accounts.get(to.toLowerCase())?.nonce ?? 0 });
        settled.push({ from, to, amount: BigInt(body.amount), nonce });
        return send(202, { ok: true, data: { accepted: true, tx_id: 'tx-h15-0001', tx_type: 'Transfer', from, to, amount: String(body.amount), privacy_mode: 'transparent_opt_out', transparent_opt_out: true } });
      }
      return err(404, 'NOT_FOUND', 'unknown route');
    });
  });
  return new Promise<{ url: string; seen: Seen[]; accounts: typeof accounts; settled: typeof settled; close: () => Promise<void> }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, seen, accounts, settled, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

function fakeRedis() {
  const m = new Map<string, string>();
  return attachWalletNonceIssuer({ set: async (k: string, v: string) => { m.set(k, v); return 'OK'; }, get: async (k: string) => m.get(k) ?? null, del: async (k: string) => (m.delete(k) ? 1 : 0) });
}

describe('signed wallet send path against an independent fake core4 (H15)', () => {
  const alice = keypair('alice');
  const bob = keypair('bob');
  const mallory = keypair('mallory');
  const envKeys = ['CORE4_API_URL', 'JWT_SECRET', 'WRFCOIN_CHAIN_ID', 'WRFCOIN_NETWORK_ID', 'WRFCOIN_CONTRIBUTOR_TOKEN', 'WRFCOIN_READER_TOKEN'];
  const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  let core4: Awaited<ReturnType<typeof startFakeCore4>>;
  let app: express.Express;
  let jwt = '';
  const auth = () => ({ Authorization: `Bearer ${jwt}` });
  const submits = () => core4.seen.filter((s) => s.path === '/transactions/submit');

  /** What the phone does (mobile signed_transfer.dart): lowercase once, sign base units, post exactly what was signed. */
  function clientBody(o: { signer?: ReturnType<typeof keypair>; from?: string; to?: string; amount: bigint; nonce: string; signedAmount?: bigint; signedNonce?: string }) {
    const signer = o.signer ?? alice;
    const from = (o.from ?? alice.address).toLowerCase();
    const to = (o.to ?? bob.address).toLowerCase();
    const message = core4TransferPreimage(CHAIN, NETWORK, from, to, o.signedAmount ?? o.amount, BigInt(o.signedNonce ?? o.nonce));
    return { from, to, amount: o.amount.toString(), nonce: o.nonce, auth_pubkey: signer.publicKey, auth_signature: signer.sign(message) };
  }

  beforeAll(async () => {
    core4 = await startFakeCore4();
    Object.assign(process.env, {
      CORE4_API_URL: core4.url, JWT_SECRET: 'h15-wallet-send-path-jwt-secret-0123456789abcdef',
      WRFCOIN_CHAIN_ID: CHAIN, WRFCOIN_NETWORK_ID: NETWORK, WRFCOIN_CONTRIBUTOR_TOKEN: TOKENS.contributor, WRFCOIN_READER_TOKEN: TOKENS.reader,
    });
    /* eslint-disable @typescript-eslint/no-var-requires */
    const walletRoutes = require('../server/routes/wallet-routes');
    app = express();
    app.use(express.json());
    app.use('/api/wallet', walletRoutes.default ?? walletRoutes);
    const { createWalletAuthService } = await import('../server/routes/wallet-auth-service');
    const service = createWalletAuthService({ redis: fakeRedis() as any, db: { execute: async () => ({ rows: [] }) } as any });
    const challenge = await service.generateNonce(alice.address, 'ed25519');
    const tokens = await service.walletLogin({ address: alice.address, scheme: 'ed25519', pubkey: alice.publicKey, nonce: challenge.nonce, signature: alice.sign(challenge.message) } as any);
    jwt = tokens.jwt;
  });

  afterAll(async () => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await core4?.close();
  });

  it('the fake core4 itself reproduces core4\'s golden authorization vector (preimage bytes AND signature)', () => {
    const vector = JSON.parse(fs.readFileSync(path.join(__dirname, '../contract-fixtures/transparent-transfer-auth-vector.json'), 'utf8')).case;
    const preimage = core4TransferPreimage(vector.chain_id, vector.network_id, vector.from, vector.to, BigInt(vector.amount), BigInt(vector.nonce));
    expect(preimage.toString('hex')).toBe(vector.preimage_hex);
    expect(verifyEd25519(vector.signer_public_key_hex, vector.signature_hex, preimage)).toBe(true);
    // and it is sensitive: one flipped bit of the amount no longer verifies
    const other = core4TransferPreimage(vector.chain_id, vector.network_id, vector.from, vector.to, BigInt(vector.amount) + 1n, BigInt(vector.nonce));
    expect(verifyEd25519(vector.signer_public_key_hex, vector.signature_hex, other)).toBe(false);
  });

  it('1. a new wallet reads as exists:false with a zero balance (core4 404 "address not found" is not an error)', async () => {
    const res = await request(app).get(`/api/wallet/${alice.address}`).set(auth());
    expect(res.status).toBe(200);
    expect(res.body.exists).toBe(false);
    expect(String(res.body.balance)).toBe('0');
    const read = core4.seen.find((s) => s.path === `/addresses/${alice.address}`)!;
    expect(read.headers.authorization).toBe(`Bearer ${TOKENS.reader}`); // the Reader token, never the user's JWT
    expect(read.headers.authorization).not.toContain(jwt);
  });

  it('2. once funded (1.5 WRF = 150000000 base units) the wallet read and the nonce read return what the app parses', async () => {
    core4.accounts.set(alice.address, { balance: 150_000_000n, nonce: 7 });
    const info = await request(app).get(`/api/wallet/${alice.address}`).set(auth());
    expect(info.status).toBe(200);
    expect(JSON.stringify(info.body)).toContain('150000000');
    const nonce = await request(app).get(`/api/wallet/${alice.address}/nonce`).set(auth());
    expect(nonce.status).toBe(200);
    expect(nonce.body.nonce).toBe('7'); // mobile: /^\d+$/ on payload.nonce
  });

  it('3. a wallet cannot read another address (owner binding)', async () => {
    expect((await request(app).get(`/api/wallet/${bob.address}`).set(auth())).status).toBe(403);
    expect((await request(app).get(`/api/wallet/${bob.address}/nonce`).set(auth())).status).toBe(403);
  });

  it('4. the signed base-unit send is relayed with the server Contributor token and the exact body, and core4 settles it', async () => {
    const nonce = (await request(app).get(`/api/wallet/${alice.address}/nonce`).set(auth())).body.nonce as string;
    const body = clientBody({ amount: 100_000_000n, nonce }); // send exactly 1 WRF
    const res = await request(app).post('/api/wallet/send').set(auth()).send(body);
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ hash: 'tx-h15-0001', status: 'submitted', settled: false }); // what the app reads

    const relayed = submits()[0];
    expect(relayed.headers.authorization).toBe(`Bearer ${TOKENS.contributor}`);
    expect(JSON.stringify(relayed.headers)).not.toContain(jwt); // the user's JWT never reaches core4
    expect(relayed.body).toEqual({
      from: alice.address, to: bob.address, amount: 100000000, nonce: '7', // amount is a JSON integer of BASE units
      transparent_opt_out: true, transparent_opt_out_reason: 'first-party wallet',
      auth_pubkey: alice.publicKey, auth_signature: body.auth_signature,
    });
    // core4's own view after verifying its own preimage: the debit and credit are in base units
    expect(core4.settled).toEqual([{ from: alice.address, to: bob.address, amount: 100_000_000n, nonce: 7n }]);
    expect(core4.accounts.get(alice.address)).toEqual({ balance: 50_000_000n, nonce: 8 });
    expect(core4.accounts.get(bob.address)?.balance).toBe(100_000_000n);
  });

  describe('single-link mutations are caught (each would break a live send)', () => {
    const send = (body: object) => request(app).post('/api/wallet/send').set(auth()).send(body);
    const before = () => submits().length;

    it('signing DISPLAY WRF (1) but sending base units (100000000) is refused by core4: AUTHORIZATION_INVALID', async () => {
      const n = before();
      const res = await send(clientBody({ amount: 10_000_000n, nonce: '8', signedAmount: 1n }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AUTHORIZATION_INVALID');
      expect(submits().length).toBe(n + 1); // it reached core4 and core4 said no
    });

    it('a mixed-case address signed but posted lowercase (or the reverse) fails: from/to are hashed as strings', async () => {
      const upper = `0x${alice.address.slice(2).toUpperCase()}`;
      const message = core4TransferPreimage(CHAIN, NETWORK, upper, bob.address, 5n, 8n);
      const res = await send({ from: alice.address, to: bob.address, amount: '5', nonce: '8', auth_pubkey: alice.publicKey, auth_signature: alice.sign(message) });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AUTHORIZATION_INVALID');
    });

    it('a signature by a key that does not derive to `from` fails (SignerIsNotSender)', async () => {
      const res = await send(clientBody({ signer: mallory, amount: 5n, nonce: '8' }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AUTHORIZATION_INVALID');
    });

    it('signing one nonce and sending another fails', async () => {
      const res = await send(clientBody({ amount: 5n, nonce: '9', signedNonce: '8' }));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('AUTHORIZATION_INVALID');
    });

    it('a `from` other than the authenticated wallet is refused by the backend before core4 is called', async () => {
      const n = before();
      const res = await send(clientBody({ signer: bob, from: bob.address, to: alice.address, amount: 5n, nonce: '0' }));
      expect(res.status).toBe(403);
      expect(submits().length).toBe(n);
    });

    it('a fractional display amount is refused by the backend (400) and never reaches core4', async () => {
      const n = before();
      const res = await send({ ...clientBody({ amount: 5n, nonce: '8' }), amount: '1.00000000' });
      expect(res.status).toBe(400);
      expect(submits().length).toBe(n);
    });

    it('an unsigned send is refused (501 SIGNED_TRANSFER_REQUIRED shape) and never reaches core4', async () => {
      const n = before();
      const res = await send({ from: alice.address, to: bob.address, amount: '5' });
      expect(res.status).toBe(501);
      expect(submits().length).toBe(n);
    });

    it('a relay with the wrong core4 credential is refused: the fake rejects a JWT as core4 does', async () => {
      const saved = process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
      process.env.WRFCOIN_CONTRIBUTOR_TOKEN = 'not-the-contributor-token';
      try {
        const res = await send(clientBody({ amount: 5n, nonce: '8' }));
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.status).not.toBe(202);
      } finally {
        process.env.WRFCOIN_CONTRIBUTOR_TOKEN = saved;
      }
    });

    it('replaying the settled transfer is refused by core4 (same from:nonce)', async () => {
      const res = await send(clientBody({ amount: 100_000_000n, nonce: '7' }));
      expect(res.status).toBe(409);
    });
  });
});
