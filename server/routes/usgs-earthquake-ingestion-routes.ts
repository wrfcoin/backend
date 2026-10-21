import crypto from 'crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  UsgsEarthquakeError,
  UsgsEarthquakeService,
} from '../services/seismic/usgs-earthquake-service.js';

interface UsgsEarthquakeRouterOptions {
  requireAuth?: boolean;
  authToken?: string;
}

export function createUsgsEarthquakeIngestionRouter(
  service: UsgsEarthquakeService = new UsgsEarthquakeService(),
  options: UsgsEarthquakeRouterOptions = {}
): express.Router {
  const router = express.Router();
  const requireAuth = options.requireAuth !== false;
  const authToken = resolveAuthToken(options.authToken);

  router.use('/ingestion/usgs-earthquake', express.json({ limit: '1mb' }));
  router.use(
    '/ingestion/usgs-earthquake',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: 'Too many USGS earthquake ingestion requests' },
    })
  );

  router.post('/ingestion/usgs-earthquake/feed', async (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    try {
      const result = await service.pollFeed(req.body || {});
      return res.status(201).json({ success: true, result });
    } catch (error) {
      return res.status(mapStatus(error)).json({
        success: false,
        error:
          error instanceof Error && mapStatus(error) < 500
            ? error.message
            : 'USGS earthquake feed ingestion failed',
      });
    }
  });

  router.get('/ingestion/usgs-earthquake/events', (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    try {
      const limit = parseLimit(req.query.limit as string | undefined);
      return res.status(200).json({
        success: true,
        events: service.getRecentEvents(limit),
      });
    } catch (error) {
      return res.status(mapStatus(error)).json({
        success: false,
        error:
          error instanceof Error && mapStatus(error) < 500
            ? error.message
            : 'USGS earthquake events query failed',
      });
    }
  });

  router.get('/ingestion/usgs-earthquake/metrics', (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    return res.status(200).json({
      success: true,
      metrics: service.getMetrics(),
    });
  });

  return router;
}

function parseLimit(value: string | undefined): number {
  if (!value) {
    return 200;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new UsgsEarthquakeError('limit must be a positive integer', 400);
  }

  return Math.trunc(parsed);
}

function mapStatus(error: unknown): number {
  if (error instanceof UsgsEarthquakeError) {
    return error.statusCode;
  }
  return 500;
}

function resolveAuthToken(overrideToken?: string): string | null {
  if (overrideToken && overrideToken.trim().length > 0) {
    return overrideToken.trim();
  }
  const envToken =
    process.env.USGS_EARTHQUAKE_INGESTION_API_TOKEN || process.env.COMPUTE_API_TOKEN;
  if (envToken && envToken.trim().length > 0) {
    return envToken.trim();
  }
  return null;
}

function requireAuthorization(
  enabled: boolean,
  token: string | null,
  req: express.Request
): { status: number; message: string } | null {
  if (!enabled) {
    return null;
  }

  if (!token) {
    return { status: 503, message: 'USGS earthquake ingestion auth token is not configured' };
  }

  const bearerToken = extractBearer(req.get('authorization'));
  const presentedToken = bearerToken || req.get('x-api-key');
  if (!secureEquals(presentedToken, token)) {
    return { status: 401, message: 'Unauthorized' };
  }

  return null;
}

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader || !/^Bearer\s+/i.test(authHeader)) {
    return null;
  }
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return token.length > 0 ? token : null;
}

function secureEquals(actual: string | null | undefined, expected: string): boolean {
  if (!actual) {
    return false;
  }
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

const defaultRouter = createUsgsEarthquakeIngestionRouter();
export default defaultRouter;
