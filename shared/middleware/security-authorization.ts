/**
 * Security Authorization Middleware - Combined Exports
 *
 * This module re-exports all session security and API authorization middleware
 * for convenient import in route files.
 *
 * SECURITY IMPLEMENTATION (Tasks 103.5, 103.6):
 * - CSRF Protection: Prevents cross-site request forgery attacks
 * - Object Authorization: Enforces resource-level access control
 * - Mass Assignment Protection: Prevents attackers from setting restricted fields
 */

// CSRF Protection
export {
  csrfProtectionMiddleware,
  generateCsrfToken,
  generateCsrfTokenMiddleware,
  getCsrfTokenEndpoint,
  CSRF_CONSTANTS,
  type CSRFProtectionConfig,
} from './csrf-protection.js';

// Object-Level Authorization
export {
  createObjectAuthorizationMiddleware,
  requireOwnership,
  requireSelfOrAdmin,
  isAuthorized,
  requireResourcePermission,
  type AuthorizationCheck,
  type AuthorizedUser,
} from './object-authorization.js';

// Mass Assignment Protection
export {
  createAllowedFieldsMiddleware,
  createBlockedFieldsMiddleware,
  createCommonFieldsProtection,
  sanitizeFields,
  pickFields,
  omitFields,
  COMMON_BLOCKED_FIELDS,
  type MassAssignmentConfig,
  type FieldSpec,
} from './mass-assignment-protection.js';

/**
 * Recommended security middleware stack for state-changing API routes
 *
 * USAGE:
 * ```typescript
 * import {
 *   csrfProtectionMiddleware,
 *   createAllowedFieldsMiddleware,
 *   createCommonFieldsProtection,
 * } from '../shared/middleware/security-authorization.js';
 * import { requireAuth } from '../middleware/authMiddleware.js';
 *
 * // Apply CSRF protection to entire app
 * app.use(csrfProtectionMiddleware());
 *
 * // Apply common field protection
 * app.use(createCommonFieldsProtection());
 *
 * // Per-route with specific allowed fields
 * router.post('/resource',
 *   requireAuth,
 *   createAllowedFieldsMiddleware(['name', 'description', 'settings']),
 *   handler
 * );
 * ```
 */

// Convenience types for common patterns
export interface SecureRouteOptions {
  /** Require authentication */
  requireAuth?: boolean;
  /** CSRF protection enabled */
  csrfProtection?: boolean;
  /** Allowed fields for request body */
  allowedFields?: string[];
  /** Blocked fields for request body (if allowedFields not specified) */
  blockedFields?: string[];
  /** Resource type for object authorization */
  resourceType?: string;
  /** Function to get resource owner ID */
  getResourceOwnerId?: (req: any) => Promise<string | null>;
}
