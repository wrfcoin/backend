/**
 * Public balance read for the passkey wallet (owner ruling 2026-10-28 (b)):
 * GET /api/public/balance/:address -> { address, balance, height, earned }, default OFF, 30/min per IP,
 * 5 s per-address cache, upstream failures are 502/504 and never a 200 with a zero.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

// Stateful Redis sorted sets drive the real shared limiter (same fake as faucet-bond-routes.test.ts).
function redisFake() {
  const sets = new Map<string, Array<{ score: number; member: string }>>();
  return {
    status: 'ready', on: jest.fn(), connect: jest.fn(async () => undefined), quit: jest.fn(async () => 'OK'), disconnect: jest.fn(),
    ttl: jest.fn(async () => -2), exists: jest.fn(async () => 0), incr: jest.fn(async () => 1), expire: jest.fn(async () => 1),
    setex: jest.fn(async () => 'OK'), del: jest.fn(async () => 1),
    pipeline: () => {
      const ops: Array<() => unknown> = [];
      const p: any = {
        zremrangebyscore: (k: string, min: number, max: number) => { ops.push(() => { sets.set(k, (sets.get(k) || []).filter((e) => e.score < min || e.score > max)); return 0; }); return p; },
        zadd: (k: string, score: number, member: string) => { ops.push(() => { sets.set(k, [...(sets.get(k) || []), { score, member }]); return 1; }); return p; },
        zcard: (k: string) => { ops.push(() => (sets.get(k) || []).length); return p; },
        expire: () => { ops.push(() => 1); return p; },
        exec: async () => ops.map((op) => [null, op()]),
      };
      return p;
    },
  };
}
jest.mock('ioredis', () => jest.fn().mockImplementation(() => (global as any).__balanceRedis));

type Seen = { path: string; headers: http.IncomingHttpHeaders };
type Reply = { status: number; json: unknown };
const READER = 'reader-token-for-public-balance-test';
const ADDR = '0xCA0E0F30E971631615883CBA3976053463C3F63E';
const LOWER = ADDR.toLowerCase();
const OTHER = '0x' + '1'.repeat(40);
const okTip: Reply = { status: 200, json: { ok: true, data: { height: 4242, tip: 'ab'.repeat(32), accounts: 9, nfts: 0, pending_transactions: 0 } } };
const okAccount = (over: Record<string, unknown> = {}): Reply => ({
  status: 200,
  json: { ok: true, data: { address: LOWER, balance: '123456789012345678901', nonce: '7', stake_required: '0', stake_locked: '1000',
    spendable_balance: '123456789012345677901', earned_balance_total: '5', contribution_rewards: {}, ...over } },
});

describe('GET /api/public/balance/:address', () => {
  const envKeys = ['CORE4_API_URL', 'WRFCOIN_READER_TOKEN', 'PUBLIC_BALANCE_READ_ENABLED', 'TRUSTED_PROXIES', 'DISABLE_FILE_LOG_TRANSPORTS', 'PUBLIC_BALANCE_UPSTREAM_MAX_PER_MIN'];
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  let seen: Seen[] = [];
  let tipReply: Reply = okTip;
  let accountReply: Reply = okAccount();
  let upstream: http.Server;
  let clock = 1_000_000;

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      seen.push({ path: req.url ?? '', headers: req.headers });
      const reply = req.url === '/blockchain' ? tipReply : accountReply;
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.json));
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
  });
  afterAll(async () => {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await new Promise<void>((r) => upstream.close(() => r()));
  });
  beforeEach(() => {
    jest.resetModules();
    (global as any).__balanceRedis = redisFake();
    Object.assign(process.env, {
      CORE4_API_URL: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      WRFCOIN_READER_TOKEN: READER,
      PUBLIC_BALANCE_READ_ENABLED: 'true',
      TRUSTED_PROXIES: '127.0.0.1,::1',
      DISABLE_FILE_LOG_TRANSPORTS: 'true',
    });
    delete process.env.PUBLIC_BALANCE_UPSTREAM_MAX_PER_MIN;
    seen = [];
    tipReply = okTip;
    accountReply = okAccount();
    clock = 1_000_000;
  });
  afterEach(() => { delete (global as any).__balanceRedis; });

  /** Same mount path as the deployed entrypoint. `deps` defaults to the production wiring except the clock. */
  function makeApp(deps: Record<string, unknown> = {}) {
    const { createPublicBalanceRouter } = require('../server/routes/public-balance-routes');
    const app = express();
    app.use('/api/public/balance', createPublicBalanceRouter({ now: () => clock, ...deps }));
    return app;
  }
  const accountReads = () => seen.filter((s) => s.path.startsWith('/addresses/')).length;
  const tipReads = () => seen.filter((s) => s.path === '/blockchain').length;
  const addr = (i: number) => `0x${i.toString(16).padStart(40, '0')}`;

  it('pins the response shape: exactly address, balance, height and earned, in the chain units and string form', async () => {
    const r = await request(makeApp()).get(`/api/public/balance/${ADDR}`)
      .set('Authorization', 'Bearer caller-token-must-not-travel').set('x-request-id', 'caller-request-id');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ address: LOWER, balance: '123456789012345677901', height: 4242, earned: '5' });
    expect(Object.keys(r.body).sort()).toEqual(['address', 'balance', 'earned', 'height']);
    expect(typeof r.body.balance).toBe('string');
    expect(typeof r.body.earned).toBe('string');
    expect(r.headers['cache-control']).toBe('no-store');
    // Tip first, then the account; the server Reader bearer only, no caller header.
    expect(seen.map((s) => s.path)).toEqual(['/blockchain', `/addresses/${LOWER}`]);
    for (const s of seen) {
      expect(s.headers.authorization).toBe(`Bearer ${READER}`);
      expect(s.headers['x-request-id']).toBeUndefined();
    }
    expect(JSON.stringify(r.body)).not.toContain(READER);
  });

  it('answers core4 NOT_FOUND (account not in state) with the chain zero and the height', async () => {
    accountReply = { status: 404, json: { ok: false, data: null, error: { code: 'NOT_FOUND', message: 'address not found' } } };
    const r = await request(makeApp()).get(`/api/public/balance/${OTHER}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ address: OTHER, balance: '0', height: 4242, earned: '0' });
  });

  it('returns earned_balance_total exactly (above 2^53, no float), and it can exceed the spendable balance', async () => {
    // Node pay is a direct state credit with no transaction: this total is where it shows.
    accountReply = okAccount({ spendable_balance: '0', earned_balance_total: '37925925888000000001' });
    const r = await request(makeApp()).get(`/api/public/balance/${ADDR}`);
    expect(r.status).toBe(200);
    expect(r.body.balance).toBe('0');
    expect(r.body.earned).toBe('37925925888000000001');
  });

  it('answers earned: null (unknown, not zero) when the node does not send earned_balance_total, and keeps the balance', async () => {
    accountReply = okAccount({ earned_balance_total: undefined });
    const r = await request(makeApp()).get(`/api/public/balance/${ADDR}`);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ address: LOWER, balance: '123456789012345677901', height: 4242, earned: null });
  });

  it.each([
    ['too short', '0x1234'],
    ['no 0x prefix', '1'.repeat(40)],
    ['non-hex digit', '0x' + 'g'.repeat(40)],
    ['41 hex digits', '0x' + '1'.repeat(41)],
    ['trailing text', `${OTHER}zz`],
    ['encoded slash', `${OTHER}%2Fnonce`],
  ])('rejects a malformed address (%s) with 400 before any node read', async (_label, address) => {
    const r = await request(makeApp()).get(`/api/public/balance/${address}`);
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_ERROR');
    expect(seen).toHaveLength(0);
  });

  it('is 404 with the flag off (default), before the limiter or the node', async () => {
    delete process.env.PUBLIC_BALANCE_READ_ENABLED;
    const rateLimit = jest.fn((_req: unknown, _res: unknown, next: () => void) => next());
    const app = makeApp({ rateLimit });
    expect((await request(app).get(`/api/public/balance/${ADDR}`)).status).toBe(404);
    process.env.PUBLIC_BALANCE_READ_ENABLED = '1';
    expect((await request(app).get(`/api/public/balance/${ADDR}`)).status).toBe(404);
    expect(rateLimit).not.toHaveBeenCalled();
    expect(seen).toHaveLength(0);
  });

  it('serves a repeat read inside 5 s from the cache, and re-reads after it expires', async () => {
    const app = makeApp();
    const first = await request(app).get(`/api/public/balance/${ADDR}`);
    accountReply = okAccount({ spendable_balance: '1' });
    clock += 4_999;
    const second = await request(app).get(`/api/public/balance/${LOWER}`);
    expect(second.body).toEqual(first.body);
    expect(accountReads()).toBe(1);
    clock += 2;
    const third = await request(app).get(`/api/public/balance/${ADDR}`);
    expect(third.body.balance).toBe('1');
    expect(accountReads()).toBe(2);
  });

  it('shares one in-flight read between concurrent callers for the same address', async () => {
    const app = makeApp();
    const rs = await Promise.all([1, 2, 3].map(() => request(app).get(`/api/public/balance/${ADDR}`)));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(accountReads()).toBe(1);
  });

  it('rate-limits at 30 reads/min per client address with 429 + Retry-After, and a new address mints no budget', async () => {
    const app = makeApp();
    for (let i = 0; i < 30; i += 1) {
      const r = await request(app).get(`/api/public/balance/${ADDR}`);
      expect(r.status).toBe(200);
    }
    const limited = await request(app).get(`/api/public/balance/${ADDR}`);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    const otherPath = await request(app).get(`/api/public/balance/${OTHER}`);
    expect(otherPath.status).toBe(429);
    expect(accountReads()).toBe(1);
  });

  it('reads the tip once per 5 s for all addresses, not once per address', async () => {
    accountReply = okAccount({ address: undefined }); // one fixture answers for many addresses
    const app = makeApp();
    for (let i = 1; i <= 4; i += 1) expect((await request(app).get(`/api/public/balance/${addr(i)}`)).status).toBe(200);
    expect(accountReads()).toBe(4);
    expect(tipReads()).toBe(1);
    clock += 5_001;
    expect((await request(app).get(`/api/public/balance/${addr(5)}`)).body.height).toBe(4242);
    expect(tipReads()).toBe(2);
  });

  it('caps account reads process-wide: distinct addresses from distinct clients stop at the cap with 503 + Retry-After and no node call', async () => {
    process.env.PUBLIC_BALANCE_UPSTREAM_MAX_PER_MIN = '3';
    accountReply = okAccount({ address: undefined });
    const app = makeApp();
    const from = (i: number) => request(app).get(`/api/public/balance/${addr(i)}`).set('X-Forwarded-For', `198.51.100.${i}`);
    for (let i = 1; i <= 3; i += 1) expect((await from(i)).status).toBe(200);
    const before = seen.length;
    for (let i = 4; i <= 8; i += 1) {
      const r = await from(i);
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('UPSTREAM_BUDGET_EXHAUSTED');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
      expect(r.body.balance).toBeUndefined();
    }
    expect(seen.length).toBe(before); // past the cap: zero upstream calls, tip included
    expect(accountReads()).toBe(3);
    // A cached address stays free while the budget is spent.
    expect((await from(1)).status).toBe(200);
    // The next minute reopens the budget.
    clock += 60_000;
    expect((await from(9)).status).toBe(200);
    expect(accountReads()).toBe(4);
  });

  it('reads the cap from PUBLIC_BALANCE_UPSTREAM_MAX_PER_MIN: default 120, at most 500, junk falls back', () => {
    const { upstreamMaxPerMinute } = require('../server/routes/public-balance-routes');
    expect(upstreamMaxPerMinute()).toBe(120);
    for (const [raw, want] of [['60', 60], ['500', 500], ['100000', 500], ['0', 120], ['-5', 120], ['1e3', 120], ['abc', 120]] as const) {
      process.env.PUBLIC_BALANCE_UPSTREAM_MAX_PER_MIN = raw;
      expect(upstreamMaxPerMinute()).toBe(want);
    }
  });

  it('keeps an untrusted peer in its own bucket however it spoofs X-Forwarded-For', async () => {
    process.env.TRUSTED_PROXIES = '10.9.9.9'; // the loopback test peer is NOT a trusted proxy here
    const app = makeApp();
    for (let i = 0; i < 30; i += 1) {
      const r = await request(app).get(`/api/public/balance/${ADDR}`).set('X-Forwarded-For', `203.0.113.${i + 1}`);
      expect(r.status).toBe(200);
    }
    const spoofed = await request(app).get(`/api/public/balance/${ADDR}`).set('X-Forwarded-For', '192.0.2.77');
    expect(spoofed.status).toBe(429);
  });

  describe('upstream failures are 502 or 504, never a 200 and never a zero', () => {
    const cases: Array<[string, () => void]> = [
      ['account 500', () => { accountReply = { status: 500, json: { ok: false, error: { code: 'INTERNAL', message: 'db path /var/x' } } }; }],
      ['account 401 (credential refused)', () => { accountReply = { status: 401, json: { ok: false, error: { code: 'UNAUTHORIZED' } } }; }],
      ['account 429 (node limiter)', () => { accountReply = { status: 429, json: { ok: false, error: { code: 'RATE_LIMITED' } } }; }],
      ['account 404 that is not NOT_FOUND', () => { accountReply = { status: 404, json: 'no route' }; }],
      ['tip 503', () => { tipReply = { status: 503, json: { ok: false } }; }],
      ['tip without a height', () => { tipReply = { status: 200, json: { ok: true, data: { tip: 'x' } } }; }],
      ['balance as a number', () => { accountReply = okAccount({ spendable_balance: 5, balance: 5 }); }],
      ['no spendable_balance (gross balance only, never used)', () => { accountReply = okAccount({ spendable_balance: undefined }); }],
      ['balance with a fraction', () => { accountReply = okAccount({ spendable_balance: '1.5' }); }],
      ['answer for another address', () => { accountReply = okAccount({ address: OTHER }); }],
      ['earned as a number', () => { accountReply = okAccount({ earned_balance_total: 5 }); }],
      ['earned negative', () => { accountReply = okAccount({ earned_balance_total: '-5' }); }],
      ['earned with a fraction', () => { accountReply = okAccount({ earned_balance_total: '0.5' }); }],
    ];
    it.each(cases)('%s -> 502', async (_label, arrange) => {
      arrange();
      const r = await request(makeApp()).get(`/api/public/balance/${ADDR}`);
      expect(r.status).toBe(502);
      expect(r.body).toEqual({ success: false, error: { code: 'UPSTREAM_ERROR', message: 'The chain node could not answer.' } });
      expect(r.body.balance).toBeUndefined();
    });

    it('node unreachable -> 502', async () => {
      process.env.CORE4_API_URL = 'http://127.0.0.1:1';
      const r = await request(makeApp()).get(`/api/public/balance/${ADDR}`);
      expect(r.status).toBe(502);
    });

    it('node timeout -> 504', async () => {
      const fetchCore4Json = jest.fn(async () => { throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }); });
      const r = await request(makeApp({ fetchCore4Json })).get(`/api/public/balance/${ADDR}`);
      expect(r.status).toBe(504);
      expect(r.body.error.code).toBe('UPSTREAM_TIMEOUT');
    });

    it('a failure is held for the same 5 s so polling does not re-ask a broken node, then recovers', async () => {
      accountReply = { status: 500, json: {} };
      const app = makeApp();
      expect((await request(app).get(`/api/public/balance/${ADDR}`)).status).toBe(502);
      accountReply = okAccount();
      expect((await request(app).get(`/api/public/balance/${ADDR}`)).status).toBe(502);
      expect(accountReads()).toBe(1);
      clock += 5_001;
      expect((await request(app).get(`/api/public/balance/${ADDR}`)).status).toBe(200);
    });

    it('no Reader credential configured -> 503, no node read, no caller token fallback', async () => {
      delete process.env.WRFCOIN_READER_TOKEN;
      const r = await request(makeApp()).get(`/api/public/balance/${ADDR}`).set('Authorization', 'Bearer caller-token');
      expect(r.status).toBe(503);
      expect(r.body.error.code).toBe('CORE4_READER_CREDENTIAL_UNCONFIGURED');
      expect(seen).toHaveLength(0);
    });
  });
});
