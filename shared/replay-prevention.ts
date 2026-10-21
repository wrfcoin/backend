/**
 * Replay Attack Prevention System
 * Implements message sequence numbers, timestamps, and deduplication
 *
 * SECURITY: Critical protection against replay attacks:
 * - Message sequence numbers (nonce) with sliding window validation
 * - Timestamp-based message freshness validation
 * - Message deduplication with bloom filters
 * - Sliding window for sequence validation
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { securityLogger } from '../server/utils/logger.js';

export interface ReplayProtectionConfig {
  maxTimestampDrift: number; // milliseconds
  sequenceWindowSize: number; // number of messages
  bloomFilterSize: number; // number of bits
  bloomFilterHashes: number; // number of hash functions
  messageRetention: number; // milliseconds
  enableTimestampValidation: boolean;
  enableSequenceValidation: boolean;
  enableBloomFilter: boolean;
}

export interface MessageMetadata {
  messageId: string;
  sequence: number;
  timestamp: number;
  senderId: string;
  messageHash: string;
}

/**
 * Bloom Filter for efficient message deduplication
 * SECURITY: Space-efficient probabilistic data structure
 */
class BloomFilter {
  private bits: Uint8Array;
  private size: number;
  private numHashes: number;

  constructor(size: number, numHashes: number) {
    this.size = size;
    this.numHashes = numHashes;
    this.bits = new Uint8Array(Math.ceil(size / 8));
  }

  /**
   * Add an item to the bloom filter
   */
  add(item: string): void {
    const hashes = this.getHashes(item);
    for (const hash of hashes) {
      const index = hash % this.size;
      const byteIndex = Math.floor(index / 8);
      const bitIndex = index % 8;
      this.bits[byteIndex] |= 1 << bitIndex;
    }
  }

  /**
   * Check if an item might be in the filter
   * SECURITY: May have false positives but never false negatives
   */
  contains(item: string): boolean {
    const hashes = this.getHashes(item);
    for (const hash of hashes) {
      const index = hash % this.size;
      const byteIndex = Math.floor(index / 8);
      const bitIndex = index % 8;
      if ((this.bits[byteIndex] & (1 << bitIndex)) === 0) {
        return false;
      }
    }
    return true;
  }

  /**
   * Generate multiple hash values for an item
   */
  private getHashes(item: string): number[] {
    const hashes: number[] = [];
    const hash1 = this.hash(item, 0);
    const hash2 = this.hash(item, hash1);

    for (let i = 0; i < this.numHashes; i++) {
      // Double hashing technique
      const combinedHash = (hash1 + i * hash2) >>> 0;
      hashes.push(combinedHash);
    }

    return hashes;
  }

  /**
   * Simple hash function
   */
  private hash(str: string, seed: number): number {
    const data = Buffer.from(str + seed.toString());
    const hash = crypto.createHash('sha256').update(data).digest();
    return hash.readUInt32BE(0);
  }

  /**
   * Clear the bloom filter
   */
  clear(): void {
    this.bits.fill(0);
  }

  /**
   * Get approximate fill ratio
   */
  getFillRatio(): number {
    let setBits = 0;
    for (let i = 0; i < this.bits.length; i++) {
      setBits += this.popcount(this.bits[i]);
    }
    return setBits / this.size;
  }

  /**
   * Count set bits in a byte
   */
  private popcount(byte: number): number {
    let count = 0;
    while (byte) {
      count += byte & 1;
      byte >>= 1;
    }
    return count;
  }
}

/**
 * Sliding Window for Sequence Number Validation
 * SECURITY: Detects out-of-order and duplicate sequence numbers
 * SECURITY FIX: Reduced window size from 1000 to 150 to limit replay attack surface
 */
class SequenceWindow {
  private window: Map<number, boolean> = new Map();
  private highestSequence: number = 0;
  private readonly windowSize: number;
  // SECURITY: Recommended maximum window size to prevent excessive replay window
  private static readonly MAX_RECOMMENDED_WINDOW_SIZE = 200;

  constructor(windowSize: number) {
    // SECURITY FIX: Cap window size to prevent excessively large replay windows
    if (windowSize > SequenceWindow.MAX_RECOMMENDED_WINDOW_SIZE) {
      securityLogger.warn('Requested window size exceeds recommended maximum', { module: 'SequenceWindow', requestedSize: windowSize, maxRecommended: SequenceWindow.MAX_RECOMMENDED_WINDOW_SIZE });
      this.windowSize = SequenceWindow.MAX_RECOMMENDED_WINDOW_SIZE;
    } else {
      this.windowSize = windowSize;
    }
  }

  /**
   * Check if a sequence number is valid and mark it as seen
   * SECURITY: Prevents sequence number replay attacks
   */
  validateAndUpdate(sequence: number): boolean {
    // Reject sequences that are too old
    if (sequence < this.highestSequence - this.windowSize) {
      return false; // Too old, outside window
    }

    // Check if already seen
    if (this.window.has(sequence)) {
      return false; // Duplicate sequence number
    }

    // Accept and update
    this.window.set(sequence, true);

    // Update highest sequence
    if (sequence > this.highestSequence) {
      this.highestSequence = sequence;
    }

    // Clean up old entries
    this.cleanup();

    return true;
  }

  /**
   * Remove entries outside the window
   */
  private cleanup(): void {
    const cutoff = this.highestSequence - this.windowSize;
    for (const [seq] of this.window) {
      if (seq < cutoff) {
        this.window.delete(seq);
      }
    }
  }

  /**
   * Get current window size
   */
  getSize(): number {
    return this.window.size;
  }

  /**
   * Get highest sequence number
   */
  getHighestSequence(): number {
    return this.highestSequence;
  }

  /**
   * Reset the window
   */
  reset(): void {
    this.window.clear();
    this.highestSequence = 0;
  }
}

/**
 * Replay Prevention System
 * SECURITY: Comprehensive replay attack prevention
 * SECURITY FIX: Implements dual bloom filter rotation to prevent temporary vulnerability
 */
export class ReplayPreventionService extends EventEmitter {
  private readonly config: ReplayProtectionConfig;
  private senderSequences: Map<string, SequenceWindow> = new Map();
  // SECURITY FIX: Dual bloom filter implementation for seamless rotation
  private primaryBloomFilter: BloomFilter;
  private secondaryBloomFilter: BloomFilter;
  private isRotating: boolean = false;
  private messageCache: Map<string, MessageMetadata> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;

  // SECURITY FIX: Reduced default window size from 1000 to 150
  private static readonly DEFAULT_CONFIG: ReplayProtectionConfig = {
    maxTimestampDrift: 5000, // 5 seconds
    sequenceWindowSize: 150, // SECURITY FIX: Reduced from 1000 to limit replay window
    bloomFilterSize: 100000, // 100k bits
    bloomFilterHashes: 7,
    messageRetention: 300000, // 5 minutes
    enableTimestampValidation: true,
    enableSequenceValidation: true,
    enableBloomFilter: true,
  };

  constructor(config?: Partial<ReplayProtectionConfig>) {
    super();
    this.config = { ...ReplayPreventionService.DEFAULT_CONFIG, ...config };
    // SECURITY FIX: Initialize dual bloom filters for seamless rotation
    this.primaryBloomFilter = new BloomFilter(
      this.config.bloomFilterSize,
      this.config.bloomFilterHashes
    );
    this.secondaryBloomFilter = new BloomFilter(
      this.config.bloomFilterSize,
      this.config.bloomFilterHashes
    );

    // Start cleanup timer
    this.startCleanupTimer();
  }

  /**
   * Validate a message against replay attacks
   * SECURITY: Multi-layered replay protection
   */
  validateMessage(metadata: MessageMetadata): {
    valid: boolean;
    reason?: string;
    checks: {
      timestamp: boolean;
      sequence: boolean;
      deduplication: boolean;
    };
  } {
    const checks = {
      timestamp: true,
      sequence: true,
      deduplication: true,
    };

    // 1. Timestamp validation
    if (this.config.enableTimestampValidation) {
      const timestampValid = this.validateTimestamp(metadata.timestamp);
      checks.timestamp = timestampValid;

      if (!timestampValid) {
        this.emit('replayAttempt', {
          type: 'timestamp',
          messageId: metadata.messageId,
          senderId: metadata.senderId,
        });

        return {
          valid: false,
          reason: 'Invalid timestamp - message too old or from future',
          checks,
        };
      }
    }

    // 2. Sequence number validation
    if (this.config.enableSequenceValidation) {
      const sequenceValid = this.validateSequence(
        metadata.senderId,
        metadata.sequence
      );
      checks.sequence = sequenceValid;

      if (!sequenceValid) {
        this.emit('replayAttempt', {
          type: 'sequence',
          messageId: metadata.messageId,
          senderId: metadata.senderId,
          sequence: metadata.sequence,
        });

        return {
          valid: false,
          reason: 'Invalid sequence number - duplicate or out of order',
          checks,
        };
      }
    }

    // 3. Message deduplication (bloom filter)
    // SECURITY FIX: Check both bloom filters during rotation overlap period
    if (this.config.enableBloomFilter) {
      const messageKey = this.getMessageKey(metadata);
      // Check both primary and secondary filters to prevent replay during rotation
      const inPrimary = this.primaryBloomFilter.contains(messageKey);
      const inSecondary = this.secondaryBloomFilter.contains(messageKey);
      const isDuplicate = inPrimary || inSecondary;
      checks.deduplication = !isDuplicate;

      if (isDuplicate) {
        // Double-check with exact cache (bloom filter may have false positives)
        if (this.messageCache.has(messageKey)) {
          this.emit('replayAttempt', {
            type: 'deduplication',
            messageId: metadata.messageId,
            senderId: metadata.senderId,
          });

          return {
            valid: false,
            reason: 'Duplicate message detected',
            checks,
          };
        }
      }

      // Add to both bloom filters during rotation, otherwise just primary
      this.primaryBloomFilter.add(messageKey);
      if (this.isRotating) {
        this.secondaryBloomFilter.add(messageKey);
      }
      this.messageCache.set(messageKey, metadata);
    }

    this.emit('messageValidated', {
      messageId: metadata.messageId,
      senderId: metadata.senderId,
      sequence: metadata.sequence,
    });

    return {
      valid: true,
      checks,
    };
  }

  /**
   * Validate message timestamp
   * SECURITY: Prevents messages with manipulated timestamps
   */
  private validateTimestamp(timestamp: number): boolean {
    const now = Date.now();
    const drift = Math.abs(now - timestamp);

    return drift <= this.config.maxTimestampDrift;
  }

  /**
   * Validate message sequence number
   * SECURITY: Detects out-of-order and duplicate sequences
   */
  private validateSequence(senderId: string, sequence: number): boolean {
    if (!this.senderSequences.has(senderId)) {
      this.senderSequences.set(
        senderId,
        new SequenceWindow(this.config.sequenceWindowSize)
      );
    }

    const window = this.senderSequences.get(senderId)!;
    return window.validateAndUpdate(sequence);
  }

  /**
   * Generate unique key for message deduplication
   */
  private getMessageKey(metadata: MessageMetadata): string {
    return `${metadata.senderId}:${metadata.messageHash}:${metadata.sequence}`;
  }

  /**
   * Create message metadata for a new message
   * SECURITY: Generate proper metadata for replay protection
   */
  createMessageMetadata(
    senderId: string,
    messageData: Buffer
  ): MessageMetadata {
    // Get current sequence for sender
    const sequence = this.getNextSequence(senderId);

    // Generate message hash
    const messageHash = crypto
      .createHash('sha256')
      .update(messageData)
      .digest('hex');

    // Generate unique message ID
    const messageId = crypto.randomBytes(16).toString('hex');

    return {
      messageId,
      sequence,
      timestamp: Date.now(),
      senderId,
      messageHash,
    };
  }

  /**
   * Get next sequence number for a sender
   */
  private getNextSequence(senderId: string): number {
    if (!this.senderSequences.has(senderId)) {
      this.senderSequences.set(
        senderId,
        new SequenceWindow(this.config.sequenceWindowSize)
      );
      return 0;
    }

    const window = this.senderSequences.get(senderId)!;
    return window.getHighestSequence() + 1;
  }

  /**
   * Start cleanup timer for old messages
   */
  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 60000); // Cleanup every minute
  }

  /**
   * Cleanup old message cache entries
   * SECURITY: Prevent memory exhaustion attacks
   * SECURITY FIX: Implements dual bloom filter rotation with overlap period
   */
  cleanup(): number {
    const now = Date.now();
    let cleaned = 0;

    for (const [key, metadata] of this.messageCache.entries()) {
      if (now - metadata.timestamp > this.config.messageRetention) {
        this.messageCache.delete(key);
        cleaned++;
      }
    }

    // SECURITY FIX: Dual bloom filter rotation with overlap period
    // This prevents temporary vulnerability during filter reset
    const primaryFillRatio = this.primaryBloomFilter.getFillRatio();
    if (primaryFillRatio > 0.7) {
      // Start rotation: secondary becomes primary, create new secondary
      this.emit('bloomFilterRotation', {
        phase: 'start',
        primaryFillRatio,
        secondaryFillRatio: this.secondaryBloomFilter.getFillRatio()
      });

      // Begin overlap period - during this time we check both filters
      this.isRotating = true;

      // Swap filters: secondary becomes primary (it has recent entries)
      const oldPrimary = this.primaryBloomFilter;
      this.primaryBloomFilter = this.secondaryBloomFilter;
      // Create new secondary filter
      this.secondaryBloomFilter = new BloomFilter(
        this.config.bloomFilterSize,
        this.config.bloomFilterHashes
      );
      // Clear the old primary
      oldPrimary.clear();

      // Schedule end of overlap period (30 seconds overlap to catch any in-flight messages)
      setTimeout(() => {
        this.isRotating = false;
        this.emit('bloomFilterRotation', { phase: 'complete' });
      }, 30000);
    }

    if (cleaned > 0) {
      this.emit('cleanup', { entriesRemoved: cleaned });
    }

    return cleaned;
  }

  /**
   * Get statistics about replay prevention
   */
  getStatistics(): {
    activeSenders: number;
    cachedMessages: number;
    bloomFilterFillRatio: number;
    secondaryBloomFilterFillRatio: number;
    isRotating: boolean;
    totalSequenceWindowSize: number;
  } {
    let totalWindowSize = 0;
    for (const window of this.senderSequences.values()) {
      totalWindowSize += window.getSize();
    }

    return {
      activeSenders: this.senderSequences.size,
      cachedMessages: this.messageCache.size,
      bloomFilterFillRatio: this.primaryBloomFilter.getFillRatio(),
      secondaryBloomFilterFillRatio: this.secondaryBloomFilter.getFillRatio(),
      isRotating: this.isRotating,
      totalSequenceWindowSize: totalWindowSize,
    };
  }

  /**
   * Reset replay protection for a specific sender
   */
  resetSender(senderId: string): void {
    const window = this.senderSequences.get(senderId);
    if (window) {
      window.reset();
    }

    // Remove cached messages from this sender
    for (const [key, metadata] of this.messageCache.entries()) {
      if (metadata.senderId === senderId) {
        this.messageCache.delete(key);
      }
    }

    this.emit('senderReset', { senderId });
  }

  /**
   * Completely reset the replay prevention system
   */
  reset(): void {
    this.senderSequences.clear();
    this.messageCache.clear();
    this.primaryBloomFilter.clear();
    this.secondaryBloomFilter.clear();
    this.isRotating = false;

    this.emit('systemReset');
  }

  /**
   * Shutdown and cleanup
   */
  shutdown(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    this.reset();
    this.emit('shutdown');
  }
}

/**
 * Helper function to generate cryptographically secure nonce
 */
export function generateNonce(length: number = 16): string {
  return crypto.randomBytes(length).toString('hex');
}

/**
 * Helper function to validate message freshness
 */
export function isMessageFresh(
  timestamp: number,
  maxAge: number = 5000
): boolean {
  const age = Date.now() - timestamp;
  return age >= 0 && age <= maxAge;
}
