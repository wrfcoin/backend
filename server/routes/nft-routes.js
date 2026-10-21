/**
 * NFT API Routes
 *
 * This module provides routes for interacting with NFTs in the Wrfcoin network.
 * Data is proxied from core4. Capabilities without a canonical upstream fail
 * closed with the standard authenticated NOT_IMPLEMENTED envelope.
 */

const express = require('express');
const router = express.Router();
const { core4ReaderHeaders, sendReaderCredentialUnavailable, READER_UNCONFIGURED } =
  require('../utils/core4-reader-credential');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { core4OperatorHeaders, adminBodyOrConfig, requireValidNftId, requireConfiguredNft, auditedAdminWrite, sendAdminPolicyError } = require('../utils/core4-admin-policy');
const { logger } = require('../utils/logger');
const { createErrorResponse } = require('../utils/error-response');
const { sendNotWired } = require('../utils/honest-gap');
const {
  generalLimiter,
  transferLimiter,
} = require('../../middleware/rateLimiting');

// All NFT operations require authentication (#231)
router.use(requireAuth);
// Rate limit NFT API endpoints (#237)
router.use(generalLimiter);

let core4ClientPromise = null;
async function getCore4Client() {
  if (!core4ClientPromise) {
    core4ClientPromise = import('../../shared/core4-route-client.js');
  }
  return core4ClientPromise;
}

function toPositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toNonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function getListPagination(req) {
  const limit = toPositiveInteger(req.query.limit, 20);
  const pageQuery = Number.parseInt(String(req.query.page ?? ''), 10);
  const page =
    Number.isFinite(pageQuery) && pageQuery > 0
      ? pageQuery
      : 1;
  // core4 pages by offset. Keep the legacy page input only as an alias when
  // no explicit offset is supplied, so conflicting inputs cannot repeat pages.
  const offset = req.query.offset === undefined
    ? (page - 1) * limit
    : toNonNegativeInteger(req.query.offset, 0);

  return { limit, offset };
}

// Get all NFTs
router.get('/', async (req, res) => {
  try {
    const {
      extractCore4Data,
      fetchCore4Json,
      sendCore4Error,
      sendCore4Unavailable,
    } = await getCore4Client();

    const { limit, offset } = getListPagination(req);
    const response = await fetchCore4Json('/nft/list', {
      headers: core4ReaderHeaders(req.headers),
      query: { offset, limit },
    });

    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to fetch NFTs');
    }

    const data = extractCore4Data(response.payload) || {};
    if (!Array.isArray(data.items)
        || !Number.isSafeInteger(data.total) || data.total < 0
        || !Number.isSafeInteger(data.limit) || data.limit <= 0
        || !Number.isSafeInteger(data.offset) || data.offset < 0) {
      return res.status(502).json(createErrorResponse(
        'Invalid NFT list response from core4', 'CORE4_INVALID_RESPONSE',
      ));
    }

    res.json({
      success: true,
      data: data.items,
      pagination: {
        limit: data.limit,
        offset: data.offset,
        total: data.total,
        hasNext: data.offset + data.limit < data.total,
        hasPrev: data.offset > 0,
      },
    });
  } catch (error) {
    if (error?.code === READER_UNCONFIGURED) return sendReaderCredentialUnavailable(res);
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error getting NFTs', { code: 'CORE4_UNAVAILABLE' });
    return sendCore4Unavailable(res, error, 'Failed to retrieve NFTs');
  }
});

// Get NFT by ID
router.get('/:id', async (req, res) => {
  try {
    const {
      extractCore4Data,
      fetchCore4Json,
      sendCore4Error,
      sendCore4Unavailable,
    } = await getCore4Client();

    const { id } = req.params;
    const response = await fetchCore4Json(`/nft/${encodeURIComponent(id)}`, {
      headers: core4ReaderHeaders(req.headers),
    });

    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to fetch NFT');
    }

    const data = extractCore4Data(response.payload);
    res.json(data ?? { id });
  } catch (error) {
    if (error?.code === READER_UNCONFIGURED) return sendReaderCredentialUnavailable(res);
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error getting NFT', {
      code: 'CORE4_UNAVAILABLE',
      id: req.params.id,
    });
    return sendCore4Unavailable(res, error, 'Failed to retrieve NFT');
  }
});

// Create new NFT
router.post('/', requireAdmin, transferLimiter, async (req, res) => {
  try {
    const { payload, source } = adminBodyOrConfig('WRFCOIN_ADMIN_NFT_MINT_CONFIG', req.body);

    const {
      extractCore4Data,
      fetchCore4Json,
      sendCore4Error,
      sendCore4Unavailable,
    } = await getCore4Client();

    const headers = core4OperatorHeaders(req.headers);
    const audit = { source, nftId: payload.id, owner: payload.owner };
    const response = await auditedAdminWrite(req, 'nft.mint', audit, () => fetchCore4Json('/nft/mint', {
      method: 'POST',
      headers,
      body: payload,
    }));

    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to create NFT');
    }

    const data = extractCore4Data(response.payload);
    res.status(201).json(data ?? null);
  } catch (error) {
    if (sendAdminPolicyError(res, error)) return;
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error creating NFT', { code: 'CORE4_UNAVAILABLE' });
    return sendCore4Unavailable(res, error, 'Failed to create NFT');
  }
});

// Transfer NFT
router.post('/:id/transfer', requireAdmin, transferLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const { payload: supplied, source } = adminBodyOrConfig('WRFCOIN_ADMIN_NFT_TRANSFER_CONFIG', req.body);
    // A body-supplied transfer acts on the (validated) URL id; the configured
    // payload keeps its own id and the URL must match it.
    if (source === 'config') requireConfiguredNft(id, supplied.id); else requireValidNftId(id);
    const recipient = supplied.to;

    const {
      extractCore4Data,
      fetchCore4Json,
      sendCore4Error,
      sendCore4Unavailable,
    } = await getCore4Client();

    const headers = core4OperatorHeaders(req.headers);
    const audit = { source, nftId: id, to: recipient };
    const response = await auditedAdminWrite(req, 'nft.transfer', audit, () => fetchCore4Json(
      `/nft/${encodeURIComponent(id)}/transfer`,
      {
        method: 'POST',
        headers,
        body: { to: recipient },
      },
    ));

    if (!response.ok) {
      return sendCore4Error(res, response, 'Failed to transfer NFT');
    }

    const data = extractCore4Data(response.payload) || {};
    res.json(
      data ?? {
        id,
        owner: recipient,
        status: 'pending',
      },
    );
  } catch (error) {
    if (sendAdminPolicyError(res, error)) return;
    const { sendCore4Unavailable } = await getCore4Client();
    logger.error('Error transferring NFT', {
      code: 'CORE4_UNAVAILABLE',
      id: req.params.id,
    });
    return sendCore4Unavailable(res, error, 'Failed to transfer NFT');
  }
});

/**
 * Execute computational NFT
 *
 * No canonical executor is wired to the mounted NFT router. Never derive an
 * execution result, gas usage, or proof from request data.
 *
 * @route POST /nft/:id/execute
 * @param {string} id - NFT identifier
 * @body {object} params - Computation parameters (inputData, computeType, etc.)
 * @returns {{ success: boolean, data: object, timestamp: string }}
 */
router.post('/:id/execute', transferLimiter, async (req, res) => {
  return sendNotWired(res, {
    capability: 'computational-nft.execute',
    message: 'Computational NFT execution is not available.',
    details:
      'No canonical executor is wired to the mounted NFT router; request data cannot stand in for execution evidence.',
    see: 'wrfcoin/backend#1150',
  });
});

/**
 * Get execution proof / verification status for a computational NFT.
 *
 * No canonical execution ledger is wired, so the route cannot infer proof or
 * status from a prior in-memory response or the NFT identifier.
 */
router.get('/:id/verify', async (req, res) => {
  return sendNotWired(res, {
    capability: 'computational-nft.verification-status',
    message: 'Computational NFT verification status is not available.',
    details: 'No canonical executor or proof ledger is wired to this route.',
    see: 'wrfcoin/backend#1150',
  });
});

/**
 * Verify a computational/data NFT.
 *
 * No canonical verifier is wired. Never derive truth, confidence, verifier
 * identity, or a verification hash from request fields.
 */
router.post('/:id/verify', transferLimiter, async (req, res) => {
  return sendNotWired(res, {
    capability: 'computational-nft.verify',
    message: 'Computational NFT verification is not available.',
    details:
      'No canonical verifier is wired to the mounted NFT router; request hashing is not verification evidence.',
    see: 'wrfcoin/backend#1150',
  });
});

module.exports = router;
