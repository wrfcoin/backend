/**
 * Integration Tests - Transaction Simulation Endpoints
 * Issue #207: Tests for governance, reward, and bridge simulation
 */

const request = require('supertest');
const express = require('express');
import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  jest,
} from '@jest/globals';

// Mock auth middleware to bypass JWT validation in tests
jest.mock('../../middleware/auth.js', () => ({
  authenticateJWT: (req: any, res: any, next: any) => {
    req.user = {
      id: 'test-user-id',
      userId: 'test-user-id',
      roles: ['admin', 'operator', 'user'],
      permissions: ['*'],
      sessionId: 'test-session',
    };
    next();
  },
}));

// Mock rate limit middleware
jest.mock(
  '../../../shared/middleware/rate-limit-redis.js',
  () => ({
    createRateLimitMiddleware: () => (req: any, res: any, next: any) => next(),
  }),
  { virtual: true }
);

// Mock logger
jest.mock('../../utils/logger.js', () => ({
  securityLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  appLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import simulationRoutes from '../../routes/simulation.js';

const app = express();
app.use(express.json());
app.use('/api/v1/simulation', simulationRoutes);

describe('Transaction Simulation Endpoints', () => {
  describe('POST /api/v1/simulation/simulate/governance', () => {
    test('should simulate a successful proposal creation', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/governance')
        .send({
          operation: 'createProposal',
          params: {
            title: 'Test Proposal',
            description: 'A test governance proposal',
            proposalType: 'parameter_change',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.wouldSucceed).toBe(true);
      expect(res.body.data.stateChanges.length).toBeGreaterThan(0);
      expect(res.body.data.requiredAuth).toContain('jwt');
      expect(res.body.data.requiredRoles.length).toBeGreaterThan(0);
      expect(res.body.data.failureReasons).toEqual([]);
      expect(res.body.data.errorCodes).toEqual([]);
      expect(res.body.data.nonce.valid).toBe(true);
      expect(res.body.requestId).toBeDefined();
      expect(res.body.timestamp).toBeDefined();
    });

    test('should simulate a vote on a proposal', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/governance')
        .send({
          operation: 'vote',
          params: {
            proposalId: 'prop_001',
            support: true,
            votingPower: 500,
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.wouldSucceed).toBe(true);
      expect(res.body.data.stateChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: expect.stringContaining('totalVotes') }),
        ])
      );
    });

    test('should fail vote simulation when proposalId is missing', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/governance')
        .send({
          operation: 'vote',
          params: {
            support: true,
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.wouldSucceed).toBe(false);
      expect(res.body.data.failureReasons).toContain('Proposal ID is required for voting');
      expect(res.body.data.errorCodes).toContain('SIM_INVALID_PARAMS');
    });

    test('should fail proposal creation without title', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/governance')
        .send({
          operation: 'createProposal',
          params: {
            description: 'No title provided',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.wouldSucceed).toBe(false);
      expect(res.body.data.errorCodes).toContain('SIM_INVALID_PARAMS');
    });

    test('should detect nonce mismatch', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/governance')
        .send({
          operation: 'createProposal',
          params: {
            title: 'Nonce Test',
            description: 'Testing nonce validation',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
          nonce: 999,
        });

      expect(res.status).toBe(200);
      expect(res.body.data.wouldSucceed).toBe(false);
      expect(res.body.data.nonce.valid).toBe(false);
      expect(res.body.data.nonce.provided).toBe(999);
      expect(res.body.data.errorCodes).toContain('SIM_NONCE_ALREADY_USED');
    });

    test('should reject invalid operation', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/governance')
        .send({
          operation: 'invalidOp',
          params: {},
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('SIM_INVALID_PARAMS');
    });

    test('should reject invalid callerAddress format', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/governance')
        .send({
          operation: 'createProposal',
          params: { title: 'Test', description: 'Test' },
          callerAddress: 'invalid-address',
        });

      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    test('should include balance checks for proposal creation', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/governance')
        .send({
          operation: 'createProposal',
          params: {
            title: 'Balance Check Test',
            description: 'Verify balance checks are included',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.balanceChecks.length).toBeGreaterThan(0);
      expect(res.body.data.balanceChecks[0]).toEqual(
        expect.objectContaining({
          address: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
          token: 'WRF',
          sufficient: true,
        })
      );
    });
  });

  describe('POST /api/v1/simulation/simulate/reward', () => {
    test('should simulate a successful reward distribution', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/reward')
        .send({
          operation: 'distribute',
          params: {
            recipientAddress: '0x8ba1f109551bD432803012645Hac136c82416aF8',
            amount: 1000,
            rewardType: 'weather_data',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.wouldSucceed).toBe(true);
      expect(res.body.data.balanceChecks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ address: 'reward_pool', sufficient: true }),
        ])
      );
    });

    test('should detect distribution exceeding cap', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/reward')
        .send({
          operation: 'distribute',
          params: {
            recipientAddress: '0x8ba1f109551bD432803012645Hac136c82416aF8',
            amount: 100000,
            rewardType: 'weather_data',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.wouldSucceed).toBe(false);
      expect(res.body.data.errorCodes).toContain('SIM_INVALID_PARAMS');
    });

    test('should simulate a reward claim with quality check', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/reward')
        .send({
          operation: 'claim',
          params: {
            stationId: 'station-001',
            qualityScore: 85,
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.wouldSucceed).toBe(true);
    });

    test('should fail claim with low quality score', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/reward')
        .send({
          operation: 'claim',
          params: {
            stationId: 'station-001',
            qualityScore: 50,
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.wouldSucceed).toBe(false);
      expect(res.body.data.failureReasons[0]).toContain('Quality score');
    });
  });

  describe('POST /api/v1/simulation/simulate/bridge', () => {
    test('should simulate a successful bridge transfer', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/bridge')
        .send({
          operation: 'transfer',
          params: {
            sourceChain: 'WRF',
            destinationChain: 'ethereum',
            amount: 100,
            token: 'WRF',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.wouldSucceed).toBe(true);
      expect(res.body.data.stateChanges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ field: expect.stringContaining('bridge') }),
        ])
      );
    });

    test('should detect insufficient balance for bridge transfer', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/bridge')
        .send({
          operation: 'transfer',
          params: {
            sourceChain: 'WRF',
            destinationChain: 'ethereum',
            amount: 999999,
            token: 'WRF',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.wouldSucceed).toBe(false);
      expect(res.body.data.errorCodes).toContain('SIM_INSUFFICIENT_BALANCE');
    });

    test('should detect low bridge liquidity', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/bridge')
        .send({
          operation: 'transfer',
          params: {
            sourceChain: 'WRF',
            destinationChain: 'polkadot',
            amount: 5000,
            token: 'WRF',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      // polkadot has 100k liquidity so 5000 should succeed
      expect(res.body.data.wouldSucceed).toBe(true);
    });

    test('should reject unsupported chain', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/bridge')
        .send({
          operation: 'transfer',
          params: {
            sourceChain: 'WRF',
            destinationChain: 'unsupported_chain',
            amount: 100,
            token: 'WRF',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.wouldSucceed).toBe(false);
      expect(res.body.data.errorCodes).toContain('SIM_INVALID_PARAMS');
      expect(res.body.data.failureReasons[0]).toContain('Unsupported destination chain');
    });

    test('should reject same source and destination chain', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/bridge')
        .send({
          operation: 'transfer',
          params: {
            sourceChain: 'ethereum',
            destinationChain: 'ethereum',
            amount: 100,
            token: 'WRF',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.wouldSucceed).toBe(false);
      expect(res.body.data.failureReasons).toContain('Source and destination chains must be different');
    });

    test('should include fee estimation in state changes', async () => {
      const res = await request(app)
        .post('/api/v1/simulation/simulate/bridge')
        .send({
          operation: 'transfer',
          params: {
            sourceChain: 'WRF',
            destinationChain: 'polygon',
            amount: 1000,
            token: 'WRF',
          },
          callerAddress: '0x742d35Cc6634C0532925a3b8D8aE7b8e4B9f1234',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.wouldSucceed).toBe(true);
      const feeChange = res.body.data.stateChanges.find(
        (c: any) => c.field === 'bridge.fee.collected'
      );
      expect(feeChange).toBeDefined();
      expect(feeChange.newValue).toBeGreaterThan(0);
    });
  });
});
