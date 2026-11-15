/**
 * Counting job for friend challenges (services/friend-challenges.ts countPass). OFF unless
 * FRIEND_CHALLENGES_ENABLED=true. Every FRIEND_CHALLENGES_INTERVAL_MS (default 2 min, at least 30 s) it
 * scans the chain readings of participants' stations with the backend Reader credential and recounts.
 * Logs carry counts only, never station ids or addresses.
 */
import { countPass, friendChallengesEnabled, type Core4Get, type Query } from './friend-challenges.js';

const DEFAULT_INTERVAL_MS = 2 * 60_000;
type Logger = { info: (m: string, meta?: object) => void; warn: (m: string, meta?: object) => void };

export async function startFriendChallengesJob(deps: { query?: Query; get?: Core4Get; logger?: Logger; now?: () => number } = {}): Promise<boolean> {
  if (!friendChallengesEnabled()) return false;
  const raw = Number(process.env.FRIEND_CHALLENGES_INTERVAL_MS);
  const interval = Number.isInteger(raw) && raw >= 30_000 ? raw : DEFAULT_INTERVAL_MS;
  const query: Query = deps.query ?? await (async () => {
    const { pool } = await import('../../database/db.js');
    return (sql: string, params?: unknown[]) => pool.query(sql, params ?? []) as Promise<{ rows: any[] }>;
  })();
  const get: Core4Get = deps.get ?? await (async () => {
    const { fetchCore4Json } = await import('../../shared/core4-route-client.js');
    return async (path: string, q?: Record<string, unknown>) => {
      const token = process.env.WRFCOIN_READER_TOKEN?.trim();
      if (!token) throw new Error('reader credential unset');
      return fetchCore4Json(path, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, timeoutMs: 5_000, ...(q ? { query: q } : {}) }) as Promise<{ ok: boolean; status: number; payload: any }>;
    };
  })();
  const now = deps.now ?? Date.now;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await countPass({ query, get, nowMs: now() });
      if (r.stations + r.completed > 0) deps.logger?.info('friend challenges: counting pass', r);
    } catch {
      deps.logger?.warn('friend challenges: counting pass failed (details withheld)');
    } finally { running = false; }
  };
  setTimeout(() => { void tick(); }, 20_000).unref?.();
  setInterval(() => { void tick(); }, interval).unref?.();
  deps.logger?.info('friend challenges job started', { intervalMs: interval });
  return true;
}
