import { readFileSync } from 'node:fs';
/**
 * Integration tests for Onboarding/Faucet API routes
 * Tests captcha challenge generation, token claiming, and rate limiting
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

const request = require('supertest');
const express = require('express');

// Must import after module is available
let onboardingRoutes: any;
let onboardingRoutesModule: any;

// Create test app
const createTestApp = (): Application => {
  const app = express();
  app.use(express.json());

  // Mock req.ip
  app.use((req: any, _res: any, next: any) => {
    Object.defineProperty(req, 'ip', {
      value: '192.168.1.1',
      writable: false,
      enumerable: true,
      configurable: true,
    });
    next();
  });

  app.use('/api/onboarding', onboardingRoutes);

  return app;
};

const solveCaptcha = (question: string): string => {
  const match = question.match(/What is (\d+) \+ (\d+)\?/);
  if (!match) {
    throw new Error('Unexpected captcha format');
  }
  return String(Number(match[1]) + Number(match[2]));
};

const clearRedisState = () => {
  redisState.addressClaims.clear();
  redisState.ipClaims.clear();
};

describe('Onboarding Faucet Routes', () => {
  let app: Application;
  let fetchMock: any;
  // The route's IP_RATE_LIMIT; kept local so the test states its own expectation.
  const IP_LIMIT_FOR_TEST = 5;
  const dispenseCallCount = () => fetchMock.mock.calls.length;

  beforeEach(() => {
    jest.resetModules();
    clearRedisState();
    redisUnavailable = false;
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
    process.env.FAUCET_SERVICE_URL = 'https://faucet.wrfcoin.test/claim';
    // Re-require the routes module to get a fresh instance with clean Maps
    onboardingRoutesModule = require('../routes/onboarding-routes');
    onboardingRoutes = onboardingRoutesModule.default;
    app = createTestApp();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.FAUCET_SERVICE_URL;
  });

  describe('POST /api/onboarding/faucet/challenge', () => {
    it('should return challengeId and question matching /What is \\d+ \\+ \\d+\\?/', async () => {
      const response = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);

      expect(response.body).toHaveProperty('challengeId');
      expect(response.body).toHaveProperty('question');
      expect(typeof response.body.challengeId).toBe('string');
      expect(response.body.challengeId.length).toBeGreaterThan(0);
      expect(response.body.question).toMatch(/^What is \d+ \+ \d+\?$/);
    });
  });

  describe('POST /api/onboarding/faucet/claim', () => {
    it('should succeed with valid address and correct captcha answer', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            txHash: '0x' + 'f'.repeat(64),
            amount: '100',
            balance: '100',
          }),
      });

      // First, get a challenge
      const challengeRes = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);

      const { challengeId, question } = challengeRes.body;

      // Parse the answer from the question "What is X + Y?"
      const answer = solveCaptcha(question);

      const response = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress: '0x' + 'a'.repeat(40),
          challengeId,
          answer,
        })
        .expect(200);

      expect(response.body.disclaimer).toBe('This is a test network. It may be reset without notice. Balances and tokens have no monetary value. No migration to mainnet is promised or implied. Please attach no production bridges, exchange listings or irreplaceable assets. https://wrfcoin-testnet.taila1c049.ts.net/testnet-disclaimer.html');
      expect(challengeRes.body.disclaimer).toBe(response.body.disclaimer);
      expect(response.body).toHaveProperty('txHash');
      expect(response.body).toHaveProperty('amount');
      expect(response.body).toHaveProperty('balance');
      expect(typeof response.body.txHash).toBe('string');
      expect(response.body.txHash).toBe('0x' + 'f'.repeat(64));
      expect(response.body.amount).toBe('100');
      expect(response.body.balance).toBe('100');
    });

    it('should read txHash from the infra faucet receipt envelope', async () => {
      // The exact success body infra testnet/services/faucet/server.js sends:
      // the hash lives under `receipt`, never at the top level.
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            ok: true,
            amount: '10',
            denomination: 'WRF',
            rateLimitResetsAt: '2026-10-06T00:00:00.000Z',
            ipFingerprint: 'abc123',
            receipt: {
              txHash: '0x' + '9'.repeat(64),
              balance: '990',
              amount: '10',
              denomination: 'WRF',
              state: 'approved',
            },
          }),
      });

      const challengeRes = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);
      const { challengeId, question } = challengeRes.body;

      const response = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress: '0x' + 'b'.repeat(40),
          challengeId,
          answer: solveCaptcha(question),
        })
        .expect(200);

      expect(response.body.txHash).toBe('0x' + '9'.repeat(64));
      expect(response.body.amount).toBe('10');
      expect(response.body.balance).toBe('990');
    });

    it('should send the faucet service bearer token when configured (#857 Option B)', async () => {
      process.env.FAUCET_SERVICE_TOKEN = 'faucet-proxy-secret';
      jest.resetModules();
      onboardingRoutes = require('../routes/onboarding-routes').default;
      app = createTestApp();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({ txHash: '0x' + 'f'.repeat(64), amount: '100', balance: '100' }),
      });

      const challengeRes = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);
      const { challengeId, question } = challengeRes.body;
      const answer = solveCaptcha(question);

      await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({ walletAddress: '0x' + 'a'.repeat(40), challengeId, answer })
        .expect(200);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://faucet.wrfcoin.test/claim',
        expect.objectContaining({
          headers: expect.objectContaining({
            authorization: 'Bearer faucet-proxy-secret',
          }),
        })
      );
      delete process.env.FAUCET_SERVICE_TOKEN;
    });

    it('should omit the authorization header when no service token is configured', async () => {
      delete process.env.FAUCET_SERVICE_TOKEN;
      delete process.env.WRFCOIN_OPERATOR_TOKEN;
      jest.resetModules();
      onboardingRoutes = require('../routes/onboarding-routes').default;
      app = createTestApp();

      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({ txHash: '0x' + 'f'.repeat(64), amount: '100', balance: '100' }),
      });

      const challengeRes = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);
      const { challengeId, question } = challengeRes.body;
      const answer = solveCaptcha(question);

      await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({ walletAddress: '0x' + 'a'.repeat(40), challengeId, answer })
        .expect(200);

      const [, fetchInit] = fetchMock.mock.calls[0];
      expect(fetchInit.headers).not.toHaveProperty('authorization');
    });

    it('should reject native wallet addresses with EVM_ADDRESS_REQUIRED without consuming the challenge', async () => {
      // The infra dispenser only pays 0x-format addresses (infra#611); the
      // proxy must fail fast — before captcha/cooldown — with a clear code.
      // Flip back to native acceptance when the dispenser learns native
      // addresses (infra#621).
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            txHash: '0x' + 'e'.repeat(64),
            amount: '100',
            balance: '250',
          }),
      });

      const challengeRes = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);

      const { challengeId, question } = challengeRes.body;
      const answer = solveCaptcha(question);

      const rejected = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress: 'wrf' + 'a'.repeat(40),
          challengeId,
          answer,
        })
        .expect(400);

      expect(rejected.body.error.code).toBe('EVM_ADDRESS_REQUIRED');
      expect(rejected.body.error.message).toMatch(/0x/);
      // The dispenser must never be called for a native address.
      expect(fetchMock).not.toHaveBeenCalled();

      // The guard runs before the challenge lookup, so the SAME challenge is
      // still valid for a corrected EVM-format retry.
      const retried = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress: '0x' + 'a'.repeat(40),
          challengeId,
          answer,
        })
        .expect(200);

      expect(retried.body.txHash).toBe('0x' + 'e'.repeat(64));
      expect(retried.body.balance).toBe('250');
    });

    it('should reject invalid wallet address with INVALID_ADDRESS', async () => {
      // Get a challenge first
      const challengeRes = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);

      const response = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress: 'not-a-valid-address',
          challengeId: challengeRes.body.challengeId,
          answer: '10',
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('INVALID_ADDRESS');
      expect(response.body.error.message).toBeDefined();
    });

    it('should reject wrong captcha answer with CAPTCHA_FAILED', async () => {
      // Get a challenge first
      const challengeRes = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);

      const { challengeId, question } = challengeRes.body;

      // Parse the correct answer and provide a wrong one
      const match = question.match(/What is (\d+) \+ (\d+)\?/);
      const correctAnswer = Number(match[1]) + Number(match[2]);
      const wrongAnswer = String(correctAnswer + 1);

      const response = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress: '0x' + 'b'.repeat(40),
          challengeId,
          answer: wrongAnswer,
        })
        .expect(400);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('CAPTCHA_FAILED');
      expect(response.body.error.message).toBeDefined();
    });

    it('should reject reuse of same challenge (one-time use)', async () => {
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            txHash: '0x' + 'c'.repeat(64),
            amount: '100',
            balance: '100',
          }),
      });

      // Get a challenge
      const challengeRes = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);

      const { challengeId, question } = challengeRes.body;
      const answer = solveCaptcha(question);

      // Use it once successfully
      await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress: '0x' + 'c'.repeat(40),
          challengeId,
          answer,
        })
        .expect(200);

      // Try to reuse the same challenge
      const response = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress: '0x' + 'd'.repeat(40),
          challengeId,
          answer,
        })
        .expect(400);

      expect(response.body.error.code).toBe('CAPTCHA_FAILED');
    });

    it('should rate-limit same address within 24h with ALREADY_CLAIMED', async () => {
      const walletAddress = '0x' + 'e'.repeat(40);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            txHash: '0x' + 'd'.repeat(64),
            amount: '100',
            balance: '100',
          }),
      });

      // First claim - get challenge and solve it
      const challenge1 = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);

      const answer1 = solveCaptcha(challenge1.body.question);

      await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress,
          challengeId: challenge1.body.challengeId,
          answer: answer1,
        })
        .expect(200);

      // Second claim with same address - get a new challenge
      const challenge2 = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);

      const answer2 = solveCaptcha(challenge2.body.question);

      const response = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress,
          challengeId: challenge2.body.challengeId,
          answer: answer2,
        })
        .expect(429);

      expect(response.body).toHaveProperty('error');
      expect(response.body.error.code).toBe('ALREADY_CLAIMED');
      expect(response.body.error.message).toBeDefined();
    });

    // #924 CRITICAL-1 regression. Dan's exact-head control: two same-address
    // requests held past the "not claimed" read, released together, returned
    // [200, 200] and the dispenser ran TWICE. The equivalent same-address and
    // same-IP concurrency tests had been REMOVED from this branch, so nothing
    // caught it. Restored here.
    it('two concurrent same-address claims: exactly one dispenses (#924)', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({ txHash: '0x' + 'f'.repeat(64), amount: '100', balance: '100' }),
      });
      redisState.addressClaims.clear();
      redisState.ipClaims.clear();
      const address = '0x' + 'c'.repeat(40);

      const claim = async () => {
        const ch = await request(app).post('/api/onboarding/faucet/challenge').expect(200);
        return request(app).post('/api/onboarding/faucet/claim').send({
          walletAddress: address,
          challengeId: ch.body.challengeId,
          answer: solveCaptcha(ch.body.question),
        });
      };

      const before = dispenseCallCount();
      const [a, b] = await Promise.all([claim(), claim()]);

      // Before the atomic reservation this was [200, 200].
      expect([a.status, b.status].sort()).toEqual([200, 429]);
      expect(dispenseCallCount() - before).toBe(1);
    });

    it('concurrent claims from one IP never exceed the IP quota (#924)', async () => {
      // The IP quota lived in the same split check/write, so fixing only the
      // address key would have left this race open.
      fetchMock.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({ txHash: '0x' + 'f'.repeat(64), amount: '100', balance: '100' }),
      });
      redisState.addressClaims.clear();
      redisState.ipClaims.clear();
      const attempts = IP_LIMIT_FOR_TEST + 3;
      const before = dispenseCallCount();

      const results = await Promise.all(
        Array.from({ length: attempts }, async (_unused, i) => {
          const ch = await request(app).post('/api/onboarding/faucet/challenge').expect(200);
          return request(app).post('/api/onboarding/faucet/claim').send({
            walletAddress: '0x' + i.toString(16).padStart(40, 'd'),
            challengeId: ch.body.challengeId,
            answer: solveCaptcha(ch.body.question),
          });
        })
      );

      const dispensed = results.filter((r) => r.status === 200).length;
      expect(dispensed).toBeLessThanOrEqual(IP_LIMIT_FOR_TEST);
      expect(dispenseCallCount() - before).toBe(dispensed);
    });

    it('should return FAUCET_EMPTY and not consume the cooldown when dispense fails', async () => {
      const walletAddress = '0x' + '1'.repeat(40);
      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 503,
        text: async () =>
          JSON.stringify({
            error: {
              code: 'FAUCET_EMPTY',
              message: 'Faucet temporarily unavailable',
            },
          }),
      });

      const firstChallenge = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);
      const firstAnswer = solveCaptcha(firstChallenge.body.question);

      const failed = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress,
          challengeId: firstChallenge.body.challengeId,
          answer: firstAnswer,
        })
        .expect(503);

      expect(failed.body.error.code).toBe('FAUCET_EMPTY');

      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            txHash: '0x' + '2'.repeat(64),
            amount: '100',
            balance: '100',
          }),
      });

      const secondChallenge = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);
      const secondAnswer = solveCaptcha(secondChallenge.body.question);

      await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress,
          challengeId: secondChallenge.body.challengeId,
          answer: secondAnswer,
        })
        .expect(200);
    });

    it('should preserve address cooldown across process restart with persisted Redis state', async () => {
      const walletAddress = '0x' + '2'.repeat(40);
      fetchMock.mockResolvedValueOnce({
        ok: true,
        text: async () =>
          JSON.stringify({
            txHash: '0x' + '3'.repeat(64),
            amount: '100',
            balance: '100',
          }),
      });

      const firstChallenge = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);
      const firstAnswer = solveCaptcha(firstChallenge.body.question);

      await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress,
          challengeId: firstChallenge.body.challengeId,
          answer: firstAnswer,
        })
        .expect(200);

      // Simulate process restart by re-loading the route module; redis state is preserved
      jest.resetModules();
      onboardingRoutes = require('../routes/onboarding-routes').default;
      app = createTestApp();

      const secondChallenge = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);
      const secondAnswer = solveCaptcha(secondChallenge.body.question);

      const response = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress,
          challengeId: secondChallenge.body.challengeId,
          answer: secondAnswer,
        })
        .expect(429);

      expect(response.body.error.code).toBe('ALREADY_CLAIMED');
    });

    it('should fail closed when Redis is unreachable', async () => {
      const walletAddress = '0x' + '4'.repeat(40);
      redisUnavailable = true;

      const challengeRes = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);
      const answer = solveCaptcha(challengeRes.body.question);

      const response = await request(app)
        .post('/api/onboarding/faucet/claim')
        .send({
          walletAddress,
          challengeId: challengeRes.body.challengeId,
          answer,
        })
        .expect(503);

      expect(response.body.error.code).toBe('FAUCET_RATE_LIMIT_STORE_UNAVAILABLE');
      expect(response.body.error.message).toBe(
        'Faucet claim rate limiting store is temporarily unavailable'
      );
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('sweepExpiredChallenges (audit/api-report-2026-09-09.md P3)', () => {
    // `/faucet/challenge` stamps `createdAt` from `Date.now()`, so the clock is
    // pinned here and each challenge is minted at an explicit, deliberately
    // separated instant. Reading the real clock made "exactly one expires" a
    // millisecond race: two challenges minted inside the same millisecond share
    // a `createdAt`, and a sweep at `staleCreatedAt + TTL + 1` then removes both.
    const CHALLENGE_TTL_MS = 5 * 60 * 1000;
    const T0 = Date.parse('2026-09-09T00:00:00.000Z');
    // Gap between the two challenges. Any value > 0 removes the race; a whole
    // minute makes the two TTL windows unambiguously distinct.
    const CREATION_GAP_MS = 60_000;

    let currentNow = T0;
    const setClock = (value: number): void => {
      currentNow = value;
    };
    const pinClock = (): void => {
      currentNow = T0;
      jest.spyOn(Date, 'now').mockImplementation(() => currentNow);
    };

    it('retains a challenge at exactly CHALLENGE_TTL_MS and removes it one ms later', async () => {
      const { sweepExpiredChallenges, getChallengeCountForTests } = onboardingRoutesModule;
      pinClock();

      // Stale challenge — created at exactly T0.
      const staleCreatedAt = T0;
      setClock(staleCreatedAt);
      const staleChallenge = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);

      // Live challenge — created a deliberate minute later, so its TTL window
      // ends CREATION_GAP_MS after the stale challenge's.
      const liveCreatedAt = T0 + CREATION_GAP_MS;
      setClock(liveCreatedAt);
      const liveChallenge = await request(app)
        .post('/api/onboarding/faucet/challenge')
        .expect(200);

      expect(staleChallenge.body.challengeId).not.toBe(liveChallenge.body.challengeId);
      expect(getChallengeCountForTests()).toBe(2);

      // Boundary 1 — exactly at the stale challenge's TTL. The sweep predicate
      // is `now - createdAt > TTL`, so an age of exactly TTL is still live.
      expect(sweepExpiredChallenges(staleCreatedAt + CHALLENGE_TTL_MS)).toBe(0);
      expect(getChallengeCountForTests()).toBe(2);

      // Boundary 2 — one millisecond past it. Exactly the stale challenge goes;
      // the live one is only (TTL + 1 - CREATION_GAP_MS) old, still inside its
      // own window.
      expect(sweepExpiredChallenges(staleCreatedAt + CHALLENGE_TTL_MS + 1)).toBe(1);
      expect(getChallengeCountForTests()).toBe(1);

      // Boundary 3 — exactly at the live challenge's own TTL: still retained.
      expect(sweepExpiredChallenges(liveCreatedAt + CHALLENGE_TTL_MS)).toBe(0);
      expect(getChallengeCountForTests()).toBe(1);

      // ...and it is genuinely still claimable at that same instant, because
      // the claim path applies the same `> TTL` rule as the sweeper.
      setClock(liveCreatedAt + CHALLENGE_TTL_MS);
      const claimRes = await request(app).post('/api/onboarding/faucet/claim').send({
        walletAddress: '0x' + 'b'.repeat(40),
        challengeId: liveChallenge.body.challengeId,
        answer: solveCaptcha(liveChallenge.body.question),
      });
      expect(claimRes.status).not.toBe(400);

      // The swept challenge is really gone, not merely past TTL — claiming it
      // 400s as "not found", the same as any unknown challengeId.
      const staleClaimRes = await request(app).post('/api/onboarding/faucet/claim').send({
        walletAddress: '0x' + 'c'.repeat(40),
        challengeId: staleChallenge.body.challengeId,
        answer: solveCaptcha(staleChallenge.body.question),
      });
      expect(staleClaimRes.status).toBe(400);
      expect(staleClaimRes.body.error.code).toBe('CAPTCHA_FAILED');
    });

    it('removes the later challenge too once its own TTL is passed', async () => {
      const { sweepExpiredChallenges, getChallengeCountForTests } = onboardingRoutesModule;
      pinClock();

      const firstCreatedAt = T0;
      setClock(firstCreatedAt);
      await request(app).post('/api/onboarding/faucet/challenge').expect(200);

      const secondCreatedAt = T0 + CREATION_GAP_MS;
      setClock(secondCreatedAt);
      await request(app).post('/api/onboarding/faucet/challenge').expect(200);

      expect(getChallengeCountForTests()).toBe(2);

      // One ms past the LATER challenge's TTL — by then both are expired.
      expect(sweepExpiredChallenges(secondCreatedAt + CHALLENGE_TTL_MS + 1)).toBe(2);
      expect(getChallengeCountForTests()).toBe(0);
    });

    it('is a no-op when nothing has expired', async () => {
      const { sweepExpiredChallenges, getChallengeCountForTests } = onboardingRoutesModule;
      pinClock();

      setClock(T0);
      await request(app).post('/api/onboarding/faucet/challenge').expect(200);
      setClock(T0 + CREATION_GAP_MS);
      await request(app).post('/api/onboarding/faucet/challenge').expect(200);
      expect(getChallengeCountForTests()).toBe(2);

      // Sweeping at the moment the newest challenge was created: nothing has
      // aged past TTL yet.
      const removed = sweepExpiredChallenges(T0 + CREATION_GAP_MS);

      expect(removed).toBe(0);
      expect(getChallengeCountForTests()).toBe(2);
    });
  });
});

test('API documentation preserves the faucet disclaimer contract and canonical URL', () => {
  const doc = readFileSync('docs/api/faucet-disclaimer.md', 'utf8');
  expect(doc).toContain('`disclaimer` string');
  expect(doc).toContain('https://wrfcoin-testnet.taila1c049.ts.net/testnet-disclaimer.html');
  expect(doc).toContain('No migration to mainnet is promised or implied.');
});
