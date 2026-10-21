/**
 * Sybil Attack Prevention - Security Orchestrator
 *
 * Consolidated implementation of reputation, challenge-response, economic penalties,
 * gradual trust, and topology analysis systems.
 */

import { createHash, randomBytes } from 'crypto';
import { ProofOfStakeManager, StakeProof } from './sybil-proof-of-stake.js';
import { PKICertificateManager, NodeCertificate } from './sybil-pki-manager.js';
import { SybilRateLimiter, NodeRegistration } from './sybil-rate-limiter.js';
import { DIDVerifier, DIDVerificationResult } from './sybil-did-verifier.js';
import { securityLogger } from '../server/utils/logger.js';

// ============================================================================
// REPUTATION SCORING SYSTEM
// ============================================================================

export interface ReputationMetrics {
  nodeId: string;
  uptime: number; // 0-100
  responseTime: number; // milliseconds
  messageValidity: number; // 0-100
  consensusAccuracy: number; // 0-100
  peerReports: {
    positive: number;
    negative: number;
  };
  historicalBehavior: number; // 0-100
  lastUpdated: Date;
}

export interface ReputationScore {
  nodeId: string;
  totalScore: number; // 0-100
  tier: 'new' | 'established' | 'trusted' | 'elite';
  metrics: ReputationMetrics;
  privileges: NodePrivileges;
  decayRate: number;
}

export interface NodePrivileges {
  canVote: boolean;
  votingWeight: number; // 0-1
  messagePropagation: 'local' | 'regional' | 'global';
  bandwidthAllocation: number; // 0-100
  priorityLevel: number; // 1-10
}

export class ReputationSystem {
  private scores = new Map<string, ReputationScore>();
  private metricsHistory = new Map<string, ReputationMetrics[]>();

  private readonly TIER_THRESHOLDS = {
    new: { min: 0, max: 30, days: 30 },
    established: { min: 30, max: 70, days: 90 },
    trusted: { min: 70, max: 90, days: 365 },
    elite: { min: 90, max: 100, days: 9999 }
  };

  /**
   * Initialize reputation for new node
   */
  initializeReputation(nodeId: string): ReputationScore {
    const initialMetrics: ReputationMetrics = {
      nodeId,
      uptime: 0,
      responseTime: 0,
      messageValidity: 100,
      consensusAccuracy: 100,
      peerReports: { positive: 0, negative: 0 },
      historicalBehavior: 50,
      lastUpdated: new Date()
    };

    const score: ReputationScore = {
      nodeId,
      totalScore: 50, // Start at 50%
      tier: 'new',
      metrics: initialMetrics,
      privileges: this.calculatePrivileges('new', 50),
      decayRate: 0.1
    };

    this.scores.set(nodeId, score);
    this.metricsHistory.set(nodeId, [initialMetrics]);

    return score;
  }

  /**
   * Update reputation based on behavior
   */
  updateReputation(nodeId: string, metrics: Partial<ReputationMetrics>): ReputationScore {
    const score = this.scores.get(nodeId);
    if (!score) {
      return this.initializeReputation(nodeId);
    }

    // Update metrics
    score.metrics = { ...score.metrics, ...metrics, lastUpdated: new Date() };

    // Calculate new total score
    score.totalScore = this.calculateTotalScore(score.metrics);

    // Update tier
    score.tier = this.calculateTier(nodeId, score.totalScore);

    // Update privileges
    score.privileges = this.calculatePrivileges(score.tier, score.totalScore);

    // Store history
    const history = this.metricsHistory.get(nodeId) || [];
    history.push({ ...score.metrics });
    if (history.length > 1000) history.shift(); // Keep last 1000 entries
    this.metricsHistory.set(nodeId, history);

    this.scores.set(nodeId, score);
    return score;
  }

  /**
   * Report malicious behavior
   */
  reportMaliciousBehavior(nodeId: string, severity: 'low' | 'medium' | 'high' | 'critical'): void {
    const score = this.scores.get(nodeId);
    if (!score) return;

    const penalties = { low: -5, medium: -15, high: -30, critical: -50 };
    score.totalScore = Math.max(0, score.totalScore + penalties[severity]);
    score.metrics.peerReports.negative++;

    this.updateReputation(nodeId, {});
  }

  /**
   * Apply reputation decay for inactive nodes
   */
  applyDecay(): void {
    const now = Date.now();
    const scoreEntries = Array.from(this.scores.entries());
    for (const [nodeId, score] of scoreEntries) {
      const hoursSinceUpdate = (now - score.metrics.lastUpdated.getTime()) / (1000 * 60 * 60);
      if (hoursSinceUpdate > 24) {
        const decayAmount = score.decayRate * (hoursSinceUpdate / 24);
        score.totalScore = Math.max(0, score.totalScore - decayAmount);
        this.scores.set(nodeId, score);
      }
    }
  }

  getReputation(nodeId: string): ReputationScore | undefined {
    return this.scores.get(nodeId);
  }

  private calculateTotalScore(metrics: ReputationMetrics): number {
    const weights = {
      uptime: 0.3,
      messageValidity: 0.25,
      consensusAccuracy: 0.25,
      peerReports: 0.1,
      historicalBehavior: 0.1
    };

    let score = 0;
    score += metrics.uptime * weights.uptime;
    score += metrics.messageValidity * weights.messageValidity;
    score += metrics.consensusAccuracy * weights.consensusAccuracy;

    const peerScore = Math.max(0,
      (metrics.peerReports.positive - metrics.peerReports.negative * 2) /
      Math.max(1, metrics.peerReports.positive + metrics.peerReports.negative) * 100
    );
    score += peerScore * weights.peerReports;
    score += metrics.historicalBehavior * weights.historicalBehavior;

    return Math.max(0, Math.min(100, score));
  }

  private calculateTier(nodeId: string, totalScore: number): ReputationScore['tier'] {
    const history = this.metricsHistory.get(nodeId) || [];
    const ageInDays = history.length / 24; // Assuming hourly updates

    if (ageInDays < 30) return 'new';
    if (ageInDays < 90 && totalScore >= 30) return 'established';
    if (ageInDays < 365 && totalScore >= 70) return 'trusted';
    if (ageInDays >= 365 && totalScore >= 90) return 'elite';

    return 'new';
  }

  private calculatePrivileges(tier: ReputationScore['tier'], totalScore: number): NodePrivileges {
    const tierConfig = {
      new: {
        canVote: false,
        votingWeight: 0,
        messagePropagation: 'local' as const,
        bandwidthAllocation: 20,
        priorityLevel: 1
      },
      established: {
        canVote: true,
        votingWeight: 0.5,
        messagePropagation: 'regional' as const,
        bandwidthAllocation: 50,
        priorityLevel: 5
      },
      trusted: {
        canVote: true,
        votingWeight: 1.0,
        messagePropagation: 'global' as const,
        bandwidthAllocation: 80,
        priorityLevel: 8
      },
      elite: {
        canVote: true,
        votingWeight: 1.5,
        messagePropagation: 'global' as const,
        bandwidthAllocation: 100,
        priorityLevel: 10
      }
    };

    return tierConfig[tier];
  }
}

// ============================================================================
// CHALLENGE-RESPONSE PROTOCOL
// ============================================================================

export interface Challenge {
  challengeId: string;
  nodeId: string;
  type: 'pow' | 'post' | 'pob' | 'time';
  difficulty: number;
  data: string;
  deadline: Date;
  createdAt: Date;
}

export interface ChallengeResponse {
  challengeId: string;
  nodeId: string;
  proof: string;
  computeTime: number;
  submittedAt: Date;
}

export class ChallengeResponseProtocol {
  private activeChallenges = new Map<string, Challenge>();
  private completedChallenges = new Map<string, ChallengeResponse>();

  /**
   * Generate Proof-of-Work challenge
   */
  generatePoWChallenge(nodeId: string, difficulty: number = 4): Challenge {
    const challengeId = this.generateChallengeId();
    const data = randomBytes(32).toString('hex');

    const challenge: Challenge = {
      challengeId,
      nodeId,
      type: 'pow',
      difficulty,
      data,
      deadline: new Date(Date.now() + 5 * 60 * 1000), // 5 minutes
      createdAt: new Date()
    };

    this.activeChallenges.set(challengeId, challenge);
    return challenge;
  }

  /**
   * Verify Proof-of-Work response
   */
  verifyPoWResponse(response: ChallengeResponse): boolean {
    const challenge = this.activeChallenges.get(response.challengeId);
    if (!challenge || challenge.type !== 'pow') {
      return false;
    }

    // Check deadline
    if (new Date() > challenge.deadline) {
      return false;
    }

    // Verify proof: hash(data + proof) starts with 'difficulty' zeros
    const hash = createHash('sha256')
      .update(challenge.data + response.proof)
      .digest('hex');

    const requiredPrefix = '0'.repeat(challenge.difficulty);
    const isValid = hash.startsWith(requiredPrefix);

    if (isValid) {
      this.completedChallenges.set(response.challengeId, response);
      this.activeChallenges.delete(response.challengeId);
    }

    return isValid;
  }

  /**
   * Generate Proof-of-Storage challenge
   */
  generatePoStChallenge(nodeId: string, dataSize: number): Challenge {
    const challengeId = this.generateChallengeId();
    const data = randomBytes(dataSize).toString('hex');

    const challenge: Challenge = {
      challengeId,
      nodeId,
      type: 'post',
      difficulty: dataSize,
      data,
      deadline: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      createdAt: new Date()
    };

    this.activeChallenges.set(challengeId, challenge);
    return challenge;
  }

  /**
   * Verify Proof-of-Storage response
   */
  verifyPoStResponse(response: ChallengeResponse): boolean {
    const challenge = this.activeChallenges.get(response.challengeId);
    if (!challenge || challenge.type !== 'post') {
      return false;
    }

    // Verify that the node can reproduce random chunks of the data
    const isValid = response.proof === challenge.data;

    if (isValid) {
      this.completedChallenges.set(response.challengeId, response);
      this.activeChallenges.delete(response.challengeId);
    }

    return isValid;
  }

  private generateChallengeId(): string {
    return randomBytes(16).toString('hex');
  }

  getActiveChallenge(nodeId: string): Challenge | undefined {
    const challenges = Array.from(this.activeChallenges.values());
    for (const challenge of challenges) {
      if (challenge.nodeId === nodeId) {
        return challenge;
      }
    }
    return undefined;
  }
}

// ============================================================================
// ECONOMIC PENALTIES
// ============================================================================

export interface Penalty {
  nodeId: string;
  type: 'fee' | 'slash' | 'ban';
  amount: string; // WRF tokens
  reason: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  appliedAt: Date;
  expiresAt?: Date;
}

export class EconomicPenaltySystem {
  private penalties = new Map<string, Penalty[]>();
  private blacklist = new Map<string, Date>(); // nodeId -> ban expiry

  private readonly REGISTRATION_FEE = '10000000000000000000'; // 10 WRF
  private readonly MIN_BALANCE = '100000000000000000000'; // 100 WRF

  /**
   * Charge registration fee
   */
  async chargeRegistrationFee(nodeId: string, walletAddress: string): Promise<boolean> {
    // In production, would execute on-chain transaction
    securityLogger.info('Charging registration fee', { module: 'EconomicPenaltySystem', nodeId, amount: this.REGISTRATION_FEE });
    return true;
  }

  /**
   * Apply penalty for malicious behavior
   */
  applyPenalty(nodeId: string, reason: string, severity: 'low' | 'medium' | 'high' | 'critical'): Penalty {
    const amounts = {
      low: '1000000000000000000', // 1 WRF
      medium: '10000000000000000000', // 10 WRF
      high: '100000000000000000000', // 100 WRF
      critical: '1000000000000000000000' // 1000 WRF
    };

    const penalty: Penalty = {
      nodeId,
      type: severity === 'critical' ? 'ban' : 'fee',
      amount: amounts[severity],
      reason,
      severity,
      appliedAt: new Date()
    };

    if (severity === 'critical') {
      penalty.expiresAt = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000); // 90 days
      this.blacklist.set(nodeId, penalty.expiresAt);
    }

    const history = this.penalties.get(nodeId) || [];
    history.push(penalty);
    this.penalties.set(nodeId, history);

    return penalty;
  }

  /**
   * Check if node is banned
   */
  isBanned(nodeId: string): boolean {
    const banExpiry = this.blacklist.get(nodeId);
    if (!banExpiry) return false;

    if (new Date() > banExpiry) {
      this.blacklist.delete(nodeId);
      return false;
    }

    return true;
  }

  /**
   * Get penalty history
   */
  getPenaltyHistory(nodeId: string): Penalty[] {
    return this.penalties.get(nodeId) || [];
  }

  /**
   * Calculate total penalties
   */
  getTotalPenalties(nodeId: string): string {
    const history = this.penalties.get(nodeId) || [];
    return history.reduce((sum, p) => {
      return (BigInt(sum) + BigInt(p.amount)).toString();
    }, '0');
  }
}

// ============================================================================
// GRADUAL TRUST BUILDING
// ============================================================================

export interface TrustTier {
  tier: 'probationary' | 'limited' | 'standard' | 'full';
  ageInDays: number;
  restrictions: string[];
  nextTier?: {
    tier: string;
    requirements: string[];
    daysRemaining: number;
  };
}

export class GradualTrustSystem {
  private nodeTiers = new Map<string, TrustTier>();
  private registrationDates = new Map<string, Date>();

  /**
   * Register new node with probationary status
   */
  registerNewNode(nodeId: string): TrustTier {
    const tier: TrustTier = {
      tier: 'probationary',
      ageInDays: 0,
      restrictions: [
        'No voting rights',
        'Local message propagation only',
        'Reduced bandwidth allocation',
        'Enhanced monitoring'
      ]
    };

    this.nodeTiers.set(nodeId, tier);
    this.registrationDates.set(nodeId, new Date());

    return tier;
  }

  /**
   * Update trust tier based on node age and behavior
   */
  updateTrustTier(nodeId: string, reputationScore: number): TrustTier {
    const regDate = this.registrationDates.get(nodeId);
    if (!regDate) {
      return this.registerNewNode(nodeId);
    }

    const ageInDays = (Date.now() - regDate.getTime()) / (24 * 60 * 60 * 1000);
    let tier: TrustTier['tier'] = 'probationary';
    let restrictions: string[] = [];

    if (ageInDays >= 90 && reputationScore >= 80) {
      tier = 'full';
      restrictions = [];
    } else if (ageInDays >= 30 && reputationScore >= 60) {
      tier = 'standard';
      restrictions = ['Reduced voting weight'];
    } else if (ageInDays >= 7 && reputationScore >= 40) {
      tier = 'limited';
      restrictions = [
        'No voting rights',
        'Regional message propagation only',
        'Standard bandwidth allocation'
      ];
    } else {
      tier = 'probationary';
      restrictions = [
        'No voting rights',
        'Local message propagation only',
        'Reduced bandwidth allocation',
        'Enhanced monitoring'
      ];
    }

    const trustTier: TrustTier = {
      tier,
      ageInDays,
      restrictions
    };

    this.nodeTiers.set(nodeId, trustTier);
    return trustTier;
  }

  getTrustTier(nodeId: string): TrustTier | undefined {
    return this.nodeTiers.get(nodeId);
  }
}

// ============================================================================
// TOPOLOGY ANALYSIS
// ============================================================================

export interface NetworkTopology {
  nodes: Map<string, NetworkNode>;
  edges: Map<string, Set<string>>; // nodeId -> connected nodeIds
  clusters: NodeCluster[];
  anomalies: TopologyAnomaly[];
}

export interface NetworkNode {
  nodeId: string;
  connections: string[];
  betweenness: number;
  clustering: number;
  geographic: {lat: number; lng: number};
}

export interface NodeCluster {
  clusterId: string;
  nodes: string[];
  density: number;
  isSuspicious: boolean;
  suspicionReasons: string[];
}

export interface TopologyAnomaly {
  type: 'cluster' | 'centralization' | 'geographic' | 'behavior';
  severity: 'low' | 'medium' | 'high';
  affectedNodes: string[];
  description: string;
  detectedAt: Date;
}

export class TopologyAnalyzer {
  private topology: NetworkTopology = {
    nodes: new Map(),
    edges: new Map(),
    clusters: [],
    anomalies: []
  };

  /**
   * Add node to topology
   */
  addNode(node: NetworkNode): void {
    this.topology.nodes.set(node.nodeId, node);
    this.topology.edges.set(node.nodeId, new Set());
  }

  /**
   * Add connection between nodes
   */
  addConnection(from: string, to: string): void {
    if (!this.topology.edges.has(from)) {
      this.topology.edges.set(from, new Set());
    }
    this.topology.edges.get(from)!.add(to);

    // Update node connections
    const node = this.topology.nodes.get(from);
    if (node) {
      node.connections.push(to);
    }
  }

  /**
   * Detect suspicious clusters
   */
  detectClusters(): NodeCluster[] {
    const clusters: NodeCluster[] = [];
    const visited = new Set<string>();

    const nodeEntries = Array.from(this.topology.nodes.keys());
    for (const nodeId of nodeEntries) {
      if (visited.has(nodeId)) continue;

      const cluster = this.findConnectedCluster(nodeId, visited);
      if (cluster.nodes.length >= 3) {
        clusters.push(cluster);
      }
    }

    this.topology.clusters = clusters;
    return clusters;
  }

  /**
   * Analyze network for anomalies
   */
  analyzeAnomalies(): TopologyAnomaly[] {
    const anomalies: TopologyAnomaly[] = [];

    // Detect suspicious clusters
    const clusters = this.detectClusters();
    for (const cluster of clusters) {
      if (cluster.isSuspicious) {
        anomalies.push({
          type: 'cluster',
          severity: 'high',
          affectedNodes: cluster.nodes,
          description: `Suspicious cluster detected: ${cluster.suspicionReasons.join(', ')}`,
          detectedAt: new Date()
        });
      }
    }

    // Detect centralization
    const centralNodes = this.findCentralNodes();
    if (centralNodes.length > 0) {
      anomalies.push({
        type: 'centralization',
        severity: 'medium',
        affectedNodes: centralNodes,
        description: 'Network centralization detected around key nodes',
        detectedAt: new Date()
      });
    }

    this.topology.anomalies = anomalies;
    return anomalies;
  }

  /**
   * Calculate betweenness centrality
   */
  calculateBetweenness(nodeId: string): number {
    // Simplified betweenness calculation
    const connections = this.topology.edges.get(nodeId)?.size || 0;
    const totalNodes = this.topology.nodes.size;
    return totalNodes > 0 ? connections / totalNodes : 0;
  }

  private findConnectedCluster(startNode: string, visited: Set<string>): NodeCluster {
    const clusterNodes: string[] = [];
    const queue = [startNode];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;

      visited.add(current);
      clusterNodes.push(current);

      const connections = this.topology.edges.get(current) || new Set();
      const connectionList = Array.from(connections);
      for (const neighbor of connectionList) {
        if (!visited.has(neighbor)) {
          queue.push(neighbor);
        }
      }
    }

    const cluster: NodeCluster = {
      clusterId: createHash('sha256').update(clusterNodes.join(',')).digest('hex').substring(0, 8),
      nodes: clusterNodes,
      density: this.calculateClusterDensity(clusterNodes),
      isSuspicious: false,
      suspicionReasons: []
    };

    // Check for suspicious patterns
    if (cluster.density > 0.8) {
      cluster.isSuspicious = true;
      cluster.suspicionReasons.push('High cluster density (>80%)');
    }

    if (cluster.nodes.length > this.topology.nodes.size * 0.3) {
      cluster.isSuspicious = true;
      cluster.suspicionReasons.push('Cluster contains >30% of network nodes');
    }

    return cluster;
  }

  private calculateClusterDensity(nodes: string[]): number {
    if (nodes.length < 2) return 0;

    let actualEdges = 0;
    const maxPossibleEdges = (nodes.length * (nodes.length - 1)) / 2;

    for (const node of nodes) {
      const connections = this.topology.edges.get(node) || new Set();
      const neighborList = Array.from(connections);
      for (const neighbor of neighborList) {
        if (nodes.includes(neighbor)) {
          actualEdges++;
        }
      }
    }

    return actualEdges / maxPossibleEdges;
  }

  private findCentralNodes(): string[] {
    const centralNodes: string[] = [];
    const avgConnections = Array.from(this.topology.edges.values())
      .reduce((sum, edges) => sum + edges.size, 0) / this.topology.nodes.size;

    const edgeEntries = Array.from(this.topology.edges.entries());
    for (const [nodeId, edges] of edgeEntries) {
      if (edges.size > avgConnections * 3) {
        centralNodes.push(nodeId);
      }
    }

    return centralNodes;
  }
}

// ============================================================================
// MAIN SECURITY ORCHESTRATOR
// ============================================================================

export interface SecurityCheck {
  passed: boolean;
  checks: {
    stake: boolean;
    certificate: boolean;
    rateLimit: boolean;
    reputation: boolean;
    challenge: boolean;
    notBanned: boolean;
    didVerified: boolean; // SECURITY ENHANCEMENT (Task 92.7): Optional DID verification
  };
  didVerification?: DIDVerificationResult; // Details of DID verification if provided
  failures: string[];
  warnings: string[];
}

export class SybilSecurityOrchestrator {
  private didVerifier: DIDVerifier;

  constructor(
    private posManager: ProofOfStakeManager,
    private pkiManager: PKICertificateManager,
    private rateLimiter: SybilRateLimiter,
    private reputationSystem: ReputationSystem,
    private challengeProtocol: ChallengeResponseProtocol,
    private penaltySystem: EconomicPenaltySystem,
    private trustSystem: GradualTrustSystem,
    private topologyAnalyzer: TopologyAnalyzer,
    didVerifier?: DIDVerifier // SECURITY ENHANCEMENT (Task 92.7): Optional DID verifier
  ) {
    // Initialize DID verifier (optional - defaults to not required)
    this.didVerifier = didVerifier || new DIDVerifier({
      requiredForRegistration: false, // Optional for gradual adoption
      maxNodesPerDID: 3,
      minVerificationLevel: 'basic',
      uniquenessScoreThreshold: 50,
    });
  }

  /**
   * Comprehensive security check for node registration
   * SECURITY ENHANCEMENT (Task 92.7): Added optional DID verification for proof-of-unique-human
   */
  async performSecurityCheck(
    nodeId: string,
    ipAddress: string,
    stakeProof: StakeProof,
    certificate: string,
    did?: string, // Optional DID for proof-of-unique-human
    didSignature?: string // Optional signature proving DID ownership
  ): Promise<SecurityCheck> {
    const checks = {
      stake: false,
      certificate: false,
      rateLimit: false,
      reputation: false,
      challenge: false,
      notBanned: false,
      didVerified: false // Will be set to true if DID verification passes (or not required)
    };
    const failures: string[] = [];
    const warnings: string[] = [];
    let didVerification: DIDVerificationResult | undefined;

    // 0. Verify DID if provided (SECURITY ENHANCEMENT - Task 92.7)
    // This is checked first to prevent Sybil attackers from wasting resources
    didVerification = await this.didVerifier.verifyDID(nodeId, nodeId, didSignature);
    if (did) {
      // DID was provided - verify it
      didVerification = await this.didVerifier.verifyDID(did, nodeId, didSignature);
      checks.didVerified = didVerification.isValid;
      if (!didVerification.isValid) {
        failures.push(...didVerification.errors);
      }
      if (didVerification.warnings.length > 0) {
        warnings.push(...didVerification.warnings);
      }
    } else {
      // No DID provided - check if required
      if (this.didVerifier.isDIDRequired()) {
        checks.didVerified = false;
        failures.push('DID verification is required for node registration');
      } else {
        // DID not required, pass check but add warning about limited privileges
        checks.didVerified = true;
        didVerification = {
          isValid: true,
          verificationLevel: 'none',
          uniquenessScore: 20,
          errors: [],
          warnings: ['Node registered without DID - some features may be restricted'],
        };
        warnings.push('Node registered without DID verification - limited network privileges');
      }
    }

    // 1. Check if banned
    checks.notBanned = !this.penaltySystem.isBanned(nodeId);
    if (!checks.notBanned) {
      failures.push('Node is currently banned');
    }

    // 2. Verify stake
    const stakeVerification = await this.posManager.verifyStakeProof(stakeProof);
    checks.stake = stakeVerification.isValid;
    if (!checks.stake) {
      failures.push(...stakeVerification.errors);
    }

    // 3. Verify certificate
    const certVerification = await this.pkiManager.verifyCertificate(nodeId, certificate);
    checks.certificate = certVerification.isValid;
    if (!checks.certificate) {
      failures.push(...certVerification.errors);
    }

    // 4. Check rate limits
    const rateLimitCheck = await this.rateLimiter.checkRateLimit(nodeId, ipAddress);
    checks.rateLimit = rateLimitCheck.allowed;
    if (!checks.rateLimit) {
      failures.push('Rate limit violations: ' + rateLimitCheck.violations.map(v => v.type).join(', '));
    }

    // 5. Check reputation (for existing nodes)
    const reputation = this.reputationSystem.getReputation(nodeId);
    if (reputation) {
      checks.reputation = reputation.totalScore >= 40;
      if (!checks.reputation) {
        failures.push('Reputation score too low');
      }
    } else {
      checks.reputation = true; // New nodes pass by default
    }

    // 6. Challenge-response (random selection) - Enhanced: 50% probability
    // SECURITY ENHANCEMENT (Task 92.7): Increased from 30% to 50% to strengthen Sybil prevention
    const CHALLENGE_PROBABILITY = 0.5; // 50% chance of challenge
    if (Math.random() < CHALLENGE_PROBABILITY) {
      const challenge = this.challengeProtocol.generatePoWChallenge(nodeId);
      warnings.push('Challenge issued - response required within 5 minutes');
      checks.challenge = false; // Will be updated when response is verified
    } else {
      checks.challenge = true;
    }

    return {
      passed: Object.values(checks).every(v => v),
      checks,
      didVerification, // Include DID verification details
      failures,
      warnings
    };
  }

  /**
   * Get DID verifier for external access (e.g., for challenge generation)
   * SECURITY ENHANCEMENT (Task 92.7)
   */
  getDIDVerifier(): DIDVerifier {
    return this.didVerifier;
  }

  /**
   * Initialize new node with all security systems
   */
  async initializeNode(
    nodeId: string,
    ipAddress: string
  ): Promise<{
    reputation: ReputationScore;
    trustTier: TrustTier;
    topologyNode: NetworkNode;
  }> {
    // Initialize reputation
    const reputation = this.reputationSystem.initializeReputation(nodeId);

    // Initialize trust tier
    const trustTier = this.trustSystem.registerNewNode(nodeId);

    // Add to topology
    const topologyNode: NetworkNode = {
      nodeId,
      connections: [],
      betweenness: 0,
      clustering: 0,
      geographic: {lat: 0, lng: 0}
    };
    this.topologyAnalyzer.addNode(topologyNode);

    return {
      reputation,
      trustTier,
      topologyNode
    };
  }

  /**
   * Monitor and update node security status
   */
  async monitorNode(nodeId: string): Promise<void> {
    // Update reputation
    const reputation = this.reputationSystem.getReputation(nodeId);
    if (reputation) {
      this.reputationSystem.updateReputation(nodeId, reputation.metrics);
    }

    // Update trust tier
    const reputationScore = reputation?.totalScore || 0;
    this.trustSystem.updateTrustTier(nodeId, reputationScore);

    // Analyze topology
    this.topologyAnalyzer.analyzeAnomalies();
  }
}
