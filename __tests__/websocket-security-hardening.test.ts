import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import path from 'path';

const mockRedis = {
  get: jest.fn(),
  set: jest.fn(),
  setex: jest.fn(),
  on: jest.fn(),
  connect: jest.fn(),
  pipeline: jest.fn(),
  ttl: jest.fn(),
  del: jest.fn(),
  sadd: jest.fn(),
  srem: jest.fn(),
  smembers: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  zadd: jest.fn(),
  zrangebyscore: jest.fn(),
  zremrangebyscore: jest.fn(),
  zcard: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

const ORIGINAL_ENV = { ...process.env };

type ServerModule = {
  app: any;
  __testHooks: {
    handleUpgradeRequest: (
      request: any,
      socket: { write: (payload: string) => void; destroy: () => void },
      head: Buffer
    ) => Promise<void>;
    resetSecurityStateForTests: () => void;
  };
};

function resetMockRedisDefaults() {
  Object.values(mockRedis).forEach(mockFn => mockFn.mockReset());
  mockRedis.get.mockResolvedValue(null);
  mockRedis.set.mockResolvedValue('OK');
  mockRedis.setex.mockResolvedValue('OK');
  mockRedis.on.mockReturnValue(undefined);
  mockRedis.connect.mockResolvedValue(undefined);
  mockRedis.pipeline.mockImplementation(() => ({
    zremrangebyscore: jest.fn().mockReturnThis(),
    zadd: jest.fn().mockReturnThis(),
    zcard: jest.fn().mockReturnThis(),
    expire: jest.fn().mockReturnThis(),
    exec: jest.fn().mockResolvedValue([
      [null, 0],
      [null, 1],
      [null, 1],
      [null, 1],
    ]),
  }));
  mockRedis.ttl.mockResolvedValue(0);
  mockRedis.del.mockResolvedValue(1);
  mockRedis.sadd.mockResolvedValue(1);
  mockRedis.srem.mockResolvedValue(1);
  mockRedis.smembers.mockResolvedValue([]);
  mockRedis.incr.mockResolvedValue(1);
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.zadd.mockResolvedValue(1);
  mockRedis.zrangebyscore.mockResolvedValue([]);
  mockRedis.zremrangebyscore.mockResolvedValue(0);
  mockRedis.zcard.mockResolvedValue(0);
}

function loadServerModule(modulePath: string, envOverrides: Record<string, string | undefined> = {}): ServerModule {
  jest.resetModules();
  process.env = {
    ...ORIGINAL_ENV,
    WS_DISABLE_AUTO_LISTEN: 'true',
    WS_DISABLE_BACKGROUND_TASKS: 'true',
    ...envOverrides,
  };
  const loaded = require(modulePath) as ServerModule;
  loaded.__testHooks.resetSecurityStateForTests();
  return loaded;
}

function createUpgradeRequest(url = '/ws', ipAddress = '127.0.0.1', headers: Record<string, string> = {}) {
  return {
    url,
    headers: {
      host: 'localhost:5002',
      ...headers,
    },
    socket: {
      remoteAddress: ipAddress,
    },
  };
}

function createSocketSpy() {
  return {
    write: jest.fn(),
    destroy: jest.fn(),
  };
}

function createMockResponse() {
  return {
    statusCode: 200,
    payload: undefined as any,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
      this.payload = body;
      return this;
    },
  };
}

function invokeGetRoute(app: any, routePath: string) {
  const stack = app?._router?.stack || app?.router?.stack || [];
  const layer = stack.find(
    (item: any) =>
      item?.route?.path === routePath && item?.route?.methods?.get
  );
  if (!layer) {
    throw new Error(`Route ${routePath} not found`);
  }
  const handler = layer.route.stack[0].handle;
  const req = { method: 'GET', url: routePath, headers: {} };
  const res = createMockResponse();
  handler(req, res);
  return res;
}

async function expectUpgradeStatus(
  modulePath: string,
  envOverrides: Record<string, string | undefined>,
  requestUrl: string,
  expectedStatusLine: string
) {
  const mod = loadServerModule(modulePath, envOverrides);
  const socket = createSocketSpy();
  await mod.__testHooks.handleUpgradeRequest(
    createUpgradeRequest(requestUrl),
    socket,
    Buffer.alloc(0)
  );
  expect(socket.write).toHaveBeenCalled();
  const payload = socket.write.mock.calls[0][0] as string;
  expect(payload).toContain(expectedStatusLine);
}

describe('WebSocket security hardening', () => {
  const cases = [
    {
      name: 'cross-chain server',
      modulePath: '../server/cross_chain_websocket_server.js',
      requestUrl: '/ws',
    },
    {
      name: 'secure messaging server',
      modulePath: '../server/secure_messaging_websocket.js',
      requestUrl: '/ws',
    },
  ];

  beforeEach(() => {
    resetMockRedisDefaults();
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  describe.each(cases)('$name', ({ modulePath, requestUrl }) => {
    it('returns 503 when JWT secret is missing in strict mode', async () => {
      await expectUpgradeStatus(
        modulePath,
        {
          NODE_ENV: 'production',
          JWT_SECRET: undefined,
          WRFCOIN_ENV: 'production',
        },
        requestUrl,
        'HTTP/1.1 503 Service Unavailable'
      );
    });

    it('returns 503 when auth module import fails in strict mode', async () => {
      await expectUpgradeStatus(
        modulePath,
        {
          NODE_ENV: 'production',
          JWT_SECRET: 'unit-test-jwt-secret',
          WRFCOIN_ENV: 'production',
          WS_AUTH_MODULE_PATH: './does-not-exist.js',
        },
        requestUrl,
        'HTTP/1.1 503 Service Unavailable'
      );
    });

    it('applies baseline 429 limiting even when auth is unavailable', async () => {
      const mod = loadServerModule(modulePath, {
        NODE_ENV: 'production',
        WRFCOIN_ENV: 'production',
        JWT_SECRET: undefined,
        WS_BASELINE_CONN_MAX: '1',
        WS_BASELINE_CONN_WINDOW_MS: '60000',
      });

      const firstSocket = createSocketSpy();
      await mod.__testHooks.handleUpgradeRequest(
        createUpgradeRequest(requestUrl, '192.168.10.10'),
        firstSocket,
        Buffer.alloc(0)
      );
      expect(firstSocket.write).toHaveBeenCalled();
      expect(firstSocket.write.mock.calls[0][0]).toContain(
        'HTTP/1.1 503 Service Unavailable'
      );

      const secondSocket = createSocketSpy();
      await mod.__testHooks.handleUpgradeRequest(
        createUpgradeRequest(requestUrl, '192.168.10.10'),
        secondSocket,
        Buffer.alloc(0)
      );
      expect(secondSocket.write).toHaveBeenCalled();
      expect(secondSocket.write.mock.calls[0][0]).toContain(
        'HTTP/1.1 429 Too Many Requests'
      );
    });

    it('returns 403 when auth middleware rejects connection in strict mode', async () => {
      const authModulePath = path.resolve(
        __dirname,
        '../shared/websocket/index.ts'
      );

      await expectUpgradeStatus(
        modulePath,
        {
          NODE_ENV: 'production',
          WRFCOIN_ENV: 'production',
          JWT_SECRET: 'unit-test-jwt-secret',
          WS_AUTH_MODULE_PATH: authModulePath,
        },
        requestUrl,
        'HTTP/1.1 403 Forbidden'
      );
    });

    it('exposes degraded readiness via /readyz when strict mode prerequisites are missing', async () => {
      const mod = loadServerModule(modulePath, {
        NODE_ENV: 'production',
        WRFCOIN_ENV: 'production',
        JWT_SECRET: undefined,
      });

      const response = invokeGetRoute(mod.app, '/readyz');
      expect(response.statusCode).toBe(503);
      expect(response.payload.status).toBe('degraded');
      expect(response.payload.strictMode).toBe(true);
      expect(response.payload.checks.jwtSecretPresent).toBe(false);
    });
  });
});
