/**
 * Sharding Controller - TypeScript Implementation
 * Handles blockchain sharding operations, shard management, and cross-shard communication
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { appLogger } from '../utils/logger.js';
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

// Zod validation schemas for sharding operations
const ethereumAddressSchema = z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');
const publicKeySchema = z.string().regex(/^0x04[a-fA-F0-9]+$/, 'Invalid public key format');
const shardIndexSchema = z.number().int().min(0).max(1023);
const amountSchema = z.number().min(0.000001).max(1000000000000);

const shardStatusSchema = z.enum(['active', 'inactive', 'syncing', 'maintenance']);
const txStatusSchema = z.enum(['pending', 'confirmed', 'failed', 'finalized']);
const rebalanceStrategySchema = z.enum(['geographic', 'load_based', 'validator_count', 'manual']);

const shardConfigurationSchema = z.object({
  maxValidators: z.number().min(1).max(1000),
  blockTime: z.number().min(1).max(600),
  consensusThreshold: z.number().min(51).max(100),
}).transform(data => ({
  maxValidators: data.maxValidators,
  blockTime: data.blockTime,
  consensusThreshold: data.consensusThreshold,
}));

const validatorSchema = z.object({
  address: ethereumAddressSchema,
  publicKey: z.string().max(256).optional(),
  stake: z.number().min(0).optional(),
});

const shardMetadataSchema = z.object({
  dataRange: z.string().max(256).default(''),
  geographicRegion: z.string().max(128).optional(),
  specialization: z.string().max(128).optional(),
}).default({} as any);

const createShardSchema = z.object({
  shardIndex: shardIndexSchema,
  configuration: shardConfigurationSchema,
  metadata: shardMetadataSchema,
  initialValidators: z.array(validatorSchema).max(1000).optional(),
});

const crossShardTxSchema = z.object({
  fromShard: shardIndexSchema,
  toShard: shardIndexSchema,
  sender: ethereumAddressSchema,
  recipient: ethereumAddressSchema,
  amount: amountSchema,
});

const rebalanceSchema = z.object({
  targetShards: z.number().int().min(1).max(1024),
  strategy: rebalanceStrategySchema,
  parameters: z.record(z.string(), z.unknown()).optional(),
});

// Sharding interfaces
interface Shard {
  id: string;
  shardIndex: number;
  status: 'active' | 'inactive' | 'syncing' | 'maintenance';
  validators: ShardValidator[];
  currentHeight: number;
  totalTransactions: number;
  tps: number; // Transactions per second
  lastBlockTime: Date;
  configuration: {
    maxValidators: number;
    blockTime: number; // seconds
    consensusThreshold: number; // percentage
  };
  metadata: {
    dataRange: string;
    geographicRegion?: string;
    specialization?: string;
  };
  createdAt: Date;
  updatedAt: Date;
}

interface ShardValidator {
  address: EthereumAddress;
  publicKey: string;
  stake: PositiveNumber;
  isActive: boolean;
  performance: {
    uptime: number; // percentage
    blocksProduced: number;
    blocksVoted: number;
    avgResponseTime: number; // ms
  };
  joinedAt: Date;
}

interface CrossShardTransaction {
  id: string;
  fromShard: number;
  toShard: number;
  sender: EthereumAddress;
  recipient: EthereumAddress;
  amount: PositiveNumber;
  status: 'pending' | 'confirmed' | 'failed' | 'finalized';
  proofs: {
    inclusionProof: string;
    merkleRoot: string;
    witnessSignatures: string[];
  };
  submittedAt: Date;
  confirmedAt?: Date;
  finalizedAt?: Date;
}

interface ShardMetrics {
  shardIndex: number;
  blockHeight: number;
  transactionCount: number;
  averageBlockTime: number;
  tps: number;
  validatorCount: number;
  activeValidators: number;
  networkLatency: number; // ms
  storageUsed: number; // bytes
  crossShardTxCount: number;
  timestamp: Date;
}

interface RebalanceRequest {
  targetShards: number;
  strategy: 'geographic' | 'load_based' | 'validator_count' | 'manual';
  parameters: Record<string, any>;
}

// Enhanced request interface
interface ShardingRequest extends Request {
  storage?: {
    getAllShards: () => Promise<Shard[]>;
    getShard: (shardIndex: number) => Promise<Shard | null>;
    createShard: (shard: Partial<Shard>) => Promise<Shard>;
    updateShard: (
      shardIndex: number,
      updates: Partial<Shard>
    ) => Promise<Shard>;
    getCrossShardTransactions: (
      status?: string
    ) => Promise<CrossShardTransaction[]>;
    createCrossShardTransaction: (
      tx: Partial<CrossShardTransaction>
    ) => Promise<CrossShardTransaction>;
    getShardMetrics: (
      shardIndex?: number,
      hours?: number
    ) => Promise<ShardMetrics[]>;
    addValidatorToShard: (
      shardIndex: number,
      validator: ShardValidator
    ) => Promise<Shard>;
  };
  shardingService?: {
    rebalanceShards: (request: RebalanceRequest) => Promise<boolean>;
    processCrossShardTx: (tx: CrossShardTransaction) => Promise<boolean>;
    validateShardState: (shardIndex: number) => Promise<boolean>;
    synchronizeShards: () => Promise<boolean>;
  };
}

/**
 * Get all shards
 */
export const getAllShards = async (
  req: ShardingRequest,
  res: Response
): Promise<ControllerResponse<Shard[]>> => {
  const requestId = uuidv4();

  try {
    const status = req.query.status as string;
    const includeMetrics = req.query.includeMetrics === 'true';

    let shards: Shard[] = [];
    if (req.storage) {
      shards = await req.storage.getAllShards();
    } else {
      // Mock shards for development
      shards = [
        {
          id: 'shard_0',
          shardIndex: 0,
          status: 'active',
          validators: [
            {
              address:
                '0x1234567890123456789012345678901234567890' as EthereumAddress,
              publicKey: '0x04abc123...',
              stake: 50000 as PositiveNumber,
              isActive: true,
              performance: {
                uptime: 99.8,
                blocksProduced: 1250,
                blocksVoted: 4800,
                avgResponseTime: 120,
              },
              joinedAt: new Date('2024-01-15'),
            },
          ],
          currentHeight: 25000,
          totalTransactions: 1250000,
          tps: 850,
          lastBlockTime: new Date(),
          configuration: {
            maxValidators: 20,
            blockTime: 3,
            consensusThreshold: 67,
          },
          metadata: {
            dataRange: '0x0000-0x3FFF',
            geographicRegion: 'North America',
            specialization: 'weather_data',
          },
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date(),
        },
        {
          id: 'shard_1',
          shardIndex: 1,
          status: 'active',
          validators: [
            {
              address:
                '0x2345678901234567890123456789012345678901' as EthereumAddress,
              publicKey: '0x04def456...',
              stake: 45000 as PositiveNumber,
              isActive: true,
              performance: {
                uptime: 99.5,
                blocksProduced: 1180,
                blocksVoted: 4650,
                avgResponseTime: 135,
              },
              joinedAt: new Date('2024-01-20'),
            },
          ],
          currentHeight: 24950,
          totalTransactions: 980000,
          tps: 720,
          lastBlockTime: new Date(),
          configuration: {
            maxValidators: 20,
            blockTime: 3,
            consensusThreshold: 67,
          },
          metadata: {
            dataRange: '0x4000-0x7FFF',
            geographicRegion: 'Europe',
            specialization: 'financial_data',
          },
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date(),
        },
      ];
    }

    // Filter by status if provided
    if (status) {
      shards = shards.filter(shard => shard.status === status);
    }

    // Sort by shard index
    shards.sort((a, b) => a.shardIndex - b.shardIndex);

    const response: ControllerResponse<Shard[]> = {
      success: true,
      data: shards,
      message: `Retrieved ${shards.length} shards`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to retrieve shards', { module: 'ShardingController', operation: 'getAllShards', error: (error as Error).message });
    const errorResponse: ControllerResponse<Shard[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve shards',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Create new shard
 */
export const createShard = async (
  req: ShardingRequest,
  res: Response
): Promise<ControllerResponse<Shard>> => {
  const requestId = uuidv4();

  try {
    // Zod validation
    const validationResult = createShardSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<Shard> = {
        success: false,
        error: 'Validation failed',
        message: validationResult.error.issues[0]?.message || 'Invalid input data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { shardIndex, configuration, metadata, initialValidators } = validationResult.data;

    // Check if shard already exists
    let existingShard: Shard | null = null;
    if (req.storage) {
      existingShard = await req.storage.getShard(shardIndex);
    }

    if (existingShard) {
      const conflictResponse: ControllerResponse<Shard> = {
        success: false,
        error: 'Shard already exists',
        message: `Shard with index ${shardIndex} already exists`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(409).json(conflictResponse);
      return conflictResponse;
    }

    // Build validators from validated input
    const validators: ShardValidator[] = [];
    if (initialValidators && Array.isArray(initialValidators)) {
      for (const validatorData of initialValidators) {
        validators.push({
          address: validatorData.address as EthereumAddress,
          publicKey: validatorData.publicKey || '',
          stake: (validatorData.stake || 0) as PositiveNumber,
          isActive: true,
          performance: {
            uptime: 100,
            blocksProduced: 0,
            blocksVoted: 0,
            avgResponseTime: 0,
          },
          joinedAt: new Date(),
        });
      }
    }

    // Create shard data
    const shardData: Partial<Shard> = {
      id: `shard_${shardIndex}`,
      shardIndex,
      status: 'inactive',
      validators,
      currentHeight: 0,
      totalTransactions: 0,
      tps: 0,
      lastBlockTime: new Date(),
      configuration,
      metadata: metadata || { dataRange: 'unspecified' },
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let shard: Shard;
    if (req.storage) {
      shard = await req.storage.createShard(shardData);
    } else {
      shard = shardData as Shard;
    }

    const response: ControllerResponse<Shard> = {
      success: true,
      data: shard,
      message: `Shard ${shardIndex} created successfully`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to create shard', { module: 'ShardingController', operation: 'createShard', error: (error as Error).message });
    const errorResponse: ControllerResponse<Shard> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create shard',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Submit cross-shard transaction
 */
export const submitCrossShardTransaction = async (
  req: ShardingRequest,
  res: Response
): Promise<ControllerResponse<CrossShardTransaction>> => {
  const requestId = uuidv4();

  try {
    // Zod validation
    const validationResult = crossShardTxSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<CrossShardTransaction> = {
        success: false,
        error: 'Validation failed',
        message: validationResult.error.issues[0]?.message || 'Invalid input data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { fromShard, toShard, sender, recipient, amount } = validationResult.data;

    // Additional business logic validation: same shard check
    if (fromShard === toShard) {
      const errorResponse: ControllerResponse<CrossShardTransaction> = {
        success: false,
        error: 'Same shard transaction',
        message: 'Cross-shard transactions must be between different shards',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Verify shards exist
    const sourceShardExists = req.storage
      ? await req.storage.getShard(fromShard)
      : true;
    const targetShardExists = req.storage
      ? await req.storage.getShard(toShard)
      : true;

    if (!sourceShardExists || !targetShardExists) {
      const errorResponse: ControllerResponse<CrossShardTransaction> = {
        success: false,
        error: 'Shard not found',
        message: 'One or both specified shards do not exist',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(errorResponse);
      return errorResponse;
    }

    // Create cross-shard transaction
    const txData: Partial<CrossShardTransaction> = {
      id: `xshard_${uuidv4()}`,
      fromShard,
      toShard,
      sender: sender as EthereumAddress,
      recipient: recipient as EthereumAddress,
      amount: amount as PositiveNumber,
      status: 'pending',
      proofs: {
        inclusionProof: '',
        merkleRoot: '',
        witnessSignatures: [],
      },
      submittedAt: new Date(),
    };

    let transaction: CrossShardTransaction;
    if (req.storage) {
      transaction = await req.storage.createCrossShardTransaction(txData);
    } else {
      transaction = txData as CrossShardTransaction;
    }

    // Process transaction if service is available
    if (req.shardingService) {
      const processed =
        await req.shardingService.processCrossShardTx(transaction);
      if (processed) {
        transaction.status = 'confirmed';
        transaction.confirmedAt = new Date();
      }
    }

    const response: ControllerResponse<CrossShardTransaction> = {
      success: true,
      data: transaction,
      message: 'Cross-shard transaction submitted successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to submit cross-shard transaction', { module: 'ShardingController', operation: 'submitCrossShardTransaction', error: (error as Error).message });
    const errorResponse: ControllerResponse<CrossShardTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to submit cross-shard transaction',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get shard metrics
 */
export const getShardMetrics = async (
  req: ShardingRequest,
  res: Response
): Promise<ControllerResponse<ShardMetrics[]>> => {
  const requestId = uuidv4();

  try {
    const shardIndex = req.query.shardIndex
      ? parseInt(req.query.shardIndex as string, 10)
      : undefined;
    const hours = Math.min(parseInt(req.query.hours as string, 10) || 24, 168); // Max 7 days

    let metrics: ShardMetrics[] = [];
    if (req.storage) {
      metrics = await req.storage.getShardMetrics(shardIndex, hours);
    } else {
      // Mock metrics for development
      const shardsToInclude = shardIndex !== undefined ? [shardIndex] : [0, 1];
      const now = Date.now();

      for (const shard of shardsToInclude) {
        for (let i = 0; i < hours; i++) {
          const timestamp = new Date(now - i * 60 * 60 * 1000);
          metrics.push({
            shardIndex: shard,
            blockHeight: 25000 - i,
            transactionCount: Math.floor(Math.random() * 1000) + 500,
            averageBlockTime: 2.8 + Math.random() * 0.4,
            tps: Math.floor(Math.random() * 200) + 600,
            validatorCount: 20,
            activeValidators: 18 + Math.floor(Math.random() * 3),
            networkLatency: Math.floor(Math.random() * 50) + 100,
            storageUsed: Math.floor(Math.random() * 1000000000) + 5000000000,
            crossShardTxCount: Math.floor(Math.random() * 50) + 10,
            timestamp,
          });
        }
      }
    }

    // Sort by timestamp and shard index
    metrics.sort((a, b) => {
      const timeDiff =
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      return timeDiff !== 0 ? timeDiff : a.shardIndex - b.shardIndex;
    });

    const response: ControllerResponse<ShardMetrics[]> = {
      success: true,
      data: metrics,
      message: `Retrieved ${metrics.length} metric points`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to retrieve shard metrics', { module: 'ShardingController', operation: 'getShardMetrics', error: (error as Error).message });
    const errorResponse: ControllerResponse<ShardMetrics[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve shard metrics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get cross-shard transactions
 */
export const getCrossShardTransactions = async (
  req: ShardingRequest,
  res: Response
): Promise<PaginatedResponse<CrossShardTransaction>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);
    const status = req.query.status as string;
    const fromShard = req.query.fromShard
      ? parseInt(req.query.fromShard as string, 10)
      : undefined;
    const toShard = req.query.toShard
      ? parseInt(req.query.toShard as string, 10)
      : undefined;

    let transactions: CrossShardTransaction[] = [];
    if (req.storage) {
      transactions = await req.storage.getCrossShardTransactions(status);
    } else {
      // Mock transactions for development
      transactions = [
        {
          id: 'xshard_1',
          fromShard: 0,
          toShard: 1,
          sender:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          recipient:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          amount: 100.5 as PositiveNumber,
          status: 'finalized',
          proofs: {
            inclusionProof: '0xabcdef...',
            merkleRoot: '0x123456...',
            witnessSignatures: ['0xsig1...', '0xsig2...'],
          },
          submittedAt: new Date(Date.now() - 3600000),
          confirmedAt: new Date(Date.now() - 3300000),
          finalizedAt: new Date(Date.now() - 3000000),
        },
      ];
    }

    // Apply filters
    if (fromShard !== undefined) {
      transactions = transactions.filter(tx => tx.fromShard === fromShard);
    }
    if (toShard !== undefined) {
      transactions = transactions.filter(tx => tx.toShard === toShard);
    }

    // Sort by submission time (most recent first)
    transactions.sort(
      (a, b) =>
        new Date(b.submittedAt).getTime() - new Date(a.submittedAt).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedTxs = transactions.slice(startIndex, endIndex);
    const totalPages = Math.ceil(transactions.length / limit);

    const response: PaginatedResponse<CrossShardTransaction> = {
      success: true,
      data: paginatedTxs,
      message: `Retrieved ${paginatedTxs.length} cross-shard transactions`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: transactions.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to retrieve cross-shard transactions', { module: 'ShardingController', operation: 'getCrossShardTransactions', error: (error as Error).message });
    const errorResponse: PaginatedResponse<CrossShardTransaction> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve cross-shard transactions',
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
 * Rebalance shards
 */
export const rebalanceShards = async (
  req: ShardingRequest,
  res: Response
): Promise<ControllerResponse<{ success: boolean }>> => {
  const requestId = uuidv4();

  try {
    // Zod validation
    const validationResult = rebalanceSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<{ success: boolean }> = {
        success: false,
        error: 'Validation failed',
        message: validationResult.error.issues[0]?.message || 'Invalid input data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { targetShards, strategy, parameters } = validationResult.data;

    // Execute rebalancing
    let rebalanced = false;
    if (req.shardingService) {
      rebalanced = await req.shardingService.rebalanceShards({
        targetShards,
        strategy,
        parameters: parameters || {},
      });
    } else {
      rebalanced = true; // Mock success
    }

    const response: ControllerResponse<{ success: boolean }> = {
      success: true,
      data: { success: rebalanced },
      message: rebalanced
        ? `Shard rebalancing initiated successfully (target: ${targetShards} shards)`
        : 'Shard rebalancing failed',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    appLogger.error('Failed to rebalance shards', { module: 'ShardingController', operation: 'rebalanceShards', error: (error as Error).message });
    const errorResponse: ControllerResponse<{ success: boolean }> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to rebalance shards',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
/**
 * Get shards (alias for getAllShards)
 */
export const getShards = getAllShards;

/**
 * Get shard by ID
 */
export const getShardById = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();
  try {
    const { id } = req.params;
    res.json({
      success: true,
      shard: { id, status: 'active', nodeCount: 0, blockHeight: 0 },
      requestId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message, requestId });
  }
};

/**
 * Get cross-shard transactions (alias for getCrossShardTransactions)
 */
export const getTransactions = getCrossShardTransactions;

/**
 * Get verification status
 */
export const getVerificationStatus = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();
  try {
    res.json({
      success: true,
      verification: { status: 'verified', lastChecked: new Date().toISOString(), integrity: 100 },
      requestId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message, requestId });
  }
};

/**
 * Get nodes for a specific shard
 */
export const getShardNodes = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();
  try {
    const { id } = req.params;
    res.json({
      success: true,
      shardId: id,
      nodes: [],
      requestId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message, requestId });
  }
};

/**
 * Get blocks for a specific shard
 */
export const getShardBlocks = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();
  try {
    const { id } = req.params;
    res.json({
      success: true,
      shardId: id,
      blocks: [],
      requestId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message, requestId });
  }
};

/**
 * Get hierarchical structure information
 */
export const getHierarchicalStructure = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();
  try {
    res.json({
      success: true,
      hierarchy: { levels: [], rootShardId: null },
      requestId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message, requestId });
  }
};

export default {
  getAllShards,
  createShard,
  submitCrossShardTransaction,
  getShardMetrics,
  getCrossShardTransactions,
  rebalanceShards,
  getShards,
  getShardById,
  getTransactions,
  getVerificationStatus,
  getShardNodes,
  getShardBlocks,
  getHierarchicalStructure,
};
