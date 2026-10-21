import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };

describe('trusted proxy helpers for cross-chain services', () => {
  let proxyHelpers: any;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      TRUSTED_PROXIES: '127.0.0.1,::1',
    };
    jest.resetModules();
    proxyHelpers = require('../server/utils/trustedProxyConfig.js');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.resetModules();
  });

  it('accepts forwarded client ip only from trusted proxies', () => {
    const trustedProxyRequest: any = {
      headers: {
        'x-forwarded-for': '198.51.100.25, 127.0.0.1',
      },
      socket: {
        remoteAddress: '127.0.0.1',
      },
    };

    const spoofedRequest: any = {
      headers: {
        'x-forwarded-for': '203.0.113.10',
      },
      socket: {
        remoteAddress: '10.20.30.40',
      },
    };

    expect(proxyHelpers.getTrustedClientIp(trustedProxyRequest)).toBe('198.51.100.25');
    expect(proxyHelpers.getIpRateLimitKey(trustedProxyRequest)).toBe('198.51.100.25');
    expect(proxyHelpers.getTrustedClientIp(spoofedRequest)).toBe('10.20.30.40');
    expect(proxyHelpers.getIpRateLimitKey(spoofedRequest)).toBe('10.20.30.40');
  });

  it('uses partner id when available and secure ip fallback otherwise', () => {
    const partnerRequest: any = {
      headers: {
        'x-partner-id': 'PARTNER_001',
        'x-forwarded-for': '198.51.100.30',
      },
      socket: {
        remoteAddress: '127.0.0.1',
      },
    };

    const anonymousRequest: any = {
      headers: {
        'x-forwarded-for': '198.51.100.44',
      },
      socket: {
        remoteAddress: '10.0.0.8',
      },
    };

    expect(proxyHelpers.getPartnerRateLimitKey(partnerRequest)).toBe('PARTNER_001');
    expect(proxyHelpers.getPartnerRateLimitKey(anonymousRequest)).toBe('10.0.0.8');
  });

  it('exposes a trust proxy evaluator backed by the allowlist', () => {
    expect(proxyHelpers.trustKnownProxy('127.0.0.1')).toBe(true);
    expect(proxyHelpers.trustKnownProxy('::1')).toBe(true);
    expect(proxyHelpers.trustKnownProxy('192.0.2.10')).toBe(false);
  });
});
