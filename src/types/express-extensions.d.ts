/**
 * Express Type Extensions
 * Centralized type definitions for Express middleware and route handlers
 */

import { Request, Response, NextFunction } from 'express';

type PaginationMeta = Record<string, unknown>;

// Extend Express Request interface for authenticated requests
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
      session?: {
        id: string;
        userId?: string;
      };
    }

    interface Response {
      success<T>(data: T, message?: string, pagination?: PaginationMeta): void;
      error(statusCode: number, message: string, details?: unknown): void;
      validationError(errors: unknown[]): void;
      notFound(resource?: string): void;
      serverError(message?: string, error?: Error): void;
      unauthorized(message?: string): void;
      forbidden(message?: string): void;
      rateLimitExceeded(retryAfter?: number): void;
    }
  }
}

// Import the standard AuthenticatedRequest from shared types
export { AuthenticatedRequest } from '../../shared/types/security-types.js';

// Custom response type with helpers
export interface ExtendedResponse extends Response {
  success<T>(data: T, message?: string, pagination?: PaginationMeta): void;
  error(statusCode: number, message: string, details?: unknown): void;
  validationError(errors: unknown[]): void;
  notFound(resource?: string): void;
  serverError(message?: string, error?: Error): void;
  unauthorized(message?: string): void;
  forbidden(message?: string): void;
  rateLimitExceeded(retryAfter?: number): void;
}

// Route handler types
export type RouteHandler = (
  req: Request,
  res: Response,
  next?: NextFunction
) => void | Promise<void>;
export type AuthenticatedRouteHandler = (
  req: import('../../shared/types/security-types').AuthenticatedRequest,
  res: ExtendedResponse,
  next?: NextFunction
) => void | Promise<void>;
export type MiddlewareFunction = (
  req: Request,
  res: Response,
  next: NextFunction
) => void | Promise<void>;

export default {};
