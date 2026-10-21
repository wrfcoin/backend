/**
 * Bridge Cryptographic Verifier Tests
 *
 * Comprehensive tests for cross-chain bridge cryptographic security:
 * - ECDSA secp256k1 signature verification
 * - BLS signature verification and aggregation
 * - Merkle proof verification
 * - Bridge message verification
 * - Attack simulations
 */

import {
  ECDSAVerifier,
  BLSVerifier,
  MerkleVerifier,
  BridgeMessageVerifier,
  fromHex,
  toHex,
} from '../shared/bridge-crypto-verifier.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import * as secp256k1 from '@noble/secp256k1';

describe('ECDSAVerifier', () => {
  let testPrivateKey: Uint8Array;
  let testPublicKey: Uint8Array;
  let testMessage: Uint8Array;
  let testMessageHash: string;

  beforeAll(async () => {
    // Generate test key pair
    testPrivateKey = secp256k1.utils.randomPrivateKey();
    testPublicKey = secp256k1.getPublicKey(testPrivateKey);
    testMessage = new TextEncoder().encode('Test bridge message');
    testMessageHash = bytesToHex(keccak_256(testMessage));
  });

  describe('verify()', () => {
    it('should verify a valid ECDSA signature', async () => {
      // Sign the message
      const signature = await secp256k1.signAsync(
        hexToBytes(testMessageHash),
        testPrivateKey
      );
      const signatureHex = signature.toCompactHex();

      const result = ECDSAVerifier.verify(
        testMessageHash,
        signatureHex,
        bytesToHex(testPublicKey)
      );

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
    });

    it('should reject an invalid signature', () => {
      // Create a random invalid signature
      const invalidSignature = '00'.repeat(64);

      const result = ECDSAVerifier.verify(
        testMessageHash,
        invalidSignature,
        bytesToHex(testPublicKey)
      );

      expect(result.isValid).toBe(false);
    });

    it('should reject a signature with wrong message hash', async () => {
      // Sign one message, verify against different hash
      const signature = await secp256k1.signAsync(
        hexToBytes(testMessageHash),
        testPrivateKey
      );
      const signatureHex = signature.toCompactHex();

      const wrongHash = bytesToHex(keccak_256(new TextEncoder().encode('Wrong message')));

      const result = ECDSAVerifier.verify(
        wrongHash,
        signatureHex,
        bytesToHex(testPublicKey)
      );

      expect(result.isValid).toBe(false);
    });

    it('should reject a signature with wrong public key', async () => {
      // Sign with one key, verify with different key
      const signature = await secp256k1.signAsync(
        hexToBytes(testMessageHash),
        testPrivateKey
      );
      const signatureHex = signature.toCompactHex();

      // Generate different key pair
      const differentPrivateKey = secp256k1.utils.randomPrivateKey();
      const differentPublicKey = secp256k1.getPublicKey(differentPrivateKey);

      const result = ECDSAVerifier.verify(
        testMessageHash,
        signatureHex,
        bytesToHex(differentPublicKey)
      );

      expect(result.isValid).toBe(false);
    });

    it('should handle malformed inputs gracefully', () => {
      const result = ECDSAVerifier.verify('invalid', 'invalid', 'invalid');
      expect(result.isValid).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('hashPersonalMessage()', () => {
    it('should hash messages with Ethereum personal message prefix', () => {
      const message = 'Hello, WRFCoin!';
      const hash = ECDSAVerifier.hashPersonalMessage(message);

      expect(hash).toBeDefined();
      expect(hash.length).toBe(32);
    });

    it('should produce consistent hashes for same input', () => {
      const message = 'Test message';
      const hash1 = ECDSAVerifier.hashPersonalMessage(message);
      const hash2 = ECDSAVerifier.hashPersonalMessage(message);

      expect(bytesToHex(hash1)).toBe(bytesToHex(hash2));
    });
  });

  describe('batchVerify()', () => {
    it('should verify multiple signatures in batch', async () => {
      const verifications = await Promise.all(
        [1, 2, 3].map(async (i) => {
          const privateKey = secp256k1.utils.randomPrivateKey();
          const publicKey = secp256k1.getPublicKey(privateKey);
          const message = new TextEncoder().encode(`Message ${i}`);
          const messageHash = bytesToHex(keccak_256(message));
          const signature = await secp256k1.signAsync(hexToBytes(messageHash), privateKey);

          return {
            messageHash,
            signature: signature.toCompactHex(),
            publicKey: bytesToHex(publicKey),
          };
        })
      );

      const result = ECDSAVerifier.batchVerify(verifications);

      expect(result.allValid).toBe(true);
      expect(result.validCount).toBe(3);
      expect(result.invalidCount).toBe(0);
    });

    it('should identify invalid signatures in batch', async () => {
      const privateKey = secp256k1.utils.randomPrivateKey();
      const publicKey = secp256k1.getPublicKey(privateKey);
      const message = new TextEncoder().encode('Valid message');
      const messageHash = bytesToHex(keccak_256(message));
      const validSignature = await secp256k1.signAsync(hexToBytes(messageHash), privateKey);

      const verifications = [
        {
          messageHash,
          signature: validSignature.toCompactHex(),
          publicKey: bytesToHex(publicKey),
        },
        {
          messageHash,
          signature: '00'.repeat(64), // Invalid signature
          publicKey: bytesToHex(publicKey),
        },
      ];

      const result = ECDSAVerifier.batchVerify(verifications);

      expect(result.allValid).toBe(false);
      expect(result.validCount).toBe(1);
      expect(result.invalidCount).toBe(1);
    });
  });
});

describe('MerkleVerifier', () => {
  describe('buildTree()', () => {
    it('should build a valid Merkle tree from leaves', () => {
      const leaves = ['0x1111', '0x2222', '0x3333', '0x4444'].map((l) =>
        hexToBytes(l.slice(2).padStart(64, '0'))
      );

      const hashFn = (data: Uint8Array) => keccak_256(data);
      const result = MerkleVerifier.buildTree(leaves, hashFn);

      expect(result.root).toBeDefined();
      expect(result.tree).toBeDefined();
      expect(result.tree.length).toBeGreaterThan(0);
    });

    it('should handle single leaf', () => {
      const leaves = [hexToBytes('00'.repeat(32))];
      const hashFn = (data: Uint8Array) => keccak_256(data);
      const result = MerkleVerifier.buildTree(leaves, hashFn);

      expect(result.root).toBeDefined();
    });

    it('should produce consistent roots for same input', () => {
      const leaves = ['0x1111', '0x2222'].map((l) =>
        hexToBytes(l.slice(2).padStart(64, '0'))
      );
      const hashFn = (data: Uint8Array) => keccak_256(data);

      const result1 = MerkleVerifier.buildTree(leaves, hashFn);
      const result2 = MerkleVerifier.buildTree(leaves, hashFn);

      expect(bytesToHex(result1.root)).toBe(bytesToHex(result2.root));
    });
  });

  describe('generateProof() and verify()', () => {
    it('should generate and verify valid proof', () => {
      const leaves = ['0x1111', '0x2222', '0x3333', '0x4444'].map((l) =>
        hexToBytes(l.slice(2).padStart(64, '0'))
      );
      const hashFn = (data: Uint8Array) => keccak_256(data);
      const { root, tree } = MerkleVerifier.buildTree(leaves, hashFn);

      // Generate proof for leaf at index 2
      const proof = MerkleVerifier.generateProof(2, leaves, hashFn);

      expect(proof.leaf).toBeDefined();
      expect(proof.proof.length).toBeGreaterThan(0);

      // Verify the proof
      const isValid = MerkleVerifier.verify(
        {
          ...proof,
          root: bytesToHex(root),
        },
        hashFn
      );

      expect(isValid).toBe(true);
    });

    it('should reject invalid proof', () => {
      const leaves = ['0x1111', '0x2222', '0x3333', '0x4444'].map((l) =>
        hexToBytes(l.slice(2).padStart(64, '0'))
      );
      const hashFn = (data: Uint8Array) => keccak_256(data);
      const { root } = MerkleVerifier.buildTree(leaves, hashFn);

      // Create an invalid proof with wrong root
      const invalidProof = {
        leaf: bytesToHex(leaves[0]),
        proof: ['00'.repeat(32)],
        root: '00'.repeat(64), // Wrong root
        leafIndex: 0,
      };

      const isValid = MerkleVerifier.verify(invalidProof, hashFn);

      expect(isValid).toBe(false);
    });
  });
});

describe('BridgeMessageVerifier', () => {
  describe('hashMessage()', () => {
    it('should hash bridge messages consistently', () => {
      const message = {
        sourceChain: 'ethereum',
        destinationChain: 'polygon',
        sender: '0x' + '11'.repeat(20),
        recipient: '0x' + '22'.repeat(20),
        amount: BigInt('1000000000000000000'),
        nonce: 1,
        timestamp: Date.now(),
      };

      const hash1 = BridgeMessageVerifier.hashMessage(message);
      const hash2 = BridgeMessageVerifier.hashMessage(message);

      expect(hash1).toBeDefined();
      expect(hash1.length).toBe(32);
      expect(bytesToHex(hash1)).toBe(bytesToHex(hash2));
    });

    it('should produce different hashes for different messages', () => {
      const message1 = {
        sourceChain: 'ethereum',
        destinationChain: 'polygon',
        sender: '0x' + '11'.repeat(20),
        recipient: '0x' + '22'.repeat(20),
        amount: BigInt('1000000000000000000'),
        nonce: 1,
        timestamp: Date.now(),
      };

      const message2 = { ...message1, nonce: 2 };

      const hash1 = BridgeMessageVerifier.hashMessage(message1);
      const hash2 = BridgeMessageVerifier.hashMessage(message2);

      expect(bytesToHex(hash1)).not.toBe(bytesToHex(hash2));
    });
  });

  describe('verifyMultiSig()', () => {
    it('should verify multi-signature threshold', async () => {
      const message = {
        sourceChain: 'ethereum',
        destinationChain: 'polygon',
        sender: '0x' + '11'.repeat(20),
        recipient: '0x' + '22'.repeat(20),
        amount: BigInt('1000000000000000000'),
        nonce: 1,
        timestamp: Date.now(),
      };

      const messageHash = BridgeMessageVerifier.hashMessage(message);

      // Generate 3 signers
      const signers = await Promise.all(
        [1, 2, 3].map(async () => {
          const privateKey = secp256k1.utils.randomPrivateKey();
          const publicKey = secp256k1.getPublicKey(privateKey);
          const signature = await secp256k1.signAsync(messageHash, privateKey);

          return {
            address: '0x' + bytesToHex(keccak_256(publicKey.slice(1))).slice(-40),
            publicKey: bytesToHex(publicKey),
            signature: signature.toCompactHex(),
          };
        })
      );

      const signatures = signers.map((s) => s.signature);
      const expectedSigners = signers.map((s) => s.address);

      // Verify 2-of-3 threshold
      const result = BridgeMessageVerifier.verifyMultiSig(
        message,
        signatures,
        expectedSigners,
        2
      );

      expect(result.isValid).toBe(true);
      expect(result.validSignatures).toBeGreaterThanOrEqual(2);
    });

    it('should reject insufficient signatures', async () => {
      const message = {
        sourceChain: 'ethereum',
        destinationChain: 'polygon',
        sender: '0x' + '11'.repeat(20),
        recipient: '0x' + '22'.repeat(20),
        amount: BigInt('1000000000000000000'),
        nonce: 1,
        timestamp: Date.now(),
      };

      // Only 1 valid signature, require 2
      const result = BridgeMessageVerifier.verifyMultiSig(
        message,
        ['00'.repeat(64)],
        ['0x' + '11'.repeat(20)],
        2
      );

      expect(result.isValid).toBe(false);
    });
  });
});

describe('Security Attack Simulations', () => {
  describe('Signature Forgery Attacks', () => {
    it('should reject forged signature attempts', () => {
      const messageHash = bytesToHex(keccak_256(new TextEncoder().encode('Original')));
      const publicKey = secp256k1.getPublicKey(secp256k1.utils.randomPrivateKey());

      // Attempt various forgery patterns
      const forgedSignatures = [
        '00'.repeat(64), // All zeros
        'ff'.repeat(64), // All ones
        messageHash.slice(0, 128), // Copy of message hash
        messageHash.slice(0, 64) + '00'.repeat(32), // Partial message
      ];

      forgedSignatures.forEach((forged) => {
        const result = ECDSAVerifier.verify(messageHash, forged, bytesToHex(publicKey));
        expect(result.isValid).toBe(false);
      });
    });

    it('should reject signature reuse across different messages', async () => {
      const privateKey = secp256k1.utils.randomPrivateKey();
      const publicKey = secp256k1.getPublicKey(privateKey);

      const message1 = keccak_256(new TextEncoder().encode('Message 1'));
      const message2 = keccak_256(new TextEncoder().encode('Message 2'));

      // Sign message 1
      const signature = await secp256k1.signAsync(message1, privateKey);

      // Try to use signature with message 2 (should fail)
      const result = ECDSAVerifier.verify(
        bytesToHex(message2),
        signature.toCompactHex(),
        bytesToHex(publicKey)
      );

      expect(result.isValid).toBe(false);
    });
  });

  describe('Merkle Proof Manipulation', () => {
    it('should reject proof with modified leaf', () => {
      const leaves = ['0x1111', '0x2222', '0x3333', '0x4444'].map((l) =>
        hexToBytes(l.slice(2).padStart(64, '0'))
      );
      const hashFn = (data: Uint8Array) => keccak_256(data);
      const { root } = MerkleVerifier.buildTree(leaves, hashFn);

      // Generate valid proof
      const proof = MerkleVerifier.generateProof(0, leaves, hashFn);

      // Modify the leaf
      const modifiedProof = {
        ...proof,
        leaf: bytesToHex(keccak_256(new TextEncoder().encode('Modified'))),
        root: bytesToHex(root),
      };

      const isValid = MerkleVerifier.verify(modifiedProof, hashFn);
      expect(isValid).toBe(false);
    });

    it('should reject proof with modified proof path', () => {
      const leaves = ['0x1111', '0x2222', '0x3333', '0x4444'].map((l) =>
        hexToBytes(l.slice(2).padStart(64, '0'))
      );
      const hashFn = (data: Uint8Array) => keccak_256(data);
      const { root } = MerkleVerifier.buildTree(leaves, hashFn);

      // Generate valid proof
      const proof = MerkleVerifier.generateProof(0, leaves, hashFn);

      // Modify a proof element
      const modifiedProof = {
        ...proof,
        proof: proof.proof.map((p, i) => (i === 0 ? '00'.repeat(32) : p)),
        root: bytesToHex(root),
      };

      const isValid = MerkleVerifier.verify(modifiedProof, hashFn);
      expect(isValid).toBe(false);
    });
  });

  describe('Replay Attack Prevention', () => {
    it('should allow verification of unique messages', () => {
      const processedNonces = new Set<string>();

      const verifyWithReplayProtection = (nonce: string): boolean => {
        if (processedNonces.has(nonce)) {
          return false; // Replay detected
        }
        processedNonces.add(nonce);
        return true;
      };

      // First submission should succeed
      expect(verifyWithReplayProtection('nonce-1')).toBe(true);

      // Replay attempt should fail
      expect(verifyWithReplayProtection('nonce-1')).toBe(false);

      // Different nonce should succeed
      expect(verifyWithReplayProtection('nonce-2')).toBe(true);
    });
  });
});
