const express = require('express');
const request = require('supertest');

const mockAuth = jest.fn((req, _res, next) => next());
const mockGeneralLimiter = jest.fn((req, _res, next) => next());
const mockWeatherLimiter = jest.fn((req, _res, next) => next());
const mockPoolQuery = jest.fn();

const mockClimateOracleNetwork = {
  initialize: jest.fn().mockResolvedValue(undefined),
  getValidatorById: jest.fn(),
  getValidatorReputation: jest.fn(),
  getValidatorDataPoints: jest.fn(),
  getValidatorVerifiedPredictions: jest.fn(),
  getValidatorHistoryLength: jest.fn(),
  getValidatorSpecialties: jest.fn(),
  getValidators: jest.fn(),
  submitData: jest.fn(),
  cancelRequest: jest.fn(),
};

jest.mock('../middleware/authMiddleware', () => ({
  requireAuth: (req, res, next) => mockAuth(req, res, next),
}));

jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: (req, res, next) => mockGeneralLimiter(req, res, next),
  weatherLimiter: (req, res, next) => mockWeatherLimiter(req, res, next),
}));

jest.mock('../db', () => ({
  pool: {
    query: (...args) => mockPoolQuery(...args),
  },
}));

jest.mock('../oracle/climate-oracle-network', () => ({
  ClimateOracleNetwork: jest.fn(() => mockClimateOracleNetwork),
}));

jest.mock('../utils/logger', () => ({
  blockchainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const oracleDetailRoutes = require('../routes/oracle-detail-routes');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { id: 'test-user' };
    next();
  });
  app.use('/api/oracle', oracleDetailRoutes);
  return app;
}

jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(async () => ({ ok: true, status: 202, payload: {} })),
  extractCore4Data: (payload) => payload,
  forwardCore4Headers: jest.fn(() => ({})),
}));
jest.mock('hash-wasm', () => ({ blake3: jest.fn(async () => 'a'.repeat(64)) }));
const { fetchCore4Json: mockCore4Fetch } = require('../../shared/core4-route-client.js');

describe('backend#1315 retired duplicate submit route at the legacy mount', () => {
  it.each(['mob-hidden', 'WX-fixed'])('returns 404 for %s with no submission I/O', async (stationId) => {
    jest.clearAllMocks();
    const res = await request(buildApp()).post('/api/oracle/submit-data').send({
      dataType: 'temperature', location: { stationId }, value: 20,
      timestamp: '2026-09-29T00:00:00Z',
    });
    expect(res.status).toBe(404);
    expect(mockCore4Fetch).not.toHaveBeenCalled();
    expect(mockClimateOracleNetwork.submitData).not.toHaveBeenCalled();
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });
});

describe('oracle-detail routes empty DB behavior', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockResolvedValue({ rows: [] });
    mockClimateOracleNetwork.initialize.mockResolvedValue(undefined);
    app = buildApp();
  });

  it('returns an empty array for data-submissions when the DB has no rows', async () => {
    const res = await request(app).get('/api/oracle/data-submissions');

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockPoolQuery).toHaveBeenCalled();
    expect(mockClimateOracleNetwork.getValidators).not.toHaveBeenCalled();
  });

  it('returns an empty leaderboard when the DB has no rows', async () => {
    const res = await request(app).get('/api/oracle/leaderboard');

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      entries: [],
      total_oracles: 0,
      total: 0,
    });
    expect(res.body.entries).toEqual([]);
    expect(mockClimateOracleNetwork.getValidators).not.toHaveBeenCalled();
    expect(mockClimateOracleNetwork.getValidatorReputation).not.toHaveBeenCalled();
  });
});
