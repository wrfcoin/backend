import { attachWalletNonceIssuer, walletNonceChallengeKey } from '../helpers/wallet-nonce-redis';
/**
 * Passkey wallet login (owner decision 2026-11-09, design 2026-11-09-passkey-station-owner-design.md
 * Phase 1). A P-256 WebAuthn passkey signs SHA3-256 of the framed login message; the JWT sub is the
 * passkey address (core4 passkey_account_address). Off unless enabled. A real authenticator is
 * simulated with node:crypto.
 */
import { describe, expect, it, jest } from '@jest/globals';
import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../server/utils/logger.js', () => ({ appLogger: mockLogger, logger: mockLogger }));

const {
  createWalletAuthService,
  buildPasskeyWalletLoginMessage,
  passkeyWalletLoginChallenge,
  PASSKEY_WALLET_LOGIN_DOMAIN,
} = require('../../server/routes/wallet-auth-service');
const { passkeyAddress } = require('../../server/services/passkey/webauthn');

const JWT_SECRET = 'passkey-wallet-login-test-secret-'.padEnd(64, 'x');
const ORIGIN = 'https://wrfcoin.com';
const CHAIN_ID = 888;
const NETWORK = 'testnet';
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest();
const RP_HASH = sha256(Buffer.from('wrfcoin.com'));

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

type SignOpts = { origin?: string; crossOrigin?: boolean; rpHash?: Buffer; flags?: number; signer?: Authenticator };

class Authenticator {
  readonly priv: crypto.KeyObject; readonly xy: Buffer; readonly address: string; readonly rpHash: Buffer;
  constructor(rpHash = RP_HASH) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    this.priv = privateKey;
    this.rpHash = rpHash;
    this.xy = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
    this.address = passkeyAddress(rpHash, this.xy);
  }
  sign(challengeB64url: string, opts: SignOpts = {}) {
    const rpHash = opts.rpHash ?? this.rpHash;
    const authData = Buffer.concat([rpHash, Buffer.of(opts.flags ?? 0x05), Buffer.alloc(4)]);
    const clientData = Buffer.from(JSON.stringify({
      type: 'webauthn.get', challenge: challengeB64url, origin: opts.origin ?? ORIGIN, crossOrigin: opts.crossOrigin ?? false,
    }));
    const raw = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), { key: (opts.signer ?? this).priv, dsaEncoding: 'der' });
    const [r, s] = readDer(raw);
    const low = s > P256_N / 2n ? P256_N - s : s;
    return {
      public_key_p256: this.xy.toString('hex'), rp_id_hash: rpHash.toString('hex'),
      authenticator_data: authData.toString('hex'), client_data_json: clientData.toString('hex'),
      signature: encodeDer(r, low).toString('hex'),
    };
  }
}

function makeRedis() {
  const store = new Map<string, string>();
  return attachWalletNonceIssuer({
    store,
    set: jest.fn(async (key: string, value: string) => { store.set(key, value); return 'OK'; }),
    get: jest.fn(async (key: string) => store.get(key) ?? null),
    del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
  });
}

function makeService(extra: Record<string, unknown> = { passkeyLoginEnabled: true }, redis = makeRedis()) {
  return {
    redis,
    service: createWalletAuthService({
      jwtSecret: JWT_SECRET,
      redis,
      db: { execute: jest.fn(async () => ({ rows: [] })) },
      walletAuthOrigin: ORIGIN,
      walletAuthChainId: CHAIN_ID,
      walletAuthNetwork: NETWORK,
      ...extra,
    }),
  };
}

async function login(service: any, key: Authenticator, opts: SignOpts = {}, address = key.address) {
  const challenge = await service.generateNonce(address, 'passkey');
  return service.walletLogin({ scheme: 'passkey', address, nonce: challenge.nonce, passkey_auth: key.sign(challenge.challenge, opts) });
}

const verifyJwt = (token: string): any => jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: 'wrfcoin-platform', audience: 'wrfcoin-api' });

describe('passkey wallet login', () => {
  it('is off by default: no nonce, no login', async () => {
    const { service } = makeService({});
    const key = new Authenticator();
    await expect(service.generateNonce(key.address, 'passkey')).rejects.toThrow('passkey login is not enabled');
    await expect(service.walletLogin({ scheme: 'passkey', address: key.address, nonce: 'n', passkey_auth: {} }))
      .rejects.toThrow('passkey login is not enabled');
  });

  it('happy path: the challenge is SHA3 of the framed message and the JWT sub is the passkey address', async () => {
    const { service } = makeService();
    const key = new Authenticator();
    const challenge = await service.generateNonce(key.address.toUpperCase().replace('0X', '0x'), 'passkey');
    const fields = {
      origin: ORIGIN, chainId: CHAIN_ID, network: NETWORK, address: key.address,
      nonce: challenge.nonce, issuedAt: challenge.issuedAt, expirationTime: challenge.expirationTime,
    };
    expect(challenge).toMatchObject({ scheme: 'passkey', network: NETWORK, chainId: CHAIN_ID, origin: ORIGIN });
    expect(challenge.message).toBe(buildPasskeyWalletLoginMessage(fields).toString('hex'));
    expect(Buffer.from(challenge.message, 'hex').subarray(0, PASSKEY_WALLET_LOGIN_DOMAIN.length).toString()).toBe(PASSKEY_WALLET_LOGIN_DOMAIN);
    expect(challenge.challenge).toBe(passkeyWalletLoginChallenge(fields).toString('base64url'));

    const tokens = await service.walletLogin({
      scheme: 'passkey', address: key.address, nonce: challenge.nonce, passkey_auth: key.sign(challenge.challenge),
    });
    const claims = verifyJwt(tokens.jwt);
    expect(claims.sub).toBe(key.address);
    expect(claims.address).toBe(key.address);
    expect(claims.wallet_scheme).toBe('passkey');
    expect(claims.role).toBe('wallet');
  });

  it('frames the message byte for byte as the frontend does (shared vector, frontend walletAuthService.passkey.test.ts)', () => {
    const fields = {
      origin: 'https://wrfcoin.com', chainId: 888, network: 'testnet', address: '0x1212121212121212121212121212121212121212',
      nonce: 'ab'.repeat(32), issuedAt: '2026-11-09T12:00:00.000Z', expirationTime: '2026-11-09T12:05:00.000Z',
    };
    expect(buildPasskeyWalletLoginMessage(fields).toString('hex')).toBe(
      '777266636f696e5f77616c6c65745f6c6f67696e5f706173736b65795f76311300000068747470733a2f2f777266636f696e2e636f6d0300000038383807000000746573746e65742a000000307831323132313231323132313231323132313231323132313231323132313231323132313231323132400000006162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616261626162616218000000323032362d31312d30395431323a30303a30302e3030305a18000000323032362d31312d30395431323a30353a30302e3030305a',
    );
    expect(passkeyWalletLoginChallenge(fields).toString('hex')).toBe('bf5daead2f05fee595873066a9175e24bfe5dd7f4265dcd440382388926a2080');
  });

  it('accepts the www origin by default', async () => {
    const { service } = makeService();
    const key = new Authenticator();
    await expect(login(service, key, { origin: 'https://www.wrfcoin.com' })).resolves.toHaveProperty('jwt');
  });

  it('refuses an origin outside the allowlist, without consuming the nonce', async () => {
    const { service, redis } = makeService();
    const key = new Authenticator();
    const challenge = await service.generateNonce(key.address, 'passkey');
    await expect(service.walletLogin({
      scheme: 'passkey', address: key.address, nonce: challenge.nonce,
      passkey_auth: key.sign(challenge.challenge, { origin: 'https://wrfcoin.com.example' }),
    })).rejects.toThrow('origin that is not allowed');
    expect(redis.store.has(walletNonceChallengeKey('passkey', key.address, challenge.nonce))).toBe(true);
  });

  it('refuses a cross-origin ceremony', async () => {
    const { service } = makeService();
    const key = new Authenticator();
    await expect(login(service, key, { crossOrigin: true })).rejects.toThrow('origin that is not allowed');
  });

  it('refuses a passkey of another RP ID (pinned to the auth origin host)', async () => {
    const { service } = makeService();
    const other = new Authenticator(sha256(Buffer.from('example.com')));
    await expect(login(service, other)).rejects.toThrow('different RP ID');
  });

  it('refuses a passkey that does not derive to the claimed address, and the owner nonce survives', async () => {
    const { service, redis } = makeService();
    const owner = new Authenticator();
    const attacker = new Authenticator();
    const challenge = await service.generateNonce(owner.address, 'passkey');
    await expect(service.walletLogin({
      scheme: 'passkey', address: owner.address, nonce: challenge.nonce, passkey_auth: attacker.sign(challenge.challenge),
    })).rejects.toThrow('address does not match the passkey');
    expect(redis.store.has(walletNonceChallengeKey('passkey', owner.address, challenge.nonce))).toBe(true);
  });

  it('refuses a signature by a different key over the right credential', async () => {
    const { service } = makeService();
    const owner = new Authenticator();
    await expect(login(service, owner, { signer: new Authenticator() })).rejects.toThrow('invalid wallet signature');
  });

  it('refuses an assertion without user verification', async () => {
    const { service } = makeService();
    await expect(login(service, new Authenticator(), { flags: 0x01 })).rejects.toThrow('invalid wallet signature');
  });

  it('a nonce is single use: replaying the same assertion fails', async () => {
    const { service } = makeService();
    const key = new Authenticator();
    const challenge = await service.generateNonce(key.address, 'passkey');
    const body = { scheme: 'passkey', address: key.address, nonce: challenge.nonce, passkey_auth: key.sign(challenge.challenge) };
    await service.walletLogin(body);
    await expect(service.walletLogin(body)).rejects.toThrow('nonce expired or not found');
  });

  it('an ed25519 nonce cannot be redeemed by a passkey login (scheme-keyed)', async () => {
    const { service } = makeService();
    const key = new Authenticator();
    const ed = await service.generateNonce(key.address, 'ed25519');
    await expect(service.walletLogin({
      scheme: 'passkey', address: key.address, nonce: ed.nonce, passkey_auth: key.sign(ed.nonce),
    })).rejects.toThrow('nonce expired or not found');
  });

  it('refresh keeps the passkey scheme, and stops once passkey login is switched off', async () => {
    const redis = makeRedis();
    const { service } = makeService({ passkeyLoginEnabled: true }, redis);
    const key = new Authenticator();
    const tokens = await login(service, key);
    const refreshed = await service.refresh({ refreshToken: tokens.refreshToken });
    expect(verifyJwt(refreshed.jwt).wallet_scheme).toBe('passkey');
    const { service: off } = makeService({}, redis);
    await expect(off.refresh({ refreshToken: refreshed.refreshToken })).rejects.toThrow('passkey login is not enabled');
  });

  it('refuses a configured origin outside the RP ID at startup', () => {
    expect(() => makeService({ passkeyLoginEnabled: true, passkeyAllowedOrigins: ['https://evil.example'] }))
      .toThrow('RP ID or a subdomain');
  });

  it('rejects a malformed passkey_auth before the nonce', async () => {
    const { service } = makeService();
    const key = new Authenticator();
    const challenge = await service.generateNonce(key.address, 'passkey');
    await expect(service.walletLogin({ scheme: 'passkey', address: key.address, nonce: challenge.nonce, passkey_auth: { x: 1 } }))
      .rejects.toThrow('passkey_auth');
  });
});
