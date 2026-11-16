/**
 * Per-bond node-pay history: store merge/retention, the recorder pass (settlement reads, the node forgetting
 * PAID epochs, earned_balance_total fallback) and GET /api/network/nodes/bonds/<id>/payout-history.
 * A real-PostgreSQL block runs only when BOND_PAYOUT_HISTORY_TEST_PG_URL names a disposable database.
 */
import { readFileSync } from 'node:fs';
import express from 'express';
import request from 'supertest';
import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  BOND_PAYOUT_RETAIN_EPOCHS, createMemoryBondPayoutStore, createPgBondPayoutStore, mergeObservation,
  type BondPayoutStore, type PayoutRow,
} from '../server/services/bond-payout-history/store';
import {
  observeSettlement, parseSettlement, runBondPayoutHistoryOnce, settleFromEarned, startBondPayoutHistoryRecorder,
  type BondInfo, type NodeGet,
} from '../server/services/bond-payout-history/recorder';
import { bondPayoutHistoryBody, createNetworkNodesRouter } from '../server/routes/network-nodes-routes';

const A = 'a1'.repeat(32);
const B = 'b2'.repeat(32);
const C = 'c3'.repeat(32);
const PAY_A = `0x${'aa'.repeat(20)}`;
const PAY_B = `0x${'bb'.repeat(20)}`;
const bytes = (hex: string) => hex.replace(/^0x/, '').match(/../g)!.map((b) => parseInt(b, 16));

const row = (over: Partial<PayoutRow>): PayoutRow => ({
  bondId: A, epoch: 5, status: 'paid', amount: '100', height: 3000, source: 'settlement',
  payoutAddress: PAY_A, baselineEarned: null, baselineHeight: null, ...over,
});

describe('mergeObservation', () => {
  it('never downgrades a paid row', () => {
    const paid = row({});
    expect(mergeObservation(paid, row({ status: 'unpaid', amount: null }))).toEqual(paid);
    expect(mergeObservation(paid, row({ status: 'pending', amount: '7' }))).toEqual(paid);
  });
  it('lets a settlement read replace an inferred paid amount, and fills gaps', () => {
    const inferred = row({ source: 'earned_total', amount: '100', baselineEarned: '5', baselineHeight: 10 });
    const merged = mergeObservation(inferred, row({ amount: '99' }));
    expect(merged).toMatchObject({ status: 'paid', source: 'settlement', amount: '99', baselineEarned: '5', baselineHeight: 10 });
    expect(mergeObservation(row({ height: null }), row({ height: 42 })).height).toBe(42);
  });
  it('pending becomes paid or unpaid and keeps its first baseline; unpaid only becomes paid', () => {
    const pending = row({ status: 'pending', baselineEarned: '1', baselineHeight: 2 });
    expect(mergeObservation(pending, row({ status: 'pending', baselineEarned: '9', baselineHeight: 9 })))
      .toMatchObject({ status: 'pending', baselineEarned: '1', baselineHeight: 2 });
    expect(mergeObservation(pending, row({}))).toMatchObject({ status: 'paid', baselineEarned: '1' });
    expect(mergeObservation(pending, row({ status: 'unpaid', amount: null }))).toMatchObject({ status: 'unpaid', amount: null });
    const unpaid = row({ status: 'unpaid', amount: null });
    expect(mergeObservation(unpaid, row({ status: 'pending' }))).toMatchObject({ status: 'unpaid' });
    expect(mergeObservation(unpaid, row({}))).toMatchObject({ status: 'paid', amount: '100' });
  });
});

describe('memory store', () => {
  it('upserts idempotently and prunes beyond the retention window and ahead of the tip', async () => {
    const store = createMemoryBondPayoutStore();
    expect(await store.record([row({ epoch: 1 }), row({ epoch: 2 })])).toBe(2);
    expect(await store.record([row({ epoch: 1 }), row({ epoch: 2 })])).toBe(0);
    expect(await store.record([row({ epoch: 1, status: 'unpaid', amount: null })])).toBe(0);
    expect((await store.history(A, 0, 10)).map((r) => r.status)).toEqual(['paid', 'paid']);
    for (let e = 0; e <= 60; e += 1) await store.record([row({ epoch: e })]);
    expect(BOND_PAYOUT_RETAIN_EPOCHS).toBeGreaterThanOrEqual(30);
    expect(await store.prune(50, BOND_PAYOUT_RETAIN_EPOCHS)).toBe(10 + 10); // 0..9 old, 51..60 ahead
    const left = await store.history(A, 0, 100);
    expect(left[0].epoch).toBe(10);
    expect(left[left.length - 1].epoch).toBe(50);
  });
});

describe('observeSettlement / settleFromEarned', () => {
  const bonds = new Map<string, BondInfo | null>([
    [A, { registeredEpoch: 1, payoutAddress: PAY_A }],
    [B, { registeredEpoch: 1, payoutAddress: PAY_B }],
    [C, { registeredEpoch: 5, payoutAddress: null }], // registered in epoch 5: no claim about epoch 5
  ]);
  const s = (status: string, maps: Record<string, unknown> = {}) =>
    parseSettlement(5, { epoch: '5', status, maturity_height: '3700', ...maps })!;

  it('PAID: listed bonds paid, other registered bonds unpaid', () => {
    const out = observeSettlement(s('PAID', { payouts_base_units: { [A.toUpperCase()]: '100' }, provisional_base_units: { [A]: '100', [B]: '100' } }), bonds, () => null);
    expect(out).toEqual([
      expect.objectContaining({ bondId: A, status: 'paid', amount: '100', height: 3700, source: 'settlement', payoutAddress: PAY_A }),
      expect.objectContaining({ bondId: B, status: 'unpaid', amount: null }),
    ]);
  });
  it('PROVISIONAL: split members pending with a baseline; the rest unpaid; UNISSUED: unpaid; OPEN/UNKNOWN: nothing', () => {
    const out = observeSettlement(s('PROVISIONAL', { provisional_base_units: { [A]: '100' } }), bonds, () => ({ earned: '500', height: 3200 }));
    expect(out).toEqual([
      expect.objectContaining({ bondId: A, status: 'pending', amount: '100', baselineEarned: '500', baselineHeight: 3200 }),
      expect.objectContaining({ bondId: B, status: 'unpaid' }),
    ]);
    expect(observeSettlement(s('UNISSUED'), bonds, () => null).map((r) => [r.bondId, r.status])).toEqual([[A, 'unpaid'], [B, 'unpaid']]);
    expect(observeSettlement(s('OPEN'), bonds, () => null)).toEqual([]);
    expect(observeSettlement(s('UNKNOWN'), bonds, () => null)).toEqual([]);
    expect(parseSettlement(5, { epoch: '6', status: 'PAID' })).toBeNull();
  });
  it('settles matured pending rows only when the earned total covers them and payouts already recorded', () => {
    const p1 = row({ epoch: 5, status: 'pending', amount: '100', height: 3700, baselineEarned: '1000', baselineHeight: 3200 });
    const p2 = row({ epoch: 6, status: 'pending', amount: '100', height: 4200, baselineEarned: '1100', baselineHeight: 3700 });
    const already = [row({ bondId: B, epoch: 4, amount: '50', height: 3300 })];
    expect(settleFromEarned([p1, p2], new Map([[PAY_A, '1249']]), new Map([[PAY_A, already]]))).toEqual([]);
    expect(settleFromEarned([p1, p2], new Map([[PAY_A, '1250']]), new Map([[PAY_A, already]])).map((r) => [r.epoch, r.status, r.source]))
      .toEqual([[5, 'paid', 'earned_total'], [6, 'paid', 'earned_total']]);
    expect(settleFromEarned([p1], new Map(), new Map())).toEqual([]);
  });
});

/** A fake node whose settlement records change over time like core4's (PROVISIONAL -> PAID -> pruned). */
function fakeNode() {
  const state = {
    epoch: 10, height: 5200,
    settlements: new Map<number, Record<string, unknown>>(),
    earned: new Map<string, string>([[PAY_A, '1000'], [PAY_B, '2000']]),
    reads: [] as string[],
  };
  const get: NodeGet = async (path) => {
    state.reads.push(path);
    let m;
    if ((m = /^\/node\/bonds\/([0-9a-f]{64})$/.exec(path))) {
      const id = m[1];
      const known = id === A || id === B;
      return { height: String(state.height), epoch: String(state.epoch), deployment_id: id, status: known ? 'REGISTERED' : 'UNKNOWN',
        registration: known ? { registered_epoch: 2, binding: { payout_account: bytes(id === A ? PAY_A : PAY_B) } } : null };
    }
    if ((m = /^\/node\/settlement\/(\d+)$/.exec(path))) {
      const e = Number(m[1]);
      return state.settlements.get(e) ?? { epoch: String(e), status: 'UNKNOWN', payouts_base_units: null };
    }
    if ((m = /^\/addresses\/(0x[0-9a-f]{40})$/.exec(path))) return { address: m[1], earned_balance_total: state.earned.get(m[1]) ?? '0' };
    return null;
  };
  return { state, get };
}

describe('runBondPayoutHistoryOnce', () => {
  it('keeps a PAID epoch after the node forgets it, and is idempotent', async () => {
    const store = createMemoryBondPayoutStore();
    const node = fakeNode();
    node.state.settlements.set(9, { epoch: '9', status: 'PROVISIONAL', maturity_height: '6000', provisional_base_units: { [A]: '100', [B]: '100' }, payouts_base_units: {} });
    node.state.settlements.set(8, { epoch: '8', status: 'PAID', maturity_height: '5100', provisional_base_units: { [A]: '100', [B]: '100' }, payouts_base_units: { [A]: '100' } });
    const first = await runBondPayoutHistoryOnce({ store, get: node.get, configured: [] });
    expect(first).toMatchObject({ status: 'ok', tipEpoch: 10, settlementsRead: 8, bonds: 2 });
    expect(node.state.reads.filter((p) => p.startsWith('/node/settlement/'))).toHaveLength(8);
    expect(node.state.reads).not.toContain('/node/settlement/10'); // the open epoch is never read
    const hist = async (id: string) => (await store.history(id, 0, 20)).map((r) => [r.epoch, r.status, r.amount]);
    expect(await hist(A)).toEqual([[8, 'paid', '100'], [9, 'pending', '100']]);
    expect(await hist(B)).toEqual([[8, 'unpaid', null], [9, 'pending', '100']]);
    expect((await store.history(A, 9, 9))[0]).toMatchObject({ baselineEarned: '1000', baselineHeight: 5200, payoutAddress: PAY_A });
    expect((await runBondPayoutHistoryOnce({ store, get: node.get, configured: [] })).changed).toBe(0);

    // Epoch 9 is paid at 6000 and the node immediately forgets it (UNKNOWN), 8 too.
    node.state.settlements.clear();
    node.state.epoch = 11; node.state.height = 6100;
    node.state.earned.set(PAY_A, '1100'); // A was paid 100; B's total did not move (B was jailed)
    const third = await runBondPayoutHistoryOnce({ store, get: node.get, configured: [] });
    expect(third.settledFromEarned).toBe(1);
    expect(await hist(A)).toEqual([[8, 'paid', '100'], [9, 'paid', '100']]);
    expect((await store.history(A, 9, 9))[0].source).toBe('earned_total');
    expect(await hist(B)).toEqual([[8, 'unpaid', null], [9, 'pending', '100']]); // stays unconfirmed, never guessed unpaid
  });

  it('records nothing when the node cannot be read', async () => {
    const store = createMemoryBondPayoutStore();
    expect(await runBondPayoutHistoryOnce({ store, get: async () => null })).toMatchObject({ status: 'unavailable', tipEpoch: null });
    expect(await store.tip()).toBeNull();
  });

  it('does not start without its flag', async () => {
    expect(await startBondPayoutHistoryRecorder({ env: {} })).toBe(false);
    expect(await startBondPayoutHistoryRecorder({ env: { BOND_PAYOUT_HISTORY_ENABLED: 'true' } })).toBe(false); // no reader token
  });
});

describe('bondPayoutHistoryBody', () => {
  it('counts 27 paid of the last 30 closed epochs; unknown and pending are null, not unpaid', () => {
    const rows: PayoutRow[] = [];
    for (let e = 10; e <= 39; e += 1) {
      if (e === 12 || e === 20) rows.push(row({ epoch: e, status: 'unpaid', amount: null }));
      else if (e === 25) continue; // never observed
      else if (e === 39) rows.push(row({ epoch: e, status: 'pending', height: 99_999 }));
      else if (e === 38) rows.push(row({ epoch: e, status: 'pending', height: 100 })); // matured, unconfirmed
      else rows.push(row({ epoch: e, height: 1000 + e }));
    }
    rows.push(row({ epoch: 9 })); // outside the window
    const body = bondPayoutHistoryBody(A, 30, { tipEpoch: 40, tipHeight: 20_000, observedAt: '2026-11-16T00:00:00Z' }, rows);
    expect(body).toMatchObject({ bond_id: A, window: 30, tip_epoch: 40, first_epoch: 10, last_epoch: 39, paid_count: 25, known_count: 27 });
    expect(body.epochs).toHaveLength(30);
    expect(body.epochs[0]).toEqual({ epoch: 10, status: 'paid', paid: true, amount: '100', height: 1010, source: 'settlement' });
    expect(body.epochs[2]).toEqual({ epoch: 12, status: 'unpaid', paid: false, amount: null, height: 3000, source: 'settlement' });
    expect(body.epochs[15]).toEqual({ epoch: 25, status: 'unknown', paid: null, amount: null, height: null, source: null });
    expect(body.epochs[28]).toMatchObject({ epoch: 38, status: 'unknown', paid: null });
    expect(body.epochs[29]).toMatchObject({ epoch: 39, status: 'pending', paid: null, amount: '100' });
  });
  it('clamps at epoch 0 and is empty before the first closed epoch', () => {
    expect(bondPayoutHistoryBody(A, 30, { tipEpoch: 3, tipHeight: 1, observedAt: 'x' }, [])).toMatchObject({ first_epoch: 0, last_epoch: 2, known_count: 0 });
    expect(bondPayoutHistoryBody(A, 30, { tipEpoch: 0, tipHeight: 1, observedAt: 'x' }, [])).toMatchObject({ first_epoch: null, last_epoch: null, epochs: [] });
  });
});

describe('GET /api/network/nodes/bonds/:bondId/payout-history', () => {
  const saved = process.env.BOND_PAYOUT_HISTORY_ENABLED;
  let store: BondPayoutStore & { rows: Map<string, PayoutRow> };
  let limited = 0;
  beforeEach(() => {
    process.env.BOND_PAYOUT_HISTORY_ENABLED = 'true';
    store = createMemoryBondPayoutStore();
    limited = 0;
  });
  afterAll(() => {
    if (saved === undefined) delete process.env.BOND_PAYOUT_HISTORY_ENABLED;
    else process.env.BOND_PAYOUT_HISTORY_ENABLED = saved;
  });
  const app = (over: { failing?: boolean } = {}) => {
    const a = express();
    a.use('/api/network', createNetworkNodesRouter({
      payoutStore: async () => (over.failing ? { ...store, tip: async () => { throw new Error('db down'); } } : store),
      payoutHistoryRateLimit: (_q, _s, next) => { limited += 1; next(); },
    }));
    return a;
  };
  const url = (id: string, q = '') => `/api/network/nodes/bonds/${id}/payout-history${q}`;

  it('is 404 when its flag is off (independent of the nodes read flag)', async () => {
    process.env.BOND_PAYOUT_HISTORY_ENABLED = 'false';
    const r = await request(app()).get(url(A));
    expect(r.status).toBe(404);
    expect(limited).toBe(0);
  });

  it('rejects malformed ids and query parameters', async () => {
    await store.setTip(5, 100);
    for (const bad of [A.toUpperCase(), A.slice(2), `${A}00`, `0x${A.slice(2)}`, 'zz'.repeat(32)]) {
      const r = await request(app()).get(url(bad));
      expect(r.status).toBe(400);
      expect(r.body.error.code).toBe('VALIDATION_ERROR');
    }
    for (const q of ['?window=0', '?window=41', '?window=abc', '?window=1.5', '?window=030', '?window=3&window=4', '?other=1']) {
      expect((await request(app()).get(url(A, q))).status).toBe(400);
    }
    expect(limited).toBeGreaterThan(0);
  });

  it('is 503 before the first recorder pass or when the store fails', async () => {
    expect((await request(app()).get(url(A))).body.error.code).toBe('BOND_PAYOUT_HISTORY_NOT_READY');
    const r = await request(app({ failing: true })).get(url(A));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('BOND_PAYOUT_HISTORY_UNAVAILABLE');
  });

  it('serves the window from the store', async () => {
    await store.setTip(6, 4000);
    await store.record([row({ epoch: 3 }), row({ epoch: 4, status: 'unpaid', amount: null }), row({ bondId: B, epoch: 5 })]);
    const r = await request(app()).get(url(A, '?window=4'));
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('public, max-age=60');
    expect(r.body).toEqual({
      bond_id: A, window: 4, tip_epoch: 6, first_epoch: 2, last_epoch: 5,
      epochs: [
        { epoch: 2, status: 'unknown', paid: null, amount: null, height: null, source: null },
        { epoch: 3, status: 'paid', paid: true, amount: '100', height: 3000, source: 'settlement' },
        { epoch: 4, status: 'unpaid', paid: false, amount: null, height: 3000, source: 'settlement' },
        { epoch: 5, status: 'unknown', paid: null, amount: null, height: null, source: null },
      ],
      paid_count: 1, known_count: 2, observed_at: expect.any(String),
    });
    expect((await request(app()).get(url(A))).body.window).toBe(30);
  });
});

const PG_URL = process.env.BOND_PAYOUT_HISTORY_TEST_PG_URL;
(PG_URL ? describe : describe.skip)('PostgreSQL store (migration 0047)', () => {
  const schema = `bond_payout_history_${process.pid}`;
  let admin: pg.Client;
  let pool: pg.Pool;
  let pgStore: BondPayoutStore;
  beforeAll(async () => {
    admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new pg.Pool({ connectionString: PG_URL, max: 3, options: `-c search_path=${schema}` });
    for (const stmt of readFileSync('drizzle/migrations/0047_bond_payout_history.sql', 'utf8').split('--> statement-breakpoint')) {
      await pool.query(stmt);
    }
    pgStore = createPgBondPayoutStore(pool as any);
  });
  afterEach(async () => { await pool.query('TRUNCATE bond_payout_history, bond_payout_history_state'); });
  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin?.end();
  });

  it('merges, reads back, prunes and tracks the tip', async () => {
    expect(await pgStore.tip()).toBeNull();
    await pgStore.setTip(12, 6000);
    await pgStore.setTip(13, 6500);
    expect(await pgStore.tip()).toMatchObject({ tipEpoch: 13, tipHeight: 6500, observedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/) });
    const big = '123456789012345678901234567890123456789';
    expect(await pgStore.record([row({ epoch: 1, status: 'pending', amount: big, baselineEarned: '7', baselineHeight: 9 }), row({ epoch: 2 })])).toBe(2);
    expect(await pgStore.record([row({ epoch: 2, status: 'unpaid', amount: null })])).toBe(0);
    expect(await pgStore.record([row({ epoch: 1, status: 'paid', amount: big })])).toBe(1);
    const h = await pgStore.history(A, 0, 10);
    expect(h).toEqual([
      row({ epoch: 1, amount: big, baselineEarned: '7', baselineHeight: 9 }),
      row({ epoch: 2 }),
    ]);
    await pgStore.record([row({ bondId: B, epoch: 3, status: 'pending', height: 100, baselineEarned: '1', baselineHeight: 50, payoutAddress: PAY_B })]);
    expect((await pgStore.maturedPending(100, 10)).map((r) => r.bondId)).toEqual([B]);
    expect(await pgStore.maturedPending(99, 10)).toEqual([]);
    expect((await pgStore.paidSince(PAY_A, 2999, 3000)).map((r) => r.epoch)).toEqual([1, 2]);
    expect(new Set(await pgStore.knownBondIds(10))).toEqual(new Set([A, B]));
    expect(await pgStore.prune(42, 40)).toBe(1); // epoch 1 < 42 - 40
    await expect(pool.query(`INSERT INTO bond_payout_history (bond_id, epoch, status, source) VALUES ('${A.toUpperCase()}', 1, 'paid', 'settlement')`)).rejects.toThrow();
  });

  it('serialises concurrent writers without losing a paid row', async () => {
    await Promise.all([
      pgStore.record([row({ epoch: 4, status: 'pending' })]),
      pgStore.record([row({ epoch: 4 })]),
      pgStore.record([row({ epoch: 4, status: 'unpaid', amount: null })]),
    ]);
    // Every order of these three observations ends paid (paid is never downgraded; pending/unpaid upgrade).
    expect((await pgStore.history(A, 4, 4))[0].status).toBe('paid');
  });
});
