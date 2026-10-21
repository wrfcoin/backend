/**
 * WebSocket Authentication and Authorization Types
 * Task 74: Implements type definitions for WebSocket security layer
 */

import type { WebSocket } from 'ws';
import type { IncomingMessage } from 'http';
import type { Role } from '../rbac.js';
import { JWT_ISSUER, JWT_AUDIENCE } from '../../server/auth/jwt-constants.js';

/**
 * WebSocket channels available in the WRFCoin platform
 */
export type WebSocketChannel =
  | 'global'
  | 'blockchain'
  | 'computational'
  | 'cross-chain'
  | 'governance'
  | 'mining'
  | 'secure-messaging'
  | 'api-monitoring';

/**
 * User roles with numeric hierarchy levels
 * Re-exported from rbac.ts for convenience
 */
export type UserRole = Role;

export const ROLE_LEVELS: Record<UserRole, number> = {
  guest: 0,
  user: 10,
  operator: 50,
  admin: 90,
  super_admin: 100,
};

/**
 * JWT payload structure for WebSocket authentication
 */
export interface WebSocketJWTPayload {
  id: string;
  address: string;
  role: UserRole;
  permissions?: string[];
  iat: number;
  exp: number;
  iss?: string;
  aud?: string;
}

/**
 * Authenticated WebSocket connection with user context
 */
export interface AuthenticatedWebSocket extends WebSocket {
  user: {
    id: string;
    address: string;
    role: UserRole;
    permissions: string[];
    sessionId: string;
  };
  connectionId: string;
  ipAddress: string;
  connectedAt: number;
  lastActivity: number;
  subscribedChannels: Set<WebSocketChannel>;
  messageCount: number;
  tokenExpiry: number;
}

/**
 * WebSocket session data stored in Redis
 */
export interface WebSocketSession {
  connectionId: string;
  userId: string;
  address: string;
  role: UserRole;
  permissions: string[];
  ipAddress: string;
  userAgent: string;
  connectedAt: number;
  lastActivity: number;
  subscribedChannels: WebSocketChannel[];
  messageCount: number;
  tokenExpiry: number;
}

/**
 * Channel access configuration
 */
export interface ChannelAccessConfig {
  channel: WebSocketChannel;
  minRole: UserRole;
  requiredPermissions?: string[];
  rateLimit: {
    messagesPerMinute: number;
    burstLimit: number;
  };
}

/**
 * Authentication result from middleware
 */
export interface WebSocketAuthResult {
  authenticated: boolean;
  user?: WebSocketJWTPayload;
  error?: {
    code: WebSocketErrorCode;
    message: string;
  };
  sessionId?: string;
}

/**
 * Rate limit check result
 */
export interface WebSocketRateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  reason?: string;
  blocked?: boolean;
}

/**
 * Channel subscription authorization result
 */
export interface ChannelAuthorizationResult {
  allowed: boolean;
  reason?: string;
}

/**
 * WebSocket error codes (4000-4099 range for application errors)
 */
export type WebSocketErrorCode =
  // Authentication errors (4001-4010)
  | 'NO_TOKEN'
  | 'INVALID_TOKEN'
  | 'TOKEN_EXPIRED'
  | 'INVALID_ORIGIN'
  | 'INVALID_SIGNATURE'
  // Authorization errors (4011-4020)
  | 'CHANNEL_UNAUTHORIZED'
  | 'INSUFFICIENT_ROLE'
  | 'MISSING_PERMISSION'
  // Rate limiting errors (4021-4030)
  | 'RATE_LIMIT_CONNECTION'
  | 'RATE_LIMIT_MESSAGE'
  | 'RATE_LIMIT_BURST'
  | 'IP_BLOCKED'
  // Session errors (4031-4040)
  | 'SESSION_EXPIRED'
  | 'SESSION_INVALID'
  // General errors (4041-4050)
  | 'INVALID_MESSAGE'
  | 'INTERNAL_ERROR';

/**
 * Numeric error codes mapping
 */
export const WS_ERROR_CODES: Record<WebSocketErrorCode, number> = {
  // Authentication errors
  NO_TOKEN: 4001,
  INVALID_TOKEN: 4002,
  TOKEN_EXPIRED: 4003,
  INVALID_ORIGIN: 4004,
  INVALID_SIGNATURE: 4005,
  // Authorization errors
  CHANNEL_UNAUTHORIZED: 4011,
  INSUFFICIENT_ROLE: 4012,
  MISSING_PERMISSION: 4013,
  // Rate limiting errors
  RATE_LIMIT_CONNECTION: 4021,
  RATE_LIMIT_MESSAGE: 4022,
  RATE_LIMIT_BURST: 4023,
  IP_BLOCKED: 4024,
  // Session errors
  SESSION_EXPIRED: 4031,
  SESSION_INVALID: 4032,
  // General errors
  INVALID_MESSAGE: 4041,
  INTERNAL_ERROR: 4042,
};

/**
 * Security event types for logging
 */
export type SecurityEventType =
  | 'connection_attempt'
  | 'connection_success'
  | 'connection_rejected'
  | 'auth_failure'
  | 'auth_success'
  | 'channel_subscribe'
  | 'channel_subscribe_denied'
  | 'rate_limit_hit'
  | 'ip_blocked'
  | 'session_created'
  | 'session_destroyed'
  | 'token_refresh'
  | 'message_received'
  | 'message_sent';

/**
 * Security event data for audit logging
 */
export interface SecurityEvent {
  type: SecurityEventType;
  timestamp: Date;
  connectionId?: string;
  userId?: string;
  ipAddress: string;
  userAgent?: string;
  channel?: WebSocketChannel;
  errorCode?: WebSocketErrorCode;
  details?: Record<string, unknown>;
}

/**
 * WebSocket message structure
 */
export interface WebSocketMessage {
  action: string;
  channel?: WebSocketChannel;
  channels?: WebSocketChannel[];
  data?: unknown;
  timestamp?: string;
}

/**
 * Configuration options for WebSocket authentication
 */
export interface WebSocketAuthConfig {
  /** JWT secret for HS256 verification */
  jwtSecret?: string;
  /** Path to JWT public key for RS256 verification */
  jwtPublicKeyPath?: string;
  /** Allowed JWT algorithms */
  algorithms: ('HS256' | 'HS384' | 'HS512' | 'RS256')[];
  /** JWT issuer claim */
  issuer: string;
  /** JWT audience claim */
  audience: string;
  /** Clock tolerance in seconds */
  clockTolerance: number;
  /** Allowed origins for WebSocket connections */
  allowedOrigins: string[];
  /** Enable guest access (unauthenticated connections with limited access) */
  allowGuestAccess: boolean;
}

/**
 * Configuration options for WebSocket rate limiting
 */
export interface WebSocketRateLimitConfig {
  /** Max connections per IP per minute */
  maxConnectionsPerMinute: number;
  /** Default messages per minute per connection */
  defaultMessagesPerMinute: number;
  /** Default burst limit (messages per 10 seconds) */
  defaultBurstLimit: number;
  /** Number of violations before IP block */
  blockThreshold: number;
  /** Block duration in seconds */
  blockDuration: number;
}

/**
 * Configuration options for WebSocket session management
 */
export interface WebSocketSessionConfig {
  /** Session TTL in seconds */
  sessionTtl: number;
  /** Redis key prefix for sessions */
  sessionPrefix: string;
  /** Redis key prefix for user connection sets */
  userConnectionsPrefix: string;
}

/**
 * Default configuration values
 */
export const DEFAULT_AUTH_CONFIG: WebSocketAuthConfig = {
  algorithms: ['HS256', 'HS384', 'HS512'],
  issuer: JWT_ISSUER,
  audience: JWT_AUDIENCE,
  clockTolerance: 30,
  allowedOrigins: [
    'https://wrfcoin.com',
    'https://app.wrfcoin.com',
    'http://localhost:3000',
    'http://localhost:5000',
  ],
  allowGuestAccess: false,
};

export const DEFAULT_RATE_LIMIT_CONFIG: WebSocketRateLimitConfig = {
  maxConnectionsPerMinute: 10,
  defaultMessagesPerMinute: 60,
  defaultBurstLimit: 10,
  blockThreshold: 5,
  blockDuration: 3600, // 1 hour
};

export const DEFAULT_SESSION_CONFIG: WebSocketSessionConfig = {
  sessionTtl: 86400, // 24 hours
  sessionPrefix: 'ws:session:',
  userConnectionsPrefix: 'ws:user:',
};
