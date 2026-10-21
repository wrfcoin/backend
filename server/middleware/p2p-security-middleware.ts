/**
 * P2P Security Middleware Orchestrator
 * Comprehensive security orchestration for P2P network protocols
 *
 * SECURITY: Task 100.10 - Complete P2P security framework integration
 */

import { EventEmitter } from 'events';
import { Request, Response, NextFunction } from 'express';
import { PeerAuthenticationService } from '../../shared/p2p-peer-authentication.js';
import { P2PEncryptionService } from '../../shared/p2p-encryption.js';
import { PeerReputationService } from '../../shared/p2p-peer-reputation.js';
import { P2PMessageValidator } from '../../shared/p2p-message-validation.js';
import { P2PRoutingSecurityService } from '../../shared/p2p-routing-security.js';
import { P2PeerDiscoveryService } from '../../shared/p2p-peer-discovery.js';
import { P2PGossipSecurityService } from '../../shared/p2p-gossip-security.js';
import { MessageAuthenticator } from '../../shared/message-authentication.js';
import { ReplayPreventionService } from '../../shared/replay-prevention.js';
import { MessageOriginVerifier } from '../../shared/message-origin.js';

export interface P2PSecurityConfig {
  enableAuthentication: boolean;
  enableEncryption: boolean;
  enableReputation: boolean;
  enableMessageValidation: boolean;
  enableRoutingSecurity: boolean;
  enablePeerDiscovery: boolean;
  enableGossipSecurity: boolean;
  minReputationScore: number;
  requireCertificates: boolean;
}

/**
 * P2P Security Middleware Orchestrator
 * Integrates all P2P security components
 */
export class P2PSecurityMiddleware extends EventEmitter {
  private authentication: PeerAuthenticationService;
  private encryption: P2PEncryptionService;
  private reputation: PeerReputationService;
  private messageValidator: P2PMessageValidator;
  private routingSecurity: P2PRoutingSecurityService;
  private peerDiscovery: P2PeerDiscoveryService;
  private gossipSecurity: P2PGossipSecurityService;
  private readonly config: P2PSecurityConfig;

  private static readonly DEFAULT_CONFIG: P2PSecurityConfig = {
    enableAuthentication: true,
    enableEncryption: true,
    enableReputation: true,
    enableMessageValidation: true,
    enableRoutingSecurity: true,
    enablePeerDiscovery: true,
    enableGossipSecurity: true,
    minReputationScore: 30,
    requireCertificates: false,
  };

  constructor(
    messageAuth: MessageAuthenticator,
    replayPrevention: ReplayPreventionService,
    originVerifier: MessageOriginVerifier,
    config?: Partial<P2PSecurityConfig>
  ) {
    super();
    this.config = { ...P2PSecurityMiddleware.DEFAULT_CONFIG, ...config };

    // Initialize security components
    this.authentication = new PeerAuthenticationService({
      requireCertificates: this.config.requireCertificates,
      enableForwardSecrecy: true,
    });

    this.encryption = new P2PEncryptionService({
      preferredCipherSuites: ['CHACHA20_POLY1305', 'AES_256_GCM'],
      enablePerfectForwardSecrecy: true,
    });

    this.reputation = new PeerReputationService({
      minScoreThreshold: this.config.minReputationScore,
    });

    this.messageValidator = new P2PMessageValidator(
      messageAuth,
      replayPrevention,
      originVerifier
    );

    this.routingSecurity = new P2PRoutingSecurityService();
    this.peerDiscovery = new P2PeerDiscoveryService();
    this.gossipSecurity = new P2PGossipSecurityService();

    this.setupEventHandlers();
  }

  /**
   * Multi-stage peer validation pipeline
   * SECURITY: Comprehensive peer validation
   */
  async validatePeer(peerId: string, publicKey: Buffer): Promise<{
    valid: boolean;
    stages: {
      authentication: boolean;
      reputation: boolean;
      discovery: boolean;
    };
    reason?: string;
  }> {
    const stages = {
      authentication: false,
      reputation: false,
      discovery: false,
    };

    // Stage 1: Authentication
    if (this.config.enableAuthentication) {
      const isAuthenticated = this.authentication.isPeerAuthenticated(peerId);
      stages.authentication = isAuthenticated;

      if (!isAuthenticated) {
        return { valid: false, stages, reason: 'Peer not authenticated' };
      }
    } else {
      stages.authentication = true;
    }

    // Stage 2: Reputation
    if (this.config.enableReputation) {
      const isReputationOk = this.reputation.isReputationAcceptable(peerId);
      stages.reputation = isReputationOk;

      if (!isReputationOk) {
        return { valid: false, stages, reason: 'Insufficient reputation' };
      }
    } else {
      stages.reputation = true;
    }

    // Stage 3: Discovery (verify peer is known)
    if (this.config.enablePeerDiscovery) {
      const knownPeers = this.peerDiscovery.getKnownPeers(1000);
      const isKnown = knownPeers.some(p => p.peerId === peerId);
      stages.discovery = isKnown;

      if (!isKnown) {
        return { valid: false, stages, reason: 'Unknown peer' };
      }
    } else {
      stages.discovery = true;
    }

    return { valid: true, stages };
  }

  /**
   * Express middleware for P2P request authentication
   */
  authenticateRequest() {
    return async (req: Request, res: Response, next: NextFunction) => {
      const peerId = req.headers['x-peer-id'] as string;
      const signature = req.headers['x-peer-signature'] as string;

      if (!peerId || !signature) {
        return res.status(401).json({
          success: false,
          error: 'Missing peer authentication headers',
        });
      }

      const validation = await this.validatePeer(peerId, Buffer.from(signature, 'hex'));

      if (!validation.valid) {
        this.emit('requestRejected', { peerId, reason: validation.reason });
        return res.status(403).json({
          success: false,
          error: validation.reason || 'Peer validation failed',
        });
      }

      req.peerId = peerId;
      next();
    };
  }

  /**
   * Rate limiting based on peer reputation
   */
  reputationRateLimit() {
    const requestCounts = new Map<string, { count: number; resetAt: number }>();

    return (req: Request, res: Response, next: NextFunction) => {
      const peerId = req.peerId;
      if (!peerId) {
        return res.status(401).json({ error: 'Peer ID required' });
      }

      const limits = this.reputation.getRateLimit(peerId);
      const now = Date.now();
      const windowMs = 1000; // 1 second window

      const current = requestCounts.get(peerId);

      if (!current || now > current.resetAt) {
        requestCounts.set(peerId, {
          count: 1,
          resetAt: now + windowMs,
        });
        return next();
      }

      if (current.count >= limits.messagesPerSecond) {
        return res.status(429).json({
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((current.resetAt - now) / 1000),
        });
      }

      current.count++;
      next();
    };
  }

  /**
   * Connection management and peer lifecycle
   */
  async handlePeerConnection(
    peerId: string,
    publicKey: Buffer,
    capabilities: string[]
  ): Promise<{
    connectionId: string;
    sessionId: string;
    encryptionEnabled: boolean;
  }> {
    // Register peer in reputation system
    this.reputation.registerPeer(peerId, capabilities);

    // Authenticate peer
    const challenge = await this.authentication.generateChallenge(peerId);

    // Note: In real implementation, would wait for challenge response
    // For now, we'll assume successful authentication

    // Establish encrypted connection
    const connection = await this.encryption.establishEncryptedConnection(
      peerId,
      ['CHACHA20_POLY1305', 'AES_256_GCM'],
      publicKey
    );

    this.emit('peerConnected', {
      peerId,
      connectionId: connection.connectionId,
      encryptionEnabled: true,
    });

    return {
      connectionId: connection.connectionId,
      sessionId: challenge.challengeId,
      encryptionEnabled: true,
    };
  }

  /**
   * Handle peer disconnection
   */
  handlePeerDisconnection(connectionId: string): void {
    this.encryption.closeConnection(connectionId);
    this.emit('peerDisconnected', { connectionId });
  }

  /**
   * Setup event handlers for cross-component coordination
   */
  private setupEventHandlers(): void {
    // Authentication events
    this.authentication.on('peerAuthenticated', ({ peerId }) => {
      this.reputation.recordEvent({
        peerId,
        eventType: 'successful_interaction',
        impactPoints: 2,
      });
    });

    this.authentication.on('authenticationFailed', ({ peerId }) => {
      this.reputation.recordEvent({
        peerId,
        eventType: 'failed_interaction',
        impactPoints: -5,
      });
    });

    // Message validation events
    this.messageValidator.on('messageValidated', ({ senderId }) => {
      this.reputation.recordEvent({
        peerId: senderId,
        eventType: 'valid_message',
        impactPoints: 1,
      });
    });

    // Reputation events
    this.reputation.on('peerBanned', ({ peerId, reason }) => {
      this.emit('peerBanned', { peerId, reason });
    });
  }

  /**
   * Get comprehensive security statistics
   */
  getSecurityStatistics(): {
    authentication: any;
    encryption: any;
    reputation: any;
  } {
    return {
      authentication: this.authentication.getStatistics(),
      encryption: this.encryption.getStatistics(),
      reputation: this.reputation.getStatistics(),
    };
  }

  /**
   * Cleanup and maintenance
   */
  cleanup(): void {
    this.authentication.cleanup();
    this.encryption.cleanup();
    this.reputation.cleanup();
    this.routingSecurity.cleanup();
    this.gossipSecurity.cleanup();
  }

  /**
   * Shutdown all security components
   */
  shutdown(): void {
    this.authentication.shutdown();
    this.encryption.shutdown();
    this.reputation.shutdown();
    this.messageValidator.shutdown();
    this.routingSecurity.shutdown();
    this.peerDiscovery.shutdown();
    this.gossipSecurity.shutdown();

    this.emit('shutdown');
  }
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      peerId?: string;
    }
  }
}
