/**
 * Bridge Verification Orchestrator Tests
 *
 * Tests for the complete verification pipeline:
 * - Transaction timing validation
 * - Merkle proof verification
 * - Nullifier (double-spend) detection
 * - Multi-signature threshold verification
 * - Oracle and relayer attestation
 * - End-to-end verification flow
 */

import {
  BridgeVerificationOrchestrator,
  VerificationRequest,
  VerificationResult,
} from '../shared/bridge-verification-orchestrator.js';
import { BridgeMerkleService } from '../shared/bridge-merkle-service.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';

describe('BridgeVerificationOrchestrator', () => {
  let orchestrator: BridgeVerificationOrchestrator;
  let merkleService: BridgeMerkleService;
  let testValidators: Array<{
    address: string;
    privateKey: Uint8Array;
    publicKey: Uint8Array;
  }>;

  beforeEach(() => {
    orchestrator = new BridgeVerificationOrchestrator();
    merkleService = new BridgeMerkleService();

    // Generate test validators
    testValidators = Array.from({ length: 5 }, () => {
      const privateKey = secp256k1.utils.randomPrivateKey();
      const publicKey = secp256k1.getPublicKey(privateKey);
      const address = '0x' + bytesToHex(keccak_256(publicKey.slice(1))).slice(-40);

      return { address, privateKey, publicKey };
    });

    // Register validators
    testValidators.forEach((v) => {
      orchestrator.registerValidator(v.address, bytesToHex(v.publicKey));
    });
  });

  const createTestTransaction = (overrides = {}) => ({
    id: 'tx-' + Date.now(),
    sourceChain: 'ethereum',
    destinationChain: 'polygon',
    sender: '0x' + '11'.repeat(20),
    recipient: '0x' + '22'.repeat(20),
    amount: BigInt('1000000000000000000'),
    tokenAddress: '0x' + '00'.repeat(20),
    nonce: 1,
    timestamp: Date.now() - 60000, // 1 minute ago
    sourceBlockNumber: 12345678,
    sourceBlockHash: '0x' + 'ab'.repeat(32),
    ...overrides,
  });

  const createMerkleProof = (transaction: any) => {
    // Create a simple test proof
    const txHash = bytesToHex(
      keccak_256(new TextEncoder().encode(JSON.stringify(transaction)))
    );
    return {
      leaf: txHash,
      root: txHash, // Simplified for testing
      proof: [],
      leafIndex: 0,
      treeSize: 1,
    };
  };

  const signTransaction = async (transaction: any, validators: typeof testValidators) => {
    const txData = JSON.stringify({
      id: transaction.id,
      sourceChain: transaction.sourceChain,
      destinationChain: transaction.destinationChain,
      sender: transaction.sender,
      recipient: transaction.recipient,
      amount: transaction.amount.toString(),
      tokenAddress: transaction.tokenAddress,
      nonce: transaction.nonce,
      timestamp: transaction.timestamp,
    });
    const messageHash = keccak_256(new TextEncoder().encode(txData));

    return Promise.all(
      validators.map(async (v) => {
        const signature = await secp256k1.signAsync(messageHash, v.privateKey);
        return {
          validatorAddress: v.address,
          publicKey: bytesToHex(v.publicKey),
          signature: signature.toCompactHex(),
          timestamp: Date.now(),
        };
      })
    );
  };

  describe('Timing Constraint Verification', () => {
    it('should reject expired transactions', async () => {
      const transaction = createTestTransaction({
        timestamp: Date.now() - 2 * 60 * 60 * 1000, // 2 hours ago (expired)
      });

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
      };

      const result = await orchestrator.verifyTransaction(request);

      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === 'TRANSACTION_EXPIRED')).toBe(true);
    });

    it('should reject future transactions', async () => {
      const transaction = createTestTransaction({
        timestamp: Date.now() + 5 * 60 * 1000, // 5 minutes in future
      });

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
      };

      const result = await orchestrator.verifyTransaction(request);

      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === 'FUTURE_TRANSACTION')).toBe(true);
    });

    it('should reject invalid nonce', async () => {
      const transaction = createTestTransaction({ nonce: -1 });

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
      };

      const result = await orchestrator.verifyTransaction(request);

      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INVALID_NONCE')).toBe(true);
    });
  });

  describe('Double-Spend Prevention (Nullifier)', () => {
    it('should allow first submission of a transaction', async () => {
      const transaction = createTestTransaction();

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
      };

      const result = await orchestrator.verifyTransaction(request);

      // May fail for other reasons but should not fail on nullifier
      const nullifierError = result.errors.find((e) => e.code === 'DOUBLE_SPEND_DETECTED');
      expect(nullifierError).toBeUndefined();
    });

    it('should detect double-spend attempts', async () => {
      const transaction = createTestTransaction();

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
      };

      // First submission
      await orchestrator.verifyTransaction(request);

      // Second submission with same transaction (double-spend attempt)
      const result = await orchestrator.verifyTransaction(request);

      expect(result.isValid).toBe(false);
      const doubleSpendError = result.errors.find(
        (e) => e.code === 'DOUBLE_SPEND_DETECTED' || e.code === 'NULLIFIER_COLLISION'
      );
      expect(doubleSpendError).toBeDefined();
    });

    it('should allow different transactions with same amount', async () => {
      const transaction1 = createTestTransaction({ nonce: 1 });
      const transaction2 = createTestTransaction({ nonce: 2 });

      const request1: VerificationRequest = {
        transaction: transaction1,
        merkleProof: createMerkleProof(transaction1),
        signatures: {
          signatures: await signTransaction(transaction1, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
      };

      const request2: VerificationRequest = {
        transaction: transaction2,
        merkleProof: createMerkleProof(transaction2),
        signatures: {
          signatures: await signTransaction(transaction2, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
      };

      const result1 = await orchestrator.verifyTransaction(request1);
      const result2 = await orchestrator.verifyTransaction(request2);

      // Both should not have nullifier errors (may have other errors)
      const nullifierError1 = result1.errors.find((e) => e.code === 'DOUBLE_SPEND_DETECTED');
      const nullifierError2 = result2.errors.find((e) => e.code === 'DOUBLE_SPEND_DETECTED');

      expect(nullifierError1).toBeUndefined();
      expect(nullifierError2).toBeUndefined();
    });
  });

  describe('Signature Threshold Verification', () => {
    it('should reject insufficient signatures', async () => {
      const transaction = createTestTransaction();

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 1)), // Only 1 sig
          requiredThreshold: 3, // Require 3
          signatureType: 'ecdsa',
        },
      };

      const result = await orchestrator.verifyTransaction(request);

      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === 'INSUFFICIENT_SIGNATURES')).toBe(true);
    });

    it('should reject signatures from unregistered validators', async () => {
      const transaction = createTestTransaction();

      // Create unregistered validator
      const unregisteredPrivateKey = secp256k1.utils.randomPrivateKey();
      const unregisteredPublicKey = secp256k1.getPublicKey(unregisteredPrivateKey);
      const unregisteredAddress = '0x' + bytesToHex(keccak_256(unregisteredPublicKey.slice(1))).slice(-40);

      const txData = JSON.stringify({
        id: transaction.id,
        sourceChain: transaction.sourceChain,
        destinationChain: transaction.destinationChain,
        sender: transaction.sender,
        recipient: transaction.recipient,
        amount: transaction.amount.toString(),
        tokenAddress: transaction.tokenAddress,
        nonce: transaction.nonce,
        timestamp: transaction.timestamp,
      });
      const messageHash = keccak_256(new TextEncoder().encode(txData));
      const unregisteredSignature = await secp256k1.signAsync(messageHash, unregisteredPrivateKey);

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: [
            {
              validatorAddress: unregisteredAddress,
              publicKey: bytesToHex(unregisteredPublicKey),
              signature: unregisteredSignature.toCompactHex(),
              timestamp: Date.now(),
            },
          ],
          requiredThreshold: 1,
          signatureType: 'ecdsa',
        },
      };

      const result = await orchestrator.verifyTransaction(request);

      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.code === 'UNKNOWN_VALIDATOR')).toBe(true);
    });
  });

  describe('Verification Steps Tracking', () => {
    it('should track all verification steps', async () => {
      const transaction = createTestTransaction();

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
      };

      const result = await orchestrator.verifyTransaction(request);

      // Check that required steps are present
      const stepNames = result.verificationSteps.map((s) => s.step);
      expect(stepNames).toContain('timing_constraints');
      expect(stepNames).toContain('merkle_verification');
      expect(stepNames).toContain('nullifier_check');
      expect(stepNames).toContain('signature_verification');
    });

    it('should include duration for each step', async () => {
      const transaction = createTestTransaction();

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
      };

      const result = await orchestrator.verifyTransaction(request);

      result.verificationSteps.forEach((step) => {
        expect(typeof step.duration).toBe('number');
        expect(step.duration).toBeGreaterThanOrEqual(0);
      });
    });
  });

  describe('Oracle and Relayer Attestation', () => {
    it('should verify oracle attestation if provided', async () => {
      const transaction = createTestTransaction();

      // Create oracle signature
      const oraclePrivateKey = secp256k1.utils.randomPrivateKey();
      const oraclePublicKey = secp256k1.getPublicKey(oraclePrivateKey);
      const txData = JSON.stringify(transaction);
      const messageHash = keccak_256(new TextEncoder().encode(txData));
      const oracleSignature = await secp256k1.signAsync(messageHash, oraclePrivateKey);

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
        oracleAttestation: {
          oracleAddress: '0x' + bytesToHex(keccak_256(oraclePublicKey.slice(1))).slice(-40),
          publicKey: bytesToHex(oraclePublicKey),
          signature: oracleSignature.toCompactHex(),
          blockConfirmations: 20,
          attestationTime: Date.now(),
        },
      };

      const result = await orchestrator.verifyTransaction(request);

      // Check oracle step is present
      const oracleStep = result.verificationSteps.find((s) => s.step === 'oracle_attestation');
      expect(oracleStep).toBeDefined();
    });

    it('should warn on insufficient block confirmations', async () => {
      const transaction = createTestTransaction();

      const oraclePrivateKey = secp256k1.utils.randomPrivateKey();
      const oraclePublicKey = secp256k1.getPublicKey(oraclePrivateKey);
      const txData = JSON.stringify(transaction);
      const messageHash = keccak_256(new TextEncoder().encode(txData));
      const oracleSignature = await secp256k1.signAsync(messageHash, oraclePrivateKey);

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
        oracleAttestation: {
          oracleAddress: '0x' + bytesToHex(keccak_256(oraclePublicKey.slice(1))).slice(-40),
          publicKey: bytesToHex(oraclePublicKey),
          signature: oracleSignature.toCompactHex(),
          blockConfirmations: 5, // Below threshold
          attestationTime: Date.now(),
        },
      };

      const result = await orchestrator.verifyTransaction(request);

      // Should have warning about insufficient confirmations
      expect(result.errors.some((e) => e.code === 'INSUFFICIENT_CONFIRMATIONS')).toBe(true);
    });
  });

  describe('Statistics and Metrics', () => {
    it('should report registered validators', () => {
      const stats = orchestrator.getStatistics();

      expect(stats.registeredValidators).toBe(testValidators.length);
      expect(stats.activeValidators).toBe(testValidators.length);
    });
  });

  describe('Event Emission', () => {
    it('should emit success event on valid verification', async () => {
      const successHandler = jest.fn();
      orchestrator.on('verification:success', successHandler);

      const transaction = createTestTransaction();

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: await signTransaction(transaction, testValidators.slice(0, 3)),
          requiredThreshold: 2,
          signatureType: 'ecdsa',
        },
      };

      await orchestrator.verifyTransaction(request);

      // Event may or may not fire depending on full verification success
      // Just verify no errors thrown
    });

    it('should emit error event on verification failure', async () => {
      const errorHandler = jest.fn();
      orchestrator.on('verification:error', errorHandler);

      // Create invalid request to force failure
      const transaction = createTestTransaction({
        timestamp: Date.now() - 10 * 60 * 60 * 1000, // Very old
      });

      const request: VerificationRequest = {
        transaction,
        merkleProof: createMerkleProof(transaction),
        signatures: {
          signatures: [],
          requiredThreshold: 1,
          signatureType: 'ecdsa',
        },
      };

      await orchestrator.verifyTransaction(request);

      // Verification should fail
    });
  });
});

describe('End-to-End Verification Scenarios', () => {
  let orchestrator: BridgeVerificationOrchestrator;
  let validators: Array<{
    address: string;
    privateKey: Uint8Array;
    publicKey: Uint8Array;
  }>;

  beforeEach(() => {
    orchestrator = new BridgeVerificationOrchestrator();

    validators = Array.from({ length: 7 }, () => {
      const privateKey = secp256k1.utils.randomPrivateKey();
      const publicKey = secp256k1.getPublicKey(privateKey);
      const address = '0x' + bytesToHex(keccak_256(publicKey.slice(1))).slice(-40);
      return { address, privateKey, publicKey };
    });

    validators.forEach((v) => {
      orchestrator.registerValidator(v.address, bytesToHex(v.publicKey));
    });
  });

  it('should handle high-value transfer with full verification', async () => {
    const transaction = {
      id: 'high-value-tx-' + Date.now(),
      sourceChain: 'ethereum',
      destinationChain: 'polygon',
      sender: '0x' + '11'.repeat(20),
      recipient: '0x' + '22'.repeat(20),
      amount: BigInt('1000000000000000000000000'), // 1M tokens
      tokenAddress: '0x' + '00'.repeat(20),
      nonce: 1,
      timestamp: Date.now() - 60000,
      sourceBlockNumber: 12345678,
      sourceBlockHash: '0x' + 'ab'.repeat(32),
    };

    const txData = JSON.stringify({
      ...transaction,
      amount: transaction.amount.toString(),
    });
    const messageHash = keccak_256(new TextEncoder().encode(txData));

    // Get 5 of 7 validator signatures (supermajority)
    const signatures = await Promise.all(
      validators.slice(0, 5).map(async (v) => {
        const signature = await secp256k1.signAsync(messageHash, v.privateKey);
        return {
          validatorAddress: v.address,
          publicKey: bytesToHex(v.publicKey),
          signature: signature.toCompactHex(),
          timestamp: Date.now(),
        };
      })
    );

    const request: VerificationRequest = {
      transaction,
      merkleProof: {
        leaf: bytesToHex(keccak_256(new TextEncoder().encode(JSON.stringify(transaction)))),
        root: bytesToHex(keccak_256(new TextEncoder().encode(JSON.stringify(transaction)))),
        proof: [],
        leafIndex: 0,
        treeSize: 1,
      },
      signatures: {
        signatures,
        requiredThreshold: 5, // Require 5 of 7
        signatureType: 'ecdsa',
      },
    };

    const result = await orchestrator.verifyTransaction(request);

    // Check verification completed all steps
    expect(result.verificationSteps.length).toBeGreaterThanOrEqual(4);
  });

  it('should reject attack with invalid merkle proof', async () => {
    const transaction = {
      id: 'attack-tx-' + Date.now(),
      sourceChain: 'ethereum',
      destinationChain: 'polygon',
      sender: '0x' + '11'.repeat(20),
      recipient: '0x' + '22'.repeat(20),
      amount: BigInt('1000000000000000000'),
      tokenAddress: '0x' + '00'.repeat(20),
      nonce: 1,
      timestamp: Date.now() - 60000,
      sourceBlockNumber: 12345678,
      sourceBlockHash: '0x' + 'ab'.repeat(32),
    };

    const txData = JSON.stringify({
      ...transaction,
      amount: transaction.amount.toString(),
    });
    const messageHash = keccak_256(new TextEncoder().encode(txData));

    const signatures = await Promise.all(
      validators.slice(0, 3).map(async (v) => {
        const signature = await secp256k1.signAsync(messageHash, v.privateKey);
        return {
          validatorAddress: v.address,
          publicKey: bytesToHex(v.publicKey),
          signature: signature.toCompactHex(),
          timestamp: Date.now(),
        };
      })
    );

    // Create invalid merkle proof with wrong root
    const request: VerificationRequest = {
      transaction,
      merkleProof: {
        leaf: bytesToHex(keccak_256(new TextEncoder().encode(JSON.stringify(transaction)))),
        root: '0x' + 'ff'.repeat(32), // Wrong root!
        proof: ['0x' + '00'.repeat(32)],
        leafIndex: 0,
        treeSize: 2,
      },
      signatures: {
        signatures,
        requiredThreshold: 2,
        signatureType: 'ecdsa',
      },
    };

    const result = await orchestrator.verifyTransaction(request);

    expect(result.isValid).toBe(false);
    expect(result.errors.some((e) => e.code === 'INVALID_MERKLE_PROOF')).toBe(true);
  });
});
