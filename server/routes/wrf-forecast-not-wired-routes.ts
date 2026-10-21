import express from 'express';
import { notWiredEnvelope } from '../middleware/require-wired-storage.js';

/**
 * backend#1289 (b3): GET /api/v1/weather/wrf-forecast/<location> has no
 * source: no WRF model run is published to the backend. It used to fall
 * through to the catch-all 404 "Endpoint not found"; it answers the
 * backend#1145 honest-gap 501 instead, which mobile maps to "Not Available
 * Yet". The location is not echoed back (backend#1290).
 *
 * Mounted at '/api'. The router has only this GET route and no router.use(),
 * so every other request passes through it untouched.
 */
export function createWrfForecastNotWiredRouter(): express.Router {
  const router = express.Router();

  router.get('/v1/weather/wrf-forecast/*', (_req, res) => {
    res.status(501).json(
      notWiredEnvelope({
        capability: 'weather.wrf-forecast',
        message: 'WRF model forecasts are not wired on this API: no WRF model run is published to the backend',
        details: 'NOAA NWS forecasts are served at GET /api/weather/forecast/<lat,lon>.',
        see: 'wrfcoin/backend#1289',
      }),
    );
  });

  return router;
}
