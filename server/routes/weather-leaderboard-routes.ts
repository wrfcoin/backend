/**
 * Weather-operator leaderboard — closes backend#384, extended by backend#693.
 *
 * Public, unauthenticated endpoint that ranks operators by submissions,
 * quality_score, or streak from PostgreSQL. #693 adds geographic filters
 * (`country`, `region`, `near`) plus `country`/`city` fields on response
 * rows so `frontend#151` can render region tabs. Response shape stays
 * additive — pre-filter clients keep parsing.
 *
 * Routes:
 *   GET /api/weather/leaderboard
 *     ?metric=earnings|submissions|quality_score|streak   (default: earnings, backend#1456)
 *     &period=7d|30d|all
 *     &limit=<1..100>
 *     &country=<ISO-3166-1-alpha-2>
 *     &region=<LeaderboardRegion>
 *     &near=<lat>,<lng>
 *     &radius_km=<N>   default 500, max 5000
 */

import express from 'express';
import { logger } from '../../utils/logger.js';
import { hasOperatorToken } from '../middleware/operator-token-auth.js';
import { peekWalletSubject } from '../middleware/authMiddleware.js';
import { profileKeyFor, shortAddress } from '../utils/contributor-alias.js';
import { coarsenCoordinatesInName } from '../utils/anonymous-projection.js';
import { fetchCore4Json as defaultFetchCore4Json } from '../../shared/core4-route-client.js';
import { createAddressEarnedReader, getDefaultAddressEarnedReader, EARNINGS_MAX_ADDRESSES } from '../services/address-lifetime-earned.js';
import { baseUnitsToWrf } from '../../shared/currency.js';
import { leaderboardEarningsUnits } from '../../shared/amount-unit-contract.js';

import type { RequestHandler } from 'express';
import {
  LEADERBOARD_REGIONS,
  countryCodesForRegion,
  isLeaderboardRegion,
  parseNear,
  type LeaderboardRegion,
  type ParsedNear,
} from './leaderboard-regions.js';

type DbExecutor = {
  execute: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
};

type CacheClient = {
  get: (key: string) => Promise<string | null>;
  setex: (key: string, seconds: number, value: string) => Promise<unknown>;
};

type Core4Fetch = (
  path: string,
  options?: Record<string, unknown>,
) => Promise<{ ok: boolean; status: number; payload: any }>;

export interface LeaderboardDeps {
  db?: DbExecutor;
  cache?: CacheClient | null;
  rateLimit?: RequestHandler | null;
  /** core4 reader transport for per-address earnings (tests inject it). */
  fetchCore4Json?: Core4Fetch;
  readerToken?: () => string | undefined;
  now?: () => number;
}

function defaultDb(): DbExecutor {
  let cachedExecuteQuery: ((sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>) | null =
    null;
  return {
    execute: async (sql: string, params?: unknown[]) => {
      if (!cachedExecuteQuery) {
        const mod = await import('../../database/index.js');
        cachedExecuteQuery = mod.executeQuery;
      }
      return cachedExecuteQuery!(sql, params);
    },
  };
}

async function defaultCache(): Promise<CacheClient | null> {
  try {
    const mod = await import('../utils/create-redis.js');
    // Leaderboard rows are authoritative in Postgres; Redis is only a cache.
    const client = mod.createRedisClient({
      failureMode: 'fail-open-cache',
    });
    return client as unknown as CacheClient;
  } catch {
    return null;
  }
}

async function defaultRateLimit(): Promise<RequestHandler | null> {
  try {
    const mod = await import('../../shared/middleware/rate-limit-redis.js');
    return mod.createRateLimitMiddleware({
      windowMs: 60 * 1000,
      maxRequests: 60,
      keyPrefix: 'ratelimit:leaderboard:region',
      message: 'Too many leaderboard requests, please try again later.',
    });
  } catch {
    return null;
  }
}

const VALID_METRICS = ['earnings', 'submissions', 'quality_score', 'streak'] as const;
type Metric = (typeof VALID_METRICS)[number];

const PERIOD_INTERVAL_MAP: Record<string, string> = {
  '7d': '7 days',
  '30d': '30 days',
  'all': '999999 days',
};

const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/;

const CACHE_TTL_SECONDS = 60;

interface Viewer {
  /** Presented the configured operator bearer. */
  operator: boolean;
  /** Lowercase wallet address of a valid wallet-login token, else null. */
  wallet: string | null;
}

interface GeoFilter {
  countries: string[] | null; // uppercase ISO alpha-2 list, null = no country filter
  near: ParsedNear | null;
  /** Bounding box pre-filter derived from `near`. Lng wraps clamped to [-180,180]. */
  bbox: { latMin: number; latMax: number; lngMin: number; lngMax: number } | null;
}

function boundingBoxFor(near: ParsedNear): GeoFilter['bbox'] {
  const latDeltaDeg = near.radiusKm / 111.32;
  const cosLat = Math.max(Math.cos((near.lat * Math.PI) / 180), 0.01);
  const lngDeltaDeg = near.radiusKm / (111.32 * cosLat);
  return {
    latMin: Math.max(near.lat - latDeltaDeg, -90),
    latMax: Math.min(near.lat + latDeltaDeg, 90),
    lngMin: Math.max(near.lng - lngDeltaDeg, -180),
    lngMax: Math.min(near.lng + lngDeltaDeg, 180),
  };
}

/**
 * Builds the SQL fragment and parameter list that filters submissions by the
 * geographic criteria. Callers append the fragment to their WHERE clause and
 * pass the params array appended to their own.
 *
 * @param tableAlias  alias of the weather_submissions row (e.g. `ws`)
 * @param paramStart  1-based index of the next $N placeholder to emit
 */
function buildGeoWhere(
  gf: GeoFilter,
  tableAlias: string,
  paramStart: number,
): { sql: string; params: unknown[]; nextParam: number } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let n = paramStart;
  if (gf.countries && gf.countries.length > 0) {
    parts.push(`UPPER(${tableAlias}.country) = ANY($${n}::text[])`);
    params.push(gf.countries);
    n++;
  }
  if (gf.bbox && gf.near) {
    parts.push(
      `${tableAlias}.latitude BETWEEN $${n} AND $${n + 1} AND ${tableAlias}.longitude BETWEEN $${n + 2} AND $${n + 3}`,
    );
    params.push(gf.bbox.latMin, gf.bbox.latMax, gf.bbox.lngMin, gf.bbox.lngMax);
    n += 4;
    // Haversine post-filter in km (earth radius 6371).
    parts.push(
      `6371 * acos(LEAST(1.0, cos(radians($${n})) * cos(radians(${tableAlias}.latitude)) * cos(radians(${tableAlias}.longitude) - radians($${n + 1})) + sin(radians($${n})) * sin(radians(${tableAlias}.latitude)))) <= $${n + 2}`,
    );
    params.push(gf.near.lat, gf.near.lng, gf.near.radiusKm);
    n += 3;
  }
  return { sql: parts.length === 0 ? '' : ` AND ${parts.join(' AND ')}`, params, nextParam: n };
}

function cacheKeyFor(
  metric: Metric,
  period: string,
  limit: number,
  gf: GeoFilter,
): string {
  const countryPart = gf.countries ? gf.countries.join(',') : '-';
  const nearPart = gf.near
    ? `${gf.near.lat.toFixed(2)},${gf.near.lng.toFixed(2)},${gf.near.radiusKm}`
    : '-';
  // v2 (backend#1361): the cache holds only the anonymous projection; never serve a pre-change body.
  // v3 (S55): rows now carry node-read earnings; never serve a pre-change body.
  return `cache:leaderboard:v3:${metric}:${period}:${limit}:${countryPart}:${nearPart}`;
}

export function createWeatherLeaderboardRouter(deps: LeaderboardDeps = {}): express.Router {
  const router = express.Router();
  const executor = deps.db ?? defaultDb();
  const fetchCore4Json = deps.fetchCore4Json ?? (defaultFetchCore4Json as Core4Fetch);
  const readerToken = deps.readerToken ?? (() => process.env.WRFCOIN_READER_TOKEN?.trim() || undefined);
  const now = deps.now ?? Date.now;

  // Per-address lifetime real_paid from core4 (budget, pacing and single-flight cache live in
  // services/address-lifetime-earned.ts, shared with the station earnings route). Injected
  // transports get a private reader so tests never share the process-wide cache.
  const earnedReader = deps.fetchCore4Json || deps.readerToken || deps.now
    ? createAddressEarnedReader({ fetchCore4Json, readerToken, now })
    : getDefaultAddressEarnedReader();
  const readEarnings = (addresses: string[]) => earnedReader.readMany(addresses);

  // Cache + rate-limit are resolved lazily so test harnesses that omit them do
  // not pay the Redis import cost. When deps explicitly pass `null` we honour
  // that (used by tests to skip).
  let cachePromise: Promise<CacheClient | null> | null = null;
  const getCache = (): Promise<CacheClient | null> => {
    if (deps.cache !== undefined) return Promise.resolve(deps.cache);
    if (!cachePromise) cachePromise = defaultCache();
    return cachePromise;
  };

  let rateLimitPromise: Promise<RequestHandler | null> | null = null;
  const getRateLimit = (): Promise<RequestHandler | null> => {
    if (deps.rateLimit !== undefined) return Promise.resolve(deps.rateLimit);
    if (!rateLimitPromise) rateLimitPromise = defaultRateLimit();
    return rateLimitPromise;
  };

  // Single dispatcher that awaits the rate-limit middleware once. Failing open
  // (no rate limit) keeps the public leaderboard available if Redis is down.
  const dispatch: RequestHandler = async (req, res, next) => {
    const rl = await getRateLimit();
    if (!rl) {
      handle(req, res).catch(next);
      return;
    }
    rl(req, res, (err?: unknown) => {
      if (err) return next(err as Error);
      handle(req, res).catch(next);
    });
  };

  router.get('/', dispatch);

  const handle = async (req: express.Request, res: express.Response) => {
    const rawMetric = String(req.query.metric ?? 'earnings');
    const rawPeriod = String(req.query.period ?? '7d');
    const rawLimit = Math.min(Math.max(Number(req.query.limit ?? 25), 1), 100);

    if (!VALID_METRICS.includes(rawMetric as Metric)) {
      return res.status(400).json({ error: `metric must be one of: ${VALID_METRICS.join(', ')}` });
    }
    if (!PERIOD_INTERVAL_MAP[rawPeriod]) {
      return res.status(400).json({ error: 'period must be 7d, 30d, or all' });
    }

    const rawCountry = req.query.country;
    const rawRegion = req.query.region;
    const rawNear = req.query.near;
    const rawRadius = req.query.radius_km;

    let countryFilter: string | null = null;
    if (typeof rawCountry === 'string' && rawCountry.length > 0) {
      if (!COUNTRY_CODE_RE.test(rawCountry)) {
        return res.status(400).json({ error: 'country must be an ISO 3166-1 alpha-2 code (e.g. US, GB)' });
      }
      countryFilter = rawCountry.toUpperCase();
    }

    let regionFilter: LeaderboardRegion | null = null;
    if (typeof rawRegion === 'string' && rawRegion.length > 0) {
      if (!isLeaderboardRegion(rawRegion)) {
        return res
          .status(400)
          .json({ error: `region must be one of: ${LEADERBOARD_REGIONS.join(', ')}` });
      }
      regionFilter = rawRegion;
    }

    let nearFilter: ParsedNear | null = null;
    if (rawNear !== undefined && rawNear !== '') {
      nearFilter = parseNear(rawNear, rawRadius);
      if (!nearFilter) {
        return res
          .status(400)
          .json({ error: 'near must be "lat,lng" with lat in [-90,90] and lng in [-180,180]; optional radius_km must be > 0' });
      }
    }

    if (rawMetric === 'earnings' && (countryFilter || regionFilter || nearFilter)) {
      // The chain registry carries no country, and a silently ignored filter would mislabel the ranking.
      return res.status(400).json({ error: 'country, region and near filters are not supported for metric=earnings' });
    }

    // Build the country-code set: country filter alone, region expansion alone,
    // or the intersection when both are supplied.
    let countries: string[] | null = null;
    if (countryFilter && regionFilter) {
      const regionCountries = countryCodesForRegion(regionFilter);
      if (regionCountries && !regionCountries.includes(countryFilter)) {
        // Country explicitly outside the region — emit empty result below.
        countries = [];
      } else {
        countries = [countryFilter];
      }
    } else if (countryFilter) {
      countries = [countryFilter];
    } else if (regionFilter) {
      const regionCountries = countryCodesForRegion(regionFilter);
      countries = regionCountries ? Array.from(regionCountries) : null; // Global → null
    }

    const gf: GeoFilter = {
      countries,
      near: nearFilter,
      bbox: nearFilter ? boundingBoxFor(nearFilter) : null,
    };

    // backend#1361: anonymous callers get short addresses; only the operator bearer and a
    // wallet's own login see a full address. The cache holds only the anonymous body, so a
    // verified viewer never reads or writes it.
    const viewer: Viewer = { operator: hasOperatorToken(req), wallet: peekWalletSubject(req) };
    const privileged = viewer.operator || viewer.wallet !== null;

    // Short-circuit: empty country set (country outside region) → empty entries,
    // no DB round-trip required.
    if (gf.countries && gf.countries.length === 0) {
      return res.json(buildResponse(rawMetric as Metric, rawPeriod, countryFilter, regionFilter, nearFilter, [], viewer));
    }

    const cache = privileged ? null : await getCache();
    const cacheKey = cacheKeyFor(rawMetric as Metric, rawPeriod, rawLimit, gf);
    if (cache) {
      try {
        const cached = await cache.get(cacheKey);
        if (cached) {
          return res.type('application/json').send(cached);
        }
      } catch {
        // Cache errors fall through to DB; the public leaderboard must not
        // break because Redis is flaky.
      }
    }

    const metric = rawMetric as Metric;
    const periodInterval = PERIOD_INTERVAL_MAP[rawPeriod];

    try {
      if (metric === 'earnings') {
        const chain = await loadChainRows(rawLimit);
        if ('candidates' in chain) {
          // Never a partial ranking: the client gets "unavailable", not a short list that looks complete.
          // backend#1457 review: the candidate counts (distinct station owners, reads done, budget) are
          // operational detail. No client reads them (frontend and mobile key off `unavailable`), so
          // only the operator bearer and a wallet login get them; anonymous callers do not.
          return res.status(503).json(buildUnavailableResponse(rawPeriod, privileged ? chain.candidates : null));
        }
        const body = buildResponse(metric, rawPeriod, null, null, null, chain.rows, viewer, chain.earned);
        const serialised = JSON.stringify(body);
        if (cache) {
          cache.setex(cacheKey, CACHE_TTL_SECONDS, serialised).catch(() => {
            // Cache write failures are non-fatal.
          });
        }
        return res.type('application/json').send(serialised);
      }
      const rows = await runLeaderboardQuery(executor, metric, rawLimit, periodInterval, gf);
      const earned = await readEarnings(rows.map(row => String(row.wallet_address)));
      const body = buildResponse(metric, rawPeriod, countryFilter, regionFilter, nearFilter, rows, viewer, earned);
      const serialised = JSON.stringify(body);
      if (cache) {
        cache.setex(cacheKey, CACHE_TTL_SECONDS, serialised).catch(() => {
          // Cache write failures are non-fatal.
        });
      }
      return res.type('application/json').send(serialised);
    } catch (err) {
      // backend#1222: never echo DB error text to anonymous callers.
      logger.error('[weather-leaderboard] query failed', { error: err instanceof Error ? err.message : String(err) });
      return res.status(500).json({ error: 'Failed to load leaderboard' });
    }
  };

  /**
   * backend#1456 option A: candidates are the distinct chain-synced station owners; the budgeted
   * node reader supplies lifetime real_paid; the DB only decorates name and region.
   */
  async function loadChainRows(limit: number): Promise<
    | { complete: true; rows: Record<string, unknown>[]; earned: Map<string, string | null> }
    | { complete: false; candidates: { total: number; read: number; cap: number } }
  > {
    const cap = EARNINGS_MAX_ADDRESSES;
    const owners = await executor.execute(
      `SELECT DISTINCT LOWER(owner_address) AS owner_address
         FROM weather_stations
        WHERE owner_address ~* '^(0x|wrf)[0-9a-f]{40}$'
        ORDER BY 1`,
    );
    const candidates = [...new Set(owners.rows.map(r => String(r.owner_address).toLowerCase()))];
    if (candidates.length > cap) {
      // Beyond the read budget the ranking cannot be proven complete: no node reads, honest unavailable.
      return { complete: false, candidates: { total: candidates.length, read: 0, cap } };
    }
    const earned = await readEarnings(candidates);
    if (candidates.some(a => earned.get(a) === null || earned.get(a) === undefined)) {
      const read = candidates.filter(a => earned.get(a) != null).length;
      return { complete: false, candidates: { total: candidates.length, read, cap } };
    }
    const ranked = candidates
      .map(address => ({ address, paid: BigInt(earned.get(address) as string) }))
      .filter(c => c.paid > 0n)
      .sort((x, y) => (x.paid === y.paid ? (x.address < y.address ? -1 : 1) : x.paid > y.paid ? -1 : 1))
      .slice(0, limit);

    let decor = new Map<string, Record<string, unknown>>();
    if (ranked.length > 0) {
      try {
        const named = await executor.execute(
          `SELECT LOWER(u.wallet_address) AS wallet_address,
                  u.display_name,
                  latest_geo.country AS country,
                  latest_geo.city AS city
             FROM users u
             LEFT JOIN LATERAL (
               SELECT country, city FROM weather_submissions ws
                WHERE ws.user_id = u.id AND (ws.country IS NOT NULL OR ws.city IS NOT NULL)
                ORDER BY ws.submitted_at DESC LIMIT 1
             ) latest_geo ON TRUE
            WHERE LOWER(u.wallet_address) = ANY($1::text[])`,
          [ranked.map(r => r.address)],
        );
        decor = new Map(named.rows.map(r => [String(r.wallet_address).toLowerCase(), r]));
      } catch (err) {
        // Names are decoration; the proven amounts must not depend on them.
        logger.warn('[weather-leaderboard] name lookup failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    const rows = ranked.map((r, i) => {
      const d = decor.get(r.address);
      const name = typeof d?.display_name === 'string' && d.display_name.length > 0 ? d.display_name : null;
      return {
        rank: i + 1,
        wallet_address: r.address,
        display_name: name ?? `WeatherNode-${r.address.slice(2, 8).toUpperCase()}`,
        value: baseUnitsToWrf(r.paid),
        country: d?.country ?? null,
        city: d?.city ?? null,
      };
    });
    return { complete: true, rows, earned };
  }

  return router;
}

async function runLeaderboardQuery(
  executor: DbExecutor,
  metric: Metric,
  limit: number,
  periodInterval: string,
  gf: GeoFilter,
): Promise<Record<string, unknown>[]> {
  // First 2 params are always [limit, periodInterval]; geo params start at $3.
  const base: unknown[] = [limit, periodInterval];
  const geo = buildGeoWhere(gf, 'ws', base.length + 1);

  if (metric === 'streak') {
    // Geo filter is applied via an EXISTS on weather_submissions because
    // streak_milestones_claimed itself has no geo columns. We also expose
    // country/city from the submitter's most recent non-null submission via a
    // LATERAL join so callers always get a value when one exists.
    const existsFrag = gf.countries || gf.near
      ? `AND EXISTS (SELECT 1 FROM weather_submissions ws WHERE ws.user_id = u.id ${geo.sql})`
      : '';
    const sql = `
      SELECT
        u.wallet_address,
        COALESCE(u.display_name, 'WeatherNode-' || UPPER(SUBSTRING(u.wallet_address, 3, 6))) AS display_name,
        MAX(smc.milestone_days) AS value,
        latest_geo.country AS country,
        latest_geo.city AS city,
        ROW_NUMBER() OVER (ORDER BY MAX(smc.milestone_days) DESC NULLS LAST) AS rank
      FROM streak_milestones_claimed smc
      JOIN users u ON u.wallet_address = smc.wallet_address
      LEFT JOIN LATERAL (
        SELECT country, city FROM weather_submissions ws2
        WHERE ws2.user_id = u.id AND (ws2.country IS NOT NULL OR ws2.city IS NOT NULL)
        ORDER BY ws2.submitted_at DESC LIMIT 1
      ) latest_geo ON TRUE
      WHERE smc.created_at >= now() - ($2::text)::interval
        ${existsFrag}
      GROUP BY u.wallet_address, u.display_name, latest_geo.country, latest_geo.city
      ORDER BY value DESC NULLS LAST
      LIMIT $1
    `;
    const result = await executor.execute(sql, [...base, ...geo.params]);
    return result.rows;
  }

  if (metric === 'quality_score') {
    const sql = `
      SELECT
        u.wallet_address,
        COALESCE(u.display_name, 'WeatherNode-' || UPPER(SUBSTRING(u.wallet_address, 3, 6))) AS display_name,
        ROUND(AVG(ws.quality_score)::numeric, 2) AS value,
        MAX(ws.country) AS country,
        MAX(ws.city) AS city,
        ROW_NUMBER() OVER (ORDER BY AVG(ws.quality_score) DESC NULLS LAST) AS rank
      FROM weather_submissions ws
      JOIN users u ON u.id = ws.user_id
      WHERE ws.submitted_at >= now() - ($2::text)::interval
        ${geo.sql}
      GROUP BY u.wallet_address, u.display_name
      HAVING COUNT(*) >= 3
      ORDER BY value DESC NULLS LAST
      LIMIT $1
    `;
    const result = await executor.execute(sql, [...base, ...geo.params]);
    return result.rows;
  }

  // submissions (default)
  const sql = `
    SELECT
      u.wallet_address,
      COALESCE(u.display_name, 'WeatherNode-' || UPPER(SUBSTRING(u.wallet_address, 3, 6))) AS display_name,
      COUNT(*) AS value,
      MAX(ws.country) AS country,
      MAX(ws.city) AS city,
      ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC) AS rank
    FROM weather_submissions ws
    JOIN users u ON u.id = ws.user_id
    WHERE ws.submitted_at >= now() - ($2::text)::interval
      ${geo.sql}
    GROUP BY u.wallet_address, u.display_name
    ORDER BY value DESC
    LIMIT $1
  `;
  const result = await executor.execute(sql, [...base, ...geo.params]);
  return result.rows;
}

function buildUnavailableResponse(period: string, candidates: { total: number; read: number; cap: number } | null) {
  return {
    success: false as const,
    error: 'Leaderboard earnings are unavailable: the node could not prove every candidate',
    metric: 'earnings' as const,
    period,
    updatedAt: new Date().toISOString(),
    earningsScope: 'lifetime' as const,
    amountUnits: leaderboardEarningsUnits(false),
    unavailable: ['earnings'] as ['earnings'],
    ...(candidates ? { candidates } : {}),
    entries: [] as never[],
  };
}

function toCountryCode(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  const trimmed = value.trim();
  return COUNTRY_CODE_RE.test(trimmed) ? trimmed.toUpperCase() : null;
}

function buildResponse(
  metric: Metric,
  period: string,
  country: string | null,
  region: LeaderboardRegion | null,
  near: ParsedNear | null,
  rows: Record<string, unknown>[],
  viewer: Viewer,
  earned: Map<string, string | null> = new Map(),
): {
  success: true;
  metric: Metric;
  period: string;
  country: string | null;
  region: LeaderboardRegion | null;
  near: { lat: number; lng: number; radius_km: number } | null;
  updatedAt: string;
  /** S55: earnings are the node's lifetime real_paid; it has no per-period ledger. */
  earningsScope: 'lifetime';
  earningsDescription: string;
  amountUnits: ReturnType<typeof leaderboardEarningsUnits>;
  unavailable?: ['earnings'];
  entries: Array<{
    rank: number;
    /** Short form (`0xa1a1…a1a1`) unless the viewer is the operator or this is their own row. */
    walletAddress: string;
    /** Opaque stable key for the profile link; null when the server has no alias secret. */
    profileKey: string | null;
    /** True when the caller's own wallet login owns this row. */
    isYou: boolean;
    displayName: string;
    /**
     * DISPLAY ONLY (backend#1457 review): a JS double from Number(), so it loses exactness above 2^53
     * and carries the ranking figure (WRF for earnings, a count/score for other metrics). Exact
     * amounts are `earningsBaseUnits` (string) and `earningsWrf`; no client may use `value` for them.
     */
    value: number;
    badgeLevel: 'gold' | 'silver' | 'bronze';
    streak: number | null;
    country: string | null;
    city: string | null;
    /** Lifetime real_paid in base units; null = the node did not answer (never zero by default). */
    earningsBaseUnits: string | null;
    /** The same amount as a WRF display string; null with earningsBaseUnits. */
    earningsWrf: string | null;
  }>;
} {
  const entries = rows.map(row => {
    const value = Number(row.value ?? 0);
    const address = String(row.wallet_address);
    const isYou = viewer.wallet !== null && address.toLowerCase() === viewer.wallet;
    const paid = earned.get(address) ?? null;
    return {
      rank: Number(row.rank),
      walletAddress: viewer.operator || isYou ? address : shortAddress(address),
      profileKey: profileKeyFor(address),
      isYou,
      // backend#1397: an owner-entered name's coordinate-like numbers at 0.1 deg.
      displayName: viewer.operator ? String(row.display_name) : coarsenCoordinatesInName(String(row.display_name)),
      value,
      badgeLevel: (value > 100 ? 'gold' : value > 30 ? 'silver' : 'bronze') as
        | 'gold'
        | 'silver'
        | 'bronze',
      streak: null,
      country: toCountryCode(row.country),
      city: typeof row.city === 'string' && row.city.length > 0 ? row.city : null,
      earningsBaseUnits: paid,
      earningsWrf: paid === null ? null : baseUnitsToWrf(BigInt(paid)),
    };
  });
  const complete = entries.every(entry => entry.earningsBaseUnits !== null);

  return {
    success: true,
    metric,
    period,
    country,
    region,
    near: near ? { lat: near.lat, lng: near.lng, radius_km: near.radiusKm } : null,
    updatedAt: new Date().toISOString(),
    earningsScope: 'lifetime',
    earningsDescription:
      'Lifetime real-station rewards paid to the address (node-proven). The period filter ranks only; it does not window this amount.',
    amountUnits: leaderboardEarningsUnits(complete),
    ...(complete ? {} : { unavailable: ['earnings'] as ['earnings'] }),
    entries,
  };
}

export default createWeatherLeaderboardRouter();
