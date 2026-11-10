/**
 * Advisory governance relay (website propose/vote, 12-word and passkey wallets):
 * POST /governance/advisory/actions wraps a browser-signed SignedAdvisoryAction exactly as the core4
 * CLI does and relays it to the node; GET .../accounts/:address/nonce and .../proposals/:id/eligibility
 * are the two reads the signer needs. Dormant unless ADVISORY_GOVERNANCE_RELAY_ENABLED=true.
 *
 * The transaction builder is pinned by contract-fixtures/advisory-governance-relay-vectors.json, which
 * core4 itself wrote (ed25519 and passkey; propose and vote). Only the network call is faked.
 */
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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
import {
  buildAdvisoryTransaction,
  ed25519Address,
  parseSignedAdvisoryAction,
  passkeyAddress,
  textProblem,
} from '../server/utils/advisory-governance-relay.js';

const mockFetchCore4 = fetchCore4Json as jest.Mock;

interface VectorCase {
  name: string;
  submitted_at: number;
  account: string;
  signed: Record<string, any>;
  data: string;
  tx_id_hex: string;
  transaction: Record<string, any>;
}
const vectors: { cases: VectorCase[] } = JSON.parse(
  readFileSync(join(__dirname, '..', 'contract-fixtures', 'advisory-governance-relay-vectors.json'), 'utf8'),
);
const byName = (name: string) => vectors.cases.find((c) => c.name === name)!;
/** The browser sends serde member order (account, action, nonce, then the authorization). */
const browserBody = (c: VectorCase) => JSON.parse(c.data);

describe('advisory relay contract (pinned by core4 vectors)', () => {
  it.each(vectors.cases.map((c) => [c.name, c]))('%s: parses and rebuilds the CLI transaction byte for byte', (_name, c) => {
    const parsed = parseSignedAdvisoryAction(browserBody(c));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.account).toBe(c.account);
    expect(parsed.signer).toBe(c.name.startsWith('passkey') ? 'passkey' : 'ed25519');
    const built = buildAdvisoryTransaction(parsed.value, c.submitted_at);
    expect(built.body.data).toBe(c.data);
    expect(built.txId).toBe(c.tx_id_hex);
    expect(built.body).toEqual(c.transaction);
  });

  it('derives ed25519 and passkey addresses as core4 does', () => {
    const ed = byName('ed25519_propose');
    expect(ed25519Address(ed.signed.public_key)).toBe(ed.account);
    const pk = byName('passkey_vote');
    expect(passkeyAddress(pk.signed.passkey.rp_id_hash, pk.signed.passkey.public_key_p256)).toBe(pk.account);
  });

  it('refuses every shape that is not exactly one signed advisory action', () => {
    const ed = browserBody(byName('ed25519_propose'));
    const pk = browserBody(byName('passkey_propose'));
    const refuse = (body: unknown, re: RegExp) => {
      const r = parseSignedAdvisoryAction(body);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.message).toMatch(re);
    };
    refuse(null, /JSON body/);
    // Any other transaction type or a whole transaction: unknown members.
    refuse({ ...ed, tx_type: 'Transfer' }, /unknown member/);
    refuse({ ...ed, parameter: 'emission_rate' }, /unknown member/);
    refuse({ ...ed, action: { transfer: { to: 'x', amount: 1 } } }, /propose or vote/);
    refuse({ ...ed, action: { propose: { title: 'a', summary: 'b', value: '0' } } }, /title and summary only/);
    refuse({ ...ed, action: { propose: { title: 'a' }, vote: {} } }, /exactly one/);
    // Both forms, or neither.
    refuse({ ...ed, passkey: pk.passkey }, /exactly one of/);
    const { public_key: _p, signature: _s, ...neither } = ed;
    refuse(neither, /exactly one of/);
    // The key must derive the account (a relayer cannot make a victim pay).
    refuse({ ...ed, account: pk.account }, /does not derive/);
    refuse({ ...pk, account: ed.account }, /does not derive/);
    refuse({ ...pk, passkey: { ...pk.passkey, origin: 'https://evil.example' } }, /unknown member/);
    refuse({ ...pk, passkey: { ...pk.passkey, rp_id_hash: 'zz' } }, /rp_id_hash/);
    refuse({ ...ed, signature: 'ab' }, /signature/);
    // One encoding per action (core4#146): no null passkey, no empty members, no uppercase hex.
    refuse({ ...ed, passkey: null }, /not null/);
    refuse({ ...pk, public_key: '' }, /non-empty/);
    refuse({ ...pk, signature: '' }, /non-empty/);
    refuse({ ...ed, public_key: ed.public_key.toUpperCase() }, /lowercase/);
    refuse({ ...ed, signature: ed.signature.toUpperCase() }, /lowercase/);
    for (const field of ['public_key_p256', 'rp_id_hash', 'authenticator_data', 'client_data_json', 'signature']) {
      refuse({ ...pk, passkey: { ...pk.passkey, [field]: pk.passkey[field].toUpperCase() } }, new RegExp(`passkey\\.${field}`));
    }
    refuse({ ...ed, nonce: -1 }, /nonce/);
    refuse({ ...ed, nonce: 2 ** 53 }, /nonce/);
    refuse({ ...ed, account: [1, 2, 3] }, /20-byte/);
    refuse({ ...ed, action: { vote: { proposal_id: 'LAW-001', approve: true } } }, /advisory id/);
    refuse({ ...ed, action: { vote: { proposal_id: 'adv-0123456789abcdef', approve: 'yes' } } }, /approve/);
  });

  it('applies core4 text rules (bytes, controls, bidi)', () => {
    expect(textProblem('title', 'a'.repeat(160))).toBeNull();
    expect(textProblem('title', 'a'.repeat(161))).toMatch(/161 bytes/);
    expect(textProblem('title', '€'.repeat(54))).toMatch(/162 bytes/);
    expect(textProblem('title', '   ')).toMatch(/empty/);
    expect(textProblem('title', 'one\ntwo')).toMatch(/U\+000A/);
    expect(textProblem('summary', 'one\ntwo')).toBeNull();
    expect(textProblem('summary', 'a‮b')).toMatch(/U\+202E/);
    expect(textProblem('summary', 'a\u0085b')).toMatch(/U\+0085/);
    expect(textProblem('title', 'Café, 東京, 🌧')).toBeNull();
    expect(textProblem('title', 'a\uD800b')).toMatch(/Unicode/);
  });
});

describe('advisory relay routes', () => {
  let app: express.Express;
  const saved: Record<string, string | undefined> = {};

  beforeAll(async () => {
    const mod = await import('../server/routes/governance-routes.js');
    app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use('/governance', mod.default);
  });
  beforeEach(() => {
    for (const k of ['ADVISORY_GOVERNANCE_RELAY_ENABLED', 'WRFCOIN_CONTRIBUTOR_TOKEN', 'WRFCOIN_READER_TOKEN']) saved[k] = process.env[k];
    process.env.ADVISORY_GOVERNANCE_RELAY_ENABLED = 'true';
    process.env.WRFCOIN_CONTRIBUTOR_TOKEN = 'test-contributor';
    process.env.WRFCOIN_READER_TOKEN = 'test-reader';
    mockFetchCore4.mockReset();
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('is 404 on all three paths while the flag is off, and never calls the node', async () => {
    process.env.ADVISORY_GOVERNANCE_RELAY_ENABLED = 'false';
    const body = browserBody(byName('passkey_vote'));
    expect((await request(app).post('/governance/advisory/actions').send(body)).status).toBe(404);
    expect((await request(app).get(`/governance/advisory/accounts/${byName('passkey_vote').account}/nonce`)).status).toBe(404);
    expect((await request(app).get('/governance/advisory/proposals/adv-0123456789abcdef/eligibility?address=0x' + 'ab'.repeat(20))).status).toBe(404);
    delete process.env.ADVISORY_GOVERNANCE_RELAY_ENABLED;
    expect((await request(app).post('/governance/advisory/actions').send(body)).status).toBe(404);
    expect(mockFetchCore4).not.toHaveBeenCalled();
  });

  it.each([['ed25519_propose'], ['passkey_vote']])('%s: relays a CLI-shaped AdvisoryGovernance transaction with the Contributor bearer', async (name) => {
    const c = byName(name);
    mockFetchCore4.mockResolvedValue({ ok: true, status: 202, payload: { ok: true, data: { tx_id: 'ff'.repeat(32), proposal_id: 'adv-0123456789abcdef', admitted: true, included: false } } });
    const res = await request(app).post('/governance/advisory/actions').send(browserBody(c));
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({ success: true, txId: 'ff'.repeat(32), proposalId: 'adv-0123456789abcdef', account: c.account, status: 'submitted', included: false });
    expect(mockFetchCore4).toHaveBeenCalledTimes(1);
    const [path, opts] = mockFetchCore4.mock.calls[0];
    expect(path).toBe('/governance/advisory/submit');
    expect(opts.method).toBe('POST');
    expect(opts.headers.authorization).toBe('Bearer test-contributor');
    expect(opts.body.tx_type).toBe('AdvisoryGovernance');
    expect(opts.body.data).toBe(c.data);
    expect(opts.body.nonce).toBe(c.signed.nonce);
    expect(opts.body.inputs[0].public_key).toBe(c.transaction.inputs[0].public_key);
  });

  it('refuses a malformed body with 400 and never calls the node', async () => {
    const body = { ...browserBody(byName('ed25519_vote')), tx_type: 'Transfer' };
    const res = await request(app).post('/governance/advisory/actions').send(body);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(mockFetchCore4).not.toHaveBeenCalled();
  });

  it('answers 503 when the Contributor credential is unset', async () => {
    delete process.env.WRFCOIN_CONTRIBUTOR_TOKEN;
    const res = await request(app).post('/governance/advisory/actions').send(browserBody(byName('ed25519_vote')));
    expect(res.status).toBe(503);
    expect(mockFetchCore4).not.toHaveBeenCalled();
  });

  it('passes node merit refusals through and hides node auth/5xx state behind a 502', async () => {
    const body = browserBody(byName('ed25519_vote'));
    mockFetchCore4.mockResolvedValueOnce({ ok: false, status: 503, payload: { ok: false, error: { code: 'FEATURE_NOT_ACTIVE', message: 'advisory_governance is not active at the next height' } } });
    let res = await request(app).post('/governance/advisory/actions').send(body);
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('FEATURE_NOT_ACTIVE');
    mockFetchCore4.mockResolvedValueOnce({ ok: false, status: 422, payload: { ok: false, error: { code: 'ADVISORY_GOVERNANCE_REFUSED', message: 'wallet already voted' } } });
    res = await request(app).post('/governance/advisory/actions').send(body);
    expect(res.status).toBe(422);
    expect(res.body.error.message).toBe('wallet already voted');
    for (const status of [401, 403, 429, 500]) {
      mockFetchCore4.mockResolvedValueOnce({ ok: false, status, payload: { ok: false, error: { code: 'X', message: 'internal' } } });
      res = await request(app).post('/governance/advisory/actions').send(body);
      expect(res.status).toBe(502);
      expect(res.body.error.code).toBe('UPSTREAM_ERROR');
    }
  });

  it('reads the account nonce with the Reader bearer (0 for an unknown account)', async () => {
    const address = byName('passkey_vote').account;
    mockFetchCore4.mockResolvedValueOnce({ ok: true, status: 200, payload: { ok: true, data: { address, nonce: 4 } } });
    let res = await request(app).get(`/governance/advisory/accounts/${address.toUpperCase().replace('0X', '0x')}/nonce`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, address, nonce: 4 });
    expect(mockFetchCore4.mock.calls[0][0]).toBe(`/addresses/${address}`);
    expect(mockFetchCore4.mock.calls[0][1].headers.authorization).toBe('Bearer test-reader');
    mockFetchCore4.mockResolvedValueOnce({ ok: false, status: 404, payload: {} });
    res = await request(app).get(`/governance/advisory/accounts/${address}/nonce`);
    expect(res.body.nonce).toBe(0);
    res = await request(app).get('/governance/advisory/accounts/not-an-address/nonce');
    expect(res.status).toBe(400);
  });

  it('maps the node eligibility read', async () => {
    const address = byName('ed25519_vote').account;
    mockFetchCore4.mockResolvedValueOnce({
      ok: true, status: 200,
      payload: { ok: true, data: { proposal_id: 'adv-0123456789abcdef', address, observed_at_height: 99, voting_open: true, eligible: true, voted: null, can_vote: true, reason: null, next_nonce: 7 } },
    });
    const res = await request(app).get(`/governance/advisory/proposals/adv-0123456789abcdef/eligibility?address=${address}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ canVote: true, eligible: true, votingOpen: true, voted: null, nextNonce: 7 });
    expect(mockFetchCore4.mock.calls[0]).toEqual(['/governance/advisory/proposals/adv-0123456789abcdef/eligibility', { query: { address } }]);
    expect((await request(app).get('/governance/advisory/proposals/LAW-1/eligibility?address=' + address)).status).toBe(400);
    expect((await request(app).get('/governance/advisory/proposals/adv-0123456789abcdef/eligibility?address=x')).status).toBe(400);
  });
});
