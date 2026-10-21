import express from 'express';
import request from 'supertest';
import { Wallet } from 'ethers';
import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const mockStorage = {
  getWalletByAddress: jest.fn(),
  createDelegation: jest.fn(),
  getDelegationById: jest.fn(),
};

const mockController = {
  getSponsor: jest.fn(),
};

jest.mock('../../server/middleware/auth', () => ({
  authenticateJWT: (req: any, res: any, next: () => void) => {
    if (req.get('authorization') === 'Bearer account-abstraction-test-token') {
      req.user = { id: 'aa-tester' };
      next();
      return;
    }

    res.status(401).json({
      success: false,
      error: {
        code: 'NO_TOKEN',
        message: 'Access token is required',
      },
    });
  },
}));

jest.mock('../../server/controllers/accountAbstractionController.ts', () => ({
  __esModule: true,
  default: mockController,
}));
jest.mock('../../server/storage', () => ({ storage: mockStorage }));
jest.mock('../../server/storage.ts', () => ({ storage: mockStorage }));
jest.mock('../../server/utils/id-generator', () => ({
  generateId: jest.fn(() => 'dlg_test_001'),
}));
jest.mock('../../server/utils/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  walletLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('../../server/utils/logger.js', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  walletLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('@noble/secp256k1', () => ({
  verify: jest.fn(() => true),
}));

import router, {
  buildDelegationSigningPayload,
  buildSponsoredTransactionSigningPayload,
} from '../../server/routes/account-abstraction-routes.ts';

describe('account abstraction security hardening', () => {
  const app = express();
  app.use(express.json());
  app.use('/api', router);

  function authorized(req: request.Test) {
    return req.set('Authorization', 'Bearer account-abstraction-test-token');
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockStorage.getWalletByAddress.mockImplementation(async (address: string) => ({
      address,
    }));
    mockStorage.createDelegation.mockImplementation(async (payload: any) => ({
      id: 1,
      ...payload,
    }));
    mockController.getSponsor.mockResolvedValue({
      success: true,
      data: {
        maxAllowance: 100,
      },
    });
  });

  it('rejects delegation creation when the wallet signature is invalid', async () => {
    const delegator = Wallet.createRandom();
    const delegatee = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const delegation = {
      delegator: delegator.address,
      delegatee: delegatee.address,
      permissions: ['transfer'],
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
    const signature = await attacker.signMessage(
      buildDelegationSigningPayload(delegation)
    );

    const res = await authorized(request(app).post('/api/delegation')).send({
      delegation,
      signature,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid signature');
    expect(mockStorage.createDelegation).not.toHaveBeenCalled();
  });

  it('accepts delegation creation when the delegator signs the canonical payload', async () => {
    const delegator = Wallet.createRandom();
    const delegatee = Wallet.createRandom();
    const delegation = {
      delegator: delegator.address,
      delegatee: delegatee.address,
      permissions: ['transfer', 'stake'],
      expiresAt: '2030-01-01T00:00:00.000Z',
    };
    const signature = await delegator.signMessage(
      buildDelegationSigningPayload(delegation)
    );

    const res = await authorized(request(app).post('/api/delegation')).send({
      delegation,
      signature,
    });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(mockStorage.createDelegation).toHaveBeenCalledWith(
      expect.objectContaining({
        delegationId: 'dlg_test_001',
        delegator: delegator.address,
        delegatee: delegatee.address,
        signature,
      })
    );
  });

  it('rejects sponsored transactions with an invalid sponsor authorization signature', async () => {
    const sender = Wallet.createRandom();
    const attacker = Wallet.createRandom();
    const recipient = Wallet.createRandom();
    const sponsorId = 'sponsor-123';
    const reason = 'gasless onboarding';
    const operation = {
      type: 'TRANSFER',
      from: sender.address,
      to: recipient.address,
      target: recipient.address,
      value: 5,
      amount: 5,
      data: '0x',
      nonce: 7,
    };
    const signature = await attacker.signMessage(
      buildSponsoredTransactionSigningPayload(operation, sponsorId, reason)
    );

    const res = await authorized(
      request(app).post('/api/sponsored-transaction')
    ).send({
      operation,
      signature,
      sponsorId,
      reason,
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid sponsor authorization signature');
  });
});
