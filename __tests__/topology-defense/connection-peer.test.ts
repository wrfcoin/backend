/**
 * Topology Attack Defense - Connection and Peer Tests
 * Tests for connection acceptance, peer registration, and dynamic restructuring
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, it } from '@jest/globals';
import {
  TopologyAttackDefense,
  PeerMetadata,
} from '../../shared/topology-attack-defense.js';
import { createTestDefense, standardCleanup, delay } from './setup.js';

describe('TopologyAttackDefense - Connection and Peer Management', () => {
  let defense: TopologyAttackDefense;

  beforeEach(() => {
    defense = createTestDefense();
  });

  afterEach(async () => {
    await standardCleanup(defense);
  });

  afterAll(async () => {
    await delay(100);
  });

  describe('Connection Acceptance', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should accept connections from new IPs', () => {
      const result = defense.shouldAcceptConnection('192.168.1.10:8080');
      expect(result.accept).toBe(true);
    });

    it('should reject connections from banned IPs', () => {
      defense.banIP('192.168.1.10', 'Test ban');

      const result = defense.shouldAcceptConnection('192.168.1.10:8080');
      expect(result.accept).toBe(false);
      expect(result.reason).toContain('banned');
    });

    it('should enforce subnet limits', () => {
      // Register max peers from same subnet
      defense.registerPeer('peer_1', '192.168.1.10:8080');
      defense.registerPeer('peer_2', '192.168.1.11:8080');

      // Third connection from same subnet should be rejected
      const result = defense.shouldAcceptConnection('192.168.1.12:8080');
      expect(result.accept).toBe(false);
      expect(result.reason).toContain('Subnet limit');
    });

    it('should allow connections from different subnets', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080');
      defense.registerPeer('peer_2', '192.168.1.11:8080');

      // Different subnet should be accepted
      const result = defense.shouldAcceptConnection('192.168.2.10:8080');
      expect(result.accept).toBe(true);
    });

    it('should rate limit connections', () => {
      // Simulate rapid connection attempts
      for (let i = 0; i < 10; i++) {
        defense.shouldAcceptConnection('10.0.0.1:8080');
      }

      // Should be rate limited
      const result = defense.shouldAcceptConnection('10.0.0.1:8080');
      expect(result.accept).toBe(false);
      expect(result.reason).toContain('rate limit');
    });
  });

  describe('Peer Registration', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should register new peers', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080', {
        region: 'us-east',
        asn: 'AS12345',
      });

      const metrics = defense.getMetrics();
      expect(metrics.activePeers).toBe(1);
      expect(metrics.uniqueRegions).toBe(1);
      expect(metrics.uniqueASNs).toBe(1);
    });

    it('should unregister peers', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080');
      defense.unregisterPeer('peer_1');

      const metrics = defense.getMetrics();
      expect(metrics.activePeers).toBe(0);
    });

    it('should update peer metadata', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080');
      defense.updatePeer('peer_1', { latency: 100 });

      const status = defense.getStatus();
      const peer = status.topTrustedPeers.find(p => p.peerId === 'peer_1');
      expect(peer?.latency).toBe(100);
    });

    it('should emit peer_registered event', (done) => {
      defense.on('peer_registered', (peer: PeerMetadata) => {
        expect(peer.peerId).toBe('peer_1');
        done();
      });

      defense.registerPeer('peer_1', '192.168.1.10:8080');
    });
  });

  describe('Dynamic Restructuring (Churn)', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should not churn with few peers', () => {
      // Register only 3 peers (below threshold of 5)
      for (let i = 0; i < 3; i++) {
        defense.registerPeer(`peer_${i}`, `192.168.${i}.1:8080`);
      }

      const result = defense.performChurn();
      expect(result.peersRemoved.length).toBe(0);
      expect(result.reason).toContain('Insufficient');
    });

    it('should churn low-trust peers', () => {
      // Register 10 peers with varying trust scores
      for (let i = 0; i < 10; i++) {
        defense.registerPeer(`peer_${i}`, `192.168.${i}.1:8080`);
        // Set different trust scores
        for (let j = 0; j < i; j++) {
          defense.increaseTrust(`peer_${i}`, 0.05);
        }
      }

      const result = defense.performChurn();

      // Should remove 20% = 2 peers (lowest trust)
      expect(result.peersRemoved.length).toBe(2);
      expect(result.peersRemoved).toContain('peer_0');
      expect(result.peersRemoved).toContain('peer_1');
    });

    it('should get peers recommended for churn based on trust', () => {
      // Register peers with varying trust scores
      for (let i = 0; i < 10; i++) {
        defense.registerPeer(`peer_${i}`, `192.168.${i}.1:8080`);
        // Set different trust scores (higher index = higher trust)
        for (let j = 0; j < i; j++) {
          defense.increaseTrust(`peer_${i}`, 0.05);
        }
      }

      // Perform churn which returns lowest trust peers
      const result = defense.performChurn();
      expect(result.peersRemoved.length).toBe(2); // 20% of 10
    });

    it('should emit churn_performed event', (done) => {
      for (let i = 0; i < 10; i++) {
        defense.registerPeer(`peer_${i}`, `192.168.${i}.1:8080`);
      }

      defense.on('churn_performed', (result) => {
        expect(result.peersRemoved.length).toBeGreaterThan(0);
        done();
      });

      defense.performChurn();
    });
  });
});
