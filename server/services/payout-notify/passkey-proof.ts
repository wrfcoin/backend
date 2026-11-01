/**
 * Passkey-signed payout-notification requests (owner approval 2026-11-01).
 *
 * A passkey wallet has no ed25519 key, so it cannot get the wallet-login JWT that subscribing needs. It
 * proves control of its address the way a passkey transfer does (core4 shared-protocol/src/accounts/
 * passkey.rs, docs/security/PASSKEY_P256_AUTH.md): the address is self-certifying, derived from the
 * credential's P-256 key and RP ID hash, and a WebAuthn assertion signs a challenge bound to the request.
 *
 *   message   = "wrfcoin_passkey_payout_notify_v1"
 *             ‖ u32le(len chain_id) ‖ chain_id ‖ u32le(len network) ‖ network
 *             ‖ u32le(len address) ‖ address ‖ u32le(len action) ‖ action
 *             ‖ u32le(len channel) ‖ channel ‖ u32le(len target_hash) ‖ target_hash
 *             ‖ u32le(len nonce) ‖ nonce ‖ u64le(expires_at_unix_seconds)
 *   challenge = SHA3-256(message)                          → navigator.credentials.get
 *
 * Strings are UTF-8: chain_id is decimal ("888"), address lowercase 0x hex, action "subscribe" or
 * "unsubscribe", channel "webpush" or "ntfy", target_hash the lowercase sha256 hex of the push endpoint
 * or ntfy topic (the same hash the subscription table keys on), nonce the server-issued hex. The same
 * framing as the transfer message under its own tag, so a notification assertion is never a transfer
 * authorization and the reverse.
 *
 * The verifier follows core4's verify_webauthn step for step: clientDataJSON type webauthn.get and the
 * challenge; rpIdHash in authenticatorData equal to the credential's; user present AND user verified;
 * ECDSA-P256-SHA256 over authenticatorData ‖ SHA-256(clientDataJSON), low-s only. Replay is stopped by
 * the nonce: issued by the server for one address, expiring after five minutes, and consumed once.
 * Nothing about the assertion or the credential is stored or logged.
 */
import crypto from 'node:crypto';

export const PASSKEY_NOTIFY_DOMAIN = 'wrfcoin_passkey_payout_notify_v1';
export const PASSKEY_ADDRESS_DOMAIN = 'wrfcoin.passkey_address.v1';
export const PASSKEY_NOTIFY_ACTIONS = ['subscribe', 'unsubscribe'] as const;
export type PasskeyNotifyAction = typeof PASSKEY_NOTIFY_ACTIONS[number];
export const NONCE_TTL_SEC = 300;
/** Outstanding challenges one address may hold per TTL window. */
export const NONCE_ISSUANCE_LIMIT = 8;
/** core4 MAX_WEBAUTHN_FIELD_LEN. */
const MAX_FIELD_BYTES = 4096;
const P256_N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const NONCE_RE = /^[0-9a-f]{64}$/;

export interface PasskeyAuth {
  public_key_p256: string;
  rp_id_hash: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
}

export interface PasskeyNotifyFields {
  chainId: string;
  network: string;
  address: string;
  action: PasskeyNotifyAction;
  channel: 'webpush' | 'ntfy';
  targetHash: string;
  nonce: string;
  expiresAtSec: number;
}

/** The signing chain and network: chain 888 testnet unless the operator says otherwise. */
export function passkeyNotifyChain(env: Record<string, string | undefined> = process.env): { chainId: string; network: string } {
  const chainId = (env.PAYOUT_NOTIFY_PASSKEY_CHAIN_ID ?? '').trim();
  const network = (env.PAYOUT_NOTIFY_PASSKEY_NETWORK ?? '').trim();
  return {
    chainId: /^[1-9][0-9]{0,9}$/.test(chainId) ? chainId : '888',
    network: /^[A-Za-z0-9._-]{1,64}$/.test(network) ? network : 'testnet',
  };
}

const sha3 = (data: Buffer) => crypto.createHash('sha3-256').update(data).digest();
const sha256 = (data: Buffer) => crypto.createHash('sha256').update(data).digest();

function framed(value: string): Buffer {
  const bytes = Buffer.from(value, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length);
  return Buffer.concat([len, bytes]);
}

export function passkeyNotifyMessage(f: PasskeyNotifyFields): Buffer {
  const expires = Buffer.alloc(8);
  expires.writeBigUInt64LE(BigInt(f.expiresAtSec));
  return Buffer.concat([
    Buffer.from(PASSKEY_NOTIFY_DOMAIN, 'utf8'),
    framed(f.chainId), framed(f.network), framed(f.address), framed(f.action), framed(f.channel),
    framed(f.targetHash), framed(f.nonce), expires,
  ]);
}

export const passkeyNotifyChallenge = (f: PasskeyNotifyFields): Buffer => sha3(passkeyNotifyMessage(f));

/** `0x` + hex(SHA3-256(domain ‖ rp_id_hash ‖ 0x04 ‖ X ‖ Y)[..20]), as core4 derives a passkey account. */
export function passkeyAddress(rpIdHash: Buffer, publicKeyXY: Buffer): string {
  return `0x${sha3(Buffer.concat([Buffer.from(PASSKEY_ADDRESS_DOMAIN, 'utf8'), rpIdHash, Buffer.of(0x04), publicKeyXY])).subarray(0, 20).toString('hex')}`;
}

const FIXED = { public_key_p256: 64, rp_id_hash: 32 } as const;
const VARIABLE = ['authenticator_data', 'client_data_json', 'signature'] as const;

/** Shape and size only (as the passkey send route checks). A string says what is wrong. */
export function parsePasskeyAuth(value: unknown): PasskeyAuth | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'passkey_auth must be an object';
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (!(key in FIXED) && !(VARIABLE as readonly string[]).includes(key)) return `passkey_auth has an unknown member: ${key.slice(0, 32)}`;
  }
  for (const [key, bytes] of Object.entries(FIXED)) {
    const hex = v[key];
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]*$/.test(hex) || hex.length !== bytes * 2) return `passkey_auth.${key} must be ${bytes} bytes of hex`;
  }
  for (const key of VARIABLE) {
    const hex = v[key];
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0 || hex.length > MAX_FIELD_BYTES * 2) {
      return `passkey_auth.${key} must be non-empty even-length hex of at most ${MAX_FIELD_BYTES} bytes`;
    }
  }
  return {
    public_key_p256: (v.public_key_p256 as string).toLowerCase(), rp_id_hash: (v.rp_id_hash as string).toLowerCase(),
    authenticator_data: v.authenticator_data as string, client_data_json: v.client_data_json as string, signature: v.signature as string,
  };
}

/** The address the credential in `auth` controls. */
export const passkeyAuthAddress = (auth: PasskeyAuth): string =>
  passkeyAddress(Buffer.from(auth.rp_id_hash, 'hex'), Buffer.from(auth.public_key_p256, 'hex'));

/** Strict DER ECDSA-Sig-Value → [r, s], or null. */
function parseDerSignature(der: Buffer): [bigint, bigint] | null {
  if (der.length < 8 || der[0] !== 0x30 || der[1] !== der.length - 2) return null;
  const ints: bigint[] = [];
  let at = 2;
  for (let i = 0; i < 2; i++) {
    if (der[at] !== 0x02) return null;
    const len = der[at + 1];
    if (len === undefined || len === 0 || len > 33 || at + 2 + len > der.length) return null;
    const body = der.subarray(at + 2, at + 2 + len);
    // Minimal encoding: no superfluous leading zero, never negative.
    if (body[0] & 0x80) return null;
    if (len > 1 && body[0] === 0 && !(body[1] & 0x80)) return null;
    ints.push(BigInt(`0x${body.toString('hex')}`));
    at += 2 + len;
  }
  return at === der.length ? [ints[0], ints[1]] : null;
}

export type AssertionRefusal =
  | 'CLIENT_DATA_INVALID' | 'WRONG_CEREMONY' | 'CHALLENGE_MISMATCH' | 'AUTHENTICATOR_DATA_INVALID'
  | 'RP_ID_MISMATCH' | 'USER_NOT_PRESENT' | 'USER_NOT_VERIFIED' | 'SIGNATURE_INVALID';

/** core4 verify_webauthn (consensus policy: user verification required). null when the assertion holds. */
export function verifyPasskeyAssertion(auth: PasskeyAuth, challenge: Buffer): AssertionRefusal | null {
  const clientData = Buffer.from(auth.client_data_json, 'hex');
  let parsed: any;
  try { parsed = JSON.parse(clientData.toString('utf8')); } catch { return 'CLIENT_DATA_INVALID'; }
  if (!parsed || typeof parsed !== 'object' || typeof parsed.type !== 'string' || typeof parsed.challenge !== 'string') return 'CLIENT_DATA_INVALID';
  if (parsed.type !== 'webauthn.get') return 'WRONG_CEREMONY';
  if (parsed.challenge !== challenge.toString('base64url')) return 'CHALLENGE_MISMATCH';
  const authData = Buffer.from(auth.authenticator_data, 'hex');
  if (authData.length < 37) return 'AUTHENTICATOR_DATA_INVALID';
  if (!authData.subarray(0, 32).equals(Buffer.from(auth.rp_id_hash, 'hex'))) return 'RP_ID_MISMATCH';
  const flags = authData[32];
  if (!(flags & 0x01)) return 'USER_NOT_PRESENT';
  if (!(flags & 0x04)) return 'USER_NOT_VERIFIED';
  const signature = Buffer.from(auth.signature, 'hex');
  const rs = parseDerSignature(signature);
  if (!rs) return 'SIGNATURE_INVALID';
  const [r, s] = rs;
  if (r === 0n || s === 0n || r >= P256_N || s >= P256_N || s > P256_N / 2n) return 'SIGNATURE_INVALID';
  try {
    const xy = Buffer.from(auth.public_key_p256, 'hex');
    const key = crypto.createPublicKey({
      key: { kty: 'EC', crv: 'P-256', x: xy.subarray(0, 32).toString('base64url'), y: xy.subarray(32).toString('base64url') },
      format: 'jwk',
    });
    const signed = Buffer.concat([authData, sha256(clientData)]);
    return crypto.verify('sha256', signed, { key, dsaEncoding: 'der' }, signature) ? null : 'SIGNATURE_INVALID';
  } catch {
    // Not a point on the curve, or otherwise unusable.
    return 'SIGNATURE_INVALID';
  }
}

export const newNonce = (): string => crypto.randomBytes(32).toString('hex');
export const isNonce = (value: unknown): value is string => typeof value === 'string' && NONCE_RE.test(value);

/**
 * Single-use challenge nonces, shared by every backend process (Redis in production).
 *   issue:   remember `nonce` for `address` until `expiresAtSec`; false when the address is over its limit.
 *   peek:    the expiry stored for an unexpired (address, nonce), or null.
 *   consume: delete it; true only for the one caller that removed it.
 */
export interface NonceStore {
  issue(address: string, nonce: string, expiresAtSec: number): Promise<boolean>;
  peek(address: string, nonce: string): Promise<number | null>;
  consume(address: string, nonce: string): Promise<boolean>;
}

const ISSUE = `-- payout_notify_passkey_nonce_v1
local used = tonumber(redis.call('GET', KEYS[1]) or '0')
if used >= tonumber(ARGV[1]) then return 0 end
if used == 0 then redis.call('SET', KEYS[1], 1, 'EX', ARGV[2]) else redis.call('INCR', KEYS[1]) end
redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[2])
return 1`;

interface RedisLike {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}

export function createRedisNonceStore(getRedis: () => RedisLike | Promise<RedisLike>, now: () => number = Date.now): NonceStore {
  const bucket = (address: string) => `payout-notify:passkey:v1:{${address}}`;
  const key = (address: string, nonce: string) => `${bucket(address)}:nonce:${nonce}`;
  return {
    async issue(address, nonce, expiresAtSec) {
      const ttl = Math.max(1, expiresAtSec - Math.floor(now() / 1000));
      const result = await (await getRedis()).eval(ISSUE, 2, `${bucket(address)}:issued`, key(address, nonce), NONCE_ISSUANCE_LIMIT, ttl, String(expiresAtSec));
      return Number(result) === 1;
    },
    async peek(address, nonce) {
      const raw = await (await getRedis()).get(key(address, nonce));
      const expires = raw === null ? NaN : Number(raw);
      return Number.isSafeInteger(expires) && expires * 1000 > now() ? expires : null;
    },
    async consume(address, nonce) {
      return (await (await getRedis()).del(key(address, nonce))) === 1;
    },
  };
}

/** One process only (tests, a single dev server). */
export function createMemoryNonceStore(now: () => number = Date.now): NonceStore {
  const nonces = new Map<string, number>();
  const issued = new Map<string, { count: number; until: number }>();
  const k = (address: string, nonce: string) => `${address}:${nonce}`;
  return {
    async issue(address, nonce, expiresAtSec) {
      const at = now();
      const bucket = issued.get(address);
      if (bucket && bucket.until > at && bucket.count >= NONCE_ISSUANCE_LIMIT) return false;
      if (!bucket || bucket.until <= at) issued.set(address, { count: 1, until: expiresAtSec * 1000 });
      else bucket.count += 1;
      nonces.set(k(address, nonce), expiresAtSec);
      return true;
    },
    async peek(address, nonce) {
      const expires = nonces.get(k(address, nonce));
      return expires !== undefined && expires * 1000 > now() ? expires : null;
    },
    async consume(address, nonce) {
      return nonces.delete(k(address, nonce));
    },
  };
}
