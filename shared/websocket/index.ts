/**
 * WebSocket Authentication and Authorization Module
 * Task 74: Unified exports for WebSocket security layer
 *
 * This module provides comprehensive security for WebSocket connections:
 * - JWT authentication on connection upgrade
 * - Role-based channel authorization
 * - Redis-backed session management
 * - Rate limiting with IP blocking
 * - Prometheus metrics and audit logging
 */

// Types
export type {
  WebSocketChannel,
  UserRole,
  WebSocketJWTPayload,
  AuthenticatedWebSocket,
  WebSocketSession,
  ChannelAccessConfig,
  WebSocketAuthResult,
  WebSocketRateLimitResult,
  ChannelAuthorizationResult,
  WebSocketErrorCode,
  SecurityEventType,
  SecurityEvent,
  WebSocketMessage,
  WebSocketAuthConfig,
  WebSocketRateLimitConfig,
  WebSocketSessionConfig,
} from './types.js';

export {
  ROLE_LEVELS,
  WS_ERROR_CODES,
  DEFAULT_AUTH_CONFIG,
  DEFAULT_RATE_LIMIT_CONFIG,
  DEFAULT_SESSION_CONFIG,
} from './types.js';

// Authentication Middleware
export {
  WebSocketAuthMiddleware,
  getWebSocketAuthMiddleware,
  createUpgradeMiddleware,
} from './ws-auth-middleware.js';

// Session Management
export {
  WebSocketSessionManager,
  getWebSocketSessionManager,
} from './ws-session-manager.js';

// Rate Limiting
export {
  WebSocketRateLimiter,
  getWebSocketRateLimiter,
} from './ws-rate-limiter.js';

// Channel Authorization
export {
  ChannelAuthorizationService,
  getChannelAuthorizationService,
  canAccessChannel,
  getAccessibleChannelsForUser,
  CHANNEL_ACCESS_CONFIG,
} from './ws-channel-authorization.js';

// Security Logging
export {
  WebSocketSecurityLogger,
  getWebSocketSecurityLogger,
  prometheusMetricsMiddleware,
} from './ws-security-logger.js';

/**
 * Convenience function to create a complete WebSocket security stack
 */
export function createWebSocketSecurityStack(options?: {
  authConfig?: Partial<import('./types.js').WebSocketAuthConfig>;
  rateLimitConfig?: Partial<import('./types.js').WebSocketRateLimitConfig>;
  sessionConfig?: Partial<import('./types.js').WebSocketSessionConfig>;
  loggerOptions?: {
    maxBufferSize?: number;
    flushIntervalMs?: number;
    onFlush?: (events: import('./types.js').SecurityEvent[]) => Promise<void>;
  };
}) {
  const { WebSocketAuthMiddleware } = require('./ws-auth-middleware');
  const { WebSocketSessionManager } = require('./ws-session-manager');
  const { WebSocketRateLimiter } = require('./ws-rate-limiter');
  const { ChannelAuthorizationService } = require('./ws-channel-authorization');
  const { WebSocketSecurityLogger } = require('./ws-security-logger');

  return {
    authMiddleware: new WebSocketAuthMiddleware(options?.authConfig),
    sessionManager: new WebSocketSessionManager(options?.sessionConfig),
    rateLimiter: new WebSocketRateLimiter(options?.rateLimitConfig),
    channelAuth: new ChannelAuthorizationService(),
    securityLogger: new WebSocketSecurityLogger(options?.loggerOptions),
  };
}

/**
 * Helper to create authenticated WebSocket connection handler
 *
 * Usage:
 * ```typescript
 * import { createAuthenticatedHandler } from 'backend/shared/websocket';
 *
 * const handler = createAuthenticatedHandler({
 *   onConnection: async (ws, authResult) => {
 *     console.log(`User ${authResult.user.id} connected`);
 *   },
 *   onMessage: async (ws, message) => {
 *     // Handle authenticated messages
 *   },
 *   onClose: async (ws) => {
 *     // Cleanup
 *   }
 * });
 *
 * // Apply to HTTP server upgrade
 * server.on('upgrade', handler.handleUpgrade);
 * ```
 */
export function createAuthenticatedHandler(callbacks: {
  onConnection?: (
    ws: import('./types.js').AuthenticatedWebSocket,
    authResult: import('./types.js').WebSocketAuthResult
  ) => Promise<void>;
  onMessage?: (
    ws: import('./types.js').AuthenticatedWebSocket,
    message: import('./types.js').WebSocketMessage
  ) => Promise<void>;
  onClose?: (ws: import('./types.js').AuthenticatedWebSocket) => Promise<void>;
  onError?: (
    ws: import('./types.js').AuthenticatedWebSocket | null,
    error: Error
  ) => Promise<void>;
}) {
  const stack = createWebSocketSecurityStack();

  return {
    stack,

    /**
     * Handle WebSocket upgrade with authentication
     */
    async handleUpgrade(
      request: import('http').IncomingMessage,
      socket: import('net').Socket,
      head: Buffer,
      wss: import('ws').WebSocketServer,
    ): Promise<void> {
      const { WebSocketAuthMiddleware } = require('./ws-auth-middleware');
      const ipAddress = WebSocketAuthMiddleware.getClientIp(request);
      const userAgent = WebSocketAuthMiddleware.getUserAgent(request);

      // Log connection attempt
      stack.securityLogger.logConnectionAttempt(ipAddress, userAgent);

      // Check connection rate limit
      const connectionLimit = await stack.rateLimiter.checkConnectionLimit(ipAddress);
      if (!connectionLimit.allowed) {
        stack.securityLogger.logConnectionRejected(
          ipAddress,
          'RATE_LIMIT_CONNECTION',
          connectionLimit.reason || 'Rate limit exceeded',
          userAgent,
        );
        socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
        socket.destroy();
        return;
      }

      // Authenticate
      const authResult = await stack.authMiddleware.authenticate(request);

      if (!authResult.authenticated || !authResult.user) {
        stack.securityLogger.logAuthFailure(
          ipAddress,
          authResult.error?.code || 'INVALID_TOKEN',
          authResult.error?.message || 'Authentication failed',
          userAgent,
        );
        stack.securityLogger.logConnectionRejected(
          ipAddress,
          authResult.error?.code || 'INVALID_TOKEN',
          authResult.error?.message || 'Authentication failed',
          userAgent,
        );

        const statusCode = authResult.error?.code === 'TOKEN_EXPIRED' ? 401 : 403;
        socket.write(`HTTP/1.1 ${statusCode} ${statusCode === 401 ? 'Unauthorized' : 'Forbidden'}\r\n\r\n`);
        socket.destroy();
        return;
      }

      // Upgrade to WebSocket
      wss.handleUpgrade(request, socket, head, async (ws) => {
        const crypto = await import('crypto');

        // Extend ws with auth info
        const authenticatedWs = ws as import('./types.js').AuthenticatedWebSocket;
        authenticatedWs.user = {
          id: authResult.user!.id,
          address: authResult.user!.address,
          role: authResult.user!.role,
          permissions: authResult.user!.permissions || [],
          sessionId: authResult.sessionId!,
        };
        authenticatedWs.connectionId = `ws_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        authenticatedWs.ipAddress = ipAddress;
        authenticatedWs.connectedAt = Date.now();
        authenticatedWs.lastActivity = Date.now();
        authenticatedWs.subscribedChannels = new Set();
        authenticatedWs.messageCount = 0;
        authenticatedWs.tokenExpiry = authResult.user!.exp * 1000;

        // Create session
        await stack.sessionManager.createSession(authenticatedWs, userAgent);

        // Log success
        stack.securityLogger.logAuthSuccess(
          authenticatedWs.connectionId,
          authenticatedWs.user.id,
          ipAddress,
        );
        stack.securityLogger.logConnectionSuccess(
          authenticatedWs.connectionId,
          authenticatedWs.user.id,
          authenticatedWs.user.role,
          ipAddress,
          userAgent,
        );
        stack.securityLogger.logSessionCreated(
          authenticatedWs.connectionId,
          authenticatedWs.user.id,
          authenticatedWs.user.role,
          ipAddress,
        );

        // Emit connection event
        wss.emit('connection', authenticatedWs, request);

        // Call user callback
        if (callbacks.onConnection) {
          try {
            await callbacks.onConnection(authenticatedWs, authResult);
          } catch (error) {
            if (callbacks.onError) {
              await callbacks.onError(authenticatedWs, error as Error);
            }
          }
        }

        // Handle messages
        ws.on('message', async (data) => {
          try {
            const message = JSON.parse(data.toString()) as import('./types.js').WebSocketMessage;
            authenticatedWs.lastActivity = Date.now();
            authenticatedWs.messageCount++;

            // Update session activity
            await stack.sessionManager.updateActivity(authenticatedWs.connectionId);

            // Check message rate limit
            const channelLimit = authenticatedWs.subscribedChannels.size > 0
              ? stack.channelAuth.getChannelRateLimit(
                Array.from(authenticatedWs.subscribedChannels)[0],
              ).messagesPerMinute
              : undefined;

            const messageLimit = await stack.rateLimiter.checkMessageLimit(
              authenticatedWs.connectionId,
              undefined,
              channelLimit,
            );

            if (!messageLimit.allowed) {
              stack.securityLogger.logRateLimitHit(
                authenticatedWs.connectionId,
                authenticatedWs.user.id,
                ipAddress,
                messageLimit.reason?.includes('Burst') ? 'burst' : 'message',
              );

              ws.send(JSON.stringify({
                type: 'error',
                error: {
                  code: 'RATE_LIMIT_MESSAGE',
                  message: messageLimit.reason || 'Message rate limit exceeded',
                },
              }));
              return;
            }

            // Handle channel subscriptions
            if (message.action === 'subscribe' && message.channels) {
              for (const channel of message.channels) {
                const canSubscribe = stack.channelAuth.canSubscribe(authenticatedWs, channel);

                if (canSubscribe.allowed) {
                  authenticatedWs.subscribedChannels.add(channel);
                  stack.securityLogger.logChannelSubscribe(
                    authenticatedWs.connectionId,
                    authenticatedWs.user.id,
                    channel,
                    ipAddress,
                  );
                } else {
                  stack.securityLogger.logChannelSubscribeDenied(
                    authenticatedWs.connectionId,
                    authenticatedWs.user.id,
                    channel,
                    canSubscribe.reason || 'Unauthorized',
                    ipAddress,
                  );

                  ws.send(JSON.stringify({
                    type: 'subscription_error',
                    channel,
                    error: canSubscribe.reason,
                  }));
                }
              }

              // Update session with subscribed channels
              await stack.sessionManager.updateChannels(
                authenticatedWs.connectionId,
                Array.from(authenticatedWs.subscribedChannels),
              );
            }

            // Call user callback
            if (callbacks.onMessage) {
              await callbacks.onMessage(authenticatedWs, message);
            }
          } catch (error) {
            if (callbacks.onError) {
              await callbacks.onError(authenticatedWs, error as Error);
            }
          }
        });

        // Handle close
        ws.on('close', async () => {
          const sessionDuration = (Date.now() - authenticatedWs.connectedAt) / 1000;

          stack.securityLogger.logSessionDestroyed(
            authenticatedWs.connectionId,
            authenticatedWs.user.id,
            authenticatedWs.user.role,
            ipAddress,
            sessionDuration,
          );

          await stack.sessionManager.removeSession(
            authenticatedWs.connectionId,
            authenticatedWs.user.id,
          );

          if (callbacks.onClose) {
            try {
              await callbacks.onClose(authenticatedWs);
            } catch (error) {
              if (callbacks.onError) {
                await callbacks.onError(authenticatedWs, error as Error);
              }
            }
          }
        });

        // Handle errors
        ws.on('error', async (error) => {
          if (callbacks.onError) {
            await callbacks.onError(authenticatedWs, error);
          }
        });
      });
    },
  };
}
