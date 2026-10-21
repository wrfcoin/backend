/**
 * Smoke tests for server/routes/cross-chain-routes.js
 * Issue #357 — cross-chain-routes has 6 endpoints and zero tests
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

const passthrough = (_req: any, _res: any, next: any) => next();

const mockController = {
  isInitialized: jest.fn().mockReturnValue(true),
  initialize: jest.fn().mockResolvedValue(undefined),
  getSupportedChains: jest.fn(),
  getNetworkStatus: jest.fn(),
  getBridgeProviders: jest.fn(),
  getComputeProviders: jest.fn(),
  getStorageProviders: jest.fn(),
  transferNFT: jest.fn(),
  transferAssetCrossChain: jest.fn(),
  executeComputationalTask: jest.fn(),
  verifyTransaction: jest.fn(),
};

jest.mock('express', () => {
  function createRouter() {
    return {
      stack: [] as any[],
      use(...args: any[]) {
        // If first arg is a function (middleware), push it; if path + fn, store route
        const firstArg = args[0];
        if (typeof firstArg === 'function') {
          this.stack.push({ handle: firstArg });
        }
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

jest.mock('../../server/integrations/cross-chain/controller', () => ({
  controller: mockController,
}));
jest.mock('../../server/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../shared/utils/input-sanitizer', () => ({
  sanitizeObject: jest.fn((obj: any) => obj),
  detectXSS: jest.fn().mockReturnValue(false),
  validateChainId: jest.fn().mockReturnValue(true),
  validateAssetId: jest.fn().mockReturnValue(true),
  validateBlockchainAddress: jest.fn().mockReturnValue(true),
}));
jest.mock('../../server/middleware/authMiddleware', () => ({ requireAuth: passthrough }));

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
  mockController.isInitialized.mockReturnValue(true);
  router = require('../../server/routes/cross-chain-routes');
});

describe('GET /chains', () => {
  it('returns 200 with supported chains', async () => {
    mockController.getSupportedChains.mockReturnValueOnce(['ethereum', 'polygon', 'wrfcoin']);
    const handler = getHandler(router, 'GET', '/chains');
    const res = mockRes();
    handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.chains).toEqual(['ethereum', 'polygon', 'wrfcoin']);
  });

  it('returns 500 when getSupportedChains throws', async () => {
    mockController.getSupportedChains.mockImplementationOnce(() => { throw new Error('chain error'); });
    const handler = getHandler(router, 'GET', '/chains');
    const res = mockRes();
    handler(mockReq(), res);
    expect(res.statusCode).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /status', () => {
  it('returns 200 with network status', async () => {
    mockController.getNetworkStatus.mockReturnValueOnce({ online: true, chains: 3 });
    const handler = getHandler(router, 'GET', '/status');
    const res = mockRes();
    handler(mockReq(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.status.online).toBe(true);
  });
});

describe('GET /providers', () => {
  it('returns all provider types when no type query param', async () => {
    mockController.getBridgeProviders.mockReturnValueOnce(['axelar']);
    mockController.getComputeProviders.mockReturnValueOnce(['golem']);
    mockController.getStorageProviders.mockReturnValueOnce(['ipfs']);
    const handler = getHandler(router, 'GET', '/providers');
    const res = mockRes();
    handler(mockReq({}, {}, {}), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.providers.bridge).toEqual(['axelar']);
    expect(res.body.providers.compute).toEqual(['golem']);
    expect(res.body.providers.storage).toEqual(['ipfs']);
  });

  it('returns only bridge providers when type=bridge', async () => {
    mockController.getBridgeProviders.mockReturnValueOnce(['axelar', 'wormhole']);
    const handler = getHandler(router, 'GET', '/providers');
    const res = mockRes();
    handler(mockReq({}, {}, { type: 'bridge' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.providers).toEqual(['axelar', 'wormhole']);
  });

  it('returns only compute providers when type=compute', async () => {
    mockController.getComputeProviders.mockReturnValueOnce(['golem', 'akash']);
    const handler = getHandler(router, 'GET', '/providers');
    const res = mockRes();
    handler(mockReq({}, {}, { type: 'compute' }), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.providers).toEqual(['golem', 'akash']);
  });
});

describe('POST /transfer', () => {
  it('returns 400 when assetId fails validation', async () => {
    const { validateAssetId } = require('../../shared/utils/input-sanitizer');
    (validateAssetId as jest.Mock).mockReturnValueOnce(false);
    const handler = getHandler(router, 'POST', '/transfer');
    const res = mockRes();
    await handler(
      mockReq({}, { assetId: 'bad!asset', assetType: 'NFT', sourceChain: 'eth', destinationChain: 'polygon', destinationAddress: '0xABC' }),
      res
    );
    expect(res.statusCode).toBe(400);
    expect(res.body.error).toMatch(/invalid characters/i);
  });

  it('returns 400 when required fields are missing', async () => {
    const handler = getHandler(router, 'POST', '/transfer');
    const res = mockRes();
    await handler(mockReq({}, { assetType: 'NFT' }), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 on successful transfer', async () => {
    mockController.transferAssetCrossChain.mockResolvedValueOnce({ success: true, transactionId: 'tx-1' });
    const handler = getHandler(router, 'POST', '/transfer');
    const res = mockRes();
    await handler(
      mockReq({}, {
        assetId: 'nft-001',
        assetType: 'NFT',
        sourceChain: 'ethereum',
        destinationChain: 'polygon',
        destinationAddress: '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12',
      }),
      res
    );
    expect(res.statusCode).toBe(200);
    expect(res.body.success).toBe(true);
  });
});
