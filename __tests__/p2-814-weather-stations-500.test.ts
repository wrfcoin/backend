/**
 * Tests for #814: GET /api/weather/stations returns 500 on testnet.
 *
 * Root cause: the baseline DB schema has a `weather_stations` table but
 * WITHOUT `latitude`, `longitude`, or `name` columns. Those are only added
 * by the manual migration `788-station-registration.sql`. When that migration
 * hasn't been applied, `listRegisteredStations()` throws
 * "column latitude does not exist" and the handler's catch re-threw as 500.
 *
 * Fix (weather-routes.js GET /stations): inner try-catch — degrade to an
 * empty station list and return 200 so the map renders blank rather than
 * crashing. Matches the pattern already used in /providers and /coverage-zones.
 *
 * Strategy: minimal express app that exactly mirrors the new handler behavior,
 * consistent with weather-stations-route-coords.test.ts. Testing the actual
 * router requires mocking CJS + 4 dynamic ESM deps; the predicate-copy
 * approach is the established pattern for this file.
 */

import express, { Request, Response } from 'express';
import request from 'supertest';

// ─── handler mirror ───────────────────────────────────────────────────────────
// Exactly mirrors the fixed GET /stations handler in weather-routes.js (#814).

type StationRow = Record<string, unknown>;

function buildStationsApp(
  listRegisteredStations: () => Promise<StationRow[]>,
  warnFn: (msg: string, meta: Record<string, unknown>) => void = () => {},
) {
  const app = express();
  app.use(express.json());

  app.get('/stations', async (_req: Request, res: Response) => {
    let stations: StationRow[] = [];
    try {
      stations = await listRegisteredStations();
    } catch (error) {
      warnFn('Could not list contributor stations, returning empty list', {
        error: (error as Error).message,
      });
    }
    return res.json({ stations, total: stations.length, source: 'wrfcoin-contributors' });
  });

  return app;
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('GET /api/weather/stations — DB failure degrades to 200 not 500 (#814)', () => {

  it('returns 200 with empty array when DB throws "column does not exist" (#814)', async () => {
    const err = new Error('column "latitude" does not exist');
    const app = buildStationsApp(() => { throw err; });

    const res = await request(app).get('/stations');

    expect(res.status).toBe(200);
    expect(res.body.stations).toEqual([]);
    expect(res.body.total).toBe(0);
    expect(res.body.source).toBe('wrfcoin-contributors');
  });

  it('returns 200 with empty array when DB throws any other error (#814)', async () => {
    const app = buildStationsApp(() => {
      throw new Error('relation "weather_stations" does not exist');
    });

    const res = await request(app).get('/stations');

    expect(res.status).toBe(200);
    expect(res.body.stations).toEqual([]);
    expect(res.body.total).toBe(0);
  });

  it('logs a warning (not an error) on DB failure — no 500 thrown (#814)', async () => {
    const warnSpy = jest.fn();
    const app = buildStationsApp(
      () => { throw new Error('column "latitude" does not exist'); },
      warnSpy,
    );

    await request(app).get('/stations');

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toContain('returning empty list');
  });

  it('returns 200 with station data when DB succeeds (#814)', async () => {
    const mockStations: StationRow[] = [
      { stationId: 'ws-001', name: 'Rooftop Alpha', latitude: 46.8, longitude: -92.1,
        status: 'active', qualityScore: 95, totalRewards: '12.5', ownerAddress: '0xABCD' },
      { stationId: 'ws-002', name: 'Parking Beta', latitude: 46.9, longitude: -91.9,
        status: 'inactive', qualityScore: 70, totalRewards: '4.0', ownerAddress: '0xEFGH' },
    ];
    const app = buildStationsApp(async () => mockStations);

    const res = await request(app).get('/stations');

    expect(res.status).toBe(200);
    expect(res.body.stations).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.source).toBe('wrfcoin-contributors');
    expect(res.body.stations[0].stationId).toBe('ws-001');
  });

  it('returns empty array when DB returns zero rows (no stations registered yet)', async () => {
    const app = buildStationsApp(async () => []);

    const res = await request(app).get('/stations');

    expect(res.status).toBe(200);
    expect(res.body.stations).toEqual([]);
    expect(res.body.total).toBe(0);
  });
});
