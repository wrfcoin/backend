import { describe, it, expect, beforeEach, jest } from '@jest/globals';

jest.mock('../server/utils/dbSecurityUtils', () => ({
  sanitizeInput: jest.fn((value: unknown) => ({ sanitized: value })),
  isValidTableName: jest.fn(() => true),
  isValidColumnName: jest.fn(() => true),
}));
jest.mock('../server/utils/logger', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

const {
  sanitizeDbInput,
  preventExcessiveDatabaseLoad,
} = require('../server/middleware/dbSecurityMiddleware.js');
const DbSecurityUtils = require('../server/utils/dbSecurityUtils');

function createResponse() {
  return {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
}

describe('dbSecurityMiddleware fast-paths', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('skips sanitization for health and metrics routes', () => {
    const req = {
      path: '/metrics/enhanced',
      method: 'POST',
      body: { query: '<script>alert(1)</script>' },
      query: { limit: '999', offset: '-1' },
      params: { id: '123' },
    };
    const res = createResponse();
    const next = jest.fn();

    sanitizeDbInput(req as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(DbSecurityUtils.sanitizeInput).not.toHaveBeenCalled();
    expect(req.body).toEqual({ query: '<script>alert(1)</script>' });
    expect(req.query).toEqual({ limit: '999', offset: '-1' });
    expect(req.params).toEqual({ id: '123' });
  });

  it('still sanitizes and normalizes user-facing db requests', () => {
    const req = {
      path: '/wallet',
      method: 'POST',
      body: { note: '<b>hi</b>' },
      query: { limit: '500', offset: '-10' },
      params: { id: '7' },
    };
    const res = createResponse();
    const next = jest.fn();

    sanitizeDbInput(req as never, res as never, next);

    expect(DbSecurityUtils.sanitizeInput).toHaveBeenCalledTimes(3);
    expect(req.body).toEqual({ sanitized: { note: '<b>hi</b>' } });
    expect(req.query).toEqual({ sanitized: { limit: '500', offset: '-10' } });
  });

  it('still clamps pagination on normal database requests', () => {
    const req = {
      path: '/wallet',
      method: 'GET',
      query: { limit: '500', offset: '-10' },
    };
    const res = createResponse();
    const next = jest.fn();

    preventExcessiveDatabaseLoad(req as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.query.limit).toBe(100);
    expect(req.query.offset).toBe(0);
  });

  it('skips database load limiting for metrics routes', () => {
    const req = {
      path: '/metrics/cache',
      method: 'GET',
      query: { limit: '999', offset: '-5' },
    };
    const res = createResponse();
    const next = jest.fn();

    preventExcessiveDatabaseLoad(req as never, res as never, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.query).toEqual({ limit: '999', offset: '-5' });
  });
});
