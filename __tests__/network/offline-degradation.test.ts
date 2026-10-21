/**
 * Offline/Graceful Degradation Tests (Task 117.5)
 *
 * Comprehensive tests for offline handling and graceful degradation including:
 * - Mesh network unavailable (queue pending, no crash)
 * - Blockchain RPC unavailable (cache fallback)
 * - Cached data utilization with TTL
 * - Degraded state API notification
 * - Partial failure handling
 * - Memory safety (no leaks, queue bounds)
 */

import { EventEmitter } from 'events';
import {
  NetworkPartitionDetector,
  type NetworkNode,
  type ConnectivityProbe,
  type PartitionEvent,
} from '../../shared/network-partition-detector';

// Mock logger
jest.mock('../../server/utils/logger', () => ({
  blockchainLogger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('Offline/Graceful Degradation Tests (Task 117.5)', () => {
  // ============================================================================
  // Helper Classes for Testing
  // ============================================================================

  /**
   * Mock network simulator for offline testing
   */
  class MockNetworkSimulator {
    private isConnected = true;
    private latency = 50;

    disconnect(): void {
      this.isConnected = false;
    }

    reconnect(): void {
      this.isConnected = true;
    }

    setLatency(ms: number): void {
      this.latency = ms;
    }

    async probe(): Promise<{ success: boolean; latency?: number }> {
      if (!this.isConnected) {
        throw new Error('Connection timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, this.latency));
      return { success: true, latency: this.latency };
    }
  }

  /**
   * Pending operation queue with bounds
   */
  class BoundedOperationQueue<T> {
    private queue: Array<{ data: T; timestamp: number; retries: number }> = [];
    private readonly maxSize: number;
    private readonly ttlMs: number;

    constructor(maxSize: number = 1000, ttlMs: number = 300000) {
      this.maxSize = maxSize;
      this.ttlMs = ttlMs;
    }

    enqueue(data: T): boolean {
      // Remove expired items first
      this.pruneExpired();

      // Check capacity
      if (this.queue.length >= this.maxSize) {
        return false; // Queue full
      }

      this.queue.push({
        data,
        timestamp: Date.now(),
        retries: 0,
      });
      return true;
    }

    dequeue(): { data: T; retries: number } | null {
      this.pruneExpired();
      const item = this.queue.shift();
      return item ? { data: item.data, retries: item.retries } : null;
    }

    peek(): T | null {
      this.pruneExpired();
      return this.queue[0]?.data || null;
    }

    size(): number {
      this.pruneExpired();
      return this.queue.length;
    }

    isEmpty(): boolean {
      return this.size() === 0;
    }

    private pruneExpired(): void {
      const now = Date.now();
      this.queue = this.queue.filter((item) => now - item.timestamp < this.ttlMs);
    }

    incrementRetries(index: number): void {
      if (this.queue[index]) {
        this.queue[index].retries++;
      }
    }

    getMaxRetries(): number {
      return Math.max(...this.queue.map((item) => item.retries), 0);
    }

    clear(): void {
      this.queue = [];
    }
  }

  /**
   * Cache with TTL for offline fallback
   */
  class CacheWithTTL<T> {
    private cache: Map<string, { value: T; expiry: number }> = new Map();
    private readonly defaultTtlMs: number;

    constructor(defaultTtlMs: number = 60000) {
      this.defaultTtlMs = defaultTtlMs;
    }

    set(key: string, value: T, ttlMs?: number): void {
      const expiry = Date.now() + (ttlMs || this.defaultTtlMs);
      this.cache.set(key, { value, expiry });
    }

    get(key: string): T | null {
      const entry = this.cache.get(key);
      if (!entry) return null;

      if (Date.now() > entry.expiry) {
        this.cache.delete(key);
        return null;
      }

      return entry.value;
    }

    has(key: string): boolean {
      return this.get(key) !== null;
    }

    delete(key: string): boolean {
      return this.cache.delete(key);
    }

    clear(): void {
      this.cache.clear();
    }

    size(): number {
      this.pruneExpired();
      return this.cache.size;
    }

    private pruneExpired(): void {
      const now = Date.now();
      for (const [key, entry] of this.cache.entries()) {
        if (now > entry.expiry) {
          this.cache.delete(key);
        }
      }
    }
  }

  /**
   * Degradation state manager
   */
  interface DegradationState {
    meshNetwork: 'online' | 'degraded' | 'offline';
    blockchainRpc: 'online' | 'degraded' | 'offline';
    overallStatus: 'healthy' | 'degraded' | 'critical';
    lastUpdate: Date;
  }

  class DegradationStateManager extends EventEmitter {
    private state: DegradationState;

    constructor() {
      super();
      this.state = {
        meshNetwork: 'online',
        blockchainRpc: 'online',
        overallStatus: 'healthy',
        lastUpdate: new Date(),
      };
    }

    updateMeshStatus(status: 'online' | 'degraded' | 'offline'): void {
      const oldStatus = this.state.meshNetwork;
      this.state.meshNetwork = status;
      this.state.lastUpdate = new Date();
      this.recalculateOverallStatus();

      if (oldStatus !== status) {
        this.emit('meshStatusChanged', { oldStatus, newStatus: status });
      }
    }

    updateBlockchainStatus(status: 'online' | 'degraded' | 'offline'): void {
      const oldStatus = this.state.blockchainRpc;
      this.state.blockchainRpc = status;
      this.state.lastUpdate = new Date();
      this.recalculateOverallStatus();

      if (oldStatus !== status) {
        this.emit('blockchainStatusChanged', { oldStatus, newStatus: status });
      }
    }

    private recalculateOverallStatus(): void {
      const oldOverall = this.state.overallStatus;

      if (
        this.state.meshNetwork === 'offline' ||
        this.state.blockchainRpc === 'offline'
      ) {
        this.state.overallStatus = 'critical';
      } else if (
        this.state.meshNetwork === 'degraded' ||
        this.state.blockchainRpc === 'degraded'
      ) {
        this.state.overallStatus = 'degraded';
      } else {
        this.state.overallStatus = 'healthy';
      }

      if (oldOverall !== this.state.overallStatus) {
        this.emit('overallStatusChanged', {
          oldStatus: oldOverall,
          newStatus: this.state.overallStatus,
        });
      }
    }

    getState(): DegradationState {
      return { ...this.state };
    }

    isHealthy(): boolean {
      return this.state.overallStatus === 'healthy';
    }

    isCritical(): boolean {
      return this.state.overallStatus === 'critical';
    }
  }

  // ============================================================================
  // Mesh Network Unavailable Tests
  // ============================================================================
  describe('Mesh Network Unavailable', () => {
    it('should queue pending operations when mesh is unavailable', () => {
      const queue = new BoundedOperationQueue<{ txId: string; data: string }>();
      const networkSim = new MockNetworkSimulator();

      networkSim.disconnect();

      // Simulate queueing operations while offline
      const result1 = queue.enqueue({ txId: 'tx-1', data: 'data-1' });
      const result2 = queue.enqueue({ txId: 'tx-2', data: 'data-2' });

      expect(result1).toBe(true);
      expect(result2).toBe(true);
      expect(queue.size()).toBe(2);
    });

    it('should not crash when mesh network is unavailable', async () => {
      const networkSim = new MockNetworkSimulator();
      networkSim.disconnect();

      // Attempting to probe should throw but not crash
      let errorCaught = false;
      try {
        await networkSim.probe();
      } catch (error) {
        errorCaught = true;
        expect((error as Error).message).toContain('timeout');
      }

      expect(errorCaught).toBe(true);
    });

    it('should process queued operations when mesh comes back online', async () => {
      const queue = new BoundedOperationQueue<{ txId: string; data: string }>();
      const networkSim = new MockNetworkSimulator();
      const processed: string[] = [];

      // Disconnect and queue operations
      networkSim.disconnect();
      queue.enqueue({ txId: 'tx-1', data: 'data-1' });
      queue.enqueue({ txId: 'tx-2', data: 'data-2' });

      // Reconnect and process queue
      networkSim.reconnect();

      while (!queue.isEmpty()) {
        const item = queue.dequeue();
        if (item) {
          await networkSim.probe(); // Verify connection
          processed.push(item.data.txId);
        }
      }

      expect(processed).toEqual(['tx-1', 'tx-2']);
    });
  });

  // ============================================================================
  // Blockchain RPC Unavailable Tests
  // ============================================================================
  describe('Blockchain RPC Unavailable', () => {
    it('should use cached data when RPC is unavailable', async () => {
      const cache = new CacheWithTTL<{ balance: number }>();

      // Cache some data while online
      cache.set('wallet:0x123', { balance: 1000 });

      // Simulate RPC failure
      const rpcAvailable = false;

      // Retrieve from cache during offline
      if (!rpcAvailable) {
        const cached = cache.get('wallet:0x123');
        expect(cached).toBeDefined();
        expect(cached?.balance).toBe(1000);
      }
    });

    it('should mark data as stale after TTL expires', async () => {
      const cache = new CacheWithTTL<{ balance: number }>(100); // 100ms TTL

      cache.set('wallet:0x123', { balance: 1000 });

      // Wait for TTL to expire
      await new Promise((resolve) => setTimeout(resolve, 150));

      const cached = cache.get('wallet:0x123');
      expect(cached).toBeNull();
    });

    it('should return cached data within TTL', () => {
      const cache = new CacheWithTTL<{ balance: number }>(60000); // 60s TTL

      cache.set('wallet:0x123', { balance: 1000 });

      // Multiple reads within TTL
      expect(cache.get('wallet:0x123')?.balance).toBe(1000);
      expect(cache.get('wallet:0x123')?.balance).toBe(1000);
      expect(cache.get('wallet:0x123')?.balance).toBe(1000);
    });
  });

  // ============================================================================
  // Cached Data Utilization with TTL Tests
  // ============================================================================
  describe('Cached Data Utilization with TTL', () => {
    it('should support different TTLs per key', () => {
      const cache = new CacheWithTTL<string>();

      cache.set('short-lived', 'value1', 100); // 100ms
      cache.set('long-lived', 'value2', 10000); // 10s

      expect(cache.get('short-lived')).toBe('value1');
      expect(cache.get('long-lived')).toBe('value2');
    });

    it('should prune expired entries on access', async () => {
      const cache = new CacheWithTTL<string>(50);

      cache.set('key1', 'value1');
      cache.set('key2', 'value2');

      await new Promise((resolve) => setTimeout(resolve, 100));

      // Size should be 0 after pruning
      expect(cache.size()).toBe(0);
    });

    it('should handle cache updates correctly', () => {
      const cache = new CacheWithTTL<number>(60000);

      cache.set('counter', 1);
      expect(cache.get('counter')).toBe(1);

      cache.set('counter', 2);
      expect(cache.get('counter')).toBe(2);
    });
  });

  // ============================================================================
  // Degraded State API Notification Tests
  // ============================================================================
  describe('Degraded State API Notification', () => {
    let stateManager: DegradationStateManager;

    beforeEach(() => {
      stateManager = new DegradationStateManager();
    });

    it('should start in healthy state', () => {
      const state = stateManager.getState();

      expect(state.meshNetwork).toBe('online');
      expect(state.blockchainRpc).toBe('online');
      expect(state.overallStatus).toBe('healthy');
    });

    it('should emit event when mesh status changes', (done) => {
      stateManager.on('meshStatusChanged', (event) => {
        expect(event.oldStatus).toBe('online');
        expect(event.newStatus).toBe('offline');
        done();
      });

      stateManager.updateMeshStatus('offline');
    });

    it('should emit event when blockchain status changes', (done) => {
      stateManager.on('blockchainStatusChanged', (event) => {
        expect(event.oldStatus).toBe('online');
        expect(event.newStatus).toBe('degraded');
        done();
      });

      stateManager.updateBlockchainStatus('degraded');
    });

    it('should calculate overall status as critical when any service is offline', () => {
      stateManager.updateMeshStatus('offline');

      expect(stateManager.isCritical()).toBe(true);
      expect(stateManager.getState().overallStatus).toBe('critical');
    });

    it('should calculate overall status as degraded when any service is degraded', () => {
      stateManager.updateMeshStatus('degraded');

      expect(stateManager.getState().overallStatus).toBe('degraded');
      expect(stateManager.isHealthy()).toBe(false);
      expect(stateManager.isCritical()).toBe(false);
    });

    it('should emit overall status change event', (done) => {
      stateManager.on('overallStatusChanged', (event) => {
        expect(event.oldStatus).toBe('healthy');
        expect(event.newStatus).toBe('critical');
        done();
      });

      stateManager.updateBlockchainStatus('offline');
    });
  });

  // ============================================================================
  // Partial Failure Handling Tests
  // ============================================================================
  describe('Partial Failure Handling', () => {
    interface ServiceStatus {
      name: string;
      available: boolean;
      lastError?: string;
    }

    class PartialFailureHandler {
      private services: Map<string, ServiceStatus> = new Map();
      private fallbackOrder: string[] = [];

      registerService(name: string, fallbackPriority: number): void {
        this.services.set(name, { name, available: true });

        // Insert in fallback order
        this.fallbackOrder.splice(fallbackPriority, 0, name);
      }

      markServiceFailed(name: string, error: string): void {
        const service = this.services.get(name);
        if (service) {
          service.available = false;
          service.lastError = error;
        }
      }

      markServiceAvailable(name: string): void {
        const service = this.services.get(name);
        if (service) {
          service.available = true;
          service.lastError = undefined;
        }
      }

      getAvailableService(): string | null {
        for (const serviceName of this.fallbackOrder) {
          const service = this.services.get(serviceName);
          if (service?.available) {
            return serviceName;
          }
        }
        return null;
      }

      getServiceStatus(): ServiceStatus[] {
        return Array.from(this.services.values());
      }

      areAllServicesFailed(): boolean {
        return !Array.from(this.services.values()).some((s) => s.available);
      }
    }

    let failureHandler: PartialFailureHandler;

    beforeEach(() => {
      failureHandler = new PartialFailureHandler();
      failureHandler.registerService('primary-rpc', 0);
      failureHandler.registerService('secondary-rpc', 1);
      failureHandler.registerService('fallback-rpc', 2);
    });

    it('should use primary service when available', () => {
      const service = failureHandler.getAvailableService();
      expect(service).toBe('primary-rpc');
    });

    it('should fall back to secondary when primary fails', () => {
      failureHandler.markServiceFailed('primary-rpc', 'Connection timeout');

      const service = failureHandler.getAvailableService();
      expect(service).toBe('secondary-rpc');
    });

    it('should fall back to tertiary when primary and secondary fail', () => {
      failureHandler.markServiceFailed('primary-rpc', 'Connection timeout');
      failureHandler.markServiceFailed('secondary-rpc', 'Server error');

      const service = failureHandler.getAvailableService();
      expect(service).toBe('fallback-rpc');
    });

    it('should detect when all services are failed', () => {
      expect(failureHandler.areAllServicesFailed()).toBe(false);

      failureHandler.markServiceFailed('primary-rpc', 'Error');
      failureHandler.markServiceFailed('secondary-rpc', 'Error');
      failureHandler.markServiceFailed('fallback-rpc', 'Error');

      expect(failureHandler.areAllServicesFailed()).toBe(true);
    });

    it('should recover when service comes back online', () => {
      failureHandler.markServiceFailed('primary-rpc', 'Error');
      expect(failureHandler.getAvailableService()).toBe('secondary-rpc');

      failureHandler.markServiceAvailable('primary-rpc');
      expect(failureHandler.getAvailableService()).toBe('primary-rpc');
    });
  });

  // ============================================================================
  // Memory Safety Tests
  // ============================================================================
  describe('Memory Safety', () => {
    it('should respect queue bounds', () => {
      const queue = new BoundedOperationQueue<number>(5);

      for (let i = 0; i < 10; i++) {
        queue.enqueue(i);
      }

      // Queue should be at max capacity
      expect(queue.size()).toBe(5);
    });

    it('should return false when queue is full', () => {
      const queue = new BoundedOperationQueue<number>(3);

      expect(queue.enqueue(1)).toBe(true);
      expect(queue.enqueue(2)).toBe(true);
      expect(queue.enqueue(3)).toBe(true);
      expect(queue.enqueue(4)).toBe(false); // Full
    });

    it('should allow enqueue after dequeue', () => {
      const queue = new BoundedOperationQueue<number>(3);

      queue.enqueue(1);
      queue.enqueue(2);
      queue.enqueue(3);
      expect(queue.enqueue(4)).toBe(false);

      queue.dequeue(); // Remove one
      expect(queue.enqueue(4)).toBe(true); // Now has space
    });

    it('should clear expired items to prevent memory bloat', async () => {
      const queue = new BoundedOperationQueue<number>(1000, 100); // 100ms TTL

      for (let i = 0; i < 100; i++) {
        queue.enqueue(i);
      }

      expect(queue.size()).toBe(100);

      await new Promise((resolve) => setTimeout(resolve, 150));

      // All items should be expired
      expect(queue.size()).toBe(0);
    });

    it('should not leak memory with repeated cache operations', () => {
      const cache = new CacheWithTTL<string>(50);

      // Simulate many cache operations
      for (let i = 0; i < 1000; i++) {
        cache.set(`key-${i}`, `value-${i}`);
      }

      // Allow TTL to expire
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          expect(cache.size()).toBe(0);
          resolve();
        }, 100);
      });
    });

    it('should handle queue clear correctly', () => {
      const queue = new BoundedOperationQueue<number>(100);

      for (let i = 0; i < 50; i++) {
        queue.enqueue(i);
      }

      expect(queue.size()).toBe(50);

      queue.clear();
      expect(queue.size()).toBe(0);
      expect(queue.isEmpty()).toBe(true);
    });
  });

  // ============================================================================
  // Network Partition Detector Tests
  // ============================================================================
  describe('Network Partition Detector Integration', () => {
    let detector: NetworkPartitionDetector;

    beforeEach(() => {
      detector = new NetworkPartitionDetector({
        heartbeatInterval: 100,
        failureThreshold: 3,
        partitionThreshold: 30,
        detectionWindowMs: 500,
      });
    });

    afterEach(() => {
      detector.stop();
    });

    it('should register and track nodes', () => {
      const node: NetworkNode = {
        nodeId: 'node-1',
        address: '192.168.1.1',
        port: 8080,
        isValidator: true,
        lastSeen: new Date(),
        consecutiveFailures: 0,
      };

      detector.registerNode(node);

      const status = detector.getNodeStatus('node-1');
      expect(status).toBeDefined();
      expect(status?.nodeId).toBe('node-1');
    });

    it('should track node failures through probes', () => {
      const node: NetworkNode = {
        nodeId: 'node-1',
        address: '192.168.1.1',
        port: 8080,
        isValidator: false,
        lastSeen: new Date(),
        consecutiveFailures: 0,
      };

      detector.registerNode(node);

      // Record failed probes
      detector.recordProbe({
        targetNodeId: 'node-1',
        probedAt: new Date(),
        success: false,
        error: 'Connection timeout',
      });

      detector.recordProbe({
        targetNodeId: 'node-1',
        probedAt: new Date(),
        success: false,
        error: 'Connection timeout',
      });

      const status = detector.getNodeStatus('node-1');
      expect(status?.consecutiveFailures).toBe(2);
    });

    it('should reset failure count on successful probe', () => {
      const node: NetworkNode = {
        nodeId: 'node-1',
        address: '192.168.1.1',
        port: 8080,
        isValidator: false,
        lastSeen: new Date(),
        consecutiveFailures: 2,
      };

      detector.registerNode(node);

      // Record successful probe
      detector.recordProbe({
        targetNodeId: 'node-1',
        probedAt: new Date(),
        success: true,
        latency: 50,
      });

      const status = detector.getNodeStatus('node-1');
      expect(status?.consecutiveFailures).toBe(0);
    });

    it('should emit node_unreachable event after threshold failures', (done) => {
      const node: NetworkNode = {
        nodeId: 'node-1',
        address: '192.168.1.1',
        port: 8080,
        isValidator: false,
        lastSeen: new Date(),
        consecutiveFailures: 0,
      };

      detector.registerNode(node);
      detector.on('node_unreachable', (nodeId) => {
        expect(nodeId).toBe('node-1');
        done();
      });

      // Record failures until threshold (3)
      for (let i = 0; i < 3; i++) {
        detector.recordProbe({
          targetNodeId: 'node-1',
          probedAt: new Date(),
          success: false,
          error: 'Timeout',
        });
      }
    });

    it('should provide partition status', () => {
      const status = detector.getPartitionStatus();

      expect(status).toHaveProperty('hasActivePartition');
      expect(status).toHaveProperty('partitionCount');
      expect(status).toHaveProperty('partitions');
      expect(status).toHaveProperty('connectivity');
    });

    it('should unregister nodes correctly', () => {
      const node: NetworkNode = {
        nodeId: 'node-1',
        address: '192.168.1.1',
        port: 8080,
        isValidator: false,
        lastSeen: new Date(),
        consecutiveFailures: 0,
      };

      detector.registerNode(node);
      expect(detector.getNodeStatus('node-1')).toBeDefined();

      detector.unregisterNode('node-1');
      expect(detector.getNodeStatus('node-1')).toBeUndefined();
    });
  });

  // ============================================================================
  // Comprehensive Degradation Scenario Tests
  // ============================================================================
  describe('Comprehensive Degradation Scenarios', () => {
    it('should handle complete network outage gracefully', async () => {
      const stateManager = new DegradationStateManager();
      const pendingQueue = new BoundedOperationQueue<any>();
      const cache = new CacheWithTTL<any>();

      // Populate cache before outage
      cache.set('important-data', { value: 'cached' });

      // Simulate complete outage
      stateManager.updateMeshStatus('offline');
      stateManager.updateBlockchainStatus('offline');

      // System should still function in degraded mode
      expect(stateManager.isCritical()).toBe(true);
      expect(cache.get('important-data')).toBeDefined();
      expect(pendingQueue.enqueue({ operation: 'pending-tx' })).toBe(true);
    });

    it('should recover from degradation to healthy state', () => {
      const stateManager = new DegradationStateManager();

      // Go to critical
      stateManager.updateMeshStatus('offline');
      stateManager.updateBlockchainStatus('offline');
      expect(stateManager.isCritical()).toBe(true);

      // Partial recovery
      stateManager.updateMeshStatus('online');
      expect(stateManager.getState().overallStatus).toBe('critical');

      // Full recovery
      stateManager.updateBlockchainStatus('online');
      expect(stateManager.isHealthy()).toBe(true);
    });

    it('should maintain data consistency through degradation cycles', () => {
      const cache = new CacheWithTTL<{ counter: number }>(60000);
      const stateManager = new DegradationStateManager();

      // Initial state
      cache.set('counter', { counter: 0 });

      // Increment while online
      for (let i = 1; i <= 5; i++) {
        cache.set('counter', { counter: i });
      }

      expect(cache.get('counter')?.counter).toBe(5);

      // Go offline
      stateManager.updateBlockchainStatus('offline');

      // Cache should still be valid
      expect(cache.get('counter')?.counter).toBe(5);

      // Come back online
      stateManager.updateBlockchainStatus('online');

      // Continue incrementing
      for (let i = 6; i <= 10; i++) {
        cache.set('counter', { counter: i });
      }

      expect(cache.get('counter')?.counter).toBe(10);
    });
  });
});
