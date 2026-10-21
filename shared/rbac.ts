/**
 * Role-Based Access Control (RBAC) Module
 * Task 94.11: Implements extended role hierarchy and permission management
 *
 * This module provides:
 * - Role definitions with hierarchical levels
 * - Permission definitions by resource and action
 * - Role-to-permission mappings
 * - Utility functions for access control checks
 */

/**
 * Available system roles in hierarchical order
 * Higher numerical values indicate more privileges
 */
export const ROLES = {
  GUEST: 'guest',
  USER: 'user',
  OPERATOR: 'operator',
  ADMIN: 'admin',
  SUPER_ADMIN: 'super_admin',
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

/**
 * Role hierarchy with numerical levels
 * Used for role comparison (higher = more privileges)
 */
export const ROLE_HIERARCHY: Record<Role, number> = {
  [ROLES.GUEST]: 0,
  [ROLES.USER]: 10,
  [ROLES.OPERATOR]: 50,
  [ROLES.ADMIN]: 90,
  [ROLES.SUPER_ADMIN]: 100,
};

/**
 * Permission actions available for resources
 */
export const ACTIONS = {
  CREATE: 'create',
  READ: 'read',
  UPDATE: 'update',
  DELETE: 'delete',
  EXECUTE: 'execute',
  MANAGE: 'manage',
  ADMIN: 'admin',
} as const;

export type Action = (typeof ACTIONS)[keyof typeof ACTIONS];

/**
 * System resources that can be protected
 */
export const RESOURCES = {
  // User management
  USER: 'user',
  USER_PROFILE: 'user_profile',
  USER_SETTINGS: 'user_settings',

  // Authentication & Security
  SESSION: 'session',
  MFA: 'mfa',
  API_KEY: 'api_key',
  SECURITY_AUDIT: 'security_audit',

  // Weather & Data
  WEATHER_DATA: 'weather_data',
  WEATHER_STATION: 'weather_station',
  SENSOR_DATA: 'sensor_data',

  // Financial & Tokens
  WALLET: 'wallet',
  TRANSACTION: 'transaction',
  TOKEN: 'token',
  CARBON_CREDIT: 'carbon_credit',

  // NFT & Marketplace
  NFT: 'nft',
  MARKETPLACE: 'marketplace',

  // Bridge & Cross-chain
  BRIDGE: 'bridge',
  CROSS_CHAIN: 'cross_chain',

  // Governance
  PROPOSAL: 'proposal',
  VOTE: 'vote',
  GOVERNANCE: 'governance',

  // System Administration
  SYSTEM_CONFIG: 'system_config',
  SYSTEM_STATS: 'system_stats',
  SYSTEM_LOGS: 'system_logs',
  CLEANUP: 'cleanup',
} as const;

export type Resource = (typeof RESOURCES)[keyof typeof RESOURCES];

/**
 * Permission string format: "action:resource"
 * Example: "read:weather_data", "admin:system_config"
 */
export type Permission = `${Action}:${Resource}`;

/**
 * Default permissions for each role
 * These can be extended or overridden at runtime
 */
export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  [ROLES.GUEST]: [
    'read:weather_data',
    'read:marketplace',
    'read:proposal',
  ],

  [ROLES.USER]: [
    // Guest permissions (inherited)
    'read:weather_data',
    'read:marketplace',
    'read:proposal',
    // User-specific permissions
    'read:user_profile',
    'update:user_profile',
    'read:user_settings',
    'update:user_settings',
    'read:session',
    'delete:session',
    'create:mfa',
    'read:mfa',
    'update:mfa',
    'create:api_key',
    'read:api_key',
    'delete:api_key',
    'read:wallet',
    'create:transaction',
    'read:transaction',
    'create:nft',
    'read:nft',
    'create:vote',
    'read:vote',
    'read:carbon_credit',
    'create:bridge',
    'read:bridge',
    'read:sensor_data',
  ],

  [ROLES.OPERATOR]: [
    // User permissions (inherited via hierarchy check)
    'read:weather_data',
    'read:marketplace',
    'read:proposal',
    'read:user_profile',
    'update:user_profile',
    'read:user_settings',
    'update:user_settings',
    'read:session',
    'delete:session',
    'create:mfa',
    'read:mfa',
    'update:mfa',
    'create:api_key',
    'read:api_key',
    'delete:api_key',
    'read:wallet',
    'create:transaction',
    'read:transaction',
    'create:nft',
    'read:nft',
    'create:vote',
    'read:vote',
    'read:carbon_credit',
    'create:bridge',
    'read:bridge',
    'read:sensor_data',
    // Operator-specific permissions
    'create:weather_data',
    'update:weather_data',
    'manage:weather_station',
    'create:sensor_data',
    'update:sensor_data',
    'read:system_stats',
    'create:carbon_credit',
    'update:carbon_credit',
    'manage:marketplace',
    'create:proposal',
    'update:proposal',
  ],

  [ROLES.ADMIN]: [
    // Operator permissions (inherited via hierarchy check)
    'read:weather_data',
    'read:marketplace',
    'read:proposal',
    'read:user_profile',
    'update:user_profile',
    'read:user_settings',
    'update:user_settings',
    'read:session',
    'delete:session',
    'create:mfa',
    'read:mfa',
    'update:mfa',
    'create:api_key',
    'read:api_key',
    'delete:api_key',
    'read:wallet',
    'create:transaction',
    'read:transaction',
    'create:nft',
    'read:nft',
    'create:vote',
    'read:vote',
    'read:carbon_credit',
    'create:bridge',
    'read:bridge',
    'read:sensor_data',
    'create:weather_data',
    'update:weather_data',
    'manage:weather_station',
    'create:sensor_data',
    'update:sensor_data',
    'read:system_stats',
    'create:carbon_credit',
    'update:carbon_credit',
    'manage:marketplace',
    'create:proposal',
    'update:proposal',
    // Admin-specific permissions
    'manage:user',
    'delete:user',
    'admin:session',
    'admin:mfa',
    'admin:api_key',
    'admin:wallet',
    'delete:weather_data',
    'delete:sensor_data',
    'delete:carbon_credit',
    'admin:nft',
    'admin:marketplace',
    'admin:bridge',
    'admin:cross_chain',
    'admin:proposal',
    'admin:governance',
    'read:system_config',
    'update:system_config',
    'read:system_logs',
    'read:security_audit',
    'execute:cleanup',
  ],

  [ROLES.SUPER_ADMIN]: [
    // All permissions (wildcard via hierarchy check)
    'admin:system_config',
    'delete:system_config',
    'admin:system_logs',
    'delete:system_logs',
    'admin:security_audit',
    'manage:user',
    'delete:user',
    'admin:user',
  ],
};

/**
 * Check if a role has a specific permission
 *
 * @param role - The role to check
 * @param permission - The permission to verify
 * @returns True if the role has the permission
 */
export function hasPermission(role: Role, permission: Permission): boolean {
  const rolePermissions = ROLE_PERMISSIONS[role];
  if (!rolePermissions) {
    return false;
  }

  // Direct permission check
  if (rolePermissions.includes(permission)) {
    return true;
  }

  // Check for wildcard admin permission
  const [action, resource] = permission.split(':') as [Action, Resource];

  // Admin action on a resource implies all other actions
  const adminPermission = `admin:${resource}` as Permission;
  if (rolePermissions.includes(adminPermission)) {
    return true;
  }

  // Manage permission implies create, update, and delete
  const managePermission = `manage:${resource}` as Permission;
  if (
    rolePermissions.includes(managePermission) &&
    ['create', 'update', 'delete', 'read'].includes(action)
  ) {
    return true;
  }

  return false;
}

/**
 * Check if a role meets or exceeds the minimum required role
 *
 * @param userRole - The user's role
 * @param requiredRole - The minimum required role
 * @returns True if the user's role is sufficient
 */
export function hasMinimumRole(userRole: Role, requiredRole: Role): boolean {
  const userLevel = ROLE_HIERARCHY[userRole] ?? 0;
  const requiredLevel = ROLE_HIERARCHY[requiredRole] ?? 100;
  return userLevel >= requiredLevel;
}

/**
 * Get the highest role from a list of roles
 *
 * @param roles - Array of roles to compare
 * @returns The highest role, or GUEST if empty
 */
export function getHighestRole(roles: Role[]): Role {
  if (!roles || roles.length === 0) {
    return ROLES.GUEST;
  }

  return roles.reduce((highest, current) => {
    const currentLevel = ROLE_HIERARCHY[current] ?? 0;
    const highestLevel = ROLE_HIERARCHY[highest] ?? 0;
    return currentLevel > highestLevel ? current : highest;
  }, ROLES.GUEST);
}

/**
 * Get all permissions for a role (including inherited from lower roles)
 *
 * @param role - The role to get permissions for
 * @returns Array of all permissions for the role
 */
export function getAllPermissions(role: Role): Permission[] {
  const permissions = new Set<Permission>();
  const roleLevel = ROLE_HIERARCHY[role] ?? 0;

  // Collect permissions from all roles at or below this level
  for (const [r, perms] of Object.entries(ROLE_PERMISSIONS)) {
    const rLevel = ROLE_HIERARCHY[r as Role] ?? 0;
    if (rLevel <= roleLevel) {
      perms.forEach(p => permissions.add(p));
    }
  }

  return Array.from(permissions);
}

/**
 * Check if a user has any of the specified roles
 *
 * @param userRoles - The user's roles
 * @param requiredRoles - The roles to check for
 * @returns True if the user has at least one required role
 */
export function hasAnyRole(userRoles: Role[], requiredRoles: Role[]): boolean {
  if (!userRoles || !requiredRoles) {
    return false;
  }

  return requiredRoles.some(required =>
    userRoles.some(userRole => hasMinimumRole(userRole, required))
  );
}

/**
 * Check if a user has all of the specified roles
 *
 * @param userRoles - The user's roles
 * @param requiredRoles - The roles to check for
 * @returns True if the user has all required roles
 */
export function hasAllRoles(userRoles: Role[], requiredRoles: Role[]): boolean {
  if (!userRoles || !requiredRoles) {
    return false;
  }

  return requiredRoles.every(required =>
    userRoles.some(userRole => hasMinimumRole(userRole, required))
  );
}

/**
 * Validate that a role string is a valid Role type
 *
 * @param role - The role string to validate
 * @returns True if valid Role
 */
export function isValidRole(role: string): role is Role {
  return Object.values(ROLES).includes(role as Role);
}

/**
 * Parse and validate roles from various formats
 *
 * @param input - Role input (string, string[], or comma-separated string)
 * @returns Array of valid roles
 */
export function parseRoles(input: string | string[] | undefined | null): Role[] {
  if (!input) {
    return [ROLES.GUEST];
  }

  const roleStrings = Array.isArray(input)
    ? input
    : input.split(',').map(s => s.trim().toLowerCase());

  return roleStrings
    .filter(isValidRole)
    .map(r => r as Role);
}
