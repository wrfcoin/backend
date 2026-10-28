import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateJWT } from '../middleware/auth.js';
import {
  AlertPollLocation,
  mapSevereWeatherResponseErrorStatus,
  SevereWeatherResponseService,
} from '../services/weather/severe-weather-response-service.js';

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

export function createWeatherAlertsRouter(
  service: SevereWeatherResponseService = new SevereWeatherResponseService()
): express.Router {
  const router = express.Router();

  // All weather alert operations require authentication (#231). Scoped to
  // this router's own subtree: the router is mounted at bare '/api', so an
  // unscoped router.use(authenticateJWT) 401s every unmatched /api/* request
  // flowing through it — silently auth-gating the entire modular mount table
  // registered after it (#880).
  router.use('/weather/alerts', authenticateJWT);

  // Read-only research endpoint. There is no client-submitted verification route.
  router.get('/weather/alerts/shadow', weatherGetLimiter, async (_req, res) => {
    if (process.env.ALERT_ENGINE_SHADOW !== '1') return res.status(404).json({ error: 'Shadow alerts disabled' });
    try {
      const { pool } = await import('../db.js');
      const { ShadowAlertStore } = await import('../services/weather/shadow-alert-store.js');
      const events = await new ShadowAlertStore(pool).list();
      return res.json({ shadow: true, events });
    } catch { return res.status(503).json({ error: 'Shadow history unavailable' }); }
  });

  router.get('/weather/alerts/active', weatherGetLimiter, (_req, res) => {
    try {
      const alerts = service.getActiveAlerts();
      return res.status(200).json({
        success: true,
        count: alerts.length,
        alerts,
        lastPollAt: service.getLastPollAt(),
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.get('/weather/alerts/history', weatherGetLimiter, (req, res) => {
    try {
      const rawLimit = Number.parseInt(String(req.query.limit || '200'), 10);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(rawLimit, 5000)) : 200;
      const history = service.getAlertHistory(limit);
      return res.status(200).json({
        success: true,
        count: history.length,
        history,
        lastPollAt: service.getLastPollAt(),
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  router.post('/weather/alerts/poll', weatherPostLimiter, async (req, res) => {
    try {
      if (req.body !== undefined && req.body !== null) {
        if (typeof req.body !== 'object' || Array.isArray(req.body)) {
          return res.status(400).json({
            success: false,
            error: 'Request body must be a JSON object when provided',
          });
        }
      }

      const locations = parseLocations(req.body?.locations);
      const summary = await service.pollNow(locations);
      return res.status(201).json({
        success: true,
        summary,
      });
    } catch (error) {
      return sendRouteError(res, error);
    }
  });

  return router;
}

const defaultRouter = createWeatherAlertsRouter();
export default defaultRouter;

function parseLocations(value: unknown): AlertPollLocation[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('locations must be an array of { latitude, longitude }');
  }

  return value.map((item, idx) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`locations[${idx}] must be an object`);
    }
    return {
      id: typeof (item as any).id === 'string' ? (item as any).id : undefined,
      latitude: Number((item as any).latitude),
      longitude: Number((item as any).longitude),
    };
  });
}

function sendRouteError(
  res: express.Response,
  error: unknown
): express.Response {
  if (error instanceof Error) {
    const mappedStatus = mapSevereWeatherResponseErrorStatus(error);
    const status = mappedStatus === 500 && /locations/i.test(error.message) ? 400 : mappedStatus;
    return res.status(status).json({
      success: false,
      error: error.message || 'Unknown error',
    });
  }

  return res.status(500).json({
    success: false,
    error: 'Unknown error',
  });
}
