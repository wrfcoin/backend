/**
 * RPC API Routes
 *
 * These routes handle RPC operations for external applications and services
 * to interact with the Wrfcoin node. These endpoints require authentication.
 * All method handlers proxy to core4 or return explicit 501s.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { isLaunchAddress } = require('./wallet-transfer-contract');
const { core4ReaderHeaders, core4TraceHeaders, READER_UNCONFIGURED } = require('../utils/core4-reader-credential');
const { RPC_METHOD_POLICY } = require('./rpc-method-policy');
const { logger } = require('../utils/logger');
const { logLocation, redactCoordinateText } = require('../utils/log-coordinates');
const {
  verifyRpcApiKey,
  rpcRateLimiter,
  logRpcAccess,
} = require('../middleware/rpcAuthMiddleware');
const NOAAWeatherService = require('../services/noaa-nws-api-service');

const noaaWeatherService = new NOAAWeatherService();

function assertWalletOwner(req, address) {
  if (!address) throw new Error('Missing required parameter: address');
  if (!isLaunchAddress(address)) {
    throw Object.assign(new Error('address must be a 20-byte 0x-hex address'), { code: -32602 });
  }
  // role=wallet is minted only after wallet-login signature verification.
  if (req.user?.role !== 'wallet' || !isLaunchAddress(req.user?.sub)) {
    throw Object.assign(new Error('Verified wallet identity required'), { code: 'RPC_WALLET_IDENTITY_REQUIRED' });
  }
  if (req.user.sub.toLowerCase() !== address.toLowerCase()) {
    throw Object.assign(new Error('Wallet address is not owned by the caller'), { code: 'RPC_WALLET_ADDRESS_FORBIDDEN' });
  }
}

function isSafeRpcClientError(error) {
  return (
    error instanceof Error &&
    error.message.startsWith('Missing required parameter:')
  );
}

function buildRpcExecutionError(id, error) {
  const policyErrors = new Map([
    [READER_UNCONFIGURED, [503, -32000, 'Core4 Reader credential is not configured']],
    ['RPC_WALLET_IDENTITY_REQUIRED', [403, -32003, 'A verified wallet login is required for balance reads']],
    ['RPC_WALLET_ADDRESS_FORBIDDEN', [403, -32003, 'Forbidden: you may read only your own wallet balance']],
  ]);
  const policy = policyErrors.get(error?.code);
  if (policy) {
    return {
      statusCode: policy[0],
      body: { jsonrpc: '2.0', id, error: {
        code: policy[1], message: policy[2], data: { code: error.code },
      } },
    };
  }

  if (error && error.code === -32601) {
    return {
      statusCode: 501,
      body: {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: 'Not implemented',
        },
      },
    };
  }

  if (isSafeRpcClientError(error) || (error && error.code === -32602)) {
    return {
      statusCode: 400,
      body: {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32602,
          message: 'Invalid params',
          data: error.message,
        },
      },
    };
  }

  return {
    statusCode: 400,
    body: {
      jsonrpc: '2.0',
      id,
      error: {
        code: typeof error?.code === 'number' ? error.code : -32603,
        message: 'Internal error',
      },
    },
  };
}

// Apply middleware to all RPC routes
router.use(rpcRateLimiter);
router.use(verifyRpcApiKey);
router.use(logRpcAccess);

let core4ClientPromise = null;
async function getCore4Client() {
  if (!core4ClientPromise) {
    core4ClientPromise = import('../../shared/core4-route-client.js');
  }
  return core4ClientPromise;
}

/**
 * Handle JSON-RPC call
 */
// The shared RPC API key proves service access, not control of a wallet.
router.post('/', (req, res, next) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || typeof req.body.method !== 'string') {
    return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
  }
  if (Object.hasOwn(RPC_METHOD_POLICY, req.body.method) && RPC_METHOD_POLICY[req.body.method] === 'owner-reader') {
    return requireAuth(req, res, () => {
      try { assertWalletOwner(req, req.body.params); return next(); }
      catch (error) {
        const result = buildRpcExecutionError(req.body.id ?? null, error);
        return res.status(result.statusCode).json(result.body);
      }
    });
  }
  return next();
}, async (req, res) => {
  const { jsonrpc, method, params, id } = req.body || {};

  // Validate RPC call format
  if (jsonrpc !== '2.0' || typeof method !== 'string' || !method || !id || Array.isArray(req.body)) {
    return res.status(400).json({
      jsonrpc: '2.0',
      id: id || null,
      error: {
        code: -32600,
        message: 'Invalid Request',
        data: 'Request must follow JSON-RPC 2.0 specification',
      },
    });
  }

  try {
    const {
      fetchCore4Json,
      extractCore4Data,
    } = await getCore4Client();

    // Define allowed methods and their handlers
    const rpcMethods = {
      'blockchain.getStatus': async () => {
        const headers = core4ReaderHeaders(req.headers);
        const [syncRes, networkRes, miningRes] = await Promise.all([
          fetchCore4Json('/node/sync/status', { headers }),
          fetchCore4Json('/network/info', { headers }),
          fetchCore4Json('/mining/stats', { headers }),
        ]);
        if (!syncRes.ok || !networkRes.ok || !miningRes.ok) {
          throw Object.assign(new Error('core4 unavailable'), { code: -32603 });
        }
        const sync = extractCore4Data(syncRes.payload) || {};
        const network = extractCore4Data(networkRes.payload) || {};
        const mining = extractCore4Data(miningRes.payload) || {};
        return {
          network: process.env.NETWORK_MODE || 'testnet',
          blockHeight: sync.chain_height ?? mining.chain_height ?? null,
          blockTime: mining.avg_block_time_secs ?? null,
          difficulty: mining.difficulty ?? null,
          hashrate: null,
          activeValidators: network.peer_count ?? null,
        };
      },

      'blockchain.getBlock': async blockHeight => {
        if (blockHeight === undefined || blockHeight === null) {
          throw new Error('Missing required parameter: blockHeight');
        }
        // core4 launch_api exposes block-by-height at /chain/block/{height}
        // (routes/mod.rs:34). There is no /api/v1/* surface. Mirror the REST
        // handler in blockchain-routes.js, which reads the chain_block_detail
        // shape (prev_block_hash, tx_count; no size/validator fields). (#851)
        const response = await fetchCore4Json(`/chain/block/${encodeURIComponent(blockHeight)}`, { headers: core4ReaderHeaders(req.headers) });
        if (!response.ok) {
          throw Object.assign(new Error('core4 unavailable'), { code: -32603 });
        }
        const data = extractCore4Data(response.payload) || {};
        return {
          height: data.height ?? blockHeight,
          hash: data.hash ?? null,
          previousHash: data.prev_block_hash ?? null,
          timestamp: data.timestamp ?? null,
          transactions: data.tx_count ?? null,
          size: null,
          validator: null,
          difficulty: data.difficulty ?? null,
          nonce: data.nonce ?? null,
        };
      },

      // #444: /addresses/:address exists on core4
      'wallet.getBalance': async address => {
        assertWalletOwner(req, address);
        const response = await fetchCore4Json(`/addresses/${encodeURIComponent(address)}`, {
          headers: core4ReaderHeaders(req.headers),
        });
        if (!response.ok) {
          throw Object.assign(new Error('core4 unavailable'), { code: -32603 });
        }
        const data = extractCore4Data(response.payload) || {};
        return {
          address,
          balance: data.spendable_balance ?? data.balance ?? null,
          pendingBalance: data.pending_balance ?? null,
          stakedBalance: data.stake_locked ?? data.staked_balance ?? null,
          lastUpdated: new Date().toISOString(),
        };
      },

      'tx.submit': async signedTx => {
        if (!signedTx || typeof signedTx !== 'object' || Array.isArray(signedTx)) {
          throw new Error('Missing required parameter: signedTx must be a signed-transaction object');
        }
        // core4 PermissionlessSubmitRequest (transactions.rs:64-71) requires
        // 6 flat, non-optional fields. actix's web::Json extractor rejects a
        // {signed_tx} wrapper with 400 before the handler runs, so the RPC
        // layer must spread the signed-tx envelope into those fields. (#852)
        const requiredFields = [
          'signer_public_key',
          'signature',
          'nonce',
          'timestamp',
          'tx_type',
          'payload',
        ];
        for (const field of requiredFields) {
          if (signedTx[field] === undefined || signedTx[field] === null) {
            throw new Error(`Missing required parameter: signedTx.${field}`);
          }
        }
        // core4 (transactions.rs:266) rejects any tx_type whose
        // trimmed/lowercased value != "data_analysis" with a 422
        // UNPROCESSABLE_ENTITY. Forwarding an arbitrary tx_type would surface
        // as an opaque -32603 Internal error, so reject up front with an
        // actionable -32602 Invalid params (do NOT silently rewrite). (#852)
        if (String(signedTx.tx_type).trim().toLowerCase() !== 'data_analysis') {
          const err = new Error(
            "tx_type must be 'data_analysis' for the permissionless submit lane"
          );
          err.code = -32602;
          throw err;
        }
        const response = await fetchCore4Json('/transactions/permissionless/submit', {
          method: 'POST',
          headers: core4TraceHeaders(req.headers),
          body: {
            signer_public_key: signedTx.signer_public_key,
            signature: signedTx.signature,
            nonce: signedTx.nonce,
            timestamp: signedTx.timestamp,
            tx_type: signedTx.tx_type,
            payload: signedTx.payload,
          },
        });
        if (!response.ok) {
          throw Object.assign(new Error('core4 unavailable'), { code: -32603 });
        }
        const data = extractCore4Data(response.payload) || {};
        return {
          txHash: data.hash ?? null,
          accepted: data.accepted ?? true,
          timestamp: new Date().toISOString(),
        };
      },

      'oracle.getForecast': async params => {
        if (!params || !params.location) {
          throw new Error('Missing required parameter: location');
        }

        // Parse location: accept {latitude, longitude} object or "lat,lng" string
        let latitude, longitude;
        if (typeof params.location === 'string') {
          const parts = params.location.split(',').map(s => parseFloat(s.trim()));
          if (parts.length !== 2 || isNaN(parts[0]) || isNaN(parts[1])) {
            throw new Error('Missing required parameter: location must be "lat,lng" or {latitude, longitude}');
          }
          [latitude, longitude] = parts;
        } else if (typeof params.location === 'object') {
          latitude = parseFloat(params.location.latitude);
          longitude = parseFloat(params.location.longitude);
        }

        if (isNaN(latitude) || isNaN(longitude)) {
          throw new Error('Missing required parameter: location must contain valid latitude and longitude');
        }

        try {
          const forecast = await noaaWeatherService.getForecast(latitude, longitude);
          return {
            source: 'noaa-nws',
            forecast,
            timestamp: new Date().toISOString(),
          };
        } catch (forecastErr) {
          // backend#1324: a caller's position is never logged finer than 0.1 deg,
          // and upstream error text (which echoes the requested point) is redacted.
          logger.error('oracle.getForecast failed', {
            location: logLocation(latitude, longitude),
            error: redactCoordinateText(forecastErr.message),
          });
          const err = new Error(`Forecast retrieval failed: ${forecastErr.message}`);
          err.code = -32603;
          throw err;
        }
      },
    };

    // Validate that the requested method exists
    if (!Object.hasOwn(rpcMethods, method) || !Object.hasOwn(RPC_METHOD_POLICY, method)) {
      return res.status(404).json({
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: 'Method not found',
          data: `The method '${method}' is not supported`,
        },
      });
    }

    // Execute the method
    try {
      const result = await rpcMethods[method](params);

      // Return successful result
      res.json({
        jsonrpc: '2.0',
        id,
        result,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error(`RPC method execution error: ${method}`, {
        error: redactCoordinateText(errorMessage),
      });

      const rpcError = buildRpcExecutionError(id, error);
      res.status(rpcError.statusCode).json(rpcError.body);
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('RPC request processing error', { error: errorMessage });

    res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32700,
        message: 'Parse error',
      },
    });
  }
});

/**
 * Get list of available RPC methods
 */
router.get('/methods', async (req, res) => {
  try {
    // Return list of supported RPC methods with descriptions
    const methods = [
      {
        name: 'blockchain.getStatus',
        description: 'Get current blockchain status',
        params: [],
        returns: 'Blockchain status object',
      },
      {
        name: 'blockchain.getBlock',
        description: 'Get block details by height',
        params: [
          {
            name: 'blockHeight',
            type: 'number',
            description: 'Block height',
          },
        ],
        returns: 'Block object',
      },
      {
        name: 'wallet.getBalance',
        description: 'Get wallet balance',
        params: [
          {
            name: 'address',
            type: 'string',
            description: 'Wallet address',
          },
        ],
        returns: 'Balance object',
      },
      {
        name: 'tx.submit',
        description: 'Submit a signed permissionless transaction',
        params: [
          {
            name: 'signedTx',
            type: 'object',
            description:
              'Signed permissionless transaction envelope with the fields ' +
              'required by core4 PermissionlessSubmitRequest',
            properties: {
              signer_public_key: { type: 'string', description: 'Hex-encoded ed25519 public key' },
              signature: { type: 'string', description: 'Hex-encoded ed25519 signature' },
              nonce: { type: 'string', description: 'Account nonce' },
              timestamp: { type: 'number', description: 'Unix timestamp (i64 seconds)' },
              tx_type: { type: 'string', description: "Must be 'data_analysis' for the permissionless submit lane (core4 rejects any other value)" },
              payload: { type: 'object', description: 'Transaction payload' },
            },
          },
        ],
        returns: 'Transaction submission result',
      },
      {
        name: 'oracle.getForecast',
        description: 'Get weather forecast from oracle network (not yet implemented)',
        params: [
          {
            name: 'params',
            type: 'object',
            properties: {
              location: {
                type: 'string',
                description: 'Location name or coordinates',
              },
              units: {
                type: 'string',
                description: 'Units (metric/imperial)',
                optional: true,
              },
            },
          },
        ],
        returns: 'Forecast data object',
      },
    ];

    res.json({
      methods,
      count: methods.length,
      jsonrpcVersion: '2.0',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Error getting RPC methods', { error: errorMessage });
    res.status(500).json({
      error: true,
      message: 'Failed to retrieve RPC methods',
    });
  }
});

/**
 * Get RPC health status
 */
router.get('/health', async (req, res) => {
  try {
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      apiVersion: '1.0.0',
      rpcVersion: '2.0',
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error('Error getting RPC health status', { error: errorMessage });
    res.status(500).json({
      error: true,
      message: 'Failed to retrieve RPC health status',
    });
  }
});

module.exports = router;
