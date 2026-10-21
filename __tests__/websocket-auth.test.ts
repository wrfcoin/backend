import { attachWalletNonceIssuer } from './helpers/wallet-nonce-redis';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import type { IncomingMessage } from 'http';
import type { Socket } from 'net';
import { Wallet } from 'ethers';

const ORIGINAL_ENV = { ...process.env };
const TEST_JWT_SECRET =
  'test-jwt-secret-key-for-lane2-wallet-signature-harness-12345';

let currentRedisMock: ReturnType<typeof createRedisMock>;

function createRedisPipeline(redis: ReturnType<typeof createRedisMock>) {
  const commands: Array<{ method: keyof ReturnType<typeof createRedisMock>; args: unknown[] }> =
    [];

  const pipeline = {
    zremrangebyscore(...args: unknown[]) {
      commands.push({ method: 'zremrangebyscore', args });
      return pipeline;
    },
    zadd(...args: unknown[]) {
      commands.push({ method: 'zadd', args });
      return pipeline;
    },
    zcard(...args: unknown[]) {
      commands.push({ method: 'zcard', args });
      return pipeline;
    },
    expire(...args: unknown[]) {
      commands.push({ method: 'expire', args });
      return pipeline;
    },
    setex(...args: unknown[]) {
      commands.push({ method: 'setex', args });
      return pipeline;
    },
    sadd(...args: unknown[]) {
      commands.push({ method: 'sadd', args });
      return pipeline;
    },
    del(...args: unknown[]) {
      commands.push({ method: 'del', args });
      return pipeline;
    },
    srem(...args: unknown[]) {
      commands.push({ method: 'srem', args });
      return pipeline;
    },
    get(...args: unknown[]) {
      commands.push({ method: 'get', args });
      return pipeline;
    },
    async exec() {
      const results: Array<[null, unknown]> = [];
      for (const { method, args } of commands) {
        const value = await (redis[method] as (...cmdArgs: unknown[]) => unknown)(...args);
        results.push([null, value]);
      }
      return results;
    },
  };

  return pipeline;
}

function createRedisMock() {
  const redis = {
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    sadd: jest.fn().mockResolvedValue(1),
    srem: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    zadd: jest.fn().mockResolvedValue(1),
    zrangebyscore: jest.fn().mockResolvedValue([]),
    zremrangebyscore: jest.fn().mockResolvedValue(0),
    zcard: jest.fn().mockResolvedValue(0),
    ttl: jest.fn().mockResolvedValue(-1),
    keys: jest.fn().mockResolvedValue([]),
    pipeline: jest.fn(),
  };

  redis.pipeline.mockImplementation(() => createRedisPipeline(redis));
  return attachWalletNonceIssuer(redis);
}

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => currentRedisMock);
});

function configureTestEnv(
  overrides: Record<string, string | undefined> = {}
): void {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    JWT_SECRET: TEST_JWT_SECRET,
    LOG_LEVEL: 'error',
    SILENT_LOGS: 'true',
    OTEL_ENABLED: 'false',
    DISABLE_FILE_LOG_TRANSPORTS: 'true',
    ...overrides,
  };
}

function createMockRequest(options: {
  headers?: Record<string, string>;
  url?: string;
  socket?: Partial<Socket>;
} = {}): IncomingMessage {
  return {
    headers: options.headers || {},
    url: options.url || '/ws',
    socket: {
      remoteAddress: '127.0.0.1',
      ...options.socket,
    },
  } as unknown as IncomingMessage;
}

function createValidWsToken(
  payload: Partial<{
    id: string;
    address: string;
    role: string;
    permissions: string[];
    iss: string;
    aud: string;
    exp: number;
  }> = {},
  secret: string = TEST_JWT_SECRET
): string {
  const nowSec = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      id: 'user-123',
      address: '0x' + crypto.randomBytes(20).toString('hex'),
      role: 'user',
      permissions: [],
      iss: 'wrfcoin-platform',
      aud: 'wrfcoin-api',
      iat: nowSec,
      exp: nowSec + 3600,
      ...payload,
    },
    secret
  );
}

async function loadWebSocketModule() {
  configureTestEnv();
  currentRedisMock = createRedisMock();
  jest.resetModules();
  return import('../shared/websocket/index.js');
}

async function loadWalletAuthModule() {
  configureTestEnv();
  currentRedisMock = createRedisMock();
  jest.resetModules();
  return import('../server/routes/wallet-auth-service.ts.js');
}

afterEach(async () => {
  process.env = { ...ORIGINAL_ENV };
  jest.clearAllMocks();
  jest.resetModules();
});

describe('wallet auth mobile signature regression', () => {
  it('accepts the exact mobile personal_sign payload and refreshes tokens', async () => {
    const db = {
      execute: jest.fn().mockResolvedValue({ rows: [] }),
    };
    const { createWalletAuthService } =
      await loadWalletAuthModule();
    const service = createWalletAuthService({
      db,
      jwtSecret: TEST_JWT_SECRET,
      accessTokenTtlSec: 120,
      refreshTokenTtlSec: 3600,
      walletAuthOrigin: 'https://wrfcoin.com',
      walletAuthChainId: 777,
    });

    const wallet = Wallet.createRandom();
    const challenge = await service.generateNonce(wallet.address);
    const storedChallenge = currentRedisMock.set.mock.calls[0][1];
    currentRedisMock.get.mockResolvedValueOnce(storedChallenge);
    const signature = await wallet.signMessage(challenge.message);

    const auth = await service.walletLogin({
      address: wallet.address,
      signature,
      nonce: challenge.nonce,
    });

    expect(auth.jwt).toEqual(expect.any(String));
    expect(auth.refreshToken).toEqual(expect.any(String));
    expect(auth.expiresIn).toBe(120);
    expect(db.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO wallets'),
      [wallet.address]
    );

    const storedRefreshToken = currentRedisMock.set.mock.calls[1][1];
    currentRedisMock.get.mockResolvedValueOnce(storedRefreshToken);
    const refreshed = await service.refresh({ refreshToken: auth.refreshToken });

    expect(refreshed.jwt).toEqual(expect.any(String));
    expect(refreshed.refreshToken).toEqual(expect.any(String));
    expect(refreshed.refreshToken).not.toBe(auth.refreshToken);
    expect(refreshed.expiresIn).toBe(120);
  });
});

describe('WebSocketAuthMiddleware', () => {
  it('authenticates a valid bearer token when env is injected before import', async () => {
    const { WebSocketAuthMiddleware } = await loadWebSocketModule();
    const authMiddleware = new WebSocketAuthMiddleware();
    const token = createValidWsToken({ id: 'user-auth-header' });

    const result = await authMiddleware.authenticate(
      createMockRequest({
        headers: { authorization: `Bearer ${token}` },
      })
    );

    expect(result.authenticated).toBe(true);
    expect(result.user?.id).toBe('user-auth-header');
    expect(result.user?.role).toBe('user');
    expect(result.sessionId).toEqual(expect.stringMatching(/^ws_/));
  });

  it('extracts a token from the Sec-WebSocket-Protocol header', async () => {
    const { WebSocketAuthMiddleware } = await loadWebSocketModule();
    const authMiddleware = new WebSocketAuthMiddleware();
    const token = createValidWsToken({ id: 'user-protocol-header' });

    const result = await authMiddleware.authenticate(
      createMockRequest({
        headers: { 'sec-websocket-protocol': `bearer, ${token}` },
      })
    );

    expect(result.authenticated).toBe(true);
    expect(result.user?.id).toBe('user-protocol-header');
  });

  it('rejects legacy query-string websocket tokens', async () => {
    const { WebSocketAuthMiddleware } = await loadWebSocketModule();
    const authMiddleware = new WebSocketAuthMiddleware();
    const token = createValidWsToken({ id: 'user-query-param' });

    const result = await authMiddleware.authenticate(
      createMockRequest({
        url: `/ws?token=${token}`,
      })
    );

    expect(result.authenticated).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('rejects an invalid token signature', async () => {
    const { WebSocketAuthMiddleware } = await loadWebSocketModule();
    const authMiddleware = new WebSocketAuthMiddleware();
    const token = createValidWsToken({}, 'wrong-secret');

    const result = await authMiddleware.authenticate(
      createMockRequest({
        headers: { authorization: `Bearer ${token}` },
      })
    );

    expect(result.authenticated).toBe(false);
    expect(result.error).toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('returns a guest session only when explicitly enabled', async () => {
    const { WebSocketAuthMiddleware } = await loadWebSocketModule();
    const authMiddleware = new WebSocketAuthMiddleware({ allowGuestAccess: true });

    const result = await authMiddleware.authenticate(createMockRequest());

    expect(result.authenticated).toBe(true);
    expect(result.user?.role).toBe('guest');
    expect(result.user?.address).toBe(
      '0x0000000000000000000000000000000000000000'
    );
  });

  it('extracts client IP from proxy headers', async () => {
    const { WebSocketAuthMiddleware } = await loadWebSocketModule();

    const ip = WebSocketAuthMiddleware.getClientIp(
      createMockRequest({
        headers: { 'x-forwarded-for': '192.168.1.100, 10.0.0.1' },
      })
    );

    expect(ip).toBe('192.168.1.100');
  });
});

describe('WebSocketRateLimiter', () => {
  it('allows connections within the configured limit', async () => {
    const { WebSocketRateLimiter } = await loadWebSocketModule();
    currentRedisMock.zcard.mockResolvedValue(1);
    const rateLimiter = new WebSocketRateLimiter({ maxConnectionsPerMinute: 2 });

    const result = await rateLimiter.checkConnectionLimit('192.168.1.1');

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1);
    await rateLimiter.close();
  });

  it('blocks requests when the IP is already rate-limited', async () => {
    const { WebSocketRateLimiter } = await loadWebSocketModule();
    currentRedisMock.ttl.mockResolvedValue(120);
    const rateLimiter = new WebSocketRateLimiter();

    const result = await rateLimiter.checkConnectionLimit('192.168.1.100');

    expect(result.allowed).toBe(false);
    expect(result.blocked).toBe(true);
    expect(result.reason).toContain('IP blocked');
    await rateLimiter.close();
  });

  it('rejects bursty message traffic', async () => {
    const { WebSocketRateLimiter } = await loadWebSocketModule();
    currentRedisMock.zcard
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(3);
    const rateLimiter = new WebSocketRateLimiter({
      defaultMessagesPerMinute: 5,
      defaultBurstLimit: 2,
    });

    const result = await rateLimiter.checkMessageLimit('conn-burst');

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('Burst limit exceeded');
    await rateLimiter.close();
  });
});

describe('WebSocketSessionManager', () => {
  it('creates and retrieves a session with the redis-backed contract', async () => {
    const { WebSocketSessionManager } = await loadWebSocketModule();
    const sessionManager = new WebSocketSessionManager();

    await sessionManager.createSession(
      {
        connectionId: 'conn-session-001',
        user: {
          id: 'user-123',
          address: '0x' + crypto.randomBytes(20).toString('hex'),
          role: 'user',
          permissions: [],
          sessionId: 'session-abc',
        },
        ipAddress: '192.168.1.1',
        connectedAt: Date.now(),
        lastActivity: Date.now(),
        subscribedChannels: new Set(['global']),
        messageCount: 0,
        tokenExpiry: Date.now() + 3600_000,
      } as any,
      'Test User Agent'
    );

    expect(currentRedisMock.setex).toHaveBeenCalledWith(
      'ws:session:conn-session-001',
      86400,
      expect.any(String)
    );
    expect(currentRedisMock.sadd).toHaveBeenCalledWith(
      'ws:user:user-123',
      'conn-session-001'
    );

    currentRedisMock.get.mockResolvedValue(
      JSON.stringify({
        connectionId: 'conn-session-001',
        userId: 'user-123',
        role: 'user',
      })
    );

    const session = await sessionManager.getSession('conn-session-001');
    expect(session).toMatchObject({
      connectionId: 'conn-session-001',
      userId: 'user-123',
      role: 'user',
    });

    await sessionManager.close();
  });

  it('removes a session from the redis contract', async () => {
    const { WebSocketSessionManager } = await loadWebSocketModule();
    const sessionManager = new WebSocketSessionManager();

    await sessionManager.removeSession('conn-remove-001', 'user-remove');

    expect(currentRedisMock.del).toHaveBeenCalledWith(
      'ws:session:conn-remove-001'
    );
    expect(currentRedisMock.srem).toHaveBeenCalledWith(
      'ws:user:user-remove',
      'conn-remove-001'
    );

    await sessionManager.close();
  });

  it('fails closed instead of creating a process-local session when Redis is unavailable', async () => {
    const { WebSocketSessionManager } = await loadWebSocketModule();
    const sessionManager = new WebSocketSessionManager();
    currentRedisMock.pipeline.mockImplementationOnce(() => {
      throw new Error('Redis unavailable');
    });

    await expect(
      sessionManager.createSession(
        {
          connectionId: 'conn-outage-001',
          user: {
            id: 'user-outage',
            address: '0x' + crypto.randomBytes(20).toString('hex'),
            role: 'user',
            permissions: [],
            sessionId: 'session-outage',
          },
          ipAddress: '192.168.1.2',
          connectedAt: Date.now(),
          lastActivity: Date.now(),
          subscribedChannels: new Set(['global']),
          messageCount: 0,
          tokenExpiry: Date.now() + 3600_000,
        } as any,
        'Test User Agent'
      )
    ).rejects.toThrow('Redis unavailable');

    expect(currentRedisMock.setex).not.toHaveBeenCalled();
    await sessionManager.close();
  });
});

describe('ChannelAuthorizationService', () => {
  it('denies guest access to mining and allows admin access to api-monitoring', async () => {
    const { ChannelAuthorizationService } = await loadWebSocketModule();
    const channelAuth = new ChannelAuthorizationService();

    expect(
      channelAuth.canSubscribe(
        {
          user: { id: 'guest', role: 'guest', permissions: [] },
        } as any,
        'mining'
      )
    ).toMatchObject({ allowed: false });

    expect(
      channelAuth.canSubscribe(
        {
          user: { id: 'admin', role: 'admin', permissions: [] },
        } as any,
        'api-monitoring'
      )
    ).toMatchObject({ allowed: true });
  });
});

describe('WebSocketSecurityLogger', () => {
  it('records connection, auth, and rate-limit metrics without file side effects', async () => {
    const { WebSocketSecurityLogger } = await loadWebSocketModule();
    const securityLogger = new WebSocketSecurityLogger();

    securityLogger.logConnectionAttempt('127.0.0.1', 'jest');
    securityLogger.logConnectionSuccess(
      'conn-001',
      'user-123',
      'user',
      '127.0.0.1',
      'jest'
    );
    securityLogger.logAuthSuccess('conn-001', 'user-123', '127.0.0.1');
    securityLogger.logAuthFailure(
      '127.0.0.1',
      'INVALID_TOKEN',
      'Bad token',
      'jest'
    );
    securityLogger.logRateLimitHit(
      'conn-001',
      'user-123',
      '127.0.0.1',
      'message',
      'global'
    );

    const metrics = securityLogger.getPrometheusMetrics();
    expect(metrics).toContain('wrfcoin_ws_connections_total');
    expect(metrics).toContain('wrfcoin_ws_auth_attempts_total');
    expect(securityLogger.getActiveConnectionsByRole()).toMatchObject({
      user: 1,
    });
    expect(securityLogger.getAuthFailureRate()).toMatchObject({
      total: 2,
      failures: 1,
      rate: 0.5,
    });

    await securityLogger.stop();
  });
});

describe('websocket defaults', () => {
  it('exports the current auth and rate limit defaults', async () => {
    const { DEFAULT_AUTH_CONFIG, DEFAULT_RATE_LIMIT_CONFIG } =
      await loadWebSocketModule();

    expect(DEFAULT_AUTH_CONFIG.allowGuestAccess).toBe(false);
    expect(DEFAULT_AUTH_CONFIG.clockTolerance).toBeGreaterThan(0);
    expect(DEFAULT_RATE_LIMIT_CONFIG.maxConnectionsPerMinute).toBeGreaterThan(0);
    expect(DEFAULT_RATE_LIMIT_CONFIG.defaultMessagesPerMinute).toBeGreaterThan(
      0
    );
    expect(DEFAULT_RATE_LIMIT_CONFIG.defaultBurstLimit).toBeGreaterThan(0);
  });
});
