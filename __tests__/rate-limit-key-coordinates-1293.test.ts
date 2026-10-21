/**
 * backend#1293: the global rate limiter keyed Redis by `<ip>:<raw path>`, so a
 * weather read put the caller's exact coordinate into Redis next to their IP
 * (`ratelimit:api:<ip>:/api/weather/forecast/44.98765,-93.26543`).
 *
 * The key now carries the path with every coordinate-like decimal coarsened to
 * 0.1 deg (server/utils/log-coordinates.js, the #1290 helper). Mobile already
 * sends 0.1 deg, so its buckets are unchanged; distinct routes keep distinct
 * keys. The coordinate below is a synthetic fixture.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const ORIGINAL_ENV = { ...process.env };

let redisMock: any;
let redisKeys: string[];

function createRedisMock() {
  const pipeline = () => {
    const p: any = {
      zremrangebyscore: jest.fn((key: string) => { redisKeys.push(key); return p; }),
      zadd: jest.fn((key: string) => { redisKeys.push(key); return p; }),
      zcard: jest.fn((key: string) => { redisKeys.push(key); return p; }),
      expire: jest.fn((key: string) => { redisKeys.push(key); return p; }),
      exec: jest.fn(async () => [[null, 0], [null, 1], [null, 1], [null, 1]]),
    };
    return p;
  };
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
    pipeline: jest.fn(pipeline),
  };
}

jest.mock('ioredis', () => jest.fn().mockImplementation(() => redisMock));
jest.mock('../server/utils/logger.js', () => ({
  appLogger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

// The fixture coordinate at two or more decimals, in any rendering.
const FINE = /44(\.|%2E)9\d|93(\.|%2E)2\d/i;
const LAT = '44.98765';
const LON = '-93.26543';

describe('rate-limit key carries no fine coordinate (backend#1293)', () => {
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
    redisKeys = [];
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
    jest.restoreAllMocks();
    jest.resetModules();
  });

  const keyFor = (path: string, extra: Record<string, unknown> = {}) =>
    rateLimitModule.generateRateLimitKey(
      { headers: {}, socket: { remoteAddress: '198.51.100.7' }, path, ...extra },
      'ratelimit:api',
    );

  it.each([
    ['forecast', `/api/weather/forecast/${LAT},${LON}`],
    ['alerts', `/api/weather/alerts/${LAT},${LON}`],
    ['current', `/api/weather/data/${LAT},${LON}`],
    ['current observations (#1303)', `/api/weather/current/${LAT},${LON}`],
    ['historical', `/api/weather/historical/${LAT},${LON}`],
    ['encoded comma', `/api/weather/forecast/${LAT}%2C${LON}`],
    ['encoded dot', '/api/weather/forecast/44%2E98765,-93%2E26543'],
  ])('%s: generated key has no fine decimal', (_name, path) => {
    const key = keyFor(path);
    expect(key).not.toMatch(FINE);
    expect(key).toContain('198.51.100.7');
  });

  // backend#1295: forms the handler's parseFloat accepts but the old text redaction missed.
  it.each([
    ['percent-encoded digits', '/api/weather/forecast/44.9%38765,-93.2%36543'],
    ['integer mantissa with exponent', '/api/weather/forecast/4498765e-5,-9326543e-5'],
    ['upper-case exponent', '/api/weather/forecast/4498765E-5,-9326543E-5'],
    ['encoded exponent sign', '/api/weather/forecast/4498765e%2D5,-9326543e%2D5'],
    ['fractional mantissa', '/api/weather/forecast/449876.5e-4,-932654.3e-4'],
    ['fractional mantissa, small exponent', '/api/weather/forecast/4498.765e-2,-9326.543e-2'],
    ['leading-dot mantissa, positive exponent', '/api/weather/forecast/.4498765e2,-.9326543e2'],
    ['positive exponent with fine mantissa', '/api/weather/forecast/4.498765e1,-9.326543e1'],
    ['upper-case with encoded plus', '/api/weather/forecast/4498765E%2D5,-9326543E%2D5'],
  ])('#1295 %s: key has no fine coordinate', (_name, path) => {
    const key = keyFor(path);
    expect(key).not.toMatch(FINE);
    expect(key).not.toMatch(/%3[0-9]/i);
    expect(key).not.toMatch(/\d{5,}e-/i);
    expect(key).not.toMatch(/\d{4,}\.\d+[eE]|[eE]%2[dD]/); // no retained mantissa prefix or encoded exponent sign
    expect(key).toMatch(/45\.0|44\.9|45/); // the 0.1 deg cell is what remains
    expect(key).toContain('198.51.100.7');
  });

  it('#1295 a malformed percent escape does not throw and still redacts', () => {
    const key = keyFor('/api/weather/forecast/44.98765,-93.26543%zz');
    expect(key).not.toMatch(FINE);
  });

  it('#1295 ordinary encoded, non-coordinate paths are byte-identical', () => {
    expect(keyFor('/api/demo/my%20thing')).toBe('ratelimit:api:198.51.100.7:/api/demo/my%20thing');
  });

  it('a raw IncomingMessage (url incl. query) has no fine decimal either', () => {
    const key = rateLimitModule.generateRateLimitKey(
      { headers: {}, socket: { remoteAddress: '198.51.100.7' }, url: `/api/weather/stations?lat=${LAT}&lng=${LON}` },
      'ratelimit:api',
    );
    expect(key).not.toMatch(FINE);
  });

  it('distinct routes still get distinct keys', () => {
    const keys = [
      keyFor(`/api/weather/forecast/${LAT},${LON}`),
      keyFor(`/api/weather/alerts/${LAT},${LON}`),
      keyFor(`/api/weather/data/${LAT},${LON}`),
      keyFor(`/api/weather/current/${LAT},${LON}`),
      keyFor('/api/weather/stations'),
      keyFor('/api/demo'),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(keyFor('/api/demo')).toBe('ratelimit:api:198.51.100.7:/api/demo');
  });

  it('a fine point and its 0.1 deg cell share the bucket mobile already uses', () => {
    expect(keyFor(`/api/weather/forecast/${LAT},${LON}`)).toBe(keyFor('/api/weather/forecast/45.0,-93.3'));
    expect(keyFor('/api/weather/forecast/45.0,-93.3')).toBe('ratelimit:api:198.51.100.7:/api/weather/forecast/45.0,-93.3');
  });

  it('different IPs on the same route keep separate buckets', () => {
    const other = rateLimitModule.generateRateLimitKey(
      { headers: {}, socket: { remoteAddress: '198.51.100.8' }, path: `/api/weather/forecast/${LAT},${LON}` },
      'ratelimit:api',
    );
    expect(other).not.toBe(keyFor(`/api/weather/forecast/${LAT},${LON}`));
  });

  it('end to end: the key the middleware writes to Redis has no fine decimal', async () => {
    const app = express();
    app.use(rateLimitModule.createRateLimitMiddleware({ windowMs: 60000, maxRequests: 100, keyPrefix: 'ratelimit:api' }));
    app.get('/api/weather/forecast/:location', (_req, res) => res.status(200).json({ ok: true }));

    const res = await request(app).get(`/api/weather/forecast/${LAT},${LON}`);

    expect(res.status).toBe(200);
    expect(redisKeys.length).toBeGreaterThan(0);
    for (const key of redisKeys) {
      expect(key).not.toMatch(FINE);
      expect(key).toContain('/api/weather/forecast/');
    }
  });
});
