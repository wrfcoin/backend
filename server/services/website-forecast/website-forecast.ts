/**
 * Make a forecast from the website (epic 7; design docs/plans/2026-11-05-website-forecast-design.md,
 * owner-approved 2026-11-07).
 *
 * A person with a 12-word wallet picks a registered station, one variable and a lead (1, 6, 12 or 24 h).
 * The backend writes the canonical forecast `data` and a random nonce (the draft); the browser checks the
 * draft, hashes it to the commit id itself and signs the commit with the wallet's ed25519 key. The backend
 * then relays the commit, keeps the reveal package (data, nonce, timestamp, manifest) and reveals in the next
 * block, so closing the tab loses nothing. The values are public on chain minutes later anyway, so holding
 * them here hides nothing worth hiding.
 *
 * Rules the owner approved: 12-word wallets only (a passkey cannot sign a forecast commit); one forecast
 * per wallet, station, lead and UTC day (the FIRST one counts: a second is refused, so it can never replace
 * the first); a forecast is scored as the wallet's first, not its best.
 *
 * Stored per forecast: wallet address, station, values, commit id and chain progress. No IP, no email.
 */
import { createHash, randomBytes } from 'node:crypto';
import { forecastCommitId, parseForecastRecord, type ForecastRecord } from '../forecast-commit-record.js';
import { stationAlias as stationAliasImpl } from '../../utils/station-alias.js';
import type { ForecastManifest } from './node-forecast-client.js';

const stationAlias = stationAliasImpl as (stationId: string) => string;

export const websiteForecastEnabled = () => process.env.WEBSITE_FORECAST_ENABLED === 'true';

/**
 * Stations open for website forecasts: WEBSITE_FORECAST_STATIONS, a comma-separated list of station ids or their
 * public aliases (st_ + 12 hex). Empty or unset means NO station is open (fail closed). Above h3000 the chain credits
 * a forecast to the station's registered owner, so a station is opened only with its owner's agreement.
 * Read per request, like the switch, so a change needs only a restart of the env, not a new image.
 */
export function websiteForecastStations(raw: string | undefined = process.env.WEBSITE_FORECAST_STATIONS): Set<string> {
  return new Set((raw ?? '').split(',').map((s) => s.trim()).filter(Boolean));
}

/** Whether website forecasts may target this station (by raw id or by its public alias). */
export function stationOpenForWebsite(stationId: string, open: Set<string> = websiteForecastStations()): boolean {
  return open.has(stationId) || open.has(stationAlias(stationId));
}

/** The public aliases of the open stations (never raw ids), for the status read. */
export function openStationAliases(open: Set<string> = websiteForecastStations()): string[] {
  return [...new Set([...open].map((s) => (ALIAS_RE.test(s) ? s : stationAlias(s))))].sort();
}

export const WEB_MODEL_ID = 'website-manual/v1';
export const LEAD_HOURS = [1, 6, 12, 24] as const;
export type LeadHours = typeof LEAD_HOURS[number];
export const WEB_VARIABLES = ['temperature_c', 'pressure_hpa'] as const;
export type WebVariable = typeof WEB_VARIABLES[number];
/** Plausible station values; a value outside is a typo, not a forecast. Pressure is station pressure. */
export const VALUE_RANGES: Record<WebVariable, [number, number]> = {
  temperature_c: [-60, 60],
  pressure_hpa: [500, 1100],
};
/** A draft must be signed and handed back within this many seconds of being written. */
export const DRAFT_MAX_AGE_S = 15 * 60;
const FUTURE_SKEW_S = 60;

export const ADDRESS_RE = /^0x[0-9a-f]{40}$/;
const PUBKEY_RE = /^[0-9a-f]{64}$/;
const SIGNATURE_RE = /^[0-9a-f]{128}$/;
const ALIAS_RE = /^st_[0-9a-f]{12}$/;

export type Fail = { ok: false; status: number; code: string; message: string };
const fail = (status: number, code: string, message: string): Fail => ({ ok: false, status, code, message });

/**
 * `serde_json::to_string(&serde_json::Value)`: compact, object keys sorted (BTreeMap). The node rebuilds
 * the commit id from the reveal payload with exactly this, so `data` must already be in this form.
 * Numbers: only finite values in the ranges above, rounded to 0.1, and integers; for those JavaScript's
 * shortest form equals serde_json's (ryu), and `12.0` is written `12` on both sides once parsed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite number');
    if (!Number.isSafeInteger(value) && (Math.abs(value) < 1e-6 || Math.abs(value) >= 1e15)) throw new Error('number out of canonical range');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error('unsupported JSON value');
}

const sha3 = (text: string) => createHash('sha3-256').update(text, 'utf8').digest('hex');

/** core4 `Address::from_public_key`: first 20 bytes of sha3-256 of the raw ed25519 key (frontend firstPartyKeys). */
export function addressFromPublicKey(pubkeyHex: string): string {
  return `0x${createHash('sha3-256').update(Buffer.from(pubkeyHex, 'hex')).digest('hex').slice(0, 40)}`;
}

export const roundValue = (v: number) => Math.round(v * 10) / 10;
export const utcDay = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);

export function buildForecastData(input: { stationId: string; variable: WebVariable; value: number; leadHours: LeadHours; issuedAt: number }) {
  const data = {
    horizon_hours: input.leadHours,
    issued_at: input.issuedAt,
    model_id: WEB_MODEL_ID,
    station_id: input.stationId,
    valid_at: input.issuedAt + input.leadHours * 3600,
    values: { [input.variable]: roundValue(input.value) },
  };
  return canonicalJson(data);
}

/**
 * The manifest the reveal carries (`ForecastArtifactManifest`, field order = declaration order, which its
 * digest depends on). A website forecast is typed by a person: there are no machine inputs, so input_hash
 * is the hash of an empty input list, as a fixed marker.
 */
export function buildManifest(record: { data: string; stationId: string; issuedAt: number; horizonHours: number; variable: string }): ForecastManifest {
  return {
    schema_version: 1,
    model_id: WEB_MODEL_ID,
    input_hash: sha3('[]'),
    output_hash: sha3(record.data),
    produced_at: record.issuedAt,
    region: record.stationId,
    horizon_hours: record.horizonHours,
    input_variables: [record.variable],
    output_variables: [record.variable],
  };
}

export interface DraftInput { stationAlias?: unknown; variable?: unknown; leadHours?: unknown; value?: unknown }
export interface ParsedDraftInput { stationAlias: string; variable: WebVariable; leadHours: LeadHours; value: number }

export function parseDraftInput(body: DraftInput): { ok: true; value: ParsedDraftInput } | Fail {
  if (typeof body.stationAlias !== 'string' || !ALIAS_RE.test(body.stationAlias)) {
    return fail(400, 'VALIDATION_ERROR', 'stationAlias must be a station alias like st_0123456789ab');
  }
  if (!WEB_VARIABLES.includes(body.variable as WebVariable)) {
    return fail(400, 'VALIDATION_ERROR', `variable must be one of ${WEB_VARIABLES.join(', ')}`);
  }
  const lead = Number(body.leadHours);
  if (!LEAD_HOURS.includes(lead as LeadHours)) return fail(400, 'VALIDATION_ERROR', `leadHours must be one of ${LEAD_HOURS.join(', ')}`);
  const variable = body.variable as WebVariable;
  const value = typeof body.value === 'number' ? body.value : typeof body.value === 'string' && body.value.trim() !== '' ? Number(body.value) : NaN;
  const [lo, hi] = VALUE_RANGES[variable];
  if (!Number.isFinite(value) || value < lo || value > hi) {
    return fail(400, 'VALIDATION_ERROR', `value must be a number from ${lo} to ${hi}`);
  }
  return { ok: true, value: { stationAlias: body.stationAlias, variable, leadHours: lead as LeadHours, value: roundValue(value) } };
}

export interface Draft {
  forecaster: string;
  stationAlias: string;
  stationId: string;
  variable: WebVariable;
  leadHours: LeadHours;
  value: number;
  data: string;
  nonce: string;
  timestamp: number;
  commitId: string;
  issuedAt: number;
  validAt: number;
}

/** Write the draft the browser checks and signs. `stationId` is the resolved, registered station. */
export function makeDraft(input: ParsedDraftInput & { forecaster: string; stationId: string; nowSec: number; nonce?: string }): Draft {
  const issuedAt = input.nowSec;
  const data = buildForecastData({ stationId: input.stationId, variable: input.variable, value: input.value, leadHours: input.leadHours, issuedAt });
  const nonce = input.nonce ?? `web-${randomBytes(16).toString('hex')}`;
  return {
    forecaster: input.forecaster,
    stationAlias: input.stationAlias,
    stationId: input.stationId,
    variable: input.variable,
    leadHours: input.leadHours,
    value: roundValue(input.value),
    data,
    nonce,
    timestamp: issuedAt,
    commitId: forecastCommitId(data, nonce, input.stationId, issuedAt),
    issuedAt,
    validAt: issuedAt + input.leadHours * 3600,
  };
}

export interface SubmitInput {
  data?: unknown; nonce?: unknown; timestamp?: unknown; commitId?: unknown; authPubkey?: unknown; authSignature?: unknown;
}

export interface CheckedSubmission {
  record: ForecastRecord;
  data: string;
  nonce: string;
  timestamp: number;
  variable: WebVariable;
  value: number;
  leadHours: LeadHours;
  forecaster: string;
  authPubkey: string;
  authSignature: string;
  manifest: ForecastManifest;
  forecastDay: string;
}

/**
 * Everything the backend can check before relaying a signed commit: the commit id re-derives from the
 * data, the data is a website forecast in canonical form and fresh, and the signing key's address is the
 * logged-in wallet (`forecaster == address(auth_pubkey)`, the key-bound rule the node applies too). The
 * signature itself is checked by the node against its own chain binding.
 */
export function checkSubmission(body: SubmitInput, walletAddress: string, nowSec: number): { ok: true; value: CheckedSubmission } | Fail {
  const forecaster = typeof walletAddress === 'string' ? walletAddress.toLowerCase() : '';
  if (!ADDRESS_RE.test(forecaster)) return fail(401, 'WALLET_REQUIRED', 'Log in with a 12-word wallet to make a forecast.');
  const authPubkey = typeof body.authPubkey === 'string' ? body.authPubkey.toLowerCase() : '';
  const authSignature = typeof body.authSignature === 'string' ? body.authSignature.toLowerCase() : '';
  if (!PUBKEY_RE.test(authPubkey)) return fail(400, 'VALIDATION_ERROR', 'authPubkey must be a 32-byte ed25519 key in hex');
  if (!SIGNATURE_RE.test(authSignature)) return fail(400, 'VALIDATION_ERROR', 'authSignature must be a 64-byte ed25519 signature in hex');
  if (addressFromPublicKey(authPubkey) !== forecaster) {
    return fail(403, 'FORECASTER_MISMATCH', 'The signing key does not belong to the logged-in wallet.');
  }
  if (typeof body.data !== 'string' || body.data.endsWith('\n')) return fail(400, 'INVALID_DATA', 'data must be the draft text, unchanged');
  const parsed = parseForecastRecord({ commitId: body.commitId, nonce: body.nonce, timestamp: body.timestamp, data: body.data });
  if (parsed.ok === false) return fail(400, parsed.code, parsed.message);
  const record = parsed.record;
  const data = body.data;
  let object: any;
  try { object = JSON.parse(data); } catch { return fail(400, 'INVALID_DATA', 'data is not JSON'); }
  let canonical: string | null = null;
  try { canonical = canonicalJson(object); } catch { canonical = null; }
  if (canonical !== data) return fail(400, 'INVALID_DATA', 'data must be canonical JSON (sorted keys, compact)');
  const keys = Object.keys(object).sort().join(',');
  if (keys !== 'horizon_hours,issued_at,model_id,station_id,valid_at,values') return fail(400, 'INVALID_DATA', 'data has unexpected fields');
  if (record.modelId !== WEB_MODEL_ID) return fail(400, 'INVALID_DATA', `data.model_id must be ${WEB_MODEL_ID}`);
  const leadHours = record.horizonHours as LeadHours;
  if (!LEAD_HOURS.includes(leadHours)) return fail(400, 'INVALID_DATA', `data.horizon_hours must be one of ${LEAD_HOURS.join(', ')}`);
  if (record.validAt !== record.issuedAt + leadHours * 3600) return fail(400, 'INVALID_DATA', 'data.valid_at must be issued_at plus the lead');
  const timestamp = Number(body.timestamp);
  if (timestamp !== record.issuedAt) return fail(400, 'INVALID_DATA', 'timestamp must equal data.issued_at');
  if (record.issuedAt > nowSec + FUTURE_SKEW_S || record.issuedAt < nowSec - DRAFT_MAX_AGE_S) {
    return fail(409, 'DRAFT_EXPIRED', 'This draft is too old. Start the forecast again.');
  }
  const valueKeys = Object.keys(object.values ?? {});
  if (valueKeys.length !== 1 || !WEB_VARIABLES.includes(valueKeys[0] as WebVariable)) {
    return fail(400, 'INVALID_DATA', 'data.values must hold exactly one of temperature_c, pressure_hpa');
  }
  const variable = valueKeys[0] as WebVariable;
  const value = object.values[variable];
  const [lo, hi] = VALUE_RANGES[variable];
  if (typeof value !== 'number' || value < lo || value > hi || roundValue(value) !== value) {
    return fail(400, 'INVALID_DATA', `the forecast value must be ${lo} to ${hi}, to one decimal`);
  }
  return {
    ok: true,
    value: {
      record, data, nonce: body.nonce as string, timestamp, variable, value, leadHours, forecaster, authPubkey, authSignature,
      manifest: buildManifest({ data, stationId: record.stationId, issuedAt: record.issuedAt, horizonHours: leadHours, variable }),
      forecastDay: utcDay(record.issuedAt),
    },
  };
}

export { stationAlias };
