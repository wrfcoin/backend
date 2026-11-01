/**
 * Forecasts checked against station readings (owner demo queue 2026-11-01 item 7; backend PR#72, #1494).
 * The record check (hash == chain commit id, revealed forecast for the same station), the chain truth
 * (hourly mean of the station's own readings), the NOAA reference, the scoring pass and the public routes.
 * No database, no network: the node and the SQL are fakes.
 */
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  checkForecastOnChain,
  forecastCommitId,
  parseForecastRecord,
  type Core4Get,
} from '../server/services/forecast-commit-record';
import {
  captureNoaaReferences,
  fahrenheitToC,
  firstHeightAtOrAfter,
  hourlyTruth,
  readSummary,
  scoreForecast,
  scorePending,
  stationReadings,
  type ChainReading,
  type Query,
} from '../server/services/forecast-verification/observed-verification';
import { createPublicForecastVerificationRouter } from '../server/routes/forecast-verification-routes';

// The exact data.json the forecast kit writes (canonical_value_json: sorted keys, compact, Python floats).
// The commit id is the kit's own compute_commit_id over it (hashlib.sha3_256), computed outside JavaScript.
const STATION = 'PWS-DULUTH-JANEDOE-01';
const DATA_KIT = '{"horizon_hours":6,"issued_at":1798000000,"model_id":"persistence-trend/v1","station_id":"PWS-TEST-1","valid_at":1798021600,"values":{"pressure_hpa":1013.0,"temperature_c":12.5}}';
const NONCE_KIT = 'kit-0123456789abcdef-1798000000';
const COMMIT_KIT = 'ad0083de8fc143356a11b677a7aaad6c0aa12fc91bd77e2b3e0a2cc771ad3048';

const ISSUED = 1_798_002_000; // on an hour boundary, as the kit issues
const VALID = ISSUED + 6 * 3600;
const DATA = JSON.stringify({ horizon_hours: 6, issued_at: ISSUED, model_id: 'persistence-trend/v1', station_id: STATION, valid_at: VALID,
  values: { humidity_pct: 80.25, temperature_c: 12.5 } });
const NONCE = 'kit-feedfacecafebeef-1798000000';
const COMMIT = forecastCommitId(DATA, NONCE, STATION, ISSUED);
const RECORD = { commitId: COMMIT, nonce: NONCE, timestamp: ISSUED, data: `${DATA}\n` };

const reply = (status: number, payload: unknown) => ({ ok: status >= 200 && status < 300, status, payload });

describe('commit record check', () => {
  it('matches the forecast kit hash byte for byte, Python float text included (1013.0 is not re-serialized)', () => {
    expect(forecastCommitId(DATA_KIT, NONCE_KIT, 'PWS-TEST-1', 1_798_000_000)).toBe(COMMIT_KIT);
    const parsed = parseForecastRecord({ commitId: COMMIT_KIT, nonce: NONCE_KIT, timestamp: '1798000000', data: `${DATA_KIT}\n` });
    expect(parsed).toMatchObject({ ok: true, record: { commitId: COMMIT_KIT, stationId: 'PWS-TEST-1', issuedAt: 1_798_000_000, validAt: 1_798_021_600,
      horizonHours: 6, modelId: 'persistence-trend/v1', values: { pressure_hpa: 1013, temperature_c: 12.5 } } });
    // Same JSON value written the JavaScript way ("1013") is a different commit.
    const js = DATA_KIT.replace('1013.0', '1013');
    expect(parseForecastRecord({ commitId: COMMIT_KIT, nonce: NONCE_KIT, timestamp: 1_798_000_000, data: js })).toMatchObject({ ok: false, code: 'COMMIT_MISMATCH' });
  });

  it('names the station by its public alias and rejects every malformed field before hashing', () => {
    const ok = parseForecastRecord(RECORD);
    expect(ok.ok).toBe(true);
    expect((ok as any).record.stationAlias).toMatch(/^st_[0-9a-f]{12}$/);
    const bad = (over: object) => (parseForecastRecord({ ...RECORD, ...over }) as any).code;
    expect(bad({ commitId: 'x' })).toBe('INVALID_COMMIT_ID');
    expect(bad({ nonce: 'has space' })).toBe('INVALID_NONCE');
    expect(bad({ timestamp: -1 })).toBe('INVALID_TIMESTAMP');
    expect(bad({ data: 42 })).toBe('INVALID_DATA');
    expect(bad({ data: '[1]' })).toBe('INVALID_DATA');
    expect(bad({ data: 'x'.repeat(5000) })).toBe('INVALID_DATA');
    expect(bad({ data: JSON.stringify({ station_id: STATION, issued_at: VALID, valid_at: ISSUED, values: { temperature_c: 1 } }) })).toBe('INVALID_DATA');
    expect(bad({ data: JSON.stringify({ station_id: STATION, issued_at: ISSUED, valid_at: VALID, values: { wind: 1 } }) })).toBe('INVALID_DATA');
    expect(bad({ nonce: 'kit-other' })).toBe('COMMIT_MISMATCH');
  });

  it('asks the node: exists, is a forecast, same station, revealed (reward-pruned reveals still count)', async () => {
    const record = (parseForecastRecord(RECORD) as any).record;
    const status = (over: object) => reply(200, { commit_id: COMMIT, station_id: STATION, contribution_type: 'forecast', status: 'revealed_attested',
      revealed_at: 4100, committed_at: null, reward_amount: null, reward_finalized: false, reward_status: 'not_evaluated', ...over });
    const run = (r: any) => checkForecastOnChain(async () => r, record);
    expect(await run(reply(404, { status: 'not_found' }))).toMatchObject({ ok: false, code: 'NOT_ON_CHAIN' });
    expect(await run(status({ contribution_type: 'contribution' }))).toMatchObject({ ok: false, code: 'NOT_A_FORECAST' });
    expect(await run(status({ station_id: 'OTHER' }))).toMatchObject({ ok: false, code: 'STATION_MISMATCH' });
    expect(await run(status({ status: 'committed_pending_reveal', revealed_at: null }))).toMatchObject({ ok: false, code: 'NOT_REVEALED' });
    expect(await run(reply(500, {}))).toMatchObject({ ok: false, code: 'UPSTREAM' });
    expect(await run(status({}))).toMatchObject({ ok: true, chain: { revealed: true, revealedAtHeight: 4100 } });
    expect(await run(status({ status: 'reward_finalized', revealed_at: null, reward_amount: '1000', reward_finalized: true })))
      .toMatchObject({ ok: true, chain: { revealed: true, revealedAtHeight: null, rewardAmount: '1000', rewardFinalized: true } });
    await expect(checkForecastOnChain(async () => { throw new Error('down'); }, record)).resolves.toMatchObject({ ok: false, code: 'UPSTREAM' });
  });
});

/** A fake chain: block h has time T0 + h * 77 s; readings keyed by height. */
function fakeChain(tip: number, readings: Array<{ height: number; observed_at: number; values: object; provenance_class?: string }> = []): Core4Get & { calls: string[] } {
  const T0 = VALID - 5000 * 77;
  const calls: string[] = [];
  const get = (async (path: string, query?: Record<string, unknown>) => {
    calls.push(path);
    if (path === '/blockchain') return reply(200, { ok: true, data: { height: tip } });
    const block = path.match(/^\/chain\/block\/(\d+)$/);
    if (block) {
      const h = Number(block[1]);
      if (h < 1 || h > tip) return reply(404, {});
      return reply(200, { ok: true, data: { height: h, timestamp: new Date((T0 + h * 77) * 1000).toISOString() } });
    }
    if (path.startsWith('/transactions/contributions/')) {
      const after = Number(query?.after);
      const upTo = Math.min(tip, after + 64);
      const items = readings.filter((r) => r.height > after && r.height <= upTo)
        .map((r) => ({ commit_id: `c${r.height}`, station_id: STATION, height: r.height, observed_at: r.observed_at, values: r.values, provenance_class: r.provenance_class ?? 'real' }));
      return reply(200, { ok: true, data: { items, next_after: upTo, next_offset: 0, has_more: upTo < tip } });
    }
    return reply(404, {});
  }) as Core4Get & { calls: string[] };
  get.calls = calls;
  return get;
}
const timeOf = (h: number) => VALID - 5000 * 77 + h * 77;

describe('chain truth', () => {
  it('finds the first block at or after a time in a bounded number of reads', async () => {
    const get = fakeChain(6000);
    const tip = { height: 6000, time: timeOf(6000) };
    const h = await firstHeightAtOrAfter(get, VALID, tip);
    expect(h).toBe(5000);
    expect(get.calls.length).toBeLessThanOrEqual(24);
    expect(await firstHeightAtOrAfter(get, timeOf(6000) + 1, tip)).toBe(6001);
    expect(await firstHeightAtOrAfter(get, 0, tip)).toBe(1);
  });

  it('averages the readings observed in the target hour, drops synthetic ones, and maps humidity_percent', () => {
    const readings: ChainReading[] = [
      { commitId: 'a', height: 5001, observedAt: VALID + 60, values: { temperature_c: 12, humidity_pct: 80 }, provenanceClass: 'real' },
      { commitId: 'b', height: 5010, observedAt: VALID + 1800, values: { temperature_c: 13 }, provenanceClass: 'real' },
      { commitId: 'c', height: 5020, observedAt: VALID + 1900, values: { temperature_c: 99 }, provenanceClass: 'synthetic' },
      { commitId: 'd', height: 5060, observedAt: VALID + 3600, values: { temperature_c: 50 }, provenanceClass: 'real' },
    ];
    expect(hourlyTruth(readings, VALID)).toEqual({ hourStart: VALID, readings: 2, heights: { from: 5001, to: 5010 },
      values: { temperature_c: 12.5, humidity_pct: 80 }, provenance: ['real'] });
    expect(hourlyTruth(readings.slice(2, 3), VALID)).toBeNull();
  });

  it('reads the station observations route with the node field names', async () => {
    const get = fakeChain(6000, [{ height: 5005, observed_at: VALID + 10, values: { temperature_c: 11, humidity_percent: 70, pressure_hpa: 1000 } }]);
    expect(await stationReadings(get, STATION, 4990, 5100)).toEqual([
      { commitId: 'c5005', height: 5005, observedAt: VALID + 10, values: { temperature_c: 11, humidity_pct: 70, pressure_hpa: 1000 }, provenanceClass: 'real' },
    ]);
  });

  it('scores only variables the forecast declares AND the readings report; NOAA only where it has the variable', () => {
    const truth = { hourStart: VALID, readings: 3, heights: { from: 1, to: 2 }, values: { temperature_c: 12, pressure_hpa: 1000 }, provenance: ['real'] };
    const noaa = { issuedHour: ISSUED - 3600, validHour: VALID, temperatureC: 11, humidityPct: 70, source: 'nws:test' };
    const s = scoreForecast({ temperature_c: 12.5, humidity_pct: 80, pressure_hpa: 1001 }, truth, noaa, 'none');
    expect(s.scoredVariables).toEqual(['temperature_c', 'pressure_hpa']);
    expect(s.scores.temperature_c).toEqual({ forecast: 12.5, truth: 12, error: 0.5, noaa: { value: 11, error: -1, leadHours: 7 } });
    expect(s.scores.pressure_hpa).toEqual({ forecast: 1001, truth: 1000, error: 1, noaa: null });
    expect(s.noaaReason).toBeNull();
    expect(scoreForecast({ temperature_c: 1 }, truth, null, 'no capture').noaaReason).toBe('no capture');
  });
});

/** Minimal in-memory stand-in for the two tables, matched on the statements this code issues. */
function fakeDb(noaaRows: any[] = []) {
  const records = new Map<string, any>();
  const statements: string[] = [];
  const query: Query = async (sql, params = []) => {
    statements.push(sql);
    const p = params as any[];
    if (sql.startsWith('SELECT commit_id, station_alias')) {
      if (sql.includes('WHERE commit_id = $1')) return { rows: records.has(p[0]) ? [records.get(p[0])] : [] };
      return { rows: [...records.values()] };
    }
    if (sql.startsWith('INSERT INTO forecast_verification_records')) {
      if (!records.has(p[0])) {
        records.set(p[0], { commit_id: p[0], station_id: p[1], station_alias: p[2], model_id: p[3], issued_at: new Date(p[4] * 1000), valid_at: new Date(p[5] * 1000),
          horizon_hours: p[6], forecast_values: JSON.parse(p[7]), status: 'pending', submitted_at: new Date(p[8] * 1000), attempts: 0 });
      }
      return { rows: [] };
    }
    if (sql.startsWith('SELECT commit_id, station_id, extract')) {
      return { rows: [...records.values()].filter((r) => r.status === 'pending' && r.valid_at.getTime() / 1000 < p[0] - 75 * 60)
        .map((r) => ({ commit_id: r.commit_id, station_id: r.station_id, issued: r.issued_at.getTime() / 1000, valid: r.valid_at.getTime() / 1000, forecast_values: r.forecast_values })) };
    }
    if (sql.startsWith('SELECT extract(epoch FROM issued_hour)')) {
      const row = noaaRows.filter((n) => n.station_id === p[0] && n.valid === p[1] && n.issued <= p[2]).sort((a, b) => b.issued - a.issued)[0];
      return { rows: row ? [row] : [] };
    }
    if (sql.startsWith('UPDATE forecast_verification_records SET status = \'scored\'')) {
      Object.assign(records.get(p[0]), { status: 'scored', truth: JSON.parse(p[1]), scores: JSON.parse(p[2]), noaa_reference: p[3] && JSON.parse(p[3]), noaa_reason: p[4], scored_at: new Date(p[5] * 1000) });
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE forecast_verification_records SET status = \'unavailable\'')) {
      Object.assign(records.get(p[0]), { status: 'unavailable', unavailable_reason: sql.includes('no_shared_variable') ? 'no_shared_variable' : 'no_chain_reading_in_target_hour' });
      return { rows: [] };
    }
    if (sql.startsWith('UPDATE forecast_verification_records SET last_attempt_at')) { records.get(p[0]).attempts += 1; return { rows: [] }; }
    if (sql.startsWith('SELECT status, count(*)')) {
      const counts = new Map<string, number>();
      for (const r of records.values()) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
      return { rows: [...counts.entries()].map(([status, n]) => ({ status, n })) };
    }
    if (sql.startsWith('SELECT station_alias, scores')) return { rows: [...records.values()].filter((r) => r.status === 'scored') };
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  return { query, records, statements };
}

describe('scoring pass', () => {
  it('waits for the target hour to end, then scores against the chain readings and the NOAA capture', async () => {
    const db = fakeDb([{ station_id: STATION, valid: VALID, issued: ISSUED - 3600, temperature_c: 11, humidity_pct: 75, source: 'nws:test' }]);
    db.records.set(COMMIT, { commit_id: COMMIT, station_id: STATION, station_alias: 'st_000000000000', issued_at: new Date(ISSUED * 1000), valid_at: new Date(VALID * 1000),
      forecast_values: { temperature_c: 12.5, humidity_pct: 80.25 }, status: 'pending', submitted_at: new Date(), attempts: 0 });
    const get = fakeChain(5200, [
      { height: 5002, observed_at: VALID + 100, values: { temperature_c: 12, humidity_percent: 79 } },
      { height: 5030, observed_at: VALID + 2000, values: { temperature_c: 13, humidity_percent: 81 } },
    ]);
    expect(await scorePending({ query: db.query, get, nowSec: VALID + 3600 })).toEqual({ scored: 0, unavailable: 0, retry: 0 });
    expect(await scorePending({ query: db.query, get, nowSec: VALID + 2 * 3600 })).toEqual({ scored: 1, unavailable: 0, retry: 0 });
    const r = db.records.get(COMMIT);
    expect(r.status).toBe('scored');
    expect(r.truth).toMatchObject({ readings: 2, values: { temperature_c: 12.5, humidity_pct: 80 } });
    expect(r.scores.temperature_c).toEqual({ forecast: 12.5, truth: 12.5, error: 0, noaa: { value: 11, error: -1.5, leadHours: 7 } });
    expect(r.scores.humidity_pct).toEqual({ forecast: 80.25, truth: 80, error: 0.25, noaa: { value: 75, error: -5, leadHours: 7 } });
  });

  it('keeps a forecast pending while no reading landed, then marks it unavailable (never a guessed truth)', async () => {
    const db = fakeDb();
    db.records.set(COMMIT, { commit_id: COMMIT, station_id: STATION, station_alias: 'st_000000000000', issued_at: new Date(ISSUED * 1000), valid_at: new Date(VALID * 1000),
      forecast_values: { temperature_c: 12.5 }, status: 'pending', submitted_at: new Date(), attempts: 0 });
    const get = fakeChain(5200);
    expect(await scorePending({ query: db.query, get, nowSec: VALID + 2 * 3600 })).toEqual({ scored: 0, unavailable: 0, retry: 1 });
    expect(db.records.get(COMMIT).status).toBe('pending');
    expect(await scorePending({ query: db.query, get, nowSec: VALID + 13 * 3600 })).toEqual({ scored: 0, unavailable: 1, retry: 0 });
    expect(db.records.get(COMMIT)).toMatchObject({ status: 'unavailable', unavailable_reason: 'no_chain_reading_in_target_hour' });
  });

  it('leaves records pending when the node cannot be read', async () => {
    const db = fakeDb();
    db.records.set(COMMIT, { commit_id: COMMIT, station_id: STATION, station_alias: 'st_000000000000', issued_at: new Date(ISSUED * 1000), valid_at: new Date(VALID * 1000),
      forecast_values: { temperature_c: 12.5 }, status: 'pending', submitted_at: new Date(), attempts: 0 });
    const down: Core4Get = async () => { throw new Error('down'); };
    expect(await scorePending({ query: db.query, get: down, nowSec: VALID + 20 * 3600 })).toEqual({ scored: 0, unavailable: 0, retry: 1 });
    expect(db.records.get(COMMIT).status).toBe('pending');
  });
});

describe('NOAA reference capture', () => {
  it('stores the next 12 hours of NWS hourly forecast in degrees C, once per station per hour', async () => {
    const inserts: any[][] = [];
    let haveRow = false;
    const query: Query = async (sql, params = []) => {
      if (sql.includes('FROM weather_stations')) return { rows: [{ station_id: STATION, latitude: 46.8, longitude: -92.1 }] };
      if (sql.startsWith('SELECT 1 FROM forecast_verification_noaa_reference')) return { rows: haveRow ? [{}] : [] };
      if (sql.startsWith('INSERT INTO forecast_verification_noaa_reference')) { inserts.push(params as any[]); return { rows: [] }; }
      throw new Error(sql);
    };
    const now = ISSUED + 120;
    const hour = (h: number) => new Date((ISSUED + h * 3600) * 1000).toISOString();
    const noaa = { getHourlyForecast: async () => ({ forecastGenerator: 'HourlyForecastGenerator', periods: [
      { startTime: hour(0), temperature: 50, temperatureUnit: 'F', relativeHumidity: 60 }, // current hour: not a forecast
      { startTime: hour(1), temperature: 50, temperatureUnit: 'F', relativeHumidity: 60 },
      { startTime: hour(2), temperature: 10, temperatureUnit: 'C', relativeHumidity: null },
      { startTime: hour(13), temperature: 50, temperatureUnit: 'F', relativeHumidity: 60 }, // beyond 12 h
    ] }) };
    expect(await captureNoaaReferences(query, noaa, now)).toEqual({ stations: 1, rows: 2, failures: 0 });
    expect(inserts.map((p) => [p[2] - p[1], p[3], p[4], p[5]])).toEqual([[3600, 10, 60, 'nws:HourlyForecastGenerator'], [7200, 10, null, 'nws:HourlyForecastGenerator']]);
    expect(fahrenheitToC(32)).toBe(0);
    haveRow = true;
    expect(await captureNoaaReferences(query, noaa, now)).toEqual({ stations: 1, rows: 0, failures: 0 });
  });

  it('counts a station outside NWS coverage as a failure and stores nothing', async () => {
    const query: Query = async (sql) => (sql.includes('FROM weather_stations') ? { rows: [{ station_id: STATION, latitude: 51.5, longitude: -0.1 }] } : { rows: [] });
    const noaa = { getHourlyForecast: async () => { throw new Error('404'); } };
    expect(await captureNoaaReferences(query, noaa, ISSUED)).toEqual({ stations: 1, rows: 0, failures: 1 });
  });
});

describe('summary', () => {
  it('says unavailable with a reason when nothing has been scored', async () => {
    const s = await readSummary(fakeDb().query, VALID);
    expect(s).toMatchObject({ status: 'unavailable', counts: { pending: 0, scored: 0, unavailable: 0 } });
    expect(s.reason).toMatch(/No forecast has been scored/);
    expect(s.variables.map((v) => [v.variable, v.chain, v.vsNoaa])).toEqual([['temperature_c', null, null], ['pressure_hpa', null, null], ['humidity_pct', null, null]]);
    expect(s.variables[1].vsNoaaReason).toMatch(/pressure/);
  });

  it('compares with NOAA only over forecasts that have both', async () => {
    const db = fakeDb();
    const scored = (id: string, tErr: number, noaaErr: number | null) => db.records.set(id, { commit_id: id, station_id: STATION, station_alias: 'st_aaaaaaaaaaaa', status: 'scored',
      issued_at: new Date(ISSUED * 1000), valid_at: new Date(VALID * 1000), submitted_at: new Date(), forecast_values: {},
      scores: { temperature_c: { forecast: 0, truth: 0, error: tErr, noaa: noaaErr === null ? null : { value: 0, error: noaaErr, leadHours: 6 } } } });
    scored('a'.repeat(64), 1, -2);
    scored('b'.repeat(64), -3, null);
    const s = await readSummary(db.query, VALID);
    expect(s.status).toBe('available');
    expect(s.variables[0]).toMatchObject({ chain: { n: 2, mae: 2, bias: -1 }, vsNoaa: { n: 1, chainMae: 1, noaaMae: 2, chainBias: 1, noaaBias: -2 } });
    expect(s.stations).toEqual([{ stationAlias: 'st_aaaaaaaaaaaa', scored: 2, temperature: { n: 2, mae: 2, bias: -1, rmse: 2.2361 } }]);
    expect(JSON.stringify(s)).not.toContain(STATION);
  });
});

describe('public routes /api/forecast-verification', () => {
  const saved = { flag: process.env.FORECAST_VERIFICATION_ENABLED, token: process.env.WRFCOIN_READER_TOKEN };
  afterAll(() => {
    if (saved.flag === undefined) delete process.env.FORECAST_VERIFICATION_ENABLED; else process.env.FORECAST_VERIFICATION_ENABLED = saved.flag;
    if (saved.token === undefined) delete process.env.WRFCOIN_READER_TOKEN; else process.env.WRFCOIN_READER_TOKEN = saved.token;
  });
  beforeEach(() => { process.env.FORECAST_VERIFICATION_ENABLED = 'true'; process.env.WRFCOIN_READER_TOKEN = 'reader-token-for-tests'; });

  const statusOk = reply(200, { commit_id: COMMIT, station_id: STATION, contribution_type: 'forecast', status: 'revealed_attested', revealed_at: 4100, reward_finalized: false });
  const app = (db = fakeDb(), get: Core4Get = async () => statusOk) => {
    const a = express();
    a.use('/api/forecast-verification', createPublicForecastVerificationRouter({ query: db.query, get, rateLimit: (_q, _s, next) => next(), now: () => VALID * 1000 }));
    return { a, db };
  };

  it('is a 404 on every path while the flag is off', async () => {
    process.env.FORECAST_VERIFICATION_ENABLED = 'false';
    const { a } = app();
    expect((await request(a).get('/api/forecast-verification/summary')).status).toBe(404);
    expect((await request(a).post('/api/forecast-verification/forecasts').send(RECORD)).status).toBe(404);
    expect((await request(a).get(`/api/forecast-verification/forecasts/${COMMIT}`)).status).toBe(404);
  });

  it('takes a valid revealed record once, names the station by alias only, and serves it back', async () => {
    const { a, db } = app();
    const first = await request(a).post('/api/forecast-verification/forecasts').send(RECORD);
    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({ commitId: COMMIT, status: 'pending', forecast: { temperature_c: 12.5, humidity_pct: 80.25 }, horizonHours: 6,
      validAt: new Date(VALID * 1000).toISOString(), truth: null, scores: null });
    expect(first.body.stationAlias).toMatch(/^st_[0-9a-f]{12}$/);
    expect(JSON.stringify(first.body)).not.toContain(STATION);
    expect((await request(a).post('/api/forecast-verification/forecasts').send(RECORD)).status).toBe(200);
    expect(db.records.size).toBe(1);
    const read = await request(a).get(`/api/forecast-verification/forecasts/${COMMIT}`);
    expect(read.status).toBe(200);
    expect(read.headers['cache-control']).toBe('no-store');
    expect((await request(a).get(`/api/forecast-verification/forecasts/${'0'.repeat(64)}`)).status).toBe(404);
    expect((await request(a).get('/api/forecast-verification/forecasts/nothex')).status).toBe(400);
  });

  it('refuses a record that does not hash to the commit, is not on chain, or is not revealed yet', async () => {
    expect((await request(app().a).post('/api/forecast-verification/forecasts').send({ ...RECORD, nonce: 'kit-x' })).body.error.code).toBe('COMMIT_MISMATCH');
    const notFound = await request(app(fakeDb(), async () => reply(404, {})).a).post('/api/forecast-verification/forecasts').send(RECORD);
    expect([notFound.status, notFound.body.error.code]).toEqual([404, 'NOT_ON_CHAIN']);
    const pending = await request(app(fakeDb(), async () => reply(200, { commit_id: COMMIT, station_id: STATION, contribution_type: 'forecast', status: 'committed_pending_reveal' })).a)
      .post('/api/forecast-verification/forecasts').send(RECORD);
    expect([pending.status, pending.body.error.code]).toEqual([409, 'NOT_REVEALED']);
    const down = await request(app(fakeDb(), async () => { throw new Error('x'); }).a).post('/api/forecast-verification/forecasts').send(RECORD);
    expect(down.status).toBe(502);
  });

  it('caps node checks for new records process-wide', async () => {
    const db = fakeDb();
    let calls = 0;
    const { a } = app(db, async () => { calls += 1; return reply(404, {}); });
    for (let i = 0; i < 30; i += 1) await request(a).post('/api/forecast-verification/forecasts').send(RECORD);
    const capped = await request(a).post('/api/forecast-verification/forecasts').send(RECORD);
    expect([capped.status, capped.body.error.code, calls]).toEqual([503, 'UPSTREAM_BUDGET_EXHAUSTED', 30]);
    expect(Number(capped.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('serves the summary', async () => {
    const res = await request(app().a).get('/api/forecast-verification/summary');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ windowDays: 30, status: 'unavailable', recent: [] });
  });
});

describe('capabilities: forecastVerification', () => {
  const saved = process.env.FORECAST_VERIFICATION_ENABLED;
  afterAll(() => { if (saved === undefined) delete process.env.FORECAST_VERIFICATION_ENABLED; else process.env.FORECAST_VERIFICATION_ENABLED = saved; });

  it('is unavailable (not_wired) while off and configured (unverified, never operational) when on', async () => {
    const { createCapabilitiesRouter } = require('../server/routes/capabilities-routes');
    const a = express();
    a.use('/api', createCapabilitiesRouter());
    process.env.FORECAST_VERIFICATION_ENABLED = 'false';
    expect((await request(a).get('/api/capabilities')).body.features.forecastVerification).toEqual({ status: 'unavailable', reasonCode: 'not_wired' });
    process.env.FORECAST_VERIFICATION_ENABLED = 'true';
    expect((await request(a).get('/api/capabilities')).body.features.forecastVerification).toEqual({ status: 'configured', reasonCode: 'unverified' });
  });
});

// ---------------------------------------------------------------------------------------------------
// Real PostgreSQL (CI exports BACKFILL_TEST_PG_URL): the migration applies twice, and the statements the
// job and the routes issue run against it unchanged.
// ---------------------------------------------------------------------------------------------------
const PG_URL = process.env.BACKFILL_TEST_PG_URL;
(PG_URL ? describe : describe.skip)('0039_forecast_verification on real PostgreSQL', () => {
  const postgres = require('postgres');
  const { readFileSync } = require('node:fs');
  const schema = `fv_0039_${process.pid}`;
  let sql: any;
  let query: Query;

  beforeAll(async () => {
    sql = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    await sql.unsafe('CREATE TABLE weather_stations (station_id text NOT NULL UNIQUE, latitude double precision, longitude double precision)');
    const migration = readFileSync('drizzle/migrations/0039_forecast_verification.sql', 'utf8');
    for (let i = 0; i < 2; i += 1) {
      for (const statement of migration.split('--> statement-breakpoint')) await sql.unsafe(statement);
    }
    query = async (text, params = []) => ({ rows: await sql.unsafe(text, params as any[]) });
  });
  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });

  it('stores a record, captures NOAA, scores it, and reads it back as the routes do', async () => {
    process.env.FORECAST_VERIFICATION_ENABLED = 'true';
    const a = express();
    a.use('/api/forecast-verification', createPublicForecastVerificationRouter({ query, rateLimit: (_q, _s, next) => next(), now: () => VALID * 1000,
      get: async () => reply(200, { commit_id: COMMIT, station_id: STATION, contribution_type: 'forecast', status: 'revealed_attested', revealed_at: 4100 }) }));
    expect((await request(a).post('/api/forecast-verification/forecasts').send(RECORD)).status).toBe(201);

    await query('INSERT INTO weather_stations (station_id, latitude, longitude) VALUES ($1, 46.8, -92.1)', [STATION]);
    const noaa = { getHourlyForecast: async () => ({ forecastGenerator: 'g', periods: [{ startTime: new Date(VALID * 1000).toISOString(), temperature: 50, temperatureUnit: 'F', relativeHumidity: 70 }] }) };
    // Captured at the hour the forecast was issued (the fallback station query: no forecast index tables here).
    expect(await captureNoaaReferences(query, noaa, ISSUED)).toEqual({ stations: 1, rows: 1, failures: 0 });

    const get = fakeChain(5200, [{ height: 5002, observed_at: VALID + 100, values: { temperature_c: 12, humidity_percent: 79 } }]);
    expect(await scorePending({ query, get, nowSec: VALID + 2 * 3600 })).toEqual({ scored: 1, unavailable: 0, retry: 0 });
    const read = await request(a).get(`/api/forecast-verification/forecasts/${COMMIT}`);
    expect(read.body).toMatchObject({ status: 'scored', truth: { readings: 1 }, noaa: { source: 'nws:g', leadHours: 6 },
      scores: { temperature_c: { forecast: 12.5, truth: 12, error: 0.5, noaa: { value: 10, error: -2, leadHours: 6 } } } });
    const summary = (await request(a).get('/api/forecast-verification/summary')).body;
    expect(summary).toMatchObject({ status: 'available', counts: { scored: 1 } });
    expect(summary.variables[0].vsNoaa).toEqual({ n: 1, chainMae: 0.5, noaaMae: 2, chainBias: 0.5, noaaBias: -2 });
  });
});
