/**
 * Comprehensive unit tests for the Incentive Mechanism
 * Tests cover all reward calculations, slashing mechanisms, and edge cases
 */

const {
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
} = require('../../shared/incentive-mechanism');

describe('IncentiveMechanism', () => {
  let incentiveMechanism;

  beforeEach(() => {
    incentiveMechanism = new IncentiveMechanism();
  });

  describe('constructor', () => {
    test('should initialize with all required properties', () => {
      expect(incentiveMechanism.baseRewards).toEqual(BaseRewards);
      expect(incentiveMechanism.baseSlashingPercentages).toEqual(
        BaseSlashingPercentages
      );
      expect(incentiveMechanism.nodeTypeMultipliers).toEqual(
        NodeTypeMultipliers
      );
      expect(incentiveMechanism.reputationThresholds).toEqual(
        ReputationThresholds
      );
      expect(incentiveMechanism.reputationImpact).toEqual(ReputationImpact);
      expect(incentiveMechanism.proximityMultiplierTiers).toEqual(
        ProximityMultiplierTiers
      );
      expect(incentiveMechanism.regionalCriticalityLevels).toEqual(
        RegionalCriticalityLevels
      );
      expect(incentiveMechanism.timeFactors).toEqual(TimeFactors);
      expect(incentiveMechanism.dataQualityTiers).toEqual(DataQualityTiers);
      expect(incentiveMechanism.slashingSeverityLevels).toEqual(
        SlashingSeverityLevels
      );
    });

    test('should initialize empty arrays for recent events', () => {
      expect(incentiveMechanism.recentRewards).toEqual([]);
      expect(incentiveMechanism.recentSlashings).toEqual([]);
      expect(incentiveMechanism.pendingParameterUpdates).toEqual([]);
    });

    test('should initialize calculation cache', () => {
      expect(incentiveMechanism.calculationCache).toBeInstanceOf(Map);
    });
  });

  describe('calculateReward', () => {
    test('should calculate basic validator reward correctly', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateReward(params);

      expect(result.eligible).toBe(true);
      expect(result.amount).toBe(BaseRewards[RewardType.BLOCK_PRODUCTION]); // 5.0
      expect(result.reputationMultiplier).toBe(1.0); // Standard reputation
    });

    test('should deny rewards for reputation below threshold', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 30, // Below minimum
      };

      const result = incentiveMechanism.calculateReward(params);

      expect(result.eligible).toBe(false);
      expect(result.amount).toBe(0);
      expect(result.reason).toBe('Reputation below minimum threshold');
    });

    test('should handle invalid reward type', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: 'INVALID_REWARD_TYPE',
        reputation: 85,
      };

      const result = incentiveMechanism.calculateReward(params);

      expect(result.eligible).toBe(false);
      expect(result.amount).toBe(0);
      expect(result.reason).toBe('Invalid reward type');
    });

    test('should apply node type multipliers correctly', () => {
      const params = {
        nodeType: 'WEATHER_STATION',
        rewardType: RewardType.CRITICAL_REGION_COVERAGE,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateReward(params);
      const expectedMultiplier =
        NodeTypeMultipliers.WEATHER_STATION[
          RewardType.CRITICAL_REGION_COVERAGE
        ];
      const expectedAmount =
        BaseRewards[RewardType.CRITICAL_REGION_COVERAGE] * expectedMultiplier;

      expect(result.amount).toBe(expectedAmount);
    });

    test('should apply enhanced reputation multiplier for high reputation', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 98, // Above enhanced threshold
      };

      const result = incentiveMechanism.calculateReward(params);

      expect(result.reputationMultiplier).toBe(1.3);
      expect(result.amount).toBe(
        BaseRewards[RewardType.BLOCK_PRODUCTION] * 1.3
      );
    });

    test('should apply reduced reputation multiplier for lower reputation', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 60, // Between reduced and minimum
      };

      const result = incentiveMechanism.calculateReward(params);

      expect(result.reputationMultiplier).toBe(0.5);
      expect(result.amount).toBe(
        BaseRewards[RewardType.BLOCK_PRODUCTION] * 0.5
      );
    });

    test('should apply proximity multiplier for weather data submission', () => {
      const params = {
        nodeType: 'WEATHER_STATION',
        rewardType: RewardType.WEATHER_DATA_SUBMISSION,
        reputation: 85,
        additionalFactors: {
          distance: 3, // Within tier 1 (0-5km)
        },
      };

      const result = incentiveMechanism.calculateReward(params);
      const expectedProximityMultiplier =
        ProximityMultiplierTiers.TIER_1.multiplier; // 2.0

      expect(result.extraMultipliers).toContainEqual(
        expect.objectContaining({
          type: 'proximity',
          value: expectedProximityMultiplier,
          description: 'Distance of 3km',
        })
      );
    });

    test('should apply regional criticality multiplier', () => {
      const params = {
        nodeType: 'WEATHER_STATION',
        rewardType: RewardType.WEATHER_DATA_SUBMISSION,
        reputation: 85,
        additionalFactors: {
          regionalCriticality: 'CRITICAL',
        },
      };

      const result = incentiveMechanism.calculateReward(params);
      const expectedMultiplier = RegionalCriticalityLevels.CRITICAL.multiplier; // 3.0

      expect(result.extraMultipliers).toContainEqual(
        expect.objectContaining({
          type: 'criticality',
          value: expectedMultiplier,
          description: 'CRITICAL region criticality',
        })
      );
    });

    test('should apply data quality multiplier based on accuracy', () => {
      const params = {
        nodeType: 'WEATHER_STATION',
        rewardType: RewardType.WEATHER_DATA_SUBMISSION,
        reputation: 85,
        additionalFactors: {
          dataAccuracy: 0.97, // 97% accuracy - EXCELLENT tier
        },
      };

      const result = incentiveMechanism.calculateReward(params);
      const expectedMultiplier = DataQualityTiers.EXCELLENT.multiplier; // 1.5

      expect(result.extraMultipliers).toContainEqual(
        expect.objectContaining({
          type: 'quality',
          value: expectedMultiplier,
          description: '97.0% data accuracy',
        })
      );
    });

    test('should apply consistency bonus for long-term participation', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 85,
        additionalFactors: {
          consistentDays: 35, // Above threshold of 30 days
        },
      };

      const result = incentiveMechanism.calculateReward(params);
      const expectedMultiplier = TimeFactors.CONSISTENCY_BONUS_MULTIPLIER; // 1.2

      expect(result.extraMultipliers).toContainEqual(
        expect.objectContaining({
          type: 'consistency',
          value: expectedMultiplier,
          description: '35 days of consistent participation',
        })
      );
    });

    test('should apply peak demand multiplier', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 85,
        additionalFactors: {
          isPeakDemand: true,
        },
      };

      const result = incentiveMechanism.calculateReward(params);
      const expectedMultiplier = TimeFactors.PEAK_DEMAND_MULTIPLIER; // 1.5

      expect(result.extraMultipliers).toContainEqual(
        expect.objectContaining({
          type: 'peak_demand',
          value: expectedMultiplier,
          description: 'Peak demand period',
        })
      );
    });

    test('should apply stake size multiplier with cap', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 85,
        additionalFactors: {
          stakeAmount: 10000,
          networkMedianStake: 1000, // 10x the median
        },
      };

      const result = incentiveMechanism.calculateReward(params);

      // Stake multiplier should be capped at 2.0
      const expectedMultiplier = 2.0;
      expect(result.extraMultipliers).toContainEqual(
        expect.objectContaining({
          type: 'stake_size',
          value: expectedMultiplier,
        })
      );
    });

    test('should combine multiple multipliers correctly', () => {
      const params = {
        nodeType: 'WEATHER_STATION',
        rewardType: RewardType.WEATHER_DATA_SUBMISSION,
        reputation: 95, // Enhanced reputation (1.3x)
        additionalFactors: {
          distance: 3, // Tier 1 proximity (2.0x)
          dataAccuracy: 0.97, // Excellent quality (1.5x)
          isPeakDemand: true, // Peak demand (1.5x)
        },
      };

      const result = incentiveMechanism.calculateReward(params);

      // Base reward: 1.0, Enhanced reputation: 1.3, Extra multipliers: 2.0 * 1.5 * 1.5 = 4.5
      // Final: 1.0 * 1.3 * 4.5 = 5.85
      expect(result.amount).toBeCloseTo(5.85, 2);
    });

    test('should record rewards for analytics', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 85,
      };

      incentiveMechanism.calculateReward(params);

      expect(incentiveMechanism.recentRewards).toHaveLength(1);
      expect(incentiveMechanism.recentRewards[0]).toMatchObject({
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        baseReward: BaseRewards[RewardType.BLOCK_PRODUCTION],
        finalReward: BaseRewards[RewardType.BLOCK_PRODUCTION],
      });
    });

    test('should limit recent rewards to 1000 entries', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 85,
      };

      // Add 1005 rewards
      for (let i = 0; i < 1005; i++) {
        incentiveMechanism.calculateReward(params);
      }

      expect(incentiveMechanism.recentRewards).toHaveLength(1000);
    });
  });

  describe('calculateSlashing', () => {
    test('should calculate basic slashing correctly', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateSlashing(params);
      const expectedPercentage =
        BaseSlashingPercentages[SlashingReason.INVALID_BLOCK]; // 5.0%
      const expectedAmount = (1000 * expectedPercentage) / 100; // 50

      expect(result.applied).toBe(true);
      expect(result.amount).toBe(expectedAmount);
      expect(result.percentage).toBe(expectedPercentage);
    });

    test('should handle invalid slashing reason', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: 'INVALID_REASON',
        stakeAmount: 1000,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateSlashing(params);

      expect(result.applied).toBe(false);
      expect(result.amount).toBe(0);
      expect(result.reason).toBe('Invalid slashing reason');
    });

    test('should apply severity multipliers correctly', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
        reputation: 85,
        additionalFactors: {
          severity: 'SEVERE',
        },
      };

      const result = incentiveMechanism.calculateSlashing(params);
      const basePercentage =
        BaseSlashingPercentages[SlashingReason.INVALID_BLOCK]; // 5.0%
      const severityMultiplier = SlashingSeverityLevels.SEVERE.multiplier; // 2.0
      const expectedPercentage = basePercentage * severityMultiplier; // 10.0%

      expect(result.percentage).toBe(expectedPercentage);
      expect(result.severity).toBe('SEVERE');
    });

    test('should apply history multiplier for repeat offenders', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
        reputation: 85,
        additionalFactors: {
          previousViolations: 2,
        },
      };

      const result = incentiveMechanism.calculateSlashing(params);
      const basePercentage =
        BaseSlashingPercentages[SlashingReason.INVALID_BLOCK]; // 5.0%
      const historyMultiplier = Math.pow(1.5, 2); // 2.25
      const expectedPercentage = basePercentage * historyMultiplier; // 11.25%

      expect(result.historyMultiplier).toBe(historyMultiplier);
      expect(result.percentage).toBe(expectedPercentage);
    });

    test('should cap history multiplier at 5 violations', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
        reputation: 85,
        additionalFactors: {
          previousViolations: 10, // Should be capped at 5
        },
      };

      const result = incentiveMechanism.calculateSlashing(params);
      const expectedHistoryMultiplier = Math.pow(1.5, 5); // Capped at 5

      expect(result.historyMultiplier).toBe(expectedHistoryMultiplier);
    });

    test('should apply reputation-based adjustment for high reputation nodes', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
        reputation: 98, // High reputation - stricter penalty
      };

      const result = incentiveMechanism.calculateSlashing(params);

      expect(result.reputationMultiplier).toBe(1.2); // 20% higher slashing
    });

    test('should apply reputation-based adjustment for low reputation nodes', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
        reputation: 60, // Low reputation - more lenient
      };

      const result = incentiveMechanism.calculateSlashing(params);

      expect(result.reputationMultiplier).toBe(0.8); // 20% lower slashing
    });

    test('should cap slashing at 100% of stake', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.MALICIOUS_BEHAVIOR,
        stakeAmount: 1000,
        reputation: 98,
        additionalFactors: {
          severity: 'CRITICAL',
          previousViolations: 5,
        },
      };

      const result = incentiveMechanism.calculateSlashing(params);

      expect(result.percentage).toBeLessThanOrEqual(100);
      expect(result.amount).toBeLessThanOrEqual(1000);
    });

    test('should calculate reputation impact correctly', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.MALICIOUS_BEHAVIOR,
        stakeAmount: 1000,
        reputation: 85,
        additionalFactors: {
          severity: 'SEVERE',
        },
      };

      const result = incentiveMechanism.calculateSlashing(params);
      const baseImpact = ReputationImpact[SlashingReason.MALICIOUS_BEHAVIOR]; // -50
      const severityMultiplier = SlashingSeverityLevels.SEVERE.multiplier; // 2.0
      const expectedImpact = baseImpact * severityMultiplier; // -100

      expect(result.reputationImpact).toBe(expectedImpact);
    });

    test('should record slashing events for analytics', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
        reputation: 85,
      };

      incentiveMechanism.calculateSlashing(params);

      expect(incentiveMechanism.recentSlashings).toHaveLength(1);
      expect(incentiveMechanism.recentSlashings[0]).toMatchObject({
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
      });
    });

    test('should limit recent slashings to 1000 entries', () => {
      const params = {
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
        reputation: 85,
      };

      // Add 1005 slashing events
      for (let i = 0; i < 1005; i++) {
        incentiveMechanism.calculateSlashing(params);
      }

      expect(incentiveMechanism.recentSlashings).toHaveLength(1000);
    });
  });

  describe('node-specific calculation methods', () => {
    test('calculateValidatorReward should work correctly', () => {
      const params = {
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateValidatorReward(params);

      expect(result.reason).toContain('VALIDATOR');
    });

    test('calculateWeatherStationReward should work correctly', () => {
      const params = {
        rewardType: RewardType.WEATHER_DATA_SUBMISSION,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateWeatherStationReward(params);

      expect(result.reason).toContain('WEATHER_STATION');
    });

    test('calculateForecastComputeReward should work correctly', () => {
      const params = {
        rewardType: RewardType.FORECAST_COMPUTATION,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateForecastComputeReward(params);

      expect(result.reason).toContain('FORECAST_COMPUTE');
    });

    test('calculateStorageKeeperReward should work correctly', () => {
      const params = {
        rewardType: RewardType.STORAGE_PROVISION,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateStorageKeeperReward(params);

      expect(result.reason).toContain('STORAGE_KEEPER');
    });

    test('calculateLightClientReward should work correctly', () => {
      const params = {
        rewardType: RewardType.NETWORK_RELAY,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateLightClientReward(params);

      expect(result.reason).toContain('LIGHT_CLIENT');
    });

    test('calculateValidatorSlashing should work correctly', () => {
      const params = {
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateValidatorSlashing(params);

      expect(result.reason).toContain('VALIDATOR');
    });

    test('calculateWeatherStationSlashing should work correctly', () => {
      const params = {
        slashingReason: SlashingReason.INCORRECT_DATA,
        stakeAmount: 1000,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateWeatherStationSlashing(params);

      expect(result.reason).toContain('WEATHER_STATION');
    });

    test('calculateForecastComputeSlashing should work correctly', () => {
      const params = {
        slashingReason: SlashingReason.FAILED_VERIFICATION,
        stakeAmount: 1000,
        reputation: 85,
      };

      const result =
        incentiveMechanism.calculateForecastComputeSlashing(params);

      expect(result.reason).toContain('FORECAST_COMPUTE');
    });

    test('calculateStorageKeeperSlashing should work correctly', () => {
      const params = {
        slashingReason: SlashingReason.STORAGE_UNAVAILABLE,
        stakeAmount: 1000,
        reputation: 85,
      };

      const result = incentiveMechanism.calculateStorageKeeperSlashing(params);

      expect(result.reason).toContain('STORAGE_KEEPER');
    });
  });

  describe('getStatistics', () => {
    test('should return empty statistics when no events recorded', () => {
      const stats = incentiveMechanism.getStatistics();

      expect(stats.rewards.total).toBe(0);
      expect(stats.rewards.count).toBe(0);
      expect(stats.slashings.total).toBe(0);
      expect(stats.slashings.count).toBe(0);
    });

    test('should calculate reward statistics correctly', () => {
      // Add some rewards
      incentiveMechanism.calculateReward({
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 85,
      });

      incentiveMechanism.calculateReward({
        nodeType: 'WEATHER_STATION',
        rewardType: RewardType.WEATHER_DATA_SUBMISSION,
        reputation: 85,
      });

      const stats = incentiveMechanism.getStatistics();

      expect(stats.rewards.count).toBe(2);
      expect(stats.rewards.total).toBe(6.0); // 5.0 + 1.0
      expect(stats.rewards.byNodeType.VALIDATOR.count).toBe(1);
      expect(stats.rewards.byNodeType.WEATHER_STATION.count).toBe(1);
      expect(
        stats.rewards.byRewardType[RewardType.BLOCK_PRODUCTION].count
      ).toBe(1);
      expect(
        stats.rewards.byRewardType[RewardType.WEATHER_DATA_SUBMISSION].count
      ).toBe(1);
    });

    test('should calculate slashing statistics correctly', () => {
      // Add some slashing events
      incentiveMechanism.calculateSlashing({
        nodeType: 'VALIDATOR',
        slashingReason: SlashingReason.INVALID_BLOCK,
        stakeAmount: 1000,
        reputation: 85,
      });

      const stats = incentiveMechanism.getStatistics();

      expect(stats.slashings.count).toBe(1);
      expect(stats.slashings.total).toBe(50); // 5% of 1000
      expect(stats.slashings.byNodeType.VALIDATOR.count).toBe(1);
      expect(stats.slashings.byReason[SlashingReason.INVALID_BLOCK].count).toBe(
        1
      );
    });
  });

  describe('updateParameters', () => {
    test('should update base rewards correctly', () => {
      const updates = {
        baseRewards: {
          [RewardType.BLOCK_PRODUCTION]: 10.0, // Changed from 5.0
        },
      };

      const result = incentiveMechanism.updateParameters(updates);

      expect(result).toBe(true);
      expect(incentiveMechanism.baseRewards[RewardType.BLOCK_PRODUCTION]).toBe(
        10.0
      );
    });

    test('should update base slashing percentages correctly', () => {
      const updates = {
        baseSlashingPercentages: {
          [SlashingReason.INVALID_BLOCK]: 10.0, // Changed from 5.0
        },
      };

      const result = incentiveMechanism.updateParameters(updates);

      expect(result).toBe(true);
      expect(
        incentiveMechanism.baseSlashingPercentages[SlashingReason.INVALID_BLOCK]
      ).toBe(10.0);
    });

    test('should reject invalid parameter updates', () => {
      const updates = {
        baseRewards: {
          [RewardType.BLOCK_PRODUCTION]: -5.0, // Negative value should be rejected
        },
      };

      incentiveMechanism.updateParameters(updates);

      // Should remain unchanged
      expect(incentiveMechanism.baseRewards[RewardType.BLOCK_PRODUCTION]).toBe(
        5.0
      );
    });

    test('should reject slashing percentages above 100%', () => {
      const updates = {
        baseSlashingPercentages: {
          [SlashingReason.INVALID_BLOCK]: 150.0, // Above 100% should be rejected
        },
      };

      incentiveMechanism.updateParameters(updates);

      // Should remain unchanged
      expect(
        incentiveMechanism.baseSlashingPercentages[SlashingReason.INVALID_BLOCK]
      ).toBe(5.0);
    });

    test('should handle null or invalid updates', () => {
      expect(incentiveMechanism.updateParameters(null)).toBe(false);
      expect(incentiveMechanism.updateParameters(undefined)).toBe(false);
      expect(incentiveMechanism.updateParameters('invalid')).toBe(false);
    });

    test('should record parameter updates', () => {
      const updates = {
        baseRewards: {
          [RewardType.BLOCK_PRODUCTION]: 10.0,
        },
      };

      incentiveMechanism.updateParameters(updates);

      expect(incentiveMechanism.pendingParameterUpdates).toHaveLength(1);
      expect(incentiveMechanism.pendingParameterUpdates[0]).toMatchObject({
        updates,
        applied: true,
      });
    });
  });

  describe('utility methods', () => {
    describe('getProximityMultiplier', () => {
      test('should return correct multiplier for different distances', () => {
        expect(incentiveMechanism.getProximityMultiplier(3)).toBe(2.0); // Tier 1
        expect(incentiveMechanism.getProximityMultiplier(10)).toBe(1.5); // Tier 2
        expect(incentiveMechanism.getProximityMultiplier(20)).toBe(1.2); // Tier 3
        expect(incentiveMechanism.getProximityMultiplier(40)).toBe(1.0); // Tier 4
        expect(incentiveMechanism.getProximityMultiplier(75)).toBe(0.8); // Tier 5
        expect(incentiveMechanism.getProximityMultiplier(150)).toBe(0.5); // Default
      });

      test('should handle invalid distance values', () => {
        expect(incentiveMechanism.getProximityMultiplier(-10)).toBe(0.5); // Default
        expect(incentiveMechanism.getProximityMultiplier('invalid')).toBe(0.5); // Default
        expect(incentiveMechanism.getProximityMultiplier(null)).toBe(0.5); // Default
      });
    });

    describe('getRegionalCriticalityMultiplier', () => {
      test('should return correct multiplier for different criticality levels', () => {
        expect(
          incentiveMechanism.getRegionalCriticalityMultiplier('CRITICAL')
        ).toBe(3.0);
        expect(
          incentiveMechanism.getRegionalCriticalityMultiplier('HIGH')
        ).toBe(2.0);
        expect(
          incentiveMechanism.getRegionalCriticalityMultiplier('MEDIUM')
        ).toBe(1.5);
        expect(
          incentiveMechanism.getRegionalCriticalityMultiplier('STANDARD')
        ).toBe(1.0);
        expect(incentiveMechanism.getRegionalCriticalityMultiplier('LOW')).toBe(
          0.8
        );
      });

      test('should return standard multiplier for invalid levels', () => {
        expect(
          incentiveMechanism.getRegionalCriticalityMultiplier('INVALID')
        ).toBe(1.0);
        expect(incentiveMechanism.getRegionalCriticalityMultiplier(null)).toBe(
          1.0
        );
      });
    });

    describe('getDataQualityMultiplier', () => {
      test('should return correct multiplier for different accuracy levels', () => {
        expect(incentiveMechanism.getDataQualityMultiplier(0.97)).toBe(1.5); // EXCELLENT
        expect(incentiveMechanism.getDataQualityMultiplier(0.92)).toBe(1.2); // GOOD
        expect(incentiveMechanism.getDataQualityMultiplier(0.87)).toBe(1.0); // STANDARD
        expect(incentiveMechanism.getDataQualityMultiplier(0.8)).toBe(0.7); // SUBPAR
        expect(incentiveMechanism.getDataQualityMultiplier(0.65)).toBe(0.4); // POOR
        expect(incentiveMechanism.getDataQualityMultiplier(0.5)).toBe(0); // Below minimum
      });

      test('should handle invalid accuracy values', () => {
        expect(incentiveMechanism.getDataQualityMultiplier(-0.1)).toBe(0);
        expect(incentiveMechanism.getDataQualityMultiplier(1.5)).toBe(0);
        expect(incentiveMechanism.getDataQualityMultiplier('invalid')).toBe(0);
        expect(incentiveMechanism.getDataQualityMultiplier(null)).toBe(0);
      });
    });
  });

  describe('exported constants', () => {
    test('should export all required constants', () => {
      expect(RewardType).toBeDefined();
      expect(SlashingReason).toBeDefined();
      expect(BaseRewards).toBeDefined();
      expect(BaseSlashingPercentages).toBeDefined();
      expect(NodeTypeMultipliers).toBeDefined();
      expect(ReputationThresholds).toBeDefined();
      expect(ReputationImpact).toBeDefined();
      expect(ProximityMultiplierTiers).toBeDefined();
      expect(RegionalCriticalityLevels).toBeDefined();
      expect(TimeFactors).toBeDefined();
      expect(DataQualityTiers).toBeDefined();
      expect(SlashingSeverityLevels).toBeDefined();
    });

    test('RewardType should contain all expected reward types', () => {
      const expectedTypes = [
        'BLOCK_PRODUCTION',
        'WEATHER_DATA_SUBMISSION',
        'FORECAST_COMPUTATION',
        'STORAGE_PROVISION',
        'DATA_VALIDATION',
        'NETWORK_RELAY',
        'GOVERNANCE_PARTICIPATION',
        'CRITICAL_REGION_COVERAGE',
        'LONG_TERM_COMMITMENT',
        'QUALITY_BONUS',
      ];

      expectedTypes.forEach(type => {
        expect(RewardType).toHaveProperty(type);
      });
    });

    test('SlashingReason should contain all expected slashing reasons', () => {
      const expectedReasons = [
        'INVALID_BLOCK',
        'DOWNTIME',
        'MALICIOUS_BEHAVIOR',
        'INCORRECT_DATA',
        'FAILED_VERIFICATION',
        'DUPLICATE_SUBMISSION',
        'SPAM',
        'LATE_SUBMISSION',
        'STORAGE_UNAVAILABLE',
        'CONSENSUS_VIOLATION',
      ];

      expectedReasons.forEach(reason => {
        expect(SlashingReason).toHaveProperty(reason);
      });
    });
  });

  describe('performance and reliability', () => {
    test('should handle high volume of reward calculations efficiently', () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        incentiveMechanism.calculateReward({
          nodeType: 'VALIDATOR',
          rewardType: RewardType.BLOCK_PRODUCTION,
          reputation: 85,
        });
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete 1000 calculations in under 1 second
    });

    test('should handle high volume of slashing calculations efficiently', () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        incentiveMechanism.calculateSlashing({
          nodeType: 'VALIDATOR',
          slashingReason: SlashingReason.INVALID_BLOCK,
          stakeAmount: 1000,
          reputation: 85,
        });
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(1000); // Should complete 1000 calculations in under 1 second
    });

    test('should maintain consistency across multiple calculations', () => {
      const params = {
        nodeType: 'VALIDATOR',
        rewardType: RewardType.BLOCK_PRODUCTION,
        reputation: 85,
      };

      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(incentiveMechanism.calculateReward(params));
      }

      // All results should be identical for same parameters
      results.forEach(result => {
        expect(result.amount).toBe(results[0].amount);
        expect(result.reputationMultiplier).toBe(
          results[0].reputationMultiplier
        );
      });
    });
  });
});
