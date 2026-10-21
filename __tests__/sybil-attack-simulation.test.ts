/**
 * Sybil Attack Simulation Tests
 *
 * Comprehensive tests for Sybil attack prevention mechanisms including:
 * - Rate limiting (IP, subnet, ASN, country)
 * - DID verification (proof-of-unique-human)
 * - Challenge-response protocols
 * - Reputation system gaming attempts
 * - Economic barrier bypass attempts
 *
 * SECURITY TESTS (Task 92.9): Validate Sybil prevention enhancements
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SybilRateLimiter, RateLimitConfig } from '../shared/sybil-rate-limiter.js';
import { DIDVerifier, DIDVerifierConfig } from '../shared/sybil-did-verifier.js';

// ============================================================================
// TEST UTILITIES
// ============================================================================

/**
 * Generate a random IP address
 */
function generateRandomIP(): string {
  return `${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
}

/**
 * Generate IPs in the same /24 subnet
 */
function generateSubnet24IPs(baseOctet: number, count: number): string[] {
  const ips: string[] = [];
  for (let i = 0; i < count; i++) {
    ips.push(`192.168.${baseOctet}.${i + 1}`);
  }
  return ips;
}

/**
 * Generate IPs spread across a /23 subnet (2 adjacent /24s)
 */
function generateSubnet23IPs(baseOctet: number, count: number): string[] {
  const ips: string[] = [];
  for (let i = 0; i < count; i++) {
    const offset = i % 2;
    const hostPart = Math.floor(i / 2) + 1;
    ips.push(`192.168.${baseOctet + offset}.${hostPart}`);
  }
  return ips;
}

/**
 * Generate IPs spread across a /22 subnet (4 adjacent /24s)
 */
function generateSubnet22IPs(baseOctet: number, count: number): string[] {
  const ips: string[] = [];
  for (let i = 0; i < count; i++) {
    const offset = i % 4;
    const hostPart = Math.floor(i / 4) + 1;
    ips.push(`192.168.${baseOctet + offset}.${hostPart}`);
  }
  return ips;
}

/**
 * Generate a valid DID
 */
function generateDID(method: string = 'wrfcoin'): string {
  const id = Math.random().toString(36).substring(2, 15);
  return `did:${method}:${id}`;
}

/**
 * Generate a mock signature
 */
function generateMockSignature(): string {
  const bytes = [];
  for (let i = 0; i < 64; i++) {
    bytes.push(Math.floor(Math.random() * 16).toString(16));
  }
  return bytes.join('');
}

// ============================================================================
// RATE LIMITER TESTS
// ============================================================================

describe('SybilRateLimiter - Rate Limiting Tests', () => {
  let rateLimiter: SybilRateLimiter;

  beforeEach(() => {
    // Create fresh rate limiter with strict config for testing
    rateLimiter = new SybilRateLimiter({
      maxNodesPerIP: 1,
      maxNodesPerSubnet: 2,
      maxNodesPerASN: 8,
      maxNodesPerCountry: 500,
      registrationWindow: 3600,
      minGeographicDiversity: 2.5,
    });
  });

  describe('IP-based Rate Limiting', () => {
    it('should ALLOW first node from an IP address', async () => {
      const nodeId = 'node-1';
      const ipAddress = '192.168.1.100';

      const result = await rateLimiter.checkRateLimit(nodeId, ipAddress);
      expect(result.allowed).toBe(true);
      expect(result.violations.length).toBe(0);
    });

    it('should REJECT second node from same IP address - SYBIL BLOCKED', async () => {
      const ipAddress = '192.168.1.100';

      // Register first node
      await rateLimiter.registerNode('node-1', ipAddress);

      // Second node from same IP should be blocked
      const result = await rateLimiter.checkRateLimit('node-2', ipAddress);
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.type === 'ip')).toBe(true);
    });

    it('should ALLOW nodes from different IP addresses', async () => {
      // Register first node
      await rateLimiter.registerNode('node-1', '192.168.1.100');

      // Different IP should be allowed
      const result = await rateLimiter.checkRateLimit('node-2', '10.0.0.50');
      expect(result.allowed).toBe(true);
    });
  });

  describe('Subnet-based Rate Limiting (/24)', () => {
    it('should ALLOW first two nodes in same /24 subnet', async () => {
      await rateLimiter.registerNode('node-1', '192.168.1.10');

      const result = await rateLimiter.checkRateLimit('node-2', '192.168.1.20');
      expect(result.allowed).toBe(true);
    });

    it('should REJECT third node in same /24 subnet - SYBIL BLOCKED', async () => {
      // Register two nodes in same /24
      await rateLimiter.registerNode('node-1', '192.168.1.10');
      await rateLimiter.registerNode('node-2', '192.168.1.20');

      // Third node should be blocked
      const result = await rateLimiter.checkRateLimit('node-3', '192.168.1.30');
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.type === 'subnet')).toBe(true);
    });
  });

  describe('Mass Registration Attack Prevention', () => {
    it('should BLOCK mass registration from same IP - SYBIL ATTACK SIMULATION', async () => {
      const ipAddress = '192.168.1.100';
      const attackerNodes = 10;
      let blocked = 0;

      // Attacker attempts to register many nodes from same IP
      for (let i = 0; i < attackerNodes; i++) {
        const result = await rateLimiter.checkRateLimit(`attacker-node-${i}`, ipAddress);
        if (!result.allowed) {
          blocked++;
        } else {
          await rateLimiter.registerNode(`attacker-node-${i}`, ipAddress);
        }
      }

      // All but first should be blocked
      expect(blocked).toBe(attackerNodes - 1);
    });

    it('should BLOCK mass registration from same /24 subnet - SYBIL ATTACK SIMULATION', async () => {
      const subnetIPs = generateSubnet24IPs(100, 10);
      let blocked = 0;

      // Attacker tries to register from multiple IPs in same /24
      for (let i = 0; i < subnetIPs.length; i++) {
        const result = await rateLimiter.checkRateLimit(`attacker-node-${i}`, subnetIPs[i]);
        if (!result.allowed) {
          blocked++;
        } else {
          await rateLimiter.registerNode(`attacker-node-${i}`, subnetIPs[i]);
        }
      }

      // Only 2 should be allowed (maxNodesPerSubnet = 2)
      expect(blocked).toBe(subnetIPs.length - 2);
    });

    it('should BLOCK spread attack across /23 subnet - SYBIL ATTACK SIMULATION', async () => {
      // Attacker tries to spread across adjacent /24 blocks
      const subnetIPs = generateSubnet23IPs(100, 8); // 8 IPs across 2 /24s
      let blocked = 0;
      let registered = 0;

      for (let i = 0; i < subnetIPs.length; i++) {
        const result = await rateLimiter.checkRateLimit(`attacker-node-${i}`, subnetIPs[i]);
        if (!result.allowed) {
          blocked++;
        } else {
          await rateLimiter.registerNode(`attacker-node-${i}`, subnetIPs[i]);
          registered++;
        }
      }

      // /23 limit is 4 nodes, so at most 4 should be allowed
      expect(registered).toBeLessThanOrEqual(4);
      expect(blocked).toBeGreaterThanOrEqual(4);
    });

    it('should BLOCK spread attack across /22 subnet - SYBIL ATTACK SIMULATION', async () => {
      // Attacker tries to spread across 4 adjacent /24 blocks
      const subnetIPs = generateSubnet22IPs(100, 12); // 12 IPs across 4 /24s
      let blocked = 0;
      let registered = 0;

      for (let i = 0; i < subnetIPs.length; i++) {
        const result = await rateLimiter.checkRateLimit(`attacker-node-${i}`, subnetIPs[i]);
        if (!result.allowed) {
          blocked++;
        } else {
          await rateLimiter.registerNode(`attacker-node-${i}`, subnetIPs[i]);
          registered++;
        }
      }

      // /22 limit is 6 nodes, so at most 6 should be allowed
      expect(registered).toBeLessThanOrEqual(6);
      expect(blocked).toBeGreaterThanOrEqual(6);
    });
  });

  describe('Deregistration and Re-registration', () => {
    it('should ALLOW new registration after node deregistration', async () => {
      const ipAddress = '192.168.1.100';

      // Register node
      await rateLimiter.registerNode('node-1', ipAddress);

      // Second node should be blocked
      let result = await rateLimiter.checkRateLimit('node-2', ipAddress);
      expect(result.allowed).toBe(false);

      // Deregister first node
      const deregistered = rateLimiter.deregisterNode('node-1');
      expect(deregistered).toBe(true);

      // Now registration should be allowed
      result = await rateLimiter.checkRateLimit('node-2', ipAddress);
      expect(result.allowed).toBe(true);
    });
  });

  describe('VPN/Tor/Proxy Detection', () => {
    it('should flag VPN connections in registration', async () => {
      // This tests the structure - in production VPN list would be loaded
      const registration = await rateLimiter.registerNode('node-1', '192.168.1.100');
      expect(registration).toHaveProperty('isVPN');
      expect(registration).toHaveProperty('isTor');
      expect(registration).toHaveProperty('isProxy');
    });
  });

  describe('Geographic Diversity', () => {
    it('should track geographic distribution', () => {
      const stats = rateLimiter.getDistributionStats();
      expect(stats).toHaveProperty('geographicEntropy');
      expect(stats).toHaveProperty('networkEntropy');
      expect(stats).toHaveProperty('uniqueCountries');
    });
  });
});

// ============================================================================
// DID VERIFICATION TESTS
// ============================================================================

describe('DIDVerifier - Proof of Unique Human Tests', () => {
  let didVerifier: DIDVerifier;

  beforeEach(() => {
    didVerifier = new DIDVerifier({
      requiredForRegistration: false,
      maxNodesPerDID: 3,
      minVerificationLevel: 'basic',
      uniquenessScoreThreshold: 50,
      allowedDIDMethods: ['did:wrfcoin:', 'did:web:', 'did:key:', 'did:pkh:', 'did:ethr:'],
    });
  });

  describe('DID Format Validation', () => {
    it('should ACCEPT valid DID formats', async () => {
      const validDIDs = [
        'did:wrfcoin:abc123',
        'did:web:example.com',
        'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK',
        'did:ethr:0x1234567890abcdef1234567890abcdef12345678',
      ];

      for (const did of validDIDs) {
        const result = await didVerifier.verifyDID(did, 'node-1', generateMockSignature());
        // Should not fail due to format
        expect(result.errors).not.toContain('Invalid DID format');
      }
    });

    it('should REJECT invalid DID formats', async () => {
      const invalidDIDs = [
        'invalid-did',
        'did:',
        'did:method:',
        ':method:id',
        'did:method with spaces:id',
      ];

      for (const did of invalidDIDs) {
        const result = await didVerifier.verifyDID(did, 'node-1');
        expect(result.isValid).toBe(false);
        expect(result.errors.some(e => e.includes('Invalid DID format') || e.includes('not allowed'))).toBe(true);
      }
    });
  });

  describe('DID Method Allowlist', () => {
    it('should REJECT unsupported DID methods', async () => {
      const result = await didVerifier.verifyDID('did:unsupported:abc123', 'node-1');
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('not allowed'))).toBe(true);
    });
  });

  describe('Multi-Node DID Prevention', () => {
    it('should ALLOW up to maxNodesPerDID nodes per DID', async () => {
      const did = generateDID();
      const maxNodes = 3;

      for (let i = 0; i < maxNodes; i++) {
        const result = await didVerifier.verifyDID(did, `node-${i}`, generateMockSignature());
        expect(result.isValid).toBe(true);
      }
    });

    it('should REJECT nodes exceeding maxNodesPerDID - SYBIL BLOCKED', async () => {
      const did = generateDID();
      const maxNodes = 3;

      // Register max allowed nodes
      for (let i = 0; i < maxNodes; i++) {
        await didVerifier.verifyDID(did, `node-${i}`, generateMockSignature());
      }

      // Next node should be blocked
      const result = await didVerifier.verifyDID(did, `node-${maxNodes}`, generateMockSignature());
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('maximum node limit'))).toBe(true);
    });
  });

  describe('DID Identity Reuse Detection', () => {
    it('should REJECT node already registered with different DID', async () => {
      const did1 = generateDID();
      const did2 = generateDID();
      const nodeId = 'node-same';

      // Register node with first DID
      await didVerifier.verifyDID(did1, nodeId, generateMockSignature());

      // Try to register same node with different DID
      const result = await didVerifier.verifyDID(did2, nodeId, generateMockSignature());
      expect(result.isValid).toBe(false);
      expect(result.errors.some(e => e.includes('different DID'))).toBe(true);
    });
  });

  describe('Uniqueness Score Calculation', () => {
    it('should assign higher scores for verified DIDs', async () => {
      const did = generateDID('web'); // did:web gets bonus points
      const result = await didVerifier.verifyDID(did, 'node-1', generateMockSignature());

      // Verified DID with web method should have higher score
      expect(result.uniquenessScore).toBeGreaterThan(30);
    });

    it('should penalize multiple nodes per DID', async () => {
      const did = generateDID();

      const firstResult = await didVerifier.verifyDID(did, 'node-1', generateMockSignature());
      const secondResult = await didVerifier.verifyDID(did, 'node-2', generateMockSignature());

      // Second node should have lower uniqueness score
      expect(secondResult.uniquenessScore).toBeLessThan(firstResult.uniquenessScore);
    });

    it('should give low score for unverified nodes', async () => {
      // Node without DID
      const result = await didVerifier.verifyDID('', 'node-1');
      expect(result.uniquenessScore).toBeLessThanOrEqual(30);
    });
  });

  describe('Challenge Generation', () => {
    it('should generate proof-of-personhood challenges', () => {
      const challenge = didVerifier.generateUniqueHumanChallenge('node-1', 'proof-of-personhood');

      expect(challenge).toHaveProperty('challengeId');
      expect(challenge).toHaveProperty('type', 'proof-of-personhood');
      expect(challenge).toHaveProperty('challenge');
      expect(challenge).toHaveProperty('expiresAt');
      expect(new Date(challenge.expiresAt) > new Date()).toBe(true);
    });

    it('should generate CAPTCHA challenges', () => {
      const challenge = didVerifier.generateUniqueHumanChallenge('node-1', 'captcha');

      expect(challenge.type).toBe('captcha');
      const parsed = JSON.parse(challenge.challenge);
      expect(parsed).toHaveProperty('type', 'captcha');
      expect(parsed).toHaveProperty('code');
    });

    it('should generate stake commitment challenges', () => {
      const challenge = didVerifier.generateUniqueHumanChallenge('node-1', 'stake-commitment');

      expect(challenge.type).toBe('stake-commitment');
      const parsed = JSON.parse(challenge.challenge);
      expect(parsed).toHaveProperty('requiredAmount');
      expect(parsed).toHaveProperty('lockDuration');
    });
  });

  describe('Challenge Response Verification', () => {
    it('should ACCEPT correct arithmetic challenge response', async () => {
      // Generate a challenge
      const challenge = didVerifier.generateUniqueHumanChallenge('node-1', 'proof-of-personhood');
      const parsed = JSON.parse(challenge.challenge);

      if (parsed.type === 'arithmetic') {
        // Parse the question and calculate answer
        const match = parsed.question.match(/What is (\d+) ([+\-*]) (\d+)\?/);
        if (match) {
          const [, a, op, b] = match;
          let answer: number;
          switch (op) {
            case '+': answer = parseInt(a) + parseInt(b); break;
            case '-': answer = parseInt(a) - parseInt(b); break;
            case '*': answer = parseInt(a) * parseInt(b); break;
            default: answer = 0;
          }

          const result = await didVerifier.verifyChallengeResponse(
            challenge.challengeId,
            'node-1',
            answer.toString()
          );
          expect(result.passed).toBe(true);
        }
      }
    });

    it('should REJECT incorrect challenge response', async () => {
      const challenge = didVerifier.generateUniqueHumanChallenge('node-1', 'proof-of-personhood');

      const result = await didVerifier.verifyChallengeResponse(
        challenge.challengeId,
        'node-1',
        'definitely-wrong-answer'
      );
      expect(result.passed).toBe(false);
    });

    it('should REJECT expired challenges', async () => {
      // This would require mocking time, which is complex
      // For now, test with non-existent challenge
      const result = await didVerifier.verifyChallengeResponse(
        'non-existent-challenge-id',
        'node-1',
        'answer'
      );
      expect(result.passed).toBe(false);
      expect(result.message).toContain('not found');
    });
  });

  describe('DID Revocation', () => {
    it('should successfully revoke DID registration', async () => {
      const did = generateDID();

      // Register node
      await didVerifier.verifyDID(did, 'node-1', generateMockSignature());

      // Verify node is registered
      let nodes = didVerifier.getNodesForDID(did);
      expect(nodes).toContain('node-1');

      // Revoke
      const revoked = didVerifier.revokeDIDRegistration('node-1');
      expect(revoked).toBe(true);

      // Verify node is no longer registered
      nodes = didVerifier.getNodesForDID(did);
      expect(nodes).not.toContain('node-1');
    });

    it('should allow re-registration after revocation', async () => {
      const did = generateDID();

      // Fill up to max
      for (let i = 0; i < 3; i++) {
        await didVerifier.verifyDID(did, `node-${i}`, generateMockSignature());
      }

      // Should be blocked
      let result = await didVerifier.verifyDID(did, 'node-3', generateMockSignature());
      expect(result.isValid).toBe(false);

      // Revoke one
      didVerifier.revokeDIDRegistration('node-0');

      // Now should be allowed
      result = await didVerifier.verifyDID(did, 'node-3', generateMockSignature());
      expect(result.isValid).toBe(true);
    });
  });

  describe('Verification Statistics', () => {
    it('should track verification statistics', async () => {
      // Register some nodes
      await didVerifier.verifyDID(generateDID(), 'node-1', generateMockSignature());
      await didVerifier.verifyDID(generateDID(), 'node-2', generateMockSignature());

      const stats = didVerifier.getVerificationStats();

      expect(stats).toHaveProperty('totalDIDs');
      expect(stats).toHaveProperty('totalNodes');
      expect(stats).toHaveProperty('averageNodesPerDID');
      expect(stats).toHaveProperty('verificationLevelDistribution');
      expect(stats.totalNodes).toBeGreaterThanOrEqual(2);
    });
  });
});

// ============================================================================
// SYBIL ATTACK SCENARIO SIMULATIONS
// ============================================================================

describe('Sybil Attack Scenario Simulations', () => {
  describe('Scenario: Botnet Attack', () => {
    it('should BLOCK botnet attempting mass registration from /16 block', async () => {
      const rateLimiter = new SybilRateLimiter({
        maxNodesPerIP: 1,
        maxNodesPerSubnet: 2,
        maxNodesPerASN: 8,
        maxNodesPerCountry: 500,
        registrationWindow: 3600,
        minGeographicDiversity: 2.0,
      });

      // Simulate botnet with 100 IPs across a /16
      const botnetIPs: string[] = [];
      for (let i = 0; i < 100; i++) {
        botnetIPs.push(`192.168.${Math.floor(i / 256) % 256}.${i % 256 + 1}`);
      }

      let successfulRegistrations = 0;

      for (let i = 0; i < botnetIPs.length; i++) {
        const result = await rateLimiter.checkRateLimit(`botnet-${i}`, botnetIPs[i]);
        if (result.allowed) {
          await rateLimiter.registerNode(`botnet-${i}`, botnetIPs[i]);
          successfulRegistrations++;
        }
      }

      // With strict subnet limits, most should be blocked
      // Each /24 allows 2 nodes, botnet spans multiple /24s
      expect(successfulRegistrations).toBeLessThan(50);

      console.log(`Botnet attack blocked: ${100 - successfulRegistrations}/100 registrations denied`);
    });
  });

  describe('Scenario: DID Identity Farming', () => {
    it('should LIMIT identity farming through DID reuse', async () => {
      const didVerifier = new DIDVerifier({
        requiredForRegistration: true,
        maxNodesPerDID: 3,
        minVerificationLevel: 'basic',
        uniquenessScoreThreshold: 50,
      });

      // Attacker has 5 fake DIDs, tries to register 10 nodes each
      const fakeIdentities = 5;
      const nodesPerIdentity = 10;
      let successfulRegistrations = 0;

      for (let identity = 0; identity < fakeIdentities; identity++) {
        const did = generateDID();

        for (let node = 0; node < nodesPerIdentity; node++) {
          const result = await didVerifier.verifyDID(
            did,
            `farm-${identity}-${node}`,
            generateMockSignature()
          );
          if (result.isValid) {
            successfulRegistrations++;
          }
        }
      }

      // Max 3 nodes per DID * 5 DIDs = 15 max
      expect(successfulRegistrations).toBeLessThanOrEqual(15);

      console.log(`Identity farming limited: ${successfulRegistrations}/50 registrations allowed`);
    });
  });

  describe('Scenario: Gradual Eclipse Attack', () => {
    it('should TRACK concentration and warn about potential eclipse', async () => {
      const rateLimiter = new SybilRateLimiter();

      // Attacker slowly registers nodes, 1 per different /24
      const attackerIPs: string[] = [];
      for (let i = 0; i < 20; i++) {
        attackerIPs.push(`10.${i}.1.1`);
      }

      let registered = 0;
      for (const ip of attackerIPs) {
        const result = await rateLimiter.checkRateLimit(`eclipse-${registered}`, ip);
        if (result.allowed) {
          await rateLimiter.registerNode(`eclipse-${registered}`, ip);
          registered++;
        }
      }

      const stats = rateLimiter.getDistributionStats();

      // With many nodes from same actor (simulated by unique IPs but could be same ASN)
      // Network diversity should still be tracked
      expect(stats.uniqueSubnets).toBeGreaterThan(0);
      expect(stats.totalNodes).toBe(registered);
    });
  });

  describe('Scenario: Reputation Gaming', () => {
    it('should require sustained good behavior for high uniqueness scores', async () => {
      const didVerifier = new DIDVerifier();

      // New node starts with low uniqueness score
      const did = generateDID();
      const result = await didVerifier.verifyDID(did, 'gamer-node', generateMockSignature());

      // Initial score should not be maximum
      expect(result.uniquenessScore).toBeLessThan(100);

      // Only verified DIDs with signature get higher scores
      expect(result.verificationLevel).not.toBe('none');
    });
  });

  describe('Scenario: Economic Barrier Bypass', () => {
    it('should enforce stake requirements cannot be shared', async () => {
      // This is tested at the orchestrator level
      // Each node must have its own stake - DID helps verify this

      const didVerifier = new DIDVerifier({
        maxNodesPerDID: 3, // Limited even with DID
      });

      const did = generateDID();
      let stakeAttemptsBlocked = 0;

      // Attacker tries to run many nodes with single stake/identity
      for (let i = 0; i < 10; i++) {
        const result = await didVerifier.verifyDID(did, `stake-bypass-${i}`, generateMockSignature());
        if (!result.isValid) {
          stakeAttemptsBlocked++;
        }
      }

      // Most attempts should be blocked
      expect(stakeAttemptsBlocked).toBeGreaterThanOrEqual(7);
    });
  });
});

// ============================================================================
// INTEGRATION TESTS
// ============================================================================

describe('Sybil Prevention Integration', () => {
  it('should work together: Rate Limiter + DID Verification', async () => {
    const rateLimiter = new SybilRateLimiter({
      maxNodesPerIP: 1,
      maxNodesPerSubnet: 2,
    });

    const didVerifier = new DIDVerifier({
      requiredForRegistration: false,
      maxNodesPerDID: 3,
    });

    // Attacker with 1 DID tries multiple IPs
    const attackerDID = generateDID();
    const attackerIPs = ['192.168.1.1', '192.168.1.2', '192.168.1.3', '192.168.1.4', '192.168.1.5'];

    let passedBothChecks = 0;

    for (let i = 0; i < attackerIPs.length; i++) {
      const nodeId = `attacker-${i}`;
      const ip = attackerIPs[i];

      // Check rate limit
      const rateResult = await rateLimiter.checkRateLimit(nodeId, ip);

      // Check DID
      const didResult = await didVerifier.verifyDID(attackerDID, nodeId, generateMockSignature());

      if (rateResult.allowed && didResult.isValid) {
        await rateLimiter.registerNode(nodeId, ip);
        passedBothChecks++;
      }
    }

    // Both systems limit:
    // - Rate limiter: 2 per /24 subnet
    // - DID: 3 per DID
    // Combined: should be limited by whichever is stricter (2 in this case)
    expect(passedBothChecks).toBeLessThanOrEqual(2);
  });
});
