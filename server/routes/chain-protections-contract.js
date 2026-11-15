/**
 * Account protections the chain enforces (core4, both unscheduled on chain 888
 * until the owner schedules them):
 *
 * - `security_key_spend`: "require my YubiKey to spend". Actions are a
 *   `SecurityKeyActionPayload` the node takes directly at
 *   POST /accounts/security-key/actions; spends add `security_key_auth`
 *   (a `SecurityKeyAssertionWire`) to POST /transactions/submit.
 * - `send_allowlist`: the browser signs a `SignedSendAllowlistAction`; the node
 *   takes it only inside a whole `Transaction` at
 *   POST /accounts/send-allowlist/submit. buildSendAllowlistTransaction wraps it
 *   exactly as the core4 CLI does (`wrfcoin send-allowlist`, tools/cli
 *   commands/send_allowlist.rs build_transaction). That transaction carries no
 *   signature of its own: the owner's ed25519 signature inside `data` is the
 *   only authorization, which mempool admission and block validation check.
 *   Pinned by contract-fixtures/send-allowlist-cli-vectors.json (artifacts the
 *   core4 CLI wrote).
 *
 * Signatures are verified by core4 (it knows the chain id). Here: shapes,
 * sizes, and that the owner key derives to the account, so a malformed body
 * never costs the node a verification.
 */
const { createHash } = require('crypto');

const MAX_ACTION_BODY_BYTES = 32 * 1024; // both node routes' JSON limit
const MAX_ALLOWLIST_DATA_BYTES = 16 * 1024; // MAX_SEND_ALLOWLIST_PAYLOAD_BYTES
const MAX_ALLOWED_ADDRESSES = 64;
const MAX_SECURITY_KEY_ASSERTIONS = 2;
const MAX_CREDENTIAL_ID_BYTES = 255;
const MAX_WEBAUTHN_FIELD_BYTES = 4096;
const MAX_DER_SIGNATURE_BYTES = 80;
const OUTPOINT_DOMAIN = Buffer.from('wrfcoin.send_allowlist.outpoint.v1');
const TX_HASH_TAG = Buffer.from('wrfcoin_tx_hash_v1');

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const isHexOf = (value, bytes) => typeof value === 'string' && value.length === bytes * 2 && /^[0-9a-fA-F]*$/.test(value);
/** Even-length hex of minBytes..maxBytes bytes. */
const isHexBetween = (value, minBytes, maxBytes) =>
  typeof value === 'string' && value.length % 2 === 0 && value.length >= minBytes * 2
  && value.length <= maxBytes * 2 && /^[0-9a-fA-F]*$/.test(value);
const isU64 = (value) => Number.isSafeInteger(value) && value >= 0;
const isPlainObject = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (message) => ({ ok: false, message });

function bodyTooLarge(body) {
  return Buffer.byteLength(JSON.stringify(body ?? null)) > MAX_ACTION_BODY_BYTES;
}

/** core4 Address::from_public_key: 0x + hex(SHA3-256(pubkey)[..20]). */
function ed25519Address(publicKeyHex) {
  return `0x${createHash('sha3-256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 40)}`;
}

/** core4 serde Address (a JSON array of 20 bytes) → lowercase 0x address, or null. */
function byteArrayToAddress(value) {
  if (!Array.isArray(value) || value.length !== 20 || !value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    return null;
  }
  return `0x${Buffer.from(value).toString('hex')}`;
}

// ---------------------------------------------------------------------------------------------------
// security_key_spend
// ---------------------------------------------------------------------------------------------------

/** `SecurityKeyAssertionWire`, validated; returned with exactly its four fields, values unchanged. */
function parseSecurityKeyAssertion(raw, label = 'security_key_auth') {
  if (!isPlainObject(raw)) return fail(`${label} must be an object`);
  if (!isHexOf(raw.public_key_p256, 64)) return fail(`${label}.public_key_p256 must be 64 bytes of hex (X || Y)`);
  // authenticator data is at least rpIdHash(32) + flags(1) + signCount(4).
  if (!isHexBetween(raw.authenticator_data, 37, MAX_WEBAUTHN_FIELD_BYTES)) {
    return fail(`${label}.authenticator_data must be 37-${MAX_WEBAUTHN_FIELD_BYTES} bytes of hex`);
  }
  if (!isHexBetween(raw.client_data_json, 1, MAX_WEBAUTHN_FIELD_BYTES)) {
    return fail(`${label}.client_data_json must be 1-${MAX_WEBAUTHN_FIELD_BYTES} bytes of hex`);
  }
  if (!isHexBetween(raw.signature, 8, MAX_DER_SIGNATURE_BYTES)) {
    return fail(`${label}.signature must be a DER signature in hex (at most ${MAX_DER_SIGNATURE_BYTES} bytes)`);
  }
  return {
    ok: true,
    value: {
      public_key_p256: raw.public_key_p256,
      authenticator_data: raw.authenticator_data,
      client_data_json: raw.client_data_json,
      signature: raw.signature,
    },
  };
}

function parseSecurityKeyWire(raw) {
  if (!isPlainObject(raw)) return fail('action.key must be an object');
  if (!isHexOf(raw.public_key_p256, 64)) return fail('action.key.public_key_p256 must be 64 bytes of hex');
  if (!isHexOf(raw.rp_id_hash, 32)) return fail('action.key.rp_id_hash must be 32 bytes of hex');
  if (!isHexBetween(raw.credential_id, 1, MAX_CREDENTIAL_ID_BYTES)) {
    return fail(`action.key.credential_id must be 1-${MAX_CREDENTIAL_ID_BYTES} bytes of hex`);
  }
  return { ok: true, value: { public_key_p256: raw.public_key_p256, rp_id_hash: raw.rp_id_hash, credential_id: raw.credential_id } };
}

/** serde `#[serde(tag = "kind", rename_all = "snake_case")] SecurityKeyActionBody`. */
function parseSecurityKeyActionBody(raw) {
  if (!isPlainObject(raw)) return fail('action must be an object');
  switch (raw.kind) {
  case 'enable': {
    const key = parseSecurityKeyWire(raw.key);
    if (!key.ok) return key;
    if (!isU64(raw.escape_delay_blocks)) return fail('action.escape_delay_blocks must be a non-negative integer');
    return { ok: true, value: { kind: 'enable', key: key.value, escape_delay_blocks: raw.escape_delay_blocks } };
  }
  case 'add_key': {
    const key = parseSecurityKeyWire(raw.key);
    return key.ok ? { ok: true, value: { kind: 'add_key', key: key.value } } : key;
  }
  case 'remove_key':
    if (!isHexOf(raw.public_key_p256, 64)) return fail('action.public_key_p256 must be 64 bytes of hex');
    return { ok: true, value: { kind: 'remove_key', public_key_p256: raw.public_key_p256 } };
  case 'disable':
  case 'begin_escape':
  case 'cancel_escape':
    return { ok: true, value: { kind: raw.kind } };
  default:
    return fail('action.kind must be one of enable, add_key, remove_key, disable, begin_escape, cancel_escape');
  }
}

/**
 * `SecurityKeyActionPayload` for POST /accounts/security-key/actions.
 * Returns { ok, account, kind, value } with value rebuilt from the known fields only.
 */
function parseSecurityKeyActionPayload(body) {
  if (!isPlainObject(body)) return fail('body must be a JSON object');
  if (!ADDRESS.test(body.account ?? '')) return fail('account must be a 0x + 40 hex address');
  if (!isU64(body.nonce)) return fail('nonce must be a non-negative integer');
  const action = parseSecurityKeyActionBody(body.action);
  if (!action.ok) return action;
  if (!isHexOf(body.owner_public_key, 32)) return fail('owner_public_key must be a 32-byte ed25519 public key in hex');
  if (!isHexOf(body.owner_signature, 64)) return fail('owner_signature must be a 64-byte ed25519 signature in hex');
  const account = body.account.toLowerCase();
  if (ed25519Address(body.owner_public_key) !== account) return fail('owner_public_key does not derive to account');
  const rawAssertions = body.key_assertions ?? [];
  if (!Array.isArray(rawAssertions) || rawAssertions.length > MAX_SECURITY_KEY_ASSERTIONS) {
    return fail(`key_assertions must be a list of at most ${MAX_SECURITY_KEY_ASSERTIONS}`);
  }
  const keyAssertions = [];
  for (const [i, raw] of rawAssertions.entries()) {
    const parsed = parseSecurityKeyAssertion(raw, `key_assertions[${i}]`);
    if (!parsed.ok) return parsed;
    keyAssertions.push(parsed.value);
  }
  return {
    ok: true,
    account,
    kind: action.value.kind,
    value: {
      account: body.account,
      nonce: body.nonce,
      action: action.value,
      owner_public_key: body.owner_public_key,
      owner_signature: body.owner_signature,
      key_assertions: keyAssertions,
    },
  };
}

// ---------------------------------------------------------------------------------------------------
// send_allowlist
// ---------------------------------------------------------------------------------------------------

function addressField(raw, label) {
  const address = byteArrayToAddress(raw);
  return address ? { ok: true, value: [...Buffer.from(address.slice(2), 'hex')] } : fail(`${label} must be a 20-byte array`);
}

/** serde externally tagged `SendAllowlistAction`. */
function parseSendAllowlistAction(raw) {
  if (raw === 'RequestDisable' || raw === 'CancelDisable') return { ok: true, value: raw, kind: raw };
  if (!isPlainObject(raw) || Object.keys(raw).length !== 1) {
    return fail('action must be exactly one of Enable, RequestAdd, CancelAdd, Remove, RaiseDelay, RequestDisable, CancelDisable');
  }
  const [kind] = Object.keys(raw);
  const inner = raw[kind];
  switch (kind) {
  case 'Enable': {
    if (!isPlainObject(inner) || !isU64(inner.add_delay_blocks)) return fail('Enable.add_delay_blocks must be a non-negative integer');
    if (!Array.isArray(inner.allowed) || inner.allowed.length > MAX_ALLOWED_ADDRESSES) {
      return fail(`Enable.allowed must list at most ${MAX_ALLOWED_ADDRESSES} addresses`);
    }
    const allowed = [];
    for (const [i, a] of inner.allowed.entries()) {
      const parsed = addressField(a, `Enable.allowed[${i}]`);
      if (!parsed.ok) return parsed;
      allowed.push(parsed.value);
    }
    return { ok: true, kind, value: { Enable: { add_delay_blocks: inner.add_delay_blocks, allowed } } };
  }
  case 'RequestAdd':
  case 'CancelAdd':
  case 'Remove': {
    const parsed = addressField(isPlainObject(inner) ? inner.address : undefined, `${kind}.address`);
    return parsed.ok ? { ok: true, kind, value: { [kind]: { address: parsed.value } } } : parsed;
  }
  case 'RaiseDelay':
    if (!isPlainObject(inner) || !isU64(inner.add_delay_blocks)) return fail('RaiseDelay.add_delay_blocks must be a non-negative integer');
    return { ok: true, kind, value: { RaiseDelay: { add_delay_blocks: inner.add_delay_blocks } } };
  default:
    return fail('action must be exactly one of Enable, RequestAdd, CancelAdd, Remove, RaiseDelay, RequestDisable, CancelDisable');
  }
}

/**
 * `SignedSendAllowlistAction` as the browser posts it. Returns { ok, account, kind, value }
 * with value rebuilt in serde's field order (the exact JSON serde_json::to_string writes).
 */
function parseSignedSendAllowlistAction(body) {
  if (!isPlainObject(body)) return fail('body must be a JSON object');
  const account = byteArrayToAddress(body.account);
  if (!account) return fail('account must be a 20-byte array');
  const action = parseSendAllowlistAction(body.action);
  if (!action.ok) return action;
  if (!isU64(body.action_nonce)) return fail('action_nonce must be a non-negative integer');
  if (!isHexOf(body.public_key, 32)) return fail('public_key must be a 32-byte ed25519 public key in hex');
  if (!isHexOf(body.signature, 64)) return fail('signature must be a 64-byte ed25519 signature in hex');
  if (ed25519Address(body.public_key) !== account) return fail('public_key does not derive to account');
  return {
    ok: true,
    account,
    kind: action.kind,
    value: {
      account: [...Buffer.from(account.slice(2), 'hex')],
      action: action.value,
      action_nonce: body.action_nonce,
      public_key: body.public_key,
      signature: body.signature,
    },
  };
}

function u32le(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}
function u64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(BigInt(n));
  return b;
}
function i64le(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
}
const sha3 = (buf) => createHash('sha3-256').update(buf).digest();
const hashJson = (bytes) => ({ hash_type: 'Sha3', bytes: [...bytes] });
function lenStr(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32le(bytes.length), bytes]);
}
function optionalStr(value) {
  return value === null || value === undefined ? Buffer.from([0]) : Buffer.concat([Buffer.from([1]), lenStr(value)]);
}

/** core4 `Transaction::calculate_hash` for the fields a SendAllowlist transaction uses. */
function calculateTransactionHash(tx, timestampMillis) {
  const parts = [TX_HASH_TAG, lenStr(tx.tx_type), u32le(tx.version), i64le(timestampMillis), u64le(tx.inputs.length)];
  for (const input of tx.inputs) {
    parts.push(Buffer.from(input.txid.bytes), u32le(input.vout), optionalStr(input.signature),
      optionalStr(input.public_key), optionalStr(input.coinbase_data));
  }
  parts.push(u64le(tx.outputs.length));
  for (const output of tx.outputs) {
    if (output.nft_data !== null) throw new Error('nft_data is not used by SendAllowlist transactions');
    parts.push(u64le(output.amount), lenStr(output.address), lenStr(output.script), Buffer.from([0]));
  }
  if (tx.lock_time !== null) throw new Error('lock_time is not used by SendAllowlist transactions');
  parts.push(optionalStr(tx.data), Buffer.from([0]), u64le(tx.fee), u64le(tx.nonce));
  return sha3(Buffer.concat(parts));
}

/** chrono's serde form of a whole-second DateTime<Utc>: RFC 3339 with no fraction. */
function rfc3339Seconds(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().replace('.000Z', 'Z');
}

/**
 * The `Transaction` JSON core4's POST /accounts/send-allowlist/submit takes, built exactly as
 * the CLI's build_transaction: one outpoint per (account, nonce) so two actions for the same
 * nonce conflict in the mempool, a zero OP_TRUE output to the account, tx nonce = action nonce,
 * `data` = the signed action's JSON, id = calculate_hash. `signed` is a parsed value from
 * parseSignedSendAllowlistAction.
 */
function buildSendAllowlistTransaction(signed, submittedAtSeconds) {
  if (!Number.isSafeInteger(submittedAtSeconds) || submittedAtSeconds < 0) throw new Error('submittedAtSeconds must be unix seconds');
  const accountBytes = Buffer.from(signed.account);
  const account = `0x${accountBytes.toString('hex')}`;
  const data = JSON.stringify(signed);
  if (Buffer.byteLength(data) > MAX_ALLOWLIST_DATA_BYTES) throw new Error('signed action is too large');
  const outpoint = sha3(Buffer.concat([OUTPOINT_DOMAIN, accountBytes, u64le(signed.action_nonce)]));
  const tx = {
    id: null,
    tx_type: 'SendAllowlist',
    version: 1,
    timestamp: rfc3339Seconds(submittedAtSeconds),
    inputs: [{ txid: hashJson(outpoint), vout: 0, signature: null, public_key: signed.public_key, coinbase_data: null }],
    outputs: [{ amount: 0, address: account, script: 'OP_TRUE', nft_data: null }],
    data,
    lock_time: null,
    fee: 0,
    sender_address: [...accountBytes],
    recipient_address: null,
    amount: 0,
    operation: { Transfer: { amount: 0 } },
    nonce: signed.action_nonce,
  };
  const id = calculateTransactionHash(tx, submittedAtSeconds * 1000);
  return { ...tx, id: hashJson(id), txId: id.toString('hex') };
}

/** The wire body (no helper fields). */
function sendAllowlistTransactionBody(built) {
  const { txId: _txId, ...tx } = built;
  return tx;
}

module.exports = {
  MAX_ACTION_BODY_BYTES,
  bodyTooLarge,
  buildSendAllowlistTransaction,
  calculateTransactionHash,
  parseSecurityKeyActionPayload,
  parseSecurityKeyAssertion,
  parseSignedSendAllowlistAction,
  sendAllowlistTransactionBody,
};
