/**
 * Smoke tests for server/routes/wallet-auth-legacy-routes.js Express router
 * Issue #356 — wallet-auth routes have zero test coverage
 *
 * Uses supertest to mount the real router on an express app, with all
 * heavy dependencies (DB, walletController, middleware) mocked.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import path from 'path';

const passthrough = (_req: any, _res: any, next: any) => next();
const mockRateLimitMiddleware = jest.fn(passthrough);
const mockAuthRateLimitPreset = {
  windowMs: 15 * 60 * 1000,
  maxRequests: 5,
  keyPrefix: 'ratelimit:auth',
};
const mockCreateRateLimitMiddleware = jest.fn(() => mockRateLimitMiddleware);

// Drizzle-style chainable mock — awaitable at any point in the chain
function makeDrizzleChain(result: any = undefined) {
  const chain: any = {};
  ['select','update','insert','set','values','where','from','orderBy','innerJoin','returning'].forEach(m => {
    chain[m] = jest.fn().mockReturnThis();
  });
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

const mockGenerateWalletNonce = jest.fn().mockReturnValue('mock-hex-nonce-64chars');
const mockGetOrCreateWallet = jest.fn();
const mockGetWallet = jest.fn();

const mockDb = {
  update: jest.fn(),
  select: jest.fn(),
  insert: jest.fn(),
};

jest.mock('../../server/db', () => ({ db: mockDb }));
jest.mock('../../shared/schema', () => ({
  wallets: { id: 'wallets.id', metadata: 'wallets.metadata' },
  users: {},
  walletUserAssociations: {},
}));
jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a: any, b: any) => ['eq', a, b]),
  and: jest.fn((...args: any[]) => ['and', ...args]),
}));
jest.mock('../../server/middleware/walletAuthMiddleware', () => ({
  walletAuth: passthrough,
  requireWalletAuth: passthrough,
  requireUserAuth: passthrough,
  associateWalletWithUser: jest.fn(),
  verifyWalletSignature: jest.fn().mockResolvedValue(false),
}));
jest.mock('../../server/controllers/walletController', () => ({
  generateWalletNonce: mockGenerateWalletNonce,
  getOrCreateWallet: mockGetOrCreateWallet,
  getWallet: mockGetWallet,
  default: {
    generateWalletNonce: mockGenerateWalletNonce,
    getOrCreateWallet: mockGetOrCreateWallet,
    getWallet: mockGetWallet,
  },
}));
jest.mock('../../server/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../shared/middleware/rate-limit-redis', () => ({
  createRateLimitMiddleware: mockCreateRateLimitMiddleware,
  RATE_LIMIT_PRESETS: {
    auth: mockAuthRateLimitPreset,
  },
}));

// Build an express app mounting the uniquely named legacy router.
const ROUTES_JS = path.resolve(__dirname, '../../server/routes/wallet-auth-legacy-routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  delete require.cache[ROUTES_JS];
  const router = require(ROUTES_JS);
  const actualRouter = router.default ?? router;
  app.use('/', actualRouter);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRateLimitMiddleware.mockImplementation(passthrough);
  mockCreateRateLimitMiddleware.mockReturnValue(mockRateLimitMiddleware);
  mockDb.update.mockReturnValue(makeDrizzleChain());
  mockDb.select.mockReturnValue(makeDrizzleChain([]));
  mockDb.insert.mockReturnValue(makeDrizzleChain());
});

describe('GET /nonce/:address', () => {
  it('uses the shared auth rate-limit preset on wallet login nonce and verify routes only', async () => {
    mockDb.select.mockReturnValueOnce(makeDrizzleChain([{ id: 1, metadata: {} }]));
    const app = buildApp();

    await request(app).get('/nonce/0xAbCdEf1234567890AbCdEf1234567890AbCdEf12');
    await request(app)
      .post('/verify')
      .send({ signature: '0xsig', message: 'some-msg' });
    await request(app).post('/associate').send({});

    expect(mockCreateRateLimitMiddleware).toHaveBeenCalledWith({
      ...mockAuthRateLimitPreset,
      message: 'Too many wallet login attempts, please try again later.',
    });
    expect(mockRateLimitMiddleware).toHaveBeenCalledTimes(2);
  });

  it('returns 200 with a nonce on success', async () => {
    mockDb.select.mockReturnValueOnce(makeDrizzleChain([{ id: 1, metadata: {} }]));
    const app = buildApp();
    const res = await request(app).get('/nonce/0xAbCdEf1234567890AbCdEf1234567890AbCdEf12');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.nonce).toBe('mock-hex-nonce-64chars');
    expect(res.body.message).toMatch(/sign/i);
  });

  // backend#1223: an anonymous GET used to INSERT a wallet row for any address.
  it('returns 404 for an unknown address and inserts no wallet row', async () => {
    mockDb.select.mockReturnValueOnce(makeDrizzleChain([]));
    const app = buildApp();
    const res = await request(app).get('/nonce/0xAbCdEf1234567890AbCdEf1234567890AbCdEf12');
    expect(res.status).toBe(404);
    expect(mockGetOrCreateWallet).not.toHaveBeenCalled();
    expect(mockDb.insert).not.toHaveBeenCalled();
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it('returns 500 when the wallet lookup throws', async () => {
    mockDb.select.mockImplementationOnce(() => {
      throw new Error('wallet error');
    });
    const app = buildApp();
    const res = await request(app).get('/nonce/0xAbCdEf1234567890AbCdEf1234567890AbCdEf12');
    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /verify', () => {
  it('returns 400 when address is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/verify')
      .send({ signature: '0xsig', message: 'some-msg' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when signature is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/verify')
      .send({ address: '0x123', message: 'some-msg' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when message is missing', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/verify')
      .send({ address: '0x123', signature: '0xsig' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  it('returns 404 when wallet is not found', async () => {
    mockGetWallet.mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app)
      .post('/verify')
      .send({ address: '0x123', signature: '0xsig', message: 'msg' });
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });

  it('returns 400 when wallet has no nonce stored', async () => {
    mockGetWallet.mockResolvedValueOnce({ id: 1, address: '0x123', metadata: {} });
    const app = buildApp();
    const res = await request(app)
      .post('/verify')
      .send({ address: '0x123', signature: '0xsig', message: 'msg' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/nonce/i);
  });
});

describe('POST /associate', () => {
  it('returns 400 when walletAddress is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/associate').send({});
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /:address', () => {
  it('returns 404 when wallet is not found', async () => {
    mockGetWallet.mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app).get('/0x1234567890abcdef1234567890abcdef12345678');
    expect(res.status).toBe(404);
  });

  it('returns 200 with wallet data when found', async () => {
    mockGetWallet.mockResolvedValueOnce({
      id: 1,
      address: '0x1234567890abcdef1234567890abcdef12345678',
      network: 'testnet',
      balance: '100',
      is_active: true,
      metadata: {},
      created_at: new Date().toISOString(),
    });
    const app = buildApp();
    const res = await request(app).get('/0x1234567890abcdef1234567890abcdef12345678');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.wallet).toBeDefined();
  });
});
