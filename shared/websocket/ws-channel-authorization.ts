/**
 * WebSocket Channel Authorization
 * Task 74: Role-based channel access control
 *
 * Integrates with RBAC from backend/shared/rbac.ts
 */

import {
  WebSocketChannel,
  ChannelAccessConfig,
  ChannelAuthorizationResult,
  UserRole,
  ROLE_LEVELS,
  AuthenticatedWebSocket,
} from './types.js';
import { hasPermission, ROLE_PERMISSIONS, Permission } from '../rbac.js';

/**
 * Channel access configuration matrix
 *
 * Defines minimum role and required permissions for each channel
 */
export const CHANNEL_ACCESS_CONFIG: ChannelAccessConfig[] = [
  // Public channels - guest access
  {
    channel: 'global',
    minRole: 'guest',
    rateLimit: { messagesPerMinute: 30, burstLimit: 10 },
  },
  {
    channel: 'blockchain',
    minRole: 'guest',
    rateLimit: { messagesPerMinute: 60, burstLimit: 20 },
  },

  // Authenticated user channels
  {
    channel: 'mining',
    minRole: 'user',
    rateLimit: { messagesPerMinute: 120, burstLimit: 30 },
  },
  {
    channel: 'cross-chain',
    minRole: 'user',
    requiredPermissions: ['read:bridge'],
    rateLimit: { messagesPerMinute: 60, burstLimit: 15 },
  },
  {
    channel: 'computational',
    minRole: 'user',
    requiredPermissions: ['read:transaction'],
    rateLimit: { messagesPerMinute: 100, burstLimit: 25 },
  },

  // Privileged channels (operator+)
  {
    channel: 'governance',
    minRole: 'operator',
    requiredPermissions: ['read:governance'],
    rateLimit: { messagesPerMinute: 60, burstLimit: 10 },
  },
  {
    channel: 'secure-messaging',
    minRole: 'operator',
    rateLimit: { messagesPerMinute: 30, burstLimit: 5 },
  },

  // Admin-only channels
  {
    channel: 'api-monitoring',
    minRole: 'admin',
    requiredPermissions: ['read:system_stats'],
    rateLimit: { messagesPerMinute: 200, burstLimit: 50 },
  },
];

/**
 * Channel Authorization Service
 * Provides role-based access control for WebSocket channels
 */
export class ChannelAuthorizationService {
  private channelConfigs: Map<WebSocketChannel, ChannelAccessConfig>;

  constructor() {
    this.channelConfigs = new Map();

    // Build lookup map for faster access
    for (const config of CHANNEL_ACCESS_CONFIG) {
      this.channelConfigs.set(config.channel, config);
    }
  }

  /**
   * Check if a user can subscribe to a channel
   */
  canSubscribe(ws: AuthenticatedWebSocket, channel: WebSocketChannel): ChannelAuthorizationResult {
    const config = this.channelConfigs.get(channel);

    if (!config) {
      return { allowed: false, reason: `Unknown channel: ${channel}` };
    }

    // Check role level
    const userRoleLevel = ROLE_LEVELS[ws.user.role] ?? 0;
    const requiredRoleLevel = ROLE_LEVELS[config.minRole] ?? 100;

    if (userRoleLevel < requiredRoleLevel) {
      return {
        allowed: false,
        reason: `Requires ${config.minRole} role or higher (current: ${ws.user.role})`,
      };
    }

    // Check required permissions if any
    if (config.requiredPermissions && config.requiredPermissions.length > 0) {
      const missingPermissions = config.requiredPermissions.filter((perm) => {
        // Check if user has this specific permission
        if (ws.user.permissions.includes(perm)) {
          return false;
        }

        // Check if user has wildcard permission
        if (ws.user.permissions.includes('*')) {
          return false;
        }

        // Check role-based permissions from RBAC
        const rolePermissions = ROLE_PERMISSIONS[ws.user.role as keyof typeof ROLE_PERMISSIONS];
        if (rolePermissions && rolePermissions.includes(perm as Permission)) {
          return false;
        }

        return true;
      });

      if (missingPermissions.length > 0) {
        return {
          allowed: false,
          reason: `Missing permissions: ${missingPermissions.join(', ')}`,
        };
      }
    }

    return { allowed: true };
  }

  /**
   * Check if a role can access a channel (without user context)
   */
  canRoleAccessChannel(role: UserRole, channel: WebSocketChannel): boolean {
    const config = this.channelConfigs.get(channel);
    if (!config) return false;

    const userRoleLevel = ROLE_LEVELS[role] ?? 0;
    const requiredRoleLevel = ROLE_LEVELS[config.minRole] ?? 100;

    return userRoleLevel >= requiredRoleLevel;
  }

  /**
   * Get rate limit config for a channel
   */
  getChannelRateLimit(channel: WebSocketChannel): { messagesPerMinute: number; burstLimit: number } {
    const config = this.channelConfigs.get(channel);
    return config?.rateLimit || { messagesPerMinute: 60, burstLimit: 10 };
  }

  /**
   * Get all channels a user can access
   */
  getAccessibleChannels(role: UserRole, permissions: string[]): WebSocketChannel[] {
    const userRoleLevel = ROLE_LEVELS[role] ?? 0;

    return CHANNEL_ACCESS_CONFIG.filter((config) => {
      // Check role level
      const requiredRoleLevel = ROLE_LEVELS[config.minRole] ?? 100;
      if (userRoleLevel < requiredRoleLevel) {
        return false;
      }

      // Check required permissions
      if (config.requiredPermissions && config.requiredPermissions.length > 0) {
        const hasAllPermissions = config.requiredPermissions.every((perm) => {
          if (permissions.includes(perm)) return true;
          if (permissions.includes('*')) return true;

          // Check role-based permissions
          const rolePermissions = ROLE_PERMISSIONS[role as keyof typeof ROLE_PERMISSIONS];
          if (rolePermissions && rolePermissions.includes(perm as Permission)) {
            return true;
          }

          return false;
        });

        if (!hasAllPermissions) return false;
      }

      return true;
    }).map((config) => config.channel);
  }

  /**
   * Get channel configuration
   */
  getChannelConfig(channel: WebSocketChannel): ChannelAccessConfig | undefined {
    return this.channelConfigs.get(channel);
  }

  /**
   * Get all channel configurations
   */
  getAllChannelConfigs(): ChannelAccessConfig[] {
    return CHANNEL_ACCESS_CONFIG;
  }

  /**
   * Check if a channel exists
   */
  isValidChannel(channel: string): channel is WebSocketChannel {
    return this.channelConfigs.has(channel as WebSocketChannel);
  }

  /**
   * Get channels grouped by minimum role requirement
   */
  getChannelsByRole(): Record<UserRole, WebSocketChannel[]> {
    const result: Record<UserRole, WebSocketChannel[]> = {
      guest: [],
      user: [],
      operator: [],
      admin: [],
      super_admin: [],
    };

    for (const config of CHANNEL_ACCESS_CONFIG) {
      result[config.minRole].push(config.channel);
    }

    return result;
  }
}

/**
 * Singleton instance
 */
let defaultInstance: ChannelAuthorizationService | null = null;

export function getChannelAuthorizationService(): ChannelAuthorizationService {
  if (!defaultInstance) {
    defaultInstance = new ChannelAuthorizationService();
  }
  return defaultInstance;
}

/**
 * Utility function to check channel access
 */
export function canAccessChannel(
  ws: AuthenticatedWebSocket,
  channel: WebSocketChannel,
): ChannelAuthorizationResult {
  return getChannelAuthorizationService().canSubscribe(ws, channel);
}

/**
 * Utility function to get accessible channels for a user
 */
export function getAccessibleChannelsForUser(ws: AuthenticatedWebSocket): WebSocketChannel[] {
  return getChannelAuthorizationService().getAccessibleChannels(
    ws.user.role,
    ws.user.permissions,
  );
}
