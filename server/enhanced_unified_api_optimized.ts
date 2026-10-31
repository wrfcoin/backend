// OpenTelemetry must be initialized before other imports for auto-instrumentation
import './utils/otel-startup.js';

import * as http from 'http';
import * as url from 'url';
import * as querystring from 'querystring';
import { createRequire } from 'node:module';
import type { IncomingMessage, ServerResponse } from 'http';
import type { ParsedUrlQuery } from 'querystring';
import { applyRawCorsHeaders } from '../shared/middleware/cors-config.js';
import {
  createRateLimitMiddleware,
  RATE_LIMIT_PRESETS,
  apiIpBudgetKey,
} from '../shared/middleware/rate-limit-redis.js';
import { applyApiSecurityHeaders } from '../shared/middleware/security-headers.js';
import { appLogger } from './utils/logger.js';
import { getCore4ApiUrl } from '../src/config/core4.js';
import { validateJwtSecret as _validateJwtSecret } from './utils/jwtSecretValidation.js';
import helmet from 'helmet';
import {
  GracefulShutdown,
  ShutdownPriority,
  createHttpServerShutdownHandler,
} from '../shared/graceful-shutdown/index.js';
import {
  resilienceCoreService,
  SyntheticIncidentState,
  ParticipationAuditEvent,
  RelayObservation,
  ForecastCoverageSnapshot,
} from './services/resilience-core-service.js';
import { environmentPhase2ReportsService } from './services/environment-phase2-reports-service.js';
import { smsObservationGatewayService } from './services/sms-observation-gateway-service.js';
import {
  completeSocialLogin,
  verifyGithubIdentity,
  verifyGoogleIdToken,
} from './services/social-auth-service.js';
import {
  checkInUser,
  getStreakBadges,
  getStreakSummary,
} from './services/streak-service.js';
import {
  getWormholeTransfer,
  isWormholeBridgeEnabled,
  initiateOutboundTransfer,
  processInboundTransfer,
} from './services/wormhole-transfer-service.js';
import {
  createWeatherCommitRevealService,
  startCommitmentExpiryJob,
} from './routes/weather-commit-reveal-routes.js';
import { connectWithRetry } from '../database/connection.js';
import {
  canonicalObservationToSensorData,
} from '../shared/weather-payload-canonical.js';
import { ingestWeatherPayload } from './services/weather-ingestion-service.js';
import { resolveWeatherSubmitGate } from './services/weather-submit-auth-migration.js';
import { executeQuery, executeTransaction, queryClient } from '../database/connection.js';
import {
  createDbHealthProbe,
  type CancellableProbeQuery,
} from './utils/db-health-probe.js';
import { createWalletAuthService, WalletNonceRateLimitError } from './routes/wallet-auth-service.js';
import {
  initializeRealtimeWebSocketServer,
  type RealtimeWebSocketHub,
} from './websocket/index.js';
import { ensureEnvironmentalRiskBaseline } from '../database/environmental-risk-bootstrap.js';
import { verifySchemaIntegrity } from '../database/schema-verify.js';
import { handleWeatherExportRequest } from './routes/export-routes.js';
import oracleSubmitRoutes from './routes/oracle-submit-routes.js';
import { Registry, collectDefaultMetrics } from 'prom-client';
import { handleStationDiscoveryRequest } from './routes/station-discovery-routes.js';
import { buildLiveStats } from './utils/live-stats.js';
import { notWiredEnvelope } from './middleware/require-wired-storage.js';
import { hasOperatorOrReaderToken, hasOperatorToken } from './middleware/operator-token-auth.js';
import { anonymousCoordinateGuard } from './middleware/anonymous-coordinate-guard.js';
import {
  extractCore4Data as extractCore4DataForStats,
  fetchCore4Json as fetchCore4JsonForStats,
  toNullable as toNullableForStats,
} from '../shared/core4-route-client.js';
import express from 'express';
import { createEnhancedApiOperationalProbes } from './enhanced_unified_api_operational_probes.js';
import { authenticateJWT } from './middleware/auth.js';
import {
  authenticateApiKey as authenticateCrossPostApiKey,
  authenticateToken as authenticateCrossPostToken,
} from './middleware/auth-middleware.js';
import { createWrfsentinelCrossPostRouter } from './routes/wrfsentinel-crosspost-routes.js';
import { wrfsentinelCrossPostStore } from './services/wrfsentinel-crosspost-store.js';
import {
  OracleWorkBroker,
} from './services/oracle-work-broker.js';
import {
  createOracleWorkRouter,
} from './routes/oracle-work-routes.js';
// mobile#256: operator-profile-routes exports a FACTORY (createOperatorProfileRouter(db?)),
// so it cannot go through safeMount (which would app.use() the factory itself as
// middleware). Mounted explicitly below, next to the other factory router.
import { createOperatorProfileRouter } from './routes/operator-profile-routes.js';
import { createStationDetailRouter } from './routes/station-detail-routes.js';
import { createStationOwnerRouter, captureOwnerActionRawBody } from './routes/station-owner-routes.js';
import { createWrfForecastNotWiredRouter } from './routes/wrf-forecast-not-wired-routes.js';
// backend#1134: the four factory-built ingestion routers were only ever mounted on
// the compute_networks_server (port 6000), never on this live main-api entrypoint.
// They export factories (createXRouter(service?, { requireAuth })) — and two of
// them have no default export at all — so safeMount cannot mount them; mounted
// explicitly below with their default service + auth, exactly as compute does.
import { createSatelliteIngestionRouter } from './routes/satellite-ingestion-routes.js';
import { createUsgsEarthquakeIngestionRouter } from './routes/usgs-earthquake-ingestion-routes.js';
import { createUsgsWaterIngestionRouter } from './routes/usgs-water-ingestion-routes.js';
import { createNrcsSoilIngestionRouter } from './routes/nrcs-soil-ingestion-routes.js';
import { requireOracleWorkRoutingDependencies } from './services/oracle-work-routing-gate.js';
// core4-launch-health.js and trustedProxyConfig.js are CJS (module.exports).
// In a "type":"module" package, .js files are treated as ESM — no named/default
// exports are visible. Import the .cjs shims generated by copy-build-assets.mjs.
import _launchHealthMod from './utils/core4-launch-health.js';
const { probeCore4Health, probeCore4Readiness } = _launchHealthMod as {
  probeCore4Health: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  probeCore4Readiness: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
};
import trustedProxyConfig from './utils/trustedProxyConfig.js';
import { createApiError } from './utils/api-error.js';

const require = createRequire(import.meta.url);
const { trustKnownProxy, normalizeTailnetClientIp } = trustedProxyConfig as {
  trustKnownProxy: (ip: string) => boolean;
  normalizeTailnetClientIp: express.RequestHandler;
};

// Extended IncomingMessage with body property
interface ExtendedIncomingMessage extends IncomingMessage {
  body?: any;
}

// Import cache and monitoring modules (with fallback types)
let cacheManager: any;
let monitoringDashboard: any;

try {
  cacheManager = require('./middleware/cache-performance').cacheManager;
  monitoringDashboard = require('./monitoring/dashboard').monitoringDashboard;
} catch (e) {
  // Fallback mock implementations
  cacheManager = {
    memoize: (fn: any, options: any) => fn,
    get: async (key: string) => null,
    set: async (key: string, value: any, ttl?: number) => {},
    clear: async () => {},
    getMetrics: () => ({ cacheHits: 0, cacheMisses: 0 }),
    getHealthStatus: () => ({ status: 'healthy' }),
    compressionMiddleware: () => (req: any, res: any, next: any) => next(),
    performanceMiddleware: () => (req: any, res: any, next: any) => next(),
    rateLimitMiddleware: () => (req: any, res: any, next: any) => next(),
  };

  monitoringDashboard = {
    recordRequest: (
      path: string,
      responseTime: number,
      cached: boolean,
      error: boolean
    ) => {},
    generateHTMLDashboard: () =>
      '<html><body><h1>Monitoring Dashboard</h1></body></html>',
  };
}

// Type definitions for currency rates
const PORT = process.env.PORT || 3001;
const prometheusRegistry = new Registry();
prometheusRegistry.setDefaultLabels({ app: 'wrfcoin-backend' });
collectDefaultMetrics({ register: prometheusRegistry, prefix: 'wrfcoin_backend_' });

const enhancedApiRateLimit = createRateLimitMiddleware({
  ...RATE_LIMIT_PRESETS.api,
  message: 'Too many requests from this IP, please try again later.',
});
// backend#1440: one budget per client address across every path, so varying the path cannot mint a fresh bucket.
const enhancedApiIpRateLimit = createRateLimitMiddleware({
  ...RATE_LIMIT_PRESETS.apiIp,
  keyGenerator: apiIpBudgetKey,
  message: 'Too many requests from this IP, please try again later.',
});
// Audit browsing has its own read budget and never spends login attempts.
const bondGrantAuditReadRateLimit = createRateLimitMiddleware({
  ...RATE_LIMIT_PRESETS.api,
  keyPrefix: 'ratelimit:faucet-bond-grants',
  message: 'Too many bond grant history requests, please try again later.',
});
const walletLoginRateLimit = createRateLimitMiddleware({
  ...RATE_LIMIT_PRESETS.auth,
  message: 'Too many wallet login attempts, please try again later.',
});

type QueryExecutor = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

interface SafeMountRecord {
  mountPath: string;
  modulePath: string;
  required: boolean;
  mounted: boolean;
  error?: string;
}

// Lazy dynamic import — avoids "require is not defined" in ESM bundles (#268)
let cachedDbExecutor: QueryExecutor | null | undefined;
async function resolveDbExecutor(): Promise<QueryExecutor | null> {
  if (cachedDbExecutor !== undefined) return cachedDbExecutor;
  try {
    const mod = await import('../database/index.js');
    cachedDbExecutor = mod.executeQuery as QueryExecutor;
  } catch {
    cachedDbExecutor = null;
  }
  return cachedDbExecutor;
}

// Lazy-initialized in startEnhancedUnifiedApiServer() to avoid blocking the
// event loop at module-scope when running inside an esbuild CJS bundle (#267).
let weatherCommitRevealService: ReturnType<typeof createWeatherCommitRevealService>;
let walletAuthService: ReturnType<typeof createWalletAuthService>;
let stopCommitmentExpiryJob: () => void;
let realtimeWsHub: RealtimeWebSocketHub | null = null;


// backend#1145: the former MOCK_DATA_GENERATORS / memoizedOperations block
// (random-number stats, security metrics, currency rates, mining and NFT
// figures served as live data) was removed. /api/stats is built by
// ./utils/live-stats.js from core4 + weather_stations; /api/security/metrics
// and /api/currency/* answer 501 NOT_IMPLEMENTED until a real source exists.
async function countActiveWeatherStations(): Promise<number> {
  const { rows } = await executeQuery(
    'SELECT COUNT(*)::int AS n FROM weather_stations WHERE is_active = true'
  );
  return Number(rows[0]?.n);
}

// Enhanced API server with comprehensive caching and performance optimization
const app = express();
app.set('trust proxy', trustKnownProxy);
// backend S-A3: one rate-limit bucket per tailnet device, not one per tailnet (IPv6 /56 collapse).
app.use(normalizeTailnetClientIp);

// Probe state for graceful drain signalling
const enhancedApiProbeState = { draining: false };

// Apply rate limiting early to protect the entire server
app.use(enhancedApiIpRateLimit);
app.use(enhancedApiRateLimit);
app.use(helmet());
app.use(['/api/auth/nonce', '/api/auth/wallet-login', '/api/faucet/bond-grant'], walletLoginRateLimit);
app.use('/api/faucet/bond-grants', bondGrantAuditReadRateLimit);

// CORS + security headers (same functions as raw handler)
app.use((req, res, next) => {
  applyRawCorsHeaders(res, req.headers.origin);
  applyApiSecurityHeaders(res);
  res.setHeader('Content-Type', 'application/json');
  next();
});

// backend#1222 (owner ruling 2026-10-01): no anonymous response body carries a
// coordinate finer than 0.1 degree, echoes and coordinate-bearing strings
// included. Mounted before every route so none can be missed; authorized
// callers (operator token, an authenticated user) keep exact values.
app.use(anonymousCoordinateGuard);

// Handle preflight
app.options('*', (_req, res) => { res.status(200).end(); });

// Body parsing (replaces manual req.on('data') accumulation)
// station owner-action relay forwards the caller's exact bytes (never re-serialised): keep the raw body.
// Email observation gateway (backend-archive#1495): 16 KiB parse limit on its own path, ahead
// of the global 1 MB parsers (which then skip the already-parsed body).
app.use('/api/transport/email', express.json({ limit: '16kb' }), express.urlencoded({ extended: false, limit: '16kb' }));
// Wolfram reading check (bring-your-own-key): the body carries the caller's own AppID, so it is read
// raw (2 KiB) ahead of the global JSON parser, whose parse errors could quote it.
app.use('/api/integrations/wolfram/reading-check', express.raw({ type: () => true, limit: 2048 }));
app.use(express.json({ limit: '1mb', verify: captureOwnerActionRawBody }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// Disabled by default. Enabling requires deployment-owned verified worker and
// Core4 readback adapters; user JWTs and request properties are not adapters.
const oracleWorkRouting = requireOracleWorkRoutingDependencies(
  process.env.WRFCOIN_ENABLE_ORACLE_WORK === 'true',
  {},
);
// mobile#256: mobile's ApiConstants.operatorProfile() calls
// GET /api/operators/:walletAddress/profile; the router existed (with its own
// test) but was only ever mounted in the non-live unified_api_server.ts — and
// even there as the factory function, not a router. Uses the default db.
app.use('/api/operators', createOperatorProfileRouter());
// backend#1168: canonical station observations/quality/submissions and an
// explicit unavailable earnings envelope on the deployed entrypoint.
app.use('/api', createStationDetailRouter());
// Station theft protection: signed owner-action relay + ownership state (spec r23/station-owner-actions-spec.md).
app.use('/api', createStationOwnerRouter());
// backend#1289 (b3): /api/v1/weather/wrf-forecast/* answers the not-wired 501
// instead of the catch-all 404.
app.use('/api', createWrfForecastNotWiredRouter());

if (oracleWorkRouting) {
  app.use('/private/oracle-work', createOracleWorkRouter({
    broker: new OracleWorkBroker({ execute: executeQuery, transaction: executeTransaction }),
    ...oracleWorkRouting,
  }));
}

// Direct Postgres liveness probe (#910), with genuine query cancellation on
// timeout so repeated /health polls against a stalled Postgres cannot
// accumulate work in the shared pool (see server/utils/db-health-probe.ts).
const probeDatabaseHealth = createDbHealthProbe(
  () => queryClient.unsafe('SELECT 1') as unknown as CancellableProbeQuery,
);

async function getOperationalHealthSnapshot() {
  const cacheHealth = cacheManager.getHealthStatus();
  const cacheStatus =
    typeof cacheHealth?.status === 'string' ? cacheHealth.status : 'unknown';
  const [core4, database] = await Promise.all([
    probeCore4Health({
      baseUrl: getCore4ApiUrl(),
    }),
    probeDatabaseHealth(),
  ]);
  // Cache is a soft/non-fatal dependency (#812): a degraded or absent cache
  // (e.g. Redis not yet connected at boot) must not cause /health to return 503.
  // core4 unavailability makes the service unhealthy, and so does Postgres
  // (#910): before this probe existed, /health reported healthy with the
  // database fully down, and no running test could catch the false positive.
  const status = core4.status !== 'up' || database.status !== 'up' ? 'unhealthy' : 'healthy';

  return {
    status,
    dependencies: {
      cache: {
        status:
          cacheStatus === 'healthy'
            ? 'up'
            : cacheStatus === 'degraded'
              ? 'degraded'
              : 'down',
        details: cacheHealth,
      },
      core4,
      database,
    },
    services: {
      cache: cacheHealth,
      core4,
      database,
    },
    timestamp: new Date().toISOString(),
  };
}

// Fix #289: Docker healthcheck curls /health but only /api/health existed
// Fix #437/#470: return 503 for unhealthy OR degraded (not just unhealthy)
app.get('/health', async (req, res) => {
  const health = await getOperationalHealthSnapshot();
  const httpStatus = health.status === 'healthy' ? 200 : 503;
  // backend#1224: the snapshot names the internal core4 URL and carries DB
  // error text. Healthchecks read only the HTTP code, so anonymous callers get
  // the status word; operator/reader bearer tokens get the full snapshot.
  if (!hasOperatorOrReaderToken(req)) {
    res.status(httpStatus).json({
      success: httpStatus === 200,
      status: health.status,
      timestamp: new Date().toISOString(),
    });
    return;
  }
  res.status(httpStatus).json({
    success: httpStatus === 200,
    data: health,
    message: httpStatus === 200 ? 'Success' : 'Service degraded or unhealthy',
    timestamp: new Date().toISOString(),
  });
});

const safeMountAudit: SafeMountRecord[] = [];
// /api/keys is not on the testnet surface (no frontend or mobile client calls it) and refuses to start without
// ENCRYPTION_KEY, so its absence is reported as optional, not as a missing required family (backend#1318).
const safeMountOptionalAllowlist = new Set(['/api/n8n', '/api/keys']);

function safeMountReadinessSnapshot(): {
  requiredMissing: Array<{ mountPath: string; modulePath: string; reason: string }>;
  optionalMissing: Array<{ mountPath: string; modulePath: string; reason: string }>;
} {
  const requiredMissing = safeMountAudit
    .filter((entry) => entry.required && !entry.mounted)
    .map((entry) => ({
      mountPath: entry.mountPath,
      modulePath: entry.modulePath,
      reason: entry.error ?? 'safeMount threw during bootstrap',
    }));

  const optionalMissing = safeMountAudit
    .filter((entry) => !entry.required && !entry.mounted)
    .map((entry) => ({
      mountPath: entry.mountPath,
      modulePath: entry.modulePath,
      reason: entry.error ?? 'safeMount threw during bootstrap',
    }));

  return { requiredMissing, optionalMissing };
}

// Fix #437/#470: Mount operational probes at /api so /api/ready and /api/live are accessible
const enhancedApiProbes = createEnhancedApiOperationalProbes({
  state: enhancedApiProbeState,
  getCacheHealthStatus: () => cacheManager.getHealthStatus(),
  // #758: readiness (/api/ready) gates on core4 /readyz so the API cannot
  // signal GO while the chain is not launch-ready. /health stays liveness.
  probeCore4Readiness: () => probeCore4Readiness({ baseUrl: getCore4ApiUrl() }),
  safeMountReadiness: safeMountReadinessSnapshot,
});

app.use('/api', enhancedApiProbes.router);

const server = http.createServer(app);

function getHeaderValue(
  header: string | string[] | undefined
): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

async function requireAuthenticatedRequest(
  req: ExtendedIncomingMessage,
  error: (statusCode: number, message: string, details?: any, code?: string) => void
): Promise<boolean> {
  let authorized = false;
  let statusCode = 401;
  let body: any = null;

  const authReq = req as typeof req & {
    get: (name: string) => string | undefined;
  };
  authReq.get = (name: string) => getHeaderValue(req.headers[name.toLowerCase()]);

  const authRes = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      return this;
    },
  };

  await authenticateJWT(authReq as any, authRes as any, () => {
    authorized = true;
  });

  if (authorized) {
    return true;
  }

  const authError = body?.error;
  error(
    statusCode,
    authError?.message || authError || 'Authentication required',
    body?.details ?? null,
    'AUTH_REQUIRED'
  );
  return false;
}

async function handleRequest(
  req: ExtendedIncomingMessage,
  res: ServerResponse,
  path: string,
  query: ParsedUrlQuery,
  startTime: number
) {
  const respond = (statusCode: number, data: any) => {
    const responseTime = Date.now() - startTime;
    res.setHeader('X-Response-Time', `${responseTime}ms`);
    res.writeHead(statusCode);
    res.end(JSON.stringify(data));
  };

  const success = (
    data: any,
    message: string = 'Success',
    statusCode: number = 200
  ) =>
    respond(statusCode, {
      success: true,
      data,
      message,
      timestamp: new Date().toISOString(),
    });

  // #909: one envelope for the whole API surface. This handler used to emit a
  // flat `error: "<string>"`, while safeMounted routers already used
  // createApiError's `error: { code, message, details }`, so a client had to
  // parse two shapes depending on which handler served it.
  const error = (
    statusCode: number,
    message: string,
    details: any = null,
    code: string = 'REQUEST_ERROR'
  ) => respond(statusCode, createApiError(code, message, details));

  // backend#1145: honest-gap envelope (same shape as backend#1118's
  // sendNotWired) for routes with no real source behind them.
  const notWired = (capability: string, message: string, details?: string, see?: string) =>
    respond(501, notWiredEnvelope({ capability, message, details, see }));

  // Record request for monitoring
  const requestStart = Date.now();

  try {
    // Performance and monitoring endpoints
    if (
      (path === '/metrics' || path === '/api/dashboard') &&
      req.method === 'GET' &&
      !hasOperatorOrReaderToken(req)
    ) {
      // backend#1224: process metrics and the per-path request dashboard are
      // operator surfaces. Prometheus scrapes with the reader token.
      error(401, 'Operator or reader bearer token required', null, 'UNAUTHORIZED');
      return;
    } else if (path === '/metrics' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': prometheusRegistry.contentType });
      res.end(await prometheusRegistry.metrics());
      return;
    } else if (path === '/api/dashboard' && req.method === 'GET') {
      const responseTime = Date.now() - requestStart;
      monitoringDashboard.recordRequest(path, responseTime, false, false);

      res.setHeader('Content-Type', 'text/html');
      res.writeHead(200);
      res.end(monitoringDashboard.generateHTMLDashboard());
      return;
    } else if (path === '/api/performance/metrics' && req.method === 'GET') {
      const responseTime = Date.now() - requestStart;
      monitoringDashboard.recordRequest(path, responseTime, false, false);

      const metrics = cacheManager.getMetrics();
      success(metrics);
    } else if (path === '/api/health' && req.method === 'GET') {
      const responseTime = Date.now() - requestStart;
      monitoringDashboard.recordRequest(path, responseTime, false, false);

      const health = await getOperationalHealthSnapshot();
      if (health.status !== 'healthy') {
        error(503, 'Core4 dependency unavailable', health);
      } else {
        success(health);
      }
    } else if (
      req.method === 'GET' &&
      (path === '/api/v1/data-catalog' ||
        path === '/api/v1/export/region' ||
        path.startsWith('/api/v1/export/stations/'))
    ) {
      const executeQuery = await resolveDbExecutor();
      if (!executeQuery) {
        error(503, 'Database unavailable for export endpoints');
        return;
      }

      const handled = await handleWeatherExportRequest({
        path,
        method: req.method,
        query,
        req,
        res,
        executeQuery,
      });

      if (handled) {
        const responseTime = Date.now() - requestStart;
        monitoringDashboard.recordRequest(path, responseTime, false, false);
        return;
      }
    } else if (
      (path === '/api/v1/stations/discover' && req.method === 'POST') ||
      (path === '/api/v1/stations/provision' && req.method === 'POST') ||
      (path === '/api/v1/stations/status' && req.method === 'GET') ||
      (/^\/api\/v1\/stations\/[^/]+\/verify$/.test(path) &&
        req.method === 'POST') ||
      (/^\/api\/v1\/stations\/[^/]+$/.test(path) && req.method === 'DELETE')
    ) {
      const executeQuery = await resolveDbExecutor();
      if (!executeQuery) {
        error(503, 'Database unavailable for station discovery endpoints');
        return;
      }

      const handled = await handleStationDiscoveryRequest({
        path,
        method: req.method,
        query,
        req,
        res,
        body: req.body,
        executeQuery,
      });

      if (handled) {
        const responseTime = Date.now() - requestStart;
        monitoringDashboard.recordRequest(path, responseTime, false, false);
        return;
      }
    } else if (
      path === '/api/resilience/participation/compliance' &&
      req.method === 'GET'
    ) {
      success(resilienceCoreService.getParticipationComplianceStatus());
    } else if (
      path === '/api/resilience/participation/audit-events' &&
      req.method === 'POST'
    ) {
      if (!(await requireAuthenticatedRequest(req, error))) {
        return;
      }
      const event = req.body as ParticipationAuditEvent;
      if (
        !event?.source ||
        !event?.ruleId ||
        !event?.action ||
        !event?.reasonCode ||
        !event?.reasonText
      ) {
        error(
          400,
          'source, ruleId, action, reasonCode, reasonText are required'
        );
      } else {
        success(
          resilienceCoreService.addParticipationAuditEvent(event),
          'Audit event recorded'
        );
      }
    } else if (
      path === '/api/resilience/relay/health' &&
      req.method === 'GET'
    ) {
      success(resilienceCoreService.getRelayHealth());
    } else if (
      path === '/api/resilience/relay/observations' &&
      req.method === 'POST'
    ) {
      if (!(await requireAuthenticatedRequest(req, error))) {
        return;
      }
      const observation = req.body as RelayObservation;
      if (
        !observation?.routeId ||
        !observation?.provider ||
        !observation?.region ||
        typeof observation?.reachable !== 'boolean'
      ) {
        error(400, 'routeId, provider, region, reachable are required');
      } else {
        success(
          resilienceCoreService.addRelayObservation(observation),
          'Relay observation recorded'
        );
      }
    } else if (
      path === '/api/resilience/incidents/synthetic' &&
      req.method === 'GET'
    ) {
      // backend#1224: incident objects are moderation data; same auth as the
      // POST that creates them.
      if (!(await requireAuthenticatedRequest(req, error))) {
        return;
      }
      success(resilienceCoreService.listSyntheticIncidents());
    } else if (
      path === '/api/resilience/incidents/synthetic' &&
      req.method === 'POST'
    ) {
      if (!(await requireAuthenticatedRequest(req, error))) {
        return;
      }
      const { campaignType, severity, actorClass, summary } = req.body || {};
      if (!campaignType || !severity || !actorClass || !summary) {
        error(400, 'campaignType, severity, actorClass, summary are required');
      } else {
        success(
          resilienceCoreService.createSyntheticIncident({
            campaignType,
            severity,
            actorClass,
            summary,
          }),
          'Synthetic incident created'
        );
      }
    } else if (
      path.startsWith('/api/resilience/incidents/synthetic/') &&
      path.endsWith('/transition') &&
      req.method === 'POST'
    ) {
      if (!(await requireAuthenticatedRequest(req, error))) {
        return;
      }
      const id = path
        .replace('/api/resilience/incidents/synthetic/', '')
        .replace('/transition', '');
      const nextState = req.body?.state as SyntheticIncidentState | undefined;
      const note = (req.body?.note as string | undefined) || '';

      if (!id || !nextState) {
        error(400, 'incident id and state are required');
      } else {
        try {
          success(
            resilienceCoreService.transitionSyntheticIncident(id, nextState, note),
            'Synthetic incident transitioned'
          );
        } catch (e) {
          error(400, e instanceof Error ? e.message : 'transition failed');
        }
      }
    } else if (
      path === '/api/resilience/transparency/ledger' &&
      req.method === 'GET'
    ) {
      success(resilienceCoreService.getTransparencyLedger());
    } else if (
      path === '/api/resilience/permissionless/health' &&
      req.method === 'GET'
    ) {
      success(resilienceCoreService.getPermissionlessHealth());
    } else if (
      path === '/api/resilience/kpi/forecast-coverage/snapshots' &&
      req.method === 'POST'
    ) {
      if (!(await requireAuthenticatedRequest(req, error))) {
        return;
      }
      const snapshot = req.body as ForecastCoverageSnapshot;
      if (
        !snapshot?.domain ||
        typeof snapshot?.reportCount !== 'number' ||
        typeof snapshot?.confidenceScore !== 'number'
      ) {
        error(400, 'domain, reportCount, confidenceScore are required');
      } else {
        try {
          success(
            resilienceCoreService.addForecastCoverageSnapshot(snapshot),
            'Forecast coverage snapshot recorded'
          );
        } catch (e) {
          error(400, e instanceof Error ? e.message : 'invalid forecast snapshot');
        }
      }
    } else if (
      path === '/api/resilience/kpi/forecast-coverage' &&
      req.method === 'GET'
    ) {
      success(resilienceCoreService.getForecastCoverageKpi());
    } else if (
      path === '/api/resilience/kpi/actor-integrity' &&
      req.method === 'GET'
    ) {
      success(resilienceCoreService.getActorIntegrityKpi());
    } else if (
      path === '/api/resilience/kpi/sanctions-parity' &&
      req.method === 'GET'
    ) {
      success(resilienceCoreService.getSanctionsParityKpi());
    } else if (
      path === '/api/resilience/kpi/participation-accessibility' &&
      req.method === 'GET'
    ) {
      success(resilienceCoreService.getParticipationAccessibilityKpi());
    } else if (
      path === '/api/resilience/kpi/alignment-summary' &&
      req.method === 'GET'
    ) {
      success(resilienceCoreService.getAlignmentKpiSummary());
    } else if (
      path === '/api/environment/reports/soil/ingest' &&
      req.method === 'POST'
    ) {
      if (!(await requireAuthenticatedRequest(req, error))) {
        return;
      }
      try {
        success(environmentPhase2ReportsService.ingestSoil(req.body), 'Soil report ingested');
      } catch (e) {
        error(400, e instanceof Error ? e.message : 'invalid soil report');
      }
    } else if (
      path === '/api/environment/reports/ocean/ingest' &&
      req.method === 'POST'
    ) {
      if (!(await requireAuthenticatedRequest(req, error))) {
        return;
      }
      try {
        success(environmentPhase2ReportsService.ingestOcean(req.body), 'Ocean report ingested');
      } catch (e) {
        error(400, e instanceof Error ? e.message : 'invalid ocean report');
      }
    } else if (
      path === '/api/environment/reports/hydrology/ingest' &&
      req.method === 'POST'
    ) {
      if (!(await requireAuthenticatedRequest(req, error))) {
        return;
      }
      try {
        success(
          environmentPhase2ReportsService.ingestHydrology(req.body),
          'Hydrology report ingested'
        );
      } catch (e) {
        error(400, e instanceof Error ? e.message : 'invalid hydrology report');
      }
    } else if (
      path === '/api/environment/reports/reports' &&
      req.method === 'GET'
    ) {
      success(
        environmentPhase2ReportsService.listReports({
          domain: query.domain as any,
          region: query.region as string | undefined,
          limit: query.limit ? Number(query.limit) : undefined,
        })
      );
    } else if (
      path === '/api/environment/reports/summary' &&
      req.method === 'GET'
    ) {
      success(environmentPhase2ReportsService.getPhase2Overview());
    } else if (
      path.startsWith('/api/environment/reports/summary/') &&
      req.method === 'GET'
    ) {
      const domain = path.replace('/api/environment/reports/summary/', '') as
        | 'soil'
        | 'ocean'
        | 'hydrology';
      if (!['soil', 'ocean', 'hydrology'].includes(domain)) {
        error(400, 'domain must be one of: soil, ocean, hydrology');
      } else {
        success(environmentPhase2ReportsService.getDomainSummary(domain));
      }
    } else if (
      path === '/api/environment/reports/docs' &&
      req.method === 'GET'
    ) {
      success({
        schemaVersion: 'env-phase2-v1',
        endpoints: [
          { method: 'POST', path: '/api/environment/reports/soil/ingest' },
          { method: 'POST', path: '/api/environment/reports/ocean/ingest' },
          { method: 'POST', path: '/api/environment/reports/hydrology/ingest' },
          { method: 'GET', path: '/api/environment/reports/reports' },
          { method: 'GET', path: '/api/environment/reports/summary' },
          { method: 'GET', path: '/api/environment/reports/summary/:domain' },
          { method: 'GET', path: '/api/environment/reports/docs' },
        ],
      });
    } else if (
      path === '/api/transport/sms/observations' &&
      req.method === 'POST'
    ) {
      const inbound = {
        messageId:
          req.body?.messageId ||
          req.body?.message_id ||
          req.body?.MessageSid ||
          req.body?.sms_message_id,
        sender:
          req.body?.sender ||
          req.body?.sender_id ||
          req.body?.from ||
          req.body?.From,
        text: req.body?.text || req.body?.body || req.body?.Body,
        receivedAt: req.body?.receivedAt || req.body?.received_at,
      };
      if (!inbound.messageId || !inbound.sender || !inbound.text) {
        error(
          400,
          'messageId/message_id/MessageSid, sender/from/From, and text/body/Body are required'
        );
      } else {
        try {
          const entry = await smsObservationGatewayService.ingestInboundMessage(inbound);
          success(entry, 'SMS observation ingested');
        } catch (e) {
          error(400, e instanceof Error ? e.message : 'invalid SMS observation payload');
        }
      }
    } else if (
      path === '/api/transport/sms/observations/queue' &&
      req.method === 'GET'
    ) {
      if (!hasOperatorToken(req)) {
        error(401, 'Operator bearer token required', null, 'UNAUTHORIZED');
        return;
      }
      success(smsObservationGatewayService.listQueue(), 'SMS observation queue');
    } else if (path === '/api/cache/clear' && req.method === 'POST') {
      if (!hasOperatorToken(req)) {
        error(401, 'Operator bearer token required', null, 'UNAUTHORIZED');
        return;
      }
      const responseTime = Date.now() - requestStart;
      monitoringDashboard.recordRequest(path, responseTime, false, false);

      await cacheManager.clear();
      success({ cleared: true }, 'Cache cleared successfully');
    } else if (path.startsWith('/api/auth/nonce/') && req.method === 'GET') {
      const address = path.split('/').pop()!;
      try {
        // ?scheme=ed25519 issues the first-party ed25519 challenge; no
        // scheme (or evm/secp256k1) keeps the original EVM challenge.
        const challenge = await walletAuthService.generateNonce(address, query?.scheme);
        success(challenge, 'Wallet login challenge generated');
      } catch (e) {
        if (e instanceof WalletNonceRateLimitError) {
          res.setHeader('Retry-After', String(e.retryAfterSec));
          error(429, e.message, null, 'RATE_LIMIT_EXCEEDED');
        } else {
          error(400, e instanceof Error ? e.message : 'Nonce generation failed');
        }
      }
    } else if (path === '/api/auth/wallet-login' && req.method === 'POST') {
      try {
        const auth = await walletAuthService.walletLogin(req.body ?? {});
        success(auth, 'Wallet login successful');
      } catch (e) {
        // Defense in depth: no exception text on the wire; details stay in the server log.
        appLogger.warn('wallet login failed', {
          error: e instanceof Error ? e.message : String(e),
        });
        error(401, 'Wallet login failed', null, 'WALLET_LOGIN_FAILED');
      }
    } else if (path === '/api/auth/refresh' && req.method === 'POST') {
      try {
        const auth = await walletAuthService.refresh(req.body ?? {});
        success(auth, 'Token refreshed');
      } catch (e) {
        error(401, e instanceof Error ? e.message : 'Token refresh failed');
      }
    } else if (path === '/api/auth/social/google' && req.method === 'POST') {
      const { idToken, mockSub, mockEmail } = req.body ?? {};
      try {
        let sub: string;
        let email: string | undefined;
        const testMode = (process.env.SOCIAL_AUTH_TEST_MODE || '').toLowerCase() === 'true';
        if (testMode && mockSub) {
          sub = String(mockSub);
          email = mockEmail ? String(mockEmail) : undefined;
        } else {
          if (!idToken) {
            error(400, 'idToken required (or mockSub in test mode)');
            return;
          }
          const identity = await verifyGoogleIdToken(String(idToken));
          sub = identity.sub;
          email = identity.email;
        }

        const auth = await completeSocialLogin({
          provider: 'google',
          sub,
          email,
        });
        success(auth, 'Social login successful');
      } catch (e) {
        error(401, e instanceof Error ? e.message : 'Invalid Google social auth');
      }
    } else if (path === '/api/auth/social/github' && req.method === 'POST') {
      const { code, accessToken, mockSub, mockEmail } = req.body ?? {};
      try {
        let sub: string;
        let email: string | undefined;
        const testMode = (process.env.SOCIAL_AUTH_TEST_MODE || '').toLowerCase() === 'true';
        if (testMode && mockSub) {
          sub = String(mockSub);
          email = mockEmail ? String(mockEmail) : undefined;
        } else {
          if (!code && !accessToken) {
            error(400, 'code or accessToken required (or mockSub in test mode)');
            return;
          }
          const identity = await verifyGithubIdentity({
            code: code ? String(code) : undefined,
            accessToken: accessToken ? String(accessToken) : undefined,
          });
          sub = identity.sub;
          email = identity.email;
        }

        const auth = await completeSocialLogin({
          provider: 'github',
          sub,
          email,
        });
        success(auth, 'Social login successful');
      } catch (e) {
        error(401, e instanceof Error ? e.message : 'Invalid GitHub social auth');
      }
    } else if (path === '/api/bridges/wormhole/inbound/process' && req.method === 'POST') {
      if (!hasOperatorToken(req)) {
        error(401, 'Operator bearer token required', null, 'UNAUTHORIZED');
        return;
      }
      if (!isWormholeBridgeEnabled()) {
        error(404, 'Not found', null, 'NOT_FOUND');
        return;
      }
      const body = req.body ?? {};
      if (
        !Number.isInteger(body?.emitterChain) ||
        !body?.emitterAddress ||
        body?.sequence === undefined ||
        !body?.recipient
      ) {
        error(
          400,
          'emitterChain, emitterAddress, sequence, and recipient are required'
        );
        return;
      }

      try {
        const transfer = await processInboundTransfer({
          emitterChain: Number(body.emitterChain),
          emitterAddress: String(body.emitterAddress),
          sequence: String(body.sequence),
          sourceTxHash: body.sourceTxHash ? String(body.sourceTxHash) : undefined,
          sourceChain: body.sourceChain ? String(body.sourceChain) : undefined,
          targetChain: body.targetChain ? String(body.targetChain) : undefined,
          token: body.token ? String(body.token) : undefined,
          amount: body.amount ? String(body.amount) : undefined,
          recipient: String(body.recipient),
        });
        success(transfer, 'Inbound Wormhole transfer processed');
      } catch (e) {
        error(400, e instanceof Error ? e.message : 'Failed to process inbound transfer');
      }
    } else if (path === '/api/bridges/wormhole/outbound/initiate' && req.method === 'POST') {
      if (!hasOperatorToken(req)) {
        error(401, 'Operator bearer token required', null, 'UNAUTHORIZED');
        return;
      }
      if (!isWormholeBridgeEnabled()) {
        error(404, 'Not found', null, 'NOT_FOUND');
        return;
      }
      const body = req.body ?? {};
      if (!body?.sender || !body?.recipient || !body?.amount) {
        error(400, 'sender, recipient, and amount are required');
        return;
      }

      try {
        const transfer = await initiateOutboundTransfer({
          sender: String(body.sender),
          recipient: String(body.recipient),
          amount: String(body.amount),
          token: body.token ? String(body.token) : undefined,
          sourceChain: body.sourceChain ? String(body.sourceChain) : undefined,
          targetChain: body.targetChain ? String(body.targetChain) : undefined,
          burnTxHash: body.burnTxHash ? String(body.burnTxHash) : undefined,
        });
        success(transfer, 'Outbound Wormhole transfer initiated');
      } catch (e) {
        error(400, e instanceof Error ? e.message : 'Failed to initiate outbound transfer');
      }
    } else if (
      path.startsWith('/api/bridges/wormhole/transfers/') &&
      req.method === 'GET'
    ) {
      const transferId = path.replace('/api/bridges/wormhole/transfers/', '');
      if (!transferId) {
        error(400, 'transferId is required');
        return;
      }
      const transfer = await getWormholeTransfer(transferId);
      if (!transfer) {
        error(404, 'Transfer not found');
      } else {
        success(transfer);
      }
    } else if (
      /^\/api\/streaks\/[0-9]+$/.test(path) &&
      req.method === 'GET'
    ) {
      const userId = Number(path.split('/')[3]);
      const tzOffsetRaw = query.tzOffsetMinutes;
      const tzOffsetMinutes =
        typeof tzOffsetRaw === 'string' ? Number.parseInt(tzOffsetRaw, 10) : 0;
      try {
        const summary = await getStreakSummary(
          userId,
          Number.isNaN(tzOffsetMinutes) ? 0 : tzOffsetMinutes
        );
        success(summary);
      } catch (e) {
        error(400, e instanceof Error ? e.message : 'Failed to fetch streak summary');
      }
    } else if (
      /^\/api\/streaks\/[0-9]+\/check-in$/.test(path) &&
      req.method === 'POST'
    ) {
      const userId = Number(path.split('/')[3]);
      const tzOffsetMinutes = Number.isInteger(req.body?.tzOffsetMinutes)
        ? Number(req.body.tzOffsetMinutes)
        : 0;
      try {
        const result = await checkInUser(userId, tzOffsetMinutes);
        success(result, 'Streak check-in accepted');
      } catch (e) {
        error(400, e instanceof Error ? e.message : 'Failed to process check-in');
      }
    } else if (
      /^\/api\/streaks\/[0-9]+\/badges$/.test(path) &&
      req.method === 'GET'
    ) {
      const userId = Number(path.split('/')[3]);
      const tzOffsetRaw = query.tzOffsetMinutes;
      const tzOffsetMinutes =
        typeof tzOffsetRaw === 'string' ? Number.parseInt(tzOffsetRaw, 10) : 0;
      try {
        const badges = await getStreakBadges(
          userId,
          Number.isNaN(tzOffsetMinutes) ? 0 : tzOffsetMinutes
        );
        success(badges);
      } catch (e) {
        error(400, e instanceof Error ? e.message : 'Failed to fetch badges');
      }

      // Core dashboard endpoints (backend#1145: real sources or honest 501s)
    } else if (path === '/api/stats' && req.method === 'GET') {
      const cacheKey = `stats:${Date.now() - (Date.now() % 30000)}`; // 30-second cache buckets
      let data = await cacheManager.get(cacheKey);

      if (!data) {
        const result = await buildLiveStats({
          fetchCore4Json: fetchCore4JsonForStats,
          extractCore4Data: extractCore4DataForStats,
          toNullable: toNullableForStats,
          countActiveStations: countActiveWeatherStations,
        });
        if (!result.ok) {
          const failure = result as { status: number; message: string; details: unknown };
          error(failure.status, failure.message, failure.details, 'CORE4_UNAVAILABLE');
          return;
        }
        data = result.data;
        await cacheManager.set(cacheKey, data, 30); // Cache for 30 seconds
      }

      success(data);
    } else if (path === '/api/security/metrics' && req.method === 'GET') {
      notWired(
        'security.metrics',
        'Security metrics are not wired on this API: no scanner, WAF or audit source feeds this route',
        'The previous response was generated by a random number generator; a real source (security-testing results, WAF counters) has to be integrated before this route can answer.',
        'wrfcoin/backend#1145'
      );
    } else if (path.startsWith('/api/currency/') && req.method === 'GET') {
      notWired(
        'currency.rates',
        'Currency rates and conversion are not wired on this API: no exchange or price feed exists for WRF',
        'The previous rates were generated by a random number generator around fixed literals; WRF has no market price on the testnet.',
        'wrfcoin/backend#1145'
      );

      // Smart contracts graph endpoint
    } else if (path === '/api/smart-contracts/graph' && req.method === 'GET') {
      notWired(
        'smart-contracts.graph',
        'Smart-contract graph is not wired: no canonical contract manifest is published to the backend',
        'The previous response hard-coded audit status, bytecode size, gas usage, and dependency claims.',
        'wrfcoin/smart-contracts#238',
      );

      // Weather commit/reveal flow endpoints
    } else if (path === '/api/weather/commit' && req.method === 'POST') {
      try {
        const result = await weatherCommitRevealService.commit(req.body ?? {});
        realtimeWsHub?.broadcast(`weather:${req.body?.stationId}`, 'commit_created', {
          commitmentId: result.commitmentId,
          revealDeadline: result.revealDeadline,
        });
        success(
          {
            commitmentId: result.commitmentId,
            revealDeadline: result.revealDeadline,
          },
          'Weather commitment accepted'
        );
      } catch (e) {
        error(400, e instanceof Error ? e.message : 'Commit failed');
      }
    } else if (path === '/api/weather/reveal' && req.method === 'POST') {
      try {
        const result = await weatherCommitRevealService.reveal(req.body ?? {});
        realtimeWsHub?.broadcast(`weather:${result.stationId}`, 'reading_revealed', {
          receiptId: result.receiptId,
          accuracyScore: result.accuracyScore,
          rewardEstimate: result.rewardEstimate,
          referenceScore: result.referenceScore ?? null,
        });
        success(
          {
            receiptId: result.receiptId,
            accuracyScore: result.accuracyScore,
            rewardEstimate: result.rewardEstimate,
            referenceScore: result.referenceScore ?? null,
          },
          'Weather reveal accepted'
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : 'Reveal failed';
        if (message.includes('too early')) {
          error(409, message);
        } else if (message.includes('not found')) {
          error(404, message);
        } else {
          error(400, message);
        }
      }
    } else if (
      path.startsWith('/api/weather/commitments/') &&
      req.method === 'GET'
    ) {
      const stationId = decodeURIComponent(
        path.replace('/api/weather/commitments/', '')
      );
      if (!stationId) {
        error(400, 'stationId is required');
      } else {
        try {
          const commitments = await weatherCommitRevealService.listCommitments(stationId);
          success(commitments, 'Weather commitments fetched');
        } catch (e) {
          error(500, e instanceof Error ? e.message : 'Failed to fetch commitments');
        }
      }

      // Weather submission endpoint (no caching for POST)
    } else if (path === '/api/weather/submit' && req.method === 'POST') {
      try {
        // #932 staged migration. The whole decision — mode, credential lookup,
        // fail-closed, verdict — lives in resolveWeatherSubmitGate() so it is
        // reachable from a test; this route keeps only logging and the response.
        // Review proved why: deleting this reject block left the entire gate
        // byte-identical, because nothing bound the CALL.
        const submitBody = (req as any).body ?? {};
        const submitStationId = submitBody.stationId ?? submitBody.station_id ?? null;
        const submitGate = await resolveWeatherSubmitGate({
          rawMode: process.env.WEATHER_SUBMIT_AUTH_MODE,
          authorization: req.headers.authorization,
          stationId: submitStationId,
          contributorToken: process.env.WRFCOIN_CONTRIBUTOR_TOKEN,
          lookupStationTokenHash: async (stationId: string) => {
            const lookup = await executeQuery(
              'SELECT submit_token_hash FROM weather_stations WHERE station_id = $1 LIMIT 1',
              [stationId]
            );
            const hash = lookup.rows?.[0]?.submit_token_hash;
            return typeof hash === 'string' && hash ? hash : null;
          },
        });
        if (submitGate.invalidMode !== undefined) {
          appLogger.error(
            '#932 WEATHER_SUBMIT_AUTH_MODE is unrecognised — running with auth OFF until fixed',
            { configured: submitGate.invalidMode, allowed: ['off', 'enforce'] }
          );
        }
        if (submitGate.action === 'reject') {
          appLogger.warn('#932 weather submit rejected', {
            route: '/api/weather/submit',
            reason: submitGate.reason,
            stationId: submitStationId,
          });
          error(
            submitGate.status ?? 401,
            'Weather submissions require a station submit token',
            { code: submitGate.code, reason: submitGate.reason }
          );
          return;
        }
        if (submitGate.action === 'warn') {
          appLogger.warn('Unauthenticated weather submit accepted during staged migration', {
            route: '/api/weather/submit',
            authStage: 'detect-and-warn',
            stationId: submitStationId,
            source: submitBody.source ?? null,
          });
        }
        const result = await ingestWeatherPayload({
          route: '/api/weather/submit',
          payload: (req as any).body ?? {},
          idempotencyKey:
            req.headers['idempotency-key'] ||
            (req as any).body?.idempotencyKey,
          transportMeta: {
            source: 'enhanced_unified_submit',
            location: (req as any).body?.location ?? null,
          },
        });

        if (result.status >= 400) {
          error(
            result.status,
            typeof result.body.error === 'string'
              ? result.body.error
              : 'Weather submission failed',
            result.body
          );
          return;
        }

        const weatherData = result.body.weatherData as Record<string, any>;
        const sensors =
          Array.isArray((req as any).body?.sensorData) &&
          (req as any).body.sensorData.length > 0
            ? (req as any).body.sensorData
            : canonicalObservationToSensorData(
                result.canonicalized.canonicalPayload.observation
              );

        success(
          {
            stationId: weatherData.stationId,
            timestamp: weatherData.timestamp,
            sensors,
            canonicalPayload: result.canonicalized.canonicalPayload,
            canonicalTelemetry: result.canonicalized.telemetry,
            persistence:
              weatherData.persistence || result.body.persistence || null,
            duplicate: Boolean(result.body.duplicate),
            replayed: Boolean(result.body.replayed),
          },
          'Weather data submitted and persisted successfully',
          result.status
        );
      } catch (e) {
        error(500, e instanceof Error ? e.message : 'Weather submission failed');
      }

      // Smart contracts endpoints
    } else if (path.startsWith('/api/contracts/') && req.method === 'POST') {
      const contractEndpoint = path.replace('/api/contracts/', '');

      // backend#1147: these two used to answer a fabricated address, tx hash,
      // gas, block number and (for submitWeatherData) a fake 0.125 WRF reward,
      // generated with crypto-quality randomness so they looked real. No
      // deploy/call path exists in core4's launch API, the blockchain adapter
      // or any mounted router, so the honest answer is the not-wired envelope.
      if (contractEndpoint === 'deploy') {
        notWired(
          'contracts.deploy',
          'Contract deployment is not wired on this API: no chain target (core4 RPC or smart-contracts deployer) is connected',
          'The previous response invented a contract address, transaction hash, gas and block number; nothing was ever deployed.',
          'wrfcoin/backend#1147'
        );
      } else if (contractEndpoint === 'call') {
        notWired(
          'contracts.call',
          'Contract calls are not wired on this API: no chain target is connected, so no function can be executed or rewarded',
          'The previous response invented a transaction hash and gas, and for submitWeatherData a 0.125 WRF reward with a 95 validation score; nothing was ever executed.',
          'wrfcoin/backend#1147'
        );
      } else {
        error(404, 'Contract endpoint not found');
      }

      // Default error for unknown endpoints
    } else {
      const responseTime = Date.now() - requestStart;
      monitoringDashboard.recordRequest(path, responseTime, true, false);
      error(404, 'Endpoint not found', { path, method: req.method });
    }

    // Record successful request if we reach here
    const responseTime = Date.now() - requestStart;
    monitoringDashboard.recordRequest(
      path,
      responseTime,
      false,
      res.getHeader('X-Cache') === 'HIT'
    );
  } catch (err) {
    const responseTime = Date.now() - requestStart;
    monitoringDashboard.recordRequest(path, responseTime, true, false);

    appLogger.error('Request handling error', { error: err instanceof Error ? err.message : 'Unknown error' });
    error(500, 'Internal server error', {
      error: err instanceof Error ? err.message : 'Unknown error',
    });
  }
}

// Initialize graceful shutdown
const shutdown = GracefulShutdown.getInstance();

// Register HTTP server handler
shutdown.registerHandler(createHttpServerShutdownHandler(server, {
  name: 'enhanced-unified-api-server',
  timeout: 15000,
}));

// Register cache manager cleanup handler
shutdown.registerHandler({
  name: 'cache-manager',
  priority: ShutdownPriority.CLOSE_CACHE,
  timeout: 5000,
  handler: async () => {
    if (cacheManager && typeof cacheManager.close === 'function') {
      await cacheManager.close();
    }
  },
});

shutdown.registerHandler({
  name: 'weather-commit-expiry-job',
  priority: ShutdownPriority.STOP_BACKGROUND_JOBS,
  timeout: 3000,
  handler: async () => {
    stopCommitmentExpiryJob();
  },
});

shutdown.registerHandler({
  name: 'realtime-websocket-server',
  priority: ShutdownPriority.CLOSE_WEBSOCKETS,
  timeout: 5000,
  handler: async () => {
    if (realtimeWsHub) {
      await realtimeWsHub.close();
      realtimeWsHub = null;
    }
  },
});

// Set up signal handlers (SIGTERM, SIGINT, etc.)
shutdown.setupSignalHandlers();

function validateJwtSecret(): void {
  _validateJwtSecret(appLogger);
}

async function startEnhancedUnifiedApiServer(): Promise<void> {
  try { validateJwtSecret(); }
  catch (e) { appLogger.error('validateJwtSecret failed', { stack: (e as Error)?.stack }); throw e; }

  // #482 wanted the database verified before traffic; #271/#910 want the
  // server to BOOT and stay diagnosable without one. Reconciled: a bounded
  // connect attempt at boot — on failure the server still starts, and the
  // /health database probe (#910) reports unhealthy/503 until Postgres is
  // genuinely reachable, so traffic is still gated, just at the readiness
  // layer instead of by a boot hang the operator cannot probe.
  try {
    await connectWithRetry(2, 1000);
  } catch (e) {
    appLogger.error(
      'database unreachable at boot — serving with /health unhealthy (503) until it recovers (#910)',
      { error: e instanceof Error ? e.message : String(e) },
    );
  }

  // Initialize services here (not at module scope) to avoid blocking the
  // event loop in the esbuild CJS bundle (#267).
  try { weatherCommitRevealService = createWeatherCommitRevealService(); }
  catch (e) { appLogger.error('createWeatherCommitRevealService failed', { stack: (e as Error)?.stack }); throw e; }

  try { walletAuthService = createWalletAuthService(); }
  catch (e) { appLogger.error('createWalletAuthService failed', { stack: (e as Error)?.stack }); throw e; }

  try { stopCommitmentExpiryJob = startCommitmentExpiryJob(weatherCommitRevealService, 60_000); }
  catch (e) { appLogger.error('startCommitmentExpiryJob failed', { stack: (e as Error)?.stack }); throw e; }

  // Run bootstrap in background — don't block server startup.
  // If it hangs (see #267), the server still starts and serves requests.
  ensureEnvironmentalRiskBaseline()
    .then((result) => {
      appLogger.info('Environmental risk bootstrap completed', { status: result.status });
    })
    .catch((e) => {
      appLogger.warn('Environmental risk bootstrap failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    });

  // Schema integrity smoke-check (#467) — warn if critical tables are missing.
  const dbImport = await import('../database/connection.js').catch((e: unknown) => {
    appLogger.error('database/connection.js import failed', { stack: (e as Error)?.stack });
    throw e;
  });
  const { db: schemaDb } = dbImport;
  verifySchemaIntegrity(schemaDb).catch((e) => {
    appLogger.warn('Schema integrity check could not run', {
      error: e instanceof Error ? e.message : String(e),
    });
  });

  // Fix #291: Mount all Express route families so mobile/frontend don't get 404.
  // Uses require() inside startup (not static import) so DB/Redis failures
  // are caught per-route and the server still boots.
  function safeMount(mountPath: string, modulePath: string): void {
    const required = !safeMountOptionalAllowlist.has(mountPath);

    try {
      const cjsModulePath = `${modulePath}.cjs`;
      const mod = (() => {
        try {
          require.resolve(cjsModulePath);
          return require(cjsModulePath);
        } catch {
          return require(modulePath);
        }
      })();
      const router = mod.default || mod.createRouter?.() || mod;
      app.use(mountPath, router);

      safeMountAudit.push({
        mountPath,
        modulePath,
        required,
        mounted: true,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);

      safeMountAudit.push({
        mountPath,
        modulePath,
        required,
        mounted: false,
        error: reason,
      });

      appLogger.warn(`Route mount skipped: ${mountPath}`, { error: reason });
    }
  }

  const authenticateCrossPost: express.RequestHandler = (req, res, next) => {
    if (req.get('x-api-key')) {
      void authenticateCrossPostApiKey(req, res, next);
      return;
    }
    authenticateCrossPostToken(req, res, next);
  };
  app.use(
    createWrfsentinelCrossPostRouter({
      authenticate: authenticateCrossPost,
      store: wrfsentinelCrossPostStore,
    })
  );

  // Mirror server.js route mounts (lines 563-645)
  // Critical earn-loop route mounted statically so live/testnet does not depend
  // on legacy CommonJS route-module loading for mobile oracle submissions.
  app.use('/api/oracle', oracleSubmitRoutes);
  safeMount('/api/blockchain',              './routes/blockchain-routes');
  safeMount('/api/explorer',                './routes/explorer-routes');
  // backend#21: self-proving passkey send (no JWT), before the requireAuth wallet router as in
  // server.js. Dormant unless WRFCOIN_ENABLE_PASSKEY_SEND=true; off, it falls through unchanged.
  safeMount('/api/wallet',                  './routes/wallet-passkey-send-gate');
  safeMount('/api/wallet',                  './routes/wallet-routes');
  safeMount('/api/wallet-auth',             './routes/wallet-auth-legacy-routes');
  safeMount('/api/weather/streak',          './routes/weather-streak-routes');
  safeMount('/api/weather/temperature-history', './routes/weather-temperature-history-routes');
  safeMount('/api/streaks',                 './routes/streak-routes');
  safeMount('/api/weather',                 './routes/weather-routes');
  safeMount('/api',                         './routes/weather-alerts-routes');
  safeMount('/api',                         './routes/weather-report-routes');
  safeMount('/api/transport/sms',           './routes/sms-observation-gateway-routes');
  safeMount('/api/transport/email',         './routes/email-observation-gateway-routes');
  safeMount('/api/auth/social',             './routes/social-auth-routes');
  safeMount('/api/gas',                     './routes/gas-relay-routes');
  safeMount('/api/chain',                   './routes/chain-routes');
  safeMount('/api/layer-zero',              './routes/layer-zero-routes');
  safeMount('/api/bridges',                 './routes/bridges');
  // backend#1136: the one canonical cross-chain router (honest-gap 501; adapter is mock-only).
  safeMount('/api/cross-chain',             './routes/cross-chain');
  safeMount('/api/bridges/wormhole',        './routes/wormhole-transfer-routes');
  safeMount('/api/sensors',                 './routes/sensor-ingest-routes');
  // backend#1133: honest-gap ICP router (501 NOT_IMPLEMENTED; no @dfinity client).
  safeMount('/api/icp',                     './routes/internet-computer-routes');
  // backend#1134: data-ingestion cluster. Paths are /ingestion/<source>/... so the
  // four factory routers mount at /api (same shape as compute_networks_server).
  app.use('/api', createSatelliteIngestionRouter());
  app.use('/api', createUsgsEarthquakeIngestionRouter());
  app.use('/api', createUsgsWaterIngestionRouter());
  app.use('/api', createNrcsSoilIngestionRouter());
  safeMountAudit.push(
    ...['satellite-ingestion-routes', 'usgs-earthquake-ingestion-routes', 'usgs-water-ingestion-routes', 'nrcs-soil-ingestion-routes']
      .map((modulePath) => ({ mountPath: '/api', modulePath: `./routes/${modulePath}`, required: true, mounted: true }))
  );
  // Twilio SMS ingest (POST /api/sms/ingest); fails closed without TWILIO_AUTH_TOKEN.
  safeMount('/api/sms',                     './routes/sms-ingest-routes');
  // backend#1154: OpenForis is deliberately absent from release artifacts.
  // There is no real provider or canonical receipt verifier, and the retired
  // route module exists only to fail closed for direct legacy imports.
  // backend#1132: real W3bstream/IoTeX device + attestation route (DB-backed,
  // integrations/iotex controller, admin-token-gated geofence review) was never mounted.
  safeMount('/api/iotex',                   './routes/iotex');
  safeMount('/api/quality',                 './routes/operator-quality-routes');
  safeMount('/api/nft',                     './routes/nft-routes');
  safeMount('/api/governance',              './routes/governance-routes');
  safeMount('/api/sanctions/orchestration', './routes/sanctions-orchestration-routes');
  safeMount('/api/sanctions',               './routes/policy-audit-routes');
  safeMount('/api/appeals',                 './routes/appeals-routes');
  safeMount('/api/integrity/risk',          './routes/abuse-risk-routes');
  safeMount('/api/integrity/sybil',         './routes/sybil-detection-routes');
  safeMount('/api/integrity/calibration',   './routes/integrity-calibration-routes');
  safeMount('/api/environment/reports',     './routes/environment-reports-routes');
  // Faucet onboarding must be reachable pre-auth: safeMounts run before the
  // token-gated catch-all, and this table is the DEPLOYED entrypoint (#857 —
  // the #869 mount in unified_api_server.ts never reached production).
  safeMount('/api/onboarding',              './routes/onboarding-routes');
  safeMount('/api/faucet',                  './routes/faucet-bond-routes');
  // Owner ruling 2026-10-28 (b): passkey wallets have no JWT; default-OFF public balance read (3 fields).
  safeMount('/api/public/balance',          './routes/public-balance-routes');
  // backend#229 (owner demo queue 2026-11-01): default-OFF public proof card for one station reading,
  // read from the node (reward evidence + reveal scan + block), never from a backend table.
  safeMount('/api/proofs',                  './routes/proof-card-routes');
  // Owner demo queue 2026-11-01 item 3: default-OFF public producers / bonded nodes / attesters read,
  // from the node (replaces the never-mounted validators.js table reads).
  safeMount('/api/network',                 './routes/network-nodes-routes');
  // backend#1178: referrals are the one growth-cluster router with shipping
  // callers (frontend useReferrals.js, mobile referral_service.dart). Mutators
  // need a wallet JWT for the acting wallet; activation pays nothing. Table:
  // 0023_referrals. DEFERRED and deliberately NOT mounted (see
  // /api/capabilities and server/CLAUDE.md): duels, challenges,
  // marketplace, academic, subscription, webhooks, telemetry,
  // contributor summary.
  safeMount('/api/referrals',               './routes/referral-routes');
  safeMount('/api/reputation',              './routes/reputationRoutes');
  safeMount('/api/mining',                  './routes/mining-routes');
  // backend#1157: mock AI providers/canned analysis are not release routes.
  // A future route must prove configured auth, provider health, and real calls.
  // backend#1156: fabricated Model Context CRUD/validation/export is retired.
  // Do not mount it in a release artifact.
  safeMount('/api/n8n',                     './routes/n8n-routes');
  safeMount('/api/oracle',                  './routes/oracle-routes');
  safeMount('/api/oracle',                  './routes/oracle-detail-routes');
  // Read-only window onto the Pythia predictive-oracle sidecar's Redis cache
  // (repo wrfcoin/wrfsentinel, epic #18 / story #20). Distinct from the
  // commit-reveal /api/oracle family above — Pythia owns its own key space.
  safeMount('/api/pythia',                  './routes/pythia-routes');
  safeMount('/api/documentation',           './routes/documentation-routes');
  safeMount('/api/modules',                 './routes/module-controller-routes');
  safeMount('/api/node-os',                 './routes/node-os-routes');
  safeMount('/api/rpc',                     './routes/rpc-routes');
  safeMount('/api/node-control',            './routes/node-control-routes');
  safeMount('/api/keys',                    './routes/key-manager-routes');
  safeMount('/api/kpi/alignment',           './routes/alignment-kpi-routes');
  safeMount('/api/achievement',             './routes/achievementRoutes');
  // #215: mobile earn→claim loop. Mobile hits /api/v1/rewards/claim/:id and
  // /api/v1/rewards/history; these were implemented but never mounted live.
  safeMount('/api/v1/rewards',              './routes/rewards');
  // #216: mobile privacy send calls /api/privacy/stealth-address (step 1 of the
  // Enhanced/Maximum private send). privacyRoutes was never mounted live.
  safeMount('/api/privacy',                 './routes/privacyRoutes');
  // Mobile weatherRealtime hits /api/storage/weather/realtime/:stationId
  // (mobile#204). The legacy data-storage-api family is unloadable through
  // this path (missing modules + top-level await — see
  // routes/storage-realtime-routes.js); mount the focused replacement.
  safeMount('/api/storage',                 './routes/storage-realtime-routes');
  safeMount('/api/defi',                    './routes/defi-routes');
  // backend#1122: bridges frontend's already-built useCapabilities.ts/
  // CapabilitiesContext.tsx readiness polling to real backend wiring status.
  safeMount('/api',                         './routes/capabilities-routes');
  // backend#695/#1131: geographic leaderboard filter shipped 2026-04-19 but was
  // only ever mounted in the dead unified_api_server.ts entrypoint, never here.
  // leaderboard-regions.ts is a helper module (region list/parseNear), not a
  // router — it's imported by this file, not mounted separately.
  safeMount('/api/weather/leaderboard',     './routes/weather-leaderboard-routes');
  safeMount('/api/earnings',                './routes/earnings-routes');
  // core4#3604 A4: public forecaster track record, fed by the chain-rewards indexer's forecast rows.
  safeMount('/api/forecasters',             './routes/forecasters-routes');
  // Owner ruling 2026-11-01: Wolfram is bring-your-own-key. One fixed question ("is this reading
  // unusual?") relayed with the caller's own AppID, never stored or logged. Dormant unless
  // WOLFRAM_READING_CHECK_ENABLED=true.
  safeMount('/api/integrations/wolfram',    './routes/wolfram-reading-check-routes');
  // backend#251: weekly forecast competition, points only, over the same indexed forecast rows.
  // OFF unless FORECAST_COMPETITIONS_ENABLED=true too (set only after migration 0036 is applied).
  safeMount('/api/competitions',            './routes/competition-routes');

  const mountSnapshot = safeMountReadinessSnapshot();
  appLogger.info('safeMount inventory', {
    total: safeMountAudit.length,
    mounted: safeMountAudit.filter((entry) => entry.mounted).length,
    skippedRequired: mountSnapshot.requiredMissing.length,
    skippedOptional: mountSnapshot.optionalMissing.length,
  });

  if (mountSnapshot.requiredMissing.length > 0) {
    appLogger.error('required safeMount route family missing', {
      missing: mountSnapshot.requiredMissing,
    });
  }

  // Catch-all: forward unmatched requests to the existing inline handleRequest
  app.use(async (req: any, res: any, next: any) => {
    if (res.headersSent) return next();
    const startTime = Date.now();
    const parsedUrl = url.parse(req.url || '', true);
    const path = parsedUrl.pathname || '';
    await handleRequest(req as ExtendedIncomingMessage, res, path, parsedUrl.query, startTime);
  });

  server.listen(Number(PORT), '0.0.0.0', () => {
    appLogger.info('Enhanced Unified API server started', {
      port: PORT,
      performanceMonitoring: `http://0.0.0.0:${PORT}/api/performance/metrics`,
      healthCheck: `http://0.0.0.0:${PORT}/health`,
      cacheManagement: `http://0.0.0.0:${PORT}/api/cache/clear`
    });

    try {
      realtimeWsHub = initializeRealtimeWebSocketServer(server);
    } catch (e) {
      appLogger.warn('Realtime WebSocket initialization failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Initialize blockchain adapter for real-time events
    try {
      const blockchainAdapter = require('./blockchain_adapter');
      blockchainAdapter.initialize().catch((err: any) => {
        appLogger.error('Failed to initialize blockchain adapter', { error: err.message });
      });
    } catch (e) {
      appLogger.warn('Blockchain adapter not available');
    }

    // #215: guarded reward-payout reconciler — advances pending achievement
    // payouts to settled by re-POSTing their claim_id. OFF by default
    // (REWARD_PAYOUT_RECONCILE_ENABLED=true) until core4 PR #2081 is deployed.
    try {
      const { startPayoutReconciler } = require('./services/reward-payout-reconciler');
      if (startPayoutReconciler()) {
        appLogger.info('Reward payout reconciler is active');
      }
    } catch (e) {
      appLogger.warn('Reward payout reconciler not started', {
        error: e instanceof Error ? e.message : String(e),
      });
    }

    // Read-side producer/attester receipts. OFF unless CHAIN_REWARD_INDEX_ENABLED=true.
    // Never log upstream/DB exception messages (they may contain credentials).
    try {
      const { startChainRewardIndex } = require('./services/chain-rewards/indexer');
      startChainRewardIndex({ logger: appLogger }).catch(() => {
        appLogger.warn('Chain reward index not started');
      });
    } catch {
      appLogger.warn('Chain reward index not started');
    }

    // backend#1253: chain -> weather_stations sync so chain-registered stations
    // reach the public map. OFF by default (STATION_CHAIN_SYNC_ENABLED=true);
    // needs core4#3342 (Operator-gated station list) on the node.
    try {
      const { startChainStationSync } = require('./services/chain-station-sync');
      startChainStationSync({ logger: appLogger }).catch((e: unknown) => {
        appLogger.warn('Chain station sync not started', {
          error: e instanceof Error ? e.message : String(e),
        });
      });
    } catch (e) {
      appLogger.warn('Chain station sync not started', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

void startEnhancedUnifiedApiServer().catch(error => {
  appLogger.error('Enhanced Unified API startup failed before listen', {
    error: error instanceof Error ? error.message : String(error),
    name: (error as Error)?.name,
    stack: (error as Error)?.stack,
    code: (error as NodeJS.ErrnoException)?.code,
  });
  // Raw console.error bypasses winston transforms so the full error is always visible.
  console.error('[STARTUP CRASH raw]', error);
  // Fail fast so Docker's restart policy can surface startup failures quickly.
  process.exit(1);
});

export default server;
