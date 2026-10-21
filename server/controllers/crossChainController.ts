/**
 * Cross-Chain Controller - TypeScript Implementation
 * Handles cross-chain bridge operations with comprehensive validation
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { crosschainLogger } from '../utils/logger.js';
import {
  ControllerResponse,
  CrossChainBridge,
  CrossChainTransfer,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
  SupportedToken,
} from '../../shared/types/security-types.js';

// =====================================================
// INPUT VALIDATION SCHEMAS (Zod)
// Security: Prevent injection attacks via strict input validation
// =====================================================

// Ethereum address validation
const ethereumAddressSchema = z.string()
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

// Positive number validation
const positiveNumberSchema = z.number()
  .positive('Amount must be positive');

// Chain name validation
const chainNameSchema = z.string()
  .min(1, 'Chain name is required')
  .max(32, 'Chain name too long')
  .regex(/^[a-z0-9_]+$/, 'Chain name must be lowercase alphanumeric with underscores');

// Bridge name validation
const bridgeNameSchema = z.string()
  .min(1, 'Bridge name is required')
  .max(128, 'Bridge name too long')
  .regex(/^[a-zA-Z0-9\s_-]+$/, 'Bridge name contains invalid characters');

// Token validation
const tokenSchema = z.string()
  .min(1, 'Token is required')
  .max(32, 'Token name too long')
  .regex(/^[A-Z0-9]+$/, 'Token must be uppercase alphanumeric');

// Bridge ID validation
const bridgeIdSchema = z.string()
  .min(1, 'Bridge ID is required')
  .max(128, 'Bridge ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Bridge ID contains invalid characters');

// Transfer ID validation
const transferIdSchema = z.string()
  .min(1, 'Transfer ID is required')
  .max(128, 'Transfer ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Transfer ID contains invalid characters');

// Transaction hash validation
const txHashSchema = z.string()
  .regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid transaction hash format');

// Create bridge request schema
const createBridgeSchema = z.object({
  name: bridgeNameSchema,
  sourceChain: chainNameSchema,
  targetChain: chainNameSchema,
  fee: positiveNumberSchema.or(z.literal(0)),
  minAmount: positiveNumberSchema,
  maxAmount: positiveNumberSchema,
}).refine((data) => data.maxAmount > data.minAmount, {
  message: 'Max amount must be greater than min amount',
  path: ['maxAmount'],
});

// Create transfer request schema
const createTransferSchema = z.object({
  bridgeId: bridgeIdSchema,
  from: ethereumAddressSchema,
  to: ethereumAddressSchema,
  amount: positiveNumberSchema,
  token: tokenSchema,
});

// Complete transfer request schema
const completeTransferSchema = z.object({
  targetTxHash: txHashSchema,
});

// Pagination query schema
const paginationQuerySchema = z.object({
  page: z.string()
    .optional()
    .transform((val) => {
      const num = val ? parseInt(val, 10) : 1;
      return isNaN(num) || num < 1 ? 1 : Math.min(num, 10000);
    }),
  limit: z.string()
    .optional()
    .transform((val) => {
      const num = val ? parseInt(val, 10) : 20;
      return isNaN(num) || num < 1 ? 20 : Math.min(num, 100);
    }),
});

// Enhanced request interface with storage
interface CrossChainRequest extends Request {
  storage?: {
    createBridge: (
      bridge: Partial<CrossChainBridge>
    ) => Promise<CrossChainBridge>;
    getBridge: (id: string) => Promise<CrossChainBridge | null>;
    getAllBridges: () => Promise<CrossChainBridge[]>;
    createTransfer: (
      transfer: Partial<CrossChainTransfer>
    ) => Promise<CrossChainTransfer>;
    getTransfer: (id: string) => Promise<CrossChainTransfer | null>;
    getTransfersByAddress: (
      address: EthereumAddress
    ) => Promise<CrossChainTransfer[]>;
    updateTransferStatus: (
      id: string,
      status: string,
      targetTxHash?: string
    ) => Promise<CrossChainTransfer>;
  };
}

// Bridge creation interface
interface CreateBridgeRequest {
  name: string;
  sourceChain: string;
  targetChain: string;
  fee: PositiveNumber;
  minAmount: PositiveNumber;
  maxAmount: PositiveNumber;
}

// Transfer creation interface
interface CreateTransferRequest {
  bridgeId: string;
  from: EthereumAddress;
  to: EthereumAddress;
  amount: PositiveNumber;
  token: SupportedToken;
}

// Supported blockchain networks
const SUPPORTED_CHAINS = [
  'ethereum',
  'binance_smart_chain',
  'polygon',
  'avalanche',
  'fantom',
  'arbitrum',
  'optimism',
  'solana',
  'cosmos',
  'polkadot',
  'cardano',
  'near',
  'wrfcoin_testnet',
];

/**
 * Create new cross-chain bridge
 */
export const createBridge = async (
  req: CrossChainRequest,
  res: Response
): Promise<ControllerResponse<CrossChainBridge>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate input using zod schema
    const zodValidation = createBridgeSchema.safeParse(req.body);
    if (!zodValidation.success) {
      const errorResponse: ControllerResponse<CrossChainBridge> = {
        success: false,
        error: 'Validation failed',
        message: zodValidation.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { name, sourceChain, targetChain, fee, minAmount, maxAmount } = zodValidation.data;

    // Validate supported chains
    if (
      !SUPPORTED_CHAINS.includes(sourceChain) ||
      !SUPPORTED_CHAINS.includes(targetChain)
    ) {
      const errorResponse: ControllerResponse<CrossChainBridge> = {
        success: false,
        error: 'Unsupported blockchain network',
        message: `Chains must be from supported list: ${SUPPORTED_CHAINS.join(', ')}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create bridge data
    const bridgeData: Partial<CrossChainBridge> = {
      id: `bridge_${uuidv4()}`,
      name,
      sourceChain,
      targetChain,
      isActive: true,
      fee: fee as PositiveNumber,
      minAmount: minAmount as PositiveNumber,
      maxAmount: maxAmount as PositiveNumber,
      totalVolume: 0 as PositiveNumber,
    };

    let bridge: CrossChainBridge;
    if (req.storage) {
      bridge = await req.storage.createBridge(bridgeData);
    } else {
      bridge = bridgeData as CrossChainBridge;
    }

    const response: ControllerResponse<CrossChainBridge> = {
      success: true,
      data: bridge,
      message: 'Cross-chain bridge created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    crosschainLogger.error('Error in createBridge', { module: 'CrossChainController', operation: 'createBridge', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<CrossChainBridge> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create cross-chain bridge',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get all available bridges
 */
export const getBridges = async (
  req: CrossChainRequest,
  res: Response
): Promise<ControllerResponse<CrossChainBridge[]>> => {
  const requestId = uuidv4();

  try {
    let bridges: CrossChainBridge[] = [];

    if (req.storage) {
      bridges = await req.storage.getAllBridges();
    } else {
      // Mock bridges for development
      bridges = [
        {
          id: 'bridge_eth_wrf',
          name: 'Ethereum-Wrfcoin Bridge',
          sourceChain: 'ethereum',
          targetChain: 'wrfcoin_testnet',
          isActive: true,
          fee: 0.01 as PositiveNumber,
          minAmount: 0.1 as PositiveNumber,
          maxAmount: 1000 as PositiveNumber,
          totalVolume: 2500.75 as PositiveNumber,
        },
        {
          id: 'bridge_bsc_wrf',
          name: 'BSC-Wrfcoin Bridge',
          sourceChain: 'binance_smart_chain',
          targetChain: 'wrfcoin_testnet',
          isActive: true,
          fee: 0.005 as PositiveNumber,
          minAmount: 0.05 as PositiveNumber,
          maxAmount: 2000 as PositiveNumber,
          totalVolume: 1850.25 as PositiveNumber,
        },
      ];
    }

    const response: ControllerResponse<CrossChainBridge[]> = {
      success: true,
      data: bridges,
      message: `Retrieved ${bridges.length} cross-chain bridges`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    crosschainLogger.error('Error in getBridges', { module: 'CrossChainController', operation: 'getBridges', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<CrossChainBridge[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve bridges',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Initiate cross-chain transfer
 */
export const initiateTransfer = async (
  req: CrossChainRequest,
  res: Response
): Promise<ControllerResponse<CrossChainTransfer>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate input using zod schema
    const zodValidation = createTransferSchema.safeParse(req.body);
    if (!zodValidation.success) {
      const errorResponse: ControllerResponse<CrossChainTransfer> = {
        success: false,
        error: 'Validation failed',
        message: zodValidation.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { bridgeId, from, to, amount, token } = zodValidation.data;

    // Get bridge information
    let bridge: CrossChainBridge | null = null;
    if (req.storage) {
      bridge = await req.storage.getBridge(bridgeId);
    }

    if (!bridge) {
      const notFoundResponse: ControllerResponse<CrossChainTransfer> = {
        success: false,
        error: 'Bridge not found',
        message: `No bridge found with ID ${bridgeId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    // Validate bridge is active
    if (!bridge.isActive) {
      const errorResponse: ControllerResponse<CrossChainTransfer> = {
        success: false,
        error: 'Bridge inactive',
        message: 'The selected bridge is currently inactive',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate amount limits
    if (amount < bridge.minAmount || amount > bridge.maxAmount) {
      const errorResponse: ControllerResponse<CrossChainTransfer> = {
        success: false,
        error: 'Amount out of range',
        message: `Transfer amount must be between ${bridge.minAmount} and ${bridge.maxAmount}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create transfer data
    const transferData: Partial<CrossChainTransfer> = {
      id: `transfer_${uuidv4()}`,
      bridgeId,
      from: from as EthereumAddress,
      to: to as EthereumAddress,
      amount: amount as PositiveNumber,
      token: token as SupportedToken,
      sourceChain: bridge.sourceChain,
      targetChain: bridge.targetChain,
      status: 'initiated',
      timestamp: new Date(),
      sourceTxHash: `0x${uuidv4().replace(/-/g, '')}${Math.random().toString(16).slice(2, 18)}`,
    };

    let transfer: CrossChainTransfer;
    if (req.storage) {
      transfer = await req.storage.createTransfer(transferData);
    } else {
      transfer = transferData as CrossChainTransfer;
    }

    const response: ControllerResponse<CrossChainTransfer> = {
      success: true,
      data: transfer,
      message: 'Cross-chain transfer initiated successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    crosschainLogger.error('Error in initiateTransfer', { module: 'CrossChainController', operation: 'initiateTransfer', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<CrossChainTransfer> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to initiate cross-chain transfer',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get transfer status
 */
export const getTransfer = async (
  req: CrossChainRequest,
  res: Response
): Promise<ControllerResponse<CrossChainTransfer>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate transfer ID parameter
    const transferIdValidation = transferIdSchema.safeParse(req.params.transferId);
    if (!transferIdValidation.success) {
      const errorResponse: ControllerResponse<CrossChainTransfer> = {
        success: false,
        error: 'Invalid transfer ID',
        message: transferIdValidation.error.issues.map((e) => e.message).join('; '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const transferId = transferIdValidation.data;

    let transfer: CrossChainTransfer | null = null;
    if (req.storage) {
      transfer = await req.storage.getTransfer(transferId);
    }

    if (!transfer) {
      const notFoundResponse: ControllerResponse<CrossChainTransfer> = {
        success: false,
        error: 'Transfer not found',
        message: `No transfer found with ID ${transferId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    const response: ControllerResponse<CrossChainTransfer> = {
      success: true,
      data: transfer,
      message: 'Transfer retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    crosschainLogger.error('Error in getTransfer', { module: 'CrossChainController', operation: 'getTransfer', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<CrossChainTransfer> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve transfer',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get transfers by address
 */
export const getTransfersByAddress = async (
  req: CrossChainRequest,
  res: Response
): Promise<PaginatedResponse<CrossChainTransfer>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate address parameter
    const addressValidation = ethereumAddressSchema.safeParse(req.params.address);
    if (!addressValidation.success) {
      const errorResponse: PaginatedResponse<CrossChainTransfer> = {
        success: false,
        error: 'Invalid address format',
        message: addressValidation.error.issues.map((e) => e.message).join('; '),
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

    // SECURITY: Validate pagination parameters
    const paginationValidation = paginationQuerySchema.safeParse(req.query);
    const { page, limit } = paginationValidation.success
      ? paginationValidation.data
      : { page: 1, limit: 20 };

    const address = addressValidation.data as EthereumAddress;

    let allTransfers: CrossChainTransfer[] = [];
    if (req.storage) {
      allTransfers = await req.storage.getTransfersByAddress(address);
    }

    // Sort by timestamp (most recent first)
    const sortedTransfers = allTransfers.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    // Implement pagination
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedTransfers = sortedTransfers.slice(startIndex, endIndex);
    const totalPages = Math.ceil(sortedTransfers.length / limit);

    const response: PaginatedResponse<CrossChainTransfer> = {
      success: true,
      data: paginatedTransfers,
      message: `Retrieved ${paginatedTransfers.length} transfers for address ${address}`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: sortedTransfers.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    crosschainLogger.error('Error in getTransfersByAddress', { module: 'CrossChainController', operation: 'getTransfersByAddress', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<CrossChainTransfer> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve transfers by address',
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
 * Complete transfer (for bridge operators)
 */
export const completeTransfer = async (
  req: CrossChainRequest,
  res: Response
): Promise<ControllerResponse<CrossChainTransfer>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate transfer ID parameter
    const transferIdValidation = transferIdSchema.safeParse(req.params.transferId);
    if (!transferIdValidation.success) {
      const errorResponse: ControllerResponse<CrossChainTransfer> = {
        success: false,
        error: 'Invalid transfer ID',
        message: transferIdValidation.error.issues.map((e) => e.message).join('; '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const transferId = transferIdValidation.data;

    // SECURITY: Validate request body
    const bodyValidation = completeTransferSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      const errorResponse: ControllerResponse<CrossChainTransfer> = {
        success: false,
        error: 'Validation failed',
        message: bodyValidation.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const { targetTxHash } = bodyValidation.data;

    let transfer: CrossChainTransfer;
    if (req.storage) {
      transfer = await req.storage.updateTransferStatus(
        transferId,
        'completed',
        targetTxHash
      );
    } else {
      // Mock response for development
      transfer = {
        id: transferId,
        bridgeId: 'mock_bridge',
        from: '0x0000000000000000000000000000000000000000' as EthereumAddress,
        to: '0x0000000000000000000000000000000000000000' as EthereumAddress,
        amount: 1.0 as PositiveNumber,
        token: 'WRF' as SupportedToken,
        sourceChain: 'ethereum',
        targetChain: 'wrfcoin_testnet',
        status: 'completed',
        timestamp: new Date(),
        sourceTxHash: '0x1234567890abcdef',
        targetTxHash,
      };
    }

    const response: ControllerResponse<CrossChainTransfer> = {
      success: true,
      data: transfer,
      message: 'Transfer completed successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    crosschainLogger.error('Error in completeTransfer', { module: 'CrossChainController', operation: 'completeTransfer', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<CrossChainTransfer> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to complete transfer',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  createBridge,
  getBridges,
  initiateTransfer,
  getTransfer,
  getTransfersByAddress,
  completeTransfer,
};
