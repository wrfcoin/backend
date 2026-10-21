// Response Helper Middleware
// Location: backend/middleware/response-helpers.ts
// Purpose: Standardized response utilities

import { Request, Response, NextFunction } from '../shared/types/express-types.js';
const { appLogger } = require('../server/utils/logger');

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  details?: any;
  timestamp?: string;
  pagination?: {
    limit: number;
    offset: number;
    total: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export const responseHelpers = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  // Success response helper
  res.success = <T>(
    data: T,
    message = 'Success',
    pagination?: any
  ): Response => {
    const response: ApiResponse<T> = {
      success: true,
      data,
      message,
      timestamp: new Date().toISOString(),
    };

    if (pagination) {
      response.pagination = pagination;
    }

    return res.json(response);
  };

  // Error response helper
  (res as any).error = (code: string, message: string, details?: any): Response => {
    const response: ApiResponse = {
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
    };

    if (details) {
      response.details = details;
    }

    // Default to 400 for client error, could be refined based on code
    const statusCode = code.startsWith('SERVER_') ? 500 : 400;
    return res.status(statusCode).json(response);
  };

  // Validation error helper
  (res as any).validationError = (errors: any[]) => {
    return res.status(400).json({
      success: false,
      error: 'Validation failed',
      details: errors,
      timestamp: new Date().toISOString(),
    });
  };

  // Not found helper
  (res as any).notFound = (resource = 'Resource') => {
    return res.status(404).json({
      success: false,
      error: `${resource} not found`,
      timestamp: new Date().toISOString(),
    });
  };

  // Server error helper
  (res as any).serverError = (message = 'Internal server error', error?: Error) => {
    appLogger.error('Server Error', { error: error?.message || error, stack: error?.stack });

    return res.status(500).json({
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
      ...(process.env.NODE_ENV === 'development' &&
        error && {
          details: {
            message: error.message,
            stack: error.stack,
          },
        }),
    });
  };

  // Unauthorized helper
  (res as any).unauthorized = (message = 'Unauthorized access') => {
    return res.status(401).json({
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
    });
  };

  // Forbidden helper
  (res as any).forbidden = (message = 'Access forbidden') => {
    return res.status(403).json({
      success: false,
      error: message,
      timestamp: new Date().toISOString(),
    });
  };

  // Rate limit exceeded helper
  res.rateLimitExceeded = (retryAfter?: number) => {
    const response: ApiResponse = {
      success: false,
      error: 'Rate limit exceeded',
      timestamp: new Date().toISOString(),
    };

    if (retryAfter) {
      response.details = { retryAfter };
      res.setHeader('Retry-After', retryAfter);
    }

    return res.status(429).json(response);
  };

  next();
};

// Note: Express Response extension - commented out due to type conflicts
// declare global {
//   namespace Express {
//     interface Response {
//       success<T>(data: T, message?: string, pagination?: any): this;
//       error(code: string, message: string, details?: any): this;
//       validationError(errors: any[]): this;
//       notFound(resource?: string): this;
//       serverError(message?: string, error?: Error): this;
//       unauthorized(message?: string): this;
//       forbidden(message?: string): this;
//       rateLimitExceeded(retryAfter?: number): this;
//     }
//   }
// }
