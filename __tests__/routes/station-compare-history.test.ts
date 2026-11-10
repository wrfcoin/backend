/**
 * Epic 8: "How has my station compared?" for the station's owner
 * (GET /api/stations/:alias/compare/history, the hourly sampler and the 30-day summary).
 * Stations, wallets and coordinates here are made up.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';
import { createStationOwnerInsightsRouter } from '../../server/routes/station-owner-insights-routes.js';
import {
  BACKOFF_BASE_MS,
  HISTORY_DAYS,
  MIN_PAIRS,
  STATION_GAP_MS,
  dominantReference,
  newSamplerState,
  nwsPairSourceFrom,
  readingFromTailItem,
  sampleStations,
  summarizeHistory,
  type CompareSample,
  type NwsPairSource,
} from '../../server/services/station-compare-history.js';
import { stationAlias } from '../../server/utils/station-alias.js';

const NOW_S = 1_790_000_000;
const HOUR = 3600;

function samples(count: number, over: (i: number) => Partial<CompareSample> = () => ({})): CompareSample[] {
  return Array.from({ length: count }, (_, i) => ({
    observedAt: NOW_S - i * HOUR,
    temperatureC: 12 + (i % 3),
    humidityPct: 60,
    pressureHpa: 1001,
    nwsStation: 'KAAA',
    nwsTemperatureC: 10 + (i % 3),
    nwsHumidityPct: 66,
    nwsPressureHpa: 1009,
    ...over(i),
  }));
}

describe('summarizeHistory', () => {
  it('gives the usual difference, the typical gap and how often the two were close', () => {
    // Temperature: ours is 2.0 warmer for 60 pairs and 0.5 warmer for 40.
    const s = samples(100, i => (i < 40 ? { temperatureC: 10.5, nwsTemperatureC: 10 } : {}));
    const r = summarizeHistory(s, NOW_S);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.reference).toEqual({ kind: 'nws', stationIdentifier: 'KAAA' });
    expect(r.days).toBe(HISTORY_DAYS);
    expect(r.to).toBe(NOW_S);
    expect(r.from).toBe(NOW_S - 99 * HOUR);
    const t = r.variables.find(v => v.variable === 'temperature_c')!;
    expect(t).toEqual({ variable: 'temperature_c', pairs: 100, usualDifference: 2, typicalGap: 2, closePercent: 40, closeWithin: 1.5 });
    const h = r.variables.find(v => v.variable === 'humidity_pct')!;
    expect(h).toEqual({ variable: 'humidity_pct', pairs: 100, usualDifference: -6, typicalGap: 6, closePercent: 100, closeWithin: 8 });
  });

  it('says not enough data below the pair floor or the day floor', () => {
    const few = summarizeHistory(samples(MIN_PAIRS - 1), NOW_S);
    expect(few).toMatchObject({ status: 'not_enough_data', pairs: MIN_PAIRS - 1, pairsNeeded: MIN_PAIRS });
    // 30 pairs, all inside two days.
    const twoDays = summarizeHistory(samples(30).map((s, i) => ({ ...s, observedAt: NOW_S - (NOW_S % 86_400) - (i % 2) * 86_400 + 60 + i })), NOW_S + 86_400);
    expect(twoDays).toMatchObject({ status: 'not_enough_data', daysWithData: 2, daysNeeded: 3 });
    expect(summarizeHistory([], NOW_S)).toMatchObject({ status: 'not_enough_data', pairs: 0 });
  });

  it('ignores samples older than 30 days and pairs against a different NWS station', () => {
    const old = samples(50).map(s => ({ ...s, observedAt: s.observedAt - 31 * 86_400, temperatureC: 40 }));
    const other = samples(10, () => ({ nwsStation: 'KBBB', temperatureC: 30 }));
    const r = summarizeHistory([...samples(80), ...old, ...other], NOW_S);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.reference.stationIdentifier).toBe('KAAA');
    expect(r.variables.find(v => v.variable === 'temperature_c')).toMatchObject({ pairs: 80, usualDifference: 2 });
  });

  it('leaves out a variable with too few pairs of its own', () => {
    const r = summarizeHistory(samples(60, i => (i < 50 ? { humidityPct: null } : {})), NOW_S);
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.variables.map(v => v.variable)).toEqual(['temperature_c']);
  });

  it('picks the reference deterministically on a tie', () => {
    expect(dominantReference([...samples(2, () => ({ nwsStation: 'KZZZ' })), ...samples(2, () => ({ nwsStation: 'KAAA' }))])).toBe('KAAA');
    expect(dominantReference([])).toBeNull();
  });
});

describe('sampler', () => {
  const HOUR_MS = 3_600_000;
  const startMs = Math.floor((NOW_S * 1000) / HOUR_MS) * HOUR_MS + 10 * 60_000;

  function setup(over: {
    stations?: Array<{ station_id: string; latitude: number | null; longitude: number | null }>;
    done?: string[];
    tail?: (id: string) => any;
    nws?: NwsPairSource;
  } = {}) {
    let clock = startMs;
    const now = () => clock;
    const sleeps: number[] = [];
    const sleep = async (ms: number) => { sleeps.push(ms); clock += ms; };
    const inserts: unknown[][] = [];
    const sql: string[] = [];
    const query = jest.fn(async (text: string, params: unknown[] = []) => {
      sql.push(text);
      if (/FROM weather_stations/.test(text)) {
        return { rows: over.stations ?? [
          { station_id: 'alpha', latitude: 40.12345, longitude: -100.98765 },
          { station_id: 'bravo', latitude: 40.14, longitude: -101.02 },
          { station_id: 'charlie', latitude: 12.3, longitude: 45.6 },
        ] };
      }
      if (/SELECT station_id FROM station_compare_samples/.test(text)) return { rows: (over.done ?? []).map(station_id => ({ station_id })) };
      if (/^INSERT INTO station_compare_samples/.test(text)) { inserts.push(params); return { rows: [] }; }
      return { rows: [] };
    });
    const okTail = (observedAt: number, values: Record<string, unknown>) => ({
      kind: 'ok' as const, items: [{ observed_at: observedAt, values }], chainHeight: 100, fromHeight: 36, toHeight: 100, complete: true,
    });
    const latest = jest.fn(async (id: string) => (over.tail
      ? over.tail(id)
      : okTail(Math.floor(clock / 1000) - 300, { temperature_c: 11.5, humidity_percent: 71, pressure_hpa: 998.2 })));
    const nws = over.nws ?? {
      latest: jest.fn(async () => ({ stationIdentifier: 'KAAA', observedAt: Math.floor(clock / 1000) - 1200, temperatureC: 10, humidityPct: 75, pressureHpa: 1004.1 })),
    };
    return { now, sleep, sleeps, inserts, sql, query, latest, nws, okTail, chainTail: { latest, lastSeenMs: async () => null } as any, clock: () => clock };
  }

  it('stores one pair per station for the current hour, from 0.1-degree cells only', async () => {
    const s = setup();
    const counts = await sampleStations({ query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, sleep: s.sleep, state: newSamplerState() });
    expect(counts).toMatchObject({ stations: 3, read: 3, stored: 3, nodeBusy: false });
    expect(s.inserts).toHaveLength(3);
    const [stationId, hour, , t, h, p, nwsStation, , nt, nh, np] = s.inserts[0];
    expect(stationId).toBe('alpha');
    expect(hour).toBe(new Date(startMs - 10 * 60_000).toISOString());
    expect([t, h, p, nwsStation, nt, nh, np]).toEqual([11.5, 71, 998.2, 'KAAA', 10, 75, 1004.1]);
    // The NWS lookup only ever sees coordinates rounded to 0.1 degree, once per cell.
    const calls = (s.nws.latest as jest.Mock).mock.calls;
    expect(calls).toEqual([[40.1, -101], [12.3, 45.6]]);
    // No stored value and no SQL parameter carries a coordinate.
    expect(JSON.stringify(s.inserts)).not.toMatch(/40\.1|-10[01]|12\.3|45\.6/);
  });

  it('reads stations at most one every 21 seconds', async () => {
    const s = setup();
    await sampleStations({ query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, sleep: s.sleep, state: newSamplerState() });
    expect(s.sleeps).toEqual([STATION_GAP_MS, STATION_GAP_MS]);
  });

  it('skips stations already sampled this hour without reading the node', async () => {
    const s = setup({ done: ['alpha', 'charlie'] });
    const counts = await sampleStations({ query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, sleep: s.sleep, state: newSamplerState() });
    expect(counts).toMatchObject({ alreadySampled: 2, read: 1, stored: 1 });
    expect(s.latest.mock.calls.map(c => c[0])).toEqual(['bravo']);
  });

  it('stops on a 429 from the node and stays away, doubling each time', async () => {
    const s = setup({ tail: () => ({ kind: 'rejected', status: 429, payload: null }) });
    const state = newSamplerState();
    const deps = { query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, sleep: s.sleep, state };
    const first = await sampleStations(deps);
    expect(first).toMatchObject({ read: 1, stored: 0, nodeBusy: true });
    expect(s.latest).toHaveBeenCalledTimes(1);
    expect(state.resumeAt).toBe(s.clock() + BACKOFF_BASE_MS);
    const second = await sampleStations(deps);
    expect(second).toMatchObject({ backingOff: true, read: 0 });
    expect(s.latest).toHaveBeenCalledTimes(1);
  });

  it('stops the pass when the node cannot be read', async () => {
    const s = setup({ tail: () => ({ kind: 'unavailable', reason: 'CORE4_UNREACHABLE' }) });
    const counts = await sampleStations({ query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, sleep: s.sleep, state: newSamplerState() });
    expect(counts).toMatchObject({ read: 1, stored: 0, nodeUnavailable: true });
  });

  it('stores nothing for a stale reading, a missing NWS observation or one too far apart in time', async () => {
    const stale = setup();
    stale.latest.mockImplementation(async () => stale.okTail(Math.floor(stale.clock() / 1000) - 2 * 3600, { temperature_c: 10 }));
    expect(await sampleStations({ query: stale.query, chainTail: stale.chainTail, nws: stale.nws, now: stale.now, sleep: stale.sleep, state: newSamplerState() }))
      .toMatchObject({ stored: 0, noReading: 3 });

    const none = setup({ nws: { latest: jest.fn(async () => null) } });
    expect(await sampleStations({ query: none.query, chainTail: none.chainTail, nws: none.nws, now: none.now, sleep: none.sleep, state: newSamplerState() }))
      .toMatchObject({ stored: 0, noReference: 3 });

    const throwing = setup({ nws: { latest: jest.fn(async () => { throw new Error('nws down'); }) } });
    expect(await sampleStations({ query: throwing.query, chainTail: throwing.chainTail, nws: throwing.nws, now: throwing.now, sleep: throwing.sleep, state: newSamplerState() }))
      .toMatchObject({ stored: 0, noReference: 3 });
  });

  it('drops implausible values and reads the NWS units it knows', async () => {
    expect(readingFromTailItem({ observed_at: 5, values: { temperature_c: 99, humidity_percent: 140, pressure_hpa: 12 } }))
      .toEqual({ observedAt: 5, temperatureC: null, humidityPct: null, pressureHpa: null });
    expect(readingFromTailItem(undefined)).toBeNull();
    const source = nwsPairSourceFrom({
      getCurrentObservations: async () => ({
        stationId: 'KAAA', timestamp: new Date(NOW_S * 1000).toISOString(),
        temperature: { value: 9.4, unit: 'wmoUnit:degC' },
        relativeHumidity: { value: 80.2, unit: 'wmoUnit:percent' },
        barometricPressure: { value: 100_870, unit: 'wmoUnit:Pa' },
      }),
    });
    expect(await source.latest(40.1, -101)).toEqual({ stationIdentifier: 'KAAA', observedAt: NOW_S, temperatureC: 9.4, humidityPct: 80.2, pressureHpa: 1008.7 });
    const odd = nwsPairSourceFrom({ getCurrentObservations: async () => ({ stationId: 'not a station', timestamp: new Date(NOW_S * 1000).toISOString() }) });
    expect(await odd.latest(40.1, -101)).toBeNull();
  });
});

describe('GET /api/stations/:alias/compare/history', () => {
  const STATION = 'made-up-station-1';
  const ALIAS = stationAlias(STATION);
  const OWNER = '0x' + 'ab'.repeat(20);
  const OTHER = '0x' + 'cd'.repeat(20);
  const now = () => NOW_S * 1000;

  function app(over: { enabled?: boolean; wallet?: string | null; operator?: boolean; rows?: Record<string, unknown>[]; failSamples?: boolean; limit?: number } = {}) {
    const sql: string[] = [];
    const db = {
      execute: jest.fn(async (text: string, params: unknown[] = []) => {
        sql.push(text);
        if (/owner_address/.test(text)) return { rows: params[0] === STATION ? [{ owner_address: OWNER }] : [] };
        if (/FROM station_compare_samples/.test(text)) {
          if (over.failSamples) throw new Error(`relation missing for ${STATION}`);
          return { rows: over.rows ?? [] };
        }
        // station alias resolution: the alias is the query parameter
        return { rows: params[0] === ALIAS ? [{ station_id: STATION }] : [] };
      }),
    };
    const a = express();
    a.use('/api', createStationOwnerInsightsRouter({
      db,
      now,
      walletOf: () => (over.wallet === undefined ? OWNER : over.wallet),
      isOperator: () => over.operator ?? false,
      historyEnabled: () => over.enabled ?? true,
      limits: over.limit ? { readPerIp: over.limit } : undefined,
    }));
    return { a, db, sql };
  }

  const rows = (count: number) => Array.from({ length: count }, (_, i) => ({
    observed_at: String(NOW_S - i * HOUR), temperature_c: 13, humidity_pct: 60, pressure_hpa: 1001,
    nws_station: 'KAAA', nws_temperature_c: 10, nws_humidity_pct: 66, nws_pressure_hpa: 1009,
  }));

  it('is 404 and reads nothing while the feature is off', async () => {
    const { a, db } = app({ enabled: false });
    const r = await request(a).get(`/api/stations/${ALIAS}/compare/history`);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { code: 'NOT_FOUND', message: 'not found' } });
    expect(db.execute).not.toHaveBeenCalled();
  });

  it('gives the owner the 30-day summary, private and with no id, owner or coordinate', async () => {
    const { a } = app({ rows: rows(80) });
    const r = await request(a).get(`/api/stations/${ALIAS}/compare/history`);
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('private, no-store');
    expect(r.body.status).toBe('ok');
    expect(r.body.reference).toEqual({ kind: 'nws', stationIdentifier: 'KAAA' });
    expect(r.body.variables[0]).toEqual({ variable: 'temperature_c', pairs: 80, usualDifference: 3, typicalGap: 3, closePercent: 0, closeWithin: 1.5 });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(STATION);
    expect(text).not.toContain(OWNER);
    expect(text).not.toMatch(/latitude|longitude|owner|wallet/i);
  });

  it('says not enough data honestly', async () => {
    const { a } = app({ rows: rows(5) });
    const r = await request(a).get(`/api/stations/${ALIAS}/compare/history`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ status: 'not_enough_data', pairs: 5, pairsNeeded: MIN_PAIRS });
  });

  it('refuses a visitor (401) and another wallet (403) without reading any sample', async () => {
    const anon = app({ wallet: null, rows: rows(80) });
    const r1 = await request(anon.a).get(`/api/stations/${ALIAS}/compare/history`);
    expect(r1.status).toBe(401);
    expect(r1.headers['cache-control']).toBe('private, no-store');
    const other = app({ wallet: OTHER, rows: rows(80) });
    const r2 = await request(other.a).get(`/api/stations/${ALIAS}/compare/history`);
    expect(r2.status).toBe(403);
    expect(JSON.stringify(r2.body)).not.toContain(OWNER);
    for (const used of [anon.sql, other.sql]) expect(used.some(q => /station_compare_samples/.test(q))).toBe(false);
  });

  it('is 404 for an unknown alias and for a raw station id from the public', async () => {
    const { a } = app();
    expect((await request(a).get('/api/stations/st_000000000000/compare/history')).status).toBe(404);
    expect((await request(a).get(`/api/stations/${STATION}/compare/history`)).status).toBe(404);
  });

  it('lets the operator bearer read by raw id', async () => {
    const { a } = app({ wallet: null, operator: true, rows: rows(80) });
    const r = await request(a).get(`/api/stations/${STATION}/compare/history`);
    expect(r.status).toBe(200);
    expect(r.body.status).toBe('ok');
  });

  it('answers a fixed 503 when the store fails, with no error text', async () => {
    const { a } = app({ failSamples: true });
    const r = await request(a).get(`/api/stations/${ALIAS}/compare/history`);
    expect(r.status).toBe(503);
    expect(JSON.stringify(r.body)).not.toContain(STATION);
    expect(r.body.error.code).toBe('STATION_DATA_UNAVAILABLE');
  });

  it('rate-limits per client', async () => {
    const { a } = app({ rows: rows(80), limit: 2 });
    await request(a).get(`/api/stations/${ALIAS}/compare/history`);
    await request(a).get(`/api/stations/${ALIAS}/compare/history`);
    expect((await request(a).get(`/api/stations/${ALIAS}/compare/history`)).status).toBe(429);
  });
});
