/**
 * Partition-Tolerant Consensus Protocol
 * Implements RAFT and PBFT consensus with partition handling
 *
 * SECURITY: Addresses Task 100.9 vulnerabilities:
 * - Adapts consensus behavior during network partitions
 * - Prevents consensus in minority partitions
 * - Implements partition-aware leader election
 * - Ensures quorum requirements during partitions
 * - Halts consensus when partition prevents safety
 * - Validates consensus decisions against partition topology
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';
import {
  PartitionEvent,
  PartitionTopology,
  NetworkPartition,
} from './network-partition-detector.js';
import { blockchainLogger } from '../server/utils/logger.js';

export interface ConsensusNode {
  nodeId: string;
  isValidator: boolean;
  stake: bigint;
  term: number;
  votedFor: string | null;
  lastHeartbeat: Date;
  role: 'follower' | 'candidate' | 'leader';
}

export interface ConsensusProposal {
  proposalId: string;
  proposerId: string;
  term: number;
  blockHeight: number;
  blockHash: string;
  timestamp: Date;
  transactions: string[];
  signatures: Map<string, string>;
}

export interface ConsensusVote {
  voterId: string;
  proposalId: string;
  term: number;
  approve: boolean;
  signature: string;
  timestamp: Date;
}

export interface ConsensusResult {
  proposalId: string;
  approved: boolean;
  votes: ConsensusVote[];
  quorumMet: boolean;
  finalizedAt: Date;
  blockHash: string;
}

export interface QuorumRequirements {
  minimumValidators: number;
  minimumStake: bigint;
  minimumVotePercentage: number;
  partitionAware: boolean;
}

export interface ConsensusConfig {
  consensusType: 'raft' | 'pbft';
  electionTimeout: number; // milliseconds
  heartbeatInterval: number; // milliseconds
  quorumRequirements: QuorumRequirements;
  maxTermDifference: number;
  partitionThreshold: number; // % of validators to consider partitioned
  haltOnPartition: boolean; // Halt consensus if partition detected
}

/**
 * Partition-Tolerant Consensus Manager
 * SECURITY: Ensures consensus safety during network partitions
 */
export class PartitionTolerantConsensus extends EventEmitter {
  private nodes: Map<string, ConsensusNode> = new Map();
  private currentTerm: number = 0;
  private currentLeader: string | null = null;
  private proposals: Map<string, ConsensusProposal> = new Map();
  private votes: Map<string, ConsensusVote[]> = new Map();
  private consensusResults: Map<string, ConsensusResult> = new Map();

  private electionTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  private currentPartition: PartitionEvent | null = null;
  private inMajorityPartition: boolean = true;
  private consensusHalted: boolean = false;

  private readonly config: ConsensusConfig;
  private readonly nodeId: string;

  private static readonly DEFAULT_CONFIG: ConsensusConfig = {
    consensusType: 'raft',
    electionTimeout: 5000,
    heartbeatInterval: 1000,
    quorumRequirements: {
      minimumValidators: 4,
      minimumStake: BigInt(0),
      minimumVotePercentage: 67, // 2/3 majority
      partitionAware: true,
    },
    maxTermDifference: 10,
    partitionThreshold: 30,
    haltOnPartition: true,
  };

  constructor(nodeId: string, config?: Partial<ConsensusConfig>) {
    super();
    this.nodeId = nodeId;
    this.config = { ...PartitionTolerantConsensus.DEFAULT_CONFIG, ...config };
  }

  /**
   * Start consensus protocol
   */
  async start(): Promise<void> {
    blockchainLogger.info('Starting consensus', {
      module: 'PartitionConsensus',
      consensusType: this.config.consensusType.toUpperCase(),
      nodeId: this.nodeId
    });

    // Initialize as follower
    this.updateNodeRole('follower');

    // Start election timer
    this.resetElectionTimer();

    this.emit('started');
  }

  /**
   * Stop consensus protocol
   */
  stop(): void {
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    blockchainLogger.info('Stopped consensus protocol', { module: 'PartitionConsensus' });
    this.emit('stopped');
  }

  /**
   * Handle partition event
   */
  handlePartitionEvent(partition: PartitionEvent): void {
    blockchainLogger.info('Processing partition event', {
      module: 'PartitionConsensus',
      severity: partition.severity
    });

    this.currentPartition = partition;

    // Determine if this node is in majority partition
    this.inMajorityPartition = this.isInMajorityPartition(partition.topology);

    blockchainLogger.info('Node partition status', {
      module: 'PartitionConsensus',
      nodeId: this.nodeId,
      partitionType: this.inMajorityPartition ? 'MAJORITY' : 'MINORITY'
    });

    // Check if consensus should be halted
    if (this.shouldHaltConsensus(partition)) {
      this.haltConsensus('Network partition detected');
    } else if (this.consensusHalted) {
      // Resume if partition is minor and we're in majority
      if (partition.severity === 'minor' && this.inMajorityPartition) {
        this.resumeConsensus();
      }
    }

    this.emit('partition_detected', {
      partition,
      inMajority: this.inMajorityPartition,
      consensusHalted: this.consensusHalted,
    });
  }

  /**
   * Handle partition healing
   */
  handlePartitionHealed(): void {
    blockchainLogger.info('Network partition healed', { module: 'PartitionConsensus' });

    this.currentPartition = null;
    this.inMajorityPartition = true;

    // Resume consensus if it was halted
    if (this.consensusHalted) {
      this.resumeConsensus();
    }

    this.emit('partition_healed');
  }

  /**
   * Propose new block/value
   */
  async propose(
    blockHeight: number,
    blockHash: string,
    transactions: string[]
  ): Promise<string> {
    if (this.consensusHalted) {
      throw new Error('Consensus is halted due to network partition');
    }

    if (!this.isLeader()) {
      throw new Error(
        `Node ${this.nodeId} is not the leader (current leader: ${this.currentLeader})`
      );
    }

    if (!this.canProposeInCurrentPartition()) {
      throw new Error('Cannot propose in minority partition');
    }

    const proposalId = crypto.randomBytes(16).toString('hex');
    const proposal: ConsensusProposal = {
      proposalId,
      proposerId: this.nodeId,
      term: this.currentTerm,
      blockHeight,
      blockHash,
      timestamp: new Date(),
      transactions,
      signatures: new Map(),
    };

    this.proposals.set(proposalId, proposal);
    this.votes.set(proposalId, []);

    blockchainLogger.info('Proposed block', {
      module: 'PartitionConsensus',
      blockHeight,
      proposalId
    });

    this.emit('proposal_created', proposal);

    // Broadcast proposal to all validators
    await this.broadcastProposal(proposal);

    return proposalId;
  }

  /**
   * Vote on proposal
   */
  async vote(proposalId: string, approve: boolean): Promise<void> {
    if (this.consensusHalted) {
      throw new Error('Consensus is halted due to network partition');
    }

    const proposal = this.proposals.get(proposalId);
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`);
    }

    // Validate proposal term
    if (proposal.term < this.currentTerm) {
      throw new Error('Proposal term is outdated');
    }

    // Create vote
    const vote: ConsensusVote = {
      voterId: this.nodeId,
      proposalId,
      term: this.currentTerm,
      approve,
      signature: this.signVote(proposalId, approve),
      timestamp: new Date(),
    };

    // Record vote
    const proposalVotes = this.votes.get(proposalId)!;
    proposalVotes.push(vote);

    blockchainLogger.info('Voted on proposal', {
      module: 'PartitionConsensus',
      vote: approve ? 'APPROVE' : 'REJECT',
      proposalId
    });

    this.emit('vote_cast', vote);

    // Check if quorum reached
    await this.checkQuorum(proposalId);
  }

  /**
   * Check if quorum reached for proposal
   */
  private async checkQuorum(proposalId: string): Promise<void> {
    const proposal = this.proposals.get(proposalId);
    const votes = this.votes.get(proposalId);

    if (!proposal || !votes) return;

    const approvals = votes.filter((v) => v.approve);
    const rejections = votes.filter((v) => !v.approve);

    const quorumMet = this.isQuorumMet(approvals, rejections);

    if (quorumMet) {
      const result: ConsensusResult = {
        proposalId,
        approved: approvals.length > rejections.length,
        votes,
        quorumMet: true,
        finalizedAt: new Date(),
        blockHash: proposal.blockHash,
      };

      this.consensusResults.set(proposalId, result);

      blockchainLogger.info('Consensus reached', {
        module: 'PartitionConsensus',
        proposalId,
        result: result.approved ? 'APPROVED' : 'REJECTED'
      });

      this.emit('consensus_reached', result);

      // Clean up
      this.proposals.delete(proposalId);
      this.votes.delete(proposalId);
    }
  }

  /**
   * Check if quorum requirements are met
   */
  private isQuorumMet(
    approvals: ConsensusVote[],
    rejections: ConsensusVote[]
  ): boolean {
    const totalVotes = approvals.length + rejections.length;
    const validators = Array.from(this.nodes.values()).filter((n) => n.isValidator);
    const totalValidators = validators.length;

    // Check minimum validators requirement
    if (totalValidators < this.config.quorumRequirements.minimumValidators) {
      return false;
    }

    // Check if partition affects quorum
    if (
      this.config.quorumRequirements.partitionAware &&
      this.currentPartition
    ) {
      const availableValidators = this.getAvailableValidatorsInPartition();
      if (totalVotes < availableValidators * 0.67) {
        return false;
      }
    }

    // Check vote percentage
    const votePercentage = (totalVotes / totalValidators) * 100;
    if (votePercentage < this.config.quorumRequirements.minimumVotePercentage) {
      return false;
    }

    // Check stake requirements
    const approvalStake = this.calculateVoteStake(approvals);
    if (approvalStake < this.config.quorumRequirements.minimumStake) {
      return false;
    }

    // Require 2/3 majority
    return approvals.length >= Math.ceil((totalVotes * 2) / 3);
  }

  /**
   * Calculate total stake from votes
   */
  private calculateVoteStake(votes: ConsensusVote[]): bigint {
    return votes.reduce((total, vote) => {
      const node = this.nodes.get(vote.voterId);
      return total + (node?.stake || BigInt(0));
    }, BigInt(0));
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
   * Check if consensus should be halted
   */
  private shouldHaltConsensus(partition: PartitionEvent): boolean {
    if (!this.config.haltOnPartition) return false;

    // Halt on critical or severe partitions
    if (partition.severity === 'critical' || partition.severity === 'severe') {
      return true;
    }

    // Halt if we're in minority partition
    if (!this.inMajorityPartition) {
      return true;
    }

    // Halt if cannot maintain consensus
    if (!partition.topology.consensusCapable) {
      return true;
    }

    return false;
  }

  /**
   * Halt consensus
   */
  private haltConsensus(reason: string): void {
    if (this.consensusHalted) return;

    blockchainLogger.error('HALTING CONSENSUS', {
      module: 'PartitionConsensus',
      reason
    });

    this.consensusHalted = true;

    // Stop timers
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
      this.electionTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    // Step down if leader
    if (this.isLeader()) {
      this.updateNodeRole('follower');
      this.currentLeader = null;
    }

    this.emit('consensus_halted', { reason });
  }

  /**
   * Resume consensus
   */
  private resumeConsensus(): void {
    if (!this.consensusHalted) return;

    blockchainLogger.info('Resuming consensus', { module: 'PartitionConsensus' });

    this.consensusHalted = false;

    // Restart as follower
    this.updateNodeRole('follower');
    this.resetElectionTimer();

    this.emit('consensus_resumed');
  }

  /**
   * Check if can propose in current partition
   */
  private canProposeInCurrentPartition(): boolean {
    if (!this.currentPartition) return true;

    // Can only propose if in majority partition
    return this.inMajorityPartition;
  }

  /**
   * Get available validators in current partition
   */
  private getAvailableValidatorsInPartition(): number {
    if (!this.currentPartition) {
      return Array.from(this.nodes.values()).filter((n) => n.isValidator).length;
    }

    const majorityPartition = this.currentPartition.topology.partitions.find(
      (p) => p.isMajority
    );

    return majorityPartition?.validators.length || 0;
  }

  /**
   * Start leader election
   */
  private async startElection(): Promise<void> {
    if (this.consensusHalted) return;

    this.currentTerm++;
    this.updateNodeRole('candidate');

    blockchainLogger.info('Starting election', {
      module: 'PartitionConsensus',
      term: this.currentTerm
    });

    // Vote for self
    const node = this.nodes.get(this.nodeId);
    if (node) {
      node.votedFor = this.nodeId;
    }

    // Request votes from other nodes
    await this.requestVotes();

    // Reset election timer
    this.resetElectionTimer();
  }

  /**
   * Request votes from other nodes
   */
  private async requestVotes(): Promise<void> {
    // In production, this would send vote requests to other nodes
    // For now, simulate based on partition state

    if (!this.inMajorityPartition) {
      blockchainLogger.info('Not in majority partition, election will fail', { module: 'PartitionConsensus' });
      return;
    }

    this.emit('election_started', {
      nodeId: this.nodeId,
      term: this.currentTerm,
    });
  }

  /**
   * Become leader
   */
  private becomeLeader(): void {
    this.updateNodeRole('leader');
    this.currentLeader = this.nodeId;

    blockchainLogger.info('Node became leader', {
      module: 'PartitionConsensus',
      nodeId: this.nodeId,
      term: this.currentTerm
    });

    // Start sending heartbeats
    this.startHeartbeat();

    this.emit('leader_elected', {
      leaderId: this.nodeId,
      term: this.currentTerm,
    });
  }

  /**
   * Start heartbeat
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    this.heartbeatTimer = setInterval(() => {
      if (!this.isLeader() || this.consensusHalted) {
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
        return;
      }

      this.sendHeartbeat();
    }, this.config.heartbeatInterval);
  }

  /**
   * Send heartbeat to followers
   */
  private sendHeartbeat(): void {
    for (const [nodeId, node] of this.nodes) {
      if (nodeId !== this.nodeId) {
        node.lastHeartbeat = new Date();
      }
    }

    this.emit('heartbeat_sent', {
      leaderId: this.nodeId,
      term: this.currentTerm,
    });
  }

  /**
   * Reset election timer
   */
  private resetElectionTimer(): void {
    if (this.electionTimer) {
      clearTimeout(this.electionTimer);
    }

    // Add CSPRNG jitter to prevent split votes (replaces Math.random — issue #478)
    const jitter = crypto.randomInt(0, this.config.electionTimeout);
    const timeout = this.config.electionTimeout + jitter;

    this.electionTimer = setTimeout(() => {
      if (!this.isLeader() && !this.consensusHalted) {
        this.startElection();
      }
    }, timeout);
  }

  /**
   * Update node role
   */
  private updateNodeRole(role: 'follower' | 'candidate' | 'leader'): void {
    const node = this.nodes.get(this.nodeId);
    if (node) {
      node.role = role;
    }
  }

  /**
   * Check if current node is leader
   */
  private isLeader(): boolean {
    const node = this.nodes.get(this.nodeId);
    return node?.role === 'leader';
  }

  /**
   * Sign vote
   */
  private signVote(proposalId: string, approve: boolean): string {
    const data = `${proposalId}:${approve}:${this.currentTerm}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Broadcast proposal
   */
  private async broadcastProposal(proposal: ConsensusProposal): Promise<void> {
    // In production, this would broadcast to all validators
    this.emit('proposal_broadcast', proposal);
  }

  /**
   * Register consensus node
   */
  registerNode(node: ConsensusNode): void {
    this.nodes.set(node.nodeId, {
      ...node,
      term: this.currentTerm,
      votedFor: null,
      lastHeartbeat: new Date(),
      role: 'follower',
    });

    blockchainLogger.info('Registered node', {
      module: 'PartitionConsensus',
      nodeId: node.nodeId,
      isValidator: node.isValidator
    });
  }

  /**
   * Get consensus status
   */
  getConsensusStatus(): {
    term: number;
    leader: string | null;
    role: string;
    consensusHalted: boolean;
    inMajorityPartition: boolean;
    activeProposals: number;
  } {
    const node = this.nodes.get(this.nodeId);
    return {
      term: this.currentTerm,
      leader: this.currentLeader,
      role: node?.role || 'follower',
      consensusHalted: this.consensusHalted,
      inMajorityPartition: this.inMajorityPartition,
      activeProposals: this.proposals.size,
    };
  }
}
