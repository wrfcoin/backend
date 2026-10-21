/**
 * #932 weather-submit authentication: staged migration from detect-and-warn to
 * enforcement.
 *
 * The blocker this closes: "no safe fail-closed seam exists without a station
 * credential contract." The contract is the per-station submit token
 * (drizzle/manual/932-station-submit-tokens.sql): plaintext lives only in the
 * collector's env; the DB stores sha256(token) in weather_stations.submit_token_hash.
 *
 * Stages, selected by WEATHER_SUBMIT_AUTH_MODE:
 *   'off'      (default) — #948 behavior: accept and WARN on anonymous submits.
 *              The default stays 'off' because the hard constraint on #932 is
 *              "without breaking live station collectors"; flipping to enforce
 *              is a deliberate owner act AFTER every live collector carries a
 *              token. A silent 'off' is itself a hazard, so the enforcement
 *              wiring logs the active mode — 'off' must be visible.
 *   'enforce'  — a submit must present, via `Authorization: Bearer …`, either
 *              this station's submit token (hash match) or the platform
 *              contributor token (the N5 collector bridge). Anything else is
 *              rejected; there is NO anonymous fallback.
 *
 * An unrecognised mode value does NOT silently mean 'off': it resolves to
 * 'off' with `invalid` set, and the route logs an error on every request until
 * the manifest is fixed — a typo must be loud.
 */

import { createHash, timingSafeEqual } from 'crypto';

export type WeatherSubmitAuthMode = 'off' | 'enforce';

export interface ResolvedAuthMode {
  mode: WeatherSubmitAuthMode;
  /** Set when the env value was unrecognised (typo) — log this loudly. */
  invalid?: string;
}

export function resolveWeatherSubmitAuthMode(raw: string | undefined): ResolvedAuthMode {
  const value = (raw ?? '').trim().toLowerCase();
  if (value === '' || value === 'off') return { mode: 'off' };
  if (value === 'enforce') return { mode: 'enforce' };
  return { mode: 'off', invalid: value };
}

/** Detect-and-warn helper from #948, unchanged. */
export function shouldWarnAboutUnauthenticatedWeatherSubmit(
  authorization: string | string[] | undefined,
): boolean {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  return !value?.trim();
}

export interface SubmitAuthInput {
  mode: WeatherSubmitAuthMode;
  authorization: string | string[] | undefined;
  /** sha256 hex of this station's submit token, or null when none provisioned. */
  stationTokenHash: string | null;
  /** WRFCOIN_CONTRIBUTOR_TOKEN — the platform-collector bridge credential. */
  contributorToken: string | undefined;
}

export type SubmitAuthDecision =
  | { action: 'allow'; via: 'mode-off' | 'station-token' | 'contributor-token' }
  | { action: 'warn'; via: 'mode-off-anonymous' }
  | { action: 'reject'; reason: string };

function constantTimeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'utf8');
  const b = Buffer.from(bHex, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Pure authorization decision for POST /api/weather/submit. No I/O: the caller
 * looks up the station hash and passes it in, so this is exhaustively testable
 * and cannot false-green on DB reachability.
 */
export function evaluateWeatherSubmitAuth(input: SubmitAuthInput): SubmitAuthDecision {
  const raw = Array.isArray(input.authorization) ? input.authorization[0] : input.authorization;
  const header = (raw ?? '').trim();

  if (input.mode === 'off') {
    if (!header) return { action: 'warn', via: 'mode-off-anonymous' };
    return { action: 'allow', via: 'mode-off' };
  }

  // --- enforce ---
  if (!header.toLowerCase().startsWith('bearer ')) {
    return { action: 'reject', reason: 'missing_bearer' };
  }
  const presented = header.slice(7).trim();
  if (!presented) {
    return { action: 'reject', reason: 'empty_bearer' };
  }

  if (input.stationTokenHash && constantTimeEqualHex(sha256Hex(presented), input.stationTokenHash)) {
    return { action: 'allow', via: 'station-token' };
  }

  const contributor = (input.contributorToken ?? '').trim();
  if (contributor && constantTimeEqualHex(sha256Hex(presented), sha256Hex(contributor))) {
    return { action: 'allow', via: 'contributor-token' };
  }

  return {
    action: 'reject',
    reason: input.stationTokenHash ? 'token_mismatch' : 'station_has_no_token',
  };
}

/**
 * #932 route gate — the whole decision the submit route makes, in one testable
 * unit.
 *
 * Extracted because the route lives inside a 1,400-line `handleRequest` in an
 * entrypoint that exports only its server, so no test can drive it. Review
 * (Alice, Opus 5) proved that cost concretely: deleting the route's entire
 * reject block left the full 2,645-test gate byte-identical. The decision
 * function was exhaustively tested; the *call* was bound by nothing.
 *
 * Everything the route used to decide inline now happens here — mode
 * resolution, the credential lookup, fail-closed on an unreadable store, and
 * the final verdict — so all of it is reachable from a test. The route keeps
 * only logging and the response call, and a source contract pins that it still
 * calls this and still returns on `reject`.
 */
export interface SubmitGateOutcome {
  action: 'allow' | 'warn' | 'reject';
  /** HTTP status the route must send. Absent when the request proceeds. */
  status?: number;
  code?: string;
  reason?: string;
  /** Resolved mode, for the route's log line. */
  mode: WeatherSubmitAuthMode;
  /** Set when WEATHER_SUBMIT_AUTH_MODE was unrecognised — log loudly. */
  invalidMode?: string;
  via?: string;
}

export async function resolveWeatherSubmitGate(args: {
  rawMode: string | undefined;
  authorization: string | string[] | undefined;
  stationId: string | null;
  contributorToken: string | undefined;
  /** Returns the station's stored sha256 hash, or null when none is provisioned. */
  lookupStationTokenHash: (stationId: string) => Promise<string | null>;
}): Promise<SubmitGateOutcome> {
  const resolved = resolveWeatherSubmitAuthMode(args.rawMode);

  let stationTokenHash: string | null = null;
  if (resolved.mode === 'enforce' && args.stationId) {
    try {
      stationTokenHash = await args.lookupStationTokenHash(args.stationId);
    } catch {
      // Fail CLOSED: an unreadable credential store is indistinguishable from
      // a station with no credential, and only one of those answers is safe.
      return {
        action: 'reject',
        status: 503,
        code: 'WEATHER_SUBMIT_AUTH_UNAVAILABLE',
        reason: 'credential_lookup_failed',
        mode: resolved.mode,
        invalidMode: resolved.invalid,
      };
    }
  }

  const decision = evaluateWeatherSubmitAuth({
    mode: resolved.mode,
    authorization: args.authorization,
    stationTokenHash,
    contributorToken: args.contributorToken,
  });

  if (decision.action === 'reject') {
    return {
      action: 'reject',
      status: 401,
      code: 'WEATHER_SUBMIT_AUTH_REQUIRED',
      reason: decision.reason,
      mode: resolved.mode,
      invalidMode: resolved.invalid,
    };
  }
  return {
    action: decision.action,
    mode: resolved.mode,
    invalidMode: resolved.invalid,
    via: decision.action === 'allow' ? decision.via : undefined,
  };
}
