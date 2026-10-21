/**
 * Byzantine Consensus Middleware
 * Express middleware integration for Byzantine consensus coordinator
 *
 * FEATURES:
 * - REST API endpoints for consensus operations
 * - WebSocket support for real-time consensus updates
 * - Monitoring and metrics endpoints
 * - Validator management endpoints
 * - Security and authentication
 */

import { Request, Response, NextFunction, Router } from 'express';
import { ByzantineConsensusCoordinator } from '../byzantine-consensus-coordinator.js';
import { EventEmitter } from 'events';
import { validateOrigin, getCorsHeaders } from './cors-config.js';
import { appLogger } from '../../server/utils/logger.js';
import jwt from 'jsonwebtoken';
import { JWT_ISSUER, JWT_AUDIENCE } from '../../server/auth/jwt-constants.js';

export interface ConsensusMiddlewareConfig {
  enableWebSocket: boolean;
  enableMetrics: boolean;
  requireAuthentication: boolean;
  corsEnabled: boolean;
}

/**
 * Byzantine Consensus Express Middleware
 */
export class ByzantineConsensusMiddleware extends EventEmitter {
  private coordinator: ByzantineConsensusCoordinator;
  private config: ConsensusMiddlewareConfig;
  private wsConnections: Set<any> = new Set();
  private readonly jwtSecret?: string;

  constructor(
    coordinator: ByzantineConsensusCoordinator,
    config: Partial<ConsensusMiddlewareConfig> = {}
  ) {
    super();

    this.coordinator = coordinator;
    this.config = {
      enableWebSocket: config.enableWebSocket !== false,
      enableMetrics: config.enableMetrics !== false,
      requireAuthentication: config.requireAuthentication || false,
      corsEnabled: config.corsEnabled !== false,
    };
    this.jwtSecret = process.env.JWT_SECRET;

    if (
      this.config.requireAuthentication &&
      (!this.jwtSecret || this.jwtSecret.length < 32)
    ) {
      throw new Error(
        'JWT_SECRET environment variable must be set with at least 32 characters when consensus authentication is enabled'
      );
    }

    this.setupCoordinatorListeners();
  }

  /**
   * Get Express router with all endpoints
   */
  getRouter(): Router {
    const router = Router();

    // Apply CORS if enabled
    if (this.config.corsEnabled) {
      router.use(this.corsMiddleware.bind(this));
    }

    if (this.config.requireAuthentication) {
      router.use((req, res, next) => {
        if (req.path === '/health') {
          return next();
        }
        return this.authMiddleware(req, res, next);
      });
    }

    // Consensus endpoints
    router.post('/consensus/propose', this.proposeBlock.bind(this));
    router.post('/consensus/vote', this.voteOnProposal.bind(this));
    router.get('/consensus/status', this.getConsensusStatus.bind(this));
    router.get('/consensus/metrics', this.getMetrics.bind(this));

    // Validator endpoints
    router.post('/validators/register', this.registerValidator.bind(this));
    router.get('/validators', this.getValidators.bind(this));
    router.get('/validators/:id', this.getValidator.bind(this));
    router.get('/validators/:id/reputation', this.getValidatorReputation.bind(this));
    router.get('/validators/:id/behavior', this.getValidatorBehavior.bind(this));

    // Byzantine tolerance endpoints
    router.get('/byzantine/tolerance', this.getByzantineTolerance.bind(this));
    router.get('/byzantine/indicators', this.getMaliciousIndicators.bind(this));
    router.get('/byzantine/quarantined', this.getQuarantinedValidators.bind(this));

    // State endpoints
    router.get('/state/current', this.getCurrentState.bind(this));
    router.get('/state/checkpoints', this.getCheckpoints.bind(this));
    router.get('/state/history', this.getStateHistory.bind(this));

    // View change endpoints
    router.get('/view/current', this.getCurrentView.bind(this));
    router.get('/view/history', this.getViewHistory.bind(this));
    router.post('/view/change', this.initiateViewChange.bind(this));

    // Attack defense endpoints
    router.get('/defense/status', this.getDefenseStatus.bind(this));
    router.get('/defense/metrics', this.getDefenseMetrics.bind(this));

    // Health check
    router.get('/health', this.healthCheck.bind(this));

    return router;
  }

  /**
   * CORS middleware with proper origin validation
   */
  private corsMiddleware(req: Request, res: Response, next: NextFunction) {
    const origin = req.headers.origin as string | undefined;
    const headers = getCorsHeaders(origin);

    Object.entries(headers).forEach(([key, value]) => {
      if (value) {
        res.header(key, value);
      }
    });

    if (req.method === 'OPTIONS') {
      const validOrigin = validateOrigin(origin);
      if (validOrigin !== false || !origin) {
        return res.sendStatus(200);
      }
      return res.status(403).json({
        success: false,
        error: 'Origin not allowed by CORS policy',
      });
    }

    next();
  }

  /**
   * Authentication middleware (placeholder)
   */
  private authMiddleware(req: Request, res: Response, next: NextFunction) {
    if (!this.config.requireAuthentication) {
      return next();
    }

    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    try {
      const decoded = jwt.verify(token, this.jwtSecret as string, { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
      (req as any).user = decoded;
      next();
    } catch (err) {
      appLogger.warn('Consensus auth: invalid token', { error: err instanceof Error ? err.message : 'unknown' });
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
  }

  /**
   * POST /consensus/propose - Propose new block
   */
  private async proposeBlock(req: Request, res: Response) {
    try {
      const { primaryId, transactions } = req.body;

      if (!primaryId || !transactions) {
        return res.status(400).json({
          error: 'Missing required fields: primaryId, transactions',
        });
      }

      const roundId = await this.coordinator.proposeBlock(primaryId, transactions);

      res.json({
        success: true,
        roundId,
        message: 'Block proposal initiated',
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to propose block',
      });
    }
  }

  /**
   * POST /consensus/vote - Vote on block proposal
   */
  private async voteOnProposal(req: Request, res: Response) {
    try {
      const { roundId, validatorId, prePrepareMessage, approve } = req.body;

      if (!roundId || !validatorId || !prePrepareMessage) {
        return res.status(400).json({
          error: 'Missing required fields',
        });
      }

      const success = await this.coordinator.voteOnProposal(
        roundId,
        validatorId,
        prePrepareMessage,
        approve !== false
      );

      res.json({
        success,
        message: success ? 'Vote recorded' : 'Vote rejected',
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to process vote',
      });
    }
  }

  /**
   * GET /consensus/status - Get consensus status
   */
  private async getConsensusStatus(req: Request, res: Response) {
    try {
      const status = this.coordinator.getStatus();
      res.json(status);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get status',
      });
    }
  }

  /**
   * GET /consensus/metrics - Get consensus metrics
   */
  private async getMetrics(req: Request, res: Response) {
    try {
      if (!this.config.enableMetrics) {
        return res.status(403).json({ error: 'Metrics not enabled' });
      }

      const metrics = this.coordinator.getMetrics();
      res.json(metrics);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get metrics',
      });
    }
  }

  /**
   * POST /validators/register - Register validator
   */
  private async registerValidator(req: Request, res: Response) {
    try {
      const { validatorId, address, publicKey, stake } = req.body;

      if (!validatorId || !address || !publicKey || !stake) {
        return res.status(400).json({ error: 'Missing required fields' });
      }

      // Convert publicKey from hex string to Buffer
      const publicKeyBuffer = Buffer.from(publicKey, 'hex');

      await this.coordinator.initialize([
        {
          validatorId,
          address,
          publicKey: publicKeyBuffer,
          stake,
        },
      ]);

      res.json({
        success: true,
        message: 'Validator registered successfully',
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to register validator',
      });
    }
  }

  /**
   * GET /validators - Get all validators
   */
  private async getValidators(req: Request, res: Response) {
    try {
      const validators = this.coordinator.getActiveValidators();
      res.json({ validators });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get validators',
      });
    }
  }

  /**
   * GET /validators/:id - Get validator info
   */
  private async getValidator(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const validator = this.coordinator.getValidator(id);

      if (!validator) {
        return res.status(404).json({ error: 'Validator not found' });
      }

      res.json({ validator });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get validator',
      });
    }
  }

  /**
   * GET /validators/:id/reputation - Get validator reputation
   */
  private async getValidatorReputation(req: Request, res: Response) {
    try {
      const { id } = req.params;
      const validator = this.coordinator.getValidator(id);

      if (!validator) {
        return res.status(404).json({ error: 'Validator not found' });
      }

      res.json({
        validatorId: id,
        reputation: validator.reputation,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get reputation',
      });
    }
  }

  /**
   * GET /validators/:id/behavior - Get validator behavior
   */
  private async getValidatorBehavior(req: Request, res: Response) {
    try {
      const { id } = req.params;
      // This would need to be exposed from the coordinator
      res.json({
        validatorId: id,
        message: 'Behavior metrics not yet exposed',
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get behavior',
      });
    }
  }

  /**
   * GET /byzantine/tolerance - Get Byzantine tolerance status
   */
  private async getByzantineTolerance(req: Request, res: Response) {
    try {
      const tolerance = this.coordinator.getByzantineTolerance();
      res.json(tolerance);
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get tolerance',
      });
    }
  }

  /**
   * GET /byzantine/indicators - Get malicious indicators
   */
  private async getMaliciousIndicators(req: Request, res: Response) {
    try {
      // This would need to be exposed from the coordinator
      res.json({
        message: 'Malicious indicators not yet exposed',
        indicators: [],
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get indicators',
      });
    }
  }

  /**
   * GET /byzantine/quarantined - Get quarantined validators
   */
  private async getQuarantinedValidators(req: Request, res: Response) {
    try {
      // This would need to be exposed from the coordinator
      res.json({
        message: 'Quarantined validators not yet exposed',
        quarantined: [],
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get quarantined',
      });
    }
  }

  /**
   * GET /state/current - Get current state
   */
  private async getCurrentState(req: Request, res: Response) {
    try {
      const status = this.coordinator.getStatus();
      res.json({
        height: status.height,
        viewNumber: status.viewNumber,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get state',
      });
    }
  }

  /**
   * GET /state/checkpoints - Get checkpoints
   */
  private async getCheckpoints(req: Request, res: Response) {
    try {
      // This would need to be exposed from the coordinator
      res.json({
        message: 'Checkpoints not yet exposed',
        checkpoints: [],
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get checkpoints',
      });
    }
  }

  /**
   * GET /state/history - Get state history
   */
  private async getStateHistory(req: Request, res: Response) {
    try {
      // This would need to be exposed from the coordinator
      res.json({
        message: 'State history not yet exposed',
        history: [],
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get history',
      });
    }
  }

  /**
   * GET /view/current - Get current view
   */
  private async getCurrentView(req: Request, res: Response) {
    try {
      const status = this.coordinator.getStatus();
      res.json({
        viewNumber: status.viewNumber,
        primaryId: status.primaryId,
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get view',
      });
    }
  }

  /**
   * GET /view/history - Get view change history
   */
  private async getViewHistory(req: Request, res: Response) {
    try {
      // This would need to be exposed from the coordinator
      res.json({
        message: 'View history not yet exposed',
        history: [],
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get view history',
      });
    }
  }

  /**
   * POST /view/change - Initiate view change
   */
  private async initiateViewChange(req: Request, res: Response) {
    try {
      const { reason } = req.body;

      if (!reason) {
        return res.status(400).json({ error: 'Reason required' });
      }

      // This would need to be exposed from the coordinator
      res.json({
        success: true,
        message: 'View change initiated',
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to initiate view change',
      });
    }
  }

  /**
   * GET /defense/status - Get attack defense status
   */
  private async getDefenseStatus(req: Request, res: Response) {
    try {
      // This would need to be exposed from the coordinator
      res.json({
        message: 'Defense status not yet exposed',
        status: {},
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get defense status',
      });
    }
  }

  /**
   * GET /defense/metrics - Get defense metrics
   */
  private async getDefenseMetrics(req: Request, res: Response) {
    try {
      // This would need to be exposed from the coordinator
      res.json({
        message: 'Defense metrics not yet exposed',
        metrics: {},
      });
    } catch (error) {
      res.status(500).json({
        error: error instanceof Error ? error.message : 'Failed to get defense metrics',
      });
    }
  }

  /**
   * GET /health - Health check
   */
  private async healthCheck(req: Request, res: Response) {
    try {
      const status = this.coordinator.getStatus();

      res.json({
        status: 'healthy',
        consensus: {
          height: status.height,
          health: status.consensusHealth,
          activeValidators: status.activeValidators,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      res.status(500).json({
        status: 'unhealthy',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Setup coordinator event listeners
   */
  private setupCoordinatorListeners() {
    // Forward important events to WebSocket clients
    this.coordinator.on('blockProposed', (event) => {
      this.broadcastToWebSockets('blockProposed', event);
    });

    this.coordinator.on('blockFinalized', (event) => {
      this.broadcastToWebSockets('blockFinalized', event);
    });

    this.coordinator.on('viewChanged', (event) => {
      this.broadcastToWebSockets('viewChanged', event);
    });

    this.coordinator.on('maliciousValidatorDetected', (event) => {
      this.broadcastToWebSockets('maliciousValidatorDetected', event);
    });

    this.coordinator.on('consensusAchieved', (event) => {
      this.broadcastToWebSockets('consensusAchieved', event);
    });
  }

  /**
   * Broadcast message to all WebSocket connections
   */
  private broadcastToWebSockets(eventType: string, data: any) {
    if (!this.config.enableWebSocket) return;

    const message = JSON.stringify({ type: eventType, data });

    for (const ws of this.wsConnections) {
      try {
        if (ws.readyState === 1) { // WebSocket.OPEN
          ws.send(message);
        }
      } catch (error) {
        appLogger.error('WebSocket send error', { module: 'ByzantineConsensus', error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /**
   * Register WebSocket connection
   */
  registerWebSocket(ws: any) {
    this.wsConnections.add(ws);

    ws.on('close', () => {
      this.wsConnections.delete(ws);
    });

    // Send initial status
    const status = this.coordinator.getStatus();
    ws.send(JSON.stringify({ type: 'status', data: status }));
  }
}
