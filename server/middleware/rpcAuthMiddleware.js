/**
 * Enhanced RPC Authentication Middleware
 *
 * This middleware provides authentication and rate limiting for RPC and
 * node-control endpoints. It requires API keys for sensitive operations
 * and prevents unauthorized access to node management functionality.
 *
 * Features:
 * - Authentication verification with secure comparison
 * - Rate limiting to prevent abuse
 * - Comprehensive security logging
 * - Metrics collection for authentication events
 */

const rateLimit = require('express-rate-limit');
const { logger, securityLogger } = require('../utils/logger');
const {
  logAuthSuccess,
  logAuthFailure,
  logApiKeyUsage,
} = require('./authLogging');
const { createApiError } = require('../utils/api-error');
const crypto = require('crypto');

const FORBIDDEN_SECRET_VALUES = new Set([
  'dev-rpc-api-key',
  'dev-admin-token',
  'changeme',
  'change-me',
]);

function getConfiguredSecret(envKey) {
  const value = process.env[envKey];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (FORBIDDEN_SECRET_VALUES.has(trimmed.toLowerCase())) return null;
  if (trimmed.startsWith('REPLACE_')) return null;
  return trimmed;
}

function respondAuthNotConfigured(res, message, code) {
  return res.status(503).json(createApiError(code, message));
}

// Setup rate limiter specific to RPC endpoints
const rpcRateLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes
  max: 50, // limit each IP to 50 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: true,
    message: 'Too many RPC requests, please try again later.',
    code: 'RPC_RATE_LIMIT_EXCEEDED',
  },
  skip: (req, res) => {
    // Log rate limit events for analytics
    if (req.rateLimit && req.rateLimit.remaining === 0) {
      securityLogger.warn('RPC rate limit exceeded', { event: 'suspicious', severity: 'low',
        ip: req.ip || req.connection.remoteAddress,
        endpoint: req.originalUrl,
        method: req.method,
      });
    }
    return false; // Don't actually skip the rate limiter
  },
});

// Stricter rate limit for node control endpoints
const nodeControlRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 requests per window
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: true,
    message: 'Too many node control requests, please try again later.',
    code: 'NODE_CONTROL_RATE_LIMIT_EXCEEDED',
  },
  skip: (req, res) => {
    // Log rate limit events for analytics with higher severity (node control is sensitive)
    if (req.rateLimit && req.rateLimit.remaining === 0) {
      securityLogger.warn('Node control rate limit exceeded', { event: 'suspicious', severity: 'medium',
        ip: req.ip || req.connection.remoteAddress,
        endpoint: req.originalUrl,
        method: req.method,
      });
    }
    return false; // Don't actually skip the rate limiter
  },
});

/**
 * Secure comparison of strings to prevent timing attacks
 * @param {string} a - First string to compare
 * @param {string} b - Second string to compare
 * @returns {boolean} True if strings match
 */
function secureCompare(a, b) {
  if (
    typeof a !== 'string' ||
    typeof b !== 'string' ||
    a.length === 0 ||
    b.length === 0
  ) {
    return false;
  }

  if (a.length !== b.length) {
    return false;
  }

  return crypto.timingSafeEqual(
    Buffer.from(a, 'utf8'),
    Buffer.from(b, 'utf8'),
  );
}

/**
 * Verify RPC API key with enhanced security logging
 */
function verifyRpcApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const validApiKey = getConfiguredSecret('RPC_API_KEY');

  if (!validApiKey) {
    logAuthFailure(req, 'RPC API key is not configured', null, 'api-key');

    return respondAuthNotConfigured(
      res,
      'RPC authentication is not configured on this server',
      'RPC_AUTH_NOT_CONFIGURED',
    );
  }

  // No API key provided
  if (!apiKey) {
    // Log authentication failure
    logAuthFailure(req, 'Missing API key', null, 'api-key');

    return res
      .status(401)
      .json(
        createApiError(
          'MISSING_API_KEY',
          'API key is required for RPC endpoints',
        ),
      );
  }

  // Use secure comparison for API keys to prevent timing attacks
  const isValid = secureCompare(apiKey, validApiKey);

  if (!isValid) {
    // Log authentication failure with invalid key
    logAuthFailure(req, 'Invalid API key', null, 'api-key');

    return res
      .status(403)
      .json(createApiError('INVALID_API_KEY', 'Invalid API key'));
  }

  // Log successful API key usage
  logApiKeyUsage({
    keyId: 'rpc-api-key',
    endpoint: req.originalUrl,
    method: req.method,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.headers['user-agent'],
  });

  // Log authentication success
  logAuthSuccess(req, { id: 'api-user', username: 'api-user' }, 'api-key');

  next();
}

/**
 * Verify node control authorization with enhanced security logging
 * Requires both API key and admin token
 */
function verifyNodeControlAuth(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  const adminToken = req.headers['x-admin-token'];
  const validApiKey = getConfiguredSecret('RPC_API_KEY');
  const validAdminToken = getConfiguredSecret('ADMIN_TOKEN');

  if (!validApiKey || !validAdminToken) {
    logAuthFailure(
      req,
      'Node control credentials are not configured',
      null,
      'node-control',
    );

    return respondAuthNotConfigured(
      res,
      'Node control authentication is not configured on this server',
      'NODE_CONTROL_AUTH_NOT_CONFIGURED',
    );
  }

  // No API key or admin token provided
  if (!apiKey || !adminToken) {
    // Log authentication failure
    logAuthFailure(req, 'Missing credentials', null, 'node-control');

    return res
      .status(401)
      .json(
        createApiError(
          'MISSING_CREDENTIALS',
          'API key and admin token are required for node control endpoints',
        ),
      );
  }

  // Use secure comparison for authentication
  const isApiKeyValid = secureCompare(apiKey, validApiKey);
  const isAdminTokenValid = secureCompare(adminToken, validAdminToken);

  if (!isApiKeyValid || !isAdminTokenValid) {
    // Log authentication failure with details but without exposing the actual keys
    logAuthFailure(req, 'Invalid credentials', null, 'node-control');

    return res
      .status(403)
      .json(createApiError('INVALID_CREDENTIALS', 'Invalid credentials'));
  }

  // Log successful authentication
  logAuthSuccess(
    req,
    { id: 'admin-user', username: 'admin-user' },
    'node-control',
  );

  logger.info('Successful node control authentication', {
    endpoint: req.originalUrl,
    method: req.method,
  });

  next();
}

/**
 * Log all RPC calls for audit purposes with enhanced metrics
 */
function logRpcAccess(req, res, next) {
  const startTime = process.hrtime();

  // Log request details
  logger.info('RPC request received', {
    method: req.method,
    path: req.originalUrl,
    ip: req.ip || req.connection.remoteAddress,
    // Sanitize sensitive data from params
    params: req.body.params
      ? JSON.stringify(sanitizeParams(req.body.params)).substring(0, 100)
      : null,
  });

  // Intercept the response
  const originalSend = res.send;
  res.send = function (data) {
    const diff = process.hrtime(startTime);
    const responseTime = diff[0] * 1e3 + diff[1] * 1e-6; // Convert to ms

    // Record metrics
    logger.metrics.recordHttpRequest(
      req.method,
      req.originalUrl || req.path,
      res.statusCode,
      responseTime,
    );

    // Log completion (but not the actual response data for security)
    logger.info('RPC request completed', {
      method: req.method,
      path: req.originalUrl,
      statusCode: res.statusCode,
      responseTime: `${responseTime.toFixed(2)}ms`,
    });

    return originalSend.call(this, data);
  };

  next();
}

/**
 * Sanitize sensitive parameters from RPC requests
 * @param {Object} params - Parameters to sanitize
 * @returns {Object} Sanitized parameters
 */
function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return params;

  const sensitiveFields = [
    'privateKey',
    'mnemonic',
    'password',
    'secret',
    'token',
    'apiKey',
  ];
  const sanitized = { ...params };

  // Recursively check for sensitive fields
  Object.keys(sanitized).forEach(key => {
    if (sensitiveFields.includes(key.toLowerCase())) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof sanitized[key] === 'object' && sanitized[key] !== null) {
      sanitized[key] = sanitizeParams(sanitized[key]);
    }
  });

  return sanitized;
}

module.exports = {
  rpcRateLimiter,
  nodeControlRateLimiter,
  verifyRpcApiKey,
  verifyNodeControlAuth,
  logRpcAccess,
  secureCompare, // Export for testing
};
