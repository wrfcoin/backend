import { createHash } from 'node:crypto';

export const PARSER_VERSION = 1;
export const U128_MAX = (1n << 128n) - 1n;
export class RewardIndexError extends Error {
  constructor(public readonly code: string) { super(code); }
}
const hasOwn = (object: object, key: string) => Object.prototype.hasOwnProperty.call(object, key);
const bad = (): never => { throw new RewardIndexError('INVALID_BLOCK'); };

/** JSON integers never cross a Number boundary. Reject duplicate keys and excessive nesting. */
export function losslessJson(raw: string): any {
  if (raw.length > 32 * 1024 * 1024) return bad();
  let i = 0;
  const ws = () => { while (/[ \t\n\r]/.test(raw[i] ?? '') && i < raw.length) i++; };
  const string = (): string => {
    const start = i++;
    while (i < raw.length) {
      if (raw[i] === '\\') { i += 2; continue; }
      if (raw[i++] === '"') {
        try { return JSON.parse(raw.slice(start, i)); } catch { return bad(); }
      }
    }
    return bad();
  };
  const value = (depth: number): any => {
    if (depth > 64) return bad();
    ws();
    if (raw[i] === '"') return string();
    if (raw[i] === '{') {
      i++; ws();
      const obj = Object.create(null);
      if (raw[i] === '}') { i++; return obj; }
      while (true) {
        ws(); if (raw[i] !== '"') return bad();
        const key = string(); ws();
        if (hasOwn(obj, key) || raw[i++] !== ':') return bad();
        obj[key] = value(depth + 1); ws();
        const sep = raw[i++];
        if (sep === '}') return obj;
        if (sep !== ',') return bad();
      }
    }
    if (raw[i] === '[') {
      i++; ws(); const arr = [];
      if (raw[i] === ']') { i++; return arr; }
      while (true) {
        arr.push(value(depth + 1)); ws();
        const sep = raw[i++];
        if (sep === ']') return arr;
        if (sep !== ',') return bad();
      }
    }
    for (const [token, result] of [['true', true], ['false', false], ['null', null]] as const) {
      if (raw.startsWith(token, i)) { i += token.length; return result; }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(raw.slice(i));
    if (!match) return bad();
    i += match[0].length;
    // Non-integer fields (e.g. difficulty) may be present but cannot be used as amounts/heights.
    return /^-?\d+$/.test(match[0]) && match[0] !== '-0' ? BigInt(match[0]) : Number(match[0]);
  };
  const result = value(0); ws();
  if (i !== raw.length) return bad();
  return result;
}

const P = (1n << 255n) - 19n;
const mod = (x: bigint) => ((x % P) + P) % P;
function pow(x: bigint, n: bigint): bigint {
  let out = 1n;
  for (x = mod(x); n > 0; n >>= 1n, x = mod(x * x)) if (n & 1n) out = mod(out * x);
  return out;
}
/** curve25519-dalek decompress: y is reduced mod p; weak/noncanonical points are accepted. */
function validEdwardsKey(bytes: Buffer): boolean {
  const yBytes = Buffer.from(bytes); yBytes[31] &= 127;
  const y = BigInt(`0x${Buffer.from(yBytes).reverse().toString('hex')}`) % P;
  const y2 = mod(y * y);
  const d = mod(-121665n * pow(121666n, P - 2n));
  const u = mod(y2 - 1n), v = mod(d * y2 + 1n);
  const x2 = mod(u * pow(v, P - 2n));
  // A zero denominator must not be accepted by the modular inverse's zero result.
  return v !== 0n && (x2 === 0n || pow(x2, (P - 1n) / 2n) === 1n);
}
export function payoutAddress(identity: unknown): string {
  if (typeof identity !== 'string') return bad();
  const address = identity.startsWith('0x') ? identity.slice(2) : identity;
  if (/^[a-fA-F0-9]{40}$/.test(address)) return `0x${address.toLowerCase()}`;
  // Rust PublicKey::from_hex does not strip a prefix.
  if (!/^[a-fA-F0-9]{64}$/.test(identity)) return bad();
  const bytes = Buffer.from(identity, 'hex');
  if (!validEdwardsKey(bytes)) return bad();
  return `0x${createHash('sha3-256').update(bytes).digest('hex').slice(0, 40)}`;
}
function uint(value: unknown, max = U128_MAX): bigint {
  if (typeof value !== 'bigint' || value < 0n || value > max) return bad();
  return value;
}
function height(value: unknown): number { return Number(uint(value, BigInt(Number.MAX_SAFE_INTEGER))); }
function hash(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) return bad();
  return value.toLowerCase();
}
export interface Payout {
  role: 'producer' | 'attester'; eventId: string; payee: string; identity: string; amount: string;
}
export interface RewardBlock {
  height: number; hash: string; prevHash: string; timestamp: string; payouts: Payout[];
}
export function parseRewardBlock(raw: string, expectedHeight: number): RewardBlock {
  const envelope = losslessJson(raw);
  const b = envelope?.data;
  if (!b || height(b.height) !== expectedHeight || !b.metadata || typeof b.metadata !== 'object' || Array.isArray(b.metadata)) return bad();
  if (typeof b.timestamp !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(b.timestamp) || !Number.isFinite(Date.parse(b.timestamp))) return bad();
  const payouts: Payout[] = [];
  if (hasOwn(b.metadata, 'producer_settlement')) {
    if (typeof b.metadata.producer_settlement !== 'string') return bad();
    const receipt = losslessJson(b.metadata.producer_settlement);
    if (height(receipt?.height) !== expectedHeight || !Array.isArray(b.producer_pubkey) || b.producer_pubkey.length !== 32) return bad();
    const key = Buffer.from(b.producer_pubkey.map((n: unknown) => Number(uint(n, 255n)))).toString('hex');
    // Producer payee MUST be an address; never derive it from the signer.
    if (typeof receipt.payout_address !== 'string' || !/^(?:0x)?[a-fA-F0-9]{40}$/.test(receipt.payout_address)) return bad();
    const amount = uint(receipt.amount); if (amount === 0n) return bad();
    payouts.push({ role: 'producer', eventId: `producer:${expectedHeight}`, payee: payoutAddress(receipt.payout_address), identity: key, amount: amount.toString() });
  }
  let commits = 0n, total = 0n;
  const decisions = new Set<string>();
  if (hasOwn(b.metadata, 'attester_settlements')) {
    if (typeof b.metadata.attester_settlements !== 'string') return bad();
    const records = losslessJson(b.metadata.attester_settlements);
    if (!Array.isArray(records) || records.length === 0) return bad();
    for (const r of records) {
      if (typeof r?.decision_id !== 'string' || r.decision_id.length === 0 || r.decision_id.length > 256 || decisions.has(r.decision_id) || height(r.finalization_height) !== expectedHeight || !Array.isArray(r.allocations) || r.allocations.length === 0) return bad();
      decisions.add(r.decision_id);
      let previous: string | null = null;
      for (const a of r.allocations) {
        if (typeof a?.attester_id !== 'string' || (previous !== null && previous >= a.attester_id)) return bad();
        previous = a.attester_id;
        const payee = payoutAddress(a.attester_id), amount = uint(a.amount);
        commits++; total += amount; if (total > U128_MAX) return bad();
        payouts.push({ role: 'attester', eventId: JSON.stringify([r.decision_id, a.attester_id]), payee, identity: a.attester_id.length === 40 ? `0x${a.attester_id.toLowerCase()}` : a.attester_id.toLowerCase(), amount: amount.toString() });
      }
    }
  }
  for (const [key, expected] of [['attester_settlement_decision_count', BigInt(decisions.size)], ['attester_settlement_commit_count', commits], ['attester_settlement_minted_total', total]] as const) {
    const v = b.metadata[key];
    if (v !== undefined && (typeof v !== 'string' || !/^(0|[1-9]\d*)$/.test(v) || BigInt(v) !== expected)) return bad();
  }
  // Deliberately ignore reward_entries/forecast/faucet/node: decisions are not paid receipts.
  return { height: expectedHeight, hash: hash(b.hash), prevHash: hash(b.prev_block_hash), timestamp: new Date(b.timestamp).toISOString(), payouts };
}
