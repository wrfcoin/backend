/**
 * Express.js Resilience Middleware
 * Easy integration of resilience patterns into Express routes
 */

import { Request, Response, NextFunction } from 'express';
import { ResilienceManager } from './resilience-manager.js';
import {
  ResilienceConfig,
  ResilienceError,
  CircuitOpenError,
  MaxRetriesExceededError,
  ServiceUnavailableError,
  FallbackResult,
} from './resilience-types.js';
import { resilience } from './index.js';
import { appLogger } from '../../../server/utils/logger.js';

interface ResilienceMiddlewareOptions {
  serviceName: string;
  manager?: ResilienceManager;
  operationName?: (req: Request) => string;
  cacheKeyGenerator?: (req: Request) => string;
  skipCircuitBreaker?: boolean;
  skipRetry?: boolean;
  skipFallback?: boolean;
  errorHandler?: (
    error: Error,
    req: Request,
    res: Response,
    next: NextFunction
  ) => void;
  successHandler?: (
    result: FallbackResult,
    req: Request,
    res: Response,
    next: NextFunction
  ) => void;
}

/**
 * Creates resilience middleware for Express.js routes
 */
export function createResilienceMiddleware(
  options: ResilienceMiddlewareOptions
) {
  const {
    serviceName,
    manager,
    operationName = req => `${req.method} ${req.path}`,
    cacheKeyGenerator,
    skipCircuitBreaker = false,
    skipRetry = false,
    skipFallback = false,
    errorHandler,
    successHandler,
  } = options;

  // Get or create resilience manager
  const resilienceManager = manager || resilience.get(serviceName);

  if (!resilienceManager) {
    throw new Error(`No resilience manager found for service: ${serviceName}`);
  }

  // Type assertion to help TypeScript understand the manager is not null after the check
  const manager_ = resilienceManager as ResilienceManager;

  return async (req: Request, res: Response, next: NextFunction) => {
    // Store original res.json and res.send methods
    const originalJson = res.json.bind(res);
    const originalSend = res.send.bind(res);

    let operationExecuted = false;
    let originalOperation: () => Promise<any>;

    // Wrap the response methods to capture the operation
    res.json = function (body: any) {
      if (!operationExecuted) {
        originalOperation = async () => body;
        executeWithResilience();
      }
      return originalJson(body);
    };

    res.send = function (body: any) {
      if (!operationExecuted) {
        originalOperation = async () => body;
        executeWithResilience();
      }
      return originalSend(body);
    };

    async function executeWithResilience() {
      if (operationExecuted) return;
      operationExecuted = true;

      try {
        const operation = operationName(req);
        const cacheKey = cacheKeyGenerator ? cacheKeyGenerator(req) : undefined;

        const result = await manager_.execute(originalOperation, operation, {
          cacheKey,
          skipCircuitBreaker,
          skipRetry,
          skipFallback,
        });

        // Handle successful result
        if (successHandler) {
          successHandler(result, req, res, next);
        } else {
          handleSuccessResponse(result, req, res);
        }
      } catch (error) {
        if (errorHandler) {
          errorHandler(error as Error, req, res, next);
        } else {
          handleErrorResponse(error as Error, req, res, next);
        }
      }
    }

    // Continue to next middleware
    next();
  };
}

/**
 * Circuit breaker middleware - protects routes from cascade failures
 */
export function circuitBreakerMiddleware(
  serviceName: string,
  options: {
    manager?: ResilienceManager;
    operationName?: (req: Request) => string;
    onCircuitOpen?: (req: Request, res: Response, next: NextFunction) => void;
  } = {}
) {
  const {
    manager,
    operationName = req => `${req.method} ${req.path}`,
    onCircuitOpen,
  } = options;

  const resilienceManager = manager || resilience.get(serviceName);

  if (!resilienceManager) {
    throw new Error(`No resilience manager found for service: ${serviceName}`);
  }

  return (req: Request, res: Response, next: NextFunction) => {
    if (resilienceManager.isCircuitOpen()) {
      if (onCircuitOpen) {
        onCircuitOpen(req, res, next);
      } else {
        res.status(503).json({
          success: false,
          error: {
            code: 'CIRCUIT_OPEN',
            message: `Service ${serviceName} is temporarily unavailable`,
            details: 'Circuit breaker is open due to previous failures',
          },
          timestamp: new Date().toISOString(),
        });
      }
      return;
    }

    next();
  };
}

/**
 * Health check middleware - exposes service health status
 */
export function healthCheckMiddleware(
  serviceName: string,
  manager?: ResilienceManager
) {
  const resilienceManager = manager || resilience.get(serviceName);

  if (!resilienceManager) {
    throw new Error(`No resilience manager found for service: ${serviceName}`);
  }

  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const metrics = resilienceManager.getMetrics();
      const isHealthy = await resilienceManager.getHealthStatus();
      const successRate = resilienceManager.getSuccessRate();

      const healthStatus = {
        service: serviceName,
        status: isHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
        metrics: {
          circuit: {
            state: metrics.circuit.state,
            errorRate: metrics.circuit.errorRate,
            avgResponseTime: metrics.circuit.avgResponseTime,
          },
          health: {
            healthy: metrics.health.healthy,
            consecutiveFailures: metrics.health.consecutiveFailures,
            lastCheck: metrics.health.lastCheck,
          },
          performance: {
            successRate: Math.round(successRate * 100) / 100,
            fallbacksActivated: metrics.fallbacksActivated,
            totalRetryAttempts: metrics.retryAttempts.length,
          },
        },
      };

      res.status(isHealthy ? 200 : 503).json(healthStatus);
    } catch (error) {
      res.status(500).json({
        service: serviceName,
        status: 'error',
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  };
}

/**
 * Metrics middleware - exposes detailed resilience metrics
 */
export function metricsMiddleware(serviceName?: string) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      let metrics;

      if (serviceName) {
        const manager = resilience.get(serviceName);
        if (!manager) {
          return res.status(404).json({
            error: `Service ${serviceName} not found`,
          });
        }
        metrics = { [serviceName]: manager.getMetrics() };
      } else {
        metrics = resilience.getAllMetrics();
      }

      return res.json({
        timestamp: new Date().toISOString(),
        services: metrics,
      });
    } catch (error) {
      return res.status(500).json({
        error: (error as Error).message,
        timestamp: new Date().toISOString(),
      });
    }
  };
}

/**
 * Global error handler for resilience errors
 */
export function resilienceErrorHandler() {
  return (error: Error, req: Request, res: Response, next: NextFunction) => {
    if (error instanceof ResilienceError) {
      handleResilienceError(error, req, res);
    } else {
      next(error); // Pass to default error handler
    }
  };
}

// Helper functions
function handleSuccessResponse(
  result: FallbackResult,
  req: Request,
  res: Response
) {
  // Add resilience headers
  res.set({
    'X-Resilience-Source': result.source,
    'X-Resilience-Response-Time': result.responseTime.toString(),
    'X-Resilience-Timestamp': result.timestamp.toISOString(),
  });

  // If response is degraded, add appropriate status code
  if (result.source !== 'primary') {
    res.status(206); // Partial Content

    // Add degraded response indicator to body if it's an object
    if (typeof result.data === 'object' && result.data !== null) {
      const responseData = {
        ...result.data,
        _resilience: {
          degraded: true,
          source: result.source,
          responseTime: result.responseTime,
        },
      };
      res.json(responseData);
      return;
    }
  }

  res.json(result.data);
}

function handleErrorResponse(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
) {
  if (error instanceof CircuitOpenError) {
    res.status(503).json({
      success: false,
      error: {
        code: 'CIRCUIT_OPEN',
        message: error.message,
        service: error.context.serviceName,
      },
      timestamp: new Date().toISOString(),
    });
  } else if (error instanceof MaxRetriesExceededError) {
    res.status(502).json({
      success: false,
      error: {
        code: 'MAX_RETRIES_EXCEEDED',
        message: error.message,
        service: error.context.serviceName,
        attempts: error.context.attempt,
      },
      timestamp: new Date().toISOString(),
    });
  } else if (error instanceof ServiceUnavailableError) {
    res.status(503).json({
      success: false,
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: error.message,
        service: error.context.serviceName,
      },
      timestamp: new Date().toISOString(),
    });
  } else {
    next(error); // Pass to default error handler
  }
}

function handleResilienceError(
  error: ResilienceError,
  req: Request,
  res: Response
) {
  const statusCode = getStatusCodeForError(error);

  res.status(statusCode).json({
    success: false,
    error: {
      code: error.code,
      message: error.message,
      service: error.context.serviceName,
      operation: error.context.operation,
      timestamp: error.context.timestamp,
      retryable: error.retryable,
    },
    timestamp: new Date().toISOString(),
  });
}

function getStatusCodeForError(error: ResilienceError): number {
  switch (error.code) {
    case 'CIRCUIT_OPEN':
      return 503;
    case 'MAX_RETRIES_EXCEEDED':
      return 502;
    case 'SERVICE_UNAVAILABLE':
      return 503;
    default:
      return 500;
  }
}

// Convenience function to set up all resilience middleware for a service
export function setupResilienceMiddleware(
  app: any, // Express app
  serviceName: string,
  config?: Partial<ResilienceConfig>
) {
  // Create and register resilience manager
  const manager = ResilienceManager.forHttpService(
    serviceName,
    'http://localhost',
    config
  );
  resilience.register(serviceName, manager);

  // Add health check endpoint
  app.get('/health', healthCheckMiddleware(serviceName, manager));

  // Add metrics endpoint
  app.get('/metrics', metricsMiddleware(serviceName));

  // Add global resilience error handler
  app.use(resilienceErrorHandler());

  appLogger.info('Resilience middleware setup complete', { serviceName });

  return manager;
}
