/**
 * Public station history read (skill-pay backtest, DECISIONS 2026-11-12 item 3):
 * GET /api/public/station-history/:alias?fromHeight=..&toHeight=..&after=..&offset=..&limit=..
 * Default OFF, alias only, bounded ~30-day height window, cursor paging, 0.1-degree coordinates,
 * node reads with the server Reader credential under a process-wide budget, 30/min per IP.
 * All data here is synthetic (an ocean location, an invented station id).
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  createPublicStationHistoryRouter,
  HISTORY_MAX_UPSTREAM_PAGES,
  HISTORY_MAX_WINDOW_HEIGHTS,
  type Core4Fetch,
  type DbQuery,
} from '../server/routes/public-station-history-routes';
import { stationAlias } from '../server/utils/station-alias.js';

const STATION = 'synthetic-history-station-0001';
const ALIAS = stationAlias(STATION) as string;
const READER = 'reader-token-for-station-history-test';
// Synthetic fine position in the open Pacific: must come out at 0.1 degree.
const FINE_LAT = 10.04567;
const FINE_LON = -140.06789;

type Call = { path: string; options: any };

/** A fake chain: one reveal for the station in every block, core4's 64-height scan cap. */
function fakeChain(tip: number, opts: { quorumEvery?: number } = {}) {
  const calls: Call[] = [];
  const fetch: Core4Fetch = async (path, options: any = {}) => {
    calls.push({ path, options });
    const after = Number(options.query?.after ?? 0);
    const offset = Number(options.query?.offset ?? 0);
    const limit = Math.min(100, Math.max(1, Number(options.query?.limit ?? 50)));
    const items: any[] = [];
    let a = after;
    let o = offset;
    let heights = 0;
    while (a < tip && items.length < limit && heights < 64) {
      const h = a + 1;
      heights += 1;
      // One station reveal at tx index 0 and one other tx at index 1 in each block.
      while (o < 2 && items.length < limit) {
        if (o === 0) {
          items.push({
            commit_id: 'ab'.repeat(32), station_id: STATION, height: h, observed_at: 1_760_000_000 + h * 77,
            values: { temperature_c: 10 + (h % 7) / 10, humidity_percent: 80, pressure_hpa: 1000.5,
              wind_speed_ms: 3, precipitation_mm: 0, dewpoint_c: 6.5, secret_extra: STATION },
            provenance_class: 'real',
            attestation: { approvals: 2, has_quorum: opts.quorumEvery ? h % opts.quorumEvery === 0 : true, owner: 'x' },
            owner_email: 'nobody@example.invalid',
          });
        }
        o += 1;
      }
      if (o === 2) { a = h; o = 0; }
    }
    return { ok: true, status: 200, payload: { ok: true, data: {
      items, limit, next_after: a, next_offset: o, has_more: a < tip, chain_height: tip, state_tip: 'cd'.repeat(32), scanned_transactions: 0,
    } } };
  };
  return { fetch, calls };
}

const query: DbQuery = async (sql, params) => {
  if (sql.includes('sha256')) return params[0] === ALIAS ? [{ station_id: STATION }] : [];
  if (sql.includes('latitude')) return params[0] === STATION ? [{ latitude: FINE_LAT, longitude: FINE_LON }] : [];
  return [];
};

const passThrough = (_req: any, _res: any, next: any) => next();

function app(fetch: Core4Fetch, extra: Record<string, unknown> = {}) {
  const a = express();
  a.use('/api/public/station-history', createPublicStationHistoryRouter({
    fetchCore4Json: fetch, readerToken: () => READER, query, rateLimit: passThrough, ...extra,
  }));
  return a;
}

describe('GET /api/public/station-history/:alias', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.PUBLIC_STATION_HISTORY_READ_ENABLED = 'true';
    delete process.env.PUBLIC_STATION_HISTORY_UPSTREAM_MAX_PER_MIN;
  });
  afterAll(() => { process.env = saved; });

  it('is 404 while the flag is off, and asks nothing', async () => {
    delete process.env.PUBLIC_STATION_HISTORY_READ_ENABLED;
    const chain = fakeChain(100);
    const res = await request(app(chain.fetch)).get(`/api/public/station-history/${ALIAS}?fromHeight=1`);
    expect(res.status).toBe(404);
    expect(chain.calls).toHaveLength(0);
  });

  it('answers a window with 0.1-degree coordinates, allowlisted fields and the server credential only', async () => {
    const chain = fakeChain(100);
    const res = await request(app(chain.fetch))
      .get(`/api/public/station-history/${ALIAS}?fromHeight=10&toHeight=20`)
      .set('authorization', 'Bearer caller-token-must-not-be-forwarded');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.station).toEqual({ alias: ALIAS, latitude: 10, longitude: -140.1 });
    expect(res.body.window).toEqual({ fromHeight: 10, toHeight: 20 });
    expect(res.body.observations.map((o: any) => o.height)).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);
    expect(res.body.observations[0]).toEqual({
      height: 10, observedAt: 1_760_000_770, temperatureC: 10.3, humidityPct: 80, pressureHpa: 1000.5,
      windSpeedMs: 3, precipitationMm: 0, dewpointC: 6.5, provenanceClass: 'real', attestation: { approvals: 2, hasQuorum: true },
    });
    expect(res.body.next).toBeNull();
    expect(res.body.chainHeight).toBe(100);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(STATION);
    expect(text).not.toContain('04567');
    expect(text).not.toContain('06789');
    expect(text).not.toContain('example.invalid');
    expect(text).not.toContain('commit');
    // The scan starts just below the window, with the server's Reader bearer and nothing from the caller.
    expect(chain.calls[0].path).toBe(`/transactions/contributions/${encodeURIComponent(STATION)}/observations`);
    expect(chain.calls[0].options.query).toMatchObject({ after: 9, offset: 0 });
    expect(chain.calls[0].options.headers).toEqual({ authorization: `Bearer ${READER}`, accept: 'application/json' });
  });

  it('pages with a cursor, mid-block included, and every reading comes back exactly once', async () => {
    const chain = fakeChain(2_000);
    const a = app(chain.fetch);
    const seen: number[] = [];
    let next: any = { after: undefined, offset: undefined };
    let rounds = 0;
    while (next && rounds < 50) {
      rounds += 1;
      const cursor = next.after === undefined ? '' : `&after=${next.after}&offset=${next.offset}`;
      const res = await request(a).get(`/api/public/station-history/${ALIAS}?fromHeight=100&toHeight=1099&limit=37${cursor}`);
      expect(res.status).toBe(200);
      expect(res.body.observations.length).toBeLessThanOrEqual(37);
      seen.push(...res.body.observations.map((o: any) => o.height));
      next = res.body.next;
    }
    expect(next).toBeNull();
    expect(seen).toEqual(Array.from({ length: 1000 }, (_, i) => 100 + i));
  });

  it('makes at most the page cap of node reads per request and hands back a cursor', async () => {
    const chain = fakeChain(30_000);
    // Sparse station: no readings at all, so the scan is limited by node reads, not by limit.
    const sparse: Core4Fetch = async (path, options: any) => {
      const r = await chain.fetch(path, options);
      r.payload.data.items = [];
      return r;
    };
    const res = await request(app(sparse)).get(`/api/public/station-history/${ALIAS}?fromHeight=1&toHeight=20000`);
    expect(res.status).toBe(200);
    expect(chain.calls).toHaveLength(HISTORY_MAX_UPSTREAM_PAGES);
    expect(res.body.observations).toEqual([]);
    expect(res.body.next).toEqual({ after: 64 * HISTORY_MAX_UPSTREAM_PAGES, offset: 0 });
  });

  it('stops at the chain tip with next = null and chainHeight below toHeight', async () => {
    const chain = fakeChain(50);
    const res = await request(app(chain.fetch)).get(`/api/public/station-history/${ALIAS}?fromHeight=40`);
    expect(res.status).toBe(200);
    expect(res.body.observations.map((o: any) => o.height)).toEqual([40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50]);
    expect(res.body.window).toEqual({ fromHeight: 40, toHeight: 40 + HISTORY_MAX_WINDOW_HEIGHTS - 1 });
    expect(res.body.next).toBeNull();
    expect(res.body.chainHeight).toBe(50);
  });

  it('keeps the quorum verdict per reading', async () => {
    const chain = fakeChain(100, { quorumEvery: 2 });
    const res = await request(app(chain.fetch)).get(`/api/public/station-history/${ALIAS}?fromHeight=1&toHeight=4`);
    expect(res.body.observations.map((o: any) => o.attestation.hasQuorum)).toEqual([false, true, false, true]);
  });

  it.each([
    ['', 'fromHeight is required'],
    ['?fromHeight=0', 'positive'],
    ['?fromHeight=abc', 'positive'],
    ['?fromHeight=10&toHeight=9', 'below'],
    [`?fromHeight=1&toHeight=${HISTORY_MAX_WINDOW_HEIGHTS + 1}`, 'at most'],
    ['?fromHeight=10&toHeight=20&after=20', 'inside the window'],
    ['?fromHeight=10&toHeight=20&after=5', 'inside the window'],
    ['?fromHeight=10&offset=1', 'offset needs after'],
    ['?fromHeight=10&limit=0', 'limit'],
    ['?fromHeight=10&limit=501', 'limit'],
    ['?fromHeight=10&stationId=x', 'Unknown query'],
    ['?fromHeight=10&fromHeight=11', 'positive'],
    ['?fromHeight=-1', 'positive'],
  ])('rejects %s with 400 and asks nothing', async (qs, message) => {
    const chain = fakeChain(100);
    const res = await request(app(chain.fetch)).get(`/api/public/station-history/${ALIAS}${qs}`);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toContain(message);
    expect(chain.calls).toHaveLength(0);
  });

  it('allows exactly the longest window', async () => {
    const chain = fakeChain(10);
    const res = await request(app(chain.fetch)).get(`/api/public/station-history/${ALIAS}?fromHeight=1&toHeight=${HISTORY_MAX_WINDOW_HEIGHTS}`);
    expect(res.status).toBe(200);
  });

  it('is 404 for a raw station id or an unknown alias, even with a bearer', async () => {
    const chain = fakeChain(100);
    for (const id of [STATION, 'st_000000000000', 'ST_ABCDEFABCDEF']) {
      const res = await request(app(chain.fetch)).get(`/api/public/station-history/${encodeURIComponent(id)}?fromHeight=1`)
        .set('authorization', `Bearer ${READER}`);
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain(STATION);
    }
    expect(chain.calls).toHaveLength(0);
  });

  it('a station with no stored position answers null coordinates, never a guess', async () => {
    const chain = fakeChain(10);
    const noPos: DbQuery = async (sql, params) => (sql.includes('latitude') ? [{ latitude: null, longitude: '' }] : query(sql, params));
    const res = await request(app(chain.fetch, { query: noPos })).get(`/api/public/station-history/${ALIAS}?fromHeight=1&toHeight=2`);
    expect(res.body.station).toEqual({ alias: ALIAS, latitude: null, longitude: null });
  });

  it('is 503 without a Reader credential and 503 when the station lookup fails', async () => {
    const chain = fakeChain(10);
    const r1 = await request(app(chain.fetch, { readerToken: () => undefined })).get(`/api/public/station-history/${ALIAS}?fromHeight=1`);
    expect(r1.status).toBe(503);
    expect(r1.body.error.code).toBe('CORE4_READER_CREDENTIAL_UNCONFIGURED');
    const broken: DbQuery = async () => { throw new Error(`db down for ${STATION}`); };
    const r2 = await request(app(chain.fetch, { query: broken })).get(`/api/public/station-history/${ALIAS}?fromHeight=1`);
    expect(r2.status).toBe(503);
    expect(r2.body.error.code).toBe('STATION_LOOKUP_UNAVAILABLE');
    expect(JSON.stringify(r2.body)).not.toContain(STATION);
    expect(chain.calls).toHaveLength(0);
  });

  it('never relays upstream text: refused is 502, timeout is 504, a cursor error is 400', async () => {
    const leaky: Core4Fetch = async () => ({ ok: false, status: 500, payload: { error: { code: 'X', message: `boom ${STATION}` } } });
    const r1 = await request(app(leaky)).get(`/api/public/station-history/${ALIAS}?fromHeight=1`);
    expect(r1.status).toBe(502);
    expect(JSON.stringify(r1.body)).not.toContain(STATION);
    const timeout: Core4Fetch = async () => { const e = new Error('t'); e.name = 'AbortError'; throw e; };
    const r2 = await request(app(timeout)).get(`/api/public/station-history/${ALIAS}?fromHeight=1`);
    expect(r2.status).toBe(504);
    const badCursor: Core4Fetch = async () => ({ ok: false, status: 400, payload: { ok: false, error: { code: 'INVALID_CURSOR', message: STATION } } });
    const r3 = await request(app(badCursor)).get(`/api/public/station-history/${ALIAS}?fromHeight=1&after=5&offset=9`);
    expect(r3.status).toBe(400);
    expect(r3.body.error.code).toBe('INVALID_CURSOR');
    expect(JSON.stringify(r3.body)).not.toContain(STATION);
    const drift: Core4Fetch = async () => ({ ok: true, status: 200, payload: { ok: true, data: { observations: [] } } });
    const r4 = await request(app(drift)).get(`/api/public/station-history/${ALIAS}?fromHeight=1`);
    expect(r4.status).toBe(502);
  });

  it('a node failure after some pages returns what was read with a cursor to resume', async () => {
    const chain = fakeChain(10_000);
    let n = 0;
    const flaky: Core4Fetch = async (path, options) => {
      n += 1;
      if (n === 3) throw new Error('reset');
      return chain.fetch(path, options);
    };
    const res = await request(app(flaky)).get(`/api/public/station-history/${ALIAS}?fromHeight=1&limit=500`);
    expect(res.status).toBe(200);
    expect(res.body.observations).toHaveLength(128);
    expect(res.body.next).toEqual({ after: 128, offset: 0 });
  });

  it('caps node reads process-wide per minute: partial page, then 503 with Retry-After', async () => {
    process.env.PUBLIC_STATION_HISTORY_UPSTREAM_MAX_PER_MIN = '10';
    let clock = 1_000_000;
    const chain = fakeChain(100_000);
    const a = app(chain.fetch, { now: () => clock });
    const r1 = await request(a).get(`/api/public/station-history/${ALIAS}?fromHeight=1&limit=500`);
    expect(r1.status).toBe(200);
    expect(chain.calls).toHaveLength(HISTORY_MAX_UPSTREAM_PAGES);
    const r2 = await request(a).get(`/api/public/station-history/${ALIAS}?fromHeight=1&limit=500`);
    expect(r2.status).toBe(200);
    expect(r2.body.observations).toHaveLength(128); // 2 reads left in the minute
    expect(r2.body.next).toEqual({ after: 128, offset: 0 });
    const r3 = await request(a).get(`/api/public/station-history/${ALIAS}?fromHeight=1`);
    expect(r3.status).toBe(503);
    expect(r3.body.error.code).toBe('UPSTREAM_BUDGET_EXHAUSTED');
    expect(Number(r3.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(chain.calls).toHaveLength(10);
    clock += 60_000;
    const r4 = await request(a).get(`/api/public/station-history/${ALIAS}?fromHeight=1&toHeight=3`);
    expect(r4.status).toBe(200);
  });

  it('applies the per-caller limiter before anything else, and fails closed without one', async () => {
    const chain = fakeChain(10);
    const deny = (_req: any, res: any) => res.status(429).set('Retry-After', '60').json({ error: 'Too many' });
    const r1 = await request(app(chain.fetch, { rateLimit: deny })).get(`/api/public/station-history/${ALIAS}?fromHeight=1`);
    expect(r1.status).toBe(429);
    expect(chain.calls).toHaveLength(0);
  });
});

describe('per-caller limiter (real shared Redis limiter, faked Redis)', () => {
  const saved = { ...process.env };
  afterAll(() => { process.env = saved; });

  it('the 31st request in a minute from one client is 429', async () => {
    jest.resetModules();
    const sets = new Map<string, Array<{ score: number; member: string }>>();
    const redis = {
      status: 'ready', on: jest.fn(), connect: jest.fn(async () => undefined), quit: jest.fn(async () => 'OK'), disconnect: jest.fn(),
      ttl: jest.fn(async () => -2), exists: jest.fn(async () => 0), incr: jest.fn(async () => 1), expire: jest.fn(async () => 1),
      setex: jest.fn(async () => 'OK'), del: jest.fn(async () => 1),
      pipeline: () => {
        const ops: Array<() => unknown> = [];
        const p: any = {
          zremrangebyscore: (k: string, min: number, max: number) => { ops.push(() => { sets.set(k, (sets.get(k) || []).filter((e) => e.score < min || e.score > max)); return 0; }); return p; },
          zadd: (k: string, score: number, member: string) => { ops.push(() => { sets.set(k, [...(sets.get(k) || []), { score, member }]); return 1; }); return p; },
          zcard: (k: string) => { ops.push(() => (sets.get(k) || []).length); return p; },
          expire: () => { ops.push(() => 1); return p; },
          exec: async () => ops.map((op) => [null, op()]),
        };
        return p;
      },
    };
    jest.doMock('ioredis', () => jest.fn().mockImplementation(() => redis));
    Object.assign(process.env, { PUBLIC_STATION_HISTORY_READ_ENABLED: 'true', DISABLE_FILE_LOG_TRANSPORTS: 'true', REDIS_URL: 'redis://127.0.0.1:1' });
    const mod = await import('../server/routes/public-station-history-routes');
    const chain = fakeChain(10);
    const a = express();
    a.use('/api/public/station-history', mod.createPublicStationHistoryRouter({ fetchCore4Json: chain.fetch, readerToken: () => READER, query }));
    const statuses: number[] = [];
    for (let i = 0; i < 31; i += 1) {
      statuses.push((await request(a).get(`/api/public/station-history/${ALIAS}?fromHeight=1&toHeight=2`)).status);
    }
    expect(statuses.slice(0, 30).every((s) => s === 200)).toBe(true);
    expect(statuses[30]).toBe(429);
  });
});
