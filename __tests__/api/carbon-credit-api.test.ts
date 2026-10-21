import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockGetAllBatches = jest.fn();
const mockCallContract = jest.fn();

jest.mock('express-rate-limit', () =>
  jest.fn(() => (_req: any, _res: any, next: any) => next())
);

jest.mock('helmet', () => () => (_req: any, _res: any, next: any) => next());

jest.mock('winston', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  })),
  format: {
    combine: jest.fn(() => ({})),
    timestamp: jest.fn(() => ({})),
    json: jest.fn(() => ({})),
    simple: jest.fn(() => ({})),
  },
  transports: {
    File: jest.fn(),
    Console: jest.fn(),
  },
}));

jest.mock('../../services/secure-wallet-service.js', () => ({
  SecureWalletService: jest.fn().mockImplementation(() => ({
    generateNonce: jest.fn().mockReturnValue('test-nonce'),
    verifyTransactionRequest: jest.fn().mockReturnValue(true),
    checkWalletBalance: jest.fn().mockResolvedValue(true),
    createAdminWallet: jest.fn().mockReturnValue({ address: '0xadmin' }),
    logSecurityEvent: jest.fn(),
  })),
}));

jest.mock('../../blockchain/services/smart-contract-service.js', () => ({
  smartContractService: {
    callContract: mockCallContract,
  },
}));

jest.mock('../../server/middleware/auth.js', () => ({
  authenticateJWT: (_req: any, _res: any, next: any) => next(),
}));

jest.mock('ethers', () => {
  const Contract = jest.fn((_address: string) => ({
    target: _address,
    connect: jest.fn().mockReturnThis(),
    getAllBatches: mockGetAllBatches,
  }));

  return {
    ethers: {
      JsonRpcProvider: jest.fn(),
      Contract,
      isAddress: jest.fn(() => true),
      ZeroAddress: '0x0000000000000000000000000000000000000000',
      parseEther: jest.fn((value: string) => value),
      formatEther: jest.fn((value: string) => value),
    },
  };
});

import { carbonCreditAPI } from '../../api/carbon-credit-api.ts';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', carbonCreditAPI);
  return app;
}

describe('carbon-credit-api', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAllBatches.mockResolvedValue({
      items: [{ tokenId: 1, projectType: 'reforestation' }],
      total: 1,
    });
  });

  it('returns paginated carbon-credit batches', async () => {
    const res = await request(makeApp())
      .get('/api/carbon-credits/batches?page=1&limit=20')
      .set('x-request-id', 'req-carbon-1');

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.requestId).toBe('req-carbon-1');
    expect(res.body.data.pagination.totalItems).toBe(1);
    expect(Array.isArray(res.body.data.batches)).toBe(true);
  });

  it('returns 500 when batch retrieval fails', async () => {
    mockGetAllBatches.mockRejectedValueOnce(new Error('rpc down'));

    const res = await request(makeApp())
      .get('/api/carbon-credits/batches')
      .set('x-request-id', 'req-carbon-2');

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('Failed to retrieve carbon credit batches');
    expect(res.body.requestId).toBe('req-carbon-2');
  });

  it('enforces wallet presence for authenticated transfer flows', async () => {
    const res = await request(makeApp())
      .post('/api/carbon-credits/transfer')
      .send({
        tokenId: 4,
        to: '0x1111111111111111111111111111111111111111',
        amount: 2,
      });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toBe('User wallet address not found in token');
    expect(mockCallContract).not.toHaveBeenCalled();
  });
});
