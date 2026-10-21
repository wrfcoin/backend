/**
 * Topology Attack Defense - Integration Tests
 * Tests for metrics, status, and full integration scenarios
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, it } from '@jest/globals';
import { TopologyAttackDefense } from '../../shared/topology-attack-defense.js';
import { createTestDefense, standardCleanup, delay } from './setup.js';

describe('TopologyAttackDefense - Integration', () => {
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

  describe('Metrics and Status', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should return accurate metrics', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080', { region: 'us-east', asn: 'AS1' });
      defense.registerPeer('peer_2', '192.168.2.10:8080', { region: 'us-west', asn: 'AS2' });
      defense.banIP('10.0.0.1', 'Test');

      const metrics = defense.getMetrics();

      expect(metrics.totalPeers).toBe(2);
      expect(metrics.activePeers).toBe(2);
      expect(metrics.decoyPeers).toBe(5);
      expect(metrics.bannedIPs).toBe(1);
      expect(metrics.uniqueSubnets).toBe(2);
      expect(metrics.uniqueRegions).toBe(2);
      expect(metrics.uniqueASNs).toBe(2);
      expect(metrics.averageTrustScore).toBeCloseTo(0.5);
    });

    it('should calculate health score', () => {
      // Register diverse peers
      defense.registerPeer('peer_1', '192.168.1.10:8080', { region: 'us-east', asn: 'AS1' });
      defense.registerPeer('peer_2', '192.168.2.10:8080', { region: 'us-west', asn: 'AS2' });
      defense.registerPeer('peer_3', '192.168.3.10:8080', { region: 'eu-west', asn: 'AS3' });

      const metrics = defense.getMetrics();

      // Should have high health score with good diversity
      expect(metrics.healthScore).toBeGreaterThan(80);
    });

    it('should return detailed status', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080');
      defense.banIP('10.0.0.1', 'Test');

      const status = defense.getStatus();

      expect(status.config).toBeDefined();
      expect(status.metrics).toBeDefined();
      expect(status.recentAlerts).toBeDefined();
      expect(status.topTrustedPeers).toBeDefined();
      expect(status.bannedIPs).toBeDefined();
    });

    it('should return recent alerts', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080');

      const alerts = defense.getAlerts();
      expect(Array.isArray(alerts)).toBe(true);
    });

    it('should filter alerts by date', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080');

      const future = new Date(Date.now() + 10000);
      const alerts = defense.getAlerts(future);
      expect(alerts.length).toBe(0);
    });
  });

  describe('Integration Scenarios', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should handle complete attack scenario', async () => {
      // 1. Attacker starts probing from multiple IPs in same subnet
      defense.shouldAcceptConnection('192.168.1.10:8080');
      defense.registerPeer('attacker_1', '192.168.1.10:8080');

      defense.shouldAcceptConnection('192.168.1.11:8080');
      defense.registerPeer('attacker_2', '192.168.1.11:8080');

      // 2. Third connection from same subnet should be blocked
      const blocked = defense.shouldAcceptConnection('192.168.1.12:8080');
      expect(blocked.accept).toBe(false);

      // 3. Attacker tries rapid connections from a different IP
      // After rate limit is hit, connections are rejected
      for (let i = 0; i < 10; i++) {
        defense.shouldAcceptConnection('10.0.0.1:8080');
      }
      // Connection should be rate limited now
      const rateLimited = defense.shouldAcceptConnection('10.0.0.1:8080');
      expect(rateLimited.accept).toBe(false);
      expect(rateLimited.reason).toContain('rate limit');

      // 4. Suspicious activity from registered peer decreases trust
      const initialTrust = defense.getPeersByTrust().find(p => p.peerId === 'attacker_1')?.trustScore || 0;
      defense.reportSuspicious('attacker_1', 3, 'Suspicious behavior');
      defense.reportSuspicious('attacker_1', 3, 'More suspicious behavior');

      // 5. Peer should have lower trust than before
      const afterTrust = defense.getPeersByTrust().find(p => p.peerId === 'attacker_1')?.trustScore || 0;
      expect(afterTrust).toBeLessThan(initialTrust);
    });

    it('should maintain healthy network with diverse peers', () => {
      // Register diverse legitimate peers
      const regions = ['us-east', 'us-west', 'eu-west', 'asia-east'];
      const asns = ['AS1', 'AS2', 'AS3', 'AS4'];

      for (let i = 0; i < 10; i++) {
        defense.registerPeer(
          `peer_${i}`,
          `192.168.${i}.1:8080`,
          {
            region: regions[i % regions.length],
            asn: asns[i % asns.length],
          }
        );
        // Simulate good behavior
        defense.increaseTrust(`peer_${i}`, 0.1);
      }

      const metrics = defense.getMetrics();

      expect(metrics.activePeers).toBe(10);
      expect(metrics.uniqueSubnets).toBe(10);
      expect(metrics.uniqueRegions).toBe(4);
      expect(metrics.uniqueASNs).toBe(4);
      expect(metrics.healthScore).toBe(100);
      expect(metrics.averageTrustScore).toBeGreaterThan(0.5);
    });

    it('should handle churn correctly over time', async () => {
      // Register peers with varying trust - lower index gets LOWER trust
      for (let i = 0; i < 10; i++) {
        defense.registerPeer(`peer_${i}`, `192.168.${i}.1:8080`);
      }

      // Set trust scores: peer_0 and peer_1 get NO increases (lowest trust)
      // peer_2 through peer_9 get increasing trust
      for (let i = 2; i < 10; i++) {
        for (let j = 0; j < i; j++) {
          defense.increaseTrust(`peer_${i}`, 0.05);
        }
      }

      // Perform churn (removes 20% = 2 lowest trust peers)
      const result = defense.performChurn();

      // Should have removed 2 peers (20% of 10)
      expect(result.peersRemoved.length).toBe(2);

      // High trust peers should remain
      const remainingPeers = defense.getMetrics().activePeers;
      expect(remainingPeers).toBe(8);
    });
  });
});
