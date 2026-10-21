/**
 * backend#1440: the default API limiter keyed `<ip>:<path>`, so one address's total was bounded per path, not per
 * address. The server now also applies a path-independent per-address budget (RATE_LIMIT_PRESETS.apiIp) alongside
 * the existing per-route limiter. Addresses are documentation/synthetic ranges.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';

// A stateful sorted-set fake: enough of the pipeline checkRateLimit uses.
function createRedisFake() {
  const sets = new Map<string, Array<{ score: number; member: string }>>();
  return {
    status: 'ready',
    on: jest.fn(),
    connect: jest.fn(async () => undefined),
    quit: jest.fn(async () => 'OK'),
    disconnect: jest.fn(),
    ttl: jest.fn(async () => -2),
    exists: jest.fn(async () => 0),
    incr: jest.fn(async () => 1),
    expire: jest.fn(async () => 1),
    setex: jest.fn(async () => 'OK'),
    del: jest.fn(async () => 1),
    pipeline: jest.fn(() => {
      const ops: Array<() => unknown> = [];
      const p: any = {
        zremrangebyscore: (key: string, min: number, max: number) => {
          ops.push(() => { sets.set(key, (sets.get(key) || []).filter(e => e.score < min || e.score > max)); return 0; });
          return p;
        },
        zadd: (key: string, score: number, member: string) => {
          ops.push(() => { sets.set(key, [...(sets.get(key) || []), { score, member }]); return 1; });
          return p;
        },
        zcard: (key: string) => { ops.push(() => (sets.get(key) || []).length); return p; },
        expire: () => { ops.push(() => 1); return p; },
        exec: async () => ops.map(op => [null, op()]),
      };
      return p;
    }),
    keys: () => [...sets.keys()],
  };
}

jest.mock('ioredis', () => jest.fn().mockImplementation(() => (global as any).__redisFake));
jest.mock('../server/utils/logger.js', () => ({
  appLogger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const ORIGINAL_ENV = { ...process.env };

describe('path-independent per-address API budget (backend#1440)', () => {
  let mod: any;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV, NODE_ENV: 'test', SILENT_LOGS: 'true', DISABLE_FILE_LOG_TRANSPORTS: 'true',
      TRUSTED_PROXIES: '127.0.0.1,::1', RATE_LIMIT_API_IP_MAX_REQUESTS: '5', RATE_LIMIT_API_MAX_REQUESTS: '100',
    };
    (global as any).__redisFake = createRedisFake();
    jest.spyOn(global, 'setInterval').mockReturnValue({ unref() { return this; }, ref() { return this; }, hasRef() { return false; } } as any);
    jest.resetModules();
    mod = require('../shared/middleware/rate-limit-redis.ts');
  });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; jest.restoreAllMocks(); jest.resetModules(); delete (global as any).__redisFake; });

  // The same chain the server mounts: path-independent per-address budget first, then the per-route limiter.
  function appFor(remote: string) {
    const app = express();
    app.set('trust proxy', false);
    app.use((req, _res, next) => { Object.defineProperty(req.socket, 'remoteAddress', { value: remote, configurable: true }); next(); });
    app.use(mod.createRateLimitMiddleware({ ...mod.RATE_LIMIT_PRESETS.apiIp, keyGenerator: mod.apiIpBudgetKey }));
    app.use(mod.createRateLimitMiddleware({ ...mod.RATE_LIMIT_PRESETS.api }));
    app.use((_req, res) => res.status(200).json({ ok: true }));
    return app;
  }
  const statuses = async (app: express.Express, paths: string[]) => {
    const out: number[] = [];
    for (const p of paths) out.push((await request(app).get(p)).status);
    return out;
  };

  it('baseline: the per-route limiter alone does not bound distinct paths (the property the new budget adds)', async () => {
    process.env.RATE_LIMIT_API_MAX_REQUESTS = '5';
    jest.resetModules();
    mod = require('../shared/middleware/rate-limit-redis.ts');
    const app = express();
    app.use(mod.createRateLimitMiddleware({ ...mod.RATE_LIMIT_PRESETS.api }));
    app.use((_req, res) => res.status(200).json({ ok: true }));
    const s = await statuses(app, Array.from({ length: 8 }, (_, i) => `/api/y${i}`));
    expect(s.every(code => code === 200)).toBe(true);
  });

  it('exposes a configured per-address budget preset', () => {
    expect(mod.RATE_LIMIT_PRESETS.apiIp.maxRequests).toBe(5);
    expect(mod.RATE_LIMIT_PRESETS.apiIp.windowMs).toBeGreaterThan(0);
  });

  it('N requests over N distinct paths from one address hit the cap', async () => {
    const app = appFor('198.51.100.7');
    const s = await statuses(app, Array.from({ length: 8 }, (_, i) => `/api/x${i}`));
    expect(s.slice(0, 5)).toEqual([200, 200, 200, 200, 200]);
    expect(s.slice(5)).toEqual([429, 429, 429]);
  });

  it('a different address has its own budget', async () => {
    await statuses(appFor('198.51.100.7'), Array.from({ length: 8 }, (_, i) => `/api/x${i}`));
    expect(await statuses(appFor('198.51.100.8'), ['/api/a'])).toEqual([200]);
  });

  it('two IPv6 addresses in one allocation share the budget', async () => {
    const first = appFor('2001:db8:abcd:12:1111:2222:3333:4444');
    const second = appFor('2001:db8:abcd:12:ffff:eeee:dddd:cccc');
    await statuses(first, ['/a', '/b', '/c']);
    const s = await statuses(second, ['/d', '/e', '/f', '/g']);
    expect(s).toEqual([200, 200, 429, 429]);
  });

  it('the per-route limiter is unchanged: its key still carries the path', async () => {
    const key = (p: string) => mod.generateRateLimitKey({ headers: {}, socket: { remoteAddress: '198.51.100.7' }, path: p }, 'ratelimit:api');
    expect(key('/api/a')).not.toBe(key('/api/b'));
    expect(mod.apiIpBudgetKey({ headers: {}, socket: { remoteAddress: '198.51.100.7' }, path: '/api/a' }))
      .toBe(mod.apiIpBudgetKey({ headers: {}, socket: { remoteAddress: '198.51.100.7' }, path: '/api/b' }));
  });

  it('the server mounts the per-address budget with the path-free key, before the per-route limiter', () => {
    const src = readFileSync('server/enhanced_unified_api_optimized.ts', 'utf8');
    expect(src).toMatch(/const enhancedApiIpRateLimit = createRateLimitMiddleware\(\{\s+\.\.\.RATE_LIMIT_PRESETS\.apiIp,\s+keyGenerator: apiIpBudgetKey,/);
    const ip = src.indexOf('app.use(enhancedApiIpRateLimit);');
    const route = src.indexOf('app.use(enhancedApiRateLimit);');
    expect(ip).toBeGreaterThan(-1);
    expect(route).toBeGreaterThan(ip);
  });
});
