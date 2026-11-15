/**
 * POST /api/weather/stations and the website station registration switch.
 * With the switch OFF the route must not load the registration module at all, so
 * a module that cannot be loaded cannot break connecting a station. With it ON a
 * load failure refuses the request instead of issuing a name-based id.
 * Made-up ids and addresses only.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../server/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../server/middleware/auth-middleware.js', () => ({
  authenticateToken: (req: any, _res: any, next: any) => {
    req.user = { address: '0x' + 'a'.repeat(40) };
    return next();
  },
}));
const mockClient = { query: jest.fn(async () => ({ rows: [] })), release: jest.fn() };
jest.mock('../../server/db.js', () => ({ pool: { connect: async () => mockClient, query: jest.fn() } }));
const mockRegister = jest.fn();
jest.mock('../../server/services/station-registration-service.js', () => ({
  registerStation: (...a: unknown[]) => mockRegister(...a),
}));
let mockLoads = 0;
jest.mock('../../server/services/website-station-chain-registration.js', () => {
  mockLoads += 1;
  throw new Error('registration module cannot be loaded');
});
jest.mock('../../server/controllers/enhanced-weather-controller', () =>
  jest.fn().mockImplementation(() => ({ getNearbyStations: jest.fn(), getWeatherAlerts: jest.fn(), getServicesHealth: jest.fn() }))
);

const weatherRoutes = require('../../server/routes/weather-routes.js');
const app = () => {
  const a = express();
  a.use(express.json());
  a.use('/api/weather', weatherRoutes);
  return a;
};
const SWITCH = 'WEBSITE_STATION_CHAIN_REGISTRATION_ENABLED';
const saved = { switch: process.env[SWITCH], key: process.env.API_KEY_ENCRYPTION_KEY };

beforeEach(() => {
  process.env.API_KEY_ENCRYPTION_KEY = 'ab'.repeat(32);
  mockRegister.mockReset();
  mockRegister.mockResolvedValue({ status: 201, body: { stationId: 'fixture-station' } });
});
afterAll(() => {
  for (const [name, value] of [[SWITCH, saved.switch], ['API_KEY_ENCRYPTION_KEY', saved.key]] as const) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

describe('POST /stations and the registration switch', () => {
  test.each([undefined, 'false', '1', 'TRUE'])('switch %p: the station is connected and the module is never loaded', async (value) => {
    if (value === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = value;
    const before = mockLoads;
    await request(app()).post('/api/weather/stations').send({ name: 'fixture' }).expect(201);
    expect(mockLoads).toBe(before);
    expect(mockRegister).toHaveBeenCalledTimes(1);
    // No generator is handed over: ids are issued the way they were before.
    expect(mockRegister.mock.calls[0][4].neutralStationId).toBeUndefined();
  });

  test('switch on and the module cannot be loaded: refused, and no station is created with a name-based id', async () => {
    process.env[SWITCH] = 'true';
    const res = await request(app()).post('/api/weather/stations').send({ name: 'fixture' });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mockRegister).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain('cannot be loaded');
  });
});
