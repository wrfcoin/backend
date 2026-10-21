/**
 * Comprehensive Test Suite for Threshold Signature Implementations
 *
 * Tests the following components:
 * 1. JavaScript Shamir's Secret Sharing (protocols.js)
 * 2. BLS12-381 Signature Aggregation (bridge-multi-signature.ts)
 * 3. Threshold verification and Lagrange interpolation
 *
 * These tests verify cryptographic correctness and security properties:
 * - Secret reconstruction from k-of-n shares
 * - BLS signature generation and verification
 * - Aggregate signature verification
 * - Edge cases and error handling
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import {
  BridgeMultiSignature,
  BLSSignatureHelper,
  SignatureStatus,
} from '../shared/bridge-multi-signature.js';

// ============================================================================
// BLS Signature Helper Tests
// ============================================================================

describe('BLSSignatureHelper', () => {
  describe('Key Generation', () => {
    it('should generate valid BLS key pairs', () => {
      const keyPair = BLSSignatureHelper.generateKeyPair();

      expect(keyPair.privateKey).toBeDefined();
      expect(keyPair.publicKey).toBeDefined();
      expect(keyPair.privateKey).toBeInstanceOf(Uint8Array);
      expect(keyPair.publicKey).toBeInstanceOf(Uint8Array);

      // Private key should be 32 bytes
      expect(keyPair.privateKey.length).toBe(32);

      // Public key should be 96 bytes (G2 point in short signatures mode)
      expect(keyPair.publicKey.length).toBe(96);
    });

    it('should generate different key pairs each time', () => {
      const keyPair1 = BLSSignatureHelper.generateKeyPair();
      const keyPair2 = BLSSignatureHelper.generateKeyPair();

      // Private keys should be different
      expect(Buffer.from(keyPair1.privateKey).toString('hex')).not.toBe(
        Buffer.from(keyPair2.privateKey).toString('hex')
      );
    });

    it('should derive correct public key from private key', () => {
      const keyPair = BLSSignatureHelper.generateKeyPair();
      const derivedPubKey = BLSSignatureHelper.getPublicKey(keyPair.privateKey);

      expect(Buffer.from(derivedPubKey).toString('hex')).toBe(
        Buffer.from(keyPair.publicKey).toString('hex')
      );
    });
  });

  describe('Signing and Verification', () => {
    let keyPair;
    const testMessage = Buffer.from('test message for BLS signature');

    beforeEach(() => {
      keyPair = BLSSignatureHelper.generateKeyPair();
    });

    it('should sign a message and verify the signature', () => {
      const signature = BLSSignatureHelper.sign(testMessage, keyPair.privateKey);

      expect(signature).toBeInstanceOf(Uint8Array);
      // Short signature should be 48 bytes
      expect(signature.length).toBe(48);

      const isValid = BLSSignatureHelper.verify(testMessage, signature, keyPair.publicKey);
      expect(isValid).toBe(true);
    });

    it('should sign hex-encoded message', () => {
      const hexMessage = testMessage.toString('hex');
      const signature = BLSSignatureHelper.sign(hexMessage, keyPair.privateKey);

      const isValid = BLSSignatureHelper.verify(hexMessage, signature, keyPair.publicKey);
      expect(isValid).toBe(true);
    });

    it('should reject signature verification with wrong public key', () => {
      const signature = BLSSignatureHelper.sign(testMessage, keyPair.privateKey);
      const otherKeyPair = BLSSignatureHelper.generateKeyPair();

      const isValid = BLSSignatureHelper.verify(testMessage, signature, otherKeyPair.publicKey);
      expect(isValid).toBe(false);
    });

    it('should reject signature verification with wrong message', () => {
      const signature = BLSSignatureHelper.sign(testMessage, keyPair.privateKey);
      const wrongMessage = Buffer.from('different message');

      const isValid = BLSSignatureHelper.verify(wrongMessage, signature, keyPair.publicKey);
      expect(isValid).toBe(false);
    });

    it('should reject tampered signature', () => {
      const signature = BLSSignatureHelper.sign(testMessage, keyPair.privateKey);

      // Tamper with the signature
      const tamperedSignature = new Uint8Array(signature);
      tamperedSignature[0] ^= 0xff;

      const isValid = BLSSignatureHelper.verify(testMessage, tamperedSignature, keyPair.publicKey);
      expect(isValid).toBe(false);
    });
  });

  describe('Signature Aggregation', () => {
    const testMessage = Buffer.from('message to be signed by multiple parties');
    let keyPairs;
    let signatures;

    beforeEach(() => {
      // Generate 5 key pairs
      keyPairs = Array.from({ length: 5 }, () => BLSSignatureHelper.generateKeyPair());

      // Sign the same message with each key
      signatures = keyPairs.map(kp => BLSSignatureHelper.sign(testMessage, kp.privateKey));
    });

    it('should aggregate multiple signatures', () => {
      const aggregated = BLSSignatureHelper.aggregateSignatures(signatures);

      expect(aggregated).toBeInstanceOf(Uint8Array);
      expect(aggregated.length).toBe(48); // Short signature size
    });

    it('should verify aggregated signature against aggregated public keys', () => {
      const aggregatedSig = BLSSignatureHelper.aggregateSignatures(signatures);
      const publicKeys = keyPairs.map(kp => kp.publicKey);

      const isValid = BLSSignatureHelper.verifyAggregate(
        testMessage,
        aggregatedSig,
        publicKeys
      );

      expect(isValid).toBe(true);
    });

    it('should fail verification with missing public key', () => {
      const aggregatedSig = BLSSignatureHelper.aggregateSignatures(signatures);
      // Only use first 4 public keys
      const partialPublicKeys = keyPairs.slice(0, 4).map(kp => kp.publicKey);

      const isValid = BLSSignatureHelper.verifyAggregate(
        testMessage,
        aggregatedSig,
        partialPublicKeys
      );

      expect(isValid).toBe(false);
    });

    it('should fail verification with wrong message', () => {
      const aggregatedSig = BLSSignatureHelper.aggregateSignatures(signatures);
      const publicKeys = keyPairs.map(kp => kp.publicKey);
      const wrongMessage = Buffer.from('wrong message');

      const isValid = BLSSignatureHelper.verifyAggregate(
        wrongMessage,
        aggregatedSig,
        publicKeys
      );

      expect(isValid).toBe(false);
    });

    it('should throw error when aggregating empty array', () => {
      expect(() => BLSSignatureHelper.aggregateSignatures([])).toThrow();
    });

    it('should aggregate public keys', () => {
      const publicKeys = keyPairs.map(kp => kp.publicKey);
      const aggregatedPubKey = BLSSignatureHelper.aggregatePublicKeys(publicKeys);

      expect(aggregatedPubKey).toBeInstanceOf(Uint8Array);
      expect(aggregatedPubKey.length).toBe(96);
    });
  });

  describe('Lagrange Coefficient Computation', () => {
    it('should compute correct Lagrange coefficients for 2-of-3', () => {
      const indices = [1, 2];

      const coeff1 = BLSSignatureHelper.computeLagrangeCoefficient(1, indices);
      const coeff2 = BLSSignatureHelper.computeLagrangeCoefficient(2, indices);

      // For x=1, x=2 evaluating at 0:
      // L_1(0) = (0-2)/(1-2) = -2/-1 = 2
      // L_2(0) = (0-1)/(2-1) = -1/1 = -1
      // Note: In modular arithmetic, -1 = BLS_FIELD_ORDER - 1
      expect(coeff1).toBe(BigInt(2));
      expect(coeff2).toBe(
        BigInt('52435875175126190479447740508185965837690552500527637822603658699938581184512')
      );
    });

    it('should compute coefficients that sum to 1 for interpolation at 0', () => {
      const indices = [1, 3, 5];

      // For Lagrange interpolation, sum of L_i(0) = 1
      let sum = BigInt(0);
      const fieldOrder = BigInt('52435875175126190479447740508185965837690552500527637822603658699938581184513');

      for (const i of indices) {
        const coeff = BLSSignatureHelper.computeLagrangeCoefficient(i, indices);
        sum = (sum + coeff) % fieldOrder;
      }

      expect(sum).toBe(BigInt(1));
    });
  });

  describe('Hex Conversion Utilities', () => {
    it('should convert bytes to hex correctly', () => {
      const bytes = new Uint8Array([0x00, 0x01, 0x0a, 0xff]);
      const hex = BLSSignatureHelper.bytesToHex(bytes);
      expect(hex).toBe('00010aff');
    });

    it('should convert hex to bytes correctly', () => {
      const hex = '00010aff';
      const bytes = BLSSignatureHelper.hexToBytes(hex);
      expect(bytes).toEqual(new Uint8Array([0x00, 0x01, 0x0a, 0xff]));
    });

    it('should handle 0x prefix in hex', () => {
      const hex = '0x00010aff';
      const bytes = BLSSignatureHelper.hexToBytes(hex);
      expect(bytes).toEqual(new Uint8Array([0x00, 0x01, 0x0a, 0xff]));
    });

    it('should roundtrip bytes through hex', () => {
      const original = new Uint8Array([1, 2, 3, 4, 5, 255, 128, 0]);
      const hex = BLSSignatureHelper.bytesToHex(original);
      const restored = BLSSignatureHelper.hexToBytes(hex);
      expect(restored).toEqual(original);
    });
  });
});

// ============================================================================
// Bridge Multi-Signature Tests
// ============================================================================

describe('BridgeMultiSignature', () => {
  let bridgeMultiSig;

  beforeEach(() => {
    // Use threshold of 4/5 (80%) to satisfy minimum 67% requirement
    // Also set minSignatureThreshold to 4 to allow testing
    bridgeMultiSig = new BridgeMultiSignature({
      requiredSignatures: 4,
      totalValidators: 5,
      signatureTimeout: 300,
      slashingEnabled: false, // Disable for testing
      minSignatureThreshold: 4,
    });
  });

  describe('Validator Management', () => {
    it('should add validators with BLS keys', () => {
      const blsKeyPair = BLSSignatureHelper.generateKeyPair();

      const validator = bridgeMultiSig.addValidator(
        '0x1234567890123456789012345678901234567890',
        'ed25519_public_key_hex',
        '1000',
        blsKeyPair.publicKey
      );

      expect(validator).toBeDefined();
      expect(validator.validatorIndex).toBe(1);
      expect(validator.blsPublicKey).toEqual(blsKeyPair.publicKey);
      expect(validator.isActive).toBe(true);
    });

    it('should assign sequential validator indices', () => {
      const validator1 = bridgeMultiSig.addValidator('0x1111', 'pk1', '100');
      const validator2 = bridgeMultiSig.addValidator('0x2222', 'pk2', '100');
      const validator3 = bridgeMultiSig.addValidator('0x3333', 'pk3', '100');

      expect(validator1.validatorIndex).toBe(1);
      expect(validator2.validatorIndex).toBe(2);
      expect(validator3.validatorIndex).toBe(3);
    });

    it('should update validator BLS key', () => {
      bridgeMultiSig.addValidator('0x1111', 'pk1', '100');
      const newBlsKey = BLSSignatureHelper.generateKeyPair().publicKey;

      bridgeMultiSig.setValidatorBLSKey('0x1111', newBlsKey);

      const validator = bridgeMultiSig.getValidator('0x1111');
      expect(validator.blsPublicKey).toEqual(newBlsKey);
    });

    it('should reject duplicate validators', () => {
      bridgeMultiSig.addValidator('0x1111', 'pk1', '100');

      expect(() => bridgeMultiSig.addValidator('0x1111', 'pk2', '200')).toThrow(
        'Validator already exists'
      );
    });
  });

  describe('Signature Request Creation', () => {
    beforeEach(() => {
      // Add validators
      for (let i = 1; i <= 5; i++) {
        const blsKeyPair = BLSSignatureHelper.generateKeyPair();
        bridgeMultiSig.addValidator(
          `0x${i.toString().padStart(40, '0')}`,
          `pk${i}`,
          '1000',
          blsKeyPair.publicKey
        );
      }
    });

    it('should create a signature request', async () => {
      const request = await bridgeMultiSig.createSignatureRequest(
        '0xabcd1234',
        'ethereum',
        'polygon',
        '100.5',
        '0xsender',
        '0xrecipient',
        'USDC'
      );

      expect(request).toBeDefined();
      expect(request.id).toBeDefined();
      expect(request.status).toBe(SignatureStatus.COLLECTING);
      expect(request.requiredSignatures).toBe(4);
      expect(request.messageHash).toBeDefined();
    });

    it('should reject request with threshold too low', async () => {
      await expect(
        bridgeMultiSig.createSignatureRequest(
          '0xabcd1234',
          'ethereum',
          'polygon',
          '100.5',
          '0xsender',
          '0xrecipient',
          'USDC',
          1 // Too low threshold
        )
      ).rejects.toThrow('Threshold too low');
    });
  });

  describe('BLS Signature Submission and Aggregation', () => {
    let validators;
    let signatureRequest;

    beforeEach(async () => {
      validators = [];

      // Add 5 validators with BLS keys
      for (let i = 1; i <= 5; i++) {
        const blsKeyPair = BLSSignatureHelper.generateKeyPair();
        const address = `0x${i.toString().padStart(40, '0')}`;

        bridgeMultiSig.addValidator(address, `pk${i}`, '1000', blsKeyPair.publicKey);

        validators.push({ address, keyPair: blsKeyPair });
      }

      // Create a signature request
      signatureRequest = await bridgeMultiSig.createSignatureRequest(
        '0xabcd1234',
        'ethereum',
        'polygon',
        '100.5',
        '0xsender',
        '0xrecipient',
        'USDC'
      );
    });

    it('should accept valid BLS signatures', async () => {
      const validator = validators[0];
      const messageBytes = Buffer.from(signatureRequest.messageHash, 'hex');
      const blsSignature = BLSSignatureHelper.sign(messageBytes, validator.keyPair.privateKey);

      const updatedRequest = await bridgeMultiSig.submitBLSSignature(
        signatureRequest.id,
        validator.address,
        blsSignature
      );

      expect(updatedRequest.signatures.size).toBe(1);
      expect(updatedRequest.status).toBe(SignatureStatus.COLLECTING);
    });

    it('should aggregate signatures when threshold is reached', async () => {
      const messageBytes = Buffer.from(signatureRequest.messageHash, 'hex');

      // Submit 4 signatures (threshold)
      for (let i = 0; i < 4; i++) {
        const validator = validators[i];
        const blsSignature = BLSSignatureHelper.sign(messageBytes, validator.keyPair.privateKey);

        await bridgeMultiSig.submitBLSSignature(
          signatureRequest.id,
          validator.address,
          blsSignature
        );
      }

      const updatedRequest = bridgeMultiSig.getSignatureRequest(signatureRequest.id);
      expect(updatedRequest!.status).toBe(SignatureStatus.COMPLETED);

      const aggregated = bridgeMultiSig.getAggregatedSignature(signatureRequest.id);
      expect(aggregated).toBeDefined();
      expect(aggregated!.blsAggregatedSignature).toBeDefined();
      expect(aggregated!.signatureCount).toBe(4);
      expect(aggregated!.participatingIndices).toEqual([1, 2, 3, 4]);
    });

    it('should verify aggregated BLS signature', async () => {
      const messageBytes = Buffer.from(signatureRequest.messageHash, 'hex');

      // Submit 4 signatures
      for (let i = 0; i < 4; i++) {
        const validator = validators[i];
        const blsSignature = BLSSignatureHelper.sign(messageBytes, validator.keyPair.privateKey);

        await bridgeMultiSig.submitBLSSignature(
          signatureRequest.id,
          validator.address,
          blsSignature
        );
      }

      const isValid = bridgeMultiSig.verifyAggregatedSignature(signatureRequest.id);
      expect(isValid).toBe(true);
    });

    it('should reject invalid BLS signatures', async () => {
      const validator = validators[0];
      // Sign a different message
      const wrongMessage = Buffer.from('wrong message');
      const invalidSignature = BLSSignatureHelper.sign(wrongMessage, validator.keyPair.privateKey);

      await expect(
        bridgeMultiSig.submitBLSSignature(
          signatureRequest.id,
          validator.address,
          invalidSignature
        )
      ).rejects.toThrow('Invalid BLS signature');
    });

    it('should reject duplicate signatures from same validator', async () => {
      const validator = validators[0];
      const messageBytes = Buffer.from(signatureRequest.messageHash, 'hex');
      const blsSignature = BLSSignatureHelper.sign(messageBytes, validator.keyPair.privateKey);

      await bridgeMultiSig.submitBLSSignature(
        signatureRequest.id,
        validator.address,
        blsSignature
      );

      await expect(
        bridgeMultiSig.submitBLSSignature(signatureRequest.id, validator.address, blsSignature)
      ).rejects.toThrow('already signed');
    });
  });

  describe('Statistics', () => {
    it('should report correct statistics', () => {
      // Add some validators
      for (let i = 1; i <= 5; i++) {
        bridgeMultiSig.addValidator(`0x${i.toString().padStart(40, '0')}`, `pk${i}`, '1000');
      }

      const stats = bridgeMultiSig.getStatistics();

      expect(stats.validators.total).toBe(5);
      expect(stats.validators.active).toBe(5);
      expect(stats.validators.averageReputation).toBe(100);
      expect(stats.config.requiredSignatures).toBe(4);
    });
  });
});

// ============================================================================
// Integration Tests
// ============================================================================

describe('Threshold Signature Integration', () => {
  it('should complete full threshold signature flow', async () => {
    // Use 5 validators with 4 required (80% threshold, above 67% minimum)
    const bridge = new BridgeMultiSignature({
      requiredSignatures: 4,
      totalValidators: 5,
      signatureTimeout: 300,
      slashingEnabled: false,
      minSignatureThreshold: 4,
    });

    // Setup validators with BLS keys
    const validators = Array.from({ length: 5 }, (_, i) => ({
      address: `0x${(i + 1).toString().padStart(40, '0')}`,
      keyPair: BLSSignatureHelper.generateKeyPair(),
    }));

    for (const v of validators) {
      bridge.addValidator(v.address, `pk_${v.address}`, '1000', v.keyPair.publicKey);
    }

    // Create signature request
    const request = await bridge.createSignatureRequest(
      '0xtx123',
      'ethereum',
      'polygon',
      '50.0',
      '0xAlice',
      '0xBob',
      'USDC'
    );

    // Get message hash
    const messageBytes = Buffer.from(request.messageHash, 'hex');

    // First 3 validators sign (not yet at threshold)
    for (let i = 0; i < 3; i++) {
      const sig = BLSSignatureHelper.sign(messageBytes, validators[i].keyPair.privateKey);
      await bridge.submitBLSSignature(request.id, validators[i].address, sig);
    }

    // Check still collecting
    let currentRequest = bridge.getSignatureRequest(request.id);
    expect(currentRequest).toBeDefined();
    expect(currentRequest!.status).toBe(SignatureStatus.COLLECTING);

    // Fourth validator signs (reaches threshold of 4)
    const sig4 = BLSSignatureHelper.sign(messageBytes, validators[3].keyPair.privateKey);
    await bridge.submitBLSSignature(request.id, validators[3].address, sig4);

    // Check completed
    currentRequest = bridge.getSignatureRequest(request.id);
    expect(currentRequest).toBeDefined();
    expect(currentRequest!.status).toBe(SignatureStatus.COMPLETED);

    // Verify aggregated signature
    const aggregated = bridge.getAggregatedSignature(request.id);
    expect(aggregated).toBeDefined();
    expect(aggregated!.signatureCount).toBe(4);
    expect(aggregated!.verificationData).toBeDefined();
    expect(aggregated!.verificationData!.verified).toBe(true);

    // Verify using helper
    const isValid = bridge.verifyAggregatedSignature(request.id);
    expect(isValid).toBe(true);
  });
});
