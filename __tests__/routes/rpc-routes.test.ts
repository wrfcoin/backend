import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

jest.mock('../../server/middleware/rpcAuthMiddleware', () => ({
  verifyRpcApiKey: (_req: any, _res: any, next: any) => next(),
  rpcRateLimiter: (_req: any, _res: any, next: any) => next(),
  logRpcAccess: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../server/utils/logger', () => ({
  logger: {
    error: jest.fn(),
  },
}));

jest.mock('../../shared/core4-route-client.js', () => ({
  fetchCore4Json: jest.fn(),
  extractCore4Data: jest.fn((payload: any) => payload),
  forwardCore4Headers: jest.fn(() => ({})),
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

let noaaConstructorCalls = 0;
const mockNOAAGetForecast = jest.fn();
jest.mock('../../server/services/noaa-nws-api-service', () =>
  jest.fn().mockImplementation(() => {
    noaaConstructorCalls += 1;
    return {
      getForecast: mockNOAAGetForecast,
    };
  })
);

import router from '../../server/routes/rpc-routes.js';
import {
  fetchCore4Json,
  extractCore4Data,
  forwardCore4Headers,
} from '../../shared/core4-route-client.js';

function mockReq(body: any = {}, headers: Record<string, string> = {}): any {
  return {
    body,
    headers,
    method: 'POST',
    url: '/',
    user: { sub: `0x${'a'.repeat(40)}`, role: 'wallet' },
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

const ORIGINAL_READER_TOKEN = process.env.WRFCOIN_READER_TOKEN;
afterAll(() => {
  if (ORIGINAL_READER_TOKEN === undefined) delete process.env.WRFCOIN_READER_TOKEN;
  else process.env.WRFCOIN_READER_TOKEN = ORIGINAL_READER_TOKEN;
});

describe('rpc route error envelopes', () => {
  beforeEach(() => {
    process.env.WRFCOIN_READER_TOKEN = 'test-only-reader-read-policy-unit';
    jest.clearAllMocks();
    (extractCore4Data as jest.Mock).mockImplementation((payload: any) => payload);
    (forwardCore4Headers as jest.Mock).mockReturnValue({});
    mockNOAAGetForecast.mockReset();
  });

  it('hides internal upstream failures from JSON-RPC clients', async () => {
    (fetchCore4Json as jest.Mock).mockResolvedValue({
      ok: false,
      payload: {},
    });

    const response = mockRes();
    const handler = getHandler(router, 'POST', '/');

    await handler(
      mockReq({
        jsonrpc: '2.0',
        id: 'req-1',
        method: 'blockchain.getStatus',
        params: [],
      }),
      response
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toEqual({
      code: -32603,
      message: 'Internal error',
    });
    expect(JSON.stringify(response.body)).not.toContain('core4 unavailable');
  });

  it('keeps safe invalid-parameter feedback specific', async () => {
    const response = mockRes();
    const handler = getHandler(router, 'POST', '/');

    await handler(
      mockReq({
        jsonrpc: '2.0',
        id: 'req-2',
        method: 'wallet.getBalance',
        params: null,
      }),
      response
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toEqual({
      code: -32602,
      message: 'Invalid params',
      data: 'Missing required parameter: address',
    });
  });

  it('uses the launch API address path for wallet balance lookups', async () => {
    (fetchCore4Json as jest.Mock).mockResolvedValue({
      ok: true,
      payload: {
        spendable_balance: '12.5',
        pending_balance: '1.5',
        stake_locked: '3.0',
      },
    });

    const response = mockRes();
    const handler = getHandler(router, 'POST', '/');

    await handler(
      mockReq({
        jsonrpc: '2.0',
        id: 'req-3',
        method: 'wallet.getBalance',
        params: `0x${'a'.repeat(40)}`,
      }),
      response
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.result.balance).toBe('12.5');
    expect(response.body.result.stakedBalance).toBe('3.0');
    expect(fetchCore4Json).toHaveBeenCalledWith(
      `/addresses/0x${'a'.repeat(40)}`,
      expect.objectContaining({
        headers: { authorization: 'Bearer test-only-reader-read-policy-unit' },
      })
    );
  });

  it('uses the launch API chain block path for blockchain.getBlock (#851)', async () => {
    (fetchCore4Json as jest.Mock).mockResolvedValue({
      ok: true,
      payload: {
        height: 42,
        hash: '0xblock',
        prev_block_hash: '0xprev',
        timestamp: '2026-06-21T00:00:00+00:00',
        tx_count: 3,
        difficulty: 7,
        nonce: 99,
      },
    });

    const response = mockRes();
    const handler = getHandler(router, 'POST', '/');

    await handler(
      mockReq({
        jsonrpc: '2.0',
        id: 'req-block',
        method: 'blockchain.getBlock',
        params: 42,
      }),
      response
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.result).toEqual(
      expect.objectContaining({
        height: 42,
        hash: '0xblock',
        previousHash: '0xprev',
        transactions: 3,
        difficulty: 7,
        nonce: 99,
        size: null,
        validator: null,
      })
    );
    expect(fetchCore4Json).toHaveBeenCalledWith(
      '/chain/block/42',
      expect.objectContaining({ headers: { authorization: 'Bearer test-only-reader-read-policy-unit' } })
    );
  });

  it('spreads the signed-tx envelope into PermissionlessSubmitRequest fields for tx.submit (#852)', async () => {
    (fetchCore4Json as jest.Mock).mockResolvedValue({
      ok: true,
      payload: {
        hash: '0xtx',
        accepted: true,
      },
    });

    const response = mockRes();
    const handler = getHandler(router, 'POST', '/');

    const signedTx = {
      signer_public_key: 'aa11',
      signature: 'bb22',
      nonce: '0',
      timestamp: 1750000000,
      tx_type: 'data_analysis',
      payload: { to: 'wrf1dest', amount: '100000000' },
    };

    await handler(
      mockReq({
        jsonrpc: '2.0',
        id: 'req-4',
        method: 'tx.submit',
        params: signedTx,
      }),
      response
    );

    expect(response.statusCode).toBe(200);
    expect(response.body.result).toEqual(
      expect.objectContaining({
        txHash: '0xtx',
        accepted: true,
      })
    );
    expect(fetchCore4Json).toHaveBeenCalledWith(
      '/transactions/permissionless/submit',
      expect.objectContaining({
        method: 'POST',
        body: {
          signer_public_key: 'aa11',
          signature: 'bb22',
          nonce: '0',
          timestamp: 1750000000,
          tx_type: 'data_analysis',
          payload: { to: 'wrf1dest', amount: '100000000' },
        },
      })
    );
  });

  it('rejects tx.submit when tx_type is not data_analysis without calling core4 (#852)', async () => {
    const response = mockRes();
    const handler = getHandler(router, 'POST', '/');

    await handler(
      mockReq({
        jsonrpc: '2.0',
        id: 'req-4c',
        method: 'tx.submit',
        params: {
          signer_public_key: 'aa11',
          signature: 'bb22',
          nonce: '0',
          timestamp: 1750000000,
          tx_type: 'Transfer',
          payload: { to: 'wrf1dest', amount: '100000000' },
        },
      }),
      response
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toEqual({
      code: -32602,
      message: 'Invalid params',
      data: "tx_type must be 'data_analysis' for the permissionless submit lane",
    });
    // core4 must never be contacted for an invalid tx_type.
    expect(fetchCore4Json).not.toHaveBeenCalled();
  });

  it('rejects tx.submit when the envelope is missing required fields (#852)', async () => {
    const response = mockRes();
    const handler = getHandler(router, 'POST', '/');

    await handler(
      mockReq({
        jsonrpc: '2.0',
        id: 'req-4b',
        method: 'tx.submit',
        params: { signer_public_key: 'aa11' },
      }),
      response
    );

    expect(response.statusCode).toBe(400);
    expect(response.body.error).toEqual({
      code: -32602,
      message: 'Invalid params',
      data: 'Missing required parameter: signedTx.signature',
    });
    expect(fetchCore4Json).not.toHaveBeenCalled();
  });

  it('creates the NOAA service once and reuses it across forecast calls', async () => {
    mockNOAAGetForecast.mockResolvedValue({
      periods: [{ name: 'Tonight', shortForecast: 'Clear' }],
    });

    const handler = getHandler(router, 'POST', '/');

    const first = mockRes();
    await handler(
      mockReq({
        jsonrpc: '2.0',
        id: 'req-4',
        method: 'oracle.getForecast',
        params: {
          location: {
            latitude: 41.9,
            longitude: -87.6,
          },
        },
      }),
      first
    );

    const second = mockRes();
    await handler(
      mockReq({
        jsonrpc: '2.0',
        id: 'req-5',
        method: 'oracle.getForecast',
        params: {
          location: '41.9,-87.6',
        },
      }),
      second
    );

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(noaaConstructorCalls).toBe(1);
    expect(mockNOAAGetForecast).toHaveBeenCalledTimes(2);
  });
});
