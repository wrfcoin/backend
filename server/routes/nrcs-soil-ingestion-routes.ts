import crypto from 'crypto';
import express from 'express';
import rateLimit from 'express-rate-limit';
import {
  NrcsSoilError,
  NrcsSoilService,
} from '../services/soil/nrcs-soil-service.js';

interface NrcsSoilRouterOptions {
  requireAuth?: boolean;
  authToken?: string;
}

export function createNrcsSoilIngestionRouter(
  service: NrcsSoilService = new NrcsSoilService(),
  options: NrcsSoilRouterOptions = {}
): express.Router {
  const router = express.Router();
  const requireAuth = options.requireAuth !== false;
  const authToken = resolveAuthToken(options.authToken);

  router.use('/ingestion/nrcs-soil', express.json({ limit: '1mb' }));
  router.use(
    '/ingestion/nrcs-soil',
    rateLimit({
      windowMs: 15 * 60 * 1000,
      max: 120,
      standardHeaders: true,
      legacyHeaders: false,
      message: { success: false, error: 'Too many NRCS soil ingestion requests' },
    })
  );

  router.post('/ingestion/nrcs-soil/scan', async (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    try {
      const observations = await service.fetchScanObservations(req.body || {});
      return res.status(201).json({ success: true, observations });
    } catch (error) {
      return res.status(mapStatus(error)).json({
        success: false,
        error:
          error instanceof Error && mapStatus(error) < 500
            ? error.message
            : 'NRCS SCAN ingestion failed',
      });
    }
  });

  router.post('/ingestion/nrcs-soil/snotel', async (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    try {
      const observations = await service.fetchSnotelObservations(req.body || {});
      return res.status(201).json({ success: true, observations });
    } catch (error) {
      return res.status(mapStatus(error)).json({
        success: false,
        error:
          error instanceof Error && mapStatus(error) < 500
            ? error.message
            : 'NRCS SNOTEL ingestion failed',
      });
    }
  });

  router.get('/ingestion/nrcs-soil/stations', async (req, res) => {
    const authError = requireAuthorization(requireAuth, authToken, req);
    if (authError) {
      return res.status(authError.status).json({ success: false, error: authError.message });
    }

    try {
      const network = parseNetwork(req.query.network as string | undefined);
      const stationTriplets = parseStationTriplets(req.query.stationTriplets as string | undefined);
      const result = await service.fetchStations({ network, stationTriplets });
      return res.status(200).json({ success: true, ...result });
    } catch (error) {
      return res.status(mapStatus(error)).json({
        success: false,
        error:
          error instanceof Error && mapStatus(error) < 500
            ? error.message
            : 'NRCS station metadata request failed',
      });
    }
  });

  router.get('/ingestion/nrcs-soil/metrics', (req, res) => {
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

function parseNetwork(value: string | undefined): 'SCAN' | 'SNOTEL' | 'ALL' | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.toUpperCase();
  if (normalized === 'SCAN') {
    return 'SCAN';
  }
  if (normalized === 'SNOTEL' || normalized === 'SNTL') {
    return 'SNOTEL';
  }
  if (normalized === 'ALL') {
    return 'ALL';
  }

  throw new NrcsSoilError('network must be one of SCAN, SNOTEL, or ALL', 400);
}

function parseStationTriplets(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }

  const stationTriplets = value
    .split(',')
    .map(station => station.trim())
    .filter(station => station.length > 0);

  if (stationTriplets.length === 0) {
    throw new NrcsSoilError('stationTriplets query must contain at least one triplet', 400);
  }

  return stationTriplets;
}

function mapStatus(error: unknown): number {
  if (error instanceof NrcsSoilError) {
    return error.statusCode;
  }
  return 500;
}

function resolveAuthToken(overrideToken?: string): string | null {
  if (overrideToken && overrideToken.trim().length > 0) {
    return overrideToken.trim();
  }

  const envToken = process.env.NRCS_SOIL_INGESTION_API_TOKEN || process.env.COMPUTE_API_TOKEN;
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
    return { status: 503, message: 'NRCS soil ingestion auth token is not configured' };
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

const defaultRouter = createNrcsSoilIngestionRouter();
export default defaultRouter;
