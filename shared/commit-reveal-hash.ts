/**
 * Commit-reveal hashing that is byte-for-byte compatible with the core4 Rust node.
 *
 * Bug #767: the backend previously hashed `blake3(JSON.stringify(readings) + nonce)`,
 * but core4 (`Transaction::compute_commit_id`) hashes
 *   SHA3-256( serde_json(data) || nonce || station_id || timestamp || contribution_type )
 * over a JSON **object** (not an array). The two never matched, so reveals were rejected
 * with 422 "Reveal payload does not match commit_hash" (after first failing the
 * "payload must be a JSON object" gate).
 *
 * This module mirrors the already-on-chain-accepted testnet collector
 * (`infra/scripts/weather-station-onboarding.js` — `sha3Hex` / `canonicalizeJson` /
 * `makeCommitHash`): SHA3-256 via node's built-in crypto, lowercase hex, the 5-field
 * `||` preimage, `contribution_type='contribution'`, and a single flat reading object
 * as `data`. core4's serde_json has no `preserve_order` feature, so it re-serializes
 * object keys in sorted (BTreeMap) order — `canonicalizeJson` reproduces that here.
 *
 * Numeric quantization (#1288): every reading field is rounded to 2 decimal places
 * (half away from zero, -0 -> 0) BEFORE hashing and in the reveal body. core4
 * re-serializes the PARSED reveal payload with serde_json, whose float parsing is not
 * round-trip exact for 16-17 significant digit doubles (a phone float32 widened to f64,
 * e.g. 1008.2767333984375), so the recomputed commit id diverged and the reveal was
 * rejected 422. A 2-decimal value has <= 15 significant digits and a small exponent, so
 * serde's fast path parses it exactly and JS/Rust print identical text. The mobile
 * client applies the IDENTICAL rule (see quantize2dp).
 */

import crypto from 'node:crypto';
import type { CommitRevealReading } from './types/weather-types.js';

/** Default contribution type — core4 hardcodes this string for both commit and reveal. */
export const DEFAULT_CONTRIBUTION_TYPE = 'contribution';

/** The canonical flat weather reading core4 hashes and scores (matches the collector). */
export interface CanonicalReading {
  temperature_c: number;
  humidity_pct: number;
  pressure_hpa: number;
  wind_mps: number;
  rainfall_mm: number;
}

function sha3Hex(value: string): string {
  return crypto.createHash('sha3-256').update(value).digest('hex');
}

/**
 * Recursively sort object keys so JSON.stringify matches Rust serde_json's
 * BTreeMap (alphabetical) key order. Mirrors the collector's `canonicalizeJson`.
 */
export function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalizeJson((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Thrown when a canonical reading cannot be built because a required scalar
 * field was present in the wire payload but could not be parsed to a finite
 * number (e.g. mobile#217: `value` arrived as an object, not a scalar). Callers
 * should map this to a 4xx so the physically-impossible reading is rejected
 * rather than fail-open into a rewarded, all-zero on-chain contribution.
 */
export class CommitRevealValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommitRevealValidationError';
  }
}

/**
 * Round to 2 decimal places, half away from zero, normalising -0 to 0.
 * MUST stay byte-identical to the mobile client's rule.
 */
export function quantize2dp(x: number): number {
  const q = (Math.sign(x) * Math.round(Math.abs(x) * 100)) / 100;
  return q === 0 ? 0 : q;
}

/** Coerce to a finite number, falling back to 0 for missing/invalid fields (collector parity). */
function toFiniteOrZero(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Like `toFiniteOrZero`, but does NOT fail-open when the field was *present but
 * unparseable*. A truly absent field (undefined/null) still yields 0 so that
 * legitimate readings which simply omit this measurement keep working; but a
 * present-yet-non-finite value (an object, an array, NaN, a non-numeric string)
 * throws instead of silently becoming 0.
 *
 * Scoped to `pressure_hpa` (mobile#217): a barometric collector that ships a
 * physically-impossible 0 hPa from a mis-shaped payload must not earn a reward.
 * Zero-valued OTHER fields (0°C, 0 mm rain, 0 m/s wind) remain legitimate and
 * keep using `toFiniteOrZero`.
 */
function toFiniteOrThrowIfPresent(value: unknown, fieldName: string): number {
  if (value === undefined || value === null) {
    return 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new CommitRevealValidationError(
      `${fieldName} was present but is not a finite scalar (got ${
        typeof value === 'object' ? JSON.stringify(value) : String(value)
      }); refusing to fail-open to 0`
    );
  }
  return n;
}

/**
 * Build the canonical flat reading object core4 hashes, mapping the backend's
 * WeatherObservation field names to the collector's canonical keys. Multi-reading
 * submissions are collapsed to a single canonical reading by the caller (first reading).
 *
 * Throws {@link CommitRevealValidationError} when `pressure_hpa` is present but
 * unparseable (mobile#217 hardening).
 */
export function buildCanonicalReading(reading: CommitRevealReading): CanonicalReading {
  const humidity =
    reading.humidity_percent !== undefined && reading.humidity_percent !== null
      ? reading.humidity_percent
      : (reading as Record<string, unknown>).humidity_pct;
  return {
    temperature_c: quantize2dp(toFiniteOrZero(reading.temperature_c)),
    humidity_pct: quantize2dp(toFiniteOrZero(humidity)),
    pressure_hpa: quantize2dp(toFiniteOrThrowIfPresent(reading.pressure_hpa, 'pressure_hpa')),
    wind_mps: quantize2dp(toFiniteOrZero(reading.wind_speed_ms)),
    rainfall_mm: quantize2dp(toFiniteOrZero(reading.precipitation_mm)),
  };
}

/**
 * Compute the commit id exactly as core4's `Transaction::compute_commit_id` does:
 *   SHA3-256( serde_json(data) || nonce || station_id || timestamp || contribution_type )
 * returned as lowercase hex.
 */
export function computeCommitId(args: {
  data: unknown;
  nonce: string;
  stationId: string;
  timestamp: number;
  contributionType?: string;
}): string {
  const { data, nonce, stationId, timestamp, contributionType = DEFAULT_CONTRIBUTION_TYPE } = args;
  const dataStr = JSON.stringify(canonicalizeJson(data));
  const preimage = `${dataStr}||${nonce}||${stationId}||${timestamp}||${contributionType}`;
  return sha3Hex(preimage);
}
