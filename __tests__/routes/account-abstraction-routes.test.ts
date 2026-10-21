/**
 * Smoke tests for server/routes/account-abstraction-routes.ts
 * Issue #356 — wallet-auth + account-abstraction routes have zero test coverage
 *
 * All jest.mock factories are self-contained (no external variable refs) to
 * avoid TDZ errors caused by the top-level import triggering module loading
 * during jest.mock hoisting.
 */
import { describe, it, expect, jest, beforeEach } from '@jest/globals';

// ── Self-contained mock factories ──────────────────────────────────────────
jest.mock('../../server/middleware/auth', () => ({
  authenticateJWT: jest.fn((_req: any, _res: any, next: any) => next()),
}));

jest.mock('../../server/controllers/accountAbstractionController', () => ({
  default: {
    createWallet: jest.fn(),
    getWallet: jest.fn(),
    createOperation: jest.fn(),
    getOperation: jest.fn(),
    signOperation: jest.fn(),
    executeOperation: jest.fn(),
    createBundle: jest.fn(),
    executeBundle: jest.fn(),
    createSponsor: jest.fn(),
    getSponsor: jest.fn(),
    estimateGas: jest.fn(),
    createRecoveryRequest: jest.fn(),
    approveRecoveryRequest: jest.fn(),
    completeRecovery: jest.fn(),
  },
}));

jest.mock('../../server/utils/cryptoUtils', () => ({
  verifySignature: jest.fn(),
}));

jest.mock('../../server/storage', () => ({
  storage: {
    getWalletByAddress: jest.fn(),
    createDelegation: jest.fn(),
    createMetaTransaction: jest.fn(),
    createSponsoredTransaction: jest.fn(),
  },
  default: {
    storage: {
      getWalletByAddress: jest.fn(),
      createDelegation: jest.fn(),
      createMetaTransaction: jest.fn(),
      createSponsoredTransaction: jest.fn(),
    },
  },
}));

jest.mock('../../server/utils/id-generator', () => ({
  generateId: jest.fn().mockReturnValue('test-gen-id'),
}));

jest.mock('../../server/utils/logger', () => ({
  walletLogger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

jest.mock('@noble/secp256k1', () => ({
  getPublicKey: jest.fn(),
  sign: jest.fn(),
}));

jest.mock('../../server/auth/jwt-constants', () => ({
  JWT_ISSUER: 'wrfcoin',
  JWT_AUDIENCE: 'wrfcoin-api',
}));

jest.mock('../../server/auth/jwt-constants.js', () => ({
  JWT_ISSUER: 'wrfcoin',
  JWT_AUDIENCE: 'wrfcoin-api',
}));

// ── Helpers to get mock refs after module loads ────────────────────────────
function getController() {
  return (require('../../server/controllers/accountAbstractionController') as any).default;
}
function getStorage() {
  return (require('../../server/storage') as any).storage;
}
function getCryptoUtils() {
  return (require('../../server/utils/cryptoUtils') as any);
}

// ── Named export tests ────────────────────────────────────────────────────
describe('buildDelegationSigningPayload', () => {
  it('serialises delegation fields to JSON', () => {
    const { buildDelegationSigningPayload } = require('../../server/routes/account-abstraction-routes') as any;
    const delegation = {
      delegator: '0xAAA',
      delegatee: '0xBBB',
      permissions: ['read'],
      expiresAt: '2027-01-01T00:00:00Z',
    };
    const result = JSON.parse(buildDelegationSigningPayload(delegation));
    expect(result.delegator).toBe('0xAAA');
    expect(result.delegatee).toBe('0xBBB');
    expect(result.permissions).toEqual(['read']);
    expect(result.expiresAt).toBe('2027-01-01T00:00:00Z');
  });
});

describe('buildSponsoredTransactionSigningPayload', () => {
  it('includes operation fields and sponsorId', () => {
    const { buildSponsoredTransactionSigningPayload } = require('../../server/routes/account-abstraction-routes') as any;
    const op = { type: 'transfer', from: '0xAAA', to: '0xBBB', amount: 10, nonce: 1 };
    const result = JSON.parse(buildSponsoredTransactionSigningPayload(op, 'sponsor-1', 'gas sponsorship'));
    expect(result.type).toBe('transfer');
    expect(result.from).toBe('0xAAA');
    expect(result.sponsorId).toBe('sponsor-1');
    expect(result.reason).toBe('gas sponsorship');
  });

  it('uses empty string as default reason', () => {
    const { buildSponsoredTransactionSigningPayload } = require('../../server/routes/account-abstraction-routes') as any;
    const op = { type: 'transfer', from: '0xAAA', to: '0xBBB', amount: 5, nonce: 0 };
    const result = JSON.parse(buildSponsoredTransactionSigningPayload(op, 'sp'));
    expect(result.reason).toBe('');
  });
});

// ── Route handler tests via supertest ────────────────────────────────────
import express from 'express';
import request from 'supertest';

function buildApp() {
  const app = express();
  app.use(express.json());
  const routerMod = require('../../server/routes/account-abstraction-routes') as any;
  const router = routerMod.default ?? routerMod;
  app.use('/', router);
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /wallet', () => {
  it('returns 400 when userId is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/wallet').send({ publicKey: '0xpub' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required/i);
  });

  it('returns 400 when publicKey is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/wallet').send({ userId: 42 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Missing required/i);
  });

  it('returns 200 when controller creates wallet successfully', async () => {
    getController().createWallet.mockResolvedValueOnce({ success: true, walletId: 'w-1', address: '0xABC' });
    const app = buildApp();
    const res = await request(app).post('/wallet').send({ userId: 1, publicKey: '0xpubkey' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 400 when controller signals failure', async () => {
    getController().createWallet.mockResolvedValueOnce({ success: false, error: 'Invalid public key' });
    const app = buildApp();
    const res = await request(app).post('/wallet').send({ userId: 1, publicKey: 'bad' });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('GET /wallet/:address', () => {
  it('returns 200 when wallet is found', async () => {
    getController().getWallet.mockResolvedValueOnce({ success: true, address: '0xAAA' });
    const app = buildApp();
    const res = await request(app).get('/wallet/0xAAA');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it('returns 404 when wallet is not found', async () => {
    getController().getWallet.mockResolvedValueOnce({ success: false, error: 'Not found' });
    const app = buildApp();
    const res = await request(app).get('/wallet/0xMISSING');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('POST /operation', () => {
  it('returns 400 when walletId is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/operation').send({
      operationType: 'transfer', target: '0xT', value: 1, data: '', nonce: 0,
    });
    expect(res.status).toBe(400);
  });

  it('returns 400 when operationType is missing', async () => {
    const app = buildApp();
    const res = await request(app).post('/operation').send({
      walletId: 1, target: '0xT', value: 1, data: '', nonce: 0,
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /delegation', () => {
  it('returns 400 when delegation body is missing required fields', async () => {
    const app = buildApp();
    const res = await request(app).post('/delegation').send({
      delegation: { delegator: '0xAAA' }, // missing delegatee, permissions, expiresAt
      signature: '0xsig',
    });
    expect(res.status).toBe(400);
  });

  it('returns 404 when delegator wallet is not found', async () => {
    getStorage().getWalletByAddress.mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await request(app).post('/delegation').send({
      delegation: {
        delegator: '0xAAA',
        delegatee: '0xBBB',
        permissions: ['read'],
        expiresAt: '2027-01-01T00:00:00Z',
      },
      signature: '0xsig',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/delegator/i);
  });

  it('returns 400 when signature is invalid', async () => {
    getStorage().getWalletByAddress
      .mockResolvedValueOnce({ address: '0xAAA' }) // delegator
      .mockResolvedValueOnce({ address: '0xBBB' }); // delegatee
    getCryptoUtils().verifySignature.mockResolvedValueOnce(false);
    const app = buildApp();
    const res = await request(app).post('/delegation').send({
      delegation: {
        delegator: '0xAAA',
        delegatee: '0xBBB',
        permissions: ['read'],
        expiresAt: '2027-01-01T00:00:00Z',
      },
      signature: '0xbadsig',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/signature/i);
  });
});

describe('POST /meta-transaction', () => {
  it('returns 400 when operation is missing required fields', async () => {
    const app = buildApp();
    const res = await request(app).post('/meta-transaction').send({
      operation: { type: 'transfer' }, // missing from, to, amount, nonce
      signature: '0xsig',
      sponsorId: 'sp-1',
    });
    expect(res.status).toBe(400);
  });
});
