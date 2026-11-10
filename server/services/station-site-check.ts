/**
 * "Has this station moved?" (Epic 8): a private note to a station's owner when the station's
 * readings start to look like a different place.
 *
 * It reads the hourly pairs the compare-history sampler stores (a station's reading beside the
 * nearest National Weather Service observation, station_compare_samples) and looks for a step:
 *
 *  - Pressure. Station pressure depends on height above sea level, so the difference between this
 *    station and the NWS station is normally steady whatever the weather does. A lasting jump in
 *    that difference means the station is now higher or lower than it was (about 8 m per hPa),
 *    or the pressure sensor was changed or recalibrated.
 *  - Temperature. A lasting change in how much warmer or cooler the station reads than the NWS
 *    station means its surroundings changed: moved, re-sited (sun, wall, indoors) or a new sensor.
 *
 * "Lasting" is the median of the last RECENT_DAYS days against the median of the BEFORE_DAYS days
 * before them, with a minimum size, a size relative to the earlier scatter, and most recent
 * readings on the new side. Only pairs against one and the same NWS station are used, because
 * the offset depends on the reference too.
 *
 * This is a hint, not a finding. It goes to the owner only (station-owner-insights-routes.ts),
 * is never shown publicly, and feeds no reward, verification or public status.
 *
 * OFF unless STATION_SITE_CHECK_ENABLED=true. Needs the compare-history sampler
 * (STATION_COMPARE_HISTORY_ENABLED=true, migration 0046) for its data.
 */
import { median } from './station-compare.js';
import { dominantReference, type CompareSample } from './station-compare-history.js';

export const stationSiteCheckEnabled = () => process.env.STATION_SITE_CHECK_ENABLED === 'true';

export const RECENT_DAYS = 3;
export const BEFORE_DAYS = 14;
export const MIN_RECENT_PAIRS = 12;
export const MIN_BEFORE_PAIRS = 36;
/** Smallest lasting change that is mentioned at all. 3 hPa is roughly 25 m of height. */
export const MIN_SHIFT = { pressure_hpa: 3, temperature_c: 4 } as const;
/** The change must also be this many times the earlier scatter (scaled median absolute deviation). */
export const SCATTER_FACTOR = { pressure_hpa: 3, temperature_c: 2 } as const;
/** Share of recent readings that must sit on the new side (past the halfway point of the change). */
export const MIN_SHARE_ON_NEW_SIDE = 0.75;
/** Near sea level, 1 hPa of pressure is about 8.3 m of height. */
export const METRES_PER_HPA = 8.3;
const DAY_S = 86_400;
const MAD_TO_SIGMA = 1.4826;

export type SiteFlag =
  | {
      kind: 'pressure_offset_changed';
      /** Change in (ours - reference), hPa: negative means this station now reads lower pressure. */
      shiftHpa: number;
      /** Rounded to 10 m. */
      approxHeightChangeM: number;
      heightDirection: 'higher' | 'lower';
      /** Start of the day (UTC) the newer readings begin, epoch seconds. */
      since: number;
    }
  | {
      kind: 'temperature_pattern_changed';
      /** Change in (ours - reference), degrees C: positive means this station now reads warmer than before. */
      shiftC: number;
      since: number;
    };

export type SiteCheckResult =
  | {
      status: 'ok';
      checkedFrom: number;
      checkedTo: number;
      reference: { kind: 'nws'; stationIdentifier: string };
      flags: SiteFlag[];
      note: string;
    }
  | { status: 'not_enough_data'; reason: string };

export const SITE_CHECK_NOTE =
  'A hint for you only. It is not shown to anyone else and does not change rewards. A new or recalibrated sensor looks the same as a move.';

const round1 = (n: number) => Math.round(n * 10) / 10;

interface Step { shift: number; }

/** Pure: is there a lasting step between the two sets of differences? */
export function lastingStep(before: number[], recent: number[], minShift: number, scatterFactor: number): Step | null {
  if (before.length < MIN_BEFORE_PAIRS || recent.length < MIN_RECENT_PAIRS) return null;
  const was = median(before);
  const shift = median(recent) - was;
  if (Math.abs(shift) < minShift) return null;
  const scatter = MAD_TO_SIGMA * median(before.map(d => Math.abs(d - was)));
  if (Math.abs(shift) < scatterFactor * scatter) return null;
  const halfway = was + shift / 2;
  const onNewSide = recent.filter(d => (shift > 0 ? d > halfway : d < halfway)).length;
  if (onNewSide / recent.length < MIN_SHARE_ON_NEW_SIDE) return null;
  return { shift };
}

/** Pure: the site check over one station's samples (any order). */
export function checkSite(samples: CompareSample[], nowS: number): SiteCheckResult {
  const recentFrom = nowS - RECENT_DAYS * DAY_S;
  const beforeFrom = recentFrom - BEFORE_DAYS * DAY_S;
  const windowed = samples.filter(s => s.observedAt >= beforeFrom && s.observedAt <= nowS);
  const reference = dominantReference(windowed);
  const used = reference === null ? [] : windowed.filter(s => s.nwsStation === reference);
  const before = used.filter(s => s.observedAt < recentFrom);
  const recent = used.filter(s => s.observedAt >= recentFrom);
  if (reference === null || before.length < MIN_BEFORE_PAIRS || recent.length < MIN_RECENT_PAIRS) {
    return {
      status: 'not_enough_data',
      reason: `Not enough history yet: this needs about ${BEFORE_DAYS + RECENT_DAYS} days of hourly comparisons with one National Weather Service station.`,
    };
  }
  const diffs = (rows: CompareSample[], mine: 'pressureHpa' | 'temperatureC', theirs: 'nwsPressureHpa' | 'nwsTemperatureC') => {
    const out: number[] = [];
    for (const s of rows) {
      const a = s[mine];
      const b = s[theirs];
      if (typeof a === 'number' && typeof b === 'number') out.push(a - b);
    }
    return out;
  };
  const since = Math.floor(recentFrom / DAY_S) * DAY_S;
  const flags: SiteFlag[] = [];

  const pressure = lastingStep(
    diffs(before, 'pressureHpa', 'nwsPressureHpa'), diffs(recent, 'pressureHpa', 'nwsPressureHpa'),
    MIN_SHIFT.pressure_hpa, SCATTER_FACTOR.pressure_hpa,
  );
  if (pressure) {
    flags.push({
      kind: 'pressure_offset_changed',
      shiftHpa: round1(pressure.shift),
      approxHeightChangeM: Math.max(10, Math.round((Math.abs(pressure.shift) * METRES_PER_HPA) / 10) * 10),
      // Lower pressure than before means higher up than before.
      heightDirection: pressure.shift < 0 ? 'higher' : 'lower',
      since,
    });
  }
  const temperature = lastingStep(
    diffs(before, 'temperatureC', 'nwsTemperatureC'), diffs(recent, 'temperatureC', 'nwsTemperatureC'),
    MIN_SHIFT.temperature_c, SCATTER_FACTOR.temperature_c,
  );
  if (temperature) flags.push({ kind: 'temperature_pattern_changed', shiftC: round1(temperature.shift), since });

  return {
    status: 'ok',
    checkedFrom: Math.min(...used.map(s => s.observedAt)),
    checkedTo: Math.max(...used.map(s => s.observedAt)),
    reference: { kind: 'nws', stationIdentifier: reference },
    flags,
    note: SITE_CHECK_NOTE,
  };
}
