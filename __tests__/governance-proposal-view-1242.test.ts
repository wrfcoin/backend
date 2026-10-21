/**
 * backend#1242 review (codex round 18, P1): a POPULATED proposal list must
 * parse in the mobile app, not just an empty one.
 *
 * core4's GovernanceProposalRecord (shared-protocol src/blockchain/state.rs)
 * has no title or description; the mobile ProposalModel requires both as
 * String and fails the whole list without them. These tests push real-shaped,
 * NONEMPTY core4 records through the backend routes and check the result
 * against the mobile model's exact key/type contract, and against what the
 * web GovernancePanel normalizer (frontend#391) reads.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../server/db.js', () => ({
  db: { execute: jest.fn(), select: jest.fn(), update: jest.fn(), insert: jest.fn() },
}));
jest.mock('../shared/governance-schema.js', () => ({ proposals: {}, votes: {}, parameters: {}, delegations: {} }));
jest.mock('../shared/schema-governance-consolidated.js', () => ({ treasuryConsolidated: {} }));
jest.mock('../server/middleware/authMiddleware.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../utils/logger.js', () => ({ logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } }));
jest.mock('../shared/core4-route-client.js', () => ({
  ...jest.requireActual('../shared/core4-route-client.js'),
  fetchCore4Json: jest.fn(),
}));

import { fetchCore4Json } from '../shared/core4-route-client.js';
import { toProposalView } from '../server/utils/governance-proposal-view.js';

const mockFetchCore4 = fetchCore4Json as jest.Mock;

// ---------------------------------------------------------------------------
// core4 records, field for field from GovernanceProposalRecord. serde encodes
// Address([u8; 20]) as a 20-byte array, unit enums as strings, and
// GovernanceParameterUpdate as an externally tagged `{ "<Variant>": value }`.
// ---------------------------------------------------------------------------
const PROPOSER = [0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef, 0x10, 0x20, 0x30, 0x40];

function core4Record(id: string, update: unknown, extra: Record<string, unknown> = {}) {
  return {
    id,
    proposer: PROPOSER,
    update,
    proposal_class: 'Standard',
    yes_votes: 1500,
    no_votes: 250,
    quorum_percent: 20,
    approval_percent: 50,
    eligible_voting_power: 10000,
    eligible_voting_power_by_voter: { wrfvoter1: 1500 },
    deposit: 1000000,
    voting_deadline: 42000,
    status: 'Active',
    finalized_at_block: null,
    execution_error: null,
    votes_by_voter: { wrfvoter1: { approve: true, voting_power: 1500, cast_at_block: 41000 } },
    ...extra,
  };
}

const RECORDS = [
  core4Record('prop-001', { EmissionRate: 5 }),
  core4Record('prop-002', {
    LawCreate: {
      law_id: 'law-7',
      title: 'Station uptime disclosure',
      category: 'operations',
      plain_language_summary: 'Stations publish their monthly uptime.',
      enforcement_level: 'Advisory',
      status: 'Active',
    },
  }, { proposal_class: 'ConstitutionalAmendment', status: 'Executed', finalized_at_block: 42001 }),
  core4Record('prop-003', { OracleSet: ['oracle-a', 'oracle-b'] }),
  core4Record('prop-004', { LawAmendSummary: { law_id: 'law-7', plain_language_summary: 'Stations publish weekly uptime.' } }),
  core4Record('prop-005', { StakeRequired: { address: PROPOSER, amount: 250 } }, { status: 'FailedQuorum' }),
];

// ---------------------------------------------------------------------------
// The mobile contract: wrfcoin/mobile lib/features/governance/data/models/
// proposal_model.g.dart (_$ProposalModelFromJson, mobile main 6789e1a0). Each
// entry mirrors one generated cast: `as String` throws on anything but a
// string, `as String?` / `as num?` throw on a present value of another type.
// ---------------------------------------------------------------------------
const MOBILE_PROPOSAL_MODEL: Record<string, 'String' | 'String?' | 'num?'> = {
  id: 'String',
  title: 'String',
  description: 'String',
  proposalType: 'String?',
  status: 'String?',
  votingPeriod: 'String?',
  createdAt: 'String?',
  votesFor: 'num?',
  votesAgainst: 'num?',
  votesAbstain: 'num?',
};

function mobileProposalModelFromJson(json: Record<string, unknown>): void {
  for (const [key, type] of Object.entries(MOBILE_PROPOSAL_MODEL)) {
    const value = json[key];
    const optional = type.endsWith('?');
    if (value === undefined || value === null) {
      if (!optional) throw new TypeError(`type 'Null' is not a subtype of type 'String' (${key})`);
      continue;
    }
    const expected = type.replace('?', '') === 'num' ? 'number' : 'string';
    if (typeof value !== expected) throw new TypeError(`${key}: ${typeof value} is not ${type}`);
  }
}

let governanceRouter: express.Router;
beforeAll(async () => {
  const mod = await import('../server/routes/governance-routes.js');
  governanceRouter = (mod as any).default ?? mod;
});
beforeEach(() => mockFetchCore4.mockReset());

function app() {
  const a = express();
  a.use(express.json());
  a.use('/governance', governanceRouter);
  return a;
}

describe('the mobile ProposalModel contract (codex round 18 P1)', () => {
  it('rejects a raw core4 record: this is the failure the adapter prevents', () => {
    expect(() => mobileProposalModelFromJson(RECORDS[0])).toThrow(/title/);
  });

  it('GET /governance/proposals with a populated chain: every item parses as a mobile ProposalModel', async () => {
    mockFetchCore4.mockResolvedValueOnce({
      ok: true,
      status: 200,
      payload: { total: RECORDS.length, offset: 0, limit: 100, proposals: RECORDS },
    });

    const res = await request(app()).get('/governance/proposals');

    expect(res.status).toBe(200);
    expect(res.body.proposals).toHaveLength(RECORDS.length);
    for (const item of res.body.proposals) {
      expect(() => mobileProposalModelFromJson(item)).not.toThrow();
    }
  });

  it('GET /governance/proposals/:id: the detail parses as a mobile ProposalModel too', async () => {
    mockFetchCore4.mockResolvedValueOnce({ ok: true, status: 200, payload: RECORDS[1] });

    const res = await request(app()).get('/governance/proposals/prop-002');

    expect(res.status).toBe(200);
    expect(() => mobileProposalModelFromJson(res.body.proposal)).not.toThrow();
    expect(res.body.proposal.title).toBe('Station uptime disclosure');
  });
});

describe('the view keeps every native core4 field and derives, never invents', () => {
  it('preserves each core4 field byte-for-byte', () => {
    for (const record of RECORDS) {
      expect(toProposalView(record)).toEqual(expect.objectContaining(record));
    }
  });

  it.each([
    ['prop-001', 'EmissionRate: 5', 'EmissionRate: 5'],
    ['prop-002', 'Station uptime disclosure', 'Stations publish their monthly uptime.'],
    ['prop-003', 'OracleSet: oracle-a, oracle-b', 'OracleSet: oracle-a, oracle-b'],
    ['prop-004', 'LawAmendSummary: law_id=law-7, plain_language_summary=Stations publish weekly uptime.', 'Stations publish weekly uptime.'],
  ])('%s: title and description come from the record itself', (id, title, description) => {
    const view = toProposalView(RECORDS.find((r) => r.id === id)) as Record<string, unknown>;
    expect(view.title).toBe(title);
    expect(view.description).toBe(description);
  });

  it('maps class and votes to the mobile names and renders the proposer as Address::to_hex does', () => {
    const view = toProposalView(RECORDS[1]) as Record<string, unknown>;
    expect(view).toMatchObject({
      proposalType: 'ConstitutionalAmendment',
      votesFor: 1500,
      votesAgainst: 250,
      proposerAddress: '0x123456789abcdef00123456789abcdef10203040',
      status: 'Executed',
    });
  });

  it('leaves fields core4 has no source for absent instead of guessing', () => {
    const view = toProposalView(RECORDS[0]) as Record<string, unknown>;
    expect(view.createdAt).toBeUndefined();
    expect(view.votingPeriod).toBeUndefined();
    expect(view.votesAbstain).toBeUndefined();
  });

  it('falls back to the id when the update is unreadable, and passes non-objects through', () => {
    expect((toProposalView({ id: 'prop-009', update: { A: 1, B: 2 } }) as Record<string, unknown>).title).toBe('Proposal prop-009');
    expect(toProposalView(null)).toBeNull();
  });

  it('keeps a future native title/description if core4 ever adds them', () => {
    const view = toProposalView(core4Record('prop-010', { EmissionRate: 1 }, { title: 'Native', description: 'Native text' })) as Record<string, unknown>;
    expect(view.title).toBe('Native');
    expect(view.description).toBe('Native text');
  });
});

describe('what the web GovernancePanel normalizer reads (frontend#391)', () => {
  it('status is a string (String() on an object would render "[object Object]") and vote maps survive', () => {
    for (const record of RECORDS) {
      const view = toProposalView(record) as Record<string, unknown>;
      expect(typeof view.status).toBe('string');
      expect(typeof view.yes_votes).toBe('number');
      expect(typeof view.no_votes).toBe('number');
      expect(view.votes_by_voter).toEqual(record.votes_by_voter);
    }
  });
});
