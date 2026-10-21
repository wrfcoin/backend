/**
 * NOT MOUNTED — follow-up decision story backend#1143 (from backend#1136, epic wrfcoin/infra#946).
 *
 * This is the computational-NFT-scoped cross-chain surface (/chains, /status,
 * /providers, /transfer, /execute, /verify). It is NOT a snapshot of the
 * canonical `cross-chain.ts` (different routes, different scope), so #1136
 * did not consolidate it away. Two facts for whoever decides its fate:
 *   1. It is broken at runtime as written: `../integrations/cross-chain/controller`
 *      exports the `CrossChainController` CLASS (`module.exports = CrossChainController`),
 *      so `const { controller } = require(...)` below yields `undefined` and the
 *      first middleware throws `TypeError: Cannot read properties of undefined
 *      (reading 'isInitialized')` on every request. Its unit test only passes
 *      because it mocks that module with a `{ controller }` shape.
 *   2. Even fixed, its backing (`integrations/cross-chain/{controller.js,adapter.ts}`)
 *      is mock-only: every provider is a `createMock*Provider()` with
 *      Math.random() txHashes/verification, and the controller fabricates
 *      content sizes and confidence scores the same way.
 * Do not mount it in this state.
 */
/**
 * Cross-Chain Routes
 *
 * This module defines the API routes for cross-chain functionality,
 * including computational NFT operations across different blockchains.
 */

const express = require('express');
const { controller } = require('../integrations/cross-chain/controller');
const { logger } = require('../utils/logger');
const {
  sanitizeObject,
  detectXSS,
  validateChainId,
  validateAssetId,
  validateBlockchainAddress,
} = require('../../shared/utils/input-sanitizer');
const { requireAuth } = require('../middleware/authMiddleware');

const router = express.Router();

// Validation middleware for POST requests
const validatePostBody = (req, res, next) => {
  // Check for XSS in the entire body
  if (req.body && detectXSS(JSON.stringify(req.body))) {
    return res.status(400).json({
      success: false,
      error: 'Invalid characters detected in request body',
    });
  }
  next();
};

/**
 * Initialize the controller
 */
router.use(async (req, res, next) => {
  try {
    if (!controller.isInitialized()) {
      await controller.initialize();
    }
    next();
  } catch (error) {
    logger.error(`Error initializing cross-chain controller: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to initialize cross-chain controller',
    });
  }
});

/**
 * Get supported chains
 * @route GET /api/cross-chain/chains
 */
router.get('/chains', (req, res) => {
  try {
    const chains = controller.getSupportedChains();
    res.json({
      success: true,
      chains,
    });
  } catch (error) {
    logger.error(`Error getting supported chains: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get supported chains',
    });
  }
});

/**
 * Get network status
 * @route GET /api/cross-chain/status
 */
router.get('/status', (req, res) => {
  try {
    const status = controller.getNetworkStatus();
    res.json({
      success: true,
      status,
    });
  } catch (error) {
    logger.error(`Error getting network status: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get network status',
    });
  }
});

/**
 * Get available providers
 * @route GET /api/cross-chain/providers
 * @query {string} type - Provider type: bridge, compute, or storage
 */
router.get('/providers', (req, res) => {
  try {
    const { type } = req.query;
    let providers;

    switch (type) {
      case 'bridge':
        providers = controller.getBridgeProviders();
        break;
      case 'compute':
        providers = controller.getComputeProviders();
        break;
      case 'storage':
        providers = controller.getStorageProviders();
        break;
      default:
        providers = {
          bridge: controller.getBridgeProviders(),
          compute: controller.getComputeProviders(),
          storage: controller.getStorageProviders(),
        };
    }

    res.json({
      success: true,
      providers,
    });
  } catch (error) {
    logger.error(`Error getting providers: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to get providers',
    });
  }
});

/**
 * Transfer NFT to a different chain
 * @route POST /api/cross-chain/transfer
 * @body {string} assetId - NFT ID
 * @body {string} assetType - Asset type (usually "NFT")
 * @body {string} sourceChain - Source chain ID
 * @body {string} destinationChain - Destination chain ID
 * @body {string} destinationAddress - Destination address
 * @body {object} metadata - Optional additional metadata
 * SECURITY: Requires authentication - asset transfers require ownership verification
 */
router.post('/transfer', requireAuth, validatePostBody, async (req, res) => {
  try {
    const {
      assetId,
      assetType,
      sourceChain,
      destinationChain,
      destinationAddress,
      metadata,
    } = req.body;

    // Validate required parameters
    if (!assetId || !sourceChain || !destinationChain || !destinationAddress) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: assetId, sourceChain, destinationChain, destinationAddress',
      });
    }

    // Validate assetId
    if (typeof assetId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'assetId must be a string',
      });
    }

    if (!validateAssetId(assetId)) {
      return res.status(400).json({
        success: false,
        error: 'assetId contains invalid characters',
      });
    }

    // Validate assetType if provided
    if (assetType !== undefined) {
      if (typeof assetType !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'assetType must be a string',
        });
      }

      const validAssetTypes = ['NFT', 'TOKEN', 'COIN', 'DATA'];
      if (!validAssetTypes.includes(assetType.toUpperCase())) {
        return res.status(400).json({
          success: false,
          error: `assetType must be one of: ${validAssetTypes.join(', ')}`,
        });
      }
    }

    // Validate sourceChain
    if (typeof sourceChain !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'sourceChain must be a string',
      });
    }

    if (!validateChainId(sourceChain)) {
      return res.status(400).json({
        success: false,
        error: 'sourceChain contains invalid characters',
      });
    }

    // Validate destinationChain
    if (typeof destinationChain !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'destinationChain must be a string',
      });
    }

    if (!validateChainId(destinationChain)) {
      return res.status(400).json({
        success: false,
        error: 'destinationChain contains invalid characters',
      });
    }

    // Validate destinationAddress
    if (typeof destinationAddress !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'destinationAddress must be a string',
      });
    }

    if (!validateBlockchainAddress(destinationAddress)) {
      return res.status(400).json({
        success: false,
        error: 'destinationAddress has invalid format',
      });
    }

    // Validate metadata if provided
    if (metadata !== undefined && (typeof metadata !== 'object' || metadata === null || Array.isArray(metadata))) {
      return res.status(400).json({
        success: false,
        error: 'metadata must be an object',
      });
    }

    // Sanitize inputs
    const sanitizedAssetId = sanitizeObject(assetId);
    const sanitizedAssetType = assetType ? sanitizeObject(assetType) : 'NFT';
    const sanitizedSourceChain = sanitizeObject(sourceChain);
    const sanitizedDestinationChain = sanitizeObject(destinationChain);
    const sanitizedDestinationAddress = sanitizeObject(destinationAddress);
    const sanitizedMetadata = metadata ? sanitizeObject(metadata) : undefined;

    const result = await controller.transferAssetCrossChain({
      assetId: sanitizedAssetId,
      assetType: sanitizedAssetType,
      sourceChain: sanitizedSourceChain,
      destinationChain: sanitizedDestinationChain,
      destinationAddress: sanitizedDestinationAddress,
      metadata: sanitizedMetadata,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    logger.error(`Error in transfer route: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to process transfer',
    });
  }
});

// Valid algorithms for execution
const VALID_ALGORITHMS = ['weather-prediction', 'data-aggregation', 'anomaly-detection', 'forecast-ensemble', 'verification'];

// Valid compute providers
const VALID_COMPUTE_PROVIDERS = ['golem', 'akash', 'tataucloud', 'render-network', 'internet-computer'];

// Valid storage providers
const VALID_STORAGE_PROVIDERS = ['ipfs', 'filecoin', 'arweave', 'storj', 'sia'];

/**
 * Execute computational NFT
 * @route POST /api/cross-chain/execute
 * @body {string} nftId - NFT ID
 * @body {string} algorithm - Algorithm to execute
 * @body {string} datasetId - Dataset ID
 * @body {string} storageProvider - Storage provider (optional)
 * @body {string} computeProvider - Compute provider
 * @body {string} executionChain - Chain to execute on
 * @body {object} algorithmParams - Additional algorithm parameters
 * SECURITY: Requires authentication - computational executions have associated costs
 */
router.post('/execute', requireAuth, validatePostBody, async (req, res) => {
  try {
    const {
      nftId,
      algorithm,
      datasetId,
      storageProvider,
      computeProvider,
      executionChain,
      algorithmParams,
    } = req.body;

    // Validate required parameters
    if (
      !nftId ||
      !algorithm ||
      !datasetId ||
      !computeProvider ||
      !executionChain
    ) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: nftId, algorithm, datasetId, computeProvider, executionChain',
      });
    }

    // Validate nftId
    if (typeof nftId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'nftId must be a string',
      });
    }

    if (!validateAssetId(nftId)) {
      return res.status(400).json({
        success: false,
        error: 'nftId contains invalid characters',
      });
    }

    // Validate algorithm
    if (typeof algorithm !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'algorithm must be a string',
      });
    }

    const normalizedAlgorithm = algorithm.toLowerCase().trim();
    if (!VALID_ALGORITHMS.includes(normalizedAlgorithm)) {
      return res.status(400).json({
        success: false,
        error: `algorithm must be one of: ${VALID_ALGORITHMS.join(', ')}`,
      });
    }

    // Validate datasetId
    if (typeof datasetId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'datasetId must be a string',
      });
    }

    if (!validateAssetId(datasetId)) {
      return res.status(400).json({
        success: false,
        error: 'datasetId contains invalid characters',
      });
    }

    // Validate storageProvider if provided
    if (storageProvider !== undefined) {
      if (typeof storageProvider !== 'string') {
        return res.status(400).json({
          success: false,
          error: 'storageProvider must be a string',
        });
      }

      const normalizedStorageProvider = storageProvider.toLowerCase().trim();
      if (!VALID_STORAGE_PROVIDERS.includes(normalizedStorageProvider)) {
        return res.status(400).json({
          success: false,
          error: `storageProvider must be one of: ${VALID_STORAGE_PROVIDERS.join(', ')}`,
        });
      }
    }

    // Validate computeProvider
    if (typeof computeProvider !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'computeProvider must be a string',
      });
    }

    const normalizedComputeProvider = computeProvider.toLowerCase().trim();
    if (!VALID_COMPUTE_PROVIDERS.includes(normalizedComputeProvider)) {
      return res.status(400).json({
        success: false,
        error: `computeProvider must be one of: ${VALID_COMPUTE_PROVIDERS.join(', ')}`,
      });
    }

    // Validate executionChain
    if (typeof executionChain !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'executionChain must be a string',
      });
    }

    if (!validateChainId(executionChain)) {
      return res.status(400).json({
        success: false,
        error: 'executionChain contains invalid characters',
      });
    }

    // Validate algorithmParams if provided
    if (algorithmParams !== undefined && (typeof algorithmParams !== 'object' || algorithmParams === null || Array.isArray(algorithmParams))) {
      return res.status(400).json({
        success: false,
        error: 'algorithmParams must be an object',
      });
    }

    // Sanitize inputs
    const sanitizedNftId = sanitizeObject(nftId);
    const sanitizedAlgorithm = sanitizeObject(normalizedAlgorithm);
    const sanitizedDatasetId = sanitizeObject(datasetId);
    const sanitizedStorageProvider = storageProvider ? sanitizeObject(storageProvider.toLowerCase().trim()) : undefined;
    const sanitizedComputeProvider = sanitizeObject(normalizedComputeProvider);
    const sanitizedExecutionChain = sanitizeObject(executionChain);
    const sanitizedAlgorithmParams = algorithmParams ? sanitizeObject(algorithmParams) : undefined;

    const result = await controller.executeCrossChainComputation({
      nftId: sanitizedNftId,
      algorithm: sanitizedAlgorithm,
      datasetId: sanitizedDatasetId,
      storageProvider: sanitizedStorageProvider,
      computeProvider: sanitizedComputeProvider,
      executionChain: sanitizedExecutionChain,
      algorithmParams: sanitizedAlgorithmParams,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    logger.error(`Error in execute route: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to execute computation',
    });
  }
});

/**
 * Verify NFT computation results
 * @route POST /api/cross-chain/verify
 * @body {string} nftId - NFT ID
 * @body {string} algorithm - Algorithm used
 * @body {string} datasetId - Dataset ID
 * @body {object} executionResult - Execution result data
 * @body {string} computeProvider - Compute provider used
 * SECURITY: Requires authentication - verification may involve user-owned assets
 */
router.post('/verify', requireAuth, validatePostBody, async (req, res) => {
  try {
    const { nftId, algorithm, datasetId, executionResult, computeProvider } =
      req.body;

    // Validate required parameters
    if (
      !nftId ||
      !algorithm ||
      !datasetId ||
      !executionResult ||
      !computeProvider
    ) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: nftId, algorithm, datasetId, executionResult, computeProvider',
      });
    }

    // Validate nftId
    if (typeof nftId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'nftId must be a string',
      });
    }

    if (!validateAssetId(nftId)) {
      return res.status(400).json({
        success: false,
        error: 'nftId contains invalid characters',
      });
    }

    // Validate algorithm
    if (typeof algorithm !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'algorithm must be a string',
      });
    }

    const normalizedAlgorithm = algorithm.toLowerCase().trim();
    if (!VALID_ALGORITHMS.includes(normalizedAlgorithm)) {
      return res.status(400).json({
        success: false,
        error: `algorithm must be one of: ${VALID_ALGORITHMS.join(', ')}`,
      });
    }

    // Validate datasetId
    if (typeof datasetId !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'datasetId must be a string',
      });
    }

    if (!validateAssetId(datasetId)) {
      return res.status(400).json({
        success: false,
        error: 'datasetId contains invalid characters',
      });
    }

    // Validate executionResult
    if (typeof executionResult !== 'object' || executionResult === null || Array.isArray(executionResult)) {
      return res.status(400).json({
        success: false,
        error: 'executionResult must be an object',
      });
    }

    // Validate computeProvider
    if (typeof computeProvider !== 'string') {
      return res.status(400).json({
        success: false,
        error: 'computeProvider must be a string',
      });
    }

    const normalizedComputeProvider = computeProvider.toLowerCase().trim();
    if (!VALID_COMPUTE_PROVIDERS.includes(normalizedComputeProvider)) {
      return res.status(400).json({
        success: false,
        error: `computeProvider must be one of: ${VALID_COMPUTE_PROVIDERS.join(', ')}`,
      });
    }

    // Sanitize inputs
    const sanitizedNftId = sanitizeObject(nftId);
    const sanitizedAlgorithm = sanitizeObject(normalizedAlgorithm);
    const sanitizedDatasetId = sanitizeObject(datasetId);
    const sanitizedExecutionResult = sanitizeObject(executionResult);
    const sanitizedComputeProvider = sanitizeObject(normalizedComputeProvider);

    const result = await controller.verifyComputationResults({
      nftId: sanitizedNftId,
      algorithm: sanitizedAlgorithm,
      datasetId: sanitizedDatasetId,
      executionResult: sanitizedExecutionResult,
      computeProvider: sanitizedComputeProvider,
    });

    if (result.success) {
      res.json(result);
    } else {
      res.status(400).json(result);
    }
  } catch (error) {
    logger.error(`Error in verify route: ${error.message}`);
    res.status(500).json({
      success: false,
      error: 'Failed to verify computation results',
    });
  }
});

module.exports = router;
