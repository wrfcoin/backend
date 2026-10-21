/**
 * Security Event Logging System
 * Comprehensive monitoring and auditing for security events
 */

const winston = require('winston');
const fs = require('fs');
const path = require('path');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Security logger configuration
const securityLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'wrfcoin-security' },
  transports: [
    new winston.transports.File({
      filename: path.join(logsDir, 'security-error.log'),
      level: 'error',
    }),
    new winston.transports.File({
      filename: path.join(logsDir, 'security-combined.log'),
    }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    }),
  ],
});

// Security event types
const SecurityEventTypes = {
  FAILED_AUTH: 'FAILED_AUTH',
  SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  CROSS_CHAIN_TRANSFER: 'CROSS_CHAIN_TRANSFER',
  INVALID_INPUT: 'INVALID_INPUT',
  UNAUTHORIZED_ACCESS: 'UNAUTHORIZED_ACCESS',
  WEATHER_SUBMISSION: 'WEATHER_SUBMISSION',
  BLOCKCHAIN_INTERACTION: 'BLOCKCHAIN_INTERACTION',
  WEBSOCKET_CONNECTION: 'WEBSOCKET_CONNECTION',
  SECURITY_VIOLATION: 'SECURITY_VIOLATION',
};

// Track failed attempts and suspicious patterns
const securityMetrics = {
  failedAttempts: new Map(), // IP -> count
  suspiciousIPs: new Set(),
  blockedIPs: new Set(),
  transferPatterns: new Map(), // IP -> transfer history
};

// Base security logging function
const logSecurityEvent = (eventType, details, req = null) => {
  const logData = {
    eventType,
    timestamp: new Date().toISOString(),
    details,
    ip: req ? req.ip || req.connection.remoteAddress : null,
    userAgent: req ? req.get('User-Agent') : null,
    url: req ? req.originalUrl : null,
    method: req ? req.method : null,
    sessionId: req ? req.sessionID : null,
  };

  securityLogger.info('Security Event', logData);

  // Update security metrics
  updateSecurityMetrics(eventType, logData);

  return logData;
};

// Failed authentication tracking
const logFailedAuth = (req, reason, attemptedCredentials = null) => {
  const ip = req.ip || req.connection.remoteAddress;

  // Increment failed attempts counter
  const currentAttempts = securityMetrics.failedAttempts.get(ip) || 0;
  securityMetrics.failedAttempts.set(ip, currentAttempts + 1);

  const eventData = {
    reason,
    attemptedCredentials: attemptedCredentials ? '***REDACTED***' : null,
    failedAttemptCount: currentAttempts + 1,
    severity: currentAttempts > 3 ? 'HIGH' : 'MEDIUM',
  };

  // Mark as suspicious after 5 failed attempts
  if (currentAttempts >= 5) {
    securityMetrics.suspiciousIPs.add(ip);
    logSuspiciousActivity(req, 'Multiple failed authentication attempts', {
      totalAttempts: currentAttempts + 1,
    });
  }

  return logSecurityEvent(SecurityEventTypes.FAILED_AUTH, eventData, req);
};

// Suspicious activity monitoring
const logSuspiciousActivity = (req, activity, additionalDetails = {}) => {
  const ip = req ? req.ip || req.connection.remoteAddress : null;

  const eventData = {
    activity,
    severity: 'HIGH',
    ...additionalDetails,
  };

  if (ip) {
    securityMetrics.suspiciousIPs.add(ip);
  }

  return logSecurityEvent(
    SecurityEventTypes.SUSPICIOUS_ACTIVITY,
    eventData,
    req
  );
};

// Rate limit violation logging
const logRateLimitExceeded = (req, endpoint, limitType = 'general') => {
  const ip = req.ip || req.connection.remoteAddress;

  const eventData = {
    endpoint,
    limitType,
    severity: 'MEDIUM',
    userAgent: req.get('User-Agent'),
  };

  // Track repeated rate limit violations
  const violationKey = `${ip}-rate-limit`;
  const violations = securityMetrics.failedAttempts.get(violationKey) || 0;
  securityMetrics.failedAttempts.set(violationKey, violations + 1);

  if (violations > 10) {
    logSuspiciousActivity(req, 'Excessive rate limit violations', {
      totalViolations: violations + 1,
    });
  }

  return logSecurityEvent(
    SecurityEventTypes.RATE_LIMIT_EXCEEDED,
    eventData,
    req
  );
};

// Cross-chain transfer auditing
const logCrossChainTransfer = (req, transferData) => {
  const ip = req ? req.ip || req.connection.remoteAddress : null;

  const eventData = {
    fromChain: transferData.fromChain,
    toChain: transferData.toChain,
    amount: transferData.amount,
    token: transferData.token,
    transferId: transferData.transferId,
    bridgeProtocol: transferData.bridgeProtocol,
    fromAddress: transferData.fromAddress,
    toAddress: transferData.toAddress,
    severity: transferData.amount > 1000 ? 'HIGH' : 'MEDIUM',
  };

  // Track transfer patterns per IP
  if (ip) {
    const transfers = securityMetrics.transferPatterns.get(ip) || [];
    transfers.push({
      timestamp: new Date(),
      amount: transferData.amount,
      chains: `${transferData.fromChain}->${transferData.toChain}`,
    });

    // Keep only last 24 hours of transfers
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentTransfers = transfers.filter(t => t.timestamp > yesterday);
    securityMetrics.transferPatterns.set(ip, recentTransfers);

    // Check for suspicious patterns
    const totalAmount = recentTransfers.reduce((sum, t) => sum + t.amount, 0);
    const transferCount = recentTransfers.length;

    if (totalAmount > 10000 || transferCount > 20) {
      logSuspiciousActivity(req, 'High volume transfer pattern detected', {
        dailyAmount: totalAmount,
        dailyTransferCount: transferCount,
      });
    }
  }

  return logSecurityEvent(
    SecurityEventTypes.CROSS_CHAIN_TRANSFER,
    eventData,
    req
  );
};

// Invalid input logging
const logInvalidInput = (req, validationErrors) => {
  const eventData = {
    errors: validationErrors.map(error => ({
      field: error.param,
      message: error.msg,
      value:
        typeof error.value === 'string'
          ? error.value.substring(0, 100)
          : error.value,
    })),
    severity: 'LOW',
  };

  return logSecurityEvent(SecurityEventTypes.INVALID_INPUT, eventData, req);
};

// Weather submission logging
const logWeatherSubmission = (req, stationData) => {
  const canonicalObservation = stationData?.canonicalPayload?.observation || {};
  const canonicalSensorCount = Object.values(canonicalObservation).filter(
    value => typeof value === 'number' && Number.isFinite(value)
  ).length;

  const eventData = {
    stationId: stationData.stationId,
    sensorCount: stationData.sensorData
      ? stationData.sensorData.length
      : canonicalSensorCount,
    rewardAmount: stationData.amount,
    hubId: stationData.hubId,
    schemaVersion: stationData?.canonicalPayload?.schema_version,
    legacyFormatDetected: Boolean(stationData?.canonicalTelemetry),
    legacyKeys: stationData?.canonicalTelemetry?.legacyKeys || [],
    severity: 'INFO',
  };

  return logSecurityEvent(
    SecurityEventTypes.WEATHER_SUBMISSION,
    eventData,
    req
  );
};

// Blockchain interaction logging
const logBlockchainInteraction = (req, interactionData) => {
  const eventData = {
    action: interactionData.action,
    contractAddress: interactionData.contractAddress,
    txHash: interactionData.txHash,
    gasUsed: interactionData.gasUsed,
    gasPrice: interactionData.gasPrice,
    severity: 'INFO',
  };

  return logSecurityEvent(
    SecurityEventTypes.BLOCKCHAIN_INTERACTION,
    eventData,
    req
  );
};

// WebSocket connection logging
const logWebSocketConnection = (req, connectionData) => {
  const eventData = {
    action: connectionData.action, // 'connect', 'disconnect', 'subscribe'
    clientId: connectionData.clientId,
    channels: connectionData.channels,
    connectionCount: connectionData.connectionCount,
    severity: 'INFO',
  };

  return logSecurityEvent(
    SecurityEventTypes.WEBSOCKET_CONNECTION,
    eventData,
    req
  );
};

// Security violation logging
const logSecurityViolation = (req, violationType, details) => {
  const eventData = {
    violationType,
    details,
    severity: 'CRITICAL',
  };

  return logSecurityEvent(
    SecurityEventTypes.SECURITY_VIOLATION,
    eventData,
    req
  );
};

// Update security metrics
const updateSecurityMetrics = (eventType, logData) => {
  // Clean up old entries (older than 24 hours)
  const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;

  // This could be expanded to maintain sliding windows for different metrics
};

// Get security statistics
const getSecurityStats = () => {
  return {
    suspiciousIPs: Array.from(securityMetrics.suspiciousIPs),
    blockedIPs: Array.from(securityMetrics.blockedIPs),
    failedAttemptsCount: securityMetrics.failedAttempts.size,
    transferPatternsCount: securityMetrics.transferPatterns.size,
    timestamp: new Date().toISOString(),
  };
};

// Express middleware for automatic request logging
const securityMiddleware = (req, res, next) => {
  // Log all requests to sensitive endpoints
  if (
    req.path.includes('/api/wallet') ||
    req.path.includes('/api/auth') ||
    req.path.includes('/api/crosschain/transfer')
  ) {
    const logData = {
      endpoint: req.path,
      method: req.method,
      contentLength: req.get('content-length'),
      severity: 'INFO',
    };

    logSecurityEvent('API_ACCESS', logData, req);
  }

  next();
};

module.exports = {
  securityLogger,
  SecurityEventTypes,
  logSecurityEvent,
  logFailedAuth,
  logSuspiciousActivity,
  logRateLimitExceeded,
  logCrossChainTransfer,
  logInvalidInput,
  logWeatherSubmission,
  logBlockchainInteraction,
  logWebSocketConnection,
  logSecurityViolation,
  getSecurityStats,
  securityMiddleware,
  securityMetrics,
};
