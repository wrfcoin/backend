/**
 * Split-Brain Prevention System
 * Prevents multiple consensus states from forming during network partitions
 *
 * SECURITY: Addresses Task 100.9 vulnerabilities:
 * - Enforces majority quorum for all consensus decisions
 * - Detects and prevents conflicting blockchain states
 * - Implements partition-aware block production
 * - Validates validator isolation scenarios
 * - Halts consensus in minority partitions
 * - Prevents double-spending through state validation
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import {
  PartitionEvent,
  PartitionTopology,
  NetworkPartition,
} from './network-partition-detector.js';
import { blockchainLogger } from '../server/utils/logger.js';

export interface BlockchainState {
  blockHeight: number;
  blockHash: string;
  stateRoot: string;
  timestamp: Date;
  validatorSet: string[];
  totalStake: bigint;
}

export interface ConflictingState {
  stateId: string;
  detectedAt: Date;
  states: BlockchainState[];
  divergencePoint: number; // Block height where states diverged
  severity: 'minor' | 'major' | 'critical';
  affectedValidators: string[];
  resolutionStrategy: 'rollback' | 'merge' | 'halt';
}

export interface QuorumVote {
  voterId: string;
  blockHash: string;
  blockHeight: number;
  signature: string;
  timestamp: Date;
  partitionId?: string;
}

export interface SplitBrainDetection {
  detectionId: string;
  detectedAt: Date;
  partitionCount: number;
  activeChains: number;
  consensusActive: boolean[];
  recommendedAction: 'halt' | 'continue' | 'merge';
}

export interface ValidatorIsolation {
  validatorId: string;
  isolatedAt: Date;
  canSeeValidators: string[];
  cannotSeeValidators: string[];
  isolationSeverity: 'partial' | 'complete';
  hasConsensusCapability: boolean;
}

export interface SplitBrainConfig {
  minimumQuorumSize: number;
  minimumQuorumPercentage: number;
  minimumStakePercentage: number;
  blockProductionThreshold: number; // % of validators needed to produce blocks
  stateConflictWindow: number; // blocks to check for conflicts
  isolationThreshold: number; // % of validators unreachable to mark isolated
  haltOnMinorityPartition: boolean;
  enforceStrictQuorum: boolean;
}

/**
 * Split-Brain Prevention Service
 * SECURITY: Ensures single canonical blockchain state
 */
export class SplitBrainPrevention extends EventEmitter {
  private blockchainStates: Map<string, BlockchainState> = new Map();
  private conflictingStates: Map<string, ConflictingState> = new Map();
  private quorumVotes: Map<number, QuorumVote[]> = new Map(); // blockHeight -> votes
  private validatorIsolation: Map<string, ValidatorIsolation> = new Map();
  private splitBrainDetections: SplitBrainDetection[] = [];

  private currentPartition: PartitionEvent | null = null;
  private consensusAllowed: boolean = true;
  private blockProductionAllowed: boolean = true;

  private readonly config: SplitBrainConfig;
  private readonly nodeId: string;
  private readonly validators: Map<string, { stake: bigint; online: boolean }> =
    new Map();

  private static readonly DEFAULT_CONFIG: SplitBrainConfig = {
    minimumQuorumSize: 4,
    minimumQuorumPercentage: 67, // 2/3 majority
    minimumStakePercentage: 67,
    blockProductionThreshold: 67,
    stateConflictWindow: 100,
    isolationThreshold: 50,
    haltOnMinorityPartition: true,
    enforceStrictQuorum: true,
  };

  constructor(nodeId: string, config?: Partial<SplitBrainConfig>) {
    super();
    this.nodeId = nodeId;
    this.config = { ...SplitBrainPrevention.DEFAULT_CONFIG, ...config };
  }

  /**
   * Start split-brain prevention
   */
  async start(): Promise<void> {
    blockchainLogger.info('Starting split-brain prevention system', { module: 'SplitBrainPrevention' });
    this.consensusAllowed = true;
    this.blockProductionAllowed = true;
    this.emit('started');
  }

  /**
   * Stop split-brain prevention
   */
  stop(): void {
    blockchainLogger.info('Stopped split-brain prevention', { module: 'SplitBrainPrevention' });
    this.emit('stopped');
  }

  /**
   * Handle network partition event
   */
  handlePartitionEvent(partition: PartitionEvent): void {
    blockchainLogger.info('Processing partition event', {
      module: 'SplitBrainPrevention',
      severity: partition.severity
    });

    this.currentPartition = partition;

    // Analyze partition impact on consensus
    const inMajority = this.isInMajorityPartition(partition.topology);
    const hasQuorum = this.hasValidatorQuorum(partition.topology);

    blockchainLogger.info('Partition analysis', {
      module: 'SplitBrainPrevention',
      inMajority,
      hasQuorum
    });

    // Determine if consensus should be allowed
    if (this.config.haltOnMinorityPartition && !inMajority) {
      this.haltConsensus('Node is in minority partition');
    } else if (!hasQuorum) {
      this.haltConsensus('Insufficient validator quorum');
    } else if (partition.severity === 'critical') {
      this.haltConsensus('Critical network partition detected');
    }

    // Check for validator isolation
    this.detectValidatorIsolation(partition.topology);

    // Check for split-brain scenario
    this.detectSplitBrain(partition);

    this.emit('partition_handled', {
      partition,
      consensusAllowed: this.consensusAllowed,
      blockProductionAllowed: this.blockProductionAllowed,
    });
  }

  /**
   * Handle partition healing
   */
  handlePartitionHealed(): void {
    blockchainLogger.info('Network partition healed', { module: 'SplitBrainPrevention' });

    this.currentPartition = null;

    // Resume consensus if it was halted
    if (!this.consensusAllowed) {
      this.resumeConsensus();
    }

    // Clear validator isolation
    this.validatorIsolation.clear();

    this.emit('partition_healed');
  }

  /**
   * Validate block production permission
   */
  canProduceBlock(): boolean {
    if (!this.blockProductionAllowed) {
      return false;
    }

    if (this.currentPartition) {
      const topology = this.currentPartition.topology;

      // Must be in majority partition
      if (!this.isInMajorityPartition(topology)) {
        return false;
      }

      // Must have sufficient validators
      const availableValidators = this.getAvailableValidators(topology);
      const totalValidators = this.validators.size;

      const validatorPercentage =
        (availableValidators.length / totalValidators) * 100;

      return validatorPercentage >= this.config.blockProductionThreshold;
    }

    return true;
  }

  /**
   * Validate consensus participation
   */
  canParticipateInConsensus(): boolean {
    if (!this.consensusAllowed) {
      return false;
    }

    if (this.currentPartition) {
      return this.isInMajorityPartition(this.currentPartition.topology);
    }

    return true;
  }

  /**
   * Record blockchain state
   */
  recordBlockchainState(state: BlockchainState): void {
    const stateKey = `${state.blockHeight}-${state.blockHash}`;
    this.blockchainStates.set(stateKey, state);

    // Check for conflicting states at same height
    this.detectConflictingStates(state.blockHeight);

    // Clean up old states
    this.cleanupOldStates(state.blockHeight - this.config.stateConflictWindow);
  }

  /**
   * Record quorum vote
   */
  recordQuorumVote(vote: QuorumVote): void {
    if (!this.quorumVotes.has(vote.blockHeight)) {
      this.quorumVotes.set(vote.blockHeight, []);
    }

    const votes = this.quorumVotes.get(vote.blockHeight)!;
    votes.push(vote);

    blockchainLogger.info('Recorded quorum vote', {
      module: 'SplitBrainPrevention',
      blockHeight: vote.blockHeight,
      voterId: vote.voterId
    });

    // Validate quorum
    this.validateQuorum(vote.blockHeight);
  }

  /**
   * Validate quorum for block height
   */
  private validateQuorum(blockHeight: number): boolean {
    const votes = this.quorumVotes.get(blockHeight);
    if (!votes || votes.length === 0) return false;

    const totalValidators = this.validators.size;
    const voteCount = votes.length;

    // Check quorum size
    if (voteCount < this.config.minimumQuorumSize) {
      return false;
    }

    // Check quorum percentage
    const quorumPercentage = (voteCount / totalValidators) * 100;
    if (quorumPercentage < this.config.minimumQuorumPercentage) {
      return false;
    }

    // Check stake percentage
    const voteStake = votes.reduce((sum, vote) => {
      const validator = this.validators.get(vote.voterId);
      return sum + (validator?.stake || BigInt(0));
    }, BigInt(0));

    const totalStake = Array.from(this.validators.values()).reduce(
      (sum, v) => sum + v.stake,
      BigInt(0)
    );

    const stakePercentage =
      totalStake > BigInt(0)
        ? Number((voteStake * BigInt(100)) / totalStake)
        : 0;

    if (stakePercentage < this.config.minimumStakePercentage) {
      return false;
    }

    // Check for majority agreement on same block hash
    const hashCounts = new Map<string, number>();
    for (const vote of votes) {
      hashCounts.set(vote.blockHash, (hashCounts.get(vote.blockHash) || 0) + 1);
    }

    const majorityHash = Array.from(hashCounts.entries()).reduce((a, b) =>
      a[1] > b[1] ? a : b
    );

    const hasConsensus = majorityHash[1] >= Math.ceil((voteCount * 2) / 3);

    if (hasConsensus) {
      blockchainLogger.info('Quorum achieved', {
        module: 'SplitBrainPrevention',
        blockHeight,
        hash: majorityHash[0]
      });
      this.emit('quorum_achieved', {
        blockHeight,
        blockHash: majorityHash[0],
        votes: majorityHash[1],
        totalValidators,
      });
    }

    return hasConsensus;
  }

  /**
   * Detect conflicting blockchain states
   */
  private detectConflictingStates(blockHeight: number): void {
    const statesAtHeight: BlockchainState[] = [];

    for (const [key, state] of this.blockchainStates) {
      if (state.blockHeight === blockHeight) {
        statesAtHeight.push(state);
      }
    }

    // Multiple states at same height indicate potential split-brain
    if (statesAtHeight.length > 1) {
      const conflictId = crypto.randomBytes(16).toString('hex');
      const severity = this.calculateConflictSeverity(statesAtHeight);

      const conflict: ConflictingState = {
        stateId: conflictId,
        detectedAt: new Date(),
        states: statesAtHeight,
        divergencePoint: blockHeight,
        severity,
        affectedValidators: this.extractAffectedValidators(statesAtHeight),
        resolutionStrategy: this.determineResolutionStrategy(severity),
      };

      this.conflictingStates.set(conflictId, conflict);

      blockchainLogger.error('CONFLICTING STATES DETECTED', {
        module: 'SplitBrainPrevention',
        blockHeight,
        severity
      });

      this.emit('conflicting_states_detected', conflict);

      // Take action based on severity
      if (severity === 'critical') {
        this.haltConsensus('Critical state conflict detected');
      }
    }
  }

  /**
   * Detect split-brain scenario
   */
  private detectSplitBrain(partition: PartitionEvent): void {
    const activeChains = partition.topology.partitions.filter(
      (p) => p.isConsensusCapable
    );

    // Split-brain occurs when multiple partitions can achieve consensus
    if (activeChains.length > 1) {
      const detection: SplitBrainDetection = {
        detectionId: crypto.randomBytes(16).toString('hex'),
        detectedAt: new Date(),
        partitionCount: partition.topology.partitions.length,
        activeChains: activeChains.length,
        consensusActive: activeChains.map((p) => p.isConsensusCapable),
        recommendedAction: 'halt',
      };

      this.splitBrainDetections.push(detection);

      blockchainLogger.error('SPLIT-BRAIN SCENARIO DETECTED', {
        module: 'SplitBrainPrevention',
        activeChains: activeChains.length
      });

      this.emit('split_brain_detected', detection);

      // Halt consensus to prevent divergence
      this.haltConsensus('Split-brain scenario detected');
    }
  }

  /**
   * Detect validator isolation
   */
  private detectValidatorIsolation(topology: PartitionTopology): void {
    for (const [validatorId, validator] of this.validators) {
      // Find which partition this validator is in
      let validatorPartition: NetworkPartition | undefined;
      for (const partition of topology.partitions) {
        if (partition.validators.includes(validatorId)) {
          validatorPartition = partition;
          break;
        }
      }

      if (!validatorPartition) continue;

      const canSee = validatorPartition.validators;
      const cannotSee = Array.from(this.validators.keys()).filter(
        (id) => !canSee.includes(id)
      );

      const isolationPercentage =
        (cannotSee.length / this.validators.size) * 100;

      if (isolationPercentage >= this.config.isolationThreshold) {
        const isolation: ValidatorIsolation = {
          validatorId,
          isolatedAt: new Date(),
          canSeeValidators: canSee,
          cannotSeeValidators: cannotSee,
          isolationSeverity:
            isolationPercentage >= 80 ? 'complete' : 'partial',
          hasConsensusCapability: validatorPartition.isConsensusCapable,
        };

        this.validatorIsolation.set(validatorId, isolation);

        blockchainLogger.warn('Validator isolated', {
          module: 'SplitBrainPrevention',
          validatorId,
          isolationSeverity: isolation.isolationSeverity
        });

        this.emit('validator_isolated', isolation);
      }
    }
  }

  /**
   * Determine if node is in majority partition
   */
  private isInMajorityPartition(topology: PartitionTopology): boolean {
    if (!topology.majorityPartition) return false;

    const majorityPartition = topology.partitions.find(
      (p) => p.partitionId === topology.majorityPartition
    );

    return majorityPartition?.nodes.includes(this.nodeId) || false;
  }

  /**
   * Check if validator quorum exists
   */
  private hasValidatorQuorum(topology: PartitionTopology): boolean {
    const majorityPartition = topology.partitions.find((p) => p.isMajority);

    if (!majorityPartition) return false;

    const availableValidators = majorityPartition.validators.length;
    const totalValidators = this.validators.size;

    // Check quorum size
    if (availableValidators < this.config.minimumQuorumSize) {
      return false;
    }

    // Check quorum percentage
    const quorumPercentage = (availableValidators / totalValidators) * 100;
    if (quorumPercentage < this.config.minimumQuorumPercentage) {
      return false;
    }

    // Check stake percentage
    const availableStake = majorityPartition.totalStake;
    const totalStake = Array.from(this.validators.values()).reduce(
      (sum, v) => sum + v.stake,
      BigInt(0)
    );

    const stakePercentage =
      totalStake > BigInt(0)
        ? Number((availableStake * BigInt(100)) / totalStake)
        : 0;

    return stakePercentage >= this.config.minimumStakePercentage;
  }

  /**
   * Get available validators in topology
   */
  private getAvailableValidators(topology: PartitionTopology): string[] {
    const majorityPartition = topology.partitions.find((p) => p.isMajority);
    return majorityPartition?.validators || [];
  }

  /**
   * Calculate conflict severity
   */
  private calculateConflictSeverity(
    states: BlockchainState[]
  ): 'minor' | 'major' | 'critical' {
    // Critical if more than 2 competing states
    if (states.length > 2) return 'critical';

    // Major if states have different validator sets
    const validatorSets = states.map((s) =>
      s.validatorSet.slice().sort().join(',')
    );
    const uniqueSets = new Set(validatorSets);
    if (uniqueSets.size > 1) return 'major';

    // Minor if just different state roots
    return 'minor';
  }

  /**
   * Extract affected validators from conflicting states
   */
  private extractAffectedValidators(states: BlockchainState[]): string[] {
    const allValidators = new Set<string>();
    for (const state of states) {
      state.validatorSet.forEach((v) => allValidators.add(v));
    }
    return Array.from(allValidators);
  }

  /**
   * Determine resolution strategy
   */
  private determineResolutionStrategy(
    severity: 'minor' | 'major' | 'critical'
  ): 'rollback' | 'merge' | 'halt' {
    if (severity === 'critical') return 'halt';
    if (severity === 'major') return 'rollback';
    return 'merge';
  }

  /**
   * Halt consensus
   */
  private haltConsensus(reason: string): void {
    if (!this.consensusAllowed) return;

    blockchainLogger.error('HALTING CONSENSUS', {
      module: 'SplitBrainPrevention',
      reason
    });

    this.consensusAllowed = false;
    this.blockProductionAllowed = false;

    this.emit('consensus_halted', { reason });
  }

  /**
   * Resume consensus
   */
  private resumeConsensus(): void {
    if (this.consensusAllowed) return;

    blockchainLogger.info('Resuming consensus', { module: 'SplitBrainPrevention' });

    this.consensusAllowed = true;
    this.blockProductionAllowed = true;

    this.emit('consensus_resumed');
  }

  /**
   * Clean up old states
   */
  private cleanupOldStates(beforeHeight: number): void {
    for (const [key, state] of this.blockchainStates) {
      if (state.blockHeight < beforeHeight) {
        this.blockchainStates.delete(key);
      }
    }

    // Clean up old votes
    for (const [height] of this.quorumVotes) {
      if (height < beforeHeight) {
        this.quorumVotes.delete(height);
      }
    }
  }

  /**
   * Register validator
   */
  registerValidator(validatorId: string, stake: bigint): void {
    this.validators.set(validatorId, { stake, online: true });
    blockchainLogger.info('Registered validator', {
      module: 'SplitBrainPrevention',
      validatorId,
      stake: stake.toString()
    });
  }

  /**
   * Update validator online status
   */
  updateValidatorStatus(validatorId: string, online: boolean): void {
    const validator = this.validators.get(validatorId);
    if (validator) {
      validator.online = online;
    }
  }

  /**
   * Get split-brain prevention status
   */
  getStatus(): {
    consensusAllowed: boolean;
    blockProductionAllowed: boolean;
    activeConflicts: number;
    isolatedValidators: number;
    splitBrainDetections: number;
  } {
    return {
      consensusAllowed: this.consensusAllowed,
      blockProductionAllowed: this.blockProductionAllowed,
      activeConflicts: this.conflictingStates.size,
      isolatedValidators: this.validatorIsolation.size,
      splitBrainDetections: this.splitBrainDetections.length,
    };
  }

  /**
   * Get conflicting states
   */
  getConflictingStates(): ConflictingState[] {
    return Array.from(this.conflictingStates.values());
  }

  /**
   * Get isolated validators
   */
  getIsolatedValidators(): ValidatorIsolation[] {
    return Array.from(this.validatorIsolation.values());
  }
}
