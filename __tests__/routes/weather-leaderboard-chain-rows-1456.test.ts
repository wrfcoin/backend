/**
 * backend#1456 option A (owner ruling 2026-10-06): leaderboard rows come from the chain.
 * Candidates = distinct weather_stations.owner_address (chain-synced registry); each one's
 * lifetime real_paid is read through the budgeted core4 reader; ranked = real_paid > 0,
 * descending (BigInt). weather_submissions/users only decorate (name, region).
 */
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';

import { createWeatherLeaderboardRouter } from '../../server/routes/weather-leaderboard-routes.js';

type Reply = { ok: boolean; status: number; payload: any };
const NOT_FOUND: Reply = { ok: false, status: 404, payload: { ok: false, error: { code: 'NOT_FOUND', message: 'address not found' } } };
const ok = (realPaid: string): Reply => ({
  ok: true,
  status: 200,
  payload: { data: { contribution_rewards: { real_paid: realPaid, synthetic_paid: '5' } } },
});

const A = '0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1';
const B = '0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
const C = '0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3';
const PHONE = '0xd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';

/** Every key and numeric value anywhere in a JSON body. */
function walk(value: unknown, out: { keys: string[]; numbers: number[] } = { keys: [], numbers: [] }) {
  if (typeof value === 'number') out.numbers.push(value);
  else if (Array.isArray(value)) value.forEach(v => walk(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) { out.keys.push(k); walk(v, out); }
  }
  return out;
}

function makeApp(opts: {
  owners: string[];
  replies: Record<string, Reply | Error>;
  names?: Array<Record<string, unknown>>;
  /** submissions-metric rows; the chain path must never need them. */
  submissionRows?: Array<Record<string, unknown>>;
  nameQueryFails?: boolean;
}) {
  const sqls: string[] = [];
  const execute = jest.fn(async (sql: string) => {
    sqls.push(sql);
    if (/FROM weather_stations/i.test(sql)) return { rows: opts.owners.map(o => ({ owner_address: o })) };
    if (/FROM users/i.test(sql) && !/weather_submissions ws\b[\s\S]*GROUP BY/i.test(sql)) {
      if (opts.nameQueryFails) throw new Error('names down');
      return { rows: opts.names ?? [] };
    }
    return { rows: opts.submissionRows ?? [] }; // zero weather_submissions on live
  });
  const calls: string[] = [];
  const fetchCore4Json = jest.fn(async (path: string) => {
    calls.push(path);
    const r = opts.replies[decodeURIComponent(path.replace('/addresses/', ''))];
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
      readerToken: () => 'reader-token',
    } as any),
  );
  return { app, calls, sqls, execute };
}

const JWT_SECRET = 'leaderboard-1456-secret-0123456789abcdef';
const OPERATOR = 'operator-token-1456-0123456789abcdef';
function walletToken(sub: string) {
  return jwt.sign({ sub, type: 'access' }, JWT_SECRET, {
    algorithm: 'HS256', issuer: 'wrfcoin-platform', audience: 'wrfcoin-api', expiresIn: '5m',
  });
}
let savedEnv: Record<string, string | undefined>;
beforeAll(() => {
  savedEnv = { JWT_SECRET: process.env.JWT_SECRET, OP: process.env.WRFCOIN_OPERATOR_TOKEN, ALIAS: process.env.WRFCOIN_PUBLIC_ALIAS_SECRET };
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.WRFCOIN_OPERATOR_TOKEN = OPERATOR;
  delete process.env.WRFCOIN_PUBLIC_ALIAS_SECRET;
});
afterEach(() => { jest.useRealTimers(); });
afterAll(() => {
  const restore = (k: string, v: string | undefined) => (v === undefined ? delete process.env[k] : (process.env[k] = v));
  restore('JWT_SECRET', savedEnv.JWT_SECRET);
  restore('WRFCOIN_OPERATOR_TOKEN', savedEnv.OP);
  restore('WRFCOIN_PUBLIC_ALIAS_SECRET', savedEnv.ALIAS);
});

describe('leaderboard rows from the chain (backend#1456)', () => {
  it('zero weather_submissions but one paid station owner yields one ranked row (default metric)', async () => {
    const { app } = makeApp({
      owners: [A, B, PHONE],
      replies: { [A]: NOT_FOUND, [B]: NOT_FOUND, [PHONE]: ok('1524000000') },
    });
    const res = await request(app).get('/api/weather/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body.metric).toBe('earnings');
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0]).toMatchObject({
      rank: 1,
      earningsBaseUnits: '1524000000',
      earningsWrf: '15.24',
      value: 15.24,
    });
    expect(res.body.earningsScope).toBe('lifetime');
    expect(res.body.unavailable).toBeUndefined();
    expect(res.body.amountUnits).toMatchObject({ denomination: 'WRF', baseUnitDecimals: 8, available: true });
  });

  it('explicit metric=earnings is the same; period is accepted and does not window the amount', async () => {
    const { app } = makeApp({ owners: [PHONE], replies: { [PHONE]: ok('1') } });
    const res = await request(app).get('/api/weather/leaderboard?metric=earnings&period=30d');
    expect(res.status).toBe(200);
    expect(res.body.entries[0].earningsBaseUnits).toBe('1');
    expect(res.body.period).toBe('30d');
  });

  it('ranks by real_paid descending as BigInt, beyond float precision, and drops zeros', async () => {
    const { app } = makeApp({
      owners: [A, B, C, PHONE],
      replies: {
        [A]: ok('9007199254740993'), // 2^53 + 1
        [B]: ok('9007199254740992'),
        [C]: NOT_FOUND,
        [PHONE]: ok('0'),
      },
    });
    const res = await request(app).get('/api/weather/leaderboard');
    expect(res.body.entries.map((e: any) => e.earningsBaseUnits)).toEqual(['9007199254740993', '9007199254740992']);
    expect(res.body.entries.map((e: any) => e.rank)).toEqual([1, 2]);
  });

  it('honours limit on ranked rows', async () => {
    const { app } = makeApp({ owners: [A, B, C], replies: { [A]: ok('3'), [B]: ok('2'), [C]: ok('1') } });
    const res = await request(app).get('/api/weather/leaderboard?limit=2');
    expect(res.body.entries.map((e: any) => e.earningsBaseUnits)).toEqual(['3', '2']);
  });

  it('a failed node read for any candidate is unavailable (503), never a partial ranking', async () => {
    const { app } = makeApp({
      owners: [A, PHONE],
      replies: { [A]: new Error('timeout'), [PHONE]: ok('1524000000') },
    });
    const res = await request(app).get('/api/weather/leaderboard');
    expect(res.status).toBe(503);
    expect(res.body.unavailable).toEqual(['earnings']);
    expect(res.body.entries).toEqual([]);
    expect(res.body.amountUnits.available).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('1524000000');
  });

  it('no reader credential: unavailable, not an empty leaderboard', async () => {
    const execute = jest.fn(async () => ({ rows: [{ owner_address: A }] }));
    const app = express();
    app.use(
      '/api/weather/leaderboard',
      createWeatherLeaderboardRouter({
        db: { execute } as any, cache: null, rateLimit: null,
        fetchCore4Json: (async () => NOT_FOUND) as any, readerToken: () => undefined,
      } as any),
    );
    const res = await request(app).get('/api/weather/leaderboard');
    expect(res.status).toBe(503);
    expect(res.body.unavailable).toEqual(['earnings']);
  });

  it('genuine empty: no candidates, or every candidate proven zero, is a 200 empty list', async () => {
    const none = await request(makeApp({ owners: [], replies: {} }).app).get('/api/weather/leaderboard');
    expect(none.status).toBe(200);
    expect(none.body.entries).toEqual([]);
    expect(none.body.unavailable).toBeUndefined();
    const zero = await request(makeApp({ owners: [A], replies: { [A]: NOT_FOUND } }).app).get('/api/weather/leaderboard');
    expect(zero.status).toBe(200);
    expect(zero.body.entries).toEqual([]);
  });

  it('budget: more than 30 candidates makes no node reads and is unavailable', async () => {
    const owners = Array.from({ length: 31 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval'], now: new Date('2026-10-06T12:34:56.031Z') });
    const { app, calls } = makeApp({ owners, replies: {} });
    const res = await request(app).get('/api/weather/leaderboard');
    jest.useRealTimers();
    expect(res.status).toBe(503);
    expect(res.body.unavailable).toEqual(['earnings']);
    // backend#1457 review: anonymous callers do not get the owner count; the operator does.
    expect(res.body).not.toHaveProperty('candidates');
    // Structural, not a substring: the body carries updatedAt (an ISO time whose milliseconds can contain "31", pinned
    // to .031Z above), so assert on keys and numeric values instead.
    const walked = walk(res.body);
    expect(walked.keys).not.toEqual(expect.arrayContaining(['candidates']));
    expect(walked.keys).not.toEqual(expect.arrayContaining(['total']));
    expect(walked.numbers).not.toContain(31);
    const op = await request(app).get('/api/weather/leaderboard').set('Authorization', `Bearer ${OPERATOR}`);
    expect(op.status).toBe(503);
    expect(op.body.candidates).toMatchObject({ total: 31, cap: 30 });
    expect(calls).toHaveLength(0);
  });

  it('budget: exactly 30 candidates reads each once; a second request is served from the cache', async () => {
    const owners = Array.from({ length: 30 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`);
    const replies: Record<string, Reply> = {};
    for (const o of owners) replies[o] = ok('5');
    const { app, calls } = makeApp({ owners, replies });
    const first = await request(app).get('/api/weather/leaderboard?limit=100');
    expect(first.status).toBe(200);
    expect(first.body.entries).toHaveLength(30);
    expect(calls).toHaveLength(30);
    await request(app).get('/api/weather/leaderboard?limit=100');
    expect(calls).toHaveLength(30);
  });

  it('privacy (#1361): anonymous gets a short address + profileKey; the caller own row and operator see the full address', async () => {
    const { app } = makeApp({ owners: [PHONE], replies: { [PHONE]: ok('7') } });
    const anon = await request(app).get('/api/weather/leaderboard');
    expect(anon.body.entries[0].walletAddress).not.toBe(PHONE);
    expect(anon.body.entries[0].walletAddress).toContain('…');
    expect(JSON.stringify(anon.body)).not.toContain(PHONE);
    expect(anon.body.entries[0].isYou).toBe(false);

    // The caller's own wallet login (checksum-case subject) sees its full address, marked isYou.
    const own = await request(app).get('/api/weather/leaderboard').set('Authorization', `Bearer ${walletToken(PHONE.toUpperCase().replace('0X', '0x'))}`);
    expect(own.status).toBe(200);
    expect(own.body.entries[0].walletAddress.toLowerCase()).toBe(PHONE);
    expect(own.body.entries[0].isYou).toBe(true);

    // The operator bearer sees every full address; another wallet's login does not.
    const { app: app2 } = makeApp({ owners: [PHONE, A], replies: { [PHONE]: ok('7'), [A]: ok('3') } });
    const op = await request(app2).get('/api/weather/leaderboard').set('Authorization', `Bearer ${OPERATOR}`);
    expect(op.body.entries.map((e: any) => e.walletAddress.toLowerCase())).toEqual([PHONE, A]);
    const other = await request(app2).get('/api/weather/leaderboard').set('Authorization', `Bearer ${walletToken(A)}`);
    const otherBody = JSON.stringify(other.body);
    expect(otherBody).not.toContain(PHONE);
    expect(other.body.entries.find((e: any) => e.isYou)?.walletAddress.toLowerCase()).toBe(A);
  });

  it('owner addresses that differ only in case are one candidate: one node read, one row', async () => {
    const { app, calls } = makeApp({ owners: [A, A.toUpperCase().replace('0X', '0x')], replies: { [A]: ok('4') } });
    const res = await request(app).get('/api/weather/leaderboard');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it('decorates with display name and region from the DB, defaults honestly when absent, survives a name-query failure', async () => {
    const named = makeApp({
      owners: [A, PHONE],
      replies: { [A]: ok('2'), [PHONE]: ok('9') },
      names: [{ wallet_address: PHONE, display_name: 'Tony', country: 'us', city: 'Chicago' }],
    });
    const res = await request(named.app).get('/api/weather/leaderboard');
    expect(res.body.entries[0]).toMatchObject({ displayName: 'Tony', country: 'US', city: 'Chicago' });
    expect(res.body.entries[1].displayName).toMatch(/^WeatherNode-/);
    expect(res.body.entries[1].country).toBeNull();

    const broken = makeApp({ owners: [PHONE], replies: { [PHONE]: ok('9') }, nameQueryFails: true });
    const r2 = await request(broken.app).get('/api/weather/leaderboard');
    expect(r2.status).toBe(200);
    expect(r2.body.entries[0].earningsBaseUnits).toBe('9');
  });

  it('geo filters are not supported for the chain metric (400), never silently ignored', async () => {
    const { app } = makeApp({ owners: [A], replies: { [A]: ok('1') } });
    for (const q of ['country=US', 'region=Europe', 'near=1,2']) {
      const res = await request(app).get(`/api/weather/leaderboard?metric=earnings&${q}`);
      expect(res.status).toBe(400);
    }
  });

  it('existing metrics are unchanged: metric=submissions still reads weather_submissions', async () => {
    const { app, sqls } = makeApp({
      owners: [PHONE],
      replies: {},
      submissionRows: [{ rank: 1, wallet_address: A, display_name: 'Alice', value: 3, country: 'US', city: 'X' }],
    });
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.status).toBe(200);
    expect(res.body.metric).toBe('submissions');
    expect(sqls.some(s => /FROM weather_stations/i.test(s))).toBe(false);
  });
});
