/**
 * Public contributor summary endpoint — closes backend#684.
 *
 * Route:
 *   GET /api/contributor/:address/summary
 *
 * Returns a single consolidated payload for a contributor's public profile,
 * fanning out to streak, reputation, rewards, referrals, and submission services
 * in parallel. Redis-caches the result for 30 s.
 */

import express from 'express';
import { Counter } from 'prom-client';
import { metricsRegistry } from '../utils/metrics.js';
import { createRedisClient } from '../utils/create-redis.js';
import {
  createRateLimitMiddleware,
  RATE_LIMIT_PRESETS,
} from '../../shared/middleware/rate-limit-redis.js';
import { getStreakSummary } from '../services/streak-service.js';
import { reputationScoringEngine } from '../services/reputation/reputation-scoring-engine.js';
import { appLogger } from '../utils/logger.js';
import { createApiError } from '../utils/api-error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

interface ContributorSummary {
  address: string;
  display_name: string | null;
  joined_at: string | null;
  current_streak_days: number;
  longest_streak_days: number;
  total_submissions_30d: number;
  quality_score_avg: number | null;
  reputation_pct: number | null;
  total_earned_wrf: number;
  referrals_activated: number;
  badges: Array<{ kind: string; token_id: string | null; earned_at: string | null }>;
  rank_weekly: number | null;
}

// ---------------------------------------------------------------------------
// Shared lazy state
// ---------------------------------------------------------------------------

let _redis: ReturnType<typeof createRedisClient> | null = null;
function getRedis() {
  if (!_redis) {
    // Public summary data is authoritative in Postgres; Redis is only a cache.
    _redis = createRedisClient({
      failureMode: 'fail-open-cache',
      lazyConnect: true,
    });
  }
  return _redis;
}

function defaultDb(): DbExecutor {
  let cachedExecuteQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null =
    null;
  return {
    execute: async (sql: string, params?: unknown[]) => {
      if (!cachedExecuteQuery) {
        const mod = await import('../../database/index.js');
        cachedExecuteQuery = mod.executeQuery;
      }
      return cachedExecuteQuery!(sql, params);
    },
  };
}

function getCounter(name: string, help: string): Counter<string> {
  const existing = metricsRegistry.getSingleMetric(name);
  if (existing) return existing as Counter<string>;
  return new Counter({ name, help, registers: [metricsRegistry] });
}

const profileViewsCounter = getCounter(
  'wrfcoin_contributor_profile_views_total',
  'Total number of contributor profile summary requests'
);

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const CACHE_TTL_S = 30;

// ---------------------------------------------------------------------------
// Data fetchers
// ---------------------------------------------------------------------------

async function fetchUserRow(
  address: string,
  db: DbExecutor
): Promise<{ id: number; display_name: string | null; joined_at: string | null } | null> {
  const { rows } = await db.execute(
    `SELECT id, display_name, created_at FROM users WHERE wallet_address = $1 LIMIT 1`,
    [address]
  );
  if (!rows.length) return null;
  const row = rows[0];
  return {
    id: Number(row.id),
    display_name: typeof row.display_name === 'string' ? row.display_name : null,
    joined_at:
      row.created_at instanceof Date
        ? (row.created_at as Date).toISOString()
        : typeof row.created_at === 'string'
          ? row.created_at
          : null,
  };
}

async function fetchStreakData(
  userId: number,
  db: DbExecutor
): Promise<{ current: number; longest: number }> {
  try {
    const summary = await getStreakSummary(userId, 0, db);
    return { current: summary.currentStreak, longest: summary.longestStreak };
  } catch {
    return { current: 0, longest: 0 };
  }
}

async function fetchReputationData(
  address: string
): Promise<{ pct: number | null; badges: ContributorSummary['badges'] }> {
  try {
    const record = await reputationScoringEngine.getScore(address);
    const badges = record.badges.map(kind => ({ kind, token_id: null, earned_at: null }));
    return { pct: record.compositeScore, badges };
  } catch {
    return { pct: null, badges: [] };
  }
}

async function fetchReferralsActivated(address: string, db: DbExecutor): Promise<number> {
  try {
    const { rows } = await db.execute(
      `SELECT COUNT(*) AS cnt FROM referrals WHERE referrer_address = $1 AND status = 'activated'`,
      [address]
    );
    return Number(rows[0]?.cnt ?? 0);
  } catch {
    return 0;
  }
}

async function fetchSubmissionsData(
  address: string,
  db: DbExecutor
): Promise<{ total_30d: number; quality_avg: number | null }> {
  try {
    const { rows } = await db.execute(
      `SELECT
         COUNT(*) AS total_30d,
         AVG(ws.quality_score) AS quality_avg
       FROM weather_submissions ws
       JOIN users u ON u.id = ws.user_id
       WHERE u.wallet_address = $1
         AND ws.created_at >= NOW() - INTERVAL '30 days'`,
      [address]
    );
    const row = rows[0] ?? {};
    const total = Number(row.total_30d ?? 0);
    const avg = row.quality_avg != null ? Number(row.quality_avg) : null;
    return { total_30d: total, quality_avg: avg };
  } catch {
    return { total_30d: 0, quality_avg: null };
  }
}

async function fetchTotalEarnedWrf(userId: number, db: DbExecutor): Promise<number> {
  try {
    const { rows } = await db.execute(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM contributor_rewards WHERE user_id = $1`,
      [userId]
    );
    return Number(rows[0]?.total ?? 0);
  } catch {
    return 0;
  }
}

async function fetchWeeklyRank(address: string, db: DbExecutor): Promise<number | null> {
  try {
    const { rows } = await db.execute(
      `SELECT rank FROM (
         SELECT
           u.wallet_address,
           ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rank
         FROM weather_submissions ws
         JOIN users u ON u.id = ws.user_id
         WHERE ws.created_at >= NOW() - INTERVAL '7 days'
         GROUP BY u.wallet_address
       ) ranked
       WHERE wallet_address = $1`,
      [address]
    );
    return rows[0]?.rank != null ? Number(rows[0].rank) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createContributorSummaryRouter(db?: DbExecutor): express.Router {
  const router = express.Router();
  const executor = db ?? defaultDb();

  const rateLimiter = createRateLimitMiddleware({
    ...RATE_LIMIT_PRESETS.api,
    keyPrefix: 'ratelimit:contributor:summary',
  });

  router.get('/:address/summary', rateLimiter, async (req, res) => {
    const { address } = req.params;

    if (!ADDRESS_RE.test(address)) {
      return res
        .status(400)
        .json(createApiError('INVALID_ETHEREUM_ADDRESS', 'Invalid Ethereum address format'));
    }

    const normalizedAddress = address.toLowerCase();
    const cacheKey = `contributor:summary:${normalizedAddress}`;

    // Cache read
    const redis = getRedis();
    try {
      const cached = await redis.get(cacheKey);
      if (cached) {
        profileViewsCounter.inc();
        res.set('Cache-Control', `public, max-age=${CACHE_TTL_S}`);
        return res.json({ success: true, data: JSON.parse(cached), timestamp: new Date().toISOString() });
      }
    } catch (err) {
      appLogger.debug('contributor summary: redis get failed, proceeding without cache', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Resolve user row first (needed for userId-based lookups)
    const userRow = await fetchUserRow(normalizedAddress, executor);

    // Fan-out — all in parallel, failures handled inside each fetcher
    const [
      streakResult,
      reputationResult,
      referralsResult,
      submissionsResult,
      earnedResult,
      rankResult,
    ] = await Promise.all([
      userRow ? fetchStreakData(userRow.id, executor) : Promise.resolve({ current: 0, longest: 0 }),
      fetchReputationData(normalizedAddress),
      fetchReferralsActivated(normalizedAddress, executor),
      fetchSubmissionsData(normalizedAddress, executor),
      userRow ? fetchTotalEarnedWrf(userRow.id, executor) : Promise.resolve(0),
      fetchWeeklyRank(normalizedAddress, executor),
    ]);

    const summary: ContributorSummary = {
      address: normalizedAddress,
      display_name: userRow?.display_name ?? null,
      joined_at: userRow?.joined_at ?? null,
      current_streak_days: streakResult.current,
      longest_streak_days: streakResult.longest,
      total_submissions_30d: submissionsResult.total_30d,
      quality_score_avg: submissionsResult.quality_avg,
      reputation_pct: reputationResult.pct,
      total_earned_wrf: earnedResult,
      referrals_activated: referralsResult,
      badges: reputationResult.badges,
      rank_weekly: rankResult,
    };

    // Cache write (best-effort)
    try {
      await redis.set(cacheKey, JSON.stringify(summary), 'EX', CACHE_TTL_S);
    } catch (err) {
      appLogger.debug('contributor summary: redis set failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    profileViewsCounter.inc();
    res.set('Cache-Control', `public, max-age=${CACHE_TTL_S}`);
    return res.json({
      success: true,
      data: summary,
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
