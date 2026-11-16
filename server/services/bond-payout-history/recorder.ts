/**
 * Bond payout history recorder: keeps per-bond node-pay history (store.ts) for longer than the node does.
 *
 * Same node reads as GET /api/network/nodes (network-nodes-routes.ts), with the backend's Reader credential:
 *   1. /node/bonds/<zero id>          the current node-pay epoch and tip height;
 *   2. /node/settlement/<e>           the last BOND_PAYOUT_SETTLEMENT_EPOCHS closed epochs;
 *   3. /node/bonds/<id>               each tracked bond (registered epoch, payout account);
 *   4. /addresses/<payout account>    earned_balance_total, for baselines and matured pending payouts.
 * Tracked bonds: ids in those settlement maps, NETWORK_NODES_BOND_IDS, and ids already in the table
 * (capped at BOND_PAYOUT_MAX_BONDS).
 *
 * What each settlement status records, per tracked bond:
 *   PAID         in payouts_base_units -> paid (amount, height = maturity height, source settlement);
 *                otherwise, if registered before the epoch -> unpaid.
 *   PROVISIONAL  in provisional_base_units -> pending (amount, maturity height, payout account and its
 *                earned_balance_total now as a baseline); otherwise, if registered before -> unpaid
 *                (the provisional split is frozen at epoch close; payouts are a subset of it).
 *   UNISSUED     registered before the epoch -> unpaid.
 *   OPEN, UNKNOWN (pruned or never seen), unreadable -> nothing.
 * The node drops a PAID epoch soon after paying it, so a pass may never see PAID. A pending row whose
 * maturity height has passed is then settled from the payout account: when earned_balance_total has risen
 * since the baseline by at least the sum of that account's matured pending amounts plus the payouts already
 * recorded for it since the baseline, every one of those rows becomes paid (source earned_total). Otherwise
 * the row stays pending (shown as unknown once matured); it is never guessed unpaid.
 *
 * Load: one pass per BOND_PAYOUT_HISTORY_INTERVAL_MS (default 5 min; an epoch is ~11 h on chain 888) makes
 * at most 1 + 8 + 64 + 64 node reads. OFF unless BOND_PAYOUT_HISTORY_ENABLED=true; needs migration 0047 and
 * WRFCOIN_READER_TOKEN. Never logs ids, addresses or upstream text.
 */
import { configuredBondIds } from '../../routes/network-nodes-routes.js';
import {
  ADDRESS_RE, BASE_UNITS_RE, BOND_ID_RE, BOND_PAYOUT_RETAIN_EPOCHS,
  type BondPayoutStore, type PayoutRow, type Pool,
} from './store.js';

type Row = Record<string, any>;
export type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<{ ok: boolean; status: number; payload: any }>;
/** One node read: the unwrapped JSON object, or null on any failure. */
export type NodeGet = (path: string) => Promise<Row | null>;

export const bondPayoutHistoryEnabled = () => process.env.BOND_PAYOUT_HISTORY_ENABLED === 'true';
export const BOND_PAYOUT_SETTLEMENT_EPOCHS = 8;
export const BOND_PAYOUT_MAX_BONDS = 64;
export const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;
const ZERO_ID = '0'.repeat(64);
const CALL_TIMEOUT_MS = 4_000;

function unwrap(payload: any): Row | null {
  const data = payload && typeof payload === 'object' && payload.ok === true && 'data' in payload ? payload.data : payload;
  return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
}

export function safeInt(value: unknown): number | null {
  if (typeof value === 'string' && /^(0|[1-9][0-9]{0,15})$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const units = (value: unknown): string | null => (typeof value === 'string' && BASE_UNITS_RE.test(value) ? value : null);

function addressHex(value: unknown): string | null {
  let hex: string | null = null;
  if (typeof value === 'string' && /^(0x)?[0-9a-fA-F]{40}$/.test(value)) hex = value.toLowerCase().replace(/^0x/, '');
  else if (Array.isArray(value) && value.length === 20 && value.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    hex = value.map((b: number) => b.toString(16).padStart(2, '0')).join('');
  }
  return hex && /[^0]/.test(hex) ? `0x${hex}` : null;
}

/** The {id: amount} map of a settlement field, ids lowercased and validated. */
function idMap(value: unknown): Map<string, string> {
  const out = new Map<string, string>();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [id, amount] of Object.entries(value)) {
    const key = id.toLowerCase();
    const v = units(amount);
    if (BOND_ID_RE.test(key) && v !== null) out.set(key, v);
  }
  return out;
}

export interface Settlement { epoch: number; status: string; maturityHeight: number | null; payouts: Map<string, string>; provisional: Map<string, string> }
export interface BondInfo { registeredEpoch: number | null; payoutAddress: string | null }

export function parseSettlement(epoch: number, row: Row | null): Settlement | null {
  if (!row || typeof row.status !== 'string') return null;
  if (row.epoch !== undefined && safeInt(row.epoch) !== epoch) return null;
  return {
    epoch, status: row.status, maturityHeight: safeInt(row.maturity_height),
    payouts: idMap(row.payouts_base_units), provisional: idMap(row.provisional_base_units),
  };
}

export function parseBond(id: string, row: Row | null): BondInfo | null {
  if (!row || row.deployment_id !== id || row.status !== 'REGISTERED') return null;
  const reg: Row = row.registration && typeof row.registration === 'object' ? row.registration : {};
  const binding: Row = reg.binding && typeof reg.binding === 'object' ? reg.binding : {};
  return { registeredEpoch: safeInt(reg.registered_epoch), payoutAddress: addressHex(binding.payout_account) };
}

/** What one settlement record says about each tracked bond (see the header). Pure. */
export function observeSettlement(s: Settlement, bonds: Map<string, BondInfo | null>,
  baseline: (address: string) => { earned: string; height: number } | null): PayoutRow[] {
  const out: PayoutRow[] = [];
  const registeredBefore = (id: string) => {
    const b = bonds.get(id);
    return !!b && b.registeredEpoch !== null && b.registeredEpoch < s.epoch;
  };
  const base = { epoch: s.epoch, height: s.maturityHeight, source: 'settlement' as const, baselineEarned: null, baselineHeight: null };
  const unpaid = (bondId: string): PayoutRow => ({ ...base, bondId, status: 'unpaid', amount: null, payoutAddress: bonds.get(bondId)?.payoutAddress ?? null });
  if (s.status === 'PAID') {
    for (const [bondId, amount] of s.payouts) out.push({ ...base, bondId, status: 'paid', amount, payoutAddress: bonds.get(bondId)?.payoutAddress ?? null });
    for (const id of bonds.keys()) if (!s.payouts.has(id) && registeredBefore(id)) out.push(unpaid(id));
  } else if (s.status === 'PROVISIONAL') {
    for (const [bondId, amount] of s.provisional) {
      const payoutAddress = bonds.get(bondId)?.payoutAddress ?? null;
      const b = payoutAddress ? baseline(payoutAddress) : null;
      out.push({ ...base, bondId, status: 'pending', amount, payoutAddress, baselineEarned: b?.earned ?? null, baselineHeight: b?.height ?? null });
    }
    for (const id of bonds.keys()) if (!s.provisional.has(id) && registeredBefore(id)) out.push(unpaid(id));
  } else if (s.status === 'UNISSUED') {
    for (const id of bonds.keys()) if (registeredBefore(id)) out.push(unpaid(id));
  }
  return out;
}

/** Matured pending rows that the payout account's earned total proves paid (see the header). Pure. */
export function settleFromEarned(pending: PayoutRow[], earnedNow: Map<string, string>,
  paidSince: Map<string, PayoutRow[]>): PayoutRow[] {
  const byAddress = new Map<string, PayoutRow[]>();
  for (const r of pending) {
    if (!r.payoutAddress || r.baselineEarned === null || r.amount === null) continue;
    const list = byAddress.get(r.payoutAddress) ?? [];
    list.push(r);
    byAddress.set(r.payoutAddress, list);
  }
  const out: PayoutRow[] = [];
  for (const [address, rows] of byAddress) {
    const now = earnedNow.get(address);
    if (now === undefined) continue;
    const baseline = rows.reduce((min, r) => (BigInt(r.baselineEarned!) < min ? BigInt(r.baselineEarned!) : min), BigInt(rows[0].baselineEarned!));
    const baselineHeight = Math.min(...rows.map((r) => r.baselineHeight ?? 0));
    const pendingKeys = new Set(rows.map((r) => `${r.bondId}:${r.epoch}`));
    const already = (paidSince.get(address) ?? []).filter((r) => r.height !== null && r.height > baselineHeight && !pendingKeys.has(`${r.bondId}:${r.epoch}`));
    const need = rows.reduce((n, r) => n + BigInt(r.amount!), 0n) + already.reduce((n, r) => n + BigInt(r.amount ?? '0'), 0n);
    if (BigInt(now) - baseline >= need) {
      for (const r of rows) out.push({ ...r, status: 'paid', source: 'earned_total' });
    }
  }
  return out;
}

export interface PassSummary {
  status: 'ok' | 'unavailable';
  tipEpoch: number | null;
  settlementsRead: number;
  bonds: number;
  observations: number;
  changed: number;
  settledFromEarned: number;
  pruned: number;
}

export async function runBondPayoutHistoryOnce(options: {
  store: BondPayoutStore; get: NodeGet; configured?: string[];
  settlementEpochs?: number; maxBonds?: number; retainEpochs?: number;
}): Promise<PassSummary> {
  const { store, get } = options;
  const summary: PassSummary = { status: 'unavailable', tipEpoch: null, settlementsRead: 0, bonds: 0, observations: 0, changed: 0, settledFromEarned: 0, pruned: 0 };
  const probe = await get(`/node/bonds/${ZERO_ID}`);
  const tipEpoch = probe ? safeInt(probe.epoch) : null;
  const tipHeight = probe ? safeInt(probe.height) : null;
  if (tipEpoch === null || tipHeight === null) return summary;
  summary.status = 'ok';
  summary.tipEpoch = tipEpoch;
  await store.setTip(tipEpoch, tipHeight);
  summary.pruned = await store.prune(tipEpoch, options.retainEpochs ?? BOND_PAYOUT_RETAIN_EPOCHS);

  // Closed epochs only: the current one is OPEN and says nothing yet.
  const epochs: number[] = [];
  for (let e = tipEpoch - 1; e >= 0 && epochs.length < (options.settlementEpochs ?? BOND_PAYOUT_SETTLEMENT_EPOCHS); e -= 1) epochs.push(e);
  const settlements = (await Promise.all(epochs.map(async (e) => parseSettlement(e, await get(`/node/settlement/${e}`)))))
    .filter((s): s is Settlement => s !== null);
  summary.settlementsRead = settlements.length;

  const maxBonds = options.maxBonds ?? BOND_PAYOUT_MAX_BONDS;
  const ids = new Set<string>();
  for (const s of settlements) for (const id of [...s.payouts.keys(), ...s.provisional.keys()]) ids.add(id);
  for (const id of options.configured ?? configuredBondIds()) ids.add(id);
  for (const id of await store.knownBondIds(maxBonds)) ids.add(id);
  const list = [...ids].slice(0, maxBonds);
  const bonds = new Map<string, BondInfo | null>();
  await Promise.all(list.map(async (id) => { bonds.set(id, parseBond(id, await get(`/node/bonds/${id}`))); }));
  summary.bonds = list.length;

  // Payout account totals: for new pending baselines and for matured pending rows.
  const earned = new Map<string, string>();
  const readEarned = async (address: string) => {
    if (earned.has(address) || !ADDRESS_RE.test(address)) return;
    const acct = await get(`/addresses/${address}`);
    const v = acct ? units(acct.earned_balance_total) : null;
    if (v !== null) earned.set(address, v);
  };
  const needBaseline = new Set<string>();
  for (const s of settlements) {
    if (s.status !== 'PROVISIONAL') continue;
    for (const id of s.provisional.keys()) { const a = bonds.get(id)?.payoutAddress; if (a) needBaseline.add(a); }
  }
  await Promise.all([...needBaseline].map(readEarned));

  const observations = settlements.flatMap((s) => observeSettlement(s, bonds, (address) => {
    const v = earned.get(address);
    return v === undefined ? null : { earned: v, height: tipHeight };
  }));
  summary.observations = observations.length;
  summary.changed = await store.record(observations);

  const matured = await store.maturedPending(tipHeight, maxBonds * 4);
  if (matured.length > 0) {
    const addresses = [...new Set(matured.map((r) => r.payoutAddress!))];
    await Promise.all(addresses.map(readEarned));
    const paidSince = new Map<string, PayoutRow[]>();
    for (const a of addresses) {
      const from = Math.min(...matured.filter((r) => r.payoutAddress === a).map((r) => r.baselineHeight ?? 0));
      paidSince.set(a, await store.paidSince(a, from, tipHeight));
    }
    const settled = settleFromEarned(matured, earned, paidSince);
    summary.settledFromEarned = settled.length;
    if (settled.length) summary.changed += await store.record(settled);
  }
  return summary;
}

// ── Production wiring ───────────────────────────────────────────────────────────────────────────

export function createNodeGet(token: string, fetchCore4Json: Core4Fetch): NodeGet {
  const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
  return async (path) => {
    try {
      const reply = await fetchCore4Json(path, { headers, timeoutMs: CALL_TIMEOUT_MS });
      return reply.ok ? unwrap(reply.payload) : null;
    } catch {
      return null;
    }
  };
}

let timer: ReturnType<typeof setTimeout> | null = null;
let active = false;
export async function startBondPayoutHistoryRecorder(options: {
  env?: Record<string, string | undefined>;
  logger?: { info(message: string, meta?: any): void; warn(message: string, meta?: any): void };
} = {}): Promise<boolean> {
  const env = options.env ?? process.env;
  if (env.BOND_PAYOUT_HISTORY_ENABLED !== 'true' || active) return active;
  const token = env.WRFCOIN_READER_TOKEN?.trim();
  if (!token) { options.logger?.warn('Bond payout history recorder not started: configuration unavailable'); return false; }
  const rawInterval = Number(env.BOND_PAYOUT_HISTORY_INTERVAL_MS);
  const interval = Number.isSafeInteger(rawInterval) && rawInterval >= 60_000 ? rawInterval : DEFAULT_INTERVAL_MS;
  try {
    const { pool } = await import('../../../database/db.js');
    const { fetchCore4Json } = await import('../../../shared/core4-route-client.js');
    const { createPgBondPayoutStore } = await import('./store.js');
    const store = createPgBondPayoutStore(pool as unknown as Pool);
    const get = createNodeGet(token, fetchCore4Json as unknown as Core4Fetch);
    const tick = async () => {
      if (!active) return;
      try {
        const summary = await runBondPayoutHistoryOnce({ store, get });
        options.logger?.info('Bond payout history pass', summary);
      } catch { options.logger?.warn('Bond payout history pass failed'); }
      if (active) { timer = setTimeout(() => { void tick(); }, interval); timer.unref?.(); }
    };
    active = true;
    timer = setTimeout(() => { void tick(); }, 30_000); timer.unref?.();
    return true;
  } catch { options.logger?.warn('Bond payout history recorder not started: configuration unavailable'); return false; }
}
export function stopBondPayoutHistoryRecorder(): void {
  active = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
