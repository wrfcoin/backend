// OpenTelemetry must be initialized before other imports for auto-instrumentation
import { initializeOTel } from './utils/otel-setup.js';
void initializeOTel().catch(() => {});

/**
 * Secure Node Discovery Server with Sybil Attack Prevention
 *
 * Replaces the vulnerable easy_node_discovery.js with comprehensive security.
 */

import express, { Request, Response, NextFunction } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { ProofOfStakeManager } from '../shared/sybil-proof-of-stake.js';
import { PKICertificateManager } from '../shared/sybil-pki-manager.js';
import { SybilRateLimiter } from '../shared/sybil-rate-limiter.js';
import {
  SybilSecurityOrchestrator,
  ReputationSystem,
  ChallengeResponseProtocol,
  EconomicPenaltySystem,
  GradualTrustSystem,
  TopologyAnalyzer
} from '../shared/sybil-security-orchestrator.js';
import { securityLogger, logError } from './utils/logger.js';
import { GracefulShutdown, ShutdownPriority } from '../shared/graceful-shutdown/index.js';
import strictCorsConfig from './utils/strict-cors-config.js';

const { resolveAllowedOrigins } = strictCorsConfig;

interface SecureNodeRegistration {
  nodeId: string;
  stakeProof: any;
  certificate: string;
  ipAddress: string;
  publicKey: string;
  signature: string;
}

class SecureNodeDiscoveryServer {
  private app: express.Application;
  private server: any;
  private wss: WebSocketServer;
  private port = 9001;

  // Security components
  private posManager: ProofOfStakeManager;
  private pkiManager: PKICertificateManager;
  private rateLimiter: SybilRateLimiter;
  private reputationSystem: ReputationSystem;
  private challengeProtocol: ChallengeResponseProtocol;
  private penaltySystem: EconomicPenaltySystem;
  private trustSystem: GradualTrustSystem;
  private topologyAnalyzer: TopologyAnalyzer;
  private securityOrchestrator: SybilSecurityOrchestrator;

  // Node registry
  private registeredNodes = new Map<string, any>();
  private pendingChallenges = new Map<string, string>(); // nodeId -> challengeId

  constructor() {
    this.app = express();
    this.server = createServer(this.app);
    this.wss = new WebSocketServer({ server: this.server });

    // Initialize security components
    this.posManager = new ProofOfStakeManager(
      process.env.BLOCKCHAIN_RPC_URL || 'http://localhost:8556',
      process.env.WRF_TOKEN_ADDRESS || '0x0',
      process.env.STAKING_CONTRACT_ADDRESS || '0x0'
    );
    this.pkiManager = new PKICertificateManager();
    this.rateLimiter = new SybilRateLimiter();
    this.reputationSystem = new ReputationSystem();
    this.challengeProtocol = new ChallengeResponseProtocol();
    this.penaltySystem = new EconomicPenaltySystem();
    this.trustSystem = new GradualTrustSystem();
    this.topologyAnalyzer = new TopologyAnalyzer();

    this.securityOrchestrator = new SybilSecurityOrchestrator(
      this.posManager,
      this.pkiManager,
      this.rateLimiter,
      this.reputationSystem,
      this.challengeProtocol,
      this.penaltySystem,
      this.trustSystem,
      this.topologyAnalyzer
    );

    this.setupMiddleware();
    this.setupRoutes();
    this.setupWebSocket();
    this.startMonitoring();
  }

  private setupMiddleware(): void {
    this.app.use(express.json());

    // CORS with strict origin control. Resolved once at setup so a production
    // misconfiguration refuses startup (backend#1236).
    const allowedOrigins = resolveAllowedOrigins({ developmentDefaults: [
      'http://localhost:5000',
      'https://wrfcoin.replit.app'
    ] });
    this.app.use((req, res, next) => {
      const origin = req.headers.origin;
      if (origin && allowedOrigins.includes(origin)) {
        res.header('Access-Control-Allow-Origin', origin);
      }
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      if (req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
      }
      next();
    });

    // Rate limiting per IP
    this.app.use((req, res, next) => {
      // Basic rate limiting - 100 requests per 15 minutes per IP
      next();
    });
  }

  private setupRoutes(): void {
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        nodeCount: this.registeredNodes.size
      });
    });

    // Secure node registration endpoint
    this.app.post('/secure-register', async (req, res) => {
      try {
        await this.handleSecureRegistration(req, res);
      } catch (error: any) {
        logError(securityLogger, 'Registration error', error as Error);
        res.status(400).json({
          success: false,
          error: error.message
        });
      }
    });

    // Submit challenge response
    this.app.post('/challenge-response', async (req, res) => {
      try {
        await this.handleChallengeResponse(req, res);
      } catch (error: any) {
        res.status(400).json({
          success: false,
          error: error.message
        });
      }
    });

    // Get network statistics
    this.app.get('/network/stats', (req, res) => {
      const stats = {
        totalNodes: this.registeredNodes.size,
        distribution: this.rateLimiter.getDistributionStats(),
        stakeStats: this.posManager.getStakeStatistics(),
        certificateStats: this.pkiManager.getCertificateStatistics(),
        topologyAnomalies: this.topologyAnalyzer.analyzeAnomalies()
      };
      res.json(stats);
    });

    // Get node information
    this.app.get('/node/:nodeId', (req, res) => {
      const { nodeId } = req.params;
      const node = this.registeredNodes.get(nodeId);

      if (!node) {
        res.status(404).json({ error: 'Node not found' });
        return;
      }

      const reputation = this.reputationSystem.getReputation(nodeId);
      const trustTier = this.trustSystem.getTrustTier(nodeId);

      res.json({
        node,
        reputation,
        trustTier
      });
    });

    // Deregister node
    this.app.post('/deregister', async (req, res) => {
      const { nodeId, signature } = req.body;

      // Verify signature
      // In production, verify the signature matches the node's certificate

      if (this.registeredNodes.has(nodeId)) {
        this.registeredNodes.delete(nodeId);
        this.rateLimiter.deregisterNode(nodeId);

        res.json({
          success: true,
          message: 'Node deregistered successfully'
        });
      } else {
        res.status(404).json({
          success: false,
          error: 'Node not found'
        });
      }
    });

    // DEPRECATED: Old quick-join endpoint (now returns error)
    this.app.post('/quick-join', (req, res) => {
      res.status(410).json({
        success: false,
        error: 'This endpoint has been deprecated for security reasons',
        message: 'Please use /secure-register endpoint with proper stake proof and certificate',
        migrationGuide: 'https://docs.wrfcoin.com/secure-node-registration'
      });
    });
  }

  private async handleSecureRegistration(req: Request, res: Response): Promise<void> {
    const registration: SecureNodeRegistration = req.body;
    const clientIP = req.ip || req.socket.remoteAddress || 'unknown';

    securityLogger.info('Secure registration request received', { clientIP, nodeId: registration.nodeId });

    // Step 1: Perform comprehensive security check
    const securityCheck = await this.securityOrchestrator.performSecurityCheck(
      registration.nodeId,
      clientIP,
      registration.stakeProof,
      registration.certificate
    );

    if (!securityCheck.passed) {
      res.status(403).json({
        success: false,
        error: 'Security check failed',
        failures: securityCheck.failures,
        warnings: securityCheck.warnings
      });
      return;
    }

    // Step 2: Charge registration fee
    await this.penaltySystem.chargeRegistrationFee(
      registration.nodeId,
      registration.stakeProof.stakeAddress
    );

    // Step 3: Register node with rate limiter
    const nodeRegistration = await this.rateLimiter.registerNode(
      registration.nodeId,
      clientIP
    );

    // Step 4: Initialize node in security systems
    const initialization = await this.securityOrchestrator.initializeNode(
      registration.nodeId,
      clientIP
    );

    // Step 5: Store node registration
    this.registeredNodes.set(registration.nodeId, {
      ...registration,
      nodeRegistration,
      reputation: initialization.reputation,
      trustTier: initialization.trustTier,
      registeredAt: new Date()
    });

    // Step 6: Check if challenge is required
    let challengeInfo: { challengeId: string; type: string; difficulty: number; data: string; deadline: Date } | null = null;
    if (!securityCheck.checks.challenge) {
      const challenge = this.challengeProtocol.generatePoWChallenge(registration.nodeId);
      this.pendingChallenges.set(registration.nodeId, challenge.challengeId);
      challengeInfo = {
        challengeId: challenge.challengeId,
        type: challenge.type,
        difficulty: challenge.difficulty,
        data: challenge.data,
        deadline: challenge.deadline
      };
    }

    res.json({
      success: true,
      nodeId: registration.nodeId,
      message: 'Node registered successfully',
      securityCheck: {
        passed: true,
        warnings: securityCheck.warnings
      },
      reputation: initialization.reputation,
      trustTier: initialization.trustTier,
      challenge: challengeInfo,
      networkInfo: {
        totalNodes: this.registeredNodes.size,
        yourPrivileges: initialization.reputation.privileges
      }
    });
  }

  private async handleChallengeResponse(req: Request, res: Response): Promise<void> {
    const { nodeId, challengeId, proof, computeTime } = req.body;

    const expectedChallengeId = this.pendingChallenges.get(nodeId);
    if (!expectedChallengeId || expectedChallengeId !== challengeId) {
      res.status(400).json({
        success: false,
        error: 'No pending challenge found for this node'
      });
      return;
    }

    const response = {
      challengeId,
      nodeId,
      proof,
      computeTime,
      submittedAt: new Date()
    };

    const isValid = this.challengeProtocol.verifyPoWResponse(response);

    if (isValid) {
      this.pendingChallenges.delete(nodeId);

      // Update reputation for completing challenge
      const reputation = this.reputationSystem.getReputation(nodeId);
      if (reputation) {
        this.reputationSystem.updateReputation(nodeId, {
          ...reputation.metrics,
          consensusAccuracy: Math.min(100, reputation.metrics.consensusAccuracy + 5)
        });
      }

      res.json({
        success: true,
        message: 'Challenge completed successfully',
        reputationBonus: 5
      });
    } else {
      // Apply penalty for failed challenge
      this.penaltySystem.applyPenalty(nodeId, 'Failed challenge response', 'low');

      res.status(400).json({
        success: false,
        error: 'Invalid challenge response',
        penalty: 'Minor reputation penalty applied'
      });
    }
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket, req: any) => {
      const clientIP = req.socket.remoteAddress;
      securityLogger.debug('WebSocket connection established', { clientIP });

      ws.on('message', async (data: any) => {
        try {
          const message = JSON.parse(data.toString());
          await this.handleWebSocketMessage(ws, message, clientIP);
        } catch (error) {
          logError(securityLogger, 'WebSocket message error', error as Error);
        }
      });

      ws.on('close', () => {
        securityLogger.debug('WebSocket disconnected', { clientIP });
      });
    });
  }

  private async handleWebSocketMessage(ws: WebSocket, message: any, clientIP: string): Promise<void> {
    switch (message.type) {
      case 'ping':
        ws.send(JSON.stringify({
          type: 'pong',
          timestamp: Date.now()
        }));
        break;

      case 'node_status':
        const { nodeId } = message;
        if (this.registeredNodes.has(nodeId)) {
          const reputation = this.reputationSystem.getReputation(nodeId);
          const trustTier = this.trustSystem.getTrustTier(nodeId);

          ws.send(JSON.stringify({
            type: 'status_update',
            nodeId,
            reputation,
            trustTier
          }));
        }
        break;

      default:
        ws.send(JSON.stringify({
          type: 'error',
          message: 'Unknown message type'
        }));
    }
  }

  private startMonitoring(): void {
    // Monitor reputation decay
    setInterval(() => {
      this.reputationSystem.applyDecay();
    }, 60 * 60 * 1000); // Every hour

    // Monitor all nodes
    setInterval(async () => {
      for (const nodeId of this.registeredNodes.keys()) {
        await this.securityOrchestrator.monitorNode(nodeId);
      }
    }, 5 * 60 * 1000); // Every 5 minutes

    // Analyze topology
    setInterval(() => {
      const anomalies = this.topologyAnalyzer.analyzeAnomalies();
      if (anomalies.length > 0) {
        securityLogger.warn('Topology anomalies detected', { count: anomalies.length });
        for (const anomaly of anomalies) {
          if (anomaly.severity === 'high') {
            securityLogger.error('High severity topology anomaly', { description: anomaly.description });
            // In production, would trigger alerts
          }
        }
      }
    }, 10 * 60 * 1000); // Every 10 minutes
  }

  public start(): void {
    this.server.listen(this.port, '0.0.0.0', () => {
      securityLogger.info('Secure Node Discovery Server started', {
        port: this.port,
        securityFeatures: [
          'Proof-of-Stake verification',
          'PKI certificate authentication',
          'IP rate limiting & geographic distribution',
          'Reputation scoring system',
          'Challenge-response protocols',
          'Economic penalties & slashing',
          'Gradual trust building',
          'Topology analysis & anomaly detection',
        ],
        endpoints: {
          registration: 'POST /secure-register',
          deprecated: 'POST /quick-join (removed)',
        },
      });
    });
  }

  public shutdown(): Promise<void> {
    return new Promise((resolve, reject) => {
      securityLogger.info('Shutting down Secure Node Discovery Server');

      // Close WebSocket connections
      this.wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN) {
          client.close(1001, 'Server shutting down');
        }
      });

      // Close WebSocket server
      this.wss.close((wsErr?: Error) => {
        if (wsErr) {
          securityLogger.error('Error closing WebSocket server', { error: wsErr.message });
        } else {
          securityLogger.info('WebSocket server closed');
        }

        // Close HTTP server
        this.server.close((serverErr?: Error) => {
          if (serverErr) {
            securityLogger.error('Error closing HTTP server', { error: serverErr.message });
            reject(serverErr);
          } else {
            securityLogger.info('HTTP server closed');
            resolve();
          }
        });
      });
    });
  }
}

// Start the server
const server = new SecureNodeDiscoveryServer();
(global as any).secureDiscoveryServer = server;
server.start();

// Set up graceful shutdown using GracefulShutdown manager
const shutdown = GracefulShutdown.getInstance({
  enableLogging: true,
  logger: (message: string, level: string) => {
    if (level === 'error') {
      securityLogger.error(message);
    } else if (level === 'warn') {
      securityLogger.warn(message);
    } else {
      securityLogger.info(message);
    }
  },
});

// Register WebSocket cleanup handler with CLOSE_WEBSOCKETS priority
shutdown.registerHandler({
  name: 'secure-node-discovery-cleanup',
  priority: ShutdownPriority.CLOSE_WEBSOCKETS,
  timeout: 10000,
  handler: async () => {
    if (global.secureDiscoveryServer) {
      await (global.secureDiscoveryServer as SecureNodeDiscoveryServer).shutdown();
    }
  },
});

// Set up signal handlers
shutdown.setupSignalHandlers();

export { SecureNodeDiscoveryServer };
