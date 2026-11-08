/**
 * Epic 8: "How does my station compare?" (GET /api/stations/:alias/compare).
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';
import { createStationDetailRouter } from '../../server/routes/station-detail-routes.js';
import {
  agreement,
  cell,
  createStationComparer,
  distanceKm,
  median,
  nwsSourceFrom,
  type NwsSource,
  type RegisteredStation,
} from '../../server/services/station-compare.js';
import { stationAlias } from '../../server/utils/station-alias.js';

const NOW_S = 1_790_000_000;
const now = () => NOW_S * 1000;

type Reading = { observedAt: number; t?: number | null; h?: number | null; d?: number | null };

function tail(readings: Record<string, Reading | 'down' | undefined>) {
  return {
    latest: jest.fn(async (id: string) => {
      const r = readings[id];
      if (r === 'down') return { kind: 'unavailable' as const, reason: 'CORE4_UNREACHABLE' };
      if (!r) return { kind: 'ok' as const, items: [], chainHeight: 100, fromHeight: 0, toHeight: 100, complete: true };
      return {
        kind: 'ok' as const,
        items: [{ observed_at: r.observedAt, values: { temperature_c: r.t ?? null, humidity_percent: r.h ?? null, dewpoint_c: r.d ?? null, pressure_hpa: 1000 } }],
        chainHeight: 100, fromHeight: 36, toHeight: 100, complete: true,
      };
    }),
    lastSeenMs: async () => null,
  };
}

// Exact coordinates as stored; the comparer must only ever use them rounded to 0.1 degree.
const STATIONS: RegisteredStation[] = [
  { stationId: 'me', latitude: 47.61234, longitude: -122.33456 },
  { stationId: 'near-1', latitude: 47.65432, longitude: -122.30001 },
  { stationId: 'near-2', latitude: 47.5, longitude: -122.2 },
  { stationId: 'near-3', latitude: 47.9, longitude: -122.6 },
  { stationId: 'far', latitude: 45.5, longitude: -122.7 }, // ~235 km away
  { stationId: 'no-coords', latitude: null, longitude: null },
];

const nwsOk = (): NwsSource & { latest: jest.Mock<any> } => ({
  latest: jest.fn(async () => ({ stationIdentifier: 'KBFI', observedAt: NOW_S - 900, values: { temperature_c: 11, humidity_pct: 70, dewpoint_c: 5.5 } })),
});

describe('station compare service', () => {
  it('compares the newest reading with the nearby median and NWS, from 0.1-degree cells only', async () => {
    const chain = tail({
      me: { observedAt: NOW_S - 300, t: 12, h: 60, d: 4.4 },
      'near-1': { observedAt: NOW_S - 400, t: 10, h: 72, d: 5 },
      'near-2': { observedAt: NOW_S - 600, t: 11, h: 68, d: 5.2 },
      'near-3': { observedAt: NOW_S - 9 * 3600 }, // too far apart in time: ignored
      far: { observedAt: NOW_S - 100, t: 30, h: 10, d: -10 },
    });
    const nws = nwsOk();
    const comparer = createStationComparer({ listStations: async () => STATIONS, chainTail: chain as any, nws, now });
    const r = await comparer.compare('me');
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.nearby).toEqual({ stations: 2, radiusKm: 100, reason: null });
    const t = r.variables.find(v => v.variable === 'temperature_c')!;
    expect(t.mine).toBe(12);
    expect(t.nearby).toEqual({ stations: 2, median: 10.5, lowest: 10, highest: 11, difference: 1.5, agreement: 'close' });
    expect(t.nws).toEqual({ value: 11, difference: 1, agreement: 'close' });
    const h = r.variables.find(v => v.variable === 'humidity_pct')!;
    expect(h.nearby?.agreement).toBe('lower');
    expect(h.nws).toEqual({ value: 70, difference: -10, agreement: 'lower' });
    expect(r.nws.stationIdentifier).toBe('KBFI');
    expect(r.notCompared.map(n => n.variable)).toEqual(['pressure_hpa']);
    // The far station is never even read; the NWS lookup gets the 0.1-degree cell, never the stored value.
    expect(chain.latest.mock.calls.map(c => c[0])).not.toContain('far');
    expect(nws.latest).toHaveBeenCalledWith(47.6, -122.3);
  });

  it('never returns another station\'s id, alias or coordinates', async () => {
    const chain = tail({ me: { observedAt: NOW_S - 60, t: 12 }, 'near-1': { observedAt: NOW_S - 60, t: 10 } });
    const comparer = createStationComparer({ listStations: async () => STATIONS, chainTail: chain as any, nws: nwsOk(), now });
    const text = JSON.stringify(await comparer.compare('me'));
    for (const s of STATIONS) {
      expect(text).not.toContain(s.stationId === 'me' ? '"me"' : s.stationId);
      expect(text).not.toContain(stationAlias(s.stationId));
    }
    expect(text).not.toMatch(/47\.6|122\.3|latitude|longitude/);
  });

  it('says so when there is no recent reading', async () => {
    const comparer = createStationComparer({
      listStations: async () => STATIONS,
      chainTail: tail({ me: { observedAt: NOW_S - 7 * 3600, t: 12 } }) as any,
      nws: nwsOk(),
      now,
    });
    expect(await comparer.compare('me')).toMatchObject({ status: 'no_recent_reading' });
  });

  it('gives reasons when there are no neighbours and NWS fails', async () => {
    const lonely = [{ stationId: 'me', latitude: 10.04, longitude: 20.04 }];
    const comparer = createStationComparer({
      listStations: async () => lonely,
      chainTail: tail({ me: { observedAt: NOW_S - 60, t: 25, h: 40 } }) as any,
      nws: { latest: async () => { throw new Error('outside the US'); } },
      now,
    });
    const r = await comparer.compare('me');
    expect(r).toMatchObject({ status: 'ok', nearby: { stations: 0 }, nws: { stationIdentifier: null } });
    if (r.status !== 'ok') return;
    expect(r.nearby.reason).toMatch(/No other registered station/);
    expect(r.nws.reason).toMatch(/US only/);
    expect(r.variables.every(v => v.nearby === null && v.nws === null)).toBe(true);
  });

  it('is unavailable (not cached for long) when the chain cannot be read', async () => {
    let clock = now();
    const chain = tail({ me: 'down' });
    const comparer = createStationComparer({ listStations: async () => STATIONS, chainTail: chain as any, nws: nwsOk(), now: () => clock });
    expect(await comparer.compare('me')).toMatchObject({ status: 'unavailable' });
    clock += 6_000;
    await comparer.compare('me');
    expect(chain.latest).toHaveBeenCalledTimes(2);
  });

  it('caches one answer per station and one NWS read per cell', async () => {
    const chain = tail({ me: { observedAt: NOW_S - 60, t: 12 }, 'near-1': { observedAt: NOW_S - 60, t: 10 } });
    const nws = nwsOk();
    const comparer = createStationComparer({ listStations: async () => STATIONS, chainTail: chain as any, nws, now });
    await Promise.all([comparer.compare('me'), comparer.compare('me'), comparer.compare('me')]);
    await comparer.compare('me'); // cached
    await comparer.compare('near-1'); // its own cell (47.7, -122.3): a second NWS read
    expect(nws.latest).toHaveBeenCalledTimes(2);
    expect(chain.latest.mock.calls.filter(c => c[0] === 'me').length).toBe(2); // once as subject, once as near-1's neighbour
  });
});

describe('helpers', () => {
  it('rounds to 0.1 degree and rejects junk', () => {
    expect(cell(47.61234, 90)).toBe(47.6);
    expect(cell('-122.35', 180)).toBe(-122.3);
    expect(cell(null, 90)).toBeNull();
    expect(cell('x', 90)).toBeNull();
    expect(cell(91, 90)).toBeNull();
  });
  it('measures distance and median', () => {
    expect(distanceKm(47.6, -122.3, 45.5, -122.7)).toBeGreaterThan(200);
    expect(distanceKm(47.6, -122.3, 47.7, -122.3)).toBeCloseTo(11.1, 0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(agreement(-2, 1.5)).toBe('lower');
  });
  it('adapts the NWS client, keeping only known units and a plain station code', async () => {
    const client = {
      getCurrentObservations: jest.fn(async () => ({
        stationId: 'KSEA',
        timestamp: new Date((NOW_S - 600) * 1000).toISOString(),
        temperature: { value: 9.4, unit: 'wmoUnit:degC' },
        relativeHumidity: { value: 81, unit: 'wmoUnit:percent' },
        dewpoint: { value: 47, unit: 'wmoUnit:degF' },
      })),
    };
    const r = await nwsSourceFrom(client).latest(47.6, -122.3);
    expect(r).toEqual({ stationIdentifier: 'KSEA', observedAt: NOW_S - 600, values: { temperature_c: 9.4, humidity_pct: 81 } });
    expect(await nwsSourceFrom({ getCurrentObservations: async () => ({ stale: true, timestamp: null }) }).latest(1, 1)).toBeNull();
  });
});

describe('GET /api/stations/:alias/compare', () => {
  function app(comparer: any, anonymous = true) {
    const db = {
      execute: jest.fn(async (sql: string) => {
        if (/weather_stations/.test(sql)) return { rows: [{ station_id: 'alice-backyard-ws' }] };
        return { rows: [] };
      }),
    };
    const a = express();
    a.use('/api', createStationDetailRouter({
      db, comparer, readerToken: () => 'reader-token', isAuthenticated: () => !anonymous,
      chainTail: tail({}) as any,
    } as any));
    return a;
  }

  it('answers by alias and never with the raw station id', async () => {
    const comparer = { compare: jest.fn(async (id: string) => ({ status: 'no_recent_reading', reason: `nothing for ${id}` })) };
    const res = await request(app(comparer)).get(`/api/stations/${stationAlias('alice-backyard-ws')}/compare`);
    expect(res.status).toBe(200);
    expect(comparer.compare).toHaveBeenCalledWith('alice-backyard-ws');
    expect(JSON.stringify(res.body)).not.toContain('alice-backyard-ws');
    expect(res.body.status).toBe('no_recent_reading');
  });

  it('404s a raw id for anonymous callers', async () => {
    const res = await request(app({ compare: jest.fn() })).get('/api/stations/alice-backyard-ws/compare');
    expect(res.status).toBe(404);
  });

  it('maps unavailable to 503 and a thrown error to the fixed 503', async () => {
    const un = await request(app({ compare: async () => ({ status: 'unavailable', reason: 'The chain could not be read right now.' }) }))
      .get(`/api/stations/${stationAlias('alice-backyard-ws')}/compare`);
    expect(un.status).toBe(503);
    expect(un.body.error.code).toBe('COMPARE_UNAVAILABLE');
    const boom = await request(app({ compare: async () => { throw new Error('SELECT secret'); } }))
      .get(`/api/stations/${stationAlias('alice-backyard-ws')}/compare`);
    expect(boom.status).toBe(503);
    expect(JSON.stringify(boom.body)).not.toContain('secret');
  });
});
