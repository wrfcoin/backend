/**
 * OpenForis API Middleware
 *
 * Express middleware for OpenForis API validation and error handling
 */

const {
  createProjectValidation,
  createPlotValidation,
  timeSeriesAnalysisValidation,
  climateProjectionValidation,
} = require('./validation-schemas');
const {
  resolveAllowedOrigins,
  isOriginAllowed,
  assertNoWildcardOrigins,
} = require('../utils/strict-cors-config');

const OpenForisErrorHandler = require('./error-handler');

/**
 * Middleware factory for OpenForis API validation
 */
class OpenForisMiddleware {
  /**
   * Create project validation middleware
   */
  static validateCreateProject() {
    return [
      ...createProjectValidation,
      OpenForisErrorHandler.handleValidationErrors,
    ];
  }

  /**
   * Create plot validation middleware
   */
  static validateCreatePlot() {
    return [
      ...createPlotValidation,
      OpenForisErrorHandler.handleValidationErrors,
    ];
  }

  /**
   * Time series analysis validation middleware
   */
  static validateTimeSeriesAnalysis() {
    return [
      ...timeSeriesAnalysisValidation,
      OpenForisErrorHandler.handleValidationErrors,
    ];
  }

  /**
   * Climate projection validation middleware
   */
  static validateClimateProjection() {
    return [
      ...climateProjectionValidation,
      OpenForisErrorHandler.handleValidationErrors,
    ];
  }

  /**
   * General OpenForis API error handling middleware
   */
  static errorHandler() {
    return OpenForisErrorHandler.handleApiErrors;
  }

  /**
   * Rate limiting middleware for OpenForis API calls
   */
  static rateLimit(options = {}) {
    const {
      windowMs = 15 * 60 * 1000, // 15 minutes
      max = 100, // limit each IP to 100 requests per windowMs
      message = 'Too many OpenForis API requests, please try again later.',
    } = options;

    const requests = new Map();

    return (req, res, next) => {
      const ip = req.ip || req.connection.remoteAddress;
      const now = Date.now();
      const windowStart = now - windowMs;

      // Clean up old entries
      for (const [key, timestamps] of requests.entries()) {
        const filtered = timestamps.filter(time => time > windowStart);
        if (filtered.length === 0) {
          requests.delete(key);
        } else {
          requests.set(key, filtered);
        }
      }

      // Check current IP
      const ipRequests = requests.get(ip) || [];
      const recentRequests = ipRequests.filter(time => time > windowStart);

      if (recentRequests.length >= max) {
        return res.status(429).json({
          success: false,
          error: 'Rate limit exceeded',
          code: 'RATE_LIMIT_EXCEEDED',
          message,
          retryAfter: Math.ceil(windowMs / 1000),
          timestamp: new Date().toISOString(),
        });
      }

      // Add current request
      recentRequests.push(now);
      requests.set(ip, recentRequests);

      next();
    };
  }

  /**
   * Request logging middleware for OpenForis API calls
   */
  static requestLogger() {
    const createLogger = require('../utils/logger');
    const logger = createLogger('openforis:middleware');

    return (req, res, next) => {
      const startTime = Date.now();

      // Log request
      logger.info('OpenForis API request started', {
        method: req.method,
        path: req.path,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        timestamp: new Date().toISOString(),
      });

      // Override res.json to log response
      const originalJson = res.json;
      res.json = function (data) {
        const duration = Date.now() - startTime;

        logger.info('OpenForis API request completed', {
          method: req.method,
          path: req.path,
          statusCode: res.statusCode,
          duration,
          success: res.statusCode < 400,
          timestamp: new Date().toISOString(),
        });

        return originalJson.call(this, data);
      };

      next();
    };
  }

  /**
   * Authentication middleware for OpenForis API
   */
  static requireAuth() {
    return (req, res, next) => {
      const apiKey = req.headers.authorization?.replace('Bearer ', '');

      if (!apiKey) {
        return res.status(401).json({
          success: false,
          error: 'Authentication required',
          code: 'AUTHENTICATION_REQUIRED',
          message: 'OpenForis API requests require authentication.',
          timestamp: new Date().toISOString(),
        });
      }

      try {
        const { validateApiKey } = require('./validation-schemas');
        validateApiKey(apiKey);

        // Store API key for later use
        req.openforisApiKey = apiKey;
        next();
      } catch (error) {
        return res.status(401).json({
          success: false,
          error: 'Invalid API key',
          code: 'INVALID_API_KEY',
          message: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    };
  }

  /**
   * CORS middleware specifically for OpenForis API endpoints
   */
  static cors() {
    return (req, res, next) => {
      const nodeEnv = process.env.NODE_ENV || 'development';
      const origin = req.headers.origin;
      const allowedOrigins = resolveAllowedOrigins({
        nodeEnv,
        requireExplicitOriginsInProduction: true,
      });

      assertNoWildcardOrigins(allowedOrigins);

      const originAllowed = isOriginAllowed(origin, allowedOrigins, { nodeEnv });

      if (originAllowed && origin) {
        res.header('Access-Control-Allow-Origin', origin);
        res.header('Vary', 'Origin');
      }
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Requested-With'
      );
      res.header('Access-Control-Allow-Credentials', 'true');
      res.header('Access-Control-Max-Age', '86400');

      if (req.method === 'OPTIONS') {
        if (originAllowed || !origin) {
          return res.status(200).end();
        }
        return res.status(403).json({
          success: false,
          error: 'Origin not allowed by CORS policy',
          code: 'OPENFORIS_CORS_ORIGIN_DENIED',
          timestamp: new Date().toISOString(),
        });
      }

      if (origin && !originAllowed) {
        return res.status(403).json({
          success: false,
          error: 'Origin not allowed by CORS policy',
          code: 'OPENFORIS_CORS_ORIGIN_DENIED',
          timestamp: new Date().toISOString(),
        });
      }

      next();
    };
  }

  /**
   * Response caching middleware for OpenForis API
   */
  static cache(options = {}) {
    const {
      maxAge = 5 * 60, // 5 minutes default
      skipIf = null,
    } = options;

    const cache = new Map();

    return (req, res, next) => {
      // Skip caching for POST, PUT, DELETE requests
      if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
        return next();
      }

      // Skip caching if custom condition is met
      if (skipIf && skipIf(req)) {
        return next();
      }

      const cacheKey = `${req.method}:${req.path}:${JSON.stringify(req.query)}`;
      const cached = cache.get(cacheKey);

      if (cached && Date.now() - cached.timestamp < maxAge * 1000) {
        res.header('X-Cache', 'HIT');
        res.header('Cache-Control', `public, max-age=${maxAge}`);
        return res.json(cached.data);
      }

      // Override res.json to cache response
      const originalJson = res.json;
      res.json = function (data) {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          cache.set(cacheKey, {
            data,
            timestamp: Date.now(),
          });

          // Clean up old cache entries
          const cutoff = Date.now() - maxAge * 1000 * 2;
          for (const [key, value] of cache.entries()) {
            if (value.timestamp < cutoff) {
              cache.delete(key);
            }
          }
        }

        res.header('X-Cache', 'MISS');
        res.header('Cache-Control', `public, max-age=${maxAge}`);
        return originalJson.call(this, data);
      };

      next();
    };
  }

  /**
   * Input sanitization middleware for OpenForis API requests
   */
  static sanitizeInput() {
    return (req, res, next) => {
      const createLogger = require('../utils/logger');
      const logger = createLogger('openforis:sanitization');

      try {
        // Recursively sanitize object properties
        const sanitizeObject = (obj, path = '') => {
          if (!obj || typeof obj !== 'object') {
            return obj;
          }

          if (Array.isArray(obj)) {
            return obj.map((item, index) =>
              sanitizeObject(item, `${path}[${index}]`)
            );
          }

          const sanitized = {};
          for (const [key, value] of Object.entries(obj)) {
            const currentPath = path ? `${path}.${key}` : key;

            if (typeof value === 'string') {
              // Remove potentially dangerous patterns
              const sanitizedValue = value
                .replace(/<script[^>]*>.*?<\/script>/gi, '') // Remove script tags
                .replace(/javascript:/gi, '') // Remove javascript: protocols
                .replace(/vbscript:/gi, '') // Remove vbscript: protocols
                .replace(/on\w+\s*=/gi, '') // Remove event handlers
                .replace(/eval\s*\(/gi, '') // Remove eval calls
                .replace(/expression\s*\(/gi, '') // Remove CSS expressions
                .trim();

              // Check for suspicious patterns in production
              if (process.env.NODE_ENV === 'production') {
                const suspiciousPatterns = [
                  /union\s+select/i,
                  /drop\s+table/i,
                  /insert\s+into/i,
                  /delete\s+from/i,
                  /'.*?or.*?'.*?='/i,
                  /\.\.\//g,
                  /%2e%2e%2f/gi,
                ];

                const foundPattern = suspiciousPatterns.find(pattern =>
                  pattern.test(value)
                );
                if (foundPattern) {
                  logger.warn('Suspicious pattern detected in input', {
                    path: currentPath,
                    pattern: foundPattern.toString(),
                    originalLength: value.length,
                    sanitizedLength: sanitizedValue.length,
                    ip: req.ip,
                    userAgent: req.get('User-Agent'),
                  });
                }
              }

              sanitized[key] = sanitizedValue;
            } else if (typeof value === 'object' && value !== null) {
              sanitized[key] = sanitizeObject(value, currentPath);
            } else {
              sanitized[key] = value;
            }
          }
          return sanitized;
        };

        // Sanitize request body
        if (req.body && typeof req.body === 'object') {
          const originalBody = JSON.stringify(req.body);
          req.body = sanitizeObject(req.body, 'body');
          const sanitizedBody = JSON.stringify(req.body);

          if (originalBody !== sanitizedBody) {
            logger.info('Request body sanitized', {
              endpoint: req.path,
              method: req.method,
              originalSize: originalBody.length,
              sanitizedSize: sanitizedBody.length,
              ip: req.ip,
            });
          }
        }

        // Sanitize query parameters
        if (req.query && typeof req.query === 'object') {
          const originalQuery = JSON.stringify(req.query);
          req.query = sanitizeObject(req.query, 'query');
          const sanitizedQuery = JSON.stringify(req.query);

          if (originalQuery !== sanitizedQuery) {
            logger.info('Query parameters sanitized', {
              endpoint: req.path,
              method: req.method,
              originalSize: originalQuery.length,
              sanitizedSize: sanitizedQuery.length,
              ip: req.ip,
            });
          }
        }

        // Sanitize URL parameters
        if (req.params && typeof req.params === 'object') {
          const originalParams = JSON.stringify(req.params);
          req.params = sanitizeObject(req.params, 'params');
          const sanitizedParams = JSON.stringify(req.params);

          if (originalParams !== sanitizedParams) {
            logger.info('URL parameters sanitized', {
              endpoint: req.path,
              method: req.method,
              originalSize: originalParams.length,
              sanitizedSize: sanitizedParams.length,
              ip: req.ip,
            });
          }
        }

        next();
      } catch (error) {
        logger.error('Input sanitization failed', {
          error: error.message,
          endpoint: req.path,
          method: req.method,
          ip: req.ip,
        });

        res.status(400).json({
          success: false,
          error: 'Request data validation failed',
          code: 'INPUT_SANITIZATION_ERROR',
          message: 'Unable to process request data safely',
          timestamp: new Date().toISOString(),
        });
      }
    };
  }

  /**
   * Request size limiting middleware
   */
  static limitRequestSize(options = {}) {
    const {
      maxBodySize = 1024 * 1024, // 1MB default
      maxQueryParams = 50,
      maxParamLength = 1000,
    } = options;

    return (req, res, next) => {
      const createLogger = require('../utils/logger');
      const logger = createLogger('openforis:size-limit');

      try {
        // Check body size
        if (req.body) {
          const bodySize = JSON.stringify(req.body).length;
          if (bodySize > maxBodySize) {
            logger.warn('Request body size exceeded limit', {
              bodySize,
              maxBodySize,
              endpoint: req.path,
              method: req.method,
              ip: req.ip,
            });

            return res.status(413).json({
              success: false,
              error: 'Request body too large',
              code: 'BODY_SIZE_EXCEEDED',
              message: `Request body size (${bodySize} bytes) exceeds maximum allowed size (${maxBodySize} bytes)`,
              timestamp: new Date().toISOString(),
            });
          }
        }

        // Check query parameter count and size
        if (req.query) {
          const queryKeys = Object.keys(req.query);
          if (queryKeys.length > maxQueryParams) {
            logger.warn('Too many query parameters', {
              paramCount: queryKeys.length,
              maxQueryParams,
              endpoint: req.path,
              ip: req.ip,
            });

            return res.status(400).json({
              success: false,
              error: 'Too many query parameters',
              code: 'QUERY_PARAM_COUNT_EXCEEDED',
              message: `Number of query parameters (${queryKeys.length}) exceeds maximum allowed (${maxQueryParams})`,
              timestamp: new Date().toISOString(),
            });
          }

          // Check individual parameter length
          for (const [key, value] of Object.entries(req.query)) {
            const paramLength = String(value).length;
            if (paramLength > maxParamLength) {
              logger.warn('Query parameter too long', {
                paramName: key,
                paramLength,
                maxParamLength,
                endpoint: req.path,
                ip: req.ip,
              });

              return res.status(400).json({
                success: false,
                error: 'Query parameter too long',
                code: 'QUERY_PARAM_LENGTH_EXCEEDED',
                message: `Query parameter '${key}' length (${paramLength}) exceeds maximum allowed (${maxParamLength})`,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }

        next();
      } catch (error) {
        logger.error('Request size validation failed', {
          error: error.message,
          endpoint: req.path,
          method: req.method,
          ip: req.ip,
        });

        res.status(500).json({
          success: false,
          error: 'Request validation error',
          code: 'REQUEST_VALIDATION_ERROR',
          message: 'Unable to validate request size',
          timestamp: new Date().toISOString(),
        });
      }
    };
  }

  /**
   * Security headers middleware for OpenForis API responses
   */
  static securityHeaders() {
    return (req, res, next) => {
      // Set comprehensive security headers
      res.header('X-Content-Type-Options', 'nosniff');
      res.header('X-Frame-Options', 'DENY');
      res.header('X-XSS-Protection', '1; mode=block');
      res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
      res.header(
        'Permissions-Policy',
        'geolocation=(), microphone=(), camera=()'
      );

      // Set HSTS in production
      if (process.env.NODE_ENV === 'production') {
        res.header(
          'Strict-Transport-Security',
          'max-age=31536000; includeSubDomains; preload'
        );
      }

      // Remove potentially revealing headers
      res.removeHeader('X-Powered-By');
      res.removeHeader('Server');

      next();
    };
  }

  /**
   * Content type validation middleware
   */
  static validateContentType() {
    return (req, res, next) => {
      // Only validate for requests that should have a body
      if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
        const contentType = req.get('Content-Type');

        if (!contentType) {
          return res.status(400).json({
            success: false,
            error: 'Content-Type header required',
            code: 'MISSING_CONTENT_TYPE',
            message: 'Content-Type header is required for this request',
            timestamp: new Date().toISOString(),
          });
        }

        if (!contentType.includes('application/json')) {
          return res.status(415).json({
            success: false,
            error: 'Unsupported Media Type',
            code: 'UNSUPPORTED_CONTENT_TYPE',
            message: 'Only application/json content type is supported',
            acceptedTypes: ['application/json'],
            timestamp: new Date().toISOString(),
          });
        }
      }

      next();
    };
  }

  /**
   * Health check middleware for OpenForis endpoints
   */
  static healthCheck() {
    return async (req, res) => {
      try {
        const { OpenForisAdapter } = require('./adapter');

        // Create a test adapter instance
        const adapter = new OpenForisAdapter({
          testMode: process.env.NODE_ENV !== 'production',
        });

        const status = adapter.getStatus();

        const health = {
          success: true,
          status: 'healthy',
          timestamp: new Date().toISOString(),
          openforis: {
            initialized: status.initialized,
            testMode: status.testMode,
            endpoints: status.endpoints,
            cache: status.cacheStats,
          },
          environment: {
            nodeEnv: process.env.NODE_ENV,
            hasApiKey: !!process.env.OPENFORIS_API_KEY,
          },
          security: {
            inputSanitization: true,
            requestSizeValidation: true,
            contentTypeValidation: true,
            securityHeaders: true,
          },
        };

        res.status(200).json(health);
      } catch (error) {
        res.status(503).json({
          success: false,
          status: 'unhealthy',
          error: error.message,
          timestamp: new Date().toISOString(),
        });
      }
    };
  }
}

module.exports = OpenForisMiddleware;
