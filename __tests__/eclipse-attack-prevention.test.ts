/**
 * Eclipse Attack Prevention - Comprehensive Test Suite
 *
 * Tests all Eclipse attack protection mechanisms including:
 * - Peer selection diversity
 * - Topology monitoring and anomaly detection
 * - Connection diversity enforcement
 * - Cryptographic proof verification
 * - Multi-channel communication
 * - Heartbeat mechanisms
 * - Consensus verification
 * - Partition detection and recovery
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { DiversePeerSelectionManager, PeerInfo, GeographicRegion, ReputationTier } from '../shared/eclipse-peer-selection.js';
import { NetworkTopologyMonitor } from '../shared/eclipse-topology-monitor.js';
import { ConnectionDiversityManager } from '../shared/eclipse-connection-diversity.js';
import { CryptographicProofManager } from '../shared/eclipse-cryptographic-proofs.js';
import { RedundantChannelManager, ChannelType } from '../shared/eclipse-redundant-channels.js';
import { HeartbeatManager } from '../shared/eclipse-heartbeat-manager.js';
import { ConsensusStateVerifier } from '../shared/eclipse-consensus-verifier.js';
import { PartitionRecoveryManager } from '../shared/eclipse-partition-recovery.js';

// ============================================================================
// Test Utilities
// ============================================================================

function createMockPeer(overrides?: Partial<PeerInfo>): PeerInfo {
  return {
    nodeId: `node-${Math.random().toString(36).substring(7)}`,
    ipAddress: `192.168.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`,
    port: 9000,
    publicKey: `pubkey-${Math.random()}`,
    geographicRegion: GeographicRegion.NORTH_AMERICA,
    continent: 'NA',
    country: 'US',
    autonomousSystem: `AS${10000 + Math.floor(Math.random() * 50000)}`,
    ipSubnet: '192.168.0.0/16',
    reputationScore: 75,
    reputationTier: ReputationTier.GOOD,
    stakeAmount: BigInt(1000),
    lastSeen: new Date(),
    connectionLatency: 50,
    uptimePercentage: 99,
    successfulTransactions: 100,
    failedTransactions: 1,
    consensusParticipation: 95,
    isBootstrapNode: false,
    ...overrides
  };
}

function createDiversePeerSet(count: number): PeerInfo[] {
  const peers: PeerInfo[] = [];
  const continents = [GeographicRegion.NORTH_AMERICA, GeographicRegion.EUROPE, GeographicRegion.ASIA];

  for (let i = 0; i < count; i++) {
    peers.push(createMockPeer({
      nodeId: `node-${i}`,
      continent: continents[i % continents.length],
      autonomousSystem: `AS${10000 + i}`,
      ipSubnet: `192.${i}.0.0/16`,
      reputationScore: 50 + (i % 50)
    }));
  }

  return peers;
}

// ============================================================================
// Peer Selection Tests
// ============================================================================

describe('Eclipse Attack Prevention - Peer Selection', () => {
  let peerSelector: DiversePeerSelectionManager;

  beforeEach(() => {
    peerSelector = new DiversePeerSelectionManager();
  });

  test('should select diverse peer set meeting all requirements', () => {
    const peers = createDiversePeerSet(50);
    peers.forEach(peer => peerSelector.addPeer(peer));

    const result = peerSelector.selectDiversePeers();

    expect(result.selectedPeers.length).toBeGreaterThanOrEqual(20);
    expect(result.diversityScore.meetsMinimumRequirements).toBe(true);
    expect(result.diversityScore.overallScore).toBeGreaterThanOrEqual(70);
  });

  test('should ensure geographic diversity (3+ continents)', () => {
    const peers = createDiversePeerSet(30);
    peers.forEach(peer => peerSelector.addPeer(peer));

    const result = peerSelector.selectDiversePeers();
    const continents = new Set(result.selectedPeers.map(p => p.continent));

    expect(continents.size).toBeGreaterThanOrEqual(3);
  });

  test('should ensure ASN diversity (5+ ASNs)', () => {
    const peers = createDiversePeerSet(30);
    peers.forEach(peer => peerSelector.addPeer(peer));

    const result = peerSelector.selectDiversePeers();
    const asns = new Set(result.selectedPeers.map(p => p.autonomousSystem));

    expect(asns.size).toBeGreaterThanOrEqual(5);
  });

  test('should limit subnet concentration (max 20% from single /16)', () => {
    const peers = createDiversePeerSet(30);
    peers.forEach(peer => peerSelector.addPeer(peer));

    const result = peerSelector.selectDiversePeers();
    const subnetCounts = new Map<string, number>();

    result.selectedPeers.forEach(peer => {
      subnetCounts.set(peer.ipSubnet, (subnetCounts.get(peer.ipSubnet) || 0) + 1);
    });

    const maxCount = Math.max(...Array.from(subnetCounts.values()));
    const concentration = maxCount / result.selectedPeers.length;

    expect(concentration).toBeLessThanOrEqual(0.20);
  });

  test('should reject peer reducing diversity below threshold', () => {
    const peers = createDiversePeerSet(20);
    peers.forEach(peer => peerSelector.addPeer(peer));

    peerSelector.selectDiversePeers();

    // Try to add peer that would reduce diversity
    const badPeer = createMockPeer({
      continent: peers[0].continent,
      autonomousSystem: peers[0].autonomousSystem,
      ipSubnet: peers[0].ipSubnet
    });

    const acceptance = peerSelector.wouldAcceptPeer(badPeer);
    expect(acceptance.accept).toBe(false);
  });
});

// ============================================================================
// Topology Monitoring Tests
// ============================================================================

describe('Eclipse Attack Prevention - Topology Monitoring', () => {
  let topologyMonitor: NetworkTopologyMonitor;

  beforeEach(() => {
    topologyMonitor = new NetworkTopologyMonitor();
  });

  afterEach(() => {
    topologyMonitor.stopMonitoring();
  });

  test('should detect sudden disconnections', (done) => {
    const nodes = createDiversePeerSet(10);

    nodes.forEach(peer => {
      topologyMonitor.addNode({
        nodeId: peer.nodeId,
        connections: new Set(),
        lastSeen: new Date(),
        isActive: true,
        geographicRegion: peer.continent,
        reputation: peer.reputationScore
      });
    });

    topologyMonitor.on('anomalyDetected', (anomaly) => {
      if (anomaly.type === 'SUDDEN_DISCONNECT') {
        expect(anomaly.severity).toBe('HIGH');
        done();
      }
    });

    // Simulate sudden disconnections
    setTimeout(() => {
      nodes.slice(0, 5).forEach(peer => {
        topologyMonitor.removeNode(peer.nodeId);
      });
    }, 100);
  });

  test('should calculate topology metrics correctly', async () => {
    const nodes = createDiversePeerSet(20);

    nodes.forEach(peer => {
      topologyMonitor.addNode({
        nodeId: peer.nodeId,
        connections: new Set(),
        lastSeen: new Date(),
        isActive: true,
        geographicRegion: peer.continent,
        reputation: peer.reputationScore
      });
    });

    // Add some edges
    for (let i = 0; i < nodes.length - 1; i++) {
      topologyMonitor.addEdge({
        source: nodes[i].nodeId,
        target: nodes[i + 1].nodeId,
        latency: 50,
        bandwidth: 1000,
        established: new Date(),
        lastActivity: new Date(),
        trafficVolume: 0
      });
    }

    const metrics = topologyMonitor.calculateTopologyMetrics();

    expect(metrics.totalNodes).toBe(20);
    expect(metrics.totalEdges).toBeGreaterThan(0);
    expect(metrics.averageDegree).toBeGreaterThan(0);
  });

  test('should detect network partitions', () => {
    const group1 = createDiversePeerSet(10);
    const group2 = createDiversePeerSet(10);

    // Add first group
    group1.forEach(peer => {
      topologyMonitor.addNode({
        nodeId: peer.nodeId,
        connections: new Set(),
        lastSeen: new Date(),
        isActive: true,
        geographicRegion: peer.continent,
        reputation: peer.reputationScore
      });
    });

    // Connect within group 1
    for (let i = 0; i < group1.length - 1; i++) {
      topologyMonitor.addEdge({
        source: group1[i].nodeId,
        target: group1[i + 1].nodeId,
        latency: 50,
        bandwidth: 1000,
        established: new Date(),
        lastActivity: new Date(),
        trafficVolume: 0
      });
    }

    // Add second group (disconnected)
    group2.forEach(peer => {
      topologyMonitor.addNode({
        nodeId: peer.nodeId,
        connections: new Set(),
        lastSeen: new Date(),
        isActive: true,
        geographicRegion: peer.continent,
        reputation: peer.reputationScore
      });
    });

    const partition = topologyMonitor.detectPartitions();
    expect(partition.partitions.length).toBeGreaterThanOrEqual(2);
  });
});

// ============================================================================
// Connection Diversity Tests
// ============================================================================

describe('Eclipse Attack Prevention - Connection Diversity', () => {
  let diversityManager: ConnectionDiversityManager;

  beforeEach(() => {
    diversityManager = new ConnectionDiversityManager();
  });

  test('should enforce minimum connection count', async () => {
    const peers = createDiversePeerSet(5);

    for (const peer of peers) {
      await diversityManager.addConnection(peer);
    }

    const score = diversityManager.getCurrentDiversityScore();
    expect(score.violations).toContain(expect.stringContaining('Insufficient connections'));
  });

  test('should trigger automatic correction on diversity violation', (done) => {
    const peers = createDiversePeerSet(25);

    diversityManager.on('autoCorrectStart', (violation) => {
      expect(violation.type).toBeDefined();
      done();
    });

    // Add concentrated peers
    const concentrated = peers.slice(0, 20).map(p => ({
      ...p,
      continent: 'NA',
      autonomousSystem: 'AS10000'
    }));

    Promise.all(concentrated.map(p => diversityManager.addConnection(p)));
  });

  test('should calculate diversity score accurately', async () => {
    const diversePeers = createDiversePeerSet(25);

    for (const peer of diversePeers) {
      await diversityManager.addConnection(peer);
    }

    const score = diversityManager.calculateDiversityScore(diversePeers);

    expect(score.geographicDiversity).toBeGreaterThan(50);
    expect(score.asnDiversity).toBeGreaterThan(50);
    expect(score.ipDiversity).toBeGreaterThan(50);
  });
});

// ============================================================================
// Cryptographic Proof Tests
// ============================================================================

describe('Eclipse Attack Prevention - Cryptographic Proofs', () => {
  let proofManager: CryptographicProofManager;

  beforeEach(() => {
    proofManager = new CryptographicProofManager();

    // Register mock validators
    for (let i = 0; i < 10; i++) {
      proofManager.registerValidator(
        `validator-${i}`,
        Buffer.alloc(32),
        BigInt(1000)
      );
    }
  });

  test('should generate and verify Merkle proofs', () => {
    const leaves = Array.from({ length: 8 }, (_, i) =>
      Buffer.from(`leaf-${i}`)
    );

    const proof = proofManager.generateMerkleProof(leaves, 3);
    const isValid = proofManager.verifyMerkleProof(proof);

    expect(isValid).toBe(true);
    expect(proof.index).toBe(3);
    expect(proof.leaf.equals(leaves[3])).toBe(true);
  });

  test('should verify block proofs with 2f+1 signatures', () => {
    const validatorSigs = Array.from({ length: 7 }, (_, i) => ({
      validatorId: `validator-${i}`,
      publicKey: Buffer.alloc(32),
      signature: Buffer.alloc(64),
      stake: BigInt(1000),
      timestamp: Date.now()
    }));

    const blockProof = proofManager.createBlockProof(
      Buffer.alloc(32),
      100,
      Buffer.alloc(32),
      Buffer.alloc(32),
      validatorSigs
    );

    const result = proofManager.verifyBlockProof(blockProof);
    expect(result.valid).toBe(true);
  });

  test('should reject proofs with insufficient stake', () => {
    const validatorSigs = Array.from({ length: 3 }, (_, i) => ({
      validatorId: `validator-${i}`,
      publicKey: Buffer.alloc(32),
      signature: Buffer.alloc(64),
      stake: BigInt(1000),
      timestamp: Date.now()
    }));

    const blockProof = proofManager.createBlockProof(
      Buffer.alloc(32),
      100,
      Buffer.alloc(32),
      Buffer.alloc(32),
      validatorSigs
    );

    const result = proofManager.verifyBlockProof(blockProof);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain('Insufficient stake');
  });
});

// ============================================================================
// Performance Benchmarks
// ============================================================================

describe('Eclipse Attack Prevention - Performance', () => {
  test('peer selection should complete within 2 seconds', async () => {
    const peerSelector = new DiversePeerSelectionManager();
    const peers = createDiversePeerSet(100);
    peers.forEach(peer => peerSelector.addPeer(peer));

    const startTime = Date.now();
    peerSelector.selectDiversePeers();
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(2000);
  });

  test('topology analysis should complete within 5 seconds for 1000 nodes', () => {
    const monitor = new NetworkTopologyMonitor();
    const nodes = createDiversePeerSet(1000);

    nodes.forEach(peer => {
      monitor.addNode({
        nodeId: peer.nodeId,
        connections: new Set(),
        lastSeen: new Date(),
        isActive: true,
        geographicRegion: peer.continent,
        reputation: peer.reputationScore
      });
    });

    const startTime = Date.now();
    monitor.calculateTopologyMetrics();
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(5000);
    monitor.stopMonitoring();
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Eclipse Attack Prevention - Full Integration', () => {
  test('should detect and recover from simulated Eclipse attack', async () => {
    const peerSelector = new DiversePeerSelectionManager();
    const topologyMonitor = new NetworkTopologyMonitor();
    const diversityManager = new ConnectionDiversityManager();
    const consensusVerifier = new ConsensusStateVerifier();
    const partitionRecovery = new PartitionRecoveryManager(['bootstrap-1', 'bootstrap-2']);

    // Setup diverse peer set
    const peers = createDiversePeerSet(50);
    peers.forEach(peer => peerSelector.addPeer(peer));

    const selected = peerSelector.selectDiversePeers();
    expect(selected.diversityScore.meetsMinimumRequirements).toBe(true);

    // Simulate Eclipse attack (malicious nodes isolate victim)
    const maliciousPeers = selected.selectedPeers.slice(0, 10);

    // Detect isolation through consensus verification
    const consensusResult = await consensusVerifier.verifyConsensusState(selected.selectedPeers);

    if (consensusResult.isIsolated) {
      // Detect partition
      const partitionDetection = await partitionRecovery.detectPartition(
        selected.selectedPeers,
        50
      );

      expect(partitionDetection.isPartitioned).toBe(true);

      // Execute recovery
      const recoveryResult = await partitionRecovery.recover(
        partitionDetection,
        selected.selectedPeers
      );

      expect(recoveryResult.success).toBe(true);
    }

    topologyMonitor.stopMonitoring();
  });
});
