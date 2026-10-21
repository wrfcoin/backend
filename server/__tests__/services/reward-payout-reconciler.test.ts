/**
 * #215 — reward-payout reconciler: advances pending rows to settled via safe
 * claim_id re-POST; leaves retryable (over-supply) rows pending; skips rows that
 * lack re-POST inputs.
 */
import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ESM leaf that ts-jest can't parse — mock it so the client/settlement modules load.
jest.mock('../../../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(),
  extractCore4Data: (p: any) => (p && typeof p === 'object' && 'data' in p ? p.data : p),
  getCore4ErrorMessage: (_p: any, f: string) => f,
}));
jest.mock('../../../database/index.js', () => ({ db: {} }));
jest.mock('../../../shared/schema.js', () => ({
  contributorRewards: { id: 'id', metadata: 'metadata' },
}));
jest.mock('../../utils/logger.js', () => ({
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

import { reconcilePendingPayouts, startPayoutReconciler, stopPayoutReconciler } from '../../services/reward-payout-reconciler.js';
import { db } from '../../../database/index.js';

let scanRows: Array<Record<string, unknown>> = [];
const updateSetSpy = jest.fn();

function fakeDb() {
  return {
    select: () => {
      const c: any = {};
      for (const m of ['from', 'where', 'orderBy']) c[m] = () => c;
      c.limit = () => Promise.resolve(scanRows);
      c.then = (r: any) => Promise.resolve(scanRows).then(r);
      return c;
    },
    update: () => {
      const c: any = {};
      c.set = (v: unknown) => { updateSetSpy(v); return c; };
      c.where = () => Promise.resolve([]);
      c.then = (r: any) => Promise.resolve([]).then(r);
      return c;
    },
  };
}

const PENDING_ROW = {
  id: 42,
  metadata: {
    achievementId: 'first-report',
    onChain: true,
    settlement: 'settling',
    claimId: 'ach:v1:1:first-report',
    address: '0x1111111111111111111111111111111111111111',
    amountBaseUnits: '5000000000',
  },
};

beforeEach(() => {
  scanRows = [];
  updateSetSpy.mockClear();
});

describe('payout reconciler feature gate and timer lifecycle', () => {
  const originalEnabled = process.env.REWARD_PAYOUT_RECONCILE_ENABLED;
  const originalInterval = process.env.REWARD_PAYOUT_RECONCILE_INTERVAL_MS;
  let selectSpy: ReturnType<typeof jest.fn>;

  beforeEach(() => {
    jest.useFakeTimers();
    stopPayoutReconciler();
    delete process.env.REWARD_PAYOUT_RECONCILE_ENABLED;
    delete process.env.REWARD_PAYOUT_RECONCILE_INTERVAL_MS;
    selectSpy = jest.fn(fakeDb().select);
    Object.assign(db, { select: selectSpy });
  });

  afterEach(() => {
    stopPayoutReconciler();
    jest.useRealTimers();
    if (originalEnabled === undefined) delete process.env.REWARD_PAYOUT_RECONCILE_ENABLED;
    else process.env.REWARD_PAYOUT_RECONCILE_ENABLED = originalEnabled;
    if (originalInterval === undefined) delete process.env.REWARD_PAYOUT_RECONCILE_INTERVAL_MS;
    else process.env.REWARD_PAYOUT_RECONCILE_INTERVAL_MS = originalInterval;
  });

  it.each([undefined, 'false', 'TRUE'])('does not schedule a sweep for %s', enabled => {
    if (enabled !== undefined) process.env.REWARD_PAYOUT_RECONCILE_ENABLED = enabled;
    expect(startPayoutReconciler()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it('ON runs the default 60-second sweep once and repeated start does not duplicate it', async () => {
    process.env.REWARD_PAYOUT_RECONCILE_ENABLED = 'true';
    expect(startPayoutReconciler()).toBe(true);
    expect(startPayoutReconciler()).toBe(true);
    expect(jest.getTimerCount()).toBe(1);
    await jest.advanceTimersByTimeAsync(59_999);
    expect(selectSpy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(selectSpy).toHaveBeenCalledTimes(1);
    stopPayoutReconciler();
    expect(jest.getTimerCount()).toBe(0);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(selectSpy).toHaveBeenCalledTimes(1);
  });

  it('ON honors a custom interval and can restart after stop', async () => {
    process.env.REWARD_PAYOUT_RECONCILE_ENABLED = 'true';
    process.env.REWARD_PAYOUT_RECONCILE_INTERVAL_MS = '1000';
    expect(startPayoutReconciler()).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(selectSpy).toHaveBeenCalledTimes(1);
    stopPayoutReconciler();
    expect(startPayoutReconciler()).toBe(true);
    await jest.advanceTimersByTimeAsync(1000);
    expect(selectSpy).toHaveBeenCalledTimes(2);
  });
});

describe('reconcilePendingPayouts (#215)', () => {
  it('flips a pending row to settled on already_processed', async () => {
    scanRows = [PENDING_ROW];
    const submitPayout = jest.fn(async () => ({
      kind: 'success', status: 'already_processed', txHash: null,
      claimId: 'ach:v1:1:first-report', address: PENDING_ROW.metadata.address, amountBaseUnits: 5_000_000_000n,
    })) as any;

    const summary = await reconcilePendingPayouts({}, { db: fakeDb() as any, submitPayout });

    expect(summary).toMatchObject({ scanned: 1, settled: 1, stillPending: 0, skipped: 0 });
    // Re-POSTed with the persisted claim_id + amount.
    expect(submitPayout).toHaveBeenCalledWith(expect.objectContaining({
      claimId: 'ach:v1:1:first-report',
      amountBaseUnits: 5_000_000_000n,
    }));
    // Ledger flipped to settled.
    expect((updateSetSpy.mock.calls[0][0] as any).metadata.settlement).toBe('settled');
  });

  it('leaves a row pending on over_supply (retryable, claim not lost)', async () => {
    scanRows = [PENDING_ROW];
    const submitPayout = jest.fn(async () => ({
      kind: 'retryable', reason: 'over_supply', code: 'OVER_SUPPLY', message: 'x', httpStatus: 422,
    })) as any;

    const summary = await reconcilePendingPayouts({}, { db: fakeDb() as any, submitPayout });

    expect(summary).toMatchObject({ scanned: 1, settled: 0, stillPending: 1, skipped: 0 });
    expect((updateSetSpy.mock.calls[0][0] as any).metadata.settlement).toBe('pending');
  });

  it('skips a row missing claimId/address/amount and does not re-POST it', async () => {
    scanRows = [{ id: 9, metadata: { onChain: true, settlement: 'pending', achievementId: 'x' } }];
    const submitPayout = jest.fn() as any;

    const summary = await reconcilePendingPayouts({}, { db: fakeDb() as any, submitPayout });

    expect(summary).toMatchObject({ scanned: 1, settled: 0, stillPending: 0, skipped: 1 });
    expect(submitPayout).not.toHaveBeenCalled();
    expect(updateSetSpy).not.toHaveBeenCalled();
  });

  it('returns a zero summary when nothing is pending', async () => {
    scanRows = [];
    const submitPayout = jest.fn() as any;
    const summary = await reconcilePendingPayouts({}, { db: fakeDb() as any, submitPayout });
    // `failed` counts rows moved to the terminal state this pass (#890 HIGH-2).
    expect(summary).toEqual({ scanned: 0, settled: 0, stillPending: 0, skipped: 0, failed: 0 });
  });
});

// Signed-mode retries must not bypass the ingress authorization boundary.
import { generateKeyPairSync, sign } from "node:crypto";
import { payoutPreimage } from "../../services/achievement-payout-authorization.js";
describe("signed payout reconciler boundary", () => {
  const keys = generateKeyPairSync("ed25519");
  const tuple = {
    achievementId: "first-report",
    claimId: "ach:v1:1:first-report",
    address: PENDING_ROW.metadata.address,
    amountBaseUnits: 1_000_000_000n,
  };
  const proof = { chainId: "777", nonce: "03".repeat(32), signature: "" };
  proof.signature = sign(
    null,
    payoutPreimage(tuple, proof),
    keys.privateKey,
  ).toString("hex");
  const names = [
    "ACHIEVEMENT_PAYOUT_SIGNED_ENABLED",
    "ACHIEVEMENT_PAYOUT_CHAIN_ID",
    "ACHIEVEMENT_PAYOUT_PUBLIC_KEY",
  ];
  const saved = Object.fromEntries(names.map((key) => [key, process.env[key]]));
  beforeEach(() => {
    process.env.ACHIEVEMENT_PAYOUT_SIGNED_ENABLED = "true";
    process.env.ACHIEVEMENT_PAYOUT_CHAIN_ID = "777";
    process.env.ACHIEVEMENT_PAYOUT_PUBLIC_KEY = keys.publicKey
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("hex");
  });
  afterEach(() => {
    for (const key of names) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });
  it("preserves and skips unsigned historical liabilities without submitting or updating", async () => {
    scanRows = [PENDING_ROW];
    const submit = jest.fn();
    expect(
      await reconcilePendingPayouts(
        {},
        { db: fakeDb(), submitPayout: submit as any },
      ),
    ).toMatchObject({ skipped: 1 });
    expect(submit).not.toHaveBeenCalled();
    expect(updateSetSpy).not.toHaveBeenCalled();
  });
  it("valid persisted proof can re-drive only the original tuple", async () => {
    scanRows = [
      {
        id: 42,
        metadata: {
          ...PENDING_ROW.metadata,
          amountBaseUnits: tuple.amountBaseUnits.toString(),
          payoutAuthorization: proof,
        },
      },
    ];
    const submit = jest.fn(async (_args: unknown) => ({
      kind: "success",
      status: "pending",
      txHash: "test",
    }));
    expect(
      await reconcilePendingPayouts(
        {},
        { db: fakeDb(), submitPayout: submit as any },
      ),
    ).toMatchObject({ stillPending: 1 });
    expect(submit).toHaveBeenCalledWith({ ...tuple, authorization: proof });
  });
  it("recipient drift in a signed ledger row refuses before submit", async () => {
    scanRows = [
      {
        id: 42,
        metadata: {
          ...PENDING_ROW.metadata,
          address: "0x" + "cd".repeat(20),
          amountBaseUnits: tuple.amountBaseUnits.toString(),
          payoutAuthorization: proof,
        },
      },
    ];
    const submit = jest.fn();
    expect(
      await reconcilePendingPayouts(
        {},
        { db: fakeDb(), submitPayout: submit as any },
      ),
    ).toMatchObject({ skipped: 1 });
    expect(submit).not.toHaveBeenCalled();
    expect(updateSetSpy).not.toHaveBeenCalled();
  });
});
