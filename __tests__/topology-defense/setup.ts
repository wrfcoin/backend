/**
 * Shared test setup for Topology Attack Defense tests
 * Provides memory-efficient cleanup utilities and common configurations
 */

import { TopologyAttackDefense, TopologyDefenseConfig } from '../../shared/topology-attack-defense.js';

// Default test configuration with shorter intervals for faster tests
export const defaultTestConfig: Partial<TopologyDefenseConfig> = {
  maxPeersPerSubnet: 2,
  churnInterval: 1000, // 1 second for testing
  churnRate: 0.2,
  decoyCount: 5,
  anomalyThreshold: 5,
  banDuration: 5000, // 5 seconds for testing
  minGeographicRegions: 2,
  minUniqueASNs: 2,
  connectionRateLimit: 5,
  enableObfuscation: true,
  enableRestructuring: true,
};

/**
 * Creates a new TopologyAttackDefense instance with test configuration
 */
export function createTestDefense(config?: Partial<TopologyDefenseConfig>): TopologyAttackDefense {
  return new TopologyAttackDefense({ ...defaultTestConfig, ...config });
}

/**
 * Safely stops and cleans up a defense instance
 * Prevents memory leaks from event listeners and timers
 */
export async function cleanupDefense(defense: TopologyAttackDefense | null): Promise<void> {
  if (!defense) return;

  try {
    defense.stop();
    defense.removeAllListeners();
  } catch {
    // Ignore cleanup errors
  }

  // Small delay to allow internal cleanup
  await new Promise(resolve => setTimeout(resolve, 10));
}

/**
 * Force garbage collection if available (requires --expose-gc flag)
 */
export function forceGC(): void {
  if (global.gc) {
    global.gc();
  }
}

/**
 * Standard afterEach cleanup for test suites
 */
export async function standardCleanup(defense: TopologyAttackDefense | null): Promise<void> {
  await cleanupDefense(defense);
  jest.clearAllTimers();
  forceGC();
}

/**
 * Wait for a short duration (useful for async operations)
 */
export function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Configure jest to use fake timers by default for timing tests
// Individual tests can opt out with jest.useRealTimers()
