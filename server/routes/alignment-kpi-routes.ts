/**
 * Alignment KPI Routes -- implements backend#34.
 *
 * Privacy-safe, aggregated KPI endpoints for measuring platform alignment
 * progress. All endpoints return aggregate metrics only -- NO individual
 * user IDs, wallet addresses, or PII are ever exposed.
 *
 * Mount path: /api/kpi/alignment
 *
 * Register in server/server.js:
 *   const alignmentKpiRoutes = require('./routes/alignment-kpi-routes');
 *   app.use('/api/kpi/alignment', alignmentKpiRoutes.default || alignmentKpiRoutes);
 */

import * as express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { db } from '../../database/index.js';
import { sql, desc } from 'drizzle-orm';
import {
  forecastCoverageMetrics,
  contributorRewards,
} from '../../shared/schema.js';
import { sanctionsOrchestrationService } from '../services/sanctions-orchestration-service.js';
import { appLogger } from '../utils/logger.js';
import type { Request, Response } from 'express';

const router = express.Router();

// All KPI operations require authentication (#231)
router.use(authenticateJWT);

/**
 * GET /api/kpi/alignment/forecast-coverage
 *
 * Aggregated forecast coverage and accuracy by region.
 * Returns region-level stats and platform-wide averages.
 * No individual contributor data is exposed.
 */
router.get('/forecast-coverage', async (_req: Request, res: Response) => {
  try {
    // Aggregate most recent metrics per region
    const regionMetrics = await db
      .select({
        region: forecastCoverageMetrics.region,
        avgCoverage: sql<number>`ROUND(AVG(${forecastCoverageMetrics.coverage}), 2)`,
        avgAccuracy: sql<number>`ROUND(AVG(${forecastCoverageMetrics.accuracy}), 2)`,
        dataPoints: sql<number>`COUNT(*)`,
        latestReportedAt: sql<string>`MAX(${forecastCoverageMetrics.createdAt})`,
      })
      .from(forecastCoverageMetrics)
      .groupBy(forecastCoverageMetrics.region)
      .orderBy(forecastCoverageMetrics.region);

    // Platform-wide averages
    const [platformAvg] = await db
      .select({
        avgCoverage: sql<number>`ROUND(AVG(${forecastCoverageMetrics.coverage}), 2)`,
        avgAccuracy: sql<number>`ROUND(AVG(${forecastCoverageMetrics.accuracy}), 2)`,
        totalDataPoints: sql<number>`COUNT(*)`,
        totalRegions: sql<number>`COUNT(DISTINCT ${forecastCoverageMetrics.region})`,
      })
      .from(forecastCoverageMetrics);

    return res.json({
      success: true,
      data: {
        regions: regionMetrics,
        platformAverages: platformAvg || {
          avgCoverage: 0,
          avgAccuracy: 0,
          totalDataPoints: 0,
          totalRegions: 0,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Error fetching alignment forecast coverage KPI', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json({
      success: false,
      error: 'Error fetching forecast coverage KPI',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/kpi/alignment/participation
 *
 * Aggregated contributor participation and reward distribution by type.
 * Returns counts and totals only -- no individual user data.
 */
router.get('/participation', async (_req: Request, res: Response) => {
  try {
    const participationByType = await db
      .select({
        contributorType: contributorRewards.contributorType,
        activeContributors: sql<number>`COUNT(DISTINCT ${contributorRewards.userId})`,
        totalRewardsDistributed: sql<number>`COALESCE(SUM(${contributorRewards.amount}), 0)`,
        rewardTransactions: sql<number>`COUNT(*)`,
      })
      .from(contributorRewards)
      .groupBy(contributorRewards.contributorType)
      .orderBy(contributorRewards.contributorType);

    // Compute mean reward per contributor for each type
    const typesWithMean = participationByType.map(row => ({
      contributorType: row.contributorType,
      activeContributors: Number(row.activeContributors),
      totalRewardsDistributed: Number(row.totalRewardsDistributed),
      rewardTransactions: Number(row.rewardTransactions),
      meanRewardPerContributor:
        Number(row.activeContributors) > 0
          ? Math.round(Number(row.totalRewardsDistributed) / Number(row.activeContributors))
          : 0,
    }));

    // Platform totals
    const totals = typesWithMean.reduce(
      (acc, row) => {
        acc.totalContributors += row.activeContributors;
        acc.totalRewards += row.totalRewardsDistributed;
        acc.totalTransactions += row.rewardTransactions;
        return acc;
      },
      { totalContributors: 0, totalRewards: 0, totalTransactions: 0 },
    );

    return res.json({
      success: true,
      data: {
        byType: typesWithMean,
        platformTotals: {
          ...totals,
          meanRewardPerContributor:
            totals.totalContributors > 0
              ? Math.round(totals.totalRewards / totals.totalContributors)
              : 0,
        },
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Error fetching alignment participation KPI', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json({
      success: false,
      error: 'Error fetching participation KPI',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/kpi/alignment/integrity
 *
 * Aggregated sanctions and integrity metrics.
 * Returns category- and actor-class-level breakdowns without
 * exposing individual case details, actor IDs, or PII.
 */
router.get('/integrity', async (_req: Request, res: Response) => {
  try {
    const integrityKpi = sanctionsOrchestrationService.getAggregatedIntegrityKpi();
    const metrics = sanctionsOrchestrationService.getMetrics();

    return res.json({
      success: true,
      data: {
        totalActiveSanctions: integrityKpi.totalActiveSanctions,
        sanctionsByOffenseCategory: integrityKpi.sanctionsByOffenseCategory,
        sanctionsByActorClass: integrityKpi.sanctionsByActorClass,
        appealRate: integrityKpi.appealRate,
        overturnRate: integrityKpi.overturnRate,
        medianResolutionHours: metrics.medianResolutionHours,
        totalCasesAllTime: metrics.totalCases,
        closedCases: metrics.closedCases,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    appLogger.error('Error fetching alignment integrity KPI', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json({
      success: false,
      error: 'Error fetching integrity KPI',
      timestamp: new Date().toISOString(),
    });
  }
});

/**
 * GET /api/kpi/alignment/summary
 *
 * Combined alignment dashboard -- aggregates forecast-coverage,
 * participation, and integrity KPIs into a single response.
 * Includes a data freshness indicator.
 */
router.get('/summary', async (_req: Request, res: Response) => {
  try {
    const now = new Date();

    // --- Forecast coverage ---
    const [platformCoverage] = await db
      .select({
        avgCoverage: sql<number>`ROUND(AVG(${forecastCoverageMetrics.coverage}), 2)`,
        avgAccuracy: sql<number>`ROUND(AVG(${forecastCoverageMetrics.accuracy}), 2)`,
        totalRegions: sql<number>`COUNT(DISTINCT ${forecastCoverageMetrics.region})`,
        latestEntry: sql<string>`MAX(${forecastCoverageMetrics.createdAt})`,
      })
      .from(forecastCoverageMetrics);

    // --- Participation ---
    const [participationTotals] = await db
      .select({
        totalContributors: sql<number>`COUNT(DISTINCT ${contributorRewards.userId})`,
        totalRewards: sql<number>`COALESCE(SUM(${contributorRewards.amount}), 0)`,
        contributorTypes: sql<number>`COUNT(DISTINCT ${contributorRewards.contributorType})`,
        latestEntry: sql<string>`MAX(${contributorRewards.createdAt})`,
      })
      .from(contributorRewards);

    // --- Integrity ---
    const integrityKpi = sanctionsOrchestrationService.getAggregatedIntegrityKpi();
    const sanctionMetrics = sanctionsOrchestrationService.getMetrics();

    // Determine data freshness
    const coverageLatest = platformCoverage?.latestEntry
      ? new Date(platformCoverage.latestEntry)
      : null;
    const participationLatest = participationTotals?.latestEntry
      ? new Date(participationTotals.latestEntry)
      : null;
    const latestDataPoint = [coverageLatest, participationLatest]
      .filter(Boolean)
      .sort((a, b) => (b as Date).getTime() - (a as Date).getTime())[0] as Date | undefined;

    const dataFreshnessMs = latestDataPoint
      ? now.getTime() - latestDataPoint.getTime()
      : null;

    return res.json({
      success: true,
      data: {
        forecastCoverage: {
          avgCoverage: platformCoverage?.avgCoverage ?? 0,
          avgAccuracy: platformCoverage?.avgAccuracy ?? 0,
          totalRegions: Number(platformCoverage?.totalRegions ?? 0),
        },
        participation: {
          totalContributors: Number(participationTotals?.totalContributors ?? 0),
          totalRewards: Number(participationTotals?.totalRewards ?? 0),
          contributorTypes: Number(participationTotals?.contributorTypes ?? 0),
          meanRewardPerContributor:
            Number(participationTotals?.totalContributors ?? 0) > 0
              ? Math.round(
                  Number(participationTotals.totalRewards) /
                    Number(participationTotals.totalContributors),
                )
              : 0,
        },
        integrity: {
          totalActiveSanctions: integrityKpi.totalActiveSanctions,
          sanctionsByOffenseCategory: integrityKpi.sanctionsByOffenseCategory,
          sanctionsByActorClass: integrityKpi.sanctionsByActorClass,
          appealRate: integrityKpi.appealRate,
          overturnRate: integrityKpi.overturnRate,
          medianResolutionHours: sanctionMetrics.medianResolutionHours,
        },
      },
      timestamp: now.toISOString(),
      dataFreshness: {
        latestDataPoint: latestDataPoint?.toISOString() ?? null,
        ageMs: dataFreshnessMs,
        stale: dataFreshnessMs !== null ? dataFreshnessMs > 24 * 60 * 60 * 1000 : null,
      },
    });
  } catch (error) {
    appLogger.error('Error fetching alignment summary KPI', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json({
      success: false,
      error: 'Error fetching alignment summary KPI',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
