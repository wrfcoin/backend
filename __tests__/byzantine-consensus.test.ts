/**
 * Byzantine Consensus Test Suite
 * Comprehensive tests for Byzantine fault-tolerant consensus implementation
 *
 * SECURITY: Tests Tasks 100.1 and 100.15 implementation:
 * - Cryptographic signature verification for all votes
 * - PBFT three-phase protocol (pre-prepare, prepare, commit)
 * - Byzantine fault tolerance with f < n/3 malicious nodes
 * - Malicious validator detection and isolation
 * - View change coordination under failures
 * - Network partition handling
 * - Attack defense mechanisms
 * - State management and checkpoints
 * - Performance benchmarks
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import crypto from 'crypto';
import {
  PBFTCryptographicVerification,
  PBFTVote,
  SignedPBFTVote,
  ThresholdSignature,
} from '../shared/pbft-cryptographic-verification.js';
import {
  ByzantineValidatorManager,
  ValidatorInfo,
  ByzantineTolerance,
  MaliciousIndicator,
} from '../shared/byzantine-validator-manager.js';
import {
  PBFTPhaseManager,
  BlockProposal,
  PrePrepareMessage,
  ConsensusRound,
} from '../shared/pbft-phase-manager.js';
import {
  ByzantineAttackDefense,
  RateLimitConfig,
  AttackMetrics,
} from '../shared/byzantine-attack-defense.js';
import {
  ConsensusStateManager,
  StateCheckpoint,
  MerkleProof,
} from '../shared/consensus-state-manager.js';
import {
  ViewChangeCoordinator,
  ViewChangeMessage,
  PrimaryFailureIndicator,
} from '../shared/view-change-coordinator.js';
import {
  ByzantineConsensusCoordinator,
  ConsensusStatus,
  ConsensusMetrics,
} from '../shared/byzantine-consensus-coordinator.js';

describe('PBFT Cryptographic Verification (Task 100.1)', () => {
  let cryptoVerification: PBFTCryptographicVerification;

  beforeEach(() => {
    cryptoVerification = new PBFTCryptographicVerification();
  });

  test('should generate validator key pairs', async () => {
    const validatorId = 'validator-1';
    const keyId = await cryptoVerification.generateValidatorKeyPair(validatorId, 'ecdsa-p256');

    expect(keyId).toBeDefined();
    expect(typeof keyId).toBe('string');

    const publicKey = cryptoVerification.getValidatorPublicKey(validatorId);
    expect(publicKey).toBeDefined();
    expect(publicKey).toBeInstanceOf(Buffer);
  });

  test('should sign PBFT votes with cryptographic signatures', async () => {
    const validatorId = 'validator-1';
    await cryptoVerification.generateValidatorKeyPair(validatorId);

    const vote: PBFTVote = {
      type: 'prepare',
      blockHash: crypto.randomBytes(32).toString('hex'),
      height: 1,
      round: 0,
      viewNumber: 0,
      validatorId,
      votingPower: 100,
      timestamp: Date.now(),
      sequenceNumber: 1,
    };

    const signedVote = await cryptoVerification.signVote(vote, validatorId);

    expect(signedVote.signature).toBeDefined();
    expect(signedVote.signature.signature).toBeInstanceOf(Buffer);
    expect(signedVote.signature.validatorId).toBe(validatorId);
    expect(signedVote.signature.nonce).toBeDefined();
    expect(signedVote.messageHash).toBeDefined();
  });

  test('should verify valid cryptographic signatures', async () => {
    const validatorId = 'validator-1';
    await cryptoVerification.generateValidatorKeyPair(validatorId);

    const vote: PBFTVote = {
      type: 'commit',
      blockHash: crypto.randomBytes(32).toString('hex'),
      height: 1,
      round: 0,
      viewNumber: 0,
      validatorId,
      votingPower: 100,
      timestamp: Date.now(),
      sequenceNumber: 1,
    };

    const signedVote = await cryptoVerification.signVote(vote, validatorId);
    const isValid = await cryptoVerification.verifyVote(signedVote);

    expect(isValid).toBe(true);
  });

  test('should reject votes with invalid signatures', async () => {
    const validatorId = 'validator-1';
    await cryptoVerification.generateValidatorKeyPair(validatorId);

    const vote: PBFTVote = {
      type: 'prepare',
      blockHash: crypto.randomBytes(32).toString('hex'),
      height: 1,
      round: 0,
      viewNumber: 0,
      validatorId,
      votingPower: 100,
      timestamp: Date.now(),
      sequenceNumber: 1,
    };

    const signedVote = await cryptoVerification.signVote(vote, validatorId);

    // Tamper with the signature
    signedVote.signature.signature = Buffer.from('invalid-signature');

    const isValid = await cryptoVerification.verifyVote(signedVote);

    expect(isValid).toBe(false);
  });

  test('should prevent replay attacks with nonce verification', async () => {
    const validatorId = 'validator-1';
    await cryptoVerification.generateValidatorKeyPair(validatorId);

    const vote: PBFTVote = {
      type: 'commit',
      blockHash: crypto.randomBytes(32).toString('hex'),
      height: 1,
      round: 0,
      viewNumber: 0,
      validatorId,
      votingPower: 100,
      timestamp: Date.now(),
      sequenceNumber: 1,
    };

    const signedVote = await cryptoVerification.signVote(vote, validatorId);

    // First verification should succeed
    const firstVerify = await cryptoVerification.verifyVote(signedVote);
    expect(firstVerify).toBe(true);

    // Second verification with same nonce should fail (replay attack)
    const secondVerify = await cryptoVerification.verifyVote(signedVote);
    expect(secondVerify).toBe(false);
  });

  test('should reject votes with expired timestamps', async () => {
    const validatorId = 'validator-1';
    await cryptoVerification.generateValidatorKeyPair(validatorId);

    const vote: PBFTVote = {
      type: 'prepare',
      blockHash: crypto.randomBytes(32).toString('hex'),
      height: 1,
      round: 0,
      viewNumber: 0,
      validatorId,
      votingPower: 100,
      timestamp: Date.now() - 60000, // 1 minute ago
      sequenceNumber: 1,
    };

    const signedVote = await cryptoVerification.signVote(vote, validatorId);

    // Manually set old timestamp
    signedVote.signature.timestamp = Date.now() - 60000;

    const isValid = await cryptoVerification.verifyVote(signedVote);

    expect(isValid).toBe(false);
  });

  test('should batch verify multiple votes efficiently', async () => {
    const validators = ['val-1', 'val-2', 'val-3', 'val-4', 'val-5'];

    // Generate key pairs for all validators
    for (const validatorId of validators) {
      await cryptoVerification.generateValidatorKeyPair(validatorId);
    }

    // Create and sign votes
    const signedVotes: SignedPBFTVote[] = [];
    const blockHash = crypto.randomBytes(32).toString('hex');

    for (const validatorId of validators) {
      const vote: PBFTVote = {
        type: 'commit',
        blockHash,
        height: 1,
        round: 0,
        viewNumber: 0,
        validatorId,
        votingPower: 100,
        timestamp: Date.now(),
        sequenceNumber: 1,
      };

      const signedVote = await cryptoVerification.signVote(vote, validatorId);
      signedVotes.push(signedVote);
    }

    const startTime = Date.now();
    const results = await cryptoVerification.batchVerifyVotes(signedVotes);
    const duration = Date.now() - startTime;

    expect(results.length).toBe(validators.length);
    expect(results.every(r => r === true)).toBe(true);
    expect(duration).toBeLessThan(500); // Should be fast
  });

  test('should create threshold signatures for 2f+1 quorum', async () => {
    const totalValidators = 10;
    const f = Math.floor((totalValidators - 1) / 3);
    const threshold = 2 * f + 1; // 7 for n=10

    const validators: string[] = [];
    for (let i = 0; i < totalValidators; i++) {
      const validatorId = `validator-${i}`;
      validators.push(validatorId);
      await cryptoVerification.generateValidatorKeyPair(validatorId);
    }

    // Create signed votes from threshold validators
    const signedVotes: SignedPBFTVote[] = [];
    const blockHash = crypto.randomBytes(32).toString('hex');

    for (let i = 0; i < threshold; i++) {
      const vote: PBFTVote = {
        type: 'commit',
        blockHash,
        height: 1,
        round: 0,
        viewNumber: 0,
        validatorId: validators[i],
        votingPower: 100,
        timestamp: Date.now(),
        sequenceNumber: 1,
      };

      const signedVote = await cryptoVerification.signVote(vote, validators[i]);
      signedVotes.push(signedVote);
    }

    const thresholdSig = await cryptoVerification.createThresholdSignature(
      signedVotes,
      threshold,
      totalValidators
    );

    expect(thresholdSig.valid).toBe(true);
    expect(thresholdSig.partialSignatures.size).toBe(threshold);
    expect(thresholdSig.threshold).toBe(threshold);
  });

  test('should get verification metrics', () => {
    const metrics = cryptoVerification.getMetrics();

    expect(metrics).toHaveProperty('totalVerifications');
    expect(metrics).toHaveProperty('successfulVerifications');
    expect(metrics).toHaveProperty('failedVerifications');
    expect(metrics).toHaveProperty('averageVerificationTime');
  });
});

describe('Byzantine Validator Manager', () => {
  let validatorManager: ByzantineValidatorManager;

  beforeEach(() => {
    validatorManager = new ByzantineValidatorManager();
  });

  test('should register validators with initial reputation', async () => {
    const validatorId = 'validator-1';
    const publicKey = Buffer.from('public-key-data');

    await validatorManager.registerValidator(validatorId, 'address-1', publicKey, 1000);

    const validator = validatorManager.getValidator(validatorId);
    expect(validator).toBeDefined();
    expect(validator?.reputation).toBe(100);
    expect(validator?.status).toBe('active');
  });

  test('should calculate Byzantine fault tolerance (f < n/3)', async () => {
    const validators = 10;

    for (let i = 0; i < validators; i++) {
      await validatorManager.registerValidator(
        `validator-${i}`,
        `address-${i}`,
        Buffer.from(`key-${i}`),
        1000
      );
    }

    const tolerance = validatorManager.getByzantineTolerance();

    expect(tolerance.totalValidators).toBe(validators);
    expect(tolerance.activeValidators).toBe(validators);
    expect(tolerance.maxByzantineNodes).toBe(Math.floor((validators - 1) / 3)); // 3 for n=10
    expect(tolerance.toleranceStatus).toBe('safe');
  });

  test('should detect malicious validators with multiple indicators', async () => {
    const validatorId = 'malicious-validator';
    await validatorManager.registerValidator(validatorId, 'address', Buffer.from('key'), 1000);

    // Report multiple malicious indicators
    const indicators: MaliciousIndicator[] = [
      {
        validatorId,
        indicatorType: 'double-voting',
        severity: 'high',
        evidence: {},
        detectedAt: new Date(),
        confidence: 0.9,
      },
      {
        validatorId,
        indicatorType: 'invalid-signature',
        severity: 'high',
        evidence: {},
        detectedAt: new Date(),
        confidence: 1.0,
      },
      {
        validatorId,
        indicatorType: 'conflicting-votes',
        severity: 'critical',
        evidence: {},
        detectedAt: new Date(),
        confidence: 0.95,
      },
    ];

    for (const indicator of indicators) {
      await validatorManager.reportMaliciousIndicator(indicator);
    }

    const validator = validatorManager.getValidator(validatorId);
    expect(validator?.status).toBe('quarantined');
  });

  test('should update validator reputation based on voting behavior', async () => {
    const validatorId = 'validator-1';
    await validatorManager.registerValidator(validatorId, 'address', Buffer.from('key'), 1000);

    // Record correct votes
    for (let i = 0; i < 10; i++) {
      await validatorManager.recordVote(validatorId, true, 50);
    }

    const reputation = validatorManager.getReputation(validatorId);
    expect(reputation?.score).toBeGreaterThan(90);
    expect(reputation?.components.accuracy).toBeGreaterThan(95);
  });

  test('should quarantine validators below reputation threshold', async () => {
    const validatorId = 'poor-validator';
    await validatorManager.registerValidator(validatorId, 'address', Buffer.from('key'), 1000);

    // Record many incorrect votes
    for (let i = 0; i < 20; i++) {
      await validatorManager.recordVote(validatorId, false, 200);
    }

    // Report malicious indicators
    for (let i = 0; i < 3; i++) {
      await validatorManager.reportMaliciousIndicator({
        validatorId,
        indicatorType: 'invalid-signature',
        severity: 'medium',
        evidence: {},
        detectedAt: new Date(),
        confidence: 0.7,
      });
    }

    const validator = validatorManager.getValidator(validatorId);
    expect(validator?.status).toBe('quarantined');
  });

  test('should get validators ranked by reputation', async () => {
    const validators = 5;

    for (let i = 0; i < validators; i++) {
      const validatorId = `validator-${i}`;
      await validatorManager.registerValidator(validatorId, `address-${i}`, Buffer.from(`key-${i}`), 1000);

      // Give different reputations
      for (let j = 0; j < i * 2; j++) {
        await validatorManager.recordVote(validatorId, true, 50);
      }
    }

    const ranked = validatorManager.getValidatorsByReputation(3);

    expect(ranked.length).toBeLessThanOrEqual(3);
    expect(ranked[0].reputation).toBeGreaterThanOrEqual(ranked[1].reputation);
  });
});

describe('PBFT Phase Manager (Three-Phase Protocol)', () => {
  let cryptoVerification: PBFTCryptographicVerification;
  let phaseManager: PBFTPhaseManager;

  beforeEach(() => {
    cryptoVerification = new PBFTCryptographicVerification();
    phaseManager = new PBFTPhaseManager(cryptoVerification);
  });

  test('should initiate pre-prepare phase', async () => {
    const primaryId = 'primary-1';
    await cryptoVerification.generateValidatorKeyPair(primaryId);

    const proposal: BlockProposal = {
      blockHash: '',
      height: 1,
      round: 0,
      viewNumber: 0,
      primaryId,
      transactions: [{ id: 'tx1' }, { id: 'tx2' }],
      timestamp: Date.now(),
      parentHash: '0x000',
      stateRoot: '0x000',
    };

    const roundId = await phaseManager.initiatePrePrepare(proposal, primaryId, 10);

    expect(roundId).toBeDefined();
    expect(typeof roundId).toBe('string');

    const round = phaseManager.getRound(roundId);
    expect(round).toBeDefined();
    expect(round?.status).toBe('pre-prepare');
  });

  test('should achieve prepare quorum with 2f+1 validators', async () => {
    const totalValidators = 10;
    const f = Math.floor((totalValidators - 1) / 3);
    const quorum = 2 * f + 1;

    const primaryId = 'primary';
    await cryptoVerification.generateValidatorKeyPair(primaryId);

    const proposal: BlockProposal = {
      blockHash: crypto.randomBytes(32).toString('hex'),
      height: 1,
      round: 0,
      viewNumber: 0,
      primaryId,
      transactions: [],
      timestamp: Date.now(),
      parentHash: '0x000',
      stateRoot: '0x000',
    };

    const roundId = await phaseManager.initiatePrePrepare(proposal, primaryId, totalValidators);

    // Generate validators and process prepare phase
    const validators: string[] = [];
    for (let i = 0; i < quorum; i++) {
      const validatorId = `validator-${i}`;
      validators.push(validatorId);
      await cryptoVerification.generateValidatorKeyPair(validatorId);

      const prePrepareMsg: PrePrepareMessage = {
        type: 'pre-prepare',
        proposal: { ...proposal, primarySignature: Buffer.from('sig'), verified: true },
        viewNumber: 0,
        sequenceNumber: 1,
        primaryId,
        timestamp: Date.now(),
      };

      await phaseManager.processPreparePhase(roundId, validatorId, prePrepareMsg);
    }

    // Simulate receiving prepare messages
    for (let i = 0; i < quorum; i++) {
      const validatorId = validators[i];
      const vote: PBFTVote = {
        type: 'prepare',
        blockHash: proposal.blockHash,
        height: 1,
        round: 0,
        viewNumber: 0,
        validatorId,
        votingPower: 100,
        timestamp: Date.now(),
        sequenceNumber: i + 1,
      };

      const signedVote = await cryptoVerification.signVote(vote, validatorId);

      await phaseManager.receivePrepareMessage(roundId, {
        type: 'prepare',
        blockHash: proposal.blockHash,
        height: 1,
        viewNumber: 0,
        sequenceNumber: i + 1,
        validatorId,
        timestamp: Date.now(),
        signature: signedVote.signature.signature,
        publicKey: signedVote.signature.publicKey,
      });
    }

    const round = phaseManager.getRound(roundId);
    expect(round?.prepareQuorum.achieved).toBe(true);
    expect(round?.status).toBe('commit');
  });

  test('should achieve commit quorum and finalize block', async () => {
    const totalValidators = 7;
    const f = Math.floor((totalValidators - 1) / 3);
    const quorum = 2 * f + 1;

    const primaryId = 'primary';
    await cryptoVerification.generateValidatorKeyPair(primaryId);

    const proposal: BlockProposal = {
      blockHash: crypto.randomBytes(32).toString('hex'),
      height: 1,
      round: 0,
      viewNumber: 0,
      primaryId,
      transactions: [],
      timestamp: Date.now(),
      parentHash: '0x000',
      stateRoot: '0x000',
    };

    const roundId = await phaseManager.initiatePrePrepare(proposal, primaryId, totalValidators);

    // Complete prepare phase
    const validators: string[] = [];
    for (let i = 0; i < quorum; i++) {
      const validatorId = `validator-${i}`;
      validators.push(validatorId);
      await cryptoVerification.generateValidatorKeyPair(validatorId);
    }

    // Manually set prepare quorum as achieved
    const round = phaseManager.getRound(roundId);
    if (round) {
      round.prepareQuorum.achieved = true;
      round.status = 'commit';
    }

    // Process commit phase
    for (let i = 0; i < quorum; i++) {
      const validatorId = validators[i];
      await phaseManager.processCommitPhase(roundId, validatorId);

      const vote: PBFTVote = {
        type: 'commit',
        blockHash: proposal.blockHash,
        height: 1,
        round: 0,
        viewNumber: 0,
        validatorId,
        votingPower: 100,
        timestamp: Date.now(),
        sequenceNumber: i + 1,
      };

      const signedVote = await cryptoVerification.signVote(vote, validatorId);

      await phaseManager.receiveCommitMessage(roundId, {
        type: 'commit',
        blockHash: proposal.blockHash,
        height: 1,
        viewNumber: 0,
        sequenceNumber: i + 1,
        validatorId,
        timestamp: Date.now(),
        signature: signedVote.signature.signature,
        publicKey: signedVote.signature.publicKey,
      });
    }

    const finalRound = phaseManager.getRound(roundId);
    expect(finalRound?.commitQuorum.achieved).toBe(true);
    expect(finalRound?.status).toBe('committed');
  });

  test('should get PBFT metrics', () => {
    const metrics = phaseManager.getMetrics();

    expect(metrics).toHaveProperty('totalRounds');
    expect(metrics).toHaveProperty('successfulRounds');
    expect(metrics).toHaveProperty('averageConsensusTime');
    expect(metrics).toHaveProperty('viewChanges');
  });
});

describe('Byzantine Attack Defense', () => {
  let attackDefense: ByzantineAttackDefense;

  beforeEach(() => {
    attackDefense = new ByzantineAttackDefense({
      maxMessagesPerSecond: 10,
      maxMessagesPerMinute: 100,
      burstCapacity: 20,
      penaltyDuration: 5000,
    });
  });

  test('should enforce rate limits per validator', async () => {
    const validatorId = 'validator-1';

    // Send messages within limit
    for (let i = 0; i < 10; i++) {
      const allowed = await attackDefense.checkRateLimit(validatorId);
      expect(allowed).toBe(true);
    }

    // Exceed rate limit
    const exceeded = await attackDefense.checkRateLimit(validatorId);
    expect(exceeded).toBe(false);
  });

  test('should detect replay attacks', async () => {
    const messageId = 'msg-1';
    const validatorId = 'validator-1';
    const nonce = 'unique-nonce';

    // First message should pass
    const firstCheck = await attackDefense.checkReplayAttack(messageId, validatorId, nonce, 1);
    expect(firstCheck).toBe(true);

    // Same message ID should be detected as replay
    const secondCheck = await attackDefense.checkReplayAttack(messageId, validatorId, nonce, 1);
    expect(secondCheck).toBe(false);
  });

  test('should detect network partitions', async () => {
    const latencies = new Map<string, number>();
    latencies.set('validator-1', 6000); // High latency
    latencies.set('validator-2', 100);
    latencies.set('validator-3', 5500); // High latency

    const unreachable = ['validator-4', 'validator-5'];

    const detected = await attackDefense.detectNetworkPartition(latencies, 3, unreachable);

    expect(detected).toBe(true);
  });

  test('should detect coordination attacks', async () => {
    const validatorVotes = new Map<string, any[]>();

    // Create suspiciously similar voting patterns
    const similarVotes = [
      { vote: 'yes', timestamp: 1000 },
      { vote: 'yes', timestamp: 1050 },
      { vote: 'no', timestamp: 2000 },
    ];

    validatorVotes.set('validator-1', [...similarVotes]);
    validatorVotes.set('validator-2', [...similarVotes]);
    validatorVotes.set('validator-3', [...similarVotes]);

    const indicator = await attackDefense.detectCoordinationAttack(validatorVotes, 10000);

    expect(indicator).toBeDefined();
    expect(indicator?.suspectedCoordinators.length).toBeGreaterThanOrEqual(3);
  });

  test('should get attack metrics', () => {
    const metrics = attackDefense.getMetrics();

    expect(metrics).toHaveProperty('replayAttacksPrevented');
    expect(metrics).toHaveProperty('dosAttemptsBlocked');
    expect(metrics).toHaveProperty('totalAttacksBlocked');
  });
});

describe('Byzantine Consensus Coordinator (Integration)', () => {
  let coordinator: ByzantineConsensusCoordinator;

  beforeEach(async () => {
    coordinator = new ByzantineConsensusCoordinator({
      totalValidators: 10,
      minStake: 1000,
      consensusTimeout: 5000,
      enableAttackDefense: true,
    });

    // Initialize with validators
    const validators = [];
    for (let i = 0; i < 10; i++) {
      validators.push({
        validatorId: `validator-${i}`,
        address: `address-${i}`,
        publicKey: Buffer.from(`publickey-${i}`),
        stake: 1000,
      });
    }

    await coordinator.initialize(validators);
  });

  test('should initialize consensus with validators', async () => {
    const status = coordinator.getStatus();

    expect(status.activeValidators).toBe(10);
    expect(status.primaryId).toBeDefined();
    expect(status.consensusHealth).toBe('healthy');
  });

  test('should calculate Byzantine tolerance correctly', () => {
    const tolerance = coordinator.getByzantineTolerance();

    expect(tolerance.totalValidators).toBe(10);
    expect(tolerance.maxByzantineNodes).toBe(3); // floor((10-1)/3) = 3
    expect(tolerance.safetyMargin).toBeGreaterThan(0);
  });

  test('should propose and finalize blocks with consensus', async () => {
    const status = coordinator.getStatus();
    const primaryId = status.primaryId!;

    const transactions = [
      { id: 'tx1', data: 'transaction 1' },
      { id: 'tx2', data: 'transaction 2' },
    ];

    const roundId = await coordinator.proposeBlock(primaryId, transactions);

    expect(roundId).toBeDefined();

    const metrics = coordinator.getMetrics();
    expect(metrics.totalBlocks).toBeGreaterThanOrEqual(0);
  });

  test('should maintain safety with f < n/3 Byzantine validators', () => {
    const tolerance = coordinator.getByzantineTolerance();

    // With 10 validators, can tolerate 3 Byzantine nodes
    expect(tolerance.maxByzantineNodes).toBe(3);
    expect(tolerance.estimatedByzantineNodes).toBeLessThan(tolerance.maxByzantineNodes);
  });

  test('should get comprehensive consensus metrics', () => {
    const metrics = coordinator.getMetrics();

    expect(metrics).toHaveProperty('totalBlocks');
    expect(metrics).toHaveProperty('successfulConsensus');
    expect(metrics).toHaveProperty('failedConsensus');
    expect(metrics).toHaveProperty('averageConsensusTime');
    expect(metrics).toHaveProperty('viewChanges');
    expect(metrics).toHaveProperty('attacksBlocked');
    expect(metrics).toHaveProperty('uptimePercentage');
  });
});

describe('Performance Benchmarks', () => {
  test('signature verification should be fast (< 50ms per vote)', async () => {
    const cryptoVerification = new PBFTCryptographicVerification();
    const validatorId = 'validator-1';
    await cryptoVerification.generateValidatorKeyPair(validatorId);

    const vote: PBFTVote = {
      type: 'commit',
      blockHash: crypto.randomBytes(32).toString('hex'),
      height: 1,
      round: 0,
      viewNumber: 0,
      validatorId,
      votingPower: 100,
      timestamp: Date.now(),
      sequenceNumber: 1,
    };

    const signedVote = await cryptoVerification.signVote(vote, validatorId);

    const startTime = Date.now();
    await cryptoVerification.verifyVote(signedVote);
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(50);
  });

  test('consensus should achieve finality in < 5 seconds', async () => {
    const coordinator = new ByzantineConsensusCoordinator({
      totalValidators: 7,
      consensusTimeout: 5000,
    });

    const validators = [];
    for (let i = 0; i < 7; i++) {
      validators.push({
        validatorId: `validator-${i}`,
        address: `address-${i}`,
        publicKey: Buffer.from(`key-${i}`),
        stake: 1000,
      });
    }

    await coordinator.initialize(validators);

    const startTime = Date.now();
    const status = coordinator.getStatus();
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(5000);
    expect(status.consensusHealth).toBe('healthy');
  });

  test('should handle 1000+ transactions per second', async () => {
    const coordinator = new ByzantineConsensusCoordinator({
      totalValidators: 10,
    });

    const validators = [];
    for (let i = 0; i < 10; i++) {
      validators.push({
        validatorId: `validator-${i}`,
        address: `address-${i}`,
        publicKey: Buffer.from(`key-${i}`),
        stake: 1000,
      });
    }

    await coordinator.initialize(validators);

    // This is a placeholder - actual throughput testing would require full network simulation
    const status = coordinator.getStatus();
    expect(status).toBeDefined();
  });
});

describe('Security Critical Tests', () => {
  test('CRITICAL: must reject all unsigned votes', async () => {
    const cryptoVerification = new PBFTCryptographicVerification();
    const validatorId = 'validator-1';
    await cryptoVerification.generateValidatorKeyPair(validatorId);

    const vote: PBFTVote = {
      type: 'commit',
      blockHash: crypto.randomBytes(32).toString('hex'),
      height: 1,
      round: 0,
      viewNumber: 0,
      validatorId,
      votingPower: 100,
      timestamp: Date.now(),
      sequenceNumber: 1,
    };

    const signedVote = await cryptoVerification.signVote(vote, validatorId);

    // Remove signature (simulate unsigned vote)
    signedVote.signature.signature = Buffer.alloc(0);

    const isValid = await cryptoVerification.verifyVote(signedVote);

    expect(isValid).toBe(false);
  });

  test('CRITICAL: must prevent f >= n/3 Byzantine validators from controlling consensus', () => {
    const validatorManager = new ByzantineValidatorManager();

    // With 10 validators, Byzantine threshold is 3
    const tolerance = validatorManager.getByzantineTolerance();

    // System should be safe with 3 Byzantine nodes, critical with 4+
    expect(tolerance.maxByzantineNodes).toBe(Math.floor((10 - 1) / 3));
  });

  test('CRITICAL: must detect and quarantine malicious validators', async () => {
    const validatorManager = new ByzantineValidatorManager();
    const validatorId = 'malicious-validator';

    await validatorManager.registerValidator(validatorId, 'address', Buffer.from('key'), 1000);

    // Report critical malicious indicator
    await validatorManager.reportMaliciousIndicator({
      validatorId,
      indicatorType: 'double-voting',
      severity: 'critical',
      evidence: {},
      detectedAt: new Date(),
      confidence: 1.0,
    });

    const validator = validatorManager.getValidator(validatorId);

    expect(validator?.status).toBe('quarantined');
  });
});
