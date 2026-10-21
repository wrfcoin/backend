import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const passthrough = (_req: any, _res: any, next: any) => next();
const initialize = jest.fn().mockResolvedValue(undefined);
const createRequest = jest.fn().mockResolvedValue('simulated-request-id');
const ClimateOracleNetwork = jest.fn().mockImplementation(() => ({
  initialize,
  createRequest,
}));

jest.mock('express', () => {
  function createRouter() {
    return {
      stack: [] as any[],
      use(...handlers: any[]) {
        handlers.forEach(handler => this.stack.push({ handle: handler }));
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
      put(path: string, ...handlers: any[]) {
        this.stack.push({
          route: {
            path,
            methods: { put: true },
            stack: handlers.map(handle => ({ handle })),
          },
        });
        return this;
      },
    };
  }
  const express: any = () => ({});
  express.Router = createRouter;
  return express;
}, { virtual: true });

jest.mock('../../server/middleware/authMiddleware', () => ({ requireAuth: passthrough }));
jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: passthrough,
  transferLimiter: passthrough,
}));
jest.mock('../../server/db', () => ({ db: {} }));
jest.mock('../../shared/oracle-schema', () => ({
  oracleRequests: {},
  oracleResponses: {},
  crossChainBridges: {},
  validatorOracleParticipation: {},
  bridgeTransactions: {},
}));
jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
  count: jest.fn(),
}));
jest.mock('../../server/oracle/climate-oracle-network', () => ({ ClimateOracleNetwork }));
jest.mock('../../server/utils/logger', () => ({
  blockchainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function mockRes(): any {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: any) => {
    res.body = body;
    return res;
  };
  return res;
}

function routeHandlers(router: any, method: string, path: string): Function[] {
  const layer = router.stack.find(
    (candidate: any) =>
      candidate.route &&
      candidate.route.path === path &&
      candidate.route.methods[method.toLowerCase()],
  );
  if (!layer) throw new Error(`route not found: ${method} ${path}`);
  return layer.route.stack.map((entry: any) => entry.handle);
}

async function executeRoute(
  router: any,
  method: string,
  path: string,
  req: any,
  res: any,
) {
  const handlers = routeHandlers(router, method, path);
  let index = 0;
  const next = async (): Promise<void> => {
    const handler = handlers[index++];
    if (handler) await handler(req, res, next);
  };
  await next();
}

describe('ClimateOracleNetwork release boundary', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    delete process.env.ORACLE_NETWORK_SIMULATION;
  });

  afterEach(() => {
    delete process.env.ORACLE_NETWORK_SIMULATION;
  });

  it.each([
    ['POST', '/requests', { body: { dataType: 'weather', parameters: { station: 'KDLH' } } }],
    ['POST', '/requests/:id/cancel', { body: {}, params: { id: 'request-1' } }],
    ['POST', '/bridges', { body: { name: 'fixture', provider: 'stub', targetChain: 'ethereum' } }],
    ['GET', '/metrics', { body: {} }],
    ['GET', '/status', { body: {} }],
    ['GET', '/validators', { body: {} }],
    ['GET', '/data-submissions', { body: {} }],
    ['POST', '/cross-chain/requests', { body: {} }],
    ['GET', '/cross-chain/bridge-status', { body: {} }],
    ['POST', '/cross-chain/test', { body: { target_chain: 'ethereum' } }],
    ['GET', '/cross-chain/networks', { body: {} }],
    ['GET', '/cross-chain/delegation-info', { body: {} }],
    ['GET', '/cross-chain/analytics', { body: {} }],
  ])('%s %s returns 501 by default without generated evidence', async (method, path, req) => {
    const router = require('../../server/routes/oracle-routes');
    const res = mockRes();

    await executeRoute(router, method, path, { params: {}, query: {}, ...req }, res);

    expect(res.statusCode).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      unavailable: true,
      error: {
        code: 'NOT_IMPLEMENTED',
        capability: 'climate-oracle-network',
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/"tx-[a-z0-9]+"/i);
    expect(ClimateOracleNetwork).not.toHaveBeenCalled();
  });

  it('labels every simulator response when the developer switch is enabled', async () => {
    process.env.ORACLE_NETWORK_SIMULATION = '1';
    const router = require('../../server/routes/oracle-routes');
    const res = mockRes();

    await executeRoute(
      router,
      'POST',
      '/requests',
      {
        params: {},
        query: {},
        body: { dataType: 'weather', parameters: { station: 'KDLH' } },
      },
      res,
    );

    expect(res.statusCode).toBe(201);
    expect(res.body).toMatchObject({
      success: true,
      simulated: true,
      data: { requestId: 'simulated-request-id' },
    });
    expect(ClimateOracleNetwork).toHaveBeenCalledTimes(1);
  });
});
