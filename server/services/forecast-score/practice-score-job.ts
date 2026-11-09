/**
 * Practice scores for website forecasts (the site-side twin of the chain's planned skill pay).
 *
 * For each website forecast that is revealed on chain and whose target time is at least 20 minutes past:
 *   - target time = the commit block's time + the lead (what the chain will use), or the draft's own target
 *     time when the commit height is not known;
 *   - truth = the station's chain reading nearest the target time, at most 15 minutes away
 *     (core4 GET /transactions/contributions/{station}/observations, Reader bearer; synthetic readings never count);
 *   - reference = from the station's own hourly readings over the 24 hours before the commit;
 *   - score = practice-score.ts (integers only), stored in website_forecast_scores (migration 0044).
 *
 * Also recorded when available: how NOAA's National Weather Service forecast for the same station and hour,
 * captured BEFORE the forecast was made by the forecast verification job, scored under the same rule
 * (temperature only; api.weather.gov data is U.S. Government work in the public domain).
 *
 * Honest by construction: no reading within 15 minutes => stays pending and is retried until 24 hours after
 * the target time, then `unscored: no_reading`. Fewer than two hourly readings before the commit =>
 * `unscored: no_baseline`. Nothing is filled in, and nothing here is paid or feeds rewards.
 *
 * OFF unless WEBSITE_FORECAST_ENABLED=true and WEBSITE_FORECAST_SCORE_ENABLED=true. Needs WRFCOIN_READER_TOKEN.
 * Logs carry counts only, never addresses, stations, coordinates or values.
 */
import type { Core4Get } from '../forecast-commit-record.js';
import {
  blockTime, chainTip, firstHeightAtOrAfter, noaaReferenceFor, stationReadings, HOUR_S, type ChainReading, type Query,
} from '../forecast-verification/observed-verification.js';
import { websiteForecastEnabled } from '../website-forecast/website-forecast.js';
import {
  DEFAULT_COPY_TOLERANCE, FIXED_POINT_UNITS, SCORE_PRECISION, TRUTH_MAX_DISTANCE_S, WINDOW_HOURS, hourlyWindow, lastReadingBefore,
  nearestReading, numberToFixedPoint, ratioSkill, referenceFromWindow, skillScore, type Reading, type ScoredVariable,
} from './practice-score.js';

export const websiteForecastScoreEnabled = () => websiteForecastEnabled() && process.env.WEBSITE_FORECAST_SCORE_ENABLED === 'true';

/** A reading takes a few blocks to land and reach its attestations: score no sooner than this after the target time. */
export const SCORE_DELAY_S = 20 * 60;
/** After this long with no reading the forecast is `unscored`. */
export const GIVE_UP_S = 24 * HOUR_S;
const RETRY_S = 30 * 60;
/** Forecasts scored per pass. One forecast costs about 60 node reads (24 hours of blocks, 64 heights per call). */
export const PRACTICE_SCORE_BATCH = 3;
const WINDOW_OBS_CALLS = 40;
const TRUTH_OBS_CALLS = 4;
export const PRACTICE_NOTE = 'Practice score. Nothing is paid yet: pay starts when skill pay is switched on.';

export interface PracticeScoreDeps { query: Query; get: Core4Get; nowSec: number }
export interface PassCounts { scored: number; unscored: number; waiting: number; retry: number }

/** Block reads repeat inside one pass (every search starts from the same tip): read each height once. */
function memoBlocks(get: Core4Get): Core4Get {
  const seen = new Map<string, ReturnType<Core4Get>>();
  return (path, query) => {
    if (query || !path.startsWith('/chain/block/')) return get(path, query);
    let hit = seen.get(path);
    if (!hit) { hit = get(path); seen.set(path, hit); hit.catch(() => seen.delete(path)); }
    return hit;
  };
}

const toReadings = (rows: ChainReading[], variable: ScoredVariable): Reading[] => {
  const out: Reading[] = [];
  for (const r of rows) {
    if (r.provenanceClass === 'synthetic') continue;
    const value = numberToFixedPoint(r.values[variable]);
    if (value !== null) out.push({ observedAt: r.observedAt, value, id: r.commitId });
  }
  return out;
};

async function readingsBetween(get: Core4Get, stationId: string, tip: { height: number; time: number }, fromTime: number, toTime: number, maxCalls: number) {
  const from = await firstHeightAtOrAfter(get, fromTime, tip);
  // A reading lands a few blocks after it is observed: read SCORE_DELAY_S of blocks past the window.
  const to = Math.min(tip.height, (await firstHeightAtOrAfter(get, toTime + SCORE_DELAY_S, tip)) - 1);
  return from > to ? [] : stationReadings(get, stationId, from, to, maxCalls);
}

const PENDING_SQL = `SELECT w.commit_id, w.station_id, w.variable, w.value, w.horizon_hours, w.committed_at_height,
    extract(epoch FROM w.issued_at)::bigint AS issued, extract(epoch FROM w.valid_at)::bigint AS valid
  FROM website_forecasts w LEFT JOIN website_forecast_scores s ON s.commit_id = w.commit_id
  WHERE w.status = 'revealed' AND w.valid_at <= to_timestamp($1) - make_interval(secs => $2)
    AND (s.commit_id IS NULL OR (s.status = 'pending' AND s.last_attempt_at <= to_timestamp($1) - make_interval(secs => $3)))
  ORDER BY s.last_attempt_at ASC NULLS FIRST, w.valid_at ASC LIMIT $4`;

const UPSERT_SQL = `INSERT INTO website_forecast_scores
    (commit_id, status, reason, unit, valid_at, valid_at_source, forecast_fp, truth_fp, truth_observed_at, err_fp, ref_fp, ref_kind,
     mean24_fp, last_fp, window_samples, tol, copied, skill, beat_baseline, nws_fp, nws_err_fp, nws_skill, nws_lead_hours,
     attempts, last_attempt_at, scored_at)
  VALUES ($1, $2, $3, $4, to_timestamp($5), $6, $7, $8, to_timestamp($9), $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23,
     1, to_timestamp($24), CASE WHEN $2 = 'pending' THEN NULL ELSE to_timestamp($24) END)
  ON CONFLICT (commit_id) DO UPDATE SET status = EXCLUDED.status, reason = EXCLUDED.reason, valid_at = EXCLUDED.valid_at,
     valid_at_source = EXCLUDED.valid_at_source, forecast_fp = EXCLUDED.forecast_fp, truth_fp = EXCLUDED.truth_fp,
     truth_observed_at = EXCLUDED.truth_observed_at, err_fp = EXCLUDED.err_fp, ref_fp = EXCLUDED.ref_fp, ref_kind = EXCLUDED.ref_kind,
     mean24_fp = EXCLUDED.mean24_fp, last_fp = EXCLUDED.last_fp, window_samples = EXCLUDED.window_samples, tol = EXCLUDED.tol,
     copied = EXCLUDED.copied, skill = EXCLUDED.skill, beat_baseline = EXCLUDED.beat_baseline, nws_fp = EXCLUDED.nws_fp,
     nws_err_fp = EXCLUDED.nws_err_fp, nws_skill = EXCLUDED.nws_skill, nws_lead_hours = EXCLUDED.nws_lead_hours,
     attempts = website_forecast_scores.attempts + 1, last_attempt_at = EXCLUDED.last_attempt_at, scored_at = EXCLUDED.scored_at
  WHERE website_forecast_scores.status = 'pending'`;

interface ScoreRow {
  status: 'pending' | 'scored' | 'unscored'; reason?: 'no_reading' | 'no_baseline'; forecast?: bigint; truth?: bigint; truthObservedAt?: number;
  err?: bigint; ref?: bigint; refKind?: string; mean24?: bigint; last?: bigint; samples?: number; copied?: boolean; skill?: bigint; beat?: boolean;
  nws?: bigint; nwsErr?: bigint; nwsSkill?: bigint; nwsLead?: number;
}

const text = (v: bigint | undefined) => (v === undefined ? null : v.toString());

async function save(query: Query, commitId: string, unit: string, validAt: number, source: string, nowSec: number, r: ScoreRow) {
  await query(UPSERT_SQL, [commitId, r.status, r.reason ?? null, unit, validAt, source, text(r.forecast), text(r.truth), r.truthObservedAt ?? null,
    text(r.err), text(r.ref), r.refKind ?? null, text(r.mean24), text(r.last), r.samples ?? null,
    r.status === 'scored' ? Number(DEFAULT_COPY_TOLERANCE) : null, r.copied ?? null, r.skill === undefined ? null : Number(r.skill), r.beat ?? null,
    text(r.nws), text(r.nwsErr), r.nwsSkill === undefined ? null : Number(r.nwsSkill), r.nwsLead ?? null, nowSec]);
}

/** One scoring pass. A node failure leaves the forecast pending for a later pass. */
export async function scoreWebsiteForecasts({ query, get: rawGet, nowSec }: PracticeScoreDeps): Promise<PassCounts> {
  const counts: PassCounts = { scored: 0, unscored: 0, waiting: 0, retry: 0 };
  const rows = (await query(PENDING_SQL, [nowSec, SCORE_DELAY_S, RETRY_S, PRACTICE_SCORE_BATCH])).rows;
  if (rows.length === 0) return counts;
  const get = memoBlocks(rawGet);
  let tip: { height: number; time: number };
  try { tip = await chainTip(get); } catch { counts.retry = rows.length; return counts; }
  for (const row of rows) {
    const variable = row.variable as ScoredVariable;
    const unit = FIXED_POINT_UNITS[variable];
    const forecast = numberToFixedPoint(Number(row.value));
    const lead = Number(row.horizon_hours);
    if (!unit || forecast === null || !Number.isInteger(lead) || lead < 1) continue;
    try {
      // The chain will take the target time from the commit block, not from the forecaster.
      const height = row.committed_at_height === null || row.committed_at_height === undefined ? null : Number(row.committed_at_height);
      const fromChain = height !== null && Number.isSafeInteger(height) && height >= 1 && height <= tip.height;
      const committedAt = fromChain ? await blockTime(get, height) : Number(row.issued);
      const validAt = fromChain ? committedAt + lead * HOUR_S : Number(row.valid);
      const source = fromChain ? 'chain' : 'draft';
      if (nowSec < validAt + SCORE_DELAY_S || tip.time < validAt + SCORE_DELAY_S) { counts.waiting += 1; continue; }

      const near = toReadings(await readingsBetween(get, row.station_id, tip, validAt - TRUTH_MAX_DISTANCE_S, validAt + TRUTH_MAX_DISTANCE_S, TRUTH_OBS_CALLS), variable);
      const truth = nearestReading(near, validAt);
      if (!truth) {
        const gaveUp = nowSec - validAt > GIVE_UP_S;
        await save(query, row.commit_id, unit, validAt, source, nowSec, gaveUp ? { status: 'unscored', reason: 'no_reading', forecast } : { status: 'pending', forecast });
        if (gaveUp) counts.unscored += 1; else counts.waiting += 1;
        continue;
      }
      const before = toReadings(await readingsBetween(get, row.station_id, tip, committedAt - WINDOW_HOURS * HOUR_S, committedAt, WINDOW_OBS_CALLS), variable);
      const reference = referenceFromWindow(hourlyWindow(before, committedAt), lead);
      const last = lastReadingBefore(before, committedAt);
      if (!reference || !last) {
        await save(query, row.commit_id, unit, validAt, source, nowSec,
          { status: 'unscored', reason: 'no_baseline', forecast, truth: truth.value, truthObservedAt: truth.observedAt });
        counts.unscored += 1;
        continue;
      }
      const score = skillScore({ forecast, truth: truth.value, reference: reference.reference, mean24: reference.mean24, last: last.value });
      const result: ScoreRow = {
        status: 'scored', forecast, truth: truth.value, truthObservedAt: truth.observedAt, err: score.err, ref: reference.reference, refKind: reference.kind,
        mean24: reference.mean24, last: last.value, samples: reference.samples, copied: score.copy, skill: score.skill, beat: score.beatBaseline,
      };
      if (variable === 'temperature_c') {
        try {
          const nws = await noaaReferenceFor(query, row.station_id, Math.floor(validAt / HOUR_S) * HOUR_S, committedAt);
          const value = nws ? numberToFixedPoint(nws.temperatureC) : null;
          if (nws && value !== null) {
            // The same ratio, without the copy check (that rule is about the forecaster, not the reference forecast).
            const nwsErr = value > truth.value ? value - truth.value : truth.value - value;
            Object.assign(result, { nws: value, nwsErr, nwsSkill: ratioSkill(nwsErr, reference.reference), nwsLead: (nws.validHour - nws.issuedHour) / HOUR_S });
          }
        } catch { /* no capture table or no capture: the comparison is simply absent */ }
      }
      await save(query, row.commit_id, unit, validAt, source, nowSec, result);
      counts.scored += 1;
    } catch {
      // The node could not answer: note the attempt, so one unreadable forecast never blocks the others.
      counts.retry += 1;
      try { await save(query, row.commit_id, unit, Number(row.valid), 'draft', nowSec, { status: 'pending', forecast }); } catch { /* next pass */ }
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------------------------------

const SCORE_COLUMNS = `status, reason, unit, extract(epoch FROM valid_at)::bigint AS valid, forecast_fp, truth_fp,
  extract(epoch FROM truth_observed_at)::bigint AS truth_observed, err_fp, ref_fp, ref_kind, copied, skill, beat_baseline,
  nws_fp, nws_err_fp, nws_skill, nws_lead_hours`;

const int = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const isoSec = (v: unknown) => (v === null || v === undefined ? null : new Date(Number(v) * 1000).toISOString());

/**
 * What the site shows. All values are fixed-point integers in `unit` (temp_c_centi = 0.01 °C, pressure_pa = Pa);
 * `skill` is in millionths. `forecastStatus` is the forecast's chain progress; `draftValidAt` its own target time.
 */
export function publicPracticeScore(score: any | null, forecastStatus: string, variable: string, draftValidAtSec: number | null) {
  const unit = (FIXED_POINT_UNITS as Record<string, string>)[variable] ?? null;
  if (!unit || forecastStatus === 'failed') return null;
  const base = { paid: false, note: PRACTICE_NOTE, unit, skillMax: Number(SCORE_PRECISION) };
  if (!score || score.status === 'pending') {
    const validAt = score ? Number(score.valid) : draftValidAtSec;
    const until = validAt === null ? null : isoSec(validAt + SCORE_DELAY_S);
    const waitingForReading = Boolean(score);
    return {
      ...base, status: 'pending' as const, reason: waitingForReading ? 'waiting_for_reading' : null,
      text: waitingForReading ? 'pending: waiting for a station reading' : `pending until ${until ?? 'the target time'}`,
      pendingUntil: until, giveUpAt: validAt === null ? null : isoSec(validAt + GIVE_UP_S),
    };
  }
  if (score.status === 'unscored') {
    return {
      ...base, status: 'unscored' as const, reason: score.reason,
      text: score.reason === 'no_baseline' ? 'unscored: not enough earlier readings for a baseline' : 'unscored: no reading',
      validAt: isoSec(score.valid), forecast: int(score.forecast_fp), truth: int(score.truth_fp), truthObservedAt: isoSec(score.truth_observed),
    };
  }
  const skill = int(score.skill);
  const nwsSkill = int(score.nws_skill);
  const err = int(score.err_fp);
  const nwsErr = int(score.nws_err_fp);
  return {
    ...base, status: 'scored' as const, reason: null, text: 'scored',
    validAt: isoSec(score.valid), forecast: int(score.forecast_fp), truth: int(score.truth_fp), truthObservedAt: isoSec(score.truth_observed),
    error: err, baseline: { error: int(score.ref_fp), kind: score.ref_kind },
    skill, copied: score.copied === true, beatBaseline: score.beat_baseline === true,
    nws: nwsErr === null || err === null ? null : {
      source: 'NOAA National Weather Service forecast', forecast: int(score.nws_fp), error: nwsErr, skill: nwsSkill, leadHours: int(score.nws_lead_hours),
      result: err < nwsErr ? 'you_beat_nws' : err > nwsErr ? 'nws_beat_you' : 'tie',
    },
  };
}

/** Score rows by commit id (empty when none). */
export async function readPracticeScores(query: Query, commitIds: string[]): Promise<Map<string, any>> {
  const out = new Map<string, any>();
  if (commitIds.length === 0) return out;
  const rows = (await query(`SELECT commit_id, ${SCORE_COLUMNS} FROM website_forecast_scores WHERE commit_id = ANY($1::text[])`, [commitIds])).rows;
  for (const row of rows) out.set(String(row.commit_id), row);
  return out;
}

// ---------------------------------------------------------------------------------------------------
// Job
// ---------------------------------------------------------------------------------------------------

type Logger = { info: (m: string, meta?: object) => void; warn: (m: string, meta?: object) => void };
const DEFAULT_INTERVAL_MS = 5 * 60_000;

export async function startWebsiteForecastScoreJob(deps: { query?: Query; get?: Core4Get; now?: () => number; logger?: Logger } = {}): Promise<boolean> {
  if (!websiteForecastScoreEnabled()) return false;
  const raw = Number(process.env.WEBSITE_FORECAST_SCORE_INTERVAL_MS);
  const intervalMs = Number.isInteger(raw) && raw >= 60_000 ? raw : DEFAULT_INTERVAL_MS;
  const job = await import('../forecast-verification/observed-verification-job.js');
  const query = deps.query ?? await job.defaultQuery();
  const get = deps.get ?? await job.defaultCore4Get();
  const now = deps.now ?? Date.now;
  let running = false;
  const tick = () => {
    if (running || !websiteForecastScoreEnabled()) return;
    running = true;
    scoreWebsiteForecasts({ query, get, nowSec: Math.floor(now() / 1000) })
      .then((c) => { if (c.scored + c.unscored + c.retry > 0) deps.logger?.info('website forecast: practice score pass', c); })
      .catch(() => deps.logger?.warn('website forecast: practice score pass failed (details withheld)'))
      .finally(() => { running = false; });
  };
  setTimeout(tick, 45_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
  deps.logger?.info('website forecast: practice score job started', { intervalMs });
  return true;
}
