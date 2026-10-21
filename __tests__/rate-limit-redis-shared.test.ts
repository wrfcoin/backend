import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };

let redisMock: any;

function createRedisMock() {
  return {
    status: 'ready',
    on: jest.fn(),
    connect: jest.fn().mockResolvedValue(undefined),
    quit: jest.fn().mockResolvedValue('OK'),
    disconnect: jest.fn(),
    ttl: jest.fn().mockResolvedValue(-2),
    exists: jest.fn().mockResolvedValue(0),
    incr: jest.fn().mockResolvedValue(1),
    expire: jest.fn().mockResolvedValue(1),
    setex: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    pipeline: jest.fn(() => ({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[null, 0], [null, 1], [null, 1], [null, 1]]),
    })),
  };
}

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => redisMock);
});

jest.mock('../server/utils/logger.js', () => ({
  appLogger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

describe('shared rate-limit redis middleware', () => {
  let rateLimitModule: any;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      SILENT_LOGS: 'true',
      DISABLE_FILE_LOG_TRANSPORTS: 'true',
      TRUSTED_PROXIES: '127.0.0.1,::1',
    };
    redisMock = createRedisMock();
    // #977: the module now unref()s its import-time cleanup timer, so this stub
    // must return something shaped like a Node Timeout rather than `0` — which
    // setInterval never returns. Intent is unchanged: no real timer is started.
    jest.spyOn(global, 'setInterval').mockReturnValue({
      unref() { return this; },
      ref() { return this; },
      hasRef() { return false; },
    } as any);
    jest.resetModules();
    rateLimitModule = require('../shared/middleware/rate-limit-redis.ts');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.clearAllMocks();
    jest.restoreAllMocks();
    jest.resetModules();
  });

  it('uses forwarded client ip only for trusted proxies', () => {
    const trustedRequest: any = {
      headers: {
        'x-forwarded-for': '198.51.100.2, 10.0.0.1',
      },
      socket: {
        remoteAddress: '127.0.0.1',
      },
      path: '/api/openforis/projects',
    };

    const untrustedRequest: any = {
      headers: {
        'x-forwarded-for': '198.51.100.99',
      },
      socket: {
        remoteAddress: '10.20.30.40',
      },
      path: '/api/openforis/projects',
    };

    // backend#1229: 10.0.0.1 is the nearest untrusted hop, so it is the
    // client; 198.51.100.2 sits left of it and could have been client-supplied.
    expect(rateLimitModule.getClientIp(trustedRequest)).toBe('10.0.0.1');
    expect(rateLimitModule.getClientIp(untrustedRequest)).toBe('10.20.30.40');
  });

  it('generates deterministic keys and reuses a singleton redis client', () => {
    const request: any = {
      headers: {},
      socket: {
        remoteAddress: '127.0.0.1',
      },
      path: '/api/demo',
    };

    const key = rateLimitModule.generateRateLimitKey(request, 'custom');
    expect(key).toBe('custom:127.0.0.1:/api/demo');

    const first = rateLimitModule.getRedisClient();
    const second = rateLimitModule.getRedisClient();
    const RedisCtor = require('ioredis');

    expect(first).toBe(redisMock);
    expect(second).toBe(redisMock);
    expect(RedisCtor).toHaveBeenCalledTimes(1);
    expect(redisMock.connect).toHaveBeenCalledTimes(1);
  });

  it('fails closed when Redis rejects a rate limit check', async () => {
    redisMock.pipeline.mockReturnValueOnce({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockRejectedValue(new Error('redis down')),
    });

    const result = await rateLimitModule.checkRateLimit('client-key', {
      windowMs: 15 * 60 * 1000,
      maxRequests: 5,
      keyPrefix: 'ratelimit:auth',
    });

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.limit).toBe(5);
  });

  it('loads positive API and auth quota overrides and rejects invalid values', () => {
    process.env.RATE_LIMIT_API_WINDOW_MS = '30000';
    process.env.RATE_LIMIT_API_MAX_REQUESTS = '60';
    process.env.RATE_LIMIT_AUTH_WINDOW_MS = '600000';
    process.env.RATE_LIMIT_AUTH_MAX_REQUESTS = '0';
    jest.resetModules();

    const configured = require('../shared/middleware/rate-limit-redis.ts');

    expect(configured.RATE_LIMIT_PRESETS.api).toMatchObject({
      windowMs: 30000,
      maxRequests: 60,
    });
    expect(configured.RATE_LIMIT_PRESETS.auth).toMatchObject({
      windowMs: 600000,
      maxRequests: 5,
    });
    expect(configured.default).toBeDefined();
  });

  it('rejects request N+1 with rate limit headers and a 429 envelope', async () => {
    const pipelineForCount = (count: number) => ({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockResolvedValue([[null, 0], [null, 1], [null, count], [null, 1]]),
    });
    redisMock.pipeline
      .mockReturnValueOnce(pipelineForCount(1))
      .mockReturnValueOnce(pipelineForCount(2));

    const middleware = rateLimitModule.createRateLimitMiddleware({
      windowMs: 60000,
      maxRequests: 1,
      keyPrefix: 'ratelimit:test',
      enableAutoBlock: false,
    });
    const req: any = {
      headers: {},
      socket: { remoteAddress: '198.51.100.20' },
      path: '/api/demo',
    };
    const response = () => {
      const res: any = {
        headers: {} as Record<string, string>,
        statusCode: 200,
        setHeader: jest.fn((key: string, value: string) => {
          res.headers[key] = value;
        }),
        status: jest.fn((code: number) => {
          res.statusCode = code;
          return res;
        }),
        json: jest.fn((payload: unknown) => {
          res.body = payload;
          return res;
        }),
      };
      return res;
    };

    const first = response();
    const second = response();
    const firstNext = jest.fn();
    const secondNext = jest.fn();
    await middleware(req, first, firstNext);
    await middleware(req, second, secondNext);

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondNext).not.toHaveBeenCalled();
    expect(second.status).toHaveBeenCalledWith(429);
    expect(second.headers['X-RateLimit-Limit']).toBe('1');
    expect(second.headers['X-RateLimit-Remaining']).toBe('0');
    expect(second.headers['Retry-After']).toBeDefined();
    expect(second.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('returns a limiter response instead of calling next when Redis fails', async () => {
    redisMock.pipeline.mockReturnValueOnce({
      zremrangebyscore: jest.fn().mockReturnThis(),
      zadd: jest.fn().mockReturnThis(),
      zcard: jest.fn().mockReturnThis(),
      expire: jest.fn().mockReturnThis(),
      exec: jest.fn().mockRejectedValue(new Error('redis down')),
    });

    const middleware = rateLimitModule.createRateLimitMiddleware({
      windowMs: 15 * 60 * 1000,
      maxRequests: 5,
      keyPrefix: 'ratelimit:auth',
    });
    const req: any = {
      headers: {},
      socket: {
        remoteAddress: '127.0.0.1',
      },
      path: '/api/auth/wallet-login',
    };
    const res: any = {
      headers: {} as Record<string, string>,
      statusCode: 200,
      setHeader: jest.fn((key: string, value: string) => {
        res.headers[key] = value;
      }),
      status: jest.fn((code: number) => {
        res.statusCode = code;
        return res;
      }),
      json: jest.fn((payload: unknown) => {
        res.body = payload;
        return res;
      }),
    };
    const next = jest.fn();

    await middleware(req, res, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  });
});
