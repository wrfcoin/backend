import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const fakeDb = {
  select: jest.fn(() => fakeDb),
  from: jest.fn(() => fakeDb),
  where: jest.fn(() => fakeDb),
  limit: jest.fn(async () => []),
  insert: jest.fn(() => fakeDb),
  values: jest.fn(async () => undefined),
  update: jest.fn(() => fakeDb),
  set: jest.fn(() => fakeDb),
  delete: jest.fn(() => fakeDb),
  orderBy: jest.fn(() => fakeDb),
};

jest.mock('drizzle-orm/postgres-js', () => ({
  drizzle: jest.fn(() => fakeDb),
}));

jest.mock('postgres', () => jest.fn(() => ({})));

jest.mock('../../server/auth/jwt-constants.js', () => ({
  JWT_ISSUER: 'wrfcoin',
  JWT_AUDIENCE: 'wrfcoin-api',
}));

jest.mock('../../server/utils/logger.js', () => ({
  securityLogger: {
    error: jest.fn(),
  },
}));

jest.mock('../../shared/schema.js', () => ({
  securityEvents: {},
  users: {
    id: 'id',
    email: 'email',
  },
}));

import { passwordResetService } from '../../server/services/password-reset-service.js';

describe('password reset error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns a token-not-found result for a missing reset token', async () => {
    const result = await passwordResetService.validateAndConsume({
      token: 'missing-token',
    });

    expect(result).toEqual({
      valid: false,
      error: 'Invalid or expired reset token',
      errorCode: 'TOKEN_NOT_FOUND',
    });
  });

  afterAll(() => {
    passwordResetService.stopCleanupTimer();
  });
});
