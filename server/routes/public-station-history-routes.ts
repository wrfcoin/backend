/**
 * Public station history read (lead brief 2026-11-13; DECISIONS "Skill pay before scheduling", item 3).
 *
 *   GET /api/public/station-history/:alias?fromHeight=<h>[&toHeight=<h>][&after=<h>&offset=<n>][&limit=<n>]
 *
 * Past chain readings of ONE station over a bounded block-height window, without the Reader role.
 * The skill-pay margin backtest needs real station history; the node's history read
 * (core4 GET /transactions/contributions/{station}/observations) needs a Reader bearer. This route
 * reads it with the backend's own Reader credential, the same way /api/public/balance does
 * (owner ruling 2026-10-28 (b): public, read-only, rate-limited).
 *
 * Shape:
 *   - The station is addressed by its public alias only (st_ + 12 hex; owner ruling 2026-09-27 Q5).
 *     A raw station id is 404 for everyone, and the raw id never appears in a response.
 *   - The window is a block-height range [fromHeight, toHeight], at most HISTORY_MAX_WINDOW_HEIGHTS
 *     heights long (~30 days at ~77 s/block). `toHeight` defaults to the longest allowed window.
 *     Readings are returned in ascending height order.
 *   - Paging: copy `next.after` / `next.offset` into the next request with the same window. `next` is
 *     null once the window is fully scanned (or the scan reached the chain tip: compare `chainHeight`
 *     with `window.toHeight` and come back later for the rest).
 *   - Each reading: height, observedAt (unix s), the node's numeric allowlist (temperature, humidity,
 *     pressure, wind speed, precipitation, dew point), provenance class and the attestation count with
 *     its quorum verdict. No commit id, no owner, no payload metadata.
 *   - `station.latitude` / `station.longitude` are rounded to 0.1 degree (owner ruling 2026-10-01 /
 *     2026-11-05). Nothing finer leaves this route.
 *
 * Dormant unless PUBLIC_STATION_HISTORY_READ_ENABLED=true (read per request; 404 otherwise).
 *
 * Load on the node is bounded for the whole process (same discipline as public-balance-routes):
 *   - one request makes at most HISTORY_MAX_UPSTREAM_PAGES node reads (each scans at most 64
 *     heights in core4), so one request covers at most 512 heights;
 *   - node reads are capped process-wide at PUBLIC_STATION_HISTORY_UPSTREAM_MAX_PER_MIN (default 120,
 *     at most 400) per fixed minute. When the budget runs out mid-request the readings so far are
 *     returned with a cursor; when nothing could be read the answer is 503 with Retry-After;
 *   - per caller: 30 requests per minute per client address (shared Redis limiter, Retry-After on 429).
 * A caller credential is never forwarded, upstream text is never relayed, and this route logs nothing.
 */
import express, { type Request, type RequestHandler, type Response } from 'express';
import { isStationAlias, resolveStationAlias, scrubRawId as scrubRawIdImpl } from '../utils/station-alias.js';
import { coarsenCoordinate as coarsenCoordinateImpl } from '../utils/anonymous-projection.js';

const scrubRawId = scrubRawIdImpl as <T>(value: T, rawId: string) => T;
const coarsenCoordinate = coarsenCoordinateImpl as (value: unknown) => number | null;

type Row = Record<string, any>;
type Core4Response = { ok: boolean; status: number; payload: any };
export type Core4Fetch = (path: string, options?: Record<string, unknown>) => Promise<Core4Response>;
export type DbQuery = (sql: string, params: unknown[]) => Promise<Row[]>;

export interface PublicStationHistoryDeps {
  fetchCore4Json?: Core4Fetch;
  readerToken?: () => string | undefined;
  now?: () => number;
  /** Runs a parameterised SELECT and returns its rows (alias lookup + coordinates). */
  query?: DbQuery;
  /** `undefined` resolves the shared Redis limiter lazily. There is no "off" value: a missing limiter fails closed. */
  rateLimit?: RequestHandler;
}

export const PUBLIC_STATION_HISTORY_RATE_LIMIT = {
  windowMs: 60 * 1000,
  maxRequests: 30,
  keyPrefix: 'ratelimit:public-station-history',
};
/** ~30 days at the chain's ~77 s block cadence (30 * 86400 / 77 = 33,662). */
export const HISTORY_MAX_WINDOW_HEIGHTS = 33_600;
/** Node reads one request may make (core4 scans at most 64 heights per read). */
export const HISTORY_MAX_UPSTREAM_PAGES = 8;
export const HISTORY_DEFAULT_LIMIT = 200;
export const HISTORY_MAX_LIMIT = 500;
/** core4 get_station_observations clamps `limit` to 1..100. */
const UPSTREAM_PAGE_LIMIT = 100;
export const PUBLIC_STATION_HISTORY_UPSTREAM_WINDOW_MS = 60_000;
const DEFAULT_UPSTREAM_MAX_PER_MIN = 120;
const MAX_UPSTREAM_MAX_PER_MIN = 400;

const HEIGHT_RE = /^(0|[1-9][0-9]{0,14})$/;
const PROVENANCE = new Set(['real', 'synthetic', 'unclassified']);
const ALLOWED_QUERY_KEYS = new Set(['fromHeight', 'toHeight', 'after', 'offset', 'limit']);

const enabled = () => process.env.PUBLIC_STATION_HISTORY_READ_ENABLED === 'true';
/** Process-wide node reads per minute: a positive integer up to 400, else the default 120. */
export function upstreamMaxPerMinute(): number {
  const raw = process.env.PUBLIC_STATION_HISTORY_UPSTREAM_MAX_PER_MIN?.trim() ?? '';
  const value = /^[1-9][0-9]{0,5}$/.test(raw) ? Number(raw) : DEFAULT_UPSTREAM_MAX_PER_MIN;
  return Math.min(value, MAX_UPSTREAM_MAX_PER_MIN);
}

const notFound = (res: Response) => res.status(404).json({ error: 'Not found' });
const fail = (res: Response, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

async function defaultRateLimit(): Promise<RequestHandler> {
  const mod = await import('../../shared/middleware/rate-limit-redis.js');
  return mod.createRateLimitMiddleware({
    ...PUBLIC_STATION_HISTORY_RATE_LIMIT,
    keyGenerator: mod.apiIpBudgetKey,
    message: 'Too many station history requests, please try again later.',
  });
}

async function defaultFetch(): Promise<Core4Fetch> {
  const { fetchCore4Json } = await import('../../shared/core4-route-client.js');
  return fetchCore4Json as unknown as Core4Fetch;
}

async function defaultQuery(): Promise<DbQuery> {
  const mod = await import('../../database/index.js');
  return async (sql, params) => (await mod.executeQuery(sql, params)).rows as Row[];
}

const isTimeout = (error: unknown) => {
  const e = error as { name?: string; code?: string } | null;
  return e?.name === 'AbortError' || e?.name === 'TimeoutError' || e?.code === 'ETIMEDOUT';
};

const finiteOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null;
const heightOrNull = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

export type HistoryReading = {
  height: number;
  observedAt: number | null;
  temperatureC: number | null;
  humidityPct: number | null;
  pressureHpa: number | null;
  windSpeedMs: number | null;
  precipitationMm: number | null;
  dewpointC: number | null;
  provenanceClass: string | null;
  attestation: { approvals: number; hasQuorum: boolean } | null;
};

/** Explicit allowlist with validated types: nothing from the node is passed through structurally. */
function reading(item: Row): HistoryReading | null {
  const height = heightOrNull(item?.height);
  if (height === null) return null;
  const values = item.values && typeof item.values === 'object' ? item.values as Row : {};
  const a = item.attestation && typeof item.attestation === 'object' ? item.attestation as Row : null;
  const approvals = a && Number.isSafeInteger(a.approvals) && a.approvals >= 0 ? a.approvals as number : null;
  const hasQuorum = a && typeof a.has_quorum === 'boolean' ? a.has_quorum : null;
  return {
    height,
    observedAt: heightOrNull(item.observed_at),
    temperatureC: finiteOrNull(values.temperature_c),
    humidityPct: finiteOrNull(values.humidity_percent),
    pressureHpa: finiteOrNull(values.pressure_hpa),
    windSpeedMs: finiteOrNull(values.wind_speed_ms),
    precipitationMm: finiteOrNull(values.precipitation_mm),
    dewpointC: finiteOrNull(values.dewpoint_c),
    provenanceClass: typeof item.provenance_class === 'string' && PROVENANCE.has(item.provenance_class)
      ? item.provenance_class : null,
    attestation: approvals !== null && hasQuorum !== null ? { approvals, hasQuorum } : null,
  };
}

type Window = { items: Row[]; nextAfter: number; nextOffset: number; hasMore: boolean; chainHeight: number };
/** core4 launch_api get_station_observations, wrapped by envelope_success as {ok, data}. */
function core4Window(payload: any): Window | null {
  const data = payload?.ok === true ? payload.data : null;
  if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
  const nextAfter = heightOrNull(data.next_after);
  const nextOffset = heightOrNull(data.next_offset);
  const chainHeight = heightOrNull(data.chain_height);
  if (nextAfter === null || nextOffset === null || chainHeight === null || typeof data.has_more !== 'boolean') return null;
  return { items: data.items as Row[], nextAfter, nextOffset, hasMore: data.has_more, chainHeight };
}

type Params = { fromHeight: number; toHeight: number; after: number; offset: number; limit: number };

function parseParams(q: Request['query']): Params | { error: string } {
  for (const key of Object.keys(q)) {
    if (!ALLOWED_QUERY_KEYS.has(key)) return { error: `Unknown query parameter.` };
  }
  const num = (key: string): number | null | undefined => {
    const raw = q[key];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || !HEIGHT_RE.test(raw)) return null;
    const n = Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  };
  const fromHeight = num('fromHeight');
  const toRaw = num('toHeight');
  const afterRaw = num('after');
  const offsetRaw = num('offset');
  const limitRaw = num('limit');
  if (fromHeight === undefined) return { error: 'fromHeight is required.' };
  if (fromHeight === null || fromHeight < 1) return { error: 'fromHeight must be a positive integer.' };
  if (toRaw === null || afterRaw === null || offsetRaw === null || limitRaw === null) {
    return { error: 'toHeight, after, offset and limit must be non-negative integers.' };
  }
  const toHeight = toRaw ?? fromHeight + HISTORY_MAX_WINDOW_HEIGHTS - 1;
  if (toHeight < fromHeight) return { error: 'toHeight must not be below fromHeight.' };
  if (toHeight - fromHeight + 1 > HISTORY_MAX_WINDOW_HEIGHTS) {
    return { error: `The window may span at most ${HISTORY_MAX_WINDOW_HEIGHTS} heights (about 30 days).` };
  }
  if (offsetRaw !== undefined && afterRaw === undefined) return { error: 'offset needs after.' };
  const after = afterRaw ?? fromHeight - 1;
  if (after < fromHeight - 1 || after >= toHeight) return { error: 'after must lie inside the window.' };
  const limit = limitRaw ?? HISTORY_DEFAULT_LIMIT;
  if (limit < 1 || limit > HISTORY_MAX_LIMIT) return { error: `limit must be 1 to ${HISTORY_MAX_LIMIT}.` };
  return { fromHeight, toHeight, after, offset: offsetRaw ?? 0, limit };
}

export function createPublicStationHistoryRouter(deps: PublicStationHistoryDeps = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  const readerToken = deps.readerToken ?? (() => process.env.WRFCOIN_READER_TOKEN?.trim() || undefined);
  const budget = { windowStart: Number.NEGATIVE_INFINITY, used: 0 };

  let fetchPromise: Promise<Core4Fetch> | null = null;
  const getFetch = () => (fetchPromise ||= deps.fetchCore4Json ? Promise.resolve(deps.fetchCore4Json) : defaultFetch());
  let queryPromise: Promise<DbQuery> | null = null;
  const getQuery = () => {
    if (!queryPromise) {
      queryPromise = deps.query ? Promise.resolve(deps.query) : defaultQuery();
      queryPromise.catch(() => { queryPromise = null; });
    }
    return queryPromise;
  };
  let rateLimitPromise: Promise<RequestHandler> | null = null;
  const getRateLimit = () => {
    if (!rateLimitPromise) {
      rateLimitPromise = deps.rateLimit ? Promise.resolve(deps.rateLimit) : defaultRateLimit();
      rateLimitPromise.catch(() => { rateLimitPromise = null; });
    }
    return rateLimitPromise;
  };

  /** Take one node read from the process-wide fixed-window budget, or say when it reopens. */
  function takeBudget(): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const at = now();
    if (at - budget.windowStart >= PUBLIC_STATION_HISTORY_UPSTREAM_WINDOW_MS) { budget.windowStart = at; budget.used = 0; }
    if (budget.used >= upstreamMaxPerMinute()) {
      return {
        ok: false,
        retryAfterSeconds: Math.max(1, Math.ceil((budget.windowStart + PUBLIC_STATION_HISTORY_UPSTREAM_WINDOW_MS - at) / 1000)),
      };
    }
    budget.used += 1;
    return { ok: true };
  }

  router.get('/:alias', (req, res, next) => {
    if (!enabled()) return notFound(res);
    getRateLimit().then(
      (limit) => limit(req, res, (err?: unknown) => (err ? next(err) : void handle(req, res).catch(() => {
        if (!res.headersSent) fail(res, 503, 'STATION_HISTORY_UNAVAILABLE', 'Station history is unavailable, please try again later.');
      }))),
      () => fail(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Station history is unavailable, please try again later.'),
    );
  });

  async function handle(req: Request, res: Response) {
    res.set('Cache-Control', 'no-store');
    const alias = String(req.params.alias ?? '');
    if (!isStationAlias(alias)) return fail(res, 404, 'STATION_NOT_FOUND', 'Unknown station.');
    const params = parseParams(req.query);
    if ('error' in params) return fail(res, 400, 'VALIDATION_ERROR', params.error);
    const token = readerToken();
    if (!token) return fail(res, 503, 'CORE4_READER_CREDENTIAL_UNCONFIGURED', 'Chain reads are unavailable on this server.');

    let stationId: string;
    let latitude: number | null = null;
    let longitude: number | null = null;
    try {
      const query = await getQuery();
      const resolved = await resolveStationAlias(query, alias);
      if (resolved.status !== 'found') return fail(res, 404, 'STATION_NOT_FOUND', 'Unknown station.');
      stationId = resolved.stationId as string;
      const rows = await query('SELECT latitude, longitude FROM weather_stations WHERE station_id = $1 LIMIT 1', [stationId]);
      // 0.1 degree, applied here before serialisation: never a finer position.
      latitude = coarsenCoordinate(rows[0]?.latitude);
      longitude = coarsenCoordinate(rows[0]?.longitude);
    } catch {
      return fail(res, 503, 'STATION_LOOKUP_UNAVAILABLE', 'Station lookup is unavailable, please try again later.');
    }

    const fetchCore4Json = await getFetch();
    // Only the server credential: no caller header (not even a request id) reaches the node.
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json' };
    const observations: HistoryReading[] = [];
    let after = params.after;
    let offset = params.offset;
    let chainHeight: number | null = null;
    let done = false;
    let pages = 0;
    let budgetRetry: number | null = null;

    while (!done && pages < HISTORY_MAX_UPSTREAM_PAGES && observations.length < params.limit) {
      const allowed = takeBudget();
      if ('retryAfterSeconds' in allowed) { budgetRetry = allowed.retryAfterSeconds; break; }
      pages += 1;
      let upstream: Core4Response;
      try {
        upstream = await fetchCore4Json(`/transactions/contributions/${encodeURIComponent(stationId)}/observations`, {
          query: { after, offset, limit: Math.min(UPSTREAM_PAGE_LIMIT, params.limit - observations.length) },
          headers,
        });
      } catch (error) {
        if (observations.length > 0) break;
        return isTimeout(error)
          ? fail(res, 504, 'UPSTREAM_TIMEOUT', 'The chain node did not answer in time.')
          : fail(res, 502, 'UPSTREAM_ERROR', 'The chain node could not answer.');
      }
      const window = upstream.ok ? core4Window(upstream.payload) : null;
      if (!window) {
        if (observations.length > 0) break;
        if (upstream.status === 400) return fail(res, 400, 'INVALID_CURSOR', 'The cursor does not match the chain.');
        return fail(res, 502, 'UPSTREAM_ERROR', 'The chain node could not answer.');
      }
      chainHeight = window.chainHeight;
      for (const item of window.items) {
        const r = reading(item);
        if (!r || r.height < params.fromHeight) continue;
        if (r.height > params.toHeight) { done = true; break; }
        observations.push(r);
      }
      if (window.nextAfter === after && window.nextOffset === offset) {
        // No progress (the scan is at the chain tip): never hand back the same cursor.
        done = true;
        break;
      }
      after = window.nextAfter;
      offset = window.nextOffset;
      if (after >= params.toHeight || !window.hasMore) done = true;
    }

    if (pages === 0 && budgetRetry !== null) {
      res.set('Retry-After', String(budgetRetry));
      return fail(res, 503, 'UPSTREAM_BUDGET_EXHAUSTED', 'Station history is busy, please try again later.');
    }

    const body = {
      station: { alias, latitude, longitude },
      window: { fromHeight: params.fromHeight, toHeight: params.toHeight },
      observations,
      next: done ? null : { after, offset },
      chainHeight,
    };
    return res.json(scrubRawId(body, stationId));
  }

  return router;
}

export default createPublicStationHistoryRouter();
