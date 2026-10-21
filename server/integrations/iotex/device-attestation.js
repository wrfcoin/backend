/**
 * IoTeX Device Attestation Module
 *
 * This module handles device attestation for weather stations and environmental sensors
 * on the IoTeX network. Device identity is real ed25519 (see the message format below);
 * there is no simulation path (backend#1240).
 */

const { createLogger } = require('../../../utils/logger.js');
const logger = createLogger('iotex:attestation');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Real ed25519 device signatures (owner ruling 2026-09-30, backend#1240).
//
// Device / publisher public keys are 32-byte ed25519 keys as 64 lowercase hex
// characters (an optional 0x prefix is accepted on input and stripped). A
// signature is 64 bytes as 128 hex characters over the canonical message:
//
//   domain || u32le(len)+chain_id || u32le(len)+network_id || u32le(len)+subject_id
//          || u32le(len)+timestamp || u32le(len)+nonce || u32le(len)+payload_hash
//
// where `domain` is the UTF-8 domain string (one per kind, so a device-data
// signature can never be replayed as an event or attestation), the u32le
// prefixes are byte lengths, `timestamp` is the decimal Unix time in seconds,
// `nonce` is 8-64 chars of [A-Za-z0-9._-], and `payload_hash` is the lowercase
// hex SHA-256 of the canonical JSON of the payload (object keys sorted
// recursively, then JSON.stringify). Chain and network come from
// WRFCOIN_CHAIN_ID / WRFCOIN_NETWORK_ID (default 777 / testnet).
// Verification is strict (the same dalek-parity check the wallet login uses).
// ---------------------------------------------------------------------------
const DOMAINS = Object.freeze({
  deviceData: 'wrfcoin.iotex.device_data.v1',
  w3bstreamEvent: 'wrfcoin.iotex.w3bstream_event.v1',
  attestation: 'wrfcoin.iotex.attestation.v1',
});
const SIGNATURE_WINDOW_SECONDS = 300; // reject stale or future timestamps beyond +-5 minutes
const NONCE_PATTERN = /^[A-Za-z0-9._-]{8,64}$/;
const SIGNED_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function chainIdentity(env = process.env) {
  return {
    chainId: env.WRFCOIN_CHAIN_ID?.trim() || '777',
    networkId: env.WRFCOIN_NETWORK_ID?.trim() || 'testnet',
  };
}

/** A 32-byte ed25519 public key as lowercase hex, or null (also for a non-canonical or small-order point). */
async function normalizePublicKey(value) {
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const { isStrictEd25519Point } = await import('../../routes/wallet-auth-service.js');
  return isStrictEd25519Point(hex) ? hex.toLowerCase() : null;
}

// JSON.parse creates an OWN "__proto__" member; assigning it into a plain {} hits the
// prototype setter and drops it from the hash, so a signed payload could gain an
// unsigned member. One rule: these keys are refused at every level, before hashing
// and before persistence (routes call hasReservedKey too).
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function hasReservedKey(value, depth = 0) {
  if (depth > 64) return true;
  if (Array.isArray(value)) return value.some((item) => hasReservedKey(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.keys(value).some((key) => RESERVED_KEYS.has(key) || hasReservedKey(value[key], depth + 1));
  }
  return false;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((acc, key) => {
        acc[key] = sortKeys(value[key]);
        return acc;
      }, Object.create(null));
  }
  return value;
}

function payloadHash(payload) {
  const canonical = JSON.stringify(sortKeys(payload === undefined ? null : payload));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function lengthPrefixed(text) {
  const bytes = Buffer.from(String(text), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([length, bytes]);
}

/** The exact bytes a device signs. `kind` is a key of DOMAINS. */
function buildSignedMessage({ kind, subjectId, timestamp, nonce, payload }, identity = chainIdentity()) {
  const domain = DOMAINS[kind];
  if (!domain) throw new Error(`unknown signed-message kind: ${kind}`);
  return Buffer.concat([
    Buffer.from(domain, 'utf8'),
    lengthPrefixed(identity.chainId),
    lengthPrefixed(identity.networkId),
    lengthPrefixed(subjectId),
    lengthPrefixed(timestamp),
    lengthPrefixed(nonce),
    lengthPrefixed(payloadHash(payload)),
  ]);
}

/** Strict ed25519 verification of raw bytes; false on any malformed input. */
async function verifyBytes(message, signatureHex, publicKeyHex) {
  const publicKey = await normalizePublicKey(publicKeyHex);
  if (!publicKey || typeof signatureHex !== 'string') return false;
  const signature = signatureHex.trim().replace(/^0x/i, '');
  if (!/^[0-9a-fA-F]{128}$/.test(signature)) return false;
  const { verifyEd25519SignatureBytes } = await import('../../routes/wallet-auth-service.js');
  return verifyEd25519SignatureBytes(publicKey, signature.toLowerCase(), message);
}

/**
 * Verify a signed device/publisher submission. Returns { ok: true, timestampSeconds }
 * or { ok: false, reason } with a fixed reason code (never echoes input).
 * `now` (ms) and `identity` are injectable for tests.
 */
async function verifySignedSubmission(
  { kind, subjectId, timestamp, nonce, payload, signature, publicKey },
  { now = Date.now(), identity = chainIdentity() } = {}
) {
  if (typeof subjectId !== 'string' || !SIGNED_ID_PATTERN.test(subjectId)) return { ok: false, reason: 'BAD_SUBJECT' };
  if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return { ok: false, reason: 'BAD_NONCE' };
  const tsText = typeof timestamp === 'number' ? String(timestamp) : timestamp;
  if (typeof tsText !== 'string' || !/^[0-9]{1,12}$/.test(tsText)) return { ok: false, reason: 'BAD_TIMESTAMP' };
  const timestampSeconds = Number(tsText);
  if (Math.abs(now / 1000 - timestampSeconds) > SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: 'TIMESTAMP_OUT_OF_WINDOW' };
  if (typeof publicKey !== 'string' || !(await normalizePublicKey(publicKey))) return { ok: false, reason: 'BAD_PUBLIC_KEY' };
  if (hasReservedKey(payload)) return { ok: false, reason: 'RESERVED_KEY' };
  const message = buildSignedMessage({ kind, subjectId, timestamp: tsText, nonce, payload }, identity);
  if (!(await verifyBytes(message, signature, publicKey))) return { ok: false, reason: 'BAD_SIGNATURE' };
  return { ok: true, timestampSeconds };
}

/**
 * Generate a challenge for device attestation
 * @param {string} deviceId - The ID of the device to attest
 * @returns {Promise<string>} The challenge string
 */
async function generateChallenge(deviceId) {
  try {
    // In a production environment, you would generate a proper cryptographic challenge
    // This is a simplified implementation for development
    const timestamp = Date.now();
    const random = crypto.randomBytes(16).toString('hex');
    const challenge = `${deviceId}:${timestamp}:${random}`;

    // Hash the challenge to make it harder to forge
    const hash = crypto.createHash('sha256').update(challenge).digest('hex');

    logger.info(`Generated attestation challenge for device ${deviceId}`, {
      challengeHash: hash.substring(0, 16), // Log only part of the hash for privacy
    });

    return hash;
  } catch (error) {
    logger.error(`Error generating attestation challenge: ${error.message}`, {
      error: error.toString(),
    });
    throw error;
  }
}

/**
 * Verify an attestation response against the device's REGISTERED public key.
 *
 * The response is `{ signature, timestamp (unix seconds), nonce, deviceClaims? }`
 * and the signature covers the `attestation` message (see the header) with the
 * stored challenge as its payload. A caller-supplied `response.publicKey` is never
 * trusted: if present it must equal the registered key, and with no registered key
 * the attestation is refused.
 * @param {string} challenge - The stored challenge string
 * @param {Object} response - The response from the device
 * @param {{deviceId: string, publicKey: string}} device - the registered device identity
 * @returns {Promise<Object>} Verification result
 */
async function verifyResponse(challenge, response, device = {}) {
  try {
    if (!response || !response.signature || !response.timestamp || !response.nonce) {
      return { success: false, message: 'Invalid attestation response format' };
    }
    const registered = await normalizePublicKey(device.publicKey);
    if (!registered) {
      return { success: false, message: 'Device has no valid registered public key' };
    }
    if (response.publicKey !== undefined && (await normalizePublicKey(response.publicKey)) !== registered) {
      return { success: false, message: 'Attestation public key does not match the registered device key' };
    }
    const result = await verifySignedSubmission({
      kind: 'attestation',
      subjectId: device.deviceId,
      timestamp: response.timestamp,
      nonce: response.nonce,
      payload: { challenge },
      signature: response.signature,
      publicKey: registered,
    });
    if (!result.ok) {
      return {
        success: false,
        message: result.reason === 'TIMESTAMP_OUT_OF_WINDOW' ? 'Attestation response timed out' : 'Invalid attestation signature',
      };
    }

    // Verify device identity claims if provided
    if (response.deviceClaims) {
      const claimsValid = verifyDeviceClaims(response.deviceClaims);
      if (!claimsValid) {
        return { success: false, message: 'Invalid device claims' };
      }
    }

    logger.info('Successfully verified attestation response', {
      challenge: String(challenge).substring(0, 16), // Log only part of the challenge for privacy
      publicKeyHash: crypto.createHash('sha256').update(registered).digest('hex').substring(0, 16),
    });

    return {
      success: true,
      message: 'Attestation verified successfully',
      verifiedAt: new Date().toISOString(),
    };
  } catch (error) {
    logger.error(`Error verifying attestation response: ${error.message}`, {
      error: error.toString(),
    });
    return { success: false, message: 'Attestation verification failed' };
  }
}

/**
 * Verify a raw ed25519 signature over `message` (bytes or UTF-8 text) with a
 * 32-byte hex public key. Real cryptography (strict verification); false on any
 * malformed input. Callers that accept device submissions use
 * verifySignedSubmission, which adds the domain, chain, timestamp window and nonce.
 * @param {Buffer|string} message
 * @param {string} signature - 128 hex characters
 * @param {string} publicKey - 64 hex characters
 * @returns {Promise<boolean>}
 */
async function verifySignature(message, signature, publicKey) {
  try {
    const bytes = Buffer.isBuffer(message) ? message : Buffer.from(String(message), 'utf8');
    return await verifyBytes(bytes, signature, publicKey);
  } catch (error) {
    logger.error(`Error verifying signature: ${error.message}`, {
      error: error.toString(),
    });
    return false;
  }
}

/**
 * Verify device claims
 * @private
 * @param {Object} claims - The claims made by the device
 * @returns {boolean} Whether the claims are valid
 */
function verifyDeviceClaims(claims) {
  // In production, this would validate claims against a registry or other source
  // For development, we'll consider claims valid if they have required fields

  const requiredFields = ['manufacturer', 'model', 'serialNumber'];

  return requiredFields.every(
    field => claims.hasOwnProperty(field) && claims[field]
  );
}

/**
 * Generate a real ed25519 key pair for a device (32-byte hex public key and seed).
 * The private seed must be delivered to the device out of band and never stored.
 * @param {string} deviceId - The ID of the device
 * @returns {Promise<Object>} Generated key pair
 */
async function generateAttestationKeys(deviceId) {
  try {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const publicHex = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('hex');
    const seedHex = privateKey.export({ format: 'der', type: 'pkcs8' }).subarray(-32).toString('hex');

    logger.info(`Generated attestation keys for device ${deviceId}`, {
      publicKeyHash: crypto.createHash('sha256').update(publicHex).digest('hex').substring(0, 16),
    });

    return {
      publicKey: publicHex,
      privateKey: seedHex, // the seed; transmit to the device securely, do not persist
    };
  } catch (error) {
    logger.error(`Error generating attestation keys: ${error.message}`, {
      error: error.toString(),
    });
    throw error;
  }
}

module.exports = {
  DOMAINS,
  SIGNATURE_WINDOW_SECONDS,
  buildSignedMessage,
  chainIdentity,
  generateAttestationKeys,
  generateChallenge,
  hasReservedKey,
  normalizePublicKey,
  payloadHash,
  verifyResponse,
  verifySignature,
  verifySignedSubmission,
};
