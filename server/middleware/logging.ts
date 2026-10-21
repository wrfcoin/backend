/**
 * Centralized Logging Middleware - Task 67.4
 *
 * Comprehensive logging middleware for WRFCoin platform with request/response
 * correlation tracking, performance monitoring, and security event logging.
 */

import { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import {
  appLogger,
  performanceLogger,
  securityLogger,
  generateCorrelationId,
  setCorrelationId,
  asyncLocalStorage,
  LogMetadata,
} from '../utils/logger.js';
import { performance } from 'perf_hooks';

// Extended Request interface with logging context
interface RequestWithLogging extends Request {
  id?: string;
  correlationId?: string;
  loggingStartTime?: number;
  sessionID?: string;
}

// Performance tracking utility
class PerformanceTracker {
  private startTime: number;
  private marks: Map<string, number> = new Map();

  constructor() {
    this.startTime = performance.now();
  }

  mark(name: string): void {
    this.marks.set(name, performance.now());
  }

  measure(name: string): number {
    const markTime = this.marks.get(name);
    return markTime ? performance.now() - markTime : 0;
  }

  getDuration(): number {
    return performance.now() - this.startTime;
  }

  getMemoryUsage(): NodeJS.MemoryUsage {
    return process.memoryUsage();
  }

  getCpuUsage(): NodeJS.CpuUsage {
    return process.cpuUsage();
  }
}

// Request/Response correlation middleware
export function correlationMiddleware(
  req: RequestWithLogging,
  res: Response,
  next: NextFunction
): void {
  // Generate or extract correlation ID
  const correlationId =
    (req.headers['x-correlation-id'] as string) ||
    (req.headers['x-request-id'] as string) ||
    generateCorrelationId();

  // Generate unique request ID
  const requestId = uuidv4();

  // Set correlation context
  req.correlationId = correlationId;
  req.id = requestId;
  req.loggingStartTime = Date.now();

  // Add correlation headers to response
  res.set('X-Correlation-ID', correlationId);
  res.set('X-Request-ID', requestId);

  // Set async local storage context
  const store = new Map();
  store.set('correlationId', correlationId);
  store.set('requestId', requestId);
  store.set('startTime', req.loggingStartTime);

  asyncLocalStorage.run(store, () => {
    setCorrelationId(correlationId);
    next();
  });
}

// Request logging middleware
export function requestLoggingMiddleware(
  req: RequestWithLogging,
  res: Response,
  next: NextFunction
): void {
  const tracker = new PerformanceTracker();

  // Extract user context
  const userId = req.user?.id || (req.headers['x-user-id'] as string);
  const walletAddress =
    req.user?.address || (req.headers['x-wallet-address'] as string);
  const apiKeyId = req.apiKey?.id || (req.headers['x-api-key-id'] as string);

  // Create request metadata
  const requestMetadata: LogMetadata = {
    service: 'api',
    operation: `${req.method}:${req.path}`,
    userId,
    requestId: req.id,
    correlationId: req.correlationId,
    method: req.method,
    path: req.path,
    ip: req.ip || req.connection?.remoteAddress || req.socket?.remoteAddress,
    userAgent: req.get('User-Agent'),
    blockchainNetwork: req.headers['x-network'] as string,
    walletAddress,
    security: {
      authMethod: req.headers['authorization']
        ? 'bearer'
        : apiKeyId
          ? 'api-key'
          : 'none',
      apiKeyUsed: !!apiKeyId,
      sessionId: req.sessionID,
      geoLocation: req.headers['x-geo-location'] as string,
      deviceFingerprint: req.headers['x-device-fingerprint'] as string,
    },
  };

  // Log incoming request
  appLogger.info(`Incoming ${req.method} ${req.path}`, requestMetadata);

  // Track performance metrics
  tracker.mark('request-start');

  // Override response methods to log completion
  const originalSend = res.send;
  const originalJson = res.json;
  const originalEnd = res.end;

  let responseLogged = false;

  const logResponse = (statusCode: number, responseSize?: number) => {
    if (responseLogged) return;
    responseLogged = true;

    const duration = tracker.getDuration();
    const memoryUsage = tracker.getMemoryUsage();
    const level =
      statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';

    const responseMetadata: LogMetadata = {
      ...requestMetadata,
      statusCode,
      duration,
      performance: {
        responseTime: duration,
        memoryUsage,
        cpuUsage: tracker.getCpuUsage(),
      },
    };

    // Add response size if available
    if (responseSize) {
      responseMetadata.performance!.throughput = {
        requestsPerSecond: 1000 / duration,
        operationsPerSecond: 1000 / duration,
      };
    }

    // Log response
    appLogger.log(
      level,
      `${req.method} ${req.path} ${statusCode} (${duration.toFixed(2)}ms)`,
      responseMetadata
    );

    // Log performance metrics separately for analysis
    performanceLogger.info(`API performance: ${req.method} ${req.path}`, {
      operation: `api:${req.method}:${req.path}`,
      duration,
      statusCode,
      performance: responseMetadata.performance,
      correlationId: req.correlationId,
    });

    // Log security events for sensitive operations
    if (
      req.path.includes('/auth') ||
      req.path.includes('/wallet') ||
      req.path.includes('/admin')
    ) {
      securityLogger.info(`API access: ${req.method} ${req.path}`, {
        operation: 'security:api-access',
        userId,
        ip: requestMetadata.ip,
        statusCode,
        userAgent: requestMetadata.userAgent,
        security: requestMetadata.security,
        correlationId: req.correlationId,
      });
    }
  };

  // Override response methods
  res.send = function (data: any) {
    const responseSize = data ? Buffer.byteLength(JSON.stringify(data)) : 0;
    logResponse(res.statusCode, responseSize);
    return originalSend.call(this, data);
  };

  res.json = function (data: any) {
    const responseSize = data ? Buffer.byteLength(JSON.stringify(data)) : 0;
    logResponse(res.statusCode, responseSize);
    return originalJson.call(this, data);
  };

  (res as any).end = function (...args: any[]) {
    logResponse(res.statusCode);
    return (originalEnd as Function).apply(this, args);
  };

  next();
}

// Error logging middleware
export function errorLoggingMiddleware(
  error: Error,
  req: RequestWithLogging,
  res: Response,
  next: NextFunction
): void {
  // SECURITY: Log full error details server-side but sanitize for metadata
  const isProduction = process.env.NODE_ENV === 'production';

  // Log full stack trace to server logs (not exposed to client)
  appLogger.error('Request error occurred', {
    operation: 'middleware:error:handler',
    correlationId: req.correlationId,
    requestId: req.id,
    error: {
      name: error.name,
      message: error.message,
    },
    // Stack trace logged at debug level to avoid log bloat
  });

  const errorMetadata: LogMetadata = {
    service: 'api',
    operation: `${req.method}:${req.path}`,
    userId: req.user?.id,
    requestId: req.id,
    correlationId: req.correlationId,
    method: req.method,
    path: req.path,
    ip: req.ip || req.connection?.remoteAddress,
    userAgent: req.get('User-Agent'),
    error: {
      name: error.name,
      // SECURITY: Sanitize error message in production to prevent information disclosure
      message: isProduction ? 'An internal error occurred' : error.message,
      // SECURITY: Stack trace removed - never expose to clients/logs that may be visible
      code: (error as any).code,
      category: (error as any).category || 'system',
      severity: (error as any).severity || 'medium',
    },
  };

  // Log error with appropriate level
  const level = (error as any).severity === 'critical' ? 'error' : 'warn';
  appLogger.log(
    level,
    `Error in ${req.method} ${req.path}: ${error.message}`,
    errorMetadata
  );

  // Log security-related errors separately
  if (
    error.name === 'UnauthorizedError' ||
    error.name === 'ForbiddenError' ||
    error.message.includes('authentication') ||
    error.message.includes('authorization')
  ) {
    securityLogger.warn(`Security error: ${error.message}`, {
      operation: 'security:error',
      userId: req.user?.id,
      ip: errorMetadata.ip,
      userAgent: errorMetadata.userAgent,
      error: errorMetadata.error,
      correlationId: req.correlationId,
    });
  }

  next(error);
}

// GraphQL operation logging middleware
export function graphqlLoggingMiddleware(
  req: RequestWithLogging,
  res: Response,
  next: NextFunction
): void {
  // Only process GraphQL requests
  if (
    !req.path.includes('/graphql') &&
    req.headers['content-type'] !== 'application/json'
  ) {
    return next();
  }

  const originalSend = res.send;
  res.send = function (data: any) {
    try {
      const responseData = typeof data === 'string' ? JSON.parse(data) : data;

      // Extract GraphQL operation details
      if (req.body && req.body.query) {
        const operationMatch = req.body.query.match(
          /(query|mutation|subscription)\s+(\w+)?/
        );
        const operationType = operationMatch?.[1] || 'unknown';
        const operationName =
          operationMatch?.[2] || req.body.operationName || 'anonymous';

        const duration = req.loggingStartTime ? Date.now() - req.loggingStartTime : 0;

        appLogger.info(`GraphQL ${operationType}: ${operationName}`, {
          operation: `graphql:${operationType}:${operationName}`,
          userId: req.user?.id,
          duration,
          correlationId: req.correlationId,
          graphql: {
            operationType: operationType as any,
            operationName,
            variables: req.body.variables,
            complexity: (req as any).graphqlComplexity,
            depth: (req as any).graphqlDepth,
          },
          performance: {
            responseTime: duration,
          },
        });

        // Log GraphQL errors
        if (responseData.errors && responseData.errors.length > 0) {
          responseData.errors.forEach((error: any) => {
            appLogger.warn(
              `GraphQL error in ${operationType} ${operationName}`,
              {
                operation: `graphql:error:${operationType}:${operationName}`,
                userId: req.user?.id,
                correlationId: req.correlationId,
                error: {
                  name: 'GraphQLError',
                  message: error.message,
                  code: error.extensions?.code,
                  category: 'business',
                  severity: 'medium',
                },
                graphql: {
                  operationType: operationType as any,
                  operationName,
                  resolverPath: error.path,
                },
              }
            );
          });
        }
      }
    } catch (parseError) {
      // Ignore JSON parsing errors in middleware
    }

    return originalSend.call(this, data);
  };

  next();
}

// Database query logging middleware
export function databaseLoggingMiddleware(
  queryText: string,
  duration: number,
  success: boolean
): void {
  const level = success ? 'debug' : 'warn';
  const message = `Database query ${success ? 'completed' : 'failed'} (${duration.toFixed(2)}ms)`;

  appLogger.log(level, message, {
    operation: 'database:query',
    duration,
    performance: {
      queryTime: duration,
    },
    success,
    // Mask potential sensitive data in queries
    query:
      queryText.length > 200 ? queryText.substring(0, 200) + '...' : queryText,
  });
}

// Service call logging middleware
export function serviceCallLoggingMiddleware(
  serviceName: string,
  endpoint: string,
  method: string,
  duration: number,
  success: boolean,
  statusCode?: number,
  error?: Error
): void {
  const level = success ? 'info' : 'warn';
  const message = `Service call to ${serviceName}${endpoint} ${success ? 'succeeded' : 'failed'}`;

  const metadata: LogMetadata = {
    operation: `service-call:${serviceName}`,
    duration,
    statusCode,
    serviceCall: {
      targetService: serviceName,
      endpoint,
      method,
      duration,
      success,
    },
    performance: {
      responseTime: duration,
    },
  };

  if (error) {
    metadata.error = {
      name: error.name,
      message: error.message,
      code: (error as any).code,
      category: 'external',
      severity: 'medium',
    };
  }

  appLogger.log(level, message, metadata);
}

// Rate limiting logging middleware
export function rateLimitLoggingMiddleware(
  req: RequestWithLogging,
  res: Response,
  next: NextFunction
): void {
  const originalSend = res.send;

  res.send = function (data: any) {
    // Log rate limit hits
    if (res.statusCode === 429) {
      securityLogger.warn('Rate limit exceeded', {
        operation: 'security:rate-limit',
        userId: req.user?.id,
        ip: req.ip,
        path: req.path,
        method: req.method,
        userAgent: req.get('User-Agent'),
        correlationId: req.correlationId,
        security: {
          event: 'rate-limit-exceeded',
          riskScore: 5, // Medium risk
        },
      });
    }

    return originalSend.call(this, data);
  };

  next();
}

// Export middleware chain for easy application
export const loggingMiddlewareChain = [
  correlationMiddleware,
  requestLoggingMiddleware,
  graphqlLoggingMiddleware,
  rateLimitLoggingMiddleware,
];

// Export error middleware separately as it needs to be added after routes
export const errorMiddlewareChain = [errorLoggingMiddleware];
