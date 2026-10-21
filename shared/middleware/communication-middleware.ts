/**
 * Communication Middleware Implementation
 *
 * This file provides standard middleware implementations that enforce
 * the WRFCoin Service Communication Standards across all services.
 */

import { Request, Response, NextFunction } from 'express';
import { AsyncLocalStorage } from 'async_hooks';
import { v4 as uuidv4 } from 'uuid';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import type { AuthenticatedRequest as BaseAuthenticatedRequest } from '../types/security-types.js';
import {
  ApiResponse,
  ApiError,
  RequestMetadata,
  RateLimitConfig,
  SecurityHeaders,
  createApiResponse,
  createApiError,
  ERROR_CODES,
} from '../types/communication-types.js';
// eslint-disable-next-line no-restricted-imports -- shared middleware uses centralized runtime logger.
import { appLogger } from '../../server/utils/logger.js';
import { hasAdminRole } from '../../server/utils/admin-role.js';
const { resolveAllowedOrigins } = require('../../server/utils/strict-cors-config.js');

// ================================
// Request Context Management
// ================================

const asyncLocalStorage = new AsyncLocalStorage<Map<string, any>>();

export interface AuthenticatedRequest extends BaseAuthenticatedRequest {
  metadata?: RequestMetadata;
}

/**
 * Transaction ID and request context middleware
 */
export const requestContextMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  asyncLocalStorage.run(new Map(), () => {
    const requestId = uuidv4();
    const transactionId =
      (req.headers['x-transaction-id'] as string) || uuidv4();

    const metadata: RequestMetadata = {
      requestId,
      transactionId,
      userId: req.user?.id,
      userRole: req.user?.roles?.[0],
      clientId: req.headers['x-client-id'] as string,
      userAgent: req.headers['user-agent'],
      ipAddress: req.ip,
      startTime: new Date(),
    };

    // Store in async context
    const store = asyncLocalStorage.getStore();
    store?.set('requestId', requestId);
    store?.set('transactionId', transactionId);
    store?.set('metadata', metadata);

    // Attach to request object
    req.metadata = metadata;

    // Add to response headers
    res.set({
      'x-request-id': requestId,
      'x-transaction-id': transactionId,
    });

    next();
  });
};

/**
 * Get current request context
 */
export const getRequestContext = (): RequestMetadata | null => {
  const store = asyncLocalStorage.getStore();
  return store?.get('metadata') || null;
};

/**
 * Get current transaction ID
 */
export const getTransactionId = (): string => {
  const store = asyncLocalStorage.getStore();
  return store?.get('transactionId') || 'unknown';
};

// ================================
// Response Formatting Middleware
// ================================

/**
 * Standardize all API responses
 */
export const responseFormatterMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  // Override res.json to ensure standard format
  const originalJson = res.json.bind(res);

  res.json = function (data: any) {
    // If data is already in standard format, use it
    if (data && typeof data === 'object' && 'success' in data) {
      return originalJson(data);
    }

    // Wrap in standard success response
    const response = createApiResponse(data, {
      requestId: req.metadata?.requestId,
      version: process.env.API_VERSION || '1.0.0',
      timestamp: new Date().toISOString(),
    });

    return originalJson(response);
  };

  next();
};

// ================================
// Error Handling Middleware
// ================================

/**
 * Global error handler that creates standardized error responses
 */
export const errorHandlerMiddleware = (
  error: Error,
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const requestId = req.metadata?.requestId || 'unknown';

  // Log error with context
  appLogger.error('Request error', {
    module: 'CommunicationMiddleware',
    requestId,
    error: error.message,
    stack: error.stack,
    url: req.originalUrl,
    method: req.method,
    userId: req.user?.id,
  });

  let statusCode = 500;
  let errorCode: string = ERROR_CODES.INTERNAL_SERVER_ERROR;
  let message = 'An unexpected error occurred';

  // Handle specific error types
  if (error.name === 'ValidationError') {
    statusCode = 400;
    errorCode = ERROR_CODES.VALIDATION_INVALID_FORMAT;
    message = error.message;
  } else if (error.name === 'UnauthorizedError') {
    statusCode = 401;
    errorCode = ERROR_CODES.AUTH_TOKEN_INVALID;
    message = 'Authentication required';
  } else if (error.name === 'ForbiddenError') {
    statusCode = 403;
    errorCode = ERROR_CODES.AUTHZ_INSUFFICIENT_PERMISSIONS;
    message = 'Access denied';
  } else if (error.name === 'NotFoundError') {
    statusCode = 404;
    errorCode = ERROR_CODES.RESOURCE_NOT_FOUND;
    message = 'Resource not found';
  }

  const apiError = createApiError(
    errorCode,
    message,
    process.env.NODE_ENV === 'development'
      ? {
        stack: error.stack,
        originalMessage: error.message,
      }
      : undefined,
  );

  (apiError as any).requestId = requestId;

  res.status(statusCode).json(apiError);
};

/**
 * 404 handler for unmatched routes
 */
export const notFoundMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
): void => {
  const error = createApiError(
    ERROR_CODES.RESOURCE_NOT_FOUND,
    `Endpoint ${req.originalUrl} not found`,
  );

  res.status(404).json(error);
};

// ================================
// Security Middleware
// ================================

/**
 * Configure security headers
 */
export const securityMiddleware = (headers?: Partial<SecurityHeaders>) => {
  const defaultHeaders = {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ['\'self\''],
        styleSrc: ['\'self\'', '\'unsafe-inline\''],
        scriptSrc: ['\'self\''],
        imgSrc: ['\'self\'', 'data:', 'https:'],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    ...headers,
  };

  return helmet(defaultHeaders);
};

/**
 * CORS configuration
 */
export const corsMiddleware = (origins?: string | string[]) => {
  return cors({
    origin: origins ||
      resolveAllowedOrigins({
        developmentDefaults: ['http://localhost:3000'],
      }),
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'x-transaction-id',
      'x-client-id',
      'x-api-key',
    ],
    credentials: true,
    maxAge: 86400, // 24 hours
  });
};

// ================================
// Rate Limiting Middleware
// ================================

/**
 * Create rate limiter with standard configuration
 */
export const createRateLimiter = (config: Partial<RateLimitConfig> = {}) => {
  const defaultConfig: RateLimitConfig = {
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000, // requests per window
    keyGenerator: (req: AuthenticatedRequest) => {
      return req.user?.id || ipKeyGenerator(req.ip || 'unknown');
    },
    skip: (req: AuthenticatedRequest) => {
      return hasAdminRole(req.user);
    },
    ...config,
  };

  return rateLimit({
    ...defaultConfig,
    standardHeaders: true,
    legacyHeaders: false,
    message: createApiError(
      ERROR_CODES.RATE_LIMIT_EXCEEDED,
      'Too many requests, please try again later',
    ),
    handler: (req: any, res: any, next: any, options: any) => {
      appLogger.warn('Rate limit exceeded', {
        module: 'CommunicationMiddleware',
        userId: (req as AuthenticatedRequest).user?.id,
        ip: req.ip,
        url: req.originalUrl,
        method: req.method,
      });
      res.status(options.statusCode).json(options.message);
    },
  });
};

// ================================
// Validation Middleware
// ================================

/**
 * Generic validation middleware factory
 */
export const validate = (
  schema: any,
  target: 'body' | 'query' | 'params' = 'body',
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const data = req[target];
    const { error, value } = schema.validate(data, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const validationError = createApiError(
        ERROR_CODES.VALIDATION_INVALID_FORMAT,
        'Validation failed',
        {
          fields: error.details.map((detail: any) => ({
            field: detail.path.join('.'),
            message: detail.message,
            value: detail.context?.value,
          })),
        },
      );

      res.status(400).json(validationError);
      return;
    }

    // Use validated and sanitized data
    (req as any)[target] = value;
    next();
  };
};

// ================================
// Performance Middleware
// ================================

/**
 * Request timing and compression middleware
 */
export const performanceMiddleware = () => {
  return [
    // Response compression
    compression({
      threshold: 1024, // Only compress if > 1KB
      level: 6, // Compression level
      filter: (req, res) => {
        if (req.headers['x-no-compression']) {
          return false;
        }
        return compression.filter(req, res);
      },
    }),

    // Request timing
    (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
      const startTime = Date.now();

      res.on('finish', () => {
        const duration = Date.now() - startTime;

        // Add timing headers
        res.set({
          'x-response-time': `${duration}ms`,
          'x-timestamp': new Date().toISOString(),
        });

        // Log performance metrics
        appLogger.info('Request performance', {
          module: 'CommunicationMiddleware',
          method: req.method,
          url: req.originalUrl,
          statusCode: res.statusCode,
          durationMs: duration,
          requestId: req.metadata?.requestId,
          userId: req.user?.id,
        });
      });

      next();
    },
  ];
};

// ================================
// Health Check Middleware
// ================================

/**
 * Health check endpoint middleware
 */
export const healthCheckMiddleware = (
  checks?: Record<string, () => Promise<boolean>>,
) => {
  return async (req: Request, res: Response): Promise<void> => {
    const health = {
      status: 'healthy' as 'healthy' | 'unhealthy',
      timestamp: new Date().toISOString(),
      version: process.env.API_VERSION || '1.0.0',
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      services: {} as Record<string, any>,
    };

    // Run health checks
    if (checks) {
      for (const [name, check] of Object.entries(checks)) {
        try {
          const isHealthy = await Promise.race([
            check(),
            new Promise<boolean>((_, reject) =>
              setTimeout(() => reject(new Error('Health check timeout')), 5000),
            ),
          ]);

          health.services[name] = {
            status: isHealthy ? 'up' : 'down',
            timestamp: new Date().toISOString(),
          };
        } catch (error) {
          health.services[name] = {
            status: 'down',
            error: (error as Error).message,
            timestamp: new Date().toISOString(),
          };
        }
      }

      // Update overall status
      const hasUnhealthy = Object.values(health.services).some(
        (service: any) => service.status === 'down',
      );

      if (hasUnhealthy) {
        health.status = 'unhealthy';
      }
    }

    const statusCode = health.status === 'healthy' ? 200 : 503;
    res.status(statusCode).json(createApiResponse(health));
  };
};

// ================================
// Request Logging Middleware
// ================================

/**
 * Structured request logging
 */
export const requestLoggingMiddleware = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const startTime = Date.now();

  // Log incoming request
  appLogger.info('Incoming request', {
    module: 'CommunicationMiddleware',
    method: req.method,
    url: req.originalUrl,
    userAgent: req.headers['user-agent'],
    requestId: req.metadata?.requestId,
    transactionId: req.metadata?.transactionId,
    userId: req.user?.id,
    ip: req.ip,
  });

  // Log response
  res.on('finish', () => {
    const duration = Date.now() - startTime;

    appLogger.info('Request completed', {
      module: 'CommunicationMiddleware',
      method: req.method,
      url: req.originalUrl,
      statusCode: res.statusCode,
      durationMs: duration,
      requestId: req.metadata?.requestId,
      transactionId: req.metadata?.transactionId,
      userId: req.user?.id,
    });
  });

  next();
};

// ================================
// Export All Middleware
// ================================

export const standardMiddleware = {
  requestContext: requestContextMiddleware,
  responseFormatter: responseFormatterMiddleware,
  errorHandler: errorHandlerMiddleware,
  notFound: notFoundMiddleware,
  security: securityMiddleware,
  cors: corsMiddleware,
  rateLimit: createRateLimiter,
  validate,
  performance: performanceMiddleware,
  healthCheck: healthCheckMiddleware,
  logging: requestLoggingMiddleware,
};
