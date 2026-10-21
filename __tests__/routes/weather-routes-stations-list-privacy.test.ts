/**
 * backend#1113: GET /api/weather/stations (contributor map pins) was fully
 * unauthenticated and leaked ownerAddress + totalRewards per station. Verifies
 * those fields are stripped for anonymous callers and only present for a
 * valid operator-token caller.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../server/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const FIXTURE_STATIONS = [
  {
    id: 'station-1',
    stationId: 'station-1',
    name: 'Rooftop Station',
    mac: 'AA:BB:CC:DD:EE:FF',
    macAddress: 'AA:BB:CC:DD:EE:FF',
    mac_address: 'AA:BB:CC:DD:EE:FF',
    metadata: {mac: 'AA:BB:CC:DD:EE:FF'},
    latitude: 45.50321,
    longitude: -122.60432,
    location: 'Portland, OR',
    status: 'live',
    lastDataUpdate: '2026-09-27T00:29:00.000Z',
    qualityScore: 91,
    totalRewards: '250000000',
    ownerAddress: '0x' + 'a'.repeat(40),
  },
];

jest.mock('../../server/services/station-registration-service.js', () => ({
  listRegisteredStations: jest.fn(async () => ({
    stations: FIXTURE_STATIONS,
    nextCursor: null,
    hasMore: false,
  })),
}));

jest.mock('../../server/db.js', () => ({ pool: {} }));

// The controller isn't exercised by this route in the coord-less branch
// tested here, but the module constructs one at require-time.
jest.mock('../../server/controllers/enhanced-weather-controller', () => {
  return jest.fn().mockImplementation(() => ({
    getNearbyStations: jest.fn(),
    getWeatherAlerts: jest.fn(),
    getServicesHealth: jest.fn(),
  }));
});

const weatherRoutes = require('../../server/routes/weather-routes.js');

function buildApp() {
  const app = express();
  app.use('/api/weather', weatherRoutes);
  return app;
}

describe('GET /api/weather/stations — owner/reward field privacy (backend#1113)', () => {
  const originalOperatorToken = process.env.WRFCOIN_OPERATOR_TOKEN;

  afterAll(() => {
    process.env.WRFCOIN_OPERATOR_TOKEN = originalOperatorToken;
  });

  it('strips ownerAddress and totalRewards for an anonymous caller', async () => {
    delete process.env.WRFCOIN_OPERATOR_TOKEN;

    const res = await request(buildApp()).get('/api/weather/stations');

    expect(res.status).toBe(200);
    expect(res.body.stations).toHaveLength(1);
    const station = res.body.stations[0];
    expect(station).not.toHaveProperty('ownerAddress');
    expect(JSON.stringify(station)).not.toContain('AA:BB:CC');
    expect(station).not.toHaveProperty('metadata');
    expect(station).not.toHaveProperty('totalRewards');
    // Public map-pin fields remain.
    // Owner ruling Q5: keyed by the public alias, no raw id.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    expect(station.alias).toBe(require('../../server/utils/station-alias').stationAlias('station-1'));
    expect(station).not.toHaveProperty('id');
    expect(station).not.toHaveProperty('stationId');
    expect(station.latitude).toBe(45.5);
    expect(station.qualityScore).toBe(91);
    expect(station.longitude).toBe(-122.60);
    expect(station.lastDataUpdate).toBe('2026-09-27T00:29:00.000Z');
    expect(station.status).toBe('live');
    expect(station).not.toHaveProperty('location');
  });

  it('passes chain freshness to the list and keeps the anonymous projection id-free (backend#1280)', async () => {
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    const { listRegisteredStations } = require('../../server/services/station-registration-service.js');
    listRegisteredStations.mockClear();

    const res = await request(buildApp()).get('/api/weather/stations');

    expect(res.status).toBe(200);
    const options = listRegisteredStations.mock.calls[0][1];
    expect(typeof options.chainLastSeen).toBe('function');
    expect(res.body.stations[0]).toMatchObject({ status: 'live', lastDataUpdate: '2026-09-27T00:29:00.000Z' });
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('station-1');
  });

  it('includes ownerAddress and totalRewards for a valid operator-token caller', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'operator-secret-token-value';

    const res = await request(buildApp())
      .get('/api/weather/stations')
      .set('authorization', 'Bearer operator-secret-token-value');

    expect(res.status).toBe(200);
    const station = res.body.stations[0];
    expect(station.ownerAddress).toBe('0x' + 'a'.repeat(40));
    expect(station.totalRewards).toBe('250000000');
  });

  it('still strips owner/reward fields for a wrong operator token', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'operator-secret-token-value';

    const res = await request(buildApp())
      .get('/api/weather/stations')
      .set('authorization', 'Bearer not-the-right-token');

    expect(res.status).toBe(200);
    const station = res.body.stations[0];
    expect(station).not.toHaveProperty('ownerAddress');
    expect(JSON.stringify(station)).not.toContain('AA:BB:CC');
    expect(station).not.toHaveProperty('metadata');
    expect(station).not.toHaveProperty('totalRewards');
  });
});
