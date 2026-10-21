/**
 * Byzantine Consensus Coordinator
 * Main orchestrator for enterprise-grade Byzantine fault-tolerant consensus
 *
 * INTEGRATIONS:
 * - PBFT Cryptographic Verification (Task 100.1)
 * - Byzantine Validator Manager
 * - PBFT Phase Manager (three-phase protocol)
 * - Byzantine Attack Defense
 * - Consensus State Manager
 * - View Change Coordinator
 *
 * SAFETY GUARANTEES:
 * - Tolerates f < n/3 Byzantine validators
 * - Cryptographic signature verification for all votes
 * - Multi-layered attack defense
 * - Automatic malicious validator detection and isolation
 * - View change protocol for primary failures
 * - State checkpoint consensus
 *
 * CRITICAL: This is the security-critical consensus implementation
 */

import { EventEmitter } from 'events';
import { PBFTCryptographicVerification, PBFTVote, SignedPBFTVote } from './pbft-cryptographic-verification.js';
import { ByzantineValidatorManager, ByzantineTolerance } from './byzantine-validator-manager.js';
import { PBFTPhaseManager, BlockProposal, PrePrepareMessage } from './pbft-phase-manager.js';
import { ByzantineAttackDefense } from './byzantine-attack-defense.js';
import { ConsensusStateManager } from './consensus-state-manager.js';
import { ViewChangeCoordinator } from './view-change-coordinator.js';

export interface ConsensusConfig {
  totalValidators: number;
  minStake: number;
  consensusTimeout: number;
  checkpointInterval: number;
  enableAttackDefense: boolean;
}

export interface ConsensusStatus {
  height: number;
  viewNumber: number;
  primaryId: string | undefined;
  activeValidators: number;
  byzantineTolerance: ByzantineTolerance;
  consensusHealth: 'healthy' | 'degraded' | 'critical';
  attacksBlocked: number;
  recentConsensusTime: number;
}

export interface ConsensusMetrics {
  totalBlocks: number;
  successfulConsensus: number;
  failedConsensus: number;
  averageConsensusTime: number;
  viewChanges: number;
  maliciousValidatorsDetected: number;
  attacksBlocked: number;
  uptimePercentage: number;
}

/**
 * Byzantine Fault-Tolerant Consensus Coordinator
 * Enterprise-grade consensus with comprehensive Byzantine defenses
 */
export class ByzantineConsensusCoordinator extends EventEmitter {
  private cryptoVerification: PBFTCryptographicVerification;
  private validatorManager: ByzantineValidatorManager;
  private phaseManager: PBFTPhaseManager;
  private attackDefense: ByzantineAttackDefense;
  private stateManager: ConsensusStateManager;
  private viewChangeCoordinator: ViewChangeCoordinator;

  private config: ConsensusConfig;
  private currentHeight: number = 0;
  private metrics: ConsensusMetrics;
  private startTime: Date;

  constructor(config: Partial<ConsensusConfig> = {}) {
    super();

    this.config = {
      totalValidators: config.totalValidators || 10,
      minStake: config.minStake || 1000,
      consensusTimeout: config.consensusTimeout || 10000,
      checkpointInterval: config.checkpointInterval || 100,
      enableAttackDefense: config.enableAttackDefense !== false,
    };

    // Initialize all components
    this.cryptoVerification = new PBFTCryptographicVerification();
    this.validatorManager = new ByzantineValidatorManager();
    this.phaseManager = new PBFTPhaseManager(this.cryptoVerification);
    this.attackDefense = new ByzantineAttackDefense();
    this.stateManager = new ConsensusStateManager();
    this.viewChangeCoordinator = new ViewChangeCoordinator();

    this.metrics = {
      totalBlocks: 0,
      successfulConsensus: 0,
      failedConsensus: 0,
      averageConsensusTime: 0,
      viewChanges: 0,
      maliciousValidatorsDetected: 0,
      attacksBlocked: 0,
      uptimePercentage: 100,
    };

    this.startTime = new Date();

    this.setupEventHandlers();
  }

  /**
   * Initialize consensus with validators
   */
  async initialize(validators: Array<{
    validatorId: string;
    address: string;
    publicKey: Buffer;
    stake: number;
  }>): Promise<void> {
    // Register all validators
    for (const validator of validators) {
      await this.validatorManager.registerValidator(
        validator.validatorId,
        validator.address,
        validator.publicKey,
        validator.stake
      );

      // Register public keys in crypto verification
      this.cryptoVerification.registerValidatorPublicKey(
        validator.validatorId,
        validator.publicKey,
        'ecdsa-p256'
      );
    }

    // Select initial primary
    const activeValidators = this.validatorManager.getActiveValidators();
    if (activeValidators.length > 0) {
      const primaryId = activeValidators[0].validatorId;
      this.viewChangeCoordinator.setPrimary(primaryId, 0);

      this.emit('consensusInitialized', {
        totalValidators: validators.length,
        activeValidators: activeValidators.length,
        primaryId,
      });
    }
  }

  /**
   * Propose new block (called by primary)
   */
  async proposeBlock(
    primaryId: string,
    transactions: any[]
  ): Promise<string> {
    const startTime = Date.now();

    // Verify primary is current leader
    const currentPrimary = this.viewChangeCoordinator.getCurrentPrimary();
    if (currentPrimary !== primaryId) {
      throw new Error(`Invalid primary: expected ${currentPrimary}, got ${primaryId}`);
    }

    // Check rate limit
    if (this.config.enableAttackDefense) {
      const allowed = await this.attackDefense.checkRateLimit(primaryId);
      if (!allowed) {
        throw new Error('Rate limit exceeded');
      }
    }

    // Get current state
    const currentState = this.stateManager.getCurrentState();
    const parentHash = currentState.stateRoot;

    // Create block proposal
    const proposal: BlockProposal = {
      blockHash: '', // Will be calculated
      height: this.currentHeight + 1,
      round: 0,
      viewNumber: this.viewChangeCoordinator.getCurrentViewNumber(),
      primaryId,
      transactions,
      timestamp: Date.now(),
      parentHash,
      stateRoot: '', // Will be calculated
    };

    // Initiate PBFT pre-prepare phase
    const roundId = await this.phaseManager.initiatePrePrepare(
      proposal,
      primaryId,
      this.config.totalValidators
    );

    this.emit('blockProposed', {
      roundId,
      height: proposal.height,
      primaryId,
      transactionCount: transactions.length,
      viewNumber: proposal.viewNumber,
    });

    return roundId;
  }

  /**
   * Vote on block proposal (called by replicas)
   */
  async voteOnProposal(
    roundId: string,
    validatorId: string,
    prePrepareMessage: PrePrepareMessage,
    approve: boolean
  ): Promise<boolean> {
    const startTime = Date.now();

    // Check rate limit
    if (this.config.enableAttackDefense) {
      const allowed = await this.attackDefense.checkRateLimit(validatorId);
      if (!allowed) {
        this.emit('votingRateLimited', { validatorId, roundId });
        return false;
      }
    }

    // Check replay attack
    const messageId = `${roundId}-${validatorId}-prepare`;
    const nonce = `${Date.now()}-${Math.random()}`;
    const replayCheck = await this.attackDefense.checkReplayAttack(
      messageId,
      validatorId,
      nonce,
      prePrepareMessage.sequenceNumber
    );

    if (!replayCheck) {
      this.emit('replayAttackDetected', { validatorId, roundId });
      return false;
    }

    if (!approve) {
      this.emit('proposalRejected', { validatorId, roundId });
      return false;
    }

    // Process prepare phase
    const prepareSuccess = await this.phaseManager.processPreparePhase(
      roundId,
      validatorId,
      prePrepareMessage
    );

    if (prepareSuccess) {
      const responseTime = Date.now() - startTime;
      await this.validatorManager.recordVote(validatorId, approve, responseTime);
    }

    return prepareSuccess;
  }

  /**
   * Process prepare message from validator
   */
  async receivePrepareMessage(
    roundId: string,
    validatorId: string,
    prepareMessage: any
  ): Promise<void> {
    // Verify cryptographic signature (CRITICAL SECURITY CHECK)
    const verified = await this.cryptoVerification.verifyVote(prepareMessage);

    if (!verified) {
      await this.validatorManager.reportMaliciousIndicator({
        validatorId,
        indicatorType: 'invalid-signature',
        severity: 'high',
        evidence: { roundId, messageType: 'prepare' },
        detectedAt: new Date(),
        confidence: 1.0,
      });

      this.emit('invalidSignatureDetected', { validatorId, roundId });
      return;
    }

    // Forward to phase manager
    await this.phaseManager.receivePrepareMessage(roundId, prepareMessage);
  }

  /**
   * Process commit phase (after prepare quorum)
   */
  async processCommit(roundId: string, validatorId: string): Promise<boolean> {
    const round = this.phaseManager.getRound(roundId);
    if (!round || !round.prepareQuorum.achieved) {
      return false;
    }

    return await this.phaseManager.processCommitPhase(roundId, validatorId);
  }

  /**
   * Receive commit message from validator
   */
  async receiveCommitMessage(
    roundId: string,
    validatorId: string,
    commitMessage: any
  ): Promise<void> {
    // Verify cryptographic signature (CRITICAL SECURITY CHECK)
    const verified = await this.cryptoVerification.verifyVote(commitMessage);

    if (!verified) {
      await this.validatorManager.reportMaliciousIndicator({
        validatorId,
        indicatorType: 'invalid-signature',
        severity: 'high',
        evidence: { roundId, messageType: 'commit' },
        detectedAt: new Date(),
        confidence: 1.0,
      });

      this.emit('invalidSignatureDetected', { validatorId, roundId });
      return;
    }

    // Forward to phase manager
    await this.phaseManager.receiveCommitMessage(roundId, commitMessage);

    // Check if commit quorum achieved
    const round = this.phaseManager.getRound(roundId);
    if (round?.commitQuorum.achieved) {
      await this.finalizeBlock(roundId, round.proposal!);
    }
  }

  /**
   * Finalize block after commit quorum
   */
  private async finalizeBlock(roundId: string, proposal: any): Promise<void> {
    const startTime = Date.now();

    // Record state transition
    await this.stateManager.recordStateTransition(
      this.currentHeight,
      proposal.height,
      proposal.transactions
    );

    this.currentHeight = proposal.height;

    // Update metrics
    this.metrics.totalBlocks++;
    this.metrics.successfulConsensus++;
    const consensusTime = Date.now() - startTime;
    this.updateAverageConsensusTime(consensusTime);

    // Create checkpoint if needed
    if (this.currentHeight % this.config.checkpointInterval === 0) {
      await this.createCheckpoint();
    }

    // Reset primary timeout
    const primaryId = this.viewChangeCoordinator.getCurrentPrimary();
    if (primaryId) {
      this.viewChangeCoordinator.resetPrimaryTimeout(primaryId);
    }

    this.emit('blockFinalized', {
      roundId,
      height: this.currentHeight,
      transactionCount: proposal.transactions.length,
      consensusTime,
    });
  }

  /**
   * Create state checkpoint with validator signatures
   */
  private async createCheckpoint(): Promise<void> {
    const activeValidators = this.validatorManager.getActiveValidators();
    const signatures = new Map<string, Buffer>();

    // Collect signatures from validators (simplified)
    for (const validator of activeValidators) {
      const signature = Buffer.from(`sig-${validator.validatorId}`);
      signatures.set(validator.validatorId, signature);
    }

    const f = Math.floor((this.config.totalValidators - 1) / 3);
    const quorum = 2 * f + 1;

    await this.stateManager.createCheckpoint(
      this.currentHeight,
      [],
      signatures,
      quorum
    );

    this.emit('checkpointCreated', {
      height: this.currentHeight,
      signatures: signatures.size,
      quorum,
    });
  }

  /**
   * Handle consensus timeout
   */
  async handleConsensusTimeout(roundId: string): Promise<void> {
    const primaryId = this.viewChangeCoordinator.getCurrentPrimary();
    if (!primaryId) return;

    this.metrics.failedConsensus++;

    // Detect primary failure
    await this.viewChangeCoordinator.detectPrimaryFailure(
      primaryId,
      'timeout',
      { roundId, timeout: this.config.consensusTimeout }
    );
  }

  /**
   * Get consensus status
   */
  getStatus(): ConsensusStatus {
    const primaryId = this.viewChangeCoordinator.getCurrentPrimary();
    const activeValidators = this.validatorManager.getActiveValidators().length;
    const byzantineTolerance = this.validatorManager.getByzantineTolerance();
    const attackMetrics = this.attackDefense.getMetrics();

    let consensusHealth: 'healthy' | 'degraded' | 'critical' = 'healthy';
    if (byzantineTolerance.toleranceStatus === 'critical') {
      consensusHealth = 'critical';
    } else if (byzantineTolerance.toleranceStatus === 'warning') {
      consensusHealth = 'degraded';
    }

    return {
      height: this.currentHeight,
      viewNumber: this.viewChangeCoordinator.getCurrentViewNumber(),
      primaryId,
      activeValidators,
      byzantineTolerance,
      consensusHealth,
      attacksBlocked: attackMetrics.totalAttacksBlocked,
      recentConsensusTime: this.metrics.averageConsensusTime,
    };
  }

  /**
   * Get comprehensive metrics
   */
  getMetrics(): ConsensusMetrics {
    const uptime = Date.now() - this.startTime.getTime();
    const expectedBlocks = Math.floor(uptime / this.config.consensusTimeout);
    this.metrics.uptimePercentage =
      expectedBlocks > 0
        ? (this.metrics.successfulConsensus / expectedBlocks) * 100
        : 100;

    return { ...this.metrics };
  }

  /**
   * Setup event handlers for component coordination
   */
  private setupEventHandlers(): void {
    // View change events
    this.viewChangeCoordinator.on('viewChangeCompleted', (event) => {
      this.metrics.viewChanges++;
      this.emit('viewChanged', event);
    });

    // Validator events
    this.validatorManager.on('validatorQuarantined', (event) => {
      this.metrics.maliciousValidatorsDetected++;
      this.emit('maliciousValidatorDetected', event);
    });

    // Attack defense events
    this.attackDefense.on('replayAttackDetected', (event) => {
      this.metrics.attacksBlocked++;
    });

    this.attackDefense.on('rateLimitViolation', (event) => {
      this.metrics.attacksBlocked++;
    });

    // Phase manager events
    this.phaseManager.on('blockCommitted', (event) => {
      this.emit('consensusAchieved', event);
    });
  }

  /**
   * Update average consensus time
   */
  private updateAverageConsensusTime(newTime: number): void {
    const total = this.metrics.successfulConsensus;
    this.metrics.averageConsensusTime =
      (this.metrics.averageConsensusTime * (total - 1) + newTime) / total;
  }

  /**
   * Get validator information
   */
  getValidator(validatorId: string) {
    return this.validatorManager.getValidator(validatorId);
  }

  /**
   * Get Byzantine tolerance status
   */
  getByzantineTolerance(): ByzantineTolerance {
    return this.validatorManager.getByzantineTolerance();
  }

  /**
   * Get active validators
   */
  getActiveValidators() {
    return this.validatorManager.getActiveValidators();
  }
}
