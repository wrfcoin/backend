/**
 * Bridge Verification Orchestrator
 *
 * Coordinates the complete verification pipeline for cross-chain bridge transactions.
 * Implements a multi-layer security approach combining:
 * - Merkle proof verification for transaction inclusion
 * - Multi-signature threshold verification
 * - Nullifier registry for double-spend prevention
 * - Timing constraints for replay protection
 * - Oracle/relayer attestation verification
 *
 * This module serves as the central security checkpoint for all bridge operations.
 */

import { EventEmitter } from 'events';
import { ECDSAVerifier, BLSVerifier, BridgeMessageVerifier } from './bridge-crypto-verifier.js';
import { BridgeMerkleService, BridgeTransaction, MerkleProof } from './bridge-merkle-service.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { crosschainLogger } from '../server/utils/logger.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface VerificationRequest {
  transaction: BridgeTransactionDetails;
  merkleProof: MerkleProofData;
  signatures: SignatureSet;
  oracleAttestation?: OracleAttestation;
  relayerAttestation?: RelayerAttestation;
}

export interface BridgeTransactionDetails {
  id: string;
  sourceChain: string;
  destinationChain: string;
  sender: string;
  recipient: string;
  amount: bigint;
  tokenAddress: string;
  nonce: number;
  timestamp: number;
  sourceBlockNumber: number;
  sourceBlockHash: string;
  data?: string;
}

export interface MerkleProofData {
  leaf: string;
  root: string;
  proof: string[];
  leafIndex: number;
  treeSize: number;
}

export interface SignatureSet {
  signatures: ValidatorSignature[];
  requiredThreshold: number;
  signatureType: 'ecdsa' | 'bls' | 'aggregated';
}

export interface ValidatorSignature {
  validatorAddress: string;
  publicKey: string;
  signature: string;
  timestamp: number;
}

export interface OracleAttestation {
  oracleAddress: string;
  publicKey: string;
  signature: string;
  blockConfirmations: number;
  attestationTime: number;
}

export interface RelayerAttestation {
  relayerAddress: string;
  publicKey: string;
  signature: string;
  deliveryConfirmation: boolean;
  attestationTime: number;
}

export interface VerificationResult {
  isValid: boolean;
  transactionId: string;
  verificationSteps: VerificationStep[];
  auditTrail: AuditEntry[];
  timestamp: number;
  overallConfidence: number;
  errors: VerificationError[];
}

export interface VerificationStep {
  step: string;
  passed: boolean;
  details: Record<string, unknown>;
  duration: number;
}

export interface AuditEntry {
  timestamp: number;
  action: string;
  result: string;
  metadata: Record<string, unknown>;
}

export interface VerificationError {
  code: string;
  message: string;
  step: string;
  severity: 'warning' | 'error' | 'critical';
}

// ============================================================================
// Nullifier Registry for Double-Spend Prevention
// ============================================================================

interface NullifierEntry {
  transactionId: string;
  nullifierHash: string;
  sourceChain: string;
  destinationChain: string;
  createdAt: number;
  processedAt?: number;
  status: 'pending' | 'processed' | 'reverted';
}

class NullifierRegistry {
  private nullifiers = new Map<string, NullifierEntry>();
  private readonly MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

  /**
   * Generate nullifier hash from transaction details
   */
  generateNullifier(tx: BridgeTransactionDetails): string {
    const data = `${tx.sourceChain}:${tx.destinationChain}:${tx.sender}:${tx.nonce}:${tx.amount}`;
    const hash = keccak_256(new TextEncoder().encode(data));
    return '0x' + bytesToHex(hash);
  }

  /**
   * Check if a nullifier has already been used (double-spend detection)
   */
  isNullifierUsed(nullifierHash: string): boolean {
    const entry = this.nullifiers.get(nullifierHash);
    if (!entry) return false;

    // Check if the nullifier is processed (used)
    return entry.status === 'processed';
  }

  /**
   * Reserve a nullifier for a pending transaction
   */
  reserveNullifier(tx: BridgeTransactionDetails): {
    success: boolean;
    nullifierHash: string;
    existingEntry?: NullifierEntry;
  } {
    const nullifierHash = this.generateNullifier(tx);

    const existing = this.nullifiers.get(nullifierHash);
    if (existing) {
      // Nullifier already exists
      if (existing.status === 'processed') {
        // Already processed - double-spend attempt
        return {
          success: false,
          nullifierHash,
          existingEntry: existing,
        };
      }

      if (existing.status === 'pending') {
        // Already pending - check if it's expired
        const age = Date.now() - existing.createdAt;
        if (age < this.MAX_AGE_MS) {
          // Still valid pending nullifier
          return {
            success: false,
            nullifierHash,
            existingEntry: existing,
          };
        }
        // Expired pending - allow reuse
      }
    }

    // Create new nullifier entry
    const entry: NullifierEntry = {
      transactionId: tx.id,
      nullifierHash,
      sourceChain: tx.sourceChain,
      destinationChain: tx.destinationChain,
      createdAt: Date.now(),
      status: 'pending',
    };

    this.nullifiers.set(nullifierHash, entry);
    return { success: true, nullifierHash };
  }

  /**
   * Mark a nullifier as processed (transaction completed)
   */
  markProcessed(nullifierHash: string): boolean {
    const entry = this.nullifiers.get(nullifierHash);
    if (!entry) return false;

    entry.status = 'processed';
    entry.processedAt = Date.now();
    return true;
  }

  /**
   * Revert a nullifier (transaction failed/reverted)
   */
  revertNullifier(nullifierHash: string): boolean {
    const entry = this.nullifiers.get(nullifierHash);
    if (!entry) return false;

    entry.status = 'reverted';
    return true;
  }

  /**
   * Clean up old entries
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [hash, entry] of this.nullifiers) {
      const age = now - entry.createdAt;
      if (age > this.MAX_AGE_MS && entry.status !== 'processed') {
        this.nullifiers.delete(hash);
        removed++;
      }
    }

    return removed;
  }
}

// ============================================================================
// Verification Orchestrator
// ============================================================================

export class BridgeVerificationOrchestrator extends EventEmitter {
  /** #977: nullifier cleanup timer handle — previously discarded. */
  private nullifierCleanupTimer?: ReturnType<typeof setInterval>;

  private merkleService: BridgeMerkleService;
  private nullifierRegistry: NullifierRegistry;

  // Timing constraints
  private readonly MAX_TRANSACTION_AGE_MS = 60 * 60 * 1000; // 1 hour
  private readonly MIN_BLOCK_CONFIRMATIONS = 15;
  private readonly SIGNATURE_VALIDITY_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

  // Registered validators
  private validators = new Map<string, {
    publicKey: string;
    reputation: number;
    isActive: boolean;
  }>();

  constructor() {
    super();
    this.merkleService = new BridgeMerkleService();
    this.nullifierRegistry = new NullifierRegistry();

    // Periodic cleanup
    // #977 ratchet: stored and unref'd — constructor-started.
    this.nullifierCleanupTimer = setInterval(() => this.nullifierRegistry.cleanup(), 60 * 60 * 1000);
    this.nullifierCleanupTimer.unref();
  }

  /**
   * Register a validator for signature verification
   */
  registerValidator(address: string, publicKey: string): void {
    this.validators.set(address.toLowerCase(), {
      publicKey,
      reputation: 100,
      isActive: true,
    });

    this.emit('validator:registered', { address, publicKey });
  }

  /**
   * Perform complete verification of a cross-chain transaction
   */
  async verifyTransaction(request: VerificationRequest): Promise<VerificationResult> {
    const startTime = Date.now();
    const steps: VerificationStep[] = [];
    const auditTrail: AuditEntry[] = [];
    const errors: VerificationError[] = [];

    auditTrail.push({
      timestamp: Date.now(),
      action: 'verification_started',
      result: 'initiated',
      metadata: { transactionId: request.transaction.id },
    });

    try {
      // Step 1: Validate transaction format and timing
      const timingResult = await this.verifyTimingConstraints(request.transaction);
      steps.push(timingResult.step);
      if (!timingResult.passed) {
        errors.push(...timingResult.errors);
        return this.buildResult(false, request.transaction.id, steps, auditTrail, errors);
      }

      // Step 2: Verify Merkle proof for transaction inclusion
      const merkleResult = await this.verifyMerkleProof(request.transaction, request.merkleProof);
      steps.push(merkleResult.step);
      if (!merkleResult.passed) {
        errors.push(...merkleResult.errors);
        return this.buildResult(false, request.transaction.id, steps, auditTrail, errors);
      }

      // Step 3: Check nullifier registry (double-spend prevention)
      const nullifierResult = await this.checkNullifier(request.transaction);
      steps.push(nullifierResult.step);
      if (!nullifierResult.passed) {
        errors.push(...nullifierResult.errors);
        return this.buildResult(false, request.transaction.id, steps, auditTrail, errors);
      }

      // Step 4: Verify validator signatures
      const signatureResult = await this.verifySignatures(request.transaction, request.signatures);
      steps.push(signatureResult.step);
      if (!signatureResult.passed) {
        errors.push(...signatureResult.errors);
        return this.buildResult(false, request.transaction.id, steps, auditTrail, errors);
      }

      // Step 5: Verify oracle attestation (if provided)
      if (request.oracleAttestation) {
        const oracleResult = await this.verifyOracleAttestation(
          request.transaction,
          request.oracleAttestation
        );
        steps.push(oracleResult.step);
        if (!oracleResult.passed) {
          errors.push(...oracleResult.errors);
          // Oracle failures are warnings, not fatal
        }
      }

      // Step 6: Verify relayer attestation (if provided)
      if (request.relayerAttestation) {
        const relayerResult = await this.verifyRelayerAttestation(
          request.transaction,
          request.relayerAttestation
        );
        steps.push(relayerResult.step);
        if (!relayerResult.passed) {
          errors.push(...relayerResult.errors);
          // Relayer failures are warnings, not fatal
        }
      }

      // Mark nullifier as processed on successful verification
      this.nullifierRegistry.markProcessed(nullifierResult.nullifierHash!);

      auditTrail.push({
        timestamp: Date.now(),
        action: 'verification_completed',
        result: 'success',
        metadata: {
          transactionId: request.transaction.id,
          duration: Date.now() - startTime,
        },
      });

      this.emit('verification:success', {
        transactionId: request.transaction.id,
        duration: Date.now() - startTime,
      });

      return this.buildResult(true, request.transaction.id, steps, auditTrail, errors);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      errors.push({
        code: 'VERIFICATION_EXCEPTION',
        message: errorMessage,
        step: 'orchestrator',
        severity: 'critical',
      });

      auditTrail.push({
        timestamp: Date.now(),
        action: 'verification_failed',
        result: 'exception',
        metadata: { error: errorMessage },
      });

      this.emit('verification:error', {
        transactionId: request.transaction.id,
        error: errorMessage,
      });

      return this.buildResult(false, request.transaction.id, steps, auditTrail, errors);
    }
  }

  /**
   * Verify timing constraints for replay protection
   */
  private async verifyTimingConstraints(
    tx: BridgeTransactionDetails
  ): Promise<{ passed: boolean; step: VerificationStep; errors: VerificationError[] }> {
    const start = Date.now();
    const errors: VerificationError[] = [];

    // Check transaction age
    const txAge = Date.now() - tx.timestamp;
    if (txAge > this.MAX_TRANSACTION_AGE_MS) {
      errors.push({
        code: 'TRANSACTION_EXPIRED',
        message: `Transaction is too old: ${txAge}ms exceeds maximum ${this.MAX_TRANSACTION_AGE_MS}ms`,
        step: 'timing_constraints',
        severity: 'error',
      });
    }

    // Check for future transactions (clock drift protection)
    if (tx.timestamp > Date.now() + 60000) {
      errors.push({
        code: 'FUTURE_TRANSACTION',
        message: 'Transaction timestamp is in the future',
        step: 'timing_constraints',
        severity: 'error',
      });
    }

    // Check nonce validity
    if (tx.nonce < 0 || !Number.isInteger(tx.nonce)) {
      errors.push({
        code: 'INVALID_NONCE',
        message: 'Transaction nonce is invalid',
        step: 'timing_constraints',
        severity: 'error',
      });
    }

    const passed = errors.length === 0;

    return {
      passed,
      step: {
        step: 'timing_constraints',
        passed,
        details: {
          transactionAge: txAge,
          maxAge: this.MAX_TRANSACTION_AGE_MS,
          nonce: tx.nonce,
        },
        duration: Date.now() - start,
      },
      errors,
    };
  }

  /**
   * Verify Merkle proof for transaction inclusion
   */
  private async verifyMerkleProof(
    tx: BridgeTransactionDetails,
    proof: MerkleProofData
  ): Promise<{ passed: boolean; step: VerificationStep; errors: VerificationError[] }> {
    const start = Date.now();
    const errors: VerificationError[] = [];

    // Convert transaction to Merkle-compatible format
    const bridgeTx: BridgeTransaction = {
      id: tx.id,
      sourceChain: tx.sourceChain,
      destinationChain: tx.destinationChain,
      sender: tx.sender,
      recipient: tx.recipient,
      amount: tx.amount,
      tokenAddress: tx.tokenAddress,
      nonce: tx.nonce,
      timestamp: tx.timestamp,
    };

    // Verify the proof
    const isValid = this.merkleService.verifyTransactionInclusion(
      bridgeTx,
      proof.proof,
      proof.leafIndex,
      proof.root,
      'keccak256'
    );

    if (!isValid) {
      errors.push({
        code: 'INVALID_MERKLE_PROOF',
        message: 'Merkle proof verification failed - transaction not included in claimed block',
        step: 'merkle_verification',
        severity: 'critical',
      });
    }

    return {
      passed: isValid,
      step: {
        step: 'merkle_verification',
        passed: isValid,
        details: {
          merkleRoot: proof.root,
          leafIndex: proof.leafIndex,
          proofLength: proof.proof.length,
        },
        duration: Date.now() - start,
      },
      errors,
    };
  }

  /**
   * Check nullifier registry for double-spend prevention
   */
  private async checkNullifier(
    tx: BridgeTransactionDetails
  ): Promise<{
    passed: boolean;
    step: VerificationStep;
    errors: VerificationError[];
    nullifierHash?: string;
  }> {
    const start = Date.now();
    const errors: VerificationError[] = [];

    const result = this.nullifierRegistry.reserveNullifier(tx);

    if (!result.success) {
      if (result.existingEntry?.status === 'processed') {
        errors.push({
          code: 'DOUBLE_SPEND_DETECTED',
          message: `Transaction has already been processed. Original transaction ID: ${result.existingEntry.transactionId}`,
          step: 'nullifier_check',
          severity: 'critical',
        });
      } else {
        errors.push({
          code: 'NULLIFIER_COLLISION',
          message: 'A pending transaction with the same nullifier exists',
          step: 'nullifier_check',
          severity: 'error',
        });
      }
    }

    return {
      passed: result.success,
      step: {
        step: 'nullifier_check',
        passed: result.success,
        details: {
          nullifierHash: result.nullifierHash,
          isNewNullifier: result.success,
        },
        duration: Date.now() - start,
      },
      errors,
      nullifierHash: result.nullifierHash,
    };
  }

  /**
   * Verify validator signatures meet threshold requirements
   */
  private async verifySignatures(
    tx: BridgeTransactionDetails,
    sigSet: SignatureSet
  ): Promise<{ passed: boolean; step: VerificationStep; errors: VerificationError[] }> {
    const start = Date.now();
    const errors: VerificationError[] = [];

    // Create message hash from transaction
    const messageHash = this.hashTransaction(tx);

    // Check we have enough signatures
    if (sigSet.signatures.length < sigSet.requiredThreshold) {
      errors.push({
        code: 'INSUFFICIENT_SIGNATURES',
        message: `Only ${sigSet.signatures.length} signatures provided, but ${sigSet.requiredThreshold} required`,
        step: 'signature_verification',
        severity: 'error',
      });

      return {
        passed: false,
        step: {
          step: 'signature_verification',
          passed: false,
          details: {
            provided: sigSet.signatures.length,
            required: sigSet.requiredThreshold,
          },
          duration: Date.now() - start,
        },
        errors,
      };
    }

    let validSignatures = 0;
    const verifiedValidators: string[] = [];

    for (const sig of sigSet.signatures) {
      // Check signature is within validity window
      if (Date.now() - sig.timestamp > this.SIGNATURE_VALIDITY_WINDOW_MS) {
        errors.push({
          code: 'SIGNATURE_EXPIRED',
          message: `Signature from ${sig.validatorAddress} has expired`,
          step: 'signature_verification',
          severity: 'warning',
        });
        continue;
      }

      // Check validator is registered and active
      const validator = this.validators.get(sig.validatorAddress.toLowerCase());
      if (!validator || !validator.isActive) {
        errors.push({
          code: 'UNKNOWN_VALIDATOR',
          message: `Signature from unregistered validator: ${sig.validatorAddress}`,
          step: 'signature_verification',
          severity: 'warning',
        });
        continue;
      }

      // Verify the cryptographic signature
      const isValid = this.verifySingleSignature(
        messageHash,
        sig.signature,
        sig.publicKey,
        sigSet.signatureType
      );

      if (isValid) {
        validSignatures++;
        verifiedValidators.push(sig.validatorAddress);
      } else {
        errors.push({
          code: 'INVALID_SIGNATURE',
          message: `Cryptographic verification failed for validator: ${sig.validatorAddress}`,
          step: 'signature_verification',
          severity: 'warning',
        });
      }
    }

    const passed = validSignatures >= sigSet.requiredThreshold;

    if (!passed) {
      errors.push({
        code: 'THRESHOLD_NOT_MET',
        message: `Only ${validSignatures} valid signatures, but ${sigSet.requiredThreshold} required`,
        step: 'signature_verification',
        severity: 'error',
      });
    }

    return {
      passed,
      step: {
        step: 'signature_verification',
        passed,
        details: {
          validSignatures,
          requiredThreshold: sigSet.requiredThreshold,
          verifiedValidators,
          signatureType: sigSet.signatureType,
        },
        duration: Date.now() - start,
      },
      errors,
    };
  }

  /**
   * Verify oracle attestation for cross-chain state
   */
  private async verifyOracleAttestation(
    tx: BridgeTransactionDetails,
    attestation: OracleAttestation
  ): Promise<{ passed: boolean; step: VerificationStep; errors: VerificationError[] }> {
    const start = Date.now();
    const errors: VerificationError[] = [];

    // Check block confirmations
    if (attestation.blockConfirmations < this.MIN_BLOCK_CONFIRMATIONS) {
      errors.push({
        code: 'INSUFFICIENT_CONFIRMATIONS',
        message: `Only ${attestation.blockConfirmations} confirmations, but ${this.MIN_BLOCK_CONFIRMATIONS} required`,
        step: 'oracle_attestation',
        severity: 'warning',
      });
    }

    // Verify oracle signature
    const messageHash = this.hashTransaction(tx);
    const isValid = this.verifySingleSignature(
      messageHash,
      attestation.signature,
      attestation.publicKey,
      'ecdsa'
    );

    if (!isValid) {
      errors.push({
        code: 'INVALID_ORACLE_SIGNATURE',
        message: 'Oracle attestation signature verification failed',
        step: 'oracle_attestation',
        severity: 'warning',
      });
    }

    const passed = isValid && attestation.blockConfirmations >= this.MIN_BLOCK_CONFIRMATIONS;

    return {
      passed,
      step: {
        step: 'oracle_attestation',
        passed,
        details: {
          oracleAddress: attestation.oracleAddress,
          blockConfirmations: attestation.blockConfirmations,
          requiredConfirmations: this.MIN_BLOCK_CONFIRMATIONS,
        },
        duration: Date.now() - start,
      },
      errors,
    };
  }

  /**
   * Verify relayer attestation for message delivery
   */
  private async verifyRelayerAttestation(
    tx: BridgeTransactionDetails,
    attestation: RelayerAttestation
  ): Promise<{ passed: boolean; step: VerificationStep; errors: VerificationError[] }> {
    const start = Date.now();
    const errors: VerificationError[] = [];

    // Verify relayer signature
    const messageHash = this.hashTransaction(tx);
    const isValid = this.verifySingleSignature(
      messageHash,
      attestation.signature,
      attestation.publicKey,
      'ecdsa'
    );

    if (!isValid) {
      errors.push({
        code: 'INVALID_RELAYER_SIGNATURE',
        message: 'Relayer attestation signature verification failed',
        step: 'relayer_attestation',
        severity: 'warning',
      });
    }

    if (!attestation.deliveryConfirmation) {
      errors.push({
        code: 'NO_DELIVERY_CONFIRMATION',
        message: 'Relayer has not confirmed message delivery',
        step: 'relayer_attestation',
        severity: 'warning',
      });
    }

    const passed = isValid && attestation.deliveryConfirmation;

    return {
      passed,
      step: {
        step: 'relayer_attestation',
        passed,
        details: {
          relayerAddress: attestation.relayerAddress,
          deliveryConfirmed: attestation.deliveryConfirmation,
        },
        duration: Date.now() - start,
      },
      errors,
    };
  }

  /**
   * Verify a single signature using appropriate algorithm
   */
  private verifySingleSignature(
    messageHash: string,
    signature: string,
    publicKey: string,
    signatureType: 'ecdsa' | 'bls' | 'aggregated'
  ): boolean {
    try {
      // Normalize inputs
      const normalizedHash = messageHash.startsWith('0x') ? messageHash.slice(2) : messageHash;
      const normalizedSig = signature.startsWith('0x') ? signature.slice(2) : signature;
      const normalizedPubKey = publicKey.startsWith('0x') ? publicKey.slice(2) : publicKey;

      if (signatureType === 'ecdsa') {
        const result = ECDSAVerifier.verify(normalizedHash, normalizedSig, normalizedPubKey);
        return result.isValid;
      } else if (signatureType === 'bls') {
        const msgBytes = hexToBytes(normalizedHash);
        const sigBytes = hexToBytes(normalizedSig);
        const pubKeyBytes = hexToBytes(normalizedPubKey);
        return BLSVerifier.verify(msgBytes, sigBytes, pubKeyBytes);
      }

      return false;
    } catch (error) {
      crosschainLogger.error('Signature verification error', {
        operation: 'bridge:signature:verify',
        signatureType,
        error: error instanceof Error ? { name: error.name, message: error.message } : 'Unknown error',
      });
      return false;
    }
  }

  /**
   * Create message hash from transaction for signing
   */
  private hashTransaction(tx: BridgeTransactionDetails): string {
    const data = `${tx.id}:${tx.sourceChain}:${tx.destinationChain}:${tx.sender}:${tx.recipient}:${tx.amount}:${tx.tokenAddress}:${tx.nonce}:${tx.timestamp}`;
    const hash = keccak_256(new TextEncoder().encode(data));
    return '0x' + bytesToHex(hash);
  }

  /**
   * Build final verification result
   */
  private buildResult(
    isValid: boolean,
    transactionId: string,
    steps: VerificationStep[],
    auditTrail: AuditEntry[],
    errors: VerificationError[]
  ): VerificationResult {
    // Calculate confidence based on passed steps and error severity
    let confidence = isValid ? 100 : 0;

    if (isValid) {
      // Reduce confidence for warnings
      const warnings = errors.filter(e => e.severity === 'warning').length;
      confidence -= warnings * 5;
      confidence = Math.max(50, confidence);
    }

    return {
      isValid,
      transactionId,
      verificationSteps: steps,
      auditTrail,
      timestamp: Date.now(),
      overallConfidence: confidence,
      errors,
    };
  }

  /**
   * Get statistics about the verification system
   */
  getStatistics(): {
    registeredValidators: number;
    activeValidators: number;
  } {
    let activeCount = 0;
    for (const validator of this.validators.values()) {
      if (validator.isActive) activeCount++;
    }

    return {
      registeredValidators: this.validators.size,
      activeValidators: activeCount,
    };
  }
}

// Export singleton instance
export const bridgeVerificationOrchestrator = new BridgeVerificationOrchestrator();
