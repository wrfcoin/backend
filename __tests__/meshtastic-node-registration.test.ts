/**
 * Comprehensive Tests for Meshtastic Node Registration
 * Task 111: Node Registration and Identity Mapping
 *
 * Tests cover:
 * - Signature verification (EVM and WRFCoin native)
 * - Message construction
 * - Address validation
 * - Registration request validation
 * - Nonce management
 * - Complete registration flow
 */

import { describe, it, expect, beforeEach, jest, afterEach } from '@jest/globals';
import { ethers, HDNodeWallet } from 'ethers';
import crypto from 'crypto';

// Type alias for mocked functions
type MockedFn = jest.Mock<any>;
import {
  constructRegistrationMessage,
  hashMessage,
  isValidWrfcoinAddress,
  normalizeAddress,
  verifyRegistrationSignature,
  validateRegistrationRequest,
  generateRegistrationNonce,
  getCurrentTimestamp,
  type RegistrationRequest,
} from '../shared/meshtastic-registration-service.js';

jest.mock('../database/db', () => ({
  db: {
    execute: jest.fn().mockResolvedValue([{ hit_count: 0 }]),
  },
}));

// Mock the database helpers
jest.mock('../shared/meshtastic-db-helpers', () => ({
  registerNode: jest.fn(),
  isNonceUsed: jest.fn(),
  markNonceUsed: jest.fn(),
  getRegisteredNode: jest.fn(),
  findNodeByMeshtasticId: jest.fn(),
  RegistrationNonceAlreadyUsedError: class RegistrationNonceAlreadyUsedError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'RegistrationNonceAlreadyUsedError';
    }
  },
}));

describe('Meshtastic Node Registration', () => {
  describe('Message Construction', () => {
    it('should construct registration message with correct format', () => {
      const nodeId = '!abc12345';
      const address = '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18';
      const nonce = 12345;
      const timestamp = 1704067200;

      const message = constructRegistrationMessage(nodeId, address, nonce, timestamp);

      expect(message).toBe(
        `WRFCOIN_NODE_REGISTRATION:${nodeId}:${address}:${nonce}:${timestamp}`
      );
    });

    it('should handle special characters in node ID', () => {
      const nodeId = '!node-123_test';
      const address = '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18';
      const nonce = 1;
      const timestamp = 1704067200;

      const message = constructRegistrationMessage(nodeId, address, nonce, timestamp);

      expect(message).toContain(nodeId);
      expect(message.split(':').length).toBe(5);
    });

    it('should produce consistent messages for same inputs', () => {
      const params = {
        nodeId: '!test123',
        address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18',
        nonce: 999,
        timestamp: 1704067200,
      };

      const message1 = constructRegistrationMessage(
        params.nodeId,
        params.address,
        params.nonce,
        params.timestamp
      );
      const message2 = constructRegistrationMessage(
        params.nodeId,
        params.address,
        params.nonce,
        params.timestamp
      );

      expect(message1).toBe(message2);
    });
  });

  describe('Message Hashing', () => {
    it('should produce Keccak256 hash by default', () => {
      const message = 'test message';
      const hash = hashMessage(message, true);

      // Keccak256 produces 66-character hex string (0x + 64 chars)
      expect(hash).toMatch(/^0x[a-fA-F0-9]{64}$/);
    });

    it('should produce SHA256 hash when specified', () => {
      const message = 'test message';
      const hash = hashMessage(message, false);

      // SHA256 produces 64-character hex string
      expect(hash).toMatch(/^[a-fA-F0-9]{64}$/);
    });

    it('should produce different hashes for different messages', () => {
      const hash1 = hashMessage('message 1');
      const hash2 = hashMessage('message 2');

      expect(hash1).not.toBe(hash2);
    });
  });

  describe('Address Validation', () => {
    describe('EVM Addresses', () => {
      it('should accept valid EVM address', () => {
        const address = '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18';
        expect(isValidWrfcoinAddress(address)).toBe(true);
      });

      it('should accept checksummed EVM address', () => {
        const address = ethers.getAddress('0x742d35cc6634c0532925a3b844bc9e7595f2ea18');
        expect(isValidWrfcoinAddress(address)).toBe(true);
      });

      it('should accept lowercase EVM address', () => {
        const address = '0x742d35cc6634c0532925a3b844bc9e7595f2ea18';
        expect(isValidWrfcoinAddress(address)).toBe(true);
      });

      it('should reject invalid EVM address', () => {
        expect(isValidWrfcoinAddress('0x123')).toBe(false);
        expect(isValidWrfcoinAddress('0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG')).toBe(false);
      });

      it('should reject EVM address without 0x prefix', () => {
        expect(isValidWrfcoinAddress('742d35Cc6634C0532925a3b844Bc9e7595f2eA18')).toBe(false);
      });
    });

    describe('WRFCoin Native Addresses', () => {
      it('should accept valid WRFCoin address with lowercase prefix', () => {
        const address = 'wrf742d35cc6634c0532925a3b844bc9e7595f2ea18';
        expect(isValidWrfcoinAddress(address)).toBe(true);
      });

      it('should accept valid WRFCoin address with uppercase prefix', () => {
        const address = 'WRF742d35cc6634c0532925a3b844bc9e7595f2ea18';
        expect(isValidWrfcoinAddress(address)).toBe(true);
      });

      it('should reject WRFCoin address with wrong length', () => {
        expect(isValidWrfcoinAddress('wrf123')).toBe(false);
        expect(isValidWrfcoinAddress('wrf742d35cc6634c0532925a3b844bc9e7595f2ea18extra')).toBe(false);
      });

      it('should reject WRFCoin address with invalid characters', () => {
        expect(isValidWrfcoinAddress('wrfGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG')).toBe(false);
      });
    });

    describe('Invalid Addresses', () => {
      it('should reject empty string', () => {
        expect(isValidWrfcoinAddress('')).toBe(false);
      });

      it('should reject null and undefined', () => {
        expect(isValidWrfcoinAddress(null as any)).toBe(false);
        expect(isValidWrfcoinAddress(undefined as any)).toBe(false);
      });

      it('should reject non-string types', () => {
        expect(isValidWrfcoinAddress(12345 as any)).toBe(false);
        expect(isValidWrfcoinAddress({} as any)).toBe(false);
      });

      it('should reject random strings', () => {
        expect(isValidWrfcoinAddress('not-an-address')).toBe(false);
        expect(isValidWrfcoinAddress('bitcoin:1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')).toBe(false);
      });
    });
  });

  describe('Address Normalization', () => {
    it('should convert to lowercase', () => {
      const address = '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18';
      expect(normalizeAddress(address)).toBe(address.toLowerCase());
    });

    it('should handle WRFCoin addresses', () => {
      const address = 'WRF742d35Cc6634C0532925a3b844Bc9e7595f2eA18';
      expect(normalizeAddress(address)).toBe('wrf742d35cc6634c0532925a3b844bc9e7595f2ea18');
    });
  });

  describe('Signature Verification', () => {
    describe('EVM Signatures', () => {
      let wallet: HDNodeWallet;
      let address: string;

      beforeEach(() => {
        // Create a test wallet
        wallet = ethers.Wallet.createRandom();
        address = wallet.address;
      });

      it('should verify valid EVM signature', async () => {
        const message = constructRegistrationMessage(
          '!testnode',
          address,
          1,
          getCurrentTimestamp()
        );

        // Sign the message
        const signature = await wallet.signMessage(message);

        const result = verifyRegistrationSignature(message, signature, address);

        expect(result.isValid).toBe(true);
        expect(result.recoveredAddress?.toLowerCase()).toBe(address.toLowerCase());
      });

      it('should reject signature from wrong address', async () => {
        const otherWallet = ethers.Wallet.createRandom();
        const message = constructRegistrationMessage(
          '!testnode',
          address,
          1,
          getCurrentTimestamp()
        );

        // Sign with different wallet
        const signature = await otherWallet.signMessage(message);

        const result = verifyRegistrationSignature(message, signature, address);

        expect(result.isValid).toBe(false);
        expect(result.error).toContain('does not match');
      });

      it('should reject invalid signature format', () => {
        const message = constructRegistrationMessage(
          '!testnode',
          address,
          1,
          getCurrentTimestamp()
        );

        const result = verifyRegistrationSignature(message, 'not-a-valid-signature', address);

        expect(result.isValid).toBe(false);
      });

      it('should reject tampered message', async () => {
        const originalMessage = constructRegistrationMessage(
          '!testnode',
          address,
          1,
          getCurrentTimestamp()
        );

        const signature = await wallet.signMessage(originalMessage);

        // Tamper with the message
        const tamperedMessage = constructRegistrationMessage(
          '!testnode',
          address,
          2, // Different nonce
          getCurrentTimestamp()
        );

        const result = verifyRegistrationSignature(tamperedMessage, signature, address);

        expect(result.isValid).toBe(false);
      });
    });

    describe('WRFCoin Native Signatures', () => {
      it('should return error for WRFCoin native address without EVM-compatible signature', () => {
        const address = 'wrf742d35cc6634c0532925a3b844bc9e7595f2ea18';
        const message = 'test message';
        const signature = 'invalid-native-signature';

        const result = verifyRegistrationSignature(message, signature, address);

        expect(result.isValid).toBe(false);
        expect(result.error).toContain('WRFCoin native signature verification');
      });
    });

    describe('Unsupported Addresses', () => {
      it('should reject unsupported address format', () => {
        const message = 'test message';
        const result = verifyRegistrationSignature(message, 'sig', 'invalid-address');

        expect(result.isValid).toBe(false);
        expect(result.error).toBe('Unsupported address format');
      });
    });
  });

  describe('Registration Request Validation', () => {
    let validRequest: RegistrationRequest;

    beforeEach(() => {
      const now = getCurrentTimestamp();
      validRequest = {
        meshtasticNodeId: '!abc12345',
        wrfcoinAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18',
        nonce: 12345,
        timestamp: now,
        signature: '0x' + 'a'.repeat(130),
        metadata: {
          hardwareModel: 'TBEAM',
          firmwareVersion: '2.1.0',
          shortName: 'TEST',
          longName: 'Test Node',
        },
      };
    });

    describe('Valid Requests', () => {
      it('should accept valid request with all fields', () => {
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
      });

      it('should accept valid request without metadata', () => {
        const { metadata, ...requestWithoutMetadata } = validRequest;
        const result = validateRegistrationRequest(requestWithoutMetadata as RegistrationRequest);
        expect(result.valid).toBe(true);
      });

      it('should accept WRFCoin native address', () => {
        validRequest.wrfcoinAddress = 'wrf742d35cc6634c0532925a3b844bc9e7595f2ea18';
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(true);
      });
    });

    describe('Invalid Node ID', () => {
      it('should reject missing node ID', () => {
        validRequest.meshtasticNodeId = '' as any;
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('meshtasticNodeId'))).toBe(true);
      });

      it('should reject node ID that is too long', () => {
        validRequest.meshtasticNodeId = 'a'.repeat(65);
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('64 characters'))).toBe(true);
      });

      it('should reject non-string node ID', () => {
        validRequest.meshtasticNodeId = 12345 as any;
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
      });
    });

    describe('Invalid Address', () => {
      it('should reject missing address', () => {
        validRequest.wrfcoinAddress = '' as any;
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('wrfcoinAddress'))).toBe(true);
      });

      it('should reject invalid address format', () => {
        validRequest.wrfcoinAddress = 'invalid-address';
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid wrfcoinAddress format'))).toBe(true);
      });
    });

    describe('Invalid Nonce', () => {
      it('should reject non-integer nonce', () => {
        validRequest.nonce = 1.5;
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('nonce'))).toBe(true);
      });

      it('should reject nonce below minimum', () => {
        validRequest.nonce = 0;
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('nonce'))).toBe(true);
      });

      it('should reject nonce above maximum', () => {
        validRequest.nonce = 2147483648; // Max 32-bit signed int + 1
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
      });

      it('should reject missing nonce', () => {
        delete (validRequest as any).nonce;
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
      });
    });

    describe('Invalid Timestamp', () => {
      it('should reject timestamp too far in the future', () => {
        validRequest.timestamp = getCurrentTimestamp() + 120; // 2 minutes in future
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('future'))).toBe(true);
      });

      it('should reject expired timestamp', () => {
        validRequest.timestamp = getCurrentTimestamp() - 400; // 6+ minutes ago
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('expired'))).toBe(true);
      });

      it('should reject non-integer timestamp', () => {
        validRequest.timestamp = 1704067200.5;
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
      });
    });

    describe('Invalid Signature', () => {
      it('should reject missing signature', () => {
        validRequest.signature = '' as any;
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('signature'))).toBe(true);
      });

      it('should reject signature that is too short', () => {
        validRequest.signature = '0x' + 'a'.repeat(60);
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
      });
    });

    describe('Invalid Metadata', () => {
      it('should reject non-object metadata', () => {
        validRequest.metadata = 'invalid' as any;
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('metadata must be an object'))).toBe(true);
      });

      it('should reject hardwareModel exceeding max length', () => {
        validRequest.metadata = { hardwareModel: 'a'.repeat(65) };
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('hardwareModel'))).toBe(true);
      });

      it('should reject firmwareVersion exceeding max length', () => {
        validRequest.metadata = { firmwareVersion: 'a'.repeat(33) };
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('firmwareVersion'))).toBe(true);
      });

      it('should reject shortName exceeding max length', () => {
        validRequest.metadata = { shortName: 'a'.repeat(17) };
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('shortName'))).toBe(true);
      });

      it('should reject longName exceeding max length', () => {
        validRequest.metadata = { longName: 'a'.repeat(256) };
        const result = validateRegistrationRequest(validRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('longName'))).toBe(true);
      });
    });

    describe('Multiple Validation Errors', () => {
      it('should report all validation errors at once', () => {
        const invalidRequest: RegistrationRequest = {
          meshtasticNodeId: '',
          wrfcoinAddress: 'invalid',
          nonce: 0,
          timestamp: 0,
          signature: 'short',
          metadata: 'invalid' as any,
        };

        const result = validateRegistrationRequest(invalidRequest);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(1);
      });
    });
  });

  describe('Nonce Generation', () => {
    it('should generate nonce within valid range', () => {
      for (let i = 0; i < 100; i++) {
        const nonce = generateRegistrationNonce();
        expect(nonce).toBeGreaterThanOrEqual(1);
        expect(nonce).toBeLessThanOrEqual(2147483647);
        expect(Number.isInteger(nonce)).toBe(true);
      }
    });

    it('should generate different nonces', () => {
      const nonces = new Set<number>();
      for (let i = 0; i < 100; i++) {
        nonces.add(generateRegistrationNonce());
      }
      // Should have at least 90 unique values out of 100
      expect(nonces.size).toBeGreaterThan(90);
    });
  });

  describe('Timestamp Generation', () => {
    it('should return current Unix timestamp in seconds', () => {
      const before = Math.floor(Date.now() / 1000);
      const timestamp = getCurrentTimestamp();
      const after = Math.floor(Date.now() / 1000);

      expect(timestamp).toBeGreaterThanOrEqual(before);
      expect(timestamp).toBeLessThanOrEqual(after);
    });

    it('should return integer timestamp', () => {
      const timestamp = getCurrentTimestamp();
      expect(Number.isInteger(timestamp)).toBe(true);
    });
  });

  describe('End-to-End Registration Flow', () => {
    let wallet: HDNodeWallet;

    beforeEach(() => {
      wallet = ethers.Wallet.createRandom();
      jest.clearAllMocks();
    });

    it('should complete full registration with valid signature', async () => {
      const { db } = await import('../database/db.js');
      const { isNonceUsed, registerNode, markNonceUsed, findNodeByMeshtasticId } = await import(
        '../shared/meshtastic-db-helpers.js'
      );

      // Mock database responses
      ((db as { execute: MockedFn }).execute).mockResolvedValue([{ hit_count: 0 }]);
      (isNonceUsed as MockedFn).mockResolvedValue(false);
      (findNodeByMeshtasticId as MockedFn).mockResolvedValue(null);
      (registerNode as MockedFn).mockResolvedValue({
        node: {
          meshtasticNodeId: '!testnode',
          wrfcoinAddress: wallet.address,
          registeredAt: new Date(),
          geoFenceStatus: 'clear',
          geoFenceGrid: null,
          geoFenceBurstCount: 1,
        },
        isNew: true,
      });
      (markNonceUsed as MockedFn).mockResolvedValue(undefined);

      // Import after mocking
      const { processRegistration } = await import('../shared/meshtastic-registration-service.js');

      const nodeId = '!testnode';
      const nonce = generateRegistrationNonce();
      const timestamp = getCurrentTimestamp();

      const message = constructRegistrationMessage(nodeId, wallet.address, nonce, timestamp);
      const signature = await wallet.signMessage(message);

      const request: RegistrationRequest = {
        meshtasticNodeId: nodeId,
        wrfcoinAddress: wallet.address,
        nonce,
        timestamp,
        signature,
      };

      const result = await processRegistration(request);

      expect(result.success).toBe(true);
      expect(result.registration).toBeDefined();
      expect(result.registration?.meshtasticNodeId).toBe(nodeId);
      expect(result.registration?.isNew).toBe(true);
    });

    it('should reject registration with reused nonce', async () => {
      const { isNonceUsed } = await import('../shared/meshtastic-db-helpers.js');
      (isNonceUsed as MockedFn).mockResolvedValue(true);

      const { processRegistration } = await import('../shared/meshtastic-registration-service.js');

      const nodeId = '!testnode';
      const nonce = 12345;
      const timestamp = getCurrentTimestamp();

      const message = constructRegistrationMessage(nodeId, wallet.address, nonce, timestamp);
      const signature = await wallet.signMessage(message);

      const request: RegistrationRequest = {
        meshtasticNodeId: nodeId,
        wrfcoinAddress: wallet.address,
        nonce,
        timestamp,
        signature,
      };

      const result = await processRegistration(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Nonce has already been used');
    });

    it('should reject registration with invalid signature', async () => {
      const { isNonceUsed } = await import('../shared/meshtastic-db-helpers.js');
      (isNonceUsed as MockedFn).mockResolvedValue(false);

      const { processRegistration } = await import('../shared/meshtastic-registration-service.js');

      const nodeId = '!testnode';
      const nonce = generateRegistrationNonce();
      const timestamp = getCurrentTimestamp();

      // Sign with a different wallet
      const otherWallet = ethers.Wallet.createRandom();
      const message = constructRegistrationMessage(nodeId, wallet.address, nonce, timestamp);
      const wrongSignature = await otherWallet.signMessage(message);

      const request: RegistrationRequest = {
        meshtasticNodeId: nodeId,
        wrfcoinAddress: wallet.address,
        nonce,
        timestamp,
        signature: wrongSignature,
      };

      const result = await processRegistration(request);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Signature verification failed');
    });

    it('should require manual attestation when a second new node appears in the same grid window', async () => {
      const { db } = await import('../database/db.js');
      const { isNonceUsed, registerNode, markNonceUsed, findNodeByMeshtasticId } = await import(
        '../shared/meshtastic-db-helpers.js'
      );

      ((db as { execute: MockedFn }).execute).mockResolvedValue([{ hit_count: 1 }]);
      (isNonceUsed as MockedFn).mockResolvedValue(false);
      (findNodeByMeshtasticId as MockedFn).mockResolvedValue(null);
      (registerNode as MockedFn).mockResolvedValue({
        node: {
          meshtasticNodeId: '!burstnode',
          wrfcoinAddress: wallet.address,
          registeredAt: new Date(),
          geoFenceStatus: 'manual_review_required',
          geoFenceGrid: '9q8yyk',
          geoFenceBurstCount: 2,
        },
        isNew: true,
      });
      (markNonceUsed as MockedFn).mockResolvedValue(undefined);

      const { processRegistration } = await import('../shared/meshtastic-registration-service.js');

      const nodeId = '!burstnode';
      const nonce = generateRegistrationNonce();
      const timestamp = getCurrentTimestamp();
      const message = constructRegistrationMessage(nodeId, wallet.address, nonce, timestamp);
      const signature = await wallet.signMessage(message);

      const request: RegistrationRequest = {
        meshtasticNodeId: nodeId,
        wrfcoinAddress: wallet.address,
        nonce,
        timestamp,
        signature,
        location: {
          lat: 37.7749,
          lon: -122.4194,
        },
      };

      const result = await processRegistration(request);

      expect(result.success).toBe(true);
      expect(result.registration?.manualAttestationRequired).toBe(true);
      expect(result.registration?.geoFenceStatus).toBe('manual_review_required');
      expect(result.registration?.geoFenceBurstCount).toBe(2);
      expect(registerNode).toHaveBeenCalledWith(
        expect.objectContaining({
          geoFenceStatus: 'manual_review_required',
          geoFenceBurstCount: 2,
          geoFenceGrid: expect.any(String),
        })
      );
    });

    it('should preserve rejected geo-fence status on self re-registration', async () => {
      const { db } = await import('../database/db.js');
      const { isNonceUsed, registerNode, markNonceUsed, findNodeByMeshtasticId } = await import(
        '../shared/meshtastic-db-helpers.js'
      );

      ((db as { execute: MockedFn }).execute).mockResolvedValue([{ hit_count: 0 }]);
      (isNonceUsed as MockedFn).mockResolvedValue(false);
      (findNodeByMeshtasticId as MockedFn).mockResolvedValue({
        meshtasticNodeId: '!rejected-node',
        wrfcoinAddress: wallet.address.toLowerCase(),
        location: { lat: 37.7749, lon: -122.4194 },
        geoFenceGrid: '9q8yyk',
        geoFenceStatus: 'rejected',
        geoFenceReason: 'admin_reject_hold',
        geoFenceBurstCount: 2,
        geoFenceWindowStartedAt: new Date('2026-03-11T12:00:00.000Z'),
        geoFenceTriggeredAt: new Date('2026-03-11T12:01:00.000Z'),
      });
      (registerNode as MockedFn).mockResolvedValue({
        node: {
          meshtasticNodeId: '!rejected-node',
          wrfcoinAddress: wallet.address,
          registeredAt: new Date(),
          geoFenceStatus: 'rejected',
          geoFenceGrid: '9q8yyk',
          geoFenceBurstCount: 2,
        },
        isNew: false,
      });
      (markNonceUsed as MockedFn).mockResolvedValue(undefined);

      const { processRegistration } = await import('../shared/meshtastic-registration-service.js');

      const nodeId = '!rejected-node';
      const nonce = generateRegistrationNonce();
      const timestamp = getCurrentTimestamp();
      const message = constructRegistrationMessage(nodeId, wallet.address, nonce, timestamp);
      const signature = await wallet.signMessage(message);

      const result = await processRegistration({
        meshtasticNodeId: nodeId,
        wrfcoinAddress: wallet.address,
        nonce,
        timestamp,
        signature,
      });

      expect(result.success).toBe(true);
      expect(result.registration?.isNew).toBe(false);
      expect(result.registration?.geoFenceStatus).toBe('rejected');
      expect(result.registration?.manualAttestationRequired).toBe(true);
      expect((db as { execute: MockedFn }).execute).not.toHaveBeenCalled();
      expect(registerNode).toHaveBeenCalledWith(
        expect.objectContaining({
          geoFenceStatus: 'rejected',
          geoFenceReason: 'admin_reject_hold',
          geoFenceBurstCount: 2,
        })
      );
    });
  });

  describe('Security Tests', () => {
    describe('Replay Attack Prevention', () => {
      it('should prevent replay of same registration', async () => {
        const { isNonceUsed, registerNode, markNonceUsed } = await import(
          '../shared/meshtastic-db-helpers.js'
        );

        const wallet = ethers.Wallet.createRandom();
        const nodeId = '!testnode';
        const nonce = generateRegistrationNonce();
        const timestamp = getCurrentTimestamp();

        const message = constructRegistrationMessage(nodeId, wallet.address, nonce, timestamp);
        const signature = await wallet.signMessage(message);

        const request: RegistrationRequest = {
          meshtasticNodeId: nodeId,
          wrfcoinAddress: wallet.address,
          nonce,
          timestamp,
          signature,
        };

        // First request succeeds
        (isNonceUsed as MockedFn).mockResolvedValueOnce(false);
        (registerNode as MockedFn).mockResolvedValueOnce({
          node: { meshtasticNodeId: nodeId, wrfcoinAddress: wallet.address },
          isNew: true,
        });
        (markNonceUsed as MockedFn).mockResolvedValueOnce(undefined);

        const { processRegistration } = await import('../shared/meshtastic-registration-service.js');

        const result1 = await processRegistration(request);
        expect(result1.success).toBe(true);

        // Second request with same nonce fails
        (isNonceUsed as MockedFn).mockResolvedValueOnce(true);

        const result2 = await processRegistration(request);
        expect(result2.success).toBe(false);
        expect(result2.error).toContain('Nonce has already been used');
      });

      it('should handle duplicate nonce insert race as replay conflict', async () => {
        const {
          isNonceUsed,
          registerNode,
          markNonceUsed,
          RegistrationNonceAlreadyUsedError,
        } = await import('../shared/meshtastic-db-helpers.js');

        const wallet = ethers.Wallet.createRandom();
        const nodeId = '!race-node';
        const nonce = generateRegistrationNonce();
        const timestamp = getCurrentTimestamp();
        const message = constructRegistrationMessage(nodeId, wallet.address, nonce, timestamp);
        const signature = await wallet.signMessage(message);

        const request: RegistrationRequest = {
          meshtasticNodeId: nodeId,
          wrfcoinAddress: wallet.address,
          nonce,
          timestamp,
          signature,
        };

        (isNonceUsed as MockedFn).mockResolvedValueOnce(false);
        (registerNode as MockedFn).mockResolvedValueOnce({
          node: { meshtasticNodeId: nodeId, wrfcoinAddress: wallet.address },
          isNew: true,
        });
        (markNonceUsed as MockedFn).mockRejectedValueOnce(
          new (RegistrationNonceAlreadyUsedError as any)('duplicate')
        );

        const { processRegistration } = await import('../shared/meshtastic-registration-service.js');
        const result = await processRegistration(request);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Nonce has already been used');
      });
    });

    describe('Timestamp Window Validation', () => {
      it('should reject requests outside 5-minute window', () => {
        const oldTimestamp = getCurrentTimestamp() - 400; // 6+ minutes ago

        const request: RegistrationRequest = {
          meshtasticNodeId: '!testnode',
          wrfcoinAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18',
          nonce: 1,
          timestamp: oldTimestamp,
          signature: '0x' + 'a'.repeat(130),
        };

        const result = validateRegistrationRequest(request);
        expect(result.valid).toBe(false);
        expect(result.errors.some(e => e.includes('expired'))).toBe(true);
      });

      it('should accept requests within valid window', () => {
        const validTimestamp = getCurrentTimestamp() - 120; // 2 minutes ago

        const request: RegistrationRequest = {
          meshtasticNodeId: '!testnode',
          wrfcoinAddress: '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18',
          nonce: 1,
          timestamp: validTimestamp,
          signature: '0x' + 'a'.repeat(130),
        };

        const result = validateRegistrationRequest(request);
        // Should not have timestamp errors
        expect(result.errors.filter(e => e.includes('timestamp'))).toHaveLength(0);
      });
    });

    describe('Address Impersonation Prevention', () => {
      it('should prevent registration with address user does not control', async () => {
        const { isNonceUsed } = await import('../shared/meshtastic-db-helpers.js');
        (isNonceUsed as MockedFn).mockResolvedValue(false);

        const { processRegistration } = await import('../shared/meshtastic-registration-service.js');

        // Attacker tries to register a victim's address
        const attackerWallet = ethers.Wallet.createRandom();
        const victimAddress = '0x742d35Cc6634C0532925a3b844Bc9e7595f2eA18';

        const nodeId = '!attacker-node';
        const nonce = generateRegistrationNonce();
        const timestamp = getCurrentTimestamp();

        // Sign with attacker's key but claim victim's address
        const message = constructRegistrationMessage(nodeId, victimAddress, nonce, timestamp);
        const attackerSignature = await attackerWallet.signMessage(message);

        const request: RegistrationRequest = {
          meshtasticNodeId: nodeId,
          wrfcoinAddress: victimAddress,
          nonce,
          timestamp,
          signature: attackerSignature,
        };

        const result = await processRegistration(request);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Signature verification failed');
      });
    });
  });
});
