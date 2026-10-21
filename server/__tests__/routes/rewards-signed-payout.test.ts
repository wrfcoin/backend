import { jest, describe, it, expect, beforeAll, beforeEach, afterEach } from '@jest/globals';

jest.mock('prom-client', () => {
  class Counter {
    inc = jest.fn();
    labels = () => ({ inc: jest.fn() });
  }
  class Gauge {
    set = jest.fn();
    labels = () => ({ set: jest.fn() });
  }
  class Histogram {
    observe = jest.fn();
    labels = () => ({ observe: jest.fn() });
  }
  const register = { registerMetric: jest.fn() };
  return { Counter, Gauge, Histogram, register };
});

const mockLogWarn = jest.fn();
const mockLogError = jest.fn();
jest.mock('../../utils/logger.js', () => ({
  performanceLogger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
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
  for (const m of ['select', 'from', 'where', 'orderBy', 'groupBy', 'leftJoin', 'innerJoin'])
    chain[m] = () => chain;
  chain.for = () => chain;
  chain.limit = () => nextSelect();
  chain.then = (res: any, rej: any) => nextSelect().then(res, rej);
  return chain;
}
function insertChain(): any {
  const chain: any = {};
  chain.values = (v: unknown) => {
    insertSpy(v);
    return chain;
  };
  chain.returning = () => Promise.resolve(insertRow ? [insertRow] : []);
  chain.then = (res: any, rej: any) => Promise.resolve(insertRow ? [insertRow] : []).then(res, rej);
  return chain;
}
function updateChain(): any {
  const chain: any = {};
  chain.set = (v: unknown) => {
    updateSetSpy(v);
    return chain;
  };
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
  select: () => {
    txOps.push('select');
    return selectChain();
  },
  insert: () => {
    txOps.push('insert');
    return insertChain();
  },
  update: () => {
    txOps.push('update');
    return updateChain();
  },
  execute: (q: unknown) => {
    txOps.push('execute');
    executeSpy(String(q));
    return Promise.resolve([]);
  },
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
  rewardDistributionConfig: {
    id: 'id',
    active: 'active',
    createdAt: 'createdAt',
  },
  contributorRewards: {
    id: 'id',
    userId: 'userId',
    amount: 'amount',
    contributorType: 'contributorType',
    reason: 'reason',
    metadata: 'metadata',
    createdAt: 'createdAt',
  },
  forecastCoverageMetrics: { region: 'region', createdAt: 'createdAt' },
  environmentalOffsetProofs: {
    userId: 'userId',
    isVerified: 'isVerified',
    offsetPoints: 'offsetPoints',
    createdAt: 'createdAt',
  },
  computationalWorkProofs: {
    id: 'id',
    nodeId: 'nodeId',
    isVerified: 'isVerified',
    resourceHours: 'resourceHours',
    completedAt: 'completedAt',
  },
  computationalNodes: { nodeId: 'nodeId', operatorAddress: 'operatorAddress' },
  algorithmAdvancements: {
    userId: 'userId',
    isVerified: 'isVerified',
    createdAt: 'createdAt',
  },
  achievements: {
    id: 'id',
    achievementId: 'achievementId',
    title: 'title',
    points: 'points',
  },
  userAchievements: {
    id: 'id',
    userId: 'userId',
    achievementId: 'achievementId',
    status: 'status',
    progress: 'progress',
    metadata: 'metadata',
  },
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
beforeAll(async () => {
  app = await buildApp();
});

import { generateKeyPairSync, sign } from 'node:crypto';
import { payoutPreimage } from '../../services/achievement-payout-authorization.js';
const keys = generateKeyPairSync('ed25519');
const wrong = generateKeyPairSync('ed25519');
const address = '0x' + 'AB'.repeat(20);
const tuple = {
  achievementId: 'first-report',
  claimId: 'ach:v1:1:first-report',
  address,
  amountBaseUnits: 1_000_000_000n,
};
const proof = { chainId: '777', nonce: '01'.repeat(32), signature: '' };
proof.signature = sign(null, payoutPreimage(tuple, proof), keys.privateKey).toString('hex');
const envKeys = [
  'ACHIEVEMENT_PAYOUT_SIGNED_ENABLED',
  'ACHIEVEMENT_PAYOUT_CHAIN_ID',
  'ACHIEVEMENT_PAYOUT_PUBLIC_KEY',
];
const prior = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
const totals = {
  recipientDay: '0',
  recipientLifetime: '0',
  globalDay: '0',
  unknownRecipients: '0',
};
function queue(points = 10, nonceRows: any[] = [], budget: any = totals) {
  selectQueue = [
    [{ id: 7, achievementId: 'first-report', title: 'Report', points }],
    [{ id: 3, progress: 100, status: 'completed', metadata: {} }],
    [{ walletAddress: address }],
    [{ id: 3 }],
    [],
    nonceRows,
    [budget],
    [{ userDay: '0', userLifetime: '0', globalDay: '0' }],
  ];
}
beforeEach(() => {
  process.env.ACHIEVEMENT_PAYOUT_SIGNED_ENABLED = 'true';
  process.env.ACHIEVEMENT_PAYOUT_CHAIN_ID = '777';
  process.env.ACHIEVEMENT_PAYOUT_PUBLIC_KEY = keys.publicKey
    .export({ format: 'der', type: 'spki' })
    .subarray(-32)
    .toString('hex');
  insertSpy.mockClear();
  updateSetSpy.mockClear();
  executeSpy.mockClear();
  txOps.length = 0;
  mockSubmitPayout.mockReset();
  mockSubmitPayout.mockResolvedValue({
    kind: 'success',
    status: 'accepted',
    txHash: 'test',
  } as never);
  insertRow = {
    id: 100,
    metadata: {
      ...tuple,
      amountBaseUnits: tuple.amountBaseUnits.toString(),
      payoutAuthorization: proof,
    },
  };
});
afterEach(() => {
  for (const key of envKeys) {
    if (prior[key] === undefined) delete process.env[key];
    else process.env[key] = prior[key];
  }
});
async function claim(auth: any = proof) {
  return request(app).post('/rewards/claim/first-report').send({ payoutAuthorization: auth });
}
function noMint() {
  expect(insertSpy).not.toHaveBeenCalled();
  expect(updateSetSpy).not.toHaveBeenCalled();
  expect(mockSubmitPayout).not.toHaveBeenCalled();
}
it('a completed row alone cannot authorize when enabled', async () => {
  queue();
  expect((await claim(null)).status).toBe(403);
  noMint();
});
it('configured Ed25519 signature authorizes and persists proof after the global lock', async () => {
  queue();
  expect((await claim()).status).toBe(202);
  expect(txOps[0]).toBe('execute');
  expect(insertSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      metadata: expect.objectContaining({ payoutAuthorization: proof, address: 'ab'.repeat(20) }),
    })
  );
  expect(mockSubmitPayout).toHaveBeenCalledWith(
    expect.objectContaining({
      authorization: proof,
      achievementId: 'first-report',
    })
  );
});
it('wrong signer never inserts or calls payout', async () => {
  queue();
  const bad = {
    ...proof,
    signature: sign(null, payoutPreimage(tuple, proof), wrong.privateKey).toString('hex'),
  };
  expect((await claim(bad)).status).toBe(403);
  noMint();
});
it('persisted nonce replay cannot create another ledger liability', async () => {
  queue(10, [{ id: 99 }]);
  expect((await claim()).status).toBe(403);
  noMint();
});
it.each([
  ['recipientDay', 16],
  ['recipientLifetime', 91],
  ['globalDay', 241],
])('pilot %s cap refuses before insert', async (field, value) => {
  queue(10, [], { ...totals, [field]: String(value) });
  expect((await claim()).status).toBe(403);
  noMint();
});
it('over 10 WRF is refused even with a valid signer and permissive legacy limits', async () => {
  queue(11);
  const bytes = Buffer.from(JSON.stringify([
    'wrfcoin_achievement_payout_authorization_v1', '777', tuple.claimId,
    tuple.achievementId, 'ab'.repeat(20), '1100000000', proof.nonce,
  ]));
  const overCapProof = { ...proof, signature: sign(null, bytes, keys.privateKey).toString('hex') };
  expect((await claim(overCapProof)).status).toBe(403);
  noMint();
});
it('unknown historical recipient fails closed', async () => {
  queue(10, [], { ...totals, unknownRecipients: '1' });
  expect((await claim()).status).toBe(403);
  noMint();
});
it('malformed configured flag refuses', async () => {
  queue();
  process.env.ACHIEVEMENT_PAYOUT_SIGNED_ENABLED = 'tru';
  expect((await claim()).status).toBe(403);
  noMint();
});
it('unsigned historical claim cannot be replayed after enablement', async () => {
  queue();
  selectQueue[4] = [
    {
      id: 99,
      metadata: { ...tuple, amountBaseUnits: tuple.amountBaseUnits.toString() },
    },
  ];
  expect((await claim()).status).toBe(403);
  noMint();
});
it('settled legacy repeat returns only an owner-scoped acknowledgement when enabled', async () => {
  queue();
  selectQueue[4] = [{ id: 99, metadata: { settlement: 'settled', privateMarker: 'must-not-leak' } }];
  const response = await claim(null);
  expect(response.status).toBe(200);
  expect(response.body).toEqual({
    success: true, alreadyClaimed: true,
    settlement: { state: 'settled', terminal: true },
  });
  noMint();
});
it.each(['pending', 'settling', 'failed', 'reversed'])(
  'unsigned %s legacy repeat still refuses without payout or writes', async (settlement) => {
    queue();
    selectQueue[4] = [{ id: 99, metadata: { settlement } }];
    expect((await claim(null)).status).toBe(403);
    noMint();
  }
);
it('a settled row for another owner cannot acknowledge this user claim', async () => {
  queue(); // The owner-scoped existing-row query returns no row.
  expect((await claim(null)).status).toBe(403);
  noMint();
});
it('an authorized same-tuple retry advances settlement without charging new budget or consuming another nonce', async () => {
  queue();
  selectQueue[4] = [insertRow];
  expect((await claim(null)).status).toBe(202);
  expect(insertSpy).not.toHaveBeenCalled();
  expect(selectQueue.length).toBe(3);
  expect(mockSubmitPayout).toHaveBeenCalledWith(expect.objectContaining({ authorization: proof }));
});
it('missing flag preserves existing unsigned route behavior', async () => {
  delete process.env.ACHIEVEMENT_PAYOUT_SIGNED_ENABLED;
  queue();
  selectQueue.splice(5, 2);
  expect((await claim(null)).status).toBe(202);
  expect(mockSubmitPayout).toHaveBeenCalled();
  expect(insertSpy).toHaveBeenCalledWith(
    expect.objectContaining({
      metadata: expect.not.objectContaining({
        payoutAuthorization: expect.anything(),
      }),
    })
  );
});
