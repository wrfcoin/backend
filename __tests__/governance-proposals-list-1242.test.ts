/**
 * backend#1242 — GET /governance/proposals always answered `proposals: []`.
 *
 * core4's GET /governance/proposals answers a paginated object,
 * `{total, offset, limit, proposals}` (core4 native-chain/src/bin/launch_api/
 * routes/governance.rs, list_governance_proposals), and the route kept the
 * result only if it was an array. The old tests mocked core4 with an array —
 * a shape core4 never sends — which is how the bug stayed green.
 *
 * Only the network call is faked here: extractCore4Data is the real one, so
 * both core4's bare object and an {ok, data} envelope go through the real
 * unwrapping. The live-node counterpart is in
 * __tests__/integration/core4-live-http-contract.test.ts.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../server/db.js', () => ({
  db: { execute: jest.fn(), select: jest.fn(), update: jest.fn(), insert: jest.fn() },
}));
jest.mock('../shared/governance-schema.js', () => ({
  proposals: {},
  votes: {},
  parameters: {},
  delegations: {},
}));
jest.mock('../shared/schema-governance-consolidated.js', () => ({
  treasuryConsolidated: {},
}));
jest.mock('../server/middleware/authMiddleware.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../utils/logger.js', () => ({
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));
jest.mock('../shared/core4-route-client.js', () => ({
  ...jest.requireActual('../shared/core4-route-client.js'),
  fetchCore4Json: jest.fn(),
}));

import { fetchCore4Json } from '../shared/core4-route-client.js';

const mockFetchCore4 = fetchCore4Json as jest.Mock;

// A GovernanceProposalRecord as core4 serializes it (shared-protocol
// blockchain/state.rs), abbreviated to the fields a list consumer reads.
const proposal = (id: string) => ({
  id,
  proposer: 'wrf1proposer',
  proposal_class: 'Standard',
  yes_votes: 10,
  no_votes: 2,
  quorum_percent: 20,
  approval_percent: 50,
  deposit: 1000,
  voting_deadline: 12345,
  status: 'Active',
});

function core4Page(total: number, offset: number, limit: number, ids: string[]) {
  return { ok: true, status: 200, payload: { total, offset, limit, proposals: ids.map(proposal) } };
}

let governanceRouter: express.Router;

beforeAll(async () => {
  const mod = await import('../server/routes/governance-routes.js');
  governanceRouter = (mod as any).default ?? mod;
});

beforeEach(() => {
  mockFetchCore4.mockReset();
});

function app() {
  const a = express();
  a.use(express.json());
  a.use('/governance', governanceRouter);
  return a;
}

describe('GET /governance/proposals reads core4\'s paginated object (backend#1242)', () => {
  it('returns the proposals core4 sent, with total/offset/limit passed through', async () => {
    mockFetchCore4.mockResolvedValueOnce(core4Page(3, 0, 100, ['prop-001', 'prop-002', 'prop-003']));

    const res = await request(app()).get('/governance/proposals');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, count: 3, total: 3, offset: 0, limit: 100, hasMore: false });
    expect(res.body.proposals.map((p: { id: string }) => p.id)).toEqual(['prop-001', 'prop-002', 'prop-003']);
  });

  it('reports a truncated page: count is the page, total is every proposal', async () => {
    mockFetchCore4.mockResolvedValueOnce(core4Page(7, 2, 2, ['prop-003', 'prop-004']));

    const res = await request(app()).get('/governance/proposals?offset=2&limit=2');

    expect(res.body).toMatchObject({ count: 2, total: 7, offset: 2, limit: 2, hasMore: true });
  });

  it('also accepts the {ok, data} envelope through the real extractCore4Data', async () => {
    const page = core4Page(1, 0, 100, ['prop-001']);
    mockFetchCore4.mockResolvedValueOnce({ ...page, payload: { ok: true, data: page.payload } });

    const res = await request(app()).get('/governance/proposals');

    expect(res.body).toMatchObject({ count: 1, total: 1 });
  });

  it.each([
    ['', { offset: 0, limit: 100 }],
    ['?limit=25', { offset: 0, limit: 25 }],
    ['?offset=40&limit=20', { offset: 40, limit: 20 }],
    ['?page=3&limit=10', { offset: 20, limit: 10 }],
    ['?limit=9999', { offset: 0, limit: 500 }],
    ['?limit=0&offset=-5', { offset: 0, limit: 1 }],
    ['?limit=abc&offset=xyz', { offset: 0, limit: 100 }],
  ])('forwards validated pagination %s to core4 as %j', async (query, expected) => {
    mockFetchCore4.mockResolvedValueOnce(core4Page(0, expected.offset, expected.limit, []));

    await request(app()).get(`/governance/proposals${query}`);

    expect(mockFetchCore4).toHaveBeenCalledWith('/governance/proposals', { query: expected });
  });

  it.each([
    ['a bare array (the shape the old code assumed)', [proposal('prop-001')]],
    ['an object without proposals', { total: 1, offset: 0, limit: 100 }],
    ['a non-numeric total', { total: '1', offset: 0, limit: 100, proposals: [] }],
    ['null', null],
  ])('fails closed with 502 CORE4_CONTRACT_MISMATCH on %s, never a silent []', async (_name, payload) => {
    mockFetchCore4.mockResolvedValueOnce({ ok: true, status: 200, payload });

    const res = await request(app()).get('/governance/proposals');

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('CORE4_CONTRACT_MISMATCH');
    expect(res.body.proposals).toBeUndefined();
  });

  it('still proxies a core4 error', async () => {
    mockFetchCore4.mockResolvedValueOnce({ ok: false, status: 503, payload: { error: 'down' } });

    const res = await request(app()).get('/governance/proposals');

    expect(res.status).toBe(503);
  });
});

describe('GET /governance/status counts proposals from core4\'s total (backend#1242)', () => {
  function stubStatus(proposalsPayload: unknown) {
    mockFetchCore4.mockImplementation(async (path: string) => {
      if (path === '/governance/proposals') return { ok: true, status: 200, payload: proposalsPayload };
      if (path === '/governance/laws') return { ok: true, status: 200, payload: { ok: true, data: { items: [{}, {}], next_cursor: null } } };
      return { ok: true, status: 200, payload: { current_policy: {} } };
    });
  }

  it('reports core4\'s total, not the length of a page, and asks for the smallest page', async () => {
    stubStatus({ total: 42, offset: 0, limit: 1, proposals: [proposal('prop-001')] });

    const res = await request(app()).get('/governance/status');

    expect(res.status).toBe(200);
    expect(res.body.data.proposalCount).toBe(42);
    expect(res.body.data.lawCount).toBe(2);
    expect(mockFetchCore4).toHaveBeenCalledWith('/governance/proposals', { query: { limit: 1 } });
  });

  it('does not present a first page as the law count when core4 has a next page (backend#1246)', async () => {
    mockFetchCore4.mockImplementation(async (path: string) => {
      if (path === '/governance/proposals') return { ok: true, status: 200, payload: { total: 1, offset: 0, limit: 1, proposals: [proposal('prop-001')] } };
      if (path === '/governance/laws') return { ok: true, status: 200, payload: { ok: true, data: { items: Array.from({ length: 50 }, () => ({})), next_cursor: 'c2' } } };
      return { ok: true, status: 200, payload: { current_policy: {} } };
    });
    const res = await request(app()).get('/governance/status');
    expect(res.status).toBe(200);
    expect(res.body.data.lawCount).toBeNull();
    expect(res.body.data.lawCountAtLeast).toBe(50);
  });

  it('a complete single law page is exact and has no lower-bound field value', async () => {
    stubStatus({ total: 1, offset: 0, limit: 1, proposals: [proposal('prop-001')] });
    const res = await request(app()).get('/governance/status');
    expect(res.body.data.lawCount).toBe(2);
    expect(res.body.data.lawCountAtLeast).toBeNull();
  });

  it('degrades proposalCount to null on an unreadable shape, like the other parts', async () => {
    stubStatus([proposal('prop-001')]);

    const res = await request(app()).get('/governance/status');

    expect(res.status).toBe(200);
    expect(res.body.data.proposalCount).toBeNull();
    expect(res.body.data.lawCount).toBe(2);
  });
});
