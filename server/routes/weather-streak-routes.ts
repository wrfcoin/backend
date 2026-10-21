import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateJWT } from '../middleware/auth.js';
import { walletMayOnlyActForOwnAddressInBody, walletMayOnlyUseOwnAddress } from '../middleware/wallet-ownership.js';

const weatherGetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const weatherPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const MILESTONES = [7, 30, 90] as const;
const WALLET_RE = /^0x[0-9a-fA-F]{40}$/;

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

function defaultDb(): DbExecutor {
  // Lazy dynamic import — avoids "require is not defined" in ESM bundles (#268)
  let cachedExecuteQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null = null;
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

export function createWeatherStreakRouter(db?: DbExecutor): express.Router {
  const router = express.Router();

  // All weather streak operations require authentication (#231)
  router.use(authenticateJWT);
  // backend#1297: a wallet-login caller may only read or act for its own address.
  router.param('walletAddress', walletMayOnlyUseOwnAddress);

  // POST /mint-trigger must be defined BEFORE GET /:walletAddress so it isn't swallowed as a param
  router.post('/mint-trigger', weatherPostLimiter, walletMayOnlyActForOwnAddressInBody('walletAddress'), async (req, res) => {
    const executor = db ?? defaultDb();
    const { walletAddress, milestoneLevel, txHash } = req.body ?? {};

    if (!walletAddress || !WALLET_RE.test(walletAddress)) {
      return res.status(400).json({ error: 'Invalid walletAddress' });
    }
    if (!MILESTONES.includes(milestoneLevel)) {
      return res.status(400).json({ error: 'milestoneLevel must be 7, 30, or 90' });
    }

    try {
      await executor.execute(
        `INSERT INTO streak_milestones_claimed (wallet_address, milestone_days, tx_hash)
         VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING`,
        [walletAddress, milestoneLevel, txHash ?? null]
      );
      return res.status(200).json({ recorded: true });
    } catch (err) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  router.get('/:walletAddress', weatherGetLimiter, async (req, res) => {
    const executor = db ?? defaultDb();
    const { walletAddress } = req.params;

    if (!WALLET_RE.test(walletAddress)) {
      return res.status(400).json({ error: 'Invalid walletAddress' });
    }

    try {
      // 1. Resolve user_id from wallet address
      const userRows = await executor.execute(
        `SELECT id FROM users WHERE wallet_address = $1 LIMIT 1`,
        [walletAddress]
      );
      const userId: unknown = userRows.rows[0]?.id ?? null;

      let currentStreak = 0;
      let longestStreak = 0;

      if (userId !== null) {
        // 2. Current streak via recursive CTE (only counted if today has a submission)
        const streakRes = await executor.execute(
          `WITH RECURSIVE streak_walk AS (
             SELECT CURRENT_DATE AS d, 1 AS n
             WHERE EXISTS (
               SELECT 1 FROM weather_submissions
               WHERE user_id = $1
                 AND DATE(submitted_at AT TIME ZONE 'UTC') = CURRENT_DATE
             )
             UNION ALL
             SELECT sw.d - 1, sw.n + 1 FROM streak_walk sw
             WHERE EXISTS (
               SELECT 1 FROM weather_submissions
               WHERE user_id = $1
                 AND DATE(submitted_at AT TIME ZONE 'UTC') = sw.d - 1
             )
           )
           SELECT COALESCE(MAX(n), 0) AS current_streak FROM streak_walk`,
          [userId]
        );
        currentStreak = Number(streakRes.rows[0]?.current_streak ?? 0);

        // 3. Longest streak via islands pattern
        const longestRes = await executor.execute(
          `WITH daily AS (
             SELECT DISTINCT DATE(submitted_at AT TIME ZONE 'UTC') AS d
             FROM weather_submissions WHERE user_id = $1
           ),
           grouped AS (
             SELECT d, d - (ROW_NUMBER() OVER (ORDER BY d))::integer AS grp FROM daily
           )
           SELECT COALESCE(MAX(cnt), 0) AS longest_streak
           FROM (SELECT COUNT(*) AS cnt FROM grouped GROUP BY grp) s`,
          [userId]
        );
        longestStreak = Number(longestRes.rows[0]?.longest_streak ?? 0);
      }

      // 4. Claimed milestones
      const claimedRes = await executor.execute(
        `SELECT milestone_days FROM streak_milestones_claimed WHERE wallet_address = $1`,
        [walletAddress]
      );
      const claimed = new Set(claimedRes.rows.map((r) => Number(r.milestone_days)));

      // 5. Compute next milestone and whether it's been reached
      const nextMilestone = (MILESTONES.find((m) => !claimed.has(m)) ?? null) as number | null;
      const milestoneReached = nextMilestone !== null && currentStreak >= nextMilestone;

      return res.status(200).json({ currentStreak, longestStreak, nextMilestone, milestoneReached });
    } catch (err) {
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default createWeatherStreakRouter();
