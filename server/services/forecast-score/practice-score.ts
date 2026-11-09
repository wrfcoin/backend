/**
 * The forecast skill rule, integers only (pure: no I/O, no clock, no floating point).
 *
 * This is the website's "practice score" for a point forecast. The chain's skill pay is designed to use the
 * same rule, so this module is written to be mirrored exactly by an integer twin in Rust: every function
 * here is checked against `contract-fixtures/forecast-skill-vectors.json`, and the twin runs the same file.
 *
 * Units (fixed point): temperature in 0.01 °C, pressure in Pa (0.01 hPa). Skill is in millionths.
 *
 *   err   = |forecast − truth|
 *   ref   = the smaller of the station's 24 h spread and its lagged-persistence error (referenceFromWindow)
 *   copy  = |forecast − mean24| ≤ tol  or  |forecast − last| ≤ tol            (tol default 5)
 *   skill = 0 if copy or ref == 0, else max(0, 1_000_000 − 1_000_000 · err / ref)   (integer division)
 *
 * Arithmetic is BigInt throughout, and every division truncates toward zero (BigInt `/`, the same as Rust's
 * integer `/`). For the twin: with |values| ≤ 2^31, `1_000_000 · err` is below 2^53, so u64 (and i64) never overflow.
 */

export const SCORE_PRECISION = 1_000_000n;
export const DEFAULT_COPY_TOLERANCE = 5n;
/** Hourly samples in the reference window: the 24 hours before the forecast was committed. */
export const WINDOW_HOURS = 24;
/** Decimal places kept by both fixed-point units (0.01 °C; 0.01 hPa = 1 Pa). */
export const FIXED_POINT_DIGITS = 2;

export const FIXED_POINT_UNITS = { temperature_c: 'temp_c_centi', pressure_hpa: 'pressure_pa' } as const;
export type ScoredVariable = keyof typeof FIXED_POINT_UNITS;

const abs = (v: bigint) => (v < 0n ? -v : v);

/** Largest r with r·r ≤ n (Newton's method on integers); n must not be negative. */
export function isqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('isqrt of a negative number');
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}

/**
 * A plain decimal text ("12.3", "-0.045", "1013") as a fixed-point integer with FIXED_POINT_DIGITS places,
 * rounded half away from zero. Text only: the digits are never turned into a floating-point number.
 * Returns null for anything else (exponent form, blanks, more than 15 integer digits).
 */
export function parseFixedPoint(text: string): bigint | null {
  const m = /^(-?)([0-9]{1,15})(?:\.([0-9]{1,20}))?$/.exec(text);
  if (!m) return null;
  const frac = m[3] ?? '';
  const kept = frac.slice(0, FIXED_POINT_DIGITS).padEnd(FIXED_POINT_DIGITS, '0');
  let magnitude = BigInt(m[2] + kept);
  const next = frac.charCodeAt(FIXED_POINT_DIGITS);
  if (next >= 53 /* '5' */) magnitude += 1n;
  return m[1] === '-' && magnitude !== 0n ? -magnitude : magnitude;
}

/**
 * A JSON number as fixed point, through its shortest decimal text (what JSON.stringify writes), so the
 * score path does no floating-point arithmetic. Null when the number has no plain decimal form.
 */
export function numberToFixedPoint(value: unknown): bigint | null {
  return typeof value === 'number' && Number.isFinite(value) ? parseFixedPoint(String(Object.is(value, -0) ? 0 : value)) : null;
}

export interface SkillInput {
  forecast: bigint;
  truth: bigint;
  reference: bigint;
  mean24: bigint;
  last: bigint;
  tol?: bigint;
}

export interface SkillResult {
  err: bigint;
  copy: boolean;
  /** 0 ..= 1_000_000. */
  skill: bigint;
  /** The forecast's error is smaller than the reference error and it is not a copy: skill > 0. */
  beatBaseline: boolean;
}

/** `max(0, 1_000_000 − 1_000_000 · err / reference)`, and 0 for a zero reference. */
export function ratioSkill(err: bigint, reference: bigint): bigint {
  if (err < 0n || reference < 0n) throw new RangeError('err and reference must not be negative');
  if (reference === 0n) return 0n;
  const lost = (SCORE_PRECISION * err) / reference;
  return lost >= SCORE_PRECISION ? 0n : SCORE_PRECISION - lost;
}

export function skillScore(input: SkillInput): SkillResult {
  const tol = input.tol ?? DEFAULT_COPY_TOLERANCE;
  if (tol < 0n) throw new RangeError('tol must not be negative');
  const err = abs(input.forecast - input.truth);
  const copy = abs(input.forecast - input.mean24) <= tol || abs(input.forecast - input.last) <= tol;
  const skill = copy ? 0n : ratioSkill(err, input.reference);
  return { err, copy, skill, beatBaseline: skill > 0n };
}

export type ReferenceKind = 'climatology_spread' | 'persistence_spread';

export interface WindowReference {
  /** Hours of the window that had a reading. */
  samples: number;
  mean24: bigint;
  spread: bigint;
  /** Null when no two samples are `lag` hours apart. */
  persistence: bigint | null;
  reference: bigint;
  kind: ReferenceKind;
}

/**
 * The reference error from the station's own hourly samples (oldest first; null = an hour with no reading).
 *
 *   mean24      = Σx / n
 *   spread      = isqrt( (n·Σx² − (Σx)²) / n² )            the population standard deviation, floored
 *   persistence = isqrt( Σ(x[i+lag] − x[i])² / pairs )      over pairs where both hours have a reading
 *   reference   = persistence if it exists and is smaller than spread, else spread
 *
 * `lag` is the forecast lead in hours (at least 1). Returns null when fewer than two hours have a reading.
 */
export function referenceFromWindow(window: ReadonlyArray<bigint | null>, lag: number): WindowReference | null {
  if (!Number.isInteger(lag) || lag < 1) throw new RangeError('lag must be a whole number of hours, at least 1');
  let n = 0n;
  let sum = 0n;
  let sumSq = 0n;
  for (const x of window) {
    if (x === null) continue;
    n += 1n; sum += x; sumSq += x * x;
  }
  if (n < 2n) return null;
  const spread = isqrt((n * sumSq - sum * sum) / (n * n));
  let pairs = 0n;
  let sq = 0n;
  for (let i = 0; i + lag < window.length; i += 1) {
    const a = window[i];
    const b = window[i + lag];
    if (a === null || b === null) continue;
    pairs += 1n; sq += (b - a) * (b - a);
  }
  const persistence = pairs === 0n ? null : isqrt(sq / pairs);
  const usePersistence = persistence !== null && persistence < spread;
  return {
    samples: Number(n),
    mean24: sum / n,
    spread,
    persistence,
    reference: usePersistence ? persistence : spread,
    kind: usePersistence ? 'persistence_spread' : 'climatology_spread',
  };
}

export interface Reading {
  /** Unix seconds. */
  observedAt: number;
  value: bigint;
  /** Tie-breaker only. */
  id: string;
}

/**
 * Hourly samples for the 24 hours before `anchor` (unix seconds): slot k covers
 * [anchor − (24 − k) h, anchor − (23 − k) h) and holds the mean of its readings (Σ / count), or null.
 */
export function hourlyWindow(readings: ReadonlyArray<Reading>, anchor: number): Array<bigint | null> {
  const sums: Array<{ sum: bigint; n: bigint } | null> = Array.from({ length: WINDOW_HOURS }, () => null);
  const start = anchor - WINDOW_HOURS * 3600;
  for (const r of readings) {
    if (!Number.isSafeInteger(r.observedAt) || r.observedAt < start || r.observedAt >= anchor) continue;
    const slot = Math.floor((r.observedAt - start) / 3600);
    const s = (sums[slot] ||= { sum: 0n, n: 0n });
    s.sum += r.value; s.n += 1n;
  }
  return sums.map((s) => (s ? s.sum / s.n : null));
}

const earlier = (a: Reading, b: Reading) => a.observedAt < b.observedAt || (a.observedAt === b.observedAt && a.id < b.id);

/** The newest reading in the 24 hours before `anchor` (ties: smaller id), or null. */
export function lastReadingBefore(readings: ReadonlyArray<Reading>, anchor: number): Reading | null {
  let best: Reading | null = null;
  for (const r of readings) {
    if (r.observedAt >= anchor || r.observedAt < anchor - WINDOW_HOURS * 3600) continue;
    if (!best || r.observedAt > best.observedAt || (r.observedAt === best.observedAt && r.id < best.id)) best = r;
  }
  return best;
}

/** The truth reading must be observed at most this far from the forecast's target time. */
export const TRUTH_MAX_DISTANCE_S = 15 * 60;

/** The reading nearest `validAt`, at most 15 minutes away (ties: the earlier reading, then the smaller id). */
export function nearestReading(readings: ReadonlyArray<Reading>, validAt: number): Reading | null {
  let best: Reading | null = null;
  let bestDistance = Infinity;
  for (const r of readings) {
    const distance = Math.abs(r.observedAt - validAt);
    if (distance > TRUTH_MAX_DISTANCE_S) continue;
    if (!best || distance < bestDistance || (distance === bestDistance && earlier(r, best))) { best = r; bestDistance = distance; }
  }
  return best;
}
