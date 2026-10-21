/**
 * Comprehensive Error Handling Framework for Wrfcoin Core
 * Provides centralized error management, logging, and recovery mechanisms
 */

const winston = require('winston');
const path = require('path');
const {
  GracefulShutdown,
  ShutdownPriority,
} = require('../shared/graceful-shutdown/index.js');

// Custom Error Classes
class WrfcoinError extends Error {
  constructor(
    message,
    code = 'WRFCOIN_ERROR',
    statusCode = 500,
    isOperational = true
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    this.timestamp = new Date().toISOString();

    Error.captureStackTrace(this, this.constructor);
  }
}

class ValidationError extends WrfcoinError {
  constructor(message, field = null) {
    super(message, 'VALIDATION_ERROR', 400);
    this.field = field;
  }
}

class AuthenticationError extends WrfcoinError {
  constructor(message = 'Authentication failed') {
    super(message, 'AUTH_ERROR', 401);
  }
}

class AuthorizationError extends WrfcoinError {
  constructor(message = 'Insufficient permissions') {
    super(message, 'AUTHORIZATION_ERROR', 403);
  }
}

class NotFoundError extends WrfcoinError {
  constructor(resource = 'Resource') {
    super(`${resource} not found`, 'NOT_FOUND', 404);
  }
}

class ConflictError extends WrfcoinError {
  constructor(message = 'Resource conflict') {
    super(message, 'CONFLICT_ERROR', 409);
  }
}

class RateLimitError extends WrfcoinError {
  constructor(message = 'Rate limit exceeded') {
    super(message, 'RATE_LIMIT_ERROR', 429);
  }
}

class DatabaseError extends WrfcoinError {
  constructor(message = 'Database operation failed') {
    super(message, 'DATABASE_ERROR', 500);
  }
}

class BlockchainError extends WrfcoinError {
  constructor(message = 'Blockchain operation failed') {
    super(message, 'BLOCKCHAIN_ERROR', 500);
  }
}

class CrossChainError extends WrfcoinError {
  constructor(message = 'Cross-chain operation failed') {
    super(message, 'CROSS_CHAIN_ERROR', 500);
  }
}

// Error Logger Configuration
const errorLogger = winston.createLogger({
  level: 'error',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    winston.format.json()
  ),
  defaultMeta: { service: 'wrfcoin-core' },
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/error.log'),
      maxsize: 5242880, // 5MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: path.join(__dirname, '../logs/combined.log'),
      maxsize: 5242880,
      maxFiles: 3,
    }),
  ],
});

// Add console transport in development
if (process.env.NODE_ENV !== 'production') {
  errorLogger.add(
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      ),
    })
  );
}

class ErrorHandler {
  constructor() {
    this.logger = errorLogger;
    this.errorCounts = new Map();
    this.circuitBreakers = new Map();
  }

  // Log error with context
  logError(error, context = {}) {
    const errorInfo = {
      message: error.message,
      code: error.code || 'UNKNOWN_ERROR',
      stack: error.stack,
      statusCode: error.statusCode || 500,
      isOperational: error.isOperational || false,
      timestamp: error.timestamp || new Date().toISOString(),
      context: context,
      pid: process.pid,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
    };

    this.logger.error('Application Error', errorInfo);

    // Track error frequency
    const errorKey = `${error.code || 'UNKNOWN'}:${error.message}`;
    this.errorCounts.set(errorKey, (this.errorCounts.get(errorKey) || 0) + 1);

    return errorInfo;
  }

  // Express error middleware
  expressErrorHandler() {
    return (error, req, res, next) => {
      const context = {
        url: req.url,
        method: req.method,
        headers: req.headers,
        userAgent: req.get('User-Agent'),
        ip: req.ip,
        requestId: req.id || this.generateRequestId(),
      };

      const errorInfo = this.logError(error, context);

      // Don't expose internal errors in production
      const isProduction = process.env.NODE_ENV === 'production';
      const isOperational = error.isOperational || false;

      const response = {
        success: false,
        error: {
          code: error.code || 'INTERNAL_ERROR',
          message:
            isProduction && !isOperational
              ? 'Internal server error'
              : error.message,
          timestamp: errorInfo.timestamp,
        },
      };

      // Add additional info for operational errors
      if (isOperational) {
        if (error.field) response.error.field = error.field;
        if (error.details) response.error.details = error.details;
      }

      // Add request ID for tracking
      if (context.requestId) {
        response.error.requestId = context.requestId;
      }

      const statusCode = error.statusCode || 500;
      res.status(statusCode).json(response);
    };
  }

  // Async wrapper for route handlers
  asyncWrapper(fn) {
    return (req, res, next) => {
      Promise.resolve(fn(req, res, next)).catch(next);
    };
  }

  // Circuit breaker for external services
  createCircuitBreaker(serviceName, options = {}) {
    const config = {
      failureThreshold: options.failureThreshold || 5,
      resetTimeout: options.resetTimeout || 60000, // 1 minute
      monitoringPeriod: options.monitoringPeriod || 300000, // 5 minutes
      ...options,
    };

    const breaker = {
      state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
      failures: 0,
      lastFailureTime: null,
      nextAttempt: null,
      successCount: 0,
      config,
    };

    this.circuitBreakers.set(serviceName, breaker);
    return breaker;
  }

  // Check circuit breaker state
  checkCircuitBreaker(serviceName) {
    const breaker = this.circuitBreakers.get(serviceName);
    if (!breaker) return { allowed: true, state: 'CLOSED' };

    const now = Date.now();

    // Check if we should attempt to reset
    if (
      breaker.state === 'OPEN' &&
      breaker.nextAttempt &&
      now >= breaker.nextAttempt
    ) {
      breaker.state = 'HALF_OPEN';
      breaker.successCount = 0;
    }

    // Determine if request is allowed
    const allowed = breaker.state !== 'OPEN';

    return {
      allowed,
      state: breaker.state,
      failures: breaker.failures,
      successCount: breaker.successCount,
    };
  }

  // Record circuit breaker success
  recordSuccess(serviceName) {
    const breaker = this.circuitBreakers.get(serviceName);
    if (!breaker) return;

    if (breaker.state === 'HALF_OPEN') {
      breaker.successCount++;
      if (breaker.successCount >= 3) {
        breaker.state = 'CLOSED';
        breaker.failures = 0;
        breaker.lastFailureTime = null;
        breaker.nextAttempt = null;
      }
    } else if (breaker.state === 'CLOSED') {
      breaker.failures = Math.max(0, breaker.failures - 1);
    }
  }

  // Record circuit breaker failure
  recordFailure(serviceName, error = null) {
    const breaker = this.circuitBreakers.get(serviceName);
    if (!breaker) return;

    breaker.failures++;
    breaker.lastFailureTime = Date.now();

    if (breaker.failures >= breaker.config.failureThreshold) {
      breaker.state = 'OPEN';
      breaker.nextAttempt = Date.now() + breaker.config.resetTimeout;

      this.logError(
        new WrfcoinError(
          `Circuit breaker opened for service: ${serviceName}`,
          'CIRCUIT_BREAKER_OPEN',
          503
        ),
        { serviceName, failures: breaker.failures }
      );
    }
  }

  // Graceful shutdown handler
  setupGracefulShutdown() {
    const shutdown = GracefulShutdown.getInstance();

    // Register HTTP server close handler
    shutdown.registerHandler({
      name: 'http-server',
      priority: ShutdownPriority.DRAIN_HTTP_CONNECTIONS,
      timeout: 10000,
      handler: async () => {
        if (global.server) {
          return new Promise((resolve, reject) => {
            global.server.close(err => {
              if (err) {
                reject(err);
              } else {
                console.log('HTTP server closed.');
                resolve();
              }
            });
          });
        }
      },
    });

    // Register database/cache connection close handler
    shutdown.registerHandler({
      name: 'close-connections',
      priority: ShutdownPriority.CLOSE_DATABASE,
      timeout: 5000,
      handler: async () => {
        await this.closeConnections();
        console.log('All connections closed.');
      },
    });

    // Set up signal handlers via GracefulShutdown
    shutdown.setupSignalHandlers();
  }

  // Close all connections
  async closeConnections() {
    const promises = [];

    // Close database connections if available
    if (global.dbConnection) {
      promises.push(global.dbConnection.close());
    }

    // Close Redis connections if available
    if (global.redisClient) {
      promises.push(global.redisClient.quit());
    }

    return Promise.all(promises);
  }

  // Unhandled rejection handler
  setupUnhandledRejectionHandler() {
    process.on('unhandledRejection', (reason, promise) => {
      const error = new WrfcoinError(
        `Unhandled Rejection: ${reason}`,
        'UNHANDLED_REJECTION',
        500,
        false
      );

      this.logError(error, {
        promise: promise.toString(),
        reason: reason?.toString(),
      });

      // In production, trigger graceful shutdown instead of direct process.exit
      if (process.env.NODE_ENV === 'production') {
        const shutdown = GracefulShutdown.getInstance();
        shutdown.shutdown('unhandledRejection');
      }
    });
  }

  // Uncaught exception handler
  setupUncaughtExceptionHandler() {
    process.on('uncaughtException', error => {
      const wrfError = new WrfcoinError(
        `Uncaught Exception: ${error.message}`,
        'UNCAUGHT_EXCEPTION',
        500,
        false
      );

      this.logError(wrfError, { originalStack: error.stack });

      // Trigger graceful shutdown instead of direct process.exit
      const shutdown = GracefulShutdown.getInstance();
      shutdown.shutdown('uncaughtException');
    });
  }

  // Generate unique request ID
  generateRequestId() {
    return `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  // Get error statistics
  getErrorStatistics() {
    const stats = {
      totalErrors: 0,
      errorsByType: {},
      circuitBreakers: {},
      topErrors: [],
    };

    // Calculate error statistics
    for (const [errorKey, count] of this.errorCounts.entries()) {
      stats.totalErrors += count;
      const [code] = errorKey.split(':');
      stats.errorsByType[code] = (stats.errorsByType[code] || 0) + count;
    }

    // Get top 10 errors
    stats.topErrors = Array.from(this.errorCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([error, count]) => ({ error, count }));

    // Circuit breaker status
    for (const [service, breaker] of this.circuitBreakers.entries()) {
      stats.circuitBreakers[service] = {
        state: breaker.state,
        failures: breaker.failures,
        lastFailureTime: breaker.lastFailureTime,
      };
    }

    return stats;
  }

  // Initialize all error handling
  initialize() {
    // Get GracefulShutdown instance and configure it
    const shutdown = GracefulShutdown.getInstance({
      enableLogging: true,
      globalTimeout: 30000,
      defaultHandlerTimeout: 5000,
      exitCodeSuccess: 0,
      exitCodeError: 1,
    });

    // Register error log flush handler to ensure logs are persisted before exit
    shutdown.registerHandler({
      name: 'flush-error-logs',
      priority: ShutdownPriority.FLUSH_LOGS,
      timeout: 3000,
      handler: async () => {
        // Ensure winston transports are flushed
        await new Promise(resolve => {
          this.logger.on('finish', resolve);
          this.logger.end();
        });
      },
    });

    this.setupGracefulShutdown();
    this.setupUnhandledRejectionHandler();
    this.setupUncaughtExceptionHandler();

    console.log('Error handling framework initialized with GracefulShutdown integration');
  }
}

// Create singleton instance
const errorHandler = new ErrorHandler();

module.exports = {
  ErrorHandler,
  errorHandler,
  WrfcoinError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  DatabaseError,
  BlockchainError,
  CrossChainError,
};
