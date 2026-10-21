/**
 * Model Context Protocol (MCP) API Routes
 *
 * This module provides dedicated routes for the Model Context Protocol
 * functionality in the Wrfcoin network.
 *
 * Security: All endpoints require JWT authentication (requireAuth).
 * Admin-only endpoints (execute, chat) additionally require admin role.
 * See issue #402.
 */

const express = require('express');
const router = express.Router();
const { logger } = require('../utils/logger');
const { requireAuth, requireAdmin } = require('../middleware/authMiddleware');
const { sendNotWired } = require('../utils/honest-gap');

router.use((_req, res) => sendNotWired(res, {
  capability: 'mcp-context',
  message: 'MCP routes are retired until canonical context sources are wired.',
  see: 'wrfcoin/backend#1181',
}));

// Import MCP components
const modelRegistry = require('../mcp/modelRegistry');
const contextProvider = require('../mcp/contextProvider');
const dataProcessor = require('../mcp/dataProcessor');

// All MCP routes require authentication (#402)
router.use(requireAuth);

/**
 * Explicit allowlist for blockchain operations reachable via POST /execute.
 * Defence-in-depth: the validator.validateOperation() switch already rejects
 * unknown operations, but this list prevents new cases from being silently
 * exposed without a deliberate code change in the route layer.
 */
const ALLOWED_EXECUTE_OPERATIONS = new Set([
  'get_blockchain_status',
  'get_transaction',
  'get_weather_data',
  'get_governance_proposals',
  'submit_weather_data',
  'submit_transaction',
  'submit_computation_job',
]);

// Get all available AI models
router.get('/models', async (req, res) => {
  try {
    const models = await modelRegistry.listModels();
    res.json({
      count: models.length,
      models: models.map(model => ({
        id: model.id,
        name: model.name,
        provider: model.provider,
        version: model.version,
        capabilities: model.capabilities,
        contextTypes: model.contextTypes,
      })),
    });
  } catch (error) {
    logger.error('Error fetching MCP models:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to fetch MCP models',
    });
  }
});

// Get model details
router.get('/models/:modelId', async (req, res) => {
  try {
    const { modelId } = req.params;
    const model = await modelRegistry.getModel(modelId);

    if (!model) {
      return res.status(404).json({
        error: true,
        message: `Model with ID ${modelId} not found`,
      });
    }

    res.json(model);
  } catch (error) {
    logger.error(
      `Error fetching MCP model with ID ${req.params.modelId}:`,
      error
    );
    res.status(500).json({
      error: true,
      message: `Failed to fetch MCP model with ID ${req.params.modelId}`,
    });
  }
});

// Get all context providers
router.get('/providers', async (req, res) => {
  try {
    const providers = await contextProvider.listProviders();
    res.json({
      count: providers.length,
      providers: providers.map(provider => ({
        id: provider.id,
        name: provider.name,
        description: provider.description,
        contextTypes: provider.contextTypes,
        capabilities: provider.capabilities,
      })),
    });
  } catch (error) {
    logger.error('Error fetching MCP context providers:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to fetch MCP context providers',
    });
  }
});

// Get context provider details
router.get('/providers/:providerId', async (req, res) => {
  try {
    const { providerId } = req.params;
    const provider = await contextProvider.getProvider(providerId);

    if (!provider) {
      return res.status(404).json({
        error: true,
        message: `Context provider with ID ${providerId} not found`,
      });
    }

    res.json(provider);
  } catch (error) {
    logger.error(
      `Error fetching MCP context provider with ID ${req.params.providerId}:`,
      error
    );
    res.status(500).json({
      error: true,
      message: `Failed to fetch MCP context provider with ID ${req.params.providerId}`,
    });
  }
});

// Get context data from provider
router.post('/context', async (req, res) => {
  try {
    const { providerId, type, parameters } = req.body;

    if (!providerId || !type) {
      return res.status(400).json({
        error: true,
        message: 'providerId and type are required',
      });
    }

    const context = await contextProvider.getContext(
      providerId,
      type,
      parameters
    );
    res.json(context);
  } catch (error) {
    logger.error('Error getting context data:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to get context data',
      details: error.message,
    });
  }
});

// Process a query with a model
router.post('/query', async (req, res) => {
  try {
    const {
      modelId,
      query,
      providers = [],
      contexts = [],
      options = {},
    } = req.body;

    if (!modelId || !query) {
      return res.status(400).json({
        error: true,
        message: 'modelId and query are required',
      });
    }

    // If providers are specified, fetch context data from each provider
    const contextData = [...contexts];
    if (providers && providers.length > 0) {
      logger.info(
        `Fetching context from ${providers.length} providers for query`
      );

      for (const providerId of providers) {
        try {
          const provider = await contextProvider.getProvider(providerId);
          if (!provider) {
            logger.warn(`Provider ${providerId} not found, skipping`);
            continue;
          }

          const providerContexts = await contextProvider.getContext(
            providerId,
            'auto',
            { query }
          );
          if (providerContexts && providerContexts.data) {
            contextData.push({
              source: provider.name,
              type: provider.contextTypes[0] || 'general',
              data: providerContexts.data,
            });
            logger.info(`Added context from provider ${provider.name}`);
          }
        } catch (providerError) {
          logger.error(
            `Error getting context from provider ${providerId}:`,
            providerError
          );
        }
      }
    }

    const result = await dataProcessor.processQuery(
      modelId,
      query,
      contextData,
      options
    );
    res.json(result);
  } catch (error) {
    logger.error('Error processing query:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to process query',
      details: error.message,
    });
  }
});

// Process a conversation message (admin-only, #402)
router.post('/chat', requireAdmin, async (req, res) => {
  try {
    const {
      modelId,
      message,
      history = [],
      contexts = [],
      options = {},
    } = req.body;

    if (!modelId || !message) {
      return res.status(400).json({
        error: true,
        message: 'modelId and message are required',
      });
    }

    const result = await dataProcessor.processChat(
      modelId,
      message,
      history,
      contexts,
      options
    );
    res.json(result);
  } catch (error) {
    logger.error('Error processing chat message:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to process chat message',
      details: error.message,
    });
  }
});

// Execute blockchain operation (admin-only, #402)
router.post('/execute', requireAdmin, async (req, res) => {
  try {
    const { operation, parameters = {} } = req.body;

    if (!operation) {
      return res.status(400).json({
        error: true,
        message: 'operation is required',
      });
    }

    // Defence-in-depth: reject operations not in the route-level allowlist
    if (!ALLOWED_EXECUTE_OPERATIONS.has(operation)) {
      logger.warn(
        `Blocked disallowed MCP execute operation: ${operation}`,
        { user: req.user?.sub }
      );
      return res.status(403).json({
        error: true,
        message: `Operation '${operation}' is not permitted`,
      });
    }

    const result = await dataProcessor.executeOperation(operation, parameters);
    res.json({
      operation,
      result,
    });
  } catch (error) {
    logger.error('Error executing operation:', error);
    res.status(500).json({
      error: true,
      message: 'Failed to execute operation',
      details: error.message,
    });
  }
});

module.exports = router;
