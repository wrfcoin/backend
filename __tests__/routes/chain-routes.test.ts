import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockFetch = jest.fn();

jest.mock('../../server/middleware/authMiddleware', () => ({
  requireAuth: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('../../server/db', () => ({
  pool: {
    query: jest.fn(),
  },
}));

jest.mock('../../server/utils/logger', () => ({
  blockchainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockQuery = (require('../../server/db') as any).pool.query as jest.Mock;

import chainRoutes from '../../server/routes/chain-routes.js';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/chain', chainRoutes);
  return app;
}

describe('chain-routes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).fetch = mockFetch;
    delete process.env.BUNDLER_RPC_URL;
    delete process.env.ENTRY_POINT_ADDRESS;
    delete process.env.BUNDLER_ENTRY_POINT_ADDRESS;
    delete process.env.USEROP_BUNDLER_RPC_URL;
  });

  it('relays the user operation to the bundler and persists a submitted transaction', async () => {
    process.env.BUNDLER_RPC_URL = 'http://bundler.local/rpc';
    process.env.ENTRY_POINT_ADDRESS = '0x1111111111111111111111111111111111111111';

    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ result: '0xabc123' }),
    });

    mockQuery.mockResolvedValue({ rows: [] });

    const res = await request(makeApp())
      .post('/api/chain/submit-userop')
      .send({
        userOp: {
          sender: '0x2222222222222222222222222222222222222222',
          to: '0x3333333333333333333333333333333333333333',
          amount: '42',
          memo: 'wallet send',
          callData: '0x',
          nonce: '7',
          hash: '0xdeadbeef',
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.userOpHash).toBe('0xabc123');
    expect(res.body.status).toBe('submitted');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('http://bundler.local/rpc');
    expect(options.method).toBe('POST');
    const payload = JSON.parse(options.body as string);
    expect(payload.method).toBe('eth_sendUserOperation');
    expect(payload.params[0].sender).toBe('0x2222222222222222222222222222222222222222');
    expect(payload.params[1]).toBe('0x1111111111111111111111111111111111111111');
    expect(mockQuery).toHaveBeenCalledTimes(1);
    expect(mockQuery.mock.calls[0][0]).toContain('INSERT INTO transactions');
    expect(mockQuery.mock.calls[0][1][0]).toBe('0xabc123');
    expect(mockQuery.mock.calls[0][1][5]).toBe('submitted');
  });

  it('returns 503 when the bundler is not configured', async () => {
    const res = await request(makeApp())
      .post('/api/chain/submit-userop')
      .send({
        userOp: {
          sender: '0x2222222222222222222222222222222222222222',
          to: '0x3333333333333333333333333333333333333333',
          amount: '42',
          callData: '0x',
          nonce: '7',
        },
      });

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('BUNDLER_RPC_URL_MISSING');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('returns 502 when the bundler rejects the user operation', async () => {
    process.env.BUNDLER_RPC_URL = 'http://bundler.local/rpc';

    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { message: 'invalid userOp' } }),
    });

    const res = await request(makeApp())
      .post('/api/chain/submit-userop')
      .send({
        userOp: {
          sender: '0x2222222222222222222222222222222222222222',
          to: '0x3333333333333333333333333333333333333333',
          amount: '42',
          callData: '0x',
          nonce: '7',
        },
      });

    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('BUNDLER_RELAY_FAILED');
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
