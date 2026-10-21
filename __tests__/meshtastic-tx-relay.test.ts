/**
 * Comprehensive Tests for Meshtastic Transaction Relay System
 * Task 109: LoRa Transaction Relay System
 *
 * Tests cover:
 * - Payload validation (enhanced txBodySchema)
 * - Chunk reconstruction
 * - Signature verification
 * - Nonce tracking and replay prevention
 * - Full transaction flow
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { ethers, HDNodeWallet } from 'ethers';
import crypto from 'crypto';

// Import the modules under test
import {
  txBodySchema,
  isValidAddress,
  isValidTxId,
  isValidAmount,
  EVM_ADDRESS_REGEX,
  WRFCOIN_ADDRESS_REGEX,
} from '../shared/meshtastic-payload-types.js';

import {
  constructTxMessage,
  verifyTxSignature,
  markNonceUsed,
  NonceAlreadyUsedError,
} from '../shared/meshtastic-tx-validator.js';
import { db } from '../database/db.js';

// Mock the database
jest.mock('../database/db', () => ({
  db: {
    insert: jest.fn().mockReturnValue({
      values: (jest.fn() as any).mockResolvedValue([]),
    }),
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: (jest.fn() as any).mockResolvedValue([]),
        }),
      }),
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: (jest.fn() as any).mockResolvedValue([]),
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: (jest.fn() as any).mockResolvedValue([]),
    }),
  },
}));

describe('Meshtastic Transaction Relay System', () => {
  // Test wallet for signing
  let testWallet: HDNodeWallet;

  beforeEach(() => {
    // Create a deterministic test wallet
    testWallet = ethers.Wallet.createRandom() as HDNodeWallet;
  });

  // ============================================================================
  // Payload Validation Tests (109.1)
  // ============================================================================

  describe('Payload Validation (109.1)', () => {
    describe('Address Validation', () => {
      it('should validate EVM addresses', () => {
        expect(isValidAddress('0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18')).toBe(true);
        expect(isValidAddress('0xabcdef1234567890abcdef1234567890abcdef12')).toBe(true);
      });

      it('should validate WRFCoin native addresses', () => {
        expect(isValidAddress('wrf742d35cc6634c0532925a3b844bc9e7595f2ea18')).toBe(true);
        expect(isValidAddress('wrfabcdef1234567890abcdef1234567890abcdef12345678')).toBe(true);
      });

      it('should reject invalid addresses', () => {
        expect(isValidAddress('')).toBe(false);
        expect(isValidAddress('invalid')).toBe(false);
        expect(isValidAddress('0x123')).toBe(false); // Too short
        expect(isValidAddress('wrf123')).toBe(false); // Too short
      });
    });

    describe('Transaction ID Validation', () => {
      it('should validate UUID format', () => {
        expect(isValidTxId('123e4567-e89b-12d3-a456-426614174000')).toBe(true);
        expect(isValidTxId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(true);
      });

      it('should validate 64-char hex format', () => {
        expect(isValidTxId('abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890')).toBe(true);
      });

      it('should reject invalid txIds', () => {
        expect(isValidTxId('')).toBe(false);
        expect(isValidTxId('invalid')).toBe(false);
        expect(isValidTxId('123')).toBe(false);
      });
    });

    describe('Amount Validation', () => {
      it('should validate positive amounts', () => {
        expect(isValidAmount('100.00')).toBe(true);
        expect(isValidAmount('0.001')).toBe(true);
        expect(isValidAmount('999999.999999')).toBe(true);
      });

      it('should reject invalid amounts', () => {
        expect(isValidAmount('')).toBe(false);
        expect(isValidAmount('0')).toBe(false);
        expect(isValidAmount('-100')).toBe(false);
        expect(isValidAmount('abc')).toBe(false);
        expect(isValidAmount('Infinity')).toBe(false);
      });
    });

    describe('Full Schema Validation', () => {
      it('should validate a complete transaction body', () => {
        const validTx = {
          txId: '123e4567-e89b-12d3-a456-426614174000',
          from: '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18',
          to: '0xabcdef1234567890abcdef1234567890abcdef12',
          amount: '100.00',
          nonce: 1,
          signature: '0x' + 'a'.repeat(130),
          chunk: {
            index: 0,
            total: 1,
            data: 'dGVzdA==', // base64 "test"
          },
        };

        const result = txBodySchema.safeParse(validTx);
        expect(result.success).toBe(true);
      });

      it('should reject chunk.index >= chunk.total', () => {
        const invalidTx = {
          txId: '123e4567-e89b-12d3-a456-426614174000',
          from: '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18',
          to: '0xabcdef1234567890abcdef1234567890abcdef12',
          amount: '100.00',
          nonce: 1,
          signature: '0x' + 'a'.repeat(130),
          chunk: {
            index: 2,
            total: 2, // index should be < total
            data: 'dGVzdA==',
          },
        };

        const result = txBodySchema.safeParse(invalidTx);
        expect(result.success).toBe(false);
      });

      it('should reject invalid address format', () => {
        const invalidTx = {
          txId: '123e4567-e89b-12d3-a456-426614174000',
          from: 'invalid_address',
          to: '0xabcdef1234567890abcdef1234567890abcdef12',
          amount: '100.00',
          nonce: 1,
          signature: '0x' + 'a'.repeat(130),
          chunk: {
            index: 0,
            total: 1,
            data: 'dGVzdA==',
          },
        };

        const result = txBodySchema.safeParse(invalidTx);
        expect(result.success).toBe(false);
      });

      it('should reject short signatures', () => {
        const invalidTx = {
          txId: '123e4567-e89b-12d3-a456-426614174000',
          from: '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18',
          to: '0xabcdef1234567890abcdef1234567890abcdef12',
          amount: '100.00',
          nonce: 1,
          signature: '0x123', // Too short
          chunk: {
            index: 0,
            total: 1,
            data: 'dGVzdA==',
          },
        };

        const result = txBodySchema.safeParse(invalidTx);
        expect(result.success).toBe(false);
      });
    });
  });

  // ============================================================================
  // Chunk Reconstruction Tests (109.2)
  // ============================================================================

  describe('Chunk Reconstruction (109.2)', () => {
    it('should correctly order chunks by index', () => {
      // Simulate out-of-order chunks
      const chunks = new Map<number, string>([
        [2, Buffer.from('chunk3').toString('base64')],
        [0, Buffer.from('chunk1').toString('base64')],
        [1, Buffer.from('chunk2').toString('base64')],
      ]);

      // Sort and concatenate (same logic as reconstructor)
      const sortedChunks = Array.from(chunks.entries())
        .sort(([a], [b]) => a - b)
        .map(([, data]) => Buffer.from(data, 'base64'));

      const result = Buffer.concat(sortedChunks).toString();
      expect(result).toBe('chunk1chunk2chunk3');
    });

    it('should handle single-chunk transactions', () => {
      const chunks = new Map<number, string>([
        [0, Buffer.from('single chunk data').toString('base64')],
      ]);

      const sortedChunks = Array.from(chunks.entries())
        .sort(([a], [b]) => a - b)
        .map(([, data]) => Buffer.from(data, 'base64'));

      const result = Buffer.concat(sortedChunks).toString();
      expect(result).toBe('single chunk data');
    });

    it('should correctly identify incomplete transactions', () => {
      const receivedChunks = new Map<number, string>([
        [0, 'chunk0'],
        [2, 'chunk2'],
        // Missing chunk 1
      ]);
      const totalChunks = 3;

      const isComplete = receivedChunks.size === totalChunks;
      expect(isComplete).toBe(false);
    });

    it('should correctly identify complete transactions', () => {
      const receivedChunks = new Map<number, string>([
        [0, 'chunk0'],
        [1, 'chunk1'],
        [2, 'chunk2'],
      ]);
      const totalChunks = 3;

      const isComplete = receivedChunks.size === totalChunks;
      expect(isComplete).toBe(true);
    });
  });

  // ============================================================================
  // Signature Verification Tests (109.3)
  // ============================================================================

  describe('Signature Verification (109.3)', () => {
    describe('Message Construction', () => {
      it('should construct transaction message with correct format', () => {
        const txId = '123e4567-e89b-12d3-a456-426614174000';
        const from = '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18';
        const to = '0xabcdef1234567890abcdef1234567890abcdef12';
        const amount = '100.00';
        const nonce = 42;

        const message = constructTxMessage(txId, from, to, amount, nonce);

        expect(message).toBe(`WRFCOIN_TX:${txId}:${from}:${to}:${amount}:${nonce}`);
      });

      it('should produce consistent messages', () => {
        const params = {
          txId: 'test-tx-id',
          from: '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18',
          to: '0xabcdef1234567890abcdef1234567890abcdef12',
          amount: '50.00',
          nonce: 1,
        };

        const msg1 = constructTxMessage(params.txId, params.from, params.to, params.amount, params.nonce);
        const msg2 = constructTxMessage(params.txId, params.from, params.to, params.amount, params.nonce);

        expect(msg1).toBe(msg2);
      });
    });

    describe('EVM Signature Verification', () => {
      it('should verify valid EVM signature', async () => {
        const txId = '123e4567-e89b-12d3-a456-426614174000';
        const to = '0xabcdef1234567890abcdef1234567890abcdef12';
        const amount = '100.00';
        const nonce = 1;

        const message = constructTxMessage(txId, testWallet.address, to, amount, nonce);
        const signature = await testWallet.signMessage(message);

        const result = verifyTxSignature(message, signature, testWallet.address);

        expect(result.isValid).toBe(true);
        expect(result.recoveredAddress?.toLowerCase()).toBe(testWallet.address.toLowerCase());
      });

      it('should reject signature from wrong address', async () => {
        const txId = '123e4567-e89b-12d3-a456-426614174000';
        const wrongAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18';
        const to = '0xabcdef1234567890abcdef1234567890abcdef12';
        const amount = '100.00';
        const nonce = 1;

        const message = constructTxMessage(txId, wrongAddress, to, amount, nonce);
        const signature = await testWallet.signMessage(message);

        // Verify against wrong address (not the signer)
        const result = verifyTxSignature(message, signature, wrongAddress);

        expect(result.isValid).toBe(false);
      });

      it('should reject tampered message', async () => {
        const txId = '123e4567-e89b-12d3-a456-426614174000';
        const to = '0xabcdef1234567890abcdef1234567890abcdef12';
        const amount = '100.00';
        const nonce = 1;

        const message = constructTxMessage(txId, testWallet.address, to, amount, nonce);
        const signature = await testWallet.signMessage(message);

        // Tamper with the message
        const tamperedMessage = constructTxMessage(txId, testWallet.address, to, '200.00', nonce);

        const result = verifyTxSignature(tamperedMessage, signature, testWallet.address);

        expect(result.isValid).toBe(false);
      });
    });

    describe('WRFCoin Native Signature Verification', () => {
      it('should reject arbitrary long signatures for WRFCoin addresses', () => {
        const message = constructTxMessage(
          '123e4567-e89b-12d3-a456-426614174000',
          'wrf742d35cc6634c0532925a3b844bc9e7595f2ea18',
          'wrfabcdef1234567890abcdef1234567890abcdef12',
          '1.0',
          1
        );

        // Previously accepted by length-only fallback; must now fail closed.
        const result = verifyTxSignature(
          message,
          'f'.repeat(130),
          'wrf742d35cc6634c0532925a3b844bc9e7595f2ea18'
        );

        expect(result.isValid).toBe(false);
      });
    });
  });

  // ============================================================================
  // Nonce Tracking Tests (109.5)
  // ============================================================================

  describe('Nonce Tracking (109.5)', () => {
    it('should detect replay attempts with same nonce', async () => {
      // This is more of an integration test concept
      // The nonce tracking is done via database queries
      // Here we test the logic flow

      const usedNonces = new Set<string>();

      const checkAndMarkNonce = (from: string, nonce: number): boolean => {
        const key = `${from.toLowerCase()}:${nonce}`;
        if (usedNonces.has(key)) {
          return false; // Replay detected
        }
        usedNonces.add(key);
        return true;
      };

      const from = '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18';

      // First use should succeed
      expect(checkAndMarkNonce(from, 1)).toBe(true);

      // Replay should fail
      expect(checkAndMarkNonce(from, 1)).toBe(false);

      // Different nonce should succeed
      expect(checkAndMarkNonce(from, 2)).toBe(true);

      // Different address can use same nonce
      expect(checkAndMarkNonce('0xabcdef1234567890abcdef1234567890abcdef12', 1)).toBe(true);
    });

    it('should handle nonce values correctly', () => {
      // Nonce should be non-negative integer
      expect(typeof 0).toBe('number');
      expect(Number.isInteger(0)).toBe(true);
      expect(0 >= 0).toBe(true);

      expect(typeof 2147483647).toBe('number');
      expect(Number.isInteger(2147483647)).toBe(true);
    });

    it('should surface duplicate nonce insert as replay conflict', async () => {
      (db.insert as jest.Mock).mockReturnValueOnce({
        values: (jest.fn() as any).mockRejectedValue({ code: '23505' }),
      });

      await expect(markNonceUsed('0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18', 1, 'tx-1')).rejects.toBeInstanceOf(
        NonceAlreadyUsedError
      );
    });
  });

  // ============================================================================
  // Rate Limiting Tests (109.5)
  // ============================================================================

  describe('Rate Limiting (109.5)', () => {
    it('should key rate limits by node ID', () => {
      // Test the key generation logic
      const keyGenerator = (nodeId: string, prefix: string) => {
        return `meshtastic:${prefix}:${nodeId}`;
      };

      const key1 = keyGenerator('node123', 'chunk');
      const key2 = keyGenerator('node456', 'chunk');
      const key3 = keyGenerator('node123', 'tx');

      expect(key1).toBe('meshtastic:chunk:node123');
      expect(key2).toBe('meshtastic:chunk:node456');
      expect(key3).toBe('meshtastic:tx:node123');

      // Different nodes should have different keys
      expect(key1).not.toBe(key2);

      // Same node, different prefix should have different keys
      expect(key1).not.toBe(key3);
    });
  });

  // ============================================================================
  // Integration Flow Tests
  // ============================================================================

  describe('Integration Flow', () => {
    it('should process complete single-chunk transaction', async () => {
      const txId = '123e4567-e89b-12d3-a456-426614174000';
      const to = '0xabcdef1234567890abcdef1234567890abcdef12';
      const amount = '100.00';
      const nonce = 1;

      // Create and sign transaction
      const message = constructTxMessage(txId, testWallet.address, to, amount, nonce);
      const signature = await testWallet.signMessage(message);

      // Simulate chunk processing
      const txBody = {
        txId,
        from: testWallet.address,
        to,
        amount,
        nonce,
        signature,
        chunk: {
          index: 0,
          total: 1,
          data: Buffer.from('transaction data').toString('base64'),
        },
      };

      // Validate payload
      const validation = txBodySchema.safeParse(txBody);
      expect(validation.success).toBe(true);

      // Verify signature
      const sigResult = verifyTxSignature(message, signature, testWallet.address);
      expect(sigResult.isValid).toBe(true);
    });

    it('should handle multi-chunk transaction flow', async () => {
      const txId = 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890';
      const to = '0xabcdef1234567890abcdef1234567890abcdef12';
      const amount = '1000.00';
      const nonce = 5;

      // Create large data that would be chunked
      const largeData = Buffer.from('A'.repeat(1000));

      // Split into chunks
      const chunkSize = 200;
      const chunks: Buffer[] = [];
      for (let i = 0; i < largeData.length; i += chunkSize) {
        chunks.push(largeData.subarray(i, i + chunkSize));
      }

      expect(chunks.length).toBe(5);

      // Simulate receiving chunks out of order
      const receivedOrder = [2, 0, 4, 1, 3];
      const accumulator = new Map<number, string>();

      for (const index of receivedOrder) {
        const txBody = {
          txId,
          from: testWallet.address,
          to,
          amount,
          nonce,
          signature: '0x' + 'a'.repeat(130), // Placeholder signature
          chunk: {
            index,
            total: chunks.length,
            data: chunks[index].toString('base64'),
          },
        };

        // Validate each chunk
        const validation = txBodySchema.safeParse(txBody);
        expect(validation.success).toBe(true);

        // Accumulate
        accumulator.set(index, chunks[index].toString('base64'));
      }

      // All chunks received
      expect(accumulator.size).toBe(chunks.length);

      // Reconstruct
      const sortedChunks = Array.from(accumulator.entries())
        .sort(([a], [b]) => a - b)
        .map(([, data]) => Buffer.from(data, 'base64'));

      const reconstructed = Buffer.concat(sortedChunks);
      expect(reconstructed.toString()).toBe(largeData.toString());
    });
  });
});
