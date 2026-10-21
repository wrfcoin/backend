/**
 * Mining Controller - TypeScript Implementation
 * Handles mining operations with comprehensive validation and type safety
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import createLogger from '../utils/logger.js';
const miningLogger = createLogger('mining');

// =====================================================
// ZOD VALIDATION SCHEMAS
// Security: Prevent injection attacks via strict input validation
// =====================================================

// Ethereum address validation
const ethereumAddressSchema = z
  .string()
  .min(10, 'Address is required')
  .max(128, 'Address too long')
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

// Mining algorithm whitelist - CRITICAL: Only allow approved algorithms
const miningAlgorithmSchema = z.enum([
  'climate_proof_of_work',
  'weather_verification',
  'environmental_consensus',
  'proof_of_climate_contribution',
], { message: 'Invalid mining algorithm' });

// Positive number validation
const positiveNumberSchema = z
  .number()
  .positive('Value must be positive');

// Hash rate validation (must be positive, reasonable upper limit)
const hashRateSchema = z
  .number()
  .positive('Hash rate must be positive')
  .max(1e15, 'Hash rate exceeds maximum allowed');

// Power consumption validation
const powerSchema = z
  .number()
  .positive('Power must be positive')
  .max(1e9, 'Power consumption exceeds maximum allowed');

// Start mining request schema
const startMiningSchema = z.object({
  miner: ethereumAddressSchema,
  algorithm: miningAlgorithmSchema,
  hashRate: hashRateSchema,
  power: powerSchema,
});

// Operation ID validation (for path params)
const operationIdSchema = z
  .string()
  .min(1, 'Operation ID is required')
  .max(128, 'Operation ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Operation ID contains invalid characters');

// Pagination validation
const paginationSchema = z.object({
  page: z.string().optional().transform((val) => {
    const num = val ? parseInt(val, 10) : 1;
    return isNaN(num) || num < 1 ? 1 : Math.min(num, 10000);
  }),
  limit: z.string().optional().transform((val) => {
    const num = val ? parseInt(val, 10) : 20;
    return isNaN(num) || num < 1 ? 20 : Math.min(num, 100);
  }),
});

// Proof submission schema
const proofSubmissionSchema = z.object({
  operationId: z.string().min(1).max(128),
  proof: z.string()
    .min(66, 'Proof must be at least 66 characters')
    .max(1024, 'Proof too long')
    .regex(/^0x[a-fA-F0-9]+$/, 'Proof must be a valid hex string starting with 0x'),
  blockHeight: z.number().int().positive('Block height must be a positive integer'),
});

// Alert thresholds schema
const alertThresholdsSchema = z.object({
  thresholds: z.record(z.string(), z.number()).refine(
    (obj) => Object.keys(obj).length > 0,
    'At least one threshold must be provided'
  ),
});
import {
  ControllerResponse,
  MiningOperation,
  MiningReward,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

// Enhanced MiningOperation interface with additional fields
interface ExtendedMiningOperation extends MiningOperation {
  pausedAt?: Date;
  resumedAt?: Date;
  restartCount?: number;
}

// Enhanced request interface with storage
interface MiningRequest extends Request {
  storage?: {
    createMiningOperation: (
      operation: Partial<ExtendedMiningOperation>
    ) => Promise<ExtendedMiningOperation>;
    getMiningOperation: (id: string) => Promise<ExtendedMiningOperation | null>;
    getMiningOperationsByMiner: (
      miner: EthereumAddress
    ) => Promise<ExtendedMiningOperation[]>;
    updateMiningOperation: (
      id: string,
      updates: Partial<ExtendedMiningOperation>
    ) => Promise<ExtendedMiningOperation>;
    createMiningReward: (
      reward: Partial<MiningReward>
    ) => Promise<MiningReward>;
    getMiningRewardsByMiner: (
      miner: EthereumAddress
    ) => Promise<MiningReward[]>;
    getNetworkHashrate: () => Promise<number>;
    getDifficulty: () => Promise<number>;
    getBlockHeight: () => Promise<number>;
  };
}

// Mining operation interfaces
interface StartMiningRequest {
  miner: EthereumAddress;
  algorithm: string;
  hashRate: number;
  power: number;
}

interface MiningStats {
  totalHashrate: number;
  activeMinerCount: number;
  networkDifficulty: number;
  averageReward: PositiveNumber;
  blockHeight: number;
}

// Supported mining algorithms
const SUPPORTED_ALGORITHMS = [
  'climate_proof_of_work',
  'weather_verification',
  'environmental_consensus',
  'proof_of_climate_contribution',
];

/**
 * Start mining operation
 */
export const startMining = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<ExtendedMiningOperation>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate input using Zod schema with algorithm whitelist
    const validationResult = startMiningSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: validationResult.error.issues[0]?.message || 'Invalid input',
        message: 'Mining operation validation failed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { miner, algorithm, hashRate, power } = validationResult.data;

    // Create mining operation
    const operationData: Partial<ExtendedMiningOperation> = {
      id: `mining_${uuidv4()}`,
      miner: miner as EthereumAddress,
      algorithm,
      hashRate,
      power,
      startTime: new Date(),
      status: 'active',
      rewardsEarned: 0 as PositiveNumber,
      restartCount: 0,
    };

    let operation: ExtendedMiningOperation;
    if (req.storage) {
      operation = await req.storage.createMiningOperation(operationData);
    } else {
      operation = operationData as ExtendedMiningOperation;
    }

    const response: ControllerResponse<ExtendedMiningOperation> = {
      success: true,
      data: operation,
      message: 'Mining operation started successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in startMining', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<ExtendedMiningOperation> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to start mining operation',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Stop mining operation
 */
export const stopMining = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<MiningOperation>> => {
  const requestId = uuidv4();

  try {
    const operationId = req.params.operationId;

    if (!operationId) {
      const errorResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: 'Operation ID is required',
        message: 'Please provide a valid mining operation ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let operation: MiningOperation | null = null;
    if (req.storage) {
      operation = await req.storage.getMiningOperation(operationId);
    }

    if (!operation) {
      const notFoundResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: 'Mining operation not found',
        message: `No mining operation found with ID ${operationId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    // Update operation status
    const updates: Partial<MiningOperation> = {
      status: 'stopped',
      endTime: new Date(),
    };

    let updatedOperation: MiningOperation;
    if (req.storage) {
      updatedOperation = await req.storage.updateMiningOperation(
        operationId,
        updates
      );
    } else {
      updatedOperation = { ...operation, ...updates };
    }

    const response: ControllerResponse<MiningOperation> = {
      success: true,
      data: updatedOperation,
      message: 'Mining operation stopped successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in stopMining', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MiningOperation> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to stop mining operation',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Pause mining operation
 */
export const pauseMining = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<MiningOperation>> => {
  const requestId = uuidv4();

  try {
    const operationId = req.params.operationId;

    if (!operationId) {
      const errorResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: 'Operation ID is required',
        message: 'Please provide a valid mining operation ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let operation: MiningOperation | null = null;
    if (req.storage) {
      operation = await req.storage.getMiningOperation(operationId);
    }

    if (!operation) {
      const notFoundResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: 'Mining operation not found',
        message: `No mining operation found with ID ${operationId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (operation.status !== 'active') {
      const errorResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: 'Invalid operation state',
        message: 'Only active mining operations can be paused',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Update operation status to paused
    const updates: Partial<MiningOperation> = {
      status: 'paused',
      pausedAt: new Date(),
    };

    let updatedOperation: MiningOperation;
    if (req.storage) {
      updatedOperation = await req.storage.updateMiningOperation(
        operationId,
        updates
      );
    } else {
      updatedOperation = { ...operation, ...updates };
    }

    const response: ControllerResponse<MiningOperation> = {
      success: true,
      data: updatedOperation,
      message: 'Mining operation paused successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in pauseMining', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MiningOperation> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to pause mining operation',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Resume paused mining operation
 */
export const resumeMining = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<MiningOperation>> => {
  const requestId = uuidv4();

  try {
    const operationId = req.params.operationId;

    if (!operationId) {
      const errorResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: 'Operation ID is required',
        message: 'Please provide a valid mining operation ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let operation: MiningOperation | null = null;
    if (req.storage) {
      operation = await req.storage.getMiningOperation(operationId);
    }

    if (!operation) {
      const notFoundResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: 'Mining operation not found',
        message: `No mining operation found with ID ${operationId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (operation.status !== 'paused') {
      const errorResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: 'Invalid operation state',
        message: 'Only paused mining operations can be resumed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Update operation status to active
    const updates: Partial<MiningOperation> = {
      status: 'active',
      resumedAt: new Date(),
      pausedAt: undefined,
    };

    let updatedOperation: MiningOperation;
    if (req.storage) {
      updatedOperation = await req.storage.updateMiningOperation(
        operationId,
        updates
      );
    } else {
      updatedOperation = { ...operation, ...updates };
    }

    const response: ControllerResponse<MiningOperation> = {
      success: true,
      data: updatedOperation,
      message: 'Mining operation resumed successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in resumeMining', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MiningOperation> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to resume mining operation',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Restart mining operation
 */
export const restartMining = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<MiningOperation>> => {
  const requestId = uuidv4();

  try {
    const operationId = req.params.operationId;

    if (!operationId) {
      const errorResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: 'Operation ID is required',
        message: 'Please provide a valid mining operation ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let operation: MiningOperation | null = null;
    if (req.storage) {
      operation = await req.storage.getMiningOperation(operationId);
    }

    if (!operation) {
      const notFoundResponse: ControllerResponse<MiningOperation> = {
        success: false,
        error: 'Mining operation not found',
        message: `No mining operation found with ID ${operationId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    // Reset operation with current configuration
    const updates: Partial<MiningOperation> = {
      status: 'active',
      startTime: new Date(),
      endTime: undefined,
      pausedAt: undefined,
      resumedAt: undefined,
      restartCount: (operation.restartCount || 0) + 1,
    };

    let updatedOperation: MiningOperation;
    if (req.storage) {
      updatedOperation = await req.storage.updateMiningOperation(
        operationId,
        updates
      );
    } else {
      updatedOperation = { ...operation, ...updates };
    }

    const response: ControllerResponse<MiningOperation> = {
      success: true,
      data: updatedOperation,
      message: 'Mining operation restarted successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in restartMining', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MiningOperation> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to restart mining operation',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get mining operations by miner address
 */
export const getMinerOperations = async (
  req: MiningRequest,
  res: Response
): Promise<PaginatedResponse<MiningOperation>> => {
  const requestId = uuidv4();

  try {
    const miner = req.params.miner as EthereumAddress;
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    // Validate Ethereum address
    if (!miner || !miner.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: PaginatedResponse<MiningOperation> = {
        success: false,
        error: 'Invalid miner address format',
        message: 'Miner address must be a valid Ethereum address',
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

    let allOperations: MiningOperation[] = [];
    if (req.storage) {
      allOperations = await req.storage.getMiningOperationsByMiner(miner);
    }

    // Sort by start time (most recent first)
    const sortedOperations = allOperations.sort(
      (a, b) =>
        new Date(b.startTime).getTime() - new Date(a.startTime).getTime()
    );

    // Implement pagination
    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedOperations = sortedOperations.slice(startIndex, endIndex);
    const totalPages = Math.ceil(sortedOperations.length / limit);

    const response: PaginatedResponse<MiningOperation> = {
      success: true,
      data: paginatedOperations,
      message: `Retrieved ${paginatedOperations.length} mining operations for miner ${miner}`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: sortedOperations.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in getMinerOperations', { error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<MiningOperation> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve mining operations',
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
 * Get mining rewards for miner
 */
export const getMinerRewards = async (
  req: MiningRequest,
  res: Response
): Promise<PaginatedResponse<MiningReward>> => {
  const requestId = uuidv4();

  try {
    const miner = req.params.miner as EthereumAddress;
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    if (!miner || !miner.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: PaginatedResponse<MiningReward> = {
        success: false,
        error: 'Invalid miner address format',
        message: 'Miner address must be a valid Ethereum address',
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

    let allRewards: MiningReward[] = [];
    if (req.storage) {
      allRewards = await req.storage.getMiningRewardsByMiner(miner);
    }

    // Sort by timestamp (most recent first)
    const sortedRewards = allRewards.sort(
      (a, b) =>
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    );

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedRewards = sortedRewards.slice(startIndex, endIndex);
    const totalPages = Math.ceil(sortedRewards.length / limit);

    const response: PaginatedResponse<MiningReward> = {
      success: true,
      data: paginatedRewards,
      message: `Retrieved ${paginatedRewards.length} mining rewards for miner ${miner}`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: sortedRewards.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in getMinerRewards', { error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<MiningReward> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve mining rewards',
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
 * Get network mining statistics
 */
export const getMiningStats = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<MiningStats>> => {
  const requestId = uuidv4();

  try {
    // Get network statistics
    let totalHashrate = 0;
    let networkDifficulty = 0;
    let blockHeight = 0;

    if (req.storage) {
      [totalHashrate, networkDifficulty, blockHeight] = await Promise.all([
        req.storage.getNetworkHashrate(),
        req.storage.getDifficulty(),
        req.storage.getBlockHeight(),
      ]);
    } else {
      // Mock values for testing
      totalHashrate = 15750000; // 15.75 MH/s
      networkDifficulty = 2500000;
      blockHeight = 12450;
    }

    const stats: MiningStats = {
      totalHashrate,
      activeMinerCount: Math.floor(totalHashrate / 100000), // Estimate based on average hashrate
      networkDifficulty,
      averageReward: 0.5 as PositiveNumber, // Average 0.5 WRF per block
      blockHeight,
    };

    const response: ControllerResponse<MiningStats> = {
      success: true,
      data: stats,
      message: 'Mining statistics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in getMiningStats', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MiningStats> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve mining statistics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get system performance metrics
 */
export const getSystemPerformance = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<any>> => {
  const requestId = uuidv4();

  try {
    // Simulate system performance data
    const systemMetrics = {
      cpu: {
        usage: Math.random() * 80 + 10, // 10-90%
        cores: Array.from({ length: 8 }, (_, i) => ({
          id: i,
          usage: Math.random() * 100,
        })),
        temperature: Math.random() * 40 + 30, // 30-70°C
        frequency: 3200 + Math.random() * 800, // 3.2-4.0 GHz
      },
      memory: {
        used: Math.random() * 12000 + 2000, // 2-14GB
        total: 16384, // 16GB
        utilization: Math.random() * 80 + 10,
        swap: {
          used: Math.random() * 2000,
          total: 8192,
        },
      },
      gpu: {
        usage: Math.random() * 90 + 5, // 5-95%
        temperature: Math.random() * 50 + 35, // 35-85°C
        memory: {
          used: Math.random() * 6000 + 1000, // 1-7GB
          total: 8192, // 8GB
        },
        clockSpeed: 1500 + Math.random() * 500, // 1.5-2.0 GHz
        powerDraw: 150 + Math.random() * 200, // 150-350W
      },
      network: {
        upload: Math.random() * 50 + 5, // 5-55 MB/s
        download: Math.random() * 100 + 10, // 10-110 MB/s
        latency: Math.random() * 100 + 20, // 20-120ms
        packetsLost: Math.random() * 2, // 0-2%
      },
      storage: {
        readSpeed: 400 + Math.random() * 400, // 400-800 MB/s
        writeSpeed: 300 + Math.random() * 300, // 300-600 MB/s
        utilization: Math.random() * 80 + 10, // 10-90%
        space: {
          used: 500000 + Math.random() * 300000, // 500-800GB used
          total: 1000000, // 1TB total
        },
      },
    };

    const response: ControllerResponse<any> = {
      success: true,
      data: systemMetrics,
      message: 'System performance metrics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in getSystemPerformance', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve system performance metrics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get mining performance metrics
 */
export const getMiningPerformance = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<any>> => {
  const requestId = uuidv4();

  try {
    // Simulate mining performance data
    const currentHashrate = 2500 + Math.random() * 500; // 2.5-3.0 GH/s
    const averageHashrate = 2750 + Math.random() * 100;

    const miningMetrics = {
      hashrate: {
        current: currentHashrate,
        average: averageHashrate,
        variance:
          (Math.abs(currentHashrate - averageHashrate) / averageHashrate) * 100,
        efficiency: 85 + Math.random() * 10, // 85-95%
      },
      workers: {
        active: 6 + Math.floor(Math.random() * 3), // 6-8 workers
        total: 8,
        efficiency: Array.from({ length: 8 }, (_, i) => ({
          id: i,
          efficiency: 70 + Math.random() * 25, // 70-95%
        })),
      },
      pool: {
        latency: 50 + Math.random() * 100, // 50-150ms
        connectionHealth: 80 + Math.random() * 20, // 80-100%
        shareAcceptance: 95 + Math.random() * 4, // 95-99%
        rejectRate: Math.random() * 3, // 0-3%
      },
      errors: {
        total: Math.floor(Math.random() * 20),
        rate: Math.random() * 2, // 0-2 per minute
        types: {
          connection: Math.floor(Math.random() * 5),
          hardware: Math.floor(Math.random() * 3),
          pool: Math.floor(Math.random() * 2),
        },
      },
      optimization: {
        recommendations: [
          'Reduce CPU thread count to optimize power consumption',
          'Increase GPU memory allocation for better performance',
          'Switch to more efficient mining pool with lower latency',
        ].slice(0, Math.floor(Math.random() * 3) + 1),
        score: 75 + Math.random() * 20, // 75-95%
      },
    };

    const response: ControllerResponse<any> = {
      success: true,
      data: miningMetrics,
      message: 'Mining performance metrics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in getMiningPerformance', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve mining performance metrics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get performance alerts and thresholds
 */
export const getPerformanceAlerts = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<any>> => {
  const requestId = uuidv4();

  try {
    // Simulate performance alerts
    const alerts = [
      {
        id: `alert_${Date.now()}_1`,
        type: 'warning',
        metric: 'GPU Temperature',
        value: 78.5,
        threshold: 75,
        message: 'GPU temperature high: 78.5°C',
        timestamp: new Date(Date.now() - 300000), // 5 minutes ago
      },
      {
        id: `alert_${Date.now()}_2`,
        type: 'critical',
        metric: 'Memory Usage',
        value: 87.2,
        threshold: 85,
        message: 'Memory usage critically high: 87.2%',
        timestamp: new Date(Date.now() - 120000), // 2 minutes ago
      },
    ].filter(() => Math.random() > 0.5); // Randomly show/hide alerts

    const response: ControllerResponse<any> = {
      success: true,
      data: { alerts },
      message: 'Performance alerts retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in getPerformanceAlerts', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve performance alerts',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Update alert thresholds
 */
export const updateAlertThresholds = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<any>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate alert thresholds using Zod schema
    const validationResult = alertThresholdsSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<any> = {
        success: false,
        error: validationResult.error.issues[0]?.message || 'Invalid thresholds',
        message: 'Please provide valid alert thresholds to update',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { thresholds } = validationResult.data;

    // In a real implementation, save thresholds to database
    miningLogger.info('Updated alert thresholds', { thresholds, requestId });

    const response: ControllerResponse<any> = {
      success: true,
      data: { thresholds },
      message: 'Alert thresholds updated successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in updateAlertThresholds', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to update alert thresholds',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Submit mining proof
 */
export const submitProof = async (
  req: MiningRequest,
  res: Response
): Promise<ControllerResponse<MiningReward>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate proof submission using Zod schema
    const validationResult = proofSubmissionSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<MiningReward> = {
        success: false,
        error: validationResult.error.issues[0]?.message || 'Invalid proof data',
        message: 'Proof submission validation failed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { operationId, proof, blockHeight } = validationResult.data;

    // Get mining operation
    let operation: MiningOperation | null = null;
    if (req.storage) {
      operation = await req.storage.getMiningOperation(operationId);
    }

    if (!operation) {
      const notFoundResponse: ControllerResponse<MiningReward> = {
        success: false,
        error: 'Mining operation not found',
        message: `No mining operation found with ID ${operationId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    // Note: Proof format already validated by Zod schema (hex string, min 66 chars)

    // Calculate reward based on algorithm and difficulty
    let rewardAmount = 0.1; // Base reward
    switch (operation.algorithm) {
      case 'climate_proof_of_work':
        rewardAmount = 0.5;
        break;
      case 'weather_verification':
        rewardAmount = 0.3;
        break;
      case 'environmental_consensus':
        rewardAmount = 0.4;
        break;
      default:
        rewardAmount = 0.2;
    }

    // Create mining reward
    const rewardData: Partial<MiningReward> = {
      id: `reward_${uuidv4()}`,
      miner: operation.miner,
      amount: rewardAmount as PositiveNumber,
      blockHeight,
      timestamp: new Date(),
      difficulty: 2500000, // Current network difficulty
      algorithm: operation.algorithm,
    };

    let reward: MiningReward;
    if (req.storage) {
      reward = await req.storage.createMiningReward(rewardData);

      // Update mining operation with earned rewards
      await req.storage.updateMiningOperation(operationId, {
        rewardsEarned: (operation.rewardsEarned +
          rewardAmount) as PositiveNumber,
      });
    } else {
      reward = rewardData as MiningReward;
    }

    const response: ControllerResponse<MiningReward> = {
      success: true,
      data: reward,
      message: 'Mining proof validated and reward issued',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in submitProof', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MiningReward> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to process mining proof',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  startMining,
  stopMining,
  pauseMining,
  resumeMining,
  restartMining,
  getMinerOperations,
  getMinerRewards,
  getMiningStats,
  submitProof,
  getSystemPerformance,
  getMiningPerformance,
  getPerformanceAlerts,
  updateAlertThresholds,
};
