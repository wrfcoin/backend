/**
 * "How has my station compared?" (Epic 8): a station's readings next to the nearest National
 * Weather Service observation, hour by hour, summed up over the last 30 days for the station's
 * owner.
 *
 * Two parts:
 *
 *  - A sampler. About once an hour, for each registered station, it stores the station's newest
 *    chain reading beside the NWS observation for the station's 0.1-degree cell
 *    (station_compare_samples, migration 0046). Only pairs are stored: a station with no fresh
 *    reading, or an area with no fresh NWS observation, stores nothing for that hour.
 *  - A summary (summarizeHistory), a pure function over those rows: for temperature and humidity,
 *    the usual difference (median of ours minus theirs), the typical gap (median absolute
 *    difference) and how often the two were close. It answers only with at least MIN_PAIRS pairs
 *    spread over at least MIN_DAYS days; otherwise it says how many it has.
 *
 * Privacy: every coordinate is rounded to 0.1 degree before it is used and none is stored or
 * returned. The table holds no owner, wallet or location. The summary goes to the station's owner
 * only (see station-owner-insights-routes.ts). Nothing here feeds rewards, verification or any
 * public flag.
 *
 * Node reads are paced on the clock every backend job that reads the node shares
 * (node-read-pacer.ts, NODE_JOB_READS_PER_MIN, default 20). Each node call the sampler makes
 * reserves one slot just before it is sent (pacedCore4Fetch), so only reads that really happen
 * are counted, and a job that is also reading (the forecast score job) gets every other slot. A
 * 429 from the node stops the pass and the sampler then stays away for 5 minutes, doubling up to
 * an hour.
 *
 * A station the node will not answer for (a refusal other than 429, or an answer in the wrong
 * shape) has had its turn for the hour and the pass moves on. If the node cannot be reached the
 * pass also moves on, without using up the station's turn. Either way the pass stops after
 * MAX_CONSECUTIVE_FAILURES in a row, so a node that is down is not asked for every station.
 *
 * Fair order: each pass starts after the station the last pass stopped at, and a station is
 * tried at most once an hour, so stations with no fresh reading cannot use up every pass.
 *
 * api.weather.gov is asked at most once per 0.1-degree cell per pass. A failed lookup puts that
 * cell on hold for 5 minutes, doubling up to an hour; stations in a cell on hold are not read
 * from the node either. Logs carry counts only.
 *
 * Pressure: NWS `barometricPressure` is stored as reported. The rest of this codebase treats that
 * field as the altimeter setting (pressure reduced to sea level), not pressure at the sensor, so
 * nothing here subtracts it from a station's pressure. The site check uses the ratio of the two.
 *
 * OFF unless STATION_COMPARE_HISTORY_ENABLED=true. Needs migration 0046 (applied by hand) and
 * WRFCOIN_READER_TOKEN.
 */
import type { ChainTailReader } from './chain-station-tail.js';
import { CLOSE_WITHIN, cell, median } from './station-compare.js';
import { nodeJobReadsPerMinute, processNodeReadClock, reserveNodeReads, type NodeReadClock } from './node-read-pacer.js';
import { createChainTailReader, type Core4Fetch } from './chain-station-tail.js';

export type Query = (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;

export const stationCompareHistoryEnabled = () => process.env.STATION_COMPARE_HISTORY_ENABLED === 'true';

export const HISTORY_DAYS = 30;
export const RETENTION_DAYS = 90;
/** A summary needs at least this many pairs, on at least this many different days. */
export const MIN_PAIRS = 24;
export const MIN_DAYS = 3;
/** Our reading must be at most this old to be sampled, and within this long of the NWS observation. */
export const SAMPLE_MAX_AGE_S = 3600;
export const SAMPLE_MAX_SKEW_S = 90 * 60;
export const NWS_MAX_AGE_MS = 2 * 3600 * 1000;
/** A pass stops after this many station reads in a row that the node did not answer. */
export const MAX_CONSECUTIVE_FAILURES = 3;
/**
 * Deadline for one paced station read: up to 7 node calls (chain-station-tail.ts TAIL_MAX_CALLS), each
 * of which may wait for a slot behind another job at one read a minute at the slowest.
 */
export const PACED_READ_DEADLINE_MS = 10 * 60_000;
export const MAX_STATIONS_PER_PASS = 60;
export const STATION_LIST_CAP = 500;
export const BACKOFF_BASE_MS = 5 * 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
const DEFAULT_INTERVAL_MS = 10 * 60_000;
const HOUR_MS = 3600_000;
const DAY_MS = 24 * HOUR_MS;
const NWS_STATION_RE = /^[A-Z0-9]{3,6}$/;

export const HISTORY_VARIABLES = ['temperature_c', 'humidity_pct'] as const;
export type HistoryVariable = typeof HISTORY_VARIABLES[number];

export interface CompareSample {
  /** Epoch seconds of our reading. */
  observedAt: number;
  temperatureC: number | null;
  humidityPct: number | null;
  pressureHpa: number | null;
  nwsStation: string;
  nwsTemperatureC: number | null;
  nwsHumidityPct: number | null;
  /** NWS `barometricPressure` as reported, hPa. Treated as the altimeter setting, not pressure at the sensor. */
  nwsBarometricHpa: number | null;
}

export interface VariableHistory {
  variable: HistoryVariable;
  pairs: number;
  /** Median of (ours - reference): positive means this station usually reads higher. */
  usualDifference: number;
  /** Median of |ours - reference|. */
  typicalGap: number;
  /** Share of pairs within closeWithin, 0 to 100, whole number. */
  closePercent: number;
  closeWithin: number;
}

export type HistorySummary =
  | {
      status: 'ok';
      days: number;
      from: number;
      to: number;
      reference: { kind: 'nws'; stationIdentifier: string };
      variables: VariableHistory[];
      note: string;
    }
  | { status: 'not_enough_data'; days: number; pairs: number; pairsNeeded: number; daysWithData: number; daysNeeded: number; reason: string };

export const HISTORY_NOTE =
  'For your information only. It does not change rewards. A station in a sunny spot, a valley or near a wall can read differently from an airport station some distance away.';

const round2 = (n: number) => Math.round(n * 100) / 100;
const finite = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** The NWS station most of the samples were paired with. Ties go to the alphabetically first id. */
export function dominantReference(samples: CompareSample[]): string | null {
  const counts = new Map<string, number>();
  for (const s of samples) counts.set(s.nwsStation, (counts.get(s.nwsStation) ?? 0) + 1);
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of [...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (count > bestCount) { best = id; bestCount = count; }
  }
  return best;
}

const MINE: Record<HistoryVariable, keyof CompareSample> = { temperature_c: 'temperatureC', humidity_pct: 'humidityPct' };
const THEIRS: Record<HistoryVariable, keyof CompareSample> = { temperature_c: 'nwsTemperatureC', humidity_pct: 'nwsHumidityPct' };

/** Pure: the 30-day summary of one station's samples. Only pairs against the dominant NWS station count. */
export function summarizeHistory(samples: CompareSample[], nowS: number): HistorySummary {
  const since = nowS - HISTORY_DAYS * 86_400;
  const recent = samples.filter(s => s.observedAt >= since && s.observedAt <= nowS);
  const reference = dominantReference(recent);
  const used = reference === null ? [] : recent.filter(s => s.nwsStation === reference);
  const days = new Set(used.map(s => Math.floor(s.observedAt / 86_400)));
  const notEnough = (): HistorySummary => ({
    status: 'not_enough_data',
    days: HISTORY_DAYS,
    pairs: used.length,
    pairsNeeded: MIN_PAIRS,
    daysWithData: days.size,
    daysNeeded: MIN_DAYS,
    reason: `Not enough history yet: this needs at least ${MIN_PAIRS} hourly comparisons on at least ${MIN_DAYS} different days.`,
  });
  if (reference === null || used.length < MIN_PAIRS || days.size < MIN_DAYS) return notEnough();

  const variables: VariableHistory[] = [];
  for (const variable of HISTORY_VARIABLES) {
    const diffs: number[] = [];
    for (const s of used) {
      const mine = s[MINE[variable]];
      const theirs = s[THEIRS[variable]];
      if (typeof mine === 'number' && typeof theirs === 'number') diffs.push(mine - theirs);
    }
    if (diffs.length < MIN_PAIRS) continue;
    const within = CLOSE_WITHIN[variable];
    variables.push({
      variable,
      pairs: diffs.length,
      usualDifference: round2(median(diffs)),
      typicalGap: round2(median(diffs.map(Math.abs))),
      closePercent: Math.round((diffs.filter(d => Math.abs(d) <= within).length / diffs.length) * 100),
      closeWithin: within,
    });
  }
  if (variables.length === 0) return notEnough();
  return {
    status: 'ok',
    days: HISTORY_DAYS,
    from: Math.min(...used.map(s => s.observedAt)),
    to: Math.max(...used.map(s => s.observedAt)),
    reference: { kind: 'nws', stationIdentifier: reference },
    variables,
    note: HISTORY_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const SELECT_SAMPLES_SQL = `SELECT extract(epoch FROM observed_at)::bigint AS observed_at,
          temperature_c, humidity_pct, pressure_hpa,
          nws_station, nws_temperature_c, nws_humidity_pct, nws_barometric_hpa
     FROM station_compare_samples
    WHERE station_id = $1 AND sampled_hour >= $2
    ORDER BY sampled_hour DESC
    LIMIT 2500`;

export function sampleFromRow(row: Record<string, unknown>): CompareSample | null {
  const observedAt = finite(row.observed_at);
  const nwsStation = typeof row.nws_station === 'string' && NWS_STATION_RE.test(row.nws_station) ? row.nws_station : null;
  if (observedAt === null || nwsStation === null) return null;
  return {
    observedAt,
    temperatureC: finite(row.temperature_c),
    humidityPct: finite(row.humidity_pct),
    pressureHpa: finite(row.pressure_hpa),
    nwsStation,
    nwsTemperatureC: finite(row.nws_temperature_c),
    nwsHumidityPct: finite(row.nws_humidity_pct),
    nwsBarometricHpa: finite(row.nws_barometric_hpa),
  };
}

/** One station's samples over the last `days` days, newest first. */
export async function readSamples(query: Query, stationId: string, nowMs: number, days = HISTORY_DAYS): Promise<CompareSample[]> {
  const since = new Date(nowMs - days * DAY_MS).toISOString();
  const result = await query(SELECT_SAMPLES_SQL, [stationId, since]);
  return result.rows.map(sampleFromRow).filter((s): s is CompareSample => s !== null);
}

// ---------------------------------------------------------------------------
// Sampler
// ---------------------------------------------------------------------------

export interface NwsPairReading {
  stationIdentifier: string;
  observedAt: number; // epoch seconds
  temperatureC: number | null;
  humidityPct: number | null;
  /** NWS `barometricPressure` as reported, hPa (treated as the altimeter setting). */
  barometricHpa: number | null;
}
export interface NwsPairSource {
  /** Latest NWS observation near a 0.1-degree cell centre, or null. May throw. */
  latest(lat: number, lon: number): Promise<NwsPairReading | null>;
}

/** Adapter over the existing NOAA/NWS client (noaa-nws-api-service.js getCurrentObservations). */
export function nwsPairSourceFrom(client: { getCurrentObservations: (lat: number, lon: number, options?: object) => Promise<any> }): NwsPairSource {
  const unit = (v: any, re: RegExp) => (v && typeof v.value === 'number' && Number.isFinite(v.value) && re.test(String(v.unit)) ? v.value as number : null);
  return {
    async latest(lat, lon) {
      const obs = await client.getCurrentObservations(lat, lon, { maxAgeMs: NWS_MAX_AGE_MS, maxStations: 3 });
      if (!obs || obs.stale) return null;
      const observedMs = Date.parse(obs.timestamp);
      const id = typeof obs.stationId === 'string' && NWS_STATION_RE.test(obs.stationId) ? obs.stationId : null;
      if (!Number.isFinite(observedMs) || id === null) return null;
      const pa = unit(obs.barometricPressure, /Pa$/);
      return {
        stationIdentifier: id,
        observedAt: Math.floor(observedMs / 1000),
        temperatureC: unit(obs.temperature, /degC$/),
        humidityPct: unit(obs.relativeHumidity, /percent$/),
        barometricHpa: pa === null ? null : pa / 100,
      };
    },
  };
}

/** Our newest chain reading (core4 get_station_observations field names), plausible values only. */
export function readingFromTailItem(item: Record<string, unknown> | undefined) {
  if (!item) return null;
  const observedAt = finite(item.observed_at);
  if (observedAt === null) return null;
  const v = item.values && typeof item.values === 'object' ? item.values as Record<string, unknown> : {};
  const t = finite(v.temperature_c);
  const h = finite(v.humidity_percent);
  const p = finite(v.pressure_hpa);
  return {
    observedAt,
    temperatureC: t !== null && t > -90 && t < 65 ? t : null,
    humidityPct: h !== null && h >= 0 && h <= 100 ? h : null,
    pressureHpa: p !== null && p > 300 && p < 1100 ? p : null,
  };
}

export interface SamplerState {
  busyStreak: number; resumeAt: number; lastPrunedAt: number;
  /** The hour (epoch ms) `tried` belongs to, and the stations already tried in it. */
  triedHour: number; tried: Set<string>;
  /** The last station a pass handled: the next pass starts after it. */
  cursor: string | null;
  /** 0.1-degree cells whose NWS lookup failed: not asked again before `until`. */
  nwsHold: Map<string, { streak: number; until: number }>;
}
export const newSamplerState = (): SamplerState => ({
  busyStreak: 0, resumeAt: 0, lastPrunedAt: 0, triedHour: 0, tried: new Set(), cursor: null, nwsHold: new Map(),
});
const MAX_NWS_HOLDS = 2000;

export interface SamplerDeps {
  query: Query;
  chainTail: ChainTailReader;
  nws: NwsPairSource;
  now?: () => number;
  state?: SamplerState;
}

export interface SamplerCounts {
  stations: number; alreadySampled: number; alreadyTried: number; read: number; stored: number;
  noReading: number; noReference: number; referenceOnHold: number; referenceErrors: number;
  /** Stations the node refused or answered in the wrong shape (their turn for the hour is used). */
  refused: number;
  nodeUnavailable: boolean; nodeBusy: boolean; backingOff: boolean;
}

const INSERT_SQL = `INSERT INTO station_compare_samples
    (station_id, sampled_hour, observed_at, temperature_c, humidity_pct, pressure_hpa,
     nws_station, nws_observed_at, nws_temperature_c, nws_humidity_pct, nws_barometric_hpa)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
  ON CONFLICT (station_id, sampled_hour) DO NOTHING`;

/** One pass: every registered station that has no sample for the current hour yet, paced. Never throws on a node or NWS failure. */
export async function sampleStations(deps: SamplerDeps): Promise<SamplerCounts> {
  const now = deps.now ?? Date.now;
  const state = deps.state ?? newSamplerState();
  const counts: SamplerCounts = {
    stations: 0, alreadySampled: 0, alreadyTried: 0, read: 0, stored: 0, noReading: 0, noReference: 0,
    referenceOnHold: 0, referenceErrors: 0, refused: 0, nodeUnavailable: false, nodeBusy: false, backingOff: false,
  };
  if (state.resumeAt > now()) { counts.backingOff = true; return counts; }

  const hourMs = Math.floor(now() / HOUR_MS) * HOUR_MS;
  const hourIso = new Date(hourMs).toISOString();

  if (now() - state.lastPrunedAt > DAY_MS) {
    await deps.query('DELETE FROM station_compare_samples WHERE sampled_hour < $1', [new Date(now() - RETENTION_DAYS * DAY_MS).toISOString()]);
    state.lastPrunedAt = now();
  }

  const listed = await deps.query(
    `SELECT station_id, latitude, longitude FROM weather_stations
      WHERE latitude IS NOT NULL AND longitude IS NOT NULL
      ORDER BY station_id ASC LIMIT ${STATION_LIST_CAP}`,
  );
  const done = new Set<string>(
    (await deps.query('SELECT station_id FROM station_compare_samples WHERE sampled_hour = $1', [hourIso])).rows.map(r => String(r.station_id)),
  );
  counts.stations = listed.rows.length;
  if (state.triedHour !== hourMs) { state.triedHour = hourMs; state.tried = new Set(); }
  // Start after the station the last pass stopped at, and wrap around once.
  const ids = listed.rows.map(r => String(r.station_id));
  const startAt = state.cursor === null ? 0 : ids.findIndex(id => id > (state.cursor as string));
  const order = startAt <= 0 ? listed.rows : [...listed.rows.slice(startAt), ...listed.rows.slice(0, startAt)];
  // At most one NWS call per cell per pass: later stations in the cell reuse the answer.
  const nwsByCell = new Map<string, Promise<NwsPairReading | null | 'error'>>();

  let failuresInARow = 0;
  for (const row of order) {
    const stationId = String(row.station_id);
    if (done.has(stationId)) { counts.alreadySampled += 1; continue; }
    if (state.tried.has(stationId)) { counts.alreadyTried += 1; continue; }
    if (counts.read >= MAX_STATIONS_PER_PASS) break;
    // The hour rolled over while this pass was waiting: the next pass takes the new hour.
    if (Math.floor(now() / HOUR_MS) * HOUR_MS !== hourMs) break;
    const lat = cell(row.latitude, 90);
    const lon = cell(row.longitude, 180);
    if (lat === null || lon === null) continue;
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;

    // A cell whose NWS lookup keeps failing costs no node read until its hold ends.
    const hold = state.nwsHold.get(key);
    if (hold && hold.until > now() && !nwsByCell.has(key)) {
      counts.referenceOnHold += 1;
      state.tried.add(stationId);
      state.cursor = stationId;
      continue;
    }

    counts.read += 1;
    const tail = await deps.chainTail.latest(stationId);
    if (tail.kind === 'rejected' && tail.status === 429) {
      counts.nodeBusy = true;
      state.busyStreak += 1;
      state.resumeAt = now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (state.busyStreak - 1));
      return counts;
    }
    // Whatever the node said, the next pass starts after this station: one station can never hold the sampler.
    state.cursor = stationId;
    if (tail.kind !== 'ok') {
      if (tail.kind === 'unavailable') {
        // The node could not be reached. The station keeps its turn for a later pass this hour.
        counts.nodeUnavailable = true;
      } else {
        // A refusal for this station (not 429) or an answer in the wrong shape: its turn is used.
        counts.refused += 1;
        state.tried.add(stationId);
      }
      failuresInARow += 1;
      // Several in a row means the node itself is the problem: asking for more stations only adds load.
      if (failuresInARow >= MAX_CONSECUTIVE_FAILURES) return counts;
      continue;
    }
    failuresInARow = 0;
    state.busyStreak = 0;
    // From here the station has had its turn for this hour, whatever the outcome.
    state.tried.add(stationId);
    const mine = readingFromTailItem(tail.items[0]);
    const nowS = Math.floor(now() / 1000);
    if (!mine || nowS - mine.observedAt > SAMPLE_MAX_AGE_S || mine.observedAt > nowS + 300
      || (mine.temperatureC === null && mine.humidityPct === null && mine.pressureHpa === null)) {
      counts.noReading += 1;
      continue;
    }

    let pending = nwsByCell.get(key);
    if (!pending) {
      pending = deps.nws.latest(lat, lon).then(
        (reading) => { state.nwsHold.delete(key); return reading; },
        () => {
          const streak = (state.nwsHold.get(key)?.streak ?? 0) + 1;
          if (state.nwsHold.size >= MAX_NWS_HOLDS) state.nwsHold.clear();
          state.nwsHold.set(key, { streak, until: now() + Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (streak - 1)) });
          counts.referenceErrors += 1;
          return 'error' as const;
        },
      );
      nwsByCell.set(key, pending);
    }
    const ref = await pending;
    if (ref === 'error' || !ref || Math.abs(ref.observedAt - mine.observedAt) > SAMPLE_MAX_SKEW_S) { counts.noReference += 1; continue; }

    await deps.query(INSERT_SQL, [
      stationId, hourIso, new Date(mine.observedAt * 1000).toISOString(),
      mine.temperatureC, mine.humidityPct, mine.pressureHpa,
      ref.stationIdentifier, new Date(ref.observedAt * 1000).toISOString(),
      ref.temperatureC, ref.humidityPct, ref.barometricHpa,
    ]);
    counts.stored += 1;
  }
  return counts;
}

/**
 * A node client that reserves one slot on the shared clock just before each call it sends. Only calls that
 * really go out are counted, so a job reading at the same time gets every other slot.
 */
export function pacedCore4Fetch(fetch: Core4Fetch, opts: {
  clock: NodeReadClock;
  readsPerMin?: () => number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Core4Fetch {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.(); }));
  const readsPerMin = opts.readsPerMin ?? nodeJobReadsPerMinute;
  return async (path, options) => {
    await reserveNodeReads(opts.clock, 1, readsPerMin(), now, sleep);
    return fetch(path, options);
  };
}

type Logger = { info: (message: string, meta?: unknown) => void; warn: (message: string, meta?: unknown) => void };

export async function startStationCompareSampler(deps: {
  query?: Query; chainTail?: ChainTailReader; nws?: NwsPairSource; now?: () => number; logger?: Logger;
} = {}): Promise<boolean> {
  if (!stationCompareHistoryEnabled()) return false;
  const raw = Number(process.env.STATION_COMPARE_SAMPLE_INTERVAL_MS);
  const intervalMs = Number.isInteger(raw) && raw >= 5 * 60_000 ? raw : DEFAULT_INTERVAL_MS;
  const query: Query = deps.query ?? await (async () => {
    const { pool } = await import('../../database/db.js');
    return (sql: string, params?: unknown[]) => pool.query(sql, params ?? []) as Promise<{ rows: any[] }>;
  })();
  // The sampler's own reader: every node call it makes waits for a slot on the clock all jobs share.
  const chainTail = deps.chainTail ?? createChainTailReader({
    fetchCore4Json: pacedCore4Fetch(
      (await import('../../shared/core4-route-client.js')).fetchCore4Json as Core4Fetch,
      { clock: processNodeReadClock, now: deps.now },
    ),
    now: deps.now,
    readDeadlineMs: PACED_READ_DEADLINE_MS,
  });
  const nws = deps.nws ?? await (async () => {
    const mod: any = await import('./noaa-nws-api-service.js');
    const NOAAWeatherService = mod.default ?? mod;
    return nwsPairSourceFrom(new NOAAWeatherService());
  })();
  const state = newSamplerState();
  let running = false;
  const tick = () => {
    if (running || !stationCompareHistoryEnabled()) return;
    running = true;
    sampleStations({ query, chainTail, nws, now: deps.now, state })
      .then((c) => { if (c.stored > 0 || c.nodeBusy || c.nodeUnavailable || c.refused > 0 || c.referenceErrors > 0) deps.logger?.info('station compare history: sample pass', c); })
      .catch(() => deps.logger?.warn('station compare history: sample pass failed (details withheld)'))
      .finally(() => { running = false; });
  };
  setTimeout(tick, 60_000).unref?.();
  setInterval(tick, intervalMs).unref?.();
  deps.logger?.info('station compare history: sampler started', { intervalMs });
  return true;
}
