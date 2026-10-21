/**
 * Meshtastic Reward Service
 *
 * Implements reward calculation and distribution for mesh network participation.
 * Task 108: Meshtastic Reward Engine Integration
 *
 * Subtasks covered:
 * - 108.2: Data Reward Calculation
 * - 108.3: Mesh Reward Calculation
 * - 108.5: Anti-Gaming Measures
 */

import { eq, and, gte, lte, sql, desc, avg, count, isNotNull } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import {
  meshtasticNodes,
  meshtasticObservations,
  meshtasticRewardAggregations,
  meshtasticRewardDistributions,
  meshtasticRewardCaps,
} from '../../shared/schema-meshtastic.js';
import { iotLogger } from '../utils/logger.js';
import {
  isRewardEligibleForGeoFence,
  type GeoFenceReviewStatus,
} from '../../shared/iot-gateway-geofence-service.js';

// ============================================================================
// Configuration Constants
// ============================================================================

export const REWARD_CONFIG = {
  // Base rewards (in WRF tokens)
  BASE_OBSERVATION_REWARD: 0.1, // Per valid observation
  BASE_RELAY_REWARD: 0.01, // Per relayed message

  // Quality multipliers (for quality score 50-100)
  QUALITY_MULTIPLIER_MIN: 0.5, // At quality 50
  QUALITY_MULTIPLIER_MAX: 2.0, // At quality 100

  // Consistency bonuses
  HOURLY_CONSISTENCY_BONUS: 0.05, // Per unique hour contributed (max 24)
  SPATIAL_COVERAGE_BONUS: 0.2, // Bonus multiplier for underserved regions

  // Mesh reward factors
  UPTIME_BONUS_THRESHOLD: 90, // Uptime % to qualify for bonus
  UPTIME_BONUS_MULTIPLIER: 1.2, // 20% bonus when above threshold
  NEIGHBOR_BONUS_THRESHOLD: 5, // Min neighbors for topology bonus
  TOPOLOGY_IMPORTANCE_WEIGHT: 0.3, // Max 30% bonus from topology

  // Anti-gaming caps (in WRF tokens)
  DAILY_CAP_PER_NODE: 50, // Max per node per day
  WEEKLY_CAP_PER_NODE: 300, // Max per node per week
  REGION_DAILY_CAP: 1000, // Max per H3 region per day

  // Quality thresholds
  MIN_QUALITY_THRESHOLD: 50, // Minimum quality score to earn rewards
} as const;

// ============================================================================
// Type Definitions
// ============================================================================

export interface DataRewardInput {
  observationCount: number;
  validObservationCount: number;
  avgQualityScore: number; // 0-100
  uniqueHoursContributed: number; // 0-24
  spatialCoverageBonus: number; // 0-1
}

export interface MeshRewardInput {
  relayedMessages: number;
  uptimePercentage: number; // 0-100
  avgNeighborCount: number;
  topologyImportanceScore: number; // 0-1
}

export interface NodeRewardInput {
  nodeId: string;
  meshtasticNodeId: string;
  wrfcoinAddress: string | null;
  geoFenceStatus?: GeoFenceReviewStatus;
  observationSummary: DataRewardInput;
  meshSummary: MeshRewardInput;
}

export interface RewardBreakdown {
  baseDataReward: number;
  qualityMultiplier: number;
  consistencyBonus: number;
  spatialBonus: number;
  baseMeshReward: number;
  uptimeBonus: number;
  topologyBonus: number;
}

export interface RewardCalculationResult {
  dataReward: number;
  meshReward: number;
  totalReward: number;
  cappedAmount: number;
  capApplied: 'none' | 'daily' | 'weekly' | 'region';
  breakdown: RewardBreakdown;
}

export interface RewardOutput {
  nodeId: string;
  wrfcoinAddress: string;
  dataReward: number;
  meshReward: number;
  totalReward: number;
  period: { start: Date; end: Date };
  transactionId?: string;
  status: 'pending' | 'distributed' | 'failed' | 'capped';
}

// ============================================================================
// MeshtasticRewardService Class
// ============================================================================

export class MeshtasticRewardService {
  constructor(private db: NeonDatabase<Record<string, unknown>>) {}

  // --------------------------------------------------------------------------
  // Subtask 108.2: Data Reward Calculation
  // --------------------------------------------------------------------------

  /**
   * Calculate data rewards based on observation metrics.
   * Formula: (validObs * BASE * qualityMultiplier) + consistencyBonus + spatialBonus
   */
  calculateDataReward(input: DataRewardInput): {
    reward: number;
    breakdown: {
      baseReward: number;
      qualityMultiplier: number;
      consistencyBonus: number;
      spatialBonus: number;
    };
  } {
    // Check minimum quality threshold
    if (input.avgQualityScore < REWARD_CONFIG.MIN_QUALITY_THRESHOLD) {
      return {
        reward: 0,
        breakdown: {
          baseReward: 0,
          qualityMultiplier: 0,
          consistencyBonus: 0,
          spatialBonus: 0,
        },
      };
    }

    // Base reward: per valid observation
    const baseReward = input.validObservationCount * REWARD_CONFIG.BASE_OBSERVATION_REWARD;

    // Quality multiplier: linear interpolation from 0.5 (at 50) to 2.0 (at 100)
    const qualityMultiplier = this.calculateQualityMultiplier(input.avgQualityScore);
    const qualityAdjustedReward = baseReward * qualityMultiplier;

    // Consistency bonus: reward unique hours of contribution (max 24 hours)
    const clampedHours = Math.min(input.uniqueHoursContributed, 24);
    const consistencyBonus = clampedHours * REWARD_CONFIG.HOURLY_CONSISTENCY_BONUS;

    // Spatial coverage bonus: reward observations in underserved areas
    const spatialBonus = input.spatialCoverageBonus * REWARD_CONFIG.SPATIAL_COVERAGE_BONUS;

    const totalDataReward = qualityAdjustedReward + consistencyBonus + spatialBonus;

    return {
      reward: totalDataReward,
      breakdown: {
        baseReward,
        qualityMultiplier,
        consistencyBonus,
        spatialBonus,
      },
    };
  }

  /**
   * Calculate quality multiplier using linear interpolation.
   * Quality 50 -> 0.5x, Quality 100 -> 2.0x
   */
  private calculateQualityMultiplier(qualityScore: number): number {
    // Clamp quality score to valid range
    const clampedScore = Math.max(
      REWARD_CONFIG.MIN_QUALITY_THRESHOLD,
      Math.min(100, qualityScore)
    );

    // Linear interpolation: score 50 -> 0.5x, score 100 -> 2.0x
    const normalized = (clampedScore - 50) / 50; // 0 to 1
    return (
      REWARD_CONFIG.QUALITY_MULTIPLIER_MIN +
      normalized * (REWARD_CONFIG.QUALITY_MULTIPLIER_MAX - REWARD_CONFIG.QUALITY_MULTIPLIER_MIN)
    );
  }

  // --------------------------------------------------------------------------
  // Subtask 108.3: Mesh Reward Calculation
  // --------------------------------------------------------------------------

  /**
   * Calculate mesh rewards based on network participation.
   * Formula: (relayedMessages * BASE) * (1 + uptimeBonus + topologyBonus)
   */
  calculateMeshReward(input: MeshRewardInput): {
    reward: number;
    breakdown: {
      baseReward: number;
      uptimeBonus: number;
      topologyBonus: number;
    };
  } {
    // Base reward: per relayed message
    const baseReward = input.relayedMessages * REWARD_CONFIG.BASE_RELAY_REWARD;

    // Uptime bonus: nodes with >= 90% uptime get 20% bonus
    const uptimeBonus =
      input.uptimePercentage >= REWARD_CONFIG.UPTIME_BONUS_THRESHOLD
        ? baseReward * (REWARD_CONFIG.UPTIME_BONUS_MULTIPLIER - 1)
        : 0;

    // Topology importance bonus: based on neighbor count and network centrality
    let topologyBonus = 0;
    if (input.avgNeighborCount >= REWARD_CONFIG.NEIGHBOR_BONUS_THRESHOLD) {
      // Cap topology score at 1.0
      const cappedTopologyScore = Math.min(1, input.topologyImportanceScore);
      topologyBonus = baseReward * cappedTopologyScore * REWARD_CONFIG.TOPOLOGY_IMPORTANCE_WEIGHT;
    }

    const totalMeshReward = baseReward + uptimeBonus + topologyBonus;

    return {
      reward: totalMeshReward,
      breakdown: {
        baseReward,
        uptimeBonus,
        topologyBonus,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Combined Reward Calculation
  // --------------------------------------------------------------------------

  /**
   * Calculate total reward for a node, combining data and mesh rewards.
   */
  calculateTotalReward(input: NodeRewardInput): RewardCalculationResult {
    if (!isRewardEligibleForGeoFence(input.geoFenceStatus)) {
      return {
        dataReward: 0,
        meshReward: 0,
        totalReward: 0,
        cappedAmount: 0,
        capApplied: 'none',
        breakdown: {
          baseDataReward: 0,
          qualityMultiplier: 0,
          consistencyBonus: 0,
          spatialBonus: 0,
          baseMeshReward: 0,
          uptimeBonus: 0,
          topologyBonus: 0,
        },
      };
    }

    const dataResult = this.calculateDataReward(input.observationSummary);
    const meshResult = this.calculateMeshReward(input.meshSummary);

    const totalBeforeCap = dataResult.reward + meshResult.reward;

    return {
      dataReward: dataResult.reward,
      meshReward: meshResult.reward,
      totalReward: totalBeforeCap,
      cappedAmount: 0,
      capApplied: 'none',
      breakdown: {
        baseDataReward: dataResult.breakdown.baseReward,
        qualityMultiplier: dataResult.breakdown.qualityMultiplier,
        consistencyBonus: dataResult.breakdown.consistencyBonus,
        spatialBonus: dataResult.breakdown.spatialBonus,
        baseMeshReward: meshResult.breakdown.baseReward,
        uptimeBonus: meshResult.breakdown.uptimeBonus,
        topologyBonus: meshResult.breakdown.topologyBonus,
      },
    };
  }

  // --------------------------------------------------------------------------
  // Subtask 108.5: Anti-Gaming Measures
  // --------------------------------------------------------------------------

  /**
   * Apply reward caps to prevent gaming (daily, weekly, region limits).
   * Returns the capped reward amount and which cap was applied.
   */
  async applyRewardCaps(
    nodeId: string,
    wrfcoinAddress: string,
    calculatedReward: number,
    windowStart: Date,
    region?: string
  ): Promise<{ cappedReward: number; capType: 'none' | 'daily' | 'weekly' | 'region' }> {
    // Check daily cap
    const dayStart = new Date(windowStart);
    dayStart.setUTCHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

    const dailyEarnings = await this.getEarningsInPeriod(nodeId, dayStart, dayEnd);
    const remainingDaily = Math.max(0, REWARD_CONFIG.DAILY_CAP_PER_NODE - dailyEarnings);

    if (calculatedReward > remainingDaily) {
      await this.updateCapRecord(
        nodeId,
        wrfcoinAddress,
        'daily',
        dayStart,
        dayEnd,
        dailyEarnings + remainingDaily
      );
      return { cappedReward: remainingDaily, capType: 'daily' };
    }

    // Check weekly cap
    const weekStart = new Date(windowStart);
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    weekStart.setUTCHours(0, 0, 0, 0);
    const weekEnd = new Date(weekStart);
    weekEnd.setUTCDate(weekEnd.getUTCDate() + 7);

    const weeklyEarnings = await this.getEarningsInPeriod(nodeId, weekStart, weekEnd);
    const remainingWeekly = Math.max(0, REWARD_CONFIG.WEEKLY_CAP_PER_NODE - weeklyEarnings);

    if (calculatedReward > remainingWeekly) {
      await this.updateCapRecord(
        nodeId,
        wrfcoinAddress,
        'weekly',
        weekStart,
        weekEnd,
        weeklyEarnings + remainingWeekly
      );
      return { cappedReward: remainingWeekly, capType: 'weekly' };
    }

    // Check region cap (if region provided)
    if (region) {
      const regionEarnings = await this.getRegionEarningsInPeriod(region, dayStart, dayEnd);
      const remainingRegion = Math.max(0, REWARD_CONFIG.REGION_DAILY_CAP - regionEarnings);

      if (calculatedReward > remainingRegion) {
        await this.updateCapRecord(
          nodeId,
          wrfcoinAddress,
          'region',
          dayStart,
          dayEnd,
          regionEarnings + remainingRegion,
          region
        );
        return { cappedReward: remainingRegion, capType: 'region' };
      }
    }

    return { cappedReward: calculatedReward, capType: 'none' };
  }

  /**
   * Get total earnings for a node in a specific period.
   */
  private async getEarningsInPeriod(
    nodeId: string,
    start: Date,
    end: Date
  ): Promise<number> {
    const result = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${meshtasticRewardAggregations.totalReward}), 0)`,
      })
      .from(meshtasticRewardAggregations)
      .where(
        and(
          eq(meshtasticRewardAggregations.meshtasticNodeId, nodeId),
          gte(meshtasticRewardAggregations.windowStart, start),
          lte(meshtasticRewardAggregations.windowEnd, end),
          eq(meshtasticRewardAggregations.status, 'distributed')
        )
      );

    return parseFloat(result[0]?.total || '0');
  }

  /**
   * Get total earnings for a region in a specific period.
   */
  private async getRegionEarningsInPeriod(
    region: string,
    start: Date,
    end: Date
  ): Promise<number> {
    const result = await this.db
      .select({
        total: sql<string>`COALESCE(SUM(${meshtasticRewardCaps.totalEarned}), 0)`,
      })
      .from(meshtasticRewardCaps)
      .where(
        and(
          eq(meshtasticRewardCaps.region, region),
          eq(meshtasticRewardCaps.capType, 'region'),
          gte(meshtasticRewardCaps.periodStart, start),
          lte(meshtasticRewardCaps.periodEnd, end)
        )
      );

    return parseFloat(result[0]?.total || '0');
  }

  /**
   * Update or create a cap tracking record.
   */
  private async updateCapRecord(
    nodeId: string,
    wrfcoinAddress: string,
    capType: 'daily' | 'weekly' | 'region',
    periodStart: Date,
    periodEnd: Date,
    totalEarned: number,
    region?: string
  ): Promise<void> {
    const capLimit =
      capType === 'daily'
        ? REWARD_CONFIG.DAILY_CAP_PER_NODE
        : capType === 'weekly'
          ? REWARD_CONFIG.WEEKLY_CAP_PER_NODE
          : REWARD_CONFIG.REGION_DAILY_CAP;

    // Upsert cap record
    await this.db
      .insert(meshtasticRewardCaps)
      .values({
        meshtasticNodeId: nodeId,
        wrfcoinAddress,
        capType,
        periodStart,
        periodEnd,
        totalEarned: totalEarned.toString(),
        capLimit: capLimit.toString(),
        isCapReached: totalEarned >= capLimit,
        region,
      })
      .onConflictDoNothing();
  }

  // --------------------------------------------------------------------------
  // Node Metrics Aggregation
  // --------------------------------------------------------------------------

  /**
   * Aggregate observation and mesh metrics for a node in a time window.
   */
  async aggregateNodeMetrics(
    nodeId: string,
    windowStart: Date,
    windowEnd: Date
  ): Promise<NodeRewardInput | null> {
    // Get node info
    const nodes = await this.db
      .select()
      .from(meshtasticNodes)
      .where(eq(meshtasticNodes.meshtasticNodeId, nodeId))
      .limit(1);

    if (nodes.length === 0) return null;
    const node = nodes[0];

    // Aggregate observation metrics
    const obsMetrics = await this.db
      .select({
        observationCount: count(),
        validCount: sql<number>`COUNT(*) FILTER (WHERE ${meshtasticObservations.validationStatus} = 'valid')`,
        avgQuality: avg(meshtasticObservations.qualityScore),
        uniqueHours: sql<number>`COUNT(DISTINCT DATE_TRUNC('hour', ${meshtasticObservations.timestamp}))`,
      })
      .from(meshtasticObservations)
      .where(
        and(
          eq(meshtasticObservations.meshtasticNodeId, nodeId),
          gte(meshtasticObservations.timestamp, windowStart),
          lte(meshtasticObservations.timestamp, windowEnd)
        )
      );

    const obs = obsMetrics[0];

    // Get mesh metrics from node record
    const meshMetrics = node.meshMetrics as {
      neighborCount?: number;
      relayedMessages?: number;
      avgRssi?: number;
      avgSnr?: number;
    } | null;

    // Calculate uptime based on observation frequency
    // Expected: 1 observation per 15 minutes = 4 per hour
    const windowHours = (windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60);
    const expectedObservations = Math.floor(windowHours * 4);
    const uptimePercentage =
      expectedObservations > 0
        ? Math.min(100, (Number(obs.observationCount) / expectedObservations) * 100)
        : 0;

    return {
      nodeId: node.id.toString(),
      meshtasticNodeId: nodeId,
      wrfcoinAddress: node.wrfcoinAddress,
      geoFenceStatus: node.geoFenceStatus as GeoFenceReviewStatus,
      observationSummary: {
        observationCount: Number(obs.observationCount) || 0,
        validObservationCount: Number(obs.validCount) || 0,
        avgQualityScore: parseFloat(obs.avgQuality?.toString() || '0'),
        uniqueHoursContributed: Number(obs.uniqueHours) || 0,
        spatialCoverageBonus: 0, // Calculated separately based on H3 region coverage
      },
      meshSummary: {
        relayedMessages: meshMetrics?.relayedMessages || 0,
        uptimePercentage,
        avgNeighborCount: meshMetrics?.neighborCount || 0,
        topologyImportanceScore: this.calculateTopologyScore(meshMetrics?.neighborCount || 0),
      },
    };
  }

  /**
   * Calculate topology importance score based on neighbor count.
   * More neighbors = more important node in the mesh.
   */
  private calculateTopologyScore(neighborCount: number): number {
    // Simple topology importance: more neighbors = more important
    // Normalize to 0-1 scale (assuming max ~20 neighbors is exceptional)
    return Math.min(1, neighborCount / 20);
  }

  // --------------------------------------------------------------------------
  // Reward Distribution
  // --------------------------------------------------------------------------

  /**
   * Distribute reward to a wallet address and record the distribution.
   */
  async distributeReward(
    aggregationId: number,
    nodeId: string,
    wrfcoinAddress: string,
    amount: number,
    period: { start: Date; end: Date }
  ): Promise<{ success: boolean; transactionId?: string; error?: string }> {
    if (amount <= 0) {
      return { success: true, transactionId: undefined };
    }

    try {
      // Create distribution record
      const [distribution] = await this.db
        .insert(meshtasticRewardDistributions)
        .values({
          aggregationId,
          meshtasticNodeId: nodeId,
          wrfcoinAddress,
          amount: amount.toString(),
          rewardType: 'combined',
          periodStart: period.start,
          periodEnd: period.end,
          status: 'pending',
          metadata: {
            calculatedAt: new Date().toISOString(),
          },
        })
        .returning();

      // Generate transaction ID (actual wallet transfer handled by separate service)
      const transactionId = `mesh-reward-${distribution.id}-${Date.now()}`;

      // Update aggregation status
      await this.db
        .update(meshtasticRewardAggregations)
        .set({
          status: 'distributed',
          distributedAt: new Date(),
          transactionId,
          updatedAt: new Date(),
        })
        .where(eq(meshtasticRewardAggregations.id, aggregationId));

      // Update distribution with transaction ID
      await this.db
        .update(meshtasticRewardDistributions)
        .set({
          transactionId,
          status: 'submitted',
        })
        .where(eq(meshtasticRewardDistributions.id, distribution.id));

      return { success: true, transactionId };
    } catch (error) {
      iotLogger.error('[MeshtasticReward] Distribution error', { error });
      return { success: false, error: (error as Error).message };
    }
  }

  // --------------------------------------------------------------------------
  // Query Methods for API Endpoints
  // --------------------------------------------------------------------------

  /**
   * Get reward history for a specific node.
   */
  async getNodeRewardHistory(
    nodeId: string,
    limit: number = 50,
    offset: number = 0
  ): Promise<{
    aggregations: typeof meshtasticRewardAggregations.$inferSelect[];
    totals: { totalDataReward: number; totalMeshReward: number; totalReward: number };
  }> {
    const aggregations = await this.db
      .select()
      .from(meshtasticRewardAggregations)
      .where(eq(meshtasticRewardAggregations.meshtasticNodeId, nodeId))
      .orderBy(desc(meshtasticRewardAggregations.windowEnd))
      .limit(limit)
      .offset(offset);

    const totalsResult = await this.db
      .select({
        totalDataReward: sql<string>`COALESCE(SUM(${meshtasticRewardAggregations.dataReward}), 0)`,
        totalMeshReward: sql<string>`COALESCE(SUM(${meshtasticRewardAggregations.meshReward}), 0)`,
        totalReward: sql<string>`COALESCE(SUM(${meshtasticRewardAggregations.totalReward}), 0)`,
      })
      .from(meshtasticRewardAggregations)
      .where(eq(meshtasticRewardAggregations.meshtasticNodeId, nodeId));

    return {
      aggregations,
      totals: {
        totalDataReward: parseFloat(totalsResult[0]?.totalDataReward || '0'),
        totalMeshReward: parseFloat(totalsResult[0]?.totalMeshReward || '0'),
        totalReward: parseFloat(totalsResult[0]?.totalReward || '0'),
      },
    };
  }

  /**
   * Get network-wide reward summary for a period.
   */
  async getNetworkRewardSummary(periodHours: number = 24): Promise<{
    totalNodes: number;
    totalRewards: number;
    totalDataRewards: number;
    totalMeshRewards: number;
    avgQualityScore: number;
    totalObservations: number;
  }> {
    const since = new Date(Date.now() - periodHours * 60 * 60 * 1000);

    const summary = await this.db
      .select({
        totalNodes: sql<number>`COUNT(DISTINCT ${meshtasticRewardAggregations.meshtasticNodeId})`,
        totalRewards: sql<string>`COALESCE(SUM(${meshtasticRewardAggregations.totalReward}), 0)`,
        totalDataRewards: sql<string>`COALESCE(SUM(${meshtasticRewardAggregations.dataReward}), 0)`,
        totalMeshRewards: sql<string>`COALESCE(SUM(${meshtasticRewardAggregations.meshReward}), 0)`,
        avgQualityScore: avg(meshtasticRewardAggregations.avgQualityScore),
        totalObservations: sql<number>`COALESCE(SUM(${meshtasticRewardAggregations.validObservationCount}), 0)`,
      })
      .from(meshtasticRewardAggregations)
      .where(gte(meshtasticRewardAggregations.windowStart, since));

    return {
      totalNodes: Number(summary[0]?.totalNodes) || 0,
      totalRewards: parseFloat(summary[0]?.totalRewards || '0'),
      totalDataRewards: parseFloat(summary[0]?.totalDataRewards || '0'),
      totalMeshRewards: parseFloat(summary[0]?.totalMeshRewards || '0'),
      avgQualityScore: parseFloat(summary[0]?.avgQualityScore?.toString() || '0'),
      totalObservations: Number(summary[0]?.totalObservations) || 0,
    };
  }

  /**
   * Get leaderboard of top earning nodes.
   */
  async getLeaderboard(
    periodHours: number = 168, // Default 7 days
    limit: number = 20
  ): Promise<
    {
      meshtasticNodeId: string;
      wrfcoinAddress: string | null;
      totalReward: number;
      totalObservations: number;
      avgQuality: number;
    }[]
  > {
    const since = new Date(Date.now() - periodHours * 60 * 60 * 1000);

    const leaderboard = await this.db
      .select({
        meshtasticNodeId: meshtasticRewardAggregations.meshtasticNodeId,
        wrfcoinAddress: meshtasticRewardAggregations.wrfcoinAddress,
        totalReward: sql<string>`SUM(${meshtasticRewardAggregations.totalReward})`,
        totalObservations: sql<number>`SUM(${meshtasticRewardAggregations.validObservationCount})`,
        avgQuality: avg(meshtasticRewardAggregations.avgQualityScore),
      })
      .from(meshtasticRewardAggregations)
      .where(gte(meshtasticRewardAggregations.windowStart, since))
      .groupBy(
        meshtasticRewardAggregations.meshtasticNodeId,
        meshtasticRewardAggregations.wrfcoinAddress
      )
      .orderBy(desc(sql`SUM(${meshtasticRewardAggregations.totalReward})`))
      .limit(limit);

    return leaderboard.map(row => ({
      meshtasticNodeId: row.meshtasticNodeId,
      wrfcoinAddress: row.wrfcoinAddress,
      totalReward: parseFloat(row.totalReward || '0'),
      totalObservations: Number(row.totalObservations) || 0,
      avgQuality: parseFloat(row.avgQuality?.toString() || '0'),
    }));
  }
}
