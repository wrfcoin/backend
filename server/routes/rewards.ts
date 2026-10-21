/**
 * Reward Distribution API Routes
 *
 * These routes handle access to the reward distribution system,
 * including configuration, individual rewards, and metrics.
 */

import * as express from 'express';
import { authenticateJWT } from '../middleware/auth.js';
import { resolveCallerUserId, walletMayOnlyUseOwnUserId } from '../middleware/wallet-ownership.js';
import { db } from '../../database/index.js';
import { eq, and, desc, lt, sql } from 'drizzle-orm';
import {
  rewardDistributionConfig,
  contributorRewards,
  forecastCoverageMetrics,
  environmentalOffsetProofs,
  computationalWorkProofs,
  computationalNodes,
  algorithmAdvancements,
  achievements,
  userAchievements,
  users,
} from '../../shared/schema.js';
import type { Request, Response } from 'express';
import { appLogger } from '../utils/logger.js';
import {
  submitPayout,
  isValidPayoutAddress,
} from '../services/reward-payout-client.js';
import {
  buildClaimId,
  pointsToBaseUnits,
  settlementFromPayout,
  mergeSettlementMetadata,
  priorAttempts,
} from '../services/reward-payout-settlement.js';
import {
  loadEmissionLimits,
  evaluateEmissionBudget,
  coerceEmissionTotal,
  describeRefusal,
  EMISSION_WINDOW_MS,
  isRefusal,
  type BudgetDecision,
} from '../services/achievement-emission-budget.js';

import {
  authorizeNewPayout, verifyPayoutAuthorization, signedPayoutEnabled, PayoutAuthorizationError,
  canonicalRecipient,
} from '../services/achievement-payout-authorization.js';

const router = express.Router();

// All reward operations require authentication (#231)
router.use(authenticateJWT);
// backend#1297: a wallet-login caller may address only its own users row.
router.param('userId', walletMayOnlyUseOwnUserId);

/**
 * Get current reward distribution configuration
 */
router.get('/config', async (req, res) => {
  try {
    // Get the most recent active configuration
    const [config] = await db
      .select()
      .from(rewardDistributionConfig)
      .where(eq(rewardDistributionConfig.active, true))
      .orderBy(desc(rewardDistributionConfig.createdAt))
      .limit(1);

    if (!config) {
      return res.status(404).json({
        error: 'No active reward distribution configuration found',
      });
    }

    return res.json({ config });
  } catch (error) {
    appLogger.error('Error fetching reward distribution config', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    return res.status(500).json({
      error: 'Error fetching reward distribution configuration',
    });
  }
});

/**
 * Get rewards for a specific user
 */
router.get('/user/:userId', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Get user's rewards
    const rewards = await db
      .select()
      .from(contributorRewards)
      .where(eq(contributorRewards.userId, userId))
      .orderBy(desc(contributorRewards.createdAt));

    // Calculate total rewards by type
    const totalsByType = await db
      .select({
        contributorType: contributorRewards.contributorType,
        total: sql`SUM(${contributorRewards.amount})`,
        count: sql`COUNT(*)`,
      })
      .from(contributorRewards)
      .where(eq(contributorRewards.userId, userId))
      .groupBy(contributorRewards.contributorType);

    return res.json({
      rewards,
      totalsByType,
      totalRewards: totalsByType.reduce(
        (sum, type) => sum + Number(type.total),
        0
      ),
    });
  } catch (error) {
    appLogger.error('Error fetching user rewards', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    return res.status(500).json({ error: 'Error fetching user rewards' });
  }
});

/**
 * Get forecast coverage metrics
 */
router.get('/forecast-coverage', async (req, res) => {
  try {
    const { region } = req.query;

    let metrics;

    // Filter by region if provided
    if (region && typeof region === 'string') {
      metrics = await db
        .select()
        .from(forecastCoverageMetrics)
        .where(eq(forecastCoverageMetrics.region, region))
        .orderBy(desc(forecastCoverageMetrics.createdAt));
    } else {
      metrics = await db
        .select()
        .from(forecastCoverageMetrics)
        .orderBy(desc(forecastCoverageMetrics.createdAt));
    }

    return res.json({ metrics });
  } catch (error) {
    appLogger.error('Error fetching forecast coverage metrics', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    return res
      .status(500)
      .json({ error: 'Error fetching forecast coverage metrics' });
  }
});

/**
 * Get summary of all rewards by type
 */
router.get('/summary', async (req, res) => {
  try {
    // Get total rewards by contributor type
    const rewardsByType = await db
      .select({
        contributorType: contributorRewards.contributorType,
        total: sql`SUM(${contributorRewards.amount})`,
        count: sql`COUNT(*)`,
      })
      .from(contributorRewards)
      .groupBy(contributorRewards.contributorType);

    // Get total environmental offset proofs
    const [offsetTotal] = await db
      .select({
        total: sql`COUNT(*)`,
        verified: sql`SUM(CASE WHEN ${environmentalOffsetProofs.isVerified} = true THEN 1 ELSE 0 END)`,
        totalPoints: sql`SUM(${environmentalOffsetProofs.offsetPoints})`,
      })
      .from(environmentalOffsetProofs);

    // Get total computational work proofs
    const [computationalTotal] = await db
      .select({
        total: sql`COUNT(*)`,
        verified: sql`SUM(CASE WHEN ${computationalWorkProofs.isVerified} = true THEN 1 ELSE 0 END)`,
        totalHours: sql`SUM(${computationalWorkProofs.resourceHours})`,
      })
      .from(computationalWorkProofs);

    // Get total algorithm advancements
    const [algorithmTotal] = await db
      .select({
        total: sql`COUNT(*)`,
        verified: sql`SUM(CASE WHEN ${algorithmAdvancements.isVerified} = true THEN 1 ELSE 0 END)`,
      })
      .from(algorithmAdvancements);

    return res.json({
      rewardsByType,
      environmentalOffsets: offsetTotal,
      computationalWork: computationalTotal,
      algorithmAdvancements: algorithmTotal,
      totalRewards: rewardsByType.reduce(
        (sum, type) => sum + Number(type.total),
        0
      ),
    });
  } catch (error) {
    appLogger.error('Error fetching rewards summary', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    return res.status(500).json({ error: 'Error fetching rewards summary' });
  }
});

/**
 * Get user's environmental offset proofs
 */
router.get('/user/:userId/offsets', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const offsets = await db
      .select()
      .from(environmentalOffsetProofs)
      .where(eq(environmentalOffsetProofs.userId, userId))
      .orderBy(desc(environmentalOffsetProofs.createdAt));

    return res.json({ offsets });
  } catch (error) {
    appLogger.error('Error fetching user offset proofs', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    return res.status(500).json({ error: 'Error fetching user offset proofs' });
  }
});

/**
 * Get user's computational work proofs
 */
router.get('/user/:userId/computational', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    // Get user's computational work by joining through computationalNodes → users (#410)
    const computationalWork = await db
      .select({
        id: computationalWorkProofs.id,
        taskId: computationalWorkProofs.taskId,
        computationType: computationalWorkProofs.computationType,
        computeResourcesUsed: computationalWorkProofs.computeResourcesUsed,
        startedAt: computationalWorkProofs.startedAt,
        completedAt: computationalWorkProofs.completedAt,
        isVerified: computationalWorkProofs.isVerified,
        resourceHours: computationalWorkProofs.resourceHours,
        rewardAmount: computationalWorkProofs.rewardAmount,
        resultMetadata: computationalWorkProofs.resultMetadata,
      })
      .from(computationalWorkProofs)
      .innerJoin(
        computationalNodes,
        eq(computationalWorkProofs.nodeId, computationalNodes.nodeId)
      )
      .innerJoin(
        users,
        eq(computationalNodes.operatorAddress, users.walletAddress)
      )
      .where(eq(users.id, userId))
      .orderBy(desc(computationalWorkProofs.completedAt));

    return res.json({ computationalWork });
  } catch (error) {
    appLogger.error('Error fetching user computational work', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    return res
      .status(500)
      .json({ error: 'Error fetching user computational work' });
  }
});

/**
 * Get user's algorithm advancements
 */
router.get('/user/:userId/algorithms', async (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);

    if (isNaN(userId)) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const algorithms = await db
      .select()
      .from(algorithmAdvancements)
      .where(eq(algorithmAdvancements.userId, userId))
      .orderBy(desc(algorithmAdvancements.createdAt));

    return res.json({ algorithms });
  } catch (error) {
    appLogger.error('Error fetching user algorithm advancements', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    return res
      .status(500)
      .json({ error: 'Error fetching user algorithm advancements' });
  }
});

/**
 * Get top contributors by type
 */
router.get('/top-contributors', async (req, res) => {
  try {
    const { type, limit = 10 } = req.query;
    const parsedLimit = parseInt(String(limit), 10);

    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      return res.status(400).json({ error: 'Invalid limit parameter (1-100)' });
    }

    let topContributors;

    // Filter by reward type if specified
    if (type && typeof type === 'string') {
      topContributors = await db
        .select({
          userId: contributorRewards.userId,
          username: users.username,
          contributorType: contributorRewards.contributorType,
          total: sql`SUM(${contributorRewards.amount})`,
          count: sql`COUNT(*)`,
        })
        .from(contributorRewards)
        .leftJoin(users, eq(contributorRewards.userId, users.id))
        .where(eq(contributorRewards.contributorType, type))
        .groupBy(
          contributorRewards.userId,
          users.username,
          contributorRewards.contributorType
        )
        .orderBy(desc(sql`SUM(${contributorRewards.amount})`))
        .limit(parsedLimit);
    } else {
      topContributors = await db
        .select({
          userId: contributorRewards.userId,
          username: users.username,
          contributorType: contributorRewards.contributorType,
          total: sql`SUM(${contributorRewards.amount})`,
          count: sql`COUNT(*)`,
        })
        .from(contributorRewards)
        .leftJoin(users, eq(contributorRewards.userId, users.id))
        .groupBy(
          contributorRewards.userId,
          users.username,
          contributorRewards.contributorType
        )
        .orderBy(desc(sql`SUM(${contributorRewards.amount})`))
        .limit(parsedLimit);
    }

    return res.json({ topContributors });
  } catch (error) {
    appLogger.error('Error fetching top contributors', { error: error instanceof Error ? error.message : 'Unknown error', stack: error instanceof Error ? error.stack : undefined });
    return res.status(500).json({ error: 'Error fetching top contributors' });
  }
});

/**
 * #215 — mobile earn→claim loop.
 *
 * Mobile calls `POST /api/v1/rewards/claim/:achievementId` and
 * `GET /api/v1/rewards/history`. Neither handler existed nor was mounted in the
 * live entrypoint, so every claim 404'd and the core earn→claim loop was dead.
 *
 * SETTLEMENT MECHANISM (investigated, not invented):
 *   - WRF weather-contribution rewards settle ON-CHAIN via core4: the oracle
 *     submit path (`oracle-submit-routes.ts`) drives core4 commit/reveal and the
 *     balance accrues as `earned_balance_total` on the contributor's address.
 *   - Achievement / gamification rewards (this route) have NO on-chain payout
 *     path today. `contributor_rewards` is the existing DB reward ledger, and
 *     `user_achievements` records what a user earned.
 *
 * ON-CHAIN PAYOUT (#215 rewire, core4 PR #2081):
 *   The claim now drives an on-chain WRF payout via core4 `POST /rewards/payout`
 *   (Operator role, port 8556), keyed by a deterministic `claim_id`. Because a
 *   payout SETTLES when mined (not at the 202), the ledger row carries a
 *   settlement lifecycle in `metadata.settlement`: pending → settling → settled.
 *   The claim marker insert (idempotent, FOR UPDATE) stays the backend dedup; the
 *   core4 `claim_id` dedup is the consensus-level guarantee that repeat submits
 *   never double-mint. Repeat claims and the background reconciler both re-POST
 *   the same claim_id safely to advance settlement.
 */
const ACHIEVEMENT_REWARD_TYPE = 'achievement';

/**
 * #940 — sum prior achievement emission and apply the ceilings.
 *
 * Runs on the caller's transaction handle so the totals it reads are the snapshot
 * the subsequent insert commits into. **Fails closed:** if the aggregate cannot be
 * read, the claim is refused rather than allowed, because an unreadable budget is
 * indistinguishable from an exhausted one and only one of those two answers is
 * safe on a mint path.
 */
async function evaluateClaimBudget(
  tx: { select: (fields: unknown) => any },
  userId: number,
  amount: number
): Promise<BudgetDecision> {
  const limits = loadEmissionLimits();
  try {
    const since = new Date(Date.now() - EMISSION_WINDOW_MS);
    const rows = await tx
      .select({
        userDay: sql<string>`COALESCE(SUM(CASE WHEN ${contributorRewards.userId} = ${userId} AND ${contributorRewards.createdAt} >= ${since} THEN ${contributorRewards.amount} ELSE 0 END), 0)`,
        userLifetime: sql<string>`COALESCE(SUM(CASE WHEN ${contributorRewards.userId} = ${userId} THEN ${contributorRewards.amount} ELSE 0 END), 0)`,
        globalDay: sql<string>`COALESCE(SUM(CASE WHEN ${contributorRewards.createdAt} >= ${since} THEN ${contributorRewards.amount} ELSE 0 END), 0)`,
      })
      .from(contributorRewards)
      .where(eq(contributorRewards.contributorType, ACHIEVEMENT_REWARD_TYPE));

    // An empty result set is a legitimate "nothing emitted yet" (the aggregate is
    // COALESCE'd server-side, but a mocked or empty driver may still yield []).
    const row = (Array.isArray(rows) ? rows[0] : rows) as Record<string, unknown> | undefined;
    const totals = {
      userDay: coerceEmissionTotal(row?.userDay),
      userLifetime: coerceEmissionTotal(row?.userLifetime),
      globalDay: coerceEmissionTotal(row?.globalDay),
    };
    return evaluateEmissionBudget({ amount, totals, limits });
  } catch (error) {
    appLogger.error('#940 emission budget unreadable; refusing the claim (fail closed)', {
      userId,
      amount,
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      allowed: false,
      rule: 'budget-unreadable',
      limit: limits.globalDaily,
      observed: NaN,
      requested: amount,
    };
  }
}

/**
 * Advisory-lock key for the achievement mint path (#940). A single GLOBAL key,
 * not one per user.
 *
 * Why global rather than `(940, userId)`: the ceilings this serializes are
 * aggregate. A per-user key would make the per-user daily/lifetime caps hard but
 * leave the GLOBAL daily budget with a one-transaction-per-connection overshoot —
 * and the global budget is precisely the one that bounds a mass-insert across
 * many freshly created users, where no per-user cap is ever approached. One
 * global key makes all three aggregate ceilings hard.
 *
 * Why it is taken FIRST, before the existing `SELECT ... FOR UPDATE`: consistent
 * lock ordering. Acquiring it *after* the row lock would let two concurrent
 * claims for the same (user, achievement) deadlock — one holding the row lock
 * waiting on the advisory lock, the other the reverse.
 *
 * Cost: achievement claims serialize. That is acceptable here — the payout POST
 * to core4 happens strictly OUTSIDE this transaction, so the serialized section
 * is a few local statements with no network call inside it.
 */
const ACHIEVEMENT_MINT_LOCK_KEY = 940;

/** Resolve the authenticated numeric users.id from the JWT session. */
async function resolveUserId(req: Request): Promise<number | null> {
  return resolveCallerUserId(req);
}

/**
 * Claim the reward for an earned achievement. Idempotent: a second claim for the
 * same (user, achievement) is rejected with 409.
 */
router.post('/claim/:achievementId', async (req: Request, res: Response) => {
  try {
    const userId = await resolveUserId(req);
    if (userId === null) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }
    const achievementKey = String(req.params.achievementId || '').trim();
    if (!achievementKey) {
      return res.status(400).json({ success: false, error: 'achievementId is required' });
    }

    // Resolve the achievement definition from its public (text) id.
    const [achievement] = await db
      .select()
      .from(achievements)
      .where(eq(achievements.achievementId, achievementKey))
      .limit(1);
    if (!achievement) {
      return res.status(404).json({ success: false, error: 'Unknown achievement' });
    }

    // The user must actually have earned/completed it.
    const [earned] = await db
      .select()
      .from(userAchievements)
      .where(
        and(
          eq(userAchievements.userId, userId),
          eq(userAchievements.achievementId, achievement.id)
        )
      )
      .limit(1);
    if (!earned) {
      return res.status(400).json({ success: false, error: 'Achievement not earned' });
    }
    const isComplete =
      earned.status === 'completed' ||
      earned.status === 'claimed' ||
      (typeof earned.progress === 'number' && earned.progress >= 100);
    if (!isComplete) {
      return res
        .status(400)
        .json({ success: false, error: 'Cannot claim reward for incomplete achievement' });
    }

    const amount = Number(achievement.points ?? 0);
    const amountBaseUnits = pointsToBaseUnits(amount);
    const claimId = buildClaimId(userId, achievementKey);

    // Recipient must be a real on-chain address for the payout.
    const [userRow] = await db
      .select({ walletAddress: users.walletAddress })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const walletAddress = userRow?.walletAddress;
    if (!isValidPayoutAddress(walletAddress)) {
      return res.status(422).json({
        success: false,
        error: 'A valid on-chain wallet address is required to receive the payout',
      });
    }

    // Idempotent claim marker: the contributor_rewards ledger row is the backend
    // dedup. A prior 'achievement' row for this achievementId means already claimed
    // — but with async on-chain settlement a repeat claim is NOT a hard failure; we
    // still re-POST the same claim_id to advance settlement (consensus dedups it).
    //
    // Concurrency (PR #889 review, P2): no unique key on the JSONB achievementId
    // marker, so we serialize on the earned achievement row with SELECT ... FOR
    // UPDATE: the second concurrent claim blocks until the first commits, then
    // observes the marker.
    const outcome = await db.transaction(async (tx) => {
      // #940 — serialize the mint path before ANY other lock in this transaction,
      // so the emission ceilings below are read-then-write under mutual exclusion
      // rather than racing. Released automatically at commit/rollback (xact).
      // See ACHIEVEMENT_MINT_LOCK_KEY for why it is global and why it is first.
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${ACHIEVEMENT_MINT_LOCK_KEY}, 0)`);

      await tx
        .select({ id: userAchievements.id })
        .from(userAchievements)
        .where(eq(userAchievements.id, earned.id))
        .for('update')
        .limit(1);

      const existing = await tx
        .select()
        .from(contributorRewards)
        .where(
          and(
            eq(contributorRewards.userId, userId),
            eq(contributorRewards.contributorType, ACHIEVEMENT_REWARD_TYPE),
            sql`${contributorRewards.metadata}->>'achievementId' = ${achievementKey}`
          )
        )
        .limit(1);
      if (existing.length > 0) {
        if (signedPayoutEnabled()) {
          const meta = existing[0].metadata as Record<string, unknown>;
          if (meta?.settlement === 'settled') {
            // Owner-scoped lookup above: acknowledge an existing terminal claim
            // without minting, replaying, or exposing its legacy metadata.
            return { alreadyClaimed: true as const, settledAcknowledgement: true as const, reward: existing[0] };
          }
          verifyPayoutAuthorization({
            achievementId: achievementKey, claimId: String(meta?.claimId || ''),
            address: String(meta?.address || ''),
            amountBaseUnits: BigInt(String(meta?.amountBaseUnits || '0')),
          }, meta?.payoutAuthorization);
        }
        return { alreadyClaimed: true as const, reward: existing[0] };
      }

      // #940 — emission budget. Reached ONLY on a first-ever claim, i.e. only when
      // this call would actually create new emission. A repeat claim returned
      // above re-POSTs an already-ledgered claim_id to advance settlement and
      // mints nothing, so charging it against the budget would double-count it and
      // could refuse a payout that is already owed.
      //
      // The sums run on `tx`, so they read the same snapshot the insert commits
      // into. What makes that read-then-write safe is the GLOBAL
      // `pg_advisory_xact_lock` taken at the top of this transaction — see
      // ACHIEVEMENT_MINT_LOCK_KEY.
      //
      // Explicitly NOT the `SELECT ... FOR UPDATE` above: that locks the
      // (user, achievement) row, so it does not serialize one user's concurrent
      // claims on DIFFERENT achievements. An earlier version of this comment
      // claimed it did; that was wrong, and it is the reason the advisory lock
      // exists rather than being redundant with the row lock.
      const payoutAuthorization = signedPayoutEnabled()
        ? await authorizeNewPayout(tx, {
            achievementId: achievementKey, claimId, address: walletAddress, amountBaseUnits,
          }, req.body?.payoutAuthorization)
        : undefined;
      const budgetDecision = await evaluateClaimBudget(tx, userId, amount);
      if (isRefusal(budgetDecision)) {
        return { refused: true as const, decision: budgetDecision };
      }

      const [inserted] = await tx
        .insert(contributorRewards)
        .values({
          userId,
          contributorType: ACHIEVEMENT_REWARD_TYPE,
          amount,
          reason: `Achievement reward: ${achievement.title}`,
          metadata: {
            achievementId: achievementKey,
            achievementRowId: achievement.id,
            ...(payoutAuthorization ? { payoutAuthorization } : {}),
            onChain: true,
            // Settlement starts pending; advanced below once core4 responds. The
            // claim_id/address/amount are persisted so the reconciler can re-POST.
            settlement: 'pending',
            claimId,
            address: payoutAuthorization ? canonicalRecipient(walletAddress) : walletAddress,
            amountBaseUnits: amountBaseUnits.toString(),
          },
        })
        .returning();

      // Flip the achievement to 'claimed' so the app can hide the claim CTA.
      const priorMeta =
        earned.metadata && typeof earned.metadata === 'object'
          ? (earned.metadata as Record<string, unknown>)
          : {};
      await tx
        .update(userAchievements)
        .set({
          status: 'claimed',
          metadata: { ...priorMeta, claimedAt: new Date().toISOString() },
        })
        .where(eq(userAchievements.id, earned.id));

      return { alreadyClaimed: false as const, reward: inserted };
    });

    // Drive (or advance) the on-chain payout. Source the payout inputs from the
    // PERSISTED ledger row — NEVER recompute {address, amount} for an existing
    // claim_id. Only the first-ever claim computes them (and persisted them in the
    // insert above); a repeat claim must re-POST the exact tuple bound to that
    // claim_id, or a wallet/points change between claims would send drifted
    // {address, amount} under the same claim_id (core4 dedups so it won't
    // double-pay, but the backend could then record/settle a mismatched tuple —
    // and if the original submit expired unmined, the drifted re-POST is what
    // lands). This mirrors what the reconciler does.
    // #940 — the emission ceiling refused. Nothing was inserted, the achievement
    // was NOT flipped to 'claimed', and no payout is submitted: the claim stays
    // claimable once the window rolls over or an owner raises the limit.
    if ('refused' in outcome && outcome.refused) {
      const reason = describeRefusal(outcome.decision);
      appLogger.warn('Achievement claim refused by the emission budget (#940)', {
        userId,
        achievementId: achievementKey,
        rule: outcome.decision.rule,
        limit: outcome.decision.limit,
        observed: outcome.decision.observed,
        requested: outcome.decision.requested,
      });
      return res.status(429).json({
        success: false,
        error: reason,
        code: 'EMISSION_BUDGET_EXCEEDED',
        rule: outcome.decision.rule,
      });
    }

    if ('settledAcknowledgement' in outcome && outcome.settledAcknowledgement) {
      return res.status(200).json({
        success: true,
        alreadyClaimed: true,
        settlement: { state: 'settled', terminal: true },
      });
    }

    const ledgerRow = outcome.reward as Record<string, unknown> | undefined;
    const rowId = ledgerRow?.id as number | undefined;
    const priorRowMeta =
      ledgerRow?.metadata && typeof ledgerRow.metadata === 'object'
        ? (ledgerRow.metadata as Record<string, unknown>)
        : { achievementId: achievementKey, claimId, address: walletAddress, amountBaseUnits: amountBaseUnits.toString() };

    const persistedClaimId =
      typeof priorRowMeta.claimId === 'string' ? priorRowMeta.claimId : claimId;
    const persistedAddress =
      typeof priorRowMeta.address === 'string' ? priorRowMeta.address : walletAddress;
    let persistedAmount = amountBaseUnits;
    try {
      if (priorRowMeta.amountBaseUnits !== undefined && priorRowMeta.amountBaseUnits !== null) {
        persistedAmount = BigInt(String(priorRowMeta.amountBaseUnits));
      }
    } catch {
      persistedAmount = amountBaseUnits;
    }

    const payout = await submitPayout({
      address: persistedAddress,
      amountBaseUnits: persistedAmount,
      claimId: persistedClaimId,
      ...(signedPayoutEnabled()
        ? { achievementId: achievementKey, authorization: priorRowMeta.payoutAuthorization }
        : {}),
    });
    const settlement = settlementFromPayout(payout, priorAttempts(priorRowMeta));

    // Persist the settlement state onto the ledger row. Also BACKFILL the replay
    // tuple (claimId/address/amountBaseUnits) when it is absent — e.g. a row
    // created by the pre-rewire ledger-only handler (#889), which has no persisted
    // payout fields. Backfilling once makes every subsequent re-POST stable and
    // drift-free (otherwise a later repeat claim would recompute from current
    // values again). Existing on-chain rows already carry these, so this is a
    // no-op for them (we write back the same values we just read).
    if (rowId !== undefined) {
      const backfilled = {
        ...priorRowMeta,
        claimId: persistedClaimId,
        address: persistedAddress,
        amountBaseUnits: persistedAmount.toString(),
      };
      await db
        .update(contributorRewards)
        .set({ metadata: mergeSettlementMetadata(backfilled, settlement) })
        .where(eq(contributorRewards.id, rowId));
    }

    const permanentlyFailed = settlement.settlement === 'failed';

    if (payout.kind === 'error') {
      appLogger.error(
        permanentlyFailed
          ? 'Achievement payout permanently failed; claim recorded, will NOT be retried'
          : 'Achievement payout not enqueued; claim recorded, will reconcile',
        {
          claimId,
          code: payout.code,
          message: payout.message,
          settlement: settlement.settlement,
          attempts: settlement.attempts,
        }
      );
    }

    return res.status(settlement.httpStatus).json({
      // #890 HIGH-2: a terminally failed payout must not report success. The
      // ledger row still exists, but nothing will ever be minted for it, and
      // telling the caller otherwise is the half of this defect the user sees.
      success: !permanentlyFailed,
      alreadyClaimed: outcome.alreadyClaimed,
      reward: outcome.reward,
      settlement: {
        state: settlement.settlement,
        status: settlement.payoutStatus,
        txHash: settlement.txHash,
        onChain: true,
        note: settlement.note,
        terminal: settlement.terminal,
        attempts: settlement.attempts,
      },
      message:
        // Report the amount actually bound to this claim_id (persisted), which for
        // a repeat claim may differ from the achievement's current points.
        settlement.settlement === 'settled'
          ? `Reward of ${persistedAmount / 100_000_000n} WRF for "${achievement.title}" has settled on-chain.`
          : permanentlyFailed
            ? `Claim for "${achievement.title}" could not be paid out and will not be retried. Contact support with claim ${persistedClaimId}.`
            : `Claim for ${persistedAmount / 100_000_000n} WRF ("${achievement.title}") accepted; settling on-chain.`,
    });
  } catch (error) {
    if (error instanceof PayoutAuthorizationError) {
      return res.status(403).json({
        success: false, code: 'PAYOUT_AUTHORIZATION_REQUIRED', error: error.message,
      });
    }
    appLogger.error('Error claiming achievement reward', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json({ success: false, error: 'Error claiming achievement reward' });
  }
});

/**
 * Paged reward history for the authenticated user (keyset by descending id).
 * Query: `?limit=` (1–100, default 25), `?before=<id>` for the next page.
 */
router.get('/history', async (req: Request, res: Response) => {
  try {
    const userId = await resolveUserId(req);
    if (userId === null) {
      return res.status(401).json({ success: false, error: 'Unauthenticated' });
    }

    const DEFAULT_LIMIT = 25;
    const MAX_LIMIT = 100;
    const parsedLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const beforeId = Number(req.query.before);
    const conditions = [eq(contributorRewards.userId, userId)];
    if (Number.isInteger(beforeId) && beforeId > 0) {
      conditions.push(lt(contributorRewards.id, beforeId));
    }

    // Fetch one extra to detect whether another page exists.
    const rows = await db
      .select()
      .from(contributorRewards)
      .where(and(...conditions))
      .orderBy(desc(contributorRewards.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const nextCursor = hasMore && page.length > 0 ? page[page.length - 1].id : null;

    return res.json({
      success: true,
      history: page,
      hasMore,
      nextCursor,
    });
  } catch (error) {
    appLogger.error('Error fetching reward history', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });
    return res.status(500).json({ success: false, error: 'Error fetching reward history' });
  }
});

export default router;
