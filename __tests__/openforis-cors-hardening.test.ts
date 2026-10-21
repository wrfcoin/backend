import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';

describe('OpenForis CORS hardening', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  function createResponse() {
    return {
      statusCode: 200,
      headers: {} as Record<string, string>,
      body: undefined as any,
      header(name: string, value: string) {
        this.headers[name] = value;
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
      end() {
        return this;
      },
    };
  }

  it('rejects disallowed preflight origins in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://app.wrfcoin.com';
    const OpenForisMiddleware = require('../server/openforis/middleware');

    const middleware = OpenForisMiddleware.cors();
    const req = {
      method: 'OPTIONS',
      headers: {
        origin: 'https://evil.example',
      },
    };
    const res = createResponse();
    const next = jest.fn();

    middleware(req, res as any, next);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.code).toBe('OPENFORIS_CORS_ORIGIN_DENIED');
  });

  it('allows configured production origins and echoes the exact origin', () => {
    process.env.NODE_ENV = 'production';
    process.env.CORS_ORIGIN = 'https://app.wrfcoin.com';
    const OpenForisMiddleware = require('../server/openforis/middleware');

    const middleware = OpenForisMiddleware.cors();
    const req = {
      method: 'GET',
      headers: {
        origin: 'https://app.wrfcoin.com',
      },
    };
    const res = createResponse();
    const next = jest.fn();

    middleware(req, res as any, next);

    expect(next).toHaveBeenCalledTimes(1);
    expect(res.headers['Access-Control-Allow-Origin']).toBe(
      'https://app.wrfcoin.com'
    );
    expect(res.headers.Vary).toBe('Origin');
  });
});
