/**
 * "Has this station moved?" (Epic 8): a private note to a station's owner when the station's
 * readings start to look like a different place.
 *
 * It reads the hourly pairs the compare-history sampler stores (a station's reading beside the
 * nearest National Weather Service observation, station_compare_samples) and looks for a step:
 *
 *  - Pressure. NWS `barometricPressure` is treated in this codebase as the altimeter setting
 *    (reduced to sea level), so it is never subtracted from a station's pressure. The RATIO
 *    ours / reference is used instead: it depends on the station's height and hardly on the
 *    weather, whichever kind of pressure either side reports. A lasting change in that ratio
 *    means the station is now higher or lower than it was (about 8.4 m per 0.1 %), or its
 *    pressure sensor was changed or recalibrated.
 *  - Temperature. A lasting change in how much warmer or cooler the station reads than the NWS
 *    station means its surroundings changed: moved, re-sited (sun, wall, indoors) or a new sensor.
 *
 * "Lasting" compares the last RECENT_DAYS days with the BEFORE_DAYS days before them, LIKE HOUR
 * WITH LIKE HOUR: each recent pair is measured against the earlier median for the same hour of
 * the day (UTC). A station that was only online for a few afternoon hours is therefore compared
 * with earlier afternoons, not with a 24-hour average. It also needs recent pairs on at least
 * MIN_RECENT_DAYS different days, at least MIN_MATCHED_HOURS hours of the day present on both
 * sides, a minimum size, a size relative to the earlier scatter, and most recent pairs on the new
 * side. Only pairs against one and the same NWS station are used, because the offset depends on
 * the reference too.
 *
 * This is a hint, not a finding. It does not say when a change began: `recentFrom` is only where
 * the newer window starts. It goes to the owner only (station-owner-insights-routes.ts), is never
 * shown publicly, and feeds no reward, verification or public status.
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
/** Recent pairs must fall on at least this many different UTC days. */
export const MIN_RECENT_DAYS = 2;
/** Hours of the day that must have pairs on both sides. */
export const MIN_MATCHED_HOURS = 6;
/** Standard-atmosphere scale height: a pressure ratio change of e^(-h / H). */
export const SCALE_HEIGHT_M = 8434;
/**
 * Smallest lasting change that is mentioned at all. Pressure is in log-ratio units: 0.003 is 0.3 %,
 * about 25 m of height (3 hPa at sea level). Temperature is in degrees C.
 */
export const MIN_SHIFT = { pressure_log_ratio: 0.003, temperature_c: 4 } as const;
/** The change must also be this many times the earlier scatter (scaled median absolute deviation). */
export const SCATTER_FACTOR = { pressure_log_ratio: 3, temperature_c: 2 } as const;
/** Share of recent pairs that must sit on the new side (past the halfway point of the change). */
export const MIN_SHARE_ON_NEW_SIDE = 0.75;
const DAY_S = 86_400;
const MAD_TO_SIGMA = 1.4826;
const SEA_LEVEL_HPA = 1013.25;

export type SiteFlag =
  | {
      kind: 'pressure_offset_changed';
      /** Change in ours / reference, in percent: negative means this station now reads lower pressure. */
      shiftPercent: number;
      /** The same change as a rough hPa figure at sea level, for wording only. */
      approxShiftHpa: number;
      /** Rounded to 10 m. */
      approxHeightChangeM: number;
      heightDirection: 'higher' | 'lower';
    }
  | {
      kind: 'temperature_pattern_changed';
      /** Change in (ours - reference), degrees C: positive means this station now reads warmer than before. */
      shiftC: number;
    };

export type SiteCheckResult =
  | {
      status: 'ok';
      checkedFrom: number;
      checkedTo: number;
      /** Where the newer window starts (epoch seconds). NOT when a change began. */
      recentFrom: number;
      reference: { kind: 'nws'; stationIdentifier: string };
      flags: SiteFlag[];
      note: string;
    }
  | { status: 'not_enough_data'; reason: string };

export const SITE_CHECK_NOTE =
  'A hint for you only. It is not shown to anyone else and does not change rewards. A new or recalibrated sensor looks the same as a move.';

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** One compared value with the time it was observed (epoch seconds). */
export interface Timed { at: number; value: number }

const hourOf = (at: number) => Math.floor((at % DAY_S) / 3600);

/**
 * Pure: is there a lasting step between the two sets, comparing like hours of the day?
 * Each recent value is measured against the earlier median for its own hour (UTC).
 */
export function lastingStep(before: Timed[], recent: Timed[], minShift: number, scatterFactor: number): { shift: number } | null {
  if (before.length < MIN_BEFORE_PAIRS || recent.length < MIN_RECENT_PAIRS) return null;
  if (new Set(recent.map(r => Math.floor(r.at / DAY_S))).size < MIN_RECENT_DAYS) return null;
  const byHour = new Map<number, number[]>();
  for (const b of before) {
    const h = hourOf(b.at);
    const list = byHour.get(h);
    if (list) list.push(b.value); else byHour.set(h, [b.value]);
  }
  const baseline = new Map<number, number>();
  for (const [h, values] of byHour) if (values.length >= 2) baseline.set(h, median(values));
  // What each recent value is above or below the usual value for that hour.
  const moved = recent.filter(r => baseline.has(hourOf(r.at))).map(r => r.value - (baseline.get(hourOf(r.at)) as number));
  const matchedHours = new Set(recent.filter(r => baseline.has(hourOf(r.at))).map(r => hourOf(r.at)));
  if (moved.length < MIN_RECENT_PAIRS || matchedHours.size < MIN_MATCHED_HOURS) return null;
  const shift = median(moved);
  if (Math.abs(shift) < minShift) return null;
  // Earlier scatter around the same hourly baseline.
  const residuals = before.filter(b => baseline.has(hourOf(b.at))).map(b => Math.abs(b.value - (baseline.get(hourOf(b.at)) as number)));
  const scatter = MAD_TO_SIGMA * median(residuals);
  if (Math.abs(shift) < scatterFactor * scatter) return null;
  const onNewSide = moved.filter(d => (shift > 0 ? d > shift / 2 : d < shift / 2)).length;
  if (onNewSide / moved.length < MIN_SHARE_ON_NEW_SIDE) return null;
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
  const pressureRatio = (rows: CompareSample[]): Timed[] => rows.flatMap(s => (
    typeof s.pressureHpa === 'number' && typeof s.nwsBarometricHpa === 'number' && s.pressureHpa > 0 && s.nwsBarometricHpa > 0
      ? [{ at: s.observedAt, value: Math.log(s.pressureHpa / s.nwsBarometricHpa) }] : []));
  const temperatureGap = (rows: CompareSample[]): Timed[] => rows.flatMap(s => (
    typeof s.temperatureC === 'number' && typeof s.nwsTemperatureC === 'number'
      ? [{ at: s.observedAt, value: s.temperatureC - s.nwsTemperatureC }] : []));
  const flags: SiteFlag[] = [];

  const pressure = lastingStep(pressureRatio(before), pressureRatio(recent), MIN_SHIFT.pressure_log_ratio, SCATTER_FACTOR.pressure_log_ratio);
  if (pressure) {
    const factor = Math.exp(pressure.shift) - 1;
    flags.push({
      kind: 'pressure_offset_changed',
      shiftPercent: round2(factor * 100),
      approxShiftHpa: round1(factor * SEA_LEVEL_HPA),
      approxHeightChangeM: Math.max(10, Math.round((Math.abs(pressure.shift) * SCALE_HEIGHT_M) / 10) * 10),
      // Lower pressure than before means higher up than before.
      heightDirection: pressure.shift < 0 ? 'higher' : 'lower',
    });
  }
  const temperature = lastingStep(temperatureGap(before), temperatureGap(recent), MIN_SHIFT.temperature_c, SCATTER_FACTOR.temperature_c);
  if (temperature) flags.push({ kind: 'temperature_pattern_changed', shiftC: round1(temperature.shift) });

  return {
    status: 'ok',
    checkedFrom: Math.min(...used.map(s => s.observedAt)),
    checkedTo: Math.max(...used.map(s => s.observedAt)),
    recentFrom: Math.floor(recentFrom / DAY_S) * DAY_S,
    reference: { kind: 'nws', stationIdentifier: reference },
    flags,
    note: SITE_CHECK_NOTE,
  };
}
