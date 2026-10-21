/**
 * Owner ruling 2026-10-03 (S55): the public leaderboard shows REAL WRF amounts.
 * Source: core4 GET /addresses/{address} -> contribution_rewards.real_paid (base-unit
 * decimal string, real-station rewards paid; synthetic and faucet credit excluded).
 * The node has no per-period ledger, so the figure is lifetime and says so. Anything
 * that is not an answer from the node is null, never zero and never an estimate.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';

import { createWeatherLeaderboardRouter } from '../../server/routes/weather-leaderboard-routes.js';

type Row = Record<string, unknown>;

const ALICE = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const BOB = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const CY = '0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';

const rows = (): Row[] => [
  { rank: 1, wallet_address: ALICE, display_name: 'Alice', value: 90, country: 'US', city: 'Chicago' },
  { rank: 2, wallet_address: BOB, display_name: 'Bob', value: 50, country: 'GB', city: 'London' },
  { rank: 3, wallet_address: CY, display_name: 'Cy', value: 20, country: 'DE', city: 'Berlin' },
];

type Reply = { ok: boolean; status: number; payload: any };
const NOT_FOUND: Reply = { ok: false, status: 404, payload: { ok: false, error: { code: 'NOT_FOUND', message: 'address not found' } } };
const ok = (realPaid: string): Reply => ({
  ok: true,
  status: 200,
  payload: { data: { address: 'x', balance: '1', earned_balance_total: '999', contribution_rewards: { real_paid: realPaid, synthetic_paid: '5' } } },
});

function makeApp(replies: Record<string, Reply | Error>, opts: { token?: string | undefined } = { token: 'reader-token' }) {
  const execute = jest.fn(async () => ({ rows: rows() }));
  const calls: Array<{ path: string; headers: any }> = [];
  const fetchCore4Json = jest.fn(async (path: string, options: any = {}) => {
    calls.push({ path, headers: options.headers });
    const addr = decodeURIComponent(path.replace('/addresses/', ''));
    const r = replies[addr];
    if (r instanceof Error) throw r;
    return r ?? { ok: false, status: 503, payload: null };
  });
  const app = express();
  app.use(
    '/api/weather/leaderboard',
    createWeatherLeaderboardRouter({
      db: { execute } as any,
      cache: null,
      rateLimit: null,
      fetchCore4Json: fetchCore4Json as any,
      readerToken: () => opts.token,
    } as any),
  );
  return { app, calls, fetchCore4Json };
}

describe('GET /api/weather/leaderboard real WRF earnings', () => {
  it('adds lifetime real_paid per row in base units and WRF display units', async () => {
    const { app, calls } = makeApp({
      [ALICE]: ok('250000000'),
      [BOB]: ok('50000000'),
      [CY]: NOT_FOUND,
    });
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.status).toBe(200);
    const [a, b, c] = res.body.entries;
    expect(a).toMatchObject({ earningsBaseUnits: '250000000', earningsWrf: '2.5' });
    expect(b).toMatchObject({ earningsBaseUnits: '50000000', earningsWrf: '0.5' });
    // 404 "address not found" = nothing credited: a true zero, not an unknown.
    expect(c).toMatchObject({ earningsBaseUnits: '0', earningsWrf: '0' });
    expect(res.body.earningsScope).toBe('lifetime');
    expect(res.body.amountUnits).toMatchObject({
      denomination: 'WRF',
      baseUnitDecimals: 8,
      available: true,
      fields: { 'entries[].earningsBaseUnits': 'base_units', 'entries[].earningsWrf': 'display_units' },
    });
    expect(res.body.unavailable).toBeUndefined();
    // Reader credential sent to core4, never echoed back.
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.headers.authorization).toBe('Bearer reader-token');
    expect(JSON.stringify(res.body)).not.toContain('reader-token');
  });

  it('never uses synthetic credit or the faucet-inclusive earned total', async () => {
    const { app } = makeApp({ [ALICE]: ok('7'), [BOB]: ok('7'), [CY]: ok('7') });
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    for (const e of res.body.entries) expect(e.earningsBaseUnits).toBe('7');
  });

  it('a failed read is null (never 0) and marks earnings unavailable', async () => {
    const { app } = makeApp({
      [ALICE]: ok('100000000'),
      [BOB]: { ok: false, status: 503, payload: null },
      [CY]: new Error('socket hang up'),
    });
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.status).toBe(200);
    const [a, b, c] = res.body.entries;
    expect(a.earningsBaseUnits).toBe('100000000');
    expect(b).toMatchObject({ earningsBaseUnits: null, earningsWrf: null });
    expect(c).toMatchObject({ earningsBaseUnits: null, earningsWrf: null });
    expect(res.body.amountUnits.available).toBe(false);
    expect(res.body.unavailable).toEqual(['earnings']);
  });

  it('a node answer without contribution_rewards.real_paid is unknown, not zero', async () => {
    const { app } = makeApp({
      [ALICE]: { ok: true, status: 200, payload: { data: { balance: '5' } } },
      [BOB]: ok('1'),
      [CY]: ok('1'),
    });
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.body.entries[0].earningsBaseUnits).toBeNull();
    expect(res.body.amountUnits.available).toBe(false);
  });

  it('rejects a non-numeric real_paid', async () => {
    const { app } = makeApp({ [ALICE]: ok('1.5'), [BOB]: ok('-3'), [CY]: ok('abc') });
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    for (const e of res.body.entries) expect(e.earningsBaseUnits).toBeNull();
  });

  it('without a reader credential makes no core4 call and reports unavailable', async () => {
    const { app, fetchCore4Json } = makeApp({}, { token: undefined });
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.status).toBe(200);
    expect(fetchCore4Json).not.toHaveBeenCalled();
    for (const e of res.body.entries) expect(e.earningsBaseUnits).toBeNull();
    expect(res.body.unavailable).toEqual(['earnings']);
    expect(res.body.amountUnits.available).toBe(false);
  });

  it('does not query core4 for a malformed address', async () => {
    const execute = jest.fn(async () => ({
      rows: [{ rank: 1, wallet_address: 'not-an-address/../x', display_name: 'X', value: 1, country: null, city: null }],
    }));
    const fetchCore4Json = jest.fn();
    const app = express();
    app.use(
      '/api/weather/leaderboard',
      createWeatherLeaderboardRouter({
        db: { execute } as any, cache: null, rateLimit: null, fetchCore4Json: fetchCore4Json as any, readerToken: () => 't',
      } as any),
    );
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(fetchCore4Json).not.toHaveBeenCalled();
    expect(res.body.entries[0].earningsBaseUnits).toBeNull();
  });

  it('keeps every pre-existing field on the row', async () => {
    const { app } = makeApp({ [ALICE]: ok('1'), [BOB]: ok('1'), [CY]: ok('1') });
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.body.entries[0]).toMatchObject({ rank: 1, displayName: 'Alice', value: 90, badgeLevel: 'silver', country: 'US', city: 'Chicago' });
  });

  it('serves a repeat read of the same address from a short cache', async () => {
    const { app, fetchCore4Json } = makeApp({ [ALICE]: ok('1'), [BOB]: ok('1'), [CY]: ok('1') });
    await request(app).get('/api/weather/leaderboard?metric=submissions');
    await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(fetchCore4Json).toHaveBeenCalledTimes(3);
  });
});

// ---------------------------------------------------------------------------
// Node read budget (LEAD standing rule): the leaderboard never fans out node reads per visitor.
// ---------------------------------------------------------------------------
const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;
const manyRows = (n: number, offset = 1): Row[] =>
  Array.from({ length: n }, (_, i) => ({
    rank: i + 1, wallet_address: addr(offset + i), display_name: `W${offset + i}`, value: 10, country: null, city: null,
  }));

function makeBudgetApp(rowsFn: () => Row[], reply: (address: string) => Reply | Error | Promise<Reply>, clock = { t: 1_000_000 }) {
  const execute = jest.fn(async () => ({ rows: rowsFn() }));
  let inFlight = 0;
  let maxInFlight = 0;
  const fetched: string[] = [];
  const fetchCore4Json = jest.fn(async (path: string) => {
    const address = decodeURIComponent(path.replace('/addresses/', ''));
    fetched.push(address);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      const r = await reply(address);
      if (r instanceof Error) throw r;
      return r;
    } finally {
      inFlight -= 1;
    }
  });
  const app = express();
  app.use(
    '/api/weather/leaderboard',
    createWeatherLeaderboardRouter({
      db: { execute } as any, cache: null, rateLimit: null,
      fetchCore4Json: fetchCore4Json as any, readerToken: () => 'reader-token', now: () => clock.t,
    } as any),
  );
  return { app, fetched, fetchCore4Json, clock, stats: () => ({ maxInFlight }) };
}

describe('leaderboard node read budget', () => {
  it('100 concurrent requests for 100 rows on a cold cache make at most 30 node reads, 4 at a time', async () => {
    const { app, fetched, stats } = makeBudgetApp(() => manyRows(100), () => ok('100000000'));
    const responses = await Promise.all(
      Array.from({ length: 100 }, () => request(app).get('/api/weather/leaderboard?metric=submissions&limit=100')),
    );
    expect(fetched.length).toBeLessThanOrEqual(30);
    expect(new Set(fetched).size).toBe(fetched.length); // one read per address, shared by all requests
    expect(stats().maxInFlight).toBeLessThanOrEqual(4);
    for (const res of responses) {
      expect(res.status).toBe(200);
      expect(res.body.entries).toHaveLength(100);
      // rows past the 30th get null, never a read and never 0
      expect(res.body.entries[29].earningsBaseUnits).toBe('100000000');
      for (const e of res.body.entries.slice(30)) expect(e.earningsBaseUnits).toBeNull();
      expect(res.body.amountUnits.available).toBe(false);
      expect(res.body.unavailable).toEqual(['earnings']);
    }
  });

  it('30 rows are fully served by at most 30 shared reads', async () => {
    const { app, fetched } = makeBudgetApp(() => manyRows(30), () => ok('5'));
    const responses = await Promise.all(Array.from({ length: 50 }, () => request(app).get('/api/weather/leaderboard?metric=submissions&limit=30')));
    expect(fetched.length).toBe(30);
    for (const res of responses) {
      expect(res.body.amountUnits.available).toBe(true);
      expect(res.body.unavailable).toBeUndefined();
    }
  });

  it('caps new node reads across different queries inside one window', async () => {
    let offset = 1;
    const { app, fetched } = makeBudgetApp(() => manyRows(20, offset), () => ok('1'));
    for (let i = 0; i < 4; i += 1) {
      await request(app).get('/api/weather/leaderboard?metric=submissions&limit=20');
      offset += 20; // a different set of 20 addresses each time
    }
    expect(fetched.length).toBeLessThanOrEqual(30);
  });

  it('keeps a proven amount for at least five minutes, then reads again', async () => {
    const { app, fetchCore4Json, clock } = makeBudgetApp(() => manyRows(2), () => ok('9'));
    await request(app).get('/api/weather/leaderboard?metric=submissions');
    clock.t += 299_000;
    await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(fetchCore4Json).toHaveBeenCalledTimes(2);
    clock.t += 2_000;
    await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(fetchCore4Json).toHaveBeenCalledTimes(4);
  });

  it('429 is unavailable (null), not retried, and not re-read for at least a minute', async () => {
    const { app, fetchCore4Json, clock } = makeBudgetApp(
      () => manyRows(1),
      () => ({ ok: false, status: 429, payload: { error: { code: 'RATE_LIMITED' } } }),
    );
    const first = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(first.body.entries[0].earningsBaseUnits).toBeNull();
    expect(first.body.amountUnits.available).toBe(false);
    clock.t += 59_000;
    await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(fetchCore4Json).toHaveBeenCalledTimes(1);
    clock.t += 2_000;
    await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(fetchCore4Json).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['401', { ok: false, status: 401, payload: { error: { code: 'UNAUTHORIZED' } } }],
    ['403', { ok: false, status: 403, payload: { error: { code: 'FORBIDDEN' } } }],
    ['500', { ok: false, status: 500, payload: { error: { code: 'INTERNAL' } } }],
    ['503', { ok: false, status: 503, payload: null }],
    // a 404 that is not the node's explicit address-not-found envelope (proxy, wrong route)
    ['bare 404', { ok: false, status: 404, payload: 'Not Found' }],
    ['404 other code', { ok: false, status: 404, payload: { error: { code: 'ROUTE_NOT_FOUND', message: 'no such route' } } }],
  ] as Array<[string, Reply]>)('%s is null, never zero', async (_name, reply) => {
    const { app } = makeBudgetApp(() => manyRows(1), () => reply);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.body.entries[0].earningsBaseUnits).toBeNull();
    expect(res.body.amountUnits.available).toBe(false);
  });

  it('a timeout is null, never zero', async () => {
    const { app } = makeBudgetApp(() => manyRows(1), () => Object.assign(new Error('aborted'), { name: 'AbortError' }));
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.body.entries[0].earningsBaseUnits).toBeNull();
  });

  it('labels the figure as lifetime real-station rewards and says the period only ranks', async () => {
    const { app } = makeBudgetApp(() => manyRows(1), () => ok('1'));
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&period=7d');
    expect(res.body.earningsScope).toBe('lifetime');
    expect(res.body.earningsDescription).toMatch(/lifetime real-station rewards/i);
    expect(res.body.earningsDescription).toMatch(/period.*rank/i);
  });
});
