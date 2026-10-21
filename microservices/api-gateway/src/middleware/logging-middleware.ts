import { Request, Response, NextFunction } from 'express';
import { AuthenticatedRequest } from '../../../../shared/types/security-types.js';
import { Logger } from '../services/logger.js';

export interface RequestWithTiming extends Omit<Request, 'startTime'> {
  user?: AuthenticatedRequest['user'];
  startTime?: number;
}

/**
 * Middleware to log HTTP requests and responses
 */
export function requestLogger(
  req: RequestWithTiming,
  res: Response,
  next: NextFunction
): void {
  const startTime = Date.now();
  req.startTime = startTime;

  // Log the incoming request
  Logger.debug(`Incoming request: ${req.method} ${req.originalUrl}`, {
    method: req.method,
    url: req.originalUrl,
    userAgent: req.get('User-Agent'),
    ip: req.ip || req.connection.remoteAddress,
    userId: req.user?.id,
    headers: req.headers,
  });

  // Override res.end to capture response
  const originalEnd = res.end;
  res.end = function (chunk?: any, encoding?: any): Response {
    const responseTime = Date.now() - startTime;

    // Log the response
    Logger.http({
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      responseTime,
      userAgent: req.get('User-Agent'),
      ip: req.ip || req.connection.remoteAddress,
      userId: req.user?.id,
    });

    // Log slow requests
    if (responseTime > 1000) {
      Logger.warn(`Slow request detected: ${req.method} ${req.originalUrl}`, {
        responseTime,
        status: res.statusCode,
        userId: req.user?.id,
      });
    }

    // Log errors
    if (res.statusCode >= 400) {
      const level = res.statusCode >= 500 ? 'error' : 'warn';
      Logger[level](
        `HTTP ${res.statusCode}: ${req.method} ${req.originalUrl}`,
        {
          status: res.statusCode,
          responseTime,
          userId: req.user?.id,
          userAgent: req.get('User-Agent'),
        }
      );
    }

    return originalEnd.call(this, chunk, encoding || undefined);
  };

  next();
}

/**
 * Middleware to track API usage and rate limiting
 */
export function usageTracker(
  req: RequestWithTiming,
  res: Response,
  next: NextFunction
): void {
  const userAddress = req.user?.address || 'anonymous';
  const endpoint = `${req.method} ${req.route?.path || req.originalUrl}`;

  // Track API usage (in production, this would go to a database)
  Logger.info(`API Usage: ${userAddress} -> ${endpoint}`, {
    userAddress,
    endpoint,
    timestamp: new Date().toISOString(),
    userAgent: req.get('User-Agent'),
    ip: req.ip,
  });

  next();
}

/**
 * Middleware to handle security events
 */
export function securityLogger(
  req: RequestWithTiming,
  res: Response,
  next: NextFunction
): void {
  // Check for suspicious patterns
  const suspiciousPatterns = [
    /\.\./, // Path traversal
    /<script/i, // XSS attempt
    /union\s+select/i, // SQL injection
    /exec\s*\(/i, // Code injection
  ];

  const url = req.originalUrl.toLowerCase();
  const body = JSON.stringify(req.body).toLowerCase();

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(url) || pattern.test(body)) {
      Logger.security('Suspicious request detected', {
        pattern: pattern.source,
        url: req.originalUrl,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userAddress: req.user?.address,
        body: req.body,
      });
      break;
    }
  }

  // Log authentication failures
  res.on('finish', () => {
    if (res.statusCode === 401 || res.statusCode === 403) {
      Logger.security('Authentication/Authorization failure', {
        status: res.statusCode,
        url: req.originalUrl,
        method: req.method,
        ip: req.ip,
        userAgent: req.get('User-Agent'),
        userAddress: req.user?.address,
      });
    }
  });

  next();
}

/**
 * Error logging middleware
 */
export function errorLogger(
  error: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void {
  Logger.error(`Unhandled error in ${req.method} ${req.originalUrl}`, error);

  // Add error context
  Logger.debug('Error context', {
    url: req.originalUrl,
    method: req.method,
    headers: req.headers,
    body: req.body,
    params: req.params,
    query: req.query,
    stack: error.stack,
  });

  next(error);
}

/**
 * Performance monitoring middleware
 */
export function performanceMonitor() {
  const startTimes = new Map<string, number>();

  return {
    start: (operation: string) => {
      startTimes.set(operation, Date.now());
    },

    end: (operation: string, metadata?: any) => {
      const startTime = startTimes.get(operation);
      if (startTime) {
        const duration = Date.now() - startTime;
        Logger.performance(operation, duration, metadata);
        startTimes.delete(operation);
      }
    },
  };
}
