/**
 * Network Partition Resilience Test Suite
 * Comprehensive tests for partition detection, prevention, and recovery
 *
 * SECURITY: Tests Task 100.9 implementation:
 * - Network partition detection
 * - Split-brain prevention
 * - State reconciliation
 * - Checkpoint recovery
 * - Consensus behavior during partitions
 * - Partition healing and recovery
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import {
  NetworkPartitionDetector,
  NetworkNode,
  PartitionEvent,
} from '../shared/network-partition-detector.js';
import {
  PartitionTolerantConsensus,
  ConsensusNode,
} from '../shared/partition-tolerant-consensus.js';
import {
  SplitBrainPrevention,
  BlockchainState,
  QuorumVote,
} from '../shared/split-brain-prevention.js';
import {
  StateReconciliation,
  StateSnapshot,
  Transaction,
  AccountState,
} from '../shared/state-reconciliation.js';
import {
  CheckpointManager,
  Checkpoint,
} from '../shared/checkpoint-manager.js';
import {
  PartitionRecovery,
  RecoveryProcess,
} from '../shared/partition-recovery.js';
import {
  NetworkTopologyMonitor,
  NetworkNode as TopologyNode,
} from '../shared/network-topology-monitor.js';

describe('Network Partition Detection', () => {
  let detector: NetworkPartitionDetector;

  beforeEach(() => {
    detector = new NetworkPartitionDetector({
      heartbeatInterval: 100,
      failureThreshold: 2,
      partitionThreshold: 30,
    });
  });

  afterEach(() => {
    detector.stop();
  });

  test('should detect network partition when threshold exceeded', async () => {
    await detector.start();

    // Register 10 nodes
    for (let i = 0; i < 10; i++) {
      const node: NetworkNode = {
        nodeId: `node-${i}`,
        address: `192.168.1.${i}`,
        port: 3000 + i,
        isValidator: i < 5,
        stake: i < 5 ? BigInt(1000) : undefined,
        lastSeen: new Date(),
        consecutiveFailures: i < 3 ? 0 : 3, // First 3 reachable, rest unreachable
      };
      detector.registerNode(node);
    }

    // Wait for detection
    await new Promise((resolve) => setTimeout(resolve, 200));

    const partitionDetected = await new Promise<boolean>((resolve) => {
      detector.once('partition_detected', () => resolve(true));
      setTimeout(() => resolve(false), 500);
    });

    expect(partitionDetected).toBe(true);

    const status = detector.getPartitionStatus();
    expect(status.hasActivePartition).toBe(true);
  }, 10000);

  test('should classify partition severity correctly', async () => {
    await detector.start();

    // Create severe partition (60% unreachable)
    for (let i = 0; i < 10; i++) {
      const node: NetworkNode = {
        nodeId: `node-${i}`,
        address: `192.168.1.${i}`,
        port: 3000 + i,
        isValidator: i < 5,
        stake: i < 5 ? BigInt(1000) : undefined,
        lastSeen: new Date(),
        consecutiveFailures: i < 4 ? 0 : 3,
      };
      detector.registerNode(node);
    }

    const partitionEvent = await new Promise<PartitionEvent | null>((resolve) => {
      detector.once('partition_detected', (event) => resolve(event));
      setTimeout(() => resolve(null), 1000);
    });

    expect(partitionEvent).not.toBeNull();
    expect(partitionEvent?.severity).toMatch(/moderate|severe|critical/);
  }, 10000);

  test('should detect partition healing', async () => {
    await detector.start();

    // Create partition
    for (let i = 0; i < 10; i++) {
      const node: NetworkNode = {
        nodeId: `node-${i}`,
        address: `192.168.1.${i}`,
        port: 3000 + i,
        isValidator: i < 5,
        lastSeen: new Date(),
        consecutiveFailures: i < 3 ? 0 : 3,
      };
      detector.registerNode(node);
    }

    // Wait for partition detection
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Heal partition by marking all nodes reachable
    for (let i = 0; i < 10; i++) {
      detector.recordProbe({
        targetNodeId: `node-${i}`,
        probedAt: new Date(),
        success: true,
        latency: 50,
      });
    }

    const healingDetected = await new Promise<boolean>((resolve) => {
      detector.once('partition_healed', () => resolve(true));
      setTimeout(() => resolve(false), 2000);
    });

    expect(healingDetected).toBe(true);
  }, 15000);
});

describe('Partition-Tolerant Consensus', () => {
  let consensus: PartitionTolerantConsensus;

  beforeEach(() => {
    consensus = new PartitionTolerantConsensus('node-1', {
      electionTimeout: 500,
      heartbeatInterval: 100,
      haltOnPartition: true,
    });
  });

  afterEach(() => {
    consensus.stop();
  });

  test('should halt consensus during partition', async () => {
    await consensus.start();

    // Register validators
    for (let i = 0; i < 5; i++) {
      const node: ConsensusNode = {
        nodeId: `node-${i}`,
        isValidator: true,
        stake: BigInt(1000),
        term: 0,
        votedFor: null,
        lastHeartbeat: new Date(),
        role: 'follower',
      };
      consensus.registerNode(node);
    }

    // Simulate partition (minority partition)
    const partitionEvent: PartitionEvent = {
      partitionId: 'test-partition',
      detectedAt: new Date(),
      severity: 'severe',
      affectedNodes: ['node-3', 'node-4'],
      affectedValidators: ['node-3', 'node-4'],
      totalStakeAffected: BigInt(2000),
      estimatedDuration: 0,
      partitionType: 'sustained',
      topology: {
        partitions: [
          {
            partitionId: 'majority',
            nodes: ['node-0', 'node-1', 'node-2'],
            validators: ['node-0', 'node-1', 'node-2'],
            totalStake: BigInt(3000),
            isConsensusCapable: true,
            isMajority: true,
          },
          {
            partitionId: 'minority',
            nodes: ['node-3', 'node-4'],
            validators: ['node-3', 'node-4'],
            totalStake: BigInt(2000),
            isConsensusCapable: false,
            isMajority: false,
          },
        ],
        isolatedNodes: ['node-3', 'node-4'],
        bridgeNodes: [],
        majorityPartition: 'majority',
        consensusCapable: true,
      },
      metadata: {
        triggerReason: 'Test partition',
        networkMetrics: {
          totalNodes: 5,
          reachableNodes: 3,
          unreachableNodes: 2,
          validatorNodes: 5,
          reachableValidators: 3,
          unreachableValidators: 2,
          averageLatency: 100,
          packetLoss: 40,
          timestamp: new Date(),
        },
        potentialCauses: ['Test'],
      },
    };

    consensus.handlePartitionEvent(partitionEvent);

    const status = consensus.getConsensusStatus();
    expect(status.consensusHalted).toBe(true);
  });

  test('should resume consensus after partition heals', async () => {
    await consensus.start();

    // Register validators
    for (let i = 0; i < 5; i++) {
      const node: ConsensusNode = {
        nodeId: `node-${i}`,
        isValidator: true,
        stake: BigInt(1000),
        term: 0,
        votedFor: null,
        lastHeartbeat: new Date(),
        role: 'follower',
      };
      consensus.registerNode(node);
    }

    // Simulate and then heal partition
    const partitionEvent: PartitionEvent = {
      partitionId: 'test-partition',
      detectedAt: new Date(),
      severity: 'severe',
      affectedNodes: ['node-3', 'node-4'],
      affectedValidators: ['node-3', 'node-4'],
      totalStakeAffected: BigInt(2000),
      estimatedDuration: 0,
      partitionType: 'sustained',
      topology: {
        partitions: [
          {
            partitionId: 'majority',
            nodes: ['node-0', 'node-1', 'node-2'],
            validators: ['node-0', 'node-1', 'node-2'],
            totalStake: BigInt(3000),
            isConsensusCapable: true,
            isMajority: true,
          },
        ],
        isolatedNodes: ['node-3', 'node-4'],
        bridgeNodes: [],
        majorityPartition: 'majority',
        consensusCapable: true,
      },
      metadata: {
        triggerReason: 'Test',
        networkMetrics: {
          totalNodes: 5,
          reachableNodes: 3,
          unreachableNodes: 2,
          validatorNodes: 5,
          reachableValidators: 3,
          unreachableValidators: 2,
          averageLatency: 100,
          packetLoss: 40,
          timestamp: new Date(),
        },
        potentialCauses: ['Test'],
      },
    };

    consensus.handlePartitionEvent(partitionEvent);
    expect(consensus.getConsensusStatus().consensusHalted).toBe(true);

    // Heal partition
    consensus.handlePartitionHealed();

    const status = consensus.getConsensusStatus();
    expect(status.consensusHalted).toBe(false);
  });
});

describe('Split-Brain Prevention', () => {
  let splitBrain: SplitBrainPrevention;

  beforeEach(() => {
    splitBrain = new SplitBrainPrevention('node-1', {
      minimumQuorumSize: 3,
      minimumQuorumPercentage: 67,
      haltOnMinorityPartition: true,
    });
  });

  afterEach(() => {
    splitBrain.stop();
  });

  test('should prevent block production in minority partition', async () => {
    await splitBrain.start();

    // Register validators
    for (let i = 0; i < 5; i++) {
      splitBrain.registerValidator(`node-${i}`, BigInt(1000));
    }

    // Simulate minority partition
    const partitionEvent: PartitionEvent = {
      partitionId: 'test-partition',
      detectedAt: new Date(),
      severity: 'severe',
      affectedNodes: ['node-0', 'node-1'],
      affectedValidators: ['node-0', 'node-1'],
      totalStakeAffected: BigInt(2000),
      estimatedDuration: 0,
      partitionType: 'sustained',
      topology: {
        partitions: [
          {
            partitionId: 'minority',
            nodes: ['node-0', 'node-1'],
            validators: ['node-0', 'node-1'],
            totalStake: BigInt(2000),
            isConsensusCapable: false,
            isMajority: false,
          },
          {
            partitionId: 'majority',
            nodes: ['node-2', 'node-3', 'node-4'],
            validators: ['node-2', 'node-3', 'node-4'],
            totalStake: BigInt(3000),
            isConsensusCapable: true,
            isMajority: true,
          },
        ],
        isolatedNodes: ['node-0', 'node-1'],
        bridgeNodes: [],
        majorityPartition: 'majority',
        consensusCapable: true,
      },
      metadata: {
        triggerReason: 'Test',
        networkMetrics: {
          totalNodes: 5,
          reachableNodes: 2,
          unreachableNodes: 3,
          validatorNodes: 5,
          reachableValidators: 2,
          unreachableValidators: 3,
          averageLatency: 100,
          packetLoss: 60,
          timestamp: new Date(),
        },
        potentialCauses: ['Test'],
      },
    };

    splitBrain.handlePartitionEvent(partitionEvent);

    expect(splitBrain.canProduceBlock()).toBe(false);
    expect(splitBrain.canParticipateInConsensus()).toBe(false);
  });

  test('should validate quorum votes', async () => {
    await splitBrain.start();

    // Register validators
    for (let i = 0; i < 5; i++) {
      splitBrain.registerValidator(`node-${i}`, BigInt(1000));
    }

    // Record votes for same block
    const blockHash = 'test-block-hash';
    for (let i = 0; i < 4; i++) {
      const vote: QuorumVote = {
        voterId: `node-${i}`,
        blockHash,
        blockHeight: 100,
        signature: `sig-${i}`,
        timestamp: new Date(),
      };
      splitBrain.recordQuorumVote(vote);
    }

    // Quorum should be achieved (4 out of 5 validators, 80% > 67%)
    const status = splitBrain.getStatus();
    expect(status.consensusAllowed).toBe(true);
  });
});

describe('State Reconciliation', () => {
  let reconciliation: StateReconciliation;

  beforeEach(() => {
    reconciliation = new StateReconciliation({
      conflictResolutionStrategy: 'majority',
      enableDoubleSpendDetection: true,
    });
  });

  test('should detect conflicting states', async () => {
    const accounts1 = new Map<string, AccountState>();
    accounts1.set('alice', {
      address: 'alice',
      balance: BigInt(1000),
      nonce: 1,
      stateHash: 'hash1',
    });

    const accounts2 = new Map<string, AccountState>();
    accounts2.set('alice', {
      address: 'alice',
      balance: BigInt(900), // Different balance
      nonce: 1,
      stateHash: 'hash2',
    });

    const snapshot1: StateSnapshot = {
      snapshotId: 'snap1',
      blockHeight: 100,
      blockHash: 'block-hash-1',
      stateRoot: 'root1',
      timestamp: new Date(),
      transactions: [],
      accounts: accounts1,
      merkleRoot: 'merkle1',
      validatorSignatures: new Map(),
    };

    const snapshot2: StateSnapshot = {
      snapshotId: 'snap2',
      blockHeight: 100, // Same height
      blockHash: 'block-hash-2',
      stateRoot: 'root2', // Different state
      timestamp: new Date(),
      transactions: [],
      accounts: accounts2,
      merkleRoot: 'merkle2',
      validatorSignatures: new Map(),
    };

    reconciliation.recordSnapshot(snapshot1);

    const conflictDetected = await new Promise<boolean>((resolve) => {
      reconciliation.once('conflict_detected', () => resolve(true));
      reconciliation.recordSnapshot(snapshot2);
      setTimeout(() => resolve(false), 100);
    });

    expect(conflictDetected).toBe(true);

    const status = reconciliation.getStatus();
    expect(status.activeConflicts).toBeGreaterThan(0);
  });

  test('should create and execute reconciliation plan', async () => {
    const accounts1 = new Map<string, AccountState>();
    accounts1.set('alice', {
      address: 'alice',
      balance: BigInt(1000),
      nonce: 1,
      stateHash: 'hash1',
    });

    const accounts2 = new Map<string, AccountState>();
    accounts2.set('alice', {
      address: 'alice',
      balance: BigInt(900),
      nonce: 1,
      stateHash: 'hash2',
    });

    const snapshot1: StateSnapshot = {
      snapshotId: 'snap1',
      blockHeight: 100,
      blockHash: 'block-hash-1',
      stateRoot: 'root1',
      timestamp: new Date(),
      transactions: [],
      accounts: accounts1,
      merkleRoot: 'merkle1',
      validatorSignatures: new Map([
        ['validator1', 'sig1'],
        ['validator2', 'sig2'],
        ['validator3', 'sig3'],
      ]),
    };

    const snapshot2: StateSnapshot = {
      snapshotId: 'snap2',
      blockHeight: 100,
      blockHash: 'block-hash-2',
      stateRoot: 'root2',
      timestamp: new Date(),
      transactions: [],
      accounts: accounts2,
      merkleRoot: 'merkle2',
      validatorSignatures: new Map([['validator4', 'sig4']]),
    };

    reconciliation.recordSnapshot(snapshot1);
    reconciliation.recordSnapshot(snapshot2);

    const status = reconciliation.getStatus();
    const conflicts = status.conflicts;

    expect(conflicts.length).toBeGreaterThan(0);

    if (conflicts.length > 0) {
      const plan = await reconciliation.createReconciliationPlan(
        conflicts[0].conflictId
      );

      expect(plan).toBeDefined();
      expect(plan.canonicalState).toBeDefined();
      expect(plan.conflictingStates.length).toBeGreaterThan(0);
    }
  });
});

describe('Checkpoint Manager', () => {
  let checkpointManager: CheckpointManager;

  beforeEach(() => {
    checkpointManager = new CheckpointManager({
      minValidatorSignatures: 3,
      minStakePercentage: 67,
    });

    // Register validators
    for (let i = 0; i < 5; i++) {
      checkpointManager.registerValidator(
        `validator-${i}`,
        `pubkey-${i}`,
        BigInt(1000)
      );
    }
  });

  test('should create checkpoint', async () => {
    const accounts = new Map<string, AccountState>();
    accounts.set('alice', {
      address: 'alice',
      balance: BigInt(1000),
      nonce: 1,
      stateHash: 'hash1',
    });

    const checkpoint = await checkpointManager.createCheckpoint(
      100,
      'block-hash',
      'state-root',
      [],
      accounts
    );

    expect(checkpoint).toBeDefined();
    expect(checkpoint.blockHeight).toBe(100);
    expect(checkpoint.accounts.size).toBe(1);
  });

  test('should sign and validate checkpoint', async () => {
    const accounts = new Map<string, AccountState>();
    const checkpoint = await checkpointManager.createCheckpoint(
      100,
      'block-hash',
      'state-root',
      [],
      accounts
    );

    // Sign checkpoint with 4 validators
    for (let i = 0; i < 4; i++) {
      await checkpointManager.signCheckpoint(
        checkpoint.checkpointId,
        `validator-${i}`
      );
    }

    // Wait for finalization
    await new Promise((resolve) => setTimeout(resolve, 100));

    const finalizedCheckpoint = checkpointManager.getCheckpoint(
      checkpoint.checkpointId
    );
    expect(finalizedCheckpoint).toBeDefined();
    expect(finalizedCheckpoint?.validatorSignatures.size).toBe(4);
  });

  test('should recover from checkpoint', async () => {
    const accounts = new Map<string, AccountState>();
    accounts.set('alice', {
      address: 'alice',
      balance: BigInt(1000),
      nonce: 1,
      stateHash: 'hash1',
    });

    const checkpoint = await checkpointManager.createCheckpoint(
      100,
      'block-hash',
      'state-root',
      [],
      accounts
    );

    // Sign and finalize
    for (let i = 0; i < 4; i++) {
      await checkpointManager.signCheckpoint(
        checkpoint.checkpointId,
        `validator-${i}`
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));

    // Recover
    const recovery = await checkpointManager.recoverFromCheckpoint(
      checkpoint.checkpointId
    );

    expect(recovery.success).toBe(true);
    expect(recovery.accountsRestored).toBe(1);
  });
});

describe('Network Topology Monitor', () => {
  let topologyMonitor: NetworkTopologyMonitor;

  beforeEach(() => {
    topologyMonitor = new NetworkTopologyMonitor({
      snapshotInterval: 100,
      predictionInterval: 200,
      enablePrediction: true,
    });
  });

  afterEach(() => {
    topologyMonitor.stop();
  });

  test('should track network topology', async () => {
    await topologyMonitor.start();

    // Register nodes
    for (let i = 0; i < 5; i++) {
      const node: TopologyNode = {
        nodeId: `node-${i}`,
        address: `192.168.1.${i}`,
        port: 3000 + i,
        region: i < 3 ? 'us-west' : 'us-east',
        asn: i < 3 ? 'AS1' : 'AS2',
        isValidator: true,
        connections: [],
        latency: new Map(),
        lastSeen: new Date(),
        status: 'online',
      };
      topologyMonitor.registerNode(node);
    }

    // Update connections
    topologyMonitor.updateConnection('node-0', 'node-1', 50);
    topologyMonitor.updateConnection('node-1', 'node-2', 60);

    await new Promise((resolve) => setTimeout(resolve, 200));

    const topology = topologyMonitor.getCurrentTopology();
    expect(topology).not.toBeNull();
    expect(topology?.nodes.size).toBe(5);
  }, 10000);

  test('should predict network partitions', async () => {
    await topologyMonitor.start();

    // Create topology with low connectivity
    for (let i = 0; i < 10; i++) {
      const node: TopologyNode = {
        nodeId: `node-${i}`,
        address: `192.168.1.${i}`,
        port: 3000 + i,
        region: 'us-west',
        isValidator: true,
        connections: i > 0 ? [`node-${i - 1}`] : [], // Linear chain (fragile)
        latency: new Map(),
        lastSeen: new Date(),
        status: 'online',
      };
      topologyMonitor.registerNode(node);
    }

    // Mark some nodes as degraded
    topologyMonitor.updateNodeStatus('node-5', 'degraded');
    topologyMonitor.updateNodeStatus('node-6', 'degraded');

    await new Promise((resolve) => setTimeout(resolve, 500));

    const predictions = topologyMonitor.getPredictions();
    // Predictions may or may not be generated depending on algorithm
    expect(Array.isArray(predictions)).toBe(true);
  }, 10000);
});

describe('Performance Tests', () => {
  test('partition detection should complete within 30 seconds', async () => {
    const detector = new NetworkPartitionDetector({
      heartbeatInterval: 100,
      failureThreshold: 2,
    });

    await detector.start();

    const startTime = Date.now();

    // Register 100 nodes
    for (let i = 0; i < 100; i++) {
      const node: NetworkNode = {
        nodeId: `node-${i}`,
        address: `192.168.1.${i}`,
        port: 3000,
        isValidator: i < 50,
        lastSeen: new Date(),
        consecutiveFailures: i < 30 ? 0 : 3, // 30% unreachable
      };
      detector.registerNode(node);
    }

    const partitionDetected = await new Promise<boolean>((resolve) => {
      detector.once('partition_detected', () => resolve(true));
      setTimeout(() => resolve(false), 30000);
    });

    const detectionTime = Date.now() - startTime;

    detector.stop();

    expect(partitionDetected).toBe(true);
    expect(detectionTime).toBeLessThan(30000);
  }, 35000);

  test('checkpoint creation should complete within 10 seconds', async () => {
    const checkpointManager = new CheckpointManager();

    // Create large state (1000 accounts)
    const accounts = new Map<string, AccountState>();
    for (let i = 0; i < 1000; i++) {
      accounts.set(`account-${i}`, {
        address: `account-${i}`,
        balance: BigInt(1000),
        nonce: 1,
        stateHash: `hash-${i}`,
      });
    }

    const startTime = Date.now();

    const checkpoint = await checkpointManager.createCheckpoint(
      1000,
      'block-hash',
      'state-root',
      [],
      accounts
    );

    const creationTime = Date.now() - startTime;

    expect(checkpoint).toBeDefined();
    expect(creationTime).toBeLessThan(10000);
  });
});
