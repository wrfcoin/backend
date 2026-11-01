/**
 * A forecaster's own commit record, checked against the chain (forecast verification, backend PR#72 /
 * backend#1494; forecast duels, backend#228).
 *
 * The node does not list revealed forecast payloads (core4 docs/testnet/forecast-scorer-job.md, "No API
 * lists revealed forecasts"), so the backend cannot read a forecast's values from the chain. What it can
 * do is check a forecaster's own files against the chain, the same way the core4 scorer job does:
 *
 *   commit_id = sha3-256( data || "||" || nonce || "||" || station_id || "||" || timestamp || "||forecast" )
 *
 * (`Transaction::compute_commit_id`; `tools/forecast-kit/forecast_kit.py compute_commit_id`). `data` is the
 * exact canonical JSON text the kit wrote to data.json, so the check runs on the submitted text itself and
 * never re-serializes numbers (serde_json writes 12.0 where JavaScript would write 12). A record whose
 * hash matches is, byte for byte, what the forecaster committed; the node then says the commit exists, is a
 * forecast for that station and has been revealed. The forecast is public on chain once revealed, so taking
 * the record after the reveal leaks nothing and cannot be front-run.
 *
 * Nothing here signs, submits or pays. The record is evidence for a read-side score only; it never feeds
 * rewards (reward scoring is core4's job: forecast-score, owner rule "rmse_sigma + anti-gaming").
 */
import { createHash } from 'node:crypto';
import { stationAlias as stationAliasImpl } from '../utils/station-alias.js';

const stationAlias = stationAliasImpl as (stationId: string) => string;

/** The variables the forecast kit and the core4 scorer use (tools/forecast-kit VARIABLES). */
export const FORECAST_VARIABLES = ['temperature_c', 'pressure_hpa', 'humidity_pct'] as const;
export type ForecastVariable = typeof FORECAST_VARIABLES[number];

export const COMMIT_ID_RE = /^[0-9a-f]{64}$/;
const NONCE_RE = /^[\x21-\x7e]{1,128}$/;
const MAX_DATA_BYTES = 4096;
const MAX_HORIZON_HOURS = 240;

export interface ForecastRecordInput {
  commitId?: unknown;
  nonce?: unknown;
  timestamp?: unknown;
  data?: unknown;
}

export interface ForecastRecord {
  commitId: string;
  /** Raw station id: internal only. Public output names the station by `stationAlias`. */
  stationId: string;
  stationAlias: string;
  modelId: string | null;
  issuedAt: number;
  validAt: number;
  horizonHours: number | null;
  values: Partial<Record<ForecastVariable, number>>;
}

export type RecordCheck =
  | { ok: true; record: ForecastRecord }
  | { ok: false; code: string; message: string };

const invalid = (code: string, message: string): RecordCheck => ({ ok: false, code, message });

function safeSeconds(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return value;
  if (typeof value === 'string' && /^[1-9][0-9]{0,11}$/.test(value)) return Number(value);
  return null;
}

export function forecastCommitId(data: string, nonce: string, stationId: string, timestamp: number): string {
  return createHash('sha3-256').update(`${data}||${nonce}||${stationId}||${timestamp}||forecast`, 'utf8').digest('hex');
}

/**
 * Check a record's shape and its commit hash. No network: `checkForecastOnChain` is the chain half.
 * `data` must be the data.json text (one trailing newline is allowed and dropped).
 */
export function parseForecastRecord(input: ForecastRecordInput): RecordCheck {
  const commitId = typeof input.commitId === 'string' ? input.commitId.trim().toLowerCase() : '';
  if (!COMMIT_ID_RE.test(commitId)) return invalid('INVALID_COMMIT_ID', 'commitId must be 64 hex characters');
  if (typeof input.nonce !== 'string' || !NONCE_RE.test(input.nonce)) {
    return invalid('INVALID_NONCE', 'nonce must be 1-128 printable characters with no spaces');
  }
  const timestamp = safeSeconds(input.timestamp);
  if (timestamp === null) return invalid('INVALID_TIMESTAMP', 'timestamp must be the commit timestamp in unix seconds');
  if (typeof input.data !== 'string') return invalid('INVALID_DATA', 'data must be the text of data.json');
  const data = input.data.endsWith('\n') ? input.data.slice(0, -1) : input.data;
  if (data.length === 0 || Buffer.byteLength(data, 'utf8') > MAX_DATA_BYTES) {
    return invalid('INVALID_DATA', `data must be 1-${MAX_DATA_BYTES} bytes`);
  }
  let parsed: any;
  try { parsed = JSON.parse(data); } catch { return invalid('INVALID_DATA', 'data is not JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid('INVALID_DATA', 'data must be a JSON object');

  const stationId = parsed.station_id;
  if (typeof stationId !== 'string' || stationId.length === 0 || stationId.length > 128) {
    return invalid('INVALID_DATA', 'data.station_id is missing');
  }
  const issuedAt = safeSeconds(parsed.issued_at);
  const validAt = safeSeconds(parsed.valid_at);
  if (issuedAt === null || validAt === null || validAt <= issuedAt) {
    return invalid('INVALID_DATA', 'data.issued_at and data.valid_at must be unix seconds with valid_at after issued_at');
  }
  const horizon = parsed.horizon_hours;
  const horizonHours = typeof horizon === 'number' && Number.isInteger(horizon) && horizon > 0 && horizon <= MAX_HORIZON_HOURS ? horizon : null;
  const modelId = typeof parsed.model_id === 'string' && /^[\x20-\x7e]{1,64}$/.test(parsed.model_id) ? parsed.model_id : null;
  const values: Partial<Record<ForecastVariable, number>> = {};
  if (parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values)) {
    for (const variable of FORECAST_VARIABLES) {
      const v = parsed.values[variable];
      if (typeof v === 'number' && Number.isFinite(v)) values[variable] = v;
    }
  }
  if (Object.keys(values).length === 0) {
    return invalid('INVALID_DATA', `data.values must forecast at least one of ${FORECAST_VARIABLES.join(', ')}`);
  }

  if (forecastCommitId(data, input.nonce, stationId, timestamp) !== commitId) {
    return invalid('COMMIT_MISMATCH', 'data, nonce, station and timestamp do not hash to this commit id');
  }
  return { ok: true, record: { commitId, stationId, stationAlias: stationAlias(stationId), modelId, issuedAt, validAt, horizonHours, values } };
}

export type Core4Response = { ok: boolean; status: number; payload: any };
export type Core4Get = (path: string, query?: Record<string, unknown>) => Promise<Core4Response>;

export interface ChainCommitStatus {
  /** core4 status string (committed_pending_reveal, revealed_attested, reward_finalized, ...). */
  status: string | null;
  /** Revealed: anything past `committed_pending_reveal`. core4 prunes the reveal record (and its height)
   * once the reward decision is taken, so `revealedAtHeight` alone cannot answer this. */
  revealed: boolean;
  committedAtHeight: number | null;
  revealedAtHeight: number | null;
  rewardAmount: string | null;
  rewardFinalized: boolean;
  rewardStatus: string | null;
}

export type ChainCheck =
  | { ok: true; chain: ChainCommitStatus }
  | { ok: false; code: 'NOT_ON_CHAIN' | 'NOT_A_FORECAST' | 'STATION_MISMATCH' | 'NOT_REVEALED' | 'UPSTREAM'; message: string };

const safeHeight = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);

function unwrap(payload: any): Record<string, any> | null {
  const data = payload && typeof payload === 'object' && payload.ok === true && 'data' in payload ? payload.data : payload;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

/** core4 GET /transactions/commit/{commit_id}/status (bare struct; 404 when unknown). */
export async function readCommitStatus(get: Core4Get, commitId: string): Promise<{ kind: 'ok'; status: Record<string, any> } | { kind: 'not_found' } | { kind: 'upstream' }> {
  let reply: Core4Response;
  try { reply = await get(`/transactions/commit/${commitId}/status`); } catch { return { kind: 'upstream' }; }
  if (reply.status === 404) return { kind: 'not_found' };
  const status = reply.ok ? unwrap(reply.payload) : null;
  if (!status || status.commit_id !== commitId) return { kind: 'upstream' };
  return { kind: 'ok', status };
}

export function chainStatusFields(status: Record<string, any>): ChainCommitStatus {
  const amount = status.reward_amount;
  const statusText = typeof status.status === 'string' && /^[a-z_]{1,64}$/.test(status.status) ? status.status : null;
  return {
    status: statusText,
    revealed: statusText !== null && statusText !== 'committed_pending_reveal' && statusText !== 'not_found',
    committedAtHeight: safeHeight(status.committed_at),
    revealedAtHeight: safeHeight(status.revealed_at),
    rewardAmount: typeof amount === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(amount) ? amount
      : typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0 ? String(amount) : null,
    rewardFinalized: status.reward_finalized === true,
    rewardStatus: typeof status.reward_status === 'string' && /^[a-z_]{1,64}$/.test(status.reward_status) ? status.reward_status : null,
  };
}

/** The chain half: the commit exists, is a forecast for this station, and has been revealed. */
export async function checkForecastOnChain(get: Core4Get, record: ForecastRecord): Promise<ChainCheck> {
  const read = await readCommitStatus(get, record.commitId);
  if (read.kind === 'not_found') return { ok: false, code: 'NOT_ON_CHAIN', message: 'the node has no commit with this id' };
  if (read.kind === 'upstream') return { ok: false, code: 'UPSTREAM', message: 'the node could not be read' };
  const status = read.status;
  if (status.contribution_type !== 'forecast') return { ok: false, code: 'NOT_A_FORECAST', message: 'this commit is not a forecast' };
  if (status.station_id !== record.stationId) return { ok: false, code: 'STATION_MISMATCH', message: 'the chain commit names a different station' };
  const chain = chainStatusFields(status);
  if (!chain.revealed) {
    return { ok: false, code: 'NOT_REVEALED', message: 'reveal the forecast on chain first; a record is taken only after its reveal' };
  }
  return { ok: true, chain };
}
