/**
 * Achievements Controller - TypeScript Implementation
 * Handles user achievements, badges, and progress tracking
 */

import { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
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
    | 'social'
    | 'technical';
  type: 'progress' | 'milestone' | 'streak' | 'rare' | 'seasonal';
  requirements: {
    metric: string;
    target: number;
    timeframe?: number; // days
    conditions?: Record<string, any>;
  };
  rewards: {
    tokens: PositiveNumber;
    nftId?: string;
    badge?: string;
    title?: string;
  };
  rarity: 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary';
  icon: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface UserAchievement {
  id: string;
  userId: EthereumAddress;
  achievementId: string;
  progress: number; // 0-100
  completed: boolean;
  completedAt?: Date;
  currentStreak?: number;
  bestStreak?: number;
  metadata: Record<string, any>;
  earnedRewards: {
    tokens: PositiveNumber;
    nftId?: string;
    badge?: string;
    title?: string;
  };
  startedAt: Date;
  lastUpdated: Date;
}

interface UserBadge {
  id: string;
  userId: EthereumAddress;
  badgeId: string;
  name: string;
  description: string;
  imageUrl: string;
  category: string;
  rarity: string;
  earnedAt: Date;
  isVisible: boolean;
}

interface LeaderboardEntry {
  userId: EthereumAddress;
  username?: string;
  score: number;
  rank: number;
  achievements: number;
  badges: number;
  totalRewards: PositiveNumber;
  lastActivity: Date;
}

// Enhanced request interface
interface AchievementsRequest extends Request {
  storage?: {
    getAllAchievements: () => Promise<Achievement[]>;
    getAchievement: (id: string) => Promise<Achievement | null>;
    createAchievement: (
      achievement: Partial<Achievement>
    ) => Promise<Achievement>;
    getUserAchievements: (
      userId: EthereumAddress
    ) => Promise<UserAchievement[]>;
    updateUserAchievement: (
      id: string,
      updates: Partial<UserAchievement>
    ) => Promise<UserAchievement>;
    getUserBadges: (userId: EthereumAddress) => Promise<UserBadge[]>;
    getLeaderboard: (
      category?: string,
      limit?: number
    ) => Promise<LeaderboardEntry[]>;
  };
  achievementService?: {
    checkProgress: (
      userId: EthereumAddress,
      achievementId: string
    ) => Promise<number>;
    awardAchievement: (
      userId: EthereumAddress,
      achievementId: string
    ) => Promise<boolean>;
    calculateUserScore: (userId: EthereumAddress) => Promise<number>;
  };
}

/**
 * Get all achievements
 */
export const getAllAchievements = async (
  req: AchievementsRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const category = req.query.category as string;
    const type = req.query.type as string;
    const rarity = req.query.rarity as string;
    const isActive =
      req.query.isActive === 'true'
        ? true
        : req.query.isActive === 'false'
          ? false
          : undefined;

    let achievements: Achievement[] = [];
    if (req.storage) {
      achievements = await req.storage.getAllAchievements();
    } else {
      // Mock achievements for development
      achievements = [
        {
          id: 'achievement_1',
          name: 'Weather Data Pioneer',
          description:
            'Submit your first weather data reading to the blockchain',
          category: 'weather',
          type: 'milestone',
          requirements: {
            metric: 'weather_submissions',
            target: 1,
          },
          rewards: {
            tokens: 1.0 as PositiveNumber,
            badge: 'pioneer_badge',
            title: 'Data Pioneer',
          },
          rarity: 'common',
          icon: '🌡️',
          isActive: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date(),
        },
        {
          id: 'achievement_2',
          name: 'Weather Station Master',
          description: 'Submit 1000 weather data readings',
          category: 'weather',
          type: 'progress',
          requirements: {
            metric: 'weather_submissions',
            target: 1000,
          },
          rewards: {
            tokens: 50.0 as PositiveNumber,
            nftId: 'weather_master_nft',
            badge: 'master_badge',
            title: 'Weather Master',
          },
          rarity: 'rare',
          icon: '⛈️',
          isActive: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date(),
        },
        {
          id: 'achievement_3',
          name: 'Daily Streak Champion',
          description: 'Submit weather data for 30 consecutive days',
          category: 'weather',
          type: 'streak',
          requirements: {
            metric: 'daily_submissions',
            target: 30,
            timeframe: 30,
          },
          rewards: {
            tokens: 25.0 as PositiveNumber,
            badge: 'streak_champion',
            title: 'Streak Champion',
          },
          rarity: 'uncommon',
          icon: '🔥',
          isActive: true,
          createdAt: new Date('2024-01-01'),
          updatedAt: new Date(),
        },
      ];
    }

    // Apply filters
    if (category) {
      achievements = achievements.filter(
        achievement => achievement.category === category
      );
    }
    if (type) {
      achievements = achievements.filter(
        achievement => achievement.type === type
      );
    }
    if (rarity) {
      achievements = achievements.filter(
        achievement => achievement.rarity === rarity
      );
    }
    if (isActive !== undefined) {
      achievements = achievements.filter(
        achievement => achievement.isActive === isActive
      );
    }

    // Sort by rarity and name
    const rarityOrder = {
      common: 1,
      uncommon: 2,
      rare: 3,
      epic: 4,
      legendary: 5,
    };
    achievements.sort((a, b) => {
      const rarityDiff = rarityOrder[b.rarity] - rarityOrder[a.rarity];
      return rarityDiff !== 0 ? rarityDiff : a.name.localeCompare(b.name);
    });

    const response: ControllerResponse<Achievement[]> = {
      success: true,
      data: achievements,
      message: `Retrieved ${achievements.length} achievements`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error: unknown) {
    appLogger.error('Failed to retrieve achievements', { module: 'AchievementsController', operation: 'getAllAchievements', error: error instanceof Error ? error.message : 'Unknown error' });
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
 * Get user achievements
 */
export const getUserAchievements = async (
  req: AchievementsRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const userId = req.params.userId;
    const completed =
      req.query.completed === 'true'
        ? true
        : req.query.completed === 'false'
          ? false
          : undefined;

    if (!userId) {
      const errorResponse: ControllerResponse<UserAchievement[]> = {
        success: false,
        error: 'User ID is required',
        message: 'Please provide a valid user ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Validate user ID format
    if (!userId.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<UserAchievement[]> = {
        success: false,
        error: 'Invalid user ID format',
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    let userAchievements: UserAchievement[] = [];
    if (req.storage) {
      userAchievements = await req.storage.getUserAchievements(
        userId as EthereumAddress
      );
    } else {
      // Mock user achievements for development
      userAchievements = [
        {
          id: 'user_achievement_1',
          userId: userId as EthereumAddress,
          achievementId: 'achievement_1',
          progress: 100,
          completed: true,
          completedAt: new Date(Date.now() - 86400000),
          metadata: { first_submission: '2024-03-15' },
          earnedRewards: {
            tokens: 1.0 as PositiveNumber,
            badge: 'pioneer_badge',
            title: 'Data Pioneer',
          },
          startedAt: new Date('2024-03-15'),
          lastUpdated: new Date(Date.now() - 86400000),
        },
        {
          id: 'user_achievement_2',
          userId: userId as EthereumAddress,
          achievementId: 'achievement_2',
          progress: 45,
          completed: false,
          metadata: { submissions_count: 450 },
          earnedRewards: {
            tokens: 0 as PositiveNumber,
          },
          startedAt: new Date('2024-03-15'),
          lastUpdated: new Date(),
        },
        {
          id: 'user_achievement_3',
          userId: userId as EthereumAddress,
          achievementId: 'achievement_3',
          progress: 83,
          completed: false,
          currentStreak: 25,
          bestStreak: 28,
          metadata: { current_streak: 25, best_streak: 28 },
          earnedRewards: {
            tokens: 0 as PositiveNumber,
          },
          startedAt: new Date('2024-04-01'),
          lastUpdated: new Date(),
        },
      ];
    }

    // Filter by completion status if provided
    if (completed !== undefined) {
      userAchievements = userAchievements.filter(
        achievement => achievement.completed === completed
      );
    }

    // Sort by progress (completed first, then by progress percentage)
    userAchievements.sort((a, b) => {
      if (a.completed && !b.completed) return -1;
      if (!a.completed && b.completed) return 1;
      return b.progress - a.progress;
    });

    const response: ControllerResponse<UserAchievement[]> = {
      success: true,
      data: userAchievements,
      message: `Retrieved ${userAchievements.length} user achievements`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error: unknown) {
    appLogger.error('Failed to retrieve user achievements', { module: 'AchievementsController', operation: 'getUserAchievements', error: error instanceof Error ? error.message : 'Unknown error' });
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
 * Get user badges
 */
export const getUserBadges = async (
  req: AchievementsRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const userId = req.params.userId;
    const visible =
      req.query.visible === 'true'
        ? true
        : req.query.visible === 'false'
          ? false
          : undefined;

    if (!userId) {
      const errorResponse: ControllerResponse<UserBadge[]> = {
        success: false,
        error: 'User ID is required',
        message: 'Please provide a valid user ID',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Validate user ID format
    if (!userId.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<UserBadge[]> = {
        success: false,
        error: 'Invalid user ID format',
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    let userBadges: UserBadge[] = [];
    if (req.storage) {
      userBadges = await req.storage.getUserBadges(userId as EthereumAddress);
    } else {
      // Mock user badges for development
      userBadges = [
        {
          id: 'user_badge_1',
          userId: userId as EthereumAddress,
          badgeId: 'pioneer_badge',
          name: 'Data Pioneer',
          description: 'First weather data submission',
          imageUrl: '/badges/pioneer.png',
          category: 'weather',
          rarity: 'common',
          earnedAt: new Date(Date.now() - 86400000),
          isVisible: true,
        },
        {
          id: 'user_badge_2',
          userId: userId as EthereumAddress,
          badgeId: 'contributor_badge',
          name: 'Network Contributor',
          description: 'Active contribution to the network',
          imageUrl: '/badges/contributor.png',
          category: 'governance',
          rarity: 'uncommon',
          earnedAt: new Date(Date.now() - 172800000),
          isVisible: true,
        },
      ];
    }

    // Filter by visibility if provided
    if (visible !== undefined) {
      userBadges = userBadges.filter(badge => badge.isVisible === visible);
    }

    // Sort by earned date (most recent first)
    userBadges.sort(
      (a, b) => new Date(b.earnedAt).getTime() - new Date(a.earnedAt).getTime()
    );

    const response: ControllerResponse<UserBadge[]> = {
      success: true,
      data: userBadges,
      message: `Retrieved ${userBadges.length} user badges`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error: unknown) {
    appLogger.error('Failed to retrieve user badges', { module: 'AchievementsController', operation: 'getUserBadges', error: error instanceof Error ? error.message : 'Unknown error' });
    const errorResponse: ControllerResponse<UserBadge[]> = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to retrieve user badges',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Get leaderboard
 */
export const getLeaderboard = async (
  req: AchievementsRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const category = req.query.category as string;
    const limit = Math.min(parseInt(req.query.limit as string, 10) || 50, 100);

    let leaderboard: LeaderboardEntry[] = [];
    if (req.storage) {
      leaderboard = await req.storage.getLeaderboard(category, limit);
    } else {
      // Mock leaderboard for development
      leaderboard = [
        {
          userId:
            '0x1234567890123456789012345678901234567890' as EthereumAddress,
          username: 'WeatherMaster',
          score: 15420,
          rank: 1,
          achievements: 12,
          badges: 8,
          totalRewards: 245.75 as PositiveNumber,
          lastActivity: new Date(),
        },
        {
          userId:
            '0x2345678901234567890123456789012345678901' as EthereumAddress,
          username: 'ClimateTracker',
          score: 12850,
          rank: 2,
          achievements: 10,
          badges: 6,
          totalRewards: 198.5 as PositiveNumber,
          lastActivity: new Date(Date.now() - 3600000),
        },
        {
          userId:
            '0x3456789012345678901234567890123456789012' as EthereumAddress,
          username: 'DataMiner42',
          score: 9630,
          rank: 3,
          achievements: 8,
          badges: 5,
          totalRewards: 156.25 as PositiveNumber,
          lastActivity: new Date(Date.now() - 7200000),
        },
      ];
    }

    const response: ControllerResponse<LeaderboardEntry[]> = {
      success: true,
      data: leaderboard,
      message: `Retrieved top ${leaderboard.length} leaderboard entries`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error: unknown) {
    appLogger.error('Failed to retrieve leaderboard', { module: 'AchievementsController', operation: 'getLeaderboard', error: error instanceof Error ? error.message : 'Unknown error' });
    const errorResponse: ControllerResponse<LeaderboardEntry[]> = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to retrieve leaderboard',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

/**
 * Award achievement to user
 */
export const awardAchievement = async (
  req: AchievementsRequest,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const { userId, achievementId } = req.body;

    // Validate required fields
    if (!userId || !achievementId) {
      const errorResponse: ControllerResponse<UserAchievement> = {
        success: false,
        error: 'Missing required fields',
        message: 'User ID and achievement ID are required',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Validate user ID format
    if (!userId.match(/^0x[a-fA-F0-9]{40}$/)) {
      const errorResponse: ControllerResponse<UserAchievement> = {
        success: false,
        error: 'Invalid user ID format',
        message: 'User ID must be a valid Ethereum address',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Award achievement
    let awarded = false;
    if (req.achievementService) {
      awarded = await req.achievementService.awardAchievement(
        userId as EthereumAddress,
        achievementId
      );
    } else {
      awarded = true; // Mock success
    }

    if (!awarded) {
      const errorResponse: ControllerResponse<UserAchievement> = {
        success: false,
        error: 'Achievement award failed',
        message: 'Failed to award achievement to user',
        timestamp: new Date().toISOString(),
        requestId,
      };
      res.status(400).json(errorResponse);
      return;
    }

    // Mock user achievement for response
    const userAchievement: UserAchievement = {
      id: `user_achievement_${uuidv4()}`,
      userId: userId as EthereumAddress,
      achievementId,
      progress: 100,
      completed: true,
      completedAt: new Date(),
      metadata: { manual_award: true },
      earnedRewards: {
        tokens: 10.0 as PositiveNumber,
        badge: 'achievement_badge',
      },
      startedAt: new Date(),
      lastUpdated: new Date(),
    };

    const response: ControllerResponse<UserAchievement> = {
      success: true,
      data: userAchievement,
      message: 'Achievement awarded successfully',
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.status(201).json(response);
  } catch (error: unknown) {
    appLogger.error('Failed to award achievement', { module: 'AchievementsController', operation: 'awardAchievement', error: error instanceof Error ? error.message : 'Unknown error' });
    const errorResponse: ControllerResponse<UserAchievement> = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to award achievement',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

// Export all controller methods
/**
 * Get earned achievements for a miner (alias for getUserAchievements)
 */
export const getEarnedAchievements = async (
  req: Request,
  res: Response
): Promise<void> => {
  // This is an alias that calls getUserAchievements
  await getUserAchievements(req, res);
};

/**
 * Update achievement visibility
 */
export const updateAchievementVisibility = async (
  req: Request,
  res: Response
): Promise<void> => {
  const requestId = uuidv4();

  try {
    const { achievementId, isVisible } = req.body;

    if (!achievementId || typeof isVisible !== 'boolean') {
      res.status(400).json({
        success: false,
        error: 'Achievement ID and visibility flag are required',
        timestamp: new Date().toISOString(),
        requestId,
      });
      return;
    }

    // Mock implementation - in real app this would update database
    const response: ControllerResponse<any> = {
      success: true,
      data: {
        achievementId,
        isVisible,
        updatedAt: new Date(),
      },
      message: `Achievement visibility updated to ${isVisible}`,
      timestamp: new Date().toISOString(),
      requestId,
    };

    res.json(response);
  } catch (error: unknown) {
    appLogger.error('Failed to update achievement visibility', { module: 'AchievementsController', operation: 'updateAchievementVisibility', error: error instanceof Error ? error.message : 'Unknown error' });
    const errorResponse: ControllerResponse<any> = {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error occurred',
      message: 'Failed to update achievement visibility',
      timestamp: new Date().toISOString(),
      requestId,
    };
    res.status(500).json(errorResponse);
  }
};

export default {
  getAllAchievements,
  getUserAchievements,
  getUserBadges,
  getLeaderboard,
  awardAchievement,
  getEarnedAchievements,
  updateAchievementVisibility,
};
