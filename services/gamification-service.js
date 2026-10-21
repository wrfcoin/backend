/**
 * Gamified Participation Rewards Service
 * Achievement badges and levels for governance contributors
 */

const EventEmitter = require('events');
const { appLogger } = require('../server/utils/logger');
const { wrfToBaseUnits, WRF_UNITS_PER_COIN } = require('../shared/currency');

class GamificationService extends EventEmitter {
  constructor() {
    super();
    this.userStats = new Map();
    this.achievements = this.initializeAchievements();
    this.levelThresholds = this.initializeLevels();
    this.streakBonuses = new Map();
  }

  initializeAchievements() {
    return {
      // Voting Achievements
      first_vote: {
        id: 'first_vote',
        name: 'Democracy Begins',
        description: 'Cast your first vote on a governance proposal',
        icon: '🗳️',
        rarity: 'common',
        points: 10,
        category: 'voting',
      },
      consistent_voter: {
        id: 'consistent_voter',
        name: 'Consistent Contributor',
        description: 'Vote on 10 consecutive proposals',
        icon: '📊',
        rarity: 'uncommon',
        points: 50,
        category: 'voting',
        requirement: { type: 'consecutive_votes', count: 10 },
      },
      super_voter: {
        id: 'super_voter',
        name: 'Governance Guardian',
        description: 'Vote on 100 proposals',
        icon: '🛡️',
        rarity: 'rare',
        points: 200,
        category: 'voting',
        requirement: { type: 'total_votes', count: 100 },
      },
      early_bird: {
        id: 'early_bird',
        name: 'Early Bird',
        description: 'Vote within the first hour of proposal creation',
        icon: '🌅',
        rarity: 'uncommon',
        points: 25,
        category: 'voting',
      },

      // Proposal Achievements
      first_proposal: {
        id: 'first_proposal',
        name: 'Visionary',
        description: 'Create your first governance proposal',
        icon: '💡',
        rarity: 'uncommon',
        points: 30,
        category: 'proposals',
      },
      successful_proposer: {
        id: 'successful_proposer',
        name: 'Change Maker',
        description: 'Have a proposal pass with 75%+ approval',
        icon: '✅',
        rarity: 'rare',
        points: 100,
        category: 'proposals',
      },
      prolific_proposer: {
        id: 'prolific_proposer',
        name: 'Policy Architect',
        description: 'Create 10 governance proposals',
        icon: '🏗️',
        rarity: 'epic',
        points: 300,
        category: 'proposals',
        requirement: { type: 'total_proposals', count: 10 },
      },

      // Delegation Achievements
      trusted_delegate: {
        id: 'trusted_delegate',
        name: 'Trusted Representative',
        description: 'Receive delegation of 1,000+ WRF voting power',
        icon: '🤝',
        rarity: 'rare',
        points: 150,
        category: 'delegation',
      },
      delegation_master: {
        id: 'delegation_master',
        name: 'Community Leader',
        description: 'Receive delegation from 50+ unique addresses',
        icon: '👥',
        rarity: 'epic',
        points: 500,
        category: 'delegation',
      },

      // Participation Achievements
      streak_7: {
        id: 'streak_7',
        name: 'Weekly Warrior',
        description: 'Participate in governance for 7 consecutive days',
        icon: '🔥',
        rarity: 'uncommon',
        points: 75,
        category: 'participation',
      },
      streak_30: {
        id: 'streak_30',
        name: 'Monthly Master',
        description: 'Participate in governance for 30 consecutive days',
        icon: '⚡',
        rarity: 'epic',
        points: 250,
        category: 'participation',
      },
      omnipresent: {
        id: 'omnipresent',
        name: 'Omnipresent',
        description: 'Vote on every proposal in a month',
        icon: '🌟',
        rarity: 'legendary',
        points: 1000,
        category: 'participation',
      },

      // Special Achievements
      genesis_participant: {
        id: 'genesis_participant',
        name: 'Genesis Participant',
        description: 'Participate in the first 10 governance proposals',
        icon: '🌱',
        rarity: 'legendary',
        points: 500,
        category: 'special',
      },
      whale_voter: {
        id: 'whale_voter',
        name: 'Whale Voter',
        description: 'Cast a vote with 10,000+ WRF voting power',
        icon: '🐋',
        rarity: 'epic',
        points: 200,
        category: 'special',
      },
      midnight_governor: {
        id: 'midnight_governor',
        name: 'Midnight Governor',
        description: 'Vote between midnight and 6 AM (UTC)',
        icon: '🌙',
        rarity: 'rare',
        points: 50,
        category: 'special',
      },
    };
  }

  initializeLevels() {
    return [
      {
        level: 1,
        name: 'Citizen',
        minPoints: 0,
        maxPoints: 99,
        perks: ['Basic voting rights'],
      },
      {
        level: 2,
        name: 'Advocate',
        minPoints: 100,
        maxPoints: 299,
        perks: ['Badge customization', '+5% vote weight'],
      },
      {
        level: 3,
        name: 'Delegate',
        minPoints: 300,
        maxPoints: 699,
        perks: ['Proposal templates', '+10% vote weight'],
      },
      {
        level: 4,
        name: 'Councilor',
        minPoints: 700,
        maxPoints: 1499,
        perks: ['Priority proposal review', '+15% vote weight'],
      },
      {
        level: 5,
        name: 'Guardian',
        minPoints: 1500,
        maxPoints: 2999,
        perks: ['Governance insights', '+20% vote weight'],
      },
      {
        level: 6,
        name: 'Elder',
        minPoints: 3000,
        maxPoints: 5999,
        perks: ['Mentorship program', '+25% vote weight'],
      },
      {
        level: 7,
        name: 'Sage',
        minPoints: 6000,
        maxPoints: 11999,
        perks: ['Beta feature access', '+30% vote weight'],
      },
      {
        level: 8,
        name: 'Oracle',
        minPoints: 12000,
        maxPoints: 24999,
        perks: ['Proposal scheduling', '+35% vote weight'],
      },
      {
        level: 9,
        name: 'Architect',
        minPoints: 25000,
        maxPoints: 49999,
        perks: ['Governance roadmap input', '+40% vote weight'],
      },
      {
        level: 10,
        name: 'Founder',
        minPoints: 50000,
        maxPoints: Infinity,
        perks: ['Protocol upgrade proposals', '+50% vote weight'],
      },
    ];
  }

  // Track user activity
  recordVote(userAddress, proposalId, votingPower, timestamp = Date.now()) {
    const stats = this.getUserStats(userAddress);

    // Update vote statistics
    stats.totalVotes++;
    stats.lastVoteTime = timestamp;
    // Use integer base-unit arithmetic to avoid float precision loss (#417)
    const votePowerBaseUnits = wrfToBaseUnits(
      Number(String(votingPower).replace(/[^\d.]/g, ''))
    );
    stats.totalVotingPower += Number(votePowerBaseUnits);

    // Check for consecutive voting
    if (
      !stats.lastProposalVoted ||
      this.isConsecutiveProposal(stats.lastProposalVoted, proposalId)
    ) {
      stats.consecutiveVotes++;
    } else {
      stats.consecutiveVotes = 1;
    }
    stats.lastProposalVoted = proposalId;

    // Update activity streak
    this.updateActivityStreak(userAddress, timestamp);

    // Check for achievements
    this.checkVotingAchievements(
      userAddress,
      proposalId,
      votingPower,
      timestamp
    );

    // Award points and check level progression
    this.awardPoints(userAddress, 5); // Base points for voting

    this.emit('vote_recorded', { userAddress, proposalId, stats });
  }

  recordProposalCreation(userAddress, proposalId, timestamp = Date.now()) {
    const stats = this.getUserStats(userAddress);

    stats.totalProposals++;
    stats.proposalsCreated.push({
      id: proposalId,
      createdAt: timestamp,
      status: 'pending',
    });

    this.checkProposalAchievements(userAddress);
    this.awardPoints(userAddress, 20); // Base points for creating proposal

    this.emit('proposal_created', { userAddress, proposalId, stats });
  }

  recordProposalResult(proposalId, result) {
    // Update all users who created this proposal
    for (const [userAddress, stats] of this.userStats) {
      const proposal = stats.proposalsCreated.find(p => p.id === proposalId);
      if (proposal) {
        proposal.status = result.passed ? 'passed' : 'rejected';
        proposal.approvalRate = result.approvalRate;

        if (result.passed) {
          stats.successfulProposals++;
          this.awardPoints(userAddress, 50); // Bonus for successful proposal

          if (result.approvalRate >= 75) {
            this.checkAchievement(userAddress, 'successful_proposer');
          }
        }
      }
    }
  }

  recordDelegation(delegateAddress, delegatorAddress, amount) {
    const stats = this.getUserStats(delegateAddress);

    if (!stats.delegators.has(delegatorAddress)) {
      stats.delegators.set(delegatorAddress, 0);
      stats.uniqueDelegators++;
    }

    const previousAmount = stats.delegators.get(delegatorAddress);
    stats.delegators.set(delegatorAddress, amount);
    stats.totalDelegatedPower += amount - previousAmount;

    this.checkDelegationAchievements(delegateAddress);
    this.awardPoints(delegateAddress, Math.floor(amount / 100)); // Points based on delegation amount

    this.emit('delegation_received', {
      delegateAddress,
      delegatorAddress,
      amount,
      stats,
    });
  }

  // Achievement checking methods
  checkVotingAchievements(userAddress, proposalId, votingPower, timestamp) {
    const stats = this.getUserStats(userAddress);

    // First vote achievement
    if (stats.totalVotes === 1) {
      this.awardAchievement(userAddress, 'first_vote');
    }

    // Consecutive voting achievements
    if (stats.consecutiveVotes === 10) {
      this.awardAchievement(userAddress, 'consistent_voter');
    }

    // Total votes milestone
    if (stats.totalVotes === 100) {
      this.awardAchievement(userAddress, 'super_voter');
    }

    // Whale voter achievement — compare in base units to avoid float rounding (#417)
    const voteBaseUnits = wrfToBaseUnits(
      Number(String(votingPower).replace(/[^\d.]/g, ''))
    );
    // 10,000 WRF in base units = 10_000 * 10^8
    if (voteBaseUnits >= 10_000n * WRF_UNITS_PER_COIN) {
      this.awardAchievement(userAddress, 'whale_voter');
    }

    // Early bird achievement (vote within first hour)
    // This would require proposal creation timestamp in real implementation

    // Midnight voter achievement
    const hour = new Date(timestamp).getUTCHours();
    if (hour >= 0 && hour < 6) {
      this.awardAchievement(userAddress, 'midnight_governor');
    }
  }

  checkProposalAchievements(userAddress) {
    const stats = this.getUserStats(userAddress);

    if (stats.totalProposals === 1) {
      this.awardAchievement(userAddress, 'first_proposal');
    }

    if (stats.totalProposals === 10) {
      this.awardAchievement(userAddress, 'prolific_proposer');
    }
  }

  checkDelegationAchievements(userAddress) {
    const stats = this.getUserStats(userAddress);

    if (stats.totalDelegatedPower >= 1000) {
      this.awardAchievement(userAddress, 'trusted_delegate');
    }

    if (stats.uniqueDelegators >= 50) {
      this.awardAchievement(userAddress, 'delegation_master');
    }
  }

  updateActivityStreak(userAddress, timestamp) {
    const stats = this.getUserStats(userAddress);
    const today = new Date(timestamp).toDateString();

    if (!stats.lastActivityDate) {
      stats.activityStreak = 1;
      stats.lastActivityDate = today;
    } else {
      const lastDate = new Date(stats.lastActivityDate);
      const currentDate = new Date(today);
      const daysDiff = Math.floor(
        (currentDate - lastDate) / (1000 * 60 * 60 * 24)
      );

      if (daysDiff === 1) {
        stats.activityStreak++;
      } else if (daysDiff > 1) {
        stats.activityStreak = 1;
      }

      stats.lastActivityDate = today;
    }

    // Check streak achievements
    if (stats.activityStreak === 7) {
      this.awardAchievement(userAddress, 'streak_7');
    } else if (stats.activityStreak === 30) {
      this.awardAchievement(userAddress, 'streak_30');
    }
  }

  // Core gamification methods
  awardAchievement(userAddress, achievementId) {
    const stats = this.getUserStats(userAddress);

    if (!stats.achievements.includes(achievementId)) {
      stats.achievements.push(achievementId);
      const achievement = this.achievements[achievementId];

      if (achievement) {
        this.awardPoints(userAddress, achievement.points);
        appLogger.info('Achievement unlocked', { achievementName: achievement.name, userAddress });

        this.emit('achievement_unlocked', {
          userAddress,
          achievement,
          totalAchievements: stats.achievements.length,
        });
      }
    }
  }

  awardPoints(userAddress, points) {
    const stats = this.getUserStats(userAddress);
    const oldLevel = this.getUserLevel(userAddress);

    stats.totalPoints += points;

    const newLevel = this.getUserLevel(userAddress);
    if (newLevel.level > oldLevel.level) {
      this.emit('level_up', {
        userAddress,
        oldLevel,
        newLevel,
        totalPoints: stats.totalPoints,
      });
      appLogger.info('Level up', { userAddress, newLevelName: newLevel.name, newLevel: newLevel.level });
    }
  }

  checkAchievement(userAddress, achievementId) {
    const achievement = this.achievements[achievementId];
    if (!achievement) return false;

    const stats = this.getUserStats(userAddress);

    if (stats.achievements.includes(achievementId)) {
      return false; // Already earned
    }

    // Check achievement requirements
    let requirementMet = false;

    if (achievement.requirement) {
      const req = achievement.requirement;
      switch (req.type) {
        case 'total_votes':
          requirementMet = stats.totalVotes >= req.count;
          break;
        case 'consecutive_votes':
          requirementMet = stats.consecutiveVotes >= req.count;
          break;
        case 'total_proposals':
          requirementMet = stats.totalProposals >= req.count;
          break;
      }
    } else {
      requirementMet = true; // No specific requirement
    }

    if (requirementMet) {
      this.awardAchievement(userAddress, achievementId);
      return true;
    }

    return false;
  }

  // User data methods
  getUserStats(userAddress) {
    if (!this.userStats.has(userAddress)) {
      this.userStats.set(userAddress, {
        totalPoints: 0,
        totalVotes: 0,
        totalProposals: 0,
        successfulProposals: 0,
        consecutiveVotes: 0,
        activityStreak: 0,
        achievements: [],
        delegators: new Map(),
        uniqueDelegators: 0,
        totalDelegatedPower: 0,
        totalVotingPower: 0,
        proposalsCreated: [],
        lastVoteTime: null,
        lastActivityDate: null,
        lastProposalVoted: null,
        joinedAt: Date.now(),
      });
    }
    return this.userStats.get(userAddress);
  }

  getUserLevel(userAddress) {
    const stats = this.getUserStats(userAddress);
    return (
      this.levelThresholds.find(
        level =>
          stats.totalPoints >= level.minPoints &&
          stats.totalPoints <= level.maxPoints
      ) || this.levelThresholds[0]
    );
  }

  getUserProfile(userAddress) {
    const stats = this.getUserStats(userAddress);
    const level = this.getUserLevel(userAddress);
    const nextLevel = this.levelThresholds.find(
      l => l.level === level.level + 1
    );

    const unlockedAchievements = stats.achievements.map(
      id => this.achievements[id]
    );
    const availableAchievements = Object.values(this.achievements).filter(
      a => !stats.achievements.includes(a.id)
    );

    return {
      userAddress,
      level: {
        current: level,
        next: nextLevel,
        progress: nextLevel
          ? (
              ((stats.totalPoints - level.minPoints) /
                (nextLevel.minPoints - level.minPoints)) *
              100
            ).toFixed(1)
          : 100,
      },
      statistics: {
        totalPoints: stats.totalPoints,
        totalVotes: stats.totalVotes,
        totalProposals: stats.totalProposals,
        successfulProposals: stats.successfulProposals,
        activityStreak: stats.activityStreak,
        uniqueDelegators: stats.uniqueDelegators,
        participationScore: this.calculateParticipationScore(userAddress),
      },
      achievements: {
        unlocked: unlockedAchievements,
        available: availableAchievements.slice(0, 5), // Show next 5 available
        total: unlockedAchievements.length,
        categories: this.getAchievementsByCategory(stats.achievements),
      },
      streaks: {
        voting: stats.consecutiveVotes,
        activity: stats.activityStreak,
        bonusMultiplier: this.getStreakBonus(userAddress),
      },
    };
  }

  calculateParticipationScore(userAddress) {
    const stats = this.getUserStats(userAddress);
    const daysSinceJoin = Math.floor(
      (Date.now() - stats.joinedAt) / (1000 * 60 * 60 * 24)
    );

    if (daysSinceJoin === 0) return 100;

    const votesPerDay = stats.totalVotes / daysSinceJoin;
    const proposalsPerMonth = (stats.totalProposals / daysSinceJoin) * 30;

    return Math.min(
      100,
      (votesPerDay * 30 + proposalsPerMonth * 10 + stats.activityStreak) * 2
    );
  }

  getAchievementsByCategory(unlockedAchievements) {
    const categories = {};

    unlockedAchievements.forEach(achievementId => {
      const achievement = this.achievements[achievementId];
      if (achievement) {
        if (!categories[achievement.category]) {
          categories[achievement.category] = 0;
        }
        categories[achievement.category]++;
      }
    });

    return categories;
  }

  getStreakBonus(userAddress) {
    const stats = this.getUserStats(userAddress);
    if (stats.activityStreak >= 30) return 2.0;
    if (stats.activityStreak >= 14) return 1.5;
    if (stats.activityStreak >= 7) return 1.25;
    return 1.0;
  }

  getLeaderboard(category = 'points', limit = 10) {
    const users = Array.from(this.userStats.entries()).map(
      ([address, stats]) => ({
        address,
        ...stats,
        level: this.getUserLevel(address),
        participationScore: this.calculateParticipationScore(address),
      })
    );

    let sortKey;
    switch (category) {
      case 'votes':
        sortKey = 'totalVotes';
        break;
      case 'proposals':
        sortKey = 'totalProposals';
        break;
      case 'streak':
        sortKey = 'activityStreak';
        break;
      case 'achievements':
        sortKey = user => user.achievements.length;
        break;
      case 'participation':
        sortKey = 'participationScore';
        break;
      default:
        sortKey = 'totalPoints';
    }

    if (typeof sortKey === 'function') {
      users.sort((a, b) => sortKey(b) - sortKey(a));
    } else {
      users.sort((a, b) => b[sortKey] - a[sortKey]);
    }

    return users.slice(0, limit).map((user, index) => ({
      rank: index + 1,
      address: user.address,
      level: user.level,
      score: typeof sortKey === 'function' ? sortKey(user) : user[sortKey],
      totalPoints: user.totalPoints,
      achievements: user.achievements.length,
    }));
  }

  // Utility methods
  isConsecutiveProposal(lastProposalId, currentProposalId) {
    // In a real implementation, this would check if proposals are consecutive
    // For now, we'll assume they are if they're different
    return lastProposalId !== currentProposalId;
  }
}

// Create singleton instance
const gamificationService = new GamificationService();

// Simulate some test data
// #977 ratchet: unref'd — created at import, must not hold the loop open.
const importTimeTimer6 = setTimeout(() => {
  // Test user activities
  const testUsers = [
    '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
    '0x856f48C9247d7b8e3D4B8F5e2C9A7b8E4C5F1234',
    '0x123f48C9247d7b8e3D4B8F5e2C9A7b8E4C5F5678',
  ];

  testUsers.forEach((user, index) => {
    // Simulate voting history
    for (let i = 0; i < (index + 1) * 15; i++) {
      gamificationService.recordVote(user, `prop_${i}`, `${1000 + i * 50} WRF`);
    }

    // Simulate proposal creation
    for (let i = 0; i < (index + 1) * 2; i++) {
      gamificationService.recordProposalCreation(
        user,
        `user_prop_${user.slice(-4)}_${i}`
      );
    }

    // Simulate delegations
    gamificationService.recordDelegation(
      user,
      `delegator_${index}`,
      500 + index * 1000
    );
  });

  appLogger.info('Gamification system initialized with test data');
}, 1000);
importTimeTimer6.unref();

module.exports = {
  GamificationService,
  gamificationService,
};
