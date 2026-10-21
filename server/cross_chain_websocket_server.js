// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});
const { resolveAllowedOrigins } = require('./utils/strict-cors-config');

/**
 * Enhanced Cross-Chain Protocol and WebSocket Server for Wrfcoin Core
 * Handles bridge protocols, blockchain messaging, and real-time connections
 */

const express = require('express');
const http = require('http');
const https = require('https');
const fs = require('fs');
const crypto = require('crypto');
const WebSocket = require('ws');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');
const { blockchainLogger } = require('./utils/logger.js');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
const { CHANNELS } = require('./utils/ws-channels');
const {
  crossChainEventBus,
  CROSS_CHAIN_EVENT_TYPES,
} = require('./events/cross-chain-event-bus.js');

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

function isLocalDevelopmentEnv() {
  if (isStrictModeEnv()) {
    return false;
  }

  const nodeEnv = (process.env.NODE_ENV || 'development').toLowerCase();
  const wrfcoinEnv = (process.env.WRFCOIN_ENV || '').toLowerCase();
  return (
    nodeEnv === 'development' ||
    nodeEnv === 'test' ||
    wrfcoinEnv === 'development' ||
    wrfcoinEnv === 'local'
  );
}

function parseBooleanFlag(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}

const EVENT_PIPELINE_CONFIG = {
  syntheticEventsFlag: parseBooleanFlag(process.env.WS_ENABLE_SYNTHETIC_EVENTS),
  syntheticEventsEnabled:
    parseBooleanFlag(process.env.WS_ENABLE_SYNTHETIC_EVENTS) &&
    isLocalDevelopmentEnv(),
  canonicalOnlyInProduction: isStrictModeEnv(),
};

if (
  EVENT_PIPELINE_CONFIG.syntheticEventsFlag &&
  !EVENT_PIPELINE_CONFIG.syntheticEventsEnabled
) {
  blockchainLogger.warn(
    'Ignoring WS_ENABLE_SYNTHETIC_EVENTS because runtime is not local development',
    {
      module: 'CrossChainWS',
      nodeEnv: process.env.NODE_ENV || 'development',
      wrfcoinEnv: process.env.WRFCOIN_ENV || '',
    }
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
      blockchainLogger.warn(
        'JWT_SECRET not configured; authentication is unavailable',
        { module: 'CrossChainWS' }
      );
      return false;
    }

    const authModule = await import('../shared/websocket/index.js');

    wsAuthMiddleware = new authModule.WebSocketAuthMiddleware({
      allowGuestAccess: false, // Cross-chain operations require authentication
    });
    wsRateLimiter = new authModule.WebSocketRateLimiter();
    wsSessionManager = new authModule.WebSocketSessionManager();
    wsChannelAuth = new authModule.ChannelAuthorizationService();
    wsSecurityLogger = new authModule.WebSocketSecurityLogger();

    authEnabled = true;
    authModuleLoaded = true;
    blockchainLogger.info('Authentication modules initialized', { module: 'CrossChainWS' });
    return true;
  } catch (error) {
    authEnabled = false;
    authModuleLoaded = false;
    wsAuthMiddleware = null;
    wsRateLimiter = wsRateLimiter || null;
    wsSessionManager = null;
    wsChannelAuth = null;
    wsSecurityLogger = null;
    authInitError = `Auth initialization failed: ${error.message}`;
    blockchainLogger.warn('Could not load auth modules', {
      module: 'CrossChainWS',
      error: error.message,
    });
    return false;
  }
}

const app = express();
const probeState = { draining: false };
const backgroundIntervals = new Set();

// Use HTTPS in production, HTTP in development
let server;
let protocol = 'ws';

if (process.env.NODE_ENV === 'production') {
  // In production, use HTTPS/WSS
  try {
    const options = {
      key: fs.readFileSync(
        process.env.SSL_KEY_PATH || '/etc/ssl/private/key.pem'
      ),
      cert: fs.readFileSync(
        process.env.SSL_CERT_PATH || '/etc/ssl/certs/cert.pem'
      ),
    };
    server = https.createServer(options, app);
    protocol = 'wss';
  } catch (error) {
    blockchainLogger.warn('SSL certificates not found, falling back to HTTP. Configure SSL_KEY_PATH and SSL_CERT_PATH for production.', { module: 'CrossChainWS' });
    server = http.createServer(app);
  }
} else {
  // Development mode
  server = http.createServer(app);
}

const wss = new WebSocket.Server({
  server,
  perMessageDeflate: false,
  maxPayload: 1024 * 1024,
  clientTracking: true,
});

const PORT = process.env.WEBSOCKET_PORT || 5002;

// Comprehensive Security Headers
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        connectSrc: ["'self'", 'wss:', 'ws:'],
        objectSrc: ["'none'"],
        frameSrc: ["'none'"],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    noSniff: true,
    xssFilter: true,
    referrerPolicy: { policy: ['strict-origin-when-cross-origin'] },
  })
);

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  message: 'Too many requests, please try again later.',
}));

app.use(
  cors({
    origin: resolveAllowedOrigins({ developmentDefaults: [
      'http://localhost:5000',
      'http://localhost:4200',
      'https://wrfcoin.replit.app',
      'https://78d83de6-3c2e-4513-8977-f64d83a9e3cb-00-33g6fqpn548lr.worf.replit.dev',
    ] }),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Requested-With',
      'Origin',
      'Accept',
    ],
    optionsSuccessStatus: 200,
  })
);

app.use(express.json());
app.use(
  createHealthMiddleware(
    'cross-chain-websocket-server',
    {
      websocketAuth: {
        critical: isStrictModeEnv(),
        check: async () => {
          const readiness = buildSecurityReadiness();
          return {
            status:
              readiness.strictMode && readiness.status !== 'ready' ? 'down' : 'up',
            ...readiness,
          };
        },
      },
    },
    { state: probeState }
  ).router
);

// Track connected clients with their subscriptions
const clients = new Map();

const syntheticTaskTimers = {
  blockchain: null,
  crossChain: null,
  mining: null,
};

const latestCanonicalChannelState = {
  blockchain: null,
  mining: null,
};

const canonicalSourceCleanupHandlers = [];

// Bridge protocol endpoints
app.get('/api/bridges/status', (req, res) => {
  res.json({
    activeBridges: 13,
    totalVolume24h: '24.8M USD',
    bridges: {
      ethereum: { status: 'active', volume: '8.2M USD', fees: '0.002 ETH' },
      polygon: { status: 'active', volume: '3.1M USD', fees: '0.01 MATIC' },
      bsc: { status: 'active', volume: '4.5M USD', fees: '0.001 BNB' },
      avalanche: { status: 'active', volume: '2.8M USD', fees: '0.01 AVAX' },
      arbitrum: { status: 'active', volume: '3.2M USD', fees: '0.0015 ETH' },
      optimism: { status: 'active', volume: '2.1M USD', fees: '0.0012 ETH' },
      solana: { status: 'maintenance', volume: '0 USD', fees: '0.001 SOL' },
      near: { status: 'active', volume: '0.9M USD', fees: '0.01 NEAR' },
    },
  });
});

app.post('/api/bridges/transfer', (req, res) => {
  const { fromChain, toChain, amount, token } = req.body;
  res.json({
    success: true,
    transferId: 'xfer_' + Math.random().toString(36).substring(2, 15),
    fromChain,
    toChain,
    amount,
    token,
    estimatedTime: '3-8 minutes',
    fees: '0.002 ' + token,
    status: 'pending',
  });
});

// WebSocket connection handling
// Enhanced WebSocket connection handling with full blockchain features

function startBackgroundInterval(handler, intervalMs) {
  if (process.env.WS_DISABLE_BACKGROUND_TASKS === 'true') {
    return null;
  }
  const timer = setInterval(handler, intervalMs);
  backgroundIntervals.add(timer);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
  return timer;
}

function getChannelSubscriberCount(channel) {
  let count = 0;
  clients.forEach((clientInfo, ws) => {
    if (
      clientInfo.subscriptions.includes(channel) &&
      ws.readyState === WebSocket.OPEN
    ) {
      count += 1;
    }
  });
  return count;
}

function normalizeBridgeStatus(status) {
  const normalized = String(status || '').toUpperCase();
  switch (normalized) {
    case 'INITIATED':
    case 'PENDING':
      return 'pending';
    case 'PROCESSING':
      return 'processing';
    case 'CONFIRMING':
      return 'confirming';
    case 'COMPLETED':
      return 'completed';
    case 'FAILED':
      return 'failed';
    default:
      return normalized ? normalized.toLowerCase() : 'unknown';
  }
}

function toCanonicalBridgeTransferPayload(payload) {
  const transaction = payload?.transaction;
  if (!transaction || typeof transaction !== 'object') {
    return null;
  }

  const transferId =
    transaction.transfer_id || transaction.tx_id || transaction.id || null;
  if (!transferId) {
    return null;
  }

  const sourceTxHash =
    transaction.source_tx_hash || transaction.external_transaction_hash || null;
  const destinationTxHash =
    transaction.destination_tx_hash || transaction.wrf_transaction_hash || null;

  return {
    transferId: String(transferId),
    fromChain: String(transaction.from_chain || ''),
    toChain: String(transaction.to_chain || ''),
    amount: String(transaction.amount ?? ''),
    token: 'WRF',
    status: normalizeBridgeStatus(transaction.status),
    direction: transaction.direction || undefined,
    sourceTxHash,
    destinationTxHash,
    trustState: transaction.trust_state || undefined,
    provenanceSource: transaction.provenance_source || undefined,
    message: payload.message || undefined,
  };
}

function validateCanonicalEventContract(channel, event, data) {
  if (!data || typeof data !== 'object') {
    return false;
  }

  if (channel === CHANNELS.BLOCKCHAIN && event === 'NEW_BLOCK') {
    return (
      Number.isFinite(Number(data.blockHeight)) &&
      typeof data.hash === 'string' &&
      Number.isFinite(Number(data.transactions))
    );
  }

  if (channel === CHANNELS.MINING && event === 'MINING_UPDATE') {
    return (
      typeof data.hashrate !== 'undefined' &&
      typeof data.difficulty !== 'undefined' &&
      typeof data.nextReward !== 'undefined' &&
      typeof data.estimatedTime !== 'undefined'
    );
  }

  if (channel === CHANNELS.CROSS_CHAIN && event === 'BRIDGE_TRANSFER') {
    return (
      typeof data.transferId === 'string' &&
      typeof data.fromChain === 'string' &&
      typeof data.toChain === 'string' &&
      typeof data.amount === 'string' &&
      typeof data.status === 'string'
    );
  }

  return true;
}

// Enhanced WebSocket error handling
wss.on('connection', (ws, req) => {
  ws.isAlive = true;

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('error', error => {
    blockchainLogger.warn('WebSocket connection error', { module: 'CrossChainWS', error: error.message });
    ws.terminate();
  });

  ws.on('close', (code, reason) => {
    blockchainLogger.info('WebSocket closed', { module: 'CrossChainWS', code, reason: reason?.toString() });
  });
});

// Heartbeat to detect broken connections
const heartbeat = startBackgroundInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      return ws.terminate();
    }

    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

const baselineLimiterCleanupTimer = startBackgroundInterval(() => {
  cleanupBaselineLimiter();
}, 300000);

wss.on('connection', (ws, req) => {
  const clientId = uuidv4();
  blockchainLogger.info('New WebSocket connection', { module: 'CrossChainWS', clientId, totalConnections: wss.clients.size });

  // Store client information with default subscriptions
  clients.set(ws, {
    id: clientId,
    subscriptions: [CHANNELS.GLOBAL, CHANNELS.CROSS_CHAIN],
  });

  // Send welcome message with blockchain capabilities
  ws.send(
    JSON.stringify({
      type: 'welcome',
      timestamp: new Date().toISOString(),
      connections: wss.clients.size,
      clientId: clientId,
      availableChannels: Object.values(CHANNELS),
    })
  );

  // Handle messages from clients
  ws.on('message', message => {
    try {
      const data = JSON.parse(message);
      handleClientMessage(ws, data);
    } catch (error) {
      blockchainLogger.error('Error parsing WebSocket message', { module: 'CrossChainWS', error: error.message });
      sendErrorToClient(ws, 'Invalid message format');
    }
  });

  // Handle client disconnection
  ws.on('close', () => {
    blockchainLogger.info('WebSocket client disconnected', { module: 'CrossChainWS', clientId });
    clients.delete(ws);
  });

  // Enhanced error handling with recovery
  ws.on('error', error => {
    blockchainLogger.error('WebSocket error for client', { module: 'CrossChainWS', clientId, error: error.message });

    // Send error notification to client if still connected
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Connection issue detected',
            timestamp: new Date().toISOString(),
            clientId: clientId,
          })
        );
      } catch (sendError) {
        blockchainLogger.error('Failed to send error message to client', { module: 'CrossChainWS', error: sendError.message });
      }
    }

    // Clean up client data
    clients.delete(ws);
  });

  // Send initial subscription confirmation
  sendSubscriptionUpdate(ws);
});

// Handle messages from clients
function handleClientMessage(ws, data) {
  const clientInfo = clients.get(ws);

  if (!clientInfo) {
    return;
  }

  const normalizedMessage = normalizeClientMessage(data);

  switch (normalizedMessage.action) {
    case 'subscribe':
      handleSubscription(ws, clientInfo, normalizedMessage.channels);
      break;

    case 'unsubscribe':
      handleUnsubscription(ws, clientInfo, normalizedMessage.channels);
      break;

    case 'ping':
      // Respond with a pong
      ws.send(
        JSON.stringify({
          channel: CHANNELS.GLOBAL,
          event: 'PONG',
          data: {
            timestamp: new Date().toISOString(),
            clientId: clientInfo.id,
          },
        })
      );
      break;

    case 'get_state':
      sendBlockchainState(ws);
      break;

    default:
      // Echo back with timestamp for compatibility
      ws.send(
        JSON.stringify({
          channel: CHANNELS.GLOBAL,
          event: 'ECHO',
          data: {
            payload: data,
            timestamp: new Date().toISOString(),
          },
        })
      );
  }
}

function normalizeClientMessage(data) {
  const payload =
    data && typeof data.data === 'object' && data.data !== null ? data.data : {};
  const rawAction =
    typeof data?.action === 'string'
      ? data.action
      : typeof data?.type === 'string'
        ? data.type
        : typeof data?.event === 'string'
          ? data.event
          : '';

  const rawChannels =
    data?.channels !== undefined ? data.channels : payload.channels;
  const channels = Array.isArray(rawChannels)
    ? rawChannels
    : rawChannels === undefined
      ? []
      : [rawChannels];

  return {
    action: rawAction.trim().toLowerCase(),
    channels,
  };
}

// Handle channel subscriptions
function handleSubscription(ws, clientInfo, channels) {
  if (!Array.isArray(channels)) {
    channels = [channels];
  }

  channels.forEach(channel => {
    if (
      Object.values(CHANNELS).includes(channel) &&
      !clientInfo.subscriptions.includes(channel)
    ) {
      clientInfo.subscriptions.push(channel);
    }
  });

  sendSubscriptionUpdate(ws);
}

// Handle channel unsubscriptions
function handleUnsubscription(ws, clientInfo, channels) {
  if (!Array.isArray(channels)) {
    channels = [channels];
  }

  channels.forEach(channel => {
    const index = clientInfo.subscriptions.indexOf(channel);
    if (index > -1) {
      clientInfo.subscriptions.splice(index, 1);
    }
  });

  sendSubscriptionUpdate(ws);
}

// Send subscription update to client
function sendSubscriptionUpdate(ws) {
  const clientInfo = clients.get(ws);
  if (clientInfo) {
    ws.send(
      JSON.stringify({
        channel: CHANNELS.GLOBAL,
        event: 'SUBSCRIPTION_UPDATED',
        data: {
          subscriptions: clientInfo.subscriptions,
          timestamp: new Date().toISOString(),
        },
      })
    );
  }
}

// Send error message to client
function sendErrorToClient(ws, message) {
  ws.send(
    JSON.stringify({
      channel: CHANNELS.GLOBAL,
      event: 'ERROR',
      data: {
        message,
        timestamp: new Date().toISOString(),
      },
    })
  );
}

// Send blockchain state to client
function sendBlockchainState(ws) {
  const state = latestCanonicalChannelState.blockchain;

  ws.send(
    JSON.stringify({
      channel: CHANNELS.BLOCKCHAIN,
      event: 'STATE_UPDATE',
      data: {
        state,
        source: state ? 'canonical' : 'unavailable',
      },
      timestamp: new Date().toISOString(),
    })
  );
}

// Broadcast message to all subscribed clients
function broadcast(channel, event, data) {
  const subscriberCount = getChannelSubscriberCount(channel);
  if (subscriberCount === 0) {
    return {
      skipped: true,
      reason: 'no-subscribers',
      subscriberCount: 0,
      delivered: 0,
    };
  }

  const message = JSON.stringify({
    channel,
    event,
    data,
    timestamp: new Date().toISOString(),
  });

  let delivered = 0;
  clients.forEach((clientInfo, ws) => {
    if (
      clientInfo.subscriptions.includes(channel) &&
      ws.readyState === WebSocket.OPEN
    ) {
      ws.send(message);
      delivered += 1;
    }
  });

  return {
    skipped: delivered === 0,
    reason: delivered === 0 ? 'no-open-subscribers' : null,
    subscriberCount,
    delivered,
  };
}

function ingestCanonicalEvent(channel, event, data, metadata = {}) {
  if (!validateCanonicalEventContract(channel, event, data)) {
    blockchainLogger.warn('Rejected canonical event with invalid contract', {
      module: 'CrossChainWS',
      channel,
      event,
      source: metadata.source || 'unknown',
    });
    return {
      accepted: false,
      reason: 'invalid-contract',
      delivered: 0,
    };
  }

  if (channel === CHANNELS.BLOCKCHAIN && event === 'NEW_BLOCK') {
    latestCanonicalChannelState.blockchain = {
      blockHeight: Number(data.blockHeight),
      hash: data.hash,
      transactions: Number(data.transactions),
      timestamp: data.timestamp || new Date().toISOString(),
    };
  } else if (channel === CHANNELS.MINING && event === 'MINING_UPDATE') {
    latestCanonicalChannelState.mining = {
      hashrate: data.hashrate,
      difficulty: data.difficulty,
      nextReward: data.nextReward,
      estimatedTime: data.estimatedTime,
      timestamp: data.timestamp || new Date().toISOString(),
    };
  }

  const result = broadcast(channel, event, data);
  return {
    accepted: true,
    ...result,
  };
}

function emitSyntheticBlockchainEvent() {
  return ingestCanonicalEvent(CHANNELS.BLOCKCHAIN, 'NEW_BLOCK', {
    blockHeight: 1247 + Math.floor(Math.random() * 100),
    hash: 'wrfc_' + Math.random().toString(36).substring(2, 15),
    transactions: Math.floor(Math.random() * 50),
    timestamp: new Date().toISOString(),
  }, { source: 'synthetic' });
}

function emitSyntheticCrossChainEvent() {
  const chains = ['ethereum', 'polygon', 'bsc', 'avalanche', 'arbitrum'];
  const fromChain = chains[Math.floor(Math.random() * chains.length)];
  const toChain = chains[Math.floor(Math.random() * chains.length)];

  if (fromChain === toChain) {
    return {
      accepted: false,
      reason: 'same-chain',
      delivered: 0,
    };
  }

  return ingestCanonicalEvent(CHANNELS.CROSS_CHAIN, 'BRIDGE_TRANSFER', {
    transferId: 'xfer_' + Math.random().toString(36).substring(2, 15),
    fromChain,
    toChain,
    amount: (Math.random() * 10).toFixed(4),
    token: 'WRF',
    status: 'processing',
    timestamp: new Date().toISOString(),
  }, { source: 'synthetic' });
}

function emitSyntheticMiningEvent() {
  return ingestCanonicalEvent(CHANNELS.MINING, 'MINING_UPDATE', {
    hashrate: 729 + Math.floor(Math.random() * 50) + ' TH/s',
    difficulty: (6 + Math.random()).toFixed(2),
    nextReward: (2.5 + Math.random() * 0.5).toFixed(3) + ' WRF',
    estimatedTime: Math.floor(Math.random() * 12) + 3 + ' minutes',
    timestamp: new Date().toISOString(),
  }, { source: 'synthetic' });
}

function emitSyntheticDemoEvents() {
  if (!EVENT_PIPELINE_CONFIG.syntheticEventsEnabled) {
    return {
      enabled: false,
      emitted: 0,
    };
  }

  const results = [
    emitSyntheticBlockchainEvent(),
    emitSyntheticCrossChainEvent(),
    emitSyntheticMiningEvent(),
  ];

  return {
    enabled: true,
    emitted: results.filter(result => result.accepted).length,
    results,
  };
}

function startSyntheticBroadcasts() {
  if (!EVENT_PIPELINE_CONFIG.syntheticEventsEnabled) {
    blockchainLogger.info('Synthetic WebSocket broadcasts are disabled by default', {
      module: 'CrossChainWS',
      strictMode: isStrictModeEnv(),
      localDevelopment: isLocalDevelopmentEnv(),
    });
    return;
  }

  blockchainLogger.warn('Synthetic WebSocket broadcasts enabled for local development', {
    module: 'CrossChainWS',
  });

  syntheticTaskTimers.blockchain = startBackgroundInterval(() => {
    emitSyntheticBlockchainEvent();
  }, 15000);

  syntheticTaskTimers.crossChain = startBackgroundInterval(() => {
    emitSyntheticCrossChainEvent();
  }, 25000);

  syntheticTaskTimers.mining = startBackgroundInterval(() => {
    emitSyntheticMiningEvent();
  }, 20000);
}

function initializeCanonicalBridgeEventSource() {
  if (!crossChainEventBus || typeof crossChainEventBus.on !== 'function') {
    return;
  }

  const bridgeHandler = payload => {
    const normalized = toCanonicalBridgeTransferPayload(payload);
    if (!normalized) {
      blockchainLogger.warn('Skipping canonical bridge event due to missing transaction fields', {
        module: 'CrossChainWS',
      });
      return;
    }

    ingestCanonicalEvent(
      CHANNELS.CROSS_CHAIN,
      'BRIDGE_TRANSFER',
      normalized,
      { source: 'cross-chain-api' }
    );
  };

  crossChainEventBus.on(CROSS_CHAIN_EVENT_TYPES.BRIDGE_TRANSACTION, bridgeHandler);
  canonicalSourceCleanupHandlers.push(() => {
    if (typeof crossChainEventBus.off === 'function') {
      crossChainEventBus.off(CROSS_CHAIN_EVENT_TYPES.BRIDGE_TRANSACTION, bridgeHandler);
    } else if (typeof crossChainEventBus.removeListener === 'function') {
      crossChainEventBus.removeListener(
        CROSS_CHAIN_EVENT_TYPES.BRIDGE_TRANSACTION,
        bridgeHandler
      );
    }
  });

  blockchainLogger.info('Canonical bridge event source attached', {
    module: 'CrossChainWS',
    eventType: CROSS_CHAIN_EVENT_TYPES.BRIDGE_TRANSACTION,
  });
}

initializeCanonicalBridgeEventSource();
startSyntheticBroadcasts();

// Broadcast heartbeat every 30 seconds
startBackgroundInterval(() => {
  const message = JSON.stringify({
    type: 'heartbeat',
    timestamp: new Date().toISOString(),
    activeConnections: wss.clients.size,
    bridgeStatus: 'operational',
  });

  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(message);
    }
  });
}, 30000);

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

// WebSocket connection test endpoint
app.get('/ws-test', (req, res) => {
  res.json({
    status: 'ready',
    websocket: `ws://${process.env.WS_HOST || 'localhost'}:${process.env.WS_PORT || '5001'}/ws`,
    connections: wss.clients.size,
    timestamp: new Date().toISOString(),
  });
});

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

// Add connection validation middleware with authentication (Task 74)
async function handleUpgradeRequest(request, socket, head) {
  const ipAddress = getClientIp(request);
  const userAgent = request.headers['user-agent'] || 'unknown';

  blockchainLogger.info('WebSocket upgrade request', { module: 'CrossChainWS', ipAddress });

  // Initialize auth modules if not already done
  await initializeAuthModules();

  // Ensure rate limiter is available even when auth modules fail to load
  if (!wsRateLimiter) {
    try {
      const { WebSocketRateLimiter } = await import('../shared/websocket/index.js');
      wsRateLimiter = new WebSocketRateLimiter();
    } catch {
      blockchainLogger.warn('Could not initialize standalone rate limiter', { module: 'CrossChainWS' });
    }
  }

  // Always enforce baseline connection limiting, independent of auth readiness.
  const baselineLimit = checkBaselineIpLimit(ipAddress);
  if (!baselineLimit.allowed) {
    blockchainLogger.warn('Baseline connection limit exceeded', {
      module: 'CrossChainWS',
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
    blockchainLogger.error('Rejecting upgrade because security readiness is degraded', {
      module: 'CrossChainWS',
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
  if (wsRateLimiter) {
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
      blockchainLogger.error('Rate limit check error', { module: 'CrossChainWS', error: err.message });
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
      blockchainLogger.error('Authentication error', { module: 'CrossChainWS', error: err.message });
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
      ws.connectionId = `cc_ws_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
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
    }

    wss.emit('connection', ws, request);
  });
}

server.on('upgrade', handleUpgradeRequest);

if (process.env.WS_DISABLE_AUTO_LISTEN !== 'true') {
  server.listen(PORT, '0.0.0.0', () => {
    const httpProtocol = protocol === 'wss' ? 'https' : 'http';
    blockchainLogger.info('Cross-Chain Protocol Server started', {
      module: 'CrossChainWS',
      port: PORT,
      protocol,
      healthCheck: `${httpProtocol}://0.0.0.0:${PORT}/health`,
      readinessCheck: `${httpProtocol}://0.0.0.0:${PORT}/readyz`,
      secure: protocol === 'wss',
    });

    if (protocol !== 'wss') {
      blockchainLogger.warn('Development mode: Using unencrypted WebSocket connections', { module: 'CrossChainWS' });
    }
  });
}

registerGracefulShutdown({
  serviceName: 'cross-chain-websocket-server',
  server,
  logger: blockchainLogger,
  state: probeState,
  cleanupFns: [
    {
      name: 'cross-chain-websocket-background-intervals',
      handler: () => {
        backgroundIntervals.forEach(timer => clearInterval(timer));
        backgroundIntervals.clear();
      },
    },
    {
      name: 'cross-chain-websocket-canonical-sources',
      handler: () => {
        cleanupCanonicalSources();
        baselineConnectionAttempts.clear();
      },
    },
    {
      name: 'cross-chain-websocket-close',
      handler: () =>
        new Promise(resolve => {
          clients.forEach((_, ws) => {
            if (ws.readyState === WebSocket.OPEN) {
              ws.close(1001, 'Server shutting down');
            }
          });
          clients.clear();
          wss.close(() => resolve());
        }),
    },
  ],
});

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
  latestCanonicalChannelState.blockchain = null;
  latestCanonicalChannelState.mining = null;
  clients.clear();
}

function addTestClient(subscriptions = [CHANNELS.GLOBAL]) {
  const ws = {
    readyState: WebSocket.OPEN,
    send: () => {},
  };

  clients.set(ws, {
    id: `test-${Date.now()}`,
    subscriptions: Array.isArray(subscriptions)
      ? [...subscriptions]
      : [subscriptions],
  });

  return ws;
}

function cleanupCanonicalSources() {
  while (canonicalSourceCleanupHandlers.length > 0) {
    const cleanup = canonicalSourceCleanupHandlers.pop();
    try {
      cleanup?.();
    } catch (error) {
      blockchainLogger.warn('Failed to clean up canonical source subscription', {
        module: 'CrossChainWS',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

module.exports = {
  app,
  server,
  __testHooks: {
    handleUpgradeRequest,
    initializeAuthModules,
    buildSecurityReadiness,
    checkBaselineIpLimit,
    resetSecurityStateForTests,
    cleanupCanonicalSources,
    addTestClient,
    getChannelSubscriberCount,
    broadcast,
    handleClientMessage,
    normalizeClientMessage,
    ingestCanonicalEvent,
    emitSyntheticDemoEvents,
    toCanonicalBridgeTransferPayload,
    getEventPipelineConfig: () => ({ ...EVENT_PIPELINE_CONFIG }),
    latestCanonicalChannelState,
    CHANNELS,
    timers: {
      heartbeat,
      baselineLimiterCleanupTimer,
      syntheticTaskTimers,
    },
  },
};
