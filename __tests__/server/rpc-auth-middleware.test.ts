import { afterAll, beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockLogAuthSuccess = jest.fn();
const mockLogAuthFailure = jest.fn();
const mockLogApiKeyUsage = jest.fn();

const mockLogger = {
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  metrics: {
    recordHttpRequest: jest.fn(),
  },
  security: {
    suspicious: jest.fn(),
  },
};

jest.mock('express-rate-limit', () => jest.fn(() => jest.fn((_req, _res, next) => next())));

jest.mock('../../server/middleware/authLogging', () => ({
  logAuthSuccess: mockLogAuthSuccess,
  logAuthFailure: mockLogAuthFailure,
  logApiKeyUsage: mockLogApiKeyUsage,
}));

jest.mock('../../server/utils/logger', () => ({
  logger: mockLogger,
}));

function makeReq(
  headers: Record<string, string> = {},
  originalUrl = '/api/rpc',
) {
  return {
    headers,
    method: 'POST',
    originalUrl,
    ip: '127.0.0.1',
    connection: {
      remoteAddress: '127.0.0.1',
    },
    body: {},
  } as any;
}

function makeRes() {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn(),
    send: jest.fn(),
  } as any;
}

function expectCanonicalApiError(
  res: ReturnType<typeof makeRes>,
  code: string,
  message: string,
) {
  expect(res.json).toHaveBeenCalledWith({
    success: false,
    error: {
      code,
      message,
      details: undefined,
    },
    timestamp: expect.any(String),
  });
}

function loadRpcAuthMiddleware() {
  let loadedModule: any;

  jest.isolateModules(() => {
    loadedModule = require('../../server/middleware/rpcAuthMiddleware');
  });

  return loadedModule;
}

const originalRpcApiKey = process.env.RPC_API_KEY;
const originalAdminToken = process.env.ADMIN_TOKEN;

describe('rpcAuthMiddleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    delete process.env.RPC_API_KEY;
    delete process.env.ADMIN_TOKEN;
  });

  afterAll(() => {
    if (originalRpcApiKey === undefined) {
      delete process.env.RPC_API_KEY;
    } else {
      process.env.RPC_API_KEY = originalRpcApiKey;
    }

    if (originalAdminToken === undefined) {
      delete process.env.ADMIN_TOKEN;
    } else {
      process.env.ADMIN_TOKEN = originalAdminToken;
    }
  });

  it('allows valid RPC API keys', () => {
    process.env.RPC_API_KEY = 'expected-token';

    const { verifyRpcApiKey } = loadRpcAuthMiddleware();
    const req = makeReq({ 'x-api-key': 'expected-token' });
    const res = makeRes();
    const next = jest.fn();

    verifyRpcApiKey(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(mockLogApiKeyUsage).toHaveBeenCalledTimes(1);
    expect(mockLogAuthSuccess).toHaveBeenCalledTimes(1);
  });

  it('rejects prefix matches for RPC API keys', () => {
    process.env.RPC_API_KEY = 'expected-token';

    const { verifyRpcApiKey } = loadRpcAuthMiddleware();
    const req = makeReq({ 'x-api-key': 'expected' });
    const res = makeRes();
    const next = jest.fn();

    verifyRpcApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expectCanonicalApiError(res, 'INVALID_API_KEY', 'Invalid API key');
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects empty RPC API keys', () => {
    process.env.RPC_API_KEY = 'expected-token';

    const { verifyRpcApiKey } = loadRpcAuthMiddleware();
    const req = makeReq({ 'x-api-key': '' });
    const res = makeRes();
    const next = jest.fn();

    verifyRpcApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expectCanonicalApiError(
      res,
      'MISSING_API_KEY',
      'API key is required for RPC endpoints',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects same-start RPC API keys with the wrong length', () => {
    process.env.RPC_API_KEY = 'expected-token';

    const { verifyRpcApiKey } = loadRpcAuthMiddleware();
    const req = makeReq({ 'x-api-key': 'expected-token-extra' });
    const res = makeRes();
    const next = jest.fn();

    verifyRpcApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expectCanonicalApiError(res, 'INVALID_API_KEY', 'Invalid API key');
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed for RPC requests when RPC_API_KEY is missing', () => {
    const { verifyRpcApiKey } = loadRpcAuthMiddleware();
    const req = makeReq({ 'x-api-key': 'expected-token' });
    const res = makeRes();
    const next = jest.fn();

    verifyRpcApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expectCanonicalApiError(
      res,
      'RPC_AUTH_NOT_CONFIGURED',
      'RPC authentication is not configured on this server',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed for node-control requests when ADMIN_TOKEN is missing', () => {
    process.env.RPC_API_KEY = 'expected-token';

    const { verifyNodeControlAuth } = loadRpcAuthMiddleware();
    const req = makeReq(
      {
        'x-api-key': 'expected-token',
        'x-admin-token': 'admin-secret',
      },
      '/api/node-control/status',
    );
    const res = makeRes();
    const next = jest.fn();

    verifyNodeControlAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expectCanonicalApiError(
      res,
      'NODE_CONTROL_AUTH_NOT_CONFIGURED',
      'Node control authentication is not configured on this server',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('allows valid node-control credentials', () => {
    process.env.RPC_API_KEY = 'expected-token';
    process.env.ADMIN_TOKEN = 'admin-secret';

    const { verifyNodeControlAuth } = loadRpcAuthMiddleware();
    const req = makeReq(
      {
        'x-api-key': 'expected-token',
        'x-admin-token': 'admin-secret',
      },
      '/api/node-control/status',
    );
    const res = makeRes();
    const next = jest.fn();

    verifyNodeControlAuth(req, res, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(mockLogAuthSuccess).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid node-control admin tokens', () => {
    process.env.RPC_API_KEY = 'expected-token';
    process.env.ADMIN_TOKEN = 'admin-secret';

    const { verifyNodeControlAuth } = loadRpcAuthMiddleware();
    const req = makeReq(
      {
        'x-api-key': 'expected-token',
        'x-admin-token': 'admin-secret-extra',
      },
      '/api/node-control/status',
    );
    const res = makeRes();
    const next = jest.fn();

    verifyNodeControlAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expectCanonicalApiError(res, 'INVALID_CREDENTIALS', 'Invalid credentials');
    expect(next).not.toHaveBeenCalled();
  });

  it('secureCompare rejects equal-length mismatches regardless of mismatch position', () => {
    const { secureCompare } = loadRpcAuthMiddleware();

    expect(secureCompare('abc12345', 'zbc12345')).toBe(false);
    expect(secureCompare('abc12345', 'abc1234z')).toBe(false);
    expect(secureCompare('abc12345', 'abc12345')).toBe(true);
  });

  it('fails closed when RPC_API_KEY is set to the historical dev fallback', () => {
    process.env.RPC_API_KEY = 'dev-rpc-api-key';

    const { verifyRpcApiKey } = loadRpcAuthMiddleware();
    const req = makeReq({ 'x-api-key': 'dev-rpc-api-key' });
    const res = makeRes();
    const next = jest.fn();

    verifyRpcApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expectCanonicalApiError(
      res,
      'RPC_AUTH_NOT_CONFIGURED',
      'RPC authentication is not configured on this server',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when ADMIN_TOKEN is set to the historical dev fallback', () => {
    process.env.RPC_API_KEY = 'expected-token';
    process.env.ADMIN_TOKEN = 'dev-admin-token';

    const { verifyNodeControlAuth } = loadRpcAuthMiddleware();
    const req = makeReq(
      {
        'x-api-key': 'expected-token',
        'x-admin-token': 'dev-admin-token',
      },
      '/api/node-control/status',
    );
    const res = makeRes();
    const next = jest.fn();

    verifyNodeControlAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expectCanonicalApiError(
      res,
      'NODE_CONTROL_AUTH_NOT_CONFIGURED',
      'Node control authentication is not configured on this server',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('fails closed when a placeholder REPLACE_* value leaks from .env.example', () => {
    process.env.RPC_API_KEY = 'REPLACE_with_strong_secret';

    const { verifyRpcApiKey } = loadRpcAuthMiddleware();
    const req = makeReq({ 'x-api-key': 'REPLACE_with_strong_secret' });
    const res = makeRes();
    const next = jest.fn();

    verifyRpcApiKey(req, res, next);

    expect(res.status).toHaveBeenCalledWith(503);
    expectCanonicalApiError(
      res,
      'RPC_AUTH_NOT_CONFIGURED',
      'RPC authentication is not configured on this server',
    );
    expect(next).not.toHaveBeenCalled();
  });
});
