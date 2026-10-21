/**
 * Achievement Controller - TypeScript Implementation
 * Handles user achievements, progress tracking, and reward distribution with comprehensive validation
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { appLogger } from '../utils/logger.js';

// ============ ZOD VALIDATION SCHEMAS ============

// Common validation schemas
const ethereumAddressSchema = z
  .string()
  .min(10, 'User ID is required')
  .max(128, 'User ID too long')
  .regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address format');

const paginationSchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
});

// Schema for achievement filtering
const achievementFilterSchema = z.object({
  category: z.enum(['weather', 'mining', 'trading', 'governance', 'environmental', 'special']).optional(),
  difficulty: z.enum(['bronze', 'silver', 'gold', 'platinum', 'legendary']).optional(),
});

// Schema for achievement progress update
const achievementProgressSchema = z.object({
  userId: ethereumAddressSchema,
  achievementId: z.string().min(1, 'Achievement ID is required').max(100, 'Achievement ID too long'),
  progressData: z.record(z.string(), z.number().min(0)),
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
  AsyncControllerMethodWithReturn,
} from '../../shared/types/controller-types.js';
import {
  EthereumAddress,
  PositiveNumber,
} from '../../shared/types/security-types.js';

// Achievement interfaces
interface Achievement {
  id: string;
  name: string;
  description: string;
  category:
    | 'weather'
    | 'mining'
    | 'trading'
    | 'governance'
    | 'environmental'
    | 'special';
  difficulty: 'bronze' | 'silver' | 'gold' | 'platinum' | 'legendary';
  requirements: {
    type: string;
    target: number;
    current?: number;
    description: string;
  }[];
  rewards: {
    tokens: PositiveNumber;
    badge?: string;
    title?: string;
    perks?: string[];
  };
  isActive: boolean;
  createdAt: Date;
  completedBy?: number; // Number of users who completed this achievement
}

interface UserAchievement {
  id: string;
  userId: EthereumAddress;
  achievementId: string;
  progress: number; // 0-100 percentage
  completed: boolean;
  completedAt?: Date;
  claimedReward: boolean;
  claimedAt?: Date;
  metadata?: Record<string, any>;
}

interface AchievementProgress {
  userId: EthereumAddress;
  achievementId: string;
  progressData: Record<string, number>;
}

// Enhanced request interface with storage
interface AchievementRequest extends Request {
  storage?: {
    getAllAchievements: () => Promise<Achievement[]>;
    getUserAchievements: (
      userId: EthereumAddress
    ) => Promise<UserAchievement[]>;
    getUserAchievement: (
      userId: EthereumAddress,
      achievementId: string
    ) => Promise<UserAchievement | null>;
    updateAchievementProgress: (
      userId: EthereumAddress,
      achievementId: string,
      progress: number
    ) => Promise<UserAchievement>;
    completeAchievement: (
      userId: EthereumAddress,
      achievementId: string
    ) => Promise<UserAchievement>;
    claimReward: (
      userId: EthereumAddress,
      achievementId: string
    ) => Promise<UserAchievement>;
    getLeaderboard: (category?: string, limit?: number) => Promise<any[]>;
  };
}

// Mock achievements data
const MOCK_ACHIEVEMENTS: Achievement[] = [
  {
    id: 'weather_collector',
    name: 'Weather Data Collector',
    description: 'Submit 100 valid weather readings',
    category: 'weather',
    difficulty: 'bronze',
    requirements: [
      {
        type: 'weather_submissions',
        target: 100,
        description: 'Submit 100 valid weather readings',
      },
    ],
    rewards: {
      tokens: 10 as PositiveNumber,
      badge: 'weather_bronze',
      title: 'Weather Observer',
    },
    isActive: true,
    createdAt: new Date(),
    completedBy: 156,
  },
  {
    id: 'mining_expert',
    name: 'Mining Expert',
    description: 'Mine 1000 WRF tokens',
    category: 'mining',
    difficulty: 'silver',
    requirements: [
      {
        type: 'tokens_mined',
        target: 1000,
        description: 'Mine 1000 WRF tokens',
      },
    ],
    rewards: {
      tokens: 50 as PositiveNumber,
      badge: 'mining_silver',
      title: 'Mining Professional',
      perks: ['Reduced mining fees'],
    },
    isActive: true,
    createdAt: new Date(),
    completedBy: 89,
  },
  {
    id: 'environmental_champion',
    name: 'Environmental Champion',
    description: 'Contribute to environmental monitoring for 30 days',
    category: 'environmental',
    difficulty: 'gold',
    requirements: [
      {
        type: 'daily_contributions',
        target: 30,
        description: 'Contribute environmental data for 30 consecutive days',
      },
    ],
    rewards: {
      tokens: 200 as PositiveNumber,
      badge: 'environmental_gold',
      title: 'Climate Guardian',
      perks: ['Priority data verification', 'Bonus weather rewards'],
    },
    isActive: true,
    createdAt: new Date(),
    completedBy: 34,
  },
  {
    id: 'governance_participant',
    name: 'Governance Participant',
    description: 'Vote on 10 governance proposals',
    category: 'governance',
    difficulty: 'bronze',
    requirements: [
      {
        type: 'votes_cast',
        target: 10,
        description: 'Vote on 10 governance proposals',
      },
    ],
    rewards: {
      tokens: 25 as PositiveNumber,
      badge: 'governance_bronze',
      title: 'Community Voice',
    },
    isActive: true,
    createdAt: new Date(),
    completedBy: 67,
  },
  {
    id: 'cross_chain_master',
    name: 'Cross-Chain Master',
    description: 'Complete 50 cross-chain transactions',
    category: 'trading',
    difficulty: 'platinum',
    requirements: [
      {
        type: 'cross_chain_transactions',
        target: 50,
        description: 'Complete 50 cross-chain transactions',
      },
    ],
    rewards: {
      tokens: 500 as PositiveNumber,
      badge: 'crosschain_platinum',
      title: 'Bridge Master',
      perks: ['Reduced bridge fees', 'Priority support'],
    },
    isActive: true,
    createdAt: new Date(),
    completedBy: 12,
  },
];

/**
 * Get all available achievements
 */
export const getAllAchievements = async (
  req: AchievementRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // Zod validation for filter parameters
    const filterResult = achievementFilterSchema.safeParse(req.query);
    const { category, difficulty } = filterResult.success
      ? filterResult.data
      : { category: undefined, difficulty: undefined };

    let achievements: Achievement[] = [];
    if (req.storage) {
      achievements = await req.storage.getAllAchievements();
    } else {
      achievements = MOCK_ACHIEVEMENTS;
    }

    // Filter by category if provided
    if (category) {
      achievements = achievements.filter(
        achievement => achievement.category === category
      );
    }

    // Filter by difficulty if provided
    if (difficulty) {
      achievements = achievements.filter(
        achievement => achievement.difficulty === difficulty
      );
    }

    // Only return active achievements
    achievements = achievements.filter(achievement => achievement.isActive);

    const response: ControllerResponse<Achievement[]> = {
      success: true,
      data: achievements,
      message: `Retrieved ${achievements.length} achievements`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error: unknown) {
    appLogger.error('Error in getAllAchievements', { error: error instanceof Error ? error.message : 'Unknown error' });
    const errorResponse: ControllerResponse<Achievement[]> = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to retrieve achievements',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Get user achievements with progress (for routes that need userId as number)
 */
export const getUserAchievements = async (userId: number): Promise<any> => {
  try {
    // Mock achievements for number-based userId
    const userAchievements = [
      {
        id: 'user_achieve_1',
        userId: userId.toString(),
        achievementId: 'weather_collector',
        progress: 75,
        completed: false,
        claimedReward: false,
        metadata: { submissions: 75 },
      },
      {
        id: 'user_achieve_2',
        userId: userId.toString(),
        achievementId: 'governance_participant',
        progress: 100,
        completed: true,
        completedAt: new Date(Date.now() - 86400000),
        claimedReward: true,
        claimedAt: new Date(Date.now() - 82800000),
        metadata: { votes: 10 },
      },
    ];

    return {
      success: true,
      data: userAchievements,
      message: `Retrieved ${userAchievements.length} user achievements`,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to retrieve user achievements',
    };
  }
};

/**
 * Get user achievements with progress (Express handler)
 */
export const getUserAchievementsHandler = async (
  req: AchievementRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // Zod validation for userId parameter
    const userIdResult = ethereumAddressSchema.safeParse(req.params.userId);
    if (!userIdResult.success) {
      const errorResponse: ControllerResponse<UserAchievement[]> = {
        success: false,
        error: userIdResult.error.issues[0].message,
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }
    const userId = userIdResult.data as EthereumAddress;

    let userAchievements: UserAchievement[] = [];
    if (req.storage) {
      userAchievements = await req.storage.getUserAchievements(userId);
    } else {
      // Mock user achievements for development
      userAchievements = [
        {
          id: 'user_achieve_1',
          userId,
          achievementId: 'weather_collector',
          progress: 75,
          completed: false,
          claimedReward: false,
          metadata: { submissions: 75 },
        },
        {
          id: 'user_achieve_2',
          userId,
          achievementId: 'governance_participant',
          progress: 100,
          completed: true,
          completedAt: new Date(Date.now() - 86400000), // 1 day ago
          claimedReward: true,
          claimedAt: new Date(Date.now() - 82800000), // 1 hour after completion
          metadata: { votes: 10 },
        },
      ];
    }

    const response: ControllerResponse<UserAchievement[]> = {
      success: true,
      data: userAchievements,
      message: `Retrieved ${userAchievements.length} user achievements`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error: unknown) {
    appLogger.error('Error in getUserAchievements', { error: error instanceof Error ? error.message : 'Unknown error' });
    const errorResponse: ControllerResponse<UserAchievement[]> = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to retrieve user achievements',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Calculate governance weight for a user
 */
export const calculateGovernanceWeight = async (
  userId: number
): Promise<number> => {
  try {
    // Mock implementation - in real app this would calculate based on achievements, tokens, etc.
    const baseWeight = 1;
    const achievementMultiplier = Math.floor(userId / 10) + 1; // Mock calculation
    return baseWeight * achievementMultiplier;
  } catch (error) {
    appLogger.error('Error calculating governance weight', { error: error instanceof Error ? error.message : 'Unknown error' });
    throw error;
  }
};

/**
 * Calculate reputation boost for a user
 */
export const calculateReputationBoost = async (
  userId: number
): Promise<number> => {
  try {
    // Mock implementation - in real app this would calculate based on achievements
    const baseBoost = 0;
    const achievementBoost = Math.floor(userId / 5) * 0.1; // Mock calculation
    return baseBoost + achievementBoost;
  } catch (error) {
    appLogger.error('Error calculating reputation boost', { error: error instanceof Error ? error.message : 'Unknown error' });
    throw error;
  }
};

/**
 * Award achievement to a user
 */
export const awardAchievement = async (
  userId: number,
  walletAddress: string,
  achievementId: string,
  evidenceData: Record<string, any>
): Promise<any> => {
  try {
    // Mock implementation
    const result = {
      success: true,
      message: `Achievement ${achievementId} awarded to user ${userId}`,
      data: {
        id: `user_achieve_${Date.now()}`,
        userId: userId.toString(),
        achievementId,
        progress: 100,
        completed: true,
        completedAt: new Date(),
        claimedReward: false,
        metadata: { evidenceData, walletAddress },
      },
    };
    return result;
  } catch (error) {
    appLogger.error('Error awarding achievement', { error: error instanceof Error ? error.message : 'Unknown error' });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to award achievement',
    };
  }
};

/**
 * Update achievement progress
 */
export const updateAchievementProgress = async (
  userId: number,
  walletAddress: string,
  achievementId: string,
  progressValue: number
): Promise<any> => {
  try {
    // Mock implementation
    const result = {
      success: true,
      message: `Achievement progress updated for user ${userId}`,
      data: {
        id: `user_achieve_${Date.now()}`,
        userId: userId.toString(),
        achievementId,
        progress: progressValue,
        completed: progressValue >= 100,
        completedAt: progressValue >= 100 ? new Date() : undefined,
        claimedReward: false,
        metadata: { walletAddress, lastUpdate: new Date() },
      },
    };
    return result;
  } catch (error) {
    appLogger.error('Error updating achievement progress', { error: error instanceof Error ? error.message : 'Unknown error' });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to update achievement progress',
    };
  }
};

/**
 * Get badge upgrade path
 */
export const getBadgeUpgradePath = async (
  badgeId: string,
  currentTier: string
): Promise<any> => {
  try {
    // Mock implementation
    const upgradePaths = {
      weather_bronze: {
        next: 'weather_silver',
        requirements: 'Submit 500 weather readings',
      },
      weather_silver: {
        next: 'weather_gold',
        requirements: 'Submit 1000 weather readings',
      },
      mining_bronze: {
        next: 'mining_silver',
        requirements: 'Mine 5000 WRF tokens',
      },
      mining_silver: {
        next: 'mining_gold',
        requirements: 'Mine 10000 WRF tokens',
      },
    };

    const upgradeKey = `${badgeId}_${currentTier}`;
    const upgradePath = upgradePaths[upgradeKey as keyof typeof upgradePaths];

    return {
      success: true,
      data: {
        badgeId,
        currentTier,
        nextTier: upgradePath?.next || 'max_tier_reached',
        requirements:
          upgradePath?.requirements || 'No further upgrades available',
      },
    };
  } catch (error) {
    appLogger.error('Error getting badge upgrade path', { error: error instanceof Error ? error.message : 'Unknown error' });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to get badge upgrade path',
    };
  }
};

/**
 * Sync achievement with WrfView app
 */
export const syncWithWrfView = async (
  userAchievementId: string
): Promise<any> => {
  try {
    // Mock implementation - in real app this would sync with external service
    return {
      success: true,
      message: `Achievement ${userAchievementId} synced with WrfView app`,
      data: {
        userAchievementId,
        syncStatus: 'completed',
        syncedAt: new Date(),
        wrfViewId: `wrfview_${Date.now()}`,
      },
    };
  } catch (error) {
    appLogger.error('Error syncing with WrfView', { error: error instanceof Error ? error.message : 'Unknown error' });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to sync with WrfView app',
    };
  }
};

/**
 * Recalculate all metrics for a user
 */
export const recalculateUserMetrics = async (userId: number): Promise<any> => {
  try {
    // Mock implementation - in real app this would recalculate all user metrics
    return {
      success: true,
      message: `Metrics recalculated for user ${userId}`,
      data: {
        userId,
        recalculatedAt: new Date(),
        metrics: {
          totalAchievements: Math.floor(Math.random() * 20),
          governanceWeight: await calculateGovernanceWeight(userId),
          reputationBoost: await calculateReputationBoost(userId),
          totalTokensEarned: Math.floor(Math.random() * 1000),
        },
      },
    };
  } catch (error) {
    appLogger.error('Error recalculating user metrics', { error: error instanceof Error ? error.message : 'Unknown error' });
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to recalculate user metrics',
    };
  }
};

/**
 * Update achievement progress for user (Express handler)
 */
export const updateAchievementProgressHandler = async (
  req: AchievementRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // Zod validation for achievement progress
    const validationResult = achievementProgressSchema.safeParse(req.body);
    if (!validationResult.success) {
      const errorResponse: ControllerResponse<UserAchievement> = {
        success: false,
        error: validationResult.error.issues[0].message,
        message: 'Invalid achievement progress data',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }
    const { userId: validatedUserId, achievementId, progressData } = validationResult.data;
    const userId = validatedUserId as EthereumAddress;

    // Find the achievement to calculate progress percentage
    const achievement = MOCK_ACHIEVEMENTS.find(a => a.id === achievementId);
    if (!achievement) {
      const errorResponse: ControllerResponse<UserAchievement> = {
        success: false,
        error: 'Achievement not found',
        message: `No achievement found with ID ${achievementId}`,
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(404).json(errorResponse);
      return;
    }

    // Calculate progress percentage based on requirements
    let totalProgress = 0;
    for (const requirement of achievement.requirements) {
      const currentValue = progressData[requirement.type] || 0;
      const requirementProgress = Math.min(
        (currentValue / requirement.target) * 100,
        100
      );
      totalProgress += requirementProgress;
    }

    const averageProgress = Math.round(
      totalProgress / achievement.requirements.length
    );
    const isCompleted = averageProgress >= 100;

    let updatedAchievement: UserAchievement;
    if (req.storage) {
      updatedAchievement = await req.storage.updateAchievementProgress(
        userId,
        achievementId,
        averageProgress
      );

      // Complete achievement if progress reaches 100%
      if (isCompleted) {
        updatedAchievement = await req.storage.completeAchievement(
          userId,
          achievementId
        );
      }
    } else {
      // Mock response for development
      updatedAchievement = {
        id: `user_achieve_${uuidv4()}`,
        userId,
        achievementId,
        progress: averageProgress,
        completed: isCompleted,
        completedAt: isCompleted ? new Date() : undefined,
        claimedReward: false,
        metadata: progressData,
      };
    }

    const response: ControllerResponse<UserAchievement> = {
      success: true,
      data: updatedAchievement,
      message: isCompleted
        ? 'Achievement completed!'
        : `Achievement progress updated to ${averageProgress}%`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error: unknown) {
    appLogger.error('Error in updateAchievementProgress', { error: error instanceof Error ? error.message : 'Unknown error' });
    const errorResponse: ControllerResponse<UserAchievement> = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to update achievement progress',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Claim achievement reward
 */
export const claimReward = async (
  req: AchievementRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // Zod validation for userId parameter
    const userIdResult = ethereumAddressSchema.safeParse(req.params.userId);
    if (!userIdResult.success) {
      const errorResponse: ControllerResponse<UserAchievement> = {
        success: false,
        error: userIdResult.error.issues[0].message,
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }
    const userId = userIdResult.data as EthereumAddress;

    // Zod validation for achievementId parameter
    const achievementIdSchema = z.string().min(1, 'Achievement ID is required').max(100);
    const achievementIdResult = achievementIdSchema.safeParse(req.params.achievementId);
    if (!achievementIdResult.success) {
      const errorResponse: ControllerResponse<UserAchievement> = {
        success: false,
        error: achievementIdResult.error.issues[0].message,
        message: 'Please provide a valid achievement ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }
    const achievementId = achievementIdResult.data;

    // Check if user has completed the achievement
    let userAchievement: UserAchievement | null = null;
    if (req.storage) {
      userAchievement = await req.storage.getUserAchievement(
        userId,
        achievementId
      );
    }

    if (!userAchievement || !userAchievement.completed) {
      const errorResponse: ControllerResponse<UserAchievement> = {
        success: false,
        error: 'Achievement not completed',
        message: 'Cannot claim reward for incomplete achievement',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    if (userAchievement.claimedReward) {
      const errorResponse: ControllerResponse<UserAchievement> = {
        success: false,
        error: 'Reward already claimed',
        message: 'Achievement reward has already been claimed',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    let claimedAchievement: UserAchievement;
    if (req.storage) {
      claimedAchievement = await req.storage.claimReward(userId, achievementId);
    } else {
      // Mock response for development
      claimedAchievement = {
        ...userAchievement,
        claimedReward: true,
        claimedAt: new Date(),
      };
    }

    // Get achievement details for reward information
    const achievement = MOCK_ACHIEVEMENTS.find(a => a.id === achievementId);

    const response: ControllerResponse<UserAchievement> = {
      success: true,
      data: claimedAchievement,
      message: `Reward claimed successfully! You received ${achievement?.rewards.tokens || 0} WRF tokens.`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error: unknown) {
    appLogger.error('Error in claimReward', { error: error instanceof Error ? error.message : 'Unknown error' });
    const errorResponse: ControllerResponse<UserAchievement> = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to claim achievement reward',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Get achievement leaderboard
 */
export const getLeaderboard = async (
  req: AchievementRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    // Zod validation for leaderboard query parameters
    const validationResult = leaderboardQuerySchema.safeParse(req.query);
    if (!validationResult.success) {
      const errorResponse: PaginatedResponse<any> = {
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
      return;
    }
    const { page, limit, category } = validationResult.data;

    let leaderboard: any[] = [];
    if (req.storage) {
      leaderboard = await req.storage.getLeaderboard(category, limit);
    } else {
      // Mock leaderboard for development
      leaderboard = [
        {
          userId: '0x1234567890123456789012345678901234567890',
          username: 'WeatherMaster',
          completedAchievements: 12,
          totalTokensEarned: 850,
          lastActivity: new Date(),
          badges: ['weather_gold', 'mining_silver', 'governance_bronze'],
        },
        {
          userId: '0x2345678901234567890123456789012345678901',
          username: 'ClimateGuardian',
          completedAchievements: 10,
          totalTokensEarned: 720,
          lastActivity: new Date(),
          badges: ['environmental_gold', 'weather_silver'],
        },
        {
          userId: '0x3456789012345678901234567890123456789012',
          username: 'MiningExpert',
          completedAchievements: 8,
          totalTokensEarned: 650,
          lastActivity: new Date(),
          badges: ['mining_platinum', 'crosschain_silver'],
        },
      ];
    }

    const totalPages = Math.ceil(leaderboard.length / limit);

    const response: PaginatedResponse<any> = {
      success: true,
      data: leaderboard,
      message: `Retrieved ${leaderboard.length} leaderboard entries`,
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
  } catch (error: unknown) {
    appLogger.error('Error in getLeaderboard', { error: error instanceof Error ? error.message : 'Unknown error' });
    const errorResponse: PaginatedResponse<any> = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to retrieve leaderboard',
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
  }
};

// Export all controller methods
export default {
  getAllAchievements,
  getUserAchievements,
  updateAchievementProgress,
  claimReward,
  getLeaderboard,
};
