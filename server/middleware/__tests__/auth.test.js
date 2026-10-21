/**
 * Comprehensive unit tests for authentication middleware
 * Tests cover all authentication scenarios and edge cases
 */

// Mock the logger before importing the auth module
const mockLogger = {
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
};

jest.mock('../../../utils/logger', () => ({
  createLogger: jest.fn(() => mockLogger),
}));

const auth = require('../auth');
const { createLogger } = require('../../../utils/logger');

describe('Authentication Middleware', () => {
  let req, res, next;

  beforeEach(() => {
    req = {
      path: '/api/test',
      method: 'GET',
      get: jest.fn(),
      headers: {},
    };

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
      send: jest.fn(),
    };

    next = jest.fn();

    // Reset all mocks
    jest.clearAllMocks();
  });

  describe('authenticateApiRequest', () => {
    test('should call next() to proceed with request', () => {
      auth.authenticateApiRequest(req, res, next);

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
    });

    test('should log debug info when API key is present', () => {
      const apiKey = 'test-api-key-12345678';
      req.get.mockReturnValue(apiKey);

      auth.authenticateApiRequest(req, res, next);

      expect(req.get).toHaveBeenCalledWith('X-API-Key');
      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Request authenticated with API key',
        {
          path: '/api/test',
          method: 'GET',
          key: 'test...5678',
        }
      );
      expect(next).toHaveBeenCalled();
    });

    test('should log debug info when no API key is present', () => {
      req.get.mockReturnValue(null);

      auth.authenticateApiRequest(req, res, next);

      expect(req.get).toHaveBeenCalledWith('X-API-Key');
      expect(mockLogger.debug).toHaveBeenCalledWith('Request without API key', {
        path: '/api/test',
        method: 'GET',
      });
      expect(next).toHaveBeenCalled();
    });

    test('should handle undefined API key gracefully', () => {
      req.get.mockReturnValue(undefined);

      auth.authenticateApiRequest(req, res, next);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Request without API key',
        expect.any(Object)
      );
      expect(next).toHaveBeenCalled();
    });

    test('should handle empty string API key', () => {
      req.get.mockReturnValue('');

      auth.authenticateApiRequest(req, res, next);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Request without API key',
        expect.any(Object)
      );
      expect(next).toHaveBeenCalled();
    });

    test('should handle very short API key correctly', () => {
      const shortKey = 'abc';
      req.get.mockReturnValue(shortKey);

      auth.authenticateApiRequest(req, res, next);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Request authenticated with API key',
        expect.objectContaining({
          key: expect.stringContaining('abc'),
        })
      );
      expect(next).toHaveBeenCalled();
    });

    test('should handle exactly 8 character API key', () => {
      const eightCharKey = 'abcd1234';
      req.get.mockReturnValue(eightCharKey);

      auth.authenticateApiRequest(req, res, next);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Request authenticated with API key',
        expect.objectContaining({
          key: 'abcd...1234',
        })
      );
      expect(next).toHaveBeenCalled();
    });

    test('should handle very long API key correctly', () => {
      const longKey = 'a'.repeat(100);
      req.get.mockReturnValue(longKey);

      auth.authenticateApiRequest(req, res, next);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Request authenticated with API key',
        expect.objectContaining({
          key: 'aaaa...aaaa',
        })
      );
      expect(next).toHaveBeenCalled();
    });

    test('should work with different HTTP methods', () => {
      const methods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];

      methods.forEach(method => {
        req.method = method;
        req.path = `/api/${method.toLowerCase()}`;

        auth.authenticateApiRequest(req, res, next);

        expect(mockLogger.debug).toHaveBeenCalledWith(
          'Request without API key',
          expect.objectContaining({
            method: method,
            path: `/api/${method.toLowerCase()}`,
          })
        );
      });

      expect(next).toHaveBeenCalledTimes(methods.length);
    });

    test('should work with different API paths', () => {
      const paths = [
        '/api/weather',
        '/api/transactions',
        '/api/blocks',
        '/health',
        '/metrics',
      ];

      paths.forEach(path => {
        req.path = path;

        auth.authenticateApiRequest(req, res, next);

        expect(mockLogger.debug).toHaveBeenCalledWith(
          'Request without API key',
          expect.objectContaining({
            path: path,
          })
        );
      });

      expect(next).toHaveBeenCalledTimes(paths.length);
    });

    test('should not modify request or response objects', () => {
      const originalReq = { ...req };
      const originalRes = { ...res };

      auth.authenticateApiRequest(req, res, next);

      // Check that no new properties were added to req or res
      expect(Object.keys(req)).toEqual(Object.keys(originalReq));
      expect(Object.keys(res)).toEqual(Object.keys(originalRes));
    });

    test('should handle null request gracefully', () => {
      expect(() => {
        auth.authenticateApiRequest(null, res, next);
      }).toThrow();
    });

    test('should handle missing req.get method', () => {
      delete req.get;

      expect(() => {
        auth.authenticateApiRequest(req, res, next);
      }).toThrow();
    });
  });

  describe('module exports', () => {
    test('should export authenticateApiRequest function', () => {
      expect(auth).toHaveProperty('authenticateApiRequest');
      expect(typeof auth.authenticateApiRequest).toBe('function');
    });

    test('should not export any other functions', () => {
      const exportedKeys = Object.keys(auth);
      expect(exportedKeys).toEqual(['authenticateApiRequest']);
    });
  });

  describe('integration scenarios', () => {
    test('should work in Express middleware chain', () => {
      const middlewareChain = [
        (req, res, next) => {
          req.user = { id: 1 };
          next();
        },
        auth.authenticateApiRequest,
        (req, res, next) => {
          res.json({ message: 'success' });
        },
      ];

      // Simulate middleware chain execution
      let currentIndex = 0;
      const executeNext = () => {
        if (currentIndex < middlewareChain.length) {
          const middleware = middlewareChain[currentIndex++];
          middleware(req, res, executeNext);
        }
      };

      executeNext();

      expect(req.user).toEqual({ id: 1 });
      expect(res.json).toHaveBeenCalledWith({ message: 'success' });
    });

    test('should handle concurrent requests correctly', async () => {
      const requests = Array(10)
        .fill()
        .map((_, index) => ({
          path: `/api/request-${index}`,
          method: 'GET',
          get: jest.fn().mockReturnValue(`key-${index}`),
        }));

      const responses = requests.map(() => ({
        status: jest.fn().mockReturnThis(),
        json: jest.fn(),
      }));

      const nexts = requests.map(() => jest.fn());

      // Execute all middleware calls concurrently
      requests.forEach((req, index) => {
        auth.authenticateApiRequest(req, responses[index], nexts[index]);
      });

      // All should complete successfully
      nexts.forEach(next => {
        expect(next).toHaveBeenCalledTimes(1);
      });

      expect(mockLogger.debug).toHaveBeenCalledTimes(10);
    });

    test('should preserve original request information', () => {
      req.originalUrl = '/api/test?param=value';
      req.ip = '127.0.0.1';
      req.userAgent = 'test-client';

      auth.authenticateApiRequest(req, res, next);

      expect(req.originalUrl).toBe('/api/test?param=value');
      expect(req.ip).toBe('127.0.0.1');
      expect(req.userAgent).toBe('test-client');
    });
  });

  describe('security considerations', () => {
    test('should mask API key in logs for security', () => {
      const sensitiveKey = 'sk-1234567890abcdef1234567890abcdef';
      req.get.mockReturnValue(sensitiveKey);

      auth.authenticateApiRequest(req, res, next);

      expect(mockLogger.debug).toHaveBeenCalledWith(
        'Request authenticated with API key',
        expect.objectContaining({
          key: 'sk-1...cdef',
        })
      );

      // Ensure the full key is not logged
      const logCall = mockLogger.debug.mock.calls[0];
      expect(JSON.stringify(logCall)).not.toContain(sensitiveKey);
    });

    test('should handle malicious API key input safely', () => {
      const maliciousKeys = [
        '<script>alert("xss")</script>',
        '"; DROP TABLE users; --',
        '../../etc/passwd',
        '\x00\x01\x02',
      ];

      maliciousKeys.forEach(key => {
        req.get.mockReturnValue(key);

        expect(() => {
          auth.authenticateApiRequest(req, res, next);
        }).not.toThrow();

        expect(next).toHaveBeenCalled();
        next.mockClear();
      });
    });

    test('should not expose sensitive information in logs', () => {
      req.password = 'secret123';
      req.token = 'bearer-token-secret';

      auth.authenticateApiRequest(req, res, next);

      const logCalls = mockLogger.debug.mock.calls;
      const allLogData = JSON.stringify(logCalls);

      expect(allLogData).not.toContain('secret123');
      expect(allLogData).not.toContain('bearer-token-secret');
    });
  });

  describe('performance', () => {
    test('should execute quickly for single request', () => {
      const startTime = Date.now();

      auth.authenticateApiRequest(req, res, next);

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(10); // Should complete within 10ms
    });

    test('should handle high volume of requests efficiently', () => {
      const startTime = Date.now();

      for (let i = 0; i < 1000; i++) {
        auth.authenticateApiRequest(req, res, next);
      }

      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(100); // 1000 requests in under 100ms
    });
  });
});
