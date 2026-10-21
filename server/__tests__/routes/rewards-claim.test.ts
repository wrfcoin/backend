/**
 * #215 — earn→claim loop coverage for rewards.ts.
 *
 * Covers the claim + history handlers, now with the on-chain payout rewire
 * (core4 PR #2081): a claim drives POST /rewards/payout and the ledger row
 * carries a pending → settling → settled lifecycle. Async settlement means a
 * repeat claim is idempotent (re-POST the same claim_id), not a hard 409.
 *
 * Kept separate from the #473 smoke suite so its transaction- + payout-aware
 * mocks don't perturb those tests.
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
} from '@jest/globals';

jest.mock('prom-client', () => {
  class Counter { inc = jest.fn(); labels = () => ({ inc: jest.fn() }); }
  class Gauge { set = jest.fn(); labels = () => ({ set: jest.fn() }); }
  class Histogram { observe = jest.fn(); labels = () => ({ observe: jest.fn() }); }
  const register = { registerMetric: jest.fn() };
  return { Counter, Gauge, Histogram, register };
});

jest.mock('../../utils/logger.js', () => ({
  performanceLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
  appLogger: { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

const mockAuthMiddleware = jest.fn((req: any, _res: any, next: any) => {
  req.user = { userId: 1 };
  next();
});
jest.mock('../../middleware/auth.js', () => ({
  authenticateJWT: (req: any, res: any, next: any) => mockAuthMiddleware(req, res, next),
}));

// Mock the payout CLIENT (the settlement helper runs for real). This also keeps
// the ESM shared/core4-route-client.js off the CJS load path.
const mockSubmitPayout = jest.fn();
jest.mock('../../services/reward-payout-client.js', () => ({
  submitPayout: (...args: unknown[]) => (mockSubmitPayout as any)(...args),
  isValidPayoutAddress: (a: unknown) => typeof a === 'string' && /^(0x)?[0-9a-fA-F]{40}$/.test(a),
  WRF_UNITS_PER_COIN: 100_000_000n,
}));

// ---------------------------------------------------------------------------
// Transaction-aware drizzle mock. selectQueue is consumed FIFO; claim order is
// achievement → earned → users(wallet) → FOR UPDATE lock → existing-claim.
// ---------------------------------------------------------------------------
let selectQueue: unknown[][] = [];
let insertRow: Record<string, unknown> | null = null;
const insertSpy = jest.fn();
const updateSetSpy = jest.fn();
const forUpdateSpy = jest.fn();

function nextSelect(): Promise<unknown[]> {
  return Promise.resolve(selectQueue.length ? (selectQueue.shift() as unknown[]) : []);
}
function selectChain(): any {
  const chain: any = {};
  for (const m of ['select', 'from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'innerJoin']) chain[m] = () => chain;
  chain.for = (mode: string) => { forUpdateSpy(mode); return chain; };
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
// `execute` added for the #940 advisory lock (`pg_advisory_xact_lock`), which the
// claim transaction now takes before any other lock. Mocked as a no-op resolve —
// the lock's presence and ordering are asserted in rewards-emission-budget.test.ts,
// not here.
const txMock = {
  select: () => selectChain(),
  insert: () => insertChain(),
  update: () => updateChain(),
  execute: () => Promise.resolve([]),
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
  sql: Object.assign(jest.fn((s: TemplateStringsArray) => s.join('')), { as: jest.fn() }),
}));

const express = require('express');
const request = require('supertest');
const drizzle = require('drizzle-orm');

async function buildApp() {
  const { default: rewardsRouter } = await import('../../routes/rewards.js');
  const app = express();
  app.use(express.json());
  app.use('/rewards', rewardsRouter);
  return app;
}

let app: any;
beforeAll(async () => { app = await buildApp(); });

const ACHIEVEMENT = { id: 7, achievementId: 'first-report', title: 'First Report', points: 50 };
const EARNED = { id: 3, userId: 1, achievementId: 7, status: 'completed', progress: 100, metadata: {} };
const WALLET = { walletAddress: '0x1111111111111111111111111111111111111111' };
const ACCEPTED = {
  kind: 'success', status: 'accepted', txHash: '0xtx', claimId: 'ach:v1:1:first-report',
  address: WALLET.walletAddress, amountBaseUnits: 5_000_000_000n,
};

beforeEach(() => {
  mockAuthMiddleware.mockImplementation((req: any, _res: any, next: any) => { req.user = { userId: 1 }; next(); });
  selectQueue = [];
  insertRow = null;
  insertSpy.mockClear();
  updateSetSpy.mockClear();
  forUpdateSpy.mockClear();
  mockSubmitPayout.mockReset();
  mockSubmitPayout.mockResolvedValue(ACCEPTED as never);
  (drizzle.lt as jest.Mock).mockClear();
});

describe('POST /rewards/claim/:achievementId (#215 on-chain)', () => {
  it('happy path: records the ledger claim, drives the payout, returns 202 settling', async () => {
    insertRow = {
      id: 100, userId: 1, contributorType: 'achievement', amount: 50,
      metadata: {
        achievementId: 'first-report', achievementRowId: 7, onChain: true, settlement: 'pending',
        claimId: 'ach:v1:1:first-report', address: WALLET.walletAddress, amountBaseUnits: '5000000000',
      },
    };
    selectQueue = [[ACHIEVEMENT], [EARNED], [WALLET], [{ id: EARNED.id }], []];

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.status).toBe(202);
    expect(res.body.success).toBe(true);
    expect(res.body.settlement).toMatchObject({ state: 'settling', status: 'accepted', txHash: '0xtx', onChain: true });

    // Ledger insert carries the on-chain marker + claim_id + amount + address.
    expect(insertSpy).toHaveBeenCalledTimes(1);
    const inserted = insertSpy.mock.calls[0][0] as any;
    expect(inserted.metadata).toMatchObject({
      onChain: true, settlement: 'pending', claimId: 'ach:v1:1:first-report',
      address: WALLET.walletAddress, amountBaseUnits: '5000000000',
    });
    // Payout submitted with points→base-units (50 WRF) and the deterministic claim_id.
    expect(mockSubmitPayout).toHaveBeenCalledWith(expect.objectContaining({
      address: WALLET.walletAddress, amountBaseUnits: 5_000_000_000n, claimId: 'ach:v1:1:first-report',
    }));
    // Row lock + achievement flip + settlement write all happened.
    expect(forUpdateSpy).toHaveBeenCalledWith('update');
    expect(updateSetSpy.mock.calls.some((c) => (c[0] as any).status === 'claimed')).toBe(true);
    expect(updateSetSpy.mock.calls.some((c) => (c[0] as any).metadata?.settlement === 'settling')).toBe(true);
  });

  it('already_processed → 200 settled', async () => {
    insertRow = { id: 100, metadata: {} };
    mockSubmitPayout.mockResolvedValue({ kind: 'success', status: 'already_processed', txHash: null } as never);
    selectQueue = [[ACHIEVEMENT], [EARNED], [WALLET], [{ id: EARNED.id }], []];

    const res = await request(app).post('/rewards/claim/first-report');
    expect(res.status).toBe(200);
    expect(res.body.settlement.state).toBe('settled');
  });

  it('over_supply → 202 pending, claim retained (never lost)', async () => {
    insertRow = { id: 100, metadata: {} };
    mockSubmitPayout.mockResolvedValue({ kind: 'retryable', reason: 'over_supply', code: 'OVER_SUPPLY', message: 'x', httpStatus: 422 } as never);
    selectQueue = [[ACHIEVEMENT], [EARNED], [WALLET], [{ id: EARNED.id }], []];

    const res = await request(app).post('/rewards/claim/first-report');
    expect(res.status).toBe(202);
    expect(res.body.settlement.state).toBe('pending');
    expect(insertSpy).toHaveBeenCalledTimes(1); // ledger row still recorded
  });

  it('double-claim: idempotent re-POST (no new ledger row), advances settlement', async () => {
    const existing = { id: 100, userId: 1, contributorType: 'achievement', metadata: { achievementId: 'first-report', settlement: 'settling', claimId: 'ach:v1:1:first-report' } };
    selectQueue = [[ACHIEVEMENT], [EARNED], [WALLET], [{ id: EARNED.id }], [existing]];

    const res = await request(app).post('/rewards/claim/first-report');

    expect(res.body.alreadyClaimed).toBe(true);
    expect(insertSpy).not.toHaveBeenCalled();            // no duplicate ledger row
    expect(mockSubmitPayout).toHaveBeenCalled();         // still re-POSTs to advance settlement
    expect([200, 202]).toContain(res.status);
  });

  it('repeat-claim re-POSTs the PERSISTED {address, amount}, not drifted current values', async () => {
    // The original claim persisted address 0xAAAA… and 5000000000 (50 WRF).
    const ORIGINAL_ADDR = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const existing = {
      id: 100, userId: 1, contributorType: 'achievement',
      metadata: {
        achievementId: 'first-report', settlement: 'settling',
        claimId: 'ach:v1:1:first-report', address: ORIGINAL_ADDR, amountBaseUnits: '5000000000',
      },
    };
    // Meanwhile the user's wallet changed AND the achievement's points changed.
    const MUTATED_WALLET = { walletAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' };
    const MUTATED_ACHIEVEMENT = { ...ACHIEVEMENT, points: 99 };
    selectQueue = [[MUTATED_ACHIEVEMENT], [EARNED], [MUTATED_WALLET], [{ id: EARNED.id }], [existing]];

    await request(app).post('/rewards/claim/first-report');

    // Must re-POST the ORIGINAL persisted tuple, NOT the mutated current values.
    expect(mockSubmitPayout).toHaveBeenCalledWith({
      address: ORIGINAL_ADDR,
      amountBaseUnits: 5_000_000_000n,
      claimId: 'ach:v1:1:first-report',
    });
    // Explicitly assert no drift to the mutated values.
    const call = mockSubmitPayout.mock.calls[0][0] as any;
    expect(call.address).not.toBe(MUTATED_WALLET.walletAddress);
    expect(call.amountBaseUnits).not.toBe(9_900_000_000n); // 99 WRF
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('backfills the replay tuple onto a pre-rewire (ledger-only) row on repeat claim', async () => {
    // A row created by the #889 ledger-only handler: no claimId/address/amount.
    const legacy = {
      id: 100, userId: 1, contributorType: 'achievement',
      metadata: { achievementId: 'first-report', settlement: 'ledger', onChain: false },
    };
    selectQueue = [[ACHIEVEMENT], [EARNED], [WALLET], [{ id: EARNED.id }], [legacy]];

    await request(app).post('/rewards/claim/first-report');

    // The settlement update backfills claimId/address/amount so future re-POSTs
    // are stable (the metadata-bearing update call, not the achievement flip).
    const metaUpdate = updateSetSpy.mock.calls.map((c) => c[0] as any).find((v) => v.metadata);
    expect(metaUpdate.metadata).toMatchObject({
      claimId: 'ach:v1:1:first-report',
      address: WALLET.walletAddress,
      amountBaseUnits: '5000000000',
    });
  });

  it('returns 422 when the user has no valid on-chain wallet address', async () => {
    selectQueue = [[ACHIEVEMENT], [EARNED], []]; // users lookup misses
    const res = await request(app).post('/rewards/claim/first-report');
    expect(res.status).toBe(422);
    expect(mockSubmitPayout).not.toHaveBeenCalled();
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown achievement', async () => {
    selectQueue = [[]];
    const res = await request(app).post('/rewards/claim/does-not-exist');
    expect(res.status).toBe(404);
    expect(mockSubmitPayout).not.toHaveBeenCalled();
  });

  it('returns 400 when the user has not earned the achievement', async () => {
    selectQueue = [[ACHIEVEMENT], []];
    const res = await request(app).post('/rewards/claim/first-report');
    expect(res.status).toBe(400);
    expect(insertSpy).not.toHaveBeenCalled();
  });

  it('returns 401 when the caller has no resolvable user id', async () => {
    mockAuthMiddleware.mockImplementation((req: any, _res: any, next: any) => { req.user = {}; next(); });
    const res = await request(app).post('/rewards/claim/first-report');
    expect(res.status).toBe(401);
  });
});

describe('GET /rewards/history (#215)', () => {
  it('returns keyset-paged results in stable descending id order with hasMore + nextCursor', async () => {
    const rows = [
      { id: 30, userId: 1, amount: 5, contributorType: 'achievement' },
      { id: 20, userId: 1, amount: 3, contributorType: 'achievement' },
      { id: 10, userId: 1, amount: 1, contributorType: 'achievement' },
    ];
    selectQueue = [rows];
    const res = await request(app).get('/rewards/history?limit=2');
    expect(res.status).toBe(200);
    expect(res.body.history.map((r: any) => r.id)).toEqual([30, 20]);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.nextCursor).toBe(20);
  });

  it('reports hasMore=false and a null cursor on the last page', async () => {
    selectQueue = [[{ id: 10, userId: 1, amount: 1, contributorType: 'achievement' }]];
    const res = await request(app).get('/rewards/history?limit=25');
    expect(res.status).toBe(200);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.nextCursor).toBeNull();
  });

  it('applies the keyset cursor (lt on id) when ?before= is supplied', async () => {
    selectQueue = [[]];
    const res = await request(app).get('/rewards/history?before=20&limit=5');
    expect(res.status).toBe(200);
    expect((drizzle.lt as jest.Mock)).toHaveBeenCalled();
  });
});
