/**
 * Centralized CORS Configuration for WRFCoin Platform (CommonJS version)
 * Replaces wildcard Access-Control-Allow-Origin: * with proper origin validation
 *
 * Security: This module implements proper CORS origin validation to prevent
 * cross-origin attacks and credential leakage.
 */

const { securityLogger } = require('../../server/utils/logger.js');
const {
  resolveAllowedOrigins,
  isExplicitlyDisallowedOrigin,
} = require('../../server/utils/strict-cors-config.js');

const DEFAULT_ALLOWED_ORIGINS = [
  'https://wrfcoin.app',
  'https://www.wrfcoin.app',
  'https://api.wrfcoin.app',
  'https://dashboard.wrfcoin.app',
  'http://localhost:3000',
  'http://localhost:5000',
  'http://localhost:4001',
  'http://0.0.0.0:5000',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:5000',
];

const ALLOWED_ORIGINS = resolveAllowedOrigins({
  developmentDefaults: DEFAULT_ALLOWED_ORIGINS,
});

// Dynamic subdomains of the platform domain only
const ALLOWED_PATTERNS = [
  /^https:\/\/[\w-]+\.wrfcoin\.app$/,
];

// Development localhost pattern
const LOCALHOST_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+$/;

/**
 * Validates if the given origin is allowed
 * @param {string|undefined} origin - The origin to validate
 * @returns {string|false} The origin if valid, or false if not allowed
 */
function validateOrigin(origin) {
  if (!origin) {
    // Allow requests with no origin (same-origin, mobile apps, curl, etc.) in development
    if (process.env.NODE_ENV === 'development') {
      return '';
    }
    return false;
  }

  if (isExplicitlyDisallowedOrigin(origin)) {
    return false;
  }

  // Direct match against allowed origins
  if (ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }

  // Pattern matching for dynamic subdomains
  for (const pattern of ALLOWED_PATTERNS) {
    if (pattern.test(origin)) {
      return origin;
    }
  }

  // Allow localhost with any port in development
  if (process.env.NODE_ENV === 'development' && LOCALHOST_PATTERN.test(origin)) {
    return origin;
  }

  return false;
}

/**
 * Generates CORS headers based on the request origin
 * @param {string|undefined} origin - The origin from the request headers
 * @returns {Object} Object containing CORS headers
 */
function getCorsHeaders(origin) {
  const validOrigin = validateOrigin(origin);

  if (validOrigin === false) {
    return {
      'Access-Control-Allow-Origin': '',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin, Accept, X-API-Key',
      'Access-Control-Allow-Credentials': 'false',
    };
  }

  return {
    'Access-Control-Allow-Origin': validOrigin || (process.env.NODE_ENV === 'development' ? '*' : ''),
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Requested-With, Origin, Accept, X-API-Key',
    'Access-Control-Allow-Credentials': 'true',
  };
}

/**
 * Sets CORS headers on an HTTP response
 * @param {Object} res - The response object
 * @param {string|undefined} origin - The origin from the request headers
 */
function setCorsHeaders(res, origin) {
  const headers = getCorsHeaders(origin);
  Object.entries(headers).forEach(([key, value]) => {
    if (value) {
      res.setHeader(key, value);
    }
  });
}

/**
 * Express middleware for CORS handling with origin validation
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next function
 */
function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const validOrigin = validateOrigin(origin);

  if (validOrigin !== false) {
    setCorsHeaders(res, origin);
  } else if (origin) {
    // Log blocked origin attempts (but don't block for preflight)
    securityLogger.warn('CORS: Blocked request from unauthorized origin', { module: 'CORS', origin });
  }

  // Handle preflight requests
  if (req.method === 'OPTIONS') {
    if (validOrigin !== false || !origin) {
      res.status(200).end();
    } else {
      res.status(403).json({
        success: false,
        error: {
          code: 'CORS_ORIGIN_NOT_ALLOWED',
          message: 'Origin not allowed by CORS policy',
        },
      });
    }
    return;
  }

  next();
}

/**
 * For raw HTTP servers (non-Express), apply CORS headers to response
 * Returns false if the origin is not allowed
 * @param {Object} res - Node.js HTTP response object
 * @param {string|undefined} origin - The origin from request headers
 * @returns {boolean} true if origin is valid and headers were set, false otherwise
 */
function applyRawCorsHeaders(res, origin) {
  const validOrigin = validateOrigin(origin);

  if (validOrigin === false && origin) {
    securityLogger.warn('CORS: Blocked request from unauthorized origin', { module: 'CORS', origin });
    return false;
  }

  const originToSet = validOrigin || (process.env.NODE_ENV === 'development' ? '*' : '');

  if (originToSet) {
    res.setHeader('Access-Control-Allow-Origin', originToSet);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Origin, Accept, X-API-Key');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  return true;
}

module.exports = {
  validateOrigin,
  getCorsHeaders,
  setCorsHeaders,
  corsMiddleware,
  applyRawCorsHeaders,
  ALLOWED_ORIGINS,
};
