/**
 * Faucet claim/challenge limiting keys: IPv6 clients are keyed on their /64, IPv4 on the full address, and the
 * client address comes from the trusted-proxy chain (req.ip), never from a header the caller controls.
 */

import {
  jest,
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
} from '@jest/globals';
import type { Application } from 'express';
// Mock cuid2 to avoid @noble/hashes version mismatch
jest.mock('@paralleldrive/cuid2', () => ({
  createId: () => 'mock-cuid-id',
  init: () => () => 'mock-cuid-id',
}));

const redisState = {
  addressClaims: new Map<string, string>(),
  ipClaims: new Map<string, Array<{ score: number; member: string }>>(),
};
let redisUnavailable = false;

const fakeRedisClient = {
  get: jest.fn(async (key: string) => {
    if (redisUnavailable) {
      throw new Error('Redis unavailable');
    }

    const value = redisState.addressClaims.get(key);
    return value ?? null;
  }),
  set: jest.fn(async (key: string, value: string) => {
    if (redisUnavailable) {
      throw new Error('Redis unavailable');
    }

    redisState.addressClaims.set(key, String(value));
    return 'OK';
  }),
  // Mirrors RESERVE_CLAIM_LUA. Real Redis runs that script atomically against a
  // single-threaded server; this fake is synchronous JS between awaits, which
  // models the same indivisibility — so a concurrency test here is meaningful
  // rather than accidentally serialised.
  eval: jest.fn(async (_script: string, _numKeys: number, ...args: Array<string | number>) => {
    if (redisUnavailable) {
      throw new Error('Redis unavailable');
    }
    const [addrKey, ipKey, nowS, cooldownS, windowS, limitS, member] = args as string[];
    const now = Number(nowS);
    const last = redisState.addressClaims.get(addrKey) ?? null;
    if (last !== null && now - Number(last) < Number(cooldownS)) {
      return [0, 'ALREADY_CLAIMED', String(last), Number(last) + Number(cooldownS) - now];
    }
    const kept = (redisState.ipClaims.get(ipKey) ?? []).filter(
      (e) => e.score > now - Number(windowS)
    );
    if (kept.length >= Number(limitS)) {
      redisState.ipClaims.set(ipKey, kept);
      return [0, 'RATE_LIMITED', last === null ? '' : String(last),
        Math.min(...kept.map((entry) => entry.score)) + Number(windowS) - now];
    }
    redisState.addressClaims.set(addrKey, String(now));
    kept.push({ score: now, member: String(member) });
    redisState.ipClaims.set(ipKey, kept);
    return [1, 'RESERVED', last === null ? '' : String(last)];
  }),

  // Used by the reservation rollback (#884/#887 ordering): the claim is
  // reserved BEFORE dispensing, so a positively-confirmed non-dispense has to
  // be able to delete it again.
  del: jest.fn(async (key: string) => {
    if (redisUnavailable) {
      throw new Error('Redis unavailable');
    }

    return redisState.addressClaims.delete(key) ? 1 : 0;
  }),
  zremrangebyscore: jest.fn(async (key: string, _min: string | number, max: number) => {
    if (redisUnavailable) {
      throw new Error('Redis unavailable');
    }

    const entries = redisState.ipClaims.get(key) ?? [];
    const filtered = entries.filter((entry) => entry.score > max);
    const removed = entries.length - filtered.length;
    redisState.ipClaims.set(key, filtered);
    return removed;
  }),
  zadd: jest.fn(async (key: string, score: number, member: string) => {
    if (redisUnavailable) {
      throw new Error('Redis unavailable');
    }

    const entries = redisState.ipClaims.get(key) ?? [];
    entries.push({ score, member });
    redisState.ipClaims.set(key, entries);
    return 1;
  }),
  zcard: jest.fn(async (key: string) => {
    if (redisUnavailable) {
      throw new Error('Redis unavailable');
    }

    return redisState.ipClaims.get(key)?.length ?? 0;
  }),
  expire: jest.fn(async () => {
    if (redisUnavailable) {
      throw new Error('Redis unavailable');
    }

    return 1;
  }),
};

jest.mock('../utils/create-redis.js', () => ({
  createRedisClient: () => fakeRedisClient,
}));

jest.mock('../../shared/core4-route-client.js', () => ({
  extractCore4Data: (payload: unknown) => payload,
  fetchCore4Json: jest.fn(),
}));

// Each test drives up to ~80 supertest requests (challenge + claim per attempt); the 5 s default is too tight on a cold,
// parallel CI run (two transient failures were seen), so give the whole file an explicit generous timeout.
jest.setTimeout(60_000);

const request = require('supertest');
const express = require('express');

const WALLET = (n: number) => '0x' + n.toString(16).padStart(40, '0');
const solve = (q: string) => { const m = q.match(/What is (\d+) \+ (\d+)\?/); if (!m) throw new Error('captcha'); return String(Number(m[1]) + Number(m[2])); };

function build(opts: { trustedProxies?: string } = {}) {
  jest.resetModules();
  redisState.addressClaims.clear(); redisState.ipClaims.clear(); redisUnavailable = false;
  if (opts.trustedProxies === undefined) delete process.env.TRUSTED_PROXIES; else process.env.TRUSTED_PROXIES = opts.trustedProxies;
  process.env.FAUCET_SERVICE_URL = 'https://faucet.wrfcoin.test/claim';
  const fetchMock = jest.fn(async () => ({ ok: true, text: async () => JSON.stringify({ txHash: '0x' + 'f'.repeat(64), amount: '100', balance: '100' }) }));
  (global as any).fetch = fetchMock;
  const { trustKnownProxy } = require('../utils/trustedProxyConfig');
  const routes = require('../routes/onboarding-routes').default;
  const app = express();
  app.set('trust proxy', trustKnownProxy); // exactly what the live entrypoint does
  app.use(express.json());
  app.use('/api/onboarding', routes);
  return { app, fetchMock };
}

// Each challenge comes from its own unrelated IPv4 client, so the CLAIM limiter is what is under test.
let challengeSource = 0;
async function claim(app: any, wallet: string, xff?: string) {
  challengeSource += 1;
  const ch = await request(app).post('/api/onboarding/faucet/challenge').set('X-Forwarded-For', `203.0.${Math.floor(challengeSource / 250)}.${(challengeSource % 250) + 1}`);
  let r = request(app).post('/api/onboarding/faucet/claim');
  if (xff) r = r.set('X-Forwarded-For', xff);
  return r.send({ walletAddress: wallet, challengeId: ch.body.challengeId, answer: solve(ch.body.question) });
}

describe('faucet claim limiting keys (IPv6 /64)', () => {
  afterEach(() => { jest.restoreAllMocks(); delete process.env.FAUCET_SERVICE_URL; delete process.env.TRUSTED_PROXIES; });

  it.each([[23 * 3_600_000, '3600'], [86_400_000 - 1, '1']])(
    'reports accurate quota Retry-After at offset %d', async (offset, expected) => {
      const { app, fetchMock } = build();
      const start = 1_800_000_000_000;
      const clock = jest.spyOn(Date, 'now');
      for (let i = 0; i < 5; ++i) {
        clock.mockReturnValue(start + i * 3_600_000);
        expect((await claim(app, WALLET(730 + i), '192.0.2.110')).status).toBe(200);
      }
      clock.mockReturnValue(start + offset);
      const rejected = await claim(app, WALLET(740), '192.0.2.110');
      expect(rejected.status).toBe(429);
      expect(rejected.body.error.code).toBe('RATE_LIMITED');
      expect(rejected.headers['retry-after']).toBe(expected);
      expect(fetchMock).toHaveBeenCalledTimes(5);
    }
  );

  it('reports the remaining wallet cooldown across independent IPs', async () => {
    const { app, fetchMock } = build();
    const start = 1_800_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    expect((await claim(app, WALLET(750), '192.0.2.120')).status).toBe(200);
    for (const [offset, expected] of [[23 * 3_600_000, '3600'], [86_400_000 - 1, '1']] as const) {
      clock.mockReturnValue(start + offset);
      const rejected = await claim(app, WALLET(750), '192.0.2.121');
      expect(rejected.status).toBe(429);
      expect(rejected.body.error.code).toBe('ALREADY_CLAIMED');
      expect(rejected.headers['retry-after']).toBe(expected);
    }
    clock.mockReturnValue(start + 86_400_000);
    expect((await claim(app, WALLET(750), '192.0.2.121')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('clamps a rejected zero-second wait to one second', async () => {
    const { app, fetchMock } = build();
    fakeRedisClient.eval.mockResolvedValueOnce([0, 'RATE_LIMITED', '', 0]);
    const rejected = await claim(app, WALLET(760), '192.0.2.130');
    expect(rejected.status).toBe(429);
    expect(rejected.headers['retry-after']).toBe('1');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('40 addresses in one /64 are limited TOGETHER (5 per 24 hours per client), another /64 is not', async () => {
    const { app, fetchMock } = build();
    const codes: number[] = [];
    for (let i = 0; i < 40; i += 1) codes.push((await claim(app, WALLET(i + 1), `2001:db8:abcd:12:${(i + 1).toString(16)}::${i + 7}`)).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(codes.slice(5).every((c) => c === 429)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    const rejected = await claim(app, WALLET(500), '2001:db8:abcd:12:ffff::1');
    expect(rejected.body.error.code).toBe('RATE_LIMITED');
    // a different /64 is a different client
    expect((await claim(app, WALLET(501), '2001:db8:abcd:13::1')).status).toBe(200);
  });

  it('rotating wallets after one hour cannot replenish the daily IP budget; the exact 24-hour boundary can', async () => {
    const { app, fetchMock } = build();
    const start = 1_800_000_000_000;
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start);
    for (let i = 0; i < 5; i += 1) {
      expect((await claim(app, WALLET(600 + i), '2001:db8:abcd:50::1')).status).toBe(200);
    }
    clock.mockReturnValue(start + 60 * 60 * 1000 + 1);
    expect((await claim(app, WALLET(610), '2001:db8:abcd:50::2')).status).toBe(429);
    clock.mockReturnValue(start + 24 * 60 * 60 * 1000 - 1);
    expect((await claim(app, WALLET(611), '2001:db8:abcd:50::3')).status).toBe(429);
    expect(fetchMock).toHaveBeenCalledTimes(5);
    // Other clients retain their own daily allowance.
    expect((await claim(app, WALLET(612), '2001:db8:abcd:51::1')).status).toBe(200);
    clock.mockReturnValue(start + 24 * 60 * 60 * 1000);
    expect((await claim(app, WALLET(613), '2001:db8:abcd:50::4')).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it('IPv4 is unchanged (full address) and IPv4-mapped IPv6 is the same client as its IPv4', async () => {
    const { app } = build();
    for (let i = 0; i < 5; i += 1) expect((await claim(app, WALLET(100 + i), '192.0.2.10')).status).toBe(200);
    expect((await claim(app, WALLET(110), '192.0.2.10')).body.error?.code).toBe('RATE_LIMITED');
    expect((await claim(app, WALLET(111), '192.0.2.11')).status).toBe(200); // another IPv4 address: its own budget
    expect((await claim(app, WALLET(112), '::ffff:192.0.2.10')).body.error?.code).toBe('RATE_LIMITED'); // same client
  });

  it('a client-supplied X-Forwarded-For entry LEFT of the trusted chain is ignored (right-to-left, trusted hops only)', async () => {
    const { app } = build();
    // The socket peer (loopback) is a trusted hop; the rightmost entry is the real client, everything left of it is the caller's claim.
    for (let i = 0; i < 5; i += 1) expect((await claim(app, WALLET(200 + i), `10.${i}.${i}.${i}, 198.51.100.77`)).status).toBe(200);
    const sixth = await claim(app, WALLET(210), '172.31.9.9, 198.51.100.77');
    expect(sixth.status).toBe(429);
  });

  it('X-Forwarded-For from an UNTRUSTED hop is ignored: forging it cannot mint a fresh key', async () => {
    // Only 10.251.0.1 is a trusted proxy here, so the loopback test peer is a plain client and its header is just text.
    const { app, fetchMock } = build({ trustedProxies: '10.251.0.1' });
    const codes: number[] = [];
    // (12 attempts: from this untrusted peer every challenge request is ALSO one client, capped at 30 a minute)
    for (let i = 0; i < 12; i += 1) codes.push((await claim(app, WALLET(300 + i), `2001:db8:${i.toString(16)}:${i.toString(16)}::1`)).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it('the dispenser still receives the real client address, not the bucket key', async () => {
    const { app, fetchMock } = build();
    expect((await claim(app, WALLET(400), '2001:db8:abcd:12::99')).status).toBe(200);
    const sent = JSON.stringify((fetchMock.mock.calls[0] as any[]) ?? []);
    expect(sent).not.toContain('/64');
  });
});

describe('faucet challenge issuance is bounded per /64 and in total', () => {
  afterEach(() => { jest.restoreAllMocks(); delete process.env.FAUCET_SERVICE_URL; delete process.env.TRUSTED_PROXIES; });

  it('40 challenge requests from addresses in one /64 share one per-minute budget; another /64 is unaffected', async () => {
    const { app } = build();
    const codes: number[] = [];
    for (let i = 0; i < 40; i += 1) codes.push((await request(app).post('/api/onboarding/faucet/challenge').set('X-Forwarded-For', `2001:db8:5:6:${(i + 1).toString(16)}::${i + 1}`)).status);
    expect(codes.filter((c) => c === 200)).toHaveLength(30);
    expect(codes.slice(30).every((c) => c === 429)).toBe(true);
    expect((await request(app).post('/api/onboarding/faucet/challenge').set('X-Forwarded-For', '2001:db8:5:7::1')).status).toBe(200);
    expect((await request(app).post('/api/onboarding/faucet/challenge').set('X-Forwarded-For', '192.0.2.200')).status).toBe(200);
  });

  it('the outstanding-challenge store is hard-capped (oldest evicted)', async () => {
    const { app } = build();
    const mod = require('../routes/onboarding-routes');
    mod.setMaxOutstandingChallengesForTests(8);
    for (let i = 0; i < 40; i += 1) await request(app).post('/api/onboarding/faucet/challenge').set('X-Forwarded-For', `198.51.${i}.1`);
    expect(mod.getChallengeCountForTests()).toBeLessThanOrEqual(8);
    expect(mod.getChallengeCountForTests()).toBeGreaterThan(0);
  });
});
