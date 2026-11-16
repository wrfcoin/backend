/**
 * Per-bond node-pay history store (migration 0047_bond_payout_history).
 *
 * The node keeps only a few node-settlement epochs and drops an epoch soon after it is PAID, so this
 * table is the backend's own record of which bonded node was paid in which 512-block node-pay epoch.
 * One row per (bond, epoch) observed. No row = never observed = unknown, which is NOT unpaid.
 *
 * Merge rule (mergeObservation): an observation never deletes a row and never downgrades `paid`.
 *   paid    stays paid (a missing amount/height may be filled in);
 *   unpaid  can become paid (a later, better read wins), never pending;
 *   pending can become paid or unpaid; the first baseline (payout account total) is kept.
 * Retention: rows more than BOND_PAYOUT_RETAIN_EPOCHS epochs behind the tip are deleted, and so are rows
 * ahead of the tip (a chain reset).
 */
import type { Client, Pool } from '../chain-rewards/store.js';

export type { Client, Pool };
export type PayoutStatus = 'paid' | 'unpaid' | 'pending';
export type PayoutSource = 'settlement' | 'earned_total';

export interface PayoutRow {
  bondId: string;
  epoch: number;
  status: PayoutStatus;
  /** Base units as a decimal string, or null. */
  amount: string | null;
  height: number | null;
  source: PayoutSource;
  payoutAddress: string | null;
  baselineEarned: string | null;
  baselineHeight: number | null;
}

export interface TipState { tipEpoch: number; tipHeight: number; observedAt: string }

export interface BondPayoutStore {
  /** Merge each observation into its row (mergeObservation), all in one transaction. */
  record(observations: PayoutRow[]): Promise<number>;
  setTip(tipEpoch: number, tipHeight: number): Promise<void>;
  tip(): Promise<TipState | null>;
  /** Delete rows with epoch < tipEpoch - retainEpochs, or epoch > tipEpoch (chain reset). */
  prune(tipEpoch: number, retainEpochs: number): Promise<number>;
  /** Rows of one bond in [fromEpoch, toEpoch], ascending. */
  history(bondId: string, fromEpoch: number, toEpoch: number): Promise<PayoutRow[]>;
  /** Bond ids with any row, newest observation first. */
  knownBondIds(limit: number): Promise<string[]>;
  /** Pending rows whose maturity height is <= throughHeight and that carry a payout address and baseline. */
  maturedPending(throughHeight: number, limit: number): Promise<PayoutRow[]>;
  /** Paid rows of a payout address with height in (afterHeight, throughHeight]. */
  paidSince(payoutAddress: string, afterHeight: number, throughHeight: number): Promise<PayoutRow[]>;
}

export const BOND_PAYOUT_RETAIN_EPOCHS = 40;
export const BOND_ID_RE = /^[0-9a-f]{64}$/;
export const BASE_UNITS_RE = /^(0|[1-9][0-9]{0,38})$/;
export const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

/** The row to store when `incoming` is observed and `existing` (or nothing) is stored. */
export function mergeObservation(existing: PayoutRow | null, incoming: PayoutRow): PayoutRow {
  if (!existing) return { ...incoming };
  const keepBaseline = {
    payoutAddress: existing.payoutAddress ?? incoming.payoutAddress,
    baselineEarned: existing.baselineEarned ?? incoming.baselineEarned,
    baselineHeight: existing.baselineHeight ?? incoming.baselineHeight,
  };
  if (existing.status === 'paid') {
    // Never downgraded. A settlement read may replace an inferred (earned_total) amount.
    const better = incoming.status === 'paid' && incoming.source === 'settlement' && existing.source !== 'settlement';
    return better
      ? { ...incoming, ...keepBaseline }
      : { ...existing, amount: existing.amount ?? (incoming.status === 'paid' ? incoming.amount : null), height: existing.height ?? incoming.height, ...keepBaseline };
  }
  if (incoming.status === 'paid') return { ...incoming, ...keepBaseline };
  if (existing.status === 'unpaid') {
    return { ...existing, height: existing.height ?? incoming.height, ...keepBaseline };
  }
  // existing pending
  if (incoming.status === 'unpaid') return { ...incoming, amount: null, ...keepBaseline };
  return { ...existing, amount: incoming.amount ?? existing.amount, height: incoming.height ?? existing.height, ...keepBaseline };
}

const sameRow = (a: PayoutRow, b: PayoutRow) =>
  a.status === b.status && a.amount === b.amount && a.height === b.height && a.source === b.source
  && a.payoutAddress === b.payoutAddress && a.baselineEarned === b.baselineEarned && a.baselineHeight === b.baselineHeight;

// ── In-memory store (tests, and a fallback when no database is configured) ─────────────────────

export function createMemoryBondPayoutStore(): BondPayoutStore & { rows: Map<string, PayoutRow> } {
  const rows = new Map<string, PayoutRow>();
  const order: string[] = [];
  let tipState: TipState | null = null;
  const key = (bondId: string, epoch: number) => `${bondId}:${epoch}`;
  return {
    rows,
    async record(observations) {
      let changed = 0;
      for (const o of observations) {
        const k = key(o.bondId, o.epoch);
        const existing = rows.get(k) ?? null;
        const next = mergeObservation(existing, o);
        if (!existing || !sameRow(existing, next)) { rows.set(k, next); changed++; }
        const i = order.indexOf(o.bondId);
        if (i >= 0) order.splice(i, 1);
        order.unshift(o.bondId);
      }
      return changed;
    },
    async setTip(tipEpoch, tipHeight) { tipState = { tipEpoch, tipHeight, observedAt: new Date().toISOString() }; },
    async tip() { return tipState; },
    async prune(tipEpoch, retainEpochs) {
      let n = 0;
      for (const [k, r] of rows) if (r.epoch < tipEpoch - retainEpochs || r.epoch > tipEpoch) { rows.delete(k); n++; }
      return n;
    },
    async history(bondId, fromEpoch, toEpoch) {
      return [...rows.values()].filter((r) => r.bondId === bondId && r.epoch >= fromEpoch && r.epoch <= toEpoch)
        .sort((a, b) => a.epoch - b.epoch).map((r) => ({ ...r }));
    },
    async knownBondIds(limit) {
      const live = new Set([...rows.values()].map((r) => r.bondId));
      return order.filter((id) => live.has(id)).slice(0, limit);
    },
    async maturedPending(throughHeight, limit) {
      return [...rows.values()].filter((r) => r.status === 'pending' && r.height !== null && r.height <= throughHeight
        && r.payoutAddress !== null && r.baselineEarned !== null && r.baselineHeight !== null)
        .sort((a, b) => a.epoch - b.epoch).slice(0, limit).map((r) => ({ ...r }));
    },
    async paidSince(payoutAddress, afterHeight, throughHeight) {
      return [...rows.values()].filter((r) => r.status === 'paid' && r.payoutAddress === payoutAddress
        && r.height !== null && r.height > afterHeight && r.height <= throughHeight).map((r) => ({ ...r }));
    },
  };
}

// ── PostgreSQL store ──────────────────────────────────────────────────────────────────────────────

const COLUMNS = `bond_id, epoch::text AS epoch, status, amount::text AS amount, height::text AS height, source,
  payout_address, baseline_earned::text AS baseline_earned, baseline_height::text AS baseline_height`;

const int = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

function fromDb(r: any): PayoutRow {
  return {
    bondId: r.bond_id, epoch: Number(r.epoch), status: r.status, amount: r.amount ?? null, height: int(r.height),
    source: r.source, payoutAddress: r.payout_address ?? null, baselineEarned: r.baseline_earned ?? null, baselineHeight: int(r.baseline_height),
  };
}

const params = (r: PayoutRow) => [r.bondId, r.epoch, r.status, r.amount, r.height, r.source, r.payoutAddress, r.baselineEarned, r.baselineHeight];

async function withClient<T>(pool: Pool, fn: (c: Client) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try { return await fn(client); } finally { client.release(); }
}

export function createPgBondPayoutStore(pool: Pool): BondPayoutStore {
  return {
    async record(observations) {
      if (observations.length === 0) return 0;
      return withClient(pool, async (c) => {
        await c.query('BEGIN');
        try {
          // One writer at a time (two backend processes, or a pass overlapping a slow one).
          await c.query('SELECT pg_advisory_xact_lock(hashtext(\'bond_payout_history\'))');
          let changed = 0;
          for (const o of observations) {
            const found = (await c.query(`SELECT ${COLUMNS} FROM bond_payout_history WHERE bond_id=$1 AND epoch=$2 FOR UPDATE`, [o.bondId, o.epoch])).rows[0];
            const existing = found ? fromDb(found) : null;
            const next = mergeObservation(existing, o);
            if (!existing) {
              await c.query(`INSERT INTO bond_payout_history (bond_id, epoch, status, amount, height, source, payout_address, baseline_earned, baseline_height)
                VALUES ($1,$2,$3,$4::numeric,$5,$6,$7,$8::numeric,$9)`, params(next));
              changed++;
            } else if (!sameRow(existing, next)) {
              await c.query(`UPDATE bond_payout_history SET status=$3, amount=$4::numeric, height=$5, source=$6, payout_address=$7,
                baseline_earned=$8::numeric, baseline_height=$9, updated_at=now() WHERE bond_id=$1 AND epoch=$2`, params(next));
              changed++;
            }
          }
          await c.query('COMMIT');
          return changed;
        } catch (e) { await c.query('ROLLBACK'); throw e; }
      });
    },
    async setTip(tipEpoch, tipHeight) {
      await withClient(pool, (c) => c.query(`INSERT INTO bond_payout_history_state (id, tip_epoch, tip_height, observed_at) VALUES (1,$1,$2,now())
        ON CONFLICT (id) DO UPDATE SET tip_epoch=EXCLUDED.tip_epoch, tip_height=EXCLUDED.tip_height, observed_at=now()`, [tipEpoch, tipHeight]));
    },
    async tip() {
      const r = (await withClient(pool, (c) => c.query(`SELECT tip_epoch::text AS tip_epoch, tip_height::text AS tip_height,
        to_char(observed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS observed_at FROM bond_payout_history_state WHERE id=1`))).rows[0];
      return r ? { tipEpoch: Number(r.tip_epoch), tipHeight: Number(r.tip_height), observedAt: r.observed_at } : null;
    },
    async prune(tipEpoch, retainEpochs) {
      const r = await withClient(pool, (c) => c.query(`WITH gone AS (DELETE FROM bond_payout_history WHERE epoch < $1 OR epoch > $2 RETURNING 1)
        SELECT count(*)::text AS n FROM gone`, [tipEpoch - retainEpochs, tipEpoch]));
      return Number(r.rows[0]?.n ?? 0);
    },
    async history(bondId, fromEpoch, toEpoch) {
      return (await withClient(pool, (c) => c.query(`SELECT ${COLUMNS} FROM bond_payout_history WHERE bond_id=$1 AND epoch BETWEEN $2 AND $3 ORDER BY epoch`,
        [bondId, fromEpoch, toEpoch]))).rows.map(fromDb);
    },
    async knownBondIds(limit) {
      return (await withClient(pool, (c) => c.query('SELECT bond_id FROM bond_payout_history GROUP BY bond_id ORDER BY max(updated_at) DESC, bond_id LIMIT $1',
        [limit]))).rows.map((r: any) => r.bond_id as string);
    },
    async maturedPending(throughHeight, limit) {
      return (await withClient(pool, (c) => c.query(`SELECT ${COLUMNS} FROM bond_payout_history WHERE status='pending' AND height <= $1
        AND payout_address IS NOT NULL AND baseline_earned IS NOT NULL AND baseline_height IS NOT NULL ORDER BY epoch, bond_id LIMIT $2`,
      [throughHeight, limit]))).rows.map(fromDb);
    },
    async paidSince(payoutAddress, afterHeight, throughHeight) {
      return (await withClient(pool, (c) => c.query(`SELECT ${COLUMNS} FROM bond_payout_history WHERE status='paid' AND payout_address=$1
        AND height > $2 AND height <= $3 ORDER BY epoch, bond_id`, [payoutAddress, afterHeight, throughHeight]))).rows.map(fromDb);
    },
  };
}
