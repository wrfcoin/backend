// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});
const { resolveAllowedOrigins } = require('./utils/strict-cors-config');

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { WebSocketServer } = require('ws');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const cors = require('cors');

// Winston logger imports
const { appLogger, logError } = require('./utils/logger.js');
const { getCore4ApiUrl, isCore4ApiConfigured } = require('../shared/core4-url.cjs');

// Graceful shutdown utility
const { GracefulShutdown, ShutdownPriority } = require('../shared/graceful-shutdown/index.js');

// WebSocket Authentication and Authorization (Task 74)
let wsAuthMiddleware = null;
let wsRateLimiter = null;
let wsSessionManager = null;
let wsChannelAuth = null;
let wsSecurityLogger = null;
let authEnabled = false;

// Blockchain Event Subscriber (Task 77)
let blockchainEventSubscriber = null;
let blockchainEventsEnabled = false;

// Initialize auth modules (lazy loading to avoid circular dependencies)
async function initializeAuthModules() {
  if (authEnabled) return;

  try {
    // Only enable auth if JWT_SECRET is configured
    if (!process.env.JWT_SECRET) {
      appLogger.info('[WS Auth] JWT_SECRET not configured, running without authentication');
      return;
    }

    const authModule = await import('../shared/websocket/index.js');

    wsAuthMiddleware = new authModule.WebSocketAuthMiddleware({
      allowGuestAccess: true, // Allow guest access for backwards compatibility
    });
    wsRateLimiter = new authModule.WebSocketRateLimiter();
    wsSessionManager = new authModule.WebSocketSessionManager();
    wsChannelAuth = new authModule.ChannelAuthorizationService();
    wsSecurityLogger = new authModule.WebSocketSecurityLogger();

    authEnabled = true;
    appLogger.info('[WS Auth] Authentication modules initialized successfully');
  } catch (error) {
    appLogger.warn('[WS Auth] Could not load auth modules, running without authentication', { error: error.message });
  }
}

// Initialize blockchain event subscriber (Task 77)
async function initializeBlockchainEventSubscriber() {
  if (blockchainEventsEnabled) return;

  try {
    // Only enable if a core4 URL is explicitly configured
    if (!isCore4ApiConfigured()) {
      appLogger.info('[WS Blockchain] CORE4_API_URL not configured, running without blockchain event subscriptions');
      return;
    }

    // Dynamic import for ESM module
    const { blockchainEventSubscriber: subscriber } = await import('../blockchain/services/blockchain-event-subscriber.js');
    blockchainEventSubscriber = subscriber;

    // Initialize the subscriber
    await blockchainEventSubscriber.initialize(getCore4ApiUrl());

    // Set up broadcast callback to forward blockchain events to WebSocket clients
    blockchainEventSubscriber.setBroadcastCallback((channel, event, data) => {
      // Map channel names to WebSocket channels
      const channelMapping = {
        'governance': CHANNELS.GOVERNANCE,
        'carbon-credits': CHANNELS.BLOCKCHAIN,
        'defi': CHANNELS.BLOCKCHAIN,
      };

      const wsChannel = channelMapping[channel] || CHANNELS.BLOCKCHAIN;
      broadcastToChannel(wsChannel, event, data);
    });

    // Subscribe to governance events if contract address is configured
    const governanceContractAddress = process.env.GOVERNANCE_CONTRACT_ADDRESS;
    if (governanceContractAddress && governanceContractAddress !== '0x0000000000000000000000000000000000000000') {
      await blockchainEventSubscriber.subscribeToGovernanceEvents(governanceContractAddress, 'governance');
      appLogger.info('[WS Blockchain] Subscribed to governance events');
    }

    // Subscribe to carbon credit events if contract address is configured
    const carbonCreditContractAddress = process.env.CARBON_CREDIT_CONTRACT_ADDRESS;
    if (carbonCreditContractAddress && carbonCreditContractAddress !== '0x0000000000000000000000000000000000000000') {
      await blockchainEventSubscriber.subscribeToCarbonCreditEvents(carbonCreditContractAddress, 'carbon-credits');
      appLogger.info('[WS Blockchain] Subscribed to carbon credit events');
    }

    // Subscribe to DeFi events if contract addresses are configured
    const ammContractAddress = process.env.AMM_CONTRACT_ADDRESS;
    const yieldFarmingContractAddress = process.env.YIELD_FARMING_CONTRACT_ADDRESS;
    if (ammContractAddress && yieldFarmingContractAddress) {
      await blockchainEventSubscriber.subscribeToDeFiEvents(ammContractAddress, yieldFarmingContractAddress, 'defi');
      appLogger.info('[WS Blockchain] Subscribed to DeFi events');
    }

    blockchainEventsEnabled = true;
    appLogger.info('[WS Blockchain] Blockchain event subscriber initialized successfully');
  } catch (error) {
    appLogger.warn('[WS Blockchain] Could not initialize blockchain event subscriber', { error: error.message });
  }
}

// Storage implementation - returns null when not configured (no mock data)
const storage = {
  getUser: async () => {
    appLogger.warn('Storage not configured - getUser called');
    return null;
  },
  getBlockByHash: async () => {
    appLogger.warn('Storage not configured - getBlockByHash called');
    return null;
  },
  getLatestBlocks: async () => {
    appLogger.warn('Storage not configured - getLatestBlocks called');
    return [];
  },
};

// Create Express app and HTTP server
const app = express();
app.use(
  cors({
    origin: resolveAllowedOrigins({ developmentDefaults: [
      'https://wrfcoin.replit.app',
      'https://78d83de6-3c2e-4513-8977-f64d83a9e3cb-00-33g6fqpn548lr.worf.replit.dev',
      'http://localhost:5000',
      'http://0.0.0.0:5000',
    ] }),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  })
);
app.use(express.json());

// Weather data blockchain submission endpoint
app.post('/api/blockchain/submit-weather', (req, res) => {
  try {
    const weatherData = req.body;

    appLogger.info('Weather data submitted to testnet blockchain', {
      stationId: weatherData.stationId,
      hubId: weatherData.hubId,
      sensorCount: weatherData.sensorCount,
      reward: weatherData.reward,
      rewardAddress: weatherData.rewardAddress
    });

    // Generate transaction details
    const transactionId = `tx_weather_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const blockHeight = Math.floor(Math.random() * 1000) + 1200;
    const blockHash = `wrfc_${Math.random().toString(36).substr(2, 12)}`;

    appLogger.info('Transaction created', { transactionId, blockHeight, blockHash });

    // Broadcast to WebSocket clients
    broadcastToChannel('blockchain', 'WEATHER_DATA_TRANSACTION', {
      transactionId,
      stationId: weatherData.stationId,
      reward: weatherData.reward,
      blockHeight,
      blockHash,
      timestamp: new Date().toISOString(),
    });

    res.json({
      success: true,
      transactionId,
      blockHeight,
      blockHash,
      message: 'Weather data recorded on testnet blockchain',
    });
  } catch (error) {
    logError(appLogger, 'Weather data submission failed', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

// Serve static files from the /static directory
app.use(express.static(path.join(__dirname, '../static')));

// Generate self-signed certificate for development
function generateSelfSignedCert() {
  // Generate a new key pair for each instance (more secure)
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  // For development only - in production, use proper SSL certificates
  appLogger.warn('Using auto-generated self-signed certificate for development. Use proper SSL certificates in production.');

  return {
    key: privateKey,
    cert: publicKey, // Note: This is a simplified approach for development only
  };
}

// Create server (HTTPS in production, HTTP in development)
const useHTTPS =
  process.env.NODE_ENV === 'production' || process.env.USE_HTTPS === 'true';
const server = useHTTPS
  ? https.createServer(
      {
        key: process.env.SSL_KEY || generateSelfSignedCert().key,
        cert: process.env.SSL_CERT || generateSelfSignedCert().cert,
      },
      app
    )
  : http.createServer(app);

// Create WebSocket server
let wss = new WebSocketServer({
  server,
  path: '/ws',
  perMessageDeflate: {
    zlibDeflateOptions: {
      chunkSize: 1024,
      memLevel: 7,
      level: 3,
    },
    zlibInflateOptions: {
      chunkSize: 10 * 1024,
    },
    clientNoContextTakeover: true,
    serverNoContextTakeover: true,
    serverMaxWindowBits: 10,
    concurrencyLimit: 10,
    threshold: 1024,
  },
});

// Keep track of all connected clients with their subscriptions
const clients = new Map();

// Shared channel constants — keeps both WS servers in sync (#454)
const { CHANNELS } = require('./utils/ws-channels');

// Initialize WebSocket server
async function initializeWebSocketServer(httpServer = null) {
  // Initialize auth modules first
  await initializeAuthModules();

  // Initialize blockchain event subscriber (Task 77)
  await initializeBlockchainEventSubscriber();

  // If httpServer is provided, use it instead of our internal server
  if (httpServer) {
    // Create a new WebSocket server attached to the provided HTTP server
    const newWss = new WebSocketServer({
      server: httpServer,
      path: '/ws',
      perMessageDeflate: {
        zlibDeflateOptions: { chunkSize: 1024, memLevel: 7, level: 3 },
        zlibInflateOptions: { chunkSize: 10 * 1024 },
        clientNoContextTakeover: true,
        serverNoContextTakeover: true,
        threshold: 1024,
      },
    });

    // Replace our reference
    wss = newWss;
  }

  // If auth is enabled, set up authenticated upgrade handler
  if (authEnabled && httpServer) {
    setupAuthenticatedUpgrade(httpServer);
  }

  wss.on('connection', async (ws, req) => {
    const clientId = ws.connectionId || uuidv4();
    const ipAddress = ws.ipAddress || getClientIp(req);
    appLogger.info('WebSocket client connected', { clientId });

    // Store client information with default subscriptions and auth info
    const userInfo = ws.user || { role: 'guest', id: clientId };
    clients.set(ws, {
      id: clientId,
      subscriptions: [CHANNELS.GLOBAL],
      user: userInfo,
      ipAddress: ipAddress,
      connectedAt: Date.now(),
    });

    // Create session if auth is enabled
    if (authEnabled && wsSessionManager && ws.user) {
      const userAgent = req.headers['user-agent'] || 'unknown';
      await wsSessionManager.createSession(ws, userAgent).catch(err => {
        appLogger.error('[WS Session] Failed to create session', { error: err.message });
      });

      // Log successful connection
      if (wsSecurityLogger) {
        wsSecurityLogger.logConnectionSuccess(
          clientId,
          ws.user.id,
          ws.user.role,
          ipAddress,
          userAgent
        );
      }
    }

    // Send a welcome message
    ws.send(
      JSON.stringify({
        channel: CHANNELS.GLOBAL,
        event: 'CONNECTION_ESTABLISHED',
        data: {
          clientId,
          userId: userInfo.id,
          role: userInfo.role,
          message: 'Connected to Wrfcoin WebSocket Server',
          timestamp: new Date().toISOString(),
          authenticated: !!ws.user,
        },
      })
    );

    // Handle messages from clients
    ws.on('message', message => {
      try {
        const data = JSON.parse(message);
        handleClientMessage(ws, data);
      } catch (error) {
        logError(appLogger, 'Error parsing WebSocket message', error);
        sendErrorToClient(ws, 'Invalid message format');
      }
    });

    // Handle client disconnection
    ws.on('close', async () => {
      appLogger.info('WebSocket client disconnected', { clientId });
      const clientInfo = clients.get(ws);

      // Clean up session
      await handleClientDisconnect(ws, clientInfo);

      clients.delete(ws);
    });

    // Handle errors
    ws.on('error', error => {
      logError(appLogger, `WebSocket error for client ${clientId}`, error);
    });

    // Send initial subscription confirmation
    sendSubscriptionUpdate(ws);
  });

  appLogger.info('WebSocket server initialized');
}

// Handle messages from clients
function handleClientMessage(ws, data) {
  const clientInfo = clients.get(ws);

  if (!clientInfo) {
    return;
  }

  switch (data.action) {
    case 'subscribe':
      handleSubscription(ws, clientInfo, data.channels);
      break;

    case 'unsubscribe':
      handleUnsubscription(ws, clientInfo, data.channels);
      break;

    case 'ping':
      // Respond with a pong
      ws.send(
        JSON.stringify({
          channel: CHANNELS.GLOBAL,
          event: 'PONG',
          data: {
            timestamp: new Date().toISOString(),
          },
        })
      );
      break;

    default:
      sendErrorToClient(ws, `Unknown action: ${data.action}`);
  }
}

// Handle subscription requests
async function handleSubscription(ws, clientInfo, channels) {
  if (!Array.isArray(channels)) {
    sendErrorToClient(ws, 'Channels must be an array');
    return;
  }

  // Filter only valid channels
  const validChannels = channels.filter(channel =>
    Object.values(CHANNELS).includes(channel)
  );

  const authorizedChannels = [];
  const deniedChannels = [];

  // Check channel authorization if auth is enabled
  for (const channel of validChannels) {
    if (authEnabled && wsChannelAuth) {
      // Create a mock authenticated WebSocket for authorization check
      const authWs = {
        user: {
          id: clientInfo.user?.id || clientInfo.id,
          address: clientInfo.user?.address || '0x0000000000000000000000000000000000000000',
          role: clientInfo.user?.role || 'guest',
          permissions: clientInfo.user?.permissions || [],
        },
      };

      const authResult = wsChannelAuth.canSubscribe(authWs, channel);

      if (authResult.allowed) {
        authorizedChannels.push(channel);

        // Log successful subscription
        if (wsSecurityLogger) {
          wsSecurityLogger.logChannelSubscribe(
            clientInfo.id,
            clientInfo.user?.id || clientInfo.id,
            channel,
            clientInfo.ipAddress || 'unknown'
          );
        }
      } else {
        deniedChannels.push({ channel, reason: authResult.reason });

        // Log denied subscription
        if (wsSecurityLogger) {
          wsSecurityLogger.logChannelSubscribeDenied(
            clientInfo.id,
            clientInfo.user?.id || clientInfo.id,
            channel,
            authResult.reason || 'Unauthorized',
            clientInfo.ipAddress || 'unknown'
          );
        }
      }
    } else {
      // No auth, allow all valid channels
      authorizedChannels.push(channel);
    }
  }

  // Update client subscriptions (maintaining uniqueness)
  clientInfo.subscriptions = [
    ...new Set([...clientInfo.subscriptions, ...authorizedChannels]),
  ];

  // Update session with subscribed channels
  if (authEnabled && wsSessionManager && ws.connectionId) {
    await wsSessionManager.updateChannels(ws.connectionId, clientInfo.subscriptions).catch(err => {
      appLogger.error('[WS Session] Failed to update channels', { error: err.message });
    });
  }

  // Send updated subscriptions to client
  sendSubscriptionUpdate(ws, deniedChannels);
}

// Handle unsubscription requests
function handleUnsubscription(ws, clientInfo, channels) {
  if (!Array.isArray(channels)) {
    sendErrorToClient(ws, 'Channels must be an array');
    return;
  }

  // Remove specified channels from subscriptions
  clientInfo.subscriptions = clientInfo.subscriptions.filter(
    sub => !channels.includes(sub) || sub === CHANNELS.GLOBAL // Cannot unsubscribe from global
  );

  // Send updated subscriptions to client
  sendSubscriptionUpdate(ws);
}

// Send subscription update to client
function sendSubscriptionUpdate(ws, deniedChannels = []) {
  const clientInfo = clients.get(ws);
  if (!clientInfo) return;

  const responseData = {
    subscriptions: clientInfo.subscriptions,
    message: 'Subscription updated successfully',
  };

  // Include denied channels if any
  if (deniedChannels.length > 0) {
    responseData.denied = deniedChannels;
    responseData.message = `Subscription updated. ${deniedChannels.length} channel(s) denied due to authorization.`;
  }

  ws.send(
    JSON.stringify({
      channel: CHANNELS.GLOBAL,
      event: 'SUBSCRIPTION_UPDATED',
      data: responseData,
    })
  );
}

// Send error message to client
function sendErrorToClient(ws, errorMessage) {
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

// Broadcast a message to all clients subscribed to the specified channel
function broadcastToChannel(channel, event, data) {
  clients.forEach((clientInfo, ws) => {
    if (
      clientInfo.subscriptions.includes(channel) &&
      ws.readyState === ws.OPEN
    ) {
      ws.send(
        JSON.stringify({
          channel,
          event,
          data: {
            ...data,
            message: data.message || `Event: ${event}`,
            channel,
            timestamp: data.timestamp || new Date().toISOString(),
          },
        })
      );
    }
  });
}

// Broadcast a transaction event
function broadcastTransaction(transaction, message) {
  appLogger.debug('Broadcasted transaction', { transactionId: transaction.id });
  broadcastToChannel(CHANNELS.BLOCKCHAIN, 'TRANSACTION_CREATED', {
    transaction,
    message: message || `New transaction created: ${transaction.id}`,
  });
}

// Broadcast a blockchain state update
function broadcastBlockchainState(state) {
  broadcastToChannel(CHANNELS.BLOCKCHAIN, 'STATE_UPDATE', {
    state,
    message: 'Blockchain state updated',
  });
}

// Broadcast a cross-chain bridge transaction
function broadcastBridgeTransaction(transaction, status, message) {
  broadcastToChannel(CHANNELS.CROSS_CHAIN, 'BRIDGE_TRANSACTION_UPDATED', {
    transaction: {
      ...transaction,
      status,
    },
    message: message || `Bridge transaction status updated to ${status}`,
  });
}

// Broadcast API monitoring metrics
function broadcastApiMetrics(metrics, event = 'REAL_TIME_METRICS') {
  broadcastToChannel(CHANNELS.API_MONITORING, event, {
    metrics,
    message: 'Real-time API metrics update',
    timestamp: new Date().toISOString(),
  });
}

// Broadcast API health status
function broadcastApiHealth(healthStatus, event = 'HEALTH_STATUS_UPDATE') {
  broadcastToChannel(CHANNELS.API_MONITORING, event, {
    health: healthStatus,
    message: `API health status: ${healthStatus.status}`,
    timestamp: new Date().toISOString(),
  });
}

// Broadcast API alert
function broadcastApiAlert(alert, event = 'API_ALERT') {
  broadcastToChannel(CHANNELS.API_MONITORING, event, {
    alert,
    message: `API Alert: ${alert.type} - ${alert.message}`,
    timestamp: new Date().toISOString(),
  });
}

// Helper to generate a realistic mock transaction
function generateMockTransaction(type = 'Regular') {
  const transactionTypes = ['Regular', 'Computational', 'NFT Mint', 'Coinbase'];
  const priorities = ['Low', 'Medium', 'High'];
  const addresses = {
    Wrf1AbCdEfGhIjKl: 'Validator Node 1',
    Wrf2MnOpQrStUvWx: 'Validator Node 2',
    Wrf3YzAbCdEfGhIj: 'Wrfcoin Foundation',
    Wrf4KlMnOpQrStUv: 'Mining Pool Alpha',
    Wrf5WxYzAbCdEfGh: 'Mining Pool Beta',
    Wrf6IjKlMnOpQrSt: 'Wrfcoin Research Institute',
    Wrf7UvWxYzAbCdEf: 'NFT Marketplace',
    Wrf8GhIjKlMnOpQr: 'Computational Node Cluster',
    Wrf9StUvWxYzAbCd: 'Community Treasury',
  };

  const regions = ['North America', 'Europe', 'Asia', 'Global'];
  const computeTypes = ['WRF', 'GFS', 'ECMWF'];

  // Create a transaction ID
  const txId = 'tx' + Math.random().toString(36).substring(2, 10);

  // Select random addresses for inputs and outputs
  const addressKeys = Object.keys(addresses);
  const inputAddresses = [];
  const outputAddresses = [];

  // Generate 1-2 inputs
  const inputCount = Math.floor(Math.random() * 2) + 1;
  for (let i = 0; i < inputCount; i++) {
    const addrKey = addressKeys[Math.floor(Math.random() * addressKeys.length)];
    inputAddresses.push({
      address: addrKey,
      name: addresses[addrKey],
      amount: Number((Math.random() * 50).toFixed(2)),
    });
  }

  // Generate 1-2 outputs
  const outputCount = Math.floor(Math.random() * 2) + 1;
  for (let i = 0; i < outputCount; i++) {
    const addrKey = addressKeys[Math.floor(Math.random() * addressKeys.length)];
    outputAddresses.push({
      address: addrKey,
      name: addresses[addrKey],
      amount: Number((Math.random() * 50).toFixed(2)),
    });
  }

  // Base transaction data
  const tx = {
    id: txId,
    timestamp: Math.floor(Date.now() / 1000),
    transaction_type:
      type ||
      transactionTypes[Math.floor(Math.random() * transactionTypes.length)],
    fee: Number((Math.random() * 0.1).toFixed(4)),
    size: Math.floor(Math.random() * 2000) + 200,
    gas_used: 0,
    confirmations: Math.floor(Math.random() * 5),
    priority: priorities[Math.floor(Math.random() * priorities.length)],
    inputs: inputAddresses,
    outputs: outputAddresses,
    meta: {},
  };

  // Add type-specific data
  switch (tx.transaction_type) {
    case 'Computational':
      tx.gas_used = Math.floor(Math.random() * 300000) + 50000;
      tx.meta = {
        computeType:
          computeTypes[Math.floor(Math.random() * computeTypes.length)],
        cpuTime: Math.floor(Math.random() * 300) + 10,
        region: regions[Math.floor(Math.random() * regions.length)],
      };
      break;

    case 'NFT Mint':
      tx.gas_used = Math.floor(Math.random() * 200000) + 50000;
      tx.meta = {
        nftId: 'NFT-' + Math.random().toString(36).substring(2, 10),
        creatorRoyalty: Math.floor(Math.random() * 10) + 1,
      };
      break;

    case 'Coinbase':
      tx.fee = 0;
      tx.inputs[0].amount = 0;
      tx.meta = {
        blockHeight: Math.floor(Math.random() * 100) + 1000,
        difficulty: Math.floor(Math.random() * 10) + 1,
      };
      break;
  }

  return tx;
}

// Helper to generate a cross-chain bridge transaction
function generateCrossChainTransaction(direction = 'outbound') {
  const chains = ['ethereum', 'polygon', 'solana', 'bnbchain'];
  const statuses = ['initiated', 'locked', 'minted', 'unlocked', 'completed'];

  const fromChain =
    direction === 'outbound'
      ? 'wrfcoin'
      : chains[Math.floor(Math.random() * chains.length)];
  const toChain =
    direction === 'outbound'
      ? chains[Math.floor(Math.random() * chains.length)]
      : 'wrfcoin';

  let senderAddress, recipientAddress;

  if (direction === 'outbound') {
    senderAddress = `WrfXPBridge${Math.floor(Math.random() * 2) + 1}`;
    recipientAddress = `0x${Math.random()
      .toString(36)
      .substring(2, 27)
      .replace(/[0-9]/g, d => String.fromCharCode(97 + parseInt(d, 10)))}`;
  } else {
    if (fromChain === 'solana') {
      senderAddress = `${Math.random()
        .toString(36)
        .substring(2, 27)
        .replace(/[0-9]/g, d => String.fromCharCode(65 + parseInt(d, 10)))}A`;
    } else {
      senderAddress = `0x${Math.random()
        .toString(36)
        .substring(2, 27)
        .replace(/[0-9]/g, d => String.fromCharCode(97 + parseInt(d, 10)))}`;
    }
    recipientAddress = `WrfWallet${String.fromCharCode(65 + Math.floor(Math.random() * 4))}`;
  }

  return {
    tx_id: 'tx' + Math.random().toString(36).substring(2, 10),
    status: 'initiated',
    direction,
    from_chain: fromChain,
    to_chain: toChain,
    amount: Math.floor(Math.random() * 100) + 1,
    sender_address: senderAddress,
    recipient_address: recipientAddress,
    external_transaction_hash:
      direction === 'outbound'
        ? `0x${Math.random().toString(16).substring(2, 16)}`
        : null,
    wrf_transaction_hash: `0x${Math.random().toString(16).substring(2, 16)}`,
    timestamp: new Date().toISOString(),
  };
}

// Start mock blockchain activity simulation
function startMockBlockchainActivitySimulation() {
  // Generate random transactions
  setInterval(
    () => {
      const txTypes = ['Regular', 'Computational', 'NFT Mint', 'Coinbase'];
      const randomType = txTypes[Math.floor(Math.random() * txTypes.length)];

      const transaction = generateMockTransaction(randomType);
      broadcastTransaction(transaction);
    },
    Math.floor(Math.random() * 5000) + 3000
  );

  // Update blockchain state periodically
  setInterval(() => {
    const state = {
      blockHeight: Math.floor(Math.random() * 100) + 1000,
      hashrate: Math.floor(Math.random() * 1000) + 500,
      difficulty: Math.floor(Math.random() * 10) + 1,
      pendingTransactions: Math.floor(Math.random() * 20),
    };

    broadcastBlockchainState(state);
  }, 10000);

  appLogger.info('Started mock blockchain activity simulation for WebSocket clients');
}

// Start mock cross-chain activity simulation
function startMockCrossChainActivitySimulation() {
  // Create new bridge transactions occasionally
  setInterval(
    () => {
      const direction = Math.random() > 0.5 ? 'outbound' : 'inbound';
      const transaction = generateCrossChainTransaction(direction);

      broadcastToChannel(CHANNELS.CROSS_CHAIN, 'BRIDGE_TRANSACTION_CREATED', {
        transaction,
        message: `New bridge transaction: ${transaction.tx_id}`,
      });

      // Schedule status updates for this transaction
      const statuses = ['locked', 'minted', 'unlocked', 'completed'];
      let currentStatusIndex = 0;

      const updateInterval = setInterval(
        () => {
          if (currentStatusIndex >= statuses.length) {
            clearInterval(updateInterval);
            return;
          }

          const newStatus = statuses[currentStatusIndex++];

          // Wait a random amount of time before updating
          setTimeout(
            () => {
              broadcastBridgeTransaction(transaction, newStatus);
            },
            Math.floor(Math.random() * 5000) + 3000
          );
        },
        Math.floor(Math.random() * 8000) + 5000
      );
    },
    Math.floor(Math.random() * 20000) + 15000
  );

  appLogger.info('Started mock cross-chain activity simulation for WebSocket clients');
}

// Start server when run directly
if (require.main === module) {
  const PORT = process.env.PORT || 4002;

  // Initialize the WebSocket server
  initializeWebSocketServer();

  // Start the HTTP server
  server.listen(PORT, '0.0.0.0', () => {
    const protocol = useHTTPS ? 'wss' : 'ws';
    appLogger.info('Wrfcoin WebSocket Server Ready', {
      protocol,
      host: '0.0.0.0',
      port: PORT,
      path: '/ws',
      https: useHTTPS
    });
    if (!useHTTPS) {
      appLogger.warn('Development mode: Using unencrypted WebSocket connections. Set NODE_ENV=production or USE_HTTPS=true for secure WebSocket (WSS)');
    }
    appLogger.info('Real-time data streaming active');

    // Start mock activity simulations
    startMockBlockchainActivitySimulation();
    startMockCrossChainActivitySimulation();
  });

  // Setup graceful shutdown
  const gracefulShutdown = GracefulShutdown.getInstance({
    logger: (message, level) => {
      if (level === 'error') {
        appLogger.error(message);
      } else if (level === 'warn') {
        appLogger.warn(message);
      } else {
        appLogger.info(message);
      }
    },
  });

  // Register WebSocket server close handler
  gracefulShutdown.registerHandler({
    name: 'websocket-server-close',
    priority: ShutdownPriority.CLOSE_WEBSOCKETS,
    timeout: 10000,
    handler: async () => {
      appLogger.info('Closing WebSocket connections...');

      // Close all client connections
      clients.forEach((clientInfo, ws) => {
        if (ws.readyState === ws.OPEN) {
          ws.close(1001, 'Server shutting down');
        }
      });
      clients.clear();

      // Close WebSocket server
      await new Promise((resolve, reject) => {
        wss.close((err) => {
          if (err) {
            appLogger.error('Error closing WebSocket server', { error: err.message });
            reject(err);
          } else {
            appLogger.info('WebSocket server closed');
            resolve();
          }
        });
      });

      // Close HTTP server
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) {
            appLogger.error('Error closing HTTP server', { error: err.message });
            reject(err);
          } else {
            appLogger.info('HTTP server closed');
            resolve();
          }
        });
      });
    },
  });

  // Register blockchain event subscriber cleanup if enabled
  gracefulShutdown.registerHandler({
    name: 'websocket-blockchain-subscriber-cleanup',
    priority: ShutdownPriority.STOP_BACKGROUND_JOBS,
    timeout: 5000,
    handler: async () => {
      if (blockchainEventSubscriber && blockchainEventsEnabled) {
        appLogger.info('Cleaning up blockchain event subscriber...');
        await blockchainEventSubscriber.cleanup?.();
      }
    },
  });

  // Setup signal handlers
  gracefulShutdown.setupSignalHandlers();
}

// Helper function to get client IP address
function getClientIp(req) {
  // Check X-Forwarded-For header (from reverse proxy)
  const forwardedFor = req.headers['x-forwarded-for'];
  if (forwardedFor) {
    const ips = Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor.split(',')[0];
    return ips.trim();
  }

  // Check X-Real-IP header (nginx)
  const realIp = req.headers['x-real-ip'];
  if (realIp) {
    return Array.isArray(realIp) ? realIp[0] : realIp;
  }

  // Fall back to socket remote address
  const socketAddress = req.socket?.remoteAddress;
  if (socketAddress) {
    // Handle IPv4-mapped IPv6 addresses
    return socketAddress.replace(/^::ffff:/, '');
  }

  return '0.0.0.0';
}

// Set up authenticated upgrade handler (Task 74)
function setupAuthenticatedUpgrade(httpServer) {
  // Remove default upgrade listener if exists
  const listeners = httpServer.listeners('upgrade');

  httpServer.on('upgrade', async (request, socket, head) => {
    const ipAddress = getClientIp(request);
    const userAgent = request.headers['user-agent'] || 'unknown';

    // Log connection attempt
    if (wsSecurityLogger) {
      wsSecurityLogger.logConnectionAttempt(ipAddress, userAgent);
    }

    // Check connection rate limit
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
          socket.write('HTTP/1.1 429 Too Many Requests\r\n\r\n');
          socket.destroy();
          return;
        }
      } catch (err) {
        appLogger.error('[WS RateLimit] Error checking rate limit', { error: err.message });
      }
    }

    // Authenticate the request
    if (wsAuthMiddleware) {
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
          socket.write(`HTTP/1.1 ${statusCode} ${statusCode === 401 ? 'Unauthorized' : 'Forbidden'}\r\n\r\n`);
          socket.destroy();
          return;
        }

        // Store auth info on the request for later use
        request.authResult = authResult;
      } catch (err) {
        appLogger.error('[WS Auth] Authentication error', { error: err.message });
        // Allow connection to proceed without auth on error
      }
    }

    // Let the default WebSocket upgrade handler proceed
    wss.handleUpgrade(request, socket, head, (ws) => {
      // Attach user info if authenticated
      if (request.authResult?.user) {
        ws.user = {
          id: request.authResult.user.id,
          address: request.authResult.user.address,
          role: request.authResult.user.role,
          permissions: request.authResult.user.permissions || [],
          sessionId: request.authResult.sessionId,
        };
        ws.connectionId = `ws_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        ws.ipAddress = ipAddress;
        ws.connectedAt = Date.now();
        ws.lastActivity = Date.now();
        ws.subscribedChannels = new Set();
        ws.messageCount = 0;
        ws.tokenExpiry = request.authResult.user.exp * 1000;
      }

      wss.emit('connection', ws, request);
    });
  });
}

// Handle client disconnection with session cleanup
async function handleClientDisconnect(ws, clientInfo) {
  if (authEnabled && wsSessionManager && ws.connectionId) {
    const sessionDuration = (Date.now() - (ws.connectedAt || Date.now())) / 1000;

    // Log session destroyed
    if (wsSecurityLogger && clientInfo?.user) {
      wsSecurityLogger.logSessionDestroyed(
        ws.connectionId,
        clientInfo.user.id,
        clientInfo.user.role,
        ws.ipAddress || 'unknown',
        sessionDuration
      );
    }

    // Remove session from Redis
    await wsSessionManager.removeSession(
      ws.connectionId,
      clientInfo?.user?.id || clientInfo?.id
    ).catch(err => {
      appLogger.error('[WS Session] Failed to remove session', { error: err.message });
    });
  }
}

// Get WebSocket security metrics
function getSecurityMetrics() {
  if (!wsSecurityLogger) {
    return { enabled: false };
  }

  return {
    enabled: true,
    activeConnections: wsSecurityLogger.getTotalConnections(),
    connectionsByRole: wsSecurityLogger.getActiveConnectionsByRole(),
    authStats: wsSecurityLogger.getAuthFailureRate(),
    rateLimitStats: wsSecurityLogger.getRateLimitStats(),
    channelAuthFailures: wsSecurityLogger.getChannelAuthFailures(),
  };
}

// Prometheus metrics endpoint handler
function getPrometheusMetrics() {
  if (!wsSecurityLogger) {
    return '';
  }
  return wsSecurityLogger.getPrometheusMetrics();
}

// Get blockchain event subscriber status (Task 77)
function getBlockchainEventStatus() {
  if (!blockchainEventSubscriber || !blockchainEventsEnabled) {
    return {
      enabled: false,
      initialized: false,
      subscriptions: [],
    };
  }

  return {
    enabled: true,
    initialized: blockchainEventSubscriber.isInitialized(),
    subscriptions: blockchainEventSubscriber.getActiveSubscriptions(),
  };
}

// Export the required functions
module.exports = {
  initWebSocketServer: initializeWebSocketServer,
  broadcastToChannel,
  broadcastTransaction,
  broadcastBlockchainState,
  broadcastBridgeTransaction,
  broadcastApiMetrics,
  broadcastApiHealth,
  broadcastApiAlert,
  startMockBlockchainActivitySimulation,
  startMockCrossChainActivitySimulation,
  broadcastStateUpdate: broadcastBlockchainState, // Add alias for backward compatibility
  server,
  app,
  CHANNELS,
  // Task 74: WebSocket Authentication and Authorization exports
  getSecurityMetrics,
  getPrometheusMetrics,
  isAuthEnabled: () => authEnabled,
  // Task 77: Blockchain Event Subscriber exports
  getBlockchainEventStatus,
  isBlockchainEventsEnabled: () => blockchainEventsEnabled,
};
