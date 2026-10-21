/**
 * Enhanced API Key Authentication Middleware
 * Provides secure API key validation with rate limiting and audit logging
 */

import { Request, Response, NextFunction } from 'express';
import {
  ApiKeyService,
  type ApiKeyValidationResult,
} from '../services/api-key-service.js';
import { API_PERMISSIONS } from '../shared/schema-api-keys.js';
import { AuthenticatedRequest } from '../shared/types/security-types.js';
import { securityLogger } from '../server/utils/logger.js';

export interface ApiKeyAuthOptions {
  required?: boolean;
  permissions?: string[];
  scopes?: string[];
  logUsage?: boolean;
}

export class ApiKeyAuthMiddleware {
  private apiKeyService: ApiKeyService;

  constructor() {
    this.apiKeyService = new ApiKeyService();
  }

  /**
   * Middleware to authenticate API keys
   */
  authenticate(options: ApiKeyAuthOptions = {}) {
    return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      const startTime = Date.now();

      try {
        // Extract API key from headers
        const apiKey = this.extractApiKey(req);

        // If API key is required but not provided
        if (options.required !== false && !apiKey) {
          this.sendAuthError(
            res,
            'API_KEY_REQUIRED',
            'Please provide an API key in the X-API-Key header or Authorization header'
          );
          return;
        }

        // If no API key provided and it's optional, continue
        if (!apiKey && options.required === false) {
          next();
          return;
        }

        // Validate the API key
        const validation = await this.apiKeyService.validateApiKey(
          apiKey!,
          this.getClientIp(req),
          req.get('User-Agent'),
          req.get('Referer')
        );

        if (!validation.isValid) {
          this.sendAuthError(
            res,
            'INVALID_API_KEY',
            validation.error || 'Authentication failed'
          );

          // Log failed attempt if we have an API key
          if (validation.apiKey) {
            await this.logUsageInternal(
              req,
              validation.apiKey.id,
              401,
              Date.now() - startTime,
              {
                error: validation.error,
              }
            );
          }
          return;
        }

        // Check permissions if specified
        if (options.permissions && options.permissions.length > 0) {
          const hasPermission = this.checkPermissions(
            validation.apiKey!.permissions as string[],
            options.permissions
          );

          if (!hasPermission) {
            this.sendAuthError(
              res,
              'INSUFFICIENT_PERMISSIONS',
              `Required permissions: ${options.permissions.join(', ')}`,
              403
            );

            await this.logUsageInternal(
              req,
              validation.apiKey!.id,
              403,
              Date.now() - startTime,
              {
                error: 'Insufficient permissions',
              }
            );
            return;
          }
        }

        // Check scopes if specified
        if (options.scopes && options.scopes.length > 0) {
          const hasScope = this.checkScopes(
            validation.apiKey!.scopes as string[],
            options.scopes
          );

          if (!hasScope) {
            this.sendAuthError(
              res,
              'INSUFFICIENT_SCOPE',
              `Required scopes: ${options.scopes.join(', ')}`,
              403
            );

            await this.logUsageInternal(
              req,
              validation.apiKey!.id,
              403,
              Date.now() - startTime,
              {
                error: 'Insufficient scope',
              }
            );
            return;
          }
        }

        // Rate limit check
        if (validation.rateLimited) {
          res.status(429).json({
            success: false,
            error: {
              code: 'RATE_LIMIT_EXCEEDED',
              message: 'You have exceeded your API rate limit',
            },
            timestamp: new Date().toISOString(),
            details: { remainingQuota: validation.remainingQuota, retryAfter: this.getRetryAfter() },
          });

          await this.logUsageInternal(
            req,
            validation.apiKey!.id,
            429,
            Date.now() - startTime,
            {
              error: 'Rate limit exceeded',
            }
          );
          return;
        }

        // Set API key data in request
        req.apiKey = {
          id: validation.apiKey!.id,
          userId: validation.apiKey!.userId,
          permissions: validation.apiKey!.permissions as string[],
          scopes: validation.apiKey!.scopes as string[],
          rateLimitTier: validation.apiKey!.rateLimitTier,
          remainingQuota: validation.remainingQuota,
        };

        // Add rate limit headers
        this.addRateLimitHeaders(res, validation.remainingQuota);

        // Log successful authentication
        if (options.logUsage !== false) {
          // We'll log the final usage in the response middleware
          res.locals.apiKeyId = validation.apiKey!.id;
          res.locals.apiKeyStartTime = startTime;
        }

        next();
      } catch (error) {
        securityLogger.error('API key authentication error', { error: error instanceof Error ? error.message : String(error), path: req.path, method: req.method });
        this.sendAuthError(
          res,
          'AUTHENTICATION_ERROR',
          'Internal authentication error'
        );
      }
    };
  }

  /**
   * Middleware to require specific permissions
   */
  requirePermissions(permissions: string[]) {
    return this.authenticate({ required: true, permissions });
  }

  /**
   * Middleware to require specific scopes
   */
  requireScopes(scopes: string[]) {
    return this.authenticate({ required: true, scopes });
  }

  /**
   * Middleware to require admin permissions
   */
  requireAdmin() {
    return this.authenticate({
      required: true,
      permissions: [API_PERMISSIONS.ADMIN],
    });
  }

  /**
   * Middleware to log API usage (should be used after route handlers)
   */
  logUsage() {
    return async (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ): Promise<void> => {
      const originalSend = res.send;

      res.send = function (body: any) {
        // Log the usage if we have API key data
        if (res.locals.apiKeyId && res.locals.apiKeyStartTime) {
          const responseTime = Date.now() - res.locals.apiKeyStartTime;

          // Don't await this to avoid blocking the response
          setImmediate(async () => {
            try {
              const apiKeyService = new ApiKeyService();
              await apiKeyService.recordUsage(
                res.locals.apiKeyId,
                req.path,
                req.method,
                res.statusCode,
                responseTime,
                {
                  userAgent: req.get('User-Agent'),
                  ipAddress: getClientIp(req),
                  referrer: req.get('Referer'),
                  requestSize: req.get('Content-Length')
                    ? parseInt(req.get('Content-Length')!, 10)
                    : undefined,
                  responseSize: res.getHeader('content-length')
                    ? Number(res.getHeader('content-length'))
                    : Buffer.isBuffer(body)
                      ? body.length
                      : typeof body === 'string'
                        ? Buffer.byteLength(body)
                        : undefined,
                }
              );
            } catch (error) {
              securityLogger.error('Error logging API usage', { error: error instanceof Error ? error.message : String(error) });
            }
          });
        }

        return originalSend.call(this, body);
      };

      next();
    };
  }

  /**
   * Extract API key from request headers
   */
  private extractApiKey(req: AuthenticatedRequest): string | null {
    // Check X-API-Key header first
    const xApiKey = req.get('X-API-Key');
    if (xApiKey) return xApiKey;

    // Check Authorization header (Bearer format)
    const authHeader = req.get('Authorization');
    if (authHeader) {
      const match = authHeader.match(/^Bearer\s+(.+)$/);
      if (match) return match[1];
    }

    // Check query parameter (less secure, only for development)
    if (process.env.NODE_ENV === 'development' && req.query.api_key) {
      return req.query.api_key as string;
    }

    return null;
  }

  /**
   * Get client IP address
   */
  private getClientIp(req: AuthenticatedRequest): string {
    return (
      req.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
      req.get('X-Real-IP') ||
      req.socket.remoteAddress ||
      'unknown'
    );
  }

  /**
   * Check if user has required permissions
   */
  private checkPermissions(
    userPermissions: string[],
    requiredPermissions: string[]
  ): boolean {
    // Admin permission grants access to everything
    if (userPermissions.includes(API_PERMISSIONS.ADMIN)) {
      return true;
    }

    // Check if user has all required permissions
    return requiredPermissions.every(permission =>
      userPermissions.includes(permission)
    );
  }

  /**
   * Check if user has required scopes
   */
  private checkScopes(userScopes: string[], requiredScopes: string[]): boolean {
    // Wildcard scope grants access to everything
    if (userScopes.includes('*')) {
      return true;
    }

    // Check if user has all required scopes
    return requiredScopes.every(scope => userScopes.includes(scope));
  }

  /**
   * Send authentication error response.
   *
   * @param statusCode  401 for missing/invalid credentials; 403 for valid
   *                    credentials that lack the required permission/scope.
   */
  private sendAuthError(res: Response, errorCode: string, message: string, statusCode = 401): void {
    res.status(statusCode).json({
      success: false,
      error: {
        code: errorCode,
        message,
      },
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Add rate limit headers to response
   */
  private addRateLimitHeaders(
    res: Response,
    remainingQuota?: { daily: number; monthly: number }
  ): void {
    if (remainingQuota) {
      res.set({
        'X-RateLimit-Remaining-Daily': remainingQuota.daily.toString(),
        'X-RateLimit-Remaining-Monthly': remainingQuota.monthly.toString(),
        'X-RateLimit-Reset-Daily': this.getDailyResetTime(),
        'X-RateLimit-Reset-Monthly': this.getMonthlyResetTime(),
      });
    }
  }

  /**
   * Get daily reset time (next midnight UTC)
   */
  private getDailyResetTime(): string {
    const tomorrow = new Date();
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    return Math.floor(tomorrow.getTime() / 1000).toString();
  }

  /**
   * Get monthly reset time (next month UTC)
   */
  private getMonthlyResetTime(): string {
    const nextMonth = new Date();
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1);
    nextMonth.setUTCDate(1);
    nextMonth.setUTCHours(0, 0, 0, 0);
    return Math.floor(nextMonth.getTime() / 1000).toString();
  }

  /**
   * Get retry after time for rate limit (in seconds)
   */
  private getRetryAfter(): number {
    const now = new Date();
    const nextHour = new Date(now);
    nextHour.setHours(nextHour.getHours() + 1, 0, 0, 0);
    return Math.floor((nextHour.getTime() - now.getTime()) / 1000);
  }

  /**
   * Log API usage internal method
   */
  private async logUsageInternal(
    req: AuthenticatedRequest,
    apiKeyId: string,
    statusCode: number,
    responseTime: number,
    metadata?: { error?: string }
  ): Promise<void> {
    try {
      await this.apiKeyService.recordUsage(
        apiKeyId,
        req.path,
        req.method,
        statusCode,
        responseTime,
        {
          userAgent: req.get('User-Agent'),
          ipAddress: this.getClientIp(req),
          referrer: req.get('Referer'),
          errorCode: metadata?.error ? 'AUTH_ERROR' : undefined,
          errorMessage: metadata?.error,
        }
      );
    } catch (error) {
      securityLogger.error('Error logging API usage', { error: error instanceof Error ? error.message : String(error) });
    }
  }
}

// Helper function to get client IP (for use in log usage middleware)
function getClientIp(req: AuthenticatedRequest): string {
  return (
    req.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    req.get('X-Real-IP') ||
    req.socket.remoteAddress ||
    'unknown'
  );
}

// Export singleton instance
export const apiKeyAuth = new ApiKeyAuthMiddleware();

// Export convenience methods
export const requireApiKey = apiKeyAuth.authenticate.bind(apiKeyAuth);
export const requirePermissions =
  apiKeyAuth.requirePermissions.bind(apiKeyAuth);
export const requireScopes = apiKeyAuth.requireScopes.bind(apiKeyAuth);
export const requireAdmin = apiKeyAuth.requireAdmin.bind(apiKeyAuth);
export const logApiUsage = apiKeyAuth.logUsage.bind(apiKeyAuth);
