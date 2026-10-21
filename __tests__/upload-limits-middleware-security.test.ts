import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockRedis = {
  get: jest.fn(),
  setex: jest.fn(),
  incr: jest.fn(),
  expire: jest.fn(),
  del: jest.fn(),
};

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => mockRedis);
});

jest.mock('../database/db', () => ({
  db: {
    select: jest.fn(),
  },
}));

jest.mock('../utils/logger', () => ({
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

import { uploadLimitsMiddleware } from '../src/middleware/uploadLimitsMiddleware.js';
import { ROLES } from '../shared/rbac.js';

describe('uploadLimitsMiddleware fail-closed behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('denies upload when daily-count check is unavailable', async () => {
    (mockRedis.get as any).mockRejectedValueOnce(new Error('redis unavailable'));

    const req = {
      user: { userId: 101, role: ROLES.USER },
      headers: { 'content-length': '1024' },
    } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      on: jest.fn(),
    } as any;
    const next = jest.fn();

    await uploadLimitsMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UPLOAD_LIMIT_CHECK_UNAVAILABLE',
      })
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('denies upload when storage-quota check is unavailable', async () => {
    (mockRedis.get as any)
      .mockResolvedValueOnce('0')
      .mockRejectedValueOnce(new Error('redis unavailable'));

    const req = {
      user: { userId: 102, role: ROLES.USER },
      headers: { 'content-length': '2048' },
    } as any;
    const res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      on: jest.fn(),
    } as any;
    const next = jest.fn();

    await uploadLimitsMiddleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'UPLOAD_LIMIT_CHECK_UNAVAILABLE',
      })
    );
    expect(next).not.toHaveBeenCalled();
  });
});
