/**
 * Session keys with spending limits (core4 `accounts::session_keys`, feature
 * `session_keys`): the wire shapes the backend relays and the exact bytes each
 * party signs. Pinned byte-for-byte by
 * contract-fixtures/session-key-golden-vectors.json (core4 test
 * `wallet_client_golden_vectors`).
 *
 * A session key is a separate ed25519 key the owner registers with limits
 * (methods, recipients, per-send, per-window and lifetime value, validity
 * heights). It can sign small transfers and wallet logins; it never sees the
 * owner's recovery phrase.
 */
const { createHash } = require('crypto');

const SESSION_KEY_TRANSFER_AUTH_DOMAIN = Buffer.from(
  'wrfcoin_session_key_transfer_auth_v1',
);
const SESSION_KEY_REGISTER_DOMAIN = 'wrfcoin.session_key_register.v1';
const SESSION_KEY_REVOKE_DOMAIN = 'wrfcoin.session_key_revoke.v1';
/** Explicit "any recipient" target. An empty target list allows nothing. */
const ANY_TARGET = `0x${'ff'.repeat(20)}`;
const U64_MAX = 18446744073709551615n;
const U128_MAX = (1n << 128n) - 1n;
const MAX_METHODS = 16;
const MAX_TARGETS = 64;

const HEX32 = /^[0-9a-fA-F]{64}$/;
// Same rule as wallet-transfer-contract isLaunchAddress (kept local: that module requires this one).
const isLaunchAddress = (value) =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
const HEX64 = /^[0-9a-fA-F]{128}$/;

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

function u128le(value) {
  const v = BigInt(value);
  return Buffer.concat([u64le(v & U64_MAX), u64le(v >> 64n)]);
}

/** u32le(len) || utf8: the transfer preimage's framing. */
function framed32(value) {
  const bytes = Buffer.from(value, 'utf8');
  return Buffer.concat([u32le(bytes.length), bytes]);
}

/** u64le(len) || bytes: the register / revoke preimages' framing. */
function lp(bytes) {
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  return Buffer.concat([u64le(b.length), b]);
}

function addressBytes(address) {
  if (!isLaunchAddress(address))
    throw new Error('expected a 0x + 40 hex address');
  return Buffer.from(address.slice(2), 'hex');
}

/**
 * The bytes a session key signs to authorize a transparent transfer: the
 * transparent-transfer preimage under its own domain, with the 32-byte session
 * public key appended. from/to are the exact (lowercase) strings submitted.
 */
function sessionKeyTransferMessage({
  chainId,
  networkId,
  from,
  to,
  amount,
  nonce,
  sessionPublicKey,
}) {
  return Buffer.concat([
    SESSION_KEY_TRANSFER_AUTH_DOMAIN,
    framed32(chainId),
    framed32(networkId),
    framed32(from),
    framed32(to),
    u64le(amount),
    u64le(nonce),
    Buffer.from(sessionPublicKey, 'hex'),
  ]);
}

/**
 * Register preimage, signed by BOTH the owner's primary key and the session
 * key. `grant` uses hex addresses here; see registerActionBody for the wire.
 */
function sessionKeyRegisterMessage({
  chainId,
  owner,
  registrationNonce,
  grant,
}) {
  const { scope } = grant;
  const parts = [
    lp(Buffer.from(SESSION_KEY_REGISTER_DOMAIN)),
    lp(Buffer.from(chainId, 'utf8')),
    lp(addressBytes(owner)),
    lp(u64le(registrationNonce)),
    lp(Buffer.from(grant.publicKey, 'hex')),
    u64le(scope.allowedMethods.length),
    ...scope.allowedMethods.map((m) => lp(Buffer.from(m, 'utf8'))),
    u64le(scope.allowedTargets.length),
    ...scope.allowedTargets.map(addressBytes),
    u128le(scope.maxValuePerUse),
    u128le(scope.maxTotalValue),
    u64le(grant.validFrom),
    u64le(grant.validUntil),
    grant.maxUses === null || grant.maxUses === undefined
      ? Buffer.from([0])
      : Buffer.concat([Buffer.from([1]), u32le(grant.maxUses)]),
  ];
  if (scope.window) {
    parts.push(
      Buffer.from('window'),
      u64le(scope.window.blocks),
      u128le(scope.window.maxValue),
    );
  }
  return Buffer.concat(parts);
}

/** Revoke preimage, signed by the owner's primary key. */
function sessionKeyRevokeMessage({
  chainId,
  owner,
  sessionKey,
  registrationNonce,
}) {
  return Buffer.concat([
    lp(Buffer.from(SESSION_KEY_REVOKE_DOMAIN)),
    lp(Buffer.from(chainId, 'utf8')),
    lp(addressBytes(owner)),
    lp(addressBytes(sessionKey)),
    lp(u64le(registrationNonce)),
  ]);
}

/** core4 serde Address: a JSON array of 20 byte numbers. */
function addressToByteArray(address) {
  return [...addressBytes(address.toLowerCase())];
}

function byteArrayToAddress(value) {
  if (
    !Array.isArray(value) ||
    value.length !== 20 ||
    !value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    return null;
  }
  return `0x${Buffer.from(value).toString('hex')}`;
}

function sessionKeyAddress(publicKeyHex) {
  if (!HEX32.test(publicKeyHex ?? '')) return null;
  return `0x${createHash('sha3-256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 40)}`;
}

/**
 * Optional session-key authorization on a transfer body. Returns
 * { ok: true, value: { sessionPublicKey, signature } }, or { ok: true, value:
 * null } when absent, or { ok: false, message }.
 */
function parseSessionKeyAuth(raw) {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: 'session_key_auth must be an object' };
  }
  const sessionPublicKey = raw.session_public_key ?? raw.sessionPublicKey;
  const signature = raw.signature;
  if (typeof sessionPublicKey !== 'string' || !HEX32.test(sessionPublicKey)) {
    return {
      ok: false,
      message:
        'session_key_auth.session_public_key must be a 32-byte ed25519 public key in hex',
    };
  }
  if (typeof signature !== 'string' || !HEX64.test(signature)) {
    return {
      ok: false,
      message:
        'session_key_auth.signature must be a 64-byte ed25519 signature in hex',
    };
  }
  return {
    ok: true,
    value: {
      sessionPublicKey: sessionPublicKey.toLowerCase(),
      signature: signature.toLowerCase(),
    },
  };
}

function isU64Number(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

/** u128 limits arrive as JSON numbers (serde); refuse anything JS cannot hold exactly. */
function isU128Number(value) {
  return Number.isSafeInteger(value) && value >= 0 && BigInt(value) <= U128_MAX;
}

function fail(message) {
  return { ok: false, message };
}

function parseGrant(grant) {
  if (!grant || typeof grant !== 'object') return fail('grant is required');
  if (typeof grant.public_key !== 'string' || !HEX32.test(grant.public_key)) {
    return fail('grant.public_key must be a 32-byte ed25519 public key in hex');
  }
  const scope = grant.scope;
  if (!scope || typeof scope !== 'object')
    return fail('grant.scope is required');
  const methods = scope.allowed_methods;
  if (
    !Array.isArray(methods) ||
    methods.length === 0 ||
    methods.length > MAX_METHODS ||
    !methods.every((m) => typeof m === 'string' && /^[a-z0-9_]{1,64}$/.test(m))
  ) {
    return fail('grant.scope.allowed_methods must be 1-16 method names');
  }
  const targets = scope.allowed_targets;
  if (
    !Array.isArray(targets) ||
    targets.length === 0 ||
    targets.length > MAX_TARGETS
  ) {
    return fail(
      'grant.scope.allowed_targets must list 1-64 addresses (ANY_TARGET for anyone)',
    );
  }
  if (!targets.every((t) => byteArrayToAddress(t) !== null)) {
    return fail('grant.scope.allowed_targets entries must be 20-byte arrays');
  }
  if (
    !isU128Number(scope.max_value_per_use) ||
    !isU128Number(scope.max_total_value)
  ) {
    return fail(
      'grant.scope.max_value_per_use and max_total_value must be non-negative integers',
    );
  }
  if (scope.window !== null && scope.window !== undefined) {
    const w = scope.window;
    if (
      !w ||
      typeof w !== 'object' ||
      !isU64Number(w.blocks) ||
      w.blocks === 0 ||
      !isU128Number(w.max_value)
    ) {
      return fail(
        'grant.scope.window must be null or { blocks > 0, max_value }',
      );
    }
  }
  if (
    !isU64Number(grant.valid_from) ||
    !isU64Number(grant.valid_until) ||
    grant.valid_until < grant.valid_from
  ) {
    return fail(
      'grant.valid_from and valid_until must be heights with valid_from <= valid_until',
    );
  }
  if (grant.max_uses !== null && grant.max_uses !== undefined) {
    if (
      !Number.isInteger(grant.max_uses) ||
      grant.max_uses < 0 ||
      grant.max_uses > 0xffffffff
    ) {
      return fail('grant.max_uses must be null or a u32');
    }
  }
  return { ok: true };
}

/**
 * Shape check of a SessionKeyActionPayload before it is relayed to core4's
 * POST /session-keys/submit. Signatures are verified by core4 (it knows the
 * chain id); here only the shape, and that the owner key derives to the owner
 * address, so a malformed body never costs the node a verification.
 * Returns { ok: true, owner, kind } or { ok: false, message }.
 */
function parseSessionKeyAction(body) {
  const action = body && typeof body === 'object' ? body.action : undefined;
  if (!action || typeof action !== 'object' || Array.isArray(action))
    return fail('action is required');
  const kinds = Object.keys(action);
  if (kinds.length !== 1 || !['Register', 'Revoke'].includes(kinds[0])) {
    return fail('action must be exactly one of Register or Revoke');
  }
  const kind = kinds[0];
  const inner = action[kind];
  if (!inner || typeof inner !== 'object')
    return fail(`${kind} must be an object`);
  const owner = byteArrayToAddress(inner.owner);
  if (!owner) return fail('owner must be a 20-byte array');
  if (
    typeof inner.owner_public_key !== 'string' ||
    !HEX32.test(inner.owner_public_key)
  ) {
    return fail('owner_public_key must be a 32-byte ed25519 public key in hex');
  }
  if (sessionKeyAddress(inner.owner_public_key) !== owner) {
    return fail('owner_public_key does not derive to owner');
  }
  if (
    typeof inner.owner_signature !== 'string' ||
    !HEX64.test(inner.owner_signature)
  ) {
    return fail('owner_signature must be a 64-byte ed25519 signature in hex');
  }
  if (kind === 'Register') {
    if (!isU64Number(inner.registration_nonce))
      return fail('registration_nonce must be a non-negative integer');
    if (
      typeof inner.session_signature !== 'string' ||
      !HEX64.test(inner.session_signature)
    ) {
      return fail(
        'session_signature must be a 64-byte ed25519 signature in hex',
      );
    }
    const grant = parseGrant(inner.grant);
    if (!grant.ok) return grant;
  } else if (!byteArrayToAddress(inner.session_key)) {
    return fail('session_key must be a 20-byte array');
  }
  return { ok: true, owner, kind };
}

module.exports = {
  ANY_TARGET,
  SESSION_KEY_REGISTER_DOMAIN,
  SESSION_KEY_REVOKE_DOMAIN,
  SESSION_KEY_TRANSFER_AUTH_DOMAIN,
  addressToByteArray,
  byteArrayToAddress,
  parseSessionKeyAction,
  parseSessionKeyAuth,
  sessionKeyAddress,
  sessionKeyRegisterMessage,
  sessionKeyRevokeMessage,
  sessionKeyTransferMessage,
};
