/**
 * Oracle Network Routes
 *
 * This file defines the API routes for the Climate Data Oracle Network.
 */

const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/authMiddleware');
const { createApiError, paginatedResponse, parseListPagination } = require('../utils/api-error');
const { sendNotWired } = require('../utils/honest-gap');
const { generalLimiter, transferLimiter } = require('../../middleware/rateLimiting');

const SIMULATION = process.env.ORACLE_NETWORK_SIMULATION === '1';

// All oracle operations require authentication (#231)
router.use(requireAuth);
// Rate limit oracle API endpoints (#237)
router.use(generalLimiter);
const { db } = require('../db');
const { eq, count } = require('drizzle-orm');
const {
  oracleRequests,
  oracleResponses,
  crossChainBridges,
  validatorOracleParticipation,
  bridgeTransactions,
} = require('../../shared/oracle-schema');
const { blockchainLogger } = require('../utils/logger');

const oracleSuccess = (data) => ({
  success: true,
  data,
});

const oracleError = (statusCode, code, message, details = null) =>
  createApiError(code, message, details);

let oracleNetwork = null;

if (SIMULATION) {
  const { ClimateOracleNetwork } = require('../oracle/climate-oracle-network');
  oracleNetwork = new ClimateOracleNetwork();
  (async () => {
    try {
      await oracleNetwork.initialize();
      blockchainLogger.info('Climate Oracle Network simulation initialized', { service: 'oracle-routes' });
    } catch (error) {
      blockchainLogger.error('Failed to initialize Climate Oracle Network simulation', { service: 'oracle-routes', error: { message: error.message, stack: error.stack } });
    }
  })();
}

function requireOracleNetwork(_req, res, next) {
  if (!SIMULATION) {
    return sendNotWired(res, {
      capability: 'climate-oracle-network',
      message: 'Climate oracle validator transport is not wired',
      details: 'Validator responses and cross-chain bridge results are simulated; no real validator transport exists.',
      see: 'wrfcoin/backend#1170',
    });
  }

  const sendJson = res.json.bind(res);
  res.json = payload => sendJson({ ...payload, simulated: true });
  return next();
}

/**
 * Get all oracle requests
 * GET /api/oracle/requests
 */
router.get('/requests', async (req, res) => {
  try {
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });

    // Get optional status filter from query
    const { status } = req.query;

    let query = db.select().from(oracleRequests);
    let countQuery = db.select({ total: count() }).from(oracleRequests);
    if (status) {
      const statusFilter = eq(oracleRequests.status, status);
      query = query.where(statusFilter);
      countQuery = countQuery.where(statusFilter);
    }

    const [countRow] = await countQuery;
    const requests = await query
      .orderBy(oracleRequests.createdAt, oracleRequests.id)
      .limit(limit)
      .offset(offset);

    res.json(paginatedResponse(requests, Number(countRow?.total ?? 0), page, limit));
  } catch (error) {
    blockchainLogger.error('Error fetching oracle requests', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch oracle requests'));
  }
});

/**
 * Get a specific oracle request by ID
 * GET /api/oracle/requests/:id
 */
router.get('/requests/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [request] = await db
      .select()
      .from(oracleRequests)
      .where(eq(oracleRequests.id, id));

    if (!request) {
      return res.status(404).json(createApiError('NOT_FOUND', 'Oracle request not found'));
    }

    res.json(oracleSuccess(request));
  } catch (error) {
    blockchainLogger.error('Error fetching oracle request', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch oracle request'));
  }
});

/**
 * Create a new oracle request
 * POST /api/oracle/requests
 */
router.post('/requests', transferLimiter, requireOracleNetwork, async (req, res) => {
  try {
    const {
      dataType,
      parameters,
      sourceChain,
      sourceAddress,
      callbackFunction,
      requiredConfidence,
      maxValidatorFee,
      deadline,
      priority,
    } = req.body;

    // Validate request
    if (!dataType || !parameters) {
      return res
        .status(400)
        .json(createApiError('INVALID_REQUEST', 'Data type and parameters are required'));
    }

    // Process the oracle request through the network
    const requestId = await oracleNetwork.createRequest({
      dataType,
      parameters,
      sourceChain,
      sourceAddress,
      callbackFunction,
      requiredConfidence,
      maxValidatorFee,
      deadline,
      priority,
    });

    res.status(201).json(
      oracleSuccess({
        requestId,
        status: 'PENDING',
      })
    );
  } catch (error) {
    blockchainLogger.error('Error creating oracle request', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to create oracle request'));
  }
});

/**
 * Get responses for a specific oracle request
 * GET /api/oracle/requests/:id/responses
 */
router.get('/requests/:id/responses', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });
    const responseFilter = eq(oracleResponses.requestId, id);
    const responses = await db
      .select()
      .from(oracleResponses)
      .where(responseFilter)
      .orderBy(oracleResponses.respondedAt, oracleResponses.id)
      .limit(limit)
      .offset(offset);

    const [countRow] = await db
      .select({ total: count() })
      .from(oracleResponses)
      .where(responseFilter);

    res.json(paginatedResponse(responses, Number(countRow?.total ?? 0), page, limit));
  } catch (error) {
    blockchainLogger.error('Error fetching oracle responses', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch oracle responses'));
  }
});

/**
 * Get validator participations for a specific oracle request
 * GET /api/oracle/requests/:id/participations
 */
router.get('/requests/:id/participations', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });
    const participationFilter = eq(validatorOracleParticipation.requestId, id);
    const participations = await db
      .select()
      .from(validatorOracleParticipation)
      .where(participationFilter)
      .orderBy(validatorOracleParticipation.createdAt, validatorOracleParticipation.id)
      .limit(limit)
      .offset(offset);

    const [countRow] = await db
      .select({ total: count() })
      .from(validatorOracleParticipation)
      .where(participationFilter);

    res.json(paginatedResponse(participations, Number(countRow?.total ?? 0), page, limit));
  } catch (error) {
    blockchainLogger.error('Error fetching validator participations', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch validator participations'));
  }
});

/**
 * Cancel an oracle request
 * POST /api/oracle/requests/:id/cancel
 */
router.post('/requests/:id/cancel', transferLimiter, requireOracleNetwork, async (req, res) => {
  try {
    const { id } = req.params;
    const cancelResult = await oracleNetwork.cancelRequest(id);

    if (!cancelResult.success) {
      return res.status(400).json(createApiError('ORACLE_CANCEL_FAILED', cancelResult.error));
    }

    res.json({
      success: true,
      message: 'Oracle request cancelled successfully',
    });
  } catch (error) {
    blockchainLogger.error('Error cancelling oracle request', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to cancel oracle request'));
  }
});

/**
 * Get all oracle responses
 * GET /api/oracle/responses
 */
router.get('/responses', async (req, res) => {
  try {
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });

    // Get optional status filter from query
    const { status } = req.query;

    let query = db.select().from(oracleResponses);
    let countQuery = db.select({ total: count() }).from(oracleResponses);
    if (status) {
      const statusFilter = eq(oracleResponses.status, status);
      query = query.where(statusFilter);
      countQuery = countQuery.where(statusFilter);
    }

    const [countRow] = await countQuery;
    const responses = await query
      .orderBy(oracleResponses.respondedAt, oracleResponses.id)
      .limit(limit)
      .offset(offset);

    res.json(paginatedResponse(responses, Number(countRow?.total ?? 0), page, limit));
  } catch (error) {
    blockchainLogger.error('Error fetching oracle responses', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch oracle responses'));
  }
});

/**
 * Get a specific oracle response by ID
 * GET /api/oracle/responses/:id
 */
router.get('/responses/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const [response] = await db
      .select()
      .from(oracleResponses)
      .where(eq(oracleResponses.id, id));

    if (!response) {
      return res.status(404).json(createApiError('NOT_FOUND', 'Oracle response not found'));
    }

    res.json(oracleSuccess(response));
  } catch (error) {
    blockchainLogger.error('Error fetching oracle response', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch oracle response'));
  }
});

/**
 * Get all cross-chain bridges
 * GET /api/oracle/bridges
 */
router.get('/bridges', async (req, res) => {
  try {
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });

    const [countRow] = await db.select({ total: count() }).from(crossChainBridges);
    const bridges = await db
      .select()
      .from(crossChainBridges)
      .orderBy(crossChainBridges.id)
      .limit(limit)
      .offset(offset);

    res.json(paginatedResponse(bridges, Number(countRow?.total ?? 0), page, limit));
  } catch (error) {
    blockchainLogger.error('Error fetching cross-chain bridges', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch cross-chain bridges'));
  }
});

/**
 * Create a new cross-chain bridge
 * POST /api/oracle/bridges
 */
router.post('/bridges', transferLimiter, requireOracleNetwork, async (req, res) => {
  try {
    const {
      name,
      provider,
      sourceChain,
      targetChain,
      contractAddress,
      providerApiKey,
      config,
      gasLimit,
      maxFeeAmount,
      securityLevel,
      requiresApproval,
      approverRoles,
    } = req.body;

    // Validate request
    if (!name || !provider || !targetChain) {
      return res
        .status(400)
        .json(createApiError('INVALID_REQUEST', 'Name, provider, and target chain are required'));
    }

    const [bridge] = await db
      .insert(crossChainBridges)
      .values({
        name,
        provider,
        sourceChain: sourceChain || 'wrfcoin',
        targetChain,
        contractAddress,
        providerApiKey,
        config,
        gasLimit,
        maxFeeAmount,
        securityLevel,
        requiresApproval,
        approverRoles,
      })
      .returning();

    res.status(201).json(
      oracleSuccess(bridge)
    );
  } catch (error) {
    blockchainLogger.error('Error creating cross-chain bridge', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to create cross-chain bridge'));
  }
});

/**
 * Update a cross-chain bridge
 * PUT /api/oracle/bridges/:id
 */
router.put('/bridges/:id', transferLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      name,
      provider,
      sourceChain,
      targetChain,
      contractAddress,
      providerApiKey,
      status,
      config,
      gasLimit,
      maxFeeAmount,
      securityLevel,
      requiresApproval,
      approverRoles,
    } = req.body;

    // Check if bridge exists
    const [existingBridge] = await db
      .select()
      .from(crossChainBridges)
      .where(eq(crossChainBridges.id, id));

    if (!existingBridge) {
      return res.status(404).json(createApiError('NOT_FOUND', 'Bridge not found'));
    }

    // Update bridge
    const [updatedBridge] = await db
      .update(crossChainBridges)
      .set({
        name,
        provider,
        sourceChain,
        targetChain,
        contractAddress,
        providerApiKey,
        status,
        config,
        gasLimit,
        maxFeeAmount,
        securityLevel,
        requiresApproval,
        approverRoles,
        updatedAt: new Date(),
      })
      .where(eq(crossChainBridges.id, id))
      .returning();

    res.json(oracleSuccess(updatedBridge));
  } catch (error) {
    blockchainLogger.error('Error updating cross-chain bridge', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to update cross-chain bridge'));
  }
});

/**
 * Get transactions for a specific bridge
 * GET /api/oracle/bridges/:id/transactions
 */
router.get('/bridges/:id/transactions', async (req, res) => {
  try {
    const { id } = req.params;
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });
    const transactionFilter = eq(bridgeTransactions.bridgeId, id);
    const transactions = await db
      .select()
      .from(bridgeTransactions)
      .where(transactionFilter)
      .orderBy(bridgeTransactions.timestamp, bridgeTransactions.id)
      .limit(limit)
      .offset(offset);

    const [countRow] = await db
      .select({ total: count() })
      .from(bridgeTransactions)
      .where(transactionFilter);

    res.json(paginatedResponse(transactions, Number(countRow?.total ?? 0), page, limit));
  } catch (error) {
    blockchainLogger.error('Error fetching bridge transactions', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch bridge transactions'));
  }
});

/**
 * Get all bridge transactions
 * GET /api/oracle/bridge-transactions
 */
router.get('/bridge-transactions', async (req, res) => {
  try {
    const { status } = req.query;
    const { limit, offset, page } = parseListPagination(req.query, {
      defaultLimit: 50,
      maxLimit: 200,
    });

    let query = db.select().from(bridgeTransactions);
    let countQuery = db.select({ total: count() }).from(bridgeTransactions);
    if (status) {
      const statusFilter = eq(bridgeTransactions.status, status);
      query = query.where(statusFilter);
      countQuery = countQuery.where(statusFilter);
    }

    const [countRow] = await countQuery;
    const transactions = await query
      .orderBy(bridgeTransactions.timestamp, bridgeTransactions.id)
      .limit(limit)
      .offset(offset);

    res.json(paginatedResponse(transactions, Number(countRow?.total ?? 0), page, limit));
  } catch (error) {
    blockchainLogger.error('Error fetching bridge transactions', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch bridge transactions'));
  }
});

/**
 * Get oracle network metrics
 * GET /api/oracle/metrics
 */
router.get('/metrics', requireOracleNetwork, async (req, res) => {
  try {
    const metrics = await oracleNetwork.getMetrics();
    res.json(oracleSuccess(metrics));
  } catch (error) {
    blockchainLogger.error('Error fetching oracle network metrics', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch oracle network metrics'));
  }
});

/**
 * Get oracle network status
 * GET /api/oracle/status
 */
router.get('/status', requireOracleNetwork, async (req, res) => {
  try {
    // Get network status from the oracle network
    const networkStatus = await oracleNetwork.getStatus();
    res.json(oracleSuccess(networkStatus));
  } catch (error) {
    blockchainLogger.error('Error fetching oracle network status', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch oracle network status'));
  }
});

/**
 * Get oracle validators
 * GET /api/oracle/validators
 */
router.get('/validators', requireOracleNetwork, async (req, res) => {
  try {
    // Get validators from the oracle network
    const validators = await oracleNetwork.getValidators();
    res.json(
      oracleSuccess({
      validators,
      activeCount: validators.filter(v => v.status === 'ACTIVE').length,
    })
    );
  } catch (error) {
    blockchainLogger.error('Error fetching oracle validators', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch oracle validators'));
  }
});

/**
 * Get recent data submissions
 * GET /api/oracle/data-submissions
 */
router.get('/data-submissions', requireOracleNetwork, async (req, res) => {
  try {
    // Get recent data submissions from the oracle network
    const submissions = await oracleNetwork.getRecentDataSubmissions();
    res.json(oracleSuccess(submissions));
  } catch (error) {
    blockchainLogger.error('Error fetching data submissions', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(createApiError('ORACLE_ERROR', 'Failed to fetch data submissions'));
  }
});

// ========== CROSS-CHAIN ORACLE API ENDPOINTS ==========
// Enhanced API endpoints that utilize the integrated RustOracleBridge for cross-chain oracle communication

/**
 * Create a cross-chain oracle request using the Rust Oracle Bridge
 * POST /api/oracle/cross-chain/requests
 *
 * This endpoint creates enhanced oracle requests that leverage the Rust blockchain core
 * with liquid democracy validation and cross-chain consensus capabilities.
 */
router.post('/cross-chain/requests', transferLimiter, requireOracleNetwork, async (req, res) => {
  try {
    const {
      dataType,
      parameters,
      sourceChain,
      targetChain,
      sourceAddress,
      callbackFunction,
      requiredConfidence,
      maxValidatorFee,
      deadline,
      priority,
      validatorRequirements,
      crossChainContext,
    } = req.body;

    // Validate required fields for cross-chain requests
    if (!dataType || !parameters || !sourceChain || !targetChain) {
    return res.status(400).json(
      createApiError(
        'INVALID_REQUEST',
        'Cross-chain requests require dataType, parameters, sourceChain, and targetChain'
      )
    );
    }

    // Validate source address for external chain requests
    if (sourceChain !== 'wrfcoin' && !sourceAddress) {
      return res
        .status(400)
        .json(
          createApiError(
            'INVALID_REQUEST',
            'Source address is required for external chain requests'
          )
        );
    }

    blockchainLogger.info('Cross-chain oracle request', { sourceChain, targetChain });

    // Create the cross-chain oracle request through the enhanced network
    const crossChainResponse = await oracleNetwork.createCrossChainRequest({
      dataType,
      parameters,
      sourceChain,
      targetChain,
      sourceAddress,
      callbackFunction,
      requiredConfidence: requiredConfidence || 0.85,
      maxValidatorFee: maxValidatorFee || 1000,
      deadline: deadline || new Date(Date.now() + 3600000).toISOString(), // 1 hour default
      priority: priority || 5,
    });

    res.status(201).json(
      oracleSuccess({
        requestId: crossChainResponse.requestId,
        result: crossChainResponse.result,
        consensus: {
          achieved: crossChainResponse.consensus.achieved_consensus,
          participating_validators:
            crossChainResponse.consensus.participating_validators,
          delegation_weighted:
            crossChainResponse.consensus.delegation_weighted_consensus,
          byzantine_fault_tolerance:
            crossChainResponse.consensus.byzantine_fault_tolerance,
        },
        execution_metrics: crossChainResponse.executionMetrics,
        liquid_democracy_attestation:
          crossChainResponse.liquidDemocracyAttestation,
        cross_chain_proof: crossChainResponse.crossChainProof,
        bridge_integration: 'rust_oracle_bridge',
      })
    );
  } catch (error) {
    blockchainLogger.error('Error creating cross-chain oracle request', { error: { message: error.message, stack: error.stack } });

    // Provide specific error information for debugging
    const details = {
      details: error.message,
    };

    // Check if it's a bridge availability error and suggest fallback
    if (error.message && error.message.includes('not available')) {
      details.fallbackAvailable = true;
      details.suggestion =
        'Consider using standard oracle request endpoint as fallback';
    }

    res.status(500).json(
      createApiError(
        'CROSS_CHAIN_REQUEST_FAILED',
        'Failed to create cross-chain oracle request',
        details
      )
    );
  }
});

/**
 * Get Rust Oracle Bridge status and health metrics
 * GET /api/oracle/cross-chain/bridge-status
 *
 * Returns detailed information about the Rust Oracle Bridge connection,
 * performance metrics, and current operational status.
 */
router.get('/cross-chain/bridge-status', requireOracleNetwork, async (req, res) => {
  try {
    // Get bridge status from the oracle network
    const bridgeStatus = oracleNetwork.rustOracleBridge
      ? oracleNetwork.rustOracleBridge.getStatus()
      : null;

    if (!bridgeStatus) {
      return res.json(
        oracleSuccess({
          connected: false,
          status: 'not_initialized',
          message: 'Rust Oracle Bridge not initialized',
          fallback_mode: true,
        })
      );
    }

    // Get performance metrics
    const performanceMetrics =
      oracleNetwork.rustOracleBridge.getPerformanceMetrics();

    // Check bridge health
    const isHealthy = oracleNetwork.rustOracleBridge.isHealthy();

    res.json(
      oracleSuccess({
        connected: bridgeStatus.connected,
        healthy: isHealthy,
        pending_requests: bridgeStatus.pendingRequests,
        rust_process_pid: bridgeStatus.rustProcessPid,
        performance_metrics: {
          average_response_time: performanceMetrics.averageResponseTime,
          total_requests_processed: performanceMetrics.requestCount,
          success_rate:
            performanceMetrics.requestCount > 0
              ? (
                  ((performanceMetrics.requestCount -
                    bridgeStatus.pendingRequests) /
                    performanceMetrics.requestCount) *
                  100
                ).toFixed(2) + '%'
              : 'N/A',
        },
        capabilities: {
          liquid_democracy_integration: true,
          cross_chain_consensus: true,
          byzantine_fault_tolerance: true,
          validator_performance_weighting: true,
          delegation_chain_validation: true,
        },
        supported_computation_types: [
          'Weather',
          'Finance',
          'Scientific',
          'MachineLearning',
          'DataAnalysis',
        ],
        supported_bridge_protocols: [
          'LayerZero',
          'IBC',
          'Axelar',
          'Wormhole',
          'Polygon PoS Bridge',
        ],
      })
    );
  } catch (error) {
    blockchainLogger.error('Error fetching bridge status', { error: { message: error.message, stack: error.stack } });
    res.status(500).json(
      createApiError('ORACLE_ERROR', 'Failed to fetch bridge status', {
        details: error.message,
      })
    );
  }
});

/**
 * Get supported cross-chain networks and bridge protocols
 * GET /api/oracle/cross-chain/networks
 *
 * Returns information about supported blockchain networks and their
 * optimal bridge protocols for cross-chain oracle communication.
 */
router.get('/cross-chain/networks', requireOracleNetwork, async (req, res) => {
  try {
    res.json({
      supported_networks: {
        ethereum: {
          name: 'Ethereum Mainnet',
          bridge_protocol: 'LayerZero',
          native_token: 'ETH',
          confirmation_requirements: 12,
          average_block_time: '12s',
          gas_token: 'ETH',
          status: 'active',
        },
        polygon: {
          name: 'Polygon',
          bridge_protocol: 'Polygon PoS Bridge',
          native_token: 'MATIC',
          confirmation_requirements: 50,
          average_block_time: '2s',
          gas_token: 'MATIC',
          status: 'active',
        },
        bsc: {
          name: 'BNB Smart Chain',
          bridge_protocol: 'LayerZero',
          native_token: 'BNB',
          confirmation_requirements: 15,
          average_block_time: '3s',
          gas_token: 'BNB',
          status: 'active',
        },
        avalanche: {
          name: 'Avalanche C-Chain',
          bridge_protocol: 'Axelar',
          native_token: 'AVAX',
          confirmation_requirements: 1,
          average_block_time: '2s',
          gas_token: 'AVAX',
          status: 'active',
        },
        arbitrum: {
          name: 'Arbitrum One',
          bridge_protocol: 'LayerZero',
          native_token: 'ETH',
          confirmation_requirements: 1,
          average_block_time: '1s',
          gas_token: 'ETH',
          status: 'active',
        },
        optimism: {
          name: 'Optimism',
          bridge_protocol: 'LayerZero',
          native_token: 'ETH',
          confirmation_requirements: 1,
          average_block_time: '2s',
          gas_token: 'ETH',
          status: 'active',
        },
        cosmos: {
          name: 'Cosmos Hub',
          bridge_protocol: 'IBC',
          native_token: 'ATOM',
          confirmation_requirements: 1,
          average_block_time: '6s',
          gas_token: 'ATOM',
          status: 'active',
        },
        osmosis: {
          name: 'Osmosis',
          bridge_protocol: 'IBC',
          native_token: 'OSMO',
          confirmation_requirements: 1,
          average_block_time: '6s',
          gas_token: 'OSMO',
          status: 'active',
        },
        solana: {
          name: 'Solana',
          bridge_protocol: 'Wormhole',
          native_token: 'SOL',
          confirmation_requirements: 32,
          average_block_time: '400ms',
          gas_token: 'SOL',
          status: 'active',
        },
        sui: {
          name: 'Sui Network',
          bridge_protocol: 'Wormhole',
          native_token: 'SUI',
          confirmation_requirements: 1,
          average_block_time: '3s',
          gas_token: 'SUI',
          status: 'active',
        },
        base: {
          name: 'Base',
          bridge_protocol: 'LayerZero',
          native_token: 'ETH',
          confirmation_requirements: 1,
          average_block_time: '2s',
          gas_token: 'ETH',
          status: 'active',
        },
      },
      bridge_protocols: {
        LayerZero: {
          description: 'Omnichain interoperability protocol',
          supported_chains: [
            'ethereum',
            'polygon',
            'bsc',
            'arbitrum',
            'optimism',
            'base',
          ],
          features: ['message_passing', 'asset_transfer', 'unified_liquidity'],
          security_model: 'relayer_oracle',
        },
        IBC: {
          description: 'Inter-Blockchain Communication protocol',
          supported_chains: ['cosmos', 'osmosis'],
          features: [
            'packet_routing',
            'channel_handshake',
            'light_client_verification',
          ],
          security_model: 'light_client',
        },
        Axelar: {
          description: 'Secure cross-chain communication',
          supported_chains: ['ethereum', 'avalanche', 'cosmos'],
          features: ['general_message_passing', 'programmable_money'],
          security_model: 'validator_network',
        },
        Wormhole: {
          description: 'Generic message passing protocol',
          supported_chains: ['ethereum', 'solana', 'sui'],
          features: ['token_bridge', 'nft_bridge', 'core_bridge'],
          security_model: 'guardian_network',
        },
        'Polygon PoS Bridge': {
          description: 'Polygon Proof-of-Stake bridge',
          supported_chains: ['ethereum', 'polygon'],
          features: ['pos_validation', 'plasma_bridge', 'state_sync'],
          security_model: 'pos_consensus',
        },
      },
      computation_types: {
        Weather: {
          description: 'Weather and climate data processing',
          supported_parameters: [
            'temperature',
            'precipitation',
            'humidity',
            'wind',
            'pressure',
            'air_quality',
          ],
          typical_response_time: '15-45s',
          consensus_threshold: 0.8,
        },
        Finance: {
          description: 'Financial data and calculations',
          supported_parameters: ['price_feeds', 'market_data', 'defi_metrics'],
          typical_response_time: '5-15s',
          consensus_threshold: 0.9,
        },
        Scientific: {
          description: 'Scientific computations and climate modeling',
          supported_parameters: [
            'climate_models',
            'environmental_impact',
            'carbon_footprint',
          ],
          typical_response_time: '30-120s',
          consensus_threshold: 0.85,
        },
        MachineLearning: {
          description: 'ML model inference and predictions',
          supported_parameters: [
            'model_inference',
            'prediction_analysis',
            'pattern_recognition',
          ],
          typical_response_time: '10-60s',
          consensus_threshold: 0.8,
        },
        DataAnalysis: {
          description: 'General data analysis and aggregation',
          supported_parameters: [
            'statistical_analysis',
            'data_aggregation',
            'trend_analysis',
          ],
          typical_response_time: '5-30s',
          consensus_threshold: 0.75,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    blockchainLogger.error('Error fetching supported networks', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({
      error: 'Failed to fetch supported networks',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Get liquid democracy delegation information for oracle validators
 * GET /api/oracle/cross-chain/delegation-info
 *
 * Returns information about the liquid democracy system integrated with
 * the oracle network, including delegation chains and validator credentials.
 */
router.get('/cross-chain/delegation-info', requireOracleNetwork, async (req, res) => {
  try {
    const { validator_address } = req.query;

    if (validator_address) {
      // Get specific validator delegation info
      const delegationChain =
        oracleNetwork.rustOracleBridge?.liquid_democracy?.get_delegation_chain?.(
          validator_address
        );
      const validatorPerformance =
        oracleNetwork.rustOracleBridge?.liquid_democracy?.get_delegate_performance?.(
          validator_address
        );

      res.json({
        validator_address,
        delegation_chain: delegationChain || null,
        performance_metrics: validatorPerformance || null,
        is_delegate: delegationChain?.chain.length > 1,
        total_delegated_power: delegationChain?.total_power || 0,
        timestamp: new Date().toISOString(),
      });
    } else {
      // Get general delegation system information
      res.json({
        delegation_system: {
          enabled: true,
          description:
            'Liquid democracy integration for oracle validator selection and performance weighting',
          features: [
            'delegation_chain_validation',
            'performance_based_weighting',
            'validator_credential_verification',
            'byzantine_fault_tolerance',
            'circular_delegation_prevention',
          ],
        },
        validator_requirements: {
          min_reputation_score: 0.8,
          min_stake_amount: 1000,
          required_data_accuracy: 0.85,
          oracle_performance_threshold: 0.7,
        },
        consensus_mechanics: {
          delegation_chain_validation: true,
          performance_weighting_enabled: true,
          byzantine_fault_tolerance: true,
          validator_credential_verification: true,
        },
        participation_metrics: {
          total_delegates: 'varies',
          active_delegations: 'varies',
          average_delegation_chain_length: 'varies',
          delegation_turnover_rate: 'varies',
        },
        timestamp: new Date().toISOString(),
      });
    }
  } catch (error) {
    blockchainLogger.error('Error fetching delegation info', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({
      error: 'Failed to fetch delegation information',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Get cross-chain oracle performance analytics
 * GET /api/oracle/cross-chain/analytics
 *
 * Returns performance analytics for cross-chain oracle operations including
 * consensus metrics, validator performance, and bridge utilization.
 */
router.get('/cross-chain/analytics', requireOracleNetwork, async (req, res) => {
  try {
    const { time_range } = req.query; // '1h', '24h', '7d', '30d'

    // Get bridge performance metrics if available
    const performanceMetrics = oracleNetwork.rustOracleBridge
      ? oracleNetwork.rustOracleBridge.getPerformanceMetrics()
      : null;

    // Get oracle network metrics
    const networkMetrics = await oracleNetwork.getMetrics();

    const unavailable = [
      'success_rate',
      'error_rate',
      'consensus_analytics',
      'top_performing_validators',
      'delegation_utilization',
      'performance_distribution',
      'bridge_utilization',
      'computation_type_distribution',
      'liquid_democracy_impact',
      'time_range',
      'throughput_per_hour',
    ];
    const bridgePerformance = performanceMetrics
      ? {
          total_requests: performanceMetrics.requestCount,
          average_response_time: performanceMetrics.averageResponseTime,
          throughput_per_hour: null,
        }
      : null;
    if (!bridgePerformance) unavailable.push('bridge_performance');

    const validators = networkMetrics?.validators;
    const validatorPerformance =
      validators &&
      Number.isFinite(validators.active) &&
      Number.isFinite(validators.averageAccuracy)
        ? {
            total_active_validators: validators.active,
            average_accuracy: validators.averageAccuracy,
          }
        : null;
    if (!validatorPerformance) unavailable.push('validator_performance');

    // No source exposes a time-windowed counter, so do not imply that the
    // caller's requested range was applied to these lifetime measurements.
    res.json({
      time_range: null,
      requested_time_range: time_range || '24h',
      bridge_performance: bridgePerformance,
      validator_performance: validatorPerformance,
      unavailable,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    blockchainLogger.error('Error fetching cross-chain analytics', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({
      error: 'Failed to fetch cross-chain analytics',
      details: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * Test cross-chain oracle connectivity
 * POST /api/oracle/cross-chain/test
 *
 * Performs a test cross-chain oracle request to validate bridge connectivity
 * and liquid democracy integration without affecting production data.
 */
router.post('/cross-chain/test', transferLimiter, requireOracleNetwork, async (req, res) => {
  try {
    const { target_chain } = req.body;

    if (!target_chain) {
      return res.status(400).json({
        error: 'Target chain is required for connectivity test',
      });
    }

    blockchainLogger.info('Testing cross-chain connectivity', { targetChain: target_chain });

    // Create a test oracle request
    const testRequest = {
      dataType: 'TEMPERATURE',
      parameters: {
        latitude: 40.7128,
        longitude: -74.006,
        test_mode: true,
      },
      sourceChain: 'wrfcoin',
      targetChain: target_chain,
      sourceAddress: 'test_address_0x123',
      requiredConfidence: 0.8,
      maxValidatorFee: 100,
      deadline: new Date(Date.now() + 300000).toISOString(), // 5 minutes
      priority: 1,
    };

    const startTime = Date.now();

    try {
      const testResponse =
        await oracleNetwork.createCrossChainRequest(testRequest);
      const endTime = Date.now();

      res.json({
        test_status: 'success',
        target_chain,
        response_time: endTime - startTime,
        bridge_status: 'operational',
        consensus_achieved: testResponse.consensus?.achieved_consensus || 0,
        participating_validators:
          testResponse.consensus?.participating_validators?.length || 0,
        liquid_democracy_validation: testResponse.liquidDemocracyAttestation
          ? 'verified'
          : 'not_verified',
        test_result: testResponse.result,
        timestamp: new Date().toISOString(),
      });
    } catch (testError) {
      // Check if it's a bridge unavailability and test fallback
      if (testError.message && testError.message.includes('not available')) {
        blockchainLogger.info('Testing fallback to local processing');

        const fallbackResponse = await oracleNetwork.createRequest(testRequest);
        const endTime = Date.now();

        res.json({
          test_status: 'fallback_success',
          target_chain,
          response_time: endTime - startTime,
          bridge_status: 'unavailable',
          fallback_mode: true,
          local_processing: 'operational',
          fallback_result: fallbackResponse,
          message: 'Rust bridge unavailable, local processing functional',
          timestamp: new Date().toISOString(),
        });
      } else {
        throw testError;
      }
    }
  } catch (error) {
    blockchainLogger.error('Cross-chain connectivity test failed', { error: { message: error.message, stack: error.stack } });
    res.status(500).json({
      test_status: 'failed',
      target_chain: req.body.target_chain || 'unknown',
      error: error.message,
      details: 'Cross-chain oracle test request failed',
      timestamp: new Date().toISOString(),
    });
  }
});

module.exports = router;
