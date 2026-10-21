/**
 * Governance Routes — DB-backed lifecycle tests
 *
 * Covers: proposal submission shape validation, vote counting logic,
 * finalize tally (PASSED/REJECTED/VETOED), execute guard, and
 * the gas-relay integration path.
 *
 * Issues: #372
 *
 * Strategy: mock the DB and core4 client so no real connections are needed.
 * The governance-routes module is tested via supertest with injected mocks.
 */

import express, { type Request, type Response, type NextFunction } from 'express';
import request from 'supertest';

// ---------------------------------------------------------------------------
// Mock DB before any imports that load drizzle
// ---------------------------------------------------------------------------
const mockDbSelect = jest.fn();
const mockDbUpdate = jest.fn();
const mockDbInsert = jest.fn();

/**
 * Build a chainable drizzle-like query object that resolves to `mockDbSelect`.
 * Supports: .where(), .orderBy(), .limit(), .offset() in any order.
 */
function makeChain() {
  const chain: any = {
    where: () => chain,
    orderBy: () => chain,
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (v: unknown) => void, reject: (e: unknown) => void) =>
      mockDbSelect().then(resolve, reject),
  };
  return chain;
}

jest.mock('../server/db.js', () => ({
  db: {
    select: () => ({ from: () => makeChain() }),
    update: () => ({ set: () => ({ where: mockDbUpdate }) }),
    insert: () => ({
      values: (values: unknown) => {
        const result = mockDbInsert(values);
        return {
          returning: () => result.returning(),
          onConflictDoNothing: () => result,
        };
      },
    }),
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ op: 'eq', args }),
  and: (...args: unknown[]) => ({ op: 'and', args }),
  desc: (value: unknown) => value,
  count: () => 'count',
  sum: (value: unknown) => value,
  sql: (parts: TemplateStringsArray) => parts.join('?'),
}));

// Mock governance schema (tables)
jest.mock('../shared/governance-schema.js', () => ({
  proposals: {},
  votes: {},
  parameters: {},
  delegations: {},
}));

jest.mock('../shared/schema-governance-consolidated.js', () => ({
  treasuryConsolidated: {},
}));

// Mock auth middleware to inject a fake user
const injectAdmin = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: 'admin-001', address: '0xAdmin', role: 'admin', roles: ['admin'] };
  next();
};
jest.mock('../server/middleware/authMiddleware.js', () => ({
  requireAuth: injectAdmin,
  requireAdmin: injectAdmin,
}));

// Mock core4 client utilities so no network calls fire
jest.mock('../shared/core4-route-client.js', () => ({
  extractCore4Data: (payload: unknown) => payload,
  fetchCore4Json: jest.fn(),
  forwardCore4Headers: () => ({}),
  sendCore4Error: (_res: Response, _r: unknown, msg: string) =>
    _res.status(502).json({ error: msg }),
  sendCore4Unavailable: (_res: Response, _e: unknown, msg: string) =>
    _res.status(503).json({ error: msg }),
  toNullable: (v: unknown) => v ?? null,
}));

jest.mock('../utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));
jest.mock('../server/utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
  securityLogger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

// Import after mocks are wired
import { fetchCore4Json } from '../shared/core4-route-client.js';
const mockFetchCore4 = fetchCore4Json as jest.Mock;

// Lazy-import router — must come after mocks
let governanceRouter: express.Router;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/governance', governanceRouter);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Simulate a DB .select().from().[where/orderBy/...]() chain that returns `rows`. */
function stubSelect(rows: unknown[]) {
  // The makeChain().then() calls mockDbSelect() directly, so mock it as a function returning a promise.
  mockDbSelect.mockReturnValueOnce(Promise.resolve(rows));
}

/** Simulate .update().set().where().returning() returning `rows`. */
function stubUpdate(rows: unknown[]) {
  mockDbUpdate.mockReturnValueOnce({ returning: () => Promise.resolve(rows) });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  // Dynamic import AFTER all mocks are registered
  const mod = await import('../server/routes/governance-routes.js');
  governanceRouter = (mod as any).default ?? (mod as any).router ?? mod;
});

beforeEach(() => {
  jest.clearAllMocks();
});

// ---------------------------------------------------------------------------
// GET /governance/proposals — list proposals
// ---------------------------------------------------------------------------

describe('GET /governance/proposals', () => {
  it('returns proposal list from core4 when available', async () => {
    // core4 answers a paginated object, never a bare array (backend#1242).
    mockFetchCore4.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { total: 1, offset: 0, limit: 100, proposals: [{ id: '1', title: 'Test' }] },
    });

    const res = await request(buildApp()).get('/governance/proposals');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.proposals).toEqual([expect.objectContaining({ id: '1', title: 'Test' })]);
    expect(res.body.count).toBe(1);
    expect(res.body.total).toBe(1);
  });

  it('proxies 502 when core4 returns an error', async () => {
    mockFetchCore4.mockResolvedValueOnce({
      ok: false,
      status: 502,
      payload: { error: 'upstream failure' },
    });

    const res = await request(buildApp()).get('/governance/proposals');

    expect(res.status).toBe(502);
  });
});

describe('GET /governance/delegations', () => {
  it('returns active delegations for the delegator path endpoint', async () => {
    stubSelect([
      {
        delegator: '0xAbC',
        delegate: '0xDef',
        amount: '25',
        createdAt: '2026-04-08T00:00:00.000Z',
        active: true,
      },
    ]);

    const res = await request(buildApp()).get('/governance/delegations/delegator/0xAbC');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.delegations).toEqual([
      expect.objectContaining({
        delegator: '0xAbC',
        delegate: '0xDef',
        votingPower: 25,
      }),
    ]);
  });

  it('supports the frontend fallback query route', async () => {
    stubSelect([
      {
        delegator: '0xAbC',
        delegate: '0xDef',
        amount: '5.5',
        createdAt: '2026-04-08T00:00:00.000Z',
        active: true,
      },
    ]);

    const res = await request(buildApp()).get('/governance/delegations?delegator=0xAbC');

    expect(res.status).toBe(200);
    expect(res.body.delegations[0]).toEqual(
      expect.objectContaining({
        delegator: '0xAbC',
        delegate: '0xDef',
        votingPower: 5.5,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// GET /governance/proposals/:id — single proposal
// ---------------------------------------------------------------------------

describe('GET /governance/proposals/:id', () => {
  it('returns the proposal from core4', async () => {
    mockFetchCore4.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { id: '42', title: 'Fund weather stations' },
    });

    const res = await request(buildApp()).get('/governance/proposals/42');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.proposal).toBeDefined();
    expect(mockFetchCore4).toHaveBeenLastCalledWith('/governance/proposals/42');
  });

  // backend#1221: the id was interpolated raw into the core4 path, so an
  // encoded dot-segment could steer the backend at any core4 GET route.
  it.each([
    '..%2F..%2Fdebug%2Fseed-account',
    '..%2F..%2Fadmin%3Fx%3D1',
    'prop%2F..%2Fvotes',
    'prop-001%3Fleak%3D1',
    'prop.001',
    'x'.repeat(129),
  ])('rejects injection-shaped id %s with 400 and never calls core4', async (id) => {
    mockFetchCore4.mockClear();

    const res = await request(buildApp()).get(`/governance/proposals/${id}`);

    expect(res.status).toBe(400);
    expect(mockFetchCore4).not.toHaveBeenCalled();
  });

  it('accepts core4-shaped ids such as prop-001', async () => {
    mockFetchCore4.mockResolvedValueOnce({ ok: true, status: 200, payload: { id: 'prop-001' } });

    const res = await request(buildApp()).get('/governance/proposals/prop-001');

    expect(res.status).toBe(200);
    expect(mockFetchCore4).toHaveBeenLastCalledWith('/governance/proposals/prop-001');
  });
});

// ---------------------------------------------------------------------------
// POST /governance/proposals — submit a proposal
// ---------------------------------------------------------------------------

describe('POST /governance/proposals', () => {
  const keys = ['WRFCOIN_OPERATOR_TOKEN', 'WRFCOIN_GOVERNANCE_PROPOSER_ADDRESS', 'WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  beforeEach(() => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'test-only-governance-operator';
    process.env.WRFCOIN_GOVERNANCE_PROPOSER_ADDRESS = `0x${'a'.repeat(40)}`;
    process.env.WRFCOIN_ADMIN_GOVERNANCE_PROPOSAL_CONFIG = JSON.stringify({ proposal_id: '99', parameter: 'test', value: '10' });
  });
  afterAll(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  it('returns 200 with proposal on success', async () => {
    mockFetchCore4.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { id: '99', title: 'New proposal' },
    });

    const res = await request(buildApp())
      .post('/governance/proposals')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.proposal).toBeDefined();
    expect(res.body.message).toMatch(/created/i);
  });

  it('returns 503 when core4 is unreachable', async () => {
    mockFetchCore4.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const res = await request(buildApp())
      .post('/governance/proposals')
      .send({});

    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// PUT /governance/proposals/:id/activate — lifecycle: DEPOSIT → VOTING
// ---------------------------------------------------------------------------

describe('PUT /governance/proposals/:id/activate', () => {
  const PROPOSAL_ID = 1;

  it('activates a DEPOSIT proposal to VOTING', async () => {
    const existing = {
      id: PROPOSAL_ID,
      status: 'DEPOSIT',
      state: 'pending',
      creatorAddress: '0xAdmin',
      votingPeriod: 3600,
    };
    stubSelect([existing]);
    const updated = { ...existing, status: 'VOTING', state: 'active' };
    stubUpdate([updated]);

    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/activate`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.proposal.status).toBe('VOTING');
  });

  it('returns 404 when proposal does not exist', async () => {
    stubSelect([]);

    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/activate`)
      .send({});

    expect(res.status).toBe(404);
  });

  it('returns 409 when proposal is already VOTING', async () => {
    stubSelect([{
      id: PROPOSAL_ID,
      status: 'VOTING',
      state: 'active',
      creatorAddress: '0xAdmin',
    }]);

    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/activate`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/activate/i);
  });
});

// ---------------------------------------------------------------------------
// PUT /governance/proposals/:id/finalize — tally and determine outcome
// ---------------------------------------------------------------------------

describe('PUT /governance/proposals/:id/finalize — vote tallying', () => {
  const PROPOSAL_ID = 2;
  const pastDate = new Date(Date.now() - 86400 * 1000).toISOString(); // 1 day ago

  it('finalizes as PASSED when YES > NO and no veto', async () => {
    stubSelect([{
      id: PROPOSAL_ID,
      status: 'VOTING',
      creatorAddress: '0xAdmin',
      votingEndTime: pastDate,
      totalYes: '60',
      totalNo: '30',
      totalNoWithVeto: '5',
      totalAbstain: '5',
    }]);
    stubUpdate([{ id: PROPOSAL_ID, status: 'PASSED' }]);

    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/finalize`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.tally.yes).toBe(60);
    expect(res.body.tally.no).toBe(30);
    expect(res.body.proposal.status).toBe('PASSED');
  });

  it('finalizes as REJECTED when NO >= YES', async () => {
    stubSelect([{
      id: PROPOSAL_ID,
      status: 'VOTING',
      creatorAddress: '0xAdmin',
      votingEndTime: pastDate,
      totalYes: '40',
      totalNo: '50',
      totalNoWithVeto: '0',
      totalAbstain: '10',
    }]);
    stubUpdate([{ id: PROPOSAL_ID, status: 'REJECTED' }]);

    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/finalize`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.proposal.status).toBe('REJECTED');
  });

  it('finalizes as VETOED when veto votes exceed 1/3 of total', async () => {
    stubSelect([{
      id: PROPOSAL_ID,
      status: 'VOTING',
      creatorAddress: '0xAdmin',
      votingEndTime: pastDate,
      totalYes: '50',
      totalNo: '10',
      totalNoWithVeto: '40', // 40/100 > 1/3
      totalAbstain: '0',
    }]);
    stubUpdate([{ id: PROPOSAL_ID, status: 'VETOED' }]);

    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/finalize`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.proposal.status).toBe('VETOED');
  });

  it('finalizes as REJECTED when there are zero votes', async () => {
    stubSelect([{
      id: PROPOSAL_ID,
      status: 'VOTING',
      creatorAddress: '0xAdmin',
      votingEndTime: pastDate,
      totalYes: '0',
      totalNo: '0',
      totalNoWithVeto: '0',
      totalAbstain: '0',
    }]);
    stubUpdate([{ id: PROPOSAL_ID, status: 'REJECTED' }]);

    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/finalize`)
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.proposal.status).toBe('REJECTED');
  });

  it('returns 400 if voting period is still active', async () => {
    const futureDate = new Date(Date.now() + 86400 * 1000).toISOString();
    stubSelect([{
      id: PROPOSAL_ID,
      status: 'VOTING',
      creatorAddress: '0xAdmin',
      votingEndTime: futureDate,
      totalYes: '10',
      totalNo: '0',
      totalNoWithVeto: '0',
      totalAbstain: '0',
    }]);

    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/finalize`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/voting period/i);
  });
});

// ---------------------------------------------------------------------------
// PUT /governance/proposals/:id/execute — only PASSED proposals can execute
// ---------------------------------------------------------------------------

describe('PUT /governance/proposals/:id/execute', () => {
  const PROPOSAL_ID = 3;

  it('refuses to fabricate execution for a PASSED proposal without a canonical receipt', async () => {
    stubSelect([{
      id: PROPOSAL_ID,
      status: 'PASSED',
      creatorAddress: '0xAdmin',
    }]);
    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/execute`)
      .send({});

    expect(res.status).toBe(503);
    expect(res.body.success).toBe(false);
    expect(res.body.code).toBe('CANONICAL_EXECUTION_UNAVAILABLE');
    expect(res.body.proposal.status).toBe('PASSED');
    expect(mockDbUpdate).not.toHaveBeenCalled();
  });

  it('returns 409 when proposal is not PASSED', async () => {
    stubSelect([{
      id: PROPOSAL_ID,
      status: 'VOTING',
      creatorAddress: '0xAdmin',
    }]);

    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/execute`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/PASSED/);
  });

  it('returns 404 when proposal does not exist', async () => {
    stubSelect([]);

    const res = await request(buildApp())
      .put(`/governance/proposals/${PROPOSAL_ID}/execute`)
      .send({});

    expect(res.status).toBe(404);
  });
});

describe('governance treasury and slashing execution truth', () => {
  it('records a deposit as a non-executed intent', async () => {
    mockDbInsert.mockReturnValueOnce({
      returning: () => Promise.resolve([{ id: 1, approvalStatus: 'pending', executedAt: null }]),
    });
    const res = await request(buildApp()).post('/governance/treasury/deposit').send({
      amount: '10', tokenAddress: 'wrf:test', description: 'observed external deposit',
    });
    expect(res.status).toBe(202);
    expect(res.body.executed).toBe(false);
    expect(res.body.transaction.approvalStatus).toBe('pending');
    expect(mockDbInsert.mock.calls[0][0]).toEqual(expect.objectContaining({
      approvalStatus: 'pending',
    }));
    expect(mockDbInsert.mock.calls[0][0]).not.toHaveProperty('executedAt');
  });

  it.each([
    ['/governance/treasury/withdraw', { amount: '5', tokenAddress: 'wrf:test', toAddress: 'wrf1target' }],
    ['/governance/rewards/slashing-event', { validatorAddress: 'wrf1validator', amount: '5', tokenAddress: 'wrf:test' }],
  ])('rejects direct action without a governance proposal: %s', async (path, body) => {
    const res = await request(buildApp()).post(path).send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/proposalId/);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it.each([
    ['/governance/treasury/withdraw', { amount: '5', tokenAddress: 'wrf:test', toAddress: 'wrf1target', proposalId: 7 }],
    ['/governance/rewards/slashing-event', { validatorAddress: 'wrf1validator', amount: '5', tokenAddress: 'wrf:test', proposalId: 7 }],
  ])('rejects action when proposal has not passed: %s', async (path, body) => {
    stubSelect([{ id: 7, status: 'VOTING' }]);
    const res = await request(buildApp()).post(path).send(body);
    expect(res.status).toBe(409);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('records a PASSED-proposal withdrawal as approved but not executed', async () => {
    stubSelect([{
      id: 7,
      status: 'PASSED',
      proposalType: 'TREASURY_WITHDRAWAL',
      metadata: { content: { amount: '5', tokenAddress: 'wrf:test', toAddress: 'wrf1target' } },
    }]);
    mockDbInsert.mockReturnValueOnce({
      returning: () => Promise.resolve([{ id: 2, approvalStatus: 'approved', executedAt: null }]),
    });
    const res = await request(buildApp()).post('/governance/treasury/withdraw').send({
      amount: '5', tokenAddress: 'wrf:test', toAddress: 'wrf1target', proposalId: 7,
    });
    expect(res.status).toBe(202);
    expect(res.body.executed).toBe(false);
    expect(mockDbInsert.mock.calls[0][0]).toEqual(expect.objectContaining({
      proposalId: '7', approvalStatus: 'approved', toAddress: 'wrf1target',
    }));
    expect(mockDbInsert.mock.calls[0][0]).not.toHaveProperty('executedAt');
  });

  it('does not let an unrelated PASSED proposal authorize an arbitrary withdrawal', async () => {
    stubSelect([{
      id: 7,
      status: 'PASSED',
      proposalType: 'TREASURY_WITHDRAWAL',
      metadata: { content: { amount: '5', tokenAddress: 'wrf:test', toAddress: 'wrf1approved' } },
    }]);
    const res = await request(buildApp()).post('/governance/treasury/withdraw').send({
      amount: '5', tokenAddress: 'wrf:test', toAddress: 'wrf1attacker', proposalId: 7,
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/exact withdrawal/);
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('records exact PASSED-proposal slashing as approved but not executed', async () => {
    stubSelect([{
      id: 9,
      status: 'PASSED',
      proposalType: 'VALIDATOR_SLASHING',
      parametersToChange: { validatorAddress: 'wrf1validator', amount: '3', tokenAddress: 'wrf:test' },
    }]);
    mockDbInsert.mockReturnValueOnce({
      returning: () => Promise.resolve([{ id: 3, approvalStatus: 'approved', executedAt: null }]),
    });
    const res = await request(buildApp()).post('/governance/rewards/slashing-event').send({
      validatorAddress: 'wrf1validator', amount: '3', tokenAddress: 'wrf:test', proposalId: 9,
    });
    expect(res.status).toBe(202);
    expect(res.body.executed).toBe(false);
    expect(mockDbInsert.mock.calls[0][0]).toEqual(expect.objectContaining({
      proposalId: '9', approvalStatus: 'approved',
    }));
    expect(mockDbInsert.mock.calls[0][0]).not.toHaveProperty('executedAt');
  });

  it.each([
    [
      '/governance/treasury/withdraw',
      'TREASURY_WITHDRAWAL',
      { amount: '5', tokenAddress: 'wrf:test', toAddress: 'wrf1target' },
      { amount: '5', tokenAddress: 'wrf:test', toAddress: 'wrf1target', proposalId: 7 },
      'GOV-7-treasury_withdrawal',
    ],
    [
      '/governance/rewards/slashing-event',
      'VALIDATOR_SLASHING',
      { validatorAddress: 'wrf1validator', amount: '3', tokenAddress: 'wrf:test' },
      { validatorAddress: 'wrf1validator', amount: '3', tokenAddress: 'wrf:test', proposalId: 7 },
      'GOV-7-validator_slashing',
    ],
  ])('returns the existing intent on an idempotent retry: %s', async (path, proposalType, content, body, transactionId) => {
    stubSelect([{ id: 7, status: 'PASSED', proposalType, metadata: { content } }]);
    mockDbInsert.mockReturnValueOnce({ returning: () => Promise.resolve([]) });
    stubSelect([{ id: 22, transactionId, approvalStatus: 'approved' }]);

    const res = await request(buildApp()).post(path).send(body);

    expect(res.status).toBe(202);
    expect(res.body.executed).toBe(false);
    expect(res.body.transaction ?? res.body.slashingEvent).toEqual(expect.objectContaining({
      id: 22,
      transactionId,
      approvalStatus: 'approved',
    }));
    expect(mockDbInsert.mock.calls[0][0]).toEqual(expect.objectContaining({ transactionId }));
  });
});

// ---------------------------------------------------------------------------
// GET /governance/proposals/:id/votes — vote listing
// ---------------------------------------------------------------------------

describe('GET /governance/proposals/:id/votes', () => {
  it('returns votes for a proposal', async () => {
    stubSelect([{ total: 1 }]);
    stubSelect([
      { voterAddress: '0xVoter1', support: true, timestamp: new Date().toISOString() },
    ]);

    const res = await request(buildApp()).get('/governance/proposals/1/votes');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.pagination.total).toBe(1);
  });
});
