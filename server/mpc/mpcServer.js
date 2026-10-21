// OpenTelemetry must be initialized before other imports for auto-instrumentation
const { initializeOTel } = require('../utils/otel-setup.js');
initializeOTel().catch(() => {});

/**
 * Wrfcoin Multi-Party Computation (MPC) Server
 *
 * This server implements secure multi-party computation protocols for
 * distributed cryptographic operations in the Wrfcoin network.
 *
 * The MPC server enables:
 * - Threshold signing for transaction validation
 * - Zero-knowledge proofs for privacy-preserving operations
 * - Secure computation for consensus protocols
 * - Key management for network validators
 */

const express = require('express');
const bodyParser = require('body-parser');
const { randomBytes, createHash } = require('crypto');
const http = require('http');
const WebSocket = require('ws');

// MPC protocols implementation
const mpcProtocols = require('./protocols');
const keyManagement = require('./keyManagement');
const sessionManager = require('./sessionManager');
const verifier = require('./verifier');
const { logger } = require('../utils/logger');

class MPCServer {
  constructor(config = {}) {
    this.config = {
      port: process.env.MPC_PORT || 5004,
      enableThresholdSigning: true,
      enableZKP: true,
      minParties: 3,
      timeoutMs: 30000,
      ...config,
    };

    this.parties = new Map();
    this.sessions = new Map();
    this.app = express();
    this.server = http.createServer(this.app);
    this.wss = new WebSocket.Server({ server: this.server, path: '/mpc-ws' });

    // Configure middleware
    this.app.use(bodyParser.json());

    // Initialize components
    this.initRoutes();
    this.initWebSocketHandlers();

    logger.info(
      `[MPCServer] Initialized with config: ${JSON.stringify(this.config)}`
    );
  }

  /**
   * Initialize HTTP routes for the MPC server
   */
  initRoutes() {
    // Health check endpoint
    this.app.get('/health', (req, res) => {
      res.status(200).json({
        status: 'healthy',
        activeParties: this.parties.size,
        activeSessions: this.sessions.size,
      });
    });

    // Register a new party
    this.app.post('/register', async (req, res) => {
      try {
        const { nodeId, publicKey, capabilities } = req.body;

        if (!nodeId || !publicKey) {
          return res
            .status(400)
            .json({
              error: 'Missing required parameters: nodeId and publicKey',
            });
        }

        const partyId = await this.registerParty(
          nodeId,
          publicKey,
          capabilities
        );

        res.status(201).json({
          partyId,
          message: 'Party registered successfully',
          serverTime: Date.now(),
        });
      } catch (error) {
        logger.error(`[MPCServer] Registration error: ${error.message}`);
        res
          .status(500)
          .json({ error: 'Registration failed', details: error.message });
      }
    });

    // Initiate a new MPC session
    this.app.post('/sessions', async (req, res) => {
      try {
        const { protocol, threshold, participants, metadata } = req.body;

        if (
          !protocol ||
          !threshold ||
          !participants ||
          participants.length < this.config.minParties
        ) {
          return res.status(400).json({
            error: 'Invalid session parameters',
            details: `Protocol, threshold, and at least ${this.config.minParties} participants are required`,
          });
        }

        const sessionId = await this.createSession(
          protocol,
          threshold,
          participants,
          metadata
        );

        res.status(201).json({
          sessionId,
          message: 'MPC session created',
          status: 'initialized',
          participants: participants.length,
        });
      } catch (error) {
        logger.error(`[MPCServer] Session creation error: ${error.message}`);
        res
          .status(500)
          .json({ error: 'Session creation failed', details: error.message });
      }
    });

    // Get session status
    this.app.get('/sessions/:sessionId', (req, res) => {
      const { sessionId } = req.params;
      const session = this.sessions.get(sessionId);

      if (!session) {
        return res.status(404).json({ error: 'Session not found' });
      }

      res.status(200).json({
        sessionId,
        status: session.status,
        protocol: session.protocol,
        participants: session.participants.length,
        threshold: session.threshold,
        startedAt: session.startedAt,
        updatedAt: session.updatedAt,
      });
    });

    // Submit a computation result
    this.app.post('/sessions/:sessionId/submit', async (req, res) => {
      try {
        const { sessionId } = req.params;
        const { partyId, share, signature } = req.body;

        if (!partyId || !share || !signature) {
          return res.status(400).json({ error: 'Missing required parameters' });
        }

        const session = this.sessions.get(sessionId);
        if (!session) {
          return res.status(404).json({ error: 'Session not found' });
        }

        // Verify signature
        const party = this.parties.get(partyId);
        if (!party) {
          return res.status(403).json({ error: 'Party not registered' });
        }

        const isValid = await verifier.verifyShare(
          session,
          partyId,
          share,
          signature
        );
        if (!isValid) {
          return res.status(403).json({ error: 'Invalid share or signature' });
        }

        // Add share to session
        const result = await this.addShareToSession(sessionId, partyId, share);

        res.status(200).json(result);
      } catch (error) {
        logger.error(`[MPCServer] Share submission error: ${error.message}`);
        res
          .status(500)
          .json({ error: 'Share submission failed', details: error.message });
      }
    });

    // Additional routes for custom MPC operations
    this.app.post('/threshold-signing', async (req, res) => {
      if (!this.config.enableThresholdSigning) {
        return res.status(403).json({ error: 'Threshold signing is disabled' });
      }

      try {
        const { participants, threshold, message } = req.body;
        const result = await mpcProtocols.thresholdSigning(
          participants,
          threshold,
          message
        );
        res.status(200).json(result);
      } catch (error) {
        logger.error(`[MPCServer] Threshold signing error: ${error.message}`);
        res
          .status(500)
          .json({ error: 'Threshold signing failed', details: error.message });
      }
    });

    this.app.post('/zero-knowledge-proof', async (req, res) => {
      if (!this.config.enableZKP) {
        return res
          .status(403)
          .json({ error: 'Zero-knowledge proofs are disabled' });
      }

      try {
        const { statement, witness, public_params } = req.body;
        const result = await mpcProtocols.generateZKProof(
          statement,
          witness,
          public_params
        );
        res.status(200).json(result);
      } catch (error) {
        logger.error(`[MPCServer] ZKP error: ${error.message}`);
        res
          .status(500)
          .json({
            error: 'Zero-knowledge proof failed',
            details: error.message,
          });
      }
    });
  }

  /**
   * Initialize WebSocket handlers for real-time MPC communication
   */
  initWebSocketHandlers() {
    this.wss.on('connection', (ws, req) => {
      const clientId = randomBytes(16).toString('hex');
      logger.info(`[MPCServer] WebSocket client connected: ${clientId}`);

      ws.on('message', async message => {
        try {
          const data = JSON.parse(message);

          switch (data.type) {
            case 'register':
              const { nodeId, publicKey, capabilities } = data;
              const partyId = await this.registerParty(
                nodeId,
                publicKey,
                capabilities
              );

              ws.send(
                JSON.stringify({
                  type: 'register_response',
                  partyId,
                  serverTime: Date.now(),
                })
              );
              break;

            case 'join_session':
              const { sessionId, partyId: requestingPartyId } = data;
              const session = this.sessions.get(sessionId);

              if (!session) {
                ws.send(
                  JSON.stringify({
                    type: 'error',
                    message: 'Session not found',
                  })
                );
                break;
              }

              // Add party to session
              session.parties.set(requestingPartyId, {
                ws,
                joinedAt: Date.now(),
              });

              // Notify all parties in the session
              this.broadcastToSession(sessionId, {
                type: 'party_joined',
                sessionId,
                partyId: requestingPartyId,
                totalParties: session.parties.size,
              });
              break;

            case 'share':
              const {
                sessionId: shareSessionId,
                partyId: sharePartyId,
                share,
                round,
              } = data;

              // Process the share
              const shareResult = await this.processShare(
                shareSessionId,
                sharePartyId,
                share,
                round
              );

              // Broadcast to all parties
              this.broadcastToSession(shareSessionId, {
                type: 'share_received',
                sessionId: shareSessionId,
                partyId: sharePartyId,
                round,
                completed: shareResult.completed,
                round_complete: shareResult.round_complete,
              });

              // If the computation is complete, send the result
              if (shareResult.completed) {
                this.broadcastToSession(shareSessionId, {
                  type: 'computation_complete',
                  sessionId: shareSessionId,
                  result: shareResult.result,
                });
              }
              break;

            default:
              ws.send(
                JSON.stringify({
                  type: 'error',
                  message: 'Unknown message type',
                })
              );
          }
        } catch (error) {
          logger.error(`[MPCServer] WebSocket message error: ${error.message}`);
          ws.send(
            JSON.stringify({
              type: 'error',
              message: 'Failed to process message',
              details: error.message,
            })
          );
        }
      });

      ws.on('close', () => {
        logger.info(`[MPCServer] WebSocket client disconnected: ${clientId}`);
        // Handle client disconnection
        this.handleClientDisconnect(clientId);
      });

      // Set up ping-pong to keep connection alive
      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
    });

    // WebSocket heartbeat
    setInterval(() => {
      this.wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();

        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  /**
   * Register a new party for MPC
   * @param {string} nodeId - Unique identifier for the node
   * @param {string} publicKey - Party's public key for verification
   * @param {Object} capabilities - Party's computational capabilities
   * @returns {string} Generated party ID
   */
  async registerParty(nodeId, publicKey, capabilities = {}) {
    // Generate a unique party ID
    const partyId = createHash('sha256')
      .update(`${nodeId}:${publicKey}:${Date.now()}`)
      .digest('hex');

    // Store party information
    this.parties.set(partyId, {
      nodeId,
      publicKey,
      capabilities: capabilities || {},
      registered: Date.now(),
      lastActive: Date.now(),
    });

    logger.info(`[MPCServer] Registered new party: ${partyId} (${nodeId})`);
    return partyId;
  }

  /**
   * Create a new MPC session
   * @param {string} protocol - The MPC protocol to use
   * @param {number} threshold - Threshold for the computation
   * @param {string[]} participants - List of participant party IDs
   * @param {Object} metadata - Additional session metadata
   * @returns {string} Generated session ID
   */
  async createSession(protocol, threshold, participants, metadata = {}) {
    // Validate participants
    for (const participant of participants) {
      if (!this.parties.has(participant)) {
        throw new Error(`Party not registered: ${participant}`);
      }
    }

    // Generate a unique session ID
    const sessionId = randomBytes(16).toString('hex');

    // Create session
    this.sessions.set(sessionId, {
      id: sessionId,
      protocol,
      threshold,
      participants,
      metadata,
      status: 'initialized',
      parties: new Map(),
      shares: new Map(),
      rounds: new Map(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
      timeoutId: setTimeout(
        () => this.handleSessionTimeout(sessionId),
        this.config.timeoutMs
      ),
    });

    logger.info(
      `[MPCServer] Created new session: ${sessionId} (${protocol}, ${participants.length} participants)`
    );
    return sessionId;
  }

  /**
   * Add a share to an MPC session
   * @param {string} sessionId - The session ID
   * @param {string} partyId - The party ID
   * @param {Object} share - The computational share
   * @returns {Object} Result status
   */
  async addShareToSession(sessionId, partyId, share) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    if (!session.participants.includes(partyId)) {
      throw new Error('Party not authorized for this session');
    }

    // Add share to session
    session.shares.set(partyId, share);
    session.updatedAt = Date.now();

    logger.info(
      `[MPCServer] Added share to session ${sessionId} from party ${partyId}`
    );

    // Check if we have enough shares to complete the computation
    if (session.shares.size >= session.threshold) {
      const result = await this.completeComputation(sessionId);
      return {
        status: 'completed',
        result,
        participants: session.shares.size,
      };
    }

    return {
      status: 'pending',
      sharesReceived: session.shares.size,
      threshold: session.threshold,
      missingShares: session.threshold - session.shares.size,
    };
  }

  /**
   * Process a share from a WebSocket client
   * @param {string} sessionId - The session ID
   * @param {string} partyId - The party ID
   * @param {Object} share - The computational share
   * @param {number} round - The current round number
   * @returns {Object} Processing result
   */
  async processShare(sessionId, partyId, share, round) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    if (!session.participants.includes(partyId)) {
      throw new Error('Party not authorized for this session');
    }

    // Initialize round if it doesn't exist
    if (!session.rounds.has(round)) {
      session.rounds.set(round, new Map());
    }

    const roundShares = session.rounds.get(round);
    roundShares.set(partyId, share);

    logger.info(
      `[MPCServer] Processed share for session ${sessionId}, party ${partyId}, round ${round}`
    );

    // Check if round is complete
    const roundComplete = roundShares.size >= session.threshold;

    // Check if computation is complete (final round)
    if (roundComplete && round === session.metadata.totalRounds) {
      const result = await this.completeComputation(sessionId);
      return {
        completed: true,
        round_complete: true,
        result,
      };
    }

    return {
      completed: false,
      round_complete: roundComplete,
    };
  }

  /**
   * Complete the MPC computation for a session
   * @param {string} sessionId - The session ID
   * @returns {Object} Computation result
   */
  async completeComputation(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error('Session not found');
    }

    try {
      let result;

      // Different computation logic based on protocol
      switch (session.protocol) {
        case 'threshold_signing':
          result = await mpcProtocols.aggregateThresholdSignature(
            session.shares,
            session.metadata.message
          );
          break;

        case 'zkp_verification':
          result = await mpcProtocols.verifyZKProof(
            session.shares,
            session.metadata.statement
          );
          break;

        case 'secret_sharing':
          result = await mpcProtocols.reconstructSecret(
            session.shares,
            session.threshold
          );
          break;

        default:
          // Generic aggregation for custom protocols
          result = await mpcProtocols.aggregateGeneric(
            session.shares,
            session.protocol,
            session.metadata
          );
      }

      // Update session status
      session.status = 'completed';
      session.result = result;
      session.completedAt = Date.now();
      session.updatedAt = Date.now();

      // Clear session timeout
      if (session.timeoutId) {
        clearTimeout(session.timeoutId);
      }

      logger.info(`[MPCServer] Completed computation for session ${sessionId}`);

      return result;
    } catch (error) {
      session.status = 'failed';
      session.error = error.message;
      session.updatedAt = Date.now();

      logger.error(
        `[MPCServer] Computation failed for session ${sessionId}: ${error.message}`
      );
      throw error;
    }
  }

  /**
   * Broadcast a message to all parties in a session
   * @param {string} sessionId - The session ID
   * @param {Object} message - The message to broadcast
   */
  broadcastToSession(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.parties) {
      return;
    }

    const messageStr = JSON.stringify(message);

    session.parties.forEach((party, partyId) => {
      if (party.ws && party.ws.readyState === WebSocket.OPEN) {
        party.ws.send(messageStr);
      }
    });
  }

  /**
   * Handle a WebSocket client disconnection
   * @param {string} clientId - The client ID
   */
  handleClientDisconnect(clientId) {
    // Implementation depends on how clients are tracked
    // This is a simplified version

    // Update any sessions this client was part of
    this.sessions.forEach((session, sessionId) => {
      if (session.parties && session.parties.has(clientId)) {
        session.parties.delete(clientId);

        // Notify other participants
        this.broadcastToSession(sessionId, {
          type: 'party_left',
          sessionId,
          partyId: clientId,
          totalParties: session.parties.size,
        });

        logger.info(`[MPCServer] Party ${clientId} left session ${sessionId}`);
      }
    });
  }

  /**
   * Handle session timeout
   * @param {string} sessionId - The session ID
   */
  handleSessionTimeout(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    if (session.status === 'initialized' || session.status === 'in_progress') {
      session.status = 'timeout';
      session.updatedAt = Date.now();

      // Notify participants
      this.broadcastToSession(sessionId, {
        type: 'session_timeout',
        sessionId,
      });

      logger.warn(
        `[MPCServer] Session ${sessionId} timed out after ${this.config.timeoutMs}ms`
      );
    }
  }

  /**
   * Start the MPC server
   * @returns {Promise<void>}
   */
  start() {
    return new Promise(resolve => {
      this.server.listen(this.config.port, () => {
        logger.info(
          `[MPCServer] MPC server running on port ${this.config.port}`
        );
        resolve();
      });
    });
  }

  /**
   * Stop the MPC server
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise(resolve => {
      // Clean up timeouts
      this.sessions.forEach(session => {
        if (session.timeoutId) {
          clearTimeout(session.timeoutId);
        }
      });

      // Close WebSocket server
      this.wss.close(() => {
        // Close HTTP server
        this.server.close(() => {
          logger.info('[MPCServer] MPC server stopped');
          resolve();
        });
      });
    });
  }
}

module.exports = MPCServer;
