/**
 * Self-proving passkey send (#2169, owner ruling 2026-10-25: "transfer proves itself").
 *
 * A passkey account has no ed25519 key and so cannot obtain a wallet JWT. Its transfer carries
 * its own authorization (`passkey_auth`, a WebAuthn assertion over the from|to|amount|nonce
 * challenge) and core4 verifies it, so these routes take NO login. The backend checks SHAPE AND
 * SIZE only, then relays to core4 `POST /transactions/submit` with the server Contributor token
 * and no ed25519 fields. It never judges the assertion and never logs its bytes.
 *
 * Mounted BEFORE `/api/wallet` (whose router applies requireAuth to everything). Dormant unless
 * WRFCOIN_ENABLE_PASSKEY_SEND=true, read per request.
 */
const express = require('express');
const { transferLimiter } = require('../../middleware/rateLimiting');
const { logger } = require('../utils/logger');
const { core4ReaderHeaders } = require('../utils/core4-reader-credential');
const { core4ContributorHeaders, sendContributorCredentialUnavailable, CONTRIBUTOR_UNCONFIGURED } = require('../utils/core4-contributor-credential');
const { isLaunchAddress, parseBaseUnits } = require('./wallet-transfer-contract');

const router = express.Router();

// Same cap as the ed25519 send route (50 transfers / hour / IP): the stricter-or-equal floor.
const PASSKEY_SEND_LIMITER = transferLimiter;

/** core4's MAX_WEBAUTHN_FIELD_LEN (shared-protocol passkey.rs). */
const MAX_FIELD_BYTES = 4096;
/** Whole request body. Fixed-size members total < 0.5 KB; three 4 KiB fields hex to < 25 KB. */
const MAX_BODY_BYTES = 32 * 1024;
const U64_MAX = 18446744073709551615n;

const FIXED_BYTES = { public_key_p256: 64, rp_id_hash: 32 };
const VARIABLE = ['authenticator_data', 'client_data_json', 'signature'];
const PASSKEY_MEMBERS = new Set([...Object.keys(FIXED_BYTES), ...VARIABLE]);

let core4ClientPromise = null;
const getCore4Client = () => (core4ClientPromise ||= import('../../shared/core4-route-client.js'));

/** 4xx the node uses to refuse a transfer on its merits (not auth/rate-limit state) pass through. */
const isNodeContractStatus = (status) => status === 503 || (status >= 400 && status < 500 && ![401, 403, 429].includes(status));
/** Generic 502 for node 401/403/429/5xx so internal auth and rate-limit state never reaches an anonymous caller. */
const sendGenericUpstream = (res) =>
  res.status(502).json({ success: false, error: { code: 'UPSTREAM_ERROR', message: 'Upstream node request failed' } });

const enabled = () => process.env.WRFCOIN_ENABLE_PASSKEY_SEND === 'true';
const invalid = (res, message) =>
  res.status(400).json({ success: false, error: { code: 'VALIDATION_ERROR', message } });

function validPasskeyAuth(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'passkey_auth must be an object';
  for (const key of Object.keys(value)) {
    if (!PASSKEY_MEMBERS.has(key)) return `passkey_auth has an unknown member: ${key.slice(0, 32)}`;
  }
  for (const [key, bytes] of Object.entries(FIXED_BYTES)) {
    const hex = value[key];
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]*$/.test(hex) || hex.length !== bytes * 2) {
      return `passkey_auth.${key} must be ${bytes} bytes of hex`;
    }
  }
  for (const key of VARIABLE) {
    const hex = value[key];
    if (typeof hex !== 'string' || !/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0 || hex.length > MAX_FIELD_BYTES * 2) {
      return `passkey_auth.${key} must be non-empty even-length hex of at most ${MAX_FIELD_BYTES} bytes`;
    }
  }
  return null;
}

function parsePasskeyTransfer(body) {
  if (!body || typeof body !== 'object') return { message: 'JSON body required' };
  if (body.auth_pubkey !== undefined || body.auth_signature !== undefined) {
    return { message: 'a passkey transfer carries passkey_auth only, not auth_pubkey/auth_signature' };
  }
  if (!isLaunchAddress(body.from) || !isLaunchAddress(body.to)) return { message: 'from and to must be core4 hex addresses' };
  const amount = parseBaseUnits(body.amount);
  if (amount === null) return { message: 'amount must be a positive integer number of base units and fit a JSON integer' };
  const nonce = String(body.nonce ?? '');
  if (!/^\d{1,20}$/.test(nonce) || BigInt(nonce) > U64_MAX) return { message: 'nonce must be a decimal u64 string' };
  const problem = validPasskeyAuth(body.passkey_auth);
  if (problem) return { message: problem };
  const p = body.passkey_auth;
  return {
    value: {
      from: body.from, to: body.to, amount, nonce,
      passkey_auth: {
        public_key_p256: p.public_key_p256, rp_id_hash: p.rp_id_hash,
        authenticator_data: p.authenticator_data, client_data_json: p.client_data_json, signature: p.signature,
      },
    },
  };
}

router.post('/send-passkey', (req, res, next) => (enabled() ? next() : res.status(404).json({ error: 'Not found' })),
  PASSKEY_SEND_LIMITER, async (req, res) => {
    try {
      const size = typeof req.rawBody === 'string' ? Buffer.byteLength(req.rawBody) : Number(req.headers['content-length'] || 0);
      if (size > MAX_BODY_BYTES) {
        return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: `body exceeds ${MAX_BODY_BYTES} bytes` } });
      }
      const parsed = parsePasskeyTransfer(req.body);
      if (!parsed.value) return invalid(res, parsed.message);
      const transfer = parsed.value;

      let headers;
      try {
        headers = core4ContributorHeaders(req.headers);
      } catch (error) {
        if (error.code === CONTRIBUTOR_UNCONFIGURED) return sendContributorCredentialUnavailable(res);
        throw error;
      }
      const { fetchCore4Json, extractCore4Data } = await getCore4Client();
      const response = await fetchCore4Json('/transactions/submit', {
        method: 'POST',
        headers,
        body: {
          ...transfer,
          transparent_opt_out: true,
          transparent_opt_out_reason: 'first-party wallet',
        },
      });
      // core4's refusals (503 FEATURE_NOT_ACTIVE, 400 AUTHORIZATION_INVALID, other 4xx validation) pass
      // through unchanged; node 401/403/429/5xx become a generic 502.
      if (!response.ok) {
        return isNodeContractStatus(response.status) ? res.status(response.status).json(response.payload) : sendGenericUpstream(res);
      }
      const result = extractCore4Data(response.payload) || {};
      return res.status(response.status || 202).json({ hash: result.tx_id ?? result.hash ?? null, status: 'submitted', settled: false });
    } catch (error) {
      // Never log the request body: it holds the assertion.
      logger.error('Passkey send relay failed', { error: error && error.message });
      const { sendCore4Unavailable } = await getCore4Client();
      return sendCore4Unavailable(res, error, 'Passkey transfer failed');
    }
  });

// The passkey client needs the account nonce but holds no JWT. Public chain data, nonce only.
router.get('/send-passkey/nonce/:address', (req, res, next) => (enabled() ? next() : res.status(404).json({ error: 'Not found' })),
  PASSKEY_SEND_LIMITER, async (req, res) => {
    try {
      if (!isLaunchAddress(req.params.address)) return invalid(res, 'Expected a core4 hex wallet address.');
      // core4 parses hex case-insensitively and answers with the lowercase form; send that form.
      const address = req.params.address.toLowerCase();
      const { fetchCore4Json, extractCore4Data } = await getCore4Client();
      const response = await fetchCore4Json(`/addresses/${encodeURIComponent(address)}`, { headers: core4ReaderHeaders(req.headers) });
      if (response.status === 404) return res.json({ address, nonce: '0' });
      if (!response.ok) return sendGenericUpstream(res);
      const account = extractCore4Data(response.payload) || {};
      return res.json({ address, nonce: String(account.nonce ?? 0) });
    } catch (error) {
      const { sendCore4Unavailable } = await getCore4Client();
      return sendCore4Unavailable(res, error, 'Failed to retrieve passkey account nonce');
    }
  });

module.exports = router;
module.exports.PASSKEY_SEND_LIMITER = PASSKEY_SEND_LIMITER;
