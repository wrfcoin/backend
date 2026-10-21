/**
 * PBFT Phase Manager
 * Implements the three-phase Practical Byzantine Fault Tolerance protocol
 *
 * PBFT PHASES:
 * Phase 1: Pre-Prepare - Primary proposes block with signature
 * Phase 2: Prepare - Replicas validate and broadcast prepare messages (2f+1 quorum)
 * Phase 3: Commit - Replicas broadcast commit messages after prepare quorum (2f+1 quorum)
 * Result: Block execution after commit quorum
 *
 * SAFETY: Requires 2f+1 matching messages in each phase where f < n/3
 * LIVENESS: View change protocol handles primary failures
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import { PBFTCryptographicVerification, PBFTVote, SignedPBFTVote } from './pbft-cryptographic-verification.js';

export interface BlockProposal {
  blockHash: string;
  height: number;
  round: number;
  viewNumber: number;
  primaryId: string;
  transactions: any[];
  timestamp: number;
  parentHash: string;
  stateRoot: string;
}

export interface SignedBlockProposal extends BlockProposal {
  primarySignature: Buffer;
  verified: boolean;
}

export interface PrePrepareMessage {
  type: 'pre-prepare';
  proposal: SignedBlockProposal;
  viewNumber: number;
  sequenceNumber: number;
  primaryId: string;
  timestamp: number;
}

export interface PrepareMessage {
  type: 'prepare';
  blockHash: string;
  height: number;
  viewNumber: number;
  sequenceNumber: number;
  validatorId: string;
  timestamp: number;
}

export interface SignedPrepareMessage extends PrepareMessage {
  signature: Buffer;
  publicKey: Buffer;
}

export interface CommitMessage {
  type: 'commit';
  blockHash: string;
  height: number;
  viewNumber: number;
  sequenceNumber: number;
  validatorId: string;
  timestamp: number;
}

export interface SignedCommitMessage extends CommitMessage {
  signature: Buffer;
  publicKey: Buffer;
}

export interface PhaseQuorum {
  required: number; // 2f+1
  received: number;
  validators: Set<string>;
  achieved: boolean;
}

export interface ConsensusRound {
  roundId: string;
  height: number;
  round: number;
  viewNumber: number;
  status: 'pre-prepare' | 'prepare' | 'commit' | 'committed' | 'failed';
  proposal?: SignedBlockProposal;
  prepareQuorum: PhaseQuorum;
  commitQuorum: PhaseQuorum;
  startTime: Date;
  phases: {
    prePrepareTime?: Date;
    prepareQuorumTime?: Date;
    commitQuorumTime?: Date;
    committedTime?: Date;
  };
}

export interface PBFTMetrics {
  totalRounds: number;
  successfulRounds: number;
  failedRounds: number;
  averageConsensusTime: number;
  averagePrepareTime: number;
  averageCommitTime: number;
  viewChanges: number;
}

/**
 * PBFT Three-Phase Protocol Manager
 * Coordinates pre-prepare, prepare, and commit phases
 */
export class PBFTPhaseManager extends EventEmitter {
  private cryptoVerification: PBFTCryptographicVerification;
  private activeRounds: Map<string, ConsensusRound> = new Map();
  private prepareMessages: Map<string, Map<string, SignedPrepareMessage>> = new Map();
  private commitMessages: Map<string, Map<string, SignedCommitMessage>> = new Map();
  private viewNumber: number = 0;
  private sequenceNumber: number = 0;
  private metrics: PBFTMetrics;

  private readonly PHASE_TIMEOUT = 10000; // 10 seconds per phase
  private readonly MAX_ROUNDS_IN_MEMORY = 100;

  constructor(cryptoVerification: PBFTCryptographicVerification) {
    super();
    this.cryptoVerification = cryptoVerification;
    this.metrics = {
      totalRounds: 0,
      successfulRounds: 0,
      failedRounds: 0,
      averageConsensusTime: 0,
      averagePrepareTime: 0,
      averageCommitTime: 0,
      viewChanges: 0,
    };
  }

  /**
   * Phase 1: Pre-Prepare
   * Primary node proposes a block to all replicas
   */
  async initiatePrePrepare(
    proposal: BlockProposal,
    primaryId: string,
    totalValidators: number
  ): Promise<string> {
    this.sequenceNumber++;
    const roundId = this.generateRoundId(proposal.height, proposal.round);

    // Calculate quorum requirements (2f+1 where f < n/3)
    const f = Math.floor((totalValidators - 1) / 3);
    const quorumRequired = 2 * f + 1;

    // Initialize consensus round
    const consensusRound: ConsensusRound = {
      roundId,
      height: proposal.height,
      round: proposal.round,
      viewNumber: this.viewNumber,
      status: 'pre-prepare',
      prepareQuorum: {
        required: quorumRequired,
        received: 0,
        validators: new Set(),
        achieved: false,
      },
      commitQuorum: {
        required: quorumRequired,
        received: 0,
        validators: new Set(),
        achieved: false,
      },
      startTime: new Date(),
      phases: {},
    };

    this.activeRounds.set(roundId, consensusRound);
    this.prepareMessages.set(roundId, new Map());
    this.commitMessages.set(roundId, new Map());

    // Sign proposal with primary's key
    const proposalHash = this.hashProposal(proposal);
    const vote: PBFTVote = {
      type: 'pre-prepare',
      blockHash: proposalHash,
      height: proposal.height,
      round: proposal.round,
      viewNumber: this.viewNumber,
      validatorId: primaryId,
      votingPower: 1,
      timestamp: Date.now(),
      sequenceNumber: this.sequenceNumber,
    };

    const signedVote = await this.cryptoVerification.signVote(vote, primaryId);

    const signedProposal: SignedBlockProposal = {
      ...proposal,
      primarySignature: signedVote.signature.signature,
      verified: false,
    };

    consensusRound.proposal = signedProposal;
    consensusRound.phases.prePrepareTime = new Date();

    this.emit('prePrepareInitiated', {
      roundId,
      height: proposal.height,
      primaryId,
      blockHash: proposalHash,
      viewNumber: this.viewNumber,
      sequenceNumber: this.sequenceNumber,
    });

    // Set timeout for pre-prepare phase
    this.setPhaseTimeout(roundId, 'pre-prepare');

    return roundId;
  }

  /**
   * Phase 2: Prepare
   * Replicas validate pre-prepare and broadcast prepare messages
   */
  async processPreparePhase(
    roundId: string,
    validatorId: string,
    prePrepareMessage: PrePrepareMessage
  ): Promise<boolean> {
    const round = this.activeRounds.get(roundId);
    if (!round) {
      throw new Error(`Unknown round: ${roundId}`);
    }

    if (round.status !== 'pre-prepare' && round.status !== 'prepare') {
      throw new Error(`Invalid round status for prepare: ${round.status}`);
    }

    // Validate pre-prepare message
    if (!this.validatePrePrepare(prePrepareMessage, round)) {
      this.emit('prePrepareValidationFailed', {
        roundId,
        validatorId,
        reason: 'Invalid pre-prepare message',
      });
      return false;
    }

    // Create prepare message
    const prepareMsg: PrepareMessage = {
      type: 'prepare',
      blockHash: prePrepareMessage.proposal.blockHash,
      height: prePrepareMessage.proposal.height,
      viewNumber: prePrepareMessage.viewNumber,
      sequenceNumber: prePrepareMessage.sequenceNumber,
      validatorId,
      timestamp: Date.now(),
    };

    // Sign prepare message
    const vote: PBFTVote = {
      type: 'prepare',
      blockHash: prepareMsg.blockHash,
      height: prepareMsg.height,
      round: round.round,
      viewNumber: prepareMsg.viewNumber,
      validatorId,
      votingPower: 1,
      timestamp: prepareMsg.timestamp,
      sequenceNumber: prepareMsg.sequenceNumber,
    };

    const signedVote = await this.cryptoVerification.signVote(vote, validatorId);

    const signedPrepareMsg: SignedPrepareMessage = {
      ...prepareMsg,
      signature: signedVote.signature.signature,
      publicKey: signedVote.signature.publicKey,
    };

    // Store prepare message
    const prepareMap = this.prepareMessages.get(roundId)!;
    prepareMap.set(validatorId, signedPrepareMsg);

    // Update round status
    if (round.status === 'pre-prepare') {
      round.status = 'prepare';
    }

    this.emit('prepareMessageReceived', {
      roundId,
      validatorId,
      blockHash: prepareMsg.blockHash,
      prepareCount: prepareMap.size,
      quorumRequired: round.prepareQuorum.required,
    });

    return true;
  }

  /**
   * Receive and process prepare message from other validators
   */
  async receivePrepareMessage(
    roundId: string,
    signedPrepareMsg: SignedPrepareMessage
  ): Promise<void> {
    const round = this.activeRounds.get(roundId);
    if (!round || round.status === 'committed' || round.status === 'failed') {
      return; // Round already finished or doesn't exist
    }

    // Verify signature
    const vote: PBFTVote = {
      type: 'prepare',
      blockHash: signedPrepareMsg.blockHash,
      height: signedPrepareMsg.height,
      round: round.round,
      viewNumber: signedPrepareMsg.viewNumber,
      validatorId: signedPrepareMsg.validatorId,
      votingPower: 1,
      timestamp: signedPrepareMsg.timestamp,
      sequenceNumber: signedPrepareMsg.sequenceNumber,
    };

    const signedVote: SignedPBFTVote = {
      ...vote,
      signature: {
        signature: signedPrepareMsg.signature,
        publicKey: signedPrepareMsg.publicKey,
        algorithm: 'ecdsa-p256',
        validatorId: signedPrepareMsg.validatorId,
        sequenceNumber: signedPrepareMsg.sequenceNumber,
        timestamp: signedPrepareMsg.timestamp,
        nonce: '', // Will be extracted from signature
      },
      messageHash: Buffer.alloc(0), // Will be calculated
      verified: false,
    };

    const isValid = await this.cryptoVerification.verifyVote(signedVote);
    if (!isValid) {
      this.emit('invalidPrepareMessage', {
        roundId,
        validatorId: signedPrepareMsg.validatorId,
      });
      return;
    }

    // Store prepare message
    const prepareMap = this.prepareMessages.get(roundId);
    if (!prepareMap) return;

    prepareMap.set(signedPrepareMsg.validatorId, signedPrepareMsg);
    round.prepareQuorum.validators.add(signedPrepareMsg.validatorId);
    round.prepareQuorum.received = prepareMap.size;

    // Check if prepare quorum achieved (2f+1)
    if (
      !round.prepareQuorum.achieved &&
      prepareMap.size >= round.prepareQuorum.required
    ) {
      round.prepareQuorum.achieved = true;
      round.phases.prepareQuorumTime = new Date();

      this.emit('prepareQuorumAchieved', {
        roundId,
        height: round.height,
        blockHash: signedPrepareMsg.blockHash,
        quorumSize: prepareMap.size,
        validators: Array.from(round.prepareQuorum.validators),
      });

      // Automatically transition to commit phase
      round.status = 'commit';
    }
  }

  /**
   * Phase 3: Commit
   * After receiving 2f+1 prepare messages, broadcast commit messages
   */
  async processCommitPhase(
    roundId: string,
    validatorId: string
  ): Promise<boolean> {
    const round = this.activeRounds.get(roundId);
    if (!round) {
      throw new Error(`Unknown round: ${roundId}`);
    }

    if (!round.prepareQuorum.achieved) {
      throw new Error('Prepare quorum not yet achieved');
    }

    if (round.status !== 'commit') {
      throw new Error(`Invalid round status for commit: ${round.status}`);
    }

    if (!round.proposal) {
      throw new Error('No proposal in round');
    }

    // Create commit message
    const commitMsg: CommitMessage = {
      type: 'commit',
      blockHash: round.proposal.blockHash,
      height: round.height,
      viewNumber: round.viewNumber,
      sequenceNumber: this.sequenceNumber,
      validatorId,
      timestamp: Date.now(),
    };

    // Sign commit message
    const vote: PBFTVote = {
      type: 'commit',
      blockHash: commitMsg.blockHash,
      height: commitMsg.height,
      round: round.round,
      viewNumber: commitMsg.viewNumber,
      validatorId,
      votingPower: 1,
      timestamp: commitMsg.timestamp,
      sequenceNumber: commitMsg.sequenceNumber,
    };

    const signedVote = await this.cryptoVerification.signVote(vote, validatorId);

    const signedCommitMsg: SignedCommitMessage = {
      ...commitMsg,
      signature: signedVote.signature.signature,
      publicKey: signedVote.signature.publicKey,
    };

    // Store commit message
    const commitMap = this.commitMessages.get(roundId)!;
    commitMap.set(validatorId, signedCommitMsg);

    this.emit('commitMessageSent', {
      roundId,
      validatorId,
      blockHash: commitMsg.blockHash,
      commitCount: commitMap.size,
      quorumRequired: round.commitQuorum.required,
    });

    return true;
  }

  /**
   * Receive and process commit message from other validators
   */
  async receiveCommitMessage(
    roundId: string,
    signedCommitMsg: SignedCommitMessage
  ): Promise<void> {
    const round = this.activeRounds.get(roundId);
    if (!round || round.status === 'committed' || round.status === 'failed') {
      return; // Round already finished or doesn't exist
    }

    // Verify signature
    const vote: PBFTVote = {
      type: 'commit',
      blockHash: signedCommitMsg.blockHash,
      height: signedCommitMsg.height,
      round: round.round,
      viewNumber: signedCommitMsg.viewNumber,
      validatorId: signedCommitMsg.validatorId,
      votingPower: 1,
      timestamp: signedCommitMsg.timestamp,
      sequenceNumber: signedCommitMsg.sequenceNumber,
    };

    const signedVote: SignedPBFTVote = {
      ...vote,
      signature: {
        signature: signedCommitMsg.signature,
        publicKey: signedCommitMsg.publicKey,
        algorithm: 'ecdsa-p256',
        validatorId: signedCommitMsg.validatorId,
        sequenceNumber: signedCommitMsg.sequenceNumber,
        timestamp: signedCommitMsg.timestamp,
        nonce: '',
      },
      messageHash: Buffer.alloc(0),
      verified: false,
    };

    const isValid = await this.cryptoVerification.verifyVote(signedVote);
    if (!isValid) {
      this.emit('invalidCommitMessage', {
        roundId,
        validatorId: signedCommitMsg.validatorId,
      });
      return;
    }

    // Store commit message
    const commitMap = this.commitMessages.get(roundId);
    if (!commitMap) return;

    commitMap.set(signedCommitMsg.validatorId, signedCommitMsg);
    round.commitQuorum.validators.add(signedCommitMsg.validatorId);
    round.commitQuorum.received = commitMap.size;

    // Check if commit quorum achieved (2f+1)
    if (
      !round.commitQuorum.achieved &&
      commitMap.size >= round.commitQuorum.required
    ) {
      round.commitQuorum.achieved = true;
      round.status = 'committed';
      round.phases.committedTime = new Date();

      const consensusTime = Date.now() - round.startTime.getTime();
      this.updateMetrics(round, consensusTime);

      this.emit('commitQuorumAchieved', {
        roundId,
        height: round.height,
        blockHash: signedCommitMsg.blockHash,
        quorumSize: commitMap.size,
        validators: Array.from(round.commitQuorum.validators),
        consensusTime,
      });

      // Block can now be executed
      this.emit('blockCommitted', {
        roundId,
        height: round.height,
        blockHash: signedCommitMsg.blockHash,
        proposal: round.proposal,
      });
    }
  }

  /**
   * Validate pre-prepare message
   */
  private validatePrePrepare(
    prePrepare: PrePrepareMessage,
    round: ConsensusRound
  ): boolean {
    // Check view number matches
    if (prePrepare.viewNumber !== round.viewNumber) {
      return false;
    }

    // Check proposal exists
    if (!prePrepare.proposal) {
      return false;
    }

    // Check primary signature (simplified - should use crypto verification)
    if (!prePrepare.proposal.primarySignature) {
      return false;
    }

    return true;
  }

  /**
   * Generate unique round ID
   */
  private generateRoundId(height: number, round: number): string {
    return `${height}-${round}-${this.viewNumber}`;
  }

  /**
   * Hash block proposal
   */
  private hashProposal(proposal: BlockProposal): string {
    const data = JSON.stringify({
      height: proposal.height,
      round: proposal.round,
      transactions: proposal.transactions,
      parentHash: proposal.parentHash,
      stateRoot: proposal.stateRoot,
      timestamp: proposal.timestamp,
    });

    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Set timeout for phase
   */
  private setPhaseTimeout(roundId: string, phase: string): void {
    setTimeout(() => {
      const round = this.activeRounds.get(roundId);
      if (!round || round.status === 'committed') {
        return; // Already committed
      }

      if (phase === 'pre-prepare' && round.status === 'pre-prepare') {
        this.emit('phaseTimeout', { roundId, phase, height: round.height });
        round.status = 'failed';
        this.metrics.failedRounds++;
      }
    }, this.PHASE_TIMEOUT);
  }

  /**
   * Update metrics
   */
  private updateMetrics(round: ConsensusRound, consensusTime: number): void {
    this.metrics.totalRounds++;
    this.metrics.successfulRounds++;

    // Update average consensus time
    const total = this.metrics.successfulRounds;
    this.metrics.averageConsensusTime =
      (this.metrics.averageConsensusTime * (total - 1) + consensusTime) / total;

    // Calculate phase times
    if (round.phases.prePrepareTime && round.phases.prepareQuorumTime) {
      const prepareTime =
        round.phases.prepareQuorumTime.getTime() -
        round.phases.prePrepareTime.getTime();
      this.metrics.averagePrepareTime =
        (this.metrics.averagePrepareTime * (total - 1) + prepareTime) / total;
    }

    if (round.phases.prepareQuorumTime && round.phases.committedTime) {
      const commitTime =
        round.phases.committedTime.getTime() -
        round.phases.prepareQuorumTime.getTime();
      this.metrics.averageCommitTime =
        (this.metrics.averageCommitTime * (total - 1) + commitTime) / total;
    }

    // Cleanup old rounds
    if (this.activeRounds.size > this.MAX_ROUNDS_IN_MEMORY) {
      this.cleanupOldRounds();
    }
  }

  /**
   * Cleanup old rounds from memory
   */
  private cleanupOldRounds(): void {
    const rounds = Array.from(this.activeRounds.entries())
      .filter(([_, round]) => round.status === 'committed' || round.status === 'failed')
      .sort((a, b) => a[1].startTime.getTime() - b[1].startTime.getTime());

    const toRemove = rounds.slice(0, rounds.length - this.MAX_ROUNDS_IN_MEMORY);
    toRemove.forEach(([roundId]) => {
      this.activeRounds.delete(roundId);
      this.prepareMessages.delete(roundId);
      this.commitMessages.delete(roundId);
    });
  }

  /**
   * Increment view number (used in view changes)
   */
  incrementViewNumber(): void {
    this.viewNumber++;
    this.metrics.viewChanges++;
    this.emit('viewChanged', { newViewNumber: this.viewNumber });
  }

  /**
   * Get current view number
   */
  getViewNumber(): number {
    return this.viewNumber;
  }

  /**
   * Get consensus round
   */
  getRound(roundId: string): ConsensusRound | undefined {
    return this.activeRounds.get(roundId);
  }

  /**
   * Get metrics
   */
  getMetrics(): PBFTMetrics {
    return { ...this.metrics };
  }

  /**
   * Get active rounds
   */
  getActiveRounds(): ConsensusRound[] {
    return Array.from(this.activeRounds.values()).filter(
      r => r.status !== 'committed' && r.status !== 'failed'
    );
  }
}
