/**
 * Centralized CORS Configuration for WRFCoin Platform (ESM version)
 * Replaces wildcard Access-Control-Allow-Origin: * with proper origin validation
 *
 * Security: This module implements proper CORS origin validation to prevent
 * cross-origin attacks and credential leakage.
 */

import { securityLogger } from '../../server/utils/logger.js';
import strictCorsConfig from '../../server/utils/strict-cors-config.js';

const { resolveAllowedOrigins } = strictCorsConfig;
const { isExplicitlyDisallowedOrigin } = strictCorsConfig;

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

const ALLOWED_PATTERNS = [
  /^https:\/\/[\w-]+\.wrfcoin\.app$/,
];

const LOCALHOST_PATTERN = /^http:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0):\d+$/;

export function validateOrigin(origin) {
  if (!origin) {
    if (process.env.NODE_ENV === 'development') {
      return '';
    }
    return false;
  }

  if (isExplicitlyDisallowedOrigin(origin)) {
    return false;
  }

  if (ALLOWED_ORIGINS.includes(origin)) {
    return origin;
  }

  for (const pattern of ALLOWED_PATTERNS) {
    if (pattern.test(origin)) {
      return origin;
    }
  }

  if (process.env.NODE_ENV === 'development' && LOCALHOST_PATTERN.test(origin)) {
    return origin;
  }

  return false;
}

export function getCorsHeaders(origin) {
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

export function setCorsHeaders(res, origin) {
  const headers = getCorsHeaders(origin);
  Object.entries(headers).forEach(([key, value]) => {
    if (value) {
      res.setHeader(key, value);
    }
  });
}

export function corsMiddleware(req, res, next) {
  const origin = req.headers.origin;
  const validOrigin = validateOrigin(origin);

  if (validOrigin !== false) {
    setCorsHeaders(res, origin);
  } else if (origin) {
    securityLogger.warn('CORS: Blocked request from unauthorized origin', { module: 'CORS', origin });
  }

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

export function applyRawCorsHeaders(res, origin) {
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

export { ALLOWED_ORIGINS };
