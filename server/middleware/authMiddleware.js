/**
 * Wrfcoin Authentication Middleware
 *
 * This middleware handles authentication and authorization for secure API endpoints.
 * It provides functions to require authentication and specific roles for protected routes.
 */

const { logger } = require('../../utils/logger');
const jwt = require('jsonwebtoken');
const { hasAdminRole } = require('../utils/admin-role');

const JWT_ISSUER = 'wrfcoin-platform';
const JWT_AUDIENCE = 'wrfcoin-api';
const JWT_ALGORITHM = 'HS256';
const JWT_MAX_AGE = '15m';

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET environment variable is required');
  }
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  return secret;
}

/**
 * Middleware to require authentication for protected routes
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const requireAuth = (req, res, next) => {
  try {
    // Get token from Authorization header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Please provide a valid token.',
      });
    }

    const token = authHeader.split(' ')[1];

    // Match the canonical wallet-login JWT contract. The login flow signs
    // access tokens with JWT_SECRET/HS256 and these same issuer/audience claims.
    const decoded = jwt.verify(token, getJwtSecret(), {
      algorithms: [JWT_ALGORITHM],
      maxAge: JWT_MAX_AGE,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });

    if (decoded.type && decoded.type !== 'access') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token. Please login again.',
      });
    }

    // Add user data to request
    req.user = decoded;

    // Continue to the next middleware or route handler
    next();
  } catch (error) {
    logger.error('Authentication error', { error });

    if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        success: false,
        error: 'Token has expired. Please login again.',
      });
    }

    return res.status(401).json({
      success: false,
      error: 'Invalid token. Please login again.',
    });
  }
};

/**
 * Middleware to require admin role for protected routes
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
// An admin token must also carry a LIVE session (backend#1329 item 1). The admin
// issuer (scripts/issue-admin-token.cjs) writes `session:<sessionId>` with a TTL equal
// to the token lifetime, so deleting that key revokes an admin token before its exp.
// Missing/expired session, a session that is not this token's own admin session, or a
// backing-store error, refuses (401): it never fails open.
async function requireLiveAdminSession(req, res, next) {
  try {
    const sessionId = req.user?.sessionId;
    if (typeof sessionId !== 'string' || sessionId === '') {
      return res.status(401).json({ success: false, error: 'Admin session required. Please login again.' });
    }
    const { sessionService } = await import('../services/redis-session-service.js');
    // Read-only, Redis-only: no TTL renewal (so a concurrent DEL cannot be undone) and
    // no process-local fallback. The session must also be this token's own admin session.
    const session = await sessionService.getSessionRedisOnly(sessionId);
    if (!session || session.userId !== req.user.userId || !hasAdminRole(session)) {
      return res.status(401).json({ success: false, error: 'Admin session not found or expired. Please login again.' });
    }
    return next();
  } catch (error) {
    logger.error('Admin session check failed', { error: error?.message });
    return res.status(401).json({ success: false, error: 'Admin session could not be verified.' });
  }
}

const requireAdmin = [
  requireAuth,
  (req, res, next) => {
    if (!hasAdminRole(req.user)) {
      return res.status(403).json({
        success: false,
        error: 'Admin privilege required for this operation.',
      });
    }

    next();
  },
  requireLiveAdminSession,
];

/**
 * Middleware to require validator role for protected routes
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const requireValidator = [
  requireAuth,
  (req, res, next) => {
    if (!req.user || !req.user.roles || !req.user.roles.includes('validator')) {
      return res.status(403).json({
        success: false,
        error: 'Validator privilege required for this operation.',
      });
    }

    next();
  },
];

/**
 * Middleware to require foundation member role for protected routes
 *
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const requireFoundationMember = [
  requireAuth,
  (req, res, next) => {
    if (
      !req.user ||
      !req.user.roles ||
      !req.user.roles.includes('foundation')
    ) {
      return res.status(403).json({
        success: false,
        error: 'Foundation member privilege required for this operation.',
      });
    }

    next();
  },
];

/**
 * The wallet address (lowercase) that a valid wallet-login access token in the
 * Authorization header belongs to, or null. Never rejects and never throws: for
 * public routes that only widen what the caller's OWN row shows (backend#1361).
 * Same verification options as requireAuth.
 */
const peekWalletSubject = req => {
  try {
    const authHeader = req.headers && req.headers.authorization;
    if (typeof authHeader !== 'string' || !authHeader.startsWith('Bearer ')) return null;
    const decoded = jwt.verify(authHeader.split(' ')[1], getJwtSecret(), {
      algorithms: [JWT_ALGORITHM],
      maxAge: JWT_MAX_AGE,
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    if (decoded.type && decoded.type !== 'access') return null;
    return typeof decoded.sub === 'string' && decoded.sub.length > 0 ? decoded.sub.toLowerCase() : null;
  } catch {
    return null;
  }
};

module.exports = {
  peekWalletSubject,
  requireAuth,
  requireAdmin,
  requireValidator,
  requireFoundationMember,
};
