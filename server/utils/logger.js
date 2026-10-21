/**
 * Logger Configuration
 *
 * This module configures a central logger using winston for consistent
 * logging throughout the application.
 */

const winston = require('winston');
const path = require('path');
const fs = require('fs');
const disableFileLogTransports =
  process.env.DISABLE_FILE_LOG_TRANSPORTS === 'true';
const silentLogs = process.env.SILENT_LOGS === 'true';

// Ensure logs directory exists
const logsDir = path.join(process.cwd(), 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Define log formats
const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp(),
  winston.format.printf(
    ({ level, message, timestamp, ...meta }) =>
      `${timestamp} [${level}] ${message} ${
        Object.keys(meta).length ? JSON.stringify(meta) : ''
      }`
  )
);

const fileFormat = winston.format.combine(
  winston.format.timestamp(),
  winston.format.json()
);

function buildTransports(service = null) {
  const transports = [];

  transports.push(
    new winston.transports.Console({
      format: consoleFormat,
      silent: silentLogs,
    })
  );

  if (!disableFileLogTransports) {
    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'error.log'),
        level: 'error',
        format: fileFormat,
        maxsize: 5242880,
        maxFiles: 5,
      })
    );
    transports.push(
      new winston.transports.File({
        filename: path.join(logsDir, 'combined.log'),
        format: fileFormat,
        maxsize: 5242880,
        maxFiles: 5,
      })
    );

    if (service && service !== 'wrfcoin-core') {
      transports.push(
        new winston.transports.File({
          filename: path.join(logsDir, 'openforis.log'),
          format: fileFormat,
          maxsize: 5242880,
          maxFiles: 3,
          level: 'info',
        })
      );
    }
  }

  return transports;
}

// Create the logger instance
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  defaultMeta: { service: 'wrfcoin-core' },
  transports: buildTransports(),
});

// Add the ability to create child loggers with context
logger.child = childOptions => {
  return winston.createLogger({
    level: logger.level,
    defaultMeta: { ...logger.defaultMeta, ...childOptions },
    transports: logger.transports,
  });
};

// Create logger function for OpenForis compatibility
const createLogger = (service = 'wrfcoin-core') => {
  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: { service },
    transports: buildTransports(service),
  });
};

// Create specialized loggers for different services
const appLogger = createLogger('app');
const governanceLogger = createLogger('governance');
const websocketLogger = createLogger('websocket');
const securityLogger = createLogger('security');
const blockchainLogger = createLogger('blockchain');
const weatherLogger = createLogger('weather');
const walletLogger = createLogger('wallet');
const miningLogger = createLogger('mining');
const nftLogger = createLogger('nft');
const iotLogger = createLogger('iot');
const privacyLogger = createLogger('privacy');
const crossChainLogger = createLogger('cross-chain');
const analyticsLogger = createLogger('analytics');
const computeLogger = createLogger('compute');
const performanceLogger = createLogger('performance');
const storageLogger = createLogger('storage');
const identityLogger = createLogger('identity');
const oracleLogger = createLogger('oracle');
const aimlLogger = createLogger('aiml');

// Helper function to log errors with proper error object handling
const logError = (loggerInstance, message, error, metadata = {}) => {
  const errorDetails = {
    ...metadata,
    error: {
      name: error.name,
      message: error.message,
      stack: process.env.NODE_ENV === 'production' ? undefined : error.stack,
      code: error.code,
    },
  };
  loggerInstance.error(message, errorDetails);
};

// Export both patterns for compatibility
module.exports = createLogger; // Default export as function
module.exports.logger = logger; // Named export for existing code
module.exports.createLogger = createLogger; // Named export for clarity
module.exports.appLogger = appLogger;
module.exports.governanceLogger = governanceLogger;
module.exports.websocketLogger = websocketLogger;
module.exports.securityLogger = securityLogger;
module.exports.blockchainLogger = blockchainLogger;
module.exports.weatherLogger = weatherLogger;
module.exports.walletLogger = walletLogger;
module.exports.miningLogger = miningLogger;
module.exports.nftLogger = nftLogger;
module.exports.iotLogger = iotLogger;
module.exports.privacyLogger = privacyLogger;
module.exports.crossChainLogger = crossChainLogger;
// backend#1086: `server/utils/logger.ts` spells the same logger
// `crosschainLogger`, and `server/routes/bridges.js` already imports that
// spelling. Under plain node this file wins resolution for `utils/logger.js`,
// so it must answer to both names or the winner decides whether a caller works.
module.exports.crosschainLogger = crossChainLogger;
module.exports.analyticsLogger = analyticsLogger;
module.exports.computeLogger = computeLogger;
module.exports.performanceLogger = performanceLogger;
module.exports.storageLogger = storageLogger;
module.exports.identityLogger = identityLogger;
module.exports.oracleLogger = oracleLogger;
module.exports.aimlLogger = aimlLogger;
module.exports.logError = logError;
