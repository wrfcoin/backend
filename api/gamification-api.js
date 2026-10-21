/**
 * Gamification API Endpoints
 * Achievement badges and levels for governance contributors
 */

const express = require('express');
const router = express.Router();
const { gamificationService } = require('../services/gamification-service');

// Get user profile with achievements and level
router.get('/profile/:userAddress', (req, res) => {
  try {
    const { userAddress } = req.params;

    // Validate Ethereum address format
    if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid Ethereum address format' });
    }

    const profile = gamificationService.getUserProfile(userAddress);

    res.json({
      success: true,
      data: profile,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get all available achievements
router.get('/achievements', (req, res) => {
  try {
    const { category } = req.query;

    // Validate category if provided
    if (category !== undefined) {
      if (typeof category !== 'string' || category.length > 100) {
        return res.status(400).json({ success: false, error: 'category must be a string under 100 chars' });
      }
    }

    let achievements = Object.values(gamificationService.achievements);

    if (category) {
      achievements = achievements.filter(a => a.category === category);
    }

    // Group by category
    const groupedAchievements = achievements.reduce((acc, achievement) => {
      if (!acc[achievement.category]) {
        acc[achievement.category] = [];
      }
      acc[achievement.category].push(achievement);
      return acc;
    }, {});

    res.json({
      success: true,
      data: {
        achievements: groupedAchievements,
        total: achievements.length,
        categories: Object.keys(groupedAchievements),
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get leaderboard
router.get('/leaderboard', (req, res) => {
  try {
    const { category = 'points', limit = 10 } = req.query;

    // Validate category
    const validCategories = ['points', 'votes', 'proposals', 'achievements'];
    if (typeof category !== 'string' || !validCategories.includes(category)) {
      return res.status(400).json({ success: false, error: 'category must be one of: points, votes, proposals, achievements' });
    }

    // Validate limit
    const limitNum = parseInt(limit, 10);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({ success: false, error: 'limit must be a number between 1 and 100' });
    }

    const leaderboard = gamificationService.getLeaderboard(
      category,
      limitNum
    );

    res.json({
      success: true,
      data: {
        leaderboard,
        category,
        total: leaderboard.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get levels information
router.get('/levels', (req, res) => {
  try {
    const levels = gamificationService.levelThresholds.map(level => ({
      ...level,
      users: Array.from(gamificationService.userStats.entries()).filter(
        ([_, stats]) => {
          const userLevel = gamificationService.getUserLevel(_);
          return userLevel.level === level.level;
        }
      ).length,
    }));

    res.json({
      success: true,
      data: levels,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Record vote activity
router.post('/activity/vote', (req, res) => {
  try {
    const { userAddress, proposalId, votingPower } = req.body;

    if (!userAddress || !proposalId || votingPower === undefined) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userAddress, proposalId, votingPower',
      });
    }

    // Validate Ethereum address format
    if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid Ethereum address format for userAddress' });
    }

    // Validate proposalId
    if (typeof proposalId !== 'string' || proposalId.length === 0 || proposalId.length > 100) {
      return res.status(400).json({ success: false, error: 'proposalId must be a non-empty string under 100 chars' });
    }

    // Validate votingPower
    if (typeof votingPower !== 'number' || votingPower < 0) {
      return res.status(400).json({ success: false, error: 'votingPower must be a non-negative number' });
    }

    gamificationService.recordVote(userAddress, proposalId, votingPower);
    const profile = gamificationService.getUserProfile(userAddress);

    res.json({
      success: true,
      data: {
        profile,
        message: 'Vote activity recorded successfully',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Record proposal creation
router.post('/activity/proposal', (req, res) => {
  try {
    const { userAddress, proposalId } = req.body;

    if (!userAddress || !proposalId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userAddress, proposalId',
      });
    }

    // Validate Ethereum address format
    if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid Ethereum address format for userAddress' });
    }

    // Validate proposalId
    if (typeof proposalId !== 'string' || proposalId.length === 0 || proposalId.length > 100) {
      return res.status(400).json({ success: false, error: 'proposalId must be a non-empty string under 100 chars' });
    }

    gamificationService.recordProposalCreation(userAddress, proposalId);
    const profile = gamificationService.getUserProfile(userAddress);

    res.json({
      success: true,
      data: {
        profile,
        message: 'Proposal creation recorded successfully',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Record delegation
router.post('/activity/delegation', (req, res) => {
  try {
    const { delegateAddress, delegatorAddress, amount } = req.body;

    if (!delegateAddress || !delegatorAddress || amount === undefined) {
      return res.status(400).json({
        success: false,
        error:
          'Missing required fields: delegateAddress, delegatorAddress, amount',
      });
    }

    // Validate Ethereum address format for delegateAddress
    if (typeof delegateAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(delegateAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid Ethereum address format for delegateAddress' });
    }

    // Validate Ethereum address format for delegatorAddress
    if (typeof delegatorAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(delegatorAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid Ethereum address format for delegatorAddress' });
    }

    // Validate amount
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum <= 0) {
      return res.status(400).json({ success: false, error: 'amount must be a positive number' });
    }

    gamificationService.recordDelegation(
      delegateAddress,
      delegatorAddress,
      amountNum
    );
    const profile = gamificationService.getUserProfile(delegateAddress);

    res.json({
      success: true,
      data: {
        profile,
        message: 'Delegation recorded successfully',
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get user achievements progress
router.get('/progress/:userAddress', (req, res) => {
  try {
    const { userAddress } = req.params;
    const { category } = req.query;

    // Validate Ethereum address format
    if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid Ethereum address format' });
    }

    // Validate category if provided
    if (category !== undefined && (typeof category !== 'string' || category.length > 100)) {
      return res.status(400).json({ success: false, error: 'category must be a string under 100 chars' });
    }

    const stats = gamificationService.getUserStats(userAddress);
    const achievements = Object.values(gamificationService.achievements);

    let filteredAchievements = achievements;
    if (category) {
      filteredAchievements = achievements.filter(a => a.category === category);
    }

    const progress = filteredAchievements.map(achievement => {
      const isUnlocked = stats.achievements.includes(achievement.id);
      let progressPercentage = 0;
      let currentValue = 0;
      let targetValue = 1;

      if (achievement.requirement) {
        const req = achievement.requirement;
        switch (req.type) {
          case 'total_votes':
            currentValue = stats.totalVotes;
            targetValue = req.count;
            break;
          case 'consecutive_votes':
            currentValue = stats.consecutiveVotes;
            targetValue = req.count;
            break;
          case 'total_proposals':
            currentValue = stats.totalProposals;
            targetValue = req.count;
            break;
        }
        progressPercentage = Math.min(100, (currentValue / targetValue) * 100);
      } else {
        progressPercentage = isUnlocked ? 100 : 0;
      }

      return {
        ...achievement,
        unlocked: isUnlocked,
        progress: {
          percentage: progressPercentage,
          current: currentValue,
          target: targetValue,
        },
      };
    });

    res.json({
      success: true,
      data: {
        achievements: progress,
        summary: {
          unlocked: progress.filter(a => a.unlocked).length,
          total: progress.length,
          points: stats.totalPoints,
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get recent achievements across all users
router.get('/recent-achievements', (req, res) => {
  try {
    const { limit = 10 } = req.query;

    // Validate limit
    const limitNum = parseInt(limit, 10);
    if (isNaN(limitNum) || limitNum < 1 || limitNum > 100) {
      return res.status(400).json({ success: false, error: 'limit must be a number between 1 and 100' });
    }

    // This would be stored in a database in a real implementation
    // For now, we'll generate sample recent achievements
    const recentAchievements = [
      {
        userAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        achievement: gamificationService.achievements.super_voter,
        unlockedAt: new Date(Date.now() - 3600000).toISOString(),
      },
      {
        userAddress: '0x856f48C9247d7b8e3D4B8F5e2C9A7b8E4C5F1234',
        achievement: gamificationService.achievements.successful_proposer,
        unlockedAt: new Date(Date.now() - 7200000).toISOString(),
      },
    ];

    res.json({
      success: true,
      data: recentAchievements.slice(0, parseInt(limit, 10)),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Get statistics overview
router.get('/stats/overview', (req, res) => {
  try {
    const totalUsers = gamificationService.userStats.size;
    const totalAchievements = Object.keys(
      gamificationService.achievements
    ).length;

    let totalVotes = 0;
    let totalProposals = 0;
    let totalPoints = 0;
    let activeUsers = 0;

    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;

    for (const [_, stats] of gamificationService.userStats) {
      totalVotes += stats.totalVotes;
      totalProposals += stats.totalProposals;
      totalPoints += stats.totalPoints;

      if (stats.lastVoteTime && stats.lastVoteTime > weekAgo) {
        activeUsers++;
      }
    }

    const avgPointsPerUser =
      totalUsers > 0 ? Math.round(totalPoints / totalUsers) : 0;
    const participationRate =
      totalUsers > 0 ? ((activeUsers / totalUsers) * 100).toFixed(1) : 0;

    res.json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          active: activeUsers,
          participationRate: `${participationRate}%`,
        },
        activity: {
          totalVotes,
          totalProposals,
          totalPoints,
          avgPointsPerUser,
        },
        achievements: {
          total: totalAchievements,
          categories: [
            ...new Set(
              Object.values(gamificationService.achievements).map(
                a => a.category
              )
            ),
          ],
          rarities: [
            ...new Set(
              Object.values(gamificationService.achievements).map(a => a.rarity)
            ),
          ],
        },
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Manually award achievement (admin function)
router.post('/admin/award-achievement', (req, res) => {
  try {
    const { userAddress, achievementId, adminKey } = req.body;

    // Validate required fields
    if (!userAddress || !achievementId || !adminKey) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: userAddress, achievementId, adminKey',
      });
    }

    // Validate Ethereum address format
    if (typeof userAddress !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(userAddress)) {
      return res.status(400).json({ success: false, error: 'Invalid Ethereum address format' });
    }

    // Validate achievementId
    if (typeof achievementId !== 'string' || achievementId.length === 0 || achievementId.length > 100) {
      return res.status(400).json({ success: false, error: 'achievementId must be a non-empty string under 100 chars' });
    }

    // Validate adminKey type
    if (typeof adminKey !== 'string') {
      return res.status(400).json({ success: false, error: 'adminKey must be a string' });
    }

    const configuredAdminKey = process.env.GAMIFICATION_ADMIN_KEY;

    if (!configuredAdminKey) {
      return res.status(503).json({
        success: false,
        error: 'Gamification admin secret is not configured',
      });
    }

    // Server-managed secret check: keep the admin path off the demo key.
    if (adminKey !== configuredAdminKey) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized',
      });
    }

    if (!gamificationService.achievements[achievementId]) {
      return res.status(400).json({
        success: false,
        error: 'Achievement not found',
      });
    }

    gamificationService.awardAchievement(userAddress, achievementId);
    const profile = gamificationService.getUserProfile(userAddress);

    res.json({
      success: true,
      data: {
        profile,
        message: `Achievement ${achievementId} awarded to ${userAddress}`,
      },
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;
