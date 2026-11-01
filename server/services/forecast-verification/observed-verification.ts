/**
 * Forecasts checked against what weather stations measured (backend PR#72 intent, backend#1494 "per-cell
 * skill against NOAA before switching"; owner demo queue 2026-11-01, item 7).
 *
 * What is scored: an ON-CHAIN forecast (a forecast-kit commit that has been revealed) whose forecaster
 * handed in its commit record (forecast-commit-record.ts proves the record is exactly what was committed).
 * What it is scored against:
 *   - truth: the chain's own readings for that station in the target hour (core4
 *     GET /transactions/contributions/{station}/observations, the attested reveals), averaged per variable
 *     exactly like the kit's `score` step (`hourly_means`, hour = floor(valid_at / 3600));
 *   - reference: what NOAA's National Weather Service forecast for the same station and hour, captured by
 *     this job BEFORE the forecast was issued (NOAA's hourly forecast cannot be read back later, so the
 *     job records it every hour for the stations forecasters target). NOAA reports temperature and
 *     humidity only, so pressure has no NOAA reference.
 *
 * Honesty rules:
 *   - A forecast is scored only on variables it declares AND the chain readings report (owner ruling
 *     2026-10-19, `scored_variables`). Nothing is filled in.
 *   - No chain reading in the target hour => the forecast stays pending, then becomes `unavailable` with
 *     a reason after FORECAST_VERIFICATION_GIVE_UP_HOURS. Never a made-up truth.
 *   - No NOAA capture for that station/hour issued at or before the forecast => `noaa: null` with a
 *     reason; the comparison is shown only over forecasts that have both.
 *   - The score is read-side evidence. It never feeds rewards (core4 forecast-score does that).
 *
 * The job is OFF unless FORECAST_VERIFICATION_ENABLED=true and reads the node with WRFCOIN_READER_TOKEN.
 */
import { FORECAST_VARIABLES, type ForecastVariable, type Core4Get, type Core4Response } from '../forecast-commit-record.js';

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export const HOUR_S = 3600;
/** core4 get_station_observations walks at most 64 heights per call. */
const OBS_WINDOW_HEIGHTS = 64;
const MAX_OBS_CALLS = 6;
const MAX_SEARCH_READS = 24;
/** Chain 888 cadence is ~77 s/block (block-heartbeat); only a starting guess for the search. */
const CADENCE_GUESS_S = 77;
export const DEFAULT_GIVE_UP_HOURS = 12;
export const SCORE_BATCH = 10;
export const REFERENCE_STATION_CAP = 25;
export const REFERENCE_LEAD_HOURS = 12;

/** Node field -> forecast variable (core4 routes/transactions.rs get_station_observations). */
const NODE_FIELDS: Record<string, ForecastVariable> = {
  temperature_c: 'temperature_c',
  pressure_hpa: 'pressure_hpa',
  humidity_percent: 'humidity_pct',
};

export interface ChainReading {
  commitId: string;
  height: number;
  observedAt: number;
  values: Partial<Record<ForecastVariable, number>>;
  provenanceClass: string | null;
}

export interface Truth {
  hourStart: number;
  readings: number;
  heights: { from: number; to: number };
  values: Partial<Record<ForecastVariable, number>>;
  provenance: string[];
}

export interface NoaaReference {
  issuedHour: number;
  validHour: number;
  temperatureC: number | null;
  humidityPct: number | null;
  source: string;
}

export interface VariableScore {
  forecast: number;
  truth: number;
  error: number;
  noaa: { value: number; error: number; leadHours: number } | null;
}

export interface ScoreResult {
  scores: Partial<Record<ForecastVariable, VariableScore>>;
  scoredVariables: ForecastVariable[];
  noaaReason: string | null;
}

const safeInt = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const finite = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const round4 = (v: number) => Math.round(v * 10_000) / 10_000;

function unwrap(payload: any): Record<string, any> | null {
  const data = payload && typeof payload === 'object' && payload.ok === true && 'data' in payload ? payload.data : payload;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

export class ChainReadError extends Error { constructor() { super('chain read failed'); } }

async function must(get: Core4Get, path: string, query?: Record<string, unknown>): Promise<Record<string, any>> {
  let reply: Core4Response;
  try { reply = await get(path, query); } catch { throw new ChainReadError(); }
  const body = reply.ok ? unwrap(reply.payload) : null;
  if (!body) throw new ChainReadError();
  return body;
}

/** Tip height and its block time (seconds). */
export async function chainTip(get: Core4Get): Promise<{ height: number; time: number }> {
  const tip = await must(get, '/blockchain');
  const height = safeInt(tip.height);
  if (height === null || height < 1) throw new ChainReadError();
  return { height, time: await blockTime(get, height) };
}

export async function blockTime(get: Core4Get, height: number): Promise<number> {
  const block = await must(get, `/chain/block/${height}`);
  const ms = typeof block.timestamp === 'string' ? Date.parse(block.timestamp) : NaN;
  if (safeInt(block.height) !== height || !Number.isFinite(ms)) throw new ChainReadError();
  return Math.floor(ms / 1000);
}

/**
 * Lowest height whose block time is >= `target` (tip + 1 when none is). Interpolation from the tip, then
 * bisection; block times are non-decreasing. Bounded reads; a block that cannot be read is an error.
 */
export async function firstHeightAtOrAfter(get: Core4Get, target: number, tip: { height: number; time: number }): Promise<number> {
  if (tip.time < target) return tip.height + 1;
  let lo = 1; // invariant: answer in [lo, hi]
  let hi = tip.height;
  let reads = 0;
  let guess = Math.min(hi, Math.max(lo, tip.height - Math.ceil((tip.time - target) / CADENCE_GUESS_S)));
  while (lo < hi) {
    if (++reads > MAX_SEARCH_READS) throw new ChainReadError();
    const mid = guess >= lo && guess < hi ? guess : Math.floor((lo + hi) / 2);
    const t = await blockTime(get, mid);
    if (t >= target) hi = mid; else lo = mid + 1;
    guess = -1;
  }
  return lo;
}

/** The chain's readings for one station whose landing block lies in [fromHeight, toHeight]. */
export async function stationReadings(get: Core4Get, stationId: string, fromHeight: number, toHeight: number): Promise<ChainReading[]> {
  const out: ChainReading[] = [];
  let after = Math.max(0, fromHeight - 1);
  let offset = 0;
  for (let calls = 0; after < toHeight; calls += 1) {
    if (calls >= MAX_OBS_CALLS) throw new ChainReadError();
    const data = await must(get, `/transactions/contributions/${encodeURIComponent(stationId)}/observations`, { after, offset, limit: 100 });
    if (!Array.isArray(data.items)) throw new ChainReadError();
    for (const item of data.items) {
      const height = safeInt(item?.height);
      const observedAt = safeInt(item?.observed_at);
      if (height === null || observedAt === null || height < fromHeight || height > toHeight || typeof item.commit_id !== 'string') continue;
      const values: Partial<Record<ForecastVariable, number>> = {};
      for (const [field, variable] of Object.entries(NODE_FIELDS)) {
        const v = finite(item.values?.[field]);
        if (v !== null) values[variable] = v;
      }
      out.push({ commitId: item.commit_id, height, observedAt, values, provenanceClass: typeof item.provenance_class === 'string' ? item.provenance_class : null });
    }
    const nextAfter = safeInt(data.next_after);
    const nextOffset = safeInt(data.next_offset);
    if (nextAfter === null || nextOffset === null || nextAfter < after || (nextAfter === after && nextOffset <= offset)) break;
    if (data.has_more === false) break;
    after = nextAfter;
    offset = nextOffset;
  }
  return out;
}

/** Hourly mean per variable over readings observed in [hourStart, hourStart + 1 h) (the kit's `hourly_means`). */
export function hourlyTruth(readings: ChainReading[], hourStart: number): Truth | null {
  const inHour = readings.filter((r) => r.observedAt >= hourStart && r.observedAt < hourStart + HOUR_S && r.provenanceClass !== 'synthetic');
  if (inHour.length === 0) return null;
  const sums: Partial<Record<ForecastVariable, { sum: number; n: number }>> = {};
  for (const r of inHour) {
    for (const [variable, value] of Object.entries(r.values) as [ForecastVariable, number][]) {
      const s = (sums[variable] ||= { sum: 0, n: 0 });
      s.sum += value; s.n += 1;
    }
  }
  const values: Partial<Record<ForecastVariable, number>> = {};
  for (const [variable, s] of Object.entries(sums) as [ForecastVariable, { sum: number; n: number }][]) values[variable] = round4(s.sum / s.n);
  if (Object.keys(values).length === 0) return null;
  return {
    hourStart,
    readings: inHour.length,
    heights: { from: Math.min(...inHour.map((r) => r.height)), to: Math.max(...inHour.map((r) => r.height)) },
    values,
    provenance: [...new Set(inHour.map((r) => r.provenanceClass ?? 'unknown'))].sort(),
  };
}

/** Errors are forecast - truth (the kit's sign). NOAA is compared only where it has the variable. */
export function scoreForecast(values: Partial<Record<ForecastVariable, number>>, truth: Truth, noaa: NoaaReference | null, noaaMissingReason: string | null): ScoreResult {
  const scores: ScoreResult['scores'] = {};
  const scoredVariables: ForecastVariable[] = [];
  for (const variable of FORECAST_VARIABLES) {
    const f = values[variable];
    const t = truth.values[variable];
    if (f === undefined || t === undefined) continue;
    scoredVariables.push(variable);
    const noaaValue = !noaa ? null : variable === 'temperature_c' ? noaa.temperatureC : variable === 'humidity_pct' ? noaa.humidityPct : null;
    scores[variable] = {
      forecast: f,
      truth: t,
      error: round4(f - t),
      noaa: noaa && noaaValue !== null ? { value: noaaValue, error: round4(noaaValue - t), leadHours: (noaa.validHour - noaa.issuedHour) / HOUR_S } : null,
    };
  }
  return { scores, scoredVariables, noaaReason: noaa ? null : noaaMissingReason };
}

// ---------------------------------------------------------------------------------------------------
// NOAA reference capture
// ---------------------------------------------------------------------------------------------------

export interface HourlyForecastSource {
  getHourlyForecast(lat: number, lon: number, hours: number): Promise<{ forecastGenerator?: string; periods: Array<{ startTime: string; temperature: number; temperatureUnit: string; relativeHumidity: number | null }> }>;
}

export const fahrenheitToC = (f: number) => round4(((f - 32) * 5) / 9);

/** Stations forecasters targeted in the last 14 days that have coordinates (0.1 degree grid). */
const REFERENCE_STATIONS_SQL = `SELECT ws.station_id, ws.latitude, ws.longitude
  FROM weather_stations ws
  WHERE ws.latitude IS NOT NULL AND ws.longitude IS NOT NULL AND ws.station_id IN (
    SELECT station_id FROM forecast_verification_records WHERE submitted_at > now() - interval '14 days'
    UNION
    SELECT e.station_id FROM chain_forecast_decision_events e
      JOIN chain_reward_blocks b ON b.chain_id = e.chain_id AND b.genesis_hash = e.genesis_hash AND b.height = e.height
      WHERE b.block_time > now() - interval '14 days')
  ORDER BY ws.station_id LIMIT ${REFERENCE_STATION_CAP}`;
const REFERENCE_STATIONS_FALLBACK_SQL = `SELECT ws.station_id, ws.latitude, ws.longitude
  FROM weather_stations ws
  WHERE ws.latitude IS NOT NULL AND ws.longitude IS NOT NULL AND ws.station_id IN (
    SELECT station_id FROM forecast_verification_records WHERE submitted_at > now() - interval '14 days')
  ORDER BY ws.station_id LIMIT ${REFERENCE_STATION_CAP}`;

export async function captureNoaaReferences(query: Query, noaa: HourlyForecastSource, nowSec: number): Promise<{ stations: number; rows: number; failures: number }> {
  let stations: any[];
  try { stations = (await query(REFERENCE_STATIONS_SQL)).rows; }
  catch { stations = (await query(REFERENCE_STATIONS_FALLBACK_SQL)).rows; } // forecast index tables not migrated
  const issuedHour = Math.floor(nowSec / HOUR_S) * HOUR_S;
  let rows = 0;
  let failures = 0;
  for (const s of stations) {
    const lat = Number(s.latitude);
    const lon = Number(s.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const already = (await query('SELECT 1 FROM forecast_verification_noaa_reference WHERE station_id = $1 AND issued_hour = to_timestamp($2) LIMIT 1', [s.station_id, issuedHour])).rows;
    if (already.length > 0) continue;
    let forecast: Awaited<ReturnType<HourlyForecastSource['getHourlyForecast']>>;
    try { forecast = await noaa.getHourlyForecast(lat, lon, REFERENCE_LEAD_HOURS + 1); } catch { failures += 1; continue; }
    const source = `nws:${typeof forecast.forecastGenerator === 'string' ? forecast.forecastGenerator.slice(0, 48) : 'hourly'}`;
    for (const period of forecast.periods ?? []) {
      const startMs = Date.parse(period.startTime);
      if (!Number.isFinite(startMs)) continue;
      const validHour = Math.floor(startMs / 1000 / HOUR_S) * HOUR_S;
      if (validHour <= issuedHour || validHour > issuedHour + REFERENCE_LEAD_HOURS * HOUR_S) continue;
      const temp = finite(period.temperature);
      const temperatureC = temp === null ? null : period.temperatureUnit === 'C' ? temp : period.temperatureUnit === 'F' ? fahrenheitToC(temp) : null;
      const humidity = finite(period.relativeHumidity);
      if (temperatureC === null && humidity === null) continue;
      await query(`INSERT INTO forecast_verification_noaa_reference (station_id, issued_hour, valid_hour, temperature_c, humidity_pct, source)
        VALUES ($1, to_timestamp($2), to_timestamp($3), $4, $5, $6) ON CONFLICT DO NOTHING`,
      [s.station_id, issuedHour, validHour, temperatureC, humidity, source]);
      rows += 1;
    }
  }
  return { stations: stations.length, rows, failures };
}

/** Latest NOAA capture for this station and hour issued at or before the forecast was issued. */
export async function noaaReferenceFor(query: Query, stationId: string, validHour: number, issuedAt: number): Promise<NoaaReference | null> {
  const row = (await query(`SELECT extract(epoch FROM issued_hour)::bigint AS issued, extract(epoch FROM valid_hour)::bigint AS valid,
      temperature_c, humidity_pct, source FROM forecast_verification_noaa_reference
    WHERE station_id = $1 AND valid_hour = to_timestamp($2) AND issued_hour <= to_timestamp($3)
    ORDER BY issued_hour DESC LIMIT 1`, [stationId, validHour, issuedAt])).rows[0];
  if (!row) return null;
  return {
    issuedHour: Number(row.issued),
    validHour: Number(row.valid),
    temperatureC: row.temperature_c === null ? null : Number(row.temperature_c),
    humidityPct: row.humidity_pct === null ? null : Number(row.humidity_pct),
    source: String(row.source),
  };
}

// ---------------------------------------------------------------------------------------------------
// Scoring pass
// ---------------------------------------------------------------------------------------------------

export interface ScorePassDeps {
  query: Query;
  get: Core4Get;
  nowSec: number;
  giveUpHours?: number;
}

/**
 * Scores up to SCORE_BATCH pending records whose target hour ended at least 15 minutes ago (a reading
 * can take a few blocks to land). A node failure leaves the record pending for the next pass.
 */
export async function scorePending({ query, get, nowSec, giveUpHours = DEFAULT_GIVE_UP_HOURS }: ScorePassDeps): Promise<{ scored: number; unavailable: number; retry: number }> {
  const pending = (await query(`SELECT commit_id, station_id, extract(epoch FROM issued_at)::bigint AS issued, extract(epoch FROM valid_at)::bigint AS valid,
      forecast_values FROM forecast_verification_records
    WHERE status = 'pending' AND valid_at < to_timestamp($1) - interval '75 minutes'
    ORDER BY valid_at ASC LIMIT ${SCORE_BATCH}`, [nowSec])).rows;
  const result = { scored: 0, unavailable: 0, retry: 0 };
  if (pending.length === 0) return result;
  let tip: { height: number; time: number };
  try { tip = await chainTip(get); } catch { result.retry = pending.length; return result; }
  for (const row of pending) {
    const validAt = Number(row.valid);
    const issuedAt = Number(row.issued);
    const hourStart = Math.floor(validAt / HOUR_S) * HOUR_S;
    let truth: Truth | null;
    try {
      // Readings land a few blocks after they are observed: search one extra hour of blocks.
      const from = await firstHeightAtOrAfter(get, hourStart, tip);
      const to = Math.min(tip.height, (await firstHeightAtOrAfter(get, hourStart + 2 * HOUR_S, tip)) - 1);
      truth = from > to ? null : hourlyTruth(await stationReadings(get, row.station_id, from, to), hourStart);
    } catch {
      await query('UPDATE forecast_verification_records SET last_attempt_at = to_timestamp($2), attempts = attempts + 1 WHERE commit_id = $1', [row.commit_id, nowSec]);
      result.retry += 1;
      continue;
    }
    if (!truth) {
      if (nowSec - validAt > giveUpHours * HOUR_S) {
        await query(`UPDATE forecast_verification_records SET status = 'unavailable', unavailable_reason = 'no_chain_reading_in_target_hour',
          scored_at = to_timestamp($2), last_attempt_at = to_timestamp($2), attempts = attempts + 1 WHERE commit_id = $1 AND status = 'pending'`, [row.commit_id, nowSec]);
        result.unavailable += 1;
      } else {
        await query('UPDATE forecast_verification_records SET last_attempt_at = to_timestamp($2), attempts = attempts + 1 WHERE commit_id = $1', [row.commit_id, nowSec]);
        result.retry += 1;
      }
      continue;
    }
    const noaa = await noaaReferenceFor(query, row.station_id, hourStart, issuedAt);
    const values = typeof row.forecast_values === 'string' ? JSON.parse(row.forecast_values) : row.forecast_values;
    const score = scoreForecast(values ?? {}, truth, noaa, 'no NOAA forecast was captured for this station and hour before the forecast was issued');
    if (score.scoredVariables.length === 0) {
      await query(`UPDATE forecast_verification_records SET status = 'unavailable', unavailable_reason = 'no_shared_variable',
        truth = $2, scored_at = to_timestamp($3), last_attempt_at = to_timestamp($3), attempts = attempts + 1 WHERE commit_id = $1 AND status = 'pending'`,
      [row.commit_id, JSON.stringify(truth), nowSec]);
      result.unavailable += 1;
      continue;
    }
    await query(`UPDATE forecast_verification_records SET status = 'scored', truth = $2, scores = $3, noaa_reference = $4, noaa_reason = $5,
      scored_at = to_timestamp($6), last_attempt_at = to_timestamp($6), attempts = attempts + 1 WHERE commit_id = $1 AND status = 'pending'`,
    [row.commit_id, JSON.stringify(truth), JSON.stringify(score.scores), noaa ? JSON.stringify(noaa) : null, score.noaaReason, nowSec]);
    result.scored += 1;
  }
  return result;
}

// ---------------------------------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------------------------------

export const SUMMARY_WINDOW_DAYS = 30;
const SUMMARY_ROW_CAP = 5000;

interface Agg { n: number; absSum: number; sum: number; sqSum: number }
const emptyAgg = (): Agg => ({ n: 0, absSum: 0, sum: 0, sqSum: 0 });
const add = (a: Agg, e: number) => { a.n += 1; a.absSum += Math.abs(e); a.sum += e; a.sqSum += e * e; };
const stats = (a: Agg) => (a.n === 0 ? null : { n: a.n, mae: round4(a.absSum / a.n), bias: round4(a.sum / a.n), rmse: round4(Math.sqrt(a.sqSum / a.n)) });

const UNAVAILABLE_NO_DATA = 'No forecast has been scored against station readings in this window yet.';
const UNAVAILABLE_NO_NOAA = 'No scored forecast has a NOAA forecast for the same station and hour, captured before it was issued.';

export function publicRecord(row: any) {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : typeof v === 'string' ? new Date(v).toISOString() : null);
  const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v ?? null);
  const truth = json(row.truth);
  return {
    commitId: row.commit_id,
    stationAlias: row.station_alias,
    modelId: row.model_id ?? null,
    issuedAt: iso(row.issued_at),
    validAt: iso(row.valid_at),
    horizonHours: row.horizon_hours ?? null,
    status: row.status,
    unavailableReason: row.unavailable_reason ?? null,
    forecast: json(row.forecast_values),
    truth: truth ? { readings: truth.readings, values: truth.values, provenance: truth.provenance, heights: truth.heights } : null,
    scores: json(row.scores),
    noaa: json(row.noaa_reference) ? { source: json(row.noaa_reference).source, leadHours: (json(row.noaa_reference).validHour - json(row.noaa_reference).issuedHour) / HOUR_S } : null,
    noaaReason: row.noaa_reason ?? null,
    submittedAt: iso(row.submitted_at),
    scoredAt: iso(row.scored_at),
  };
}

const RECORD_COLUMNS = `commit_id, station_alias, model_id, issued_at, valid_at, horizon_hours, status, unavailable_reason,
  forecast_values, truth, scores, noaa_reference, noaa_reason, submitted_at, scored_at`;

export async function readRecord(query: Query, commitId: string) {
  const row = (await query(`SELECT ${RECORD_COLUMNS} FROM forecast_verification_records WHERE commit_id = $1`, [commitId])).rows[0];
  return row ? publicRecord(row) : null;
}

export async function readSummary(query: Query, nowSec: number) {
  const counts = (await query(`SELECT status, count(*)::int AS n FROM forecast_verification_records
    WHERE valid_at > to_timestamp($1) - interval '${SUMMARY_WINDOW_DAYS} days' GROUP BY status`, [nowSec])).rows;
  const byStatus: Record<string, number> = { pending: 0, scored: 0, unavailable: 0 };
  for (const c of counts) byStatus[c.status] = Number(c.n);
  const scored = (await query(`SELECT station_alias, scores FROM forecast_verification_records
    WHERE status = 'scored' AND valid_at > to_timestamp($1) - interval '${SUMMARY_WINDOW_DAYS} days'
    ORDER BY valid_at DESC LIMIT ${SUMMARY_ROW_CAP}`, [nowSec])).rows;

  const variables: Record<string, { chain: Agg; pairedChain: Agg; pairedNoaa: Agg }> = {};
  const stations = new Map<string, { scored: number; temperature: Agg }>();
  for (const row of scored) {
    const scores = (typeof row.scores === 'string' ? JSON.parse(row.scores) : row.scores) ?? {};
    const st = stations.get(row.station_alias) ?? { scored: 0, temperature: emptyAgg() };
    st.scored += 1;
    stations.set(row.station_alias, st);
    for (const variable of FORECAST_VARIABLES) {
      const s = scores[variable] as VariableScore | undefined;
      if (!s || typeof s.error !== 'number') continue;
      const v = (variables[variable] ||= { chain: emptyAgg(), pairedChain: emptyAgg(), pairedNoaa: emptyAgg() });
      add(v.chain, s.error);
      if (variable === 'temperature_c') add(st.temperature, s.error);
      if (s.noaa && typeof s.noaa.error === 'number') { add(v.pairedChain, s.error); add(v.pairedNoaa, s.noaa.error); }
    }
  }
  const recent = (await query(`SELECT ${RECORD_COLUMNS} FROM forecast_verification_records
    ORDER BY submitted_at DESC LIMIT 20`)).rows.map(publicRecord);

  return {
    windowDays: SUMMARY_WINDOW_DAYS,
    status: byStatus.scored > 0 ? 'available' : 'unavailable',
    reason: byStatus.scored > 0 ? null : UNAVAILABLE_NO_DATA,
    counts: byStatus,
    variables: FORECAST_VARIABLES.map((variable) => {
      const v = variables[variable];
      const paired = v && v.pairedChain.n > 0;
      return {
        variable,
        chain: v ? stats(v.chain) : null,
        vsNoaa: paired
          ? { n: v.pairedChain.n, chainMae: stats(v.pairedChain)!.mae, noaaMae: stats(v.pairedNoaa)!.mae, chainBias: stats(v.pairedChain)!.bias, noaaBias: stats(v.pairedNoaa)!.bias }
          : null,
        vsNoaaReason: paired ? null : variable === 'pressure_hpa' ? 'NOAA hourly forecasts do not include pressure.' : UNAVAILABLE_NO_NOAA,
      };
    }),
    stations: [...stations.entries()].sort((a, b) => b[1].scored - a[1].scored).slice(0, 25)
      .map(([alias, s]) => ({ stationAlias: alias, scored: s.scored, temperature: stats(s.temperature) })),
    recent,
  };
}
