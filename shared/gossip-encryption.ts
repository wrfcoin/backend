/**
 * Gossip Topic-Based Encryption System
 * Task 100.14 - End-to-end encryption for sensitive gossip topics
 *
 * SECURITY FEATURES:
 * - Topic-based encryption with separate key spaces
 * - Automated key rotation with graceful transitions
 * - Secure key distribution via Diffie-Hellman
 * - Selective encryption based on message sensitivity
 * - Perfect forward secrecy with ephemeral keys
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

export interface TopicKey {
  keyId: string;
  topic: string;
  key: Buffer;
  algorithm: 'aes-256-gcm' | 'chacha20-poly1305';
  createdAt: Date;
  expiresAt: Date;
  version: number;
  isActive: boolean;
}

export interface EncryptionResult {
  ciphertext: Buffer;
  iv: Buffer;
  authTag: Buffer;
  keyId: string;
  algorithm: string;
}

export interface KeyRotationSchedule {
  topic: string;
  rotationInterval: number; // milliseconds
  gracePeriod: number; // milliseconds
  nextRotation: Date;
}

/**
 * Gossip Encryption Service
 * SECURITY: Topic-based end-to-end encryption with key management
 */
export class GossipEncryption extends EventEmitter {
  private topicKeys: Map<string, TopicKey[]> = new Map(); // topic -> keys (current + old)
  private rotationSchedules: Map<string, KeyRotationSchedule> = new Map();
  private keyExchangeKeys: Map<string, Buffer> = new Map(); // peer -> DH public key
  private rotationTimers: Map<string, NodeJS.Timeout> = new Map();
  private readonly defaultRotationInterval = 86400000; // 24 hours
  private readonly defaultGracePeriod = 3600000; // 1 hour

  constructor() {
    super();
    this.initializeSensitiveTopics();
  }

  /**
   * Initialize encryption for known sensitive topics
   */
  private initializeSensitiveTopics(): void {
    const sensitiveTopics = [
      'consensus',
      'validator',
      'private',
      'confidential',
      'key-exchange',
      'admin',
    ];

    for (const topic of sensitiveTopics) {
      this.initializeTopicEncryption(topic);
    }
  }

  /**
   * Initialize encryption for a topic
   */
  initializeTopicEncryption(
    topic: string,
    algorithm: TopicKey['algorithm'] = 'aes-256-gcm'
  ): TopicKey {
    const key = this.generateTopicKey(topic, algorithm);

    // Store as active key
    if (!this.topicKeys.has(topic)) {
      this.topicKeys.set(topic, []);
    }
    this.topicKeys.get(topic)!.push(key);

    // Schedule rotation
    this.scheduleKeyRotation(topic);

    this.emit('topicInitialized', {
      topic,
      keyId: key.keyId,
      algorithm,
    });

    return key;
  }

  /**
   * Generate new topic encryption key
   */
  private generateTopicKey(
    topic: string,
    algorithm: TopicKey['algorithm']
  ): TopicKey {
    const keyId = crypto.randomBytes(16).toString('hex');
    const key = crypto.randomBytes(32); // 256-bit key

    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.defaultRotationInterval);

    // Get version number
    const existingKeys = this.topicKeys.get(topic) || [];
    const version = existingKeys.length + 1;

    return {
      keyId,
      topic,
      key,
      algorithm,
      createdAt: now,
      expiresAt,
      version,
      isActive: true,
    };
  }

  /**
   * Encrypt gossip message payload
   * SECURITY: Authenticated encryption with additional data (AEAD)
   */
  async encryptPayload(
    topic: string,
    payload: Buffer,
    additionalData?: Buffer
  ): Promise<EncryptionResult> {
    const topicKey = this.getActiveTopicKey(topic);
    if (!topicKey) {
      throw new Error(`No encryption key available for topic: ${topic}`);
    }

    const iv = crypto.randomBytes(12); // 96-bit IV for GCM
    let cipher: crypto.CipherGCM;
    let ciphertext: Buffer;
    let authTag: Buffer;

    if (topicKey.algorithm === 'aes-256-gcm') {
      cipher = crypto.createCipheriv('aes-256-gcm', topicKey.key, iv) as crypto.CipherGCM;

      if (additionalData) {
        cipher.setAAD(additionalData);
      }

      ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
      authTag = cipher.getAuthTag();
    } else if (topicKey.algorithm === 'chacha20-poly1305') {
      cipher = crypto.createCipheriv('chacha20-poly1305', topicKey.key, iv) as crypto.CipherGCM;

      if (additionalData) {
        cipher.setAAD(additionalData);
      }

      ciphertext = Buffer.concat([cipher.update(payload), cipher.final()]);
      authTag = cipher.getAuthTag();
    } else {
      throw new Error(`Unsupported algorithm: ${topicKey.algorithm}`);
    }

    return {
      ciphertext,
      iv,
      authTag,
      keyId: topicKey.keyId,
      algorithm: topicKey.algorithm,
    };
  }

  /**
   * Decrypt gossip message payload
   * SECURITY: Verification of authentication tag prevents tampering
   */
  async decryptPayload(
    encryptionResult: EncryptionResult,
    topic: string,
    additionalData?: Buffer
  ): Promise<Buffer> {
    const topicKey = this.getTopicKeyById(topic, encryptionResult.keyId);
    if (!topicKey) {
      throw new Error(`Encryption key not found: ${encryptionResult.keyId}`);
    }

    let decipher: crypto.DecipherGCM;

    if (encryptionResult.algorithm === 'aes-256-gcm') {
      decipher = crypto.createDecipheriv(
        'aes-256-gcm',
        topicKey.key,
        encryptionResult.iv
      ) as crypto.DecipherGCM;
    } else if (encryptionResult.algorithm === 'chacha20-poly1305') {
      decipher = crypto.createDecipheriv(
        'chacha20-poly1305',
        topicKey.key,
        encryptionResult.iv
      ) as crypto.DecipherGCM;
    } else {
      throw new Error(`Unsupported algorithm: ${encryptionResult.algorithm}`);
    }

    decipher.setAuthTag(encryptionResult.authTag);

    if (additionalData) {
      decipher.setAAD(additionalData);
    }

    try {
      const plaintext = Buffer.concat([
        decipher.update(encryptionResult.ciphertext),
        decipher.final(),
      ]);

      return plaintext;
    } catch (error) {
      this.emit('decryptionError', {
        keyId: encryptionResult.keyId,
        topic,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw new Error('Decryption failed: authentication tag verification failed');
    }
  }

  /**
   * Get active encryption key for topic
   */
  private getActiveTopicKey(topic: string): TopicKey | null {
    const keys = this.topicKeys.get(topic);
    if (!keys || keys.length === 0) {
      return null;
    }

    // Find most recent active key
    const activeKeys = keys.filter(k => k.isActive && new Date() < k.expiresAt);
    if (activeKeys.length === 0) {
      return null;
    }

    activeKeys.sort((a, b) => b.version - a.version);
    return activeKeys[0];
  }

  /**
   * Get topic key by ID
   */
  private getTopicKeyById(topic: string, keyId: string): TopicKey | null {
    const keys = this.topicKeys.get(topic);
    if (!keys) {
      return null;
    }

    return keys.find(k => k.keyId === keyId) || null;
  }

  /**
   * Schedule automatic key rotation
   */
  private scheduleKeyRotation(topic: string): void {
    const schedule: KeyRotationSchedule = {
      topic,
      rotationInterval: this.defaultRotationInterval,
      gracePeriod: this.defaultGracePeriod,
      nextRotation: new Date(Date.now() + this.defaultRotationInterval),
    };

    this.rotationSchedules.set(topic, schedule);

    // Clear existing timer if any
    const existingTimer = this.rotationTimers.get(topic);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    // Schedule rotation
    const timer = setTimeout(() => {
      this.rotateTopicKey(topic);
    }, this.defaultRotationInterval);

    this.rotationTimers.set(topic, timer);

    this.emit('rotationScheduled', {
      topic,
      nextRotation: schedule.nextRotation,
    });
  }

  /**
   * Rotate encryption key for topic
   * SECURITY: Smooth rotation with grace period
   */
  async rotateTopicKey(topic: string): Promise<TopicKey> {
    const oldKey = this.getActiveTopicKey(topic);

    // Generate new key
    const algorithm = oldKey?.algorithm || 'aes-256-gcm';
    const newKey = this.generateTopicKey(topic, algorithm);

    // Add new key
    this.topicKeys.get(topic)!.push(newKey);

    // Mark old key as inactive after grace period
    if (oldKey) {
      setTimeout(() => {
        oldKey.isActive = false;
        this.emit('keyDeactivated', {
          topic,
          keyId: oldKey.keyId,
        });

        // Remove old key after additional period
        setTimeout(() => {
          this.removeTopicKey(topic, oldKey.keyId);
        }, this.defaultGracePeriod);
      }, this.defaultGracePeriod);
    }

    // Schedule next rotation
    this.scheduleKeyRotation(topic);

    this.emit('keyRotated', {
      topic,
      oldKeyId: oldKey?.keyId,
      newKeyId: newKey.keyId,
      version: newKey.version,
    });

    return newKey;
  }

  /**
   * Remove old topic key
   */
  private removeTopicKey(topic: string, keyId: string): void {
    const keys = this.topicKeys.get(topic);
    if (!keys) return;

    const index = keys.findIndex(k => k.keyId === keyId);
    if (index >= 0) {
      // Securely wipe key material
      keys[index].key.fill(0);
      keys.splice(index, 1);

      this.emit('keyRemoved', { topic, keyId });
    }
  }

  /**
   * Perform Diffie-Hellman key exchange for peer-to-peer encryption
   * SECURITY: Perfect forward secrecy with ephemeral keys
   */
  async performKeyExchange(
    peerId: string
  ): Promise<{ publicKey: Buffer; sharedSecret: Buffer }> {
    // Generate ephemeral DH key pair
    const dh = crypto.createDiffieHellman(2048);
    dh.generateKeys();

    const publicKey = dh.getPublicKey();

    // Get peer's public key (would come from peer in real implementation)
    const peerPublicKey = this.keyExchangeKeys.get(peerId);
    if (!peerPublicKey) {
      throw new Error(`No public key available for peer: ${peerId}`);
    }

    // Compute shared secret
    const sharedSecret = dh.computeSecret(peerPublicKey);

    // Derive encryption key from shared secret
    const derivedKey = crypto.pbkdf2Sync(sharedSecret, Buffer.from(peerId), 100000, 32, 'sha256');

    this.emit('keyExchangeCompleted', {
      peerId,
      keyLength: derivedKey.length,
    });

    return {
      publicKey,
      sharedSecret: derivedKey,
    };
  }

  /**
   * Register peer's public key for key exchange
   */
  registerPeerPublicKey(peerId: string, publicKey: Buffer): void {
    this.keyExchangeKeys.set(peerId, publicKey);

    this.emit('peerKeyRegistered', {
      peerId,
      keyLength: publicKey.length,
    });
  }

  /**
   * Check if topic requires encryption
   */
  requiresEncryption(topic: string): boolean {
    return this.topicKeys.has(topic);
  }

  /**
   * Get topic encryption info
   */
  getTopicInfo(topic: string): {
    hasEncryption: boolean;
    activeKey?: {
      keyId: string;
      algorithm: string;
      version: number;
      expiresAt: Date;
    };
    nextRotation?: Date;
  } {
    const activeKey = this.getActiveTopicKey(topic);
    const schedule = this.rotationSchedules.get(topic);

    if (!activeKey) {
      return { hasEncryption: false };
    }

    return {
      hasEncryption: true,
      activeKey: {
        keyId: activeKey.keyId,
        algorithm: activeKey.algorithm,
        version: activeKey.version,
        expiresAt: activeKey.expiresAt,
      },
      nextRotation: schedule?.nextRotation,
    };
  }

  /**
   * Export public keys for key distribution
   * SECURITY: Only export public information
   */
  exportPublicKeys(): Map<
    string,
    {
      keyId: string;
      algorithm: string;
      version: number;
      expiresAt: Date;
    }
  > {
    const publicKeys = new Map();

    for (const [topic, keys] of this.topicKeys.entries()) {
      const activeKey = keys.find(k => k.isActive);
      if (activeKey) {
        publicKeys.set(topic, {
          keyId: activeKey.keyId,
          algorithm: activeKey.algorithm,
          version: activeKey.version,
          expiresAt: activeKey.expiresAt,
        });
      }
    }

    return publicKeys;
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    encryptedTopics: number;
    totalKeys: number;
    activeKeys: number;
    scheduledRotations: number;
  } {
    let totalKeys = 0;
    let activeKeys = 0;

    for (const keys of this.topicKeys.values()) {
      totalKeys += keys.length;
      activeKeys += keys.filter(k => k.isActive).length;
    }

    return {
      encryptedTopics: this.topicKeys.size,
      totalKeys,
      activeKeys,
      scheduledRotations: this.rotationSchedules.size,
    };
  }

  /**
   * Shutdown and cleanup
   * SECURITY: Securely wipe all key material
   */
  shutdown(): void {
    // Clear rotation timers
    for (const timer of this.rotationTimers.values()) {
      clearTimeout(timer);
    }
    this.rotationTimers.clear();

    // Securely wipe all keys
    for (const keys of this.topicKeys.values()) {
      for (const key of keys) {
        key.key.fill(0);
      }
    }
    this.topicKeys.clear();

    // Wipe key exchange keys
    for (const key of this.keyExchangeKeys.values()) {
      key.fill(0);
    }
    this.keyExchangeKeys.clear();

    this.rotationSchedules.clear();
    this.emit('shutdown');
  }
}
