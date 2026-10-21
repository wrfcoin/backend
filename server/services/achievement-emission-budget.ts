/**
 * Achievement emission budget (backend#940 — LAUNCH BLOCKER).
 *
 * The achievement mint path authorizes on the *existence* of a `user_achievements`
 * row, and that table's `progress`/`status` columns default to `100`/`'completed'`.
 * A bare insert is therefore immediately mintable. Until the authorization side is
 * fixed (tracked separately — see the PR body), the ceiling is what bounds the
 * damage: no single claim, no single user, and no single day may emit more than a
 * configured amount of WRF.
 *
 * Two properties this module is built around:
 *
 *   1. **It is a pure policy function.** `evaluateEmissionBudget` does no I/O, so
 *      the bound can be tested exhaustively without a database. The caller owns
 *      the aggregate query and the fail-closed error handling.
 *   2. **It fails closed on a malformed limit.** An unparseable or negative
 *      `ACHIEVEMENT_*` env var falls back to the built-in default rather than
 *      widening to `Infinity`. A typo in a deploy manifest must not silently
 *      remove the ceiling — that is the exact failure mode #940 is about.
 *
 * Amounts here are **WRF whole units**, matching `achievements.points` and the
 * `contributor_rewards.amount` integer column. The base-unit conversion
 * (`WRF_UNITS_PER_COIN = 10^8`) happens downstream in the payout client; the
 * budget deliberately operates on the same units as the ledger it sums, so the
 * comparison never crosses a unit boundary.
 */

/** Ceilings applied to the achievement mint path, in whole WRF. */
export interface EmissionLimits {
  /** Maximum a single claim may emit. */
  perClaim: number;
  /** Maximum one user may emit in the rolling window. */
  userDaily: number;
  /** Maximum one user may emit over the lifetime of the ledger. */
  userLifetime: number;
  /** Maximum all users combined may emit in the rolling window. */
  globalDaily: number;
}

/** Observed achievement emission, summed from `contributor_rewards`. */
export interface EmissionTotals {
  /** This user's emission inside the rolling window. */
  userDay: number;
  /** This user's emission over all time. */
  userLifetime: number;
  /** All users' emission inside the rolling window. */
  globalDay: number;
}

/** A refusal, carrying everything the log line and the API error need. */
export interface BudgetRefusal {
  allowed: false;
  /** Which ceiling refused. */
  rule:
    | 'per-claim'
    | 'user-daily'
    | 'user-lifetime'
    | 'global-daily'
    | 'invalid-amount'
    /** The budget could not be read at all — the fail-closed path. */
    | 'budget-unreadable';
  limit: number;
  /**
   * Already-emitted total the request was measured against. `NaN` when the total
   * could not be read; `describeRefusal` must not render an arithmetic result in
   * that case (it would read "NaN WRF" on a public error surface).
   */
  observed: number;
  requested: number;
}

export type BudgetDecision = { allowed: true } | BudgetRefusal;

/**
 * Narrow a decision to a refusal.
 *
 * This exists rather than an inline `if (!decision.allowed)` because the repo
 * compiles with `strict: false`, under which TypeScript does not reliably narrow
 * a boolean-literal discriminant — the refusal fields get widened away and the
 * build fails. A user-defined type guard narrows regardless of strictness.
 */
export function isRefusal(decision: BudgetDecision): decision is BudgetRefusal {
  return decision.allowed === false;
}

/**
 * Built-in ceilings. These are **placeholders pending an owner decision on
 * emission policy** — they are deliberately finite rather than deliberately
 * correct. A finite wrong number fails closed and is visible; no number at all
 * is the launch blocker.
 */
export const DEFAULT_EMISSION_LIMITS: Readonly<EmissionLimits> = Object.freeze({
  perClaim: 200,
  userDaily: 1_000,
  userLifetime: 5_000,
  globalDaily: 100_000,
});

/** Rolling window the daily ceilings are measured over. */
export const EMISSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Parse one limit from the environment, falling back to `fallback` when the value
 * is absent, unparseable, negative, or non-finite. Returns the fallback rather
 * than throwing so a bad manifest degrades to the safe ceiling instead of
 * crashing the route — but it never degrades to *no* ceiling.
 */
function readLimit(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/**
 * Resolve the active ceilings from the environment. Every field is guaranteed
 * finite and non-negative on return.
 */
export function loadEmissionLimits(env: NodeJS.ProcessEnv = process.env): EmissionLimits {
  return {
    perClaim: readLimit(env.ACHIEVEMENT_MAX_CLAIM_WRF, DEFAULT_EMISSION_LIMITS.perClaim),
    userDaily: readLimit(env.ACHIEVEMENT_USER_DAILY_WRF, DEFAULT_EMISSION_LIMITS.userDaily),
    userLifetime: readLimit(
      env.ACHIEVEMENT_USER_LIFETIME_WRF,
      DEFAULT_EMISSION_LIMITS.userLifetime
    ),
    globalDaily: readLimit(env.ACHIEVEMENT_GLOBAL_DAILY_WRF, DEFAULT_EMISSION_LIMITS.globalDaily),
  };
}

/**
 * Decide whether emitting `amount` WRF is within every ceiling.
 *
 * Ceilings are checked cheapest-first and the *first* refusal is reported, so the
 * error names the tightest binding rule rather than an arbitrary one.
 */
export function evaluateEmissionBudget(args: {
  amount: number;
  totals: EmissionTotals;
  limits: EmissionLimits;
}): BudgetDecision {
  const { amount, totals, limits } = args;

  // A non-finite or negative amount is not a small mint, it is a broken one.
  if (!Number.isFinite(amount) || amount < 0) {
    return {
      allowed: false,
      rule: 'invalid-amount',
      limit: limits.perClaim,
      observed: 0,
      requested: amount,
    };
  }

  if (amount > limits.perClaim) {
    return {
      allowed: false,
      rule: 'per-claim',
      limit: limits.perClaim,
      observed: 0,
      requested: amount,
    };
  }

  const checks: Array<{
    rule: 'user-daily' | 'user-lifetime' | 'global-daily';
    observed: number;
    limit: number;
  }> = [
    { rule: 'user-daily', observed: totals.userDay, limit: limits.userDaily },
    { rule: 'user-lifetime', observed: totals.userLifetime, limit: limits.userLifetime },
    { rule: 'global-daily', observed: totals.globalDay, limit: limits.globalDaily },
  ];

  for (const check of checks) {
    // A non-finite observed total means the aggregate query returned something we
    // cannot reason about. Refuse rather than compare against NaN, which would
    // silently evaluate false and let the mint through.
    if (!Number.isFinite(check.observed)) {
      return {
        allowed: false,
        rule: check.rule,
        limit: check.limit,
        observed: check.observed,
        requested: amount,
      };
    }
    if (check.observed + amount > check.limit) {
      return {
        allowed: false,
        rule: check.rule,
        limit: check.limit,
        observed: check.observed,
        requested: amount,
      };
    }
  }

  return { allowed: true };
}

/**
 * Coerce a SQL aggregate (Postgres returns `SUM()` as a string, and `NULL` for an
 * empty set) into a number. An empty set is a legitimate zero; anything that does
 * not parse yields `NaN`, which `evaluateEmissionBudget` treats as a refusal.
 */
export function coerceEmissionTotal(raw: unknown): number {
  if (raw === null || raw === undefined) return 0;
  if (typeof raw === 'number') return raw;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : NaN;
}

/** Human-readable refusal reason for the API error body and the log line. */
export function describeRefusal(decision: BudgetRefusal): string {
  switch (decision.rule) {
    case 'invalid-amount':
      return `Refusing to mint an invalid amount (${decision.requested})`;
    case 'budget-unreadable':
      // Deliberately renders no arithmetic: `observed` is NaN on this path, and
      // "would put emission at NaN WRF" is not something to show a caller.
      return 'The achievement emission budget could not be read; refusing the claim';
    case 'per-claim':
      return `Claim of ${decision.requested} WRF exceeds the ${decision.limit} WRF per-claim ceiling`;
    case 'user-daily':
      return `Claim of ${decision.requested} WRF would put this user at ${
        decision.observed + decision.requested
      } WRF in 24h, over the ${decision.limit} WRF daily cap`;
    case 'user-lifetime':
      return `Claim of ${decision.requested} WRF would put this user at ${
        decision.observed + decision.requested
      } WRF lifetime, over the ${decision.limit} WRF cap`;
    case 'global-daily':
      return `Claim of ${decision.requested} WRF would put total achievement emission at ${
        decision.observed + decision.requested
      } WRF in 24h, over the ${decision.limit} WRF global budget`;
  }
}
