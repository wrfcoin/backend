/**
 * Comprehensive Secure Gossip Protocol Implementation
 * Task 100.14 - Enhanced gossip security beyond basic p2p-gossip-security
 *
 * SECURITY ENHANCEMENTS:
 * - Advanced cryptographic verification with threshold signatures
 * - Multi-source cross-verification for gossip messages
 * - Information freshness validation with exponential decay
 * - Gossip chain-of-custody tracking
 * - Enhanced reputation-based filtering with dynamic thresholds
 * - Topic-based gossip encryption for sensitive information
 * - Byzantine-resistant gossip propagation
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { MessageAuthenticator } from './message-authentication.js';
import { PeerReputationService } from './p2p-peer-reputation.js';
import { MessageOriginVerifier } from './message-origin.js';

export interface SecureGossipMessage {
  messageId: string;
  topic: string;
  payload: Buffer;
  originator: string;
  timestamp: Date;
  expiresAt: Date;
  hopCount: number;
  path: string[]; // Chain of custody
  signatures: Map<string, Buffer>; // Multi-signature from validators
  encryptionMetadata?: {
    algorithm: string;
    iv: Buffer;
    authTag: Buffer;
    encrypted: boolean;
  };
  verificationProofs: {
    merkleRoot: Buffer;
    merkleProofs: Buffer[];
    witnessSignatures: Map<string, Buffer>;
  };
  metadata: {
    priority: 'low' | 'normal' | 'high' | 'critical';
    requiresVerification: boolean;
    minValidators: number;
    crossVerificationCount: number;
  };
}

export interface GossipValidationResult {
  isValid: boolean;
  confidence: number; // 0-1
  validatorCount: number;
  crossVerified: boolean;
  freshness: number; // 0-1
  reputationScore: number;
  reasons: string[];
}

export interface GossipProtocolConfig {
  maxHops: number;
  fanout: number;
  gossipInterval: number;
  maxMessageAge: number;
  minCrossVerifications: number;
  freshnessDecayRate: number; // per second
  encryptSensitiveTopics: boolean;
  requireThresholdSignatures: boolean;
  thresholdSignatureCount: number;
  enableChainOfCustody: boolean;
  maxPathLength: number;
}

/**
 * Comprehensive Secure Gossip Protocol Service
 * SECURITY: Multi-layered validation with Byzantine resistance
 */
export class SecureGossipProtocol extends EventEmitter {
  private seenMessages: Map<string, SecureGossipMessage> = new Map();
  private messageVerifications: Map<string, Set<string>> = new Map(); // messageId -> verifier peerIds
  private topicKeys: Map<string, Buffer> = new Map(); // Topic encryption keys
  private readonly config: GossipProtocolConfig;
  private readonly messageAuth: MessageAuthenticator;
  private readonly peerReputation: PeerReputationService;
  private readonly originVerifier: MessageOriginVerifier;
  private validatorPublicKeys: Map<string, Buffer> = new Map();

  private static readonly DEFAULT_CONFIG: GossipProtocolConfig = {
    maxHops: 5,
    fanout: 3,
    gossipInterval: 1000,
    maxMessageAge: 300000, // 5 minutes
    minCrossVerifications: 3,
    freshnessDecayRate: 0.001, // 0.1% per second
    encryptSensitiveTopics: true,
    requireThresholdSignatures: true,
    thresholdSignatureCount: 2,
    enableChainOfCustody: true,
    maxPathLength: 10,
  };

  constructor(
    messageAuth: MessageAuthenticator,
    peerReputation: PeerReputationService,
    originVerifier: MessageOriginVerifier,
    config?: Partial<GossipProtocolConfig>
  ) {
    super();
    this.config = { ...SecureGossipProtocol.DEFAULT_CONFIG, ...config };
    this.messageAuth = messageAuth;
    this.peerReputation = peerReputation;
    this.originVerifier = originVerifier;

    // Start periodic cleanup
    setInterval(() => this.cleanup(), 60000); // Every minute
  }

  /**
   * Create a secure gossip message with full cryptographic protection
   * SECURITY: Multi-signature, encryption, and verification proofs
   */
  async createSecureGossipMessage(
    topic: string,
    payload: Buffer,
    originator: string,
    metadata: SecureGossipMessage['metadata'],
    validatorKeys?: Map<string, Buffer>
  ): Promise<SecureGossipMessage> {
    const messageId = this.generateMessageId(topic, payload, originator);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.config.maxMessageAge);

    // Encrypt payload if topic is sensitive
    let finalPayload = payload;
    let encryptionMetadata: SecureGossipMessage['encryptionMetadata'];

    if (this.isSensitiveTopic(topic) && this.config.encryptSensitiveTopics) {
      const encrypted = await this.encryptPayload(topic, payload);
      finalPayload = encrypted.ciphertext;
      encryptionMetadata = {
        algorithm: 'aes-256-gcm',
        iv: encrypted.iv,
        authTag: encrypted.authTag,
        encrypted: true,
      };
    }

    // Create Merkle tree for verification
    const verificationProofs = await this.createVerificationProofs(
      messageId,
      finalPayload,
      originator
    );

    // Collect validator signatures if threshold signatures required
    const signatures = new Map<string, Buffer>();
    if (this.config.requireThresholdSignatures && validatorKeys) {
      for (const [validatorId, privateKey] of validatorKeys.entries()) {
        const signature = await this.signMessage(messageId, finalPayload, privateKey);
        signatures.set(validatorId, signature);

        if (signatures.size >= this.config.thresholdSignatureCount) {
          break;
        }
      }
    }

    const message: SecureGossipMessage = {
      messageId,
      topic,
      payload: finalPayload,
      originator,
      timestamp: now,
      expiresAt,
      hopCount: 0,
      path: [originator],
      signatures,
      encryptionMetadata,
      verificationProofs,
      metadata,
    };

    this.seenMessages.set(messageId, message);
    this.messageVerifications.set(messageId, new Set([originator]));

    this.emit('messageCreated', {
      messageId,
      topic,
      originator,
      encrypted: !!encryptionMetadata,
    });

    return message;
  }

  /**
   * Validate secure gossip message with comprehensive security checks
   * SECURITY: Multi-stage validation with Byzantine resistance
   */
  async validateSecureGossipMessage(
    message: SecureGossipMessage,
    receivedFrom: string
  ): Promise<GossipValidationResult> {
    const reasons: string[] = [];
    let confidence = 1.0;
    let validatorCount = 0;
    let crossVerified = false;

    // Stage 1: Basic validation
    if (this.seenMessages.has(message.messageId)) {
      return {
        isValid: false,
        confidence: 0,
        validatorCount: 0,
        crossVerified: false,
        freshness: 0,
        reputationScore: 0,
        reasons: ['Duplicate message'],
      };
    }

    // Stage 2: Freshness check
    const freshness = this.calculateFreshness(message.timestamp, message.expiresAt);
    if (freshness === 0) {
      reasons.push('Message expired');
      return {
        isValid: false,
        confidence: 0,
        validatorCount: 0,
        crossVerified: false,
        freshness: 0,
        reputationScore: 0,
        reasons,
      };
    }

    confidence *= freshness;

    // Stage 3: Hop count validation
    if (message.hopCount > this.config.maxHops) {
      reasons.push(`Exceeded max hops: ${message.hopCount}`);
      confidence *= 0.5;
    }

    // Stage 4: Path validation (chain of custody)
    if (this.config.enableChainOfCustody) {
      const pathValid = await this.validatePath(message.path, receivedFrom);
      if (!pathValid) {
        reasons.push('Invalid propagation path');
        confidence *= 0.6;
      }

      if (message.path.length > this.config.maxPathLength) {
        reasons.push('Path too long');
        confidence *= 0.7;
      }
    }

    // Stage 5: Threshold signature verification
    if (this.config.requireThresholdSignatures) {
      validatorCount = await this.verifyThresholdSignatures(message);
      if (validatorCount < this.config.thresholdSignatureCount) {
        reasons.push(
          `Insufficient signatures: ${validatorCount}/${this.config.thresholdSignatureCount}`
        );
        confidence *= 0.5;
      }
    }

    // Stage 6: Merkle proof verification
    const merkleValid = await this.verifyMerkleProofs(message);
    if (!merkleValid) {
      reasons.push('Invalid Merkle proofs');
      confidence *= 0.4;
    }

    // Stage 7: Origin verification
    const originResult = await this.originVerifier.verifyOrigin(
      message.originator,
      message.verificationProofs.merkleRoot,
      Buffer.from(message.messageId)
    );

    if (!originResult.verified) {
      reasons.push(`Origin verification failed: ${originResult.reason}`);
      confidence *= 0.3;
    }

    // Stage 8: Reputation check
    const reputation = this.peerReputation.getReputation(message.originator);
    const reputationScore = reputation?.score || 0;

    if (reputationScore < 30) {
      reasons.push(`Low originator reputation: ${reputationScore}`);
      confidence *= 0.5;
    }

    // Stage 9: Cross-verification check
    const verifications = this.messageVerifications.get(message.messageId);
    const verificationCount = verifications ? verifications.size : 0;
    crossVerified = verificationCount >= this.config.minCrossVerifications;

    if (!crossVerified && message.metadata.requiresVerification) {
      reasons.push(
        `Insufficient cross-verifications: ${verificationCount}/${this.config.minCrossVerifications}`
      );
      confidence *= 0.6;
    }

    // Stage 10: Decryption validation (if encrypted)
    if (message.encryptionMetadata?.encrypted) {
      const decryptionValid = await this.validateEncryption(message);
      if (!decryptionValid) {
        reasons.push('Encryption validation failed');
        confidence *= 0.3;
      }
    }

    // Calculate final validity
    const isValid = confidence >= 0.7 && reasons.length < 3;

    if (isValid) {
      // Store message and add to verifications
      this.seenMessages.set(message.messageId, message);
      if (!this.messageVerifications.has(message.messageId)) {
        this.messageVerifications.set(message.messageId, new Set());
      }
      this.messageVerifications.get(message.messageId)!.add(receivedFrom);

      this.emit('messageValidated', {
        messageId: message.messageId,
        confidence,
        validatorCount,
        crossVerified,
      });
    } else {
      this.emit('messageRejected', {
        messageId: message.messageId,
        confidence,
        reasons,
      });
    }

    return {
      isValid,
      confidence,
      validatorCount,
      crossVerified,
      freshness,
      reputationScore,
      reasons,
    };
  }

  /**
   * Calculate message freshness with exponential decay
   * SECURITY: Prevents replay attacks with old messages
   */
  private calculateFreshness(timestamp: Date, expiresAt: Date): number {
    const now = Date.now();
    const messageTime = timestamp.getTime();
    const expiry = expiresAt.getTime();

    // Check if expired
    if (now > expiry) {
      return 0;
    }

    // Check if from future (clock skew attack)
    if (messageTime > now + 5000) {
      // 5 second tolerance
      return 0;
    }

    // Calculate age
    const age = now - messageTime;
    const lifetime = expiry - messageTime;

    // Exponential decay: freshness = e^(-decay * age)
    const freshness = Math.exp(-this.config.freshnessDecayRate * (age / 1000));

    // Normalize to 0-1 range
    return Math.max(0, Math.min(1, freshness));
  }

  /**
   * Verify threshold signatures from validators
   * SECURITY: Byzantine-resistant multi-signature verification
   */
  private async verifyThresholdSignatures(message: SecureGossipMessage): Promise<number> {
    let validCount = 0;

    for (const [validatorId, signature] of message.signatures.entries()) {
      const publicKey = this.validatorPublicKeys.get(validatorId);
      if (!publicKey) {
        continue;
      }

      const messageData = Buffer.concat([
        Buffer.from(message.messageId),
        message.payload,
        Buffer.from(message.timestamp.toISOString()),
      ]);

      try {
        const verify = crypto.createVerify('SHA256');
        verify.update(messageData);
        verify.end();

        const publicKeyObject = crypto.createPublicKey({
          key: publicKey,
          format: 'der',
          type: 'spki',
        });

        if (verify.verify(publicKeyObject, signature)) {
          validCount++;
        }
      } catch (error) {
        this.emit('signatureVerificationError', {
          validatorId,
          messageId: message.messageId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
      }
    }

    return validCount;
  }

  /**
   * Verify Merkle proofs for message integrity
   * SECURITY: Cryptographic proof of message inclusion
   */
  private async verifyMerkleProofs(message: SecureGossipMessage): Promise<boolean> {
    const { merkleRoot, merkleProofs } = message.verificationProofs;

    if (merkleProofs.length === 0) {
      return true; // No proofs required
    }

    try {
      // Compute leaf hash
      let currentHash = crypto
        .createHash('sha256')
        .update(Buffer.concat([Buffer.from(message.messageId), message.payload]))
        .digest();

      // Verify each proof level
      for (const proof of merkleProofs) {
        const combined = Buffer.concat([currentHash, proof]);
        currentHash = crypto.createHash('sha256').update(combined).digest();
      }

      // Compare with root
      return crypto.timingSafeEqual(currentHash, merkleRoot);
    } catch (error) {
      this.emit('merkleVerificationError', {
        messageId: message.messageId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Validate propagation path (chain of custody)
   * SECURITY: Prevents path forgery and loop detection
   */
  private async validatePath(path: string[], receivedFrom: string): Promise<boolean> {
    // Check for loops
    const uniquePath = new Set(path);
    if (uniquePath.size !== path.length) {
      this.emit('pathLoopDetected', { path });
      return false;
    }

    // Verify each hop in path is a known peer
    for (const peerId of path) {
      const peer = this.peerReputation.getReputation(peerId);
      if (!peer || peer.score < 20) {
        return false;
      }
    }

    // Verify receivedFrom is the last hop
    if (path[path.length - 1] !== receivedFrom) {
      this.emit('pathMismatch', {
        expectedLast: path[path.length - 1],
        receivedFrom,
      });
      return false;
    }

    return true;
  }

  /**
   * Encrypt gossip payload for sensitive topics
   * SECURITY: Topic-based encryption with authenticated encryption
   */
  private async encryptPayload(
    topic: string,
    payload: Buffer
  ): Promise<{ ciphertext: Buffer; iv: Buffer; authTag: Buffer }> {
    const key = await this.getTopicKey(topic);
    const iv = crypto.randomBytes(16);

    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
    const authTag = cipher.getAuthTag();

    return { ciphertext, iv, authTag };
  }

  /**
   * Decrypt gossip payload
   * SECURITY: Authenticated decryption with integrity check
   */
  async decryptPayload(message: SecureGossipMessage): Promise<Buffer | null> {
    if (!message.encryptionMetadata?.encrypted) {
      return message.payload;
    }

    try {
      const key = await this.getTopicKey(message.topic);
      const decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        key,
        message.encryptionMetadata.iv
      );

      decipher.setAuthTag(message.encryptionMetadata.authTag);

      const decrypted = Buffer.concat([
        decipher.update(message.payload),
        decipher.final(),
      ]);

      return decrypted;
    } catch (error) {
      this.emit('decryptionError', {
        messageId: message.messageId,
        topic: message.topic,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return null;
    }
  }

  /**
   * Validate encryption metadata
   */
  private async validateEncryption(message: SecureGossipMessage): Promise<boolean> {
    if (!message.encryptionMetadata) {
      return true;
    }

    // Attempt decryption to validate
    const decrypted = await this.decryptPayload(message);
    return decrypted !== null;
  }

  /**
   * Get or create topic encryption key
   */
  private async getTopicKey(topic: string): Promise<Buffer> {
    let key = this.topicKeys.get(topic);

    if (!key) {
      // Derive topic key from master key using a cryptographically random salt
      const masterKey = Buffer.from(process.env.GOSSIP_MASTER_KEY || crypto.randomBytes(32));
      const salt = crypto.randomBytes(32);

      key = crypto.pbkdf2Sync(masterKey, salt, 100000, 32, 'sha256');
      this.topicKeys.set(topic, key);
      // Note: salt is per-runtime — keys are ephemeral and rederived on restart.
      // For persistent keys, store salt alongside the derived key.
    }

    return key;
  }

  /**
   * Create verification proofs (Merkle tree)
   */
  private async createVerificationProofs(
    messageId: string,
    payload: Buffer,
    originator: string
  ): Promise<SecureGossipMessage['verificationProofs']> {
    // Create leaf hash
    const leafHash = crypto
      .createHash('sha256')
      .update(Buffer.concat([Buffer.from(messageId), payload]))
      .digest();

    // For single message, merkle root is the leaf hash
    const merkleRoot = leafHash;
    const merkleProofs: Buffer[] = [];

    // Collect witness signatures (if available)
    const witnessSignatures = new Map<string, Buffer>();

    return {
      merkleRoot,
      merkleProofs,
      witnessSignatures,
    };
  }

  /**
   * Sign message with private key
   */
  private async signMessage(
    messageId: string,
    payload: Buffer,
    privateKey: Buffer
  ): Promise<Buffer> {
    const messageData = Buffer.concat([Buffer.from(messageId), payload]);

    const sign = crypto.createSign('SHA256');
    sign.update(messageData);
    sign.end();

    const privateKeyObject = crypto.createPrivateKey({
      key: privateKey,
      format: 'der',
      type: 'pkcs8',
    });

    return sign.sign(privateKeyObject);
  }

  /**
   * Generate unique message ID
   */
  private generateMessageId(topic: string, payload: Buffer, originator: string): string {
    // Length-prefix each field to prevent collision attacks from ambiguous
    // concatenation (e.g., topic="a"+payload="b" vs topic="ab"+payload="").
    const lengthPrefix = (buf: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(buf.length);
      return Buffer.concat([len, buf]);
    };

    const data = Buffer.concat([
      lengthPrefix(Buffer.from(topic)),
      lengthPrefix(payload),
      lengthPrefix(Buffer.from(originator)),
      lengthPrefix(Buffer.from(Date.now().toString())),
      crypto.randomBytes(16),
    ]);

    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Check if topic requires encryption
   */
  private isSensitiveTopic(topic: string): boolean {
    const sensitiveTopics = [
      'consensus',
      'validator',
      'private',
      'confidential',
      'key-exchange',
    ];

    return sensitiveTopics.some(sensitive => topic.toLowerCase().includes(sensitive));
  }

  /**
   * Register validator public key
   */
  registerValidator(validatorId: string, publicKey: Buffer): void {
    this.validatorPublicKeys.set(validatorId, publicKey);
    this.emit('validatorRegistered', { validatorId });
  }

  /**
   * Add cross-verification for a message
   */
  addCrossVerification(messageId: string, verifierId: string): boolean {
    const verifications = this.messageVerifications.get(messageId);
    if (!verifications) {
      return false;
    }

    verifications.add(verifierId);
    this.emit('crossVerificationAdded', {
      messageId,
      verifierId,
      totalVerifications: verifications.size,
    });

    return true;
  }

  /**
   * Get message verification count
   */
  getVerificationCount(messageId: string): number {
    const verifications = this.messageVerifications.get(messageId);
    return verifications ? verifications.size : 0;
  }

  /**
   * Cleanup expired messages
   */
  cleanup(): void {
    const now = Date.now();
    let cleaned = 0;

    for (const [messageId, message] of this.seenMessages.entries()) {
      if (now > message.expiresAt.getTime()) {
        this.seenMessages.delete(messageId);
        this.messageVerifications.delete(messageId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.emit('cleanup', { messagesRemoved: cleaned });
    }
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    seenMessages: number;
    averageVerifications: number;
    encryptedMessages: number;
    validatorCount: number;
  } {
    let totalVerifications = 0;
    let encryptedCount = 0;

    for (const [messageId, message] of this.seenMessages.entries()) {
      const verifications = this.messageVerifications.get(messageId);
      totalVerifications += verifications ? verifications.size : 0;

      if (message.encryptionMetadata?.encrypted) {
        encryptedCount++;
      }
    }

    return {
      seenMessages: this.seenMessages.size,
      averageVerifications:
        this.seenMessages.size > 0 ? totalVerifications / this.seenMessages.size : 0,
      encryptedMessages: encryptedCount,
      validatorCount: this.validatorPublicKeys.size,
    };
  }

  /**
   * Shutdown and cleanup
   */
  shutdown(): void {
    this.seenMessages.clear();
    this.messageVerifications.clear();
    this.topicKeys.clear();
    this.validatorPublicKeys.clear();
    this.emit('shutdown');
  }
}
