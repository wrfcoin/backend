import { describe, it, expect, beforeEach } from '@jest/globals';
import request from 'supertest';
import express from 'express';
import { walletRoutes } from '../../../microservices/user-management-service/src/routes/wallet-routes.js';

describe('Wallet Controller', () => {
  let app: express.Application;
  const validAddress = '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234';

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/wallet', walletRoutes);
  });

  describe('GET /api/wallet/:address', () => {
    it('returns wallet balance data for a valid wallet address', async () => {
      const response = await request(app)
        .get(`/api/wallet/${validAddress}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toMatchObject({
        address: validAddress,
        balance: '125.4589 WRF',
        stakingRewards: '12.45 WRF',
        weatherRewards: '8.92 WRF',
      });
      expect(response.body.data.tokens).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ token: 'WRF', balance: '125.4589' }),
        ])
      );
      expect(response.body).toHaveProperty('timestamp');
    });

    it('rejects malformed wallet addresses with a 400 error', async () => {
      const response = await request(app)
        .get('/api/wallet/not-a-wallet')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatchObject({
        code: 'INVALID_ADDRESS',
        message: 'Invalid address format',
      });
    });
  });

  describe('GET /api/wallet/:address/transactions', () => {
    it('rejects malformed wallet addresses with a 400 error', async () => {
      const response = await request(app)
        .get('/api/wallet/not-a-wallet/transactions')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatchObject({
        code: 'INVALID_ADDRESS',
        message: 'Invalid address format',
      });
    });

    it('normalizes pagination bounds for transaction history', async () => {
      const response = await request(app)
        .get(`/api/wallet/${validAddress}/transactions?page=0&limit=999`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.pagination).toMatchObject({
        page: 1,
        limit: 100,
        total: 150,
        totalPages: 2,
        hasNext: true,
        hasPrev: false,
      });
      expect(response.body.data.data).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            from: validAddress,
            token: 'WRF',
            status: 'confirmed',
          }),
        ])
      );
    });

    it('falls back to default pagination when query params are not numeric', async () => {
      const response = await request(app)
        .get(`/api/wallet/${validAddress}/transactions?page=abc&limit=xyz`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data.pagination).toMatchObject({
        page: 1,
        limit: 20,
        total: 150,
        totalPages: 8,
        hasNext: true,
        hasPrev: false,
      });
    });
  });

  describe('POST /api/wallet/send', () => {
    it('rejects requests that omit required parameters', async () => {
      const response = await request(app)
        .post('/api/wallet/send')
        .send({ amount: 10 })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatchObject({
        code: 'MISSING_PARAMS',
        message: 'Missing required parameters: to, amount',
      });
    });

    it('rejects malformed recipient wallet addresses', async () => {
      const response = await request(app)
        .post('/api/wallet/send')
        .send({
          to: 'not-a-wallet',
          amount: 5,
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatchObject({
        code: 'INVALID_ADDRESS',
        message: 'Invalid address format',
      });
    });

    it('rejects nonpositive and nonnumeric transaction amounts', async () => {
      const invalidAmounts = [0, -1, 'abc'];

      for (const amount of invalidAmounts) {
        const response = await request(app)
          .post('/api/wallet/send')
          .send({
            to: validAddress,
            amount,
          })
          .expect(400);

        expect(response.body.success).toBe(false);
        expect(response.body.error).toMatchObject({
          code: 'INVALID_AMOUNT',
          message: 'Amount must be greater than 0',
        });
      }
    });

    it('returns a pending transaction payload for a valid send request', async () => {
      const response = await request(app)
        .post('/api/wallet/send')
        .send({
          to: validAddress,
          amount: 10.5,
          token: 'USDC',
          memo: 'launch test',
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toMatchObject({
        to: validAddress,
        amount: '10.5',
        token: 'USDC',
        status: 'pending',
        fee: '0.001',
        memo: 'launch test',
      });
      expect(response.body.data.hash).toMatch(/^0x/);
    });

    it('defaults send requests to WRF when token is omitted', async () => {
      const response = await request(app)
        .post('/api/wallet/send')
        .send({
          to: validAddress,
          amount: 3,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.data).toMatchObject({
        to: validAddress,
        amount: '3',
        token: 'WRF',
        status: 'pending',
      });
    });
  });
});
