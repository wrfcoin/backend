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
import {
  createRedisNonceStore as createSharedRedisNonceStore, framed, sha3, type RedisLike, type NonceStore,
} from '../passkey/webauthn.js';

// The shared checks moved to services/passkey/webauthn.ts; re-exported so existing imports keep working.
export {
  PASSKEY_ADDRESS_DOMAIN, NONCE_TTL_SEC, NONCE_ISSUANCE_LIMIT, parsePasskeyAuth, passkeyAddress, passkeyAuthAddress,
  verifyPasskeyAssertion, newNonce, isNonce, createMemoryNonceStore,
  type PasskeyAuth, type AssertionRefusal, type NonceStore,
} from '../passkey/webauthn.js';

export const PASSKEY_NOTIFY_DOMAIN = 'wrfcoin_passkey_payout_notify_v1';
export const PASSKEY_NOTIFY_ACTIONS = ['subscribe', 'unsubscribe'] as const;
export type PasskeyNotifyAction = typeof PASSKEY_NOTIFY_ACTIONS[number];

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

/** Redis nonce store for payout-notification challenges (key space unchanged: `payout-notify:passkey:v1`). */
export function createRedisNonceStore(getRedis: () => RedisLike | Promise<RedisLike>, now: () => number = Date.now): NonceStore {
  return createSharedRedisNonceStore(getRedis, 'payout-notify:passkey:v1', now);
}
