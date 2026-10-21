import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../server/utils/logger', () => ({
  logger: mockLogger,
  securityLogger: mockLogger,
}));

jest.mock('../../utils/logger', () => ({
  logger: mockLogger,
}));

const passthrough = (_req: any, _res: any, next: any) => next();

jest.mock('../../server/middleware/authMiddleware', () => ({
  requireAuth: passthrough,
  requireAdmin: [passthrough],
}));

jest.mock('../../middleware/rateLimiting', () => ({
  generalLimiter: passthrough,
  transferLimiter: passthrough,
}));

const mockFetchCore4Json = jest.fn();
const mockExtractCore4Data = jest.fn((payload: any) => payload);
const mockForwardCore4Headers = jest.fn(() => ({}));

jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: mockFetchCore4Json,
  extractCore4Data: mockExtractCore4Data,
  forwardCore4Headers: mockForwardCore4Headers,
  sendCore4Unavailable: (
    res: any,
    error: any,
    message = 'Blockchain node unavailable',
  ) =>
    res.status(503).json({
      success: false,
      error: {
        code: 'CORE4_UNAVAILABLE',
        message,
        details:
          error instanceof Error
            ? error.message
            : String(error ?? 'Unknown error'),
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
    details = 'This backend route has no matching core4 API yet.',
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

const nftRoutes = require('../../server/routes/nft-routes');

function mockReq(
  params: Record<string, string> = {},
  body: any = {},
  query: any = {},
  headers: Record<string, string> = {},
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
    send(data: any) {
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

const ORIGINAL_READER_TOKEN = process.env.WRFCOIN_READER_TOKEN;
const configKeys = ['WRFCOIN_OPERATOR_TOKEN', 'WRFCOIN_ADMIN_NFT_MINT_CONFIG', 'WRFCOIN_ADMIN_NFT_TRANSFER_CONFIG'];
const savedConfig = Object.fromEntries(configKeys.map(key => [key, process.env[key]]));
afterAll(() => {
  for (const [key, value] of Object.entries(savedConfig)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  if (ORIGINAL_READER_TOKEN === undefined) delete process.env.WRFCOIN_READER_TOKEN;
  else process.env.WRFCOIN_READER_TOKEN = ORIGINAL_READER_TOKEN;
});

describe('nft-routes', () => {
  beforeEach(() => {
    process.env.WRFCOIN_READER_TOKEN = 'test-only-reader-read-policy-unit';
    process.env.WRFCOIN_OPERATOR_TOKEN = 'test-only-nft-operator';
    process.env.WRFCOIN_ADMIN_NFT_MINT_CONFIG = JSON.stringify({ id: 'nft-999', owner: `0x${'a'.repeat(40)}`, metadata: { tier: 'gold' } });
    process.env.WRFCOIN_ADMIN_NFT_TRANSFER_CONFIG = JSON.stringify({ id: 'nft-123', to: `0x${'b'.repeat(40)}` });
    jest.clearAllMocks();

    mockForwardCore4Headers.mockReturnValue({});
    mockExtractCore4Data.mockImplementation((payload: any) => payload);
    mockFetchCore4Json.mockImplementation(
      async (path: string, options: any = {}) => {
        if (path === '/nft/list') {
          return {
            ok: true,
            status: 200,
            payload: {
              items: [{ id: 'nft-1', title: 'Storm Badge' }],
              total: 5,
              limit: options.query.limit,
              offset: options.query.offset,
            },
          };
        }

        if (path === '/nft/nft-123') {
          return {
            ok: true,
            status: 200,
            payload: {
              id: 'nft-123',
              title: 'Storm Badge',
              owner: 'wrf-owner',
            },
          };
        }

        if (path === '/nft/mint') {
          return {
            ok: true,
            status: 201,
            payload: {
              success: true,
              nft: {
                id: 'nft-999',
                name: options.body?.name,
                creator: options.body?.creator,
              },
            },
          };
        }

        if (path === '/nft/nft-123/transfer') {
          return {
            ok: true,
            status: 200,
            payload: {
              success: true,
              transfer: {
                nftId: 'nft-123',
                to: options.body?.to,
              },
            },
          };
        }

        throw new Error(`Unexpected core4 path: ${path}`);
      },
    );
  });

  it('lists NFTs through the launch API list endpoint', async () => {
    const res = mockRes();
    const handler = getHandler(nftRoutes, 'GET', '/');

    await handler(mockReq({}, {}, { limit: '2', offset: '2' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.pagination.total).toBe(5);
    expect(res.body.pagination.hasPrev).toBe(true);
    expect(res.body.pagination.hasNext).toBe(true);
    expect(mockFetchCore4Json).toHaveBeenCalledWith(
      '/nft/list',
      expect.objectContaining({
        query: { offset: 2, limit: 2 },
      }),
    );
  });

  it.each([
    [{ limit: '2', offset: '0' }, 0, 2, ['nft-0', 'nft-1'], true, false],
    [{ limit: '2', offset: '2' }, 2, 2, ['nft-2', 'nft-3'], true, true],
    [{ limit: '2', offset: '4' }, 4, 2, ['nft-4'], false, true],
    [{ limit: '2', offset: '7' }, 7, 2, [], false, true],
    [{ limit: '2', page: '2' }, 2, 2, ['nft-2', 'nft-3'], true, true],
    [{ limit: '2', page: '1', offset: '2' }, 2, 2, ['nft-2', 'nft-3'], true, true],
    [{}, 0, 20, ['nft-0', 'nft-1', 'nft-2', 'nft-3', 'nft-4'], false, false],
  ])('uses the actual core4 list shape for query %j', async (query, offset, limit, ids, hasNext, hasPrev) => {
    const catalog = Array.from({ length: 5 }, (_, i) => ({ id: `nft-${i}` }));
    mockFetchCore4Json.mockImplementation(async (_path: string, options: any) => ({
      ok: true, status: 200, payload: {
        items: catalog.slice(options.query.offset, options.query.offset + options.query.limit),
        total: catalog.length, limit: options.query.limit, offset: options.query.offset,
      },
    }));
    const res = mockRes();
    await getHandler(nftRoutes, 'GET', '/')(mockReq({}, {}, query), res);
    expect(mockFetchCore4Json).toHaveBeenCalledWith('/nft/list', {
      headers: { authorization: 'Bearer test-only-reader-read-policy-unit' },
      query: { offset, limit },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body.data.map((item: any) => item.id)).toEqual(ids);
    expect(res.body.pagination).toEqual({ limit, offset, total: 5, hasNext, hasPrev });
  });

  it('keeps an empty catalog honest', async () => {
    mockFetchCore4Json.mockResolvedValue({ ok: true, status: 200,
      payload: { items: [], total: 0, limit: 20, offset: 0 } });
    const res = mockRes();
    await getHandler(nftRoutes, 'GET', '/')(mockReq(), res);
    expect(res.body).toEqual({ success: true, data: [], pagination: {
      limit: 20, offset: 0, total: 0, hasNext: false, hasPrev: false,
    } });
  });

  it.each([
    { nfts: [{ id: 'old-shape' }], total: 1, limit: 20, offset: 0 },
    { items: [], total: -1, limit: 20, offset: 0 },
    { items: [], total: 0, limit: 20, offset: -1 },
    { items: [], total: 0, limit: '20', offset: 0 },
  ])('refuses a malformed core4 list rather than inventing an empty result: %j', async payload => {
    mockFetchCore4Json.mockResolvedValue({ ok: true, status: 200, payload });
    const res = mockRes();
    await getHandler(nftRoutes, 'GET', '/')(mockReq(), res);
    expect(res.statusCode).toBe(502);
    expect(res.body.error.code).toBe('CORE4_INVALID_RESPONSE');
    expect(res.body).not.toHaveProperty('data');
  });

  it('fetches an NFT by id through the launch API', async () => {
    const res = mockRes();
    const handler = getHandler(nftRoutes, 'GET', '/:id');

    await handler(mockReq({ id: 'nft-123' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('nft-123');
    expect(res.body.title).toBe('Storm Badge');
    expect(mockFetchCore4Json).toHaveBeenCalledWith(
      '/nft/nft-123',
      expect.objectContaining({
        headers: { authorization: 'Bearer test-only-reader-read-policy-unit' },
      }),
    );
  });

  it('mints NFTs through the launch API mint endpoint', async () => {
    const res = mockRes();
    const handler = getHandler(nftRoutes, 'POST', '/');

    await handler(mockReq({}, {}), res);

    expect(res.statusCode).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.nft.id).toBe('nft-999');
    expect(mockFetchCore4Json).toHaveBeenCalledWith(
      '/nft/mint',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          id: 'nft-999', owner: `0x${'a'.repeat(40)}`, metadata: { tier: 'gold' },
        }),
      }),
    );
  });

  it('transfers NFTs through the launch API transfer endpoint', async () => {
    const res = mockRes();
    const handler = getHandler(nftRoutes, 'POST', '/:id/transfer');

    await handler(mockReq({ id: 'nft-123' }, {}), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.transfer.nftId).toBe('nft-123');
    expect(mockFetchCore4Json).toHaveBeenCalledWith(
      '/nft/nft-123/transfer',
      expect.objectContaining({
        method: 'POST',
        body: expect.objectContaining({
          to: `0x${'b'.repeat(40)}`,
        }),
      }),
    );
  });

  describe('POST /:id/execute', () => {
    it('fails closed with the standard unavailable envelope', async () => {
      const handler = getHandler(nftRoutes, 'POST', '/:id/execute');
      const res = mockRes();
      await handler(
        mockReq(
          { id: 'nft-weather-1' },
          {
            params: { dataset: 'gfs', threshold: 0.9 },
            inputData: 'sample-payload',
            computeType: 'forecast',
          },
        ),
        res,
      );

      expect(res.statusCode).toBe(501);
      expect(res.body).toMatchObject({
        success: false,
        unavailable: true,
        error: {
          code: 'NOT_IMPLEMENTED',
          capability: 'computational-nft.execute',
          see: 'wrfcoin/backend#1150',
        },
      });
      expect(res.body).not.toHaveProperty('data');
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/verify', () => {
    it('cannot turn request hashing into verification evidence', async () => {
      const handler = getHandler(nftRoutes, 'POST', '/:id/verify');
      const res = mockRes();
      await handler(
        mockReq(
          { id: 'nft-data-9' },
          {
            verificationParams: { provenance: 'testnet', checksum: 'abc123' },
          },
        ),
        res,
      );

      expect(res.statusCode).toBe(501);
      expect(res.body.error).toMatchObject({
        code: 'NOT_IMPLEMENTED',
        capability: 'computational-nft.verify',
      });
      expect(JSON.stringify(res.body)).not.toMatch(
        /verified|confidence|verifierAddress|verificationHash/,
      );
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });
  });

  describe('GET /:id/verify', () => {
    it('does not infer proof status without a canonical execution ledger', async () => {
      const handler = getHandler(nftRoutes, 'GET', '/:id/verify');
      const res = mockRes();
      await handler(mockReq({ id: 'nft-no-exec-1' }), res);

      expect(res.statusCode).toBe(501);
      expect(res.body.error).toMatchObject({
        code: 'NOT_IMPLEMENTED',
        capability: 'computational-nft.verification-status',
      });
      expect(res.body).not.toHaveProperty('verified');
      expect(res.body).not.toHaveProperty('proof');
      expect(mockFetchCore4Json).not.toHaveBeenCalled();
    });
  });
});
