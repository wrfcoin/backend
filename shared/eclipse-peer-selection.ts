/**
 * Eclipse Attack Protection - Diverse Peer Selection
 *
 * Implements intelligent peer selection algorithms with strict diversity requirements
 * to prevent Eclipse attacks where malicious nodes attempt to isolate honest participants.
 *
 * Key Features:
 * - Geographic diversity enforcement (minimum 3 continents)
 * - Autonomous System Number (ASN) diversity (minimum 5 ASNs)
 * - IP subnet distribution limits (max 20% from single /16)
 * - Reputation-weighted selection across trust tiers
 * - Stake-weighted diversity balancing
 * - Real-time diversity scoring and optimization
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface PeerInfo {
  nodeId: string;
  ipAddress: string;
  port: number;
  publicKey: string;
  geographicRegion: GeographicRegion;
  continent: string;
  country: string;
  autonomousSystem: string; // ASN
  ipSubnet: string; // /16 subnet
  reputationScore: number; // 0-100
  reputationTier: ReputationTier;
  stakeAmount: bigint;
  lastSeen: Date;
  connectionLatency: number; // milliseconds
  uptimePercentage: number;
  successfulTransactions: number;
  failedTransactions: number;
  consensusParticipation: number; // percentage
  isBootstrapNode: boolean;
}

export enum GeographicRegion {
  NORTH_AMERICA = 'NORTH_AMERICA',
  SOUTH_AMERICA = 'SOUTH_AMERICA',
  EUROPE = 'EUROPE',
  AFRICA = 'AFRICA',
  ASIA = 'ASIA',
  OCEANIA = 'OCEANIA',
  MIDDLE_EAST = 'MIDDLE_EAST'
}

export enum ReputationTier {
  BOOTSTRAP = 'BOOTSTRAP',      // Trusted bootstrap nodes
  EXCELLENT = 'EXCELLENT',       // 90-100 reputation
  GOOD = 'GOOD',                 // 70-89 reputation
  AVERAGE = 'AVERAGE',           // 50-69 reputation
  BELOW_AVERAGE = 'BELOW_AVERAGE', // 30-49 reputation
  POOR = 'POOR',                 // 0-29 reputation
  UNKNOWN = 'UNKNOWN'            // No reputation data
}

export interface PeerSelectionCriteria {
  minimumPeerCount: number;      // At least 20 diverse peers
  maximumPeerCount: number;      // Cap at 100 peers
  geographicRegions: string[];   // Minimum 3 continents
  autonomousSystems: string[];   // Minimum 5 different ASNs
  maxSubnetConcentration: number; // Maximum 20% from single /16
  reputationTiers: ReputationTier[]; // Mix across all tiers
  minimumDiversityScore: number; // Threshold for acceptance
  stakeWeightFactor: number;     // 0-1, weight given to stake
  latencyWeightFactor: number;   // 0-1, weight given to latency
  reputationWeightFactor: number; // 0-1, weight given to reputation
}

export interface DiversityScore {
  overallScore: number;          // 0-100
  geographicDiversity: number;   // 0-100
  asnDiversity: number;          // 0-100
  ipDiversity: number;           // 0-100
  reputationDiversity: number;   // 0-100
  stakeDiversity: number;        // 0-100
  meetsMinimumRequirements: boolean;
  violations: string[];
}

export interface PeerSelectionResult {
  selectedPeers: PeerInfo[];
  diversityScore: DiversityScore;
  rejectedPeers: Array<{ peer: PeerInfo; reason: string }>;
  timestamp: Date;
}

// ============================================================================
// Diverse Peer Selection Manager
// ============================================================================

export class DiversePeerSelectionManager extends EventEmitter {
  private peers: Map<string, PeerInfo> = new Map();
  private selectedPeers: Set<string> = new Set();
  private criteria: PeerSelectionCriteria;
  private geoIpDatabase: Map<string, { continent: string; country: string; asn: string }> = new Map();

  constructor(criteria?: Partial<PeerSelectionCriteria>) {
    super();

    this.criteria = {
      minimumPeerCount: 20,
      maximumPeerCount: 100,
      geographicRegions: [
        GeographicRegion.NORTH_AMERICA,
        GeographicRegion.EUROPE,
        GeographicRegion.ASIA
      ],
      autonomousSystems: [], // Will be filled dynamically
      maxSubnetConcentration: 0.20, // 20%
      reputationTiers: Object.values(ReputationTier),
      minimumDiversityScore: 70,
      stakeWeightFactor: 0.3,
      latencyWeightFactor: 0.2,
      reputationWeightFactor: 0.5,
      ...criteria
    };

    this.initializeGeoIpDatabase();
  }

  // ============================================================================
  // Peer Management
  // ============================================================================

  /**
   * Add a peer to the available peer pool
   */
  public addPeer(peer: PeerInfo): void {
    // Enrich peer with geographic data if not provided
    if (!peer.continent || !peer.autonomousSystem) {
      const geoData = this.lookupGeoData(peer.ipAddress);
      peer.continent = geoData.continent;
      peer.country = geoData.country;
      peer.autonomousSystem = geoData.asn;
    }

    // Calculate IP subnet
    peer.ipSubnet = this.calculateSubnet(peer.ipAddress);

    // Determine reputation tier
    peer.reputationTier = this.determineReputationTier(peer);

    this.peers.set(peer.nodeId, peer);
    this.emit('peerAdded', peer);
  }

  /**
   * Remove a peer from the pool
   */
  public removePeer(nodeId: string): void {
    this.peers.delete(nodeId);
    this.selectedPeers.delete(nodeId);
    this.emit('peerRemoved', nodeId);
  }

  /**
   * Update peer information
   */
  public updatePeer(nodeId: string, updates: Partial<PeerInfo>): void {
    const peer = this.peers.get(nodeId);
    if (peer) {
      Object.assign(peer, updates);
      if (updates.reputationScore !== undefined) {
        peer.reputationTier = this.determineReputationTier(peer);
      }
      this.emit('peerUpdated', peer);
    }
  }

  // ============================================================================
  // Peer Selection Algorithm
  // ============================================================================

  /**
   * Select diverse peer set meeting all criteria
   */
  public selectDiversePeers(): PeerSelectionResult {
    const availablePeers = Array.from(this.peers.values());
    const selectedPeers: PeerInfo[] = [];
    const rejectedPeers: Array<{ peer: PeerInfo; reason: string }> = [];

    // Phase 1: Bootstrap nodes (always include)
    const bootstrapPeers = availablePeers.filter(p => p.isBootstrapNode);
    selectedPeers.push(...bootstrapPeers.slice(0, Math.min(5, bootstrapPeers.length)));

    // Phase 2: Geographic diversity - ensure representation from required continents
    const continentPeers = this.selectByContinent(availablePeers, selectedPeers);
    selectedPeers.push(...continentPeers);

    // Phase 3: ASN diversity - ensure ASN spread
    const asnPeers = this.selectByASN(availablePeers, selectedPeers);
    selectedPeers.push(...asnPeers);

    // Phase 4: Reputation diversity - ensure tier spread
    const reputationPeers = this.selectByReputation(availablePeers, selectedPeers);
    selectedPeers.push(...reputationPeers);

    // Phase 5: Fill remaining slots with optimal peers
    const remainingSlots = this.criteria.maximumPeerCount - selectedPeers.length;
    if (remainingSlots > 0) {
      const optimalPeers = this.selectOptimalPeers(
        availablePeers,
        selectedPeers,
        remainingSlots
      );
      selectedPeers.push(...optimalPeers);
    }

    // Phase 6: Validate diversity requirements
    const diversityScore = this.calculateDiversityScore(selectedPeers);

    // Phase 7: If requirements not met, attempt optimization
    if (!diversityScore.meetsMinimumRequirements) {
      const optimized = this.optimizePeerSelection(availablePeers, selectedPeers);
      selectedPeers.length = 0;
      selectedPeers.push(...optimized);
    }

    // Update selected peers set
    this.selectedPeers.clear();
    selectedPeers.forEach(p => this.selectedPeers.add(p.nodeId));

    const result: PeerSelectionResult = {
      selectedPeers,
      diversityScore: this.calculateDiversityScore(selectedPeers),
      rejectedPeers,
      timestamp: new Date()
    };

    this.emit('peersSelected', result);
    return result;
  }

  /**
   * Select peers ensuring continent diversity
   */
  private selectByContinent(
    availablePeers: PeerInfo[],
    currentSelection: PeerInfo[]
  ): PeerInfo[] {
    const selected: PeerInfo[] = [];
    const selectedContinents = new Set(currentSelection.map(p => p.continent));
    const requiredContinents = this.criteria.geographicRegions;

    for (const continent of requiredContinents) {
      if (selectedContinents.has(continent)) continue;

      // Find best peer from this continent
      const continentPeers = availablePeers.filter(
        p => p.continent === continent && !this.isPeerSelected(p, currentSelection)
      );

      if (continentPeers.length > 0) {
        const best = this.selectBestPeer(continentPeers);
        selected.push(best);
        selectedContinents.add(continent);
      }
    }

    return selected;
  }

  /**
   * Select peers ensuring ASN diversity
   */
  private selectByASN(
    availablePeers: PeerInfo[],
    currentSelection: PeerInfo[]
  ): PeerInfo[] {
    const selected: PeerInfo[] = [];
    const selectedASNs = new Set(currentSelection.map(p => p.autonomousSystem));
    const targetASNCount = 5; // Minimum 5 different ASNs

    while (selectedASNs.size < targetASNCount) {
      // Find best peer from unused ASN
      const candidatePeers = availablePeers.filter(
        p => !selectedASNs.has(p.autonomousSystem) &&
             !this.isPeerSelected(p, [...currentSelection, ...selected])
      );

      if (candidatePeers.length === 0) break;

      const best = this.selectBestPeer(candidatePeers);
      selected.push(best);
      selectedASNs.add(best.autonomousSystem);
    }

    return selected;
  }

  /**
   * Select peers ensuring reputation tier diversity
   */
  private selectByReputation(
    availablePeers: PeerInfo[],
    currentSelection: PeerInfo[]
  ): PeerInfo[] {
    const selected: PeerInfo[] = [];
    const selectedTiers = new Set(currentSelection.map(p => p.reputationTier));
    const targetTiers = [
      ReputationTier.EXCELLENT,
      ReputationTier.GOOD,
      ReputationTier.AVERAGE
    ];

    for (const tier of targetTiers) {
      if (selectedTiers.has(tier)) continue;

      // Find best peer from this tier
      const tierPeers = availablePeers.filter(
        p => p.reputationTier === tier &&
             !this.isPeerSelected(p, [...currentSelection, ...selected])
      );

      if (tierPeers.length > 0) {
        const best = this.selectBestPeer(tierPeers);
        selected.push(best);
        selectedTiers.add(tier);
      }
    }

    return selected;
  }

  /**
   * Select optimal peers to fill remaining slots
   */
  private selectOptimalPeers(
    availablePeers: PeerInfo[],
    currentSelection: PeerInfo[],
    count: number
  ): PeerInfo[] {
    const candidates = availablePeers.filter(
      p => !this.isPeerSelected(p, currentSelection)
    );

    // Score each candidate by how much it improves diversity
    const scoredCandidates = candidates.map(peer => ({
      peer,
      score: this.calculatePeerSelectionScore(peer, currentSelection)
    }));

    // Sort by score descending
    scoredCandidates.sort((a, b) => b.score - a.score);

    // Select top N
    return scoredCandidates.slice(0, count).map(c => c.peer);
  }

  /**
   * Calculate selection score for a peer
   */
  private calculatePeerSelectionScore(peer: PeerInfo, currentSelection: PeerInfo[]): number {
    let score = 0;

    // Reputation score component
    score += peer.reputationScore * this.criteria.reputationWeightFactor;

    // Latency component (lower is better)
    const latencyScore = Math.max(0, 100 - peer.connectionLatency / 10);
    score += latencyScore * this.criteria.latencyWeightFactor;

    // Stake component
    const stakeScore = Math.min(100, Number(peer.stakeAmount) / 1000);
    score += stakeScore * this.criteria.stakeWeightFactor;

    // Diversity bonus
    const diversityBonus = this.calculateDiversityBonus(peer, currentSelection);
    score += diversityBonus * 0.3;

    // Uptime bonus
    score += peer.uptimePercentage * 0.2;

    return score;
  }

  /**
   * Calculate diversity bonus for adding a peer
   */
  private calculateDiversityBonus(peer: PeerInfo, currentSelection: PeerInfo[]): number {
    let bonus = 0;

    // Continent diversity bonus
    const continents = new Set(currentSelection.map(p => p.continent));
    if (!continents.has(peer.continent)) {
      bonus += 50;
    }

    // ASN diversity bonus
    const asns = new Set(currentSelection.map(p => p.autonomousSystem));
    if (!asns.has(peer.autonomousSystem)) {
      bonus += 30;
    }

    // Reputation tier diversity bonus
    const tiers = new Set(currentSelection.map(p => p.reputationTier));
    if (!tiers.has(peer.reputationTier)) {
      bonus += 20;
    }

    return bonus;
  }

  /**
   * Select best peer from a set based on composite score
   */
  private selectBestPeer(peers: PeerInfo[]): PeerInfo {
    return peers.reduce((best, current) => {
      const bestScore = this.calculatePeerSelectionScore(best, []);
      const currentScore = this.calculatePeerSelectionScore(current, []);
      return currentScore > bestScore ? current : best;
    });
  }

  /**
   * Check if peer is already selected
   */
  private isPeerSelected(peer: PeerInfo, selection: PeerInfo[]): boolean {
    return selection.some(p => p.nodeId === peer.nodeId);
  }

  // ============================================================================
  // Diversity Scoring
  // ============================================================================

  /**
   * Calculate comprehensive diversity score
   */
  public calculateDiversityScore(peers: PeerInfo[]): DiversityScore {
    const violations: string[] = [];

    // Geographic diversity
    const continents = new Set(peers.map(p => p.continent));
    const geographicDiversity = Math.min(100, (continents.size / 6) * 100);
    if (continents.size < 3) {
      violations.push(`Insufficient geographic diversity: ${continents.size} continents (minimum 3)`);
    }

    // ASN diversity
    const asns = new Set(peers.map(p => p.autonomousSystem));
    const asnDiversity = Math.min(100, (asns.size / 10) * 100);
    if (asns.size < 5) {
      violations.push(`Insufficient ASN diversity: ${asns.size} ASNs (minimum 5)`);
    }

    // IP subnet diversity
    const subnets = new Map<string, number>();
    peers.forEach(p => {
      const count = subnets.get(p.ipSubnet) || 0;
      subnets.set(p.ipSubnet, count + 1);
    });

    const maxSubnetCount = Math.max(...subnets.values());
    const subnetConcentration = maxSubnetCount / peers.length;
    const ipDiversity = Math.max(0, 100 - (subnetConcentration * 100));

    if (subnetConcentration > this.criteria.maxSubnetConcentration) {
      violations.push(
        `Excessive subnet concentration: ${(subnetConcentration * 100).toFixed(1)}% (maximum 20%)`
      );
    }

    // Reputation diversity
    const tiers = new Set(peers.map(p => p.reputationTier));
    const reputationDiversity = Math.min(100, (tiers.size / Object.keys(ReputationTier).length) * 100);

    // Stake diversity (Gini coefficient)
    const stakeDiversity = this.calculateStakeDiversity(peers);

    // Overall score (weighted average)
    const overallScore = (
      geographicDiversity * 0.25 +
      asnDiversity * 0.25 +
      ipDiversity * 0.20 +
      reputationDiversity * 0.15 +
      stakeDiversity * 0.15
    );

    // Check minimum requirements
    const meetsMinimumRequirements =
      peers.length >= this.criteria.minimumPeerCount &&
      continents.size >= 3 &&
      asns.size >= 5 &&
      subnetConcentration <= this.criteria.maxSubnetConcentration &&
      overallScore >= this.criteria.minimumDiversityScore;

    if (peers.length < this.criteria.minimumPeerCount) {
      violations.push(`Insufficient peer count: ${peers.length} (minimum ${this.criteria.minimumPeerCount})`);
    }

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
  private calculateStakeDiversity(peers: PeerInfo[]): number {
    if (peers.length === 0) return 0;

    const stakes = peers.map(p => Number(p.stakeAmount)).sort((a, b) => a - b);
    const n = stakes.length;

    let numerator = 0;
    stakes.forEach((stake, i) => {
      numerator += (n - i) * stake;
    });

    const denominator = n * stakes.reduce((sum, stake) => sum + stake, 0);
    const gini = (2 * numerator / denominator) - (n + 1) / n;

    // Convert Gini (0=equal, 1=unequal) to diversity score (100=diverse, 0=concentrated)
    return Math.max(0, (1 - gini) * 100);
  }

  // ============================================================================
  // Optimization
  // ============================================================================

  /**
   * Optimize peer selection to meet diversity requirements
   */
  private optimizePeerSelection(
    availablePeers: PeerInfo[],
    currentSelection: PeerInfo[]
  ): PeerInfo[] {
    let bestSelection = [...currentSelection];
    let bestScore = this.calculateDiversityScore(bestSelection);

    // Genetic algorithm-style optimization
    const iterations = 50;
    const populationSize = 10;

    for (let iter = 0; iter < iterations; iter++) {
      const population: PeerInfo[][] = [];

      // Generate population variations
      for (let i = 0; i < populationSize; i++) {
        const variation = this.generatePeerSelectionVariation(
          availablePeers,
          bestSelection
        );
        population.push(variation);
      }

      // Evaluate population
      for (const selection of population) {
        const score = this.calculateDiversityScore(selection);
        if (score.overallScore > bestScore.overallScore) {
          bestSelection = selection;
          bestScore = score;

          if (bestScore.meetsMinimumRequirements) {
            return bestSelection;
          }
        }
      }
    }

    return bestSelection;
  }

  /**
   * Generate variation of peer selection
   */
  private generatePeerSelectionVariation(
    availablePeers: PeerInfo[],
    baseSelection: PeerInfo[]
  ): PeerInfo[] {
    const variation = [...baseSelection];

    // Randomly replace 20% of peers
    const replaceCount = Math.floor(variation.length * 0.2);

    for (let i = 0; i < replaceCount; i++) {
      const removeIndex = Math.floor(Math.random() * variation.length);
      variation.splice(removeIndex, 1);

      const candidates = availablePeers.filter(
        p => !this.isPeerSelected(p, variation)
      );

      if (candidates.length > 0) {
        const randomIndex = Math.floor(Math.random() * candidates.length);
        variation.push(candidates[randomIndex]);
      }
    }

    return variation;
  }

  // ============================================================================
  // Peer Set Rebalancing
  // ============================================================================

  /**
   * Rebalance peer set to maintain diversity
   */
  public rebalancePeerSet(): PeerSelectionResult {
    const currentScore = this.calculateDiversityScore(
      Array.from(this.selectedPeers.values()).map(id => this.peers.get(id)!)
    );

    if (currentScore.meetsMinimumRequirements &&
        currentScore.overallScore >= this.criteria.minimumDiversityScore) {
      // No rebalancing needed
      return {
        selectedPeers: Array.from(this.selectedPeers.values()).map(id => this.peers.get(id)!),
        diversityScore: currentScore,
        rejectedPeers: [],
        timestamp: new Date()
      };
    }

    // Reselect peers
    return this.selectDiversePeers();
  }

  // ============================================================================
  // Utility Methods
  // ============================================================================

  /**
   * Initialize mock GeoIP database
   */
  private initializeGeoIpDatabase(): void {
    // In production, integrate with MaxMind GeoIP2 or similar
    // Mock data for demonstration
    this.geoIpDatabase.set('192.168.1.0/16', {
      continent: GeographicRegion.NORTH_AMERICA,
      country: 'US',
      asn: 'AS15169'
    });
  }

  /**
   * Lookup geographic data for IP
   */
  private lookupGeoData(ip: string): { continent: string; country: string; asn: string } {
    // Mock implementation - in production use GeoIP database
    const hash = this.hashIP(ip);
    const continents = Object.values(GeographicRegion);
    const continent = continents[hash % continents.length];

    return {
      continent,
      country: 'XX',
      asn: `AS${10000 + (hash % 50000)}`
    };
  }

  /**
   * Calculate /16 subnet from IP
   */
  private calculateSubnet(ip: string): string {
    const parts = ip.split('.');
    return `${parts[0]}.${parts[1]}.0.0/16`;
  }

  /**
   * Determine reputation tier from score
   */
  private determineReputationTier(peer: PeerInfo): ReputationTier {
    if (peer.isBootstrapNode) return ReputationTier.BOOTSTRAP;

    const score = peer.reputationScore;
    if (score >= 90) return ReputationTier.EXCELLENT;
    if (score >= 70) return ReputationTier.GOOD;
    if (score >= 50) return ReputationTier.AVERAGE;
    if (score >= 30) return ReputationTier.BELOW_AVERAGE;
    if (score > 0) return ReputationTier.POOR;
    return ReputationTier.UNKNOWN;
  }

  /**
   * Hash IP address for deterministic continent assignment
   */
  private hashIP(ip: string): number {
    const hash = crypto.createHash('sha256').update(ip).digest();
    return hash.readUInt32BE(0);
  }

  /**
   * Get current selected peers
   */
  public getSelectedPeers(): PeerInfo[] {
    return Array.from(this.selectedPeers.values())
      .map(id => this.peers.get(id)!)
      .filter(p => p !== undefined);
  }

  /**
   * Get diversity score for current selection
   */
  public getCurrentDiversityScore(): DiversityScore {
    return this.calculateDiversityScore(this.getSelectedPeers());
  }

  /**
   * Check if peer would be accepted
   */
  public wouldAcceptPeer(peer: PeerInfo): { accept: boolean; reason?: string } {
    const currentSelection = this.getSelectedPeers();
    const testSelection = [...currentSelection, peer];
    const score = this.calculateDiversityScore(testSelection);

    if (score.violations.length > 0) {
      return {
        accept: false,
        reason: score.violations.join('; ')
      };
    }

    return { accept: true };
  }
}

export default DiversePeerSelectionManager;
