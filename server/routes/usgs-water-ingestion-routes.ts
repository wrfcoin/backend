import express from 'express';
import crypto from 'crypto';
import rateLimit from 'express-rate-limit';
import {
  UsgsHydrologyError,
  UsgsWaterService,
} from '../services/hydrology/usgs-water-service.js';

interface UsgsWaterRouterOptions {
  requireAuth?: boolean;
  authToken?: string;
}

export function createUsgsWaterIngestionRouter(
  service: UsgsWaterService = new UsgsWaterService(),
  options: UsgsWaterRouterOptions = {}
): express.Router {
  const router = express.Router();
  const requireAuth = options.requireAuth !== false;
  const authToken = resolveAuthToken(options.authToken);

  router.use('/ingestion/usgs-water', express.json({ limit: '1mb' }));
  router.use(
    '/ingestion/usgs-water',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: 'Too many USGS ingestion requests' },
    })
  );

  router.post('/ingestion/usgs-water/iv', async (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    try {
      const observations = await service.fetchInstantaneousValues(req.body || {});
      return res.status(201).json({ success: true, observations });
    } catch (error) {
      return res.status(mapStatus(error)).json({
        success: false,
        error:
          error instanceof Error && mapStatus(error) < 500
            ? error.message
            : 'USGS IV ingestion failed',
      });
    }
  });

  router.post('/ingestion/usgs-water/dv', async (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    try {
      const observations = await service.fetchDailyValues(req.body || {});
      return res.status(201).json({ success: true, observations });
    } catch (error) {
      return res.status(mapStatus(error)).json({
        success: false,
        error:
          error instanceof Error && mapStatus(error) < 500
            ? error.message
            : 'USGS DV ingestion failed',
      });
    }
  });

  router.get('/ingestion/usgs-water/sites', async (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    try {
      const boundingBox = parseBoundingBox(req.query.bbox as string | undefined);
      const result = await service.discoverSites({
        stateCode: req.query.stateCd as string | undefined,
        countyCode: req.query.countyCd as string | undefined,
        boundingBox,
      });
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return res.status(mapStatus(error)).json({
        success: false,
        error:
          error instanceof Error && mapStatus(error) < 500
            ? error.message
            : 'USGS site discovery failed',
      });
    }
  });

  router.get('/ingestion/usgs-water/metrics', (req, res) => {
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

function parseBoundingBox(value: string | undefined):
  | { west: number; south: number; east: number; north: number }
  | undefined {
  if (!value) {
    return undefined;
  }

  const parts = value.split(',').map(Number);
  if (parts.length !== 4 || parts.some(v => !Number.isFinite(v))) {
    throw new UsgsHydrologyError('bbox must be west,south,east,north numeric values', 400);
  }

  return {
    west: parts[0],
    south: parts[1],
    east: parts[2],
    north: parts[3],
  };
}

function mapStatus(error: unknown): number {
  if (error instanceof UsgsHydrologyError) {
    return error.statusCode;
  }
  return 500;
}

function resolveAuthToken(overrideToken?: string): string | null {
  if (overrideToken && overrideToken.trim().length > 0) {
    return overrideToken.trim();
  }
  const envToken = process.env.USGS_WATER_INGESTION_API_TOKEN || process.env.COMPUTE_API_TOKEN;
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
    return { status: 503, message: 'USGS water ingestion auth token is not configured' };
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
