const mockSelect = jest.fn();
const mockInitialize = jest.fn(() => Promise.resolve());
const mockAuth = jest.fn((_req, _res, next) => next());
const mockLimiter = jest.fn((_req, _res, next) => next());
const mockWarn = jest.fn();
const mockError = jest.fn();

jest.mock('express', () => {
  const createRouter = () => ({
    stack: [] as any[],
    use() {
      return this;
    },
    get(path: string, handler: any) {
      this.stack.push({
        route: {
          path,
          methods: { get: true },
          stack: [{ handle: handler }],
        },
      });
      return this;
    },
    post(path: string, handler: any) {
      this.stack.push({
        route: {
          path,
          methods: { post: true },
          stack: [{ handle: handler }],
        },
      });
      return this;
    },
  });

  const express = () => createRouter();
  (express as any).Router = () => createRouter();
  return express;
}, { virtual: true });

jest.mock('drizzle-orm', () => ({
  eq: jest.fn(),
}), { virtual: true });

jest.mock('../../server/db', () => ({
  db: {
    select: mockSelect,
  },
}));

jest.mock('../../server/middleware/auth', () => ({
  authenticateJWT: mockAuth,
}));

jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: mockLimiter,
  transferLimiter: mockLimiter,
}));

jest.mock('../../server/layer-zero/bridge', () => ({
  initialize: mockInitialize,
  getAdapterInfo: jest.fn(),
  estimateGas: jest.fn(),
  sendMessage: jest.fn(),
  transferTokens: jest.fn(),
}));

jest.mock('../../utils/logger', () => () => ({
  warn: mockWarn,
  error: mockError,
}));

jest.mock('../../shared/layer-zero-schema', () => ({
  layerZeroChains: { chainId: 'chainId' },
  layerZeroMessages: { messageId: 'messageId' },
  layerZeroTokenTransfers: { transferId: 'transferId' },
}));

const layerZeroRoutesModule = require('../../server/routes/layer-zero-routes.js');
const layerZeroRoutes = layerZeroRoutesModule.default || layerZeroRoutesModule;

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

function createMockBuilder({
  selectRows = [],
  whereRows = [],
  offsetRows = [],
}: {
  selectRows?: any[];
  whereRows?: any[];
  offsetRows?: any[];
} = {}) {
  const builder: any = {};
  builder.then = jest.fn((resolve: (value: any[]) => void) => resolve(selectRows));
  builder.where = jest.fn().mockResolvedValue(whereRows);
  builder.limit = jest.fn(() => builder);
  builder.offset = jest.fn().mockResolvedValue(offsetRows);
  return builder;
}

function createMockRes() {
  const res: any = {
    statusCode: 200,
    body: null,
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    json: jest.fn((payload: any) => {
      res.body = payload;
      return res;
    }),
  };

  return res;
}

describe('layer-zero-routes double-response guard (#404)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelect.mockReset();
  });

  it.each([
    {
      method: 'GET',
      path: '/chains',
      selectRows: [{ id: 1, name: 'DB Ethereum' }],
      expectedBody: { success: true, chains: [{ id: 1, name: 'DB Ethereum' }] },
    },
    {
      method: 'GET',
      path: '/chains/:chainId',
      whereRows: [{ id: 1, name: 'DB Ethereum' }],
      expectedBody: {
        success: true,
        chain: { id: 1, name: 'DB Ethereum' },
      },
    },
    {
      method: 'GET',
      path: '/messages/:messageId',
      whereRows: [{ messageId: 'msg-1', status: 'SENT' }],
      expectedBody: {
        success: true,
        message: { messageId: 'msg-1', status: 'SENT' },
      },
    },
    {
      method: 'GET',
      path: '/transfers/:transferId',
      whereRows: [{ transferId: 'tx-1', status: 'SENT' }],
      expectedBody: {
        success: true,
        transfer: { transferId: 'tx-1', status: 'SENT' },
      },
    },
  ])('returns once for $path when DB has a record', async ({
    method,
    path,
    selectRows = [],
    whereRows = [],
    expectedBody,
  }) => {
    const selectResult = createMockBuilder({ selectRows, whereRows });

    mockSelect.mockReturnValue({
      from: jest.fn(() => selectResult),
    });

    const handler = getHandler(layerZeroRoutes, method, path);
    const res = createMockRes();

    await handler(
      {
        params:
          path === '/chains/:chainId'
            ? { chainId: '1' }
            : path === '/messages/:messageId'
              ? { messageId: 'msg-1' }
              : path === '/transfers/:transferId'
                ? { transferId: 'tx-1' }
                : {},
        query: {},
        body: {},
      },
      res
    );

    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual(expectedBody);
  });
});

describe('layer-zero-routes pagination guard (#442)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelect.mockReset();
  });

  it.each([
    {
      path: '/messages',
      query: { limit: '9999999', offset: '7' },
      limit: 100,
      offset: 7,
      selectRows: [{ messageId: 'msg-1', status: 'SENT' }],
      expectedBody: {
        success: true,
        messages: [{ messageId: 'msg-1', status: 'SENT' }],
      },
    },
    {
      path: '/transfers',
      query: { limit: '-1', offset: '-4' },
      limit: 10,
      offset: 0,
      selectRows: [{ transferId: 'tx-1', status: 'SENT' }],
      expectedBody: {
        success: true,
        transfers: [{ transferId: 'tx-1', status: 'SENT' }],
      },
    },
  ])('caps and normalizes pagination for $path', async ({
    path,
    query,
    limit,
    offset,
    selectRows,
    expectedBody,
  }) => {
    const selectResult = createMockBuilder({
      offsetRows: selectRows,
    });

    mockSelect.mockReturnValue({
      from: jest.fn(() => selectResult),
    });

    const handler = getHandler(layerZeroRoutes, 'GET', path);
    const res = createMockRes();

    await handler(
      {
        params: {},
        query,
        body: {},
      },
      res
    );

    expect(selectResult.limit).toHaveBeenCalledWith(limit);
    expect(selectResult.offset).toHaveBeenCalledWith(offset);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledTimes(1);
    expect(res.body).toEqual(expectedBody);
  });
});
