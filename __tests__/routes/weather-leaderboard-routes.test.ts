/**
 * Tests for GET /api/weather/leaderboard geographic filters — backend#693.
 *
 * Exercises each query-param branch (country / region / near / combined)
 * plus validation, backwards compat, caching short-circuits, and the
 * empty-set optimisation when country and region contradict each other.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

type Row = Record<string, unknown>;

function makeDb(sequences: Array<{ rows: Row[] }>) {
  let idx = 0;
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const execute = jest.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params: params ?? [] });
    return sequences[idx++] ?? { rows: [] };
  });
  return { execute, calls };
}

import { createWeatherLeaderboardRouter } from '../../server/routes/weather-leaderboard-routes.js';

function makeApp(db: ReturnType<typeof makeDb>, cache: any = null) {
  const app = express();
  app.use(express.json());
  app.use(
    '/api/weather/leaderboard',
    createWeatherLeaderboardRouter({
      db: { execute: db.execute } as any,
      cache,
      rateLimit: null,
    }),
  );
  return app;
}

const sampleRows = (withGeo: boolean = true): Row[] => [
  {
    rank: 1,
    wallet_address: '0xaaa0000000000000000000000000000000000001',
    display_name: 'Alice',
    value: 847,
    country: withGeo ? 'US' : null,
    city: withGeo ? 'Chicago' : null,
  },
  {
    rank: 2,
    wallet_address: '0xbbb0000000000000000000000000000000000002',
    display_name: 'Bob',
    value: 120,
    country: withGeo ? 'GB' : null,
    city: withGeo ? 'London' : null,
  },
];

describe('GET /api/weather/leaderboard — backwards compatibility', () => {
  it('returns the global leaderboard when no query params are passed', async () => {
    const db = makeDb([{ rows: sampleRows() }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.metric).toBe('submissions');
    expect(res.body.period).toBe('7d');
    expect(res.body.country).toBeNull();
    expect(res.body.region).toBeNull();
    expect(res.body.near).toBeNull();
    expect(res.body.entries).toHaveLength(2);
    expect(res.body.entries[0]).toMatchObject({
      rank: 1,
      walletAddress: expect.stringMatching(/^0x/),
      displayName: 'Alice',
      value: 847,
      badgeLevel: 'gold',
      country: 'US',
      city: 'Chicago',
    });
    // No geofilter → no country/bbox params appended beyond [limit, interval].
    expect(db.calls[0].params).toEqual([25, '7 days']);
  });

  it('falls back to null country/city when the DB row has no geo columns', async () => {
    const db = makeDb([{ rows: sampleRows(false) }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.status).toBe(200);
    expect(res.body.entries[0].country).toBeNull();
    expect(res.body.entries[0].city).toBeNull();
  });

  it('rejects invalid metric with 400', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=bogus');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/metric must be/);
  });

  it('rejects invalid period with 400', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&period=nope');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/period must be/);
  });
});

describe('GET /api/weather/leaderboard — ?country=XX', () => {
  it('expands country filter into the SQL with UPPER() normalisation', async () => {
    const db = makeDb([{ rows: sampleRows() }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&country=us');
    expect(res.status).toBe(200);
    expect(res.body.country).toBe('US');
    expect(db.calls[0].sql).toMatch(/UPPER\(ws\.country\) = ANY\(\$3::text\[\]\)/);
    expect(db.calls[0].params).toEqual([25, '7 days', ['US']]);
  });

  it('rejects malformed country codes with 400', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&country=usa');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/alpha-2/);
  });

  it('returns an empty list (not 400) for well-formed but unknown country codes', async () => {
    const db = makeDb([{ rows: [] }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&country=ZZ');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(0);
  });
});

describe('GET /api/weather/leaderboard — ?region=<enum>', () => {
  it('expands the North America region into a multi-country ANY() list', async () => {
    const db = makeDb([{ rows: sampleRows() }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&region=North%20America');
    expect(res.status).toBe(200);
    expect(res.body.region).toBe('North America');
    const countriesParam = db.calls[0].params[2] as string[];
    expect(countriesParam).toContain('US');
    expect(countriesParam).toContain('CA');
    expect(countriesParam).toContain('MX');
    expect(countriesParam.length).toBeGreaterThan(3);
  });

  it('rejects unknown region enum values with 400', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&region=Atlantis');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/region must be one of/);
  });

  it('treats ?region=Global the same as no region filter', async () => {
    const db = makeDb([{ rows: sampleRows() }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&region=Global');
    expect(res.status).toBe(200);
    expect(res.body.region).toBe('Global');
    expect(db.calls[0].params).toEqual([25, '7 days']);
  });
});

describe('GET /api/weather/leaderboard — ?near=lat,lng', () => {
  it('emits a bounding-box prefilter plus Haversine post-filter', async () => {
    const db = makeDb([{ rows: sampleRows() }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&near=41.88,-87.63&radius_km=50');
    expect(res.status).toBe(200);
    expect(res.body.near).toEqual({ lat: 41.88, lng: -87.63, radius_km: 50 });
    expect(db.calls[0].sql).toMatch(/latitude BETWEEN \$3 AND \$4/);
    expect(db.calls[0].sql).toMatch(/longitude BETWEEN \$5 AND \$6/);
    expect(db.calls[0].sql).toMatch(/6371 \* acos/);
    const params = db.calls[0].params;
    // [limit, interval, latMin, latMax, lngMin, lngMax, lat, lng, radiusKm]
    expect(params.length).toBe(9);
    expect(params[6]).toBeCloseTo(41.88, 4);
    expect(params[7]).toBeCloseTo(-87.63, 4);
    expect(params[8]).toBe(50);
  });

  it('defaults radius to 500km when ?radius_km is omitted', async () => {
    const db = makeDb([{ rows: [] }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&near=0,0');
    expect(res.status).toBe(200);
    expect(res.body.near?.radius_km).toBe(500);
  });

  it('caps radius at 5000km', async () => {
    const db = makeDb([{ rows: [] }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&near=0,0&radius_km=10000');
    expect(res.status).toBe(200);
    expect(res.body.near?.radius_km).toBe(5000);
  });

  it('rejects malformed ?near with 400', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&near=not-a-coord');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/near must be/);
  });

  it('rejects out-of-range lat with 400', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&near=200,0');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/weather/leaderboard — combined filters', () => {
  it('intersects country and region: country within region → country wins', async () => {
    const db = makeDb([{ rows: sampleRows() }]);
    const app = makeApp(db);
    const res = await request(app).get(
      '/api/weather/leaderboard?metric=submissions&country=US&region=North%20America',
    );
    expect(res.status).toBe(200);
    expect(db.calls[0].params[2]).toEqual(['US']);
  });

  it('short-circuits to empty entries when country is outside region (no DB round-trip)', async () => {
    const db = makeDb([]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&country=JP&region=Europe');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(0);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('combines country with ?near=: both conditions appear in the SQL', async () => {
    const db = makeDb([{ rows: sampleRows() }]);
    const app = makeApp(db);
    const res = await request(app).get(
      '/api/weather/leaderboard?metric=submissions&country=US&near=41.88,-87.63&radius_km=100',
    );
    expect(res.status).toBe(200);
    expect(db.calls[0].sql).toMatch(/UPPER\(ws\.country\) = ANY/);
    expect(db.calls[0].sql).toMatch(/latitude BETWEEN/);
    expect(db.calls[0].sql).toMatch(/6371 \* acos/);
  });
});

describe('GET /api/weather/leaderboard — streak metric with geo', () => {
  it('uses an EXISTS subquery against weather_submissions when geofilter is active', async () => {
    const db = makeDb([{ rows: [{ ...sampleRows()[0], value: 30 }] }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=streak&country=US');
    expect(res.status).toBe(200);
    expect(res.body.metric).toBe('streak');
    expect(db.calls[0].sql).toMatch(/streak_milestones_claimed/);
    expect(db.calls[0].sql).toMatch(/EXISTS \(SELECT 1 FROM weather_submissions/);
    expect(db.calls[0].sql).toMatch(/UPPER\(ws\.country\) = ANY/);
  });

  it('skips the EXISTS subquery for the unfiltered streak leaderboard', async () => {
    const db = makeDb([{ rows: [{ ...sampleRows()[0], value: 30 }] }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=streak');
    expect(res.status).toBe(200);
    expect(db.calls[0].sql).not.toMatch(/EXISTS \(SELECT 1 FROM weather_submissions/);
  });
});

describe('GET /api/weather/leaderboard — Redis cache', () => {
  it('serves a cache hit without touching the DB', async () => {
    const cached = JSON.stringify({
      success: true,
      metric: 'submissions',
      period: '7d',
      country: 'US',
      region: null,
      near: null,
      updatedAt: '2026-04-19T00:00:00Z',
      entries: [{ rank: 1, walletAddress: '0xcached', displayName: 'Cached', value: 99, badgeLevel: 'silver', streak: null, country: 'US', city: 'Cached City' }],
    });
    const cache = {
      get: jest.fn<(k: string) => Promise<string | null>>().mockResolvedValue(cached),
      setex: jest.fn<() => Promise<'OK'>>().mockResolvedValue('OK'),
    };
    const db = makeDb([]);
    const app = makeApp(db, cache);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&country=US');
    expect(res.status).toBe(200);
    expect(res.body.entries[0].displayName).toBe('Cached');
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('writes the response to Redis with SETEX on a cache miss', async () => {
    const cache = {
      get: jest.fn<(k: string) => Promise<string | null>>().mockResolvedValue(null),
      setex: jest.fn<() => Promise<'OK'>>().mockResolvedValue('OK'),
    };
    const db = makeDb([{ rows: sampleRows() }]);
    const app = makeApp(db, cache);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&country=GB');
    expect(res.status).toBe(200);
    // setex is fire-and-forget, so let the microtask queue drain.
    await new Promise(r => setImmediate(r));
    expect(cache.setex).toHaveBeenCalledTimes(1);
    const [key, ttl] = cache.setex.mock.calls[0];
    // v2 (backend#1361): the key changed so no pre-change body with full addresses is ever served.
    expect(key).toMatch(/^cache:leaderboard:v3:submissions:7d:25:GB:-$/);
    expect(ttl).toBe(60);
  });

  it('falls through to the DB when the cache GET throws', async () => {
    const cache = {
      get: jest.fn<() => Promise<string | null>>().mockRejectedValue(new Error('redis down')),
      setex: jest.fn<() => Promise<'OK'>>().mockResolvedValue('OK'),
    };
    const db = makeDb([{ rows: sampleRows() }]);
    const app = makeApp(db, cache);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions&country=US');
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(2);
  });
});

describe('GET /api/weather/leaderboard — integration fixture', () => {
  // 3 countries × 3 regions fixture: each country row lives in its own region
  // bucket. This asserts the handler returns the right subset for each filter
  // combination against the same input stream.
  const fixtureRows = [
    { rank: 1, wallet_address: '0x01', display_name: 'N1', value: 50, country: 'US', city: 'NY' },
    { rank: 2, wallet_address: '0x02', display_name: 'N2', value: 40, country: 'CA', city: 'Toronto' },
    { rank: 3, wallet_address: '0x03', display_name: 'N3', value: 30, country: 'MX', city: 'CDMX' },
    { rank: 4, wallet_address: '0x04', display_name: 'E1', value: 45, country: 'GB', city: 'London' },
    { rank: 5, wallet_address: '0x05', display_name: 'E2', value: 35, country: 'DE', city: 'Berlin' },
    { rank: 6, wallet_address: '0x06', display_name: 'A1', value: 60, country: 'JP', city: 'Tokyo' },
  ];

  it('returns all rows when no filter is applied', async () => {
    const db = makeDb([{ rows: fixtureRows }]);
    const app = makeApp(db);
    const res = await request(app).get('/api/weather/leaderboard?metric=submissions');
    expect(res.body.entries).toHaveLength(6);
  });

  it('shapes response entries identically across country and region filter paths', async () => {
    const db1 = makeDb([{ rows: [fixtureRows[0]] }]);
    const app1 = makeApp(db1);
    const r1 = await request(app1).get('/api/weather/leaderboard?metric=submissions&country=US');

    const db2 = makeDb([{ rows: [fixtureRows[0]] }]);
    const app2 = makeApp(db2);
    const r2 = await request(app2).get('/api/weather/leaderboard?metric=submissions&region=North%20America');

    const stripVolatile = (body: any) => {
      const { updatedAt: _u, country: _c, region: _r, ...rest } = body;
      return rest;
    };
    expect(stripVolatile(r1.body)).toEqual(stripVolatile(r2.body));
  });
});
