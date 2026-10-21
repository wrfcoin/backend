/**
 * Eclipse Attack Protection - Connection Diversity Enforcement
 *
 * Enforces minimum diversity standards for peer connections to prevent
 * Eclipse attacks through homogeneous peer sets and geographic isolation.
 *
 * Key Features:
 * - Real-time diversity score monitoring
 * - Automatic peer rotation for diversity maintenance
 * - Connection health monitoring
 * - Diversity requirement enforcement
 * - Alert generation on threshold violations
 */

import { EventEmitter } from 'events';
import type { PeerInfo, DiversityScore, GeographicRegion } from './eclipse-peer-selection.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface ConnectionDiversityRequirements {
  minimumConnections: number;           // At least 20 active peers
  geographicSpread: number;            // Peers in 3+ continents
  asnSpread: number;                   // Peers from 5+ ASNs
  redundantPaths: number;              // 3+ independent routing paths
  maximumSingleSourcePercent: number;  // < 20% peers from same /16
  diversityScoreThreshold: number;     // Minimum 70/100
  rebalanceInterval: number;           // Rebalance every 30 minutes
}

export interface ConnectionHealth {
  peerId: string;
  isHealthy: boolean;
  lastHeartbeat: Date;
  latency: number;
  packetLoss: number;
  bandwidth: number;
  uptime: number;
  failedAttempts: number;
}

export interface DiversityViolation {
  type: ViolationType;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  description: string;
  currentValue: number;
  requiredValue: number;
  timestamp: Date;
}

export enum ViolationType {
  INSUFFICIENT_CONNECTIONS = 'INSUFFICIENT_CONNECTIONS',
  GEOGRAPHIC_CONCENTRATION = 'GEOGRAPHIC_CONCENTRATION',
  ASN_CONCENTRATION = 'ASN_CONCENTRATION',
  SUBNET_CONCENTRATION = 'SUBNET_CONCENTRATION',
  DIVERSITY_SCORE_LOW = 'DIVERSITY_SCORE_LOW',
  SINGLE_REGION_ISOLATION = 'SINGLE_REGION_ISOLATION'
}

export interface RotationStrategy {
  peersToRemove: string[];
  peersToAdd: string[];
  reason: string;
  expectedImprovement: number;
}

// ============================================================================
// Connection Diversity Manager
// ============================================================================

export class ConnectionDiversityManager extends EventEmitter {
  private requirements: ConnectionDiversityRequirements;
  private activeConnections: Map<string, PeerInfo> = new Map();
  private connectionHealth: Map<string, ConnectionHealth> = new Map();
  private violations: DiversityViolation[] = [];
  private rebalanceTimer?: NodeJS.Timeout;

  constructor(requirements?: Partial<ConnectionDiversityRequirements>) {
    super();

    this.requirements = {
      minimumConnections: 20,
      geographicSpread: 3,
      asnSpread: 5,
      redundantPaths: 3,
      maximumSingleSourcePercent: 0.20,
      diversityScoreThreshold: 70,
      rebalanceInterval: 1800000, // 30 minutes
      ...requirements
    };

    this.startRebalancing();
  }

  // ============================================================================
  // Connection Management
  // ============================================================================

  /**
   * Add connection and validate diversity
   */
  public async addConnection(peer: PeerInfo): Promise<{ accepted: boolean; reason?: string }> {
    // Check if adding this peer would violate diversity requirements
    const testConnections = new Map(this.activeConnections);
    testConnections.set(peer.nodeId, peer);

    const testScore = this.calculateDiversityScore(Array.from(testConnections.values()));

    if (!this.meetsDiversityRequirements(testScore)) {
      const violation = this.identifyViolation(testScore);
      this.emit('connectionRejected', { peer, reason: violation.description });

      return {
        accepted: false,
        reason: violation.description
      };
    }

    // Accept connection
    this.activeConnections.set(peer.nodeId, peer);
    this.connectionHealth.set(peer.nodeId, {
      peerId: peer.nodeId,
      isHealthy: true,
      lastHeartbeat: new Date(),
      latency: peer.connectionLatency,
      packetLoss: 0,
      bandwidth: 0,
      uptime: 100,
      failedAttempts: 0
    });

    this.emit('connectionAccepted', peer);
    return { accepted: true };
  }

  /**
   * Remove connection
   */
  public removeConnection(peerId: string): void {
    this.activeConnections.delete(peerId);
    this.connectionHealth.delete(peerId);
    this.emit('connectionRemoved', peerId);

    // Check if removal caused diversity violation
    this.checkDiversityCompliance();
  }

  /**
   * Update connection health
   */
  public updateConnectionHealth(peerId: string, health: Partial<ConnectionHealth>): void {
    const current = this.connectionHealth.get(peerId);
    if (current) {
      Object.assign(current, health);

      // Check if unhealthy
      if (!this.isConnectionHealthy(current)) {
        current.isHealthy = false;
        this.emit('connectionUnhealthy', { peerId, health: current });

        // Consider replacing unhealthy connection
        this.considerReplacement(peerId);
      }
    }
  }

  /**
   * Check if connection is healthy
   */
  private isConnectionHealthy(health: ConnectionHealth): boolean {
    const now = Date.now();
    const timeSinceHeartbeat = now - health.lastHeartbeat.getTime();

    return (
      timeSinceHeartbeat < 60000 &&        // Heartbeat within last minute
      health.latency < 500 &&              // Latency under 500ms
      health.packetLoss < 0.05 &&          // Packet loss under 5%
      health.uptime > 95 &&                // Uptime over 95%
      health.failedAttempts < 3            // Fewer than 3 failed attempts
    );
  }

  // ============================================================================
  // Diversity Scoring
  // ============================================================================

  /**
   * Calculate diversity score for connection set
   */
  public calculateDiversityScore(connections: PeerInfo[]): DiversityScore {
    const violations: string[] = [];

    // 1. Connection count
    if (connections.length < this.requirements.minimumConnections) {
      violations.push(
        `Insufficient connections: ${connections.length}/${this.requirements.minimumConnections}`
      );
    }

    // 2. Geographic diversity
    const continents = new Set(connections.map(p => p.continent));
    const geographicDiversity = Math.min(100, (continents.size / 6) * 100);

    if (continents.size < this.requirements.geographicSpread) {
      violations.push(
        `Insufficient geographic spread: ${continents.size}/${this.requirements.geographicSpread} continents`
      );
    }

    // 3. ASN diversity
    const asns = new Set(connections.map(p => p.autonomousSystem));
    const asnDiversity = Math.min(100, (asns.size / 10) * 100);

    if (asns.size < this.requirements.asnSpread) {
      violations.push(
        `Insufficient ASN spread: ${asns.size}/${this.requirements.asnSpread} ASNs`
      );
    }

    // 4. IP subnet diversity
    const subnetCounts = new Map<string, number>();
    connections.forEach(p => {
      const count = subnetCounts.get(p.ipSubnet) || 0;
      subnetCounts.set(p.ipSubnet, count + 1);
    });

    const maxSubnetCount = Math.max(...Array.from(subnetCounts.values()), 0);
    const subnetConcentration = connections.length > 0 ? maxSubnetCount / connections.length : 0;
    const ipDiversity = Math.max(0, 100 - (subnetConcentration * 100));

    if (subnetConcentration > this.requirements.maximumSingleSourcePercent) {
      violations.push(
        `Excessive subnet concentration: ${(subnetConcentration * 100).toFixed(1)}%/${(this.requirements.maximumSingleSourcePercent * 100)}%`
      );
    }

    // 5. Reputation diversity
    const reputationTiers = new Set(connections.map(p => p.reputationTier));
    const reputationDiversity = Math.min(100, (reputationTiers.size / 6) * 100);

    // 6. Stake diversity (Gini coefficient)
    const stakeDiversity = this.calculateStakeDiversity(connections);

    // Calculate overall score
    const overallScore = (
      geographicDiversity * 0.25 +
      asnDiversity * 0.25 +
      ipDiversity * 0.20 +
      reputationDiversity * 0.15 +
      stakeDiversity * 0.15
    );

    const meetsMinimumRequirements = violations.length === 0 &&
      overallScore >= this.requirements.diversityScoreThreshold;

    return {
      overallScore,
      geographicDiversity,
      asnDiversity,
      ipDiversity,
      reputationDiversity,
      stakeDiversity,
      meetsMinimumRequirements,
      violations
    };
  }

  /**
   * Calculate stake diversity using Gini coefficient
   */
  private calculateStakeDiversity(connections: PeerInfo[]): number {
    if (connections.length === 0) return 0;

    const stakes = connections.map(p => Number(p.stakeAmount)).sort((a, b) => a - b);
    const n = stakes.length;

    let numerator = 0;
    stakes.forEach((stake, i) => {
      numerator += (n - i) * stake;
    });

    const denominator = n * stakes.reduce((sum, stake) => sum + stake, 0);
    if (denominator === 0) return 100;

    const gini = (2 * numerator / denominator) - (n + 1) / n;
    return Math.max(0, (1 - gini) * 100);
  }

  /**
   * Check if diversity requirements are met
   */
  private meetsDiversityRequirements(score: DiversityScore): boolean {
    return score.meetsMinimumRequirements;
  }

  /**
   * Identify primary diversity violation
   */
  private identifyViolation(score: DiversityScore): DiversityViolation {
    const connections = Array.from(this.activeConnections.values());

    // Check connection count
    if (connections.length < this.requirements.minimumConnections) {
      return {
        type: ViolationType.INSUFFICIENT_CONNECTIONS,
        severity: 'CRITICAL',
        description: 'Insufficient peer connections',
        currentValue: connections.length,
        requiredValue: this.requirements.minimumConnections,
        timestamp: new Date()
      };
    }

    // Check geographic spread
    const continents = new Set(connections.map(p => p.continent));
    if (continents.size < this.requirements.geographicSpread) {
      return {
        type: ViolationType.GEOGRAPHIC_CONCENTRATION,
        severity: 'HIGH',
        description: 'Insufficient geographic diversity',
        currentValue: continents.size,
        requiredValue: this.requirements.geographicSpread,
        timestamp: new Date()
      };
    }

    // Check ASN spread
    const asns = new Set(connections.map(p => p.autonomousSystem));
    if (asns.size < this.requirements.asnSpread) {
      return {
        type: ViolationType.ASN_CONCENTRATION,
        severity: 'HIGH',
        description: 'Insufficient ASN diversity',
        currentValue: asns.size,
        requiredValue: this.requirements.asnSpread,
        timestamp: new Date()
      };
    }

    // Check subnet concentration
    const subnetCounts = new Map<string, number>();
    connections.forEach(p => {
      const count = subnetCounts.get(p.ipSubnet) || 0;
      subnetCounts.set(p.ipSubnet, count + 1);
    });

    const maxSubnetCount = Math.max(...Array.from(subnetCounts.values()));
    const concentration = maxSubnetCount / connections.length;

    if (concentration > this.requirements.maximumSingleSourcePercent) {
      return {
        type: ViolationType.SUBNET_CONCENTRATION,
        severity: 'MEDIUM',
        description: 'Excessive subnet concentration',
        currentValue: concentration * 100,
        requiredValue: this.requirements.maximumSingleSourcePercent * 100,
        timestamp: new Date()
      };
    }

    // Default: low diversity score
    return {
      type: ViolationType.DIVERSITY_SCORE_LOW,
      severity: 'MEDIUM',
      description: 'Overall diversity score below threshold',
      currentValue: score.overallScore,
      requiredValue: this.requirements.diversityScoreThreshold,
      timestamp: new Date()
    };
  }

  // ============================================================================
  // Diversity Compliance Checking
  // ============================================================================

  /**
   * Check current diversity compliance
   */
  public checkDiversityCompliance(): DiversityScore {
    const connections = Array.from(this.activeConnections.values());
    const score = this.calculateDiversityScore(connections);

    if (!score.meetsMinimumRequirements) {
      const violation = this.identifyViolation(score);
      this.violations.push(violation);
      this.emit('diversityViolation', violation);

      // Trigger automatic correction
      this.triggerAutomaticCorrection(violation);
    }

    return score;
  }

  /**
   * Trigger automatic correction for diversity violations
   */
  private async triggerAutomaticCorrection(violation: DiversityViolation): Promise<void> {
    this.emit('autoCorrectStart', violation);

    try {
      const strategy = this.generateCorrectionStrategy(violation);
      await this.executeCorrectionStrategy(strategy);

      this.emit('autoCorrectSuccess', { violation, strategy });
    } catch (error) {
      this.emit('autoCorrectFailed', { violation, error });
    }
  }

  /**
   * Generate correction strategy for violation
   */
  private generateCorrectionStrategy(violation: DiversityViolation): RotationStrategy {
    const connections = Array.from(this.activeConnections.values());
    const peersToRemove: string[] = [];
    const peersToAdd: string[] = [];

    switch (violation.type) {
      case ViolationType.GEOGRAPHIC_CONCENTRATION:
        // Remove peers from over-represented regions
        const regionCounts = new Map<string, string[]>();
        connections.forEach(p => {
          const peers = regionCounts.get(p.continent) || [];
          peers.push(p.nodeId);
          regionCounts.set(p.continent, peers);
        });

        // Find most concentrated region
        let maxRegion = '';
        let maxCount = 0;
        regionCounts.forEach((peers, region) => {
          if (peers.length > maxCount) {
            maxCount = peers.length;
            maxRegion = region;
          }
        });

        // Remove lowest reputation peers from that region
        const regionPeers = regionCounts.get(maxRegion) || [];
        const sortedByReputation = regionPeers
          .map(id => this.activeConnections.get(id)!)
          .sort((a, b) => a.reputationScore - b.reputationScore);

        peersToRemove.push(...sortedByReputation.slice(0, 2).map(p => p.nodeId));
        break;

      case ViolationType.ASN_CONCENTRATION:
        // Similar logic for ASN concentration
        const asnCounts = new Map<string, string[]>();
        connections.forEach(p => {
          const peers = asnCounts.get(p.autonomousSystem) || [];
          peers.push(p.nodeId);
          asnCounts.set(p.autonomousSystem, peers);
        });

        let maxAsn = '';
        let maxAsnCount = 0;
        asnCounts.forEach((peers, asn) => {
          if (peers.length > maxAsnCount) {
            maxAsnCount = peers.length;
            maxAsn = asn;
          }
        });

        const asnPeers = asnCounts.get(maxAsn) || [];
        const sortedAsnPeers = asnPeers
          .map(id => this.activeConnections.get(id)!)
          .sort((a, b) => a.reputationScore - b.reputationScore);

        peersToRemove.push(...sortedAsnPeers.slice(0, 2).map(p => p.nodeId));
        break;

      case ViolationType.SUBNET_CONCENTRATION:
        // Remove peers from concentrated subnets
        const subnetCounts = new Map<string, string[]>();
        connections.forEach(p => {
          const peers = subnetCounts.get(p.ipSubnet) || [];
          peers.push(p.nodeId);
          subnetCounts.set(p.ipSubnet, peers);
        });

        let maxSubnet = '';
        let maxSubnetCount = 0;
        subnetCounts.forEach((peers, subnet) => {
          if (peers.length > maxSubnetCount) {
            maxSubnetCount = peers.length;
            maxSubnet = subnet;
          }
        });

        const subnetPeers = subnetCounts.get(maxSubnet) || [];
        const sortedSubnetPeers = subnetPeers
          .map(id => this.activeConnections.get(id)!)
          .sort((a, b) => a.reputationScore - b.reputationScore);

        peersToRemove.push(...sortedSubnetPeers.slice(0, 2).map(p => p.nodeId));
        break;

      default:
        // Remove lowest reputation peers
        const sorted = connections
          .sort((a, b) => a.reputationScore - b.reputationScore);
        peersToRemove.push(...sorted.slice(0, 2).map(p => p.nodeId));
    }

    return {
      peersToRemove,
      peersToAdd,
      reason: violation.description,
      expectedImprovement: 10 // Expected 10 point improvement
    };
  }

  /**
   * Execute correction strategy
   */
  private async executeCorrectionStrategy(strategy: RotationStrategy): Promise<void> {
    // Remove peers
    strategy.peersToRemove.forEach(peerId => {
      this.removeConnection(peerId);
    });

    // Signal need for new diverse peers
    this.emit('needDiversePeers', {
      count: strategy.peersToRemove.length,
      reason: strategy.reason
    });
  }

  // ============================================================================
  // Peer Rotation and Rebalancing
  // ============================================================================

  /**
   * Start automatic rebalancing
   */
  private startRebalancing(): void {
    this.rebalanceTimer = setInterval(
      () => this.performRebalance(),
      this.requirements.rebalanceInterval
    );
  }

  /**
   * Stop automatic rebalancing
   */
  public stopRebalancing(): void {
    if (this.rebalanceTimer) {
      clearInterval(this.rebalanceTimer);
    }
  }

  /**
   * Perform peer set rebalancing
   */
  public async performRebalance(): Promise<void> {
    this.emit('rebalanceStart');

    try {
      const score = this.checkDiversityCompliance();

      if (!score.meetsMinimumRequirements) {
        // Already handled by checkDiversityCompliance
        this.emit('rebalanceComplete', { action: 'corrected', score });
        return;
      }

      // Even if compliant, optimize for better diversity
      if (score.overallScore < 85) {
        await this.optimizeDiversity();
        this.emit('rebalanceComplete', { action: 'optimized', score });
      } else {
        this.emit('rebalanceComplete', { action: 'none', score });
      }
    } catch (error) {
      this.emit('rebalanceError', error);
    }
  }

  /**
   * Optimize diversity score through peer rotation
   */
  private async optimizeDiversity(): Promise<void> {
    const connections = Array.from(this.activeConnections.values());

    // Find peers that contribute least to diversity
    const peerContributions = connections.map(peer => ({
      peer,
      contribution: this.calculatePeerDiversityContribution(peer, connections)
    }));

    // Sort by contribution (ascending)
    peerContributions.sort((a, b) => a.contribution - b.contribution);

    // Replace bottom 10% with request for diverse peers
    const replaceCount = Math.max(1, Math.floor(connections.length * 0.1));
    const toReplace = peerContributions.slice(0, replaceCount);

    toReplace.forEach(({ peer }) => {
      this.removeConnection(peer.nodeId);
    });

    this.emit('needDiversePeers', {
      count: replaceCount,
      reason: 'Diversity optimization'
    });
  }

  /**
   * Calculate how much a peer contributes to overall diversity
   */
  private calculatePeerDiversityContribution(peer: PeerInfo, allPeers: PeerInfo[]): number {
    // Score based on uniqueness
    let contribution = 0;

    // Geographic uniqueness
    const sameContinent = allPeers.filter(p => p.continent === peer.continent).length;
    contribution += 100 / sameContinent;

    // ASN uniqueness
    const sameAsn = allPeers.filter(p => p.autonomousSystem === peer.autonomousSystem).length;
    contribution += 100 / sameAsn;

    // Subnet uniqueness
    const sameSubnet = allPeers.filter(p => p.ipSubnet === peer.ipSubnet).length;
    contribution += 100 / sameSubnet;

    // Reputation tier uniqueness
    const sameTier = allPeers.filter(p => p.reputationTier === peer.reputationTier).length;
    contribution += 50 / sameTier;

    return contribution;
  }

  /**
   * Consider replacing unhealthy connection
   */
  private considerReplacement(peerId: string): void {
    const health = this.connectionHealth.get(peerId);
    if (!health) return;

    // If severely unhealthy, replace immediately
    if (health.failedAttempts >= 5 || health.uptime < 50) {
      this.removeConnection(peerId);
      this.emit('needDiversePeers', {
        count: 1,
        reason: `Replaced unhealthy peer ${peerId}`
      });
    }
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  public getCurrentScore(): DiversityScore {
    const connections = Array.from(this.activeConnections.values());
    return this.calculateDiversityScore(connections);
  }

  public getActiveConnections(): PeerInfo[] {
    return Array.from(this.activeConnections.values());
  }

  public getViolations(): DiversityViolation[] {
    return [...this.violations];
  }

  public getConnectionHealth(peerId: string): ConnectionHealth | undefined {
    return this.connectionHealth.get(peerId);
  }
}

export default ConnectionDiversityManager;
