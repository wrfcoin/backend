/**
 * Smoke tests for server/routes/oracle-routes.js
 * Issue #357 — oracle-routes is data-integrity-critical with 18 endpoints and zero tests
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// This legacy suite exercises the simulator handlers themselves. Production
// defaults are covered independently by oracle-network-release-boundary.
process.env.ORACLE_NETWORK_SIMULATION = '1';

const passthrough = (_req: any, _res: any, next: any) => next();

// Drizzle chainable mock — awaitable at any point in the chain
function makeDrizzleChain(result: any = []) {
  const chain: any = {};
  // 'offset' is required by the #903 pagination work: the routes now build
  // .limit(n).offset(n) chains, and a mock missing offset makes every paginated
  // handler throw "chain.limit(...).offset is not a function" -> 500.
  ['select','update','insert','set','values','from','where','orderBy','innerJoin','returning','limit','offset'].forEach(m => {
    chain[m] = jest.fn().mockReturnThis();
  });
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const mockDb = {
  select: jest.fn(),
  insert: jest.fn(),
  update: jest.fn(),
};

const mockOracleNetwork = {
  initialize: jest.fn().mockResolvedValue(undefined),
  createRequest: jest.fn(),
  cancelRequest: jest.fn(),
  getMetrics: jest.fn(),
  getStatus: jest.fn(),
  getValidators: jest.fn(),
  getRecentDataSubmissions: jest.fn(),
};

jest.mock('express', () => {
  function createRouter() {
    return {
      stack: [] as any[],
      use(...handlers: any[]) {
        handlers.forEach((h: any) => { if (typeof h === 'function') this.stack.push({ handle: h }); });
        return this;
      },
      get(path: string, ...handlers: any[]) {
        this.stack.push({ route: { path, methods: { get: true }, stack: handlers.map((h: any) => ({ handle: h })) } });
        return this;
      },
      post(path: string, ...handlers: any[]) {
        this.stack.push({ route: { path, methods: { post: true }, stack: handlers.map((h: any) => ({ handle: h })) } });
        return this;
      },
      put(path: string, ...handlers: any[]) {
        this.stack.push({ route: { path, methods: { put: true }, stack: handlers.map((h: any) => ({ handle: h })) } });
        return this;
      },
    };
  }
  const express: any = () => ({});
  express.Router = createRouter;
  express.json = () => passthrough;
  return express;
}, { virtual: true });

jest.mock('../../server/middleware/authMiddleware', () => ({ requireAuth: passthrough }));
jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: passthrough,
  transferLimiter: passthrough,
}));
jest.mock('../../server/db', () => ({ db: mockDb }));
jest.mock('../../shared/oracle-schema', () => ({
  oracleRequests: { id: 'oracleRequests.id', status: 'oracleRequests.status', createdAt: 'oracleRequests.createdAt' },
  oracleResponses: { requestId: 'oracleResponses.requestId' },
  crossChainBridges: { id: 'crossChainBridges.id' },
  validatorOracleParticipation: { requestId: 'validatorOracleParticipation.requestId' },
  bridgeTransactions: { bridgeId: 'bridgeTransactions.bridgeId', timestamp: 'bridgeTransactions.timestamp', status: 'bridgeTransactions.status' },
}));
jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a: any, b: any) => ['eq', a, b]),
  desc: jest.fn((a: any) => ['desc', a]),
  // #903 pagination added `count()` to every list route. Without it here the
  // mocked module returns undefined and `count()` throws before the handler
  // reaches its query, surfacing as an opaque 500.
  count: jest.fn(() => ['count']),
}));
jest.mock('../../server/oracle/climate-oracle-network', () => ({
  ClimateOracleNetwork: jest.fn().mockImplementation(() => mockOracleNetwork),
}));
jest.mock('../../server/utils/logger', () => ({
  blockchainLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Only `createApiError` is stubbed. `parseListPagination` and
// `paginatedResponse` are the REAL implementations: they are the contract these
// routes now expose, so stubbing them would assert the mock rather than the
// envelope clients actually receive. A partial mock is also what broke this
// suite — the #903 routes call two helpers this factory never provided, so both
// were undefined and every list handler threw a 500 before touching the db.
jest.mock('../../server/utils/api-error', () => ({
  ...(jest.requireActual('../../server/utils/api-error') as object),
  createApiError: jest.fn((code: string, msg: string) => ({ code, message: msg })),
}));

function getHandler(router: any, method: string, path: string): (...args: any[]) => any {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === path && layer.route.methods[method.toLowerCase()]) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`No handler found for ${method} ${path}`);
}

function mockReq(params: any = {}, body: any = {}, query: any = {}): any {
  return { params, body, query };
}
function mockRes(): any {
  const res: any = { statusCode: 200, body: null };
  res.status = (c: number) => { res.statusCode = c; return res; };
  res.json = (d: any) => { res.body = d; return res; };
  return res;
}

let router: any;

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.select.mockReturnValue(makeDrizzleChain([]));
  mockDb.insert.mockReturnValue(makeDrizzleChain([{ id: 'new-1' }]));
  mockDb.update.mockReturnValue(makeDrizzleChain([{ id: 'up-1' }]));
  router = require('../../server/routes/oracle-routes');
});

describe('GET /requests', () => {
  // #909 moved list routes from a bare array to the paginated envelope
  // { success, data, pagination }. These assertions follow the envelope; a
  // consumer still reading res.body as an array is broken and should be
  // updated with it (see frontend OracleDashboard.jsx).
  it('returns 200 with an empty envelope page when no requests exist', async () => {
    const handler = getHandler(router, 'GET', '/requests');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(Array.isArray(res.body.data)).toBe(true);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination).toMatchObject({ total: 0, page: 1, limit: 50 });
  });

  it('returns 200 with request list inside the envelope', async () => {
    // The route builds the page query first and the count query second.
    mockDb.select
      .mockReturnValueOnce(makeDrizzleChain([{ id: 'r1', status: 'PENDING' }]))
      .mockReturnValueOnce(makeDrizzleChain([{ total: 1 }]));
    const handler = getHandler(router, 'GET', '/requests');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].id).toBe('r1');
    expect(res.body.pagination.total).toBe(1);
  });

  it('honours limit/offset and reports the derived page', async () => {
    mockDb.select
      .mockReturnValueOnce(makeDrizzleChain([{ id: 'r9' }]))
      .mockReturnValueOnce(makeDrizzleChain([{ total: 25 }]));
    const handler = getHandler(router, 'GET', '/requests');
    const res = mockRes();
    await handler(mockReq({}, {}, { limit: '10', offset: '10' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.pagination).toMatchObject({
      total: 25,
      page: 2,
      limit: 10,
      totalPages: 3,
      hasNext: true,
      hasPrev: true,
    });
  });

  it('does not 500 when the count query returns no row', async () => {
    // Guards the #903 regression: `Number(countRow.total)` on an empty count
    // result threw a TypeError that surfaced as an opaque 500.
    mockDb.select
      .mockReturnValueOnce(makeDrizzleChain([{ id: 'r1' }]))
      .mockReturnValueOnce(makeDrizzleChain([])); // count query yields nothing
    const handler = getHandler(router, 'GET', '/requests');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.pagination.total).toBe(0);
  });

  it('passes status query parameter to db filter', async () => {
    const handler = getHandler(router, 'GET', '/requests');
    const res = mockRes();
    await handler(mockReq({}, {}, { status: 'PENDING' }), res);
    // The db.select().from().where().orderBy() chain was called
    expect(mockDb.select).toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
  });
});

describe('GET /requests/:id', () => {
  it('returns 404 when request is not found', async () => {
    mockDb.select.mockReturnValueOnce(makeDrizzleChain([])); // empty → not found
    const handler = getHandler(router, 'GET', '/requests/:id');
    const res = mockRes();
    await handler(mockReq({ id: 'non-existent' }), res);
    expect(res.statusCode).toBe(404);
  });

  it('returns 200 with request data when found', async () => {
    mockDb.select.mockReturnValueOnce(makeDrizzleChain([{ id: 'r1', dataType: 'weather', status: 'PENDING' }]));
    const handler = getHandler(router, 'GET', '/requests/:id');
    const res = mockRes();
    await handler(mockReq({ id: 'r1' }), res);
    expect(res.statusCode).toBe(200);
    // #909: single-resource routes now wrap in { success, data }.
    expect(res.body.success).toBe(true);
    expect(res.body.data.id).toBe('r1');
  });
});

describe('POST /requests', () => {
  it('returns 400 when dataType and parameters are missing', async () => {
    const handler = getHandler(router, 'POST', '/requests');
    const res = mockRes();
    await handler(mockReq({}, {}), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 when only dataType is provided', async () => {
    const handler = getHandler(router, 'POST', '/requests');
    const res = mockRes();
    await handler(mockReq({}, { dataType: 'weather' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 201 on successful request creation', async () => {
    mockOracleNetwork.createRequest.mockResolvedValueOnce('req-42');
    const handler = getHandler(router, 'POST', '/requests');
    const res = mockRes();
    await handler(mockReq({}, { dataType: 'weather', parameters: { lat: 40.7, lng: -74 } }), res);
    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.requestId).toBe('req-42');
    expect(res.body.data.status).toBe('PENDING');
  });
});

describe('GET /metrics', () => {
  it('returns 200 with metrics from oracle network', async () => {
    mockOracleNetwork.getMetrics.mockResolvedValueOnce({ totalRequests: 100, avgResponseTime: 1.5 });
    const handler = getHandler(router, 'GET', '/metrics');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.totalRequests).toBe(100);
  });
});

describe('GET /status', () => {
  it('returns 200 with network status', async () => {
    mockOracleNetwork.getStatus.mockResolvedValueOnce({ healthy: true, validatorCount: 5 });
    const handler = getHandler(router, 'GET', '/status');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.healthy).toBe(true);
  });
});

describe('GET /validators', () => {
  it('returns 200 with validators list', async () => {
    mockOracleNetwork.getValidators.mockResolvedValueOnce([
      { id: 'v1', status: 'ACTIVE' },
      { id: 'v2', status: 'ACTIVE' },
    ]);
    const handler = getHandler(router, 'GET', '/validators');
    const res = mockRes();
    await handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.data.validators).toHaveLength(2);
    expect(res.body.data.activeCount).toBe(2);
  });
});
