/**
 * Reward trail (plan 2026-11-17-reward-trail, slice 1): GET /api/stations/:alias/reward-trail lists each
 * recent reading with the plain stages it has reached (submitted, accepted, eligible, settled, in
 * wallet), derived only from core4's reward-evidence verdict. Owner ruling 2026-11-19: each reading's
 * own reward amount is shown on its eligible and settled steps (never a total, never an address).
 * Fixtures follow core4 native-chain
 * routes/transactions.rs RewardEvidenceResponse / reward_evidence_verdict.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';
import { createStationDetailRouter, rewardTrail } from '../../server/routes/station-detail-routes.js';
import { stationAlias } from '../../server/utils/station-alias.js';

const H = (n: number) => n.toString(16).padStart(64, '0');
const OWNER = '0xabc0000000000000000000000000000000000001';
const STATION_ID = 'station-a-private-name';
const ALIAS: string = (stationAlias as (id: string) => string)(STATION_ID);

const ONE_WRF = { baseUnits: '100000000', wrf: '1' };

function evidence(blocker: string | null, opts: { blockHeight?: number | null; blockFinal?: boolean; amount?: string } = {}) {
  const blockHeight = opts.blockHeight === undefined ? 470 : opts.blockHeight;
  return {
    commit_id: H(1),
    contribution: { status: 'revealed_attested' },
    reward: blocker === 'no_reward_record' ? null : {
      address: OWNER, amount: opts.amount ?? '100000000', reason: 'contribution', station_id: STATION_ID,
      provenance_class: 'real', reward_eligible: true, finalized: true,
    },
    block: blockHeight === null ? null : { height: blockHeight, hash: 'cd'.repeat(32), timestamp: 1_790_000_000, finalized: opts.blockFinal ?? true },
    block_search: { scanned_from: 1, scanned_to: 500, archive_consulted: false, complete: true },
    account: { address: OWNER, balance: '1', earned_balance_total: '100000000', credit_covers_reward: blocker === null },
    rewarded: blocker === null,
    rewarded_blocker: blocker,
  };
}

describe('rewardTrail(): stages from core4 reward evidence', () => {
  it('a fully proven reading is in the wallet, with its heights and its own amount on eligible and settled', () => {
    const t = rewardTrail(460, evidence(null));
    expect(t).toEqual({
      stage: 'in_wallet',
      unknown: false,
      submitted: { state: 'done' },
      accepted: { state: 'done', height: 460 },
      eligible: { state: 'done', amount: ONE_WRF },
      settled: { state: 'done', height: 470, amount: ONE_WRF },
      inWallet: { state: 'done' },
    });
  });

  it('no reward record yet: accepted, eligibility pending, later stages not reached', () => {
    const t = rewardTrail(460, evidence('no_reward_record', { blockHeight: null }));
    expect(t.stage).toBe('accepted');
    expect(t.unknown).toBe(false);
    expect(t.eligible).toEqual({ state: 'pending', reason: 'no_reward_record' });
    expect(t.settled).toEqual({ state: 'not_reached' });
    expect(t.inWallet).toEqual({ state: 'not_reached' });
  });

  it.each(['provenance_not_reward_eligible', 'zero_amount'])('%s: not eligible, says why, stops there', (code) => {
    const t = rewardTrail(460, evidence(code));
    expect(t.stage).toBe('accepted');
    expect(t.eligible).toEqual({ state: 'not_eligible', reason: code }); // no amount on a step that did not count
    expect(t.settled.state).toBe('not_reached');
  });

  it.each([['0'], ['-5'], ['1.5'], ['12345678901234567890123456789012345678901']])('a malformed or zero amount (%s) is not shown, never guessed', (amount) => {
    const t = rewardTrail(460, evidence(null, { amount }));
    expect(t.eligible).toEqual({ state: 'done' });
    expect(t.settled).toEqual({ state: 'done', height: 470 });
  });

  it('an amount core4 marks not reward-eligible is never shown', () => {
    const ev = evidence(null) as any;
    ev.reward.reward_eligible = false;
    expect(rewardTrail(460, ev).eligible).toEqual({ state: 'done' });
  });

  it('reward decided but not finalized: eligible with its amount, settlement pending without one', () => {
    const t = rewardTrail(460, evidence('reward_not_finalized', { blockHeight: null }));
    expect(t.stage).toBe('eligible');
    expect(t.eligible).toEqual({ state: 'done', amount: ONE_WRF });
    expect(t.settled).toEqual({ state: 'pending', reason: 'reward_not_finalized' });
  });

  it('settlement block not final yet: pending, with the block height it is in', () => {
    const t = rewardTrail(460, evidence('block_not_finalized', { blockFinal: false }));
    expect(t.stage).toBe('eligible');
    expect(t.settled).toEqual({ state: 'pending', reason: 'block_not_finalized', height: 470 });
  });

  it.each(['block_not_found_in_scan_window', 'block_scan_incomplete'])('%s: settlement UNKNOWN, never "not paid"', (code) => {
    const t = rewardTrail(460, evidence(code, { blockHeight: null }));
    expect(t.stage).toBe('eligible');
    expect(t.unknown).toBe(true);
    expect(t.settled).toEqual({ state: 'unknown', reason: code });
    expect(t.inWallet.state).toBe('not_reached');
  });

  it.each(['account_missing', 'account_credit_short'])('%s: settled, wallet move UNKNOWN', (code) => {
    const t = rewardTrail(460, evidence(code));
    expect(t.stage).toBe('settled');
    expect(t.unknown).toBe(true);
    expect(t.settled).toEqual({ state: 'done', height: 470, amount: ONE_WRF });
    expect(t.inWallet).toEqual({ state: 'unknown', reason: code });
  });

  it('a failed evidence read is unknown from "eligible" on', () => {
    const t = rewardTrail(460, null);
    expect(t).toMatchObject({ stage: 'accepted', unknown: true, eligible: { state: 'unknown', reason: 'evidence_unavailable' } });
    expect(t.settled.state).toBe('not_reached');
  });

  it('a blocker this backend does not know is unknown, never proven', () => {
    const t = rewardTrail(460, evidence('some_new_core4_leg'));
    expect(t).toMatchObject({ stage: 'accepted', unknown: true, eligible: { state: 'unknown', reason: 'unrecognised_blocker' } });
  });

  it('a missing reading height is unknown, never invented', () => {
    const t = rewardTrail(null, null);
    expect(t.stage).toBe('submitted');
    expect(t.accepted).toEqual({ state: 'unknown', height: null, reason: 'reading_height_unavailable' });
  });
});

function core4(items: Array<{ n: number; height: number }>, ev: Record<string, unknown>) {
  return jest.fn(async (path: string) => {
    if (/\/observations$/.test(path)) {
      return { ok: true, status: 200, payload: { ok: true, data: {
        items: items.map(({ n, height }) => ({
          commit_id: H(n), station_id: STATION_ID, height, observed_at: 1_790_000_000 + n,
          values: { temperature_c: 1 }, provenance_class: 'real', attestation: null,
        })),
        limit: 100, next_after: 500, next_offset: 0, has_more: false, chain_height: 500,
        state_tip: 'ab'.repeat(32), scanned_transactions: items.length,
      } } };
    }
    const m = /^\/transactions\/contributions\/([0-9a-f]{64})\/reward-evidence$/.exec(path);
    if (m && ev[m[1]]) return { ok: true, status: 200, payload: { ok: true, data: ev[m[1]] } };
    return { ok: false, status: 503, payload: null };
  });
}

function anonymousApp(fetchCore4Json: any) {
  const db = {
    execute: jest.fn(async (sql: string) => {
      if (/weather_stations/.test(sql)) return { rows: [{ station_id: STATION_ID, owner_address: OWNER, stations_sharing: 1 }] };
      return { rows: [] };
    }),
  };
  const a = express();
  a.use('/api', createStationDetailRouter({
    db, fetchCore4Json, readerToken: () => 'reader-token', isAuthenticated: () => false,
  } as any));
  return a;
}

describe('GET /api/stations/:alias/reward-trail (anonymous)', () => {
  it('lists the newest readings with their stages and per-reading amounts, and no total, address or raw station id anywhere', async () => {
    const f = core4([{ n: 2, height: 462 }, { n: 1, height: 461 }], {
      [H(2)]: { ...evidence('no_reward_record', { blockHeight: null }), commit_id: H(2) },
      [H(1)]: { ...evidence(null), commit_id: H(1) },
    });
    const res = await request(anonymousApp(f)).get(`/api/stations/${ALIAS}/reward-trail`);
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('core4');
    expect(res.body.window).toEqual({ readings: 2, complete: true, scope: 'recent-observations' });
    expect(res.body.readings.map((r: any) => [r.commitId, r.readingHeight, r.trail.stage])).toEqual([
      [H(2), 462, 'accepted'],
      [H(1), 461, 'in_wallet'],
    ]);
    expect(Object.keys(res.body.readings[1]).sort()).toEqual(['commitId', 'readingHeight', 'trail']);
    expect(Object.keys(res.body).sort()).toEqual(['amountUnits', 'readings', 'source', 'window']);
    // Owner ruling 2026-11-19: the proven reading shows its own amount; the pending one shows none.
    expect(res.body.readings[1].trail.eligible).toEqual({ state: 'done', amount: ONE_WRF });
    expect(res.body.readings[1].trail.settled).toEqual({ state: 'done', height: 470, amount: ONE_WRF });
    expect(JSON.stringify(res.body.readings[0])).not.toContain('amount');
    expect(res.body.amountUnits).toMatchObject({ denomination: 'WRF', baseUnitDecimals: 8, available: true });
    const text = JSON.stringify(res.body).toLowerCase();
    expect(text).not.toContain(STATION_ID);
    expect(text).not.toContain(OWNER.slice(2));
    // Amounts appear only inside a step's `amount` object: never a total, lifetime, rate, balance or address.
    expect(text).not.toMatch(/total|lifetime|rate|balance|address|owner|perday|earned/);
    const amountKeys = JSON.stringify(res.body.readings).match(/"amount"/g) ?? [];
    expect(amountKeys).toHaveLength(2);
    // One tail read plus one evidence read per reading: nothing more.
    expect(f.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/reward-evidence'))).toHaveLength(2);
  });

  it('an unreadable reading still gets a trail that says unknown', async () => {
    const f = core4([{ n: 3, height: 463 }], {});
    const res = await request(anonymousApp(f)).get(`/api/stations/${ALIAS}/reward-trail`);
    expect(res.body.readings[0]).toEqual({
      commitId: H(3), readingHeight: 463,
      trail: expect.objectContaining({ stage: 'accepted', unknown: true, eligible: { state: 'unknown', reason: 'evidence_unavailable' } }),
    });
  });

  it('shares the evidence cache with /earnings: asking both costs no extra node reads', async () => {
    const f = core4([{ n: 4, height: 464 }], { [H(4)]: { ...evidence(null), commit_id: H(4) } });
    const a = anonymousApp(f);
    await request(a).get(`/api/stations/${ALIAS}/earnings`);
    await request(a).get(`/api/stations/${ALIAS}/reward-trail`);
    expect(f.mock.calls.filter((c: any[]) => String(c[0]).endsWith('/reward-evidence'))).toHaveLength(1);
  });

  it('without the reader credential it says unavailable and reads nothing', async () => {
    const f = core4([{ n: 5, height: 465 }], {});
    const db = { execute: jest.fn(async () => ({ rows: [{ station_id: STATION_ID }] })) };
    const a = express();
    a.use('/api', createStationDetailRouter({ db, fetchCore4Json: f, readerToken: () => undefined, isAuthenticated: () => false } as any));
    const res = await request(a).get(`/api/stations/${ALIAS}/reward-trail`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ readings: [], unavailable: ['readings'], source: null });
    expect(f).not.toHaveBeenCalled();
  });

  it('a raw station id is 404 for an anonymous caller', async () => {
    const res = await request(anonymousApp(core4([], {}))).get(`/api/stations/${STATION_ID}/reward-trail`);
    expect(res.status).toBe(404);
  });
});
