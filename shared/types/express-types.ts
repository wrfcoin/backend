/**
 * Standardized Express Types for WRFCoin Platform
 * Ensures consistent Express type usage across all microservices
 */

import {
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction as ExpressNextFunction,
} from 'express';
// Define types inline to avoid dependency on express-serve-static-core
type ParamsDictionary = { [key: string]: string };
type Query = { [key: string]: string | string[] | undefined };

// ================================
// Standardized Express Types
// ================================

// Base Request type with proper generics
export interface Request<
  P = ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = Query,
  Locals extends Record<string, any> = Record<string, any>,
> extends ExpressRequest<P, ResBody, ReqBody, ReqQuery, Locals> {
  // Additional properties can be added here if needed
  requestId?: string;
  traceId?: string;
  userId?: string;
  clientIP?: string;
  startTime?: Date;
}

// Base Response type with proper generics
// Note: success() and error() methods are added via global Express augmentation below
export type Response<
  ResBody = any,
  Locals extends Record<string, any> = Record<string, any>,
> = ExpressResponse<ResBody, Locals>;

// NextFunction type
export type NextFunction = ExpressNextFunction;

// ================================
// Handler Types
// ================================

export type RequestHandler<
  P = ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = Query,
  Locals extends Record<string, any> = Record<string, any>,
> = (
  req: Request<P, ResBody, ReqBody, ReqQuery, Locals>,
  res: Response<ResBody, Locals>,
  next: NextFunction
) => void | Promise<void>;

export type ErrorRequestHandler<
  P = ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = Query,
  Locals extends Record<string, any> = Record<string, any>,
> = (
  err: any,
  req: Request<P, ResBody, ReqBody, ReqQuery, Locals>,
  res: Response<ResBody, Locals>,
  next: NextFunction
) => void | Promise<void>;

// ================================
// Middleware Types
// ================================

export interface MiddlewareOptions {
  skipIf?: (req: Request) => boolean;
  onError?: (
    error: Error,
    req: Request,
    res: Response,
    next: NextFunction
  ) => void;
}

export type Middleware<
  P = ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = Query,
  Locals extends Record<string, any> = Record<string, any>,
> = RequestHandler<P, ResBody, ReqBody, ReqQuery, Locals>;

// ================================
// Route Parameter Types
// ================================

export interface RouteParams {
  [key: string]: string;
}

export interface QueryParams {
  [key: string]: string | string[] | undefined;
}

// ================================
// Common Request/Response Types
// ================================

export interface PaginationQuery {
  page?: string;
  limit?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface FilterQuery {
  search?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
}

export interface AuthenticatedRequest<
  P = ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = Query,
  Locals extends Record<string, any> = Record<string, any>,
> extends Request<P, ResBody, ReqBody, ReqQuery, Locals> {
  user?: {
    id?: string;
    userId?: string; // Alias for id for backward compatibility
    address?: string;
    walletAddress?: string; // Alias for address for backward compatibility
    email?: string;
    role?: string;
    roles?: string[];
    permissions?: string[];
    sessionId?: string;
    verified?: boolean;
  };
  apiKey?: {
    id: string; // API key ID (required per global augmentation)
    userId: string; // User ID associated with the API key (required per global augmentation)
    name?: string; // API key name
    permissions: string[];
    scopes: string[]; // Scopes for fine-grained access (required per global augmentation)
    rateLimitTier: string;
    remainingQuota?: {
      daily: number;
      monthly: number;
    };
    lastUsed?: Date;
  };
  service?: {
    name: string;
    id: string;
  };
}

// ================================
// Service-Specific Request Types
// ================================

// Weather Data Request
export interface WeatherDataRequest extends Request {
  body: {
    stationId: string;
    temperature: number;
    humidity: number;
    pressure: number;
    windSpeed?: number;
    windDirection?: number;
    rainfall?: number;
    timestamp?: string;
  };
}

// Cross-Chain Transfer Request
export interface CrossChainTransferRequest extends Request {
  body: {
    to: string;
    amount: string;
    token?: string;
    sourceChain: string;
    targetChain: string;
  };
}

// Governance Vote Request
export interface GovernanceVoteRequest extends Request {
  body: {
    proposalId: string;
    support: boolean;
    reason?: string;
  };
}

// Compute Job Request
export interface ComputeJobRequest extends Request {
  body: {
    task: any;
    network: string;
    resources?: {
      cpu: number;
      memory: string;
      gpu?: boolean;
    };
    priority?: 'low' | 'normal' | 'high' | 'urgent';
  };
}

// NFT Listing Request
export interface NFTListingRequest extends Request {
  body: {
    tokenId: string;
    price: string;
    currency: string;
    expiration?: string;
  };
}

// ================================
// Response Helper Types
// ================================

export interface ApiSuccessResponse<T = any> {
  success: true;
  data: T;
  timestamp: string;
  meta?: {
    pagination?: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
      hasNext: boolean;
      hasPrev: boolean;
    };
    cache?: {
      cached: boolean;
      ttl?: number;
    };
    version?: string;
    requestId?: string;
  };
}

export interface ApiErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
    field?: string;
    stack?: string;
  };
  timestamp: string;
  requestId?: string;
}

export type ApiResponse<T = any> = ApiSuccessResponse<T> | ApiErrorResponse;

// ================================
// Type Guards
// ================================

export function isApiSuccessResponse<T>(
  response: ApiResponse<T>
): response is ApiSuccessResponse<T> {
  return response.success === true;
}

export function isApiErrorResponse(
  response: ApiResponse<any>
): response is ApiErrorResponse {
  return response.success === false;
}

export function isAuthenticatedRequest<
  P = ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = Query,
  Locals extends Record<string, any> = Record<string, any>,
>(
  req: Request<P, ResBody, ReqBody, ReqQuery, Locals>
): req is AuthenticatedRequest<P, ResBody, ReqBody, ReqQuery, Locals> {
  return 'user' in req && req.user != null;
}

// ================================
// Response Helper Functions
// ================================

export function createSuccessResponse<T>(
  data: T,
  meta?: ApiSuccessResponse<T>['meta']
): ApiSuccessResponse<T> {
  return {
    success: true,
    data,
    timestamp: new Date().toISOString(),
    meta,
  };
}

export function createErrorResponse(
  code: string,
  message: string,
  details?: any,
  field?: string
): ApiErrorResponse {
  return {
    success: false,
    error: {
      code,
      message,
      details,
      field,
    },
    timestamp: new Date().toISOString(),
  };
}

// ================================
// Express App Extension
// ================================

declare global {
  namespace Express {
    interface Request {
      user?: {
        id?: string;
        userId?: string;
        address?: string;
        walletAddress?: string;
        email?: string;
        role?: string;
        roles?: string[];
        permissions?: string[];
        sessionId?: string;
        verified?: boolean;
      };
      requestId?: string;
      traceId?: string;
      userId?: string;
      clientIP?: string;
      startTime?: Date;
    }

    interface Response {
      success<T>(data: T, message?: string, pagination?: any): Response;
      error(code: string | number, message: string, details?: any): Response;
    }
  }
}

// ================================
// Multer Types for File Uploads
// ================================

export interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  destination: string;
  filename: string;
  path: string;
  buffer: Buffer;
  stream: import('stream').Readable;
}

export interface FileUploadRequest extends Request {
  file?: MulterFile;
  files?: MulterFile[] | { [fieldname: string]: MulterFile[] };
}

// ================================
// Validation Types
// ================================

export interface ValidationError {
  field: string;
  message: string;
  value?: any;
  code: string;
}

export interface ValidationResult {
  isValid: boolean;
  errors: ValidationError[];
  warnings?: ValidationError[];
}

export interface ValidatedRequest<T = any> extends Request {
  validatedBody: T;
  validatedQuery: any;
  validatedParams: any;
}

// ================================
// Utility Types
// ================================

export type AsyncRequestHandler<
  P = ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = Query,
  Locals extends Record<string, any> = Record<string, any>,
> = (
  req: Request<P, ResBody, ReqBody, ReqQuery, Locals>,
  res: Response<ResBody, Locals>,
  next: NextFunction
) => Promise<void>;

export type SyncRequestHandler<
  P = ParamsDictionary,
  ResBody = any,
  ReqBody = any,
  ReqQuery = Query,
  Locals extends Record<string, any> = Record<string, any>,
> = (
  req: Request<P, ResBody, ReqBody, ReqQuery, Locals>,
  res: Response<ResBody, Locals>,
  next: NextFunction
) => void;

// ================================
// Export Everything
// ================================

export type { ParamsDictionary, Query };
