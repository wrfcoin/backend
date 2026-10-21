import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFetchCore4Json = jest.fn();

const mockSharedCore4RouteClient = {
  extractCore4Data: (payload: any) => payload,
  fetchCore4Json: mockFetchCore4Json,
  forwardCore4Headers: (headers: Record<string, any> = {}) => ({
    ...(typeof headers.authorization === 'string' && headers.authorization
      ? { authorization: headers.authorization }
      : {}),
    ...(typeof headers['x-api-key'] === 'string' && headers['x-api-key']
      ? { 'x-api-key': headers['x-api-key'] }
      : {}),
  }),
  sendCore4Error: (res: any, response: any, fallbackMessage: string) =>
    res.status(response?.status || 502).json({
      success: false,
      error: {
        code: 'CORE4_ERROR',
        message: fallbackMessage,
      },
    }),
  sendCore4Unavailable: (res: any, _error: any, message: string) =>
    res.status(503).json({
      success: false,
      error: {
        code: 'CORE4_UNAVAILABLE',
        message,
        details: _error && _error instanceof Error ? _error.message : String(_error ?? ''),
      },
    }),
  sendNotImplemented: (res: any, message: string) =>
    res.status(501).json({
      success: false,
      error: {
        code: 'NOT_IMPLEMENTED',
        message,
      },
    }),
  toNullable: (value: any) => value ?? null,
};

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
      };
    }

    const express = () => ({});
    (express as any).Router = createRouter;
    return express;
  },
  { virtual: true },
);

jest.mock('../../server/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// jest.mock (not jest.unstable_mockModule): the suite runs under Jest's CJS
// transform, where unstable_mockModule registers into the never-consulted ESM
// registry and silently fails to intercept anything (#967 regression).
jest.mock('../../shared/core4-route-client.js', () => mockSharedCore4RouteClient);

const blockchainRoutes = require('../../server/routes/blockchain-routes.js');

function mockReq(
  params: Record<string, string> = {},
  body: any = {},
  query: any = {},
  headers: Record<string, any> = {}
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

function getHandler(router: any, pathSuffix: string): Function {
  for (const layer of router.stack) {
    if (layer.route && layer.route.path === pathSuffix) {
      return layer.route.stack[layer.route.stack.length - 1].handle;
    }
  }
  throw new Error(`No handler found for GET ${pathSuffix}`);
}

describe('blockchain-routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchCore4Json.mockReset();
  });

  it('maps core4 status data into the existing status shape', async () => {
    mockFetchCore4Json.mockImplementation(async (path: string) => {
      if (path === '/blockchain') {
        return {
          ok: true,
          status: 200,
          payload: {
            height: 88,
            tip: '0xabc',
            pending_transactions: 7,
          },
        };
      }

      if (path === '/network/info') {
        return {
          ok: true,
          status: 200,
          payload: {
            chain_id: 'wrfcoin-mainnet',
            sync_status: 'synced',
            peer_count: 12,
          },
        };
      }

      if (path === '/mining/stats') {
        return {
          ok: true,
          status: 200,
          payload: {
            difficulty: 12345,
            avg_block_time_secs: 11.5,
            chain_height: 88,
          },
        };
      }

      return { ok: true, status: 200, payload: {} };
    });

    const res = mockRes();
    const handler = getHandler(blockchainRoutes, '/status');

    await handler(mockReq(), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.blockHeight).toBe(88);
    expect(res.body.pendingTransactions).toBe(7);
    expect(res.body.chainId).toBe('wrfcoin-mainnet');
  });

  // audit/api-report-2026-09-09.md P2: core4's /transactions/stake/metrics is
  // now Reader-gated. This call is a server-side aggregate-dashboard read —
  // it must use a server-owned WRFCOIN_READER_TOKEN, never the inbound
  // caller's own Authorization (an anonymous public caller has none, and
  // reusing an authenticated caller's token here would spend their
  // credential on an unrelated server-initiated call).
  describe('stake/metrics auth (never forwards the caller Authorization)', () => {
    function mockChainCalls(stakePayload: any = { account_count: 4 }) {
      mockFetchCore4Json.mockImplementation(async (path: string) => {
        if (path === '/blockchain') {
          return { ok: true, status: 200, payload: { height: 88, tip: '0xabc', pending_transactions: 7 } };
        }
        if (path === '/network/info') {
          return { ok: true, status: 200, payload: { chain_id: 'wrfcoin-mainnet', sync_status: 'synced', peer_count: 12 } };
        }
        if (path === '/mining/stats') {
          return { ok: true, status: 200, payload: { difficulty: 12345, avg_block_time_secs: 11.5, chain_height: 88 } };
        }
        if (path === '/transactions/stake/metrics') {
          return { ok: true, status: 200, payload: stakePayload };
        }
        return { ok: true, status: 200, payload: {} };
      });
    }

    const originalReaderToken = process.env.WRFCOIN_READER_TOKEN;
    afterEach(() => {
      if (originalReaderToken === undefined) {
        delete process.env.WRFCOIN_READER_TOKEN;
      } else {
        process.env.WRFCOIN_READER_TOKEN = originalReaderToken;
      }
    });

    it('uses a server-owned Reader bearer token, not the caller Authorization, when WRFCOIN_READER_TOKEN is set', async () => {
      process.env.WRFCOIN_READER_TOKEN = 'server-reader-token-value';
      mockChainCalls({ account_count: 4 });

      const res = mockRes();
      const handler = getHandler(blockchainRoutes, '/status');

      await handler(
        mockReq({}, {}, {}, { authorization: 'Bearer station-read-token', 'x-api-key': 'reader-key' }),
        res
      );

      expect(res.statusCode).toBe(200);
      expect(res.body.activeValidators).toBe(4);
      expect(mockFetchCore4Json).toHaveBeenCalledWith('/transactions/stake/metrics', {
        headers: { authorization: 'Bearer server-reader-token-value' },
      });
      // All aggregate reads use the server Reader without caller credentials.
      expect(mockFetchCore4Json).toHaveBeenCalledWith('/blockchain', {
        headers: { authorization: 'Bearer server-reader-token-value' },
      });
    });

    it('reports an honest null activeValidators when WRFCOIN_READER_TOKEN is unset, and never sends the caller token', async () => {
      delete process.env.WRFCOIN_READER_TOKEN;
      mockFetchCore4Json.mockImplementation(async (path: string) => {
        if (path === '/blockchain') return { ok: true, status: 200, payload: { height: 88 } };
        if (path === '/network/info') return { ok: true, status: 200, payload: { sync_status: 'synced' } };
        if (path === '/mining/stats') return { ok: true, status: 200, payload: { chain_height: 88 } };
        if (path === '/transactions/stake/metrics') {
          return { ok: false, status: 401, payload: { error: 'unauthorized' } };
        }
        return { ok: true, status: 200, payload: {} };
      });

      const res = mockRes();
      const handler = getHandler(blockchainRoutes, '/status');

      await handler(mockReq({}, {}, {}, { authorization: 'Bearer station-read-token' }), res);

      expect(res.statusCode).toBe(200);
      expect(res.body.activeValidators).toBeNull();
      expect(mockFetchCore4Json).toHaveBeenCalledWith('/transactions/stake/metrics', { headers: {} });
    });
  });

  it('maps recent blocks from core4 and respects offset slicing', async () => {
    const blocks = [
      {
        height: 10,
        hash: '0xa',
        prev_block_hash: '0x9',
        timestamp: '2026-03-26T00:00:00.000Z',
        tx_count: 1,
      },
      {
        height: 11,
        hash: '0xb',
        prev_block_hash: '0xa',
        timestamp: '2026-03-26T00:01:00.000Z',
        tx_count: 2,
      },
      {
        height: 12,
        hash: '0xc',
        prev_block_hash: '0xb',
        timestamp: '2026-03-26T00:02:00.000Z',
        tx_count: 3,
      },
    ];
    mockFetchCore4Json.mockImplementation(async (path: string) => {
      if (path === '/chain/blocks') {
        return {
          ok: true,
          status: 200,
          payload: { blocks, chain_height: 12 },
        };
      }
      throw new Error(`Unexpected fetch ${path}`);
    });

    const res = mockRes();
    const handler = getHandler(blockchainRoutes, '/blocks');

    await handler(mockReq({}, {}, { limit: '1', offset: '1' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.blocks).toHaveLength(1);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].height).toBe(11);
    expect(res.body.total).toBe(13);
    expect(res.body.pagination.total).toBe(13);
    expect(res.body.pagination.page).toBe(2);
    expect(res.body.pagination.totalPages).toBe(13);
  });

  it('returns full page when offset is at exact boundary (#423)', async () => {
    const blocks = Array.from({ length: 11 }, (_, i) => ({
      height: i,
      hash: `0x${i}`,
      prev_block_hash: i > 0 ? `0x${i - 1}` : '0x0',
      timestamp: '2026-01-01T00:00:00.000Z',
      tx_count: 0,
    }));
    mockFetchCore4Json.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { blocks, chain_height: 10 },
    });

    const res = mockRes();
    const handler = getHandler(blockchainRoutes, '/blocks');

    await handler(mockReq({}, {}, { limit: '5', offset: '5' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(5);
    expect(res.body.data[0].height).toBe(5);
    expect(res.body.data[4].height).toBe(9);
    expect(res.body.pagination.page).toBe(2);
    expect(res.body.pagination.limit).toBe(5);
    expect(res.body.pagination.totalPages).toBe(3);
  });

  it('derives pagination booleans from the actual returned window for non-page-aligned offsets (#654)', async () => {
    const blocks = Array.from({ length: 11 }, (_, i) => ({
      height: i,
      hash: `0x${i}`,
      prev_block_hash: i > 0 ? `0x${i - 1}` : '0x0',
      timestamp: '2026-01-01T00:00:00.000Z',
      tx_count: 0,
    }));
    mockFetchCore4Json.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { blocks, chain_height: 10 },
    });

    const res = mockRes();
    const handler = getHandler(blockchainRoutes, '/blocks');

    await handler(mockReq({}, {}, { limit: '10', offset: '1' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(10);
    expect(res.body.data[0].height).toBe(1);
    expect(res.body.data[9].height).toBe(10);
    expect(res.body.pagination.hasPrev).toBe(true);
    expect(res.body.pagination.hasNext).toBe(false);
  });

  it('returns limit blocks even when offset > 0 — no silent truncation (#438)', async () => {
    const blocks = Array.from({ length: 101 }, (_, i) => ({
      height: i,
      hash: `0x${i}`,
      prev_block_hash: '0x0',
      timestamp: '2026-01-01T00:00:00.000Z',
      tx_count: 0,
    }));
    mockFetchCore4Json.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { blocks, chain_height: 100 },
    });

    const res = mockRes();
    const handler = getHandler(blockchainRoutes, '/blocks');

    // limit 100 is the operator/Reader ceiling; anonymous callers are bounded to the 30 most
    // recent blocks (explorer B1, see explorer-summary-b1.test.ts).
    process.env.WRFCOIN_OPERATOR_TOKEN = 'operator-token-for-438';
    try {
      await handler(mockReq({}, {}, { limit: '100', offset: '1' }, { authorization: 'Bearer operator-token-for-438' }), res);
    } finally {
      delete process.env.WRFCOIN_OPERATOR_TOKEN;
    }

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(100);
    expect(res.body.data[0].height).toBe(1);
    expect(res.body.data[99].height).toBe(100);
  });

  it('returns empty page when offset exceeds available blocks', async () => {
    const blocks = [
      { height: 0, hash: '0xa', prev_block_hash: '0x0', timestamp: '2026-01-01T00:00:00.000Z', tx_count: 0 },
    ];
    mockFetchCore4Json.mockResolvedValue({
      ok: true,
      status: 200,
      payload: { blocks, chain_height: 0 },
    });

    const res = mockRes();
    const handler = getHandler(blockchainRoutes, '/blocks');

    await handler(mockReq({}, {}, { limit: '10', offset: '100' }), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.data).toHaveLength(0);
    expect(res.body.pagination.hasNext).toBe(false);
  });

  it('returns 501 for unsupported transaction lookup', async () => {
    const res = mockRes();
    const handler = getHandler(blockchainRoutes, '/transactions/:hash');

    await handler(
      mockReq({ hash: '0x' + 'a'.repeat(64) }),
      res
    );

    expect(res.statusCode).toBe(501);
    expect(res.body.error.code).toBe('NOT_IMPLEMENTED');
  });

  it('returns 503 when core4 is unreachable', async () => {
    mockFetchCore4Json.mockRejectedValue(new Error('connect ECONNREFUSED'));

    const res = mockRes();
    const handler = getHandler(blockchainRoutes, '/status');

    await handler(mockReq(), res);

    expect(res.statusCode).toBe(503);
    expect(res.body.error.code).toBe('CORE4_UNAVAILABLE');
  });
});
