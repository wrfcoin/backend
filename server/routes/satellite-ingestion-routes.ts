import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  NoaaGoesIngestionService,
  SatelliteIngestionError,
} from '../services/satellite/noaa-goes-ingestion-service.js';
import { BoundingBox } from '../services/satellite/satellite-observation-types.js';

const MAX_EXTRACT_OBSERVATIONS = 2000;

interface SatelliteRouterOptions {
  requireAuth?: boolean;
  authToken?: string;
}

export function createSatelliteIngestionRouter(
  service: NoaaGoesIngestionService = new NoaaGoesIngestionService(),
  options: SatelliteRouterOptions = {}
): express.Router {
  const router = express.Router();
  const requireAuth = options.requireAuth !== false;
  const authToken = resolveSatelliteAuthToken(options.authToken);

  router.use('/ingestion/satellite-goes', express.json({ limit: '1mb' }));
  router.use(
    '/ingestion/satellite-goes',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: 'Too many satellite ingestion requests' },
    })
  );

  router.post('/ingestion/satellite-goes/poll', async (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    try {
      const result = await service.pollLatest(req.body || {});
      return res.status(201).json({
        success: true,
        result,
      });
    } catch (error) {
      return res.status(mapStatusCode(error)).json({
        success: false,
        error: error instanceof Error && mapStatusCode(error) < 500 ? error.message : 'GOES poll failed',
      });
    }
  });

  router.post('/ingestion/satellite-goes/backfill', async (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    const { startTime, endTime } = req.body || {};
    if (!startTime || !endTime) {
      return res.status(400).json({
        success: false,
        error: 'startTime and endTime are required',
      });
    }

    try {
      const result = await service.backfill(req.body);
      return res.status(201).json({
        success: true,
        result,
      });
    } catch (error) {
      return res.status(mapStatusCode(error)).json({
        success: false,
        error:
          error instanceof Error && mapStatusCode(error) < 500
            ? error.message
            : 'GOES backfill failed',
      });
    }
  });

  router.post('/ingestion/satellite-goes/extract', async (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    try {
      const boundsCandidate = req.body?.bounds;
      if (!isBoundingBox(boundsCandidate)) {
        return res.status(400).json({
          success: false,
          error: 'bounds must include finite west/south/east/north values',
        });
      }

      const observations = Array.isArray(req.body?.observations)
        ? req.body.observations
        : service.getRecentObservations();
      if (observations.length > MAX_EXTRACT_OBSERVATIONS) {
        return res.status(413).json({
          success: false,
          error: `Too many observations in extract request; max ${MAX_EXTRACT_OBSERVATIONS}`,
        });
      }
      if (!observations.every(isExtractableObservation)) {
        return res.status(400).json({
          success: false,
          error: 'observations must include coverageBounds with finite west/south/east/north',
        });
      }

      const extracted = service.extractRegional(observations, boundsCandidate as BoundingBox);
      return res.status(200).json({
        success: true,
        extracted,
      });
    } catch (error) {
      return res.status(mapStatusCode(error)).json({
        success: false,
        error:
          error instanceof Error && mapStatusCode(error) < 500
            ? error.message
            : 'Regional extraction failed',
      });
    }
  });

  router.get('/ingestion/satellite-goes/metrics', (req, res) => {
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

function mapStatusCode(error: unknown): number {
  if (error instanceof SatelliteIngestionError) {
    return error.statusCode;
  }
  return 500;
}

function resolveSatelliteAuthToken(overrideToken?: string): string | null {
  if (overrideToken && overrideToken.trim().length > 0) {
    return overrideToken.trim();
  }
  const envToken = process.env.SATELLITE_INGESTION_API_TOKEN || process.env.COMPUTE_API_TOKEN;
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
    return { status: 503, message: 'Satellite ingestion auth token is not configured' };
  }

  const bearer = extractBearerToken(req.get('authorization'));
  const presented = bearer || req.get('x-api-key');
  if (presented !== token) {
    return { status: 401, message: 'Unauthorized' };
  }
  return null;
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }
  const token = authHeader.substring(7).trim();
  return token.length > 0 ? token : null;
}

function isBoundingBox(value: unknown): value is BoundingBox {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const bounds = value as Record<string, unknown>;
  return (
    isFiniteNumber(bounds.west) &&
    isFiniteNumber(bounds.south) &&
    isFiniteNumber(bounds.east) &&
    isFiniteNumber(bounds.north)
  );
}

function isExtractableObservation(value: unknown): boolean {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const observation = value as Record<string, unknown>;
  return isBoundingBox(observation.coverageBounds);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
