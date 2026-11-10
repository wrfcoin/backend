/**
 * Practice scores for website forecasts: the integer skill rule against its shared vectors
 * (contract-fixtures/forecast-skill-vectors.json, the file a second implementation is checked against),
 * the scoring pass over a fake node, and what the read routes return. The node is a fake. The storage
 * flow runs on real PostgreSQL when CI exports BACKFILL_TEST_PG_URL.
 */
import express from 'express';
import request from 'supertest';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import {
  LANDING_MARGIN_S, MIN_PERSISTENCE_PAIRS, MIN_WINDOW_SAMPLES, TRUTH_MAX_DISTANCE_S, countsAsReading, hourlyWindow, inRange, isqrt, lastReadingBefore,
  nearestReading, numberToFixedPoint, parseFixedPoint, ratioSkill, referenceFromWindow, skillScore, truthCandidates, windowCandidates,
  type ChainSample, type Reading, type ScoredVariable,
} from '../server/services/forecast-score/practice-score';
import {
  BACKOFF_BASE_MS, GIVE_UP_S, PRACTICE_NOTE, SCORE_DELAY_S, newPaceState, publicPracticeScore, readPracticeScores, readsPerMinute, scoreWebsiteForecasts,
  websiteForecastScoreEnabled,
} from '../server/services/forecast-score/practice-score-job';
import { reserveNodeReads, type NodeReadClock } from '../server/services/node-read-pacer.js';
import { createWebsiteForecastRouter } from '../server/routes/website-forecast-routes';
import { createPublicForecastVerificationRouter } from '../server/routes/forecast-verification-routes';
import { listMine } from '../server/services/website-forecast/website-forecast-store';
import type { Core4Get } from '../server/services/forecast-commit-record';
import type { Query } from '../server/services/forecast-verification/observed-verification';

const vectors = JSON.parse(readFileSync('contract-fixtures/forecast-skill-vectors.json', 'utf8'));
const big = (v: number | null) => (v === null ? null : BigInt(v));
const toReading = (r: any): Reading => ({ observedAt: r.observed_at, value: BigInt(r.value), id: r.id });
const fromReading = (r: Reading | null) => (r === null ? null : { observed_at: r.observedAt, value: Number(r.value), id: r.id });
const named = (list: any[]) => list.map((v: any) => [v.name, v] as [string, any]);

describe('integer skill rule against the shared vectors (schema v3)', () => {
  it('has the expected file shape and constants', () => {
    expect(vectors.schema).toBe('wrfcoin-forecast-skill-vectors/v3');
    expect([vectors.precision, vectors.default_tol, vectors.min_window_samples, vectors.min_persistence_pairs]).toEqual([1_000_000, 5, MIN_WINDOW_SAMPLES, MIN_PERSISTENCE_PAIRS]);
    expect([vectors.truth_max_distance_s, vectors.landing_margin_s, vectors.score_delay_s]).toEqual([TRUTH_MAX_DISTANCE_S, LANDING_MARGIN_S, SCORE_DELAY_S]);
    expect(SCORE_DELAY_S).toBe(35 * 60);
    expect(['range', 'rule3_scenarios', 'skill', 'skill_wide_arithmetic', 'reference', 'hourly_window', 'nearest_reading', 'last_reading_before', 'fixed_point']
      .map((k) => vectors[k].length)).toEqual([11, 10, 47, 2, 33, 7, 8, 5, 37]);
    // The rule text is the contract: the pinned points must be in it.
    const rule = vectors.rule.join('\n');
    for (const pinned of ['AS OF the closing block', '[target - 15 min, target + 35 min)', 'height < commit_height', 'not \'synthetic\' (no class recorded', 'back-dated or future-dated', 'fits i64']) {
      expect(rule).toContain(pinned);
    }
  });

  it('every case in the skill section is inside its variable\'s range, so a twin that range-checks inside its score function passes them all', () => {
    for (const v of vectors.skill) {
      for (const k of ['forecast', 'truth', 'mean24', 'last']) expect(inRange(v.variable as ScoredVariable, BigInt(v[k]))).toBe(true);
    }
    for (const v of vectors.skill_wide_arithmetic) expect(inRange('pressure_hpa', BigInt(v.forecast))).toBe(false);
  });

  it.each(named(vectors.rule3_scenarios))('rule 3 (which readings count): %s', (_name, v: any) => {
    const samples: ChainSample[] = v.readings.map((r: any) => ({
      id: r.id, observedAt: r.observed_at, value: BigInt(r.value), height: r.height, blockTime: r.block_time, hasQuorum: r.has_quorum, provenance: r.provenance,
    }));
    const truth = truthCandidates(samples, v.variable, v.target);
    const window = windowCandidates(samples, v.variable, v.commit_time, v.commit_height);
    expect(v.target).toBe(v.commit_time + v.lead_hours * 3600);
    expect({
      truth_candidates: truth.map((r) => r.id).sort(), truth: nearestReading(truth, v.target)?.id ?? null,
      window_candidates: window.map((r) => r.id).sort(), last: lastReadingBefore(window, v.commit_time)?.id ?? null,
      window: hourlyWindow(window, v.commit_time).map((x) => (x === null ? null : Number(x))),
    }).toEqual(v.expect);
  });

  it('a reading counts only with quorum, a provenance that is not synthetic, and a value in range', () => {
    const ok = { value: 1500n, hasQuorum: true, provenance: 'real' as string | null };
    expect(countsAsReading('temperature_c', ok)).toBe(true);
    expect(countsAsReading('temperature_c', { ...ok, provenance: null })).toBe(true);
    expect(countsAsReading('temperature_c', { ...ok, provenance: 'synthetic' })).toBe(false);
    expect(countsAsReading('temperature_c', { ...ok, hasQuorum: false })).toBe(false);
    expect(countsAsReading('temperature_c', { ...ok, value: 10_001n })).toBe(false);
    expect(countsAsReading('pressure_hpa', ok)).toBe(false);
  });

  it.each(vectors.range.map((v: any) => [`${v.variable} ${v.value}`, v]))('range: %s', (_n, v: any) => {
    expect(inRange(v.variable as ScoredVariable, BigInt(v.value))).toBe(v.expect);
  });

  it.each(named([...vectors.skill, ...vectors.skill_wide_arithmetic]))('skill: %s', (_name, v: any) => {
    const r = skillScore({ forecast: BigInt(v.forecast), truth: BigInt(v.truth), reference: BigInt(v.reference), mean24: BigInt(v.mean24), last: BigInt(v.last), tol: BigInt(v.tol) });
    expect({ err: Number(r.err), copy: r.copy, skill: Number(r.skill), beat_baseline: r.beatBaseline }).toEqual(v.expect);
  });

  it.each(named(vectors.reference))('reference: %s', (_name, v: any) => {
    const r = referenceFromWindow(v.window.map(big), v.lag);
    expect(r === null ? null : {
      samples: r.samples, mean24: Number(r.mean24), spread: Number(r.spread), pairs: r.pairs, persistence: r.persistence === null ? null : Number(r.persistence),
      reference: Number(r.reference), kind: r.kind,
    }).toEqual(v.expect);
  });

  it.each(named(vectors.hourly_window))('hourly window: %s', (_name, v: any) => {
    expect(hourlyWindow(v.readings.map(toReading), v.anchor).map((x) => (x === null ? null : Number(x)))).toEqual(v.expect);
  });

  it.each(named(vectors.nearest_reading))('nearest reading: %s', (_name, v: any) => {
    expect(fromReading(nearestReading(v.readings.map(toReading), v.target))).toEqual(v.expect);
  });

  it.each(named(vectors.last_reading_before))('last reading before: %s', (_name, v: any) => {
    expect(fromReading(lastReadingBefore(v.readings.map(toReading), v.anchor))).toEqual(v.expect);
  });

  it.each(vectors.fixed_point.map((v: any) => [JSON.stringify(v.text), v]))('fixed point (backend adapter): %s', (_n, v: any) => {
    const r = parseFixedPoint(v.text);
    expect(r === null ? null : Number(r)).toBe(v.expect);
  });

  it('uses the default tolerance of 5 when none is given', () => {
    expect(skillScore({ forecast: 1805n, truth: 1805n, reference: 250n, mean24: 1800n, last: 0n }).copy).toBe(true);
    expect(skillScore({ forecast: 1806n, truth: 1806n, reference: 250n, mean24: 1800n, last: 0n }).skill).toBe(1_000_000n);
  });

  it('turns JSON numbers into fixed point through their text, never through floating-point arithmetic', () => {
    expect(numberToFixedPoint(0.1 + 0.2)).toBe(30n);
    expect(numberToFixedPoint(1.005)).toBe(101n); // the text "1.005", not the binary value just below it
    expect(numberToFixedPoint(-0)).toBe(0n);
    expect(numberToFixedPoint(1e-7)).toBeNull();
    expect(numberToFixedPoint(1e21)).toBeNull();
    expect(numberToFixedPoint(Number.NaN)).toBeNull();
    expect(numberToFixedPoint('12.3')).toBeNull();
  });

  it('isqrt is the floor square root, exact past 2^53; bad arguments are refused', () => {
    for (const [n, r] of [[0n, 0n], [1n, 1n], [3n, 1n], [4n, 2n], [43125n, 207n], [10n ** 30n, 10n ** 15n], [10n ** 30n - 1n, 10n ** 15n - 1n]]) expect(isqrt(n)).toBe(r);
    expect(() => isqrt(-1n)).toThrow();
    expect(() => ratioSkill(-1n, 5n)).toThrow();
    expect(() => ratioSkill(1n, -5n)).toThrow();
    expect(() => skillScore({ forecast: 1n, truth: 1n, reference: 1n, mean24: 0n, last: 0n, tol: -1n })).toThrow();
    expect(() => referenceFromWindow(Array(24).fill(1n), 0)).toThrow();
    expect(() => referenceFromWindow(Array(24).fill(1n), 1.5)).toThrow();
  });

  it('ignores a reading whose time is not a whole number of seconds', () => {
    const odd = [{ observedAt: Number.NaN, value: 1n, id: 'a' }, { observedAt: 1.5e300, value: 2n, id: 'b' }, { observedAt: 1_800_000_000.5, value: 3n, id: 'c' }];
    expect(nearestReading(odd, 1_800_000_000)).toBeNull();
    expect(lastReadingBefore(odd, 1_800_000_001)).toBeNull();
    expect(hourlyWindow(odd, 1_800_000_001).every((x) => x === null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------
// A fake node: blocks every 77 s; a reading lands in the first block at least 150 s after it is observed
// (or `landDelay` seconds after), and has reached quorum unless said otherwise.
// ---------------------------------------------------------------------------------------------------
const STATION = 'PWS-TEST-ALPHA-01';
const BLOCK_S = 77;
const GENESIS = 1_800_000_000;
const COMMIT_HEIGHT = 1500;
const COMMITTED_AT = GENESIS + COMMIT_HEIGHT * BLOCK_S;
const LEAD = 6;
const VALID_AT = COMMITTED_AT + LEAD * 3600;
const COMMIT_ID = 'c1'.repeat(32);

interface Obs { observedAt: number; values: Record<string, number>; provenance?: string | null; quorum?: boolean | null; landDelay?: number }
const landing = (o: Obs) => Math.ceil((o.observedAt + (o.landDelay ?? 150) - GENESIS) / BLOCK_S);

function fakeNode(tipHeight: number, readings: Obs[], opts: { fail?: boolean; busyAfter?: number; clock?: () => number } = {}) {
  const calls = { blocks: 0, observations: 0 };
  /** When each request reached the node (the test's clock), and its path. */
  const log: Array<{ at: number; path: string }> = [];
  const get: Core4Get = async (path, query) => {
    log.push({ at: opts.clock ? opts.clock() : 0, path });
    if (opts.busyAfter !== undefined && log.length > opts.busyAfter) return { ok: false, status: 429, payload: null };
    if (opts.fail) return { ok: false, status: 503, payload: null };
    if (path === '/blockchain') return { ok: true, status: 200, payload: { height: tipHeight } };
    const block = /^\/chain\/block\/(\d+)$/.exec(path);
    if (block) {
      calls.blocks += 1;
      const height = Number(block[1]);
      return { ok: true, status: 200, payload: { height, timestamp: new Date((GENESIS + height * BLOCK_S) * 1000).toISOString() } };
    }
    if (path === `/transactions/contributions/${STATION}/observations`) {
      calls.observations += 1;
      const after = Number(query?.after ?? 0);
      const next = Math.min(after + 64, tipHeight);
      const items = readings.map((o, i) => ({ o, i, height: landing(o) })).filter((x) => x.height > after && x.height <= next)
        .map((x) => ({ commit_id: `obs-${String(x.i).padStart(5, '0')}`, station_id: STATION, height: x.height, observed_at: x.o.observedAt, values: x.o.values,
          provenance_class: x.o.provenance === undefined ? 'real' : x.o.provenance,
          attestation: x.o.quorum === undefined ? { approvals: 2, has_quorum: true } : x.o.quorum === null ? null : { approvals: x.o.quorum ? 2 : 1, has_quorum: x.o.quorum } }));
      return { ok: true, status: 200, payload: { ok: true, data: { items, next_after: next, next_offset: 0, has_more: next < tipHeight } } };
    }
    return { ok: false, status: 404, payload: null };
  };
  return { get, calls, log };
}

/** A steady ramp: a reading every 10 minutes from 24 h before the commit, 0.05 °C warmer each time, starting at 10.00 °C. */
function ramp(until = VALID_AT + 3600, skip: (j: number) => boolean = () => false): Obs[] {
  const out: Obs[] = [];
  for (let j = 0; COMMITTED_AT - 86_400 + j * 600 <= until; j += 1) {
    if (skip(j)) continue;
    out.push({ observedAt: COMMITTED_AT - 86_400 + j * 600, values: { temperature_c: (1000 + 5 * j) / 100, pressure_hpa: 1013.25 } });
  }
  return out;
}
const tipAt = (time: number) => Math.floor((time - GENESIS) / BLOCK_S);
/** A clock the pacing sleeps on: waiting costs no real time. */
function fast() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => { t += ms; }, advance: (ms: number) => { t += ms; } };
}

type Saved = Record<string, any>;
function fakeStore(rows: any[], opts: { nws?: any[]; failSave?: boolean } = {}) {
  const saved: Saved[] = [];
  const sqls: string[] = [];
  const nwsParams: unknown[][] = [];
  const query: Query = async (sql, params = []) => {
    sqls.push(sql);
    if (sql.includes('FROM website_forecasts w LEFT JOIN website_forecast_scores')) return { rows };
    const insert = /INSERT INTO website_forecast_scores \(([^)]+)\)/.exec(sql);
    if (insert) {
      if (opts.failSave) throw new Error('database is down');
      const columns = insert[1].split(',').map((c) => c.trim());
      expect(columns.slice(-2)).toEqual(['attempts', 'scored_at']);
      expect(params.length).toBe(columns.length - 1); // attempts is a literal
      const row: Saved = {};
      columns.slice(0, -2).forEach((c, i) => { row[c] = params[i]; });
      row.scored_at = params[params.length - 1];
      saved.push(row);
      return { rows: [] };
    }
    if (sql.includes('forecast_verification_noaa_reference')) { nwsParams.push(params); return { rows: opts.nws ?? [] }; }
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  return { query, saved, sqls, nwsParams };
}
const forecastRow = (over: Record<string, unknown> = {}) => ({
  commit_id: COMMIT_ID, station_id: STATION, variable: 'temperature_c', value: 18.1, horizon_hours: LEAD, committed_at_height: String(COMMIT_HEIGHT),
  issued: String(COMMITTED_AT - 120), valid: String(COMMITTED_AT - 120 + LEAD * 3600), ...over,
});
const pick = (row: Saved, keys: string[]) => keys.map((k) => row[k]);

describe('scoring pass', () => {
  const NOW = VALID_AT + SCORE_DELAY_S + 600;

  it('scores a forecast by the integer rule: truth, reference from the station\'s own 24 hours, skill, beat the baseline', async () => {
    const store = fakeStore([forecastRow()], { nws: [{ issued: String(Math.floor(VALID_AT / 3600) * 3600 - 7 * 3600), temperature_c: 18.4 }] });
    const node = fakeNode(tipAt(NOW), ramp());
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: node.get, nowSec: NOW }))
      .toMatchObject({ scored: 1, unscored: 0, waiting: 0, retry: 0, skipped: 0, saveErrors: 0, nodeBusy: false, backingOff: false });
    expect(store.saved.length).toBe(1);
    const p = store.saved[0];
    // Hourly means 1012 + 30k (k = 0..23): mean 1357, spread isqrt(43125) = 207, 6 h persistence 180 (the smaller one).
    expect(pick(p, ['commit_id', 'status', 'reason', 'unit', 'valid_at', 'valid_at_source'])).toEqual([COMMIT_ID, 'scored', null, 'temp_c_centi', VALID_AT, 'chain']);
    expect(pick(p, ['forecast_fp', 'truth_fp', 'truth_observed_at', 'err_fp'])).toEqual(['1810', '1900', VALID_AT, '90']);
    // The truth reading is named: reading j = 180 of the ramp, and the block it landed in.
    expect(pick(p, ['truth_commit_id', 'truth_height'])).toEqual(['obs-00180', Math.ceil((VALID_AT + 150 - GENESIS) / BLOCK_S)]);
    expect(pick(p, ['ref_fp', 'ref_kind', 'mean24_fp', 'last_fp', 'window_samples', 'tol'])).toEqual(['180', 'persistence_spread', '1357', '1715', 24, 5]);
    expect(pick(p, ['copied', 'skill', 'beat_baseline'])).toEqual([false, 500_000, true]);
    // NOAA's forecast for that hour, captured before the commit: 18.4 °C, off by 0.60, skill 1e6 − 1e6·60/180.
    expect(pick(p, ['nws_fp', 'nws_err_fp', 'nws_skill', 'nws_lead_hours'])).toEqual(['1840', '60', 666_667, 7]);
    expect(pick(p, ['last_attempt_at', 'scored_at'])).toEqual([NOW, NOW]);
    // The NOAA capture must itself be older than the commit time, not just its hour.
    expect(store.sqls.find((q) => q.includes('forecast_verification_noaa_reference'))).toMatch(/captured_at < to_timestamp\(\$3\)/);
    expect(store.nwsParams[0]).toEqual([STATION, Math.floor(VALID_AT / 3600) * 3600, COMMITTED_AT]);
  });

  it('zeroes a copy of the last reading', async () => {
    const store = fakeStore([forecastRow({ value: 17.2 })]);
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), ramp()).get, nowSec: NOW });
    expect(pick(store.saved[0], ['forecast_fp', 'last_fp', 'copied', 'skill', 'beat_baseline'])).toEqual(['1720', '1715', true, 0, false]);
  });

  it('scores pressure in Pa; a flat station has a zero reference and nobody beats it', async () => {
    const store = fakeStore([forecastRow({ variable: 'pressure_hpa', value: 1013.3 })]);
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), ramp()).get, nowSec: NOW });
    expect(pick(store.saved[0], ['unit', 'forecast_fp', 'truth_fp', 'err_fp', 'ref_fp', 'skill', 'beat_baseline', 'nws_fp'])).toEqual(['pressure_pa', '101330', '101325', '5', '0', 0, false, null]);
  });

  it('does not score before the chain tip has reached target + 35 minutes, whatever the wall clock says', async () => {
    const store = fakeStore([forecastRow()]);
    const early = VALID_AT + SCORE_DELAY_S - 1;
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(early), ramp()).get, nowSec: early })).toMatchObject({ waiting: 1, scored: 0 });
    // The clock is past, the chain is not (20 minutes after the target, the old threshold): still waiting.
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(VALID_AT + 20 * 60), ramp()).get, nowSec: NOW })).toMatchObject({ waiting: 1, scored: 0 });
    expect(store.saved).toEqual([]);
  });

  it('the truth does not depend on when the scorer runs: a reading that lands late is still the one chosen', async () => {
    // Observed one minute after the target, but it takes 25 minutes to land. The 10-minute readings around it land promptly.
    const late: Obs = { observedAt: VALID_AT + 60, values: { temperature_c: 19.4 }, landDelay: 25 * 60 };
    const readings = [...ramp().filter((o) => o.observedAt !== VALID_AT), late];
    // Run exactly when it first may run, and again hours later: the same truth both times.
    for (const at of [VALID_AT + SCORE_DELAY_S, VALID_AT + 5 * 3600]) {
      const store = fakeStore([forecastRow()]);
      expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(at) + 1, readings).get, nowSec: at + BLOCK_S })).toMatchObject({ scored: 1 });
      expect(pick(store.saved[0], ['truth_fp', 'truth_observed_at', 'truth_commit_id'])).toEqual(['1940', VALID_AT + 60, `obs-${String(readings.length - 1).padStart(5, '0')}`]);
    }
    // A reading that lands after target + 35 minutes is never a candidate, even when the scorer runs much later.
    const tooLate = [...ramp().filter((o) => o.observedAt !== VALID_AT), { ...late, landDelay: 40 * 60 }];
    const store = fakeStore([forecastRow()]);
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(VALID_AT + 5 * 3600), tooLate).get, nowSec: VALID_AT + 5 * 3600 });
    expect(pick(store.saved[0], ['truth_fp', 'truth_observed_at'])).toEqual(['1895', VALID_AT - 600]);
  });

  it('the baseline and the copy check use only readings that had landed before the commit', async () => {
    // A back-dated reading equal to the forecast: "observed" a minute before the commit, landed 10 minutes after it.
    const backdated: Obs = { observedAt: COMMITTED_AT - 60, values: { temperature_c: 18.1 }, landDelay: 660 };
    expect(landing(backdated)).toBeGreaterThan(COMMIT_HEIGHT);
    const store = fakeStore([forecastRow()]);
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), [...ramp(), backdated]).get, nowSec: NOW });
    // Had it counted, `last` would be 1810 and the forecast a copy with skill 0.
    expect(pick(store.saved[0], ['last_fp', 'mean24_fp', 'copied', 'skill'])).toEqual(['1715', '1357', false, 500_000]);
    // A reading with the same value that had landed two blocks before the commit does count.
    const early: Obs = { observedAt: COMMITTED_AT - 300, values: { temperature_c: 18.1 }, landDelay: 100 };
    expect(landing(early)).toBe(COMMIT_HEIGHT - 2);
    const seen = fakeStore([forecastRow()]);
    await scoreWebsiteForecasts({ ...fast(), query: seen.query, get: fakeNode(tipAt(NOW), [...ramp(), early]).get, nowSec: NOW });
    expect(pick(seen.saved[0], ['last_fp', 'copied', 'skill'])).toEqual(['1810', true, 0]);
    // A reading landing exactly in the commit's block is not below it.
    const atCommit: Obs = { ...backdated, landDelay: 60 };
    expect(landing(atCommit)).toBe(COMMIT_HEIGHT);
    const edge = fakeStore([forecastRow()]);
    await scoreWebsiteForecasts({ ...fast(), query: edge.query, get: fakeNode(tipAt(NOW), [...ramp(), atCommit]).get, nowSec: NOW });
    expect(pick(edge.saved[0], ['last_fp', 'copied'])).toEqual(['1715', false]);
  });

  it('no reading within 15 minutes: pending, then unscored after 24 hours; never a made-up truth', async () => {
    // Readings stop 30 minutes before the target time and resume 30 minutes after.
    const gap = ramp(VALID_AT + 86_400 + 7200, (j) => j >= 178 && j <= 182);
    const store = fakeStore([forecastRow()]);
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), gap).get, nowSec: NOW })).toMatchObject({ scored: 0, unscored: 0, waiting: 1, retry: 0 });
    expect(pick(store.saved[0], ['status', 'reason', 'truth_fp', 'skill', 'scored_at'])).toEqual(['pending', null, null, null, null]);
    const late = VALID_AT + GIVE_UP_S + 60;
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(late), gap).get, nowSec: late })).toMatchObject({ scored: 0, unscored: 1, waiting: 0, retry: 0 });
    expect(pick(store.saved[1], ['status', 'reason', 'truth_fp', 'skill', 'scored_at'])).toEqual(['unscored', 'no_reading', null, null, late]);
  });

  it('never scores against synthetic or out-of-range readings', async () => {
    const store = fakeStore([forecastRow()]);
    const synthetic = ramp().map((o) => ({ ...o, provenance: 'synthetic' }));
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), synthetic).get, nowSec: NOW })).toMatchObject({ scored: 0, waiting: 1 });
    expect(store.saved[0].status).toBe('pending');
    // The reading at the target says 500 °C: ignored, the next nearest is used.
    const absurd = ramp().map((o) => (o.observedAt === VALID_AT ? { ...o, values: { temperature_c: 500 } } : o));
    const next = fakeStore([forecastRow()]);
    await scoreWebsiteForecasts({ ...fast(), query: next.query, get: fakeNode(tipAt(NOW), absurd).get, nowSec: NOW });
    expect(pick(next.saved[0], ['status', 'truth_fp'])).toEqual(['scored', '1895']);
  });

  it('only readings that reached the attestation quorum count as truth', async () => {
    // The reading exactly at the target time has no quorum; the next nearest (10 minutes earlier, 18.95 °C) has.
    const mixed = ramp().map((o) => (o.observedAt === VALID_AT ? { ...o, quorum: false } : o));
    const store = fakeStore([forecastRow()]);
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), mixed).get, nowSec: NOW })).toMatchObject({ scored: 1 });
    expect(pick(store.saved[0], ['truth_fp', 'truth_observed_at', 'err_fp'])).toEqual(['1895', VALID_AT - 600, '85']);
    // Readings within 15 minutes exist, but none has quorum (one has no attestation at all): waiting, then unscored.
    const none = ramp(VALID_AT + 86_400 + 7200).map((o) => (Math.abs(o.observedAt - VALID_AT) <= 900 ? { ...o, quorum: o.observedAt === VALID_AT ? null : false } : o));
    const waiting = fakeStore([forecastRow()]);
    expect(await scoreWebsiteForecasts({ ...fast(), query: waiting.query, get: fakeNode(tipAt(NOW), none).get, nowSec: NOW })).toMatchObject({ scored: 0, waiting: 1 });
    expect(pick(waiting.saved[0], ['status', 'truth_fp'])).toEqual(['pending', null]);
    const late = VALID_AT + GIVE_UP_S + 60;
    expect(await scoreWebsiteForecasts({ ...fast(), query: waiting.query, get: fakeNode(tipAt(late), none).get, nowSec: late })).toMatchObject({ unscored: 1 });
    expect(pick(waiting.saved[1], ['status', 'reason'])).toEqual(['unscored', 'no_reading']);
  });

  it('the reference window also uses quorum readings only, and needs at least 12 hourly samples', async () => {
    // Before the commit only the readings on the hour have quorum: 24 hourly samples 1000 + 30k instead of the means 1012 + 30k.
    const sparse = ramp().map((o) => (o.observedAt < COMMITTED_AT && (o.observedAt - (COMMITTED_AT - 86_400)) % 3600 !== 0 ? { ...o, quorum: false } : o));
    const store = fakeStore([forecastRow()]);
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), sparse).get, nowSec: NOW });
    expect(pick(store.saved[0], ['status', 'mean24_fp', 'last_fp', 'ref_fp', 'window_samples', 'skill'])).toEqual(['scored', '1345', '1690', '180', 24, 500_000]);
    // Readings only in the last 11 hours before the commit: no baseline, with the truth it found.
    const short = ramp().filter((o) => o.observedAt >= COMMITTED_AT - 11 * 3600);
    const none = fakeStore([forecastRow()]);
    expect(await scoreWebsiteForecasts({ ...fast(), query: none.query, get: fakeNode(tipAt(NOW), short).get, nowSec: NOW })).toMatchObject({ unscored: 1 });
    expect(pick(none.saved[0], ['status', 'reason', 'truth_fp', 'truth_commit_id', 'skill'])).toEqual(['unscored', 'no_baseline', '1900', expect.stringMatching(/^obs-/), null]);
    // Twelve hours is enough.
    const enough = fakeStore([forecastRow()]);
    await scoreWebsiteForecasts({ ...fast(), query: enough.query, get: fakeNode(tipAt(NOW), ramp().filter((o) => o.observedAt >= COMMITTED_AT - 12 * 3600)).get, nowSec: NOW });
    expect(pick(enough.saved[0], ['status', 'window_samples'])).toEqual(['scored', 12]);
  });

  it('a forecast outside the scored range is unscored with that reason; a row it cannot read is counted, not dropped', async () => {
    const store = fakeStore([forecastRow({ value: 150 }), forecastRow({ commit_id: 'c2'.repeat(32), variable: 'humidity_pct' }), forecastRow({ commit_id: 'c3'.repeat(32), horizon_hours: 0 })]);
    const node = fakeNode(tipAt(NOW), ramp());
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: node.get, nowSec: NOW })).toMatchObject({ unscored: 1, skipped: 2, scored: 0 });
    expect(store.saved.length).toBe(1);
    expect(pick(store.saved[0], ['status', 'reason', 'forecast_fp', 'scored_at'])).toEqual(['unscored', 'out_of_range', null, NOW]);
  });

  it('falls back to the draft target time when the commit height is unknown', async () => {
    const store = fakeStore([forecastRow({ committed_at_height: null })]);
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), ramp()).get, nowSec: NOW });
    expect(pick(store.saved[0], ['status', 'valid_at', 'valid_at_source'])).toEqual(['scored', COMMITTED_AT - 120 + LEAD * 3600, 'draft']);
  });

  it('a node that cannot answer: pending with its own reason, then unscored after 24 hours', async () => {
    const store = fakeStore([forecastRow()]);
    // Not even the tip: nothing is known, nothing is marked.
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), ramp(), { fail: true }).get, nowSec: NOW })).toMatchObject({ scored: 0, retry: 1, nodeBusy: false });
    expect(store.saved).toEqual([]);
    // The tip answers but the readings do not.
    const node = fakeNode(tipAt(NOW), ramp());
    const flaky: Core4Get = (path, q) => (path.includes('/observations') ? Promise.reject(new Error('down')) : node.get(path, q));
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: flaky, nowSec: NOW })).toMatchObject({ retry: 1, scored: 0, unscored: 0 });
    expect(pick(store.saved[0], ['status', 'reason', 'scored_at'])).toEqual(['pending', 'node_unavailable', null]);
    const late = Number(forecastRow().valid) + GIVE_UP_S + 60;
    const lateNode = fakeNode(tipAt(late), ramp());
    const stillFlaky: Core4Get = (path, q) => (path.includes('/observations') ? Promise.reject(new Error('down')) : lateNode.get(path, q));
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: stillFlaky, nowSec: late })).toMatchObject({ retry: 0, unscored: 1 });
    expect(pick(store.saved[1], ['status', 'reason', 'scored_at'])).toEqual(['unscored', 'node_unavailable', late]);
  });

  it('a result that cannot be saved is its own count, and the forecast is not read from the node again every pass', async () => {
    const clock = fast();
    const pace = newPaceState();
    const store = fakeStore([forecastRow()], { failSave: true });
    const node = fakeNode(tipAt(NOW), ramp());
    const run = (query = store.query) => scoreWebsiteForecasts({ ...clock, pace, query, get: node.get, nowSec: NOW });
    expect(await run()).toMatchObject({ scored: 0, unscored: 0, waiting: 0, retry: 0, saveErrors: 1, deferred: 0 });
    const readsForOne = node.log.length;
    expect(readsForOne).toBeGreaterThan(20);
    // Until its retry time it is left alone: not one node read.
    clock.advance(BACKOFF_BASE_MS - 5000);
    expect(await run()).toMatchObject({ saveErrors: 0, deferred: 1, scored: 0, nodeReads: 0 });
    expect(node.log.length).toBe(readsForOne);
    // After 5 minutes it is tried again; a second failure doubles the wait.
    clock.advance(10_000);
    expect(await run()).toMatchObject({ saveErrors: 1, deferred: 0 });
    expect(pace.saveFailures.get(COMMIT_ID)?.count).toBe(2);
    clock.advance(BACKOFF_BASE_MS + 1000);
    expect(await run()).toMatchObject({ deferred: 1, saveErrors: 0 });
    // Once the database takes the row again, the mark is cleared.
    clock.advance(BACKOFF_BASE_MS);
    const healthy = fakeStore([forecastRow()]);
    expect(await run(healthy.query)).toMatchObject({ scored: 1, saveErrors: 0, deferred: 0 });
    expect(pace.saveFailures.size).toBe(0);
  });

  const threeForecasts = () => [forecastRow(), forecastRow({ commit_id: 'c2'.repeat(32), value: 18.6 }), forecastRow({ commit_id: 'c3'.repeat(32), value: 19.4, horizon_hours: 1 })];
  const mostInAnyMinute = (times: number[]) => Math.max(0, ...times.map((t, i) => times.filter((u, j) => j >= i && u < t + 60_000).length));

  it('paces node reads under the ceiling, across passes too, and shares reads between forecasts of one station', async () => {
    const clock = fast();
    const pace = newPaceState();
    const node = fakeNode(tipAt(NOW + 3600), ramp(), { clock: clock.now });
    const store = fakeStore(threeForecasts());
    const first = await scoreWebsiteForecasts({ ...clock, pace, query: store.query, get: node.get, nowSec: NOW + 3600 });
    expect(first).toMatchObject({ scored: 3, retry: 0, nodeBusy: false, nodeReads: node.log.length });
    // Default ceiling: 20 reads a minute, so one every 3 seconds.
    expect(node.log.length).toBeGreaterThan(40);
    expect(mostInAnyMinute(node.log.map((l) => l.at))).toBeLessThanOrEqual(20);
    expect(clock.now()).toBeGreaterThanOrEqual((node.log.length - 1) * 3000);
    // Three forecasts for one station cost far less than three times one: blocks and reading chunks are shared.
    const alone = fakeNode(tipAt(NOW + 3600), ramp());
    await scoreWebsiteForecasts({ ...fast(), query: fakeStore([forecastRow()]).query, get: alone.get, nowSec: NOW + 3600 });
    expect(alone.log.length).toBeLessThan(80);
    expect(node.log.length).toBeLessThan(alone.log.length * 2);
    const paths = node.log.filter((l) => l.path.startsWith('/chain/block/')).map((l) => l.path);
    expect(new Set(paths).size).toBe(paths.length);
    // A second pass straight after the first keeps the same spacing (shared pace state).
    await scoreWebsiteForecasts({ ...clock, pace, query: fakeStore([forecastRow({ commit_id: 'c4'.repeat(32) })]).query, get: node.get, nowSec: NOW + 3600 });
    expect(mostInAnyMinute(node.log.map((l) => l.at))).toBeLessThanOrEqual(20);
  });

  it('honours a lower ceiling from the environment and ignores a bad one', async () => {
    expect([readsPerMinute(undefined), readsPerMinute('6'), readsPerMinute('0'), readsPerMinute('500'), readsPerMinute('abc'), readsPerMinute('2.5')]).toEqual([20, 6, 20, 20, 20, 20]);
    const clock = fast();
    const node = fakeNode(tipAt(NOW), ramp(), { clock: clock.now });
    await scoreWebsiteForecasts({ ...clock, readsPerMin: 6, query: fakeStore([forecastRow()]).query, get: node.get, nowSec: NOW });
    expect(mostInAnyMinute(node.log.map((l) => l.at))).toBeLessThanOrEqual(6);
  });

  it('shares one clock with other jobs that read the node: together they stay at 20 a minute', async () => {
    const clock = fast();
    const shared: NodeReadClock = { nextReadAt: 0 };
    const pace = { ...newPaceState(), clock: shared };
    const node = fakeNode(tipAt(NOW), ramp(), { clock: clock.now });
    // Another job (the station sampler) takes a station's worth of slots, 7 reads, every 30 seconds while this one scores.
    const other: number[] = [];
    let nextOther = clock.now();
    const get: typeof node.get = async (path, query) => {
      while (clock.now() >= nextOther) {
        await reserveNodeReads(shared, 7, 20, clock.now, clock.sleep);
        for (let i = 0; i < 7; i += 1) other.push(clock.now() + i * 3_000);
        nextOther += 30_000;
      }
      return node.get(path, query);
    };
    await scoreWebsiteForecasts({ ...clock, pace, query: fakeStore([forecastRow()]).query, get, nowSec: NOW });
    expect(node.log.length).toBeGreaterThan(20);
    expect(other.length).toBeGreaterThan(7);
    // The job's own state is untouched: its reads were reserved on the shared clock.
    expect(pace.nextReadAt).toBe(0);
    expect(shared.nextReadAt).toBeGreaterThan(0);
    // mostInAnyMinute expects times in order.
    expect(mostInAnyMinute([...node.log.map((l) => l.at), ...other].sort((a, b) => a - b))).toBeLessThanOrEqual(20);
  });

  it('a 429 stops the pass at once, marks nothing, and the scorer backs off 5 minutes, then 10', async () => {
    const clock = fast();
    const pace = newPaceState();
    const store = fakeStore(threeForecasts());
    const node = fakeNode(tipAt(NOW + 3600), ramp(), { busyAfter: 12 });
    const run = () => scoreWebsiteForecasts({ ...clock, pace, query: store.query, get: node.get, nowSec: NOW + 3600 });
    expect(await run()).toMatchObject({ scored: 0, unscored: 0, retry: 3, nodeBusy: true, nodeReads: 13, backingOff: false });
    expect(node.log.length).toBe(13); // the 429 itself was the last request
    expect(store.saved).toEqual([]);
    // The next interval falls inside the backoff: no query result is acted on and the node is not touched.
    clock.advance(BACKOFF_BASE_MS - 1000);
    expect(await run()).toMatchObject({ backingOff: true, nodeReads: 0, retry: 0 });
    expect(node.log.length).toBe(13);
    // After 5 minutes it tries again; still busy, so the wait doubles.
    clock.advance(2000);
    expect(await run()).toMatchObject({ nodeBusy: true, nodeReads: 1, backingOff: false });
    clock.advance(BACKOFF_BASE_MS + 1000);
    expect(await run()).toMatchObject({ backingOff: true });
    expect(pace.busyStreak).toBe(2);
    // A clean pass clears the streak.
    clock.advance(BACKOFF_BASE_MS);
    const calm = fakeNode(tipAt(NOW + 3600), ramp());
    expect(await scoreWebsiteForecasts({ ...clock, pace, query: store.query, get: calm.get, nowSec: NOW + 3600 })).toMatchObject({ scored: 3, nodeBusy: false });
    expect(pace.busyStreak).toBe(0);
  });

  it('does nothing, and reads nothing from the node, when no forecast is due', async () => {
    const node = fakeNode(tipAt(NOW), ramp());
    expect(await scoreWebsiteForecasts({ ...fast(), query: fakeStore([]).query, get: node.get, nowSec: NOW }))
      .toEqual({ scored: 0, unscored: 0, waiting: 0, retry: 0, skipped: 0, saveErrors: 0, deferred: 0, nodeReads: 0, nodeBusy: false, backingOff: false });
    expect(node.calls).toEqual({ blocks: 0, observations: 0 });
  });
});

const SCORED_ROW = {
  status: 'scored', reason: null, unit: 'temp_c_centi', valid: String(VALID_AT), forecast_fp: '1810', truth_fp: '1900', truth_observed: String(VALID_AT),
  truth_commit_id: 'ab'.repeat(32), truth_height: '1790', err_fp: '90', ref_fp: '180', ref_kind: 'persistence_spread', copied: false, skill: 500000,
  beat_baseline: true, nws_fp: '1840', nws_err_fp: '60', nws_skill: 666667, nws_lead_hours: 6,
};
/** Nothing in a practice score may name the station, a place, a wallet or money. */
const PRIVATE_WORDS = /station|lat|lon|owner|payout|address|wallet|forecaster|amount|reward/i;

describe('what the site is told', () => {
  it('scored: integers, the baseline, beat it or not, the NOAA comparison, the truth reading, and that nothing is paid', () => {
    expect(publicPracticeScore(SCORED_ROW, 'revealed', 'temperature_c', VALID_AT)).toEqual({
      paid: false, note: 'Practice score. Nothing is paid for it.', unit: 'temp_c_centi', skillMax: 1_000_000, status: 'scored', reason: null, text: 'scored',
      validAt: new Date(VALID_AT * 1000).toISOString(), forecast: 1810, truth: 1900, truthObservedAt: new Date(VALID_AT * 1000).toISOString(),
      truthCommitId: 'ab'.repeat(32), truthHeight: 1790,
      error: 90, baseline: { error: 180, kind: 'persistence_spread' }, skill: 500_000, copied: false, beatBaseline: true,
      nws: { source: 'NOAA National Weather Service forecast', forecast: 1840, error: 60, skill: 666_667, leadHours: 6, result: 'nws_beat_you' },
    });
    expect(publicPracticeScore({ ...SCORED_ROW, nws_err_fp: '95' }, 'revealed', 'temperature_c', null)).toMatchObject({ nws: { result: 'you_beat_nws' } });
    expect(publicPracticeScore({ ...SCORED_ROW, nws_err_fp: '90' }, 'revealed', 'temperature_c', null)).toMatchObject({ nws: { result: 'tie' } });
    expect(publicPracticeScore({ ...SCORED_ROW, nws_fp: null, nws_err_fp: null, nws_skill: null }, 'revealed', 'temperature_c', null)).toMatchObject({ nws: null });
    // No promise of pay, now or later.
    expect(PRACTICE_NOTE).toBe('Practice score. Nothing is paid for it.');
    expect(PRACTICE_NOTE).not.toMatch(/[0-9]|WRF|earn|start|when|soon|later|yet/i);
  });

  it('pending until 35 minutes after the target time, then waiting for a reading or for the node, then unscored with its reason', () => {
    const until = new Date((VALID_AT + SCORE_DELAY_S) * 1000).toISOString();
    expect(publicPracticeScore(null, 'revealed', 'temperature_c', VALID_AT)).toMatchObject({ status: 'pending', reason: null, text: `pending until ${until}`, pendingUntil: until, validAt: null, paid: false });
    expect(publicPracticeScore(null, 'revealed', 'temperature_c', null)).toMatchObject({ status: 'pending', text: 'pending until the target time', pendingUntil: null, giveUpAt: null });
    expect(publicPracticeScore({ status: 'pending', reason: null, valid: String(VALID_AT) }, 'revealed', 'temperature_c', 1)).toMatchObject({
      status: 'pending', reason: 'waiting_for_reading', text: 'pending: waiting for a station reading', pendingUntil: until,
      validAt: new Date(VALID_AT * 1000).toISOString(), giveUpAt: new Date((VALID_AT + GIVE_UP_S) * 1000).toISOString(),
    });
    // A node failure is never shown as "waiting for a station reading".
    expect(publicPracticeScore({ status: 'pending', reason: 'node_unavailable', valid: String(VALID_AT) }, 'revealed', 'temperature_c', 1))
      .toMatchObject({ status: 'pending', reason: 'node_unavailable', text: 'pending: the chain node could not be read; trying again' });
    const unscored = (reason: string) => publicPracticeScore({ status: 'unscored', reason, valid: String(VALID_AT), forecast_fp: '1810' }, 'revealed', 'temperature_c', null);
    expect(unscored('no_reading')).toMatchObject({ status: 'unscored', reason: 'no_reading', text: 'unscored: no reading', forecast: 1810, truth: null, truthCommitId: null });
    expect(unscored('no_baseline')).toMatchObject({ text: 'unscored: not enough earlier readings for a baseline' });
    expect(unscored('node_unavailable')).toMatchObject({ reason: 'node_unavailable', text: 'unscored: the chain node could not be read' });
    expect(unscored('out_of_range')).toMatchObject({ reason: 'out_of_range', text: 'unscored: the forecast value is outside the scored range' });
    expect(unscored('constructor')).toMatchObject({ reason: 'no_reading' });
    expect(publicPracticeScore(null, 'failed', 'temperature_c', VALID_AT)).toBeNull();
    expect(publicPracticeScore(null, 'revealed', 'humidity_pct', VALID_AT)).toBeNull();
    expect(publicPracticeScore(null, 'revealed', 'constructor', VALID_AT)).toBeNull();
  });

  it('carries no station id, coordinates, wallet or payout field', () => {
    expect(JSON.stringify(publicPracticeScore(SCORED_ROW, 'revealed', 'temperature_c', VALID_AT))).not.toMatch(PRIVATE_WORDS);
  });
});

describe('GET /api/forecasts/mine', () => {
  const WALLET = `0x${'ab'.repeat(20)}`;
  const saved = { ...process.env };
  const mineRow = (commitId: string, status: string) => ({
    commit_id: commitId, station_alias: 'st_0123456789ab', variable: 'temperature_c', value: 18.1, horizon_hours: 6,
    issued_at: new Date((COMMITTED_AT - 120) * 1000), valid_at: new Date(VALID_AT * 1000), status, failure: null, commit_tx_hash: null, reveal_tx_hash: null,
    committed_at_height: '1500', revealed_at_height: '1501', score_status: null, scores: null,
  });
  const app = (query: Query) => {
    const a = express();
    a.use('/api/forecasts', createWebsiteForecastRouter({
      query, rateLimit: (_q, _s, n) => n(), authenticate: (req: any, _res, next) => { req.user = { address: WALLET }; next(); },
    }));
    return a;
  };
  const store = (scoreRows: any[] | Error) => {
    const sqls: string[] = [];
    const query: Query = async (sql) => {
      sqls.push(sql);
      if (sql.includes('FROM website_forecast_scores')) { if (scoreRows instanceof Error) throw scoreRows; return { rows: scoreRows }; }
      return { rows: [mineRow('a1'.repeat(32), 'revealed'), mineRow('b2'.repeat(32), 'revealed'), mineRow('c3'.repeat(32), 'committed')] };
    };
    return { query, sqls };
  };
  beforeEach(() => { process.env.WEBSITE_FORECAST_ENABLED = 'true'; delete process.env.WEBSITE_FORECAST_SCORE_ENABLED; });
  afterEach(() => { process.env = { ...saved }; });

  it('is off by default: no practiceScore field and the score table is never read', async () => {
    expect(websiteForecastScoreEnabled()).toBe(false);
    const s = store([]);
    const res = await request(app(s.query)).get('/api/forecasts/mine');
    expect(res.status).toBe(200);
    expect(res.body.forecasts.length).toBe(3);
    for (const f of res.body.forecasts) expect('practiceScore' in f).toBe(false);
    expect(s.sqls.some((q) => q.includes('website_forecast_scores'))).toBe(false);
  });

  it('needs the website forecast switch too', () => {
    process.env.WEBSITE_FORECAST_SCORE_ENABLED = 'true';
    expect(websiteForecastScoreEnabled()).toBe(true);
    process.env.WEBSITE_FORECAST_ENABLED = 'false';
    expect(websiteForecastScoreEnabled()).toBe(false);
  });

  it('when on: a scored row, a pending row, and nothing for a forecast that is not revealed yet', async () => {
    process.env.WEBSITE_FORECAST_SCORE_ENABLED = 'true';
    const res = await request(app(store([{ ...SCORED_ROW, commit_id: 'a1'.repeat(32), nws_fp: null, nws_err_fp: null, nws_skill: null, nws_lead_hours: null }]).query)).get('/api/forecasts/mine');
    expect(res.status).toBe(200);
    const [a, b, c] = res.body.forecasts;
    expect(a.practiceScore).toMatchObject({ status: 'scored', forecast: 1810, truth: 1900, error: 90, skill: 500000, beatBaseline: true, paid: false, nws: null });
    expect(b.practiceScore).toMatchObject({ status: 'pending', pendingUntil: new Date((VALID_AT + SCORE_DELAY_S) * 1000).toISOString() });
    expect(c.practiceScore).toBeNull();
    expect(a.score).toBeNull(); // the older field is unchanged
  });

  it('when on but the score table cannot be read: the list still answers', async () => {
    process.env.WEBSITE_FORECAST_SCORE_ENABLED = 'true';
    const res = await request(app(store(new Error('relation "website_forecast_scores" does not exist')).query)).get('/api/forecasts/mine');
    expect(res.status).toBe(200);
    expect(res.body.forecasts.map((f: any) => f.practiceScore)).toEqual([null, null, null]);
  });
});

describe('GET /api/forecast-verification/forecasts/:commitId (anyone, no login)', () => {
  const saved = { ...process.env };
  const ID = 'a1'.repeat(32);
  const RAW_STATION = 'PWS-SECRET-RAW-ID-77';
  const record = {
    commit_id: ID, station_alias: 'st_0123456789ab', model_id: 'website-manual/v1', issued_at: new Date((COMMITTED_AT - 120) * 1000), valid_at: new Date(VALID_AT * 1000),
    horizon_hours: 6, status: 'pending', unavailable_reason: null, forecast_values: { temperature_c: 18.1 }, truth: null, scores: null, noaa_reference: null,
    noaa_reason: null, submitted_at: new Date(COMMITTED_AT * 1000), scored_at: null,
    // Columns a careless SELECT * would return: they must never reach the answer.
    station_id: RAW_STATION, forecaster: `0x${'ee'.repeat(20)}`, payout_address: `0x${'ff'.repeat(20)}`,
  };
  const app = (scoreRows: any[] | Error) => {
    const sqls: string[] = [];
    const query: Query = async (sql) => {
      sqls.push(sql);
      if (sql.includes('FROM website_forecast_scores')) { if (scoreRows instanceof Error) throw scoreRows; return { rows: scoreRows }; }
      if (sql.includes('FROM forecast_verification_records WHERE commit_id')) return { rows: [record] };
      return { rows: [] };
    };
    const a = express();
    a.use('/api/forecast-verification', createPublicForecastVerificationRouter({ query, rateLimit: (_q, _s, n) => n() }));
    return { a, sqls };
  };
  beforeEach(() => { process.env.FORECAST_VERIFICATION_ENABLED = 'true'; process.env.WEBSITE_FORECAST_ENABLED = 'true'; delete process.env.WEBSITE_FORECAST_SCORE_ENABLED; });
  afterEach(() => { process.env = { ...saved }; });
  const leaks = (body: unknown) => {
    const text = JSON.stringify(body);
    return text.includes(RAW_STATION) || text.includes('ee'.repeat(20)) || text.includes('ff'.repeat(20)) || /payout|forecaster|owner|latitude|longitude/i.test(text);
  };

  it('switch off: the record as before, no practiceScore field, the score table never read', async () => {
    const { a, sqls } = app([{ ...SCORED_ROW, commit_id: ID }]);
    const res = await request(a).get(`/api/forecast-verification/forecasts/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ commitId: ID, stationAlias: 'st_0123456789ab', status: 'pending' });
    expect('practiceScore' in res.body).toBe(false);
    expect(sqls.some((q) => q.includes('website_forecast_scores'))).toBe(false);
    expect(leaks(res.body)).toBe(false);
  });

  it('switch on: the practice score, with no station id, wallet or payout field anywhere in the answer', async () => {
    process.env.WEBSITE_FORECAST_SCORE_ENABLED = 'true';
    const res = await request(app([{ ...SCORED_ROW, commit_id: ID, station_id: RAW_STATION, forecaster: `0x${'ee'.repeat(20)}` }]).a).get(`/api/forecast-verification/forecasts/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body.practiceScore).toMatchObject({ status: 'scored', forecast: 1810, truth: 1900, error: 90, skill: 500_000, beatBaseline: true, paid: false });
    expect(JSON.stringify(res.body.practiceScore)).not.toMatch(PRIVATE_WORDS);
    expect(leaks(res.body)).toBe(false);
  });

  it('switch on, not a website forecast (no score row): practiceScore is null, never "pending"', async () => {
    process.env.WEBSITE_FORECAST_SCORE_ENABLED = 'true';
    const res = await request(app([]).a).get(`/api/forecast-verification/forecasts/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body.practiceScore).toBeNull();
  });

  it('switch on, score table missing: the record still answers', async () => {
    process.env.WEBSITE_FORECAST_SCORE_ENABLED = 'true';
    const res = await request(app(new Error('relation "website_forecast_scores" does not exist')).a).get(`/api/forecast-verification/forecasts/${ID}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ commitId: ID, practiceScore: null });
    expect(leaks(res.body)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------
// Storage on real PostgreSQL (CI): migration 0044 applies twice, the upsert, the terminal states, the list.
// ---------------------------------------------------------------------------------------------------
const PG_URL = process.env.BACKFILL_TEST_PG_URL;
(PG_URL ? describe : describe.skip)('practice scores on real PostgreSQL', () => {
  const postgres = require('postgres');
  const schema = `wf_0044_${process.pid}`;
  const WALLET = `0x${'cd'.repeat(20)}`;
  let sql: any;
  let query: Query;
  const NOW = VALID_AT + SCORE_DELAY_S + 600;
  const VALID_HOUR = Math.floor(VALID_AT / 3600) * 3600;

  async function insertForecast(commitId: string, over: { value?: number; variable?: string; day?: string; status?: string; height?: number | null } = {}) {
    await sql.unsafe(`INSERT INTO website_forecasts (commit_id, forecaster, station_id, station_alias, variable, value, horizon_hours, issued_at, valid_at,
        forecast_day, data, nonce, commit_timestamp, manifest, auth_pubkey, auth_signature, status, committed_at_height, record_filed)
      VALUES ($1, $2, $3, 'st_0123456789ab', $4, $5, $6, to_timestamp($7), to_timestamp($8), $9::date, '{}', 'n', $14, '{}', $10, $11, $12, $13, true)`,
    [commitId, WALLET, STATION, over.variable ?? 'temperature_c', over.value ?? 18.1, LEAD, COMMITTED_AT - 120, COMMITTED_AT - 120 + LEAD * 3600,
      over.day ?? '2027-01-15', 'ab'.repeat(32), 'cd'.repeat(64), over.status ?? 'revealed', over.height === undefined ? COMMIT_HEIGHT : over.height,
      COMMITTED_AT - 120]);
  }
  const insertNws = (issuedHour: number, temperatureC: number, capturedAt: number) => sql.unsafe(`INSERT INTO forecast_verification_noaa_reference
      (station_id, issued_hour, valid_hour, temperature_c, humidity_pct, source, captured_at) VALUES ($1, to_timestamp($2), to_timestamp($3), $4, 50, 'nws:test', to_timestamp($5))`,
  [STATION, issuedHour, VALID_HOUR, temperatureC, capturedAt]);
  const practice = async (rows: any[]) => {
    const scores = await readPracticeScores(query, rows.map((r) => r.commit_id));
    return new Map<string, unknown>(rows.map((r) => [r.commit_id, publicPracticeScore(scores.get(r.commit_id) ?? null, r.status, r.variable, Math.floor(new Date(r.valid_at).getTime() / 1000))]));
  };
  const pass = (node: { get: Core4Get }, nowSec: number) => scoreWebsiteForecasts({ ...fast(), query, get: node.get, nowSec });

  beforeAll(async () => {
    sql = postgres(PG_URL as string, { max: 1, onnotice: () => {} });
    await sql.unsafe(`CREATE SCHEMA ${schema}`);
    await sql.unsafe(`SET search_path TO ${schema}`);
    for (const file of ['0039_forecast_verification', '0043_website_forecasts', '0044_website_forecast_scores']) {
      const migration = readFileSync(`drizzle/migrations/${file}.sql`, 'utf8');
      for (let i = 0; i < 2; i += 1) for (const statement of migration.split('--> statement-breakpoint')) await sql.unsafe(statement);
    }
    query = async (text, params = []) => ({ rows: await sql.unsafe(text, params as any[]) });
  });
  afterAll(async () => {
    if (!sql) return;
    await sql.unsafe(`DROP SCHEMA ${schema} CASCADE`);
    await sql.end({ timeout: 5 });
  });
  beforeEach(async () => { await sql.unsafe('TRUNCATE website_forecast_scores, website_forecasts, forecast_verification_noaa_reference'); });

  it('scores a revealed forecast once, stores integers and the truth reading, and lists it with the wallet\'s forecasts', async () => {
    await insertForecast(COMMIT_ID);
    // Two NOAA captures for the hour: an older one taken before the commit, and a newer issue hour that began
    // before the commit but was captured after it. Only the first may be used.
    const commitHour = Math.floor(COMMITTED_AT / 3600) * 3600;
    await insertNws(commitHour - 3600, 18.4, COMMITTED_AT - 3000);
    await insertNws(commitHour, 19.0, COMMITTED_AT + 60);
    const node = fakeNode(tipAt(NOW), ramp());
    expect(await pass(node, NOW)).toMatchObject({ scored: 1, unscored: 0, waiting: 0, retry: 0, saveErrors: 0 });
    const [row] = await sql.unsafe('SELECT * FROM website_forecast_scores');
    expect(row).toMatchObject({
      commit_id: COMMIT_ID, status: 'scored', reason: null, unit: 'temp_c_centi', valid_at_source: 'chain', forecast_fp: '1810', truth_fp: '1900', err_fp: '90',
      truth_commit_id: 'obs-00180', truth_height: String(Math.ceil((VALID_AT + 150 - GENESIS) / BLOCK_S)),
      ref_fp: '180', ref_kind: 'persistence_spread', mean24_fp: '1357', last_fp: '1715', window_samples: 24, tol: 5, copied: false, skill: 500000,
      beat_baseline: true, nws_fp: '1840', nws_err_fp: '60', nws_skill: 666667, nws_lead_hours: (VALID_HOUR - (commitHour - 3600)) / 3600, attempts: 1,
    });
    expect(Math.floor(new Date(row.valid_at).getTime() / 1000)).toBe(VALID_AT);
    expect(Math.floor(new Date(row.scored_at).getTime() / 1000)).toBe(NOW);
    // A scored forecast is final: a later pass neither selects nor rewrites it.
    const before = { ...node.calls };
    expect(await pass(node, NOW + 7200)).toMatchObject({ scored: 0, unscored: 0, waiting: 0, retry: 0 });
    expect(node.calls).toEqual(before);
    const mine = await listMine(query, WALLET, 50, practice);
    expect(mine.length).toBe(1);
    expect(mine[0].practiceScore).toMatchObject({
      status: 'scored', forecast: 1810, truth: 1900, error: 90, baseline: { error: 180 }, skill: 500000, beatBaseline: true, truthCommitId: 'obs-00180', nws: { result: 'nws_beat_you' },
    });
    expect((await listMine(query, WALLET))[0]).not.toHaveProperty('practiceScore');
  });

  it('a NOAA capture taken after the commit is never used', async () => {
    await insertForecast(COMMIT_ID);
    await insertNws(Math.floor(COMMITTED_AT / 3600) * 3600, 19.0, COMMITTED_AT + 60);
    expect(await pass(fakeNode(tipAt(NOW), ramp()), NOW)).toMatchObject({ scored: 1 });
    expect((await sql.unsafe('SELECT nws_fp, nws_err_fp, nws_skill FROM website_forecast_scores'))[0]).toMatchObject({ nws_fp: null, nws_err_fp: null, nws_skill: null });
  });

  it('pending is retried no sooner than 30 minutes later, then becomes unscored', async () => {
    await insertForecast(COMMIT_ID);
    const gap = ramp(VALID_AT + 86_400 + 7200, (j) => j >= 178 && j <= 182);
    expect(await pass(fakeNode(tipAt(NOW), gap), NOW)).toMatchObject({ waiting: 1 });
    expect((await sql.unsafe('SELECT status, reason, attempts, scored_at FROM website_forecast_scores'))[0]).toMatchObject({ status: 'pending', reason: null, attempts: 1, scored_at: null });
    expect((await listMine(query, WALLET, 50, practice))[0].practiceScore).toMatchObject({ status: 'pending', reason: 'waiting_for_reading' });
    // Ten minutes later: not selected again.
    const soon = fakeNode(tipAt(NOW + 600), gap);
    expect(await pass(soon, NOW + 600)).toMatchObject({ scored: 0, unscored: 0, waiting: 0, retry: 0 });
    expect(soon.calls).toEqual({ blocks: 0, observations: 0 });
    const late = VALID_AT + GIVE_UP_S + 60;
    expect(await pass(fakeNode(tipAt(late), gap), late)).toMatchObject({ unscored: 1 });
    expect((await sql.unsafe('SELECT status, reason, attempts, skill FROM website_forecast_scores'))[0]).toMatchObject({ status: 'unscored', reason: 'no_reading', attempts: 2, skill: null });
    expect((await listMine(query, WALLET, 50, practice))[0].practiceScore).toMatchObject({ status: 'unscored', text: 'unscored: no reading' });
  });

  it('a node failure is stored as pending with its own reason, and a later good pass scores it; only revealed forecasts are looked at', async () => {
    await insertForecast(COMMIT_ID);
    await insertForecast('d4'.repeat(32), { status: 'failed', day: '2027-01-16' });
    await insertForecast('e5'.repeat(32), { status: 'committed', day: '2027-01-17' });
    const good = fakeNode(tipAt(NOW), ramp());
    const flaky: Core4Get = (path, q) => (path.includes('/observations') ? Promise.reject(new Error('down')) : good.get(path, q));
    expect(await pass({ get: flaky }, NOW)).toMatchObject({ retry: 1, scored: 0 });
    expect((await sql.unsafe('SELECT status, reason FROM website_forecast_scores'))[0]).toMatchObject({ status: 'pending', reason: 'node_unavailable' });
    expect((await listMine(query, WALLET, 50, practice)).find((f: any) => f.commitId === COMMIT_ID)?.practiceScore).toMatchObject({ status: 'pending', reason: 'node_unavailable' });
    expect(await pass(fakeNode(tipAt(NOW + 3600), ramp()), NOW + 3600)).toMatchObject({ scored: 1 });
    const rows = await sql.unsafe('SELECT commit_id, status, reason, attempts, skill FROM website_forecast_scores');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ commit_id: COMMIT_ID, status: 'scored', reason: null, attempts: 2, skill: 500000 });
  });

  it('migration 0044 upgrades an earlier draft of the table in place, and is still rerunnable after that', async () => {
    const draft = `wf_0044_draft_${process.pid}`;
    await sql.unsafe(`CREATE SCHEMA ${draft}`);
    try {
      await sql.unsafe(`SET search_path TO ${draft}`);
      // The table as first drafted: no truth reading columns, two reasons only.
      await sql.unsafe(`CREATE TABLE website_forecast_scores (
        commit_id text PRIMARY KEY CHECK (commit_id ~ '^[0-9a-f]{64}$'),
        status text NOT NULL CHECK (status IN ('pending', 'scored', 'unscored')),
        reason text CHECK (reason IN ('no_reading', 'no_baseline')),
        unit text NOT NULL CHECK (unit IN ('temp_c_centi', 'pressure_pa')),
        valid_at timestamptz NOT NULL, valid_at_source text NOT NULL CHECK (valid_at_source IN ('chain', 'draft')),
        forecast_fp bigint, truth_fp bigint, truth_observed_at timestamptz, err_fp bigint, ref_fp bigint,
        ref_kind text CHECK (ref_kind IN ('climatology_spread', 'persistence_spread')), mean24_fp bigint, last_fp bigint, window_samples integer, tol integer,
        copied boolean, skill integer CHECK (skill BETWEEN 0 AND 1000000), beat_baseline boolean, nws_fp bigint, nws_err_fp bigint,
        nws_skill integer CHECK (nws_skill BETWEEN 0 AND 1000000), nws_lead_hours integer, attempts integer NOT NULL DEFAULT 0, last_attempt_at timestamptz,
        scored_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`);
      await sql.unsafe(`INSERT INTO website_forecast_scores (commit_id, status, reason, unit, valid_at, valid_at_source) VALUES ('${'aa'.repeat(32)}', 'unscored', 'no_reading', 'temp_c_centi', now(), 'chain')`);
      await expect(sql.unsafe(`INSERT INTO website_forecast_scores (commit_id, status, reason, unit, valid_at, valid_at_source) VALUES ('${'bb'.repeat(32)}', 'unscored', 'node_unavailable', 'temp_c_centi', now(), 'chain')`)).rejects.toThrow(/check constraint/);
      const migration = readFileSync('drizzle/migrations/0044_website_forecast_scores.sql', 'utf8');
      for (let i = 0; i < 3; i += 1) for (const statement of migration.split('--> statement-breakpoint')) await sql.unsafe(statement);
      // The earlier row is kept; the new columns and reasons are accepted; a made-up reason is still refused.
      await sql.unsafe(`INSERT INTO website_forecast_scores (commit_id, status, reason, unit, valid_at, valid_at_source, truth_commit_id, truth_height)
        VALUES ('${'bb'.repeat(32)}', 'unscored', 'node_unavailable', 'temp_c_centi', now(), 'chain', 'obs-1', 1790), ('${'cc'.repeat(32)}', 'unscored', 'out_of_range', 'temp_c_centi', now(), 'chain', NULL, NULL)`);
      await expect(sql.unsafe(`INSERT INTO website_forecast_scores (commit_id, status, reason, unit, valid_at, valid_at_source) VALUES ('${'dd'.repeat(32)}', 'unscored', 'because', 'temp_c_centi', now(), 'chain')`)).rejects.toThrow(/check constraint/);
      const rows = await sql.unsafe('SELECT commit_id, reason, truth_commit_id, truth_height FROM website_forecast_scores ORDER BY commit_id');
      expect(rows.map((r: any) => [r.commit_id.slice(0, 2), r.reason, r.truth_commit_id, r.truth_height])).toEqual([['aa', 'no_reading', null, null], ['bb', 'node_unavailable', 'obs-1', '1790'], ['cc', 'out_of_range', null, null]]);
      // Exactly one reason constraint, not one per run.
      const checks = await sql.unsafe(`SELECT conname FROM pg_constraint WHERE conrelid = '${draft}.website_forecast_scores'::regclass AND conname LIKE '%reason%'`);
      expect(checks.map((c: any) => c.conname)).toEqual(['website_forecast_scores_reason_check']);
    } finally {
      await sql.unsafe(`SET search_path TO ${schema}`);
      await sql.unsafe(`DROP SCHEMA ${draft} CASCADE`);
    }
  });

  it('stores an out-of-range forecast as unscored (the table accepts every reason the scorer writes)', async () => {
    await insertForecast(COMMIT_ID, { value: 60 });
    await sql.unsafe('UPDATE website_forecasts SET value = 150');
    expect(await pass(fakeNode(tipAt(NOW), ramp()), NOW)).toMatchObject({ unscored: 1, saveErrors: 0 });
    expect((await sql.unsafe('SELECT status, reason, forecast_fp FROM website_forecast_scores'))[0]).toMatchObject({ status: 'unscored', reason: 'out_of_range', forecast_fp: null });
  });
});
