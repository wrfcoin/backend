/**
 * Object-Level Authorization Middleware
 *
 * Implements fine-grained access control at the resource/object level.
 * Ensures users can only access resources they own or have explicit permission for.
 *
 * SECURITY IMPLEMENTATION (Task 103.6):
 * - Enforces ownership checks on resource operations
 * - Supports role-based access escalation (admin can access any resource)
 * - Provides flexible resource type definitions
 * - Logs authorization failures for security audit
 * - Prevents IDOR (Insecure Direct Object Reference) vulnerabilities
 */

import type { Request, Response, NextFunction } from 'express';
import { securityLogger } from '../../server/utils/logger.js';

/**
 * User information for authorization checks
 */
interface AuthorizedUser {
  id: string;
  address?: string;
  role?: string;
  roles?: string[];
  permissions?: string[];
}

/**
 * Authorization check configuration
 */
export interface AuthorizationCheck {
  /** Resource type name for error messages (e.g., 'wallet', 'transaction', 'nft') */
  resourceType: string;

  /**
   * Function to extract resource owner ID from request
   * Should return null if resource not found or owner cannot be determined
   */
  getResourceOwnerId: (req: Request) => Promise<string | null>;

  /**
   * Optional: Function to check if user has explicit permission for resource
   * Useful for shared resources or delegated access
   */
  hasExplicitPermission?: (req: Request, user: AuthorizedUser) => Promise<boolean>;

  /**
   * Roles that can access any resource of this type (default: ['admin'])
   */
  privilegedRoles?: string[];

  /**
   * Custom error handler for authorization failures
   */
  onUnauthorized?: (req: Request, res: Response, reason: string) => void;

  /**
   * Enable detailed logging of authorization decisions
   */
  enableLogging?: boolean;
}

/**
 * Authorization result interface
 */
interface AuthorizationResult {
  authorized: boolean;
  reason: string;
  userId?: string;
  resourceOwnerId?: string | null;
  accessType: 'owner' | 'privileged_role' | 'explicit_permission' | 'denied';
}

/**
 * Default privileged roles that can access any resource
 */
const DEFAULT_PRIVILEGED_ROLES = ['admin', 'superadmin', 'system'];

/**
 * Default unauthorized handler
 */
const defaultUnauthorizedHandler = (
  req: Request,
  res: Response,
  reason: string
): void => {
  res.status(403).json({
    error: 'Access Denied',
    message: reason,
    code: 'AUTHORIZATION_DENIED',
  });
};

/**
 * Log authorization decision for audit purposes
 */
function logAuthorizationDecision(
  req: Request,
  result: AuthorizationResult,
  resourceType: string
): void {
  const logData = {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.path,
    resourceType,
    userId: result.userId || 'unauthenticated',
    resourceOwnerId: result.resourceOwnerId,
    accessType: result.accessType,
    authorized: result.authorized,
    reason: result.reason,
    ip: req.ip || req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  };

  if (result.authorized) {
    securityLogger.info('Access granted', { module: 'ObjectAuthorization', ...logData });
  } else {
    securityLogger.warn('Access denied', { module: 'ObjectAuthorization', ...logData });
  }
}

/**
 * Check if user has a privileged role
 */
function hasPrivilegedRole(user: AuthorizedUser, privilegedRoles: string[]): boolean {
  // Check single role field
  if (user.role && privilegedRoles.includes(user.role)) {
    return true;
  }

  // Check roles array
  if (user.roles && Array.isArray(user.roles)) {
    return user.roles.some((role) => privilegedRoles.includes(role));
  }

  return false;
}

/**
 * Creates object-level authorization middleware
 *
 * USAGE:
 * ```typescript
 * import { createObjectAuthorizationMiddleware } from './middleware/object-authorization.js';
 *
 * // Basic usage - check if user owns the wallet
 * const walletAuthz = createObjectAuthorizationMiddleware({
 *   resourceType: 'wallet',
 *   getResourceOwnerId: async (req) => {
 *     const wallet = await WalletService.findById(req.params.walletId);
 *     return wallet?.ownerId || null;
 *   },
 * });
 *
 * router.get('/wallet/:walletId', requireAuth, walletAuthz, getWalletHandler);
 * router.delete('/wallet/:walletId', requireAuth, walletAuthz, deleteWalletHandler);
 * ```
 *
 * @param check - Authorization check configuration
 * @returns Express middleware function
 */
export function createObjectAuthorizationMiddleware(check: AuthorizationCheck) {
  const privilegedRoles = check.privilegedRoles || DEFAULT_PRIVILEGED_ROLES;
  const onUnauthorized = check.onUnauthorized || defaultUnauthorizedHandler;
  const enableLogging = check.enableLogging ?? (process.env.NODE_ENV !== 'test');

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    // Get authenticated user from request
    const user = req.user as AuthorizedUser | undefined;

    // Authentication is required for authorization
    if (!user) {
      const result: AuthorizationResult = {
        authorized: false,
        reason: 'Authentication required',
        accessType: 'denied',
      };

      if (enableLogging) {
        logAuthorizationDecision(req, result, check.resourceType);
      }

      res.status(401).json({
        error: 'Authentication Required',
        message: 'You must be authenticated to access this resource',
        code: 'AUTHENTICATION_REQUIRED',
      });
      return;
    }

    try {
      // Check if user has a privileged role (can access any resource)
      if (hasPrivilegedRole(user, privilegedRoles)) {
        const result: AuthorizationResult = {
          authorized: true,
          reason: 'Privileged role access',
          userId: user.id,
          accessType: 'privileged_role',
        };

        if (enableLogging) {
          logAuthorizationDecision(req, result, check.resourceType);
        }

        next();
        return;
      }

      // Get the resource owner ID
      const resourceOwnerId = await check.getResourceOwnerId(req);

      // If resource not found, let the route handler deal with 404
      if (resourceOwnerId === null) {
        const result: AuthorizationResult = {
          authorized: true, // Let it pass - route will handle 404
          reason: 'Resource not found or owner unknown - delegating to handler',
          userId: user.id,
          resourceOwnerId: null,
          accessType: 'owner',
        };

        if (enableLogging) {
          logAuthorizationDecision(req, result, check.resourceType);
        }

        next();
        return;
      }

      // Check if user is the owner
      if (resourceOwnerId === user.id || resourceOwnerId === user.address) {
        const result: AuthorizationResult = {
          authorized: true,
          reason: 'User is resource owner',
          userId: user.id,
          resourceOwnerId,
          accessType: 'owner',
        };

        if (enableLogging) {
          logAuthorizationDecision(req, result, check.resourceType);
        }

        next();
        return;
      }

      // Check for explicit permission if configured
      if (check.hasExplicitPermission) {
        const hasPermission = await check.hasExplicitPermission(req, user);
        if (hasPermission) {
          const result: AuthorizationResult = {
            authorized: true,
            reason: 'User has explicit permission',
            userId: user.id,
            resourceOwnerId,
            accessType: 'explicit_permission',
          };

          if (enableLogging) {
            logAuthorizationDecision(req, result, check.resourceType);
          }

          next();
          return;
        }
      }

      // Authorization denied
      const result: AuthorizationResult = {
        authorized: false,
        reason: `You do not have permission to access this ${check.resourceType}`,
        userId: user.id,
        resourceOwnerId,
        accessType: 'denied',
      };

      if (enableLogging) {
        logAuthorizationDecision(req, result, check.resourceType);
      }

      onUnauthorized(req, res, result.reason);
    } catch (error) {
      securityLogger.error('Error during authorization check', { module: 'ObjectAuthorization', error: error instanceof Error ? error.message : String(error) });

      // Don't expose internal errors - fail closed
      const result: AuthorizationResult = {
        authorized: false,
        reason: 'Authorization check failed',
        userId: user.id,
        accessType: 'denied',
      };

      if (enableLogging) {
        logAuthorizationDecision(req, result, check.resourceType);
      }

      res.status(500).json({
        error: 'Authorization Error',
        message: 'Unable to verify access permissions',
        code: 'AUTHORIZATION_ERROR',
      });
    }
  };
}

/**
 * Creates a simple ownership check middleware
 * Convenient wrapper for common ownership patterns
 *
 * @param resourceType - Resource type name for error messages
 * @param getOwnerId - Function to get owner ID from request params/body
 * @returns Express middleware function
 */
export function requireOwnership(
  resourceType: string,
  getOwnerId: (req: Request) => string | null | Promise<string | null>
) {
  return createObjectAuthorizationMiddleware({
    resourceType,
    getResourceOwnerId: async (req) => {
      const result = getOwnerId(req);
      return result instanceof Promise ? await result : result;
    },
  });
}

/**
 * Creates middleware that checks if user matches a URL parameter
 * Common pattern for user-specific routes like /users/:userId/...
 *
 * @param paramName - URL parameter name to check (default: 'userId')
 * @param resourceType - Resource type name (default: 'resource')
 * @returns Express middleware function
 */
export function requireSelfOrAdmin(
  paramName: string = 'userId',
  resourceType: string = 'resource'
) {
  return createObjectAuthorizationMiddleware({
    resourceType,
    getResourceOwnerId: async (req) => {
      return req.params[paramName] || null;
    },
    privilegedRoles: ['admin', 'superadmin'],
  });
}

/**
 * Utility to check authorization programmatically
 * Useful for service layer authorization checks
 *
 * @param userId - ID of user requesting access
 * @param userRoles - User's roles
 * @param resourceOwnerId - Owner ID of the resource
 * @param privilegedRoles - Roles that bypass ownership check
 * @returns Boolean indicating if access should be granted
 */
export function isAuthorized(
  userId: string,
  userRoles: string[],
  resourceOwnerId: string,
  privilegedRoles: string[] = DEFAULT_PRIVILEGED_ROLES
): boolean {
  // Check privileged roles
  if (userRoles.some((role) => privilegedRoles.includes(role))) {
    return true;
  }

  // Check ownership
  return userId === resourceOwnerId;
}

/**
 * Middleware factory for checking specific permissions on resources
 *
 * @param resourceType - Resource type name
 * @param permission - Required permission string
 * @param getResourceOwnerId - Function to get resource owner
 * @returns Express middleware function
 */
export function requireResourcePermission(
  resourceType: string,
  permission: string,
  getResourceOwnerId: (req: Request) => Promise<string | null>
) {
  return createObjectAuthorizationMiddleware({
    resourceType,
    getResourceOwnerId,
    hasExplicitPermission: async (req, user) => {
      // Check if user has the required permission
      return user.permissions?.includes(permission) || false;
    },
  });
}

// Export types for consumers
export type { AuthorizedUser, AuthorizationResult };

// Default export for convenience
export default createObjectAuthorizationMiddleware;
