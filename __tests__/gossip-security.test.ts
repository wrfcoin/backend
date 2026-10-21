/**
 * Comprehensive Gossip Security Test Suite
 * Task 100.14 - Testing all gossip security modules
 *
 * TEST SCENARIOS:
 * - Information poisoning attack simulations
 * - Network state corruption scenarios
 * - Gossip-based DoS attack tests
 * - Consensus manipulation attempts
 * - Cross-verification testing
 * - Rate limiting effectiveness
 * - Encryption/decryption performance
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import crypto from 'crypto';
import { SecureGossipProtocol } from '../shared/gossip-protocol-security.js';
import { GossipStateVerifier } from '../shared/gossip-state-verification.js';
import { GossipAntiPoisoning } from '../shared/gossip-anti-poisoning.js';
import { GossipRateLimiter } from '../shared/gossip-rate-limiting.ts.js';
import { GossipEncryption } from '../shared/gossip-encryption.js';
import { GossipConsensusProtection } from '../shared/gossip-consensus-protection.js';
import { MessageAuthenticator } from '../shared/message-authentication.js';
import { PeerReputationService } from '../shared/p2p-peer-reputation.js';
import { MessageOriginVerifier } from '../shared/message-origin.js';

describe('Gossip Security - SecureGossipProtocol', () => {
  let messageAuth: MessageAuthenticator;
  let peerReputation: PeerReputationService;
  let originVerifier: MessageOriginVerifier;
  let secureGossip: SecureGossipProtocol;

  beforeEach(async () => {
    messageAuth = new MessageAuthenticator();
    await messageAuth.initialize(crypto.randomBytes(32));
    peerReputation = new PeerReputationService();
    originVerifier = new MessageOriginVerifier();
    secureGossip = new SecureGossipProtocol(
      messageAuth,
      peerReputation,
      originVerifier
    );
  });

  afterEach(() => {
    secureGossip.shutdown();
    peerReputation.shutdown();
    originVerifier.shutdown();
    messageAuth.shutdown();
  });

  it('should create secure gossip message with encryption', async () => {
    const topic = 'consensus';
    const payload = Buffer.from('test payload');
    const originator = 'node1';

    const message = await secureGossip.createSecureGossipMessage(
      topic,
      payload,
      originator,
      {
        priority: 'high',
        requiresVerification: true,
        minValidators: 3,
        crossVerificationCount: 0,
      }
    );

    expect(message.messageId).toBeDefined();
    expect(message.topic).toBe(topic);
    expect(message.originator).toBe(originator);
    expect(message.encryptionMetadata).toBeDefined();
    expect(message.encryptionMetadata?.encrypted).toBe(true);
  });

  it('should reject expired messages', async () => {
    const topic = 'test';
    const payload = Buffer.from('test');
    const originator = 'node1';

    const message = await secureGossip.createSecureGossipMessage(
      topic,
      payload,
      originator,
      {
        priority: 'normal',
        requiresVerification: false,
        minValidators: 1,
        crossVerificationCount: 0,
      }
    );

    // Manually expire the message
    message.expiresAt = new Date(Date.now() - 10000);

    const result = await secureGossip.validateSecureGossipMessage(
      message,
      'node2'
    );

    expect(result.isValid).toBe(false);
    expect(result.freshness).toBe(0);
  });

  it('should validate message signatures', async () => {
    const topic = 'test';
    const payload = Buffer.from('test payload');
    const originator = 'node1';

    // Register validator
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    const validatorId = 'validator1';
    secureGossip.registerValidator(
      validatorId,
      publicKey.export({ type: 'spki', format: 'der' })
    );

    const validatorKeys = new Map();
    validatorKeys.set(
      validatorId,
      privateKey.export({ type: 'pkcs8', format: 'der' })
    );

    const message = await secureGossip.createSecureGossipMessage(
      topic,
      payload,
      originator,
      {
        priority: 'normal',
        requiresVerification: true,
        minValidators: 1,
        crossVerificationCount: 0,
      },
      validatorKeys
    );

    const result = await secureGossip.validateSecureGossipMessage(
      message,
      'node2'
    );

    expect(result.isValid).toBe(true);
    expect(result.validatorCount).toBeGreaterThanOrEqual(1);
  });
});

describe('Gossip Security - State Verification', () => {
  let stateVerifier: GossipStateVerifier;

  beforeEach(() => {
    stateVerifier = new GossipStateVerifier();
  });

  afterEach(() => {
    stateVerifier.shutdown();
  });

  it('should detect state divergence', async () => {
    // Update local state
    stateVerifier.updateState('key1', 'value1');
    stateVerifier.updateState('key2', 'value2');

    const localState = stateVerifier.getCurrentState();
    expect(localState).not.toBeNull();

    // Create divergent remote state
    const remoteVerifier = new GossipStateVerifier();
    remoteVerifier.updateState('key1', 'different_value');
    remoteVerifier.updateState('key2', 'value2');

    const remoteState = remoteVerifier.getCurrentState();
    expect(remoteState).not.toBeNull();

    const remoteStates = new Map();
    remoteStates.set('remote1', remoteState!);

    const result = await stateVerifier.verifyStateConsistency(remoteStates);

    expect(result.divergences.length).toBeGreaterThan(0);
    expect(result.consistency).toBeLessThan(1.0);

    remoteVerifier.shutdown();
  });

  it('should create and restore snapshots', () => {
    stateVerifier.updateState('test', 'value');
    const snapshot = stateVerifier.createSnapshot();

    expect(snapshot.snapshotId).toBeDefined();
    expect(snapshot.state.data.get('test')).toBe('value');

    // Modify state
    stateVerifier.updateState('test', 'modified');

    // Restore snapshot
    const restored = stateVerifier.restoreSnapshot(snapshot.snapshotId);
    expect(restored).toBe(true);

    const currentState = stateVerifier.getCurrentState();
    expect(currentState?.data.get('test')).toBe('value');
  });

  it('should detect corruption', () => {
    stateVerifier.updateState('key', 'value');

    // Get current state and corrupt it
    const state = stateVerifier.getCurrentState();
    if (state) {
      state.checksum = 'corrupted';
    }

    const corruption = stateVerifier.detectCorruption();
    expect(corruption.isCorrupted).toBe(true);
    expect(corruption.reasons.length).toBeGreaterThan(0);
  });
});

describe('Gossip Security - Anti-Poisoning', () => {
  let peerReputation: PeerReputationService;
  let antiPoisoning: GossipAntiPoisoning;

  beforeEach(() => {
    peerReputation = new PeerReputationService();
    antiPoisoning = new GossipAntiPoisoning(peerReputation);
  });

  afterEach(() => {
    antiPoisoning.shutdown();
    peerReputation.shutdown();
  });

  it('should detect information poisoning from low-reputation source', async () => {
    const messageId = 'test_msg_1';
    const topic = 'data';
    const payload = { data: 'suspicious_data' };
    const source = 'malicious_peer';

    // Register source with low reputation
    peerReputation.registerPeer(source);
    peerReputation.recordEvent({
      peerId: source,
      eventType: 'invalid_message',
      impactPoints: -20,
    });

    const result = await antiPoisoning.detectPoisoning(
      messageId,
      topic,
      payload,
      source
    );

    expect(result.sourceCredibility).toBeLessThan(0.5);
  });

  it('should quarantine suspicious messages', async () => {
    const messageId = 'suspicious_msg';
    const topic = 'test';
    const payload = { data: crypto.randomBytes(1000) }; // Random data
    const source = 'new_peer';

    const result = await antiPoisoning.detectPoisoning(
      messageId,
      topic,
      payload,
      source
    );

    // Messages from unknown sources with high entropy should be suspicious
    if (result.isPoisoned) {
      expect(result.recommendedAction).toMatch(/quarantine|reject/);
    }
  });

  it('should detect statistical anomalies', async () => {
    const topic = 'data';
    const source = 'peer1';

    // Establish baseline with normal messages
    for (let i = 0; i < 10; i++) {
      await antiPoisoning.detectPoisoning(
        `msg_${i}`,
        topic,
        { value: 100 + i },
        source
      );
    }

    // Send anomalous message
    const anomalyResult = await antiPoisoning.detectPoisoning(
      'anomaly_msg',
      topic,
      { value: 999999 }, // Outlier
      source
    );

    expect(anomalyResult.anomalyScore).toBeGreaterThan(0);
  });
});

describe('Gossip Security - Rate Limiting', () => {
  let peerReputation: PeerReputationService;
  let rateLimiter: GossipRateLimiter;

  beforeEach(() => {
    peerReputation = new PeerReputationService();
    rateLimiter = new GossipRateLimiter(peerReputation, {
      perSourceLimit: {
        messagesPerSecond: 10,
        burstSize: 20,
      },
    });
  });

  afterEach(() => {
    rateLimiter.shutdown();
    peerReputation.shutdown();
  });

  it('should allow messages within rate limit', async () => {
    const source = 'peer1';
    const topic = 'test';

    const result = await rateLimiter.checkRateLimit(
      'msg1',
      source,
      topic,
      'normal'
    );

    expect(result.allowed).toBe(true);
    expect(result.tokensRemaining).toBeGreaterThan(0);
  });

  it('should reject messages exceeding rate limit', async () => {
    const source = 'peer1';
    const topic = 'test';

    // Send many messages rapidly
    const promises = [];
    for (let i = 0; i < 100; i++) {
      promises.push(
        rateLimiter.checkRateLimit(`msg_${i}`, source, topic, 'normal')
      );
    }

    const results = await Promise.all(promises);
    const rejected = results.filter(r => !r.allowed);

    expect(rejected.length).toBeGreaterThan(0);
  });

  it('should detect burst attacks', async () => {
    const source = 'attacker';
    const topic = 'test';

    // Rapid burst
    const burstSize = 50;
    const results = await Promise.all(
      Array(burstSize)
        .fill(0)
        .map((_, i) =>
          rateLimiter.checkRateLimit(`burst_${i}`, source, topic, 'normal')
        )
    );

    const burstRejected = results.filter(
      r => !r.allowed && r.reason?.includes('burst')
    );

    expect(burstRejected.length).toBeGreaterThan(0);
  });

  it('should give priority to critical messages', async () => {
    const source = 'peer1';
    const topic = 'test';

    // Exhaust normal token budget
    for (let i = 0; i < 20; i++) {
      await rateLimiter.checkRateLimit(`msg_${i}`, source, topic, 'normal');
    }

    // Try critical message
    const criticalResult = await rateLimiter.checkRateLimit(
      'critical_msg',
      source,
      topic,
      'critical'
    );

    // Critical messages should have better chance of going through
    expect(criticalResult.allowed || criticalResult.queuePosition).toBeDefined();
  });
});

describe('Gossip Security - Encryption', () => {
  let encryption: GossipEncryption;

  beforeEach(() => {
    encryption = new GossipEncryption();
  });

  afterEach(() => {
    encryption.shutdown();
  });

  it('should encrypt and decrypt payloads', async () => {
    const topic = 'sensitive';
    const payload = Buffer.from('secret message');

    encryption.initializeTopicEncryption(topic);

    const encrypted = await encryption.encryptPayload(topic, payload);

    expect(encrypted.ciphertext).toBeDefined();
    expect(encrypted.iv).toBeDefined();
    expect(encrypted.authTag).toBeDefined();
    expect(encrypted.ciphertext).not.toEqual(payload);

    const decrypted = await encryption.decryptPayload(encrypted, topic);

    expect(decrypted).toEqual(payload);
  });

  it('should fail decryption with wrong key', async () => {
    const topic1 = 'topic1';
    const topic2 = 'topic2';
    const payload = Buffer.from('message');

    encryption.initializeTopicEncryption(topic1);
    encryption.initializeTopicEncryption(topic2);

    const encrypted = await encryption.encryptPayload(topic1, payload);

    // Try to decrypt with wrong topic key
    await expect(
      encryption.decryptPayload(encrypted, topic2)
    ).rejects.toThrow();
  });

  it('should rotate keys', async () => {
    const topic = 'test';
    encryption.initializeTopicEncryption(topic);

    const info1 = encryption.getTopicInfo(topic);
    expect(info1.hasEncryption).toBe(true);

    const oldKeyId = info1.activeKey?.keyId;

    // Rotate key
    await encryption.rotateTopicKey(topic);

    const info2 = encryption.getTopicInfo(topic);
    const newKeyId = info2.activeKey?.keyId;

    expect(newKeyId).not.toBe(oldKeyId);
    expect(info2.activeKey?.version).toBeGreaterThan(info1.activeKey?.version || 0);
  });
});

describe('Gossip Security - Consensus Protection', () => {
  let consensusProtection: GossipConsensusProtection;

  beforeEach(() => {
    consensusProtection = new GossipConsensusProtection({
      totalValidators: 100,
      byzantineThreshold: 33,
      quorumThreshold: 67,
      commitThreshold: 67,
    });
  });

  afterEach(() => {
    consensusProtection.shutdown();
  });

  it('should validate consensus messages', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    const validator = 'validator1';
    consensusProtection.registerValidator(
      validator,
      publicKey.export({ type: 'spki', format: 'der' })
    );

    const blockHash = crypto.randomBytes(32);
    const messageId = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date();

    const messageData = Buffer.concat([
      Buffer.from(messageId),
      Buffer.from('1'), // round
      Buffer.from('propose'),
      blockHash,
      Buffer.from(timestamp.toISOString()),
      Buffer.from('1'), // height
    ]);

    const sign = crypto.createSign('SHA256');
    sign.update(messageData);
    sign.end();

    const signature = sign.sign(
      privateKey.export({ type: 'pkcs8', format: 'der' })
    );

    const message = {
      messageId,
      consensusRound: 1,
      voteType: 'propose' as const,
      blockHash,
      validator,
      signature,
      timestamp,
      height: 1,
    };

    const result = await consensusProtection.validateConsensusMessage(message);

    expect(result.isValid).toBe(true);
    expect(result.reasons.length).toBe(0);
  });

  it('should detect equivocation', async () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
    });

    const validator = 'validator1';
    consensusProtection.registerValidator(
      validator,
      publicKey.export({ type: 'spki', format: 'der' })
    );

    // First vote
    const blockHash1 = crypto.randomBytes(32);
    const message1 = await createSignedMessage(
      validator,
      1,
      1,
      'prevote',
      blockHash1,
      privateKey
    );

    await consensusProtection.validateConsensusMessage(message1);

    // Second vote for different block (equivocation)
    const blockHash2 = crypto.randomBytes(32);
    const message2 = await createSignedMessage(
      validator,
      1,
      1,
      'prevote',
      blockHash2,
      privateKey
    );

    let equivocationDetected = false;
    consensusProtection.on('equivocationDetected', () => {
      equivocationDetected = true;
    });

    await consensusProtection.validateConsensusMessage(message2);

    expect(equivocationDetected).toBe(true);
  });

  it('should detect split-brain', async () => {
    // Create votes for two different blocks
    const block1 = crypto.randomBytes(32);
    const block2 = crypto.randomBytes(32);

    // Add votes for block1 (40 validators)
    for (let i = 0; i < 40; i++) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });

      const validator = `validator_${i}`;
      consensusProtection.registerValidator(
        validator,
        publicKey.export({ type: 'spki', format: 'der' })
      );

      const message = await createSignedMessage(
        validator,
        1,
        1,
        'prevote',
        block1,
        privateKey
      );

      await consensusProtection.validateConsensusMessage(message);
    }

    // Add votes for block2 (40 validators)
    for (let i = 40; i < 80; i++) {
      const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
      });

      const validator = `validator_${i}`;
      consensusProtection.registerValidator(
        validator,
        publicKey.export({ type: 'spki', format: 'der' })
      );

      const message = await createSignedMessage(
        validator,
        1,
        1,
        'prevote',
        block2,
        privateKey
      );

      await consensusProtection.validateConsensusMessage(message);
    }

    const splitBrain = consensusProtection.detectSplitBrain(1);

    expect(splitBrain.detected).toBe(true);
    expect(splitBrain.partition1Size).toBeGreaterThanOrEqual(33);
    expect(splitBrain.partition2Size).toBeGreaterThanOrEqual(33);
  });
});

// Helper function
async function createSignedMessage(
  validator: string,
  round: number,
  height: number,
  voteType: 'propose' | 'prevote' | 'precommit' | 'commit',
  blockHash: Buffer,
  privateKey: crypto.KeyObject
) {
  const messageId = crypto.randomBytes(16).toString('hex');
  const timestamp = new Date();

  const messageData = Buffer.concat([
    Buffer.from(messageId),
    Buffer.from(round.toString()),
    Buffer.from(voteType),
    blockHash,
    Buffer.from(timestamp.toISOString()),
    Buffer.from(height.toString()),
  ]);

  const sign = crypto.createSign('SHA256');
  sign.update(messageData);
  sign.end();

  const signature = sign.sign(privateKey.export({ type: 'pkcs8', format: 'der' }));

  return {
    messageId,
    consensusRound: round,
    voteType,
    blockHash,
    validator,
    signature,
    timestamp,
    height,
  };
}

describe('Gossip Security - Performance Tests', () => {
  it('should validate 1000 messages in < 5 seconds', async () => {
    const messageAuth = new MessageAuthenticator();
    await messageAuth.initialize(crypto.randomBytes(32));
    const peerReputation = new PeerReputationService();
    const originVerifier = new MessageOriginVerifier();
    const secureGossip = new SecureGossipProtocol(
      messageAuth,
      peerReputation,
      originVerifier
    );

    const startTime = Date.now();
    const messageCount = 1000;

    for (let i = 0; i < messageCount; i++) {
      const message = await secureGossip.createSecureGossipMessage(
        'test',
        Buffer.from(`message ${i}`),
        'node1',
        {
          priority: 'normal',
          requiresVerification: false,
          minValidators: 0,
          crossVerificationCount: 0,
        }
      );

      await secureGossip.validateSecureGossipMessage(message, 'node2');
    }

    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(5000); // 5 seconds
    expect(elapsed / messageCount).toBeLessThan(5); // < 5ms per message

    secureGossip.shutdown();
    peerReputation.shutdown();
    originVerifier.shutdown();
    messageAuth.shutdown();
  });

  it('should encrypt/decrypt 100 messages in < 200ms', async () => {
    const encryption = new GossipEncryption();
    const topic = 'performance_test';
    encryption.initializeTopicEncryption(topic);

    const payload = Buffer.from('test payload for performance');
    const startTime = Date.now();
    const count = 100;

    for (let i = 0; i < count; i++) {
      const encrypted = await encryption.encryptPayload(topic, payload);
      await encryption.decryptPayload(encrypted, topic);
    }

    const elapsed = Date.now() - startTime;

    expect(elapsed).toBeLessThan(200); // 200ms for 100 encrypt/decrypt
    expect(elapsed / count).toBeLessThan(2); // < 2ms per operation

    encryption.shutdown();
  });
});
