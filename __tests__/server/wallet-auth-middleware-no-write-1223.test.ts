/**
 * backend#1223: walletAuth used to call getOrCreateWallet() for any request
 * carrying X-Wallet-Address, before any signature check, so an anonymous GET
 * could insert unlimited `wallets` rows. A row may only be created once a
 * signature proves the caller holds the address.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockGetOrCreateWallet = jest.fn();
const mockVerifySignature = jest.fn();
const mockDbInsert = jest.fn();

function makeChain(result: unknown) {
  const chain: any = {};
  ['from', 'innerJoin', 'where', 'limit', 'set'].forEach(m => {
    chain[m] = jest.fn().mockReturnValue(chain);
  });
  chain.then = (resolve: any, reject: any) => Promise.resolve(result).then(resolve, reject);
  return chain;
}

jest.mock('../../server/db', () => ({
  db: {
    select: jest.fn(() => makeChain([])),
    update: jest.fn(() => makeChain(undefined)),
    insert: (...args: unknown[]) => mockDbInsert(...args),
  },
}));
jest.mock('../../shared/schema', () => ({
  wallets: {},
  users: {},
  walletUserAssociations: { walletId: 'walletId', isAuthorized: 'isAuthorized', userId: 'userId', id: 'id' },
}));
jest.mock('drizzle-orm', () => ({ eq: jest.fn(), and: jest.fn() }));
jest.mock('../../server/utils/cryptoUtils', () => ({
  verifySignature: (...args: unknown[]) => mockVerifySignature(...args),
}));
jest.mock('../../server/controllers/walletController', () => ({
  getOrCreateWallet: (...args: unknown[]) => mockGetOrCreateWallet(...args),
}));
jest.mock('../../server/utils/logger', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { walletAuth } = require('../../server/middleware/walletAuthMiddleware');

const ADDRESS = '0xAbCdEf1234567890AbCdEf1234567890AbCdEf12';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(walletAuth);
  app.all('*', (req: any, res) =>
    res.json({ walletAuthenticated: req.isWalletAuthenticated, hasWallet: !!req.wallet })
  );
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetOrCreateWallet.mockImplementation(async () => ({ id: 'w1', address: ADDRESS }));
});

describe('walletAuth creates no wallet row for an unverified X-Wallet-Address', () => {
  it.each(['/nonce/' + ADDRESS, '/' + ADDRESS])('anonymous GET %s', async path => {
    const res = await request(buildApp()).get(path).set('X-Wallet-Address', ADDRESS);

    expect(res.status).toBe(200);
    expect(res.body.walletAuthenticated).toBe(false);
    expect(mockGetOrCreateWallet).not.toHaveBeenCalled();
    expect(mockDbInsert).not.toHaveBeenCalled();
  });

  it('unsigned POST', async () => {
    const res = await request(buildApp()).post('/associate').set('X-Wallet-Address', ADDRESS).send({});

    expect(res.body.walletAuthenticated).toBe(false);
    expect(mockGetOrCreateWallet).not.toHaveBeenCalled();
  });

  it('POST with an invalid signature is rejected before any wallet write', async () => {
    mockVerifySignature.mockReturnValue(false);

    const res = await request(buildApp())
      .post('/associate')
      .set('X-Wallet-Address', ADDRESS)
      .set('X-Wallet-Signature', '0xbad')
      .set('X-Wallet-Message', 'msg')
      .send({});

    expect(res.status).toBe(401);
    expect(mockGetOrCreateWallet).not.toHaveBeenCalled();
  });

  it('POST with a valid signature may create the wallet', async () => {
    mockVerifySignature.mockReturnValue(true);

    const res = await request(buildApp())
      .post('/associate')
      .set('X-Wallet-Address', ADDRESS)
      .set('X-Wallet-Signature', '0xgood')
      .set('X-Wallet-Message', 'msg')
      .send({});

    expect(res.status).toBe(200);
    expect(res.body.walletAuthenticated).toBe(true);
    expect(res.body.hasWallet).toBe(true);
    expect(mockGetOrCreateWallet).toHaveBeenCalledWith(ADDRESS);
  });
});
