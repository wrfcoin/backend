/**
 * Owner ruling Q5 (2026-09-27): the anonymous contributor list is keyed by the
 * public station alias — including its keyset cursor, so no station id appears
 * in a response or a follow-up URL.
 */
const express = require('express');
const request = require('supertest');
const { stationAlias } = require('../../server/utils/station-alias');

jest.mock('../../server/utils/logger', () => ({
  logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() },
}));

const mockList = jest.fn();
jest.mock('../../server/services/station-registration-service.js', () => ({
  listRegisteredStations: (...args: unknown[]) => mockList(...args),
}));

const mockQuery = jest.fn();
jest.mock('../../server/db.js', () => ({ pool: { query: (...args: unknown[]) => mockQuery(...args) } }));

jest.mock('../../server/controllers/enhanced-weather-controller', () =>
  jest.fn().mockImplementation(() => ({ getNearbyStations: jest.fn(), getWeatherAlerts: jest.fn(), getServicesHealth: jest.fn() }))
);

const weatherRoutes = require('../../server/routes/weather-routes.js');

function app() {
  const a = express();
  a.use('/api/weather', weatherRoutes);
  return a;
}

const row = (id: string) => ({
  id, stationId: id, name: 'Neutral label', latitude: 10.123456, longitude: -20.987654,
  location: 'Secret St', status: 'active', qualityScore: 90, totalRewards: '5', ownerAddress: '0x' + 'b'.repeat(40),
});

describe('GET /api/weather/stations alias cursor', () => {
  const original = process.env.WRFCOIN_OPERATOR_TOKEN;
  beforeEach(() => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'op-token';
    mockList.mockReset();
    mockQuery.mockReset();
  });
  afterAll(() => {
    process.env.WRFCOIN_OPERATOR_TOKEN = original;
  });

  test('anonymous: nextCursor is an alias and no station id appears anywhere', async () => {
    mockList.mockResolvedValue({ stations: [row('PWS-JANE-01')], nextCursor: 'PWS-JANE-01', hasMore: true });
    const res = await request(app()).get('/api/weather/stations?limit=1').expect(200);
    expect(res.body.nextCursor).toBe(stationAlias('PWS-JANE-01'));
    expect(res.body.stations[0]).toEqual({
      alias: stationAlias('PWS-JANE-01'), name: 'Neutral label', latitude: 10.1, longitude: -21, status: 'active',
      lastDataUpdate: null, isActive: null, qualityScore: 90,
    });
    expect(JSON.stringify(res.body)).not.toContain('PWS-JANE-01');
    expect(JSON.stringify(res.body)).not.toMatch(/stationId|"id"|Secret St|bbbb|totalRewards/);
  });

  test('anonymous: ?after=<alias> resolves to the internal id for the keyset', async () => {
    mockQuery.mockResolvedValue({ rows: [{ station_id: 'PWS-JANE-01' }] });
    mockList.mockResolvedValue({ stations: [row('PWS-ZED-02')], nextCursor: null, hasMore: false });
    await request(app()).get(`/api/weather/stations?after=${stationAlias('PWS-JANE-01')}`).expect(200);
    expect(mockQuery.mock.calls[0][0]).toContain('sha256(');
    expect(mockList.mock.calls[0][1]).toEqual({ limit: undefined, after: 'PWS-JANE-01', chainLastSeen: expect.any(Function) });
  });

  test.each([
    ['a raw station id', 'PWS-JANE-01', { rows: [] }],
    ['an unknown alias', stationAlias('NOPE'), { rows: [] }],
  ])('anonymous: ?after=%s → 400 INVALID_CURSOR, list not queried', async (_l, after, rows) => {
    mockQuery.mockResolvedValue(rows);
    const res = await request(app()).get(`/api/weather/stations?after=${encodeURIComponent(after)}`).expect(400);
    expect(res.body.error.code).toBe('INVALID_CURSOR');
    expect(mockList).not.toHaveBeenCalled();
  });

  test('operator: real ids, raw cursor passes through, alias added', async () => {
    mockList.mockResolvedValue({ stations: [row('PWS-JANE-01')], nextCursor: 'PWS-JANE-01', hasMore: true });
    const res = await request(app())
      .get('/api/weather/stations?after=PWS-AAA')
      .set('Authorization', 'Bearer op-token')
      .expect(200);
    expect(mockList.mock.calls[0][1]).toEqual({ limit: undefined, after: 'PWS-AAA', chainLastSeen: expect.any(Function) });
    expect(res.body.stations[0]).toEqual({ ...row('PWS-JANE-01'), alias: stationAlias('PWS-JANE-01') });
    expect(res.body.nextCursor).toBe('PWS-JANE-01');
  });
});

// #1258 review P2: a stored name equal to / containing the raw id is not served.
describe('anonymous display name never carries the raw id', () => {
  const original = process.env.WRFCOIN_OPERATOR_TOKEN;
  beforeEach(() => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'op-token';
    mockList.mockReset();
  });
  afterAll(() => {
    process.env.WRFCOIN_OPERATOR_TOKEN = original;
  });

  test.each([
    ['name == id', 'PWS-REVIEW-JANE-01'],
    ['name contains id (other case)', "pws-review-jane-01's station"],
    ['empty name', ''],
  ])('%s → neutral alias label', async (_l, name) => {
    mockList.mockResolvedValue({ stations: [{ ...row('PWS-REVIEW-JANE-01'), name }], nextCursor: null, hasMore: false });
    const res = await request(app()).get('/api/weather/stations').expect(200);
    const alias = stationAlias('PWS-REVIEW-JANE-01');
    expect(res.body.stations[0].name).toBe(`Weather station ${alias}`);
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('pws-review-jane-01');
  });

  test('an operator-chosen neutral name is served as-is; operator sees the stored name', async () => {
    mockList.mockResolvedValue({ stations: [{ ...row('PWS-REVIEW-JANE-01'), name: 'Duluth, MN weather station' }], nextCursor: null, hasMore: false });
    const anon = await request(app()).get('/api/weather/stations').expect(200);
    expect(anon.body.stations[0].name).toBe('Duluth, MN weather station');
    mockList.mockResolvedValue({ stations: [{ ...row('PWS-REVIEW-JANE-01'), name: 'PWS-REVIEW-JANE-01' }], nextCursor: null, hasMore: false });
    const op = await request(app()).get('/api/weather/stations').set('Authorization', 'Bearer op-token').expect(200);
    expect(op.body.stations[0].name).toBe('PWS-REVIEW-JANE-01');
  });
});

// backend#1255/#1263 fields on the anonymous projection: type-validated, and
// never a carrier for the raw id.
describe('anonymous freshness fields (#1263) are validated', () => {
  const original = process.env.WRFCOIN_OPERATOR_TOKEN;
  beforeEach(() => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'op-token';
    mockList.mockReset();
  });
  afterAll(() => {
    process.env.WRFCOIN_OPERATOR_TOKEN = original;
  });

  test('valid values pass: live, ISO lastDataUpdate, boolean isActive', async () => {
    mockList.mockResolvedValue({ stations: [{ ...row('PWS-JANE-01'), status: 'live', lastDataUpdate: '2026-09-27T00:29:00.000Z', isActive: false }], nextCursor: null, hasMore: false });
    const res = await request(app()).get('/api/weather/stations').expect(200);
    expect(res.body.stations[0]).toMatchObject({ status: 'live', lastDataUpdate: '2026-09-27T00:29:00.000Z', isActive: false });
  });

  test.each([
    ['raw id', 'PWS-JANE-01'],
    ['raw id with a date prefix', '2026-09-27T00:29:00Z PWS-JANE-01'],
    ['V8-parsable non-ISO text', 'PWS-JANE-01 2026'],
    ['an object', { at: '2026-09-27T00:29:00Z', station: 'PWS-JANE-01' }],
  ])('lastDataUpdate as %s → null; the raw id never appears', async (_l, value) => {
    mockList.mockResolvedValue({ stations: [{ ...row('PWS-JANE-01'), status: 'PWS-JANE-01', lastDataUpdate: value, isActive: 'PWS-JANE-01' }], nextCursor: null, hasMore: false });
    const res = await request(app()).get('/api/weather/stations').expect(200);
    expect(res.body.stations[0]).toMatchObject({ status: null, lastDataUpdate: null, isActive: null });
    expect(JSON.stringify(res.body).toLowerCase()).not.toContain('pws-jane-01');
  });
});
