/**
 * Idempotency replay tests for weather data submission (#457)
 *
 * Verifies that RouteDurableStore's getIdempotency/putIdempotency correctly:
 *   1. Returns a cached response on a duplicate POST (replay path).
 *   2. Stores the entry so a second call returns it without re-processing.
 *   3. Evicts the oldest entry when MAX_IDEMPOTENCY_ENTRIES (10 000) is exceeded
 *      and allows re-processing of the evicted key.
 *
 * Uses the file backend with a path inside backend/data/ (required by SAFE_BASE_DIR).
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import path from 'node:path';
import fs from 'node:fs/promises';

// SAFE_BASE_DIR in route-durable-store.ts = path.resolve(cwd, 'backend', 'data').
// We must use a path under that directory.
const BASE_DATA_DIR = path.resolve(process.cwd(), 'backend', 'data');
const TEST_STORE_PATH = path.join(BASE_DATA_DIR, `idempotency-test-${process.pid}.json`);
const TEST_MAX_IDEMPOTENCY_ENTRIES = 10;

// Set env vars BEFORE importing the module
process.env.WRFCOIN_ROUTE_STORE_PATH = TEST_STORE_PATH;
process.env.WRFCOIN_ROUTE_STORE_BACKEND = 'file';

import { RouteDurableStore } from '../../shared/route-durable-store.js';
import type { IdempotencyEntry } from '../../shared/route-durable-store.js';

describe('RouteDurableStore idempotency replay', () => {
  let store: RouteDurableStore;

  beforeEach(async () => {
    // Ensure the data directory exists (matches SAFE_BASE_DIR requirement)
    await fs.mkdir(BASE_DATA_DIR, { recursive: true });
    // Remove any leftover store file
    await fs.rm(TEST_STORE_PATH, { force: true });
    // Create a fresh store instance pointing at our test file
    store = new RouteDurableStore(TEST_STORE_PATH, 'file', TEST_MAX_IDEMPOTENCY_ENTRIES);
  });

  afterEach(async () => {
    await fs.rm(TEST_STORE_PATH, { force: true });
  });

  // -------------------------------------------------------------------------
  // Test 1: Duplicate idempotency key returns cached response
  // -------------------------------------------------------------------------
  it('returns cached response on duplicate idempotency key without re-processing', async () => {
    const scope = 'weather:submit';
    const key = 'idem-key-abc123';
    const firstStatus = 200;
    const firstBody = { success: true, commitmentId: 'commit-001' };

    // First request: store the result
    await store.putIdempotency(scope, key, firstStatus, firstBody);

    // Second request: checks for existing entry and gets cached response
    const cached = await store.getIdempotency(scope, key);

    expect(cached).not.toBeNull();
    expect((cached as IdempotencyEntry).status).toBe(firstStatus);
    expect((cached as IdempotencyEntry).responseBody).toEqual(firstBody);
    expect((cached as IdempotencyEntry).scope).toBe(scope);
    expect((cached as IdempotencyEntry).key).toBe(key);
  });

  it('returns null for an idempotency key that has not been stored', async () => {
    const result = await store.getIdempotency('weather:submit', 'never-stored-key');
    expect(result).toBeNull();
  });

  it('documents that file-backend OVERWRITES duplicate keys (unlike DB ON CONFLICT DO NOTHING)', async () => {
    // NOTE: The file backend does NOT implement ON CONFLICT DO NOTHING — it overwrites.
    // Only the DB backend (Postgres) has true idempotency guarantee.
    // This test documents the discrepancy so callers know not to rely on the file
    // backend for write-once semantics; production must use WRFCOIN_ROUTE_STORE_BACKEND=db.
    const scope = 'weather:submit';
    const key = 'idem-key-file-overwrite';

    await store.putIdempotency(scope, key, 200, { round: 1 });
    await store.putIdempotency(scope, key, 200, { round: 2 });

    const entry = await store.getIdempotency(scope, key);
    // File backend: second write wins
    expect((entry as IdempotencyEntry).responseBody).toEqual({ round: 2 });
  });

  // -------------------------------------------------------------------------
  // Test 2: Second reveal for same commitmentId is detectable → reject with 409
  // -------------------------------------------------------------------------
  it('marks a commitmentId as already-revealed so a second reveal can be rejected', async () => {
    const scope = 'weather:reveal';
    const commitmentId = 'commit-xyz-789';

    // First reveal: store 200 OK
    await store.putIdempotency(scope, commitmentId, 200, {
      revealed: true,
      txHash: '0xabc',
    });

    // Second reveal attempt: caller checks idempotency store first
    const existing = await store.getIdempotency(scope, commitmentId);

    // Assert the cached entry is present — handler uses this to return 409
    expect(existing).not.toBeNull();
    expect((existing as IdempotencyEntry).status).toBe(200);

    // Simulate handler logic: if entry found → return 409
    const handlerStatus = existing ? 409 : 200;
    expect(handlerStatus).toBe(409);
  });

  // -------------------------------------------------------------------------
  // Test 3: Eviction at MAX_IDEMPOTENCY_ENTRIES → oldest key is evictable
  // -------------------------------------------------------------------------
  it('uses the production default idempotency bound of 10,000 entries when not overridden', () => {
    const defaultStore = new RouteDurableStore(TEST_STORE_PATH, 'file');
    expect(defaultStore.getMaxIdempotencyEntries()).toBe(10_000);
  });

  it('evicts the oldest entry only after the configured idempotency bound is exceeded', async () => {
    const scope = 'weather:submit';
    const firstKey = 'very-first-key';

    // Store the key we will check for eviction
    await store.putIdempotency(scope, firstKey, 200, { original: true });

    // Confirm it is stored
    const beforeEviction = await store.getIdempotency(scope, firstKey);
    expect(beforeEviction).not.toBeNull();

    // Fill exactly to the injected bound. The oldest entry must still exist.
    const MAX = TEST_MAX_IDEMPOTENCY_ENTRIES;
    for (let i = 0; i < MAX - 1; i++) {
      await store.putIdempotency(scope, `filler-key-${i}`, 200, { i });
    }
    await expect(store.getIdempotency(scope, firstKey)).resolves.not.toBeNull();

    // One additional entry exceeds the bound and evicts FIFO.
    await store.putIdempotency(scope, 'overflow-key', 200, { overflow: true });

    // The first key should now be evicted (FIFO eviction)
    const afterEviction = await store.getIdempotency(scope, firstKey);
    expect(afterEviction).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Edge cases: invalid / empty keys
  // -------------------------------------------------------------------------
  it('returns null and does not throw for an empty-string idempotency key', async () => {
    const result = await store.getIdempotency('weather:submit', '');
    expect(result).toBeNull();
  });

  it('putIdempotency is a no-op for an empty-string key', async () => {
    await expect(
      store.putIdempotency('weather:submit', '', 200, { body: true })
    ).resolves.toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Scope isolation: same key in different scopes are independent entries
  // -------------------------------------------------------------------------
  it('isolates entries by scope (weather:submit vs weather:reveal share no state)', async () => {
    const key = 'shared-key-123';

    await store.putIdempotency('weather:submit', key, 200, { scope: 'submit' });
    await store.putIdempotency('weather:reveal', key, 200, { scope: 'reveal' });

    const submitEntry = await store.getIdempotency('weather:submit', key);
    const revealEntry = await store.getIdempotency('weather:reveal', key);

    expect((submitEntry as IdempotencyEntry).responseBody).toEqual({ scope: 'submit' });
    expect((revealEntry as IdempotencyEntry).responseBody).toEqual({ scope: 'reveal' });
  });
});
