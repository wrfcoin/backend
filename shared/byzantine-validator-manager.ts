/**
 * Byzantine Validator Manager
 * Implements validator registration, reputation scoring, and malicious actor detection
 *
 * BYZANTINE FAULT TOLERANCE:
 * - Maintains security with up to f < n/3 malicious nodes
 * - Statistical anomaly detection for Byzantine behavior
 * - Reputation scoring system (0-100)
 * - Automatic validator isolation and slashing
 * - Behavior pattern analysis
 * - Economic incentives and penalties
 *
 * CRITICAL: System can tolerate f Byzantine validators where f < n/3
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

export interface ValidatorInfo {
  validatorId: string;
  address: string;
  publicKey: Buffer;
  votingPower: number;
  stake: number;
  reputation: number; // 0-100
  status: 'active' | 'inactive' | 'quarantined' | 'slashed';
  registeredAt: Date;
  lastActiveAt: Date;
}

export interface ValidatorBehavior {
  validatorId: string;
  totalVotes: number;
  correctVotes: number;
  incorrectVotes: number;
  missedVotes: number;
  averageResponseTime: number; // milliseconds
  doubleVoteAttempts: number;
  invalidSignatures: number;
  suspiciousPatterns: number;
  lastVoteTime: Date;
}

export interface ReputationScore {
  validatorId: string;
  score: number; // 0-100
  components: {
    accuracy: number; // Vote correctness
    availability: number; // Participation rate
    responsiveness: number; // Response time
    reliability: number; // Consistency
    honesty: number; // No Byzantine behavior
  };
  trend: 'improving' | 'stable' | 'declining';
  lastUpdated: Date;
}

export interface MaliciousIndicator {
  validatorId: string;
  indicatorType:
    | 'double-voting'
    | 'conflicting-votes'
    | 'invalid-signature'
    | 'response-pattern-anomaly'
    | 'coordination-attack'
    | 'timing-attack'
    | 'vote-withholding';
  severity: 'low' | 'medium' | 'high' | 'critical';
  evidence: any;
  detectedAt: Date;
  confidence: number; // 0-1
}

export interface SlashingEvent {
  validatorId: string;
  reason: string;
  slashedAmount: number;
  reputationPenalty: number;
  timestamp: Date;
  evidence: MaliciousIndicator[];
}

export interface QuarantineEntry {
  validatorId: string;
  reason: string;
  startTime: Date;
  endTime: Date;
  indicators: MaliciousIndicator[];
  reviewStatus: 'pending' | 'cleared' | 'confirmed';
}

export interface ByzantineTolerance {
  totalValidators: number;
  activeValidators: number;
  maxByzantineNodes: number; // f = floor((n-1)/3)
  estimatedByzantineNodes: number;
  safetyMargin: number; // How far from Byzantine threshold
  toleranceStatus: 'safe' | 'warning' | 'critical';
}

/**
 * Byzantine Validator Management System
 * Detects and isolates malicious validators while maintaining f < n/3 safety
 */
export class ByzantineValidatorManager extends EventEmitter {
  private validators: Map<string, ValidatorInfo> = new Map();
  private behaviors: Map<string, ValidatorBehavior> = new Map();
  private reputations: Map<string, ReputationScore> = new Map();
  private maliciousIndicators: Map<string, MaliciousIndicator[]> = new Map();
  private quarantined: Map<string, QuarantineEntry> = new Map();
  private slashingHistory: SlashingEvent[] = [];

  // Byzantine fault tolerance parameters
  private readonly MIN_REPUTATION_THRESHOLD = 30;
  private readonly QUARANTINE_REPUTATION_THRESHOLD = 20;
  private readonly SLASH_REPUTATION_THRESHOLD = 10;
  private readonly MALICIOUS_INDICATOR_THRESHOLD = 3;
  private readonly RESPONSE_TIME_ANOMALY_FACTOR = 3.0; // 3x average
  private readonly QUARANTINE_DURATION = 3600000; // 1 hour

  // Reputation scoring weights
  private readonly REPUTATION_WEIGHTS = {
    accuracy: 0.3,
    availability: 0.2,
    responsiveness: 0.15,
    reliability: 0.2,
    honesty: 0.15,
  };

  constructor() {
    super();
  }

  /**
   * Register new validator
   */
  async registerValidator(
    validatorId: string,
    address: string,
    publicKey: Buffer,
    stake: number
  ): Promise<void> {
    if (this.validators.has(validatorId)) {
      throw new Error(`Validator ${validatorId} already registered`);
    }

    // Initial voting power based on stake
    const votingPower = this.calculateVotingPower(stake);

    const validator: ValidatorInfo = {
      validatorId,
      address,
      publicKey,
      votingPower,
      stake,
      reputation: 100, // Start with perfect reputation
      status: 'active',
      registeredAt: new Date(),
      lastActiveAt: new Date(),
    };

    this.validators.set(validatorId, validator);

    // Initialize behavior tracking
    this.behaviors.set(validatorId, {
      validatorId,
      totalVotes: 0,
      correctVotes: 0,
      incorrectVotes: 0,
      missedVotes: 0,
      averageResponseTime: 0,
      doubleVoteAttempts: 0,
      invalidSignatures: 0,
      suspiciousPatterns: 0,
      lastVoteTime: new Date(),
    });

    // Initialize reputation score
    this.reputations.set(validatorId, {
      validatorId,
      score: 100,
      components: {
        accuracy: 100,
        availability: 100,
        responsiveness: 100,
        reliability: 100,
        honesty: 100,
      },
      trend: 'stable',
      lastUpdated: new Date(),
    });

    this.emit('validatorRegistered', {
      validatorId,
      stake,
      votingPower,
    });
  }

  /**
   * Record validator vote for behavior analysis
   */
  async recordVote(
    validatorId: string,
    voteCorrect: boolean,
    responseTime: number
  ): Promise<void> {
    const behavior = this.behaviors.get(validatorId);
    if (!behavior) {
      throw new Error(`Unknown validator: ${validatorId}`);
    }

    behavior.totalVotes++;
    if (voteCorrect) {
      behavior.correctVotes++;
    } else {
      behavior.incorrectVotes++;
    }

    // Update average response time
    behavior.averageResponseTime =
      (behavior.averageResponseTime * (behavior.totalVotes - 1) + responseTime) /
      behavior.totalVotes;

    behavior.lastVoteTime = new Date();

    // Check for anomalies
    await this.analyzeVotingBehavior(validatorId);

    // Update reputation
    await this.updateReputation(validatorId);

    // Update last active time
    const validator = this.validators.get(validatorId);
    if (validator) {
      validator.lastActiveAt = new Date();
    }
  }

  /**
   * Record missed vote
   */
  async recordMissedVote(validatorId: string): Promise<void> {
    const behavior = this.behaviors.get(validatorId);
    if (!behavior) return;

    behavior.missedVotes++;
    behavior.totalVotes++;

    await this.updateReputation(validatorId);

    this.emit('missedVote', {
      validatorId,
      totalMissed: behavior.missedVotes,
    });
  }

  /**
   * Report malicious indicator
   */
  async reportMaliciousIndicator(indicator: MaliciousIndicator): Promise<void> {
    const indicators = this.maliciousIndicators.get(indicator.validatorId) || [];
    indicators.push(indicator);
    this.maliciousIndicators.set(indicator.validatorId, indicators);

    // Update behavior metrics
    const behavior = this.behaviors.get(indicator.validatorId);
    if (behavior) {
      switch (indicator.indicatorType) {
        case 'double-voting':
        case 'conflicting-votes':
          behavior.doubleVoteAttempts++;
          break;
        case 'invalid-signature':
          behavior.invalidSignatures++;
          break;
        default:
          behavior.suspiciousPatterns++;
      }
    }

    this.emit('maliciousIndicatorDetected', {
      validatorId: indicator.validatorId,
      type: indicator.indicatorType,
      severity: indicator.severity,
      confidence: indicator.confidence,
    });

    // Check if action is needed
    await this.evaluateByzantineBehavior(indicator.validatorId);
  }

  /**
   * Analyze voting behavior for anomalies
   */
  private async analyzeVotingBehavior(validatorId: string): Promise<void> {
    const behavior = this.behaviors.get(validatorId);
    if (!behavior) return;

    // Calculate average response time across all validators
    const allBehaviors = Array.from(this.behaviors.values());
    const averageResponseTime =
      allBehaviors.reduce((sum, b) => sum + b.averageResponseTime, 0) /
      allBehaviors.length;

    // Check for response time anomaly
    if (
      behavior.averageResponseTime >
      averageResponseTime * this.RESPONSE_TIME_ANOMALY_FACTOR
    ) {
      await this.reportMaliciousIndicator({
        validatorId,
        indicatorType: 'response-pattern-anomaly',
        severity: 'medium',
        evidence: {
          validatorResponseTime: behavior.averageResponseTime,
          networkAverage: averageResponseTime,
          factor: behavior.averageResponseTime / averageResponseTime,
        },
        detectedAt: new Date(),
        confidence: 0.7,
      });
    }

    // Check for suspiciously low error rate (could indicate insider knowledge)
    const accuracy = behavior.correctVotes / behavior.totalVotes;
    if (accuracy > 0.99 && behavior.totalVotes > 100) {
      await this.reportMaliciousIndicator({
        validatorId,
        indicatorType: 'vote-withholding',
        severity: 'low',
        evidence: {
          accuracy,
          totalVotes: behavior.totalVotes,
        },
        detectedAt: new Date(),
        confidence: 0.5,
      });
    }
  }

  /**
   * Evaluate if validator exhibits Byzantine behavior
   */
  private async evaluateByzantineBehavior(validatorId: string): Promise<void> {
    const indicators = this.maliciousIndicators.get(validatorId) || [];

    // Count critical and high severity indicators
    const criticalIndicators = indicators.filter(
      i => i.severity === 'critical'
    ).length;
    const highIndicators = indicators.filter(i => i.severity === 'high').length;

    // Immediate quarantine for critical indicators
    if (criticalIndicators > 0) {
      await this.quarantineValidator(validatorId, 'Critical Byzantine behavior detected');
      return;
    }

    // Quarantine if too many indicators
    if (
      indicators.length >= this.MALICIOUS_INDICATOR_THRESHOLD ||
      highIndicators >= 2
    ) {
      await this.quarantineValidator(validatorId, 'Multiple malicious indicators detected');
      return;
    }

    // Update reputation
    await this.updateReputation(validatorId);

    const reputation = this.reputations.get(validatorId);
    if (reputation && reputation.score < this.QUARANTINE_REPUTATION_THRESHOLD) {
      await this.quarantineValidator(validatorId, 'Reputation below quarantine threshold');
    }
  }

  /**
   * Update validator reputation score
   */
  private async updateReputation(validatorId: string): Promise<void> {
    const behavior = this.behaviors.get(validatorId);
    const reputation = this.reputations.get(validatorId);
    if (!behavior || !reputation) return;

    const oldScore = reputation.score;

    // Calculate component scores
    const accuracy =
      behavior.totalVotes > 0
        ? (behavior.correctVotes / behavior.totalVotes) * 100
        : 100;

    const availability =
      behavior.totalVotes > 0
        ? ((behavior.totalVotes - behavior.missedVotes) / behavior.totalVotes) * 100
        : 100;

    // Responsiveness based on response time (lower is better)
    const avgResponseTime = behavior.averageResponseTime || 100;
    const responsiveness = Math.max(0, 100 - (avgResponseTime / 100) * 10);

    // Reliability based on consistency
    const reliability =
      behavior.totalVotes > 10 ? Math.min(100, (behavior.totalVotes / 100) * 100) : 50;

    // Honesty based on absence of malicious indicators
    const indicators = this.maliciousIndicators.get(validatorId) || [];
    const honesty = Math.max(0, 100 - indicators.length * 10);

    reputation.components = {
      accuracy,
      availability,
      responsiveness,
      reliability,
      honesty,
    };

    // Calculate weighted score
    reputation.score =
      accuracy * this.REPUTATION_WEIGHTS.accuracy +
      availability * this.REPUTATION_WEIGHTS.availability +
      responsiveness * this.REPUTATION_WEIGHTS.responsiveness +
      reliability * this.REPUTATION_WEIGHTS.reliability +
      honesty * this.REPUTATION_WEIGHTS.honesty;

    // Determine trend
    if (reputation.score > oldScore + 5) {
      reputation.trend = 'improving';
    } else if (reputation.score < oldScore - 5) {
      reputation.trend = 'declining';
    } else {
      reputation.trend = 'stable';
    }

    reputation.lastUpdated = new Date();

    // Update validator status based on reputation
    const validator = this.validators.get(validatorId);
    if (validator) {
      validator.reputation = reputation.score;

      if (reputation.score < this.SLASH_REPUTATION_THRESHOLD) {
        await this.slashValidator(validatorId, 'Reputation below slashing threshold');
      }
    }

    this.emit('reputationUpdated', {
      validatorId,
      score: reputation.score,
      oldScore,
      trend: reputation.trend,
    });
  }

  /**
   * Quarantine suspicious validator
   */
  private async quarantineValidator(validatorId: string, reason: string): Promise<void> {
    const validator = this.validators.get(validatorId);
    if (!validator) return;

    if (validator.status === 'quarantined') return; // Already quarantined

    validator.status = 'quarantined';

    const indicators = this.maliciousIndicators.get(validatorId) || [];
    const quarantineEntry: QuarantineEntry = {
      validatorId,
      reason,
      startTime: new Date(),
      endTime: new Date(Date.now() + this.QUARANTINE_DURATION),
      indicators,
      reviewStatus: 'pending',
    };

    this.quarantined.set(validatorId, quarantineEntry);

    this.emit('validatorQuarantined', {
      validatorId,
      reason,
      duration: this.QUARANTINE_DURATION,
      indicators: indicators.length,
    });

    // Check Byzantine tolerance after quarantine
    this.checkByzantineTolerance();
  }

  /**
   * Slash validator for Byzantine behavior
   */
  private async slashValidator(validatorId: string, reason: string): Promise<void> {
    const validator = this.validators.get(validatorId);
    if (!validator) return;

    if (validator.status === 'slashed') return; // Already slashed

    // Calculate slashing amount (10% of stake)
    const slashedAmount = validator.stake * 0.1;
    validator.stake -= slashedAmount;
    validator.votingPower = this.calculateVotingPower(validator.stake);
    validator.status = 'slashed';
    validator.reputation = 0;

    const indicators = this.maliciousIndicators.get(validatorId) || [];
    const slashingEvent: SlashingEvent = {
      validatorId,
      reason,
      slashedAmount,
      reputationPenalty: 100,
      timestamp: new Date(),
      evidence: indicators,
    };

    this.slashingHistory.push(slashingEvent);

    this.emit('validatorSlashed', {
      validatorId,
      reason,
      slashedAmount,
      remainingStake: validator.stake,
    });

    // Remove from active validator set
    this.validators.delete(validatorId);

    // Check Byzantine tolerance after slashing
    this.checkByzantineTolerance();
  }

  /**
   * Release validator from quarantine
   */
  async releaseFromQuarantine(validatorId: string): Promise<void> {
    const validator = this.validators.get(validatorId);
    const quarantine = this.quarantined.get(validatorId);

    if (!validator || !quarantine) return;

    // Check if quarantine period has expired
    if (Date.now() < quarantine.endTime.getTime()) {
      throw new Error('Quarantine period not yet expired');
    }

    validator.status = 'active';
    quarantine.reviewStatus = 'cleared';
    this.quarantined.delete(validatorId);

    // Clear some indicators (give second chance)
    const indicators = this.maliciousIndicators.get(validatorId) || [];
    const recentIndicators = indicators.filter(
      i => Date.now() - i.detectedAt.getTime() < 86400000
    ); // Keep last 24h
    this.maliciousIndicators.set(validatorId, recentIndicators);

    this.emit('validatorReleased', {
      validatorId,
      quarantineDuration: Date.now() - quarantine.startTime.getTime(),
    });
  }

  /**
   * Calculate Byzantine fault tolerance status
   */
  getByzantineTolerance(): ByzantineTolerance {
    const totalValidators = this.validators.size;
    const activeValidators = Array.from(this.validators.values()).filter(
      v => v.status === 'active'
    ).length;

    // Maximum Byzantine nodes: f = floor((n-1)/3)
    const maxByzantineNodes = Math.floor((activeValidators - 1) / 3);

    // Estimate Byzantine nodes based on quarantined and low reputation
    const quarantinedCount = this.quarantined.size;
    const lowReputationCount = Array.from(this.reputations.values()).filter(
      r => r.score < this.MIN_REPUTATION_THRESHOLD
    ).length;
    const estimatedByzantineNodes = quarantinedCount + lowReputationCount;

    // Safety margin: how far from threshold
    const safetyMargin = maxByzantineNodes - estimatedByzantineNodes;

    let toleranceStatus: 'safe' | 'warning' | 'critical' = 'safe';
    if (safetyMargin < 2) {
      toleranceStatus = 'critical';
    } else if (safetyMargin < 5) {
      toleranceStatus = 'warning';
    }

    return {
      totalValidators,
      activeValidators,
      maxByzantineNodes,
      estimatedByzantineNodes,
      safetyMargin,
      toleranceStatus,
    };
  }

  /**
   * Check and emit warning if approaching Byzantine threshold
   */
  private checkByzantineTolerance(): void {
    const tolerance = this.getByzantineTolerance();

    if (tolerance.toleranceStatus === 'critical') {
      this.emit('byzantineToleranceCritical', tolerance);
    } else if (tolerance.toleranceStatus === 'warning') {
      this.emit('byzantineToleranceWarning', tolerance);
    }
  }

  /**
   * Calculate voting power from stake
   */
  private calculateVotingPower(stake: number): number {
    // Square root weighting to prevent concentration
    return Math.floor(Math.sqrt(stake));
  }

  /**
   * Get active validators (not quarantined or slashed)
   */
  getActiveValidators(): ValidatorInfo[] {
    return Array.from(this.validators.values()).filter(v => v.status === 'active');
  }

  /**
   * Get validator information
   */
  getValidator(validatorId: string): ValidatorInfo | undefined {
    return this.validators.get(validatorId);
  }

  /**
   * Get validator reputation
   */
  getReputation(validatorId: string): ReputationScore | undefined {
    return this.reputations.get(validatorId);
  }

  /**
   * Get validator behavior
   */
  getBehavior(validatorId: string): ValidatorBehavior | undefined {
    return this.behaviors.get(validatorId);
  }

  /**
   * Get malicious indicators for validator
   */
  getMaliciousIndicators(validatorId: string): MaliciousIndicator[] {
    return this.maliciousIndicators.get(validatorId) || [];
  }

  /**
   * Get all quarantined validators
   */
  getQuarantinedValidators(): QuarantineEntry[] {
    return Array.from(this.quarantined.values());
  }

  /**
   * Get slashing history
   */
  getSlashingHistory(): SlashingEvent[] {
    return [...this.slashingHistory];
  }

  /**
   * Get validators ranked by reputation
   */
  getValidatorsByReputation(limit?: number): ValidatorInfo[] {
    const validators = Array.from(this.validators.values())
      .filter(v => v.status === 'active')
      .sort((a, b) => b.reputation - a.reputation);

    return limit ? validators.slice(0, limit) : validators;
  }
}
