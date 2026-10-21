/** Legacy middleware remains unit-tested, but no longer fronts a public route. */
import { jest } from '@jest/globals';

process.env.NODE_ENV = 'test';
process.env.OPENFORIS_JWT_SECRET = 'test-openforis-secret-for-retired-middleware';
process.env.OPENFORIS_API_KEYS = '[]';

jest.mock('redis', () => ({
  createClient: jest.fn(() => ({
    connect: jest.fn(),
    get: jest.fn(),
    set: jest.fn(),
    setEx: jest.fn(),
    del: jest.fn(),
    keys: jest.fn(),
    quit: jest.fn(),
    on: jest.fn(),
    sendCommand: jest.fn(),
  })),
}));

jest.mock(
  'rate-limit-redis',
  () => jest.fn().mockImplementation(() => ({})),
  { virtual: true },
);

describe('OpenForis rate limiter class', () => {
  let rateLimiter: any;

  beforeEach(async () => {
    const { OpenForisRateLimiter } = await import(
      '../middleware/openforis-rate-limiter.js'
    );
    rateLimiter = new OpenForisRateLimiter();
  });

  afterEach(async () => {
    if (rateLimiter?.cleanup) await rateLimiter.cleanup();
  });

  it('constructs operation-specific limiters', () => {
    expect(rateLimiter.getGeneralLimiter()).toBeDefined();
    expect(rateLimiter.getProjectLimiter()).toBeDefined();
    expect(rateLimiter.getAnalysisLimiter()).toBeDefined();
  });

  it('reports rate-limit status', async () => {
    await expect(rateLimiter.getRateLimitStatus()).resolves.toBeDefined();
  });
});

describe('OpenForis authentication helpers', () => {
  it('remain importable for legacy callers without exporting a route', async () => {
    const authModule = await import('../middleware/openforis-auth.js');

    expect(typeof authModule.authenticateOpenForisFlexible).toBe('function');
    expect(typeof authModule.authenticateOpenForisOptional).toBe('function');
    expect(typeof authModule.requireOpenForisPermission).toBe('function');
    expect(typeof authModule.requireOpenForisTier).toBe('function');
  });
});
