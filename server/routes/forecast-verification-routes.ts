import express from 'express';
import {
  ForecastVerificationRequest,
  ForecastVerificationService,
  mapVerificationErrorStatus,
} from '../services/forecast/forecast-verification-service.js';

import type { Request as PublicRequest, RequestHandler, Response as PublicResponse } from 'express';
import {
  COMMIT_ID_RE,
  checkForecastOnChain,
  parseForecastRecord,
  type Core4Get,
} from '../services/forecast-commit-record.js';
import { readRecord, readSummary, type Query } from '../services/forecast-verification/observed-verification.js';
import { defaultCore4Get, defaultQuery, forecastVerificationEnabled } from '../services/forecast-verification/observed-verification-job.js';

const MAX_VERIFY_PAYLOAD_BYTES = 2 * 1024 * 1024;

interface ForecastVerificationRouterOptions {
  requireAuth?: boolean;
  authToken?: string;
}

export function createForecastVerificationRouter(
  service: ForecastVerificationService = new ForecastVerificationService(),
  options: ForecastVerificationRouterOptions = {}
): express.Router {
  const router = express.Router();
  router.use('/compute/forecast/verify', express.json({ limit: '2mb' }));

  const requireAuth = options.requireAuth !== false;
  const authToken = resolveVerificationAuthToken(options.authToken);

  router.post('/compute/forecast/verify', async (req, res) => {
    if (requireAuth) {
      if (!authToken) {
        return res.status(503).json({
          success: false,
          error: 'Verification endpoint auth token is not configured',
        });
      }

      const bearerToken = extractBearerToken(req.get('authorization'));
      const presentedToken = bearerToken || req.get('x-api-key');
      if (presentedToken !== authToken) {
        return res.status(401).json({
          success: false,
          error: 'Unauthorized',
        });
      }
    }

    const payloadBytes = Buffer.byteLength(JSON.stringify(req.body || {}), 'utf8');
    if (payloadBytes > MAX_VERIFY_PAYLOAD_BYTES) {
      return res.status(413).json({
        success: false,
        error: 'Payload too large for forecast verification request',
      });
    }

    try {
      const payload = req.body as ForecastVerificationRequest;
      const report = await service.verifyForecast(payload);
      return res.status(201).json({
        success: true,
        report,
      });
    } catch (error) {
      const status = mapVerificationErrorStatus(error);
      return res.status(status).json({
        success: false,
        error:
          error instanceof Error && status < 500
            ? error.message
            : 'Forecast verification failed',
      });
    }
  });

  return router;
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7).trim();
  return token.length > 0 ? token : null;
}

function resolveVerificationAuthToken(overrideToken?: string): string | null {
  if (overrideToken && overrideToken.trim().length > 0) {
    return overrideToken.trim();
  }

  const envToken = process.env.FORECAST_VERIFICATION_API_TOKEN || process.env.COMPUTE_API_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }

  return null;
}

// ---------------------------------------------------------------------------------------------------
// Public, deployed surface (owner demo queue 2026-11-01, item 7; backend PR#72, backend#1494)
//
//   GET  /api/forecast-verification/summary              30-day skill of on-chain forecasts vs station
//                                                        readings, and vs NOAA on the same forecasts
//   GET  /api/forecast-verification/forecasts/:commitId   one record and its score
//   POST /api/forecast-verification/forecasts             hand in a forecast-kit commit record
//                                                        { commitId, nonce, timestamp, data }
//
// The bearer-gated gridded POST above stays on compute_networks_server.ts only; the deployed entrypoint
// mounts this default export. Dormant unless FORECAST_VERIFICATION_ENABLED=true (read per request; 404).
// The POST needs no login: the record proves itself (its hash is the chain commit id) and is accepted only
// once the forecast is revealed on chain, so it publishes nothing that is not already public. The raw
// station id never leaves this process; responses name the station by its public alias.
// Limits: 30 requests/min per client (shared Redis limiter, fail-closed), node checks for new records
// capped process-wide at 30/min (one node read each), summary cached 30 s.
// ---------------------------------------------------------------------------------------------------
export const FORECAST_VERIFICATION_RATE_LIMIT = { windowMs: 60 * 1000, maxRequests: 30, keyPrefix: 'ratelimit:forecast-verification' };
export const FORECAST_VERIFICATION_SUBMIT_PER_MIN = 30;
const SUMMARY_TTL_MS = 30_000;

export interface PublicForecastVerificationDeps {
  query?: Query;
  get?: Core4Get;
  now?: () => number;
  rateLimit?: RequestHandler;
}

async function defaultVerificationRateLimit(): Promise<RequestHandler> {
  const mod = await import('../../shared/middleware/rate-limit-redis.js');
  return mod.createRateLimitMiddleware({
    ...FORECAST_VERIFICATION_RATE_LIMIT,
    keyGenerator: mod.apiIpBudgetKey,
    message: 'Too many forecast verification requests, please try again later.',
  });
}

const failWith = (res: PublicResponse, status: number, code: string, message: string) =>
  res.status(status).json({ success: false, error: { code, message } });

export function createPublicForecastVerificationRouter(deps: PublicForecastVerificationDeps = {}): express.Router {
  const router = express.Router();
  const now = deps.now ?? Date.now;
  let queryPromise: Promise<Query> | null = null;
  const getQuery = () => (queryPromise ||= deps.query ? Promise.resolve(deps.query) : defaultQuery());
  let getPromise: Promise<Core4Get> | null = null;
  const getCore4 = () => (getPromise ||= deps.get ? Promise.resolve(deps.get) : defaultCore4Get());
  let limitPromise: Promise<RequestHandler> | null = null;
  const getLimit = () => {
    if (!limitPromise) {
      limitPromise = deps.rateLimit ? Promise.resolve(deps.rateLimit) : defaultVerificationRateLimit();
      limitPromise.catch(() => { limitPromise = null; });
    }
    return limitPromise;
  };
  const budget = { windowStart: Number.NEGATIVE_INFINITY, used: 0 };
  let summaryCache: { expiresAt: number; value: Promise<unknown> } | null = null;

  const gate = (handler: (req: PublicRequest, res: PublicResponse) => Promise<unknown>): RequestHandler => (req, res, next) => {
    if (!forecastVerificationEnabled()) return void res.status(404).json({ error: 'Not found' });
    res.set('Cache-Control', 'no-store');
    getLimit().then(
      (limit) => limit(req, res, (err?: unknown) => {
        if (err) return next(err);
        handler(req, res).catch(() => {
          if (!res.headersSent) failWith(res, 503, 'UNAVAILABLE', 'Forecast verification is unavailable right now.');
        });
      }),
      () => failWith(res, 503, 'RATE_LIMIT_UNAVAILABLE', 'Forecast verification is unavailable, please try again later.'),
    );
  };

  router.get('/summary', gate(async (_req, res) => {
    const at = now();
    if (!summaryCache || summaryCache.expiresAt <= at) {
      const value = getQuery().then((q) => readSummary(q, Math.floor(at / 1000)));
      summaryCache = { expiresAt: at + SUMMARY_TTL_MS, value };
      value.catch(() => { summaryCache = null; });
    }
    res.json(await summaryCache.value);
  }));

  router.get('/forecasts/:commitId', gate(async (req, res) => {
    const commitId = String(req.params.commitId ?? '');
    if (!COMMIT_ID_RE.test(commitId)) return failWith(res, 400, 'VALIDATION_ERROR', 'Expected a 64-character lowercase hex commit id.');
    const record = await readRecord(await getQuery(), commitId);
    if (!record) return failWith(res, 404, 'NOT_FOUND', 'No forecast record has been handed in for this commit id.');
    return res.json(record);
  }));

  router.post('/forecasts', express.json({ limit: '8kb' }), gate(async (req, res) => {
    const parsed = parseForecastRecord(req.body ?? {});
    if (parsed.ok === false) return failWith(res, 400, parsed.code, parsed.message);
    const record = parsed.record;
    const query = await getQuery();
    const existing = await readRecord(query, record.commitId);
    if (existing) return res.status(200).json(existing);
    if (!process.env.WRFCOIN_READER_TOKEN?.trim() && !deps.get) {
      return failWith(res, 503, 'CORE4_READER_CREDENTIAL_UNCONFIGURED', 'Chain reads are unavailable on this server.');
    }
    const at = now();
    if (at - budget.windowStart >= 60_000) { budget.windowStart = at; budget.used = 0; }
    if (budget.used >= FORECAST_VERIFICATION_SUBMIT_PER_MIN) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((budget.windowStart + 60_000 - at) / 1000))));
      return failWith(res, 503, 'UPSTREAM_BUDGET_EXHAUSTED', 'Forecast verification is busy, please try again later.');
    }
    budget.used += 1;
    const chain = await checkForecastOnChain(await getCore4(), record);
    if (chain.ok === false) {
      if (chain.code === 'UPSTREAM') return failWith(res, 502, 'UPSTREAM_ERROR', 'The chain node could not answer.');
      return failWith(res, chain.code === 'NOT_ON_CHAIN' ? 404 : 409, chain.code, chain.message);
    }
    await query(`INSERT INTO forecast_verification_records
        (commit_id, station_id, station_alias, model_id, issued_at, valid_at, horizon_hours, forecast_values, status, submitted_at)
      VALUES ($1, $2, $3, $4, to_timestamp($5), to_timestamp($6), $7, $8, 'pending', to_timestamp($9))
      ON CONFLICT (commit_id) DO NOTHING`,
    [record.commitId, record.stationId, record.stationAlias, record.modelId, record.issuedAt, record.validAt, record.horizonHours,
      JSON.stringify(record.values), Math.floor(at / 1000)]);
    summaryCache = null;
    return res.status(201).json(await readRecord(query, record.commitId));
  }));

  return router;
}

export default createPublicForecastVerificationRouter();
