/**
 * Consensus Controller - TypeScript Implementation
 * Handles consensus mechanism operations, validator management, and network coordination
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { blockchainLogger } from '../utils/logger.js';
import {
  ControllerResponse,
  PaginatedResponse,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

// Consensus interfaces
interface Validator {
  id: string;
  address: EthereumAddress;
  publicKey: string;
  stake: PositiveNumber;
  status: 'active' | 'inactive' | 'jailed' | 'unbonding';
  reputation: number;
  missedBlocks: number;
  producedBlocks: number;
  joinedAt: Date;
  lastActiveAt: Date;
  commission: number; // Percentage
  delegators: number;
  totalDelegated: PositiveNumber;
  votingPower: number;
}

interface ConsensusRound {
  id: string;
  height: number;
  round: number;
  step: 'propose' | 'prevote' | 'precommit' | 'commit';
  proposer: EthereumAddress;
  startTime: Date;
  endTime?: Date;
  participants: EthereumAddress[];
  votes: Vote[];
  status: 'in_progress' | 'completed' | 'failed' | 'timeout';
}

interface Vote {
  id: string;
  validator: EthereumAddress;
  height: number;
  round: number;
  type: 'prevote' | 'precommit';
  blockHash?: string;
  signature: string;
  timestamp: Date;
}

interface ConsensusMetrics {
  totalValidators: number;
  activeValidators: number;
  totalStake: PositiveNumber;
  averageBlockTime: number; // seconds
  finalizationTime: number; // seconds
  networkHealth: number; // 0-100 score
  lastBlockHeight: number;
  consensusVersion: string;
  participationRate: number; // percentage
}

interface ValidatorPerformance {
  validator: EthereumAddress;
  uptime: number; // percentage
  blocks_produced: number;
  blocks_missed: number;
  average_response_time: number; // ms
  efficiency_score: number; // 0-100
  rewards_earned: PositiveNumber;
  penalties_applied: number;
  last_activity: Date;
}

// Enhanced request interface
interface ConsensusRequest extends Request {
  storage?: {
    getAllValidators: () => Promise<Validator[]>;
    getValidator: (address: EthereumAddress) => Promise<Validator | null>;
    updateValidator: (
      address: EthereumAddress,
      updates: Partial<Validator>
    ) => Promise<Validator>;
    getCurrentRound: () => Promise<ConsensusRound | null>;
    getConsensusHistory: (limit?: number) => Promise<ConsensusRound[]>;
    getConsensusMetrics: () => Promise<ConsensusMetrics>;
    getValidatorPerformance: (
      address: EthereumAddress
    ) => Promise<ValidatorPerformance | null>;
    recordVote: (vote: Vote) => Promise<void>;
  };
  consensus?: {
    startNewRound: (
      height: number,
      proposer: EthereumAddress
    ) => Promise<ConsensusRound>;
    submitVote: (vote: Partial<Vote>) => Promise<boolean>;
    finalizeBlock: (height: number, blockHash: string) => Promise<boolean>;
    slashValidator: (
      address: EthereumAddress,
      reason: string
    ) => Promise<boolean>;
  };
}

/**
 * Get all validators
 */
export const getAllValidators = async (
  req: ConsensusRequest,
  res: Response
): Promise<ControllerResponse<Validator[]>> => {
  const requestId = uuidv4();

  try {
    const status = req.query.status as string;
    const sortBy = (req.query.sortBy as string) || 'stake';

    let validators: Validator[] = [];
    if (req.storage) {
      validators = await req.storage.getAllValidators();
    } else {
      // Mock validators for development
      validators = [
        {
          id: 'validator_1',
          address:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          publicKey: '0x04abc123...',
          stake: 10000 as PositiveNumber,
          status: 'active',
          reputation: 95,
          missedBlocks: 5,
          producedBlocks: 1250,
          joinedAt: new Date('2024-01-15'),
          lastActiveAt: new Date(),
          commission: 5.0,
          delegators: 150,
          totalDelegated: 50000 as PositiveNumber,
          votingPower: 8.5,
        },
        {
          id: 'validator_2',
          address:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          publicKey: '0x04def456...',
          stake: 8500 as PositiveNumber,
          status: 'active',
          reputation: 88,
          missedBlocks: 12,
          producedBlocks: 980,
          joinedAt: new Date('2024-02-20'),
          lastActiveAt: new Date(),
          commission: 7.5,
          delegators: 89,
          totalDelegated: 32000 as PositiveNumber,
          votingPower: 6.8,
        },
      ];
    }

    // Filter by status
    if (status) {
      validators = validators.filter(validator => validator.status === status);
    }

    // Sort validators
    validators.sort((a, b) => {
      switch (sortBy) {
        case 'stake':
          return b.stake - a.stake;
        case 'reputation':
          return b.reputation - a.reputation;
        case 'votingPower':
          return b.votingPower - a.votingPower;
        default:
          return b.stake - a.stake;
      }
    });

    const response: ControllerResponse<Validator[]> = {
      success: true,
      data: validators,
      message: `Retrieved ${validators.length} validators`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getAllValidators', { module: 'ConsensusController', operation: 'getAllValidators', error: (error as Error).message });
    const errorResponse: ControllerResponse<Validator[]> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve validators',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get validator details
 */
export const getValidator = async (
  req: ConsensusRequest,
  res: Response
): Promise<ControllerResponse<Validator>> => {
  const requestId = uuidv4();

  try {
    const address = req.params.address as EthereumAddress;

    if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<Validator> = {
        success: false,
        error: 'Invalid address format',
        message: 'Address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let validator: Validator | null = null;
    if (req.storage) {
      validator = await req.storage.getValidator(address);
    }

    if (!validator) {
      const notFoundResponse: ControllerResponse<Validator> = {
        success: false,
        error: 'Validator not found',
        message: `No validator found with address ${address}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    const response: ControllerResponse<Validator> = {
      success: true,
      data: validator,
      message: 'Validator retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getValidator', { module: 'ConsensusController', operation: 'getValidator', error: (error as Error).message });
    const errorResponse: ControllerResponse<Validator> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve validator',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get current consensus round
 */
export const getCurrentRound = async (
  req: ConsensusRequest,
  res: Response
): Promise<ControllerResponse<ConsensusRound>> => {
  const requestId = uuidv4();

  try {
    let currentRound: ConsensusRound | null = null;
    if (req.storage) {
      currentRound = await req.storage.getCurrentRound();
    }

    if (!currentRound) {
      // Mock current round for development
      currentRound = {
        id: `round_${uuidv4()}`,
        height: 12345,
        round: 0,
        step: 'prevote',
        proposer:
          '0x1234567890123456789012345678901234567890' as EthereumAddress,
        startTime: new Date(Date.now() - 5000),
        participants: [
          '0x1234567890123456789012345678901234567890' as EthereumAddress,
          '0x2345678901234567890123456789012345678901' as EthereumAddress,
        ],
        votes: [],
        status: 'in_progress',
      };
    }

    const response: ControllerResponse<ConsensusRound> = {
      success: true,
      data: currentRound,
      message: 'Current consensus round retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getCurrentRound', { module: 'ConsensusController', operation: 'getCurrentRound', error: (error as Error).message });
    const errorResponse: ControllerResponse<ConsensusRound> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve current consensus round',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Submit vote to consensus
 */
export const submitVote = async (
  req: ConsensusRequest,
  res: Response
): Promise<ControllerResponse<{ accepted: boolean }>> => {
  const requestId = uuidv4();

  try {
    const { validator, height, round, type, blockHash, signature } = req.body;

    // Validate required fields
    if (!validator || !height || round === undefined || !type || !signature) {
      const errorResponse: ControllerResponse<{ accepted: boolean }> = {
        success: false,
        error: 'Missing required fields',
        message: 'Validator, height, round, type, and signature are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate validator address
    if (!validator.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<{ accepted: boolean }> = {
        success: false,
        error: 'Invalid validator address format',
        message: 'Validator address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Validate vote type
    if (!['prevote', 'precommit'].includes(type)) {
      const errorResponse: ControllerResponse<{ accepted: boolean }> = {
        success: false,
        error: 'Invalid vote type',
        message: 'Vote type must be either "prevote" or "precommit"',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    // Create vote
    const vote: Vote = {
      id: `vote_${uuidv4()}`,
      validator: validator as EthereumAddress,
      height,
      round,
      type,
      blockHash,
      signature,
      timestamp: new Date(),
    };

    // Submit vote
    let accepted = false;
    if (req.consensus) {
      accepted = await req.consensus.submitVote(vote);
    } else {
      accepted = true; // Mock acceptance
    }

    // Record vote if accepted
    if (accepted && req.storage) {
      await req.storage.recordVote(vote);
    }

    const response: ControllerResponse<{ accepted: boolean }> = {
      success: true,
      data: { accepted },
      message: accepted ? 'Vote submitted successfully' : 'Vote rejected',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in submitVote', { module: 'ConsensusController', operation: 'submitVote', error: (error as Error).message });
    const errorResponse: ControllerResponse<{ accepted: boolean }> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to submit vote',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get consensus metrics
 */
export const getConsensusMetrics = async (
  req: ConsensusRequest,
  res: Response
): Promise<ControllerResponse<ConsensusMetrics>> => {
  const requestId = uuidv4();

  try {
    let metrics: ConsensusMetrics;
    if (req.storage) {
      metrics = await req.storage.getConsensusMetrics();
    } else {
      // Mock metrics for development
      metrics = {
        totalValidators: 150,
        activeValidators: 142,
        totalStake: 2500000 as PositiveNumber,
        averageBlockTime: 6.2,
        finalizationTime: 12.8,
        networkHealth: 94,
        lastBlockHeight: 12345,
        consensusVersion: '1.0.0',
        participationRate: 94.7,
      };
    }

    const response: ControllerResponse<ConsensusMetrics> = {
      success: true,
      data: metrics,
      message: 'Consensus metrics retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getConsensusMetrics', { module: 'ConsensusController', operation: 'getConsensusMetrics', error: (error as Error).message });
    const errorResponse: ControllerResponse<ConsensusMetrics> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve consensus metrics',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get validator performance
 */
export const getValidatorPerformance = async (
  req: ConsensusRequest,
  res: Response
): Promise<ControllerResponse<ValidatorPerformance>> => {
  const requestId = uuidv4();

  try {
    const address = req.params.address as EthereumAddress;

    if (!address || !address.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<ValidatorPerformance> = {
        success: false,
        error: 'Invalid address format',
        message: 'Address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    let performance: ValidatorPerformance | null = null;
    if (req.storage) {
      performance = await req.storage.getValidatorPerformance(address);
    } else {
      // Mock performance data
      performance = {
        validator: address,
        uptime: 98.5,
        blocks_produced: 1250,
        blocks_missed: 15,
        average_response_time: 120,
        efficiency_score: 94,
        rewards_earned: 2450.75 as PositiveNumber,
        penalties_applied: 2,
        last_activity: new Date(),
      };
    }

    if (!performance) {
      const notFoundResponse: ControllerResponse<ValidatorPerformance> = {
        success: false,
        error: 'Performance data not found',
        message: `No performance data found for validator ${address}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    const response: ControllerResponse<ValidatorPerformance> = {
      success: true,
      data: performance,
      message: 'Validator performance retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getValidatorPerformance', { module: 'ConsensusController', operation: 'getValidatorPerformance', error: (error as Error).message });
    const errorResponse: ControllerResponse<ValidatorPerformance> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve validator performance',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get consensus history
 */
export const getConsensusHistory = async (
  req: ConsensusRequest,
  res: Response
): Promise<PaginatedResponse<ConsensusRound>> => {
  const requestId = uuidv4();

  try {
    const page = Math.max(parseInt(req.query.page as string, 10) || 1, 1);
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 20, 100);

    let history: ConsensusRound[] = [];
    if (req.storage) {
      history = await req.storage.getConsensusHistory(limit);
    } else {
      // Mock history for development
      history = [
        {
          id: 'round_12344',
          height: 12344,
          round: 0,
          step: 'commit',
          proposer:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          startTime: new Date(Date.now() - 30000),
          endTime: new Date(Date.now() - 24000),
          participants: [
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          ],
          votes: [],
          status: 'completed',
        },
      ];
    }

    const totalPages = Math.ceil(history.length / limit);

    const response: PaginatedResponse<ConsensusRound> = {
      success: true,
      data: history,
      message: `Retrieved ${history.length} consensus rounds`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: history.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    blockchainLogger.error('Error in getConsensusHistory', { module: 'ConsensusController', operation: 'getConsensusHistory', error: (error as Error).message });
    const errorResponse: PaginatedResponse<ConsensusRound> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve consensus history',
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
  getAllValidators,
  getValidator,
  getCurrentRound,
  submitVote,
  getConsensusMetrics,
  getValidatorPerformance,
  getConsensusHistory,
};
