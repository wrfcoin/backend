/**
 * Wallet API Routes
 *
 * This module provides routes for interacting with WrfCoin wallets.
 * Data is proxied from core4 or read from canonical persisted storage. Missing
 * upstream data remains empty/unavailable and is never synthesized.
 */

const express = require('express');
const crypto = require('crypto');
const { Mnemonic } = require('ethers');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const {
  generalLimiter,
  transferLimiter,
} = require('../../middleware/rateLimiting');
const { logger } = require('../utils/logger');
const { notWiredEnvelope } = require('../middleware/require-wired-storage');
const { core4ReaderHeaders } = require('../utils/core4-reader-credential');
const { core4ContributorHeaders, sendContributorCredentialUnavailable, CONTRIBUTOR_UNCONFIGURED } = require('../utils/core4-contributor-credential');
const {
  isLaunchAddress,
  parseBaseUnits,
  parseSignedTransfer,
} = require('./wallet-transfer-contract');
const { parseSessionKeyAction } = require('./session-key-contract');

// All wallet operations require authentication (#230)
router.use(requireAuth);
// Rate limit all wallet routes; financial POST endpoints get tighter limits (#237)
router.use(generalLimiter);
const config = require('../../config');

// Currency helpers — matches core4 WRF_UNITS_PER_COIN = 10^8
const WRF_UNITS_PER_COIN = 100_000_000n;
/** @param {number} displayAmount @returns {bigint} */
function wrfToBaseUnits(displayAmount) {
  const [whole, frac = ''] = Math.abs(displayAmount).toString().split('.');
  const paddedFrac = frac.padEnd(8, '0').slice(0, 8);
  return BigInt(whole) * WRF_UNITS_PER_COIN + BigInt(paddedFrac);
}
/** @param {bigint} baseUnits @returns {string} */
function baseUnitsToWrf(baseUnits) {
  const whole = baseUnits / WRF_UNITS_PER_COIN;
  const frac = (baseUnits % WRF_UNITS_PER_COIN).toString().padStart(8, '0');
  return `${whole}.${frac}`.replace(/\.?0+$/, '');
}
/** @param {bigint} baseUnits @returns {number | null} */
function baseUnitsToCore4Amount(baseUnits) {
  return baseUnits <= BigInt(Number.MAX_SAFE_INTEGER)
    ? Number(baseUnits)
    : null;
}

let core4ClientPromise = null;
async function getCore4Client() {
  if (!core4ClientPromise) {
    core4ClientPromise = import('../../shared/core4-route-client.js');
  }
  return core4ClientPromise;
}

let databaseClientPromise = null;
async function getDatabaseClient() {
  if (!databaseClientPromise) {
    databaseClientPromise = import('../../database/index.js');
  }
  return databaseClientPromise;
}

// Base-unit amounts from core4 are decimal strings; anything else is treated as not reported.
function baseUnitString(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return String(value);
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value) ? value : null;
}

/**
 * The on-chain reward split core4 serves in GET /addresses/{a}.contribution_rewards
 * (real_paid / real_pending / synthetic_paid ...). `weatherRewards` is ONLY the real
 * contribution rewards actually paid; when core4 does not report the block (older node,
 * malformed) it is null with an explicit reason, never a guess or a share of the total.
 */
function weatherRewardFields(account) {
  const block = account.contribution_rewards;
  const paid = block && typeof block === 'object' ? baseUnitString(block.real_paid) : null;
  if (paid === null) {
    return {
      weatherRewards: null,
      weatherRewardsPending: null,
      weatherRewardsUnavailable: 'core4 did not report contribution_rewards for this address',
    };
  }
  return {
    weatherRewards: paid,
    weatherRewardsPending: baseUnitString(block.real_pending),
    weatherRewardsUnavailable: null,
  };
}

function normalizeAccountData(address, account) {
  const earned = baseUnitString(account.earned_balance_total ?? account.earnedBalanceTotal);
  return {
    // On-chain earned total (base units, decimal string) or null when core4 did not report it.
    earned_balance_total: earned,
    earnedBalanceTotal: earned,
    ...weatherRewardFields(account),
    address,
    balance: account.spendable_balance ?? account.balance ?? null,
    transactions: account.transaction_count ?? account.transactions ?? null,
    nonce: account.nonce ?? null,
    firstSeen: account.first_seen ?? account.firstSeen ?? null,
    lastActive: account.last_active ?? account.lastActive ?? null,
    balanceHistory: account.balance_history ?? account.balanceHistory ?? [],
    pendingTransactions:
      account.pending_transactions ?? account.pendingTransactions ?? null,
    dataSubmissions:
      account.data_submissions ?? account.dataSubmissions ?? null,
    computationalTasks:
      account.computational_tasks ?? account.computationalTasks ?? null,
    reputationScore:
      account.reputation_score ?? account.reputationScore ?? null,
  };
}

// ---------------------------------------------------------------------------
// BIP-39 mnemonic helpers (folded in from the retired standalone
// server/wallet_server.js — backend#1116). Stateless: nothing is persisted and
// the mnemonic is NEVER logged. Uses ethers' BIP-39 implementation so
// validation checks the checksum, not just the word count.
// ---------------------------------------------------------------------------
const VALID_MNEMONIC_STRENGTHS = [128, 160, 192, 224, 256];
const VALID_MNEMONIC_WORD_COUNTS = [12, 15, 18, 21, 24];

/**
 * Generate a BIP-39 mnemonic from cryptographically secure entropy.
 *
 * @route POST /wallet/mnemonic/generate
 * @param {number} [strength=128] - Entropy bits: 128 | 160 | 192 | 224 | 256
 * @returns {{ success: boolean, data: { mnemonic: string, strength: number, wordCount: number, generated: string } }}
 */
router.post('/mnemonic/generate', (req, res) => {
  try {
    const { strength = 128 } = req.body ?? {};
    if (!VALID_MNEMONIC_STRENGTHS.includes(strength)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid strength parameter',
        message: `Strength must be one of: ${VALID_MNEMONIC_STRENGTHS.join(', ')}`,
        timestamp: new Date().toISOString(),
      });
    }

    const entropy = crypto.randomBytes(strength / 8);
    const mnemonic = Mnemonic.fromEntropy(entropy).phrase;
    const wordCount = mnemonic.split(' ').length;

    // Deliberately logs only the shape, never the phrase.
    logger.info('Generated BIP-39 mnemonic', { wordCount, strength });

    return res.json({
      success: true,
      data: {
        mnemonic,
        strength,
        wordCount,
        generated: new Date().toISOString(),
        entropy: 'cryptographically-secure',
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error generating mnemonic', { error: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to generate secure mnemonic phrase',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Validate a BIP-39 mnemonic (word count, wordlist membership and checksum).
 *
 * @route POST /wallet/mnemonic/validate
 * @param {string} mnemonic - Space-separated phrase
 * @returns {{ success: boolean, data: { valid: boolean, wordCount: number, strength?: number, error?: string } }}
 */
router.post('/mnemonic/validate', (req, res) => {
  try {
    const { mnemonic } = req.body ?? {};
    if (!mnemonic || typeof mnemonic !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'Invalid input',
        message: 'Mnemonic phrase is required',
        timestamp: new Date().toISOString(),
      });
    }

    const words = mnemonic.trim().split(/\s+/);
    const wordCount = words.length;

    if (!VALID_MNEMONIC_WORD_COUNTS.includes(wordCount)) {
      return res.json({
        success: true,
        data: {
          valid: false,
          error: 'Invalid word count',
          expected: VALID_MNEMONIC_WORD_COUNTS,
          actual: wordCount,
        },
        timestamp: new Date().toISOString(),
      });
    }

    const valid = Mnemonic.isValidMnemonic(words.join(' '));
    logger.info('Validated BIP-39 mnemonic', { wordCount, valid });

    return res.json({
      success: true,
      data: {
        valid,
        wordCount,
        strength: (wordCount / 3) * 32,
        ...(valid
          ? {}
          : { error: 'Invalid mnemonic (unknown word or checksum mismatch)' }),
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error validating mnemonic', { error: error.message });
    return res.status(500).json({
      success: false,
      error: 'Failed to validate mnemonic phrase',
      timestamp: new Date().toISOString(),
    });
  }
});

// Get wallet information. core4 /addresses/{address} is Reader-gated, so this
// uses the same own-address + Reader-token path as /transactions (#1282).
router.get('/:address', async (req, res) => {
  try {
    if (!requireOwnAddress(req, res)) return undefined;
    const readerToken = requireReaderToken(res);
    if (!readerToken) return undefined;
    const { extractCore4Data, fetchCore4Json, sendCore4Error } =
      await getCore4Client();

    const { address } = req.params;
    const response = await fetchCore4Json(
      `/addresses/${encodeURIComponent(address)}`,
      { headers: core4ReaderHeaders(req.headers) },
    );

    if (isCore4AddressNotFound(response)) {
      // A new wallet has no account state until it first receives funds; on
      // chain that is a zero balance, not an error (#1285). Say so explicitly
      // with exists:false rather than 404, which left the mobile wallet with
      // no way to reach the faucet.
      return res.json({
        ...normalizeAccountData(address, {
          balance: '0',
          earned_balance_total: '0',
          contribution_rewards: { real_paid: '0', real_pending: '0' },
        }),
        spendable_balance: '0',
        exists: false,
      });
    }

    if (!response.ok) {
      return sendCore4Error(
        res,
        response,
        'Failed to fetch wallet information',
      );
    }

    const account = extractCore4Data(response.payload) || {};
    res.json(normalizeAccountData(address, account));
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error getting wallet info', {
      error: error.message,
      address: req.params.address,
    });
    return sendCore4Unavailable(
      res,
      error,
      'Failed to retrieve wallet information',
    );
  }
});

/**
 * True only for core4 get_address_compat's "no account state" answer:
 * 404 with envelope error { code: 'NOT_FOUND', message: 'address not found' }.
 * core4 rejects a malformed address with 400 VALIDATION_ERROR before it looks
 * the account up, so this body also means the address was well-formed. Any
 * other 404 (unknown route, different code or message) is not matched.
 */
function isCore4AddressNotFound(response) {
  const payload = response && response.payload;
  return (
    response.status === 404 &&
    payload !== null &&
    typeof payload === 'object' &&
    payload.ok === false &&
    payload.error !== null &&
    typeof payload.error === 'object' &&
    payload.error.code === 'NOT_FOUND' &&
    payload.error.message === 'address not found'
  );
}

let readerTokenMissingWarned = false;
/**
 * Returns the configured Reader token, or sends a 503 and returns null.
 * Without the token core4 would answer 401, which an authenticated client
 * would misread as its own session expiring — fail closed with 503 instead.
 */
function requireReaderToken(res) {
  const readerToken = process.env.WRFCOIN_READER_TOKEN?.trim();
  if (readerToken) return readerToken;
  if (!readerTokenMissingWarned) {
    readerTokenMissingWarned = true;
    logger.warn(
      'WRFCOIN_READER_TOKEN is not set; wallet info/history/nonce/NFT reads return 503 until it is configured',
    );
  }
  res.status(503).json({
    success: false,
    error: {
      code: 'CORE4_READER_CREDENTIAL_UNCONFIGURED',
      message:
        'Wallet chain reads are unavailable: the backend core4 Reader credential is not configured',
    },
    timestamp: new Date().toISOString(),
  });
  return null;
}

/**
 * Binds a Reader-backed read to the authenticated identity. Same comparison
 * as POST /:address/transactions (#824): JWT sub vs URL address, lowercased.
 * Sends 401/403 and returns false when the caller may not read this address.
 */
function requireOwnAddress(req, res) {
  const callerAddress = req.user && req.user.sub;
  if (!callerAddress || typeof callerAddress !== 'string') {
    res.status(401).json({
      error: true,
      message: 'Authenticated wallet address could not be determined',
    });
    return false;
  }
  if (callerAddress.toLowerCase() !== String(req.params.address).toLowerCase()) {
    res.status(403).json({
      error: true,
      message: 'Forbidden: you may only read chain data for your own address',
    });
    return false;
  }
  return true;
}

// Monetary history fields are decimal strings. Never stringify JSON numbers:
// an upstream u128 may already have lost precision before it reaches us.
function historyBaseUnits(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 39) return null;
  return BigInt(value) <= (1n << 128n) - 1n ? value : null;
}

function historyItem(tx, version) {
  const legacy = {
    txId: tx.tx_id ?? null,
    blockHeight: tx.block_height ?? null,
    type: tx.tx_type ?? null,
    from: tx.sender ?? null,
    to: tx.to ?? null,
    amount: tx.amount ?? null,
  };
  if (version === 1) return legacy;
  const amount = historyBaseUnits(tx.amount_base_units);
  return {
    ...legacy,
    eventId: typeof tx.event_id === 'string' ? tx.event_id : null,
    timestamp: tx.timestamp ?? null,
    type: tx.kind ?? tx.tx_type ?? null,
    from: tx.from ?? tx.sender ?? null,
    amount,
    amountBaseUnits: amount,
    direction: ['received', 'sent', 'self'].includes(tx.direction) ? tx.direction : 'unknown',
    counterparty: tx.counterparty ?? null,
    kind: tx.kind ?? null,
    settlement: ['paid', 'included'].includes(tx.settlement) ? tx.settlement : null,
  };
}

function isPaidHistoryCredit(tx, address) {
  if (!tx || typeof tx !== 'object' || typeof tx.to !== 'string') return false;
  const canonical = value => value.toLowerCase().replace(/^0x/, '');
  const amount = historyBaseUnits(tx.amount_base_units);
  const prefix = tx.kind === 'weather_reward' ? 'contribution:' : tx.kind === 'forecast_reward' ? 'forecast:' : null;
  return tx.settlement === 'paid' && tx.direction === 'received'
    && canonical(tx.to) === canonical(address)
    && amount !== null && BigInt(amount) > 0n
    && prefix !== null && typeof tx.event_id === 'string'
    && tx.event_id.startsWith(prefix) && tx.event_id.length > prefix.length;
}

// Get wallet transaction history
router.get('/:address/transactions', async (req, res) => {
  try {
    if (!requireOwnAddress(req, res)) return undefined;
    const readerToken = requireReaderToken(res);
    if (!readerToken) return undefined;
    const {
      extractCore4Data,
      fetchCore4Json,
      sendCore4Error,
      sendNotImplemented,
    } = await getCore4Client();
    const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit ?? '25'), 10) || 25));
    const offset = Math.max(0, Number.parseInt(String(req.query.offset ?? '0'), 10) || 0);
    let creditQuery = '';
    if (req.query.creditLimit !== undefined) {
      const creditLimit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.creditLimit), 10) || 1));
      creditQuery += `&credit_limit=${creditLimit}`;
    }
    if (req.query.creditAfter !== undefined) {
      if (typeof req.query.creditAfter !== 'string') return res.status(400).json({ error: 'Invalid credit cursor' });
      creditQuery += `&credit_after=${encodeURIComponent(req.query.creditAfter)}`;
    }
    const address = encodeURIComponent(req.params.address);
    const response = await fetchCore4Json(
      `/addresses/${address}/transactions?limit=${limit}&offset=${offset}${creditQuery}`,
      { headers: core4ReaderHeaders(req.headers) },
    );

    if (response.status === 404) {
      return sendNotImplemented(
        res,
        'Wallet transaction history is unavailable on this node version.',
        'capability: wallet.history; core4 does not serve /addresses/{address}/transactions',
      );
    }
    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to fetch wallet transaction history');
    }

    const data = extractCore4Data(response.payload) || {};
    const transactions = Array.isArray(data.transactions) ? data.transactions : [];
    const schemaVersion = Array.isArray(data.credit_events) ? 2 : 1;
    return res.json({
      schemaVersion,
      items: transactions.filter(tx => tx && typeof tx === 'object').map(tx => historyItem(tx, schemaVersion)),
      creditItems: schemaVersion === 2 ? data.credit_events
        .filter(tx => isPaidHistoryCredit(tx, req.params.address))
        .map(tx => historyItem(tx, 2)) : [],
      // No global count: core4 bounds examined records before filtering, and
      // an empty page may still have a next cursor.
      creditTotal: null,
      creditRecordsExamined: schemaVersion === 2 ? data.credit_records_examined ?? null : null,
      creditScanLimit: schemaVersion === 2 ? data.credit_scan_limit ?? null : null,
      creditLimit: schemaVersion === 2 ? data.credit_limit ?? limit : null,
      creditNextCursor: schemaVersion === 2 && typeof data.credit_next_cursor === 'string' ? data.credit_next_cursor : null,
      creditOrder: schemaVersion === 2 ? data.credit_order ?? null : null,
      windowStartHeight: data.window_start_height ?? null,
      source: 'core4',
      complete: false,
      limit: data.limit ?? limit,
      offset: data.offset ?? offset,
      totalInWindow: data.total_in_window ?? transactions.length,
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error getting wallet transactions', {
      error: error.message,
      address: req.params.address,
    });
    return sendCore4Unavailable(
      res,
      error,
      'Failed to retrieve wallet transactions',
    );
  }
});

router.get('/:address/nonce', async (req, res) => {
  try {
    if (!requireOwnAddress(req, res)) return undefined;
    const readerToken = requireReaderToken(res);
    if (!readerToken) return undefined;
    const { address } = req.params;
    const { fetchCore4Json, extractCore4Data } = await getCore4Client();
    const response = await fetchCore4Json(
      `/addresses/${encodeURIComponent(address)}`,
      { headers: core4ReaderHeaders(req.headers) },
    );
    if (!response.ok) return res.status(response.status || 502).json(response.payload);
    const account = extractCore4Data(response.payload) || {};
    if (account.nonce === undefined || account.nonce === null) {
      return res.status(501).json(
        notWiredEnvelope({
          capability: 'wallet.nonce',
          message:
            'wallet.nonce is not wired: the core4 address response does not expose nonce',
        }),
      );
    }
    return res.json({ address, nonce: String(account.nonce) });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    return sendCore4Unavailable(res, error, 'Failed to retrieve wallet nonce');
  }
});

function rejectInvalidSignedTransfer(res, parsed) {
  if (parsed.unsigned) {
    return res.status(501).json(
      notWiredEnvelope({
        capability: 'wallet.send',
        message: parsed.message,
        see: 'SIGNED_TRANSFER_CONTRACT',
      }),
    );
  }
  return res.status(400).json({
    success: false,
    error: { code: parsed.code, message: parsed.message },
  });
}

// Exactly one authorization goes to core4: the owner's ed25519 key, or a
// registered session key (core4 checks that key's scope and limits).
function transferAuthorization(transfer) {
  if (transfer.sessionKeyAuth) {
    return {
      session_key_auth: {
        session_public_key: transfer.sessionKeyAuth.sessionPublicKey,
        signature: transfer.sessionKeyAuth.signature,
      },
    };
  }
  return { auth_pubkey: transfer.authPubkey, auth_signature: transfer.authSignature };
}

async function submitSignedTransfer(req, res, expectedFrom) {
  const parsed = parseSignedTransfer(req.body);
  if (!parsed.ok) return rejectInvalidSignedTransfer(res, parsed);
  const transfer = parsed.value;
  if (transfer.from.toLowerCase() !== expectedFrom.toLowerCase()) {
    return res.status(403).json({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'signed from address must match the authenticated wallet',
      },
    });
  }
  const { fetchCore4Json, extractCore4Data } =
    await getCore4Client();
  let headers;
  try {
    headers = core4ContributorHeaders(req.headers);
  } catch (error) {
    if (error.code === CONTRIBUTOR_UNCONFIGURED) return sendContributorCredentialUnavailable(res);
    throw error;
  }
  const response = await fetchCore4Json('/transactions/submit', {
    method: 'POST',
    // The caller's Authorization header is a backend JWT. Core4 has its own
    // role-token store, so the relay must replace that JWT with a narrowly
    // scoped Contributor credential. Ownership remains bound above to JWT sub.
    headers,
    body: {
      from: transfer.from,
      to: transfer.to,
      amount: transfer.amount,
      nonce: transfer.nonce,
      transparent_opt_out: true,
      transparent_opt_out_reason: 'first-party wallet',
      ...transferAuthorization(transfer),
    },
  });
  if (!response.ok) return res.status(response.status || 502).json(response.payload);
  const result = extractCore4Data(response.payload) || {};
  return res.status(response.status || 202).json({
    hash: result.tx_id ?? result.hash ?? null,
    status: 'submitted',
    settled: false,
  });
}

// Send WRF transaction endpoint - matches frontend expectation
router.post('/send', transferLimiter, async (req, res) => {
  try {
    // Bind sender to the authenticated identity (JWT sub claim).
    // Accepting an arbitrary `from` in the body would let any authenticated
    // user drain another user's wallet.
    const from = req.user && req.user.sub;
    if (!from) {
      return res.status(401).json({
        error: 'Authenticated wallet address could not be determined',
      });
    }

    return await submitSignedTransfer(req, res, from);
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Transaction error:', error);
    return sendCore4Unavailable(res, error, 'Transaction failed');
  }
});

/**
 * Session keys (core4 feature session_keys): GET lists the caller's own
 * grants with their limits and what is left; POST relays an owner-signed
 * register or revoke. Both are owner-bound to the JWT subject. While the
 * feature is off core4 answers the list with feature_active:false and the
 * submit with 503 FEATURE_NOT_ACTIVE, which pass through unchanged.
 */
router.get('/:address/session-keys', async (req, res) => {
  try {
    if (!isLaunchAddress(req.params.address)) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_ADDRESS', message: 'Expected a core4 hex wallet address.' },
      });
    }
    if (!requireOwnAddress(req, res)) return undefined;
    if (!requireReaderToken(res)) return undefined;
    const { fetchCore4Json, extractCore4Data } = await getCore4Client();
    const response = await fetchCore4Json(
      `/accounts/${encodeURIComponent(req.params.address.toLowerCase())}/session-keys`,
      { headers: core4ReaderHeaders(req.headers) },
    );
    if (!response.ok) return res.status(response.status || 502).json(response.payload);
    const data = extractCore4Data(response.payload);
    if (!data || typeof data !== 'object' || !Array.isArray(data.session_keys)) {
      return res.status(502).json({
        success: false,
        error: { code: 'CORE4_BAD_RESPONSE', message: 'core4 session-key list had an unexpected shape' },
      });
    }
    return res.json({ success: true, data });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    return sendCore4Unavailable(res, error, 'Failed to read session keys');
  }
});

router.post('/session-keys', transferLimiter, async (req, res) => {
  try {
    const caller = req.user && req.user.sub;
    if (!caller || typeof caller !== 'string') {
      return res.status(401).json({ error: 'Authenticated wallet address could not be determined' });
    }
    const parsed = parseSessionKeyAction(req.body);
    if (!parsed.ok) {
      return res.status(400).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: parsed.message },
      });
    }
    if (parsed.owner !== caller.toLowerCase()) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'session key owner must match the authenticated wallet' },
      });
    }
    let headers;
    try {
      headers = core4ContributorHeaders(req.headers);
    } catch (error) {
      if (error.code === CONTRIBUTOR_UNCONFIGURED) return sendContributorCredentialUnavailable(res);
      throw error;
    }
    const { fetchCore4Json, extractCore4Data } = await getCore4Client();
    const response = await fetchCore4Json('/session-keys/submit', {
      method: 'POST',
      headers,
      body: { action: req.body.action },
    });
    if (!response.ok) return res.status(response.status || 502).json(response.payload);
    const result = extractCore4Data(response.payload) || {};
    return res.status(response.status || 202).json({
      hash: result.tx_id ?? null,
      action: parsed.kind.toLowerCase(),
      status: 'submitted',
      settled: false,
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Session key action error:', error);
    return sendCore4Unavailable(res, error, 'Session key action failed');
  }
});

// This is the backend's existing display rule, not a fee charged by core4.
// If core4 introduces an authoritative transfer fee, replace this rule with
// that source and return authoritative: true.
// Amounts are integer base units end to end (same rule as POST /send, #1197):
// no display-WRF parsing and no floating point; integer division floors.
function computeDisplayFeeBaseUnits(transferAmountBaseUnits) {
  return transferAmountBaseUnits / 1000n;
}

router.post('/estimate-gas', transferLimiter, (req, res) => {
  const { to, amount } = req.body ?? {};
  const transferAmountBaseUnits = parseBaseUnits(amount);
  if (!isLaunchAddress(to) || transferAmountBaseUnits === null) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message:
          'to must be a core4 hex address and amount must be a positive integer number of base units and fit a JSON integer',
      },
    });
  }

  const feeBaseUnits = computeDisplayFeeBaseUnits(BigInt(transferAmountBaseUnits));
  return res.json({
    success: true,
    amountBaseUnits: String(transferAmountBaseUnits),
    feeBaseUnits: feeBaseUnits.toString(),
    unit: 'integer base units',
    currency: 'WRF',
    authoritative: false,
    source: 'backend-display-rule',
    rule: 'floor(amountBaseUnits/1000)',
    note: 'core4 charges no transfer fee; this figure is not debited on chain',
  });
});

// Create transaction (legacy endpoint)
router.post('/:address/transactions', transferLimiter, async (req, res) => {
  try {
    const { address } = req.params;

    // Ownership check: the caller must own the address in the URL (#824)
    const callerAddress = req.user && req.user.sub;
    if (
      !callerAddress ||
      callerAddress.toLowerCase() !== address.toLowerCase()
    ) {
      return res.status(403).json({
        error: true,
        message:
          'Forbidden: you may only submit transactions from your own address',
      });
    }

    return await submitSignedTransfer(req, res, address);
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error creating transaction', {
      error: error.message,
      address: req.params.address,
    });
    return sendCore4Unavailable(res, error, 'Failed to create transaction');
  }
});

/**
 * Get wallet NFTs
 *
 * Reads the canonical core4 NFT owner index. Empty owners remain empty.
 *
 * @route GET /wallet/:address/nfts
 * @param {string} address - Wallet address
 * @returns {{ success: boolean, data: object[], timestamp: string }}
 */
router.get('/:address/nfts', async (req, res) => {
  try {
    const { address } = req.params;
    if (!isLaunchAddress(address)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ADDRESS',
          message: 'Expected a core4 hex wallet address.',
        },
      });
    }

    // core4 /nft/list is Reader-gated (#1282): own address + Reader token only.
    if (!requireOwnAddress(req, res)) return undefined;
    const readerToken = requireReaderToken(res);
    if (!readerToken) return undefined;

    const { extractCore4Data, fetchCore4Json, sendCore4Error } =
      await getCore4Client();
    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 25, 1),
      100,
    );
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const response = await fetchCore4Json('/nft/list', {
      headers: core4ReaderHeaders(req.headers),
      query: { owner: address, limit, offset },
    });
    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to retrieve wallet NFTs');
    }

    const data = extractCore4Data(response.payload) || {};
    const nfts = Array.isArray(data.items) ? data.items : [];
    const total = Number(data.total ?? nfts.length);

    return res.json({
      success: true,
      data: nfts,
      pagination: { total, limit, offset },
      source: 'core4:/nft/list',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error getting wallet NFTs', {
      error: error.message,
      address: req.params.address,
    });
    return sendCore4Unavailable(res, error, 'Failed to retrieve wallet NFTs');
  }
});

/**
 * Get wallet data submissions
 *
 * Reads persisted weather/IoT submissions for the wallet. Chain inclusion
 * status/hash/height are not stored by this table and remain explicitly
 * unavailable.
 *
 * @route GET /wallet/:address/data
 * @param {string} address - Wallet address
 * @returns {{ success: boolean, data: object[], timestamp: string }}
 */
router.get('/:address/data', async (req, res) => {
  try {
    const { address } = req.params;
    if (!isLaunchAddress(address)) {
      return res.status(400).json({
        success: false,
        error: {
          code: 'INVALID_ADDRESS',
          message: 'Expected a core4 hex wallet address.',
        },
      });
    }

    const limit = Math.min(
      Math.max(Number.parseInt(req.query.limit, 10) || 25, 1),
      100,
    );
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const { executeQuery } = await getDatabaseClient();
    const [countResult, result] = await Promise.all([
      executeQuery(
        `SELECT COUNT(*)::integer AS total_count
           FROM weather_submissions ws
           LEFT JOIN users u ON u.id = ws.user_id
           LEFT JOIN weather_commitments wc ON wc.id = ws.commitment_id
          WHERE LOWER(ws.wallet_address) = LOWER($1)
             OR LOWER(u.wallet_address) = LOWER($1)
             OR LOWER(wc.contributor) = LOWER($1)`,
        [address],
      ),
      executeQuery(
        `SELECT ws.id,
                ws.station_id,
                ws.reward_amount,
                ws.quality_score,
                ws.source,
                ws.submitted_at
           FROM weather_submissions ws
           LEFT JOIN users u ON u.id = ws.user_id
           LEFT JOIN weather_commitments wc ON wc.id = ws.commitment_id
          WHERE LOWER(ws.wallet_address) = LOWER($1)
             OR LOWER(u.wallet_address) = LOWER($1)
             OR LOWER(wc.contributor) = LOWER($1)
          ORDER BY ws.submitted_at DESC, ws.id DESC
          LIMIT $2 OFFSET $3`,
        [address, limit, offset],
      ),
    ]);
    const rows = Array.isArray(result.rows) ? result.rows : [];
    const submissions = rows.map((row) => ({
      submissionId: String(row.id),
      timestamp: new Date(row.submitted_at).toISOString(),
      dataType: row.source,
      reward: row.reward_amount == null ? null : String(row.reward_amount),
      stationId: row.station_id,
      qualityScore:
        row.quality_score == null ? null : Number(row.quality_score),
    }));
    const total = Number(countResult.rows?.[0]?.total_count ?? 0);

    return res.json({
      success: true,
      data: submissions,
      pagination: { total, limit, offset },
      source: 'database:weather_submissions',
      unavailable: ['dataHash', 'status', 'blockHeight'],
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error getting wallet data submissions', {
      error: error.message,
      address: req.params.address,
    });
    return res.status(503).json({
      success: false,
      unavailable: true,
      reason: 'The canonical submission store is unavailable.',
      error: {
        code: 'DATABASE_UNAVAILABLE',
        message: 'Failed to retrieve wallet data submissions.',
        details: error.message,
      },
      timestamp: new Date().toISOString(),
    });
  }
});

// #216 — Enhanced/Maximum privacy send (mobile `POST /api/wallet/send-private`).
//
// Mobile's `sendPrivateTransaction` first calls /api/privacy/stealth-address
// (now mounted, see privacyRoutes) and then POSTs here with the resolved stealth
// `to`. The route was never mounted and had no handler, so the private send
// threw for every user.
//
// ESCALATION (see privacyRoutes /stealth-address): a real private send requires
// ring-signature construction over client-held key material plus a private
// transaction submission. core4 exposes the crypto primitives (feature-gated
// `--features privacy`: /privacy/ring-signature/create, key-image registry,
// commitments) but there is no single "submit a private transfer for a bare
// address" endpoint, and no wallet→stealth-key directory to originate it. This
// expands to a coordinated core4 + backend + mobile change. Until that lands we
// mount a real handler that binds the sender to the JWT identity, validates
// input, and returns a clear 501 rather than a 404/crash — so mobile can degrade
// gracefully (or hide the non-Standard tiers, per issue #216) instead of hard-failing.
router.post('/send-private', transferLimiter, async (req, res) => {
  try {
    const { to, amount, privacyLevel } = req.body || {};

    // Bind sender to the authenticated identity (mirrors /send: never trust `from`).
    const from = req.user && req.user.sub;
    if (!from) {
      return res.status(401).json({
        error: 'Authenticated wallet address could not be determined',
      });
    }
    if (!to || !amount) {
      return res.status(400).json({
        error: 'Missing required fields: to, amount',
      });
    }

    const { sendNotImplemented } = await getCore4Client();
    return sendNotImplemented(
      res,
      'Private (Enhanced/Maximum) sends are not yet available end-to-end.',
      'core4 exposes the privacy crypto primitives (ring signatures, key images, ' +
        'commitments under --features privacy) but no single private-transfer submit ' +
        'endpoint, and no recipient stealth-key directory to originate the send. ' +
        'Completing this requires a coordinated core4 + backend + mobile change. ' +
        'Use the Standard privacy tier in the interim.',
    );
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error processing private send', { error: error.message });
    return sendCore4Unavailable(res, error, 'Failed to process private send');
  }
});

module.exports = router;
