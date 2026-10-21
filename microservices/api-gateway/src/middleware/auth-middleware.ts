import { Request, Response, NextFunction } from 'express';
import * as jwt from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../../../../server/auth/jwt-constants.js';
import { JwtPayload } from 'jsonwebtoken';

import {
  AuthenticatedRequest as BaseAuthenticatedRequest,
  Permission,
} from '../../../../shared/types/security-types.ts';
import { securityLogger } from '../../../../server/utils/logger.js';

export interface AuthenticatedRequest extends BaseAuthenticatedRequest {
  service?: {
    name: string;
    id: string;
  };
}

/**
 * 102.9: Role hierarchy for RBAC permission validation
 * Higher numbers indicate more privileged roles.
 * SECURITY: This hierarchy prevents privilege escalation attacks by ensuring
 * users can only assign roles below their own level.
 */
export const ROLE_HIERARCHY: Record<string, number> = {
  admin: 3,
  moderator: 2,
  user: 1,
  guest: 0,
};

/**
 * 102.9: Extended user permissions structure for granular access control
 * Supports both legacy string[] permissions and new Permission[] structure
 */
export interface ExtendedUserPermissions {
  id: string;
  address: string;
  role: string;
  permissions?: string[] | Permission[];
}

export class AuthMiddleware {
  // 102.2: Secure JWT secret management - fail fast if not properly configured
  private static readonly JWT_SECRET = (() => {
    const secret = process.env.JWT_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error(
        'JWT_SECRET environment variable must be set with at least 32 characters'
      );
    }
    return secret;
  })();

  /**
   * 102.9: Check if a user's permissions array contains a specific resource:action permission.
   * Supports both legacy string[] format ("resource:action") and new Permission[] format.
   *
   * SECURITY: This method provides granular permission checking beyond role-based access,
   * enabling fine-grained authorization for specific resources and actions.
   *
   * @param permissions - User's permissions array (string[] or Permission[])
   * @param resource - The resource to check access for (e.g., 'users', 'weather-data')
   * @param action - The action to check (e.g., 'read', 'write', 'delete', 'admin')
   * @returns boolean indicating if the user has the required permission
   */
  private static hasPermission(
    permissions: string[] | Permission[] | undefined,
    resource: string,
    action: string
  ): boolean {
    if (!permissions || permissions.length === 0) {
      return false;
    }

    // Check if permissions is in the new Permission[] format
    if (typeof permissions[0] === 'object' && 'resource' in permissions[0]) {
      return (permissions as Permission[]).some(
        (p) => p.resource === resource && p.action === action
      );
    }

    // Legacy string[] format: "resource:action"
    const permissionString = `${resource}:${action}`;
    return (permissions as string[]).includes(permissionString);
  }

  /**
   * 102.9: Validate if a user with the given role can assign a target role.
   *
   * SECURITY: Prevents privilege escalation by ensuring users cannot:
   * 1. Assign roles equal to or higher than their own
   * 2. Assign roles that don't exist in the hierarchy
   *
   * @param assignerRole - The role of the user attempting to assign a role
   * @param targetRole - The role being assigned
   * @returns boolean indicating if the assignment is allowed
   */
  static canAssignRole(assignerRole: string, targetRole: string): boolean {
    const assignerLevel = ROLE_HIERARCHY[assignerRole];
    const targetLevel = ROLE_HIERARCHY[targetRole];

    // Unknown roles cannot be assigned or used to assign
    if (assignerLevel === undefined || targetLevel === undefined) {
      return false;
    }

    // Users can only assign roles strictly below their own level
    return assignerLevel > targetLevel;
  }

  /**
   * 102.9: Check if a user is attempting to modify their own role (self-escalation prevention).
   *
   * SECURITY: This is a critical check to prevent users from escalating their own privileges.
   * Even admins should not be able to modify their own role without additional verification.
   *
   * @param requestingUserId - The ID of the user making the request
   * @param targetUserId - The ID of the user whose role is being modified
   * @returns boolean indicating if this is a self-modification attempt
   */
  static isSelfRoleModification(
    requestingUserId: string,
    targetUserId: string
  ): boolean {
    return requestingUserId === targetUserId;
  }

  // 102.2: Secure service token management - fail fast if not properly configured
  private static readonly SERVICE_TOKEN = (() => {
    const token = process.env.SERVICE_TOKEN;
    if (!token || token.length < 32) {
      throw new Error(
        'SERVICE_TOKEN environment variable must be set with at least 32 characters'
      );
    }
    return token;
  })();

  // JWT verification options for algorithm constraint (102.1)
  private static readonly JWT_VERIFY_OPTIONS: jwt.VerifyOptions = {
    algorithms: ['HS256', 'HS384', 'HS512'],
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    clockTolerance: 30,
  };

  // JWT signing options for token generation
  private static readonly JWT_SIGN_OPTIONS: jwt.SignOptions = {
    algorithm: 'HS256',
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: '24h',
  };

  /**
   * Middleware to verify JWT tokens for user authentication
   */
  static verifyUserToken(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void {
    try {
      const authHeader = req.headers.authorization;

      if (!authHeader || !authHeader.startsWith('Bearer ')) {
        res.status(401).json({
          success: false,
          error: {
            code: 'MISSING_TOKEN',
            message: 'Authorization token required',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const token = authHeader.substring(7); // Remove 'Bearer ' prefix

      try {
        // 102.1: JWT algorithm validation - constrain to approved algorithms
        const decoded = jwt.verify(
          token,
          AuthMiddleware.JWT_SECRET,
          AuthMiddleware.JWT_VERIFY_OPTIONS
        ) as JwtPayload & {
          id: string;
          address: string;
          role?: string;
          permissions?: string[];
        };

        if (!decoded.id || !decoded.address) {
          res.status(401).json({
            success: false,
            error: {
              code: 'INVALID_TOKEN_PAYLOAD',
              message: 'Token payload is invalid',
            },
            timestamp: new Date().toISOString(),
          });
          return;
        }

        req.user = {
          id: decoded.id,
          address: decoded.address,
          role: decoded.role || 'user',
          permissions: decoded.permissions || ['read'],
        };

        next();
      } catch (jwtError) {
        res.status(401).json({
          success: false,
          error: {
            code: 'INVALID_TOKEN',
            message: 'Token is invalid or expired',
          },
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error) {
      securityLogger.error('Auth middleware error', {
        operation: 'auth:middleware:error',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'AUTH_ERROR',
          message: 'Authentication service error',
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Middleware to verify service-to-service communication tokens
   */
  static verifyServiceToken(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void {
    try {
      const serviceHeader = req.headers['x-service-token'];

      if (!serviceHeader || serviceHeader !== AuthMiddleware.SERVICE_TOKEN) {
        res.status(403).json({
          success: false,
          error: {
            code: 'INVALID_SERVICE_TOKEN',
            message: 'Invalid service authentication',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const serviceName = req.headers['x-service-name'];
      const serviceId = req.headers['x-service-id'];

      if (!serviceName || !serviceId) {
        res.status(403).json({
          success: false,
          error: {
            code: 'MISSING_SERVICE_INFO',
            message: 'Service name and ID required',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      req.service = {
        name: serviceName as string,
        id: serviceId as string,
      };

      next();
    } catch (error) {
      securityLogger.error('Service auth middleware error', {
        operation: 'auth:service:middleware:error',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      res.status(500).json({
        success: false,
        error: {
          code: 'SERVICE_AUTH_ERROR',
          message: 'Service authentication error',
        },
        timestamp: new Date().toISOString(),
      });
    }
  }

  /**
   * Optional authentication - allows both authenticated and anonymous users
   */
  static optionalAuth(
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      // No token provided, continue as anonymous user
      next();
      return;
    }

    // Token provided, verify it
    AuthMiddleware.verifyUserToken(req, res, next);
  }

  /**
   * Generate JWT token for user
   * Uses secure signing options with issuer/audience for verification compatibility
   */
  static generateUserToken(user: {
    id: string;
    address: string;
    role?: string;
  }): string {
    return jwt.sign(
      {
        id: user.id,
        address: user.address,
        role: user.role || 'user',
      },
      AuthMiddleware.JWT_SECRET,
      AuthMiddleware.JWT_SIGN_OPTIONS
    );
  }

  /**
   * Generate service token for inter-service communication
   */
  static generateServiceToken(): string {
    return AuthMiddleware.SERVICE_TOKEN;
  }

  /**
   * Middleware to check if user has required role.
   * 102.9: Enhanced with role hierarchy validation for consistent access control.
   *
   * SECURITY: Admin role auto-escalates to all roles for backward compatibility,
   * but specific permission checks should use requirePermission() for granular control.
   *
   * @param requiredRole - The minimum role required to access the resource
   */
  static requireRole(requiredRole: string) {
    return (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ): void => {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'User authentication required',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const userRole = req.user.role || 'guest';
      const userRoleLevel = ROLE_HIERARCHY[userRole] ?? 0;
      const requiredRoleLevel = ROLE_HIERARCHY[requiredRole] ?? 0;

      // 102.9: Use role hierarchy for comparison instead of exact match
      // Admin still auto-escalates, but now any role >= required role level passes
      if (userRoleLevel < requiredRoleLevel) {
        res.status(403).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_ROLE',
            message: `Role '${requiredRole}' or higher required`,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      next();
    };
  }

  /**
   * 102.9: Middleware to check if user has a specific granular permission.
   *
   * SECURITY: This provides fine-grained access control beyond role-based access.
   * Use this for resource-specific operations where role-level access is too broad.
   *
   * Example usage:
   *   router.delete('/users/:id', AuthMiddleware.requirePermission('users', 'delete'), handler);
   *   router.post('/weather-data', AuthMiddleware.requirePermission('weather-data', 'write'), handler);
   *
   * @param resource - The resource being accessed (e.g., 'users', 'weather-data', 'carbon-credits')
   * @param action - The action being performed (e.g., 'read', 'write', 'delete', 'admin')
   */
  static requirePermission(resource: string, action: string) {
    return (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ): void => {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'User authentication required',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Check if user has the specific permission
      const hasPermission = AuthMiddleware.hasPermission(
        req.user.permissions,
        resource,
        action
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: {
            code: 'PERMISSION_DENIED',
            message: `Permission '${resource}:${action}' required`,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      next();
    };
  }

  /**
   * 102.9: Middleware to validate role assignment requests.
   *
   * SECURITY: Prevents privilege escalation by enforcing:
   * 1. Users cannot modify their own role
   * 2. Users can only assign roles below their own level
   * 3. Only valid roles from ROLE_HIERARCHY can be assigned
   *
   * Use this middleware before any endpoint that modifies user roles.
   *
   * @param getTargetUserId - Function to extract target user ID from request
   * @param getTargetRole - Function to extract target role from request
   */
  static validateRoleAssignment(
    getTargetUserId: (req: AuthenticatedRequest) => string,
    getTargetRole: (req: AuthenticatedRequest) => string
  ) {
    return (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ): void => {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'User authentication required',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const targetUserId = getTargetUserId(req);
      const targetRole = getTargetRole(req);
      const assignerRole = req.user.role || 'guest';

      // SECURITY: Prevent self-role modification (privilege escalation vector)
      if (AuthMiddleware.isSelfRoleModification(req.user.id, targetUserId)) {
        res.status(403).json({
          success: false,
          error: {
            code: 'SELF_ROLE_MODIFICATION_DENIED',
            message: 'Users cannot modify their own role',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // SECURITY: Validate role hierarchy (prevent assigning equal or higher roles)
      if (!AuthMiddleware.canAssignRole(assignerRole, targetRole)) {
        res.status(403).json({
          success: false,
          error: {
            code: 'ROLE_ASSIGNMENT_DENIED',
            message: `Cannot assign role '${targetRole}' - insufficient privileges`,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      next();
    };
  }

  /**
   * 102.9: Combined middleware requiring both role AND permission.
   *
   * SECURITY: Use this for high-security operations that require both:
   * 1. A minimum role level
   * 2. A specific granular permission
   *
   * @param requiredRole - The minimum role required
   * @param resource - The resource for permission check
   * @param action - The action for permission check
   */
  static requireRoleAndPermission(
    requiredRole: string,
    resource: string,
    action: string
  ) {
    return (
      req: AuthenticatedRequest,
      res: Response,
      next: NextFunction
    ): void => {
      if (!req.user) {
        res.status(401).json({
          success: false,
          error: {
            code: 'AUTHENTICATION_REQUIRED',
            message: 'User authentication required',
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const userRole = req.user.role || 'guest';
      const userRoleLevel = ROLE_HIERARCHY[userRole] ?? 0;
      const requiredRoleLevel = ROLE_HIERARCHY[requiredRole] ?? 0;

      // Check role requirement
      if (userRoleLevel < requiredRoleLevel) {
        res.status(403).json({
          success: false,
          error: {
            code: 'INSUFFICIENT_ROLE',
            message: `Role '${requiredRole}' or higher required`,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Check permission requirement (admin does NOT bypass this check)
      const hasPermission = AuthMiddleware.hasPermission(
        req.user.permissions,
        resource,
        action
      );

      if (!hasPermission) {
        res.status(403).json({
          success: false,
          error: {
            code: 'PERMISSION_DENIED',
            message: `Permission '${resource}:${action}' required in addition to role`,
          },
          timestamp: new Date().toISOString(),
        });
        return;
      }

      next();
    };
  }
}
