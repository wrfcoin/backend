import express from 'express';
import {
  ForecastVerificationRequest,
  ForecastVerificationService,
  mapVerificationErrorStatus,
} from '../services/forecast/forecast-verification-service.js';

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
