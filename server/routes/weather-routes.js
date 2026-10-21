/**
 * Weather API Routes
 *
 * This module provides routes for interacting with weather data in the Wrfcoin network.
 * Now enhanced with real weather API integration (NOAA NWS, NOAA Data Service).
 */

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const router = express.Router();
const { logger } = require('../utils/logger');
const { coarsenCoordinate, coarsenCoordinatesInName } = require('../utils/anonymous-projection');
const { stationAlias, isStationAlias, resolveStationAlias, scrubRawId } = require('../utils/station-alias');
const { createApiError } = require('../utils/api-error');
const { stationServiceFailureResponse } = require('../utils/station-service-error');
const EnhancedWeatherController = require('../controllers/enhanced-weather-controller');
const { secureCompare } = require('../middleware/rpcAuthMiddleware');
const { hasOperatorOrReaderToken } = require('../middleware/operator-token-auth');

function requireOperatorOrReaderToken(req, res, next) {
  if (hasOperatorOrReaderToken(req)) {
    return next();
  }
  return res.status(401).json({ success: false, error: 'Operator or reader bearer token required' });
}

// backend#1113: is this caller allowed to see per-address owner/reward
// identity on an otherwise-public, unauthenticated station list? Same
// operator-token pattern already used by /stations/credentials below, which
// backend#1114 switched to the same constant-time secureCompare helper.
function isOperatorRequest(req) {
  const operatorToken = process.env.WRFCOIN_OPERATOR_TOKEN;
  if (!operatorToken) {
    return false;
  }
  const auth = req.header('authorization') || '';
  const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return Boolean(presented) && secureCompare(presented, operatorToken);
}

// Lazy-loaded ESM station registration service (#788). Avoids eager import of TS
// modules in environments that resolve this router via CJS require().
let _stationService = null;
async function getStationService() {
  if (!_stationService) {
    _stationService = await import('../services/station-registration-service.js');
  }
  return _stationService;
}

// backend#1280: newest chain observation per station. The collectors submit to
// the core4 node, not the backend, so `weather_data` alone never shows a
// station live. The reader is shared with the station detail routes, cached
// and bounded; any core4 failure degrades to the database answer.
let _chainTail = null;
async function getChainLastSeen() {
  if (!_chainTail) {
    const { getDefaultChainTailReader } = await import('../services/chain-station-tail.js');
    _chainTail = getDefaultChainTailReader();
  }
  return _chainTail.lastSeenMs;
}

// backend#1232 (S10): station_reward_cycles has no writer, so reward-progress answers from
// the chain (tail + core4 per-commit reward evidence) when the table has nothing.
let _chainRewardEvidence = null;
async function getChainRewardEvidence() {
  if (!_chainRewardEvidence) {
    const { createStationChainEvidenceReader } = await import('../services/station-chain-reward-evidence.js');
    const { fetchCore4Json } = await import('../../shared/core4-route-client.js');
    _chainRewardEvidence = createStationChainEvidenceReader({
      fetchCore4Json,
      readerToken: () => process.env.WRFCOIN_READER_TOKEN?.trim() || undefined,
    });
  }
  return _chainRewardEvidence;
}

// #1042 boot probe: resolve the service once at mount time so a build that
// shipped this router without its compiled service fails LOUDLY in the boot
// log (code + stack), not as a generic 500 at first request. Intentionally
// does not throw — scripts/verify-dist-import-resolution.mjs is the hard gate
// at build time; this is the runtime tripwire for images built another way.
getStationService().catch((error) => {
  stationServiceFailureResponse('preload station registration service at boot', error, logger);
});

// 64-hex-char AES-256-GCM key for provider-credential encryption at rest (#788).
function getEncryptionKey() {
  const key = process.env.API_KEY_ENCRYPTION_KEY;
  if (!key || !/^[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('API_KEY_ENCRYPTION_KEY must be a 64-hex-character string');
  }
  return key;
}

// Node 18+/20+ exposes a global fetch; this indirection keeps it test-injectable.
const defaultFetch = (url, init) => globalThis.fetch(url, init);

const weatherGetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const weatherPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

// Initialize enhanced weather controller
const weatherController = new EnhancedWeatherController();
async function authenticateWeatherRequest(req, res, next) {
  try {
    const { authenticateToken } = await import('../middleware/auth-middleware.js');
    return authenticateToken(req, res, next);
  } catch (error) {
    return next(error);
  }
}

// Lazy cached DB pool — avoids CJS require() in ESM bundle (#268)
let _cachedPool = null;
async function getPool() {
  if (!_cachedPool) {
    const dbModule = await import('../db.js');
    // backend#1247: fail loudly, and never cache undefined, if the pool export
    // is not visible (a CJS star re-export hid it and every query threw
    // "Cannot read properties of undefined").
    const pool = dbModule.pool ?? dbModule.default?.pool;
    if (!pool) {
      throw new Error('server/db.js exposes no pool export');
    }
    _cachedPool = pool;
  }
  return _cachedPool;
}

async function ingestLegacyWeatherRouteRequest(req, source) {
  const { location, data, stationId } = req.body;
  const { ingestWeatherPayload } = await import('../services/weather-ingestion-service.js');

  // Normalize field names: accept both legacy (temperature) and canonical (temperature_c)
  const payload = {
    stationId,
    timestamp: data?.timestamp || new Date().toISOString(),
    temperature_c: data?.temperature_c ?? data?.temperature,
    humidity_percent: data?.humidity_percent ?? data?.humidity,
    pressure_hpa: data?.pressure_hpa ?? data?.pressure,
    wind_speed_ms: data?.wind_speed_ms ?? data?.windSpeed,
    windDirection: data?.windDirection,
    precipitation_mm: data?.precipitation_mm ?? data?.precipitation,
    visibility: data?.visibility,
    uvIndex: data?.uvIndex,
    airQuality: data?.airQuality,
  };

  return ingestWeatherPayload({
    route: '/api/weather/data',
    payload,
    idempotencyKey: req.header('idempotency-key') || req.body?.idempotencyKey,
    transportMeta: {
      source: source || 'legacy_weather_route',
      userId: req.user?.id || null,
      walletAddress: req.user?.address || null,
      location,
    },
  });
}

// Get current weather data by location (enhanced with real APIs)
router.get('/data/:location', weatherGetLimiter, async (req, res) => {
  await weatherController.getCurrentWeather(req, res);
});

// Get historical weather data by location
router.get('/historical/:location', weatherGetLimiter, async (req, res) => {
  await weatherController.getHistoricalWeather(req, res);
});

// backend#1303: latest NWS observation (temperature, humidity, pressure, wind).
router.get('/current/:location', weatherGetLimiter, async (req, res) => {
  await weatherController.getCurrentObservations(req, res);
});

// Get weather forecast by location (enhanced with real APIs)
router.get('/forecast/:location', weatherGetLimiter, async (req, res) => {
  await weatherController.getWeatherForecast(req, res);
});

// Get weather data providers
router.get('/providers', weatherGetLimiter, async (req, res) => {
  try {
    let providers = [];

    // Query real station data grouped by owner
    try {
      const pool = await getPool();
      const result = await pool.query(`
        SELECT
          owner_address,
          COUNT(*) AS station_count,
          BOOL_OR(is_active) AS has_active,
          MAX(updated_at) AS last_update
        FROM weather_stations
        GROUP BY owner_address
        ORDER BY station_count DESC
        LIMIT 50
      `);

      if (result.rows && result.rows.length > 0) {
        providers = result.rows.map((row, idx) => ({
          id: `provider-${idx + 1}`,
          name: `Station Operator ${(row.owner_address || '').slice(0, 10)}...`,
          type: 'station_network',
          stations: Number(row.station_count),
          dataTypes: ['temperature', 'precipitation', 'humidity', 'pressure'],
          coverage: 'regional',
          reliability: row.has_active ? 0.95 : 0.5,
          lastUpdate: row.last_update || new Date().toISOString(),
        }));
      }
    } catch (dbError) {
      logger.warn('DB query failed for weather providers, using fallback', {
        error: dbError.message,
      });
    }

    res.json({
      providers,
      total: providers.length,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error getting weather providers', { error: error.message });
    res.status(500).json(createApiError('WEATHER_ERROR', 'Failed to retrieve weather providers'));
  }
});

// Submit weather data
router.post('/data', weatherPostLimiter, authenticateWeatherRequest, async (req, res) => {
  try {
    const { location, data, source, signature, stationId } = req.body;

    if (!location || !data) {
      return res.status(400).json(createApiError('INVALID_REQUEST', 'Missing required parameters: location, data'));
    }

    // Station ownership verification (#264) — fail-closed
    if (stationId) {
      const userAddress = req.user?.address;
      if (!userAddress || userAddress === 'unknown') {
        return res.status(401).json(createApiError('UNAUTHORIZED', 'Wallet address required for station verification'));
      }
      try {
        const pool = await getPool();
        const result = await pool.query(
          'SELECT 1 FROM weather_stations WHERE station_id = $1 AND lower(owner_address) = lower($2) LIMIT 1',
          [stationId, userAddress]
        );
        if (result.rows.length === 0) {
          return res.status(403).json(createApiError('FORBIDDEN', 'You do not own this weather station'));
        }
      } catch (dbErr) {
        logger.warn('Station ownership check failed, rejecting', {
          error: dbErr.message,
        });
        return res
          .status(503)
          .json(createApiError('SERVICE_UNAVAILABLE', 'Station verification temporarily unavailable'));
      }
    }

    const result = await ingestLegacyWeatherRouteRequest(req, source);
    return res.status(result.status).json(result.body);
  } catch (error) {
    logger.error('Error submitting weather data', { error: error.message });
    res.status(500).json(createApiError('WEATHER_ERROR', 'Failed to submit weather data'));
  }
});

// Register weather station — self-service onboarding (#788).
// Encrypts provider keys at rest, validates them against the live provider, and
// upserts the station so it appears on the contributor map.
router.post('/stations', weatherPostLimiter, authenticateWeatherRequest, async (req, res) => {
  try {
    // Owner is the authenticated wallet, unless an admin token overrides it
    // (needed to register pre-existing contributors).
    let ownerAddress = req.user?.address;
    const adminToken = process.env.ADMIN_TOKEN;
    const presentedAdmin = req.header('x-admin-token');
    const isAdminOverride = Boolean(adminToken && presentedAdmin && secureCompare(presentedAdmin, adminToken));
    if (isAdminOverride && req.body?.ownerAddress) {
      ownerAddress = String(req.body.ownerAddress);
    }

    if (!ownerAddress || ownerAddress === 'unknown') {
      return res.status(401).json(createApiError('UNAUTHORIZED', 'Wallet address required to register a station'));
    }

    let encryptionKey;
    try {
      encryptionKey = getEncryptionKey();
    } catch (keyErr) {
      logger.error('Station registration misconfigured', {
        error: keyErr.message,
      });
      return res.status(500).json(createApiError('SERVER_MISCONFIGURED', 'Encryption key not configured'));
    }

    const { registerStation } = await getStationService();
    const pool = await getPool();
    // Single connection + explicit transaction: the service takes a per-owner
    // pg_advisory_xact_lock over its count-then-insert section, which only
    // serializes anything if the whole call shares one transaction. On a bare
    // pool, each query autocommits and the lock releases at statement end —
    // that is the measured 25-of-10 cap bypass from the PR #1000 review.
    const client = await pool.connect();
    let result;
    try {
      await client.query('BEGIN');
      result = await registerStation(
        req.body || {},
        ownerAddress,
        { pool: client, fetchFn: defaultFetch, encryptionKey },
        (bytes) => crypto.randomBytes(bytes).toString('hex'),
        { isAdminOverride, maxStationsPerOwner: process.env.MAX_STATIONS_PER_OWNER }
      );
      if (result.status < 400) {
        await client.query('COMMIT');
      } else {
        await client.query('ROLLBACK');
      }
    } catch (txError) {
      try { await client.query('ROLLBACK'); } catch { /* connection already gone */ }
      throw txError;
    } finally {
      client.release();
    }
    return res.status(result.status).json(result.body);
  } catch (error) {
    // #1042: code+stack must reach the log — an ERR_MODULE_NOT_FOUND from the
    // lazy service import used to surface here as a generic 500 with only
    // error.message, hiding the real cause.
    const failure = stationServiceFailureResponse('register weather station', error, logger);
    res.status(failure.status).json(createApiError(failure.code, failure.publicMessage));
  }
});

// ---------------------------------------------------------------------------
// Per-phone station registration (backend#1288). Phone-only, tailnet-reachable;
// deliberately NOT on the public funnel allowlist. See
// docs/plans/2026-09-29-per-phone-station-registration-design.md §3.
// ---------------------------------------------------------------------------
let _mobileStationService = null;
async function getMobileStationService() {
  if (!_mobileStationService) {
    _mobileStationService = await import('../services/mobile-station-registration-service.js');
  }
  return _mobileStationService;
}

// Per-wallet limits sit AFTER authentication so the key is the wallet, on top of
// the per-IP weatherPostLimiter. 5 challenges / hour, 10 registrations / hour.
function walletRateLimit(max) {
  return rateLimit({
    windowMs: 60 * 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => `wallet:${String(req.user?.address || 'anonymous').toLowerCase()}`,
    validate: { keyGeneratorIpFallback: false },
    message: { success: false, error: { code: 'RATE_LIMITED', message: 'Too many requests, please try again later' } },
  });
}
const mobileChallengeWalletLimiter = walletRateLimit(5);
const mobileRegisterWalletLimiter = walletRateLimit(10);

async function runMobileStationRoute(req, res, action) {
  try {
    const service = await getMobileStationService();
    const pool = await getPool();
    const store = new service.PgMobileStationStore(pool);
    const deps = {
      ...service.resolveMobileStationChain(),
      now: () => Math.floor(Date.now() / 1000),
      logger,
    };
    const result = await action(service, store, deps);
    const body = result.status < 400 ? { success: true, ...result.body } : result.body;
    return res.status(result.status).json(body);
  } catch (error) {
    const failure = stationServiceFailureResponse('register mobile station', error, logger);
    return res.status(failure.status).json(createApiError(failure.code, failure.publicMessage));
  }
}

router.post(
  '/stations/mobile/challenge',
  weatherPostLimiter,
  authenticateWeatherRequest,
  mobileChallengeWalletLimiter,
  (req, res) =>
    runMobileStationRoute(req, res, (service, store, deps) =>
      service.issueMobileStationChallenge(store, req.user?.address, deps)
    )
);

router.post(
  '/stations/mobile',
  weatherPostLimiter,
  authenticateWeatherRequest,
  mobileRegisterWalletLimiter,
  (req, res) =>
    runMobileStationRoute(req, res, (service, store, deps) =>
      service.registerMobileStation(store, req.user?.address, req.body, deps)
    )
);

// B4: the caller's own registration status (db_only -> submitted -> on_chain).
router.get('/stations/mobile', weatherGetLimiter, authenticateWeatherRequest, (req, res) =>
  runMobileStationRoute(req, res, (service, store) =>
    service.getMobileStationStatus(store, req.user?.address)
  )
);

// Pre-validate a provider API key without writing anything (#788). For the
// frontend onboarding flow.
router.post('/stations/verify-key', weatherPostLimiter, authenticateWeatherRequest, async (req, res) => {
  try {
    const { provider = 'ambient', apiKey, appKey } = req.body || {};
    // Key pre-validation is only possible for providers with a live ingestion
    // path (currently only 'ambient'). Other supported providers (#847) can be
    // registered directly via POST /stations in a 'pending' ingestion state;
    // there is simply no live key check to run for them.
    if (provider !== 'ambient') {
      return res
        .status(400)
        .json(
          createApiError(
            'KEY_VERIFICATION_UNAVAILABLE',
            `key verification is not available for provider '${provider}'; register it directly — it will appear in a 'pending' ingestion state`
          )
        );
    }
    if (!apiKey || !appKey) {
      return res.status(400).json(createApiError('INVALID_REQUEST', 'apiKey and appKey are required'));
    }
    const { verifyAmbientKey } = await getStationService();
    const result = await verifyAmbientKey(defaultFetch, String(apiKey), String(appKey));
    return res.json({ valid: result.valid, devices: result.devices });
  } catch (error) {
    const failure = stationServiceFailureResponse('verify provider key', error, logger);
    res.status(failure.status).json(createApiError(failure.code, failure.publicMessage));
  }
});

// Wallet-scoped evidence projection for onboarding reward progress (#2456).
// The browser receives one backend read model and never joins private core4
// endpoints or local reward estimates into an earnings claim.
router.get('/stations/:stationId/reward-progress', weatherGetLimiter, authenticateWeatherRequest, async (req, res) => {
  try {
    const ownerAddress = req.user?.address;
    if (!ownerAddress || ownerAddress === 'unknown') {
      return res.status(401).json(createApiError('UNAUTHORIZED', 'Wallet address required'));
    }
    let stationId = String(req.params.stationId || '');
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(stationId)) {
      return res.status(400).json(createApiError('INVALID_REQUEST', 'Invalid station ID'));
    }

    const { getStationRewardProgress, StationRewardProgressNotFound } =
      await import('../services/station-reward-progress.js');
    const pool = await getPool();
    // Owner ruling Q5 follow-up: the station page's route id is the public
    // alias, so the (already authenticated) owner may address the station by
    // alias. Resolve it AFTER authentication; the ownership check below is
    // unchanged, so an unknown alias and a station owned by someone else are
    // the same 404 (no enumeration).
    if (isStationAlias(stationId)) {
      const resolved = await resolveStationAlias(
        async (sql, params) => (await pool.query(sql, params)).rows || [],
        stationId
      );
      if (resolved.status !== 'found') {
        return res.status(404).json(createApiError('NOT_FOUND', 'Station not found'));
      }
      stationId = resolved.stationId;
    }
    try {
      const progress = await getStationRewardProgress(pool, stationId, ownerAddress, undefined, {
        chainEvidence: await getChainRewardEvidence(),
      });
      return res.json(progress);
    } catch (error) {
      if (error instanceof StationRewardProgressNotFound) {
        // Do not reveal whether a station exists for a different wallet.
        return res.status(404).json(createApiError('NOT_FOUND', 'Station not found'));
      }
      throw error;
    }
  } catch (error) {
    logger.error('Error reading station reward progress', {
      error: error.message,
    });
    return res.status(503).json(createApiError('SERVICE_UNAVAILABLE', 'Reward progress temporarily unavailable'));
  }
});

// Internal endpoint for the multi-tenant collector (core4#1732). Returns
// DECRYPTED provider credentials. Guarded by the operator bearer token.
router.get('/stations/credentials', async (req, res) => {
  try {
    const operatorToken = process.env.WRFCOIN_OPERATOR_TOKEN;
    const auth = req.header('authorization') || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!operatorToken || !presented || !secureCompare(presented, operatorToken)) {
      return res.status(403).json(createApiError('FORBIDDEN', 'Operator token required'));
    }
    let encryptionKey;
    try {
      encryptionKey = getEncryptionKey();
    } catch (keyErr) {
      logger.error('Credentials endpoint misconfigured', {
        error: keyErr.message,
      });
      return res.status(500).json(createApiError('SERVER_MISCONFIGURED', 'Encryption key not configured'));
    }
    const { listStationCredentials } = await getStationService();
    const pool = await getPool();
    const rows = await listStationCredentials(pool, encryptionKey);
    return res.json(rows);
  } catch (error) {
    const failure = stationServiceFailureResponse('list station credentials', error, logger);
    res.status(failure.status).json(createApiError(failure.code, failure.publicMessage));
  }
});

// Get coverage zones for the data-desert gamification map (mobile#62)
router.get('/coverage-zones', weatherGetLimiter, async (req, res) => {
  try {
    let zones = [];

    // Try to derive zones from real station locations in the DB.
    try {
      const pool = await getPool();
      // #885: GROUP BY on raw lat/lng produces one group per unique coordinate —
      // effectively unbounded (grows with every distinct station location) and
      // can hold a pool connection under launch-time map polling. Round
      // coordinates into ~0.5° grid buckets (matches the 50km zone radius) so the
      // result set is bounded by geography, and cap it with a LIMIT.
      const result = await pool.query(`
        SELECT
          ROUND(latitude::numeric, 1) AS lat_bucket,
          ROUND(longitude::numeric, 1) AS lng_bucket,
          COUNT(*) AS station_count
        FROM weather_stations
        WHERE is_active = true
          AND latitude IS NOT NULL
          AND longitude IS NOT NULL
        GROUP BY lat_bucket, lng_bucket
        ORDER BY station_count DESC
        LIMIT 500
      `);

      if (result.rows && result.rows.length > 0) {
        zones = result.rows.map((row) => {
          const count = Number(row.station_count);
          const type = count >= 3 ? 'covered' : count >= 1 ? 'sparse' : 'desert';
          const multiplier = type === 'desert' ? 2.0 : type === 'sparse' ? 1.5 : 1.0;
          return {
            lat: Number(row.lat_bucket),
            lng: Number(row.lng_bucket),
            radius: 50,
            type,
            rewardMultiplier: multiplier,
          };
        });
      }
    } catch (dbError) {
      logger.warn('DB query failed for coverage-zones, using fallback', {
        error: dbError.message,
      });
    }

    res.json({ zones });
  } catch (error) {
    logger.error('Error getting coverage zones', { error: error.message });
    res.status(500).json({
      error: true,
      message: 'Failed to retrieve coverage zones',
      details: error.message,
    });
  }
});

/**
 * Anonymous display name (#1258 review P2). Registration lets a caller store a
 * name equal to (or containing) the station id, and ids can carry personal
 * names. If the stored name is empty or contains the raw id (case-insensitive),
 * the public name is a neutral label built from the alias; otherwise the
 * operator-chosen name is served. Operator reads keep the stored name.
 */
const PUBLIC_STATION_STATUSES = new Set(['live', 'stale', 'registered', 'active', 'inactive']);
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/;

function isoTimestampOrNull(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (typeof value !== 'string' || !ISO_TIMESTAMP_RE.test(value)) return null;
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function publicStationName(station) {
  const alias = stationAlias(station.stationId);
  const name = typeof station.name === 'string' ? station.name.trim() : '';
  const rawId = String(station.stationId || '').toLowerCase();
  if (name === '' || (rawId !== '' && name.toLowerCase().includes(rawId))) {
    return `Weather station ${alias}`;
  }
  // backend#1397: an owner-entered name's coordinate-like numbers at 0.1 deg.
  return coarsenCoordinatesInName(name);
}

// Get weather stations.
// With lat+lng query params → NOAA/NWS reference stations (unchanged).
// Without coords → registered WRFCoin contributor stations from the DB (#788).
// The coord-less branch is what populates pins on the contributor map.
router.get('/stations', weatherGetLimiter, async (req, res) => {
  // If EITHER coordinate is present, treat this as a nearby-station query and
  // route to getNearbyStations, which returns 400 when one of lat/lng is
  // missing. A partial query (e.g. ?lat=46.8) must NOT silently fall through to
  // the contributor-list branch and return 200 with unrelated stations (#789).
  if (req.query.lat || req.query.lng) {
    return weatherController.getNearbyStations(req, res);
  }

  // Degrade gracefully when the DB schema is incomplete (e.g. the #788 manual
  // migration hasn't been applied yet — latitude/longitude/name columns absent).
  // An empty station list renders a blank map rather than a 500 error page (#814).
  //
  // #885: this SELECT is bounded (LIMIT + keyset pagination) so public map
  // polling cannot hold a connection scanning the whole table and exhaust the
  // 20-conn pool. Clients page via ?limit= and ?after=<last station_id>.
  // backend#1113 / #1222 / owner ruling Q5 (2026-09-27): only an operator
  // bearer sees the internal projection (real station ids, owner, rewards,
  // free-text location, exact coordinates). Everyone else gets the anonymous
  // projection keyed by the public alias (server/utils/station-alias.js):
  // no id/stationId, coordinates coarsened to 0.1 deg, and a cursor that is
  // an alias too, so no response or URL carries a station id.
  const includeOwnerFields = isOperatorRequest(req);
  let page = { stations: [], nextCursor: null, hasMore: false };
  try {
    const { listRegisteredStations } = await getStationService();
    const pool = await getPool();
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
    let after = typeof req.query.after === 'string' && req.query.after !== '' ? req.query.after : null;
    if (after !== null && !includeOwnerFields) {
      const resolved = isStationAlias(after)
        ? await resolveStationAlias(async (sql, params) => (await pool.query(sql, params)).rows || [], after)
        : { status: 'not-found' };
      if (resolved.status !== 'found') {
        return res.status(400).json({
          error: { code: 'INVALID_CURSOR', message: 'after must be a station alias returned as nextCursor' },
        });
      }
      after = resolved.stationId;
    }
    let chainLastSeen;
    try {
      chainLastSeen = await getChainLastSeen();
    } catch (error) {
      logger.warn('Chain station freshness unavailable, using database freshness only', { error: error.message });
    }
    page = await listRegisteredStations(pool, { limit, after, chainLastSeen });
  } catch (error) {
    logger.warn('Could not list contributor stations, returning empty list', {
      error: error.message,
    });
  }
  if (includeOwnerFields) {
    return res.json({
      stations: page.stations.map((station) => ({ ...station, alias: stationAlias(station.stationId) })),
      total: page.stations.length,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
      source: 'wrfcoin-contributors',
    });
  }
  // Explicit allowlist: a field added to the internal projection later can
  // never reach anonymous callers by default.
  // backend#1255/#1263: freshness fields are part of the public projection:
  // status is observation-derived (live|stale|registered), lastDataUpdate the
  // latest observation time (ISO) or null, isActive the separate registration
  // flag. Each is type-validated, and scrubRawId() runs on every item.
  const stations = page.stations.map((station) =>
    scrubRawId(
      {
        alias: stationAlias(station.stationId),
        name: publicStationName(station),
        latitude: coarsenCoordinate(station.latitude),
        longitude: coarsenCoordinate(station.longitude),
        status: PUBLIC_STATION_STATUSES.has(station.status) ? station.status : null,
        lastDataUpdate: isoTimestampOrNull(station.lastDataUpdate),
        isActive: typeof station.isActive === 'boolean' ? station.isActive : null,
        qualityScore: station.qualityScore,
      },
      station.stationId
    )
  );
  return res.json({
    stations,
    total: stations.length,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor ? stationAlias(page.nextCursor) : null,
    source: 'wrfcoin-contributors',
  });
});

// backend#1289: weather-alerts-routes (mounted at /api AFTER this router) owns
// GET /api/weather/alerts/active and /history. Without this skip, those two
// segments were caught here as a location and answered 400. next('route')
// skips the rest of this route (the limiter too), so only those two paths
// change; /alerts/<lat,lon> and /alerts/<name>?lat=&lng= are served as before.
const ALERTS_ROUTER_SEGMENTS = new Set(['active', 'history']);

function skipAlertsRouterSegments(req, _res, next) {
  return next(ALERTS_ROUTER_SEGMENTS.has(req.params.location) ? 'route' : undefined);
}

// Get weather alerts for a location
router.get('/alerts/:location', skipAlertsRouterSegments, weatherGetLimiter, async (req, res) => {
  await weatherController.getWeatherAlerts(req, res);
});

// Get health status of weather services.
// backend#1224: the body reports NOAA token configuration, rate counters and
// upstream error text, and every hit makes two outbound NOAA calls — operator
// or reader bearer token only.
router.get('/health', requireOperatorOrReaderToken, async (req, res) => {
  await weatherController.getServicesHealth(req, res);
});

module.exports = router;
