import { describe, expect, it, jest } from '@jest/globals';

const passthrough = (_req: any, _res: any, next: any) => next();

jest.mock('../../server/middleware/authMiddleware', () => ({
  requireAuth: passthrough,
}));

jest.mock('../../server/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('../../shared/core4-route-client.js', () => ({
  sendCore4Unavailable: (res: any, error: any, message = 'Blockchain node unavailable') =>
    res.status(503).json({
      success: false,
      error: {
        code: 'CORE4_UNAVAILABLE',
        message,
        details: error instanceof Error ? error.message : String(error ?? 'Unknown error'),
      },
      timestamp: new Date().toISOString(),
    }),
  sendCore4Error: (res: any, response: any, fallbackMessage: string) =>
    res.status(response?.status || 502).json({
      success: false,
      error: {
        code: 'CORE4_ERROR',
        message: response?.payload?.error?.message ?? fallbackMessage,
        details: response?.payload ?? null,
      },
      timestamp: new Date().toISOString(),
    }),
  sendNotImplemented: (
    res: any,
    message: string,
    details = 'This backend route has no matching core4 API yet.'
  ) =>
    res.status(501).json({
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message,
        details,
      },
      timestamp: new Date().toISOString(),
    }),
}));

const computeRoutes = require('../../server/routes/compute-routes');

function mockReq(params: Record<string, string> = {}, body: any = {}, query: any = {}): any {
  return {
    params,
    body,
    query,
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

describe('compute-routes', () => {
  it('returns 501 for task submission with no launch API equivalent', async () => {
    const res = mockRes();
    const handler = getHandler(computeRoutes, 'POST', '/tasks');

    await handler(
      mockReq(
        {},
        {
          taskType: 'machine-learning',
          priority: 'high',
          resourceRequirements: {
            cpu: 4,
          },
        }
      ),
      res
    );

    expect(res.statusCode).toBe(501);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('returns 501 for compute task status lookups with no launch API equivalent', async () => {
    const res = mockRes();
    const handler = getHandler(computeRoutes, 'GET', '/tasks/:taskId/status');

    await handler(mockReq({ taskId: 'task-1' }), res);

    expect(res.statusCode).toBe(501);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  });
});
