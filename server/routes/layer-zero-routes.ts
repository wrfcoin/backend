/**
 * Wrfcoin LayerZero API Routes
 *
 * This module provides API endpoints for interacting with the LayerZero
 * protocol integration in Wrfcoin.
 */

const express = require('express');
const router = express.Router();
const { authenticateJWT } = require('../middleware/auth');
const { generalLimiter, transferLimiter } = require('../../middleware/rateLimiting');
const bridgeService = require('../layer-zero/bridge');

// All LayerZero bridge operations require authentication (#231)
router.use(authenticateJWT);
// Rate limit LayerZero endpoints; transfer/message POST endpoints get tighter limits (#237)
router.use(generalLimiter);
const config = require('../layer-zero/config');
const { db } = require('../db');
const { crosschainLogger: logger } = require('../utils/logger');
const {
  layerZeroChains,
  layerZeroMessages,
  layerZeroTokenTransfers,
} = require('../../shared/layer-zero-schema');
const { eq } = require('drizzle-orm');
const MAX_LAYER_ZERO_PAGE_SIZE = 100;

// Initialize the bridge service when routes are loaded
bridgeService.initialize().catch(error => {
  logger.error('Failed to initialize bridge service on route loading', error);
});

/**
 * Get all supported chains
 */
router.get('/chains', async (req, res) => {
  try {
    // Get chains from database if available, otherwise from config
    try {
      const chains = await db.select().from(layerZeroChains);

      if (chains && chains.length > 0) {
        return res.json({
          success: true,
          chains: chains,
        });
      }
    } catch (dbError) {
      logger.warn(
        'Failed to get chains from database, falling back to config',
        dbError
      );
    }

    // Fallback to config
    const configChains = config.getAllChains();

    res.json({
      success: true,
      chains: configChains,
    });
  } catch (error) {
    logger.error('Error getting supported chains', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to get supported chains' });
    return;
  }
});

/**
 * Get chain information by ID
 */
router.get('/chains/:chainId', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId, 10);

    if (isNaN(chainId)) {
      res.status(400).json({ success: false, error: 'Invalid chain ID' });
      return;
    }

    // Try to get from database first
    try {
      const [chain] = await db
        .select()
        .from(layerZeroChains)
        .where(eq(layerZeroChains.chainId, chainId));

      if (chain) {
        return res.json({
          success: true,
          chain,
        });
      }
    } catch (dbError) {
      logger.warn(
        `Failed to get chain ${chainId} from database, falling back to config`,
        dbError
      );
    }

    // Fallback to config
    const chainConfig = config.getChainConfig(chainId);

    if (!chainConfig) {
      res.status(404).json({
        success: false,
        error: `Chain with ID ${chainId} not found`,
      });
      return;
    }

    res.json({
      success: true,
      chain: chainConfig,
    });
  } catch (error) {
    logger.error(
      `Error getting chain information for ID ${req.params.chainId}`,
      error
    );
    res
      .status(500)
      .json({ success: false, error: 'Failed to get chain information' });
    return;
  }
});

/**
 * Get adapter information for a chain
 */
router.get('/chains/:chainId/adapter', async (req, res) => {
  try {
    const chainId = parseInt(req.params.chainId, 10);

    if (isNaN(chainId)) {
      res.status(400).json({ success: false, error: 'Invalid chain ID' });
      return;
    }

    // backend#1026: this called bridgeService.getAdapterInfo(), which bridge.js
    // never exported — require() of untyped JS is `any`, so tsc could not see
    // it, and the catch below turned the TypeError into a permanent 500.
    const adapter = await bridgeService.getAdapterForChain(chainId);

    if (!adapter) {
      res
        .status(404)
        .json({ success: false, error: `No adapter for chain ID ${chainId}` });
      return;
    }

    // The adapter is a module instance; expose a serializable summary, not the
    // object itself.
    res.json({
      success: true,
      adapter: {
        chainId,
        supported: true,
        capabilities: Object.keys(adapter),
      },
    });
  } catch (error) {
    logger.error(
      `Error getting adapter information for chain ID ${req.params.chainId}`,
      error
    );
    res
      .status(500)
      .json({ success: false, error: 'Failed to get adapter information' });
    return;
  }
});

/**
 * Estimate gas for a cross-chain operation
 */
router.post('/estimate-gas', transferLimiter, async (req, res) => {
  try {
    const {
      sourceChainId,
      destinationChainId,
      messageType,
      tokenType,
      amount,
    } = req.body;

    if (!sourceChainId || !destinationChainId) {
      res
        .status(400)
        .json({
          success: false,
          error: 'Missing required fields: sourceChainId, destinationChainId',
        });
      return;
    }

    // backend#1026: this called bridgeService.estimateGas(), a method bridge.js
    // never exported (the name lives on the per-chain adapters). The bridge-level
    // equivalent is estimateFee(source, destination, operationType, amount).
    const operationType = messageType ?? (tokenType ? 'TOKEN' : 'MESSAGE');
    const operationTypes = ['MESSAGE', 'TOKEN', 'NFT'];
    if (
      typeof operationType !== 'string' ||
      !operationTypes.includes(operationType)
    ) {
      res.status(400).json({
        success: false,
        error: `Unsupported messageType: ${String(operationType)}`,
      });
      return;
    }

    const estimation = await bridgeService.estimateFee(
      parseInt(sourceChainId, 10),
      parseInt(destinationChainId, 10),
      operationType,
      amount
    );

    res.json({
      success: true,
      estimation,
    });
  } catch (error) {
    logger.error('Error estimating gas', error);
    res.status(500).json({ success: false, error: 'Failed to estimate gas' });
    return;
  }
});

/**
 * Send a cross-chain message
 */
router.post('/send-message', transferLimiter, async (req, res) => {
  try {
    const {
      sourceChainId,
      destinationChainId,
      message,
      messageType,
      gasLimit,
    } = req.body;

    if (!sourceChainId || !destinationChainId || !message) {
      res
        .status(400)
        .json({
          success: false,
          error:
            'Missing required fields: sourceChainId, destinationChainId, message',
        });
      return;
    }

    const result = await bridgeService.sendMessage({
      sourceChainId: parseInt(sourceChainId, 10),
      destinationChainId: parseInt(destinationChainId, 10),
      message,
      messageType,
      gasLimit: gasLimit ? parseInt(gasLimit, 10) : undefined,
    });

    // Save message to database
    try {
      await db.insert(layerZeroMessages).values({
        messageId: result.messageId,
        sourceChainId: parseInt(sourceChainId, 10),
        destinationChainId: parseInt(destinationChainId, 10),
        sender: 'wrfcoin-system', // In a real app, this would be the user's address
        receiver: 'wrfcoin-system',
        payload: message,
        messageType: messageType || 'GENERIC',
        status: 'SENT',
        fee: result.fees?.totalFee || null,
        metadata: {
          estimatedGas: result.estimatedGas,
          estimatedDeliveryTimeSeconds: result.estimatedDeliveryTimeSeconds,
        },
      });
    } catch (dbError) {
      logger.warn('Failed to save message to database', dbError);
    }

    res.json({
      success: true,
      result,
    });
  } catch (error) {
    logger.error('Error sending cross-chain message', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to send cross-chain message' });
    return;
  }
});

/**
 * Transfer tokens across chains
 */
router.post('/transfer-tokens', transferLimiter, async (req, res) => {
  try {
    const {
      sourceChainId,
      destinationChainId,
      tokenType,
      tokenAddress,
      amount,
      senderAddress,
      recipientAddress,
      tokenId,
      metadata,
    } = req.body;

    if (
      !sourceChainId ||
      !destinationChainId ||
      !tokenType ||
      !amount ||
      !senderAddress ||
      !recipientAddress
    ) {
      res
        .status(400)
        .json({
          success: false,
          error:
            'Missing required fields: sourceChainId, destinationChainId, tokenType, amount, senderAddress, recipientAddress',
        });
      return;
    }

    const result = await bridgeService.transferTokens({
      sourceChainId: parseInt(sourceChainId, 10),
      destinationChainId: parseInt(destinationChainId, 10),
      tokenType,
      tokenAddress,
      amount: String(amount), // pass display-WRF string; bridge service parses internally
      senderAddress,
      recipientAddress,
      tokenId,
      metadata,
    });

    // Save transfer to database
    try {
      await db.insert(layerZeroTokenTransfers).values({
        transferId: result.transferId,
        sourceChainId: parseInt(sourceChainId, 10),
        destinationChainId: parseInt(destinationChainId, 10),
        tokenType,
        tokenAddress: tokenAddress || null,
        amount: amount.toString(),
        senderAddress,
        recipientAddress,
        tokenId: tokenId || null,
        status: 'SENT',
        fee: result.fees?.totalFee || null,
        metadata: {
          estimatedGas: result.estimatedGas,
          estimatedDeliveryTimeSeconds: result.estimatedDeliveryTimeSeconds,
          ...metadata,
        },
      });
    } catch (dbError) {
      logger.warn('Failed to save token transfer to database', dbError);
    }

    res.json({
      success: true,
      result,
    });
  } catch (error) {
    logger.error('Error transferring tokens across chains', error);
    res
      .status(500)
      .json({
        success: false,
        error: 'Failed to transfer tokens across chains',
      });
    return;
  }
});

/**
 * Get message by ID
 */
router.get('/messages/:messageId', async (req, res) => {
  try {
    const { messageId } = req.params;

    // Try to get from database first
    try {
      const [message] = await db
        .select()
        .from(layerZeroMessages)
        .where(eq(layerZeroMessages.messageId, messageId));

      if (message) {
        return res.json({
          success: true,
          message,
        });
      }
    } catch (dbError) {
      logger.warn(`Failed to get message ${messageId} from database`, dbError);
    }

    // Message not found
    res.status(404).json({
      success: false,
      error: `Message with ID ${messageId} not found`,
    });
    return;
  } catch (error) {
    logger.error(
      `Error getting message with ID ${req.params.messageId}`,
      error
    );
    res.status(500).json({ success: false, error: 'Failed to get message' });
    return;
  }
});

/**
 * Get token transfer by ID
 */
router.get('/transfers/:transferId', async (req, res) => {
  try {
    const { transferId } = req.params;

    // Try to get from database
    try {
      const [transfer] = await db
        .select()
        .from(layerZeroTokenTransfers)
        .where(eq(layerZeroTokenTransfers.transferId, transferId));

      if (transfer) {
        return res.json({
          success: true,
          transfer,
        });
      }
    } catch (dbError) {
      logger.warn(
        `Failed to get transfer ${transferId} from database`,
        dbError
      );
    }

    // Transfer not found
    res.status(404).json({
      success: false,
      error: `Transfer with ID ${transferId} not found`,
    });
    return;
  } catch (error) {
    logger.error(
      `Error getting transfer with ID ${req.params.transferId}`,
      error
    );
    res.status(500).json({ success: false, error: 'Failed to get transfer' });
    return;
  }
});

/**
 * Get recent messages
 */
router.get('/messages', async (req, res) => {
  try {
    const rawLimit = parseInt(req.query.limit as string, 10);
    const limit =
      !Number.isNaN(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_LAYER_ZERO_PAGE_SIZE)
        : 10;
    const rawOffset = parseInt(req.query.offset as string, 10);
    const offset = !Number.isNaN(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    // Get messages from database
    try {
      const messages = await db
        .select()
        .from(layerZeroMessages)
        .limit(limit)
        .offset(offset);

      res.json({
        success: true,
        messages,
      });
    } catch (dbError) {
      logger.error('Failed to get messages from database', dbError);
      res
        .status(500)
        .json({
          success: false,
          error: 'Failed to get messages from database',
        });
      return;
    }
  } catch (error) {
    logger.error('Error getting recent messages', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to get recent messages' });
    return;
  }
});

/**
 * Get recent transfers
 */
router.get('/transfers', async (req, res) => {
  try {
    const rawLimit = parseInt(req.query.limit as string, 10);
    const limit =
      !Number.isNaN(rawLimit) && rawLimit > 0
        ? Math.min(rawLimit, MAX_LAYER_ZERO_PAGE_SIZE)
        : 10;
    const rawOffset = parseInt(req.query.offset as string, 10);
    const offset = !Number.isNaN(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

    // Get transfers from database
    try {
      const transfers = await db
        .select()
        .from(layerZeroTokenTransfers)
        .limit(limit)
        .offset(offset);

      res.json({
        success: true,
        transfers,
      });
    } catch (dbError) {
      logger.error('Failed to get transfers from database', dbError);
      res
        .status(500)
        .json({
          success: false,
          error: 'Failed to get transfers from database',
        });
      return;
    }
  } catch (error) {
    logger.error('Error getting recent transfers', error);
    res
      .status(500)
      .json({ success: false, error: 'Failed to get recent transfers' });
    return;
  }
});

export default router;
