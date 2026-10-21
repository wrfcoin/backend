import { Response } from 'express';

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  message?: string;
  code?: string;
  timestamp: string;
  requestId?: string;
}

export interface PaginatedResponse<T = any> extends ApiResponse<T[]> {
  pagination?: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasNext: boolean;
    hasPrev: boolean;
  };
}

export class ApiResponseBuilder {
  private response: ApiResponse = {
    success: false,
    timestamp: new Date().toISOString(),
  };

  static success<T>(data?: T): ApiResponseBuilder {
    const builder = new ApiResponseBuilder();
    builder.response.success = true;
    builder.response.data = data;
    return builder;
  }

  static error(message: string, code?: string): ApiResponseBuilder {
    const builder = new ApiResponseBuilder();
    builder.response.success = false;
    builder.response.error = message;
    builder.response.code = code;
    return builder;
  }

  static paginated<T>(
    data: T[],
    page: number,
    limit: number,
    total: number
  ): ApiResponseBuilder {
    const builder = new ApiResponseBuilder();
    const totalPages = Math.ceil(total / limit);

    builder.response.success = true;
    builder.response.data = data;
    (builder.response as PaginatedResponse).pagination = {
      page,
      limit,
      total,
      totalPages,
      hasNext: page < totalPages,
      hasPrev: page > 1,
    };

    return builder;
  }

  message(message: string): ApiResponseBuilder {
    this.response.message = message;
    return this;
  }

  code(code: string): ApiResponseBuilder {
    this.response.code = code;
    return this;
  }

  requestId(requestId: string): ApiResponseBuilder {
    this.response.requestId = requestId;
    return this;
  }

  build(): ApiResponse {
    return this.response;
  }

  send(res: Response, statusCode: number = 200): void {
    res.status(statusCode).json(this.response);
  }
}

// Helper functions for common response patterns
export function sendSuccess<T>(
  res: Response,
  data?: T,
  message?: string,
  statusCode: number = 200
): void {
  ApiResponseBuilder.success(data)
    .message(message || 'Success')
    .send(res, statusCode);
}

export function sendError(
  res: Response,
  message: string,
  code?: string,
  statusCode: number = 400
): void {
  ApiResponseBuilder.error(message, code).send(res, statusCode);
}

export function sendPaginated<T>(
  res: Response,
  data: T[],
  page: number,
  limit: number,
  total: number,
  message?: string
): void {
  ApiResponseBuilder.paginated(data, page, limit, total)
    .message(message || 'Success')
    .send(res);
}

export function sendNotFound(
  res: Response,
  resource: string = 'Resource'
): void {
  sendError(res, `${resource} not found`, 'NOT_FOUND', 404);
}

export function sendUnauthorized(
  res: Response,
  message: string = 'Unauthorized'
): void {
  sendError(res, message, 'UNAUTHORIZED', 401);
}

export function sendForbidden(
  res: Response,
  message: string = 'Forbidden'
): void {
  sendError(res, message, 'FORBIDDEN', 403);
}

export function sendInternalError(
  res: Response,
  message: string = 'Internal server error'
): void {
  sendError(res, message, 'INTERNAL_ERROR', 500);
}

export function sendValidationError(res: Response, errors: any): void {
  ApiResponseBuilder.error('Validation failed', 'VALIDATION_ERROR').build();

  res.status(422).json({
    success: false,
    error: 'Validation failed',
    code: 'VALIDATION_ERROR',
    errors,
    timestamp: new Date().toISOString(),
  });
}

// Middleware to add request ID to responses
export function addRequestId(requestId: string) {
  return (res: Response, next: () => void) => {
    const originalJson = res.json;
    res.json = function (body: any) {
      if (body && typeof body === 'object') {
        body.requestId = requestId;
      }
      return originalJson.call(this, body);
    };
    next();
  };
}
