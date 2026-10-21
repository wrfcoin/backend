import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import jwt from 'jsonwebtoken';
import { JWT_AUDIENCE, JWT_ISSUER } from '../../server/auth/jwt-constants';

const mockSelectLimit = jest.fn();
const mockSelectWhere = jest.fn(() => ({ limit: mockSelectLimit }));
const mockSelectFrom = jest.fn(() => ({ where: mockSelectWhere }));
const mockSelect = jest.fn(() => ({ from: mockSelectFrom }));

const mockInsertValues = jest.fn();
const mockInsert = jest.fn(() => ({ values: mockInsertValues }));

const mockUpdateWhere = jest.fn();
const mockUpdateSet = jest.fn(() => ({ where: mockUpdateWhere }));
const mockUpdate = jest.fn(() => ({ set: mockUpdateSet }));

const mockRecordReferralFunnelStep = jest.fn();
const mockAppLoggerError = jest.fn();

jest.mock('../../database/connection.js', () => ({
  db: {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  },
}));

// auth-middleware.ts (wallet JWT verification, used unmocked) also exports
// API-key auth; its service pulls the DB schema, which the drizzle mock below
// cannot satisfy. authenticateToken does not use it.
jest.mock('../../server/services/api-key-service.js', () => ({ apiKeyService: {} }));

jest.mock('drizzle-orm', () => ({
  eq: jest.fn((_left: unknown, _right: unknown) => ({ type: 'eq' })),
  and: jest.fn((...conditions: unknown[]) => ({ type: 'and', conditions })),
}));

jest.mock('../../shared/schema-engagement.js', () => ({
  referrals: {
    referralCode: 'referralCode',
    referrerAddress: 'referrerAddress',
    refereeAddress: 'refereeAddress',
    status: 'status',
  },
  REFERRAL_STATUS: {
    PENDING: 'pending',
    ACTIVATED: 'activated',
    REWARDED: 'rewarded',
  },
}));

jest.mock('../../server/utils/metrics.js', () => ({
  recordReferralFunnelStep: mockRecordReferralFunnelStep,
}));

jest.mock('../../server/utils/logger.js', () => ({
  appLogger: {
    error: mockAppLoggerError,
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

import router from '../../server/routes/referral-routes.ts';

// backend#1178: mutators need a wallet login token (same claims as
// wallet-auth-service issueTokens) for the wallet the request acts for.
function bearer(address: string): string {
  const token = jwt.sign(
    { sub: address, address, role: 'wallet', type: 'access' },
    process.env.JWT_SECRET as string,
    { algorithm: 'HS256', issuer: JWT_ISSUER, audience: JWT_AUDIENCE, expiresIn: 600 },
  );
  return `Bearer ${token}`;
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/referrals', router);
  return app;
}

describe('POST /api/referrals/generate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectLimit.mockReset();
    mockInsertValues.mockReset();
    mockUpdateWhere.mockReset();
  });

  it('returns a canonical 400 envelope when walletAddress is missing', async () => {
    const res = await request(makeApp()).post('/api/referrals/generate')
      .set('Authorization', bearer('0xabc')).send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'MISSING_WALLET_ADDRESS',
      message: 'walletAddress required',
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('returns a generic canonical 500 envelope and suppresses raw generate errors', async () => {
    mockSelectLimit.mockResolvedValueOnce([]);
    mockInsertValues.mockRejectedValueOnce(new Error('insert exploded'));

    const res = await request(makeApp())
      .post('/api/referrals/generate')
      .set('Authorization', bearer('0xabc'))
      .send({ walletAddress: '0xabc' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'REFERRAL_CODE_GENERATION_FAILED',
      message: 'Failed to generate referral code',
    });
    expect(typeof res.body.timestamp).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('insert exploded');
    expect(mockAppLoggerError).toHaveBeenCalledWith(
      'Referral code generation failed',
      {
        error: 'insert exploded',
      },
    );
  });
});

describe('POST /api/referrals/activate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSelectLimit.mockReset();
    mockInsertValues.mockReset();
    mockUpdateWhere.mockReset();
  });

  it('returns a canonical 400 envelope when required fields are missing', async () => {
    const res = await request(makeApp()).post('/api/referrals/activate')
      .set('Authorization', bearer('0xreferee')).send({});

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'MISSING_REFERRAL_ACTIVATION_FIELDS',
      message: 'referralCode and refereeAddress required',
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('returns a canonical 404 envelope when the referral code is not pending', async () => {
    mockSelectLimit.mockResolvedValueOnce([]);

    const res = await request(makeApp())
      .post('/api/referrals/activate')
      .set('Authorization', bearer('0xreferee'))
      .send({ referralCode: 'ABC123', refereeAddress: '0xreferee' });

    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'REFERRAL_CODE_NOT_FOUND_OR_ACTIVATED',
      message: 'Referral code not found or already activated',
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('returns a canonical 400 envelope for self-referrals', async () => {
    mockSelectLimit.mockResolvedValueOnce([{ referrerAddress: '0xsame' }]);

    const res = await request(makeApp())
      .post('/api/referrals/activate')
      .set('Authorization', bearer('0xsame'))
      .send({ referralCode: 'ABC123', refereeAddress: '0xsame' });

    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'SELF_REFERRAL_NOT_ALLOWED',
      message: 'Self-referral not allowed',
    });
    expect(typeof res.body.timestamp).toBe('string');
  });

  it('returns a generic canonical 500 envelope and suppresses raw errors', async () => {
    mockSelectLimit.mockRejectedValueOnce(new Error('database exploded'));

    const res = await request(makeApp())
      .post('/api/referrals/activate')
      .set('Authorization', bearer('0xreferee'))
      .send({ referralCode: 'ABC123', refereeAddress: '0xreferee' });

    expect(res.status).toBe(500);
    expect(res.body.success).toBe(false);
    expect(res.body.error).toMatchObject({
      code: 'REFERRAL_ACTIVATION_FAILED',
      message: 'Failed to activate referral code',
    });
    expect(typeof res.body.timestamp).toBe('string');
    expect(JSON.stringify(res.body)).not.toContain('database exploded');
    expect(mockAppLoggerError).toHaveBeenCalledWith('Referral activation failed', {
      error: 'database exploded',
    });
  });
});
