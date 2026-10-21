/**
 * Wallet Controller - TypeScript Implementation
 * Handles wallet operations with type safety and comprehensive validation
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import {
  ControllerResponse,
  WalletBalance,
  WalletTransaction,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

const { db } = require('../db');
const {
  wallets,
  walletUserAssociations,
  users,
} = require('../../shared/schema');
const { logger } = require('../utils/logger');

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

// Network name validation
const networkSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9-]+$/, 'Network must be lowercase alphanumeric with hyphens')
  .optional();

// Balance validation (non-negative number)
const balanceSchema = z
  .number()
  .min(0, 'Balance must be non-negative')
  .max(1e18, 'Balance exceeds maximum');

// Label validation
const labelSchema = z
  .string()
  .max(256, 'Label too long')
  .regex(/^[a-zA-Z0-9\s_-]*$/, 'Label contains invalid characters')
  .optional();

// Public key validation
const publicKeySchema = z
  .string()
  .max(256, 'Public key too long')
  .optional();

// Pagination schemas
const pageSchema = z
  .string()
  .optional()
  .transform((val) => {
    const num = val ? parseInt(val, 10) : 1;
    return isNaN(num) || num < 1 ? 1 : Math.min(num, 10000);
  });

const limitSchema = z
  .string()
  .optional()
  .transform((val) => {
    const num = val ? parseInt(val, 10) : 20;
    return isNaN(num) || num < 1 ? 20 : Math.min(num, 100);
  });

// Request body schemas
const createWalletSchema = z.object({
  address: ethereumAddressSchema,
  network: networkSchema,
  publicKey: publicKeySchema,
  label: labelSchema,
});

const updateBalanceSchema = z.object({
  balance: balanceSchema,
});

const listWalletsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
});

// Wallet metadata interface
interface WalletMetadata {
  network?: string;
  publicKey?: string;
  label?: string;
  [key: string]: any;
}

// Database wallet interface
interface DbWallet {
  id: string;
  address: EthereumAddress;
  network: string;
  balance: PositiveNumber;
  createdAt: Date;
  lastUpdated: Date;
  publicKey?: string;
  label?: string;
  metadata: WalletMetadata;
}

/**
 * Create or retrieve wallet with enhanced validation
 */
export const getOrCreateWallet = async (
  address: EthereumAddress,
  metadata: WalletMetadata = {}
): Promise<DbWallet> => {
  try {
    // Validate Ethereum address format
    if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
      throw new Error('Invalid Ethereum address format');
    }

    // Check if wallet exists
    const [existingWallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.address, address));

    if (existingWallet) {
      return existingWallet as DbWallet;
    }

    // Create new wallet with validation
    const walletData = {
      id: uuidv4(),
      address,
      network: metadata.network || 'testnet',
      balance: 0 as PositiveNumber,
      createdAt: new Date(),
      lastUpdated: new Date(),
      publicKey: metadata.publicKey || null,
      label: metadata.label || null,
      metadata: metadata || {},
    };

    const [newWallet] = await db.insert(wallets).values(walletData).returning();

    logger.info('Created new wallet', {
      address: newWallet.address,
      network: newWallet.network,
      id: newWallet.id,
    });

    return newWallet as DbWallet;
  } catch (error) {
    logger.error('Error in getOrCreateWallet:', error);
    throw error;
  }
};

/**
 * Create wallet endpoint
 */
export const createWallet = async (
  req: Request,
  res: Response
): Promise<ControllerResponse<DbWallet>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate request body with Zod
    const validationResult = createWalletSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<DbWallet> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Validation failed: ' + validationResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { address, network, publicKey, label } = validationResult.data;

    const metadata: WalletMetadata = {
      network: network || 'testnet',
      publicKey,
      label,
    };

    const wallet = await getOrCreateWallet(
      address as EthereumAddress,
      metadata
    );

    const response: ControllerResponse<DbWallet> = {
      success: true,
      data: wallet,
      message:
        wallet.createdAt.getTime() === wallet.lastUpdated.getTime()
          ? 'Wallet created successfully'
          : 'Wallet already exists',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    logger.error('Error in createWallet:', error);
    const errorResponse: ControllerResponse<DbWallet> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create wallet',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get wallet by address
 */
export const getWallet = async (
  req: Request,
  res: Response
): Promise<ControllerResponse<DbWallet>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate address parameter with Zod
    const validationResult = ethereumAddressSchema.safeParse(req.params.address);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<DbWallet> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Address must be a valid 42-character hex string starting with 0x',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const address = validationResult.data as EthereumAddress;

    const [wallet] = await db
      .select()
      .from(wallets)
      .where(eq(wallets.address, address));

    if (!wallet) {
      const notFoundResponse: ControllerResponse<DbWallet> = {
        success: false,
        error: 'Wallet not found',
        message: `No wallet found with address ${address}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    const response: ControllerResponse<DbWallet> = {
      success: true,
      data: wallet as DbWallet,
      message: 'Wallet retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    logger.error('Error in getWallet:', error);
    const errorResponse: ControllerResponse<DbWallet> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve wallet',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Update wallet balance
 */
export const updateWalletBalance = async (
  req: Request,
  res: Response
): Promise<ControllerResponse<DbWallet>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate address parameter with Zod
    const addressValidation = ethereumAddressSchema.safeParse(req.params.address);
    if (!addressValidation.success) {
      const errorResponse: ControllerResponse<DbWallet> = {
        success: false,
        error: addressValidation.error.issues[0].message,
        message: 'Address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // SECURITY: Validate request body with Zod
    const bodyValidation = updateBalanceSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      const errorResponse: ControllerResponse<DbWallet> = {
        success: false,
        error: bodyValidation.error.issues[0].message,
        message: 'Validation failed: ' + bodyValidation.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const address = addressValidation.data as EthereumAddress;
    const { balance } = bodyValidation.data;

    const [updatedWallet] = await db
      .update(wallets)
      .set({
        balance: balance as PositiveNumber,
        lastUpdated: new Date(),
      })
      .where(eq(wallets.address, address))
      .returning();

    if (!updatedWallet) {
      const notFoundResponse: ControllerResponse<DbWallet> = {
        success: false,
        error: 'Wallet not found',
        message: `No wallet found with address ${address}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    logger.info('Updated wallet balance', {
      address: updatedWallet.address,
      previousBalance: 'unknown',
      newBalance: updatedWallet.balance,
    });

    const response: ControllerResponse<DbWallet> = {
      success: true,
      data: updatedWallet as DbWallet,
      message: 'Wallet balance updated successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    logger.error('Error in updateWalletBalance:', error);
    const errorResponse: ControllerResponse<DbWallet> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to update wallet balance',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * List all wallets with pagination
 */
export const listWallets = async (
  req: Request,
  res: Response
): Promise<ControllerResponse<DbWallet[]>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate query parameters with Zod
    const validationResult = listWalletsQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<DbWallet[]> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid query parameters',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { page, limit } = validationResult.data;
    const offset = (page - 1) * limit;

    const allWallets = await db
      .select()
      .from(wallets)
      .limit(limit)
      .offset(offset);

    const response: ControllerResponse<DbWallet[]> = {
      success: true,
      data: allWallets as DbWallet[],
      message: `Retrieved ${allWallets.length} wallets`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    logger.error('Error in listWallets:', error);
    const errorResponse: ControllerResponse<DbWallet[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve wallets',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  createWallet,
  getWallet,
  updateWalletBalance,
  listWallets,
  getOrCreateWallet,
};
