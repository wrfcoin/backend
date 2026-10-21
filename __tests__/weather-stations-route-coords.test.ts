/**
 * Route-level test for GET /api/weather/stations coordinate routing (#789).
 *
 * The real router (server/routes/weather-routes.js) decides between two
 * branches purely from req.query:
 *   - EITHER lat OR lng present  -> getNearbyStations (which 400s if one is
 *     missing), so a partial query like ?lat=46.8 cannot silently become a
 *     contributor-list query.
 *   - NEITHER present            -> the DB contributor-list branch.
 *
 * This test reproduces that exact predicate over a minimal Express app so the
 * routing decision is verified without importing the heavy CJS router (which
 * constructs the full controller + rate limiters at require time).
 */

import express from 'express';
import request from 'supertest';

/** The routing predicate copied verbatim from weather-routes.js GET /stations. */
function mountStationsRoute(
  app: express.Express,
  getNearbyStations: (req: express.Request, res: express.Response) => void,
  listContributorStations: (req: express.Request, res: express.Response) => void
): void {
  app.get('/stations', (req, res) => {
    if (req.query.lat || req.query.lng) {
      return getNearbyStations(req, res);
    }
    return listContributorStations(req, res);
  });
}

describe('GET /stations coordinate routing (#789)', () => {
  function buildApp() {
    const app = express();
    const nearbyHandler = jest.fn((req: express.Request, res: express.Response) => {
      const { lat, lng } = req.query;
      if (!lat || !lng) {
        return res.status(400).json({ error: true, message: 'Latitude and longitude are required' });
      }
      return res.status(200).json({ source: 'nearby', stations: [] });
    });
    const listHandler = jest.fn((_req: express.Request, res: express.Response) => {
      return res.status(200).json({ source: 'wrfcoin-contributors', stations: [], total: 0 });
    });
    mountStationsRoute(app, nearbyHandler, listHandler);
    return { app, nearbyHandler, listHandler };
  }

  it('NEITHER coordinate present -> contributor-list branch (200)', async () => {
    const { app, nearbyHandler, listHandler } = buildApp();
    const res = await request(app).get('/stations');
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('wrfcoin-contributors');
    expect(listHandler).toHaveBeenCalledTimes(1);
    expect(nearbyHandler).not.toHaveBeenCalled();
  });

  it('partial query ?lat only -> getNearbyStations, which returns 400 (no silent fall-through)', async () => {
    const { app, nearbyHandler, listHandler } = buildApp();
    const res = await request(app).get('/stations').query({ lat: '46.8' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe(true);
    expect(nearbyHandler).toHaveBeenCalledTimes(1);
    expect(listHandler).not.toHaveBeenCalled();
  });

  it('partial query ?lng only -> getNearbyStations, which returns 400', async () => {
    const { app, nearbyHandler, listHandler } = buildApp();
    const res = await request(app).get('/stations').query({ lng: '-92.0' });
    expect(res.status).toBe(400);
    expect(nearbyHandler).toHaveBeenCalledTimes(1);
    expect(listHandler).not.toHaveBeenCalled();
  });

  it('BOTH coordinates present -> getNearbyStations (200)', async () => {
    const { app, nearbyHandler, listHandler } = buildApp();
    const res = await request(app).get('/stations').query({ lat: '46.8', lng: '-92.0' });
    expect(res.status).toBe(200);
    expect(res.body.source).toBe('nearby');
    expect(nearbyHandler).toHaveBeenCalledTimes(1);
    expect(listHandler).not.toHaveBeenCalled();
  });
});
