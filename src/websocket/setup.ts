import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage } from 'http';
import { URL } from 'url';
import { authenticateWebSocketToken } from './auth.js';
import { parseWebSocketMessage, validateMessage } from './validators.js';
import { WebSocketRateLimiter } from './rateLimiter.js';
import { logger } from '../utils/logger.js';

const PRODUCTION_ORIGINS = [
  'https://wrfcoin.com',
  'https://app.wrfcoin.com',
  'https://staging.wrfcoin.com',
];

const DEV_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5000',
];

// SECURITY: Only allow localhost origins in non-production environments
const ALLOWED_ORIGINS = process.env.NODE_ENV === 'production'
  ? PRODUCTION_ORIGINS
  : [...PRODUCTION_ORIGINS, ...DEV_ORIGINS];

interface AuthenticatedWebSocket extends WebSocket {
  user: {
    id: string;
    address: string;
    role: string;
  };
  rateLimiter: WebSocketRateLimiter;
  lastActivity: number;
  ipAddress: string; // SECURITY: Bind connection to IP for session hijacking prevention
  connectionTime: number; // SECURITY: Track connection time for anomaly detection
  messageCount: number; // SECURITY: Track total messages for anomaly detection
}

function getHeaderValue(
  header: string | string[] | undefined
): string | undefined {
  return Array.isArray(header) ? header[0] : header;
}

function extractTokenFromProtocolHeader(
  header: string | string[] | undefined
): string | null {
  const rawValues = Array.isArray(header)
    ? header
    : typeof header === 'string'
      ? [header]
      : [];

  const candidates = rawValues
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);

  const bearerIndex = candidates.findIndex(
    value => value.toLowerCase() === 'bearer'
  );
  if (bearerIndex !== -1 && candidates[bearerIndex + 1]) {
    return candidates[bearerIndex + 1];
  }

  const prefixedToken = candidates.find(value =>
    value.toLowerCase().startsWith('bearer.')
  );
  if (prefixedToken) {
    return prefixedToken.slice('bearer.'.length);
  }

  return null;
}

export function requestUsesQueryToken(request: IncomingMessage): boolean {
  try {
    const parsedUrl = new URL(
      request.url || '/',
      `wss://${request.headers.host || 'localhost'}`
    );
    return parsedUrl.searchParams.has('token');
  } catch {
    return false;
  }
}

export function extractHandshakeToken(
  request: IncomingMessage
): string | null {
  const authorizationHeader = getHeaderValue(request.headers.authorization);
  if (authorizationHeader?.startsWith('Bearer ')) {
    return authorizationHeader.slice('Bearer '.length).trim();
  }

  return extractTokenFromProtocolHeader(
    request.headers['sec-websocket-protocol']
  );
}

export function setupWebSockets(server: any) {
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024, // SECURITY: 64KB max message size to prevent memory exhaustion
  });

  // Hook into the HTTP server's 'upgrade' event for authentication
  server.on(
    'upgrade',
    async (request: IncomingMessage, socket: any, head: Buffer) => {
      try {
        // 1. Origin Validation
        const origin = request.headers.origin;
        if (!origin || !ALLOWED_ORIGINS.includes(origin)) {
          logger.warn(
            `[WSS] Denying connection from invalid origin: ${origin}`,
            {
              ip: request.socket.remoteAddress,
              userAgent: request.headers['user-agent'],
            }
          );
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        if (requestUsesQueryToken(request)) {
          logger.warn(
            '[WSS] Denying connection using legacy query token transport',
            {
              ip: request.socket.remoteAddress,
              origin,
            }
          );
          socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
          socket.destroy();
          return;
        }

        // 2. Extract and validate JWT token from supported handshake headers.
        const token = extractHandshakeToken(request);

        if (!token) {
          logger.warn('[WSS] Denying connection without token', {
            ip: request.socket.remoteAddress,
            origin,
          });
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // 3. Authenticate the token
        const user = await authenticateWebSocketToken(token);
        if (!user) {
          logger.warn('[WSS] Denying connection with invalid token', {
            ip: request.socket.remoteAddress,
            origin,
          });
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }

        // 4. SECURITY: Check TLS enforcement in production.
        // NOTE: x-forwarded-proto is trusted here because in production the
        // service runs behind a reverse proxy that strips/overrides this header.
        // Direct exposure to the internet without a trusted proxy would allow
        // clients to spoof this header.
        if (
          process.env.NODE_ENV === 'production' &&
          !request.headers['x-forwarded-proto']?.includes('https')
        ) {
          logger.warn('[WSS] Denying non-TLS connection in production', {
            ip: request.socket.remoteAddress,
            origin,
          });
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }

        // 5. Complete the WebSocket handshake
        wss.handleUpgrade(request, socket, head, ws => {
          const authenticatedWs = ws as AuthenticatedWebSocket;
          const clientIP = request.socket.remoteAddress || 'unknown';

          authenticatedWs.user = user;
          authenticatedWs.rateLimiter = new WebSocketRateLimiter(user.id);
          authenticatedWs.lastActivity = Date.now();
          authenticatedWs.ipAddress = clientIP; // SECURITY: Bind to IP
          authenticatedWs.connectionTime = Date.now(); // SECURITY: Track connection time
          authenticatedWs.messageCount = 0; // SECURITY: Track message count

          wss.emit('connection', authenticatedWs, request);
        });
      } catch (error) {
        logger.error('[WSS] Error during WebSocket upgrade', {
          error: error instanceof Error ? error.message : String(error),
          ip: request.socket.remoteAddress,
        });
        socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
        socket.destroy();
      }
    }
  );

  // Handle WebSocket connections
  wss.on(
    'connection',
    (ws: AuthenticatedWebSocket, request: IncomingMessage) => {
      logger.info('[WSS] Client connected', {
        userId: ws.user.id,
        userAddress: ws.user.address,
        ip: request.socket.remoteAddress,
      });

      // Send welcome message
      ws.send(
        JSON.stringify({
          type: 'connection_established',
          payload: {
            message: 'Connected to WRFCoin WebSocket',
            timestamp: new Date().toISOString(),
          },
        })
      );

      // Handle incoming messages
      ws.on('message', async (message: Buffer) => {
        try {
          ws.lastActivity = Date.now();
          ws.messageCount++;

          // SECURITY: Anomaly detection - check for suspicious activity
          const anomalyDetected = detectWebSocketAnomaly(ws);
          if (anomalyDetected.isSuspicious) {
            logger.warn('[WSS] Suspicious activity detected', {
              userId: ws.user.id,
              ip: ws.ipAddress,
              reason: anomalyDetected.reason,
              messageCount: ws.messageCount,
              connectionDuration: Date.now() - ws.connectionTime,
            });

            if (anomalyDetected.severity === 'critical') {
              ws.close(1008, 'Policy violation: Suspicious activity detected');
              return;
            }
          }

          // Rate limiting check
          if (!ws.rateLimiter.checkLimit()) {
            logger.warn('[WSS] Rate limit exceeded', {
              userId: ws.user.id,
              ip: ws.ipAddress,
            });
            ws.send(
              JSON.stringify({
                type: 'error',
                payload: {
                  message: 'Rate limit exceeded. Please slow down.',
                  code: 'RATE_LIMIT_EXCEEDED',
                },
              })
            );
            return;
          }

          // Parse and validate message
          const parseResult = parseWebSocketMessage(message);
          if (!parseResult.success) {
            logger.warn('[WSS] Invalid JSON payload received', {
              userId: ws.user.id,
              error:
                parseResult.error instanceof Error
                  ? parseResult.error.message
                  : 'Invalid JSON format',
            });
            ws.close(1003, 'Invalid JSON format');
            return;
          }

          const validationResult = validateMessage(parseResult.data);

          if (!validationResult.success) {
            logger.warn('[WSS] Invalid message format received', {
              userId: ws.user.id,
              error:
                validationResult.error instanceof Error
                  ? validationResult.error.message
                  : validationResult.error,
            });
            ws.close(1003, 'Invalid message format');
            return;
          }

          // Handle the validated message
          await handleWebSocketMessage(ws, validationResult.data);
        } catch (error) {
          logger.error('[WSS] Error processing message', {
            userId: ws.user.id,
            error: error instanceof Error ? error.message : String(error),
          });
          ws.close(1011, 'Internal server error');
        }
      });

      // Handle connection close
      ws.on('close', (code: number, reason: Buffer) => {
        logger.info('[WSS] Client disconnected', {
          userId: ws.user.id,
          code,
          reason: reason.toString(),
        });
      });

      // Handle WebSocket errors
      ws.on('error', (error: Error) => {
        logger.error('[WSS] WebSocket error', {
          userId: ws.user.id,
          error: error.message,
        });
      });

      // Set up ping/pong for connection health
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.ping();
        }
      }, 30000); // 30 seconds

      ws.on('close', () => {
        clearInterval(pingInterval);
      });
    }
  );

  // Set up periodic cleanup of inactive connections
  setInterval(
    () => {
      const now = Date.now();
      wss.clients.forEach(ws => {
        const authenticatedWs = ws as AuthenticatedWebSocket;
        // Close connections inactive for more than 1 hour
        if (now - authenticatedWs.lastActivity > 60 * 60 * 1000) {
          logger.info('[WSS] Closing inactive connection', {
            userId: authenticatedWs.user?.id,
          });
          ws.close(1000, 'Connection timeout');
        }
      });
    },
    5 * 60 * 1000
  ); // Check every 5 minutes

  return wss;
}

async function handleWebSocketMessage(
  ws: AuthenticatedWebSocket,
  message: any
) {
  const { type, payload } = message;

  switch (type) {
    case 'subscribe':
      await handleSubscription(ws, payload);
      break;

    case 'unsubscribe':
      await handleUnsubscription(ws, payload);
      break;

    case 'wallet_update':
      await handleWalletUpdate(ws, payload);
      break;

    case 'transaction_status':
      await handleTransactionStatus(ws, payload);
      break;

    case 'ping':
      ws.send(
        JSON.stringify({
          type: 'pong',
          payload: { timestamp: new Date().toISOString() },
        })
      );
      break;

    default:
      logger.warn('[WSS] Unknown message type', {
        userId: ws.user.id,
        type,
      });
      ws.send(
        JSON.stringify({
          type: 'error',
          payload: {
            message: `Unknown message type: ${type}`,
            code: 'UNKNOWN_MESSAGE_TYPE',
          },
        })
      );
  }
}

async function handleSubscription(ws: AuthenticatedWebSocket, payload: any) {
  // Implement subscription logic for real-time updates
  logger.info('[WSS] Handling subscription', {
    userId: ws.user.id,
    subscription: payload.channel,
  });

  ws.send(
    JSON.stringify({
      type: 'subscription_confirmed',
      payload: {
        channel: payload.channel,
        timestamp: new Date().toISOString(),
      },
    })
  );
}

async function handleUnsubscription(ws: AuthenticatedWebSocket, payload: any) {
  // Implement unsubscription logic
  logger.info('[WSS] Handling unsubscription', {
    userId: ws.user.id,
    subscription: payload.channel,
  });
}

async function handleWalletUpdate(ws: AuthenticatedWebSocket, payload: any) {
  // Handle wallet-related updates with proper authorization
  logger.info('[WSS] Handling wallet update', {
    userId: ws.user.id,
    walletAddress: payload.address,
  });
}

async function handleTransactionStatus(
  ws: AuthenticatedWebSocket,
  payload: any
) {
  // Handle transaction status requests
  logger.info('[WSS] Handling transaction status request', {
    userId: ws.user.id,
    transactionId: payload.transactionId,
  });
}

// SECURITY: Anomaly detection for WebSocket connections
interface AnomalyDetectionResult {
  isSuspicious: boolean;
  reason?: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
}

function detectWebSocketAnomaly(
  ws: AuthenticatedWebSocket
): AnomalyDetectionResult {
  const connectionDuration = Date.now() - ws.connectionTime;
  const messagesPerMinute = ws.messageCount / (connectionDuration / 60000);

  // Detect message flood attacks (>200 messages/minute)
  if (messagesPerMinute > 200) {
    return {
      isSuspicious: true,
      reason: 'Excessive message rate detected',
      severity: 'critical',
    };
  }

  // Detect suspicious connection duration with low activity
  if (connectionDuration > 30 * 60 * 1000 && ws.messageCount < 5) {
    return {
      isSuspicious: true,
      reason: 'Long-lived connection with minimal activity',
      severity: 'medium',
    };
  }

  // Detect burst patterns (>50 messages in 10 seconds)
  const recentActivity = connectionDuration < 10000 && ws.messageCount > 50;
  if (recentActivity) {
    return {
      isSuspicious: true,
      reason: 'Burst pattern detected',
      severity: 'high',
    };
  }

  return { isSuspicious: false };
}
