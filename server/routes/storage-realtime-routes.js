/**
 * Storage Realtime Read API (mobile#204)
 *
 * The legacy storage route family (data-storage-api.js, mounted only via the
 * never-imported routes/index.js) cannot be loaded through safeMount: it pulls
 * the TypeScript-only shared/utils/file-upload-security, and carried top-level
 * await that fails CJS conversion (removed in #930 — the module still does not
 * load, because file-upload-security has no .js peer).
 *
 * NOTE: an earlier revision of this comment also blamed a "nonexistent
 * './layer-zero-schema'". That was wrong — `shared/layer-zero-schema.js`
 * exists and `require.resolve` finds it. Two of the three cited blockers were
 * real; that one was not. Corrected so the next person debugging this family
 * does not chase a module that is fine.
 *
 * This module restores the one endpoint that has a live consumer — the mobile
 * app's
 * GET /api/storage/weather/realtime/:stationId — backed by the canonical
 * weather_submissions table (drizzle/migrations/0002_sensor_ingest.sql).
 *
 * Exported as a createRouter factory so tests can inject a stubbed pool;
 * safeMount resolves it via mod.createRouter?.().
 */

const express = require('express');
const rateLimit = require('express-rate-limit');
const { logger } = require('../utils/logger');
const { hasOperatorToken } = require('../middleware/operator-token-auth');
const { coarsenCoordinate } = require('../utils/anonymous-projection');

const DEFAULT_MAX_AGE_MS = 300_000; // 5 minutes, same default as the legacy handler
const MAX_MAX_AGE_MS = 3_600_000; // 1 hour cap, same as the legacy validator

function toNumber(value) {
  // pg returns numeric columns as strings; absent sensors as null.
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseMaxAgeMs(raw) {
  const parsed = Number.parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_MAX_AGE_MS;
  return Math.min(parsed, MAX_MAX_AGE_MS);
}

function createRouter({ pool } = {}) {
  // Resolve the pool lazily and per-runtime. The live API image runs source
  // via tsx (backend#811), where ../db is server/db.ts and CJS require()
  // cannot resolve it — only dynamic import('../db.js') can (tsx maps the
  // .js specifier onto db.ts). The dist build is the opposite: require()
  // works, as it does for the sibling routes. Try require first, fall back
  // to dynamic import; a failed resolution is retried on the next request
  // and surfaces as a per-request 500 instead of a silently skipped mount.
  let db = pool || null;
  let dbPromise = null;
  const getPool = async () => {
    if (db) return db;
    if (!dbPromise) {
      dbPromise = (async () => {
        try {
          return require('../db').pool;
        } catch {
          const mod = await import('../db.js');
          return mod.pool;
        }
      })().catch((error) => {
        dbPromise = null;
        throw error;
      });
    }
    db = await dbPromise;
    return db;
  };
  const router = express.Router();

  const realtimeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: 'Too many requests from this IP, please try again later.',
  });

  /**
   * GET /api/storage/weather/realtime/:stationId?maxAge=<ms>
   *
   * Latest reading for a station within maxAge. The flat response shape is
   * the mobile contract: ForecastModel.fromJson requires non-null numeric
   * temperature/humidity/pressure/windSpeed/precipitation plus string
   * location/timestamp, and the PWS dashboard reads the same keys through
   * unwrapMapPayload. Raw nullable sensor values are preserved under
   * `sensors` so absent readings stay distinguishable from real zeros.
   */
  router.get('/weather/realtime/:stationId', realtimeLimiter, async (req, res) => {
    const stationId = String(req.params.stationId || '').trim();
    if (!stationId) {
      return res.status(400).json({ error: 'Station ID required' });
    }
    const maxAgeMs = parseMaxAgeMs(req.query.maxAge);

    try {
      // COALESCE(station_id, device_id) is the station-identity convention
      // for this table (see export-routes.ts) — mobile submissions may carry
      // only a device_id.
      const result = await (await getPool()).query(
        `SELECT COALESCE(station_id, device_id) AS station_id,
                latitude, longitude, temperature, humidity,
                pressure, wind_speed, wind_direction, rainfall,
                quality_score, source, submitted_at
           FROM weather_submissions
          WHERE COALESCE(station_id, device_id) = $1
            AND submitted_at >= now() - ($2::bigint * interval '1 millisecond')
          ORDER BY submitted_at DESC
          LIMIT 1`,
        [stationId, maxAgeMs],
      );

      const row = result.rows?.[0];
      if (!row) {
        return res.status(404).json({
          error: 'No reading within maxAge for station',
          stationId,
          maxAgeMs,
        });
      }

      const exactLocation = hasOperatorToken(req);
      const sensors = {
        temperature: toNumber(row.temperature),
        humidity: toNumber(row.humidity),
        pressure: toNumber(row.pressure),
        windSpeed: toNumber(row.wind_speed),
        windDirection: toNumber(row.wind_direction),
        precipitation: toNumber(row.rainfall),
      };

      return res.json({
        stationId: row.station_id,
        location: row.station_id,
        temperature: sensors.temperature ?? 0,
        humidity: sensors.humidity ?? 0,
        pressure: sensors.pressure ?? 0,
        windSpeed: sensors.windSpeed ?? 0,
        windDirection:
          sensors.windDirection === null ? null : String(sensors.windDirection),
        precipitation: sensors.precipitation ?? 0,
        timestamp: new Date(row.submitted_at).toISOString(),
        qualityScore: toNumber(row.quality_score),
        source: row.source,
        // backend#1222: exact submission coordinates (including phone
        // submissions) are operator-only; anonymous callers get 0.1 deg.
        latitude: exactLocation ? toNumber(row.latitude) : coarsenCoordinate(row.latitude),
        longitude: exactLocation ? toNumber(row.longitude) : coarsenCoordinate(row.longitude),
        sensors,
      });
    } catch (error) {
      logger.error('Failed to read realtime weather for station', {
        stationId,
        error: error.message,
      });
      return res.status(500).json({ error: 'Failed to retrieve realtime data' });
    }
  });

  return router;
}

module.exports = { createRouter };
