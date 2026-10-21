import express from 'express';
import request from 'supertest';

import {
  createDebugAccountSeedRouter,
  getSeededValidators,
  getSeededWalletBalance,
  resetDebugAccountSeedState,
} from '../server/debug-account-seeding.js';

function createTestApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(createDebugAccountSeedRouter());
  app.get('/api/wallet/:address', (req, res) => {
    const walletBalance = getSeededWalletBalance(req.params.address);
    res.json({
      success: true,
      data:
        walletBalance ?? {
          address: req.params.address,
          balance: '100 WRF',
          tokens: [],
          nfts: [],
        },
      timestamp: new Date().toISOString(),
    });
  });
  app.get('/api/validators', (_req, res) => {
    res.json({
      success: true,
      data: getSeededValidators(),
      timestamp: new Date().toISOString(),
    });
  });
  return app;
}

describe('POST /debug/seed-account', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousOperatorToken = process.env.WRFCOIN_OPERATOR_TOKEN;

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    delete process.env.WRFCOIN_OPERATOR_TOKEN;
    resetDebugAccountSeedState();
  });

  afterEach(() => {
    resetDebugAccountSeedState();
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = previousNodeEnv;
    }

    if (previousOperatorToken === undefined) {
      delete process.env.WRFCOIN_OPERATOR_TOKEN;
    } else {
      process.env.WRFCOIN_OPERATOR_TOKEN = previousOperatorToken;
    }
  });

  it('rejects requests without the operator bearer token', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'dev-operator-token';
    const app = createTestApp();

    const response = await request(app).post('/debug/seed-account').send({
      address: '0x1111111111111111111111111111111111111111',
      amount: 250,
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHORIZED');
  });

  it('refuses the endpoint when NODE_ENV=production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.WRFCOIN_OPERATOR_TOKEN = 'prod-token';
    const app = createTestApp();

    const response = await request(app)
      .post('/debug/seed-account')
      .set('Authorization', 'Bearer prod-token')
      .send({
        address: '0x1111111111111111111111111111111111111111',
        amount: 250,
      });

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('NOT_FOUND');
  });

  it('requires an explicit operator token configuration', async () => {
    const app = createTestApp();

    const response = await request(app)
      .post('/debug/seed-account')
      .set('Authorization', 'Bearer missing-server-config')
      .send({
        address: '0x1111111111111111111111111111111111111111',
        amount: 250,
      });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('DEBUG_SEED_ACCOUNT_DISABLED');
  });

  it('seeds funded and pre-staked state that is visible through wallet and validator reads', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'dev-operator-token';
    const app = createTestApp();
    const address = '0x1111111111111111111111111111111111111111';

    const walletBeforeSeed = await request(app).get(`/api/wallet/${address}`);
    expect(walletBeforeSeed.status).toBe(200);
    expect(walletBeforeSeed.body.data.balance).toBe('100 WRF');

    const firstSeed = await request(app)
      .post('/debug/seed-account')
      .set('Authorization', 'Bearer dev-operator-token')
      .send({
        address,
        amount: 250,
        stakeAmount: 100,
      });

    expect(firstSeed.status).toBe(200);
    expect(firstSeed.body).toEqual({
      status: 'success',
      address,
      amount: 250,
      stakeAmount: 100,
      validatorSeeded: true,
    });

    const secondSeed = await request(app)
      .post('/debug/seed-account')
      .set('Authorization', 'Bearer dev-operator-token')
      .send({
        address,
        amount: 250,
        stakeAmount: 100,
      });

    expect(secondSeed.status).toBe(200);

    const walletResponse = await request(app).get(`/api/wallet/${address}`);
    expect(walletResponse.status).toBe(200);
    expect(walletResponse.body.data).toEqual({
      address,
      balance: '250 WRF',
      tokens: [],
      nfts: [],
    });

    const validatorsResponse = await request(app).get('/api/validators');
    expect(validatorsResponse.status).toBe(200);
    expect(
      validatorsResponse.body.data.filter(
        (validator: { address: string }) => validator.address === address,
      ),
    ).toHaveLength(1);
    expect(validatorsResponse.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          address,
          stake: 100,
          commission: 5,
          isActive: true,
        }),
      ]),
    );
  });

  it('rejects invalid seed payloads', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'dev-operator-token';
    const app = createTestApp();

    const response = await request(app)
      .post('/debug/seed-account')
      .set('Authorization', 'Bearer dev-operator-token')
      .send({
        address: 'not-an-address',
        amount: -1,
      });

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('INVALID_SEED_ACCOUNT_REQUEST');
  });

  it('is idempotent and updates an existing seeded address in place', async () => {
    process.env.WRFCOIN_OPERATOR_TOKEN = 'dev-operator-token';
    const app = createTestApp();
    const address = '0x2222222222222222222222222222222222222222';

    await request(app)
      .post('/debug/seed-account')
      .set('Authorization', 'Bearer dev-operator-token')
      .send({
        address,
        amount: 50,
        stakeAmount: 10,
      });

    const secondResponse = await request(app)
      .post('/debug/seed-account')
      .set('Authorization', 'Bearer dev-operator-token')
      .send({
        address,
        amount: 75,
        stakeAmount: 25,
      });

    expect(secondResponse.status).toBe(200);
    expect(secondResponse.body).toEqual({
      status: 'success',
      address,
      amount: 75,
      stakeAmount: 25,
      validatorSeeded: true,
    });

    const walletResponse = await request(app).get(`/api/wallet/${address}`);
    expect(walletResponse.body.data.balance).toBe('75 WRF');

    const validatorsResponse = await request(app).get('/api/validators');
    expect(validatorsResponse.body.data).toEqual([
      {
        address,
        stake: 25,
        commission: 5,
        uptime: 99.9,
        blocksProposed: 0,
        slashingEvents: 0,
        delegators: 0,
        isActive: true,
      },
    ]);
  });
});
