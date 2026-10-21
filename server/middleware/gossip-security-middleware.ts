/**
 * Gossip Security Middleware
 * Task 100.14 - Express/WebSocket middleware integrating all gossip security modules
 *
 * INTEGRATION:
 * - SecureGossipProtocol for message validation
 * - GossipStateVerifier for network state consistency
 * - GossipAntiPoisoning for information poisoning detection
 * - GossipRateLimiter for advanced rate limiting
 * - GossipEncryption for topic-based encryption
 * - GossipConsensusProtection for consensus manipulation prevention
 */

import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';
import { SecureGossipProtocol, SecureGossipMessage } from '../../shared/gossip-protocol-security.js';
import { GossipStateVerifier } from '../../shared/gossip-state-verification.js';
import { GossipAntiPoisoning } from '../../shared/gossip-anti-poisoning.js';
import { GossipRateLimiter } from '../../shared/gossip-rate-limiting.js';
import { GossipEncryption } from '../../shared/gossip-encryption.js';
import { GossipConsensusProtection } from '../../shared/gossip-consensus-protection.js';
import { MessageAuthenticator } from '../../shared/message-authentication.js';
import { PeerReputationService } from '../../shared/p2p-peer-reputation.js';
import { MessageOriginVerifier } from '../../shared/message-origin.js';
import { blockchainLogger } from '../utils/logger.js';

export interface GossipSecurityConfig {
  enableEncryption: boolean;
  enableRateLimiting: boolean;
  enableAntiPoisoning: boolean;
  enableStateVerification: boolean;
  enableConsensusProtection: boolean;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

/**
 * Integrated Gossip Security Middleware
 * SECURITY: Multi-layered validation pipeline
 */
export class GossipSecurityMiddleware extends EventEmitter {
  private secureGossip: SecureGossipProtocol;
  private stateVerifier: GossipStateVerifier;
  private antiPoisoning: GossipAntiPoisoning;
  private rateLimiter: GossipRateLimiter;
  private encryption: GossipEncryption;
  private consensusProtection: GossipConsensusProtection;
  private readonly config: GossipSecurityConfig;

  private static readonly DEFAULT_CONFIG: GossipSecurityConfig = {
    enableEncryption: true,
    enableRateLimiting: true,
    enableAntiPoisoning: true,
    enableStateVerification: true,
    enableConsensusProtection: true,
    logLevel: 'info',
  };

  constructor(
    messageAuth: MessageAuthenticator,
    peerReputation: PeerReputationService,
    originVerifier: MessageOriginVerifier,
    config?: Partial<GossipSecurityConfig>
  ) {
    super();
    this.config = { ...GossipSecurityMiddleware.DEFAULT_CONFIG, ...config };

    // Initialize security modules
    this.secureGossip = new SecureGossipProtocol(
      messageAuth,
      peerReputation,
      originVerifier
    );

    this.stateVerifier = new GossipStateVerifier();
    this.antiPoisoning = new GossipAntiPoisoning(peerReputation);
    this.rateLimiter = new GossipRateLimiter(peerReputation);
    this.encryption = new GossipEncryption();
    this.consensusProtection = new GossipConsensusProtection({
      totalValidators: 100,
      byzantineThreshold: 33,
      quorumThreshold: 67,
      commitThreshold: 67,
    });

    // Wire up event listeners
    this.setupEventListeners();
  }

  /**
   * Setup event listeners for security modules
   */
  private setupEventListeners(): void {
    // Secure gossip events
    this.secureGossip.on('messageRejected', data => {
      this.log('warn', 'Message rejected', data);
    });

    // Anti-poisoning events
    this.antiPoisoning.on('messageQuarantined', data => {
      this.log('warn', 'Message quarantined', data);
    });

    // Rate limiter events
    this.rateLimiter.on('globalLimitExceeded', data => {
      this.log('warn', 'Global rate limit exceeded', data);
    });

    this.rateLimiter.on('burstDetected', data => {
      this.log('error', 'Burst attack detected', data);
    });

    // Consensus protection events
    this.consensusProtection.on('equivocationDetected', data => {
      this.log('error', 'Equivocation detected', data);
    });

    this.consensusProtection.on('splitBrainDetected', data => {
      this.log('error', 'Split-brain detected', data);
    });
  }

  /**
   * Express middleware for HTTP gossip endpoints
   */
  httpMiddleware() {
    return async (req: Request, res: Response, next: NextFunction) => {
      try {
        const source = this.extractSource(req);
        const topic = req.body?.topic || 'default';
        const priority = req.body?.priority || 'normal';

        // Stage 1: Rate limiting
        if (this.config.enableRateLimiting) {
          const rateLimitResult = await this.rateLimiter.checkRateLimit(
            req.body?.messageId || 'unknown',
            source,
            topic,
            priority
          );

          if (!rateLimitResult.allowed) {
            return res.status(429).json({
              success: false,
              error: 'Rate limit exceeded',
              reason: rateLimitResult.reason,
              retryAfter: rateLimitResult.retryAfter,
            });
          }
        }

        // Stage 2: Anti-poisoning check
        if (this.config.enableAntiPoisoning && req.body?.payload) {
          const poisoningResult = await this.antiPoisoning.detectPoisoning(
            req.body.messageId,
            topic,
            req.body.payload,
            source
          );

          if (poisoningResult.isPoisoned) {
            return res.status(400).json({
              success: false,
              error: 'Message rejected',
              reason: 'Potential information poisoning detected',
              confidence: poisoningResult.confidence,
              action: poisoningResult.recommendedAction,
            });
          }
        }

        // Attach security context to request
        (req as any).security = {
          source,
          validated: true,
          timestamp: new Date(),
        };

        next();
      } catch (error) {
        this.log('error', 'Security middleware error', {
          error: error instanceof Error ? error.message : 'Unknown error',
        });

        res.status(500).json({
          success: false,
          error: 'Security validation failed',
        });
      }
    };
  }

  /**
   * WebSocket middleware for gossip protocol
   */
  websocketMiddleware() {
    return async (ws: WebSocket, req: any) => {
      const source = this.extractSource(req);
      let messageCount = 0;

      ws.on('message', async data => {
        try {
          messageCount++;
          const message = JSON.parse(data.toString());

          // Validate gossip message
          const validationResult = await this.validateGossipMessage(message, source);

          if (!validationResult.allowed) {
            ws.send(
              JSON.stringify({
                type: 'error',
                error: validationResult.reason,
                messageId: message.messageId,
              })
            );
            return;
          }

          // Process valid message
          ws.send(
            JSON.stringify({
              type: 'ack',
              messageId: message.messageId,
              timestamp: new Date().toISOString(),
            })
          );
        } catch (error) {
          this.log('error', 'WebSocket message processing error', {
            error: error instanceof Error ? error.message : 'Unknown error',
            source,
          });

          ws.send(
            JSON.stringify({
              type: 'error',
              error: 'Message processing failed',
            })
          );
        }
      });

      ws.on('close', () => {
        this.log('info', 'WebSocket disconnected', {
          source,
          messagesProcessed: messageCount,
        });
      });

      // Send welcome message
      ws.send(
        JSON.stringify({
          type: 'welcome',
          message: 'Connected to secure gossip protocol',
          timestamp: new Date().toISOString(),
        })
      );
    };
  }

  /**
   * Comprehensive gossip message validation
   * SECURITY: Multi-stage validation pipeline
   */
  async validateGossipMessage(
    message: any,
    source: string
  ): Promise<{
    allowed: boolean;
    reason?: string;
    stage?: string;
  }> {
    // Stage 1: Rate limiting
    if (this.config.enableRateLimiting) {
      const rateLimitResult = await this.rateLimiter.checkRateLimit(
        message.messageId,
        source,
        message.topic || 'default',
        message.priority || 'normal'
      );

      if (!rateLimitResult.allowed) {
        return {
          allowed: false,
          reason: rateLimitResult.reason,
          stage: 'rate_limiting',
        };
      }
    }

    // Stage 2: Decryption if encrypted
    let decryptedPayload = message.payload;
    if (
      this.config.enableEncryption &&
      message.encryptionMetadata?.encrypted
    ) {
      try {
        const gossipMessage: SecureGossipMessage = message;
        decryptedPayload = await this.encryption.decryptPayload(
          message.encryptionMetadata,
          message.topic
        );
      } catch (error) {
        return {
          allowed: false,
          reason: 'Decryption failed',
          stage: 'decryption',
        };
      }
    }

    // Stage 3: Anti-poisoning detection
    if (this.config.enableAntiPoisoning) {
      const poisoningResult = await this.antiPoisoning.detectPoisoning(
        message.messageId,
        message.topic || 'default',
        decryptedPayload,
        source
      );

      if (poisoningResult.recommendedAction === 'reject') {
        return {
          allowed: false,
          reason: 'Information poisoning detected',
          stage: 'anti_poisoning',
        };
      }
    }

    // Stage 4: Secure gossip protocol validation
    const gossipValidation = await this.secureGossip.validateSecureGossipMessage(
      message,
      source
    );

    if (!gossipValidation.isValid) {
      return {
        allowed: false,
        reason: `Gossip validation failed: ${gossipValidation.reasons.join(', ')}`,
        stage: 'gossip_protocol',
      };
    }

    // All stages passed
    return { allowed: true };
  }

  /**
   * Validate consensus message
   */
  async validateConsensusMessage(message: any): Promise<{
    allowed: boolean;
    reason?: string;
  }> {
    if (!this.config.enableConsensusProtection) {
      return { allowed: true };
    }

    const validation = await this.consensusProtection.validateConsensusMessage(message);

    if (!validation.isValid) {
      return {
        allowed: false,
        reason: validation.reasons.join('; '),
      };
    }

    // Check for split-brain
    const splitBrain = this.consensusProtection.detectSplitBrain(message.height);
    if (splitBrain.detected) {
      return {
        allowed: false,
        reason: 'Network split-brain detected',
      };
    }

    return { allowed: true };
  }

  /**
   * Perform state verification
   */
  async verifyNetworkState(remoteStates: Map<string, any>): Promise<{
    isValid: boolean;
    consistency: number;
    divergenceCount: number;
  }> {
    if (!this.config.enableStateVerification) {
      return { isValid: true, consistency: 1.0, divergenceCount: 0 };
    }

    const verification = await this.stateVerifier.verifyStateConsistency(remoteStates);

    return {
      isValid: verification.isValid,
      consistency: verification.consistency,
      divergenceCount: verification.divergences.length,
    };
  }

  /**
   * Extract source identifier from request
   */
  private extractSource(req: any): string {
    // Try various source identifiers
    return (
      req.headers['x-peer-id'] ||
      req.headers['x-forwarded-for']?.split(',')[0] ||
      req.socket?.remoteAddress ||
      'unknown'
    );
  }

  /**
   * Logging helper
   */
  private log(level: string, message: string, data?: any): void {
    const levels = ['error', 'warn', 'info', 'debug'];
    const configLevelIndex = levels.indexOf(this.config.logLevel);
    const messageLevelIndex = levels.indexOf(level);

    if (messageLevelIndex <= configLevelIndex) {
      const logData = {
        operation: 'gossip:security',
        ...data,
      };

      if (level === 'error') {
        blockchainLogger.error(message, logData);
      } else if (level === 'warn') {
        blockchainLogger.warn(message, logData);
      } else if (level === 'debug') {
        blockchainLogger.debug(message, logData);
      } else {
        blockchainLogger.info(message, logData);
      }

      this.emit('log', { timestamp: new Date().toISOString(), level, message, ...data });
    }
  }

  /**
   * Get statistics from all security modules
   */
  getStatistics(): {
    gossip: any;
    stateVerifier: any;
    antiPoisoning: any;
    rateLimiter: any;
    encryption: any;
    consensusProtection: any;
  } {
    return {
      gossip: this.secureGossip.getStatistics(),
      stateVerifier: this.stateVerifier.getStatistics(),
      antiPoisoning: this.antiPoisoning.getStatistics(),
      rateLimiter: this.rateLimiter.getStatistics(),
      encryption: this.encryption.getStatistics(),
      consensusProtection: this.consensusProtection.getStatistics(),
    };
  }

  /**
   * Get security service instances (for advanced integration)
   */
  getServices(): {
    secureGossip: SecureGossipProtocol;
    stateVerifier: GossipStateVerifier;
    antiPoisoning: GossipAntiPoisoning;
    rateLimiter: GossipRateLimiter;
    encryption: GossipEncryption;
    consensusProtection: GossipConsensusProtection;
  } {
    return {
      secureGossip: this.secureGossip,
      stateVerifier: this.stateVerifier,
      antiPoisoning: this.antiPoisoning,
      rateLimiter: this.rateLimiter,
      encryption: this.encryption,
      consensusProtection: this.consensusProtection,
    };
  }

  /**
   * Shutdown all security modules
   */
  shutdown(): void {
    this.secureGossip.shutdown();
    this.stateVerifier.shutdown();
    this.antiPoisoning.shutdown();
    this.rateLimiter.shutdown();
    this.encryption.shutdown();
    this.consensusProtection.shutdown();

    this.emit('shutdown');
  }
}

/**
 * Factory function to create middleware with dependencies
 */
export async function createGossipSecurityMiddleware(
  config?: Partial<GossipSecurityConfig>
): Promise<GossipSecurityMiddleware> {
  // Initialize dependencies
  const messageAuth = new MessageAuthenticator();
  await messageAuth.initialize(Buffer.from(process.env.MESSAGE_AUTH_KEY || randomBytes(32)));

  const peerReputation = new PeerReputationService();
  const originVerifier = new MessageOriginVerifier();

  return new GossipSecurityMiddleware(
    messageAuth,
    peerReputation,
    originVerifier,
    config
  );
}
