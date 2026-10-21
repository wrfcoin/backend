/**
 * Tests for ApiKeyAuthMiddleware HTTP status code correctness (issue #662).
 *
 * RFC 7235 semantics:
 *   401 — credentials missing or invalid (re-authenticate)
 *   403 — credentials valid but access denied (permission / scope)
 */

import { Request, Response, NextFunction } from 'express';

// ─── mocks ──────────────────────────────────────────────────────────────────

const mockValidateApiKey = jest.fn();
const mockRecordUsage = jest.fn().mockResolvedValue(undefined);

jest.mock('../services/api-key-service.js', () => ({
  ApiKeyService: jest.fn().mockImplementation(() => ({
    validateApiKey: mockValidateApiKey,
    recordUsage: mockRecordUsage,
  })),
}));

jest.mock('../server/utils/logger.js', () => ({
  securityLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
  appLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock('../shared/schema-api-keys.js', () => ({
  API_PERMISSIONS: { ADMIN: 'admin', READ: 'read', WRITE: 'write' },
}));

// ─── helpers ─────────────────────────────────────────────────────────────────

function makeReq(apiKey?: string): Partial<Request> {
  return {
    get: jest.fn((header: string) => {
      if (header === 'X-API-Key') return apiKey ?? null;
      return null;
    }),
    path: '/test',
    method: 'GET',
    socket: { remoteAddress: '127.0.0.1' } as unknown as import('net').Socket,
  };
}

function makeRes(): { res: Partial<Response>; statusCode: () => number; body: () => unknown } {
  let _status = 200;
  let _body: unknown;
  const json = jest.fn((b) => { _body = b; });
  const status = jest.fn((code: number) => { _status = code; return { json } as unknown as Response; });
  const set = jest.fn().mockReturnThis();
  const res = { status, json, set, locals: {} } as unknown as Partial<Response>;
  return { res, statusCode: () => _status, body: () => _body };
}

const VALID_KEY_RESULT = {
  isValid: true,
  apiKey: {
    id: 'key-123',
    permissions: ['read', 'write'],
    scopes: ['weather:read', 'carbon:write'],
  },
  rateLimited: false,
  remainingQuota: { daily: 1000, monthly: 10000 },
};

// ─── import SUT after mocks are registered ───────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ApiKeyAuthMiddleware } = require('../middleware/api-key-auth.js') as typeof import('../middleware/api-key-auth');

// ─── tests ───────────────────────────────────────────────────────────────────

describe('ApiKeyAuthMiddleware — 401 paths (unauthenticated)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 401 when API key header is missing', async () => {
    const middleware = new ApiKeyAuthMiddleware();
    const { res, statusCode } = makeRes();
    const req = makeReq(/* no key */);
    const next = jest.fn();

    await middleware.authenticate({ required: true })(
      req as Request,
      res as Response,
      next as NextFunction
    );

    expect(statusCode()).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 when API key is invalid', async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      isValid: false,
      error: 'Key not found',
      apiKey: null,
      rateLimited: false,
    });

    const middleware = new ApiKeyAuthMiddleware();
    const { res, statusCode } = makeRes();
    const next = jest.fn();

    await middleware.authenticate({ required: true })(
      makeReq('bad-key') as Request,
      res as Response,
      next as NextFunction
    );

    expect(statusCode()).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 401 on internal authentication error', async () => {
    mockValidateApiKey.mockRejectedValueOnce(new Error('DB unavailable'));

    const middleware = new ApiKeyAuthMiddleware();
    const { res, statusCode } = makeRes();
    const next = jest.fn();

    await middleware.authenticate({ required: true })(
      makeReq('any-key') as Request,
      res as Response,
      next as NextFunction
    );

    expect(statusCode()).toBe(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('ApiKeyAuthMiddleware — 403 paths (authorized but forbidden)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns 403 when key is valid but lacks the required permission', async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      ...VALID_KEY_RESULT,
      apiKey: { ...VALID_KEY_RESULT.apiKey, permissions: ['read'] }, // no 'admin'
    });

    const middleware = new ApiKeyAuthMiddleware();
    const { res, statusCode, body } = makeRes();
    const next = jest.fn();

    await middleware.authenticate({ required: true, permissions: ['admin'] })(
      makeReq('good-key') as Request,
      res as Response,
      next as NextFunction
    );

    expect(statusCode()).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect((body() as Record<string, unknown>)?.error).toMatch(/Insufficient Permissions/i);
  });

  it('returns 403 when key is valid but lacks the required scope', async () => {
    mockValidateApiKey.mockResolvedValueOnce({
      ...VALID_KEY_RESULT,
      apiKey: { ...VALID_KEY_RESULT.apiKey, scopes: ['weather:read'] }, // no 'carbon:write'
    });

    const middleware = new ApiKeyAuthMiddleware();
    const { res, statusCode, body } = makeRes();
    const next = jest.fn();

    await middleware.authenticate({ required: true, scopes: ['carbon:write'] })(
      makeReq('good-key') as Request,
      res as Response,
      next as NextFunction
    );

    expect(statusCode()).toBe(403);
    expect(next).not.toHaveBeenCalled();
    expect((body() as Record<string, unknown>)?.error).toMatch(/Insufficient Scope/i);
  });

  it('distinguishes 403 from 401 — same error string but different code', async () => {
    // Sanity: ensure the two bad-credentials cases still get 401
    mockValidateApiKey.mockResolvedValueOnce({
      isValid: false,
      error: 'Revoked',
      apiKey: null,
      rateLimited: false,
    });

    const middleware = new ApiKeyAuthMiddleware();
    const { res: res401, statusCode: sc401 } = makeRes();
    await middleware.authenticate({ required: true })(
      makeReq('revoked-key') as Request,
      res401 as Response,
      jest.fn() as NextFunction
    );

    // And permissions failure gets 403
    mockValidateApiKey.mockResolvedValueOnce({
      ...VALID_KEY_RESULT,
      apiKey: { ...VALID_KEY_RESULT.apiKey, permissions: [] },
    });
    const { res: res403, statusCode: sc403 } = makeRes();
    await middleware.authenticate({ required: true, permissions: ['write'] })(
      makeReq('good-key') as Request,
      res403 as Response,
      jest.fn() as NextFunction
    );

    expect(sc401()).toBe(401);
    expect(sc403()).toBe(403);
  });
});

describe('ApiKeyAuthMiddleware — success path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls next() and does NOT set a 4xx status when key is valid with sufficient permissions', async () => {
    mockValidateApiKey.mockResolvedValueOnce(VALID_KEY_RESULT);

    const middleware = new ApiKeyAuthMiddleware();
    const { res, statusCode } = makeRes();
    const next = jest.fn();

    await middleware.authenticate({ required: true, permissions: ['read'] })(
      makeReq('good-key') as Request,
      res as Response,
      next as NextFunction
    );

    expect(next).toHaveBeenCalledTimes(1);
    // status() should not have been called with a 4xx code
    const statusSpy = (res as { status: jest.Mock }).status;
    const calledWith4xx = statusSpy.mock.calls.some(([code]: [number]) => code >= 400);
    expect(calledWith4xx).toBe(false);
  });

  it('calls next() when key is valid with sufficient scope', async () => {
    mockValidateApiKey.mockResolvedValueOnce(VALID_KEY_RESULT);

    const middleware = new ApiKeyAuthMiddleware();
    const { res } = makeRes();
    const next = jest.fn();

    await middleware.authenticate({ required: true, scopes: ['weather:read'] })(
      makeReq('good-key') as Request,
      res as Response,
      next as NextFunction
    );

    expect(next).toHaveBeenCalledTimes(1);
  });
});
