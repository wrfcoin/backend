/**
 * Usage counts for the operator: how many people are actually using testnet.
 *
 *   GET /api/admin/usage-counts   (operator bearer token only)
 *
 * The response is counts only. It never carries an address, a station id, a
 * coordinate or a per-user row: every query below is an aggregate, and the
 * response is built from named numeric fields, never from a spread of a DB row.
 *
 * Sections (each one is read on its own; a section whose table is missing or
 * unreadable comes back as null and is named in `unavailable`, the rest still
 * answer):
 *   wallets        - wallets the backend has seen (a row is written on wallet login)
 *   phoneStations  - per-phone station registrations by activation status
 *   contributions  - settled chain contributions per UTC day (last 14 days) from
 *                    the chain reward index; one row per contributor per block
 *   returners      - contributors active this week, last week, and in both
 *   stationReadings- weather_data rows per UTC day (readings the backend stores
 *                    for registered provider stations; phone readings go to the
 *                    chain, not this table)
 */

import { Router } from 'express';
import type { NextFunction, Request, Response, RequestHandler } from 'express';

// CJS operator-token middleware, typed inline (same as the email gateway route).
const { requireOperatorToken } = require('../middleware/operator-token-auth.js') as {
  requireOperatorToken: (req: Request, res: Response, next: NextFunction) => void;
};

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type RewardChain = { chainId: string; genesis: string };

export interface UsageCountsDeps {
  db?: DbExecutor;
  rewardChain?: () => RewardChain | null;
  now?: () => number;
  auth?: RequestHandler;
}

export const USAGE_DAYS = 14;
const CACHE_TTL_MS = 60_000;

function defaultRewardChain(): RewardChain | null {
  const chainId = process.env.CHAIN_REWARD_INDEX_CHAIN_ID;
  const genesis = process.env.CHAIN_REWARD_INDEX_GENESIS_HASH;
  return chainId && genesis ? { chainId, genesis } : null;
}

function defaultDb(): DbExecutor {
  let executeQuery: DbExecutor['execute'] | null = null;
  return {
    execute: async (sql, params) => {
      if (!executeQuery) {
        const mod = await import('../../database/index.js');
        executeQuery = mod.executeQuery as DbExecutor['execute'];
      }
      return executeQuery!(sql, params);
    },
  };
}

function count(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
}

function dayString(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)) return value.slice(0, 10);
  return null;
}

/** Every UTC date from (today - days + 1) to today, oldest first. */
export function lastUtcDays(nowMs: number, days: number): string[] {
  const today = Date.UTC(
    new Date(nowMs).getUTCFullYear(),
    new Date(nowMs).getUTCMonth(),
    new Date(nowMs).getUTCDate(),
  );
  const out: string[] = [];
  for (let i = days - 1; i >= 0; i -= 1) {
    out.push(new Date(today - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

async function readWallets(db: DbExecutor) {
  const { rows } = await db.execute(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days') AS new_7d,
            COUNT(*) FILTER (WHERE last_updated >= now() - interval '7 days') AS seen_7d
       FROM wallets`,
  );
  const r = rows[0] ?? {};
  return { total: count(r.total), newLast7Days: count(r.new_7d), seenLast7Days: count(r.seen_7d) };
}

async function readPhoneStations(db: DbExecutor) {
  const { rows } = await db.execute(
    `SELECT COUNT(*) AS total,
            COUNT(*) FILTER (WHERE status = 'db_only') AS waiting,
            COUNT(*) FILTER (WHERE status = 'submitted') AS submitted,
            COUNT(*) FILTER (WHERE status = 'on_chain') AS on_chain,
            COUNT(*) FILTER (WHERE created_at >= now() - interval '7 days') AS new_7d
       FROM mobile_station_registrations`,
  );
  const r = rows[0] ?? {};
  return {
    registered: count(r.total),
    waitingForActivation: count(r.waiting),
    submitted: count(r.submitted),
    active: count(r.on_chain),
    newLast7Days: count(r.new_7d),
  };
}

async function readContributions(db: DbExecutor, chain: RewardChain, days: string[]) {
  const params = [chain.chainId, chain.genesis, days[0]];
  const [perDay, complete] = await Promise.all([
    db.execute(
      `SELECT day, COUNT(*) AS settled, COUNT(DISTINCT contributor_address) AS contributors
         FROM chain_contribution_payees
        WHERE chain_id = $1 AND genesis_hash = $2 AND day >= $3::date
        GROUP BY day`,
      params,
    ),
    db.execute(
      `SELECT NOT EXISTS (
          SELECT 1 FROM chain_reward_blocks
           WHERE chain_id = $1 AND genesis_hash = $2 AND NOT contribution_scanned
        ) AS complete`,
      [chain.chainId, chain.genesis],
    ),
  ]);
  const byDay = new Map<string, { settled: number; contributors: number }>();
  for (const row of perDay.rows) {
    const day = dayString(row.day);
    if (day) byDay.set(day, { settled: count(row.settled), contributors: count(row.contributors) });
  }
  return {
    indexComplete: complete.rows[0]?.complete === true,
    perDay: days.map((day) => ({
      day,
      settledContributions: byDay.get(day)?.settled ?? 0,
      contributors: byDay.get(day)?.contributors ?? 0,
    })),
  };
}

async function readReturners(db: DbExecutor, chain: RewardChain, days: string[]) {
  // days has 14 entries: [0..6] = last week, [7..13] = this week (UTC dates).
  const { rows } = await db.execute(
    `WITH weeks AS (
        SELECT contributor_address,
               bool_or(day >= $4::date) AS this_week,
               bool_or(day <  $4::date) AS last_week
          FROM chain_contribution_payees
         WHERE chain_id = $1 AND genesis_hash = $2 AND day >= $3::date
         GROUP BY contributor_address
      )
      SELECT COUNT(*) FILTER (WHERE this_week) AS this_week,
             COUNT(*) FILTER (WHERE last_week) AS last_week,
             COUNT(*) FILTER (WHERE this_week AND last_week) AS returned
        FROM weeks`,
    [chain.chainId, chain.genesis, days[0], days[7]],
  );
  const r = rows[0] ?? {};
  return {
    activeThisWeek: count(r.this_week),
    activeLastWeek: count(r.last_week),
    returnedFromLastWeek: count(r.returned),
  };
}

async function readStationReadings(db: DbExecutor, days: string[]) {
  const { rows } = await db.execute(
    `SELECT ("timestamp" AT TIME ZONE 'UTC')::date AS day, COUNT(*) AS readings
       FROM weather_data
      WHERE "timestamp" >= $1::date
      GROUP BY 1`,
    [days[0]],
  );
  const byDay = new Map<string, number>();
  for (const row of rows) {
    const day = dayString(row.day);
    if (day) byDay.set(day, count(row.readings));
  }
  return days.map((day) => ({ day, readings: byDay.get(day) ?? 0 }));
}

export async function readUsageCounts(db: DbExecutor, chain: RewardChain | null, nowMs: number) {
  const days = lastUtcDays(nowMs, USAGE_DAYS);
  const unavailable: string[] = [];
  const section = async <T>(name: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch {
      unavailable.push(name);
      return null;
    }
  };
  const noChain = async (): Promise<never> => {
    throw new Error('chain reward index not configured');
  };
  const [wallets, phoneStations, contributions, returners, stationReadings] = await Promise.all([
    section('wallets', () => readWallets(db)),
    section('phoneStations', () => readPhoneStations(db)),
    section('contributions', () => (chain ? readContributions(db, chain, days) : noChain())),
    section('returners', () => (chain ? readReturners(db, chain, days) : noChain())),
    section('stationReadings', () => readStationReadings(db, days)),
  ]);
  return {
    generatedAt: new Date(nowMs).toISOString(),
    days: USAGE_DAYS,
    wallets,
    phoneStations,
    contributions,
    returners,
    stationReadings,
    unavailable: unavailable.sort(),
  };
}

export function createUsageCountsRouter(deps: UsageCountsDeps = {}): Router {
  const router = Router();
  const db = deps.db ?? defaultDb();
  const rewardChain = deps.rewardChain ?? defaultRewardChain;
  const now = deps.now ?? Date.now;
  const auth = deps.auth ?? requireOperatorToken;
  let cache: { expiresAt: number; value: Promise<unknown> } | null = null;

  router.get('/', auth, async (_req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    const at = now();
    if (!cache || cache.expiresAt <= at) {
      const value = readUsageCounts(db, rewardChain(), at);
      cache = { expiresAt: at + CACHE_TTL_MS, value };
      value.catch(() => {
        cache = null;
      });
    }
    try {
      res.json({ success: true, data: await cache.value });
    } catch {
      res.status(503).json({ success: false, error: 'Usage counts are unavailable right now.' });
    }
  });

  return router;
}

export default createUsageCountsRouter();
