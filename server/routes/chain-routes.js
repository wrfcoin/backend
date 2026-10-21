/**
 * Chain Routes — ERC-4337 User Operation Submission
 *
 * Provides the /chain/submit-userop endpoint consumed by the mobile app's
 * wallet send flow.  The mobile builds an ERC-4337 userOp, optionally
 * sponsors gas via /api/gas/sponsor, then submits it here.
 *
 * The route relays the operation to the configured bundler before persisting a
 * submitted record locally.
 *
 * Cross-repo fix for wrfcoin/mobile#62.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { blockchainLogger } = require('../utils/logger');
const {
  relayUserOperationToBundler,
  DEFAULT_ENTRY_POINT_ADDRESS,
} = require('../services/userop-bundler-service');

// All chain operations require authentication.
router.use(requireAuth);

function parseTransactionAmount(amount) {
  if (typeof amount === 'number' && Number.isFinite(amount)) {
    return Math.trunc(amount);
  }

  if (typeof amount === 'bigint') {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    return amount <= max ? Number(amount) : 0;
  }

  if (typeof amount === 'string') {
    const trimmed = amount.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed)) {
      try {
        const parsed = BigInt(trimmed);
        const max = BigInt(Number.MAX_SAFE_INTEGER);
        return parsed <= max ? Number(parsed) : 0;
      } catch {
        return 0;
      }
    }

    if (/^\d+$/.test(trimmed)) {
      const parsed = Number(trimmed);
      return Number.isSafeInteger(parsed) ? parsed : 0;
    }
  }

  return 0;
}

/**
 * POST /api/chain/submit-userop
 *
 * Accepts an ERC-4337 user operation, relays it to the configured bundler,
 * and returns the bundler-issued userOpHash.
 *
 * Request body:
 *   { userOp: { sender, to, amount, memo?, callData, nonce, hash, entryPoint? } }
 *
 * Response:
 *   { userOpHash: "0x...", status: "submitted", timestamp: "..." }
 */
router.post('/submit-userop', async (req, res) => {
  try {
    const { userOp } = req.body;

    if (!userOp || !userOp.sender || !userOp.to) {
      return res.status(400).json({
        success: false,
        error: { code: 'INVALID_USEROP', message: 'userOp must include sender and to fields' },
      });
    }

    blockchainLogger.info('UserOp submitted', {
      service: 'chain-routes',
      sender: userOp.sender,
      to: userOp.to,
      nonce: userOp.nonce,
    });

    const relayResult = await relayUserOperationToBundler(userOp);
    const userOpHash = relayResult.userOpHash;
    const entryPoint = relayResult.entryPoint || DEFAULT_ENTRY_POINT_ADDRESS;

    // In testnet, persist to the transactions table if the DB is available.
    try {
      const { pool } = require('../db');
      await pool.query(
        `INSERT INTO transactions (
           tx_id,
           from_address,
           to_address,
           amount,
           fee,
           status,
           type,
           block_id,
           data,
           timestamp
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, NULL, $8, NOW())
         ON CONFLICT (tx_id) DO UPDATE SET
           from_address = EXCLUDED.from_address,
           to_address = EXCLUDED.to_address,
           amount = EXCLUDED.amount,
           fee = EXCLUDED.fee,
           status = EXCLUDED.status,
           type = EXCLUDED.type,
           data = EXCLUDED.data,
           timestamp = EXCLUDED.timestamp`,
        [
          userOpHash,
          userOp.sender,
          userOp.to,
          parseTransactionAmount(userOp.amount),
          0,
          'submitted',
          'userop',
          JSON.stringify({
            userOp: {
              ...userOp,
              entryPoint,
            },
            bundler: {
              entryPoint,
              userOpHash,
              relayStatus: 'submitted',
            },
          }),
        ],
      );
    } catch (dbError) {
      // Non-fatal — the hash is still returned.
      blockchainLogger.warn('Failed to persist userOp to DB', { error: dbError.message });
    }

    res.json({
      userOpHash,
      status: 'submitted',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    blockchainLogger.error('Error submitting userOp', {
      error: {
        message: error.message,
        stack: error.stack,
        code: error.code,
      },
    });

    if (error.code === 'BUNDLER_RPC_URL_MISSING' || error.code === 'FETCH_UNAVAILABLE') {
      return res.status(503).json({
        success: false,
        error: {
          code: error.code,
          message: 'Bundler relay is not configured',
        },
      });
    }

    if (error.code === 'BUNDLER_TIMEOUT' || error.code === 'BUNDLER_RELAY_FAILED' || error.code === 'BUNDLER_INVALID_RESPONSE') {
      return res.status(502).json({
        success: false,
        error: {
          code: error.code,
          message: 'Failed to relay user operation to bundler',
          details: error.message,
        },
      });
    }

    res.status(500).json({
      success: false,
      error: { code: 'USEROP_SUBMIT_FAILED', message: 'Failed to submit user operation' },
    });
  }
});

module.exports = router;
