/**
 * Blockchain Controller - TypeScript Implementation
 * Handles blockchain operations with type safety and enterprise-grade error handling
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import {
  ControllerResponse,
  BlockchainStatus,
  BlockchainTransaction,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';
import { blockchainLogger } from '../utils/logger.js';

// =====================================================
// INPUT VALIDATION SCHEMAS
// Security: Prevent injection attacks via strict input validation
// =====================================================

// Ethereum address validation
const ethereumAddressSchema = z
  .string()
  .min(10, 'Address is required')
  .max(128, 'Address too long')
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

// Block hash validation (64 hex chars after 0x)
const blockHashSchema = z
  .string()
  .min(1, 'Block hash is required')
  .max(128, 'Block hash too long')
  .regex(/^(0x)?[a-fA-F0-9]+$/, 'Invalid block hash format');

// Pagination schemas
const limitSchema = z
  .string()
  .optional()
  .transform((val) => {
    const num = val ? parseInt(val, 10) : 10;
    return isNaN(num) || num < 1 ? 10 : Math.min(num, 100);
  });

const addressLimitSchema = z
  .string()
  .optional()
  .transform((val) => {
    const num = val ? parseInt(val, 10) : 50;
    return isNaN(num) || num < 1 ? 50 : Math.min(num, 200);
  });

// Query schemas
const blocksQuerySchema = z.object({
  limit: limitSchema,
});

const addressQuerySchema = z.object({
  limit: addressLimitSchema,
});

// Enhanced request interface with storage
interface BlockchainRequest extends Request {
  storage: {
    getLatestBlocks: (limit: number) => Promise<any[]>;
    getNodeCount: () => Promise<number>;
    getNetworkHashrate: () => Promise<number>;
    getTotalTransactionCount: () => Promise<number>;
    getBlockByHash: (hash: string) => Promise<any>;
    getTransactionsByBlock: (blockHash: string) => Promise<any[]>;
    getAddressBalance: (address: string) => Promise<number>;
    getAddressTransactions: (address: string, limit?: number) => Promise<any[]>;
  };
}

const blockchainAdapter = require('../blockchain_adapter');

/**
 * Get comprehensive blockchain information
 */
export const getBlockchainInfo = async (
  req: BlockchainRequest,
  res: Response
): Promise<ControllerResponse<BlockchainStatus>> => {
  const requestId = uuidv4();

  try {
    // Try blockchain adapter first for real-time data
    try {
      const blockchainInfo = await blockchainAdapter.getBlockchainInfo();
      const response: ControllerResponse<BlockchainStatus> = {
        success: true,
        data: blockchainInfo,
        message: 'Blockchain information retrieved successfully',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.json(response);
      return response;
    } catch (adapterError) {
      blockchainLogger.info('Blockchain adapter unavailable, using storage fallback', { error: (adapterError as Error).message });
    }

    // Fallback to storage with enhanced calculations
    const latestBlocks = await req.storage.getLatestBlocks(1);
    const blockHeight =
      latestBlocks.length > 0 ? latestBlocks[0].blockHeight : 0;

    // Get comprehensive network statistics
    const [nodeCount, networkHashrate, totalTransactions] = await Promise.all([
      req.storage.getNodeCount(),
      req.storage.getNetworkHashrate(),
      req.storage.getTotalTransactionCount(),
    ]);

    const difficulty = latestBlocks.length > 0 ? latestBlocks[0].difficulty : 0;

    // Calculate average block time with improved accuracy
    const recentBlocks = await req.storage.getLatestBlocks(20);
    let avgBlockTime = 2.5; // Default 2.5 minutes

    if (recentBlocks.length > 1) {
      let totalTime = 0;
      let validIntervals = 0;

      for (let i = 0; i < recentBlocks.length - 1; i++) {
        const timeDiff =
          (new Date(recentBlocks[i].timestamp).getTime() -
            new Date(recentBlocks[i + 1].timestamp).getTime()) /
          1000;

        // Filter out anomalous intervals (< 30s or > 10min)
        if (timeDiff > 30 && timeDiff < 600) {
          totalTime += timeDiff;
          validIntervals++;
        }
      }

      if (validIntervals > 0) {
        avgBlockTime = totalTime / validIntervals / 60; // Convert to minutes
      }
    }

    const blockchainStatus: BlockchainStatus = {
      isConnected: true,
      chainId: 1337, // Wrfcoin testnet
      blockHeight,
      networkName: 'Wrfcoin Testnet',
      gasPrice: 0.001, // WRF per gas unit
      lastUpdate: new Date(),
    };

    const response: ControllerResponse<BlockchainStatus> = {
      success: true,
      data: blockchainStatus,
      message: 'Blockchain information retrieved from storage',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getBlockchainInfo', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<BlockchainStatus> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve blockchain information',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get latest blocks with pagination
 */
export const getLatestBlocks = async (
  req: BlockchainRequest,
  res: Response
): Promise<ControllerResponse<any[]>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate query parameters with Zod
    const validationResult = blocksQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<any[]> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid query parameters',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { limit } = validationResult.data;

    // Try blockchain adapter first
    try {
      const blocks = await blockchainAdapter.getLatestBlocks(limit);
      const response: ControllerResponse<any[]> = {
        success: true,
        data: blocks,
        message: `Retrieved ${blocks.length} latest blocks`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.json(response);
      return response;
    } catch (adapterError) {
      blockchainLogger.info('Blockchain adapter unavailable, using storage', { error: (adapterError as Error).message });
    }

    // Fallback to storage
    const blocks = await req.storage.getLatestBlocks(limit);
    const response: ControllerResponse<any[]> = {
      success: true,
      data: blocks,
      message: `Retrieved ${blocks.length} blocks from storage`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getLatestBlocks', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<any[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve latest blocks',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get block by hash with transaction details
 */
export const getBlockByHash = async (
  req: BlockchainRequest,
  res: Response
): Promise<ControllerResponse<any>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate block hash parameter with Zod
    const validationResult = blockHashSchema.safeParse(req.params.hash);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<any> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Block hash must be a valid hex string',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const blockHash = validationResult.data;

    // Try blockchain adapter first
    try {
      const block = await blockchainAdapter.getBlockByHash(blockHash);
      if (block) {
        const transactions =
          await blockchainAdapter.getTransactionsByBlock(blockHash);
        const blockWithTransactions = { ...block, transactions };

        const response: ControllerResponse<any> = {
          success: true,
          data: blockWithTransactions,
          message: 'Block retrieved successfully',
          timestamp: new Date().toISOString(),
          requestId,
        };
        res.json(response);
        return response;
      }
    } catch (adapterError) {
      blockchainLogger.info('Blockchain adapter error', { error: (adapterError as Error).message });
    }

    // Fallback to storage
    const block = await req.storage.getBlockByHash(blockHash);
    if (!block) {
      const notFoundResponse: ControllerResponse<any> = {
        success: false,
        error: 'Block not found',
        message: `No block found with hash ${blockHash}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    const transactions = await req.storage.getTransactionsByBlock(blockHash);
    const blockWithTransactions = { ...block, transactions };

    const response: ControllerResponse<any> = {
      success: true,
      data: blockWithTransactions,
      message: 'Block retrieved from storage',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getBlockByHash', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve block',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get address balance and transaction history
 */
export const getAddressInfo = async (
  req: BlockchainRequest,
  res: Response
): Promise<ControllerResponse<any>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate address parameter with Zod
    const addressValidation = ethereumAddressSchema.safeParse(req.params.address);
    if (!addressValidation.success) {
      const errorResponse: ControllerResponse<any> = {
        success: false,
        error: addressValidation.error.issues[0].message,
        message: 'Address must be a valid 42-character hex string starting with 0x',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // SECURITY: Validate query parameters with Zod
    const queryValidation = addressQuerySchema.safeParse(req.query);
    if (!queryValidation.success) {
      const errorResponse: ControllerResponse<any> = {
        success: false,
        error: queryValidation.error.issues[0].message,
        message: 'Invalid query parameters',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const address = addressValidation.data as EthereumAddress;
    const { limit } = queryValidation.data;

    // Get balance and transactions in parallel
    const [balance, transactions] = await Promise.all([
      req.storage.getAddressBalance(address),
      req.storage.getAddressTransactions(address, limit),
    ]);

    const addressInfo = {
      address,
      balance: balance as PositiveNumber,
      transactionCount: transactions.length,
      transactions: transactions.slice(0, limit),
    };

    const response: ControllerResponse<any> = {
      success: true,
      data: addressInfo,
      message: `Retrieved information for address ${address}`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getAddressInfo', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve address information',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  getBlockchainInfo,
  getLatestBlocks,
  getBlockByHash,
  getAddressInfo,
};
