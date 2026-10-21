/**
 * Enhanced GraphQL Error Handling - Task 67.3 + Task 103.4
 *
 * Comprehensive GraphQL error handling with:
 * - Security error masking
 * - Query complexity error handling
 * - DataLoader error management
 * - Integration with centralized error system
 * - Performance monitoring
 * - Production introspection protection (Task 103.4)
 * - Enhanced information disclosure prevention (Task 103.4)
 */

import { GraphQLError, GraphQLFormattedError } from 'graphql';
import {
  WrfcoinError,
  ValidationError,
  AuthenticationError,
  AuthorizationError,
  DatabaseError,
  NetworkError,
  ExternalServiceError,
  ErrorClassificationManager,
} from '../middleware/error-handler.js';
import {
  graphqlLogger,
  logError,
  logGraphQLOperation,
  getCorrelationId,
} from '../utils/logger.js';

/**
 * Task 103.4: Production environment check
 */
const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/**
 * Task 103.4: GraphQL Introspection Protection
 * Returns configuration to disable introspection in production
 */
export function getIntrospectionConfig(): { introspection: boolean } {
  const introspectionEnabled = !isProduction();

  if (!introspectionEnabled) {
    graphqlLogger.info('GraphQL introspection disabled for production environment');
  }

  return {
    introspection: introspectionEnabled,
  };
}

/**
 * Task 103.4: Sanitize error message to remove sensitive information
 */
function sanitizeErrorMessage(message: string): string {
  if (!message) return 'An error occurred';

  // Remove SQL patterns
  let sanitized = message.replace(/SELECT\s+.*?\s+FROM\s+/gi, 'SELECT ... FROM ');
  sanitized = sanitized.replace(/INSERT\s+INTO\s+\w+/gi, 'INSERT INTO [table]');
  sanitized = sanitized.replace(/UPDATE\s+\w+\s+SET/gi, 'UPDATE [table] SET');
  sanitized = sanitized.replace(/DELETE\s+FROM\s+\w+/gi, 'DELETE FROM [table]');

  // Remove table/column/constraint names
  sanitized = sanitized.replace(/relation\s+"[^"]+"/gi, 'relation "[table]"');
  sanitized = sanitized.replace(/table\s+"[^"]+"/gi, 'table "[table]"');
  sanitized = sanitized.replace(/column\s+"[^"]+"/gi, 'column "[column]"');
  sanitized = sanitized.replace(/constraint\s+"[^"]+"/gi, 'constraint "[constraint]"');

  // Remove file paths
  sanitized = sanitized.replace(/\/[a-zA-Z0-9_\-/.]+\.(js|ts|json)/g, '[file]');
  sanitized = sanitized.replace(/at\s+[^\s]+\s+\([^)]+\)/g, 'at [location]');

  return sanitized;
}

// GraphQL-specific error class
export class GraphQLOperationError extends WrfcoinError {
  public operationName?: string;
  public operationType?: string;
  public complexity?: number;
  public depth?: number;
  public resolverPath?: string[];

  constructor(message: string, options: any = {}) {
    super(message, {
      ...options,
      code: options.code || 'GRAPHQL_ERROR',
      category: 'graphql',
      severity: 'medium',
    });
    this.operationName = options.operationName;
    this.operationType = options.operationType;
    this.complexity = options.complexity;
    this.depth = options.depth;
    this.resolverPath = options.resolverPath;
  }
}

// Query complexity error
export class GraphQLComplexityError extends GraphQLOperationError {
  public maxComplexity: number;

  constructor(complexity: number, maxComplexity: number, options: any = {}) {
    super(
      `Query complexity ${complexity} exceeds maximum allowed complexity ${maxComplexity}`,
      {
        ...options,
        code: 'QUERY_COMPLEXITY_ERROR',
        severity: 'medium',
      }
    );
    this.complexity = complexity;
    this.maxComplexity = maxComplexity;
  }
}

// Query depth error
export class GraphQLDepthError extends GraphQLOperationError {
  public maxDepth: number;

  constructor(depth: number, maxDepth: number, options: any = {}) {
    super(`Query depth ${depth} exceeds maximum allowed depth ${maxDepth}`, {
      ...options,
      code: 'QUERY_DEPTH_ERROR',
      severity: 'medium',
    });
    this.depth = depth;
    this.maxDepth = maxDepth;
  }
}

// Rate limit error for GraphQL
export class GraphQLRateLimitError extends GraphQLOperationError {
  public limit: number;
  public window: number;

  constructor(limit: number, window: number, options: any = {}) {
    super(`GraphQL rate limit exceeded: ${limit} operations per ${window}ms`, {
      ...options,
      code: 'GRAPHQL_RATE_LIMIT_ERROR',
      severity: 'low',
      retryable: true,
      retryAfter: window,
    });
    this.limit = limit;
    this.window = window;
  }
}

// DataLoader error wrapper
export class DataLoaderError extends GraphQLOperationError {
  public batchKey: string;

  constructor(message: string, batchKey: string, options: any = {}) {
    super(`DataLoader error for batch ${batchKey}: ${message}`, {
      ...options,
      code: 'DATALOADER_ERROR',
      severity: 'medium',
    });
    this.batchKey = batchKey;
  }
}

/**
 * Security-aware error formatter for GraphQL responses
 * Task 103.4: Enhanced security masking for production
 */
export function createGraphQLErrorFormatter(
  options: {
    enableStackTrace?: boolean;
    enableSecurityMasking?: boolean;
    enableDetailedErrors?: boolean;
  } = {}
) {
  // Task 103.4: Force disable stack traces in production
  const enableStackTrace =
    options.enableStackTrace !== false && !isProduction();
  // Task 103.4: Force enable security masking in production
  const enableSecurityMasking = options.enableSecurityMasking !== false || isProduction();
  // Task 103.4: Force disable detailed errors in production
  const enableDetailedErrors = options.enableDetailedErrors !== false && !isProduction();

  return function formatError(error: GraphQLError): GraphQLFormattedError {
    const startTime = Date.now();
    const correlationId = getCorrelationId();

    // Extract the original error
    const originalError = error.originalError || error;

    // Classify the error using our centralized system
    const classifiedError =
      ErrorClassificationManager.classifyError(originalError);
    classifiedError.correlationId = correlationId;

    // Add GraphQL-specific context
    if (error.path) {
      classifiedError.context = {
        ...classifiedError.context,
        graphqlPath: error.path,
        resolverPath: error.path.join('.'),
      };
    }

    if (error.locations) {
      classifiedError.context = {
        ...classifiedError.context,
        locations: error.locations,
      };
    }

    // Log the GraphQL error
    logError(graphqlLogger, 'GraphQL operation error', classifiedError, {
      operation: 'graphql-error-formatting',
    });

    // Prepare the formatted error response
    const formattedError: GraphQLFormattedError = {
      message: error.message,
      locations: error.locations,
      path: error.path,
      extensions: {
        code: classifiedError.code,
        category: classifiedError.category,
        correlationId: classifiedError.correlationId,
        timestamp: classifiedError.timestamp,
      },
    };

    // Apply security masking for sensitive errors
    // Task 103.4: Enhanced security masking in production
    if (enableSecurityMasking) {
      // In production, mask ALL errors except validation errors
      if (isProduction()) {
        // Allow validation errors through with sanitized messages
        if (classifiedError.category === 'validation') {
          const sanitizedValidationError: GraphQLFormattedError = {
            message: sanitizeErrorMessage(error.message),
            locations: formattedError.locations,
            path: formattedError.path,
            extensions: {
              code: 'VALIDATION_ERROR',
              correlationId: classifiedError.correlationId,
              timestamp: classifiedError.timestamp,
            },
          };
          return sanitizedValidationError;
        }
        // All other errors get generic message in production
        const maskedError: GraphQLFormattedError = {
          message: 'An error occurred while processing your request',
          locations: formattedError.locations,
          path: formattedError.path,
          extensions: {
            code: classifiedError.code,
            correlationId: classifiedError.correlationId,
            timestamp: classifiedError.timestamp,
            masked: true,
          },
        };
        return maskedError;
      }

      // In development, still mask security/auth/critical errors
      if (
        classifiedError.category === 'security' ||
        classifiedError.category === 'authentication' ||
        classifiedError.severity === 'critical'
      ) {
        // Create a new formatted error with the masked message
        const maskedError: GraphQLFormattedError = {
          message: 'An error occurred while processing your request',
          locations: formattedError.locations,
          path: formattedError.path,
          extensions: {
            ...formattedError.extensions,
            masked: true,
          },
        };
        return maskedError;
      }
    }

    // Add detailed error information in development
    if (enableDetailedErrors) {
      const existingExtensions = formattedError.extensions || {};
      const detailedExtensions: any = {
        ...existingExtensions,
        severity: classifiedError.severity,
        service: classifiedError.service,
        retryable: classifiedError.retryable,
      };

      // Add retry information if applicable
      if (classifiedError.retryable && classifiedError.retryAfter) {
        detailedExtensions.retryAfter = classifiedError.retryAfter;
      }

      // Add validation errors if present
      if (
        classifiedError instanceof ValidationError &&
        classifiedError.validationErrors
      ) {
        detailedExtensions.validationErrors = classifiedError.validationErrors;
      }

      // Add business context for business errors
      if (classifiedError.category === 'business') {
        detailedExtensions.businessRule = (classifiedError as any).businessRule;
        detailedExtensions.entityType = (classifiedError as any).entityType;
      }

      // Add stack trace ONLY in development - Task 103.4 security enforcement
      if (enableStackTrace && error.stack && !isProduction()) {
        detailedExtensions.stack = error.stack.split('\n');
      }

      // Performance tracking
      const processingTime = Date.now() - startTime;
      detailedExtensions.processingTime = processingTime;

      // Create new formatted error with all extensions
      return {
        ...formattedError,
        extensions: detailedExtensions,
      };
    }

    // Performance tracking for non-detailed mode
    const processingTime = Date.now() - startTime;
    const finalExtensions = {
      ...formattedError.extensions,
      processingTime,
    };

    return {
      ...formattedError,
      extensions: finalExtensions,
    };
  };
}

/**
 * Enhanced GraphQL context creator with error handling utilities
 */
export function createGraphQLContext(req: any, res: any) {
  const correlationId = req.correlationId || getCorrelationId();

  return {
    req,
    res,
    correlationId,
    user: req.user,

    // Error throwing utilities
    throwGraphQLError: (
      message: string,
      code: string,
      extensions: any = {}
    ) => {
      throw new GraphQLError(message, {
        extensions: {
          code,
          correlationId,
          ...extensions,
        },
      });
    },

    throwValidationError: (message: string, validationErrors: any[] = []) => {
      const error = new ValidationError(message, {
        validationErrors,
        correlationId,
        operation: 'graphql-validation',
      });
      throw new GraphQLError(error.message, {
        originalError: error,
        extensions: {
          code: error.code,
          validationErrors: error.validationErrors,
          correlationId,
        },
      });
    },

    throwAuthError: (message: string, authMethod?: string) => {
      const error = new AuthenticationError(message, {
        authMethod,
        correlationId,
        operation: 'graphql-authentication',
      });
      throw new GraphQLError(error.message, {
        originalError: error,
        extensions: {
          code: error.code,
          correlationId,
        },
      });
    },

    throwPermissionError: (message: string, requiredPermission?: string) => {
      const error = new AuthorizationError(message, {
        requiredPermission,
        correlationId,
        operation: 'graphql-authorization',
      });
      throw new GraphQLError(error.message, {
        originalError: error,
        extensions: {
          code: error.code,
          requiredPermission,
          correlationId,
        },
      });
    },
  };
}

/**
 * DataLoader error wrapper utility
 */
export function wrapDataLoaderWithErrorHandling<K, V>(
  batchLoadFn: (keys: readonly K[]) => Promise<(V | Error)[]>,
  batchKey: string,
  options: any = {}
) {
  return async (keys: readonly K[]): Promise<(V | Error)[]> => {
    const startTime = Date.now();
    const correlationId = getCorrelationId();

    try {
      const results = await batchLoadFn(keys);

      // Log successful batch operation
      graphqlLogger.info(`DataLoader batch completed: ${batchKey}`, {
        operation: `dataloader:${batchKey}`,
        batchSize: keys.length,
        duration: Date.now() - startTime,
        correlationId,
      });

      // Check for individual errors in the batch
      const errorCount = results.filter(
        result => result instanceof Error
      ).length;
      if (errorCount > 0) {
        graphqlLogger.warn(
          `DataLoader batch had ${errorCount} errors: ${batchKey}`,
          {
            operation: `dataloader:${batchKey}`,
            batchSize: keys.length,
            errorCount,
            successCount: results.length - errorCount,
            correlationId,
          }
        );
      }

      return results;
    } catch (error) {
      // Classify and wrap the error
      const classifiedError = ErrorClassificationManager.classifyError(error);
      const dataLoaderError = new DataLoaderError(
        classifiedError.message,
        batchKey,
        {
          correlationId,
          cause: classifiedError,
          context: {
            batchSize: keys.length,
            batchKey,
          },
        }
      );

      logError(
        graphqlLogger,
        `DataLoader batch failed: ${batchKey}`,
        dataLoaderError,
        {
          operation: `dataloader:${batchKey}`,
          duration: Date.now() - startTime,
        }
      );

      // Return errors for all keys in the batch
      return keys.map(() => dataLoaderError);
    }
  };
}

/**
 * Query complexity analysis error handler
 */
export function createComplexityErrorHandler(maxComplexity: number = 1000) {
  return (complexity: number, operationName?: string) => {
    if (complexity > maxComplexity) {
      const error = new GraphQLComplexityError(complexity, maxComplexity, {
        operationName,
        correlationId: getCorrelationId(),
      });

      logError(graphqlLogger, 'GraphQL query complexity exceeded', error, {
        operation: `graphql:${operationName || 'unknown'}`,
      });

      throw new GraphQLError(error.message, {
        originalError: error,
        extensions: {
          code: error.code,
          complexity,
          maxComplexity,
          correlationId: error.correlationId,
        },
      });
    }
  };
}

/**
 * Query depth analysis error handler
 */
export function createDepthErrorHandler(maxDepth: number = 10) {
  return (depth: number, operationName?: string) => {
    if (depth > maxDepth) {
      const error = new GraphQLDepthError(depth, maxDepth, {
        operationName,
        correlationId: getCorrelationId(),
      });

      logError(graphqlLogger, 'GraphQL query depth exceeded', error, {
        operation: `graphql:${operationName || 'unknown'}`,
      });

      throw new GraphQLError(error.message, {
        originalError: error,
        extensions: {
          code: error.code,
          depth,
          maxDepth,
          correlationId: error.correlationId,
        },
      });
    }
  };
}

/**
 * GraphQL operation performance monitoring
 */
export function createGraphQLPerformanceMonitor() {
  return {
    requestDidStart() {
      const startTime = Date.now();
      const correlationId = getCorrelationId();

      return {
        didResolveOperation(requestContext: any) {
          const { operationName, operation } = requestContext.request;

          logGraphQLOperation(
            operation?.operation || 'unknown',
            operationName || 'unnamed',
            0, // Duration will be updated later
            undefined,
            requestContext.request.variables,
            requestContext.context?.user?.id
          );
        },

        didResolveSource(requestContext: any) {
          // Log source resolution if needed
        },

        didEncounterErrors(requestContext: any) {
          const errors = requestContext.errors || [];
          const duration = Date.now() - startTime;

          errors.forEach((error: GraphQLError) => {
            const classifiedError = ErrorClassificationManager.classifyError(
              error.originalError || error
            );

            logError(
              graphqlLogger,
              'GraphQL execution error',
              classifiedError,
              {
                operation: `graphql:${requestContext.request.operationName || 'unknown'}`,
                duration,
              }
            );
          });
        },

        willSendResponse(requestContext: any) {
          const duration = Date.now() - startTime;
          const { operationName, operation } = requestContext.request;
          const hasErrors =
            requestContext.errors && requestContext.errors.length > 0;

          logGraphQLOperation(
            operation?.operation || 'unknown',
            operationName || 'unnamed',
            duration,
            undefined,
            requestContext.request.variables,
            requestContext.context?.user?.id
          );

          // Log performance metrics
          if (duration > 5000) {
            // Log slow operations
            graphqlLogger.warn(`Slow GraphQL operation: ${operationName}`, {
              operation: `graphql:${operationName || 'unknown'}`,
              duration,
              hasErrors,
              performance: {
                responseTime: duration,
                slow: true,
              },
              correlationId,
            });
          }
        },
      };
    },
  };
}

export default {
  GraphQLOperationError,
  GraphQLComplexityError,
  GraphQLDepthError,
  GraphQLRateLimitError,
  DataLoaderError,
  createGraphQLErrorFormatter,
  createGraphQLContext,
  wrapDataLoaderWithErrorHandling,
  createComplexityErrorHandler,
  createDepthErrorHandler,
  createGraphQLPerformanceMonitor,
  // Task 103.4: Introspection protection
  getIntrospectionConfig,
  isProduction,
};
