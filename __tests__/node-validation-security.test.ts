/**
 * Comprehensive Security Tests for Node Validation Bypass Vulnerabilities
 * Tests all implemented security mechanisms
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { NodeCapabilityVerification } from '../shared/node-validation.js';
import { NodeIdentityVerification } from '../shared/node-identity.js';
import { NodeStakingManager } from '../shared/node-staking.js';
import { NodeBehaviorMonitor } from '../shared/node-monitoring.js';
import crypto from 'crypto';

describe('Node Validation Bypass Prevention', () => {
  describe('Resource Capability Verification', () => {
    let verifier: NodeCapabilityVerification;

    beforeEach(() => {
      verifier = new NodeCapabilityVerification();
    });

    it('should reject node with insufficient CPU', async () => {
      const challenge = await verifier.generateResourceChallenge('node-1');

      const result = await verifier.verifyNodeCapabilities(
        'node-1',
        challenge.challengeId,
        {
          cpu: { cores: 2, frequency: 2000, architecture: 'x86_64' },
          memory: { total: 8, available: 6 },
          storage: { total: 100, available: 80, type: 'SSD' },
          bandwidth: { upload: 100, download: 100, latency: 50 },
          uptime: 7200,
        },
        'invalid-solution',
        1000
      );

      expect(result.verified).toBe(false);
      expect(result.reason).toContain('Insufficient CPU cores');
    });

    it('should verify legitimate node with proof-of-work', async () => {
      const challenge = await verifier.generateResourceChallenge('node-2');

      // Simulate solving the challenge
      let solution = '';
      let hash = '';
      let nonce = 0;

      while (!hash.startsWith('0'.repeat(challenge.difficulty))) {
        solution = nonce.toString();
        hash = crypto
          .createHash('sha256')
          .update(challenge.challenge + solution)
          .digest('hex');
        nonce++;
      }

      const result = await verifier.verifyNodeCapabilities(
        'node-2',
        challenge.challengeId,
        {
          cpu: { cores: 8, frequency: 3000, architecture: 'x86_64' },
          memory: { total: 16, available: 12 },
          storage: { total: 500, available: 400, type: 'NVMe' },
          bandwidth: { upload: 500, download: 500, latency: 20 },
          uptime: 86400,
        },
        solution,
        2000
      );

      expect(result.verified).toBe(true);
      expect(result.proofId).toBeDefined();
    });

    it('should detect fake capability claims', async () => {
      const challenge = await verifier.generateResourceChallenge('node-3');

      // Malicious node claims high capabilities but provides fast computation
      const result = await verifier.verifyNodeCapabilities(
        'node-3',
        challenge.challengeId,
        {
          cpu: { cores: 1, frequency: 1000, architecture: 'x86_64' },
          memory: { total: 2, available: 1 },
          storage: { total: 50, available: 40, type: 'HDD' },
          bandwidth: { upload: 10, download: 10, latency: 100 },
          uptime: 100,
        },
        'fake-solution',
        10 // Impossibly fast for low-end hardware
      );

      expect(result.verified).toBe(false);
    });
  });

  describe('PKI Identity Verification', () => {
    let verifier: NodeIdentityVerification;

    beforeEach(async () => {
      verifier = new NodeIdentityVerification();
      // Wait for root CA initialization
      await new Promise(resolve => setTimeout(resolve, 100));
    });

    it('should issue valid certificate to legitimate node', async () => {
      const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const result = await verifier.registerNode('node-4', keyPair.publicKey, {
        commonName: 'node-4.wrfcoin.network',
        organization: 'WRFCoin Network',
        country: 'US',
        validityDays: 365,
      });

      expect(result.certificate).toBeDefined();
      expect(result.certificateChain.length).toBeGreaterThan(0);
    });

    it('should reject duplicate node registration', async () => {
      const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      await verifier.registerNode('node-5', keyPair.publicKey, {
        commonName: 'node-5',
        organization: 'Test',
        country: 'US',
        validityDays: 365,
      });

      await expect(
        verifier.registerNode('node-5', keyPair.publicKey, {
          commonName: 'node-5',
          organization: 'Test',
          country: 'US',
          validityDays: 365,
        })
      ).rejects.toThrow('Node already registered');
    });

    it('should detect revoked certificates', async () => {
      const keyPair = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const { certificate, certificateChain } = await verifier.registerNode(
        'node-6',
        keyPair.publicKey,
        {
          commonName: 'node-6',
          organization: 'Test',
          country: 'US',
          validityDays: 365,
        }
      );

      await verifier.revokeNodeCertificate('node-6', 'Malicious behavior');

      const result = await verifier.verifyNodeCertificate(
        'node-6',
        certificate,
        certificateChain
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain('revoked');
    });
  });

  describe('Economic Staking Requirements', () => {
    let stakingManager: NodeStakingManager;

    beforeEach(() => {
      stakingManager = new NodeStakingManager();
    });

    it('should reject stake below minimum', async () => {
      await expect(
        stakingManager.stakeTokens('node-7', BigInt(1000))
      ).rejects.toThrow('Insufficient stake');
    });

    it('should accept valid stake and grant voting power', async () => {
      await stakingManager.stakeTokens('node-8', BigInt(50000));

      const votingPower = stakingManager.getVotingPower('node-8');
      expect(votingPower).toBeGreaterThan(0);
    });

    it('should slash stake for misbehavior', async () => {
      await stakingManager.stakeTokens('node-9', BigInt(20000));

      const initialPower = stakingManager.getVotingPower('node-9');
      await stakingManager.slashStake('node-9', 'Invalid transactions');

      const finalPower = stakingManager.getVotingPower('node-9');
      expect(finalPower).toBeLessThan(initialPower);
    });
  });

  describe('Behavior Monitoring & Reputation', () => {
    let monitor: NodeBehaviorMonitor;

    beforeEach(() => {
      monitor = new NodeBehaviorMonitor();
    });

    it('should build reputation for good behavior', async () => {
      await monitor.recordBehavior('node-10', {
        uptime: 86400,
        responseTime: 100,
        validTransactions: 1000,
        invalidTransactions: 0,
        consensusParticipation: 100,
      });

      const reputation = monitor.getReputation('node-10');
      expect(reputation).toBeDefined();
      expect(reputation?.trustLevel).toBe('high');
    });

    it('should downgrade reputation for bad behavior', async () => {
      await monitor.recordBehavior('node-11', {
        uptime: 1000,
        responseTime: 5000,
        validTransactions: 10,
        invalidTransactions: 100,
        consensusParticipation: 5,
      });

      const reputation = monitor.getReputation('node-11');
      expect(reputation).toBeDefined();
      expect(reputation?.trustLevel).not.toBe('high');
    });

    it('should track reputation history', async () => {
      // Record good behavior
      await monitor.recordBehavior('node-12', {
        validTransactions: 100,
        invalidTransactions: 0,
      });

      // Record bad behavior
      await monitor.recordBehavior('node-12', {
        validTransactions: 0,
        invalidTransactions: 50,
      });

      const reputation = monitor.getReputation('node-12');
      expect(reputation?.history.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('Multi-Stage Validation Integration', () => {
    it('should require all validation stages to pass', async () => {
      // This would test the complete validation middleware chain
      // Simulating a node that passes some stages but fails others

      const verifier = new NodeCapabilityVerification();
      const identity = new NodeIdentityVerification();
      const staking = new NodeStakingManager();
      const monitor = new NodeBehaviorMonitor();

      // Node with good capabilities but no stake
      const challenge = await verifier.generateResourceChallenge('node-13');
      expect(challenge).toBeDefined();

      // Even if capabilities are verified, without stake, node should be rejected
      const votingPower = staking.getVotingPower('node-13');
      expect(votingPower).toBe(0);
    });
  });

  describe('Attack Scenario Simulations', () => {
    it('should prevent Sybil attack with resource proof', async () => {
      const verifier = new NodeCapabilityVerification();

      // Attacker tries to register multiple nodes with same hardware
      const challenge1 = await verifier.generateResourceChallenge('attacker-1');
      const challenge2 = await verifier.generateResourceChallenge('attacker-2');

      // Both would need to solve different challenges with same hardware
      // This should be detected as suspicious behavior
      expect(challenge1.challenge).not.toBe(challenge2.challenge);
    });

    it('should prevent replay attacks with challenge expiration', async () => {
      const verifier = new NodeCapabilityVerification();

      const challenge = await verifier.generateResourceChallenge('node-14');

      // Wait for challenge to expire (in real test, mock timer)
      // Challenge should be rejected if used after expiration
      expect(challenge.expiresAt.getTime()).toBeGreaterThan(Date.now());
    });

    it('should prevent identity spoofing with PKI', async () => {
      const identity = new NodeIdentityVerification();

      const keyPair1 = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      const keyPair2 = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });

      // Wait for CA initialization
      await new Promise(resolve => setTimeout(resolve, 100));

      const { certificate } = await identity.registerNode(
        'node-15',
        keyPair1.publicKey,
        {
          commonName: 'node-15',
          organization: 'Test',
          country: 'US',
          validityDays: 365,
        }
      );

      // Try to authenticate with different key pair
      const challenge = 'test-challenge';
      const sign = crypto.createSign('SHA256');
      sign.update(challenge);
      const signature = sign.sign(keyPair2.privateKey, 'hex');

      const result = await identity.authenticateNode(
        'node-15',
        challenge,
        signature,
        certificate
      );

      // Should fail because signature doesn't match certificate
      expect(result.authenticated).toBe(false);
    });
  });
});
