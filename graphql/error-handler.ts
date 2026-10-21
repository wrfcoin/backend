/**
 * GraphQL Error Handler
 * Centralized error handling and formatting for GraphQL operations
 */

import { GraphQLError } from 'graphql';
import { logger } from '../utils/logger.js';
import crypto from 'crypto';

// Error types
export enum ErrorCode {
  AUTHENTICATION_ERROR = 'AUTHENTICATION_ERROR',
  AUTHORIZATION_ERROR = 'AUTHORIZATION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  NOT_FOUND = 'NOT_FOUND',
  DUPLICATE_ERROR = 'DUPLICATE_ERROR',
  RATE_LIMIT_ERROR = 'RATE_LIMIT_ERROR',
  BLOCKCHAIN_ERROR = 'BLOCKCHAIN_ERROR',
  DATABASE_ERROR = 'DATABASE_ERROR',
  EXTERNAL_SERVICE_ERROR = 'EXTERNAL_SERVICE_ERROR',
  INTERNAL_ERROR = 'INTERNAL_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  TIMEOUT_ERROR = 'TIMEOUT_ERROR',
  RESOURCE_EXHAUSTED = 'RESOURCE_EXHAUSTED',
  CONTRACT_EXECUTION_ERROR = 'CONTRACT_EXECUTION_ERROR',
  QUERY_COMPLEXITY_ERROR = 'QUERY_COMPLEXITY_ERROR',
}

// Error severity levels
export enum ErrorSeverity {
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
  CRITICAL = 'CRITICAL',
}

// Error categories for different handling strategies
export enum ErrorCategory {
  CLIENT_ERROR = 'CLIENT_ERROR',
  SERVER_ERROR = 'SERVER_ERROR',
  EXTERNAL_ERROR = 'EXTERNAL_ERROR',
  BLOCKCHAIN_ERROR = 'BLOCKCHAIN_ERROR',
}

// Error messages
const ERROR_MESSAGES = {
  [ErrorCode.AUTHENTICATION_ERROR]: 'Authentication required',
  [ErrorCode.AUTHORIZATION_ERROR]: 'Insufficient permissions',
  [ErrorCode.VALIDATION_ERROR]: 'Invalid input provided',
  [ErrorCode.NOT_FOUND]: 'Resource not found',
  [ErrorCode.DUPLICATE_ERROR]: 'Resource already exists',
  [ErrorCode.RATE_LIMIT_ERROR]: 'Rate limit exceeded',
  [ErrorCode.BLOCKCHAIN_ERROR]: 'Blockchain operation failed',
  [ErrorCode.DATABASE_ERROR]: 'Database operation failed',
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: 'External service unavailable',
  [ErrorCode.INTERNAL_ERROR]: 'Internal server error',
  [ErrorCode.NETWORK_ERROR]: 'Network connection failed',
  [ErrorCode.TIMEOUT_ERROR]: 'Operation timed out',
  [ErrorCode.RESOURCE_EXHAUSTED]: 'System resources exhausted',
  [ErrorCode.CONTRACT_EXECUTION_ERROR]: 'Smart contract execution failed',
  [ErrorCode.QUERY_COMPLEXITY_ERROR]: 'Query too complex',
};

// Error severity mapping
const ERROR_SEVERITY_MAP = {
  [ErrorCode.AUTHENTICATION_ERROR]: ErrorSeverity.MEDIUM,
  [ErrorCode.AUTHORIZATION_ERROR]: ErrorSeverity.MEDIUM,
  [ErrorCode.VALIDATION_ERROR]: ErrorSeverity.LOW,
  [ErrorCode.NOT_FOUND]: ErrorSeverity.LOW,
  [ErrorCode.DUPLICATE_ERROR]: ErrorSeverity.LOW,
  [ErrorCode.RATE_LIMIT_ERROR]: ErrorSeverity.MEDIUM,
  [ErrorCode.BLOCKCHAIN_ERROR]: ErrorSeverity.HIGH,
  [ErrorCode.DATABASE_ERROR]: ErrorSeverity.HIGH,
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: ErrorSeverity.MEDIUM,
  [ErrorCode.INTERNAL_ERROR]: ErrorSeverity.CRITICAL,
  [ErrorCode.NETWORK_ERROR]: ErrorSeverity.MEDIUM,
  [ErrorCode.TIMEOUT_ERROR]: ErrorSeverity.MEDIUM,
  [ErrorCode.RESOURCE_EXHAUSTED]: ErrorSeverity.HIGH,
  [ErrorCode.CONTRACT_EXECUTION_ERROR]: ErrorSeverity.HIGH,
  [ErrorCode.QUERY_COMPLEXITY_ERROR]: ErrorSeverity.MEDIUM,
};

// Error category mapping
const ERROR_CATEGORY_MAP = {
  [ErrorCode.AUTHENTICATION_ERROR]: ErrorCategory.CLIENT_ERROR,
  [ErrorCode.AUTHORIZATION_ERROR]: ErrorCategory.CLIENT_ERROR,
  [ErrorCode.VALIDATION_ERROR]: ErrorCategory.CLIENT_ERROR,
  [ErrorCode.NOT_FOUND]: ErrorCategory.CLIENT_ERROR,
  [ErrorCode.DUPLICATE_ERROR]: ErrorCategory.CLIENT_ERROR,
  [ErrorCode.RATE_LIMIT_ERROR]: ErrorCategory.CLIENT_ERROR,
  [ErrorCode.BLOCKCHAIN_ERROR]: ErrorCategory.BLOCKCHAIN_ERROR,
  [ErrorCode.DATABASE_ERROR]: ErrorCategory.SERVER_ERROR,
  [ErrorCode.EXTERNAL_SERVICE_ERROR]: ErrorCategory.EXTERNAL_ERROR,
  [ErrorCode.INTERNAL_ERROR]: ErrorCategory.SERVER_ERROR,
  [ErrorCode.NETWORK_ERROR]: ErrorCategory.EXTERNAL_ERROR,
  [ErrorCode.TIMEOUT_ERROR]: ErrorCategory.EXTERNAL_ERROR,
  [ErrorCode.RESOURCE_EXHAUSTED]: ErrorCategory.SERVER_ERROR,
  [ErrorCode.CONTRACT_EXECUTION_ERROR]: ErrorCategory.BLOCKCHAIN_ERROR,
  [ErrorCode.QUERY_COMPLEXITY_ERROR]: ErrorCategory.CLIENT_ERROR,
};

// Retry-able error codes
const RETRYABLE_ERRORS = new Set([
  ErrorCode.NETWORK_ERROR,
  ErrorCode.TIMEOUT_ERROR,
  ErrorCode.EXTERNAL_SERVICE_ERROR,
  ErrorCode.DATABASE_ERROR,
]);

// Error context interface for better error tracking
interface ErrorContext {
  requestId?: string;
  userId?: string;
  operationType?: string;
  field?: string;
  variables?: Record<string, any>;
  correlationId?: string;
  clientIP?: string;
  userAgent?: string;
  timestamp?: Date;
  retryCount?: number;
  queryComplexity?: number;
  // Additional context properties
  resource?: string;
  transactionHash?: string;
  limit?: number;
  window?: string;
  query?: string;
  operation?: string;
  endpoint?: string;
  timeoutMs?: number;
}

// Custom GraphQL Error class with enhanced features
export class WrfcoinError extends GraphQLError {
  public readonly code: ErrorCode;
  public readonly severity: ErrorSeverity;
  public readonly category: ErrorCategory;
  public readonly isRetryable: boolean;
  public readonly correlationId: string;
  public readonly context?: ErrorContext;

  constructor(
    message: string,
    code: ErrorCode,
    context?: ErrorContext,
    extensions?: Record<string, any>
  ) {
    const correlationId = crypto.randomBytes(8).toString('hex');
    const severity = ERROR_SEVERITY_MAP[code];
    const category = ERROR_CATEGORY_MAP[code];
    const isRetryable = RETRYABLE_ERRORS.has(code);

    super(message, {
      extensions: {
        code,
        severity,
        category,
        isRetryable,
        correlationId,
        timestamp: new Date().toISOString(),
        ...context,
        ...extensions,
      },
    });

    this.code = code;
    this.severity = severity;
    this.category = category;
    this.isRetryable = isRetryable;
    this.correlationId = correlationId;
    this.context = context;
  }
}

// Enhanced error classification with better detection patterns
function classifyError(
  error: any,
  message: string
): { code: ErrorCode; userMessage: string } {
  const lowerMessage = message.toLowerCase();

  // Authentication errors
  if (
    lowerMessage.includes('unauthorized') ||
    lowerMessage.includes('authentication required') ||
    lowerMessage.includes('invalid token') ||
    lowerMessage.includes('jwt') ||
    error?.code === 'UNAUTHENTICATED'
  ) {
    return {
      code: ErrorCode.AUTHENTICATION_ERROR,
      userMessage: ERROR_MESSAGES[ErrorCode.AUTHENTICATION_ERROR],
    };
  }

  // Authorization errors
  if (
    lowerMessage.includes('permission') ||
    lowerMessage.includes('forbidden') ||
    lowerMessage.includes('access denied') ||
    lowerMessage.includes('insufficient permissions') ||
    error?.code === 'FORBIDDEN'
  ) {
    return {
      code: ErrorCode.AUTHORIZATION_ERROR,
      userMessage: ERROR_MESSAGES[ErrorCode.AUTHORIZATION_ERROR],
    };
  }

  // Validation errors
  if (
    lowerMessage.includes('validation') ||
    lowerMessage.includes('invalid input') ||
    lowerMessage.includes('bad request') ||
    lowerMessage.includes('malformed') ||
    error?.code === 'BAD_USER_INPUT'
  ) {
    return { code: ErrorCode.VALIDATION_ERROR, userMessage: message };
  }

  // Not found errors
  if (
    lowerMessage.includes('not found') ||
    lowerMessage.includes('does not exist') ||
    lowerMessage.includes('erc721: invalid token id') ||
    error?.code === 'NOT_FOUND'
  ) {
    return {
      code: ErrorCode.NOT_FOUND,
      userMessage: ERROR_MESSAGES[ErrorCode.NOT_FOUND],
    };
  }

  // Duplicate errors
  if (
    lowerMessage.includes('already exists') ||
    lowerMessage.includes('duplicate') ||
    lowerMessage.includes('conflict') ||
    error?.code === 'DUPLICATE'
  ) {
    return {
      code: ErrorCode.DUPLICATE_ERROR,
      userMessage: ERROR_MESSAGES[ErrorCode.DUPLICATE_ERROR],
    };
  }

  // Network/timeout errors
  if (
    lowerMessage.includes('timeout') ||
    lowerMessage.includes('timed out') ||
    lowerMessage.includes('network error') ||
    lowerMessage.includes('connection failed') ||
    error?.code === 'TIMEOUT'
  ) {
    return {
      code: ErrorCode.TIMEOUT_ERROR,
      userMessage: ERROR_MESSAGES[ErrorCode.TIMEOUT_ERROR],
    };
  }

  // Database errors
  if (
    lowerMessage.includes('database') ||
    lowerMessage.includes('sql') ||
    lowerMessage.includes('connection') ||
    lowerMessage.includes('query failed') ||
    error?.name === 'DatabaseError' ||
    error?.code?.startsWith('P')
  ) {
    // Prisma error codes start with P
    return {
      code: ErrorCode.DATABASE_ERROR,
      userMessage: ERROR_MESSAGES[ErrorCode.DATABASE_ERROR],
    };
  }

  // Blockchain/contract errors
  if (
    lowerMessage.includes('blockchain') ||
    lowerMessage.includes('contract') ||
    lowerMessage.includes('transaction') ||
    lowerMessage.includes('revert') ||
    lowerMessage.includes('gas') ||
    lowerMessage.includes('nonce') ||
    error?.code === 'CALL_EXCEPTION'
  ) {
    return {
      code: ErrorCode.CONTRACT_EXECUTION_ERROR,
      userMessage: ERROR_MESSAGES[ErrorCode.CONTRACT_EXECUTION_ERROR],
    };
  }

  // Rate limiting
  if (
    lowerMessage.includes('rate limit') ||
    lowerMessage.includes('too many requests') ||
    error?.code === 'RATE_LIMITED'
  ) {
    return {
      code: ErrorCode.RATE_LIMIT_ERROR,
      userMessage: ERROR_MESSAGES[ErrorCode.RATE_LIMIT_ERROR],
    };
  }

  // Resource exhaustion
  if (
    lowerMessage.includes('resource') ||
    lowerMessage.includes('memory') ||
    lowerMessage.includes('cpu') ||
    lowerMessage.includes('quota') ||
    error?.code === 'RESOURCE_EXHAUSTED'
  ) {
    return {
      code: ErrorCode.RESOURCE_EXHAUSTED,
      userMessage: ERROR_MESSAGES[ErrorCode.RESOURCE_EXHAUSTED],
    };
  }

  // Default to internal error
  return {
    code: ErrorCode.INTERNAL_ERROR,
    userMessage: ERROR_MESSAGES[ErrorCode.INTERNAL_ERROR],
  };
}

// Apollo Server v4 compatible error formatter
export const apolloErrorFormatter = (
  formattedError: any,
  error: unknown
): any => {
  const originalError = error as any;

  // If it's already a WrfcoinError, return the formatted version
  if (originalError instanceof WrfcoinError) {
    return formattedError;
  }

  // If it's already a GraphQL error with proper extensions, keep it
  if (originalError instanceof GraphQLError && originalError.extensions?.code) {
    return formattedError;
  }

  const message =
    originalError?.message ||
    formattedError?.message ||
    'An unexpected error occurred';
  const { code, userMessage } = classifyError(originalError, message);

  const correlationId = crypto.randomBytes(8).toString('hex');
  const severity = ERROR_SEVERITY_MAP[code];
  const category = ERROR_CATEGORY_MAP[code];

  // Enhanced logging with correlation ID
  logger.error('GraphQL Error', {
    correlationId,
    code,
    severity,
    category,
    message: userMessage,
    originalMessage: message,
    originalError: originalError?.message,
    stack: originalError?.stack,
    path: formattedError.path,
    source: formattedError.source?.body,
  });

  return {
    ...formattedError,
    message: process.env.NODE_ENV === 'production' ? userMessage : message,
    extensions: {
      ...formattedError.extensions,
      code,
      severity,
      category,
      correlationId,
      isRetryable: RETRYABLE_ERRORS.has(code),
      timestamp: new Date().toISOString(),
      originalError:
        process.env.NODE_ENV === 'development'
          ? originalError?.message
          : undefined,
    },
  };
};

// Resolver-compatible error formatter (used in resolvers)
export const formatError = (formattedError: any, error: unknown): any => {
  const message = formattedError?.message || 'An unexpected error occurred';
  const { code } = classifyError(error as Error, message);

  return {
    message:
      process.env.NODE_ENV === 'production' ? ERROR_MESSAGES[code] : message,
    code,
    extensions: {
      timestamp: new Date(),
    },
  };
};

// Error handling middleware for GraphQL
export const errorHandler = (error: GraphQLError) => {
  const errorCode = error.extensions?.code as ErrorCode;
  const severity = error.extensions?.severity as ErrorSeverity;

  // Log errors based on severity, not just type
  if (severity === ErrorSeverity.HIGH || severity === ErrorSeverity.CRITICAL) {
    logger.error('High/Critical GraphQL execution error', {
      correlationId: error.extensions?.correlationId,
      message: error.message,
      code: errorCode,
      severity,
      path: error.path,
      source: error.source?.body,
      stack: error.stack,
    });
  } else if (severity === ErrorSeverity.MEDIUM) {
    logger.warn('Medium severity GraphQL error', {
      correlationId: error.extensions?.correlationId,
      message: error.message,
      code: errorCode,
      path: error.path,
    });
  } else {
    logger.debug('Low severity GraphQL error', {
      correlationId: error.extensions?.correlationId,
      code: errorCode,
      path: error.path,
    });
  }

  // In production, sanitize internal error details
  if (process.env.NODE_ENV === 'production') {
    if (errorCode === ErrorCode.INTERNAL_ERROR) {
      return new GraphQLError(ERROR_MESSAGES[ErrorCode.INTERNAL_ERROR], {
        extensions: {
          code: ErrorCode.INTERNAL_ERROR,
          severity: ErrorSeverity.CRITICAL,
          correlationId: error.extensions?.correlationId,
          timestamp: new Date().toISOString(),
        },
      });
    }
  }

  return error;
};

// Enhanced helper functions for common errors with better context
export const authenticationError = (
  message?: string,
  context?: ErrorContext
) => {
  return new WrfcoinError(
    message || ERROR_MESSAGES[ErrorCode.AUTHENTICATION_ERROR],
    ErrorCode.AUTHENTICATION_ERROR,
    context
  );
};

export const authorizationError = (
  message?: string,
  context?: ErrorContext
) => {
  return new WrfcoinError(
    message || ERROR_MESSAGES[ErrorCode.AUTHORIZATION_ERROR],
    ErrorCode.AUTHORIZATION_ERROR,
    context
  );
};

export const validationError = (
  message: string,
  field?: string,
  context?: ErrorContext
) => {
  return new WrfcoinError(message, ErrorCode.VALIDATION_ERROR, {
    ...context,
    field,
  });
};

export const notFoundError = (resource: string, context?: ErrorContext) => {
  return new WrfcoinError(`${resource} not found`, ErrorCode.NOT_FOUND, {
    ...context,
    resource,
  });
};

export const duplicateError = (resource: string, context?: ErrorContext) => {
  return new WrfcoinError(
    `${resource} already exists`,
    ErrorCode.DUPLICATE_ERROR,
    { ...context, resource }
  );
};

export const blockchainError = (
  message: string,
  transactionHash?: string,
  context?: ErrorContext
) => {
  return new WrfcoinError(message, ErrorCode.CONTRACT_EXECUTION_ERROR, {
    ...context,
    transactionHash,
  });
};

export const rateLimitError = (
  limit: number,
  window: string,
  context?: ErrorContext
) => {
  return new WrfcoinError(
    ERROR_MESSAGES[ErrorCode.RATE_LIMIT_ERROR],
    ErrorCode.RATE_LIMIT_ERROR,
    { ...context, limit, window }
  );
};

export const databaseError = (
  message?: string,
  query?: string,
  context?: ErrorContext
) => {
  return new WrfcoinError(
    message || ERROR_MESSAGES[ErrorCode.DATABASE_ERROR],
    ErrorCode.DATABASE_ERROR,
    { ...context, query }
  );
};

export const timeoutError = (
  operation: string,
  timeoutMs: number,
  context?: ErrorContext
) => {
  return new WrfcoinError(
    `${operation} timed out after ${timeoutMs}ms`,
    ErrorCode.TIMEOUT_ERROR,
    { ...context, operation, timeoutMs }
  );
};

export const networkError = (
  message?: string,
  endpoint?: string,
  context?: ErrorContext
) => {
  return new WrfcoinError(
    message || ERROR_MESSAGES[ErrorCode.NETWORK_ERROR],
    ErrorCode.NETWORK_ERROR,
    { ...context, endpoint }
  );
};

// Retry wrapper for operations that can fail transiently
export async function withRetry<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  backoffMs: number = 1000,
  context?: ErrorContext
): Promise<T> {
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      // Check if error is retryable
      const { code } = classifyError(
        error,
        (error as any)?.message || 'Unknown error'
      );
      if (!RETRYABLE_ERRORS.has(code) || attempt === maxRetries) {
        throw error;
      }

      // Log retry attempt
      logger.warn('Operation failed, retrying', {
        attempt,
        maxRetries,
        error: (error as any)?.message,
        correlationId: context?.correlationId,
        retryAfterMs: backoffMs * attempt,
      });

      // Exponential backoff
      await new Promise(resolve => setTimeout(resolve, backoffMs * attempt));
    }
  }

  throw lastError;
}

// Performance monitoring wrapper
export function withPerformanceMonitoring<T extends any[], R>(
  operationName: string,
  fn: (...args: T) => Promise<R>,
  thresholdMs: number = 5000
) {
  return async (...args: T): Promise<R> => {
    const startTime = Date.now();
    const correlationId = crypto.randomBytes(8).toString('hex');

    try {
      const result = await fn(...args);
      const duration = Date.now() - startTime;

      if (duration > thresholdMs) {
        logger.warn('Slow operation detected', {
          operationName,
          correlationId,
          durationMs: duration,
          thresholdMs,
        });
      }

      logger.debug('Operation completed', {
        operationName,
        correlationId,
        durationMs: duration,
      });

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;

      logger.error('Operation failed', {
        operationName,
        correlationId,
        durationMs: duration,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error;
    }
  };
}
