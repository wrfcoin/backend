/**
 * API types for Gateway service
 */

export interface GatewayHealthResponse {
  success: boolean;
  data: {
    status: 'healthy' | 'degraded';
    gateway: string;
    timestamp: string;
    services: Record<
      string,
      {
        name: string;
        url: string;
        healthy: boolean;
      }
    >;
  };
}

export interface ErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
  timestamp: string;
}

export interface ProxyErrorResponse extends ErrorResponse {
  error: {
    code: 'SERVICE_UNAVAILABLE' | 'GATEWAY_ERROR' | 'NOT_FOUND';
    message: string;
    details?: string;
  };
}

export enum HttpStatusCodes {
  OK = 200,
  CREATED = 201,
  BAD_REQUEST = 400,
  UNAUTHORIZED = 401,
  FORBIDDEN = 403,
  NOT_FOUND = 404,
  INTERNAL_SERVER_ERROR = 500,
  SERVICE_UNAVAILABLE = 503,
}

export interface RateLimitHeaders {
  'x-ratelimit-limit': string;
  'x-ratelimit-remaining': string;
  'x-ratelimit-reset': string;
}
