/**
 * WebSocket Connection Stabilizer for Wrfcoin Backend
 * Provides robust WebSocket server configuration and client management
 */

const WebSocket = require('ws');
const { appLogger } = require('./logger');

class WebSocketStabilizer {
  constructor(server, options = {}) {
    this.server = server;
    this.clients = new Map();
    this.heartbeatInterval = options.heartbeatInterval || 30000;
    this.heartbeatTimer = null;

    this.wss = new WebSocket.Server({
      server: this.server,
      path: options.path || '/ws',
      perMessageDeflate: false,
      maxPayload: options.maxPayload || 1024 * 1024,
      clientTracking: true,
    });

    this.setupConnectionHandling();
    this.startHeartbeat();
  }

  setupConnectionHandling() {
    this.wss.on('connection', (ws, req) => {
      const clientId = this.generateClientId();
      const clientInfo = {
        id: clientId,
        ip: req.socket.remoteAddress,
        userAgent: req.headers['user-agent'],
        connectedAt: new Date(),
        isAlive: true,
        subscriptions: new Set(),
      };

      this.clients.set(ws, clientInfo);
      appLogger.info('WebSocket client connected', { module: 'WebSocketStabilizer', clientId, totalClients: this.wss.clients.size });

      // Setup client event handlers
      ws.on('pong', () => {
        const client = this.clients.get(ws);
        if (client) {
          client.isAlive = true;
        }
      });

      ws.on('message', data => {
        try {
          this.handleMessage(ws, JSON.parse(data.toString()));
        } catch (error) {
          appLogger.error('WebSocket message parse error', { module: 'WebSocketStabilizer', error: error.message });
          this.sendError(ws, 'Invalid message format');
        }
      });

      ws.on('close', (code, reason) => {
        const client = this.clients.get(ws);
        if (client) {
          appLogger.info('WebSocket client disconnected', { module: 'WebSocketStabilizer', clientId: client.id, code });
          this.clients.delete(ws);
        }
      });

      ws.on('error', error => {
        appLogger.error('WebSocket client error', { module: 'WebSocketStabilizer', error: error.message });
        const client = this.clients.get(ws);
        if (client) {
          this.clients.delete(ws);
        }
      });

      // Send welcome message
      this.sendMessage(ws, {
        type: 'welcome',
        clientId: clientId,
        timestamp: new Date().toISOString(),
        serverInfo: {
          version: '2.0.0',
          capabilities: ['blockchain', 'weather', 'cross-chain', 'governance'],
        },
      });
    });

    this.wss.on('error', error => {
      appLogger.error('WebSocket server error', { module: 'WebSocketStabilizer', error: error.message });
    });
  }

  handleMessage(ws, message) {
    const client = this.clients.get(ws);
    if (!client) return;

    switch (message.type) {
      case 'ping':
        this.sendMessage(ws, {
          type: 'pong',
          timestamp: new Date().toISOString(),
        });
        break;

      case 'subscribe':
        if (message.channel) {
          client.subscriptions.add(message.channel);
          this.sendMessage(ws, {
            type: 'subscribed',
            channel: message.channel,
            timestamp: new Date().toISOString(),
          });
        }
        break;

      case 'unsubscribe':
        if (message.channel) {
          client.subscriptions.delete(message.channel);
          this.sendMessage(ws, {
            type: 'unsubscribed',
            channel: message.channel,
            timestamp: new Date().toISOString(),
          });
        }
        break;

      default:
        appLogger.warn('Unknown message type', { module: 'WebSocketStabilizer', messageType: message.type });
    }
  }

  sendMessage(ws, message) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify(message));
      } catch (error) {
        appLogger.error('Failed to send WebSocket message', { module: 'WebSocketStabilizer', error: error.message });
      }
    }
  }

  sendError(ws, errorMessage) {
    this.sendMessage(ws, {
      type: 'error',
      message: errorMessage,
      timestamp: new Date().toISOString(),
    });
  }

  broadcast(message, channel = null) {
    const messageObj = {
      ...message,
      timestamp: new Date().toISOString(),
    };

    this.wss.clients.forEach(ws => {
      const client = this.clients.get(ws);
      if (client && ws.readyState === WebSocket.OPEN) {
        // Send to all clients or only subscribed ones
        if (!channel || client.subscriptions.has(channel)) {
          this.sendMessage(ws, messageObj);
        }
      }
    });
  }

  startHeartbeat() {
    this.heartbeatTimer = setInterval(() => {
      this.wss.clients.forEach(ws => {
        const client = this.clients.get(ws);
        if (client) {
          if (!client.isAlive) {
            appLogger.info('Terminating inactive client', { module: 'WebSocketStabilizer', clientId: client.id });
            ws.terminate();
            this.clients.delete(ws);
            return;
          }

          client.isAlive = false;
          ws.ping();
        }
      });
    }, this.heartbeatInterval);
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  generateClientId() {
    return 'client_' + Math.random().toString(36).substring(2, 15);
  }

  getStats() {
    return {
      totalClients: this.wss.clients.size,
      activeClients: Array.from(this.clients.values()).filter(c => c.isAlive)
        .length,
      channels: this.getActiveChannels(),
      uptime: process.uptime(),
    };
  }

  getActiveChannels() {
    const channels = new Set();
    this.clients.forEach(client => {
      client.subscriptions.forEach(channel => channels.add(channel));
    });
    return Array.from(channels);
  }

  close() {
    this.stopHeartbeat();
    this.wss.close();
  }
}

module.exports = WebSocketStabilizer;
