/**
 * Comprehensive Error Handling System - Task 67.3 + Task 103.4
 *
 * Centralized error management for the WRFCoin platform with:
 * - Error classification and correlation tracking
 * - Integration with logging infrastructure
 * - Circuit breaker patterns
 * - Retry logic with exponential backoff
 * - HSM security error handling
 * - GraphQL error formatting
 * - Service-level error coordination
 * - Security-focused error sanitization (Task 103.4)
 */

const {
  SDKError,
  FFIError,
  SDKNotInitializedError,
  InvalidParamsError,
  SDKTimeoutError,
} = require('../sdk/errors');
const { DatabaseErrorHandler } = require('../database-error-handler');
const {
  appLogger,
  securityLogger,
  performanceLogger,
  logError,
  logSecurityEvent,
  getCorrelationId,
  generateCorrelationId,
} = require('../utils/logger');

/**
 * Error Sanitization Utility - Task 103.4
 * Prevents information disclosure by sanitizing error messages for client responses
 */
const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Sanitize error for client response - removes sensitive information
 * @param {Error} error - The original error
 * @returns {Object} - Sanitized error object safe for client
 */
function sanitizeErrorForClient(error) {
  // Always log full error internally for debugging
  appLogger.error('[Internal Error Details]', {
    message: error.message,
    stack: error.stack,
    code: error.code,
    sql: error.sql,
    table: error.table,
    constraint: error.constraint,
  });

  // In production, return generic messages
  if (isProduction()) {
    return {
      message: 'An internal error occurred',
      code: error.code || 'INTERNAL_ERROR',
    };
  }

  // In development, still sanitize sensitive database info
  return {
    message: sanitizeDatabaseMessage(error.message || 'An error occurred'),
    code: error.code || 'INTERNAL_ERROR',
  };
}

/**
 * Sanitize database error messages - removes table names, column names, SQL queries
 * @param {string} message - The original error message
 * @returns {string} - Sanitized message
 */
function sanitizeDatabaseMessage(message) {
  if (!message) return 'A database error occurred';

  // Remove SQL query patterns
  let sanitized = message.replace(/SELECT\s+.*?\s+FROM\s+/gi, 'SELECT ... FROM ');
  sanitized = sanitized.replace(/INSERT\s+INTO\s+\w+/gi, 'INSERT INTO [table]');
  sanitized = sanitized.replace(/UPDATE\s+\w+\s+SET/gi, 'UPDATE [table] SET');
  sanitized = sanitized.replace(/DELETE\s+FROM\s+\w+/gi, 'DELETE FROM [table]');

  // Remove table names from common error patterns
  sanitized = sanitized.replace(/relation\s+"[^"]+"/gi, 'relation "[table]"');
  sanitized = sanitized.replace(/table\s+"[^"]+"/gi, 'table "[table]"');
  sanitized = sanitized.replace(/column\s+"[^"]+"/gi, 'column "[column]"');
  sanitized = sanitized.replace(/constraint\s+"[^"]+"/gi, 'constraint "[constraint]"');
  sanitized = sanitized.replace(/index\s+"[^"]+"/gi, 'index "[index]"');

  // Remove file paths
  sanitized = sanitized.replace(/\/[a-zA-Z0-9_\-/.]+\.(js|ts|json)/g, '[file]');
  sanitized = sanitized.replace(/at\s+[^\s]+\s+\([^)]+\)/g, 'at [location]');

  return sanitized;
}

/**
 * WRFCoin Platform Error Classes
 */

/**
 * Base WRFCoin error class with enhanced metadata and correlation tracking
 */
class WrfcoinError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || 'WRFCOIN_ERROR';
    this.category = options.category || 'system';
    this.severity = options.severity || 'medium';
    this.service = options.service || 'unknown';
    this.operation = options.operation;
    this.correlationId = options.correlationId || getCorrelationId();
    this.requestId = options.requestId;
    this.retryable = options.retryable || false;
    this.retryAfter = options.retryAfter;
    this.context = options.context || {};
    this.cause = options.cause;
    this.timestamp = new Date().toISOString();
    this.userId = options.userId;
    this.sessionId = options.sessionId;

    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  toJSON() {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      severity: this.severity,
      service: this.service,
      operation: this.operation,
      correlationId: this.correlationId,
      requestId: this.requestId,
      retryable: this.retryable,
      retryAfter: this.retryAfter,
      context: this.context,
      timestamp: this.timestamp,
      userId: this.userId,
      sessionId: this.sessionId,
      stack: this.stack,
    };
  }
}

/**
 * Validation error for input validation failures
 */
class ValidationError extends WrfcoinError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'VALIDATION_ERROR',
      category: 'validation',
      severity: 'low',
      retryable: false,
    });
    this.validationErrors = options.validationErrors || [];
    this.field = options.field;
  }
}

/**
 * Authentication error for auth failures
 */
class AuthenticationError extends WrfcoinError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'AUTHENTICATION_ERROR',
      category: 'authentication',
      severity: 'medium',
      retryable: false,
    });
    this.authMethod = options.authMethod;
    this.tokenExpired = options.tokenExpired || false;
  }
}

/**
 * Authorization error for permission failures
 */
class AuthorizationError extends WrfcoinError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'AUTHORIZATION_ERROR',
      category: 'authorization',
      severity: 'medium',
      retryable: false,
    });
    this.requiredPermission = options.requiredPermission;
    this.userRoles = options.userRoles || [];
  }
}

/**
 * Network error for external service communication failures
 */
class NetworkError extends WrfcoinError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'NETWORK_ERROR',
      category: 'network',
      severity: 'medium',
      retryable: true,
      retryAfter: options.retryAfter || 1000,
    });
    this.statusCode = options.statusCode;
    this.endpoint = options.endpoint;
    this.method = options.method;
  }
}

/**
 * Database error for database operation failures
 * NOTE: Task 103.4 - query, table, and constraint are logged internally but NOT exposed to clients
 */
class DatabaseError extends WrfcoinError {
  constructor(message, options = {}) {
    // Sanitize the message before calling super
    const sanitizedMessage = sanitizeDatabaseMessage(message);
    super(sanitizedMessage, {
      ...options,
      code: options.code || 'DATABASE_ERROR',
      category: 'database',
      severity: 'high',
      retryable: options.retryable !== false, // Default to retryable
    });
    // Store internally for logging but mark as non-enumerable to prevent JSON serialization
    Object.defineProperty(this, '_internalQuery', {
      value: options.query,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(this, '_internalTable', {
      value: options.table,
      enumerable: false,
      writable: false,
    });
    Object.defineProperty(this, '_internalConstraint', {
      value: options.constraint,
      enumerable: false,
      writable: false,
    });
    // Log internal details for debugging (not exposed to client)
    if (options.query || options.table) {
      appLogger.debug('[DatabaseError Internal Details]', {
        query: options.query,
        table: options.table,
        constraint: options.constraint,
      });
    }
  }
}

/**
 * Business logic error for domain-specific failures
 */
class BusinessError extends WrfcoinError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'BUSINESS_ERROR',
      category: 'business',
      severity: 'medium',
      retryable: false,
    });
    this.businessRule = options.businessRule;
    this.entityId = options.entityId;
    this.entityType = options.entityType;
  }
}

/**
 * External service error for third-party service failures
 */
class ExternalServiceError extends WrfcoinError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'EXTERNAL_SERVICE_ERROR',
      category: 'external',
      severity: 'medium',
      retryable: true,
      retryAfter: options.retryAfter || 2000,
    });
    this.serviceName = options.serviceName;
    this.endpoint = options.endpoint;
    this.responseCode = options.responseCode;
    this.circuitBreakerState = options.circuitBreakerState;
  }
}

/**
 * HSM-specific error for hardware security module operations
 */
class HSMError extends WrfcoinError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'HSM_ERROR',
      category: 'security',
      severity: 'critical',
      retryable: options.retryable || false,
    });
    this.hsmOperation = options.hsmOperation;
    this.keyId = options.keyId;
    this.slotId = options.slotId;
  }
}

/**
 * Cross-chain error for bridge operations
 */
class CrossChainError extends WrfcoinError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'CROSS_CHAIN_ERROR',
      category: 'cross_chain',
      severity: 'medium',
      retryable: true,
      retryAfter: options.retryAfter || 5000,
    });
    this.sourceChain = options.sourceChain;
    this.targetChain = options.targetChain;
    this.bridgeType = options.bridgeType;
    this.amount = options.amount;
  }
}

/**
 * IoT error for sensor and device operations
 */
class IoTError extends WrfcoinError {
  constructor(message, options = {}) {
    super(message, {
      ...options,
      code: options.code || 'IOT_ERROR',
      category: 'iot',
      severity: 'medium',
      retryable: true,
      retryAfter: options.retryAfter || 3000,
    });
    this.deviceId = options.deviceId;
    this.sensorType = options.sensorType;
    this.location = options.location;
    this.dataQuality = options.dataQuality;
  }
}

/**
 * Circuit Breaker Implementation for Service Resilience
 */
class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.recoveryTimeout = options.recoveryTimeout || 30000; // 30 seconds
    this.monitor = options.monitor || ((success, duration) => {});

    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.failureCount = 0;
    this.lastFailureTime = null;
    this.nextAttempt = null;
  }

  async execute(operation, fallback = null) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttempt) {
        const error = new ExternalServiceError('Circuit breaker is OPEN', {
          circuitBreakerState: 'open',
          retryAfter: this.nextAttempt - Date.now(),
        });

        if (fallback) {
          appLogger.warn('Circuit breaker OPEN, executing fallback', {
            operation: 'circuit-breaker',
            circuitBreakerState: 'open',
          });
          return await fallback();
        }
        throw error;
      } else {
        this.state = 'HALF_OPEN';
        appLogger.info('Circuit breaker moving to HALF_OPEN state');
      }
    }

    const startTime = Date.now();
    try {
      const result = await operation();
      this.onSuccess();
      this.monitor(true, Date.now() - startTime);
      return result;
    } catch (error) {
      this.onFailure();
      this.monitor(false, Date.now() - startTime);

      if (fallback && this.state === 'OPEN') {
        appLogger.warn('Circuit breaker opened, executing fallback', {
          operation: 'circuit-breaker',
          circuitBreakerState: 'open',
          error: error.message,
        });
        return await fallback();
      }
      throw error;
    }
  }

  onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
  }

  onFailure() {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttempt = Date.now() + this.recoveryTimeout;

      appLogger.error('Circuit breaker OPENED', {
        operation: 'circuit-breaker',
        failureCount: this.failureCount,
        threshold: this.failureThreshold,
        nextAttempt: this.nextAttempt,
      });
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      lastFailureTime: this.lastFailureTime,
      nextAttempt: this.nextAttempt,
    };
  }
}

/**
 * Retry Logic with Exponential Backoff
 */
class RetryManager {
  constructor(options = {}) {
    this.maxRetries = options.maxRetries || 3;
    this.baseDelay = options.baseDelay || 1000;
    this.maxDelay = options.maxDelay || 30000;
    this.backoffMultiplier = options.backoffMultiplier || 2;
    // backend#1089: was `options.jitter || true`, and `false || true` is true —
    // jitter:false was unsettable and jitter silently always on. This file
    // already spells the intended idiom three times (`!== false` for retryable
    // at 234 and twice at 858/860), so the `||` was a slip, not a design.
    this.jitter = options.jitter !== false;
  }

  async execute(operation, context = {}) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        const result = await operation();

        if (attempt > 1) {
          performanceLogger.info('Operation succeeded after retries', {
            operation: context.operation || 'unknown',
            attempt,
            totalAttempts: this.maxRetries + 1,
            correlationId: context.correlationId,
          });
        }

        return result;
      } catch (error) {
        lastError = error;

        // Don't retry if error is not retryable or we've reached max attempts
        if (!this.isRetryable(error) || attempt > this.maxRetries) {
          break;
        }

        const delay = this.calculateDelay(attempt);

        appLogger.warn(`Operation failed, retrying in ${delay}ms`, {
          operation: context.operation || 'unknown',
          attempt,
          maxRetries: this.maxRetries,
          delay,
          error: error.message,
          correlationId: context.correlationId,
        });

        await this.sleep(delay);
      }
    }

    // If we get here, all retries failed
    const finalError = this.enhanceErrorWithRetryInfo(
      lastError,
      this.maxRetries
    );

    logError(appLogger, 'Operation failed after all retries', finalError, {
      operation: context.operation || 'unknown',
      totalAttempts: this.maxRetries + 1,
      correlationId: context.correlationId,
    });

    throw finalError;
  }

  isRetryable(error) {
    // Check if error has retryable property
    if (error.retryable !== undefined) {
      return error.retryable;
    }

    // Default retry logic for common error types
    if (
      error instanceof NetworkError ||
      error instanceof ExternalServiceError
    ) {
      return true;
    }

    if (error instanceof DatabaseError) {
      // Retry on connection errors, timeouts, deadlocks
      const retryableCodes = [
        'ECONNRESET',
        'ECONNREFUSED',
        'ETIMEDOUT',
        'ER_LOCK_DEADLOCK',
      ];
      return retryableCodes.some(
        code => error.message.includes(code) || error.code === code
      );
    }

    if (error instanceof HSMError) {
      // Only retry on specific HSM errors
      const retryableHsmCodes = [
        'CKR_DEVICE_ERROR',
        'CKR_TOKEN_NOT_RECOGNIZED',
      ];
      return retryableHsmCodes.includes(error.code);
    }

    return false;
  }

  calculateDelay(attempt) {
    let delay = this.baseDelay * Math.pow(this.backoffMultiplier, attempt - 1);
    delay = Math.min(delay, this.maxDelay);

    // Add jitter to prevent thundering herd
    if (this.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5);
    }

    return Math.floor(delay);
  }

  enhanceErrorWithRetryInfo(error, maxRetries) {
    if (error instanceof WrfcoinError) {
      error.context = {
        ...error.context,
        retriesAttempted: maxRetries,
        finalAttempt: true,
      };
      return error;
    }

    // Wrap non-WrfcoinError in a WrfcoinError
    return new WrfcoinError(
      `Operation failed after ${maxRetries} retries: ${error.message}`,
      {
        cause: error,
        category: 'system',
        severity: 'high',
        context: {
          retriesAttempted: maxRetries,
          finalAttempt: true,
          originalError: error.name,
        },
      }
    );
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

/**
 * Error Classification and Recovery Manager
 */
class ErrorClassificationManager {
  static classifyError(error) {
    // If already a WrfcoinError, return as-is
    if (error instanceof WrfcoinError) {
      return error;
    }

    // Handle legacy SDK errors
    if (error instanceof SDKError) {
      return new ExternalServiceError(error.message, {
        code: error.code,
        service: 'rust-sdk',
        cause: error,
        retryable: error instanceof SDKTimeoutError,
      });
    }

    // Database errors
    // Task 103.4: Log SQL query internally but do NOT expose to client
    if (error.code && error.code.startsWith('ER_')) {
      // Log full details internally for debugging
      appLogger.error('[Database Error - Internal Details]', {
        code: error.code,
        sql: error.sql,
        table: error.table,
        originalMessage: error.message,
      });
      return new DatabaseError(error.message, {
        code: error.code,
        // query and table are stored internally but not exposed via JSON
        query: error.sql,
        table: error.table,
        cause: error,
      });
    }

    // Network/HTTP errors
    if (error.response && error.response.status) {
      const isRetryable = [408, 429, 500, 502, 503, 504].includes(
        error.response.status
      );
      return new NetworkError(error.message, {
        statusCode: error.response.status,
        endpoint: error.config?.url,
        method: error.config?.method,
        retryable: isRetryable,
        cause: error,
      });
    }

    // Validation errors
    if (error.name === 'ValidationError' || error.isJoi) {
      return new ValidationError(error.message, {
        validationErrors: error.details || [],
        cause: error,
      });
    }

    // JWT/Auth errors
    if (
      error.name === 'JsonWebTokenError' ||
      error.name === 'TokenExpiredError'
    ) {
      return new AuthenticationError(error.message, {
        tokenExpired: error.name === 'TokenExpiredError',
        cause: error,
      });
    }

    // Default classification
    return new WrfcoinError(error.message, {
      code: error.code || 'UNKNOWN_ERROR',
      category: 'system',
      severity: 'medium',
      cause: error,
    });
  }

  static determineRecoveryAction(error) {
    const recovery = {
      shouldRetry: false,
      retryDelay: 0,
      fallbackAvailable: false,
      // `circuitBreakerAction` was here, initialised to 'none' with a comment
      // enumerating 'none' | 'trip' | 'reset'. The whole field is removed (#1089).
      //
      // It was WRITE-ONLY: set in two places and read in none. No comparison, no
      // conditional, no call site anywhere in the repo consumed it. Of this object
      // only `shouldRetry` and `retryDelay` are consumed (below); the rest of
      // `recovery` is emitted into log payloads and nothing else.
      //
      // It never drove a circuit breaker. The real `CircuitBreaker` opens in
      // `onFailure()` off its own `failureCount` against `failureThreshold`, and has
      // never looked at this field. So a field named for breaker control, sitting in
      // failure handling beside a 'trip' value, implied an integration that has not
      // existed at any point — the reason an operator or reviewer reads this function
      // and assumes breakers trip here.
      //
      // Deleting only the 'trip' assignment was considered and rejected by the owner:
      // it would have left `circuitBreakerAction: 'none'` and its three-value comment
      // in place, still implying the same integration.
      escalate: false,
    };

    if (error.retryable) {
      recovery.shouldRetry = true;
      recovery.retryDelay = error.retryAfter || 1000;
    }

    switch (error.category) {
      case 'network':
      case 'external':
        recovery.shouldRetry = true;
        recovery.fallbackAvailable = true;
        break;

      case 'database':
        recovery.shouldRetry = true;
        recovery.retryDelay = 2000;
        break;

      case 'security':
        recovery.escalate = true;
        recovery.shouldRetry = false;
        break;

      case 'validation':
      case 'authentication':
      case 'authorization':
        recovery.shouldRetry = false;
        break;

      case 'business':
        recovery.shouldRetry = false;
        recovery.escalate = error.severity === 'high';
        break;
    }

    return recovery;
  }
}

/**
 * Service Registry for Circuit Breakers
 */
class ServiceRegistry {
  constructor() {
    this.services = new Map();
    this.defaultConfig = {
      failureThreshold: 5,
      recoveryTimeout: 30000,
      monitor: this.defaultMonitor.bind(this),
    };
  }

  registerService(serviceName, config = {}) {
    const finalConfig = { ...this.defaultConfig, ...config };
    const circuitBreaker = new CircuitBreaker(finalConfig);

    this.services.set(serviceName, {
      circuitBreaker,
      config: finalConfig,
      stats: {
        totalCalls: 0,
        successCalls: 0,
        failureCalls: 0,
        lastCall: null,
      },
    });

    appLogger.info(`Service registered with circuit breaker: ${serviceName}`, {
      operation: 'service-registry',
      service: serviceName,
      config: finalConfig,
    });
  }

  async executeServiceCall(
    serviceName,
    operation,
    fallback = null,
    context = {}
  ) {
    if (!this.services.has(serviceName)) {
      this.registerService(serviceName);
    }

    const service = this.services.get(serviceName);
    const startTime = Date.now();

    try {
      service.stats.totalCalls++;
      service.stats.lastCall = new Date().toISOString();

      const result = await service.circuitBreaker.execute(operation, fallback);

      service.stats.successCalls++;

      performanceLogger.info(`Service call succeeded: ${serviceName}`, {
        operation: `service-call:${serviceName}`,
        duration: Date.now() - startTime,
        circuitBreakerState: service.circuitBreaker.state,
        correlationId: context.correlationId,
      });

      return result;
    } catch (error) {
      service.stats.failureCalls++;

      const classifiedError = ErrorClassificationManager.classifyError(error);
      classifiedError.service = serviceName;
      classifiedError.circuitBreakerState = service.circuitBreaker.state;

      logError(
        appLogger,
        `Service call failed: ${serviceName}`,
        classifiedError,
        {
          operation: `service-call:${serviceName}`,
          duration: Date.now() - startTime,
          correlationId: context.correlationId,
        }
      );

      throw classifiedError;
    }
  }

  getServiceStats(serviceName) {
    const service = this.services.get(serviceName);
    if (!service) return null;

    return {
      ...service.stats,
      circuitBreaker: service.circuitBreaker.getState(),
      successRate:
        service.stats.totalCalls > 0
          ? service.stats.successCalls / service.stats.totalCalls
          : 0,
    };
  }

  getAllServiceStats() {
    const stats = {};
    for (const [serviceName, service] of this.services) {
      stats[serviceName] = this.getServiceStats(serviceName);
    }
    return stats;
  }

  defaultMonitor(success, duration) {
    // Default monitoring implementation
    if (!success && duration > 10000) {
      appLogger.warn('Slow failing service call detected', {
        operation: 'service-monitor',
        duration,
        success,
      });
    }
  }
}

// Global service registry instance
const serviceRegistry = new ServiceRegistry();

/**
 * Centralized Error Handler Middleware
 */
function createErrorHandler(options = {}) {
  const retryManager = new RetryManager(options.retry || {});
  const enableSecurityMasking = options.enableSecurityMasking !== false;
  const enableStackTrace =
    options.enableStackTrace !== false && process.env.NODE_ENV !== 'production';

  return (error, req, res, next) => {
    const startTime = Date.now();
    const correlationId = req.correlationId || getCorrelationId();

    // Classify the error
    const classifiedError = ErrorClassificationManager.classifyError(error);
    classifiedError.correlationId = correlationId;
    classifiedError.requestId = req.id;
    classifiedError.userId = req.user?.id;
    classifiedError.sessionId = req.sessionID;

    // Add request context
    classifiedError.context = {
      ...classifiedError.context,
      method: req.method,
      path: req.path,
      ip: req.ip || req.connection?.remoteAddress,
      userAgent: req.get('User-Agent'),
    };

    // Determine recovery action
    const recovery =
      ErrorClassificationManager.determineRecoveryAction(classifiedError);

    // Log the error with appropriate level
    const logLevel =
      classifiedError.severity === 'critical'
        ? 'error'
        : classifiedError.severity === 'high'
          ? 'error'
          : 'warn';

    logError(appLogger, 'Request processing error', classifiedError, {
      operation: `${req.method}:${req.path}`,
      recovery,
      performance: {
        responseTime: Date.now() - startTime,
      },
    });

    // Security event logging for security-related errors
    if (
      classifiedError.category === 'security' ||
      classifiedError.category === 'authentication'
    ) {
      logSecurityEvent(
        'security_error',
        {
          errorCode: classifiedError.code,
          errorMessage: classifiedError.message,
          recovery,
        },
        'error',
        classifiedError.userId,
        classifiedError.context.ip
      );
    }

    // Prepare response based on error type and security settings
    const response = {
      error: {
        code: classifiedError.code,
        message:
          enableSecurityMasking && classifiedError.category === 'security'
            ? 'Security error occurred'
            : classifiedError.message,
        category: classifiedError.category,
        correlationId: classifiedError.correlationId,
        timestamp: classifiedError.timestamp,
      },
    };

    // Add retry information if applicable
    if (recovery.shouldRetry) {
      response.error.retryable = true;
      response.error.retryAfter = recovery.retryDelay;
    }

    // Add stack trace ONLY in development - Task 103.4 security fix
    if (enableStackTrace && classifiedError.stack && !isProduction()) {
      response.error.stack = classifiedError.stack.split('\n');
    }

    // Add validation errors if present
    if (
      classifiedError instanceof ValidationError &&
      classifiedError.validationErrors.length > 0
    ) {
      response.error.validationErrors = classifiedError.validationErrors;
    }

    // Determine HTTP status code
    let statusCode = 500;
    switch (classifiedError.category) {
      case 'validation':
        statusCode = 400;
        break;
      case 'authentication':
        statusCode = 401;
        break;
      case 'authorization':
        statusCode = 403;
        break;
      case 'business':
        statusCode = 422;
        break;
      case 'rate_limit':
        statusCode = 429;
        if (classifiedError.retryAfter) {
          res.set('Retry-After', Math.ceil(classifiedError.retryAfter / 1000));
        }
        break;
      case 'network':
      case 'external':
        statusCode = 502;
        break;
      case 'database':
        statusCode = 503;
        break;
      default:
        statusCode = 500;
    }

    // Set correlation ID header
    res.set('X-Correlation-ID', correlationId);

    // Send response
    res.status(statusCode).json(response);
  };
}

/**
 * Express middleware for adding correlation ID and error handling setup
 */
function setupErrorHandling(options = {}) {
  return (req, res, next) => {
    // Add correlation ID if not present
    if (!req.correlationId) {
      req.correlationId =
        req.get('X-Correlation-ID') || generateCorrelationId();
    }

    // Add error handling utilities to request
    req.throwWrfcoinError = (message, errorOptions = {}) => {
      throw new WrfcoinError(message, {
        ...errorOptions,
        correlationId: req.correlationId,
        requestId: req.id,
        userId: req.user?.id,
        sessionId: req.sessionID,
      });
    };

    req.throwValidationError = (message, validationErrors = []) => {
      throw new ValidationError(message, {
        validationErrors,
        correlationId: req.correlationId,
        requestId: req.id,
      });
    };

    req.throwAuthError = (message, authOptions = {}) => {
      throw new AuthenticationError(message, {
        ...authOptions,
        correlationId: req.correlationId,
        requestId: req.id,
      });
    };

    next();
  };
}

module.exports = {
  // Error classes
  WrfcoinError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  NetworkError,
  DatabaseError,
  BusinessError,
  ExternalServiceError,
  HSMError,
  CrossChainError,
  IoTError,

  // Utility classes
  CircuitBreaker,
  RetryManager,
  ErrorClassificationManager,
  ServiceRegistry,

  // Middleware
  createErrorHandler,
  setupErrorHandling,

  // Error sanitization utilities - Task 103.4
  sanitizeErrorForClient,
  sanitizeDatabaseMessage,
  isProduction,

  // Global instances
  serviceRegistry,
};
