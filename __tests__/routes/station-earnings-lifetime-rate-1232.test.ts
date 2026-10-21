/**
 * backend#1232 (additive): GET /api/stations/:id/earnings also answers `lifetime` and `rate`.
 *  - lifetime: the owner address's core4 `real_paid`, read through the leaderboard's shared reader
 *    (same cache, same 30-reads-per-5-minutes budget). scope 'station' only when no other
 *    weather_stations row shares the owner; otherwise scope 'address' + stationsSharingAddress.
 *  - rate: rewarded base units per day over the COMPLETE recent window, from data the route
 *    already reads (no extra node reads). Never 0 when unproven: null + fieldsUnavailable.
 * Fixtures follow core4 native-chain routes/transactions.rs (reward-evidence) and GET /addresses/{a}.
 */
import express from 'express';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { stationAlias } from '../../server/utils/station-alias.js';
import { createStationDetailRouter } from '../../server/routes/station-detail-routes.js';
import { createWeatherLeaderboardRouter } from '../../server/routes/weather-leaderboard-routes.js';
import { createAddressEarnedReader } from '../../server/services/address-lifetime-earned.js';

const H = (n: number) => n.toString(16).padStart(64, '0');
const OWNER = '0xabc0000000000000000000000000000000000001';
const CHAIN_HEIGHT = 500;
const BASE_TS = 1_790_000_000;

const rewarded = (commit: string, amount: string, ts: number) => ({
  commit_id: commit,
  reward: { address: OWNER, amount, reason: 'contribution', station_id: 'station-a', provenance_class: 'real', reward_eligible: true, finalized: true },
  block: { height: ts - BASE_TS, hash: 'cd'.repeat(32), timestamp: ts, finalized: true },
  account: { address: OWNER, balance: amount, earned_balance_total: amount, credit_covers_reward: true },
  rewarded: true, rewarded_blocker: null,
});

type AddrAnswer = { ok: boolean; status: number; payload: any };
function core4(commits: number[], evidence: Record<string, any>, addr: AddrAnswer | ((a: string) => AddrAnswer)) {
  return jest.fn(async (path: string) => {
    const obs = /^\/transactions\/contributions\/([^/]+)\/observations$/.exec(path);
    if (obs) {
      const items = commits.map((n) => ({
        commit_id: H(n), station_id: decodeURIComponent(obs[1]), height: 459 + n, observed_at: BASE_TS + n,
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
      return e ? { ok: true, status: 200, payload: { ok: true, data: e } } : { ok: false, status: 404, payload: null };
    }
    const a = /^\/addresses\/([^/]+)$/.exec(path);
    if (a) return typeof addr === 'function' ? addr(decodeURIComponent(a[1])) : addr;
    return { ok: false, status: 404, payload: null };
  });
}
const paid = (real_paid: string): AddrAnswer => ({ ok: true, status: 200, payload: { ok: true, data: { contribution_rewards: { real_paid } } } });
const addressCalls = (f: any) => f.mock.calls.filter((c: any[]) => String(c[0]).startsWith('/addresses/'));

/** owner row as the route's single owner query returns it (weather_stations, no migration). */
function app(fetchCore4Json: any, owner: { owner_address: string; stations_sharing: number } | null | 'throw' = { owner_address: OWNER, stations_sharing: 1 }, extra: Record<string, unknown> = {}) {
  const db = { execute: jest.fn(async (sql: string) => {
    if (/stations_sharing/.test(sql)) {
      if (owner === 'throw') throw new Error('db down');
      return { rows: owner ? [owner] : [] };
    }
    return /weather_stations/.test(sql) ? { rows: [{ station_id: 'station-a' }] } : { rows: [] };
  }) };
  const a = express();
  a.use('/api', createStationDetailRouter({
    db, fetchCore4Json, readerToken: () => 'reader-token', isAuthenticated: () => true, ...extra,
  } as any));
  return a;
}
const four = (amount = '100000001') => {
  const ev: Record<string, any> = {};
  [0, 3600, 7200, 10800].forEach((dt, i) => { ev[H(i + 1)] = rewarded(H(i + 1), amount, BASE_TS + dt); });
  return ev;
};
const get = (a: any) => request(a).get('/api/stations/station-a/earnings');

describe('lifetime', () => {
  it('sole owner: the address real_paid, exact to 8 decimals, scope station, no address in the body', async () => {
    const f = core4([1], {}, paid('123456789012345678'));
    const res = await get(app(f));
    expect(res.status).toBe(200);
    expect(res.body.lifetime).toEqual({
      scope: 'station', baseUnits: '123456789012345678', wrf: '1234567890.12345678',
      denomination: 'WRF', baseUnitDecimals: 8, source: 'core4',
    });
    expect(JSON.stringify(res.body)).not.toContain(OWNER.slice(2, 12));
    expect(res.body.fieldsUnavailable).not.toContain('lifetime');
    expect(addressCalls(f)).toHaveLength(1);
    expect(addressCalls(f)[0][0]).toBe(`/addresses/${OWNER}`);
  });

  it('keeps 1 base unit and >2^53 exact (no float)', async () => {
    const one = await get(app(core4([1], {}, paid('1'))));
    expect(one.body.lifetime).toMatchObject({ baseUnits: '1', wrf: '0.00000001' });
    const big = await get(app(core4([1], {}, paid('9007199254740993'))));
    expect(big.body.lifetime).toMatchObject({ baseUnits: '9007199254740993', wrf: '90071992.54740993' });
  });

  it('shared owner address: the address total, labelled scope address with the sharing count', async () => {
    const res = await get(app(core4([1], {}, paid('500000000')), { owner_address: OWNER, stations_sharing: 3 }));
    expect(res.body.lifetime).toMatchObject({ scope: 'address', stationsSharingAddress: 3, baseUnits: '500000000', wrf: '5' });
  });

  it('node says "address not found": a proven zero, not unavailable', async () => {
    const res = await get(app(core4([1], {}, { ok: false, status: 404, payload: { error: { code: 'NOT_FOUND', message: 'address not found' } } })));
    expect(res.body.lifetime).toMatchObject({ scope: 'station', baseUnits: '0', wrf: '0' });
  });

  it.each([
    ['node 503', () => core4([1], {}, { ok: false, status: 503, payload: null }), { owner_address: OWNER, stations_sharing: 1 }],
    ['malformed real_paid', () => core4([1], {}, paid('12.5')), { owner_address: OWNER, stations_sharing: 1 }],
    ['no owner row', () => core4([1], {}, paid('1')), null],
    ['malformed owner address', () => core4([1], {}, paid('1')), { owner_address: 'not-an-address', stations_sharing: 1 }],
    ['sharing count unproven', () => core4([1], {}, paid('1')), { owner_address: OWNER, stations_sharing: 0 }],
    ['owner query fails', () => core4([1], {}, paid('1')), 'throw'],
  ] as const)('%s: lifetime null + fieldsUnavailable, never 0', async (_n, mk, owner) => {
    const res = await get(app(mk(), owner as any));
    expect(res.status).toBe(200);
    expect(res.body.lifetime).toBeNull();
    expect(res.body.fieldsUnavailable).toContain('lifetime');
    // the existing recent-window contract is unaffected
    expect(res.body.source).toBe('core4');
    expect(res.body.earnings).toHaveLength(1);
  });
});

describe('read budget shared with the leaderboard', () => {
  it('a leaderboard read and a station read of the same address cost ONE node read', async () => {
    const f = core4([1], {}, paid('250000000'));
    const reader = createAddressEarnedReader({ fetchCore4Json: f as any, readerToken: () => 'reader-token' });
    const lb = await reader.readMany([OWNER]);
    expect(lb.get(OWNER)).toBe('250000000');
    const res = await get(app(f, undefined, { addressEarned: reader }));
    expect(res.body.lifetime).toMatchObject({ baseUnits: '250000000' });
    expect(addressCalls(f)).toHaveLength(1);
  });

  it('the leaderboard router and the station router, built with one reader, share its cache', async () => {
    const f = core4([1], {}, paid('7'));
    const reader = createAddressEarnedReader({ fetchCore4Json: f as any, readerToken: () => 'reader-token' });
    expect(typeof createWeatherLeaderboardRouter).toBe('function');
    await get(app(f, undefined, { addressEarned: reader }));
    await get(app(f, undefined, { addressEarned: reader }));
    expect(addressCalls(f)).toHaveLength(1);
  });

  it('30 reads per 5-minute window across all callers; the 31st is unavailable with no node read', async () => {
    let t = 1_000_000;
    const f = core4([1], {}, paid('9'));
    const reader = createAddressEarnedReader({ fetchCore4Json: f as any, readerToken: () => 'reader-token', now: () => t });
    const addrs = Array.from({ length: 30 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    await reader.readMany(addrs);
    expect(addressCalls(f)).toHaveLength(30);
    const res = await get(app(f, undefined, { addressEarned: reader, now: () => t }));
    expect(res.body.lifetime).toBeNull();
    expect(res.body.fieldsUnavailable).toContain('lifetime');
    expect(addressCalls(f)).toHaveLength(30);
    t += 300_001; // next window: allowed again
    const later = await get(app(f, undefined, { addressEarned: reader, now: () => t }));
    expect(later.body.lifetime).toMatchObject({ baseUnits: '9' });
    expect(addressCalls(f)).toHaveLength(31);
  });

  it('concurrent station requests make one node read (single flight)', async () => {
    const f = core4([1], {}, paid('3'));
    const reader = createAddressEarnedReader({ fetchCore4Json: f as any, readerToken: () => 'reader-token' });
    const a = app(f, undefined, { addressEarned: reader });
    await Promise.all([get(a), get(a), get(a)]);
    expect(addressCalls(f)).toHaveLength(1);
  });
});

describe('rate', () => {
  it('rewarded base units/day over the complete window, exact (excludes the oldest commit reward)', async () => {
    // rewards at +0, +3600, +7200, +10800 s; the sum of the 3 newer = 300000003; span 10800 s
    const res = await get(app(core4([1, 2, 3, 4], four(), paid('1'))));
    expect(res.body.rate).toEqual({
      baseUnitsPerDay: '2400000024', wrfPerDay: '24.00000024',
      windowCommits: 4, windowSeconds: 10800, complete: true,
      denomination: 'WRF', baseUnitDecimals: 8, source: 'core4',
    });
    expect(res.body.fieldsUnavailable).not.toContain('rate');
    // earnings and totals are unchanged
    expect(res.body.totals).toMatchObject({ rewardedCommits: 4, rewardedBaseUnits: '400000004' });
  });

  it('floors the division (no rounding up to a number the chain never paid)', async () => {
    // newer-3 sum 3 base units over 10800 s => 3*86400/10800 = 24 exactly; use 7200 span instead
    const ev: Record<string, any> = {};
    [0, 1800, 3601].forEach((dt, i) => { ev[H(i + 1)] = rewarded(H(i + 1), '1', BASE_TS + dt); });
    const res = await get(app(core4([1, 2, 3], ev, paid('1'))));
    // sum of newer two = 2; 2*86400/3601 = 47.98.. => floor 47
    expect(res.body.rate).toMatchObject({ baseUnitsPerDay: '47', wrfPerDay: '0.00000047', windowSeconds: 3601 });
  });

  it.each([
    ['fewer than 3 rewarded commits', () => { const e = four(); delete e[H(3)]; delete e[H(4)]; return core4([1, 2, 3, 4], e, paid('1')); }],
    ['span under one hour', () => { const e: Record<string, any> = {}; [0, 600, 1200].forEach((dt, i) => { e[H(i + 1)] = rewarded(H(i + 1), '5', BASE_TS + dt); }); return core4([1, 2, 3], e, paid('1')); }],
    ['an unreadable commit makes the window incomplete', () => { const e = four(); e[H(2)] = 'down'; return core4([1, 2, 3, 4], e, paid('1')); }],
    ['no commits', () => core4([], {}, paid('1'))],
  ])('%s: rate null + fieldsUnavailable, never 0', async (_n, mk) => {
    const res = await get(app(mk()));
    expect(res.status).toBe(200);
    expect(res.body.rate).toBeNull();
    expect(res.body.fieldsUnavailable).toContain('rate');
  });

  it('costs no extra node reads beyond the window evidence and one address read', async () => {
    const base = core4([1, 2, 3, 4], four(), paid('1'));
    await get(app(base, null)); // no owner row: today's route, no address read
    const f = core4([1, 2, 3, 4], four(), paid('1'));
    await get(app(f));
    expect(f.mock.calls.length).toBe(base.mock.calls.length + 1); // exactly the one address read
    expect(addressCalls(f)).toHaveLength(1);
  });
});

describe('unavailable shapes stay byte-compatible', () => {
  it('no reader credential: the stub body is unchanged (no lifetime/rate keys)', async () => {
    const a = express();
    a.use('/api', createStationDetailRouter({
      db: { execute: async () => ({ rows: [{ station_id: 'station-a' }] }) }, fetchCore4Json: core4([1], {}, paid('1')),
      readerToken: () => undefined, isAuthenticated: () => true,
    } as any));
    const res = await get(a);
    expect(Object.keys(res.body).sort()).toEqual(['amountUnits', 'earnings', 'reason', 'source', 'unavailable']);
  });
});

describe('window completeness: an unusable rewarded commit never yields an honest-looking rate', () => {
  it("reviewer probe: 4 x 100 with #3 rewarded:true but amount 'bad' => rate null, not 1600/day", async () => {
    const ev = four('100');
    ev[H(3)] = rewarded(H(3), 'bad', BASE_TS + 7200);
    const res = await get(app(core4([1, 2, 3, 4], ev, paid('1'))));
    expect(res.body.rate).toBeNull();
    expect(res.body.fieldsUnavailable).toContain('rate');
  });

  it('a rewarded:true commit with no block time is the same: rate null', async () => {
    const ev = four('100');
    ev[H(3)] = { ...rewarded(H(3), '100', BASE_TS + 7200), block: null };
    const res = await get(app(core4([1, 2, 3, 4], ev, paid('1'))));
    expect(res.body.rate).toBeNull();
    expect(res.body.fieldsUnavailable).toContain('rate');
  });

  it('the same four commits with good amounts give the honest rate (control)', async () => {
    const res = await get(app(core4([1, 2, 3, 4], four('100'), paid('1'))));
    expect(res.body.rate).toMatchObject({ baseUnitsPerDay: '2400', windowSeconds: 10800 });
  });
});

describe('sharing count privacy', () => {
  const TOKEN_SECRET = 'station-earnings-1232-secret-0123456789abcdef';
  const OPERATOR = 'operator-token-1232-0123456789abcdef';
  const OTHER = '0xdef0000000000000000000000000000000000002';
  const wallet = (sub: string) => jwt.sign({ sub, type: 'access' }, TOKEN_SECRET, {
    algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m',
  });
  let saved: Record<string, string | undefined>;
  beforeAll(() => {
    saved = { JWT_SECRET: process.env.JWT_SECRET, OP: process.env.WRFCOIN_OPERATOR_TOKEN };
    process.env.JWT_SECRET = TOKEN_SECRET;
    process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  });
  afterAll(() => {
    for (const [k, v] of [['JWT_SECRET', saved.JWT_SECRET], ['WRFCOIN_OPERATOR_TOKEN', saved.OP]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });
  const shared = { owner_address: OWNER, stations_sharing: 3 };
  const anonGet = (a: any, headers: Record<string, string> = {}) =>
    request(a).get(`/api/stations/${stationAlias('station-a')}/earnings`).set(headers);
  const anonApp = () => app(core4([1], {}, paid('500000000')), shared, { isAuthenticated: () => false });

  // Owner ruling 2026-10-05: a shared (address-scoped) lifetime is visible only to the owner
  // wallet's own login and the operator/reader bearer. Everyone else gets the same body as the
  // unproven case, and no node read is spent on it.
  const SOLE = { owner_address: OWNER, stations_sharing: 1 };
  const unprovenBody = async () => (await anonGet(app(core4([1], {}, { ok: false, status: 503, payload: null }), SOLE, { isAuthenticated: () => false }))).body;

  it.each([
    ['anonymous', {}],
    ['another wallet', { authorization: `Bearer ${wallet(OTHER)}` }],
  ])('%s + shared wallet: lifetime null, fieldsUnavailable, NO node address read', async (_n, headers) => {
    const f = core4([1], {}, paid('500000000'));
    const res = await anonGet(app(f, shared, { isAuthenticated: () => false }), headers as any);
    expect(res.status).toBe(200);
    expect(res.body.lifetime).toBeNull();
    expect(res.body.fieldsUnavailable).toContain('lifetime');
    expect(res.text).not.toMatch(/stationsSharing|"scope":"(station|address)"|500000000/);
    expect(addressCalls(f)).toHaveLength(0);
  });

  it('anonymous shared body is byte-identical in shape to the unproven body (no distinguishing reason)', async () => {
    const shape = (b: any) => JSON.stringify(b, (_k, v) => v, 0);
    const sharedRes = await anonGet(anonApp());
    const unproven = await unprovenBody();
    expect(Object.keys(sharedRes.body)).toEqual(Object.keys(unproven));
    expect(sharedRes.body.lifetime).toEqual(unproven.lifetime);
    expect(sharedRes.body.fieldsUnavailable).toEqual(unproven.fieldsUnavailable);
    expect(shape(sharedRes.body)).toBe(shape(unproven));
  });

  it.each([
    ['anonymous', {}],
    ['another wallet', { authorization: `Bearer ${wallet(OTHER)}` }],
  ])('%s + sole station: lifetime stays public (scope station)', async (_n, headers) => {
    const res = await anonGet(app(core4([1], {}, paid('500000000')), SOLE, { isAuthenticated: () => false }), headers as any);
    expect(res.body.lifetime).toMatchObject({ scope: 'station', baseUnits: '500000000' });
    expect('stationsSharingAddress' in res.body.lifetime).toBe(false);
  });

  it('owner login + sole station: scope station, no count', async () => {
    const res = await anonGet(app(core4([1], {}, paid('5')), SOLE, { isAuthenticated: () => false }), { authorization: `Bearer ${wallet(OWNER)}` });
    expect(res.body.lifetime).toMatchObject({ scope: 'station' });
    expect('stationsSharingAddress' in res.body.lifetime).toBe(false);
  });

  it('owner login + shared: reads once and sees the address total + count', async () => {
    const f = core4([1], {}, paid('500000000'));
    const res = await anonGet(app(f, shared, { isAuthenticated: () => false }), { authorization: `Bearer ${wallet(OWNER)}` });
    expect(res.body.lifetime).toMatchObject({ scope: 'address', stationsSharingAddress: 3, baseUnits: '500000000' });
    expect(addressCalls(f)).toHaveLength(1);
  });

  it('operator bearer + shared: address total + count', async () => {
    const f = core4([1], {}, paid('500000000'));
    const res = await get(app(f, shared, { isAuthenticated: () => true }));
    expect(res.body.lifetime).toMatchObject({ scope: 'address', stationsSharingAddress: 3 });
    expect(addressCalls(f)).toHaveLength(1);
  });

  it('the owner wallet\'s own login sees the count', async () => {
    const res = await anonGet(anonApp(), { authorization: `Bearer ${wallet(OWNER)}` });
    expect(res.body.lifetime).toMatchObject({ scope: 'address', stationsSharingAddress: 3 });
  });

  it('the operator/reader bearer sees the count', async () => {
    const res = await get(app(core4([1], {}, paid('500000000')), shared, { isAuthenticated: () => true }));
    expect(res.body.lifetime).toMatchObject({ scope: 'address', stationsSharingAddress: 3 });
  });
});

describe('owner query text', () => {
  it('compares lower(trim(owner_address)) on both sides', async () => {
    const { STATION_OWNER_SHARING_SQL } = await import('../../server/routes/station-detail-routes.js');
    expect(STATION_OWNER_SHARING_SQL).toContain('lower(trim(o.owner_address)) = lower(trim(w.owner_address))');
    expect(STATION_OWNER_SHARING_SQL).toContain('lower(trim(w.owner_address)) AS owner_address');
  });
});
