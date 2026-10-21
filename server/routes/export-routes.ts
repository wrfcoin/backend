import type { IncomingMessage, ServerResponse } from 'http';
import type { ParsedUrlQuery } from 'querystring';
import { hasOperatorToken } from '../middleware/operator-token-auth.js';
import { coarsenCoordinate } from '../utils/anonymous-projection.js';
// backend#1222: the rate-limit key must not be a client-chosen header. The shared
// resolver honours X-Forwarded-For only from configured trusted proxies and walks
// it right to left (backend#1229).
import { getClientIp } from '../../shared/middleware/rate-limit-redis.js';

export type QueryExecutor = (
  sql: string,
  params?: unknown[]
) => Promise<{ rows: Record<string, unknown>[] }>;

type ExportFormat = 'json' | 'csv';

interface DateRange {
  from: string;
  to: string;
}

interface ExportObservation {
  stationId: string | null;
  temperature: number | null;
  pressure: number | null;
  humidity: number | null;
  qualityScore: number | null;
  rewardAmount: number | null;
  source: string | null;
  latitude: number | null;
  longitude: number | null;
  submittedAt: string | null;
  distanceKm?: number | null;
}

export interface HandleWeatherExportRequestInput {
  path: string;
  method?: string;
  query: ParsedUrlQuery;
  req: IncomingMessage;
  res: ServerResponse;
  executeQuery: QueryExecutor;
}

const EXPORT_RATE_LIMIT_WINDOW_MS = 60_000;
const EXPORT_RATE_LIMIT_MAX = 10;
const EXPORT_CHUNK_SIZE = 500;
const MAX_CATALOG_LIMIT = 1000;

const exportRateLimiter = new Map<string, { count: number; resetAt: number }>();

export function resetWeatherExportRateLimiter(): void {
  exportRateLimiter.clear();
}

function readQueryValue(
  query: ParsedUrlQuery,
  key: string
): string | undefined {
  const value = query[key];
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value) && typeof value[0] === 'string') {
    return value[0];
  }
  return undefined;
}

function parseDateRange(query: ParsedUrlQuery): DateRange | { error: string } {
  const fromRaw = readQueryValue(query, 'from') || readQueryValue(query, 'start');
  const toRaw = readQueryValue(query, 'to') || readQueryValue(query, 'end');

  if (!fromRaw || !toRaw) {
    return { error: 'from/start and to/end query parameters are required' };
  }

  const fromDate = new Date(fromRaw);
  const toDate = new Date(toRaw);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return { error: 'from/start and to/end must be valid ISO date values' };
  }
  if (fromDate > toDate) {
    return { error: 'from/start must be earlier than or equal to to/end' };
  }

  return {
    from: fromDate.toISOString(),
    to: toDate.toISOString(),
  };
}

function parseFormat(query: ParsedUrlQuery): ExportFormat | { error: string } {
  const rawFormat = (readQueryValue(query, 'format') || 'json').toLowerCase();
  if (rawFormat === 'json' || rawFormat === 'csv') {
    return rawFormat;
  }
  return { error: 'format must be one of: json, csv' };
}

function parseCoordinate(
  value: string | undefined,
  name: string,
  min: number,
  max: number
): number | { error: string } {
  if (!value) {
    return { error: `${name} query parameter is required` };
  }
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    return { error: `${name} must be a valid number between ${min} and ${max}` };
  }
  return parsed;
}

function parseRadiusKm(query: ParsedUrlQuery): number | { error: string } {
  const rawValue = readQueryValue(query, 'radius_km');
  if (!rawValue) {
    return { error: 'radius_km query parameter is required' };
  }
  const parsed = Number.parseFloat(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1000) {
    return { error: 'radius_km must be a valid number between 0 and 1000' };
  }
  return parsed;
}

function parseCatalogLimit(query: ParsedUrlQuery): number | { error: string } {
  const rawLimit = readQueryValue(query, 'limit');
  if (!rawLimit) {
    return 100;
  }
  const parsed = Number.parseInt(rawLimit, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > MAX_CATALOG_LIMIT) {
    return {
      error: `limit must be an integer between 1 and ${MAX_CATALOG_LIMIT}`,
    };
  }
  return parsed;
}

function normalizeString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  return String(value);
}

function normalizeNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeDate(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const parsed = new Date(String(value));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString();
}

// backend#1222: the anonymous export is a bulk location/financial dump
// otherwise. Anonymous rows carry coordinates coarsened to 0.1 deg, no
// per-submission reward amount, and distance rounded to whole km (precise
// distances from caller-chosen centres would trilaterate the exact point).
// The operator bearer gets exact rows.
export const ANONYMOUS_MIN_REGION_RADIUS_KM = 25;

function mapObservationRow(row: Record<string, unknown>, exact: boolean): ExportObservation {
  const distanceKm = normalizeNumber(row.distance_km);
  return {
    stationId: normalizeString(row.station_id),
    temperature: normalizeNumber(row.temperature),
    pressure: normalizeNumber(row.pressure),
    humidity: normalizeNumber(row.humidity),
    qualityScore: normalizeNumber(row.quality_score),
    rewardAmount: exact ? normalizeNumber(row.reward_amount) : null,
    source: normalizeString(row.source),
    latitude: exact ? normalizeNumber(row.latitude) : coarsenCoordinate(row.latitude),
    longitude: exact ? normalizeNumber(row.longitude) : coarsenCoordinate(row.longitude),
    submittedAt: normalizeDate(row.submitted_at),
    distanceKm: exact || distanceKm === null ? distanceKm : Math.round(distanceKm),
  };
}

function csvEscape(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return '';
  }
  const raw = String(value);
  if (raw.includes(',') || raw.includes('"') || raw.includes('\n')) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: Record<string, unknown>,
  headers: Record<string, string> = {}
): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function consumeRateLimit(ip: string): {
  allowed: boolean;
  retryAfterSeconds: number;
} {
  const now = Date.now();
  const bucket = exportRateLimiter.get(ip);
  if (!bucket || now >= bucket.resetAt) {
    exportRateLimiter.set(ip, {
      count: 1,
      resetAt: now + EXPORT_RATE_LIMIT_WINDOW_MS,
    });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= EXPORT_RATE_LIMIT_MAX) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
    };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

async function fetchStationObservationChunk(
  executeQuery: QueryExecutor,
  stationId: string,
  range: DateRange,
  offset: number,
  limit: number
): Promise<Record<string, unknown>[]> {
  const result = await executeQuery(
    `SELECT
       COALESCE(station_id, device_id) AS station_id,
       temperature,
       pressure,
       humidity,
       quality_score,
       reward_amount,
       source,
       latitude,
       longitude,
       submitted_at
     FROM weather_submissions
     WHERE COALESCE(station_id, device_id) = $1
       AND submitted_at >= $2::timestamptz
       AND submitted_at <= $3::timestamptz
     ORDER BY submitted_at ASC
     LIMIT $4 OFFSET $5`,
    [stationId, range.from, range.to, limit, offset]
  );
  return result.rows;
}

async function fetchRegionObservationChunk(
  executeQuery: QueryExecutor,
  lat: number,
  lon: number,
  radiusKm: number,
  range: DateRange,
  offset: number,
  limit: number
): Promise<Record<string, unknown>[]> {
  const result = await executeQuery(
    `WITH filtered AS (
       SELECT
         COALESCE(station_id, device_id) AS station_id,
         temperature,
         pressure,
         humidity,
         quality_score,
         reward_amount,
         source,
         latitude,
         longitude,
         submitted_at,
         (
           6371 * acos(
             cos(radians($1::double precision)) *
             cos(radians(latitude::double precision)) *
             cos(radians(longitude::double precision) - radians($2::double precision)) +
             sin(radians($1::double precision)) *
             sin(radians(latitude::double precision))
           )
         ) AS distance_km
       FROM weather_submissions
       WHERE latitude IS NOT NULL
         AND longitude IS NOT NULL
         AND submitted_at >= $3::timestamptz
         AND submitted_at <= $4::timestamptz
     )
     SELECT *
     FROM filtered
     WHERE distance_km <= $5::double precision
     ORDER BY submitted_at ASC
     LIMIT $6 OFFSET $7`,
    [lat, lon, range.from, range.to, radiusKm, limit, offset]
  );
  return result.rows;
}

async function streamJsonObservations(
  res: ServerResponse,
  filters: Record<string, unknown>,
  fetchChunk: (
    offset: number,
    limit: number
  ) => Promise<Record<string, unknown>[]>,
  exact: boolean
): Promise<void> {
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });

  let offset = 0;
  let count = 0;
  let first = true;

  res.write('{"success":true,"data":{"format":"json","observations":[');

  while (true) {
    const rows = await fetchChunk(offset, EXPORT_CHUNK_SIZE);
    if (!rows.length) {
      break;
    }

    for (const row of rows) {
      const observation = mapObservationRow(row, exact);
      if (!first) {
        res.write(',');
      }
      res.write(JSON.stringify(observation));
      first = false;
      count += 1;
    }

    offset += rows.length;
  }

  res.write(`],"count":${count},"filters":${JSON.stringify(filters)}},"timestamp":"${new Date().toISOString()}"}`);
  res.end();
}

async function streamCsvObservations(
  res: ServerResponse,
  filename: string,
  fetchChunk: (
    offset: number,
    limit: number
  ) => Promise<Record<string, unknown>[]>,
  exact: boolean
): Promise<void> {
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}"`,
  });

  res.write(
    'station_id,submitted_at,temperature,pressure,humidity,quality_score,reward_amount,source,latitude,longitude,distance_km\n'
  );

  let offset = 0;
  while (true) {
    const rows = await fetchChunk(offset, EXPORT_CHUNK_SIZE);
    if (!rows.length) {
      break;
    }

    for (const row of rows) {
      const observation = mapObservationRow(row, exact);
      res.write(
        [
          csvEscape(observation.stationId),
          csvEscape(observation.submittedAt),
          csvEscape(observation.temperature),
          csvEscape(observation.pressure),
          csvEscape(observation.humidity),
          csvEscape(observation.qualityScore),
          csvEscape(observation.rewardAmount),
          csvEscape(observation.source),
          csvEscape(observation.latitude),
          csvEscape(observation.longitude),
          csvEscape(observation.distanceKm ?? null),
        ].join(',') + '\n'
      );
    }

    offset += rows.length;
  }

  res.end();
}

async function handleDataCatalogRequest(
  query: ParsedUrlQuery,
  executeQuery: QueryExecutor,
  res: ServerResponse
): Promise<void> {
  const limitValue = parseCatalogLimit(query);
  if (typeof limitValue !== 'number') {
    writeJson(res, 400, {
      success: false,
      error: limitValue.error,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  const result = await executeQuery(
    `SELECT
       COALESCE(station_id, device_id) AS station_id,
       MIN(submitted_at) AS first_observation_at,
       MAX(submitted_at) AS last_observation_at,
       COUNT(*)::bigint AS observations_count,
       AVG(quality_score) AS average_quality_score
     FROM weather_submissions
     WHERE COALESCE(station_id, device_id) IS NOT NULL
     GROUP BY COALESCE(station_id, device_id)
     ORDER BY observations_count DESC
     LIMIT $1`,
    [limitValue]
  );

  const stations = result.rows.map((row) => ({
    stationId: normalizeString(row.station_id),
    firstObservationAt: normalizeDate(row.first_observation_at),
    lastObservationAt: normalizeDate(row.last_observation_at),
    observationsCount: normalizeNumber(row.observations_count),
    averageQualityScore: normalizeNumber(row.average_quality_score),
  }));

  writeJson(res, 200, {
    success: true,
    data: {
      stations,
      total: stations.length,
    },
    timestamp: new Date().toISOString(),
  });
}

function isRateLimitedExportPath(path: string): boolean {
  return (
    path.startsWith('/api/v1/export/stations/') || path === '/api/v1/export/region'
  );
}

export async function handleWeatherExportRequest(
  input: HandleWeatherExportRequestInput
): Promise<boolean> {
  const { path, method, query, req, res, executeQuery } = input;
  const exact = hasOperatorToken(req);

  if (method !== 'GET') {
    return false;
  }

  if (path === '/api/v1/data-catalog') {
    await handleDataCatalogRequest(query, executeQuery, res);
    return true;
  }

  const stationMatch = path.match(
    /^\/api\/v1\/export\/stations\/([^/]+)\/observations$/
  );
  const isRegionPath = path === '/api/v1/export/region';

  if (!stationMatch && !isRegionPath) {
    return false;
  }

  if (isRateLimitedExportPath(path)) {
    const rateLimit = consumeRateLimit(getClientIp(req));
    if (!rateLimit.allowed) {
      writeJson(
        res,
        429,
        {
          success: false,
          error: 'Rate limit exceeded: max 10 export requests per minute per IP',
          timestamp: new Date().toISOString(),
        },
        { 'Retry-After': String(rateLimit.retryAfterSeconds) }
      );
      return true;
    }
  }

  const format = parseFormat(query);
  if (typeof format !== 'string') {
    writeJson(res, 400, {
      success: false,
      error: format.error,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  const range = parseDateRange(query);
  if ('error' in range) {
    writeJson(res, 400, {
      success: false,
      error: range.error,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  if (stationMatch) {
    const stationId = decodeURIComponent(stationMatch[1]);
    const filters = {
      stationId,
      from: range.from,
      to: range.to,
    };

    const fetchChunk = (offset: number, limit: number) =>
      fetchStationObservationChunk(executeQuery, stationId, range, offset, limit);

    if (format === 'csv') {
      await streamCsvObservations(
        res,
        `station-${stationId}-observations.csv`,
        fetchChunk,
        exact
      );
      return true;
    }

    await streamJsonObservations(res, filters, fetchChunk, exact);
    return true;
  }

  const latValue = parseCoordinate(readQueryValue(query, 'lat'), 'lat', -90, 90);
  if (typeof latValue !== 'number') {
    writeJson(res, 400, {
      success: false,
      error: latValue.error,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  const lonValue = parseCoordinate(readQueryValue(query, 'lon'), 'lon', -180, 180);
  if (typeof lonValue !== 'number') {
    writeJson(res, 400, {
      success: false,
      error: lonValue.error,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  const parsedRadiusKm = parseRadiusKm(query);
  if (typeof parsedRadiusKm !== 'number') {
    writeJson(res, 400, {
      success: false,
      error: parsedRadiusKm.error,
      timestamp: new Date().toISOString(),
    });
    return true;
  }

  // backend#1222: a tiny radius around a caller-chosen point is a location
  // oracle ("is there a station within 100 m of this house?"). Anonymous
  // callers are clamped up to a minimum radius.
  const radiusKm = exact
    ? parsedRadiusKm
    : Math.max(parsedRadiusKm, ANONYMOUS_MIN_REGION_RADIUS_KM);

  // The echoed centre is coarsened for anonymous callers too: no anonymous
  // body carries a coordinate finer than 0.1 deg (owner ruling 2026-10-01).
  const filters = {
    lat: exact ? latValue : coarsenCoordinate(latValue),
    lon: exact ? lonValue : coarsenCoordinate(lonValue),
    radiusKm,
    from: range.from,
    to: range.to,
  };

  const fetchChunk = (offset: number, limit: number) =>
    fetchRegionObservationChunk(
      executeQuery,
      latValue,
      lonValue,
      radiusKm,
      range,
      offset,
      limit
    );

  if (format === 'csv') {
    await streamCsvObservations(res, 'regional-weather-observations.csv', fetchChunk, exact);
    return true;
  }

  await streamJsonObservations(res, filters, fetchChunk, exact);
  return true;
}
