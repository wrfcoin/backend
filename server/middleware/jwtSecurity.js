/**
 * Enhanced JWT Security Implementation
 * Task 2.5: Secure JWT handling with refresh tokens and blacklisting
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { logger } = require('../utils/logger');

// In-memory blacklist for development (use Redis in production)
const tokenBlacklist = new Set();
const refreshTokens = new Map(); // Map refresh tokens to user data
const REFRESH_TOKEN_CLEANUP_INTERVAL_MS = 30 * 60 * 1000;

/**
 * Generate a secure key pair for RS256 (production)
 */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  return { publicKey, privateKey };
}

/**
 * Sign JWT with enhanced security
 */
function signToken(payload, options = {}) {
  const config = require('../../config');

  if (!config.jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  const defaultOptions = {
    expiresIn: '15m', // Short expiration
    issuer: 'wrfcoin-platform',
    audience: 'wrfcoin-api',
    algorithm: process.env.NODE_ENV === 'production' ? 'RS256' : 'HS256',
  };

  const mergedOptions = { ...defaultOptions, ...options };

  // Add security claims
  const securePayload = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    jti: crypto.randomUUID(), // Unique token ID for tracking
    scope: payload.scope || 'basic',
  };

  return jwt.sign(securePayload, config.jwtSecret, mergedOptions);
}

/**
 * Generate refresh token
 */
function generateRefreshToken(userId) {
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  refreshTokens.set(refreshToken, {
    userId,
    expiresAt,
    createdAt: new Date(),
  });

  // Clean up expired refresh tokens
  cleanupExpiredRefreshTokens();

  return refreshToken;
}

/**
 * Validate refresh token and generate new access token
 */
function refreshAccessToken(refreshToken) {
  const tokenData = refreshTokens.get(refreshToken);

  if (!tokenData) {
    throw new Error('Invalid refresh token');
  }

  if (new Date() > tokenData.expiresAt) {
    refreshTokens.delete(refreshToken);
    throw new Error('Refresh token expired');
  }

  // Generate new access token
  const accessToken = signToken({
    userId: tokenData.userId,
    type: 'access',
  });

  return accessToken;
}

/**
 * Blacklist a token (logout/revocation)
 */
function blacklistToken(token) {
  try {
    const decoded = jwt.decode(token);
    if (decoded && decoded.jti) {
      tokenBlacklist.add(decoded.jti);
      logger.info(`Token blacklisted: ${decoded.jti}`);
    }
  } catch (error) {
    logger.warn('Failed to blacklist token:', error.message);
  }
}

/**
 * Check if token is blacklisted
 */
function isTokenBlacklisted(token) {
  try {
    const decoded = jwt.decode(token);
    return decoded && decoded.jti && tokenBlacklist.has(decoded.jti);
  } catch (error) {
    return false;
  }
}

/**
 * Verify token with blacklist check
 */
function verifyToken(token, options = {}) {
  const config = require('../../config');

  if (!config.jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required');
  }

  // Check blacklist first
  if (isTokenBlacklisted(token)) {
    throw new Error('Token has been revoked');
  }

  const defaultOptions = {
    algorithms: [process.env.NODE_ENV === 'production' ? 'RS256' : 'HS256'],
    issuer: 'wrfcoin-platform',
    audience: 'wrfcoin-api',
    maxAge: '15m',
  };

  const mergedOptions = { ...defaultOptions, ...options };

  return jwt.verify(token, config.jwtSecret, mergedOptions);
}

/**
 * Clean up expired refresh tokens
 */
function cleanupExpiredRefreshTokens() {
  const now = new Date();
  for (const [token, data] of refreshTokens.entries()) {
    if (now > data.expiresAt) {
      refreshTokens.delete(token);
    }
  }
}

// Periodically prune stale refresh tokens so long-lived processes do not
// accumulate expired entries even when no new tokens are being minted.
const refreshTokenCleanupTimer = setInterval(
  cleanupExpiredRefreshTokens,
  REFRESH_TOKEN_CLEANUP_INTERVAL_MS
);

if (typeof refreshTokenCleanupTimer.unref === 'function') {
  refreshTokenCleanupTimer.unref();
}

/**
 * Enhanced authentication middleware with blacklist support
 */
const enhancedAuth = (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Please provide a valid token.',
        code: 'MISSING_TOKEN',
      });
    }

    const token = authHeader.split(' ')[1];

    try {
      const decoded = verifyToken(token);
      req.user = decoded;
      req.tokenId = decoded.jti;
      next();
    } catch (error) {
      let errorCode = 'INVALID_TOKEN';
      let errorMessage = 'Invalid or expired token';

      if (error.message.includes('revoked')) {
        errorCode = 'TOKEN_REVOKED';
        errorMessage = 'Token has been revoked';
      } else if (error.message.includes('expired')) {
        errorCode = 'TOKEN_EXPIRED';
        errorMessage = 'Token has expired';
      }

      return res.status(401).json({
        success: false,
        error: errorMessage,
        code: errorCode,
      });
    }
  } catch (error) {
    logger.error('Authentication middleware error:', error);
    return res.status(500).json({
      success: false,
      error: 'Authentication system error',
      code: 'AUTH_SYSTEM_ERROR',
    });
  }
};

/**
 * Logout endpoint to blacklist token
 */
const logout = (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      blacklistToken(token);
    }

    res.json({
      success: true,
      message: 'Successfully logged out',
    });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({
      success: false,
      error: 'Logout failed',
    });
  }
};

/**
 * Refresh token endpoint
 */
const refresh = (req, res) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(400).json({
        success: false,
        error: 'Refresh token required',
      });
    }

    const accessToken = refreshAccessToken(refreshToken);

    res.json({
      success: true,
      accessToken,
      expiresIn: '15m',
    });
  } catch (error) {
    logger.error('Token refresh error:', error);
    res.status(401).json({
      success: false,
      error: error.message || 'Token refresh failed',
    });
  }
};

module.exports = {
  signToken,
  verifyToken,
  generateRefreshToken,
  refreshAccessToken,
  blacklistToken,
  isTokenBlacklisted,
  enhancedAuth,
  logout,
  refresh,
  generateKeyPair,
  cleanupExpiredRefreshTokens,
};
