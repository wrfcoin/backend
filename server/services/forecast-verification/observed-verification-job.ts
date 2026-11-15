/**
 * Background job for observed forecast verification (observed-verification.ts).
 *
 * OFF unless FORECAST_VERIFICATION_ENABLED=true. Every FORECAST_VERIFICATION_INTERVAL_MS (default 5 min,
 * at least 60 s) it scores pending records; once per UTC hour it captures NOAA's hourly forecast for the
 * stations forecasters target (FORECAST_VERIFICATION_NOAA_REFERENCE=false turns that half off).
 * Logs carry counts only, never station ids, coordinates or upstream text.
 */
import type { Core4Get } from '../forecast-commit-record.js';
import { captureNoaaReferences, scorePending, HOUR_S, type HourlyForecastSource, type Query } from './observed-verification.js';

export const forecastVerificationEnabled = () => process.env.FORECAST_VERIFICATION_ENABLED === 'true';
const DEFAULT_INTERVAL_MS = 5 * 60_000;
const CALL_TIMEOUT_MS = 5_000;

type Logger = { info: (m: string, meta?: object) => void; warn: (m: string, meta?: object) => void };

export interface ForecastVerificationJobDeps {
  query?: Query;
  get?: Core4Get;
  noaa?: HourlyForecastSource;
  now?: () => number;
  logger?: Logger;
}

export async function defaultQuery(): Promise<Query> {
  const { pool } = await import('../../../database/db.js');
  return (sql, params) => pool.query(sql, params ?? []) as Promise<{ rows: any[] }>;
}

/** Node GET with the backend Reader credential only; no caller header ever reaches the node. */
export async function defaultCore4Get(): Promise<Core4Get> {
  const { fetchCore4Json } = await import('../../../shared/core4-route-client.js');
  return async (path, query) => {
    const token = process.env.WRFCOIN_READER_TOKEN?.trim();
    if (!token) throw new Error('reader credential unset');
    return fetchCore4Json(path, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      timeoutMs: CALL_TIMEOUT_MS,
      ...(query ? { query } : {}),
    }) as Promise<{ ok: boolean; status: number; payload: any }>;
  };
}

/** NOAA's NWS client (a CommonJS module; the build ships it as .js and .cjs). */
async function defaultNoaa(): Promise<HourlyForecastSource> {
  const mod: any = await import('../noaa-nws-api-service.js');
  const NOAAWeatherService = mod.default ?? mod;
  return new NOAAWeatherService();
}

export async function runForecastVerificationTick(deps: Required<Omit<ForecastVerificationJobDeps, 'logger'>> & { logger?: Logger }, state: { lastCaptureHour: number }) {
  const nowSec = Math.floor(deps.now() / 1000);
  const hour = Math.floor(nowSec / HOUR_S);
  if (process.env.FORECAST_VERIFICATION_NOAA_REFERENCE !== 'false' && hour !== state.lastCaptureHour) {
    state.lastCaptureHour = hour;
    try {
      const c = await captureNoaaReferences(deps.query, deps.noaa, nowSec);
      deps.logger?.info('forecast verification: NOAA reference capture', c);
    } catch {
      deps.logger?.warn('forecast verification: NOAA reference capture failed (details withheld)');
    }
  }
  try {
    const giveUp = Number(process.env.FORECAST_VERIFICATION_GIVE_UP_HOURS);
    const s = await scorePending({ query: deps.query, get: deps.get, nowSec, ...(Number.isInteger(giveUp) && giveUp >= 2 && giveUp <= 72 ? { giveUpHours: giveUp } : {}) });
    if (s.scored + s.unavailable + s.retry > 0) deps.logger?.info('forecast verification: scoring pass', s);
  } catch {
    deps.logger?.warn('forecast verification: scoring pass failed (details withheld)');
  }
}

export async function startForecastVerificationJob(deps: ForecastVerificationJobDeps = {}): Promise<boolean> {
  if (!forecastVerificationEnabled()) return false;
  const raw = Number(process.env.FORECAST_VERIFICATION_INTERVAL_MS);
  const interval = Number.isInteger(raw) && raw >= 60_000 ? raw : DEFAULT_INTERVAL_MS;
  const resolved = {
    query: deps.query ?? await defaultQuery(),
    get: deps.get ?? await defaultCore4Get(),
    noaa: deps.noaa ?? await defaultNoaa(),
    now: deps.now ?? Date.now,
    logger: deps.logger,
  };
  const state = { lastCaptureHour: -1 };
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try { await runForecastVerificationTick(resolved, state); } finally { running = false; }
  };
  setTimeout(() => { void tick(); }, 30_000).unref?.();
  setInterval(() => { void tick(); }, interval).unref?.();
  deps.logger?.info('forecast verification job started', { intervalMs: interval });
  return true;
}
