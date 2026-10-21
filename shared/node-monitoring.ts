/**
 * Continuous Node Behavior Monitoring with Reputation Scoring
 */

import { EventEmitter } from 'events';

interface NodeBehavior {
  nodeId: string;
  uptime: number;
  responseTime: number;
  validTransactions: number;
  invalidTransactions: number;
  consensusParticipation: number;
  lastSeen: Date;
}

interface ReputationScore {
  nodeId: string;
  score: number; // 0-100
  history: { score: number; timestamp: Date }[];
  trustLevel: 'untrusted' | 'low' | 'medium' | 'high' | 'verified';
}

export class NodeBehaviorMonitor extends EventEmitter {
  private behaviors: Map<string, NodeBehavior> = new Map();
  private reputations: Map<string, ReputationScore> = new Map();

  async recordBehavior(
    nodeId: string,
    behavior: Partial<NodeBehavior>
  ): Promise<void> {
    const existing = this.behaviors.get(nodeId) || {
      nodeId,
      uptime: 0,
      responseTime: 0,
      validTransactions: 0,
      invalidTransactions: 0,
      consensusParticipation: 0,
      lastSeen: new Date(),
    };

    const updated = { ...existing, ...behavior, lastSeen: new Date() };
    this.behaviors.set(nodeId, updated);

    await this.updateReputation(nodeId);
  }

  private async updateReputation(nodeId: string): Promise<void> {
    const behavior = this.behaviors.get(nodeId);
    if (!behavior) return;

    const score = this.calculateReputationScore(behavior);
    const reputation = this.reputations.get(nodeId) || {
      nodeId,
      score: 50,
      history: [],
      trustLevel: 'untrusted',
    };

    reputation.score = score;
    reputation.history.push({ score, timestamp: new Date() });
    reputation.trustLevel = this.getTrustLevel(score);

    this.reputations.set(nodeId, reputation);
    this.emit('reputationUpdated', {
      nodeId,
      score,
      trustLevel: reputation.trustLevel,
    });
  }

  private calculateReputationScore(behavior: NodeBehavior): number {
    let score = 50; // Base score

    // Uptime contribution (max 25 points)
    score += Math.min(25, behavior.uptime / 1000);

    // Transaction validity (max 30 points)
    const totalTx = behavior.validTransactions + behavior.invalidTransactions;
    if (totalTx > 0) {
      score += (behavior.validTransactions / totalTx) * 30;
    }

    // Consensus participation (max 20 points)
    score += Math.min(20, behavior.consensusParticipation / 5);

    // Response time penalty
    if (behavior.responseTime > 1000) score -= 5;

    return Math.max(0, Math.min(100, score));
  }

  private getTrustLevel(score: number): ReputationScore['trustLevel'] {
    if (score >= 90) return 'verified';
    if (score >= 70) return 'high';
    if (score >= 50) return 'medium';
    if (score >= 30) return 'low';
    return 'untrusted';
  }

  getReputation(nodeId: string): ReputationScore | undefined {
    return this.reputations.get(nodeId);
  }
}
