import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const passthrough = (_req: any, _res: any, next: any) => next();

const mockPoolQuery = jest.fn();
const mockGetValidators = jest.fn();
const mockGetValidatorReputation = jest.fn();
const mockSubmitData = jest.fn();

jest.mock(
  'express',
  () => {
    function createRouter() {
      return {
        stack: [] as any[],
        use(...handlers: any[]) {
          this.stack.push(...handlers.map(handle => ({ handle })));
          return this;
        },
        get(path: string, ...handlers: any[]) {
          this.stack.push({
            route: {
              path,
              methods: { get: true },
              stack: handlers.map(handle => ({ handle })),
            },
          });
          return this;
        },
        post(path: string, ...handlers: any[]) {
          this.stack.push({
            route: {
              path,
              methods: { post: true },
              stack: handlers.map(handle => ({ handle })),
            },
          });
          return this;
        },
      };
    }

    const express = () => ({});
    (express as any).Router = createRouter;
    (express as any).json = () => passthrough;
    return express;
  },
  { virtual: true },
);

jest.mock('../../server/middleware/authMiddleware', () => ({
  requireAuth: passthrough,
}));

jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: passthrough,
  weatherLimiter: passthrough,
}));

jest.mock('../../server/db', () => ({
  pool: {
    query: mockPoolQuery,
  },
}));

jest.mock('../../server/utils/logger', () => ({
  blockchainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../server/oracle/climate-oracle-network', () => ({
  ClimateOracleNetwork: jest.fn().mockImplementation(() => ({
    initialize: jest.fn().mockResolvedValue(true),
    getValidators: mockGetValidators,
    getValidatorReputation: mockGetValidatorReputation,
    getValidatorById: jest.fn(),
    getValidatorDataPoints: jest.fn(),
    getValidatorVerifiedPredictions: jest.fn(),
    getValidatorHistoryLength: jest.fn(),
    getValidatorSpecialties: jest.fn(),
    submitData: mockSubmitData,
  })),
}));

const oracleDetailRoutes = require('../../server/routes/oracle-detail-routes');

function mockReq(
  params: Record<string, string> = {},
  body: any = {},
  query: any = {},
  headers: Record<string, string> = {}
): any {
  return {
    params,
    body,
    query,
    headers,
    method: 'GET',
    url: '/',
  };
}

function mockRes(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: any) {
      res.body = data;
      return res;
    },
  };
  return res;
}

function getHandler(router: any, method: string, pathSuffix: string): Function {
  for (const layer of router.stack) {
    if (
      layer.route &&
      layer.route.path === pathSuffix &&
      layer.route.methods[method.toLowerCase()]
    ) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${pathSuffix}`);
}

describe('oracle-detail-routes data-submissions (#426)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockReset();
    mockGetValidators.mockReset();
    mockGetValidatorReputation.mockReset();
    mockSubmitData.mockReset();
  });

  it('returns an honest empty submissions array when weather_submissions has no rows', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });

    const res = mockRes();
    const handler = getHandler(oracleDetailRoutes, 'GET', '/data-submissions');

    await handler(mockReq({}, {}, {}), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('returns mapped real submissions as a bare array when weather_submissions has rows', async () => {
    mockPoolQuery.mockResolvedValueOnce({
      rows: [
        {
          id: 42,
          station_id: 'station-abc',
          temperature: 24.2,
          pressure: null,
          humidity: 62,
          quality_score: 91,
          reward_amount: '1.50',
          source: 'station',
          submitted_at: '2026-04-01T10:00:00.000Z',
        },
      ],
    });

    const res = mockRes();
    const handler = getHandler(oracleDetailRoutes, 'GET', '/data-submissions');

    await handler(mockReq({}, {}, {}), res);

    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toEqual([
      expect.objectContaining({
        id: 'sub-42',
        type: 'temperature',
        location: 'station-abc',
        status: 'verified',
      }),
    ]);
  });

  it('returns an empty array when the DB query throws', async () => {
    mockPoolQuery.mockRejectedValueOnce(new Error('db unavailable'));

    const res = mockRes();
    const handler = getHandler(oracleDetailRoutes, 'GET', '/data-submissions');

    await handler(mockReq({}, {}, {}), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe('oracle-detail-routes retired duplicate submit-data (#1315)', () => {
  it('does not register a duplicate POST handler beside the guarded submit router', () => {
    expect(() => getHandler(oracleDetailRoutes, 'POST', '/submit-data'))
      .toThrow('No handler found for POST /submit-data');
  });
});

describe('oracle-detail-routes leaderboard fallback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPoolQuery.mockRejectedValue(new Error('db unavailable'));
    mockGetValidators.mockResolvedValue([
      { id: 2, name: 'Validator Two', reputation_score: 95 },
      { id: 1, name: 'Validator One', reputation_score: 75 },
    ]);
    mockGetValidatorReputation.mockImplementation(async (validatorId: number) => {
      if (validatorId === 1) {
        return { reputationScore: 0.61 };
      }
      if (validatorId === 2) {
        return { reputationScore: 0.93 };
      }
      return null;
    });
  });

  it('normalizes fallback leaderboard entries from getValidatorReputation()', async () => {
    const res = mockRes();
    const handler = getHandler(oracleDetailRoutes, 'GET', '/leaderboard');

    await handler(mockReq({}, {}, { limit: '5' }), res);

    expect(res.statusCode).toBe(200);
    expect(mockGetValidators).toHaveBeenCalledTimes(1);
    expect(mockGetValidatorReputation).toHaveBeenCalledWith(2);
    expect(mockGetValidatorReputation).toHaveBeenCalledWith(1);
    expect(res.body).toEqual({
      entries: [
        {
          oracle_id: 'Validator Two',
          reputation_score: 930000,
          reputation_pct: 93,
          tier: 'Gold',
        },
        {
          oracle_id: 'Validator One',
          reputation_score: 610000,
          reputation_pct: 61,
          tier: 'Bronze',
        },
      ],
      total_oracles: 2,
      total: 2,
    });
  });

  it('returns a clear empty-state message when no validators are registered', async () => {
    mockGetValidators.mockResolvedValue([]);

    const res = mockRes();
    const handler = getHandler(oracleDetailRoutes, 'GET', '/leaderboard');

    await handler(mockReq({}, {}, { limit: '5' }), res);

    expect(res.statusCode).toBe(200);
    expect(mockGetValidators).toHaveBeenCalledTimes(1);
    expect(mockGetValidatorReputation).not.toHaveBeenCalled();
    expect(res.body).toEqual({
      entries: [],
      total_oracles: 0,
      total: 0,
      message: 'No validators registered yet',
    });
  });
});
