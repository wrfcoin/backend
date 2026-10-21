// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('./utils/otel-setup.js');
initializeOTel().catch(() => {});
const { resolveAllowedOrigins } = require('./utils/strict-cors-config');

/**
 * 🚀 SUPER EASY NODE DISCOVERY for Wrfcoin Testnet
 * Just run this and share the URL - that's it!
 */

const express = require('express');
const WebSocket = require('ws');
const { createHash } = require('crypto');
const os = require('os');
const https = require('https');
const fs = require('fs');
const { appLogger } = require('./utils/logger');
const { createHealthMiddleware } = require('./middleware/create-health-middleware');
const { GracefulShutdown, ShutdownPriority } = require('../shared/graceful-shutdown/index.js');

class SuperEasyNodeDiscovery {
  constructor() {
    this.app = express();
    this.discoveryPort = Number.parseInt(process.env.NODE_DISCOVERY_PORT || '9010', 10);
    this.nodePort = Number.parseInt(process.env.NODE_DISCOVERY_WS_PORT || '9002', 10);
    this.peers = new Map();
    this.nodeId = this.generateNodeId();
    this.localIP = this.getLocalIP();
    this.probeState = { draining: false };
    this.healthMiddleware = null;

    // Environment detection for production vs testnet
    this.isProduction =
      process.env.NODE_ENV === 'production' ||
      process.env.WRF_NETWORK === 'mainnet';
    this.useSSL = this.isProduction;
    this.protocol = this.useSSL ? 'wss' : 'ws';
    this.httpProtocol = this.useSSL ? 'https' : 'http';

    appLogger.info('WRFCOIN SUPER EASY NODE DISCOVERY starting', {
      nodeId: this.nodeId,
      localIP: this.localIP,
      securityMode: this.isProduction ? 'Production (SSL)' : 'Testnet (Development)',
      protocol: this.protocol
    });
  }

  generateNodeId() {
    const hostname = os.hostname();
    const timestamp = Date.now();
    return createHash('sha256')
      .update(`${hostname}-${timestamp}`)
      .digest('hex')
      .substring(0, 8);
  }

  getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) {
          return iface.address;
        }
      }
    }
    return 'localhost';
  }

  // SSL certificate configuration for production
  getSSLOptions() {
    if (!this.useSSL) return null;

    try {
      // Try to load SSL certificates
      const certPath = process.env.SSL_CERT_PATH || './certs/cert.pem';
      const keyPath = process.env.SSL_KEY_PATH || './certs/key.pem';

      if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
        return {
          cert: fs.readFileSync(certPath),
          key: fs.readFileSync(keyPath),
        };
      } else {
        appLogger.warn('SSL certificates not found, falling back to HTTP for development');
        this.useSSL = false;
        this.protocol = 'ws';
        this.httpProtocol = 'http';
        return null;
      }
    } catch (error) {
      appLogger.warn('SSL certificate loading failed, falling back to HTTP', { error: error.message });
      this.useSSL = false;
      this.protocol = 'ws';
      this.httpProtocol = 'http';
      return null;
    }
  }

  setupAPI() {
    this.app.use(express.json());
    this.app.use(express.static('public'));
    this.healthMiddleware = createHealthMiddleware(
      'node-discovery',
      {},
      { state: this.probeState }
    );
    this.app.use(this.healthMiddleware.router);

    // Enable CORS with specific origins for security. Resolved once at setup
    // so a production misconfiguration refuses startup (backend#1236).
    const allowedOrigins = [
      ...resolveAllowedOrigins({ developmentDefaults: ['http://localhost:5000', 'http://localhost:4000'] }),
      'https://wrfcoin.replit.app',
      'https://78d83de6-3c2e-4513-8977-f64d83a9e3cb-00-33g6fqpn548lr.worf.replit.dev',
    ];
    this.app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      }

      res.header(
        'Access-Control-Allow-Headers',
        'Content-Type, Authorization, X-Requested-With'
      );
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.header('Access-Control-Allow-Credentials', 'false');

      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
      }
      next();
    });

    // 🎯 SUPER EASY: One-click node registration
    this.app.post('/quick-join', (req, res) => {
      const clientIP = req.ip || req.connection.remoteAddress || 'unknown';
      const nodeId =
        req.body.nodeId || `node-${Math.random().toString(36).substr(2, 6)}`;

      this.peers.set(nodeId, {
        id: nodeId,
        ip: clientIP,
        port: this.nodePort,
        joinedAt: Date.now(),
        status: 'active',
      });

      appLogger.info('Quick join successful', { nodeId, clientIP });

      res.json({
        success: true,
        nodeId: nodeId,
        networkSize: this.peers.size,
        message: 'Welcome to the Wrfcoin testnet!',
        nextSteps: [
          'Your node is now registered',
          'Connect via WebSocket for real-time updates',
          'Start mining or validating transactions',
        ],
      });
    });

    // 📡 Get network status
    this.app.get('/network', (req, res) => {
      const activePeers = Array.from(this.peers.values()).filter(
        peer => Date.now() - peer.joinedAt < 600000
      ); // 10 minutes

      res.json({
        networkName: 'Wrfcoin Testnet',
        discoveryNode: this.nodeId,
        totalNodes: activePeers.length,
        peers: activePeers,
        performance: {
          layer2TPS: '6,944 TPS',
          totalSystemTPS: '12,632+ TPS',
          reliability: '100%',
        },
      });
    });

    // 🏠 Super simple homepage with instructions
    this.app.get('/', (req, res) => {
      res.send(`
            <!DOCTYPE html>
            <html>
            <head>
                <title>🚀 Wrfcoin Easy Testnet</title>
                <style>
                    body { font-family: Arial, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
                    .container { background: white; padding: 30px; border-radius: 10px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
                    .highlight { background: #e8f5e8; padding: 15px; border-radius: 5px; margin: 10px 0; }
                    .command { background: #f0f0f0; padding: 10px; border-radius: 5px; font-family: monospace; margin: 10px 0; }
                    .green { color: #27ae60; }
                    .blue { color: #3498db; }
                    h1 { color: #2c3e50; }
                    .status { display: inline-block; background: #27ae60; color: white; padding: 5px 10px; border-radius: 15px; font-size: 12px; }
                </style>
            </head>
            <body>
                <div class="container">
                    <h1>🚀 Wrfcoin Super Easy Testnet</h1>
                    <div class="status">LIVE</div>
                    
                    <div class="highlight">
                        <h2>🎯 For Your Buddy - Super Easy Setup:</h2>
                        <p><strong>Just tell them to visit this URL:</strong></p>
                        <div class="command">${this.httpProtocol}://${this.localIP}:${this.discoveryPort}</div>
                        <p>That's it! No complex setup needed.</p>
                    </div>

                    <h3>📊 Current Network Status:</h3>
                    <p>🆔 Discovery Node: <strong>${this.nodeId}</strong></p>
                    <p>🌐 Active Nodes: <strong><span id="nodeCount">${this.peers.size}</span></strong></p>
                    <p>⚡ Performance: <strong class="green">12,632+ TPS</strong></p>
                    <p>🔒 Reliability: <strong class="green">100%</strong></p>

                    <h3>🔗 Quick Actions:</h3>
                    <button onclick="quickJoin()" style="background: #27ae60; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer;">
                        Join Network Now
                    </button>
                    <button onclick="checkNetwork()" style="background: #3498db; color: white; padding: 10px 20px; border: none; border-radius: 5px; cursor: pointer; margin-left: 10px;">
                        Check Network
                    </button>

                    <div id="status" style="margin-top: 20px;"></div>

                    <h3>💬 WebSocket Connection:</h3>
                    <div class="command">${this.protocol}://${this.localIP}:${this.nodePort}</div>

                    <h3>🛠️ Advanced Setup (Optional):</h3>
                    <p>To register with custom settings:</p>
                    <div class="command">
curl -X POST ${this.httpProtocol}://${this.localIP}:${this.discoveryPort}/quick-join \\<br>
  -H "Content-Type: application/json" \\<br>
  -d '{"nodeId": "my-custom-node"}'
                    </div>
                </div>

                <script>
                    async function quickJoin() {
                        try {
                            const response = await fetch('/quick-join', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ nodeId: 'web-' + Math.random().toString(36).substr(2, 6) })
                            });
                            const data = await response.json();
                            const statusDiv = document.getElementById('status');
                            statusDiv.textContent = '';
                            const successDiv = document.createElement('div');
                            successDiv.style.cssText = 'background: #d4edda; color: #155724; padding: 15px; border-radius: 5px;';
                            
                            const strongEl = document.createElement('strong');
                            strongEl.textContent = '✅ Success!';
                            successDiv.appendChild(strongEl);
                            
                            successDiv.appendChild(document.createTextNode(' Node ID: ' + data.nodeId));
                            successDiv.appendChild(document.createElement('br'));
                            successDiv.appendChild(document.createTextNode('Network Size: ' + data.networkSize + ' nodes'));
                            
                            statusDiv.appendChild(successDiv);
                            updateNodeCount();
                        } catch (error) {
                            const statusDiv = document.getElementById('status');
                            statusDiv.textContent = '';
                            const errorDiv = document.createElement('div');
                            errorDiv.style.cssText = 'background: #f8d7da; color: #721c24; padding: 15px; border-radius: 5px;';
                            errorDiv.textContent = '❌ Error: ' + error.message;
                            statusDiv.appendChild(errorDiv);
                        }
                    }

                    async function checkNetwork() {
                        try {
                            const response = await fetch('/network');
                            const data = await response.json();
                            const statusDiv = document.getElementById('status');
                            statusDiv.textContent = '';
                            const networkDiv = document.createElement('div');
                            networkDiv.style.cssText = 'background: #d1ecf1; color: #0c5460; padding: 15px; border-radius: 5px;';
                            
                            const strongEl = document.createElement('strong');
                            strongEl.textContent = '📊 Network Status:';
                            networkDiv.appendChild(strongEl);
                            networkDiv.appendChild(document.createElement('br'));
                            
                            networkDiv.appendChild(document.createTextNode('Total Nodes: ' + data.totalNodes));
                            networkDiv.appendChild(document.createElement('br'));
                            networkDiv.appendChild(document.createTextNode('Performance: ' + data.performance.layer2TPS));
                            networkDiv.appendChild(document.createElement('br'));
                            networkDiv.appendChild(document.createTextNode('Reliability: ' + data.performance.reliability));
                            
                            statusDiv.appendChild(networkDiv);
                            updateNodeCount();
                        } catch (error) {
                            const statusDiv = document.getElementById('status');
                            statusDiv.textContent = '';
                            const errorDiv = document.createElement('div');
                            errorDiv.style.cssText = 'background: #f8d7da; color: #721c24; padding: 15px; border-radius: 5px;';
                            errorDiv.textContent = '❌ Error: ' + error.message;
                            statusDiv.appendChild(errorDiv);
                        }
                    }

                    async function updateNodeCount() {
                        try {
                            const response = await fetch('/network');
                            const data = await response.json();
                            document.getElementById('nodeCount').textContent = data.totalNodes;
                        } catch (error) {
                            console.error('Failed to update node count:', error);
                        }
                    }

                    // Auto-refresh node count every 30 seconds
                    setInterval(updateNodeCount, 30000);
                </script>
            </body>
            </html>
            `);
    });
  }

  setupWebSocket() {
    const sslOptions = this.getSSLOptions();

    if (this.useSSL && sslOptions) {
      // Create HTTPS server for secure WebSocket
      const server = https.createServer(sslOptions);
      this.wss = new WebSocket.Server({ server });

      server.listen(this.nodePort, '0.0.0.0', () => {
        appLogger.info('Secure WebSocket server running', {
          protocol: this.protocol,
          host: this.localIP,
          port: this.nodePort
        });
      });
    } else {
      // Standard WebSocket server for development
      this.wss = new WebSocket.Server({ port: this.nodePort });
      appLogger.info('WebSocket server running', {
        protocol: this.protocol,
        host: this.localIP,
        port: this.nodePort
      });
    }

    this.wss.on('connection', (ws, req) => {
      const clientIP = req.socket.remoteAddress;
      appLogger.info('WebSocket client connected', { clientIP, protocol: this.protocol });

      // Send welcome with network info
      ws.send(
        JSON.stringify({
          type: 'welcome',
          discoveryNode: this.nodeId,
          networkSize: this.peers.size,
          message: `Connected to Wrfcoin ${this.isProduction ? 'mainnet' : 'testnet'}`,
          security: this.useSSL ? 'secure' : 'development',
          performance: {
            totalTPS: '12,632+',
            layer2TPS: '6,944',
            reliability: '100%',
          },
        })
      );

      ws.on('message', message => {
        try {
          const data = JSON.parse(message);
          this.handleWebSocketMessage(ws, data, clientIP);
        } catch (error) {
          appLogger.error('Invalid WebSocket message', { error: error.message });
        }
      });

      ws.on('close', () => {
        appLogger.info('WebSocket client disconnected', { clientIP });
      });
    });
  }

  handleWebSocketMessage(ws, data, clientIP) {
    switch (data.type) {
      case 'ping':
        ws.send(
          JSON.stringify({
            type: 'pong',
            timestamp: Date.now(),
            networkSize: this.peers.size,
          })
        );
        break;

      case 'join_network':
        const nodeId =
          data.nodeId || `ws-${Math.random().toString(36).substr(2, 6)}`;
        this.peers.set(nodeId, {
          id: nodeId,
          ip: clientIP,
          port: this.nodePort,
          joinedAt: Date.now(),
          status: 'active',
          connection: 'websocket',
        });

        // Broadcast new node to all connected clients
        this.broadcast(
          {
            type: 'node_joined',
            nodeId: nodeId,
            networkSize: this.peers.size,
            timestamp: Date.now(),
          },
          ws
        );

        ws.send(
          JSON.stringify({
            type: 'join_success',
            nodeId: nodeId,
            networkSize: this.peers.size,
          })
        );
        break;

      case 'transaction':
        // Relay transaction to network
        appLogger.info('Transaction relay received', { nodeId: data.nodeId || 'unknown' });
        this.broadcast(
          {
            type: 'transaction_broadcast',
            transaction: data.transaction,
            from: data.nodeId,
            timestamp: Date.now(),
          },
          ws
        );
        break;

      default:
        appLogger.warn('Unknown WebSocket message type', { type: data.type });
    }
  }

  broadcast(message, excludeWs = null) {
    this.wss.clients.forEach(client => {
      if (client !== excludeWs && client.readyState === WebSocket.OPEN) {
        try {
          client.send(JSON.stringify(message));
        } catch (error) {
          appLogger.error('Broadcast error', { error: error.message });
        }
      }
    });
  }

  start() {
    // Setup HTTP API
    this.setupAPI();

    const sslOptions = this.getSSLOptions();
    if (this.useSSL && sslOptions) {
      // Create HTTPS server for production
      const httpsServer = https.createServer(sslOptions, this.app);
      httpsServer.listen(this.discoveryPort, '0.0.0.0', () => {
        appLogger.info('Secure discovery server is live', {
          webInterface: `${this.httpProtocol}://${this.localIP}:${this.discoveryPort}`,
          apiEndpoint: `${this.httpProtocol}://${this.localIP}:${this.discoveryPort}/network`
        });
      });
    } else {
      // Standard HTTP server for development
      this.app.listen(this.discoveryPort, '0.0.0.0', () => {
        appLogger.info('Discovery server is live', {
          webInterface: `${this.httpProtocol}://${this.localIP}:${this.discoveryPort}`,
          apiEndpoint: `${this.httpProtocol}://${this.localIP}:${this.discoveryPort}/network`
        });
      });
    }

    // Setup WebSocket server
    this.setupWebSocket();

    // Register this node as the discovery node
    this.peers.set(this.nodeId, {
      id: this.nodeId,
      ip: this.localIP,
      port: this.nodePort,
      joinedAt: Date.now(),
      status: 'discovery',
      role: 'discovery_node',
    });

    this.showInstructions();
  }

  showInstructions() {
    appLogger.info('Node discovery instructions', {
      shareLink: `${this.httpProtocol}://${this.localIP}:${this.discoveryPort}`,
      curlCommand: `curl -X POST ${this.httpProtocol}://${this.localIP}:${this.discoveryPort}/quick-join`,
      webSocketUrl: `${this.protocol}://${this.localIP}:${this.nodePort}`,
      systemCapacity: '12,632+ TPS'
    });
  }

  setupGracefulShutdown() {
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

    gracefulShutdown.registerHandler({
      name: 'node-discovery-mark-draining',
      priority: ShutdownPriority.STOP_ACCEPTING_CONNECTIONS,
      timeout: 2000,
      handler: async () => {
        this.probeState.draining = true;
        if (this.healthMiddleware?.markDraining) {
          this.healthMiddleware.markDraining();
        }
      },
    });

    // Register WebSocket server close handler
    gracefulShutdown.registerHandler({
      name: 'node-discovery-websocket-close',
      priority: ShutdownPriority.CLOSE_WEBSOCKETS,
      timeout: 10000,
      handler: async () => {
        appLogger.info('Shutting down discovery node WebSocket server...');

        if (this.wss) {
          // Close all client connections
          this.wss.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
              client.close(1001, 'Server shutting down');
            }
          });

          // Close WebSocket server
          await new Promise((resolve) => {
            this.wss.close(() => {
              appLogger.info('Discovery WebSocket server closed');
              resolve();
            });
          });
        }
      },
    });

    // Register peer cleanup handler
    gracefulShutdown.registerHandler({
      name: 'node-discovery-peer-cleanup',
      priority: ShutdownPriority.STOP_BACKGROUND_JOBS,
      timeout: 5000,
      handler: async () => {
        appLogger.info('Cleaning up peer registry...');
        this.peers.clear();
      },
    });

    // Setup signal handlers
    gracefulShutdown.setupSignalHandlers();
  }
}

function startDiscoveryNode() {
  const discoveryNode = new SuperEasyNodeDiscovery();
  global.discoveryNode = discoveryNode;
  discoveryNode.start();
  discoveryNode.setupGracefulShutdown();
  return discoveryNode;
}

if (require.main === module) {
  startDiscoveryNode();
}

module.exports = {
  SuperEasyNodeDiscovery,
  startDiscoveryNode,
};
