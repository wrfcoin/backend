import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const ORIGINAL_ENV = { ...process.env };
const TEST_JWT_SECRET = 'test-jwt-secret-for-wallet-token-1297-123456789';
const WALLET = '0x' + 'ab'.repeat(20);

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

let currentSessionServiceMock: {
  createSession: jest.Mock;
  validateSession: jest.Mock;
  invalidateSession: jest.Mock;
  cleanupExpiredSessions: jest.Mock;
  getActiveSessionCount: jest.Mock;
  getHealthStatus: jest.Mock;
};

function createRedisMock(connectShouldFail = false) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const store = new Map<string, { value: string; expiresAt: number }>();

  const redis: any = {
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers.has(event)) {
        handlers.set(event, []);
      }
      handlers.get(event)!.push(handler);
      return redis;
    }),
    connect: jest.fn(async () => {
      if (connectShouldFail) {
        throw new Error('Redis unavailable');
      }

      for (const handler of handlers.get('connect') || []) {
        handler();
      }
      for (const handler of handlers.get('ready') || []) {
        handler();
      }
    }),
    config: jest.fn(async (command: string, key: string) => {
      if (command === 'GET' && key === 'maxmemory-policy') {
        return ['maxmemory-policy', 'noeviction'];
      }
      return null;
    }),
    exists: jest.fn(async (key: string) => {
      const entry = store.get(key);
      if (!entry) {
        return 0;
      }
      if (entry.expiresAt <= Date.now()) {
        store.delete(key);
        return 0;
      }
      return 1;
    }),
    setex: jest.fn(async (key: string, ttlSeconds: number, value: string) => {
      store.set(key, {
        value,
        expiresAt: Date.now() + ttlSeconds * 1000,
      });
      return 'OK';
    }),
    quit: jest.fn(async () => 'OK'),
    disconnect: jest.fn(),
    store,
  };

  return redis;
}

function configureEnv() {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    JWT_SECRET: TEST_JWT_SECRET,
    JWT_PUBLIC_KEY_PATH: '/tmp/nonexistent-jwt-public.pem',
    LOG_LEVEL: 'error',
    SILENT_LOGS: 'true',
    DISABLE_FILE_LOG_TRANSPORTS: 'true',
  };
}

async function loadAuthModule(redisMock: ReturnType<typeof createRedisMock>) {
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
  currentSessionServiceMock = {
    createSession: jest.fn().mockResolvedValue(true),
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
    sessionService: currentSessionServiceMock,
  }));
  jest.doMock('../database/connection.js', () => ({
    db: mockDb,
  }));

  const module = await import('../server/middleware/auth.js');
  await Promise.resolve();
  await Promise.resolve();
  return module;
}


function requestWith(token: string) {
  return {
    get: jest.fn((header: string) => (header.toLowerCase() === 'authorization' ? `Bearer ${token}` : null)),
    path: '/api/test',
    method: 'GET',
  } as any;
}

function responseMock() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
}

// The exact claim set wallet-auth-service.issueTokens signs.
async function mintWalletToken(overrides: Record<string, unknown> = {}, options: jwt.SignOptions = {}) {
  const { JWT_ISSUER, JWT_AUDIENCE } = await import('../server/auth/jwt-constants.js');
  return jwt.sign(
    { sub: WALLET, address: WALLET, role: 'wallet', type: 'access', ...overrides },
    TEST_JWT_SECRET,
    { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 900, ...options },
  );
}

beforeEach(() => {
  configureEnv();
  jest.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

async function run(middlewareName: 'authenticateJWT' | 'authenticateSessionJWT', token: string) {
  const mod: any = await loadAuthModule(createRedisMock(false));
  await new Promise((resolve) => setTimeout(resolve, 20));
  currentSessionServiceMock.validateSession.mockResolvedValue(null); // no live session for any token here
  const req = requestWith(token);
  const res = responseMock();
  const next = jest.fn();
  await mod[middlewareName](req, res, next);
  return { req, res, next, sessions: currentSessionServiceMock.validateSession };
}

describe('wallet-login tokens in authenticateJWT (backend#1297)', () => {
  it('a wallet access token passes with no session lookup, and the identity is the wallet', async () => {
    const { req, res, next, sessions } = await run('authenticateJWT', await mintWalletToken());
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(sessions).not.toHaveBeenCalled();
    expect(req.user).toEqual(expect.objectContaining({ id: WALLET, userId: WALLET, address: WALLET, roles: ['wallet'], permissions: [] }));
  });

  it('an ed25519 wallet token (extra wallet_scheme claim) passes too', async () => {
    const { next } = await run('authenticateJWT', await mintWalletToken({ wallet_scheme: 'ed25519' }));
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a wallet REFRESH-typed token', { type: 'refresh' }],
    ['a token with no type', { type: undefined }],
    ['a forged admin role', { role: 'admin' }],
    ['a forged user role', { role: 'user' }],
    ['a wallet role with roles array only', { role: undefined, roles: ['wallet'] }],
    ['a sub that is not a chain address', { sub: 'alice', address: 'alice' }],
    ['a sub that differs from address', { address: '0x' + 'cd'.repeat(20) }],
  ])('%s is refused (session required) and never reaches the route', async (_name, overrides) => {
    const { res, next } = await run('authenticateJWT', await mintWalletToken(overrides as Record<string, unknown>));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_SESSION' }) }));
  });

  it('a wallet-shaped token that names a sessionId takes the session path, not the wallet path', async () => {
    const mod: any = await loadAuthModule(createRedisMock(false));
    currentSessionServiceMock.validateSession.mockResolvedValue(null);
    const token = await mintWalletToken({ sessionId: 'not-a-session' });
    const res = responseMock();
    const next = jest.fn();
    await mod.authenticateJWT(requestWith(token), res, next);
    expect(currentSessionServiceMock.validateSession).toHaveBeenCalledWith('not-a-session');
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('a normal session token is unchanged (session validated, user from the session token)', async () => {
    const mod: any = await loadAuthModule(createRedisMock(false));
    const { token } = await mod.generateToken('user-1', ['user'], ['read']);
    const req = requestWith(token);
    const res = responseMock();
    const next = jest.fn();
    await mod.authenticateJWT(req, res, next);
    expect(currentSessionServiceMock.validateSession).toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(expect.objectContaining({ userId: 'user-1', roles: ['user'] }));
  });

  it('an expired wallet token is refused', async () => {
    const { res, next } = await run('authenticateJWT', await mintWalletToken({}, { expiresIn: -120 }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_TOKEN' }) }));
  });

  it('a wallet token signed with the wrong key, or wrong issuer/audience, is refused', async () => {
    const { JWT_AUDIENCE } = await import('../server/auth/jwt-constants.js');
    for (const bad of [
      jwt.sign({ sub: WALLET, address: WALLET, role: 'wallet', type: 'access' }, 'another-secret-xxxxxxxxxxxxxxxxxxxxxxxx', { algorithm: 'HS256', expiresIn: 900 }),
      jwt.sign({ sub: WALLET, address: WALLET, role: 'wallet', type: 'access' }, TEST_JWT_SECRET, { algorithm: 'HS256', issuer: 'someone-else', audience: JWT_AUDIENCE, expiresIn: 900 }),
    ]) {
      const { res, next } = await run('authenticateJWT', bad);
      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    }
  });

  it('a revoked wallet token is refused', async () => {
    const redisMock = createRedisMock(false);
    const mod: any = await loadAuthModule(redisMock);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const token = await mintWalletToken();
    await mod.revokeToken(token);
    const res = responseMock();
    const next = jest.fn();
    await mod.authenticateJWT(requestWith(token), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'TOKEN_REVOKED' }) }));
  });
});

describe('authenticateSessionJWT (gas sponsor, sensor upload) still refuses wallet tokens', () => {
  it('a wallet access token answers 401 INVALID_SESSION', async () => {
    const { res, next } = await run('authenticateSessionJWT', await mintWalletToken());
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.objectContaining({ code: 'INVALID_SESSION' }) }));
  });
});

describe('routes that must stay session-only', () => {
  it.each(['server/routes/gas-relay-routes.ts', 'server/routes/sensor-ingest-routes.ts'])('%s uses authenticateSessionJWT, not authenticateJWT', (file) => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', file), 'utf8') as string;
    expect(src).toMatch(/router\.use\(authenticateSessionJWT\)/);
    expect(src).not.toMatch(/router\.use\(authenticateJWT\)/);
  });
});
