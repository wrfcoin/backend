/**
 * backend#1280: an uncursored observations read must serve the chain TAIL.
 *
 * core4's get_station_observations scans ascending from `after` (default 0),
 * at most 64 heights per call, and the public edge admits only `limit=1`, so
 * the route used to return the genesis window. Live evidence (2026-09-27):
 * source=core4, order=ascending-height, cursor.nextAfter=64, chainHeight=25382.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';
import { createStationDetailRouter } from '../../server/routes/station-detail-routes.js';
import { fakeCore4Chain } from '../fixtures/fake-core4-chain.js';

function app(fetchCore4Json: any, opts: { anonymous?: boolean; token?: string | null; db?: any } = {}) {
  const db = opts.db ?? {
    execute: jest.fn(async (sql: string) => {
      // Alias resolution for anonymous callers: one registered station.
      if (/weather_stations/.test(sql)) return { rows: [{ station_id: 'alice-backyard-ws' }] };
      return { rows: [] };
    }),
  };
  const a = express();
  a.use('/api', createStationDetailRouter({
    db,
    fetchCore4Json,
    readerToken: () => (opts.token === undefined ? 'reader-token' : opts.token ?? undefined),
    isAuthenticated: () => !opts.anonymous,
  } as any));
  return { app: a, db };
}

const NOW_S = 1_790_000_000;

describe('uncursored observations read serves the chain tail (backend#1280)', () => {
  it('returns the newest reveal, not the genesis window', async () => {
    const fetchCore4Json = fakeCore4Chain(25382, [
      { station: 'station-a', height: 3, observedAt: NOW_S - 5_000_000, temperature: 1 },
      { station: 'station-a', height: 25370, observedAt: NOW_S - 600, temperature: 2 },
      { station: 'station-a', height: 25380, observedAt: NOW_S - 60, temperature: 3 },
    ]);
    const res = await request(app(fetchCore4Json).app).get('/api/stations/station-a/observations?limit=1');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('core4');
    expect(res.body.observations).toHaveLength(1);
    expect(res.body.observations[0]).toMatchObject({ height: 25380, temperatureC: 3 });
    expect(res.body.order).toBe('descending-height');
    expect(res.body.cursor.chainHeight).toBe(25382);
  });

  it('walks back past empty tail windows, within the call cap', async () => {
    const fetchCore4Json = fakeCore4Chain(25382, [
      { station: 'station-a', height: 25382 - 64 * 2 - 10, observedAt: NOW_S - 9000, temperature: 7 },
    ]);
    const res = await request(app(fetchCore4Json).app).get('/api/stations/station-a/observations?limit=1');
    expect(res.body.observations[0]).toMatchObject({ height: 25382 - 138, temperatureC: 7 });
    expect(fetchCore4Json.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('stops at the walk-back cap and answers an empty core4 window, not the genesis one', async () => {
    const fetchCore4Json = fakeCore4Chain(25382, [
      { station: 'station-a', height: 3, observedAt: NOW_S - 5_000_000 },
    ]);
    const res = await request(app(fetchCore4Json).app).get('/api/stations/station-a/observations?limit=1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'core4', observations: [] });
    expect(fetchCore4Json.mock.calls.length).toBeLessThanOrEqual(7);
    // Only the cold height probe (limit 1) starts low; every window read is
    // inside the four tail windows, never the genesis window.
    const [probe, ...windows] = fetchCore4Json.mock.calls as any[];
    expect(probe[1].query).toMatchObject({ limit: 1 });
    expect(windows.length).toBeGreaterThan(0);
    for (const [, options] of windows) {
      expect(options.query.after).toBeGreaterThanOrEqual(25382 - 64 * 4);
    }
  });

  it('follows core4 continuation pages when the 1000-transaction scan cap truncates a window', async () => {
    // 30 other transactions per block: a 64-block window needs two core4 pages.
    const fetchCore4Json = fakeCore4Chain(25382, [
      { station: 'station-a', height: 25381, observedAt: NOW_S - 30, temperature: 9 },
    ], 30);
    const res = await request(app(fetchCore4Json).app).get('/api/stations/station-a/observations?limit=1');
    expect(res.body.observations[0]).toMatchObject({ height: 25381, temperatureC: 9 });
    expect(res.body.tail).toMatchObject({ complete: true, toHeight: 25382 });
    expect(fetchCore4Json.mock.calls.length).toBeLessThanOrEqual(7);
  });

  it('coalesces concurrent reads and caches the answer', async () => {
    const fetchCore4Json = fakeCore4Chain(500, [{ station: 'station-a', height: 499, observedAt: NOW_S }]);
    const { app: a } = app(fetchCore4Json);
    await Promise.all([1, 2, 3, 4].map(() => request(a).get('/api/stations/station-a/observations?limit=1')));
    const first = fetchCore4Json.mock.calls.length;
    await request(a).get('/api/stations/station-a/observations?limit=1');
    expect(fetchCore4Json.mock.calls.length).toBe(first);
    expect(first).toBeLessThanOrEqual(2);
  });

  it('keeps explicit cursors ascending for authenticated history paging', async () => {
    const fetchCore4Json = fakeCore4Chain(200, [
      { station: 'station-a', height: 5, observedAt: NOW_S - 100 },
      { station: 'station-a', height: 150, observedAt: NOW_S },
    ]);
    const res = await request(app(fetchCore4Json).app).get('/api/stations/station-a/observations?after=0&offset=0');
    expect(res.body.order).toBe('ascending-height');
    expect(res.body.observations[0].height).toBe(5);
  });

  it('degrades to the database path when core4 is down, without throwing', async () => {
    const fetchCore4Json = jest.fn(async () => { throw new Error('ECONNREFUSED'); });
    const db = { execute: jest.fn(async () => ({ rows: [] })) };
    const res = await request(app(fetchCore4Json, { db }).app).get('/api/stations/station-a/observations?limit=1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'backend-db', core4Unavailable: 'CORE4_UNREACHABLE', observations: [] });
  });

  it('never puts the raw station id in an anonymous tail answer', async () => {
    const rawId = 'alice-backyard-ws';
    const fetchCore4Json = fakeCore4Chain(1000, [{ station: rawId, height: 990, observedAt: NOW_S }]);
    const { stationAlias } = await import('../../server/utils/station-alias.js');
    const alias = stationAlias(rawId);
    const res = await request(app(fetchCore4Json, { anonymous: true }).app)
      .get(`/api/stations/${alias}/observations?limit=1`);
    expect(res.status).toBe(200);
    expect(res.body.observations[0]).toMatchObject({ height: 990 });
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain(rawId);
  });
});
