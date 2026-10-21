/**
 * Prometheus Metrics Export
 *
 * Provides application-level metrics for monitoring:
 * - Log counts by level
 * - Error rates
 * - Request latency histograms
 * - Custom business metrics
 */

import {
  Registry,
  Counter,
  Histogram,
  Gauge,
  collectDefaultMetrics,
} from 'prom-client';
import { Request, Response, NextFunction, Router } from 'express';
import { appLogger } from './logger.js';
import type { LegacyFormatTelemetry } from '../../shared/weather-payload-canonical.js';

// Create a custom registry
export const metricsRegistry = new Registry();

// Set default labels
metricsRegistry.setDefaultLabels({
  app: 'wrfcoin-backend',
});

// Collect default metrics (CPU, memory, event loop, etc.)
collectDefaultMetrics({ register: metricsRegistry });

// ===== Log Metrics =====

export const logCounter = new Counter({
  name: 'wrfcoin_log_messages_total',
  help: 'Total number of log messages by level and logger',
  labelNames: ['level', 'logger'],
  registers: [metricsRegistry],
});

export const logErrorCounter = new Counter({
  name: 'wrfcoin_log_errors_total',
  help: 'Total number of error log messages by logger',
  labelNames: ['logger', 'error_type'],
  registers: [metricsRegistry],
});

// ===== HTTP Request Metrics =====

export const httpRequestDuration = new Histogram({
  name: 'wrfcoin_http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});

export const httpRequestTotal = new Counter({
  name: 'wrfcoin_http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});

export const httpActiveConnections = new Gauge({
  name: 'wrfcoin_http_active_connections',
  help: 'Number of active HTTP connections',
  registers: [metricsRegistry],
});

// ===== Business Metrics =====

export const weatherDataCounter = new Counter({
  name: 'wrfcoin_weather_data_submissions_total',
  help: 'Total number of weather data submissions',
  labelNames: ['station_id', 'quality_score_bucket'],
  registers: [metricsRegistry],
});

export const weatherPayloadFormatCounter = new Counter({
  name: 'wrfcoin_weather_payload_format_total',
  help:
    'Weather payload format classification for ingestion and relay paths',
  labelNames: ['route', 'format', 'has_legacy_keys'],
  registers: [metricsRegistry],
});

export const transactionCounter = new Counter({
  name: 'wrfcoin_transactions_total',
  help: 'Total number of blockchain transactions',
  labelNames: ['type', 'status'],
  registers: [metricsRegistry],
});

export const bridgeTransactionCounter = new Counter({
  name: 'wrfcoin_bridge_transactions_total',
  help: 'Total number of cross-chain bridge transactions',
  labelNames: ['source_chain', 'destination_chain', 'status'],
  registers: [metricsRegistry],
});

export const reorgsDetectedTotal = new Counter({
  name: 'wrfcoin_reorgs_detected_total',
  help: 'Total number of chain reorgs detected across cross-chain bridges',
  labelNames: ['chain', 'bridge'],
  registers: [metricsRegistry],
});

export const bridgeValidatorsActiveGauge = new Gauge({
  name: 'wrfcoin_bridge_validators_active',
  help: 'Number of active bridge validators configured per bridge',
  labelNames: ['bridge'],
  registers: [metricsRegistry],
});

export const carbonCreditsIssued = new Counter({
  name: 'wrfcoin_carbon_credits_issued_total',
  help: 'Total number of carbon credits issued',
  labelNames: ['source', 'methodology'],
  registers: [metricsRegistry],
});

export const iotDevicesActive = new Gauge({
  name: 'wrfcoin_iot_devices_active',
  help: 'Number of currently active IoT devices',
  labelNames: ['device_type', 'platform'],
  registers: [metricsRegistry],
});

export const governanceProposals = new Gauge({
  name: 'wrfcoin_governance_proposals',
  help: 'Number of governance proposals by status',
  labelNames: ['status'],
  registers: [metricsRegistry],
});

// ===== Engagement & Funnel Metrics (#685) =====
//
// These counters answer "is anyone actually using feature X?" and let
// product/sprint managers see funnel drop-off without grepping logs.
// All steps share a single counter per funnel with a `step` label so
// new steps can be added without registering new metrics.

/** Allowed values for the `contributionFunnelCounter` `step` label. */
export const CONTRIBUTION_FUNNEL_STEPS = [
  'wallet_created',
  'first_submission',
  'streak_7',
  'streak_30',
  'first_nft_claim',
] as const;
export type ContributionFunnelStep = (typeof CONTRIBUTION_FUNNEL_STEPS)[number];

export const contributionFunnelCounter = new Counter({
  name: 'wrfcoin_contribution_funnel_total',
  help: 'Per-step contribution funnel events (wallet → submission → streak → NFT)',
  labelNames: ['step'],
  registers: [metricsRegistry],
});

/** Allowed values for the `referralFunnelCounter` `step` label. */
export const REFERRAL_FUNNEL_STEPS = [
  'code_generated',
  'code_shared',
  'code_entered',
  'activated',
] as const;
export type ReferralFunnelStep = (typeof REFERRAL_FUNNEL_STEPS)[number];

export const referralFunnelCounter = new Counter({
  name: 'wrfcoin_referral_funnel_total',
  help: 'Per-step referral funnel events (generated → shared → entered → activated)',
  labelNames: ['step'],
  registers: [metricsRegistry],
});

export const pageViewCounter = new Counter({
  name: 'wrfcoin_page_views_total',
  help: 'Frontend page-view counter for feature-adoption tracking',
  labelNames: ['page', 'referrer_type'],
  registers: [metricsRegistry],
});

/**
 * Unique wallets active in the last 15 minutes.
 *
 * Defined here so the metric is scrape-able from day one; a follow-up
 * PR will wire a periodic refresh job that queries recent activity
 * (Redis sorted-set or DB aggregate) and calls `.set()`. Until then
 * the gauge reports 0, which is the correct conservative default.
 */
export const activeWalletsGauge = new Gauge({
  name: 'wrfcoin_active_wallets_15m',
  help: 'Unique wallet addresses with activity in the last 15 minutes',
  registers: [metricsRegistry],
});

// ===== Service Health Metrics =====

export const serviceHealthGauge = new Gauge({
  name: 'wrfcoin_service_health',
  help: 'Health status of microservices (1 = healthy, 0 = unhealthy)',
  labelNames: ['service'],
  registers: [metricsRegistry],
});

export const dbConnectionPoolGauge = new Gauge({
  name: 'wrfcoin_db_connection_pool',
  help: 'Database connection pool stats',
  labelNames: ['stat'],
  registers: [metricsRegistry],
});

// ===== Helper Functions =====

/**
 * Increment log counter based on level
 */
export function recordLogMetric(level: string, logger: string): void {
  logCounter.inc({ level, logger });
  if (level === 'error') {
    logErrorCounter.inc({ logger, error_type: 'generic' });
  }
}

/**
 * Record HTTP request metrics
 */
export function recordHttpMetrics(
  method: string,
  route: string,
  statusCode: number,
  durationSeconds: number
): void {
  const labels = { method, route, status_code: statusCode.toString() };
  httpRequestDuration.observe(labels, durationSeconds);
  httpRequestTotal.inc(labels);
}

/**
 * Record an engagement-funnel event (#685). Use the typed step values
 * from the corresponding `*_FUNNEL_STEPS` array — invalid strings will
 * still increment but break the dashboards.
 */
export function recordContributionFunnelStep(step: ContributionFunnelStep): void {
  contributionFunnelCounter.inc({ step });
}

export function recordReferralFunnelStep(step: ReferralFunnelStep): void {
  referralFunnelCounter.inc({ step });
}

export function recordPageView(page: string, referrerType: string = 'direct'): void {
  pageViewCounter.inc({ page, referrer_type: referrerType });
}

/**
 * Record canonical-v1 vs legacy weather payload shape usage.
 */
export function recordWeatherPayloadFormatMetric(
  route: string,
  telemetry?: LegacyFormatTelemetry
): void {
  weatherPayloadFormatCounter.inc({
    route,
    format: telemetry?.source ?? 'canonical-v1',
    has_legacy_keys: telemetry ? 'true' : 'false',
  });
}

/**
 * Express middleware to collect HTTP metrics
 */
export function metricsMiddleware(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime();
  httpActiveConnections.inc();

  res.on('finish', () => {
    httpActiveConnections.dec();
    const [seconds, nanoseconds] = process.hrtime(start);
    const duration = seconds + nanoseconds / 1e9;

    // Normalize route path to reduce cardinality
    const route = normalizeRoutePath(req.route?.path || req.path);

    recordHttpMetrics(req.method, route, res.statusCode, duration);
  });

  next();
}

/**
 * Normalize route paths to reduce metric cardinality
 */
function normalizeRoutePath(path: string): string {
  // Replace UUIDs
  let normalized = path.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    ':id'
  );

  // Replace numeric IDs
  normalized = normalized.replace(/\/\d+/g, '/:id');

  // Replace Ethereum addresses
  normalized = normalized.replace(/0x[0-9a-fA-F]{40}/g, ':address');

  // Replace transaction hashes
  normalized = normalized.replace(/0x[0-9a-fA-F]{64}/g, ':txHash');

  return normalized || '/';
}

/**
 * Get metrics endpoint handler
 */
export async function getMetrics(): Promise<string> {
  return metricsRegistry.metrics();
}

/**
 * Create a metrics router for Express
 */
export function createMetricsRouter(): Router {
  const router = Router();

  router.get('/metrics', async (req: Request, res: Response) => {
    try {
      res.set('Content-Type', metricsRegistry.contentType);
      res.end(await getMetrics());
    } catch (error) {
      appLogger.error('Error generating metrics', { error });
      res.status(500).end('Error generating metrics');
    }
  });

  // Health check endpoint that also updates health metrics
  router.get('/health/metrics', async (req: Request, res: Response) => {
    try {
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        memory: process.memoryUsage(),
      };

      // Update service health gauge
      serviceHealthGauge.set({ service: 'main-api' }, 1);

      res.json(health);
    } catch (error) {
      serviceHealthGauge.set({ service: 'main-api' }, 0);
      res.status(503).json({ status: 'unhealthy', error: (error as Error).message });
    }
  });

  return router;
}

/**
 * Initialize metrics collection
 */
export function initializeMetrics(): void {
  try {
    const logMetric =
      typeof metricsRegistry.getSingleMetric === 'function'
        ? metricsRegistry.getSingleMetric('wrfcoin_log_messages_total')
        : null;
    appLogger.info('Prometheus metrics initialized', {
      metricsEndpoint: '/metrics',
      registeredMetrics: logMetric ? 'configured' : 'pending',
    });
  } catch (error) {
    appLogger.error('Failed to initialize metrics registry', { error });
  }
}

export {
  metricsRegistry as registry,
  Counter,
  Histogram,
  Gauge,
};
