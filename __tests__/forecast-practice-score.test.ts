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
  hourlyWindow, isqrt, lastReadingBefore, nearestReading, numberToFixedPoint, parseFixedPoint, ratioSkill, referenceFromWindow, skillScore,
  type Reading,
} from '../server/services/forecast-score/practice-score';
import {
  GIVE_UP_S, PRACTICE_NOTE, SCORE_DELAY_S, publicPracticeScore, readPracticeScores, scoreWebsiteForecasts, websiteForecastScoreEnabled,
} from '../server/services/forecast-score/practice-score-job';
import { createWebsiteForecastRouter } from '../server/routes/website-forecast-routes';
import { listMine } from '../server/services/website-forecast/website-forecast-store';
import type { Core4Get } from '../server/services/forecast-commit-record';
import type { Query } from '../server/services/forecast-verification/observed-verification';

const vectors = JSON.parse(readFileSync('contract-fixtures/forecast-skill-vectors.json', 'utf8'));
const big = (v: number | null) => (v === null ? null : BigInt(v));

describe('integer skill rule against the shared vectors', () => {
  it('has the expected file shape', () => {
    expect(vectors.schema).toBe('wrfcoin-forecast-skill-vectors/v1');
    expect(vectors.precision).toBe(1_000_000);
    expect(vectors.default_tol).toBe(5);
    expect([vectors.skill.length, vectors.reference.length, vectors.fixed_point.length]).toEqual([46, 27, 18]);
  });

  it.each(vectors.skill.map((v: any) => [v.name, v]))('skill: %s', (_name, v: any) => {
    const r = skillScore({ forecast: BigInt(v.forecast), truth: BigInt(v.truth), reference: BigInt(v.reference), mean24: BigInt(v.mean24), last: BigInt(v.last), tol: BigInt(v.tol) });
    expect({ err: Number(r.err), copy: r.copy, skill: Number(r.skill), beat_baseline: r.beatBaseline }).toEqual(v.expect);
  });

  it.each(vectors.reference.map((v: any) => [v.name, v]))('reference: %s', (_name, v: any) => {
    const r = referenceFromWindow(v.window.map(big), v.lag);
    expect(r === null ? null : {
      samples: r.samples, mean24: Number(r.mean24), spread: Number(r.spread), persistence: r.persistence === null ? null : Number(r.persistence),
      reference: Number(r.reference), kind: r.kind,
    }).toEqual(v.expect);
  });

  it.each(vectors.fixed_point.map((v: any) => [v.text, v.expect]))('fixed point: %s', (text, expected) => {
    expect(Number(parseFixedPoint(text as string))).toBe(expected);
  });

  it('uses the default tolerance of 5 when none is given', () => {
    expect(skillScore({ forecast: 1805n, truth: 1805n, reference: 250n, mean24: 1800n, last: 0n }).copy).toBe(true);
    expect(skillScore({ forecast: 1806n, truth: 1806n, reference: 250n, mean24: 1800n, last: 0n }).skill).toBe(1_000_000n);
  });

  it('refuses what is not a plain decimal, and never goes through floating-point arithmetic', () => {
    for (const bad of ['', ' 1', '1e3', '1.', '.5', '+1', 'NaN', '1,5', '1234567890123456']) expect(parseFixedPoint(bad)).toBeNull();
    expect(numberToFixedPoint(0.1 + 0.2)).toBe(30n);
    expect(numberToFixedPoint(1.005)).toBe(101n); // the text "1.005", not the binary value just below it
    expect(numberToFixedPoint(-0)).toBe(0n);
    expect(numberToFixedPoint(1e-7)).toBeNull();
    expect(numberToFixedPoint(Number.NaN)).toBeNull();
    expect(numberToFixedPoint('12.3')).toBeNull();
  });

  it('isqrt is the floor square root, exact past 2^53', () => {
    for (const [n, r] of [[0n, 0n], [1n, 1n], [3n, 1n], [4n, 2n], [43125n, 207n], [10n ** 30n, 10n ** 15n], [10n ** 30n - 1n, 10n ** 15n - 1n]]) expect(isqrt(n)).toBe(r);
    expect(() => isqrt(-1n)).toThrow();
    expect(() => ratioSkill(-1n, 5n)).toThrow();
    expect(() => referenceFromWindow([1n, 2n], 0)).toThrow();
  });
});

describe('readings to window and truth', () => {
  const at = (observedAt: number, value: bigint, id = `r${observedAt}`): Reading => ({ observedAt, value, id });
  const ANCHOR = 1_800_000_000;

  it('buckets the 24 hours before the anchor into hourly means; the anchor itself is outside', () => {
    const w = hourlyWindow([at(ANCHOR - 86_400, 100n), at(ANCHOR - 86_400 + 3599, 103n), at(ANCHOR - 3600, 7n), at(ANCHOR - 1, -8n), at(ANCHOR, 999n), at(ANCHOR - 86_401, 999n)], ANCHOR);
    expect(w.length).toBe(24);
    expect(w[0]).toBe(101n); // (100 + 103) / 2 truncates
    expect(w[23]).toBe(0n); // (7 − 8) / 2 truncates toward zero
    expect(w.slice(1, 23).every((v) => v === null)).toBe(true);
  });

  it('takes the last reading strictly before the anchor', () => {
    expect(lastReadingBefore([at(ANCHOR, 1n), at(ANCHOR - 5, 2n), at(ANCHOR - 600, 3n)], ANCHOR)?.value).toBe(2n);
    expect(lastReadingBefore([at(ANCHOR - 5, 2n, 'b'), at(ANCHOR - 5, 9n, 'a')], ANCHOR)?.value).toBe(9n);
    expect(lastReadingBefore([at(ANCHOR - 86_401, 1n)], ANCHOR)).toBeNull();
  });

  it('takes the reading nearest the target time, at most 15 minutes away; ties go to the earlier one', () => {
    expect(nearestReading([at(ANCHOR - 901, 1n), at(ANCHOR + 901, 2n)], ANCHOR)).toBeNull();
    expect(nearestReading([at(ANCHOR - 900, 1n), at(ANCHOR + 901, 2n)], ANCHOR)?.value).toBe(1n);
    expect(nearestReading([at(ANCHOR + 300, 1n), at(ANCHOR - 300, 2n), at(ANCHOR + 200, 3n)], ANCHOR)?.value).toBe(3n);
    expect(nearestReading([at(ANCHOR + 300, 1n), at(ANCHOR - 300, 2n)], ANCHOR)?.value).toBe(2n);
    expect(nearestReading([at(ANCHOR + 60, 1n, 'b'), at(ANCHOR + 60, 2n, 'a')], ANCHOR)?.value).toBe(2n);
  });
});

// ---------------------------------------------------------------------------------------------------
// A fake node: blocks every 77 s; a reading lands in the first block at least 150 s after it is observed.
// ---------------------------------------------------------------------------------------------------
const STATION = 'PWS-TEST-ALPHA-01';
const BLOCK_S = 77;
const GENESIS = 1_800_000_000;
const COMMIT_HEIGHT = 1500;
const COMMITTED_AT = GENESIS + COMMIT_HEIGHT * BLOCK_S;
const LEAD = 6;
const VALID_AT = COMMITTED_AT + LEAD * 3600;
const COMMIT_ID = 'c1'.repeat(32);

interface Obs { observedAt: number; values: Record<string, number>; provenance?: string | null; quorum?: boolean | null }

function fakeNode(tipHeight: number, readings: Obs[], opts: { fail?: boolean; busyAfter?: number; clock?: () => number } = {}) {
  const calls = { blocks: 0, observations: 0 };
  /** When each request reached the node (the test's clock), and its path. */
  const log: Array<{ at: number; path: string }> = [];
  const landing = (o: Obs) => Math.ceil((o.observedAt + 150 - GENESIS) / BLOCK_S);
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
  return { now: () => t, sleep: async (ms: number) => { t += ms; } };
}

function fakeStore(rows: any[], nws: any[] = []) {
  const saved: any[][] = [];
  const query: Query = async (sql, params = []) => {
    if (sql.includes('FROM website_forecasts w LEFT JOIN website_forecast_scores')) return { rows };
    if (sql.includes('INSERT INTO website_forecast_scores')) { saved.push(params); return { rows: [] }; }
    if (sql.includes('forecast_verification_noaa_reference')) return { rows: nws };
    throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
  };
  return { query, saved };
}
const forecastRow = (over: Record<string, unknown> = {}) => ({
  commit_id: COMMIT_ID, station_id: STATION, variable: 'temperature_c', value: 18.1, horizon_hours: LEAD, committed_at_height: String(COMMIT_HEIGHT),
  issued: String(COMMITTED_AT - 120), valid: String(COMMITTED_AT - 120 + LEAD * 3600), ...over,
});
// UPSERT parameter positions (1-based in SQL).
const P = { status: 1, reason: 2, unit: 3, validAt: 4, source: 5, forecast: 6, truth: 7, truthAt: 8, err: 9, ref: 10, refKind: 11, mean24: 12, last: 13, samples: 14, tol: 15, copied: 16, skill: 17, beat: 18, nws: 19, nwsErr: 20, nwsSkill: 21, nwsLead: 22, now: 23 };

describe('scoring pass', () => {
  const NOW = VALID_AT + SCORE_DELAY_S + 600;

  it('scores a forecast by the integer rule: truth, reference from the station\'s own 24 hours, skill, beat the baseline', async () => {
    const store = fakeStore([forecastRow()], [{ issued: String(COMMITTED_AT - 3000), valid: String(Math.floor(VALID_AT / 3600) * 3600), temperature_c: 18.4, humidity_pct: null, source: 'nws:test' }]);
    const node = fakeNode(tipAt(NOW), ramp());
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: node.get, nowSec: NOW })).toMatchObject({ scored: 1, unscored: 0, waiting: 0, retry: 0 });
    expect(store.saved.length).toBe(1);
    const p = store.saved[0];
    // Hourly means 1012 + 30k (k = 0..23): mean 1357, spread isqrt(43125) = 207, 6 h persistence 180 (the smaller one).
    expect([p[0], p[P.status], p[P.reason], p[P.unit], p[P.validAt], p[P.source]]).toEqual([COMMIT_ID, 'scored', null, 'temp_c_centi', VALID_AT, 'chain']);
    expect([p[P.forecast], p[P.truth], p[P.truthAt], p[P.err]]).toEqual(['1810', '1900', VALID_AT, '90']);
    expect([p[P.ref], p[P.refKind], p[P.mean24], p[P.last], p[P.samples], p[P.tol]]).toEqual(['180', 'persistence_spread', '1357', '1715', 24, 5]);
    expect([p[P.copied], p[P.skill], p[P.beat]]).toEqual([false, 500_000, true]);
    // NOAA's forecast for that hour, captured before the commit: 18.4 °C, off by 0.60, skill 1e6 − 1e6·60/180.
    expect([p[P.nws], p[P.nwsErr], p[P.nwsSkill], p[P.nwsLead]]).toEqual(['1840', '60', 666_667, expect.any(Number)]);
    expect(p[P.now]).toBe(NOW);
  });

  it('reads each block once per pass and stays inside the node read budget', async () => {
    const store = fakeStore([forecastRow()]);
    const node = fakeNode(tipAt(NOW), ramp());
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: node.get, nowSec: NOW });
    expect(node.calls.blocks).toBeLessThan(80);
    expect(node.calls.observations).toBeLessThan(30);
  });

  it('zeroes a copy of the last reading', async () => {
    const store = fakeStore([forecastRow({ value: 17.2 })]);
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), ramp()).get, nowSec: NOW });
    const p = store.saved[0];
    expect([p[P.forecast], p[P.last], p[P.copied], p[P.skill], p[P.beat]]).toEqual(['1720', '1715', true, 0, false]);
  });

  it('scores pressure in Pa; a flat station has a zero reference and nobody beats it', async () => {
    const store = fakeStore([forecastRow({ variable: 'pressure_hpa', value: 1013.3 })]);
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), ramp()).get, nowSec: NOW });
    const p = store.saved[0];
    expect([p[P.unit], p[P.forecast], p[P.truth], p[P.err], p[P.ref], p[P.skill], p[P.beat], p[P.nws]]).toEqual(['pressure_pa', '101330', '101325', '5', '0', 0, false, null]);
  });

  it('waits until 20 minutes after the chain target time, by the clock and by the chain tip', async () => {
    const store = fakeStore([forecastRow()]);
    const early = VALID_AT + SCORE_DELAY_S - 1;
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(early), ramp()).get, nowSec: early })).toMatchObject({ waiting: 1, scored: 0 });
    // The clock is past, the chain is not (stalled): still waiting.
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(VALID_AT), ramp()).get, nowSec: NOW })).toMatchObject({ waiting: 1, scored: 0 });
    expect(store.saved).toEqual([]);
  });

  it('no reading within 15 minutes: pending, then unscored after 24 hours; never a made-up truth', async () => {
    // Readings stop 30 minutes before the target time and resume 30 minutes after.
    const gap = ramp(VALID_AT + 86_400 + 7200, (j) => j >= 178 && j <= 182);
    const store = fakeStore([forecastRow()]);
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), gap).get, nowSec: NOW })).toMatchObject({ scored: 0, unscored: 0, waiting: 1, retry: 0 });
    expect([store.saved[0][P.status], store.saved[0][P.reason], store.saved[0][P.truth], store.saved[0][P.skill]]).toEqual(['pending', null, null, null]);
    const late = VALID_AT + GIVE_UP_S + 60;
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(late), gap).get, nowSec: late })).toMatchObject({ scored: 0, unscored: 1, waiting: 0, retry: 0 });
    expect([store.saved[1][P.status], store.saved[1][P.reason], store.saved[1][P.truth], store.saved[1][P.skill]]).toEqual(['unscored', 'no_reading', null, null]);
  });

  it('never scores against synthetic readings', async () => {
    const store = fakeStore([forecastRow()]);
    const synthetic = ramp().map((o) => ({ ...o, provenance: 'synthetic' }));
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), synthetic).get, nowSec: NOW })).toMatchObject({ scored: 0, waiting: 1 });
    expect(store.saved[0][P.status]).toBe('pending');
  });

  it('no earlier readings to build a baseline from: unscored, with the truth it found', async () => {
    const store = fakeStore([forecastRow()]);
    const onlyAfter = ramp().filter((o) => o.observedAt >= COMMITTED_AT);
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), onlyAfter).get, nowSec: NOW })).toMatchObject({ unscored: 1 });
    expect([store.saved[0][P.status], store.saved[0][P.reason], store.saved[0][P.truth], store.saved[0][P.skill]]).toEqual(['unscored', 'no_baseline', '1900', null]);
  });

  it('falls back to the draft target time when the commit height is unknown', async () => {
    const store = fakeStore([forecastRow({ committed_at_height: null })]);
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), ramp()).get, nowSec: NOW });
    expect([store.saved[0][P.status], store.saved[0][P.validAt], store.saved[0][P.source]]).toEqual(['scored', COMMITTED_AT - 120 + LEAD * 3600, 'draft']);
  });

  it('a node that cannot answer leaves the forecast pending for a later pass', async () => {
    const store = fakeStore([forecastRow()]);
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), ramp(), { fail: true }).get, nowSec: NOW })).toMatchObject({ scored: 0, unscored: 0, waiting: 0, retry: 1 });
    expect(store.saved).toEqual([]);
    // The tip answers but the readings do not.
    const node = fakeNode(tipAt(NOW), ramp());
    const flaky: Core4Get = (path, q) => (path.includes('/observations') ? Promise.reject(new Error('down')) : node.get(path, q));
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: flaky, nowSec: NOW })).toMatchObject({ retry: 1, scored: 0 });
    expect(store.saved[0][P.status]).toBe('pending');
  });

  it('only readings that reached the attestation quorum count as truth', async () => {
    // The reading exactly at the target time has no quorum; the next nearest (10 minutes earlier, 18.95 °C) has.
    const mixed = ramp().map((o) => (o.observedAt === VALID_AT ? { ...o, quorum: false } : o));
    const store = fakeStore([forecastRow()]);
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), mixed).get, nowSec: NOW })).toMatchObject({ scored: 1 });
    expect([store.saved[0][P.truth], store.saved[0][P.truthAt], store.saved[0][P.err]]).toEqual(['1895', VALID_AT - 600, '85']);
    // Readings within 15 minutes exist, but none has quorum (one has no attestation at all): waiting, then unscored.
    const none = ramp(VALID_AT + 86_400 + 7200).map((o) => (Math.abs(o.observedAt - VALID_AT) <= 900 ? { ...o, quorum: o.observedAt === VALID_AT ? null : false } : o));
    const waiting = fakeStore([forecastRow()]);
    expect(await scoreWebsiteForecasts({ ...fast(), query: waiting.query, get: fakeNode(tipAt(NOW), none).get, nowSec: NOW })).toMatchObject({ scored: 0, waiting: 1 });
    expect([waiting.saved[0][P.status], waiting.saved[0][P.truth]]).toEqual(['pending', null]);
    const late = VALID_AT + GIVE_UP_S + 60;
    expect(await scoreWebsiteForecasts({ ...fast(), query: waiting.query, get: fakeNode(tipAt(late), none).get, nowSec: late })).toMatchObject({ unscored: 1 });
    expect([waiting.saved[1][P.status], waiting.saved[1][P.reason]]).toEqual(['unscored', 'no_reading']);
  });

  it('the reference window also uses quorum readings only', async () => {
    // Before the commit only the readings on the hour have quorum: 24 hourly samples 1000 + 30k instead of the means 1012 + 30k.
    const sparse = ramp().map((o) => (o.observedAt < COMMITTED_AT && (o.observedAt - (COMMITTED_AT - 86_400)) % 3600 !== 0 ? { ...o, quorum: false } : o));
    const store = fakeStore([forecastRow()]);
    await scoreWebsiteForecasts({ ...fast(), query: store.query, get: fakeNode(tipAt(NOW), sparse).get, nowSec: NOW });
    const p = store.saved[0];
    expect([p[P.status], p[P.mean24], p[P.last], p[P.ref], p[P.samples], p[P.skill]]).toEqual(['scored', '1345', '1690', '180', 24, 500_000]);
    // No quorum reading before the commit at all: no baseline.
    const bare = ramp().map((o) => (o.observedAt < COMMITTED_AT ? { ...o, quorum: false } : o));
    const none = fakeStore([forecastRow()]);
    await scoreWebsiteForecasts({ ...fast(), query: none.query, get: fakeNode(tipAt(NOW), bare).get, nowSec: NOW });
    expect([none.saved[0][P.status], none.saved[0][P.reason]]).toEqual(['unscored', 'no_baseline']);
  });

  const threeForecasts = () => [forecastRow(), forecastRow({ commit_id: 'c2'.repeat(32), value: 18.6 }), forecastRow({ commit_id: 'c3'.repeat(32), value: 19.4, horizon_hours: 1 })];
  const mostInAnyMinute = (times: number[]) => Math.max(0, ...times.map((t, i) => times.filter((u, j) => j >= i && u < t + 60_000).length));

  it('paces node reads under the ceiling, across passes too, and shares reads between forecasts of one station', async () => {
    const clock = fast();
    const pace = { nextReadAt: 0 };
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
    expect(node.log.length).toBeLessThan(alone.log.length * 2);
    const paths = node.log.filter((l) => l.path.startsWith('/chain/block/')).map((l) => l.path);
    expect(new Set(paths).size).toBe(paths.length);
    // A second pass straight after the first keeps the same spacing (shared pace state).
    await scoreWebsiteForecasts({ ...clock, pace, query: fakeStore([forecastRow({ commit_id: 'c4'.repeat(32) })]).query, get: node.get, nowSec: NOW + 3600 });
    expect(mostInAnyMinute(node.log.map((l) => l.at))).toBeLessThanOrEqual(20);
  });

  it('honours a lower ceiling from the environment and ignores a bad one', async () => {
    const { readsPerMinute } = await import('../server/services/forecast-score/practice-score-job');
    expect([readsPerMinute(undefined), readsPerMinute('6'), readsPerMinute('0'), readsPerMinute('500'), readsPerMinute('abc'), readsPerMinute('2.5')]).toEqual([20, 6, 20, 20, 20, 20]);
    const clock = fast();
    const node = fakeNode(tipAt(NOW), ramp(), { clock: clock.now });
    await scoreWebsiteForecasts({ ...clock, readsPerMin: 6, query: fakeStore([forecastRow()]).query, get: node.get, nowSec: NOW });
    expect(mostInAnyMinute(node.log.map((l) => l.at))).toBeLessThanOrEqual(6);
  });

  it('a 429 from the node stops the pass at once; nothing is marked and the next interval starts over', async () => {
    const store = fakeStore(threeForecasts());
    const node = fakeNode(tipAt(NOW + 3600), ramp(), { busyAfter: 12 });
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: node.get, nowSec: NOW + 3600 }))
      .toMatchObject({ scored: 0, unscored: 0, retry: 3, nodeBusy: true, nodeReads: 13 });
    expect(node.log.length).toBe(13); // the 429 itself was the last request
    expect(store.saved).toEqual([]);
    // Busy on the very first read (the tip): same outcome.
    const tipBusy = fakeNode(tipAt(NOW), ramp(), { busyAfter: 0 });
    expect(await scoreWebsiteForecasts({ ...fast(), query: store.query, get: tipBusy.get, nowSec: NOW })).toMatchObject({ retry: 3, nodeBusy: true, nodeReads: 1 });
  });

  it('does nothing, and reads nothing from the node, when no forecast is due', async () => {
    const node = fakeNode(tipAt(NOW), ramp());
    expect(await scoreWebsiteForecasts({ ...fast(), query: fakeStore([]).query, get: node.get, nowSec: NOW })).toEqual({ scored: 0, unscored: 0, waiting: 0, retry: 0, nodeReads: 0, nodeBusy: false });
    expect(node.calls).toEqual({ blocks: 0, observations: 0 });
  });
});

describe('what the site is told', () => {
  const scored = {
    status: 'scored', reason: null, unit: 'temp_c_centi', valid: String(VALID_AT), forecast_fp: '1810', truth_fp: '1900', truth_observed: String(VALID_AT),
    err_fp: '90', ref_fp: '180', ref_kind: 'persistence_spread', copied: false, skill: 500000, beat_baseline: true,
    nws_fp: '1840', nws_err_fp: '60', nws_skill: 666667, nws_lead_hours: 6,
  };

  it('scored: integers, the baseline, beat it or not, the NOAA comparison, and an honest note about pay', () => {
    expect(publicPracticeScore(scored, 'revealed', 'temperature_c', VALID_AT)).toEqual({
      paid: false, note: PRACTICE_NOTE, unit: 'temp_c_centi', skillMax: 1_000_000, status: 'scored', reason: null, text: 'scored',
      validAt: new Date(VALID_AT * 1000).toISOString(), forecast: 1810, truth: 1900, truthObservedAt: new Date(VALID_AT * 1000).toISOString(),
      error: 90, baseline: { error: 180, kind: 'persistence_spread' }, skill: 500_000, copied: false, beatBaseline: true,
      nws: { source: 'NOAA National Weather Service forecast', forecast: 1840, error: 60, skill: 666_667, leadHours: 6, result: 'nws_beat_you' },
    });
    expect(publicPracticeScore({ ...scored, nws_err_fp: '95' }, 'revealed', 'temperature_c', null)).toMatchObject({ nws: { result: 'you_beat_nws' } });
    expect(publicPracticeScore({ ...scored, nws_fp: null, nws_err_fp: null, nws_skill: null }, 'revealed', 'temperature_c', null)).toMatchObject({ nws: null });
    expect(PRACTICE_NOTE).toMatch(/Nothing is paid yet/);
    expect(PRACTICE_NOTE).not.toMatch(/[0-9]|WRF|earn/i);
  });

  it('pending until 20 minutes after the target time, then waiting for a reading, then unscored', () => {
    const until = new Date((VALID_AT + SCORE_DELAY_S) * 1000).toISOString();
    expect(publicPracticeScore(null, 'revealed', 'temperature_c', VALID_AT)).toMatchObject({ status: 'pending', reason: null, text: `pending until ${until}`, pendingUntil: until, paid: false });
    expect(publicPracticeScore({ status: 'pending', valid: String(VALID_AT) }, 'revealed', 'temperature_c', 1)).toMatchObject({
      status: 'pending', reason: 'waiting_for_reading', pendingUntil: until, giveUpAt: new Date((VALID_AT + GIVE_UP_S) * 1000).toISOString(),
    });
    expect(publicPracticeScore({ status: 'unscored', reason: 'no_reading', valid: String(VALID_AT), forecast_fp: '1810' }, 'revealed', 'temperature_c', null))
      .toMatchObject({ status: 'unscored', reason: 'no_reading', text: 'unscored: no reading', forecast: 1810, truth: null });
    expect(publicPracticeScore({ status: 'unscored', reason: 'no_baseline', valid: String(VALID_AT) }, 'revealed', 'temperature_c', null))
      .toMatchObject({ text: 'unscored: not enough earlier readings for a baseline' });
    expect(publicPracticeScore(null, 'failed', 'temperature_c', VALID_AT)).toBeNull();
    expect(publicPracticeScore(null, 'revealed', 'humidity_pct', VALID_AT)).toBeNull();
  });

  it('carries no station id, coordinates, wallet or payout field', () => {
    const text = JSON.stringify(publicPracticeScore(scored, 'revealed', 'temperature_c', VALID_AT));
    expect(text).not.toMatch(/station|lat|lon|owner|payout|address|amount|reward/i);
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
    const res = await request(app(store([{
      commit_id: 'a1'.repeat(32), status: 'scored', reason: null, unit: 'temp_c_centi', valid: String(VALID_AT), forecast_fp: '1810', truth_fp: '1900',
      truth_observed: String(VALID_AT), err_fp: '90', ref_fp: '180', ref_kind: 'persistence_spread', copied: false, skill: 500000, beat_baseline: true,
      nws_fp: null, nws_err_fp: null, nws_skill: null, nws_lead_hours: null,
    }]).query)).get('/api/forecasts/mine');
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

  async function insertForecast(commitId: string, over: { value?: number; variable?: string; day?: string; status?: string; height?: number | null } = {}) {
    await sql.unsafe(`INSERT INTO website_forecasts (commit_id, forecaster, station_id, station_alias, variable, value, horizon_hours, issued_at, valid_at,
        forecast_day, data, nonce, commit_timestamp, manifest, auth_pubkey, auth_signature, status, committed_at_height, record_filed)
      VALUES ($1, $2, $3, 'st_0123456789ab', $4, $5, $6, to_timestamp($7), to_timestamp($8), $9::date, '{}', 'n', $14, '{}', $10, $11, $12, $13, true)`,
    [commitId, WALLET, STATION, over.variable ?? 'temperature_c', over.value ?? 18.1, LEAD, COMMITTED_AT - 120, COMMITTED_AT - 120 + LEAD * 3600,
      over.day ?? '2027-01-15', 'ab'.repeat(32), 'cd'.repeat(64), over.status ?? 'revealed', over.height === undefined ? COMMIT_HEIGHT : over.height,
      COMMITTED_AT - 120]);
  }
  const practice = async (rows: any[]) => {
    const scores = await readPracticeScores(query, rows.map((r) => r.commit_id));
    return new Map<string, unknown>(rows.map((r) => [r.commit_id, publicPracticeScore(scores.get(r.commit_id) ?? null, r.status, r.variable, Math.floor(new Date(r.valid_at).getTime() / 1000))]));
  };

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
  beforeEach(async () => { await sql.unsafe('TRUNCATE website_forecast_scores, website_forecasts'); });

  it('scores a revealed forecast once, stores integers, and lists it with the wallet\'s forecasts', async () => {
    await insertForecast(COMMIT_ID);
    await sql.unsafe(`INSERT INTO forecast_verification_noaa_reference (station_id, issued_hour, valid_hour, temperature_c, humidity_pct, source)
      VALUES ($1, to_timestamp($2), to_timestamp($3), 18.4, 50, 'nws:test')`, [STATION, Math.floor((COMMITTED_AT - 3600) / 3600) * 3600, Math.floor(VALID_AT / 3600) * 3600]);
    const node = fakeNode(tipAt(NOW), ramp());
    expect(await scoreWebsiteForecasts({ ...fast(), query, get: node.get, nowSec: NOW })).toMatchObject({ scored: 1, unscored: 0, waiting: 0, retry: 0 });
    const [row] = await sql.unsafe('SELECT * FROM website_forecast_scores');
    expect(row).toMatchObject({
      commit_id: COMMIT_ID, status: 'scored', reason: null, unit: 'temp_c_centi', valid_at_source: 'chain', forecast_fp: '1810', truth_fp: '1900', err_fp: '90',
      ref_fp: '180', ref_kind: 'persistence_spread', mean24_fp: '1357', last_fp: '1715', window_samples: 24, tol: 5, copied: false, skill: 500000,
      beat_baseline: true, nws_fp: '1840', nws_err_fp: '60', nws_skill: 666667, attempts: 1,
    });
    expect(Math.floor(new Date(row.valid_at).getTime() / 1000)).toBe(VALID_AT);
    // A scored forecast is final: a later pass neither selects nor rewrites it.
    const before = { ...node.calls };
    expect(await scoreWebsiteForecasts({ ...fast(), query, get: node.get, nowSec: NOW + 7200 })).toMatchObject({ scored: 0, unscored: 0, waiting: 0, retry: 0 });
    expect(node.calls).toEqual(before);
    const mine = await listMine(query, WALLET, 50, practice);
    expect(mine.length).toBe(1);
    expect(mine[0].practiceScore).toMatchObject({ status: 'scored', forecast: 1810, truth: 1900, error: 90, baseline: { error: 180 }, skill: 500000, beatBaseline: true, nws: { result: 'nws_beat_you' } });
    expect((await listMine(query, WALLET))[0]).not.toHaveProperty('practiceScore');
  });

  it('pending is retried no sooner than 30 minutes later, then becomes scored or unscored', async () => {
    await insertForecast(COMMIT_ID);
    const gap = ramp(VALID_AT + 86_400 + 7200, (j) => j >= 178 && j <= 182);
    expect(await scoreWebsiteForecasts({ ...fast(), query, get: fakeNode(tipAt(NOW), gap).get, nowSec: NOW })).toMatchObject({ waiting: 1 });
    expect((await sql.unsafe('SELECT status, attempts, scored_at FROM website_forecast_scores'))[0]).toMatchObject({ status: 'pending', attempts: 1, scored_at: null });
    expect((await listMine(query, WALLET, 50, practice))[0].practiceScore).toMatchObject({ status: 'pending', reason: 'waiting_for_reading' });
    // Ten minutes later: not selected again.
    const soon = fakeNode(tipAt(NOW + 600), gap);
    expect(await scoreWebsiteForecasts({ ...fast(), query, get: soon.get, nowSec: NOW + 600 })).toMatchObject({ scored: 0, unscored: 0, waiting: 0, retry: 0 });
    expect(soon.calls).toEqual({ blocks: 0, observations: 0 });
    const late = VALID_AT + GIVE_UP_S + 60;
    expect(await scoreWebsiteForecasts({ ...fast(), query, get: fakeNode(tipAt(late), gap).get, nowSec: late })).toMatchObject({ unscored: 1 });
    expect((await sql.unsafe('SELECT status, reason, attempts, skill FROM website_forecast_scores'))[0]).toMatchObject({ status: 'unscored', reason: 'no_reading', attempts: 2, skill: null });
    expect((await listMine(query, WALLET, 50, practice))[0].practiceScore).toMatchObject({ status: 'unscored', text: 'unscored: no reading' });
  });

  it('a pending forecast is scored when its reading shows up; only revealed forecasts are looked at', async () => {
    await insertForecast(COMMIT_ID);
    await insertForecast('d4'.repeat(32), { status: 'failed', day: '2027-01-16' });
    await insertForecast('e5'.repeat(32), { status: 'committed', day: '2027-01-17' });
    const gap = ramp(VALID_AT + 7200, (j) => j >= 178 && j <= 182);
    await scoreWebsiteForecasts({ ...fast(), query, get: fakeNode(tipAt(NOW), gap).get, nowSec: NOW });
    expect(await scoreWebsiteForecasts({ ...fast(), query, get: fakeNode(tipAt(NOW + 3600), ramp()).get, nowSec: NOW + 3600 })).toMatchObject({ scored: 1 });
    const rows = await sql.unsafe('SELECT commit_id, status, attempts, skill FROM website_forecast_scores');
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ commit_id: COMMIT_ID, status: 'scored', attempts: 2, skill: 500000 });
  });
});
