/**
 * core4#28 / ADR 2026-10-23-3563 (owner answer A1): /api/weather/coverage-zones shows the
 * rule the chain PAYS, read from core4 GET /network/scarcity, and nothing else. The old
 * database grouping (0.1 degree buckets over weather_stations, an unreachable 2.0x "desert"
 * bucket) is gone: a node that cannot answer is "unavailable", never a guessed rule.
 * Bodies follow core4 routes/scarcity.rs ScarcityResponse.
 */
import express from 'express';
import request from 'supertest';

jest.mock('../server/db', () => ({ pool: { query: jest.fn(), connect: jest.fn() } }));
jest.mock('../database/connection.js', () => ({ executeQuery: jest.fn(async () => ({ rows: [] })) }));
const mockFetchCore4Json = jest.fn();
jest.mock('../shared/core4-route-client.js', () => ({
  fetchCore4Json: (...args: unknown[]) => mockFetchCore4Json(...args),
  extractCore4Data: (p: any) => p?.data ?? p,
  forwardCore4Headers: jest.fn(() => ({})),
}));

import { createScarcityReader, parseScarcityPayload, resetDefaultScarcityReader } from '../server/services/chain-scarcity';

/* eslint-disable @typescript-eslint/no-var-requires */
const weatherRoutes = require('../server/routes/weather-routes');

const RULE = {
  grid_km: 222, cell_size_degrees: 2, min_station_density: 3, desert_bonus_percent: 150,
  baseline_percent: 100, activation_height: 0, active: true,
};
const BODY = {
  rule: RULE,
  cells: [
    { lat_idx: 68, lon_idx: 42, center_latitude: 47, center_longitude: -93, station_count: 2, multiplier_percent: 150 },
    { lat_idx: 65, lon_idx: 49, center_latitude: 41, center_longitude: -81, station_count: 5, multiplier_percent: 100 },
  ],
  point: null,
  observed_at_height: 4242,
  state_root_hex: 'ab'.repeat(32),
};

describe('parseScarcityPayload', () => {
  it('accepts the core4 body', () => {
    const v = parseScarcityPayload(BODY);
    expect(v?.cells).toHaveLength(2);
    expect(v?.rule.desertBonusMultiplier).toBe(1.5);
  });
  it.each([
    ['no rule', { ...BODY, rule: undefined }],
    ['a multiplier below the baseline', { ...BODY, cells: [{ ...BODY.cells[0], multiplier_percent: 50 }] }],
    ['a multiplier above the 2.0x combined cap', { ...BODY, cells: [{ ...BODY.cells[0], multiplier_percent: 250 }] }],
    ['a non-finite centre', { ...BODY, cells: [{ ...BODY.cells[0], center_latitude: null }] }],
    ['not an object', 'down'],
  ])('rejects %s', (_n, body) => {
    expect(parseScarcityPayload(body)).toBeNull();
  });
});

describe('GET /api/weather/coverage-zones', () => {
  const app = express().use('/api/weather', weatherRoutes);
  const prevToken = process.env.WRFCOIN_READER_TOKEN;
  beforeEach(() => {
    mockFetchCore4Json.mockReset();
    resetDefaultScarcityReader();
    process.env.WRFCOIN_READER_TOKEN = 'reader-token';
  });
  afterAll(() => {
    if (prevToken === undefined) delete process.env.WRFCOIN_READER_TOKEN;
    else process.env.WRFCOIN_READER_TOKEN = prevToken;
  });

  it('serves the chain-paid rule and cells, not a database grouping', async () => {
    mockFetchCore4Json.mockResolvedValue({ ok: true, status: 200, payload: BODY });
    const res = await request(app).get('/api/weather/coverage-zones?fresh=1');
    expect(res.status).toBe(200);
    expect(mockFetchCore4Json).toHaveBeenCalledWith('/network/scarcity', expect.objectContaining({
      headers: expect.objectContaining({ authorization: 'Bearer reader-token' }),
    }));
    expect(res.body.source).toBe('chain');
    expect(res.body.observedAtHeight).toBe(4242);
    expect(res.body.rule).toEqual({
      gridKm: 222, cellSizeDegrees: 2, minStationDensity: 3, desertBonusMultiplier: 1.5,
      baselineMultiplier: 1, activationHeight: 0, active: true,
    });
    expect(res.body.zones).toEqual([
      { lat: 47, lng: -93, radius: 111, type: 'sparse', rewardMultiplier: 1.5, stationCount: 2 },
      { lat: 41, lng: -81, radius: 111, type: 'covered', rewardMultiplier: 1, stationCount: 5 },
    ]);
    // the unreachable 2.0x tier is not invented anywhere
    expect(res.body.zones.some((z: any) => z.rewardMultiplier === 2)).toBe(false);
    expect(res.body.zones.some((z: any) => z.type === 'desert')).toBe(false);
  });

  it('answers 503 unavailable, with no zones, when the node cannot say what is paid', async () => {
    mockFetchCore4Json.mockResolvedValue({ ok: false, status: 503, payload: null });
    const res = await request(app).get('/api/weather/coverage-zones?fresh=2');
    expect(res.status).toBe(503);
    expect(res.body.zones).toBeUndefined();
    expect(res.body.error.code).toBe('SCARCITY_UNAVAILABLE');
  });

  it('answers 503 without calling the node when no reader token is configured', async () => {
    delete process.env.WRFCOIN_READER_TOKEN;
    const res = await request(app).get('/api/weather/coverage-zones?fresh=3');
    expect(res.status).toBe(503);
    expect(mockFetchCore4Json).not.toHaveBeenCalled();
  });
});

describe('createScarcityReader cache', () => {
  it('reads the node once inside the TTL and again after it', async () => {
    let t = 0;
    const fetchCore4Json = jest.fn(async () => ({ ok: true, status: 200, payload: BODY }));
    const read = createScarcityReader({ fetchCore4Json: fetchCore4Json as any, readerToken: () => 'x', now: () => t });
    await read(); await read();
    expect(fetchCore4Json).toHaveBeenCalledTimes(1);
    t = 60_000;
    await read();
    expect(fetchCore4Json).toHaveBeenCalledTimes(2);
  });
});
