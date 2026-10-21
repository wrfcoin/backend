/**
 * Transaction Controller - TypeScript Implementation
 * Handles blockchain transaction operations with comprehensive validation
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { blockchainLogger } from '../utils/logger.js';
import {
  ControllerResponse,
  BlockchainTransaction,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
  SupportedToken,
} from '../../shared/types/security-types.js';
import { wrfToBaseUnits, baseUnitsToWrf, WRF_UNITS_PER_COIN } from '../../shared/currency.js';

// ============================================
// Zod Validation Schemas
// ============================================

// Core validation patterns
const ethereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');
const transactionHashSchema = z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transaction hash format');
const positiveAmountSchema = z.number().positive('Amount must be positive');
const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

// Supported token types
const supportedTokenSchema = z.enum(['WRF', 'ETH', 'USDC', 'USDT', 'DAI', 'WBTC']).default('WRF');

// Create transaction request schema
const createTransactionSchema = z.object({
  from: ethereumAddressSchema,
  to: ethereumAddressSchema,
  amount: positiveAmountSchema,
  token: supportedTokenSchema.optional(),
  fee: z.number().positive().optional(),
  data: z.string().max(10000).optional(),
});

// Transaction hash params schema
const transactionHashParamsSchema = z.object({
  hash: transactionHashSchema,
});

// Address params schema
const addressParamsSchema = z.object({
  address: ethereumAddressSchema,
});

// Enhanced request interface with storage
interface TransactionRequest extends Request {
  storage: {
    getTransactionByHash: (
      hash: string
    ) => Promise<BlockchainTransaction | null>;
    getTransactionsBySender: (
      address: EthereumAddress
    ) => Promise<BlockchainTransaction[]>;
    getTransactionsByReceiver: (
      address: EthereumAddress
    ) => Promise<BlockchainTransaction[]>;
    getTransactionsByAddress: (
      address: EthereumAddress
    ) => Promise<BlockchainTransaction[]>;
    createTransaction: (
      transaction: Partial<BlockchainTransaction>
    ) => Promise<BlockchainTransaction>;
    updateTransactionStatus: (
      hash: string,
      status: string
    ) => Promise<BlockchainTransaction>;
  };
}

// Transaction creation interface
interface CreateTransactionRequest {
  from: EthereumAddress;
  to: EthereumAddress;
  amount: PositiveNumber;
  token: SupportedToken;
  fee?: PositiveNumber;
  data?: string;
}

/**
 * Get transaction by hash with comprehensive details
 */
export const getTransactionByHash = async (
  req: TransactionRequest,
  res: Response
): Promise<ControllerResponse<BlockchainTransaction>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for transaction hash
    const paramsResult = transactionHashParamsSchema.safeParse(req.params);
    if (!paramsResult.success) {
      const errorResponse: ControllerResponse<BlockchainTransaction> = {
        success: false,
        error: paramsResult.error.issues[0].message,
        message: 'Transaction hash must be a valid 66-character hex string starting with 0x',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const txHash = paramsResult.data.hash;

    const transaction = await req.storage.getTransactionByHash(txHash);

    if (!transaction) {
      const notFoundResponse: ControllerResponse<BlockchainTransaction> = {
        success: false,
        error: 'Transaction not found',
        message: `No transaction found with hash ${txHash}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    const response: ControllerResponse<BlockchainTransaction> = {
      success: true,
      data: transaction,
      message: 'Transaction retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getTransactionByHash', { module: 'TransactionController', operation: 'getTransactionByHash', error: (error as Error).message });
    const errorResponse: ControllerResponse<BlockchainTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve transaction',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get transactions by sender address with pagination
 */
export const getTransactionsBySender = async (
  req: TransactionRequest,
  res: Response
): Promise<PaginatedResponse<BlockchainTransaction>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for address and pagination
    const paramsResult = addressParamsSchema.safeParse(req.params);
    const queryResult = paginationSchema.safeParse(req.query);

    if (!paramsResult.success) {
      const errorResponse: PaginatedResponse<BlockchainTransaction> = {
        success: false,
        error: paramsResult.error.issues[0].message,
        message: 'Address must be a valid 42-character hex string starting with 0x',
        timestamp: new Date().toISOString(),
        requestId,
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const address = paramsResult.data.address as EthereumAddress;
    const { page, limit } = queryResult.success ? queryResult.data : { page: 1, limit: 20 };

    const allTransactions = await req.storage.getTransactionsBySender(address);

    // Implement pagination
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedTransactions = allTransactions.slice(startIndex, endIndex);
    const totalPages = Math.ceil(allTransactions.length / limit);

    const response: PaginatedResponse<BlockchainTransaction> = {
      success: true,
      data: paginatedTransactions,
      message: `Retrieved ${paginatedTransactions.length} transactions for sender ${address}`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: allTransactions.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getTransactionsBySender', { module: 'TransactionController', operation: 'getTransactionsBySender', error: (error as Error).message });
    const errorResponse: PaginatedResponse<BlockchainTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve transactions by sender',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get transactions by receiver address
 */
export const getTransactionsByReceiver = async (
  req: TransactionRequest,
  res: Response
): Promise<PaginatedResponse<BlockchainTransaction>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for address and pagination
    const paramsResult = addressParamsSchema.safeParse(req.params);
    const queryResult = paginationSchema.safeParse(req.query);

    if (!paramsResult.success) {
      const errorResponse: PaginatedResponse<BlockchainTransaction> = {
        success: false,
        error: paramsResult.error.issues[0].message,
        message: 'Address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const address = paramsResult.data.address as EthereumAddress;
    const { page, limit } = queryResult.success ? queryResult.data : { page: 1, limit: 20 };

    const allTransactions =
      await req.storage.getTransactionsByReceiver(address);

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedTransactions = allTransactions.slice(startIndex, endIndex);
    const totalPages = Math.ceil(allTransactions.length / limit);

    const response: PaginatedResponse<BlockchainTransaction> = {
      success: true,
      data: paginatedTransactions,
      message: `Retrieved ${paginatedTransactions.length} transactions for receiver ${address}`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: allTransactions.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getTransactionsByReceiver', { module: 'TransactionController', operation: 'getTransactionsByReceiver', error: (error as Error).message });
    const errorResponse: PaginatedResponse<BlockchainTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve transactions by receiver',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Create new transaction
 */
export const createTransaction = async (
  req: TransactionRequest,
  res: Response
): Promise<ControllerResponse<BlockchainTransaction>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for create transaction request body
    const bodyResult = createTransactionSchema.safeParse(req.body);

    if (!bodyResult.success) {
      const errorResponse: ControllerResponse<BlockchainTransaction> = {
        success: false,
        error: bodyResult.error.issues[0].message,
        message: 'Transaction validation failed: ' + bodyResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const transactionData = bodyResult.data;

    // Create transaction with enhanced data
    const newTransactionData: Partial<BlockchainTransaction> = {
      hash: `0x${uuidv4().replace(/-/g, '')}${Math.random().toString(16).slice(2, 18)}`,
      from: transactionData.from as EthereumAddress,
      to: transactionData.to as EthereumAddress,
      amount: transactionData.amount as PositiveNumber,
      token: (transactionData.token || 'WRF') as SupportedToken,
      fee:
        (transactionData.fee ||
        Number(wrfToBaseUnits(transactionData.amount) / 1000n)) as PositiveNumber,
      timestamp: new Date(),
      status: 'pending',
    };

    const transaction = await req.storage.createTransaction(newTransactionData);

    const response: ControllerResponse<BlockchainTransaction> = {
      success: true,
      data: transaction,
      message: 'Transaction created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in createTransaction', { module: 'TransactionController', operation: 'createTransaction', error: (error as Error).message });
    const errorResponse: ControllerResponse<BlockchainTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create transaction',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get all transactions for an address (both sent and received)
 */
export const getAddressTransactions = async (
  req: TransactionRequest,
  res: Response
): Promise<PaginatedResponse<BlockchainTransaction>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for address and pagination
    const paramsResult = addressParamsSchema.safeParse(req.params);
    const queryResult = paginationSchema.safeParse(req.query);

    if (!paramsResult.success) {
      const errorResponse: PaginatedResponse<BlockchainTransaction> = {
        success: false,
        error: paramsResult.error.issues[0].message,
        message: 'Address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
        pagination: {
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
          hasNext: false,
          hasPrev: false,
        },
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const address = paramsResult.data.address as EthereumAddress;
    const { page, limit } = queryResult.success ? queryResult.data : { page: 1, limit: 20 };

    const allTransactions = await req.storage.getTransactionsByAddress(address);

    // Sort by timestamp (most recent first)
    const sortedTransactions = allTransactions.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedTransactions = sortedTransactions.slice(
      startIndex,
      endIndex
    );
    const totalPages = Math.ceil(sortedTransactions.length / limit);

    const response: PaginatedResponse<BlockchainTransaction> = {
      success: true,
      data: paginatedTransactions,
      message: `Retrieved ${paginatedTransactions.length} transactions for address ${address}`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: sortedTransactions.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getAddressTransactions', { module: 'TransactionController', operation: 'getAddressTransactions', error: (error as Error).message });
    const errorResponse: PaginatedResponse<BlockchainTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve address transactions',
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
        hasNext: false,
        hasPrev: false,
      },
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  getTransactionByHash,
  getTransactionsBySender,
  getTransactionsByReceiver,
  createTransaction,
  getAddressTransactions,
};
