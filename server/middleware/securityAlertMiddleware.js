/**
 * Security Alert Middleware
 *
 * This middleware monitors for suspicious behavior and triggers alerts
 * when potential security threats are detected.
 */

const { logger } = require('../utils/logger');

// In-memory store for tracking suspicious behavior
const rateLimitTracker = new Map();
const bruteForceTracker = new Map();
const sensitiveEndpoints = [
  '/api/wallet',
  '/api/keys',
  '/api/rpc',
  '/api/node-control',
  '/api/governance',
];

/**
 * Check if a request matches sensitive endpoint patterns
 * @param {string} url - Request URL to check
 * @returns {boolean} True if sensitive
 */
function isSensitiveEndpoint(url) {
  return sensitiveEndpoints.some(endpoint => url.startsWith(endpoint));
}

/**
 * Clean up old entries from trackers periodically
 */
function cleanupTrackers() {
  const now = Date.now();
  const expiryTime = 1000 * 60 * 60; // 1 hour

  // Clean rate limit tracker
  for (const [key, { timestamp }] of rateLimitTracker.entries()) {
    if (now - timestamp > expiryTime) {
      rateLimitTracker.delete(key);
    }
  }

  // Clean brute force tracker
  for (const [key, { timestamp }] of bruteForceTracker.entries()) {
    if (now - timestamp > expiryTime) {
      bruteForceTracker.delete(key);
    }
  }

  logger.debug('Cleaned up security trackers', {
    rateLimitTrackerSize: rateLimitTracker.size,
    bruteForceTrackerSize: bruteForceTracker.size,
  });
}

// Clean up every hour
// #977 ratchet: unref'd — created at import, must not hold the loop open.
const importTimeTimer3 = setInterval(cleanupTrackers, 1000 * 60 * 60);
importTimeTimer3.unref();

/**
 * Create a middleware that tracks suspicious behavior
 * @returns {Function} Express middleware function
 */
function createSecurityAlertMiddleware() {
  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const url = req.originalUrl;
    const method = req.method;
    const now = Date.now();

    // Track request rate by IP
    const rateKey = `${ip}:rate`;
    const rateData = rateLimitTracker.get(rateKey) || {
      count: 0,
      timestamp: now,
      lastAlert: 0,
    };

    // Update rate data
    rateData.count++;
    rateData.timestamp = now;
    rateLimitTracker.set(rateKey, rateData);

    // Check for rate-related suspicious behavior - 100 requests in a minute
    const isTooManyRequests = rateData.count > 100;
    const lastAlertWasLongAgo = now - rateData.lastAlert > 1000 * 60; // 1 minute

    if (isTooManyRequests && lastAlertWasLongAgo) {
      // Use standard logger since logger.security.suspicious is not defined
      logger.warn('Security Alert: High request rate from IP', {
        level: 'medium',
        ip,
        requestCount: rateData.count,
        timeWindow: '1 minute',
      });

      // Update last alert time
      rateData.lastAlert = now;
    }

    // Track sensitive endpoints separately
    if (isSensitiveEndpoint(url)) {
      // Check for brute force attempts on sensitive endpoints
      const bruteKey = `${ip}:${url}:brute`;
      const bruteData = bruteForceTracker.get(bruteKey) || {
        count: 0,
        timestamp: now,
        lastAlert: 0,
        failureCount: 0,
      };

      // Update brute force data
      bruteData.count++;
      bruteData.timestamp = now;
      bruteForceTracker.set(bruteKey, bruteData);

      // Track failure counts for sensitive endpoints on response
      const originalEnd = res.end;
      res.end = function (...args) {
        // Status codes 401 and 403 indicate auth failures
        if (res.statusCode === 401 || res.statusCode === 403) {
          bruteData.failureCount++;

          // Alert on multiple failures
          if (
            bruteData.failureCount >= 5 &&
            now - bruteData.lastAlert > 1000 * 60 * 5
          ) {
            // Use standard logger since logger.security.suspicious is not defined
            logger.warn('Security Alert: Possible brute force attempt', {
              level: 'high',
              ip,
              endpoint: url,
              method,
              failureCount: bruteData.failureCount,
            });

            bruteData.lastAlert = now;
          }
        }

        return originalEnd.apply(this, args);
      };
    }

    next();
  };
}

/**
 * Create a middleware that checks request payloads for malicious content
 * @returns {Function} Express middleware function
 */
function createPayloadScanMiddleware() {
  return (req, res, next) => {
    // Skip scanning if no body
    if (!req.body) {
      return next();
    }

    // Simple patterns to check (can be expanded)
    const suspiciousPatterns = [
      /eval\s*\(/i, // JavaScript eval
      /<script[\s>]/i, // Inline script tags
      /\bdocument\.cookie\b/i, // Cookie stealing attempts
      /\b(union|select|insert|update|delete|drop)\b.*\b(from|into|table)\b/i, // SQL commands
      /\b(and|or)\b.*\b(true|false|1|0)\b.*=/i, // SQL boolean injection
      /\b(sleep|benchmark|wait|delay)\b.*\(/i, // Time-based SQL injection
      /(\.\.\/|\.\.\\)/, // Directory traversal
    ];

    // Convert body to string for checking
    let bodyStr = '';
    try {
      bodyStr = JSON.stringify(req.body);
    } catch (error) {
      bodyStr = String(req.body);
    }

    // Check each pattern
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(bodyStr)) {
        // Alert on suspicious content
        logger.warn('Security Alert: Suspicious payload content detected', {
          level: 'high',
          ip: req.ip || req.connection.remoteAddress,
          endpoint: req.originalUrl,
          method: req.method,
          pattern: pattern.toString(),
        });

        // Don't block request, just log the alert
        break;
      }
    }

    next();
  };
}

module.exports = {
  createSecurityAlertMiddleware,
  createPayloadScanMiddleware,
};
