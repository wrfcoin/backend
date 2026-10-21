import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const passthrough = (_req: any, _res: any, next: any) => next();
const mockOracleNetwork = {
  initialize: jest.fn().mockResolvedValue(undefined),
  rustOracleBridge: null,
  getMetrics: jest.fn().mockResolvedValue({ validators: {} }),
};

jest.mock('express', () => {
  function createRouter() {
    return {
      stack: [] as any[],
      use: jest.fn(),
      get(path: string, ...handlers: any[]) {
        this.stack.push({
          route: {
            path,
            methods: { get: true },
            stack: handlers.map((handle) => ({ handle })),
          },
        });
        return this;
      },
      post: jest.fn().mockReturnThis(),
      put: jest.fn().mockReturnThis(),
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
jest.mock('drizzle-orm', () => ({ eq: jest.fn(), count: jest.fn() }));
jest.mock('../../server/oracle/climate-oracle-network', () => ({
  ClimateOracleNetwork: jest.fn().mockImplementation(() => mockOracleNetwork),
}));
jest.mock('../../server/utils/logger', () => ({
  blockchainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function analyticsHandler(router: any): (...args: any[]) => Promise<void> {
  const layer = router.stack.find(
    (candidate: any) =>
      candidate.route?.path === '/cross-chain/analytics' &&
      candidate.route.methods.get,
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function assertNoFabricatedAnalytics(source: string): void {
  const start = source.indexOf('router.get(\'/cross-chain/analytics\'');
  const end = source.indexOf('router.post(\'/cross-chain/test\'', start);
  const handler = source.slice(start, end);

  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  expect(handler).not.toMatch(/95\.8|99\.8|87\.3|requests:\s*142/);
  expect(handler).not.toMatch(/Mock value|Mock calculation/);
  expect(handler).not.toMatch(/\?\?\s*0/);
}

describe('oracle cross-chain analytics truth boundary', () => {
  beforeEach(() => {
    process.env.ORACLE_NETWORK_SIMULATION = '1';
    jest.clearAllMocks();
    mockOracleNetwork.getMetrics.mockResolvedValue({ validators: {} });
  });

  afterAll(() => {
    delete process.env.ORACLE_NETWORK_SIMULATION;
  });

  it('returns nulls and names unavailable fields without metric sources', async () => {
    const router = require('../../server/routes/oracle-routes');
    const res: any = {
      statusCode: 200,
      body: null,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: unknown) {
        this.body = body;
        return this;
      },
    };

    await analyticsHandler(router)({ query: {} }, res);

    expect(res.statusCode).toBe(200);
    expect(res.body.time_range).toBeNull();
    expect(res.body.requested_time_range).toBe('24h');
    expect(res.body.bridge_performance).toBeNull();
    expect(res.body.validator_performance).toBeNull();
    expect(res.body.unavailable).toEqual(expect.arrayContaining([
      'time_range',
      'throughput_per_hour',
      'bridge_performance',
      'validator_performance',
      'success_rate',
      'error_rate',
      'consensus_analytics',
      'performance_distribution',
      'bridge_utilization',
      'computation_type_distribution',
      'liquid_democracy_impact',
    ]));
  });

  it('contains none of the fabricated analytics literals', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'server/routes/oracle-routes.js'),
      'utf8',
    );

    assertNoFabricatedAnalytics(source);
  });

  it('rejects restoration of a fabricated success rate', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'server/routes/oracle-routes.js'),
      'utf8',
    );

    const mutated = source.replace(
      'const unavailable = [',
      'const fabricated = { success_rate: 95.8 };\n    const unavailable = [',
    );

    expect(() => assertNoFabricatedAnalytics(mutated)).toThrow();
  });
});
