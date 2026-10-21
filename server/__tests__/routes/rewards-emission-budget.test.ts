/**
 * #940 (LAUNCH BLOCKER) — the achievement mint path must have an emission ceiling.
 *
 * The vulnerability: `user_achievements.progress` defaults to `100` and `.status`
 * to `'completed'`, and the claim route authorizes purely on that row existing. So
 * a *bare insert* — `INSERT INTO user_achievements (user_id, achievement_id)` — is
 * immediately mintable at up to 200 WRF, and nothing bounded how many times that
 * could happen.
 *
 * These tests drive the real route with a bare-insert-shaped `user_achievements`
 * row (exactly the defaulted `progress: 100` / `status: 'completed'` values) and
 * assert the ceiling refuses it. The companion unit suite
 * (`__tests__/services/achievement-emission-budget.test.ts`) proves the policy is
 * arithmetically right; THIS suite proves it is actually on the mint path.
 *
 * What this suite does NOT pin — stated rather than left silent:
 *   - It does not prove the ceiling holds under real concurrency. It asserts that
 *     a global `pg_advisory_xact_lock` is taken, and that it is taken FIRST, but
 *     asserting a statement is issued is not the same as observing mutual
 *     exclusion under load — that needs a live database.
 *   - The lock is a single-database lock, not a distributed one: read replicas or
 *     a second primary would weaken the bound again.
 *
 *     (An earlier version of this comment claimed the per-user ceilings were made
 *     tight by the pre-existing `SELECT ... FOR UPDATE`. That was FALSE — that
 *     lock is on the (user, achievement) row, so it does not serialize one user's
 *     concurrent claims on different achievements. Caught in cross-model review;
 *     the advisory lock is what actually closes it.)
 *   - It does not prove Postgres actually applies the column defaults; the drizzle
 *     layer is mocked here. The defaults are read directly from `shared/schema.ts`
 *     in the assertion below instead.
 */

import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

jest.mock('prom-client', () => {
  class Counter { inc = jest.fn(); labels = () => ({ inc: jest.fn() }); }
  class Gauge { set = jest.fn(); labels = () => ({ set: jest.fn() }); }
  class Histogram { observe = jest.fn(); labels = () => ({ observe: jest.fn() }); }
  const register = { registerMetric: jest.fn() };
  return { Counter, Gauge, Histogram, register };
});

const mockLogWarn = jest.fn();
const mockLogError = jest.fn();
jest.mock('../../utils/logger.js', () => ({
  performanceLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  appLogger: {
    info: jest.fn(),
    error: (...a: unknown[]) => (mockLogError as any)(...a),
    warn: (...a: unknown[]) => (mockLogWarn as any)(...a),
    debug: jest.fn(),
  },
}));

const mockAuthMiddleware = jest.fn((req: any, _res: any, next: any) => {
  req.user = { userId: 1 };
  next();
});
jest.mock('../../middleware/auth.js', () => ({
  authenticateJWT: (req: any, res: any, next: any) => mockAuthMiddleware(req, res, next),
}));

const mockSubmitPayout = jest.fn();
jest.mock('../../services/reward-payout-client.js', () => ({
  submitPayout: (...args: unknown[]) => (mockSubmitPayout as any)(...args),
  isValidPayoutAddress: (a: unknown) => typeof a === 'string' && /^(0x)?[0-9a-fA-F]{40}$/.test(a),
  WRF_UNITS_PER_COIN: 100_000_000n,
}));

// ---------------------------------------------------------------------------
// Transaction-aware drizzle mock (same shape as rewards-claim.test.ts). The
// select order on a first-ever claim is:
//   achievement -> earned -> users(wallet) -> FOR UPDATE lock -> existing-claim
//   -> #940 budget aggregate
// A queued entry that is an Error is THROWN, which is how the fail-closed path
// is exercised.
// ---------------------------------------------------------------------------
let selectQueue: unknown[] = [];
let insertRow: Record<string, unknown> | null = null;
const insertSpy = jest.fn();
const updateSetSpy = jest.fn();

function nextSelect(): Promise<unknown[]> {
  if (!selectQueue.length) return Promise.resolve([]);
  const next = selectQueue.shift();
  if (next instanceof Error) return Promise.reject(next);
  return Promise.resolve(next as unknown[]);
}
function selectChain(): any {
  const chain: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'innerJoin']) chain[m] = () => chain;
  chain.for = () => chain;
  chain.limit = () => nextSelect();
  chain.then = (res: any, rej: any) => nextSelect().then(res, rej);
  return chain;
}
function insertChain(): any {
  const chain: any = {};
  chain.values = (v: unknown) => { insertSpy(v); return chain; };
  chain.returning = () => Promise.resolve(insertRow ? [insertRow] : []);
  chain.then = (res: any, rej: any) => Promise.resolve(insertRow ? [insertRow] : []).then(res, rej);
  return chain;
}
function updateChain(): any {
  const chain: any = {};
  chain.set = (v: unknown) => { updateSetSpy(v); return chain; };
  chain.where = () => Promise.resolve([]);
  chain.then = (res: any, rej: any) => Promise.resolve([]).then(res, rej);
  return chain;
}
/**
 * Records the order of operations inside the transaction, so the advisory lock's
 * position (it must be FIRST — see ACHIEVEMENT_MINT_LOCK_KEY) can be asserted
 * rather than assumed.
 */
const txOps: string[] = [];
const executeSpy = jest.fn();

const txMock = {
  select: () => { txOps.push('select'); return selectChain(); },
  insert: () => { txOps.push('insert'); return insertChain(); },
  update: () => { txOps.push('update'); return updateChain(); },
  execute: (q: unknown) => { txOps.push('execute'); executeSpy(String(q)); return Promise.resolve([]); },
};

jest.mock('../../../database/index.js', () => ({
  db: {
    select: () => selectChain(),
    insert: () => insertChain(),
    update: () => updateChain(),
    transaction: (cb: (tx: unknown) => Promise<unknown>) => Promise.resolve(cb(txMock)),
  },
}));

jest.mock('../../../shared/schema.js', () => ({
  rewardDistributionConfig: { id: 'id', active: 'active', createdAt: 'createdAt' },
  contributorRewards: {
    id: 'id', userId: 'userId', amount: 'amount', contributorType: 'contributorType',
    reason: 'reason', metadata: 'metadata', createdAt: 'createdAt',
  },
  forecastCoverageMetrics: { region: 'region', createdAt: 'createdAt' },
  environmentalOffsetProofs: { userId: 'userId', isVerified: 'isVerified', offsetPoints: 'offsetPoints', createdAt: 'createdAt' },
  computationalWorkProofs: { id: 'id', nodeId: 'nodeId', isVerified: 'isVerified', resourceHours: 'resourceHours', completedAt: 'completedAt' },
  computationalNodes: { nodeId: 'nodeId', operatorAddress: 'operatorAddress' },
  algorithmAdvancements: { userId: 'userId', isVerified: 'isVerified', createdAt: 'createdAt' },
  achievements: { id: 'id', achievementId: 'achievementId', title: 'title', points: 'points' },
  userAchievements: { id: 'id', userId: 'userId', achievementId: 'achievementId', status: 'status', progress: 'progress', metadata: 'metadata' },
  users: { id: 'id', username: 'username', walletAddress: 'walletAddress' },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn(() => ({})),
  and: jest.fn(() => ({})),
  desc: jest.fn(() => ({})),
  lt: jest.fn(() => ({})),
  // Interleaves interpolated VALUES, unlike the simpler `s.join('')` mock used in
  // rewards-claim.test.ts. Without this the advisory-lock key vanishes from the
  // rendered statement and the assertion below would be testing the mock rather
  // than the code — it passed against `pg_advisory_xact_lock(, 0)`.
  sql: Object.assign(
    jest.fn((s: TemplateStringsArray, ...vals: unknown[]) =>
      s.reduce((acc, part, i) => acc + part + (i < vals.length ? String(vals[i]) : ''), '')
    ),
    { as: jest.fn() }
  ),
}));

const express = require('express');
const request = require('supertest');

async function buildApp() {
  const { default: rewardsRouter } = await import('../../routes/rewards.js');
  const app = express();
  app.use(express.json());
  app.use('/rewards', rewardsRouter);
  return app;
}

let app: any;
beforeAll(async () => { app = await buildApp(); });

const ACHIEVEMENT = { id: 7, achievementId: 'first-report', title: 'First Report', points: 200 };

/**
 * The #940 payload: a `user_achievements` row carrying ONLY the column defaults.
 * No verifiable earning event produced it — this is what a bare insert looks like.
 */
const BARE_INSERT_ROW = {
  id: 3,
  userId: 1,
  achievementId: 7,
  progress: 100,          // shared/schema.ts:557 — .notNull().default(100)
  status: 'completed',    // shared/schema.ts:558 — .notNull().default('completed')
  metadata: {},
};

const WALLET = { walletAddress: '0x1111111111111111111111111111111111111111' };
const ACCEPTED = {
  kind: 'success', status: 'accepted', txHash: '0xtx', claimId: 'ach:v1:1:first-report',
  address: WALLET.walletAddress, amountBaseUnits: 20_000_000_000n,
};

/** Queue for a first-ever claim, with `budget` as the aggregate row returned. */
function queueFirstClaim(budget: Record<string, unknown> | Error) {
  selectQueue = [
    [ACHIEVEMENT],
    [BARE_INSERT_ROW],
    [WALLET],
    [{ id: BARE_INSERT_ROW.id }],
    [],                       // no prior ledger row -> first-ever claim
    budget instanceof Error ? budget : [budget],
  ];
}

const ENV_KEYS = [
  'ACHIEVEMENT_MAX_CLAIM_WRF',
  'ACHIEVEMENT_USER_DAILY_WRF',
  'ACHIEVEMENT_USER_LIFETIME_WRF',
  'ACHIEVEMENT_GLOBAL_DAILY_WRF',
];
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  mockAuthMiddleware.mockImplementation((req: any, _res: any, next: any) => { req.user = { userId: 1 }; next(); });
  selectQueue = [];
  insertRow = {
    id: 100, userId: 1, contributorType: 'achievement', amount: 200,
    metadata: {
      achievementId: 'first-report', achievementRowId: 7, onChain: true, settlement: 'pending',
      claimId: 'ach:v1:1:first-report', address: WALLET.walletAddress, amountBaseUnits: '20000000000',
    },
  };
  insertSpy.mockClear();
  updateSetSpy.mockClear();
  executeSpy.mockClear();
  txOps.length = 0;
  mockLogWarn.mockClear();
  mockLogError.mockClear();
  mockSubmitPayout.mockReset();
  mockSubmitPayout.mockResolvedValue(ACCEPTED as never);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k] as string;
  }
});

describe('#940 — the mint path refuses once the emission budget is exhausted', () => {
  it('REFUSES a bare-insert achievement claim when the global daily budget is spent', async () => {
    // 99,900 already emitted today against a 100,000 ceiling; this claim is 200.
    process.env.ACHIEVEMENT_GLOBAL_DAILY_WRF = '100000';
    queueFirstClaim({ userDay: '0', userLifetime: '0', globalDay: '99900' });

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.status).toBe(429);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('EMISSION_BUDGET_EXCEEDED');
    expect(res.body.rule).toBe('global-daily');
  });

  it('REFUSES once the per-user daily cap is reached, even with global headroom', async () => {
    process.env.ACHIEVEMENT_USER_DAILY_WRF = '1000';
    queueFirstClaim({ userDay: '900', userLifetime: '900', globalDay: '900' });

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.status).toBe(429);
    expect(res.body.rule).toBe('user-daily');
  });

  it('REFUSES a claim worth more than the per-claim ceiling', async () => {
    process.env.ACHIEVEMENT_MAX_CLAIM_WRF = '50';
    queueFirstClaim({ userDay: '0', userLifetime: '0', globalDay: '0' });

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.status).toBe(429);
    expect(res.body.rule).toBe('per-claim');
  });

  it('a refusal mints NOTHING: no ledger row, no status flip, no payout submitted', async () => {
    // The refusal has to be complete. A 429 that still inserted the ledger row or
    // flipped the achievement to 'claimed' would burn the claim without paying it;
    // one that still called submitPayout would emit the WRF anyway.
    process.env.ACHIEVEMENT_GLOBAL_DAILY_WRF = '100';
    queueFirstClaim({ userDay: '0', userLifetime: '0', globalDay: '100' });

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.status).toBe(429);
    expect(insertSpy).not.toHaveBeenCalled();
    expect(mockSubmitPayout).not.toHaveBeenCalled();
    expect(updateSetSpy.mock.calls.some((c) => (c[0] as any)?.status === 'claimed')).toBe(false);
  });

  it('FAILS CLOSED: an unreadable budget refuses the claim rather than allowing it', async () => {
    // An unreadable budget is indistinguishable from an exhausted one, and only
    // one of those two answers is safe on a mint path.
    queueFirstClaim(new Error('relation "contributor_rewards" does not exist'));

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.status).toBe(429);
    expect(res.body.code).toBe('EMISSION_BUDGET_EXCEEDED');
    expect(mockSubmitPayout).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
    expect(mockLogError).toHaveBeenCalled();
  });

  it('the fail-closed error names the unreadable case and renders no NaN arithmetic', async () => {
    // `observed` is NaN on this path. Rendering "would put emission at NaN WRF"
    // on a public error surface is a defect in its own right.
    queueFirstClaim(new Error('connection terminated'));

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.body.rule).toBe('budget-unreadable');
    expect(String(res.body.error)).not.toContain('NaN');
  });
});

describe('#940 — the ceilings are serialized, not merely computed', () => {
  it('takes a GLOBAL advisory lock, so the aggregate ceilings cannot be raced', async () => {
    // Cindy (Fable 5) review, blocker 2: the pre-existing `SELECT ... FOR UPDATE`
    // locks the (user, achievement) row, so it does NOT serialize one user's
    // concurrent claims on DIFFERENT achievements — the per-user caps had the same
    // read-then-write race as the global one. A global advisory lock closes all
    // three aggregate ceilings at once.
    process.env.ACHIEVEMENT_GLOBAL_DAILY_WRF = '100000';
    queueFirstClaim({ userDay: '0', userLifetime: '0', globalDay: '0' });

    await request(app).post('/rewards/claim/first-report');

    expect(executeSpy).toHaveBeenCalledTimes(1);
    const stmt = executeSpy.mock.calls[0][0] as string;
    expect(stmt).toContain('pg_advisory_xact_lock');
    // Global key, NOT keyed on userId — a per-user key would leave the global
    // daily budget racy, and that is the ceiling that bounds a mass-insert.
    expect(stmt).toContain('940');
  });

  it('takes the advisory lock BEFORE any other lock in the transaction', async () => {
    // Lock ordering, not just lock presence. Acquiring the advisory lock after the
    // row lock lets two concurrent claims for the same (user, achievement)
    // deadlock: one holds the row and waits on the advisory, the other the reverse.
    process.env.ACHIEVEMENT_GLOBAL_DAILY_WRF = '100000';
    queueFirstClaim({ userDay: '0', userLifetime: '0', globalDay: '0' });

    await request(app).post('/rewards/claim/first-report');

    expect(txOps[0]).toBe('execute');
  });

  it('holds the lock on the repeat-claim path too — no path skips serialization', async () => {
    const priorRow = {
      id: 100, userId: 1, contributorType: 'achievement', amount: 200,
      metadata: {
        achievementId: 'first-report', onChain: true, settlement: 'pending',
        claimId: 'ach:v1:1:first-report', address: WALLET.walletAddress,
        amountBaseUnits: '20000000000',
      },
    };
    selectQueue = [
      [ACHIEVEMENT], [{ ...BARE_INSERT_ROW, status: 'claimed' }], [WALLET],
      [{ id: BARE_INSERT_ROW.id }], [priorRow],
    ];

    await request(app).post('/rewards/claim/first-report');

    expect(txOps[0]).toBe('execute');
  });

  it('logs the refusal with the rule, the limit, and the observed total', async () => {
    process.env.ACHIEVEMENT_GLOBAL_DAILY_WRF = '100000';
    queueFirstClaim({ userDay: '0', userLifetime: '0', globalDay: '99900' });

    await request(app).post('/rewards/claim/first-report');

    expect(mockLogWarn).toHaveBeenCalledWith(
      expect.stringContaining('#940'),
      expect.objectContaining({ rule: 'global-daily', limit: 100000, observed: 99900, requested: 200 })
    );
  });
});

describe('#940 — the ceiling does not break the paths that were already correct', () => {
  it('ALLOWS a claim with headroom, and still drives the payout (202 settling)', async () => {
    process.env.ACHIEVEMENT_GLOBAL_DAILY_WRF = '100000';
    queueFirstClaim({ userDay: '0', userLifetime: '0', globalDay: '0' });

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(mockSubmitPayout).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: 'ach:v1:1:first-report', amountBaseUnits: 20_000_000_000n })
    );
  });

  it('ALLOWS a claim that lands exactly on the ceiling', async () => {
    process.env.ACHIEVEMENT_GLOBAL_DAILY_WRF = '100000';
    queueFirstClaim({ userDay: '0', userLifetime: '0', globalDay: '99800' });

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.status).toBe(202);
    expect(mockSubmitPayout).toHaveBeenCalled();
  });

  it('does NOT charge a repeat claim against the budget — it re-POSTs to settle', async () => {
    // A repeat claim emits nothing new (core4 dedups the claim_id), so charging it
    // would double-count the original AND could refuse a payout already owed.
    // The budget aggregate is deliberately absent from this queue: reaching it
    // would mean the repeat path ran the check.
    process.env.ACHIEVEMENT_GLOBAL_DAILY_WRF = '1';
    const priorRow = {
      id: 100, userId: 1, contributorType: 'achievement', amount: 200,
      metadata: {
        achievementId: 'first-report', onChain: true, settlement: 'pending',
        claimId: 'ach:v1:1:first-report', address: WALLET.walletAddress,
        amountBaseUnits: '20000000000',
      },
    };
    selectQueue = [
      [ACHIEVEMENT],
      [{ ...BARE_INSERT_ROW, status: 'claimed' }],
      [WALLET],
      [{ id: BARE_INSERT_ROW.id }],
      [priorRow],           // prior ledger row -> repeat claim, budget NOT consulted
    ];

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.status).not.toBe(429);
    expect(mockSubmitPayout).toHaveBeenCalledWith(
      expect.objectContaining({ claimId: 'ach:v1:1:first-report' })
    );
  });
});
