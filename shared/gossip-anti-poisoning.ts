/**
 * Gossip Information Poisoning Prevention System
 * Task 100.14 - Advanced protection against false information injection
 *
 * SECURITY FEATURES:
 * - Multi-source content validation
 * - Statistical anomaly detection for poisoned messages
 * - Semantic consistency checking
 * - Source reputation analysis with weighted scoring
 * - Quarantine mechanisms for suspicious messages
 * - Pattern-based poisoning detection
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { PeerReputationService } from './p2p-peer-reputation.js';

export interface PoisoningDetectionResult {
  isPoisoned: boolean;
  confidence: number; // 0-1
  reasons: string[];
  anomalyScore: number; // 0-1
  sourceCredibility: number; // 0-1
  contentConsistency: number; // 0-1
  recommendedAction: 'accept' | 'quarantine' | 'reject';
}

export interface MessageContentAnalysis {
  messageId: string;
  topic: string;
  payload: any;
  source: string;
  timestamp: Date;
  historicalContext: {
    similarMessages: number;
    averageDeviation: number;
    patternMatch: boolean;
  };
  statisticalMetrics: {
    entropy: number;
    outlierScore: number;
    distributionFit: number;
  };
}

export interface QuarantinedMessage {
  messageId: string;
  message: any;
  quarantineReason: string;
  quarantinedAt: Date;
  reviewedBy: Set<string>;
  releaseVotes: number;
  rejectVotes: number;
  status: 'pending' | 'released' | 'rejected';
}

export interface PoisoningPattern {
  patternId: string;
  patternType: 'content' | 'timing' | 'source' | 'behavioral';
  description: string;
  indicators: string[];
  severity: 'low' | 'medium' | 'high' | 'critical';
  matchCount: number;
  lastDetected: Date;
}

/**
 * Gossip Anti-Poisoning Service
 * SECURITY: Multi-layered defense against information poisoning
 */
export class GossipAntiPoisoning extends EventEmitter {
  private messageHistory: Map<string, MessageContentAnalysis> = new Map();
  private quarantine: Map<string, QuarantinedMessage> = new Map();
  private knownPatterns: Map<string, PoisoningPattern> = new Map();
  private topicBaselines: Map<string, TopicBaseline> = new Map();
  private readonly peerReputation: PeerReputationService;
  private readonly maxHistorySize = 10000;
  private readonly quarantineThreshold = 0.7; // 70% poisoning probability
  private readonly rejectThreshold = 0.9; // 90% poisoning probability

  constructor(peerReputation: PeerReputationService) {
    super();
    this.peerReputation = peerReputation;
    this.initializeKnownPatterns();

    // Periodic cleanup
    setInterval(() => this.cleanupOldData(), 300000); // Every 5 minutes
  }

  /**
   * Initialize known poisoning attack patterns
   */
  private initializeKnownPatterns(): void {
    const patterns: Omit<PoisoningPattern, 'matchCount' | 'lastDetected'>[] = [
      {
        patternId: 'flood-attack',
        patternType: 'timing',
        description: 'Rapid flooding with similar messages',
        indicators: ['high-frequency', 'duplicate-content', 'single-source'],
        severity: 'high',
      },
      {
        patternId: 'false-consensus',
        patternType: 'behavioral',
        description: 'Multiple sources spreading identical false information',
        indicators: ['synchronized-timing', 'identical-content', 'new-sources'],
        severity: 'critical',
      },
      {
        patternId: 'gradual-shift',
        patternType: 'content',
        description: 'Gradual introduction of false data',
        indicators: ['incremental-change', 'sustained-pattern', 'slow-deviation'],
        severity: 'high',
      },
      {
        patternId: 'statistical-anomaly',
        patternType: 'content',
        description: 'Statistically improbable data values',
        indicators: ['outlier-values', 'distribution-mismatch', 'entropy-anomaly'],
        severity: 'medium',
      },
      {
        patternId: 'reputation-gaming',
        patternType: 'behavioral',
        description: 'Artificial reputation building before attack',
        indicators: ['sudden-high-volume', 'reputation-spike', 'behavior-change'],
        severity: 'high',
      },
    ];

    patterns.forEach(pattern => {
      this.knownPatterns.set(pattern.patternId, {
        ...pattern,
        matchCount: 0,
        lastDetected: new Date(0),
      });
    });
  }

  /**
   * Detect information poisoning in gossip message
   * SECURITY: Multi-dimensional analysis for comprehensive detection
   */
  async detectPoisoning(
    messageId: string,
    topic: string,
    payload: any,
    source: string
  ): Promise<PoisoningDetectionResult> {
    const reasons: string[] = [];
    let anomalyScore = 0;
    let contentConsistency = 1.0;

    // Stage 1: Source credibility analysis
    const sourceCredibility = this.analyzeSourceCredibility(source);
    if (sourceCredibility < 0.5) {
      reasons.push(`Low source credibility: ${sourceCredibility.toFixed(2)}`);
      anomalyScore += 0.3;
    }

    // Stage 2: Content analysis
    const contentAnalysis = await this.analyzeContent(messageId, topic, payload, source);
    this.messageHistory.set(messageId, contentAnalysis);

    // Stage 3: Statistical anomaly detection
    const statisticalAnomalies = this.detectStatisticalAnomalies(contentAnalysis);
    if (statisticalAnomalies.length > 0) {
      reasons.push(...statisticalAnomalies);
      anomalyScore += 0.25;
    }

    // Stage 4: Historical consistency check
    const consistencyResult = await this.checkHistoricalConsistency(topic, payload);
    contentConsistency = consistencyResult.consistency;
    if (contentConsistency < 0.7) {
      reasons.push(`Low content consistency: ${contentConsistency.toFixed(2)}`);
      anomalyScore += 0.2;
    }

    // Stage 5: Pattern matching
    const matchedPatterns = this.matchPoisoningPatterns(contentAnalysis, source);
    if (matchedPatterns.length > 0) {
      reasons.push(`Matched ${matchedPatterns.length} poisoning patterns`);
      matchedPatterns.forEach(pattern => {
        reasons.push(`  - ${pattern.description}`);
        anomalyScore += pattern.severity === 'critical' ? 0.4 : 0.2;
      });
    }

    // Stage 6: Cross-verification
    const crossVerification = await this.performCrossVerification(messageId, payload, topic);
    if (!crossVerification.verified) {
      reasons.push('Failed cross-verification');
      anomalyScore += 0.3;
    }

    // Normalize anomaly score
    anomalyScore = Math.min(1, anomalyScore);

    // Calculate confidence in poisoning detection
    const confidence = this.calculatePoisoningConfidence(
      anomalyScore,
      sourceCredibility,
      contentConsistency
    );

    // Determine recommended action
    let recommendedAction: PoisoningDetectionResult['recommendedAction'];
    if (confidence >= this.rejectThreshold) {
      recommendedAction = 'reject';
    } else if (confidence >= this.quarantineThreshold) {
      recommendedAction = 'quarantine';
    } else {
      recommendedAction = 'accept';
    }

    const isPoisoned = confidence >= this.quarantineThreshold;

    const result: PoisoningDetectionResult = {
      isPoisoned,
      confidence,
      reasons,
      anomalyScore,
      sourceCredibility,
      contentConsistency,
      recommendedAction,
    };

    // Take action based on recommendation
    if (recommendedAction === 'quarantine') {
      this.quarantineMessage(messageId, payload, reasons.join('; '), source);
    }

    this.emit('poisoningDetection', {
      messageId,
      isPoisoned,
      confidence,
      action: recommendedAction,
    });

    return result;
  }

  /**
   * Analyze source credibility
   */
  private analyzeSourceCredibility(source: string): number {
    const reputation = this.peerReputation.getReputation(source);
    if (!reputation) {
      return 0.3; // Unknown source gets low credibility
    }

    // Factors affecting credibility
    const reputationScore = reputation.score / 100;
    const trustLevel = this.trustLevelToScore(reputation.trustLevel);
    const successRate =
      reputation.metrics.successfulInteractions /
      (reputation.metrics.successfulInteractions +
        reputation.metrics.failedInteractions || 1);

    // Weighted average
    return reputationScore * 0.4 + trustLevel * 0.3 + successRate * 0.3;
  }

  /**
   * Convert trust level to numeric score
   */
  private trustLevelToScore(trustLevel: string): number {
    const scores = {
      untrusted: 0.1,
      low: 0.3,
      neutral: 0.5,
      trusted: 0.8,
      highly_trusted: 1.0,
    };

    return scores[trustLevel as keyof typeof scores] || 0.5;
  }

  /**
   * Analyze message content
   */
  private async analyzeContent(
    messageId: string,
    topic: string,
    payload: any,
    source: string
  ): Promise<MessageContentAnalysis> {
    // Get baseline for topic
    const baseline = this.getOrCreateTopicBaseline(topic);

    // Calculate statistical metrics
    const entropy = this.calculateEntropy(payload);
    const outlierScore = baseline.calculateOutlierScore(payload);
    const distributionFit = baseline.calculateDistributionFit(payload);

    // Find similar historical messages
    const similarMessages = this.findSimilarMessages(topic, payload);
    const averageDeviation = this.calculateAverageDeviation(payload, similarMessages);
    const patternMatch = similarMessages.length > 3;

    return {
      messageId,
      topic,
      payload,
      source,
      timestamp: new Date(),
      historicalContext: {
        similarMessages: similarMessages.length,
        averageDeviation,
        patternMatch,
      },
      statisticalMetrics: {
        entropy,
        outlierScore,
        distributionFit,
      },
    };
  }

  /**
   * Calculate Shannon entropy of payload
   */
  private calculateEntropy(payload: any): number {
    const str = JSON.stringify(payload);
    const freq = new Map<string, number>();

    for (const char of str) {
      freq.set(char, (freq.get(char) || 0) + 1);
    }

    let entropy = 0;
    const len = str.length;

    for (const count of freq.values()) {
      const p = count / len;
      entropy -= p * Math.log2(p);
    }

    // Normalize to 0-1 range (max entropy for ASCII is ~6.64)
    return Math.min(1, entropy / 6.64);
  }

  /**
   * Detect statistical anomalies
   */
  private detectStatisticalAnomalies(analysis: MessageContentAnalysis): string[] {
    const anomalies: string[] = [];

    // Check entropy
    if (analysis.statisticalMetrics.entropy < 0.2) {
      anomalies.push('Suspiciously low entropy (possible pattern attack)');
    } else if (analysis.statisticalMetrics.entropy > 0.95) {
      anomalies.push('Suspiciously high entropy (possible random data)');
    }

    // Check outlier score
    if (analysis.statisticalMetrics.outlierScore > 0.8) {
      anomalies.push(
        `High outlier score: ${analysis.statisticalMetrics.outlierScore.toFixed(2)}`
      );
    }

    // Check distribution fit
    if (analysis.statisticalMetrics.distributionFit < 0.3) {
      anomalies.push(
        `Poor distribution fit: ${analysis.statisticalMetrics.distributionFit.toFixed(2)}`
      );
    }

    return anomalies;
  }

  /**
   * Check historical consistency
   */
  private async checkHistoricalConsistency(
    topic: string,
    payload: any
  ): Promise<{ consistency: number; matchingMessages: number }> {
    const baseline = this.topicBaselines.get(topic);
    if (!baseline) {
      return { consistency: 0.5, matchingMessages: 0 }; // Neutral for new topics
    }

    const similarMessages = this.findSimilarMessages(topic, payload);
    const matchingMessages = similarMessages.length;

    if (matchingMessages === 0) {
      return { consistency: 0.3, matchingMessages: 0 }; // Low consistency for novel messages
    }

    // Calculate consistency based on deviation from similar messages
    const deviations = similarMessages.map(msg =>
      this.calculateDeviation(payload, msg.payload)
    );

    const averageDeviation = deviations.reduce((a, b) => a + b, 0) / deviations.length;

    // Consistency is inverse of deviation
    const consistency = Math.max(0, 1 - averageDeviation);

    return { consistency, matchingMessages };
  }

  /**
   * Find similar messages in history
   */
  private findSimilarMessages(topic: string, payload: any): MessageContentAnalysis[] {
    const similar: MessageContentAnalysis[] = [];

    for (const analysis of this.messageHistory.values()) {
      if (analysis.topic !== topic) continue;

      const similarity = this.calculateSimilarity(payload, analysis.payload);
      if (similarity > 0.7) {
        similar.push(analysis);
      }
    }

    return similar.slice(-10); // Return last 10 similar messages
  }

  /**
   * Calculate similarity between two payloads
   */
  private calculateSimilarity(payload1: any, payload2: any): number {
    const str1 = JSON.stringify(payload1);
    const str2 = JSON.stringify(payload2);

    // Simple Jaccard similarity
    const set1 = new Set(str1.split(''));
    const set2 = new Set(str2.split(''));

    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);

    return intersection.size / union.size;
  }

  /**
   * Calculate deviation from baseline
   */
  private calculateDeviation(payload: any, baseline: any): number {
    return 1 - this.calculateSimilarity(payload, baseline);
  }

  /**
   * Calculate average deviation
   */
  private calculateAverageDeviation(
    payload: any,
    messages: MessageContentAnalysis[]
  ): number {
    if (messages.length === 0) return 1.0;

    const deviations = messages.map(msg => this.calculateDeviation(payload, msg.payload));
    return deviations.reduce((a, b) => a + b, 0) / deviations.length;
  }

  /**
   * Match against known poisoning patterns
   */
  private matchPoisoningPatterns(
    analysis: MessageContentAnalysis,
    source: string
  ): PoisoningPattern[] {
    const matchedPatterns: PoisoningPattern[] = [];

    for (const pattern of this.knownPatterns.values()) {
      const matches = this.checkPatternMatch(pattern, analysis, source);

      if (matches) {
        matchedPatterns.push(pattern);
        pattern.matchCount++;
        pattern.lastDetected = new Date();
      }
    }

    return matchedPatterns;
  }

  /**
   * Check if message matches a specific pattern
   */
  private checkPatternMatch(
    pattern: PoisoningPattern,
    analysis: MessageContentAnalysis,
    source: string
  ): boolean {
    const indicators = pattern.indicators;

    // Pattern-specific logic
    switch (pattern.patternType) {
      case 'timing':
        return this.checkTimingPattern(indicators, analysis, source);
      case 'content':
        return this.checkContentPattern(indicators, analysis);
      case 'behavioral':
        return this.checkBehavioralPattern(indicators, source);
      case 'source':
        return this.checkSourcePattern(indicators, source);
      default:
        return false;
    }
  }

  /**
   * Check timing-based patterns
   */
  private checkTimingPattern(
    indicators: string[],
    analysis: MessageContentAnalysis,
    source: string
  ): boolean {
    if (indicators.includes('high-frequency')) {
      // Check if source has sent many recent messages
      const recentMessages = Array.from(this.messageHistory.values()).filter(
        msg =>
          msg.source === source && Date.now() - msg.timestamp.getTime() < 60000 // Last minute
      );

      return recentMessages.length > 20; // More than 20 messages per minute
    }

    return false;
  }

  /**
   * Check content-based patterns
   */
  private checkContentPattern(indicators: string[], analysis: MessageContentAnalysis): boolean {
    if (indicators.includes('outlier-values')) {
      return analysis.statisticalMetrics.outlierScore > 0.8;
    }

    if (indicators.includes('entropy-anomaly')) {
      const entropy = analysis.statisticalMetrics.entropy;
      return entropy < 0.2 || entropy > 0.95;
    }

    return false;
  }

  /**
   * Check behavioral patterns
   */
  private checkBehavioralPattern(indicators: string[], source: string): boolean {
    if (indicators.includes('reputation-spike')) {
      const reputation = this.peerReputation.getReputation(source);
      if (!reputation) return false;

      const history = this.peerReputation.getEventHistory(source, 50);
      const recentPositive = history
        .slice(-10)
        .filter(e => e.impactPoints > 0).length;

      return recentPositive > 8; // 80%+ positive recent events (suspicious)
    }

    return false;
  }

  /**
   * Check source-based patterns
   */
  private checkSourcePattern(indicators: string[], source: string): boolean {
    const reputation = this.peerReputation.getReputation(source);
    return !reputation || reputation.score < 20;
  }

  /**
   * Perform cross-verification with multiple sources
   */
  private async performCrossVerification(
    messageId: string,
    payload: any,
    topic: string
  ): Promise<{ verified: boolean; agreementCount: number }> {
    // Find messages with similar content from different sources
    const similar = this.findSimilarMessages(topic, payload);
    const uniqueSources = new Set(similar.map(msg => msg.source));

    // Need at least 3 different sources to agree
    const verified = uniqueSources.size >= 3;

    return {
      verified,
      agreementCount: uniqueSources.size,
    };
  }

  /**
   * Calculate poisoning confidence
   */
  private calculatePoisoningConfidence(
    anomalyScore: number,
    sourceCredibility: number,
    contentConsistency: number
  ): number {
    // Weighted combination
    const inverseCredibility = 1 - sourceCredibility;
    const inverseConsistency = 1 - contentConsistency;

    return (anomalyScore * 0.4 + inverseCredibility * 0.3 + inverseConsistency * 0.3);
  }

  /**
   * Quarantine suspicious message
   */
  private quarantineMessage(
    messageId: string,
    message: any,
    reason: string,
    source: string
  ): void {
    const quarantined: QuarantinedMessage = {
      messageId,
      message,
      quarantineReason: reason,
      quarantinedAt: new Date(),
      reviewedBy: new Set(),
      releaseVotes: 0,
      rejectVotes: 0,
      status: 'pending',
    };

    this.quarantine.set(messageId, quarantined);

    this.emit('messageQuarantined', {
      messageId,
      reason,
      source,
    });
  }

  /**
   * Review quarantined message
   */
  reviewQuarantinedMessage(
    messageId: string,
    reviewerId: string,
    decision: 'release' | 'reject'
  ): boolean {
    const quarantined = this.quarantine.get(messageId);
    if (!quarantined || quarantined.status !== 'pending') {
      return false;
    }

    quarantined.reviewedBy.add(reviewerId);

    if (decision === 'release') {
      quarantined.releaseVotes++;
    } else {
      quarantined.rejectVotes++;
    }

    // Decision threshold: 3 votes
    if (quarantined.releaseVotes >= 3) {
      quarantined.status = 'released';
      this.emit('messageReleased', { messageId });
    } else if (quarantined.rejectVotes >= 3) {
      quarantined.status = 'rejected';
      this.emit('messageRejected', { messageId });
    }

    return true;
  }

  /**
   * Get or create topic baseline
   */
  private getOrCreateTopicBaseline(topic: string): TopicBaseline {
    let baseline = this.topicBaselines.get(topic);

    if (!baseline) {
      baseline = new TopicBaseline(topic);
      this.topicBaselines.set(topic, baseline);
    }

    return baseline;
  }

  /**
   * Cleanup old data
   */
  private cleanupOldData(): void {
    const cutoff = Date.now() - 3600000; // 1 hour

    // Cleanup message history
    if (this.messageHistory.size > this.maxHistorySize) {
      const entries = Array.from(this.messageHistory.entries());
      entries.sort((a, b) => a[1].timestamp.getTime() - b[1].timestamp.getTime());

      const toRemove = entries.slice(0, entries.length - this.maxHistorySize);
      toRemove.forEach(([id]) => this.messageHistory.delete(id));
    }

    // Cleanup old quarantined messages
    for (const [messageId, quarantined] of this.quarantine.entries()) {
      if (quarantined.quarantinedAt.getTime() < cutoff) {
        this.quarantine.delete(messageId);
      }
    }
  }

  /**
   * Get statistics
   */
  getStatistics(): {
    messageHistory: number;
    quarantinedMessages: number;
    knownPatterns: number;
    totalPatternMatches: number;
  } {
    let totalMatches = 0;
    for (const pattern of this.knownPatterns.values()) {
      totalMatches += pattern.matchCount;
    }

    return {
      messageHistory: this.messageHistory.size,
      quarantinedMessages: this.quarantine.size,
      knownPatterns: this.knownPatterns.size,
      totalPatternMatches: totalMatches,
    };
  }

  /**
   * Shutdown and cleanup
   */
  shutdown(): void {
    this.messageHistory.clear();
    this.quarantine.clear();
    this.topicBaselines.clear();
    this.emit('shutdown');
  }
}

/**
 * Topic baseline for statistical analysis
 */
class TopicBaseline {
  private samples: any[] = [];
  private readonly maxSamples = 1000;

  constructor(public topic: string) {}

  addSample(payload: any): void {
    this.samples.push(payload);

    if (this.samples.length > this.maxSamples) {
      this.samples.shift();
    }
  }

  calculateOutlierScore(payload: any): number {
    if (this.samples.length < 10) {
      return 0.5; // Neutral score for insufficient data
    }

    // Calculate deviation from mean
    const similarities = this.samples.map(sample => {
      const str1 = JSON.stringify(payload);
      const str2 = JSON.stringify(sample);
      const set1 = new Set(str1.split(''));
      const set2 = new Set(str2.split(''));
      const intersection = new Set([...set1].filter(x => set2.has(x)));
      const union = new Set([...set1, ...set2]);
      return intersection.size / union.size;
    });

    const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;

    // Outlier score is inverse of similarity
    return 1 - avgSimilarity;
  }

  calculateDistributionFit(payload: any): number {
    if (this.samples.length < 10) {
      return 0.5;
    }

    // Simple distribution fit based on how many samples are similar
    const similarCount = this.samples.filter(sample => {
      const similarity =
        1 -
        Math.abs(
          JSON.stringify(payload).length - JSON.stringify(sample).length
        ) /
          Math.max(
            JSON.stringify(payload).length,
            JSON.stringify(sample).length
          );
      return similarity > 0.5;
    }).length;

    return similarCount / this.samples.length;
  }
}
