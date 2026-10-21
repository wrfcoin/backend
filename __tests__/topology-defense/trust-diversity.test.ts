/**
 * Topology Attack Defense - Trust and Diversity Tests
 * Tests for trust score management, diversity requirements, and cleanup
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, it } from '@jest/globals';
import {
  TopologyAttackDefense,
  TopologyAlertType,
} from '../../shared/topology-attack-defense.js';
import { createTestDefense, standardCleanup, delay } from './setup.js';

describe('TopologyAttackDefense - Trust and Diversity', () => {
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

  describe('Trust Score Management', () => {
    beforeEach(() => {
      defense.start();
      defense.registerPeer('peer_1', '192.168.1.10:8080');
    });

    it('should increase trust score', () => {
      const initial = defense.getPeersByTrust()[0]?.trustScore || 0;
      defense.increaseTrust('peer_1', 0.1);
      const after = defense.getPeersByTrust()[0]?.trustScore || 0;

      expect(after).toBeCloseTo(initial + 0.1);
    });

    it('should decrease trust score', () => {
      const initial = defense.getPeersByTrust()[0]?.trustScore || 0;
      defense.decreaseTrust('peer_1', 0.1);
      const after = defense.getPeersByTrust()[0]?.trustScore || 0;

      expect(after).toBeCloseTo(initial - 0.1);
    });

    it('should cap trust score at 1.0', () => {
      for (let i = 0; i < 20; i++) {
        defense.increaseTrust('peer_1', 0.1);
      }

      const trust = defense.getPeersByTrust()[0]?.trustScore || 0;
      expect(trust).toBe(1.0);
    });

    it('should floor trust score at 0', () => {
      for (let i = 0; i < 20; i++) {
        defense.decreaseTrust('peer_1', 0.1);
      }

      const trust = defense.getPeersByTrust()[0]?.trustScore || 0;
      expect(trust).toBe(0);
    });

    it('should sort peers by trust score', () => {
      defense.registerPeer('peer_2', '192.168.2.10:8080');
      defense.registerPeer('peer_3', '192.168.3.10:8080');

      defense.increaseTrust('peer_3', 0.3);
      defense.increaseTrust('peer_2', 0.1);

      const sortedPeers = defense.getPeersByTrust();
      expect(sortedPeers[0].peerId).toBe('peer_3');
      expect(sortedPeers[2].peerId).toBe('peer_1');
    });
  });

  describe('Diversity Requirements', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should create alert for low geographic diversity', (done) => {
      defense.on('alert', (alert) => {
        if (alert.type === TopologyAlertType.GEOGRAPHIC_ISOLATION) {
          expect(alert.severity).toBe('medium');
          done();
        }
      });

      // Register peer without meeting geographic requirements
      defense.registerPeer('peer_1', '192.168.1.10:8080', { region: 'us-east' });
    });

    it('should create alert for subnet concentration', (done) => {
      const strictDefense = new TopologyAttackDefense({
        maxPeersPerSubnet: 1,
      });
      strictDefense.start();

      strictDefense.on('alert', (alert) => {
        if (alert.type === TopologyAlertType.SUBNET_CONCENTRATION) {
          expect(alert.severity).toBe('high');
          strictDefense.stop();
          strictDefense.removeAllListeners();
          done();
        }
      });

      // Force subnet concentration (bypass shouldAcceptConnection)
      strictDefense.registerPeer('peer_1', '192.168.1.10:8080');
      strictDefense.registerPeer('peer_2', '192.168.1.11:8080');
      strictDefense.checkDiversityRequirements();
    });

    it('should track unique regions', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080', { region: 'us-east' });
      defense.registerPeer('peer_2', '192.168.2.10:8080', { region: 'us-west' });
      defense.registerPeer('peer_3', '192.168.3.10:8080', { region: 'eu-west' });

      const metrics = defense.getMetrics();
      expect(metrics.uniqueRegions).toBe(3);
    });

    it('should track unique ASNs', () => {
      defense.registerPeer('peer_1', '192.168.1.10:8080', { asn: 'AS12345' });
      defense.registerPeer('peer_2', '192.168.2.10:8080', { asn: 'AS67890' });
      defense.registerPeer('peer_3', '192.168.3.10:8080', { asn: 'AS12345' }); // Duplicate

      const metrics = defense.getMetrics();
      expect(metrics.uniqueASNs).toBe(2);
    });
  });

  describe('Cleanup Operations', () => {
    // #1091 — this block used to bet on the machine. `banDuration: 50` plus
    // `getBannedIPs()`, which filters on `expiresAt > new Date()`, gave the
    // assertion on the line after `banIP()` a 50 ms real-time budget:
    //
    //     shortBanDefense.banIP('192.168.1.10', 'Short ban');
    //     expect(shortBanDefense.getBannedIPs().length).toBe(1);   // 0 under load
    //
    // Any scheduling delay over 50 ms between those two statements expired the
    // ban before it was read. Reproduced deterministically against the real
    // class: read immediately -> 1, read after a 60 ms busy-wait -> 0. It fired
    // on `main` at 8656ef1c in 1 of 5 full-gate runs, and never in isolation.
    //
    // Raising `banDuration` was rejected: it lowers the probability of the race
    // without removing it, still loses under heavy contention, and cannot reach
    // the 60 s cleanup tick at all. On a controlled clock the timing is the
    // subject rather than the hazard, and the block can finally assert the
    // behaviour it is named for.
    it('should clean up expired bans automatically', async () => {
      jest.useFakeTimers();
      // Constructed directly rather than via createTestDefense(): that helper
      // sets churnInterval to 1 s, and advancing to the 60 s cleanup tick would
      // then fire performChurn 60 times. The default 10 min churn interval
      // leaves cleanup as the only timer this test drives.
      const shortBanDefense = new TopologyAttackDefense({
        banDuration: 50, // 50ms
      });
      try {
        shortBanDefense.start();
        shortBanDefense.banIP('192.168.1.10', 'Short ban');

        // getMetrics().bannedIPs is the raw Map size with no expiry filter, so
        // "was it recorded" carries no time budget even in principle. That is
        // the assertion #1091 lost; it cannot be lost again.
        expect(shortBanDefense.getMetrics().bannedIPs).toBe(1);
        expect(shortBanDefense.getBannedIPs()).toHaveLength(1);

        // Still banned right up to the deadline — never previously asserted, so
        // a ban that expired early was invisible.
        await jest.advanceTimersByTimeAsync(49);
        expect(shortBanDefense.getBannedIPs()).toHaveLength(1);

        // At the deadline the filtered view drops it...
        await jest.advanceTimersByTimeAsync(1);
        expect(shortBanDefense.getBannedIPs()).toHaveLength(0);
        // ...but nothing has pruned the Map yet. This separates the expiry
        // FILTER from the automatic CLEANUP, which the old assertion could not
        // do: `getBannedIPs()` returns 0 either way, so it passed whether or not
        // performCleanup ever ran.
        expect(shortBanDefense.getMetrics().bannedIPs).toBe(1);

        // start() schedules performCleanup on a 60 s interval. Reaching it is
        // only possible on a controlled clock, which is why the behaviour this
        // test is named for went unexercised.
        await jest.advanceTimersByTimeAsync(60_000);
        expect(shortBanDefense.getMetrics().bannedIPs).toBe(0);
      } finally {
        shortBanDefense.stop();
        shortBanDefense.removeAllListeners();
        jest.useRealTimers();
      }
    });

    // The old test also exercised the lazy path — isIPBanned() deletes an
    // expired record on read — as a side effect of using it to "trigger expiry
    // check". Keeping it explicit so that coverage is not lost with the rewrite.
    it('should drop an expired ban lazily when isIPBanned reads it', async () => {
      jest.useFakeTimers();
      const shortBanDefense = new TopologyAttackDefense({
        banDuration: 50, // 50ms
      });
      try {
        shortBanDefense.start();
        shortBanDefense.banIP('192.168.1.20', 'Short ban');
        expect(shortBanDefense.isIPBanned('192.168.1.20')).toBe(true);
        expect(shortBanDefense.getMetrics().bannedIPs).toBe(1);

        await jest.advanceTimersByTimeAsync(50);

        // Reads false AND prunes the record, without waiting for the 60 s tick.
        expect(shortBanDefense.isIPBanned('192.168.1.20')).toBe(false);
        expect(shortBanDefense.getMetrics().bannedIPs).toBe(0);
      } finally {
        shortBanDefense.stop();
        shortBanDefense.removeAllListeners();
        jest.useRealTimers();
      }
    });
  });
});
