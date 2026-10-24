import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * backend#1229: the limiter and the 1 h auto-ban keyed on the frontend nginx
 * container's address, so one tailnet client's failed logins banned every
 * client behind that proxy.
 *
 * Ingress paths into the backend (header provenance: tailscaled's serve/funnel
 * reverse proxy SETS X-Forwarded-For to the true source address, overwriting
 * anything the client sent — tailscale ipn/ipnlocal/serve.go
 * addProxyForwardedHeaders, unchanged since at least v1.50.0):
 *
 *   tailnet: client → tailscale serve (XFF = client) → docker-proxy (bridge
 *            gateway) → frontend nginx ($proxy_add_x_forwarded_for appends the
 *            gateway) → backend.  Backend sees peer = nginx,
 *            XFF = "<client>, <gateway>".
 *   funnel:  client → tailscale funnel (XFF = client) → docker-proxy (bridge
 *            gateway) → funnel-edge Caddy → backend.  Today Caddy trusts no
 *            proxy, so it REPLACES XFF with its peer: XFF = "<gateway>".  With
 *            the companion infra change it trusts the gateway and appends:
 *            XFF = "<client>, <gateway>".
 *
 * Two configurations are exercised: the one deployed today (TRUSTED_PROXIES
 * unset, bridge addresses dynamic) and the exact value the companion infra PR
 * sets (a pinned wrfcoin-ingress network, 10.251.0.0/24).
 */

const ORIGINAL_ENV = { ...process.env };

// Today's deployment: dynamic addresses on the wrfcoin-testnet bridge.
const TODAY_GATEWAY = '172.18.0.1';
const TODAY_NGINX = '172.18.0.5';
const TODAY_FUNNEL_EDGE = '172.18.0.7';

// Companion infra PR: pinned wrfcoin-ingress network.
const INGRESS_GATEWAY = '10.251.0.1';
const INGRESS_NGINX = '10.251.0.10';
const INGRESS_EDGE = '10.251.0.11';
const INGRESS_FUNNEL_EDGE = '10.251.0.12';
const CONFIGURED_TRUSTED_PROXIES =
  `127.0.0.1,::1,${INGRESS_GATEWAY},${INGRESS_NGINX},${INGRESS_EDGE},${INGRESS_FUNNEL_EDGE}`;

const TAILNET_A = '100.64.0.10';
const TAILNET_B = '100.64.0.20';
const PUBLIC_A = '203.0.113.5';
const PUBLIC_B = '198.51.100.9';

let redisMock: any;

// Just enough of ioredis for checkRateLimit / isIpBlocked / recordViolation,
// with real state so buckets and bans are observable.
function createStatefulRedis() {
  const zsets = new Map<string, number[]>();
  const counters = new Map<string, number>();
  const expiring = new Map<string, number>();
  return {
    zsets,
    counters,
    expiring,
    status: 'ready',
    on: jest.fn(),
    connect: jest.fn(async () => undefined),
    quit: jest.fn(async () => 'OK'),
    disconnect: jest.fn(),
    ttl: jest.fn(async (key: string) => (expiring.has(key) ? expiring.get(key) : -2)),
    exists: jest.fn(async (key: string) => (expiring.has(key) ? 1 : 0)),
    incr: jest.fn(async (key: string) => {
      const next = (counters.get(key) || 0) + 1;
      counters.set(key, next);
      return next;
    }),
    expire: jest.fn(async () => 1),
    setex: jest.fn(async (key: string, seconds: number) => {
      expiring.set(key, seconds);
      return 'OK';
    }),
    del: jest.fn(async (...keys: string[]) => {
      keys.forEach((key) => counters.delete(key));
      return keys.length;
    }),
    pipeline: jest.fn(() => {
      let key = '';
      const pipe: any = {
        zremrangebyscore: () => pipe,
        zadd: (k: string, score: number) => {
          key = k;
          zsets.set(k, [...(zsets.get(k) || []), score]);
          return pipe;
        },
        zcard: () => pipe,
        expire: () => pipe,
        exec: async () => [[null, 0], [null, 1], [null, (zsets.get(key) || []).length], [null, 1]],
      };
      return pipe;
    }),
  };
}

jest.mock('ioredis', () => jest.fn().mockImplementation(() => redisMock));

jest.mock('../server/utils/logger.js', () => ({
  appLogger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

function request(peer: string, forwardedFor?: string): any {
  return {
    headers: forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor },
    socket: { remoteAddress: peer },
    path: '/api/auth/wallet-login',
  };
}

function fakeResponse(): any {
  const res: any = { statusCode: 200, body: undefined, headers: {} };
  res.setHeader = (name: string, value: string) => { res.headers[name] = value; };
  res.status = (code: number) => { res.statusCode = code; return res; };
  res.json = (body: unknown) => { res.body = body; return res; };
  return res;
}

async function send(middleware: any, req: any): Promise<{ status: number; code?: string }> {
  const res = fakeResponse();
  let passed = false;
  await middleware(req, res, () => { passed = true; });
  return passed ? { status: 200 } : { status: res.statusCode, code: res.body?.error?.code };
}

async function sendMany(middleware: any, makeReq: () => any, count: number) {
  const results = [];
  for (let i = 0; i < count; i += 1) results.push(await send(middleware, makeReq()));
  return results;
}

function loadRateLimit(trustedProxies: string | undefined) {
  process.env = {
    ...ORIGINAL_ENV,
    NODE_ENV: 'test',
    SILENT_LOGS: 'true',
    DISABLE_FILE_LOG_TRANSPORTS: 'true',
    RATE_LIMIT_BLOCK_THRESHOLD: '2',
  };
  if (trustedProxies === undefined) {
    delete process.env.TRUSTED_PROXIES;
  } else {
    process.env.TRUSTED_PROXIES = trustedProxies;
  }
  redisMock = createStatefulRedis();
  jest.spyOn(global, 'setInterval').mockReturnValue({
    unref() { return this; },
    ref() { return this; },
    hasRef() { return false; },
  } as any);
  jest.resetModules();
  return require('../shared/middleware/rate-limit-redis.ts');
}

function authLimiter(rateLimit: any) {
  return rateLimit.createRateLimitMiddleware({ windowMs: 900_000, maxRequests: 2, keyPrefix: 'ratelimit:auth' });
}

function banKeys(): string[] {
  return [...redisMock.expiring.keys()].filter((key) => key.startsWith('ratelimit:blocked:'));
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  jest.restoreAllMocks();
  jest.resetModules();
});

describe('backend#1229 with the DEPLOYED configuration (TRUSTED_PROXIES unset)', () => {
  let rateLimit: any;

  beforeEach(() => {
    rateLimit = loadRateLimit(undefined);
  });

  it('classifies both ingress paths as a shared proxy address, not a client', () => {
    expect(rateLimit.resolveClientIp(request(TODAY_NGINX, `${TAILNET_A}, ${TODAY_GATEWAY}`)))
      .toEqual({ ip: TODAY_NGINX, shared: true });
    expect(rateLimit.resolveClientIp(request(TODAY_FUNNEL_EDGE, TODAY_GATEWAY)))
      .toEqual({ ip: TODAY_FUNNEL_EDGE, shared: true });
    // CT101 host → 127.0.0.1:4001 arrives from the bridge gateway, no XFF.
    expect(rateLimit.resolveClientIp(request(TODAY_GATEWAY)))
      .toEqual({ ip: TODAY_GATEWAY, shared: true });
  });

  it('tailnet: client A tripping the limit never bans client B (shared bucket, no ban)', async () => {
    const limiter = authLimiter(rateLimit);
    const a = await sendMany(limiter, () => request(TODAY_NGINX, `${TAILNET_A}, ${TODAY_GATEWAY}`), 8);
    expect(a.slice(0, 2).map((r) => r.status)).toEqual([200, 200]);
    expect(a.map((r) => r.code)).not.toContain('IP_BLOCKED');

    // Without trusted-proxy config the clients share nginx's bucket, so B is
    // rate-limited by A's traffic — but never IP_BLOCKED.
    const b = await send(limiter, request(TODAY_NGINX, `${TAILNET_B}, ${TODAY_GATEWAY}`));
    expect(b).toEqual({ status: 429, code: 'RATE_LIMIT_EXCEEDED' });
    expect(banKeys()).toEqual([]);
  });

  it('funnel: client A tripping the limit never bans client B (shared bucket, no ban)', async () => {
    const limiter = authLimiter(rateLimit);
    const a = await sendMany(limiter, () => request(TODAY_FUNNEL_EDGE, TODAY_GATEWAY), 8);
    expect(a.map((r) => r.code)).not.toContain('IP_BLOCKED');
    const b = await send(limiter, request(TODAY_FUNNEL_EDGE, TODAY_GATEWAY));
    expect(b.code).not.toBe('IP_BLOCKED');
    expect(banKeys()).toEqual([]);
  });

  it('does not enforce a ban already stored on a shared address', async () => {
    redisMock.expiring.set(`ratelimit:blocked:${TODAY_NGINX}`, 3000);
    const limiter = authLimiter(rateLimit);
    expect(await send(limiter, request(TODAY_NGINX, `${TAILNET_A}, ${TODAY_GATEWAY}`))).toEqual({ status: 200 });
  });

  it('still bans a public client that reaches the backend directly, XFF or not', async () => {
    const limiter = authLimiter(rateLimit);
    const direct = await sendMany(limiter, () => request(PUBLIC_A), 6);
    expect(direct[direct.length - 1]).toEqual({ status: 429, code: 'IP_BLOCKED' });

    // A forged XFF from an untrusted public peer neither changes its key nor
    // buys it the shared-address exemption.
    const forged = await sendMany(limiter, () => request(PUBLIC_B, '10.0.0.5'), 6);
    expect(forged[forged.length - 1]).toEqual({ status: 429, code: 'IP_BLOCKED' });
    expect(banKeys().sort()).toEqual([`ratelimit:blocked:${PUBLIC_A}`, `ratelimit:blocked:${PUBLIC_B}`].sort());
  });
});

describe('backend#1229 with the companion infra configuration (pinned wrfcoin-ingress)', () => {
  let rateLimit: any;

  beforeEach(() => {
    rateLimit = loadRateLimit(CONFIGURED_TRUSTED_PROXIES);
  });

  const paths: Array<[string, (client: string) => any]> = [
    ['tailnet (serve → nginx)', (client) => request(INGRESS_NGINX, `${client}, ${INGRESS_GATEWAY}`)],
    ['funnel (funnel → funnel-edge Caddy)', (client) => request(INGRESS_FUNNEL_EDGE, `${client}, ${INGRESS_GATEWAY}`)],
    ['public edge (443 Caddy)', (client) => request(INGRESS_EDGE, client)],
  ];

  it.each(paths)('%s: resolves each client to its own non-shared address', (_name, via) => {
    expect(rateLimit.resolveClientIp(via(TAILNET_A))).toEqual({ ip: TAILNET_A, shared: false });
    expect(rateLimit.resolveClientIp(via(PUBLIC_B))).toEqual({ ip: PUBLIC_B, shared: false });
  });

  it.each(paths)('%s: A is limited and banned, B behind the same proxy still gets 200', async (_name, via) => {
    const limiter = authLimiter(rateLimit);
    const a = await sendMany(limiter, () => via(PUBLIC_A), 6);
    expect(a.slice(0, 2).map((r) => r.status)).toEqual([200, 200]);
    expect(a.map((r) => r.code)).toContain('RATE_LIMIT_EXCEEDED');
    expect(a[a.length - 1]).toEqual({ status: 429, code: 'IP_BLOCKED' });

    expect(await send(limiter, via(PUBLIC_B))).toEqual({ status: 200 });
    expect(banKeys()).toEqual([`ratelimit:blocked:${PUBLIC_A}`]);
  });

  it('a client banned on one ingress path does not ban a different client on the other', async () => {
    const limiter = authLimiter(rateLimit);
    await sendMany(limiter, () => request(INGRESS_NGINX, `${TAILNET_A}, ${INGRESS_GATEWAY}`), 6);
    expect(await send(limiter, request(INGRESS_FUNNEL_EDGE, `${PUBLIC_B}, ${INGRESS_GATEWAY}`))).toEqual({ status: 200 });
    expect(await send(limiter, request(INGRESS_NGINX, `${TAILNET_B}, ${INGRESS_GATEWAY}`))).toEqual({ status: 200 });
  });

  it('ignores X-Forwarded-For from an untrusted peer', () => {
    expect(rateLimit.getClientIp(request(PUBLIC_A, '192.0.2.7'))).toBe(PUBLIC_A);
  });

  it('does not let a client choose its key by prepending X-Forwarded-For entries', () => {
    const chain = `192.0.2.7, ${TAILNET_A}, ${INGRESS_GATEWAY}`;
    expect(rateLimit.getClientIp(request(INGRESS_NGINX, chain))).toBe(TAILNET_A);
  });

  it('stops at a malformed entry instead of adopting it', () => {
    expect(rateLimit.resolveClientIp(request(INGRESS_NGINX, `garbage, ${INGRESS_GATEWAY}`)))
      .toEqual({ ip: INGRESS_GATEWAY, shared: true });
  });

  it('never bans a proxy when every hop is a proxy (CT101 loopback → :5000)', async () => {
    const limiter = authLimiter(rateLimit);
    const results = await sendMany(limiter, () => request(INGRESS_NGINX, INGRESS_GATEWAY), 6);
    expect(results.map((r) => r.code)).not.toContain('IP_BLOCKED');
    expect(results[results.length - 1]).toEqual({ status: 429, code: 'RATE_LIMIT_EXCEEDED' });
    expect(await rateLimit.recordViolation(INGRESS_NGINX)).toBe(false);
    await rateLimit.blockIp(INGRESS_GATEWAY);
    expect(banKeys()).toEqual([]);
  });

  it('accepts CIDR entries in TRUSTED_PROXIES', () => {
    rateLimit = loadRateLimit('127.0.0.1,10.251.0.0/24');
    expect(rateLimit.isTrustedProxy(INGRESS_NGINX)).toBe(true);
    expect(rateLimit.isTrustedProxy(`::ffff:${INGRESS_GATEWAY}`)).toBe(true);
    expect(rateLimit.isTrustedProxy('10.251.1.5')).toBe(false);
    expect(rateLimit.isTrustedProxy('not-an-ip')).toBe(false);
  });
});

describe('backend#1229: Express req.ip and getSecureClientIp agree on the client', () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, TRUSTED_PROXIES: `127.0.0.1,::1,${INGRESS_GATEWAY}` };
    jest.resetModules();
  });

  it('resolves the client right to left through the trust-proxy evaluator', async () => {
    const express = require('express');
    const supertest = require('supertest');
    const { trustKnownProxy, getTrustedClientIp } = require('../server/utils/trustedProxyConfig.js');

    const app = express();
    app.set('trust proxy', trustKnownProxy);
    app.get('/ip', (req: any, res: any) => res.json({ ip: req.ip, secure: getTrustedClientIp(req) }));

    // supertest connects over loopback, which stands in for nginx here.
    const honest = await supertest(app).get('/ip').set('X-Forwarded-For', `${TAILNET_A}, ${INGRESS_GATEWAY}`);
    expect(honest.body).toEqual({ ip: TAILNET_A, secure: TAILNET_A });

    const spoofed = await supertest(app).get('/ip').set('X-Forwarded-For', `192.0.2.7, ${TAILNET_B}, ${INGRESS_GATEWAY}`);
    expect(spoofed.body).toEqual({ ip: TAILNET_B, secure: TAILNET_B });
  });

  it('refuses to auto-block a trusted proxy in EnhancedRateLimit', async () => {
    const EnhancedRateLimit = require('../server/utils/rateLimitEnhanced.js');
    const limiter = new EnhancedRateLimit();
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await limiter.blockIp(INGRESS_GATEWAY, 'test');
      expect((await limiter.isIpBlocked(INGRESS_GATEWAY)).blocked).toBe(false);
    } finally {
      limiter.stopCleanup();
    }
  });
  it('does not count or escalate violations on a trusted proxy in EnhancedRateLimit, warning once', async () => {
    const EnhancedRateLimit = require('../server/utils/rateLimitEnhanced.js');
    const limiter = new EnhancedRateLimit();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      for (let i = 0; i < limiter.config.suspiciousThreshold + 2; i++) {
        expect(await limiter.recordViolation(INGRESS_GATEWAY)).toBe(false);
      }
      expect(limiter.violationCounts.has(INGRESS_GATEWAY)).toBe(false);
      expect((await limiter.isIpBlocked(INGRESS_GATEWAY)).blocked).toBe(false);
      expect(warn.mock.calls.filter((c) => String(c[0]).includes(INGRESS_GATEWAY))).toHaveLength(1);
      // an ordinary client is still counted and banned
      let banned = false;
      for (let i = 0; i < limiter.config.suspiciousThreshold; i++) banned = await limiter.recordViolation(PUBLIC_A);
      expect(banned).toBe(true);
    } finally {
      limiter.stopCleanup();
    }
  });
});
