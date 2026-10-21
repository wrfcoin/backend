/**
 * #977 — module-scope / constructor `setInterval` handles must be unref'd.
 *
 * A timer started as an **import side effect** holds the event loop open for
 * every module that pulls the file in, directly or transitively. `forceExit: true`
 * on the canonical gate hides this: the runner is killed rather than exiting, so
 * a leaked handle is invisible until something else (a CLI, a one-shot script, a
 * graceful shutdown) hangs. #978 fixed the first instance — `main` never exited,
 * and exited 265 ms after the fix.
 *
 * How this is tested: wrap `setInterval` before importing, capture every timer the
 * import creates, and assert `hasRef() === false` on each. `hasRef()` is the
 * property that actually matters — whether the handle keeps the loop alive —
 * rather than a proxy for it.
 *
 * What this does NOT pin, stated rather than left silent:
 *   - It asserts nothing about timers created *later*, at runtime, by methods
 *     these modules expose. Only the import-time handles are covered.
 *   - It does not prove the process exits; that needs a child process, and the
 *     modules here are not loadable outside the ts-jest transform.
 *   - It covers the three sites evidenced by open-handle traces on the gate, not
 *     every `setInterval` in the tree — see the audit note at the bottom.
 */

import { jest, describe, it, expect, afterEach } from '@jest/globals';

type AnyTimer = { hasRef?: () => boolean; unref?: () => void };

const created: AnyTimer[] = [];

/**
 * Import `specifier` with `setInterval` instrumented, returning every timer the
 * import created. Restores the global in a `finally` so a throwing import cannot
 * leave the patch installed for later tests.
 */
async function timersCreatedByImporting(specifier: string): Promise<AnyTimer[]> {
  const captured: AnyTimer[] = [];
  const realSetInterval = global.setInterval;
  (global as unknown as Record<string, unknown>).setInterval = (
    ...args: unknown[]
  ): unknown => {
    const timer = (realSetInterval as unknown as (...a: unknown[]) => AnyTimer)(...args);
    captured.push(timer);
    created.push(timer);
    return timer;
  };
  try {
    await import(specifier);
  } finally {
    (global as unknown as Record<string, unknown>).setInterval = realSetInterval;
  }
  return captured;
}

afterEach(() => {
  // Don't leak the very handles this suite is about.
  for (const t of created.splice(0)) {
    try {
      (t as unknown as { unref?: () => void }).unref?.();
      clearInterval(t as unknown as NodeJS.Timeout);
    } catch {
      /* best effort */
    }
  }
});

describe("#977 — import-time timers do not hold the event loop open", () => {
  it("prometheus-metrics: the 30s memory-metrics refresh is unref'd", async () => {
    // Bare module-scope `setInterval`. Every module importing the metrics
    // middleware inherits this handle.
    const timers = await timersCreatedByImporting('../server/middleware/prometheus-metrics.js');

    expect(timers.length).toBeGreaterThan(0);
    for (const t of timers) {
      expect(typeof t.hasRef).toBe('function');
      expect(t.hasRef!()).toBe(false);
    }
  });

  it("redis-session-service: the session-cleanup interval is unref'd", async () => {
    // Started in the constructor, and the module exports a module-scope singleton
    // (`export const sessionService = new RedisSessionService()`), so importing
    // the file is enough to start it. `server/middleware/auth.ts` imports this,
    // which is how it reached the gate's open-handle trace.
    const timers = await timersCreatedByImporting('../server/services/redis-session-service.js');

    expect(timers.length).toBeGreaterThan(0);
    for (const t of timers) {
      expect(t.hasRef!()).toBe(false);
    }
  });

  it("cross-chain-htlc-manager: the expiration monitor is unref'd", async () => {
    // Constructor-started, module-scope singleton (`export const htlcManager`).
    // Reached the gate via shared/bridge-rollback-coordinator.ts, which imports
    // it. Before this change the setInterval return was discarded entirely, so
    // the handle could be neither unref'd nor cleared.
    const timers = await timersCreatedByImporting('../shared/cross-chain-htlc-manager.js');

    expect(timers.length).toBeGreaterThan(0);
    for (const t of timers) {
      expect(t.hasRef!()).toBe(false);
    }
  });

  // ---- second batch (#977 remainder) ----------------------------------------

  it("carbon-marketplace-service: both maintenance timers are unref'd", async () => {
    // Module-scope singleton (`export const carbonMarketplaceService = new ...`).
    // TWO timers: expired-orders (60s) and reveal-deadlines (30s). Both returns
    // were previously discarded, so neither could be unref'd OR cleared.
    const timers = await timersCreatedByImporting('../services/carbon-marketplace-service.js');

    expect(timers.length).toBeGreaterThanOrEqual(2);
    for (const t of timers) expect(t.hasRef!()).toBe(false);
  });

  it("iot-carbon-integration-service: the cleanup timer is unref'd", async () => {
    // Constructor-started behind a module-scope singleton.
    const timers = await timersCreatedByImporting('../services/iot-carbon-integration-service.js');

    expect(timers.length).toBeGreaterThan(0);
    for (const t of timers) expect(t.hasRef!()).toBe(false);
  });

  it("meshtastic-tx-reconstructor: the cleanup interval is unref'd", async () => {
    // `startCleanup()` is called at MODULE SCOPE, not by a constructor — so the
    // timer starts on import even though the class itself looks well-behaved.
    const timers = await timersCreatedByImporting('../shared/meshtastic-tx-reconstructor.js');

    expect(timers.length).toBeGreaterThan(0);
    for (const t of timers) expect(t.hasRef!()).toBe(false);
  });

  it("meshtastic-tx-validator: the nonce-cleanup interval is unref'd", async () => {
    const timers = await timersCreatedByImporting('../shared/meshtastic-tx-validator.js');

    expect(timers.length).toBeGreaterThan(0);
    for (const t of timers) expect(t.hasRef!()).toBe(false);
  });

  it("rate-limit-redis: the in-memory cache cleanup is unref'd", async () => {
    // Bare module-scope `setInterval` — the same shape as prometheus-metrics.
    const timers = await timersCreatedByImporting('../shared/middleware/rate-limit-redis.js');

    expect(timers.length).toBeGreaterThan(0);
    for (const t of timers) expect(t.hasRef!()).toBe(false);
  });

  it("cache-manager/cache-metrics: the collection interval is unref'd", async () => {
    // Reached transitively: `export const cacheManager = new WRFCoinCacheManager()`
    // starts the metrics collector, so the leak is one module away from the import.
    const timers = await timersCreatedByImporting('../server/cache/cache-manager.js');

    expect(timers.length).toBeGreaterThan(0);
    for (const t of timers) expect(t.hasRef!()).toBe(false);
  });

  it("authLogging: the auth-failure cache cleanup is unref'd", async () => {
    // A .js file — missed by earlier sweeps that grepped `--include=*.ts`.
    // Bare module-scope setInterval, so every importer inherited the handle.
    const timers = await timersCreatedByImporting('../server/middleware/authLogging.js');

    expect(timers.length).toBeGreaterThan(0);
    for (const t of timers) expect(t.hasRef!()).toBe(false);
  });

  it("CrossChainMetricsService: the cleanup timer is unref'd on construction", async () => {
    // NOT an import-time leak — the accessor is lazy, so importing the module
    // starts nothing. It is included because its handle was DISCARDED (never
    // clearable by anyone) and it surfaces in gate traces once something calls
    // the accessor. Constructed explicitly here rather than via import.
    const captured: AnyTimer[] = [];
    const realSetInterval = global.setInterval;
    (global as unknown as Record<string, unknown>).setInterval = (...args: unknown[]): unknown => {
      const t = (realSetInterval as unknown as (...a: unknown[]) => AnyTimer)(...args);
      captured.push(t); created.push(t);
      return t;
    };
    try {
      const mod: any = await import('../services/CrossChainMetricsService.js');
      new mod.CrossChainMetricsService();
    } finally {
      (global as unknown as Record<string, unknown>).setInterval = realSetInterval;
    }

    expect(captured.length).toBeGreaterThan(0);
    for (const t of captured) expect(t.hasRef!()).toBe(false);
  });
});

/**
 * Audit note (not a test): `rg 'setInterval\(' --type ts` finds ~40 call sites
 * across server/services, server/middleware and shared/. The great majority are
 * started by an explicit `start()`/method call on an object the caller owns, and
 * those are NOT leaks — the owner controls the lifetime. Only sites reachable at
 * import time are covered here. Extending this suite is the right home for any
 * further site that shows up in an open-handle trace.
 */
