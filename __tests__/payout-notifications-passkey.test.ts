/**
 * Passkey-signed payout-notification subscribe/unsubscribe (owner approval 2026-11-01). A real P-256
 * authenticator is simulated with node:crypto: its address is derived the way core4 derives a passkey
 * account, and each request carries a WebAuthn assertion over the bound challenge.
 */
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createPayoutNotificationRouter } from '../server/routes/payout-notification-routes.js';
import { targetHash } from '../server/services/payout-notify/channels.js';
import {
  NONCE_ISSUANCE_LIMIT, NONCE_TTL_SEC, createMemoryNonceStore, passkeyAddress, passkeyNotifyChallenge, passkeyNotifyMessage,
  verifyPasskeyAssertion, type PasskeyAuth, type PasskeyNotifyFields,
} from '../server/services/payout-notify/passkey-proof.js';

const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest();
const RP_HASH = sha256(Buffer.from('wrfcoin.com'));
const TOPIC = 'wrf-payouts-7f3a9c11';
const FCM = 'https://fcm.googleapis.com/fcm/send/abc123';
const P256DH = 'B' + 'A'.repeat(86);
const AUTH = 'abcdefghijklmnopqrstuv';

function derInt(v: bigint): Buffer {
  let hex = v.toString(16); if (hex.length % 2) hex = `0${hex}`;
  let b = Buffer.from(hex, 'hex'); if (b[0] & 0x80) b = Buffer.concat([Buffer.of(0), b]);
  return Buffer.concat([Buffer.of(0x02, b.length), b]);
}
function readDer(der: Buffer): [bigint, bigint] {
  const rl = der[3]; const r = BigInt(`0x${der.subarray(4, 4 + rl).toString('hex')}`);
  const sl = der[5 + rl]; const s = BigInt(`0x${der.subarray(6 + rl, 6 + rl + sl).toString('hex')}`);
  return [r, s];
}
const encodeDer = (r: bigint, s: bigint) => { const body = Buffer.concat([derInt(r), derInt(s)]); return Buffer.concat([Buffer.of(0x30, body.length), body]); };

class Authenticator {
  readonly priv: crypto.KeyObject; readonly xy: Buffer; readonly address: string;
  constructor() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.priv = privateKey;
    this.xy = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    this.address = passkeyAddress(RP_HASH, this.xy);
  }
  sign(challenge: Buffer, opts: { flags?: number; highS?: boolean; type?: string; signer?: Authenticator } = {}): PasskeyAuth {
    const authData = Buffer.concat([RP_HASH, Buffer.of(opts.flags ?? 0x05), Buffer.alloc(4)]);
    const clientData = Buffer.from(JSON.stringify({ type: opts.type ?? 'webauthn.get', challenge: challenge.toString('base64url'), origin: 'https://wrfcoin.com', crossOrigin: false }));
    const raw = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), { key: (opts.signer ?? this).priv, dsaEncoding: 'der' });
    const [r, s] = readDer(raw);
    const low = s > P256_N / 2n ? P256_N - s : s;
    return {
      public_key_p256: this.xy.toString('hex'), rp_id_hash: RP_HASH.toString('hex'),
      authenticator_data: authData.toString('hex'), client_data_json: clientData.toString('hex'),
      signature: encodeDer(r, opts.highS ? P256_N - low : low).toString('hex'),
    };
  }
}

/** Minimal stand-in for the subscription table. */
function fakePool() {
  const rows: Array<{ id: string; address: string; channel: string; target: string; target_hash: string }> = [];
  const client = {
    release() {},
    async query(sql: string, params: any[]) {
      if (sql.startsWith('SELECT count')) {
        const [a, ch, h] = params;
        return { rows: [{ mine: rows.filter(r => r.address === a).length, total: rows.length, existing: rows.filter(r => r.address === a && r.channel === ch && r.target_hash === h).length }] };
      }
      if (sql.startsWith('INSERT')) {
        const [address, channel, target, target_hash] = params;
        let row = rows.find(r => r.address === address && r.channel === channel && r.target_hash === target_hash);
        if (!row) { row = { id: crypto.randomUUID(), address, channel, target, target_hash }; rows.push(row); }
        return { rows: [{ ...row, created_at: new Date(0), last_delivered_at: null }] };
      }
      if (sql.startsWith('DELETE')) {
        const [address, channel, h] = params;
        const gone = rows.filter(r => r.address === address && r.channel === channel && r.target_hash === h);
        for (const g of gone) rows.splice(rows.indexOf(g), 1);
        return { rows: gone.map(g => ({ id: g.id })) };
      }
      throw new Error(`unexpected sql ${sql}`);
    },
  };
  return { rows, pool: { connect: async () => client } as any };
}

const FLAGS = ['PAYOUT_NOTIFY_ENABLED', 'WEB_PUSH_VAPID_PUBLIC_KEY', 'WEB_PUSH_VAPID_PRIVATE_KEY', 'PAYOUT_NOTIFY_NTFY_SERVER', 'PAYOUT_NOTIFY_PASSKEY_CHAIN_ID', 'PAYOUT_NOTIFY_PASSKEY_NETWORK'];
const saved: Record<string, string | undefined> = Object.fromEntries(FLAGS.map(k => [k, process.env[k]]));
afterAll(() => { for (const k of FLAGS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

let clock = 1_800_000_000_000;
let db: ReturnType<typeof fakePool>;
let app: express.Express;
beforeEach(() => {
  process.env.PAYOUT_NOTIFY_ENABLED = 'true';
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = 'B' + 'x'.repeat(86);
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = 'y'.repeat(43);
  delete process.env.PAYOUT_NOTIFY_NTFY_SERVER; delete process.env.PAYOUT_NOTIFY_PASSKEY_CHAIN_ID; delete process.env.PAYOUT_NOTIFY_PASSKEY_NETWORK;
  clock = 1_800_000_000_000;
  db = fakePool();
  app = express();
  app.use('/api/notifications', createPayoutNotificationRouter({ rateLimit: null, pool: db.pool, now: () => clock, nonceStore: createMemoryNonceStore(() => clock) }));
});

async function challengeFor(address: string) {
  const r = await request(app).post('/api/notifications/passkey/challenge').send({ address });
  expect(r.status).toBe(201);
  return r.body as { nonce: string; expiresAt: number; chainId: string; network: string; domain: string };
}
const fields = (c: { nonce: string; expiresAt: number }, address: string, action: 'subscribe' | 'unsubscribe', channel: 'ntfy' | 'webpush', hash: string): PasskeyNotifyFields =>
  ({ chainId: '888', network: 'testnet', address, action, channel, targetHash: hash, nonce: c.nonce, expiresAtSec: c.expiresAt });

async function signedNtfy(key: Authenticator, opts: Parameters<Authenticator['sign']>[1] = {}, topic = TOPIC, address = key.address) {
  const c = await challengeFor(address);
  return { address, channel: 'ntfy', topic, nonce: c.nonce, passkey_auth: key.sign(passkeyNotifyChallenge(fields(c, address, 'subscribe', 'ntfy', targetHash(topic))), opts) };
}

describe('the signed message', () => {
  test('bytes are pinned (the frontend builds the same challenge)', () => {
    const f: PasskeyNotifyFields = {
      chainId: '888', network: 'testnet', address: `0x${'ab'.repeat(20)}`, action: 'subscribe', channel: 'ntfy',
      targetHash: targetHash(TOPIC), nonce: '01'.repeat(32), expiresAtSec: 1_800_000_300,
    };
    const msg = passkeyNotifyMessage(f);
    expect(msg.subarray(0, 32).toString()).toBe('wrfcoin_passkey_payout_notify_v1');
    expect(msg.subarray(32, 39).toString('hex')).toBe('03000000383838');
    expect(msg.readBigUInt64LE(msg.length - 8)).toBe(1_800_000_300n);
    expect(passkeyNotifyChallenge(f).toString('hex')).toBe('8a03d3ee0b3d001ea3f8d67b5cc9eb823520b6218597b4f02a3aadfa84995aad');
  });
  test('every bound field changes the challenge', () => {
    const base = fields({ nonce: '02'.repeat(32), expiresAt: 1 }, `0x${'cd'.repeat(20)}`, 'subscribe', 'ntfy', targetHash(TOPIC));
    const h = passkeyNotifyChallenge(base).toString('hex');
    for (const change of [{ chainId: '777' }, { network: 'mainnet' }, { address: `0x${'ce'.repeat(20)}` }, { action: 'unsubscribe' as const },
      { channel: 'webpush' as const }, { targetHash: targetHash('other-topic-123') }, { nonce: '03'.repeat(32) }, { expiresAtSec: 2 }]) {
      expect(passkeyNotifyChallenge({ ...base, ...change }).toString('hex')).not.toBe(h);
    }
  });
  test('verifier: user verification required, low-s only, ceremony type, right key', () => {
    const k = new Authenticator(); const other = new Authenticator();
    const ch = crypto.randomBytes(32);
    expect(verifyPasskeyAssertion(k.sign(ch), ch)).toBeNull();
    expect(verifyPasskeyAssertion(k.sign(ch, { flags: 0x01 }), ch)).toBe('USER_NOT_VERIFIED');
    expect(verifyPasskeyAssertion(k.sign(ch, { flags: 0x04 }), ch)).toBe('USER_NOT_PRESENT');
    expect(verifyPasskeyAssertion(k.sign(ch, { highS: true }), ch)).toBe('SIGNATURE_INVALID');
    expect(verifyPasskeyAssertion(k.sign(ch, { type: 'webauthn.create' }), ch)).toBe('WRONG_CEREMONY');
    expect(verifyPasskeyAssertion(k.sign(ch, { signer: other }), ch)).toBe('SIGNATURE_INVALID');
    expect(verifyPasskeyAssertion(k.sign(ch), crypto.randomBytes(32))).toBe('CHALLENGE_MISMATCH');
    expect(verifyPasskeyAssertion({ ...k.sign(ch), rp_id_hash: sha256(Buffer.from('evil.example')).toString('hex') }, ch)).toBe('RP_ID_MISMATCH');
  });
});

describe('passkey subscribe', () => {
  test('a valid assertion subscribes the passkey address (ntfy), no login', async () => {
    const k = new Authenticator();
    const r = await request(app).post('/api/notifications/passkey/subscriptions').send(await signedNtfy(k));
    expect(r.status).toBe(201);
    expect(r.body.subscription).toMatchObject({ address: k.address, channel: 'ntfy', label: TOPIC, targetHash: targetHash(TOPIC) });
    expect(db.rows).toHaveLength(1);
  });

  test('a valid assertion subscribes a browser push endpoint, keyed by the endpoint hash', async () => {
    const k = new Authenticator();
    const c = await challengeFor(k.address);
    const body = { address: k.address, channel: 'webpush', subscription: { endpoint: FCM, keys: { p256dh: P256DH, auth: AUTH } }, nonce: c.nonce,
      passkey_auth: k.sign(passkeyNotifyChallenge(fields(c, k.address, 'subscribe', 'webpush', targetHash(FCM)))) };
    const r = await request(app).post('/api/notifications/passkey/subscriptions').send(body);
    expect(r.status).toBe(201);
    expect(r.body.subscription).toMatchObject({ channel: 'webpush', label: 'fcm.googleapis.com', targetHash: targetHash(FCM) });
  });

  test('wrong credential: a signature from another key over this key\'s credential is refused', async () => {
    const k = new Authenticator(); const thief = new Authenticator();
    const r = await request(app).post('/api/notifications/passkey/subscriptions').send(await signedNtfy(k, { signer: thief }));
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('PASSKEY_ASSERTION_INVALID');
    expect(db.rows).toHaveLength(0);
  });

  test('wrong address: a valid passkey cannot subscribe an address it does not derive', async () => {
    const k = new Authenticator(); const victim = new Authenticator();
    const r = await request(app).post('/api/notifications/passkey/subscriptions').send(await signedNtfy(k, {}, TOPIC, victim.address));
    expect(r.status).toBe(403); expect(r.body.error.code).toBe('PASSKEY_ADDRESS_MISMATCH');
    expect(db.rows).toHaveLength(0);
  });

  test('replayed nonce: the same signed request works once', async () => {
    const k = new Authenticator();
    const body = await signedNtfy(k);
    expect((await request(app).post('/api/notifications/passkey/subscriptions').send(body)).status).toBe(201);
    const again = await request(app).post('/api/notifications/passkey/subscriptions').send(body);
    expect(again.status).toBe(401); expect(again.body.error.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
  });

  test('a nonce made up by the client, or one past its five minutes, is refused', async () => {
    const k = new Authenticator();
    const forged = { ...(await signedNtfy(k)), nonce: 'ff'.repeat(32) };
    expect((await request(app).post('/api/notifications/passkey/subscriptions').send(forged)).body.error.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
    const late = await signedNtfy(k);
    clock += (NONCE_TTL_SEC + 1) * 1000;
    const r = await request(app).post('/api/notifications/passkey/subscriptions').send(late);
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('PASSKEY_CHALLENGE_EXPIRED');
  });

  test('the signature is bound to the target: signed for one topic, sent with another', async () => {
    const k = new Authenticator();
    const body = { ...(await signedNtfy(k)), topic: 'attacker-topic-123456' };
    const r = await request(app).post('/api/notifications/passkey/subscriptions').send(body);
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('PASSKEY_ASSERTION_INVALID');
    expect(db.rows).toHaveLength(0);
  });

  test('a failed signature does not burn the open challenge', async () => {
    const k = new Authenticator(); const thief = new Authenticator();
    const good = await signedNtfy(k);
    const bad = { ...good, passkey_auth: { ...good.passkey_auth, signature: k.sign(crypto.randomBytes(32), { signer: thief }).signature } };
    expect((await request(app).post('/api/notifications/passkey/subscriptions').send(bad)).status).toBe(401);
    expect((await request(app).post('/api/notifications/passkey/subscriptions').send(good)).status).toBe(201);
  });

  test('without user verification the request is refused', async () => {
    const k = new Authenticator();
    const r = await request(app).post('/api/notifications/passkey/subscriptions').send(await signedNtfy(k, { flags: 0x01 }));
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('PASSKEY_ASSERTION_INVALID');
  });

  test('bad shapes are 400; the flag off is 503; the challenge is limited per address', async () => {
    const k = new Authenticator();
    const body = await signedNtfy(k);
    expect((await request(app).post('/api/notifications/passkey/subscriptions').send({ ...body, passkey_auth: { ...body.passkey_auth, extra: '00' } })).status).toBe(400);
    expect((await request(app).post('/api/notifications/passkey/subscriptions').send({ ...body, nonce: 'xyz' })).status).toBe(400);
    expect((await request(app).post('/api/notifications/passkey/challenge').send({ address: 'nope' })).status).toBe(400);
    for (let i = 1; i < NONCE_ISSUANCE_LIMIT; i++) await challengeFor(k.address);
    const over = await request(app).post('/api/notifications/passkey/challenge').send({ address: k.address });
    expect(over.status).toBe(429); expect(over.body.error.code).toBe('TOO_MANY_CHALLENGES');
    process.env.PAYOUT_NOTIFY_ENABLED = 'false';
    expect((await request(app).post('/api/notifications/passkey/challenge').send({ address: k.address })).status).toBe(503);
    expect((await request(app).post('/api/notifications/passkey/subscriptions').send(body)).status).toBe(503);
  });

  test('the challenge names the chain and network the client must sign for', async () => {
    const k = new Authenticator();
    expect(await challengeFor(k.address)).toMatchObject({ domain: 'wrfcoin_passkey_payout_notify_v1', chainId: '888', network: 'testnet' });
    process.env.PAYOUT_NOTIFY_PASSKEY_CHAIN_ID = '889';
    expect((await challengeFor(k.address)).chainId).toBe('889');
  });
});

describe('passkey unsubscribe', () => {
  async function signedUnsub(k: Authenticator, hash = targetHash(TOPIC)) {
    const c = await challengeFor(k.address);
    return { address: k.address, channel: 'ntfy', targetHash: hash, nonce: c.nonce, passkey_auth: k.sign(passkeyNotifyChallenge(fields(c, k.address, 'unsubscribe', 'ntfy', hash))) };
  }

  test('removes the address\'s subscription with that target hash, once', async () => {
    const k = new Authenticator();
    expect((await request(app).post('/api/notifications/passkey/subscriptions').send(await signedNtfy(k))).status).toBe(201);
    const body = await signedUnsub(k);
    const r = await request(app).post('/api/notifications/passkey/unsubscribe').send(body);
    expect(r.status).toBe(200); expect(r.body.removed).toBe(1);
    expect(db.rows).toHaveLength(0);
    expect((await request(app).post('/api/notifications/passkey/unsubscribe').send(body)).status).toBe(401);
  });

  test('a subscribe signature is not an unsubscribe signature', async () => {
    const k = new Authenticator();
    expect((await request(app).post('/api/notifications/passkey/subscriptions').send(await signedNtfy(k))).status).toBe(201);
    const sub = await signedNtfy(k);
    const r = await request(app).post('/api/notifications/passkey/unsubscribe').send({ address: k.address, channel: 'ntfy', targetHash: targetHash(TOPIC), nonce: sub.nonce, passkey_auth: sub.passkey_auth });
    expect(r.status).toBe(401); expect(r.body.error.code).toBe('PASSKEY_ASSERTION_INVALID');
    expect(db.rows).toHaveLength(1);
  });

  test('another passkey cannot remove someone else\'s subscription', async () => {
    const k = new Authenticator(); const other = new Authenticator();
    expect((await request(app).post('/api/notifications/passkey/subscriptions').send(await signedNtfy(k))).status).toBe(201);
    const c = await challengeFor(k.address);
    const r = await request(app).post('/api/notifications/passkey/unsubscribe').send({ address: k.address, channel: 'ntfy', targetHash: targetHash(TOPIC), nonce: c.nonce,
      passkey_auth: other.sign(passkeyNotifyChallenge(fields(c, k.address, 'unsubscribe', 'ntfy', targetHash(TOPIC)))) });
    expect(r.status).toBe(403);
    expect(db.rows).toHaveLength(1);
  });
});
