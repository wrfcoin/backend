import { attachWalletNonceIssuer } from '../helpers/wallet-nonce-redis';
import express from 'express';
import request from 'supertest';
import { Wallet } from 'ethers';

jest.mock('../../utils/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('../../server/utils/logger.js', () => ({
  appLogger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

describe('wallet login JWT contract for protected wallet routes', () => {
  const originalEnv = { ...process.env };
  const jwtSecret = 'wallet-login-route-auth-secret-'.padEnd(64, 'x');

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it('accepts the wallet-login access JWT on a production protected wallet route', async () => {
    process.env.NODE_ENV = 'production';
    process.env.JWT_SECRET = jwtSecret;

    const { createWalletAuthService } = await import(
      '../../server/routes/wallet-auth-service'
    );
    const { requireAuth } = require('../../server/middleware/authMiddleware');

    const redisStore = new Map<string, string>();
    const redis = attachWalletNonceIssuer({
      set: jest.fn(async (key: string, value: string) => {
        redisStore.set(key, value);
        return 'OK';
      }),
      get: jest.fn(async (key: string) => redisStore.get(key) ?? null),
      del: jest.fn(async (key: string) => {
        redisStore.delete(key);
        return 1;
      }),
    });
    const db = { execute: jest.fn(async () => ({ rows: [] })) };

    const wallet = Wallet.createRandom();
    const service = createWalletAuthService({
      jwtSecret,
      redis,
      db,
      accessTokenTtlSec: 15 * 60,
      walletAuthOrigin: 'https://wrfcoin.com',
      walletAuthChainId: 777,
    });
    const challenge = await service.generateNonce(wallet.address);
    const signature = await wallet.signMessage(challenge.message);

    const loginResponse = await service.walletLogin({
      address: wallet.address,
      signature,
      nonce: challenge.nonce,
    });

    const app = express();
    app.get('/api/wallet/:address', requireAuth, (req, res) => {
      res.status(200).json({
        address: req.params.address,
        authenticatedAddress: req.user.address,
        role: req.user.role,
      });
    });

    const response = await request(app)
      .get(`/api/wallet/${wallet.address}`)
      .set('Authorization', `Bearer ${loginResponse.jwt}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      address: wallet.address,
      authenticatedAddress: wallet.address,
      role: 'wallet',
    });
  });
});
