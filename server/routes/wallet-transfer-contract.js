const { createHash } = require('crypto');

const U64_MAX = 18446744073709551615n;
const TRANSPARENT_TRANSFER_AUTH_DOMAIN = Buffer.from('wrfcoin_transparent_transfer_auth_v2');

const SIGNED_TRANSFER_CONTRACT = Object.freeze({
  fields: ['from', 'to', 'amount', 'nonce', 'auth_pubkey', 'auth_signature'],
  amount: Object.freeze({
    requestUnit: 'integer base units',
    core4Unit: 'integer base units',
    signedAs: 'u64 little-endian',
  }),
  keyScheme: 'ed25519',
  authorizationPreimage:
    'core4 TransparentTransferPayload::authorization_message(nonce); shared-protocol transaction.rs',
});

function isLaunchAddress(value) {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
}

/**
 * core4 chain address of an ed25519 public key:
 * 0x + hex(SHA3-256(pubkey)[..20]). SHA3-256 (FIPS 202), NOT Keccak-256.
 * Pinned by contract-fixtures/wallet-key-scheme-vector.json (core4#3234) and
 * matching shared-protocol Address::from_public_key, which authorize_debit
 * compares against a signed transfer's from.
 * Returns the lowercase address, or null when the key is not 32 bytes of hex.
 */
function ed25519PublicKeyToLaunchAddress(publicKeyHex) {
  if (typeof publicKeyHex !== 'string' || !/^[0-9a-fA-F]{64}$/.test(publicKeyHex)) {
    return null;
  }
  const digest = createHash('sha3-256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex');
  return `0x${digest.slice(0, 40)}`;
}

function parseBaseUnits(value) {
  const raw = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const units = BigInt(raw);
  return units <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(units) : null;
}

function u32le(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32LE(value);
  return out;
}

function u64le(value) {
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(BigInt(value));
  return out;
}

function framed(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32le(bytes.length), bytes]);
}

function transparentTransferMessage({ chainId, networkId, from, to, amount, nonce }) {
  return Buffer.concat([
    TRANSPARENT_TRANSFER_AUTH_DOMAIN,
    framed(chainId),
    framed(networkId),
    framed(from),
    framed(to),
    u64le(amount),
    u64le(nonce),
  ]);
}

function parseSignedTransfer(body = {}) {
  const from = body.from;
  const to = body.to;
  const authPubkey = body.authPubkey ?? body.auth_pubkey;
  const authSignature = body.authSignature ?? body.auth_signature;
  const missingSignature = !authPubkey || !authSignature || body.nonce === undefined;
  if (missingSignature) {
    return { ok: false, unsigned: true, code: 'SIGNED_TRANSFER_REQUIRED', message: 'unsigned transfers cannot settle; submit a client-signed transparent transfer (see SIGNED_TRANSFER_CONTRACT)' };
  }
  if (!isLaunchAddress(from) || !isLaunchAddress(to)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'from and to must be core4 hex addresses' };
  }
  const amount = parseBaseUnits(body.amount);
  if (amount === null) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'amount must be a positive integer number of base units and fit a JSON integer' };
  }
  const nonce = String(body.nonce);
  if (!/^\d{1,20}$/.test(nonce) || BigInt(nonce) > U64_MAX) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'nonce must be a decimal u64 string' };
  }
  if (!/^[0-9a-fA-F]{64}$/.test(authPubkey)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'auth_pubkey must be a 32-byte ed25519 public key in hex' };
  }
  if (!/^[0-9a-fA-F]{128}$/.test(authSignature)) {
    return { ok: false, code: 'VALIDATION_ERROR', message: 'auth_signature must be a 64-byte ed25519 signature in hex' };
  }
  return { ok: true, value: { from, to, amount, nonce, authPubkey, authSignature } };
}

module.exports = {
  SIGNED_TRANSFER_CONTRACT,
  ed25519PublicKeyToLaunchAddress,
  isLaunchAddress,
  parseBaseUnits,
  parseSignedTransfer,
  transparentTransferMessage,
};
