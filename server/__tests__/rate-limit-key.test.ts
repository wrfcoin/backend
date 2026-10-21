import { describe, expect, it } from '@jest/globals';
import { createWindowCounter, rateLimitKey } from '../utils/rate-limit-key.js';

describe('rateLimitKey', () => {
  it('IPv6 on the /64, IPv4 on the full address, IPv4-mapped IPv6 as IPv4, in every spelling', () => {
    expect(rateLimitKey('203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitKey('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(rateLimitKey('::ffff:cb00:7109')).toBe('203.0.113.9');
    const prefix = '2001:db8:abcd:12::/64';
    for (const ip of ['2001:db8:abcd:12::1', '2001:db8:abcd:12:ffff:ffff:ffff:ffff', '2001:0DB8:abcd:0012:0:0:0:5', '2001:db8:abcd:12:1:2:3:4%eth0', '[2001:db8:abcd:12::9]']) {
      expect(rateLimitKey(ip)).toBe(prefix);
    }
    expect(rateLimitKey('2001:db8:abcd:13::1')).not.toBe(prefix);
    expect(rateLimitKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(rateLimitKey('')).toBe('unknown');
    expect(rateLimitKey('not an ip')).toBe('unparseable');
  });

  it('strips a port from IPv4 a.b.c.d:port and bracketed [v6]:port before keying, so each port is NOT a fresh budget', () => {
    expect(rateLimitKey('203.0.113.9:51234')).toBe('203.0.113.9');
    expect(rateLimitKey('203.0.113.9:1')).toBe(rateLimitKey('203.0.113.9:65535'));
    expect(rateLimitKey('203.0.113.9:51234')).toBe(rateLimitKey('203.0.113.9'));
    expect(rateLimitKey('[2001:db8:abcd:12::1]:443')).toBe('2001:db8:abcd:12::/64');
    expect(rateLimitKey('[2001:db8:abcd:12::1]:443')).toBe(rateLimitKey('[2001:db8:abcd:12::9]:8080'));
    expect(rateLimitKey('[::ffff:203.0.113.9]:80')).toBe('203.0.113.9');
    expect(rateLimitKey('[2001:db8:abcd:12::1]')).toBe('2001:db8:abcd:12::/64');
    // a bare IPv6 address is never mistaken for host:port
    expect(rateLimitKey('2001:db8:abcd:12::1')).toBe('2001:db8:abcd:12::/64');
  });

  it('every value that is still unparseable shares ONE key, so garbage cannot mint fresh budgets', () => {
    const garbage = ['not an ip', 'x', '999.1.1.1', '1.2.3', '1.2.3.4.5', '203.0.113.9:99999999', '203.0.113.9:abc', '[::1', 'fe80::zz', '1.2.3.4:80:90', '<script>', 'a'.repeat(300)];
    const keys = new Set(garbage.map((g) => rateLimitKey(g)));
    expect([...keys]).toEqual(['unparseable']);
    expect(rateLimitKey('')).toBe('unknown');
  });
});

describe('createWindowCounter', () => {
  it('is hard-bounded at maxKeys: expired entries go first, then the oldest', () => {
    let t = 1_000;
    const counter = createWindowCounter(2, 60_000, () => t, 5);
    for (let i = 0; i < 100; i += 1) counter(`k${i}`);
    expect(counter.size()).toBeLessThanOrEqual(5);
    expect(counter('recent')).toBe(true);
    expect(counter('recent')).toBe(true);
    expect(counter('recent')).toBe(false);
    t += 61_000;
    expect(counter('recent')).toBe(true);
  });
});
