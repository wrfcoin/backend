import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockVerifySignature = jest.fn();
const mockGetOrCreateWallet = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

const mockLimit = jest.fn();
const mockWhere = jest.fn(() => ({ limit: mockLimit }));
const mockInnerJoin = jest.fn(() => ({ where: mockWhere }));
const mockFrom = jest.fn(() => ({ innerJoin: mockInnerJoin }));
const mockSelect = jest.fn(() => ({ from: mockFrom }));

const mockUpdateWhere = jest.fn().mockResolvedValue(undefined);
const mockSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockSet }));

const mockDb = {
  select: mockSelect,
  update: mockUpdate,
};

jest.mock('../../server/utils/cryptoUtils', () => ({
  verifySignature: mockVerifySignature,
}));

jest.mock('../../server/utils/logger', () => ({
  logger: mockLogger,
}));

jest.mock('../../server/controllers/walletController', () => ({
  getOrCreateWallet: mockGetOrCreateWallet,
  associateWalletWithUser: jest.fn(),
}));

jest.mock('../../server/db', () => ({
  db: mockDb,
}));

jest.mock('../../shared/schema', () => ({
  wallets: { id: 'wallets.id' },
  users: { id: 'users.id' },
  walletUserAssociations: {
    id: 'assoc.id',
    userId: 'assoc.userId',
    walletId: 'assoc.walletId',
    isAuthorized: 'assoc.isAuthorized',
  },
}));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((a: unknown, b: unknown) => ['eq', a, b]),
  and: jest.fn((...args: unknown[]) => ['and', ...args]),
}));

const {
  walletAuth,
  requireWalletAuth,
  requireUserAuth,
} = require('../../server/middleware/walletAuthMiddleware');

function makeReq(overrides: Record<string, unknown> = {}) {
  return {
    path: '/wallet/protected',
    method: 'POST',
    headers: {},
    ...overrides,
  } as any;
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
  } as any;
}

describe('walletAuthMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetOrCreateWallet.mockResolvedValue({ id: 101, address: '0xabc' });
    mockLimit.mockResolvedValue([]);
    mockVerifySignature.mockResolvedValue(true);
  });

  it('allows anonymous requests with no wallet headers', async () => {
    const req = makeReq();
    const res = makeRes();
    const next = jest.fn();

    await walletAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.isWalletAuthenticated).toBe(false);
    expect(req.isUserAuthenticated).toBe(false);
    expect(mockGetOrCreateWallet).not.toHaveBeenCalled();
  });

  it('skips signature verification for GET requests', async () => {
    const req = makeReq({
      method: 'GET',
      headers: { 'x-wallet-address': '0x1234567890abcdef1234567890abcdef12345678' },
    });
    const res = makeRes();
    const next = jest.fn();

    await walletAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    // backend#1223: an unverified address on a GET must not create a wallet row.
    expect(mockGetOrCreateWallet).not.toHaveBeenCalled();
    expect(mockVerifySignature).not.toHaveBeenCalled();
    expect(req.isWalletAuthenticated).toBe(false);
  });

  it('returns 401 for invalid wallet signature', async () => {
    const req = makeReq({
      headers: {
        'x-wallet-address': '0x1234567890abcdef1234567890abcdef12345678',
        'x-wallet-signature': '0xbadsig',
        'x-wallet-message': 'msg',
      },
    });
    const res = makeRes();
    const next = jest.fn();

    mockVerifySignature.mockResolvedValue(false);

    await walletAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Invalid wallet signature',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('authenticates wallet and attaches user when association exists', async () => {
    const req = makeReq({
      headers: {
        'x-wallet-address': '0x1234567890abcdef1234567890abcdef12345678',
        'x-wallet-signature': '0xgoodsig',
        'x-wallet-message': 'msg',
      },
    });
    const res = makeRes();
    const next = jest.fn();

    mockLimit.mockResolvedValue([
      {
        association: { id: 5001 },
        user: { id: 42, roles: ['member'] },
      },
    ]);
    mockVerifySignature.mockResolvedValue(true);

    await walletAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.isWalletAuthenticated).toBe(true);
    expect(req.isUserAuthenticated).toBe(true);
    expect(req.user).toEqual({ id: 42, roles: ['member'] });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockSet).toHaveBeenCalledTimes(1);
    expect(mockUpdateWhere).toHaveBeenCalledTimes(1);
  });

  it('requireWalletAuth rejects unauthenticated requests', () => {
    const req = { isWalletAuthenticated: false } as any;
    const res = makeRes();
    const next = jest.fn();

    requireWalletAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'Wallet authentication required',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('requireUserAuth rejects when user is not authenticated', () => {
    const req = { isUserAuthenticated: false } as any;
    const res = makeRes();
    const next = jest.fn();

    requireUserAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      message: 'User authentication required',
    });
    expect(next).not.toHaveBeenCalled();
  });
});
