// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

const { WebSocketServer } = require('ws');
const https = require('https');
const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const ProductionCORSCleanupImport = require('../middleware/production-cors-cleanup');
const ProductionCORSCleanup =
  ProductionCORSCleanupImport?.default || ProductionCORSCleanupImport;

// Import Winston logger for structured logging
import { securityLogger } from './utils/logger.js';

// WebSocket Authentication and Authorization (Task 74)
let wsAuthMiddleware = null;
let wsRateLimiter = null;
let wsSessionManager = null;
let wsChannelAuth = null;
let wsSecurityLogger = null;
let authEnabled = false;
let authInitAttempted = false;
let authInitError = null;
let authModuleLoaded = false;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WS_BASELINE_CONN_WINDOW_MS = parsePositiveInt(
  process.env.WS_BASELINE_CONN_WINDOW_MS,
  60000
);
const WS_BASELINE_CONN_MAX = parsePositiveInt(
  process.env.WS_BASELINE_CONN_MAX,
  20
);
const baselineConnectionAttempts = new Map();

function isStrictModeEnv() {
  const nodeEnv = (process.env.NODE_ENV || '').toLowerCase();
  const wrfcoinEnv = (process.env.WRFCOIN_ENV || '').toLowerCase();
  return (
    nodeEnv === 'production' ||
    nodeEnv === 'staging' ||
    wrfcoinEnv === 'production' ||
    wrfcoinEnv === 'staging'
  );
}

function checkBaselineIpLimit(ipAddress) {
  const now = Date.now();
  const existing = baselineConnectionAttempts.get(ipAddress) || [];
  const recentAttempts = existing.filter(
    timestamp => now - timestamp < WS_BASELINE_CONN_WINDOW_MS
  );

  if (recentAttempts.length >= WS_BASELINE_CONN_MAX) {
    baselineConnectionAttempts.set(ipAddress, recentAttempts);
    const oldest = recentAttempts[0];
    const retryAfterMs = Math.max(
      WS_BASELINE_CONN_WINDOW_MS - (now - oldest),
      1000
    );
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
    };
  }

  recentAttempts.push(now);
  baselineConnectionAttempts.set(ipAddress, recentAttempts);
  return { allowed: true, retryAfterSeconds: 0 };
}

function cleanupBaselineLimiter() {
  const now = Date.now();
  for (const [ipAddress, attempts] of baselineConnectionAttempts.entries()) {
    const recentAttempts = attempts.filter(
      timestamp => now - timestamp < WS_BASELINE_CONN_WINDOW_MS
    );
    if (recentAttempts.length === 0) {
      baselineConnectionAttempts.delete(ipAddress);
    } else {
      baselineConnectionAttempts.set(ipAddress, recentAttempts);
    }
  }
}

function buildSecurityReadiness() {
  const strictMode = isStrictModeEnv();
  const checks = {
    jwtSecretPresent: Boolean(process.env.JWT_SECRET),
    authModuleLoaded,
    authMiddlewareReady: Boolean(wsAuthMiddleware),
    authRateLimiterReady: Boolean(wsRateLimiter),
    baselineRateLimiterReady: true,
  };
  const strictRequirementsMet =
    checks.jwtSecretPresent &&
    checks.authModuleLoaded &&
    checks.authMiddlewareReady &&
    checks.authRateLimiterReady &&
    checks.baselineRateLimiterReady;

  return {
    status: strictMode && !strictRequirementsMet ? 'degraded' : 'ready',
    strictMode,
    checks,
    authEnabled,
    authInitAttempted,
    authInitError,
  };
}

function rejectUpgrade(socket, statusCode, reasonPhrase, headers = {}) {
  const serializedHeaders = Object.entries(headers).map(
    ([key, value]) => `${key}: ${value}`
  );
  const response = [
    `HTTP/1.1 ${statusCode} ${reasonPhrase}`,
    'Connection: close',
    ...serializedHeaders,
    '',
    '',
  ].join('\r\n');
  socket.write(response);
  socket.destroy();
}

// Initialize auth modules (lazy loading)
async function initializeAuthModules() {
  if (authEnabled && wsAuthMiddleware && wsRateLimiter) {
    return true;
  }

  authInitAttempted = true;
  authInitError = null;

  try {
    if (!process.env.JWT_SECRET) {
      authEnabled = false;
      authModuleLoaded = false;
      wsAuthMiddleware = null;
      wsRateLimiter = null;
      wsSessionManager = null;
      wsChannelAuth = null;
      wsSecurityLogger = null;
      authInitError = 'JWT_SECRET missing';
      securityLogger.warn(
        'JWT_SECRET not configured; authentication is unavailable',
        {
          module: 'SecureMessagingWS',
          component: 'Auth',
        }
      );
      return false;
    }

    const authModulePath =
      process.env.WS_AUTH_MODULE_PATH || '../shared/websocket/index.js';
    const authModule = await import(authModulePath);

    wsAuthMiddleware = new authModule.WebSocketAuthMiddleware({
      allowGuestAccess: false, // Secure messaging requires authentication
    });
    wsRateLimiter = new authModule.WebSocketRateLimiter();
    wsSessionManager = new authModule.WebSocketSessionManager();
    wsChannelAuth = new authModule.ChannelAuthorizationService();
    wsSecurityLogger = new authModule.WebSocketSecurityLogger();

    authEnabled = true;
    authModuleLoaded = true;
    securityLogger.info('Authentication modules initialized', {
      module: 'SecureMessagingWS',
      component: 'Auth',
    });
    return true;
  } catch (error) {
    authEnabled = false;
    authModuleLoaded = false;
    wsAuthMiddleware = null;
    wsRateLimiter = null;
    wsSessionManager = null;
    wsChannelAuth = null;
    wsSecurityLogger = null;
    authInitError = `Auth initialization failed: ${error.message}`;
    securityLogger.warn('Could not load auth modules', {
      module: 'SecureMessagingWS',
      component: 'Auth',
      error: error.message,
    });
    return false;
  }
}

// Helper function to get client IP address
function getClientIp(req) {
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    return Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0].trim();
  }
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }
  const socketAddress = req.socket?.remoteAddress;
  return socketAddress ? socketAddress.replace(/^::ffff:/, '') : '0.0.0.0';
}

function startBackgroundInterval(handler, intervalMs) {
  if (process.env.WS_DISABLE_BACKGROUND_TASKS === 'true') {
    return null;
  }
  const timer = setInterval(handler, intervalMs);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

// Create Express app and HTTP server
const app = express();
// Enhanced security middleware with production CORS cleanup
ProductionCORSCleanup.autoConfigureCORS(app);
app.use(express.json());

app.get('/health', (req, res) => {
  const readiness = buildSecurityReadiness();
  res.json({
    status: 'healthy',
    service: 'Secure Messaging WebSocket Server',
    timestamp: new Date().toISOString(),
    websocketConnections: wss.clients.size,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    securityReadiness: {
      status: readiness.status,
      strictMode: readiness.strictMode,
      authEnabled: readiness.authEnabled,
      baselineRateLimiterReady: readiness.checks.baselineRateLimiterReady,
    },
  });
});

app.get('/readyz', (req, res) => {
  const readiness = buildSecurityReadiness();
  const statusCode =
    readiness.strictMode && readiness.status !== 'ready' ? 503 : 200;
  res.status(statusCode).json({
    status: readiness.status,
    strictMode: readiness.strictMode,
    checks: readiness.checks,
    authEnabled: readiness.authEnabled,
    authInitAttempted: readiness.authInitAttempted,
    authInitError: readiness.authInitError,
    timestamp: new Date().toISOString(),
  });
});

// Create HTTPS server with SSL/TLS support
let server;
try {
  // Try to load SSL certificates for production
  const sslOptions = {
    key: fs.readFileSync('/etc/ssl/private/server.key'),
    cert: fs.readFileSync('/etc/ssl/certs/server.crt'),
  };
  server = https.createServer(sslOptions, app);
  securityLogger.info('HTTPS server created with SSL certificates', {
    module: 'SecureMessagingWS',
    protocol: 'https',
  });
} catch (error) {
  // Fallback to HTTP for development
  securityLogger.warn('SSL certificates not found, using HTTP for development', {
    module: 'SecureMessagingWS',
    protocol: 'http',
  });
  server = http.createServer(app);
}

// Create WebSocket server on port 4002
const wss = new WebSocketServer({
  path: '/ws',
  noServer: true, // We'll handle upgrades manually for authentication
});

// Keep track of connected clients
const clients = new Set();
const baselineLimiterCleanupTimer = startBackgroundInterval(() => {
  cleanupBaselineLimiter();
}, 300000);

// Add connection validation middleware with authentication (Task 74)
async function handleUpgradeRequest(request, socket, head) {
  // Only handle upgrades for WebSocket path
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (url.pathname !== '/ws') {
    rejectUpgrade(socket, 404, 'Not Found');
    return;
  }

  const ipAddress = getClientIp(request);
  const userAgent = request.headers['user-agent'] || 'unknown';

  securityLogger.info('WebSocket upgrade request', {
    module: 'SecureMessagingWS',
    ipAddress,
  });

  // Initialize auth modules if not already done
  await initializeAuthModules();

  // Always enforce baseline connection limiting, independent of auth readiness.
  const baselineLimit = checkBaselineIpLimit(ipAddress);
  if (!baselineLimit.allowed) {
    securityLogger.warn('Baseline connection limit exceeded', {
      module: 'SecureMessagingWS',
      component: 'RateLimit',
      ipAddress,
      retryAfterSeconds: baselineLimit.retryAfterSeconds,
    });
    rejectUpgrade(socket, 429, 'Too Many Requests', {
      'Retry-After': String(baselineLimit.retryAfterSeconds),
    });
    return;
  }

  const readiness = buildSecurityReadiness();
  if (readiness.strictMode && readiness.status !== 'ready') {
    securityLogger.error('Rejecting upgrade because security readiness is degraded', {
      module: 'SecureMessagingWS',
      component: 'Auth',
      ipAddress,
      checks: readiness.checks,
      authInitError: readiness.authInitError,
    });
    rejectUpgrade(socket, 503, 'Service Unavailable');
    return;
  }

  // Log connection attempt
  if (wsSecurityLogger) {
    wsSecurityLogger.logConnectionAttempt(ipAddress, userAgent);
  }

  // Check rate limit if auth is enabled
  if (authEnabled && wsRateLimiter) {
    try {
      const rateLimitResult = await wsRateLimiter.checkConnectionLimit(ipAddress);
      if (!rateLimitResult.allowed) {
        if (wsSecurityLogger) {
          wsSecurityLogger.logConnectionRejected(
            ipAddress,
            'RATE_LIMIT_CONNECTION',
            rateLimitResult.reason || 'Connection rate limit exceeded',
            userAgent
          );
        }
        rejectUpgrade(socket, 429, 'Too Many Requests');
        return;
      }
    } catch (err) {
      securityLogger.error('Rate limit check error', {
        module: 'SecureMessagingWS',
        component: 'RateLimit',
        error: err.message,
      });
    }
  }

  // Authenticate if enabled
  if (authEnabled && wsAuthMiddleware) {
    try {
      const authResult = await wsAuthMiddleware.authenticate(request);

      if (!authResult.authenticated) {
        if (wsSecurityLogger) {
          wsSecurityLogger.logAuthFailure(
            ipAddress,
            authResult.error?.code || 'INVALID_TOKEN',
            authResult.error?.message || 'Authentication failed',
            userAgent
          );
          wsSecurityLogger.logConnectionRejected(
            ipAddress,
            authResult.error?.code || 'INVALID_TOKEN',
            authResult.error?.message || 'Authentication failed',
            userAgent
          );
        }

        const statusCode = authResult.error?.code === 'TOKEN_EXPIRED' ? 401 : 403;
        rejectUpgrade(
          socket,
          statusCode,
          statusCode === 401 ? 'Unauthorized' : 'Forbidden'
        );
        return;
      }

      request.authResult = authResult;
    } catch (err) {
      securityLogger.error('Authentication error', {
        module: 'SecureMessagingWS',
        component: 'Auth',
        error: err.message,
      });
    }
  }

  // Allow the upgrade
  wss.handleUpgrade(request, socket, head, ws => {
    // Attach auth info if available
    if (request.authResult?.user) {
      ws.user = {
        id: request.authResult.user.id,
        address: request.authResult.user.address,
        role: request.authResult.user.role,
        permissions: request.authResult.user.permissions || [],
        sessionId: request.authResult.sessionId,
      };
      ws.connectionId = `sm_ws_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
      ws.ipAddress = ipAddress;
      ws.connectedAt = Date.now();

      // Log successful connection
      if (wsSecurityLogger) {
        wsSecurityLogger.logConnectionSuccess(
          ws.connectionId,
          ws.user.id,
          ws.user.role,
          ipAddress,
          userAgent
        );
      }

      // Create session if session manager is available
      if (wsSessionManager) {
        wsSessionManager.createSession(ws, userAgent).catch(err => {
          securityLogger.warn('Failed to create session', {
            module: 'SecureMessagingWS',
            component: 'Session',
            error: err.message,
          });
        });
      }
    }

    wss.emit('connection', ws, request);
  });
}

server.on('upgrade', handleUpgradeRequest);

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const userId = ws.user?.id || 'anonymous';
  const connectionId = ws.connectionId || `anon_${Date.now()}`;

  securityLogger.info('New WebSocket client connected', {
    module: 'SecureMessagingWS',
    userId,
    connectionId,
  });
  clients.add(ws);

  // Handle incoming messages
  ws.on('message', async data => {
    try {
      const message = JSON.parse(data);
      securityLogger.info('Received message', {
        module: 'SecureMessagingWS',
        userId,
        messageType: message.type,
      });

      // Check message rate limit if auth is enabled
      if (authEnabled && wsRateLimiter && ws.connectionId) {
        try {
          const messageLimit = await wsRateLimiter.checkMessageLimit(ws.connectionId);
          if (!messageLimit.allowed) {
            if (wsSecurityLogger) {
              wsSecurityLogger.logRateLimitHit(
                ws.connectionId,
                ws.user?.id || 'unknown',
                ws.ipAddress || '0.0.0.0',
                'message'
              );
            }
            ws.send(JSON.stringify({
              type: 'error',
              error: {
                code: 'RATE_LIMIT_MESSAGE',
                message: messageLimit.reason || 'Message rate limit exceeded',
              },
            }));
            return;
          }
        } catch (err) {
          securityLogger.warn('Error checking message rate limit', {
            module: 'SecureMessagingWS',
            component: 'RateLimit',
            error: err.message,
          });
        }
      }

      // Broadcast secure messages to other connected clients
      if (message.type === 'secure_message') {
        // Add sender info to the message if authenticated
        const enrichedMessage = {
          ...message,
          sender: ws.user ? {
            id: ws.user.id,
            address: ws.user.address,
          } : undefined,
          timestamp: new Date().toISOString(),
        };

        clients.forEach(client => {
          if (client !== ws && client.readyState === 1) {
            client.send(JSON.stringify(enrichedMessage));
          }
        });
      }

      // Handle blockchain transaction broadcasts
      if (message.type === 'blockchain_transaction') {
        clients.forEach(client => {
          if (client.readyState === 1) {
            client.send(
              JSON.stringify({
                type: 'transaction_broadcast',
                data: message.data,
                sender: ws.user?.address,
                timestamp: new Date().toISOString(),
              })
            );
          }
        });
      }
    } catch (error) {
      securityLogger.error('Error processing message', {
        module: 'SecureMessagingWS',
        userId,
        error: error.message,
      });
      ws.send(JSON.stringify({
        type: 'error',
        error: { message: 'Invalid message format' },
        timestamp: new Date().toISOString(),
      }));
    }
  });

  // Handle client disconnect
  ws.on('close', async () => {
    securityLogger.info('WebSocket client disconnected', {
      module: 'SecureMessagingWS',
      userId,
      connectionId,
    });
    clients.delete(ws);

    // Cleanup session if authenticated
    if (ws.user && ws.connectionId && wsSessionManager) {
      try {
        const sessionDuration = ws.connectedAt ? (Date.now() - ws.connectedAt) / 1000 : 0;

        if (wsSecurityLogger) {
          wsSecurityLogger.logSessionDestroyed(
            ws.connectionId,
            ws.user.id,
            ws.user.role,
            ws.ipAddress || '0.0.0.0',
            sessionDuration
          );
        }

        await wsSessionManager.removeSession(ws.connectionId, ws.user.id);
      } catch (err) {
        securityLogger.warn('Failed to cleanup session', {
          module: 'SecureMessagingWS',
          component: 'Session',
          error: err.message,
        });
      }
    }
  });

  // Handle errors
  ws.on('error', error => {
    securityLogger.error('WebSocket error', {
      module: 'SecureMessagingWS',
      userId,
      error: error.message,
    });
  });

  // Send welcome message with auth info
  ws.send(
    JSON.stringify({
      type: 'connection_established',
      message: 'Connected to Wrfcoin secure messaging',
      authenticated: !!ws.user,
      user: ws.user ? {
        id: ws.user.id,
        address: ws.user.address,
        role: ws.user.role,
      } : undefined,
      connectionId: ws.connectionId,
      timestamp: new Date().toISOString(),
    })
  );
});

// Start mock blockchain activity for real-time updates
const mockBroadcastTimer = startBackgroundInterval(() => {
  const txId = 'tx' + Math.random().toString(36).substr(2, 9);
  const mockTransaction = {
    type: 'blockchain_activity',
    data: {
      transactionId: txId,
      from: '0x' + Math.random().toString(16).substr(2, 40),
      to: '0x' + Math.random().toString(16).substr(2, 40),
      amount: (Math.random() * 100).toFixed(2) + ' WRF',
      timestamp: new Date().toISOString(),
    },
  };

  clients.forEach(client => {
    if (client.readyState === 1) {
      client.send(JSON.stringify(mockTransaction));
    }
  });

  securityLogger.debug('Broadcasted mock transaction', {
    module: 'SecureMessagingWS',
    transactionId: txId,
    clientCount: clients.size,
  });
}, 5000);

// Start the server
const PORT =
  process.env.SECURE_MESSAGING_WS_PORT ||
  process.env.WEBSOCKET_PORT ||
  4002;

if (process.env.WS_DISABLE_AUTO_LISTEN !== 'true') {
  server.listen(PORT, '0.0.0.0', () => {
    const protocol = server instanceof https.Server ? 'wss' : 'ws';
    const httpProtocol = protocol === 'wss' ? 'https' : 'http';
    securityLogger.info('Wrfcoin WebSocket Server ready', {
      module: 'SecureMessagingWS',
      port: PORT,
      endpoint: `${protocol}://0.0.0.0:${PORT}/ws`,
      protocol,
      encrypted: protocol === 'wss',
      healthCheck: `${httpProtocol}://0.0.0.0:${PORT}/health`,
      readinessCheck: `${httpProtocol}://0.0.0.0:${PORT}/readyz`,
      features: {
        realTimeDataStreaming: true,
      },
    });
    if (protocol === 'ws') {
      securityLogger.warn('Development mode: Using unencrypted WebSocket connections', {
        module: 'SecureMessagingWS',
        protocol: 'ws',
      });
    }
  });
}

function resetSecurityStateForTests() {
  wsAuthMiddleware = null;
  wsRateLimiter = null;
  wsSessionManager = null;
  wsChannelAuth = null;
  wsSecurityLogger = null;
  authEnabled = false;
  authInitAttempted = false;
  authInitError = null;
  authModuleLoaded = false;
  baselineConnectionAttempts.clear();
}

module.exports = {
  app,
  server,
  wss,
  __testHooks: {
    handleUpgradeRequest,
    initializeAuthModules,
    buildSecurityReadiness,
    checkBaselineIpLimit,
    resetSecurityStateForTests,
    timers: {
      mockBroadcastTimer,
      baselineLimiterCleanupTimer,
    },
  },
};
