import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const ORIGINAL_ENV = { ...process.env };
const TEST_JWT_SECRET = 'test-jwt-secret-for-redis-revocation-123456789';

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

async function waitForInfoMessage(message: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (mockLogger.info.mock.calls.some(([firstArg]) => firstArg === message)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(`Timed out waiting for logger message: ${message}`);
}

beforeEach(() => {
  configureEnv();
  jest.clearAllMocks();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.resetModules();
});

describe('JWT revocation Redis migration', () => {
  it('persists revocations to Redis using the JWT identifier and survives a reload', async () => {
    const redisMock = createRedisMock(false);
    const { generateToken, revokeToken } = await loadAuthModule(redisMock);
    await waitForInfoMessage(
      '[AuthRevocation] Redis maxmemory-policy=noeviction; revocation persistence enabled'
    );

    const { token } = await generateToken('user-1', ['user'], ['read']);
    const decoded = jwt.decode(token) as jwt.JwtPayload & {
      jti?: string;
      sessionId?: string;
    };

    expect(decoded.jti).toBeDefined();
    expect(decoded.jti).toBe(decoded.sessionId);

    await revokeToken(token);

    const legacyHash = crypto.createHash('sha256').update(token).digest('hex');

    expect(redisMock.setex).toHaveBeenCalledTimes(2);
    expect(redisMock.setex).toHaveBeenCalledWith(
      `jwt:revoked:${decoded.jti}`,
      expect.any(Number),
      '1'
    );
    expect(redisMock.setex).toHaveBeenCalledWith(
      `revoked:jwt:${legacyHash}`,
      expect.any(Number),
      '1'
    );

    const ttlSeconds = redisMock.setex.mock.calls[0][1] as number;
    expect(ttlSeconds).toBeGreaterThan(0);
    expect(ttlSeconds).toBeLessThanOrEqual(24 * 60 * 60);

    const { authenticateJWT } = await loadAuthModule(redisMock);
    const req = {
      get: jest.fn((header: string) =>
        header.toLowerCase() === 'authorization' ? `Bearer ${token}` : null
      ),
      path: '/api/test',
      method: 'GET',
    } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(redisMock.exists).toHaveBeenCalledWith(`jwt:revoked:${decoded.jti}`);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({ code: 'TOKEN_REVOKED' }),
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when Redis is unavailable instead of authenticating from local state', async () => {
    const redisMock = createRedisMock(true);
    const { generateToken, authenticateJWT } =
      await loadAuthModule(redisMock);

    const { token } = await generateToken('user-2', ['user'], ['read']);

    const req = {
      get: jest.fn((header: string) =>
        header.toLowerCase() === 'authorization' ? `Bearer ${token}` : null
      ),
      path: '/api/test',
      method: 'GET',
    } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    } as any;
    const next = jest.fn();

    await authenticateJWT(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: expect.objectContaining({
          code: 'AUTH_REVOCATION_STORE_UNAVAILABLE',
        }),
      })
    );
    expect(redisMock.exists).not.toHaveBeenCalled();
    expect(currentSessionServiceMock.validateSession).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });
});
