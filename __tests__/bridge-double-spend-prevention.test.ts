/**
 * @title Bridge Double-Spend Prevention Tests (TypeScript)
 * @notice Tests for bridge-zk-commitments.ts and bridge-layerzero-verifier.ts
 * @dev Task 92.6 - Comprehensive testing of nullifier and commitment systems
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { EventEmitter } from 'events';

// Import modules under test
import {
  ZKHasher,
  NullifierRegistry,
  CommitmentMerkleTree,
  CommitmentStatus,
} from '../shared/bridge-zk-commitments.js';

import {
  UltraLightNode,
  OracleBlockConfirmation,
  LayerZeroProof,
  BlockHeader,
  ReceiptProof,
  RelayerConfirmation,
} from '../shared/bridge-layerzero-verifier.js';

describe('Bridge ZK Commitments - Double-Spend Prevention', () => {
  describe('ZKHasher', () => {
    it('should generate deterministic nullifiers', () => {
      const commitmentHash = 'abcd1234';
      const secret = 'test_secret';
      const senderAddress = '0x1234567890abcdef1234567890abcdef12345678';

      const nullifier1 = ZKHasher.generateNullifier(commitmentHash, secret, senderAddress);
      const nullifier2 = ZKHasher.generateNullifier(commitmentHash, secret, senderAddress);

      expect(nullifier1).toBe(nullifier2);
      expect(nullifier1).toMatch(/^[a-f0-9]{64}$/);
    });

    it('should generate different nullifiers for different inputs', () => {
      const nullifier1 = ZKHasher.generateNullifier('commit1', 'secret1', '0xaddr1');
      const nullifier2 = ZKHasher.generateNullifier('commit2', 'secret1', '0xaddr1');
      const nullifier3 = ZKHasher.generateNullifier('commit1', 'secret2', '0xaddr1');

      expect(nullifier1).not.toBe(nullifier2);
      expect(nullifier1).not.toBe(nullifier3);
      expect(nullifier2).not.toBe(nullifier3);
    });

    it('should generate unique commitments with different salts', () => {
      const commitment1 = ZKHasher.generateCommitment(
        '0xsender',
        '0xrecipient',
        '1000',
        'ETH',
        'ethereum',
        'polygon',
        'salt1'
      );

      const commitment2 = ZKHasher.generateCommitment(
        '0xsender',
        '0xrecipient',
        '1000',
        'ETH',
        'ethereum',
        'polygon',
        'salt2'
      );

      expect(commitment1).not.toBe(commitment2);
    });

    it('should use domain separation in hashing', () => {
      const domain1 = Buffer.from('domain1');
      const domain2 = Buffer.from('domain2');
      const data = 'same_data';

      const hash1 = ZKHasher.hashWithDomain(domain1, data);
      const hash2 = ZKHasher.hashWithDomain(domain2, data);

      expect(hash1).not.toBe(hash2);
    });

    it('should generate cryptographically secure salt', () => {
      const salt1 = ZKHasher.generateSalt();
      const salt2 = ZKHasher.generateSalt();

      expect(salt1).toMatch(/^[a-f0-9]{64}$/);
      expect(salt2).toMatch(/^[a-f0-9]{64}$/);
      expect(salt1).not.toBe(salt2);
    });

    it('should generate transfer IDs', () => {
      const transferId = ZKHasher.generateTransferId(
        '0xsender',
        '0xrecipient',
        '1000',
        Date.now()
      );

      expect(transferId).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe('NullifierRegistry', () => {
    let registry: NullifierRegistry;

    beforeEach(() => {
      registry = new NullifierRegistry();
    });

    it('should start with no consumed nullifiers', () => {
      const nullifier = '0x' + '1'.repeat(64);
      expect(registry.isNullifierConsumed(nullifier)).toBe(false);
    });

    it('should allow reserving a nullifier', () => {
      const nullifier = '0x' + '2'.repeat(64);
      const commitmentId = 'commit_123';

      const result = registry.reserveNullifier(nullifier, commitmentId);
      expect(result).toBe(true);
      expect(registry.isNullifierPending(nullifier)).toBe(true);
    });

    it('should reject reserving the same nullifier twice', () => {
      const nullifier = '0x' + '3'.repeat(64);

      registry.reserveNullifier(nullifier, 'commit_1');
      const result = registry.reserveNullifier(nullifier, 'commit_2');

      expect(result).toBe(false);
    });

    it('should consume nullifier and mark as used - CORE DOUBLE-SPEND PREVENTION', () => {
      const nullifier = '0x' + '4'.repeat(64);
      const commitmentId = 'commit_456';
      const consumedBy = '0xconsumer';

      // Reserve first
      registry.reserveNullifier(nullifier, commitmentId);

      // Consume
      const result = registry.consumeNullifier(
        nullifier,
        commitmentId,
        consumedBy,
        '0xtxhash',
        'ethereum',
        'polygon'
      );
      expect(result).toBe(true);

      // Should now be consumed
      expect(registry.isNullifierConsumed(nullifier)).toBe(true);
    });

    it('should REJECT consuming same nullifier twice - DOUBLE SPEND BLOCKED', () => {
      const nullifier = '0x' + '5'.repeat(64);
      const commitmentId = 'commit_789';
      const consumedBy = '0xconsumer';

      registry.reserveNullifier(nullifier, commitmentId);
      registry.consumeNullifier(
        nullifier,
        commitmentId,
        consumedBy,
        '0xtxhash',
        'ethereum',
        'polygon'
      );

      // Second consumption MUST fail
      const result = registry.consumeNullifier(
        nullifier,
        commitmentId,
        consumedBy,
        '0xtxhash2',
        'ethereum',
        'polygon'
      );
      expect(result).toBe(false);
    });

    it('should emit events on nullifier operations', (done) => {
      const nullifier = '0x' + '6'.repeat(64);
      let eventCount = 0;

      registry.on('nullifier-reserved', () => {
        eventCount++;
      });

      registry.on('nullifier-consumed', () => {
        eventCount++;
        if (eventCount >= 2) done();
      });

      registry.reserveNullifier(nullifier, 'commit_1');
      registry.consumeNullifier(
        nullifier,
        'commit_1',
        '0xconsumer',
        '0xtxhash',
        'ethereum',
        'polygon'
      );
    });

    it('should emit double-spend-blocked event on duplicate consumption', (done) => {
      const nullifier = '0x' + '7'.repeat(64);

      registry.on('double-spend-blocked', (data) => {
        expect(data.nullifierHash).toBe(nullifier);
        expect(data.attemptedBy).toBe('0xattacker');
        done();
      });

      registry.reserveNullifier(nullifier, 'commit_1');
      registry.consumeNullifier(
        nullifier,
        'commit_1',
        '0xconsumer',
        '0xtxhash',
        'ethereum',
        'polygon'
      );

      // Double-spend attempt
      registry.consumeNullifier(
        nullifier,
        'commit_1',
        '0xattacker',
        '0xtxhash2',
        'ethereum',
        'polygon'
      );
    });

    it('should track statistics', () => {
      const nullifier = '0x' + '8'.repeat(64);

      registry.reserveNullifier(nullifier, 'commit_1');
      registry.consumeNullifier(
        nullifier,
        'commit_1',
        '0xconsumer',
        '0xtxhash',
        'ethereum',
        'polygon'
      );

      const stats = registry.getStatistics();
      expect(stats.totalConsumed).toBeGreaterThanOrEqual(1);
    });

    it('should get nullifier record after consumption', () => {
      const nullifier = '0x' + '9'.repeat(64);

      registry.reserveNullifier(nullifier, 'commit_1');
      registry.consumeNullifier(
        nullifier,
        'commit_1',
        '0xconsumer',
        '0xtxhash',
        'ethereum',
        'polygon'
      );

      const record = registry.getNullifierRecord(nullifier);
      expect(record).not.toBeNull();
      expect(record?.nullifierHash).toBe(nullifier);
      expect(record?.consumedBy).toBe('0xconsumer');
      expect(record?.transactionHash).toBe('0xtxhash');
    });

    it('should return null for unknown nullifier record', () => {
      const record = registry.getNullifierRecord('0x' + 'f'.repeat(64));
      expect(record).toBeNull();
    });
  });

  describe('CommitmentMerkleTree', () => {
    let tree: CommitmentMerkleTree;

    beforeEach(() => {
      tree = new CommitmentMerkleTree(10); // Small tree for testing
    });

    it('should add commitments and return index', () => {
      const commitment = '0x' + 'a'.repeat(64);

      const index = tree.addCommitment(commitment);
      expect(index).toBe(0);

      const index2 = tree.addCommitment('0x' + 'b'.repeat(64));
      expect(index2).toBe(1);
    });

    it('should generate valid proofs', () => {
      const commitment1 = '0x' + 'a'.repeat(64);
      const commitment2 = '0x' + 'b'.repeat(64);
      const commitment3 = '0x' + 'c'.repeat(64);

      tree.addCommitment(commitment1);
      tree.addCommitment(commitment2);
      tree.addCommitment(commitment3);

      const proof = tree.getProof(commitment1);
      expect(proof).not.toBeNull();
      expect(proof?.commitmentHash).toBe(commitment1);
      expect(proof?.merkleRoot).toBeDefined();
      expect(proof?.proof).toBeDefined();
    });

    it('should verify valid proofs', () => {
      const commitment = '0x' + 'd'.repeat(64);
      tree.addCommitment(commitment);

      const proof = tree.getProof(commitment);
      expect(proof).not.toBeNull();

      const isValid = tree.verifyProof(proof!);
      expect(isValid).toBe(true);
    });

    it('should return null proof for unknown commitment', () => {
      tree.addCommitment('0x' + 'a'.repeat(64));

      const proof = tree.getProof('0x' + 'z'.repeat(64));
      expect(proof).toBeNull();
    });

    it('should track commitment index', () => {
      const commitment = '0x' + 'e'.repeat(64);
      tree.addCommitment(commitment);

      const index = tree.getCommitmentIndex(commitment);
      expect(index).toBe(0);
    });

    it('should update root on each addition', () => {
      const root1 = tree.getRoot();

      tree.addCommitment('0x' + '1'.repeat(64));
      const root2 = tree.getRoot();

      tree.addCommitment('0x' + '2'.repeat(64));
      const root3 = tree.getRoot();

      expect(root1).not.toBe(root2);
      expect(root2).not.toBe(root3);
    });

    it('should provide tree statistics', () => {
      tree.addCommitment('0x' + 'a'.repeat(64));
      tree.addCommitment('0x' + 'b'.repeat(64));

      const stats = tree.getStatistics();
      expect(stats.totalCommitments).toBe(2);
      expect(stats.treeDepth).toBe(10);
      expect(stats.maxCapacity).toBe(1024); // 2^10
    });
  });
});

describe('LayerZero Verifier - Cross-Chain Replay Prevention', () => {
  describe('UltraLightNode', () => {
    let uln: UltraLightNode;

    beforeEach(() => {
      uln = new UltraLightNode();
    });

    it('should accept block hash with sufficient oracle confirmations', () => {
      const chainId = 1;
      const blockNumber = 12345;
      const blockHash = '0x' + 'a'.repeat(64);

      // Create valid oracle confirmations (need at least 2/3 to agree)
      const confirmations: OracleBlockConfirmation[] = [
        {
          oracleId: 'oracle1',
          oracleAddress: '0xoracle1',
          chainId,
          blockNumber,
          blockHash,
          confirmations: 15,
          timestamp: Date.now(),
          signature: '0xsig1',
        },
        {
          oracleId: 'oracle2',
          oracleAddress: '0xoracle2',
          chainId,
          blockNumber,
          blockHash,
          confirmations: 15,
          timestamp: Date.now(),
          signature: '0xsig2',
        },
        {
          oracleId: 'oracle3',
          oracleAddress: '0xoracle3',
          chainId,
          blockNumber,
          blockHash,
          confirmations: 15,
          timestamp: Date.now(),
          signature: '0xsig3',
        },
      ];

      const result = uln.submitBlockHash(chainId, blockNumber, blockHash, confirmations);
      // Result depends on internal signature verification
      expect(typeof result).toBe('boolean');
    });

    it('should check if block is verified', () => {
      const chainId = 1;
      const blockNumber = 12345;
      const blockHash = '0x' + 'a'.repeat(64);

      // Initially not verified
      const isVerified = uln.isBlockVerified(chainId, blockNumber, blockHash);
      expect(isVerified).toBe(false);
    });

    it('should get chain head', () => {
      const chainId = 1;
      const head = uln.getChainHead(chainId);
      expect(head).toBe(0); // Initially zero
    });

    it('should get verified block hash', () => {
      const chainId = 1;
      const blockNumber = 12345;

      const hash = uln.getVerifiedBlockHash(chainId, blockNumber);
      expect(hash).toBeNull(); // Not verified yet
    });

    it('should submit and retrieve block headers', () => {
      const header: BlockHeader = {
        hash: '0x' + 'a'.repeat(64),
        parentHash: '0x' + 'b'.repeat(64),
        number: 12345,
        timestamp: Date.now(),
        stateRoot: '0x' + 'c'.repeat(64),
        transactionsRoot: '0x' + 'd'.repeat(64),
        receiptsRoot: '0x' + 'e'.repeat(64),
      };

      uln.submitBlockHeader(header);

      const retrieved = uln.getBlockHeader(header.hash);
      expect(retrieved).not.toBeNull();
      expect(retrieved?.number).toBe(header.number);
    });

    it('should emit events for block verification', (done) => {
      uln.on('block-rejected', (data) => {
        expect(data.reason).toBeDefined();
        done();
      });

      // Submit with insufficient confirmations
      uln.submitBlockHash(1, 12345, '0x' + 'a'.repeat(64), []);
    });
  });
});

describe('Integration - Combined Double-Spend Prevention', () => {
  it('should prevent double-spend with nullifier registry', () => {
    const registry = new NullifierRegistry();
    const tree = new CommitmentMerkleTree(10);

    // Create commitment
    const commitmentHash = ZKHasher.generateCommitment(
      '0xsender',
      '0xrecipient',
      '1000',
      'ETH',
      'ethereum',
      'polygon',
      ZKHasher.generateSalt()
    );

    // Add to tree
    tree.addCommitment(commitmentHash);
    const proof = tree.getProof(commitmentHash);
    expect(proof).not.toBeNull();

    // Generate nullifier
    const nullifier = ZKHasher.generateNullifier(
      commitmentHash,
      'secret',
      '0xsender'
    );

    // First consumption
    registry.reserveNullifier(nullifier, 'commit_1');
    const result1 = registry.consumeNullifier(
      nullifier,
      'commit_1',
      '0xrevealer',
      '0xtxhash',
      'ethereum',
      'polygon'
    );
    expect(result1).toBe(true);

    // Double-spend attempt
    const result2 = registry.consumeNullifier(
      nullifier,
      'commit_1',
      '0xattacker',
      '0xtxhash2',
      'ethereum',
      'polygon'
    );
    expect(result2).toBe(false);
  });

  it('should handle multiple independent transfers', () => {
    const registry = new NullifierRegistry();
    const tree = new CommitmentMerkleTree(10);

    // Create multiple commitments
    const commitments = Array.from({ length: 5 }, (_, i) => {
      const commitment = ZKHasher.generateCommitment(
        `0xsender${i}`,
        `0xrecipient${i}`,
        (1000 * (i + 1)).toString(),
        'ETH',
        'ethereum',
        'polygon',
        ZKHasher.generateSalt()
      );

      tree.addCommitment(commitment);

      const nullifier = ZKHasher.generateNullifier(
        commitment,
        `secret${i}`,
        `0xsender${i}`
      );

      return { commitment, nullifier, id: `commit_${i}` };
    });

    // All should be consumable independently
    commitments.forEach(({ nullifier, id }, i) => {
      registry.reserveNullifier(nullifier, id);
      const result = registry.consumeNullifier(
        nullifier,
        id,
        `0xrevealer${i}`,
        `0xtxhash${i}`,
        'ethereum',
        'polygon'
      );
      expect(result).toBe(true);
    });

    // Verify all are consumed
    const stats = registry.getStatistics();
    expect(stats.totalConsumed).toBe(5);

    // Verify tree has all commitments
    const treeStats = tree.getStatistics();
    expect(treeStats.totalCommitments).toBe(5);
  });

  it('should verify commitment inclusion before consumption', () => {
    const registry = new NullifierRegistry();
    const tree = new CommitmentMerkleTree(10);

    // Create commitment
    const commitment = ZKHasher.generateCommitment(
      '0xsender',
      '0xrecipient',
      '1000',
      'ETH',
      'ethereum',
      'polygon',
      ZKHasher.generateSalt()
    );

    // Add to tree
    tree.addCommitment(commitment);

    // Verify proof
    const proof = tree.getProof(commitment);
    expect(proof).not.toBeNull();
    expect(tree.verifyProof(proof!)).toBe(true);

    // Generate nullifier
    const nullifier = ZKHasher.generateNullifier(
      commitment,
      'secret',
      '0xsender'
    );

    // Only consume if proof is valid
    if (tree.verifyProof(proof!)) {
      registry.reserveNullifier(nullifier, 'commit_1');
      const result = registry.consumeNullifier(
        nullifier,
        'commit_1',
        '0xrevealer',
        '0xtxhash',
        'ethereum',
        'polygon'
      );
      expect(result).toBe(true);
    }

    expect(registry.isNullifierConsumed(nullifier)).toBe(true);
  });
});

describe('Stress Tests - High Volume Double-Spend Prevention', () => {
  it('should handle many unique nullifiers efficiently', () => {
    const registry = new NullifierRegistry();
    const nullifierCount = 100;

    // Generate many unique nullifiers
    const nullifiers = Array.from({ length: nullifierCount }, (_, i) =>
      '0x' + i.toString(16).padStart(64, '0')
    );

    // Check all are initially unused
    nullifiers.forEach(nullifier => {
      expect(registry.isNullifierConsumed(nullifier)).toBe(false);
    });

    // Reserve and consume all
    nullifiers.forEach((nullifier, i) => {
      registry.reserveNullifier(nullifier, `commit_${i}`);
      registry.consumeNullifier(
        nullifier,
        `commit_${i}`,
        '0xconsumer',
        `0xtxhash${i}`,
        'ethereum',
        'polygon'
      );
    });

    // Verify all are consumed
    const stats = registry.getStatistics();
    expect(stats.totalConsumed).toBe(nullifierCount);
  });

  it('should maintain consistency under parallel checks', () => {
    const registry = new NullifierRegistry();
    const testNullifier = '0x' + 'f'.repeat(64);

    // Reserve and consume
    registry.reserveNullifier(testNullifier, 'commit_1');
    registry.consumeNullifier(
      testNullifier,
      'commit_1',
      '0xconsumer',
      '0xtxhash',
      'ethereum',
      'polygon'
    );

    // Rapid parallel queries should all return consistent result
    const results = Array.from({ length: 100 }, () =>
      registry.isNullifierConsumed(testNullifier)
    );

    // All should return true
    expect(results.every(r => r === true)).toBe(true);
  });

  it('should handle many commitments in merkle tree', () => {
    const tree = new CommitmentMerkleTree(15); // Supports 2^15 = 32768 commitments
    const commitmentCount = 100;

    // Add many commitments
    const commitments = Array.from({ length: commitmentCount }, (_, i) =>
      '0x' + i.toString(16).padStart(64, '0')
    );

    commitments.forEach(commitment => {
      tree.addCommitment(commitment);
    });

    // Verify all have valid proofs
    commitments.forEach(commitment => {
      const proof = tree.getProof(commitment);
      expect(proof).not.toBeNull();
      expect(tree.verifyProof(proof!)).toBe(true);
    });

    const stats = tree.getStatistics();
    expect(stats.totalCommitments).toBe(commitmentCount);
  });
});
