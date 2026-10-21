/**
 * API Audit Middleware
 *
 * This middleware provides auditing for sensitive API endpoints to detect
 * potential abuse and maintain a record of important API operations.
 */

const logger = require('../utils/logger').logger;
const path = require('path');
const fs = require('fs');

const AUDIT_LOG_DIR = path.join(__dirname, '../../logs/audit');

// Ensure log directory exists
if (!fs.existsSync(AUDIT_LOG_DIR)) {
  fs.mkdirSync(AUDIT_LOG_DIR, { recursive: true });
}

// List of sensitive endpoints that require detailed auditing
const SENSITIVE_ENDPOINTS = [
  // Wallet and financial endpoints
  { pattern: /^\/api\/wallet\/transfer/, level: 'high' },
  { pattern: /^\/api\/wallet\/create/, level: 'high' },
  { pattern: /^\/api\/wallet\/import/, level: 'high' },
  { pattern: /^\/api\/oracle\/price/, level: 'medium' },
  { pattern: /^\/api\/nft\/mint/, level: 'high' },
  { pattern: /^\/api\/nft\/transfer/, level: 'high' },

  // Governance endpoints
  { pattern: /^\/api\/governance\/proposal\/create/, level: 'high' },
  { pattern: /^\/api\/governance\/vote/, level: 'medium' },
  { pattern: /^\/api\/governance\/veto/, level: 'high' },

  // Integration endpoints with financial operations
  { pattern: /^\/api\/integrations\/.*\/transfer/, level: 'high' },
  { pattern: /^\/api\/integrations\/.*\/bridge/, level: 'high' },

  // User management
  { pattern: /^\/api\/user\/register/, level: 'medium' },
  { pattern: /^\/api\/user\/update/, level: 'medium' },

  // Blockchain write operations
  { pattern: /^\/api\/blockchain\/submit/, level: 'high' },
];

/**
 * Generate unique request ID
 */
function generateRequestId() {
  return `req-${Date.now()}-${Math.random().toString(36).substring(2, 15)}`;
}

/**
 * Check if a path matches any of the sensitive patterns
 * @param {string} path - The request path
 * @returns {Object|null} - The matched pattern object or null if no match
 */
function matchesSensitivePattern(path) {
  for (const endpoint of SENSITIVE_ENDPOINTS) {
    if (endpoint.pattern.test(path)) {
      return endpoint;
    }
  }
  return null;
}

/**
 * Write audit log to file
 * @param {Object} auditData - The audit data to log
 */
function writeAuditLog(auditData) {
  const date = new Date();
  const filename = path.join(
    AUDIT_LOG_DIR,
    `api-audit-${date.toISOString().split('T')[0]}.log`
  );

  const logEntry =
    JSON.stringify({
      ...auditData,
      timestamp: date.toISOString(),
    }) + '\n';

  fs.appendFile(filename, logEntry, err => {
    if (err) {
      logger.error(`Failed to write audit log: ${err.message}`, { error: err });
    }
  });
}

/**
 * Determines if a request should be blocked based on audit history
 * @param {Object} req - Express request object
 * @returns {boolean} - True if request should be blocked
 */
function shouldBlockRequest(req) {
  // This is a placeholder for more advanced abuse detection logic
  // In a real implementation, you might:
  // 1. Check for rapid repeated requests from the same IP
  // 2. Look for unusual patterns in request parameters
  // 3. Compare against known abuse signatures
  // 4. Implement a risk scoring system

  return false; // Default to allowing requests
}

/**
 * API audit middleware
 */
function apiAudit(req, res, next) {
  // Add request ID for tracing
  const requestId = generateRequestId();
  req.requestId = requestId;

  // Check if this is a sensitive endpoint
  const sensitiveMatch = matchesSensitivePattern(req.path);

  if (sensitiveMatch) {
    // Capture request start time
    const startTime = Date.now();

    // Create base audit record
    const auditRecord = {
      requestId,
      path: req.path,
      method: req.method,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      sensitivityLevel: sensitiveMatch.level,
      userId: req.user ? req.user.id : null,
      params: {
        query: { ...req.query },
        // Exclude sensitive data like passwords from body
        body: {
          ...req.body,
          password: req.body.password ? '[REDACTED]' : undefined,
          privateKey: req.body.privateKey ? '[REDACTED]' : undefined,
          seed: req.body.seed ? '[REDACTED]' : undefined,
          mnemonic: req.body.mnemonic ? '[REDACTED]' : undefined,
        },
      },
    };

    // Check for potential abuse patterns
    if (shouldBlockRequest(req)) {
      // Log blocked request
      auditRecord.outcome = 'BLOCKED';
      auditRecord.reason = 'Potential abuse detected';

      writeAuditLog(auditRecord);
      logger.warn(`Blocked suspicious API request: ${req.method} ${req.path}`, {
        requestId,
        ip: req.ip,
      });

      return res.status(429).json({
        error: true,
        message: 'Request blocked due to suspicious activity',
        code: 'SUSPICIOUS_ACTIVITY',
      });
    }

    // Intercept response to add audit logging after request completes
    const originalSend = res.send;
    res.send = function (body) {
      // Calculate request duration
      const duration = Date.now() - startTime;

      // Update audit record with response data
      auditRecord.statusCode = res.statusCode;
      auditRecord.duration = duration;
      auditRecord.outcome = res.statusCode < 400 ? 'SUCCESS' : 'ERROR';

      // Parse response body if it's JSON
      try {
        const parsedBody = JSON.parse(body);
        // Store response without sensitive data
        auditRecord.response = {
          error: parsedBody.error,
          code: parsedBody.code,
          // Don't include full response data to keep logs smaller
          hasData: !!parsedBody.data,
        };
      } catch (error) {
        // Not JSON or couldn't parse
        auditRecord.response = {
          type: typeof body,
          length: body ? body.length : 0,
        };
      }

      // Write audit record to log file
      writeAuditLog(auditRecord);

      // Log high-sensitivity operations to application log
      if (sensitiveMatch.level === 'high') {
        logger.info(`Sensitive API operation: ${req.method} ${req.path}`, {
          requestId,
          statusCode: res.statusCode,
          duration,
          userId: auditRecord.userId,
        });
      }

      // Continue with the original response
      return originalSend.call(this, body);
    };
  }

  // Continue to next middleware
  next();
}

module.exports = apiAudit;
