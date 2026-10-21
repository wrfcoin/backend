/**
 * RBAC Middleware for Express Routes
 * Task 94.11: Role-Based Access Control middleware implementation
 *
 * Provides Express middleware functions for:
 * - Role-based route protection
 * - Permission-based route protection
 * - Combined role and permission checks
 */

import { Request, Response, NextFunction } from 'express';
import {
  Role,
  Permission,
  ROLES,
  ACTIONS,
  RESOURCES,
  hasMinimumRole,
  hasPermission,
  hasAnyRole,
  getHighestRole,
  parseRoles,
  Action,
  Resource,
} from '../../shared/rbac.js';

// Re-export constants for convenience
export { ROLES, ACTIONS, RESOURCES, Role, Permission, Action, Resource };

/**
 * Extended Request interface with user information
 */
export interface RBACRequest extends Request {
  user?: {
    id: string;
    userId?: string;
    roles?: string[];
    permissions?: string[];
    sessionId?: string;
  };
}

/**
 * Standard error response format
 */
const errorResponse = (message: string, code: string) => ({
  success: false,
  error: {
    code,
    message,
  },
  timestamp: new Date().toISOString(),
});

/**
 * Middleware to require a minimum role level
 *
 * @param minRole - The minimum role required to access the route
 * @returns Express middleware function
 *
 * @example
 * router.get('/admin/stats', requireRole(ROLES.ADMIN), statsHandler);
 */
export const requireRole = (minRole: Role) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rbacReq = req as RBACRequest;

    if (!rbacReq.user) {
      res.status(401).json(
        errorResponse('Authentication required', 'AUTHENTICATION_REQUIRED')
      );
      return;
    }

    const userRoles = parseRoles(rbacReq.user.roles);
    const highestRole = getHighestRole(userRoles);

    if (!hasMinimumRole(highestRole, minRole)) {
      res.status(403).json(
        errorResponse(
          `Insufficient role. Required: ${minRole}, You have: ${highestRole}`,
          'INSUFFICIENT_ROLE'
        )
      );
      return;
    }

    next();
  };
};

/**
 * Middleware to require any of the specified roles
 *
 * @param allowedRoles - Array of roles that can access the route
 * @returns Express middleware function
 *
 * @example
 * router.get('/reports', requireAnyRole([ROLES.ADMIN, ROLES.OPERATOR]), reportsHandler);
 */
export const requireAnyRole = (allowedRoles: Role[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rbacReq = req as RBACRequest;

    if (!rbacReq.user) {
      res.status(401).json(
        errorResponse('Authentication required', 'AUTHENTICATION_REQUIRED')
      );
      return;
    }

    const userRoles = parseRoles(rbacReq.user.roles);

    if (!hasAnyRole(userRoles, allowedRoles)) {
      res.status(403).json(
        errorResponse(
          `Insufficient role. Required one of: ${allowedRoles.join(', ')}`,
          'INSUFFICIENT_ROLE'
        )
      );
      return;
    }

    next();
  };
};

/**
 * Middleware to require a specific permission
 *
 * @param action - The action being performed
 * @param resource - The resource being accessed
 * @returns Express middleware function
 *
 * @example
 * router.delete('/users/:id', requirePermission('delete', 'user'), deleteUserHandler);
 */
export const requirePermission = (action: Action, resource: Resource) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rbacReq = req as RBACRequest;

    if (!rbacReq.user) {
      res.status(401).json(
        errorResponse('Authentication required', 'AUTHENTICATION_REQUIRED')
      );
      return;
    }

    const userRoles = parseRoles(rbacReq.user.roles);
    const highestRole = getHighestRole(userRoles);
    const permission = `${action}:${resource}` as Permission;

    if (!hasPermission(highestRole, permission)) {
      res.status(403).json(
        errorResponse(
          `Permission denied. Required: ${permission}`,
          'PERMISSION_DENIED'
        )
      );
      return;
    }

    next();
  };
};

/**
 * Middleware to require any of the specified permissions
 *
 * @param permissions - Array of permission tuples [action, resource]
 * @returns Express middleware function
 *
 * @example
 * router.get('/data', requireAnyPermission([['read', 'weather_data'], ['admin', 'weather_data']]), dataHandler);
 */
export const requireAnyPermission = (permissions: [Action, Resource][]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rbacReq = req as RBACRequest;

    if (!rbacReq.user) {
      res.status(401).json(
        errorResponse('Authentication required', 'AUTHENTICATION_REQUIRED')
      );
      return;
    }

    const userRoles = parseRoles(rbacReq.user.roles);
    const highestRole = getHighestRole(userRoles);

    const hasAnyPerm = permissions.some(([action, resource]) => {
      const permission = `${action}:${resource}` as Permission;
      return hasPermission(highestRole, permission);
    });

    if (!hasAnyPerm) {
      const permStrings = permissions.map(([a, r]) => `${a}:${r}`).join(', ');
      res.status(403).json(
        errorResponse(
          `Permission denied. Required one of: ${permStrings}`,
          'PERMISSION_DENIED'
        )
      );
      return;
    }

    next();
  };
};

/**
 * Middleware to require admin role specifically
 * Shorthand for requireRole(ROLES.ADMIN)
 *
 * @returns Express middleware function
 *
 * @example
 * router.post('/cleanup', requireAdmin(), cleanupHandler);
 */
export const requireAdmin = () => requireRole(ROLES.ADMIN);

/**
 * Middleware to require operator role or higher
 * Shorthand for requireRole(ROLES.OPERATOR)
 *
 * @returns Express middleware function
 *
 * @example
 * router.post('/data/submit', requireOperator(), submitHandler);
 */
export const requireOperator = () => requireRole(ROLES.OPERATOR);

/**
 * Middleware to require authenticated user role or higher
 * Shorthand for requireRole(ROLES.USER)
 *
 * @returns Express middleware function
 *
 * @example
 * router.get('/profile', requireUser(), profileHandler);
 */
export const requireUser = () => requireRole(ROLES.USER);

/**
 * Middleware to allow access but attach role information
 * Useful for routes that behave differently based on role
 *
 * @returns Express middleware function that always passes but sets role info
 */
export const attachRoleInfo = () => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const rbacReq = req as RBACRequest;

    if (rbacReq.user?.roles) {
      const userRoles = parseRoles(rbacReq.user.roles);
      // Attach computed role info to request
      (rbacReq as any).rbac = {
        roles: userRoles,
        highestRole: getHighestRole(userRoles),
        isAdmin: hasMinimumRole(getHighestRole(userRoles), ROLES.ADMIN),
        isOperator: hasMinimumRole(getHighestRole(userRoles), ROLES.OPERATOR),
      };
    } else {
      (rbacReq as any).rbac = {
        roles: [ROLES.GUEST],
        highestRole: ROLES.GUEST,
        isAdmin: false,
        isOperator: false,
      };
    }

    next();
  };
};

/**
 * Middleware factory for resource-based access control
 * Checks if user can perform action on resource with optional owner check
 *
 * @param action - The action being performed
 * @param resource - The resource type
 * @param getResourceOwnerId - Optional function to get resource owner ID
 * @returns Express middleware function
 *
 * @example
 * router.delete('/posts/:id', checkResourceAccess('delete', 'post', req => getPostOwnerId(req.params.id)), deletePostHandler);
 */
export const checkResourceAccess = (
  action: Action,
  resource: Resource,
  getResourceOwnerId?: (req: Request) => Promise<string | null>
) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const rbacReq = req as RBACRequest;

    if (!rbacReq.user) {
      res.status(401).json(
        errorResponse('Authentication required', 'AUTHENTICATION_REQUIRED')
      );
      return;
    }

    const userRoles = parseRoles(rbacReq.user.roles);
    const highestRole = getHighestRole(userRoles);
    const permission = `${action}:${resource}` as Permission;

    // Check if user has general permission
    if (hasPermission(highestRole, permission)) {
      next();
      return;
    }

    // If owner check function provided, check resource ownership
    if (getResourceOwnerId) {
      try {
        const ownerId = await getResourceOwnerId(req);
        const userId = rbacReq.user.id || rbacReq.user.userId;

        if (ownerId && ownerId === userId) {
          // Owner can perform action on their own resource
          next();
          return;
        }
      } catch (error) {
        // Owner check failed, fall through to permission denied
      }
    }

    res.status(403).json(
      errorResponse(
        `Permission denied. Required: ${permission}`,
        'PERMISSION_DENIED'
      )
    );
  };
};

/**
 * Combine multiple middleware checks (all must pass)
 *
 * @param middlewares - Array of middleware functions
 * @returns Combined middleware function
 *
 * @example
 * router.post('/admin/action', combineChecks([requireAdmin(), requirePermission('execute', 'cleanup')]), actionHandler);
 */
export const combineChecks = (
  middlewares: ((req: Request, res: Response, next: NextFunction) => void)[]
) => {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    let index = 0;

    const runNext = (err?: any): void => {
      if (err) {
        return;
      }

      if (index >= middlewares.length) {
        next();
        return;
      }

      const middleware = middlewares[index];
      index++;

      try {
        middleware(req, res, runNext);
      } catch (error) {
        res.status(500).json(
          errorResponse('Internal server error during authorization', 'AUTH_ERROR')
        );
      }
    };

    runNext();
  };
};

export default {
  requireRole,
  requireAnyRole,
  requirePermission,
  requireAnyPermission,
  requireAdmin,
  requireOperator,
  requireUser,
  attachRoleInfo,
  checkResourceAccess,
  combineChecks,
};
