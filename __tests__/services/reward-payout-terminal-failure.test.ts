/**
 * #890 HIGH-2 — a non-retryable payout failure must reach a TERMINAL state and
 * stop being re-swept.
 *
 * Before this, every non-success outcome mapped back to `pending`, and the
 * reconciler selects `settlement IN ('pending','settling')` every 60s. A
 * `points: 0` claim fails validation BEFORE the network call, so it returned to
 * `pending` and was re-submitted forever with identical arguments — and the user
 * had already been told `success: true`.
 *
 * These are RED-control tests. Removing the terminal transition in
 * `settlementFromPayout` fails them; see the PR comment for the recorded run.
 */
import { jest, describe, it, expect, beforeEach } from '@jest/globals';

jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(),
  extractCore4Data: (p: any) => (p && typeof p === 'object' && 'data' in p ? p.data : p),
  getCore4ErrorMessage: (_p: any, f: string) => f,
}));
jest.mock('../../database/index.js', () => ({ db: {} }));
jest.mock('../../shared/schema.js', () => ({
  contributorRewards: { id: 'id', metadata: 'metadata' },
}));
jest.mock('../../server/utils/logger.js', () => ({
  appLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('drizzle-orm', () => ({
  eq: jest.fn(() => ({})),
  and: jest.fn(() => ({})),
  desc: jest.fn(() => ({})),
  lt: jest.fn(() => ({})),
  sql: Object.assign(
    jest.fn((strings: TemplateStringsArray) => (Array.isArray(strings) ? strings.join('') : '')),
    { as: jest.fn() }
  ),
}));

import { submitPayout } from '../../server/services/reward-payout-client.js';
import {
  settlementFromPayout,
  mergeSettlementMetadata,
  pointsToBaseUnits,
  priorAttempts,
  isTerminalSettlement,
  MAX_SETTLEMENT_ATTEMPTS,
} from '../../server/services/reward-payout-settlement.js';
import { reconcilePendingPayouts } from '../../server/services/reward-payout-reconciler.js';

const ADDRESS = '0x' + 'ab'.repeat(20);
const CLAIM_ID = 'ach:v1:7:first-report';

/** A fetch seam that fails the test if the network is ever touched. */
function forbiddenFetch() {
  return jest.fn(() => {
    throw new Error('network was called for a pre-network validation failure');
  }) as any;
}

async function payoutFor(points: number) {
  return submitPayout(
    { address: ADDRESS, amountBaseUnits: pointsToBaseUnits(points), claimId: CLAIM_ID },
    { fetchJson: forbiddenFetch(), getOperatorToken: () => 'test-token' }
  );
}

describe('#890 HIGH-2 — terminal failed state', () => {
  it('points:0 fails before the network call and settles TERMINAL failed, not pending', async () => {
    const payout = await payoutFor(0);

    expect(payout.kind).toBe('error');
    // The defining property: deterministic, argument-only, pre-network.
    expect((payout as any).validation).toBe(true);

    const settlement = settlementFromPayout(payout);
    expect(settlement.settlement).toBe('failed');
    expect(settlement.terminal).toBe(true);
    // A 202 here is the lie the user saw; the real status must surface.
    expect(settlement.httpStatus).toBe(422);
    expect(settlement.note).toMatch(/non-retryable/);
  });

  it('points above the 200 WRF per-payout cap is equally terminal', async () => {
    const payout = await payoutFor(201);
    expect((payout as any).validation).toBe(true);

    const settlement = settlementFromPayout(payout);
    expect(settlement.settlement).toBe('failed');
    expect(settlement.terminal).toBe(true);
  });

  it('a RETRYABLE failure still stays pending — the fix must not over-terminalize', () => {
    const settlement = settlementFromPayout({
      kind: 'retryable',
      reason: 'over_supply',
      code: 'OVER_SUPPLY',
      message: 'emission budget exhausted this block',
      httpStatus: 503,
    } as any);

    expect(settlement.settlement).toBe('pending');
    expect(settlement.terminal).toBe(false);
  });

  it('a MISSING OPERATOR TOKEN stays retryable — it is config, not a bad claim', async () => {
    const payout = await submitPayout(
      { address: ADDRESS, amountBaseUnits: pointsToBaseUnits(5), claimId: CLAIM_ID },
      { fetchJson: forbiddenFetch(), getOperatorToken: () => undefined }
    );

    expect(payout.kind).toBe('error');
    expect((payout as any).code).toBe('UNAUTHORIZED');
    // Must NOT be marked validation: the same claim succeeds once configured.
    expect((payout as any).validation).toBeUndefined();

    const settlement = settlementFromPayout(payout);
    expect(settlement.settlement).toBe('pending');
    expect(settlement.terminal).toBe(false);
  });

  it('the attempt counter advances and eventually terminates an unclassifiable failure', () => {
    const retryable = {
      kind: 'retryable',
      reason: 'network',
      code: 'NETWORK',
      message: 'connect ECONNREFUSED',
      httpStatus: null,
    } as any;

    const lastPending = settlementFromPayout(retryable, MAX_SETTLEMENT_ATTEMPTS - 2);
    expect(lastPending.settlement).toBe('pending');

    const exhausted = settlementFromPayout(retryable, MAX_SETTLEMENT_ATTEMPTS - 1);
    expect(exhausted.settlement).toBe('failed');
    expect(exhausted.terminal).toBe(true);
    expect(exhausted.note).toMatch(/attempts exhausted/);
  });

  it('the attempt count round-trips through persisted metadata', () => {
    const first = settlementFromPayout({
      kind: 'retryable', reason: 'network', code: 'NETWORK', message: 'x', httpStatus: null,
    } as any);
    const meta = mergeSettlementMetadata({}, first);

    expect(meta.settlementAttempts).toBe(1);
    // Without this the counter restarts each sweep and the bound is unreachable.
    expect(priorAttempts(meta)).toBe(1);
  });
});

describe('#890 HIGH-2 — the reconciler stops re-driving a terminal row', () => {
  let store: Array<Record<string, unknown>>;
  let submitSpy: any;

  /** Fake db that models the production `IN ('pending','settling')` sweep filter. */
  function fakeDb() {
    return {
      select: () => {
        const c: any = {};
        for (const m of ['from', 'where', 'orderBy']) c[m] = () => c;
        const sweepSet = () =>
          store.filter((r) => {
            const s = (r.metadata as any)?.settlement;
            return s === 'pending' || s === 'settling';
          });
        c.limit = () => Promise.resolve(sweepSet());
        c.then = (r: any) => Promise.resolve(sweepSet()).then(r);
        return c;
      },
      update: () => {
        const c: any = {};
        c.set = (v: any) => {
          // Single row in these tests; apply the metadata write to the store.
          store[0] = { ...store[0], metadata: v.metadata };
          return c;
        };
        c.where = () => Promise.resolve([]);
        c.then = (r: any) => Promise.resolve([]).then(r);
        return c;
      },
    };
  }

  beforeEach(() => {
    store = [
      {
        id: 42,
        metadata: {
          onChain: true,
          settlement: 'pending',
          claimId: CLAIM_ID,
          address: ADDRESS,
          // points:0 -> zero base units: rejected before the network call.
          amountBaseUnits: pointsToBaseUnits(0).toString(),
        },
      },
    ];
    submitSpy = jest.fn(async () => ({
      kind: 'error',
      code: 'UNPROCESSABLE_ENTITY',
      message: 'amount must be > 0',
      httpStatus: 422,
      validation: true,
    }));
  });

  it('moves the points:0 row to terminal failed and NEVER re-sweeps it', async () => {
    const db = fakeDb();

    const first = await reconcilePendingPayouts({}, { db: db as any, submitPayout: submitSpy });
    expect(first.scanned).toBe(1);
    expect(first.failed).toBe(1);
    expect(first.stillPending).toBe(0);
    expect((store[0].metadata as any).settlement).toBe('failed');
    expect(isTerminalSettlement((store[0].metadata as any).settlement)).toBe(true);

    // The row is now terminal, so the next sweep must not see it at all.
    const second = await reconcilePendingPayouts({}, { db: db as any, submitPayout: submitSpy });
    expect(second.scanned).toBe(0);

    // The load-bearing assertion: submitted exactly once, ever. Before the fix
    // this row returned to `pending` and was re-submitted on every pass.
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it('resumes the attempt budget across sweeps so a retryable failure also terminates', async () => {
    // The points:0 case above terminates on the validation guard and never
    // touches the counter, so it cannot prove the reconciler resumes it. This
    // one can: an always-retryable failure only terminates if each sweep reads
    // the PERSISTED attempt count. Drop `priorAttempts(meta)` in the reconciler
    // and this row sweeps forever.
    store = [
      {
        id: 43,
        metadata: {
          onChain: true,
          settlement: 'pending',
          claimId: CLAIM_ID,
          address: ADDRESS,
          amountBaseUnits: pointsToBaseUnits(5).toString(),
        },
      },
    ];
    const alwaysRetryable = jest.fn(async () => ({
      kind: 'retryable',
      reason: 'network',
      code: 'NETWORK',
      message: 'connect ECONNREFUSED',
      httpStatus: null,
    }));
    const db = fakeDb();

    for (let i = 0; i < MAX_SETTLEMENT_ATTEMPTS; i++) {
      await reconcilePendingPayouts({}, { db: db as any, submitPayout: alwaysRetryable as any });
    }

    expect((store[0].metadata as any).settlement).toBe('failed');
    expect((store[0].metadata as any).settlementAttempts).toBe(MAX_SETTLEMENT_ATTEMPTS);
    // Bounded: it stopped at the budget instead of re-submitting indefinitely.
    expect(alwaysRetryable).toHaveBeenCalledTimes(MAX_SETTLEMENT_ATTEMPTS);

    // And once terminal it leaves the sweep set for good.
    const after = await reconcilePendingPayouts({}, { db: db as any, submitPayout: alwaysRetryable as any });
    expect(after.scanned).toBe(0);
    expect(alwaysRetryable).toHaveBeenCalledTimes(MAX_SETTLEMENT_ATTEMPTS);
  });
});
