/**
 * Simulation Controller - Transaction Preflight/Simulation
 * Issue #207: Read-only simulation endpoints for previewing transaction outcomes
 *
 * Provides deterministic simulation of governance actions, reward distributions,
 * and cross-chain bridge transfers without mutating state.
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { securityLogger } from '../utils/logger.js';
import { hasAdminRole } from '../utils/admin-role.js';
import {
  ControllerResponse,
} from '../../shared/types/controller-types.js';

// =====================================================
// ZOD VALIDATION SCHEMAS
// =====================================================

const ethereumAddressSchema = z
  .string()
  .min(10, 'Address is required')
  .max(128, 'Address too long')
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address');

const nonceSchema = z.number().int().nonnegative().optional();

// Governance simulation schema
const simulateGovernanceSchema = z.object({
  operation: z.enum(['createProposal', 'vote', 'execute', 'cancel']),
  params: z.object({
    proposalId: z.string().max(128).regex(/^[a-zA-Z0-9_-]*$/).optional(),
    title: z.string().min(1).max(256).optional(),
    description: z.string().min(1).max(10000).optional(),
    proposalType: z.enum([
      'computational_nft',
      'reward_distribution',
      'network_upgrade',
      'parameter_change',
    ]).optional(),
    support: z.boolean().optional(),
    votingPower: z.number().positive().optional(),
    votingPeriod: z.number().int().positive().max(365 * 24 * 60 * 60 * 1000).optional(),
    quorumThreshold: z.number().min(0).max(100).optional(),
  }),
  callerAddress: ethereumAddressSchema,
  nonce: nonceSchema,
});

// Reward simulation schema
const simulateRewardSchema = z.object({
  operation: z.enum(['distribute', 'claim', 'setRate']),
  params: z.object({
    stationId: z.string().min(1).max(128).optional(),
    recipientAddress: ethereumAddressSchema.optional(),
    amount: z.number().positive().optional(),
    rewardType: z.enum(['weather_data', 'validation', 'governance_participation', 'staking']).optional(),
    qualityScore: z.number().min(0).max(100).optional(),
  }),
  callerAddress: ethereumAddressSchema,
  nonce: nonceSchema,
});

// Bridge simulation schema
const simulateBridgeSchema = z.object({
  operation: z.enum(['transfer', 'lock', 'release']),
  params: z.object({
    sourceChain: z.string().min(1).max(64),
    destinationChain: z.string().min(1).max(64),
    amount: z.number().positive(),
    token: z.string().min(1).max(32).default('WRF'),
    recipientAddress: ethereumAddressSchema.optional(),
  }),
  callerAddress: ethereumAddressSchema,
  nonce: nonceSchema,
});

// =====================================================
// SIMULATION RESULT TYPES
// =====================================================

interface StateChange {
  field: string;
  previousValue: unknown;
  newValue: unknown;
}

interface BalanceCheck {
  address: string;
  token: string;
  required: number;
  available: number;
  sufficient: boolean;
}

interface SimulationResult {
  wouldSucceed: boolean;
  stateChanges: StateChange[];
  requiredAuth: string[];
  requiredRoles: string[];
  failureReasons: string[];
  errorCodes: string[];
  nonce: {
    expected: number;
    provided: number | null;
    valid: boolean;
  };
  balanceChecks: BalanceCheck[];
}

// =====================================================
// ERROR CODES
// =====================================================

const SIM_ERROR = {
  INSUFFICIENT_BALANCE: 'SIM_INSUFFICIENT_BALANCE',
  NONCE_ALREADY_USED: 'SIM_NONCE_ALREADY_USED',
  UNAUTHORIZED: 'SIM_UNAUTHORIZED',
  MISSING_ROLE: 'SIM_MISSING_ROLE',
  INVALID_PARAMS: 'SIM_INVALID_PARAMS',
  BRIDGE_LIQUIDITY_LOW: 'SIM_BRIDGE_LIQUIDITY_LOW',
  VOTING_PERIOD_ENDED: 'SIM_VOTING_PERIOD_ENDED',
} as const;

// =====================================================
// MOCK STATE (simulates blockchain state for preflight checks)
// =====================================================

const MOCK_NONCE_REGISTRY = new Map<string, number>();
const DEFAULT_BALANCE = 10000;
const DEFAULT_VOTING_POWER = 1000;
const QUORUM_THRESHOLD = 51;

const SUPPORTED_CHAINS = [
  'ethereum', 'polygon', 'bsc', 'avalanche',
  'arbitrum', 'optimism', 'base', 'cosmos',
  'polkadot', 'solana', 'WRF',
];

const BRIDGE_LIQUIDITY: Record<string, number> = {
  ethereum: 2_450_000,
  polygon: 1_200_000,
  bsc: 890_000,
  avalanche: 500_000,
  arbitrum: 350_000,
  optimism: 300_000,
  base: 200_000,
  cosmos: 150_000,
  polkadot: 100_000,
  solana: 250_000,
};

function getExpectedNonce(address: string): number {
  return MOCK_NONCE_REGISTRY.get(address) || 0;
}

function validateNonce(address: string, provided: number | undefined): { expected: number; provided: number | null; valid: boolean } {
  const expected = getExpectedNonce(address);
  if (provided === undefined || provided === null) {
    return { expected, provided: null, valid: true };
  }
  return { expected, provided, valid: provided === expected };
}

// =====================================================
// SIMULATION HANDLERS
// =====================================================

/**
 * Simulate a governance action (proposal creation, vote, execution, cancellation)
 */
export const simulateGovernanceAction = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const validation = simulateGovernanceSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: { code: SIM_ERROR.INVALID_PARAMS, message: validation.error.issues[0]?.message || 'Invalid parameters' },
        timestamp: new Date().toISOString(),
        requestId,
      });
      return;
    }

    const { operation, params, callerAddress, nonce } = validation.data;

    const stateChanges: StateChange[] = [];
    const requiredAuth: string[] = ['jwt'];
    const requiredRoles: string[] = [];
    const failureReasons: string[] = [];
    const errorCodes: string[] = [];
    const balanceChecks: BalanceCheck[] = [];

    const nonceResult = validateNonce(callerAddress, nonce);
    if (!nonceResult.valid) {
      failureReasons.push(`Nonce mismatch: expected ${nonceResult.expected}, got ${nonceResult.provided}`);
      errorCodes.push(SIM_ERROR.NONCE_ALREADY_USED);
    }

    // Check user roles from auth
    const user = (req as any).user;
    const userRoles: string[] = Array.isArray(user?.roles) ? user.roles : [];

    switch (operation) {
      case 'createProposal': {
        requiredRoles.push('user', 'operator', 'admin');
        if (!params.title || !params.description) {
          failureReasons.push('Proposal requires title and description');
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }

        const hasRole = hasAdminRole(user) || userRoles.some(r => ['user', 'operator'].includes(r));
        if (!hasRole) {
          failureReasons.push('Caller lacks required role for proposal creation');
          errorCodes.push(SIM_ERROR.MISSING_ROLE);
        }

        // Balance check for proposal deposit
        const proposalDeposit = 100;
        balanceChecks.push({
          address: callerAddress,
          token: 'WRF',
          required: proposalDeposit,
          available: DEFAULT_BALANCE,
          sufficient: DEFAULT_BALANCE >= proposalDeposit,
        });

        if (DEFAULT_BALANCE < proposalDeposit) {
          failureReasons.push('Insufficient balance for proposal deposit');
          errorCodes.push(SIM_ERROR.INSUFFICIENT_BALANCE);
        }

        if (failureReasons.length === 0) {
          stateChanges.push(
            { field: 'proposals.count', previousValue: 0, newValue: 1 },
            { field: `proposals.new.status`, previousValue: null, newValue: 'active' },
            { field: `proposals.new.proposer`, previousValue: null, newValue: callerAddress },
            { field: `balances.${callerAddress}.WRF`, previousValue: DEFAULT_BALANCE, newValue: DEFAULT_BALANCE - proposalDeposit },
          );
        }
        break;
      }

      case 'vote': {
        requiredRoles.push('user', 'operator', 'admin');
        if (!params.proposalId) {
          failureReasons.push('Proposal ID is required for voting');
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }
        if (params.support === undefined) {
          failureReasons.push('Vote support (true/false) is required');
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }

        // Simulate voting period check
        const votingPeriodActive = true; // In real impl, check proposal endDate
        if (!votingPeriodActive) {
          failureReasons.push('Voting period has ended for this proposal');
          errorCodes.push(SIM_ERROR.VOTING_PERIOD_ENDED);
        }

        const votingPower = params.votingPower || DEFAULT_VOTING_POWER;
        if (failureReasons.length === 0) {
          stateChanges.push(
            { field: `proposals.${params.proposalId}.totalVotes`, previousValue: 0, newValue: votingPower },
            { field: `proposals.${params.proposalId}.votes.${callerAddress}`, previousValue: null, newValue: params.support },
          );
        }
        break;
      }

      case 'execute': {
        requiredRoles.push('admin');
        if (!params.proposalId) {
          failureReasons.push('Proposal ID is required for execution');
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }

        const isAdmin = hasAdminRole(user);
        if (!isAdmin) {
          failureReasons.push('Only admin can execute proposals');
          errorCodes.push(SIM_ERROR.MISSING_ROLE);
        }

        if (failureReasons.length === 0) {
          stateChanges.push(
            { field: `proposals.${params.proposalId}.status`, previousValue: 'passed', newValue: 'executed' },
          );
        }
        break;
      }

      case 'cancel': {
        requiredRoles.push('admin');
        if (!params.proposalId) {
          failureReasons.push('Proposal ID is required for cancellation');
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }

        const isAdmin = hasAdminRole(user);
        if (!isAdmin) {
          failureReasons.push('Only admin can cancel proposals');
          errorCodes.push(SIM_ERROR.MISSING_ROLE);
        }

        if (failureReasons.length === 0) {
          stateChanges.push(
            { field: `proposals.${params.proposalId}.status`, previousValue: 'active', newValue: 'cancelled' },
          );
        }
        break;
      }
    }

    const wouldSucceed = failureReasons.length === 0;

    const result: SimulationResult = {
      wouldSucceed,
      stateChanges,
      requiredAuth,
      requiredRoles,
      failureReasons,
      errorCodes,
      nonce: nonceResult,
      balanceChecks,
    };

    securityLogger.info('Governance simulation completed', {
      requestId,
      operation,
      callerAddress,
      wouldSucceed,
    });

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    securityLogger.error('Governance simulation error', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'SIMULATION_ERROR', message: 'Internal server error' },
      timestamp: new Date().toISOString(),
      requestId,
    });
  }
};

/**
 * Simulate a reward distribution action
 */
export const simulateRewardDistribution = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const validation = simulateRewardSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: { code: SIM_ERROR.INVALID_PARAMS, message: validation.error.issues[0]?.message || 'Invalid parameters' },
        timestamp: new Date().toISOString(),
        requestId,
      });
      return;
    }

    const { operation, params, callerAddress, nonce } = validation.data;

    const stateChanges: StateChange[] = [];
    const requiredAuth: string[] = ['jwt'];
    const requiredRoles: string[] = [];
    const failureReasons: string[] = [];
    const errorCodes: string[] = [];
    const balanceChecks: BalanceCheck[] = [];

    const nonceResult = validateNonce(callerAddress, nonce);
    if (!nonceResult.valid) {
      failureReasons.push(`Nonce mismatch: expected ${nonceResult.expected}, got ${nonceResult.provided}`);
      errorCodes.push(SIM_ERROR.NONCE_ALREADY_USED);
    }

    const user = (req as any).user;
    const userRoles: string[] = Array.isArray(user?.roles) ? user.roles : [];

    switch (operation) {
      case 'distribute': {
        requiredRoles.push('operator', 'admin');
        const hasRole = hasAdminRole(user) || userRoles.includes('operator');
        if (!hasRole) {
          failureReasons.push('Caller lacks operator or admin role for distribution');
          errorCodes.push(SIM_ERROR.MISSING_ROLE);
        }

        if (!params.recipientAddress) {
          failureReasons.push('Recipient address is required');
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }
        if (!params.amount) {
          failureReasons.push('Distribution amount is required');
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }

        const rewardPoolBalance = 1_000_000;
        const amount = params.amount || 0;
        const maxDistributionCap = 50_000;

        balanceChecks.push({
          address: 'reward_pool',
          token: 'WRF',
          required: amount,
          available: rewardPoolBalance,
          sufficient: rewardPoolBalance >= amount,
        });

        if (amount > rewardPoolBalance) {
          failureReasons.push('Reward pool has insufficient balance');
          errorCodes.push(SIM_ERROR.INSUFFICIENT_BALANCE);
        }
        if (amount > maxDistributionCap) {
          failureReasons.push(`Distribution exceeds per-transaction cap of ${maxDistributionCap} WRF`);
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }

        if (failureReasons.length === 0) {
          stateChanges.push(
            { field: 'reward_pool.balance', previousValue: rewardPoolBalance, newValue: rewardPoolBalance - amount },
            { field: `balances.${params.recipientAddress}.WRF`, previousValue: 0, newValue: amount },
          );
        }
        break;
      }

      case 'claim': {
        requiredRoles.push('user', 'operator', 'admin');
        if (!params.stationId) {
          failureReasons.push('Station ID is required for reward claim');
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }

        // Simulate eligibility check
        const qualityScore = params.qualityScore || 0;
        const minQualityScore = 70;
        const estimatedReward = qualityScore >= minQualityScore ? Math.floor(qualityScore * 0.1 * 100) / 100 : 0;

        if (qualityScore < minQualityScore) {
          failureReasons.push(`Quality score ${qualityScore} is below minimum threshold ${minQualityScore}`);
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }

        if (failureReasons.length === 0) {
          stateChanges.push(
            { field: `rewards.${callerAddress}.claimed`, previousValue: false, newValue: true },
            { field: `balances.${callerAddress}.WRF`, previousValue: DEFAULT_BALANCE, newValue: DEFAULT_BALANCE + estimatedReward },
          );
        }
        break;
      }

      case 'setRate': {
        requiredRoles.push('admin');
        const isAdmin = hasAdminRole(user);
        if (!isAdmin) {
          failureReasons.push('Only admin can modify reward rates');
          errorCodes.push(SIM_ERROR.MISSING_ROLE);
        }

        if (!params.rewardType) {
          failureReasons.push('Reward type is required');
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }
        if (!params.amount) {
          failureReasons.push('New rate amount is required');
          errorCodes.push(SIM_ERROR.INVALID_PARAMS);
        }

        if (failureReasons.length === 0) {
          stateChanges.push(
            { field: `rewardRates.${params.rewardType}`, previousValue: 0.1, newValue: params.amount },
          );
        }
        break;
      }
    }

    const wouldSucceed = failureReasons.length === 0;

    const result: SimulationResult = {
      wouldSucceed,
      stateChanges,
      requiredAuth,
      requiredRoles,
      failureReasons,
      errorCodes,
      nonce: nonceResult,
      balanceChecks,
    };

    securityLogger.info('Reward simulation completed', {
      requestId,
      operation,
      callerAddress,
      wouldSucceed,
    });

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    securityLogger.error('Reward simulation error', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'SIMULATION_ERROR', message: 'Internal server error' },
      timestamp: new Date().toISOString(),
      requestId,
    });
  }
};

/**
 * Simulate a cross-chain bridge transfer
 */
export const simulateBridgeTransfer = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const validation = simulateBridgeSchema.safeParse(req.body);
    if (!validation.success) {
      res.status(400).json({
        success: false,
        error: { code: SIM_ERROR.INVALID_PARAMS, message: validation.error.issues[0]?.message || 'Invalid parameters' },
        timestamp: new Date().toISOString(),
        requestId,
      });
      return;
    }

    const { operation, params, callerAddress, nonce } = validation.data;

    const stateChanges: StateChange[] = [];
    const requiredAuth: string[] = ['jwt'];
    const requiredRoles: string[] = ['user', 'operator', 'admin'];
    const failureReasons: string[] = [];
    const errorCodes: string[] = [];
    const balanceChecks: BalanceCheck[] = [];

    const nonceResult = validateNonce(callerAddress, nonce);
    if (!nonceResult.valid) {
      failureReasons.push(`Nonce mismatch: expected ${nonceResult.expected}, got ${nonceResult.provided}`);
      errorCodes.push(SIM_ERROR.NONCE_ALREADY_USED);
    }

    const { sourceChain, destinationChain, amount, token } = params;

    // Validate chains
    if (!SUPPORTED_CHAINS.includes(sourceChain.toLowerCase())) {
      failureReasons.push(`Unsupported source chain: ${sourceChain}`);
      errorCodes.push(SIM_ERROR.INVALID_PARAMS);
    }
    if (!SUPPORTED_CHAINS.includes(destinationChain.toLowerCase())) {
      failureReasons.push(`Unsupported destination chain: ${destinationChain}`);
      errorCodes.push(SIM_ERROR.INVALID_PARAMS);
    }
    if (sourceChain.toLowerCase() === destinationChain.toLowerCase()) {
      failureReasons.push('Source and destination chains must be different');
      errorCodes.push(SIM_ERROR.INVALID_PARAMS);
    }

    // Balance check
    balanceChecks.push({
      address: callerAddress,
      token,
      required: amount,
      available: DEFAULT_BALANCE,
      sufficient: DEFAULT_BALANCE >= amount,
    });

    if (amount > DEFAULT_BALANCE) {
      failureReasons.push(`Insufficient ${token} balance for bridge transfer`);
      errorCodes.push(SIM_ERROR.INSUFFICIENT_BALANCE);
    }

    // Liquidity check on destination chain
    const destLiquidity = BRIDGE_LIQUIDITY[destinationChain.toLowerCase()] || 0;
    if (amount > destLiquidity) {
      failureReasons.push(`Destination chain ${destinationChain} has insufficient bridge liquidity (${destLiquidity} available, ${amount} required)`);
      errorCodes.push(SIM_ERROR.BRIDGE_LIQUIDITY_LOW);
    }

    // Fee estimation
    const bridgeFeePercent = 0.001; // 0.1%
    const bridgeFee = Math.ceil(amount * bridgeFeePercent * 100) / 100;
    const totalRequired = amount + bridgeFee;

    balanceChecks.push({
      address: callerAddress,
      token,
      required: totalRequired,
      available: DEFAULT_BALANCE,
      sufficient: DEFAULT_BALANCE >= totalRequired,
    });

    if (failureReasons.length === 0) {
      stateChanges.push(
        { field: `balances.${callerAddress}.${token}`, previousValue: DEFAULT_BALANCE, newValue: DEFAULT_BALANCE - totalRequired },
        { field: `bridge.${sourceChain}.locked`, previousValue: 0, newValue: amount },
        { field: `bridge.${destinationChain}.pending`, previousValue: 0, newValue: amount },
        { field: 'bridge.fee.collected', previousValue: 0, newValue: bridgeFee },
      );
    }

    const wouldSucceed = failureReasons.length === 0;

    const result: SimulationResult = {
      wouldSucceed,
      stateChanges,
      requiredAuth,
      requiredRoles,
      failureReasons,
      errorCodes,
      nonce: nonceResult,
      balanceChecks,
    };

    securityLogger.info('Bridge simulation completed', {
      requestId,
      operation,
      sourceChain,
      destinationChain,
      amount,
      callerAddress,
      wouldSucceed,
    });

    res.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
      requestId,
    });
  } catch (error) {
    securityLogger.error('Bridge simulation error', {
      requestId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'SIMULATION_ERROR', message: 'Internal server error' },
      timestamp: new Date().toISOString(),
      requestId,
    });
  }
};

export default {
  simulateGovernanceAction,
  simulateRewardDistribution,
  simulateBridgeTransfer,
};
