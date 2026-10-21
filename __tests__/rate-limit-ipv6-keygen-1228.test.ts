import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * backend#1228: express-rate-limit 8 keys a raw IPv6 address per /128, so a
 * client holding a /64 can rotate addresses into fresh buckets. Every custom
 * keyGenerator that falls back to the IP must go through ipKeyGenerator, which
 * collapses IPv6 to its /56. The limiter's own ERR_ERL_KEY_GEN_IPV6 check must
 * stay silent when these modules build their limiters.
 */

const mockCaptured: Array<Record<string, any>> = [];

jest.mock('express-rate-limit', () => {
  const actual = jest.requireActual('express-rate-limit') as any;
  const wrapped: any = (options: Record<string, any>) => {
    mockCaptured.push(options);
    return actual(options);
  };
  Object.assign(wrapped, actual);
  wrapped.default = wrapped;
  wrapped.rateLimit = wrapped;
  wrapped.__esModule = true;
  return wrapped;
});

// Limiter modules connect to Redis at import time; keep them in-process.
jest.mock('redis', () => {
  const client = () => ({
    on: jest.fn(),
    connect: jest.fn(() => Promise.reject(new Error('redis disabled in this test'))),
    quit: jest.fn(async () => undefined),
    disconnect: jest.fn(async () => undefined),
    sendCommand: jest.fn(),
    isOpen: false,
  });
  return { createClient: jest.fn(client), default: { createClient: jest.fn(client) } };
});

const ORIGINAL_ENV = { ...process.env };

// Same /64, different interface identifiers.
const V6_A = '2001:db8:1:2::1';
const V6_B = '2001:db8:1:2:ffff:ffff:ffff:9';
// Different /56.
const V6_OTHER = '2001:db8:1:100::1';

function fakeRequest(ip: string): any {
  return {
    ip,
    headers: {},
    body: {},
    socket: { remoteAddress: ip },
    connection: { remoteAddress: ip },
    get: () => undefined,
  };
}

function expectSharedV6Bucket(keyFor: (req: any) => string) {
  const a = keyFor(fakeRequest(V6_A));
  const b = keyFor(fakeRequest(V6_B));
  expect(a).toBe(b);
  expect(a).not.toContain(V6_A);
  expect(keyFor(fakeRequest(V6_OTHER))).not.toBe(a);
  // IPv4 keys are unchanged.
  expect(keyFor(fakeRequest('198.51.100.7'))).toContain('198.51.100.7');
}

describe('backend#1228: IP-based keyGenerators bucket IPv6 by subnet', () => {
  let consoleError: any;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      SILENT_LOGS: 'true',
      DISABLE_FILE_LOG_TRANSPORTS: 'true',
      TRUSTED_PROXIES: '127.0.0.1,::1',
    };
    delete process.env.REDIS_URL;
    mockCaptured.length = 0;
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    const ipv6Errors = consoleError.mock.calls.filter((args: unknown[]) =>
      args.some((arg) => String((arg as any)?.code ?? arg).includes('ERR_ERL_KEY_GEN_IPV6')));
    expect(ipv6Errors).toEqual([]);
    process.env = { ...ORIGINAL_ENV };
    jest.restoreAllMocks();
  });

  it('governance vote/write limiters', () => {
    jest.isolateModules(() => { require('../server/routes/governance-routes.ts'); });
    const custom = mockCaptured.filter((options) => typeof options.keyGenerator === 'function');
    expect(custom.length).toBe(2);
    custom.forEach((options) => expectSharedV6Bucket(options.keyGenerator));
    // Authenticated users still key on their id.
    expect(custom[0].keyGenerator({ ...fakeRequest(V6_A), user: { id: 'user-1' } })).toBe('user-1');
  });

  it('oauth initiation limiter', () => {
    jest.isolateModules(() => { require('../server/routes/oauth-routes.ts'); });
    const custom = mockCaptured.filter((options) => typeof options.keyGenerator === 'function');
    expect(custom.length).toBeGreaterThanOrEqual(1);
    custom.forEach((options) => expectSharedV6Bucket(options.keyGenerator));
  });

  it('bridge rate limiter', () => {
    jest.isolateModules(() => { require('../server/middleware/bridge-security-middleware.ts'); });
    const custom = mockCaptured.filter((options) => typeof options.keyGenerator === 'function');
    expect(custom.length).toBe(1);
    expectSharedV6Bucket(custom[0].keyGenerator);
  });

  it('communication-middleware default limiter', () => {
    jest.isolateModules(() => {
      const { createRateLimiter } = require('../shared/middleware/communication-middleware.ts');
      createRateLimiter();
    });
    const custom = mockCaptured.filter((options) => typeof options.keyGenerator === 'function');
    expect(custom.length).toBe(1);
    expectSharedV6Bucket(custom[0].keyGenerator);
  });

  it('openforis anonymous fallback key', () => {
    jest.isolateModules(() => {
      const { OpenForisRateLimiter } = require('../server/middleware/openforis-rate-limiter.ts');
      const limiter = new OpenForisRateLimiter();
      expectSharedV6Bucket((req) => (limiter as any).generateKey(req, 'read'));
    });
  });

  it('middleware/rateLimiting secureKeyGenerator', () => {
    jest.isolateModules(() => {
      const { secureKeyGenerator, cleanup } = require('../middleware/rateLimiting.js');
      try {
        expectSharedV6Bucket(secureKeyGenerator);
      } finally {
        cleanup?.();
      }
    });
  });

  it('utils/rate-limiter default key generator', () => {
    jest.isolateModules(() => {
      const { rateLimiter } = require('../utils/rate-limiter.js');
      expectSharedV6Bucket((req) => rateLimiter.defaultKeyGenerator(req));
    });
  });

  it('trustedProxyConfig IP and partner keys (cross-chain, partner servers)', () => {
    jest.isolateModules(() => {
      const { getIpRateLimitKey, getPartnerRateLimitKey } = require('../server/utils/trustedProxyConfig.js');
      expectSharedV6Bucket(getIpRateLimitKey);
      expectSharedV6Bucket(getPartnerRateLimitKey);
    });
  });
});
