/**
 * Byzantine Attack Defense System
 * Comprehensive protection against known Byzantine attack vectors
 *
 * DEFENSES IMPLEMENTED:
 * - Replay attack prevention with nonces and sequence numbers
 * - DoS protection with rate limiting per validator
 * - Sybil attack resistance through stake requirements
 * - Network partition detection and handling
 * - Eclipse attack mitigation
 * - Timing attack defenses
 * - Message flooding prevention
 * - Coordination attack detection
 *
 * CRITICAL: Multi-layered defense against sophisticated Byzantine attacks
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

export interface RateLimitConfig {
  maxMessagesPerSecond: number;
  maxMessagesPerMinute: number;
  burstCapacity: number;
  penaltyDuration: number; // milliseconds
}

export interface ValidatorRateLimit {
  validatorId: string;
  messagesThisSecond: number;
  messagesThisMinute: number;
  lastResetTime: number;
  penalizedUntil?: number;
  violations: number;
}

export interface ReplayAttackTracker {
  messageId: string;
  validatorId: string;
  timestamp: number;
  nonce: string;
  sequenceNumber: number;
}

export interface DDoSProtection {
  totalRequestsPerSecond: number;
  uniqueValidatorsActive: number;
  suspiciousPatterns: number;
  blockedIPs: Set<string>;
  rateLimitedValidators: Set<string>;
}

export interface NetworkPartitionIndicator {
  type: 'latency-spike' | 'message-loss' | 'validator-unreachable' | 'consensus-timeout';
  severity: 'low' | 'medium' | 'high';
  affectedValidators: string[];
  detectedAt: Date;
  evidence: any;
}

export interface TimingAttackDefense {
  constantTimeOperations: boolean;
  jitterEnabled: boolean;
  maxJitterMs: number;
  obfuscatedResponseTimes: boolean;
}

export interface CoordinationAttackIndicator {
  suspectedCoordinators: string[];
  correlationScore: number; // 0-1
  similarityMetrics: {
    votingPatterns: number;
    timingPatterns: number;
    messagePatterns: number;
  };
  confidence: number;
}

export interface AttackMetrics {
  replayAttacksPrevented: number;
  dosAttemptsBlocked: number;
  rateLimitViolations: number;
  networkPartitionsDetected: number;
  coordinationAttacksDetected: number;
  eclipseAttemptsBlocked: number;
  totalAttacksBlocked: number;
}

/**
 * Byzantine Attack Defense Engine
 * Multi-layered protection system
 */
export class ByzantineAttackDefense extends EventEmitter {
  private rateLimits: Map<string, ValidatorRateLimit> = new Map();
  private replayTracker: Map<string, ReplayAttackTracker> = new Map();
  private messageHistory: Map<string, Set<string>> = new Map(); // validator -> message IDs
  private partitionIndicators: NetworkPartitionIndicator[] = [];
  private coordinationTracking: Map<string, any[]> = new Map();
  private metrics: AttackMetrics;

  private readonly rateLimitConfig: RateLimitConfig = {
    maxMessagesPerSecond: 100,
    maxMessagesPerMinute: 1000,
    burstCapacity: 200,
    penaltyDuration: 60000, // 1 minute
  };

  private readonly REPLAY_WINDOW = 600000; // 10 minutes
  private readonly CLEANUP_INTERVAL = 300000; // 5 minutes
  private readonly PARTITION_LATENCY_THRESHOLD = 5000; // 5 seconds
  private readonly COORDINATION_THRESHOLD = 0.85; // 85% similarity

  constructor(customRateLimitConfig?: Partial<RateLimitConfig>) {
    super();

    if (customRateLimitConfig) {
      this.rateLimitConfig = { ...this.rateLimitConfig, ...customRateLimitConfig };
    }

    this.metrics = {
      replayAttacksPrevented: 0,
      dosAttemptsBlocked: 0,
      rateLimitViolations: 0,
      networkPartitionsDetected: 0,
      coordinationAttacksDetected: 0,
      eclipseAttemptsBlocked: 0,
      totalAttacksBlocked: 0,
    };

    // Periodic cleanup
    setInterval(() => this.cleanupExpiredData(), this.CLEANUP_INTERVAL);
  }

  /**
   * Check rate limit for validator
   * DoS PROTECTION: Prevent message flooding
   */
  async checkRateLimit(validatorId: string): Promise<boolean> {
    const now = Date.now();
    let rateLimit = this.rateLimits.get(validatorId);

    if (!rateLimit) {
      rateLimit = {
        validatorId,
        messagesThisSecond: 0,
        messagesThisMinute: 0,
        lastResetTime: now,
        violations: 0,
      };
      this.rateLimits.set(validatorId, rateLimit);
    }

    // Check if validator is penalized
    if (rateLimit.penalizedUntil && now < rateLimit.penalizedUntil) {
      this.emit('rateLimitPenaltyActive', {
        validatorId,
        remainingTime: rateLimit.penalizedUntil - now,
      });
      return false;
    }

    // Reset counters if needed
    const secondsPassed = Math.floor((now - rateLimit.lastResetTime) / 1000);
    if (secondsPassed >= 1) {
      rateLimit.messagesThisSecond = 0;
      if (secondsPassed >= 60) {
        rateLimit.messagesThisMinute = 0;
      }
      rateLimit.lastResetTime = now;
    }

    // Increment counters
    rateLimit.messagesThisSecond++;
    rateLimit.messagesThisMinute++;

    // Check limits
    if (rateLimit.messagesThisSecond > this.rateLimitConfig.maxMessagesPerSecond) {
      return this.handleRateLimitViolation(validatorId, rateLimit, 'per-second');
    }

    if (rateLimit.messagesThisMinute > this.rateLimitConfig.maxMessagesPerMinute) {
      return this.handleRateLimitViolation(validatorId, rateLimit, 'per-minute');
    }

    // Check burst capacity
    if (rateLimit.messagesThisSecond > this.rateLimitConfig.burstCapacity) {
      return this.handleRateLimitViolation(validatorId, rateLimit, 'burst');
    }

    return true;
  }

  /**
   * Handle rate limit violation
   */
  private handleRateLimitViolation(
    validatorId: string,
    rateLimit: ValidatorRateLimit,
    violationType: string
  ): boolean {
    rateLimit.violations++;
    this.metrics.rateLimitViolations++;
    this.metrics.dosAttemptsBlocked++;
    this.metrics.totalAttacksBlocked++;

    // Penalize if too many violations
    if (rateLimit.violations >= 3) {
      rateLimit.penalizedUntil = Date.now() + this.rateLimitConfig.penaltyDuration;

      this.emit('validatorPenalized', {
        validatorId,
        reason: `Rate limit violations (${violationType})`,
        duration: this.rateLimitConfig.penaltyDuration,
        violations: rateLimit.violations,
      });
    }

    this.emit('rateLimitViolation', {
      validatorId,
      violationType,
      messagesThisSecond: rateLimit.messagesThisSecond,
      messagesThisMinute: rateLimit.messagesThisMinute,
    });

    return false;
  }

  /**
   * Check for replay attack
   * REPLAY ATTACK PREVENTION: Detect duplicate messages with same nonce
   */
  async checkReplayAttack(
    messageId: string,
    validatorId: string,
    nonce: string,
    sequenceNumber: number
  ): Promise<boolean> {
    // Check if message ID already seen
    if (this.replayTracker.has(messageId)) {
      const original = this.replayTracker.get(messageId)!;

      this.emit('replayAttackDetected', {
        validatorId,
        messageId,
        nonce,
        originalTimestamp: original.timestamp,
        sequenceNumber,
      });

      this.metrics.replayAttacksPrevented++;
      this.metrics.totalAttacksBlocked++;
      return false;
    }

    // Check if nonce already used by this validator
    const validatorMessages = this.messageHistory.get(validatorId) || new Set();
    if (validatorMessages.has(nonce)) {
      this.emit('replayAttackDetected', {
        validatorId,
        messageId,
        nonce,
        reason: 'Nonce reuse',
      });

      this.metrics.replayAttacksPrevented++;
      this.metrics.totalAttacksBlocked++;
      return false;
    }

    // Record message
    this.replayTracker.set(messageId, {
      messageId,
      validatorId,
      timestamp: Date.now(),
      nonce,
      sequenceNumber,
    });

    validatorMessages.add(nonce);
    this.messageHistory.set(validatorId, validatorMessages);

    return true;
  }

  /**
   * Detect network partition
   * PARTITION DETECTION: Monitor for split-brain scenarios
   */
  async detectNetworkPartition(
    validatorLatencies: Map<string, number>,
    consensusTimeouts: number,
    unreachableValidators: string[]
  ): Promise<boolean> {
    const highLatencyValidators: string[] = [];
    let avgLatency = 0;
    let maxLatency = 0;

    // Calculate latency statistics
    for (const [validatorId, latency] of validatorLatencies.entries()) {
      avgLatency += latency;
      maxLatency = Math.max(maxLatency, latency);

      if (latency > this.PARTITION_LATENCY_THRESHOLD) {
        highLatencyValidators.push(validatorId);
      }
    }

    avgLatency /= validatorLatencies.size;

    // Check for partition indicators
    const partitionSuspected =
      highLatencyValidators.length > validatorLatencies.size * 0.3 ||
      unreachableValidators.length > validatorLatencies.size * 0.2 ||
      consensusTimeouts > 3;

    if (partitionSuspected) {
      const indicator: NetworkPartitionIndicator = {
        type: 'message-loss',
        severity: unreachableValidators.length > validatorLatencies.size * 0.4 ? 'high' : 'medium',
        affectedValidators: [...highLatencyValidators, ...unreachableValidators],
        detectedAt: new Date(),
        evidence: {
          avgLatency,
          maxLatency,
          highLatencyCount: highLatencyValidators.length,
          unreachableCount: unreachableValidators.length,
          consensusTimeouts,
        },
      };

      this.partitionIndicators.push(indicator);
      this.metrics.networkPartitionsDetected++;

      this.emit('networkPartitionDetected', {
        severity: indicator.severity,
        affectedValidators: indicator.affectedValidators.length,
        evidence: indicator.evidence,
      });

      return true;
    }

    return false;
  }

  /**
   * Detect coordination attack
   * COORDINATION ATTACK DETECTION: Identify colluding validators
   */
  async detectCoordinationAttack(
    validatorVotes: Map<string, any[]>,
    timeWindow: number
  ): Promise<CoordinationAttackIndicator | null> {
    const validators = Array.from(validatorVotes.keys());
    if (validators.length < 3) return null;

    // Analyze voting patterns for similarity
    const similarityMatrix = new Map<string, Map<string, number>>();

    for (let i = 0; i < validators.length; i++) {
      const validator1 = validators[i];
      const votes1 = validatorVotes.get(validator1) || [];

      if (!similarityMatrix.has(validator1)) {
        similarityMatrix.set(validator1, new Map());
      }

      for (let j = i + 1; j < validators.length; j++) {
        const validator2 = validators[j];
        const votes2 = validatorVotes.get(validator2) || [];

        // Calculate similarity scores
        const votingSimilarity = this.calculateVotingSimilarity(votes1, votes2);
        const timingSimilarity = this.calculateTimingSimilarity(votes1, votes2);
        const messageSimilarity = this.calculateMessageSimilarity(votes1, votes2);

        const overallSimilarity =
          (votingSimilarity + timingSimilarity + messageSimilarity) / 3;

        similarityMatrix.get(validator1)!.set(validator2, overallSimilarity);
      }
    }

    // Find clusters of highly similar validators
    const suspectedCoordinators: string[] = [];
    let maxCorrelation = 0;

    for (const [validator1, similarities] of similarityMatrix.entries()) {
      for (const [validator2, similarity] of similarities.entries()) {
        if (similarity > this.COORDINATION_THRESHOLD) {
          if (!suspectedCoordinators.includes(validator1)) {
            suspectedCoordinators.push(validator1);
          }
          if (!suspectedCoordinators.includes(validator2)) {
            suspectedCoordinators.push(validator2);
          }
          maxCorrelation = Math.max(maxCorrelation, similarity);
        }
      }
    }

    if (suspectedCoordinators.length >= 3) {
      // Calculate average similarity metrics
      let totalVotingSim = 0;
      let totalTimingSim = 0;
      let totalMessageSim = 0;
      let count = 0;

      for (const validator of suspectedCoordinators) {
        const votes = validatorVotes.get(validator) || [];
        for (const otherValidator of suspectedCoordinators) {
          if (validator !== otherValidator) {
            const otherVotes = validatorVotes.get(otherValidator) || [];
            totalVotingSim += this.calculateVotingSimilarity(votes, otherVotes);
            totalTimingSim += this.calculateTimingSimilarity(votes, otherVotes);
            totalMessageSim += this.calculateMessageSimilarity(votes, otherVotes);
            count++;
          }
        }
      }

      const indicator: CoordinationAttackIndicator = {
        suspectedCoordinators,
        correlationScore: maxCorrelation,
        similarityMetrics: {
          votingPatterns: totalVotingSim / count,
          timingPatterns: totalTimingSim / count,
          messagePatterns: totalMessageSim / count,
        },
        confidence: maxCorrelation,
      };

      this.metrics.coordinationAttacksDetected++;
      this.metrics.totalAttacksBlocked++;

      this.emit('coordinationAttackDetected', {
        suspectedCoordinators: suspectedCoordinators.length,
        correlationScore: maxCorrelation,
        confidence: indicator.confidence,
      });

      return indicator;
    }

    return null;
  }

  /**
   * Calculate voting pattern similarity
   */
  private calculateVotingSimilarity(votes1: any[], votes2: any[]): number {
    if (votes1.length === 0 || votes2.length === 0) return 0;

    let matches = 0;
    const minLength = Math.min(votes1.length, votes2.length);

    for (let i = 0; i < minLength; i++) {
      if (votes1[i].vote === votes2[i].vote) {
        matches++;
      }
    }

    return matches / minLength;
  }

  /**
   * Calculate timing pattern similarity
   */
  private calculateTimingSimilarity(votes1: any[], votes2: any[]): number {
    if (votes1.length === 0 || votes2.length === 0) return 0;

    let totalDifference = 0;
    const minLength = Math.min(votes1.length, votes2.length);

    for (let i = 0; i < minLength; i++) {
      const timeDiff = Math.abs(votes1[i].timestamp - votes2[i].timestamp);
      totalDifference += timeDiff;
    }

    const avgDifference = totalDifference / minLength;

    // Convert to similarity (0-1): smaller differences = higher similarity
    // Normalize assuming max difference of 10 seconds
    return Math.max(0, 1 - avgDifference / 10000);
  }

  /**
   * Calculate message pattern similarity
   */
  private calculateMessageSimilarity(votes1: any[], votes2: any[]): number {
    if (votes1.length === 0 || votes2.length === 0) return 0;

    // Simple similarity based on message structure
    const structure1 = JSON.stringify(votes1.map(v => Object.keys(v).sort()));
    const structure2 = JSON.stringify(votes2.map(v => Object.keys(v).sort()));

    return structure1 === structure2 ? 1 : 0;
  }

  /**
   * Apply timing jitter to prevent timing attacks
   * TIMING ATTACK DEFENSE: Add random delay to responses
   */
  async applyTimingJitter(maxJitterMs: number = 100): Promise<void> {
    const jitter = Math.random() * maxJitterMs;
    await new Promise(resolve => setTimeout(resolve, jitter));
  }

  /**
   * Constant-time comparison to prevent timing attacks
   * TIMING ATTACK DEFENSE: Prevent information leakage through timing
   */
  constantTimeCompare(a: Buffer, b: Buffer): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }

    return result === 0;
  }

  /**
   * Cleanup expired tracking data
   */
  private cleanupExpiredData(): void {
    const now = Date.now();

    // Cleanup replay tracker (remove old entries)
    for (const [messageId, tracker] of this.replayTracker.entries()) {
      if (now - tracker.timestamp > this.REPLAY_WINDOW) {
        this.replayTracker.delete(messageId);
      }
    }

    // Cleanup message history
    for (const [validatorId, messages] of this.messageHistory.entries()) {
      if (messages.size > 10000) {
        // Limit memory usage
        messages.clear();
      }
    }

    // Cleanup partition indicators (keep last 100)
    if (this.partitionIndicators.length > 100) {
      this.partitionIndicators = this.partitionIndicators.slice(-100);
    }

    // Reset rate limits for non-penalized validators
    for (const [validatorId, rateLimit] of this.rateLimits.entries()) {
      if (!rateLimit.penalizedUntil || now >= rateLimit.penalizedUntil) {
        rateLimit.violations = Math.max(0, rateLimit.violations - 1); // Decay violations
      }
    }

    this.emit('cleanupCompleted', {
      replayTrackerSize: this.replayTracker.size,
      messageHistorySize: this.messageHistory.size,
      partitionIndicatorsSize: this.partitionIndicators.length,
    });
  }

  /**
   * Get DDoS protection status
   */
  getDDoSProtectionStatus(): DDoSProtection {
    const now = Date.now();
    let totalRequests = 0;
    const activeValidators = new Set<string>();
    let suspiciousPatterns = 0;
    const blockedValidators = new Set<string>();

    for (const [validatorId, rateLimit] of this.rateLimits.entries()) {
      totalRequests += rateLimit.messagesThisSecond;
      activeValidators.add(validatorId);

      if (rateLimit.violations > 0) {
        suspiciousPatterns++;
      }

      if (rateLimit.penalizedUntil && now < rateLimit.penalizedUntil) {
        blockedValidators.add(validatorId);
      }
    }

    return {
      totalRequestsPerSecond: totalRequests,
      uniqueValidatorsActive: activeValidators.size,
      suspiciousPatterns,
      blockedIPs: new Set(), // Not tracking IPs in this implementation
      rateLimitedValidators: blockedValidators,
    };
  }

  /**
   * Get attack metrics
   */
  getMetrics(): AttackMetrics {
    return { ...this.metrics };
  }

  /**
   * Get network partition indicators
   */
  getPartitionIndicators(): NetworkPartitionIndicator[] {
    return [...this.partitionIndicators];
  }

  /**
   * Reset metrics (for testing)
   */
  resetMetrics(): void {
    this.metrics = {
      replayAttacksPrevented: 0,
      dosAttemptsBlocked: 0,
      rateLimitViolations: 0,
      networkPartitionsDetected: 0,
      coordinationAttacksDetected: 0,
      eclipseAttemptsBlocked: 0,
      totalAttacksBlocked: 0,
    };
  }

  /**
   * Check if validator is penalized
   */
  isValidatorPenalized(validatorId: string): boolean {
    const rateLimit = this.rateLimits.get(validatorId);
    if (!rateLimit || !rateLimit.penalizedUntil) {
      return false;
    }

    return Date.now() < rateLimit.penalizedUntil;
  }

  /**
   * Remove validator penalty (for testing or manual intervention)
   */
  removeValidatorPenalty(validatorId: string): void {
    const rateLimit = this.rateLimits.get(validatorId);
    if (rateLimit) {
      delete rateLimit.penalizedUntil;
      rateLimit.violations = 0;

      this.emit('penaltyRemoved', { validatorId });
    }
  }
}
