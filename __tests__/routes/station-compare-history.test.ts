/**
 * Epic 8: "How has my station compared?" for the station's owner
 * (GET /api/stations/:alias/compare/history, the hourly sampler and the 30-day summary).
 * Stations, wallets and coordinates here are synthetic: no value stands for a real place.
 */
import express from 'express';
import request from 'supertest';
import { describe, expect, it, jest } from '@jest/globals';
import { createStationOwnerInsightsRouter } from '../../server/routes/station-owner-insights-routes.js';
import {
  BACKOFF_BASE_MS,
  HISTORY_DAYS,
  MAX_STATIONS_PER_PASS,
  MIN_PAIRS,
  MAX_CONSECUTIVE_FAILURES,
  dominantReference,
  newSamplerState,
  nwsPairSourceFrom,
  pacedCore4Fetch,
  readingFromTailItem,
  sampleStations,
  summarizeHistory,
  type CompareSample,
  type NwsPairSource,
} from '../../server/services/station-compare-history.js';
import { stationAlias } from '../../server/utils/station-alias.js';
import { gapMsFor, nodeJobReadsPerMinute, reserveNodeReads, type NodeReadClock } from '../../server/services/node-read-pacer.js';
import { createChainTailReader } from '../../server/services/chain-station-tail.js';

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
    nwsBarometricHpa: 1009,
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
        // SYNTHETIC coordinates: open ocean near 0 N 0 E, with digits no real station has. They are finer
        // than 0.1 degree only to prove that the sampler rounds before it uses them.
        return { rows: over.stations ?? [
          { station_id: 'alpha', latitude: 0.123456, longitude: 0.654321 },
          { station_id: 'bravo', latitude: 0.149999, longitude: 0.650001 },
          { station_id: 'charlie', latitude: 0.3, longitude: 0.4 },
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
      latest: jest.fn(async () => ({ stationIdentifier: 'KAAA', observedAt: Math.floor(clock / 1000) - 1200, temperatureC: 10, humidityPct: 75, barometricHpa: 1004.1 })),
    };
    return { now, sleep, sleeps, inserts, sql, query, latest, nws, okTail, chainTail: { latest, lastSeenMs: async () => null } as any, clock: () => clock };
  }

  it('stores one pair per station for the current hour, from 0.1-degree cells only', async () => {
    const s = setup();
    const counts = await sampleStations({ query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, state: newSamplerState() });
    expect(counts).toMatchObject({ stations: 3, read: 3, stored: 3, nodeBusy: false });
    expect(s.inserts).toHaveLength(3);
    const [stationId, hour, , t, h, p, nwsStation, , nt, nh, np] = s.inserts[0];
    expect(stationId).toBe('alpha');
    expect(hour).toBe(new Date(startMs - 10 * 60_000).toISOString());
    expect([t, h, p, nwsStation, nt, nh, np]).toEqual([11.5, 71, 998.2, 'KAAA', 10, 75, 1004.1]);
    // The NWS lookup only ever sees coordinates rounded to 0.1 degree, once per cell.
    const calls = (s.nws.latest as jest.Mock).mock.calls;
    expect(calls).toEqual([[0.1, 0.7], [0.3, 0.4]]);
    // No stored row carries a coordinate, fine or rounded: only the eleven sample columns.
    expect(s.inserts.every(row => row.length === 11)).toBe(true);
    expect(JSON.stringify(s.inserts)).not.toMatch(/0\.123456|0\.654321|0\.149999|0\.650001/);
    expect(s.sql.filter(q => /^INSERT/.test(q)).join(' ')).not.toMatch(/latitude|longitude/);
  });

  it('skips stations already sampled this hour without reading the node', async () => {
    const s = setup({ done: ['alpha', 'charlie'] });
    const counts = await sampleStations({ query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, state: newSamplerState() });
    expect(counts).toMatchObject({ alreadySampled: 2, read: 1, stored: 1 });
    expect(s.latest.mock.calls.map(c => c[0])).toEqual(['bravo']);
  });

  it('stops on a 429 from the node and stays away, doubling each time', async () => {
    const s = setup({ tail: () => ({ kind: 'rejected', status: 429, payload: null }) });
    const state = newSamplerState();
    const deps = { query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, state };
    const first = await sampleStations(deps);
    expect(first).toMatchObject({ read: 1, stored: 0, nodeBusy: true });
    expect(s.latest).toHaveBeenCalledTimes(1);
    expect(state.resumeAt).toBe(s.clock() + BACKOFF_BASE_MS);
    const second = await sampleStations(deps);
    expect(second).toMatchObject({ backingOff: true, read: 0 });
    expect(s.latest).toHaveBeenCalledTimes(1);
  });

  it('stops the pass after three stations in a row the node could not be reached for, and they keep their turn', async () => {
    const stations = Array.from({ length: 8 }, (_, i) => ({ station_id: `s-${i}`, latitude: 0.3, longitude: 0.4 }));
    const s = setup({ stations, tail: () => ({ kind: 'unavailable', reason: 'CORE4_UNREACHABLE' }) });
    const state = newSamplerState();
    const counts = await sampleStations({ query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, state });
    expect(counts).toMatchObject({ read: MAX_CONSECUTIVE_FAILURES, stored: 0, nodeUnavailable: true, refused: 0 });
    expect(state.tried.size).toBe(0);
    expect(state.cursor).toBe('s-2');
  });

  it('a station the node keeps refusing does not hold up the others, in this pass or the next', async () => {
    const stations = ['a-live', 'b-refused', 'c-live', 'd-live'].map(station_id => ({ station_id, latitude: 0.3, longitude: 0.4 }));
    const s = setup({ stations });
    s.latest.mockImplementation(async (id: string) => (id === 'b-refused'
      ? { kind: 'rejected' as const, status: 422, payload: { error: { code: 'INVALID_STATION' } } }
      : s.okTail(Math.floor(s.clock() / 1000) - 60, { temperature_c: 11.5, humidity_percent: 71, pressure_hpa: 998.2 })));
    const state = newSamplerState();
    const deps = { query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, state };
    const first = await sampleStations(deps);
    expect(first).toMatchObject({ read: 4, stored: 3, refused: 1, nodeBusy: false, nodeUnavailable: false });
    expect(s.inserts.map(row => row[0])).toEqual(['a-live', 'c-live', 'd-live']);
    // Its turn for the hour is used: the next pass does not ask for it again.
    s.latest.mockClear();
    await sampleStations(deps);
    expect(s.latest).not.toHaveBeenCalled();
    // Next hour it is asked once more, and the others are sampled again around it.
    await s.sleep(3_600_000);
    const nextHour = await sampleStations(deps);
    expect(nextHour).toMatchObject({ read: 4, refused: 1, stored: 3 });
  });

  it('a wrong-shaped answer for one station is treated the same way', async () => {
    const stations = ['a-odd', 'b-live'].map(station_id => ({ station_id, latitude: 0.3, longitude: 0.4 }));
    const s = setup({ stations });
    s.latest.mockImplementation(async (id: string) => (id === 'a-odd'
      ? { kind: 'mismatch' as const }
      : s.okTail(Math.floor(s.clock() / 1000) - 60, { temperature_c: 11.5 })));
    expect(await sampleStations({ query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, state: newSamplerState() }))
      .toMatchObject({ read: 2, refused: 1, stored: 1 });
  });

  it('stores nothing for a stale reading, a missing NWS observation or one too far apart in time', async () => {
    const stale = setup();
    stale.latest.mockImplementation(async () => stale.okTail(Math.floor(stale.clock() / 1000) - 2 * 3600, { temperature_c: 10 }));
    expect(await sampleStations({ query: stale.query, chainTail: stale.chainTail, nws: stale.nws, now: stale.now, state: newSamplerState() }))
      .toMatchObject({ stored: 0, noReading: 3 });

    const none = setup({ nws: { latest: jest.fn(async () => null) } });
    expect(await sampleStations({ query: none.query, chainTail: none.chainTail, nws: none.nws, now: none.now, state: newSamplerState() }))
      .toMatchObject({ stored: 0, noReference: 3 });

  });

  it('a pass cannot be used up by stations with no fresh reading: each is tried once an hour and the next pass carries on', async () => {
    // 150 stations with nothing fresh sort ahead of the one live station.
    const offline = Array.from({ length: 150 }, (_, i) => ({ station_id: `a-offline-${String(i).padStart(3, '0')}`, latitude: 0.3, longitude: 0.4 }));
    const s = setup({ stations: [...offline, { station_id: 'z-live', latitude: 0.3, longitude: 0.4 }] });
    s.latest.mockImplementation(async (id: string) => (id === 'z-live'
      ? s.okTail(Math.floor(s.clock() / 1000) - 60, { temperature_c: 11.5, humidity_percent: 71, pressure_hpa: 998.2 })
      : { kind: 'ok' as const, items: [], chainHeight: 100, fromHeight: 36, toHeight: 100, complete: true }));
    const state = newSamplerState();
    // No pacing wait here, so three passes fit in one hour of the fake clock.
    const deps = { query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, state };
    const first = await sampleStations(deps);
    expect(first).toMatchObject({ read: MAX_STATIONS_PER_PASS, stored: 0, noReading: MAX_STATIONS_PER_PASS });
    const second = await sampleStations(deps);
    // It carried on after the 60th station instead of starting over.
    expect(second).toMatchObject({ read: MAX_STATIONS_PER_PASS, stored: 0, alreadyTried: 0 });
    const third = await sampleStations(deps);
    expect(third).toMatchObject({ read: 31, stored: 1 });
    expect(s.inserts.map(row => row[0])).toEqual(['z-live']);
    // Nothing was read twice in the hour.
    const readIds = s.latest.mock.calls.map(c => c[0]);
    expect(new Set(readIds).size).toBe(readIds.length);
    // A fourth pass in the same hour has nothing left to read.
    expect(await sampleStations(deps)).toMatchObject({ read: 0 });
  });

  it('starts each pass after the station the last one stopped at', async () => {
    const stations = Array.from({ length: MAX_STATIONS_PER_PASS + 5 }, (_, i) => ({ station_id: `s-${String(i).padStart(3, '0')}`, latitude: 0.3, longitude: 0.4 }));
    const s = setup({ stations });
    const state = newSamplerState();
    const deps = { query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, state };
    await sampleStations(deps);
    expect(state.cursor).toBe(`s-${String(MAX_STATIONS_PER_PASS - 1).padStart(3, '0')}`);
    s.latest.mockClear();
    await sampleStations(deps);
    expect(s.latest.mock.calls.map(c => c[0])[0]).toBe(`s-${String(MAX_STATIONS_PER_PASS).padStart(3, '0')}`);
    expect(s.latest).toHaveBeenCalledTimes(5);
  });

  it('asks api.weather.gov once per cell per pass, and holds a failing cell for 5 minutes, doubling', async () => {
    const failing = { latest: jest.fn(async () => { throw new Error('nws down'); }) };
    const s = setup({ nws: failing });
    const state = newSamplerState();
    const deps = { query: s.query, chainTail: s.chainTail, nws: failing, now: s.now, state };
    const first = await sampleStations(deps);
    // alpha and bravo share a cell: one call for both, one for charlie's cell.
    expect(failing.latest).toHaveBeenCalledTimes(2);
    expect(first).toMatchObject({ stored: 0, noReference: 3, referenceErrors: 2 });
    expect(state.nwsHold.get('0.1,0.7')).toMatchObject({ streak: 1 });
    expect((state.nwsHold.get('0.1,0.7') as { until: number }).until - s.clock()).toBeLessThanOrEqual(BACKOFF_BASE_MS);

    // Next hour, still inside the hold: no NWS call and no node read for those cells.
    state.nwsHold.forEach((hold) => { hold.until = s.clock() + 2 * 3_600_000; });
    s.latest.mockClear();
    await s.sleep(3_600_000);
    const held = await sampleStations(deps);
    expect(held).toMatchObject({ read: 0, referenceOnHold: 3 });
    expect(failing.latest).toHaveBeenCalledTimes(2);
    expect(s.latest).not.toHaveBeenCalled();

    // After the hold a second failure doubles it.
    state.nwsHold.forEach((hold) => { hold.until = 0; });
    await s.sleep(3_600_000);
    await sampleStations(deps);
    expect(failing.latest).toHaveBeenCalledTimes(4);
    expect(state.nwsHold.get('0.1,0.7')).toMatchObject({ streak: 2 });
    const hold = state.nwsHold.get('0.1,0.7') as { until: number };
    expect(hold.until - s.clock()).toBeGreaterThan(BACKOFF_BASE_MS);
    expect(hold.until - s.clock()).toBeLessThanOrEqual(2 * BACKOFF_BASE_MS);
  });

  it('a lookup that works again clears the hold', async () => {
    const s = setup();
    const state = newSamplerState();
    state.nwsHold.set('0.1,0.7', { streak: 3, until: 0 });
    await sampleStations({ query: s.query, chainTail: s.chainTail, nws: s.nws, now: s.now, state });
    expect(state.nwsHold.has('0.1,0.7')).toBe(false);
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
    expect(await source.latest(0.1, 0.7)).toEqual({ stationIdentifier: 'KAAA', observedAt: NOW_S, temperatureC: 9.4, humidityPct: 80.2, barometricHpa: 1008.7 });
    const odd = nwsPairSourceFrom({ getCurrentObservations: async () => ({ stationId: 'not a station', timestamp: new Date(NOW_S * 1000).toISOString() }) });
    expect(await odd.latest(0.1, 0.7)).toBeNull();
  });
});

describe('one pace for every job that reads the node', () => {
  const fakeClock = (start = 1_000_000) => {
    let t = start;
    return { now: () => t, sleep: async (ms: number) => { t += ms; } };
  };

  it('two jobs on one clock take turns, and together stay at the ceiling', async () => {
    // A small scheduler: sleepers wake one at a time, earliest first, so two jobs can wait at once.
    let t = 1_000_000;
    const sleepers: Array<{ wake: number; resume: () => void }> = [];
    const clock = { now: () => t, sleep: (ms: number) => new Promise<void>(resume => { sleepers.push({ wake: t + ms, resume }); }) };
    const idle = () => new Promise<void>(resolve => { setImmediate(resolve); });
    const runUntil = async (work: Promise<unknown>) => {
      let done = false;
      void work.then(() => { done = true; });
      for (;;) {
        await idle();
        if (done) return;
        sleepers.sort((a, b) => a.wake - b.wake);
        const next = sleepers.shift();
        if (next) { t = Math.max(t, next.wake); next.resume(); }
      }
    };
    const shared: NodeReadClock = { nextReadAt: 0 };
    const reads: Array<{ job: string; at: number }> = [];
    const job = async (name: string, count: number) => {
      for (let i = 0; i < count; i += 1) {
        await reserveNodeReads(shared, 1, 20, clock.now, clock.sleep);
        reads.push({ job: name, at: clock.now() });
      }
    };
    await runUntil(Promise.all([job('score', 30), job('sampler', 30)]));
    reads.sort((a, b) => a.at - b.at);
    // No two reads share a slot, and slots are one gap apart: 20 a minute in total.
    for (let i = 1; i < reads.length; i += 1) expect(reads[i].at - reads[i - 1].at).toBe(gapMsFor(20));
    // While both have work, neither waits more than one turn.
    for (let i = 2; i < 40; i += 1) expect(new Set([reads[i].job, reads[i - 1].job]).size).toBe(2);
  });

  it('the sampler reserves one slot per node call it really makes, behind slots another job holds', async () => {
    const HOUR_MS = 3_600_000;
    const clock = fakeClock(Math.floor((NOW_S * 1000) / HOUR_MS) * HOUR_MS + 60_000);
    const start = clock.now();
    const shared: NodeReadClock = { nextReadAt: start + 9_000 }; // another job holds the next 9 s
    const calls: number[] = [];
    // A node that answers the height probe and one window: two calls for a live station.
    const node = jest.fn(async (_path: string, options?: Record<string, unknown>) => {
      calls.push(clock.now());
      const query = (options?.query ?? {}) as { limit?: number };
      const item = { observed_at: Math.floor(clock.now() / 1000) - 60, height: 500, values: { temperature_c: 11.5, humidity_percent: 71, pressure_hpa: 998.2 } };
      return { ok: true, status: 200, payload: { ok: true, data: { items: query.limit === 1 ? [] : [item], next_after: 500, next_offset: 0, has_more: false, chain_height: 500 } } };
    });
    const chainTail = createChainTailReader({
      fetchCore4Json: pacedCore4Fetch(node, { clock: shared, readsPerMin: () => 20, now: clock.now, sleep: clock.sleep }),
      readerToken: () => 'reader-token-for-this-test',
      now: clock.now,
      readDeadlineMs: 600_000,
    });
    const query = jest.fn(async (text: string) => (/FROM weather_stations/.test(text)
      ? { rows: [{ station_id: 'alpha', latitude: 0.3, longitude: 0.4 }] } : { rows: [] }));
    const counts = await sampleStations({
      query, chainTail, nws: { latest: async () => ({ stationIdentifier: 'KAAA', observedAt: Math.floor(clock.now() / 1000) - 600, temperatureC: 10, humidityPct: 75, barometricHpa: 1004 }) },
      now: clock.now, state: newSamplerState(),
    });
    expect(counts).toMatchObject({ read: 1, stored: 1 });
    // The first call waited for the held slots; each further call took exactly one more slot.
    expect(calls[0]).toBe(start + 9_000);
    for (let i = 1; i < calls.length; i += 1) expect(calls[i] - calls[i - 1]).toBe(gapMsFor(20));
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThan(7);
    // Nothing was reserved beyond the calls that went out.
    expect(shared.nextReadAt).toBe(calls[calls.length - 1] + gapMsFor(20));
  });

  it('a paced read that has to wait is not cut off by the page-request deadline', async () => {
    const clock = fakeClock();
    const shared: NodeReadClock = { nextReadAt: clock.now() + 120_000 }; // two minutes of slots already taken
    const node = jest.fn(async () => ({ ok: true, status: 200, payload: { ok: true, data: { items: [], next_after: 10, next_offset: 0, has_more: false, chain_height: 10 } } }));
    const chainTail = createChainTailReader({
      fetchCore4Json: pacedCore4Fetch(node, { clock: shared, readsPerMin: () => 20, now: clock.now, sleep: clock.sleep }),
      readerToken: () => 'reader-token-for-this-test', now: clock.now, readDeadlineMs: 600_000,
    });
    expect((await chainTail.latest('alpha')).kind).toBe('ok');
    expect(node).toHaveBeenCalled();
  });

  it('reads the shared ceiling from the environment and ignores a bad value', () => {
    expect(nodeJobReadsPerMinute(undefined)).toBe(20);
    expect(nodeJobReadsPerMinute('61')).toBe(20);
    expect(nodeJobReadsPerMinute('12')).toBe(12);
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
    nws_station: 'KAAA', nws_temperature_c: 10, nws_humidity_pct: 66, nws_barometric_hpa: 1009,
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

  it('the default bypass is the operator bearer only: the reader bearer is treated as a visitor', async () => {
    const saved = { op: process.env.WRFCOIN_OPERATOR_TOKEN, rd: process.env.WRFCOIN_READER_TOKEN };
    process.env.WRFCOIN_OPERATOR_TOKEN = 'operator-token-for-this-test-0123456789';
    process.env.WRFCOIN_READER_TOKEN = 'reader-token-for-this-test-0123456789ab';
    try {
      const db = { execute: jest.fn(async (text: string, params: unknown[] = []) => {
        if (/owner_address/.test(text)) return { rows: [{ owner_address: OWNER }] };
        if (/FROM station_compare_samples/.test(text)) return { rows: rows(80) };
        return { rows: params[0] === ALIAS ? [{ station_id: STATION }] : [] };
      }) };
      const a = express();
      a.use('/api', createStationOwnerInsightsRouter({ db, now, historyEnabled: () => true }));
      const reader = await request(a).get(`/api/stations/${ALIAS}/compare/history`).set('Authorization', `Bearer ${process.env.WRFCOIN_READER_TOKEN}`);
      expect(reader.status).toBe(401);
      const readerRaw = await request(a).get(`/api/stations/${STATION}/compare/history`).set('Authorization', `Bearer ${process.env.WRFCOIN_READER_TOKEN}`);
      expect(readerRaw.status).toBe(404);
      const operator = await request(a).get(`/api/stations/${ALIAS}/compare/history`).set('Authorization', `Bearer ${process.env.WRFCOIN_OPERATOR_TOKEN}`);
      expect(operator.status).toBe(200);
    } finally {
      if (saved.op === undefined) delete process.env.WRFCOIN_OPERATOR_TOKEN; else process.env.WRFCOIN_OPERATOR_TOKEN = saved.op;
      if (saved.rd === undefined) delete process.env.WRFCOIN_READER_TOKEN; else process.env.WRFCOIN_READER_TOKEN = saved.rd;
    }
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
