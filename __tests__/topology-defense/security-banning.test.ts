/**
 * Topology Attack Defense - Security and Banning Tests
 * Tests for suspicious activity, IP banning, crawling detection, and events
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, it } from '@jest/globals';
import {
  TopologyAttackDefense,
  TopologyAlertType,
} from '../../shared/topology-attack-defense.js';
import { createTestDefense, standardCleanup, delay } from './setup.js';

describe('TopologyAttackDefense - Security and Banning', () => {
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

  describe('Suspicious Activity Detection', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should decrease trust on suspicious report', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080');

      const initialTrust = defense.getPeersByTrust()[0]?.trustScore || 0;
      defense.reportSuspicious('peer_1', 3, 'Test suspicious activity');

      const afterTrust = defense.getPeersByTrust()[0]?.trustScore || 0;
      expect(afterTrust).toBeLessThan(initialTrust);
    });

    it('should ban IP after threshold exceeded', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080');

      // Report enough suspicious activity to exceed threshold
      defense.reportSuspicious('peer_1', 6, 'Severe violation');

      expect(defense.isIPBanned('192.168.1.10')).toBe(true);
    });

    it('should emit suspicious_activity event', (done) => {
      defense.registerPeer('peer_1', '192.168.1.10:8080');

      defense.on('suspicious_activity', (data) => {
        expect(data.peerId).toBe('peer_1');
        expect(data.severity).toBe(2);
        done();
      });

      defense.reportSuspicious('peer_1', 2, 'Test');
    });
  });

  describe('IP Banning', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should ban IP addresses', () => {
      defense.banIP('192.168.1.10', 'Test ban');
      expect(defense.isIPBanned('192.168.1.10')).toBe(true);
    });

    it('should unban IP addresses', () => {
      defense.banIP('192.168.1.10', 'Test ban');
      defense.unbanIP('192.168.1.10');
      expect(defense.isIPBanned('192.168.1.10')).toBe(false);
    });

    it('should increase ban duration for repeat offenders when re-banned before unban', () => {
      // Ban an IP - first violation
      defense.banIP('192.168.1.10', 'First offense');
      const firstBan = defense.getBannedIPs()[0];
      expect(firstBan.violationCount).toBe(1);

      // Ban again without unbanning - violation count should increase
      defense.banIP('192.168.1.10', 'Second offense');
      const secondBan = defense.getBannedIPs()[0];
      expect(secondBan.violationCount).toBe(2);

      // Duration should be longer (multiplied by violation count)
      const firstDuration = firstBan.expiresAt.getTime() - firstBan.bannedAt.getTime();
      const secondDuration = secondBan.expiresAt.getTime() - secondBan.bannedAt.getTime();
      expect(secondDuration).toBeGreaterThan(firstDuration);
    });

    it('should auto-expire bans', async () => {
      // Use shorter ban duration for test
      const shortBanDefense = new TopologyAttackDefense({
        banDuration: 100, // 100ms
      });
      shortBanDefense.start();

      shortBanDefense.banIP('192.168.1.10', 'Short ban');
      expect(shortBanDefense.isIPBanned('192.168.1.10')).toBe(true);

      await new Promise(resolve => setTimeout(resolve, 150));

      expect(shortBanDefense.isIPBanned('192.168.1.10')).toBe(false);

      shortBanDefense.stop();
      shortBanDefense.removeAllListeners();
    });

    it('should emit ip_banned event', (done) => {
      defense.on('ip_banned', (record) => {
        expect(record.ip).toBe('192.168.1.10');
        expect(record.reason).toBe('Test ban');
        done();
      });

      defense.banIP('192.168.1.10', 'Test ban');
    });
  });

  describe('Topology Crawling Detection', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should rate limit rapid connection attempts', () => {
      const ip = '10.0.0.1';

      // First few attempts should be accepted
      const result1 = defense.shouldAcceptConnection(`${ip}:8080`);
      expect(result1.accept).toBe(true);

      // Simulate more rapid connection attempts
      for (let i = 1; i < 10; i++) {
        defense.shouldAcceptConnection(`${ip}:8080`);
      }

      // Connection should now be rate limited
      const result2 = defense.shouldAcceptConnection(`${ip}:8080`);
      expect(result2.accept).toBe(false);
      expect(result2.reason).toContain('rate limit');
    });

    it('should reject rate-limited connections', () => {
      const ip = '10.0.0.2';

      // Make enough connections to hit rate limit
      for (let i = 0; i < 6; i++) {
        defense.shouldAcceptConnection(`${ip}:8080`);
      }

      // Subsequent connection should be rejected
      const result = defense.shouldAcceptConnection(`${ip}:8080`);
      expect(result.accept).toBe(false);
    });
  });

  describe('Event Emission', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should emit started event', (done) => {
      const newDefense = new TopologyAttackDefense();
      newDefense.on('started', () => {
        newDefense.stop();
        newDefense.removeAllListeners();
        done();
      });
      newDefense.start();
    });

    it('should emit stopped event', (done) => {
      defense.on('stopped', () => {
        done();
      });
      defense.stop();
    });

    it('should emit alert events', (done) => {
      let alertReceived = false;
      defense.on('alert', (alert) => {
        if (!alertReceived) {
          alertReceived = true;
          expect(alert.alertId).toBeDefined();
          expect(alert.type).toBeDefined();
          done();
        }
      });

      defense.registerPeer('peer_1', '192.168.1.10:8080');
    });
  });
});
