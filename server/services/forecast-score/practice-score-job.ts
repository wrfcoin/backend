/**
 * Practice scores for website forecasts (the site-side twin of the chain's planned skill pay).
 *
 * The rule is written out in practice-score.ts ("THE RULE") and in contract-fixtures/forecast-skill-vectors.json.
 * In short, for each website forecast that is revealed on chain:
 *   - target time = the commit block's time + the lead (what the chain will use), or the draft's own target
 *     time when the commit height is not known;
 *   - nothing is scored before the chain tip's time has reached target + 35 minutes: 15 minutes of readings
 *     plus 20 minutes for them to land and reach quorum. The candidate readings are then a closed set, so the
 *     score does not depend on when this job happened to run;
 *   - truth = the station's quorum-attested chain reading nearest the target time, at most 15 minutes away,
 *     landed in a block before target + 35 minutes. Its commit id and block height are stored with the score;
 *   - reference and copy check = the station's own quorum-attested readings observed in the 24 hours before the
 *     commit AND landed in a block below the commit's height: only what the forecaster could have seen;
 *   - synthetic readings and out-of-range values never count;
 *   - score = practice-score.ts (integers only), stored in website_forecast_scores (migration 0044).
 *
 * Also recorded when available: how NOAA's National Weather Service forecast for the same station and hour,
 * captured by the forecast verification job BEFORE the commit time, scored under the same ratio (temperature
 * only; api.weather.gov data is U.S. Government work in the public domain).
 *
 * Honest by construction: no reading => pending, retried every 30 minutes until 24 hours after the target time,
 * then `unscored: no_reading`. A node that cannot be read => pending with its own reason, then
 * `unscored: node_unavailable` after the same 24 hours. Fewer than 12 hourly samples before the commit =>
 * `unscored: no_baseline`. Nothing is filled in, and nothing here is paid or feeds rewards.
 *
 * Node reads are paced: at most WEBSITE_FORECAST_SCORE_READS_PER_MIN (default 20, 1 to 60) a minute in this
 * process, because the node's read limiter is shared with the backend's other reads. Blocks and 64-height
 * reading chunks are read once per pass and shared between forecasts. A 429 from the node stops the pass,
 * marks nothing, and the scorer then stays away for 5 minutes, doubling each time up to an hour. A forecast
 * whose result cannot be written is left alone the same way, so it does not cost node reads every pass.
 *
 * OFF unless WEBSITE_FORECAST_ENABLED=true and WEBSITE_FORECAST_SCORE_ENABLED=true. Needs WRFCOIN_READER_TOKEN.
 * Logs carry counts only, never addresses, stations, coordinates or values.
 */
import type { Core4Get } from '../forecast-commit-record.js';
import {
  blockTime, chainTip, firstHeightAtOrAfter, stationReadings, HOUR_S, type ChainReading, type Query,
} from '../forecast-verification/observed-verification.js';
import { websiteForecastEnabled } from '../website-forecast/website-forecast.js';
import {
  DEFAULT_COPY_TOLERANCE, FIXED_POINT_UNITS, SCORE_DELAY_S, SCORE_PRECISION, TRUTH_MAX_DISTANCE_S, WINDOW_HOURS, countsAsReading, hourlyWindow, inRange,
  isScoredVariable, lastReadingBefore, nearestReading, numberToFixedPoint, ratioSkill, referenceFromWindow, skillScore,
  type Reading, type ScoredVariable,
} from './practice-score.js';

export { SCORE_DELAY_S };
export const websiteForecastScoreEnabled = () => websiteForecastEnabled() && process.env.WEBSITE_FORECAST_SCORE_ENABLED === 'true';

/** After this long past the target time with no reading (or no answer from the node) the forecast is `unscored`. */
export const GIVE_UP_S = 24 * HOUR_S;
const RETRY_S = 30 * 60;
/** Forecasts scored per pass. One forecast costs about 60 node reads (24 hours of blocks, 64 heights per call). */
export const PRACTICE_SCORE_BATCH = 3;
/** core4 get_station_observations walks at most 64 heights per call: readings are read and shared in chunks of that size. */
const CHUNK_HEIGHTS = 64;
const CHUNK_OBS_CALLS = 4;
export const DEFAULT_READS_PER_MIN = 20;
/** After a 429 the scorer stays away this long, doubling on each further 429, up to BACKOFF_MAX_MS. */
export const BACKOFF_BASE_MS = 5 * 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
export const PRACTICE_NOTE = 'Practice score. Nothing is paid for it.';

export function readsPerMinute(raw: string | undefined = process.env.WEBSITE_FORECAST_SCORE_READS_PER_MIN): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : DEFAULT_READS_PER_MIN;
}

/**
 * Shared between passes (one per process), so the ceiling also holds across the end of one pass and the start
 * of the next, and a 429 is remembered.
 */
export interface PaceState {
  nextReadAt: number; busyStreak: number; resumeAt: number;
  /** Forecasts whose result could not be written: not read from the node again before `retryAt` (in memory). */
  saveFailures: Map<string, { count: number; retryAt: number }>;
}
export const newPaceState = (): PaceState => ({ nextReadAt: 0, busyStreak: 0, resumeAt: 0, saveFailures: new Map() });
class NodeBusy extends Error { constructor() { super('node read limit'); } }

/**
 * At most `perMin` node reads a minute: reads are spaced 60 s / perMin apart. After a 429 every further read
 * in this pass is refused without reaching the node.
 */
function paced(get: Core4Get, perMin: number, state: PaceState, now: () => number, sleep: (ms: number) => Promise<void>) {
  const gapMs = Math.ceil(60_000 / perMin);
  const status = { limited: false, reads: 0 };
  const pacedGet: Core4Get = async (path, query) => {
    if (status.limited) throw new NodeBusy();
    const wait = state.nextReadAt - now();
    if (wait > 0) await sleep(wait);
    state.nextReadAt = Math.max(now(), state.nextReadAt) + gapMs;
    status.reads += 1;
    const reply = await get(path, query);
    if (reply.status === 429) { status.limited = true; throw new NodeBusy(); }
    return reply;
  };
  return { get: pacedGet, status };
}

export interface PracticeScoreDeps {
  query: Query; get: Core4Get; nowSec: number;
  /** Pacing (defaults: the env ceiling, a fresh state, the real clock and timer). */
  readsPerMin?: number; pace?: PaceState; now?: () => number; sleep?: (ms: number) => Promise<void>;
}
export interface PassCounts {
  scored: number; unscored: number; waiting: number; retry: number;
  /** Rows that cannot be scored at all (unknown variable, unreadable value): never silently dropped. */
  skipped: number;
  /** A result that could not be written. The forecast is left alone for 5 minutes, doubling up to an hour. */
  saveErrors: number;
  /** Forecasts not looked at this pass because their last result could not be written. */
  deferred: number;
  nodeReads: number; nodeBusy: boolean;
  /** The pass did not run: the node answered 429 recently. */
  backingOff: boolean;
}

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

/**
 * Rule 3 and rule 1: quorum-attested, not synthetic, in range. Also returns each reading's landing height.
 * A reading the node no longer holds a provenance class for (null) counts: the node drops that record some
 * time after the reading is settled, so requiring an explicit class would exclude real readings.
 */
function toReadings(rows: ChainReading[], variable: ScoredVariable): { readings: Reading[]; heights: Map<string, number> } {
  const readings: Reading[] = [];
  const heights = new Map<string, number>();
  for (const r of rows) {
    const value = numberToFixedPoint(r.values[variable]);
    if (value === null || !countsAsReading(variable, { value, hasQuorum: r.hasQuorum, provenance: r.provenanceClass })) continue;
    readings.push({ observedAt: r.observedAt, value, id: r.commitId });
    heights.set(r.commitId, r.height);
  }
  return { readings, heights };
}

type ChunkCache = Map<string, Promise<ChainReading[]>>;

/**
 * The station's readings landed in blocks [from, to], read in fixed 64-height chunks so forecasts for the same
 * station share them within a pass (their 24-hour windows overlap). A chunk that reaches past the tip is not kept.
 */
async function readingsInHeights(get: Core4Get, chunks: ChunkCache, stationId: string, tipHeight: number, from: number, to: number): Promise<ChainReading[]> {
  const out: ChainReading[] = [];
  if (from > to) return out;
  for (let base = Math.floor((from - 1) / CHUNK_HEIGHTS) * CHUNK_HEIGHTS; base < to; base += CHUNK_HEIGHTS) {
    const end = Math.min(base + CHUNK_HEIGHTS, tipHeight);
    const key = `${stationId}|${base}`;
    let chunk = chunks.get(key);
    if (!chunk) {
      chunk = stationReadings(get, stationId, base + 1, end, CHUNK_OBS_CALLS);
      if (base + CHUNK_HEIGHTS <= tipHeight) { chunks.set(key, chunk); chunk.catch(() => chunks.delete(key)); }
    }
    for (const r of await chunk) if (r.height >= from && r.height <= to) out.push(r);
  }
  return out;
}

const PENDING_SQL = `SELECT w.commit_id, w.station_id, w.variable, w.value, w.horizon_hours, w.committed_at_height,
    extract(epoch FROM w.issued_at)::bigint AS issued, extract(epoch FROM w.valid_at)::bigint AS valid
  FROM website_forecasts w LEFT JOIN website_forecast_scores s ON s.commit_id = w.commit_id
  WHERE w.status = 'revealed' AND w.valid_at <= to_timestamp($1) - make_interval(secs => $2)
    AND (s.commit_id IS NULL OR (s.status = 'pending' AND s.last_attempt_at <= to_timestamp($1) - make_interval(secs => $3)))
  ORDER BY s.last_attempt_at ASC NULLS FIRST, w.valid_at ASC LIMIT $4`;

export type UnscoredReason = 'no_reading' | 'no_baseline' | 'node_unavailable' | 'out_of_range';

interface ScoreRow {
  status: 'pending' | 'scored' | 'unscored';
  /** On a pending row: why it is still pending (null = no reading yet). */
  reason?: UnscoredReason;
  forecast?: bigint; truth?: bigint; truthObservedAt?: number; truthCommitId?: string; truthHeight?: number;
  err?: bigint; ref?: bigint; refKind?: string; mean24?: bigint; last?: bigint; samples?: number; copied?: boolean; skill?: bigint; beat?: boolean;
  nws?: bigint; nwsErr?: bigint; nwsSkill?: bigint; nwsLead?: number;
}

const text = (v: bigint | undefined) => (v === undefined ? null : v.toString());
const SECONDS = new Set(['valid_at', 'truth_observed_at', 'last_attempt_at']);

/** Column -> value for one result. Kept as a list so the SQL and its parameters cannot drift apart. */
function columnsFor(commitId: string, unit: string, validAt: number, source: string, nowSec: number, r: ScoreRow): Array<[string, unknown]> {
  return [
    ['commit_id', commitId], ['status', r.status], ['reason', r.reason ?? null], ['unit', unit], ['valid_at', validAt], ['valid_at_source', source],
    ['forecast_fp', text(r.forecast)], ['truth_fp', text(r.truth)], ['truth_observed_at', r.truthObservedAt ?? null],
    ['truth_commit_id', r.truthCommitId ?? null], ['truth_height', r.truthHeight ?? null],
    ['err_fp', text(r.err)], ['ref_fp', text(r.ref)], ['ref_kind', r.refKind ?? null], ['mean24_fp', text(r.mean24)], ['last_fp', text(r.last)],
    ['window_samples', r.samples ?? null], ['tol', r.status === 'scored' ? Number(DEFAULT_COPY_TOLERANCE) : null], ['copied', r.copied ?? null],
    ['skill', r.skill === undefined ? null : Number(r.skill)], ['beat_baseline', r.beat ?? null],
    ['nws_fp', text(r.nws)], ['nws_err_fp', text(r.nwsErr)], ['nws_skill', r.nwsSkill === undefined ? null : Number(r.nwsSkill)], ['nws_lead_hours', r.nwsLead ?? null],
    ['last_attempt_at', nowSec],
  ];
}

/** Insert the result, or replace a pending one. A scored or unscored row is final and is never rewritten. */
export function upsertSql(columns: string[]): string {
  const value = (c: string, i: number) => (SECONDS.has(c) ? `to_timestamp($${i + 1})` : `$${i + 1}`);
  const stamp = `$${columns.length + 1}`;
  return `INSERT INTO website_forecast_scores (${columns.join(', ')}, attempts, scored_at)
  VALUES (${columns.map(value).join(', ')}, 1, to_timestamp(${stamp}))
  ON CONFLICT (commit_id) DO UPDATE SET ${columns.filter((c) => c !== 'commit_id').map((c) => `${c} = EXCLUDED.${c}`).join(', ')},
    attempts = website_forecast_scores.attempts + 1, scored_at = EXCLUDED.scored_at
  WHERE website_forecast_scores.status = 'pending'`;
}

async function save(query: Query, commitId: string, unit: string, validAt: number, source: string, nowSec: number, r: ScoreRow) {
  const columns = columnsFor(commitId, unit, validAt, source, nowSec, r);
  // scored_at: when the row became final; null while pending.
  await query(upsertSql(columns.map(([c]) => c)), [...columns.map(([, v]) => v), r.status === 'pending' ? null : nowSec]);
}

/** NOAA's forecast for this station and hour, captured before the commit time (the capture time itself, not its hour). */
async function nwsCapturedBefore(query: Query, stationId: string, validHour: number, committedAt: number): Promise<{ temperatureC: number | null; leadHours: number } | null> {
  const row = (await query(`SELECT extract(epoch FROM issued_hour)::bigint AS issued, temperature_c FROM forecast_verification_noaa_reference
    WHERE station_id = $1 AND valid_hour = to_timestamp($2) AND captured_at < to_timestamp($3) AND issued_hour <= to_timestamp($3)
    ORDER BY issued_hour DESC LIMIT 1`, [stationId, validHour, committedAt])).rows[0];
  if (!row) return null;
  return { temperatureC: row.temperature_c === null ? null : Number(row.temperature_c), leadHours: (validHour - Number(row.issued)) / HOUR_S };
}

interface Evaluation { validAt: number; source: 'chain' | 'draft'; result: ScoreRow | 'not_due' }

/** Everything that reads the node for one forecast. Throws when the node cannot answer. */
async function evaluate(deps: { query: Query; get: Core4Get; chunks: ChunkCache; nowSec: number; tip: { height: number; time: number } },
  row: any, variable: ScoredVariable, forecast: bigint, lead: number): Promise<Evaluation> {
  const { query, get, chunks, nowSec, tip } = deps;
  // Rule 2: the chain takes the target time from the commit block, not from the forecaster.
  const known = row.committed_at_height === null || row.committed_at_height === undefined ? null : Number(row.committed_at_height);
  const fromChain = known !== null && Number.isSafeInteger(known) && known >= 1 && known <= tip.height;
  const committedAt = fromChain ? await blockTime(get, known) : Number(row.issued);
  const validAt = fromChain ? committedAt + lead * HOUR_S : Number(row.valid);
  const source = fromChain ? 'chain' as const : 'draft' as const;
  // Rule 3: the truth window must be closed on chain before anything is scored.
  if (nowSec < validAt + SCORE_DELAY_S || tip.time < validAt + SCORE_DELAY_S) return { validAt, source, result: 'not_due' };

  const truthFrom = await firstHeightAtOrAfter(get, validAt - TRUTH_MAX_DISTANCE_S, tip);
  const truthTo = (await firstHeightAtOrAfter(get, validAt + SCORE_DELAY_S, tip)) - 1; // blocks before target + 35 min
  const near = toReadings(await readingsInHeights(get, chunks, row.station_id, tip.height, truthFrom, truthTo), variable);
  const truth = nearestReading(near.readings, validAt);
  if (!truth) {
    return { validAt, source, result: nowSec - validAt > GIVE_UP_S ? { status: 'unscored', reason: 'no_reading', forecast } : { status: 'pending', forecast } };
  }
  const found = { truth: truth.value, truthObservedAt: truth.observedAt, truthCommitId: truth.id, truthHeight: near.heights.get(truth.id) };

  // Rule 3: the baseline uses only readings that had landed below the commit's height.
  const commitHeight = fromChain ? known : await firstHeightAtOrAfter(get, committedAt, tip);
  const windowFrom = await firstHeightAtOrAfter(get, committedAt - WINDOW_HOURS * HOUR_S, tip);
  const before = toReadings(await readingsInHeights(get, chunks, row.station_id, tip.height, windowFrom, commitHeight - 1), variable).readings;
  const reference = referenceFromWindow(hourlyWindow(before, committedAt), lead);
  const last = lastReadingBefore(before, committedAt);
  if (!reference || !last) return { validAt, source, result: { status: 'unscored', reason: 'no_baseline', forecast, ...found } };

  const score = skillScore({ forecast, truth: truth.value, reference: reference.reference, mean24: reference.mean24, last: last.value });
  const result: ScoreRow = {
    status: 'scored', forecast, ...found, err: score.err, ref: reference.reference, refKind: reference.kind,
    mean24: reference.mean24, last: last.value, samples: reference.samples, copied: score.copy, skill: score.skill, beat: score.beatBaseline,
  };
  if (variable === 'temperature_c') {
    try {
      const nws = await nwsCapturedBefore(query, row.station_id, Math.floor(validAt / HOUR_S) * HOUR_S, committedAt);
      const value = nws ? numberToFixedPoint(nws.temperatureC) : null;
      if (nws && value !== null && inRange(variable, value)) {
        // The same ratio, without the copy check (that rule is about the forecaster, not the reference forecast).
        const nwsErr = value > truth.value ? value - truth.value : truth.value - value;
        Object.assign(result, { nws: value, nwsErr, nwsSkill: ratioSkill(nwsErr, reference.reference), nwsLead: nws.leadHours });
      }
    } catch { /* no capture table or no capture: the comparison is simply absent */ }
  }
  return { validAt, source, result };
}

/** One scoring pass. */
export async function scoreWebsiteForecasts(deps: PracticeScoreDeps): Promise<PassCounts> {
  const { query, nowSec } = deps;
  const now = deps.now ?? Date.now;
  const pace = deps.pace ?? newPaceState();
  const counts: PassCounts = { scored: 0, unscored: 0, waiting: 0, retry: 0, skipped: 0, saveErrors: 0, deferred: 0, nodeReads: 0, nodeBusy: false, backingOff: false };
  if (now() < pace.resumeAt) { counts.backingOff = true; return counts; }
  const selected = (await query(PENDING_SQL, [nowSec, SCORE_DELAY_S, RETRY_S, PRACTICE_SCORE_BATCH])).rows;
  // A forecast whose last result could not be written is left alone until its retry time: no node reads for it.
  const rows = selected.filter((row) => (pace.saveFailures.get(row.commit_id)?.retryAt ?? 0) <= now());
  counts.deferred = selected.length - rows.length;
  if (rows.length === 0) return counts;
  const pacer = paced(deps.get, deps.readsPerMin ?? readsPerMinute(), pace, now,
    deps.sleep ?? ((ms) => new Promise<void>((resolve) => { setTimeout(resolve, ms); })));
  const get = memoBlocks(pacer.get);
  const chunks: ChunkCache = new Map();
  const done = () => {
    counts.nodeReads = pacer.status.reads;
    counts.nodeBusy = pacer.status.limited;
    if (pacer.status.limited) {
      pace.busyStreak += 1;
      pace.resumeAt = now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (pace.busyStreak - 1));
    } else if (pacer.status.reads > 0) {
      pace.busyStreak = 0;
    }
    return counts;
  };
  const write = async (row: any, unit: string, validAt: number, source: string, result: ScoreRow): Promise<boolean> => {
    try {
      await save(query, row.commit_id, unit, validAt, source, nowSec, result);
      pace.saveFailures.delete(row.commit_id);
      return true;
    } catch {
      // No attempt mark could be written, so remember it here: otherwise this forecast would cost a full
      // set of node reads on every pass for as long as the database refuses the row.
      counts.saveErrors += 1;
      const failures = (pace.saveFailures.get(row.commit_id)?.count ?? 0) + 1;
      if (pace.saveFailures.size > 1000) pace.saveFailures.clear();
      pace.saveFailures.set(row.commit_id, { count: failures, retryAt: now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)) });
      return false;
    }
  };
  let tip: { height: number; time: number };
  try { tip = await chainTip(get); } catch { counts.retry = rows.length; return done(); }
  for (const [index, row] of rows.entries()) {
    const lead = Number(row.horizon_hours);
    const forecast = numberToFixedPoint(Number(row.value));
    if (!isScoredVariable(row.variable) || forecast === null || !Number.isInteger(lead) || lead < 1) { counts.skipped += 1; continue; }
    const variable = row.variable;
    const unit = FIXED_POINT_UNITS[variable];
    if (!inRange(variable, forecast)) {
      if (await write(row, unit, Number(row.valid), 'draft', { status: 'unscored', reason: 'out_of_range' })) counts.unscored += 1;
      continue;
    }
    let evaluation: Evaluation;
    try {
      evaluation = await evaluate({ query, get, chunks, nowSec, tip }, row, variable, forecast, lead);
    } catch {
      if (pacer.status.limited) {
        // The node said "too many requests": stop here and leave the rest for a later pass, unmarked.
        counts.retry += rows.length - index;
        break;
      }
      // The node could not answer. Note the attempt (so one unreadable forecast never blocks the others) and give
      // up 24 hours after the target time, like a missing reading, but with its own reason.
      const gaveUp = nowSec - Number(row.valid) > GIVE_UP_S;
      const noted = await write(row, unit, Number(row.valid), 'draft', { status: gaveUp ? 'unscored' : 'pending', reason: 'node_unavailable', forecast });
      if (gaveUp && noted) counts.unscored += 1; else counts.retry += 1;
      continue;
    }
    const { result } = evaluation;
    if (result === 'not_due') { counts.waiting += 1; continue; }
    if (!(await write(row, unit, evaluation.validAt, evaluation.source, result))) continue;
    if (result.status === 'scored') counts.scored += 1; else if (result.status === 'unscored') counts.unscored += 1; else counts.waiting += 1;
  }
  return done();
}

// ---------------------------------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------------------------------

const SCORE_COLUMNS = `status, reason, unit, extract(epoch FROM valid_at)::bigint AS valid, forecast_fp, truth_fp,
  extract(epoch FROM truth_observed_at)::bigint AS truth_observed, truth_commit_id, truth_height, err_fp, ref_fp, ref_kind, copied, skill,
  beat_baseline, nws_fp, nws_err_fp, nws_skill, nws_lead_hours`;

const int = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const isoSec = (v: unknown) => (v === null || v === undefined ? null : new Date(Number(v) * 1000).toISOString());
const UNSCORED_TEXT: Record<UnscoredReason, string> = {
  no_reading: 'unscored: no reading',
  no_baseline: 'unscored: not enough earlier readings for a baseline',
  node_unavailable: 'unscored: the chain node could not be read',
  out_of_range: 'unscored: the forecast value is outside the scored range',
};

/**
 * What the site shows. All values are fixed-point integers in `unit` (temp_c_centi = 0.01 °C, pressure_pa = Pa);
 * `skill` is in millionths. `forecastStatus` is the forecast's chain progress; `draftValidAt` its own target time.
 * The truth reading is named by its chain commit id and block height, so anyone can check it.
 */
export function publicPracticeScore(score: any | null, forecastStatus: string, variable: string, draftValidAtSec: number | null) {
  if (!isScoredVariable(variable) || forecastStatus === 'failed') return null;
  const base = { paid: false, note: PRACTICE_NOTE, unit: FIXED_POINT_UNITS[variable], skillMax: Number(SCORE_PRECISION) };
  if (!score || score.status === 'pending') {
    const validAt = score ? Number(score.valid) : draftValidAtSec;
    const until = validAt === null ? null : isoSec(validAt + SCORE_DELAY_S);
    const reason = !score ? null : score.reason === 'node_unavailable' ? 'node_unavailable' : 'waiting_for_reading';
    return {
      ...base, status: 'pending' as const, reason,
      text: reason === 'node_unavailable' ? 'pending: the chain node could not be read; trying again'
        : reason ? 'pending: waiting for a station reading' : `pending until ${until ?? 'the target time'}`,
      validAt: score ? isoSec(score.valid) : null, pendingUntil: until, giveUpAt: validAt === null ? null : isoSec(validAt + GIVE_UP_S),
    };
  }
  const truthRef = {
    validAt: isoSec(score.valid), forecast: int(score.forecast_fp), truth: int(score.truth_fp), truthObservedAt: isoSec(score.truth_observed),
    truthCommitId: typeof score.truth_commit_id === 'string' ? score.truth_commit_id : null, truthHeight: int(score.truth_height),
  };
  if (score.status === 'unscored') {
    const reason: UnscoredReason = Object.prototype.hasOwnProperty.call(UNSCORED_TEXT, score.reason) ? score.reason : 'no_reading';
    return { ...base, status: 'unscored' as const, reason, text: UNSCORED_TEXT[reason], ...truthRef };
  }
  const skill = int(score.skill);
  const nwsSkill = int(score.nws_skill);
  const err = int(score.err_fp);
  const nwsErr = int(score.nws_err_fp);
  return {
    ...base, status: 'scored' as const, reason: null, text: 'scored', ...truthRef,
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
  const pace = newPaceState();
  let running = false;
  const tick = () => {
    if (running || !websiteForecastScoreEnabled()) return;
    running = true;
    scoreWebsiteForecasts({ query, get, nowSec: Math.floor(now() / 1000), pace, now })
      .then((c) => { if (c.scored + c.unscored + c.retry + c.skipped + c.saveErrors + c.deferred > 0 || c.nodeBusy) deps.logger?.info('website forecast: practice score pass', c); })
      .catch(() => deps.logger?.warn('website forecast: practice score pass failed (details withheld)'))
      .finally(() => { running = false; });
  };
  setTimeout(tick, 45_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
  deps.logger?.info('website forecast: practice score job started', { intervalMs });
  return true;
}
