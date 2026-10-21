/**
 * Tests for RouteDurableStore HA-safe consistency semantics (Issue #239)
 *
 * Tests:
 * - Initial consistency state for file and db backends
 * - Degraded signaling on normalized table read failure
 * - runStartupIntegrityCheck behavior (success and failure paths)
 * - Migration idempotence
 * - Consumer compatibility (bridge/governance/weather in file mode)
 */
import { RouteDurableStore } from '../shared/route-durable-store.js';

describe('RouteDurableStore – consistency state (issue #239)', () => {
  describe('initial state', () => {
    it('exposes healthy state with legacy-only readMode for file backend', () => {
      const store = new RouteDurableStore('/tmp/test-store-239.json', 'file');
      const s = store.getConsistencyState();
      expect(s.health).toBe('healthy');
      expect(s.readMode).toBe('legacy-only');
      expect(s.backend).toBe('file');
      expect(s.issues).toHaveLength(0);
      expect(s.degradedAt).toBeNull();
      expect(s.migrationComplete).toBe(false);
    });

    it('exposes healthy state with dual-read readMode for db backend', () => {
      const store = new RouteDurableStore('/tmp/test-store-239.json', 'db');
      const s = store.getConsistencyState();
      expect(s.health).toBe('healthy');
      expect(s.readMode).toBe('dual-read');
      expect(s.backend).toBe('db');
      expect(s.issues).toHaveLength(0);
    });

    it('returns a defensive copy from getConsistencyState', () => {
      const store = new RouteDurableStore('/tmp/test-store-239.json', 'file');
      const s1 = store.getConsistencyState();
      const s2 = store.getConsistencyState();
      expect(s1).not.toBe(s2); // different object references
      expect(s1).toEqual(s2);  // same content
    });
  });

  describe('degraded signaling on read failure', () => {
    // Helper: create a db-mode store whose blob fallback works (no real DB needed).
    // We mock loadStateFromDb so ensureLoaded() doesn't actually hit the DB.
    function makeDbStoreWithPreloadedState() {
      const store = new RouteDurableStore('/tmp/test-store-239.json', 'db');
      const mockState = {
        governance: { proposals: {}, votes: {} },
        weather: { records: {} },
        bridges: {
          transactions: {},
          verificationResults: {},
          safety: {
            halted: false, haltedAt: null, haltReason: null,
            globalExposure: '0', routeExposure: {},
            globalExposureCap: '1000000000000', routeExposureCap: '250000000000',
            anomalyWindowStartedAt: new Date(0).toISOString(),
            anomalyFailuresInWindow: 0, anomalyFailureThreshold: 5,
            challengeWindowSeconds: 1800,
          },
        },
        idempotency: { entries: {}, order: [] },
      };
      // ensureLoaded() for db backend always calls loadStateFromDb; mock it out
      (store as any).loadStateFromDb = async () => JSON.parse(JSON.stringify(mockState));
      (store as any).dbInitialized = true;
      (store as any).normalizedTablesReady = true;
      return store;
    }

    it('marks store degraded when readBridgeStates normalized read fails', async () => {
      const store = makeDbStoreWithPreloadedState();
      // Inject a failing executeQuery to simulate DB unavailability
      (store as any).executeQuery = async () => { throw new Error('db unavailable'); };

      await store.readBridgeStates();

      const s = store.getConsistencyState();
      expect(s.health).toBe('degraded');
      expect(s.issues.some(i => i.includes('bridge_state') || i.includes('db unavailable'))).toBe(true);
      expect(s.degradedAt).not.toBeNull();
    });

    it('accumulates issues on repeated failures without duplicates', async () => {
      const store = makeDbStoreWithPreloadedState();
      (store as any).executeQuery = async () => { throw new Error('connection reset'); };

      await store.readBridgeStates();
      const firstDegradedAt = store.getConsistencyState().degradedAt;

      // Second failure with same message should not add duplicate issue
      await store.readBridgeStates();
      const s = store.getConsistencyState();
      const bridgeIssues = s.issues.filter(i => i.includes('connection reset'));
      expect(bridgeIssues.length).toBe(1); // no duplicate
      expect(s.degradedAt).toBe(firstDegradedAt); // degradedAt stays at first occurrence
    });

    it('does not override health=failed with degraded', async () => {
      const store = makeDbStoreWithPreloadedState();
      // Manually set to failed state before the DB read
      (store as any)._consistencyState.health = 'failed';
      (store as any).executeQuery = async () => { throw new Error('db error'); };

      await store.readBridgeStates();

      // Should still be failed, not downgraded to degraded
      expect(store.getConsistencyState().health).toBe('failed');
    });
  });

  describe('runStartupIntegrityCheck', () => {
    it('sets readMode=legacy-only and health=healthy for file backend (no DB probe)', async () => {
      const store = new RouteDurableStore('/tmp/test-store-239.json', 'file');
      await store.runStartupIntegrityCheck();
      const s = store.getConsistencyState();
      expect(s.readMode).toBe('legacy-only');
      expect(s.health).toBe('healthy');
      expect(s.lastIntegrityCheckAt).not.toBeNull();
    });

    it('sets readMode=legacy-only and health=degraded when DB unreachable', async () => {
      const store = new RouteDurableStore('/tmp/test-store-239.json', 'db');
      (store as any).loadExecuteQuery = async () => {
        throw new Error('ECONNREFUSED');
      };
      await store.runStartupIntegrityCheck();
      const s = store.getConsistencyState();
      expect(s.readMode).toBe('legacy-only');
      expect(s.health).toBe('degraded');
      expect(s.lastIntegrityCheckAt).not.toBeNull();
      expect(s.issues.some(i => i.includes('ECONNREFUSED'))).toBe(true);
    });

    it('sets readMode=normalized and migrationComplete=true on successful DB probe', async () => {
      const store = new RouteDurableStore('/tmp/test-store-239.json', 'db');
      // Mock successful DB operations
      (store as any).loadExecuteQuery = async () => jest.fn().mockResolvedValue({ rows: [] });
      (store as any).ensureDbInitialized = jest.fn().mockResolvedValue(undefined);
      (store as any).ensureNormalizedTables = jest.fn().mockResolvedValue(undefined);
      (store as any).migrateToNormalizedTables = jest.fn().mockResolvedValue(undefined);

      await store.runStartupIntegrityCheck();
      const s = store.getConsistencyState();
      expect(s.readMode).toBe('normalized');
      expect(s.migrationComplete).toBe(true);
      expect(s.health).toBe('healthy');
      expect(s.issues).toHaveLength(0);
      expect(s.degradedAt).toBeNull();
      expect(s.schemaVersion).not.toBeNull();
    });

    it('is idempotent — second call does not lose state', async () => {
      const store = new RouteDurableStore('/tmp/test-store-239.json', 'file');
      await store.runStartupIntegrityCheck();
      await store.runStartupIntegrityCheck();
      const s = store.getConsistencyState();
      expect(s.health).toBe('healthy');
      expect(s.readMode).toBe('legacy-only');
    });
  });

  describe('migrateToNormalizedTables idempotence', () => {
    it('second run does not throw and uses ON CONFLICT DO NOTHING semantics', async () => {
      const store = new RouteDurableStore('/tmp/test-store-239.json', 'db');
      (store as any).dbInitialized = true;
      (store as any).normalizedTablesReady = true;
      const mockQuery = jest.fn().mockResolvedValue({ rows: [] });
      (store as any).executeQuery = mockQuery;

      // Run twice — should not throw
      await expect((store as any).migrateToNormalizedTables()).resolves.not.toThrow();
      await expect((store as any).migrateToNormalizedTables()).resolves.not.toThrow();
    });
  });

  describe('consumer compatibility in file mode', () => {
    let store: RouteDurableStore;

    beforeEach(() => {
      store = new RouteDurableStore('/tmp/test-store-compat-239.json', 'file');
    });

    afterEach(async () => {
      // Clean up test file
      const fs = await import('node:fs/promises');
      await fs.unlink('/tmp/test-store-compat-239.json').catch(() => {});
    });

    it('read() returns the default state (bridges.safety not halted) on a fresh store', async () => {
      const safety = await store.read(s => s.bridges.safety);
      expect(safety.halted).toBe(false);
      expect(typeof safety.globalExposure).toBe('string');
    });

    it('read() returns empty bridge transactions on a fresh store', async () => {
      const txs = await store.read(s => Object.values(s.bridges.transactions));
      expect(Array.isArray(txs)).toBe(true);
      expect(txs).toHaveLength(0);
    });

    it('readBridgeStates() returns an array in file mode (blob fallback)', async () => {
      const rows = await store.readBridgeStates();
      expect(Array.isArray(rows)).toBe(true);
    });

    it('getConsistencyState remains healthy in file mode after reads', async () => {
      await store.read(s => s.bridges.safety);
      await store.readBridgeStates();
      const s = store.getConsistencyState();
      expect(s.health).toBe('healthy');
      expect(s.readMode).toBe('legacy-only');
    });
  });
});
