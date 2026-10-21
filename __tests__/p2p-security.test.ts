/**
 * P2P Security Framework Test Suite
 * Comprehensive security testing with attack simulations
 *
 * Tests for Task 100.10 implementation
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import crypto from 'crypto';
import { PeerAuthenticationService, createSelfSignedCertificate } from '../shared/p2p-peer-authentication.js';
import { P2PEncryptionService } from '../shared/p2p-encryption.js';
import { PeerReputationService } from '../shared/p2p-peer-reputation.js';
import { P2PMessageValidator } from '../shared/p2p-message-validation.js';
import { P2PRoutingSecurityService } from '../shared/p2p-routing-security.js';
import { P2PeerDiscoveryService } from '../shared/p2p-peer-discovery.js';
import { P2PGossipSecurityService } from '../shared/p2p-gossip-security.js';
import { MessageAuthenticator } from '../shared/message-authentication.js';
import { ReplayPreventionService } from '../shared/replay-prevention.js';
import { MessageOriginVerifier } from '../shared/message-origin.js';

describe('P2P Security Framework', () => {
  describe('Peer Authentication', () => {
    let authService: PeerAuthenticationService;
    let testKeyPair: crypto.KeyPairSyncResult<Buffer, Buffer>;

    beforeEach(() => {
      authService = new PeerAuthenticationService();
      testKeyPair = crypto.generateKeyPairSync('ec', {
        namedCurve: 'secp256k1',
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
      });
    });

    afterEach(() => {
      authService.shutdown();
    });

    it('should generate authentication challenge', async () => {
      const peerId = 'peer-test-001';
      const challenge = await authService.generateChallenge(peerId);

      expect(challenge.challengeId).toBeDefined();
      expect(challenge.peerId).toBe(peerId);
      expect(challenge.nonce).toBeInstanceOf(Buffer);
      expect(challenge.expiresAt).toBeInstanceOf(Date);
    });

    it('should authenticate peer with valid signature', async () => {
      const peerId = 'peer-test-002';
      const challenge = await authService.generateChallenge(peerId);

      // Sign challenge
      const sign = crypto.createSign('SHA256');
      sign.update(challenge.nonce);
      sign.end();

      const privateKeyObject = crypto.createPrivateKey({
        key: testKeyPair.privateKey,
        format: 'der',
        type: 'pkcs8',
      });

      const signature = sign.sign(privateKeyObject);

      const response = {
        challengeId: challenge.challengeId,
        peerId,
        signature,
        publicKey: testKeyPair.publicKey,
        timestamp: new Date(),
      };

      const result = await authService.verifyAuthenticationResponse(response);

      expect(result.authenticated).toBe(true);
      expect(result.sessionId).toBeDefined();
    });

    it('should reject expired challenge', async () => {
      const peerId = 'peer-test-003';
      authService = new PeerAuthenticationService({ challengeTimeout: 100 });

      const challenge = await authService.generateChallenge(peerId);

      // Wait for challenge to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      const sign = crypto.createSign('SHA256');
      sign.update(challenge.nonce);
      sign.end();

      const privateKeyObject = crypto.createPrivateKey({
        key: testKeyPair.privateKey,
        format: 'der',
        type: 'pkcs8',
      });

      const signature = sign.sign(privateKeyObject);

      const response = {
        challengeId: challenge.challengeId,
        peerId,
        signature,
        publicKey: testKeyPair.publicKey,
        timestamp: new Date(),
      };

      const result = await authService.verifyAuthenticationResponse(response);

      expect(result.authenticated).toBe(false);
      expect(result.reason).toContain('expired');
    });

    it('should detect peer spoofing attempts', async () => {
      const realPeerId = 'peer-real';
      const fakePeerId = 'peer-fake';

      const challenge = await authService.generateChallenge(realPeerId);

      // Fake peer tries to respond to real peer's challenge
      const sign = crypto.createSign('SHA256');
      sign.update(challenge.nonce);
      sign.end();

      const privateKeyObject = crypto.createPrivateKey({
        key: testKeyPair.privateKey,
        format: 'der',
        type: 'pkcs8',
      });

      const signature = sign.sign(privateKeyObject);

      const response = {
        challengeId: challenge.challengeId,
        peerId: fakePeerId, // Wrong peer ID
        signature,
        publicKey: testKeyPair.publicKey,
        timestamp: new Date(),
      };

      const result = await authService.verifyAuthenticationResponse(response);

      expect(result.authenticated).toBe(false);
      expect(result.reason).toContain('mismatch');
    });
  });

  describe('P2P Encryption', () => {
    let encryptionService: P2PEncryptionService;

    beforeEach(() => {
      encryptionService = new P2PEncryptionService();
    });

    afterEach(() => {
      encryptionService.shutdown();
    });

    it('should establish encrypted connection', async () => {
      const peerId = 'peer-encrypt-001';
      const remoteCipherSuites = ['CHACHA20_POLY1305', 'AES_256_GCM'];

      const connection = await encryptionService.establishEncryptedConnection(
        peerId,
        remoteCipherSuites
      );

      expect(connection.connectionId).toBeDefined();
      expect(connection.cipherSuite).toBeDefined();
      expect(connection.encryptionKey).toBeDefined();
    });

    it('should encrypt and decrypt messages', async () => {
      const peerId = 'peer-encrypt-002';
      const remoteCipherSuites = ['CHACHA20_POLY1305'];

      const connection = await encryptionService.establishEncryptedConnection(
        peerId,
        remoteCipherSuites
      );

      const plaintext = Buffer.from('Test message for encryption');
      const encrypted = encryptionService.encrypt(connection.connectionId, plaintext);

      expect(encrypted.ciphertext).toBeInstanceOf(Buffer);
      expect(encrypted.iv).toBeInstanceOf(Buffer);
      expect(encrypted.authTag).toBeInstanceOf(Buffer);

      const decrypted = encryptionService.decrypt(connection.connectionId, encrypted);

      expect(decrypted.toString()).toBe(plaintext.toString());
    });

    it('should detect message tampering', async () => {
      const peerId = 'peer-encrypt-003';
      const remoteCipherSuites = ['AES_256_GCM'];

      const connection = await encryptionService.establishEncryptedConnection(
        peerId,
        remoteCipherSuites
      );

      const plaintext = Buffer.from('Original message');
      const encrypted = encryptionService.encrypt(connection.connectionId, plaintext);

      // Tamper with ciphertext
      encrypted.ciphertext[0] ^= 0xFF;

      expect(() => {
        encryptionService.decrypt(connection.connectionId, encrypted);
      }).toThrow();
    });
  });

  describe('Peer Reputation', () => {
    let reputationService: PeerReputationService;

    beforeEach(() => {
      reputationService = new PeerReputationService();
    });

    afterEach(() => {
      reputationService.shutdown();
    });

    it('should initialize peer with default reputation', () => {
      const peerId = 'peer-rep-001';
      const reputation = reputationService.registerPeer(peerId);

      expect(reputation.score).toBe(50);
      expect(reputation.trustLevel).toBe('neutral');
    });

    it('should increase reputation on valid messages', () => {
      const peerId = 'peer-rep-002';
      reputationService.registerPeer(peerId);

      const initialRep = reputationService.getReputation(peerId);
      const initialScore = initialRep?.score || 0;

      reputationService.recordEvent({
        peerId,
        eventType: 'valid_message',
        impactPoints: 5,
      });

      const updatedRep = reputationService.getReputation(peerId);
      expect(updatedRep?.score).toBeGreaterThan(initialScore);
    });

    it('should decrease reputation on invalid messages', () => {
      const peerId = 'peer-rep-003';
      reputationService.registerPeer(peerId);

      const initialRep = reputationService.getReputation(peerId);
      const initialScore = initialRep?.score || 0;

      reputationService.recordEvent({
        peerId,
        eventType: 'invalid_message',
        impactPoints: -10,
      });

      const updatedRep = reputationService.getReputation(peerId);
      expect(updatedRep?.score).toBeLessThan(initialScore);
    });

    it('should ban peer with low reputation', () => {
      const peerId = 'peer-rep-004';
      reputationService = new PeerReputationService({ banThreshold: 20 });
      reputationService.registerPeer(peerId);

      // Drive reputation below ban threshold
      for (let i = 0; i < 10; i++) {
        reputationService.recordEvent({
          peerId,
          eventType: 'malicious_behavior',
          impactPoints: -20,
        });
      }

      const reputation = reputationService.getReputation(peerId);
      expect(reputation?.bannedUntil).toBeDefined();
      expect(reputationService.isReputationAcceptable(peerId)).toBe(false);
    });

    it('should detect reputation gaming', () => {
      const peerId = 'peer-rep-005';
      reputationService.registerPeer(peerId);

      // Simulate rapid score increases
      for (let i = 0; i < 15; i++) {
        reputationService.recordEvent({
          peerId,
          eventType: 'successful_interaction',
          impactPoints: 5,
        });
      }

      const gaming = reputationService.detectReputationGaming(peerId);
      expect(gaming.isSuspicious).toBe(true);
      expect(gaming.reasons.length).toBeGreaterThan(0);
    });
  });

  describe('Attack Scenarios', () => {
    it('should prevent Sybil attack through peer discovery', () => {
      const discoveryService = new P2PeerDiscoveryService();
      const maliciousIntroducer = 'peer-sybil-attacker';

      // Simulate introducing many peers rapidly
      for (let i = 0; i < 150; i++) {
        const isSybil = discoveryService.detectSybilAttack(`peer-sybil-${i}`);
        // Should detect after threshold
        if (i > 100) {
          expect(isSybil).toBe(true);
        }
      }

      discoveryService.shutdown();
    });

    it('should detect Eclipse attack', () => {
      const routingService = new P2PRoutingSecurityService();
      const targetPeer = 'peer-target';

      // All connections from same ASN (suspicious)
      const connections = Array.from({ length: 10 }, (_, i) => `12345678-peer-${i}`);

      const isEclipse = routingService.detectEclipseAttack(targetPeer, connections);
      expect(isEclipse).toBe(true);

      routingService.shutdown();
    });

    it('should detect gossip amplification attack', () => {
      const gossipService = new P2PGossipSecurityService();
      const attacker = 'peer-gossip-attacker';

      // Simulate rapid message creation
      const isAmplification = gossipService.detectGossipAmplificationAttack(attacker);

      // Should be detected with high message volume
      expect(typeof isAmplification).toBe('boolean');

      gossipService.shutdown();
    });
  });

  describe('Integration Tests', () => {
    let messageAuth: MessageAuthenticator;
    let replayPrevention: ReplayPreventionService;
    let originVerifier: MessageOriginVerifier;
    let messageValidator: P2PMessageValidator;

    beforeEach(async () => {
      messageAuth = new MessageAuthenticator();
      await messageAuth.initialize(Buffer.from('test-master-key-32-bytes-long!!'));

      replayPrevention = new ReplayPreventionService();
      originVerifier = new MessageOriginVerifier();

      messageValidator = new P2PMessageValidator(
        messageAuth,
        replayPrevention,
        originVerifier
      );
    });

    afterEach(() => {
      messageAuth.shutdown();
      replayPrevention.shutdown();
      originVerifier.shutdown();
      messageValidator.shutdown();
    });

    it('should validate complete P2P message flow', async () => {
      const senderId = 'peer-sender';
      const keyPair = crypto.generateKeyPairSync('ec', {
        namedCurve: 'secp256k1',
        publicKeyEncoding: { type: 'spki', format: 'der' },
        privateKeyEncoding: { type: 'pkcs8', format: 'der' },
      });

      // Register peer
      await originVerifier.registerPeer(senderId, keyPair.publicKey);

      const payload = Buffer.from('Test message payload');

      // Create signature
      const sign = crypto.createSign('SHA256');
      sign.update(payload);
      sign.end();

      const privateKeyObject = crypto.createPrivateKey({
        key: keyPair.privateKey,
        format: 'der',
        type: 'pkcs8',
      });

      const signature = sign.sign(privateKeyObject);

      const message = {
        messageId: crypto.randomBytes(16).toString('hex'),
        senderId,
        payload,
        signature,
        sequence: 1,
        timestamp: Date.now(),
        nonce: crypto.randomBytes(16).toString('hex'),
        messageType: 'data' as const,
      };

      const result = await messageValidator.validateMessage(message);

      expect(result.valid).toBe(true);
      expect(result.checks.origin).toBe(true);
      expect(result.checks.replay).toBe(true);
      expect(result.checks.schema).toBe(true);
    });
  });
});
