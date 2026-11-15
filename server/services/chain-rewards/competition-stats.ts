/**
 * Weekly forecast competition (backend#251), points only.
 *
 * A competition is a named UTC calendar week (ISO week: Monday 00:00Z to the next Monday 00:00Z) over the
 * SAME rows /api/forecasters reads: the chain-rewards indexer's forecast decisions
 * (`chain_forecast_decision_events`, migration 0035). There is no second scorer and no submission path:
 * the chain verifies and scores every revealed forecast, and a forecast enters a week in the block where
 * its reward decision is first observed (readers group by commit_id and take min(height), as
 * forecaster-stats.ts does). Synthetic and unclassified forecasts never score.
 *
 * Points (rule `scored-forecasts-v1`): one point per real forecast the chain scored and decided in the
 * week. Ties go to whoever reached their total first (earlier last forecast), then by address. Skill is
 * not readable from any node route yet (forecaster-stats SKILL_REASON), so v1 does not weight by it; a
 * skill-weighted rule would be a new rule id, never a silent change to past weeks.
 *
 * No WRF and no stakes: prizes are points only (owner posture on games, 2026-10-03). Paid prizes would be
 * an on-chain Reward transaction, never a backend balance write.
 *
 * A week is `open` until it ends, `scoring` until the index has read a block at least FINALIZE_GRACE_MS
 * past the end, then `final`: the standings are frozen into `forecast_competitions` /
 * `forecast_competition_results` (migration 0036) with the block they were read through. That block is a
 * foreign key into chain_reward_blocks ON DELETE CASCADE, so a reorg rewind past it un-finalizes the week
 * and it is computed again from the replacement blocks.
 */
import type { Client, Pool } from './store.js';
import { ForecastStatsUnavailable, forecastersEnabled, withForecastSnapshot, type SnapshotHeader } from './forecaster-stats.js';

export const COMPETITION_RULE = {
  id: 'scored-forecasts-v1' as const,
  points: 'One point for each of your forecasts that the chain scored and decided a reward for during the week.',
  ties: 'Equal points: whoever reached the total first ranks higher.',
  prizes: 'Points only. No WRF is paid and nothing is staked.',
  week: 'Weeks run Monday 00:00 UTC to the next Monday 00:00 UTC, by block time.',
};
/** The index must have read a block this long past the week's end before the week is frozen. */
export const FINALIZE_GRACE_MS = 60 * 60 * 1000;
export const MAX_STORED_ROWS = 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const competitionsEnabled = () => forecastersEnabled() && process.env.FORECAST_COMPETITIONS_ENABLED === 'true';

export type CompetitionStatus = 'open' | 'scoring' | 'final';
export interface CompetitionWeek { week: string; from: string; until: string }
export interface StandingRow { rank: number; address: string; points: string; forecasts: string; firstAt: string; lastAt: string }
export interface Standings {
  competition: CompetitionWeek & {
    title: string; status: CompetitionStatus; rule: typeof COMPETITION_RULE;
    final: { finalizedAt: string; throughHeight: string; throughHash: string } | null;
  };
  asOf: SnapshotHeader['asOf'] | null;
  coverage: SnapshotHeader['coverage'] | null;
  entrants: number; forecasts: string;
  rows: StandingRow[];
}
export interface WeekSummary extends CompetitionWeek {
  title: string; status: CompetitionStatus; entrants: number | null; forecasts: string | null;
  leaders: StandingRow[];
}
export interface CompetitionSource {
  /** Standings for one week label, or null when the week is in the future or before the chain began. */
  standings(week: string): Promise<Standings | null>;
  /** The current week plus up to `weeks - 1` earlier ones (never before the chain's first block). */
  recent(weeks: number): Promise<{ current: string; weeks: WeekSummary[] }>;
  currentWeek(): string;
}

// ── ISO week arithmetic (UTC) ─────────────────────────────────────────────

/** Monday 00:00Z of the ISO week containing `ms`. */
export function weekStart(ms: number): number {
  const day = new Date(ms);
  const midnight = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate());
  const dow = (day.getUTCDay() + 6) % 7; // Monday = 0
  return midnight - dow * DAY_MS;
}

/** ISO-8601 week label (`2026-W44`) for the week containing `ms`; the year is the Thursday's year. */
export function weekLabel(ms: number): string {
  const monday = weekStart(ms);
  const thursday = new Date(monday + 3 * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan4 = Date.UTC(year, 0, 4);
  const week1 = weekStart(jan4);
  const n = Math.round((monday - week1) / WEEK_MS) + 1;
  return `${year}-W${String(n).padStart(2, '0')}`;
}

/** Monday 00:00Z for a label, or null when the label is not a real ISO week. */
export function parseWeek(label: string): number | null {
  const m = /^([0-9]{4})-W([0-9]{2})$/.exec(label);
  if (!m) return null;
  const year = Number(m[1]), n = Number(m[2]);
  if (year < 2000 || year > 9999 || n < 1 || n > 53) return null;
  const start = weekStart(Date.UTC(year, 0, 4)) + (n - 1) * WEEK_MS;
  return weekLabel(start) === label ? start : null;
}

export function weekWindow(label: string): CompetitionWeek | null {
  const start = parseWeek(label);
  if (start === null) return null;
  return { week: label, from: new Date(start).toISOString(), until: new Date(start + WEEK_MS).toISOString() };
}

export const weekTitle = (label: string) => `Week ${Number(label.slice(6))}, ${label.slice(0, 4)} forecast competition`;

// ── Read model ────────────────────────────────────────────────────────────

const TS = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;

/** Every forecaster's points in [from, until), ranked. Same first-observation rule as /api/forecasters. */
async function computeRows(client: Client, args: string[], from: string, until: string): Promise<StandingRow[]> {
  const rows = (await client.query(`WITH firsts AS (
      SELECT e.commit_id, e.forecaster_address, min(e.height) AS height
      FROM chain_forecast_decision_events e
      WHERE e.chain_id=$1 AND e.genesis_hash=$2 AND e.provenance_class='real'
      GROUP BY e.commit_id, e.forecaster_address),
    timed AS (
      SELECT f.forecaster_address, b.block_time
      FROM firsts f JOIN chain_reward_blocks b ON b.chain_id=$1 AND b.genesis_hash=$2 AND b.height=f.height
      WHERE b.block_time>=$3::timestamptz AND b.block_time<$4::timestamptz)
    SELECT forecaster_address, count(*)::text AS forecasts,
      to_char(min(block_time) AT TIME ZONE 'UTC', ${TS}) AS first_at,
      to_char(max(block_time) AT TIME ZONE 'UTC', ${TS}) AS last_at
    FROM timed GROUP BY forecaster_address
    ORDER BY count(*) DESC, max(block_time) ASC, forecaster_address ASC`, [...args, from, until])).rows;
  return rows.map((r: any, i: number) => ({
    rank: i + 1, address: r.forecaster_address, points: r.forecasts, forecasts: r.forecasts, firstAt: r.first_at, lastAt: r.last_at,
  }));
}

const sumForecasts = (rows: StandingRow[]) => rows.reduce((n, r) => n + BigInt(r.forecasts), 0n).toString();

export function createCompetitionSource(pool: Pool, chain: string, genesis: string, clock = () => Date.now()): CompetitionSource {
  const args = [chain, genesis];

  async function readFinal(week: string): Promise<{ meta: any; rows: StandingRow[] } | null> {
    let client: Client | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const meta = (await client.query(`SELECT through_height::text AS through_height, through_hash, entrants, forecasts::text AS forecasts,
          to_char(finalized_at AT TIME ZONE 'UTC', ${TS}) AS finalized_at
        FROM forecast_competitions WHERE chain_id=$1 AND genesis_hash=$2 AND week_label=$3`, [...args, week])).rows[0];
      if (!meta) { await client.query('COMMIT'); return null; }
      const rows = (await client.query(`SELECT rank, forecaster_address, points::text AS points, forecasts::text AS forecasts,
          to_char(first_at AT TIME ZONE 'UTC', ${TS}) AS first_at, to_char(last_at AT TIME ZONE 'UTC', ${TS}) AS last_at
        FROM forecast_competition_results WHERE chain_id=$1 AND genesis_hash=$2 AND week_label=$3 ORDER BY rank`, [...args, week])).rows;
      await client.query('COMMIT');
      return { meta, rows: rows.map((r: any) => ({ rank: r.rank, address: r.forecaster_address, points: r.points, forecasts: r.forecasts, firstAt: r.first_at, lastAt: r.last_at })) };
    } catch {
      if (client) { try { await client.query('ROLLBACK'); } catch {} }
      throw new ForecastStatsUnavailable();
    } finally { client?.release(); }
  }

  /** Freeze a week. Idempotent: a concurrent or earlier freeze wins and this one writes nothing. */
  async function freeze(week: CompetitionWeek, header: SnapshotHeader, rows: StandingRow[]): Promise<void> {
    let client: Client | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      const inserted = (await client.query(`INSERT INTO forecast_competitions
          (chain_id, genesis_hash, week_label, starts_at, ends_at, rule_id, through_height, through_hash, entrants, forecasts)
        VALUES ($1,$2,$3,$4::timestamptz,$5::timestamptz,$6,$7::bigint,$8,$9,$10::bigint)
        ON CONFLICT DO NOTHING RETURNING week_label`,
      [...args, week.week, week.from, week.until, COMPETITION_RULE.id, header.asOf.height, header.asOf.hash, rows.length, sumForecasts(rows)])).rows;
      if (inserted.length === 1) {
        for (const r of rows.slice(0, MAX_STORED_ROWS)) {
          await client.query(`INSERT INTO forecast_competition_results
              (chain_id, genesis_hash, week_label, rank, forecaster_address, points, forecasts, first_at, last_at)
            VALUES ($1,$2,$3,$4,$5,$6::bigint,$7::bigint,$8::timestamptz,$9::timestamptz)`,
          [...args, week.week, r.rank, r.address, r.points, r.forecasts, r.firstAt, r.lastAt]);
        }
      }
      await client.query('COMMIT');
    } catch {
      // A failed freeze (e.g. the read-through block was just rewound) leaves the week `scoring`; the
      // next read tries again. It never turns a good live answer into an error.
      if (client) { try { await client.query('ROLLBACK'); } catch {} }
    } finally { client?.release(); }
  }

  function finalStandings(window: CompetitionWeek, stored: { meta: any; rows: StandingRow[] }): Standings {
    return {
      competition: { ...window, title: weekTitle(window.week), status: 'final', rule: COMPETITION_RULE,
        final: { finalizedAt: stored.meta.finalized_at, throughHeight: stored.meta.through_height, throughHash: stored.meta.through_hash } },
      asOf: null, coverage: null,
      entrants: Number(stored.meta.entrants), forecasts: stored.meta.forecasts, rows: stored.rows,
    };
  }

  async function standings(week: string): Promise<Standings | null> {
    const window = weekWindow(week);
    if (!window) return null;
    const now = clock();
    if (Date.parse(window.from) > now) return null;
    const stored = await readFinal(week);
    if (stored) return finalStandings(window, stored);
    const live = await withForecastSnapshot(pool, chain, genesis, clock, async (client, header) => {
      const genesisTime = (await client.query(`SELECT to_char(block_time AT TIME ZONE 'UTC', ${TS}) AS t FROM chain_reward_blocks
        WHERE chain_id=$1 AND genesis_hash=$2 AND height=1`, args)).rows[0]?.t;
      if (!genesisTime || Date.parse(window.until) <= Date.parse(genesisTime)) return null;
      return { header, rows: await computeRows(client, args, window.from, window.until) };
    });
    if (!live) return null;
    const ended = Date.parse(window.until) <= now;
    const indexedPast = Date.parse(live.header.asOf.time) >= Date.parse(window.until) + FINALIZE_GRACE_MS;
    if (ended && indexedPast) {
      await freeze(window, live.header, live.rows);
      const frozen = await readFinal(week);
      if (frozen) return finalStandings(window, frozen);
    }
    return {
      competition: { ...window, title: weekTitle(week), status: ended ? 'scoring' : 'open', rule: COMPETITION_RULE, final: null },
      asOf: live.header.asOf, coverage: live.header.coverage,
      entrants: live.rows.length, forecasts: sumForecasts(live.rows), rows: live.rows,
    };
  }

  async function recent(weeks: number): Promise<{ current: string; weeks: WeekSummary[] }> {
    const current = weekLabel(clock());
    const out: WeekSummary[] = [];
    let start = weekStart(clock());
    for (let i = 0; i < weeks; i++, start -= WEEK_MS) {
      const label = weekLabel(start);
      const s = await standings(label);
      if (!s) break; // before the chain's first block: nothing earlier exists either
      out.push({ week: label, from: s.competition.from, until: s.competition.until, title: s.competition.title,
        status: s.competition.status, entrants: s.entrants, forecasts: s.forecasts, leaders: s.rows.slice(0, 3) });
    }
    return { current, weeks: out };
  }

  return { standings, recent, currentWeek: () => weekLabel(clock()) };
}

let lazy: CompetitionSource | null = null;
/** Production wiring: the indexer's pool and chain identity; nothing is read while the flags are off. */
export function defaultCompetitionSource(): CompetitionSource {
  const resolve = async (): Promise<CompetitionSource> => {
    if (lazy) return lazy;
    const { pool } = await import('../../../database/db.js');
    const chain = process.env.CHAIN_REWARD_INDEX_CHAIN_ID ?? '', genesis = process.env.CHAIN_REWARD_INDEX_GENESIS_HASH ?? '';
    if (!/^[0-9]{1,20}$/.test(chain) || !/^[0-9a-f]{64}$/.test(genesis)) throw new ForecastStatsUnavailable();
    lazy = createCompetitionSource(pool as unknown as Pool, chain, genesis);
    return lazy;
  };
  return {
    standings: async week => (await resolve()).standings(week),
    recent: async weeks => (await resolve()).recent(weeks),
    currentWeek: () => weekLabel(Date.now()),
  };
}
