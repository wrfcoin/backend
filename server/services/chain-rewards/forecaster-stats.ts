/**
 * Forecaster track record read model (wrfcoin/core4#3604, Phase A item A4).
 *
 * Reads only the forecast rows the chain-rewards indexer writes from block metadata
 * (`chain_forecast_decision_events`, `chain_forecast_block_stats`), under the same snapshot gate as
 * the earnings read model: a consistent REPEATABLE READ view, index status `ok`, complete coverage
 * from height 1 and a fresh `checked_at`. Anything else is `ForecastStatsUnavailable` (HTTP 503 at
 * the route), never a partial answer.
 *
 * What the chain exposes today bounds what is promised (facts recorded in the lane ledger):
 *  - a forecast counts from the block in which its reward DECISION is first observed; a decision may
 *    be repeated while pending, so readers group by commit_id and take min(height);
 *  - `amount` on a decision is nominal until finalized and is never summed; paid figures come only
 *    from the per-block minted counters, network-wide;
 *  - skill (CRPS/RMSE/MAE by variable and lead) is NOT readable from any node route on core4 dd1801a3
 *    (`/chain/block/{h}` carries a reveal's commit_id only); the columns exist and stay NULL, and the
 *    API says `not_yet_available` rather than inventing a number.
 */
import type { Client, Pool } from './store.js';

export const FORECASTER_PERIODS = ['7d', '30d', 'all'] as const;
export type ForecasterPeriod = typeof FORECASTER_PERIODS[number];
export const forecastersEnabled = () => process.env.CHAIN_REWARD_INDEX_ENABLED === 'true';
export class ForecastStatsUnavailable extends Error { constructor() { super('FORECASTERS_UNAVAILABLE'); } }

const units = { currency: 'WRF', decimals: 8, scale: '100000000' };
const NOT_YET = (reason: string) => ({ status: 'not_yet_available' as const, reason });
export const SKILL_REASON = 'The node does not expose revealed forecast receipts in block reads (core4 /chain/block/{height} carries a reveal\'s commit_id only), so no skill score can be read yet.';
export const PAID_REASON = 'Per-forecaster paid totals are not in block metadata (decisions are nominal until finalized); only network-wide minted totals are available.';

export interface SnapshotHeader {
  units: typeof units;
  coverage: { fromHeight: string; throughHeight: string; complete: true; skippedRecords: string };
  asOf: { height: string; hash: string; time: string; checkedAt: string };
  finalityPolicy: 'confirmed-canonical-with-rollback';
}
export interface LeaderboardRow {
  rank: number; address: string; forecasts: string; forecastsPrevious: string | null; forecastsDelta: string | null;
  firstActiveAt: string; lastActiveAt: string;
  skill: ReturnType<typeof NOT_YET>; paid: ReturnType<typeof NOT_YET>;
}
export interface ForecasterStatsSource {
  leaderboard(period: ForecasterPeriod, limit: number): Promise<any>;
  trackRecord(address: string): Promise<any>;
  /** `c_` profile key or 0x address -> lowercase address, null when unknown. */
  resolveAddress(keyOrAddress: string): Promise<string | null>;
}

/**
 * Run `fn` inside one consistent REPEATABLE READ view of the forecast index, but only when the index
 * is healthy: status `ok`, no reorg probe, complete coverage from height 1, `checked_at` at most 10
 * minutes old. Anything else rejects with `ForecastStatsUnavailable`. Shared with the weekly
 * competition read model so both answer from the same gate.
 */
export async function withForecastSnapshot<T>(pool: Pool, chain: string, genesis: string, clock: () => number,
  fn: (client: Client, header: SnapshotHeader) => Promise<T>): Promise<T> {
  const args = [chain, genesis];
  let client: Client | undefined;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const state = (await client.query(`SELECT s.*, to_char(b.block_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS block_time
      FROM chain_reward_index_state s
      JOIN chain_reward_blocks b ON b.chain_id=s.chain_id AND b.genesis_hash=s.genesis_hash AND b.height=s.cursor_height AND b.block_hash=s.cursor_hash
      WHERE s.chain_id=$1 AND s.genesis_hash=$2`, args)).rows[0];
    const age = state ? clock() - new Date(state.checked_at).getTime() : NaN;
    if (!state || state.status !== 'ok' || state.reorg_probe_height !== null || state.parser_version !== 1 ||
        Number(state.history_floor) !== 1 || !Number.isFinite(age) || age < -5000 || age > 600000) throw new ForecastStatsUnavailable();
    const coverage = (await client.query(`SELECT count(*)::text AS count, min(height)::text AS floor, max(height)::text AS ceiling,
      bool_and(parser_version=1) AS parsed FROM chain_reward_blocks WHERE chain_id=$1 AND genesis_hash=$2`, args)).rows[0];
    if (!coverage?.parsed || coverage.floor !== '1' || coverage.ceiling !== String(state.cursor_height) || coverage.count !== String(state.cursor_height)) throw new ForecastStatsUnavailable();
    const skipped = (await client.query('SELECT coalesce(sum(skipped_records),0)::text AS skipped FROM chain_forecast_block_stats WHERE chain_id=$1 AND genesis_hash=$2', args)).rows[0];
    const header: SnapshotHeader = { units,
      coverage: { fromHeight: '1', throughHeight: String(state.cursor_height), complete: true, skippedRecords: skipped.skipped },
      asOf: { height: String(state.cursor_height), hash: state.cursor_hash, time: state.block_time, checkedAt: new Date(state.checked_at).toISOString() },
      finalityPolicy: 'confirmed-canonical-with-rollback' };
    const result = await fn(client, header); await client.query('COMMIT'); return result;
  } catch { if (client) { try { await client.query('ROLLBACK'); } catch {} } throw new ForecastStatsUnavailable(); }
  finally { client?.release(); }
}

function display(amount: string) {
  const n = BigInt(amount); return `${n / 100000000n}.${(n % 100000000n).toString().padStart(8, '0')}`;
}
const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : typeof value === 'string' ? new Date(value).toISOString() : null);

export function createForecasterStatsSource(pool: Pool, chain: string, genesis: string, clock = () => Date.now(),
  profileKeyFor: (address: string) => string | null = () => null): ForecasterStatsSource {
  const args = [chain, genesis];

  const snapshot = <T>(fn: (client: Client, header: SnapshotHeader) => Promise<T>): Promise<T> =>
    withForecastSnapshot(pool, chain, genesis, clock, fn);

  /** [start, end] bounds for a period ending at the snapshot's block time; `null` start = all time. */
  async function bounds(client: Client, header: SnapshotHeader, period: ForecasterPeriod, back = 0): Promise<{ start: string | null; end: string }> {
    const end = header.asOf.time;
    if (period === 'all') return { start: null, end };
    const days = period === '7d' ? 7 : 30;
    // Keep PostgreSQL microseconds at both boundaries; JS Date truncates them.
    const row = (await client.query(`SELECT to_char(($1::timestamptz - $2::int * interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start,
      to_char(($1::timestamptz - $3::int * interval '24 hours') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS end`, [end, days * (back + 1), days * back])).rows[0];
    return { start: row.start, end: row.end };
  }

  // First observation of each real forecast decision, with its block time.
  const FIRSTS = `WITH firsts AS (
      SELECT e.commit_id, e.forecaster_address, min(e.height) AS height
      FROM chain_forecast_decision_events e
      WHERE e.chain_id=$1 AND e.genesis_hash=$2 AND e.provenance_class='real'
      GROUP BY e.commit_id, e.forecaster_address),
    timed AS (
      SELECT f.commit_id, f.forecaster_address, f.height, b.block_time
      FROM firsts f JOIN chain_reward_blocks b ON b.chain_id=$1 AND b.genesis_hash=$2 AND b.height=f.height
      WHERE b.block_time<=$3::timestamptz AND ($4::timestamptz IS NULL OR b.block_time>=$4::timestamptz))`;

  async function perForecaster(client: Client, start: string | null, end: string, limit: number | null) {
    return (await client.query(`${FIRSTS}
      SELECT forecaster_address, count(*)::text AS forecasts,
        to_char(min(block_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_at,
        to_char(max(block_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_at
      FROM timed GROUP BY forecaster_address
      ORDER BY count(*) DESC, min(block_time) ASC, forecaster_address ASC ${limit === null ? '' : 'LIMIT $5'}`,
      limit === null ? [...args, end, start] : [...args, end, start, limit])).rows;
  }

  async function network(client: Client, start: string | null, end: string) {
    const activity = (await client.query(`${FIRSTS}
      SELECT count(*)::text AS forecasts, count(DISTINCT forecaster_address)::text AS forecasters FROM timed`, [...args, end, start])).rows[0];
    const minted = (await client.query(`SELECT coalesce(sum(s.minted_count),0)::text AS minted_count, coalesce(sum(s.minted_total),0)::text AS minted_total,
        coalesce(sum(s.with_receipt_count),0)::text AS with_receipt, coalesce(sum(s.baseline_count),0)::text AS baseline,
        count(*) FILTER (WHERE s.minted_count IS NULL)::text AS blocks_without_counters, count(*)::text AS blocks
      FROM chain_forecast_block_stats s JOIN chain_reward_blocks b ON b.chain_id=s.chain_id AND b.genesis_hash=s.genesis_hash AND b.height=s.height
      WHERE s.chain_id=$1 AND s.genesis_hash=$2 AND b.block_time<=$3::timestamptz AND ($4::timestamptz IS NULL OR b.block_time>=$4::timestamptz)`, [...args, end, start])).rows[0];
    return {
      forecasters: activity.forecasters, forecasts: activity.forecasts,
      rewardsMintedCount: minted.minted_count, rewardsMintedBaseUnits: minted.minted_total, rewardsMintedDisplay: display(minted.minted_total),
      rewardsWithReceiptCount: minted.with_receipt, rewardsBaselineCount: minted.baseline,
      blocks: minted.blocks, blocksWithoutCounters: minted.blocks_without_counters,
      meanSkill: NOT_YET(SKILL_REASON),
    };
  }

  return {
    leaderboard: (period, limit) => snapshot(async (client, header) => {
      const current = await bounds(client, header, period);
      const rows = await perForecaster(client, current.start, current.end, limit);
      let previous = new Map<string, string>();
      if (period !== 'all') {
        const prior = await bounds(client, header, period, 1);
        previous = new Map((await perForecaster(client, prior.start, prior.end, null)).map(r => [r.forecaster_address, r.forecasts]));
      }
      return { ...header, period, window: { from: current.start, through: current.end }, status: 'available', complete: true,
        network: await network(client, current.start, current.end),
        rows: rows.map((r, i): LeaderboardRow => {
          const prev = period === 'all' ? null : (previous.get(r.forecaster_address) ?? '0');
          return { rank: i + 1, address: r.forecaster_address, forecasts: r.forecasts, forecastsPrevious: prev,
            forecastsDelta: prev === null ? null : (BigInt(r.forecasts) - BigInt(prev)).toString(),
            firstActiveAt: r.first_at, lastActiveAt: r.last_at, skill: NOT_YET(SKILL_REASON), paid: NOT_YET(PAID_REASON) };
        }) };
    }),
    trackRecord: address => snapshot(async (client, header) => {
      if (!/^0x[0-9a-f]{40}$/.test(address)) throw new ForecastStatsUnavailable();
      const totals = (await client.query(`WITH firsts AS (
          SELECT e.commit_id, min(e.height) AS height, min(e.provenance_class) AS provenance_class
          FROM chain_forecast_decision_events e WHERE e.chain_id=$1 AND e.genesis_hash=$2 AND e.forecaster_address=$3 GROUP BY e.commit_id)
        SELECT count(*)::text AS forecasts,
          count(*) FILTER (WHERE provenance_class='real')::text AS real, count(*) FILTER (WHERE provenance_class='synthetic')::text AS synthetic,
          count(*) FILTER (WHERE provenance_class='unclassified')::text AS unclassified,
          to_char(min(b.block_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS first_at,
          to_char(max(b.block_time) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS last_at
        FROM firsts f JOIN chain_reward_blocks b ON b.chain_id=$1 AND b.genesis_hash=$2 AND b.height=f.height`, [...args, address])).rows[0];
      const series = (await client.query(`WITH firsts AS (
          SELECT e.commit_id, min(e.height) AS height FROM chain_forecast_decision_events e
          WHERE e.chain_id=$1 AND e.genesis_hash=$2 AND e.forecaster_address=$3 GROUP BY e.commit_id)
        SELECT to_char(date_trunc('day', b.block_time AT TIME ZONE 'UTC'), 'YYYY-MM-DD') AS day, count(*)::text AS forecasts
        FROM firsts f JOIN chain_reward_blocks b ON b.chain_id=$1 AND b.genesis_hash=$2 AND b.height=f.height
        WHERE b.block_time>=$4::timestamptz - interval '30 days' GROUP BY 1 ORDER BY 1`, [...args, address, header.asOf.time])).rows;
      const recent = (await client.query(`WITH firsts AS (
          SELECT e.commit_id, min(e.height) AS height, max(e.height) AS last_height, count(*)::text AS times_seen
          FROM chain_forecast_decision_events e WHERE e.chain_id=$1 AND e.genesis_hash=$2 AND e.forecaster_address=$3 GROUP BY e.commit_id)
        SELECT f.commit_id, f.height::text AS height, f.last_height::text AS last_height, f.times_seen,
          to_char(b.block_time AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS decided_at,
          e.station_id, e.provenance_class, e.skill_score, e.rmse, e.mae, e.bias, e.horizon_hours, e.variables
        FROM firsts f JOIN chain_reward_blocks b ON b.chain_id=$1 AND b.genesis_hash=$2 AND b.height=f.height
        JOIN chain_forecast_decision_events e ON e.chain_id=$1 AND e.genesis_hash=$2 AND e.commit_id=f.commit_id AND e.height=f.height
        ORDER BY f.height DESC, f.commit_id ASC LIMIT 20`, [...args, address])).rows;
      return { ...header, address, status: 'available', complete: true,
        totals: { forecasts: totals.forecasts, byProvenance: { real: totals.real, synthetic: totals.synthetic, unclassified: totals.unclassified },
          firstActiveAt: totals.first_at ?? null, lastActiveAt: totals.last_at ?? null,
          meanSkill: NOT_YET(SKILL_REASON), paid: NOT_YET(PAID_REASON) },
        skill: NOT_YET(SKILL_REASON), byVariable: [], byLead: [],
        series: series.map(r => ({ day: r.day, forecasts: r.forecasts, meanSkill: null })),
        recent: recent.map(r => ({ commitId: r.commit_id, blockHeight: r.height, lastHeight: r.last_height, timesSeen: r.times_seen,
          decidedAt: r.decided_at, stationId: r.station_id, provenanceClass: r.provenance_class,
          skill: r.skill_score ?? null, rmse: r.rmse ?? null, mae: r.mae ?? null, bias: r.bias ?? null,
          horizonHours: r.horizon_hours ?? null, variables: r.variables ?? null,
          receipt: r.skill_score === null || r.skill_score === undefined ? 'not_exposed' : 'present' })) };
    }),
    resolveAddress: async input => {
      if (/^0x[0-9a-fA-F]{40}$/.test(input)) return input.toLowerCase();
      if (!/^c_[0-9a-f]{24}$/.test(input)) return null;
      let client: Client | undefined;
      try {
        client = await pool.connect();
        const rows = (await client.query('SELECT DISTINCT forecaster_address FROM chain_forecast_decision_events WHERE chain_id=$1 AND genesis_hash=$2', args)).rows;
        for (const row of rows) if (profileKeyFor(row.forecaster_address) === input) return row.forecaster_address;
        return null;
      } catch { throw new ForecastStatsUnavailable(); } finally { client?.release(); }
    },
  };
}

let lazy: ForecasterStatsSource | null = null;
/** Production wiring: the same pool and chain identity the indexer uses; nothing is read while the flag is off. */
export function defaultForecasterStatsSource(): ForecasterStatsSource {
  const resolve = async (): Promise<ForecasterStatsSource> => {
    if (lazy) return lazy;
    const { pool } = await import('../../../database/db.js');
    const { profileKeyFor } = await import('../../utils/contributor-alias.js');
    const chain = process.env.CHAIN_REWARD_INDEX_CHAIN_ID ?? '', genesis = process.env.CHAIN_REWARD_INDEX_GENESIS_HASH ?? '';
    if (!/^[0-9]{1,20}$/.test(chain) || !/^[0-9a-f]{64}$/.test(genesis)) throw new ForecastStatsUnavailable();
    lazy = createForecasterStatsSource(pool as unknown as Pool, chain, genesis, Date.now, profileKeyFor);
    return lazy;
  };
  return {
    leaderboard: async (period, limit) => (await resolve()).leaderboard(period, limit),
    trackRecord: async address => (await resolve()).trackRecord(address),
    resolveAddress: async input => (await resolve()).resolveAddress(input),
  };
}
