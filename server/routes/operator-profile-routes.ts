/**
 * Shareable operator profile card endpoints — closes backend#409.
 *
 * Public (unauthenticated) endpoints that aggregate existing data into
 * a shareable profile for a given wallet address:
 *   GET /api/operators/:walletAddress/profile   — JSON profile data
 *   GET /api/operators/:walletAddress/og-meta   — Open Graph meta tags
 *
 * Results are cached for 2 minutes per the acceptance criteria.
 */

import express from 'express';
import { earningsEnabled, defaultEarningsSource, type EarningsSource } from '../services/chain-rewards/earnings.js';
import { logger } from '../../utils/logger.js';
import { isValidWrfcoinAddress } from '../../shared/wallet-address.js';
import { hasOperatorToken } from '../middleware/operator-token-auth.js';
import { peekWalletSubject } from '../middleware/authMiddleware.js';
import {
  createProfileKeyResolver,
  isProfileKey,
  profileKeyFor,
  shortAddress,
} from '../utils/contributor-alias.js';

const CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

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

interface ProfileData {
  walletAddress: string;
  displayName: string | null;
  stationCount: number;
  totalSubmissions: number;
  currentStreak: number;
  longestStreak: number;
  qualityScore: number;
  totalRewardsEarned: string;
  badges: string[];
  joinedAt: string | null;
  lastSubmission: string | null;
  rank: number | null;
  coverageRegion: string | null;
}

// Simple in-memory cache
const profileCache = new Map<string, { data: ProfileData; expiresAt: number }>();

async function fetchProfile(walletAddress: string, db: DbExecutor): Promise<ProfileData | null> {
  const cached = profileCache.get(walletAddress);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  // Basic user info
  const userResult = await db.execute(
    `SELECT id, wallet_address, created_at FROM users WHERE wallet_address = $1 LIMIT 1`,
    [walletAddress]
  );
  if (!userResult.rows.length) return null;
  const user = userResult.rows[0];
  const userId = user.id;

  // Submission aggregates
  const subResult = await db.execute(
    `SELECT
       COUNT(*) as total_submissions,
       MAX(submitted_at) as last_submission,
       AVG(quality_score) as avg_quality
     FROM weather_submissions WHERE user_id = $1`,
    [userId]
  );
  const sub = subResult.rows[0] ?? {};

  // Station count
  const stationResult = await db.execute(
    `SELECT COUNT(DISTINCT station_id) as station_count
     FROM weather_submissions WHERE user_id = $1`,
    [userId]
  );
  const stationCount = Number(stationResult.rows[0]?.station_count ?? 0);

  // Streak data from streak_milestones_claimed
  const streakResult = await db.execute(
    `SELECT MAX(milestone_days) as longest_streak
     FROM streak_milestones_claimed WHERE wallet_address = $1`,
    [walletAddress]
  );
  const longestStreak = Number(streakResult.rows[0]?.longest_streak ?? 0);

  // Current streak: consecutive days with at least one submission up to today
  const currentStreakResult = await db.execute(
    `WITH daily AS (
       SELECT DATE(submitted_at) as day
       FROM weather_submissions WHERE user_id = $1
       GROUP BY DATE(submitted_at)
     ), ranked AS (
       SELECT day, ROW_NUMBER() OVER (ORDER BY day DESC) as rn
       FROM daily
     )
     SELECT COUNT(*) as current_streak
     FROM ranked
     WHERE day = CURRENT_DATE - (rn - 1) * INTERVAL '1 day'`,
    [userId]
  );
  const currentStreak = Number(currentStreakResult.rows[0]?.current_streak ?? 0);

  // Rewards earned (sum of reward_amount from weather_submissions or rewards table)
  const rewardResult = await db.execute(
    `SELECT COALESCE(SUM(reward_amount), 0)::text as total_rewards
     FROM weather_submissions WHERE user_id = $1`,
    [userId]
  );
  const totalRewardsEarned = String(rewardResult.rows[0]?.total_rewards ?? '0');

  // Rank by submission count
  const rankResult = await db.execute(
    `SELECT rank FROM (
       SELECT user_id, RANK() OVER (ORDER BY COUNT(*) DESC) as rank
       FROM weather_submissions GROUP BY user_id
     ) ranked WHERE user_id = $1`,
    [userId]
  );
  const rank = rankResult.rows[0]?.rank != null ? Number(rankResult.rows[0].rank) : null;

  // Badges from achievement tables (if available, else empty)
  let badges: string[] = [];
  try {
    const badgeResult = await db.execute(
      `SELECT achievement_type FROM user_achievements WHERE user_id = $1`,
      [userId]
    );
    badges = badgeResult.rows.map(r => String(r.achievement_type));
  } catch {
    // table may not exist yet — silently skip
  }

  const profile: ProfileData = {
    walletAddress,
    displayName: null, // no display_name column currently
    stationCount,
    totalSubmissions: Number(sub.total_submissions ?? 0),
    currentStreak,
    longestStreak,
    qualityScore: Math.round(Number(sub.avg_quality ?? 0) * 10) / 10,
    totalRewardsEarned,
    badges,
    joinedAt: user.created_at ? new Date(user.created_at as string).toISOString() : null,
    lastSubmission: sub.last_submission ? new Date(sub.last_submission as string).toISOString() : null,
    rank,
    coverageRegion: null, // derived from station geolocation — stub for now
  };

  profileCache.set(walletAddress, { data: profile, expiresAt: Date.now() + CACHE_TTL_MS });
  return profile;
}

export function createOperatorProfileRouter(db?: DbExecutor, earnings: EarningsSource = defaultEarningsSource()): express.Router {
  const router = express.Router();
  const executor = db ?? defaultDb();
  const resolveProfileKey = createProfileKeyResolver(executor);

  // backend#1361: the public leaderboard links to a profile by an opaque key (`c_<24 hex>`), not
  // by wallet address. A key resolves to the address server-side; the address is then shown in
  // full only to the operator bearer and to the wallet's own login. A caller who supplied the
  // full address themselves is not told anything new by an echo of it.
  type Target = { walletAddress: string; byKey: boolean } | { error: 400 | 404 };
  async function resolveTarget(param: string): Promise<Target> {
    if (isProfileKey(param)) {
      const indexed = earningsEnabled() ? await earnings.resolveAddress?.(param) : null;
      const address = indexed ?? await resolveProfileKey(param);
      return address ? { walletAddress: address, byKey: true } : { error: 404 };
    }
    return isValidWrfcoinAddress(param) ? { walletAddress: param, byKey: false } : { error: 400 };
  }
  const visibleAddress = (req: express.Request, target: { walletAddress: string; byKey: boolean }): string => {
    if (!target.byKey) return target.walletAddress;
    const own = peekWalletSubject(req) === target.walletAddress.toLowerCase();
    return hasOperatorToken(req) || own ? target.walletAddress : shortAddress(target.walletAddress);
  };

  // GET /api/operators/:walletAddress/profile
  router.get('/:walletAddress/profile', async (req, res) => {
    try {
      const target = await resolveTarget(req.params.walletAddress);
      if ('error' in target) {
        return target.error === 400
          ? res.status(400).json({ error: 'Invalid wallet address format' })
          : res.status(404).json({ error: 'Operator not found' });
      }
      const { walletAddress } = target;
      const legacyProfile = await fetchProfile(walletAddress, executor);
      let roleEarnings: any;
      let observed = false;
      if (earningsEnabled()) {
        try {
          observed = legacyProfile !== null || (await earnings.resolveAddress?.(walletAddress)) != null;
          if (observed) roleEarnings = await earnings.profile(walletAddress);
        } catch {
          if (!legacyProfile && !observed) return res.status(503).json({ error: 'Profile earnings unavailable' });
          roleEarnings = { status: 'unavailable', roles: null, overallPaidBaseUnits: null, overallComplete: false };
        }
      }
      const profile = legacyProfile ?? (observed ? { walletAddress, displayName: `Operator-${profileKeyFor(walletAddress)?.slice(2, 10) ?? 'unknown'}`, weatherStatisticsAvailable: false } : null);
      if (!profile) {
        return res.status(404).json(
          target.byKey ? { error: 'Operator not found' } : { error: 'Operator not found', walletAddress },
        );
      }
      // backend#1222: a per-address reward total is a financial record;
      // anonymous callers get null, the operator bearer gets the amount.
      const operatorView = hasOperatorToken(req);
      const isYou = peekWalletSubject(req) === walletAddress.toLowerCase();
      const body = {
        ...profile,
        walletAddress: earningsEnabled() && !operatorView && !isYou ? shortAddress(walletAddress) : visibleAddress(req, target),
        // An anonymous raw-address lookup must not return the alias: with a candidate address it
        // would be a lookup oracle (address -> key -> leaderboard row -> display name). A key-addressed
        // page already holds its key; the operator and the owning wallet may see it.
        profileKey: target.byKey || operatorView || isYou ? profileKeyFor(walletAddress) : null,
        isYou,
        ...(operatorView ? {} : { totalRewardsEarned: null }),
        ...(earningsEnabled() ? { roleEarnings: roleEarnings ?? { status: 'unavailable', roles: null, overallPaidBaseUnits: null, overallComplete: false }, legacyRewardSource: 'weather-submissions-db' } : {}),
      };
      res.set('Cache-Control', 'private, no-store');
      return res.json({ success: true, profile: body });
    } catch (err) {
      logger.error('[operator-profile] lookup failed', { error: err instanceof Error ? err.message : String(err) });
      return res.status(500).json({ error: 'Failed to load operator profile' });
    }
  });

  // GET /api/operators/:walletAddress/og-meta
  router.get('/:walletAddress/og-meta', async (req, res) => {
    try {
      const target = await resolveTarget(req.params.walletAddress);
      if ('error' in target) {
        return target.error === 400
          ? res.status(400).json({ error: 'Invalid wallet address format' })
          : res.status(404).json({ error: 'Operator not found' });
      }
      const { walletAddress } = target;
      const profile = await fetchProfile(walletAddress, executor);
      if (!profile) {
        return res.status(404).json(
          target.byKey ? { error: 'Operator not found' } : { error: 'Operator not found', walletAddress },
        );
      }
      const shortAddr = `${walletAddress.slice(0, 6)}...${walletAddress.slice(-4)}`;
      const displayName = profile.displayName ?? `WeatherNode-${walletAddress.slice(2, 8).toUpperCase()}`;
      // A key link must not leak the address through the image URL either.
      const pathKey = target.byKey ? req.params.walletAddress : walletAddress;
      return res.json({
        success: true,
        meta: {
          title: `${displayName} — WRFCoin Operator`,
          description: `${profile.currentStreak}-day streak · ${profile.totalSubmissions.toLocaleString()} readings · Quality score ${profile.qualityScore}%`,
          imageUrl: `/api/operators/${pathKey}/card.png`,
          walletAddress: visibleAddress(req, target),
          shortAddr,
        },
      });
    } catch (err) {
      logger.error('[operator-profile] og-meta lookup failed', { error: err instanceof Error ? err.message : String(err) });
      return res.status(500).json({ error: 'Failed to load operator profile' });
    }
  });

  return router;
}

export default createOperatorProfileRouter();
