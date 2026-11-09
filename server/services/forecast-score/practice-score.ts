/**
 * The forecast skill rule, integers only (pure: no I/O, no clock, no floating point).
 *
 * This is the website's "practice score" for a point forecast. The chain's skill pay is designed to use the
 * same rule, so this module is written to be mirrored exactly by an integer twin in Rust: every function of
 * THE RULE below is checked against `contract-fixtures/forecast-skill-vectors.json` (schema v2), and the twin
 * runs the same file.
 *
 * THE RULE
 *
 * Inputs are fixed-point integers: temperature in 0.01 °C, pressure in Pa (0.01 hPa). Skill is in millionths.
 *
 * 1. Range. A value outside its variable's range is not used: temperature −10000..=10000, pressure
 *    30000..=120000. An out-of-range reading is ignored; an out-of-range forecast is unscored.
 * 2. Times. `commit` is the commit block's time, `target = commit + lead hours`.
 * 3. Which readings count. Station readings that reached the oracle attestation quorum and are not synthetic.
 *      - for the truth: observed within 15 minutes of `target`, landed in a block whose time is before
 *        `target + 35 min`. A forecast is not scored before the chain tip's time has reached
 *        `target + 35 min` (15 minutes of readings plus 20 minutes for them to land and reach quorum), so
 *        the set of candidate readings is closed when the score is taken;
 *      - for the reference window and `last`: observed in the 24 hours before `commit` AND landed in a block
 *        below the commit's height, so only what the forecaster could have seen is used.
 * 4. Truth (nearestReading): the candidate nearest `target`; ties go to the earlier reading, then the
 *    smaller id. No candidate: no score.
 * 5. Window (hourlyWindow): 24 hourly slots, slot k = [commit − (24 − k) h, commit − (23 − k) h); a slot's
 *    sample is Σ / count of its readings, or empty. `last` (lastReadingBefore) is the newest reading before
 *    `commit` (ties: smaller id).
 * 6. Reference (referenceFromWindow), with n = slots that have a sample, lag = lead hours:
 *      at least 12 samples are required, else no baseline (unscored);
 *      mean24      = Σx / n
 *      spread      = isqrt( (n·Σx² − (Σx)²) / n² )
 *      persistence = isqrt( Σ(x[i+lag] − x[i])² / pairs ) over slot pairs where both have a sample, used only
 *                    when there are at least 6 pairs
 *      reference   = persistence if it is used and smaller than spread, else spread
 * 7. Score (skillScore):
 *      err   = |forecast − truth|
 *      copy  = |forecast − mean24| ≤ tol  or  |forecast − last| ≤ tol            (tol default 5)
 *      skill = 0 if copy or reference == 0, else max(0, 1_000_000 − 1_000_000 · err / reference)
 *
 * Every division is integer division truncating toward zero (BigInt `/`, Rust's integer `/`); isqrt is the
 * floor square root. Widths: with |x| ≤ 120000 (rule 1) and n ≤ 24, n·Σx² ≤ 24 · 24 · 120000² < 8.3e12 and
 * (Σx)² ≤ (24 · 120000)² < 8.3e12; Σ(Δx)² ≤ 24 · 240000² < 1.4e12; 1_000_000 · err ≤ 2.4e11. All fit i64.
 * (skillScore itself is exact for any |value| ≤ 2^31: 1_000_000 · err < 2^53.)
 *
 * NOT part of the rule: parseFixedPoint / numberToFixedPoint. The node relays readings as JSON decimals
 * today, so the backend needs an adapter from decimal text to fixed point. The chain rule takes integers.
 */

export const SCORE_PRECISION = 1_000_000n;
export const DEFAULT_COPY_TOLERANCE = 5n;
/** Hourly samples in the reference window: the 24 hours before the forecast was committed. */
export const WINDOW_HOURS = 24;
/** Fewer hourly samples than this: no baseline. */
export const MIN_WINDOW_SAMPLES = 12;
/** Fewer persistence pairs than this: the reference is the spread. */
export const MIN_PERSISTENCE_PAIRS = 6;
/** Decimal places kept by both fixed-point units (0.01 °C; 0.01 hPa = 1 Pa). */
export const FIXED_POINT_DIGITS = 2;

export const FIXED_POINT_UNITS = { temperature_c: 'temp_c_centi', pressure_hpa: 'pressure_pa' } as const;
export type ScoredVariable = keyof typeof FIXED_POINT_UNITS;
export const isScoredVariable = (v: unknown): v is ScoredVariable => typeof v === 'string' && Object.prototype.hasOwnProperty.call(FIXED_POINT_UNITS, v);

/** Rule 1: inclusive ranges, in fixed-point units. */
export const VALUE_RANGE: Record<ScoredVariable, readonly [bigint, bigint]> = {
  temperature_c: [-10_000n, 10_000n],
  pressure_hpa: [30_000n, 120_000n],
};
export const inRange = (variable: ScoredVariable, value: bigint) => value >= VALUE_RANGE[variable][0] && value <= VALUE_RANGE[variable][1];

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
 * Backend adapter, not part of the rule. A plain decimal text ("12.3", "-0.045", "1013") as a fixed-point
 * integer with FIXED_POINT_DIGITS places, rounded half away from zero. Text only: the digits are never turned
 * into a floating-point number. Returns null for anything else: exponent form, blanks, a sign other than
 * a leading "-", more than 15 integer digits or more than 20 fraction digits.
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
 * Backend adapter, not part of the rule. A JSON number as fixed point, through its shortest decimal text
 * (what JSON.stringify writes). Null when the number has no plain decimal form.
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

/** Rule 7. */
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
  /** Slot pairs `lag` hours apart where both have a sample. */
  pairs: number;
  /** Null when there are fewer than MIN_PERSISTENCE_PAIRS pairs. */
  persistence: bigint | null;
  reference: bigint;
  kind: ReferenceKind;
}

/**
 * Rule 6: the reference error from the station's own hourly samples (oldest first; null = an hour with no
 * reading). `lag` is the forecast lead in hours (at least 1). Returns null (no baseline) when fewer than
 * MIN_WINDOW_SAMPLES hours have a reading.
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
  if (n < BigInt(MIN_WINDOW_SAMPLES)) return null;
  const spread = isqrt((n * sumSq - sum * sum) / (n * n));
  let pairs = 0n;
  let sq = 0n;
  for (let i = 0; i + lag < window.length; i += 1) {
    const a = window[i];
    const b = window[i + lag];
    if (a === null || b === null) continue;
    pairs += 1n; sq += (b - a) * (b - a);
  }
  const persistence = pairs < BigInt(MIN_PERSISTENCE_PAIRS) ? null : isqrt(sq / pairs);
  const usePersistence = persistence !== null && persistence < spread;
  return {
    samples: Number(n),
    mean24: sum / n,
    spread,
    pairs: Number(pairs),
    persistence,
    reference: usePersistence ? persistence : spread,
    kind: usePersistence ? 'persistence_spread' : 'climatology_spread',
  };
}

export interface Reading {
  /** Unix seconds. */
  observedAt: number;
  value: bigint;
  /** Tie-breaker only (the reading's commit id). */
  id: string;
}

const usable = (r: Reading) => Number.isSafeInteger(r.observedAt);

/**
 * Rule 5: hourly samples for the 24 hours before `anchor` (unix seconds). Slot k covers
 * [anchor − (24 − k) h, anchor − (23 − k) h) and holds the mean of its readings (Σ / count), or null.
 */
export function hourlyWindow(readings: ReadonlyArray<Reading>, anchor: number): Array<bigint | null> {
  const sums: Array<{ sum: bigint; n: bigint } | null> = Array.from({ length: WINDOW_HOURS }, () => null);
  const start = anchor - WINDOW_HOURS * 3600;
  for (const r of readings) {
    if (!usable(r) || r.observedAt < start || r.observedAt >= anchor) continue;
    const slot = Math.floor((r.observedAt - start) / 3600);
    const s = (sums[slot] ||= { sum: 0n, n: 0n });
    s.sum += r.value; s.n += 1n;
  }
  return sums.map((s) => (s ? s.sum / s.n : null));
}

/** Rule 5: the newest reading in the 24 hours before `anchor` (ties: smaller id), or null. */
export function lastReadingBefore(readings: ReadonlyArray<Reading>, anchor: number): Reading | null {
  let best: Reading | null = null;
  for (const r of readings) {
    if (!usable(r) || r.observedAt >= anchor || r.observedAt < anchor - WINDOW_HOURS * 3600) continue;
    if (!best || r.observedAt > best.observedAt || (r.observedAt === best.observedAt && r.id < best.id)) best = r;
  }
  return best;
}

/** The truth reading must be observed at most this far from the forecast's target time. */
export const TRUTH_MAX_DISTANCE_S = 15 * 60;
/** Time allowed for a reading to land in a block and reach quorum after the reading window closes. */
export const LANDING_MARGIN_S = 20 * 60;
/** Rule 3: no score before the chain tip's time has reached target + this. */
export const SCORE_DELAY_S = TRUTH_MAX_DISTANCE_S + LANDING_MARGIN_S;

/** Rule 4: the reading nearest `validAt`, at most 15 minutes away (ties: the earlier reading, then the smaller id). */
export function nearestReading(readings: ReadonlyArray<Reading>, validAt: number): Reading | null {
  let best: Reading | null = null;
  let bestDistance = 0;
  for (const r of readings) {
    if (!usable(r)) continue;
    const distance = Math.abs(r.observedAt - validAt);
    if (distance > TRUTH_MAX_DISTANCE_S) continue;
    const wins = !best || distance < bestDistance
      || (distance === bestDistance && (r.observedAt < best.observedAt || (r.observedAt === best.observedAt && r.id < best.id)));
    if (wins) { best = r; bestDistance = distance; }
  }
  return best;
}
