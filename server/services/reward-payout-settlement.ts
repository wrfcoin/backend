/**
 * Shared settlement-state helpers for the #215 on-chain achievement payout.
 *
 * Settlement is ASYNCHRONOUS: the core4 `POST /rewards/payout` 202 only means the
 * payout tx was enqueued — it SETTLES when mined. We track that lifecycle on the
 * `contributor_rewards` ledger row's JSONB `metadata.settlement`:
 *
 *   pending  → recorded on the backend, not yet successfully enqueued on core4
 *              (never submitted, or a retryable failure — the reconciler retries).
 *   settling → core4 accepted/pending (tx enqueued, tx_hash known, not yet mined).
 *   settled  → core4 reported already_processed (applied on-chain). TERMINAL.
 *   failed   → this claim can never settle. TERMINAL.
 *
 * Re-POSTing the same claim_id is always safe (consensus dedups on claim_id), so
 * the reconciler simply re-submits until it sees already_processed → settled.
 *
 * ## Why `failed` exists (#890 HIGH-2)
 *
 * Every non-success outcome previously mapped back to `pending`, and the sweep
 * selects `settlement IN ('pending','settling')`. A deterministic input failure
 * — `points: 0`, or points above the 200 WRF per-payout cap — is rejected
 * BEFORE the network call, so it returned to `pending` and was re-submitted
 * every 60 seconds forever, with identical arguments and therefore an identical
 * result. The user had already been told `success: true`.
 *
 * Two guards, because they fail differently:
 *
 *   1. A deterministic validation failure (`PayoutError.validation`) goes
 *      STRAIGHT to `failed`. Retrying is not merely wasteful, it is provably
 *      pointless: the inputs are fixed and they are the reason for the failure.
 *   2. Everything else that is not yet settled carries an attempt counter and
 *      goes to `failed` once it exceeds MAX_SETTLEMENT_ATTEMPTS. This bounds
 *      the failures we cannot classify — a missing operator token, or a hard
 *      error from core4 — without declaring them unfixable on the first pass.
 *
 * Both terminal states are excluded from the sweep by that same `IN` clause, so
 * no reconciler change is needed to stop re-driving them.
 */

import crypto from 'node:crypto';
import { WRF_UNITS_PER_COIN, type PayoutResult } from './reward-payout-client.js';

export type SettlementState = 'pending' | 'settling' | 'settled' | 'failed';

/** States the reconciler must never re-drive. */
export const TERMINAL_SETTLEMENT_STATES: ReadonlySet<SettlementState> = new Set([
  'settled',
  'failed',
]);

export function isTerminalSettlement(state: unknown): boolean {
  return typeof state === 'string' && TERMINAL_SETTLEMENT_STATES.has(state as SettlementState);
}

/**
 * Retry budget for failures we cannot prove are permanent. At the default 60s
 * sweep this is ~10 minutes of retrying before a claim is parked for a human.
 * Overridable so an operator can widen it without a deploy.
 */
export const MAX_SETTLEMENT_ATTEMPTS = Math.max(
  1,
  Number(process.env.REWARD_PAYOUT_MAX_ATTEMPTS) || 10
);

/** Read the persisted attempt count off a ledger row's metadata. */
export function priorAttempts(meta: Record<string, unknown> | null | undefined): number {
  const raw = meta?.settlementAttempts;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Economic mapping: 1 achievement point = 1 WRF (assumption — flag for product
 * confirmation; kept in one place so it is trivial to change). Achievement
 * `points` are whole-WRF reward amounts; convert to u128 base units for core4.
 */
export const WRF_PER_ACHIEVEMENT_POINT = 1n;

export function pointsToBaseUnits(points: number): bigint {
  const p = Number.isFinite(points) && points > 0 ? Math.floor(points) : 0;
  return BigInt(p) * WRF_PER_ACHIEVEMENT_POINT * WRF_UNITS_PER_COIN;
}

/**
 * Deterministic idempotency key for a (user, achievement) claim. Deterministic so
 * the reconciler can re-POST without reading anything back, and stable so core4's
 * dedup collapses repeat claims to a single mint. Bounded to the contract's 128
 * bytes (achievementId is user-facing text of unbounded length).
 */
export function buildClaimId(userId: number, achievementKey: string): string {
  const raw = `ach:v1:${userId}:${achievementKey}`;
  if (Buffer.byteLength(raw, 'utf8') <= 128) {
    return raw;
  }
  // Over the 128-byte limit: DON'T truncate the raw string — two distinct
  // achievementIds sharing a 128-byte prefix would collapse to the same claim_id
  // and one would block the other's payout. Use a collision-resistant digest of
  // the full key instead (deterministic, stable, well within 128 bytes).
  const digest = crypto.createHash('sha256').update(achievementKey, 'utf8').digest('hex');
  return `ach:v1:${userId}:h:${digest}`;
}

export interface SettlementUpdate {
  settlement: SettlementState;
  /** The raw core4 status, when we got one. */
  payoutStatus: string | null;
  txHash: string | null;
  /** Last error/reason when not yet settled (for observability). */
  note: string | null;
  /** HTTP-ish status to return to the mobile caller. */
  httpStatus: number;
  /** Submission attempts consumed so far, persisted for the next sweep. */
  attempts: number;
  /** True when this row must never be re-driven again. */
  terminal: boolean;
}

/**
 * Map a payout client result to a ledger settlement update + response status.
 *
 * `attemptsBefore` is the attempt count already persisted on the row; pass
 * `priorAttempts(meta)`. It defaults to 0 so a first submission needs nothing.
 */
export function settlementFromPayout(
  result: PayoutResult,
  attemptsBefore = 0
): SettlementUpdate {
  const attempts = Math.max(0, Math.floor(attemptsBefore)) + 1;

  if (result.kind === 'success') {
    if (result.status === 'already_processed') {
      return {
        settlement: 'settled',
        payoutStatus: 'already_processed',
        txHash: result.txHash,
        note: null,
        httpStatus: 200,
        attempts,
        terminal: true,
      };
    }
    // accepted | pending — tx enqueued, settles when mined. Not terminal: the
    // sweep still has to observe already_processed.
    return {
      settlement: 'settling',
      payoutStatus: result.status,
      txHash: result.txHash,
      note: null,
      httpStatus: 202,
      attempts,
      terminal: false,
    };
  }

  const note = `${result.code}: ${result.message}`;

  // Guard 1 — deterministic input validation. The arguments are the defect and
  // they do not change between sweeps, so retrying is provably pointless. Go
  // terminal immediately and surface the real 4xx rather than a false 202.
  if (result.kind === 'error' && result.validation === true) {
    return {
      settlement: 'failed',
      payoutStatus: null,
      txHash: null,
      note: `non-retryable ${note}`,
      httpStatus: result.httpStatus ?? 422,
      attempts,
      terminal: true,
    };
  }

  // Guard 2 — everything else unsettled: retryable failures, a missing operator
  // token, or a hard error from core4. Any of these may clear on its own, so
  // keep retrying, but bound it so a stuck claim is parked for a human instead
  // of sweeping forever.
  if (attempts >= MAX_SETTLEMENT_ATTEMPTS) {
    return {
      settlement: 'failed',
      payoutStatus: null,
      txHash: null,
      note: `attempts exhausted (${attempts}/${MAX_SETTLEMENT_ATTEMPTS}) — last: ${note}`,
      httpStatus: 202,
      attempts,
      terminal: true,
    };
  }

  // Claim is NOT lost — leave it pending for the reconciler.
  return {
    settlement: 'pending',
    payoutStatus: null,
    txHash: null,
    note,
    httpStatus: 202,
    attempts,
    terminal: false,
  };
}

/**
 * Merge a settlement update into a ledger row's existing metadata object,
 * preserving the claim marker fields.
 */
export function mergeSettlementMetadata(
  prior: Record<string, unknown>,
  update: SettlementUpdate
): Record<string, unknown> {
  return {
    ...prior,
    onChain: true,
    settlement: update.settlement,
    settlementStatus: update.payoutStatus,
    txHash: update.txHash ?? (prior.txHash as string | undefined) ?? null,
    payoutNote: update.note,
    settlementUpdatedAt: new Date().toISOString(),
    // Persisted so the next sweep can resume the retry budget rather than
    // restarting it — without this the attempt counter never advances and the
    // bound in guard 2 is unreachable.
    settlementAttempts: update.attempts,
    settlementTerminal: update.terminal,
  };
}
