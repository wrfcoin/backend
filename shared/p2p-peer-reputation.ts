/**
 * P2P Peer Reputation System
 * Implements peer behavior scoring and trust management
 *
 * SECURITY: Addresses Task 100.10 vulnerabilities:
 * - Peer behavior scoring system (0-100 scale)
 * - Trust level classification
 * - Reputation decay over time for inactive peers
 * - Multi-metric evaluation
 * - Reputation-based rate limiting and prioritization
 * - Protection against reputation gaming and poisoning
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

export interface ReputationMetrics {
  messageValidity: number; // 0-100
  uptime: number; // percentage
  responseTime: number; // milliseconds
  bandwidthContribution: number; // bytes
  successfulInteractions: number;
  failedInteractions: number;
  lastUpdated: Date;
}

export interface PeerReputation {
  peerId: string;
  score: number; // 0-100
  trustLevel: 'untrusted' | 'low' | 'neutral' | 'trusted' | 'highly_trusted';
  metrics: ReputationMetrics;
  firstSeen: Date;
  lastSeen: Date;
  reportCount: number; // Number of negative reports
  bannedUntil?: Date;
  metadata: {
    version: string;
    tags: string[];
  };
}

export interface ReputationConfig {
  initialScore: number;
  decayRate: number; // points per hour for inactive peers
  decayInterval: number; // milliseconds
  minScoreThreshold: number; // minimum score to accept messages
  banThreshold: number; // score below which peer is banned
  banDuration: number; // milliseconds
  maxReports: number; // max negative reports before auto-ban
  scoreWeights: {
    messageValidity: number;
    uptime: number;
    responseTime: number;
    bandwidthContribution: number;
  };
}

export interface ReputationEvent {
  peerId: string;
  eventType:
    | 'valid_message'
    | 'invalid_message'
    | 'timeout'
    | 'successful_interaction'
    | 'failed_interaction'
    | 'bandwidth_contribution'
    | 'malicious_behavior';
  impactPoints: number;
  metadata?: Record<string, any>;
  timestamp: Date;
}

/**
 * Peer Reputation Service
 * SECURITY: Dynamic trust management based on behavior
 */
export class PeerReputationService extends EventEmitter {
  private reputations: Map<string, PeerReputation> = new Map();
  private readonly config: ReputationConfig;
  private decayTimer: NodeJS.Timeout | null = null;
  private eventHistory: Map<string, ReputationEvent[]> = new Map();

  private static readonly DEFAULT_CONFIG: ReputationConfig = {
    initialScore: 50,
    decayRate: 1, // 1 point per hour
    decayInterval: 3600000, // 1 hour
    minScoreThreshold: 30,
    banThreshold: 10,
    banDuration: 24 * 60 * 60 * 1000, // 24 hours
    maxReports: 5,
    scoreWeights: {
      messageValidity: 0.4,
      uptime: 0.2,
      responseTime: 0.2,
      bandwidthContribution: 0.2,
    },
  };

  constructor(config?: Partial<ReputationConfig>) {
    super();
    this.config = { ...PeerReputationService.DEFAULT_CONFIG, ...config };
    this.startDecayTimer();
  }

  /**
   * Register new peer
   */
  registerPeer(peerId: string, tags: string[] = []): PeerReputation {
    if (this.reputations.has(peerId)) {
      return this.reputations.get(peerId)!;
    }

    const now = new Date();
    const reputation: PeerReputation = {
      peerId,
      score: this.config.initialScore,
      trustLevel: 'neutral',
      metrics: {
        messageValidity: 100,
        uptime: 0,
        responseTime: 0,
        bandwidthContribution: 0,
        successfulInteractions: 0,
        failedInteractions: 0,
        lastUpdated: now,
      },
      firstSeen: now,
      lastSeen: now,
      reportCount: 0,
      metadata: {
        version: '1.0',
        tags,
      },
    };

    this.reputations.set(peerId, reputation);
    this.eventHistory.set(peerId, []);

    this.emit('peerRegistered', { peerId, initialScore: reputation.score });

    return reputation;
  }

  /**
   * Record reputation event
   * SECURITY: Update reputation based on peer behavior
   */
  recordEvent(event: Omit<ReputationEvent, 'timestamp'>): void {
    const reputation = this.reputations.get(event.peerId);
    if (!reputation) {
      // Auto-register unknown peer with lower initial score
      this.registerPeer(event.peerId);
      return this.recordEvent(event);
    }

    const fullEvent: ReputationEvent = {
      ...event,
      timestamp: new Date(),
    };

    // Store event in history
    const history = this.eventHistory.get(event.peerId) || [];
    history.push(fullEvent);

    // Keep last 100 events
    if (history.length > 100) {
      history.shift();
    }
    this.eventHistory.set(event.peerId, history);

    // Update reputation score
    this.updateReputationScore(reputation, fullEvent);

    // Update last seen
    reputation.lastSeen = new Date();

    this.emit('eventRecorded', {
      peerId: event.peerId,
      eventType: event.eventType,
      newScore: reputation.score,
      trustLevel: reputation.trustLevel,
    });
  }

  /**
   * Update reputation score based on event
   */
  private updateReputationScore(reputation: PeerReputation, event: ReputationEvent): void {
    const oldScore = reputation.score;

    // Apply event impact
    reputation.score = Math.max(0, Math.min(100, reputation.score + event.impactPoints));

    // Update specific metrics based on event type
    switch (event.eventType) {
      case 'valid_message':
        reputation.metrics.messageValidity = Math.min(
          100,
          reputation.metrics.messageValidity + 1
        );
        reputation.metrics.successfulInteractions++;
        break;

      case 'invalid_message':
        reputation.metrics.messageValidity = Math.max(
          0,
          reputation.metrics.messageValidity - 5
        );
        reputation.metrics.failedInteractions++;
        break;

      case 'timeout':
        reputation.metrics.failedInteractions++;
        break;

      case 'successful_interaction':
        reputation.metrics.successfulInteractions++;
        break;

      case 'failed_interaction':
        reputation.metrics.failedInteractions++;
        break;

      case 'bandwidth_contribution':
        if (event.metadata?.bytes) {
          reputation.metrics.bandwidthContribution += event.metadata.bytes;
        }
        break;

      case 'malicious_behavior':
        reputation.reportCount++;
        // Significant penalty for malicious behavior
        reputation.score = Math.max(0, reputation.score - 20);
        break;
    }

    // Update trust level based on score
    reputation.trustLevel = this.calculateTrustLevel(reputation.score);

    // Check if peer should be banned
    if (
      reputation.score < this.config.banThreshold ||
      reputation.reportCount >= this.config.maxReports
    ) {
      this.banPeer(reputation.peerId, 'Low reputation score or excessive reports');
    }

    reputation.metrics.lastUpdated = new Date();

    this.emit('reputationUpdated', {
      peerId: reputation.peerId,
      oldScore,
      newScore: reputation.score,
      oldTrustLevel: this.calculateTrustLevel(oldScore),
      newTrustLevel: reputation.trustLevel,
      delta: event.impactPoints,
    });
  }

  /**
   * Calculate trust level from reputation score
   */
  private calculateTrustLevel(score: number): PeerReputation['trustLevel'] {
    if (score >= 90) return 'highly_trusted';
    if (score >= 70) return 'trusted';
    if (score >= 40) return 'neutral';
    if (score >= 20) return 'low';
    return 'untrusted';
  }

  /**
   * Get peer reputation
   */
  getReputation(peerId: string): PeerReputation | null {
    return this.reputations.get(peerId) || null;
  }

  /**
   * Check if peer meets minimum reputation threshold
   */
  isReputationAcceptable(peerId: string): boolean {
    const reputation = this.reputations.get(peerId);
    if (!reputation) {
      return false;
    }

    // Check if banned
    if (reputation.bannedUntil && new Date() < reputation.bannedUntil) {
      return false;
    }

    return reputation.score >= this.config.minScoreThreshold;
  }

  /**
   * Ban peer
   * SECURITY: Isolate malicious peers
   */
  banPeer(peerId: string, reason: string): boolean {
    const reputation = this.reputations.get(peerId);
    if (!reputation) {
      return false;
    }

    reputation.bannedUntil = new Date(Date.now() + this.config.banDuration);
    reputation.score = 0;
    reputation.trustLevel = 'untrusted';

    this.emit('peerBanned', {
      peerId,
      reason,
      bannedUntil: reputation.bannedUntil,
    });

    return true;
  }

  /**
   * Unban peer
   */
  unbanPeer(peerId: string): boolean {
    const reputation = this.reputations.get(peerId);
    if (!reputation) {
      return false;
    }

    reputation.bannedUntil = undefined;
    reputation.score = this.config.initialScore;
    reputation.trustLevel = this.calculateTrustLevel(reputation.score);
    reputation.reportCount = 0;

    this.emit('peerUnbanned', { peerId });

    return true;
  }

  /**
   * Report malicious peer
   */
  reportPeer(peerId: string, reason: string, evidence?: any): void {
    this.recordEvent({
      peerId,
      eventType: 'malicious_behavior',
      impactPoints: -20,
      metadata: { reason, evidence },
    });

    this.emit('peerReported', {
      peerId,
      reason,
      reportCount: this.reputations.get(peerId)?.reportCount || 0,
    });
  }

  /**
   * Calculate composite reputation score
   * SECURITY: Multi-metric weighted scoring
   */
  calculateCompositeScore(peerId: string): number {
    const reputation = this.reputations.get(peerId);
    if (!reputation) {
      return 0;
    }

    const { metrics } = reputation;
    const { scoreWeights } = this.config;

    // Normalize metrics to 0-100 scale
    const normalizedUptime = Math.min(100, metrics.uptime);
    const normalizedResponseTime = Math.max(
      0,
      100 - Math.min(100, metrics.responseTime / 10)
    ); // Lower is better
    const normalizedBandwidth = Math.min(
      100,
      (metrics.bandwidthContribution / (1024 * 1024)) * 10
    ); // 10MB = 100 points

    // Calculate weighted average
    const compositeScore =
      metrics.messageValidity * scoreWeights.messageValidity +
      normalizedUptime * scoreWeights.uptime +
      normalizedResponseTime * scoreWeights.responseTime +
      normalizedBandwidth * scoreWeights.bandwidthContribution;

    return Math.round(compositeScore);
  }

  /**
   * Get reputation-based rate limit
   * SECURITY: Higher reputation = higher rate limits
   */
  getRateLimit(peerId: string): {
    messagesPerSecond: number;
    burstSize: number;
    priority: 'low' | 'normal' | 'high' | 'critical';
  } {
    const reputation = this.reputations.get(peerId);
    if (!reputation) {
      return {
        messagesPerSecond: 1,
        burstSize: 5,
        priority: 'low',
      };
    }

    const score = reputation.score;
    const trustLevel = reputation.trustLevel;

    // Rate limits based on trust level
    const rateLimits = {
      highly_trusted: { mps: 100, burst: 500, priority: 'critical' as const },
      trusted: { mps: 50, burst: 200, priority: 'high' as const },
      neutral: { mps: 20, burst: 50, priority: 'normal' as const },
      low: { mps: 5, burst: 10, priority: 'low' as const },
      untrusted: { mps: 1, burst: 5, priority: 'low' as const },
    };

    return {
      messagesPerSecond: rateLimits[trustLevel].mps,
      burstSize: rateLimits[trustLevel].burst,
      priority: rateLimits[trustLevel].priority,
    };
  }

  /**
   * Apply reputation decay for inactive peers
   * SECURITY: Prevent stale high reputation scores
   */
  private applyReputationDecay(): void {
    const now = new Date();
    const hoursSinceLastDecay = 1; // Called every hour

    for (const reputation of this.reputations.values()) {
      // Skip banned peers
      if (reputation.bannedUntil && now < reputation.bannedUntil) {
        continue;
      }

      const hoursSinceLastSeen =
        (now.getTime() - reputation.lastSeen.getTime()) / (1000 * 60 * 60);

      // Only decay if inactive for more than 1 hour
      if (hoursSinceLastSeen > 1) {
        const decay = this.config.decayRate * hoursSinceLastDecay;
        const oldScore = reputation.score;

        reputation.score = Math.max(
          this.config.initialScore,
          reputation.score - decay
        );

        // Update trust level if score changed significantly
        if (Math.abs(oldScore - reputation.score) >= 10) {
          const oldTrustLevel = reputation.trustLevel;
          reputation.trustLevel = this.calculateTrustLevel(reputation.score);

          if (oldTrustLevel !== reputation.trustLevel) {
            this.emit('trustLevelChanged', {
              peerId: reputation.peerId,
              oldLevel: oldTrustLevel,
              newLevel: reputation.trustLevel,
              reason: 'decay',
            });
          }
        }
      }
    }
  }

  /**
   * Get peer ranking
   * SECURITY: Identify most trustworthy peers
   */
  getPeerRanking(limit: number = 10): Array<{
    peerId: string;
    score: number;
    trustLevel: string;
  }> {
    return Array.from(this.reputations.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map(rep => ({
        peerId: rep.peerId,
        score: rep.score,
        trustLevel: rep.trustLevel,
      }));
  }

  /**
   * Get event history for peer
   */
  getEventHistory(peerId: string, limit: number = 20): ReputationEvent[] {
    const history = this.eventHistory.get(peerId) || [];
    return history.slice(-limit);
  }

  /**
   * Detect reputation gaming attempts
   * SECURITY: Prevent reputation manipulation
   */
  detectReputationGaming(peerId: string): {
    isSuspicious: boolean;
    reasons: string[];
  } {
    const reputation = this.reputations.get(peerId);
    if (!reputation) {
      return { isSuspicious: false, reasons: [] };
    }

    const reasons: string[] = [];
    const history = this.eventHistory.get(peerId) || [];

    // Check for rapid score increases
    const recentEvents = history.slice(-10);
    const scoreIncrease = recentEvents
      .filter(e => e.impactPoints > 0)
      .reduce((sum, e) => sum + e.impactPoints, 0);

    if (scoreIncrease > 50 && recentEvents.length === 10) {
      reasons.push('Rapid score increase detected');
    }

    // Check for suspicious patterns
    const successRate =
      reputation.metrics.successfulInteractions /
      (reputation.metrics.successfulInteractions + reputation.metrics.failedInteractions || 1);

    if (successRate === 1.0 && reputation.metrics.successfulInteractions > 100) {
      reasons.push('Suspiciously perfect success rate');
    }

    // Check for timestamp manipulation
    const eventTimes = recentEvents.map(e => e.timestamp.getTime());
    const avgTimeDiff =
      eventTimes.reduce((sum, time, i) => {
        if (i === 0) return sum;
        return sum + (time - eventTimes[i - 1]);
      }, 0) / (eventTimes.length - 1 || 1);

    if (avgTimeDiff < 100 && recentEvents.length > 5) {
      reasons.push('Events occurring too rapidly (< 100ms apart)');
    }

    return {
      isSuspicious: reasons.length > 0,
      reasons,
    };
  }

  /**
   * Start reputation decay timer
   */
  private startDecayTimer(): void {
    this.decayTimer = setInterval(() => {
      this.applyReputationDecay();
      this.emit('decayApplied', { timestamp: new Date() });
    }, this.config.decayInterval);
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    totalPeers: number;
    bannedPeers: number;
    averageScore: number;
    trustLevelDistribution: Record<string, number>;
    topPeers: Array<{ peerId: string; score: number }>;
  } {
    const now = new Date();
    let totalScore = 0;
    let bannedCount = 0;
    const trustLevelDistribution: Record<string, number> = {
      untrusted: 0,
      low: 0,
      neutral: 0,
      trusted: 0,
      highly_trusted: 0,
    };

    for (const reputation of this.reputations.values()) {
      totalScore += reputation.score;
      trustLevelDistribution[reputation.trustLevel]++;

      if (reputation.bannedUntil && now < reputation.bannedUntil) {
        bannedCount++;
      }
    }

    const topPeers = this.getPeerRanking(5);

    return {
      totalPeers: this.reputations.size,
      bannedPeers: bannedCount,
      averageScore: this.reputations.size > 0 ? totalScore / this.reputations.size : 0,
      trustLevelDistribution,
      topPeers,
    };
  }

  /**
   * Cleanup old reputation data
   */
  cleanup(maxAge: number = 30 * 24 * 60 * 60 * 1000): number {
    const now = new Date();
    const cutoff = new Date(now.getTime() - maxAge);
    let cleaned = 0;

    for (const [peerId, reputation] of this.reputations.entries()) {
      // Remove peers not seen for more than maxAge
      if (reputation.lastSeen < cutoff) {
        this.reputations.delete(peerId);
        this.eventHistory.delete(peerId);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      this.emit('cleanup', { peersRemoved: cleaned });
    }

    return cleaned;
  }

  /**
   * Shutdown and cleanup
   */
  shutdown(): void {
    if (this.decayTimer) {
      clearInterval(this.decayTimer);
      this.decayTimer = null;
    }

    this.reputations.clear();
    this.eventHistory.clear();

    this.emit('shutdown');
  }
}

/**
 * Helper function to create test reputation events
 */
export function createReputationEvent(
  peerId: string,
  eventType: ReputationEvent['eventType'],
  impactPoints: number,
  metadata?: Record<string, any>
): Omit<ReputationEvent, 'timestamp'> {
  return {
    peerId,
    eventType,
    impactPoints,
    metadata,
  };
}
