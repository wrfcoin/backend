/**
 * Eclipse Security Orchestrator
 *
 * SECURITY ENHANCEMENT (Task 92.10-92.12)
 *
 * Unified orchestration layer that integrates all eclipse attack protection mechanisms:
 * - Diverse peer selection with geographic/ASN/subnet requirements
 * - Network topology monitoring and anomaly detection
 * - Connection diversity enforcement
 * - Multi-path heartbeat verification
 * - Partition detection and recovery
 * - Outbound connection diversity requirements
 * - Peer rotation mechanisms
 *
 * Eclipse attacks isolate a node by controlling all its peer connections,
 * effectively "eclipsing" the node from the honest network.
 */

import { EventEmitter } from 'events';
import { DiversePeerSelectionManager, PeerInfo, DiversityScore, GeographicRegion, ReputationTier } from './eclipse-peer-selection.js';
import { NetworkTopologyMonitor, TopologyMetrics, TopologyAnomaly, AnomalyType } from './eclipse-topology-monitor.js';
import { ConnectionDiversityManager, DiversityViolation, ViolationType } from './eclipse-connection-diversity.js';
import { HeartbeatManager, HeartbeatStatus } from './eclipse-heartbeat-manager.js';
import { PartitionRecoveryManager, PartitionDetectionResult, RecoveryResult } from './eclipse-partition-recovery.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface EclipseSecurityConfig {
  // Peer selection thresholds
  minimumPeerCount: number;           // Minimum 20 diverse peers
  minimumContinents: number;          // Minimum 3 continents
  minimumASNs: number;                // Minimum 5 different ASNs
  maxSubnetConcentration: number;     // Max 20% from single /16

  // Outbound connection requirements
  minOutboundConnections: number;     // Minimum outbound connections
  minOutboundDiversity: number;       // Minimum diversity score for outbound
  outboundRotationInterval: number;   // Rotation interval in ms

  // Heartbeat thresholds
  heartbeatInterval: number;          // Heartbeat every 10s
  heartbeatTimeout: number;           // Timeout after 30s
  maxMissedHeartbeats: number;        // Max 3 missed heartbeats

  // Anomaly detection thresholds
  suddenDisconnectThreshold: number;  // Number of sudden disconnects to alert
  partitionConfidenceThreshold: number; // Confidence threshold for partition

  // Recovery settings
  bootstrapNodes: string[];           // Bootstrap nodes for recovery
  recoveryTimeout: number;            // Recovery timeout in ms

  // Monitoring intervals
  quickScanInterval: number;          // Quick scan every 30s
  fullAnalysisInterval: number;       // Full analysis every 5min
  rebalanceInterval: number;          // Rebalance every 30min
}

export interface EclipseSecurityCheck {
  passed: boolean;
  timestamp: Date;
  checks: {
    peerDiversity: boolean;
    geographicSpread: boolean;
    asnSpread: boolean;
    subnetDistribution: boolean;
    outboundDiversity: boolean;
    topologyHealth: boolean;
    heartbeatHealth: boolean;
    noPartitions: boolean;
    noActiveAnomalies: boolean;
  };
  metrics: {
    totalPeers: number;
    continentCount: number;
    asnCount: number;
    diversityScore: number;
    outboundCount: number;
    activeAnomalies: number;
    missedHeartbeats: number;
    partitionConfidence: number;
  };
  failures: string[];
  warnings: string[];
  recommendations: string[];
}

export interface EclipseAttackIndicator {
  type: 'peer_concentration' | 'geographic_isolation' | 'asn_monopoly' |
        'rapid_peer_change' | 'heartbeat_anomaly' | 'consensus_divergence' |
        'topology_manipulation' | 'coordinated_disconnect';
  severity: 'low' | 'medium' | 'high' | 'critical';
  confidence: number;
  description: string;
  affectedPeers: string[];
  detectedAt: Date;
  mitigationSteps: string[];
}

export interface OutboundConnectionPolicy {
  nodeId: string;
  peer: PeerInfo;
  direction: 'outbound' | 'inbound';
  establishedAt: Date;
  lastActivity: Date;
  rotationEligible: boolean;
}

// ============================================================================
// Eclipse Security Orchestrator
// ============================================================================

export class EclipseSecurityOrchestrator extends EventEmitter {
  private config: EclipseSecurityConfig;
  private peerSelector: DiversePeerSelectionManager;
  private topologyMonitor: NetworkTopologyMonitor;
  private diversityManager: ConnectionDiversityManager;
  private heartbeatManager: HeartbeatManager;
  private partitionRecovery: PartitionRecoveryManager;

  private outboundConnections: Map<string, OutboundConnectionPolicy> = new Map();
  private inboundConnections: Map<string, OutboundConnectionPolicy> = new Map();
  private attackIndicators: EclipseAttackIndicator[] = [];

  private rotationTimer?: NodeJS.Timeout;
  private monitoringActive = false;

  constructor(config?: Partial<EclipseSecurityConfig>) {
    super();

    this.config = {
      minimumPeerCount: 20,
      minimumContinents: 3,
      minimumASNs: 5,
      maxSubnetConcentration: 0.20,
      minOutboundConnections: 8,
      minOutboundDiversity: 60,
      outboundRotationInterval: 1800000, // 30 minutes
      heartbeatInterval: 10000,
      heartbeatTimeout: 30000,
      maxMissedHeartbeats: 3,
      suddenDisconnectThreshold: 5,
      partitionConfidenceThreshold: 0.7,
      bootstrapNodes: [],
      recoveryTimeout: 120000,
      quickScanInterval: 30000,
      fullAnalysisInterval: 300000,
      rebalanceInterval: 1800000,
      ...config
    };

    // Initialize components
    this.peerSelector = new DiversePeerSelectionManager({
      minimumPeerCount: this.config.minimumPeerCount,
      geographicRegions: [
        GeographicRegion.NORTH_AMERICA,
        GeographicRegion.EUROPE,
        GeographicRegion.ASIA
      ],
      maxSubnetConcentration: this.config.maxSubnetConcentration,
      minimumDiversityScore: 70
    });

    this.topologyMonitor = new NetworkTopologyMonitor();
    this.diversityManager = new ConnectionDiversityManager({
      minimumConnections: this.config.minimumPeerCount,
      geographicSpread: this.config.minimumContinents,
      asnSpread: this.config.minimumASNs,
      maximumSingleSourcePercent: this.config.maxSubnetConcentration,
      diversityScoreThreshold: 70,
      rebalanceInterval: this.config.rebalanceInterval
    });

    this.heartbeatManager = new HeartbeatManager();
    this.partitionRecovery = new PartitionRecoveryManager(this.config.bootstrapNodes);

    // Setup event listeners
    this.setupEventListeners();
  }

  // ============================================================================
  // Initialization and Lifecycle
  // ============================================================================

  /**
   * Start eclipse protection monitoring
   */
  public start(): void {
    if (this.monitoringActive) return;

    this.monitoringActive = true;
    this.topologyMonitor.startMonitoring();

    // Start outbound rotation
    this.rotationTimer = setInterval(
      () => this.rotateOutboundConnections(),
      this.config.outboundRotationInterval
    );

    this.emit('started');
  }

  /**
   * Stop eclipse protection monitoring
   */
  public stop(): void {
    this.monitoringActive = false;
    this.topologyMonitor.stopMonitoring();
    this.diversityManager.stopRebalancing();

    if (this.rotationTimer) {
      clearInterval(this.rotationTimer);
      this.rotationTimer = undefined;
    }

    this.emit('stopped');
  }

  /**
   * Setup event listeners for all components
   */
  private setupEventListeners(): void {
    // Topology monitor events
    this.topologyMonitor.on('anomalyDetected', (anomaly: TopologyAnomaly) => {
      this.handleTopologyAnomaly(anomaly);
    });

    // Diversity manager events
    this.diversityManager.on('diversityViolation', (violation: DiversityViolation) => {
      this.handleDiversityViolation(violation);
    });

    this.diversityManager.on('needDiversePeers', (request: { count: number; reason: string }) => {
      this.handlePeerRequest(request);
    });

    // Heartbeat manager events
    this.heartbeatManager.on('isolationDetected', (peerId: string) => {
      this.handleIsolationDetected(peerId);
    });

    // Partition recovery events
    this.partitionRecovery.on('recoveryComplete', (result: RecoveryResult) => {
      this.emit('recoveryComplete', result);
    });
  }

  // ============================================================================
  // Peer Connection Management
  // ============================================================================

  /**
   * Add a new peer connection
   */
  public async addPeer(peer: PeerInfo, direction: 'outbound' | 'inbound'): Promise<{
    accepted: boolean;
    reason?: string;
  }> {
    // Step 1: Check diversity requirements
    const diversityResult = await this.diversityManager.addConnection(peer);

    if (!diversityResult.accepted) {
      return {
        accepted: false,
        reason: `Diversity violation: ${diversityResult.reason}`
      };
    }

    // Step 2: Check outbound requirements
    if (direction === 'outbound') {
      const outboundCheck = this.checkOutboundRequirements(peer);
      if (!outboundCheck.allowed) {
        return {
          accepted: false,
          reason: outboundCheck.reason
        };
      }
    }

    // Step 3: Add to appropriate connection map
    const policy: OutboundConnectionPolicy = {
      nodeId: peer.nodeId,
      peer,
      direction,
      establishedAt: new Date(),
      lastActivity: new Date(),
      rotationEligible: direction === 'outbound'
    };

    if (direction === 'outbound') {
      this.outboundConnections.set(peer.nodeId, policy);
    } else {
      this.inboundConnections.set(peer.nodeId, policy);
    }

    // Step 4: Add to peer selector and topology monitor
    this.peerSelector.addPeer(peer);
    this.topologyMonitor.addNode({
      nodeId: peer.nodeId,
      connections: new Set(),
      lastSeen: new Date(),
      isActive: true,
      geographicRegion: peer.continent,
      reputation: peer.reputationScore
    });

    // Step 5: Start heartbeat monitoring
    this.heartbeatManager.startHeartbeat(peer);

    this.emit('peerAdded', { peer, direction });
    return { accepted: true };
  }

  /**
   * Remove a peer connection
   */
  public removePeer(nodeId: string): void {
    const outbound = this.outboundConnections.get(nodeId);
    const inbound = this.inboundConnections.get(nodeId);

    this.outboundConnections.delete(nodeId);
    this.inboundConnections.delete(nodeId);

    this.peerSelector.removePeer(nodeId);
    this.topologyMonitor.removeNode(nodeId);
    this.diversityManager.removeConnection(nodeId);
    this.heartbeatManager.stopHeartbeat(nodeId);

    this.emit('peerRemoved', { nodeId, wasOutbound: !!outbound, wasInbound: !!inbound });

    // Check if this removal compromises security
    this.checkSecurityAfterRemoval(nodeId);
  }

  /**
   * Check outbound connection requirements
   */
  private checkOutboundRequirements(peer: PeerInfo): { allowed: boolean; reason?: string } {
    const outboundPeers = Array.from(this.outboundConnections.values()).map(p => p.peer);

    // Check geographic diversity in outbound
    const continents = new Set(outboundPeers.map(p => p.continent));
    continents.add(peer.continent);

    if (outboundPeers.length >= 3 && !continents.has(peer.continent) && continents.size < 2) {
      // If we already have 3+ outbound and adding this doesn't improve geographic diversity
      const sameContinent = outboundPeers.filter(p => p.continent === peer.continent).length;
      if (sameContinent >= this.config.minOutboundConnections / 2) {
        return {
          allowed: false,
          reason: `Too many outbound connections from ${peer.continent}`
        };
      }
    }

    // Check ASN diversity in outbound
    const asns = new Set(outboundPeers.map(p => p.autonomousSystem));
    const sameASN = outboundPeers.filter(p => p.autonomousSystem === peer.autonomousSystem).length;
    if (sameASN >= 2) {
      return {
        allowed: false,
        reason: `Too many outbound connections from ASN ${peer.autonomousSystem}`
      };
    }

    return { allowed: true };
  }

  // ============================================================================
  // Outbound Connection Management
  // ============================================================================

  /**
   * Rotate outbound connections for security
   * SECURITY: Prevents long-term eclipse attacks by regularly changing peers
   */
  public async rotateOutboundConnections(): Promise<void> {
    if (!this.monitoringActive) return;

    this.emit('rotationStart');

    const rotatable = Array.from(this.outboundConnections.values())
      .filter(p => p.rotationEligible)
      .filter(p => {
        const age = Date.now() - p.establishedAt.getTime();
        return age > this.config.outboundRotationInterval;
      });

    // Rotate 10% of eligible connections
    const rotateCount = Math.max(1, Math.floor(rotatable.length * 0.1));

    // Sort by contribution to diversity (keep most valuable)
    const scored = rotatable.map(p => ({
      policy: p,
      contribution: this.calculatePeerContribution(p.peer)
    })).sort((a, b) => a.contribution - b.contribution);

    // Remove lowest contribution peers
    const toRemove = scored.slice(0, rotateCount);

    for (const { policy } of toRemove) {
      this.removePeer(policy.nodeId);
    }

    this.emit('rotationComplete', {
      rotated: toRemove.length,
      reason: 'Scheduled rotation'
    });

    // Request new diverse peers
    this.emit('needDiversePeers', {
      count: toRemove.length,
      reason: 'Rotation replacement'
    });
  }

  /**
   * Calculate how much a peer contributes to diversity
   */
  private calculatePeerContribution(peer: PeerInfo): number {
    const allPeers = [
      ...Array.from(this.outboundConnections.values()).map(p => p.peer),
      ...Array.from(this.inboundConnections.values()).map(p => p.peer)
    ];

    let contribution = 0;

    // Geographic uniqueness
    const sameContinent = allPeers.filter(p => p.continent === peer.continent).length;
    contribution += 100 / sameContinent;

    // ASN uniqueness
    const sameASN = allPeers.filter(p => p.autonomousSystem === peer.autonomousSystem).length;
    contribution += 100 / sameASN;

    // Subnet uniqueness
    const sameSubnet = allPeers.filter(p => p.ipSubnet === peer.ipSubnet).length;
    contribution += 100 / sameSubnet;

    return contribution;
  }

  // ============================================================================
  // Security Check
  // ============================================================================

  /**
   * Perform comprehensive eclipse security check
   */
  public async performSecurityCheck(): Promise<EclipseSecurityCheck> {
    const failures: string[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];

    const allPeers = [
      ...Array.from(this.outboundConnections.values()).map(p => p.peer),
      ...Array.from(this.inboundConnections.values()).map(p => p.peer)
    ];

    // 1. Peer diversity check
    const diversityScore = this.diversityManager.getCurrentScore();
    const peerDiversityPassed = diversityScore.meetsMinimumRequirements;

    if (!peerDiversityPassed) {
      failures.push('Peer diversity below minimum requirements');
      diversityScore.violations.forEach(v => warnings.push(v));
    }

    // 2. Geographic spread check
    const continents = new Set(allPeers.map(p => p.continent));
    const geographicPassed = continents.size >= this.config.minimumContinents;

    if (!geographicPassed) {
      failures.push(`Insufficient geographic spread: ${continents.size}/${this.config.minimumContinents} continents`);
      recommendations.push('Add peers from additional continents');
    }

    // 3. ASN spread check
    const asns = new Set(allPeers.map(p => p.autonomousSystem));
    const asnPassed = asns.size >= this.config.minimumASNs;

    if (!asnPassed) {
      failures.push(`Insufficient ASN spread: ${asns.size}/${this.config.minimumASNs} ASNs`);
      recommendations.push('Add peers from different autonomous systems');
    }

    // 4. Subnet distribution check
    const subnetCounts = new Map<string, number>();
    allPeers.forEach(p => {
      subnetCounts.set(p.ipSubnet, (subnetCounts.get(p.ipSubnet) || 0) + 1);
    });

    const maxSubnet = Math.max(...Array.from(subnetCounts.values()), 0);
    const subnetConcentration = allPeers.length > 0 ? maxSubnet / allPeers.length : 0;
    const subnetPassed = subnetConcentration <= this.config.maxSubnetConcentration;

    if (!subnetPassed) {
      failures.push(`Excessive subnet concentration: ${(subnetConcentration * 100).toFixed(1)}%`);
      recommendations.push('Replace peers from concentrated subnets');
    }

    // 5. Outbound diversity check
    const outboundPeers = Array.from(this.outboundConnections.values()).map(p => p.peer);
    const outboundDiversity = this.diversityManager.calculateDiversityScore(outboundPeers);
    const outboundPassed = this.outboundConnections.size >= this.config.minOutboundConnections &&
                          outboundDiversity.overallScore >= this.config.minOutboundDiversity;

    if (!outboundPassed) {
      if (this.outboundConnections.size < this.config.minOutboundConnections) {
        failures.push(`Insufficient outbound connections: ${this.outboundConnections.size}/${this.config.minOutboundConnections}`);
      }
      if (outboundDiversity.overallScore < this.config.minOutboundDiversity) {
        warnings.push(`Low outbound diversity: ${outboundDiversity.overallScore.toFixed(1)}/${this.config.minOutboundDiversity}`);
      }
      recommendations.push('Establish more diverse outbound connections');
    }

    // 6. Topology health check
    const topologyMetrics = this.topologyMonitor.getMetrics();
    const topologyPassed = topologyMetrics !== null &&
                          topologyMetrics.connectedComponents <= 1 &&
                          topologyMetrics.isolatedNodes === 0;

    if (!topologyPassed) {
      if (topologyMetrics && topologyMetrics.connectedComponents !== undefined && topologyMetrics.connectedComponents > 1) {
        failures.push(`Network partition detected: ${topologyMetrics.connectedComponents} components`);
      }
      if (topologyMetrics && topologyMetrics.isolatedNodes !== undefined && topologyMetrics.isolatedNodes > 0) {
        warnings.push(`${topologyMetrics.isolatedNodes} isolated nodes detected`);
      }
    }

    // 7. Heartbeat health check
    let missedHeartbeats = 0;
    for (const peer of allPeers) {
      const status = this.heartbeatManager.getHeartbeatStatus(peer.nodeId);
      missedHeartbeats += status.missedHeartbeats;
    }
    const heartbeatPassed = missedHeartbeats < allPeers.length * 0.1; // Less than 10% missing

    if (!heartbeatPassed) {
      warnings.push(`High heartbeat miss rate: ${missedHeartbeats} missed`);
      recommendations.push('Check network connectivity to affected peers');
    }

    // 8. Partition check
    const partitionResult = await this.partitionRecovery.detectPartition(
      allPeers,
      this.config.minimumPeerCount
    );
    const noPartitionsPassed = !partitionResult.isPartitioned;

    if (!noPartitionsPassed) {
      failures.push(`Partition detected with ${(partitionResult.confidence * 100).toFixed(1)}% confidence`);
      partitionResult.indicators.forEach(i => warnings.push(i));
      recommendations.push('Initiate partition recovery');
    }

    // 9. Active anomalies check
    const recentAnomalies = this.topologyMonitor.getRecentAnomalies(5);
    const criticalAnomalies = recentAnomalies.filter(a =>
      a.severity === 'CRITICAL' || a.severity === 'HIGH'
    );
    const noAnomaliesPassed = criticalAnomalies.length === 0;

    if (!noAnomaliesPassed) {
      criticalAnomalies.forEach(a => {
        failures.push(`Active anomaly: ${a.type} - ${a.description}`);
      });
    }

    // Calculate overall pass
    const passed = peerDiversityPassed && geographicPassed && asnPassed &&
                   subnetPassed && outboundPassed && topologyPassed &&
                   noPartitionsPassed && noAnomaliesPassed;

    const result: EclipseSecurityCheck = {
      passed,
      timestamp: new Date(),
      checks: {
        peerDiversity: peerDiversityPassed,
        geographicSpread: geographicPassed,
        asnSpread: asnPassed,
        subnetDistribution: subnetPassed,
        outboundDiversity: outboundPassed,
        topologyHealth: topologyPassed,
        heartbeatHealth: heartbeatPassed,
        noPartitions: noPartitionsPassed,
        noActiveAnomalies: noAnomaliesPassed
      },
      metrics: {
        totalPeers: allPeers.length,
        continentCount: continents.size,
        asnCount: asns.size,
        diversityScore: diversityScore.overallScore,
        outboundCount: this.outboundConnections.size,
        activeAnomalies: criticalAnomalies.length,
        missedHeartbeats,
        partitionConfidence: partitionResult.confidence
      },
      failures,
      warnings,
      recommendations
    };

    this.emit('securityCheckComplete', result);
    return result;
  }

  // ============================================================================
  // Attack Detection
  // ============================================================================

  /**
   * Detect potential eclipse attack indicators
   */
  public async detectEclipseAttack(): Promise<EclipseAttackIndicator[]> {
    const indicators: EclipseAttackIndicator[] = [];

    const allPeers = [
      ...Array.from(this.outboundConnections.values()).map(p => p.peer),
      ...Array.from(this.inboundConnections.values()).map(p => p.peer)
    ];

    // 1. Peer concentration detection
    const peerConcentration = this.detectPeerConcentration(allPeers);
    if (peerConcentration) indicators.push(peerConcentration);

    // 2. Geographic isolation detection
    const geoIsolation = this.detectGeographicIsolation(allPeers);
    if (geoIsolation) indicators.push(geoIsolation);

    // 3. ASN monopoly detection
    const asnMonopoly = this.detectASNMonopoly(allPeers);
    if (asnMonopoly) indicators.push(asnMonopoly);

    // 4. Rapid peer change detection
    const rapidChange = this.detectRapidPeerChange();
    if (rapidChange) indicators.push(rapidChange);

    // 5. Heartbeat anomaly detection
    const heartbeatAnomaly = this.detectHeartbeatAnomaly(allPeers);
    if (heartbeatAnomaly) indicators.push(heartbeatAnomaly);

    // 6. Topology manipulation detection
    const topologyManipulation = this.detectTopologyManipulation();
    if (topologyManipulation) indicators.push(topologyManipulation);

    this.attackIndicators = indicators;

    if (indicators.length > 0) {
      this.emit('eclipseAttackDetected', indicators);
    }

    return indicators;
  }

  private detectPeerConcentration(peers: PeerInfo[]): EclipseAttackIndicator | null {
    const subnetCounts = new Map<string, PeerInfo[]>();
    peers.forEach(p => {
      const list = subnetCounts.get(p.ipSubnet) || [];
      list.push(p);
      subnetCounts.set(p.ipSubnet, list);
    });

    for (const [subnet, peerList] of Array.from(subnetCounts.entries())) {
      const concentration = peerList.length / peers.length;
      if (concentration > 0.30) {
        return {
          type: 'peer_concentration',
          severity: concentration > 0.50 ? 'critical' : 'high',
          confidence: concentration,
          description: `${(concentration * 100).toFixed(1)}% of peers from subnet ${subnet}`,
          affectedPeers: peerList.map(p => p.nodeId),
          detectedAt: new Date(),
          mitigationSteps: [
            'Disconnect from concentrated subnet peers',
            'Request diverse peers from different subnets',
            'Enable enhanced peer selection'
          ]
        };
      }
    }

    return null;
  }

  private detectGeographicIsolation(peers: PeerInfo[]): EclipseAttackIndicator | null {
    const continents = new Set(peers.map(p => p.continent));

    if (peers.length >= 10 && continents.size === 1) {
      return {
        type: 'geographic_isolation',
        severity: 'high',
        confidence: 0.9,
        description: `All ${peers.length} peers from single continent: ${Array.from(continents)[0]}`,
        affectedPeers: peers.map(p => p.nodeId),
        detectedAt: new Date(),
        mitigationSteps: [
          'Connect to bootstrap nodes in different continents',
          'Request geographically diverse peers',
          'Enable geographic diversity enforcement'
        ]
      };
    }

    return null;
  }

  private detectASNMonopoly(peers: PeerInfo[]): EclipseAttackIndicator | null {
    const asnCounts = new Map<string, PeerInfo[]>();
    peers.forEach(p => {
      const list = asnCounts.get(p.autonomousSystem) || [];
      list.push(p);
      asnCounts.set(p.autonomousSystem, list);
    });

    for (const [asn, peerList] of Array.from(asnCounts.entries())) {
      const monopoly = peerList.length / peers.length;
      if (monopoly > 0.40) {
        return {
          type: 'asn_monopoly',
          severity: monopoly > 0.60 ? 'critical' : 'high',
          confidence: monopoly,
          description: `${(monopoly * 100).toFixed(1)}% of peers from ASN ${asn}`,
          affectedPeers: peerList.map(p => p.nodeId),
          detectedAt: new Date(),
          mitigationSteps: [
            'Disconnect excess peers from this ASN',
            'Request peers from different autonomous systems',
            'Verify ASN is legitimate network operator'
          ]
        };
      }
    }

    return null;
  }

  private detectRapidPeerChange(): EclipseAttackIndicator | null {
    // This would track peer connection/disconnection rates over time
    // For now, return null as implementation would require history tracking
    return null;
  }

  private detectHeartbeatAnomaly(peers: PeerInfo[]): EclipseAttackIndicator | null {
    const isolatedPeers = peers.filter(peer => {
      const status = this.heartbeatManager.getHeartbeatStatus(peer.nodeId);
      return status.isIsolated;
    });

    if (isolatedPeers.length > peers.length * 0.3) {
      return {
        type: 'heartbeat_anomaly',
        severity: 'critical',
        confidence: isolatedPeers.length / peers.length,
        description: `${isolatedPeers.length} of ${peers.length} peers show heartbeat isolation`,
        affectedPeers: isolatedPeers.map(p => p.nodeId),
        detectedAt: new Date(),
        mitigationSteps: [
          'Check local network connectivity',
          'Verify peer reachability',
          'Initiate partition recovery if needed'
        ]
      };
    }

    return null;
  }

  private detectTopologyManipulation(): EclipseAttackIndicator | null {
    const recentAnomalies = this.topologyMonitor.getRecentAnomalies(5);
    const manipulationAnomalies = recentAnomalies.filter(a =>
      a.type === AnomalyType.CLUSTERING_ATTACK ||
      a.type === AnomalyType.COORDINATED_DISCONNECT
    );

    if (manipulationAnomalies.length > 0) {
      return {
        type: 'topology_manipulation',
        severity: 'critical',
        confidence: 0.85,
        description: `${manipulationAnomalies.length} topology manipulation patterns detected`,
        affectedPeers: manipulationAnomalies.flatMap(a => a.affectedNodes),
        detectedAt: new Date(),
        mitigationSteps: [
          'Analyze network topology changes',
          'Disconnect suspicious peers',
          'Connect to trusted bootstrap nodes',
          'Enable enhanced topology monitoring'
        ]
      };
    }

    return null;
  }

  // ============================================================================
  // Event Handlers
  // ============================================================================

  private handleTopologyAnomaly(anomaly: TopologyAnomaly): void {
    this.emit('topologyAnomaly', anomaly);

    if (anomaly.severity === 'CRITICAL') {
      // Trigger immediate security check
      this.performSecurityCheck();
    }

    if (anomaly.type === AnomalyType.PARTITION_DETECTED) {
      this.initiateRecovery();
    }
  }

  private handleDiversityViolation(violation: DiversityViolation): void {
    this.emit('diversityViolation', violation);

    // Log attack indicator
    const indicator: EclipseAttackIndicator = {
      type: 'peer_concentration',
      severity: violation.severity === 'CRITICAL' ? 'critical' : 'medium',
      confidence: 0.7,
      description: violation.description,
      affectedPeers: [],
      detectedAt: violation.timestamp,
      mitigationSteps: ['Request diverse peers', 'Remove concentrated peers']
    };

    this.attackIndicators.push(indicator);
  }

  private handlePeerRequest(request: { count: number; reason: string }): void {
    this.emit('needPeers', request);
  }

  private handleIsolationDetected(peerId: string): void {
    this.emit('peerIsolated', peerId);

    // Check if we're becoming isolated
    const networkIsolation = this.heartbeatManager.detectNetworkIsolation(
      Array.from(this.outboundConnections.values()).map(p => p.peer)
    );

    if (networkIsolation) {
      this.initiateRecovery();
    }
  }

  private checkSecurityAfterRemoval(removedNodeId: string): void {
    // Quick security check after peer removal
    const allPeers = [
      ...Array.from(this.outboundConnections.values()).map(p => p.peer),
      ...Array.from(this.inboundConnections.values()).map(p => p.peer)
    ];

    if (allPeers.length < this.config.minimumPeerCount) {
      this.emit('needPeers', {
        count: this.config.minimumPeerCount - allPeers.length,
        reason: 'Below minimum peer count after removal'
      });
    }

    const continents = new Set(allPeers.map(p => p.continent));
    if (continents.size < this.config.minimumContinents) {
      this.emit('needPeers', {
        count: 2,
        reason: 'Geographic diversity compromised'
      });
    }
  }

  // ============================================================================
  // Recovery
  // ============================================================================

  /**
   * Initiate partition recovery
   */
  public async initiateRecovery(): Promise<RecoveryResult> {
    this.emit('recoveryStart');

    const allPeers = [
      ...Array.from(this.outboundConnections.values()).map(p => p.peer),
      ...Array.from(this.inboundConnections.values()).map(p => p.peer)
    ];

    const partition = await this.partitionRecovery.detectPartition(
      allPeers,
      this.config.minimumPeerCount
    );

    if (!partition.isPartitioned) {
      return {
        success: true,
        recoveredPeers: 0,
        newConsensusState: null,
        duration: 0
      };
    }

    return await this.partitionRecovery.recover(partition, allPeers);
  }

  // ============================================================================
  // Query Methods
  // ============================================================================

  public getConfig(): EclipseSecurityConfig {
    return { ...this.config };
  }

  public getAttackIndicators(): EclipseAttackIndicator[] {
    return [...this.attackIndicators];
  }

  public getOutboundConnections(): OutboundConnectionPolicy[] {
    return Array.from(this.outboundConnections.values());
  }

  public getInboundConnections(): OutboundConnectionPolicy[] {
    return Array.from(this.inboundConnections.values());
  }

  public getPeerSelector(): DiversePeerSelectionManager {
    return this.peerSelector;
  }

  public getTopologyMonitor(): NetworkTopologyMonitor {
    return this.topologyMonitor;
  }

  public getDiversityManager(): ConnectionDiversityManager {
    return this.diversityManager;
  }

  public getHeartbeatManager(): HeartbeatManager {
    return this.heartbeatManager;
  }

  public getPartitionRecovery(): PartitionRecoveryManager {
    return this.partitionRecovery;
  }
}

export default EclipseSecurityOrchestrator;
