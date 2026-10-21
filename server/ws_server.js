// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

/**
 * WebSocket Server
 *
 * This file creates a standalone WebSocket server that the frontend can connect to directly.
 * It uses the same port as the API server (3000) but on a specific path (/ws).
 *
 * Security Features (Task 103.3):
 * - Redis-backed rate limiting with auto-blocking
 * - Trusted proxy validation for X-Forwarded-For
 * - Per-connection and per-message rate limits
 * - Automatic IP blocking after repeated violations
 */
const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');

// Import configuration and logging
const { loadConfiguration, getNetworkType } = require('../config');
const logger = require('../utils/logger')('ws_server');
const { corsMiddleware, validateOrigin, ALLOWED_ORIGINS } = require('../shared/middleware/cors-config.js');
const { createApiSecurityHeadersMiddleware } = require('../shared/middleware/security-headers.js');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');

// Import Redis rate limiting (Task 103.3)
let rateLimitRedis;
try {
  // Dynamic import for TypeScript module
  rateLimitRedis = require('../shared/middleware/rate-limit-redis');
} catch (error) {
  logger.warn('Redis rate limiting module not available, using fallback', {
    error: error.message,
  });
  rateLimitRedis = null;
}

// WebSocket Rate Limit Configuration
const WS_RATE_LIMIT_CONFIG = {
  // Connection rate limiting
  maxConnections: parseInt(process.env.WS_MAX_CONNECTIONS_PER_MINUTE || '50', 10),
  connectionWindowMs: 60000, // 1 minute
  // Message rate limiting
  maxMessagesPerMinute: parseInt(process.env.WS_MAX_MESSAGES_PER_MINUTE || '60', 10),
  // Auto-block configuration
  enableAutoBlock: true,
};

// Fallback in-memory rate limiting (when Redis is unavailable)
const connectionRateLimits = new Map(); // IP -> { count, windowStart }
const messageRateLimits = new Map(); // clientId -> { count, windowStart }

// Load configuration
const config = loadConfiguration();
const networkType = getNetworkType();
const probeState = { draining: false };
const backgroundIntervals = [];

// Log server startup
logger.info(`Starting WebSocket server in ${networkType.toUpperCase()} mode`, {
  network: networkType,
  websocketConfig: config.websocket,
});

// Create Express app
const app = express();
// Use centralized CORS middleware for consistent origin validation
app.use(corsMiddleware);
// Apply security headers (CSP, X-Frame-Options, etc.)
app.use(createApiSecurityHeadersMiddleware());
app.use(express.json());
app.use(
  createHealthMiddleware('ws-server', {}, { state: probeState }).router
);

// Add request logging
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    logger.debug(`${req.method} ${req.originalUrl}`, {
      method: req.method,
      url: req.originalUrl,
      status: res.statusCode,
      duration: `${duration}ms`,
      ip: req.ip || req.connection.remoteAddress,
    });
  });

  next();
});

// Create HTTP server
const server = http.createServer(app);

// ============================================================================
// Rate Limiting Helper Functions (Task 103.3)
// ============================================================================

/**
 * Get client IP with trusted proxy validation
 * Only trusts X-Forwarded-For from trusted proxies
 */
function getSecureClientIp(req) {
  if (rateLimitRedis && rateLimitRedis.getClientIp) {
    return rateLimitRedis.getClientIp(req);
  }

  // Fallback: simple IP extraction (less secure, doesn't validate trusted proxies)
  const connectionIp = req.socket?.remoteAddress || '';
  const forwardedFor = req.headers['x-forwarded-for'];

  // Only trust forwarded header in development or if connection is from localhost
  if (forwardedFor && (process.env.NODE_ENV === 'development' ||
      connectionIp === '127.0.0.1' || connectionIp === '::1' || connectionIp === '::ffff:127.0.0.1')) {
    return forwardedFor.split(',')[0].trim();
  }

  return connectionIp.replace(/^::ffff:/, '') || '0.0.0.0';
}

/**
 * Check WebSocket connection rate limit
 */
async function checkConnectionRateLimit(req) {
  const clientIp = getSecureClientIp(req);

  // Use Redis rate limiting if available
  if (rateLimitRedis && rateLimitRedis.checkWebSocketRateLimit) {
    try {
      const result = await rateLimitRedis.checkWebSocketRateLimit(req, {
        maxConnections: WS_RATE_LIMIT_CONFIG.maxConnections,
        windowMs: WS_RATE_LIMIT_CONFIG.connectionWindowMs,
      });
      return result;
    } catch (error) {
      logger.warn('Redis rate limit check failed, using fallback', { error: error.message });
    }
  }

  // Fallback to in-memory rate limiting
  const now = Date.now();
  const limit = connectionRateLimits.get(clientIp) || { count: 0, windowStart: now };

  // Reset window if expired
  if (now - limit.windowStart > WS_RATE_LIMIT_CONFIG.connectionWindowMs) {
    limit.count = 0;
    limit.windowStart = now;
  }

  limit.count++;
  connectionRateLimits.set(clientIp, limit);

  return {
    allowed: limit.count <= WS_RATE_LIMIT_CONFIG.maxConnections,
    remaining: Math.max(0, WS_RATE_LIMIT_CONFIG.maxConnections - limit.count),
    resetAt: limit.windowStart + WS_RATE_LIMIT_CONFIG.connectionWindowMs,
    current: limit.count,
    limit: WS_RATE_LIMIT_CONFIG.maxConnections,
    blocked: false,
  };
}

/**
 * Check WebSocket message rate limit for a client
 */
async function checkMessageRateLimit(clientId, clientIp) {
  // Use Redis rate limiting if available
  if (rateLimitRedis && rateLimitRedis.checkWebSocketMessageRateLimit) {
    try {
      return await rateLimitRedis.checkWebSocketMessageRateLimit(
        clientIp,
        WS_RATE_LIMIT_CONFIG.maxMessagesPerMinute
      );
    } catch (error) {
      logger.warn('Redis message rate limit check failed, using fallback', { error: error.message });
    }
  }

  // Fallback to in-memory rate limiting
  const now = Date.now();
  const limit = messageRateLimits.get(clientId) || { count: 0, windowStart: now };

  if (now - limit.windowStart > 60000) { // 1 minute window
    limit.count = 0;
    limit.windowStart = now;
  }

  limit.count++;
  messageRateLimits.set(clientId, limit);

  return {
    allowed: limit.count <= WS_RATE_LIMIT_CONFIG.maxMessagesPerMinute,
    remaining: Math.max(0, WS_RATE_LIMIT_CONFIG.maxMessagesPerMinute - limit.count),
    current: limit.count,
    limit: WS_RATE_LIMIT_CONFIG.maxMessagesPerMinute,
  };
}

/**
 * Record a rate limit violation and potentially block the IP
 */
async function recordRateLimitViolation(clientIp, reason) {
  logger.warn('WebSocket rate limit violation', {
    ip: clientIp,
    reason,
    timestamp: new Date().toISOString(),
  });

  if (rateLimitRedis && rateLimitRedis.recordViolation && WS_RATE_LIMIT_CONFIG.enableAutoBlock) {
    try {
      const wasBlocked = await rateLimitRedis.recordViolation(clientIp);
      if (wasBlocked) {
        logger.warn('IP auto-blocked due to repeated WebSocket rate limit violations', {
          ip: clientIp,
        });
      }
      return wasBlocked;
    } catch (error) {
      logger.error('Failed to record rate limit violation', { error: error.message });
    }
  }

  return false;
}

// Clean up stale in-memory rate limit entries periodically
backgroundIntervals.push(setInterval(() => {
  const now = Date.now();
  const connectionWindow = WS_RATE_LIMIT_CONFIG.connectionWindowMs * 2;
  const messageWindow = 120000; // 2 minutes

  for (const [ip, limit] of connectionRateLimits.entries()) {
    if (now - limit.windowStart > connectionWindow) {
      connectionRateLimits.delete(ip);
    }
  }

  for (const [clientId, limit] of messageRateLimits.entries()) {
    if (now - limit.windowStart > messageWindow) {
      messageRateLimits.delete(clientId);
    }
  }
}, 60000)); // Clean up every minute

// ============================================================================
// WebSocket Server Creation
// ============================================================================

// Create WebSocket server with origin verification and rate limiting
const wss = new WebSocket.Server({
  server,
  path: '/ws',
  verifyClient: async (info, callback) => {
    const origin = info.origin;
    const validOrigin = validateOrigin(origin);
    const clientIp = getSecureClientIp(info.req);

    // Step 1: Validate origin
    if (validOrigin === false && origin) {
      logger.warn('WebSocket connection rejected due to invalid origin', {
        origin,
        ip: clientIp,
      });
      callback(false, 403, 'Origin not allowed');
      return;
    }

    // Step 2: Check rate limit (Task 103.3)
    try {
      const rateLimitResult = await checkConnectionRateLimit(info.req);

      if (rateLimitResult.blocked) {
        logger.warn('WebSocket connection rejected - IP blocked', {
          ip: clientIp,
          blockExpiresIn: rateLimitResult.blockExpiresIn,
        });
        callback(false, 429, 'IP temporarily banned');
        return;
      }

      if (!rateLimitResult.allowed) {
        logger.warn('WebSocket connection rejected - rate limit exceeded', {
          ip: clientIp,
          current: rateLimitResult.current,
          limit: rateLimitResult.limit,
        });

        // Record violation for potential auto-blocking
        await recordRateLimitViolation(clientIp, 'connection_rate_limit_exceeded');

        callback(false, 429, 'Too many connection attempts');
        return;
      }

      callback(true);
    } catch (error) {
      logger.error('Error during WebSocket rate limit check', {
        error: error.message,
        ip: clientIp,
      });
      // Fail open to prevent complete service disruption
      callback(true);
    }
  },
});

// Log WebSocket server creation
logger.info('WebSocket server created', {
  path: '/ws',
  heartbeatInterval: config.websocket.heartbeatInterval,
  maxClients: 1000, // Default limit
  originValidation: 'enabled',
  rateLimiting: 'enabled',
  maxConnectionsPerMinute: WS_RATE_LIMIT_CONFIG.maxConnections,
  maxMessagesPerMinute: WS_RATE_LIMIT_CONFIG.maxMessagesPerMinute,
});

// Store connected clients
const clients = new Map();

// Available channels
const CHANNELS = {
  GLOBAL: 'global',
  BLOCKCHAIN: 'blockchain',
  COMPUTATIONAL: 'computational',
  CROSS_CHAIN: 'cross-chain',
  GOVERNANCE: 'governance',
  MINING: 'mining',
};

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  // Task 103.3: Use secure IP extraction with trusted proxy validation
  const clientIp = getSecureClientIp(req);

  // Enhanced structured logging with client details
  logger.info('WebSocket client connected', {
    clientId,
    ip: clientIp,
    userAgent: req.headers['user-agent'] || 'Unknown',
    timestamp: new Date().toISOString(),
    network: networkType,
  });

  // Store client information with additional metadata
  clients.set(ws, {
    id: clientId,
    ip: clientIp,
    userAgent: req.headers['user-agent'] || 'Unknown',
    connectedAt: new Date().toISOString(),
    subscriptions: [CHANNELS.GLOBAL, CHANNELS.BLOCKCHAIN],
    messageCount: 0,
    lastActive: Date.now(),
  });

  // Send welcome message with network information
  ws.send(
    JSON.stringify({
      channel: CHANNELS.GLOBAL,
      event: 'CONNECTION_ESTABLISHED',
      data: {
        clientId,
        message: 'Connected to Wrfcoin WebSocket Server',
        timestamp: new Date().toISOString(),
        network: networkType,
        networkId: config.network.networkId,
        chainId: config.network.chainId,
      },
    })
  );

  // Handle messages with enhanced logging
  // Task 103.3: Wrap message handler with async for rate limiting
  ws.on('message', async message => {
    try {
      // Update client activity
      const client = clients.get(ws);
      if (client) {
        client.lastActive = Date.now();
        client.messageCount++;
      }

      // Task 103.3: Check message rate limit
      const rateLimitResult = await checkMessageRateLimit(clientId, clientIp);
      if (!rateLimitResult.allowed) {
        logger.warn('WebSocket message rate limit exceeded', {
          clientId,
          ip: clientIp,
          current: rateLimitResult.current,
          limit: rateLimitResult.limit,
        });

        // Record violation
        await recordRateLimitViolation(clientIp, 'message_rate_limit_exceeded');

        // Send rate limit error to client
        sendError(ws, 'Message rate limit exceeded. Please slow down.');

        // If heavily over limit, close connection
        if (rateLimitResult.current > rateLimitResult.limit * 2) {
          logger.warn('Closing connection due to excessive message rate', {
            clientId,
            ip: clientIp,
          });
          ws.close(1008, 'Rate limit exceeded');
        }
        return;
      }

      // Parse and handle message
      const data = JSON.parse(message);

      // Log received message
      logger.debug(`Received WebSocket message from client ${clientId}`, {
        clientId,
        messageType: data.action || 'unknown',
        timestamp: new Date().toISOString(),
      });

      // Process the message
      handleMessage(ws, data);
    } catch (error) {
      // Task 103.4: Log full error internally but sanitize for client
      const isProduction = process.env.NODE_ENV === 'production';
      logger.error('Error handling WebSocket message', {
        clientId,
        error: error.message,
        stack: error.stack, // Logged internally only
        rawMessage: isProduction ? '[redacted]' : message.toString().substring(0, 200),
      });

      // Send generic error to client - never expose internal details
      sendError(ws, isProduction ? 'Message processing failed' : 'Invalid message format');
    }
  });

  // Handle disconnections with enhanced logging
  ws.on('close', (code, reason) => {
    const client = clients.get(ws);

    logger.info('WebSocket client disconnected', {
      clientId,
      code,
      reason: reason ? reason.toString() : 'No reason provided',
      connectedDuration: client
        ? `${Math.floor((Date.now() - new Date(client.connectedAt).getTime()) / 1000)}s`
        : 'Unknown',
      messageCount: client ? client.messageCount : 0,
    });

    clients.delete(ws);
  });

  // Handle errors with enhanced logging
  // Task 103.4: Log full error internally, do not expose to client
  ws.on('error', error => {
    logger.error('WebSocket error', {
      clientId,
      error: error.message,
      stack: error.stack, // Logged internally only, never sent to client
    });
    // Note: WebSocket error events don't send responses to clients
    // but we ensure no error details leak through other channels
  });

  // Set up a client-specific ping interval to keep the connection alive
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      // Check if client hasn't been active for too long (inactive for 5 minutes)
      const client = clients.get(ws);
      if (client && Date.now() - client.lastActive > 5 * 60 * 1000) {
        logger.warn('Closing inactive WebSocket connection', {
          clientId,
          inactiveDuration: `${Math.floor((Date.now() - client.lastActive) / 1000)}s`,
        });

        clearInterval(pingInterval);
        ws.terminate();
      }
    } else {
      // Clear interval if the connection is closed
      clearInterval(pingInterval);
    }
  }, config.websocket.heartbeatInterval || 30000);
});

// Handle client messages
function handleMessage(ws, data) {
  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  if (data.action === 'subscribe' && Array.isArray(data.channels)) {
    // Filter valid channels
    const validChannels = data.channels.filter(channel =>
      Object.values(CHANNELS).includes(channel)
    );

    // Update subscriptions
    clientInfo.subscriptions = [
      ...new Set([...clientInfo.subscriptions, ...validChannels]),
    ];

    // Send confirmation
    ws.send(
      JSON.stringify({
        channel: CHANNELS.GLOBAL,
        event: 'SUBSCRIPTION_UPDATED',
        data: {
          subscriptions: clientInfo.subscriptions,
          message: 'Subscription updated successfully',
        },
      })
    );
  } else if (data.action === 'unsubscribe' && Array.isArray(data.channels)) {
    // Remove channels but keep GLOBAL
    clientInfo.subscriptions = clientInfo.subscriptions.filter(
      channel => !data.channels.includes(channel) || channel === CHANNELS.GLOBAL
    );

    // Send confirmation
    ws.send(
      JSON.stringify({
        channel: CHANNELS.GLOBAL,
        event: 'SUBSCRIPTION_UPDATED',
        data: {
          subscriptions: clientInfo.subscriptions,
          message: 'Subscription updated successfully',
        },
      })
    );
  } else if (data.action === 'ping') {
    // Respond with pong
    ws.send(
      JSON.stringify({
        channel: CHANNELS.GLOBAL,
        event: 'PONG',
        data: { timestamp: new Date().toISOString() },
      })
    );
  }
}

// Helper function to send errors
function sendError(ws, errorMessage) {
  ws.send(
    JSON.stringify({
      channel: CHANNELS.GLOBAL,
      event: 'ERROR',
      data: {
        message: errorMessage,
        timestamp: new Date().toISOString(),
      },
    })
  );
}

// Broadcast to all connected clients subscribed to a channel
function broadcast(channel, event, data = {}) {
  const message = JSON.stringify({
    channel,
    event,
    data: {
      ...data,
      timestamp: data.timestamp || new Date().toISOString(),
    },
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const clientInfo = clients.get(client);
      if (clientInfo && clientInfo.subscriptions.includes(channel)) {
        client.send(message);
      }
    }
  });
}

// API route to check status
app.get('/status', (req, res) => {
  res.json({
    status: 'running',
    clients: wss.clients.size,
    uptime: process.uptime(),
  });
});

// Add a route to force a broadcast for testing
app.post('/broadcast', (req, res) => {
  const { channel, event, data } = req.body;

  if (!channel || !event) {
    return res.status(400).json({ error: 'Channel and event are required' });
  }

  broadcast(channel, event, data || {});

  res.json({
    success: true,
    message: `Broadcast sent to ${channel}`,
    recipients: Array.from(wss.clients).filter(client => {
      const clientInfo = clients.get(client);
      return clientInfo && clientInfo.subscriptions.includes(channel);
    }).length,
  });
});

// Setup mock blockchain activities with testnet configuration
function setupMockData() {
  // Use testnet configuration values for realistic test data
  const txFrequency = Math.max(config.network.blockTime * 200, 3000); // Transaction frequency, min 3 seconds
  const initialDifficulty = config.mining.initialDifficulty || 4;
  const maxBlockSize = config.transactions.maxTransactionsPerBlock || 1000;

  logger.info('Setting up mock blockchain data generators', {
    transactionFrequency: `${txFrequency / 1000}s`,
    blockUpdateFrequency: '10s',
    pingFrequency: `${config.websocket.heartbeatInterval / 1000}s`,
    initialDifficulty,
    network: networkType,
  });

  // Broadcast a transaction every 3-6 seconds
  backgroundIntervals.push(setInterval(
    () => {
      const txId = `tx${Math.random().toString(36).substring(2, 10)}`;
      const txType = ['Regular', 'Computational', 'NFT', 'Governance'][
        Math.floor(Math.random() * 4)
      ];
      const amount = Math.floor(Math.random() * 1000) + 1;
      const fee = (Math.random() * 0.1).toFixed(4);

      // Log the transaction with structured data
      logger.info(`Broadcasted transaction: ${txId}`, {
        txId,
        txType,
        amount,
        fee,
        network: networkType,
      });

      // Broadcast the transaction to all subscribed clients
      broadcast(CHANNELS.BLOCKCHAIN, 'TRANSACTION_CREATED', {
        transaction: {
          id: txId,
          timestamp: new Date().toISOString(),
          type: txType,
          amount: amount,
          fee: fee,
          status: 'confirmed',
        },
        message: `New transaction created: ${txId}`,
      });
    },
    Math.floor(Math.random() * (txFrequency / 2)) + txFrequency
  ));

  // Broadcast blockchain state updates every 10 seconds
  backgroundIntervals.push(setInterval(() => {
    // Generate state data based on configuration to make it more realistic
    const blockHeight = Math.floor(Math.random() * 100) + 1000;
    const hashrate = Math.floor(Math.random() * 1000) + 500;
    const difficulty = Math.floor(Math.random() * 5) + initialDifficulty;
    const pendingTransactions = Math.floor(Math.random() * 20);

    // Log the state update with structured data
    logger.debug('Broadcasting blockchain state update', {
      blockHeight,
      hashrate,
      difficulty,
      pendingTransactions,
      network: networkType,
    });

    // Broadcast the state update
    broadcast(CHANNELS.BLOCKCHAIN, 'STATE_UPDATE', {
      state: {
        blockHeight,
        hashrate,
        difficulty,
        pendingTransactions,
      },
    });
  }, 10000));

  // Ping clients regularly to keep connections alive
  backgroundIntervals.push(setInterval(() => {
    // Count active clients
    let activeClients = 0;

    wss.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        // Send ping message
        client.send(
          JSON.stringify({
            channel: CHANNELS.GLOBAL,
            event: 'PING',
            data: { timestamp: new Date().toISOString() },
          })
        );

        activeClients++;
      }
    });

    // Log ping activity periodically
    logger.debug('Sent ping to active clients', {
      activeClients,
      totalClients: wss.clients.size,
      timestamp: new Date().toISOString(),
    });
  }, config.websocket.heartbeatInterval || 30000));

  logger.info('Started mock data generators for testnet environment');
}

// Start server with proper logging
const PORT = process.env.WS_PORT || 5001;
server.listen(PORT, '0.0.0.0', () => {
  logger.info(`WebSocket server running on http://0.0.0.0:${PORT}`, {
    port: PORT,
    network: networkType,
    mode: process.env.NODE_ENV || 'development',
  });

  // Set up mock data generators only for testnet
  if (networkType === 'testnet') {
    setupMockData();
  } else {
    logger.info('Mock data generation disabled for mainnet');
  }

  // Log server state at startup
  logger.info('WebSocket server initialization complete', {
    startTime: new Date().toISOString(),
    pid: process.pid,
    nodeVersion: process.version,
    memoryUsage: process.memoryUsage(),
  });
});

// Add process error handling with logging
// Task 103.4: These are internal logs only - no client exposure
process.on('uncaughtException', error => {
  // Internal logging only - full details for debugging
  logger.emergency('Uncaught exception in WebSocket server', {
    error: error.message,
    stack: error.stack, // Internal log only
    timestamp: new Date().toISOString(),
  });

  // Don't exit immediately to allow logging to complete
  setTimeout(() => {
    process.exit(1);
  }, 1000);
});

process.on('unhandledRejection', (reason, promise) => {
  // Internal logging only - full details for debugging
  logger.critical('Unhandled promise rejection in WebSocket server', {
    reason: reason?.message || reason,
    stack: reason?.stack, // Internal log only
    timestamp: new Date().toISOString(),
  });
});

registerGracefulShutdown({
  serviceName: 'ws-server',
  server,
  logger,
  state: probeState,
  cleanupFns: [
    {
      name: 'ws-server-cleanup',
      handler: () => {
        return new Promise((resolve) => {
          backgroundIntervals.forEach(interval => clearInterval(interval));
          logger.notice('Closing WebSocket connections...');
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.close(1001, 'Server shutting down');
            }
          });
          wss.close(() => {
            logger.info('WebSocket server closed successfully');
            resolve();
          });
        });
      },
    },
  ],
});

// Export public API
module.exports = { broadcast, CHANNELS };
