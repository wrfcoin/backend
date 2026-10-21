/**
 * backend#1228: the shared Redis limiter keyed the raw IPv6 /128, so a client with a /64 got a fresh bucket per
 * address. The bucket key now carries the allocation prefix for IPv6; IPv4 and tailnet (per-device) addresses
 * keep their exact key. Addresses below are documentation/synthetic ranges.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('ioredis', () => jest.fn().mockImplementation(() => ({ status: 'ready', on: jest.fn(), connect: jest.fn(), quit: jest.fn(), disconnect: jest.fn() })));
jest.mock('../server/utils/logger.js', () => ({
  appLogger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

describe('shared rate-limit key for IPv6 clients (backend#1228)', () => {
  let mod: any;
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, NODE_ENV: 'test', SILENT_LOGS: 'true', DISABLE_FILE_LOG_TRANSPORTS: 'true', TRUSTED_PROXIES: '127.0.0.1,::1' };
    jest.spyOn(global, 'setInterval').mockReturnValue({ unref() { return this; }, ref() { return this; }, hasRef() { return false; } } as any);
    jest.resetModules();
    mod = require('../shared/middleware/rate-limit-redis.ts');
  });
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; jest.restoreAllMocks(); jest.resetModules(); });

  const keyFor = (remoteAddress: string, path = '/api/x') =>
    mod.generateRateLimitKey({ headers: {}, socket: { remoteAddress }, path }, 'ratelimit:api');

  it('addresses inside one IPv6 allocation share a bucket', () => {
    const a = keyFor('2001:db8:abcd:12:1111:2222:3333:4444');
    const b = keyFor('2001:db8:abcd:12:ffff:eeee:dddd:cccc');
    const c = keyFor('2001:db8:abcd:34:1:2:3:4'); // same /56, another /64
    expect(a).toBe(b);
    expect(a).toBe(c);
  });

  it('a different allocation gets a different bucket', () => {
    expect(keyFor('2001:db8:abcd:12::1')).not.toBe(keyFor('2001:db8:ffff:12::1'));
  });

  it('IPv4 and IPv4-mapped IPv6 keep their exact key', () => {
    expect(keyFor('198.51.100.7')).toBe('ratelimit:api:198.51.100.7:/api/x');
    expect(keyFor('::ffff:198.51.100.7')).toBe('ratelimit:api:198.51.100.7:/api/x');
    expect(keyFor('198.51.100.8')).not.toBe(keyFor('198.51.100.7'));
  });

  it('tailnet devices keep one bucket per device (S-A3 is not undone)', () => {
    const d1 = keyFor('fd7a:115c:a1e0:ab12:4843:cd96:6200:0001');
    const d2 = keyFor('fd7a:115c:a1e0:ab12:4843:cd96:6200:0002');
    expect(d1).not.toBe(d2);
    expect(d1).toContain('fd7a:115c:a1e0:ab12:4843:cd96:6200:0001');
  });

  it('the exact address never reaches the bucket key for a non-tailnet IPv6 client', () => {
    expect(keyFor('2001:db8:abcd:12:1111:2222:3333:4444')).not.toContain('1111:2222:3333:4444');
  });
});
