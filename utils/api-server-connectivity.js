/**
 * API Server Connectivity Manager for Wrfcoin Core
 * Handles server initialization, routing, and connection management
 */

const express = require('express');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const EventEmitter = require('events');
const { corsMiddleware } = require('../shared/middleware/cors-config.js');

class APIServerConnectivity extends EventEmitter {
  constructor(options = {}) {
    super();

    this.config = {
      port: options.port || 5000,
      host: options.host || '0.0.0.0',
      ssl: options.ssl || false,
      cors: options.cors !== false,
      compression: options.compression !== false,
      rateLimit: options.rateLimit !== false,
      healthCheck: options.healthCheck !== false,
      websocket: options.websocket !== false,
      timeout: options.timeout || 30000,
      keepAlive: options.keepAlive !== false,
      ...options,
    };

    this.app = express();
    this.server = null;
    this.wsServer = null;
    this.connections = new Set();
    this.isRunning = false;
    this.startTime = null;
    this.requestCount = 0;
    this.errorCount = 0;
  }

  // Initialize and start the API server
  async start() {
    try {
      await this.setupMiddleware();
      await this.setupRoutes();
      await this.setupWebSocket();
      await this.startServer();

      this.isRunning = true;
      this.startTime = new Date();

      this.emit('server:started', {
        port: this.config.port,
        host: this.config.host,
        ssl: this.config.ssl,
        timestamp: this.startTime,
      });

      console.log(
        `🚀 Wrfcoin API Server running on ${this.config.ssl ? 'https' : 'http'}://${this.config.host}:${this.config.port}`
      );

      return true;
    } catch (error) {
      this.emit('server:error', error);
      throw error;
    }
  }

  // Setup Express middleware
  async setupMiddleware() {
    // Request parsing
    this.app.use(express.json({ limit: '10mb' }));
    this.app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // CORS handling with proper origin validation
    if (this.config.cors) {
      this.app.use(corsMiddleware);
    }

    // Request logging and metrics
    this.app.use((req, res, next) => {
      this.requestCount++;
      const startTime = Date.now();

      req.requestId = `req_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      req.startTime = startTime;

      res.on('finish', () => {
        const duration = Date.now() - startTime;
        const logData = {
          requestId: req.requestId,
          method: req.method,
          url: req.url,
          status: res.statusCode,
          duration,
          userAgent: req.get('user-agent'),
          ip: req.ip || req.connection.remoteAddress,
        };

        this.emit('request:completed', logData);

        if (res.statusCode >= 400) {
          this.errorCount++;
          this.emit('request:error', logData);
        }
      });

      next();
    });

    // Request timeout handling
    this.app.use((req, res, next) => {
      res.setTimeout(this.config.timeout, () => {
        const error = new Error('Request timeout');
        error.code = 'REQUEST_TIMEOUT';
        next(error);
      });
      next();
    });
  }

  // Setup API routes
  async setupRoutes() {
    // Health check endpoints
    if (this.config.healthCheck) {
      this.app.get('/health', (req, res) => {
        res.json({
          status: 'healthy',
          uptime: this.getUptime(),
          timestamp: new Date().toISOString(),
          version: '1.0.0',
          requests: this.requestCount,
          errors: this.errorCount,
        });
      });

      this.app.get('/health/ready', (req, res) => {
        res.json({
          ready: this.isRunning,
          timestamp: new Date().toISOString(),
        });
      });

      this.app.get('/health/live', (req, res) => {
        res.json({
          alive: true,
          timestamp: new Date().toISOString(),
        });
      });
    }

    // API status endpoint
    this.app.get('/api/status', (req, res) => {
      res.json({
        server: 'Wrfcoin Core API',
        version: '1.0.0',
        status: 'operational',
        uptime: this.getUptime(),
        connections: this.connections.size,
        requests: this.requestCount,
        errors: this.errorCount,
        timestamp: new Date().toISOString(),
      });
    });

    // Blockchain endpoints
    this.app.get('/api/blockchain/info', (req, res) => {
      res.json({
        chainId: 'wrfcoin-mainnet',
        blockHeight: Math.floor(Math.random() * 1000000) + 5000000,
        networkHash: Math.floor(Math.random() * 1000000000000),
        difficulty: Math.floor(Math.random() * 1000000000),
        peers: Math.floor(Math.random() * 100) + 20,
        mempool: Math.floor(Math.random() * 5000) + 100,
        timestamp: new Date().toISOString(),
      });
    });

    this.app.get('/api/blockchain/blocks/latest', (req, res) => {
      res.json({
        height: Math.floor(Math.random() * 1000000) + 5000000,
        hash:
          '0x' +
          Array(64)
            .fill(0)
            .map(() => Math.floor(Math.random() * 16).toString(16))
            .join(''),
        timestamp: new Date().toISOString(),
        transactions: Math.floor(Math.random() * 100) + 10,
        size: Math.floor(Math.random() * 1000000) + 500000,
      });
    });

    // Network endpoints
    this.app.get('/api/network/peers', (req, res) => {
      const peers = [];
      for (let i = 0; i < Math.floor(Math.random() * 20) + 10; i++) {
        peers.push({
          id: `peer_${i}`,
          address: `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}:8333`,
          version: '1.0.0',
          lastSeen: new Date(
            Date.now() - Math.random() * 3600000
          ).toISOString(),
          latency: Math.floor(Math.random() * 200) + 10,
        });
      }
      res.json({ peers, count: peers.length });
    });

    // Mining endpoints
    this.app.get('/api/mining/stats', (req, res) => {
      res.json({
        hashRate: `${(Math.random() * 100 + 50).toFixed(2)} TH/s`,
        difficulty: Math.floor(Math.random() * 1000000000000),
        blockReward: 50,
        nextDifficultyAdjustment: Math.floor(Math.random() * 2016) + 100,
        estimatedTime: `${Math.floor(Math.random() * 14) + 1} days`,
        timestamp: new Date().toISOString(),
      });
    });

    // Environmental data endpoints
    this.app.get('/api/environmental/sensors', (req, res) => {
      const sensors = [];
      for (let i = 0; i < 10; i++) {
        sensors.push({
          id: `sensor_${i}`,
          type: ['temperature', 'humidity', 'air_quality', 'noise'][
            Math.floor(Math.random() * 4)
          ],
          location: {
            lat: (Math.random() * 180 - 90).toFixed(6),
            lng: (Math.random() * 360 - 180).toFixed(6),
          },
          value: (Math.random() * 100).toFixed(2),
          unit: 'unit',
          timestamp: new Date().toISOString(),
        });
      }
      res.json({ sensors, count: sensors.length });
    });

    // Cross-chain endpoints
    this.app.get('/api/bridges/status', (req, res) => {
      const bridges = [
        'ethereum',
        'polygon',
        'bsc',
        'avalanche',
        'arbitrum',
        'optimism',
        'fantom',
        'harmony',
        'xdai',
        'moonbeam',
      ].map(chain => ({
        chain,
        status: Math.random() > 0.1 ? 'operational' : 'maintenance',
        latency: Math.floor(Math.random() * 5000) + 1000,
        volume24h: Math.floor(Math.random() * 1000000) + 100000,
        lastUpdate: new Date().toISOString(),
      }));

      res.json({ bridges, timestamp: new Date().toISOString() });
    });

    // Error handling
    this.app.use((error, req, res, next) => {
      this.errorCount++;

      const errorResponse = {
        error: {
          message: error.message,
          code: error.code || 'INTERNAL_ERROR',
          requestId: req.requestId,
          timestamp: new Date().toISOString(),
        },
      };

      if (process.env.NODE_ENV === 'development') {
        errorResponse.error.stack = error.stack;
      }

      const statusCode = error.statusCode || error.status || 500;
      res.status(statusCode).json(errorResponse);

      this.emit('server:error', { error, req });
    });

    // 404 handler
    this.app.use((req, res) => {
      res.status(404).json({
        error: {
          message: 'Endpoint not found',
          code: 'NOT_FOUND',
          path: req.path,
          method: req.method,
          timestamp: new Date().toISOString(),
        },
      });
    });
  }

  // Setup WebSocket server
  async setupWebSocket() {
    if (!this.config.websocket) return;

    this.wsServer = new WebSocket.Server({
      noServer: true,
      perMessageDeflate: false,
    });

    this.wsServer.on('connection', (ws, req) => {
      const connectionId = `ws_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      ws.connectionId = connectionId;

      this.connections.add(ws);

      ws.on('close', () => {
        this.connections.delete(ws);
        this.emit('websocket:disconnected', { connectionId });
      });

      ws.on('message', message => {
        try {
          const data = JSON.parse(message);
          this.handleWebSocketMessage(ws, data);
        } catch (error) {
          ws.send(
            JSON.stringify({
              error: 'Invalid JSON message',
              timestamp: new Date().toISOString(),
            })
          );
        }
      });

      ws.send(
        JSON.stringify({
          type: 'connection',
          connectionId,
          timestamp: new Date().toISOString(),
        })
      );

      this.emit('websocket:connected', { connectionId, req });
    });
  }

  // Handle WebSocket messages
  handleWebSocketMessage(ws, data) {
    switch (data.type) {
      case 'subscribe':
        ws.subscription = data.channel;
        ws.send(
          JSON.stringify({
            type: 'subscribed',
            channel: data.channel,
            timestamp: new Date().toISOString(),
          })
        );
        break;

      case 'ping':
        ws.send(
          JSON.stringify({
            type: 'pong',
            timestamp: new Date().toISOString(),
          })
        );
        break;

      default:
        ws.send(
          JSON.stringify({
            type: 'error',
            message: 'Unknown message type',
            timestamp: new Date().toISOString(),
          })
        );
    }
  }

  // Start the HTTP/HTTPS server
  async startServer() {
    return new Promise((resolve, reject) => {
      if (this.config.ssl) {
        // For SSL, you would need certificates
        this.server = https.createServer(this.config.ssl, this.app);
      } else {
        this.server = http.createServer(this.app);
      }

      // Handle WebSocket upgrade
      if (this.config.websocket) {
        this.server.on('upgrade', (request, socket, head) => {
          this.wsServer.handleUpgrade(request, socket, head, ws => {
            this.wsServer.emit('connection', ws, request);
          });
        });
      }

      // Configure keep-alive
      if (this.config.keepAlive) {
        this.server.keepAliveTimeout = 65000;
        this.server.headersTimeout = 66000;
      }

      this.server.listen(this.config.port, this.config.host, error => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });

      this.server.on('error', error => {
        this.emit('server:error', error);
        reject(error);
      });
    });
  }

  // Broadcast to WebSocket clients
  broadcast(data, channel = null) {
    const message = JSON.stringify({
      ...data,
      timestamp: new Date().toISOString(),
    });

    this.connections.forEach(ws => {
      if (ws.readyState === WebSocket.OPEN) {
        if (!channel || ws.subscription === channel) {
          ws.send(message);
        }
      }
    });
  }

  // Stop the server
  async stop() {
    return new Promise(resolve => {
      this.isRunning = false;

      // Close WebSocket connections
      this.connections.forEach(ws => {
        ws.terminate();
      });
      this.connections.clear();

      // Close server
      if (this.server) {
        this.server.close(() => {
          this.emit('server:stopped', {
            timestamp: new Date().toISOString(),
          });
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  // Get server uptime
  getUptime() {
    if (!this.startTime) return 0;
    return Math.floor((Date.now() - this.startTime.getTime()) / 1000);
  }

  // Get server statistics
  getStats() {
    return {
      isRunning: this.isRunning,
      uptime: this.getUptime(),
      startTime: this.startTime,
      requests: this.requestCount,
      errors: this.errorCount,
      connections: this.connections.size,
      config: {
        port: this.config.port,
        host: this.config.host,
        ssl: this.config.ssl,
        websocket: this.config.websocket,
      },
    };
  }

  // Test connectivity
  async testConnectivity() {
    if (!this.isRunning) {
      throw new Error('Server is not running');
    }

    const testUrl = `http${this.config.ssl ? 's' : ''}://${this.config.host}:${this.config.port}/health`;

    try {
      const response = await fetch(testUrl);
      return {
        status: response.status,
        ok: response.ok,
        url: testUrl,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      throw new Error(`Connectivity test failed: ${error.message}`);
    }
  }
}

module.exports = APIServerConnectivity;
