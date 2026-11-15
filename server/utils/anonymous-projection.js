/**
 * Anonymous-read projections (backend#1222).
 *
 * Public, unauthenticated reads must not hand out exact station/device
 * locations or per-address reward amounts. These helpers are applied
 * server-side before serialization: rounding in the client is not a boundary.
 */

// 0.1 degree is ~11 km of latitude: a region, not a neighbourhood. Owner
// ruling 2026-10-01 (0.1 degree everywhere public, matching mobile collect and
// log-coordinates.js): no anonymous response carries a finer position.
const ANONYMOUS_COORDINATE_DECIMALS = 1;

function coarsenCoordinate(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const factor = 10 ** ANONYMOUS_COORDINATE_DECIMALS;
  return Math.round(numeric * factor) / factor;
}

// Owner-entered station names (backend#1397): a station projection sent to an
// anonymous caller carries the name with coordinate-like numbers at one
// decimal. Applied by the station projections only, never to third-party text.
// One complete numeric-token grammar (backend#1397 / frontend#436 review):
// every maximal decimal token, with optional sign, empty fraction ("1."),
// leading dot (".5") and exponent ("1.e-3", "+.5e1"). No form is special-cased,
// so no spelling of a number slips past. Byte-identical to the frontend rule;
// the shared vector table (contract-fixtures/station-name-public-vectors.json)
// pins both.
const NUMBER_TOKEN = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/**
 * A name with every number token that parses to a finite value with
 * |value| ≤ 180 and is not already exactly at one decimal replaced by its
 * one-decimal form, e.g. "Hilltop 10.123456,-21" → "Hilltop 10.1,-21".
 * Integers and one-decimal values stay byte-identical ("Station 42", "v2").
 * A non-coordinate such as "Unit 12.345" is coarsened too: an accepted cost
 * that fails safe.
 */
function coarsenCoordinatesInName(name) {
  if (typeof name !== 'string') return name;
  return name.replace(NUMBER_TOKEN, (token) => {
    const value = Number(token);
    if (!Number.isFinite(value) || Math.abs(value) > 180) return token;
    // The frontend's exact expression, so both sides produce the same text.
    const oneDecimal = Math.round(value * 10) / 10;
    return oneDecimal === value ? token : String(oneDecimal);
  });
}

function toIntegerAmount(amount) {
  if (typeof amount === 'number' && Number.isSafeInteger(amount) && amount >= 0) {
    return BigInt(amount);
  }
  if (typeof amount === 'string' && /^\d+$/.test(amount)) {
    return BigInt(amount);
  }
  return null;
}

/**
 * core4 block metadata carries `reward_entries` — a JSON-encoded list of
 * {address, amount, reason, station_id, ...}. Anonymous callers get an
 * aggregate ({count, total_amount}) instead of the per-address list.
 * `total_amount` is null when any amount is not a plain integer.
 */
function redactRewardEntriesMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return metadata;
  }
  if (!Object.prototype.hasOwnProperty.call(metadata, 'reward_entries')) {
    return metadata;
  }

  const { reward_entries: raw, ...rest } = metadata;
  let entries = raw;
  if (typeof raw === 'string') {
    try {
      entries = JSON.parse(raw);
    } catch {
      entries = null;
    }
  }

  let summary = { count: null, total_amount: null };
  if (Array.isArray(entries)) {
    let total = 0n;
    let summable = true;
    for (const entry of entries) {
      const amount = toIntegerAmount(entry && entry.amount);
      if (amount === null) {
        summable = false;
        break;
      }
      total += amount;
    }
    summary = { count: entries.length, total_amount: summable ? total.toString() : null };
  }

  return { ...rest, reward_entries_summary: summary };
}

/**
 * Anonymous projection of core4 block `metadata` (block-page review 2026-11-08): an ALLOWLIST.
 *
 * The earlier projection removed only `reward_entries` and passed every other key through, so
 * keys core4 added later went out raw: `producer_settlement` (payout address + per-block amount),
 * `attester_settlements` (per-attester amounts) and `low_quality_streak_entries` (owner addresses
 * on a low-quality streak). Now:
 *
 *  - Block-level scalars (counts, totals, flags, reward-policy config, genesis chain config) pass
 *    only by EXACT key name, and only as a boolean, a finite number or a short string that is
 *    not JSON-like. A new core4 key is dropped until someone reviews it and adds it here.
 *  - Per-identity lists become aggregates:
 *      reward_entries             -> reward_entries_summary {count, total_amount}
 *      attester_settlements       -> attester_settlements_summary {count, total_amount} (allocations)
 *      low_quality_streak_entries -> low_quality_streak_summary {count}
 *      producer_settlement        -> producer_settlement {amount, height} (no payout address)
 *  - Commit-id lists (quality challenges, late quorums) are dropped; their *_count scalars stay.
 *
 * `total_amount` is null when any amount is not a plain non-negative integer; `count` is null when
 * the value cannot be read. Operators (see hasOperatorToken) get the raw metadata.
 */
const ANONYMOUS_BLOCK_METADATA_SCALARS = new Set([
  // per-block reward and settlement aggregates
  'attester_settlement_commit_count', 'attester_settlement_decision_count', 'attester_settlement_minted_total',
  'faucet_rewards_minted_total',
  'forecast_rewards_baseline_count', 'forecast_rewards_decided_count', 'forecast_rewards_decided_total',
  'forecast_rewards_minted_count', 'forecast_rewards_minted_total', 'forecast_rewards_with_receipt_count',
  'oracle_reward_late_quorum_count', 'oracle_reward_missing_quorum_count', 'oracle_reward_quorum_commit_count',
  'oracle_reward_required_quorum', 'oracle_reward_revealed_commit_count',
  'pop_deferred_real_contribution_reveals', 'pop_skipped_mempool_transactions', 'pop_useful_work_activation_height',
  'publishing_score',
  'quality_challenge_count', 'quality_enforcement_active', 'quality_event_records_emitted_count',
  'quality_slashing_applied_count', 'quality_slashing_applied_total',
  'reward_analyzer', 'reward_collector', 'reward_keeper', 'reward_offsetter', 'reward_total',
  'rewards_budget_limited', 'rewards_budget_pool',
  'rewards_decided_count', 'rewards_decided_total', 'rewards_minted_count', 'rewards_minted_total', 'rewards_nominal_total',
  'rewards_provenance_real_decision_count', 'rewards_provenance_real_minted_total',
  'rewards_provenance_synthetic_decision_count', 'rewards_provenance_synthetic_minted_total',
  'rewards_provenance_unclassified_decision_count', 'rewards_provenance_unclassified_minted_total',
  'rewards_quality_borderline_count', 'rewards_quality_high_count', 'rewards_quality_warning_count',
  'rewards_skipped_low_quality_count',
  'rewards_trust_trusted_provider_count', 'rewards_trust_unverified_count', 'rewards_trust_verified_station_count',
  'role_analyzer_count', 'role_collector_count', 'role_keeper_count', 'role_offsetter_count',
  'task_assigner_enabled', 'multidomain_schema_version_min',
  'useful_work_forecast_reveals', 'useful_work_liveness_fallback', 'useful_work_quality_contributions',
  // reward-policy config (weights and thresholds, the same for every station)
  'rewards_quality_multipliers', 'rewards_quality_thresholds', 'rewards_trust_weights',
  // genesis chain config (public by design)
  'chain_id', 'network_id', 'protocol_version', 'faucet_address', 'oracle_quorum', 'oracle_set',
  'protocol_activation_schedule', 'schedule_governance_keys',
  'node_share_challenge_blocks', 'node_share_epoch_blocks',
  'testnet_faucet_allocation_base_units', 'testnet_flat_reward_base_units', 'testnet_flat_reward_seconds',
]);
const MAX_SCALAR_LENGTH = 512;

function parseJsonValue(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function amountSummary(items, amountOf) {
  if (!Array.isArray(items)) return { count: null, total_amount: null };
  let total = 0n;
  let summable = true;
  for (const item of items) {
    const amount = toIntegerAmount(amountOf(item));
    if (amount === null) {
      summable = false;
      break;
    }
    total += amount;
  }
  return { count: items.length, total_amount: summable ? total.toString() : null };
}

function scalarOrUndefined(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (value.length > MAX_SCALAR_LENGTH) return undefined;
    // A JSON object or array hiding in a string is a structure, not a scalar.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) return undefined;
    return value;
  }
  return undefined;
}

function projectAnonymousBlockMetadata(metadata) {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const out = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!ANONYMOUS_BLOCK_METADATA_SCALARS.has(key)) continue;
    const scalar = scalarOrUndefined(value);
    if (scalar !== undefined) out[key] = scalar;
  }
  const has = (key) => Object.prototype.hasOwnProperty.call(metadata, key);
  if (has('reward_entries')) {
    out.reward_entries_summary = amountSummary(parseJsonValue(metadata.reward_entries), (e) => e && e.amount);
  }
  if (has('attester_settlements')) {
    const settlements = parseJsonValue(metadata.attester_settlements);
    const allocations = Array.isArray(settlements)
      ? settlements.flatMap((s) => (s && Array.isArray(s.allocations) ? s.allocations : [null]))
      : null;
    out.attester_settlements_summary = amountSummary(allocations, (a) => a && a.amount);
  }
  if (has('low_quality_streak_entries')) {
    const entries = parseJsonValue(metadata.low_quality_streak_entries);
    out.low_quality_streak_summary = { count: Array.isArray(entries) ? entries.length : null };
  }
  if (has('producer_settlement')) {
    const settlement = parseJsonValue(metadata.producer_settlement);
    const ok = settlement && typeof settlement === 'object' && !Array.isArray(settlement);
    const amount = ok ? toIntegerAmount(settlement.amount) : null;
    const height = ok && Number.isSafeInteger(settlement.height) && settlement.height >= 0 ? settlement.height : null;
    out.producer_settlement = { amount: amount === null ? null : amount.toString(), height };
  }
  return out;
}

const TX_TYPE_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const HEX64_RE = /^(0x)?[0-9a-fA-F]{64}$/;
const ORACLE_ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

/**
 * Anonymous projection of core4's /chain/block/<h> `transactions` (backend#1265): an
 * explicit allowlist, never a pass-through. Each entry keeps only its type and, for the
 * proof-relevant variants, the commit id, a validated oracle id and the approval flag.
 * The sender address, raw station ids, nonces and every unknown key are dropped, and
 * unexpected shapes yield a bare {type: null} entry so the count still lines up.
 * Operators (see hasOperatorToken) get the raw list.
 */
function projectAnonymousBlockTransactions(transactions) {
  if (!Array.isArray(transactions)) {
    return [];
  }
  return transactions.map((tx) => {
    const source = tx && typeof tx === 'object' && !Array.isArray(tx) ? tx : {};
    const entry = { type: typeof source.type === 'string' && TX_TYPE_RE.test(source.type) ? source.type : null };
    const payload = source.payload && typeof source.payload === 'object' && !Array.isArray(source.payload)
      ? source.payload
      : null;
    if (payload) {
      const projected = {};
      if (typeof payload.commit_id === 'string' && HEX64_RE.test(payload.commit_id)) {
        projected.commit_id = payload.commit_id;
      }
      if (typeof payload.oracle_id === 'string' && ORACLE_ID_RE.test(payload.oracle_id)) {
        projected.oracle_id = payload.oracle_id;
      }
      if (typeof payload.approved === 'boolean') {
        projected.approved = payload.approved;
      }
      entry.payload = projected;
    }
    if (source.payload_error === 'undecodable_canonical_payload') {
      entry.payload_error = source.payload_error;
    }
    return entry;
  });
}

module.exports = {
  ANONYMOUS_BLOCK_METADATA_SCALARS,
  projectAnonymousBlockMetadata,
  projectAnonymousBlockTransactions,
  ANONYMOUS_COORDINATE_DECIMALS,
  coarsenCoordinate,
  coarsenCoordinatesInName,
  redactRewardEntriesMetadata,
};
