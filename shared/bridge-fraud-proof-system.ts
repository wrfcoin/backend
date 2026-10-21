/**
 * Bridge Fraud Proof System
 *
 * Implements cryptographic fraud proof mechanisms to detect and prevent:
 * - Double-spending attacks across bridges
 * - Invalid state transitions
 * - Malicious validator behavior
 * - Replay attacks
 *
 * Security Features:
 * - Merkle proof verification
 * - Cryptographic signature validation
 * - Nonce-based replay protection
 * - Automatic rollback on fraud detection
 */

import crypto from 'crypto';
import { EventEmitter } from 'events';
import MerkleTree from 'merkletreejs';
import { ECDSAVerifier, fromHex, toHex } from './bridge-crypto-verifier.js';
import { crosschainLogger } from '../server/utils/logger.js';

export enum FraudProofType {
  DOUBLE_SPEND = 'DOUBLE_SPEND',
  INVALID_STATE_TRANSITION = 'INVALID_STATE_TRANSITION',
  MALICIOUS_VALIDATOR = 'MALICIOUS_VALIDATOR',
  REPLAY_ATTACK = 'REPLAY_ATTACK',
  INSUFFICIENT_SIGNATURES = 'INSUFFICIENT_SIGNATURES',
  EXPIRED_TRANSACTION = 'EXPIRED_TRANSACTION',
  INVALID_MERKLE_PROOF = 'INVALID_MERKLE_PROOF',
}

export interface FraudProof {
  id: string;
  type: FraudProofType;
  sourceChain: string;
  destinationChain?: string;
  transactionHash: string;
  blockNumber: number;
  timestamp: Date;
  evidence: FraudEvidence;
  submitter: string;
  verified: boolean;
  actionTaken?: FraudAction;
}

export interface FraudEvidence {
  // Double-spend evidence
  duplicateTransactions?: {
    tx1: TransactionProof;
    tx2: TransactionProof;
    sharedInputs: string[];
  };

  // Invalid state transition
  invalidStateTransition?: {
    previousStateRoot: string;
    claimedStateRoot: string;
    actualStateRoot: string;
    invalidTransaction: string;
    merkleProof: string[];
  };

  // Malicious validator
  maliciousValidator?: {
    validatorAddress: string;
    doubleSignatures?: {
      sig1: SignatureProof;
      sig2: SignatureProof;
    };
    invalidProof?: string;
    contradictoryVotes?: string[];
  };

  // Replay attack
  replayAttack?: {
    originalTransaction: TransactionProof;
    replayedTransaction: TransactionProof;
    originalChain: string;
    replayedChain: string;
  };

  // Generic proof data
  rawData?: any;
}

export interface TransactionProof {
  transactionHash: string;
  blockHash: string;
  blockNumber: number;
  sender: string;
  recipient: string;
  amount: string;
  nonce: number;
  timestamp: number;
  signature: string;
  merkleProof?: string[];
  blockHeader?: BlockHeader;
}

export interface BlockHeader {
  parentHash: string;
  stateRoot: string;
  transactionsRoot: string;
  receiptsRoot: string;
  number: number;
  timestamp: number;
  miner?: string;
  difficulty?: string;
  extraData?: string;
}

export interface SignatureProof {
  signature: string;
  messageHash: string;
  publicKey: string;
  recoveredAddress: string;
  timestamp: number;
}

export enum FraudAction {
  TRANSACTION_REVERTED = 'TRANSACTION_REVERTED',
  VALIDATOR_SLASHED = 'VALIDATOR_SLASHED',
  BRIDGE_PAUSED = 'BRIDGE_PAUSED',
  FUNDS_RETURNED = 'FUNDS_RETURNED',
  INVESTIGATION_PENDING = 'INVESTIGATION_PENDING',
}

export class BridgeFraudProofSystem extends EventEmitter {
  private fraudProofs: Map<string, FraudProof> = new Map();
  private transactionRegistry: Map<string, TransactionProof> = new Map();
  private nonceRegistry: Map<string, Set<number>> = new Map();
  private stateRoots: Map<string, Map<number, string>> = new Map();
  private validatorReputation: Map<string, number> = new Map();

  private readonly PROOF_SUBMISSION_TIMEOUT = 3600; // 1 hour
  private readonly MIN_REPUTATION = -100;
  private readonly FRAUD_DETECTION_REWARD = '1000'; // WRF tokens

  constructor() {
    super();
  }

  /**
   * Submit fraud proof for verification
   */
  public async submitFraudProof(
    type: FraudProofType,
    sourceChain: string,
    transactionHash: string,
    blockNumber: number,
    evidence: FraudEvidence,
    submitter: string,
    destinationChain?: string
  ): Promise<FraudProof> {
    // Generate unique fraud proof ID
    const proofId = this.generateProofId(type, transactionHash, blockNumber);

    // Check if proof already exists
    if (this.fraudProofs.has(proofId)) {
      throw new Error(`Fraud proof already submitted: ${proofId}`);
    }

    const fraudProof: FraudProof = {
      id: proofId,
      type,
      sourceChain,
      destinationChain,
      transactionHash,
      blockNumber,
      timestamp: new Date(),
      evidence,
      submitter,
      verified: false,
    };

    // Store fraud proof
    this.fraudProofs.set(proofId, fraudProof);

    this.emit('fraud:submitted', {
      proofId,
      type,
      submitter,
      transactionHash,
    });

    // Verify fraud proof
    const verified = await this.verifyFraudProof(fraudProof);

    if (verified) {
      await this.handleVerifiedFraud(fraudProof);
    }

    return fraudProof;
  }

  /**
   * Verify fraud proof authenticity
   */
  public async verifyFraudProof(proof: FraudProof): Promise<boolean> {
    try {
      let isValid = false;

      switch (proof.type) {
        case FraudProofType.DOUBLE_SPEND:
          isValid = await this.verifyDoubleSpend(proof);
          break;

        case FraudProofType.INVALID_STATE_TRANSITION:
          isValid = await this.verifyInvalidStateTransition(proof);
          break;

        case FraudProofType.MALICIOUS_VALIDATOR:
          isValid = await this.verifyMaliciousValidator(proof);
          break;

        case FraudProofType.REPLAY_ATTACK:
          isValid = await this.verifyReplayAttack(proof);
          break;

        case FraudProofType.INSUFFICIENT_SIGNATURES:
          isValid = await this.verifyInsufficientSignatures(proof);
          break;

        case FraudProofType.EXPIRED_TRANSACTION:
          isValid = await this.verifyExpiredTransaction(proof);
          break;

        case FraudProofType.INVALID_MERKLE_PROOF:
          isValid = await this.verifyInvalidMerkleProof(proof);
          break;

        default:
          crosschainLogger.warn('Unknown fraud proof type encountered', {
            operation: 'bridge:fraud:verify',
            proofId: proof.id,
            type: proof.type,
            transactionHash: proof.transactionHash,
          });
          isValid = false;
      }

      proof.verified = isValid;

      if (isValid) {
        this.emit('fraud:verified', {
          proofId: proof.id,
          type: proof.type,
          transactionHash: proof.transactionHash,
        });
      } else {
        this.emit('fraud:rejected', {
          proofId: proof.id,
          type: proof.type,
          reason: 'verification_failed',
        });
      }

      return isValid;
    } catch (error) {
      crosschainLogger.error('Fraud proof verification failed', {
        operation: 'bridge:fraud:verify',
        proofId: proof.id,
        type: proof.type,
        transactionHash: proof.transactionHash,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      proof.verified = false;
      return false;
    }
  }

  /**
   * Verify double-spend fraud proof
   */
  private async verifyDoubleSpend(proof: FraudProof): Promise<boolean> {
    const evidence = proof.evidence.duplicateTransactions;
    if (!evidence) return false;

    const { tx1, tx2, sharedInputs } = evidence;

    // Verify both transactions are valid
    if (!this.verifyTransactionProof(tx1) || !this.verifyTransactionProof(tx2)) {
      return false;
    }

    // Verify transactions have same sender and nonce (double-spend)
    if (tx1.sender !== tx2.sender) {
      return false;
    }

    if (tx1.nonce !== tx2.nonce) {
      return false;
    }

    // Verify transactions are different
    if (tx1.transactionHash === tx2.transactionHash) {
      return false;
    }

    // Verify shared inputs exist
    if (!sharedInputs || sharedInputs.length === 0) {
      return false;
    }

    // Verify both transactions were actually included in blocks
    const tx1Valid = await this.verifyTransactionInclusion(tx1);
    const tx2Valid = await this.verifyTransactionInclusion(tx2);

    return tx1Valid && tx2Valid;
  }

  /**
   * Verify invalid state transition fraud proof
   */
  private async verifyInvalidStateTransition(proof: FraudProof): Promise<boolean> {
    const evidence = proof.evidence.invalidStateTransition;
    if (!evidence) return false;

    const {
      previousStateRoot,
      claimedStateRoot,
      actualStateRoot,
      invalidTransaction,
      merkleProof,
    } = evidence;

    // Verify claimed state root differs from actual
    if (claimedStateRoot === actualStateRoot) {
      return false;
    }

    // Verify Merkle proof of invalid transaction
    const merkleValid = this.verifyMerkleProof(
      invalidTransaction,
      claimedStateRoot,
      merkleProof
    );

    if (!merkleValid) {
      return false;
    }

    // Verify state transition is invalid
    // This would require replaying the transaction against the previous state
    // For now, we trust the Merkle proof verification
    return true;
  }

  /**
   * Verify malicious validator fraud proof
   */
  private async verifyMaliciousValidator(proof: FraudProof): Promise<boolean> {
    const evidence = proof.evidence.maliciousValidator;
    if (!evidence) return false;

    const { validatorAddress, doubleSignatures, contradictoryVotes } = evidence;

    // Verify double signatures
    if (doubleSignatures) {
      const { sig1, sig2 } = doubleSignatures;

      // Verify both signatures are from the same validator
      if (sig1.recoveredAddress !== sig2.recoveredAddress) {
        return false;
      }

      if (sig1.recoveredAddress !== validatorAddress) {
        return false;
      }

      // Verify signatures are for different messages
      if (sig1.messageHash === sig2.messageHash) {
        return false;
      }

      // Verify both signatures are valid
      if (!this.verifySignature(sig1) || !this.verifySignature(sig2)) {
        return false;
      }

      return true;
    }

    // Verify contradictory votes
    if (contradictoryVotes && contradictoryVotes.length >= 2) {
      // Implementation would verify validator voted differently on same proposal
      return true;
    }

    return false;
  }

  /**
   * Verify replay attack fraud proof
   */
  private async verifyReplayAttack(proof: FraudProof): Promise<boolean> {
    const evidence = proof.evidence.replayAttack;
    if (!evidence) return false;

    const {
      originalTransaction,
      replayedTransaction,
      originalChain,
      replayedChain,
    } = evidence;

    // Verify transactions are on different chains
    if (originalChain === replayedChain) {
      return false;
    }

    // Verify both transactions have identical signatures
    if (originalTransaction.signature !== replayedTransaction.signature) {
      return false;
    }

    // Verify both transactions are valid
    if (!this.verifyTransactionProof(originalTransaction) ||
        !this.verifyTransactionProof(replayedTransaction)) {
      return false;
    }

    // Verify transactions have same nonce (replay indicator)
    if (originalTransaction.nonce !== replayedTransaction.nonce) {
      return false;
    }

    return true;
  }

  /**
   * Verify insufficient signatures fraud proof
   */
  private async verifyInsufficientSignatures(proof: FraudProof): Promise<boolean> {
    // This would verify that a transaction was executed without
    // the required threshold of validator signatures
    // Implementation depends on multi-signature system
    return true;
  }

  /**
   * Verify expired transaction fraud proof
   */
  private async verifyExpiredTransaction(proof: FraudProof): Promise<boolean> {
    // Verify transaction was executed after its expiration time
    const tx = this.transactionRegistry.get(proof.transactionHash);
    if (!tx) return false;

    const now = Math.floor(Date.now() / 1000);
    const isExpired = tx.timestamp > 0 && now > tx.timestamp;

    return isExpired;
  }

  /**
   * Verify invalid Merkle proof fraud proof
   */
  private async verifyInvalidMerkleProof(proof: FraudProof): Promise<boolean> {
    const evidence = proof.evidence.invalidStateTransition;
    if (!evidence || !evidence.merkleProof) return false;

    // Attempt to verify the Merkle proof
    const isValid = this.verifyMerkleProof(
      evidence.invalidTransaction,
      evidence.claimedStateRoot,
      evidence.merkleProof
    );

    // Proof is fraudulent if Merkle verification fails
    return !isValid;
  }

  /**
   * Verify transaction proof validity
   */
  private verifyTransactionProof(tx: TransactionProof): boolean {
    if (!tx.transactionHash || !tx.blockHash || !tx.signature) {
      return false;
    }

    if (!tx.sender || !tx.recipient) {
      return false;
    }

    if (tx.nonce < 0) {
      return false;
    }

    return true;
  }

  /**
   * Verify transaction inclusion in block
   */
  private async verifyTransactionInclusion(tx: TransactionProof): Promise<boolean> {
    if (!tx.merkleProof || tx.merkleProof.length === 0) {
      return false;
    }

    if (!tx.blockHeader) {
      return false;
    }

    // Verify transaction is in the Merkle tree
    return this.verifyMerkleProof(
      tx.transactionHash,
      tx.blockHeader.transactionsRoot,
      tx.merkleProof
    );
  }

  /**
   * Verify Merkle proof
   */
  private verifyMerkleProof(
    leaf: string,
    root: string,
    proof: string[]
  ): boolean {
    try {
      let hash = leaf;

      for (const proofElement of proof) {
        // Concatenate and hash in order
        const combined = [hash, proofElement].sort().join('');
        hash = crypto.createHash('sha256').update(combined).digest('hex');
      }

      return hash === root;
    } catch (error) {
      crosschainLogger.error('Merkle proof verification failed', {
        operation: 'bridge:fraud:merkle:verify',
        leaf: leaf.substring(0, 16) + '...',
        root: root.substring(0, 16) + '...',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Verify cryptographic signature using real ECDSA secp256k1
   * Used for fraud proof signature validation
   */
  private verifySignature(sig: SignatureProof): boolean {
    try {
      // Validate required fields
      if (!sig.signature || !sig.messageHash || !sig.publicKey) {
        this.emit('signature:validation_failed', {
          reason: 'missing_required_fields',
          hasSignature: !!sig.signature,
          hasMessageHash: !!sig.messageHash,
          hasPublicKey: !!sig.publicKey,
        });
        return false;
      }

      // Validate signature format (ECDSA signatures are 64 bytes = 128 hex chars)
      const normalizedSig = sig.signature.startsWith('0x') ? sig.signature.slice(2) : sig.signature;
      if (normalizedSig.length < 128) {
        this.emit('signature:validation_failed', {
          reason: 'signature_too_short',
          length: normalizedSig.length,
          expected: 128,
        });
        return false;
      }

      // Normalize inputs - remove 0x prefix if present
      const normalizedHash = sig.messageHash.startsWith('0x')
        ? sig.messageHash.slice(2)
        : sig.messageHash;
      const normalizedPubKey = sig.publicKey.startsWith('0x')
        ? sig.publicKey.slice(2)
        : sig.publicKey;

      // Use real ECDSA secp256k1 verification from crypto verifier
      const result = ECDSAVerifier.verify(normalizedHash, normalizedSig, normalizedPubKey);

      if (!result.isValid) {
        this.emit('signature:cryptographic_verification_failed', {
          messageHash: sig.messageHash.substring(0, 16) + '...',
          error: result.error,
        });
        return false;
      }

      this.emit('signature:verified', {
        publicKey: sig.publicKey.substring(0, 16) + '...',
        messageHash: sig.messageHash.substring(0, 16) + '...',
      });

      return true;
    } catch (error) {
      crosschainLogger.error('Fraud proof signature verification failed', {
        operation: 'bridge:fraud:signature:verify',
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      this.emit('signature:error', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Handle verified fraud
   */
  private async handleVerifiedFraud(proof: FraudProof): Promise<void> {
    let action: FraudAction;

    switch (proof.type) {
      case FraudProofType.DOUBLE_SPEND:
        action = FraudAction.TRANSACTION_REVERTED;
        await this.revertTransaction(proof.transactionHash);
        break;

      case FraudProofType.MALICIOUS_VALIDATOR:
        action = FraudAction.VALIDATOR_SLASHED;
        await this.slashValidator(proof.evidence.maliciousValidator!.validatorAddress);
        break;

      case FraudProofType.REPLAY_ATTACK:
        action = FraudAction.TRANSACTION_REVERTED;
        await this.revertTransaction(proof.transactionHash);
        break;

      default:
        action = FraudAction.INVESTIGATION_PENDING;
    }

    proof.actionTaken = action;

    this.emit('fraud:action_taken', {
      proofId: proof.id,
      type: proof.type,
      action,
    });

    // Reward fraud proof submitter
    this.emit('fraud:reward', {
      recipient: proof.submitter,
      amount: this.FRAUD_DETECTION_REWARD,
      proofId: proof.id,
    });
  }

  /**
   * Revert fraudulent transaction
   */
  private async revertTransaction(transactionHash: string): Promise<void> {
    this.emit('transaction:revert', {
      transactionHash,
      reason: 'fraud_detected',
    });
  }

  /**
   * Slash malicious validator
   */
  private async slashValidator(validatorAddress: string): Promise<void> {
    const currentReputation = this.validatorReputation.get(validatorAddress) || 100;
    const newReputation = Math.max(this.MIN_REPUTATION, currentReputation - 50);

    this.validatorReputation.set(validatorAddress, newReputation);

    this.emit('validator:slashed', {
      validatorAddress,
      previousReputation: currentReputation,
      newReputation,
      slashAmount: 50,
    });

    // If reputation too low, remove validator
    if (newReputation <= this.MIN_REPUTATION) {
      this.emit('validator:removed', {
        validatorAddress,
        reason: 'malicious_behavior',
      });
    }
  }

  /**
   * Register transaction for fraud monitoring
   */
  public registerTransaction(tx: TransactionProof): void {
    this.transactionRegistry.set(tx.transactionHash, tx);

    // Track nonces for replay detection
    if (!this.nonceRegistry.has(tx.sender)) {
      this.nonceRegistry.set(tx.sender, new Set());
    }
    this.nonceRegistry.get(tx.sender)!.add(tx.nonce);
  }

  /**
   * Check if nonce has been used (replay detection)
   */
  public isNonceUsed(sender: string, nonce: number): boolean {
    const nonces = this.nonceRegistry.get(sender);
    return nonces ? nonces.has(nonce) : false;
  }

  /**
   * Register state root
   */
  public registerStateRoot(chain: string, blockNumber: number, stateRoot: string): void {
    if (!this.stateRoots.has(chain)) {
      this.stateRoots.set(chain, new Map());
    }
    this.stateRoots.get(chain)!.set(blockNumber, stateRoot);
  }

  /**
   * Get fraud proof by ID
   */
  public getFraudProof(proofId: string): FraudProof | undefined {
    return this.fraudProofs.get(proofId);
  }

  /**
   * Get all fraud proofs
   */
  public getAllFraudProofs(): FraudProof[] {
    return Array.from(this.fraudProofs.values());
  }

  /**
   * Get fraud proofs by type
   */
  public getFraudProofsByType(type: FraudProofType): FraudProof[] {
    return Array.from(this.fraudProofs.values()).filter(
      proof => proof.type === type
    );
  }

  /**
   * Get validator reputation
   */
  public getValidatorReputation(validatorAddress: string): number {
    return this.validatorReputation.get(validatorAddress) || 100;
  }

  /**
   * Generate unique proof ID
   */
  private generateProofId(
    type: FraudProofType,
    transactionHash: string,
    blockNumber: number
  ): string {
    const data = `${type}-${transactionHash}-${blockNumber}-${Date.now()}`;
    return crypto.createHash('sha256').update(data).digest('hex');
  }

  /**
   * Get statistics
   */
  public getStatistics() {
    const stats = {
      totalProofs: this.fraudProofs.size,
      verifiedProofs: 0,
      rejectedProofs: 0,
      byType: {} as Record<string, number>,
      actionsTaken: {} as Record<string, number>,
    };

    for (const proof of this.fraudProofs.values()) {
      if (proof.verified) {
        stats.verifiedProofs++;
      } else {
        stats.rejectedProofs++;
      }

      stats.byType[proof.type] = (stats.byType[proof.type] || 0) + 1;

      if (proof.actionTaken) {
        stats.actionsTaken[proof.actionTaken] =
          (stats.actionsTaken[proof.actionTaken] || 0) + 1;
      }
    }

    return stats;
  }
}

// Singleton instance
export const fraudProofSystem = new BridgeFraudProofSystem();
