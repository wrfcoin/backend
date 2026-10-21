import express from 'express';
import rateLimit from 'express-rate-limit';
import { authenticateJWT } from '../middleware/auth.js';
import {
  DEFAULT_DAYS,
  MAX_DAYS,
  getTemperatureHistory,
  type TransactionRunner,
} from '../services/temperature-history.js';

const weatherGetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const ALLOWED_KEYS = new Set(['latE1', 'lonE1', 'days']);

function defaultRunner(): TransactionRunner {
  return async (callback) => {
    // Lazy import keeps ESM/CJS bundling safe (#268). executeTransaction opens one
    // transaction, so the statement_timeout set inside it is local to it.
    const mod = await import('../../database/connection.js');
    return mod.executeTransaction(callback);
  };
}

function integerInRange(
  value: unknown,
  min: number,
  max: number,
): number | null {
  if (typeof value !== 'string' || !/^-?\d{1,4}$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max
    ? parsed
    : null;
}

export function createWeatherTemperatureHistoryRouter(
  run?: TransactionRunner,
): express.Router {
  const router = express.Router();
  router.use(authenticateJWT);

  // GET /  ?latE1=<int tenths>&lonE1=<int tenths>&days=<1..30>
  router.get('/', weatherGetLimiter, async (req, res) => {
    // Error bodies never echo the input: a rejected request may carry an exact coordinate.
    const keys = Object.keys(req.query);
    if (keys.some((key) => !ALLOWED_KEYS.has(key))) {
      return res.status(400).json({
        error:
          'Only latE1, lonE1 and days are accepted (integer tenths of a degree; no finer coordinates)',
      });
    }
    const latE1 = integerInRange(req.query.latE1, -900, 900);
    const lonE1 = integerInRange(req.query.lonE1, -1800, 1800);
    if (latE1 === null || lonE1 === null) {
      return res.status(400).json({
        error:
          'latE1 in [-900, 900] and lonE1 in [-1800, 1800] are required as integer tenths of a degree',
      });
    }
    let days = DEFAULT_DAYS;
    if (req.query.days !== undefined) {
      const parsed = integerInRange(req.query.days, 1, MAX_DAYS);
      if (parsed === null)
        return res
          .status(400)
          .json({ error: `days must be an integer from 1 to ${MAX_DAYS}` });
      days = parsed;
    }

    try {
      const history = await getTemperatureHistory(run ?? defaultRunner(), { latE1, lonE1, days });
      res.setHeader('Cache-Control', 'private, max-age=300');
      return res.status(200).json(history);
    } catch (err) {
      // 57014 = query_canceled: the database-side statement_timeout fired.
      const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
      if (code === '57014') {
        return res.status(503).json({ error: 'Temperature history is temporarily unavailable' });
      }
      return res.status(500).json({ error: 'Internal server error' });
    }
  });

  return router;
}

export default createWeatherTemperatureHistoryRouter();
