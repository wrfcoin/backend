import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

const ORIGINAL_ENV = { ...process.env };

function createResponse() {
  return {
    headers: {} as Record<string, string>,
    statusCode: 200,
    body: undefined as any,
    set(values: Record<string, string>) {
      this.headers = { ...this.headers, ...values };
      return this;
    },
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

describe('communication middleware', () => {
  let middleware: any;

  beforeEach(() => {
    process.env = {
      ...ORIGINAL_ENV,
      NODE_ENV: 'test',
      API_VERSION: '1.0.0-test',
      SILENT_LOGS: 'true',
      DISABLE_FILE_LOG_TRANSPORTS: 'true',
    };

    jest.resetModules();
    jest.doMock('../server/utils/logger.js', () => ({
      appLogger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
      },
    }));

    middleware = require('../shared/middleware/communication-middleware.ts');
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    jest.clearAllMocks();
    jest.resetModules();
  });

  it('attaches request metadata and propagates request headers', () => {
    const req: any = {
      headers: {
        'x-transaction-id': 'tx-fixed-123',
        'x-client-id': 'client-9',
        'user-agent': 'lane3-test',
      },
      ip: '203.0.113.7',
      user: { id: 'user-1', roles: ['validator'] },
    };
    const res = createResponse();
    const next = jest.fn();

    middleware.requestContextMiddleware(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(req.metadata).toMatchObject({
      transactionId: 'tx-fixed-123',
      userId: 'user-1',
      userRole: 'validator',
      clientId: 'client-9',
      ipAddress: '203.0.113.7',
    });
    expect(typeof req.metadata.requestId).toBe('string');
    expect(res.headers['x-request-id']).toBe(req.metadata.requestId);
    expect(res.headers['x-transaction-id']).toBe('tx-fixed-123');
  });

  it('maps UnauthorizedError into standardized auth error response', () => {
    const req: any = {
      metadata: { requestId: 'req-42' },
      originalUrl: '/api/private',
      method: 'GET',
      user: { id: 'user-2' },
    };
    const res = createResponse();
    const next = jest.fn();
    const error = new Error('bad token');
    error.name = 'UnauthorizedError';

    middleware.errorHandlerMiddleware(error, req, res, next);

    expect(res.statusCode).toBe(401);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    expect(res.body.error.message).toBe('Authentication required');
    expect(res.body.requestId).toBe('req-42');
  });
});
