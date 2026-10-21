/**
 * Reward-payout reconciler (#215 on-chain rewire).
 *
 * Achievement payouts settle asynchronously (a core4 202 means enqueued, not
 * mined). This sweep advances ledger rows stuck in `pending`/`settling` toward
 * `settled` by RE-POSTing the same `claim_id` — always safe, because core4 dedups
 * on claim_id and only reports `already_processed` once the payout is applied
 * on-chain. Retryable failures (over-supply / partition) leave the row pending
 * for a later pass; the claim is never lost.
 *
 * Wired to a guarded interval in the live entrypoint (OFF by default until core4
 * PR #2081 is deployed) and directly unit-testable via injected deps.
 */

import { signedPayoutEnabled, verifyPayoutAuthorization } from './achievement-payout-authorization.js';
import { db as defaultDb } from '../../database/index.js';
import { eq, sql } from 'drizzle-orm';
import { contributorRewards } from '../../shared/schema.js';
import { appLogger } from '../utils/logger.js';
import { submitPayout as defaultSubmitPayout } from './reward-payout-client.js';
import {
  settlementFromPayout,
  mergeSettlementMetadata,
  priorAttempts,
} from './reward-payout-settlement.js';

export interface ReconcileDeps {
  db: { select: (...a: unknown[]) => any; update: (...a: unknown[]) => any };
  submitPayout: typeof defaultSubmitPayout;
}

export interface ReconcileSummary {
  scanned: number;
  settled: number;
  stillPending: number;
  skipped: number;
  /**
   * Rows moved to the terminal `failed` state this pass — a non-retryable
   * validation failure, or the retry budget exhausted. These leave the sweep
   * set permanently and need a human, so they are counted separately rather
   * than folded into `stillPending` (#890 HIGH-2).
   */
  failed: number;
}

const defaultDeps: ReconcileDeps = {
  db: defaultDb as unknown as ReconcileDeps['db'],
  submitPayout: defaultSubmitPayout,
};

/**
 * Re-drive unsettled on-chain achievement payouts. Returns a summary; never
 * throws for a per-row failure (logged and counted, sweep continues).
 */
export async function reconcilePendingPayouts(
  options: { limit?: number } = {},
  deps: Partial<ReconcileDeps> = {}
): Promise<ReconcileSummary> {
  const { db, submitPayout } = { ...defaultDeps, ...deps };
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);

  const rows: Array<Record<string, unknown>> = await db
    .select()
    .from(contributorRewards)
    .where(
      sql`${contributorRewards.metadata}->>'onChain' = 'true' AND ${contributorRewards.metadata}->>'settlement' IN ('pending','settling')`
    )
    .orderBy(contributorRewards.id)
    .limit(limit);

  const summary: ReconcileSummary = {
    scanned: rows.length,
    settled: 0,
    stillPending: 0,
    skipped: 0,
    failed: 0,
  };

  for (const row of rows) {
    const meta =
      row.metadata && typeof row.metadata === 'object'
        ? (row.metadata as Record<string, unknown>)
        : {};
    const claimId = typeof meta.claimId === 'string' ? meta.claimId : null;
    const address = typeof meta.address === 'string' ? meta.address : null;
    const amountRaw = meta.amountBaseUnits;

    let amountBaseUnits: bigint | null = null;
    try {
      amountBaseUnits = amountRaw !== undefined && amountRaw !== null ? BigInt(String(amountRaw)) : null;
    } catch {
      amountBaseUnits = null;
    }

    // A row missing its re-POST inputs can't be reconciled automatically.
    if (!claimId || !address || amountBaseUnits === null) {
      summary.skipped += 1;
      appLogger.warn('Skipping unreconcilable payout row (missing claimId/address/amount)', {
        rowId: row.id,
      });
      continue;
    }

    let signed = false;
    try {
      signed = signedPayoutEnabled();
      if (signed) verifyPayoutAuthorization({
        achievementId: String(meta.achievementId || ''), address, amountBaseUnits, claimId,
      }, meta.payoutAuthorization);
    } catch {
      // Keep unauthorized/legacy liabilities intact; do not submit or erase them.
      summary.skipped += 1;
      continue;
    }
    const result = await submitPayout({ address, amountBaseUnits, claimId,
      ...(signed ? { achievementId: String(meta.achievementId), authorization: meta.payoutAuthorization } : {}),
    });
    // Resume the retry budget from the row rather than restarting it — a
    // counter that resets every pass can never reach its bound.
    const settlement = settlementFromPayout(result, priorAttempts(meta));

    await db
      .update(contributorRewards)
      .set({ metadata: mergeSettlementMetadata(meta, settlement) })
      .where(eq(contributorRewards.id, row.id as number));

    if (settlement.settlement === 'settled') {
      summary.settled += 1;
    } else if (settlement.settlement === 'failed') {
      summary.failed += 1;
      appLogger.error('Reward payout moved to terminal failed; will not be retried', {
        rowId: row.id,
        claimId,
        attempts: settlement.attempts,
        note: settlement.note,
      });
    } else {
      summary.stillPending += 1;
    }
  }

  if (summary.scanned > 0) {
    appLogger.info('Reward payout reconcile pass complete', { ...summary });
  }
  return summary;
}

let reconcileTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Start the guarded periodic reconciler. No-op unless
 * REWARD_PAYOUT_RECONCILE_ENABLED=true (keeps it dormant until core4 #2081 is
 * live). Returns true when a sweep was scheduled.
 */
export function startPayoutReconciler(): boolean {
  if (process.env.REWARD_PAYOUT_RECONCILE_ENABLED !== 'true') {
    return false;
  }
  if (reconcileTimer) {
    return true;
  }
  const intervalMs = Number(process.env.REWARD_PAYOUT_RECONCILE_INTERVAL_MS) || 60_000;
  reconcileTimer = setInterval(() => {
    reconcilePendingPayouts().catch((error) => {
      appLogger.error('Reward payout reconcile sweep failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, intervalMs);
  // Don't keep the event loop alive for this background sweep.
  reconcileTimer.unref?.();
  appLogger.info('Reward payout reconciler started', { intervalMs });
  return true;
}

export function stopPayoutReconciler(): void {
  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }
}
