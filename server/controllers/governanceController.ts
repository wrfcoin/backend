/**
 * Governance Controller - TypeScript Implementation
 * Handles computational NFT governance and reward distribution with type safety
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { governanceLogger } from '../utils/logger.js';

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

// Proposal type whitelist - CRITICAL: Only allow approved proposal types
const proposalTypeSchema = z.enum([
  'computational_nft',
  'reward_distribution',
  'network_upgrade',
  'parameter_change',
], { message: 'Invalid proposal type' });

// Proposal ID validation
const proposalIdSchema = z
  .string()
  .min(1, 'Proposal ID is required')
  .max(128, 'Proposal ID too long')
  .regex(/^[a-zA-Z0-9_-]+$/, 'Proposal ID contains invalid characters');

// Proposal data schema - title and description are required
const proposalDataSchema = z.object({
  title: z.string()
    .min(1, 'Title is required')
    .max(256, 'Title too long'),
  description: z.string()
    .min(1, 'Description is required')
    .max(10000, 'Description too long'),
  proposalType: proposalTypeSchema.optional(),
  executionData: z.any().optional(),
  votingPeriod: z.number().int().positive().max(365 * 24 * 60 * 60 * 1000).optional(), // Max 1 year
  quorumThreshold: z.number().min(0).max(100).optional(),
});

// Infer type for type safety
type ValidatedProposalData = z.infer<typeof proposalDataSchema>;

// Submit proposal request schema
const submitProposalSchema = z.object({
  proposalData: proposalDataSchema,
  submitterAddress: ethereumAddressSchema.optional(),
});

// Vote data schema
const voteSchema = z.object({
  proposalId: proposalIdSchema,
  support: z.boolean(),
  reason: z.string().max(2000, 'Reason too long').optional(),
  votingPower: z.number().positive().optional(),
  voterAddress: ethereumAddressSchema.optional(),
});

// Slashing event validation schema (backend#196)
const slashingEventSchema = z.object({
  oracle_address: ethereumAddressSchema,
  reason: z.enum([
    'invalid_block',
    'downtime',
    'malicious_behavior',
    'incorrect_data',
    'failed_verification',
    'duplicate_submission',
    'spam',
    'late_submission',
    'storage_unavailable',
    'consensus_violation',
  ], { message: 'Invalid slashing reason' }),
  evidence: z.string().max(5000, 'Evidence too long').optional(),
  block_height: z.number().int().nonnegative().optional(),
});

import {
  ControllerResponse,
  GovernanceProposal,
  GovernanceVote,
  AsyncControllerMethod,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

// Enhanced interfaces for governance operations
interface ProposalData {
  title: string;
  description: string;
  proposalType:
    | 'computational_nft'
    | 'reward_distribution'
    | 'network_upgrade'
    | 'parameter_change';
  executionData?: any;
  votingPeriod?: number; // in blocks
  quorumThreshold?: number; // percentage
}

interface VoteData {
  proposalId: string;
  support: boolean;
  votingPower?: PositiveNumber;
  reason?: string;
}

interface GovernanceRequest extends Request {
  headers: {
    'x-wallet-address'?: string;
    [key: string]: string | undefined;
  };
}

// Mock governance implementations with proper error handling
class SafeComputationalNFTGovernance {
  private initialized = false;

  async initialize(): Promise<void> {
    try {
      // Initialize governance system
      this.initialized = true;
      governanceLogger.info('Computational NFT Governance initialized');
    } catch (error) {
      governanceLogger.warn('Governance initialization warning', { error: (error as Error).message });
    }
  }

  async submitProposal(
    proposalData: ProposalData,
    submitterAddress: EthereumAddress
  ): Promise<GovernanceProposal> {
    if (!this.initialized) {
      await this.initialize();
    }

    const proposal: GovernanceProposal = {
      id: `prop_${uuidv4()}`,
      title: proposalData.title,
      description: proposalData.description,
      proposer: submitterAddress,
      startTime: new Date(),
      endTime: new Date(
        Date.now() + (proposalData.votingPeriod || 7 * 24 * 60 * 60 * 1000)
      ), // 7 days default
      status: 'active',
      votesFor: 0 as PositiveNumber,
      votesAgainst: 0 as PositiveNumber,
      totalVotes: 0 as PositiveNumber,
      quorumReached: false,
    };

    return proposal;
  }

  async getProposal(proposalId: string): Promise<GovernanceProposal | null> {
    // Mock implementation - in production, this would query the blockchain/database
    return null;
  }

  async vote(
    proposalId: string,
    voteData: VoteData,
    voterAddress: EthereumAddress
  ): Promise<GovernanceVote> {
    const vote: GovernanceVote = {
      proposalId,
      voter: voterAddress,
      support: voteData.support,
      votingPower: voteData.votingPower || (1 as PositiveNumber),
      timestamp: new Date(),
      reason: voteData.reason,
    };

    return vote;
  }
}

class SafeRewardDistributionGovernance {
  private initialized = false;

  async initialize(): Promise<void> {
    try {
      this.initialized = true;
      governanceLogger.info('Reward Distribution Governance initialized');
    } catch (error) {
      governanceLogger.warn('Reward governance initialization warning', { error: (error as Error).message });
    }
  }

  async submitRewardProposal(
    proposalData: ProposalData,
    submitterAddress: EthereumAddress
  ): Promise<GovernanceProposal> {
    if (!this.initialized) {
      await this.initialize();
    }

    const proposal: GovernanceProposal = {
      id: `reward_prop_${uuidv4()}`,
      title: proposalData.title,
      description: proposalData.description,
      proposer: submitterAddress,
      startTime: new Date(),
      endTime: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      status: 'active',
      votesFor: 0 as PositiveNumber,
      votesAgainst: 0 as PositiveNumber,
      totalVotes: 0 as PositiveNumber,
      quorumReached: false,
    };

    return proposal;
  }
}

// Initialize governance systems
const nftGovernance = new SafeComputationalNFTGovernance();
const rewardGovernance = new SafeRewardDistributionGovernance();

// Initialize systems with proper error handling
let governanceInitialized = false;

const initializeGovernance = async (): Promise<void> => {
  try {
    await Promise.all([
      nftGovernance.initialize(),
      rewardGovernance.initialize(),
    ]);
    governanceInitialized = true;
    governanceLogger.info('All governance systems initialized successfully');
  } catch (error) {
    governanceLogger.warn('Governance initialization completed with warnings', { error: (error as Error).message });
    governanceInitialized = true; // Continue with limited functionality
  }
};

// Initialize on startup
initializeGovernance();

/**
 * Submit computational NFT proposal
 */
export const submitComputationalNFTProposal = async (
  req: GovernanceRequest,
  res: Response
): Promise<ControllerResponse<GovernanceProposal>> => {
  const requestId = uuidv4();

  try {
    // Get submitter address from header or body
    const rawSubmitterAddress =
      req.headers['x-wallet-address'] || req.body.submitterAddress;

    // SECURITY: Validate submitter address using Zod
    const addressValidation = ethereumAddressSchema.safeParse(rawSubmitterAddress);
    if (!addressValidation.success) {
      const errorResponse: ControllerResponse<GovernanceProposal> = {
        success: false,
        error: addressValidation.error.issues[0]?.message || 'Invalid submitter address',
        message: 'Please provide a valid wallet address in x-wallet-address header or submitterAddress field',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const submitterAddress = addressValidation.data;

    // SECURITY: Validate proposal data using Zod schema
    const proposalValidation = proposalDataSchema.safeParse(req.body.proposalData);
    if (!proposalValidation.success) {
      const errorResponse: ControllerResponse<GovernanceProposal> = {
        success: false,
        error: proposalValidation.error.issues[0]?.message || 'Invalid proposal data',
        message: 'Proposal validation failed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const proposalData = proposalValidation.data;

    const result = await nftGovernance.submitProposal(
      proposalData as ProposalData,
      submitterAddress as EthereumAddress
    );

    const response: ControllerResponse<GovernanceProposal> = {
      success: true,
      data: result,
      message: 'Computational NFT proposal submitted successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in submitComputationalNFTProposal', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<GovernanceProposal> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to submit computational NFT proposal',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Submit reward distribution proposal
 */
export const submitRewardDistributionProposal = async (
  req: GovernanceRequest,
  res: Response
): Promise<ControllerResponse<GovernanceProposal>> => {
  const requestId = uuidv4();

  try {
    // Get submitter address from header or body
    const rawSubmitterAddress =
      req.headers['x-wallet-address'] || req.body.submitterAddress;

    // SECURITY: Validate submitter address using Zod
    const addressValidation = ethereumAddressSchema.safeParse(rawSubmitterAddress);
    if (!addressValidation.success) {
      const errorResponse: ControllerResponse<GovernanceProposal> = {
        success: false,
        error: addressValidation.error.issues[0]?.message || 'Invalid submitter address',
        message: 'Please provide a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const submitterAddress = addressValidation.data;

    // SECURITY: Validate proposal data using Zod schema
    const proposalValidation = proposalDataSchema.safeParse(req.body.proposalData);
    if (!proposalValidation.success) {
      const errorResponse: ControllerResponse<GovernanceProposal> = {
        success: false,
        error: proposalValidation.error.issues[0]?.message || 'Invalid proposal data',
        message: 'Proposal must include title and description',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const proposalData = proposalValidation.data;

    const result = await rewardGovernance.submitRewardProposal(
      proposalData as ProposalData,
      submitterAddress as EthereumAddress
    );

    const response: ControllerResponse<GovernanceProposal> = {
      success: true,
      data: result,
      message: 'Reward distribution proposal submitted successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in submitRewardDistributionProposal', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<GovernanceProposal> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to submit reward distribution proposal',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Vote on proposal
 */
export const voteOnProposal = async (
  req: GovernanceRequest,
  res: Response
): Promise<ControllerResponse<GovernanceVote>> => {
  const requestId = uuidv4();

  try {
    // Get voter address from header or body
    const rawVoterAddress =
      req.headers['x-wallet-address'] || req.body.voterAddress;

    // Merge voter address into body for validation
    const validationInput = {
      ...req.body,
      voterAddress: rawVoterAddress,
    };

    // SECURITY: Validate vote data using Zod schema
    const validationResult = voteSchema.safeParse(validationInput);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<GovernanceVote> = {
        success: false,
        error: validationResult.error.issues[0]?.message || 'Invalid vote data',
        message: 'Vote validation failed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { proposalId, support, reason, voterAddress } = validationResult.data;

    // Additional validation: voterAddress is required
    if (!voterAddress) {
      const errorResponse: ControllerResponse<GovernanceVote> = {
        success: false,
        error: 'Voter address is required',
        message: 'Please provide a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const voteData: VoteData = {
      proposalId,
      support,
      reason,
    };

    const result = await nftGovernance.vote(
      proposalId,
      voteData,
      voterAddress as EthereumAddress
    );

    const response: ControllerResponse<GovernanceVote> = {
      success: true,
      data: result,
      message: 'Vote recorded successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in voteOnProposal', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<GovernanceVote> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to record vote',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get proposal by ID
 */
export const getProposal = async (
  req: Request,
  res: Response
): Promise<ControllerResponse<GovernanceProposal>> => {
  const requestId = uuidv4();

  try {
    // SECURITY: Validate proposal ID path parameter
    const validationResult = proposalIdSchema.safeParse(req.params.proposalId);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<GovernanceProposal> = {
        success: false,
        error: validationResult.error.issues[0]?.message || 'Invalid proposal ID',
        message: 'Please provide a valid proposal ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const proposalId = validationResult.data;

    const proposal = await nftGovernance.getProposal(proposalId);

    if (!proposal) {
      const notFoundResponse: ControllerResponse<GovernanceProposal> = {
        success: false,
        error: 'Proposal not found',
        message: `No proposal found with ID ${proposalId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(notFoundResponse);
      return notFoundResponse;
    }

    const response: ControllerResponse<GovernanceProposal> = {
      success: true,
      data: proposal,
      message: 'Proposal retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in getProposal', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<GovernanceProposal> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve proposal',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get governance system status
 */
export const getGovernanceStatus = async (
  req: Request,
  res: Response
): Promise<ControllerResponse<any>> => {
  const requestId = uuidv4();

  try {
    const status = {
      initialized: governanceInitialized,
      systems: {
        nftGovernance: 'active',
        rewardGovernance: 'active',
      },
      lastUpdate: new Date().toISOString(),
    };

    const response: ControllerResponse<any> = {
      success: true,
      data: status,
      message: 'Governance status retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in getGovernanceStatus', { error: (error as Error).message, requestId });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve governance status',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Record a slashing event for an oracle (backend#196)
 */
export const recordSlashingEvent = async (
  req: Request,
  res: Response
): Promise<ControllerResponse<any>> => {
  const requestId = uuidv4();

  try {
    const validationResult = slashingEventSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<any> = {
        success: false,
        error: validationResult.error.issues[0]?.message || 'Invalid slashing event data',
        message: 'Slashing event validation failed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }

    const { oracle_address, reason, evidence, block_height } = validationResult.data;

    const event = {
      id: `slash_${uuidv4()}`,
      oracle_address,
      reason,
      evidence: evidence || null,
      block_height: block_height || null,
      recorded_at: new Date().toISOString(),
      status: 'recorded',
    };

    governanceLogger.info('Slashing event recorded', {
      requestId,
      oracle_address,
      reason,
      block_height,
    });

    const response: ControllerResponse<any> = {
      success: true,
      data: event,
      message: 'Slashing event recorded successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Error in recordSlashingEvent', {
      error: (error as Error).message,
      requestId,
    });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to record slashing event',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
export default {
  submitComputationalNFTProposal,
  submitRewardDistributionProposal,
  voteOnProposal,
  getProposal,
  getGovernanceStatus,
  recordSlashingEvent,
};
