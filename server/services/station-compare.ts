/**
 * "How does my station compare?" (Epic 8).
 *
 * One station's newest chain reading next to two references:
 *
 *  - nearby: the newest chain readings of other registered stations whose
 *    0.1-degree cell lies within NEARBY_RADIUS_KM of this station's cell. Only
 *    aggregates are returned (how many stations, median, lowest, highest): no
 *    station id, alias, name, owner or distance of any other station.
 *  - nws: the nearest NOAA/NWS observation station's latest observation for
 *    this station's 0.1-degree cell (US only; elsewhere it is `unavailable`).
 *
 * Privacy floor: the nearby aggregate is shown only when at least
 * MIN_NEARBY_STATIONS (3) other stations contribute to it, per variable;
 * otherwise it is null with a reason, and the station count reads 0.
 *
 * Privacy (owner ruling 2026-10-01 / 2026-11-05): every coordinate this module
 * uses, including the distance test and the NWS lookup, is first rounded to
 * 0.1 degree, and no coordinate leaves it. Every station is treated the same.
 *
 * Read-side only: nothing here feeds rewards, verification or flags.
 *
 * Variables compared: temperature, humidity and dew point. Pressure is not
 * compared, because station pressure depends on each station's height above
 * sea level.
 *
 * Cost: one result per station is cached for RESULT_TTL_MS and concurrent
 * reads share one in-flight promise; the NWS read is cached per 0.1-degree cell
 * for NWS_TTL_MS; the station list for LIST_TTL_MS. Chain reads go through the
 * shared ChainTailReader, which has its own cache and per-read call cap.
 */
import type { ChainTailReader } from './chain-station-tail.js';

export const NEARBY_RADIUS_KM = 100;
export const MAX_NEARBY_STATIONS = 10;
/**
 * Privacy floor (lead ruling 2026-11-08): a nearby median is shown only when at least this many
 * other stations contribute to it. With one or two neighbours the "median" is, or nearly is, one
 * identifiable station's reading.
 */
export const MIN_NEARBY_STATIONS = 3;
/** A nearby reading counts only if it was taken within this long of ours. */
export const NEARBY_MAX_SKEW_S = 2 * 3600;
/** Our own reading must be at most this old to be compared at all. */
export const MINE_MAX_AGE_S = 6 * 3600;
export const NWS_MAX_AGE_MS = 2 * 3600 * 1000;
const RESULT_TTL_MS = 120_000;
const NWS_TTL_MS = 15 * 60_000;
const LIST_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 512;

export const COMPARE_VARIABLES = ['temperature_c', 'humidity_pct', 'dewpoint_c'] as const;
export type CompareVariable = typeof COMPARE_VARIABLES[number];

/** Differences inside these bands read as "close". Fixed, and returned with the answer. */
export const CLOSE_WITHIN: Record<CompareVariable, number> = {
  temperature_c: 1.5,
  humidity_pct: 8,
  dewpoint_c: 1.5,
};

export type Agreement = 'close' | 'higher' | 'lower';

export interface RegisteredStation {
  stationId: string;
  latitude: number | null;
  longitude: number | null;
}

export interface NwsReading {
  stationIdentifier: string | null;
  observedAt: number; // epoch seconds
  values: Partial<Record<CompareVariable, number>>;
}

export interface NwsSource {
  /** Latest NWS observation near a 0.1-degree cell centre, or null when there is none. May throw. */
  latest(lat: number, lon: number): Promise<NwsReading | null>;
}

export interface VariableComparison {
  variable: CompareVariable;
  mine: number | null;
  nearby: { stations: number; median: number; lowest: number; highest: number; difference: number; agreement: Agreement } | null;
  nws: { value: number; difference: number; agreement: Agreement } | null;
  closeWithin: number;
}

export type CompareResult =
  | {
      status: 'ok';
      observedAt: number;
      nearby: { stations: number; radiusKm: number; reason: string | null };
      nws: { stationIdentifier: string | null; observedAt: number | null; reason: string | null };
      variables: VariableComparison[];
      notCompared: Array<{ variable: string; reason: string }>;
    }
  | { status: 'no_recent_reading'; reason: string }
  | { status: 'unavailable'; reason: string };

export const NOT_COMPARED = [
  { variable: 'pressure_hpa', reason: 'Station pressure depends on each station\'s height above sea level, so it is not compared.' },
];

/** 0.1 degree, the public grid. Null for anything that is not a finite number in range. */
export function cell(value: unknown, limit: number): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > limit) return null;
  return Math.round(n * 10) / 10;
}

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad;
  const dLon = (bLon - aLon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export function agreement(difference: number, within: number): Agreement {
  if (Math.abs(difference) <= within) return 'close';
  return difference > 0 ? 'higher' : 'lower';
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Newest chain item's values (core4 get_station_observations field names), or null. */
export function readingFromItem(item: Record<string, unknown> | undefined): { observedAt: number; values: Partial<Record<CompareVariable, number>> } | null {
  if (!item) return null;
  const observedAt = finite(item.observed_at);
  if (observedAt === null) return null;
  const v = item.values && typeof item.values === 'object' ? item.values as Record<string, unknown> : {};
  const values: Partial<Record<CompareVariable, number>> = {};
  const t = finite(v.temperature_c);
  const h = finite(v.humidity_percent);
  const d = finite(v.dewpoint_c);
  if (t !== null && t > -90 && t < 65) values.temperature_c = t;
  if (h !== null && h >= 0 && h <= 100) values.humidity_pct = h;
  if (d !== null && d > -90 && d < 40) values.dewpoint_c = d;
  return { observedAt, values };
}

async function newestReading(chainTail: ChainTailReader, stationId: string) {
  const tail = await chainTail.latest(stationId);
  if (tail.kind !== 'ok') return { kind: 'unavailable' as const };
  return { kind: 'ok' as const, reading: readingFromItem(tail.items[0]) };
}

export interface StationComparer {
  compare(stationId: string): Promise<CompareResult>;
}

export function createStationComparer(deps: {
  listStations: () => Promise<RegisteredStation[]>;
  chainTail: ChainTailReader;
  nws: NwsSource;
  now?: () => number;
}): StationComparer {
  const now = deps.now ?? Date.now;
  const results = new Map<string, { expiresAt: number; value: Promise<CompareResult> }>();
  const nwsCache = new Map<string, { expiresAt: number; value: Promise<NwsReading | null | 'error'> }>();
  let list: { expiresAt: number; value: Promise<RegisteredStation[]> } | null = null;

  const bounded = <V>(map: Map<string, V>) => {
    while (map.size > MAX_CACHE_ENTRIES) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };

  function stations(): Promise<RegisteredStation[]> {
    if (list && list.expiresAt > now()) return list.value;
    const entry = { expiresAt: now() + LIST_TTL_MS, value: deps.listStations() };
    entry.value.catch(() => { if (list === entry) list = null; });
    list = entry;
    return entry.value;
  }

  function nwsFor(lat: number, lon: number): Promise<NwsReading | null | 'error'> {
    const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
    const cached = nwsCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.value;
    const entry = {
      expiresAt: now() + NWS_TTL_MS,
      value: deps.nws.latest(lat, lon).catch(() => 'error' as const),
    };
    nwsCache.set(key, entry);
    bounded(nwsCache);
    return entry.value;
  }

  async function build(stationId: string): Promise<CompareResult> {
    let all: RegisteredStation[];
    try {
      all = await stations();
    } catch {
      return { status: 'unavailable', reason: 'The station list is unavailable right now.' };
    }
    const me = all.find(s => s.stationId === stationId);
    const mine = await newestReading(deps.chainTail, stationId);
    if (mine.kind !== 'ok') return { status: 'unavailable', reason: 'The chain could not be read right now.' };
    const nowS = Math.floor(now() / 1000);
    if (!mine.reading || nowS - mine.reading.observedAt > MINE_MAX_AGE_S) {
      return { status: 'no_recent_reading', reason: 'This station has no reading on chain in the last 6 hours.' };
    }
    const reading = mine.reading;
    const lat = cell(me?.latitude, 90);
    const lon = cell(me?.longitude, 180);

    // Nearby stations: 0.1-degree cells only, nearest first, capped.
    let nearbyReason: string | null = null;
    const nearbyReadings: Array<Partial<Record<CompareVariable, number>>> = [];
    if (lat === null || lon === null) {
      nearbyReason = 'This station has no registered location, so nearby stations cannot be found.';
    } else {
      const candidates = all
        .filter(s => s.stationId !== stationId)
        .map(s => ({ s, lat: cell(s.latitude, 90), lon: cell(s.longitude, 180) }))
        .filter((c): c is { s: RegisteredStation; lat: number; lon: number } => c.lat !== null && c.lon !== null)
        .map(c => ({ id: c.s.stationId, km: distanceKm(lat, lon, c.lat, c.lon) }))
        .filter(c => c.km <= NEARBY_RADIUS_KM)
        .sort((a, b) => a.km - b.km || (a.id < b.id ? -1 : 1))
        .slice(0, MAX_NEARBY_STATIONS);
      const reads = await Promise.all(candidates.map(c => newestReading(deps.chainTail, c.id)));
      for (const r of reads) {
        if (r.kind === 'ok' && r.reading && Math.abs(r.reading.observedAt - reading.observedAt) <= NEARBY_MAX_SKEW_S) {
          nearbyReadings.push(r.reading.values);
        }
      }
      if (nearbyReadings.length < MIN_NEARBY_STATIONS) {
        // Below the floor nothing about the neighbours is returned, not even how many there are.
        nearbyReadings.length = 0;
        nearbyReason = `Not enough nearby stations: a nearby comparison needs at least ${MIN_NEARBY_STATIONS} other stations within ${NEARBY_RADIUS_KM} km with a reading from about the same time.`;
      }
    }

    // NWS: the nearest official observation to this station's cell.
    let nwsReading: NwsReading | null = null;
    let nwsReason: string | null = null;
    if (lat === null || lon === null) {
      nwsReason = 'This station has no registered location.';
    } else {
      const got = await nwsFor(lat, lon);
      if (got === 'error') nwsReason = 'The National Weather Service did not answer for this area (it covers the US only).';
      else if (got === null) nwsReason = 'The National Weather Service has no recent observation near this station.';
      else nwsReading = got;
    }

    const variables: VariableComparison[] = COMPARE_VARIABLES.map(variable => {
      const mineValue = reading.values[variable] ?? null;
      const within = CLOSE_WITHIN[variable];
      const others = nearbyReadings.map(v => v[variable]).filter((v): v is number => typeof v === 'number');
      let nearby: VariableComparison['nearby'] = null;
      if (mineValue !== null && others.length >= MIN_NEARBY_STATIONS) {
        const m = median(others);
        const difference = round2(mineValue - m);
        nearby = {
          stations: others.length,
          median: round2(m),
          lowest: round2(Math.min(...others)),
          highest: round2(Math.max(...others)),
          difference,
          agreement: agreement(difference, within),
        };
      }
      let nws: VariableComparison['nws'] = null;
      const nwsValue = nwsReading?.values[variable];
      if (mineValue !== null && typeof nwsValue === 'number') {
        const difference = round2(mineValue - nwsValue);
        nws = { value: round2(nwsValue), difference, agreement: agreement(difference, within) };
      }
      return { variable, mine: mineValue, nearby, nws, closeWithin: within };
    });

    return {
      status: 'ok',
      observedAt: reading.observedAt,
      nearby: { stations: nearbyReadings.length, radiusKm: NEARBY_RADIUS_KM, reason: nearbyReason },
      nws: {
        stationIdentifier: nwsReading?.stationIdentifier ?? null,
        observedAt: nwsReading?.observedAt ?? null,
        reason: nwsReason,
      },
      variables,
      notCompared: NOT_COMPARED,
    };
  }

  return {
    compare(stationId: string) {
      const cached = results.get(stationId);
      if (cached && cached.expiresAt > now()) return cached.value;
      const entry = { expiresAt: now() + RESULT_TTL_MS, value: build(stationId) };
      // A failed or unavailable answer is not kept for the full TTL.
      entry.value.then(
        r => { if (r.status === 'unavailable') entry.expiresAt = now() + 5_000; },
        () => { results.delete(stationId); },
      );
      results.set(stationId, entry);
      bounded(results);
      return entry.value;
    },
  };
}

const NWS_STATION_RE = /^[A-Z0-9]{3,6}$/;

/** Adapter over the existing NOAA/NWS client (noaa-nws-api-service.js getCurrentObservations). */
export function nwsSourceFrom(client: { getCurrentObservations: (lat: number, lon: number, options?: object) => Promise<any> }): NwsSource {
  const degC = (v: any) => (v && typeof v.value === 'number' && Number.isFinite(v.value) && /degC$/.test(String(v.unit)) ? v.value : null);
  const pct = (v: any) => (v && typeof v.value === 'number' && Number.isFinite(v.value) && /percent$/.test(String(v.unit)) ? v.value : null);
  return {
    async latest(lat, lon) {
      const obs = await client.getCurrentObservations(lat, lon, { maxAgeMs: NWS_MAX_AGE_MS, maxStations: 3 });
      if (!obs || obs.stale) return null;
      const observedMs = Date.parse(obs.timestamp);
      if (!Number.isFinite(observedMs)) return null;
      const values: Partial<Record<CompareVariable, number>> = {};
      const t = degC(obs.temperature);
      const h = pct(obs.relativeHumidity);
      const d = degC(obs.dewpoint);
      if (t !== null) values.temperature_c = t;
      if (h !== null) values.humidity_pct = h;
      if (d !== null) values.dewpoint_c = d;
      const id = typeof obs.stationId === 'string' && NWS_STATION_RE.test(obs.stationId) ? obs.stationId : null;
      return { stationIdentifier: id, observedAt: Math.floor(observedMs / 1000), values };
    },
  };
}
