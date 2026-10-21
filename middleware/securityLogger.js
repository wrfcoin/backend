/**
 * Security Logging Configuration
 * Comprehensive logging for security events
 */

const winston = require('winston');
const DailyRotateFile = require('winston-daily-rotate-file');

// Security event logger
const securityLogger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'wrfcoin-security' },
  transports: [
    new DailyRotateFile({
      filename: 'logs/security-%DATE%.log',
      datePattern: 'YYYY-MM-DD',
      maxSize: '20m',
      maxFiles: '14d',
    }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Security event types
const logSecurityEvent = (eventType, details, req = null) => {
  const logData = {
    eventType,
    timestamp: new Date().toISOString(),
    details,
    ip: req ? req.ip : null,
    userAgent: req ? req.get('User-Agent') : null,
  };

  securityLogger.info('Security Event', logData);
};

// Specific logging functions
const logFailedAuth = (ip, reason) => {
  logSecurityEvent('FAILED_AUTH', { ip, reason });
};

const logSuspiciousActivity = (activity, details) => {
  logSecurityEvent('SUSPICIOUS_ACTIVITY', { activity, details });
};

const logRateLimitExceeded = (ip, endpoint) => {
  logSecurityEvent('RATE_LIMIT_EXCEEDED', { ip, endpoint });
};

const logCrossChainTransfer = (fromChain, toChain, amount, transferId) => {
  logSecurityEvent('CROSS_CHAIN_TRANSFER', {
    fromChain,
    toChain,
    amount,
    transferId,
  });
};

module.exports = {
  securityLogger,
  logSecurityEvent,
  logFailedAuth,
  logSuspiciousActivity,
  logRateLimitExceeded,
  logCrossChainTransfer,
};
