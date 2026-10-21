/**
 * Meshtastic Reward Aggregation Job
 *
 * Scheduled job for aggregating metrics and calculating rewards per node per time window.
 * Task 108.1: Periodic Aggregation Job
 *
 * Aggregation windows:
 * - Hourly (1h): Runs at the start of each hour
 * - Daily (24h): Runs at midnight UTC
 */

import { eq, and, gte, lte, sql, desc } from 'drizzle-orm';
import type { NeonDatabase } from 'drizzle-orm/neon-serverless';
import {
  meshtasticNodes,
  meshtasticObservations,
  meshtasticRewardAggregations,
} from '../../shared/schema-meshtastic.js';
import { MeshtasticRewardService, REWARD_CONFIG } from '../services/meshtastic-reward-service.js';

// ============================================================================
// Configuration
// ============================================================================

export interface AggregationConfig {
  windowType: '1h' | '24h';
  windowDurationMs: number;
  scheduleIntervalMs: number;
  enableDistribution: boolean;
  dryRun: boolean;
}

const AGGREGATION_CONFIGS: Record<string, AggregationConfig> = {
  hourly: {
    windowType: '1h',
    windowDurationMs: 60 * 60 * 1000, // 1 hour
    scheduleIntervalMs: 60 * 60 * 1000, // Run every hour
    enableDistribution: false, // Hourly is for tracking only
    dryRun: false,
  },
  daily: {
    windowType: '24h',
    windowDurationMs: 24 * 60 * 60 * 1000, // 24 hours
    scheduleIntervalMs: 24 * 60 * 60 * 1000, // Run every 24 hours
    enableDistribution: true, // Daily triggers actual reward distribution
    dryRun: false,
  },
};

// ============================================================================
// Types
// ============================================================================

export interface AggregationResult {
  nodeId: string;
  meshtasticNodeId: string;
  wrfcoinAddress: string | null;
  windowStart: Date;
  windowEnd: Date;
  windowType: '1h' | '24h';
  metrics: {
    observationCount: number;
    validObservationCount: number;
    avgQualityScore: number;
    uniqueHoursContributed: number;
    relayedMessages: number;
    uptimePercentage: number;
  };
  rewards: {
    dataReward: number;
    meshReward: number;
    totalReward: number;
    cappedAmount: number;
    capApplied: string;
  };
  status: 'pending' | 'distributed' | 'skipped' | 'capped' | 'failed';
  aggregationId?: number;
  error?: string;
}

export interface AggregationJobResult {
  windowStart: Date;
  windowEnd: Date;
  windowType: '1h' | '24h';
  nodesProcessed: number;
  nodesSkipped: number;
  nodesFailed: number;
  totalRewardsCalculated: number;
  totalRewardsDistributed: number;
  results: AggregationResult[];
  startTime: Date;
  endTime: Date;
  durationMs: number;
}

// ============================================================================
// MeshtasticRewardAggregationJob Class
// ============================================================================

export class MeshtasticRewardAggregationJob {
  private rewardService: MeshtasticRewardService;
  private hourlyIntervalId: NodeJS.Timeout | null = null;
  private dailyIntervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  constructor(private db: NeonDatabase<Record<string, unknown>>) {
    this.rewardService = new MeshtasticRewardService(db);
  }

  // --------------------------------------------------------------------------
  // Scheduler Methods
  // --------------------------------------------------------------------------

  /**
   * Start the reward aggregation scheduler.
   * Schedules both hourly and daily aggregation jobs.
   */
  startScheduler(): void {
    if (this.isRunning) {
      console.log('[MeshtasticRewardAggregation] Scheduler already running');
      return;
    }

    this.isRunning = true;
    console.log('[MeshtasticRewardAggregation] Starting reward aggregation scheduler');

    // Schedule hourly aggregation
    this.scheduleHourlyAggregation();

    // Schedule daily aggregation
    this.scheduleDailyAggregation();

    console.log('[MeshtasticRewardAggregation] Scheduler started successfully');
  }

  /**
   * Stop the reward aggregation scheduler.
   */
  stopScheduler(): void {
    if (!this.isRunning) {
      console.log('[MeshtasticRewardAggregation] Scheduler not running');
      return;
    }

    if (this.hourlyIntervalId) {
      clearInterval(this.hourlyIntervalId);
      this.hourlyIntervalId = null;
    }

    if (this.dailyIntervalId) {
      clearInterval(this.dailyIntervalId);
      this.dailyIntervalId = null;
    }

    this.isRunning = false;
    console.log('[MeshtasticRewardAggregation] Scheduler stopped');
  }

  /**
   * Schedule hourly aggregation to run at the start of each hour.
   */
  private scheduleHourlyAggregation(): void {
    const config = AGGREGATION_CONFIGS.hourly;

    // Calculate time until next hour
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setMinutes(0, 0, 0);
    nextHour.setHours(nextHour.getHours() + 1);
    const msUntilNextHour = nextHour.getTime() - now.getTime();

    console.log(
      `[MeshtasticRewardAggregation] Hourly aggregation scheduled to start in ${Math.round(msUntilNextHour / 1000 / 60)} minutes`
    );

    // Run first aggregation at next hour, then every hour
    setTimeout(() => {
      // Run immediately at start of hour
      this.runHourlyAggregation().catch(err => {
        console.error('[MeshtasticRewardAggregation] Hourly aggregation error:', err);
      });

      // Then run every hour
      this.hourlyIntervalId = setInterval(() => {
        this.runHourlyAggregation().catch(err => {
          console.error('[MeshtasticRewardAggregation] Hourly aggregation error:', err);
        });
      }, config.scheduleIntervalMs);
    }, msUntilNextHour);
  }

  /**
   * Schedule daily aggregation to run at midnight UTC.
   */
  private scheduleDailyAggregation(): void {
    const config = AGGREGATION_CONFIGS.daily;

    // Calculate time until next midnight UTC
    const now = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setUTCHours(24, 0, 0, 0);
    const msUntilMidnight = nextMidnight.getTime() - now.getTime();

    console.log(
      `[MeshtasticRewardAggregation] Daily aggregation scheduled to start in ${Math.round(msUntilMidnight / 1000 / 60 / 60)} hours`
    );

    // Run first aggregation at next midnight, then every 24 hours
    setTimeout(() => {
      // Run immediately at midnight
      this.runDailyAggregation().catch(err => {
        console.error('[MeshtasticRewardAggregation] Daily aggregation error:', err);
      });

      // Then run every 24 hours
      this.dailyIntervalId = setInterval(() => {
        this.runDailyAggregation().catch(err => {
          console.error('[MeshtasticRewardAggregation] Daily aggregation error:', err);
        });
      }, config.scheduleIntervalMs);
    }, msUntilMidnight);
  }

  // --------------------------------------------------------------------------
  // Aggregation Methods
  // --------------------------------------------------------------------------

  /**
   * Run hourly aggregation for the previous hour.
   */
  async runHourlyAggregation(): Promise<AggregationJobResult> {
    const config = AGGREGATION_CONFIGS.hourly;

    // Calculate window: previous hour
    const windowEnd = new Date();
    windowEnd.setMinutes(0, 0, 0);
    const windowStart = new Date(windowEnd.getTime() - config.windowDurationMs);

    console.log(
      `[MeshtasticRewardAggregation] Running hourly aggregation: ${windowStart.toISOString()} - ${windowEnd.toISOString()}`
    );

    return this.runAggregation(config, windowStart, windowEnd);
  }

  /**
   * Run daily aggregation for the previous 24 hours.
   */
  async runDailyAggregation(): Promise<AggregationJobResult> {
    const config = AGGREGATION_CONFIGS.daily;

    // Calculate window: previous 24 hours (midnight to midnight)
    const windowEnd = new Date();
    windowEnd.setUTCHours(0, 0, 0, 0);
    const windowStart = new Date(windowEnd.getTime() - config.windowDurationMs);

    console.log(
      `[MeshtasticRewardAggregation] Running daily aggregation: ${windowStart.toISOString()} - ${windowEnd.toISOString()}`
    );

    return this.runAggregation(config, windowStart, windowEnd);
  }

  /**
   * Run aggregation for a specific time window.
   */
  async runAggregation(
    config: AggregationConfig,
    windowStart: Date,
    windowEnd: Date
  ): Promise<AggregationJobResult> {
    const startTime = new Date();
    const results: AggregationResult[] = [];
    let nodesProcessed = 0;
    let nodesSkipped = 0;
    let nodesFailed = 0;
    let totalRewardsCalculated = 0;
    let totalRewardsDistributed = 0;

    try {
      // Get all nodes with observations in the window
      const activeNodes = await this.getActiveNodesInWindow(windowStart, windowEnd);

      console.log(
        `[MeshtasticRewardAggregation] Found ${activeNodes.length} active nodes for ${config.windowType} window`
      );

      // Process each node
      for (const node of activeNodes) {
        try {
          const result = await this.processNodeAggregation(
            node.meshtasticNodeId,
            node.wrfcoinAddress,
            windowStart,
            windowEnd,
            config
          );

          if (result.status === 'skipped') {
            nodesSkipped++;
          } else {
            nodesProcessed++;
            totalRewardsCalculated += result.rewards.totalReward;

            if (result.status === 'distributed') {
              totalRewardsDistributed += result.rewards.cappedAmount;
            }
          }

          results.push(result);
        } catch (error) {
          nodesFailed++;
          results.push({
            nodeId: '',
            meshtasticNodeId: node.meshtasticNodeId,
            wrfcoinAddress: node.wrfcoinAddress,
            windowStart,
            windowEnd,
            windowType: config.windowType,
            metrics: {
              observationCount: 0,
              validObservationCount: 0,
              avgQualityScore: 0,
              uniqueHoursContributed: 0,
              relayedMessages: 0,
              uptimePercentage: 0,
            },
            rewards: {
              dataReward: 0,
              meshReward: 0,
              totalReward: 0,
              cappedAmount: 0,
              capApplied: 'none',
            },
            status: 'failed',
            error: (error as Error).message,
          });
        }
      }

      const endTime = new Date();

      console.log(
        `[MeshtasticRewardAggregation] ${config.windowType} aggregation complete: ` +
          `${nodesProcessed} processed, ${nodesSkipped} skipped, ${nodesFailed} failed, ` +
          `${totalRewardsCalculated.toFixed(4)} WRF calculated, ${totalRewardsDistributed.toFixed(4)} WRF distributed`
      );

      return {
        windowStart,
        windowEnd,
        windowType: config.windowType,
        nodesProcessed,
        nodesSkipped,
        nodesFailed,
        totalRewardsCalculated,
        totalRewardsDistributed,
        results,
        startTime,
        endTime,
        durationMs: endTime.getTime() - startTime.getTime(),
      };
    } catch (error) {
      console.error('[MeshtasticRewardAggregation] Fatal aggregation error:', error);
      throw error;
    }
  }

  /**
   * Process reward aggregation for a single node.
   */
  private async processNodeAggregation(
    meshtasticNodeId: string,
    wrfcoinAddress: string | null,
    windowStart: Date,
    windowEnd: Date,
    config: AggregationConfig
  ): Promise<AggregationResult> {
    // Skip nodes without wallet address (not registered for rewards)
    if (!wrfcoinAddress) {
      return {
        nodeId: '',
        meshtasticNodeId,
        wrfcoinAddress,
        windowStart,
        windowEnd,
        windowType: config.windowType,
        metrics: {
          observationCount: 0,
          validObservationCount: 0,
          avgQualityScore: 0,
          uniqueHoursContributed: 0,
          relayedMessages: 0,
          uptimePercentage: 0,
        },
        rewards: {
          dataReward: 0,
          meshReward: 0,
          totalReward: 0,
          cappedAmount: 0,
          capApplied: 'none',
        },
        status: 'skipped',
      };
    }

    // Aggregate node metrics
    const nodeMetrics = await this.rewardService.aggregateNodeMetrics(
      meshtasticNodeId,
      windowStart,
      windowEnd
    );

    if (!nodeMetrics) {
      return {
        nodeId: '',
        meshtasticNodeId,
        wrfcoinAddress,
        windowStart,
        windowEnd,
        windowType: config.windowType,
        metrics: {
          observationCount: 0,
          validObservationCount: 0,
          avgQualityScore: 0,
          uniqueHoursContributed: 0,
          relayedMessages: 0,
          uptimePercentage: 0,
        },
        rewards: {
          dataReward: 0,
          meshReward: 0,
          totalReward: 0,
          cappedAmount: 0,
          capApplied: 'none',
        },
        status: 'skipped',
      };
    }

    // Calculate rewards
    const rewardCalc = this.rewardService.calculateTotalReward(nodeMetrics);

    // Apply caps
    const { cappedReward, capType } = await this.rewardService.applyRewardCaps(
      meshtasticNodeId,
      wrfcoinAddress,
      rewardCalc.totalReward,
      windowStart
    );

    // Store aggregation record
    const [aggregation] = await this.db
      .insert(meshtasticRewardAggregations)
      .values({
        meshtasticNodeId,
        wrfcoinAddress,
        windowStart,
        windowEnd,
        windowType: config.windowType,
        observationCount: nodeMetrics.observationSummary.observationCount,
        validObservationCount: nodeMetrics.observationSummary.validObservationCount,
        avgQualityScore: nodeMetrics.observationSummary.avgQualityScore.toFixed(2),
        uniqueHoursContributed: nodeMetrics.observationSummary.uniqueHoursContributed,
        spatialCoverageBonus: nodeMetrics.observationSummary.spatialCoverageBonus.toFixed(2),
        relayedMessages: nodeMetrics.meshSummary.relayedMessages,
        uptimePercentage: nodeMetrics.meshSummary.uptimePercentage.toFixed(2),
        avgNeighborCount: nodeMetrics.meshSummary.avgNeighborCount.toFixed(2),
        topologyImportanceScore: nodeMetrics.meshSummary.topologyImportanceScore.toFixed(2),
        dataReward: rewardCalc.dataReward.toFixed(8),
        meshReward: rewardCalc.meshReward.toFixed(8),
        totalReward: cappedReward.toFixed(8),
        status: capType !== 'none' ? 'capped' : 'pending',
      })
      .returning();

    let status: AggregationResult['status'] = capType !== 'none' ? 'capped' : 'pending';

    // Distribute rewards if enabled and amount > 0
    if (config.enableDistribution && !config.dryRun && cappedReward > 0) {
      const distribution = await this.rewardService.distributeReward(
        aggregation.id,
        meshtasticNodeId,
        wrfcoinAddress,
        cappedReward,
        { start: windowStart, end: windowEnd }
      );

      if (distribution.success) {
        status = 'distributed';
      } else {
        status = 'failed';
      }
    }

    return {
      nodeId: nodeMetrics.nodeId,
      meshtasticNodeId,
      wrfcoinAddress,
      windowStart,
      windowEnd,
      windowType: config.windowType,
      metrics: {
        observationCount: nodeMetrics.observationSummary.observationCount,
        validObservationCount: nodeMetrics.observationSummary.validObservationCount,
        avgQualityScore: nodeMetrics.observationSummary.avgQualityScore,
        uniqueHoursContributed: nodeMetrics.observationSummary.uniqueHoursContributed,
        relayedMessages: nodeMetrics.meshSummary.relayedMessages,
        uptimePercentage: nodeMetrics.meshSummary.uptimePercentage,
      },
      rewards: {
        dataReward: rewardCalc.dataReward,
        meshReward: rewardCalc.meshReward,
        totalReward: rewardCalc.totalReward,
        cappedAmount: cappedReward,
        capApplied: capType,
      },
      status,
      aggregationId: aggregation.id,
    };
  }

  /**
   * Get all nodes that have observations in the time window.
   */
  private async getActiveNodesInWindow(
    windowStart: Date,
    windowEnd: Date
  ): Promise<{ meshtasticNodeId: string; wrfcoinAddress: string | null }[]> {
    // Get distinct nodes with observations in window
    const nodesWithObservations = await this.db
      .selectDistinct({
        meshtasticNodeId: meshtasticObservations.meshtasticNodeId,
      })
      .from(meshtasticObservations)
      .where(
        and(
          gte(meshtasticObservations.timestamp, windowStart),
          lte(meshtasticObservations.timestamp, windowEnd)
        )
      );

    if (nodesWithObservations.length === 0) {
      return [];
    }

    // Get node details including wallet address
    const nodeIds = nodesWithObservations.map(n => n.meshtasticNodeId);
    const nodes = await this.db
      .select({
        meshtasticNodeId: meshtasticNodes.meshtasticNodeId,
        wrfcoinAddress: meshtasticNodes.wrfcoinAddress,
      })
      .from(meshtasticNodes)
      .where(sql`${meshtasticNodes.meshtasticNodeId} IN ${nodeIds}`);

    return nodes;
  }

  // --------------------------------------------------------------------------
  // Manual Trigger Methods
  // --------------------------------------------------------------------------

  /**
   * Trigger a manual aggregation for a specific time window.
   * Useful for testing, backfilling, or re-running failed aggregations.
   */
  async triggerManualAggregation(
    windowType: '1h' | '24h',
    startTime?: Date,
    endTime?: Date,
    options?: { dryRun?: boolean; enableDistribution?: boolean }
  ): Promise<AggregationJobResult> {
    const baseConfig = AGGREGATION_CONFIGS[windowType === '1h' ? 'hourly' : 'daily'];

    const config: AggregationConfig = {
      ...baseConfig,
      dryRun: options?.dryRun ?? false,
      enableDistribution: options?.enableDistribution ?? baseConfig.enableDistribution,
    };

    // Calculate default window if not provided
    let windowStart: Date;
    let windowEnd: Date;

    if (startTime && endTime) {
      windowStart = startTime;
      windowEnd = endTime;
    } else if (startTime) {
      windowStart = startTime;
      windowEnd = new Date(startTime.getTime() + config.windowDurationMs);
    } else {
      // Default: previous window
      windowEnd = new Date();
      if (windowType === '1h') {
        windowEnd.setMinutes(0, 0, 0);
      } else {
        windowEnd.setUTCHours(0, 0, 0, 0);
      }
      windowStart = new Date(windowEnd.getTime() - config.windowDurationMs);
    }

    console.log(
      `[MeshtasticRewardAggregation] Manual ${windowType} aggregation triggered: ${windowStart.toISOString()} - ${windowEnd.toISOString()}`
    );

    return this.runAggregation(config, windowStart, windowEnd);
  }

  /**
   * Get aggregation status for a specific window.
   */
  async getAggregationStatus(
    windowStart: Date,
    windowEnd: Date,
    windowType: '1h' | '24h'
  ): Promise<{
    exists: boolean;
    count: number;
    totalRewards: number;
    statuses: Record<string, number>;
  }> {
    const aggregations = await this.db
      .select({
        status: meshtasticRewardAggregations.status,
        totalReward: meshtasticRewardAggregations.totalReward,
      })
      .from(meshtasticRewardAggregations)
      .where(
        and(
          eq(meshtasticRewardAggregations.windowStart, windowStart),
          eq(meshtasticRewardAggregations.windowEnd, windowEnd),
          eq(meshtasticRewardAggregations.windowType, windowType)
        )
      );

    const statuses: Record<string, number> = {};
    let totalRewards = 0;

    for (const agg of aggregations) {
      const status = agg.status || 'pending';
      statuses[status] = (statuses[status] || 0) + 1;
      totalRewards += parseFloat(agg.totalReward || '0');
    }

    return {
      exists: aggregations.length > 0,
      count: aggregations.length,
      totalRewards,
      statuses,
    };
  }
}

// ============================================================================
// Singleton Instance Helper
// ============================================================================

let aggregationJobInstance: MeshtasticRewardAggregationJob | null = null;

/**
 * Get or create the singleton aggregation job instance.
 */
export function getAggregationJob(
  db: NeonDatabase<Record<string, unknown>>
): MeshtasticRewardAggregationJob {
  if (!aggregationJobInstance) {
    aggregationJobInstance = new MeshtasticRewardAggregationJob(db);
  }
  return aggregationJobInstance;
}

/**
 * Start the reward aggregation scheduler.
 */
export function startRewardAggregationScheduler(
  db: NeonDatabase<Record<string, unknown>>
): MeshtasticRewardAggregationJob {
  const job = getAggregationJob(db);
  job.startScheduler();
  return job;
}

/**
 * Stop the reward aggregation scheduler.
 */
export function stopRewardAggregationScheduler(): void {
  if (aggregationJobInstance) {
    aggregationJobInstance.stopScheduler();
  }
}
