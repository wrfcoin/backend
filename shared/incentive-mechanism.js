/**
 * Wrfcoin Incentive Mechanism
 *
 * This module defines the reward distribution and slashing mechanisms for Wrfcoin's
 * specialized node roles. It ensures proper economic incentives for all participants.
 */

// Define reward types
const RewardType = {
  BLOCK_PRODUCTION: 'block_production', // Reward for producing a valid block
  WEATHER_DATA_SUBMISSION: 'weather_data', // Reward for submitting weather data
  FORECAST_COMPUTATION: 'forecast_computation', // Reward for computing forecasts
  STORAGE_PROVISION: 'storage_provision', // Reward for storing data
  DATA_VALIDATION: 'data_validation', // Reward for validating data
  NETWORK_RELAY: 'network_relay', // Reward for relaying transactions
  GOVERNANCE_PARTICIPATION: 'governance', // Reward for governance participation
  CRITICAL_REGION_COVERAGE: 'critical_region', // Bonus for covering critical regions
  LONG_TERM_COMMITMENT: 'commitment', // Bonus for long-term participation
  QUALITY_BONUS: 'quality', // Bonus for high-quality contributions
};

// Define slashing reasons
const SlashingReason = {
  INVALID_BLOCK: 'invalid_block', // Producing an invalid block
  DOWNTIME: 'downtime', // Excessive downtime
  MALICIOUS_BEHAVIOR: 'malicious_behavior', // Detected malicious behavior
  INCORRECT_DATA: 'incorrect_data', // Submitting incorrect data
  FAILED_VERIFICATION: 'failed_verification', // Failed verification check
  DUPLICATE_SUBMISSION: 'duplicate_submission', // Duplicate data submission
  SPAM: 'spam', // Spamming the network
  LATE_SUBMISSION: 'late_submission', // Very late data submission
  STORAGE_UNAVAILABLE: 'storage_unavailable', // Promised storage unavailable
  CONSENSUS_VIOLATION: 'consensus_violation', // Violating consensus rules
};

// Base reward values (in WRF tokens)
const BaseRewards = {
  [RewardType.BLOCK_PRODUCTION]: 5.0, // Base reward for block production
  [RewardType.WEATHER_DATA_SUBMISSION]: 1.0, // Base reward for weather data
  [RewardType.FORECAST_COMPUTATION]: 3.0, // Base reward for computing forecasts
  [RewardType.STORAGE_PROVISION]: 0.5, // Base reward for storing data (per GB/day)
  [RewardType.DATA_VALIDATION]: 0.25, // Base reward for validating data
  [RewardType.NETWORK_RELAY]: 0.1, // Base reward for relaying transactions
  [RewardType.GOVERNANCE_PARTICIPATION]: 2.0, // Base reward for governance participation
  [RewardType.CRITICAL_REGION_COVERAGE]: 2.0, // Bonus for covering critical regions
  [RewardType.LONG_TERM_COMMITMENT]: 1.0, // Bonus for long-term participation
  [RewardType.QUALITY_BONUS]: 1.5, // Bonus for high-quality contributions
};

// Base slashing percentages (of staked amount)
const BaseSlashingPercentages = {
  [SlashingReason.INVALID_BLOCK]: 5.0, // 5% slash for invalid block
  [SlashingReason.DOWNTIME]: 1.0, // 1% slash for excessive downtime
  [SlashingReason.MALICIOUS_BEHAVIOR]: 20.0, // 20% slash for malicious behavior
  [SlashingReason.INCORRECT_DATA]: 2.0, // 2% slash for incorrect data
  [SlashingReason.FAILED_VERIFICATION]: 3.0, // 3% slash for failed verification
  [SlashingReason.DUPLICATE_SUBMISSION]: 1.0, // 1% slash for duplicate submission
  [SlashingReason.SPAM]: 2.0, // 2% slash for spamming
  [SlashingReason.LATE_SUBMISSION]: 0.5, // 0.5% slash for late submission
  [SlashingReason.STORAGE_UNAVAILABLE]: 3.0, // 3% slash for unavailable storage
  [SlashingReason.CONSENSUS_VIOLATION]: 10.0, // 10% slash for consensus violation
};

// Node type specific multipliers
const NodeTypeMultipliers = {
  VALIDATOR: {
    [RewardType.BLOCK_PRODUCTION]: 1.0,
    [RewardType.DATA_VALIDATION]: 1.2,
    [RewardType.GOVERNANCE_PARTICIPATION]: 1.5,
  },
  WEATHER_STATION: {
    [RewardType.WEATHER_DATA_SUBMISSION]: 1.0,
    [RewardType.CRITICAL_REGION_COVERAGE]: 2.0,
    [RewardType.QUALITY_BONUS]: 1.5,
  },
  FORECAST_COMPUTE: {
    [RewardType.FORECAST_COMPUTATION]: 1.0,
    [RewardType.DATA_VALIDATION]: 0.8,
    [RewardType.QUALITY_BONUS]: 1.8,
  },
  STORAGE_KEEPER: {
    [RewardType.STORAGE_PROVISION]: 1.0,
    [RewardType.DATA_VALIDATION]: 0.5,
    [RewardType.LONG_TERM_COMMITMENT]: 2.0,
  },
  LIGHT_CLIENT: {
    [RewardType.NETWORK_RELAY]: 1.0,
    [RewardType.DATA_VALIDATION]: 0.2,
  },
};

// Reputation thresholds for rewards
const ReputationThresholds = {
  MINIMUM_REPUTATION: 50, // Minimum reputation to receive rewards
  REDUCED_REWARDS: 70, // Threshold for reduced rewards
  STANDARD_REWARDS: 85, // Threshold for standard rewards
  ENHANCED_REWARDS: 95, // Threshold for enhanced rewards
};

// Reputation impact of slashing
const ReputationImpact = {
  [SlashingReason.INVALID_BLOCK]: -20,
  [SlashingReason.DOWNTIME]: -5,
  [SlashingReason.MALICIOUS_BEHAVIOR]: -50,
  [SlashingReason.INCORRECT_DATA]: -15,
  [SlashingReason.FAILED_VERIFICATION]: -10,
  [SlashingReason.DUPLICATE_SUBMISSION]: -5,
  [SlashingReason.SPAM]: -10,
  [SlashingReason.LATE_SUBMISSION]: -3,
  [SlashingReason.STORAGE_UNAVAILABLE]: -15,
  [SlashingReason.CONSENSUS_VIOLATION]: -30,
};

// Proximity-based reward multiplier tiers
const ProximityMultiplierTiers = {
  TIER_1: { maxDistance: 5, multiplier: 2.0 }, // 0-5 km: 2x rewards
  TIER_2: { maxDistance: 15, multiplier: 1.5 }, // 5-15 km: 1.5x rewards
  TIER_3: { maxDistance: 30, multiplier: 1.2 }, // 15-30 km: 1.2x rewards
  TIER_4: { maxDistance: 50, multiplier: 1.0 }, // 30-50 km: standard rewards
  TIER_5: { maxDistance: 100, multiplier: 0.8 }, // 50-100 km: 0.8x rewards
  DEFAULT: { multiplier: 0.5 }, // >100 km: 0.5x rewards
};

// Regional criticality levels and multipliers
const RegionalCriticalityLevels = {
  CRITICAL: { multiplier: 3.0 }, // Critical data gaps: 3x rewards
  HIGH: { multiplier: 2.0 }, // High importance: 2x rewards
  MEDIUM: { multiplier: 1.5 }, // Medium importance: 1.5x rewards
  STANDARD: { multiplier: 1.0 }, // Standard importance: normal rewards
  LOW: { multiplier: 0.8 }, // Low importance: 0.8x rewards
};

// Time-based factors
const TimeFactors = {
  CONSISTENCY_BONUS_THRESHOLD_DAYS: 30, // Days of consistent participation for bonus
  CONSISTENCY_BONUS_MULTIPLIER: 1.2, // Multiplier for consistent participation
  HISTORICAL_PERFORMANCE_WINDOW_DAYS: 90, // Days to consider for historical performance
  DOWNTIME_TOLERANCE_HOURS: 24, // Hours of downtime before penalties
  PEAK_DEMAND_MULTIPLIER: 1.5, // Multiplier during peak demand periods
};

// Data quality tiers and multipliers
const DataQualityTiers = {
  EXCELLENT: { multiplier: 1.5, minAccuracy: 0.95 }, // 95%+ accuracy: 1.5x rewards
  GOOD: { multiplier: 1.2, minAccuracy: 0.9 }, // 90-95% accuracy: 1.2x rewards
  STANDARD: { multiplier: 1.0, minAccuracy: 0.85 }, // 85-90% accuracy: normal rewards
  SUBPAR: { multiplier: 0.7, minAccuracy: 0.75 }, // 75-85% accuracy: 0.7x rewards
  POOR: { multiplier: 0.4, minAccuracy: 0.6 }, // 60-75% accuracy: 0.4x rewards
  // Below 60% accuracy may result in slashing
};

// Slashing severity levels
const SlashingSeverityLevels = {
  MINOR: { multiplier: 0.5 }, // Minor violations: 0.5x base slashing
  STANDARD: { multiplier: 1.0 }, // Standard violations: normal slashing
  SEVERE: { multiplier: 2.0 }, // Severe violations: 2x base slashing
  CRITICAL: { multiplier: 3.0 }, // Critical violations: 3x base slashing
};

/**
 * Incentive Mechanism class that handles reward calculation and slashing
 */
class IncentiveMechanism {
  constructor() {
    this.baseRewards = { ...BaseRewards };
    this.baseSlashingPercentages = { ...BaseSlashingPercentages };
    this.nodeTypeMultipliers = { ...NodeTypeMultipliers };
    this.reputationThresholds = { ...ReputationThresholds };
    this.reputationImpact = { ...ReputationImpact };
    this.proximityMultiplierTiers = { ...ProximityMultiplierTiers };
    this.regionalCriticalityLevels = { ...RegionalCriticalityLevels };
    this.timeFactors = { ...TimeFactors };
    this.dataQualityTiers = { ...DataQualityTiers };
    this.slashingSeverityLevels = { ...SlashingSeverityLevels };

    // Keep track of recent rewards and slashing events for analytics
    this.recentRewards = [];
    this.recentSlashings = [];

    // Cache for frequently accessed calculations
    this.calculationCache = new Map();

    // Store governance-approved parameter updates
    this.pendingParameterUpdates = [];
  }

  /**
   * Calculate reward for a specific node and activity
   *
   * @param {Object} params - Parameters for reward calculation
   * @param {string} params.nodeType - Type of node (VALIDATOR, WEATHER_STATION, etc.)
   * @param {string} params.rewardType - Type of reward (from RewardType enum)
   * @param {number} params.reputation - Node's reputation score (0-100)
   * @param {Object} [params.additionalFactors] - Additional factors for calculation
   * @returns {Object} Calculated reward information
   */
  calculateReward(params) {
    const { nodeType, rewardType, reputation, additionalFactors = {} } = params;

    // Check if node meets minimum reputation requirement
    if (reputation < this.reputationThresholds.MINIMUM_REPUTATION) {
      return {
        amount: 0,
        reason: 'Reputation below minimum threshold',
        eligible: false,
      };
    }

    // Get base reward for the activity
    let baseReward = this.baseRewards[rewardType] || 0;
    if (baseReward === 0) {
      return {
        amount: 0,
        reason: 'Invalid reward type',
        eligible: false,
      };
    }

    // Apply node type multiplier if applicable
    const nodeMultipliers = this.nodeTypeMultipliers[nodeType] || {};
    const nodeMultiplier = nodeMultipliers[rewardType] || 1.0;
    baseReward *= nodeMultiplier;

    // Apply reputation-based multiplier
    let reputationMultiplier = 1.0;
    if (reputation >= this.reputationThresholds.ENHANCED_REWARDS) {
      reputationMultiplier = 1.3; // 30% bonus for excellent reputation
    } else if (reputation >= this.reputationThresholds.STANDARD_REWARDS) {
      reputationMultiplier = 1.0; // Standard rewards
    } else if (reputation >= this.reputationThresholds.REDUCED_REWARDS) {
      reputationMultiplier = 0.8; // 20% reduction for lower reputation
    } else {
      reputationMultiplier = 0.5; // 50% reduction for minimum acceptable reputation
    }

    // Apply multipliers from additional factors
    let extraMultiplier = 1.0;
    const multipliers = [];

    // Apply proximity-based multiplier if applicable
    if (
      additionalFactors.distance !== undefined &&
      (rewardType === RewardType.WEATHER_DATA_SUBMISSION ||
        rewardType === RewardType.FORECAST_COMPUTATION)
    ) {
      const distance = additionalFactors.distance;
      let proximityMultiplier =
        this.proximityMultiplierTiers.DEFAULT.multiplier;

      for (const tier of Object.values(this.proximityMultiplierTiers)) {
        if (tier.maxDistance && distance <= tier.maxDistance) {
          proximityMultiplier = tier.multiplier;
          break;
        }
      }

      extraMultiplier *= proximityMultiplier;
      multipliers.push({
        type: 'proximity',
        value: proximityMultiplier,
        description: `Distance of ${distance}km`,
      });
    }

    // Apply regional criticality multiplier if applicable
    if (additionalFactors.regionalCriticality) {
      const criticalityLevel = additionalFactors.regionalCriticality;
      const criticalityMultiplier =
        this.regionalCriticalityLevels[criticalityLevel]?.multiplier ||
        this.regionalCriticalityLevels.STANDARD.multiplier;

      extraMultiplier *= criticalityMultiplier;
      multipliers.push({
        type: 'criticality',
        value: criticalityMultiplier,
        description: `${criticalityLevel} region criticality`,
      });
    }

    // Apply data quality multiplier if applicable
    if (
      additionalFactors.dataAccuracy !== undefined &&
      (rewardType === RewardType.WEATHER_DATA_SUBMISSION ||
        rewardType === RewardType.FORECAST_COMPUTATION)
    ) {
      const accuracy = additionalFactors.dataAccuracy;
      let qualityMultiplier = 0; // Default to zero for very poor quality

      for (const [tier, config] of Object.entries(this.dataQualityTiers)) {
        if (accuracy >= config.minAccuracy) {
          qualityMultiplier = config.multiplier;
          break;
        }
      }

      extraMultiplier *= qualityMultiplier;
      multipliers.push({
        type: 'quality',
        value: qualityMultiplier,
        description: `${(accuracy * 100).toFixed(1)}% data accuracy`,
      });
    }

    // Apply consistency bonus if applicable
    if (
      additionalFactors.consistentDays &&
      additionalFactors.consistentDays >=
        this.timeFactors.CONSISTENCY_BONUS_THRESHOLD_DAYS
    ) {
      const consistencyMultiplier =
        this.timeFactors.CONSISTENCY_BONUS_MULTIPLIER;
      extraMultiplier *= consistencyMultiplier;
      multipliers.push({
        type: 'consistency',
        value: consistencyMultiplier,
        description: `${additionalFactors.consistentDays} days of consistent participation`,
      });
    }

    // Apply peak demand bonus if applicable
    if (additionalFactors.isPeakDemand) {
      const peakMultiplier = this.timeFactors.PEAK_DEMAND_MULTIPLIER;
      extraMultiplier *= peakMultiplier;
      multipliers.push({
        type: 'peak_demand',
        value: peakMultiplier,
        description: 'Peak demand period',
      });
    }

    // Apply stake size multiplier if applicable
    if (additionalFactors.stakeAmount && additionalFactors.networkMedianStake) {
      const stakeRatio =
        additionalFactors.stakeAmount / additionalFactors.networkMedianStake;
      // Cap the stake multiplier at 2.0 (200%)
      const stakeMultiplier = Math.min(Math.sqrt(stakeRatio), 2.0);
      extraMultiplier *= stakeMultiplier;
      multipliers.push({
        type: 'stake_size',
        value: stakeMultiplier,
        description: `Stake ratio: ${stakeRatio.toFixed(2)}`,
      });
    }

    // Calculate final reward
    const finalReward = baseReward * reputationMultiplier * extraMultiplier;

    // Record reward for analytics
    this.recentRewards.push({
      nodeType,
      rewardType,
      baseReward,
      finalReward,
      reputationMultiplier,
      extraMultiplier,
      timestamp: new Date().toISOString(),
    });

    // Keep recentRewards limited to last 1000 entries
    if (this.recentRewards.length > 1000) {
      this.recentRewards.shift();
    }

    return {
      amount: finalReward,
      baseReward,
      reputationMultiplier,
      extraMultipliers: multipliers,
      reason: `${rewardType} reward for ${nodeType}`,
      eligible: true,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Calculate slashing amount for a specific violation
   *
   * @param {Object} params - Parameters for slashing calculation
   * @param {string} params.nodeType - Type of node (VALIDATOR, WEATHER_STATION, etc.)
   * @param {string} params.slashingReason - Reason for slashing (from SlashingReason enum)
   * @param {number} params.stakeAmount - Amount of stake the node has
   * @param {number} params.reputation - Node's reputation score (0-100)
   * @param {Object} [params.additionalFactors] - Additional factors for calculation
   * @returns {Object} Calculated slashing information
   */
  calculateSlashing(params) {
    const {
      nodeType,
      slashingReason,
      stakeAmount,
      reputation,
      additionalFactors = {},
    } = params;

    // Get base slashing percentage for the violation
    const basePercentage = this.baseSlashingPercentages[slashingReason];
    if (basePercentage === undefined) {
      return {
        amount: 0,
        percentage: 0,
        reputationImpact: 0,
        reason: 'Invalid slashing reason',
        applied: false,
      };
    }

    // Determine severity level multiplier
    let severityMultiplier = this.slashingSeverityLevels.STANDARD.multiplier;
    let severityLevel = 'STANDARD';

    if (additionalFactors.severity) {
      severityLevel = additionalFactors.severity;
      severityMultiplier =
        this.slashingSeverityLevels[severityLevel]?.multiplier ||
        this.slashingSeverityLevels.STANDARD.multiplier;
    }

    // Apply history-based multiplier
    let historyMultiplier = 1.0;
    if (additionalFactors.previousViolations) {
      // Exponential increase for repeat offenders
      historyMultiplier = Math.pow(
        1.5,
        Math.min(additionalFactors.previousViolations, 5)
      );
    }

    // Apply reputation-based adjustment
    // Higher reputation nodes face stricter penalties as they're expected to know better
    let reputationMultiplier = 1.0;
    if (reputation >= this.reputationThresholds.ENHANCED_REWARDS) {
      reputationMultiplier = 1.2; // 20% higher slashing for highest reputation nodes
    } else if (reputation <= this.reputationThresholds.REDUCED_REWARDS) {
      reputationMultiplier = 0.8; // 20% lower slashing for lower reputation nodes
    }

    // Calculate final slashing percentage
    const finalPercentage =
      basePercentage *
      severityMultiplier *
      historyMultiplier *
      reputationMultiplier;

    // Cap the maximum slashing at 100% of stake
    const cappedPercentage = Math.min(finalPercentage, 100);

    // Calculate absolute amount
    const slashAmount = (stakeAmount * cappedPercentage) / 100;

    // Calculate reputation impact
    const baseReputationImpact = this.reputationImpact[slashingReason] || 0;
    const finalReputationImpact = baseReputationImpact * severityMultiplier;

    // Record slashing for analytics
    this.recentSlashings.push({
      nodeType,
      slashingReason,
      stakeAmount,
      slashAmount,
      percentage: cappedPercentage,
      reputationImpact: finalReputationImpact,
      timestamp: new Date().toISOString(),
    });

    // Keep recentSlashings limited to last 1000 entries
    if (this.recentSlashings.length > 1000) {
      this.recentSlashings.shift();
    }

    return {
      amount: slashAmount,
      percentage: cappedPercentage,
      reputationImpact: finalReputationImpact,
      basePercentage,
      severityMultiplier,
      historyMultiplier,
      reputationMultiplier,
      reason: `${slashingReason} violation by ${nodeType}`,
      severity: severityLevel,
      applied: true,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Calculate reward for a validator node
   *
   * @param {Object} params - Parameters for reward calculation
   * @returns {Object} Calculated reward information
   */
  calculateValidatorReward(params) {
    const validatorParams = {
      ...params,
      nodeType: 'VALIDATOR',
    };
    return this.calculateReward(validatorParams);
  }

  /**
   * Calculate reward for a weather station node
   *
   * @param {Object} params - Parameters for reward calculation
   * @returns {Object} Calculated reward information
   */
  calculateWeatherStationReward(params) {
    const weatherStationParams = {
      ...params,
      nodeType: 'WEATHER_STATION',
    };
    return this.calculateReward(weatherStationParams);
  }

  /**
   * Calculate reward for a forecast compute node
   *
   * @param {Object} params - Parameters for reward calculation
   * @returns {Object} Calculated reward information
   */
  calculateForecastComputeReward(params) {
    const forecastComputeParams = {
      ...params,
      nodeType: 'FORECAST_COMPUTE',
    };
    return this.calculateReward(forecastComputeParams);
  }

  /**
   * Calculate reward for a storage keeper node
   *
   * @param {Object} params - Parameters for reward calculation
   * @returns {Object} Calculated reward information
   */
  calculateStorageKeeperReward(params) {
    const storageKeeperParams = {
      ...params,
      nodeType: 'STORAGE_KEEPER',
    };
    return this.calculateReward(storageKeeperParams);
  }

  /**
   * Calculate reward for a light client node
   *
   * @param {Object} params - Parameters for reward calculation
   * @returns {Object} Calculated reward information
   */
  calculateLightClientReward(params) {
    const lightClientParams = {
      ...params,
      nodeType: 'LIGHT_CLIENT',
    };
    return this.calculateReward(lightClientParams);
  }

  /**
   * Calculate slashing for a validator node
   *
   * @param {Object} params - Parameters for slashing calculation
   * @returns {Object} Calculated slashing information
   */
  calculateValidatorSlashing(params) {
    const validatorParams = {
      ...params,
      nodeType: 'VALIDATOR',
    };
    return this.calculateSlashing(validatorParams);
  }

  /**
   * Calculate slashing for a weather station node
   *
   * @param {Object} params - Parameters for slashing calculation
   * @returns {Object} Calculated slashing information
   */
  calculateWeatherStationSlashing(params) {
    const weatherStationParams = {
      ...params,
      nodeType: 'WEATHER_STATION',
    };
    return this.calculateSlashing(weatherStationParams);
  }

  /**
   * Calculate slashing for a forecast compute node
   *
   * @param {Object} params - Parameters for slashing calculation
   * @returns {Object} Calculated slashing information
   */
  calculateForecastComputeSlashing(params) {
    const forecastComputeParams = {
      ...params,
      nodeType: 'FORECAST_COMPUTE',
    };
    return this.calculateSlashing(forecastComputeParams);
  }

  /**
   * Calculate slashing for a storage keeper node
   *
   * @param {Object} params - Parameters for slashing calculation
   * @returns {Object} Calculated slashing information
   */
  calculateStorageKeeperSlashing(params) {
    const storageKeeperParams = {
      ...params,
      nodeType: 'STORAGE_KEEPER',
    };
    return this.calculateSlashing(storageKeeperParams);
  }

  /**
   * Get statistics about recent rewards and slashings
   *
   * @returns {Object} Statistics about recent rewards and slashings
   */
  getStatistics() {
    // Calculate statistics for rewards
    const rewardStats = {
      total: 0,
      count: this.recentRewards.length,
      byNodeType: {},
      byRewardType: {},
    };

    for (const reward of this.recentRewards) {
      rewardStats.total += reward.finalReward;

      // Count by node type
      rewardStats.byNodeType[reward.nodeType] = rewardStats.byNodeType[
        reward.nodeType
      ] || {
        total: 0,
        count: 0,
      };
      rewardStats.byNodeType[reward.nodeType].total += reward.finalReward;
      rewardStats.byNodeType[reward.nodeType].count += 1;

      // Count by reward type
      rewardStats.byRewardType[reward.rewardType] = rewardStats.byRewardType[
        reward.rewardType
      ] || {
        total: 0,
        count: 0,
      };
      rewardStats.byRewardType[reward.rewardType].total += reward.finalReward;
      rewardStats.byRewardType[reward.rewardType].count += 1;
    }

    // Calculate statistics for slashings
    const slashingStats = {
      total: 0,
      count: this.recentSlashings.length,
      byNodeType: {},
      byReason: {},
    };

    for (const slashing of this.recentSlashings) {
      slashingStats.total += slashing.slashAmount;

      // Count by node type
      slashingStats.byNodeType[slashing.nodeType] = slashingStats.byNodeType[
        slashing.nodeType
      ] || {
        total: 0,
        count: 0,
      };
      slashingStats.byNodeType[slashing.nodeType].total += slashing.slashAmount;
      slashingStats.byNodeType[slashing.nodeType].count += 1;

      // Count by reason
      slashingStats.byReason[slashing.slashingReason] = slashingStats.byReason[
        slashing.slashingReason
      ] || {
        total: 0,
        count: 0,
      };
      slashingStats.byReason[slashing.slashingReason].total +=
        slashing.slashAmount;
      slashingStats.byReason[slashing.slashingReason].count += 1;
    }

    return {
      rewards: rewardStats,
      slashings: slashingStats,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Update parameters via governance proposals
   *
   * @param {Object} updates - Parameter updates to apply
   * @returns {boolean} Success status
   */
  updateParameters(updates) {
    if (!updates || typeof updates !== 'object') {
      return false;
    }

    // Validate and apply updates
    if (updates.baseRewards && typeof updates.baseRewards === 'object') {
      for (const [key, value] of Object.entries(updates.baseRewards)) {
        if (
          this.baseRewards[key] !== undefined &&
          typeof value === 'number' &&
          value >= 0
        ) {
          this.baseRewards[key] = value;
        }
      }
    }

    if (
      updates.baseSlashingPercentages &&
      typeof updates.baseSlashingPercentages === 'object'
    ) {
      for (const [key, value] of Object.entries(
        updates.baseSlashingPercentages
      )) {
        if (
          this.baseSlashingPercentages[key] !== undefined &&
          typeof value === 'number' &&
          value >= 0 &&
          value <= 100
        ) {
          this.baseSlashingPercentages[key] = value;
        }
      }
    }

    // Record parameter update
    this.pendingParameterUpdates.push({
      updates,
      timestamp: new Date().toISOString(),
      applied: true,
    });

    return true;
  }

  /**
   * Calculate proximity-based reward multiplier
   *
   * @param {number} distance - Distance in kilometers
   * @returns {number} The multiplier value
   */
  getProximityMultiplier(distance) {
    if (typeof distance !== 'number' || distance < 0) {
      return this.proximityMultiplierTiers.DEFAULT.multiplier;
    }

    for (const tier of Object.values(this.proximityMultiplierTiers)) {
      if (tier.maxDistance && distance <= tier.maxDistance) {
        return tier.multiplier;
      }
    }

    return this.proximityMultiplierTiers.DEFAULT.multiplier;
  }

  /**
   * Get regional criticality multiplier
   *
   * @param {string} criticalityLevel - Criticality level (CRITICAL, HIGH, etc.)
   * @returns {number} The multiplier value
   */
  getRegionalCriticalityMultiplier(criticalityLevel) {
    return (
      this.regionalCriticalityLevels[criticalityLevel]?.multiplier ||
      this.regionalCriticalityLevels.STANDARD.multiplier
    );
  }

  /**
   * Get data quality multiplier based on accuracy
   *
   * @param {number} accuracy - Accuracy value (0-1)
   * @returns {number} The multiplier value
   */
  getDataQualityMultiplier(accuracy) {
    if (typeof accuracy !== 'number' || accuracy < 0 || accuracy > 1) {
      return 0;
    }

    for (const [tier, config] of Object.entries(this.dataQualityTiers)) {
      if (accuracy >= config.minAccuracy) {
        return config.multiplier;
      }
    }

    return 0; // Very poor accuracy
  }
}

module.exports = {
  RewardType,
  SlashingReason,
  BaseRewards,
  BaseSlashingPercentages,
  NodeTypeMultipliers,
  ReputationThresholds,
  ReputationImpact,
  ProximityMultiplierTiers,
  RegionalCriticalityLevels,
  TimeFactors,
  DataQualityTiers,
  SlashingSeverityLevels,
  IncentiveMechanism,
};
