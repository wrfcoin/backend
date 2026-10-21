/**
 * Tests for the read-only Pythia sidecar routes — backend#896.
 *
 * Mounted at /api/pythia. These routes are unauthenticated by design, read-only
 * against a Redis cache the sidecar owns, and must degrade to 503 rather than
 * hang or 500 when Redis is unreachable.
 *
 * The three properties worth locking down, because each one silently regresses:
 *   1. bounded reads   — /bounties must never HGETALL an operator-owned hash;
 *   2. bounded exposure — the router must carry a rate limiter;
 *   3. honest staleness — a garbage PYTHIA_MAX_FEED_AGE_MS must not make
 *      /health report a dead feed as fresh.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

// ---------------------------------------------------------------------------
// Mocks — must be hoisted before any import that uses them
// ---------------------------------------------------------------------------

const mockGet = jest.fn<(key: string) => Promise<string | null>>();
const mockHgetall = jest.fn<(key: string) => Promise<Record<string, string>>>();
const mockHscan =
  jest.fn<(...args: unknown[]) => Promise<[string, string[]]>>();
const mockXrevrange =
  jest.fn<(...args: unknown[]) => Promise<Array<[string, string[]]>>>();
const mockOn = jest.fn();

jest.mock('../../server/utils/create-redis.js', () => ({
  createRedisClient: jest.fn(() => ({
    get: mockGet,
    hgetall: mockHgetall,
    hscan: mockHscan,
    xrevrange: mockXrevrange,
    on: mockOn,
  })),
}));

// The limiter is exercised as a mount-point assertion below rather than by
// driving 100 requests through it; here it is a pass-through so the route
// assertions stay about the routes.
//
// Match the real source import. Fresh-process source and compiled mount
// tests separately prove resolution and the actual limiter; this unit mock
// keeps payload assertions independent of rate-limit state.
const mockGeneralLimiter = jest.fn((_req: any, _res: any, next: any) => next());
jest.mock(
  '../../middleware/rateLimiting.js',
  () => ({ generalLimiter: mockGeneralLimiter }),
);

const loadApp = async () => {
  const { default: router } = await import('../../server/routes/pythia-routes.js');
  const app = express();
  app.use('/api/pythia', router);
  return app;
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGet.mockResolvedValue(null);
  mockHgetall.mockResolvedValue({});
  mockHscan.mockResolvedValue(['0', []]);
  mockXrevrange.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// 1. Bounded reads — the MEDIUM finding on /bounties
// ---------------------------------------------------------------------------

describe('GET /api/pythia/bounties — bounded reads', () => {
  it('never calls HGETALL on the operator-owned active-bounty hash', async () => {
    const app = await loadApp();
    await request(app).get('/api/pythia/bounties').expect(200);

    expect(mockHscan).toHaveBeenCalled();
    // The regression this guards: an unauthenticated request pulling an
    // unbounded hash into memory and onto the wire.
    expect(mockHgetall).not.toHaveBeenCalledWith('pythia:bounty:active');
  });

  it('caps the active list and reports the truncation honestly', async () => {
    // One page far larger than the default cap of 100, and a non-zero cursor so
    // more data plainly remains.
    const flat: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      flat.push(`intent-${i}`, JSON.stringify({ id: i }));
    }
    mockHscan.mockResolvedValue(['42', flat]);

    const app = await loadApp();
    const res = await request(app).get('/api/pythia/bounties').expect(200);

    expect(res.body.active).toHaveLength(100);
    expect(res.body.active_limit).toBe(100);
    expect(res.body.active_truncated).toBe(true);
    expect(res.body.intents_limit).toBe(50);
  });

  it('reports a complete short list as NOT truncated', async () => {
    // RED CONTROL for the truncation flag: with the condition absent, the flag
    // must be false. A detector that always says "truncated" is useless.
    mockHscan.mockResolvedValue(['0', ['intent-a', '{"id":"a"}']]);

    const app = await loadApp();
    const res = await request(app).get('/api/pythia/bounties').expect(200);

    expect(res.body.active).toEqual([{ intent_id: 'intent-a', intent: { id: 'a' } }]);
    expect(res.body.active_truncated).toBe(false);
  });

  it('stops scanning on the iteration guard instead of looping forever', async () => {
    // A hash whose cursor never returns to 0 — without the guard this is an
    // unbounded command loop driven by one anonymous request.
    mockHscan.mockResolvedValue(['99', []]);

    const app = await loadApp();
    const res = await request(app).get('/api/pythia/bounties').expect(200);

    expect(mockHscan.mock.calls.length).toBeLessThanOrEqual(20);
    // Stopping on the guard is still truncation and must be reported as such.
    expect(res.body.active_truncated).toBe(true);
  });

  it('caps the intent stream with COUNT rather than reading it whole', async () => {
    const app = await loadApp();
    await request(app).get('/api/pythia/bounties').expect(200);

    expect(mockXrevrange).toHaveBeenCalledWith(
      'pythia:bounty:intents',
      '+',
      '-',
      'COUNT',
      50,
    );
  });
});

// ---------------------------------------------------------------------------
// 2. Bounded exposure — the MEDIUM rate-limiter finding
// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('runs the shared general limiter on every Pythia route', async () => {
    const app = await loadApp();

    await request(app).get('/api/pythia/health').expect(200);
    await request(app).get('/api/pythia/predictions').expect(200);
    await request(app).get('/api/pythia/events').expect(200);
    await request(app).get('/api/pythia/bounties').expect(200);

    // Unauthenticated + unmetered + Redis-backed is the amplification shape
    // this guards against.
    expect(mockGeneralLimiter).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// 3. Honest staleness — the LOW NaN finding on PYTHIA_MAX_FEED_AGE_MS
// ---------------------------------------------------------------------------

describe('GET /api/pythia/health — staleness', () => {
  const withEnv = async (value: string | undefined, run: () => Promise<void>) => {
    const previous = process.env.PYTHIA_MAX_FEED_AGE_MS;
    if (value === undefined) delete process.env.PYTHIA_MAX_FEED_AGE_MS;
    else process.env.PYTHIA_MAX_FEED_AGE_MS = value;
    jest.resetModules();
    try {
      await run();
    } finally {
      if (previous === undefined) delete process.env.PYTHIA_MAX_FEED_AGE_MS;
      else process.env.PYTHIA_MAX_FEED_AGE_MS = previous;
      jest.resetModules();
    }
  };

  it('falls back to the documented default when the env var is garbage', async () => {
    await withEnv('not-a-number', async () => {
      // An ancient heartbeat: stale under ANY sane threshold.
      mockHgetall.mockResolvedValue({ last_heartbeat_at: '1' });

      const app = await loadApp();
      const res = await request(app).get('/api/pythia/health').expect(200);

      // The bug: NaN loses every comparison, so `feedAge > NaN` is false and a
      // dead feed reads as fresh forever.
      expect(res.body.max_feed_age_ms).toBe(900000);
      expect(res.body.stale).toBe(true);
    });
  });

  it('honours a valid override', async () => {
    // RED CONTROL for the fallback: a legitimate value must NOT be replaced by
    // the default, or the guard would be indistinguishable from ignoring the
    // env var entirely.
    await withEnv('123456', async () => {
      mockHgetall.mockResolvedValue({ last_heartbeat_at: String(Date.now()) });

      const app = await loadApp();
      const res = await request(app).get('/api/pythia/health').expect(200);

      expect(res.body.max_feed_age_ms).toBe(123456);
      expect(res.body.stale).toBe(false);
    });
  });

  it('treats a missing heartbeat as maximally stale', async () => {
    mockHgetall.mockResolvedValue({});

    const app = await loadApp();
    const res = await request(app).get('/api/pythia/health').expect(200);

    expect(res.body.meta).toBeNull();
    expect(res.body.feed_age_ms).toBeNull();
    expect(res.body.stale).toBe(true);
  });

  // backend#1224: `meta` carries the sidecar git commit and heartbeats.
  describe('meta is operator/reader detail', () => {
    const meta = { last_heartbeat_at: String(Date.now()), git_commit: 'deadbeef' };
    afterEach(() => {
      delete process.env.WRFCOIN_READER_TOKEN;
    });

    it('is null for anonymous callers, who keep the staleness verdict', async () => {
      mockHgetall.mockResolvedValue(meta);

      const app = await loadApp();
      const res = await request(app).get('/api/pythia/health').expect(200);

      expect(res.body.meta).toBeNull();
      expect(res.body.stale).toBe(false);
      expect(JSON.stringify(res.body)).not.toContain('deadbeef');
    });

    it('is returned to a reader bearer token', async () => {
      process.env.WRFCOIN_READER_TOKEN = 'test-reader-token';
      mockHgetall.mockResolvedValue(meta);

      const app = await loadApp();
      const res = await request(app)
        .get('/api/pythia/health')
        .set('Authorization', 'Bearer test-reader-token')
        .expect(200);

      expect(res.body.meta).toEqual(meta);
    });
  });
});

// ---------------------------------------------------------------------------
// 4. Read-only contract + graceful degradation (regression cover for the
//    properties the review verified by hand)
// ---------------------------------------------------------------------------

describe('read-only contract and degradation', () => {
  it('degrades to 503 on Redis failure, never 500', async () => {
    const boom = new Error('ECONNREFUSED');
    mockGet.mockRejectedValue(boom);
    mockHgetall.mockRejectedValue(boom);
    mockHscan.mockRejectedValue(boom);
    mockXrevrange.mockRejectedValue(boom);

    const app = await loadApp();
    for (const path of ['/predictions', '/events', '/health', '/bounties', '/verdicts/abc']) {
      const res = await request(app).get(`/api/pythia${path}`);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'redis_unavailable' });
    }
  });

  it('exposes no Redis write commands to the router', async () => {
    // The mock client has no set/hset/xadd/del. If a handler ever reaches for
    // one, it throws and the endpoint 503s instead of silently mutating the
    // sidecar's cache — so this asserts the surface stays read-only.
    const app = await loadApp();
    await request(app).get('/api/pythia/predictions').expect(200);
    await request(app).get('/api/pythia/events').expect(200);
    await request(app).get('/api/pythia/bounties').expect(200);
  });

  it('rejects an unknown horizon and an unknown domain', async () => {
    const app = await loadApp();

    const horizon = await request(app)
      .get('/api/pythia/predictions?horizon=decade')
      .expect(400);
    expect(horizon.body.error).toBe('invalid_horizon');

    const domain = await request(app).get('/api/pythia/events?domain=politics').expect(400);
    expect(domain.body.error).toBe('invalid_domain');
  });

  it('aliases 1w to the week key', async () => {
    mockGet.mockResolvedValue(JSON.stringify({ predictions: [{ x: 1 }], cached_at: 5 }));

    const app = await loadApp();
    const res = await request(app).get('/api/pythia/predictions?horizon=1w').expect(200);

    expect(mockGet).toHaveBeenCalledWith('pythia:predictions:week');
    expect(res.body.horizon).toBe('week');
    expect(res.body.stale).toBe(false);
  });

  it('404s a verdict that is not cached', async () => {
    mockGet.mockResolvedValue(null);

    const app = await loadApp();
    const res = await request(app).get('/api/pythia/verdicts/req-1').expect(404);

    expect(res.body).toEqual({ error: 'verdict_not_found', request_id: 'req-1' });
  });
});
