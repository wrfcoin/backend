/**
 * Unit Tests for Meshtastic Reward Service
 * Task 108: Meshtastic Reward Engine Integration
 *
 * Tests cover:
 * - Data reward calculation (subtask 108.2)
 * - Mesh reward calculation (subtask 108.3)
 * - Combined reward calculation
 * - Anti-gaming cap enforcement (subtask 108.5)
 * - Edge cases and boundary conditions
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  MeshtasticRewardService,
  REWARD_CONFIG,
  DataRewardInput,
  MeshRewardInput,
  NodeRewardInput,
} from '../server/services/meshtastic-reward-service.js';

// Mock the database module
jest.mock('../database/db', () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([{ id: 1 }]),
    onConflictDoNothing: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    offset: jest.fn().mockResolvedValue([]),
  },
}));

// Create mock db for service instantiation
// @ts-ignore - Mock database for testing
const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockResolvedValue([]),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockResolvedValue([{ id: 1 }]),
  onConflictDoNothing: jest.fn().mockResolvedValue([]),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  groupBy: jest.fn().mockReturnThis(),
  orderBy: jest.fn().mockReturnThis(),
  offset: jest.fn().mockResolvedValue([]),
};

describe('MeshtasticRewardService', () => {
  let rewardService: MeshtasticRewardService;

  beforeEach(() => {
    rewardService = new MeshtasticRewardService(mockDb);
    jest.clearAllMocks();
  });

  // ==========================================================================
  // REWARD_CONFIG Tests
  // ==========================================================================

  describe('REWARD_CONFIG', () => {
    it('should have correct base reward values', () => {
      expect(REWARD_CONFIG.BASE_OBSERVATION_REWARD).toBe(0.1);
      expect(REWARD_CONFIG.BASE_RELAY_REWARD).toBe(0.01);
    });

    it('should have correct quality multiplier range', () => {
      expect(REWARD_CONFIG.QUALITY_MULTIPLIER_MIN).toBe(0.5);
      expect(REWARD_CONFIG.QUALITY_MULTIPLIER_MAX).toBe(2.0);
    });

    it('should have correct anti-gaming caps', () => {
      expect(REWARD_CONFIG.DAILY_CAP_PER_NODE).toBe(50);
      expect(REWARD_CONFIG.WEEKLY_CAP_PER_NODE).toBe(300);
      expect(REWARD_CONFIG.REGION_DAILY_CAP).toBe(1000);
    });

    it('should have correct minimum quality threshold', () => {
      expect(REWARD_CONFIG.MIN_QUALITY_THRESHOLD).toBe(50);
    });
  });

  // ==========================================================================
  // Data Reward Calculation Tests (Subtask 108.2)
  // ==========================================================================

  describe('calculateDataReward', () => {
    it('should return 0 reward when quality is below threshold', () => {
      const input: DataRewardInput = {
        observationCount: 100,
        validObservationCount: 80,
        avgQualityScore: 40, // Below MIN_QUALITY_THRESHOLD (50)
        uniqueHoursContributed: 10,
        spatialCoverageBonus: 0.5,
      };

      const result = rewardService.calculateDataReward(input);

      expect(result.reward).toBe(0);
      expect(result.breakdown.baseReward).toBe(0);
      expect(result.breakdown.qualityMultiplier).toBe(0);
    });

    it('should calculate base reward correctly', () => {
      const input: DataRewardInput = {
        observationCount: 100,
        validObservationCount: 80,
        avgQualityScore: 75, // Should give 1.25x multiplier
        uniqueHoursContributed: 0,
        spatialCoverageBonus: 0,
      };

      const result = rewardService.calculateDataReward(input);

      // Base: 80 * 0.1 = 8.0 WRF
      expect(result.breakdown.baseReward).toBe(8.0);
    });

    it('should apply minimum quality multiplier at threshold', () => {
      const input: DataRewardInput = {
        observationCount: 10,
        validObservationCount: 10,
        avgQualityScore: 50, // At threshold
        uniqueHoursContributed: 0,
        spatialCoverageBonus: 0,
      };

      const result = rewardService.calculateDataReward(input);

      // Quality multiplier at 50 should be 0.5
      expect(result.breakdown.qualityMultiplier).toBe(0.5);
      // Base: 10 * 0.1 = 1.0, with 0.5x = 0.5
      expect(result.reward).toBeCloseTo(0.5, 4);
    });

    it('should apply maximum quality multiplier at 100', () => {
      const input: DataRewardInput = {
        observationCount: 10,
        validObservationCount: 10,
        avgQualityScore: 100,
        uniqueHoursContributed: 0,
        spatialCoverageBonus: 0,
      };

      const result = rewardService.calculateDataReward(input);

      // Quality multiplier at 100 should be 2.0
      expect(result.breakdown.qualityMultiplier).toBe(2.0);
      // Base: 10 * 0.1 = 1.0, with 2.0x = 2.0
      expect(result.reward).toBeCloseTo(2.0, 4);
    });

    it('should calculate consistency bonus correctly', () => {
      const input: DataRewardInput = {
        observationCount: 10,
        validObservationCount: 10,
        avgQualityScore: 50,
        uniqueHoursContributed: 10,
        spatialCoverageBonus: 0,
      };

      const result = rewardService.calculateDataReward(input);

      // Consistency: 10 hours * 0.05 = 0.5 WRF
      expect(result.breakdown.consistencyBonus).toBe(0.5);
    });

    it('should cap consistency bonus at 24 hours', () => {
      const input: DataRewardInput = {
        observationCount: 10,
        validObservationCount: 10,
        avgQualityScore: 50,
        uniqueHoursContributed: 48, // More than 24
        spatialCoverageBonus: 0,
      };

      const result = rewardService.calculateDataReward(input);

      // Consistency: max 24 hours * 0.05 = 1.2 WRF
      expect(result.breakdown.consistencyBonus).toBeCloseTo(1.2, 6);
    });

    it('should calculate spatial bonus correctly', () => {
      const input: DataRewardInput = {
        observationCount: 10,
        validObservationCount: 10,
        avgQualityScore: 50,
        uniqueHoursContributed: 0,
        spatialCoverageBonus: 1.0, // Full bonus
      };

      const result = rewardService.calculateDataReward(input);

      // Spatial: 1.0 * 0.2 = 0.2 WRF
      expect(result.breakdown.spatialBonus).toBeCloseTo(0.2, 6);
    });

    it('should combine all data reward components correctly', () => {
      const input: DataRewardInput = {
        observationCount: 100,
        validObservationCount: 80,
        avgQualityScore: 75, // 1.25x multiplier
        uniqueHoursContributed: 10, // 0.5 bonus
        spatialCoverageBonus: 0.5, // 0.1 bonus
      };

      const result = rewardService.calculateDataReward(input);

      // Base: 80 * 0.1 = 8.0
      // Quality adjusted: 8.0 * 1.25 = 10.0
      // Consistency: 10 * 0.05 = 0.5
      // Spatial: 0.5 * 0.2 = 0.1
      // Total: 10.0 + 0.5 + 0.1 = 10.6

      expect(result.reward).toBeCloseTo(10.6, 4);
    });
  });

  // ==========================================================================
  // Mesh Reward Calculation Tests (Subtask 108.3)
  // ==========================================================================

  describe('calculateMeshReward', () => {
    it('should calculate base mesh reward correctly', () => {
      const input: MeshRewardInput = {
        relayedMessages: 100,
        uptimePercentage: 50, // Below threshold
        avgNeighborCount: 2, // Below threshold
        topologyImportanceScore: 0,
      };

      const result = rewardService.calculateMeshReward(input);

      // Base: 100 * 0.01 = 1.0 WRF
      expect(result.breakdown.baseReward).toBe(1.0);
      expect(result.reward).toBe(1.0);
    });

    it('should apply uptime bonus when above threshold', () => {
      const input: MeshRewardInput = {
        relayedMessages: 100,
        uptimePercentage: 95, // Above 90% threshold
        avgNeighborCount: 2,
        topologyImportanceScore: 0,
      };

      const result = rewardService.calculateMeshReward(input);

      // Base: 100 * 0.01 = 1.0
      // Uptime bonus: 1.0 * 0.2 = 0.2
      // Total: 1.0 + 0.2 = 1.2
      expect(result.breakdown.uptimeBonus).toBeCloseTo(0.2, 6);
      expect(result.reward).toBeCloseTo(1.2, 4);
    });

    it('should not apply uptime bonus below threshold', () => {
      const input: MeshRewardInput = {
        relayedMessages: 100,
        uptimePercentage: 89, // Below 90% threshold
        avgNeighborCount: 2,
        topologyImportanceScore: 0,
      };

      const result = rewardService.calculateMeshReward(input);

      expect(result.breakdown.uptimeBonus).toBe(0);
      expect(result.reward).toBe(1.0);
    });

    it('should apply topology bonus when neighbors above threshold', () => {
      const input: MeshRewardInput = {
        relayedMessages: 100,
        uptimePercentage: 50,
        avgNeighborCount: 10, // Above 5 threshold
        topologyImportanceScore: 0.8,
      };

      const result = rewardService.calculateMeshReward(input);

      // Base: 100 * 0.01 = 1.0
      // Topology: 1.0 * 0.8 * 0.3 = 0.24
      expect(result.breakdown.topologyBonus).toBeCloseTo(0.24, 4);
      expect(result.reward).toBeCloseTo(1.24, 4);
    });

    it('should not apply topology bonus when neighbors below threshold', () => {
      const input: MeshRewardInput = {
        relayedMessages: 100,
        uptimePercentage: 50,
        avgNeighborCount: 4, // Below 5 threshold
        topologyImportanceScore: 0.8,
      };

      const result = rewardService.calculateMeshReward(input);

      expect(result.breakdown.topologyBonus).toBe(0);
      expect(result.reward).toBe(1.0);
    });

    it('should cap topology importance score at 1.0', () => {
      const input: MeshRewardInput = {
        relayedMessages: 100,
        uptimePercentage: 50,
        avgNeighborCount: 10,
        topologyImportanceScore: 1.5, // Above 1.0
      };

      const result = rewardService.calculateMeshReward(input);

      // Should be capped: 1.0 * 1.0 * 0.3 = 0.3 (not 0.45)
      expect(result.breakdown.topologyBonus).toBeCloseTo(0.3, 4);
    });

    it('should combine all mesh reward components correctly', () => {
      const input: MeshRewardInput = {
        relayedMessages: 100,
        uptimePercentage: 95, // Above threshold
        avgNeighborCount: 10, // Above threshold
        topologyImportanceScore: 0.5,
      };

      const result = rewardService.calculateMeshReward(input);

      // Base: 100 * 0.01 = 1.0
      // Uptime: 1.0 * 0.2 = 0.2
      // Topology: 1.0 * 0.5 * 0.3 = 0.15
      // Total: 1.0 + 0.2 + 0.15 = 1.35

      expect(result.reward).toBeCloseTo(1.35, 4);
    });
  });

  // ==========================================================================
  // Combined Reward Calculation Tests
  // ==========================================================================

  describe('calculateTotalReward', () => {
    it('should combine data and mesh rewards correctly', () => {
      const input: NodeRewardInput = {
        nodeId: '1',
        meshtasticNodeId: '!abc123',
        wrfcoinAddress: '0x123',
        observationSummary: {
          observationCount: 10,
          validObservationCount: 10,
          avgQualityScore: 75, // 1.25x
          uniqueHoursContributed: 0,
          spatialCoverageBonus: 0,
        },
        meshSummary: {
          relayedMessages: 50,
          uptimePercentage: 95,
          avgNeighborCount: 3,
          topologyImportanceScore: 0,
        },
      };

      const result = rewardService.calculateTotalReward(input);

      // Data: 10 * 0.1 * 1.25 = 1.25
      // Mesh: 50 * 0.01 * 1.2 (uptime) = 0.6
      // Total: 1.25 + 0.6 = 1.85

      expect(result.dataReward).toBeCloseTo(1.25, 4);
      expect(result.meshReward).toBeCloseTo(0.6, 4);
      expect(result.totalReward).toBeCloseTo(1.85, 4);
    });

    it('should return 0 data reward when below quality threshold', () => {
      const input: NodeRewardInput = {
        nodeId: '1',
        meshtasticNodeId: '!abc123',
        wrfcoinAddress: '0x123',
        observationSummary: {
          observationCount: 10,
          validObservationCount: 10,
          avgQualityScore: 40, // Below threshold
          uniqueHoursContributed: 10,
          spatialCoverageBonus: 1.0,
        },
        meshSummary: {
          relayedMessages: 50,
          uptimePercentage: 95,
          avgNeighborCount: 10,
          topologyImportanceScore: 0.5,
        },
      };

      const result = rewardService.calculateTotalReward(input);

      expect(result.dataReward).toBe(0);
      expect(result.meshReward).toBeGreaterThan(0);
      expect(result.totalReward).toBe(result.meshReward);
    });

    it('should include full reward breakdown', () => {
      const input: NodeRewardInput = {
        nodeId: '1',
        meshtasticNodeId: '!abc123',
        wrfcoinAddress: '0x123',
        observationSummary: {
          observationCount: 10,
          validObservationCount: 10,
          avgQualityScore: 100,
          uniqueHoursContributed: 5,
          spatialCoverageBonus: 0.5,
        },
        meshSummary: {
          relayedMessages: 100,
          uptimePercentage: 95,
          avgNeighborCount: 10,
          topologyImportanceScore: 0.5,
        },
      };

      const result = rewardService.calculateTotalReward(input);

      expect(result.breakdown).toHaveProperty('baseDataReward');
      expect(result.breakdown).toHaveProperty('qualityMultiplier');
      expect(result.breakdown).toHaveProperty('consistencyBonus');
      expect(result.breakdown).toHaveProperty('spatialBonus');
      expect(result.breakdown).toHaveProperty('baseMeshReward');
      expect(result.breakdown).toHaveProperty('uptimeBonus');
      expect(result.breakdown).toHaveProperty('topologyBonus');
    });

    it('should hold rewards while geo-fence manual review is pending', () => {
      const input: NodeRewardInput = {
        nodeId: '1',
        meshtasticNodeId: '!abc123',
        wrfcoinAddress: '0x123',
        geoFenceStatus: 'manual_review_required',
        observationSummary: {
          observationCount: 10,
          validObservationCount: 10,
          avgQualityScore: 100,
          uniqueHoursContributed: 10,
          spatialCoverageBonus: 1,
        },
        meshSummary: {
          relayedMessages: 100,
          uptimePercentage: 95,
          avgNeighborCount: 10,
          topologyImportanceScore: 1,
        },
      };

      const result = rewardService.calculateTotalReward(input);

      expect(result.dataReward).toBe(0);
      expect(result.meshReward).toBe(0);
      expect(result.totalReward).toBe(0);
      expect(result.cappedAmount).toBe(0);
      expect(result.capApplied).toBe('none');
      expect(result.breakdown).toEqual({
        baseDataReward: 0,
        qualityMultiplier: 0,
        consistencyBonus: 0,
        spatialBonus: 0,
        baseMeshReward: 0,
        uptimeBonus: 0,
        topologyBonus: 0,
      });
    });
  });

  // ==========================================================================
  // Edge Cases and Boundary Conditions
  // ==========================================================================

  describe('Edge Cases', () => {
    it('should handle zero observations gracefully', () => {
      const input: DataRewardInput = {
        observationCount: 0,
        validObservationCount: 0,
        avgQualityScore: 75,
        uniqueHoursContributed: 0,
        spatialCoverageBonus: 0,
      };

      const result = rewardService.calculateDataReward(input);

      expect(result.reward).toBe(0);
    });

    it('should handle zero relayed messages gracefully', () => {
      const input: MeshRewardInput = {
        relayedMessages: 0,
        uptimePercentage: 95,
        avgNeighborCount: 10,
        topologyImportanceScore: 0.5,
      };

      const result = rewardService.calculateMeshReward(input);

      expect(result.reward).toBe(0);
    });

    it('should handle quality score exactly at threshold', () => {
      const input: DataRewardInput = {
        observationCount: 10,
        validObservationCount: 10,
        avgQualityScore: 50, // Exactly at threshold
        uniqueHoursContributed: 0,
        spatialCoverageBonus: 0,
      };

      const result = rewardService.calculateDataReward(input);

      expect(result.reward).toBeGreaterThan(0);
    });

    it('should handle uptime exactly at threshold', () => {
      const input: MeshRewardInput = {
        relayedMessages: 100,
        uptimePercentage: 90, // Exactly at threshold
        avgNeighborCount: 2,
        topologyImportanceScore: 0,
      };

      const result = rewardService.calculateMeshReward(input);

      // Should get uptime bonus at exactly 90%
      expect(result.breakdown.uptimeBonus).toBeCloseTo(0.2, 6);
    });

    it('should handle neighbor count exactly at threshold', () => {
      const input: MeshRewardInput = {
        relayedMessages: 100,
        uptimePercentage: 50,
        avgNeighborCount: 5, // Exactly at threshold
        topologyImportanceScore: 0.5,
      };

      const result = rewardService.calculateMeshReward(input);

      // Should get topology bonus at exactly 5 neighbors
      expect(result.breakdown.topologyBonus).toBeGreaterThan(0);
    });

    it('should handle large observation counts', () => {
      const input: DataRewardInput = {
        observationCount: 10000,
        validObservationCount: 9500,
        avgQualityScore: 95,
        uniqueHoursContributed: 24,
        spatialCoverageBonus: 1.0,
      };

      const result = rewardService.calculateDataReward(input);

      // Should calculate without overflow
      expect(result.reward).toBeGreaterThan(0);
      expect(Number.isFinite(result.reward)).toBe(true);
    });

    it('should handle quality score above 100 by clamping', () => {
      const input: DataRewardInput = {
        observationCount: 10,
        validObservationCount: 10,
        avgQualityScore: 150, // Above 100
        uniqueHoursContributed: 0,
        spatialCoverageBonus: 0,
      };

      const result = rewardService.calculateDataReward(input);

      // Should be capped at 2.0x multiplier
      expect(result.breakdown.qualityMultiplier).toBe(2.0);
    });
  });

  // ==========================================================================
  // Integration-style Tests
  // ==========================================================================

  describe('Realistic Scenarios', () => {
    it('should calculate rewards for a high-performing node', () => {
      const input: NodeRewardInput = {
        nodeId: '1',
        meshtasticNodeId: '!highperf123',
        wrfcoinAddress: '0x123',
        observationSummary: {
          observationCount: 96, // One per 15 min for 24h
          validObservationCount: 90,
          avgQualityScore: 92,
          uniqueHoursContributed: 24,
          spatialCoverageBonus: 0.8,
        },
        meshSummary: {
          relayedMessages: 500,
          uptimePercentage: 98,
          avgNeighborCount: 12,
          topologyImportanceScore: 0.7,
        },
      };

      const result = rewardService.calculateTotalReward(input);

      // High-performing node should get substantial rewards
      expect(result.dataReward).toBeGreaterThan(15); // Significant data rewards
      expect(result.meshReward).toBeGreaterThan(5); // Good mesh rewards
      expect(result.totalReward).toBeGreaterThan(20);
    });

    it('should calculate rewards for a low-performing node', () => {
      const input: NodeRewardInput = {
        nodeId: '2',
        meshtasticNodeId: '!lowperf456',
        wrfcoinAddress: '0x456',
        observationSummary: {
          observationCount: 10,
          validObservationCount: 5,
          avgQualityScore: 55, // Just above threshold
          uniqueHoursContributed: 2,
          spatialCoverageBonus: 0,
        },
        meshSummary: {
          relayedMessages: 10,
          uptimePercentage: 30,
          avgNeighborCount: 1,
          topologyImportanceScore: 0.1,
        },
      };

      const result = rewardService.calculateTotalReward(input);

      // Low-performing node should get minimal rewards
      expect(result.dataReward).toBeLessThan(1);
      expect(result.meshReward).toBeLessThan(0.5);
      expect(result.totalReward).toBeLessThan(1.5);
    });

    it('should handle unregistered node (no wallet address)', () => {
      const input: NodeRewardInput = {
        nodeId: '3',
        meshtasticNodeId: '!unreg789',
        wrfcoinAddress: null, // Not registered
        observationSummary: {
          observationCount: 50,
          validObservationCount: 40,
          avgQualityScore: 80,
          uniqueHoursContributed: 12,
          spatialCoverageBonus: 0.5,
        },
        meshSummary: {
          relayedMessages: 200,
          uptimePercentage: 85,
          avgNeighborCount: 6,
          topologyImportanceScore: 0.4,
        },
      };

      const result = rewardService.calculateTotalReward(input);

      // Should still calculate rewards (eligibility check is separate)
      expect(result.totalReward).toBeGreaterThan(0);
    });
  });

  // ==========================================================================
  // Formula Verification Tests
  // ==========================================================================

  describe('Formula Verification', () => {
    it('should match documented data reward formula', () => {
      // Formula: DataReward = (validObs * 0.1 * qualityMultiplier) + (uniqueHours * 0.05) + (spatialBonus * 0.2)
      const input: DataRewardInput = {
        observationCount: 100,
        validObservationCount: 80,
        avgQualityScore: 75, // (75-50)/50 * 1.5 + 0.5 = 1.25
        uniqueHoursContributed: 10,
        spatialCoverageBonus: 0.5,
      };

      const result = rewardService.calculateDataReward(input);

      // Manual calculation:
      // qualityMultiplier = 0.5 + ((75 - 50) / 50) * 1.5 = 0.5 + 0.75 = 1.25
      // qualityAdjusted = 80 * 0.1 * 1.25 = 10.0
      // consistency = 10 * 0.05 = 0.5
      // spatial = 0.5 * 0.2 = 0.1
      // total = 10.0 + 0.5 + 0.1 = 10.6

      expect(result.breakdown.qualityMultiplier).toBeCloseTo(1.25, 4);
      expect(result.reward).toBeCloseTo(10.6, 4);
    });

    it('should match documented mesh reward formula', () => {
      // Formula: MeshReward = relayedMessages * 0.01 * (1 + uptimeBonus + topologyBonus)
      const input: MeshRewardInput = {
        relayedMessages: 100,
        uptimePercentage: 95, // +0.2 bonus
        avgNeighborCount: 10, // qualifies for topology bonus
        topologyImportanceScore: 0.5, // +0.15 bonus (0.5 * 0.3)
      };

      const result = rewardService.calculateMeshReward(input);

      // Manual calculation:
      // base = 100 * 0.01 = 1.0
      // uptimeBonus = 1.0 * 0.2 = 0.2
      // topologyBonus = 1.0 * 0.5 * 0.3 = 0.15
      // total = 1.0 + 0.2 + 0.15 = 1.35

      expect(result.reward).toBeCloseTo(1.35, 4);
    });
  });
});
