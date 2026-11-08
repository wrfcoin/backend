/**
 * Blockchain API Routes
 *
 * This module proxies supported blockchain reads to the core4 launch API and
 * returns explicit 501s for legacy mock endpoints that have no real upstream.
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const { hasOperatorToken, hasOperatorOrReaderToken } = require('../middleware/operator-token-auth');
const {
  projectAnonymousBlockTransactions,
  redactRewardEntriesMetadata,
} = require('../utils/anonymous-projection');
const { core4PublicReadHeaders } = require('../utils/core4-reader-credential');

const ANONYMOUS_BLOCK_WINDOW = 30;

let core4ClientPromise = null;

async function getCore4Client() {
  if (!core4ClientPromise) {
    core4ClientPromise = import('../../shared/core4-route-client.js');
  }

  return core4ClientPromise;
}

function toInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

let warnedMissingReaderToken = false;

// /transactions/stake/metrics is Reader-gated on core4 (core4#1841-class
// hardening). This is a server-side aggregate-dashboard read, not an action
// on the caller's behalf, so it must never see the inbound caller's own
// Authorization: an anonymous public caller has none, and reusing an
// authenticated caller's token here would spend their credential on an
// unrelated server-initiated call. Use a server-owned Reader credential
// instead; only request/correlation IDs may cross from req.headers.
function readerAuthHeaders(requestHeaders) {
  const readerToken = process.env.WRFCOIN_READER_TOKEN?.trim();
  if (!readerToken) {
    if (!warnedMissingReaderToken) {
      warnedMissingReaderToken = true;
      logger.warn(
        'WRFCOIN_READER_TOKEN is not configured — GET /api/blockchain/status will report ' +
          'activeValidators as null (core4 /transactions/stake/metrics requires Reader auth)'
      );
    }
  }
  return core4PublicReadHeaders(requestHeaders);
}

// core4 GET /network/upgrade (unauthenticated) describes what the chain has
// scheduled: `scheduled.entries` is the effective feature schedule (genesis plus
// applied schedule extensions), each with `active_at_next`; the top-level
// `activation_height`/`blocks_remaining` mirror a governance-signed upgrade
// notice, when one is installed. An upgrade is scheduled while either names a
// height still ahead of the tip. With no answer from core4 the result is
// unknown (null), not "no".
function summarizeUpgrade(upgrade) {
  if (!upgrade || typeof upgrade !== 'object') {
    return { upgradeScheduled: null, nextUpgradeHeight: null };
  }
  const heights = [];
  const entries = Array.isArray(upgrade.scheduled?.entries) ? upgrade.scheduled.entries : [];
  for (const entry of entries) {
    if (entry && entry.active_at_next === false && Number.isSafeInteger(entry.activation_height)) {
      heights.push(entry.activation_height);
    }
  }
  if (
    Number.isSafeInteger(upgrade.activation_height) &&
    Number.isSafeInteger(upgrade.blocks_remaining) &&
    upgrade.blocks_remaining > 0
  ) {
    heights.push(upgrade.activation_height);
  }
  return {
    upgradeScheduled: heights.length > 0,
    nextUpgradeHeight: heights.length > 0 ? Math.min(...heights) : null,
  };
}

router.get('/status', async (req, res) => {
  try {
    const {
      extractCore4Data,
      fetchCore4Json,
      sendCore4Error,
      sendCore4Unavailable,
      toNullable,
    } = await getCore4Client();
    const headers = readerAuthHeaders(req.headers);
    const [blockchainResponse, networkResponse, miningResponse, stakeResponse, upgradeResponse] =
      await Promise.all([
        fetchCore4Json('/blockchain', { headers }),
        fetchCore4Json('/network/info', { headers }),
        fetchCore4Json('/mining/stats', { headers }),
        fetchCore4Json('/transactions/stake/metrics', { headers }),
        // Optional: a failure here must not fail the status read.
        fetchCore4Json('/network/upgrade', { headers }).catch(() => null),
      ]);

    for (const [response, message] of [
      [blockchainResponse, 'Failed to retrieve blockchain status'],
      [networkResponse, 'Failed to retrieve blockchain network info'],
      [miningResponse, 'Failed to retrieve blockchain mining stats'],
    ]) {
      if (!response.ok) {
        return sendCore4Error(res, response, message);
      }
    }

    const blockchain = extractCore4Data(blockchainResponse.payload) || {};
    const network = extractCore4Data(networkResponse.payload) || {};
    const mining = extractCore4Data(miningResponse.payload) || {};
    const stake = stakeResponse.ok
      ? extractCore4Data(stakeResponse.payload) || {}
      : {};
    const upgrade = summarizeUpgrade(
      upgradeResponse?.ok ? extractCore4Data(upgradeResponse.payload) : null,
    );

    res.json({
      network: process.env.NETWORK_MODE || 'testnet',
      blockHeight: toNullable(blockchain.height ?? mining.chain_height),
      blockTime: toNullable(mining.avg_block_time_secs),
      difficulty: toNullable(mining.difficulty),
      hashrate: null,
      activeValidators: toNullable(stake.account_count),
      totalTransactions: toNullable(mining.total_transactions),
      pendingTransactions: toNullable(blockchain.pending_transactions),
      avgBlockSize: null,
      lastBlockTime: null,
      status: toNullable(network.sync_status ?? 'unknown'),
      upgradeScheduled: upgrade.upgradeScheduled,
      nextUpgradeHeight: upgrade.nextUpgradeHeight,
      lastUpdated: new Date().toISOString(),
      chainId: toNullable(network.chain_id),
      peerCount: toNullable(network.peer_count),
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error getting blockchain status', {
      error: error instanceof Error ? error.message : String(error),
    });
    return sendCore4Unavailable(
      res,
      error,
      'Failed to retrieve blockchain status'
    );
  }
});

router.get('/blocks', async (req, res) => {
  try {
    const {
      extractCore4Data,
      fetchCore4Json,
      sendCore4Error,
      sendCore4Unavailable,
      toNullable,
    } = await getCore4Client();
    // Anonymous callers (the mobile explorer) may only read the ANONYMOUS_BLOCK_WINDOW most
    // recent blocks: limit <= 30 and limit + offset <= 30, so the upstream read is bounded and
    // no phone can walk deep history. The operator or Reader bearer keeps the original limits.
    const operator = hasOperatorOrReaderToken(req);
    const limit = Math.min(
      Math.max(toInteger(req.query.limit, 10), 1),
      operator ? 100 : ANONYMOUS_BLOCK_WINDOW
    );
    const requestedOffset = Math.max(toInteger(req.query.offset, 0), 0);
    const offset = operator
      ? requestedOffset
      : Math.min(requestedOffset, ANONYMOUS_BLOCK_WINDOW - limit);
    // Fetch exactly what we need — do not cap at 100 here; that would silently
    // truncate results when offset > 0 (#423, #438).
    const upstreamLimit = limit + offset;

    const response = await fetchCore4Json('/chain/blocks', {
      query: { limit: upstreamLimit },
    });

    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to retrieve blocks');
    }

    const payload = extractCore4Data(response.payload) || {};
    const blocks = Array.isArray(payload.blocks) ? payload.blocks : [];
    const total = Number(payload.chain_height ?? 0) + 1;
    const pageStart = Math.min(offset, blocks.length);
    const pageEnd = Math.min(offset + limit, total);
    const selectedBlocks = blocks.slice(pageStart, pageEnd).map((block) => ({
      height: toNullable(block.height),
      hash: toNullable(block.hash),
      previousHash: toNullable(block.prev_block_hash),
      timestamp: toNullable(block.timestamp),
      transactions: toNullable(block.tx_count),
      size: null,
      validator: null,
      difficulty: null,
      nonce: null,
      type: 'standard',
      reward: null,
      gasUsed: null,
      gasLimit: null,
    }));

    const page = Math.floor(offset / limit) + 1;
    const totalPages = total > 0 ? Math.ceil(total / limit) : 0;
    res.json({
      success: true,
      blocks: selectedBlocks,
      data: selectedBlocks,
      total,
      pagination: {
        page,
        limit,
        offset,
        total,
        totalPages,
        hasNext: pageEnd < (operator ? total : Math.min(total, ANONYMOUS_BLOCK_WINDOW)),
        hasPrev: pageStart > 0,
      },
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error getting blocks', {
      error: error instanceof Error ? error.message : String(error),
    });
    return sendCore4Unavailable(res, error, 'Failed to retrieve blocks');
  }
});

router.get('/blocks/:height', async (req, res) => {
  const height = toInteger(req.params.height, Number.NaN);

  if (!Number.isFinite(height) || height < 0) {
    return res.status(400).json({
      error: true,
      message: 'Invalid block height',
    });
  }

  try {
    const {
      extractCore4Data,
      fetchCore4Json,
      sendCore4Error,
      sendCore4Unavailable,
      toNullable,
    } = await getCore4Client();
    const response = await fetchCore4Json(`/chain/block/${height}`);

    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to retrieve block');
    }

    const block = extractCore4Data(response.payload) || {};

    res.json({
      height: toNullable(block.height),
      hash: toNullable(block.hash),
      previousHash: toNullable(block.prev_block_hash),
      timestamp: toNullable(block.timestamp),
      // backend#1265: the raw transaction list carries sender addresses and raw station ids;
      // anonymous callers get an explicit allowlist projection, the operator bearer the raw list.
      transactions: hasOperatorToken(req)
        ? (Array.isArray(block.transactions) ? block.transactions : [])
        : projectAnonymousBlockTransactions(block.transactions),
      transactionCount: toNullable(block.tx_count),
      size: null,
      validator: null,
      validatorName: null,
      difficulty: toNullable(block.difficulty),
      nonce: toNullable(block.nonce),
      type: 'standard',
      reward: null,
      gasUsed: null,
      gasLimit: null,
      merkleRoot: null,
      stateRoot: null,
      receiptsRoot: null,
      extraData: null,
      // backend#1222: per-address reward entries are aggregated for
      // anonymous callers; the operator bearer sees the raw metadata.
      metadata: hasOperatorToken(req)
        ? toNullable(block.metadata)
        : toNullable(redactRewardEntriesMetadata(block.metadata)),
      version: toNullable(block.version),
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error getting block', {
      error: error instanceof Error ? error.message : String(error),
      height: req.params.height,
    });
    return sendCore4Unavailable(res, error, 'Failed to retrieve block');
  }
});

router.get('/transactions', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Transaction listing is not available from the core4 launch API.'
  );
});

const TX_HASH_RE = /^(?:0x)?([0-9a-fA-F]{64})$/;
// core4's TransactionType is a fieldless enum; only these names pass through.
const TX_TYPE_RE = /^[A-Za-z][A-Za-z0-9]{0,63}$/;
const TX_STATUSES = new Set(['pending', 'included', 'unknown']);

// Public lookup of one transaction by hash (the website's tx links). core4
// GET /transactions/{tx_id}/status answers only status, block height and type
// within the node's retained window; this route passes exactly those fields,
// plus that block's timestamp from the light header. No sender, recipient,
// amount, payload or station field crosses (none is in the upstream answer).
router.get('/transactions/:hash', async (req, res) => {
  const match = TX_HASH_RE.exec(String(req.params.hash ?? ''));
  if (!match) {
    return res.status(400).json({
      success: false,
      error: { code: 'VALIDATION_ERROR', message: 'A transaction hash is 64 hex characters' },
    });
  }
  const txId = match[1].toLowerCase();

  try {
    const { extractCore4Data, fetchCore4Json, sendCore4Error } = await getCore4Client();
    const headers = readerAuthHeaders(req.headers);
    const response = await fetchCore4Json(`/transactions/${txId}/status`, { headers });
    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to look up transaction');
    }
    const data = extractCore4Data(response.payload) || {};
    const status = TX_STATUSES.has(data.status) ? data.status : 'unknown';
    const blockHeight =
      status === 'included' && Number.isSafeInteger(data.block_height) && data.block_height >= 0
        ? data.block_height
        : null;
    const txType =
      status !== 'unknown' && typeof data.tx_type === 'string' && TX_TYPE_RE.test(data.tx_type)
        ? data.tx_type
        : null;

    let timestamp = null;
    if (blockHeight !== null) {
      // Optional: a missing header must not fail the lookup.
      const header = await fetchCore4Json(`/chain/header/${blockHeight}`, { headers }).catch(() => null);
      const headerData = header?.ok ? extractCore4Data(header.payload) || {} : {};
      // LightHeaderResponse { header: { timestamp: RFC 3339 } }
      const raw = headerData.header?.timestamp;
      const ms = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
      if (Number.isFinite(ms)) timestamp = new Date(ms).toISOString();
    }

    return res.json({
      success: true,
      data: {
        hash: `0x${txId}`,
        status,
        blockHeight,
        txType,
        timestamp,
        // The node only searches its retained blocks and mempool: "unknown"
        // means "not found here", not "never existed".
        windowLimited: true,
      },
    });
  } catch (error) {
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error looking up transaction', {
      error: error instanceof Error ? error.message : String(error),
    });
    return sendCore4Unavailable(res, error, 'Failed to look up transaction');
  }
});

router.get('/validators', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Validator listing is not available from the core4 launch API.'
  );
});

router.get('/validators/:address', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Validator detail lookup is not available from the core4 launch API.'
  );
});

router.get('/stats', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Legacy token-market blockchain stats are not available from the core4 launch API.'
  );
});

module.exports = router;
