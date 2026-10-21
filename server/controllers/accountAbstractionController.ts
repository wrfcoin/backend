/**
 * Account Abstraction Controller - TypeScript Implementation
 * Handles ERC-4337 account abstraction operations and smart wallet management
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { walletLogger } from '../utils/logger.js';
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

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

// Hex data validation (for callData, signature, etc.)
const hexDataSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]*$/, 'Invalid hex data format')
  .max(1000000, 'Hex data too long'); // ~500KB limit

// Hex signature validation
const signatureSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]+$/, 'Invalid signature format')
  .max(1024, 'Signature too long');

// Salt validation (optional hex or string)
const saltSchema = z
  .string()
  .max(128, 'Salt too long')
  .optional();

// Gas limit validation
const gasLimitSchema = z
  .number()
  .int()
  .positive('Gas limit must be positive')
  .max(30000000, 'Gas limit too high')
  .optional();

// Gas price validation
const gasPriceSchema = z
  .number()
  .int()
  .nonnegative('Gas price must be non-negative')
  .max(1e15, 'Gas price too high')
  .optional();

// Threshold validation
const thresholdSchema = z
  .number()
  .int()
  .min(1, 'Threshold must be at least 1')
  .max(100, 'Threshold too high')
  .optional();

// Daily limit validation
const dailyLimitSchema = z
  .number()
  .nonnegative('Daily limit must be non-negative')
  .max(1e18, 'Daily limit too high')
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

// Status validation
const accountStatusSchema = z
  .enum(['active', 'paused', 'upgraded'])
  .optional();

const operationStatusSchema = z
  .enum(['pending', 'submitted', 'included', 'failed', 'reverted'])
  .optional();

// Request body schemas
const deployAccountSchema = z.object({
  owner: ethereumAddressSchema,
  salt: saltSchema,
  features: z.object({
    multiSig: z.boolean().default(false),
    socialRecovery: z.boolean().default(false),
    gaslessTransactions: z.boolean().default(true),
    batchTransactions: z.boolean().default(true),
    scheduledTransactions: z.boolean().default(false),
  }).optional(),
  guardians: z.array(ethereumAddressSchema).max(50, 'Too many guardians').optional(),
  threshold: thresholdSchema,
  dailyLimit: dailyLimitSchema,
});

const executeUserOperationSchema = z.object({
  accountAddress: ethereumAddressSchema,
  sender: ethereumAddressSchema,
  callData: hexDataSchema,
  callGasLimit: gasLimitSchema,
  maxFeePerGas: gasPriceSchema,
  maxPriorityFeePerGas: gasPriceSchema,
  paymasterAndData: z.string().regex(/^0x[a-fA-F0-9]*$/).max(10000).optional(),
  signature: signatureSchema,
});

const accountQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  owner: ethereumAddressSchema.optional(),
  status: accountStatusSchema,
});

const operationsQuerySchema = z.object({
  page: pageSchema,
  limit: limitSchema,
  accountAddress: ethereumAddressSchema.optional(),
  status: operationStatusSchema,
});

// Account Abstraction interfaces
interface SmartAccount {
  id: string;
  address: EthereumAddress;
  owner: EthereumAddress;
  factory: EthereumAddress;
  implementation: EthereumAddress;
  version: string;
  status: 'active' | 'paused' | 'upgraded';
  features: {
    multiSig: boolean;
    socialRecovery: boolean;
    gaslessTransactions: boolean;
    batchTransactions: boolean;
    scheduledTransactions: boolean;
  };
  configuration: {
    guardians: EthereumAddress[];
    threshold: number;
    dailyLimit: PositiveNumber;
    sessionKeys: SessionKey[];
  };
  metrics: {
    totalTransactions: number;
    gasSaved: PositiveNumber;
    lastActivity: Date;
  };
  createdAt: Date;
  updatedAt: Date;
}

interface SessionKey {
  id: string;
  publicKey: string;
  permissions: string[];
  expiresAt: Date;
  isActive: boolean;
  usageCount: number;
  maxUsage?: number;
}

interface UserOperation {
  id: string;
  accountAddress: EthereumAddress;
  sender: EthereumAddress;
  nonce: number;
  initCode: string;
  callData: string;
  callGasLimit: number;
  verificationGasLimit: number;
  preVerificationGas: number;
  maxFeePerGas: PositiveNumber;
  maxPriorityFeePerGas: PositiveNumber;
  paymasterAndData: string;
  signature: string;
  status: 'pending' | 'submitted' | 'included' | 'failed' | 'reverted';
  hash?: string;
  blockNumber?: number;
  gasUsed?: number;
  actualGasCost?: PositiveNumber;
  reason?: string;
  createdAt: Date;
  executedAt?: Date;
}

interface Paymaster {
  id: string;
  address: EthereumAddress;
  name: string;
  type: 'verifying' | 'deposit' | 'token';
  status: 'active' | 'paused' | 'deprecated';
  supportedTokens: EthereumAddress[];
  deposit: PositiveNumber;
  configuration: {
    maxCost: PositiveNumber;
    validUntil: Date;
    validAfter: Date;
  };
  statistics: {
    totalOperations: number;
    totalGasSponsored: PositiveNumber;
    successRate: number;
  };
}

interface BundleOperation {
  id: string;
  bundler: EthereumAddress;
  operations: string[];
  status: 'pending' | 'submitted' | 'included' | 'failed';
  transactionHash?: string;
  blockNumber?: number;
  gasUsed?: number;
  timestamp: Date;
}

// Enhanced request interface
interface AccountAbstractionRequest extends Request {
  storage?: {
    getAllAccounts: () => Promise<SmartAccount[]>;
    getAccount: (address: string) => Promise<SmartAccount | null>;
    createAccount: (account: Partial<SmartAccount>) => Promise<SmartAccount>;
    updateAccount: (
      address: string,
      updates: Partial<SmartAccount>
    ) => Promise<SmartAccount>;
    getUserOperations: (
      accountAddress?: string,
      limit?: number
    ) => Promise<UserOperation[]>;
    createUserOperation: (
      operation: Partial<UserOperation>
    ) => Promise<UserOperation>;
    getPaymasters: () => Promise<Paymaster[]>;
    getBundles: (limit?: number) => Promise<BundleOperation[]>;
  };
  aaService?: {
    deployAccount: (
      owner: EthereumAddress,
      salt?: string
    ) => Promise<SmartAccount>;
    executeUserOperation: (operation: UserOperation) => Promise<string>;
    bundleOperations: (operations: UserOperation[]) => Promise<BundleOperation>;
    estimateGas: (
      operation: Partial<UserOperation>
    ) => Promise<{ gasLimit: number; gasPrice: PositiveNumber }>;
    validateOperation: (operation: UserOperation) => Promise<boolean>;
  };
}

/**
 * Get all smart accounts
 */
export const getAllAccounts = async (
  req: AccountAbstractionRequest,
  res: Response
): Promise<PaginatedResponse<SmartAccount>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate query parameters with Zod
    const validationResult = accountQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      const errorResponse: PaginatedResponse<SmartAccount> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid query parameters',
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

    const { page, limit, owner, status } = validationResult.data;

    let accounts: SmartAccount[] = [];
    if (req.storage) {
      accounts = await req.storage.getAllAccounts();
    } else {
      // Mock accounts for development
      accounts = [
        {
          id: 'account_1',
          address:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          owner:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          factory:
            '0x3456789012345678901234567890123456789012' as EthereumAddress,
          implementation:
            '0x4567890123456789012345678901234567890123' as EthereumAddress,
          version: '1.0.0',
          status: 'active',
          features: {
            multiSig: true,
            socialRecovery: true,
            gaslessTransactions: true,
            batchTransactions: true,
            scheduledTransactions: false,
          },
          configuration: {
            guardians: [
              '0x5678901234567890123456789012345678901234' as EthereumAddress,
            ],
            threshold: 2,
            dailyLimit: 1000 as PositiveNumber,
            sessionKeys: [
              {
                id: 'session_1',
                publicKey: '0x04abc123...',
                permissions: ['transfer', 'approve'],
                expiresAt: new Date(Date.now() + 86400000),
                isActive: true,
                usageCount: 12,
                maxUsage: 100,
              },
            ],
          },
          metrics: {
            totalTransactions: 456,
            gasSaved: 2.5 as PositiveNumber,
            lastActivity: new Date(),
          },
          createdAt: new Date('2024-03-01'),
          updatedAt: new Date(),
        },
      ];
    }

    // Apply filters
    if (owner) {
      accounts = accounts.filter(
        account => account.owner.toLowerCase() === owner.toLowerCase()
      );
    }
    if (status) {
      accounts = accounts.filter(account => account.status === status);
    }

    // Sort by last activity (most recent first)
    accounts.sort(
      (a, b) =>
        new Date(b.metrics.lastActivity).getTime() -
        new Date(a.metrics.lastActivity).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedAccounts = accounts.slice(startIndex, endIndex);
    const totalPages = Math.ceil(accounts.length / limit);

    const response: PaginatedResponse<SmartAccount> = {
      success: true,
      data: paginatedAccounts,
      message: `Retrieved ${paginatedAccounts.length} smart accounts`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: accounts.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    walletLogger.error('Error in getAllAccounts', { module: 'AccountAbstractionController', operation: 'getAllAccounts', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<SmartAccount> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve smart accounts',
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
 * Deploy new smart account
 */
export const deployAccount = async (
  req: AccountAbstractionRequest,
  res: Response
): Promise<ControllerResponse<SmartAccount>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate request body with Zod
    const validationResult = deployAccountSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<SmartAccount> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Validation failed: ' + validationResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { owner, salt, features, guardians, threshold, dailyLimit } = validationResult.data;

    // Deploy account
    let deployedAccount: SmartAccount;
    if (req.aaService) {
      deployedAccount = await req.aaService.deployAccount(
        owner as EthereumAddress,
        salt
      );
    } else {
      // Mock deployment for development
      deployedAccount = {
        id: `account_${uuidv4()}`,
        address:
          `0x${Math.random().toString(16).substring(2, 42).padStart(40, '0')}` as EthereumAddress,
        owner: owner as EthereumAddress,
        factory:
          '0x3456789012345678901234567890123456789012' as EthereumAddress,
        implementation:
          '0x4567890123456789012345678901234567890123' as EthereumAddress,
        version: '1.0.0',
        status: 'active',
        features: {
          multiSig: features?.multiSig ?? false,
          socialRecovery: features?.socialRecovery ?? false,
          gaslessTransactions: features?.gaslessTransactions ?? true,
          batchTransactions: features?.batchTransactions ?? true,
          scheduledTransactions: features?.scheduledTransactions ?? false,
        },
        configuration: {
          guardians: (guardians || []) as EthereumAddress[],
          threshold: threshold || 1,
          dailyLimit: (dailyLimit || 10000) as PositiveNumber,
          sessionKeys: [],
        },
        metrics: {
          totalTransactions: 0,
          gasSaved: 0 as PositiveNumber,
          lastActivity: new Date(),
        },
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    }

    // Store account
    if (req.storage) {
      deployedAccount = await req.storage.createAccount(deployedAccount);
    }

    const response: ControllerResponse<SmartAccount> = {
      success: true,
      data: deployedAccount,
      message: 'Smart account deployed successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    walletLogger.error('Error in deployAccount', { module: 'AccountAbstractionController', operation: 'deployAccount', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<SmartAccount> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to deploy smart account',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Execute user operation
 */
export const executeUserOperation = async (
  req: AccountAbstractionRequest,
  res: Response
): Promise<ControllerResponse<UserOperation>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate request body with Zod
    const validationResult = executeUserOperationSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<UserOperation> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Validation failed: ' + validationResult.error.issues.map(e => e.message).join(', '),
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const {
      accountAddress,
      sender,
      callData,
      callGasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      paymasterAndData = '0x',
      signature,
    } = validationResult.data;

    // Get account
    let account: SmartAccount | null = null;
    if (req.storage) {
      account = await req.storage.getAccount(accountAddress);
    }

    if (!account) {
      const notFoundResponse: ControllerResponse<UserOperation> = {
        success: false,
        error: 'Account not found',
        message: `No smart account found with address ${accountAddress}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (account.status !== 'active') {
      const errorResponse: ControllerResponse<UserOperation> = {
        success: false,
        error: 'Account not active',
        message: 'Cannot execute operations on inactive account',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create user operation
    const operation: Partial<UserOperation> = {
      id: `op_${uuidv4()}`,
      accountAddress: accountAddress as EthereumAddress,
      sender: sender as EthereumAddress,
      nonce: account.metrics.totalTransactions + 1,
      initCode: '0x',
      callData,
      callGasLimit: callGasLimit || 200000,
      verificationGasLimit: 100000,
      preVerificationGas: 21000,
      maxFeePerGas: (maxFeePerGas || 30000000000) as PositiveNumber,
      maxPriorityFeePerGas: (maxPriorityFeePerGas ||
        2000000000) as PositiveNumber,
      paymasterAndData,
      signature,
      status: 'pending',
      createdAt: new Date(),
    };

    let userOperation: UserOperation;
    if (req.storage) {
      userOperation = await req.storage.createUserOperation(operation);
    } else {
      userOperation = operation as UserOperation;
    }

    // Execute operation
    let executionHash: string | undefined;
    if (req.aaService) {
      try {
        // Validate operation first
        const isValid = await req.aaService.validateOperation(userOperation);
        if (!isValid) {
          throw new Error('Invalid user operation');
        }

        executionHash = await req.aaService.executeUserOperation(userOperation);
        userOperation.status = 'submitted';
        userOperation.hash = executionHash;
      } catch (error) {
        userOperation.status = 'failed';
        userOperation.reason = (error as Error).message;
      }
    } else {
      // Mock execution for development
      userOperation.status = 'submitted';
      userOperation.hash = `0x${Math.random().toString(16).substring(2, 66)}`;
    }

    userOperation.executedAt = new Date();

    const response: ControllerResponse<UserOperation> = {
      success: userOperation.status !== 'failed',
      data: userOperation,
      message:
        userOperation.status === 'failed'
          ? `Operation failed: ${userOperation.reason}`
          : 'User operation executed successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(userOperation.status === 'failed' ? 400 : 200).json(response);
    return response;
  } catch (error) {
    walletLogger.error('Error in executeUserOperation', { module: 'AccountAbstractionController', operation: 'executeUserOperation', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<UserOperation> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to execute user operation',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get user operations
 */
export const getUserOperations = async (
  req: AccountAbstractionRequest,
  res: Response
): Promise<PaginatedResponse<UserOperation>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate query parameters with Zod
    const validationResult = operationsQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      const errorResponse: PaginatedResponse<UserOperation> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid query parameters',
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

    const { page, limit, accountAddress, status } = validationResult.data;

    let operations: UserOperation[] = [];
    if (req.storage) {
      operations = await req.storage.getUserOperations(accountAddress, limit);
    } else {
      // Mock operations for development
      operations = [
        {
          id: 'op_1',
          accountAddress:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          sender:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          nonce: 1,
          initCode: '0x',
          callData: '0xa9059cbb000000000000000000000000...',
          callGasLimit: 200000,
          verificationGasLimit: 100000,
          preVerificationGas: 21000,
          maxFeePerGas: 30000000000 as PositiveNumber,
          maxPriorityFeePerGas: 2000000000 as PositiveNumber,
          paymasterAndData: '0x',
          signature: '0x1234...',
          status: 'included',
          hash: '0xabcdef1234567890...',
          blockNumber: 18500000,
          gasUsed: 185000,
          actualGasCost: 0.005 as PositiveNumber,
          createdAt: new Date(Date.now() - 3600000),
          executedAt: new Date(Date.now() - 3590000),
        },
      ];
    }

    // Filter by status if provided
    if (status) {
      operations = operations.filter(op => op.status === status);
    }

    // Sort by creation time (most recent first)
    operations.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedOperations = operations.slice(startIndex, endIndex);
    const totalPages = Math.ceil(operations.length / limit);

    const response: PaginatedResponse<UserOperation> = {
      success: true,
      data: paginatedOperations,
      message: `Retrieved ${paginatedOperations.length} user operations`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: operations.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    walletLogger.error('Error in getUserOperations', { module: 'AccountAbstractionController', operation: 'getUserOperations', error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<UserOperation> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve user operations',
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
 * Get available paymasters
 */
export const getPaymasters = async (
  req: AccountAbstractionRequest,
  res: Response
): Promise<ControllerResponse<Paymaster[]>> => {
  const requestId = uuidv4();

  try {
    let paymasters: Paymaster[] = [];
    if (req.storage) {
      paymasters = await req.storage.getPaymasters();
    } else {
      // Mock paymasters for development
      paymasters = [
        {
          id: 'paymaster_1',
          address:
            '0x1111111111111111111111111111111111111111' as EthereumAddress,
          name: 'Wrfcoin Paymaster',
          type: 'verifying',
          status: 'active',
          supportedTokens: [
            '0x2222222222222222222222222222222222222222' as EthereumAddress,
          ],
          deposit: 100 as PositiveNumber,
          configuration: {
            maxCost: 0.1 as PositiveNumber,
            validUntil: new Date(Date.now() + 86400000),
            validAfter: new Date(),
          },
          statistics: {
            totalOperations: 1250,
            totalGasSponsored: 25.5 as PositiveNumber,
            successRate: 98.4,
          },
        },
      ];
    }

    const response: ControllerResponse<Paymaster[]> = {
      success: true,
      data: paymasters,
      message: `Retrieved ${paymasters.length} paymasters`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    walletLogger.error('Error in getPaymasters', { module: 'AccountAbstractionController', operation: 'getPaymasters', error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<Paymaster[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve paymasters',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  getAllAccounts,
  deployAccount,
  executeUserOperation,
  getUserOperations,
  getPaymasters,
};
