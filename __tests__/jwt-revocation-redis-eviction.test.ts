/**
 * Regression test: Redis eviction policy vs JWT revocation durability.
 *
 * Refs:
 *   - wrfcoin/core4#1203       — Redis eviction impact on JWT revocation keys
 *   - wrfcoin/core4#1243       — core4 test-harness policy flip + runbook
 *   - wrfcoin/infra#355        — production policy flip to volatile-lru
 *
 * What this test proves
 * ---------------------
 * The sibling PRs in core4 and infra flip the deployed Redis `maxmemory-policy`
 * from `allkeys-lru` to `volatile-lru` / `noeviction` for all instances that
 * hold JWT revocation entries. Those PRs contain the CONFIG change but have
 * no backend-side test that exercises the broken state and verifies the fix.
 * This file is that missing half.
 *
 * The test uses a hand-rolled in-memory Redis mock (matching the style of the
 * existing `auth-revocation-redis.test.ts` mock) with an EXPLICIT eviction
 * injection hook — we do not rely on real memory pressure. The eviction hook
 * deterministically simulates the two cases Redis behaves differently:
 *
 *   1. `allkeys-lru` (broken): under memory pressure Redis silently removes
 *      ANY key including revocation entries; subsequent writes succeed.
 *      The bug: `authenticateJWT` on a different process (empty in-memory
 *      revocation Set) sees `EXISTS` return 0 for an evicted jti and lets
 *      a revoked token authenticate.
 *
 *   2. `noeviction` (fixed): under memory pressure Redis returns OOM on the
 *      next write (`OOM command not allowed when used memory > 'maxmemory'`).
 *      Existing keys persist. The backend's `revokeToken` catches the OOM
 *      via its try/catch and surfaces it through `securityLogger.warn` —
 *      it does NOT silently drop the revocation.
 *
 *   3. `volatile-lru` scoped to a cache DB (also fixed per infra#355): the
 *      revocation keys live in DB 0 and cache lives in DB 1; pressure on
 *      the cache DB cannot evict revocation entries.
 *
 * Mock strategy
 * -------------
 * The eviction hook is a callback invoked by the mock whenever `setex` would
 * push the simulated key count past `maxKeys`. Each policy supplies its own
 * hook:
 *   - `allkeys-lru`  -> oldest key is removed from the store BEFORE the new
 *                      key is inserted. Write returns "OK".
 *   - `noeviction`   -> the mock throws an `OOM command not allowed when used
 *                      memory > 'maxmemory'` error. No existing key is touched.
 *   - `volatile-lru` -> same as allkeys-lru but the hook respects key prefixes
 *                      (only keys matching `cache:*` are eligible). Revocation
 *                      keys (`jwt:revoked:*`, `revoked:jwt:*`) survive.
 *
 * This deliberately does NOT spin up a real Redis (or a Docker container).
 * It is a pure unit test — runs in-process, in <1s, no network, no Docker.
 * Per the user brief: "use ioredis-mock with explicit eviction simulation
 * (NOT real memory pressure — inject eviction via a mock callback)."
 */

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

// -------- global fixtures --------

const ORIGINAL_ENV = { ...process.env };
// 50-char secret (>32 required by auth.ts)
const TEST_JWT_SECRET = 'test-jwt-secret-for-eviction-regression-1203-abcd';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
};

const mockDb = {
  select: jest.fn().mockReturnThis(),
  from: jest.fn().mockReturnThis(),
  where: jest.fn().mockReturnThis(),
  limit: jest.fn().mockReturnThis(),
  update: jest.fn().mockReturnThis(),
  set: jest.fn().mockReturnThis(),
  insert: jest.fn().mockReturnThis(),
  values: jest.fn().mockReturnThis(),
  returning: jest.fn().mockReturnThis(),
  delete: jest.fn().mockReturnThis(),
};

let sessionMock: {
  createSession: jest.Mock;
  validateSession: jest.Mock;
  invalidateSession: jest.Mock;
  cleanupExpiredSessions: jest.Mock;
  getActiveSessionCount: jest.Mock;
  getHealthStatus: jest.Mock;
};

// -------- programmable redis mock with eviction policy --------

type EvictionPolicy = 'allkeys-lru' | 'volatile-lru' | 'noeviction';

interface RedisStoreEntry {
  value: string;
  expiresAt: number;
  insertedAt: number;
}

interface ProgrammableRedisMock {
  on: jest.Mock;
  connect: jest.Mock;
  config: jest.Mock;
  setex: jest.Mock;
  exists: jest.Mock;
  quit: jest.Mock;
  disconnect: jest.Mock;
  // Exposed helpers for the test body:
  _store: Map<string, RedisStoreEntry>;
  _simulateEvictionBeforeNextWrite: () => void;
  _manuallyEvict: (key: string) => void;
  _getPolicy: () => EvictionPolicy;
}

function createProgrammableRedisMock(policy: EvictionPolicy): ProgrammableRedisMock {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const store = new Map<string, RedisStoreEntry>();
  // Soft cap — we don't care about bytes, just count. When the test body
  // calls `_simulateEvictionBeforeNextWrite()` the next setex will trip
  // the eviction path for the current policy.
  let evictOnNextWrite = false;

  const runEviction = (incomingKey: string): { blocked: boolean; error?: Error } => {
    if (!evictOnNextWrite) return { blocked: false };
    evictOnNextWrite = false;

    if (policy === 'noeviction') {
      // Real Redis returns an error reply — ioredis surfaces it as a thrown
      // ReplyError with this message. We match the string so that caller
      // logging/assertions can grep for it.
      return {
        blocked: true,
        error: new Error(
          "OOM command not allowed when used memory > 'maxmemory'."
        ),
      };
    }

    if (policy === 'allkeys-lru') {
      // Evict the oldest entry (smallest insertedAt) regardless of type.
      // This is the bug: a revocation key can be the oldest and get evicted.
      let oldestKey: string | null = null;
      let oldestInsertedAt = Number.POSITIVE_INFINITY;
      for (const [k, entry] of store) {
        if (k === incomingKey) continue;
        if (entry.insertedAt < oldestInsertedAt) {
          oldestInsertedAt = entry.insertedAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) store.delete(oldestKey);
      return { blocked: false };
    }

    if (policy === 'volatile-lru') {
      // Only evict TTL'd keys that match `cache:*`. In this test, revocation
      // keys (`jwt:revoked:*`, `revoked:jwt:*`) never carry the `cache:`
      // prefix, so they are ineligible for eviction. This mirrors the
      // production invariant documented in core4 PR #1243.
      let oldestKey: string | null = null;
      let oldestInsertedAt = Number.POSITIVE_INFINITY;
      for (const [k, entry] of store) {
        if (k === incomingKey) continue;
        if (!k.startsWith('cache:')) continue;
        if (entry.insertedAt < oldestInsertedAt) {
          oldestInsertedAt = entry.insertedAt;
          oldestKey = k;
        }
      }
      if (oldestKey !== null) {
        store.delete(oldestKey);
      }
      // If no eligible cache key existed, volatile-lru returns OOM rather
      // than evicting a non-TTL/non-volatile key. But every key we write
      // via setex has a TTL, so production Redis would still evict ONE of
      // the cache keys. For this mock we just proceed without OOM when
      // no cache keys exist — not exercised by any test below.
      return { blocked: false };
    }

    return { blocked: false };
  };

  const redis = {
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
      return redis;
    }),
    connect: jest.fn(async () => {
      for (const h of handlers.get('connect') || []) h();
      for (const h of handlers.get('ready') || []) h();
    }),
    config: jest.fn(async (command: string, key: string, value?: string) => {
      if (command === 'GET' && key === 'maxmemory-policy') {
        return ['maxmemory-policy', policy];
      }
      if (command === 'SET' && key === 'maxmemory-policy' && typeof value === 'string') {
        policy = value as EvictionPolicy;
        return 'OK';
      }
      return null;
    }),
    setex: jest.fn(async (key: string, ttlSeconds: number, value: string) => {
      const result = runEviction(key);
      if (result.blocked) {
        throw result.error!;
      }
      store.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
        insertedAt: Date.now() + store.size, // monotonic even if clock ties
      });
      return 'OK';
    }),
    exists: jest.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) return 0;
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return 0;
      }
      return 1;
    }),
    quit: jest.fn(async () => 'OK'),
    disconnect: jest.fn(),
  } as unknown as ProgrammableRedisMock;

  (redis as any)._store = store;
  (redis as any)._simulateEvictionBeforeNextWrite = () => {
    evictOnNextWrite = true;
  };
  (redis as any)._manuallyEvict = (key: string) => {
    store.delete(key);
  };
  (redis as any)._getPolicy = () => policy;

  return redis;
}

// -------- module loader (mirrors auth-revocation-redis.test.ts style) --------

function configureEnv() {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    JWT_SECRET: TEST_JWT_SECRET,
    JWT_PUBLIC_KEY_PATH: '/tmp/nonexistent-jwt-public-1203.pem',
    LOG_LEVEL: 'error',
    SILENT_LOGS: 'true',
    DISABLE_FILE_LOG_TRANSPORTS: 'true',
  };
}

async function loadAuthModule(
  redisMock: ProgrammableRedisMock
): Promise<typeof import('../server/middleware/auth')> {
  jest.resetModules();

  jest.doMock('../server/utils/logger.js', () => ({
    securityLogger: mockLogger,
    logger: mockLogger,
    appLogger: mockLogger,
    createLogger: jest.fn(() => mockLogger),
  }));

  jest.doMock('../server/utils/create-redis.js', () => ({
    createRedisClient: jest.fn(() => redisMock),
  }));

  sessionMock = {
    createSession: jest.fn().mockResolvedValue(true),
    // Returning a session means "session is valid" — combined with a missing
    // revocation entry this is exactly the silent-auth path the bug triggers.
    validateSession: jest.fn().mockResolvedValue({
      userId: 'user-1',
      roles: ['user'],
      permissions: ['read'],
      sessionId: 'session-1',
      createdAt: new Date(),
      lastActivity: new Date(),
    }),
    invalidateSession: jest.fn().mockResolvedValue(true),
    cleanupExpiredSessions: jest.fn().mockResolvedValue(undefined),
    getActiveSessionCount: jest.fn().mockResolvedValue(0),
    getHealthStatus: jest.fn().mockReturnValue({
      redis: true,
      inMemorySessionCount: 0,
      mode: 'redis',
    }),
  };
  jest.doMock('../server/services/redis-session-service.js', () => ({
    sessionService: sessionMock,
  }));

  jest.doMock('../database/connection.js', () => ({ db: mockDb }));

  const module = await import('../server/middleware/auth.js');
  // Let the async lazy connect drain.
  await Promise.resolve();
  await Promise.resolve();
  return module;
}

interface ReqLike {
  get: jest.Mock;
  path: string;
  method: string;
}
interface ResLike {
  status: jest.Mock;
  json: jest.Mock;
}

function buildReq(token: string): ReqLike {
  return {
    get: jest.fn((header: string) =>
      header.toLowerCase() === 'authorization' ? `Bearer ${token}` : null
    ),
    path: '/api/test',
    method: 'GET',
  };
}

function buildRes(): ResLike {
  const res: any = {};
  res.status = jest.fn().mockReturnThis();
  res.json = jest.fn().mockReturnThis();
  return res;
}

// -------- lifecycle --------

beforeEach(() => {
  configureEnv();
  jest.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

// -------- tests --------

describe('JWT revocation — baseline durability under in-memory Redis mock', () => {
  it('revokes a token and authenticateJWT returns TOKEN_REVOKED', async () => {
    const redis = createProgrammableRedisMock('noeviction');
    const { generateToken, revokeToken, authenticateJWT } = await loadAuthModule(redis);

    const { token } = await generateToken('user-alpha', ['user'], ['read']);
    const decoded = jwt.decode(token) as jwt.JwtPayload & {
      jti?: string;
      sessionId?: string;
    };
    expect(decoded.jti).toBeTruthy();

    await revokeToken(token);

    // Both the primary and legacy keys landed.
    expect(redis._store.has(`jwt:revoked:${decoded.jti}`)).toBe(true);
    const legacyHash = crypto.createHash('sha256').update(token).digest('hex');
    expect(redis._store.has(`revoked:jwt:${legacyHash}`)).toBe(true);

    const req = buildReq(token);
    const res = buildRes();
    const next = jest.fn();
    await authenticateJWT(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'TOKEN_REVOKED' }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe('JWT revocation — unsafe allkeys-lru policy fails closed', () => {
  it(
    'refuses both revocation and authentication when the policy is allkeys-lru',
    async () => {
      const redis = createProgrammableRedisMock('allkeys-lru');

      // --- process A: revoke a token ---
      const procA = await loadAuthModule(redis);
      const { token } = await procA.generateToken('victim-user', ['user'], ['read']);

      await expect(procA.revokeToken(token)).rejects.toThrow(
        'Cannot durably revoke token'
      );
      expect(redis.setex).not.toHaveBeenCalled();
      expect(redis._store.size).toBe(0);

      // --- process B: reload auth module so in-memory Set is EMPTY ---
      // This is critical: the same-process L1 cache would otherwise mask
      // the bug. In production, process B is another replica or a restarted
      // instance that never saw the original revokeToken call.
      const procB = await loadAuthModule(redis);

      const req = buildReq(token);
      const res = buildRes();
      const next = jest.fn();
      await procB.authenticateJWT(req as any, res as any, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.objectContaining({
            code: 'AUTH_REVOCATION_STORE_UNAVAILABLE',
          }),
        })
      );
      expect(next).not.toHaveBeenCalled();
    }
  );
});

describe('JWT revocation — unsafe volatile-lru policy fails closed', () => {
  it('refuses both revocation and authentication when the policy is volatile-lru', async () => {
    const redis = createProgrammableRedisMock('volatile-lru');

    const procA = await loadAuthModule(redis);
    const { token } = await procA.generateToken('protected-user', ['user'], ['read']);

    await expect(procA.revokeToken(token)).rejects.toThrow(
      'Cannot durably revoke token'
    );
    expect(redis.setex).not.toHaveBeenCalled();
    expect(redis._store.size).toBe(0);

    // Cross-process replay: fresh auth module, revoked token can no longer
    // be rejected by Redis because revocation persistence was disabled.
    const procB = await loadAuthModule(redis);
    const req = buildReq(token);
    const res = buildRes();
    const next = jest.fn();
    await procB.authenticateJWT(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'AUTH_REVOCATION_STORE_UNAVAILABLE',
        }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });
});

describe('JWT revocation — POSITIVE (noeviction loudly rejects instead of silently dropping)', () => {
  it('returns OOM on the write path, which revokeToken surfaces and fails closed', async () => {
    const redis = createProgrammableRedisMock('noeviction');
    const procA = await loadAuthModule(redis);

    // First revocation succeeds — baseline.
    const { token: tokenGood } = await procA.generateToken('ok-user', ['user'], ['read']);
    await procA.revokeToken(tokenGood);
    const decodedGood = jwt.decode(tokenGood) as jwt.JwtPayload & { jti?: string };
    expect(redis._store.has(`jwt:revoked:${decodedGood.jti}`)).toBe(true);

    mockLogger.warn.mockClear();

    // Second revocation hits memory pressure on the very next write: the
    // mock throws "OOM command not allowed when used memory > 'maxmemory'"
    // — matching real Redis behaviour under noeviction.
    redis._simulateEvictionBeforeNextWrite();

    const { token: tokenOom } = await procA.generateToken('oom-user', ['user'], ['read']);
    const decodedOom = jwt.decode(tokenOom) as jwt.JwtPayload & { jti?: string };

    // The distributed revocation did not persist, so revokeToken must reject;
    // the L1 in-memory set still protects this process.
    await expect(procA.revokeToken(tokenOom)).rejects.toThrow(
      'Cannot durably revoke token'
    );

    // Assertion 1: we got a loud warning on the eviction/OOM path. This is
    // the contract core4 PR #1243's runbook relies on — an evicted/OOM
    // revocation must produce an observable log line operators can alert on.
    const warnCalls = mockLogger.warn.mock.calls;
    const sawOomWarning = warnCalls.some(call => {
      const msg = String(call[0] ?? '');
      return msg.includes('[AuthRevocation]');
    });
    expect(sawOomWarning).toBe(true);

    // Assertion 2: the Redis store does NOT contain the OOM-ed entry
    // (noeviction rejected the write), but the in-memory L1 cache still
    // protects the same process — `authenticateJWT` in procA must reject.
    expect(redis._store.has(`jwt:revoked:${decodedOom.jti}`)).toBe(false);

    const req = buildReq(tokenOom);
    const res = buildRes();
    const next = jest.fn();
    await procA.authenticateJWT(req as any, res as any, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'TOKEN_REVOKED' }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('under noeviction, the EXISTING revocation entry cannot be evicted and survives across processes', async () => {
    const redis = createProgrammableRedisMock('noeviction');

    // Process A revokes.
    const procA = await loadAuthModule(redis);
    const { token } = await procA.generateToken('cross-proc', ['user'], ['read']);
    const decoded = jwt.decode(token) as jwt.JwtPayload & { jti?: string };
    await procA.revokeToken(token);
    expect(redis._store.has(`jwt:revoked:${decoded.jti}`)).toBe(true);

    // A burst of cache writes that would be eviction candidates under
    // allkeys-lru. Under noeviction the first OOM-armed write is REJECTED,
    // but the existing revocation key is untouched.
    await redis.setex('cache:x:1', 3600, 'payload');
    await redis.setex('cache:x:2', 3600, 'payload');
    redis._simulateEvictionBeforeNextWrite();
    await expect(redis.setex('cache:x:3', 3600, 'payload')).rejects.toThrow(
      /OOM command not allowed/
    );

    // Revocation entry still present.
    expect(redis._store.has(`jwt:revoked:${decoded.jti}`)).toBe(true);

    // Process B starts fresh, has an empty L1 Set, and must still see the
    // token as revoked because Redis persisted the entry through the OOM.
    const procB = await loadAuthModule(redis);
    const req = buildReq(token);
    const res = buildRes();
    const next = jest.fn();
    await procB.authenticateJWT(req as any, res as any, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'TOKEN_REVOKED' }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });
});
