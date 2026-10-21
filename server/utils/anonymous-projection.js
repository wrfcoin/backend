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
  projectAnonymousBlockTransactions,
  ANONYMOUS_COORDINATE_DECIMALS,
  coarsenCoordinate,
  coarsenCoordinatesInName,
  redactRewardEntriesMetadata,
};
