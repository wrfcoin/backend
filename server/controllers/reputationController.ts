/**
 * Reputation Controller - TypeScript Implementation
 * Handles user reputation scoring, reputation-based rewards, and trust metrics
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { governanceLogger } from '../utils/logger.js';

// ============ ZOD VALIDATION SCHEMAS ============

// Common validation schemas
const ethereumAddressSchema = z
  .string()
  .min(10, 'Address is required')
  .max(128, 'Address too long')
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// Schema for reputation update request
const reputationUpdateSchema = z.object({
  address: ethereumAddressSchema,
  eventType: z
    .string()
    .min(1, 'Event type is required')
    .max(100, 'Event type too long'),
  impact: z.number().min(-100, 'Impact must be at least -100').max(100, 'Impact must be at most 100'),
  description: z
    .string()
    .min(1, 'Description is required')
    .max(1000, 'Description too long'),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// Schema for badge award
const awardBadgeSchema = z.object({
  name: z.string().min(1, 'Badge name is required').max(100, 'Badge name too long'),
  description: z.string().min(1, 'Description is required').max(500, 'Description too long'),
  category: z.string().min(1, 'Category is required').max(50, 'Category too long'),
  level: z.enum(['bronze', 'silver', 'gold', 'platinum', 'legendary']),
  requirements: z.string().max(500).optional(),
});

// Schema for leaderboard query
const leaderboardQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  category: z.string().max(50).optional(),
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

// Reputation interfaces
interface ReputationScore {
  id: string;
  address: EthereumAddress;
  overallScore: number; // 0-1000 scale
  categories: {
    weatherData: number;
    mining: number;
    governance: number;
    community: number;
    reliability: number;
  };
  badges: ReputationBadge[];
  level: ReputationLevel;
  multiplier: number; // Reward multiplier based on reputation
  lastUpdated: Date;
  history: ReputationEvent[];
}

interface ReputationBadge {
  id: string;
  name: string;
  description: string;
  category: string;
  level: 'bronze' | 'silver' | 'gold' | 'platinum' | 'legendary';
  earnedAt: Date;
  requirements: string;
}

interface ReputationLevel {
  name: string;
  minScore: number;
  maxScore: number;
  benefits: string[];
  color: string;
}

interface ReputationEvent {
  id: string;
  type:
    | 'weather_submission'
    | 'mining_contribution'
    | 'governance_vote'
    | 'community_help'
    | 'penalty';
  impact: number; // Positive or negative impact on reputation
  description: string;
  timestamp: Date;
  relatedData?: Record<string, any>;
}

interface ReputationUpdateRequest {
  address: EthereumAddress;
  eventType: string;
  impact: number;
  description: string;
  metadata?: Record<string, any>;
}

// Enhanced request interface
interface ReputationRequest extends Request {
  storage?: {
    getReputationScore: (
      address: EthereumAddress
    ) => Promise<ReputationScore | null>;
    updateReputationScore: (
      address: EthereumAddress,
      event: ReputationEvent
    ) => Promise<ReputationScore>;
    getReputationLeaderboard: (
      category?: string,
      limit?: number
    ) => Promise<ReputationScore[]>;
    getReputationHistory: (
      address: EthereumAddress,
      limit?: number
    ) => Promise<ReputationEvent[]>;
    createReputationScore: (
      score: Partial<ReputationScore>
    ) => Promise<ReputationScore>;
    awardBadge: (
      address: EthereumAddress,
      badge: ReputationBadge
    ) => Promise<ReputationScore>;
  };
}

// Reputation levels configuration
const REPUTATION_LEVELS: ReputationLevel[] = [
  {
    name: 'Newcomer',
    minScore: 0,
    maxScore: 99,
    benefits: ['Basic platform access'],
    color: '#808080',
  },
  {
    name: 'Contributor',
    minScore: 100,
    maxScore: 249,
    benefits: ['Basic platform access', '5% reward bonus'],
    color: '#CD7F32',
  },
  {
    name: 'Reliable',
    minScore: 250,
    maxScore: 499,
    benefits: ['Basic platform access', '10% reward bonus', 'Priority support'],
    color: '#C0C0C0',
  },
  {
    name: 'Trusted',
    minScore: 500,
    maxScore: 749,
    benefits: [
      'Basic platform access',
      '15% reward bonus',
      'Priority support',
      'Governance voting weight +1',
    ],
    color: '#FFD700',
  },
  {
    name: 'Expert',
    minScore: 750,
    maxScore: 899,
    benefits: [
      'Basic platform access',
      '20% reward bonus',
      'Priority support',
      'Governance voting weight +2',
      'Beta access',
    ],
    color: '#E5E4E2',
  },
  {
    name: 'Legend',
    minScore: 900,
    maxScore: 1000,
    benefits: [
      'All benefits',
      '25% reward bonus',
      'VIP support',
      'Governance voting weight +3',
      'Special recognition',
    ],
    color: '#FF6B35',
  },
];

/**
 * Get reputation score for address
 */
export const getReputationScore = async (
  req: ReputationRequest,
  res: Response
): Promise<ControllerResponse<ReputationScore>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for address parameter
    const addressResult = ethereumAddressSchema.safeParse(req.params.address);
    if (!addressResult.success) {
      const errorResponse: ControllerResponse<ReputationScore> = {
        success: false,
        error: addressResult.error.issues[0].message,
        message: 'Address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const address = addressResult.data as EthereumAddress;

    let reputationScore: ReputationScore | null = null;
    if (req.storage) {
      reputationScore = await req.storage.getReputationScore(address);
    }

    // Create default reputation score if none exists
    if (!reputationScore) {
      const defaultScore: ReputationScore = {
        id: `reputation_${uuidv4()}`,
        address,
        overallScore: 0,
        categories: {
          weatherData: 0,
          mining: 0,
          governance: 0,
          community: 0,
          reliability: 0,
        },
        badges: [],
        level: REPUTATION_LEVELS[0],
        multiplier: 1.0,
        lastUpdated: new Date(),
        history: [],
      };

      if (req.storage) {
        reputationScore = await req.storage.createReputationScore(defaultScore);
      } else {
        reputationScore = defaultScore;
      }
    }

    const response: ControllerResponse<ReputationScore> = {
      success: true,
      data: reputationScore,
      message: 'Reputation score retrieved successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Failed to retrieve reputation score', { module: 'ReputationController', operation: 'getReputationScore', error: (error as Error).message });
    const errorResponse: ControllerResponse<ReputationScore> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve reputation score',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Update reputation score
 */
export const updateReputationScore = async (
  req: ReputationRequest,
  res: Response
): Promise<ControllerResponse<ReputationScore>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for reputation update request
    const validationResult = reputationUpdateSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<ReputationScore> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid reputation update data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const { address: validatedAddress, eventType, impact, description, metadata } =
      validationResult.data;
    const address = validatedAddress as EthereumAddress;

    // Create reputation event
    const reputationEvent: ReputationEvent = {
      id: `event_${uuidv4()}`,
      type: eventType as any,
      impact,
      description,
      timestamp: new Date(),
      relatedData: metadata,
    };

    let updatedScore: ReputationScore;
    if (req.storage) {
      updatedScore = await req.storage.updateReputationScore(
        address,
        reputationEvent
      );
    } else {
      // Mock calculation for development
      const newOverallScore = Math.max(0, Math.min(1000, 500 + impact));
      const newLevel =
        REPUTATION_LEVELS.find(
          level =>
            newOverallScore >= level.minScore &&
            newOverallScore <= level.maxScore
        ) || REPUTATION_LEVELS[0];

      updatedScore = {
        id: `reputation_${address}`,
        address,
        overallScore: newOverallScore,
        categories: {
          weatherData:
            eventType === 'weather_submission'
              ? Math.max(0, 100 + impact)
              : 100,
          mining:
            eventType === 'mining_contribution'
              ? Math.max(0, 100 + impact)
              : 100,
          governance:
            eventType === 'governance_vote' ? Math.max(0, 100 + impact) : 100,
          community:
            eventType === 'community_help' ? Math.max(0, 100 + impact) : 100,
          reliability: Math.max(0, 100 + (impact > 0 ? impact / 2 : impact)),
        },
        badges: [],
        level: newLevel,
        multiplier: 1.0 + (newOverallScore / 1000) * 0.25, // Up to 25% bonus
        lastUpdated: new Date(),
        history: [reputationEvent],
      };
    }

    const response: ControllerResponse<ReputationScore> = {
      success: true,
      data: updatedScore,
      message: `Reputation updated: ${impact > 0 ? '+' : ''}${impact} points`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Failed to update reputation score', { module: 'ReputationController', operation: 'updateReputationScore', error: (error as Error).message });
    const errorResponse: ControllerResponse<ReputationScore> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to update reputation score',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

/**
 * Get reputation leaderboard
 */
export const getReputationLeaderboard = async (
  req: ReputationRequest,
  res: Response
): Promise<PaginatedResponse<ReputationScore>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for leaderboard query parameters
    const validationResult = leaderboardQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      const errorResponse: PaginatedResponse<ReputationScore> = {
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
    const { page, limit, category } = validationResult.data;

    let leaderboard: ReputationScore[] = [];
    if (req.storage) {
      leaderboard = await req.storage.getReputationLeaderboard(category, limit);
    } else {
      // Mock leaderboard for development
      leaderboard = [
        {
          id: 'rep_1',
          address:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          overallScore: 890,
          categories: {
            weatherData: 200,
            mining: 180,
            governance: 150,
            community: 200,
            reliability: 160,
          },
          badges: [
            {
              id: 'badge_1',
              name: 'Weather Expert',
              description: 'Submitted 1000+ accurate weather readings',
              category: 'weather',
              level: 'gold',
              earnedAt: new Date(),
              requirements: '1000 weather submissions',
            },
          ],
          level: REPUTATION_LEVELS[4],
          multiplier: 1.22,
          lastUpdated: new Date(),
          history: [],
        },
        {
          id: 'rep_2',
          address:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          overallScore: 756,
          categories: {
            weatherData: 150,
            mining: 200,
            governance: 180,
            community: 120,
            reliability: 106,
          },
          badges: [
            {
              id: 'badge_2',
              name: 'Mining Master',
              description: 'Contributed significant mining power',
              category: 'mining',
              level: 'platinum',
              earnedAt: new Date(),
              requirements: '10000 WRF mined',
            },
          ],
          level: REPUTATION_LEVELS[3],
          multiplier: 1.19,
          lastUpdated: new Date(),
          history: [],
        },
      ];
    }

    const totalPages = Math.ceil(leaderboard.length / limit);

    const response: PaginatedResponse<ReputationScore> = {
      success: true,
      data: leaderboard,
      message: `Retrieved ${leaderboard.length} reputation scores from leaderboard`,
      timestamp: new Date().toISOString(),
      requestId,
      pagination: {
        page,
        limit,
        total: leaderboard.length,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Failed to retrieve reputation leaderboard', { module: 'ReputationController', operation: 'getReputationLeaderboard', error: (error as Error).message });
    const errorResponse: PaginatedResponse<ReputationScore> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve reputation leaderboard',
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
 * Get reputation history for address
 */
export const getReputationHistory = async (
  req: ReputationRequest,
  res: Response
): Promise<PaginatedResponse<ReputationEvent>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for address parameter
    const addressResult = ethereumAddressSchema.safeParse(req.params.address);
    if (!addressResult.success) {
      const errorResponse: PaginatedResponse<ReputationEvent> = {
        success: false,
        error: addressResult.error.issues[0].message,
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
    const address = addressResult.data as EthereumAddress;

    // Zod validation for pagination
    const paginationResult = paginationSchema.safeParse(req.query);
    const { page, limit } = paginationResult.success
      ? paginationResult.data
      : { page: 1, limit: 20 };

    let history: ReputationEvent[] = [];
    if (req.storage) {
      history = await req.storage.getReputationHistory(address, limit);
    } else {
      // Mock history for development
      history = [
        {
          id: 'event_1',
          type: 'weather_submission',
          impact: 5,
          description: 'Submitted accurate weather data',
          timestamp: new Date(Date.now() - 86400000),
          relatedData: { stationId: 'station_123', accuracy: 0.98 },
        },
        {
          id: 'event_2',
          type: 'governance_vote',
          impact: 3,
          description: 'Participated in governance voting',
          timestamp: new Date(Date.now() - 172800000),
          relatedData: { proposalId: 'prop_456' },
        },
      ];
    }

    const totalPages = Math.ceil(history.length / limit);

    const response: PaginatedResponse<ReputationEvent> = {
      success: true,
      data: history,
      message: `Retrieved ${history.length} reputation events for ${address}`,
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
    governanceLogger.error('Failed to retrieve reputation history', { module: 'ReputationController', operation: 'getReputationHistory', error: (error as Error).message });
    const errorResponse: PaginatedResponse<ReputationEvent> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to retrieve reputation history',
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
 * Award reputation badge
 */
export const awardBadge = async (
  req: ReputationRequest,
  res: Response
): Promise<ControllerResponse<ReputationScore>> => {
  const requestId = uuidv4();

  try {
    // Zod validation for address parameter
    const addressResult = ethereumAddressSchema.safeParse(req.params.address);
    if (!addressResult.success) {
      const errorResponse: ControllerResponse<ReputationScore> = {
        success: false,
        error: addressResult.error.issues[0].message,
        message: 'Address must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const address = addressResult.data as EthereumAddress;

    // Zod validation for badge data
    const badgeResult = awardBadgeSchema.safeParse(req.body);
    if (!badgeResult.success) {
      const errorResponse: ControllerResponse<ReputationScore> = {
        success: false,
        error: badgeResult.error.issues[0].message,
        message: 'Invalid badge information',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return errorResponse;
    }
    const { name, description, category, level, requirements } = badgeResult.data;

    const badge: ReputationBadge = {
      id: `badge_${uuidv4()}`,
      name,
      description,
      category,
      level,
      earnedAt: new Date(),
      requirements: requirements || 'Achievement unlocked',
    };

    let updatedScore: ReputationScore;
    if (req.storage) {
      updatedScore = await req.storage.awardBadge(address, badge);
    } else {
      // Mock response for development
      updatedScore = {
        id: `reputation_${address}`,
        address,
        overallScore: 750,
        categories: {
          weatherData: 150,
          mining: 150,
          governance: 150,
          community: 150,
          reliability: 150,
        },
        badges: [badge],
        level: REPUTATION_LEVELS[3],
        multiplier: 1.19,
        lastUpdated: new Date(),
        history: [],
      };
    }

    const response: ControllerResponse<ReputationScore> = {
      success: true,
      data: updatedScore,
      message: `Badge "${name}" awarded successfully`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
    return response;
  } catch (error) {
    governanceLogger.error('Failed to award badge', { module: 'ReputationController', operation: 'awardBadge', error: (error as Error).message });
    const errorResponse: ControllerResponse<ReputationScore> = {
      success: false,
      error: (error as Error).message,
      message: 'Failed to award badge',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
    return errorResponse;
  }
};

// Export all controller methods
/**
 * Record a reputation event
 */
export const recordReputationEvent = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();
  try {
    const { identityDid, eventType, score, details } = req.body;
    res.status(201).json({
      success: true,
      event: {
        id: uuidv4(),
        identityDid,
        eventType,
        score,
        details,
        createdAt: new Date().toISOString(),
      },
      requestId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message, requestId });
  }
};

/**
 * Get reputation events for an identity
 */
export const getReputationEvents = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();
  try {
    const { identityDid } = req.params;
    res.json({
      success: true,
      events: [],
      identityDid,
      requestId,
    });
  } catch (error) {
    res.status(500).json({ success: false, error: (error as Error).message, requestId });
  }
};

/**
 * Get top ranked identities (alias for getReputationLeaderboard)
 */
export const getTopRankedIdentities = getReputationLeaderboard;

export default {
  getReputationScore,
  updateReputationScore,
  getReputationLeaderboard,
  getReputationHistory,
  awardBadge,
  recordReputationEvent,
  getReputationEvents,
  getTopRankedIdentities,
};
