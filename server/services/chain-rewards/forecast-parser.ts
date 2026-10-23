/**
 * Forecast track-record extraction (wrfcoin/core4#3604, A4), read from the same `/chain/block/{h}`
 * envelope the reward indexer already fetches. Unlike `parseRewardBlock` (money: fails closed), this
 * parser is TOLERANT: a record it cannot interpret is counted in `skipped` and the index keeps going,
 * so a statistics defect can never halt producer/attester receipt indexing. Readers surface `skipped`
 * as incomplete coverage.
 *
 * Source of truth: block metadata `reward_entries`, a JSON string of the chain's
 * `ContributionRewardRecord { address, amount, reason, station_id, provenance_class }` list; forecast
 * decisions carry `reason = "forecast:<commit_id>"`. The producer repeats a pending decision in every
 * block until it finalizes, so the same commit_id recurs across heights (the store keeps one row per
 * observation). `amount` is nominal until finalized and is never summed by readers.
 *
 * Block counters `forecast_rewards_decided_count` / `_total` (the chain assigns the MINTED figures to
 * these keys), `forecast_rewards_with_receipt_count` and `forecast_rewards_baseline_count` are copied
 * when present and well-formed.
 */
import { losslessJson, U128_MAX } from './parser.js';

export type ProvenanceClass = 'real' | 'synthetic' | 'unclassified';
export interface ForecastDecision {
  commitId: string;
  forecaster: string; // 0x + 40 lowercase hex
  stationId: string;
  amount: string; // decimal base units, nominal
  provenanceClass: ProvenanceClass;
  /** Present only when the node's block detail exposes the revealed receipt/manifest (not on core4 dd1801a3). */
  skillScore: number | null;
  rmse: number | null;
  mae: number | null;
  bias: number | null;
  horizonHours: number | null;
  variables: string[] | null;
}
export interface ForecastBlockStats {
  mintedCount: string | null;
  mintedTotal: string | null;
  withReceiptCount: string | null;
  baselineCount: string | null;
}
export interface ForecastBlock {
  decisions: ForecastDecision[];
  stats: ForecastBlockStats;
  /** reward_entries records (or counter values) the parser could not interpret. */
  skipped: number;
}

const PROVENANCE: ReadonlySet<string> = new Set(['real', 'synthetic', 'unclassified']);
const EMPTY_STATS: ForecastBlockStats = { mintedCount: null, mintedTotal: null, withReceiptCount: null, baselineCount: null };

/** `Address` derives serde over `[u8; 20]` (a 20-integer array); a `0x`-prefixed 40-hex string is accepted too. */
export function forecasterAddress(value: unknown): string | null {
  if (typeof value === 'string') {
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    return /^[0-9a-fA-F]{40}$/.test(hex) ? `0x${hex.toLowerCase()}` : null;
  }
  if (Array.isArray(value) && value.length === 20) {
    let hex = '';
    for (const byte of value) {
      const n = typeof byte === 'bigint' ? byte : typeof byte === 'number' && Number.isInteger(byte) ? BigInt(byte) : null;
      if (n === null || n < 0n || n > 255n) return null;
      hex += n.toString(16).padStart(2, '0');
    }
    return `0x${hex}`;
  }
  return null;
}

/** `Balance` is an unsigned 128-bit integer; losslessJson yields a bigint. A digit string is accepted too. */
function baseUnits(value: unknown): string | null {
  if (typeof value === 'bigint') return value >= 0n && value <= U128_MAX ? value.toString() : null;
  if (typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= U128_MAX) return value;
  return null;
}

function counter(value: unknown): string | null {
  return typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value) && BigInt(value) <= U128_MAX ? value : null;
}

function finite(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint' && value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return null;
}

/** Optional receipt/manifest fields; absent today, read when the node starts exposing them. */
function receiptFields(record: Record<string, unknown>): Pick<ForecastDecision, 'skillScore' | 'rmse' | 'mae' | 'bias' | 'horizonHours' | 'variables'> {
  const out = { skillScore: null as number | null, rmse: null as number | null, mae: null as number | null, bias: null as number | null, horizonHours: null as number | null, variables: null as string[] | null };
  const metrics = (record.verification_receipt as any)?.metrics ?? record.metrics;
  if (metrics && typeof metrics === 'object') {
    const skill = finite(metrics.skill_score);
    out.skillScore = skill !== null && skill >= 0 && skill <= 1 ? skill : null;
    out.rmse = finite(metrics.rmse); out.mae = finite(metrics.mae); out.bias = finite(metrics.bias);
  }
  const manifest = record.manifest;
  if (manifest && typeof manifest === 'object') {
    const horizon = finite((manifest as any).horizon_hours);
    out.horizonHours = horizon !== null && horizon >= 0 && Number.isInteger(horizon) ? horizon : null;
    const vars = (manifest as any).output_variables;
    out.variables = Array.isArray(vars) && vars.every((v: unknown) => typeof v === 'string') ? [...vars] : null;
  }
  return out;
}

function decisionFrom(record: unknown): ForecastDecision | 'not-forecast' | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const r = record as Record<string, unknown>;
  if (typeof r.reason !== 'string') return null;
  if (!r.reason.startsWith('forecast:')) return 'not-forecast';
  const commitId = r.reason.slice('forecast:'.length);
  if (commitId.length === 0 || commitId.length > 256) return null;
  const forecaster = forecasterAddress(r.address);
  const amount = baseUnits(r.amount);
  if (!forecaster || amount === null || typeof r.station_id !== 'string' || typeof r.provenance_class !== 'string' || !PROVENANCE.has(r.provenance_class)) return null;
  return { commitId, forecaster, stationId: r.station_id, amount, provenanceClass: r.provenance_class as ProvenanceClass, ...receiptFields(r) };
}

export function parseForecastBlock(raw: string, expectedHeight: number): ForecastBlock {
  const out: ForecastBlock = { decisions: [], stats: { ...EMPTY_STATS }, skipped: 0 };
  let metadata: any;
  try {
    const b = losslessJson(raw)?.data;
    if (!b || typeof b !== 'object' || b.height !== BigInt(expectedHeight)) return { ...out, skipped: 1 };
    metadata = b.metadata;
  } catch { return { ...out, skipped: 1 }; }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return out;

  for (const [key, field] of [['forecast_rewards_decided_count', 'mintedCount'], ['forecast_rewards_decided_total', 'mintedTotal'],
    ['forecast_rewards_with_receipt_count', 'withReceiptCount'], ['forecast_rewards_baseline_count', 'baselineCount']] as const) {
    if (!(key in metadata)) continue;
    const value = counter(metadata[key]);
    if (value === null) out.skipped++; else out.stats[field] = value;
  }

  if (!('reward_entries' in metadata)) return out;
  if (typeof metadata.reward_entries !== 'string') return { ...out, skipped: out.skipped + 1 };
  let entries: unknown;
  try { entries = losslessJson(metadata.reward_entries); } catch { return { ...out, skipped: out.skipped + 1 }; }
  if (!Array.isArray(entries)) return { ...out, skipped: out.skipped + 1 };
  const seen = new Set<string>();
  for (const entry of entries) {
    const decision = decisionFrom(entry);
    if (decision === 'not-forecast') continue;
    if (decision === null) { out.skipped++; continue; }
    if (seen.has(decision.commitId)) continue; // one observation per block per commit
    seen.add(decision.commitId);
    out.decisions.push(decision);
  }
  return out;
}
