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
    const [blockchainResponse, networkResponse, miningResponse, stakeResponse] =
      await Promise.all([
        fetchCore4Json('/blockchain', { headers }),
        fetchCore4Json('/network/info', { headers }),
        fetchCore4Json('/mining/stats', { headers }),
        fetchCore4Json('/transactions/stake/metrics', { headers }),
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
      upgradeScheduled: false,
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

router.get('/transactions/:hash', async (_req, res) => {
  const { sendNotImplemented } = await getCore4Client();
  return sendNotImplemented(
    res,
    'Transaction lookup by hash is not available from the core4 launch API.'
  );
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
