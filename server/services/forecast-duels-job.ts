/**
 * Resolver job for free-play forecast duels (services/forecast-duels.ts resolvePass). OFF unless
 * FORECAST_DUELS_ENABLED=true. Every FORECAST_DUELS_INTERVAL_MS (default 5 min, at least 60 s) it voids
 * unaccepted duels past their lock and judges matched duels past their target hour from the chain's
 * finalized forecast rewards. Logs carry counts only.
 */
import { duelsEnabled, resolvePass, type Core4Get, type Query } from './forecast-duels.js';

const DEFAULT_INTERVAL_MS = 5 * 60_000;
type Logger = { info: (m: string, meta?: object) => void; warn: (m: string, meta?: object) => void };

export async function startForecastDuelsJob(deps: { query?: Query; get?: Core4Get; logger?: Logger; now?: () => number } = {}): Promise<boolean> {
  if (!duelsEnabled()) return false;
  const raw = Number(process.env.FORECAST_DUELS_INTERVAL_MS);
  const interval = Number.isInteger(raw) && raw >= 60_000 ? raw : DEFAULT_INTERVAL_MS;
  const query: Query = deps.query ?? await (async () => {
    const { pool } = await import('../../database/db.js');
    return (sql: string, params?: unknown[]) => pool.query(sql, params ?? []) as Promise<{ rows: any[] }>;
  })();
  const get: Core4Get = deps.get ?? await (await import('../routes/duel-routes.js')).defaultDuelCore4Get();
  const now = deps.now ?? Date.now;
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const r = await resolvePass({ query, get, nowMs: now() });
      if (r.voided + r.resolved + r.failed > 0) deps.logger?.info('forecast duels: resolver pass', r);
    } catch {
      deps.logger?.warn('forecast duels: resolver pass failed (details withheld)');
    } finally { running = false; }
  };
  setTimeout(() => { void tick(); }, 40_000).unref?.();
  setInterval(() => { void tick(); }, interval).unref?.();
  deps.logger?.info('forecast duels job started', { intervalMs: interval });
  return true;
}
