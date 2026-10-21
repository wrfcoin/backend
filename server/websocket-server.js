// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});

import WebSocket, { WebSocketServer } from 'ws';
import http from 'http';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { registerGracefulShutdown } = require('./utils/graceful-shutdown');
const { writeProbeResponse } = require('./utils/raw-http-health');
// Shared channel constants — keeps both WS servers in sync (#454)
const { CHANNELS } = require('./utils/ws-channels');

const PORT = 6000;
const probeState = { draining: false };
const backgroundIntervals = [];

// Create HTTP server for WebSocket upgrade
const server = http.createServer();
server.on('request', (req, res) => {
  if (writeProbeResponse(req, res, 'websocket-server', probeState)) {
    return;
  }

  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({
      success: false,
      error: 'Not found',
    })
  );
});

// Create WebSocket server
const wss = new WebSocketServer({
  server,
  path: '/ws',
});

// Store client subscriptions
const clients = new Map();

// Broadcast to all clients subscribed to a channel.
// Message shape matches websocket.js: { channel, event, data, timestamp } (#454).
function broadcast(channel, event, data) {
  const message = JSON.stringify({
    channel,
    event,
    data,
    timestamp: Date.now(),
  });

  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN) {
      const clientInfo = clients.get(client);
      if (clientInfo && clientInfo.channels.has(channel)) {
        client.send(message);
      }
    }
  });
}

// Handle new WebSocket connections
wss.on('connection', (ws, req) => {
  console.log('New WebSocket connection from:', req.socket.remoteAddress);

  // Initialize client info
  clients.set(ws, {
    channels: new Set(),
    lastPing: Date.now(),
  });

  // Send welcome message
  ws.send(
    JSON.stringify({
      type: 'welcome',
      message: 'Connected to Wrfcoin WebSocket server',
      timestamp: Date.now(),
    })
  );

  ws.on('message', rawMessage => {
    try {
      const message = JSON.parse(rawMessage.toString());
      const clientInfo = clients.get(ws);

      switch (message.type) {
        case 'subscribe':
          if (message.channel && clientInfo) {
            clientInfo.channels.add(message.channel);
            console.log(`Client subscribed to channel: ${message.channel}`);

            // Send confirmation
            ws.send(
              JSON.stringify({
                type: 'subscribed',
                channel: message.channel,
                timestamp: Date.now(),
              })
            );
          }
          break;

        case 'unsubscribe':
          if (message.channel && clientInfo) {
            clientInfo.channels.delete(message.channel);
            console.log(`Client unsubscribed from channel: ${message.channel}`);
          }
          break;

        case 'ping':
          if (clientInfo) {
            clientInfo.lastPing = Date.now();
            ws.send(
              JSON.stringify({
                type: 'pong',
                timestamp: Date.now(),
              })
            );
          }
          break;

        default:
          console.log('Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('Error processing WebSocket message:', error);
    }
  });

  ws.on('close', (code, reason) => {
    console.log(`WebSocket connection closed: ${code} ${reason}`);
    clients.delete(ws);
  });

  ws.on('error', error => {
    console.error('WebSocket error:', error);
    clients.delete(ws);
  });
});

// Simulate blockchain data updates
backgroundIntervals.push(setInterval(() => {
  const blockchainData = {
    blockHeight: 1024567 + Math.floor(Math.random() * 10),
    hashRate: (150.2 + (Math.random() - 0.5) * 10).toFixed(1) + ' TH/s',
    peers: 42 + Math.floor(Math.random() * 5),
    timestamp: new Date().toISOString(),
  };

  broadcast(CHANNELS.BLOCKCHAIN, 'BLOCK_UPDATE', blockchainData);
}, 5000));

// Simulate mining updates
backgroundIntervals.push(setInterval(() => {
  const miningData = {
    isMining: true,
    currentBlock: 1024567 + Math.floor(Math.random() * 10),
    hashRate: (15.2 + (Math.random() - 0.5) * 2).toFixed(1) + ' GH/s',
    difficulty: 4.2e12 + Math.random() * 1e11,
    timestamp: new Date().toISOString(),
  };

  broadcast(CHANNELS.MINING, 'MINING_UPDATE', miningData);
}, 8000));

// Start the server
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🔌 WebSocket Server running on ws://0.0.0.0:${PORT}/ws`);
  console.log(`📡 Broadcasting real-time blockchain data`);
  console.log(`👥 Clients connected: ${wss.clients.size}`);
});

// Clean up inactive connections every 30 seconds
backgroundIntervals.push(setInterval(() => {
  const now = Date.now();
  wss.clients.forEach(client => {
    const clientInfo = clients.get(client);
    if (clientInfo && now - clientInfo.lastPing > 60000) {
      console.log('Terminating inactive WebSocket connection');
      client.terminate();
      clients.delete(client);
    }
  });
}, 30000));

registerGracefulShutdown({
  serviceName: 'websocket-server',
  server,
  logger: console,
  state: probeState,
  cleanupFns: [
    {
      name: 'websocket-server-background-intervals',
      handler: () => {
        backgroundIntervals.forEach(interval => clearInterval(interval));
      },
    },
    {
      name: 'websocket-server-ws-close',
      handler: () =>
        new Promise(resolve => {
          wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
              client.close(1001, 'Server shutting down');
            }
          });
          clients.clear();
          wss.close(() => resolve());
        }),
    },
  ],
});
