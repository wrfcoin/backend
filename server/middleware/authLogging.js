/**
 * Authentication Logging Middleware
 *
 * This middleware logs authentication events for audit and security purposes.
 * It captures both successful and failed authentication attempts.
 */

const { securityLogger } = require('../utils/logger');
const ipCache = new Map(); // Simple in-memory cache for tracking failed attempts by IP

/**
 * Log successful authentication
 * @param {Object} req - Express request object
 * @param {Object} user - User object
 * @param {string} authType - Authentication type (session, api-key, jwt, etc.)
 */
function logAuthSuccess(req, user, authType = 'unknown') {
  securityLogger.info('Authentication succeeded', {
    event: 'auth_success',
    user,
    method: req.method,
    endpoint: req.originalUrl,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.headers['user-agent'],
    authType,
  });

  // Reset failed attempt counter for this IP
  if (ipCache.has(req.ip)) {
    ipCache.delete(req.ip);
  }
}

/**
 * Log failed authentication
 * @param {Object} req - Express request object
 * @param {string} reason - Reason for the failure
 * @param {string} username - Attempted username (if available)
 * @param {string} authType - Authentication type (session, api-key, jwt, etc.)
 */
function logAuthFailure(req, reason, username = null, authType = 'unknown') {
  // Increment failed attempt counter for this IP
  const ip = req.ip || req.connection.remoteAddress;
  const currentCount = ipCache.get(ip) || 0;
  const newCount = currentCount + 1;
  ipCache.set(ip, newCount);

  securityLogger.warn('Authentication failed', {
    event: 'auth_failure',
    username,
    method: req.method,
    endpoint: req.originalUrl,
    ip,
    userAgent: req.headers['user-agent'],
    reason,
    authType,
    failureCount: newCount,
  });

  // Log suspicious behavior if too many attempts
  if (newCount >= 5) {
    securityLogger.warn('Multiple failed authentication attempts', {
      event: 'suspicious',
      severity: 'high',
      ip,
      username,
      failureCount: newCount,
    });
  }
}

/**
 * Log API key usage
 * @param {Object} req - Express request object
 * @param {string} keyId - API key identifier
 */
function logApiKeyUsage(req, keyId) {
  securityLogger.info('API key used', {
    event: 'api_key_usage',
    keyId,
    endpoint: req.originalUrl,
    method: req.method,
    ip: req.ip || req.connection.remoteAddress,
    userAgent: req.headers['user-agent'],
  });
}

/**
 * Periodically clean up the IP cache to prevent memory leaks
 */
// #977: unref'd below — this runs as an IMPORT SIDE EFFECT, so every module
// pulling in the auth-logging middleware inherited a live handle.
const authFailureCacheCleanupTimer = setInterval(
  () => {
    securityLogger.debug('Cleaning authentication failure cache', {
      cacheSize: ipCache.size,
    });
    ipCache.clear();
  },
  1000 * 60 * 60
); // Clean every hour
authFailureCacheCleanupTimer.unref();

module.exports = {
  logAuthSuccess,
  logAuthFailure,
  logApiKeyUsage,
};
