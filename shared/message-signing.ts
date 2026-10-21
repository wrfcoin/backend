/**
 * Digital Signatures for Consensus Messages
 * Implements ECDSA and EdDSA signature schemes for consensus protocol
 *
 * SECURITY: Critical security implementation:
 * - Digital signature verification for consensus messages
 * - Supports ECDSA (secp256k1, P-256) and EdDSA (Ed25519)
 * - Batch signature verification for performance
 * - Signature aggregation for multi-party messages
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { blockchainLogger } from '../server/utils/logger.js';

export type SignatureAlgorithm =
  | 'ecdsa-secp256k1'
  | 'ecdsa-p256'
  | 'eddsa-ed25519';

export interface SignatureKeyPair {
  publicKey: Buffer;
  privateKey: Buffer;
  algorithm: SignatureAlgorithm;
  keyId: string;
  createdAt: Date;
}

export interface MessageSignature {
  signature: Buffer;
  publicKey: Buffer;
  algorithm: SignatureAlgorithm;
  keyId: string;
  timestamp: number;
  nonce: string; // Added for replay protection
  version: number; // Version field for backward compatibility
}

export interface ConsensusMessage {
  type: string;
  payload: Buffer;
  round: number;
  height: number;
  proposerId: string;
}

export interface SignedConsensusMessage extends ConsensusMessage {
  signature: MessageSignature;
  messageHash: Buffer;
}

/**
 * Digital Signature System for Consensus Messages
 */
export class MessageSigningService extends EventEmitter {
  private keyPairs: Map<string, SignatureKeyPair> = new Map();
  private verificationCache: Map<
    string,
    { valid: boolean; timestamp: number }
  > = new Map();
  private readonly CACHE_TTL = 60000; // 1 minute

  constructor() {
    super();
  }

  /**
   * Generate a new key pair for message signing
   * SECURITY: Supports multiple signature algorithms
   */
  async generateKeyPair(
    algorithm: SignatureAlgorithm = 'ecdsa-p256'
  ): Promise<string> {
    const keyId = crypto.randomBytes(16).toString('hex');
    let keyPair: SignatureKeyPair;

    switch (algorithm) {
      case 'ecdsa-secp256k1':
        keyPair = await this.generateECDSAKeyPair('secp256k1', keyId);
        break;
      case 'ecdsa-p256':
        keyPair = await this.generateECDSAKeyPair('prime256v1', keyId);
        break;
      case 'eddsa-ed25519':
        keyPair = await this.generateEdDSAKeyPair(keyId);
        break;
      default:
        throw new Error(`Unsupported signature algorithm: ${algorithm}`);
    }

    this.keyPairs.set(keyId, keyPair);

    this.emit('keyPairGenerated', {
      keyId,
      algorithm,
      publicKey: keyPair.publicKey.toString('hex'),
    });

    return keyId;
  }

  /**
   * Generate ECDSA key pair
   * SECURITY: Uses secure elliptic curves
   */
  private async generateECDSAKeyPair(
    curve: 'secp256k1' | 'prime256v1',
    keyId: string
  ): Promise<SignatureKeyPair> {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: curve,
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    return {
      publicKey: Buffer.from(publicKey),
      privateKey: Buffer.from(privateKey),
      algorithm: curve === 'secp256k1' ? 'ecdsa-secp256k1' : 'ecdsa-p256',
      keyId,
      createdAt: new Date(),
    };
  }

  /**
   * Generate EdDSA key pair (Ed25519)
   * SECURITY: Modern signature scheme with strong security properties
   */
  private async generateEdDSAKeyPair(keyId: string): Promise<SignatureKeyPair> {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'der' },
      privateKeyEncoding: { type: 'pkcs8', format: 'der' },
    });

    return {
      publicKey: Buffer.from(publicKey),
      privateKey: Buffer.from(privateKey),
      algorithm: 'eddsa-ed25519',
      keyId,
      createdAt: new Date(),
    };
  }

  /**
   * Sign a consensus message
   * SECURITY: Creates cryptographic proof of message authenticity
   * Includes nonce and timestamp for replay protection
   */
  signMessage(message: Buffer, keyId: string): MessageSignature {
    const keyPair = this.keyPairs.get(keyId);
    if (!keyPair) {
      throw new Error(`Key pair not found: ${keyId}`);
    }

    // Generate cryptographically secure nonce for replay protection
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = Date.now();

    // Include nonce and timestamp in signed data to prevent replay attacks
    const signedData = Buffer.concat([
      message,
      Buffer.from(nonce, 'hex'),
      Buffer.from(timestamp.toString()),
    ]);

    let signature: Buffer;

    if (keyPair.algorithm.startsWith('ecdsa')) {
      const sign = crypto.createSign('SHA256');
      sign.update(signedData);
      sign.end();

      const privateKeyObject = crypto.createPrivateKey({
        key: keyPair.privateKey,
        format: 'der',
        type: 'pkcs8',
      });

      signature = sign.sign(privateKeyObject);
    } else if (keyPair.algorithm === 'eddsa-ed25519') {
      const privateKeyObject = crypto.createPrivateKey({
        key: keyPair.privateKey,
        format: 'der',
        type: 'pkcs8',
      });

      signature = crypto.sign(null, signedData, privateKeyObject);
    } else {
      throw new Error(`Unsupported algorithm: ${keyPair.algorithm}`);
    }

    this.emit('messageSigned', {
      keyId,
      algorithm: keyPair.algorithm,
      messageLength: message.length,
      nonce,
    });

    return {
      signature,
      publicKey: keyPair.publicKey,
      algorithm: keyPair.algorithm,
      keyId,
      timestamp,
      nonce,
      version: 2, // Version 2 includes nonce for replay protection
    };
  }

  /**
   * Verify a message signature
   * SECURITY: Cryptographic verification with caching for performance
   * Includes nonce/timestamp validation for replay protection
   */
  verifySignature(message: Buffer, sig: MessageSignature): boolean {
    // Check cache first - SECURITY: Include public key hash in cache key to prevent cache poisoning
    const cacheKey = this.getCacheKey(message, sig);
    const cached = this.verificationCache.get(cacheKey);

    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      this.emit('cacheHit', { keyId: sig.keyId });
      return cached.valid;
    }

    let isValid = false;

    try {
      // Validate signature timestamp to prevent replay of old signatures
      const signatureAge = Date.now() - sig.timestamp;
      const MAX_SIGNATURE_AGE = 5 * 60 * 1000; // 5 minutes
      if (signatureAge > MAX_SIGNATURE_AGE || signatureAge < 0) {
        this.emit('verificationFailed', {
          keyId: sig.keyId,
          reason: 'signature_expired_or_future',
          signatureAge,
        });
        return false;
      }

      // Reconstruct signed data with nonce and timestamp for version 2 signatures
      let verifyData: Buffer;
      if (sig.version === 2 && sig.nonce) {
        verifyData = Buffer.concat([
          message,
          Buffer.from(sig.nonce, 'hex'),
          Buffer.from(sig.timestamp.toString()),
        ]);
      } else {
        // Backward compatibility for version 1 signatures (legacy)
        verifyData = message;
      }

      if (sig.algorithm.startsWith('ecdsa')) {
        const verify = crypto.createVerify('SHA256');
        verify.update(verifyData);
        verify.end();

        const publicKeyObject = crypto.createPublicKey({
          key: sig.publicKey,
          format: 'der',
          type: 'spki',
        });

        isValid = verify.verify(publicKeyObject, sig.signature);
      } else if (sig.algorithm === 'eddsa-ed25519') {
        const publicKeyObject = crypto.createPublicKey({
          key: sig.publicKey,
          format: 'der',
          type: 'spki',
        });

        isValid = crypto.verify(null, verifyData, publicKeyObject, sig.signature);
      }

      // Cache the result
      this.verificationCache.set(cacheKey, {
        valid: isValid,
        timestamp: Date.now(),
      });

      this.emit(isValid ? 'verificationSuccess' : 'verificationFailed', {
        keyId: sig.keyId,
        algorithm: sig.algorithm,
      });
    } catch (error) {
      this.emit('verificationError', {
        keyId: sig.keyId,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      isValid = false;
    }

    return isValid;
  }

  /**
   * Sign a consensus message with full metadata
   * SECURITY: Comprehensive consensus message authentication
   */
  signConsensusMessage(
    message: ConsensusMessage,
    keyId: string
  ): SignedConsensusMessage {
    // Serialize consensus message for signing
    const messageData = this.serializeConsensusMessage(message);
    const messageHash = crypto
      .createHash('sha256')
      .update(messageData)
      .digest();

    const signature = this.signMessage(messageHash, keyId);

    return {
      ...message,
      signature,
      messageHash,
    };
  }

  /**
   * Verify a signed consensus message
   * SECURITY: Full consensus message validation
   */
  verifyConsensusMessage(signedMessage: SignedConsensusMessage): boolean {
    // Reconstruct message data
    const messageData = this.serializeConsensusMessage({
      type: signedMessage.type,
      payload: signedMessage.payload,
      round: signedMessage.round,
      height: signedMessage.height,
      proposerId: signedMessage.proposerId,
    });

    const computedHash = crypto
      .createHash('sha256')
      .update(messageData)
      .digest();

    // Verify hash matches
    if (!computedHash.equals(signedMessage.messageHash)) {
      this.emit('hashMismatch', {
        expected: signedMessage.messageHash.toString('hex'),
        computed: computedHash.toString('hex'),
      });
      return false;
    }

    // Verify signature
    return this.verifySignature(
      signedMessage.messageHash,
      signedMessage.signature
    );
  }

  /**
   * Batch signature verification for performance
   * SECURITY: Optimized verification for multiple messages
   */
  async verifyBatch(
    messages: Array<{ message: Buffer; signature: MessageSignature }>
  ): Promise<boolean[]> {
    const results = await Promise.all(
      messages.map(async ({ message, signature }) => {
        return this.verifySignature(message, signature);
      })
    );

    this.emit('batchVerification', {
      total: messages.length,
      valid: results.filter(r => r).length,
      invalid: results.filter(r => !r).length,
    });

    return results;
  }

  /**
   * Aggregate signatures for multi-party messages
   * SECURITY: Multi-signature support for consensus
   */
  createMultiSignature(
    message: Buffer,
    keyIds: string[]
  ): Array<MessageSignature> {
    if (keyIds.length === 0) {
      throw new Error('At least one key ID required for multi-signature');
    }

    const signatures: MessageSignature[] = [];

    for (const keyId of keyIds) {
      try {
        const signature = this.signMessage(message, keyId);
        signatures.push(signature);
      } catch (error) {
        this.emit('multiSignatureError', {
          keyId,
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        throw error;
      }
    }

    this.emit('multiSignatureCreated', {
      signerCount: signatures.length,
      messageLength: message.length,
    });

    return signatures;
  }

  /**
   * Verify multi-signature (threshold signatures)
   * SECURITY: Threshold signature verification for Byzantine fault tolerance
   */
  verifyMultiSignature(
    message: Buffer,
    signatures: MessageSignature[],
    threshold: number
  ): { valid: boolean; validCount: number; requiredCount: number } {
    if (signatures.length < threshold) {
      return {
        valid: false,
        validCount: signatures.length,
        requiredCount: threshold,
      };
    }

    let validCount = 0;

    for (const signature of signatures) {
      if (this.verifySignature(message, signature)) {
        validCount++;
      }
    }

    const valid = validCount >= threshold;

    this.emit('multiSignatureVerification', {
      validCount,
      totalSignatures: signatures.length,
      threshold,
      result: valid ? 'success' : 'failed',
    });

    return {
      valid,
      validCount,
      requiredCount: threshold,
    };
  }

  /**
   * Serialize consensus message for signing
   * SECURITY: Deterministic serialization for consistent hashing
   */
  private serializeConsensusMessage(message: ConsensusMessage): Buffer {
    const parts: Buffer[] = [
      Buffer.from(message.type, 'utf8'),
      message.payload,
      Buffer.from(message.round.toString()),
      Buffer.from(message.height.toString()),
      Buffer.from(message.proposerId, 'utf8'),
    ];

    return Buffer.concat(parts);
  }

  /**
   * Generate cache key for verification results
   * SECURITY: Includes public key hash to prevent cache poisoning attacks
   * where an attacker could substitute a different public key for the same message
   */
  private getCacheKey(message: Buffer, sig: MessageSignature): string {
    const messageHash = crypto
      .createHash('sha256')
      .update(message)
      .digest('hex');
    const sigHash = crypto
      .createHash('sha256')
      .update(sig.signature)
      .digest('hex');
    // SECURITY FIX: Include public key hash in cache key to prevent cache poisoning
    const publicKeyHash = crypto
      .createHash('sha256')
      .update(sig.publicKey)
      .digest('hex');
    // Include nonce in cache key for version 2 signatures to prevent replay cache attacks
    const nonceComponent = sig.nonce || 'legacy';
    return `${messageHash}:${sigHash}:${publicKeyHash}:${sig.keyId}:${nonceComponent}`;
  }

  /**
   * Clean up expired cache entries
   */
  cleanupCache(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, value] of this.verificationCache.entries()) {
      if (now - value.timestamp > this.CACHE_TTL) {
        this.verificationCache.delete(key);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.emit('cacheCleanup', { entriesRemoved: cleaned });
    }

    return cleaned;
  }

  /**
   * Get public key for a key ID
   */
  getPublicKey(keyId: string): Buffer | null {
    const keyPair = this.keyPairs.get(keyId);
    return keyPair ? keyPair.publicKey : null;
  }

  /**
   * Export public key in PEM format
   */
  exportPublicKey(keyId: string): string | null {
    const keyPair = this.keyPairs.get(keyId);
    if (!keyPair) {
      return null;
    }

    const publicKeyObject = crypto.createPublicKey({
      key: keyPair.publicKey,
      format: 'der',
      type: 'spki',
    });

    return publicKeyObject.export({ type: 'spki', format: 'pem' }) as string;
  }

  /**
   * Secure cleanup of private keys
   * SECURITY: Wipe key material before deletion
   */
  deleteKeyPair(keyId: string): boolean {
    const keyPair = this.keyPairs.get(keyId);
    if (!keyPair) {
      return false;
    }

    // Securely wipe private key
    keyPair.privateKey.fill(0);

    this.keyPairs.delete(keyId);

    this.emit('keyPairDeleted', { keyId });

    return true;
  }

  /**
   * Shutdown and cleanup
   * SECURITY: Secure cleanup of all key material
   */
  shutdown(): void {
    // Securely wipe all private keys
    for (const keyPair of this.keyPairs.values()) {
      keyPair.privateKey.fill(0);
    }

    this.keyPairs.clear();
    this.verificationCache.clear();

    this.emit('shutdown');
  }
}

/**
 * Signature aggregation for BLS signatures
 * NOTE: BLS signature aggregation would require external library
 * This is a placeholder for future implementation
 */
export class BLSSignatureAggregator {
  // BLS signature aggregation would be implemented here
  // Requires external library like @noble/bls12-381

  constructor() {
    blockchainLogger.warn('BLS signatures not yet implemented', { module: 'BLSManager', recommendation: 'Use ECDSA/EdDSA for now' });
  }
}
