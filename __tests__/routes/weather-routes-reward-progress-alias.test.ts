/**
 * Owner ruling Q5 follow-up (stage15 ack point 1): the authenticated owner may
 * call reward-progress with the public alias; it resolves AFTER authentication
 * and the ownership check is unchanged.
 */
const express = require('express');
const request = require('supertest');
const { stationAlias } = require('../../server/utils/station-alias');

jest.mock('../../server/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

let mockUser: { address: string } | null = null;
jest.mock('../../server/middleware/auth-middleware.js', () => ({
  authenticateToken: (req: any, res: any, next: any) => {
    if (!mockUser) return res.status(401).json({ error: 'unauthenticated' });
    req.user = mockUser;
    return next();
  },
}));

const mockQuery = jest.fn();
jest.mock('../../server/db.js', () => ({ pool: { query: (...a: unknown[]) => mockQuery(...a) } }));

class MockNotFound extends Error {}
const mockProgress = jest.fn();
jest.mock('../../server/services/station-reward-progress.js', () => ({
  getStationRewardProgress: (...a: unknown[]) => mockProgress(...a),
  StationRewardProgressNotFound: MockNotFound,
}));

jest.mock('../../server/controllers/enhanced-weather-controller', () =>
  jest.fn().mockImplementation(() => ({ getNearbyStations: jest.fn(), getWeatherAlerts: jest.fn(), getServicesHealth: jest.fn() }))
);

const weatherRoutes = require('../../server/routes/weather-routes.js');
const app = () => {
  const a = express();
  a.use('/api/weather', weatherRoutes);
  return a;
};

const RAW = 'PWS-DULUTH-JANE-01';
const ALIAS = stationAlias(RAW);
const OWNER = '0x' + 'a'.repeat(40);

describe('reward-progress accepts the public alias for the authenticated owner', () => {
  beforeEach(() => {
    mockUser = { address: OWNER };
    mockQuery.mockReset();
    mockProgress.mockReset();
  });

  test('owner + alias → resolved to the internal id, ownership checked as before', async () => {
    mockQuery.mockResolvedValue({ rows: [{ station_id: RAW }] });
    mockProgress.mockResolvedValue({ state: 'awaiting_observation' });
    const res = await request(app()).get(`/api/weather/stations/${ALIAS}/reward-progress`).expect(200);
    expect(res.body).toEqual({ state: 'awaiting_observation' });
    expect(mockProgress.mock.calls[0][1]).toBe(RAW);
    expect(mockProgress.mock.calls[0][2]).toBe(OWNER);
  });

  test('non-owner + alias → the same 404 as today (no enumeration)', async () => {
    mockQuery.mockResolvedValue({ rows: [{ station_id: RAW }] });
    mockProgress.mockRejectedValue(new MockNotFound('nope'));
    const res = await request(app()).get(`/api/weather/stations/${ALIAS}/reward-progress`).expect(404);
    expect(res.body.error?.code ?? res.body.code).toBe('NOT_FOUND');
  });

  test('unknown alias → the same 404, progress never queried', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await request(app()).get(`/api/weather/stations/${stationAlias('NOPE')}/reward-progress`).expect(404);
    expect(mockProgress).not.toHaveBeenCalled();
  });

  test('unauthenticated + alias → 401 before any alias lookup', async () => {
    mockUser = null;
    await request(app()).get(`/api/weather/stations/${ALIAS}/reward-progress`).expect(401);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  test('raw id keeps working for the owner', async () => {
    mockProgress.mockResolvedValue({ state: 'rewarded' });
    await request(app()).get(`/api/weather/stations/${RAW}/reward-progress`).expect(200);
    expect(mockProgress.mock.calls[0][1]).toBe(RAW);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
