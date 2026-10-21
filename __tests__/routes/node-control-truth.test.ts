import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const passthrough = (_req: any, _res: any, next: any) => next();

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
      post(path: string, ...handlers: any[]) {
        this.stack.push({
          route: {
            path,
            methods: { post: true },
            stack: handlers.map((handle) => ({ handle })),
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

jest.mock('../../server/middleware/rpcAuthMiddleware', () => ({
  verifyNodeControlAuth: passthrough,
  nodeControlRateLimiter: passthrough,
}));
jest.mock('../../server/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));
jest.mock('../../config', () => ({ network: 'test', websocket: { enabled: false } }));

function getHandler(router: any, method: string, path: string): (...args: any[]) => any {
  const layer = router.stack.find(
    (candidate: any) =>
      candidate.route?.path === path &&
      candidate.route.methods[method.toLowerCase()],
  );
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function mockRes(): any {
  const res: any = { statusCode: 200, body: null };
  res.status = (code: number) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body: unknown) => {
    res.body = body;
    return res;
  };
  return res;
}

describe('node-control truth boundary', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('creates no timer and has an empty process log buffer at import', async () => {
    const router = require('../../server/routes/node-control-routes');
    expect(jest.getTimerCount()).toBe(0);

    const res = mockRes();
    await getHandler(router, 'GET', '/logs')({ query: {} }, res);

    expect(res.body.data).toEqual({
      logs: [],
      total: 0,
      filtered: 0,
      source: 'process-buffer',
    });
  });

  it('returns 501 instead of claiming a service restart', async () => {
    const router = require('../../server/routes/node-control-routes');
    const res = mockRes();

    await getHandler(router, 'POST', '/restart/:service')(
      { params: { service: 'api' }, ip: '127.0.0.1' },
      res,
    );

    expect(res.statusCode).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      unavailable: true,
      error: { capability: 'node-control.restart' },
    });
  });

  it('returns 501 instead of claiming a cache clear', async () => {
    const router = require('../../server/routes/node-control-routes');
    const res = mockRes();

    await getHandler(router, 'POST', '/clear-cache')(
      { body: { cacheType: 'all' }, ip: '127.0.0.1' },
      res,
    );

    expect(res.statusCode).toBe(501);
    expect(res.body).toMatchObject({
      success: false,
      unavailable: true,
      error: { capability: 'node-control.clear-cache' },
    });
  });

  it('exports pushLog for genuine process callers', async () => {
    const router = require('../../server/routes/node-control-routes');
    router.pushLog('warn', 'real process warning', 'test-process');
    const res = mockRes();

    await getHandler(router, 'GET', '/logs')({ query: {} }, res);

    expect(res.body.data.logs).toHaveLength(1);
    expect(res.body.data.logs[0]).toMatchObject({
      level: 'warn',
      message: 'real process warning',
      source: 'test-process',
    });
  });
});
