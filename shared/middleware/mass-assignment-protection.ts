/**
 * Mass Assignment Protection Middleware
 *
 * Prevents mass assignment attacks by filtering request bodies to only include
 * explicitly allowed fields. This protects against attackers adding extra
 * fields like 'isAdmin', 'role', or 'balance' to exploit insecure data binding.
 *
 * SECURITY IMPLEMENTATION (Task 103.6):
 * - Implements allowlist-based field filtering
 * - Supports nested object field specifications
 * - Logs stripped fields for security auditing
 * - Provides flexible configuration per-route
 * - Preserves original request body for audit purposes
 */

import type { Request, Response, NextFunction } from 'express';
import { securityLogger } from '../../server/utils/logger.js';

/**
 * Field specification for nested objects
 * Can be a simple field name string or an object with nested fields
 */
type FieldSpec = string | { [key: string]: FieldSpec[] | true };

/**
 * Mass assignment protection configuration
 */
export interface MassAssignmentConfig {
  /** Enable logging of stripped fields (default: true in non-production) */
  enableLogging?: boolean;
  /** Store original body in req.originalBody for audit (default: false) */
  preserveOriginal?: boolean;
  /** Custom handler when fields are stripped */
  onFieldsStripped?: (req: Request, strippedFields: string[]) => void;
  /** Strict mode - reject request if disallowed fields present (default: false) */
  strictMode?: boolean;
  /** Custom error message for strict mode */
  strictModeMessage?: string;
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Required<MassAssignmentConfig> = {
  enableLogging: process.env.NODE_ENV !== 'production',
  preserveOriginal: false,
  onFieldsStripped: () => {},
  strictMode: false,
  strictModeMessage: 'Request contains disallowed fields',
};

/**
 * Flatten nested field specifications into dot-notation paths
 *
 * @param specs - Array of field specifications
 * @param prefix - Current path prefix
 * @returns Set of allowed field paths
 */
function flattenFieldSpecs(specs: FieldSpec[], prefix: string = ''): Set<string> {
  const paths = new Set<string>();

  for (const spec of specs) {
    if (typeof spec === 'string') {
      paths.add(prefix ? `${prefix}.${spec}` : spec);
    } else if (typeof spec === 'object') {
      for (const [key, value] of Object.entries(spec)) {
        const currentPath = prefix ? `${prefix}.${key}` : key;

        if (value === true) {
          // Allow entire nested object
          paths.add(`${currentPath}.*`);
        } else if (Array.isArray(value)) {
          // Recursively process nested fields
          const nestedPaths = flattenFieldSpecs(value, currentPath);
          nestedPaths.forEach((p) => paths.add(p));
        }
      }
    }
  }

  return paths;
}

/**
 * Check if a field path is allowed based on allowlist
 *
 * @param path - Dot-notation path to check
 * @param allowedPaths - Set of allowed paths
 * @returns True if path is allowed
 */
function isPathAllowed(path: string, allowedPaths: Set<string>): boolean {
  // Direct match
  if (allowedPaths.has(path)) {
    return true;
  }

  // Check for wildcard matches (e.g., "metadata.*" allows "metadata.foo")
  const pathParts = path.split('.');
  for (let i = 1; i <= pathParts.length; i++) {
    const wildcardPath = pathParts.slice(0, i).join('.') + '.*';
    if (allowedPaths.has(wildcardPath)) {
      return true;
    }
  }

  return false;
}

/**
 * Recursively filter object fields based on allowlist
 *
 * @param obj - Object to filter
 * @param allowedPaths - Set of allowed field paths
 * @param currentPath - Current dot-notation path
 * @param strippedFields - Array to collect stripped field names
 * @returns Filtered object
 */
function filterObject(
  obj: Record<string, any>,
  allowedPaths: Set<string>,
  currentPath: string = '',
  strippedFields: string[] = []
): Record<string, any> {
  if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) {
    return obj;
  }

  const result: Record<string, any> = {};

  for (const [key, value] of Object.entries(obj)) {
    const fieldPath = currentPath ? `${currentPath}.${key}` : key;

    if (isPathAllowed(fieldPath, allowedPaths)) {
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        // Recursively filter nested objects
        result[key] = filterObject(value, allowedPaths, fieldPath, strippedFields);
      } else if (Array.isArray(value)) {
        // Handle arrays - filter each object element
        result[key] = value.map((item, index) => {
          if (typeof item === 'object' && item !== null) {
            return filterObject(item, allowedPaths, `${fieldPath}[${index}]`, strippedFields);
          }
          return item;
        });
      } else {
        result[key] = value;
      }
    } else {
      strippedFields.push(fieldPath);
    }
  }

  return result;
}

/**
 * Get all field paths from an object
 *
 * @param obj - Object to analyze
 * @param prefix - Current path prefix
 * @returns Array of all field paths
 */
function getAllPaths(obj: Record<string, any>, prefix: string = ''): string[] {
  const paths: string[] = [];

  if (typeof obj !== 'object' || obj === null) {
    return paths;
  }

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = prefix ? `${prefix}.${key}` : key;
    paths.push(currentPath);

    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      paths.push(...getAllPaths(value, currentPath));
    }
  }

  return paths;
}

/**
 * Creates mass assignment protection middleware with field allowlist
 *
 * USAGE:
 * ```typescript
 * import { createAllowedFieldsMiddleware } from './middleware/mass-assignment-protection.js';
 *
 * // Simple flat field list
 * const userUpdateMiddleware = createAllowedFieldsMiddleware([
 *   'name',
 *   'email',
 *   'avatar',
 *   'preferences',
 * ]);
 *
 * // With nested fields
 * const profileMiddleware = createAllowedFieldsMiddleware([
 *   'name',
 *   'email',
 *   { settings: ['theme', 'notifications', 'language'] },
 *   { metadata: true }, // Allow all fields in metadata object
 * ]);
 *
 * router.put('/user/:id', requireAuth, userUpdateMiddleware, updateUserHandler);
 * ```
 *
 * @param allowedFields - Array of allowed field specifications
 * @param config - Configuration options
 * @returns Express middleware function
 */
export function createAllowedFieldsMiddleware(
  allowedFields: FieldSpec[],
  config: MassAssignmentConfig = {}
) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const allowedPaths = flattenFieldSpecs(allowedFields);

  return (req: Request, res: Response, next: NextFunction): void => {
    // Only process if body exists and is an object
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      next();
      return;
    }

    // Preserve original body if configured
    if (mergedConfig.preserveOriginal) {
      (req as any).originalBody = JSON.parse(JSON.stringify(req.body));
    }

    // Track stripped fields
    const strippedFields: string[] = [];

    // Filter the request body
    req.body = filterObject(req.body, allowedPaths, '', strippedFields);

    // Handle stripped fields
    if (strippedFields.length > 0) {
      // Strict mode - reject request
      if (mergedConfig.strictMode) {
        res.status(400).json({
          error: 'Invalid Request',
          message: mergedConfig.strictModeMessage,
          code: 'DISALLOWED_FIELDS',
          fields: strippedFields,
        });
        return;
      }

      // Log stripped fields
      if (mergedConfig.enableLogging) {
        securityLogger.warn('Mass assignment fields stripped', { module: 'MassAssignment', method: req.method, path: req.path, strippedFields });
      }

      // Custom callback
      mergedConfig.onFieldsStripped(req, strippedFields);
    }

    next();
  };
}

/**
 * Create middleware that blocks specific fields (denylist approach)
 * Use allowlist approach (createAllowedFieldsMiddleware) when possible
 *
 * @param blockedFields - Array of field names to block
 * @param config - Configuration options
 * @returns Express middleware function
 */
export function createBlockedFieldsMiddleware(
  blockedFields: string[],
  config: MassAssignmentConfig = {}
) {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const blockedSet = new Set(blockedFields);

  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      next();
      return;
    }

    // Preserve original body if configured
    if (mergedConfig.preserveOriginal) {
      (req as any).originalBody = JSON.parse(JSON.stringify(req.body));
    }

    // Track stripped fields
    const strippedFields: string[] = [];

    // Remove blocked fields
    for (const field of blockedSet) {
      if (field in req.body) {
        delete req.body[field];
        strippedFields.push(field);
      }
    }

    if (strippedFields.length > 0) {
      if (mergedConfig.strictMode) {
        res.status(400).json({
          error: 'Invalid Request',
          message: mergedConfig.strictModeMessage,
          code: 'BLOCKED_FIELDS',
          fields: strippedFields,
        });
        return;
      }

      if (mergedConfig.enableLogging) {
        securityLogger.warn('Mass assignment blocked fields removed', { module: 'MassAssignment', method: req.method, path: req.path, strippedFields });
      }

      mergedConfig.onFieldsStripped(req, strippedFields);
    }

    next();
  };
}

/**
 * Common blocked fields that should almost never be settable by users
 * Use with createBlockedFieldsMiddleware for basic protection
 */
export const COMMON_BLOCKED_FIELDS = [
  // Role/Permission fields
  'role',
  'roles',
  'isAdmin',
  'isSuper',
  'isSuperuser',
  'isModerator',
  'permissions',
  'privileges',
  'accessLevel',
  'userType',

  // System fields
  'id',
  '_id',
  'uuid',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'createdBy',
  'updatedBy',
  'version',
  '__v',

  // Financial fields
  'balance',
  'credits',
  'points',
  'rewards',
  'earnings',

  // Verification/Trust fields
  'verified',
  'isVerified',
  'emailVerified',
  'trusted',
  'reputation',
  'status',

  // Security fields
  'password',
  'passwordHash',
  'salt',
  'apiKey',
  'secretKey',
  'privateKey',
  'token',
  'refreshToken',
  'mfaSecret',
];

/**
 * Creates middleware that blocks common sensitive fields
 * Good as a base protection layer
 *
 * @param additionalBlockedFields - Extra fields to block
 * @param config - Configuration options
 * @returns Express middleware function
 */
export function createCommonFieldsProtection(
  additionalBlockedFields: string[] = [],
  config: MassAssignmentConfig = {}
) {
  return createBlockedFieldsMiddleware(
    [...COMMON_BLOCKED_FIELDS, ...additionalBlockedFields],
    config
  );
}

/**
 * Utility function to sanitize an object directly (for use in services)
 *
 * @param data - Data object to sanitize
 * @param allowedFields - Array of allowed field specifications
 * @returns Sanitized object
 */
export function sanitizeFields<T extends Record<string, any>>(
  data: T,
  allowedFields: FieldSpec[]
): Partial<T> {
  const allowedPaths = flattenFieldSpecs(allowedFields);
  return filterObject(data, allowedPaths) as Partial<T>;
}

/**
 * Type-safe utility for picking allowed fields from type
 * Provides TypeScript compile-time safety
 *
 * @param data - Source data object
 * @param keys - Keys to allow from T
 * @returns Object with only specified keys
 */
export function pickFields<T extends Record<string, any>, K extends keyof T>(
  data: T,
  keys: K[]
): Pick<T, K> {
  const result = {} as Pick<T, K>;
  for (const key of keys) {
    if (key in data) {
      result[key] = data[key];
    }
  }
  return result;
}

/**
 * Type-safe utility for omitting fields from type
 *
 * @param data - Source data object
 * @param keys - Keys to exclude from T
 * @returns Object without specified keys
 */
export function omitFields<T extends Record<string, any>, K extends keyof T>(
  data: T,
  keys: K[]
): Omit<T, K> {
  const result = { ...data };
  for (const key of keys) {
    delete result[key];
  }
  return result as Omit<T, K>;
}

// Export types
export type { FieldSpec };

// Default export
export default createAllowedFieldsMiddleware;
