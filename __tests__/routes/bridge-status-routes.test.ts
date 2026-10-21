/**
 * Smoke tests for server/routes/bridge-status.js
 * Issue #358 — bridge-status routes (fee estimation, status, health) have zero tests
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const passthrough = (_req: any, _res: any, next: any) => next();

jest.mock('express', () => {
  function createRouter() {
    return {
      stack: [] as any[],
      use(...args: any[]) {
        const firstArg = args[0];
        if (typeof firstArg === 'function') this.stack.push({ handle: firstArg });
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
    };
  }
  const express: any = () => ({});
  express.Router = createRouter;
  express.json = () => passthrough;
  return express;
}, { virtual: true });

jest.mock('../../server/middleware/authMiddleware', () => ({ requireAuth: passthrough }));
jest.mock('../../server/utils/logger', () => ({
  crosschainLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../shared/utils/input-sanitizer', () => ({
  sanitizeObject: jest.fn((obj: any) => obj),
  detectXSS: jest.fn().mockReturnValue(false),
  validateNumericRange: jest.fn().mockImplementation((val: any, min: number, max: number) => {
    const n = Number(val);
    if (isNaN(n) || n < min || n > max) return null;
    return n;
  }),
  validateChainId: jest.fn().mockReturnValue(true),
}));
jest.mock('../../services/GasEstimationService', () => ({
  getGasEstimationService: jest.fn().mockReturnValue(null),
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
  router = require('../../server/routes/bridge-status');
});

describe('GET /status', () => {
  it('returns 200 with all bridge statuses', () => {
    const handler = getHandler(router, 'GET', '/status');
    const res = mockRes();
    handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.type).toBe('all_bridges');
    expect(Array.isArray(res.body.bridges)).toBe(true);
    expect(res.body.bridges.length).toBeGreaterThan(0);
    expect(res.body).toHaveProperty('timestamp');
  });

  it('includes standard bridge fields in each status entry', () => {
    const handler = getHandler(router, 'GET', '/status');
    const res = mockRes();
    handler(mockReq(), res);
    const bridge = res.body.bridges[0];
    expect(bridge).toHaveProperty('id');
    expect(bridge).toHaveProperty('status');
    expect(bridge).toHaveProperty('uptime');
  });
});

describe('GET /status/:bridgeId', () => {
  it('returns 200 with status for a known bridge', () => {
    const handler = getHandler(router, 'GET', '/status/:bridgeId');
    const res = mockRes();
    handler(mockReq({ bridgeId: 'axelar' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.bridgeId).toBe('axelar');
    expect(res.body.type).toBe('bridge_status');
  });

  it('returns 404 for an unknown bridgeId', () => {
    const handler = getHandler(router, 'GET', '/status/:bridgeId');
    const res = mockRes();
    handler(mockReq({ bridgeId: 'nonexistent-bridge-xyz' }), res);
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });
});

describe('POST /fee-estimate', () => {
  it('returns 400 when bridgeId is missing', async () => {
    const handler = getHandler(router, 'POST', '/fee-estimate');
    const res = mockRes();
    await handler(mockReq({}, { amount: 1, sourceChain: 'ethereum', destChain: 'polygon' }), res);
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/missing required parameters/i);
  });

  it('returns 400 when amount is missing', async () => {
    const handler = getHandler(router, 'POST', '/fee-estimate');
    const res = mockRes();
    await handler(mockReq({}, { bridgeId: 'axelar', sourceChain: 'ethereum', destChain: 'polygon' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when bridgeId is not in valid list', async () => {
    const handler = getHandler(router, 'POST', '/fee-estimate');
    const res = mockRes();
    await handler(
      mockReq({}, { bridgeId: 'unknown-bridge', amount: 10, sourceChain: 'ethereum', destChain: 'polygon' }),
      res
    );
    expect(res.statusCode).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('returns 400 when amount is zero or negative', async () => {
    const handler = getHandler(router, 'POST', '/fee-estimate');
    const res = mockRes();
    await handler(
      mockReq({}, { bridgeId: 'axelar', amount: 0, sourceChain: 'ethereum', destChain: 'polygon' }),
      res
    );
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 fee estimate for valid request (no gas service, uses fallback)', async () => {
    const handler = getHandler(router, 'POST', '/fee-estimate');
    const res = mockRes();
    await handler(
      mockReq({}, { bridgeId: 'axelar', amount: 100, sourceChain: 'ethereum', destChain: 'polygon' }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('bridgeId', 'axelar');
    expect(res.body).toHaveProperty('totalFee');
  });
});

describe('GET /health', () => {
  it('returns 200 with health status', () => {
    const handler = getHandler(router, 'GET', '/health');
    const res = mockRes();
    handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('healthyBridges');
    expect(res.body).toHaveProperty('timestamp');
  });
});
