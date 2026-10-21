/**
 * @deprecated DEPRECATED: Use the unified Winston logger instead.
 *
 * This legacy logger wraps console.log and lacks:
 * - Structured JSON logging
 * - Log file rotation
 * - Sensitive data masking
 * - Correlation IDs for distributed tracing
 * - Service-specific log categorization
 *
 * MIGRATION GUIDE:
 * ================
 * Replace imports from '../utils/logger' with '../server/utils/logger':
 *
 * BEFORE:
 *   const { createLogger, log } = require('../utils/logger');
 *   const logger = createLogger('my-module');
 *   logger.info('message', { data: 'value' });
 *
 * AFTER:
 *   import { appLogger } from '../server/utils/logger.js';
 *   // Or use specialized loggers based on context:
 *   // securityLogger, graphqlLogger, crosschainLogger, iotLogger,
 *   // weatherLogger, walletLogger, governanceLogger, computeLogger,
 *   // aimlLogger, storageLogger, blockchainLogger
 *   appLogger.info('message', { operation: 'my-operation', data: 'value' });
 *
 * Available loggers in ../server/utils/logger.ts:
 * - appLogger: General application logging
 * - securityLogger: Security events and audit logs
 * - graphqlLogger: GraphQL operations
 * - crosschainLogger: Cross-chain bridge operations
 * - iotLogger: IoT sensor data
 * - weatherLogger: Weather data processing
 * - walletLogger: Wallet operations
 * - governanceLogger: DAO governance
 * - computeLogger: Distributed computing
 * - aimlLogger: AI/ML operations
 * - storageLogger: Storage network operations
 * - blockchainLogger: Blockchain operations
 *
 * Helper functions:
 * - logError(logger, message, error, metadata)
 * - logSecurityEvent(event, details, level, userId, ip)
 * - logPerformanceMetrics(operation, duration, memoryUsage, additionalMetrics)
 */

// Emit deprecation warning once per process
let deprecationWarningEmitted = false;

const emitDeprecationWarning = () => {
  if (!deprecationWarningEmitted && process.env.NODE_ENV !== 'test') {
    deprecationWarningEmitted = true;
    console.warn(
      '\x1b[33m%s\x1b[0m', // Yellow color
      '[DEPRECATION WARNING] backend/utils/logger.js is deprecated. ' +
      'Migrate to backend/server/utils/logger.ts for structured logging, ' +
      'sensitive data masking, and distributed tracing support.'
    );
  }
};

const createLogger = moduleName => {
  emitDeprecationWarning();

  return {
    info: function (message, extra) {
      console.log(`[INFO] [${moduleName}] ${message}`, extra || '');
    },
    error: function (message, extra) {
      console.error(`[ERROR] [${moduleName}] ${message}`, extra || '');
    },
    warn: function (message, extra) {
      console.warn(`[WARN] [${moduleName}] ${message}`, extra || '');
    },
    debug: function (message, extra) {
      console.log(`[DEBUG] [${moduleName}] ${message}`, extra || '');
    },
  };
};

const log = {
  info: function (message) {
    emitDeprecationWarning();
    console.log(`[INFO] ${message}`);
  },
  debug: function (message) {
    emitDeprecationWarning();
    console.log(`[DEBUG] ${message}`);
  },
  warn: function (message) {
    emitDeprecationWarning();
    console.warn(`[WARN] ${message}`);
  },
  error: function (message) {
    emitDeprecationWarning();
    console.error(`[ERROR] ${message}`);
  },
};

// Create default logger instance
const logger = createLogger('default');

// ESM exports only (CommonJS module.exports removed for ES module compatibility)
// Named exports for specific imports
export { createLogger, log, logger };
// Default export matches module.exports shape for `import logger from ...` consumers
export default { createLogger, log, logger };
