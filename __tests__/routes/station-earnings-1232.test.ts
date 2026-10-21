/**
 * backend#1232: GET /api/stations/:id/earnings joins the station's newest chain commits to
 * core4's per-commit reward evidence (GET /transactions/contributions/{id}/reward-evidence).
 * Fixtures follow core4 native-chain routes/transactions.rs RewardEvidenceResponse.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';
import { createStationDetailRouter } from '../../server/routes/station-detail-routes.js';

const H = (n: number) => n.toString(16).padStart(64, '0');
const OWNER = '0xabc0000000000000000000000000000000000001';
const CHAIN_HEIGHT = 500;

type Ev = Record<string, unknown> | 'down' | 'bad';
function rewardedEvidence(commit: string, amount: string, height: number) {
  return {
    commit_id: commit,
    chain: { network_id: 'testnet', chain_id: '777', genesis_hash: 'ab'.repeat(32) },
    contribution: { status: 'finalized' },
    reward: { address: OWNER, amount, reason: 'contribution', station_id: 'station-a', provenance_class: 'real', reward_eligible: true, finalized: true },
    block: { height, hash: 'cd'.repeat(32), timestamp: 1_790_000_000 + height, finalized: true },
    block_search: { scanned_from: 1, scanned_to: CHAIN_HEIGHT, archive_consulted: false, complete: true },
    account: { address: OWNER, balance: amount, earned_balance_total: amount, credit_covers_reward: true },
    rewarded: true,
    rewarded_blocker: null,
  };
}
const pendingEvidence = (commit: string) => ({
  commit_id: commit, reward: null, block: null, account: null, rewarded: false, rewarded_blocker: 'no_reward_record',
});

function core4(commits: number[], evidence: Record<string, Ev>) {
  return jest.fn(async (path: string) => {
    const obs = /^\/transactions\/contributions\/([^/]+)\/observations$/.exec(path);
    if (obs) {
      const items = commits.map((n) => ({
        commit_id: H(n), station_id: decodeURIComponent(obs[1]), height: 459 + n, observed_at: 1_790_000_000 + n,
        values: { temperature_c: 1, humidity_percent: 2, pressure_hpa: 3, wind_speed_ms: null, precipitation_mm: null, dewpoint_c: null },
        provenance_class: 'real', attestation: null,
      }));
      return { ok: true, status: 200, payload: { ok: true, data: {
        items, limit: 100, next_after: CHAIN_HEIGHT, next_offset: 0, has_more: false,
        chain_height: CHAIN_HEIGHT, state_tip: 'ab'.repeat(32), scanned_transactions: items.length,
      } } };
    }
    const ev = /^\/transactions\/contributions\/([0-9a-f]{64})\/reward-evidence$/.exec(path);
    if (ev) {
      const e = evidence[ev[1]];
      if (e === 'down') return { ok: false, status: 503, payload: null };
      if (e === 'bad') return { ok: true, status: 200, payload: { ok: true, data: { nonsense: true } } };
      return e ? { ok: true, status: 200, payload: { ok: true, data: e } } : { ok: false, status: 404, payload: null };
    }
    return { ok: false, status: 404, payload: null };
  });
}

function app(fetchCore4Json: any, opts: { anonymous?: boolean; token?: string | null; now?: () => number } = {}) {
  const db = { execute: jest.fn(async (sql: string) => (/weather_stations/.test(sql) ? { rows: [{ station_id: 'station-a' }] } : { rows: [] })) };
  const a = express();
  a.use('/api', createStationDetailRouter({
    db, fetchCore4Json,
    readerToken: () => (opts.token === undefined ? 'reader-token' : opts.token ?? undefined),
    isAuthenticated: () => !opts.anonymous,
    ...(opts.now ? { now: opts.now } : {}),
  } as any));
  return a;
}
const evidenceCalls = (f: any) => f.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/reward-evidence'));

describe('station earnings from core4 reward evidence (backend#1232)', () => {
  const fields = {
    'earnings[].amountBaseUnits': 'base_units',
    'earnings[].amountWrf': 'display_units',
    'totals.rewardedBaseUnits': 'base_units',
    'totals.rewardedWrf': 'display_units',
  };

  it('declares the source-backed denomination and scale without losing large integer precision', async () => {
    const res = await request(app(core4([1], { [H(1)]: rewardedEvidence(H(1), '9007199254740993', 1) })))
      .get('/api/stations/station-a/earnings');
    expect(res.body.amountUnits).toEqual({ denomination: 'WRF', baseUnitDecimals: 8, baseUnitsPerUnit: '100000000', available: true, fields });
    expect(res.body.earnings[0]).toMatchObject({ amountBaseUnits: '9007199254740993', amountWrf: '90071992.54740993' });
    expect(res.body.totals).toMatchObject({ rewardedBaseUnits: '9007199254740993', rewardedWrf: '90071992.54740993' });
  });

  it('declares known units separately from unavailable Reader data, without payout values', async () => {
    const f = core4([1], {});
    const res = await request(app(f, { token: null })).get('/api/stations/station-a/earnings');
    expect(res.body.amountUnits).toEqual({ denomination: 'WRF', baseUnitDecimals: 8, baseUnitsPerUnit: '100000000', available: false, fields });
    expect(res.body.earnings).toEqual([]);
    expect(res.body.totals).toBeUndefined();
    expect(f).not.toHaveBeenCalled();
  });

  it('marks a partially unknown window unavailable while retaining its proven subtotal', async () => {
    const f = core4([1, 2], { [H(1)]: rewardedEvidence(H(1), '100000000', 1), [H(2)]: 'down' });
    const res = await request(app(f)).get('/api/stations/station-a/earnings');
    expect(res.body.amountUnits).toMatchObject({ denomination: 'WRF', baseUnitDecimals: 8, available: false });
    expect(res.body.totals).toMatchObject({ rewardedBaseUnits: '100000000', unknownCommits: 1 });
    expect(res.body.earnings[0].amountBaseUnits).toBeNull();
    expect(res.body.earnings[1].amountBaseUnits).toBe('100000000');
  });

  it('lists per-commit rewards, sums only PROVEN ones, and keeps pending ones honest', async () => {
    const f = core4([10, 20, 30], {
      [H(30)]: rewardedEvidence(H(30), '150000000', 30),
      [H(20)]: pendingEvidence(H(20)),
      [H(10)]: rewardedEvidence(H(10), '50000000', 10),
    });
    const res = await request(app(f)).get('/api/stations/station-a/earnings');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('core4');
    expect(res.body.earnings.map((e: any) => e.commitId)).toEqual([H(30), H(20), H(10)]); // newest first
    expect(res.body.earnings[0]).toMatchObject({
      rewarded: true, amountBaseUnits: '150000000', amountWrf: '1.5', blocker: null, finalized: true, height: 30,
    });
    expect(res.body.earnings[1]).toMatchObject({
      rewarded: false, amountBaseUnits: null, amountWrf: null, blocker: 'no_reward_record', finalized: false,
    });
    expect(res.body.totals).toMatchObject({ rewardedCommits: 2, unknownCommits: 0, rewardedBaseUnits: '200000000', rewardedWrf: '2' });
    expect(res.body.window).toMatchObject({ commits: 3, scope: 'recent-observations' });
  });

  it('a non-rewarded commit never contributes an amount, even when core4 sends one', async () => {
    const ev = rewardedEvidence(H(1), '999', 1);
    (ev as any).rewarded = false;
    (ev as any).rewarded_blocker = 'reward_not_finalized';
    const res = await request(app(core4([1], { [H(1)]: ev }))).get('/api/stations/station-a/earnings');
    expect(res.body.earnings[0]).toMatchObject({ rewarded: false, amountBaseUnits: null, blocker: 'reward_not_finalized' });
    expect(res.body.totals.rewardedBaseUnits).toBe('0');
  });

  it('a commit whose evidence cannot be read is UNKNOWN, not zero; a malformed body is the same', async () => {
    const res = await request(app(core4([1, 2], { [H(1)]: 'down', [H(2)]: 'bad' }))).get('/api/stations/station-a/earnings');
    expect(res.status).toBe(200);
    expect(res.body.earnings.every((e: any) => e.rewarded === null && e.blocker === 'evidence_unavailable')).toBe(true);
    expect(res.body.totals).toMatchObject({ unknownCommits: 2, rewardedCommits: 0 });
  });

  it('a station with no commits yields an empty window, not a stub', async () => {
    const res = await request(app(core4([], {}))).get('/api/stations/station-a/earnings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ earnings: [], source: 'core4', window: { commits: 0 } });
    expect(res.body.unavailable).toBeUndefined();
  });

  it('no reader credential or core4 down: the honest unavailable shape, no numbers', async () => {
    const none = await request(app(core4([1], {}), { token: null })).get('/api/stations/station-a/earnings');
    expect(none.body).toMatchObject({ earnings: [], source: null, unavailable: ['earnings'] });
    const down = await request(app(jest.fn(async () => ({ ok: false, status: 503, payload: null })))).get('/api/stations/station-a/earnings');
    expect(down.body).toMatchObject({ earnings: [], source: null, unavailable: ['earnings'] });
    expect(none.body.totals).toBeUndefined();
    expect(down.body.totals).toBeUndefined();
    expect(down.body.amountUnits.available).toBe(false);
  });

  it('anonymous callers (alias route) get the projection with no payee address, station id or raw core4 body', async () => {
    const { stationAlias } = await import('../../server/utils/station-alias.js');
    const alias = stationAlias('station-a');
    const f = core4([5], { [H(5)]: rewardedEvidence(H(5), '100000000', 5) });
    const res = await request(app(f, { anonymous: true })).get(`/api/stations/${alias}/earnings`);
    expect(res.status).toBe(200);
    expect(res.body.totals.rewardedWrf).toBe('1');
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain('station-a');
    expect(text).not.toContain('genesis');
    // and a raw station id is refused for anonymous callers
    expect((await request(app(f, { anonymous: true })).get('/api/stations/station-a/earnings')).status).toBe(404);
  });

  it('the payee address and station id are never in an authenticated body either', async () => {
    const f = core4([5], { [H(5)]: rewardedEvidence(H(5), '100000000', 5) });
    const text = JSON.stringify((await request(app(f)).get('/api/stations/station-a/earnings')).body);
    expect(text).not.toContain(OWNER);
    expect(text).not.toContain('station-a');
  });

  it('caps the window (default 10, max 25) and costs O(window) core4 evidence reads, cached on repeat', async () => {
    const nums = Array.from({ length: 40 }, (_, i) => i + 1);
    const ev = Object.fromEntries(nums.map((n) => [H(n), rewardedEvidence(H(n), '1', n)]));
    const f = core4(nums, ev);
    const a = app(f);
    expect((await request(a).get('/api/stations/station-a/earnings')).body.earnings).toHaveLength(10);
    expect(evidenceCalls(f)).toHaveLength(10);
    await request(a).get('/api/stations/station-a/earnings');
    expect(evidenceCalls(f)).toHaveLength(10); // second poll: all cached
    expect((await request(a).get('/api/stations/station-a/earnings?limit=100')).body.earnings).toHaveLength(25);
    expect(evidenceCalls(f)).toHaveLength(25);
  });

  it('pending evidence is re-read after its short TTL; a proven reward is not', async () => {
    let t = 1_000_000;
    const f = core4([1, 2], { [H(1)]: rewardedEvidence(H(1), '1', 1), [H(2)]: pendingEvidence(H(2)) });
    const a = app(f, { now: () => t });
    await request(a).get('/api/stations/station-a/earnings');
    t += 30_000;
    await request(a).get('/api/stations/station-a/earnings');
    const byCommit = (id: string) => evidenceCalls(f).filter((c: any[]) => String(c[0]).includes(id)).length;
    expect(byCommit(H(1))).toBe(1);
    expect(byCommit(H(2))).toBe(2);
  });

  it('sends the Reader bearer to core4 and never the caller\'s credentials', async () => {
    const f = core4([1], { [H(1)]: pendingEvidence(H(1)) });
    await request(app(f)).get('/api/stations/station-a/earnings').set('authorization', 'Bearer caller-jwt');
    const [, options] = evidenceCalls(f)[0] as any[];
    expect(options.headers.authorization).toBe('Bearer reader-token');
  });
});
