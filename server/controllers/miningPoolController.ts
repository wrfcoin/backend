/**
 * Mining Pool Controller - TypeScript Implementation
 * Handles mining pool operations, member management, and reward distribution
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

// Pool type whitelist
const poolTypeSchema = z.enum(['public', 'private', 'invitation_only'], {
  message: 'Invalid pool type',
});

// Pool algorithm whitelist
const poolAlgorithmSchema = z.enum([
  'proof_of_work',
  'proof_of_useful_analysis',
  'proof_of_publishing',
], { message: 'Invalid pool algorithm' });

// Payment scheme whitelist
const paymentSchemeSchema = z.enum(['pps', 'pplns', 'prop', 'solo'], {
  message: 'Invalid payment scheme',
});

// Pool configuration schema - required fields must match interface
const poolConfigurationSchema = z.object({
  minimumHashrate: z.number().positive('Minimum hashrate must be positive'),
  minimumStake: z.number().positive().optional(),
  feePercentage: z.number().min(0, 'Fee cannot be negative').max(10, 'Fee cannot exceed 10%'),
  payoutThreshold: z.number().positive('Payout threshold must be positive'),
  difficultyTarget: z.number().positive().default(1000000),
  blockTime: z.number().positive().default(300),
});

// Create pool request schema
const createPoolSchema = z.object({
  name: z.string().min(1, 'Name is required').max(128, 'Name too long'),
  description: z.string().max(1024, 'Description too long').optional(),
  operator: ethereumAddressSchema,
  poolType: poolTypeSchema,
  algorithm: poolAlgorithmSchema,
  configuration: poolConfigurationSchema,
  paymentScheme: paymentSchemeSchema,
});

// Join pool request schema
const joinPoolSchema = z.object({
  address: ethereumAddressSchema,
  username: z.string().max(64, 'Username too long').optional(),
});

// Submit share request schema
const submitShareSchema = z.object({
  poolId: z.string().min(1).max(128).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid pool ID format'),
  member: ethereumAddressSchema,
  nonce: z.string().min(1).max(256).regex(/^[a-fA-F0-9]+$/, 'Nonce must be a hex string'),
  difficulty: z.number().positive('Difficulty must be positive'),
});

// Pool ID validation (for path params)
const poolIdSchema = z
  .string()
  .min(1, 'Pool ID is required')
  .max(128, 'Pool ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Pool ID contains invalid characters');

// Query filter schemas
const poolQuerySchema = z.object({
  poolType: poolTypeSchema.optional(),
  algorithm: poolAlgorithmSchema.optional(),
  status: z.enum(['active', 'inactive', 'maintenance']).optional(),
});

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
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

// Mining Pool interfaces
interface MiningPool {
  id: string;
  name: string;
  description: string;
  operator: EthereumAddress;
  poolType: 'public' | 'private' | 'invitation_only';
  algorithm:
    | 'proof_of_work'
    | 'proof_of_useful_analysis'
    | 'proof_of_publishing';
  status: 'active' | 'inactive' | 'maintenance';
  configuration: {
    minimumHashrate: number; // H/s
    minimumStake?: PositiveNumber;
    feePercentage: number; // 0-100
    payoutThreshold: PositiveNumber;
    difficultyTarget: number;
    blockTime: number; // seconds
  };
  statistics: {
    totalHashrate: number; // H/s
    memberCount: number;
    blocksFound: number;
    totalRewards: PositiveNumber;
    efficiency: number; // percentage
    uptime: number; // percentage
  };
  paymentScheme: 'pps' | 'pplns' | 'prop' | 'solo'; // Pay Per Share, Pay Per Last N Shares, Proportional, Solo
  createdAt: Date;
  updatedAt: Date;
}

interface PoolMember {
  id: string;
  poolId: string;
  address: EthereumAddress;
  username?: string;
  joinedAt: Date;
  status: 'active' | 'inactive' | 'banned';
  statistics: {
    hashrate: number; // H/s
    shares: number;
    validShares: number;
    invalidShares: number;
    blocksFound: number;
    totalEarnings: PositiveNumber;
    lastActivity: Date;
  };
  settings: {
    difficulty: number;
    autoPayoutEnabled: boolean;
    payoutAddress?: EthereumAddress;
  };
}

interface PoolReward {
  id: string;
  poolId: string;
  blockHash: string;
  blockHeight: number;
  totalReward: PositiveNumber;
  poolFee: PositiveNumber;
  memberRewards: {
    address: EthereumAddress;
    amount: PositiveNumber;
    shares: number;
  }[];
  distributedAt: Date;
  status: 'pending' | 'distributed' | 'failed';
}

interface ShareSubmission {
  id: string;
  poolId: string;
  member: EthereumAddress;
  nonce: string;
  difficulty: number;
  isValid: boolean;
  timestamp: Date;
  blockHash?: string;
  accepted: boolean;
}

// Enhanced request interface
interface MiningPoolRequest extends Request {
  storage?: {
    getAllPools: () => Promise<MiningPool[]>;
    getPool: (id: string) => Promise<MiningPool | null>;
    createPool: (pool: Partial<MiningPool>) => Promise<MiningPool>;
    updatePool: (
      id: string,
      updates: Partial<MiningPool>
    ) => Promise<MiningPool>;
    getPoolMembers: (poolId: string) => Promise<PoolMember[]>;
    addMember: (member: Partial<PoolMember>) => Promise<PoolMember>;
    updateMember: (
      id: string,
      updates: Partial<PoolMember>
    ) => Promise<PoolMember>;
    getPoolRewards: (poolId: string, limit?: number) => Promise<PoolReward[]>;
    submitShare: (share: Partial<ShareSubmission>) => Promise<ShareSubmission>;
  };
  miningService?: {
    validateShare: (share: any) => Promise<boolean>;
    calculateRewards: (pool: MiningPool, block: any) => Promise<any>;
    distributeRewards: (poolId: string, rewards: any) => Promise<boolean>;
  };
}

/**
 * Get all mining pools
 */
export const getAllPools = async (
  req: MiningPoolRequest,
  res: Response
): Promise<ControllerResponse<MiningPool[]>> => {
  const requestId = uuidv4();

  try {
    const poolType = req.query.poolType as string;
    const algorithm = req.query.algorithm as string;
    const status = req.query.status as string;

    let pools: MiningPool[] = [];
    if (req.storage) {
      pools = await req.storage.getAllPools();
    } else {
      // Mock pools for development
      pools = [
        {
          id: 'pool_1',
          name: 'Wrfcoin Weather Pool',
          description: 'Mining pool focused on weather data analysis',
          operator:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          poolType: 'public',
          algorithm: 'proof_of_useful_analysis',
          status: 'active',
          configuration: {
            minimumHashrate: 1000000, // 1 MH/s
            minimumStake: 100 as PositiveNumber,
            feePercentage: 2.5,
            payoutThreshold: 1 as PositiveNumber,
            difficultyTarget: 1000000,
            blockTime: 300,
          },
          statistics: {
            totalHashrate: 250000000, // 250 MH/s
            memberCount: 156,
            blocksFound: 2450,
            totalRewards: 12500.75 as PositiveNumber,
            efficiency: 98.5,
            uptime: 99.8,
          },
          paymentScheme: 'pplns',
          createdAt: new Date('2024-01-15'),
          updatedAt: new Date(),
        },
        {
          id: 'pool_2',
          name: 'Climate Research Collective',
          description: 'Private pool for climate research institutions',
          operator:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          poolType: 'private',
          algorithm: 'proof_of_publishing',
          status: 'active',
          configuration: {
            minimumHashrate: 5000000, // 5 MH/s
            minimumStake: 1000 as PositiveNumber,
            feePercentage: 1.0,
            payoutThreshold: 5 as PositiveNumber,
            difficultyTarget: 2000000,
            blockTime: 180,
          },
          statistics: {
            totalHashrate: 450000000, // 450 MH/s
            memberCount: 42,
            blocksFound: 1850,
            totalRewards: 22500.25 as PositiveNumber,
            efficiency: 99.2,
            uptime: 99.9,
          },
          paymentScheme: 'pps',
          createdAt: new Date('2024-02-01'),
          updatedAt: new Date(),
        },
      ];
    }

    // Apply filters
    if (poolType) {
      pools = pools.filter(pool => pool.poolType === poolType);
    }
    if (algorithm) {
      pools = pools.filter(pool => pool.algorithm === algorithm);
    }
    if (status) {
      pools = pools.filter(pool => pool.status === status);
    }

    // Sort by total hashrate (highest first)
    pools.sort(
      (a, b) => b.statistics.totalHashrate - a.statistics.totalHashrate
    );

    const response: ControllerResponse<MiningPool[]> = {
      success: true,
      data: pools,
      message: `Retrieved ${pools.length} mining pools`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in getAllPools', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MiningPool[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve mining pools',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Create mining pool
 */
export const createPool = async (
  req: MiningPoolRequest,
  res: Response
): Promise<ControllerResponse<MiningPool>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate all input using Zod schema with whitelisted values
    const validationResult = createPoolSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<MiningPool> = {
        success: false,
        error: validationResult.error.issues[0]?.message || 'Invalid input',
        message: 'Pool creation validation failed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const {
      name,
      description,
      operator,
      poolType,
      algorithm,
      configuration,
      paymentScheme,
    } = validationResult.data;

    // Create pool data
    const poolData: Partial<MiningPool> = {
      id: `pool_${uuidv4()}`,
      name,
      description: description || '',
      operator: operator as EthereumAddress,
      poolType,
      algorithm,
      status: 'active',
      configuration: {
        minimumHashrate: configuration.minimumHashrate,
        minimumStake: configuration.minimumStake as PositiveNumber | undefined,
        feePercentage: configuration.feePercentage,
        payoutThreshold: configuration.payoutThreshold as PositiveNumber,
        difficultyTarget: configuration.difficultyTarget,
        blockTime: configuration.blockTime,
      },
      statistics: {
        totalHashrate: 0,
        memberCount: 0,
        blocksFound: 0,
        totalRewards: 0 as PositiveNumber,
        efficiency: 100,
        uptime: 100,
      },
      paymentScheme,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    let pool: MiningPool;
    if (req.storage) {
      pool = await req.storage.createPool(poolData);
    } else {
      pool = poolData as MiningPool;
    }

    const response: ControllerResponse<MiningPool> = {
      success: true,
      data: pool,
      message: 'Mining pool created successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in createPool', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<MiningPool> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to create mining pool',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Join mining pool
 */
export const joinPool = async (
  req: MiningPoolRequest,
  res: Response
): Promise<ControllerResponse<PoolMember>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate pool ID path parameter
    const poolIdValidation = poolIdSchema.safeParse(req.params.poolId);
    if (!poolIdValidation.success) {
      const errorResponse: ControllerResponse<PoolMember> = {
        success: false,
        error: poolIdValidation.error.issues[0]?.message || 'Invalid pool ID',
        message: 'Pool ID validation failed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const poolId = poolIdValidation.data;

    // SECURITY: Validate join pool request body
    const bodyValidation = joinPoolSchema.safeParse(req.body);
    if (!bodyValidation.success) {
      const errorResponse: ControllerResponse<PoolMember> = {
        success: false,
        error: bodyValidation.error.issues[0]?.message || 'Invalid input',
        message: 'Join pool validation failed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const { address, username } = bodyValidation.data;

    // Get pool
    let pool: MiningPool | null = null;
    if (req.storage) {
      pool = await req.storage.getPool(poolId);
    }

    if (!pool) {
      const notFoundResponse: ControllerResponse<PoolMember> = {
        success: false,
        error: 'Pool not found',
        message: `No mining pool found with ID ${poolId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    if (pool.status !== 'active') {
      const errorResponse: ControllerResponse<PoolMember> = {
        success: false,
        error: 'Pool not active',
        message: 'Cannot join inactive pool',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Check if member already exists
    let existingMembers: PoolMember[] = [];
    if (req.storage) {
      existingMembers = await req.storage.getPoolMembers(poolId);
    }

    const existingMember = existingMembers.find(
      member => member.address === address
    );
    if (existingMember) {
      const conflictResponse: ControllerResponse<PoolMember> = {
        success: false,
        error: 'Already a member',
        message: 'Address is already a member of this pool',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(409).json(conflictResponse);
      return conflictResponse;
    }

    // Create member data
    const memberData: Partial<PoolMember> = {
      id: `member_${uuidv4()}`,
      poolId,
      address: address as EthereumAddress,
      username,
      joinedAt: new Date(),
      status: 'active',
      statistics: {
        hashrate: 0,
        shares: 0,
        validShares: 0,
        invalidShares: 0,
        blocksFound: 0,
        totalEarnings: 0 as PositiveNumber,
        lastActivity: new Date(),
      },
      settings: {
        difficulty: pool.configuration.difficultyTarget,
        autoPayoutEnabled: true,
      },
    };

    let member: PoolMember;
    if (req.storage) {
      member = await req.storage.addMember(memberData);

      // Update pool member count
      await req.storage.updatePool(poolId, {
        statistics: {
          ...pool.statistics,
          memberCount: pool.statistics.memberCount + 1,
        },
        updatedAt: new Date(),
      });
    } else {
      member = memberData as PoolMember;
    }

    const response: ControllerResponse<PoolMember> = {
      success: true,
      data: member,
      message: 'Successfully joined mining pool',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in joinPool', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<PoolMember> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to join mining pool',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Submit share to pool
 */
export const submitShare = async (
  req: MiningPoolRequest,
  res: Response
): Promise<ControllerResponse<ShareSubmission>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate share submission using Zod schema
    const validationResult = submitShareSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<ShareSubmission> = {
        success: false,
        error: validationResult.error.issues[0]?.message || 'Invalid input',
        message: 'Share submission validation failed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { poolId, member, nonce, difficulty } = validationResult.data;

    // Validate share
    let isValid = true;
    let accepted = true;
    if (req.miningService) {
      isValid = await req.miningService.validateShare({
        poolId,
        member,
        nonce,
        difficulty,
      });
      accepted = isValid;
    } else {
      // Mock validation - 95% acceptance rate
      accepted = Math.random() > 0.05;
      isValid = accepted;
    }

    // Create share submission
    const shareData: Partial<ShareSubmission> = {
      id: `share_${uuidv4()}`,
      poolId,
      member: member as EthereumAddress,
      nonce,
      difficulty,
      isValid,
      timestamp: new Date(),
      accepted,
    };

    let share: ShareSubmission;
    if (req.storage) {
      share = await req.storage.submitShare(shareData);
    } else {
      share = shareData as ShareSubmission;
    }

    const response: ControllerResponse<ShareSubmission> = {
      success: accepted,
      data: share,
      message: accepted ? 'Share accepted' : 'Share rejected',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(accepted ? 200 : 400).json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in submitShare', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<ShareSubmission> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to submit share',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get pool members
 */
export const getPoolMembers = async (
  req: MiningPoolRequest,
  res: Response
): Promise<PaginatedResponse<PoolMember>> => {
  const requestId = uuidv4();

  try {
    const poolId = req.params.poolId;
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    if (!poolId) {
      const errorResponse: PaginatedResponse<PoolMember> = {
        success: false,
        error: 'Pool ID is required',
        message: 'Please provide a valid pool ID',
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

    let members: PoolMember[] = [];
    if (req.storage) {
      members = await req.storage.getPoolMembers(poolId);
    } else {
      // Mock members for development
      members = [
        {
          id: 'member_1',
          poolId,
          address:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          username: 'weather_miner_1',
          joinedAt: new Date('2024-03-01'),
          status: 'active',
          statistics: {
            hashrate: 15000000, // 15 MH/s
            shares: 2450,
            validShares: 2398,
            invalidShares: 52,
            blocksFound: 3,
            totalEarnings: 125.75 as PositiveNumber,
            lastActivity: new Date(),
          },
          settings: {
            difficulty: 1000000,
            autoPayoutEnabled: true,
            payoutAddress:
              '0x1234567890123456789012345678901234567890' as EthereumAddress,
          },
        },
      ];
    }

    // Sort by hashrate (highest first)
    members.sort((a, b) => b.statistics.hashrate - a.statistics.hashrate);

    const startIndex = (page - 1) * limit;
    const endIndex = page * limit;
    const paginatedMembers = members.slice(startIndex, endIndex);
    const totalPages = Math.ceil(members.length / limit);

    const response: PaginatedResponse<PoolMember> = {
      success: true,
      data: paginatedMembers,
      message: `Retrieved ${paginatedMembers.length} pool members`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: members.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    miningLogger.error('Error in getPoolMembers', { error: (error as Error).message, requestId });
    const errorResponse: PaginatedResponse<PoolMember> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve pool members',
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
  getAllPools,
  createPool,
  joinPool,
  submitShare,
  getPoolMembers,
};
