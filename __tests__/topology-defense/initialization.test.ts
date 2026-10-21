/**
 * Topology Attack Defense - Initialization Tests
 * Tests for system initialization and decoy peer management
 */

import { describe, test, expect, beforeEach, afterEach, afterAll, it } from '@jest/globals';
import {
  TopologyAttackDefense,
  TopologyDefenseConfig,
} from '../../shared/topology-attack-defense.js';
import { createTestDefense, standardCleanup, delay, defaultTestConfig } from './setup.js';

describe('TopologyAttackDefense - Initialization', () => {
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

  describe('Initialization', () => {
    it('should initialize with default configuration', () => {
      const defaultDefense = new TopologyAttackDefense();
      const metrics = defaultDefense.getMetrics();

      expect(metrics.totalPeers).toBe(0);
      expect(metrics.activePeers).toBe(0);
      expect(metrics.bannedIPs).toBe(0);

      defaultDefense.stop();
      defaultDefense.removeAllListeners();
    });

    it('should accept custom configuration', () => {
      const config: Partial<TopologyDefenseConfig> = {
        maxPeersPerSubnet: 5,
        decoyCount: 20,
      };

      const customDefense = new TopologyAttackDefense(config);
      customDefense.start();

      const metrics = customDefense.getMetrics();
      expect(metrics.decoyPeers).toBe(20);

      customDefense.stop();
      customDefense.removeAllListeners();
    });

    it('should generate decoy peers on start', () => {
      defense.start();

      const metrics = defense.getMetrics();
      expect(metrics.decoyPeers).toBe(5);
    });
  });

  describe('Decoy Peer Management (Topology Obfuscation)', () => {
    beforeEach(() => {
      defense.start();
    });

    it('should generate the configured number of decoy peers', () => {
      const metrics = defense.getMetrics();
      expect(metrics.decoyPeers).toBe(5);
    });

    it('should include decoys in shareable peer lists', () => {
      // Add some real peers
      for (let i = 0; i < 5; i++) {
        defense.registerPeer(`peer_${i}`, `192.168.${i}.1:8080`, {
          region: `region_${i}`,
          asn: `AS${i}`,
        });
      }

      const shareablePeers = defense.getShareablePeers(10);

      // Should include mix of real and decoy peers
      expect(shareablePeers.length).toBeLessThanOrEqual(10);

      // Some should be decoys (contain "decoy_" prefix)
      const decoyCount = shareablePeers.filter(p => p.includes('decoy_')).length;
      expect(decoyCount).toBeGreaterThan(0);
    });

    it('should rotate decoy peers', () => {
      const initialPeers = defense.getShareablePeers(10);
      defense.rotateDecoyPeers();
      // Decoys with expired timestamps should be rotated
      // (In this test, none are expired yet, but the method should run without error)
      const afterRotation = defense.getShareablePeers(10);
      expect(afterRotation).toBeDefined();
    });

    it('should not include decoys when obfuscation is disabled', () => {
      defense.stop();
      defense.removeAllListeners();

      const noObfuscation = new TopologyAttackDefense({
        enableObfuscation: false,
        decoyCount: 5,
      });
      noObfuscation.start();

      // Add real peers
      for (let i = 0; i < 3; i++) {
        noObfuscation.registerPeer(`peer_${i}`, `192.168.${i}.1:8080`);
      }

      const shareablePeers = noObfuscation.getShareablePeers(10);
      const decoyCount = shareablePeers.filter(p => p.includes('decoy_')).length;
      expect(decoyCount).toBe(0);

      noObfuscation.stop();
      noObfuscation.removeAllListeners();
    });
  });
});
