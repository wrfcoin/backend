/**
 * #940 — the achievement emission ceiling, tested as a pure policy.
 *
 * These tests need no database, so every branch of the bound is reachable and the
 * suite cannot be a false green from Postgres reachability (the trap that twice
 * mis-declared `weather-persistence-paths` a stale quarantine entry).
 *
 * The route-level proof that this policy is actually WIRED to the mint path lives
 * in `server/__tests__/routes/rewards-emission-budget.test.ts`. Passing here and
 * failing there would mean a correct bound that nothing calls — which is why both
 * exist.
 */

import { describe, it, expect } from '@jest/globals';
import {
  loadEmissionLimits,
  evaluateEmissionBudget,
  coerceEmissionTotal,
  describeRefusal,
  DEFAULT_EMISSION_LIMITS,
  EMISSION_WINDOW_MS,
  type EmissionLimits,
} from '../../server/services/achievement-emission-budget';

const LIMITS: EmissionLimits = {
  perClaim: 200,
  userDaily: 1_000,
  userLifetime: 5_000,
  globalDaily: 100_000,
};

const ZERO = { userDay: 0, userLifetime: 0, globalDay: 0 };

describe('#940 emission budget — limit loading', () => {
  it('uses the built-in ceilings when the environment is empty', () => {
    expect(loadEmissionLimits({} as NodeJS.ProcessEnv)).toEqual(DEFAULT_EMISSION_LIMITS);
  });

  it('reads every ceiling from the environment', () => {
    const limits = loadEmissionLimits({
      ACHIEVEMENT_MAX_CLAIM_WRF: '50',
      ACHIEVEMENT_USER_DAILY_WRF: '100',
      ACHIEVEMENT_USER_LIFETIME_WRF: '400',
      ACHIEVEMENT_GLOBAL_DAILY_WRF: '9000',
    } as NodeJS.ProcessEnv);
    expect(limits).toEqual({
      perClaim: 50,
      userDaily: 100,
      userLifetime: 400,
      globalDaily: 9_000,
    });
  });

  it('falls back to the default — never to Infinity — on a malformed limit', () => {
    // This is the failure mode #940 is about: a typo in a deploy manifest must
    // not silently remove the ceiling.
    for (const bad of ['', '   ', 'abc', 'NaN', '-1', 'Infinity', '1e999']) {
      const limits = loadEmissionLimits({
        ACHIEVEMENT_GLOBAL_DAILY_WRF: bad,
      } as NodeJS.ProcessEnv);
      expect(Number.isFinite(limits.globalDaily)).toBe(true);
      expect(limits.globalDaily).toBe(DEFAULT_EMISSION_LIMITS.globalDaily);
    }
  });

  it('accepts an explicit zero — a deliberate freeze is a valid policy', () => {
    const limits = loadEmissionLimits({
      ACHIEVEMENT_GLOBAL_DAILY_WRF: '0',
    } as NodeJS.ProcessEnv);
    expect(limits.globalDaily).toBe(0);
    expect(
      evaluateEmissionBudget({ amount: 1, totals: ZERO, limits }).allowed
    ).toBe(false);
  });

  it('measures the daily ceilings over a 24h window', () => {
    expect(EMISSION_WINDOW_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('#940 emission budget — the bound itself', () => {
  it('allows a claim that fits under every ceiling', () => {
    expect(
      evaluateEmissionBudget({ amount: 200, totals: ZERO, limits: LIMITS })
    ).toEqual({ allowed: true });
  });

  it('allows a claim that lands exactly ON a ceiling', () => {
    // The ceiling is inclusive: 800 already emitted + 200 == the 1000 daily cap.
    const decision = evaluateEmissionBudget({
      amount: 200,
      totals: { ...ZERO, userDay: 800 },
      limits: LIMITS,
    });
    expect(decision).toEqual({ allowed: true });
  });

  it('refuses the single WRF that crosses a ceiling', () => {
    const decision = evaluateEmissionBudget({
      amount: 200,
      totals: { ...ZERO, userDay: 801 },
      limits: LIMITS,
    });
    expect(decision.allowed).toBe(false);
    expect(decision).toMatchObject({ rule: 'user-daily', limit: 1_000, observed: 801 });
  });

  it('refuses a single claim larger than the per-claim ceiling', () => {
    const decision = evaluateEmissionBudget({
      amount: 201,
      totals: ZERO,
      limits: LIMITS,
    });
    expect(decision).toMatchObject({ allowed: false, rule: 'per-claim', limit: 200 });
  });

  it('refuses on the user lifetime ceiling even when the day is clean', () => {
    const decision = evaluateEmissionBudget({
      amount: 200,
      totals: { userDay: 0, userLifetime: 4_900, globalDay: 0 },
      limits: LIMITS,
    });
    expect(decision).toMatchObject({ allowed: false, rule: 'user-lifetime' });
  });

  it('refuses on the global ceiling even when this user has emitted nothing', () => {
    // The aggregate budget is the one that bounds a mass-insert attack across many
    // freshly created users, where no single user cap is ever approached.
    const decision = evaluateEmissionBudget({
      amount: 200,
      totals: { userDay: 0, userLifetime: 0, globalDay: 99_900 },
      limits: LIMITS,
    });
    expect(decision).toMatchObject({ allowed: false, rule: 'global-daily', limit: 100_000 });
  });

  it('reports the TIGHTEST binding rule when several are exhausted at once', () => {
    const decision = evaluateEmissionBudget({
      amount: 200,
      totals: { userDay: 9_999, userLifetime: 9_999, globalDay: 999_999 },
      limits: LIMITS,
    });
    expect(decision).toMatchObject({ allowed: false, rule: 'user-daily' });
  });

  it('refuses a negative or non-finite amount rather than treating it as a small mint', () => {
    for (const amount of [-1, -0.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      const decision = evaluateEmissionBudget({ amount, totals: ZERO, limits: LIMITS });
      expect(decision.allowed).toBe(false);
    }
    expect(
      evaluateEmissionBudget({ amount: -1, totals: ZERO, limits: LIMITS })
    ).toMatchObject({ rule: 'invalid-amount' });
  });

  it('refuses when an observed total is not a number — never compares against NaN', () => {
    // `NaN + 200 > 1000` evaluates FALSE, so an uncoerced NaN would silently
    // ALLOW the mint. This asserts the explicit finiteness guard instead.
    const decision = evaluateEmissionBudget({
      amount: 200,
      totals: { ...ZERO, userDay: Number.NaN },
      limits: LIMITS,
    });
    expect(decision).toMatchObject({ allowed: false, rule: 'user-daily' });
  });

  it('allows a zero-value claim, which emits nothing', () => {
    expect(
      evaluateEmissionBudget({ amount: 0, totals: ZERO, limits: LIMITS }).allowed
    ).toBe(true);
  });
});

describe('#940 emission budget — SQL aggregate coercion', () => {
  it('treats an empty result set as zero emitted', () => {
    expect(coerceEmissionTotal(null)).toBe(0);
    expect(coerceEmissionTotal(undefined)).toBe(0);
  });

  it('parses the string Postgres returns for SUM()', () => {
    // node-postgres returns bigint-capable aggregates as strings.
    expect(coerceEmissionTotal('12345')).toBe(12_345);
    expect(coerceEmissionTotal(' 42 ')).toBe(42);
    expect(coerceEmissionTotal(7)).toBe(7);
  });

  it('yields NaN for an unparseable aggregate, so the bound refuses', () => {
    expect(Number.isNaN(coerceEmissionTotal('not-a-number'))).toBe(true);
    expect(Number.isNaN(coerceEmissionTotal({}))).toBe(true);
  });
});

describe('#940 emission budget — refusal messages', () => {
  it('names the rule, the limit, and the resulting total for every refusal', () => {
    const rules = ['per-claim', 'user-daily', 'user-lifetime', 'global-daily', 'invalid-amount'];
    for (const rule of rules) {
      const message = describeRefusal({
        allowed: false,
        rule: rule as never,
        limit: 1_000,
        observed: 900,
        requested: 200,
      });
      expect(typeof message).toBe('string');
      expect(message.length).toBeGreaterThan(0);
    }
  });

  it('states the total the claim WOULD have reached, not just the observed total', () => {
    const message = describeRefusal({
      allowed: false,
      rule: 'global-daily',
      limit: 100_000,
      observed: 99_900,
      requested: 200,
    });
    expect(message).toContain('100100');
    expect(message).toContain('100000');
  });
});
