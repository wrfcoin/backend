// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

const http = require('http');
const path = require('path');

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const session = require('express-session');
const Sentry = require('@sentry/node');
const WebSocket = require('ws');
const { csrfProtectionMiddleware } = require('../shared/middleware/csrf-protection');

// Graceful shutdown manager
const { GracefulShutdown, ShutdownPriority } = require('../shared/graceful-shutdown/index.js');

const wolframRoutes = require('./routes/wolfram-routes');
const { logger, securityLogger } = require('./utils/logger');
const apiAudit = require('./middleware/apiAudit');
// SECURITY FIX (102.8): Import session store configuration for Redis-based sessions
const { getSessionStore, sessionSecurityMiddleware } = require('../config/session-store');
const { setupGraphQLServer } = require('./graphql');
const MPCServer = require('./mpc/mpcServer');
const {
  createMetricsMiddleware,
  createMetricsEndpoint,
} = require('./middleware/metricsMiddleware');
const {
  createEnhancedMetricsMiddleware,
  createEnhancedMetricsEndpoint,
} = require('./middleware/enhancedMetricsMiddleware');
const { getDatabaseMetrics, getDatabaseMetricsSummary } = require('../database/queryMonitor');
const { getBlockchainMetrics, getBlockchainMetricsSummary, startMetricsSync } = require('../services/blockchainMetrics');
const {
  startMetricsCollection,
  getPrometheusMetrics: getSystemPrometheusMetrics,
  collectSystemSnapshot,
} = require('../performance/real-metrics-collector');
const { redisCachePrometheusCollector, redisMetrics } = require('./cache/cache-metrics');
const { cacheClient } = require('./cache/redis-client');
const {
  createSecurityAlertMiddleware,
  createPayloadScanMiddleware,
} = require('./middleware/securityAlertMiddleware');
const config = require('../config');
const DbAccessControl = require('./middleware/dbAccessControl');
const dbSecurityMiddleware = require('./middleware/dbSecurityMiddleware');
const computationalRoutes = require('./routes/computational');
const WrfcoinSDK = require('./sdk');
const governanceController = require('./controllers/governanceController');
const wolframPlugin = require('./plugins/wolframPlugin');
const aiPluginManager = require('./plugins/ai_plugin_manager');
const MCPServer = require('./mcp/mcpServer');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { probeCore4Readiness } = require('./utils/core4-launch-health');
const {
  resolveAllowedOrigins,
  assertNoWildcardOrigins,
  createCorsOriginDelegate,
} = require('./utils/strict-cors-config');

/**
 * Wrfcoin API Server
 *
 * This is the main entry point for the Wrfcoin backend API that serves:
 * - Core blockchain functionality via SDK
 * - Database access for UI components
 * - WebSocket notifications
 * - Cross-chain integrations
 * - Comprehensive logging, monitoring, and alerting
 */

// Core dependencies

// Import GraphQL server setup

// Import MPC server for privacy features

// Import custom middleware for monitoring and security

// Create Express app
const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 5002; // Changed from 5001 to avoid conflict with WebSocket server
const probeState = { draining: false };

// Load configuration
logger.info(`Loading Wrfcoin configuration for network: ${config.network}`);

// Initialize Sentry error tracking if DSN is provided
if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: 0.2,
    integrations: [
      // Enable HTTP calls tracing
      new Sentry.Integrations.Http({ tracing: true }),
      // Enable Express.js middleware tracing
      new Sentry.Integrations.Express({ app }),
    ],
  });

  // The Sentry request handler must be the first middleware
  app.use(Sentry.Handlers.requestHandler());

  // TracingHandler creates a trace for every incoming request
  app.use(Sentry.Handlers.tracingHandler());

  logger.info('Sentry error tracking initialized');
} else {
  logger.warn(
    'Sentry DSN not provided. Error tracking with Sentry is disabled.'
  );
}

// Initialize middleware
// Restrict CORS to trusted origins only
const trustedCorsOrigins = resolveAllowedOrigins({
  nodeEnv: process.env.NODE_ENV || 'development',
});
assertNoWildcardOrigins(trustedCorsOrigins);

app.use(
  cors({
    origin: createCorsOriginDelegate(trustedCorsOrigins, {
      nodeEnv: process.env.NODE_ENV || 'development',
    }),
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'X-API-Key',
      'X-Admin-Token',
      'X-Wallet-Address',
      'X-Wallet-Signature',
      'X-Wallet-Message',
    ],
    credentials: true,
  })
);

// Add metrics middleware to measure request durations and track API usage
app.use(createMetricsMiddleware());

const operationalProbes = createHealthMiddleware(
  'wrfcoin-api-server',
  {
    redis: {
      critical: false,
      check: () => ({
        status: cacheClient.isConnected ? 'up' : 'down',
      }),
    },
    sessionStore: {
      critical: false,
      check: () => ({
        status:
          sessionStore && sessionStore.client ? 'up' : 'down',
      }),
    },
    core4: {
      critical: true,
      check: () => probeCore4Readiness(),
    },
  },
  {
    state: probeState,
  }
);
app.use(operationalProbes.router);

// Add enhanced metrics middleware for P50/P95/P99 percentiles and error categorization (Task 84)
app.use(createEnhancedMetricsMiddleware({
  collectRequestSize: true,
  collectResponseSize: true,
  recordGraphQL: true,
  logSlowRequests: true,
  slowRequestThreshold: 1000, // Log requests slower than 1 second
}));

// Add security alert middleware to monitor for suspicious behavior
app.use(createSecurityAlertMiddleware());

// Body parsing with size limits to prevent abuse
app.use(bodyParser.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));
app.use(bodyParser.urlencoded({ extended: true, limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf.toString(); } }));

// Scan request payloads for malicious content
app.use(createPayloadScanMiddleware());

// Force HTTPS in production
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(`https://${req.headers.host}${req.url}`);
    }
    next();
  });
}

// Configure session middleware
// SECURITY FIXES (102.6, 102.7, 102.8): Session timeout, cookie hardening, and Redis storage
// SECURITY FIX (102.8): Get Redis session store for production
// In development, falls back to in-memory store with warning
let sessionStore = null;
try {
  sessionStore = getSessionStore();
} catch (error) {
  logger.error('Failed to initialize session store:', error.message);
  if (process.env.NODE_ENV === 'production') {
    throw error; // Fail fast in production
  }
}

app.use(
  session({
    secret:
      process.env.SESSION_SECRET ||
      (() => {
        throw new Error('SESSION_SECRET environment variable is required');
      })(),
    name: 'wrfcoin_session',
    cookie: {
      // SECURITY FIX (102.7): Always set httpOnly to prevent XSS access to cookies
      httpOnly: true,
      // SECURITY FIX (102.7): Always use secure cookies unless explicitly in local development
      // This prevents cookies from being transmitted over unencrypted HTTP connections
      secure: process.env.NODE_ENV !== 'development' || process.env.FORCE_HTTPS === 'true',
      // SECURITY FIX (102.7): Strict SameSite prevents CSRF attacks
      sameSite: 'strict',
      // SECURITY FIX (102.6): Reduced idle timeout from 24 hours to 1 hour
      // This limits the window of opportunity for session hijacking attacks
      maxAge: 60 * 60 * 1000, // 1 hour idle timeout
    },
    // SECURITY FIX (102.6): Enable rolling sessions to reset expiry on activity
    // Combined with shorter maxAge, this provides sliding window session management
    rolling: true,
    resave: false,
    saveUninitialized: false,
    // SECURITY FIX (102.8): Use Redis for session storage in production
    // This provides session persistence, scalability, and proper memory management
    ...(sessionStore && { store: sessionStore }),
  })
);

// SECURITY FIX (102.5): Add session security middleware to reject header-based session IDs
app.use(sessionSecurityMiddleware);

app.use(
  csrfProtectionMiddleware({
    ignorePaths: ['/health', '/ready', '/api/oauth/', '/api/webhook/'],
  })
);

// Configure and use Helmet for security headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
        objectSrc: ["'none'"],
        imgSrc: ["'self'", 'data:', 'https:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'https:'],
        frameSrc: ["'self'"],
        frameAncestors: ["'self'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        fontSrc: ["'self'", 'data:', 'https:'],
        workerSrc: ["'self'", 'blob:'],
      },
    },
    // Enable Strict-Transport-Security header with preload option
    hsts: {
      maxAge: 31536000, // 1 year in seconds
      includeSubDomains: true,
      preload: true,
    },
    // Configure X-Frame-Options header
    frameguard: {
      action: 'sameorigin',
    },
    // Enable other security headers
    xssFilter: true,
    noSniff: true,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  })
);

// Configure basic rate limiting
const standardLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: true,
    message: 'Too many requests, please try again later.',
    code: 'RATE_LIMIT_EXCEEDED',
  },
  // Log rate limiting events
  skip: (req, res) => {
    // Check if this is the last request allowed in the current window
    if (req.rateLimit && req.rateLimit.remaining === 0) {
      securityLogger.warn('Rate limit exceeded', { event: 'suspicious', severity: 'low',
        ip: req.ip || req.connection.remoteAddress,
        endpoint: req.originalUrl,
        method: req.method,
        userAgent: req.headers['user-agent'],
      });
    }
    return false; // Don't actually skip the rate limiter
  },
});

// Configure stricter rate limiting for sensitive endpoints
const sensitiveEndpointLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 30, // limit each IP to 30 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: true,
    message:
      'Too many requests to sensitive API endpoint, please try again later.',
    code: 'SENSITIVE_RATE_LIMIT_EXCEEDED',
  },
  // Log rate limiting events with higher severity
  skip: (req, res) => {
    if (req.rateLimit && req.rateLimit.remaining === 0) {
      securityLogger.warn('Sensitive endpoint rate limit exceeded', {
        event: 'suspicious',
        severity: 'medium',
        ip: req.ip || req.connection.remoteAddress,
        endpoint: req.originalUrl,
        method: req.method,
        userAgent: req.headers['user-agent'],
      });
    }
    return false; // Don't actually skip the rate limiter
  },
});

const FAST_API_PATHS = new Set(['/health', '/ready', '/live', '/metrics']);

function isFastApiPath(path) {
  if (!path) {
    return false;
  }

  return FAST_API_PATHS.has(path) || path.startsWith('/metrics/');
}

function skipFastApiMiddleware(middleware) {
  return (req, res, next) => {
    if (isFastApiPath(req.path)) {
      return next();
    }
    return middleware(req, res, next);
  };
}

// Apply standard rate limiting to all routes
app.use('/api/', standardLimiter);

// Apply stricter rate limiting to sensitive routes
app.use('/api/wallet', sensitiveEndpointLimiter);
app.use('/api/governance', sensitiveEndpointLimiter);
app.use('/api/oracle', sensitiveEndpointLimiter);
app.use('/api/keys', sensitiveEndpointLimiter);
app.use('/api/rpc', sensitiveEndpointLimiter);
app.use('/api/node-control', sensitiveEndpointLimiter);
app.use('/api/node-os', sensitiveEndpointLimiter);

// Middleware to skip heavy processing for health/metrics routes
const skipHeavyMiddlewareForStaticRoutes = (req, res, next) => {
  const path = req.path;
  const isStaticRoute = /^\/(health|metrics|live|ready)($|\/)/.test(path);
  req.skipHeavyMiddleware = isStaticRoute;
  next();
};

app.use('/api', skipHeavyMiddlewareForStaticRoutes);

// Apply API auditing to all routes
app.use('/api', skipFastApiMiddleware(apiAudit));

// Apply input sanitization to all API routes (except health/metrics)
app.use('/api', (req, res, next) => {
  if (req.skipHeavyMiddleware) {
    return next();
  }
  dbSecurityMiddleware.sanitizeDbInput(req, res, next);
});

// Apply input sanitization to all API routes
app.use('/api', (req, res, next) => {
  if (req.skipHeavyMiddleware) {
    return next();
  }
  dbSecurityMiddleware.sanitizeDbInput(req, res, next);
});
app.use('/api', (req, res, next) => {
  if (req.skipHeavyMiddleware) {
    return next();
  }
  dbSecurityMiddleware.preventExcessiveDatabaseLoad(req, res, next);
});

// Apply schema validation only to dynamic query routes
app.get('/api/dynamicQuery', dbSecurityMiddleware.validateSchemaNames);

// Create specific resource routes with permission checks
const router = express.Router();
router.all('/wallet/:id', dbSecurityMiddleware.checkDbPermission('wallet'));
router.all(
  '/transaction/:id',
  dbSecurityMiddleware.checkDbPermission('transaction')
);
router.all(
  '/validator/:id',
  dbSecurityMiddleware.checkDbPermission('validator')
);
router.all('/node/:id', dbSecurityMiddleware.checkDbPermission('node'));
router.all('/forecast/:id', dbSecurityMiddleware.checkDbPermission('forecast'));
router.all(
  '/computation/:id',
  dbSecurityMiddleware.checkDbPermission('computation')
);

// Apply the router to the /api path
app.use('/api', router);

// Apply data ownership enforcement only to API routes that mutate user-owned data (except health/metrics)
app.use('/api', (req, res, next) => {
  if (req.skipHeavyMiddleware) {
    return next();
  }
  DbAccessControl.enforceDataOwnership()(req, res, next);
});

// Health check route
app.get('/api/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    network: config.network,
    version: config.version,
  });
});

// Expose Prometheus metrics endpoint
app.get('/api/metrics', createMetricsEndpoint());

// Enhanced metrics endpoint with P50/P95/P99 percentiles (Task 84)
app.get('/api/metrics/enhanced', createEnhancedMetricsEndpoint());

// Database metrics endpoint with query profiling (Task 84.3)
app.get('/api/metrics/database', async (req, res) => {
  try {
    const format = req.query.format || 'prometheus';
    if (format === 'json') {
      const summary = await getDatabaseMetricsSummary();
      res.json(summary);
    } else {
      const metrics = await getDatabaseMetrics();
      res.set('Content-Type', 'text/plain');
      res.send(metrics);
    }
  } catch (error) {
    logger.error('Error generating database metrics:', error);
    res.status(500).json({ error: 'Failed to generate database metrics' });
  }
});

// Blockchain & cross-chain metrics endpoint (Task 84.4)
app.get('/api/metrics/blockchain', async (req, res) => {
  try {
    const format = req.query.format || 'prometheus';
    if (format === 'json') {
      const summary = await getBlockchainMetricsSummary();
      res.json(summary);
    } else {
      const metrics = await getBlockchainMetrics();
      res.set('Content-Type', 'text/plain');
      res.send(metrics);
    }
  } catch (error) {
    logger.error('Error generating blockchain metrics:', error);
    res.status(500).json({ error: 'Failed to generate blockchain metrics' });
  }
});

// System resource metrics endpoint (Task 84.5)
app.get('/api/metrics/system', async (req, res) => {
  try {
    const format = req.query.format || 'prometheus';
    if (format === 'json') {
      const snapshot = await collectSystemSnapshot();
      res.json(snapshot);
    } else {
      const metrics = await getSystemPrometheusMetrics();
      res.set('Content-Type', 'text/plain');
      res.send(metrics);
    }
  } catch (error) {
    logger.error('Error generating system metrics:', error);
    res.status(500).json({ error: 'Failed to generate system metrics' });
  }
});

// Cache metrics endpoint (Task 84.6)
app.get('/api/metrics/cache', async (req, res) => {
  try {
    const format = req.query.format || 'json';
    // Get statistics from Redis cache client
    const stats = await cacheClient.getStatistics();

    if (format === 'json') {
      res.json({
        timestamp: new Date().toISOString(),
        cache: stats,
        prometheus: {
          wrfcoin_redis_connected: stats.connected ? 1 : 0,
          wrfcoin_redis_hit_rate_percent: parseFloat(stats.performance.hitRate.replace('%', '')) || 0,
          wrfcoin_redis_total_gets: stats.operations.getCount,
          wrfcoin_redis_total_sets: stats.operations.setCount,
          wrfcoin_redis_total_hits: stats.operations.hitCount,
          wrfcoin_redis_total_misses: stats.operations.missCount,
          wrfcoin_redis_total_errors: stats.operations.errorCount,
          wrfcoin_redis_compression_bytes_saved: stats.compression.bytesSaved,
        },
      });
    } else {
      // Prometheus format
      const hitRate = parseFloat(stats.performance.hitRate.replace('%', '')) || 0;
      const prometheusOutput = [
        `# HELP wrfcoin_redis_connected Redis connection status`,
        `# TYPE wrfcoin_redis_connected gauge`,
        `wrfcoin_redis_connected ${stats.connected ? 1 : 0}`,
        `# HELP wrfcoin_redis_hit_rate_percent Redis cache hit rate percentage`,
        `# TYPE wrfcoin_redis_hit_rate_percent gauge`,
        `wrfcoin_redis_hit_rate_percent ${hitRate}`,
        `# HELP wrfcoin_redis_total_gets Total Redis GET operations`,
        `# TYPE wrfcoin_redis_total_gets gauge`,
        `wrfcoin_redis_total_gets ${stats.operations.getCount}`,
        `# HELP wrfcoin_redis_total_hits Total Redis cache hits`,
        `# TYPE wrfcoin_redis_total_hits gauge`,
        `wrfcoin_redis_total_hits ${stats.operations.hitCount}`,
        `# HELP wrfcoin_redis_total_misses Total Redis cache misses`,
        `# TYPE wrfcoin_redis_total_misses gauge`,
        `wrfcoin_redis_total_misses ${stats.operations.missCount}`,
        `# HELP wrfcoin_redis_total_errors Total Redis errors`,
        `# TYPE wrfcoin_redis_total_errors gauge`,
        `wrfcoin_redis_total_errors ${stats.operations.errorCount}`,
      ].join('\n');
      res.set('Content-Type', 'text/plain');
      res.send(prometheusOutput);
    }
  } catch (error) {
    logger.error('Error generating cache metrics:', error);
    res.status(500).json({ error: 'Failed to generate cache metrics' });
  }
});

// Register Wolfram API routes
app.use('/api/integrations/wolfram', wolframRoutes);

// Register Computational NFT routes
app.use('/api/computational', computationalRoutes);

// Initialize SDK
const sdk = new WrfcoinSDK({
  network: config.network,
  dataDir: path.join(__dirname, '../data'),
  logLevel: config.logLevel,
});

// Initialize controller modules
// Initialize governance controller with error handling
if (typeof governanceController.initialize === 'function') {
  governanceController.initialize(sdk);
} else {
  logger.warn('Governance controller initialization skipped - method not available');
}

// Initialize Wolfram plugin with empty config (will be configured through API)
wolframPlugin.initialize({ appId: null });

// Initialize AI Plugin Manager
aiPluginManager.initialize().then(initialized => {
  if (initialized) {
    logger.info('AI Plugin Manager initialized successfully');
  } else {
    logger.warn('AI Plugin Manager initialization failed');
  }
});

// Initialize Model Context Protocol (MCP) Server
const mcpServer = new MCPServer({
  port: process.env.MCP_PORT || 5005,
  enableWebSocketAPI: true,
  enableContextProviders: true,
});

// Start MCP server
mcpServer
  .start()
  .then(() => {
    logger.info('Model Context Protocol (MCP) server started successfully');
  })
  .catch(error => {
    logger.error(`Failed to start MCP server: ${error.message}`);
  });

// API Routes
app.use('/api/blockchain', require('./routes/blockchain-routes'));
app.use('/api/explorer', require('./routes/explorer-routes'));
app.use('/api/wallet', require('./routes/wallet-routes'));
app.use('/api/wallet-auth', require('./routes/wallet-auth-legacy-routes'));
const weatherStreakRoutes = require('./routes/weather-streak-routes');
app.use('/api/weather/streak', weatherStreakRoutes.default || weatherStreakRoutes);
const weatherTemperatureHistoryRoutes = require('./routes/weather-temperature-history-routes');
app.use('/api/weather/temperature-history', weatherTemperatureHistoryRoutes.default || weatherTemperatureHistoryRoutes);
const streakRoutes = require('./routes/streak-routes');
app.use('/api/streaks', streakRoutes.default || streakRoutes);
app.use('/api/weather', require('./routes/weather-routes'));
const weatherAlertsRoutes = require('./routes/weather-alerts-routes');
const weatherReportRoutes = require('./routes/weather-report-routes');
const smsObservationGatewayRoutes = require('./routes/sms-observation-gateway-routes');
app.use(
  '/api',
  weatherAlertsRoutes.default ||
    weatherAlertsRoutes.createWeatherAlertsRouter?.() ||
    weatherAlertsRoutes
);
app.use('/api', weatherReportRoutes.default || weatherReportRoutes);
app.use(
  '/api/transport/sms',
  smsObservationGatewayRoutes.default ||
    smsObservationGatewayRoutes.createSmsObservationGatewayRouter?.() ||
    smsObservationGatewayRoutes
);
const socialAuthRoutes = require('./routes/social-auth-routes');
app.use('/api/auth/social', socialAuthRoutes.default || socialAuthRoutes);

const gasRelayRoutes = require('./routes/gas-relay-routes');
app.use('/api/gas', gasRelayRoutes.default || gasRelayRoutes);
const chainRoutes = require('./routes/chain-routes');
app.use('/api/chain', chainRoutes.default || chainRoutes);
const bridgesRoutes = require('./routes/bridges');
app.use('/api/bridges', bridgesRoutes.default || bridgesRoutes);
const wormholeTransferRoutes = require('./routes/wormhole-transfer-routes');
app.use('/api/bridges/wormhole', wormholeTransferRoutes.default || wormholeTransferRoutes);

const sensorIngestRoutes = require('./routes/sensor-ingest-routes');
app.use('/api/sensors', sensorIngestRoutes.default || sensorIngestRoutes);

app.use('/api/nft', require('./routes/nft-routes'));
app.use('/api/governance', require('./routes/governance-routes'));
app.use('/api/sanctions/orchestration', require('./routes/sanctions-orchestration-routes'));
app.use('/api/sanctions', require('./routes/policy-audit-routes'));
const appealsRoutes = require('./routes/appeals-routes');
const abuseRiskRoutes = require('./routes/abuse-risk-routes');
const sybilDetectionRoutes = require('./routes/sybil-detection-routes');
const reputationRoutes = require('./routes/reputationRoutes');
app.use('/api/appeals', appealsRoutes.default || appealsRoutes);
app.use('/api/integrity/risk', abuseRiskRoutes.default || abuseRiskRoutes);
app.use('/api/integrity/sybil', sybilDetectionRoutes.default || sybilDetectionRoutes);
app.use('/api/integrity/calibration', require('./routes/integrity-calibration-routes'));
app.use('/api/environment/reports', require('./routes/environment-reports-routes'));
app.use('/api/reputation', reputationRoutes.default || reputationRoutes);
app.use('/api/mining', require('./routes/mining-routes'));
// backend#1157: the mock-only AI plugin API is retired and deliberately absent
// from release artifacts until providers have configured auth and health proof.
// backend#1156: the fabricated Model Context API is retired and deliberately
// absent from release artifacts.
app.use('/api/n8n', require('./routes/n8n-routes'));
// Mount Oracle API routes directly at the /api/oracle path
app.use('/api/oracle', require('./routes/oracle-routes'));
// Use the primary API's wallet/station/collect-key-bound submission design (#1284).
// Mount before the dashboard router so a legacy handler cannot bypass it.
const oracleSubmitRoutes = require('./routes/oracle-submit-routes.js');
app.use('/api/oracle', oracleSubmitRoutes.default || oracleSubmitRoutes);
// Mount Oracle detail routes directly at the /api/oracle path too for detailed data
app.use('/api/oracle', require('./routes/oracle-detail-routes'));
app.use('/api/documentation', require('./routes/documentation-routes'));
// Mount Module Controller routes for workflow management and profile loading
app.use('/api/modules', require('./routes/module-controller-routes'));

// Node OS routes (requires admin authentication for sensitive operations)
app.use('/api/node-os', require('./routes/node-os-routes'));

// Secure RPC endpoints (requires authentication)
app.use('/api/rpc', require('./routes/rpc-routes'));

// Node control endpoints (requires admin authentication)
app.use('/api/node-control', require('./routes/node-control-routes'));

// Key management endpoints (requires admin authentication)
app.use('/api/keys', require('./routes/key-manager-routes'));

// Alignment KPI endpoints (aggregated, privacy-safe metrics -- backend#34)
const alignmentKpiRoutes = require('./routes/alignment-kpi-routes');
app.use('/api/kpi/alignment', alignmentKpiRoutes.default || alignmentKpiRoutes);

// Achievement routes for mobile gamification (backend#197)
const achievementRoutes = require('./routes/achievementRoutes');
app.use('/api/achievement', achievementRoutes.default || achievementRoutes);

// Slack command routes for bidirectional Claude-in-Slack bridge
const slackCommandRoutes = require('./routes/slack-command-routes');
app.use('/api/slack', slackCommandRoutes.default || slackCommandRoutes);

// Unknown API routes must fail closed before the production SPA catch-all.
// Otherwise retired or misspelled GET endpoints return index.html with 200.
app.use(require('./middleware/api-not-found'));

// Serve static frontend in production
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../dist')));

  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '../dist/index.html'));
  });
}

// Sentry error handler must be before any other error middleware and after all controllers
if (process.env.SENTRY_DSN) {
  app.use(Sentry.Handlers.errorHandler());
}

// Custom error handler
app.use((err, req, res, next) => {
  const statusCode = err.statusCode || 500;

  // Log the error with enhanced details
  logger.error(`API Error: ${err.message}`, {
    path: req.originalUrl || req.path,
    statusCode,
    error: err.stack,
    method: req.method,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.headers['user-agent'],
    // Only include sensitive request data for server errors (not client errors)
    requestData:
      statusCode >= 500
        ? {
            query: req.query ? JSON.stringify(req.query) : undefined,
            // Sanitize body to prevent logging sensitive data
            body: req.body
              ? JSON.stringify(sanitizeRequestBody(req.body))
              : undefined,
          }
        : undefined,
  });

  // Return sanitized error message
  res.status(statusCode).json({
    error: true,
    message:
      process.env.NODE_ENV === 'production'
        ? 'An error occurred processing your request'
        : err.message,
    code: err.code || 'INTERNAL_SERVER_ERROR',
    path: req.originalUrl || req.path,
  });
});

/**
 * Sanitize request body to prevent logging sensitive data
 * @param {Object} body - Request body
 * @returns {Object} - Sanitized body
 */
function sanitizeRequestBody(body) {
  if (!body || typeof body !== 'object') return body;

  const sensitiveFields = [
    'password',
    'token',
    'apiKey',
    'secret',
    'key',
    'privateKey',
    'auth',
    'jwt',
  ];
  const sanitized = { ...body };

  Object.keys(sanitized).forEach(key => {
    if (sensitiveFields.includes(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeRequestBody(sanitized[key]);
    }
  });

  return sanitized;
}

// Initialize GraphQL server integration
logger.info('Setting up GraphQL server for rich querying capabilities...');
setupGraphQLServer(app, {
  graphiql: process.env.NODE_ENV !== 'production',
  introspection: true,
});

// Initialize MPC server for privacy features
logger.info('Initializing MPC server for enhanced privacy and security...');
const mpcServer = new MPCServer({
  port: process.env.MPC_PORT || 5004,
  enableThresholdSigning: true,
  enableZKP: true,
  minParties: 3,
});

// Start MPC server in background
mpcServer.start().catch(error => {
  logger.error(`Failed to start MPC server: ${error.message}`);
});

// Start server
const host = '0.0.0.0';
server.listen(PORT, host, () => {
  // Start blockchain metrics sync (Task 84.4)
  startMetricsSync();

  // Start system resource metrics collection (Task 84.5)
  startMetricsCollection();

  // Configure and start Redis cache Prometheus metrics collection (Task 84.6)
  redisCachePrometheusCollector.setCacheClient(() => cacheClient);
  redisCachePrometheusCollector.start(15000); // 15 second collection interval

  logger.info(`Wrfcoin API server running on http://${host}:${PORT}`, {
    port: PORT,
    network: config.network,
    mode: process.env.NODE_ENV || 'development',
    features: {
      sentryEnabled: !!process.env.SENTRY_DSN,
      metricsEnabled: true,
      securityAlertsEnabled: true,
      graphqlEnabled: true,
      mpcPrivacyEnabled: true,
      computationalNFTMarketplace: true,
    },
    endpoints: {
      graphql: `http://${host}:${PORT}/graphql`,
      graphiql:
        process.env.NODE_ENV !== 'production'
          ? `http://${host}:${PORT}/graphql`
          : null,
      mpcServer: `http://${host}:${process.env.MPC_PORT || 5004}`,
    },
  });

  // Initialize WebSocket server (if enabled)
  if (config.websocket && config.websocket.enabled) {
    require('./ws_server').initialize(server, {
      path: '/ws',
      network: config.network,
    });
  } else {
    // Initialize a minimal WebSocket server for status updates
    const wss = new WebSocket.Server({ server, path: '/ws', maxPayload: 64 * 1024 });

    wss.on('connection', ws => {
      logger.info('WebSocket client connected');

      let messageCount = 0;
      let windowStart = Date.now();

      // Send initial status message
      ws.send(
        JSON.stringify({
          type: 'status',
          status: 'connected',
          timestamp: Date.now(),
          network: config.network || 'testnet',
        })
      );

      // Handle client messages
      ws.on('message', message => {
        // Rate limiting: max 10 messages per second per connection
        const now = Date.now();
        if (now - windowStart >= 1000) {
          messageCount = 0;
          windowStart = now;
        }
        messageCount++;
        if (messageCount > 10) {
          ws.close(1008, 'Rate limit exceeded');
          return;
        }

        try {
          const data = JSON.parse(message);
          logger.debug(
            `WebSocket message received: ${data.type || 'unknown'}`,
            { data }
          );

          // Echo back for testing
          if (data.type === 'ping') {
            ws.send(
              JSON.stringify({
                type: 'pong',
                timestamp: Date.now(),
              })
            );
          }
        } catch (error) {
          logger.error(`Error processing WebSocket message: ${error.message}`);
        }
      });

      // Handle disconnection
      ws.on('close', () => {
        logger.info('WebSocket client disconnected');
      });
    });

    logger.info('Minimal WebSocket server initialized at /ws');
  }
});

// Add unhandled error listeners to prevent crashes
process.on('uncaughtException', error => {
  logger.error('Uncaught exception', { error: error.stack });
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(error);
  }
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled rejection', {
    reason: reason instanceof Error ? reason.stack : String(reason),
    promise: String(promise),
  });
  if (process.env.SENTRY_DSN) {
    Sentry.captureException(reason);
  }
});

// ============================================================================
// Graceful Shutdown Setup
// ============================================================================

const gracefulShutdown = GracefulShutdown.getInstance({
  logger: (msg, level) => {
    if (level === 'error') {
      logger.error(msg);
    } else if (level === 'warn') {
      logger.warn(msg);
    } else {
      logger.info(msg);
    }
  },
});

// Register metrics collection cleanup
gracefulShutdown.registerHandler({
  name: 'main-api-drain-state',
  priority: ShutdownPriority.STOP_ACCEPTING_CONNECTIONS,
  timeout: 1000,
  handler: async () => {
    probeState.draining = true;
    logger.info('Main API server entering draining state');
  },
});

gracefulShutdown.registerHandler({
  name: 'main-api-metrics-cleanup',
  priority: ShutdownPriority.STOP_BACKGROUND_JOBS,
  timeout: 2000,
  handler: async () => {
    logger.info('Stopping metrics collection');
    // Stop Redis cache Prometheus metrics collection
    if (redisCachePrometheusCollector && redisCachePrometheusCollector.stop) {
      redisCachePrometheusCollector.stop();
    }
  },
});

// Register MPC server cleanup
gracefulShutdown.registerHandler({
  name: 'main-api-mpc-server',
  priority: ShutdownPriority.STOP_BACKGROUND_JOBS,
  timeout: 5000,
  handler: async () => {
    logger.info('Stopping MPC server');
    if (mpcServer && mpcServer.stop) {
      await mpcServer.stop();
    }
  },
});

// Register MCP server cleanup
gracefulShutdown.registerHandler({
  name: 'main-api-mcp-server',
  priority: ShutdownPriority.STOP_BACKGROUND_JOBS,
  timeout: 5000,
  handler: async () => {
    logger.info('Stopping MCP server');
    if (mcpServer && mcpServer.stop) {
      await mcpServer.stop();
    }
  },
});

// Register session store cleanup (Redis)
gracefulShutdown.registerHandler({
  name: 'main-api-session-store',
  priority: ShutdownPriority.CLOSE_CACHE,
  timeout: 5000,
  handler: async () => {
    logger.info('Closing session store');
    if (sessionStore && sessionStore.client && sessionStore.client.quit) {
      await sessionStore.client.quit();
    }
  },
});

// Register HTTP server cleanup
gracefulShutdown.registerHandler({
  name: 'main-api-http-server',
  priority: ShutdownPriority.DRAIN_HTTP_CONNECTIONS,
  timeout: 10000,
  handler: () => {
    return new Promise((resolve, reject) => {
      logger.info('Closing HTTP server');
      server.close(err => {
        if (err) {
          logger.error('Error closing server', { error: err.message });
          reject(err);
        } else {
          logger.info('HTTP server closed');
          resolve();
        }
      });
    });
  },
});

// Set up signal handlers
gracefulShutdown.setupSignalHandlers();

// Export for testing
module.exports = { app, server };
