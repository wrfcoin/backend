import express from 'express';
import request from 'supertest';

jest.mock('redis', () => ({ createClient: () => ({
  on: jest.fn(),
  connect: async () => { throw new Error('test-only Redis unavailable'); },
  quit: async () => {},
}) }));
jest.mock('../utils/rate-limiter.js', () => ({ rateLimiter: {} }));
jest.mock('../server/utils/logger.js', () => ({ appLogger: {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(),
} }));

import { OpenForisRateLimiter } from '../server/middleware/openforis-rate-limiter.js';

async function expectLimit(user: unknown, tier: string, limit: number) {
  const limiter = new OpenForisRateLimiter({ general: { max: 1, windowMs: 60000 } });
  const app = express();
  app.use((req, _res, next) => { (req as any).user = user; next(); });
  app.get('/tier', limiter.getGeneralLimiter(), limiter.addRateLimitHeaders(), (_req, res) => res.json({ ok: true }));
  try {
    for (let i = 0; i < limit; i++) {
      const res = await request(app).get('/tier');
      expect(res.status).toBe(200);
      expect(res.headers['x-ratelimit-tier']).toBe(tier);
      expect(res.headers['x-ratelimit-limit']).toBe(String(limit));
    }
    const denied = await request(app).get('/tier');
    expect(denied.status).toBe(429);
    expect(denied.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
  } finally {
    await limiter.cleanup();
  }
}

it.each([
  'notadmin', 'admin', 'notenterprise', 'enterprise', 'notpremium', 'premium',
  'premium,bulk_operations', null, undefined, 123, { admin: true },
  [], ['notadmin'], ['ADMIN'],
])('malformed or nonmatching permissions=%j retain the free limit', async permissions => {
  await expectLimit({ id: 'ordinary-user', role: 'user', permissions }, 'free', 1);
});

it.each([
  { permissions: ['admin'], tier: 'admin', limit: 10 },
  { permissions: ['read', 'admin'], tier: 'admin', limit: 10 },
  { permissions: ['enterprise'], tier: 'enterprise', limit: 5 },
  { permissions: ['premium', 'bulk_operations'], tier: 'enterprise', limit: 5 },
  { permissions: ['premium'], tier: 'premium', limit: 2 },
  { permissions: ['bulk_operations'], tier: 'free', limit: 1 },
])('exact array permissions preserve $tier limit $limit', async ({ permissions, tier, limit }) => {
  await expectLimit({ id: 'array-user', role: 'user', permissions }, tier, limit);
});

it.each([
  { role: 'admin', tier: 'admin', limit: 10 },
  { role: 'premium', tier: 'premium', limit: 2 },
])('preserves independent scalar $role role tier', async ({ role, tier, limit }) => {
  await expectLimit({ id: 'scalar-user', role, permissions: [] }, tier, limit);
});

it('keeps anonymous requests at the free limit', async () => {
  await expectLimit(undefined, 'free', 1);
});
