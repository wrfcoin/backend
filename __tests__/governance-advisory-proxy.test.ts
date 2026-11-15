/**
 * Advisory governance read proxy: GET /governance/advisory/proposals and
 * /governance/advisory/proposals/:id forward to core4's
 * /governance/advisory/* routes. Only the network call is faked;
 * extractCore4Data is the real one.
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

// An AdvisoryProposalView as core4 serializes it (governance/advisory.rs).
const view = (id: string) => ({
  id,
  kind: 'advisory',
  proposer: 'ab'.repeat(20),
  title: 'Welcome to governance',
  summary: 'The first advisory proposal. It changes nothing.',
  created_at_block: 100,
  voting_deadline: 1220,
  status: 'active',
  yes_votes: 1,
  no_votes: 0,
  eligible_count: 12,
  quorum_min_votes: 3,
  approval_percent: 51,
  deposit_held: '100000000',
  finalized_at_block: null,
});

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

describe('GET /governance/advisory/proposals', () => {
  it('forwards paging and status and unwraps the core4 envelope', async () => {
    mockFetchCore4.mockResolvedValue({
      ok: true,
      status: 200,
      payload: {
        ok: true,
        data: {
          feature_active_next_height: true,
          observed_at_height: 1300,
          total: 3,
          offset: 0,
          limit: 2,
          next_offset: 2,
          proposals: [view('adv-0123456789abcdef'), view('adv-fedcba9876543210')],
          limits: { quorum_min_votes: 3, chain_id: '888', network_id: 'testnet' },
        },
      },
    });
    const res = await request(app()).get('/governance/advisory/proposals?limit=2&status=active');
    expect(res.status).toBe(200);
    expect(mockFetchCore4).toHaveBeenCalledWith('/governance/advisory/proposals', {
      query: { offset: 0, limit: 2, status: 'active' },
    });
    expect(res.body.success).toBe(true);
    expect(res.body.featureActive).toBe(true);
    expect(res.body.total).toBe(3);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.proposals).toHaveLength(2);
    expect(res.body.proposals[0].title).toBe('Welcome to governance');
    expect(res.body.limits.quorum_min_votes).toBe(3);
  });

  it('answers an empty list while the feature is unscheduled', async () => {
    mockFetchCore4.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { ok: true, data: { feature_active_next_height: false, total: 0, proposals: [] } },
    });
    const res = await request(app()).get('/governance/advisory/proposals');
    expect(res.status).toBe(200);
    expect(res.body.featureActive).toBe(false);
    expect(res.body.proposals).toEqual([]);
  });

  it('refuses an unknown status without calling core4', async () => {
    const res = await request(app()).get('/governance/advisory/proposals?status=executed');
    expect(res.status).toBe(400);
    expect(mockFetchCore4).not.toHaveBeenCalled();
  });

  it('reports an unexpected node shape as 502', async () => {
    mockFetchCore4.mockResolvedValue({ ok: true, status: 200, payload: { ok: true, data: { nope: 1 } } });
    const res = await request(app()).get('/governance/advisory/proposals');
    expect(res.status).toBe(502);
  });
});

describe('GET /governance/advisory/proposals/:id', () => {
  it('returns one proposal', async () => {
    mockFetchCore4.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { ok: true, data: { observed_at_height: 5, proposal: view('adv-0123456789abcdef') } },
    });
    const res = await request(app()).get('/governance/advisory/proposals/adv-0123456789abcdef');
    expect(res.status).toBe(200);
    expect(mockFetchCore4).toHaveBeenCalledWith('/governance/advisory/proposals/adv-0123456789abcdef');
    expect(res.body.proposal.id).toBe('adv-0123456789abcdef');
  });

  it.each(['LAW-001', 'adv-0123', 'adv-0123456789ABCDEF', 'adv-0123456789abcdef%2F..'])(
    'refuses %s before building an upstream path',
    async (id) => {
      const res = await request(app()).get(`/governance/advisory/proposals/${id}`);
      expect(res.status).toBe(400);
      expect(mockFetchCore4).not.toHaveBeenCalled();
    },
  );
});
